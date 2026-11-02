"""Remplit une instance Contrail avec des données de démonstration (images générées).

Usage :  python scripts/seed_demo.py [--url http://localhost:8000] [--password ...]
À utiliser sur une instance vide, pour découvrir l'interface. Les données créées
sont fictives et peuvent être supprimées ensuite (ou repartez d'un dossier data/ vide).
"""
from __future__ import annotations

import argparse
import io
import json
import random
from datetime import datetime, timedelta

import httpx
from PIL import Image, ImageDraw, ImageFont

FLEET = [
    ("F-HBXA", "Airbus A320-214", "A320", "Air France", "AFR", "LFBO"),
    ("F-HPJA", "Airbus A380-861", "A388", "Air France", "AFR", "LFPG"),
    ("F-GKXS", "Airbus A320-214", "A320", "Air France", "AFR", "LFBO"),
    ("EC-MXV", "Airbus A321-231", "A321", "Iberia", "IBE", "LEMD"),
    ("G-EUPT", "Airbus A319-131", "A319", "British Airways", "BAW", "EGLL"),
    ("D-AIZA", "Airbus A320-214", "A320", "Lufthansa", "DLH", "EDDF"),
    ("HB-JNA", "Boeing 777-3DE(ER)", "B77W", "Swiss", "SWR", "LSZH"),
    ("JA873A", "Boeing 787-9", "B789", "All Nippon Airways", "ANA", "RJTT"),
    ("N784AV", "Boeing 787-8", "B788", "Avianca", "AVA", "KMIA"),
    ("F-WWDD", "Airbus A350-1041", "A35K", "Airbus", None, "LFBO"),
    ("F-RARF", "Airbus A330-223", "A332", "Armée de l'Air et de l'Espace", "FAF", "LFBO"),
    ("EI-DVM", "Boeing 737-8AS", "B738", "Ryanair", "RYR", "LFBO"),
]
LIVERIES = {"F-GKXS": "SkyTeam", "EI-DVM": "Retro 1985", "D-AIZA": "Fanhansa 50 years"}
TAGS = ["Approche", "Décollage", "Nuit", "Filé", "Contre-jour"]


def image(reg: str, hue: int) -> bytes:
    w, h = 1600, 1067
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=(int(90 + 120 * t), int(140 + 80 * t), int(200 + 40 * (1 - t)) - hue % 40))
    # fuselage stylisé
    d.rounded_rectangle((260, 470, 1340, 610), radius=70, fill=(245, 247, 250))
    d.polygon([(1240, 470), (1380, 300), (1420, 300), (1340, 480)], fill=(30, 60, 140))
    d.polygon([(640, 560), (980, 560), (760, 760), (690, 760)], fill=(220, 224, 230))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 70)
    except OSError:
        font = ImageFont.load_default()
    d.text((900, 500), reg, fill=(20, 20, 30), font=font)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--password", default="")
    ap.add_argument("--count", type=int, default=28)
    a = ap.parse_args()
    c = httpx.Client(base_url=a.url, timeout=60)
    if a.password:
        c.post("/api/auth/login", json={"password": a.password}).raise_for_status()
    random.seed(42)
    now = datetime.now()
    for i in range(a.count):
        reg, model, typ, owner, icao, apt = random.choice(FLEET)
        when = now - timedelta(days=random.randint(0, 420), hours=random.randint(0, 12))
        data = {"registration": reg, "aircraft": model, "aircraft_icao": typ, "owner": owner, "airline_icao": icao,
                "airport": apt, "date": when.strftime("%Y-%m-%dT%H:%M"), "livery": LIVERIES.get(reg),
                "military": "Armée" in owner, "tags": random.sample(TAGS, k=random.randint(0, 2)),
                "favorite": random.random() < 0.15, "flight_type": "military" if "Armée" in owner else ("test" if reg.startswith("F-W") else "commercial")}
        files = {"image": (f"{reg}.jpg", image(reg, i * 13), "image/jpeg")} if random.random() < 0.9 else None
        r = c.post("/api/spots", params={"force": True}, data={"data": json.dumps(data)}, files=files)
        print(r.status_code, reg)
    for f in [("LFBO", "LFPG", "F-HBXA", "AF7781"), ("LFPG", "RJTT", "JA873A", "NH216"), ("LFBO", "LEMD", "EC-MXV", "IB8723")]:
        c.post("/api/flights", json={"date": (now - timedelta(days=random.randint(30, 300))).strftime("%Y-%m-%d"),
                                     "dep_icao": f[0], "arr_icao": f[1], "registration": f[2], "flight_number": f[3]})
    c.post("/api/locations", json={"name": "Parking P5 — seuil 32L", "lat": 43.6205, "lng": 1.3790, "airport": "LFBO",
                                   "runways": "14R/32L", "view_bearing": 300})
    c.post("/api/fleets/AFR/import", json={"text": "F-HBXA,A320\nF-GKXS,A320\nF-HPJA,A388\nF-HBXB,A320\nF-HEPA,A320", "name": "Air France"})
    print("Données de démonstration créées.")


if __name__ == "__main__":
    main()
