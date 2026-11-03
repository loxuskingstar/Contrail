"""Tests de fumée de l'API (hors-ligne : aucun appel externe).

Lancer :  CONTRAIL_OFFLINE=1 pytest -q
"""
from __future__ import annotations

import io
import json
import os
import tempfile

import pytest

os.environ["CONTRAIL_DATA_DIR"] = tempfile.mkdtemp(prefix="contrail-test-")
os.environ["CONTRAIL_OFFLINE"] = "1"
os.environ["CONTRAIL_DISABLE_SCHEDULER"] = "1"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402
from app.services import geo, registration, weather  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def jpeg_bytes(color=(40, 120, 200)) -> bytes:
    img = Image.new("RGB", (1200, 800), color)
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


def test_registration_country():
    assert registration.country_of("F-HBXA") == "FR"
    assert registration.country_of("n123ab") == "US"
    assert registration.country_of("B-HNR") == "HK"
    assert registration.country_of("B-18901") == "TW"
    assert registration.country_of("VP-BKQ") == "BM"
    assert registration.country_of("JA873A") == "JP"
    assert registration.country_of("HB-JNA") == "CH"


def test_ocr_candidate_extraction():
    c = registration.extract_candidates("AIR FRANCE\nF-HBXA  A320\nFHPND")
    regs = [x["registration"] for x in c]
    assert regs[0] == "F-HBXA"
    assert "F-HPND" in regs


def test_metar_decoder():
    d = weather.decode_metar("METAR LFBO 021430Z 29012G25KT 9999 -RA FEW020 BKN045 12/08 Q1015 NOSIG")
    assert d["wind_dir"] == 290 and d["wind_kt"] == 12 and d["gust_kt"] == 25
    assert d["visibility_m"] == 9999 and d["temp_c"] == 12 and d["qnh_hpa"] == 1015
    assert d["clouds"][1] == {"cover": "BKN", "ft": 4500, "type": None}
    assert d["category"] == "VFR" and d["summary"] == "rain"


def test_sun_position_sanity():
    from datetime import datetime, timezone
    az, el = geo.sun_position(43.6, 1.44, datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc))
    assert 60 < el < 72 and 150 < az < 210


