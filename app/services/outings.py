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


_RANGE = ("COALESCE(o.airport, '') = ? AND COALESCE(o.place, '') = ? AND o.day <= ? AND COALESCE(o.end_day, o.day) >= ?")


def find(day: str, airport: str | None, place: str | None) -> int | None:
    """Sortie couvrant ce jour sur ce site (une sortie de plusieurs jours l'emporte sur une sortie d'un jour)."""
    r = q1(f"SELECT o.id_outing id FROM outings o WHERE {_RANGE} ORDER BY (o.end_day IS NOT NULL) DESC, o.day LIMIT 1",
           (airport or "", place or "", day, day))
    return r["id"] if r else None


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
        found = find(*k)
        new = found if found else conn.execute(
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
    conn.execute("UPDATE spotting AS s SET outing_id = (SELECT o.id_outing FROM outings o WHERE "
                 "COALESCE(o.airport, '') = COALESCE(NULLIF(s.airport, ''), '') AND COALESCE(o.place, '') = COALESCE(NULLIF(s.place, ''), '') "
                 "AND o.day <= substr(s.date, 1, 10) AND COALESCE(o.end_day, o.day) >= substr(s.date, 1, 10) "
                 "ORDER BY (o.end_day IS NOT NULL) DESC, o.day LIMIT 1) "
                 "WHERE s.outing_id IS NULL AND s.date IS NOT NULL AND length(s.date) >= 10 "
                 "AND (NULLIF(s.airport, '') IS NOT NULL OR NULLIF(s.place, '') IS NOT NULL)")
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
                 "AND kind = 'outing' AND NOT EXISTS (SELECT 1 FROM spotting s WHERE s.outing_id = outings.id_outing)")
    conn.commit()


# --------------------------------------------------------------------------- #
# Fusion, scission, planification (meetings aériens sur plusieurs jours)
# --------------------------------------------------------------------------- #
class OutingError(ValueError):
    pass


def _site(o: dict) -> tuple[str, str]:
    return (o.get("airport") or "", o.get("place") or "")


def merge(ids: list[int], name: str | None = None, kind: str | None = None) -> int:
    """Fusionne des sorties du même site en une seule couvrant tous leurs jours ; retourne l'id conservé (la plus ancienne)."""
    ids = list(dict.fromkeys(ids))
    rows = [q1("SELECT * FROM outings WHERE id_outing = ?", (i,)) for i in ids]
    if len(ids) < 2 or any(r is None for r in rows):
        raise OutingError("need_two")
    if len({_site(r) for r in rows}) > 1:
        raise OutingError("different_sites")
    rows.sort(key=lambda r: (r["day"], r["id_outing"]))
    keep, others = rows[0], rows[1:]
    end = max(r.get("end_day") or r["day"] for r in rows)
    notes = "\n\n".join(dict.fromkeys(r["notes"].strip() for r in rows if r.get("notes") and r["notes"].strip())) or None
    nm = (name or "").strip() or next((r["name"] for r in rows if r.get("name")), None)
    kd = kind if kind in ("outing", "airshow") else ("airshow" if any(r["kind"] == "airshow" for r in rows) else keep["kind"])
    conn = db()
    for r in others:
        conn.execute("UPDATE spotting SET outing_id = ? WHERE outing_id = ?", (keep["id_outing"], r["id_outing"]))
        conn.execute("UPDATE outing_items SET outing_id = ? WHERE outing_id = ?", (keep["id_outing"], r["id_outing"]))
        conn.execute("DELETE FROM outings WHERE id_outing = ?", (r["id_outing"],))
    conn.execute("UPDATE outings SET end_day = ?, name = ?, notes = ?, kind = ? WHERE id_outing = ?",
                 (end if end > keep["day"] else None, nm, notes, kd, keep["id_outing"]))
    conn.commit()
    return keep["id_outing"]


def split(outing_id: int) -> None:
    """Défait une fusion : chaque jour redevient une sortie. Le nom et les notes restent sur le premier jour."""
    o = q1("SELECT * FROM outings WHERE id_outing = ?", (outing_id,))
    if not o or not o.get("end_day"):
        raise OutingError("not_multi_day")
    conn = db()
    conn.execute("UPDATE spotting SET outing_id = NULL WHERE outing_id = ?", (outing_id,))
    conn.execute("UPDATE outings SET end_day = NULL WHERE id_outing = ?", (outing_id,))
    conn.commit()
    sync()


def plan(day: str, end_day: str | None, airport: str | None, place: str | None, name: str | None, kind: str = "airshow") -> int:
    """Crée (ou complète) une sortie planifiée, puis y rassemble les sorties et spots déjà présents sur ces jours."""
    import re
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day or ""):
        raise OutingError("bad_day")
    end = end_day if end_day and end_day > day else None
    if end and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
        raise OutingError("bad_day")
    ap = (airport or "").strip().upper() or None
    pl = (place or "").strip() or None
    if not (ap or pl):
        raise OutingError("need_site")
    conn = db()
    row = q1("SELECT id_outing FROM outings WHERE day = ? AND COALESCE(airport, '') = ? AND COALESCE(place, '') = ?", (day, ap or "", pl or ""))
    if row:
        oid = row["id_outing"]
        conn.execute("UPDATE outings SET end_day = ?, kind = ?, name = COALESCE(?, name) WHERE id_outing = ?",
                     (end, kind, (name or "").strip() or None, oid))
    else:
        oid = conn.execute("INSERT INTO outings (day, end_day, airport, place, name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (day, end, ap, pl, (name or "").strip() or None, kind, now_iso())).lastrowid
    conn.commit()
    last = end or day
    inside = [r["id_outing"] for r in q("SELECT id_outing FROM outings WHERE COALESCE(airport, '') = ? AND COALESCE(place, '') = ? "
                                         "AND day >= ? AND day <= ? AND id_outing <> ?", (ap or "", pl or "", day, last, oid))]
    if inside:
        oid = merge([oid, *inside], name, kind)
    sync()
    return oid
