# visioaye-agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent desktop VisioAye — service système invisible, piloté 100 % par le site web via `127.0.0.1:19876`.

Composant **open-source** du projet VisioAye. Seul le code de l'agent est publié sous licence MIT ; le back et le front restent sous licence propriétaire. Ce découpage permet notamment d'obtenir un certificat de code signing gratuit via [SignPath Foundation](https://signpath.org/foundation).

## Rôle

- Expose un serveur HTTP local (Fastify) consommé par `app.visioayi.eu` pour piloter le pairing, les bindings et le statut.
- Ouvre un WebSocket sortant vers `api.visioayi.eu` pour recevoir les events de sync.
- Persiste son état (JWT device, bindings, journal d'audit) dans un SQLite local (`agent.sqlite` sous `%ProgramData%\VisioAye\` / `~/Library/Application Support/VisioAye/` / `/var/lib/visioaye/`).
- Auto-update via check de `app.visioayi.eu/releases/latest.json` (étape 3.7, non implémenté en v3 initial).

Spec complète : `docs/features/file-sync-agent/feature.md`. Décisions actées : `docs/features/file-sync-agent/plan-implementation.md` §Points tranchés.

## Prérequis

- **Node 22+** (le `engines` du `package.json` est `>=22.0.0`). Node 24 fonctionne mais `better-sqlite3` peut ne pas avoir de binaire précompilé et nécessiter une build locale.
- **Windows** : [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) avec « C++ build tools » + Windows SDK, OU `npm install --global windows-build-tools` (déprécié mais fonctionne encore), OU installer avec `node 22.x` qui a un prebuilt pour `better-sqlite3`.
- **macOS** : Xcode Command Line Tools (`xcode-select --install`).
- **Linux** : `build-essential` + `python3`.

En CI / release, le binaire est packagé avec `@yao-pkg/pkg` et embarque son propre Node — pas de prérequis pour l'utilisateur final.

## Structure

```
visioaye-agent/
├── src/
│   ├── main.ts                 — bootstrap (HTTP local + WS + updater)
│   ├── common/
│   │   ├── config.ts           — constantes (ports, URLs)
│   │   ├── logger.ts           — logger JSON structuré
│   │   ├── paths.ts            — paths OS-aware (data, logs, sqlite)
│   │   └── audit-log.ts        — journal des opérations FS (SQLite local)
│   ├── db/
│   │   └── sqlite.ts           — init SQLite + schéma
│   ├── http/
│   │   └── server.ts           — Fastify sur 127.0.0.1:19876
│   ├── pairing/
│   │   └── pairing.service.ts  — flow /pair → POST /devices/complete-pairing
│   ├── sync/
│   │   ├── ws-client.ts        — WS vers api.visioayi.eu (reconnect exp)
│   │   └── downloader.ts       — stub étape 3.5
│   └── updater/
│       └── updater.ts          — stub étape 3.7
└── (après `pnpm install`) node_modules/, dist/, agent.sqlite
```

## Scripts

```bash
pnpm install            # installe les deps (requiert build tools, cf. ci-dessus)
pnpm dev                # tsc --watch, reload manuel du process
pnpm build              # compile en dist/
pnpm start              # lance dist/main.js
pnpm lint               # oxlint type-aware
pnpm test               # vitest
pnpm package            # bundle via pkg (4 cibles)
pnpm package:win        # bundle Windows x64 uniquement
pnpm package:mac        # bundle macOS x64
pnpm package:mac-arm    # bundle macOS arm64
pnpm package:linux      # bundle Linux x64
```

Depuis la racine du monorepo :

```bash
make agent              # pnpm dev dans visioaye-agent/
make build-agent        # pnpm build dans visioaye-agent/
```

## Release / Publication des binaires

**Entièrement self-host** — pas de CI externe (GitHub Actions / GitLab CI). Build local depuis ton PC, puis `scp` vers le serveur prod. Zéro dépendance externe.

**Plateformes supportées actuellement** : Windows x64. macOS et Linux viendront quand on aura accès aux machines correspondantes (compiler un binaire macOS nécessite un Mac, c'est une contrainte Apple).

### Procédure complète

```bash
cd visioaye-agent/

# 1. Build : compile en TS, puis bundle via @yao-pkg/pkg en binaire natif
pnpm release              # = pnpm package + generate-latest-json.mjs
                          # produit builds/visioaye_agent_win_x64.exe + builds/latest.json

# 2. Deploy : scp vers /srv/visioaye/public/releases/<version>/ + copie latest.json a la racine
pnpm deploy               # necessite acces SSH au serveur (cle configuree)
```

**Variables d'env pour `pnpm deploy`** (optionnelles, defaults prod) :

| Var | Default | Rôle |
|---|---|---|
| `VISIOAYE_DEPLOY_USER` | `visioaye` | user SSH |
| `VISIOAYE_DEPLOY_HOST` | `app.visioayi.eu` | host SSH |
| `VISIOAYE_DEPLOY_ROOT` | `/srv/visioaye/public/releases` | chemin remote |

### Pourquoi self-host et pas CI cloud

CLAUDE.md racine, règle "100 % self-hosted" : les binaires desktop doivent être servis depuis `app.visioayi.eu`, jamais depuis GitHub Releases. En pratique, la CI cloud (GitHub Actions) pourrait quand même **builder** sans violer la règle (les artefacts seraient copiés ensuite vers le serveur), mais on préfère rester 100 % interne : zéro secret chez un tiers, zéro dépendance.

**Conséquences** :
- Windows x64 → build depuis n'importe quel PC Windows
- macOS → **nécessite un Mac** (les 4 OS supportés par `pkg` ne permettent pas de cross-compiler vers macOS depuis Windows/Linux — l'Apple SDK n'est redistribuable que sur un Mac)
- Linux → cross-compile depuis Windows/Mac fonctionne en général mais nécessite tests

### Scripts

| Script | Rôle |
|---|---|
| `pnpm package` | Bundle TS → binaire natif pour les cibles de `package.json` section `pkg.targets` |
| `pnpm package:win` | Windows x64 uniquement |
| `pnpm package:mac` | macOS Intel (nécessite d'être sur un Mac) |
| `pnpm package:mac-arm` | macOS Apple Silicon (nécessite d'être sur un Mac arm64) |
| `node scripts/generate-latest-json.mjs` | Produit `builds/latest.json` (sha256 + URLs) |
| `pnpm release` | Enchaîne `package` + `generate-latest-json` |
| `pnpm deploy` | `scp` les binaires + `latest.json` vers le serveur |

## Config runtime

- `VISIOAYE_SERVER_URL` — URL du back (défaut `https://api.visioayi.eu`). À pointer sur `http://localhost:3001` en dev local.
- `VISIOAYE_LOCAL_HTTP_HOST` — Host d'écoute du serveur local Fastify (défaut `127.0.0.1`). Doit matcher `NEXT_PUBLIC_AGENT_LOCAL_URL` côté front.
- `VISIOAYE_LOCAL_HTTP_PORT` — Port d'écoute du serveur local Fastify (défaut `19876`).
- `VISIOAYE_CORS_ORIGINS` — Origines autorisées séparées par virgule (défaut `https://app.visioayi.eu,http://localhost:3000`).

## Prochaines étapes

Suivre `docs/features/file-sync-agent/plan-implementation.md` phase 3.

- [x] 3.3 — scaffolding (ce livrable)
- [ ] 3.4 — flow pairing côté agent (appel `/devices/complete-pairing` + stockage JWT) → stub déjà en place dans `pairing.service.ts`
- [ ] 3.5 — scan initial + downloader (`assertPathAllowed` partout)
- [ ] 3.6 — WS client + events (`file.updated`, `file.deleted`, `sync_setting.changed`)
- [ ] 3.7 — auto-updater (check `latest.json`, remplacement binaire)

## Licence

[MIT](LICENSE). Vous pouvez auditer, modifier, redistribuer. Les contributions externes sont bienvenues via pull-request.

## Sécurité

Consultez [SECURITY.md](SECURITY.md) pour la politique de signalement de vulnérabilités et les garanties intégrées au produit (confinement strict `assertPathAllowed`, zéro readdir global, opt-in avant lecture d'un fichier hors manifeste, journal d'audit transparent, JWT device-scoped révocable).

## Signature des releases

Deux couches de signature complémentaires :

1. **Signature cryptographique du manifeste `latest.json` (Ed25519)** — bloque les attaques DNS/MITM/serveur compromis qui serviraient un faux manifeste.
2. **Signature Authenticode des binaires** via SignPath Foundation — accepte par Smart App Control.

### Générer la keypair Ed25519 (une fois)

```bash
cd visioaye-agent
node scripts/generate-signing-keypair.mjs
```

Sortie : `secrets/update-signing.key` (privée, gitignored) + `src/updater/trusted-public-key.ts` (publique, à commiter).

Stocker le contenu de `secrets/update-signing.key` dans le secret CI `VISIOAYE_UPDATE_SIGNING_KEY`. Le script `scripts/generate-latest-json.mjs` utilise cette clé (env var OU fichier local) pour produire `latest.json.sig` à chaque release. L'agent vérifie `latest.json.sig` contre la clé publique embarquée avant tout check de version.

### Secrets GHA requis (workflow `.github/workflows/release-agent.yml`)

- `VISIOAYE_UPDATE_SIGNING_KEY` — contenu PEM de la clé privée Ed25519
- `SIGNPATH_API_TOKEN` — token API SignPath (après enrôlement validé)
- `SIGNPATH_ORG_ID` — UUID organisation SignPath

### Signature Authenticode (SignPath)

Les binaires `.exe` et `.msi` distribués depuis `app.visioayi.eu/releases/` sont [signés via SignPath Foundation](../docs/features/file-sync-agent/signpath-application.md) (certificat open-source gratuit). Pour vérifier sous PowerShell :

```powershell
Get-AuthenticodeSignature "C:\Program Files\VisioAye\visioaye_agent.exe"
```

Le champ `Status` doit être `Valid`. Si ce n'est pas le cas, considérez le binaire comme non authentique.

Vous pouvez également vérifier le `sha256` d'un binaire téléchargé contre celui publié dans `latest.json` :

```powershell
Get-FileHash .\visioaye_agent_win_x64_0.1.0.msi -Algorithm SHA256
```

## Reproductibilité du build

```bash
git clone <repo>
cd visioaye-agent
pnpm install --frozen-lockfile
pnpm release
```

Le `sha256` du MSI produit doit matcher celui de `latest.json` publié par VisioAye (modulo la signature SignPath ajoutée post-build — pour comparer le contenu non signé, utiliser `signtool remove /s` ou build en désactivant la signature).
