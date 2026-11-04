"""Wishlist : ce que l'on veut voir ou photographier.

Un souhait peut viser un appareil précis, un modèle (ou toute sa famille), une compagnie, une livrée,
un aéroport, un événement (meeting aérien) ou être libre. Les souhaits à critères se valident seuls dès
qu'un spot correspondant est enregistré (`sync`), avec une progression quand plusieurs appareils
distincts sont attendus. Les appareils peuvent en plus être suivis en direct (alerte quand ils volent).
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime

from ..core import execute, now_iso, q, q1
from . import actypes, geo, operators, refdb
from . import registration as regs
from .notify import notify, texts

KINDS = ("aircraft", "type", "airline", "livery", "event", "airport", "other")
CRITERIA = ("aircraft", "type", "airline", "livery", "event", "airport")


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def today() -> date:
    return datetime.now().date()


def _d(s: str | None) -> date | None:
    try:
        return date.fromisoformat((s or "")[:10])
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Appariement
# --------------------------------------------------------------------------- #
class Spots:
    """Spots chargés une fois par évaluation, avec les clés dérivées mises en cache."""

    def __init__(self) -> None:
        self.rows = q("SELECT id_spotting id, registration, aircraft, aircraft_icao, owner, airline_icao, livery, airport, "
                      "thumb, COALESCE(date, created_at) d, created_at c FROM spotting")
        self._airline: dict[int, str | None] = {}
        self._family: dict[int, str | None] = {}
        self._apt: dict[str | None, str | None] = {}

    def airline(self, s: dict) -> str | None:
        if s["id"] not in self._airline:
            self._airline[s["id"]] = operators.group_key(s["airline_icao"], s["owner"])
        return self._airline[s["id"]]

    def family(self, s: dict) -> str | None:
        if s["id"] not in self._family:
            self._family[s["id"]] = actypes.family(s["aircraft_icao"], s["aircraft"])
        return self._family[s["id"]]

    def airport(self, code: str | None) -> str | None:
        if code not in self._apt:
            self._apt[code] = geo.resolve_icao(code) if code else None
        return self._apt[code]


def matches(w: dict, s: dict, ctx: Spots) -> bool:
    kind, val = w["kind"], (w.get("value") or "")
    if w.get("since") and (s["c"] or s["d"] or "")[:10] < w["since"][:10]:   # « enregistrés depuis » : date de saisie
        return False
    if kind == "aircraft":
        return (s["registration"] or "").upper() == val.upper()
    if kind == "type":
        code = (s["aircraft_icao"] or "").upper()
        if w.get("family"):
            fam = actypes.family(val, w.get("title"))
            if fam:
                return ctx.family(s) == fam
        if re.fullmatch(r"[A-Z0-9]{2,4}", val.upper()) and (code or not s["aircraft"]):
            return code == val.upper()
        return bool(_norm(val)) and _norm(val) in _norm(f"{s['aircraft'] or ''} {code}")
    if kind == "airline":
        k = (ctx.airline(s) or "").upper()
        if k and k == val.upper():
            return True
        ok = refdb._opkey(val)
        return bool(ok) and ok == refdb._opkey(s["owner"])
    if kind == "livery":
        if not _norm(val) or _norm(val) not in _norm(s["livery"]):
            return False
        return not w.get("airline_key") or (ctx.airline(s) or "").upper() == w["airline_key"].upper()
    if kind == "airport":
        return bool(val) and ctx.airport(val) == ctx.airport(s["airport"]) is not None
    if kind == "event":
        a, b = _d(w.get("start_date")), _d(w.get("end_date")) or _d(w.get("start_date"))
        sd = _d(s["d"])
        if not (a and b and sd and a <= sd <= b):
            return False
        return not w.get("airport") or ctx.airport(w["airport"]) == ctx.airport(s["airport"])
    return False


def evaluate(w: dict, ctx: Spots) -> tuple[int, list[dict]]:
    ms = [s for s in ctx.rows if matches(w, s, ctx)] if w["kind"] in CRITERIA else []
    ms.sort(key=lambda s: ((s["d"] or ""), s["id"]), reverse=True)
    n = len({s["registration"] for s in ms})
    return n, ms


# --------------------------------------------------------------------------- #
# Validation à l'enregistrement
# --------------------------------------------------------------------------- #
def _default_title(kind: str, value: str | None) -> str | None:
    if not value:
        return None
    if kind == "aircraft":
        return value
    if kind == "type":
        return actypes.name(value) or value
    if kind == "airline":
        r = q1("SELECT name FROM airlines WHERE key = ? AND name IS NOT NULL", (value,)) \
            or q1("SELECT MAX(owner) name FROM spotting WHERE opg(airline_icao, owner) = ?", (value,))
        return (r or {}).get("name") or value
    if kind == "airport":
        a = geo.airport(value)
        return f"{a['name']} ({a['icao']})" if a else value
    return value


def clean(body: dict, existing: dict | None = None) -> dict:
    """Normalise une saisie ; lève ValueError(code) si elle est inutilisable."""
    src = {**(existing or {}), **{k: v for k, v in body.items() if v is not None or k in ("note", "url", "place", "airport",
                                                                                        "airline_key", "parent_id")}}
    kind = src.get("kind")
    if kind not in KINDS:
        raise ValueError("kind_invalid")
    out: dict = {"kind": kind}
    val = (src.get("value") or "").strip() or None
    if kind == "aircraft":
        val = regs.normalize(val or "")
        if not val:
            raise ValueError("registration_required")
    elif kind == "type":
        val = (val or "").upper() if val and re.fullmatch(r"[A-Za-z0-9]{2,4}", val) else val
    elif kind == "airport":
        a = geo.airport(val)
        val = a["icao"] if a else (val or "").upper() or None
    elif kind == "airline" and val and re.fullmatch(r"[A-Za-z]{3}", val):
        val = val.upper()
    if kind in ("aircraft", "type", "airline", "livery", "airport") and not val:
        raise ValueError("value_required")
    out["value"] = val
    title = (src.get("title") or "").strip() or _default_title(kind, val)
    if not title:
        raise ValueError("title_required")
    out["title"] = title[:160]
    out["airline_key"] = ((src.get("airline_key") or "").strip() or None) if kind == "livery" else None
    out["family"] = int(bool(src.get("family"))) if kind == "type" else 0
    out["note"] = (src.get("note") or "").strip() or None
    out["priority"] = min(3, max(1, int(src.get("priority") or 2)))
    out["goal_count"] = min(999, max(1, int(src.get("goal_count") or 1))) if kind != "aircraft" else 1
    out["auto_complete"] = int(bool(src.get("auto_complete", 1))) if kind != "other" else 0
    out["track"] = int(bool(src.get("track"))) if kind == "aircraft" else 0
    out["notify"] = int(bool(src.get("notify", 1)))
    out["remind_days"] = min(60, max(0, int(src.get("remind_days") if src.get("remind_days") is not None else 7)))
    out["place"] = (src.get("place") or "").strip() or None
    out["url"] = (src.get("url") or "").strip() or None
    apt = (src.get("airport") or "").strip()
    out["airport"] = (geo.resolve_icao(apt) or None) if apt and kind == "event" else None
    for k in ("lat", "lng"):
        try:
            out[k] = float(src[k]) if src.get(k) not in (None, "") else None
        except (TypeError, ValueError):
            out[k] = None
    if kind == "event":
        a, b = _d(src.get("start_date")), _d(src.get("end_date"))
        if not a:
            raise ValueError("start_date_required")
        if b and b < a:
            raise ValueError("dates_invalid")
        out["start_date"], out["end_date"] = a.isoformat(), (b or a).isoformat()
    else:
        out["start_date"] = out["end_date"] = None
        d = _d(src.get("end_date"))   # échéance facultative des autres souhaits
        out["end_date"] = d.isoformat() if d else None
    pid = src.get("parent_id")
    if pid:
        parent = q1("SELECT id, kind FROM wishes WHERE id = ?", (int(pid),))
        if not parent or parent["kind"] != "event" or (existing and parent["id"] == existing["id"]):
            raise ValueError("parent_invalid")
        out["parent_id"] = parent["id"]
    else:
        out["parent_id"] = None
    return out


def duplicate(c: dict, ignore_id: int | None = None) -> dict | None:
    if c["kind"] in ("event", "other"):
        return None
    return q1("SELECT id FROM wishes WHERE status = 'open' AND kind = ? AND UPPER(value) = UPPER(?) "
              "AND COALESCE(airline_key,'') = COALESCE(?, '') AND family = ? AND id <> ?",
              (c["kind"], c["value"], c["airline_key"], c["family"], ignore_id or 0))


def insert(c: dict, count_existing: bool = False) -> int:
    now = now_iso()
    c = {**c, "since": None if count_existing else today().isoformat(), "created_at": now, "updated_at": now}
    cur = execute(f"INSERT INTO wishes({', '.join(c)}) VALUES({', '.join('?' * len(c))})", list(c.values()))
    return cur.lastrowid


# --------------------------------------------------------------------------- #
# Validation automatique et rappels
# --------------------------------------------------------------------------- #
def sync(notify_done: bool = True) -> list[dict]:
    """Recalcule la progression des souhaits ouverts et valide ceux qui sont atteints. Retourne les nouveaux réalisés."""
    open_ = q("SELECT * FROM wishes WHERE status = 'open' AND kind IN ('aircraft','type','airline','livery','event','airport')")
    if not open_:
        return []
    ctx = Spots()
    done: list[dict] = []
    for w in open_:
        n, ms = evaluate(w, ctx)
        finished = bool(w["auto_complete"]) and n >= w["goal_count"]
        if finished and w["kind"] == "event":
            end = _d(w["end_date"]) or _d(w["start_date"])
            finished = bool(end) and today() > end
        if finished:
            spot = ms[0] if ms else None
            execute("UPDATE wishes SET status='done', progress=?, done_at=?, done_spot_id=?, airborne=0, updated_at=? WHERE id=?",
                    (n, now_iso(), spot["id"] if spot else None, now_iso(), w["id"]))
            done.append({**w, "done_spot_id": spot["id"] if spot else None})
        elif n != w["progress"]:
            execute("UPDATE wishes SET progress=? WHERE id=?", (n, w["id"]))
    if notify_done:
        for w in done:
            if w["notify"]:
                title, body = texts("wish_done", title=w["title"])
                link = f"#/spots/{w['done_spot_id']}" if w["done_spot_id"] else "#/wishlist"
                notify("wishlist", title, body, link, {"wish": w["id"], "kind": w["kind"]})
    return done


def reminders() -> int:
    """Rappels d'événements : à J-remind_days, la veille et le jour même (une seule fois chacun)."""
    sent = 0
    for w in q("SELECT * FROM wishes WHERE status='open' AND kind='event' AND notify=1 AND start_date IS NOT NULL"):
        start = _d(w["start_date"])
        days = (start - today()).days if start else -1
        if days < 0 or w["reminded"] == days or days not in {w["remind_days"], 1, 0}:
            continue
        where = " · ".join(x for x in (w["place"], w["airport"]) if x)
        if days == 0:
            title, body = texts("wish_event_today", title=w["title"], where=where or "—")
        else:
            title, body = texts("wish_event", title=w["title"], n=days, where=where or "—")
        notify("wishlist", title, body, "#/wishlist", {"wish": w["id"], "days": days})
        execute("UPDATE wishes SET reminded=? WHERE id=?", (days, w["id"]))
        sent += 1
    return sent


