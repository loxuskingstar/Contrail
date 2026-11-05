"""Étiquettes, recherche d'appareil / d'aéroport, analyse de photo, réglages, notifications, succès."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..core import (APP_VERSION, ENV_KEYS, config_source, db, execute, get_config, get_settings, q, q1,
                    safe_media_path, save_config, set_settings)
from ..services import aircraft, gamification, geo, media, storage
from ..services import registration as regs

router = APIRouter(tags=["misc"])


@router.get("/api/health")
def health():
    return {"ok": True, "version": APP_VERSION}


class MaintenanceIn(BaseModel):
    purge_orphans: bool = False


@router.get("/api/storage")
def storage_report():
    return storage.report()


@router.post("/api/maintenance")
def maintenance(body: MaintenanceIn | None = None):
    return storage.maintain(bool(body and body.purge_orphans))


# --------------------------------------------------------------------------- #
# Session de test (base isolée, jeu de données fictif sans images)
# --------------------------------------------------------------------------- #
class SessionIn(BaseModel):
    profile: str


@router.get("/api/session")
def session_info():
    from ..core import PROFILES, current_profile
    return {"profile": current_profile(), "sandbox_exists": (PROFILES["test"] / "contrail.db").exists()}


@router.post("/api/session")
def session_switch(body: SessionIn, response: Response):
    from ..services import sandbox
    if body.profile == "test":
        sandbox.ensure_sandbox()
        response.set_cookie("contrail_profile", "test", max_age=60 * 60 * 24 * 365, samesite="lax", httponly=True)
    else:
        response.delete_cookie("contrail_profile")
    return {"profile": "test" if body.profile == "test" else "main"}


@router.post("/api/session/reset")
def session_reset():
    from ..core import current_profile
    from ..services import sandbox
    if current_profile() != "test":
        raise HTTPException(400, "not_in_test_session")
    sandbox.reset_sandbox()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Étiquettes
# --------------------------------------------------------------------------- #
class TagIn(BaseModel):
    name: str
    color: str = "#64748b"


@router.get("/api/tags")
def list_tags():
    return q("SELECT t.*, (SELECT COUNT(*) FROM spotting_tags st WHERE st.id_tag = t.id_tag) AS count "
             "FROM tags t ORDER BY t.name COLLATE NOCASE")


@router.post("/api/tags")
def create_tag(t: TagIn):
    name = t.name.strip()[:40]
    if not name:
        raise HTTPException(422, "name_required")
    if q1("SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE", (name,)):
        raise HTTPException(409, "tag_exists")
    cur = execute("INSERT INTO tags(name, color) VALUES(?, ?)", (name, t.color))
    return q1("SELECT * FROM tags WHERE id_tag = ?", (cur.lastrowid,))


@router.put("/api/tags/{tag_id}")
def update_tag(tag_id: int, t: TagIn):
    execute("UPDATE tags SET name=?, color=? WHERE id_tag=?", (t.name.strip()[:40], t.color, tag_id))
    return q1("SELECT * FROM tags WHERE id_tag = ?", (tag_id,))


@router.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int):
    execute("DELETE FROM tags WHERE id_tag = ?", (tag_id,))
    return {"deleted": tag_id}


# --------------------------------------------------------------------------- #
# Recherche
# --------------------------------------------------------------------------- #
@router.get("/api/lookup/aircraft/{reg}")
def lookup_aircraft(reg: str, refresh: bool = False):
    if not regs.normalize(reg):
        raise HTTPException(422, "registration_required")
    return aircraft.lookup(reg, refresh=refresh)


@router.get("/api/lookup/hex/{icao24}")
def lookup_hex(icao24: str, callsign: str = ""):
    from ..services import actypes
    d = dict(aircraft.by_icao24(icao24) or {})
    if d.get("aircraft_icao") and not d.get("type_name"):
        d["type_name"] = actypes.name(d["aircraft_icao"])
    d["cls"] = actypes.classify(d.get("aircraft_icao"), None, d.get("aircraft"))
    if callsign:
        d["route"] = aircraft.hexdb_route(callsign)
    if d.get("registration"):
        r = regs.normalize(d["registration"])
        d["spotted"] = q1("SELECT COUNT(*) n FROM spotting WHERE registration = ?", (r,))["n"]
        own = q1("SELECT id_spotting, image, thumb FROM spotting WHERE registration = ? AND image IS NOT NULL "
                 "ORDER BY favorite DESC, date DESC LIMIT 1", (r,))
        if own:
            d["own_photo"] = own
    return d


@router.get("/api/lookup/registration-country/{reg}")
def reg_country(reg: str):
    return {"registration": regs.normalize(reg), "country": regs.country_of(reg)}


@router.get("/api/airports/search")
def airports_search(q_: str = "", limit: int = 12, q: str = ""):  # noqa: A002 - "q" exposé côté API
    return geo.search_airports(q or q_, limit)


@router.get("/api/airports/{code}")
def airport_info(code: str):
    a = geo.airport(code)
    if not a:
        raise HTTPException(404, "not_found")
    return a


@router.post("/api/media/analyze")
def analyze_photo(image: UploadFile = File(...), ocr: bool = True, airport: str = ""):
    """Pré-analyse d'une photo avant enregistrement : EXIF + OCR de l'immatriculation."""
    raw = image.file.read()
    try:
        img = media.open_image(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, "invalid_image") from e
    exif = media.extract_exif(img)
    out = {"exif": exif, "ocr": {"available": media.ocr_available(), "candidates": []}}
    if exif.get("lat") is not None:
        near = nearest_airport(exif["lat"], exif["lng"])
        if near:
            out["nearest_airport"] = near
    if ocr and get_settings()["modules"].get("ocr", True):
        out["ocr"] = media.ocr_registration(raw)
        out["ocr"].pop("text", None)
        out["ocr"]["candidates"] = rank_candidates(out["ocr"]["candidates"],
                                                  airport or (out.get("nearest_airport") or {}).get("icao"))
    return out


def rank_candidates(cands: list[dict], airport: str | None) -> list[dict]:
    """Affine le classement OCR : appareils déjà connus et pays de l'aéroport favorisés."""
    ap = geo.airport(airport) if airport else None
    for c in cands:
        reg = c["registration"]
        if q1("SELECT 1 FROM spotting WHERE registration = ? UNION SELECT 1 FROM aircraft_cache WHERE registration = ? "
              "UNION SELECT 1 FROM fleets WHERE registration = ? UNION SELECT 1 FROM wishes WHERE kind = 'aircraft' AND value = ?",
              (reg, reg, reg, reg)):
            c["score"] = round(c["score"] + 0.5, 2)
            c["known"] = True
        if ap and c.get("country") == ap["country"]:
            c["score"] = round(c["score"] + 0.3, 2)
    return sorted(cands, key=lambda c: -c["score"])


