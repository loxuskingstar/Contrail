"""Configuration, chemins et accès base de données.

Toute donnée persistante vit dans un unique dossier DATA_DIR (./data par défaut),
ce qui permet une migration par simple copier-coller du dossier.
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

APP_NAME = "Contrail"
APP_VERSION = "3.0.0"

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("CONTRAIL_DATA_DIR", BASE_DIR / "data")).resolve()

# Configuration (clés API) et secret de session sont communs aux deux profils.
CONFIG_PATH = DATA_DIR / "config.json"
SECRET_PATH = DATA_DIR / "secret.key"

# --------------------------------------------------------------------------- #
# Profils de données : « main » (vos données) et « test » (session de test isolée,
# stockée dans data/sandbox/). Le profil actif est porté par une ContextVar,
# positionnée à chaque requête par le middleware à partir d'un cookie.
# --------------------------------------------------------------------------- #
PROFILES = {"main": DATA_DIR, "test": DATA_DIR / "sandbox"}
_profile: ContextVar[str] = ContextVar("contrail_profile", default="main")


def current_profile() -> str:
    return _profile.get()


def data_root() -> Path:
    return PROFILES[_profile.get()]


@contextmanager
def use_profile(name: str) -> Iterator[None]:
    token = _profile.set(name if name in PROFILES else "main")
    try:
        yield
    finally:
        _profile.reset(token)


def set_profile(name: str):
    return _profile.set(name if name in PROFILES else "main")


def db_path() -> Path:
    return data_root() / "contrail.db"


class _Dirs(Mapping):
    """Sous-dossiers de données du profil actif (images, miniatures, audio…)."""
    NAMES = ("images", "thumbs", "originals", "audio", "exports", "backups", "tmp")

    def __getitem__(self, key: str) -> Path:
        if key not in self.NAMES:
            raise KeyError(key)
        return data_root() / key

    def __iter__(self):
        return iter(self.NAMES)

    def __len__(self) -> int:
        return len(self.NAMES)


DIRS = _Dirs()


def ensure_dirs() -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        data_root().mkdir(parents=True, exist_ok=True)
        for d in DIRS.values():
            d.mkdir(parents=True, exist_ok=True)
    except PermissionError as e:
        if not hasattr(os, "getuid"):       # Windows
            raise SystemExit(f"Contrail ne peut pas écrire dans {DATA_DIR} : choisissez un dossier de données accessible.") from e
        raise SystemExit(
            f"Contrail ne peut pas écrire dans {DATA_DIR} (UID {os.getuid()}). "
            f"Donnez-lui les droits sur le dossier de données, par exemple : "
            f"sudo chown -R {os.getuid()}:{os.getgid()} ./data"
        ) from e


# --------------------------------------------------------------------------- #
# Configuration (clés API, options serveur). Les variables d'environnement
# priment toujours sur config.json ; config.json est modifiable depuis l'UI.
# --------------------------------------------------------------------------- #
ENV_KEYS = {
    "airlabs_api_key": "AIRLABS_API_KEY",
    "aviationstack_api_key": "AVIATIONSTACK_API_KEY",
    "opensky_client_id": "OPENSKY_CLIENT_ID",
    "opensky_client_secret": "OPENSKY_CLIENT_SECRET",
    "ntfy_url": "NTFY_URL",
    "webhook_url": "WEBHOOK_URL",
    "public_base_url": "PUBLIC_BASE_URL",
    # Copie des sauvegardes hors de la machine
    "backup_remote_path": "BACKUP_REMOTE_PATH",
    "backup_webdav_url": "BACKUP_WEBDAV_URL",
    "backup_webdav_user": "BACKUP_WEBDAV_USER",
    "backup_webdav_password": "BACKUP_WEBDAV_PASSWORD",
}

_config_lock = threading.Lock()


def load_config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def save_config(data: dict[str, Any]) -> None:
    with _config_lock:
        current = load_config()
        current.update({k: v for k, v in data.items() if k in ENV_KEYS})
        CONFIG_PATH.write_text(json.dumps(current, indent=2, ensure_ascii=False), "utf-8")


def get_config(key: str, default: str = "") -> str:
    env = ENV_KEYS.get(key)
    if env and os.environ.get(env):
        return os.environ[env]
    return str(load_config().get(key) or default)


def config_source(key: str) -> str:
    env = ENV_KEYS.get(key)
    if env and os.environ.get(env):
        return "env"
    return "file" if load_config().get(key) else "none"


def app_password() -> str:
    return os.environ.get("CONTRAIL_PASSWORD", "")


def secret_key() -> str:
    ensure_dirs()
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(secrets.token_urlsafe(48), "utf-8")
        try:
            os.chmod(SECRET_PATH, 0o600)
        except OSError:
            pass
    return SECRET_PATH.read_text("utf-8").strip()


# --------------------------------------------------------------------------- #
# Base SQLite : une connexion par thread, mode WAL.
# --------------------------------------------------------------------------- #
_local = threading.local()


def _dict_factory(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


# --------------------------------------------------------------------------- #
# Révision des données : un compteur par base, incrémenté à chaque écriture et à chaque COMMIT (toutes connexions).
# Sert à mémoriser les agrégats coûteux (badges, statistiques…) sans jamais servir une valeur périmée.
# --------------------------------------------------------------------------- #
_REV: dict[str, int] = {}
_REV_LOCK = threading.Lock()
_WRITE_PREFIX = ("INSERT", "UPDATE", "DELETE", "REPLACE", "COMMIT", "ALTER", "DROP", "CREATE")


def _bump(path: str, sql: str) -> None:
    if sql[:7].lstrip().upper().startswith(_WRITE_PREFIX):
        with _REV_LOCK:
            _REV[path] = _REV.get(path, 0) + 1


def data_rev() -> tuple[str, int]:
    p = str(db_path())
    return p, _REV.get(p, 0)


_MEMO: dict[tuple, tuple[int, Any]] = {}


def memo(name: str, compute, *args):
    """Valeur mémorisée tant que la base du profil actif n'a pas changé."""
    path, rev = data_rev()
    key = (name, path, args)
    hit = _MEMO.get(key)
    if hit and hit[0] == rev:
        return hit[1]
    value = compute(*args)
    if len(_MEMO) > 150:
        _MEMO.clear()
    _MEMO[key] = (rev, value)   # `rev` lue AVANT le calcul : une écriture concurrente invalide aussitôt
    return value


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    _p = str(path)
    conn.set_trace_callback(lambda sql: _bump(_p, sql))
    conn.row_factory = _dict_factory
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    from app.services import operators
    operators.register(conn)
    from app.services import registration as _regs
    conn.create_function("known", 1, _regs.known, deterministic=True)
    from app.services import actypes as _act
    conn.create_function("mk", 2, _act.model_key, deterministic=True)     # modèle compté (vols : sans marque militaire)
    conn.create_function("mk", 3, _act.model_key, deterministic=True)     # spots : MRTT, avions de ligne militaires… = modèles à part
    return conn