# --------------------------------------------------------------------------- #
# Radar
# --------------------------------------------------------------------------- #
def radar_matcher():
    """Fonction (hex, immat, type, indicatif) → souhait correspondant, pour repérer un souhait sur le radar."""
    ws = q("SELECT id, kind, value, title, family, priority, icao24 FROM wishes WHERE status='open' "
           "AND kind IN ('aircraft','type','airline')")
    by_reg = {w["value"].upper(): w for w in ws if w["kind"] == "aircraft"}
    by_hex = {w["icao24"].lower(): w for w in ws if w["kind"] == "aircraft" and w["icao24"]}
    types = [w for w in ws if w["kind"] == "type"]
    airlines = {w["value"].upper(): w for w in ws if w["kind"] == "airline" and re.fullmatch(r"[A-Z]{3}", w["value"] or "")}

    def match(hx: str | None, reg: str | None, typ: str | None, callsign: str | None) -> dict | None:
        if hx and hx.lower() in by_hex:
            return by_hex[hx.lower()]
        if reg and reg.upper() in by_reg:
            return by_reg[reg.upper()]
        if typ:
            for w in types:
                if (w["value"] or "").upper() == typ.upper():
                    return w
                if w["family"] and actypes.family(w["value"], w["title"]) and actypes.family(w["value"], w["title"]) == actypes.family(typ):
                    return w
        if callsign and len(callsign) >= 4 and callsign[:3].isalpha() and callsign[3].isdigit():
            return airlines.get(callsign[:3].upper())
        return None
    return match


