"""Statistiques, timeline par cellule, flottes & complétion, livrées spéciales, tableau de bord."""
from __future__ import annotations

import csv
import io
import json
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import db, execute, get_config, memo, now_iso, q, q1
from ..services import collection, aircraft as ac
from ..services import airframes
from ..services import collection, geo, wishes
from ..services import registration as regs
from .spots import decorate, LIST_COLS

router = APIRouter(tags=["stats"])


def _period(year: str) -> tuple[str, list]:
    return ("substr(date,1,4) = ?", [year]) if year else ("1=1", [])


@router.get("/api/stats")
def stats(year: str = ""):
    from datetime import date
    return memo("stats", lambda y, d: _stats(y), year, date.today().isoformat())


def _stats(year: str = ""):
    w, p = _period(year)
    totals = q1(
        f"SELECT COUNT(*) spots, COUNT(DISTINCT known(registration)) registrations, "
        f"COUNT(DISTINCT mk(aircraft_icao, aircraft, military)) types, "
        f"COUNT(DISTINCT opg(airline_icao, owner)) airlines, COUNT(DISTINCT NULLIF(airport,'')) airports, "
        f"COUNT(DISTINCT country) countries, SUM(CASE WHEN image IS NOT NULL THEN 1 ELSE 0 END) photos, "
        f"SUM(CASE WHEN livery_category IS NOT NULL AND livery_category NOT IN ('primer', 'white') THEN 1 ELSE 0 END) special_liveries, "
        f"COUNT(DISTINCT CASE WHEN livery_category = 'primer' THEN registration END) primers, "
        f"COUNT(DISTINCT CASE WHEN livery_category = 'white' THEN registration END) whites, "
        f"SUM(military) military, COUNT(DISTINCT substr(date,1,10)) days, "
        f"SUM(CASE WHEN atc_audio IS NOT NULL THEN 1 ELSE 0 END) audio FROM spotting WHERE {w}", p)

    def top(expr: str, extra: str = "", n: int = 10):
        return q(f"SELECT {expr} AS k, COUNT(*) n {extra} FROM spotting WHERE {w} AND {expr} IS NOT NULL "
                 f"AND {expr} <> '' GROUP BY k ORDER BY n DESC, k LIMIT {n}", p)

    top_regs = q(f"SELECT registration k, COUNT(*) n, MAX(aircraft) aircraft, MAX(owner) owner, "
                 f"(SELECT thumb FROM spotting s2 WHERE s2.registration = s.registration AND thumb IS NOT NULL "
                 f"ORDER BY date DESC LIMIT 1) thumb FROM spotting s WHERE {w} GROUP BY registration "
                 f"ORDER BY n DESC, MAX(date) DESC LIMIT 10", p)
    top_airports = top("airport")
    for a in top_airports:
        info = geo.airport(a["k"])
        a["name"] = info["name"] if info else None
    gear = q(f"SELECT camera, lens, COUNT(*) n, COUNT(DISTINCT known(registration)) regs FROM spotting WHERE {w} "
             f"AND camera IS NOT NULL GROUP BY camera, lens ORDER BY n DESC LIMIT 10", p)
    focal = q(f"SELECT CASE WHEN focal < 35 THEN '<35' WHEN focal < 100 THEN '35-99' WHEN focal < 200 THEN '100-199' "
              f"WHEN focal < 300 THEN '200-299' WHEN focal < 400 THEN '300-399' WHEN focal < 600 THEN '400-599' "
              f"ELSE '600+' END k, COUNT(*) n, MIN(focal) mn FROM spotting WHERE {w} AND focal IS NOT NULL "
              f"GROUP BY k ORDER BY mn", p)
    by_month = q(f"SELECT substr(date,1,7) k, COUNT(*) n, COUNT(DISTINCT known(registration)) regs FROM spotting "
                 f"WHERE {w} AND date IS NOT NULL GROUP BY k ORDER BY k", p)
    by_year = q("SELECT substr(date,1,4) k, COUNT(*) n FROM spotting WHERE date IS NOT NULL GROUP BY k ORDER BY k")
    by_hour = q(f"SELECT CAST(substr(date,12,2) AS INTEGER) k, COUNT(*) n FROM spotting WHERE {w} "
                f"AND length(date) >= 13 GROUP BY k ORDER BY k", p)
    by_weekday = q(f"SELECT CAST(strftime('%w', substr(date,1,10)) AS INTEGER) k, COUNT(*) n FROM spotting "
                   f"WHERE {w} AND date IS NOT NULL GROUP BY k ORDER BY k", p)
    manufacturers = top("manufacturer")
    flight_types = top("flight_type")
    best_day = q1(f"SELECT substr(date,1,10) k, COUNT(*) n FROM spotting WHERE {w} AND date IS NOT NULL "
                  f"GROUP BY k ORDER BY n DESC LIMIT 1", p)
    first = q1(f"SELECT id_spotting, registration, date FROM spotting WHERE {w} AND date IS NOT NULL ORDER BY date LIMIT 1", p)
    # Calendrier d'activité : l'année choisie, ou les 53 dernières semaines
    from datetime import date as _date, timedelta as _td
    if year:
        cal_from, cal_to = f"{year}-01-01", f"{year}-12-31"
    else:
        end = _date.today()
        cal_from, cal_to = (end - _td(days=7 * 53 - 1)).isoformat(), end.isoformat()
    cal = q("SELECT substr(date,1,10) k, COUNT(*) n FROM spotting WHERE date IS NOT NULL AND substr(date,1,10) BETWEEN ? AND ? "
            "GROUP BY k", (cal_from, cal_to))
    days_all = q(f"SELECT DISTINCT substr(date,1,10) d FROM spotting WHERE {w} AND date IS NOT NULL", p)
    return {
        "year": year, "totals": totals, "top_registrations": top_regs, "top_airports": top_airports,
        "top_types": top("mk(aircraft_icao, aircraft, military)", ", MAX(aircraft) label"),
        "top_airlines": top("opg(airline_icao, owner)", ", MAX(owner) label"),
        "top_countries": top("country"), "top_tags": q(
            f"SELECT t.name k, t.color, COUNT(*) n FROM spotting_tags st JOIN tags t USING(id_tag) "
            f"JOIN spotting s USING(id_spotting) WHERE {w.replace('date', 's.date')} GROUP BY t.id_tag ORDER BY n DESC LIMIT 10", p),
        "gear": gear, "cameras": top("camera"), "lenses": top("lens"), "focal": focal,
        "manufacturers": manufacturers, "flight_types": flight_types,
        "by_month": by_month, "by_year": by_year, "by_hour": by_hour, "by_weekday": by_weekday,
        "best_day": best_day, "first": first,
        "calendar": {"from": cal_from, "to": cal_to, "days": {r["k"]: r["n"] for r in cal}},
        "streak": streaks(days_all, _date.today() if not year or year == str(_date.today().year) else None),
        "years": [r["k"] for r in by_year][::-1],
    }


