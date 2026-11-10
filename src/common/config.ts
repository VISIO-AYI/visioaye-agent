import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './paths.js';

export const AGENT_VERSION = '0.1.2';

export const LOCAL_HTTP_HOST = process.env['VISIOAYE_LOCAL_HTTP_HOST'] ?? '127.0.0.1';
export const LOCAL_HTTP_PORT = Number(process.env['VISIOAYE_LOCAL_HTTP_PORT'] ?? 19876);

export const PROD_SERVER_URL = 'https://api.visioayi.eu';
export const DEV_SERVER_URL = 'http://localhost:3001';

const DEFAULT_CORS_ORIGINS = ['https://app.visioayi.eu', 'http://localhost:3000'];

export function getCorsOrigins(): string[] {
  const raw = process.env['VISIOAYE_CORS_ORIGINS'];
  if (!raw) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type AgentConfig = { serverUrl?: string };

function loadConfig(): AgentConfig {
  const configPath = join(getDataDir(), 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as AgentConfig;
  } catch {
    return {};
  }
}

export function getServerUrl(): string {
  if (process.env['VISIOAYE_SERVER_URL']) return process.env['VISIOAYE_SERVER_URL'];
  const cfg = loadConfig();
  if (cfg.serverUrl) return cfg.serverUrl;
  return PROD_SERVER_URL;
}

export function getWsUrl(): string {
  const base = getServerUrl();
  return base.replace(/^http/, 'ws') + '/sync/ws';
}
