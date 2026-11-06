"""Immatriculations : normalisation, pays d'immatriculation, extraction dans un texte OCR."""
from __future__ import annotations

import re

# Préfixes de nationalité OACI -> code pays ISO-3166 alpha-2.
PREFIXES: dict[str, str] = {
    "YA": "AF", "ZA": "AL", "7T": "DZ", "C3": "AD", "D2": "AO", "VP-A": "AI", "V2": "AG",
    "LV": "AR", "LQ": "AR", "EK": "AM", "P4": "AW", "VH": "AU", "OE": "AT", "4K": "AZ",
    "C6": "BS", "A9C": "BH", "S2": "BD", "8P": "BB", "EW": "BY", "OO": "BE", "V3": "BZ",
    "TY": "BJ", "VP-B": "BM", "VQ-B": "BM", "VR-B": "BM", "A5": "BT", "CP": "BO", "E7": "BA",
    "A2": "BW", "PP": "BR", "PR": "BR", "PS": "BR", "PT": "BR", "PU": "BR", "V8": "BN",
    "LZ": "BG", "XT": "BF", "9U": "BI", "XU": "KH", "TJ": "CM", "C": "CA", "CF": "CA",
    "CG": "CA", "D4": "CV", "VP-C": "KY", "TL": "CF", "TT": "TD", "CC": "CL", "B": "CN",
    "HK": "CO", "D6": "KM", "TN": "CG", "E5": "CK", "TI": "CR", "9A": "HR", "CU": "CU",
    "5B": "CY", "OK": "CZ", "9Q": "CD", "OY": "DK", "J2": "DJ", "J7": "DM", "HI": "DO",
    "HC": "EC", "SU": "EG", "YS": "SV", "3C": "GQ", "E3": "ER", "ES": "EE", "ET": "ET",
    "DQ": "FJ", "OH": "FI", "F": "FR", "TR": "GA", "C5": "GM", "4L": "GE", "D": "DE",
    "9G": "GH", "SX": "GR", "J3": "GD", "TG": "GT", "3X": "GN", "J5": "GW", "8R": "GY",
    "HH": "HT", "HR": "HN", "HA": "HU", "TF": "IS", "VT": "IN", "PK": "ID", "EP": "IR",
    "YI": "IQ", "EI": "IE", "EJ": "IE", "4X": "IL", "I": "IT", "TU": "CI", "6Y": "JM",
    "JA": "JP", "JY": "JO", "UP": "KZ", "5Y": "KE", "T3": "KI", "P": "KP", "HL": "KR",
    "Z6": "XK", "9K": "KW", "EX": "KG", "RDPL": "LA", "YL": "LV", "OD": "LB", "7P": "LS",
    "A8": "LR", "5A": "LY", "HB": "CH", "LY": "LT", "LX": "LU", "Z3": "MK", "5R": "MG",
    "7Q": "MW", "9M": "MY", "8Q": "MV", "TZ": "ML", "9H": "MT", "V7": "MH", "5T": "MR",
    "3B": "MU", "XA": "MX", "XB": "MX", "XC": "MX", "V6": "FM", "ER": "MD", "3A": "MC",
    "JU": "MN", "4O": "ME", "CN": "MA", "C9": "MZ", "XY": "MM", "XZ": "MM", "V5": "NA",
    "C2": "NR", "9N": "NP", "PH": "NL", "PJ": "CW", "ZK": "NZ", "ZL": "NZ", "ZM": "NZ",
    "YN": "NI", "5U": "NE", "5N": "NG", "LN": "NO", "A4O": "OM", "AP": "PK", "T8A": "PW",
    "E4": "PS", "HP": "PA", "P2": "PG", "ZP": "PY", "OB": "PE", "RP": "PH", "SP": "PL",
    "SN": "PL", "CS": "PT", "CR": "PT", "A7": "QA", "YR": "RO", "RA": "RU", "RF": "RU",
    "9XR": "RW", "V4": "KN", "J6": "LC", "J8": "VC", "5W": "WS", "T7": "SM", "S9": "ST",
    "HZ": "SA", "6V": "SN", "6W": "SN", "YU": "RS", "S7": "SC", "9L": "SL", "9V": "SG",
    "OM": "SK", "S5": "SI", "H4": "SB", "6O": "SO", "ZS": "ZA", "ZT": "ZA", "ZU": "ZA",
    "Z8": "SS", "EC": "ES", "EM": "ES", "4R": "LK", "ST": "SD", "PZ": "SR", "3D": "SZ",
    "SE": "SE", "YK": "SY", "EY": "TJ", "5H": "TZ", "HS": "TH", "4W": "TL", "5V": "TG",
    "A3": "TO", "9Y": "TT", "TS": "TN", "TC": "TR", "EZ": "TM", "T2": "TV", "5X": "UG",
    "UR": "UA", "A6": "AE", "G": "GB", "M": "IM", "2": "GG", "ZJ": "JE", "N": "US",
    "CX": "UY", "UK": "UZ", "YJ": "VU", "YV": "VE", "VN": "VN", "7O": "YE", "9J": "ZM",
    "Z": "ZW", "VP-L": "VG", "VQ-T": "TC", "VP-F": "FK", "VP-G": "GI", "VP-M": "MS",
    "VQ-H": "SH", "T9": "BA", "9S": "CD",
}

