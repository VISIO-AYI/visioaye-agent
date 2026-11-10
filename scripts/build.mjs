#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const BUILDS = join(ROOT, 'builds');

const DEFAULT_TARGETS = ['node22-win-x64', 'node22-linux-x64'];

const TARGET_TO_SUFFIX = {
  'node22-win-x64': 'win_x64.exe',
  'node22-macos-x64': 'macos_x64',
  'node22-macos-arm64': 'macos_arm64',
  'node22-linux-x64': 'linux_x64',
};

function parseArgs() {
  const args = process.argv.slice(2);
  let target = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      target = args[i + 1];
      i++;
    }
  }
  return { target };
}

function run(cmd, args, cwd = ROOT) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    throw new Error(`${cmd} a echoue (code ${res.status})`);
  }
}

function main() {
  const { target } = parseArgs();
  const targets = target ? [target] : DEFAULT_TARGETS;

  if (!existsSync(DIST)) {
    console.log('dist/ absent, build TS...');
    run('pnpm', ['build']);
  }
  mkdirSync(BUILDS, { recursive: true });

  const entry = join(DIST, 'main.js');
  if (!existsSync(entry)) {
    throw new Error(`Entry manquante : ${entry}`);
  }

  for (const t of targets) {
    const suffix = TARGET_TO_SUFFIX[t];
    if (!suffix) throw new Error(`Cible inconnue : ${t}`);
    const out = join(BUILDS, `visioaye_agent_${suffix}`);
    run('pnpm', ['exec', 'pkg', entry, '--targets', t, '--output', out, '--compress', 'GZip']);
  }

  console.log(`\nBinaires produits dans ${BUILDS}/`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
