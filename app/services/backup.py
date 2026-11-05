"""Sauvegardes .zip (BDD + configuration, médias en option) et restauration."""
from __future__ import annotations

import json
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

from ..core import (APP_VERSION, CONFIG_PATH, DIRS, connect, db_path, get_config, get_settings, load_config, reset_connections)

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
                # Le mot de passe du serveur de sauvegarde ne doit pas être stocké… sur ce serveur
                cfg = {k: v for k, v in load_config().items() if k != "backup_webdav_password"}
                z.writestr("config.json", json.dumps(cfg, indent=2, ensure_ascii=False))
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
    keep = int(settings.get("backup_keep") or 7)
    prune(keep)
    info = describe(target)
    info["remote"] = push_remote(target, keep)
    return info


# --------------------------------------------------------------------------- #
# Copie hors de la machine : un dossier monté (NAS, disque externe, Syncthing…) et/ou un serveur WebDAV
# (Nextcloud, Synology…). Une panne de disque ne doit pas emporter les sauvegardes avec la base.
# --------------------------------------------------------------------------- #
REMOTE_STATUS = "remote-status.json"


def remote_configured() -> bool:
    return bool(get_config("backup_remote_path") or get_config("backup_webdav_url"))


def _dav_auth():
    import httpx
    user = get_config("backup_webdav_user")
    return httpx.BasicAuth(user, get_config("backup_webdav_password")) if user else None


def _dav_names(client, base: str) -> list[str]:
    import re
    r = client.request("PROPFIND", base + "/", headers={"Depth": "1"})
    if r.status_code not in (200, 207):
        return []
    names = {n.rsplit("/", 1)[-1] for n in re.findall(r"<[^>]*href[^>]*>([^<]+)<", r.text)}
    return sorted((n for n in names if n.startswith(PREFIX) and n.endswith(".zip")), reverse=True)


def _push_dir(src: Path, keep: int) -> None:
    dest = Path(get_config("backup_remote_path"))
    if not dest.is_dir():   # jamais de mkdir : un montage absent ferait écrire dans le conteneur et rien sur le disque distant
        raise OSError(f"dossier introuvable : {dest}")
    tmp = dest / (src.name + ".part")
    shutil.copyfile(src, tmp)
    tmp.replace(dest / src.name)
    for old in sorted(dest.glob(f"{PREFIX}*.zip"), reverse=True)[max(keep, 1):]:
        old.unlink(missing_ok=True)


def _push_webdav(src: Path, keep: int) -> None:
    import httpx
    base = get_config("backup_webdav_url").rstrip("/")
    with httpx.Client(auth=_dav_auth(), timeout=httpx.Timeout(600, connect=20), follow_redirects=True) as c:
        with open(src, "rb") as fh:
            r = c.put(f"{base}/{src.name}", content=fh)
        if r.status_code not in (200, 201, 204):
            raise OSError(f"WebDAV : HTTP {r.status_code}")
        for old in _dav_names(c, base)[max(keep, 1):]:
            c.delete(f"{base}/{old}")


def push_remote(src: Path, keep: int = 7) -> dict:
    """Copie une sauvegarde vers chaque destination configurée. Ne lève jamais : renvoie le détail par destination."""
    targets = []
    for kind, configured, fn in (("path", get_config("backup_remote_path"), _push_dir),
                                 ("webdav", get_config("backup_webdav_url"), _push_webdav)):
        if not configured:
            continue
        try:
            fn(src, keep)
            targets.append({"kind": kind, "ok": True})
        except Exception as e:  # noqa: BLE001 — la sauvegarde locale existe déjà, l'échec est signalé à part
            targets.append({"kind": kind, "ok": False, "error": str(e)[:200]})
    result = {"configured": bool(targets), "ok": all(t["ok"] for t in targets), "targets": targets,
              "at": datetime.now().isoformat(timespec="seconds"), "file": src.name}
    if targets:
        (DIRS["backups"] / REMOTE_STATUS).write_text(json.dumps(result), "utf-8")
        if not result["ok"]:
            from .notify import notify, texts
            title, body = texts("backup_remote_failed", error="; ".join(f"{t['kind']}: {t['error']}" for t in targets if not t["ok"]))
            notify("backup", title, body, "#/settings/data")
    return result


def remote_status() -> dict:
    try:
        last = json.loads((DIRS["backups"] / REMOTE_STATUS).read_text("utf-8"))
    except (OSError, ValueError):
        last = None
    return {"configured": remote_configured(), "last": last}


def test_remote() -> dict:
    """Vérifie les destinations en y écrivant puis supprimant un petit fichier."""
    probe = DIRS["tmp"] / "contrail-remote-probe.txt"
    probe.write_text("contrail", "utf-8")
    out = []
    try:
        if get_config("backup_remote_path"):
            try:
                dest = Path(get_config("backup_remote_path"))
                if not dest.is_dir():
                    raise OSError(f"dossier introuvable : {dest}")
                (dest / ".contrail-probe").write_text("ok", "utf-8")
                (dest / ".contrail-probe").unlink()
                out.append({"kind": "path", "ok": True})
            except Exception as e:  # noqa: BLE001
                out.append({"kind": "path", "ok": False, "error": str(e)[:200]})
        if get_config("backup_webdav_url"):
            import httpx
            try:
                base = get_config("backup_webdav_url").rstrip("/")
                with httpx.Client(auth=_dav_auth(), timeout=30, follow_redirects=True) as c:
                    r = c.put(f"{base}/.contrail-probe", content=probe.read_bytes())
                    if r.status_code not in (200, 201, 204):
                        raise OSError(f"WebDAV : HTTP {r.status_code}")
                    c.delete(f"{base}/.contrail-probe")
                out.append({"kind": "webdav", "ok": True})
            except Exception as e:  # noqa: BLE001
                out.append({"kind": "webdav", "ok": False, "error": str(e)[:200]})
    finally:
        probe.unlink(missing_ok=True)
    return {"configured": bool(out), "ok": bool(out) and all(t["ok"] for t in out), "targets": out}


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
        if "config.json" in names:   # fusion : les clés absentes de l'archive (mot de passe WebDAV) sont conservées
            try:
                incoming = json.loads(z.read("config.json"))
            except ValueError:
                incoming = {}
            CONFIG_PATH.write_text(json.dumps({**load_config(), **incoming}, indent=2, ensure_ascii=False), "utf-8")
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
