#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SECRETS_DIR = join(ROOT, 'secrets');
const PRIVATE_KEY_PATH = join(SECRETS_DIR, 'update-signing.key');
const PUBLIC_KEY_PATH = join(ROOT, 'src', 'updater', 'trusted-public-key.ts');

if (existsSync(PRIVATE_KEY_PATH) && !process.argv.includes('--force')) {
  console.error(`Keypair deja presente : ${PRIVATE_KEY_PATH}`);
  console.error('Relance avec --force pour ecraser (ATTENTION : ancienne cle publique a retirer).');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

mkdirSync(SECRETS_DIR, { recursive: true });
writeFileSync(PRIVATE_KEY_PATH, privPem, { mode: 0o600 });

const generatedAt = new Date().toISOString();
const tsFile = `export const UPDATE_TRUSTED_PUBLIC_KEY_PEM = \`${pubPem.trimEnd()}
\`;

export const UPDATE_TRUSTED_PUBLIC_KEY_GENERATED_AT = '${generatedAt}';
`;

mkdirSync(join(ROOT, 'src', 'updater'), { recursive: true });
writeFileSync(PUBLIC_KEY_PATH, tsFile);

console.log(`Keypair Ed25519 generee.`);
console.log(`  Privee  : ${PRIVATE_KEY_PATH}  (NE PAS commiter - ajoute a .gitignore)`);
console.log(`  Publique: ${PUBLIC_KEY_PATH}  (A commiter avec l'agent)`);
console.log('\nActions a faire :');
console.log('  1. Verifier que visioaye-agent/secrets/*.key est gitignore');
console.log('  2. Stocker le contenu de update-signing.key dans le secret CI VISIOAYE_UPDATE_SIGNING_KEY');
console.log('  3. Commiter trusted-public-key.ts');
