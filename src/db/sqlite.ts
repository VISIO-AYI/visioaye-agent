import { rmSync, statSync } from 'node:fs';
import sqliteWasm from 'node-sqlite3-wasm';
import type { Database as SqliteDb } from 'node-sqlite3-wasm';
import { logger } from '../common/logger.js';
import { getSqlitePath } from '../common/paths.js';

const { Database } = sqliteWasm;

const SQLITE_LOCK_SUFFIXES = ['.lock', '-wal', '-shm', '-journal'];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  server_id INTEGER PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL,
  jwt TEXT NOT NULL,
  paired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL UNIQUE,
  folder_id INTEGER NOT NULL,
  local_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  operation TEXT NOT NULL,
  path TEXT NOT NULL,
  file_id INTEGER,
  result TEXT NOT NULL,
  details TEXT,
  pushed_at TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_pending_idx ON audit_log (pushed_at, ts);

CREATE TABLE IF NOT EXISTS manifest_files (
  binding_id INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  UNIQUE (binding_id, relative_path)
);
CREATE INDEX IF NOT EXISTS manifest_files_binding_idx ON manifest_files (binding_id);
`;

let dbInstance: SqliteDb | null = null;

export function openDb(): SqliteDb {
  if (dbInstance) return dbInstance;
  cleanupStaleLockDirs();
  const db = new Database(getSqlitePath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  dbInstance = db;
  return db;
}

function cleanupStaleLockDirs(): void {
  const base = getSqlitePath();
  for (const suffix of SQLITE_LOCK_SUFFIXES) {
    const path = base + suffix;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      logger.warn('SQLite: dossier parasite supprime avant openDb', { path });
    } catch (err) {
      logger.error('SQLite: impossible de supprimer le dossier parasite', {
        path,
        message: (err as Error).message,
      });
    }
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
