"""Sorties de spotting : une journée sur un site (aéroport ou lieu libre), rattachée automatiquement aux spots."""
from __future__ import annotations

from ..core import db, now_iso, q, q1

_KEY = ("o.day = substr(s.date, 1, 10) AND COALESCE(o.airport, '') = COALESCE(NULLIF(s.airport, ''), '') "
        "AND COALESCE(o.place, '') = COALESCE(NULLIF(s.place, ''), '')")


def key_of(s: dict) -> tuple[str, str | None, str | None] | None:
    d = (s.get("date") or "")[:10]
    ap = (s.get("airport") or "").strip() or None
    pl = (s.get("place") or "").strip() or None
    if len(d) != 10 or not (ap or pl):
        return None
    return d, ap, pl


def attach(spot_id: int) -> int | None:
    """Rattache un spot à la sortie de son jour et de son site (créée au besoin) ; None s'il n'a ni date ni site."""
    s = q1("SELECT id_spotting, date, airport, place, outing_id FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s:
        return None
    k = key_of(s)
    conn = db()
    if k is None:
        new = None
    else:
        row = q1("SELECT id_outing FROM outings WHERE day = ? AND COALESCE(airport, '') = ? AND COALESCE(place, '') = ?",
                 (k[0], k[1] or "", k[2] or ""))
        new = row["id_outing"] if row else conn.execute(
            "INSERT INTO outings (day, airport, place, created_at) VALUES (?, ?, ?, ?)", (k[0], k[1], k[2], now_iso())).lastrowid
    if new != s["outing_id"]:
        conn.execute("UPDATE spotting SET outing_id = ? WHERE id_spotting = ?", (new, spot_id))
    conn.commit()
    if s["outing_id"] and s["outing_id"] != new:
        gc()
    return new


def sync() -> int:
    """Rattache tous les spots encore sans sortie (import, ancien spot…) ; retourne leur nombre."""
    n = q1("SELECT COUNT(*) n FROM spotting WHERE outing_id IS NULL AND date IS NOT NULL AND length(date) >= 10 "
           "AND (NULLIF(airport, '') IS NOT NULL OR NULLIF(place, '') IS NOT NULL)")["n"]
    if not n:
        return 0
    conn = db()
    conn.execute("INSERT OR IGNORE INTO outings (day, airport, place, created_at) "
                 "SELECT DISTINCT substr(date, 1, 10), NULLIF(airport, ''), NULLIF(place, ''), ? FROM spotting "
                 "WHERE outing_id IS NULL AND date IS NOT NULL AND length(date) >= 10 "
                 "AND (NULLIF(airport, '') IS NOT NULL OR NULLIF(place, '') IS NOT NULL)", (now_iso(),))
    conn.execute(f"UPDATE spotting AS s SET outing_id = (SELECT o.id_outing FROM outings o WHERE {_KEY}) "
                 "WHERE s.outing_id IS NULL AND s.date IS NOT NULL AND length(s.date) >= 10 "
                 "AND (NULLIF(s.airport, '') IS NOT NULL OR NULLIF(s.place, '') IS NOT NULL)")
    conn.commit()
    return n


def gc() -> None:
    """Supprime les sorties vides qui n'ont ni nom ni notes."""
    conn = db()
    conn.execute("DELETE FROM outings WHERE COALESCE(name, '') = '' AND COALESCE(notes, '') = '' "
                 "AND NOT EXISTS (SELECT 1 FROM spotting s WHERE s.outing_id = outings.id_outing)")
    conn.commit()
