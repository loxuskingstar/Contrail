#!/bin/sh
# Prépare le dossier de données puis lance Contrail sans les droits root.
set -e

DATA_DIR="${CONTRAIL_DATA_DIR:-/app/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
    # Aligne l'utilisateur interne sur le propriétaire souhaité côté hôte
    if [ "$(id -g contrail)" != "$PGID" ]; then groupmod -o -g "$PGID" contrail; fi
    if [ "$(id -u contrail)" != "$PUID" ]; then usermod -o -u "$PUID" contrail; fi

    mkdir -p "$DATA_DIR"
    # Ne touche qu'aux éléments qui n'appartiennent pas déjà au bon utilisateur
    # (rapide même avec des milliers de photos lors des redémarrages suivants).
    find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || true

    exec gosu "$PUID:$PGID" "$@"
fi

# Conteneur lancé directement avec un utilisateur imposé (option « user: » de compose)
if [ ! -w "$DATA_DIR" ]; then
    echo "ERREUR : $DATA_DIR n'est pas accessible en écriture pour l'UID $(id -u)." >&2
    echo "Corrigez sur l'hôte avec : sudo chown -R $(id -u):$(id -g) ./data" >&2
    exit 1
fi
exec "$@"
