"""Collection & flottes : compagnies observées, flottes (AirLabs paginé, base locale, import manuel), complétion."""
from __future__ import annotations

import csv
import io
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import db, execute, get_config, now_iso, q, q1
from ..services import actypes, refdb
from ..services import aircraft as ac
from ..services import registration as regs

router = APIRouter(tags=["fleets"])

AIRLABS_PAGE_MAX = 500     # limite des clés payantes ; les clés gratuites sont plafonnées à 50 lignes
MAX_PAGES = 80             # garde-fou : 4 000 appareils avec une clé gratuite


def _airline_groups() -> list[dict]:
    return q("SELECT COALESCE(airline_icao, owner) AS key, MAX(airline_icao) icao, MAX(owner) name, COUNT(*) spots, "
             "COUNT(DISTINCT registration) regs, MAX(date) last FROM spotting "
             "WHERE COALESCE(airline_icao, owner) IS NOT NULL AND military = 0 GROUP BY key ORDER BY regs DESC")


def _active_fleet(key: str) -> str:
    return ("FROM fleets f WHERE f.airline_key = ? AND NOT EXISTS (SELECT 1 FROM fleet_exclusions x "
            "WHERE x.airline_key = f.airline_key AND x.registration = f.registration)")


@router.get("/api/fleets")
def fleets_overview():
    groups = {g["key"]: g for g in _airline_groups()}
    meta = {r["key"]: r for r in q("SELECT * FROM airlines")}
    stats = {r["airline_key"]: r for r in q(
        "SELECT f.airline_key, COUNT(*) n, SUM(CASE WHEN EXISTS (SELECT 1 FROM spotting s WHERE s.registration = f.registration) "
        "THEN 1 ELSE 0 END) seen FROM fleets f WHERE NOT EXISTS (SELECT 1 FROM fleet_exclusions x WHERE x.airline_key = f.airline_key "
        "AND x.registration = f.registration) GROUP BY f.airline_key")}
    keys = list(groups) + [k for k in meta if k not in groups]
    out = []
    for k in keys:
        g = groups.get(k, {"key": k, "icao": meta.get(k, {}).get("icao"), "name": None, "spots": 0, "regs": 0, "last": None})
        m = meta.get(k, {})
        st = stats.get(k) or {}
        size, seen = st.get("n"), st.get("seen") or 0
        out.append({**g, "name": m.get("name") or g.get("name") or k, "iata": m.get("iata"), "fleet_size": size,
                    "fleet_seen": seen, "completion": round(seen / size, 4) if size else None,
                    "fleet_source": m.get("fleet_source"), "fleet_fetched_at": m.get("fleet_fetched_at")})
    return out


def _family(row: dict) -> str:
    return (actypes.family(row.get("aircraft_icao"), row.get("aircraft"))
            or actypes.name(row.get("aircraft_icao")) or row.get("aircraft") or "?")


@router.get("/api/fleets/{key}")
def fleet_detail(key: str):
    meta = q1("SELECT * FROM airlines WHERE key = ?", (key,)) or {"key": key}
    fleet = q("SELECT f.registration, f.aircraft, f.aircraft_icao, f.status, f.icao24, f.built, f.source, "
              "(SELECT COUNT(*) FROM spotting s WHERE s.registration = f.registration) AS spotted, "
              "(SELECT thumb FROM spotting s WHERE s.registration = f.registration AND thumb IS NOT NULL "
              "ORDER BY date DESC LIMIT 1) AS thumb " + _active_fleet(key) + " ORDER BY f.registration", (key,))
    for f in fleet:
        f["family"] = _family(f)
        f["cls"] = actypes.classify(f.get("aircraft_icao"), None, f.get("aircraft"))
    fleet.sort(key=lambda f: (f["family"], f["registration"]))
    excluded = q("SELECT f.registration, f.aircraft, f.aircraft_icao FROM fleets f JOIN fleet_exclusions x "
                 "ON x.airline_key = f.airline_key AND x.registration = f.registration WHERE f.airline_key = ? "
                 "ORDER BY f.registration", (key,))
    spotted = q("SELECT registration, MAX(aircraft) aircraft, MAX(aircraft_icao) aircraft_icao, COUNT(*) n, MAX(date) last, "
                "(SELECT thumb FROM spotting s2 WHERE s2.registration = s.registration AND thumb IS NOT NULL ORDER BY date DESC LIMIT 1) thumb "
                "FROM spotting s WHERE COALESCE(airline_icao, owner) = ? GROUP BY registration ORDER BY aircraft, registration", (key,))
    by_type: dict = {}
    for f in fleet:
        b = by_type.setdefault(f["family"], {"type": f["family"], "code": f.get("aircraft_icao"), "total": 0, "seen": 0})
        b["total"] += 1
        b["seen"] += 1 if f["spotted"] else 0
    name = (meta.get("name")
            or (q1("SELECT MAX(owner) n FROM spotting WHERE COALESCE(airline_icao, owner) = ?", (key,)) or {}).get("n") or key)
    in_ref = 0
    if refdb.available():
        known = {f["registration"] for f in fleet} | {x["registration"] for x in excluded}
        in_ref = sum(1 for r in refdb.by_operator(name, meta.get("icao")) if r.get("registration") and r["registration"] not in known)
    return {"key": key, "name": name, "meta": meta, "fleet": fleet, "spotted": spotted, "excluded": excluded,
            "by_type": sorted(by_type.values(), key=lambda b: (-b["total"], b["type"])),
            "airlabs": bool(get_config("airlabs_api_key")), "refdb_candidates": in_ref}


