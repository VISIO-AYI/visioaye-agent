import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from '../common/logger.js';

const TOKEN_BYTES = 32;
const APP_NAME = 'VisioAye';

let cachedToken: string | null = null;
let cachedTokenPath: string | null = null;

export function initLocalToken(): { token: string; path: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const path = getTokenFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  restrictToOwner(path);
  cachedToken = token;
  cachedTokenPath = path;
  logger.info('Local token genere', { path, length: token.length });
  return { token, path };
}

export function getLocalToken(): string | null {
  return cachedToken;
}

export function getLocalTokenPath(): string | null {
  return cachedTokenPath;
}

export function verifyLocalToken(provided: string | undefined): boolean {
  if (!cachedToken || typeof provided !== 'string') return false;
  if (provided.length !== cachedToken.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ cachedToken.charCodeAt(i);
  }
  return diff === 0;
}

function getTokenFilePath(): string {
  const os = platform();
  if (os === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return join(base, APP_NAME, 'local-token.txt');
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME, 'local-token.txt');
  }
  return join(homedir(), '.config', APP_NAME.toLowerCase(), 'local-token.txt');
}

function restrictToOwner(path: string): void {
  if (platform() === 'win32') {
    const user = process.env['USERNAME'];
    if (!user) return;
    try {
      spawnSync('icacls', [path, '/inheritance:r'], { stdio: 'ignore' });
      spawnSync('icacls', [path, '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } catch (err) {
      logger.warn('restrictToOwner (icacls) echec - token reste lisible par groupes hérités', {
        message: (err as Error).message,
      });
    }
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    logger.warn('restrictToOwner (chmod) echec', { message: (err as Error).message });
  }
}
