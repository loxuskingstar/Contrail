#!/bin/sh
# Installeur Contrail pour Linux (toutes distributions) : ./install.sh   — pose quelques questions, aucun droit root requis.
# Options : --prefix DOSSIER  --no-desktop-icon  --yes (accepte les valeurs par défaut, sans question)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/Contrail"
[ -x "$SRC/Contrail" ] || { echo "Dossier « Contrail » introuvable à côté de install.sh."; exit 1; }

PREFIX=""; DESKTOP_ICON=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-desktop-icon) DESKTOP_ICON="n"; shift ;;
    --yes|-y) YES=1; shift ;;
    *) echo "Option inconnue : $1"; exit 2 ;;
  esac
done

if [ "$(id -u)" = "0" ]; then DEFAULT="/opt/contrail"; APPS="/usr/share/applications"; BIN="/usr/local/bin"; ICONS="/usr/share/icons/hicolor/512x512/apps"
else DEFAULT="$HOME/.local/opt/contrail"; APPS="$HOME/.local/share/applications"; BIN="$HOME/.local/bin"; ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"; fi

echo "=== Installation de Contrail ==="
if [ -z "$PREFIX" ]; then
  if [ "$YES" = 1 ]; then PREFIX="$DEFAULT"; else
    printf "Dossier d'installation [%s] : " "$DEFAULT"; read -r PREFIX || true; PREFIX="${PREFIX:-$DEFAULT}"
  fi
fi
if [ -z "$DESKTOP_ICON" ]; then
  if [ "$YES" = 1 ]; then DESKTOP_ICON="o"; else printf "Créer un raccourci sur le Bureau ? [O/n] : "; read -r DESKTOP_ICON || true; fi
fi
case "$PREFIX" in "~"*) PREFIX="$HOME${PREFIX#"~"}" ;; esac

mkdir -p "$PREFIX" "$APPS" "$BIN" "$ICONS"
rm -rf "$PREFIX/app"; mkdir -p "$PREFIX/app"
cp -R "$SRC/." "$PREFIX/app/"
cp "$HERE/contrail.png" "$ICONS/contrail.png"
cp "$HERE/uninstall.sh" "$PREFIX/uninstall.sh"; chmod +x "$PREFIX/uninstall.sh"
ln -sf "$PREFIX/app/Contrail" "$BIN/contrail"

ENTRY="[Desktop Entry]
Type=Application
Name=Contrail
GenericName=Plane spotting
Comment=Carnet de plane spotting et de vols
Exec=\"$PREFIX/app/Contrail\"
Icon=$ICONS/contrail.png
Terminal=false
Categories=Utility;Network;
StartupNotify=false
Actions=Lan;

[Desktop Action Lan]
Name=Contrail (accès depuis le téléphone)
Exec=\"$PREFIX/app/Contrail\" --lan
"
printf "%s" "$ENTRY" > "$APPS/contrail.desktop"; chmod +x "$APPS/contrail.desktop"
case "$DESKTOP_ICON" in
  n|N|non|Non) ;;
  *) D="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
     if [ -d "$D" ]; then printf "%s" "$ENTRY" > "$D/Contrail.desktop"; chmod +x "$D/Contrail.desktop"
       command -v gio >/dev/null 2>&1 && gio set "$D/Contrail.desktop" metadata::trusted true 2>/dev/null || true
       echo "Raccourci créé sur le Bureau."; fi ;;
esac
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
echo "Contrail est installé dans $PREFIX"
echo "Lancez-le depuis le menu des applications (« Contrail »), le raccourci du Bureau, ou la commande : contrail"
echo "Vos données : ${XDG_DATA_HOME:-$HOME/.local/share}/contrail"
