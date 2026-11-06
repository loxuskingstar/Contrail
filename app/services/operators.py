"""Identité d'une compagnie dans les spots.

Le code OACI d'un spot (`airline_icao`) vient souvent d'une base d'appareils qui rattache une filiale
à sa maison mère (Hop! → AFR). Regrouper aveuglément par code mélange alors les deux flottes.
`group_key(icao, owner)` garde le code OACI tant que le propriétaire saisi est compatible avec le nom
connu de ce code, et bascule sur le nom du propriétaire sinon. Elle est enregistrée dans SQLite sous
le nom `opg` et remplace `COALESCE(airline_icao, owner)` partout.
<<<<<<< HEAD
=======

Inversement, un propriétaire qui porte le nom d'un *autre* code connu est rattaché à ce code : un spot
« Ryanair » saisi sous le code MAY (Malta Air) rejoint RYR, et un spot « Air France » sans code rejoint AFR,
au lieu de former une compagnie à part.
>>>>>>> f04f40360544dbd43d4a4c562449716509ebcf0f
"""
from __future__ import annotations

import sqlite3
import time

from app.core import db_path

# Mots qui peuvent s'ajouter à un nom sans changer de compagnie (« Deutsche Lufthansa »).
GENERIC = {"deutsche", "group", "groupe", "holdings", "holding", "international", "intl", "the", "de", "of", "und"}
TTL = 30.0
_cache: dict[tuple[str, str], tuple[float, frozenset[str]]] = {}


def _key(name: str | None) -> str:
    from app.services import refdb
    return refdb._opkey(name)


def compatible(a: str, refs) -> bool:
    """Le nom simplifié `a` désigne-t-il la même compagnie que l'une des références ?"""
    if not a:
        return True
    wa = set(a.split())
    for r in refs:
        wr = set(r.split())
        if a == r:
            return True
        small, big = (wa, wr) if len(wa) <= len(wr) else (wr, wa)
        if small and small <= big and (big - small) <= GENERIC:
            return True
    return False


def sources(icao: str) -> dict[str, list[str]]:
    """Noms de référence par source (diagnostic) : base de référence, spots, nom enregistré."""
    out: dict[str, list[str]] = {"refdb": [], "spots": [], "registered": []}
    try:
        from app.services import refdb
        out["refdb"] = sorted({_key(n) for n in refdb.dominant_operators(icao)} - {""})
        c = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True, timeout=5)
        try:
            rows = c.execute("SELECT owner, COUNT(*) n FROM spotting WHERE airline_icao = ? AND owner IS NOT NULL "
                             "GROUP BY owner", (icao,)).fetchall()
            tally: dict[str, int] = {}
            for o, n in rows:
                if _key(o):
                    tally[_key(o)] = tally.get(_key(o), 0) + n
            if tally:
                top = max(tally.values())
                out["spots"] = sorted(k for k, v in tally.items() if v == top)
            out["registered"] = sorted({_key(n) for (n,) in c.execute(
                "SELECT name FROM airlines WHERE (key = ? OR icao = ?) AND name IS NOT NULL", (icao, icao))} - {""})
        finally:
            c.close()
    except sqlite3.Error:
        pass
    return out


def _refs(icao: str) -> frozenset[str]:
    """Référence d'un code OACI. Une seule source fait foi, dans l'ordre : base de référence, propriétaire
    majoritaire des spots, nom enregistré (qui peut avoir été fixé à tort par une ancienne version)."""
    path = str(db_path())
    hit = _cache.get((path, icao))
    now = time.monotonic()
    if hit and now - hit[0] < TTL:
        return hit[1]
    src = sources(icao)
    out = frozenset(src["refdb"] or src["spots"] or src["registered"])
    _cache[(path, icao)] = (now, out)
    return out


<<<<<<< HEAD
def reset_cache() -> None:
    _cache.clear()
=======
_names: dict[str, tuple[float, dict[str, str]]] = {}


def _name_index() -> dict[str, str]:
    """Nom simplifié de référence → code OACI, pour les codes présents dans les spots (le plus fréquent l'emporte)."""
    path = str(db_path())
    hit = _names.get(path)
    now = time.monotonic()
    if hit and now - hit[0] < TTL:
        return hit[1]
    idx: dict[str, tuple[str, int]] = {}
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            codes = c.execute("SELECT airline_icao, COUNT(*) FROM spotting WHERE airline_icao IS NOT NULL AND airline_icao <> '' "
                              "GROUP BY airline_icao").fetchall()
        finally:
            c.close()
    except sqlite3.Error:
        codes = []
    for code, n in codes:
        for name in _refs(code):
            if name not in idx or n > idx[name][1]:
                idx[name] = (code, n)
    out = {name: code for name, (code, _) in idx.items()}
    _names[path] = (now, out)
    return out


def _code_for_name(owner: str) -> str | None:
    """Code OACI connu qui porte ce nom de compagnie (égalité d'abord, puis noms compatibles)."""
    k = _key(owner)
    if not k:
        return None
    idx = _name_index()
    if k in idx:
        return idx[k]
    for name, code in idx.items():
        if compatible(k, {name}):
            return code
    return None


def reset_cache() -> None:
    _cache.clear()
    _names.clear()
>>>>>>> f04f40360544dbd43d4a4c562449716509ebcf0f


def group_key(icao: str | None, owner: str | None) -> str | None:
    icao = (icao or "").strip().upper() or None
    owner = (owner or "").strip() or None
    if not owner:
        return icao
    if not icao:
<<<<<<< HEAD
        return owner
    refs = _refs(icao)
    if not refs or compatible(_key(owner), refs):
        return icao
    return owner
=======
        return _code_for_name(owner) or owner
    refs = _refs(icao)
    if not refs or compatible(_key(owner), refs):
        return icao
    return _code_for_name(owner) or owner
>>>>>>> f04f40360544dbd43d4a4c562449716509ebcf0f


def register(conn: sqlite3.Connection) -> None:
    conn.create_function("opg", 2, group_key)


def same_operator(name: str | None, key: str, icao: str | None) -> bool:
    """Un opérateur (nom de la base de référence) appartient-il à la compagnie `key` ?"""
    k = _key(name)
    if not k:
        return True
    if icao:
        refs = _refs(icao)
        if refs:
            return compatible(k, refs)
    return True