@router.get("/api/stats/flights")
def flight_stats(year: str = ""):
    from datetime import date
    return memo("flight_stats", lambda y, d: _flight_stats(y), year, date.today().isoformat())


def _flight_stats(year: str = ""):
    w, p = _period(year)
    rows = q(f"SELECT * FROM flights WHERE {w}", p)
    if not rows:
        return {"count": 0}

    def count(key):
        c: dict = {}
        for r in rows:
            v = r.get(key)
            if v:
                c[v] = c.get(v, 0) + 1
        return [{"k": k, "n": n} for k, n in sorted(c.items(), key=lambda kv: -kv[1])[:10]]

    routes: dict = {}
    airports: dict = {}
    for r in rows:
        key = "–".join(sorted((r["dep_icao"], r["arr_icao"])))
        routes[key] = routes.get(key, 0) + 1
        for a in (r["dep_icao"], r["arr_icao"]):
            airports[a] = airports.get(a, 0) + 1
    longest = max(rows, key=lambda r: r["distance_km"] or 0)
    shortest = min((r for r in rows if r["distance_km"]), key=lambda r: r["distance_km"], default=None)
    km = sum(r["distance_km"] or 0 for r in rows)
    return {
        "count": len(rows), "km": round(km), "minutes": sum(r["duration_min"] or 0 for r in rows),
        "earth_laps": round(km / 40075, 3), "moon_pct": round(km / 384400 * 100, 2),
        "airports": len(airports),
        "top_airports": [{"k": k, "n": n, "name": (geo.airport(k) or {}).get("name")}
                         for k, n in sorted(airports.items(), key=lambda kv: -kv[1])[:10]],
        "top_routes": [{"k": k, "n": n} for k, n in sorted(routes.items(), key=lambda kv: -kv[1])[:10]],
        "top_airlines": count("airline"), "top_types": count("aircraft"), "seat_types": count("seat_type"),
        "classes": count("cabin_class"), "reasons": count("reason"),
        "longest": {k: longest[k] for k in ("id_flight", "dep_icao", "arr_icao", "distance_km", "date")},
        "shortest": {k: shortest[k] for k in ("id_flight", "dep_icao", "arr_icao", "distance_km", "date")} if shortest else None,
        "by_year": [{"k": y, "n": sum(1 for r in rows if r["date"][:4] == y)} for y in sorted({r["date"][:4] for r in rows})],
    }


