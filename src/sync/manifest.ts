import { request } from 'undici';
import { getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { openDb } from '../db/sqlite.js';
import { getStoredJwt } from '../pairing/pairing.service.js';

type ManifestFile = {
  id: number;
  relativePath: string;
  name: string;
  sha256: string | null;
  sizeBytes: number | null;
};

export async function refreshManifest(bindingId: number, folderId: number): Promise<number> {
  logger.info('Manifest: refresh demande', { bindingId, folderId });
  const jwt = getStoredJwt();
  if (!jwt) {
    logger.warn('Manifest refresh impossible : agent non paired');
    return 0;
  }
  const res = await request(`${getServerUrl()}/sync/projects/${folderId}/manifest`, {
    method: 'GET',
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.statusCode !== 200) {
    const body = await res.body.text();
    logger.error('Manifest fetch echoue', { status: res.statusCode, body: body.slice(0, 200) });
    return 0;
  }
  const files = (await res.body.json()) as ManifestFile[];
  const db = openDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM manifest_files WHERE binding_id = ?').run([bindingId]);
    const stmt = db.prepare(
      'INSERT INTO manifest_files (binding_id, relative_path, file_id, sha256, size_bytes) VALUES (?, ?, ?, ?, ?)',
    );
    for (const f of files) {
      stmt.run([bindingId, f.relativePath, f.id, f.sha256, f.sizeBytes]);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logger.info('Manifest rafraichi', { bindingId, count: files.length });
  return files.length;
}

export function lookupManifestFileId(bindingId: number, relativePath: string): number | null {
  const db = openDb();
  const row = db
    .prepare(
      'SELECT file_id FROM manifest_files WHERE binding_id = ? AND relative_path = ?',
    )
    .get([bindingId, relativePath]) as { file_id: number } | undefined;
  return row?.file_id ?? null;
}

export function lookupManifestSha(bindingId: number, relativePath: string): string | null {
  const db = openDb();
  const row = db
    .prepare(
      'SELECT sha256 FROM manifest_files WHERE binding_id = ? AND relative_path = ?',
    )
    .get([bindingId, relativePath]) as { sha256: string | null } | undefined;
  return row?.sha256 ?? null;
}

export function lookupManifestByFileId(
  fileId: number,
): { bindingId: number; relativePath: string; sha256: string | null } | null {
  const db = openDb();
  const row = db
    .prepare(
      'SELECT binding_id, relative_path, sha256 FROM manifest_files WHERE file_id = ? LIMIT 1',
    )
    .get([fileId]) as
    | { binding_id: number; relative_path: string; sha256: string | null }
    | undefined;
  if (!row) return null;
  return { bindingId: row.binding_id, relativePath: row.relative_path, sha256: row.sha256 };
}

export function upsertManifestFile(entry: {
  bindingId: number;
  relativePath: string;
  fileId: number;
  sha256: string | null;
  sizeBytes: number | null;
}): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO manifest_files (binding_id, relative_path, file_id, sha256, size_bytes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(binding_id, relative_path) DO UPDATE SET
       file_id = excluded.file_id,
       sha256 = excluded.sha256,
       size_bytes = excluded.size_bytes`,
  ).run([entry.bindingId, entry.relativePath, entry.fileId, entry.sha256, entry.sizeBytes]);
}

export function deleteManifestEntryByFileId(fileId: number): number {
  const db = openDb();
  const res = db.prepare('DELETE FROM manifest_files WHERE file_id = ?').run([fileId]);
  return res.changes ?? 0;
}

export function lookupBindingByFolderId(
  folderId: number,
): { bindingId: number; localPath: string } | null {
  const db = openDb();
  const row = db
    .prepare('SELECT server_id, local_path FROM local_bindings WHERE folder_id = ? LIMIT 1')
    .get([folderId]) as { server_id: number; local_path: string } | undefined;
  if (!row) return null;
  return { bindingId: row.server_id, localPath: row.local_path };
}

export async function refreshAllBindings(): Promise<void> {
  const db = openDb();
  const bindings = db
    .prepare('SELECT id, server_id, folder_id FROM local_bindings')
    .all() as Array<{ id: number; server_id: number; folder_id: number }>;
  for (const b of bindings) {
    try {
      await refreshManifest(b.server_id, b.folder_id);
    } catch (err) {
      logger.error('Refresh manifest echoue pour binding', {
        bindingId: b.server_id,
        folderId: b.folder_id,
        message: (err as Error).message,
      });
    }
  }
}
