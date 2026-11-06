#!/bin/bash
# Construit le .dmg macOS à partir de dist/Contrail.app : `bash desktop/macos/build_dmg.sh 2.2.0`
set -euo pipefail
VERSION="${1:?version}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/dist/Contrail.app"
OUT="$ROOT/dist/Contrail-$VERSION-macOS-$(uname -m).dmg"
STAGE="$(mktemp -d)"
[ -d "$APP" ] || { echo "Contrail.app introuvable : lancez d'abord pyinstaller"; exit 1; }

# Signature « ad hoc » : sans compte développeur, évite le message « l'app est endommagée » sur les Mac Apple Silicon
codesign --force --deep --sign - "$APP" || echo "codesign indisponible, on continue"

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"       # le geste habituel : glisser Contrail sur Applications
cat > "$STAGE/Lisez-moi - premier lancement.txt" <<'TXT'
INSTALLATION
1. Glissez « Contrail » sur le dossier « Applications ».
2. Au premier lancement, macOS peut afficher « développeur non identifié » :
   faites clic droit (ou Ctrl + clic) sur Contrail dans Applications, puis « Ouvrir », puis « Ouvrir » à nouveau.
   Ce n'est à faire qu'une seule fois.
   (Sinon : Réglages Système > Confidentialité et sécurité > « Ouvrir quand même ».)
3. Contrail s'ouvre dans votre navigateur. Son icône reste dans la barre de menus : clic pour rouvrir ou quitter.

VOS DONNÉES : ~/Library/Application Support/Contrail (conservées si vous supprimez l'application).
TXT
hdiutil create -volname "Contrail $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "→ $OUT"
