"""Une même cellule sous plusieurs immatriculations.

Un avion photographié en F-WWCF (essais) puis en F-HXXX (livré) est le même appareil. Deux liens le montrent :
l'immatriculation d'essai saisie sur un spot, et le MSN (numéro de série constructeur), à condition que les
deux spots soient du même constructeur ou de la même famille — un MSN n'est unique que chez un constructeur.
"""
from __future__ import annotations

from ..core import q
from . import actypes
from . import registration as regs


def _msn(v: str | None) -> str:
    return (v or "").strip().upper().lstrip("0")


def _maker(s: dict) -> str | None:
    fam = actypes.family(s.get("aircraft_icao"), s.get("aircraft"))
    if fam:
        return f"fam:{fam.split()[0].lower()}"      # « Airbus A320 » → « airbus » : A320 et A350 partagent la numérotation Airbus
    m = (s.get("manufacturer") or "").strip().lower()
    return f"mfr:{m}" if m else None


def _build() -> tuple[list[set[str]], dict[str, int], dict[str, list[int]]]:
    """Liens entre immatriculations d'une même cellule + nombre de spots par immatriculation (une seule lecture de la table)."""
    by_msn: dict[tuple[str, str], set[str]] = {}
    links: list[set[str]] = []
    counts: dict[str, int] = {}
    for s in q("SELECT registration, test_registration, msn, manufacturer, aircraft_icao, aircraft FROM spotting"):
        counts[s["registration"]] = counts.get(s["registration"], 0) + 1
        own = {x for x in (s["registration"], s["test_registration"]) if x}
        if len(own) > 1:
            links.append(own)                       # immat d'essai ↔ immat portée sur ce spot
        msn = _msn(s["msn"])
        if msn:
            mk = _maker(s)
            if mk:
                by_msn.setdefault((mk, msn), set()).update(own)
    links += [v for v in by_msn.values() if len(v) > 1]
    index: dict[str, list[int]] = {}
    for i, l in enumerate(links):
        for x in l:
            index.setdefault(x, []).append(i)
    return links, counts, index


def group(reg: str) -> list[str]:
    """Immatriculations rattachées à `reg` (elle-même comprise), la plus utilisée en premier."""
    from ..core import memo

    r = regs.normalize(reg)
    links, counts, index = memo("airframe_links", _build)
    seen = {r}
    todo = [r]
    done: set[int] = set()
    while todo:                                     # fermeture transitive : F-WWCF ↔ F-HXXX ↔ D-AXXX
        for i in index.get(todo.pop(), ()):
            if i not in done:
                done.add(i)
                for x in links[i]:
                    if x not in seen:
                        seen.add(x)
                        todo.append(x)
    if len(seen) == 1:
        return [r]
    return sorted(seen, key=lambda x: (x != r, -counts.get(x, 0), x))
