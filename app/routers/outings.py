"""Sorties de spotting : liste, détail, nom et notes."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..core import db, q, q1
from ..services import actypes, collection, geo, outings, refdb
from .spots import LIST_COLS, decorate

router = APIRouter(prefix="/api/outings", tags=["outings"])

SPECIAL = "s.livery_category IS NOT NULL AND s.livery_category NOT IN ('primer', 'white')"
STATS = (f"COUNT(*) n, COUNT(DISTINCT s.registration) regs, COUNT(DISTINCT COALESCE(s.aircraft_icao, s.aircraft)) types, "
         f"MIN(s.date) first_at, MAX(s.date) last_at, SUM(s.favorite) favs, SUM(s.military) military, "
         f"SUM(CASE WHEN {SPECIAL} THEN 1 ELSE 0 END) specials, SUM(CASE WHEN s.image IS NOT NULL THEN 1 ELSE 0 END) photos, SUM(CASE WHEN s.is_patrol = 1 THEN 1 ELSE 0 END) patrols")


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
def list_outings(year: str = "", airport: str = "", place: str = "", search: str = "", kind: str = "",
                 limit: int = Query(30, le=200), offset: int = 0):
    outings.sync()
    where, params = _filters(year, airport, place, search)
    shown = "(o.kind = 'airshow' OR EXISTS (SELECT 1 FROM spotting s WHERE s.outing_id = o.id_outing))"
    if kind:
        where += " AND o.kind = ?"; params = params + [kind]
    total = q1(f"SELECT COUNT(*) n FROM outings o WHERE {where} AND {shown}", params)["n"]
    page = q(f"SELECT o.id_outing id, o.day, o.end_day, o.kind, o.airport, o.place, o.name FROM outings o WHERE {where} AND {shown} "
             "ORDER BY o.day DESC, o.id_outing DESC LIMIT ? OFFSET ?", params + [limit, offset])
    stats = {}                                   # agrégats calculés seulement pour les sorties de la page
    if page:
        marks = ",".join("?" * len(page))
        stats = {r["oid"]: r for r in q(f"SELECT s.outing_id oid, {STATS} FROM spotting s WHERE s.outing_id IN ({marks}) "
                                        "GROUP BY s.outing_id", [p["id"] for p in page])}
    empty = {"n": 0, "regs": 0, "types": 0, "first_at": None, "last_at": None, "favs": 0, "military": 0, "specials": 0, "photos": 0, "patrols": 0}
    rows = [{**p, **empty, **{k: v for k, v in stats.get(p["id"], {}).items() if k != "oid"}} for p in page]
    years = [r["y"] for r in q("SELECT DISTINCT substr(day, 1, 4) y FROM outings ORDER BY y DESC")]
    for it in rows:
        it["span"] = (_days_between(it["day"], it["end_day"]) + 1) if it.get("end_day") else 1
    return {"items": _decorate(rows), "total": total, "years": years}


def _days_between(a: str, b: str) -> int:
    from datetime import date
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _all_days(day: str, end: str | None) -> list[str]:
    from datetime import date, timedelta
    if not end:
        return [day]
    d0 = date.fromisoformat(day)
    return [(d0 + timedelta(days=i)).isoformat() for i in range(min(_days_between(day, end), 14) + 1)]


def _norm_reg(v: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (v or "").upper())


def _items(outing_id: int, rows: list[dict]) -> list[dict]:
    regs = {}
    types = {}
    for r in rows:
        regs.setdefault(_norm_reg(r["registration"]), r["id_spotting"])
        if r.get("test_registration"):
            regs.setdefault(_norm_reg(r["test_registration"]), r["id_spotting"])
        if r.get("aircraft_icao"):
            types.setdefault(r["aircraft_icao"].upper(), r["id_spotting"])
    out = []
    for it in q("SELECT id_item id, day, time, label, match_kind, match_value, done, notes FROM outing_items WHERE outing_id = ? "
                "ORDER BY COALESCE(day, ''), COALESCE(time, ''), id_item", (outing_id,)):
        spot = regs.get(_norm_reg(it["match_value"])) if it["match_kind"] == "registration" else \
            types.get((it["match_value"] or "").upper()) if it["match_kind"] == "type" else None
        it["spot_id"] = spot
        it["seen"] = bool(spot or it["done"])
        out.append(it)
    return out


@router.get("/{outing_id}")
def get_outing(outing_id: int):
    outings.sync()
    o = q1("SELECT id_outing id, day, end_day, kind, airport, place, name, notes FROM outings WHERE id_outing = ?", (outing_id,))
    if not o:
        raise HTTPException(404, "not_found")
    st = q1(f"SELECT {STATS} FROM spotting s WHERE s.outing_id = ?", (outing_id,))
    if (not st or not st["n"]) and o["kind"] != "airshow":
        raise HTTPException(404, "not_found")
    o.update({k: (v or 0) if k not in ("first_at", "last_at") else v for k, v in (st or {}).items()})
    rows = q(f"SELECT {LIST_COLS}, s.metar, s.metar_json FROM spotting s WHERE s.outing_id = ? ORDER BY s.date, s.id_spotting", (outing_id,))
    ctx = collection.badge_context()
    weather = None
    weather_by_day: dict[str, dict] = {}
    for r in rows:
        if r.get("metar_json"):
            try:
                d = json.loads(r["metar_json"])
                w = {"raw": r["metar"], "category": d.get("category"), "wind": d.get("wind"), "temp": d.get("temp"),
                     "visibility": d.get("visibility"), "at": r["date"]}
                weather = weather or w
                weather_by_day.setdefault((r["date"] or "")[:10], w)
            except (TypeError, ValueError):
                pass
        r.pop("metar_json", None); r.pop("metar", None)
    o["spots"] = decorate(rows, ctx)
    o["new_regs"] = sum(1 for r in rows if ctx["rank"].get(r["id_spotting"], 0) == 1)
    o["firsts"] = sum(1 for r in rows if any(b["code"] in ("first_type", "first_airline", "first_airport") for b in r["badges"]))
    o["rare"] = sum(1 for r in o["spots"] if any(b["code"] == "rarity" and b["tier"] in collection.RARE_TIERS for b in r["badges"]))
    o["weather"] = weather
    o["airport_info"] = _ap(o["airport"])
    types: dict[str, int] = {}
    for r in rows:
        k = r["aircraft_icao"] or r["aircraft"]
        if k:
            types[k] = types.get(k, 0) + 1
    o["top_types"] = sorted(({"k": k, "n": n} for k, n in types.items()), key=lambda x: -x["n"])[:6]
    # Jours de la sortie (y compris sans spot) : chiffres par jour et météo
    per: dict[str, dict] = {}
    for r in o["spots"]:
        d = (r["date"] or "")[:10]
        e = per.setdefault(d, {"day": d, "n": 0, "regs": set(), "new": 0, "military": 0})
        e["n"] += 1
        e["regs"].add(r["registration"])
        e["military"] += 1 if r.get("military") else 0
        e["new"] += 1 if ctx["rank"].get(r["id_spotting"], 0) == 1 else 0
    days = []
    for d in sorted(set(_all_days(o["day"], o["end_day"])) | set(per)):
        e = per.get(d, {"day": d, "n": 0, "regs": set(), "new": 0, "military": 0})
        days.append({**e, "regs": len(e["regs"]), "weather": weather_by_day.get(d)})
    o["days"] = days
    hours: dict[int, int] = {}
    for r in rows:
        if r.get("date") and len(r["date"]) >= 13:
            hours[int(r["date"][11:13])] = hours.get(int(r["date"][11:13]), 0) + 1
    o["hours"] = [{"h": h, "n": hours.get(h, 0)} for h in range(min(hours), max(hours) + 1)] if hours else []
    o["items"] = _items(outing_id, rows)
    last = o["end_day"] or o["day"]
    o["mergeable"] = [dict(r, span=1) for r in q(
        "SELECT o2.id_outing id, o2.day, o2.end_day, o2.name FROM outings o2 WHERE o2.id_outing <> ? AND COALESCE(o2.airport, '') = ? "
        "AND COALESCE(o2.place, '') = ? AND o2.day <= date(?, '+3 days') AND COALESCE(o2.end_day, o2.day) >= date(?, '-3 days') "
        "AND EXISTS (SELECT 1 FROM spotting s WHERE s.outing_id = o2.id_outing) ORDER BY o2.day",
        (outing_id, o["airport"] or "", o["place"] or "", last, o["day"]))]
    o["prev_id"] = (q1("SELECT o2.id_outing id FROM outings o2 WHERE (o2.day, o2.id_outing) < (?, ?) AND (o2.kind = 'airshow' OR EXISTS "
                       "(SELECT 1 FROM spotting s WHERE s.outing_id = o2.id_outing)) ORDER BY o2.day DESC, o2.id_outing DESC LIMIT 1",
                       (o["day"], outing_id)) or {}).get("id")
    o["next_id"] = (q1("SELECT o2.id_outing id FROM outings o2 WHERE (o2.day, o2.id_outing) > (?, ?) AND (o2.kind = 'airshow' OR EXISTS "
                       "(SELECT 1 FROM spotting s WHERE s.outing_id = o2.id_outing)) ORDER BY o2.day, o2.id_outing LIMIT 1",
                       (o["day"], outing_id)) or {}).get("id")
    return o


class OutingIn(BaseModel):
    name: str | None = None
    notes: str | None = None
    kind: str | None = None
    day: str | None = None
    end_day: str | None = None


def _err(e: Exception):
    raise HTTPException(422, str(e))


@router.put("/{outing_id}")
def update_outing(outing_id: int, body: OutingIn):
    o = q1("SELECT * FROM outings WHERE id_outing = ?", (outing_id,))
    if not o:
        raise HTTPException(404, "not_found")
    kind = body.kind if body.kind in ("outing", "airshow") else o["kind"]
    day, end = o["day"], o["end_day"]
    if body.day is not None or body.end_day is not None:
        day = body.day or o["day"]
        end = body.end_day or None
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or (end and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)):
            raise HTTPException(422, "bad_day")
        end = end if end and end > day else None
    conn = db()
    try:
        conn.execute("UPDATE outings SET name = ?, notes = ?, kind = ?, day = ?, end_day = ? WHERE id_outing = ?",
                     ((body.name or "").strip()[:120] or None, (body.notes or "").strip()[:4000] or None, kind, day, end, outing_id))
    except Exception as e:  # noqa: BLE001 — clé (jour, site) déjà prise
        raise HTTPException(409, "day_taken") from e
    if (day, end) != (o["day"], o["end_day"]):       # plage modifiée : on détache les spots devenus hors plage, puis on rattache
        conn.execute("UPDATE spotting SET outing_id = NULL WHERE outing_id = ? AND substr(date, 1, 10) NOT BETWEEN ? AND ?",
                     (outing_id, day, end or day))
    conn.commit()
    outings.sync()
    return get_outing(outing_id)


class PlanIn(BaseModel):
    day: str
    end_day: str | None = None
    airport: str | None = None
    place: str | None = None
    name: str | None = None
    kind: str = "airshow"


@router.post("")
def plan_outing(body: PlanIn):
    """Planifie un meeting (ou une sortie) à venir, et y rassemble ce qui existe déjà sur ces jours."""
    try:
        oid = outings.plan(body.day, body.end_day, body.airport, body.place, body.name, body.kind)
    except outings.OutingError as e:
        _err(e)
    return {"id": oid}


class MergeIn(BaseModel):
    ids: list[int]
    name: str | None = None
    kind: str | None = None


@router.post("/merge")
def merge_outings(body: MergeIn):
    try:
        oid = outings.merge(body.ids, body.name, body.kind)
    except outings.OutingError as e:
        _err(e)
    return {"id": oid}


@router.post("/{outing_id}/split")
def split_outing(outing_id: int):
    try:
        outings.split(outing_id)
    except outings.OutingError as e:
        _err(e)
    return {"ok": True}


@router.delete("/{outing_id}")
def delete_outing(outing_id: int):
    """Supprime une sortie planifiée vide (une sortie qui contient des spots se défait avec « Séparer »)."""
    if q1("SELECT 1 FROM spotting WHERE outing_id = ? LIMIT 1", (outing_id,)):
        raise HTTPException(409, "has_spots")
    conn = db()
    conn.execute("DELETE FROM outing_items WHERE outing_id = ?", (outing_id,))
    conn.execute("DELETE FROM outings WHERE id_outing = ?", (outing_id,))
    conn.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Programme / « à voir » d'un meeting
# --------------------------------------------------------------------------- #
class ItemIn(BaseModel):
    label: str | None = None
    day: str | None = None
    time: str | None = None
    match_kind: str | None = None
    match_value: str | None = None
    done: bool | None = None
    notes: str | None = None


def _detect(label: str) -> tuple[str, str | None]:
    """Devine ce que désigne une ligne du programme : immatriculation, code type, ou texte libre."""
    v = label.strip().upper()
    if re.fullmatch(r"[A-Z0-9]{1,2}-[A-Z0-9]{2,5}|N\d{1,5}[A-Z]{0,2}", v):
        return "registration", v
    if re.fullmatch(r"[A-Z][A-Z0-9]{2,3}", v) and (v in refdb.type_counts() or actypes.family(v, None)):
        return "type", v
    return "free", None


@router.post("/{outing_id}/items")
def add_item(outing_id: int, body: ItemIn):
    if not q1("SELECT 1 FROM outings WHERE id_outing = ?", (outing_id,)):
        raise HTTPException(404, "not_found")
    label = (body.label or "").strip()[:120]
    if not label:
        raise HTTPException(422, "label_required")
    kind, val = (body.match_kind, (body.match_value or "").strip().upper() or None) if body.match_kind in ("registration", "type", "free") else _detect(label)
    conn = db()
    cur = conn.execute("INSERT INTO outing_items (outing_id, day, time, label, match_kind, match_value, notes, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))",
                       (outing_id, body.day or None, (body.time or "")[:5] or None, label, kind, val, (body.notes or "").strip()[:500] or None))
    conn.commit()
    return {"id": cur.lastrowid, "match_kind": kind, "match_value": val}


@router.put("/items/{item_id}")
def update_item(item_id: int, body: ItemIn):
    it = q1("SELECT * FROM outing_items WHERE id_item = ?", (item_id,))
    if not it:
        raise HTTPException(404, "not_found")
    f = body.model_dump(exclude_unset=True)
    conn = db()
    if "label" in f and (f["label"] or "").strip():
        label = f["label"].strip()[:120]
        kind, val = _detect(label)
        conn.execute("UPDATE outing_items SET label = ?, match_kind = ?, match_value = ? WHERE id_item = ?", (label, kind, val, item_id))
    for col in ("day", "time", "notes"):
        if col in f:
            conn.execute(f"UPDATE outing_items SET {col} = ? WHERE id_item = ?", ((f[col] or "").strip() or None, item_id))
    if "done" in f:
        conn.execute("UPDATE outing_items SET done = ? WHERE id_item = ?", (1 if f["done"] else 0, item_id))
    conn.commit()
    return {"ok": True}


@router.delete("/items/{item_id}")
def delete_item(item_id: int):
    conn = db()
    conn.execute("DELETE FROM outing_items WHERE id_item = ?", (item_id,))
    conn.commit()
    return {"ok": True}