def tracked() -> list[dict]:
    return q("SELECT * FROM wishes WHERE kind='aircraft' AND status='open' AND track=1")


# --------------------------------------------------------------------------- #
# Sérialisation
# --------------------------------------------------------------------------- #
def decorate(rows: list[dict]) -> list[dict]:
    """Ajoute à chaque souhait les informations d'affichage (photo, dernier spot, jours restants…)."""
    if not rows:
        return rows
    ctx = Spots()
    by_id = {s["id"]: s for s in ctx.rows}
    t = today()
    for w in rows:
        w["last_status"] = json.loads(w["last_status"]) if isinstance(w.get("last_status"), str) else w.get("last_status")
        spot = None
        if w["status"] == "open":
            n, ms = evaluate(w, ctx)
            w["progress"] = n
            spot = ms[0] if ms else None
        elif w.get("done_spot_id"):
            spot = by_id.get(w["done_spot_id"])
        w["last_spot"] = ({"id": spot["id"], "registration": spot["registration"], "date": spot["d"], "airport": spot["airport"]}
                          if spot else None)
        w["thumb"] = spot["thumb"] if spot else None
        if w["kind"] == "aircraft":
            reg = w["value"]
            w["registration"] = reg
            w["country"] = regs.country_of(reg)
            c = q1("SELECT json_extract(data,'$.aircraft') a, json_extract(data,'$.owner') o FROM aircraft_cache WHERE registration = ?", (reg,))
            seen = [s for s in ctx.rows if (s["registration"] or "").upper() == reg.upper()]
            w["spotted"] = len(seen)
            w["aircraft"] = (c or {}).get("a") or (seen[0]["aircraft"] if seen else None)
            w["owner"] = (c or {}).get("o") or (seen[0]["owner"] if seen else None)
            if not w["thumb"]:
                w["thumb"] = next((s["thumb"] for s in sorted(seen, key=lambda s: s["d"] or "", reverse=True) if s["thumb"]), None)
        start, end = _d(w.get("start_date")), _d(w.get("end_date"))
        w["days_to_start"] = (start - t).days if start and w["kind"] == "event" else None
        w["days_left"] = (end - t).days if end else None
        w["ongoing"] = bool(w["kind"] == "event" and start and end and start <= t <= end)
        w["past"] = bool(end and end < t)
    return rows


def summary() -> dict:
    ctx_rows = q("SELECT * FROM wishes ORDER BY priority DESC, created_at DESC")
    open_ = [w for w in ctx_rows if w["status"] == "open"]
    year = str(today().year)
    upcoming = [w for w in open_ if w["kind"] == "event" and (_d(w["end_date"]) or date.max) >= today()]
    upcoming.sort(key=lambda w: w["start_date"] or "")
    return {
        "open": len(open_), "done": sum(1 for w in ctx_rows if w["status"] == "done"),
        "done_year": sum(1 for w in ctx_rows if w["status"] == "done" and (w["done_at"] or "").startswith(year)),
        "events": decorate(upcoming[:3]),
        "top": decorate([w for w in open_ if w["kind"] != "event"][:4]),
        "airborne": [{"registration": w["value"], "title": w["title"]} for w in open_ if w["airborne"]],
    }
