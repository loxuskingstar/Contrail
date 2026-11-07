"""Module Spotting : CRUD, filtres, vues liste/galerie/carte, doublons, références croisées."""
from __future__ import annotations

import json
import random
import re
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from ..core import db, execute, get_settings, memo, now_iso, q, q1, set_settings
from ..services import outings as outings_svc, trash, airframes, collection, gamification, geo, media, weather, wishes
from ..services import actypes
from ..services import registration as regs
from ..services.notify import notify, texts

router = APIRouter(prefix="/api/spots", tags=["spots"])

TAG_PALETTE = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6",
               "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b"]

FLIGHT_TYPES = ["commercial", "cargo", "test", "delivery", "ferry", "military", "business", "general",
                "helicopter", "medical", "training", "airshow", "government",
                "museum", "display", "storage", "maintenance", "scrapyard", "other"]    # museum… scrapyard : avions statiques

EDITABLE = ("registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner", "airline_icao",
            "livery", "military", "flight_type", "test_registration", "date", "airport", "place", "location_id", "lat", "lng",
            "description", "icao24", "favorite", "rating", "camera", "lens", "focal", "aperture", "iso",
            "shutter")

SORTS = {
    "date_desc": "COALESCE(s.date, s.created_at) DESC, s.id_spotting DESC",
    "date_asc": "COALESCE(s.date, s.created_at) ASC, s.id_spotting ASC",
    "created": "s.created_at DESC, s.id_spotting DESC",
    "registration": "s.registration ASC, s.date DESC",
    "type": "mk(s.aircraft_icao, s.aircraft, s.military) ASC, s.date DESC",
}


# --------------------------------------------------------------------------- #
# Filtres partagés (liste, carte, export, partage)
# --------------------------------------------------------------------------- #
# Moment de la journée d'après la hauteur du soleil (mêmes seuils que les badges) ; aube / crépuscule se distinguent par l'heure
_HOUR = "CAST(substr(s.date, 12, 2) AS INTEGER)"
DAYTIME_SQL = {
    "day": "s.sun_elevation > 8",
    "golden": "s.sun_elevation BETWEEN -4 AND 8",
    "dawn": f"s.sun_elevation >= -12 AND s.sun_elevation < -4 AND {_HOUR} < 12",
    "dusk": f"s.sun_elevation >= -12 AND s.sun_elevation < -4 AND {_HOUR} >= 12",
    "night": "s.sun_elevation < -12",
}
_WX = "json_extract(s.metar_json, '$.summary')"


def _wx_in(*vals: str) -> str:
    return f"{_WX} IN ({','.join(repr(v) for v in vals)})"


WEATHER_SQL = {
    "clear": _wx_in("clear"),
    "partly_cloudy": _wx_in("partly_cloudy"),
    "cloudy": _wx_in("cloudy", "overcast"),
    "rain": _wx_in("rain", "drizzle", "showers", "freezing"),
    "snow": _wx_in("snow", "snow_grains", "ice_crystals", "ice_pellets", "hail", "small_hail"),
    "storm": _wx_in("thunderstorm", "squalls", "funnel_cloud"),
    "fog": _wx_in("fog", "mist", "haze", "smoke", "dust", "sand", "volcanic_ash"),
    "none": "s.metar_json IS NULL",
}
_KT = "COALESCE(json_extract(s.metar_json, '$.wind_kt'), -1)"
_GUST = "COALESCE(json_extract(s.metar_json, '$.gust_kt'), 0)"
WIND_SQL = {
    "calm": f"{_KT} BETWEEN 0 AND 7 AND {_GUST} < 15",
    "moderate": f"{_KT} BETWEEN 8 AND 17 AND {_GUST} < 25",
    "strong": f"({_KT} >= 18 OR {_GUST} >= 25)",
}


