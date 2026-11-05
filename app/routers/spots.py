"""Module Spotting : CRUD, filtres, vues liste/galerie/carte, doublons, références croisées."""
from __future__ import annotations

import json
import random
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from ..core import db, execute, get_settings, now_iso, q, q1
from ..services import collection, gamification, geo, media, weather, wishes
from ..services import registration as regs
from ..services.notify import notify, texts

router = APIRouter(prefix="/api/spots", tags=["spots"])

TAG_PALETTE = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6",
               "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b"]

FLIGHT_TYPES = ["commercial", "cargo", "test", "delivery", "ferry", "military", "business", "general",
                "helicopter", "medical", "training", "airshow", "government", "other"]

EDITABLE = ("registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner", "airline_icao",
            "livery", "military", "flight_type", "test_registration", "date", "airport", "location_id", "lat", "lng",
            "description", "icao24", "favorite", "rating", "camera", "lens", "focal", "aperture", "iso",
            "shutter")

SORTS = {
    "date_desc": "COALESCE(s.date, s.created_at) DESC, s.id_spotting DESC",
    "date_asc": "COALESCE(s.date, s.created_at) ASC, s.id_spotting ASC",
    "created": "s.created_at DESC, s.id_spotting DESC",
    "registration": "s.registration ASC, s.date DESC",
    "type": "COALESCE(s.aircraft_icao, s.aircraft) ASC, s.date DESC",
}


# --------------------------------------------------------------------------- #
# Filtres partagés (liste, carte, export, partage)
# --------------------------------------------------------------------------- #
def build_filters(f: dict) -> tuple[str, list]:
    where, params = ["1=1"], []
    if f.get("search"):
        like = f"%{f['search'].strip()}%"
        where.append("(s.registration LIKE ? OR s.aircraft LIKE ? OR s.aircraft_icao LIKE ? OR s.owner LIKE ? "
                     "OR s.airport LIKE ? OR s.livery LIKE ? OR s.description LIKE ? OR s.msn LIKE ? OR s.date LIKE ? "
                     "OR s.test_registration LIKE ?)")
        params += [like] * 10
    for key, col in (("registration", "s.registration"), ("airport", "s.airport"), ("country", "s.country"),
                     ("flight_type", "s.flight_type"), ("camera", "s.camera"), ("lens", "s.lens"),
                     ("livery_category", "s.livery_category")):
        if f.get(key):
            where.append(f"{col} = ?")
            params.append(f[key].upper() if key in ("registration", "airport", "country") else f[key])
    if f.get("type"):
        where.append("COALESCE(s.aircraft_icao, s.aircraft) = ?")
        params.append(f["type"])
    if f.get("airline"):
        where.append("opg(s.airline_icao, s.owner) = ?")
        params.append(f["airline"])
    if f.get("tag"):
        where.append("EXISTS (SELECT 1 FROM spotting_tags st WHERE st.id_spotting = s.id_spotting AND st.id_tag = ?)")
        params.append(int(f["tag"]))
    if f.get("year"):
        where.append("substr(s.date,1,4) = ?")
        params.append(str(f["year"]))
    if f.get("month"):
        where.append("substr(s.date,1,7) = ?")
        params.append(str(f["month"]))
    if f.get("date_from"):
        where.append("s.date >= ?")
        params.append(f["date_from"])
    if f.get("date_to"):
        where.append("s.date <= ?")
        params.append(f["date_to"] + "T23:59")
    if f.get("special"):
        where.append("s.livery_category IS NOT NULL AND s.livery_category NOT IN ('primer', 'white')")
    if f.get("military") is not None and f.get("military") != "":
        where.append("s.military = ?")
        params.append(int(f["military"]))
    if f.get("favorite"):
        where.append("s.favorite = 1")
    if f.get("has_photo"):
        where.append("s.image IS NOT NULL")
    if f.get("has_audio"):
        where.append("s.atc_audio IS NOT NULL")
    if f.get("location_id"):
        where.append("s.location_id = ?")
        params.append(int(f["location_id"]))
    if f.get("ids"):
        ids = [int(x) for x in str(f["ids"]).split(",") if x.strip().isdigit()]
        where.append(f"s.id_spotting IN ({','.join('?' * len(ids)) or 'NULL'})")
        params += ids
    return " AND ".join(where), params


