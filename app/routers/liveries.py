"""Livrées : catégories éditables, regroupement par livrée et rangement manuel.

Une « livrée » est un texte de livrée chez un exploitant (clé `collection.livery_key`) : les trois F-5 de la Patrouille Suisse
en livrée « 60 ans » n'en font qu'une, la « Star Alliance » d'Air Canada et celle de Brussels Airlines en font deux.
La catégorie de chaque spot reste écrite dans `spotting.livery_category` (filtres, statistiques, succès), recalculée
dès qu'une règle, un mot-clé ou un rangement manuel change.
"""
from __future__ import annotations

import secrets
from collections import Counter

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import db, execute, now_iso, q, q1
from ..services import collection
from .spots import LIST_COLS, decorate

router = APIRouter(tags=["liveries"])

PLAIN = collection.PLAIN
LOCKED = ("special", *PLAIN)          # catégories d'origine indispensables : renommables, pas supprimables
ICONS = {"history", "users", "sparkles", "flag", "heart", "palette", "paint-bucket", "star", "crown", "gem", "trophy", "medal",
         "award", "flame", "zap", "shield", "plane", "globe", "camera", "tag", "music", "target", "swatch-book", "wand-sparkles",
         "sun", "moon", "rocket", "party-popper", "film", "gamepad-2", "rainbow", "leaf", "anchor", "cake", "sparkle", "swords",
         "snowflake", "car", "ribbon", "handshake", "building-2", "calendar-days"}


class CategoryIn(BaseModel):
    name: str | None = None
    icon: str | None = None
    keywords: str | None = None


class OrderIn(BaseModel):
    codes: list[str]


class GroupIn(BaseModel):
    key: str
    category: str | None = None        # code, "" = classement automatique, absent = inchangé
    livery: str | None = None          # nouveau texte de livrée (renommer / fusionner)


class ReorderIn(BaseModel):
    category: str
    keys: list[str]


def _clean(v: str | None, n: int) -> str:
    return " ".join((v or "").split())[:n]


def _categories(with_disabled: bool = False) -> list[dict]:
    rows = q("SELECT code, name, icon, position, keywords, builtin, disabled FROM livery_categories ORDER BY position, code")
    stats = {r["c"]: r for r in q("SELECT livery_category c, COUNT(*) n, COUNT(DISTINCT registration) u FROM spotting "
                                  "WHERE livery_category IS NOT NULL GROUP BY livery_category")}
    out = []
    for r in rows:
        if r["disabled"] and not with_disabled:
            continue
        st = stats.get(r["code"]) or {}
        out.append({"code": r["code"], "name": r["name"], "icon": r["icon"] or "palette", "position": r["position"],
                    "keywords": r["keywords"] or "", "builtin": bool(r["builtin"]), "disabled": bool(r["disabled"]),
                    "plain": r["code"] in PLAIN, "locked": r["code"] in LOCKED,
                    "count": st.get("n", 0), "unique": st.get("u", 0)})
    return out


def _enabled(code: str) -> bool:
    return bool(q1("SELECT 1 FROM livery_categories WHERE code = ? AND disabled = 0", (code,)))


def _groups() -> dict[str, dict]:
    """Toutes les livrées connues, regroupées par clé, avec leur photo de couverture."""
    rows = q("SELECT id_spotting id, registration, livery, owner, livery_category cat, thumb, image, country, aircraft_icao, "
             "favorite, rating, COALESCE(date, created_at) d FROM spotting WHERE livery_category IS NOT NULL")
    manual = {r["key"]: r for r in q("SELECT key, category, position FROM livery_groups")}
    groups: dict[str, dict] = {}
    for r in rows:
        k = collection.livery_key(r["livery"], r["owner"])
        g = groups.setdefault(k, {"key": k, "texts": Counter(), "owner": r["owner"], "regs": [], "types": [], "cats": Counter(),
                                  "n": 0, "last": "", "cover": None, "_score": None, "countries": Counter()})
        g["n"] += 1
        g["texts"][r["livery"]] += 1
        g["cats"][r["cat"]] += 1
        if r["country"]:
            g["countries"][r["country"]] += 1
        if r["registration"] not in g["regs"]:
            g["regs"].append(r["registration"])
        if r["aircraft_icao"] and r["aircraft_icao"] not in g["types"]:
            g["types"].append(r["aircraft_icao"])
        g["last"] = max(g["last"], r["d"] or "")
        # Couverture : favori > mieux noté > plus récent, toujours avec une photo si possible
        score = (bool(r["thumb"]), r["favorite"] or 0, r["rating"] or 0, r["d"] or "")
        if g["_score"] is None or score > g["_score"]:
            g["_score"] = score
            g["cover"] = {"id": r["id"], "thumb": r["thumb"], "image": r["image"], "registration": r["registration"]}
    for k, g in groups.items():
        m = manual.get(k) or {}
        g["livery"] = g["texts"].most_common(1)[0][0]
        g["category"] = g["cats"].most_common(1)[0][0]
        g["country"] = g["countries"].most_common(1)[0][0] if g["countries"] else None
        g["manual"] = bool(m.get("category"))
        g["position"] = m.get("position")
        for x in ("texts", "cats", "countries", "_score"):
            g.pop(x)
    return groups