def build_filters(f: dict) -> tuple[str, list]:
    where, params = ["1=1"], []
    if f.get("search"):
        like = f"%{f['search'].strip()}%"
        # Une ancienne immatriculation ramène aussi les spots du même avion (nouvelle compagnie, immat d'essai…)
        sib = airframes.group(f["search"]) if len(regs.normalize(f["search"])) >= 3 else []
        sib = sib if len(sib) > 1 else []
        where.append("(s.registration LIKE ? OR s.aircraft LIKE ? OR s.aircraft_icao LIKE ? OR s.owner LIKE ? "
                     "OR s.airport LIKE ? OR s.livery LIKE ? OR s.description LIKE ? OR s.msn LIKE ? OR s.date LIKE ? "
                     "OR s.test_registration LIKE ? OR s.place LIKE ?"
                     + (f" OR s.registration IN ({','.join('?' * len(sib))})" if sib else "") + ")")
        params += [like] * 11 + sib
    for key, col in (("registration", "s.registration"), ("airport", "s.airport"), ("place", "s.place"), ("country", "s.country"),
                     ("flight_type", "s.flight_type"), ("camera", "s.camera"), ("lens", "s.lens"),
                     ("livery_category", "s.livery_category")):
        if f.get(key):
            where.append(f"{col} = ?")
            params.append(f[key].upper() if key in ("registration", "airport", "country") else f[key])
    if f.get("type"):
        where.append("mk(s.aircraft_icao, s.aircraft, s.military) = ?")
        params.append(actypes.model_key(f["type"]))
    if f.get("airline"):
        where.append("opg(s.airline_icao, s.owner) = ?")
        params.append(f["airline"])
    tag_ids = sorted({int(x) for x in re.findall(r"\d+", str(f.get("tag") or ""))})
    if tag_ids:
        if f.get("tag_mode") == "any":          # au moins une des étiquettes
            where.append(f"EXISTS (SELECT 1 FROM spotting_tags st WHERE st.id_spotting = s.id_spotting AND st.id_tag IN ({','.join('?' * len(tag_ids))}))")
            params.extend(tag_ids)
        else:                                   # toutes les étiquettes (par défaut)
            for tid in tag_ids:
                where.append("EXISTS (SELECT 1 FROM spotting_tags st WHERE st.id_spotting = s.id_spotting AND st.id_tag = ?)")
                params.append(tid)
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
    if f.get("daytime") in DAYTIME_SQL:
        where.append(DAYTIME_SQL[f["daytime"]])
    if f.get("weather") in WEATHER_SQL:
        where.append(WEATHER_SQL[f["weather"]])
    if f.get("wind") in WIND_SQL:
        where.append(WIND_SQL[f["wind"]])
    if f.get("rare") or f.get("rarity"):
        rt = collection.rare_types((f["rarity"],) if f.get("rarity") else None)
        where.append(f"s.aircraft_icao IN ({','.join('?' * len(rt)) or 'NULL'})")
        params += rt
    if f.get("favorite"):
        where.append("s.favorite = 1")
    if f.get("has_photo"):
        where.append("s.image IS NOT NULL")
    if f.get("has_audio"):
        where.append("s.atc_audio IS NOT NULL")
    if f.get("unknown"):
        where.append("s.registration LIKE 'SANS-IMMAT-%'")      # spots à compléter : avion non identifié
    if f.get("patrol"):
        where.append("s.patrol_id = ?")
        params.append(int(f["patrol"]))
    if f.get("outing"):
        where.append("s.outing_id = ?")
        params.append(int(f["outing"]))
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
             "s.description, s.lat, s.lng, s.location_id, s.place, s.test_registration, s.patrol_id, s.is_patrol, s.patrol_size, "
             "(SELECT name FROM patrols WHERE id_patrol = s.patrol_id) AS patrol_name")


@router.get("")
def list_spots(
    search: str = "", tag: str = "", tag_mode: str = "all", airport: str = "", place: str = "", type: str = "", airline: str = "",
    registration: str = "", country: str = "", year: str = "", month: str = "", flight_type: str = "",
    special: bool = False, military: int | None = None, favorite: bool = False, has_photo: bool = False,
    has_audio: bool = False, camera: str = "", lens: str = "", livery_category: str = "",
    location_id: int | None = None, date_from: str = "", date_to: str = "", patrol: int | None = None, unknown: bool = False, outing: int | None = None, rare: bool = False, rarity: str = "", daytime: str = "", weather: str = "", wind: str = "",
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
    search: str = "", tag: str = "", tag_mode: str = "all", airport: str = "", place: str = "", type: str = "", airline: str = "",
    registration: str = "", country: str = "", year: str = "", month: str = "", flight_type: str = "",
    special: bool = False, military: int | None = None, favorite: bool = False, has_photo: bool = False,
    has_audio: bool = False, camera: str = "", lens: str = "", livery_category: str = "",
    location_id: int | None = None, date_from: str = "", date_to: str = "",
):
    """Spots regroupés par lieu (point de vue, coordonnées GPS ou aéroport), puis par appareil."""
    return memo("map", _spots_map, tuple(sorted(dict(locals()).items())))