def nearest_airport(lat: float, lng: float, max_km: float = 15) -> dict | None:
    best, best_d = None, max_km
    for icao, a in geo._airports().items():  # noqa: SLF001
        if abs(a["lat"] - lat) > 0.3 or abs(a["lon"] - lng) > 0.4:
            continue
        d = geo.haversine_km(lat, lng, a["lat"], a["lon"])
        # On préfère les aéroports dotés d'un code IATA (aéroports commerciaux)
        d_eff = d * (0.6 if a.get("iata") else 1)
        if d_eff < best_d:
            best, best_d = icao, d_eff
    return geo.airport(best) if best else None


@router.get("/api/airports/nearest/{lat}/{lng}")
def airport_nearest(lat: float, lng: float):
    return nearest_airport(lat, lng, 40) or {}


# --------------------------------------------------------------------------- #
# Base de référence des appareils (hors-ligne)
# --------------------------------------------------------------------------- #
@router.get("/api/refdb")
def refdb_status():
    from ..services import refdb
    return refdb.status()


class RefdbDownload(BaseModel):
    source: str = "tar1090"


@router.post("/api/refdb/download")
def refdb_download(body: RefdbDownload | None = None):
    from ..services import refdb
    src = (body.source if body else "tar1090")
    if src not in ("tar1090", "opensky"):
        raise HTTPException(422, "bad_source")
    if not refdb.start_download(refdb.DEFAULT_URL if src == "tar1090" else "opensky"):
        raise HTTPException(409, "refdb_busy")
    return refdb.status()


@router.post("/api/refdb/upload")
def refdb_upload(file: UploadFile = File(...)):
    import shutil
    import uuid

    from ..core import DATA_DIR
    from ..services import refdb
    tmp = DATA_DIR / "tmp" / f"refdb-{uuid.uuid4().hex}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    if not refdb.start_import(tmp, file.filename or "fichier"):
        tmp.unlink(missing_ok=True)
        raise HTTPException(409, "refdb_busy")
    return refdb.status()


