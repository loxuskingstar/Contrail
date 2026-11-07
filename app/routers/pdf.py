"""Exports PDF mis en page : bilan annuel, liste de spots (filtrable), fiche d'un spot, carnet de vols.

Le rendu suit le thème personnalisable (réglages « pdf_* » + paramètres de la requête, voir services/pdf.py).
"""
from __future__ import annotations

import io
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from PIL import Image as PILImage
from reportlab.lib.units import mm
from reportlab.platypus import Image, KeepTogether, Paragraph, Spacer

from ..core import get_settings, q
from ..services import airframes, geo
from ..services import pdf as pdfs
from ..services.pdf import Builder, Style, Tr, image_data, num
from . import flights as flights_router
from . import reports as reports_router
from . import spots as spots_router

router = APIRouter(prefix="/api/pdf", tags=["pdf"])

YEAR_SECTIONS = ("kpis", "months", "firsts", "top", "photos", "special")
SPOT_COLS = ("photo", "reg", "type", "owner", "livery", "date", "place", "tags", "rating", "notes", "msn")
DEFAULT_COLS = ("photo", "reg", "type", "owner", "date", "place")
MAX_ROWS = 3000
BOOL_FILTERS = ("special", "favorite", "has_photo", "has_audio", "unknown", "rare")
INT_FILTERS = ("military", "location_id", "patrol", "outing")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "export"


def _respond(data: bytes, name: str, inline: bool) -> Response:
    disp = "inline" if inline else "attachment"
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'{disp}; filename="{_slug(name)}.pdf"',
                                                                 "Cache-Control": "no-store"})


def _flag(v) -> bool:
    return str(v).lower() in ("1", "true", "yes", "on")


def _style(request: Request, force: dict | None = None) -> Style:
    over = dict(request.query_params)
    for k, v in (force or {}).items():
        over.setdefault(k, v)
    return Style.build(get_settings(), over)


def _place(r: dict) -> str:
    if r.get("airport"):
        a = geo.airport(r["airport"])
        return f"{a['name']} ({r['airport']})" if a else r["airport"]
    return r.get("place") or ""


