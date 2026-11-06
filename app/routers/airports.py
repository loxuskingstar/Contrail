"""Pages par aéroport : fréquentation, appareils vus, points de vue, sorties."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..core import memo, q, q1
from ..services import collection, geo, refdb
from .spots import LIST_COLS, decorate

router = APIRouter(prefix="/api/airport-pages", tags=["airports"])

SPECIAL = "livery_category IS NOT NULL AND livery_category NOT IN ('primer', 'white')"


def _list(_search: str = ""):
    rows = q(f"SELECT airport icao, COUNT(*) n, COUNT(DISTINCT registration) regs, MIN(date) first_at, MAX(date) last_at, "
             f"SUM(CASE WHEN {SPECIAL} THEN 1 ELSE 0 END) specials FROM spotting "
             f"WHERE airport IS NOT NULL AND airport <> '' GROUP BY airport ORDER BY n DESC")
    for r in rows:
        a = geo.airport(r["icao"]) or {}
        r.update({"name": a.get("name"), "city": a.get("city"), "country": a.get("country"), "iata": a.get("iata"),
                  "lat": a.get("lat"), "lng": a.get("lng")})
    return rows


@router.get("")
def list_airports():
    return {"items": memo("airports", _list)}


def _detail(icao: str):
    st = q1(f"SELECT COUNT(*) n, COUNT(DISTINCT registration) regs, COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, "
            f"MIN(date) first_at, MAX(date) last_at, SUM(favorite) favs, SUM(military) military, "
            f"SUM(CASE WHEN {SPECIAL} THEN 1 ELSE 0 END) specials FROM spotting WHERE airport = ?", (icao,))
    if not st or not st["n"]:
        return None
    tops = lambda sql: q(sql, (icao,))
    st["top_types"] = tops("SELECT COALESCE(aircraft_icao, aircraft) k, COUNT(*) n FROM spotting WHERE airport = ? AND "
                           "COALESCE(aircraft_icao, aircraft) IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8")
    st["top_airlines"] = tops("SELECT owner k, COUNT(*) n FROM spotting WHERE airport = ? AND owner IS NOT NULL AND owner <> '' "
                              "GROUP BY owner ORDER BY n DESC LIMIT 8")
    st["by_year"] = tops("SELECT substr(date, 1, 4) k, COUNT(*) n FROM spotting WHERE airport = ? AND date IS NOT NULL "
                         "GROUP BY k ORDER BY k")
    st["by_month"] = [{"m": int(r["m"]), "n": r["n"]} for r in tops(
        "SELECT substr(date, 6, 2) m, COUNT(*) n FROM spotting WHERE airport = ? AND date IS NOT NULL GROUP BY m ORDER BY m")]
    st["top_regs"] = tops("SELECT registration, COALESCE(aircraft_icao, aircraft) type, COUNT(*) n FROM spotting WHERE airport = ? "
                          "AND registration NOT LIKE 'SANS-IMMAT-%' GROUP BY registration ORDER BY n DESC, registration LIMIT 6")
    best = q1("SELECT o.id_outing id, o.day, o.name, COUNT(*) n FROM outings o JOIN spotting s ON s.outing_id = o.id_outing "
              "WHERE o.airport = ? GROUP BY o.id_outing ORDER BY n DESC, o.day DESC LIMIT 1", (icao,))
    st["best_outing"] = best
    tc = refdb.type_counts()
    seen = {r["t"]: r["n"] for r in q("SELECT aircraft_icao t, COUNT(*) n FROM spotting WHERE airport = ? AND aircraft_icao IS NOT NULL "
                                      "GROUP BY aircraft_icao", (icao,))}
    tiers: dict[str, int] = {}
    for t_, n_ in seen.items():
        tier = collection.rarity_tier(tc.get(t_))
        if tier:
            tiers[tier] = tiers.get(tier, 0) + 1
    st["rarity"] = tiers
    st["rare_types"] = sorted(((t_, tc[t_]) for t_ in seen if collection.rarity_tier(tc.get(t_)) in collection.RARE_TIERS), key=lambda x: x[1])[:6]
    st["first_regs"] = tops("SELECT registration, COALESCE(aircraft_icao, aircraft) type, MIN(date) d FROM spotting WHERE airport = ? "
                            "GROUP BY registration ORDER BY d DESC LIMIT 6")
    st["locations"] = q("SELECT l.id_location id, l.name, l.lat, l.lng, l.view_bearing, l.best_time, (SELECT COUNT(*) FROM spotting s "
                        "WHERE s.location_id = l.id_location) n FROM spot_locations l WHERE l.airport = ? ORDER BY n DESC, l.name", (icao,))
    st["outings"] = q("SELECT o.id_outing id, o.day, o.name, COUNT(s.id_spotting) n FROM outings o "
                      "JOIN spotting s ON s.outing_id = o.id_outing WHERE o.airport = ? GROUP BY o.id_outing "
                      "ORDER BY o.day DESC, o.id_outing DESC LIMIT 8", (icao,))
    st["n_outings"] = (q1("SELECT COUNT(DISTINCT outing_id) n FROM spotting WHERE airport = ? AND outing_id IS NOT NULL", (icao,)) or {}).get("n", 0)
    rows = q(f"SELECT {LIST_COLS} FROM spotting s WHERE s.airport = ? ORDER BY COALESCE(s.date, s.created_at) DESC, s.id_spotting DESC LIMIT 12", (icao,))
    st["recent"] = decorate(rows)
    return st


@router.get("/{code}")
def get_airport(code: str):
    a = geo.airport(code)
    icao = a["icao"] if a else code.strip().upper()
    d = memo("airport", _detail, icao)
    if d is None and not a:
        raise HTTPException(404, "Aéroport inconnu")
    return {"icao": icao, "info": a, **(d or {"n": 0, "regs": 0, "types": 0, "top_types": [], "top_airlines": [], "by_year": [],
                                              "by_month": [], "first_regs": [], "locations": [], "outings": [], "n_outings": 0, "recent": [], "top_regs": [], "best_outing": None,
                                              "rarity": {}, "rare_types": []})}
