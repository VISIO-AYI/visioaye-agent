import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';
import { logAudit } from '../common/audit-log.js';
import { getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { assertPathAllowed } from '../common/path-guard.js';
import { getStoredJwt } from '../pairing/pairing.service.js';

type RemoteFile = {
  id: number;
  name: string;
  sha256: string | null;
  sizeBytes: number | null;
  relativePath: string;
};

export async function downloadFileToBinding(remote: RemoteFile, bindingPath: string): Promise<void> {
  const localPath = join(bindingPath, remote.relativePath);
  logger.info('Downloader: start', {
    fileId: remote.id,
    relativePath: remote.relativePath,
    localPath,
    expectedSha: remote.sha256?.slice(0, 12),
  });
  assertPathAllowed(localPath, 'write');

  const jwt = getStoredJwt();
  if (!jwt) throw new Error('Agent non paired');

  logger.debug('Downloader: GET /files/:id/download', { fileId: remote.id });
  const presign = await request(`${getServerUrl()}/files/${remote.id}/download`, {
    method: 'GET',
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (presign.statusCode !== 200) {
    logAudit({
      operation: 'download',
      path: localPath,
      fileId: remote.id,
      result: 'error',
      details: `download-init ${presign.statusCode}`,
    });
    throw new Error(`download-init failed (${presign.statusCode})`);
  }
  const { presignedUrl } = (await presign.body.json()) as { presignedUrl: string };
  logger.debug('Downloader: presignedUrl obtenu, fetch blob', {
    fileId: remote.id,
    urlPrefix: presignedUrl.slice(0, 80),
  });

  const blob = await request(presignedUrl, { method: 'GET' });
  if (blob.statusCode !== 200) {
    throw new Error(`blob fetch failed (${blob.statusCode})`);
  }

  await mkdir(dirname(localPath), { recursive: true });
  await pipeline(blob.body, createWriteStream(localPath));
  logger.debug('Downloader: blob ecrit', { localPath });

  if (remote.sha256) {
    const actual = sha256OfFile(localPath);
    if (actual !== remote.sha256) {
      logAudit({
        operation: 'download',
        path: localPath,
        fileId: remote.id,
        result: 'error',
        details: `SHA mismatch expected ${remote.sha256} got ${actual}`,
      });
      throw new Error('SHA mismatch');
    }
  }

  logAudit({ operation: 'download', path: localPath, fileId: remote.id, result: 'ok' });
  logger.info('Fichier telecharge', { path: localPath, fileId: remote.id });
}

export function sha256OfFile(path: string): string {
  assertPathAllowed(path, 'read');
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

export function localFileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  return statSync(path).isFile();
}

export async function initialScan(bindingPath: string, manifest: RemoteFile[]): Promise<void> {
  logger.info('Scan initial (seul readdir autorise)', { bindingPath, count: manifest.length });
  logAudit({ operation: 'readdir', path: bindingPath, result: 'ok', details: 'scan initial unique' });
  for (const file of manifest) {
    const local = join(bindingPath, file.relativePath);
    if (!localFileExists(local)) {
      await downloadFileToBinding(file, bindingPath);
    }
  }
}
