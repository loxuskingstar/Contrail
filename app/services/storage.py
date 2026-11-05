"""Occupation disque, fichiers orphelins et maintenance de la base (intégrité, compactage, optimisation)."""
from __future__ import annotations

import time
from pathlib import Path

from ..core import DIRS, connect, db_path, q
from . import media, refdb

MEDIA_KINDS = ("images", "thumbs", "audio", "originals")
ORPHAN_MIN_AGE = 3600   # un fichier de moins d'une heure peut appartenir à un envoi en cours : on n'y touche pas


def _tree(base: Path) -> tuple[int, int]:
    total = count = 0
    if base.exists():
        for p in base.rglob("*"):
            if p.is_file():
                total += p.stat().st_size
                count += 1
    return total, count


def _file_size(p: Path) -> int:
    n = p.stat().st_size if p.exists() else 0
    for ext in ("-wal", "-shm"):
        w = Path(str(p) + ext)
        n += w.stat().st_size if w.exists() else 0
    return n


def _referenced() -> dict[str, set[str]]:
    rows = q("SELECT image, thumb, atc_audio FROM spotting")
    imgs = {r["image"] for r in rows if r["image"]}
    return {
        "images": imgs,
        "thumbs": {r["thumb"] for r in rows if r["thumb"]},
        "audio": {r["atc_audio"] for r in rows if r["atc_audio"]},
        # un original porte le même sous-dossier et le même nom (hors extension) que l'image qu'il a produite
        "originals": {str(Path(i).with_suffix("")) for i in imgs},
    }


def orphans() -> dict[str, list[Path]]:
    ref, out, now = _referenced(), {}, time.time()
    for kind in MEDIA_KINDS:
        base, found = DIRS[kind], []
        if base.exists():
            for p in base.rglob("*"):
                if not p.is_file() or now - p.stat().st_mtime < ORPHAN_MIN_AGE:
                    continue
                rel = p.relative_to(base)
                key = str(rel.with_suffix("")) if kind == "originals" else rel.as_posix()
                if key not in ref[kind]:
                    found.append(p)
        out[kind] = found
    return out


def report() -> dict:
    parts = {}
    for kind in MEDIA_KINDS + ("backups",):
        size, n = _tree(DIRS[kind])
        parts[kind] = {"bytes": size, "files": n}
    parts["database"] = {"bytes": _file_size(db_path()), "files": 1}
    parts["refdb"] = {"bytes": _file_size(refdb.REF_PATH) if refdb.available() else 0, "files": 1 if refdb.available() else 0}
    spots = q("SELECT COUNT(*) n, COUNT(image) with_image FROM spotting")[0]
    orph = orphans()
    ob = sum(p.stat().st_size for ps in orph.values() for p in ps)
    total = sum(v["bytes"] for v in parts.values())
    imgs = parts["images"]
    return {
        "parts": parts, "total": total, "spots": spots["n"], "with_image": spots["with_image"],
        "avg_image": round(imgs["bytes"] / imgs["files"]) if imgs["files"] else 0,
        "orphans": {"files": sum(len(v) for v in orph.values()), "bytes": ob},
    }


def maintain(purge_orphans: bool = False) -> dict:
    """Vérifie l'intégrité, compacte et optimise la base ; supprime au besoin les médias orphelins."""
    before = _file_size(db_path())
    conn = connect()
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()
        ok = (integrity["integrity_check"] if isinstance(integrity, dict) else integrity[0]) == "ok"
        if ok:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("VACUUM")
            conn.execute("PRAGMA optimize")
    finally:
        conn.close()
    hashed = media.backfill_phash()
    freed = removed = 0
    if purge_orphans:
        for ps in orphans().values():
            for p in ps:
                try:
                    freed += p.stat().st_size
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
    return {"integrity": ok, "db_before": before, "db_after": _file_size(db_path()),
            "orphans_removed": removed, "orphans_freed": freed, "hashed": hashed}
