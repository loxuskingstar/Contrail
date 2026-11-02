"""Outils de terrain : répertoire des spots, soleil, radar OpenSky, watchlist."""
from __future__ import annotations

import json
from datetime import datetime

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..core import execute, now_iso, q, q1
from ..services import geo, opensky
from ..services import registration as regs

router = APIRouter(tags=["field"])


class LocationIn(BaseModel):
    name: str
    lat: float
    lng: float
    airport: str | None = None
    runways: str | None = None
    view_bearing: float | None = None
    access: str | None = None
    notes: str | None = None


def _tz_for(lat: float, lng: float, airport: str | None) -> str:
    a = geo.airport(airport)
    if a:
        return a["tz"]
    from .misc import nearest_airport

    n = nearest_airport(lat, lng, 80)
    return n["tz"] if n else "UTC"


def _prepare_loc(body: LocationIn) -> dict:
    d = body.model_dump()
    d["airport"] = geo.resolve_icao(d["airport"]) if d.get("airport") else None
    if d.get("view_bearing") is not None:
        d["view_bearing"] = float(d["view_bearing"]) % 360
    d["best_time"] = geo.best_time_summary(d["lat"], d["lng"], _tz_for(d["lat"], d["lng"], d["airport"]), d.get("view_bearing"))
    return d


@router.get("/api/locations")
def list_locations():
    rows = q("SELECT l.*, (SELECT COUNT(*) FROM spotting s WHERE s.location_id = l.id_location) spots "
             "FROM spot_locations l ORDER BY l.airport, l.name")
    now = datetime.now()
    for r in rows:
        tz = _tz_for(r["lat"], r["lng"], r["airport"])
        r["today"] = geo.sun_day(r["lat"], r["lng"], now, tz, r["view_bearing"], step_min=15)
        r["today"].pop("samples", None)
    return rows


@router.get("/api/locations/{loc_id}")
def get_location(loc_id: int):
    r = q1("SELECT * FROM spot_locations WHERE id_location = ?", (loc_id,))
    if not r:
        raise HTTPException(404, "not_found")
    return r


@router.post("/api/locations")
def create_location(body: LocationIn):
    d = _prepare_loc(body)
    d["created_at"] = d["updated_at"] = now_iso()
    cur = execute(f"INSERT INTO spot_locations({', '.join(d)}) VALUES({', '.join('?' * len(d))})", list(d.values()))
    return get_location(cur.lastrowid)


@router.put("/api/locations/{loc_id}")
def update_location(loc_id: int, body: LocationIn):
    d = _prepare_loc(body)
    d["updated_at"] = now_iso()
    execute(f"UPDATE spot_locations SET {', '.join(f'{k}=?' for k in d)} WHERE id_location=?", list(d.values()) + [loc_id])
    return get_location(loc_id)


@router.delete("/api/locations/{loc_id}")
def delete_location(loc_id: int):
    execute("DELETE FROM spot_locations WHERE id_location = ?", (loc_id,))
    return {"deleted": loc_id}


@router.get("/api/sun")
def sun(lat: float, lng: float, bearing: float | None = None, date: str = "", airport: str = ""):
    try:
        day = datetime.fromisoformat(date) if date else datetime.now()
    except ValueError as e:
        raise HTTPException(422, "bad_date") from e
    tz = _tz_for(lat, lng, airport or None)
    res = geo.sun_day(lat, lng, day, tz, bearing)
    from zoneinfo import ZoneInfo

    az, el = geo.sun_position(lat, lng, datetime.now(ZoneInfo(tz)))
    res["now"] = {"az": az, "el": el}
    return res


# --------------------------------------------------------------------------- #
# Radar
# --------------------------------------------------------------------------- #
@router.get("/api/radar")
def radar(lamin: float, lomin: float, lamax: float, lomax: float):
    # Limite la zone pour rester dans le quota anonyme d'OpenSky
    if (lamax - lamin) * (lomax - lomin) > 100:
        raise HTTPException(422, "area_too_large")
    try:
        return opensky.radar(lamin, lomin, lamax, lomax)
    except httpx.HTTPError as e:
        raise HTTPException(502, "opensky_unreachable") from e


# --------------------------------------------------------------------------- #
# Watchlist
# --------------------------------------------------------------------------- #
class WatchIn(BaseModel):
    registration: str
    note: str | None = None
    notify: bool = True


@router.get("/api/watchlist")
def list_watch():
    rows = q("SELECT w.*, (SELECT COUNT(*) FROM spotting s WHERE s.registration = w.registration) spotted, "
             "(SELECT thumb FROM spotting s WHERE s.registration = w.registration AND thumb IS NOT NULL ORDER BY date DESC LIMIT 1) thumb, "
             "(SELECT json_extract(data,'$.aircraft') FROM aircraft_cache c WHERE c.registration = w.registration) aircraft, "
             "(SELECT json_extract(data,'$.owner') FROM aircraft_cache c WHERE c.registration = w.registration) owner "
             "FROM watchlist w ORDER BY w.airborne DESC, w.registration")
    for r in rows:
        r["last_status"] = json.loads(r["last_status"] or "null")
        r["country"] = regs.country_of(r["registration"])
    return rows


@router.post("/api/watchlist")
def add_watch(body: WatchIn, bg: BackgroundTasks):
    reg = regs.normalize(body.registration)
    if not reg:
        raise HTTPException(422, "registration_required")
    if q1("SELECT 1 FROM watchlist WHERE registration = ?", (reg,)):
        raise HTTPException(409, "already_watched")
    hx = q1("SELECT icao24 FROM spotting WHERE registration = ? AND icao24 IS NOT NULL LIMIT 1", (reg,))
    cur = execute("INSERT INTO watchlist(registration, icao24, note, notify, created_at) VALUES(?,?,?,?,?)",
                  (reg, hx["icao24"] if hx else None, body.note, int(body.notify), now_iso()))
    bg.add_task(opensky.check_watchlist)
    return q1("SELECT * FROM watchlist WHERE id = ?", (cur.lastrowid,))


@router.put("/api/watchlist/{wid}")
def update_watch(wid: int, body: WatchIn):
    execute("UPDATE watchlist SET note=?, notify=? WHERE id=?", (body.note, int(body.notify), wid))
    return q1("SELECT * FROM watchlist WHERE id = ?", (wid,))


@router.delete("/api/watchlist/{wid}")
def delete_watch(wid: int):
    execute("DELETE FROM watchlist WHERE id = ?", (wid,))
    return {"deleted": wid}


@router.post("/api/watchlist/check")
def check_now():
    return {"alerts": opensky.check_watchlist(), "items": list_watch()}
