"""Identité d'une compagnie dans les spots.

Le code OACI d'un spot (`airline_icao`) vient souvent d'une base d'appareils qui rattache une filiale
à sa maison mère (Hop! → AFR). Regrouper aveuglément par code mélange alors les deux flottes.
`group_key(icao, owner)` garde le code OACI tant que le propriétaire saisi est compatible avec le nom
connu de ce code, et bascule sur le nom du propriétaire sinon. Elle est enregistrée dans SQLite sous
le nom `opg` et remplace `COALESCE(airline_icao, owner)` partout.
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


def _refs(icao: str) -> frozenset[str]:
    """Noms de référence d'un code OACI : nom enregistré, opérateur dominant de la base de référence, sinon spots."""
    path = str(db_path())
    hit = _cache.get((path, icao))
    now = time.monotonic()
    if hit and now - hit[0] < TTL:
        return hit[1]
    refs: set[str] = set()
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            for (n,) in c.execute("SELECT name FROM airlines WHERE (key = ? OR icao = ?) AND name IS NOT NULL", (icao, icao)):
                refs.add(_key(n))
            from app.services import refdb
            for n in refdb.dominant_operators(icao):
                refs.add(_key(n))
            if not refs:
                rows = c.execute("SELECT owner, COUNT(*) n FROM spotting WHERE airline_icao = ? AND owner IS NOT NULL "
                                 "GROUP BY owner ORDER BY n DESC", (icao,)).fetchall()
                if rows:
                    refs |= {_key(o) for o, n in rows if n == rows[0][1]}
        finally:
            c.close()
    except sqlite3.Error:
        refs = set()
    refs.discard("")
    out = frozenset(refs)
    _cache[(path, icao)] = (now, out)
    return out


def reset_cache() -> None:
    _cache.clear()


def group_key(icao: str | None, owner: str | None) -> str | None:
    icao = (icao or "").strip().upper() or None
    owner = (owner or "").strip() or None
    if not owner:
        return icao
    if not icao:
        return owner
    refs = _refs(icao)
    if not refs or compatible(_key(owner), refs):
        return icao
    return owner


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
