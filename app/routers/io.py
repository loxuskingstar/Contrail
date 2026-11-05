"""Import CSV de masse, exports complets, sauvegardes et restauration."""
from __future__ import annotations

import csv
import io
import json
import re
import shutil
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse

from ..core import APP_VERSION, DIRS, db, execute, now_iso, q, q1
from ..services import aircraft as ac
from ..services import backup, gamification, geo
from ..services import registration as regs
from . import flights as flights_router
from .spots import find_duplicates, prepare, set_tags

router = APIRouter(tags=["io"])

SPOT_SYNONYMS = {
    "registration": ["registration", "reg", "regist", "immatriculation", "immat", "tail", "tail number",
                     "aircraft registration", "matricula", "registro", "登録記号", "reg."],
    "aircraft": ["aircraft", "aircraft type", "type", "model", "modele", "modèle", "avion", "aircraft model",
                 "modelo", "機種"],
    "aircraft_icao": ["icao type", "type code", "icao_type", "typecode", "type designator", "icao"],
    "msn": ["msn", "c/n", "cn", "serial", "serial number", "construction number", "msn/cn", "s/n"],
    "owner": ["airline", "operator", "owner", "compagnie", "operateur", "opérateur", "aerolinea", "aerolínea",
              "航空会社", "airline/operator"],
    "livery": ["livery", "livrée", "livree", "special livery", "librea", "塗装"],
    "airport": ["airport", "location", "aéroport", "aeroport", "airport icao", "place", "lieu", "aeropuerto",
                "空港", "spotted at"],
    "date": ["date", "date taken", "photo date", "date/time", "datetime", "fecha", "日付", "taken", "date de prise"],
    "time": ["time", "heure", "hora", "時刻"],
    "description": ["notes", "note", "description", "comment", "comments", "remarks", "remarques", "commentaire",
                    "observaciones", "メモ"],
    "tags": ["tags", "étiquettes", "etiquettes", "keywords", "labels", "etiquetas", "タグ"],
    "military": ["military", "militaire", "militar"],
    "flight_type": ["flight type", "type de vol", "tipo de vuelo"],
    "test_registration": ["test registration", "test reg", "immat d'essai", "immatriculation d'essai", "matrícula de prueba"],
}

FLIGHT_SYNONYMS = {
    "date": ["date", "fecha", "日付"],
    "flight_number": ["flight number", "flight", "flight no", "numéro de vol", "vol", "número de vuelo", "便名"],
    "dep_icao": ["from", "departure", "dep", "origin", "départ", "depart", "origen", "出発"],
    "arr_icao": ["to", "arrival", "arr", "destination", "arrivée", "arrivee", "destino", "到着"],
    "dep_time": ["dep time", "departure time", "heure de départ", "std", "atd"],
    "arr_time": ["arr time", "arrival time", "heure d'arrivée", "sta", "ata"],
    "duration_min": ["duration", "durée", "duracion", "duración"],
    "airline": ["airline", "compagnie", "aerolinea", "aerolínea", "航空会社"],
    "aircraft": ["aircraft", "aircraft type", "type", "avion", "機種"],
    "registration": ["registration", "reg", "immatriculation", "tail", "matricula"],
    "seat": ["seat number", "seat", "siège", "siege", "asiento", "座席"],
    "seat_type": ["seat type", "type de siège"],
    "cabin_class": ["flight class", "class", "classe", "cabin", "clase"],
    "reason": ["flight reason", "reason", "motif", "motivo"],
    "notes": ["note", "notes", "comment", "remarques"],
}


def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower().replace("_", " "))


def _read_csv(raw: bytes) -> tuple[list[str], list[dict]]:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:5000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    rows = [r for r in reader if any((v or "").strip() for v in r.values())]
    return [h for h in (reader.fieldnames or []) if h], rows


def suggest_mapping(headers: list[str], synonyms: dict) -> dict:
    mapping = {}
    normed = {h: _norm_header(h) for h in headers}
    for field, syns in synonyms.items():
        for h, n in normed.items():
            if n in syns and h not in mapping.values():
                mapping[field] = h
                break
    return mapping


DATE_FORMATS_DAYFIRST = ["%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%d.%m.%Y %H:%M", "%d.%m.%Y",
                         "%d-%m-%Y %H:%M", "%d-%m-%Y", "%d/%m/%y", "%d/%m/%y %H:%M"]
