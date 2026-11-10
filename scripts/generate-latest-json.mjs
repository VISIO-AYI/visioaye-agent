#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BUILDS = join(ROOT, 'builds');
const SECRETS_DIR = join(ROOT, 'secrets');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const BASE_URL = process.env.VISIOAYE_RELEASES_BASE_URL ?? '/releases';
const SIGNING_KEY_PEM_FROM_ENV = process.env.VISIOAYE_UPDATE_SIGNING_KEY;
const SIGNING_KEY_FILE = join(SECRETS_DIR, 'update-signing.key');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function classify(filename) {
  if (filename.endsWith('.msi')) return { os: 'windows', arch: 'x64', installer: true };
  if (filename.endsWith('.exe')) return { os: 'windows', arch: 'x64', installer: false };
  if (filename.includes('macos_arm64') || filename.includes('macos_arm')) {
    return { os: 'macos', arch: 'arm64', installer: false };
  }
  if (filename.includes('macos')) return { os: 'macos', arch: 'x64', installer: false };
  if (filename.includes('linux')) return { os: 'linux', arch: 'x64', installer: false };
  return null;
}

function main() {
  if (!existsSync(BUILDS)) {
    console.error(`Dossier ${BUILDS} absent, lance d'abord pnpm package.`);
    process.exit(1);
  }
  const entries = readdirSync(BUILDS)
    .filter((f) => /^visioaye_agent/.test(f) && !f.endsWith('.json'))
    .map((f) => {
      const full = join(BUILDS, f);
      const meta = classify(f);
      if (!meta) return null;
      return {
        filename: f,
        os: meta.os,
        arch: meta.arch,
        installer: meta.installer,
        sha256: sha256(full),
        downloadUrl: `${BASE_URL}/${VERSION}/${f}`,
      };
    })
    .filter(Boolean);
  entries.sort((a, b) => {
    if (a.os !== b.os) return a.os.localeCompare(b.os);
    return Number(b.installer) - Number(a.installer);
  });

  const manifest = {
    version: VERSION,
    releasedAt: new Date().toISOString(),
    binaries: entries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(BUILDS, 'latest.json'), manifestJson);
  console.log(`latest.json genere pour v${VERSION} avec ${entries.length} binaires.`);

  const privateKeyPem = resolveSigningKey();
  if (!privateKeyPem) {
    console.warn('AVERTISSEMENT : aucune cle privee trouvee (VISIOAYE_UPDATE_SIGNING_KEY ou secrets/update-signing.key).');
    console.warn('latest.json.sig NON genere - l\'agent refusera cet update si verif activee.');
    return;
  }
  const privateKey = createPrivateKey(privateKeyPem);
  const signatureBytes = sign(null, Buffer.from(manifestJson, 'utf8'), privateKey);
  const signatureB64 = signatureBytes.toString('base64');
  writeFileSync(join(BUILDS, 'latest.json.sig'), signatureB64);
  console.log(`latest.json.sig genere (Ed25519, ${signatureBytes.length} bytes).`);
}

function resolveSigningKey() {
  if (SIGNING_KEY_PEM_FROM_ENV && SIGNING_KEY_PEM_FROM_ENV.includes('BEGIN')) {
    return SIGNING_KEY_PEM_FROM_ENV;
  }
  if (existsSync(SIGNING_KEY_FILE)) {
    return readFileSync(SIGNING_KEY_FILE, 'utf8');
  }
  return null;
}

main();
