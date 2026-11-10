import { createPublicKey, verify } from 'node:crypto';
import { logger } from '../common/logger.js';
import { UPDATE_TRUSTED_PUBLIC_KEY_PEM } from './trusted-public-key.js';

export type UpdateManifest = {
  version: string;
  releasedAt: string;
  binaries: Array<{
    filename: string;
    os: string;
    arch: string;
    installer: boolean;
    sha256: string;
    downloadUrl: string;
  }>;
};

export class ManifestVerificationError extends Error {
  constructor(public readonly reason: string) {
    super(`Manifest update refuse : ${reason}`);
    this.name = 'ManifestVerificationError';
  }
}

export function verifyManifestSignature(manifestJson: string, signatureBase64: string): void {
  const publicKey = createPublicKey(UPDATE_TRUSTED_PUBLIC_KEY_PEM);
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signatureBase64.trim(), 'base64');
  } catch {
    throw new ManifestVerificationError('signature base64 invalide');
  }
  if (signatureBytes.length === 0) {
    throw new ManifestVerificationError('signature vide');
  }
  const ok = verify(null, Buffer.from(manifestJson, 'utf8'), publicKey, signatureBytes);
  if (!ok) {
    logger.error('Manifest update : signature Ed25519 INVALIDE - update refuse (attaque possible)');
    throw new ManifestVerificationError('signature Ed25519 invalide');
  }
}

export function parseManifest(manifestJson: string): UpdateManifest {
  const parsed = JSON.parse(manifestJson) as UpdateManifest;
  if (!parsed || typeof parsed.version !== 'string' || !Array.isArray(parsed.binaries)) {
    throw new ManifestVerificationError('structure manifest invalide');
  }
  return parsed;
}
