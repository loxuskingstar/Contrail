"""Module « Mes vols » : carnet de vols personnels, carte grand cercle, références croisées."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import execute, get_settings, now_iso, q, q1
from ..services import actypes, collection, gamification, geo
from ..services import registration as regs
from ..services.notify import notify, texts

router = APIRouter(prefix="/api/flights", tags=["flights"])


class FlightIn(BaseModel):
    date: str
    dep_icao: str
    arr_icao: str
    dep_time: str | None = None
    arr_time: str | None = None
    flight_number: str | None = None
    airline: str | None = None
    airline_icao: str | None = None
    registration: str | None = None
    aircraft: str | None = None
    aircraft_icao: str | None = None
    seat: str | None = None
    seat_type: str | None = None
    cabin_class: str | None = None
    reason: str | None = None
    duration_min: int | None = None
    notes: str | None = None


def _duration(date: str, dep: str, arr: str, t1: str | None, t2: str | None) -> int | None:
    """Durée bloc à partir des heures locales de départ/arrivée et des fuseaux des aéroports."""
    if not t1 or not t2:
        return None
    from datetime import datetime, timedelta

    u1 = geo.local_to_utc(f"{date[:10]}T{t1[:5]}", dep)
    u2 = geo.local_to_utc(f"{date[:10]}T{t2[:5]}", arr)
    if not u1 or not u2:
        return None
    d1 = datetime.fromisoformat(u1.replace("Z", "+00:00"))
    d2 = datetime.fromisoformat(u2.replace("Z", "+00:00"))
    while d2 <= d1:
        d2 += timedelta(days=1)
    mins = int((d2 - d1).total_seconds() // 60)
    return mins if mins < 24 * 60 else None


def prepare(f: FlightIn) -> dict:
    d = {k: (v.strip() if isinstance(v, str) else v) for k, v in f.model_dump().items()}
    d = {k: (None if v == "" else v) for k, v in d.items()}
    d["dep_icao"] = geo.resolve_icao(d["dep_icao"])
    d["arr_icao"] = geo.resolve_icao(d["arr_icao"])
    if not d["dep_icao"] or not d["arr_icao"]:
        raise HTTPException(422, "airports_required")
    if d.get("registration"):
        d["registration"] = regs.normalize(d["registration"])
    for k in ("flight_number", "airline_icao", "aircraft_icao"):
        if d.get(k):
            d[k] = d[k].upper().replace(" ", "")
    d["distance_km"] = geo.route_distance_km(d["dep_icao"], d["arr_icao"])
    if not d.get("duration_min"):
        d["duration_min"] = _duration(d["date"], d["dep_icao"], d["arr_icao"], d.get("dep_time"), d.get("arr_time"))
    return d


def enrich(rows: list[dict]) -> list[dict]:
    spotted = {r["registration"]: r["n"] for r in q("SELECT registration, COUNT(*) n FROM spotting GROUP BY registration")}
    for r in rows:
        for side in ("dep", "arr"):
            a = geo.airport(r[f"{side}_icao"])
            r[f"{side}_info"] = {k: a[k] for k in ("icao", "iata", "name", "city", "country", "lat", "lng")} if a else None
        r["spotted_count"] = spotted.get(r.get("registration") or "", 0)
    return rows


@router.get("")
def list_flights(year: str = "", search: str = ""):
    where, params = ["1=1"], []
    if year:
        where.append("substr(date,1,4) = ?")
        params.append(year)
    if search:
        like = f"%{search}%"
        where.append("(flight_number LIKE ? OR airline LIKE ? OR registration LIKE ? OR dep_icao LIKE ? "
                     "OR arr_icao LIKE ? OR aircraft LIKE ?)")
        params += [like] * 6
    rows = q(f"SELECT * FROM flights WHERE {' AND '.join(where)} ORDER BY date DESC, dep_time DESC", params)
    enrich(rows)
    total_km = sum(r["distance_km"] or 0 for r in rows)
    total_min = sum(r["duration_min"] or 0 for r in rows)
    airports = {r["dep_icao"] for r in rows} | {r["arr_icao"] for r in rows}
    return {"items": rows, "summary": {
        "count": len(rows), "km": round(total_km), "minutes": total_min, "airports": len(airports),
        "earth_laps": round(total_km / 40075, 2),
        "countries": len({(r["dep_info"] or {}).get("country") for r in rows} | {(r["arr_info"] or {}).get("country") for r in rows} - {None}),
        "years": sorted({r["date"][:4] for r in rows}, reverse=True),
    }}


@router.get("/{flight_id}")
def get_flight(flight_id: int):
    r = q1("SELECT * FROM flights WHERE id_flight = ?", (flight_id,))
    if not r:
        raise HTTPException(404, "not_found")
    enrich([r])
    r["spots"] = collection.crossref_for_flight(r["registration"]) if r.get("registration") else []
    r["context"] = _context(r)
    return r


def _context(r: dict) -> dict:
    """Mise en perspective d'un vol : rang chronologique, route, compagnie, type, appareil, voisins."""
    key = (r["date"], r.get("dep_time") or "", r["id_flight"])
    order = "(date < ? OR (date = ? AND COALESCE(dep_time,'') < ?) OR (date = ? AND COALESCE(dep_time,'') = ? AND id_flight < ?))"
    before = (key[0], key[0], key[1], key[0], key[1], key[2])

    def nth(extra: str = "", params: tuple = ()) -> dict:
        n = q1(f"SELECT COUNT(*) n FROM flights WHERE {order}{extra}", before + params)["n"] + 1
        tot = q1(f"SELECT COUNT(*) n FROM flights WHERE 1=1{extra}", params)["n"]
        return {"n": n, "total": tot}

    ctx = {"overall": nth(),
           "route": nth(" AND ((dep_icao = ? AND arr_icao = ?) OR (dep_icao = ? AND arr_icao = ?))",
                        (r["dep_icao"], r["arr_icao"], r["arr_icao"], r["dep_icao"])),
           "year": nth(" AND substr(date,1,4) = ?", (r["date"][:4],))}
    if r.get("airline_icao") or r.get("airline"):
        ctx["airline"] = nth(" AND COALESCE(airline_icao, airline) = ?", (r.get("airline_icao") or r.get("airline"),))
    if r.get("aircraft_icao") or r.get("aircraft"):
        ctx["type"] = nth(" AND mk(aircraft_icao, aircraft) = ?", (actypes.model_key(r.get("aircraft_icao"), r.get("aircraft")),))
    if r.get("registration"):
        ctx["airframe"] = nth(" AND registration = ?", (r["registration"],))
    prev = q1(f"SELECT id_flight, dep_icao, arr_icao, date FROM flights WHERE {order} "
              "ORDER BY date DESC, COALESCE(dep_time,'') DESC, id_flight DESC LIMIT 1", before)
    after = (key[0], key[0], key[1], key[0], key[1], key[2])
    nxt = q1("SELECT id_flight, dep_icao, arr_icao, date FROM flights WHERE (date > ? OR (date = ? AND COALESCE(dep_time,'') > ?) "
             "OR (date = ? AND COALESCE(dep_time,'') = ? AND id_flight > ?)) ORDER BY date, COALESCE(dep_time,''), id_flight LIMIT 1", after)
    ctx["prev"], ctx["next"] = prev, nxt
    # Heures UTC et vitesse moyenne
    if r.get("dep_time"):
        ctx["dep_utc"] = geo.local_to_utc(f"{r['date'][:10]}T{r['dep_time'][:5]}", r["dep_icao"])
    if r.get("arr_time"):
        ctx["arr_utc"] = geo.local_to_utc(f"{r['date'][:10]}T{r['arr_time'][:5]}", r["arr_icao"])
    if r.get("distance_km") and r.get("duration_min"):
        ctx["speed_kmh"] = round(r["distance_km"] / (r["duration_min"] / 60))
    for side in ("dep", "arr"):
        a = geo.airport(r[f"{side}_icao"])
        if a and r.get(f"{side}_info") is not None:
            r[f"{side}_info"]["tz"] = a.get("tz")
    # Déjà spotté à l'un des deux aéroports ?
    ctx["spots_at"] = {c: q1("SELECT COUNT(*) n FROM spotting WHERE airport = ?", (c,))["n"] for c in {r["dep_icao"], r["arr_icao"]}}
    return ctx


