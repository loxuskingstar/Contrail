"""Sauvegardes .zip (BDD + configuration, médias en option) et restauration."""
from __future__ import annotations

import json
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

from ..core import (APP_VERSION, CONFIG_PATH, DIRS, connect, db_path, get_settings, reset_connections)

PREFIX = "contrail-backup-"


def _snapshot_db(dest: Path) -> None:
    src = connect()
    try:
        out = sqlite3.connect(str(dest))
        with out:
            src.backup(out)
        out.close()
    finally:
        src.close()


def create_backup(include_media: bool | None = None, label: str = "auto") -> dict:
    settings = get_settings()
    if include_media is None:
        include_media = bool(settings.get("backup_include_media"))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"{PREFIX}{stamp}{'-full' if include_media else ''}.zip"
    target = DIRS["backups"] / name
    tmp_db = DIRS["tmp"] / f"snapshot-{stamp}.db"
    _snapshot_db(tmp_db)
    try:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.write(tmp_db, "contrail.db")
            if CONFIG_PATH.exists():
                z.write(CONFIG_PATH, "config.json")
            z.writestr("manifest.json", json.dumps({
                "app": "contrail", "version": APP_VERSION, "created": datetime.now().isoformat(timespec="seconds"),
                "include_media": include_media, "label": label,
            }, indent=2))
            if include_media:
                for kind in ("images", "thumbs", "audio", "originals"):
                    base = DIRS[kind]
                    for p in base.rglob("*"):
                        if p.is_file():
                            z.write(p, f"{kind}/{p.relative_to(base).as_posix()}", compress_type=zipfile.ZIP_STORED)
    finally:
        tmp_db.unlink(missing_ok=True)
    prune(int(settings.get("backup_keep") or 7))
    return describe(target)


def describe(p: Path) -> dict:
    st = p.stat()
    return {"name": p.name, "size": st.st_size, "created": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "full": p.stem.endswith("-full")}


def list_backups() -> list[dict]:
    return [describe(p) for p in sorted(DIRS["backups"].glob(f"{PREFIX}*.zip"), reverse=True)]


def prune(keep: int) -> None:
    files = sorted(DIRS["backups"].glob(f"{PREFIX}*.zip"), reverse=True)
    for p in files[max(keep, 1):]:
        p.unlink(missing_ok=True)


def backup_path(name: str) -> Path | None:
    if "/" in name or "\\" in name or not name.startswith(PREFIX) or not name.endswith(".zip"):
        return None
    p = DIRS["backups"] / name
    return p if p.is_file() else None


def last_backup_time() -> datetime | None:
    files = sorted(DIRS["backups"].glob(f"{PREFIX}*.zip"), reverse=True)
    return datetime.fromtimestamp(files[0].stat().st_mtime) if files else None


def restore(zip_path: Path) -> dict:
    """Restaure une archive. Une sauvegarde de sécurité est créée avant toute modification."""
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        if "contrail.db" not in names:
            raise ValueError("invalid_backup")
        tmp = DIRS["tmp"] / "restore-candidate.db"
        with z.open("contrail.db") as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
        chk = sqlite3.connect(str(tmp))
        try:
            tables = {r[0] for r in chk.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"spotting", "tags", "flights"} <= tables:
                raise ValueError("invalid_backup")
            if chk.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("corrupt_backup")
        finally:
            chk.close()
        safety = create_backup(include_media=False, label="pre-restore")
        reset_connections()
        dst = connect()
        src = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
        finally:
            src.close()
            dst.close()
        tmp.unlink(missing_ok=True)
        reset_connections()
        if "config.json" in names:
            CONFIG_PATH.write_bytes(z.read("config.json"))
        media = 0
        for n in names:
            kind = n.split("/", 1)[0]
            if kind in ("images", "thumbs", "audio", "originals") and not n.endswith("/"):
                rel = n.split("/", 1)[1]
                target = (DIRS[kind] / rel).resolve()
                if DIRS[kind].resolve() not in target.parents:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as s, open(target, "wb") as d:
                    shutil.copyfileobj(s, d)
                media += 1
    return {"restored": True, "media_files": media, "safety_backup": safety["name"], "db": str(db_path().name)}