class FetchOptions(BaseModel):
    include_light: bool = False
    replace: bool = True


def _airlabs_pages(icao: str, api_key: str) -> list[dict]:
    rows: list[dict] = []
    limit = AIRLABS_PAGE_MAX
    with ac.client() as c:
        for _ in range(MAX_PAGES):
            r = c.get("https://airlabs.co/api/v9/fleets",
                      params={"airline_icao": icao, "api_key": api_key, "limit": limit, "offset": len(rows)},
                      timeout=httpx.Timeout(30, connect=10))
            data = r.json() or {}
            if data.get("error"):
                msg = str(data["error"].get("message", ""))
                # Clé gratuite : on retombe sur des pages de 50 lignes
                if limit > 50 and ("limit" in msg.lower() or data["error"].get("code") in ("wrong_params", "limit_exceeded")):
                    limit = 50
                    continue
                raise HTTPException(502, msg or "airlabs_error")
            page = data.get("response") or []
            rows.extend(page)
            req = data.get("request") or {}
            has_more = req.get("has_more")
            if has_more is None:
                has_more = len(page) >= min(limit, 50) and len(page) > 0
            if not page or not has_more:
                break
            if len(page) < limit:
                limit = len(page)  # la clé est plafonnée : on adopte la taille de page réelle
    return rows


def _is_light(a: dict) -> bool:
    if (a.get("type") or "").lower() in ("helicopter", "gyrocopter"):
        return True
    if (a.get("engine") or "").lower() == "piston":
        return True
    return actypes.classify(a.get("icao"), None, a.get("model")) in actypes.LIGHT_CLASSES


@router.post("/api/fleets/{key}/fetch")
def fleet_fetch(key: str, opts: FetchOptions | None = None):
    opts = opts or FetchOptions()
    api_key = get_config("airlabs_api_key")
    if not api_key:
        raise HTTPException(400, "airlabs_key_required")
    icao = key.upper()
    if not re.fullmatch(r"[A-Z]{3}", icao):
        raise HTTPException(400, "icao_required")
    try:
        fleet = _airlabs_pages(icao, api_key)
        with ac.client() as c:
            info = c.get("https://airlabs.co/api/v9/airlines", params={"icao_code": icao, "api_key": api_key}).json()
    except httpx.HTTPError as e:
        raise HTTPException(502, "airlabs_unreachable") from e
    airline = ((info or {}).get("response") or [{}])[0]
    conn = db()
    if opts.replace:
        conn.execute("DELETE FROM fleets WHERE airline_key = ? AND COALESCE(source, 'airlabs') = 'airlabs'", (key,))
    kept = skipped = 0
    seen: set[str] = set()
    for a in fleet:
        reg = regs.normalize(a.get("reg_number"))
        if not reg or reg in seen:
            continue
        seen.add(reg)
        if not opts.include_light and _is_light(a):
            skipped += 1
            continue
        model = a.get("model") or a.get("icao")
        conn.execute("INSERT OR REPLACE INTO fleets(airline_key, registration, aircraft, aircraft_icao, icao24, built, status, source) "
                     "VALUES(?,?,?,?,?,?,?,?)",
                     (key, reg, model, (a.get("icao") or "").upper() or None, (a.get("hex") or "").lower() or None,
                      str(a.get("built") or "") or None, a.get("status"), "airlabs"))
        kept += 1
    conn.execute("INSERT INTO airlines(key, icao, iata, name, fleet_source, fleet_fetched_at) VALUES(?,?,?,?,?,?) "
                 "ON CONFLICT(key) DO UPDATE SET icao=excluded.icao, iata=excluded.iata, "
                 "name=COALESCE(excluded.name, airlines.name), fleet_source=excluded.fleet_source, "
                 "fleet_fetched_at=excluded.fleet_fetched_at",
                 (key, icao, airline.get("iata_code"), airline.get("name"), "airlabs", now_iso()))
    conn.commit()
    return {**fleet_detail(key), "fetch": {"received": len(fleet), "kept": kept, "skipped_light": skipped}}