@router.delete("/api/refdb")
def refdb_delete():
    from ..services import refdb
    refdb.delete()
    return refdb.status()


# --------------------------------------------------------------------------- #
# Médias protégés
# --------------------------------------------------------------------------- #
@router.get("/media/{kind}/{path:path}")
def serve_media(kind: str, path: str):
    if kind not in ("images", "thumbs", "audio"):
        raise HTTPException(404)
    p = safe_media_path(kind, path)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# --------------------------------------------------------------------------- #
# Réglages et configuration
# --------------------------------------------------------------------------- #
@router.get("/api/settings")
def read_settings():
    return get_settings()


@router.put("/api/settings")
def write_settings(values: dict):
    return set_settings(values)


def _mask(v: str) -> str:
    return (v[:3] + "•" * 6 + v[-2:]) if len(v) > 8 else ("•" * len(v) if v else "")


SECRET_KEYS = {"airlabs_api_key", "aviationstack_api_key", "opensky_client_secret"}


@router.get("/api/config")
def read_config():
    out = {}
    for k in ENV_KEYS:
        v = get_config(k)
        out[k] = {"set": bool(v), "source": config_source(k),
                  "value": _mask(v) if k in SECRET_KEYS else v}
    out["ocr_available"] = media.ocr_available()
    out["version"] = APP_VERSION
    return out


@router.put("/api/config")
def write_config(values: dict):
    clean = {k: (str(v).strip() if v is not None else "") for k, v in values.items()
             if k in ENV_KEYS and "•" not in str(v or "")}
    save_config(clean)
    return read_config()


# --------------------------------------------------------------------------- #
# Notifications
# --------------------------------------------------------------------------- #
@router.get("/api/notifications")
def list_notifications(limit: int = 50, since_id: int = 0):
    rows = q("SELECT * FROM notifications WHERE id > ? ORDER BY id DESC LIMIT ?", (since_id, limit))
    unread = q1("SELECT COUNT(*) n FROM notifications WHERE read = 0")["n"]
    return {"items": rows, "unread": unread}


@router.post("/api/notifications/read")
def mark_read(ids: list[int] | None = None):
    if ids:
        execute(f"UPDATE notifications SET read = 1 WHERE id IN ({','.join('?' * len(ids))})", ids)
    else:
        execute("UPDATE notifications SET read = 1")
    return {"ok": True}


@router.delete("/api/notifications")
def clear_notifications():
    execute("DELETE FROM notifications")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Succès
# --------------------------------------------------------------------------- #
@router.get("/api/achievements")
def achievements():
    # Rattrape les paliers atteints sans nouvel enregistrement (import, nouvelle série de succès…)
    gamification.evaluate()
    return gamification.listing()


@router.post("/api/achievements/evaluate")
def achievements_evaluate():
    return {"new": gamification.evaluate()}


# --------------------------------------------------------------------------- #
# Recherche globale (palette de commandes)
# --------------------------------------------------------------------------- #
@router.get("/api/search")
def global_search(q_: str = "", q: str = ""):  # noqa: A002
    term = (q or q_).strip()
    if len(term) < 2:
        return {"spots": [], "airframes": [], "flights": [], "airports": [], "tags": []}
    like = f"%{term}%"
    conn = db()
    spots = conn.execute(
        "SELECT id_spotting, registration, aircraft_icao, aircraft, owner, airport, date, thumb FROM spotting "
        "WHERE registration LIKE ? OR owner LIKE ? OR aircraft LIKE ? OR livery LIKE ? OR description LIKE ? "
        "ORDER BY date DESC LIMIT 8", (like,) * 5).fetchall()
    airframes = conn.execute(
        "SELECT registration, MAX(aircraft) aircraft, COUNT(*) n FROM spotting WHERE registration LIKE ? "
        "GROUP BY registration ORDER BY n DESC LIMIT 6", (like,)).fetchall()
    flights = conn.execute(
        "SELECT id_flight, date, dep_icao, arr_icao, flight_number, airline FROM flights WHERE flight_number LIKE ? "
        "OR airline LIKE ? OR registration LIKE ? OR dep_icao LIKE ? OR arr_icao LIKE ? ORDER BY date DESC LIMIT 6",
        (like,) * 5).fetchall()
    tags = conn.execute("SELECT * FROM tags WHERE name LIKE ? LIMIT 5", (like,)).fetchall()
    return {"spots": spots, "airframes": airframes, "flights": flights,
            "airports": geo.search_airports(term, 5), "tags": tags}
