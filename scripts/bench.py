"""Banc d'essai de performance : fabrique une base de N spots fictifs (sans images) et chronomètre les routes principales.

Usage :  python scripts/bench.py [--n 10000] [--keep]
Travaille dans un dossier temporaire ; ne touche jamais à vos données.
"""
from __future__ import annotations

import argparse
import os
import random
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path


def build(n: int) -> None:
    from app.core import connect
    from app.db import init_db

    init_db()
    c = connect()
    rnd = random.Random(7)
    types = [("A320", "Airbus A320-214"), ("A321", "Airbus A321-231"), ("B738", "Boeing 737-800"), ("B789", "Boeing 787-9"),
             ("A359", "Airbus A350-941"), ("E190", "Embraer 190"), ("AT76", "ATR 72-600"), ("A388", "Airbus A380-861"),
             ("B77W", "Boeing 777-300ER"), ("C172", "Cessna 172"), ("H160", "Airbus H160"), ("A400", "Airbus A400M")]
    airlines = [("AFR", "Air France"), ("EZY", "easyJet"), ("RYR", "Ryanair"), ("DLH", "Lufthansa"), ("BAW", "British Airways"),
                ("KLM", "KLM"), ("IBE", "Iberia"), ("TVF", "Transavia France")]
    airports = ["LFBO", "LFPG", "LFPO", "LFPB", "LFML", "LFLL", "EGLL", "EHAM", "EDDF", "LEMD", "LFBD", "LFRS"]
    regs = [f"F-{a}{b}{c}{d}" for a in "GHJ" for b in "ABCDEFKLMNPRSTUVXZ" for c in "ABCDEFGHJKLMNPQRSTUVXYZ" for d in "ABCDEFGHJKLM"]
    rnd.shuffle(regs)
    regs = regs[: max(50, int(n * 0.55))]   # ~55 % d'immatriculations distinctes : beaucoup de « revus »
    tags = [(i, f"tag{i}") for i in range(1, 13)]
    c.executemany("INSERT OR IGNORE INTO tags (id_tag, name, color) VALUES (?, ?, '#888')", tags)
    t0 = datetime(2019, 1, 1)
    rows = []
    for i in range(n):
        ty = rnd.choice(types)
        al = rnd.choice(airlines)
        d = t0 + timedelta(minutes=rnd.randint(0, 60 * 24 * 365 * 7))
        ap = rnd.choice(airports)
        stamp = datetime.now().isoformat(timespec="seconds")
        rows.append((rnd.choice(regs), ty[1], ty[0], al[1], al[0], d.strftime("%Y-%m-%dT%H:%M"), ap, f"img{i}.webp", f"th{i}.webp",
                     "FR", rnd.random() < 0.05, rnd.choice([None, None, None, None, "Retro 1985", "Star Alliance"]), rnd.uniform(-20, 60), stamp, stamp))
    c.executemany("INSERT INTO spotting (registration, aircraft, aircraft_icao, owner, airline_icao, date, airport, image, thumb, country, "
                  "favorite, livery, sun_elevation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    ids = [r["id_spotting"] for r in c.execute("SELECT id_spotting FROM spotting")]
    c.executemany("INSERT OR IGNORE INTO spotting_tags (id_spotting, id_tag) VALUES (?, ?)",
                  [(i, rnd.randint(1, 12)) for i in ids if rnd.random() < 0.4])
    c.commit()
    c.close()


def timeit(client, label: str, path: str, **params) -> float:
    t = time.perf_counter()
    r = client.get(path, params=params)
    dt = (time.perf_counter() - t) * 1000
    print(f"{label:<44} {dt:8.0f} ms   HTTP {r.status_code}   {len(r.content) / 1024:7.0f} Ko")
    return dt


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10000)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="contrail-bench-")
    os.environ["CONTRAIL_DATA_DIR"] = tmp
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    t = time.perf_counter()
    build(a.n)
    print(f"{a.n} spots créés en {time.perf_counter() - t:.1f} s dans {tmp}\n")
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        timeit(c, "liste (page 1, 60)", "/api/spots")
        timeit(c, "liste (page 1, 60) — 2e appel", "/api/spots")
        timeit(c, "liste page profonde (offset 5000)", "/api/spots", offset=5000)
        timeit(c, "liste tri immatriculation", "/api/spots", sort="registration")
        timeit(c, "recherche « A320 »", "/api/spots", search="A320")
        timeit(c, "recherche « F-GA »", "/api/spots", search="F-GA")
        timeit(c, "filtre année", "/api/spots", year="2022")
        timeit(c, "filtre compagnie", "/api/spots", airline="AFR")
        timeit(c, "filtre étiquette", "/api/spots", tag=3)
        timeit(c, "carte (/map)", "/api/spots/map")
        timeit(c, "facettes", "/api/spots/facets")
        timeit(c, "statistiques (tout)", "/api/stats")
        timeit(c, "statistiques (année)", "/api/stats", year="2022")
        timeit(c, "tableau de bord", "/api/dashboard")
        timeit(c, "succès", "/api/achievements")
        timeit(c, "livrées", "/api/liveries")
        timeit(c, "un spot", "/api/spots/5000")
        timeit(c, "cellule (airframe)", "/api/airframe/F-GAAA")
        timeit(c, "export CSV", "/api/export/spots.csv")
        timeit(c, "sorties (1er appel : rattachement)", "/api/outings?limit=30")
        timeit(c, "sorties (liste)", "/api/outings?limit=30")
        timeit(c, "sortie (détail)", "/api/outings/1")
        timeit(c, "aéroports (liste)", "/api/airport-pages")
        timeit(c, "aéroport (fiche)", "/api/airport-pages/LFBO")
        timeit(c, "spots rares", "/api/spots?rare=1")
    if not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