@router.get("/api/livery-categories")
def list_categories(all: bool = False):
    return _categories(with_disabled=all)


@router.get("/api/liveries")
def liveries():
    cats = _categories()
    by_cat: dict[str, list] = {c["code"]: [] for c in cats}
    for g in _groups().values():
        by_cat.setdefault(g["category"], []).append(g)
    for items in by_cat.values():
        # Ordre manuel d'abord (positions), puis les livrées jamais rangées, de la plus récente à la plus ancienne
        items.sort(key=lambda g: g["last"], reverse=True)
        items.sort(key=lambda g: (g["position"] is None, g["position"] if g["position"] is not None else 0))
    for c in cats:
        c["groups"] = by_cat.get(c["code"], [])
        c["liveries"] = len(c["groups"])
    return {"categories": cats}


@router.get("/api/liveries/group")
def livery_group(key: str):
    rows = q("SELECT id_spotting id, livery, owner FROM spotting WHERE livery_category IS NOT NULL")
    ids = [r["id"] for r in rows if collection.livery_key(r["livery"], r["owner"]) == key]
    if not ids:
        raise HTTPException(404, "not_found")
    g = _groups().get(key)
    ph = ",".join("?" * len(ids))
    spots = decorate(q(f"SELECT {LIST_COLS} FROM spotting s WHERE s.id_spotting IN ({ph}) "
                       f"ORDER BY COALESCE(s.date, s.created_at) DESC", ids))
    return {**(g or {"key": key}), "spots": spots}


@router.post("/api/livery-categories")
def create_category(body: CategoryIn):
    name = _clean(body.name, 60)
    if not name:
        raise HTTPException(422, "name_required")
    if q1("SELECT 1 FROM livery_categories WHERE lower(name) = lower(?) AND disabled = 0", (name,)):
        raise HTTPException(409, "exists")
    code = "c" + secrets.token_hex(4)
    pos = (q1("SELECT MAX(position) p FROM livery_categories WHERE code NOT IN ('primer', 'white')")["p"] or 0) + 1
    execute("INSERT INTO livery_categories (code, name, icon, position, keywords, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
            (code, name, body.icon if body.icon in ICONS else "palette", pos, _clean(body.keywords, 500) or None, now_iso()))
    if body.keywords:
        collection.recategorize()
    return next(c for c in _categories() if c["code"] == code)


@router.put("/api/livery-categories/{code}")
def update_category(code: str, body: CategoryIn):
    cur = q1("SELECT * FROM livery_categories WHERE code = ?", (code,))
    if not cur:
        raise HTTPException(404, "not_found")
    sets, params = [], []
    if body.name is not None:
        name = _clean(body.name, 60)
        if not name and not cur["builtin"]:
            raise HTTPException(422, "name_required")
        sets.append("name = ?"), params.append(name or None)    # vide sur une catégorie d'origine : libellé traduit
    if body.icon is not None and body.icon in ICONS:
        sets.append("icon = ?"), params.append(body.icon)
    if body.keywords is not None and code not in PLAIN:
        sets.append("keywords = ?"), params.append(_clean(body.keywords, 500) or None)
    if sets:
        execute(f"UPDATE livery_categories SET {', '.join(sets)} WHERE code = ?", (*params, code))
    if body.keywords is not None and (body.keywords or None) != cur["keywords"]:
        collection.recategorize()
    return next(c for c in _categories(with_disabled=True) if c["code"] == code)


