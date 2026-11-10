import { openDb } from '../db/sqlite.js';

export type AuditOperation = 'read' | 'write' | 'delete' | 'readdir' | 'upload' | 'download';
export type AuditResult = 'ok' | 'denied' | 'error';

export type AuditEntry = {
  operation: AuditOperation;
  path: string;
  fileId?: number | null;
  result: AuditResult;
  details?: string | null;
};

export function logAudit(entry: AuditEntry): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO audit_log (operation, path, file_id, result, details) VALUES (?, ?, ?, ?, ?)`,
  ).run([
    entry.operation,
    entry.path,
    entry.fileId ?? null,
    entry.result,
    entry.details ?? null,
  ]);
}

export function pendingAuditEntries(limit = 500): Array<AuditEntry & { id: number; ts: string }> {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, ts, operation, path, file_id as fileId, result, details
         FROM audit_log
         WHERE pushed_at IS NULL
         ORDER BY ts ASC
         LIMIT ?`,
    )
    .all([limit]) as unknown as Array<AuditEntry & { id: number; ts: string }>;
  return rows;
}

export function markAuditPushed(ids: number[]): void {
  if (ids.length === 0) return;
  const db = openDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE audit_log SET pushed_at = datetime('now') WHERE id IN (${placeholders})`).run(
    ids,
  );
}
