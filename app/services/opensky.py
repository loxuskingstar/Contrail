"""OpenSky Network : radar en direct et suivi de la watchlist.

L'accès anonyme fonctionne (quota réduit). Avec un client API OpenSky
(OAuth2 client credentials), le quota augmente nettement. Quand le quota est épuisé (429), le radar
bascule automatiquement sur des agrégateurs ADS-B gratuits (adsb.lol, airplanes.live).
"""
from __future__ import annotations

import json
import logging
import threading
import time

import httpx

from ..core import get_config, get_setting, now_iso, q, execute
from . import actypes, refdb, wishes
from . import aircraft as ac
from .notify import notify, texts

log = logging.getLogger("contrail.opensky")

API = "https://opensky-network.org/api"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

_token: dict = {"value": None, "exp": 0.0}
_token_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
_failed_until = 0.0   # OpenSky en panne ou lent : on passe directement aux sources gratuites pendant 60 s
_last_error = ""       # dernière cause d'échec des sources gratuites (affichée dans l'interface)
_last_warn = 0.0
_tile_cache: dict[str, tuple[float, str, list[dict]]] = {}
_blocked_until = 0.0  # OpenSky a répondu 429 : on le laisse tranquille jusqu'à cette date (secondes epoch)

# Sources ADS-B communautaires gratuites, sans clé, au format « readsb » (point + rayon en milles nautiques)
FREE_SOURCES = (("adsb.lol", "https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/{r}"),
                ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat:.4f}/lon/{lon:.4f}/dist/{r}"),
                ("airplanes.live", "https://api.airplanes.live/v2/point/{lat:.4f}/{lon:.4f}/{r}"))
MIN_GAP = 1.05   # ces services limitent à ~1 requête par seconde et par client
_src_off: dict[str, tuple[float, int]] = {}   # source -> (pause jusqu'à, code HTTP) après 429/403
_src_last: dict[str, float] = {}
_src_lock = {name: threading.Lock() for name, _ in FREE_SOURCES}


def _throttle(name: str) -> None:
    with _src_lock[name]:
        wait = _src_last.get(name, 0.0) + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _src_last[name] = time.time()

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


def _states(params: list[tuple[str, str]], timeout: float | None = None) -> dict:
    with ac.client() as c:
        r = c.get(f"{API}/states/all", params=params, headers=_auth_headers(c), **({"timeout": timeout} if timeout else {}))
        if r.status_code == 429:
            global _blocked_until
            try:
                wait = int(r.headers.get("X-Rate-Limit-Retry-After-Seconds", 600))
            except ValueError:
                wait = 600
            _blocked_until = time.time() + min(max(wait, 30), 6 * 3600)
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


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


OPENSKY_MAX_AREA = 100  # degrés carrés (au-delà : 3 à 4 crédits par requête)
MAX_TILES = 9
TILE_DEG = 5.8  # un disque de 250 nm (maximum accepté) couvre une tuile de ~5,8° de côté


def _tiles(lamin: float, lomin: float, lamax: float, lomax: float) -> list[tuple[float, float, float, float]]:
    """Découpe la zone en tuiles couvrables chacune par un disque de 250 nm."""
    import math

    mid = (lamin + lamax) / 2
    rows = max(1, math.ceil((lamax - lamin) / TILE_DEG))
    cols = max(1, math.ceil((lomax - lomin) * max(math.cos(math.radians(mid)), 0.1) / TILE_DEG))
    if rows * cols > MAX_TILES:
        raise ValueError("area_too_large")
    dla, dlo = (lamax - lamin) / rows, (lomax - lomin) / cols
    return [(lamin + i * dla, lomin + j * dlo, lamin + (i + 1) * dla, lomin + (j + 1) * dlo)
            for i in range(rows) for j in range(cols)]


