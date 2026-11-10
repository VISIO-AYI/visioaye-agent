import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'undici';
import { logAudit } from '../common/audit-log.js';
import { getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { assertPathAllowed } from '../common/path-guard.js';
import { getStoredJwt } from '../pairing/pairing.service.js';

type UploadInitBody = {
  fileId?: number;
  bindingId: number;
  relativePath: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  expectedServerSha256?: string;
};

type UploadInitResponse = {
  fileId: number;
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
};

type ConflictPayload = {
  status: 'conflict';
  fileId: number;
  serverSha256: string;
  suggestedName: string;
};

export class ConflictDetected extends Error {
  constructor(public readonly payload: ConflictPayload) {
    super(`Conflit: ${payload.fileId} (suggestion ${payload.suggestedName})`);
    this.name = 'ConflictDetected';
  }
}

export async function uploadLocalFile(params: {
  localPath: string;
  bindingId: number;
  relativePath: string;
  fileId?: number;
  expectedServerSha256?: string;
  mimeType?: string;
}): Promise<{ fileId: number; sha256: string }> {
  const { localPath, bindingId, relativePath, fileId, expectedServerSha256, mimeType } = params;
  assertPathAllowed(localPath, 'read');

  const jwt = getStoredJwt();
  if (!jwt) throw new Error('Agent non paired');

  const stat = statSync(localPath);
  const sizeBytes = stat.size;
  const content = readFileSync(localPath);
  const sha256 = createHash('sha256').update(content).digest('hex');

  logger.info('Uploader: appel /sync/upload-init', {
    bindingId,
    relativePath,
    fileId,
    sizeBytes,
    sha256: sha256.slice(0, 12),
  });

  const init = await fetchJson<UploadInitResponse>(
    '/sync/upload-init',
    jwt,
    {
      fileId,
      bindingId,
      relativePath,
      filename: relativePath.split('/').pop() ?? relativePath,
      mimeType,
      sizeBytes,
      expectedServerSha256,
    } satisfies UploadInitBody,
  );

  logger.info('Uploader: /sync/upload-init OK, PUT S3', {
    fileId: init.fileId,
    uploadUrl: init.uploadUrl.slice(0, 80),
  });

  const put = await request(init.uploadUrl, {
    method: 'PUT',
    body: content,
    headers: {
      'content-type': mimeType ?? 'application/octet-stream',
      'content-length': String(sizeBytes),
    },
  });
  if (put.statusCode >= 300) {
    const body = await put.body.text();
    throw new Error(`PUT S3 failed ${put.statusCode}: ${body}`);
  }

  await fetchJson('/sync/upload-complete', jwt, {
    fileId: init.fileId,
    sha256,
    sizeBytesActual: sizeBytes,
  });

  logAudit({
    operation: 'upload',
    path: localPath,
    fileId: init.fileId,
    result: 'ok',
    details: `${sizeBytes} bytes, sha ${sha256.slice(0, 12)}`,
  });
  logger.info('Fichier uploade', { path: localPath, fileId: init.fileId });
  return { fileId: init.fileId, sha256 };
}

async function fetchJson<T>(path: string, jwt: string, body: unknown): Promise<T> {
  const res = await request(`${getServerUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode === 409) {
    try {
      const parsed = JSON.parse(text) as { message?: ConflictPayload };
      if (parsed.message && typeof parsed.message === 'object') {
        throw new ConflictDetected(parsed.message);
      }
    } catch (err) {
      if (err instanceof ConflictDetected) throw err;
    }
    throw new Error(`Conflit non parsable: ${text}`);
  }
  if (res.statusCode >= 300) {
    throw new Error(`${path} failed ${res.statusCode}: ${text}`);
  }
  return JSON.parse(text) as T;
}
