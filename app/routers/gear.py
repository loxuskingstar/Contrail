"""Matériel photo : boîtiers, objectifs et setups (combinaisons boîtier + objectif).

Les noms détectés par l'EXIF vivent dans les spots ; la table `gear` ne contient que ce que l'utilisateur ajoute à la main.
La liste présentée est l'union des deux, ce qui permet de renommer ou fusionner un nom détecté (« ILCE-7M4 » → « Sony A7 IV »).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import execute, now_iso, q, q1

router = APIRouter(tags=["gear"])

KINDS = {"camera": "camera", "lens": "lens"}


def _name(v: str | None) -> str:
    return re.sub(r"\s+", " ", (v or "").strip())[:120]


def _kind(k: str) -> str:
    if k not in KINDS:
        raise HTTPException(422, "invalid_kind")
    return KINDS[k]


class GearIn(BaseModel):
    kind: str
    name: str


class RenameIn(BaseModel):
    kind: str
    old: str
    new: str


class SetupIn(BaseModel):
    name: str | None = None
    camera: str | None = None
    lens: str | None = None


def _listing(kind: str) -> list[dict]:
    col = _kind(kind)          # nom de colonne issu d'une liste fermée : sûr dans le SQL
    used = {r["n"]: r for r in q(
        f"SELECT {col} n, COUNT(*) count, MAX(COALESCE(date, created_at)) last FROM spotting "
        f"WHERE {col} IS NOT NULL AND {col} <> '' GROUP BY {col}")}
    manual = {r["name"]: r["id_gear"] for r in q("SELECT id_gear, name FROM gear WHERE kind = ?", (kind,))}
    out = []
    for name in sorted(set(used) | set(manual), key=lambda x: (-(used.get(x, {}).get("count") or 0), x.lower())):
        u = used.get(name, {})
        out.append({"name": name, "count": u.get("count", 0), "last": u.get("last"), "manual": name in manual,
                    "id": manual.get(name)})
    return out


def _setups() -> list[dict]:
    rows = q("SELECT id_setup id, name, camera, lens FROM gear_setups ORDER BY name COLLATE NOCASE")
    use = {(r["camera"], r["lens"]): r["n"] for r in q(
        "SELECT camera, lens, COUNT(*) n FROM spotting WHERE camera IS NOT NULL OR lens IS NOT NULL GROUP BY camera, lens")}
    for r in rows:
        r["count"] = use.get((r["camera"], r["lens"]), 0)
    return rows


@router.get("/api/gear")
def list_gear():
    return {"cameras": _listing("camera"), "lenses": _listing("lens"), "setups": _setups()}


@router.post("/api/gear")
def add_gear(body: GearIn):
    kind, name = _kind(body.kind), _name(body.name)
    if not name:
        raise HTTPException(422, "name_required")
    execute("INSERT OR IGNORE INTO gear(kind, name, created_at) VALUES(?,?,?)", (kind, name, now_iso()))
    return {"kind": kind, "name": name}


@router.post("/api/gear/rename")
def rename_gear(body: RenameIn):
    """Renomme (ou fusionne dans un nom existant) un boîtier/objectif : spots, matériel manuel et setups suivent."""
    kind, old, new = _kind(body.kind), _name(body.old), _name(body.new)
    if not old or not new:
        raise HTTPException(422, "name_required")
    if old == new:
        return {"kind": kind, "name": new, "spots": 0}
    n = execute(f"UPDATE spotting SET {kind} = ? WHERE {kind} = ?", (new, old)).rowcount
    execute("INSERT OR IGNORE INTO gear(kind, name, created_at) VALUES(?,?,?)", (kind, new, now_iso()))
    execute("DELETE FROM gear WHERE kind = ? AND name = ?", (kind, old))
    execute(f"UPDATE gear_setups SET {kind} = ? WHERE {kind} = ?", (new, old))
    return {"kind": kind, "name": new, "spots": n}


@router.delete("/api/gear")
def delete_gear(kind: str, name: str):
    k, name = _kind(kind), _name(name)
    if q1(f"SELECT 1 FROM spotting WHERE {k} = ? LIMIT 1", (name,)):
        raise HTTPException(409, "gear_in_use")      # des spots l'utilisent : renommer ou fusionner plutôt que supprimer
    execute("DELETE FROM gear WHERE kind = ? AND name = ?", (k, name))
    execute(f"UPDATE gear_setups SET {k} = NULL WHERE {k} = ?", (name,))
    return {"deleted": name}


def _setup_row(body: SetupIn) -> tuple[str | None, str | None, str]:
    cam, lens = _name(body.camera) or None, _name(body.lens) or None
    if not cam and not lens:
        raise HTTPException(422, "setup_empty")
    name = _name(body.name) or " + ".join(x for x in (cam, lens) if x)
    for k, v in (("camera", cam), ("lens", lens)):
        if v:
            execute("INSERT OR IGNORE INTO gear(kind, name, created_at) VALUES(?,?,?)", (k, v, now_iso()))
    return cam, lens, name


@router.post("/api/gear/setups")
def create_setup(body: SetupIn):
    cam, lens, name = _setup_row(body)
    cur = execute("INSERT INTO gear_setups(name, camera, lens, created_at) VALUES(?,?,?,?)", (name, cam, lens, now_iso()))
    return {"id": cur.lastrowid, "name": name, "camera": cam, "lens": lens}


@router.put("/api/gear/setups/{sid}")
def update_setup(sid: int, body: SetupIn):
    if not q1("SELECT 1 FROM gear_setups WHERE id_setup = ?", (sid,)):
        raise HTTPException(404, "not_found")
    cam, lens, name = _setup_row(body)
    execute("UPDATE gear_setups SET name = ?, camera = ?, lens = ? WHERE id_setup = ?", (name, cam, lens, sid))
    return {"id": sid, "name": name, "camera": cam, "lens": lens}


@router.delete("/api/gear/setups/{sid}")
def delete_setup(sid: int):
    execute("DELETE FROM gear_setups WHERE id_setup = ?", (sid,))
    return {"deleted": sid}