# Pays où l'immatriculation s'écrit sans tiret (préfixe collé).
NO_HYPHEN = ("N", "JA", "HL", "UK", "RDPL")

_HYPHEN_KEYS = sorted((k for k in PREFIXES if "-" in k), key=len, reverse=True)
_PLAIN_KEYS = sorted((k for k in PREFIXES if "-" not in k), key=len, reverse=True)


def normalize(reg: str | None) -> str:
    if not reg:
        return ""
    r = re.sub(r"[\s_]+", "", reg.strip().upper())
    r = r.replace("–", "-").replace("—", "-")
    return r


# Spot sans immatriculation lisible : une immatriculation de substitution unique, jamais comptée comme un avion identifié
UNKNOWN_PREFIX = "SANS-IMMAT-"


def new_unknown() -> str:
    import secrets
    return UNKNOWN_PREFIX + secrets.token_hex(3).upper()


def is_unknown(reg: str | None) -> bool:
    return bool(reg) and reg.upper().startswith(UNKNOWN_PREFIX)


def known(reg: str | None) -> str | None:
    """NULL pour une immatriculation de substitution (fonction SQL `known`, utilisée dans les COUNT(DISTINCT …))."""
    return None if is_unknown(reg) else reg


def country_of(reg: str | None) -> str | None:
    r = normalize(reg)
    if not r or is_unknown(r):
        return None
    # Cas particuliers de la Chine / Hong Kong / Macao / Taïwan (préfixe B).
    if r.startswith("B-"):
        rest = r[2:]
        if rest[:1] in ("H", "K", "L"):
            return "HK"
        if rest[:1] == "M":
            return "MO"
        if re.fullmatch(r"\d{5}", rest):
            return "TW"
        return "CN"
    if "-" in r:
        for k in _HYPHEN_KEYS:
            if r.startswith(k):
                return PREFIXES[k]
        head = r.split("-", 1)[0]
        return PREFIXES.get(head)
    for k in NO_HYPHEN:
        if r.startswith(k):
            if k == "N" and not re.fullmatch(r"N[1-9]\d{0,4}[A-Z]{0,2}", r):
                continue
            return PREFIXES[k]
    return None


def is_plausible(reg: str) -> bool:
    r = normalize(reg)
    if not 3 <= len(r) <= 10:
        return False
    return country_of(r) is not None


# --------------------------------------------------------------------------- #
# Extraction depuis un texte brut (OCR)
# --------------------------------------------------------------------------- #
_RE_HYPHEN = re.compile(r"(?<![A-Z0-9])([A-Z0-9]{1,4}-[A-Z0-9]{2,5})(?![A-Z0-9])")
_RE_US = re.compile(r"(?<![A-Z0-9])(N[1-9][0-9]{0,4}[A-Z]{0,2})(?![A-Z0-9])")
_RE_JA = re.compile(r"(?<![A-Z0-9])(JA[0-9]{2,4}[A-Z]{0,2})(?![A-Z0-9])")
_RE_HL = re.compile(r"(?<![A-Z0-9])(HL[0-9]{4})(?![A-Z0-9])")
_RE_FUSED = re.compile(r"(?<![A-Z0-9])([A-Z][A-Z0-9]{4,6})(?![A-Z0-9])")


def extract_candidates(text: str) -> list[dict]:
    """Retourne les immatriculations plausibles trouvées dans un texte, triées par score."""
    t = text.upper().replace("—", "-").replace("–", "-").replace("_", "-")
    t = re.sub(r"[|!]", "I", t)
    found: dict[str, float] = {}

    def add(reg: str, score: float) -> None:
        reg = normalize(reg)
        if is_plausible(reg):
            found[reg] = max(found.get(reg, 0), score)

    for m in _RE_HYPHEN.finditer(t):
        cand = m.group(1)
        head, tail = cand.split("-", 1)
        # Les lettres O/0 et I/1 sont souvent confondues après le tiret.
        if tail.isalpha() or head in ("B", "VP", "VQ", "HB", "D", "F", "G", "EC", "I", "OO", "PH"):
            add(cand, 1.0)
        else:
            add(cand, 0.8)
            add(head + "-" + tail.replace("0", "O").replace("1", "I"), 0.7)
    for rx, score in ((_RE_US, 0.75), (_RE_JA, 0.9), (_RE_HL, 0.9)):
        for m in rx.finditer(t):
            add(m.group(1), score)
    # Immatriculations "collées" (tiret non lu) : F HBXA -> F-HBXA
    for m in _RE_FUSED.finditer(t.replace(" ", "")):
        s = m.group(1)
        for plen in (1, 2):
            head, tail = s[:plen], s[plen:]
            if head in PREFIXES and head not in NO_HYPHEN and tail.isalpha() and 3 <= len(tail) <= 5:
                add(f"{head}-{tail}", 0.45)
    return [{"registration": r, "score": round(s, 2), "country": country_of(r)}
            for r, s in sorted(found.items(), key=lambda kv: -kv[1])][:6]


