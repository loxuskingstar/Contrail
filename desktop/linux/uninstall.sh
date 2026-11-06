#!/bin/sh
# Désinstalle Contrail (les données sont conservées sauf réponse contraire).
PREFIX="$(cd "$(dirname "$0")" && pwd)"
"$PREFIX/app/Contrail" --stop --no-browser 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then APPS="/usr/share/applications"; BIN="/usr/local/bin"; ICONS="/usr/share/icons/hicolor/512x512/apps"
else APPS="$HOME/.local/share/applications"; BIN="$HOME/.local/bin"; ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"; fi
D="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$APPS/contrail.desktop" "$D/Contrail.desktop" "$BIN/contrail" "$ICONS/contrail.png"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/contrail"
if [ -d "$DATA" ]; then
  printf "Supprimer aussi vos données (spots, photos, sauvegardes) dans %s ? [o/N] : " "$DATA"; read -r R || true
  case "$R" in o|O|oui|Oui) rm -rf "$DATA" ;; esac
fi
rm -rf "$PREFIX"
echo "Contrail est désinstallé."
