"""Remplissage automatique des données appareil.

Ordre des sources : historique local (spots précédents) -> cache -> hexdb.io (sans clé)
-> AirLabs (clé gratuite) -> Aviationstack (clé gratuite, expérimental).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

from ..core import APP_NAME, APP_VERSION, execute, get_config, now_iso, q1
from . import registration as regs

log = logging.getLogger("contrail.aircraft")

UA = {"User-Agent": f"{APP_NAME}/{APP_VERSION} (self-hosted spotting log)"}
TIMEOUT = httpx.Timeout(8.0, connect=5.0)
CACHE_DAYS = 30

FIELDS = ("registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner",
          "airline_icao", "icao24", "country", "military")


def _offline_handler(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("CONTRAIL_OFFLINE=1 : appels externes désactivés", request=request)


def client() -> httpx.Client:
    if os.environ.get("CONTRAIL_OFFLINE") == "1":
        return httpx.Client(transport=httpx.MockTransport(_offline_handler), headers=UA)
    return httpx.Client(timeout=TIMEOUT, headers=UA, follow_redirects=True)


def _clean(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


# --------------------------------------------------------------------------- #
# hexdb.io
# --------------------------------------------------------------------------- #
def hexdb_reg_to_hex(reg: str, c: httpx.Client) -> str | None:
    r = c.get("https://hexdb.io/reg-hex", params={"reg": reg})
    if r.status_code == 200:
        txt = r.text.strip()
        if txt and "n/a" not in txt.lower() and len(txt) <= 8:
            return txt.lower()
    return None


def hexdb_aircraft(hex_code: str, c: httpx.Client) -> dict | None:
    r = c.get(f"https://hexdb.io/api/v1/aircraft/{hex_code}")
    if r.status_code != 200:
        return None
    try:
        d = r.json()
    except ValueError:
        return None
    if not d or d.get("status") == "404":
        return None
    typ = _clean(d.get("Type"))
    manu = _clean(d.get("Manufacturer"))
    model = f"{manu} {typ}" if manu and typ and not typ.lower().startswith(manu.lower()) else (typ or manu)
    return {
        "registration": _clean(d.get("Registration")),
        "aircraft": model,
        "aircraft_icao": _clean(d.get("ICAOTypeCode")),
        "manufacturer": manu,
        "owner": _clean(d.get("RegisteredOwners")),
        "airline_icao": _clean(d.get("OperatorFlagCode")),
        "icao24": hex_code.lower(),
    }


def hexdb_route(callsign: str) -> str | None:
    try:
        with client() as c:
            r = c.get(f"https://hexdb.io/api/v1/route/icao/{callsign.strip()}")
            if r.status_code == 200:
                return (r.json() or {}).get("route")
    except (httpx.HTTPError, ValueError):
        return None
    return None


def by_icao24(icao24: str) -> dict | None:
    """Utilisé par le radar : hex Mode-S -> données appareil."""
    icao24 = icao24.lower().strip()
    from . import actypes, refdb
    ref = refdb.by_hex([icao24]).get(icao24)
    row = q1("SELECT data FROM aircraft_cache WHERE json_extract(data,'$.icao24') = ?", (icao24,))
    if row:
        return json.loads(row["data"])
    try:
        with client() as c:
            d = hexdb_aircraft(icao24, c)
    except httpx.HTTPError:
        d = None
    if not d and ref:
        return {"registration": ref.get("registration"), "aircraft_icao": ref.get("typecode"),
                "aircraft": ref.get("description") or actypes.name(ref.get("typecode")), "owner": ref.get("ownop"),
                "icao24": icao24, "country": regs.country_of(ref.get("registration"))}
    if d and d.get("registration"):
        d["country"] = regs.country_of(d["registration"])
        _store(regs.normalize(d["registration"]), d, "hexdb")
    return d


# --------------------------------------------------------------------------- #
# AirLabs / Aviationstack
# --------------------------------------------------------------------------- #
def airlabs_fleet_entry(reg: str, c: httpx.Client) -> dict | None:
    key = get_config("airlabs_api_key")
    if not key:
        return None
    r = c.get("https://airlabs.co/api/v9/fleets", params={"reg_number": reg, "api_key": key})
    if r.status_code != 200:
        return None
    resp = (r.json() or {}).get("response") or []
    if not resp:
        return None
    d = resp[0]
    model = _clean(d.get("model"))
    manu = _clean(d.get("manufacturer"))
    return {
        "registration": _clean(d.get("reg_number")),
        "aircraft": f"{manu.title()} {model}" if manu and model and manu.lower() not in model.lower() else model,
        "aircraft_icao": _clean(d.get("icao")),
        "manufacturer": manu.title() if manu else None,
        "msn": _clean(str(d.get("msn"))) if d.get("msn") else None,
        "airline_icao": _clean(d.get("airline_icao")),
        "icao24": (_clean(d.get("hex")) or "").lower() or None,
        "built": d.get("built"),
    }


def aviationstack_entry(reg: str, c: httpx.Client) -> dict | None:
    key = get_config("aviationstack_api_key")
    if not key:
        return None
    # Le plan gratuit d'Aviationstack n'accepte historiquement que HTTP.
    r = c.get("http://api.aviationstack.com/v1/airplanes", params={"access_key": key, "search": reg})
    if r.status_code != 200:
        return None
    for d in (r.json() or {}).get("data") or []:
        if regs.normalize(d.get("registration_number")) == regs.normalize(reg):
            return {
                "registration": _clean(d.get("registration_number")),
                "aircraft": _clean(d.get("model_name")),
                "aircraft_icao": _clean(d.get("iata_type")) if not d.get("model_code") else _clean(d.get("model_code")),
                "msn": _clean(d.get("construction_number")),
                "owner": _clean(d.get("plane_owner")),
                "icao24": (_clean(d.get("icao_code_hex")) or "").lower() or None,
            }
    return None


# --------------------------------------------------------------------------- #
# Cache & fusion
# --------------------------------------------------------------------------- #
def _store(reg: str, data: dict, source: str) -> None:
    execute(
        "INSERT INTO aircraft_cache(registration, data, source, fetched_at) VALUES(?,?,?,?) "
        "ON CONFLICT(registration) DO UPDATE SET data=excluded.data, source=excluded.source, "
        "fetched_at=excluded.fetched_at",
        (reg, json.dumps(data, ensure_ascii=False), source, now_iso()),
    )


def _from_history(reg: str) -> dict | None:
    row = q1(
        "SELECT registration, aircraft, aircraft_icao, manufacturer, msn, owner, airline_icao, icao24, "
        "military FROM spotting WHERE registration = ? ORDER BY date DESC LIMIT 1",
        (reg,),
    )
    if row:
        return {k: v for k, v in row.items() if v not in (None, "")}
    row = q1("SELECT registration, aircraft, aircraft_icao, airline FROM flights WHERE registration = ? "
             "ORDER BY date DESC LIMIT 1", (reg,))
    if row:
        return {"registration": reg, "aircraft": row["aircraft"], "aircraft_icao": row["aircraft_icao"],
                "owner": row["airline"]}
    return None


def lookup(reg_in: str, refresh: bool = False) -> dict:
    reg = regs.normalize(reg_in)
    result: dict = {"registration": reg, "country": regs.country_of(reg)}
    sources: list[str] = []

    hist = _from_history(reg)
    if hist:
        result.update({k: v for k, v in hist.items() if v not in (None, "")})
        sources.append("history")

    cached = q1("SELECT data, fetched_at FROM aircraft_cache WHERE registration = ?", (reg,))
    fresh = False
    if cached and not refresh:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"].replace("Z", "+00:00"))
            fresh = age < timedelta(days=CACHE_DAYS)
        except ValueError:
            fresh = False
        for k, v in json.loads(cached["data"]).items():
            if v not in (None, "") and not result.get(k):
                result[k] = v
        sources.append("cache")

    # Base de référence locale (hors-ligne) : Mode-S, type, opérateur
    from . import actypes, refdb
    ref = refdb.by_reg(reg)
    if ref:
        local = {"icao24": ref.get("icao24"), "aircraft_icao": ref.get("typecode"),
                 "aircraft": ref.get("description") or actypes.name(ref.get("typecode")), "owner": ref.get("ownop"),
                 "msn": refdb.msn_of(ref.get("icao24")), "built": ref.get("year")}
        if ref.get("military"):
            local["military"] = 1
        for k, v in local.items():
            if v not in (None, "") and not result.get(k):
                result[k] = v
        sources.append("refdb")

    if not fresh:
        remote: dict = {}
        used: list[str] = []
        try:
            with client() as c:
                try:
                    hx = hexdb_reg_to_hex(reg, c)
                    if hx:
                        d = hexdb_aircraft(hx, c) or {"icao24": hx}
                        remote.update({k: v for k, v in d.items() if v})
                        used.append("hexdb")
                except (httpx.HTTPError, ValueError) as e:
                    log.info("hexdb indisponible: %s", e)
                for name, fn in (("airlabs", airlabs_fleet_entry), ("aviationstack", aviationstack_entry)):
                    try:
                        d = fn(reg, c)
                    except (httpx.HTTPError, ValueError) as e:
                        log.info("%s indisponible: %s", name, e)
                        d = None
                    if d:
                        for k, v in d.items():
                            if v and not remote.get(k):
                                remote[k] = v
                        used.append(name)
        except httpx.HTTPError:
            pass
        if remote:
            remote["registration"] = reg
            remote["country"] = regs.country_for(reg, remote.get("owner"))
            _store(reg, remote, "+".join(used))
            for k, v in remote.items():
                if v not in (None, "") and not result.get(k):
                    result[k] = v
            sources.extend(used)

    if not result.get("country"):
        result["country"] = regs.country_for(reg, result.get("owner"))
    if "military" not in result:
        result["military"] = 1 if regs.looks_military(result.get("owner"), result.get("aircraft")) else 0
    result["sources"] = sources
    result["found"] = any(result.get(k) for k in ("aircraft", "aircraft_icao", "owner", "msn"))
    return result
