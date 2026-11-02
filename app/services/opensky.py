"""OpenSky Network : radar en direct et suivi de la watchlist.

L'accès anonyme fonctionne (quota réduit). Avec un client API OpenSky
(OAuth2 client credentials), le quota augmente nettement.
"""
from __future__ import annotations

import json
import logging
import threading
import time

import httpx

from ..core import get_config, get_setting, now_iso, q, execute
from . import aircraft as ac
from .notify import notify, texts

log = logging.getLogger("contrail.opensky")

API = "https://opensky-network.org/api"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

_token: dict = {"value": None, "exp": 0.0}
_token_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}

STATE_FIELDS = ("icao24", "callsign", "origin_country", "time_position", "last_contact", "lng", "lat",
                "baro_alt", "on_ground", "velocity", "track", "vertical_rate", "sensors", "geo_alt",
                "squawk", "spi", "position_source", "category")


def _auth_headers(c: httpx.Client) -> dict:
    cid, secret = get_config("opensky_client_id"), get_config("opensky_client_secret")
    if not cid or not secret:
        return {}
    with _token_lock:
        if _token["value"] and _token["exp"] > time.time() + 30:
            return {"Authorization": f"Bearer {_token['value']}"}
        try:
            r = c.post(TOKEN_URL, data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret})
            r.raise_for_status()
            d = r.json()
            _token["value"], _token["exp"] = d["access_token"], time.time() + int(d.get("expires_in", 1800))
            return {"Authorization": f"Bearer {_token['value']}"}
        except (httpx.HTTPError, KeyError, ValueError) as e:
            log.warning("Jeton OpenSky indisponible : %s", e)
            return {}


def _states(params: list[tuple[str, str]]) -> dict:
    with ac.client() as c:
        r = c.get(f"{API}/states/all", params=params, headers=_auth_headers(c))
        if r.status_code == 429:
            return {"error": "rate_limited", "states": []}
        r.raise_for_status()
        data = r.json() or {}
    states = []
    for s in data.get("states") or []:
        d = dict(zip(STATE_FIELDS, s))
        d["callsign"] = (d.get("callsign") or "").strip() or None
        d["alt_m"] = d.get("geo_alt") if d.get("geo_alt") is not None else d.get("baro_alt")
        if d.get("lat") is None or d.get("lng") is None:
            continue
        states.append({k: d.get(k) for k in ("icao24", "callsign", "origin_country", "lat", "lng", "alt_m",
                                             "on_ground", "velocity", "track", "vertical_rate", "squawk",
                                             "category", "last_contact")})
    return {"time": data.get("time"), "states": states}


def radar(lamin: float, lomin: float, lamax: float, lomax: float) -> dict:
    key = f"{lamin:.1f},{lomin:.1f},{lamax:.1f},{lomax:.1f}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 8:
        return hit[1]
    res = _states([("lamin", f"{lamin:.4f}"), ("lomin", f"{lomin:.4f}"), ("lamax", f"{lamax:.4f}"),
                   ("lomax", f"{lomax:.4f}"), ("extended", "1")])
    # Enrichissement local : appareils de la watchlist et appareils déjà spottés
    watch = {r["icao24"]: r["registration"] for r in q("SELECT icao24, registration FROM watchlist WHERE icao24 IS NOT NULL")}
    spotted = {r["icao24"]: r["registration"] for r in q(
        "SELECT DISTINCT icao24, registration FROM spotting WHERE icao24 IS NOT NULL")}
    cached = {}
    for row in q("SELECT registration, json_extract(data,'$.icao24') hx FROM aircraft_cache WHERE hx IS NOT NULL"):
        cached[row["hx"]] = row["registration"]
    seen_regs = {r["registration"] for r in q("SELECT DISTINCT registration FROM spotting")}
    for s in res["states"]:
        hx = s["icao24"]
        reg = watch.get(hx) or spotted.get(hx) or cached.get(hx)
        s["registration"] = reg
        s["watch"] = hx in watch
        s["spotted"] = hx in spotted or (reg in seen_regs if reg else False)
    if len(_cache) > 50:
        _cache.clear()
    _cache[key] = (time.time(), res)
    return res


# --------------------------------------------------------------------------- #
# Watchlist
# --------------------------------------------------------------------------- #
def _airlabs_live(reg: str) -> dict | None:
    key = get_config("airlabs_api_key")
    if not key:
        return None
    try:
        with ac.client() as c:
            r = c.get("https://airlabs.co/api/v9/flights", params={"reg_number": reg, "api_key": key})
            resp = (r.json() or {}).get("response") or []
            return resp[0] if resp else None
    except (httpx.HTTPError, ValueError):
        return None


def check_watchlist() -> int:
    items = q("SELECT * FROM watchlist")
    if not items:
        return 0
    # Résolution des hex Mode-S manquants
    for it in items:
        if not it["icao24"]:
            try:
                info = ac.lookup(it["registration"])
                if info.get("icao24"):
                    it["icao24"] = info["icao24"]
                    execute("UPDATE watchlist SET icao24=? WHERE id=?", (info["icao24"], it["id"]))
            except Exception as e:  # noqa: BLE001
                log.info("Résolution hex impossible pour %s : %s", it["registration"], e)
    hexes = [it["icao24"] for it in items if it["icao24"]]
    live: dict[str, dict] = {}
    if hexes:
        try:
            res = _states([("icao24", h) for h in hexes])
            live = {s["icao24"]: s for s in res["states"]}
        except (httpx.HTTPError, ValueError) as e:
            log.info("OpenSky indisponible : %s", e)
            return 0
    homes = {h.upper() for h in (get_setting("home_airports") or [])}
    alerts = 0
    for it in items:
        st = live.get(it["icao24"] or "")
        airborne = bool(st and not st.get("on_ground"))
        status = {"checked_at": now_iso(), "airborne": airborne}
        if st:
            status.update({k: st.get(k) for k in ("callsign", "lat", "lng", "alt_m", "velocity", "track")})
            if st.get("callsign"):
                status["route"] = ac.hexdb_route(st["callsign"])
        flight = _airlabs_live(it["registration"]) if airborne else None
        if flight:
            status.update({"dep": flight.get("dep_icao"), "arr": flight.get("arr_icao"),
                           "flight": flight.get("flight_icao") or flight.get("flight_iata")})
        execute("UPDATE watchlist SET last_status=?, airborne=?, last_seen_at=COALESCE(?, last_seen_at) WHERE id=?",
                (json.dumps(status), int(airborne), now_iso() if st else None, it["id"]))
        if airborne and not it["airborne"] and it["notify"]:
            route = status.get("route") or (f"{status.get('dep')}-{status.get('arr')}" if status.get("dep") else "")
            detail = " · ".join(x for x in (status.get("callsign"), route) if x)
            arr = (status.get("arr") or (route.split("-")[-1] if route else "") or "").upper()
            if arr and arr in homes:
                title, body = texts("watch_home", reg=it["registration"], airport=arr, detail=detail)
            else:
                title, body = texts("watch_airborne", reg=it["registration"], detail=detail)
            notify("watchlist", title, body, f"#/airframe/{it['registration']}",
                   {"registration": it["registration"], **status})
            alerts += 1
    return alerts