# --------------------------------------------------------------------------- #
# Tableau de bord
# --------------------------------------------------------------------------- #
@router.get("/api/dashboard")
def dashboard():
    from datetime import date
    return memo("dashboard", lambda d: _dashboard(), date.today().isoformat())


def _dashboard():
    from datetime import date

    today = date.today()
    totals = q1("SELECT COUNT(*) spots, COUNT(DISTINCT known(registration)) regs, "
                "COUNT(DISTINCT mk(aircraft_icao, aircraft, military)) types, COUNT(DISTINCT opg(airline_icao, owner)) airlines, "
                "COUNT(DISTINCT NULLIF(airport,'')) airports, COUNT(DISTINCT country) countries FROM spotting")
    month = q1("SELECT COUNT(*) n FROM spotting WHERE substr(date,1,7) = ?", (today.strftime("%Y-%m"),))["n"]
    year_totals = q1("SELECT COUNT(*) spots, COUNT(DISTINCT mk(aircraft_icao, aircraft, military)) types, "
                     "COUNT(DISTINCT known(registration)) regs, COUNT(DISTINCT substr(date,1,10)) days FROM spotting WHERE substr(date,1,4) = ?",
                     (str(today.year),))
    last_year = q1("SELECT COUNT(*) spots FROM spotting WHERE substr(date,1,4) = ? AND substr(date,6,5) <= ?",
                   (str(today.year - 1), today.strftime("%m-%d")))["spots"]
    year = q1("SELECT COUNT(*) n FROM spotting WHERE substr(date,1,4) = ?", (str(today.year),))["n"]
    recent = q(f"SELECT {LIST_COLS} FROM spotting s ORDER BY COALESCE(s.date, s.created_at) DESC, s.id_spotting DESC LIMIT 12")
    decorate(recent)
    on_this_day = q(f"SELECT {LIST_COLS} FROM spotting s WHERE substr(s.date,6,5) = ? AND substr(s.date,1,4) < ? "
                    f"ORDER BY s.date DESC LIMIT 8", (today.strftime("%m-%d"), str(today.year)))
    hero = q1("SELECT id_spotting, registration, aircraft, owner, image, thumb, airport, date FROM spotting "
              "WHERE image IS NOT NULL ORDER BY favorite DESC, COALESCE(date, created_at) DESC LIMIT 1")
    top_types = q("SELECT mk(aircraft_icao, aircraft, military) k, MAX(aircraft) label, COUNT(*) n FROM spotting "
                  "WHERE mk(aircraft_icao, aircraft, military) IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 6")
    months = q("SELECT substr(date,1,7) k, COUNT(*) n FROM spotting WHERE date >= date('now','-11 months','start of month') "
               "GROUP BY k ORDER BY k")
    flights = q1("SELECT COUNT(*) n, COALESCE(SUM(distance_km),0) km FROM flights")
    watch = q("SELECT value registration, airborne, last_status, last_seen_at FROM wishes WHERE kind='aircraft' AND status='open' AND track=1 ORDER BY airborne DESC, value LIMIT 6")
    for wr in watch:
        wr["last_status"] = json.loads(wr["last_status"] or "null")
    from ..services import gamification
    unl = q("SELECT code, icon, unlocked_at FROM achievements WHERE unlocked_at IS NOT NULL ORDER BY unlocked_at DESC, target DESC")
    unl = [r for r in unl if r["code"] in gamification.BY_CODE]
    pts = sum(gamification.BY_CODE[r["code"]]["points"] for r in unl)
    ach = [{**r, "tier": gamification.BY_CODE[r["code"]]["tier"], "series": gamification.BY_CODE[r["code"]]["series"],
            "level": gamification.BY_CODE[r["code"]]["level"]} for r in unl[:5]]
    ach_total = {"total": len(gamification.DEFINITIONS), "unlocked": len(unl), "points": pts, "rank": gamification.rank(pts)}
    drafts_hint = q1("SELECT COUNT(*) n FROM spotting WHERE weather_status = 'pending'")["n"]
    return {"totals": totals, "month": month, "year": year, "recent": recent, "on_this_day": on_this_day,
            "hero": hero, "top_types": top_types, "months": months, "flights": flights, "watchlist": watch, "wishlist": wishes.summary(),
            "achievements": ach, "achievements_total": ach_total, "pending_weather": drafts_hint,
            "year_totals": year_totals, "last_year_same_day": last_year, "today": today.isoformat(),
            "streak": streaks(q("SELECT DISTINCT substr(date,1,10) d FROM spotting WHERE date IS NOT NULL"), today)}


