"""Succès (achievements) : définitions, métriques et déblocage."""
from __future__ import annotations

import json
from functools import lru_cache

from ..core import STATIC_DIR, db, get_setting, now_iso, q, q1
from .notify import notify, texts

# code, métrique, seuil, icône, catégorie
DEFINITIONS: list[tuple[str, str, int, str, str]] = [
    ("first_spot", "spots", 1, "📸", "spotting"),
    ("spots_10", "spots", 10, "🛫", "spotting"),
    ("spots_100", "spots", 100, "💯", "spotting"),
    ("spots_500", "spots", 500, "🏅", "spotting"),
    ("spots_1000", "spots", 1000, "🏆", "spotting"),
    ("regs_50", "regs", 50, "🔢", "spotting"),
    ("regs_250", "regs", 250, "🗂️", "spotting"),
    ("types_10", "types", 10, "✈️", "collection"),
    ("types_25", "types", 25, "🛩️", "collection"),
    ("types_50", "types", 50, "🧭", "collection"),
    ("airlines_10", "airlines", 10, "🎨", "collection"),
    ("airlines_50", "airlines", 50, "🌈", "collection"),
    ("countries_10", "countries", 10, "🌍", "collection"),
    ("countries_30", "countries", 30, "🗺️", "collection"),
    ("airports_5", "airports", 5, "📍", "field"),
    ("airports_20", "airports", 20, "🧳", "field"),
    ("livery_1", "special_liveries", 1, "✨", "collection"),
    ("livery_10", "special_liveries", 10, "🎭", "collection"),
    ("military_1", "military", 1, "🎖️", "collection"),
    ("military_10", "military", 10, "🛡️", "collection"),
    ("night_5", "night", 5, "🌙", "field"),
    ("golden_10", "golden", 10, "🌅", "field"),
    ("early_bird", "early", 1, "🐦", "field"),
    ("big_day", "big_day", 25, "⚡", "field"),
    ("loyal_5", "max_same_reg", 5, "🔁", "spotting"),
    ("audio_1", "audio", 1, "🎧", "field"),
    ("full_circle", "flown_spotted", 1, "🔄", "flights"),
    ("flights_1", "flights", 1, "🎫", "flights"),
    ("flights_25", "flights", 25, "🧳", "flights"),
    ("flights_100", "flights", 100, "🌐", "flights"),
    ("km_earth", "flight_km", 40075, "🌏", "flights"),
    ("km_moon", "flight_km", 384400, "🌕", "flights"),
    ("fleet_complete", "fleet_complete", 1, "🧩", "collection"),
    ("locations_3", "locations", 3, "🔭", "field"),
]


def metrics() -> dict[str, float]:
    m: dict[str, float] = {}
    r = q1(
        "SELECT COUNT(*) spots, COUNT(DISTINCT registration) regs, "
        "COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, "
        "COUNT(DISTINCT COALESCE(airline_icao, owner)) airlines, "
        "COUNT(DISTINCT NULLIF(airport,'')) airports, COUNT(DISTINCT country) countries, "
        "SUM(CASE WHEN livery_category IS NOT NULL THEN 1 ELSE 0 END) special_liveries, "
        "SUM(military) military, SUM(CASE WHEN sun_elevation < -6 THEN 1 ELSE 0 END) night, "
        "SUM(CASE WHEN sun_elevation BETWEEN -4 AND 8 THEN 1 ELSE 0 END) golden, "
        "SUM(CASE WHEN substr(date, 12, 5) < '07:00' AND length(date) >= 16 THEN 1 ELSE 0 END) early, "
        "SUM(CASE WHEN atc_audio IS NOT NULL THEN 1 ELSE 0 END) audio FROM spotting"
    ) or {}
    m.update({k: v or 0 for k, v in r.items()})
    m["max_same_reg"] = (q1("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM spotting GROUP BY registration)") or {}).get("n") or 0
    m["big_day"] = (q1("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM spotting WHERE date IS NOT NULL "
                       "GROUP BY substr(date,1,10))") or {}).get("n") or 0
    f = q1("SELECT COUNT(*) flights, COALESCE(SUM(distance_km),0) km FROM flights") or {}
    m["flights"], m["flight_km"] = f.get("flights") or 0, round(f.get("km") or 0)
    m["flown_spotted"] = (q1("SELECT COUNT(DISTINCT s.registration) n FROM spotting s JOIN flights f "
                             "ON f.registration = s.registration") or {}).get("n") or 0
    m["locations"] = (q1("SELECT COUNT(*) n FROM spot_locations") or {}).get("n") or 0
    m["fleet_complete"] = (q1(
        "SELECT COUNT(*) n FROM (SELECT f.airline_key, COUNT(*) total, "
        "SUM(CASE WHEN EXISTS(SELECT 1 FROM spotting s WHERE s.registration = f.registration) THEN 1 ELSE 0 END) seen "
        "FROM fleets f GROUP BY f.airline_key HAVING total >= 5 AND seen = total)") or {}).get("n") or 0
    return m


def sync_definitions() -> None:
    conn = db()
    for code, metric, target, icon, cat in DEFINITIONS:
        conn.execute(
            "INSERT INTO achievements(code, criteria, icon, category, target) VALUES(?,?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET criteria=excluded.criteria, icon=excluded.icon, "
            "category=excluded.category, target=excluded.target",
            (code, json.dumps({"metric": metric, "gte": target}), icon, cat, target),
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
    lang = get_setting("language") or "fr"
    return _i18n(lang).get(f"ach.{code}.name") or code


def evaluate(notify_new: bool = True) -> list[str]:
    """Évalue tous les succès ; retourne les codes nouvellement débloqués."""
    m = metrics()
    unlocked = {r["code"] for r in q("SELECT code FROM achievements WHERE unlocked_at IS NOT NULL")}
    new = []
    conn = db()
    for code, metric, target, _icon, _cat in DEFINITIONS:
        if code not in unlocked and m.get(metric, 0) >= target:
            conn.execute("UPDATE achievements SET unlocked_at=? WHERE code=?", (now_iso(), code))
            new.append(code)
    conn.commit()
    if notify_new:
        for code in new:
            title, body = texts("achievement", name=achievement_name(code))
            notify("achievement", title, body, "#/achievements", {"code": code})
    return new


def listing() -> list[dict]:
    m = metrics()
    rows = {r["code"]: r for r in q("SELECT * FROM achievements")}
    out = []
    for code, metric, target, icon, cat in DEFINITIONS:
        r = rows.get(code, {})
        val = m.get(metric, 0)
        out.append({"code": code, "icon": icon, "category": cat, "metric": metric, "target": target,
                    "value": val, "progress": min(1.0, val / target if target else 1),
                    "unlocked_at": r.get("unlocked_at")})
    return out
