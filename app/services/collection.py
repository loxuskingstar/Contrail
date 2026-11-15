"""Livrées spéciales, badges dynamiques et références croisées spots / vols."""
from __future__ import annotations

import re

from ..core import memo, q

# Avion d'essai pas encore peint (apprêt vert ou métal nu) : catégorie à part, jamais comptée comme livrée spéciale
PRIMER_RX = re.compile(r"\bprimers?\b|appr[eê]ts?\b|non\s?peint|pas\s?(encore\s?)?peint|unpainted|bare\s?metal|"
                       r"green\s?(aircraft|primer)|zinc\s?chromate|sin\s?pintar|imprimaci[oó]n|"
                       r"lackiert\s?nicht|grundierung|プライマー|未塗装|下地", re.I)

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


# Livrée entièrement blanche (avion livré « en blanc », white tail, avion de loueur) : à côté du primer, hors livrées spéciales
WHITE_RX = re.compile(r"^\s*(livr[ée]e\s+)?((full|all|toute|totalement|enti[èe]rement)[\s-]+)?"
                      r"(blanche?s?|white|wei(ss|ß)|blanc[ao]|白|ホワイト)(\s+(tail|livery|aircraft|queue|livr[ée]e))?\s*$|"
                      r"\b(white[\s-]?tail|queue\s+blanche|livr[ée]e\s+blanche|all[\s-]?white|full[\s-]?white)\b", re.I)
PLAIN = ("primer", "white")   # catégories « sans livrée » : comptées à part des livrées spéciales


def is_primer(livery: str | None) -> bool:
    return bool(livery and PRIMER_RX.search(livery))


def is_white(livery: str | None) -> bool:
    return bool(livery and not is_primer(livery) and WHITE_RX.search(livery))


def is_special_livery(livery: str | None) -> bool:
    if not livery or is_primer(livery) or is_white(livery):
        return False
    return livery.strip().lower() not in ("", "none", "standard", "classique", "classic livery", "normal", "-")