def db() -> sqlite3.Connection:
    """Connexion du thread courant vers la base du profil actif."""
    conns: dict = getattr(_local, "conns", None) or {}
    _local.conns = conns
    if getattr(_local, "gen", -1) != _db_generation[0]:
        for c in conns.values():
            try:
                c.close()
            except sqlite3.Error:
                pass
        conns.clear()
        _local.gen = _db_generation[0]
    path = str(db_path())
    conn = conns.get(path)
    if conn is None:
        conn = connect(Path(path))
        conns[path] = conn
    return conn


# Incrémenté après une restauration pour forcer la réouverture des connexions.
_db_generation = [0]


def reset_connections() -> None:
    _db_generation[0] += 1


def q(sql: str, params: tuple | list | dict = ()) -> list[dict]:
    return db().execute(sql, params).fetchall()


def q1(sql: str, params: tuple | list | dict = ()) -> dict | None:
    return db().execute(sql, params).fetchone()


def execute(sql: str, params: tuple | list | dict = ()) -> sqlite3.Cursor:
    conn = db()
    cur = conn.execute(sql, params)
    conn.commit()
    return cur


# --------------------------------------------------------------------------- #
# Préférences utilisateur (table user_settings, valeurs JSON)
# --------------------------------------------------------------------------- #
DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "auto",               # auto | light | dark
    "accent": "#3b82f6",
    "language": "fr",
    "units": "metric",             # metric | imperial (distances vols)
    "home_airports": [],           # ex. ["LFBO"]
    "default_airport": "",
    "patrol_mode": "simple",       # simple : une patrouille = un spot (nommé) | detailed : un spot par avion
    "dashboard_widgets": [
        "hero", "quick", "goals", "recent", "on_this_day", "top_types",
        "achievements", "month_chart", "watchlist",
    ],
    "modules": {
        "flights": True, "fleets": True, "radar": True, "weather": True,
        "ocr": True, "locations": True, "gamification": True, "watchlist": True,
    },
    "trash_days": 30,              # durée de conservation des éléments supprimés (0 = suppression immédiate)
    "fleet_overrides": {},         # effectifs mondiaux corrigés à la main par code type (rareté), ex. {"A337": 6}
    "photographer": "",            # nom écrit dans les métadonnées IPTC/XMP des photos exportées
    "copyright": "",
    "keep_originals": False,
    "image_max_px": 2560,
    "image_quality": 85,
    "backup_interval_hours": 24,   # 0 = désactivé
    "backup_keep": 7,
    "backup_include_media": False,
    "watch_interval_min": 5,
    "goal_spots": 0,               # objectifs de l'année (0 = aucun)
    "goal_types": 0,
    "goal_regs": 0,
    "share_include_notes": False,
    "radar_center": None,          # [lat, lng] ou None -> géolocalisation
    "map_tiles": "auto",           # auto | positron | liberty | bright | dark | fiord (OpenFreeMap) | osm | custom
    "map_tiles_url": "",
    "map_tiles_attribution": "",
}


def get_settings() -> dict[str, Any]:
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    for row in q("SELECT key, value FROM user_settings"):
        try:
            val = json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(out.get(row["key"]), dict) and isinstance(val, dict):
            out[row["key"]].update(val)
        else:
            out[row["key"]] = val
    return out


def get_setting(key: str) -> Any:
    return get_settings().get(key, DEFAULT_SETTINGS.get(key))


def set_settings(values: dict[str, Any]) -> dict[str, Any]:
    conn = db()
    for k, v in values.items():
        if k not in DEFAULT_SETTINGS:
            continue
        conn.execute(
            "INSERT INTO user_settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, json.dumps(v, ensure_ascii=False)),
        )
    conn.commit()
    return get_settings()


# --------------------------------------------------------------------------- #
# Utilitaires
# --------------------------------------------------------------------------- #
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_media_path(kind: str, rel: str) -> Path | None:
    """Résout un chemin média en garantissant qu'il reste dans <profil>/kind."""
    base = DIRS.get(kind) if kind in _Dirs.NAMES else None
    if base is None or not rel:
        return None
    p = (base / rel).resolve()
    try:
        p.relative_to(base.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None