def attach_tags(rows: list[dict]) -> None:
    if not rows:
        return
    ids = [r["id_spotting"] for r in rows]
    tag_rows = q(
        f"SELECT st.id_spotting, t.id_tag, t.name, t.color FROM spotting_tags st JOIN tags t USING(id_tag) "
        f"WHERE st.id_spotting IN ({','.join('?' * len(ids))}) ORDER BY t.name", ids)
    by: dict[int, list] = {}
    for t in tag_rows:
        by.setdefault(t["id_spotting"], []).append({"id_tag": t["id_tag"], "name": t["name"], "color": t["color"]})
    for r in rows:
        r["tags"] = by.get(r["id_spotting"], [])


def decorate(rows: list[dict], ctx: dict | None = None) -> list[dict]:
    attach_tags(rows)
    ctx = ctx or collection.badge_context()
    for r in rows:
        r["badges"] = collection.badges_for(r, ctx)
        r.pop("exif_json", None)
    return rows


LIST_COLS = ("s.id_spotting, s.registration, s.aircraft, s.aircraft_icao, s.owner, s.airline_icao, s.livery, "
             "s.livery_category, s.military, s.flight_type, s.date, s.airport, s.thumb, s.image, s.image_w, "
             "s.image_h, s.atc_audio, s.country, s.favorite, s.rating, s.sun_elevation, s.msn, s.camera, s.lens, "
             "s.description, s.lat, s.lng, s.location_id")


@router.get("")
def list_spots(
    search: str = "", tag: int | None = None, airport: str = "", type: str = "", airline: str = "",
    registration: str = "", country: str = "", year: str = "", month: str = "", flight_type: str = "",
    special: bool = False, military: int | None = None, favorite: bool = False, has_photo: bool = False,
    has_audio: bool = False, camera: str = "", lens: str = "", livery_category: str = "",
    location_id: int | None = None, date_from: str = "", date_to: str = "",
    sort: str = "date_desc", limit: int = Query(60, le=500), offset: int = 0,
):
    f = dict(locals())
    where, params = build_filters(f)
    total = q1(f"SELECT COUNT(*) n FROM spotting s WHERE {where}", params)["n"]
    rows = q(f"SELECT {LIST_COLS} FROM spotting s WHERE {where} ORDER BY {SORTS.get(sort, SORTS['date_desc'])} "
             f"LIMIT ? OFFSET ?", params + [limit, offset])
    return {"items": decorate(rows), "total": total, "offset": offset, "limit": limit}


@router.get("/map")
def spots_map(
    search: str = "", tag: int | None = None, airport: str = "", type: str = "", airline: str = "",
    registration: str = "", country: str = "", year: str = "", month: str = "", flight_type: str = "",
    special: bool = False, military: int | None = None, favorite: bool = False, has_photo: bool = False,
    has_audio: bool = False, camera: str = "", lens: str = "", livery_category: str = "",
    location_id: int | None = None, date_from: str = "", date_to: str = "",
):
    """Spots regroupés par lieu (point de vue, coordonnées GPS ou aéroport), puis par appareil."""
    f = dict(locals())
    where, params = build_filters(f)
    rows = q(f"SELECT s.id_spotting, s.registration, s.aircraft_icao, s.aircraft, s.owner, s.thumb, s.airport, "
             f"s.lat, s.lng, s.location_id, s.date, s.livery_category, s.military, s.favorite, "
             f"l.name AS loc_name, l.lat AS loc_lat, l.lng AS loc_lng "
             f"FROM spotting s LEFT JOIN spot_locations l ON l.id_location = s.location_id "
             f"WHERE {where} ORDER BY s.date DESC", params)
    places: dict[tuple, dict] = {}
    for r in rows:
        ap = geo.airport(r["airport"]) if r["airport"] else None
        if r["location_id"] and r["loc_lat"] is not None:
            lat, lng, kind, name = r["loc_lat"], r["loc_lng"], "location", r["loc_name"]
            key = ("L", r["location_id"])
        elif r["lat"] is not None and r["lng"] is not None:
            lat, lng, kind, name = r["lat"], r["lng"], "gps", None
            key = ("G", round(r["lat"], 3), round(r["lng"], 3))
        elif ap:
            lat, lng, kind, name = ap["lat"], ap["lng"], "airport", ap["name"]
            key = ("A", ap["icao"])
        else:
            continue
        p = places.setdefault(key, {
            "id": "-".join(str(k) for k in key), "kind": kind, "lat": lat, "lng": lng, "name": name,
            "airport": r["airport"], "airport_name": ap["name"] if ap else None,
            "city": ap["city"] if ap else None, "country": ap["country"] if ap else None,
            "iata": ap["iata"] if ap else None, "location_id": r["location_id"],
            "count": 0, "first": None, "last": None, "_regs": {}, "_types": {}, "special": 0, "military": 0,
        })
        p["count"] += 1
        if r["date"]:
            p["last"] = max(p["last"] or r["date"], r["date"])
            p["first"] = min(p["first"] or r["date"], r["date"])
        p["special"] += 1 if r["livery_category"] not in (None, "primer", "white") else 0
        p["military"] += 1 if r["military"] else 0
        tkey = r["aircraft_icao"] or r["aircraft"]
        if tkey:
            p["_types"][tkey] = p["_types"].get(tkey, 0) + 1
        a = p["_regs"].get(r["registration"])
        if a is None:
            # Les lignes arrivent du plus récent au plus ancien : la première rencontre est la dernière en date
            a = p["_regs"][r["registration"]] = {
                "registration": r["registration"], "id_spotting": r["id_spotting"], "aircraft": r["aircraft"],
                "aircraft_icao": r["aircraft_icao"], "owner": r["owner"], "date": r["date"], "thumb": r["thumb"],
                "n": 0, "special": r["livery_category"] not in (None, "primer", "white"), "favorite": False}
        a["n"] += 1
        a["thumb"] = a["thumb"] or r["thumb"]
        a["favorite"] = a["favorite"] or bool(r["favorite"])
    out = []
    for p in places.values():
        regs_ = sorted(p.pop("_regs").values(), key=lambda a: (a["date"] or ""), reverse=True)
        types = sorted(p.pop("_types").items(), key=lambda kv: -kv[1])
        p["regs"] = len(regs_)
        p["types"] = [{"k": k, "n": n} for k, n in types[:6]]
        p["types_count"] = len(types)
        p["aircraft"] = regs_[:60]
        p["thumbs"] = [a["thumb"] for a in regs_ if a["thumb"]][:4]
        out.append(p)
    out.sort(key=lambda p: -p["count"])
    return {"places": out, "total": len(rows)}


