import { hostname, platform } from 'node:os';
import { request } from 'undici';
import { AGENT_VERSION, getServerUrl } from '../common/config.js';
import { logger } from '../common/logger.js';
import { decryptJwt, encryptJwt, isEncrypted } from '../db/jwt-crypto.js';
import { openDb } from '../db/sqlite.js';

type DeviceOs = 'windows' | 'macos' | 'linux';

type PairingCompleteResponse = {
  device: { id: number; hostname: string; os: string; agentVersion: string | null };
  accessToken: string;
};

function detectOs(): DeviceOs {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

export async function completePairing(pairingCode: string): Promise<{ deviceId: number }> {
  const url = `${getServerUrl()}/devices/complete-pairing`;
  const body = {
    pairingCode,
    hostname: hostname(),
    os: detectOs(),
    agentVersion: AGENT_VERSION,
  };
  logger.info('Pairing: appel serveur', { url, hostname: body.hostname, os: body.os });
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.statusCode !== 201) {
    const text = await res.body.text();
    logger.error('Pairing refuse', { status: res.statusCode, body: text.slice(0, 200) });
    throw new Error(`Pairing refuse (${res.statusCode}): ${text}`);
  }
  const data = (await res.body.json()) as PairingCompleteResponse;
  persistDeviceToken(data);
  logger.info('Pairing complete', { deviceId: data.device.id, hostname: body.hostname });
  return { deviceId: data.device.id };
}

function persistDeviceToken(data: PairingCompleteResponse): void {
  const db = openDb();
  const stored = encryptJwt(data.accessToken);
  db.prepare('DELETE FROM devices').run();
  db.prepare(
    'INSERT INTO devices (server_id, user_id, jwt) VALUES (?, ?, ?)',
  ).run([data.device.id, extractUserId(data.accessToken), stored]);
  logger.info('Device token persiste', { encrypted: isEncrypted(stored) });
}

function extractUserId(jwt: string): number {
  const [, payloadPart] = jwt.split('.');
  if (!payloadPart) throw new Error('JWT mal forme');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  return payload.sub as number;
}

export function getStoredJwt(): string | null {
  const db = openDb();
  const row = db.prepare('SELECT jwt FROM devices LIMIT 1').get() as { jwt: string } | undefined;
  if (!row) return null;
  const plain = decryptJwt(row.jwt);
  if (!plain) return null;
  if (!isEncrypted(row.jwt)) {
    migrateLegacyJwt(plain);
  }
  return plain;
}

function migrateLegacyJwt(plain: string): void {
  try {
    const db = openDb();
    const reencrypted = encryptJwt(plain);
    if (!isEncrypted(reencrypted)) return;
    db.prepare('UPDATE devices SET jwt = ? WHERE jwt NOT LIKE ?').run([reencrypted, 'dpapi:%']);
    logger.info('Migration JWT legacy -> DPAPI effectuee');
  } catch (err) {
    logger.warn('Migration JWT legacy -> DPAPI echouee', { message: (err as Error).message });
  }
}

export function getDeviceId(): number | null {
  const db = openDb();
  const row = db.prepare('SELECT server_id FROM devices LIMIT 1').get() as
    | { server_id: number }
    | undefined;
  return row?.server_id ?? null;
}

export function isPaired(): boolean {
  return getStoredJwt() !== null;
}

export function unpairLocal(): void {
  const db = openDb();
  db.prepare('DELETE FROM devices').run();
  db.prepare('DELETE FROM local_bindings').run();
  logger.info('Agent unpair (local wipe)');
}

export async function refreshJwt(): Promise<boolean> {
  const jwt = getStoredJwt();
  const deviceId = getDeviceId();
  if (!jwt || deviceId === null) return false;
  const res = await request(`${getServerUrl()}/devices/${deviceId}/jwt-refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.statusCode === 401 || res.statusCode === 403) {
    logger.warn('JWT refresh refuse - device revoque cote serveur, unpair local');
    unpairLocal();
    return false;
  }
  if (res.statusCode !== 200) {
    logger.error('JWT refresh echoue', { status: res.statusCode });
    return false;
  }
  const data = (await res.body.json()) as { accessToken: string };
  const db = openDb();
  const stored = encryptJwt(data.accessToken);
  db.prepare('UPDATE devices SET jwt = ? WHERE server_id = ?').run([stored, deviceId]);
  return true;
}