def _after(reg: str | None, flight_id: int, is_new: bool) -> dict:
    extra = {"crossref": [], "achievements": []}
    if reg and is_new:
        spots = collection.crossref_for_flight(reg)
        if spots:
            extra["crossref"] = spots
            title, body = texts("crossref_flight", reg=reg, n=len(spots))
            notify("crossref", title, body, f"#/airframe/{reg}", {"registration": reg, "flight": flight_id})
    if get_settings()["modules"].get("gamification", True):
        extra["achievements"] = gamification.evaluate()
    return extra


@router.post("")
def create_flight(f: FlightIn):
    d = prepare(f)
    d["created_at"] = d["updated_at"] = now_iso()
    cur = execute(f"INSERT INTO flights({', '.join(d)}) VALUES({', '.join('?' * len(d))})", list(d.values()))
    return {"flight": get_flight(cur.lastrowid), **_after(d.get("registration"), cur.lastrowid, True)}


@router.put("/{flight_id}")
def update_flight(flight_id: int, f: FlightIn):
    old = q1("SELECT registration FROM flights WHERE id_flight = ?", (flight_id,))
    if not old:
        raise HTTPException(404, "not_found")
    d = prepare(f)
    d["updated_at"] = now_iso()
    execute(f"UPDATE flights SET {', '.join(f'{k}=?' for k in d)} WHERE id_flight=?", list(d.values()) + [flight_id])
    reg_changed = d.get("registration") and d.get("registration") != old["registration"]
    return {"flight": get_flight(flight_id), **_after(d.get("registration"), flight_id, bool(reg_changed))}


@router.delete("/{flight_id}")
def delete_flight(flight_id: int):
    from ..services import trash
    row = q1("SELECT * FROM flights WHERE id_flight = ?", (flight_id,))
    if not row:
        raise HTTPException(404, "not_found")
    tid = trash.put("flight", [row]) if trash.enabled() else []
    execute("DELETE FROM flights WHERE id_flight = ?", (flight_id,))
    return {"deleted": flight_id, "trash": tid[0] if tid else None}
