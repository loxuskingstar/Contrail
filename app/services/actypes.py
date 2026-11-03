"""Types d'appareils : désignation courante et classe de silhouette à partir du code OACI.

La table (static/data/aircraft_types.json) est partagée avec l'interface (radar, cartes de partage).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from ..core import STATIC_DIR

LIGHT_CLASSES = {"light", "heli", "glider", "balloon", "drone"}


@lru_cache(maxsize=1)
def _table() -> dict[str, list[str]]:
    try:
        return json.loads((STATIC_DIR / "data" / "aircraft_types.json").read_text("utf-8"))["types"]
    except (OSError, ValueError, KeyError):
        return {}


def name(code: str | None) -> str | None:
    if not code:
        return None
    e = _table().get(code.upper())
    return e[0] if e else None


# Catégories ADS-B (OpenSky « category ») → classe
_CATEGORY = {2: "light", 3: "bizjet", 4: "narrow", 5: "narrow", 6: "wide", 7: "fighter", 8: "heli", 9: "glider",
             10: "balloon", 11: "light", 12: "light", 14: "drone"}

_DESC_RULES = [
    (re.compile(r"helicop|hélicop|rotor|\bH1[2-7]\d\b|\bEC1[2-5]\d\b|\bAW1\d\d\b|robinson", re.I), "heli"),
    (re.compile(r"glider|planeur|segelflug|\bASK\b|discus|ventus", re.I), "glider"),
    (re.compile(r"balloon|ballon|airship", re.I), "balloon"),
    (re.compile(r"A380|747|A340|An-?124|C-?17\b|Il-?76", re.I), "jumbo"),
    (re.compile(r"A3[03][0-9]|A35|7[6-8]7|MD-?11|DC-?10|A300|A310", re.I), "wide"),
    (re.compile(r"A3[12][0-9]|A220|737|757|717|MD-?8|C919", re.I), "narrow"),
    (re.compile(r"CRJ|ERJ|E1[79]\d|E-?Jet|Fokker (70|100)|Avro RJ|BAe 146|Superjet", re.I), "regional"),
    (re.compile(r"ATR|Dash ?8|DHC|Saab 340|King Air|Caravan|PC-?12|TBM|Hercules|A400|Jetstream|Twin Otter|turboprop", re.I), "turboprop"),
    (re.compile(r"Citation|Challenger|Global|Gulfstream|Falcon|Learjet|Phenom|Legacy|PC-?24|Hawker|HondaJet", re.I), "bizjet"),
    (re.compile(r"Rafale|Mirage|F-?16|F-?15|F-?18|F-?35|Eurofighter|Typhoon|Tornado|Alpha ?Jet|Hawk|Gripen", re.I), "fighter"),
    (re.compile(r"Cessna 1\d\d|Piper|Robin|Cirrus|Diamond DA|Mooney|Bonanza|Socata|Jodel|Cub", re.I), "light"),
]


def classify(code: str | None = None, category: int | None = None, desc: str | None = None) -> str:
    if code:
        e = _table().get(code.upper())
        if e:
            return e[1]
    if desc:
        for rx, cls in _DESC_RULES:
            if rx.search(desc):
                return cls
    if category in _CATEGORY:
        return _CATEGORY[category]
    return "unknown"


# --------------------------------------------------------------------------- #
# Familles d'appareils (regroupement des flottes)
# --------------------------------------------------------------------------- #
_FAMILY_CODES = [
    (r"^(A318|A319|A320|A321|A19N|A20N|A21N)$", "Airbus A320 family"),
    (r"^(BCS1|BCS3)$", "Airbus A220"),
    (r"^A3(30|32|33|37|38|39)$", "Airbus A330"),
    (r"^A3(40|42|43|45|46)$", "Airbus A340"),
    (r"^(A359|A35K)$", "Airbus A350"),
    (r"^A388$", "Airbus A380"),
    (r"^(A306|A30B|A310)$", "Airbus A300 / A310"),
    (r"^(B73[1-9]|B37M|B38M|B39M|B3XM)$", "Boeing 737"),
    (r"^B74[1-8RS]$", "Boeing 747"),
    (r"^B75[23]$", "Boeing 757"),
    (r"^B76[234]$", "Boeing 767"),
    (r"^(B77[2389LW]|B77F)$", "Boeing 777"),
    (r"^(B788|B789|B78X)$", "Boeing 787"),
    (r"^(E170|E175|E75L|E75S|E190|E195|E290|E295)$", "Embraer E-Jet"),
    (r"^(E135|E145|E35L)$", "Embraer ERJ"),
    (r"^AT[4-7]\d$", "ATR 42 / 72"),
    (r"^CRJ\d$", "Bombardier CRJ"),
    (r"^DH8[A-D]$", "De Havilland Dash 8"),
    (r"^(SU95)$", "Sukhoi Superjet"),
    (r"^(C919)$", "COMAC C919"),
]
_FAMILY_TEXT = [
    (r"\bA(318|319|320|321)\b|A32[01]neo|A319neo", "Airbus A320 family"),
    (r"\bA220\b|\bCS(100|300)\b|\bBD-500", "Airbus A220"),
    (r"\bA330\b", "Airbus A330"),
    (r"\bA340\b", "Airbus A340"),
    (r"\bA350\b", "Airbus A350"),
    (r"\bA380\b", "Airbus A380"),
    (r"\b(B?737|7M[89])\b", "Boeing 737"),
    (r"\bB?747\b", "Boeing 747"),
    (r"\bB?757\b", "Boeing 757"),
    (r"\bB?767\b", "Boeing 767"),
    (r"\bB?777\b", "Boeing 777"),
    (r"\bB?787\b", "Boeing 787"),
    (r"\b(ERJ[- ]?1[79]\d|E1[79]\d|E2\d\d|Embraer 1[79]\d)\b", "Embraer E-Jet"),
    (r"\bATR[- ]?(42|72)\b", "ATR 42 / 72"),
    (r"\bCRJ", "Bombardier CRJ"),
    (r"\b(Dash ?8|DHC-8|Q400)\b", "De Havilland Dash 8"),
]


def family(code: str | None, text: str | None = None) -> str | None:
    """Famille commerciale d'un appareil (« Boeing 777 ») d'après son code OACI ou son libellé libre."""
    c = (code or "").strip().upper()
    for pat, fam in _FAMILY_CODES:
        if c and re.match(pat, c):
            return fam
    s = f"{text or ''} {c}"
    # Normalise « A320-214 », « 777-328(ER) », « Boeing 787-9 »
    s2 = re.sub(r"(\d{3})-\w+", r"\1", s)
    for pat, fam in _FAMILY_TEXT:
        if re.search(pat, s2, re.I):
            return fam
    return None
