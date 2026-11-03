"""Statistiques, timeline par cellule, flottes & complétion, livrées spéciales, tableau de bord."""
from __future__ import annotations

import csv
import io
import json
import re

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import db, execute, get_config, now_iso, q, q1
from ..services import aircraft as ac
from ..services import collection, geo
from ..services import registration as regs
from .spots import decorate, LIST_COLS

router = APIRouter(tags=["stats"])


def _period(year: str) -> tuple[str, list]:
    return ("substr(date,1,4) = ?", [year]) if year else ("1=1", [])


@router.get("/api/stats")
def stats(year: str = ""):
    w, p = _period(year)
    totals = q1(
        f"SELECT COUNT(*) spots, COUNT(DISTINCT registration) registrations, "
        f"COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, "
        f"COUNT(DISTINCT COALESCE(airline_icao, owner)) airlines, COUNT(DISTINCT NULLIF(airport,'')) airports, "
        f"COUNT(DISTINCT country) countries, SUM(CASE WHEN image IS NOT NULL THEN 1 ELSE 0 END) photos, "
        f"SUM(CASE WHEN livery_category IS NOT NULL THEN 1 ELSE 0 END) special_liveries, "
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
    gear = q(f"SELECT camera, lens, COUNT(*) n, COUNT(DISTINCT registration) regs FROM spotting WHERE {w} "
             f"AND camera IS NOT NULL GROUP BY camera, lens ORDER BY n DESC LIMIT 10", p)
    focal = q(f"SELECT CASE WHEN focal < 35 THEN '<35' WHEN focal < 100 THEN '35-99' WHEN focal < 200 THEN '100-199' "
              f"WHEN focal < 300 THEN '200-299' WHEN focal < 400 THEN '300-399' WHEN focal < 600 THEN '400-599' "
              f"ELSE '600+' END k, COUNT(*) n, MIN(focal) mn FROM spotting WHERE {w} AND focal IS NOT NULL "
              f"GROUP BY k ORDER BY mn", p)
    by_month = q(f"SELECT substr(date,1,7) k, COUNT(*) n, COUNT(DISTINCT registration) regs FROM spotting "
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
    return {
        "year": year, "totals": totals, "top_registrations": top_regs, "top_airports": top_airports,
        "top_types": top("COALESCE(aircraft_icao, aircraft)", ", MAX(aircraft) label"),
        "top_airlines": top("COALESCE(airline_icao, owner)", ", MAX(owner) label"),
        "top_countries": top("country"), "top_tags": q(
            f"SELECT t.name k, t.color, COUNT(*) n FROM spotting_tags st JOIN tags t USING(id_tag) "
            f"JOIN spotting s USING(id_spotting) WHERE {w.replace('date', 's.date')} GROUP BY t.id_tag ORDER BY n DESC LIMIT 10", p),
        "gear": gear, "cameras": top("camera"), "lenses": top("lens"), "focal": focal,
        "manufacturers": manufacturers, "flight_types": flight_types,
        "by_month": by_month, "by_year": by_year, "by_hour": by_hour, "by_weekday": by_weekday,
        "best_day": best_day, "first": first,
        "years": [r["k"] for r in by_year][::-1],
    }


@router.get("/api/stats/flights")
def flight_stats(year: str = ""):
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

    today = date.today()
    totals = q1("SELECT COUNT(*) spots, COUNT(DISTINCT registration) regs, "
                "COUNT(DISTINCT COALESCE(aircraft_icao, aircraft)) types, COUNT(DISTINCT COALESCE(airline_icao, owner)) airlines, "
                "COUNT(DISTINCT NULLIF(airport,'')) airports, COUNT(DISTINCT country) countries FROM spotting")
    month = q1("SELECT COUNT(*) n FROM spotting WHERE substr(date,1,7) = ?", (today.strftime("%Y-%m"),))["n"]
    year = q1("SELECT COUNT(*) n FROM spotting WHERE substr(date,1,4) = ?", (str(today.year),))["n"]
    recent = q(f"SELECT {LIST_COLS} FROM spotting s ORDER BY COALESCE(s.date, s.created_at) DESC, s.id_spotting DESC LIMIT 12")
    decorate(recent)
    on_this_day = q(f"SELECT {LIST_COLS} FROM spotting s WHERE substr(s.date,6,5) = ? AND substr(s.date,1,4) < ? "
                    f"ORDER BY s.date DESC LIMIT 8", (today.strftime("%m-%d"), str(today.year)))
    hero = q1("SELECT id_spotting, registration, aircraft, owner, image, thumb, airport, date FROM spotting "
              "WHERE image IS NOT NULL ORDER BY favorite DESC, COALESCE(date, created_at) DESC LIMIT 1")
    top_types = q("SELECT COALESCE(aircraft_icao, aircraft) k, MAX(aircraft) label, COUNT(*) n FROM spotting "
                  "WHERE COALESCE(aircraft_icao, aircraft) IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 6")
    months = q("SELECT substr(date,1,7) k, COUNT(*) n FROM spotting WHERE date >= date('now','-11 months','start of month') "
               "GROUP BY k ORDER BY k")
    flights = q1("SELECT COUNT(*) n, COALESCE(SUM(distance_km),0) km FROM flights")
    watch = q("SELECT registration, airborne, last_status, last_seen_at FROM watchlist ORDER BY airborne DESC, registration LIMIT 6")
    for wr in watch:
        wr["last_status"] = json.loads(wr["last_status"] or "null")
    ach = q("SELECT code, icon, unlocked_at FROM achievements WHERE unlocked_at IS NOT NULL ORDER BY unlocked_at DESC LIMIT 4")
    ach_total = q1("SELECT COUNT(*) total, SUM(unlocked_at IS NOT NULL) unlocked FROM achievements")
    drafts_hint = q1("SELECT COUNT(*) n FROM spotting WHERE weather_status = 'pending'")["n"]
    return {"totals": totals, "month": month, "year": year, "recent": recent, "on_this_day": on_this_day,
            "hero": hero, "top_types": top_types, "months": months, "flights": flights, "watchlist": watch,
            "achievements": ach, "achievements_total": ach_total, "pending_weather": drafts_hint}


# --------------------------------------------------------------------------- #
# Timeline d'une cellule (airframe)
# --------------------------------------------------------------------------- #
@router.get("/api/airframe/{reg}")
def airframe(reg: str):
    r = regs.normalize(reg)
    spots = q(f"SELECT {LIST_COLS}, s.date_utc FROM spotting s WHERE s.registration = ? ORDER BY s.date", (r,))
    decorate(spots)
    flights = q("SELECT * FROM flights WHERE registration = ? ORDER BY date", (r,))
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
        events.append({"kind": "spot", "date": s["date"], "id": s["id_spotting"], "airport": s["airport"],
                       "lat": s["lat"] if s["lat"] is not None else (a or {}).get("lat"),
                       "lng": s["lng"] if s["lng"] is not None else (a or {}).get("lng"),
                       "thumb": s["thumb"], "livery": s["livery"], "owner": s["owner"],
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
    in_watch = q1("SELECT id FROM watchlist WHERE registration = ?", (r,))
    return {"info": info, "events": events, "spots": len(spots), "flights": len(flights),
            "first_seen": spots[0]["date"] if spots else None, "last_seen": spots[-1]["date"] if spots else None,
            "airports": airports, "changes": changes, "watch_id": in_watch["id"] if in_watch else None,
            "cover": next((s["image"] for s in reversed(spots) if s.get("image")), None)}


@router.get("/api/liveries")
def liveries():
    rows = q(f"SELECT {LIST_COLS} FROM spotting s WHERE s.livery_category IS NOT NULL ORDER BY s.date DESC")
    decorate(rows)
    groups: dict = {}
    for r in rows:
        groups.setdefault(r["livery_category"], []).append(r)
    order = ["retro", "alliance", "commemorative", "logojet", "cause", "special"]
    return [{"category": c, "items": groups[c], "count": len(groups[c]),
             "unique": len({i["registration"] for i in groups[c]})} for c in order if c in groups]
