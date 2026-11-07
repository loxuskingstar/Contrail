#!/usr/bin/env python3
"""Contrôles statiques du front (sans navigateur) : icônes inexistantes, clés i18n manquantes, jeux de clés différents entre langues,
classes CSS de lignes de liste inconnues. Code de sortie 1 au moindre problème :  python3 scripts/lint_front.py"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = sorted((ROOT / "static" / "js").rglob("*.js"))
errors: list[str] = []

# --- icônes : icon('nom') doit exister dans lib/icons.js
icons_src = (ROOT / "static/js/lib/icons.js").read_text(encoding="utf-8")
known = set(re.findall(r'^"?([a-z0-9-]+)"?\s*:', icons_src, re.M)) | set(re.findall(r'"([a-z0-9-]+)":', icons_src))
for f in JS:
    for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        for m in re.finditer(r"""\bicon\('([a-z0-9-]+)'""", line):
            if m.group(1) not in known:
                errors.append(f"{f.relative_to(ROOT)}:{n}: icône inconnue « {m.group(1)} »")

# --- i18n : mêmes clés dans les 4 langues, et toute clé littérale t('…') utilisée existe
dicts = {l: json.loads((ROOT / f"static/i18n/{l}.json").read_text(encoding="utf-8")) for l in ("fr", "en", "es", "ja")}
base = set(dicts["fr"])
for l, d in dicts.items():
    for k in sorted(base - set(d)):
        errors.append(f"i18n/{l}.json : clé manquante « {k} »")
    for k in sorted(set(d) - base):
        errors.append(f"i18n/{l}.json : clé en trop « {k} »")
dyn_prefixes = tuple(sorted({m.group(1) for f in JS for m in re.finditer(r"""\bt\(`([a-z0-9_.]+)\$\{""", f.read_text(encoding="utf-8"))}))
for f in JS:
    for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        for m in re.finditer(r"""\bt\('([a-z0-9_]+\.[a-z0-9_.]+)'""", line):
            if m.group(1) not in base and not m.group(1).endswith(("_", ".")):     # préfixe d'une clé construite
                errors.append(f"{f.relative_to(ROOT)}:{n}: clé i18n absente « {m.group(1)} »")

# --- clés construites dynamiquement : widgets de l'accueil, entrées du menu, types de vol
def _list(src: str, name: str) -> list[str]:
    m = re.search(name + r"\s*=\s*\[(.*?)\]", src, re.S)
    return re.findall(r"'([a-z_]+)'", m.group(1)) if m else []


dash = (ROOT / "static/js/views/dashboard.js").read_text(encoding="utf-8")
for w in _list(dash, "export const WIDGETS"):
    if f"widget.{w}" not in base:
        errors.append(f"i18n : clé de widget absente « widget.{w} »")
app_js = (ROOT / "static/js/app.js").read_text(encoding="utf-8")
for k in re.findall(r"(?:key|group): '([a-z0-9_.]+)'", app_js):
    if k not in base:
        errors.append(f"i18n : clé de menu absente « {k} »")
form = (ROOT / "static/js/views/spot-form.js").read_text(encoding="utf-8")
for f in _list(form, "const FLIGHT_TYPES"):
    if f"ftype.{f}" not in base:
        errors.append(f"i18n : type de vol absent « ftype.{f} »")

# --- CSS : « row-item » n'existe pas (c'est .list-row)
for f in JS:
    for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        if "row-item" in line:
            errors.append(f"{f.relative_to(ROOT)}:{n}: classe CSS inconnue « row-item » (utiliser list-row)")

for e in errors:
    print(e)
print(f"{len(errors)} problème(s)" if errors else "front OK")
sys.exit(1 if errors else 0)
