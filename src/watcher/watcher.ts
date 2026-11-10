import { statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import chokidar from 'chokidar';
import { logAudit } from '../common/audit-log.js';
import { getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { openDb } from '../db/sqlite.js';
import { getStoredJwt } from '../pairing/pairing.service.js';
import { lookupManifestFileId, lookupManifestSha } from '../sync/manifest.js';
import { enqueueUpload, processNext } from '../sync/upload-queue.js';
import { getIgnoredPatterns } from './ignored.js';

const DEBOUNCE_MS = 500;
const DOWNLOAD_GUARD_MS = 2_000;
const WORKER_TICK_MS = 1_000;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

type Chokidar = typeof chokidar;

type WatcherDeps = {
  chokidar?: Chokidar;
};

type ActiveWatcher = {
  bindingId: number;
  folderId: number;
  localPath: string;
  watcher: unknown;
  pending: Map<string, NodeJS.Timeout>;
  recentDownloads: Map<string, number>;
};

const active = new Map<number, ActiveWatcher>();
let workerTimer: NodeJS.Timeout | null = null;

export function markRecentDownload(bindingId: number, relativePath: string): void {
  const w = active.get(bindingId);
  if (!w) return;
  w.recentDownloads.set(relativePath, Date.now() + DOWNLOAD_GUARD_MS);
}

export async function startWatchers(deps: WatcherDeps = {}): Promise<void> {
  const lib = deps.chokidar ?? chokidar;
  logger.info('startWatchers: chokidar charge, lecture des bindings');

  const bindings = openDb()
    .prepare('SELECT server_id, folder_id, local_path FROM local_bindings')
    .all() as Array<{ server_id: number; folder_id: number; local_path: string }>;
  logger.info('startWatchers: bindings a attacher', { count: bindings.length });

  for (const b of bindings) {
    if (active.has(b.server_id)) {
      logger.debug('startWatchers: deja attache', { bindingId: b.server_id });
      continue;
    }
    attachWatcher(lib, b.server_id, b.folder_id, b.local_path);
  }
  startWorker();
}

export async function attachBinding(
  serverId: number,
  folderId: number,
  localPath: string,
): Promise<void> {
  if (active.has(serverId)) return;
  attachWatcher(chokidar, serverId, folderId, localPath);
  startWorker();
}

export function stopWatchers(): void {
  for (const [, w] of active) {
    for (const timer of w.pending.values()) clearTimeout(timer);
    void (w.watcher as { close?: () => Promise<void> }).close?.();
  }
  active.clear();
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

function attachWatcher(
  lib: Chokidar,
  bindingId: number,
  folderId: number,
  localPath: string,
): void {
  const watcher = lib.watch(localPath, {
    ignored: getIgnoredPatterns(),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const state: ActiveWatcher = {
    bindingId,
    folderId,
    localPath,
    watcher,
    pending: new Map(),
    recentDownloads: new Map(),
  };
  active.set(bindingId, state);

  const handle = (event: 'add' | 'change' | 'unlink', fullPath: string) => {
    const rel = relative(localPath, fullPath).split(sep).join('/');
    logger.info('chokidar event', { bindingId, event, fullPath, rel });
    if (!rel || rel.startsWith('..')) {
      logger.warn('chokidar event ignore (rel invalide)', { bindingId, rel });
      return;
    }
    const guardUntil = state.recentDownloads.get(rel);
    if (guardUntil && guardUntil > Date.now()) {
      logger.info('chokidar event ignore (guard download recent)', { bindingId, rel });
      return;
    }

    const existing = state.pending.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void onDebounced(state, event, fullPath, rel), DEBOUNCE_MS);
    state.pending.set(rel, timer);
  };

  watcher.on('add', (p: string) => handle('add', p));
  watcher.on('change', (p: string) => handle('change', p));
  watcher.on('unlink', (p: string) => handle('unlink', p));
  watcher.on('ready', () => logger.info('Watcher ready (scan initial OK)', { bindingId, localPath }));
  watcher.on('error', (err: unknown) =>
    logger.error('Watcher erreur', { bindingId, message: err instanceof Error ? err.message : String(err) }),
  );

  logger.info('Watcher attache', { bindingId, localPath });
}

async function onDebounced(
  state: ActiveWatcher,
  event: 'add' | 'change' | 'unlink',
  fullPath: string,
  rel: string,
): Promise<void> {
  logger.info('onDebounced', { bindingId: state.bindingId, event, rel });
  state.pending.delete(rel);

  if (event === 'unlink') {
    await handleLocalDeletion(state, rel);
    return;
  }

  let sizeBytes: number;
  try {
    sizeBytes = statSync(fullPath).size;
  } catch (err) {
    logger.warn('onDebounced: stat impossible, abandon', {
      rel,
      message: (err as Error).message,
    });
    return;
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    logger.warn('onDebounced: fichier trop gros, upload refuse', {
      rel,
      sizeBytes,
      limitBytes: MAX_FILE_SIZE_BYTES,
    });
    logAudit({
      operation: 'upload',
      path: fullPath,
      result: 'denied',
      details: `taille ${sizeBytes} > limite ${MAX_FILE_SIZE_BYTES}`,
    });
    return;
  }

  const manifestFileId = lookupManifestFileId(state.bindingId, rel);
  logger.info('lookupManifestFileId resultat', { bindingId: state.bindingId, rel, manifestFileId });
  if (manifestFileId === null) {
    logger.warn('Fichier inconnu du manifest -> handleNewFile (pas d upload)', {
      bindingId: state.bindingId,
      rel,
    });
    await handleNewFile(state, rel, fullPath, sizeBytes);
    return;
  }

  const expectedServerSha256 = lookupManifestSha(state.bindingId, rel) ?? undefined;
  enqueueUpload({
    bindingId: state.bindingId,
    relativePath: rel,
    localPath: fullPath,
    fileId: manifestFileId,
    expectedServerSha256,
  });
  logger.info('Upload enqueue', { bindingId: state.bindingId, rel, fileId: manifestFileId });
}

async function handleNewFile(
  state: ActiveWatcher,
  rel: string,
  fullPath: string,
  sizeBytes: number,
): Promise<void> {
  logger.info('handleNewFile: fichier hors manifeste, signal pending-additions (PAS d upload auto)', {
    bindingId: state.bindingId,
    rel,
    fullPath,
    sizeBytes,
  });
  logAudit({
    operation: 'read',
    path: fullPath,
    result: 'denied',
    details: 'nouveau fichier hors manifeste - pas de lecture sans consentement',
  });
  await postToServer('/sync/pending-additions', {
    bindingId: state.bindingId,
    items: [{ relativePath: rel, sizeBytes }],
  });
  logger.info('handleNewFile: pending-additions envoye au serveur', {
    bindingId: state.bindingId,
    rel,
    sizeBytes,
  });
}

async function handleLocalDeletion(state: ActiveWatcher, rel: string): Promise<void> {
  const fileId = lookupManifestFileId(state.bindingId, rel);
  logger.info('handleLocalDeletion', { bindingId: state.bindingId, rel, fileId });
  if (fileId === null) {
    logger.debug('handleLocalDeletion: fileId inconnu, rien a signaler');
    return;
  }
  await postToServer('/sync/local-deletion', { fileId });
  logger.info('handleLocalDeletion: signal local-deletion envoye', { fileId });
}

async function postToServer(path: string, body: unknown): Promise<void> {
  const jwt = getStoredJwt();
  if (!jwt) {
    logger.warn('postToServer: pas de JWT, abandon', { path });
    return;
  }
  try {
    const { request } = await import('undici');
    logger.debug('postToServer: envoi', { path });
    const res = await request(`${getServerUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    });
    logger.debug('postToServer: reponse', { path, status: res.statusCode });
  } catch (err) {
    logger.error('Signal serveur echoue', { path, message: (err as Error).message });
  }
}

function startWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void processNext().catch((err) =>
      logger.error('Worker upload erreur', { message: (err as Error).message }),
    );
  }, WORKER_TICK_MS);
  workerTimer.unref();
}

export function joinBindingPath(localPath: string, rel: string): string {
  return join(localPath, rel.split('/').join(sep));
}
