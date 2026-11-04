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
