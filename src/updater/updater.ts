import { request } from 'undici';
import { AGENT_VERSION, getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import {
  ManifestVerificationError,
  parseManifest,
  verifyManifestSignature,
  type UpdateManifest,
} from './manifest-verify.js';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const MANIFEST_PATH = '/releases/latest.json';
const SIGNATURE_PATH = '/releases/latest.json.sig';

export function startUpdater(): void {
  logger.info('Updater: demarre', { intervalMs: CHECK_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS });
  setTimeout(() => {
    void checkOnce();
    setInterval(() => void checkOnce(), CHECK_INTERVAL_MS).unref();
  }, INITIAL_DELAY_MS).unref();
}

async function checkOnce(): Promise<void> {
  const baseUrl = getServerUrl();
  logger.info('Updater: check demarre', { baseUrl });
  try {
    const manifestJson = await fetchText(`${baseUrl}${MANIFEST_PATH}`);
    const signatureB64 = await fetchText(`${baseUrl}${SIGNATURE_PATH}`);
    verifyManifestSignature(manifestJson, signatureB64);
    const manifest = parseManifest(manifestJson);
    evaluateUpdate(manifest);
  } catch (err) {
    if (err instanceof ManifestVerificationError) {
      logger.error('Updater: manifest refuse (signature invalide)', { reason: err.reason });
      return;
    }
    logger.warn('Updater: check echoue', { message: (err as Error).message });
  }
}

function evaluateUpdate(manifest: UpdateManifest): void {
  if (manifest.version === AGENT_VERSION) {
    logger.info('Updater: deja a jour', { version: AGENT_VERSION });
    return;
  }
  if (!isNewerVersion(manifest.version, AGENT_VERSION)) {
    logger.info('Updater: manifest annonce version anterieure, ignore', {
      remote: manifest.version,
      local: AGENT_VERSION,
    });
    return;
  }
  const installer = manifest.binaries.find((b) => b.installer && b.os === 'windows');
  logger.warn('Updater: nouvelle version disponible (install manuel pour l\'instant)', {
    remote: manifest.version,
    local: AGENT_VERSION,
    installer: installer ? { filename: installer.filename, sha256: installer.sha256, url: installer.downloadUrl } : null,
  });
}

function isNewerVersion(remote: string, local: string): boolean {
  const [r1 = 0, r2 = 0, r3 = 0] = remote.split('.').map((s) => Number(s) || 0);
  const [l1 = 0, l2 = 0, l3 = 0] = local.split('.').map((s) => Number(s) || 0);
  if (r1 !== l1) return r1 > l1;
  if (r2 !== l2) return r2 > l2;
  return r3 > l3;
}

async function fetchText(url: string): Promise<string> {
  const res = await request(url, { method: 'GET' });
  if (res.statusCode !== 200) {
    throw new Error(`GET ${url} -> ${res.statusCode}`);
  }
  return res.body.text();
}
