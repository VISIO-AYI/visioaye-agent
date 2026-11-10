import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { logger } from '../common/logger.js';

const DPAPI_PREFIX = 'dpapi:';

export function encryptJwt(plaintext: string): string {
  if (platform() !== 'win32') {
    return plaintext;
  }
  const encrypted = winDpapiProtect(plaintext);
  if (encrypted === null) {
    logger.warn('encryptJwt: DPAPI Protect echoue, stockage en clair (fallback)');
    return plaintext;
  }
  return DPAPI_PREFIX + encrypted;
}

export function decryptJwt(stored: string): string {
  if (!stored.startsWith(DPAPI_PREFIX)) {
    return stored;
  }
  const cipher = stored.slice(DPAPI_PREFIX.length);
  const decrypted = winDpapiUnprotect(cipher);
  if (decrypted === null) {
    logger.error('decryptJwt: DPAPI Unprotect echoue, JWT inexploitable');
    return '';
  }
  return decrypted;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(DPAPI_PREFIX);
}

function winDpapiProtect(plaintext: string): string | null {
  const script = `
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [Console]::Out.Write([Convert]::ToBase64String($protected))
  `;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: plaintext, encoding: 'utf8', timeout: 5000 },
  );
  if (res.status !== 0 || typeof res.stdout !== 'string' || res.stdout.length === 0) {
    logger.warn('winDpapiProtect: exit non-zero', {
      status: res.status,
      stderr: res.stderr?.slice(0, 200),
    });
    return null;
  }
  return res.stdout.trim();
}

function winDpapiUnprotect(cipherBase64: string): string | null {
  const script = `
    $cipher = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $cipher, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
  `;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: cipherBase64, encoding: 'utf8', timeout: 5000 },
  );
  if (res.status !== 0 || typeof res.stdout !== 'string') {
    logger.warn('winDpapiUnprotect: exit non-zero', {
      status: res.status,
      stderr: res.stderr?.slice(0, 200),
    });
    return null;
  }
  return res.stdout;
}