MILITARY_HINTS = re.compile(
    r"air force|armée|armee|navy|army|luftwaffe|marine nationale|força aérea|forca aerea|"
    r"ejército|ejercito|fuerza aérea|fuerza aerea|aeronautica militare|usaf|raf\b|"
    r"royal air force|military|militaire|defen[cs]e|aéronavale|gendarmerie|coast guard|"
    r"bundeswehr|nato|otan|esercito|marina militare",
    re.I,
)


def looks_military(*values: str | None) -> bool:
    return any(v and MILITARY_HINTS.search(v) for v in values)


# --------------------------------------------------------------------------- #
# Pays déduit de l'exploitant, pour les « immatriculations » qui n'en sont pas (numéros de série militaires : QA400, 31+05…)
# --------------------------------------------------------------------------- #
_ALIASES = {
    # forces armées et services d'État sans nom de pays dans leur intitulé
    "FR": ("armee de l'air", "armee de l air", "marine nationale", "aeronavale", "gendarmerie nationale", "securite civile", "alat", "french", "francais"),
    "DE": ("luftwaffe", "bundeswehr", "marineflieger", "german", "allemand", "deutsche"),
    "GB": ("royal air force", "royal navy", "fleet air arm", "army air corps", "british", "britannique"),
    "US": ("usaf", "us air force", "us navy", "us army", "usmc", "united states", "american", "americain", "uscg"),
    "IT": ("aeronautica militare", "esercito", "marina militare", "guardia di finanza", "italian", "italien"),
    "ES": ("ejercito del aire", "fuerza aerea espanola", "armada espanola", "spanish", "espagnol", "guardia civil"),
    "PT": ("forca aerea portuguesa", "portuguese", "portugais"),
    "NL": ("koninklijke luchtmacht", "dutch", "neerlandais", "royal netherlands"),
    "BE": ("belgian", "belge", "composante air"),
    "CH": ("swiss", "suisse", "schweizer luftwaffe"),
    "CA": ("rcaf", "canadian", "canadien", "forces canadiennes"),
    "PL": ("polish", "polonais"), "GR": ("hellenic", "greek", "grec"), "TR": ("turkish", "turc"),
    "RU": ("russian", "russe", "voenno"), "CN": ("chinese", "chinois", "plaaf"), "JP": ("japanese", "japonais", "jasdf", "jmsdf"),
    "IN": ("indian", "indien"), "BR": ("brazilian", "bresilien"), "AU": ("australian", "australien", "raaf"),
    "SA": ("saudi", "saoudien"), "AE": ("emirates air force", "emirati"), "QA": ("qatari",), "EG": ("egyptian", "egyptien"),
    "MA": ("moroccan", "marocain"), "SE": ("swedish", "suedois"), "NO": ("norwegian", "norvegien"), "DK": ("danish", "danois"),
    "FI": ("finnish", "finlandais"), "AT": ("austrian", "autrichien"), "CZ": ("czech", "tcheque"), "RO": ("romanian", "roumain"),
    "HU": ("hungarian", "hongrois"), "IE": ("irish", "irlandais"), "UA": ("ukrainian", "ukrainien"), "IL": ("israeli", "israelien"),
    "KR": ("korean", "coreen", "rokaf"), "SG": ("singaporean", "singapourien", "rsaf"), "TH": ("thai", "thailandais"),
}


def _fold(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


_NAMES: list[tuple[re.Pattern, str]] | None = None


def _name_patterns() -> list[tuple[re.Pattern, str]]:
    global _NAMES
    if _NAMES is None:
        import json
        from pathlib import Path
        pairs: dict[str, str] = {}
        f = Path(__file__).resolve().parents[2] / "static" / "data" / "country_names.json"
        if f.is_file():
            pairs.update(json.loads(f.read_text(encoding="utf-8")))
        for code, words in _ALIASES.items():
            pairs.update({w: code for w in words})
        # le plus long d'abord : « equatorial guinea » avant « guinea », « south africa » avant « africa »
        _NAMES = [(re.compile(rf"(?<![a-z]){re.escape(k)}(?![a-z])"), v) for k, v in sorted(pairs.items(), key=lambda kv: -len(kv[0]))]
    return _NAMES


def country_from_operator(owner: str | None) -> str | None:
    """Pays d'après l'exploitant (« Qatar Emiri Air Force » → QA, « Armée de l'Air » → FR) ; None si rien de reconnu."""
    if not owner or len(owner.strip()) < 3:
        return None
    text = _fold(owner)
    for pat, code in _name_patterns():
        if pat.search(text):
            return code
    return None


def country_for(reg: str | None, owner: str | None = None) -> str | None:
    """Pays d'immatriculation, à défaut celui de l'exploitant (avions militaires, numéros de série)."""
    return country_of(reg) or (country_from_operator(owner) if not is_unknown(reg) else None)
