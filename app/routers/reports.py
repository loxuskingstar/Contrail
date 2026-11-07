"""Rapports : bilan d'une année de spotting (chiffres, premières, classements, meilleures photos)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..core import memo, q, q1
from ..services import geo

router = APIRouter(prefix="/api/reports")

T = "mk(aircraft_icao, aircraft, military)"        # modèle compté
A = "opg(airline_icao, owner)"                      # compagnie regroupée


def _firsts(expr: str, year: str, label: str = "aircraft") -> list[dict]:
    """Éléments (modèles, compagnies, aéroports…) vus pour la première fois durant l'année, avec le spot de cette première fois."""
    return q(f"SELECT k, label, d, id FROM (SELECT {expr} k, {label} label, substr(date,1,10) d, id_spotting id, "
             f"ROW_NUMBER() OVER (PARTITION BY {expr} ORDER BY date, id_spotting) rn FROM spotting "
             f"WHERE date IS NOT NULL AND {expr} IS NOT NULL) WHERE rn = 1 AND substr(d,1,4) = ? ORDER BY d", (year,))


def _build(year: str) -> dict:
    yr = "substr(date,1,4) = ?"
    tot = q1(f"SELECT COUNT(*) spots, COUNT(DISTINCT CASE WHEN is_patrol = 0 THEN registration END) regs, COUNT(DISTINCT {T}) types, "
             f"COUNT(DISTINCT {A}) airlines, COUNT(DISTINCT airport) airports, COUNT(DISTINCT country) countries, "
             f"COUNT(DISTINCT substr(date,1,10)) days, SUM(military) military, SUM(image IS NOT NULL) photos, SUM(favorite) favorites "
             f"FROM spotting WHERE {yr}", (year,))
    if not tot or not tot["spots"]:
        raise HTTPException(404, "no_data")
    prev = q1(f"SELECT COUNT(*) spots, COUNT(DISTINCT {T}) types, COUNT(DISTINCT airport) airports FROM spotting WHERE substr(date,1,4) = ?",
              (str(int(year) - 1),))
    months = {r["m"]: r["n"] for r in q(f"SELECT substr(date,6,2) m, COUNT(*) n FROM spotting WHERE {yr} GROUP BY m", (year,))}

    def top(expr: str, label: str, where: str = "", n: int = 6):
        return q(f"SELECT {expr} k, {label} label, COUNT(*) n FROM spotting WHERE {yr} AND {expr} IS NOT NULL {where} "
                 f"GROUP BY k ORDER BY n DESC, k LIMIT {n}", (year,))

    airports = top("airport", "airport")
    for a in airports:
        info = geo.airport(a["k"])
        a["label"] = info["name"] if info else a["k"]
        a["country"] = info["country"] if info else None
    best_day = q1(f"SELECT substr(date,1,10) day, COUNT(*) n, MAX(airport) airport FROM spotting WHERE {yr} GROUP BY day ORDER BY n DESC, day LIMIT 1", (year,))
    photos = q(f"SELECT id_spotting id, registration, aircraft, thumb, rating, favorite, airport, substr(date,1,10) day FROM spotting "
               f"WHERE {yr} AND thumb IS NOT NULL ORDER BY favorite DESC, COALESCE(rating,0) DESC, date DESC LIMIT 6", (year,))
    special = q(f"SELECT id_spotting id, registration, aircraft, livery, thumb FROM spotting WHERE {yr} AND is_patrol = 0 AND livery_category "
                f"NOT IN ('primer','white') AND livery_category IS NOT NULL ORDER BY date DESC LIMIT 6", (year,))
    patrols = q1(f"SELECT COUNT(DISTINCT patrol_id) n FROM spotting WHERE {yr} AND patrol_id IS NOT NULL", (year,))
    return {
        "year": int(year), "totals": tot, "previous": prev, "months": [months.get(f"{m:02d}", 0) for m in range(1, 13)],
        "firsts": {
            "types": _firsts(T, year),
            "airlines": _firsts(A, year, label="owner"),
            "airports": _firsts("airport", year, "airport"),
            "countries": _firsts("country", year, "country"),
        },
        "top": {"types": top(T, "MAX(aircraft)"), "airlines": top(A, "MAX(owner)"), "airports": airports,
                "countries": top("country", "country")},
        "best_day": best_day, "photos": photos, "special": special, "patrols": (patrols or {}).get("n", 0),
    }


@router.get("/years")
def years():
    return {"years": [r["y"] for r in q("SELECT DISTINCT substr(date,1,4) y FROM spotting WHERE date IS NOT NULL ORDER BY y DESC")]}


@router.get("/year/{year}")
def year_report(year: int):
    if not 1950 <= year <= 2200:
        raise HTTPException(422, "invalid_year")
    return memo(f"report-{year}", lambda: _build(str(year)))
