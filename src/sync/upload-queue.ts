import { openDb } from '../db/sqlite.js';
import { logger } from '../common/logger.js';
import { ConflictDetected, uploadLocalFile } from './uploader.js';

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS upload_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  local_path TEXT NOT NULL,
  file_id INTEGER,
  expected_server_sha TEXT,
  mime_type TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  UNIQUE (binding_id, relative_path)
);
CREATE INDEX IF NOT EXISTS upload_queue_next_idx ON upload_queue (next_attempt_at);
`;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type QueueRow = {
  id: number;
  binding_id: number;
  relative_path: string;
  local_path: string;
  file_id: number | null;
  expected_server_sha: string | null;
  mime_type: string | null;
  attempts: number;
};

export function initQueue(): void {
  openDb().exec(QUEUE_SCHEMA);
}

export function enqueueUpload(entry: {
  bindingId: number;
  relativePath: string;
  localPath: string;
  fileId?: number | null;
  expectedServerSha256?: string | null;
  mimeType?: string | null;
}): void {
  logger.info('Queue: enqueueUpload', {
    bindingId: entry.bindingId,
    rel: entry.relativePath,
    fileId: entry.fileId ?? null,
  });
  const db = openDb();
  db.prepare(
    `INSERT INTO upload_queue
       (binding_id, relative_path, local_path, file_id, expected_server_sha, mime_type)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(binding_id, relative_path) DO UPDATE SET
       local_path = excluded.local_path,
       file_id = excluded.file_id,
       expected_server_sha = excluded.expected_server_sha,
       mime_type = excluded.mime_type,
       attempts = 0,
       next_attempt_at = datetime('now'),
       last_error = NULL`,
  ).run([
    entry.bindingId,
    entry.relativePath,
    entry.localPath,
    entry.fileId ?? null,
    entry.expectedServerSha256 ?? null,
    entry.mimeType ?? null,
  ]);
}

export async function processNext(): Promise<boolean> {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, binding_id, relative_path, local_path, file_id,
              expected_server_sha, mime_type, attempts
         FROM upload_queue
        WHERE next_attempt_at <= datetime('now')
        ORDER BY next_attempt_at ASC
        LIMIT 1`,
    )
    .get() as QueueRow | undefined;
  if (!row) {
    logger.debug('Queue: processNext - rien a faire');
    return false;
  }

  logger.info('Worker: traite entree upload', {
    queueId: row.id,
    bindingId: row.binding_id,
    rel: row.relative_path,
    fileId: row.file_id,
    attempts: row.attempts,
  });

  try {
    await uploadLocalFile({
      bindingId: row.binding_id,
      relativePath: row.relative_path,
      localPath: row.local_path,
      fileId: row.file_id ?? undefined,
      expectedServerSha256: row.expected_server_sha ?? undefined,
      mimeType: row.mime_type ?? undefined,
    });
    db.prepare('DELETE FROM upload_queue WHERE id = ?').run([row.id]);
    return true;
  } catch (err) {
    if (err instanceof ConflictDetected) {
      logger.warn('Conflit detecte - rename local (TODO watcher reeenqueue)', {
        fileId: err.payload.fileId,
        suggested: err.payload.suggestedName,
      });
      db.prepare('DELETE FROM upload_queue WHERE id = ?').run([row.id]);
      return true;
    }
    const attempts = row.attempts + 1;
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    const nextAt = new Date(Date.now() + backoff).toISOString();
    if (attempts >= MAX_ATTEMPTS) {
      logger.error('Upload abandonne apres trop de tentatives', {
        id: row.id,
        path: row.local_path,
        err: (err as Error).message,
      });
      db.prepare('DELETE FROM upload_queue WHERE id = ?').run([row.id]);
      return true;
    }
    db.prepare(
      `UPDATE upload_queue
          SET attempts = ?, next_attempt_at = ?, last_error = ?
        WHERE id = ?`,
    ).run([attempts, nextAt, (err as Error).message.slice(0, 500), row.id]);
    logger.warn('Upload retry planifie', { id: row.id, attempts, backoffMs: backoff });
    return true;
  }
}

export function queueLength(): number {
  const db = openDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM upload_queue').get() as { c: number };
  return row.c;
}