# --------------------------------------------------------------------------- #
# Timeline d'une cellule (airframe)
# --------------------------------------------------------------------------- #
@router.get("/api/airframe/{reg}")
def airframe(reg: str):
    r = regs.normalize(reg)
    ids = airframes.group(r)          # immatriculations de la même cellule (essai ↔ définitive, via le MSN)
    ph = ",".join("?" * len(ids))
    spots = q(f"SELECT {LIST_COLS}, s.date_utc, s.test_registration FROM spotting s WHERE s.registration IN ({ph}) ORDER BY s.date", ids)
    decorate(spots)
    flights = q(f"SELECT * FROM flights WHERE registration IN ({ph}) ORDER BY date", ids)
    cached = q1("SELECT data, fetched_at, source FROM aircraft_cache WHERE registration = ?", (r,))
    info = json.loads(cached["data"]) if cached else {}
    if spots:
        latest = spots[-1]
        for k in ("aircraft", "aircraft_icao", "owner", "airline_icao", "msn"):
            if latest.get(k):
                info.setdefault(k, latest[k])
    info["registration"] = r
    info["country"] = regs.country_of(r)
    events = []
    for s in spots:
        a = geo.airport(s["airport"])
        events.append({"kind": "spot", "date": s["date"], "id": s["id_spotting"], "airport": s["airport"], "place": s.get("place"),
                       "lat": s["lat"] if s["lat"] is not None else (a or {}).get("lat"),
                       "lng": s["lng"] if s["lng"] is not None else (a or {}).get("lng"),
                       "thumb": s["thumb"], "livery": s["livery"], "owner": s["owner"],
                       "registration": s["registration"], "test_registration": s.get("test_registration"),
                       "airport_name": (a or {}).get("name"), "badges": s["badges"], "tags": s["tags"]})
    for f in flights:
        d, a = geo.airport(f["dep_icao"]), geo.airport(f["arr_icao"])
        events.append({"kind": "flight", "date": f["date"] + ("T" + f["dep_time"] if f.get("dep_time") else ""),
                       "id": f["id_flight"], "dep": f["dep_icao"], "arr": f["arr_icao"],
                       "dep_ll": [d["lat"], d["lng"]] if d else None, "arr_ll": [a["lat"], a["lng"]] if a else None,
                       "flight_number": f["flight_number"], "seat": f["seat"]})
    events.sort(key=lambda e: e["date"] or "")
    # Changements de livrée / d'opérateur au fil du temps
    changes, prev = [], None
    for s in spots:
        cur = (s.get("owner"), s.get("livery") if collection.is_special_livery(s.get("livery")) else None)
        if prev is not None and cur != prev:
            changes.append({"date": s["date"], "owner": cur[0], "livery": cur[1]})
        prev = cur
    airports = sorted({s["airport"] for s in spots if s["airport"]})
    in_watch = q1("SELECT id FROM wishes WHERE kind='aircraft' AND status='open' AND UPPER(value) = ?", (r,))
    counts = {i: sum(1 for s in spots if s["registration"] == i) for i in ids}
    return {"info": info, "aliases": [{"registration": i, "spots": counts[i]} for i in ids if i != r],
            "tests": sorted({s["test_registration"] for s in spots if s.get("test_registration")} - {r}), "events": events, "spots": len(spots), "flights": len(flights),
            "first_seen": spots[0]["date"] if spots else None, "last_seen": spots[-1]["date"] if spots else None,
            "airports": airports, "changes": changes, "watch_id": in_watch["id"] if in_watch else None,
            "cover": next((s["image"] for s in reversed(spots) if s.get("image")), None)}


