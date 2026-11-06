"""Aéroports (base hors-ligne airportsdata), géodésie et position du soleil."""
from __future__ import annotations

import math
import unicodedata
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import airportsdata


# --------------------------------------------------------------------------- #
# Aéroports
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def _core() -> dict[str, dict]:
    return airportsdata.load("ICAO")


CODE_OVERRIDES: dict[str, str] = {}      # identifiant OurAirports → code SIA, pour les correspondances confirmées à la main

_KIND = {"H": "heliport", "A": "airfield", "S": "seaplane", "B": "balloonport"}


@lru_cache(maxsize=1)
def _extra() -> tuple[dict[str, dict], dict[str, str]]:
    """Hélistations, altisurfaces, bases ULM et terrains que airportsdata ignore (OurAirports, domaine public).
    Renvoie (terrains par code, alias → code) : LF3624 (code SIA) désigne le terrain FR-0442 d'OurAirports."""
    import gzip
    import json
    from pathlib import Path
    f = Path(__file__).resolve().parents[2] / "static" / "data" / "airfields_extra.json.gz"
    if not f.is_file():
        return {}, {}
    rows: dict[str, dict] = {}
    alias: dict[str, str] = {}
    for code, kind, name, lat, lon, elev, country, city, al in json.loads(gzip.decompress(f.read_bytes())):
        if "-" in code and al and not (len(al) <= 3 and al.isalpha()):   # FR-0442 → LF3624 : on retient le code que les pilotes et le SIA utilisent
            alias[code] = al
            code = al
            al = ""
        if len(code) <= 3 and code.isalpha():      # codes locaux à trois lettres : ils entreraient en collision avec les codes IATA
            continue
        rows[code] = {"icao": code, "iata": "", "name": name, "city": city or "", "country": country, "lat": lat, "lon": lon,
                      "elevation": elev, "tz": "", "kind": _KIND.get(kind, "airfield")}
        if al:
            alias[al] = code
    # codes SIA absents d'OurAirports, confirmés à la main
    for old, new in CODE_OVERRIDES.items():
        if old in rows:
            rows[new] = {**rows.pop(old), "icao": new}
            alias[old] = new
    return rows, alias


@lru_cache(maxsize=1)
def _airports() -> dict[str, dict]:
    """Base complète : aéroports + hélistations et petits terrains."""
    return {**_extra()[0], **_core()}


@lru_cache(maxsize=1)
def _iata_index() -> dict[str, str]:
    return {a["iata"]: icao for icao, a in _airports().items() if a.get("iata")}


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


@lru_cache(maxsize=1)
def _search_index() -> list[tuple[str, str]]:
    al = {v: k for k, v in _extra()[1].items()}

    def words(a: dict) -> str:
        # noms OurAirports en anglais : on ajoute les mots qu'on tape en français (hôpital, hélistation, altiport…)
        n, k = a["name"].lower(), a.get("kind", "")
        extra = []
        if k == "heliport":
            extra.append("heliport helistation helipad dzh")
        if "hospital" in n:
            extra.append("hopital chu centre hospitalier clinique")
        if "altiport" in n or "altisurface" in n:
            extra.append("altiport altisurface montagne")
        if "ultralight" in n:
            extra.append("ulm base ulm")
        if "seaplane" in n or k == "seaplane":
            extra.append("hydrobase hydravion")
        return " ".join(extra)

    return [(icao, _fold(f"{icao} {al.get(icao, '')} {a.get('iata','')} {a['name']} {a['city']} {words(a)}")) for icao, a in _airports().items()]


def _load_custom() -> dict[str, dict]:
    from ..core import q
    try:
        rows = q("SELECT * FROM custom_airfields")
    except Exception:  # noqa: BLE001 — base pas encore migrée
        return {}
    return {r["code"]: {"icao": r["code"], "iata": "", "name": r["name"], "city": r["city"] or "", "country": r["country"] or "",
                        "lat": r["lat"], "lon": r["lng"], "elevation": r["elevation_ft"], "tz": "", "kind": r["kind"], "custom": True}
            for r in rows}


def custom() -> dict[str, dict]:
    """Terrains ajoutés par l'utilisateur (propres à chaque profil), prioritaires sur les bases embarquées."""
    from ..core import memo
    return memo("custom_airfields", _load_custom)


def airport(code: str | None) -> dict | None:
    if not code:
        return None
    c = code.strip().upper()
    a = custom().get(c) or _airports().get(c)
    if a is None and len(c) == 3:
        icao = _iata_index().get(c)
        a = _airports().get(icao) if icao else None
    if a is None and len(c) > 3:          # anciens identifiants (FR-0442 → LF3624) ; jamais pour 3 lettres, réservées à l'IATA
        a = _airports().get(_extra()[1].get(c, ""))
    if a is None:
        return None
    return {
        "icao": a["icao"], "iata": a.get("iata") or None, "name": a["name"], "city": a["city"],
        "country": a["country"], "lat": a["lat"], "lng": a["lon"], "tz": a.get("tz") or tz_at(a["lat"], a["lon"]),
        "elevation_ft": a.get("elevation"), "kind": a.get("kind", "airport"), "custom": bool(a.get("custom")),
    }