@router.delete("/api/livery-categories/{code}")
def delete_category(code: str):
    cur = q1("SELECT * FROM livery_categories WHERE code = ?", (code,))
    if not cur:
        raise HTTPException(404, "not_found")
    if code in LOCKED:
        raise HTTPException(400, "locked")
    # Les livrées rangées là à la main retournent au classement automatique
    execute("UPDATE livery_groups SET category = NULL WHERE category = ?", (code,))
    if cur["builtin"]:
        execute("UPDATE livery_categories SET disabled = 1 WHERE code = ?", (code,))
    else:
        execute("DELETE FROM livery_categories WHERE code = ?", (code,))
    return {"ok": True, "moved": collection.recategorize()}


@router.post("/api/livery-categories/{code}/restore")
def restore_category(code: str):
    execute("UPDATE livery_categories SET disabled = 0 WHERE code = ? AND builtin = 1", (code,))
    collection.recategorize()
    return {"ok": True}


@router.post("/api/livery-categories/reorder")
def reorder_categories(body: OrderIn):
    conn = db()
    conn.executemany("UPDATE livery_categories SET position = ? WHERE code = ? AND code NOT IN ('primer', 'white')",
                     [(i, c) for i, c in enumerate(body.codes)])
    conn.commit()
    return {"ok": True}


def _upsert_group(key: str, **cols) -> None:
    row = q1("SELECT key FROM livery_groups WHERE key = ?", (key,))
    cols["updated_at"] = now_iso()
    if row:
        execute(f"UPDATE livery_groups SET {', '.join(f'{k} = ?' for k in cols)} WHERE key = ?", (*cols.values(), key))
    else:
        execute(f"INSERT INTO livery_groups (key, {', '.join(cols)}) VALUES (?, {', '.join('?' * len(cols))})", (key, *cols.values()))


@router.put("/api/liveries/group")
def update_group(body: GroupIn):
    key = body.key
    rows = [r for r in q("SELECT id_spotting id, livery, owner FROM spotting WHERE livery IS NOT NULL AND livery <> ''")
            if collection.livery_key(r["livery"], r["owner"]) == key]
    if not rows:
        raise HTTPException(404, "not_found")
    if body.livery is not None:
        text = _clean(body.livery, 120)
        if not text:
            raise HTTPException(422, "livery_required")
        conn = db()
        conn.executemany("UPDATE spotting SET livery = ?, updated_at = ? WHERE id_spotting = ?", [(text, now_iso(), r["id"]) for r in rows])
        conn.commit()
        # Le rangement suit la livrée renommée ; si elle rejoint une livrée existante, celle-ci garde le sien
        new_key = collection.livery_key(text, rows[0]["owner"])
        if new_key != key:
            old = q1("SELECT category, position FROM livery_groups WHERE key = ?", (key,))
            if old and not q1("SELECT 1 FROM livery_groups WHERE key = ?", (new_key,)):
                _upsert_group(new_key, category=old["category"], position=old["position"])
            execute("DELETE FROM livery_groups WHERE key = ?", (key,))
            key = new_key
    if body.category is not None:
        if body.category and not _enabled(body.category):
            raise HTTPException(422, "invalid_category")
        _upsert_group(key, category=body.category or None, position=None)
    collection.recategorize()
    return {"ok": True, "key": key, **({k: v for k, v in (_groups().get(key) or {}).items() if k != "key"})}


@router.post("/api/liveries/reorder")
def reorder_group(body: ReorderIn):
    """Ordre complet d'une catégorie après un glisser-déposer ; une livrée venue d'une autre catégorie y est rangée à la main."""
    if not _enabled(body.category):
        raise HTTPException(422, "invalid_category")
    current = {k: g["category"] for k, g in _groups().items()}
    for i, k in enumerate(body.keys):
        if k not in current:
            continue
        cols = {"position": float(i)}
        if current[k] != body.category:
            cols["category"] = body.category
        _upsert_group(k, **cols)
    moved = collection.recategorize()
    return {"ok": True, "moved": moved}


@router.post("/api/liveries/reset")
def reset_order(category: str = ""):
    """Oublie l'ordre manuel (d'une catégorie ou de toutes) ; les catégories imposées à la main restent."""
    keys = [k for k, g in _groups().items() if not category or g["category"] == category]
    conn = db()
    conn.executemany("UPDATE livery_groups SET position = NULL WHERE key = ?", [(k,) for k in keys])
    conn.execute("DELETE FROM livery_groups WHERE category IS NULL AND position IS NULL")
    conn.commit()
    return {"ok": True}