def _free_tile(lamin: float, lomin: float, lamax: float, lomax: float, start: int = 0) -> tuple[str, list[dict]]:
    import math

    lat, lon = (lamin + lamax) / 2, (lomin + lomax) / 2
    dlat_nm = (lamax - lamin) / 2 * 60
    dlon_nm = (lomax - lomin) / 2 * 60 * max(math.cos(math.radians(lat)), 0.1)
    radius = max(5, min(250, math.ceil(math.hypot(dlat_nm, dlon_nm))))
    errs: list[str] = []
    order = FREE_SOURCES[start % len(FREE_SOURCES):] + FREE_SOURCES[:start % len(FREE_SOURCES)]
    for name, tpl in order:
        off = _src_off.get(name)
        if off and off[0] > time.time():
            errs.append(f"{name} : en pause (HTTP {off[1]})")
            continue
        try:
            _throttle(name)
            with ac.client() as c:
                r = c.get(tpl.format(lat=lat, lon=lon, r=radius), timeout=6)
                if r.status_code >= 400:
                    errs.append(f"{name} : HTTP {r.status_code}")
                    if r.status_code in (403, 429):
                        # 429 : trop de requêtes, on laisse souffler la source ; 403 : refus, on réessaie plus tard
                        _src_off[name] = (time.time() + (45 if r.status_code == 429 else 600), r.status_code)
                    continue
                data = r.json() or {}
        except httpx.HTTPError as e:
            errs.append(f"{name} : {type(e).__name__} {str(e)[:80]}".strip())
            continue
        except ValueError:
            errs.append(f"{name} : réponse illisible")
            continue
        states = []
        for a in data.get("ac") or data.get("aircraft") or []:
            la, lo = _num(a.get("lat")), _num(a.get("lon"))
            hx = (a.get("hex") or "").lower().lstrip("~")
            if la is None or lo is None or not hx or not (lamin <= la <= lamax and lomin <= lo <= lomax):
                continue
            alt = a.get("alt_geom") if _num(a.get("alt_geom")) is not None else a.get("alt_baro")
            ground = alt == "ground"
            alt_ft = _num(alt)
            states.append({
                "icao24": hx, "callsign": (a.get("flight") or "").strip() or None,
                "origin_country": None, "lat": la, "lng": lo,
                "alt_m": round(alt_ft * 0.3048, 1) if alt_ft is not None else (0 if ground else None),
                "on_ground": ground,
                "velocity": round(a["gs"] * 0.514444, 1) if _num(a.get("gs")) is not None else None,
                "track": _num(a.get("track")),
                "vertical_rate": round((_num(a.get("baro_rate")) or _num(a.get("geom_rate")) or 0) * 0.00508, 1),
                "squawk": a.get("squawk"), "category": None, "last_contact": None})
        return name, states
    raise httpx.HTTPError(" ; ".join(errs))


def _free_tile_cached(tile: tuple[float, float, float, float], start: int = 0) -> tuple[str, list[dict]] | None:
    """Une tuile, avec cache de 8 s ; en cas d'échec, la dernière version connue (moins de 2 min) ; sinon None."""
    key = ",".join(f"{v:.1f}" for v in tile)
    hit = _tile_cache.get(key)
    if hit and time.time() - hit[0] < 8:
        return hit[1], hit[2]
    try:
        name, sts = _free_tile(*tile, start=start)
    except (httpx.HTTPError, ValueError) as e:
        global _last_error, _last_warn
        _last_error = str(e) or type(e).__name__
        if time.time() - _last_warn > 60:
            _last_warn = time.time()
            log.warning("Radar : sources gratuites indisponibles (%s) : %s", key, _last_error)
        return (hit[1], hit[2]) if hit and time.time() - hit[0] < 120 else None
    if len(_tile_cache) > 200:
        _tile_cache.clear()
    _tile_cache[key] = (time.time(), name, sts)
    return name, sts


def _free_states(lamin: float, lomin: float, lamax: float, lomax: float) -> dict:
    """Radar de secours (et vues très larges) : agrégateurs ADS-B gratuits, une requête par tuile.

    Tolérant aux pannes partielles : une tuile manquante n'invalide pas les autres (champ `partial`)."""
    from concurrent.futures import ThreadPoolExecutor

    tiles = _tiles(lamin, lomin, lamax, lomax)
    with ThreadPoolExecutor(max_workers=min(3, len(tiles))) as ex:
        parts = list(ex.map(lambda it: _free_tile_cached(it[1], it[0]), enumerate(tiles)))  # tuiles réparties sur les sources
    ok = [p for p in parts if p]
    if not ok:
        raise httpx.HTTPError(_last_error or "sources gratuites indisponibles")
    seen: dict[str, dict] = {}
    for _, sts in ok:
        for st in sts:
            seen[st["icao24"]] = st
    return {"time": int(time.time()), "states": list(seen.values()), "source": ok[0][0],
            "partial": len(parts) - len(ok)}