@router.post("/api/fleets/{key}/complete-local")
def fleet_complete_local(key: str):
    """Ajoute les appareils de la base de référence locale dont l'opérateur correspond à la compagnie."""
    if not refdb.available():
        raise HTTPException(400, "refdb_missing")
    d = fleet_detail(key)
    known = {f["registration"] for f in d["fleet"]} | {x["registration"] for x in d["excluded"]}
    added = 0
    conn = db()
    for r in refdb.by_operator(d["name"], d["meta"].get("icao")):
        reg = r.get("registration")
        if not reg or reg in known:
            continue
        if actypes.classify(r.get("typecode"), None, r.get("description")) in actypes.LIGHT_CLASSES:
            continue
        conn.execute("INSERT OR IGNORE INTO fleets(airline_key, registration, aircraft, aircraft_icao, icao24, source) VALUES(?,?,?,?,?,?)",
                     (key, reg, r.get("description") or actypes.name(r.get("typecode")), r.get("typecode"), r.get("icao24"), "refdb"))
        added += 1
    conn.execute("INSERT INTO airlines(key, name, fleet_source, fleet_fetched_at) VALUES(?,?,?,?) "
                 "ON CONFLICT(key) DO UPDATE SET fleet_source=COALESCE(airlines.fleet_source, excluded.fleet_source), "
                 "fleet_fetched_at=excluded.fleet_fetched_at", (key, d["name"], "refdb", now_iso()))
    conn.commit()
    return {**fleet_detail(key), "added": added}


class FleetImport(BaseModel):
    text: str
    name: str | None = None
    replace: bool = True


@router.post("/api/fleets/{key}/import")
def fleet_import(key: str, body: FleetImport):
    """Import manuel : une immatriculation par ligne, éventuellement suivie du type (CSV ou tabulation)."""
    rows = []
    for line in csv.reader(io.StringIO(body.text.replace("\t", ",").replace(";", ","))):
        if not line:
            continue
        reg = regs.normalize(line[0])
        if reg and reg.lower() not in ("registration", "reg", "immatriculation"):
            typ = (line[1].strip() if len(line) > 1 else None) or None
            code = typ.upper() if typ and re.fullmatch(r"[A-Za-z0-9]{3,4}", typ) and actypes.name(typ) else None
            rows.append((reg, typ, code))
    if not rows:
        raise HTTPException(422, "empty_fleet")
    conn = db()
    if body.replace:
        conn.execute("DELETE FROM fleets WHERE airline_key = ?", (key,))
    for reg, typ, code in rows:
        conn.execute("INSERT OR REPLACE INTO fleets(airline_key, registration, aircraft, aircraft_icao, source) VALUES(?,?,?,?,?)",
                     (key, reg, typ, code, "manual"))
    conn.execute("INSERT INTO airlines(key, icao, name, fleet_source, fleet_fetched_at) VALUES(?,?,?,?,?) "
                 "ON CONFLICT(key) DO UPDATE SET name=COALESCE(excluded.name, airlines.name), "
                 "fleet_source='manual', fleet_fetched_at=excluded.fleet_fetched_at",
                 (key, key.upper() if re.fullmatch(r"[A-Za-z]{3}", key) else None, body.name, "manual", now_iso()))
    conn.commit()
    return fleet_detail(key)


class Exclusion(BaseModel):
    registration: str


@router.post("/api/fleets/{key}/exclude")
def fleet_exclude(key: str, body: Exclusion):
    execute("INSERT OR IGNORE INTO fleet_exclusions(airline_key, registration, created_at) VALUES(?,?,?)",
            (key, regs.normalize(body.registration), now_iso()))
    return fleet_detail(key)


@router.delete("/api/fleets/{key}/exclude/{reg}")
def fleet_include(key: str, reg: str):
    execute("DELETE FROM fleet_exclusions WHERE airline_key = ? AND registration = ?", (key, regs.normalize(reg)))
    return fleet_detail(key)


@router.delete("/api/fleets/{key}")
def fleet_delete(key: str):
    execute("DELETE FROM fleets WHERE airline_key = ?", (key,))
    execute("DELETE FROM fleet_exclusions WHERE airline_key = ?", (key,))
    execute("UPDATE airlines SET fleet_source=NULL, fleet_fetched_at=NULL WHERE key=?", (key,))
    return {"ok": True}