def _fold(s: str | None) -> str:
    import unicodedata
    s = "".join(c for c in unicodedata.normalize("NFKD", (s or "").lower()) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip()


def livery_key(livery: str | None, owner: str | None = None) -> str:
    """Identité d'une livrée : son texte chez un exploitant (« Star Alliance » d'Air Canada ≠ celle de Brussels Airlines,
    mais les avions d'une patrouille dans la même livrée anniversaire n'en font qu'une)."""
    return f"{_fold(livery)}|{_fold(owner)}"


def _load_cfg() -> dict:
    cats = q("SELECT code, keywords, disabled FROM livery_categories ORDER BY position, code")
    groups = {r["key"]: r["category"] for r in q("SELECT key, category FROM livery_groups WHERE category IS NOT NULL")}
    enabled = {c["code"] for c in cats if not c["disabled"]}
    kw = [(c["code"], [k for k in (_fold(x) for x in re.split(r"[,;\n]", c["keywords"] or "")) if k])
          for c in cats if not c["disabled"] and c["keywords"]]
    return {"enabled": enabled, "groups": {k: v for k, v in groups.items() if v in enabled}, "keywords": kw}


def livery_config() -> dict:
    try:
        return memo("livery_cfg", _load_cfg)
    except Exception:  # noqa: BLE001 — base pas encore migrée : règles d'origine
        return {"enabled": {c for c, _ in LIVERY_RULES} | {"special", *PLAIN}, "groups": {}, "keywords": []}


def livery_category(livery: str | None, owner: str | None = None, cfg: dict | None = None) -> str | None:
    """Ordre : rangement manuel de la livrée > primer / blanche > mots-clés des catégories > règles d'origine > « spéciale »."""
    if not livery or livery.strip().lower() in ("", "none", "standard", "classique", "classic livery", "normal", "-"):
        return None
    cfg = cfg or livery_config()
    manual = cfg["groups"].get(livery_key(livery, owner))
    if manual:
        return manual
    if is_primer(livery):
        return "primer"
    if is_white(livery):
        return "white"
    folded = _fold(livery)
    for code, words in cfg["keywords"]:
        if code not in PLAIN and any(w in folded for w in words):
            return code
    for cat, rx in LIVERY_RULES:
        if cat in cfg["enabled"] and rx.search(livery):
            return cat
    return "special"


# --------------------------------------------------------------------------- #
# Badges dynamiques
# --------------------------------------------------------------------------- #
RARITY_TIERS = ((25, "legendary"), (250, "epic"), (2000, "rare"), (10000, "uncommon"))   # appareils connus au monde pour ce type ; au-delà : « common »
RARE_TIERS = ("legendary", "epic", "rare")


def rarity_tier(n: int | None) -> str | None:
    if not n:
        return None
    for lim, name in RARITY_TIERS:
        if n <= lim:
            return name
    return "common"


def rare_types(tiers: tuple[str, ...] | None = None) -> list[str]:
    """Types présents dans la collection dont la rareté mondiale est connue (liste vide sans base de référence)."""
    from . import refdb
    tc = refdb.type_counts()
    if not tc:
        return []
    mine = {r["t"] for r in q("SELECT DISTINCT aircraft_icao t FROM spotting WHERE aircraft_icao IS NOT NULL")}
    tiers = tiers or RARE_TIERS
    return sorted(t for t in mine if rarity_tier(tc.get(t)) in tiers)


def badge_context() -> dict:
    """Agrégats nécessaires aux badges, mémorisés tant que les données ne changent pas (lecture seule : ne pas modifier)."""
    from . import refdb
    return memo("badge_context", _badge_context, refdb.REF_PATH.stat().st_mtime if refdb.available() else 0)


def _badge_context(_ref_mtime=0) -> dict:
    """Une seule passe, dans l'ordre chronologique : premier spot de chaque type / compagnie / aéroport, rang par immatriculation."""
    from . import operators

    ctx: dict = {"first_type": set(), "first_airline": set(), "first_airport": set(), "rank": {}, "patrol_rank": {}}
    occ_seen: dict[int, dict[str, int]] = {}      # patrouille → {passage (jour|lieu): rang}
    seen_t: set = set()
    seen_a: set = set()
    seen_p: set = set()
    counts: dict[str, int] = {}
    opg_cache: dict[tuple, str | None] = {}
    for r in q("SELECT id_spotting, registration, mk(aircraft_icao, aircraft, military) t, airline_icao, owner, airport, place, "
               "patrol_id, is_patrol, substr(COALESCE(date, created_at), 1, 10) day "
               "FROM spotting ORDER BY COALESCE(date, created_at), id_spotting"):
        sid = r["id_spotting"]
        if r["t"] and r["t"] not in seen_t:
            seen_t.add(r["t"]); ctx["first_type"].add(sid)
        k = (r["airline_icao"], r["owner"])
        if k not in opg_cache:
            opg_cache[k] = operators.group_key(*k)
        al = opg_cache[k]
        if al and al not in seen_a:
            seen_a.add(al); ctx["first_airline"].add(sid)
        if r["airport"] and r["airport"] not in seen_p:
            seen_p.add(r["airport"]); ctx["first_airport"].add(sid)
        n = counts[r["registration"]] = counts.get(r["registration"], 0) + 1
        ctx["rank"][sid] = n
        if r["patrol_id"]:
            # Rencontres d'une patrouille : un passage = un jour et un lieu, qu'il soit saisi en mode simple ou avion par avion
            seen = occ_seen.setdefault(r["patrol_id"], {})
            pr = seen.setdefault(f"{r['day']}|{r['airport'] or r['place'] or ''}", len(seen) + 1)
            ctx["patrol_rank"][sid] = pr
            if r["is_patrol"]:
                ctx["rank"][sid] = pr          # le « revu » d'une patrouille compte ses passages, pas seulement ses saisies simples
    ctx["reg_counts"] = counts
    from . import refdb
    ctx["type_counts"] = refdb.type_counts()
    top = max(counts.values(), default=0)
    ctx["most_spotted"] = {r for r, n in counts.items() if n == top and n >= 2}
    ctx["flown"] = {r["registration"] for r in q(
        "SELECT DISTINCT registration FROM flights WHERE registration IS NOT NULL AND registration <> ''")}
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
    prank = ctx.get("patrol_rank", {}).get(sid, 1)
    if prank > 1 and not spot.get("is_patrol"):
        b.append({"code": "patrol_seen", "n": prank})           # avion identifié : sa patrouille est revue
    if reg in ctx["most_spotted"]:
        b.append({"code": "most_spotted", "n": n})
    if is_primer(spot.get("livery")):
        b.append({"code": "primer"})
    elif is_white(spot.get("livery")):
        b.append({"code": "white"})
    elif is_special_livery(spot.get("livery")):
        b.append({"code": "special_livery", "cat": spot.get("livery_category") or "special"})
    if reg in ctx["flown"]:
        b.append({"code": "flown"})
    if spot.get("military"):
        b.append({"code": "military"})
    tn = ctx.get("type_counts", {}).get(spot.get("aircraft_icao"))
    tier = rarity_tier(tn)
    if tier:
        b.append({"code": "rarity", "tier": tier, "n": tn})
    el = spot.get("sun_elevation")
    if el is not None:
        if el < -12:                                    # nuit noire (au-delà du crépuscule astronomique)
            b.append({"code": "night"})
        elif el < -4:                                   # crépuscule civil avancé / nautique : ciel encore clair, soleil sous l'horizon
            hour = int(spot["date"][11:13]) if len(spot.get("date") or "") >= 13 else 18
            b.append({"code": "twilight", "phase": "dawn" if hour < 12 else "dusk"})
        elif el <= 8:
            b.append({"code": "golden_hour"})
    return b


def crossref_for_spot(reg: str) -> list[dict]:
    return q("SELECT id_flight, date, dep_icao, arr_icao, flight_number FROM flights WHERE registration = ? "
             "ORDER BY date", (reg,))


def crossref_for_flight(reg: str) -> list[dict]:
    return q("SELECT id_spotting, date, airport, thumb FROM spotting WHERE registration = ? ORDER BY date", (reg,))


def recategorize() -> int:
    """Recalcule la catégorie de livrée des spots dont elle a changé (règles, mots-clés ou rangement manuel modifiés)."""
    from ..core import db
    cfg = _load_cfg()
    changes = []
    for r in q("SELECT id_spotting id, livery, owner, livery_category cat FROM spotting"):
        new = livery_category(r["livery"], r["owner"], cfg)
        if new != r["cat"]:
            changes.append((new, r["id"]))
    if changes:
        conn = db()
        conn.executemany("UPDATE spotting SET livery_category = ? WHERE id_spotting = ?", changes)
        conn.commit()
    return len(changes)