LIVERY_PER_CAT = 90   # au-delà, la page renvoie vers la liste filtrée (évite des réponses de plusieurs Mo)


@router.get("/api/liveries")
def liveries(limit: int = LIVERY_PER_CAT):
    order = ["retro", "alliance", "commemorative", "logojet", "cause", "special", "primer", "white"]
    stats_ = {r["c"]: r for r in q("SELECT livery_category c, COUNT(*) n, COUNT(DISTINCT registration) u FROM spotting "
                                   "WHERE livery_category IS NOT NULL GROUP BY livery_category")}
    out = []
    ctx = collection.badge_context()
    for c in order:
        if c not in stats_:
            continue
        rows = q(f"SELECT {LIST_COLS} FROM spotting s WHERE s.livery_category = ? ORDER BY s.date DESC LIMIT ?", (c, limit))
        out.append({"category": c, "items": decorate(rows, ctx), "count": stats_[c]["n"], "unique": stats_[c]["u"]})
    return out


def streaks(rows: list[dict], today=None) -> dict:
    """Plus longue série de jours consécutifs avec au moins un spot, et série en cours."""
    from datetime import date as _date, timedelta as _td
    days = sorted({_date.fromisoformat(r["d"]) for r in rows if r.get("d") and len(r["d"]) == 10 and r["d"][4] == "-"})
    best = cur = 0
    best_end = None
    prev = None
    for d in days:
        cur = cur + 1 if prev and d - prev == _td(days=1) else 1
        if cur > best:
            best, best_end = cur, d
        prev = d
    current = 0
    if today and days:
        s = set(days)
        d = today if today in s else today - _td(days=1)
        while d in s:
            current += 1
            d -= _td(days=1)
    return {"longest": best, "longest_from": (best_end - _td(days=best - 1)).isoformat() if best_end else None,
            "longest_to": best_end.isoformat() if best_end else None, "current": current, "active_days": len(days)}
