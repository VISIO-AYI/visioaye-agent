import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'VisioAye';

export function getDataDir(): string {
  const os = platform();
  if (os === 'win32') {
    const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
    return join(programData, APP_NAME);
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return join('/var', 'lib', APP_NAME.toLowerCase());
}

export function getLogDir(): string {
  const os = platform();
  if (os === 'win32') {
    return join(getDataDir(), 'logs');
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Logs', APP_NAME);
  }
  return join('/var', 'log', APP_NAME.toLowerCase());
}

export function getSqlitePath(): string {
  return join(getDataDir(), 'agent.sqlite');
}

export function ensureDataDirs(): void {
  mkdirSync(getDataDir(), { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });
}
