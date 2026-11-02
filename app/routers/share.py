"""Partage public par lien sécurisé (jeton aléatoire, révocable, expiration facultative)."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..core import execute, get_setting, now_iso, q, q1, safe_media_path
from ..services import geo
from ..services import registration as regs
from .spots import attach_tags, build_filters

router = APIRouter(tags=["share"])

KINDS = ("gallery", "spot", "flight", "flights", "airframe")
PUBLIC_SPOT_COLS = ("s.id_spotting, s.registration, s.aircraft, s.aircraft_icao, s.owner, s.livery, s.military, "
                    "s.flight_type, s.date, s.airport, s.thumb, s.image_w, s.image_h, s.country, s.camera, s.lens, "
                    "s.focal, s.aperture, s.iso, s.shutter, s.description, s.image")


class ShareIn(BaseModel):
    kind: str
    target: str | None = None
    title: str | None = None
    expires_days: int | None = None


@router.get("/api/shares")
def list_shares():
    return q("SELECT * FROM shares ORDER BY created_at DESC")


@router.post("/api/shares")
def create_share(body: ShareIn):
    if body.kind not in KINDS:
        raise HTTPException(422, "bad_kind")
    token = secrets.token_urlsafe(18)
    expires = None
    if body.expires_days:
        expires = (datetime.now(timezone.utc) + timedelta(days=body.expires_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    execute("INSERT INTO shares(token, kind, target, title, expires_at, created_at) VALUES(?,?,?,?,?,?)",
            (token, body.kind, body.target, body.title, expires, now_iso()))
    return q1("SELECT * FROM shares WHERE token = ?", (token,))


@router.delete("/api/shares/{token}")
def revoke_share(token: str):
    execute("UPDATE shares SET revoked = 1 WHERE token = ?", (token,))
    return {"revoked": token}


@router.delete("/api/shares/{token}/purge")
def delete_share(token: str):
    execute("DELETE FROM shares WHERE token = ?", (token,))
    return {"deleted": token}


def _valid_share(token: str) -> dict:
    s = q1("SELECT * FROM shares WHERE token = ?", (token,))
    if not s or s["revoked"]:
        raise HTTPException(404, "share_not_found")
    if s["expires_at"] and s["expires_at"] < now_iso():
        raise HTTPException(410, "share_expired")
    return s


def _gallery_filter(target: str | None) -> dict:
    f: dict = {}
    if target and ":" in target:
        k, v = target.split(":", 1)
        if k in ("tag", "airport", "year", "type", "airline", "registration"):
            f[k] = v
        elif k == "special":
            f["special"] = True
        elif k == "favorite":
            f["favorite"] = True
    return f


def _spot_ids_for(share: dict) -> set[int]:
    k = share["kind"]
    if k == "spot":
        return {int(share["target"])} if (share["target"] or "").isdigit() else set()
    if k == "gallery":
        where, params = build_filters(_gallery_filter(share["target"]))
        return {r["id_spotting"] for r in q(f"SELECT s.id_spotting FROM spotting s WHERE {where}", params)}
    if k == "airframe":
        return {r["id_spotting"] for r in q("SELECT id_spotting FROM spotting WHERE registration = ?",
                                            (regs.normalize(share["target"]),))}
    if k == "flight":
        f = q1("SELECT registration FROM flights WHERE id_flight = ?", (share["target"],))
        if f and f["registration"]:
            return {r["id_spotting"] for r in q("SELECT id_spotting FROM spotting WHERE registration = ?", (f["registration"],))}
    return set()


def _public_spots(where: str, params: list) -> list[dict]:
    rows = q(f"SELECT {PUBLIC_SPOT_COLS} FROM spotting s WHERE {where} ORDER BY s.date DESC LIMIT 2000", params)
    attach_tags(rows)
    include_notes = bool(get_setting("share_include_notes"))
    for r in rows:
        r["has_image"] = bool(r.pop("image"))
        if not include_notes:
            r.pop("description", None)
        a = geo.airport(r["airport"])
        # Pas de coordonnées GPS précises en public : seulement celles de l'aéroport.
        r["lat"], r["lng"] = (a["lat"], a["lng"]) if a else (None, None)
        r["airport_name"] = a["name"] if a else None
        r.pop("thumb", None)
    return rows


def _public_flights(where: str, params: list) -> list[dict]:
    rows = q(f"SELECT id_flight, date, dep_icao, arr_icao, flight_number, airline, registration, aircraft, "
             f"distance_km, duration_min FROM flights WHERE {where} ORDER BY date DESC", params)
    for r in rows:
        for side in ("dep", "arr"):
            a = geo.airport(r[f"{side}_icao"])
            r[f"{side}_info"] = {k: a[k] for k in ("name", "city", "country", "lat", "lng", "iata")} if a else None
    return rows


@router.get("/api/public/{token}")
def public_view(token: str):
    s = _valid_share(token)
    execute("UPDATE shares SET views = views + 1 WHERE token = ?", (token,))
    out = {"kind": s["kind"], "title": s["title"], "created_at": s["created_at"], "spots": [], "flights": []}
    if s["kind"] in ("gallery", "spot", "airframe"):
        ids = sorted(_spot_ids_for(s))
        if ids:
            out["spots"] = _public_spots(f"s.id_spotting IN ({','.join('?' * len(ids))})", ids)
    if s["kind"] == "flight":
        out["flights"] = _public_flights("id_flight = ?", [s["target"]])
    if s["kind"] == "flights":
        out["flights"] = _public_flights("1=1", [])
    if s["kind"] == "airframe":
        out["registration"] = regs.normalize(s["target"])
        out["flights"] = _public_flights("registration = ?", [out["registration"]])
    out["stats"] = {"spots": len(out["spots"]), "regs": len({x["registration"] for x in out["spots"]}),
                    "types": len({x["aircraft_icao"] or x["aircraft"] for x in out["spots"]}),
                    "flights": len(out["flights"]), "km": round(sum(f["distance_km"] or 0 for f in out["flights"]))}
    return out


@router.get("/api/public/{token}/media/{size}/{spot_id}")
def public_media(token: str, size: str, spot_id: int):
    s = _valid_share(token)
    if spot_id not in _spot_ids_for(s):
        raise HTTPException(404)
    row = q1("SELECT image, thumb FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not row:
        raise HTTPException(404)
    p = safe_media_path("thumbs", row["thumb"]) if size == "thumb" else safe_media_path("images", row["image"])
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=86400"})
