#!/usr/bin/env bash
# Déploie l'appli (dossier app/) sur Vercel avec les clés rangées au trousseau macOS.
#
#   scripts/deploy-vercel.sh          # déploiement de prévisualisation
#   scripts/deploy-vercel.sh --prod   # déploiement en production
#
# Les noms des clés sont déclarés dans secrets.yaml. Les valeurs restent au trousseau :
# `ezk-secret get` les lit (Touch ID) dans des variables, jamais affichées.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v ezk-secret >/dev/null || { echo "ezk-secret introuvable (voir la recette secrets-trousseau)." >&2; exit 1; }
command -v vercel >/dev/null || { echo "CLI vercel introuvable : pnpm add -g vercel" >&2; exit 1; }

# Lit une clé au trousseau seulement si elle y est rangée (list ne révèle que les noms).
lire_si_present() {
  if ezk-secret list "$1" 2>/dev/null | grep -qx "$1"; then
    ezk-secret get "$1"
  fi
}

VERCEL_TOKEN="$(ezk-secret get VERCEL_TOKEN)"
export VERCEL_TOKEN
[ -n "$VERCEL_TOKEN" ] || { echo "Jeton Vercel vide au trousseau (VERCEL_TOKEN)." >&2; exit 1; }

ORG_ID="$(lire_si_present inpactz-vercel-org-id)"
PROJECT_ID="$(lire_si_present inpactz-vercel-project-id)"
if [ -n "$ORG_ID" ] && [ -n "$PROJECT_ID" ]; then
  export VERCEL_ORG_ID="$ORG_ID" VERCEL_PROJECT_ID="$PROJECT_ID"
fi

# Le Dockerfile à la racine (service Render) ferait détecter un « container » à Vercel.
# On déploie donc un dossier qui ne contient que vercel.json et app/.
racine="$(pwd)"
etape="$(mktemp -d)/inpactz"
mkdir -p "$etape"
trap 'rm -rf "$(dirname "$etape")"' EXIT
cp vercel.json "$etape/"
cp -R app "$etape/app"
if [ -d .vercel ]; then cp -R .vercel "$etape/.vercel"; fi

(cd "$etape" && vercel deploy --yes "$@")

# Garde le lien vers le projet Vercel (gitignoré) pour les prochains déploiements.
if [ -d "$etape/.vercel" ]; then rm -rf "$racine/.vercel"; cp -R "$etape/.vercel" "$racine/.vercel"; fi
