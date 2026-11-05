"""Wishlist : souhaits (appareil, modèle, compagnie, livrée, événement, aéroport, libre) et suivi en direct."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..core import execute, now_iso, q, q1
from ..services import opensky, wishes

router = APIRouter(tags=["wishes"])


class WishIn(BaseModel):
    kind: str
    title: str | None = None
    value: str | None = None
    airline_key: str | None = None
    family: bool | None = None
    note: str | None = None
    priority: int | None = None
    goal_count: int | None = None
    count_existing: bool | None = None
    start_date: str | None = None
    end_date: str | None = None
    place: str | None = None
    airport: str | None = None
    lat: float | None = None
    lng: float | None = None
    url: str | None = None
    parent_id: int | None = None
    auto_complete: bool | None = None
    track: bool | None = None
    notify: bool | None = None
    remind_days: int | None = None


def _get(wid: int) -> dict:
    w = q1("SELECT * FROM wishes WHERE id = ?", (wid,))
    if not w:
        raise HTTPException(404, "not_found")
    return w


def _one(wid: int) -> dict:
    return wishes.decorate([_get(wid)])[0]


def _fields(body: WishIn) -> dict:
    return body.model_dump(exclude={"count_existing"}, exclude_unset=True)


@router.get("/api/wishes")
def list_wishes(status: str | None = None, kind: str | None = None):
    wishes.sync(notify_done=True)
    sql, params = "SELECT * FROM wishes WHERE 1=1", []
    if status in ("open", "done"):
        sql += " AND status = ?"
        params.append(status)
    if kind in wishes.KINDS:
        sql += " AND kind = ?"
        params.append(kind)
    rows = wishes.decorate(q(sql + " ORDER BY status DESC, priority DESC, created_at DESC", params))
    return rows


@router.get("/api/wishes/summary")
def wishes_summary():
    return wishes.summary()


@router.get("/api/wishes/suggestions")
def suggestions():
    """Valeurs déjà connues pour la saisie assistée (compagnies, livrées, aéroports)."""
    airlines = q("SELECT opg(airline_icao, owner) key, MAX(owner) name, COUNT(*) n FROM spotting "
                 "WHERE opg(airline_icao, owner) IS NOT NULL GROUP BY key ORDER BY n DESC")
    known = {a["key"] for a in airlines}
    for r in q("SELECT key, name FROM airlines"):
        if r["key"] not in known:
            airlines.append({"key": r["key"], "name": r["name"] or r["key"], "n": 0})
    return {
        "airlines": airlines,
        "liveries": list(dict.fromkeys(["Primer", "Blanche"] + [r["livery"] for r in q(
            "SELECT livery, COUNT(*) n FROM spotting WHERE livery IS NOT NULL AND livery <> '' GROUP BY livery ORDER BY n DESC")])),
        "airports": [r["airport"] for r in q("SELECT airport, COUNT(*) n FROM spotting WHERE airport IS NOT NULL AND airport <> '' "
                                            "GROUP BY airport ORDER BY n DESC")],
        "events": q("SELECT id, title, start_date, end_date FROM wishes WHERE kind='event' AND status='open' ORDER BY start_date"),
    }


@router.post("/api/wishes")
def add_wish(body: WishIn, bg: BackgroundTasks):
    try:
        c = wishes.clean(_fields(body))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if wishes.duplicate(c):
        raise HTTPException(409, "already_wished")
    wid = wishes.insert(c, count_existing=bool(body.count_existing))
    if c["kind"] == "aircraft":
        hx = q1("SELECT icao24 FROM spotting WHERE registration = ? AND icao24 IS NOT NULL LIMIT 1", (c["value"],))
        if hx:
            execute("UPDATE wishes SET icao24 = ? WHERE id = ?", (hx["icao24"], wid))
        if c["track"]:
            bg.add_task(opensky.check_watchlist)
    wishes.sync(notify_done=False)
    return _one(wid)


@router.put("/api/wishes/{wid}")
def update_wish(wid: int, body: WishIn):
    cur = _get(wid)
    try:
        c = wishes.clean(_fields(body), cur)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if wishes.duplicate(c, ignore_id=wid):
        raise HTTPException(409, "already_wished")
    c["updated_at"] = now_iso()
    if body.count_existing is not None:
        c["since"] = None if body.count_existing else (cur["since"] or wishes.today().isoformat())
    if c["kind"] == "aircraft" and c["value"] != cur["value"]:
        c["icao24"] = None
    execute(f"UPDATE wishes SET {', '.join(f'{k} = ?' for k in c)} WHERE id = ?", [*c.values(), wid])
    wishes.sync(notify_done=False)
    return _one(wid)


@router.post("/api/wishes/{wid}/done")
def mark_done(wid: int, spot_id: int | None = None):
    _get(wid)
    execute("UPDATE wishes SET status='done', done_at=?, done_spot_id=?, airborne=0, updated_at=? WHERE id=?",
            (now_iso(), spot_id, now_iso(), wid))
    return _one(wid)


@router.post("/api/wishes/{wid}/reopen")
def reopen(wid: int):
    _get(wid)
    execute("UPDATE wishes SET status='open', done_at=NULL, done_spot_id=NULL, since=?, updated_at=? WHERE id=?",
            (wishes.today().isoformat(), now_iso(), wid))
    return _one(wid)


@router.delete("/api/wishes/{wid}")
def delete_wish(wid: int):
    _get(wid)
    execute("UPDATE wishes SET parent_id = NULL WHERE parent_id = ?", (wid,))
    execute("DELETE FROM wishes WHERE id = ?", (wid,))
    return {"deleted": wid}


@router.get("/api/wishes/{wid}/spots")
def wish_spots(wid: int):
    w = _get(wid)
    ctx = wishes.Spots()
    _, ms = wishes.evaluate(w, ctx)
    return {"items": [{"id": s["id"], "registration": s["registration"], "aircraft": s["aircraft"], "date": s["d"],
                       "airport": s["airport"], "thumb": s["thumb"]} for s in ms[:60]], "total": len(ms)}


@router.post("/api/wishes/check")
def check_now():
    alerts = opensky.check_watchlist()
    done = wishes.sync(notify_done=True)
    wishes.reminders()
    return {"alerts": alerts, "done": len(done), "items": list_wishes()}


@router.get("/api/wishes/export.csv")
def export_csv():
    rows = wishes.decorate(q("SELECT * FROM wishes ORDER BY status DESC, priority DESC, created_at"))
    cols = ["id", "kind", "title", "value", "status", "priority", "goal_count", "progress", "start_date", "end_date", "place",
            "airport", "url", "note", "created_at", "done_at"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="contrail-wishlist-{datetime.now():%Y%m%d}.csv"'})


# --------------------------------------------------------------------------- #
# Compatibilité : anciens points d'accès « watchlist » (radar, fiche appareil, fiche spot)
# --------------------------------------------------------------------------- #
class WatchIn(BaseModel):
    registration: str
    note: str | None = None
    notify: bool = True


@router.get("/api/watchlist")
def list_watch():
    return wishes.decorate(q("SELECT * FROM wishes WHERE kind='aircraft' AND status='open' ORDER BY airborne DESC, value"))


@router.post("/api/watchlist")
def add_watch(body: WatchIn, bg: BackgroundTasks):
    try:
        c = wishes.clean({"kind": "aircraft", "value": body.registration, "note": body.note, "notify": body.notify,
                          "track": True, "auto_complete": False})
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if wishes.duplicate(c):
        raise HTTPException(409, "already_watched")
    wid = wishes.insert(c, count_existing=True)
    hx = q1("SELECT icao24 FROM spotting WHERE registration = ? AND icao24 IS NOT NULL LIMIT 1", (c["value"],))
    if hx:
        execute("UPDATE wishes SET icao24 = ? WHERE id = ?", (hx["icao24"], wid))
    bg.add_task(opensky.check_watchlist)
    return _one(wid)


@router.put("/api/watchlist/{wid}")
def update_watch(wid: int, body: WatchIn):
    _get(wid)
    execute("UPDATE wishes SET note=?, notify=?, updated_at=? WHERE id=?", (body.note, int(body.notify), now_iso(), wid))
    return _one(wid)


@router.delete("/api/watchlist/{wid}")
def delete_watch(wid: int):
    execute("DELETE FROM wishes WHERE id = ?", (wid,))
    return {"deleted": wid}


@router.post("/api/watchlist/check")
def check_watch():
    return {"alerts": opensky.check_watchlist(), "items": list_watch()}
