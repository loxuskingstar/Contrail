"""Session de test : base isolée (data/sandbox/) préremplie avec un jeu de données sans images.

Vos données réelles ne sont jamais lues ni modifiées depuis la session de test.
Le jeu de données est décrit dans app/fixtures/jeu_de_test.json (dates relatives au jour de chargement).
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
from datetime import datetime, timedelta, timezone

from ..core import (BASE_DIR, PROFILES, db, db_path, ensure_dirs, get_settings, now_iso, reset_connections,
                    set_settings, use_profile)

log = logging.getLogger("contrail.sandbox")
FIXTURE = BASE_DIR / "app" / "fixtures" / "jeu_de_test.json"
_lock = threading.Lock()


def _local_iso(days_ago: int, hhmm: str) -> str:
    d = datetime.now() - timedelta(days=int(days_ago))
    return f"{d:%Y-%m-%d}T{hhmm}"


def load_fixture() -> dict:
    """Charge le jeu de test dans la base du profil actif (qui doit être « test »)."""
    from ..routers import flights as flights_router
    from ..routers.spots import prepare as prepare_spot
    from ..routers.spots import set_tags
    from . import gamification
    from .weather import decode_metar

    data = json.loads(FIXTURE.read_text("utf-8"))
    conn = db()
    set_settings(data.get("settings", {}))
    for tg in data.get("tags", []):
        conn.execute("INSERT OR IGNORE INTO tags(name, color) VALUES(?, ?)", (tg["name"], tg["color"]))
    conn.commit()

    loc_ids: dict[str, int] = {}
    from ..routers.field import LocationIn, _prepare_loc
    for loc in data.get("locations", []):
        d = _prepare_loc(LocationIn(**loc))
        d["created_at"] = d["updated_at"] = now_iso()
        cur = conn.execute(f"INSERT INTO spot_locations({', '.join(d)}) VALUES({', '.join('?' * len(d))})", list(d.values()))
        loc_ids[loc["name"]] = cur.lastrowid
    conn.commit()

    for s in data.get("spots", []):
        payload = {k: s.get(k) for k in ("registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner",
                                         "airline_icao", "livery", "flight_type", "military", "airport", "description",
                                         "camera", "lens", "focal", "aperture", "iso", "shutter", "favorite", "rating")}
        payload["date"] = _local_iso(s.get("days_ago", 0), s.get("time", "12:00"))
        if s.get("location") in loc_ids:
            payload["location_id"] = loc_ids[s["location"]]
        out = prepare_spot(payload)
        metar = s.get("metar")
        if metar and out.get("date_utc"):
            utc = datetime.fromisoformat(out["date_utc"].replace("Z", "+00:00"))
            # Heure ronde précédente, comme un METAR réel
            obs = utc.replace(minute=0, second=0) if utc.minute >= 0 else utc
            metar = metar.replace("{DDHHMM}", f"{obs:%d%H%M}")
            decoded = decode_metar(metar)
            decoded["observed"] = obs.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            out.update({"metar": metar, "metar_json": json.dumps(decoded), "weather_status": "ok"})
        else:
            out["weather_status"] = "none"
        out["created_at"] = out["updated_at"] = now_iso()
        cur = conn.execute(f"INSERT INTO spotting({', '.join(out)}) VALUES({', '.join('?' * len(out))})", list(out.values()))
        conn.commit()
        if s.get("tags"):
            set_tags(cur.lastrowid, s["tags"])

    for f in data.get("flights", []):
        body = {k: v for k, v in f.items() if k not in ("days_ago", "dep", "arr")}
        body.update(date=_local_iso(f.get("days_ago", 0), "00:00")[:10], dep_icao=f["dep"], arr_icao=f["arr"])
        d = flights_router.prepare(flights_router.FlightIn(**body))
        d["created_at"] = d["updated_at"] = now_iso()
        conn.execute(f"INSERT INTO flights({', '.join(d)}) VALUES({', '.join('?' * len(d))})", list(d.values()))
    conn.commit()

    for fl in data.get("fleets", []):
        for reg, typ in fl["registrations"]:
            conn.execute("INSERT OR REPLACE INTO fleets(airline_key, registration, aircraft) VALUES(?,?,?)", (fl["key"], reg, typ))
        conn.execute("INSERT OR REPLACE INTO airlines(key, icao, name, fleet_source, fleet_fetched_at) VALUES(?,?,?,?,?)",
                     (fl["key"], fl["key"], fl["name"], "manual", now_iso()))
    for w in data.get("watchlist", []):
        conn.execute("INSERT OR IGNORE INTO wishes(kind, title, value, note, notify, track, auto_complete, created_at, updated_at) "
                     "VALUES('aircraft',?,?,?,0,1,0,?,?)", (w["registration"], w["registration"], w.get("note"), now_iso(), now_iso()))
    for w in data.get("wishes", []):
        start = end = None
        if w.get("start_in") is not None:
            start_d = datetime.now().date() + timedelta(days=int(w["start_in"]))
            start, end = start_d.isoformat(), (start_d + timedelta(days=int(w.get("length", 1)) - 1)).isoformat()
        conn.execute("INSERT INTO wishes(kind, title, value, airline_key, family, note, priority, goal_count, start_date, end_date, "
                     "place, airport, notify, since, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)",
                     (w["kind"], w["title"], w.get("value"), w.get("airline_key"), int(w.get("family", 0)), w.get("note"),
                      w.get("priority", 2), w.get("goal_count", 1), start, end, w.get("place"), w.get("airport"),
                      now_iso(), now_iso()))
    conn.commit()

    gamification.evaluate(notify_new=False)
    from . import wishes
    wishes.sync(notify_done=False)
    conn.execute("DELETE FROM notifications")
    conn.commit()
    return {"spots": len(data.get("spots", [])), "flights": len(data.get("flights", []))}


def ensure_sandbox() -> None:
    """Crée et remplit la base de test si elle n'existe pas encore."""
    with _lock:
        with use_profile("test"):
            if db_path().exists():
                return
        # Reprend l'apparence de vos réglages pour que la session de test vous soit familière
        with use_profile("main"):
            base = get_settings()
        appearance = {k: base[k] for k in ("theme", "accent", "language", "units", "map_tiles", "map_tiles_url",
                                            "map_tiles_attribution", "modules") if k in base}
        _create(appearance)


def _create(appearance: dict) -> None:
    with use_profile("test"):
        from ..db import init_db
        from . import gamification

        ensure_dirs()
        init_db()
        gamification.sync_definitions()
        set_settings(appearance)
        try:
            res = load_fixture()
            log.info("Session de test créée : %s spots, %s vols", res["spots"], res["flights"])
        except Exception:
            log.exception("Chargement du jeu de test en échec")
            raise


def reset_sandbox() -> None:
    """Efface entièrement la session de test puis recharge le jeu de données."""
    with _lock:
        shutil.rmtree(PROFILES["test"], ignore_errors=True)
        reset_connections()
    ensure_sandbox()