def radar(lamin: float, lomin: float, lamax: float, lomax: float) -> dict:
    key = f"{lamin:.1f},{lomin:.1f},{lamax:.1f},{lomax:.1f}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 8:
        raw = hit[1]
    else:
        raw = None
        wide = (lamax - lamin) * (lomax - lomin) > OPENSKY_MAX_AREA  # vue large : sources gratuites, on épargne les crédits OpenSky
        global _failed_until
        if time.time() >= max(_blocked_until, _failed_until) and not wide:
            try:
                raw = _states([("lamin", f"{lamin:.4f}"), ("lomin", f"{lomin:.4f}"), ("lamax", f"{lamax:.4f}"),
                               ("lomax", f"{lomax:.4f}"), ("extended", "1")], timeout=5)
            except (httpx.HTTPError, ValueError) as e:
                _failed_until = time.time() + 60
                log.info("OpenSky indisponible, bascule sur une source gratuite : %s", e)
        if raw is None or raw.get("error") == "rate_limited":
            raw = _free_states(lamin, lomin, lamax, lomax)  # lève httpx.HTTPError si tout est en panne
        if len(_cache) > 50:
            _cache.clear()
        _cache[key] = (time.time(), raw)
    # Copie : l'enrichissement dépend du profil (données réelles ou session de test)
    res = {"time": raw.get("time"), "error": raw.get("error"), "source": raw.get("source", "opensky"), "partial": raw.get("partial", 0), "states": [dict(s) for s in raw["states"]]}
    watch = {r["icao24"]: r["registration"] for r in q("SELECT icao24, value registration FROM wishes WHERE kind='aircraft' AND status='open' AND icao24 IS NOT NULL")}
    wish_match = wishes.radar_matcher()
    spotted = {r["icao24"]: r["registration"] for r in q(
        "SELECT DISTINCT icao24, registration FROM spotting WHERE icao24 IS NOT NULL")}
    cached = {r["hx"]: r for r in q(
        "SELECT registration, json_extract(data,'$.icao24') hx, json_extract(data,'$.aircraft_icao') typ "
        "FROM aircraft_cache WHERE hx IS NOT NULL")}
    seen_regs = {r["registration"] for r in q("SELECT DISTINCT registration FROM spotting")}
    ref = refdb.by_hex([s["icao24"] for s in res["states"]])
    for s in res["states"]:
        hx = s["icao24"]
        r = ref.get(hx) or {}
        c = cached.get(hx) or {}
        reg = watch.get(hx) or spotted.get(hx) or c.get("registration") or r.get("registration")
        typ = c.get("typ") or r.get("typecode")
        s["registration"] = reg
        s["type"] = typ
        s["desc"] = r.get("description")
        s["cls"] = actypes.classify(typ, s.get("category"), r.get("description"))
        s["military"] = bool(r.get("military"))
        s["watch"] = hx in watch
        w = wish_match(hx, reg, typ, s.get("callsign"))
        s["wish"] = {"id": w["id"], "title": w["title"], "kind": w["kind"]} if w else None
        s["spotted"] = hx in spotted or (reg in seen_regs if reg else False)
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
    items = [dict(w, registration=w["value"]) for w in wishes.tracked()]
    if not items:
        return 0
    # Résolution des hex Mode-S manquants
    for it in items:
        if not it["icao24"]:
            try:
                info = ac.lookup(it["registration"])
                if info.get("icao24"):
                    it["icao24"] = info["icao24"]
                    execute("UPDATE wishes SET icao24=? WHERE id=?", (info["icao24"], it["id"]))
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
        execute("UPDATE wishes SET last_status=?, airborne=?, last_seen_at=COALESCE(?, last_seen_at) WHERE id=?",
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