def _spots_map(items):
    f = dict(items)
    where, params = build_filters(f)
    rows = q(f"SELECT s.id_spotting, s.registration, s.aircraft_icao, s.aircraft, s.owner, s.thumb, s.airport, s.place, "
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
            lat, lng, kind, name = r["lat"], r["lng"], "gps", r["place"]
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
    return memo("facets", _facets)


def _facets():
    """Valeurs disponibles pour les filtres."""
    def col(sql):
        return [r["v"] for r in q(sql) if r["v"]]
    return {
        "airports": col("SELECT airport v, COUNT(*) n FROM spotting GROUP BY airport ORDER BY n DESC"),
        "places": col("SELECT place v, COUNT(*) n FROM spotting WHERE place IS NOT NULL GROUP BY place ORDER BY n DESC"),
        "types": col("SELECT mk(aircraft_icao, aircraft, military) v, COUNT(*) n FROM spotting GROUP BY v ORDER BY n DESC"),
        "airlines": q("SELECT opg(airline_icao, owner) v, MAX(owner) name, COUNT(*) n FROM spotting "
                      "WHERE opg(airline_icao, owner) IS NOT NULL GROUP BY v ORDER BY n DESC"),
        "years": col("SELECT DISTINCT substr(date,1,4) v FROM spotting WHERE date IS NOT NULL ORDER BY v DESC"),
        "countries": col("SELECT country v, COUNT(*) n FROM spotting GROUP BY country ORDER BY n DESC"),
        "flight_types": FLIGHT_TYPES,
        # Sites (aéroports et lieux libres) avec leur nombre de spots, du plus récemment visité au plus ancien
        "sites": q("SELECT CASE WHEN airport IS NOT NULL THEN 'airport' ELSE 'place' END kind, COALESCE(airport, place) value, "
                   "COUNT(*) n, MAX(date) last, AVG(lat) lat, AVG(lng) lng FROM spotting WHERE airport IS NOT NULL OR place IS NOT NULL "
                   "GROUP BY kind, value ORDER BY last DESC"),
        "recent_airports": col("SELECT airport v, MAX(date) d FROM spotting WHERE airport IS NOT NULL "
                               "GROUP BY airport ORDER BY d DESC LIMIT 8"),
    }


class DupCheck(BaseModel):
    registration: str
    airport: str | None = None
    place: str | None = None
    date: str | None = None
    exclude_id: int | None = None


def find_duplicates(reg: str, airport: str | None, date: str | None, exclude_id: int | None = None,
                    place: str | None = None) -> list[dict]:
    if not reg or regs.is_unknown(regs.normalize(reg)) or not (airport or place) or not date:
        return []                     # sans immatriculation, deux spots ne sont jamais « le même avion »
    return q("SELECT id_spotting, registration, airport, date, thumb FROM spotting WHERE registration = ? "
             "AND ((? IS NOT NULL AND airport = ?) OR (? IS NOT NULL AND place = ?)) AND substr(date,1,10) = ? AND id_spotting <> ?",
             (regs.normalize(reg), airport and geo.resolve_icao(airport), airport and geo.resolve_icao(airport), place, place,
              date[:10], exclude_id or -1))


@router.post("/check-duplicate")
def check_duplicate(body: DupCheck):
    ap, pl = _split_place(body.airport, body.place)
    return {"duplicates": find_duplicates(body.registration, ap, body.date, body.exclude_id, place=pl)}


PHOTO_DUP_MAX = 6      # distance de Hamming (sur 64 bits) : au-delà, ce sont deux photos différentes du même avion


@router.post("/check-photo")
def check_photo(image: UploadFile = File(...), exclude_id: int | None = Form(None)):
    """Spots dont la photo ressemble à celle qu'on s'apprête à enregistrer."""
    try:
        h = media.hash_bytes(image.file.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, "invalid_image") from e
    out = []
    mine = q1("SELECT patrol_id FROM spotting WHERE id_spotting = ?", (exclude_id,)) if exclude_id else None
    for r in q("SELECT id_spotting, registration, date, airport, thumb, phash FROM spotting WHERE phash IS NOT NULL AND id_spotting <> ? "
               "AND (patrol_id IS NULL OR patrol_id IS NOT ?)", (exclude_id or -1, mine and mine["patrol_id"])):
        d = media.hamming(h, r["phash"])
        if d <= PHOTO_DUP_MAX:
            out.append({**{k: r[k] for k in ("id_spotting", "registration", "date", "airport", "thumb")}, "distance": d})
    return {"matches": sorted(out, key=lambda m: m["distance"])[:5]}


def _ignored_pairs() -> set[str]:
    return set(get_settings().get("dup_ignored") or [])


def _pair_key(a: int, b: int) -> str:
    return f"{min(a, b)}-{max(a, b)}"


def photo_pairs(max_dist: int = PHOTO_DUP_MAX) -> list[tuple[int, dict, dict]]:
    """Paires de spots aux photos quasi identiques. Deux empreintes de 64 bits à moins de 6 bits d'écart partagent forcément
    un bloc identique parmi 7 : on ne compare que les empreintes d'un même bloc (≈ linéaire au lieu de quadratique)."""
    rows = q("SELECT id_spotting id, registration, date, airport, thumb, phash, patrol_id FROM spotting WHERE phash IS NOT NULL ORDER BY id_spotting")
    nblk = max_dist + 1
    bounds = [(k * 64 // nblk, (k + 1) * 64 // nblk) for k in range(nblk)]
    buckets: dict[tuple[int, int], list[int]] = {}
    vals = []
    for idx, r in enumerate(rows):
        try:
            h = int(r["phash"], 16)
        except (TypeError, ValueError):
            vals.append(None)
            continue
        vals.append(h)
        for k, (lo, hi) in enumerate(bounds):
            buckets.setdefault((k, (h >> lo) & ((1 << (hi - lo)) - 1)), []).append(idx)
    seen: set[tuple[int, int]] = set()
    out = []
    ignored = _ignored_pairs()
    for members in buckets.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                a, b = members[x], members[y]
                if (a, b) in seen:
                    continue
                seen.add((a, b))
                d = (vals[a] ^ vals[b]).bit_count()
                ra, rb = rows[a], rows[b]
                if d > max_dist or (ra["patrol_id"] and ra["patrol_id"] == rb["patrol_id"]) or _pair_key(ra["id"], rb["id"]) in ignored:
                    continue                  # une patrouille partage sa photo : ce n'est pas un doublon
                out.append((d, ra, rb))
    out.sort(key=lambda t: (t[0], t[1]["id"]))
    return out


@router.get("/duplicates")
def photo_duplicates(limit: int = 50):
    """Paires de spots dont les photos sont quasi identiques."""
    cols = ("id", "registration", "date", "airport", "thumb")
    pairs = photo_pairs()
    return {"count": len(pairs), "pairs": [{"distance": d, "a": {k: ra[k] for k in cols}, "b": {k: rb[k] for k in cols}}
                                           for d, ra, rb in pairs[:limit]]}


class DupPair(BaseModel):
    a: int
    b: int
    undo: bool = False


@router.post("/duplicates/ignore")
def ignore_duplicate(body: DupPair):
    """« Garder les deux » : la paire n'est plus proposée."""
    cur = _ignored_pairs()
    (cur.discard if body.undo else cur.add)(_pair_key(body.a, body.b))
    set_settings({"dup_ignored": sorted(cur)})
    return {"ignored": len(cur)}


@router.get("/patrol-names")
def patrol_names():
    """Noms de patrouilles déjà utilisés, du plus récent au plus ancien (suggestions de saisie)."""
    return [r["name"] for r in q("SELECT name FROM patrols WHERE name IS NOT NULL AND name <> '' GROUP BY name "
                                 "ORDER BY MAX(id_patrol) DESC LIMIT 50")]


@router.get("/patrol-index")
def patrol_index():
    """Patrouilles connues avec leur nombre de spots et le mode (simple ou non) : indique à la saisie où l'avion sera rattaché."""
    rows = q("SELECT p.id_patrol id, p.name, COUNT(s.id_spotting) n, COALESCE(MAX(s.is_patrol), 0) simple FROM patrols p "
             "LEFT JOIN spotting s ON s.patrol_id = p.id_patrol WHERE p.name IS NOT NULL AND p.name <> '' GROUP BY p.id_patrol")
    out: dict[str, dict] = {}
    for r in rows:
        k = regs._fold(r["name"].strip())  # noqa: SLF001
        o = out.setdefault(k, {"id": r["id"], "name": r["name"], "n": 0, "simple": 0})
        o["n"] += r["n"]
        if r["simple"] and not o["simple"]:
            o["id"], o["simple"] = r["id"], 1
    return list(out.values())


@router.get("/countries")
def countries():
    """Codes pays connus (nationalité d'une patrouille)."""
    return sorted(set(regs.PREFIXES.values()))


@router.get("/patrol-countries")
def patrol_countries():
    """Nationalité déjà saisie pour chaque nom de patrouille (la plus récente l'emporte) : pré-remplit la saisie."""
    out: dict[str, str] = {}
    for r in q("SELECT p.name, s.country FROM spotting s JOIN patrols p ON p.id_patrol = s.patrol_id "
               "WHERE s.is_patrol = 1 AND s.country IS NOT NULL AND p.name IS NOT NULL ORDER BY s.id_spotting DESC"):
        out.setdefault(r["name"].lower(), r["country"])
    return out


def patrol_of(s: dict) -> dict | None:
    if not s.get("patrol_id"):
        return None
    p = q1("SELECT id_patrol id, name FROM patrols WHERE id_patrol = ?", (s["patrol_id"],))
    if not p:
        return None
    p["members"] = q("SELECT id_spotting, registration, test_registration, aircraft, owner, thumb, is_patrol, date, airport, place FROM spotting "
                     "WHERE patrol_id = ? ORDER BY id_spotting", (p["id"],))
    return p


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
    s["patrol"] = None if s.get("is_patrol") else patrol_of(s)
    s["patrol_members"] = q("SELECT id_spotting, registration, aircraft, owner, thumb FROM spotting WHERE patrol_id = ? "
                            "AND is_patrol = 0 ORDER BY COALESCE(date, created_at) DESC, id_spotting DESC LIMIT 60",
                            (s["patrol_id"],)) if s.get("is_patrol") and s.get("patrol_id") else []
    s["outing"] = q1("SELECT o.id_outing id, o.day, o.name, (SELECT COUNT(*) FROM spotting x WHERE x.outing_id = o.id_outing) n "
                     "FROM outings o WHERE o.id_outing = ?", (s["outing_id"],)) if s.get("outing_id") else None
    s["patrol_name"] = (q1("SELECT name FROM patrols WHERE id_patrol = ?", (s["patrol_id"],)) or {}).get("name") if s.get("patrol_id") else None
    ids = airframes.group(s["registration"])
    s["encounters"] = q1(f"SELECT COUNT(*) n FROM spotting WHERE registration IN ({','.join('?' * len(ids))})", ids)["n"]
    s["aliases"] = [i for i in ids if i != s["registration"]]
    k = "COALESCE(date, created_at)"
    cur = q1(f"SELECT {k} d FROM spotting WHERE id_spotting = ?", (spot_id,))["d"]
    newer = q1(f"SELECT id_spotting FROM spotting WHERE ({k}, id_spotting) > (?, ?) ORDER BY {k} ASC, id_spotting ASC LIMIT 1", (cur, spot_id))
    older = q1(f"SELECT id_spotting FROM spotting WHERE ({k}, id_spotting) < (?, ?) ORDER BY {k} DESC, id_spotting DESC LIMIT 1", (cur, spot_id))
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


def _split_place(airport_raw: str | None, place_raw: str | None) -> tuple[str | None, str | None]:
    """Le champ « aéroport » accepte aussi un lieu libre (plage, meeting, ville) : un aéroport reconnu reste un aéroport,
    tout autre texte devient un lieu. Renvoie (code OACI, lieu)."""
    a = geo.airport(airport_raw) if airport_raw else None
    if a:
        return a["icao"], None
    if airport_raw and not place_raw:
        if re.fullmatch(r"[A-Z]{4}|[A-Z]{2}\d{2,5}", airport_raw):    # code OACI ou code terrain/hélistation (ex. LF3624) absent de la base : conservé tel quel
            return airport_raw, None
        return None, airport_raw[:120]
    return None, (place_raw or "")[:120] or None


def prepare(data: dict[str, Any], existing: dict | None = None) -> dict:
    out = {k: data.get(k) for k in EDITABLE if k in data}
    for k, v in list(out.items()):
        if isinstance(v, str):
            out[k] = v.strip() or None
    merged = {**(existing or {}), **out}
    if "registration" in out or not existing:
        reg = regs.normalize(merged.get("registration"))
        if not reg:
            if not data.get("unknown_registration"):
                raise HTTPException(422, "registration_required")
            # Sans immatriculation lisible : on garde celle de substitution déjà attribuée, sinon on en crée une
            old = (existing or {}).get("registration")
            reg = old if regs.is_unknown(old) else regs.new_unknown()
        out["registration"] = reg
        ex = existing or {}
        # le pays n'est recalculé que si l'immatriculation change : un pays corrigé à la main survit aux modifications suivantes
        if not ex.get("country") or reg != ex.get("registration"):
            out["country"] = regs.country_for(reg, merged.get("owner"))
    elif "owner" in out and not (existing or {}).get("country"):
        # exploitant renseigné après coup (série militaire type QA400) : le pays se déduit de lui
        out["country"] = regs.country_for((existing or {}).get("registration"), out.get("owner"))
    if "country" in data:
        # choix explicite dans le formulaire : un code pays le fixe, « Auto » (vide) relance la détection
        c = str(data.get("country") or "").strip().upper()
        if c and not re.fullmatch(r"[A-Z]{2}", c):
            raise HTTPException(422, "invalid_country")
        out["country"] = c or regs.country_for(merged.get("registration"), merged.get("owner"))
    if "airport" in out or "place" in out:
        out["airport"], out["place"] = _split_place(out.get("airport"), out.get("place"))
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
    # Immatriculation d'essai (facultative, tout type de vol) : normalisée
    if "test_registration" in out:
        out["test_registration"] = regs.normalize(out["test_registration"]) or None if out["test_registration"] else None

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
    if any(k in out for k in ("date", "airport", "place", "lat", "lng")) or not existing:
        # Sans aéroport, l'heure locale est celle du fuseau de l'aéroport le plus proche des coordonnées
        tz = "UTC" if geo.airport(merged.get("airport")) else geo.tz_at(merged.get("lat"), merged.get("lng"))
        out["date_utc"] = geo.local_to_utc(merged.get("date"), merged.get("airport"), fallback_tz=tz)
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
    outings_svc.attach(spot_id)
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



# --------------------------------------------------------------------------- #
# Patrouilles : un spot par avion, photo partagée, reliés par patrol_id
# --------------------------------------------------------------------------- #
MEMBER_FIELDS = ("registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner", "airline_icao", "livery",
                 "test_registration")
INHERIT = ("aircraft", "aircraft_icao", "manufacturer", "owner", "airline_icao", "livery", "military", "flight_type",
           "date", "airport", "place", "location_id", "lat", "lng", "description", "camera", "lens", "focal", "aperture",
           "iso", "shutter", "rating")
# Ce qui décrit la photo et la prise de vue : modifié sur un avion, appliqué aux autres avions de la même photo
SHARED = ("date", "date_utc", "sun_elevation", "airport", "place", "location_id", "lat", "lng", "description", "flight_type",
          "camera", "lens", "focal", "aperture", "iso", "shutter", "rating",
          "image", "thumb", "image_w", "image_h", "phash", "exif_json")
IDENTITY = ("aircraft", "aircraft_icao", "manufacturer", "owner", "airline_icao", "livery", "military")
INHERIT_RAW = ("exif_json", "image", "thumb", "image_w", "image_h", "phash")


def _prepare_members(base: dict, members: list | None) -> list[dict]:
    """Lignes prêtes à insérer pour les autres avions d'une patrouille (hérite de la photo, de la date, du lieu)."""
    rows: list[dict] = []
    seen = {base.get("registration")} if not regs.is_unknown(base.get("registration")) else set()
    for m in members or []:
        if not isinstance(m, dict):
            continue
        own = m.get("inherit_aircraft") is False          # autre appareil que l'avion principal : ni type ni compagnie hérités
        inp = {k: base[k] for k in INHERIT if base.get(k) not in (None, "") and not (own and k in IDENTITY)}
        inp.update({k: v for k, v in m.items() if k in MEMBER_FIELDS and v not in (None, "")})
        inp["unknown_registration"] = bool(m.get("unknown_registration"))
        row = prepare(inp)
        if row["registration"] in seen:
            continue
        seen.add(row["registration"])
        row.update({k: base[k] for k in INHERIT_RAW if base.get(k) is not None})
        rows.append(row)
    return rows


def _gc_patrols() -> None:
    """Une patrouille sans spot disparaît ; en mode détaillé, avec un seul avion restant, elle se dissout.
    Une patrouille « mode simple » (un seul spot, is_patrol) reste telle quelle."""
    for r in q("SELECT p.id_patrol FROM patrols p LEFT JOIN spotting s ON s.patrol_id = p.id_patrol "
               "GROUP BY p.id_patrol HAVING COUNT(s.id_spotting) < 2 AND COALESCE(SUM(s.is_patrol), 0) = 0"):
        execute("UPDATE spotting SET patrol_id = NULL WHERE patrol_id = ?", (r["id_patrol"],))
        execute("DELETE FROM patrols WHERE id_patrol = ?", (r["id_patrol"],))


def patrol_key(name: str) -> str:
    """Clé d'immatriculation d'une patrouille « mode simple » : son nom en majuscules, espaces → tirets."""
    return re.sub(r"[\s_]+", "-", name.strip().upper())[:60]


def _simple_country(info: dict) -> str | None:
    c = str(info.get("country") or "").strip().upper()
    return c if re.fullmatch(r"[A-Z]{2}", c) else None


def _simple_size(info: dict) -> int | None:
    try:
        n = int(info.get("size"))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _free_files(s: dict) -> None:
    """Supprime les fichiers d'un spot ; la photo reste si un autre spot (patrouille) la partage encore."""
    if s.get("image") and q1("SELECT 1 FROM spotting WHERE image = ? LIMIT 1", (s["image"],)):
        media.delete_audio(s.get("atc_audio"))
        return
    delete_spot_files(s)


def _insert_members(rows: list[dict], patrol_id: int, tags: list, bg: BackgroundTasks) -> dict:
    extra: dict = {"crossref": [], "achievements": [], "wishes": []}
    for row in rows:
        row["patrol_id"] = patrol_id
        row["created_at"] = row["updated_at"] = now_iso()
        if row.get("military") is None:
            row["military"] = 1 if regs.looks_military(row.get("owner"), row.get("aircraft")) else 0
        cur = execute(f"INSERT INTO spotting({', '.join(row)}) VALUES({', '.join('?' * len(row))})", list(row.values()))
        set_tags(cur.lastrowid, tags)
        e = _post_save(cur.lastrowid, row["registration"], True, bool(row.get("airport") and row.get("date_utc")), bg)
        for k, v in e.items():
            extra[k] = extra.get(k, []) + v
    return extra


def _propagate(spot_id: int, patrol_id: int | None, out: dict, payload: dict, bg: BackgroundTasks, before: dict | None = None) -> None:
    """Applique aux autres avions de la photo les informations communes qui viennent d'être modifiées.

    Une patrouille réunit des avions vus à des moments différents : seuls les avions de la même photo (à défaut, de la
    même date, quand il n'y a pas de photo) sont concernés, jamais les autres avions rattachés à la patrouille."""
    if not patrol_id:
        return
    before = before or {}
    if before.get("image"):
        sibs = [r["id_spotting"] for r in q("SELECT id_spotting FROM spotting WHERE patrol_id = ? AND id_spotting <> ? AND is_patrol = 0 "
                                            "AND image = ?", (patrol_id, spot_id, before["image"]))]
    else:
        sibs = [r["id_spotting"] for r in q("SELECT id_spotting FROM spotting WHERE patrol_id = ? AND id_spotting <> ? AND is_patrol = 0 "
                                            "AND image IS NULL AND date IS ?", (patrol_id, spot_id, before.get("date")))]
    if not sibs:
        return
    common = {k: out[k] for k in SHARED if k in out}
    wx = settings_modules_weather()
    for sid in sibs:
        if common:
            execute(f"UPDATE spotting SET {', '.join(f'{k} = ?' for k in common)}, updated_at = ? WHERE id_spotting = ?",
                    [*common.values(), now_iso(), sid])
        if "tags" in payload:
            set_tags(sid, payload["tags"])
        if common:
            outings_svc.attach(sid)
            if wx and ("date_utc" in common or "airport" in common):
                execute("UPDATE spotting SET weather_status = 'pending' WHERE id_spotting = ?", (sid,))
                bg.add_task(weather.update_spot_weather, sid)


def settings_modules_weather() -> bool:
    return bool(get_settings()["modules"].get("weather", True))


def find_patrol(name: str | None, exclude: int | None = None) -> int | None:
    """Patrouille existante portant ce nom (sans tenir compte des majuscules ni des accents), la patrouille « mode
    simple » en premier : un avion identifié rejoint ainsi celle déjà saisie en mode simple."""
    key = regs._fold((name or "").strip())  # noqa: SLF001
    if not key:
        return None
    best = None
    for r in q("SELECT p.id_patrol id, p.name, COALESCE(MAX(s.is_patrol), 0) simple FROM patrols p "
               "LEFT JOIN spotting s ON s.patrol_id = p.id_patrol WHERE p.name IS NOT NULL GROUP BY p.id_patrol ORDER BY p.id_patrol"):
        if r["id"] == exclude or regs._fold(r["name"].strip()) != key:  # noqa: SLF001
            continue
        if best is None or (r["simple"] and not best[1]):
            best = (r["id"], r["simple"])
    return best[0] if best else None


def _patrol_id(spot: dict | None, info: dict) -> int:
    """Patrouille du spot : rejoint celle qui porte déjà ce nom, sinon renomme l'actuelle ou en crée une."""
    name = (info.get("name") or "").strip()[:80] or None
    pid = (spot or {}).get("patrol_id")
    same = find_patrol(name, exclude=pid)
    if same:
        return same
    if pid:
        if "name" in info:
            execute("UPDATE patrols SET name = ? WHERE id_patrol = ?", (name, pid))
        return pid
    return execute("INSERT INTO patrols(name, created_at) VALUES(?, ?)", (name, now_iso())).lastrowid


def _duplicates_of(rows: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in rows:
        out += find_duplicates(r["registration"], r.get("airport"), r.get("date"), place=r.get("place"))
    return out


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
    patrol_in = payload.get("patrol") if isinstance(payload.get("patrol"), dict) else None
    simple = bool(patrol_in and patrol_in.get("simple"))
    if simple:
        if not (patrol_in.get("name") or "").strip():
            raise HTTPException(422, "patrol_name_required")
        payload["registration"] = patrol_key(patrol_in["name"])      # la patrouille tient lieu d'immatriculation
    out: dict = {}
    _apply_image(out, image, payload)
    merged_input = {**payload, **{k: v for k, v in out.items() if k in EDITABLE and not payload.get(k)}}
    if not merged_input.get("airport") and not merged_input.get("place") and get_settings().get("default_airport"):
        merged_input["airport"] = get_settings()["default_airport"]
    out.update(prepare(merged_input))
    member_rows: list[dict] = []
    if simple:
        out.update({"country": _simple_country(patrol_in), "is_patrol": 1, "patrol_size": _simple_size(patrol_in)})
    elif patrol_in:
        if out.get("military") is None:
            out["military"] = 1 if regs.looks_military(out.get("owner"), out.get("aircraft")) else 0
        try:
            member_rows = _prepare_members(out, patrol_in.get("members"))
        except HTTPException:
            media.delete_image(out.get("image"), out.get("thumb"))
            raise
    if not force:
        dups = find_duplicates(out["registration"], out.get("airport"), out.get("date"), place=out.get("place")) + _duplicates_of(member_rows)
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
    if patrol_in:
        out["patrol_id"] = _patrol_id(None, patrol_in)
    cols = ", ".join(out.keys())
    cur = execute(f"INSERT INTO spotting({cols}) VALUES({', '.join('?' * len(out))})", list(out.values()))
    spot_id = cur.lastrowid
    set_tags(spot_id, payload.get("tags") or [])
    extra = _post_save(spot_id, out["registration"], True, bool(out.get("airport") and out.get("date_utc")), bg)
    if member_rows:
        more = _insert_members(member_rows, out["patrol_id"], payload.get("tags") or [], bg)
        for k, v in more.items():
            extra[k] = extra.get(k, []) + v
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
    if existing.get("is_patrol"):
        # Patrouille « mode simple » : l'immatriculation est la clé tirée de son nom
        payload.pop("registration", None)
        payload.pop("unknown_registration", None)
        info = payload.get("patrol") if isinstance(payload.get("patrol"), dict) else {}
        if payload.get("patrol", 0) is None:
            payload.pop("patrol")
        elif (info.get("name") or "").strip():
            payload["registration"] = patrol_key(info["name"])
        elif "name" in info:
            raise HTTPException(422, "patrol_name_required")
    out: dict = {}
    drop_old: tuple | None = None
    if image and image.filename:
        drop_old = (existing.get("image"), existing.get("thumb"))
        _apply_image(out, image, payload)
    elif payload.get("remove_image"):
        drop_old = (existing.get("image"), existing.get("thumb"))
        out.update({"image": None, "thumb": None, "image_w": None, "image_h": None, "phash": None})
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
    if existing.get("is_patrol"):
        out["country"] = existing.get("country")        # nationalité de la patrouille, pas déduite d'une immatriculation
        if isinstance(payload.get("patrol"), dict):
            if "size" in payload["patrol"]:
                out["patrol_size"] = _simple_size(payload["patrol"])
            if "country" in payload["patrol"]:
                out["country"] = _simple_country(payload["patrol"])
    out["updated_at"] = now_iso()
    sets = ", ".join(f"{k} = ?" for k in out)
    patrol_in = payload.get("patrol") if isinstance(payload.get("patrol"), dict) else None
    member_rows: list[dict] = []
    if patrol_in and patrol_in.get("members"):
        member_rows = _prepare_members({**existing, **out}, patrol_in["members"])
        dups = _duplicates_of(member_rows)
        if dups and not payload.get("force"):
            raise HTTPException(409, detail={"code": "duplicate", "duplicates": dups})
    if patrol_in is not None:
        out["patrol_id"] = _patrol_id(existing, patrol_in)
        sets = ", ".join(f"{k} = ?" for k in out)
    elif "patrol" in payload and payload["patrol"] is None:
        out["patrol_id"] = None
        sets = ", ".join(f"{k} = ?" for k in out)
    execute(f"UPDATE spotting SET {sets} WHERE id_spotting = ?", list(out.values()) + [spot_id])
    if not existing.get("is_patrol"):
        _propagate(spot_id, out.get("patrol_id", existing.get("patrol_id")), out, payload, bg, existing)
    if drop_old and drop_old[0]:
        if q1("SELECT 1 FROM spotting WHERE image = ? LIMIT 1", (drop_old[0],)):
            pass                           # la photo reste utilisée par un autre avion de la patrouille
        else:
            media.delete_image(*drop_old)
    if "tags" in payload:
        set_tags(spot_id, payload["tags"])
    if member_rows:
        _insert_members(member_rows, out["patrol_id"], payload.get("tags") or [t["id_tag"] for t in q(
            "SELECT id_tag FROM spotting_tags WHERE id_spotting = ?", (spot_id,))], bg)
    _gc_patrols()
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


def _remove_spots(rows: list[dict]) -> list[int]:
    """Retire des spots : à la corbeille (récupérables) ou définitivement si la corbeille est désactivée."""
    if not rows:
        return []
    conn = db()
    ids = [r["id_spotting"] for r in rows]
    tids = trash.put("spot", rows) if trash.enabled() else []
    conn.execute(f"DELETE FROM spotting WHERE id_spotting IN ({','.join('?' * len(ids))})", ids)
    conn.commit()
    if not trash.enabled():
        for r in rows:
            _free_files(r)
    _gc_patrols()
    outings_svc.gc()
    return tids


@router.delete("/{spot_id}")
def delete_spot(spot_id: int):
    s = q1("SELECT * FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s:
        raise HTTPException(404, "not_found")
    tid = _remove_spots([s])
    return {"deleted": spot_id, "trash": tid[0] if tid else None}


class Bulk(BaseModel):
    ids: list[int]
    action: str
    value: Any = None


@router.post("/bulk")
def bulk(body: Bulk, bg: BackgroundTasks):
    if not body.ids:
        return {"updated": 0}
    marks = ",".join("?" * len(body.ids))
    conn = db()
    if body.action == "delete":
        rows = q(f"SELECT * FROM spotting WHERE id_spotting IN ({marks})", body.ids)
        return {"updated": len(rows), "trash": _remove_spots(rows)}
    elif body.action in ("add_tag", "remove_tag"):
        tag_id = int(body.value)
        for i in body.ids:
            if body.action == "add_tag":
                conn.execute("INSERT OR IGNORE INTO spotting_tags VALUES(?, ?)", (i, tag_id))
            else:
                conn.execute("DELETE FROM spotting_tags WHERE id_spotting=? AND id_tag=?", (i, tag_id))
        conn.commit()
    elif body.action == "set":
        return _bulk_set(body.ids, body.value, bg)
    elif body.action == "favorite":
        conn.execute(f"UPDATE spotting SET favorite=? WHERE id_spotting IN ({marks})", [1 if body.value else 0] + body.ids)
        conn.commit()
    else:
        raise HTTPException(400, "unknown_action")
    return {"updated": len(body.ids)}


# Champs modifiables en masse (liste blanche) ; « prepare » applique les mêmes règles qu'à l'édition d'un spot
BULK_FIELDS = ("country", "airport", "place", "flight_type", "owner", "airline_icao", "rating", "aircraft", "aircraft_icao",
               "manufacturer", "military", "livery", "registration")


def _bulk_set(ids: list[int], value: Any, bg: BackgroundTasks) -> dict:
    vals = {k: v for k, v in (value or {}).items() if k in BULK_FIELDS} if isinstance(value, dict) else {}
    if not vals:
        raise HTTPException(400, "nothing_to_set")
    rows = q(f"SELECT * FROM spotting WHERE id_spotting IN ({','.join('?' * len(ids))})", ids)
    n = 0
    for r in rows:
        v = dict(vals)
        if r.get("is_patrol"):
            v.pop("registration", None)             # la clé d'une patrouille « mode simple » est son nom
            v.pop("country", None)
            if not v:
                continue
        try:
            out = prepare(v, r)
        except HTTPException:
            continue
        if r.get("is_patrol"):
            out["country"] = r.get("country")
        out["updated_at"] = now_iso()
        execute(f"UPDATE spotting SET {', '.join(f'{k} = ?' for k in out)} WHERE id_spotting = ?", list(out.values()) + [r["id_spotting"]])
        if not r.get("is_patrol"):
            _propagate(r["id_spotting"], r.get("patrol_id"), out, v, bg, r)
        _post_save(r["id_spotting"], out.get("registration", r["registration"]), False,
                   out.get("date_utc") != r.get("date_utc") or out.get("airport", r["airport"]) != r["airport"], bg)
        n += 1
    return {"updated": n}