def _hero(photo_id: int | None, B: Builder) -> None:
    if not photo_id or B.S.cover_style != "photo" or not B.S.cover:
        return
    row = q("SELECT image, thumb FROM spotting WHERE id_spotting = ?", (photo_id,))
    if row:
        pw, ph = B.S.pagesize
        size = (1700, int(1700 * (ph * 0.58) / pw))                  # exactement le cadre de la couverture
        B.hero = (image_data("images", row[0]["image"], size, shade=True)
                  or image_data("thumbs", row[0]["thumb"], (size[0] // 2, size[1] // 2), shade=True))


# --------------------------------------------------------------------------- #
# Bilan annuel
# --------------------------------------------------------------------------- #
@router.get("/year/{year}")
def pdf_year(year: int, request: Request, inline: bool = False, sections: str = ""):
    if not 1950 <= year <= 2200:
        raise HTTPException(422, "invalid_year")
    r = reports_router._build(str(year))
    S = _style(request)
    T = Tr(S.lang)
    want = [s for s in sections.split(",") if s in YEAR_SECTIONS] or list(YEAR_SECTIONS)
    tt, pv = r["totals"], r["previous"]
    B = Builder(S, T("report.title", y=year), T("report.sub", spots=tt["spots"], days=tt["days"]), T("pdf.year_kicker"))
    B.cover_stats = [(num(tt["spots"]), T("outing.k_spots")), (num(tt["types"]), T("report.k_types")),
                     (num(tt["airports"]), T("report.k_airports")), (num(tt["days"]), T("report.k_days"))]
    _hero(r["photos"][0]["id"] if r["photos"] else None, B)

    def delta(cur, prev):
        if not pv or prev is None:
            return "", False
        key = "report.vs_up" if cur > prev else "report.vs_down" if cur < prev else "report.vs_same"
        return T(key, n=abs(cur - prev), y=year - 1), cur > prev

    if "kpis" in want:
        d1, d2, d3 = delta(tt["spots"], pv and pv["spots"]), delta(tt["types"], pv and pv["types"]), delta(tt["airports"], pv and pv["airports"])
        B.add(B.kpis([
            (num(tt["spots"]), T("outing.k_spots"), *d1), (num(tt["types"]), T("report.k_types"), *d2),
            (num(tt["regs"]), T("report.k_regs")), (num(tt["airlines"]), T("report.k_airlines")),
            (num(tt["airports"]), T("report.k_airports"), *d3), (num(tt["countries"]), T("report.k_countries")),
            (num(tt["days"]), T("report.k_days")), (num(tt["favorites"] or 0), T("report.k_fav"))], cols=4 if B.W > 150 * mm else 2))
        B.space()
    if "months" in want:
        B.add(B.h1(T("report.by_month")), Spacer(1, 1 * mm), pdfs.BarChart([T.month(i) for i in range(12)], r["months"], B))
        bd = r["best_day"]
        if bd:
            B.add(Spacer(1, 1.5 * mm), B.para(T("report.best_day", date=T.date(bd["day"]), n=bd["n"], where=bd["airport"] or ""), "small"))
        B.space()
    if "firsts" in want:
        f = r["firsts"]

        def chip_block(title_key, items, fmt):
            labels = [fmt(x) for x in items[:18]]
            return [B.h2(T(title_key, n=len(items))), B.chips(labels, len(items) - len(labels))]

        blocks = [b for b, n in ((chip_block("report.first_types", f["types"], lambda x: x["label"] or x["k"]), len(f["types"])),
                                 (chip_block("report.first_airlines", f["airlines"], lambda x: x["label"] or x["k"]), len(f["airlines"])),
                                 (chip_block("report.first_airports", f["airports"], lambda x: x["k"]), len(f["airports"])),
                                 (chip_block("report.first_countries", f["countries"], lambda x: str(x["k"]).upper()), len(f["countries"]))) if n]
        if blocks:
            B.add(KeepTogether([B.h1(T("pdf.firsts")), Spacer(1, 1.5 * mm)]), B.columns(blocks))
    if "top" in want:
        tp = r["top"]
        rank = lambda items, lab, sub=lambda x: "": pdfs.RankList([(lab(x), sub(x), x["n"]) for x in items], B)    # noqa: E731
        B.add(KeepTogether([B.h1(T("pdf.rankings")), Spacer(1, 1.5 * mm)]), B.columns([
            [B.h2(T("report.top_types")), rank(tp["types"], lambda x: x["label"] or x["k"])],
            [B.h2(T("report.top_airlines")), rank(tp["airlines"], lambda x: x["label"] or x["k"])],
            [B.h2(T("report.top_airports")), rank(tp["airports"], lambda x: x["label"] or x["k"], lambda x: x["k"])],
            [B.h2(T("report.top_countries")), rank(tp["countries"], lambda x: str(x["k"]).upper())]]))
    if "photos" in want and S.photos and r["photos"]:
        B.add(KeepTogether([B.h1(T("report.best_photos")), Spacer(1, 2 * mm), B.photo_grid(
            [{"thumb": p["thumb"], "caption": p["registration"] + (" *" if p["favorite"] else ""),
              "sub": " · ".join(x for x in (p["aircraft"], p["airport"]) if x)} for p in r["photos"]], cols=3)]))
    if "special" in want and r["special"]:
        B.add(B.h1(T("report.special")), Spacer(1, 1.5 * mm),
              B.chips([f"{x['registration']} · {x['livery'] or x['aircraft'] or ''}" for x in r["special"]]))
    return _respond(B.render(), f"contrail-bilan-{year}", inline)


# --------------------------------------------------------------------------- #
# Liste de spots (avec les filtres de la page Spots)
# --------------------------------------------------------------------------- #
def _filters(request: Request) -> dict:
    f = {k: v for k, v in request.query_params.items()}
    for k in BOOL_FILTERS:
        f[k] = _flag(f.get(k))
    for k in INT_FILTERS:
        if f.get(k) in (None, ""):
            f.pop(k, None)
        else:
            try:
                f[k] = int(f[k])
            except ValueError:
                f.pop(k, None)
    return f


@router.get("/spots")
def pdf_spots(request: Request, inline: bool = False, cols: str = "", group: str = "none", sort: str = "date_desc",
              title: str = "", subtitle: str = ""):
    f = _filters(request)
    where, params = spots_router.build_filters(f)
    total = q(f"SELECT COUNT(*) n FROM spotting s WHERE {where}", params)[0]["n"]
    if not total:
        raise HTTPException(404, "no_data")
    rows = q(f"SELECT {spots_router.LIST_COLS} FROM spotting s WHERE {where} ORDER BY "
             f"{spots_router.SORTS.get(sort, spots_router.SORTS['date_desc'])} LIMIT {MAX_ROWS}", params)
    spots_router.attach_tags(rows)
    S = _style(request)
    T = Tr(S.lang)
    chosen = [c for c in cols.split(",") if c in SPOT_COLS] or list(DEFAULT_COLS)
    use_photos = S.photos and "photo" in chosen and len(rows) <= 1500
    if not use_photos and "photo" in chosen:
        chosen.remove("photo")
    dates = sorted(r["date"][:10] for r in rows if r["date"])
    period = f"{T.date(dates[0])} – {T.date(dates[-1])}" if dates and dates[0] != dates[-1] else (T.date(dates[0]) if dates else "")
    n_types = len({r["aircraft_icao"] or r["aircraft"] for r in rows if r["aircraft_icao"] or r["aircraft"]})
    n_air = len({r["owner"] for r in rows if r["owner"]})
    n_ap = len({r["airport"] for r in rows if r["airport"]})
    heading = title.strip()[:120] or T("pdf.spots_title")
    sub = (subtitle.strip()[:160] or " · ".join(x for x in (T("pdf.spots_sub", count=total, n=num(total)), period) if x))
    B = Builder(S, heading, sub, T("pdf.spots_kicker"))
    B.cover_stats = [(num(total), T("outing.k_spots")), (num(n_types), T("report.k_types")), (num(n_air), T("report.k_airlines")), (num(n_ap), T("report.k_airports"))]
    if S.cover and S.cover_style == "photo":
        best = next((r for r in sorted(rows, key=lambda r: (-(r["favorite"] or 0), -(r["rating"] or 0))) if r["thumb"]), None)
        _hero(best["id_spotting"] if best else None, B)
    B.add(B.kpis([(num(total), T("outing.k_spots")), (num(n_types), T("report.k_types")), (num(n_air), T("report.k_airlines")), (num(n_ap), T("report.k_airports"))]))
    B.space()
    if total > MAX_ROWS:
        B.add(B.para(T("pdf.truncated", n=MAX_ROWS), "small"), Spacer(1, 2 * mm))

    # colonnes : largeurs fixes en mm, le reste réparti selon des poids
    spec = {"photo": ("", 19, None), "reg": (T("pdf.col_reg"), 25, None), "date": (T("pdf.col_date"), 25, None), "rating": (T("pdf.col_rating"), 13, None),
            "msn": (T("pdf.col_msn"), 18, None), "type": (T("pdf.col_type"), 0, 1.15), "owner": (T("pdf.col_owner"), 0, 1.15),
            "livery": (T("pdf.col_livery"), 0, 1.0), "place": (T("pdf.col_place"), 0, 1.25), "tags": (T("pdf.col_tags"), 0, 1.0), "notes": (T("pdf.col_notes"), 0, 1.8)}
    fixed = sum(spec[c][1] for c in chosen) * mm
    weights = sum(spec[c][2] or 0 for c in chosen) or 1
    widths = [spec[c][1] * mm if spec[c][1] else (B.W - fixed) * spec[c][2] / weights for c in chosen]

    def cell(r: dict, c: str):
        if c == "photo":
            data = image_data("thumbs", r["thumb"], (171, 114), radius=0)
            return Image(data, width=17 * mm, height=11.3 * mm) if data else ""
        if c == "reg":
            return Paragraph(f"<b>{pdfs.clean(r['registration'], B.F)}</b>" + (" *" if r["favorite"] else ""), B.styles["cell"])
        if c == "type":
            return r["aircraft"] or r["aircraft_icao"] or ""
        if c == "owner":
            return r["owner"] or ""
        if c == "livery":
            return r["livery"] or ""
        if c == "date":
            return T.date(r["date"])
        if c == "place":
            return _place(r)
        if c == "tags":
            return ", ".join(t["name"] for t in r["tags"])
        if c == "rating":
            return ("*" * int(r["rating"])) if r["rating"] else ""
        if c == "msn":
            return r["msn"] or ""
        return (r["description"] or "")[:260]

    def block(items: list[dict]):
        return B.table([spec[c][0] for c in chosen], [[cell(r, c) for c in chosen] for r in items], widths)

    if group in ("day", "airport", "year"):
        keyf = {"day": lambda r: (r["date"] or "")[:10], "year": lambda r: (r["date"] or "")[:4], "airport": lambda r: _place(r) or "—"}[group]
        buckets: dict[str, list[dict]] = {}
        for r in rows:
            buckets.setdefault(keyf(r), []).append(r)
        for k, items in buckets.items():
            label = (T.date(k) if group == "day" and k else k) or "—"
            B.add(B.h1(f"{label}  ·  {len(items)}"), Spacer(1, 1.5 * mm), block(items), Spacer(1, B.gap))
    else:
        B.add(block(rows))
    return _respond(B.render(), f"contrail-spots-{_slug(heading)}", inline)


# --------------------------------------------------------------------------- #
# Fiche d'un spot
# --------------------------------------------------------------------------- #
@router.get("/spot/{spot_id}")
def pdf_spot(spot_id: int, request: Request, inline: bool = False):
    s = spots_router.get_spot(spot_id)
    S = _style(request, {"cover": "0"})
    T = Tr(S.lang)
    ap = s.get("airport_info")
    title = s["registration"]
    sub = " · ".join(x for x in (s.get("aircraft"), s.get("owner")) if x)
    B = Builder(S, title, sub, T("pdf.spot_kicker"))
    B.cover_stats = [(str(s.get("encounters") or 1), T("pdf.k_encounters")), (T.date(s.get("date")), T("pdf.col_date"))]
    if S.cover and S.cover_style == "photo":
        _hero(spot_id, B)
    if S.photos and s.get("image"):
        data = image_data("images", s["image"], (1900, 1300), radius=30, fit="contain") or image_data("thumbs", s.get("thumb"), (900, 650), radius=30, fit="contain")
        if data:
            with PILImage.open(io.BytesIO(data.getvalue())) as im:
                iw, ih = im.size
            k = min(B.W / iw, 112 * mm / ih)
            B.add(Image(data, width=iw * k, height=ih * k, hAlign="CENTER"), Spacer(1, B.gap))
    place = " · ".join(x for x in ((ap or {}).get("name"), s.get("airport"), s.get("place")) if x)
    cam = " · ".join(x for x in (s.get("camera"), s.get("lens")) if x)
    B.add(B.h1(T("pdf.details")), Spacer(1, 1 * mm), B.keyvals([
        (T("pdf.col_date"), T.date(s.get("date"), with_time=True)), (T("pdf.col_place"), place),
        (T("pdf.col_type"), " ".join(x for x in (s.get("aircraft"), f"({s['aircraft_icao']})" if s.get("aircraft_icao") else "") if x)),
        (T("pdf.col_owner"), s.get("owner") or ""), (T("pdf.col_livery"), s.get("livery") or ""), (T("pdf.col_msn"), s.get("msn") or ""),
        (T("pdf.f_camera"), cam), (T("pdf.col_rating"), ("*" * int(s["rating"])) if s.get("rating") else ""),
        (T("pdf.f_encounters"), str(s.get("encounters") or "")), (T("pdf.f_patrol"), s.get("patrol_name") or "")]))
    if s.get("tags"):
        B.add(Spacer(1, B.gap), B.chips([x["name"] for x in s["tags"]]))
    if s.get("description"):
        B.add(Spacer(1, B.gap), B.h1(T("pdf.notes")), Spacer(1, 1.5 * mm), Paragraph(pdfs.clean(s["description"], B.F).replace("\n", "<br/>"), B.styles["body"]))
    ids = airframes.group(s["registration"])
    others = q(f"SELECT id_spotting, date, airport, place, registration FROM spotting WHERE registration IN ({','.join('?' * len(ids))}) "
               f"AND id_spotting != ? ORDER BY date DESC LIMIT 25", ids + [spot_id])
    if others:
        w = [30 * mm, B.W - 30 * mm - 30 * mm, 30 * mm]
        B.add(Spacer(1, B.gap), B.h1(T("pdf.other_sightings")), Spacer(1, 1.5 * mm),
              B.table([T("pdf.col_date"), T("pdf.col_place"), T("pdf.col_reg")], [[T.date(o["date"]), _place(o), o["registration"]] for o in others], w))
    fl = s.get("flights") or []
    if fl:
        w = [30 * mm, B.W - 30 * mm - 40 * mm, 40 * mm]
        B.add(Spacer(1, B.gap), B.h1(T("pdf.flights_title")), Spacer(1, 1.5 * mm),
              B.table([T("pdf.col_date"), T("pdf.c_route"), T("pdf.c_flight")], [[T.date(x["date"]), f"{x['dep_icao']} > {x['arr_icao']}", x["flight_number"] or ""] for x in fl], w))
    return _respond(B.render(), f"contrail-spot-{s['registration']}", inline)


# --------------------------------------------------------------------------- #
# Carnet de vols
# --------------------------------------------------------------------------- #
@router.get("/flights")
def pdf_flights(request: Request, inline: bool = False, year: str = "", search: str = ""):
    data = flights_router.list_flights(year=year, search=search)
    items, sm = data["items"], data["summary"]
    if not items:
        raise HTTPException(404, "no_data")
    S = _style(request)
    T = Tr(S.lang)
    hours = f"{sm['minutes'] // 60:,}".replace(",", " ")
    title = T("pdf.flights_title") + (f" {year}" if year else "")
    B = Builder(S, title, T("pdf.flights_sub", count=sm["count"], n=num(sm["count"])), T("pdf.flights_kicker"))
    stats = [(num(sm["count"]), T("pdf.k_flights")), (f"{num(sm['km'])} km", T("pdf.k_km")), (f"{hours} h", T("pdf.k_hours")), (num(sm["airports"]), T("report.k_airports"))]
    B.cover_stats = stats
    B.add(B.kpis(stats))
    B.space()
    rest = B.W - (24 + 26 + 17 + 21) * mm
    widths = [24 * mm, 26 * mm, rest * 0.42, rest * 0.58, 17 * mm, 21 * mm]
    rows = []
    for x in items:
        dur = f"{x['duration_min'] // 60}h{x['duration_min'] % 60:02d}" if x.get("duration_min") else ""
        rows.append([T.date(x["date"]), x.get("flight_number") or "", f"{x['dep_icao']} > {x['arr_icao']}",
                     " · ".join(p for p in (x.get("aircraft"), x.get("registration")) if p) or (x.get("airline") or ""), dur,
                     f"{num(round(x['distance_km']))} km" if x.get("distance_km") else ""])
    B.add(B.table([T("pdf.col_date"), T("pdf.c_flight"), T("pdf.c_route"), T("pdf.c_aircraft"), T("pdf.c_duration"), T("pdf.c_distance")], rows, widths))
    return _respond(B.render(), f"contrail-vols{'-' + year if year else ''}", inline)
