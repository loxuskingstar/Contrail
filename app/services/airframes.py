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


def group(reg: str) -> list[str]:
    """Immatriculations rattachées à `reg` (elle-même comprise), la plus utilisée en premier."""
    r = regs.normalize(reg)
    rows = q("SELECT registration, test_registration, msn, manufacturer, aircraft_icao, aircraft FROM spotting")
    by_msn: dict[tuple[str, str], set[str]] = {}
    links: list[set[str]] = []
    for s in rows:
        own = {x for x in (s["registration"], s["test_registration"]) if x}
        if len(own) > 1:
            links.append(own)                       # immat d'essai ↔ immat portée sur ce spot
        mk, msn = _maker(s), _msn(s["msn"])
        if msn and mk:
            by_msn.setdefault((mk, msn), set()).update(own)
    links += [v for v in by_msn.values() if len(v) > 1]
    seen = {r}
    changed = True
    while changed:                                  # fermeture transitive : F-WWCF ↔ F-HXXX ↔ D-AXXX
        changed = False
        for l in links:
            if seen & l and not l <= seen:
                seen |= l
                changed = True
    if len(seen) == 1:
        return [r]
    n = {x: 0 for x in seen}
    for s in rows:
        if s["registration"] in n:
            n[s["registration"]] += 1
    return sorted(seen, key=lambda x: (x != r, -n[x], x))