DATE_FORMATS_MONTHFIRST = ["%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y"]
DATE_FORMATS_ISO = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
                    "%Y/%m/%d %H:%M", "%Y/%m/%d", "%Y:%m:%d %H:%M:%S", "%d %b %Y", "%d %B %Y", "%b %d, %Y"]


def parse_date(value: str | None, time_value: str | None = None, dayfirst: bool = True) -> str | None:
    if not value:
        return None
    v = value.strip().replace("Z", "")
    if time_value and time_value.strip():
        v = f"{v} {time_value.strip()[:8]}"
    formats = DATE_FORMATS_ISO + (DATE_FORMATS_DAYFIRST + DATE_FORMATS_MONTHFIRST if dayfirst
                                  else DATE_FORMATS_MONTHFIRST + DATE_FORMATS_DAYFIRST)
    for fmt in formats:
        try:
            dt = datetime.strptime(v, fmt)
            has_time = "%H" in fmt
            return dt.strftime("%Y-%m-%dT%H:%M") if has_time else dt.strftime("%Y-%m-%dT12:00")
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(v).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def parse_airport(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    m = re.search(r"\b([A-Z]{4})\b\)?\s*$", v) or re.search(r"[(/]\s*([A-Z]{4})\s*\)", v)
    if m and geo.airport(m.group(1)):
        return m.group(1)
    m = re.search(r"\(([A-Z]{3})(?:/[A-Z]{4})?\)", v) or re.fullmatch(r"([A-Z]{3,4})", v.upper())
    if m and geo.airport(m.group(1)):
        return geo.resolve_icao(m.group(1))
    res = geo.search_airports(v, 1)
    return res[0]["icao"] if res else None


def _icao_in_parens(value: str | None, length: int) -> str | None:
    if not value:
        return None
    m = re.search(r"\(([A-Z0-9]{2})?/?([A-Z0-9]{%d})\)" % length, value)
    return m.group(2) if m else None


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
@router.post("/api/import/preview")
def import_preview(file: UploadFile = File(...), kind: str = Form("spots")):
    raw = file.file.read()
    headers, rows = _read_csv(raw)
    if not headers:
        raise HTTPException(422, "empty_csv")
    syn = SPOT_SYNONYMS if kind == "spots" else FLIGHT_SYNONYMS
    token = uuid.uuid4().hex
    (DIRS["tmp"] / f"import-{token}.csv").write_bytes(raw)
    return {"token": token, "headers": headers, "rows": len(rows), "sample": rows[:8],
            "mapping": suggest_mapping(headers, syn), "fields": list(syn.keys())}


def _enrich_after_import(ids: list[int]) -> None:
    regs_done: dict[str, dict] = {}
    for sid in ids:
        s = q1("SELECT * FROM spotting WHERE id_spotting = ?", (sid,))
        if not s:
            continue
        if s["registration"] not in regs_done:
            try:
                regs_done[s["registration"]] = ac.lookup(s["registration"])
            except Exception:  # noqa: BLE001
                regs_done[s["registration"]] = {}
        info = regs_done[s["registration"]]
        upd = {k: info[k] for k in ("aircraft", "aircraft_icao", "manufacturer", "msn", "owner", "airline_icao", "icao24")
               if info.get(k) and not s.get(k)}
        if upd:
            execute(f"UPDATE spotting SET {', '.join(f'{k}=?' for k in upd)} WHERE id_spotting=?", list(upd.values()) + [sid])


@router.post("/api/import/commit")
def import_commit(bg: BackgroundTasks, token: str = Form(...), kind: str = Form("spots"), mapping: str = Form("{}"),
                  dayfirst: bool = Form(True), skip_duplicates: bool = Form(True), enrich: bool = Form(False),
                  default_airport: str = Form("")):
    path = DIRS["tmp"] / f"import-{re.sub(r'[^a-f0-9]', '', token)}.csv"
    if not path.exists():
        raise HTTPException(404, "import_expired")
    headers, rows = _read_csv(path.read_bytes())
    m = json.loads(mapping or "{}")
    imported, skipped, errors, ids = 0, 0, [], []

    def get(row, field):
        h = m.get(field)
        return (row.get(h) or "").strip() if h else ""

    patrols_seen: dict[tuple, int] = {}      # (nom, jour, lieu) → patrouille : les lignes d'une même patrouille se regroupent

    for i, row in enumerate(rows, start=2):
        try:
            if kind == "spots":
                reg = get(row, "registration")
                if not reg:
                    skipped += 1
                    continue
                data = {
                    "registration": reg, "aircraft": get(row, "aircraft") or None,
                    "aircraft_icao": get(row, "aircraft_icao") or None, "msn": get(row, "msn") or None,
                    "owner": get(row, "owner") or None, "livery": get(row, "livery") or None,
                    "airport": parse_airport(get(row, "airport")) or (default_airport or None),
                    "date": parse_date(get(row, "date"), get(row, "time"), dayfirst),
                    "description": get(row, "description") or None,
                    "flight_type": get(row, "flight_type") or None,
                    "test_registration": get(row, "test_registration") or None,
                    "military": get(row, "military").lower() in ("1", "true", "yes", "oui", "x", "sí", "si"),
                }
                place_h = next((h for h in row if h and h.strip().lower() in ("place", "lieu", "lugar") and h != m.get("airport")), None)
                if place_h and (row.get(place_h) or "").strip():
                    data["place"] = row[place_h].strip()
                    data["airport"] = None if not get(row, "airport") else data["airport"]
                out = prepare(data)
                patrol_name = (row.get("patrol") or "").strip()
                if patrol_name:
                    key = (patrol_name, (out.get("date") or "")[:10], out.get("airport") or out.get("place"))
                    if key not in patrols_seen:
                        patrols_seen[key] = execute("INSERT INTO patrols(name, created_at) VALUES(?, ?)", (patrol_name[:80], now_iso())).lastrowid
                    out["patrol_id"] = patrols_seen[key]
                if skip_duplicates and find_duplicates(out["registration"], out.get("airport"), out.get("date"), place=out.get("place")):
                    skipped += 1
                    continue
                out["created_at"] = out["updated_at"] = now_iso()
                cur = db().execute(f"INSERT INTO spotting({', '.join(out)}) VALUES({', '.join('?' * len(out))})",
                                   list(out.values()))
                db().commit()
                tags = [t for t in re.split(r"[|;,]", get(row, "tags")) if t.strip()]
                if tags:
                    set_tags(cur.lastrowid, tags)
                ids.append(cur.lastrowid)
            else:
                dep_raw, arr_raw = get(row, "dep_icao"), get(row, "arr_icao")
                dep, arr = parse_airport(dep_raw), parse_airport(arr_raw)
                date = parse_date(get(row, "date"), None, dayfirst)
                if not dep or not arr or not date:
                    errors.append({"line": i, "error": "missing_airport_or_date"})
                    continue
                dur = get(row, "duration_min")
                dur_min = None
                if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", dur):
                    hh, mm = dur.split(":")[:2]
                    dur_min = int(hh) * 60 + int(mm)
                elif dur.isdigit():
                    dur_min = int(dur)
                seat_map = {"1": "window", "2": "middle", "3": "aisle"}
                class_map = {"1": "economy", "2": "business", "3": "first", "4": "premium", "5": "first"}
                reason_map = {"1": "leisure", "2": "business", "3": "crew", "4": "other"}
                airline = get(row, "airline")
                aircraft_v = get(row, "aircraft")
                f = flights_router.FlightIn(
                    date=date[:10], dep_icao=dep, arr_icao=arr, dep_time=get(row, "dep_time")[:5] or None,
                    arr_time=get(row, "arr_time")[:5] or None, flight_number=get(row, "flight_number") or None,
                    airline=re.sub(r"\s*\(.*\)\s*$", "", airline) or None,
                    airline_icao=_icao_in_parens(airline, 3),
                    registration=get(row, "registration") or None,
                    aircraft=re.sub(r"\s*\(.*\)\s*$", "", aircraft_v) or None,
                    aircraft_icao=_icao_in_parens(aircraft_v, 4) or _icao_in_parens(aircraft_v, 3),
                    seat=get(row, "seat") or None,
                    seat_type=seat_map.get(get(row, "seat_type"), get(row, "seat_type").lower() or None),
                    cabin_class=class_map.get(get(row, "cabin_class"), get(row, "cabin_class").lower() or None),
                    reason=reason_map.get(get(row, "reason"), get(row, "reason").lower() or None),
                    duration_min=dur_min, notes=get(row, "notes") or None)
                d = flights_router.prepare(f)
                d["created_at"] = d["updated_at"] = now_iso()
                db().execute(f"INSERT INTO flights({', '.join(d)}) VALUES({', '.join('?' * len(d))})", list(d.values()))
                db().commit()
            imported += 1
        except HTTPException as e:
            errors.append({"line": i, "error": str(e.detail)})
        except Exception as e:  # noqa: BLE001
            errors.append({"line": i, "error": str(e)[:120]})
    path.unlink(missing_ok=True)
    if enrich and ids:
        bg.add_task(_enrich_after_import, ids)
    gamification.evaluate()
    return {"imported": imported, "skipped": skipped, "errors": errors[:50], "error_count": len(errors)}


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
SPOT_EXPORT = ["id_spotting", "registration", "aircraft", "aircraft_icao", "manufacturer", "msn", "owner",
               "airline_icao", "livery", "livery_category", "military", "flight_type", "test_registration", "date", "date_utc", "airport",
               "place", "lat", "lng", "country", "description", "favorite", "rating", "camera", "lens", "focal", "aperture",
               "iso", "shutter", "metar", "image", "atc_audio", "created_at"]


def _csv_response(rows: list[dict], cols: list[str], name: str) -> Response:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/api/export/spots.csv")
def export_spots():
    rows = q(f"SELECT {', '.join(SPOT_EXPORT)}, (SELECT name FROM patrols WHERE id_patrol = spotting.patrol_id) AS patrol, (SELECT group_concat(t.name, '|') FROM spotting_tags st "
             f"JOIN tags t USING(id_tag) WHERE st.id_spotting = spotting.id_spotting) AS tags FROM spotting ORDER BY date")
    return _csv_response(rows, SPOT_EXPORT + ["patrol", "tags"], f"contrail-spots-{datetime.now():%Y%m%d}.csv")


@router.get("/api/export/flights.csv")
def export_flights():
    rows = q("SELECT * FROM flights ORDER BY date")
    cols = ["id_flight", "date", "dep_icao", "arr_icao", "dep_time", "arr_time", "flight_number", "airline",
            "airline_icao", "registration", "aircraft", "aircraft_icao", "seat", "seat_type", "cabin_class",
            "reason", "duration_min", "distance_km", "notes"]
    return _csv_response(rows, cols, f"contrail-flights-{datetime.now():%Y%m%d}.csv")


@router.get("/api/export/full.json")
def export_full():
    tables = ["spotting", "tags", "spotting_tags", "flights", "spot_locations", "achievements", "user_settings",
              "wishes", "airlines", "fleets", "shares"]
    payload = {"app": "contrail", "version": APP_VERSION, "exported_at": now_iso(),
               "tables": {t: q(f"SELECT * FROM {t}") for t in tables}}
    data = json.dumps(payload, ensure_ascii=False, indent=1)
    return Response(data, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="contrail-export-{datetime.now():%Y%m%d}.json"'})


# --------------------------------------------------------------------------- #
# Sauvegardes
# --------------------------------------------------------------------------- #
@router.get("/api/backups")
def backups_list():
    last = backup.last_backup_time()
    return {"items": backup.list_backups(), "last": last.isoformat(timespec="seconds") if last else None,
            "remote": backup.remote_status()}


@router.post("/api/backups/remote-test")
def backups_remote_test():
    return backup.test_remote()


@router.post("/api/backups")
def backups_create(include_media: bool = False):
    return backup.create_backup(include_media=include_media, label="manual")


@router.get("/api/backups/{name}")
def backups_download(name: str):
    p = backup.backup_path(name)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, filename=name, media_type="application/zip")


@router.delete("/api/backups/{name}")
def backups_delete(name: str):
    p = backup.backup_path(name)
    if not p:
        raise HTTPException(404)
    p.unlink()
    return {"deleted": name}


@router.post("/api/backups/restore")
def backups_restore(file: UploadFile = File(...)):
    tmp = DIRS["tmp"] / f"restore-{uuid.uuid4().hex}.zip"
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        return backup.restore(tmp)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, "invalid_backup") from e
    finally:
        tmp.unlink(missing_ok=True)
