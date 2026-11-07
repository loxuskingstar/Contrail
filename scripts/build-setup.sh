#!/bin/bash
# Construit les installeurs de la plateforme courante a partir du code :
#   Windows (Git Bash) : PyInstaller + Inno Setup -> dist/Contrail-<version>-Windows-Setup.exe
#   Linux              : PyInstaller + .deb / .tar.gz (desktop/linux/build_linux.sh)
#   macOS              : PyInstaller + .dmg (desktop/macos/build_dmg.sh)
# Usage :  bash scripts/build-setup.sh [version] [--skip-pyinstaller] [--clean]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
VERSION=""; SKIP=0; CLEAN=0
for a in "$@"; do case "$a" in --skip-pyinstaller) SKIP=1;; --clean) CLEAN=1;; *) VERSION="$a";; esac; done
[ -n "$VERSION" ] || VERSION="$(sed -n 's/^APP_VERSION *= *"\([^"]*\)".*/\1/p' app/core.py | head -1)"
[ -n "$VERSION" ] || { echo "APP_VERSION introuvable dans app/core.py"; exit 1; }
echo "== Contrail $VERSION =="

PY="$(command -v python3 || command -v python || command -v py || true)"; [ -n "$PY" ] || { echo "Python introuvable"; exit 1; }
[ "$CLEAN" = 1 ] && { echo "-- Nettoyage"; rm -rf build dist; }
if [ "$SKIP" = 0 ]; then
  echo "-- Dependances"; "$PY" -m pip install -q -r requirements.txt pyinstaller pystray
  echo "-- PyInstaller"; "$PY" -m PyInstaller --noconfirm desktop/contrail.spec
fi

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    [ -f dist/Contrail/Contrail.exe ] || { echo "dist/Contrail/Contrail.exe introuvable"; exit 1; }
    ISCC="$(command -v iscc || true)"
    if [ -z "$ISCC" ]; then
      for d in "${LOCALAPPDATA:-}/Programs/Inno Setup 6" "${PROGRAMFILES:-}/Inno Setup 6" "${PROGRAMFILES(X86):-}/Inno Setup 6" "/c/Program Files (x86)/Inno Setup 6"; do
        [ -f "$d/ISCC.exe" ] && { ISCC="$d/ISCC.exe"; break; }
      done
    fi
    [ -n "$ISCC" ] || { echo "ISCC.exe introuvable : winget install JRSoftware.InnoSetup"; exit 1; }
    WROOT="$(cd "$ROOT" && (pwd -W 2>/dev/null || pwd))"
    MSYS2_ARG_CONV_EXCL="*" "$ISCC" "/DAppVersion=$VERSION" "/DSourceDir=$WROOT\\dist\\Contrail" "desktop\\windows\\contrail.iss"
    echo "OK : dist/Contrail-$VERSION-Windows-Setup.exe";;
  Linux)  bash desktop/linux/build_linux.sh "$VERSION"; echo "OK : voir dist/";;
  Darwin) bash desktop/macos/build_dmg.sh "$VERSION"; echo "OK : voir dist/";;
  *) echo "Systeme non gere"; exit 1;;
esac
