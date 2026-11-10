const HARDCODED_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',

  '**/.env',
  '**/.env.*',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/.kube/**',
  '**/.docker/**',
  '**/.npmrc',
  '**/.yarnrc',
  '**/.pypirc',
  '**/.netrc',
  '**/secrets/**',

  '**/*.pem',
  '**/*.key',
  '**/*.pfx',
  '**/*.p12',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa',
  '**/id_rsa.pub',
  '**/id_ed25519',
  '**/id_ed25519.pub',
  '**/id_ecdsa',
  '**/id_ecdsa.pub',
  '**/known_hosts',
  '**/authorized_keys',

  '**/~$*',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/*.tmp',
  '**/*.temp',
  '**/*.swp',
  '**/*.swo',
  '**/*.part',
  '**/*.crdownload',
  '**/.visioaye-tmp/**',
] as const;

let workspaceOverrides: string[] = [];

export function setWorkspaceIgnoredPatterns(patterns: string[]): void {
  workspaceOverrides = patterns.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 256);
}

export function getIgnoredPatterns(): string[] {
  return [...HARDCODED_IGNORED, ...workspaceOverrides];
}
