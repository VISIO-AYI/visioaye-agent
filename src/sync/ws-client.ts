import { unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import { getWsUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { getStoredJwt } from '../pairing/pairing.service.js';
import { markRecentDownload } from '../watcher/watcher.js';
import { downloadFileToBinding } from './downloader.js';
import {
  deleteManifestEntryByFileId,
  lookupBindingByFolderId,
  lookupManifestByFileId,
  upsertManifestFile,
} from './manifest.js';

const MAX_RELATIVE_PATH_LENGTH = 1024;

function isSafeRelativePath(rel: unknown, bindingPath: string): rel is string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_RELATIVE_PATH_LENGTH) return false;
  if (rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return false;
  const segments = rel.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '.')) return false;
  const resolved = resolve(bindingPath, rel);
  const bindingResolved = resolve(bindingPath);
  const bindingWithSep = bindingResolved.endsWith(sep) ? bindingResolved : bindingResolved + sep;
  return resolved === bindingResolved || resolved.startsWith(bindingWithSep);
}

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private stopped = false;

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const jwt = getStoredJwt();
    if (!jwt) {
      logger.warn('WS non demarre : agent pas encore paired');
      return;
    }
    const url = getWsUrl();
    logger.info('WS: tentative connexion', { url });
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
      logger.info('WS connecte');
    });

    socket.on('message', (raw) => {
      const text = raw.toString();
      logger.debug('WS message recu', { raw: text.slice(0, 200) });
      try {
        const msg = JSON.parse(text);
        void this.handleMessage(msg);
      } catch (err) {
        logger.error('WS message invalide', { message: (err as Error).message });
      }
    });

    socket.on('close', (code, reason) => {
      this.socket = null;
      if (this.stopped) return;
      logger.warn('WS deconnecte, retry', {
        code,
        reason: reason?.toString().slice(0, 100),
        delayMs: this.reconnectDelay,
      });
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    });

    socket.on('error', (err) => {
      logger.error('WS erreur', { message: err.message });
    });
  }

  private async handleMessage(msg: { type?: string; payload?: unknown }): Promise<void> {
    switch (msg.type) {
      case 'file.updated':
        await this.onFileUpdated(msg.payload as FileUpdatedPayload);
        break;
      case 'file.deleted':
        await this.onFileDeleted(msg.payload as FileDeletedPayload);
        break;
      case 'sync_setting.changed':
        logger.info('WS: sync_setting.changed', { payload: msg.payload });
        break;
      case 'scope_policy.changed':
        logger.info('WS: scope_policy.changed', { payload: msg.payload });
        break;
      default:
        logger.debug('WS message type inconnu', { type: msg.type });
    }
  }

  private async onFileUpdated(payload: FileUpdatedPayload): Promise<void> {
    logger.info('WS: file.updated recu', payload);
    const binding = lookupBindingByFolderId(payload.folderId);
    if (!binding) {
      logger.debug('WS: file.updated ignore - pas de binding local pour ce folder', {
        folderId: payload.folderId,
      });
      return;
    }
    const existing = lookupManifestByFileId(payload.fileId);
    if (existing && payload.sha256 && existing.sha256 === payload.sha256) {
      logger.info('WS: file.updated ignore - SHA local deja a jour', {
        fileId: payload.fileId,
        sha256: payload.sha256.slice(0, 12),
      });
      return;
    }

    const localRel = existing?.relativePath ?? payload.relativePath;
    if (!isSafeRelativePath(localRel, binding.localPath)) {
      logger.error('WS: file.updated REJETE - relativePath unsafe (path traversal)', {
        fileId: payload.fileId,
        relativePath: localRel,
        bindingPath: binding.localPath,
      });
      return;
    }
    markRecentDownload(binding.bindingId, localRel);
    logger.info('WS: file.updated - download planifie', {
      fileId: payload.fileId,
      bindingId: binding.bindingId,
      relativePath: localRel,
    });

    try {
      await downloadFileToBinding(
        {
          id: payload.fileId,
          name: localRel,
          sha256: payload.sha256,
          sizeBytes: payload.sizeBytes,
          relativePath: localRel,
        },
        binding.localPath,
      );
      upsertManifestFile({
        bindingId: binding.bindingId,
        relativePath: localRel,
        fileId: payload.fileId,
        sha256: payload.sha256,
        sizeBytes: payload.sizeBytes,
      });
      logger.info('WS: file.updated - download OK + manifest a jour', {
        fileId: payload.fileId,
        relativePath: localRel,
      });
    } catch (err) {
      logger.error('WS: file.updated - download echoue', {
        fileId: payload.fileId,
        message: (err as Error).message,
      });
    }
  }

  private async onFileDeleted(payload: FileDeletedPayload): Promise<void> {
    logger.info('WS: file.deleted recu', payload);
    const existing = lookupManifestByFileId(payload.fileId);
    if (!existing) {
      logger.debug('WS: file.deleted ignore - fichier inconnu du manifest local', {
        fileId: payload.fileId,
      });
      return;
    }
    const binding = lookupBindingByFolderId(payload.folderId);
    if (!binding) {
      logger.debug('WS: file.deleted ignore - pas de binding local pour ce folder', {
        folderId: payload.folderId,
      });
      return;
    }
    if (!isSafeRelativePath(existing.relativePath, binding.localPath)) {
      logger.error('WS: file.deleted REJETE - relativePath manifest unsafe', {
        fileId: payload.fileId,
        relativePath: existing.relativePath,
        bindingPath: binding.localPath,
      });
      return;
    }
    const localPath = join(binding.localPath, existing.relativePath.split('/').join(sep));
    markRecentDownload(binding.bindingId, existing.relativePath);
    try {
      unlinkSync(localPath);
      logger.info('WS: file.deleted - fichier local supprime', { localPath });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.info('WS: file.deleted - fichier local deja absent', { localPath });
      } else {
        logger.error('WS: file.deleted - suppression echouee', {
          localPath,
          message: (err as Error).message,
        });
      }
    }
    const removed = deleteManifestEntryByFileId(payload.fileId);
    logger.info('WS: file.deleted - manifest nettoye', { fileId: payload.fileId, removed });
  }
}

type FileUpdatedPayload = {
  fileId: number;
  folderId: number;
  relativePath: string;
  sha256: string | null;
  sizeBytes: number | null;
};
type FileDeletedPayload = { fileId: number; folderId: number };
