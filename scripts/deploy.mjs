#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BUILDS = join(ROOT, 'builds');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const SERVER_USER = process.env.VISIOAYE_DEPLOY_USER ?? 'visioaye';
const SERVER_HOST = process.env.VISIOAYE_DEPLOY_HOST ?? 'app.visioayi.eu';
const SERVER_ROOT = process.env.VISIOAYE_DEPLOY_ROOT ?? '/srv/visioaye/public/releases';

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    throw new Error(`${cmd} a echoue (code ${res.status})`);
  }
}

function main() {
  if (!existsSync(BUILDS)) {
    console.error(`Dossier ${BUILDS} absent. Lance d'abord : pnpm release`);
    process.exit(1);
  }
  const files = readdirSync(BUILDS);
  if (files.length === 0) {
    console.error(`Dossier ${BUILDS} vide. Lance d'abord : pnpm release`);
    process.exit(1);
  }

  const remoteVersionDir = `${SERVER_ROOT}/${VERSION}`;
  const target = `${SERVER_USER}@${SERVER_HOST}`;

  console.log(`\nDeploiement v${VERSION} vers ${target}:${remoteVersionDir}`);

  run('ssh', [target, `mkdir -p ${remoteVersionDir}`]);
  run('scp', [`-r`, `${BUILDS}/.`, `${target}:${remoteVersionDir}/`]);
  run('ssh', [target, `cp ${remoteVersionDir}/latest.json ${SERVER_ROOT}/latest.json`]);

  console.log(`\nOK. Binaires disponibles sur https://${SERVER_HOST}/releases/${VERSION}/`);
  console.log(`Manifest : https://${SERVER_HOST}/releases/latest.json`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