@router.get("/facets")
def facets():
    """Valeurs disponibles pour les filtres."""
    def col(sql):
        return [r["v"] for r in q(sql) if r["v"]]
    return {
        "airports": col("SELECT airport v, COUNT(*) n FROM spotting GROUP BY airport ORDER BY n DESC"),
        "types": col("SELECT COALESCE(aircraft_icao, aircraft) v, COUNT(*) n FROM spotting GROUP BY v ORDER BY n DESC"),
        "airlines": q("SELECT opg(airline_icao, owner) v, MAX(owner) name, COUNT(*) n FROM spotting "
                      "WHERE opg(airline_icao, owner) IS NOT NULL GROUP BY v ORDER BY n DESC"),
        "years": col("SELECT DISTINCT substr(date,1,4) v FROM spotting WHERE date IS NOT NULL ORDER BY v DESC"),
        "countries": col("SELECT country v, COUNT(*) n FROM spotting GROUP BY country ORDER BY n DESC"),
        "flight_types": FLIGHT_TYPES,
        "recent_airports": col("SELECT airport v, MAX(date) d FROM spotting WHERE airport IS NOT NULL "
                               "GROUP BY airport ORDER BY d DESC LIMIT 8"),
    }


class DupCheck(BaseModel):
    registration: str
    airport: str | None = None
    date: str | None = None
    exclude_id: int | None = None


def find_duplicates(reg: str, airport: str | None, date: str | None, exclude_id: int | None = None) -> list[dict]:
    if not reg or not airport or not date:
        return []
    return q("SELECT id_spotting, registration, airport, date, thumb FROM spotting WHERE registration = ? "
             "AND airport = ? AND substr(date,1,10) = ? AND id_spotting <> ?",
             (regs.normalize(reg), geo.resolve_icao(airport), date[:10], exclude_id or -1))


@router.post("/check-duplicate")
def check_duplicate(body: DupCheck):
    return {"duplicates": find_duplicates(body.registration, body.airport, body.date, body.exclude_id)}