def resolve_icao(code: str | None) -> str | None:
    a = airport(code)
    return a["icao"] if a else (code.strip().upper() if code else None)


def search_places(query: str, lang: str = "fr", limit: int = 8) -> list[dict]:
    """Villes et localités (Open-Meteo Geocoding, sans clé) pour situer un spot hors aéroport. Renvoie [] hors ligne."""
    from .aircraft import client
    q = query.strip()
    if len(q) < 2:
        return []
    try:
        with client() as c:
            r = c.get("https://geocoding-api.open-meteo.com/v1/search",
                      params={"name": q, "count": limit, "language": lang if lang in ("fr", "en", "es", "ja") else "en", "format": "json"})
            r.raise_for_status()
            rows = r.json().get("results") or []
    except Exception:  # noqa: BLE001 — réseau, quota ou service indisponible : on propose seulement les aéroports
        return []
    out = []
    for x in rows:
        name = x.get("name")
        # Le département (ou, à défaut, la région) distingue les homonymes : « Saint-Pierre (Manche) » ≠ « Saint-Pierre (Cantal) »
        sub = next((v for v in (x.get("admin2"), x.get("admin1")) if v and v != name), None)
        label = ", ".join(p for p in (f"{name} ({sub})" if sub else name, x.get("country")) if p)
        detail = " · ".join(dict.fromkeys(p for p in (x.get("admin2"), x.get("admin1"), x.get("country")) if p and p != name))
        out.append({"label": label, "name": name, "detail": detail, "lat": x.get("latitude"), "lng": x.get("longitude"),
                    "country": x.get("country_code"), "tz": x.get("timezone")})
    return out


def tz_at(lat: float | None, lng: float | None) -> str:
    """Fuseau horaire d'un point : celui de l'aéroport le plus proche (aucune base de fuseaux embarquée)."""
    if lat is None or lng is None:
        return "UTC"
    best, best_d = None, 1e9
    for a in _core().values():
        if abs(a["lat"] - lat) > 6 or abs(a["lon"] - lng) > 8:    # préfiltre : l'essentiel de la planète est écarté sans calcul
            continue
        d = haversine_km(lat, lng, a["lat"], a["lon"])
        if d < best_d and a.get("tz"):
            best, best_d = a, d
    return best["tz"] if best else "UTC"


def search_airports(query: str, limit: int = 12) -> list[dict]:
    qf = _fold(query.strip())
    if not qf:
        return []
    exact = airport(query)
    results: list[dict] = [exact] if exact else []
    seen = {exact["icao"]} if exact else set()
    tokens = qf.split()
    for icao, a in custom().items():
        if icao not in seen and all(t in _fold(f"{icao} {a['name']} {a['city']}") for t in tokens):
            results.append(airport(icao))
            seen.add(icao)
    scored = []
    for icao, hay in _search_index():
        if icao in seen:
            continue
        if all(t in hay for t in tokens):
            # Les codes et les débuts de mots passent devant.
            score = 0 if hay.startswith(qf) else (1 if f" {qf}" in hay else 2)
            scored.append((score, icao not in _core(), icao))     # aéroports avant hélistations et terrains de même pertinence
    scored.sort()
    for _, _, icao in scored[: limit - len(results)]:
        results.append(airport(icao))
    return results


def local_to_utc(local_iso: str | None, icao: str | None, fallback_tz: str = "UTC") -> str | None:
    """Convertit une heure locale d'aéroport ("YYYY-MM-DDTHH:MM") en UTC ISO."""
    if not local_iso:
        return None
    try:
        dt = datetime.fromisoformat(local_iso.replace("Z", ""))
    except ValueError:
        return None
    a = airport(icao)
    tzname = a["tz"] if a else fallback_tz
    try:
        tz = ZoneInfo(tzname)
    except Exception:  # noqa: BLE001 - fuseau inconnu
        tz = timezone.utc
    return dt.replace(tzinfo=tz).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# Géodésie
# --------------------------------------------------------------------------- #
EARTH_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def route_distance_km(dep: str, arr: str) -> float | None:
    a, b = airport(dep), airport(arr)
    if not a or not b:
        return None
    return round(haversine_km(a["lat"], a["lng"], b["lat"], b["lng"]), 1)


