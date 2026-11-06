"""Succès (achievements) : séries à paliers, métriques, rangs et déblocage.

Chaque série suit une métrique (spots, types différents, km volés…) et comporte plusieurs paliers,
du plus accessible au plus difficile. Un palier est un succès à part entière (code « série_seuil »),
avec une rareté (bronze → diamant) qui rapporte des points ; le total des points donne un rang.
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from functools import lru_cache

from ..core import STATIC_DIR, db, get_setting, memo, now_iso, q, q1
from . import actypes, geo
from .notify import notify, texts

TIERS = ["bronze", "silver", "gold", "platinum", "diamond"]
POINTS = {"bronze": 10, "silver": 20, "gold": 40, "platinum": 80, "diamond": 150}
RANKS = [(0, "novice"), (100, "observer"), (300, "spotter"), (700, "confirmed"), (1500, "expert"),
         (3000, "master"), (5000, "ace"), (8000, "legend")]

# série, métrique, paliers, icône, catégorie, raretés imposées (sinon réparties du bronze au diamant)
SERIES: list[tuple[str, str, list[int], str, str, list[str] | None]] = [
    # --- Spotting
    ("spots", "spots", [1, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000], "📸", "spotting", None),
    ("regs", "regs", [5, 25, 50, 100, 250, 500, 1000, 2500], "🔢", "spotting", None),
    ("days", "days", [3, 10, 25, 50, 100, 200, 365], "📅", "spotting", None),
    ("big_day", "big_day", [10, 25, 50, 100], "⚡", "spotting", ["silver", "gold", "platinum", "diamond"]),
    ("streak", "streak", [3, 7, 14, 30], "🔥", "spotting", ["bronze", "gold", "platinum", "diamond"]),
    ("year_round", "year_round", [4, 8, 12], "🗓️", "spotting", ["bronze", "silver", "platinum"]),
    ("spots_year", "spots_year", [50, 200, 500, 1000], "📈", "spotting", ["silver", "gold", "platinum", "diamond"]),
    ("loyal", "max_same_reg", [3, 5, 10, 25], "🔁", "spotting", ["bronze", "silver", "gold", "platinum"]),
    ("photos", "photos", [1, 25, 100, 500, 1000, 2500], "🖼️", "spotting", None),
    ("favorites", "favorites", [1, 10, 50], "⭐", "spotting", ["bronze", "silver", "gold"]),
    # --- Collection
    ("types", "types", [5, 10, 25, 50, 75, 100, 150, 200], "✈️", "collection", None),
    ("airlines", "airlines", [5, 10, 25, 50, 100, 200, 300], "🎨", "collection", None),
    ("countries", "countries", [3, 10, 25, 50, 75, 100, 130], "🌍", "collection", None),
    ("manufacturers", "manufacturers", [3, 5, 10, 20, 30], "🏭", "collection", ["bronze", "silver", "gold", "platinum", "diamond"]),
    ("liveries", "special_liveries", [1, 5, 10, 25, 50, 100], "✨", "collection", None),
    ("livery_kinds", "livery_kinds", [3, 5], "🎭", "collection", ["silver", "gold"]),
    ("primer", "primers", [1, 3, 5, 10, 20], "🟩", "collection", None),
    ("white", "whites", [1, 3, 5, 10, 20], "⬜", "collection", None),
    ("military", "military", [1, 10, 50, 100, 250], "🎖️", "collection", None),
    ("heavies", "heavies", [1, 10, 50, 100, 250], "🐋", "collection", None),
    ("queens", "queens", [1, 5, 25], "👑", "collection", ["silver", "gold", "platinum"]),
    ("a380", "a380", [1, 10, 50], "🛬", "collection", ["silver", "gold", "diamond"]),
    ("helicopters", "helicopters", [1, 10, 50], "🚁", "collection", ["bronze", "silver", "gold"]),
    ("bizjets", "bizjets", [1, 10, 50, 100], "💼", "collection", ["bronze", "silver", "gold", "platinum"]),
    ("props", "props", [1, 10, 50, 100], "🌀", "collection", ["bronze", "silver", "gold", "platinum"]),
    ("light", "light", [1, 10, 50], "🛩️", "collection", ["bronze", "silver", "gold"]),
    ("fighters", "fighters", [1, 5, 25], "⚔️", "collection", ["silver", "gold", "platinum"]),
    ("oddities", "oddities", [1, 3], "🎈", "collection", ["gold", "platinum"]),
    ("alphabet", "alphabet", [10, 20, 26], "🔤", "collection", ["bronze", "gold", "platinum"]),
    ("fleet_half", "fleet_half", [1, 5], "📊", "collection", ["gold", "platinum"]),
    ("fleet_complete", "fleet_complete", [1, 3, 10], "🧩", "collection", ["gold", "platinum", "diamond"]),
    # --- Terrain
    ("wishes", "wishes_done", [1, 5, 10, 25, 50], "🎯", "field", None),
    ("airports", "airports", [1, 5, 10, 25, 50, 100], "📍", "field", None),
    ("abroad", "airport_countries", [2, 5, 10, 20, 40], "🧳", "field", None),
    ("globe", "airport_span", [500, 2000, 5000, 10000, 18000], "🌐", "field", None),
    ("locations", "locations", [1, 3, 10, 25], "🔭", "field", ["bronze", "silver", "gold", "platinum"]),
    ("gps", "gps", [10, 100, 500], "🛰️", "field", ["bronze", "silver", "gold"]),
    ("night", "night", [1, 10, 50, 200], "🌙", "field", None),
    ("golden", "golden", [1, 10, 50, 200, 500], "🌅", "field", None),
    ("early", "early", [1, 10, 50], "🐦", "field", ["bronze", "silver", "gold"]),
    ("late", "late", [1, 10, 50], "🦉", "field", ["bronze", "silver", "gold"]),
    ("bad_weather", "bad_weather", [1, 10, 50, 100], "🌧️", "field", None),
    ("windy", "windy", [1, 10, 25], "🌬️", "field", ["silver", "gold", "platinum"]),
    ("audio", "audio", [1, 10, 50], "🎧", "field", ["bronze", "silver", "gold"]),
    # --- Vols
    ("flights", "flights", [1, 5, 10, 25, 50, 100, 250, 500], "🎫", "flights", None),
    ("flight_km", "flight_km", [1000, 10000, 40075, 100000, 384400, 768800], "🌏", "flights", None),
    ("flight_hours", "flight_hours", [10, 50, 100, 250, 500, 1000], "⏱️", "flights", None),
    ("flight_airports", "flight_airports", [5, 10, 25, 50, 100], "🛫", "flights", None),
    ("flight_countries", "flight_countries", [3, 10, 25, 50], "🗺️", "flights", ["bronze", "silver", "gold", "platinum"]),
    ("flight_airlines", "flight_airlines", [3, 10, 25, 50], "🏷️", "flights", ["bronze", "silver", "gold", "platinum"]),
    ("flight_types", "flight_types", [3, 10, 25, 40], "🛩️", "flights", ["bronze", "silver", "gold", "platinum"]),
    ("long_haul", "longest_flight", [1500, 5000, 9000, 13000], "🌙", "flights", ["bronze", "silver", "gold", "platinum"]),
    ("cabins", "cabins", [2, 3, 4], "💺", "flights", ["silver", "gold", "platinum"]),
    ("full_circle", "flown_spotted", [1, 5, 25], "🔄", "flights", ["silver", "gold", "platinum"]),
]

# Anciens codes (≤ v1.3) → nouveaux : les déblocages sont conservés
LEGACY = {
    "first_spot": "spots_1", "spots_10": "spots_10", "spots_100": "spots_100", "spots_500": "spots_500",
    "spots_1000": "spots_1000", "regs_50": "regs_50", "regs_250": "regs_250", "types_10": "types_10",
    "types_25": "types_25", "types_50": "types_50", "airlines_10": "airlines_10", "airlines_50": "airlines_50",
    "countries_10": "countries_10", "countries_30": "countries_25", "airports_5": "airports_5", "airports_20": "airports_10",
    "livery_1": "liveries_1", "livery_10": "liveries_10", "military_1": "military_1", "military_10": "military_10",
    "night_5": "night_1", "golden_10": "golden_10", "early_bird": "early_1", "big_day": "big_day_25",
    "loyal_5": "loyal_5", "audio_1": "audio_1", "full_circle": "full_circle_1", "flights_1": "flights_1",
    "flights_25": "flights_25", "flights_100": "flights_100", "km_earth": "flight_km_40075", "km_moon": "flight_km_384400",
    "fleet_complete": "fleet_complete_1", "locations_3": "locations_3",
}


def _tier(series_tiers: list[str] | None, i: int, n: int) -> str:
    if series_tiers:
        return series_tiers[min(i, len(series_tiers) - 1)]
    if n == 1:
        return "gold"
    return TIERS[round(i * (len(TIERS) - 1) / (n - 1))]


def _definitions() -> list[dict]:
    out = []
    for series, metric, thresholds, icon, cat, tiers in SERIES:
        for i, n in enumerate(thresholds):
            tier = _tier(tiers, i, len(thresholds))
            out.append({"code": f"{series}_{n}", "series": series, "metric": metric, "target": n, "icon": icon,
                        "category": cat, "tier": tier, "points": POINTS[tier], "level": i + 1, "levels": len(thresholds)})
    return out


DEFINITIONS = _definitions()
BY_CODE = {d["code"]: d for d in DEFINITIONS}


# --------------------------------------------------------------------------- #
# Métriques
# --------------------------------------------------------------------------- #
def _n(sql: str, params: tuple = ()) -> float:
    r = q1(sql, params) or {}
    v = next(iter(r.values()), None) if r else None
    return v or 0


def _max_streak(days: list[str]) -> int:
    best = cur = 0
    prev: date | None = None
    for d in sorted({x for x in days if x}):
        try:
            dd = date.fromisoformat(d)
        except ValueError:
            continue
        cur = cur + 1 if prev and dd - prev == timedelta(days=1) else 1
        best = max(best, cur)
        prev = dd
    return best


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def metrics() -> dict[str, float]:
    """Mesures des succès, mémorisées tant que les données (et le jour) ne changent pas — lecture seule."""
    return memo("metrics", lambda d: _metrics(), date.today().isoformat())


def _metrics() -> dict[str, float]:
    m: dict[str, float] = {}
    r = q1(
        "SELECT COUNT(*) spots, COUNT(DISTINCT known(registration)) regs, "
        "COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, "
        "COUNT(DISTINCT CASE WHEN military = 0 THEN opg(airline_icao, owner) END) airlines, "
        "COUNT(DISTINCT NULLIF(airport,'')) airports, COUNT(DISTINCT country) countries, "
        "COUNT(DISTINCT NULLIF(manufacturer,'')) manufacturers, "
        "SUM(CASE WHEN livery_category IS NOT NULL AND livery_category NOT IN ('primer', 'white') THEN 1 ELSE 0 END) special_liveries, "
        "COUNT(DISTINCT CASE WHEN livery_category NOT IN ('primer', 'white') THEN livery_category END) livery_kinds, "
        "COUNT(DISTINCT CASE WHEN livery_category = 'primer' THEN registration END) primers, "
        "COUNT(DISTINCT CASE WHEN livery_category = 'white' THEN registration END) whites, "
        "COUNT(DISTINCT CASE WHEN military = 1 THEN registration END) military, "
        "SUM(CASE WHEN sun_elevation < -6 THEN 1 ELSE 0 END) night, "
        "SUM(CASE WHEN sun_elevation BETWEEN -4 AND 8 THEN 1 ELSE 0 END) golden, "
        "SUM(CASE WHEN length(date) >= 16 AND substr(date, 12, 5) < '07:00' THEN 1 ELSE 0 END) early, "
        "SUM(CASE WHEN length(date) >= 16 AND substr(date, 12, 5) >= '22:00' THEN 1 ELSE 0 END) late, "
        "SUM(CASE WHEN atc_audio IS NOT NULL THEN 1 ELSE 0 END) audio, "
        "SUM(CASE WHEN image IS NOT NULL THEN 1 ELSE 0 END) photos, "
        "SUM(favorite) favorites, SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) gps, "
        "COUNT(DISTINCT substr(date,1,10)) days FROM spotting"
    ) or {}
    m.update({k: v or 0 for k, v in r.items()})
    m["max_same_reg"] = _n("SELECT MAX(n) FROM (SELECT COUNT(*) n FROM spotting GROUP BY registration)")
    m["big_day"] = _n("SELECT MAX(n) FROM (SELECT COUNT(*) n FROM spotting WHERE date IS NOT NULL GROUP BY substr(date,1,10))")
    m["spots_year"] = _n("SELECT MAX(n) FROM (SELECT COUNT(*) n FROM spotting WHERE date IS NOT NULL GROUP BY substr(date,1,4))")
    m["year_round"] = _n("SELECT MAX(n) FROM (SELECT COUNT(DISTINCT substr(date,6,2)) n FROM spotting WHERE date IS NOT NULL "
                         "GROUP BY substr(date,1,4))")
    m["streak"] = _max_streak([r["d"] for r in q("SELECT DISTINCT substr(date,1,10) d FROM spotting WHERE date IS NOT NULL")])
    m["locations"] = _n("SELECT COUNT(*) FROM spot_locations")

    # Classes d'appareils (immatriculations distinctes)
    cls_count: dict[str, int] = {}
    queens = a380 = 0
    for r in q("SELECT registration, MAX(aircraft_icao) icao, MAX(aircraft) model FROM spotting GROUP BY registration"):
        c = actypes.classify(r["icao"], None, r["model"])
        cls_count[c] = cls_count.get(c, 0) + 1
        code = (r["icao"] or "").upper()
        text = (r["model"] or "").upper()
        if code.startswith("B74") or "747" in text:
            queens += 1
        if code == "A388" or "A380" in text:
            a380 += 1
    m["heavies"] = cls_count.get("jumbo", 0) + cls_count.get("wide", 0)
    m["queens"], m["a380"] = queens, a380
    m["helicopters"] = cls_count.get("heli", 0)
    m["bizjets"] = cls_count.get("bizjet", 0)
    m["props"] = cls_count.get("turboprop", 0)
    m["light"] = cls_count.get("light", 0)
    m["fighters"] = cls_count.get("fighter", 0)
    m["oddities"] = sum(cls_count.get(k, 0) for k in ("glider", "balloon", "drone"))

    # Alphabet : dernières lettres d'immatriculation différentes (A à Z)
    m["alphabet"] = len({(r["registration"] or "")[-1:] for r in q("SELECT DISTINCT registration FROM spotting WHERE known(registration) IS NOT NULL AND is_patrol = 0")} &
                        set("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))

    # Aéroports : pays et étendue géographique
    aps = [geo.airport(r["airport"]) for r in q("SELECT DISTINCT airport FROM spotting WHERE airport IS NOT NULL AND airport != ''")]
    aps = [a for a in aps if a]
    m["airport_countries"] = len({a.get("country") for a in aps if a.get("country")})
    span = 0.0
    pts = [(a["lat"], a["lng"]) for a in aps if a.get("lat") is not None][:400]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            span = max(span, _km(pts[i], pts[j]))
    m["airport_span"] = round(span)

    # Météo : conditions difficiles (pluie, neige, orage, brouillard, IFR) et vent fort
    bad = windy = 0
    for r in q("SELECT metar_json FROM spotting WHERE metar_json IS NOT NULL"):
        try:
            w = json.loads(r["metar_json"]) or {}
        except (TypeError, ValueError):
            continue
        items = " ".join(" ".join(x.get("items", [])) for x in w.get("weather") or [])
        if w.get("category") in ("IFR", "LIFR") or any(k in items for k in ("rain", "snow", "thunder", "fog", "drizzle", "hail", "shower")):
            bad += 1
        if max(w.get("wind_kt") or 0, w.get("gust_kt") or 0) >= 25:
            windy += 1
    m["bad_weather"], m["windy"] = bad, windy

    # Flottes
    fleets = q("SELECT f.airline_key, COUNT(*) total, "
               "SUM(CASE WHEN EXISTS(SELECT 1 FROM spotting s WHERE s.registration = f.registration) THEN 1 ELSE 0 END) seen "
               "FROM fleets f WHERE NOT EXISTS (SELECT 1 FROM fleet_exclusions x WHERE x.airline_key = f.airline_key "
               "AND x.registration = f.registration) GROUP BY f.airline_key")
    m["fleet_complete"] = sum(1 for f in fleets if f["total"] >= 5 and f["seen"] == f["total"])
    m["wishes_done"] = (q1("SELECT COUNT(*) n FROM wishes WHERE status = 'done'") or {}).get("n", 0)
    m["fleet_half"] = sum(1 for f in fleets if f["total"] >= 10 and f["seen"] * 2 >= f["total"])

    # Vols
    f = q1("SELECT COUNT(*) flights, COALESCE(SUM(distance_km),0) km, COALESCE(SUM(duration_min),0) mins, "
           "COALESCE(MAX(distance_km),0) longest, COUNT(DISTINCT COALESCE(airline_icao, airline)) airlines, "
           "COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, COUNT(DISTINCT cabin_class) cabins FROM flights") or {}
    m["flights"], m["flight_km"] = f.get("flights") or 0, round(f.get("km") or 0)
    m["flight_hours"] = round((f.get("mins") or 0) / 60)
    m["longest_flight"] = round(f.get("longest") or 0)
    m["flight_airlines"], m["flight_types"], m["cabins"] = f.get("airlines") or 0, f.get("types") or 0, f.get("cabins") or 0
    fa = {r["c"] for r in q("SELECT dep_icao c FROM flights UNION SELECT arr_icao FROM flights")}
    m["flight_airports"] = len(fa)
    m["flight_countries"] = len({(geo.airport(c) or {}).get("country") for c in fa} - {None})
    m["flown_spotted"] = _n("SELECT COUNT(DISTINCT known(s.registration)) FROM spotting s JOIN flights f ON f.registration = s.registration")
    return m


# --------------------------------------------------------------------------- #
# Synchronisation, évaluation, liste
# --------------------------------------------------------------------------- #
def sync_definitions() -> None:
    conn = db()
    existing = {r["code"]: r for r in q("SELECT code, unlocked_at FROM achievements")}
    # Migration des anciens codes : on reporte la date de déblocage la plus ancienne
    for old, new in LEGACY.items():
        r = existing.get(old)
        if r and old != new and r.get("unlocked_at"):
            cur = existing.get(new, {}).get("unlocked_at")
            if not cur or r["unlocked_at"] < cur:
                conn.execute("INSERT INTO achievements(code, criteria, icon, category, target, unlocked_at) VALUES(?,?,?,?,?,?) "
                             "ON CONFLICT(code) DO UPDATE SET unlocked_at=excluded.unlocked_at",
                             (new, "{}", "🏆", "spotting", 1, r["unlocked_at"]))
    valid = set(BY_CODE)
    for code in existing:
        if code not in valid:
            conn.execute("DELETE FROM achievements WHERE code = ?", (code,))
    for d in DEFINITIONS:
        conn.execute(
            "INSERT INTO achievements(code, criteria, icon, category, target) VALUES(?,?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET criteria=excluded.criteria, icon=excluded.icon, "
            "category=excluded.category, target=excluded.target",
            (d["code"], json.dumps({"metric": d["metric"], "gte": d["target"], "tier": d["tier"]}), d["icon"], d["category"], d["target"]),
        )
    conn.commit()


@lru_cache(maxsize=8)
def _i18n(lang: str) -> dict:
    p = STATIC_DIR / "i18n" / f"{lang}.json"
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def achievement_name(code: str) -> str:
    d = BY_CODE.get(code)
    if not d:
        return code
    tr = _i18n(get_setting("language") or "fr")
    name = tr.get(f"ach.s.{d['series']}.name") or d["series"]
    return f"{name} {_roman(d['level'])}"


def _roman(n: int) -> str:
    vals = [(10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for v, s in vals:
        while n >= v:
            out += s
            n -= v
    return out


def evaluate(notify_new: bool = True) -> list[str]:
    """Évalue tous les succès ; retourne les codes nouvellement débloqués (du plus facile au plus difficile)."""
    m = metrics()
    unlocked = {r["code"] for r in q("SELECT code FROM achievements WHERE unlocked_at IS NOT NULL")}
    new = []
    conn = db()
    ts = now_iso()
    for d in DEFINITIONS:
        if d["code"] not in unlocked and m.get(d["metric"], 0) >= d["target"]:
            conn.execute("UPDATE achievements SET unlocked_at=? WHERE code=?", (ts, d["code"]))
            new.append(d["code"])
    conn.commit()
    if notify_new and new:
        # Une seule notification par série : le palier le plus haut atteint
        best: dict[str, str] = {}
        for code in new:
            best[BY_CODE[code]["series"]] = code
        for code in list(best.values())[:5]:
            title, body = texts("achievement", name=achievement_name(code))
            notify("achievement", title, body, "#/achievements", {"code": code})
    return new


def rank(points: int) -> dict:
    cur, nxt = RANKS[0], None
    for i, (need, key) in enumerate(RANKS):
        if points >= need:
            cur = (need, key)
            nxt = RANKS[i + 1] if i + 1 < len(RANKS) else None
    return {"key": cur[1], "min": cur[0], "next": nxt[1] if nxt else None, "next_min": nxt[0] if nxt else None,
            "level": RANKS.index(cur) + 1}


def listing() -> dict:
    m = metrics()
    rows = {r["code"]: r for r in q("SELECT code, unlocked_at FROM achievements")}
    items = []
    for d in DEFINITIONS:
        val = m.get(d["metric"], 0)
        items.append({**d, "value": val, "progress": min(1.0, val / d["target"] if d["target"] else 1),
                      "unlocked_at": (rows.get(d["code"]) or {}).get("unlocked_at")})
    points = sum(i["points"] for i in items if i["unlocked_at"])
    total_points = sum(i["points"] for i in items)
    tiers = {tr: {"unlocked": sum(1 for i in items if i["tier"] == tr and i["unlocked_at"]),
                  "total": sum(1 for i in items if i["tier"] == tr)} for tr in TIERS}
    return {"items": items, "unlocked": sum(1 for i in items if i["unlocked_at"]), "total": len(items),
            "points": points, "total_points": total_points, "rank": rank(points), "tiers": tiers}
