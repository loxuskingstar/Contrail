"""Corbeille : spots et vols supprimés restent récupérables pendant `trash_days` jours (30 par défaut).

Les lignes supprimées sont déplacées dans la table `trash` (copie JSON de la ligne) : toutes les requêtes de
l'application (statistiques, succès, carte, export…) continuent de ne voir que les données vivantes, sans filtre
supplémentaire. Les fichiers (photo, miniature, audio) restent sur disque jusqu'à la suppression définitive.
"""
from __future__ import annotations

import json
import logging

from ..core import db, execute, get_setting, now_iso, q, q1
from . import media

log = logging.getLogger("contrail.trash")


def days() -> int:
    try:
        return max(0, int(get_setting("trash_days") if get_setting("trash_days") is not None else 30))
    except (TypeError, ValueError):
        return 30


def enabled() -> bool:
    return days() > 0


def _label(kind: str, row: dict) -> str:
    if kind == "spot":
        bits = [row.get("registration") or "", row.get("aircraft_icao") or row.get("aircraft") or "", row.get("airport") or row.get("place") or ""]
    else:
        bits = [row.get("flight_number") or row.get("registration") or "", f"{row.get('dep_icao') or ''}→{row.get('arr_icao') or ''}"]
    return " · ".join(b for b in bits if b and b != "→")[:120]


def put(kind: str, rows: list[dict]) -> list[int]:
    """Met des lignes à la corbeille (elles doivent déjà avoir été lues ; l'appelant les supprime ensuite)."""
    conn = db()
    ids = []
    for r in rows:
        payload = dict(r)
        if kind == "spot":
            payload["_tags"] = [t["id_tag"] for t in q("SELECT id_tag FROM spotting_tags WHERE id_spotting = ?", (r["id_spotting"],))]
            if r.get("patrol_id"):
                p = q1("SELECT name FROM patrols WHERE id_patrol = ?", (r["patrol_id"],))
                payload["_patrol_name"] = p["name"] if p else None
        cur = conn.execute(
            "INSERT INTO trash (kind, ref_id, label, payload, image, thumb, audio, deleted_at) VALUES (?,?,?,?,?,?,?,?)",
            (kind, r.get("id_spotting") or r.get("id_flight"), _label(kind, r), json.dumps(payload, ensure_ascii=False, default=str),
             r.get("image"), r.get("thumb"), r.get("atc_audio"), now_iso()))
        ids.append(cur.lastrowid)
    conn.commit()
    return ids


def _file_still_used(image: str | None) -> bool:
    return bool(image) and bool(
        q1("SELECT 1 FROM spotting WHERE image = ? LIMIT 1", (image,)) or q1("SELECT 1 FROM trash WHERE image = ? LIMIT 1", (image,)))


def release_files(image: str | None, thumb: str | None, audio: str | None) -> None:
    """Supprime les fichiers d'une ligne définitivement retirée (la photo reste si un autre spot ou une autre entrée la partage)."""
    media.delete_audio(audio)
    if image and _file_still_used(image):
        return
    media.delete_image(image, thumb)


def listing() -> dict:
    keep = days()
    items = q("SELECT id_trash id, kind, ref_id, label, thumb, deleted_at FROM trash ORDER BY id_trash DESC")
    return {"items": items, "days": keep, "count": len(items)}


def restore(trash_id: int) -> dict | None:
    row = q1("SELECT * FROM trash WHERE id_trash = ?", (trash_id,))
    if not row:
        return None
    data = json.loads(row["payload"])
    kind = row["kind"]
    table, pk = ("spotting", "id_spotting") if kind == "spot" else ("flights", "id_flight")
    cols = {c["name"] for c in q(f"PRAGMA table_info({table})")}
    tags = data.pop("_tags", [])
    data.pop("_patrol_name", None)
    conn = db()
    if data.get(pk) and q1(f"SELECT 1 FROM {table} WHERE {pk} = ?", (data[pk],)):
        data.pop(pk)                                  # identifiant repris entre-temps : on en attribue un nouveau
    if kind == "spot":
        if data.get("patrol_id") and not q1("SELECT 1 FROM patrols WHERE id_patrol = ?", (data["patrol_id"],)):
            data["patrol_id"] = None                  # la patrouille s'est dissoute entre-temps
        data["outing_id"] = None                      # rattaché de nouveau à sa sortie (recréée au besoin) après la restauration
        if data.get("location_id") and not q1("SELECT 1 FROM spot_locations WHERE id_location = ?", (data["location_id"],)):
            data["location_id"] = None
        if data.get("draft_uuid") and q1("SELECT 1 FROM spotting WHERE draft_uuid = ?", (data["draft_uuid"],)):
            data["draft_uuid"] = None
    out = {k: v for k, v in data.items() if k in cols}
    new_id = conn.execute(f"INSERT INTO {table} ({', '.join(out)}) VALUES ({', '.join('?' * len(out))})", list(out.values())).lastrowid
    for t in tags:
        if q1("SELECT 1 FROM tags WHERE id_tag = ?", (t,)):
            conn.execute("INSERT OR IGNORE INTO spotting_tags (id_spotting, id_tag) VALUES (?, ?)", (new_id, t))
    conn.execute("DELETE FROM trash WHERE id_trash = ?", (trash_id,))
    conn.commit()
    if kind == "spot":
        from . import outings
        outings.attach(new_id)
    return {"kind": kind, "id": new_id}


def purge(trash_id: int) -> bool:
    row = q1("SELECT * FROM trash WHERE id_trash = ?", (trash_id,))
    if not row:
        return False
    execute("DELETE FROM trash WHERE id_trash = ?", (trash_id,))
    release_files(row["image"], row["thumb"], row["audio"])
    return True


def empty() -> int:
    n = 0
    for r in q("SELECT id_trash FROM trash"):
        n += purge(r["id_trash"])
    return n


def purge_old() -> int:
    """Supprime définitivement ce qui dort dans la corbeille depuis plus de `trash_days` jours."""
    from datetime import datetime, timedelta, timezone

    keep = days()
    if keep <= 0:
        return empty()
    limit = (datetime.now(timezone.utc) - timedelta(days=keep)).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = 0
    for r in q("SELECT id_trash FROM trash WHERE deleted_at < ?", (limit,)):
        n += purge(r["id_trash"])
    if n:
        log.info("Corbeille : %d élément(s) supprimé(s) définitivement", n)
    return n