# --------------------------------------------------------------------------- #
# Position du soleil (algorithme NOAA simplifié, précision ~0,1°)
# --------------------------------------------------------------------------- #
def sun_position(lat: float, lng: float, when: datetime) -> tuple[float, float]:
    """Retourne (azimut en degrés depuis le nord, élévation en degrés)."""
    when = when.astimezone(timezone.utc)
    jd = when.timestamp() / 86400.0 + 2440587.5
    t = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    mr = math.radians(m)
    c = (math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * mr) * (0.019993 - 0.000101 * t) + math.sin(3 * mr) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * t
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(eps)) * math.sin(math.radians(app_long))))
    y = math.tan(math.radians(eps / 2)) ** 2
    l0r = math.radians(l0)
    eq_time = 4 * math.degrees(
        y * math.sin(2 * l0r) - 2 * e * math.sin(mr) + 4 * e * y * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * y * y * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * mr)
    )
    minutes = when.hour * 60 + when.minute + when.second / 60
    tst = (minutes + eq_time + 4 * lng) % 1440
    ha = tst / 4 - 180
    latr, declr, har = math.radians(lat), math.radians(decl), math.radians(ha)
    cos_zen = math.sin(latr) * math.sin(declr) + math.cos(latr) * math.cos(declr) * math.cos(har)
    zen = math.degrees(math.acos(max(-1.0, min(1.0, cos_zen))))
    elev = 90 - zen
    # Réfraction atmosphérique approximative
    if elev > -0.575:
        te = math.tan(math.radians(elev)) if elev < 85 else 0
        if elev > 5 and te:
            elev += (58.1 / te - 0.07 / te**3 + 0.000086 / te**5) / 3600
        elif elev > -0.575:
            elev += (1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))) / 3600
    az_den = math.cos(latr) * math.sin(math.radians(zen))
    if abs(az_den) > 1e-6:
        az_rad = (math.sin(latr) * math.cos(math.radians(zen)) - math.sin(declr)) / az_den
        az_rad = max(-1.0, min(1.0, az_rad))
        az = 180 - math.degrees(math.acos(az_rad))
        if ha > 0:
            az = -az
        az = (az + 360) % 360
    else:
        az = 180.0 if lat > 0 else 0.0
    return round(az, 1), round(elev, 2)


def _ang_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def sun_day(lat: float, lng: float, day: datetime, tzname: str, view_bearing: float | None,
            step_min: int = 10) -> dict:
    """Course du soleil sur une journée et créneaux où le soleil est dans le dos du spotter."""
    try:
        tz = ZoneInfo(tzname)
    except Exception:  # noqa: BLE001
        tz = timezone.utc
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    samples, windows, golden = [], [], []
    current = None
    gcur = None
    sunrise = sunset = None
    prev_elev = None
    for i in range(0, 24 * 60, step_min):
        t = start + timedelta(minutes=i)
        az, el = sun_position(lat, lng, t)
        hhmm = t.strftime("%H:%M")
        samples.append({"t": hhmm, "az": az, "el": el})
        if prev_elev is not None:
            if prev_elev < -0.833 <= el and sunrise is None:
                sunrise = hhmm
            if prev_elev >= -0.833 > el:
                sunset = hhmm
        prev_elev = el
        good = False
        if view_bearing is not None and el > 4:
            # Soleil dans le dos : l'azimut du soleil est opposé à la direction de visée.
            good = _ang_diff(az, (view_bearing + 180) % 360) <= 70
        if good and current is None:
            current = {"start": hhmm, "end": hhmm, "best_diff": 999}
        if good:
            current["end"] = hhmm
            diff = _ang_diff(az, (view_bearing + 180) % 360)
            if diff < current["best_diff"]:
                current["best_diff"], current["best"] = diff, hhmm
        elif current is not None:
            windows.append(current)
            current = None
        is_golden = -4 <= el <= 8
        if is_golden and gcur is None:
            gcur = {"start": hhmm, "end": hhmm}
        if is_golden:
            gcur["end"] = hhmm
        elif gcur is not None:
            golden.append(gcur)
            gcur = None
    if current:
        windows.append(current)
    if gcur:
        golden.append(gcur)
    for w in windows:
        w.pop("best_diff", None)
    return {"date": start.strftime("%Y-%m-%d"), "tz": tzname, "sunrise": sunrise, "sunset": sunset,
            "windows": windows, "golden": golden, "samples": samples}


def best_time_summary(lat: float, lng: float, tzname: str, view_bearing: float | None) -> str | None:
    """Résumé saisonnier compact : 'AM' / 'PM' / 'AM+PM' selon les solstices et équinoxes."""
    if view_bearing is None:
        return None
    year = datetime.now().year
    parts = []
    for month, label in ((3, "mar"), (6, "jun"), (9, "sep"), (12, "dec")):
        res = sun_day(lat, lng, datetime(year, month, 21), tzname, view_bearing, step_min=15)
        spans = [f"{w['start']}–{w['end']}" for w in res["windows"]]
        parts.append(f"{label}: {', '.join(spans) if spans else '—'}")
    return " · ".join(parts)


def sun_elevation_at(lat: float | None, lng: float | None, utc_iso: str | None) -> float | None:
    if lat is None or lng is None or not utc_iso:
        return None
    try:
        dt = datetime.fromisoformat(utc_iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return sun_position(lat, lng, dt)[1]
