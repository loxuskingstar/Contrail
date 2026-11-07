"""Patrouilles : une patrouille regroupe des passages (photos de la formation, y compris en « mode simple ») et des avions identifiés.

Un *passage* est une rencontre : un jour, un lieu. Plusieurs photos ou avions du même jour et du même lieu ne font qu'un passage.
Un avion identifié compte donc comme une rencontre de la patrouille, au même titre qu'un spot en mode simple."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import execute, memo, q, q1
from ..services import geo

router = APIRouter(prefix="/api/patrols", tags=["patrols"])

OCC = "(COALESCE(substr(s.date, 1, 10), 'u' || s.id_spotting) || '|' || COALESCE(NULLIF(s.airport, ''), NULLIF(s.place, ''), ''))"


def _list() -> list[dict]:
    rows = q(f"""
        SELECT p.id_patrol id, p.name, COUNT(*) spots, SUM(s.is_patrol) simple_spots,
               COUNT(DISTINCT CASE WHEN s.is_patrol = 0 THEN s.registration END) aircraft,
               COUNT(DISTINCT {OCC}) passages, MIN(s.date) first_at, MAX(s.date) last_at,
               MAX(s.country) country, MAX(s.patrol_size) size,
               (SELECT x.thumb FROM spotting x WHERE x.patrol_id = p.id_patrol AND x.thumb IS NOT NULL
                  ORDER BY x.date DESC, x.id_spotting DESC LIMIT 1) thumb
        FROM patrols p JOIN spotting s ON s.patrol_id = p.id_patrol
        GROUP BY p.id_patrol ORDER BY MAX(s.date) DESC""")
    for r in rows:
        r["name"] = r["name"] or ""
        r["simple"] = bool(r.pop("simple_spots"))
    return rows


@router.get("")
def list_patrols():
    return {"items": [r for r in memo("patrols", _list) if r["name"] or r["passages"] > 1]}


@router.get("/{pid}")
def get_patrol(pid: int):
    p = q1("SELECT id_patrol id, name FROM patrols WHERE id_patrol = ?", (pid,))
    if not p:
        raise HTTPException(404, "not_found")
    spots = q("SELECT s.id_spotting id, s.registration, s.aircraft, s.aircraft_icao, s.owner, s.date, s.airport, s.place, s.thumb, "
              "s.is_patrol, s.patrol_size, s.country, s.military, s.livery_category, s.favorite FROM spotting s "
              "WHERE s.patrol_id = ? ORDER BY s.date DESC, s.id_spotting DESC", (pid,))
    # Passages : un par jour et par lieu
    passages: dict[str, dict] = {}
    for s in spots:
        key = f"{(s['date'] or 'u' + str(s['id']))[:10]}|{s['airport'] or s['place'] or ''}"
        o = passages.setdefault(key, {"day": (s["date"] or "")[:10] or None, "date": s["date"], "airport": s["airport"], "place": s["place"],
                                      "thumb": None, "simple_id": None, "size": None, "spots": [], "aircraft": []})
        o["spots"].append(s["id"])
        o["thumb"] = o["thumb"] or s["thumb"]
        if s["is_patrol"]:
            o["simple_id"] = o["simple_id"] or s["id"]
            o["size"] = o["size"] or s["patrol_size"]
        else:
            o["aircraft"].append({"id": s["id"], "registration": s["registration"]})
    for o in passages.values():
        a = geo.airport(o["airport"]) if o["airport"] else None
        o["airport_name"] = a["name"] if a else None
    plist = list(passages.values())
    # Avions identifiés : combien de rencontres chacun, quand, et sur combien de passages de la patrouille
    fleet: dict[str, dict] = {}
    for s in spots:
        if s["is_patrol"]:
            continue
        f = fleet.setdefault(s["registration"], {"registration": s["registration"], "aircraft": s["aircraft"], "owner": s["owner"], "thumb": None,
                                                "n": 0, "last": s["date"], "first": s["date"], "id": s["id"]})
        f["n"] += 1
        f["thumb"] = f["thumb"] or s["thumb"]
        f["first"] = s["date"] or f["first"]
    for f in fleet.values():
        f["passages"] = sum(1 for o in plist if any(a["registration"] == f["registration"] for a in o["aircraft"]))
    airports: dict[str, int] = {}
    years: dict[str, int] = {}
    for o in plist:
        if o["airport"] or o["place"]:
            k = o["airport"] or o["place"]
            airports[k] = airports.get(k, 0) + 1
        if o["day"]:
            years[o["day"][:4]] = years.get(o["day"][:4], 0) + 1
    dates = sorted(s["date"] for s in spots if s["date"])
    sizes = [s["patrol_size"] for s in spots if s["patrol_size"]]
    return {
        "id": p["id"], "name": p["name"] or "", "country": next((s["country"] for s in spots if s["is_patrol"] and s["country"]), None)
        or next((s["country"] for s in spots if s["country"]), None),
        "simple": any(s["is_patrol"] for s in spots), "spots": len(spots), "passages": plist, "n_passages": len(plist),
        "aircraft": sorted(fleet.values(), key=lambda f: (-f["n"], f["registration"])), "size": max(sizes) if sizes else None,
        "first_at": dates[0] if dates else None, "last_at": dates[-1] if dates else None,
        "military": any(s["military"] for s in spots),
        "airports": [{"k": k, "n": n, "name": (geo.airport(k) or {}).get("name")} for k, n in sorted(airports.items(), key=lambda kv: -kv[1])[:8]],
        "by_year": [{"y": y, "n": n} for y, n in sorted(years.items())],
    }


class Rename(BaseModel):
    name: str


@router.put("/{pid}")
def rename_patrol(pid: int, body: Rename):
    name = body.name.strip()[:80]
    if not name:
        raise HTTPException(422, "patrol_name_required")
    if not q1("SELECT 1 FROM patrols WHERE id_patrol = ?", (pid,)):
        raise HTTPException(404, "not_found")
    from .spots import find_patrol, patrol_key
    other = find_patrol(name, exclude=pid)
    if other:                                   # ce nom existe déjà : les deux patrouilles n'en font qu'une
        return _merge(pid, other)
    execute("UPDATE patrols SET name = ? WHERE id_patrol = ?", (name, pid))
    # En mode simple, l'immatriculation est la clé tirée du nom : elle suit le nom
    execute("UPDATE spotting SET registration = ? WHERE patrol_id = ? AND is_patrol = 1", (patrol_key(name), pid))
    return {"id": pid, "name": name}


class Merge(BaseModel):
    into: int


def _merge(pid: int, into: int) -> dict:
    if pid == into or not q1("SELECT 1 FROM patrols WHERE id_patrol = ?", (into,)):
        raise HTTPException(422, "invalid_merge")
    from .spots import patrol_key
    target = q1("SELECT name FROM patrols WHERE id_patrol = ?", (into,))
    execute("UPDATE spotting SET patrol_id = ? WHERE patrol_id = ?", (into, pid))
    execute("UPDATE spotting SET registration = ? WHERE patrol_id = ? AND is_patrol = 1", (patrol_key(target["name"] or ""), into))
    execute("DELETE FROM patrols WHERE id_patrol = ?", (pid,))
    return {"id": into, "name": target["name"], "merged": True}


@router.post("/{pid}/merge")
def merge_patrol(pid: int, body: Merge):
    return _merge(pid, body.into)


@router.post("/{pid}/detach/{spot_id}")
def detach_spot(pid: int, spot_id: int):
    """Retire un spot de la patrouille (avion rattaché par erreur)."""
    execute("UPDATE spotting SET patrol_id = NULL WHERE id_spotting = ? AND patrol_id = ? AND is_patrol = 0", (spot_id, pid))
    return {"ok": True}