@router.get("/{spot_id}")
def get_spot(spot_id: int, sort: str = "date_desc"):
    s = q1("SELECT * FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s:
        raise HTTPException(404, "not_found")
    exif = json.loads(s.get("exif_json") or "{}")
    decorate([s])
    s["exif"] = exif
    s["metar_decoded"] = json.loads(s["metar_json"]) if s.get("metar_json") else None
    s.pop("metar_json", None)
    s["airport_info"] = geo.airport(s["airport"])
    s["location"] = q1("SELECT * FROM spot_locations WHERE id_location = ?", (s["location_id"],)) if s["location_id"] else None
    s["flights"] = collection.crossref_for_spot(s["registration"])
    s["encounters"] = q1("SELECT COUNT(*) n FROM spotting WHERE registration = ?", (s["registration"],))["n"]
    key = "COALESCE(date, created_at) || printf('%010d', id_spotting)"
    cur = q1(f"SELECT {key} k FROM spotting WHERE id_spotting = ?", (spot_id,))["k"]
    newer = q1(f"SELECT id_spotting FROM spotting WHERE {key} > ? ORDER BY {key} ASC LIMIT 1", (cur,))
    older = q1(f"SELECT id_spotting FROM spotting WHERE {key} < ? ORDER BY {key} DESC LIMIT 1", (cur,))
    s["prev_id"] = newer["id_spotting"] if newer else None   # "précédent" dans une liste triée du plus récent
    s["next_id"] = older["id_spotting"] if older else None
    return s


# --------------------------------------------------------------------------- #
# Création / mise à jour
# --------------------------------------------------------------------------- #
def _to_float(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def prepare(data: dict[str, Any], existing: dict | None = None) -> dict:
    out = {k: data.get(k) for k in EDITABLE if k in data}
    for k, v in list(out.items()):
        if isinstance(v, str):
            out[k] = v.strip() or None
    merged = {**(existing or {}), **out}
    if "registration" in out or not existing:
        reg = regs.normalize(merged.get("registration"))
        if not reg:
            raise HTTPException(422, "registration_required")
        out["registration"] = reg
        out["country"] = regs.country_of(reg)
    if "airport" in out:
        out["airport"] = geo.resolve_icao(out["airport"]) if out["airport"] else None
    if "aircraft_icao" in out and out["aircraft_icao"]:
        out["aircraft_icao"] = out["aircraft_icao"].upper()
    if "airline_icao" in out and out["airline_icao"]:
        out["airline_icao"] = out["airline_icao"].upper()
    if "icao24" in out and out["icao24"]:
        out["icao24"] = out["icao24"].lower()
    for k in ("lat", "lng", "focal", "aperture"):
        if k in out:
            out[k] = _to_float(out[k])
    for k in ("military", "favorite"):
        if k in out:
            out[k] = 1 if out[k] in (True, 1, "1", "true", "on") else 0
    for k in ("rating", "iso", "location_id"):
        if k in out:
            try:
                out[k] = int(out[k]) if out[k] not in (None, "") else None
            except (TypeError, ValueError):
                out[k] = None
    if "msn" in out and out["msn"] is not None:
        out["msn"] = str(out["msn"])
    # Immatriculation d'essai : normalisée, et conservée seulement pour un « Vol d'essai »
    if "test_registration" in out:
        out["test_registration"] = regs.normalize(out["test_registration"]) or None if out["test_registration"] else None
    if out.get("flight_type") and out["flight_type"] != "test":
        out["test_registration"] = None
    if "livery" in out:
        out["livery_category"] = collection.livery_category(out["livery"])
        # Un avion en primer est un avion d'essai : le type de vol « Vol d'essai » est proposé s'il n'est pas renseigné
        if out["livery_category"] == "primer" and not (out.get("flight_type") or (existing or {}).get("flight_type")):
            out["flight_type"] = "test"
    merged = {**(existing or {}), **out}
    # Coordonnées : point de vue choisi > GPS EXIF > (affichage : aéroport)
    if out.get("location_id"):
        loc = q1("SELECT lat, lng, airport FROM spot_locations WHERE id_location = ?", (out["location_id"],))
        if loc:
            out["lat"], out["lng"] = loc["lat"], loc["lng"]
            if not merged.get("airport") and loc["airport"]:
                out["airport"] = loc["airport"]
    merged = {**(existing or {}), **out}
    if any(k in out for k in ("date", "airport")) or not existing:
        out["date_utc"] = geo.local_to_utc(merged.get("date"), merged.get("airport"))
    merged = {**(existing or {}), **out}
    lat, lng = merged.get("lat"), merged.get("lng")
    if lat is None:
        a = geo.airport(merged.get("airport"))
        if a:
            lat, lng = a["lat"], a["lng"]
    out["sun_elevation"] = geo.sun_elevation_at(lat, lng, merged.get("date_utc"))
    return out


def set_tags(spot_id: int, tags: list) -> None:
    conn = db()
    conn.execute("DELETE FROM spotting_tags WHERE id_spotting = ?", (spot_id,))
    for t in tags or []:
        tag_id = None
        if isinstance(t, int) or (isinstance(t, str) and t.isdigit()):
            tag_id = int(t)
        elif isinstance(t, dict) and t.get("id_tag"):
            tag_id = int(t["id_tag"])
        else:
            name = (t.get("name") if isinstance(t, dict) else str(t)).strip()
            if not name:
                continue
            row = conn.execute("SELECT id_tag FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
            if row:
                tag_id = row["id_tag"]
            else:
                tag_id = conn.execute("INSERT INTO tags(name, color) VALUES(?, ?)",
                                      (name[:40], random.choice(TAG_PALETTE))).lastrowid
        conn.execute("INSERT OR IGNORE INTO spotting_tags(id_spotting, id_tag) VALUES(?, ?)", (spot_id, tag_id))
    conn.commit()


def _apply_image(out: dict, image: UploadFile | None, data: dict) -> None:
    if not image or not image.filename:
        return
    raw = image.file.read()
    if not raw:
        return
    try:
        res = media.save_image(raw, image.filename)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, "invalid_image") from e
    exif = res.pop("exif")
    out.update(res)
    out["exif_json"] = json.dumps(exif)
    for k in ("camera", "lens", "focal", "aperture", "iso", "shutter"):
        if exif.get(k) is not None and not data.get(k):
            out[k] = exif[k]
    if exif.get("datetime") and not data.get("date"):
        out["date"] = exif["datetime"]
    if exif.get("lat") is not None and data.get("lat") in (None, "") and not data.get("location_id"):
        out["lat"], out["lng"] = exif["lat"], exif["lng"]


def _post_save(spot_id: int, reg: str, is_new: bool, weather_needed: bool, bg: BackgroundTasks) -> dict:
    extra: dict = {"crossref": [], "achievements": [], "wishes": []}
    settings = get_settings()
    if weather_needed and settings["modules"].get("weather", True):
        execute("UPDATE spotting SET weather_status='pending' WHERE id_spotting=?", (spot_id,))
        bg.add_task(weather.update_spot_weather, spot_id)
    if is_new:
        flights = collection.crossref_for_spot(reg)
        if flights:
            extra["crossref"] = flights
            title, body = texts("crossref_spot", reg=reg, n=len(flights))
            notify("crossref", title, body, f"#/airframe/{reg}", {"registration": reg, "spot": spot_id})
    if settings["modules"].get("watchlist", True):
        extra["wishes"] = [{"id": w["id"], "title": w["title"], "kind": w["kind"]} for w in wishes.sync()]
    if settings["modules"].get("gamification", True):
        extra["achievements"] = gamification.evaluate()
    return extra


@router.post("")
def create_spot(
    bg: BackgroundTasks,
    data: str = Form("{}"),
    image: UploadFile | None = File(None),
    audio: UploadFile | None = File(None),
    force: bool = False,
):
    payload = json.loads(data or "{}")
    if payload.get("draft_uuid"):
        exist = q1("SELECT id_spotting FROM spotting WHERE draft_uuid = ?", (payload["draft_uuid"],))
        if exist:
            return {"spot": get_spot(exist["id_spotting"]), "already_synced": True, "crossref": [], "achievements": []}
    out: dict = {}
    _apply_image(out, image, payload)
    merged_input = {**payload, **{k: v for k, v in out.items() if k in EDITABLE and not payload.get(k)}}
    if not merged_input.get("airport") and get_settings().get("default_airport"):
        merged_input["airport"] = get_settings()["default_airport"]
    out.update(prepare(merged_input))
    if not force:
        dups = find_duplicates(out["registration"], out.get("airport"), out.get("date"))
        if dups:
            media.delete_image(out.get("image"), out.get("thumb"))
            raise HTTPException(409, detail={"code": "duplicate", "duplicates": dups})
    if audio and audio.filename:
        try:
            out["atc_audio"] = media.save_audio(audio.file.read(), audio.filename)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
    if out.get("military") is None:
        out["military"] = 1 if regs.looks_military(out.get("owner"), out.get("aircraft")) else 0
    out["draft_uuid"] = payload.get("draft_uuid")
    out["created_at"] = out["updated_at"] = now_iso()
    cols = ", ".join(out.keys())
    cur = execute(f"INSERT INTO spotting({cols}) VALUES({', '.join('?' * len(out))})", list(out.values()))
    spot_id = cur.lastrowid
    set_tags(spot_id, payload.get("tags") or [])
    extra = _post_save(spot_id, out["registration"], True, bool(out.get("airport") and out.get("date_utc")), bg)
    return {"spot": get_spot(spot_id), **extra}


@router.put("/{spot_id}")
def update_spot(
    spot_id: int,
    bg: BackgroundTasks,
    data: str = Form("{}"),
    image: UploadFile | None = File(None),
    audio: UploadFile | None = File(None),
):
    existing = q1("SELECT * FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not existing:
        raise HTTPException(404, "not_found")
    payload = json.loads(data or "{}")
    out: dict = {}
    if image and image.filename:
        old = (existing.get("image"), existing.get("thumb"))
        _apply_image(out, image, payload)
        media.delete_image(*old)
    elif payload.get("remove_image"):
        media.delete_image(existing.get("image"), existing.get("thumb"))
        out.update({"image": None, "thumb": None, "image_w": None, "image_h": None})
    if audio and audio.filename:
        try:
            new_audio = media.save_audio(audio.file.read(), audio.filename)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        media.delete_audio(existing.get("atc_audio"))
        out["atc_audio"] = new_audio
    elif payload.get("remove_audio"):
        media.delete_audio(existing.get("atc_audio"))
        out["atc_audio"] = None
    out.update(prepare({**{k: v for k, v in out.items() if k in EDITABLE}, **payload}, existing))
    out["updated_at"] = now_iso()
    sets = ", ".join(f"{k} = ?" for k in out)
    execute(f"UPDATE spotting SET {sets} WHERE id_spotting = ?", list(out.values()) + [spot_id])
    if "tags" in payload:
        set_tags(spot_id, payload["tags"])
    changed_wx = (out.get("date_utc") != existing.get("date_utc") or out.get("airport", existing["airport"]) != existing["airport"])
    extra = _post_save(spot_id, out.get("registration", existing["registration"]), False, changed_wx, bg)
    return {"spot": get_spot(spot_id), **extra}


@router.patch("/{spot_id}/favorite")
def toggle_favorite(spot_id: int):
    execute("UPDATE spotting SET favorite = 1 - favorite, updated_at=? WHERE id_spotting = ?", (now_iso(), spot_id))
    r = q1("SELECT favorite FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not r:
        raise HTTPException(404, "not_found")
    return r


@router.post("/{spot_id}/weather")
def refresh_weather(spot_id: int):
    weather.update_spot_weather(spot_id)
    s = q1("SELECT metar, metar_json, taf, weather_status FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s:
        raise HTTPException(404, "not_found")
    s["metar_decoded"] = json.loads(s.pop("metar_json") or "null")
    return s


def delete_spot_files(s: dict) -> None:
    media.delete_image(s.get("image"), s.get("thumb"))
    media.delete_audio(s.get("atc_audio"))


@router.delete("/{spot_id}")
def delete_spot(spot_id: int):
    s = q1("SELECT * FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s:
        raise HTTPException(404, "not_found")
    execute("DELETE FROM spotting WHERE id_spotting = ?", (spot_id,))
    delete_spot_files(s)
    return {"deleted": spot_id}


class Bulk(BaseModel):
    ids: list[int]
    action: str
    value: Any = None


@router.post("/bulk")
def bulk(body: Bulk):
    if not body.ids:
        return {"updated": 0}
    marks = ",".join("?" * len(body.ids))
    conn = db()
    if body.action == "delete":
        rows = q(f"SELECT * FROM spotting WHERE id_spotting IN ({marks})", body.ids)
        conn.execute(f"DELETE FROM spotting WHERE id_spotting IN ({marks})", body.ids)
        conn.commit()
        for r in rows:
            delete_spot_files(r)
    elif body.action in ("add_tag", "remove_tag"):
        tag_id = int(body.value)
        for i in body.ids:
            if body.action == "add_tag":
                conn.execute("INSERT OR IGNORE INTO spotting_tags VALUES(?, ?)", (i, tag_id))
            else:
                conn.execute("DELETE FROM spotting_tags WHERE id_spotting=? AND id_tag=?", (i, tag_id))
        conn.commit()
    elif body.action == "favorite":
        conn.execute(f"UPDATE spotting SET favorite=? WHERE id_spotting IN ({marks})", [1 if body.value else 0] + body.ids)
        conn.commit()
    else:
        raise HTTPException(400, "unknown_action")
    return {"updated": len(body.ids)}
