# Politique de sécurité — visioaye-agent

## Signaler une vulnérabilité

Si vous pensez avoir découvert une vulnérabilité de sécurité dans
`visioaye-agent`, merci de **ne pas** ouvrir d'issue publique.

Envoyez un email à **security@visioayi.eu** avec :

- Une description du problème
- Les étapes de reproduction si vous les avez
- La version concernée (`visioaye-agent --version` ou SHA256 du binaire)

Nous accusons réception sous **72 h** et proposons un plan de remédiation
dans un délai de **14 jours**.

## Versions supportées

Seule la dernière version mineure est supportée en termes de patchs de
sécurité. Les versions antérieures reçoivent uniquement des correctifs
critiques pendant 6 mois après leur sortie.

## Portée

Les composants suivants sont dans le périmètre :

- Binaires `visioaye_agent_*` distribués depuis `app.visioayi.eu/releases/`
- Code source dans ce dépôt
- Pipeline de build reproductible

Hors périmètre :

- Infrastructure serveur (`api.visioayi.eu`) — reportez sur
  `security@visioayi.eu` avec mention [BACKEND]
- Clients tiers qui réutilisent notre code

## Garanties de sécurité du produit

### Confinement strict (`assertPathAllowed`)

L'agent n'effectue **aucune** opération filesystem hors des dossiers
explicitement liés par l'utilisateur via l'UI web. Chaque appel `read`,
`write`, `delete`, `readdir` passe par `assertPathAllowed()` qui vérifie
que le chemin est confiné dans un `local_binding` actif. Tout chemin
refusé est journalisé dans `agent_audit_log` avec `result='denied'`.

### Zéro readdir global

Après le scan initial unique d'un dossier lié (à la création du binding),
l'agent **ne refait jamais** de `readdir` sur le disque. Il opère
uniquement via events watcher ciblés et lookups par chemin exact. Aucune
exploration opportuniste.

### Nouveau fichier détecté : opt-in explicite

Si l'agent détecte un fichier **hors manifeste** dans un dossier lié, il
**ne lit pas son contenu**. Il crée une entrée `pending_local_additions`
avec seulement le chemin relatif et la taille (via `stat`), notifie
l'utilisateur, et attend un consentement explicite via l'UI web avant
toute lecture/upload.

### Journal d'audit transparent

Toutes les opérations filesystem sont journalisées localement (SQLite)
puis synchronisées périodiquement avec le serveur. L'utilisateur peut
consulter ce journal dans l'UI web (`/settings/devices` → section
« Journal d'audit »).

### Pas de télémétrie cachée

Aucun ping d'usage, aucune métrique silencieuse, aucune collecte de
données personnelles. Les seuls appels réseau sortants sont :

1. Vers `app.visioayi.eu/releases/latest.json` — pour vérifier les mises
   à jour (toutes les 6 h)
2. Vers l'API définie dans `config.json` — pour le pairing, l'upload et
   le WebSocket de sync

### JWT device-scoped révocable

Chaque agent possède un JWT lié à un `device_id`. L'utilisateur peut
révoquer ce JWT depuis `/settings/devices` d'un clic. Le serveur rejette
alors immédiatement tout appel ultérieur du device.

## Build reproductible

Chaque binaire publié peut être reproduit depuis les sources :

```bash
git checkout agent-v<version>
cd visioaye-agent
pnpm install --frozen-lockfile
pnpm release
```

Le `sha256` du binaire produit doit matcher celui publié dans
`latest.json`. Si ce n'est pas le cas, considérez le binaire téléchargé
comme compromis.
