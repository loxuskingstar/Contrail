"""Livrées spéciales, badges dynamiques et références croisées spots / vols."""
from __future__ import annotations

import re

from ..core import q

LIVERY_RULES: list[tuple[str, re.Pattern]] = [
    ("alliance", re.compile(r"star\s?alliance|sky\s?team|one\s?world|alianza|alliance", re.I)),
    ("retro", re.compile(r"r[ée]tro|heritage|vintage|classic|historic|throwback|ancienne|old\s?colou?rs?|"
                         r"\b(19[2-8]\d)s?\b|レトロ", re.I)),
    ("commemorative", re.compile(r"anniversa|jubil|\d+\s?(ans|years|años|jahre|周年)|commemor|"
                                 r"comm[ée]mor|tribute|hommage|centen|celebrat|olymp|world\s?cup|"
                                 r"coupe du monde|expo|記念", re.I)),
    ("logojet", re.compile(r"logo|sponsor|promo|advert|pub\b|publicit|movie|film|star\s?wars|disney|"
                           r"pokemon|pokémon|team|club|football|rugby|ジェット", re.I)),
    ("cause", re.compile(r"pink|ribbon|cancer|unicef|pride|rainbow|charity|climate|eco|green|ukraine|"
                         r"solidar", re.I)),
]


def is_special_livery(livery: str | None) -> bool:
    if not livery:
        return False
    return livery.strip().lower() not in ("", "none", "standard", "classique", "classic livery", "normal", "-")


def livery_category(livery: str | None) -> str | None:
    if not is_special_livery(livery):
        return None
    for cat, rx in LIVERY_RULES:
        if rx.search(livery or ""):
            return cat
    return "special"


# --------------------------------------------------------------------------- #
# Badges dynamiques
# --------------------------------------------------------------------------- #
def badge_context() -> dict:
    """Pré-calcule une fois les agrégats nécessaires à l'attribution des badges."""
    ctx: dict = {}
    order = "COALESCE(date, created_at), id_spotting"
    ctx["first_type"] = {r["id"] for r in q(
        f"SELECT (SELECT id_spotting FROM spotting s2 WHERE COALESCE(s2.aircraft_icao, s2.aircraft) = g.k "
        f"ORDER BY {order} LIMIT 1) AS id FROM (SELECT DISTINCT COALESCE(aircraft_icao, aircraft) AS k "
        f"FROM spotting WHERE COALESCE(aircraft_icao, aircraft) IS NOT NULL) g")}
    ctx["first_airline"] = {r["id"] for r in q(
        f"SELECT (SELECT id_spotting FROM spotting s2 WHERE opg(s2.airline_icao, s2.owner) = g.k "
        f"ORDER BY {order} LIMIT 1) AS id FROM (SELECT DISTINCT opg(airline_icao, owner) AS k "
        f"FROM spotting WHERE opg(airline_icao, owner) IS NOT NULL) g")}
    ctx["first_airport"] = {r["id"] for r in q(
        f"SELECT (SELECT id_spotting FROM spotting s2 WHERE s2.airport = g.k ORDER BY {order} LIMIT 1) AS id "
        f"FROM (SELECT DISTINCT airport AS k FROM spotting WHERE airport IS NOT NULL AND airport <> '') g")}
    counts = {r["registration"]: r["n"] for r in q(
        "SELECT registration, COUNT(*) n FROM spotting GROUP BY registration")}
    ctx["reg_counts"] = counts
    top = max(counts.values(), default=0)
    ctx["most_spotted"] = {r for r, n in counts.items() if n == top and n >= 2}
    ctx["flown"] = {r["registration"] for r in q(
        "SELECT DISTINCT registration FROM flights WHERE registration IS NOT NULL AND registration <> ''")}
    # rang chronologique de chaque spot pour son immatriculation
    ctx["rank"] = {r["id_spotting"]: r["rk"] for r in q(
        f"SELECT id_spotting, ROW_NUMBER() OVER (PARTITION BY registration ORDER BY {order}) rk FROM spotting")}
    return ctx


def badges_for(spot: dict, ctx: dict) -> list[dict]:
    b: list[dict] = []
    sid = spot["id_spotting"]
    reg = spot["registration"]
    if sid in ctx["first_type"]:
        b.append({"code": "first_type"})
    if sid in ctx["first_airline"]:
        b.append({"code": "first_airline"})
    if sid in ctx["first_airport"]:
        b.append({"code": "first_airport"})
    n = ctx["reg_counts"].get(reg, 1)
    rank = ctx["rank"].get(sid, 1)
    if rank > 1:
        b.append({"code": "seen_again", "n": rank})
    if reg in ctx["most_spotted"]:
        b.append({"code": "most_spotted", "n": n})
    if is_special_livery(spot.get("livery")):
        b.append({"code": "special_livery", "cat": spot.get("livery_category") or "special"})
    if reg in ctx["flown"]:
        b.append({"code": "flown"})
    if spot.get("military"):
        b.append({"code": "military"})
    el = spot.get("sun_elevation")
    if el is not None:
        if el < -6:
            b.append({"code": "night"})
        elif el <= 8:
            b.append({"code": "golden_hour"})
    return b


def crossref_for_spot(reg: str) -> list[dict]:
    return q("SELECT id_flight, date, dep_icao, arr_icao, flight_number FROM flights WHERE registration = ? "
             "ORDER BY date", (reg,))


def crossref_for_flight(reg: str) -> list[dict]:
    return q("SELECT id_spotting, date, airport, thumb FROM spotting WHERE registration = ? ORDER BY date", (reg,))
