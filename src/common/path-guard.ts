import { normalize, parse, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { openDb } from '../db/sqlite.js';
import { logAudit } from './audit-log.js';

export class PathNotAllowedError extends Error {
  constructor(public readonly path: string) {
    super(`Path refuse par assertPathAllowed : ${path}`);
    this.name = 'PathNotAllowedError';
  }
}

export class BindingPathUnsafeError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Binding refuse (${reason}) : ${path}`);
    this.name = 'BindingPathUnsafeError';
  }
}

const WINDOWS_FORBIDDEN_PARENTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
];

const POSIX_FORBIDDEN_PARENTS = [
  '/etc',
  '/root',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/var/run',
  '/var/log',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
];

export function assertBindingPathSafe(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new BindingPathUnsafeError(rawPath, 'chemin vide');
  }
  if (rawPath.includes('\0')) {
    throw new BindingPathUnsafeError(rawPath, 'null byte');
  }
  const absolute = resolve(normalize(rawPath.trim()));
  if (absolute.includes('..')) {
    throw new BindingPathUnsafeError(absolute, 'path traversal residuel');
  }
  const { root, dir } = parse(absolute);
  if (absolute === root || withTrailingSep(absolute) === withTrailingSep(root)) {
    throw new BindingPathUnsafeError(absolute, 'racine disque interdite');
  }
  if (dir === root) {
    throw new BindingPathUnsafeError(absolute, 'dossier de premier niveau interdit');
  }
  const forbidden = platform() === 'win32' ? WINDOWS_FORBIDDEN_PARENTS : POSIX_FORBIDDEN_PARENTS;
  const checkable = platform() === 'win32' ? absolute.toLowerCase() : absolute;
  for (const parent of forbidden) {
    const normalizedParent = platform() === 'win32' ? parent.toLowerCase() : parent;
    if (checkable === normalizedParent || withTrailingSep(checkable).startsWith(withTrailingSep(normalizedParent))) {
      throw new BindingPathUnsafeError(absolute, `dossier systeme interdit (${parent})`);
    }
  }
  return absolute;
}

export function listActiveBindingPaths(): string[] {
  const db = openDb();
  const rows = db
    .prepare('SELECT local_path FROM local_bindings')
    .all() as Array<{ local_path: string }>;
  return rows.map((r) => withTrailingSep(resolve(r.local_path)));
}

export function assertPathAllowed(path: string, op: 'read' | 'write' | 'delete' | 'readdir'): void {
  const absolute = resolve(normalize(path));
  const bindings = listActiveBindingPaths();
  const allowed = bindings.some((b) => withTrailingSep(absolute).startsWith(b));
  if (!allowed) {
    logAudit({ operation: op, path: absolute, result: 'denied', details: 'hors binding' });
    throw new PathNotAllowedError(absolute);
  }
}

function withTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}
