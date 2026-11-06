"""Sorties de spotting : liste, détail, nom et notes."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..core import db, q, q1
from ..services import collection, geo, outings
from .spots import LIST_COLS, decorate

router = APIRouter(prefix="/api/outings", tags=["outings"])

SPECIAL = "s.livery_category IS NOT NULL AND s.livery_category NOT IN ('primer', 'white')"
STATS = (f"COUNT(*) n, COUNT(DISTINCT s.registration) regs, COUNT(DISTINCT COALESCE(s.aircraft_icao, s.aircraft)) types, "
         f"MIN(s.date) first_at, MAX(s.date) last_at, SUM(s.favorite) favs, SUM(s.military) military, "
         f"SUM(CASE WHEN {SPECIAL} THEN 1 ELSE 0 END) specials, SUM(CASE WHEN s.image IS NOT NULL THEN 1 ELSE 0 END) photos")


def _filters(year: str, airport: str, place: str, search: str) -> tuple[str, list]:
    where, params = ["1=1"], []
    if year:
        where.append("o.day LIKE ?"); params.append(f"{year}%")
    if airport:
        where.append("o.airport = ?"); params.append(airport.upper())
    if place:
        where.append("o.place = ?"); params.append(place)
    if search:
        like = f"%{search.strip()}%"
        where.append("(o.name LIKE ? OR o.notes LIKE ? OR o.airport LIKE ? OR o.place LIKE ? OR o.day LIKE ?)")
        params += [like] * 5
    return " AND ".join(where), params


def _decorate(items: list[dict]) -> list[dict]:
    """Ajoute vignettes et nombre de nouveaux avions (jamais vus avant la sortie) à une page de sorties."""
    if not items:
        return items
    ids = [i["id"] for i in items]
    marks = ",".join("?" * len(ids))
    ctx = collection.badge_context()
    rank = ctx["rank"]
    thumbs: dict[int, list[str]] = {}
    new: dict[int, int] = {}
    for r in q(f"SELECT id_spotting, outing_id, thumb FROM spotting WHERE outing_id IN ({marks}) "
               "ORDER BY favorite DESC, COALESCE(rating, 0) DESC, date", ids):
        if r["thumb"] and len(thumbs.setdefault(r["outing_id"], [])) < 4:
            thumbs[r["outing_id"]].append(r["thumb"])
        if rank.get(r["id_spotting"], 0) == 1:
            new[r["outing_id"]] = new.get(r["outing_id"], 0) + 1
    for i in items:
        i["thumbs"] = thumbs.get(i["id"], [])
        i["new_regs"] = new.get(i["id"], 0)
        i["airport_info"] = _ap(i["airport"])
    return items


def _ap(code: str | None) -> dict | None:
    a = geo.airport(code) if code else None
    return {"icao": a["icao"], "name": a["name"], "city": a["city"], "country": a["country"], "iata": a.get("iata")} if a else None


@router.get("")
def list_outings(year: str = "", airport: str = "", place: str = "", search: str = "",
                 limit: int = Query(30, le=200), offset: int = 0):
    outings.sync()
    where, params = _filters(year, airport, place, search)
    total = q1(f"SELECT COUNT(*) n FROM outings o WHERE {where} AND EXISTS (SELECT 1 FROM spotting s WHERE s.outing_id = o.id_outing)", params)["n"]
    page = q(f"SELECT o.id_outing id, o.day, o.airport, o.place, o.name FROM outings o WHERE {where} AND EXISTS "
             f"(SELECT 1 FROM spotting s WHERE s.outing_id = o.id_outing) ORDER BY o.day DESC, o.id_outing DESC LIMIT ? OFFSET ?",
             params + [limit, offset])
    stats = {}                                   # agrégats calculés seulement pour les sorties de la page
    if page:
        marks = ",".join("?" * len(page))
        stats = {r["oid"]: r for r in q(f"SELECT s.outing_id oid, {STATS} FROM spotting s WHERE s.outing_id IN ({marks}) "
                                        "GROUP BY s.outing_id", [p["id"] for p in page])}
    rows = [{**p, **{k: v for k, v in stats.get(p["id"], {}).items() if k != "oid"}} for p in page]
    years = [r["y"] for r in q("SELECT DISTINCT substr(day, 1, 4) y FROM outings ORDER BY y DESC")]
    return {"items": _decorate(rows), "total": total, "years": years}


@router.get("/{outing_id}")
def get_outing(outing_id: int):
    outings.sync()
    o = q1("SELECT id_outing id, day, airport, place, name, notes FROM outings WHERE id_outing = ?", (outing_id,))
    if not o:
        raise HTTPException(404, "not_found")
    st = q1(f"SELECT {STATS} FROM spotting s WHERE s.outing_id = ?", (outing_id,))
    if not st or not st["n"]:
        raise HTTPException(404, "not_found")
    o.update(st)
    rows = q(f"SELECT {LIST_COLS}, s.metar, s.metar_json FROM spotting s WHERE s.outing_id = ? ORDER BY s.date, s.id_spotting", (outing_id,))
    ctx = collection.badge_context()
    weather = None
    for r in rows:
        if r.get("metar_json") and weather is None:
            try:
                d = json.loads(r["metar_json"])
                weather = {"raw": r["metar"], "category": d.get("category"), "wind": d.get("wind"), "temp": d.get("temp"),
                           "visibility": d.get("visibility"), "at": r["date"]}
            except (TypeError, ValueError):
                pass
        r.pop("metar_json", None); r.pop("metar", None)
    o["spots"] = decorate(rows, ctx)
    o["new_regs"] = sum(1 for r in rows if ctx["rank"].get(r["id_spotting"], 0) == 1)
    o["firsts"] = sum(1 for r in rows if any(b["code"] in ("first_type", "first_airline", "first_airport") for b in r["badges"]))
    o["weather"] = weather
    o["airport_info"] = _ap(o["airport"])
    types: dict[str, int] = {}
    for r in rows:
        k = r["aircraft_icao"] or r["aircraft"]
        if k:
            types[k] = types.get(k, 0) + 1
    o["top_types"] = sorted(({"k": k, "n": n} for k, n in types.items()), key=lambda x: -x["n"])[:6]
    o["prev_id"] = (q1("SELECT o2.id_outing id FROM outings o2 WHERE (o2.day, o2.id_outing) < (?, ?) AND EXISTS "
                       "(SELECT 1 FROM spotting s WHERE s.outing_id = o2.id_outing) ORDER BY o2.day DESC, o2.id_outing DESC LIMIT 1",
                       (o["day"], outing_id)) or {}).get("id")
    o["next_id"] = (q1("SELECT o2.id_outing id FROM outings o2 WHERE (o2.day, o2.id_outing) > (?, ?) AND EXISTS "
                       "(SELECT 1 FROM spotting s WHERE s.outing_id = o2.id_outing) ORDER BY o2.day, o2.id_outing LIMIT 1",
                       (o["day"], outing_id)) or {}).get("id")
    return o


class OutingIn(BaseModel):
    name: str | None = None
    notes: str | None = None


@router.put("/{outing_id}")
def update_outing(outing_id: int, body: OutingIn):
    if not q1("SELECT 1 FROM outings WHERE id_outing = ?", (outing_id,)):
        raise HTTPException(404, "not_found")
    conn = db()
    conn.execute("UPDATE outings SET name = ?, notes = ? WHERE id_outing = ?",
                 ((body.name or "").strip()[:120] or None, (body.notes or "").strip()[:4000] or None, outing_id))
    conn.commit()
    return get_outing(outing_id)