def test_spot_crud_duplicates_crossref(client):
    r = client.post("/api/flights", json={"date": "2026-05-01", "dep_icao": "LFBO", "arr_icao": "LFPG",
                                          "registration": "F-HBXA", "dep_time": "07:00", "arr_time": "08:20"})
    assert r.status_code == 200, r.text
    f = r.json()["flight"]
    assert f["distance_km"] > 500 and f["duration_min"] == 80

    data = {"registration": "f-hbxa", "aircraft": "Airbus A320-214", "aircraft_icao": "a320", "owner": "Air France",
            "airport": "TLS", "date": "2026-11-01T15:30", "livery": "SkyTeam", "tags": ["Approche", "Nuit"]}
    r = client.post("/api/spots", data={"data": json.dumps(data)},
                    files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 200, r.text
    body = r.json()
    s = body["spot"]
    assert s["registration"] == "F-HBXA" and s["airport"] == "LFBO" and s["country"] == "FR"
    assert s["livery_category"] == "alliance" and s["thumb"] and s["image"].endswith(".webp")
    assert body["crossref"], "le vol précédent sur F-HBXA doit être détecté"
    codes = {b["code"] for b in s["badges"]}
    assert {"first_type", "special_livery", "flown"} <= codes
    assert len(s["tags"]) == 2
    assert "spots_1" in body["achievements"] and "photos_1" in body["achievements"]

    r = client.post("/api/spots", data={"data": json.dumps(data)})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate"
    r = client.post("/api/spots?force=true", data={"data": json.dumps(data)})
    assert r.status_code == 200
    sid2 = r.json()["spot"]["id_spotting"]
    assert any(b["code"] == "seen_again" for b in r.json()["spot"]["badges"])

    media = client.get(f"/media/thumbs/{s['thumb']}")
    assert media.status_code == 200
    assert client.get("/media/thumbs/../contrail.db").status_code == 404

    r = client.put(f"/api/spots/{s['id_spotting']}", data={"data": json.dumps({"description": "Belle lumière"})})
    assert r.json()["spot"]["description"] == "Belle lumière"
    assert client.delete(f"/api/spots/{sid2}").status_code == 200

    lst = client.get("/api/spots", params={"tag": s["tags"][0]["id_tag"]}).json()
    assert lst["total"] == 1
    assert client.get("/api/spots/map").json()["places"][0]["count"] == 1


def test_offline_draft_idempotence(client):
    payload = {"registration": "D-AIZA", "airport": "EDDF", "date": "2026-10-10T10:00", "draft_uuid": "abc-123"}
    a = client.post("/api/spots", data={"data": json.dumps(payload)}).json()
    b = client.post("/api/spots", data={"data": json.dumps(payload)}).json()
    assert a["spot"]["id_spotting"] == b["spot"]["id_spotting"] and b["already_synced"]


def test_stats_dashboard_airframe(client):
    st = client.get("/api/stats").json()
    assert st["totals"]["spots"] >= 2
    assert client.get("/api/dashboard").status_code == 200
    af = client.get("/api/airframe/F-HBXA").json()
    assert af["spots"] == 1 and af["flights"] == 1 and len(af["events"]) == 2
    assert client.get("/api/stats/flights").json()["count"] == 1
    assert client.get("/api/liveries").json()[0]["category"] == "alliance"


def test_fleet_manual_import(client):
    r = client.post("/api/fleets/AFR/import", json={"text": "F-HBXA,A320\nF-HBXB,A320\nF-GKXA,A320", "name": "Air France"})
    assert r.status_code == 200
    ov = {f["key"]: f for f in client.get("/api/fleets").json()}
    assert ov["AFR"]["fleet_size"] == 3 and ov["AFR"]["fleet_seen"] == 1


def test_locations_and_sun(client):
    r = client.post("/api/locations", json={"name": "Parking P5", "lat": 43.64, "lng": 1.37, "airport": "LFBO",
                                            "view_bearing": 320})
    assert r.status_code == 200 and r.json()["best_time"]
    sun = client.get("/api/sun", params={"lat": 43.64, "lng": 1.37, "bearing": 320, "date": "2026-06-21"}).json()
    assert sun["sunrise"] and sun["windows"]


def test_share_public(client):
    tok = client.post("/api/shares", json={"kind": "gallery", "target": "airport:LFBO", "title": "Toulouse"}).json()["token"]
    pub = client.get(f"/api/public/{tok}").json()
    assert pub["stats"]["spots"] >= 1 and "description" not in pub["spots"][0]
    sid = pub["spots"][0]["id_spotting"]
    assert client.get(f"/api/public/{tok}/media/thumb/{sid}").status_code == 200
    client.delete(f"/api/shares/{tok}")
    assert client.get(f"/api/public/{tok}").status_code == 404


def test_csv_import_and_export(client):
    csv_data = ("Registration;Aircraft;Airline;Location;Date;Notes\n"
                "EC-MXV;A321;Iberia;Madrid (LEMD);03/02/2025;rotation\n"
                "G-EUPT;A319;British Airways;LHR;04/02/2025 14:05;\n").encode()
    prev = client.post("/api/import/preview", files={"file": ("x.csv", csv_data, "text/csv")}, data={"kind": "spots"}).json()
    assert prev["mapping"]["registration"] == "Registration" and prev["mapping"]["airport"] == "Location"
    res = client.post("/api/import/commit", data={"token": prev["token"], "kind": "spots",
                                                  "mapping": json.dumps(prev["mapping"])}).json()
    assert res["imported"] == 2, res
    sp = client.get("/api/spots", params={"registration": "EC-MXV"}).json()["items"][0]
    assert sp["airport"] == "LEMD" and sp["date"].startswith("2025-02-03")

    fr24 = ("Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,"
            "Seat type,Flight class,Flight reason,Note\n"
            "2024-07-14,AF7781,Toulouse / Blagnac (TLS/LFBO),Paris / Orly (ORY/LFPO),09:10:00,10:25:00,01:15:00,"
            "Air France (AF/AFR),Airbus A318 (A318),F-GUGJ,12A,1,1,1,\n").encode()
    prev = client.post("/api/import/preview", files={"file": ("f.csv", fr24, "text/csv")}, data={"kind": "flights"}).json()
    res = client.post("/api/import/commit", data={"token": prev["token"], "kind": "flights",
                                                  "mapping": json.dumps(prev["mapping"])}).json()
    assert res["imported"] == 1, res
    fl = [f for f in client.get("/api/flights").json()["items"] if f["flight_number"] == "AF7781"][0]
    assert fl["airline_icao"] == "AFR" and fl["seat_type"] == "window" and fl["duration_min"] == 75

    assert client.get("/api/export/spots.csv").status_code == 200
    assert "tables" in client.get("/api/export/full.json").json()


def test_backup_roundtrip(client):
    b = client.post("/api/backups").json()
    assert b["name"].endswith(".zip")
    z = client.get(f"/api/backups/{b['name']}")
    assert z.status_code == 200
    before = client.get("/api/stats").json()["totals"]["spots"]
    r = client.post("/api/backups/restore", files={"file": ("b.zip", z.content, "application/zip")})
    assert r.status_code == 200, r.text
    assert client.get("/api/stats").json()["totals"]["spots"] == before


def test_settings_and_achievements(client):
    s = client.put("/api/settings", json={"theme": "dark", "modules": {"radar": False}}).json()
    assert s["theme"] == "dark" and s["modules"]["radar"] is False and s["modules"]["flights"] is True
    ach = client.get("/api/achievements").json()
    assert ach["unlocked"] >= 2
    assert client.get("/api/search", params={"q": "HBXA"}).json()["airframes"]


def test_test_session_is_isolated(client):
    before = client.get("/api/stats").json()["totals"]["spots"]
    r = client.post("/api/session", json={"profile": "test"})
    assert r.status_code == 200 and client.cookies.get("contrail_profile") == "test"
    assert client.get("/api/session").json()["profile"] == "test"
    st = client.get("/api/stats").json()
    assert st["totals"]["spots"] == 62 and st["totals"]["photos"] == 0
    assert client.get("/api/stats/flights").json()["count"] == 14
    assert len(client.get("/api/locations").json()) == 3
    sp = client.get("/api/spots", params={"limit": 200}).json()["items"]
    with_wx = [s for s in sp if True]
    detail = client.get(f"/api/spots/{with_wx[0]['id_spotting']}").json()
    assert detail["image"] is None
    assert any(f["fleet_size"] for f in client.get("/api/fleets").json())
    assert client.get("/api/achievements").json()["unlocked"] > 3
    gear = st["gear"]
    assert gear and gear[0]["camera"]
    # une écriture en session de test ne touche pas les données réelles
    client.post("/api/spots", params={"force": True}, data={"data": json.dumps({"registration": "F-TEST", "airport": "LFBO"})})
    tok = client.post("/api/shares", json={"kind": "gallery", "target": "all"}).json()["token"]
    assert tok.startswith("t-")
    assert client.post("/api/session/reset").status_code == 200
    assert client.get("/api/stats").json()["totals"]["spots"] == 62
    client.post("/api/session", json={"profile": "main"})
    client.cookies.delete("contrail_profile")
    assert client.get("/api/session").json()["profile"] == "main"
    assert client.get("/api/stats").json()["totals"]["spots"] == before
    assert client.get("/api/spots", params={"registration": "F-TEST"}).json()["total"] == 0


def test_refdb_import_and_radar_enrichment(client, tmp_path):
    import gzip
    from app.services import opensky, refdb
    lines = ["39e68b;F-HBXA;A320;00;AIRBUS A-320;2012;Air France;",
             "39e68c;F-HBXB;A320;00;AIRBUS A-320;2012;Air France;",
             "39e68d;F-HBXC;A321;00;AIRBUS A-321;2014;Air France;",
             "3b7752;F-RARF;A332;10;AIRBUS A-330-200;2010;French Air Force;",
             "3a1234;F-GCQJ;P28R;00;PIPER PA-28R-201;1980;Air France;",
             "nothex;F-XXXX;A320;00;bad;;;"]
    f = tmp_path / "aircraft.csv.gz"
    f.write_bytes(gzip.compress("\n".join(lines).encode()))
    assert refdb.import_file(f, "test") == 5
    assert refdb.by_reg("F-HBXA")["typecode"] == "A320"
    assert refdb.by_hex(["3b7752"])["3b7752"]["military"] == 1
    # en-tête OpenSky
    g = tmp_path / "os.csv"
    g.write_text("'icao24','registration','manufacturername','model','typecode','operator','operatoricao','built'\n"
                 "'4ca123','EI-ABC','Boeing','737-8AS','B738','Ryanair','RYR','2005-01-01'\n")
    from app.services.refdb import _rows_from_text
    fmt, rows = _rows_from_text(open(g, encoding="utf-8"))
    assert fmt == "opensky" and next(rows)[2] == "B738"
    # le radar classe les appareils grâce à la base locale
    opensky._cache.clear()
    orig = opensky._states
    opensky._states = lambda params: {"time": 1, "states": [
        {"icao24": "39e68b", "callsign": "AFR1", "lat": 43.6, "lng": 1.4, "alt_m": 1000, "on_ground": False, "track": 90, "category": 0},
        {"icao24": "abcdef", "callsign": "HELI", "lat": 43.6, "lng": 1.4, "alt_m": 300, "on_ground": False, "track": 0, "category": 8}]}
    try:
        st = {s["icao24"]: s for s in client.get("/api/radar", params={"lamin": 43, "lomin": 1, "lamax": 44, "lomax": 2}).json()["states"]}
    finally:
        opensky._states = orig
    assert st["39e68b"]["cls"] == "narrow" and st["39e68b"]["registration"] == "F-HBXA"
    assert st["abcdef"]["cls"] == "heli"
    # remplissage automatique hors-ligne depuis la base locale
    assert client.get("/api/lookup/aircraft/F-RARF").json()["aircraft_icao"] == "A332"


def test_fleet_airlabs_pagination_and_exclusions(client, monkeypatch):
    import httpx
    from app.routers import fleets as fl
    from app.core import save_config
    save_config({"airlabs_api_key": "k"})
    regs_ = [f"F-H{chr(65 + i // 26)}{chr(65 + i % 26)}Z" for i in range(120)]

    def handler(req: httpx.Request):
        if req.url.path.endswith("/airlines"):
            return httpx.Response(200, json={"response": [{"name": "Air France", "iata_code": "AF"}]})
        limit = min(int(req.url.params["limit"]), 50)
        off = int(req.url.params["offset"])
        page = [{"reg_number": r, "icao": "A320", "model": "Airbus A320-200", "hex": "39" + f"{i:04x}", "engine": "jet", "type": "landplane"}
                for i, r in enumerate(regs_[off:off + limit], start=off)]
        if off == 0:
            page[0] = {"reg_number": "F-GCQJ", "icao": "P28R", "model": "PA-28RT-201 Arrow 4", "engine": "piston", "type": "landplane"}
        return httpx.Response(200, json={"request": {"has_more": off + limit < len(regs_)}, "response": page})

    monkeypatch.setattr(fl.ac, "client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    d = client.post("/api/fleets/AFR/fetch", json={}).json()
    assert d["fetch"]["received"] == 120 and d["fetch"]["skipped_light"] == 1
    assert len(d["fleet"]) >= 119 and d["by_type"][0]["type"] == "Airbus A320 family"
    d = client.post("/api/fleets/AFR/exclude", json={"registration": regs_[5]}).json()
    assert regs_[5] in [x["registration"] for x in d["excluded"]]
    assert regs_[5] not in [f["registration"] for f in d["fleet"]]
    d = client.delete(f"/api/fleets/AFR/exclude/{regs_[5]}").json()
    assert not d["excluded"]
    d = client.post("/api/fleets/AFR/complete-local").json()
    assert d["added"] == 1  # F-HBXC (base locale) ; F-GCQJ, avion léger, est ignoré
    assert any(f["registration"] == "F-HBXC" and f["source"] == "refdb" for f in d["fleet"])
    save_config({"airlabs_api_key": ""})


def test_achievements_tiers_and_legacy_migration(client):
    """Séries à paliers, rang, et reprise des déblocages des anciens codes (≤ v1.3)."""
    from app.core import db
    from app.services import gamification
    conn = db()
    conn.execute("INSERT OR REPLACE INTO achievements(code, criteria, icon, category, target, unlocked_at) "
                 "VALUES('km_earth', '{}', '🌏', 'flights', 40075, '2024-05-01T10:00:00Z')")
    conn.commit()
    gamification.sync_definitions()
    r = client.get("/api/achievements").json()
    by = {i["code"]: i for i in r["items"]}
    assert "km_earth" not in by and by["flight_km_40075"]["unlocked_at"] == "2024-05-01T10:00:00Z"
    assert r["total"] > 200 and r["points"] >= by["flight_km_40075"]["points"]
    assert {i["tier"] for i in r["items"]} == set(gamification.TIERS)
    assert r["rank"]["key"] in {k for _, k in gamification.RANKS}
    # Une même série va du plus simple au plus difficile
    spots = [i for i in r["items"] if i["series"] == "spots"]
    assert [i["target"] for i in spots] == sorted(i["target"] for i in spots) and spots[0]["tier"] == "bronze" and spots[-1]["tier"] == "diamond"


def test_refdb_merge_opensky_and_local_fleet(client, tmp_path):
    """tar1090 + OpenSky fusionnées : le code OACI d'opérateur est propagé, la flotte se construit sans AirLabs."""
    from app.services import refdb
    refdb.delete()
    tar = ["39e700;F-HEPA;A20N;00;AIRBUS A-320neo;2021;Air France;",
           "39e701;F-HEPB;A20N;00;AIRBUS A-320neo;2021;Air France;",
           "39e702;F-HEPC;A20N;00;AIRBUS A-320neo;2021;Air France;",
           "39e703;F-HEPD;A20N;00;AIRBUS A-320neo;2022;AIR FRANCE S.A.;",
           "39e704;F-HTYZ;A359;00;AIRBUS A-350-900;2023;Air France;",
           "3a9999;F-GZZZ;C172;00;CESSNA 172;1979;Aeroclub;"]
    f = tmp_path / "tar.csv"
    f.write_text("\n".join(tar))
    assert refdb.import_file(f, "tar1090") == 6
    osk = tmp_path / "os.csv"
    osk.write_text("'icao24','registration','typecode','model','operator','operatorIcao','built'\n"
                   "'39e700','F-HEPA','A20N','A320-251N','Air France','AFR','2021-01-01'\n"
                   "'39e701','F-HEPB','A20N','A320-251N','Air France','AFR','2021-01-01'\n"
                   "'39e702','','A20N','A320-251N','Air France','AFR','2021-01-01'\n"
                   "'4ca777','EI-NEW','B38M','737-8200','Ryanair','RYR','2022-01-01'\n")
    assert refdb.import_file(osk, "opensky") == 4
    st = refdb.status()
    assert st["count"] == 7 and "opensky" in st["source"] and "tar1090" in st["source"]
    # tar1090 garde la priorité sur l'immatriculation, OpenSky apporte le code OACI…
    assert refdb.by_reg("F-HEPC")["operator_icao"] == "AFR"
    # …qui est propagé aux appareils connus seulement par le nom (« AIR FRANCE S.A. » ≈ « Air France »)
    assert refdb.by_reg("F-HEPD")["operator_icao"] == "AFR" and refdb.by_reg("F-HTYZ")["operator_icao"] == "AFR"
    d = client.post("/api/fleets/AFR/complete-local", json={"replace": True}).json()
    regs_ = {x["registration"] for x in d["fleet"]}
    assert {"F-HEPA", "F-HEPB", "F-HEPC", "F-HEPD", "F-HTYZ"} <= regs_ and "F-GZZZ" not in regs_
    assert d["meta"]["fleet_source"] == "refdb"
    r = client.post("/api/fleets/build-local", json={}).json()
    assert r["airlines"] >= 1
    refdb.delete()
