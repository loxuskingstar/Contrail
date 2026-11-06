#!/bin/bash
# Construit, à partir de dist/Contrail : le paquet .deb (Debian/Ubuntu/Mint) et l'archive .tar.gz avec install.sh
# (toutes distributions) : `bash desktop/linux/build_linux.sh 2.2.0`
set -euo pipefail
VERSION="${1:?version}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; HERE="$ROOT/desktop/linux"; DIST="$ROOT/dist"
ARCH_DEB="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
[ -x "$DIST/Contrail/Contrail" ] || { echo "dist/Contrail introuvable : lancez d'abord pyinstaller"; exit 1; }

# --- .deb : installation par double-clic dans le gestionnaire de logiciels, ou « sudo apt install ./fichier.deb »
PKG="$(mktemp -d)/contrail_${VERSION}_${ARCH_DEB}"
mkdir -p "$PKG/DEBIAN" "$PKG/opt/contrail" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/512x512/apps"
cp -R "$DIST/Contrail/." "$PKG/opt/contrail/"
cp "$ROOT/desktop/assets/icon.png" "$PKG/usr/share/icons/hicolor/512x512/apps/contrail.png"
ln -s /opt/contrail/Contrail "$PKG/usr/bin/contrail"
cat > "$PKG/usr/share/applications/contrail.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Contrail
GenericName=Plane spotting
Comment=Carnet de plane spotting et de vols
Exec=/opt/contrail/Contrail
Icon=contrail
Terminal=false
Categories=Utility;Network;
Actions=Lan;

[Desktop Action Lan]
Name=Contrail (accès depuis le téléphone)
Exec=/opt/contrail/Contrail --lan
DESK
SIZE=$(du -sk "$PKG/opt" | cut -f1)
cat > "$PKG/DEBIAN/control" <<CTL
Package: contrail
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH_DEB
Installed-Size: $SIZE
Maintainer: Contrail <contrail@localhost>
Description: Carnet de plane spotting et de vols personnels
 Application locale (aucun Docker requis) : s'ouvre dans le navigateur,
 données stockées dans ~/.local/share/contrail.
CTL
cat > "$PKG/DEBIAN/postrm" <<'RM'
#!/bin/sh
[ "$1" = "remove" ] || [ "$1" = "purge" ] && command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q 2>/dev/null || true
exit 0
RM
chmod 755 "$PKG/DEBIAN/postrm"
dpkg-deb --root-owner-group --build "$PKG" "$DIST/Contrail-$VERSION-Linux-$ARCH_DEB.deb" >/dev/null
echo "→ $DIST/Contrail-$VERSION-Linux-$ARCH_DEB.deb"

# --- archive universelle avec installeur interactif
TAR="$(mktemp -d)/Contrail-$VERSION-Linux"
mkdir -p "$TAR"
cp -R "$DIST/Contrail" "$TAR/Contrail"
cp "$HERE/install.sh" "$HERE/uninstall.sh" "$TAR/"; chmod +x "$TAR/install.sh" "$TAR/uninstall.sh"
cp "$ROOT/desktop/assets/icon.png" "$TAR/contrail.png"
tar -C "$(dirname "$TAR")" -czf "$DIST/Contrail-$VERSION-Linux-$(uname -m).tar.gz" "$(basename "$TAR")"
echo "→ $DIST/Contrail-$VERSION-Linux-$(uname -m).tar.gz"
