#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BUILDS = join(ROOT, 'builds');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const FRONT_RELEASES =
  process.env.VISIOAYE_FRONT_RELEASES_DIR ??
  resolve(ROOT, '..', 'visioaye-front', 'public', 'releases');

function main() {
  if (!existsSync(BUILDS)) {
    console.error(`Dossier ${BUILDS} absent. Lance d'abord : pnpm release`);
    process.exit(1);
  }
  const latest = join(BUILDS, 'latest.json');
  if (!existsSync(latest)) {
    console.error(`latest.json absent dans ${BUILDS}. Lance d'abord : pnpm release`);
    process.exit(1);
  }

  const versionDir = join(FRONT_RELEASES, VERSION);
  mkdirSync(versionDir, { recursive: true });

  const files = readdirSync(BUILDS).filter((f) => !f.endsWith('.json'));
  for (const f of files) {
    copyFileSync(join(BUILDS, f), join(versionDir, f));
  }
  copyFileSync(latest, join(versionDir, 'latest.json'));
  copyFileSync(latest, join(FRONT_RELEASES, 'latest.json'));

  const olds = readdirSync(FRONT_RELEASES).filter(
    (name) => name !== VERSION && name !== 'latest.json' && /^\d+\.\d+\.\d+/.test(name),
  );
  for (const old of olds) {
    rmSync(join(FRONT_RELEASES, old), { recursive: true, force: true });
    console.log(`Supprime ancien dossier ${old}`);
  }

  console.log(`\nDeploye v${VERSION} dans ${FRONT_RELEASES}`);
  console.log(`Teste : ouvre http://localhost:3000 et recharge le site`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
