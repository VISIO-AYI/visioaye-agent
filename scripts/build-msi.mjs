#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INSTALLER = join(ROOT, 'installer');
const BUILDS = join(ROOT, 'builds');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const WIX_CANDIDATES = [
  'wix',
  join(process.env.USERPROFILE ?? '', '.dotnet', 'tools', 'wix.exe'),
  join(process.env.HOME ?? '', '.dotnet', 'tools', 'wix.exe'),
];

function findWix() {
  for (const cand of WIX_CANDIDATES) {
    if (!cand) continue;
    const res = spawnSync(cand, ['--version'], { shell: process.platform === 'win32' });
    if (res.status === 0) return cand;
  }
  throw new Error(
    'wix (dotnet tool) introuvable. Installe-le : dotnet tool install --global wix',
  );
}

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    throw new Error(`${cmd} a echoue (code ${res.status})`);
  }
}

function main() {
  const wix = findWix();
  console.log(`wix : ${wix}`);

  const exePath = join(BUILDS, 'visioaye_agent_win_x64.exe');
  if (!existsSync(exePath)) {
    throw new Error(`Binaire absent : ${exePath}. Lance d'abord : pnpm package:win`);
  }

  const output = join(BUILDS, `visioaye_agent_win_x64_${VERSION}.msi`);
  run(
    wix,
    [
      'build',
      '-arch', 'x64',
      '-ext', 'WixToolset.Util.wixext',
      '-d', `AgentVersion=${VERSION}`,
      '-b', ROOT,
      '-o', output,
      join(INSTALLER, 'Package.wxs'),
    ],
    ROOT,
  );

  console.log(`\nMSI genere : ${output}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
