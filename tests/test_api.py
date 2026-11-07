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
    opensky._states = lambda params, timeout=None: {"time": 1, "states": [
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


def test_radar_falls_back_to_free_source_on_quota(client, monkeypatch):
    import httpx
    from app.services import opensky
    opensky._cache.clear()
    opensky._blocked_until = 0.0
    opensky._failed_until = 0.0
    opensky._tile_cache.clear()
    opensky._src_off.clear()
    opensky.MIN_GAP = 0
    calls = []

    def handler(req: httpx.Request):
        calls.append(req.url.host)
        if req.url.host == "opensky-network.org":
            return httpx.Response(429, headers={"X-Rate-Limit-Retry-After-Seconds": "3600"})
        if req.url.host == "api.adsb.lol":
            return httpx.Response(200, json={"ac": [
                {"hex": "39e68b", "flight": "AFR1  ", "lat": 43.6, "lon": 1.4, "alt_baro": 10000, "gs": 200, "track": 90, "baro_rate": 640},
                {"hex": "abcdef", "lat": 43.5, "lon": 1.5, "alt_baro": "ground"},
                {"hex": "fffff0", "lat": 50.0, "lon": 1.5, "alt_baro": 5000},   # hors zone
                {"hex": "fffff1", "alt_baro": 5000}]})                           # sans position
        return httpx.Response(500)

    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: orig(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    res = client.get("/api/radar", params={"lamin": 43, "lomin": 1, "lamax": 44, "lomax": 2}).json()
    assert res["source"] == "adsb.lol" and {s["icao24"] for s in res["states"]} == {"39e68b", "abcdef"}
    a = next(s for s in res["states"] if s["icao24"] == "39e68b")
    assert a["alt_m"] == 3048.0 and a["callsign"] == "AFR1" and round(a["velocity"]) == 103
    assert next(s for s in res["states"] if s["icao24"] == "abcdef")["on_ground"] is True
    # OpenSky est mis en pause : un second appel (autre zone, hors cache) ne le sollicite plus
    n = calls.count("opensky-network.org")
    client.get("/api/radar", params={"lamin": 40, "lomin": 1, "lamax": 41, "lomax": 2})
    assert calls.count("opensky-network.org") == n
    opensky._blocked_until = 0.0
    opensky._failed_until = 0.0
    opensky._tile_cache.clear()
    opensky._src_off.clear()
    opensky.MIN_GAP = 0


def test_radar_wide_view_uses_free_tiles(client, monkeypatch):
    import httpx
    from app.services import opensky
    opensky._cache.clear()
    opensky._blocked_until = 0.0
    opensky._failed_until = 0.0
    opensky._tile_cache.clear()
    opensky._src_off.clear()
    opensky.MIN_GAP = 0
    hosts = []

    def handler(req: httpx.Request):
        hosts.append(req.url.host)
        if req.url.host == "opensky-network.org":
            return httpx.Response(429)
        # un avion par tuile, positionné au centre du disque interrogé
        import re
        lat, lon = re.search(r"(?:point|lat)/(-?[\d.]+)/(?:lon/)?(-?[\d.]+)", req.url.path).groups()
        return httpx.Response(200, json={"ac": [{"hex": f"a{len(hosts):05x}", "lat": float(lat), "lon": float(lon), "alt_baro": 30000}]})

    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: orig(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    r = client.get("/api/radar", params={"lamin": 40, "lomin": -2, "lamax": 50, "lomax": 8})   # 100 °² : OpenSky d'abord
    r = client.get("/api/radar", params={"lamin": 38, "lomin": -4, "lamax": 52, "lomax": 10})  # 196 °² : tuiles gratuites
    assert r.status_code == 200 and "opensky-network.org" not in hosts[-6:]
    assert len(r.json()["states"]) >= 4 and r.json()["source"] in ("adsb.lol", "adsb.fi", "airplanes.live")
    assert client.get("/api/radar", params={"lamin": 30, "lomin": -10, "lamax": 55, "lomax": 20}).status_code == 422


def test_radar_survives_opensky_timeout_and_partial_tiles(client, monkeypatch):
    import httpx
    from app.services import opensky
    opensky._cache.clear(); opensky._tile_cache.clear()
    opensky._blocked_until = 0.0; opensky._failed_until = 0.0
    opensky._src_off.clear(); opensky.MIN_GAP = 0
    n = {"os": 0}

    def handler(req: httpx.Request):
        if req.url.host == "opensky-network.org":
            n["os"] += 1
            raise httpx.ReadTimeout("lent", request=req)
        import re
        lat = float(re.search(r"(?:point|lat)/(-?[\d.]+)", req.url.path).group(1))
        if lat > 47:       # une partie de la zone : toutes les sources échouent
            return httpx.Response(429 if req.url.host == "api.adsb.lol" else 503)
        return httpx.Response(200, json={"ac": [{"hex": "39e68b", "lat": lat, "lon": 1.5, "alt_baro": 9000}]})

    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: orig(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    # 1) OpenSky expire : repli immédiat, puis mise en pause de 60 s (pas de nouvel essai)
    r = client.get("/api/radar", params={"lamin": 43, "lomin": 1, "lamax": 44, "lomax": 2})
    assert r.status_code == 200 and r.json()["source"] == "adsb.lol" and n["os"] == 1
    client.get("/api/radar", params={"lamin": 42, "lomin": 1, "lamax": 43, "lomax": 2})
    assert n["os"] == 1
    # 2) vue large dont une tuile échoue : résultat partiel, pas d'erreur
    r = client.get("/api/radar", params={"lamin": 38, "lomin": -4, "lamax": 52, "lomax": 10})
    assert r.status_code == 200 and r.json()["partial"] >= 1 and r.json()["states"]
    # 3) tout échoue et rien en cache : 502
    r = client.get("/api/radar", params={"lamin": 60, "lomin": 1, "lamax": 61, "lomax": 2})
    assert r.status_code == 502 and "HTTP 429" in r.json()["detail"]["reason"]


def test_radar_pauses_blocked_source_and_uses_next(client, monkeypatch):
    import httpx
    from app.services import opensky
    opensky._cache.clear(); opensky._tile_cache.clear(); opensky._src_off.clear()
    opensky._blocked_until = 0.0; opensky._failed_until = 0.0; opensky.MIN_GAP = 0
    calls = []

    def handler(req: httpx.Request):
        calls.append(req.url.host)
        if req.url.host == "opensky-network.org":
            return httpx.Response(429)
        if req.url.host == "api.adsb.lol":
            return httpx.Response(429)
        if req.url.host == "api.airplanes.live":
            return httpx.Response(403)
        return httpx.Response(200, json={"aircraft": [{"hex": "39e68b", "lat": 43.6, "lon": 1.4, "alt_baro": 9000}]})

    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: orig(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    r = client.get("/api/radar", params={"lamin": 43, "lomin": 1, "lamax": 44, "lomax": 2}).json()
    assert r["source"] == "adsb.fi" and len(r["states"]) == 1
    opensky._cache.clear(); opensky._tile_cache.clear(); calls.clear()
    r = client.get("/api/radar", params={"lamin": 43, "lomin": 1.1, "lamax": 44, "lomax": 2.1}).json()
    assert r["source"] == "adsb.fi" and "api.adsb.lol" not in calls and "api.airplanes.live" not in calls


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


def test_subsidiary_not_merged_with_parent_airline(client):
    """Hop! (code AFR hérité de la maison mère) ne doit pas être compté comme Air France."""
    for reg, owner in (("F-GKXA", "Air France"), ("F-GKXB", "AIR FRANCE S.A."), ("F-HBXC", "Hop!")):
        data = {"registration": reg, "aircraft": "Airbus A320", "aircraft_icao": "A320", "owner": owner,
                "airline_icao": "AFR", "date": "2026-05-01T10:00"}
        r = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")})
        assert r.status_code == 200, r.text
    from app.services import operators
    operators.reset_cache()
    groups = {g["key"]: g for g in client.get("/api/fleets").json()}
    # AFR = les 2 spots codés AFR + le spot « Air France » saisi sans code (rattaché à AFR par son nom)
    assert groups["AFR"]["regs"] == 3 and groups["Hop!"]["regs"] == 1
    airlines = {a["v"]: a["n"] for a in client.get("/api/spots/facets").json()["airlines"]}
    assert airlines["AFR"] == 3 and airlines["Hop!"] == 1
    assert len(client.get("/api/spots", params={"airline": "Hop!"}).json()["items"]) == 1
    assert len(client.get("/api/spots", params={"airline": "AFR"}).json()["items"]) == 3
    top = {a["k"]: a["n"] for a in client.get("/api/stats").json()["top_airlines"]}
    assert top["AFR"] == 3 and top["Hop!"] == 1


def test_polluted_registered_name_does_not_merge_subsidiary(client):
    """Un nom enregistré à tort (« Hop! » pour AFR) ne doit plus fusionner les deux compagnies."""
    from app.core import execute
    from app.services import operators
    execute("INSERT INTO airlines(key, icao, name) VALUES('AFR','AFR','Hop!') ON CONFLICT(key) DO UPDATE SET name='Hop!'")
    operators.reset_cache()
    groups = {g["key"]: g for g in client.get("/api/fleets").json()}
    assert groups["AFR"]["regs"] == 3 and groups["Hop!"]["regs"] == 1
    d = client.get("/api/fleets-reference/AFR").json()
    assert d["used"] == ["air france"]


def test_wishlist_kinds_matching_and_legacy_watchlist(client):
    from app.services import wishes
    # souhaits de plusieurs natures
    a = client.post("/api/wishes", json={"kind": "aircraft", "value": "f-wish", "track": True}).json()
    assert a["value"] == "F-WISH" and a["status"] == "open"
    assert client.post("/api/wishes", json={"kind": "aircraft", "value": "F-WISH"}).status_code == 409
    t = client.post("/api/wishes", json={"kind": "type", "value": "A388", "goal_count": 1}).json()
    ap = client.post("/api/wishes", json={"kind": "airport", "value": "LFBO", "goal_count": 2}).json()
    ev = client.post("/api/wishes", json={"kind": "event", "title": "Meeting", "start_date": "2026-05-01",
                                          "end_date": "2026-05-02", "airport": "LFBO"}).json()
    assert ev["days_to_start"] is not None and client.post("/api/wishes", json={"kind": "event", "title": "x"}).status_code == 422
    child = client.post("/api/wishes", json={"kind": "other", "title": "Rafale solo", "parent_id": ev["id"]}).json()
    assert child["parent_id"] == ev["id"]
    # un spot correspondant valide l'appareil (suivi automatique) et fait progresser l'aéroport
    data = {"registration": "F-WISH", "aircraft": "Airbus A380-861", "aircraft_icao": "A388", "owner": "Air France",
            "airport": "LFBO", "date": "2026-05-01T10:00"}
    r = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()
    done = {w["title"] for w in r["wishes"]}
    assert "F-WISH" in done and any(w["kind"] == "type" for w in r["wishes"])
    items = {w["id"]: w for w in client.get("/api/wishes").json()}
    assert items[a["id"]]["status"] == "done" and items[a["id"]]["done_spot_id"] == r["spot"]["id_spotting"]
    assert items[t["id"]]["status"] == "done"
    assert items[ap["id"]]["progress"] >= 1
    assert items[ev["id"]]["progress"] >= 1        # l'événement attend la fin des dates pour se valider
    # compatibilité : l'ancienne API watchlist reste utilisable (suivi sans validation automatique)
    w = client.post("/api/watchlist", json={"registration": "F-GKXA"}).json()
    assert w["auto_complete"] == 0 and w["track"] == 1 and w["registration"] == "F-GKXA"
    assert any(x["registration"] == "F-GKXA" for x in client.get("/api/watchlist").json())
    assert client.delete(f"/api/watchlist/{w['id']}").json()["deleted"] == w["id"]
    # rouvrir, supprimer l'événement détache ses objectifs
    assert client.post(f"/api/wishes/{a['id']}/reopen").json()["status"] == "open"
    client.delete(f"/api/wishes/{ev['id']}")
    assert next(x for x in client.get("/api/wishes").json() if x["id"] == child["id"])["parent_id"] is None
    assert "title,value" in client.get("/api/wishes/export.csv").text
    assert wishes.summary()["open"] >= 1


def test_wishlist_family_livery_airline_and_reminders(client):
    from app.services import wishes
    fam = client.post("/api/wishes", json={"kind": "type", "value": "A320", "family": True, "count_existing": True}).json()
    assert fam["progress"] >= 1 and fam["status"] == "done"        # les A319/A321/A320 déjà spottés comptent
    air = client.post("/api/wishes", json={"kind": "airline", "value": "AFR", "goal_count": 50, "count_existing": True}).json()
    assert air["status"] == "open" and air["progress"] >= 1
    hop = client.post("/api/wishes", json={"kind": "airline", "value": "Hop!", "count_existing": True}).json()
    assert hop["progress"] <= air["progress"] or hop["title"]      # Hop! ne reprend pas les spots d'Air France
    liv = client.post("/api/wishes", json={"kind": "livery", "value": "SkyTeam", "goal_count": 1, "count_existing": True}).json()
    assert liv["status"] == "done"
    from datetime import timedelta
    ev = client.post("/api/wishes", json={"kind": "event", "title": "Rappel", "remind_days": 3,
                                          "start_date": (wishes.today() + timedelta(days=3)).isoformat()}).json()
    assert wishes.reminders() >= 1 and wishes.reminders() == 0      # un seul rappel par échéance
    n = client.get("/api/notifications").json()["items"]
    assert any(i["kind"] == "wishlist" for i in n)


def test_primer_livery_is_separate_from_special_liveries(client):
    from app.core import execute
    from app.services import collection
    base = client.get("/api/stats").json()["totals"]["special_liveries"]
    data = {"registration": "F-WZZZ", "aircraft": "Airbus A350-1000", "aircraft_icao": "A35K", "livery": "Primer",
            "flight_type": "test", "date": "2026-06-01T10:00"}
    r = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()
    sid = r["spot"]["id_spotting"]
    assert r["spot"]["livery_category"] == "primer"
    assert any(b["code"] == "primer" for b in client.get(f"/api/spots/{sid}").json()["badges"])
    assert not any(b["code"] == "special_livery" for b in client.get(f"/api/spots/{sid}").json()["badges"])
    assert client.get("/api/stats").json()["totals"]["special_liveries"] == base      # pas compté comme livrée spéciale
    groups = {g["category"]: g for g in client.get("/api/liveries").json()}
    assert groups["primer"]["unique"] >= 1
    assert sid not in {s["id_spotting"] for s in client.get("/api/spots", params={"special": "true"}).json()["items"]}
    assert sid in {s["id_spotting"] for s in client.get("/api/spots", params={"livery_category": "primer"}).json()["items"]}
    # un ancien spot « Primer » rangé en livrée spéciale est reclassé au démarrage
    execute("UPDATE spotting SET livery_category = 'special' WHERE id_spotting = ?", (sid,))
    assert collection.recategorize() >= 1
    assert client.get(f"/api/spots/{sid}").json()["livery_category"] == "primer"


def test_primer_defaults_flight_type_to_test(client):
    data = {"registration": "F-WZZY", "aircraft": "Airbus A220-300", "aircraft_icao": "BCS3", "livery": "Primer", "date": "2026-06-02T10:00"}
    s = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()["spot"]
    assert s["flight_type"] == "test"
    data.update(registration="F-WZZX", flight_type="delivery")       # une valeur saisie n'est jamais écrasée
    s = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()["spot"]
    assert s["flight_type"] == "delivery"


def _post_spot(client, **data):
    base = {"aircraft": "Airbus A350-900", "aircraft_icao": "A359", "date": "2026-06-03T10:00", **data}
    return client.post("/api/spots", data={"data": json.dumps(base)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()["spot"]


def test_white_livery_is_separate_from_special_liveries(client):
    base = client.get("/api/stats").json()["totals"]["special_liveries"]
    for reg, liv in (("F-WHT1", "Blanche"), ("F-WHT2", "White"), ("F-WHT3", "Livrée blanche")):
        assert _post_spot(client, registration=reg, livery=liv)["livery_category"] == "white"
    assert _post_spot(client, registration="F-WHT4", livery="Blanche et rouge")["livery_category"] != "white"   # pas un simple « blanc »
    assert client.get("/api/stats").json()["totals"]["special_liveries"] == base + 1                              # seule la 4e compte
    ids = {s["registration"] for s in client.get("/api/spots", params={"livery_category": "white"}).json()["items"]}
    assert {"F-WHT1", "F-WHT2", "F-WHT3"} <= ids
    assert "white" in {g["category"] for g in client.get("/api/liveries").json()}


def test_test_registration_is_optional_for_any_flight_type(client):
    s = _post_spot(client, registration="F-WTR1", flight_type="test", test_registration=" f-wwcf ")
    assert s["test_registration"] == "F-WWCF"
    assert client.get(f"/api/spots/{s['id_spotting']}").json()["test_registration"] == "F-WWCF"
    assert s["id_spotting"] in {x["id_spotting"] for x in client.get("/api/spots", params={"search": "WWCF"}).json()["items"]}
    assert "F-WWCF" in client.get("/api/export/spots.csv").text
    # indépendante du type de vol : conservée si le type change ou n'est pas renseigné ; effacée seulement si on la vide
    upd = client.put(f"/api/spots/{s['id_spotting']}", data={"data": json.dumps({"flight_type": "delivery"})}).json()
    assert (upd.get("spot") or upd)["test_registration"] == "F-WWCF"
    s2 = _post_spot(client, registration="F-WTR2", test_registration="F-WWDD")                  # aucun type de vol
    assert s2["test_registration"] == "F-WWDD"
    s3 = _post_spot(client, registration="F-WTR2B", flight_type="commercial", test_registration="F-WWDE")
    assert s3["test_registration"] == "F-WWDE"
    upd = client.put(f"/api/spots/{s2['id_spotting']}", data={"data": json.dumps({"test_registration": ""})}).json()
    assert (upd.get("spot") or upd)["test_registration"] is None


def test_wish_on_aircraft_matches_its_test_registration(client):
    w = client.post("/api/wishes", json={"kind": "aircraft", "value": "F-WWXY", "goal_count": 1}).json()
    _post_spot(client, registration="F-WTR3", flight_type="test", test_registration="F-WWXY")
    got = next(x for x in client.get("/api/wishes").json() if x["id"] == w["id"])
    assert got["status"] == "done"


def test_storage_report_and_maintenance(client):
    from app.core import DIRS
    r = client.get("/api/storage").json()
    assert r["total"] > 0 and r["parts"]["images"]["files"] >= 1 and r["spots"] >= 1
    assert r["orphans"]["files"] == 0
    import os as _os, time as _t
    stray = DIRS["images"] / "orphelin-test.webp"
    stray.write_bytes(b"x" * 2048)
    fresh = DIRS["images"] / "envoi-en-cours.webp"
    fresh.write_bytes(b"y" * 10)
    _os.utime(stray, (_t.time() - 7200, _t.time() - 7200))
    assert client.get("/api/storage").json()["orphans"]["files"] == 1          # le fichier récent n'est pas signalé
    m = client.post("/api/maintenance", json={"purge_orphans": True}).json()
    assert m["integrity"] is True and m["orphans_removed"] == 1
    assert not stray.exists() and fresh.exists()
    assert client.get("/api/storage").json()["parts"]["images"]["files"] >= 1   # les photos des spots sont intactes
    fresh.unlink()


def test_security_headers_and_upload_cap(client, monkeypatch):
    h = client.get("/api/health").headers
    assert h["x-frame-options"] == "SAMEORIGIN" and "geolocation" in h["permissions-policy"]
    import app.main as m
    monkeypatch.setattr(m, "_MAX_UPLOAD", 50)
    r = client.post("/api/analyze-photo", files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 413


def test_owner_name_of_another_code_is_merged(client):
    """Un spot « Ryanair » saisi sous le code MAY (Malta Air) rejoint RYR ; « Malta Air » reste à part."""
    from app.services import operators
    rows = [("EI-RYA", "RYR", "Ryanair"), ("EI-RYB", "RYR", "Ryanair DAC"), ("9H-MAA", "MAY", "Malta Air"),
            ("9H-MAB", "MAY", "Malta Air"), ("9H-MAC", "MAY", "Ryanair"), ("EI-RYC", None, "Ryanair")]
    for reg, code, owner in rows:
        data = {"registration": reg, "aircraft": "Boeing 737-800", "aircraft_icao": "B738", "owner": owner,
                "airline_icao": code, "date": "2026-05-02T10:00"}
        assert client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).status_code == 200
    operators.reset_cache()
    airlines = {a["v"]: a["n"] for a in client.get("/api/spots/facets").json()["airlines"]}
    assert airlines["RYR"] == 4 and airlines["MAY"] == 2           # EI-RYA, EI-RYB, 9H-MAC (nom Ryanair) et EI-RYC (sans code)
    assert not any(k.lower().startswith("ryanair") for k in airlines)
    assert {s["registration"] for s in client.get("/api/spots", params={"airline": "RYR"}).json()["items"]} >= {"9H-MAC", "EI-RYC"}


def test_airframe_groups_test_and_final_registration_by_msn(client):
    _post_spot(client, registration="F-WWAA", aircraft="Airbus A321neo", aircraft_icao="A21N", msn="9999", flight_type="test", test_registration="F-WWAA", livery="Primer")
    _post_spot(client, registration="F-HAAA", aircraft="Airbus A321neo", aircraft_icao="A21N", msn="09999", livery="Standard", date="2026-08-01T10:00")
    _post_spot(client, registration="N99999", aircraft="Boeing 737-800", aircraft_icao="B738", msn="9999")      # même MSN, autre constructeur
    a = client.get("/api/airframe/F-HAAA").json()
    assert a["spots"] == 2 and [x["registration"] for x in a["aliases"]] == ["F-WWAA"]
    assert {e["registration"] for e in a["events"]} == {"F-HAAA", "F-WWAA"}
    assert client.get("/api/airframe/F-WWAA").json()["spots"] == 2          # depuis l'immat d'essai : même cellule
    b = client.get("/api/airframe/N99999").json()
    assert b["spots"] == 1 and b["aliases"] == []                           # un MSN n'est unique que chez un constructeur
    sid = next(s["id_spotting"] for s in client.get("/api/spots", params={"registration": "F-HAAA"}).json()["items"])
    assert client.get(f"/api/spots/{sid}").json()["encounters"] == 2
    # test_registration sur un spot dont l'immat est la définitive
    _post_spot(client, registration="F-HBBB", aircraft="Airbus A330-900", aircraft_icao="A339", flight_type="test", test_registration="F-WWBB")
    _post_spot(client, registration="F-WWBB", aircraft="Airbus A330-900", aircraft_icao="A339", flight_type="test")
    assert client.get("/api/airframe/F-WWBB").json()["spots"] == 2


def test_remote_backup_to_directory_and_webdav(client, tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from app.core import CONFIG_PATH, save_config
    from app.services import backup

    remote = tmp_path / "nas"
    remote.mkdir()
    save_config({"backup_remote_path": str(remote)})
    r = client.post("/api/backups").json()
    assert r["remote"]["ok"] and (remote / r["name"]).is_file()
    assert not list(remote.glob("*.part"))                                         # copie atomique : pas de fichier partiel
    for _ in range(3):                                                             # rotation sur la destination (backup_keep)
        client.post("/api/backups")
    keep = int(client.get("/api/settings").json().get("backup_keep") or 7)
    assert len(list(remote.glob("contrail-backup-*.zip"))) <= keep
    st = client.get("/api/backups").json()["remote"]
    assert st["configured"] and st["last"]["ok"]
    # un montage absent n'est jamais « créé » : échec signalé, sauvegarde locale conservée
    save_config({"backup_remote_path": str(tmp_path / "absent")})
    r = client.post("/api/backups").json()
    assert r["remote"]["ok"] is False and not (tmp_path / "absent").exists() and r["name"]
    assert any(i["kind"] == "backup" for i in client.get("/api/notifications").json()["items"])
    assert client.post("/api/backups/remote-test").json()["ok"] is False

    # WebDAV : serveur minimal (PUT, PROPFIND, DELETE, authentification de base)
    files: dict[str, bytes] = {}

    class Dav(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _auth(self):
            ok = self.headers.get("Authorization") == "Basic am9objpzZWNyZXQ="      # john:secret
            if not ok:
                self.send_response(401); self.end_headers()
            return ok
        def do_PUT(self):
            if self._auth():
                files[self.path.rsplit("/", 1)[-1]] = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(201); self.end_headers()
        def do_DELETE(self):
            if self._auth():
                files.pop(self.path.rsplit("/", 1)[-1], None); self.send_response(204); self.end_headers()
        def do_PROPFIND(self):
            if self._auth():
                body = "<d:multistatus xmlns:d='DAV:'>" + "".join(f"<d:response><d:href>/dav/{n}</d:href></d:response>" for n in files) + "</d:multistatus>"
                self.send_response(207); self.send_header("Content-Length", str(len(body.encode()))); self.end_headers(); self.wfile.write(body.encode())
    srv = HTTPServer(("127.0.0.1", 0), Dav)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        save_config({"backup_remote_path": "", "backup_webdav_url": f"http://127.0.0.1:{srv.server_port}/dav",
                     "backup_webdav_user": "john", "backup_webdav_password": "secret"})
        assert client.post("/api/backups/remote-test").json()["ok"] is True and ".contrail-probe" not in files
        for _ in range(keep + 2):
            r = client.post("/api/backups").json()
            assert r["remote"]["ok"], r["remote"]
        names = [n for n in files if n.startswith("contrail-backup-")]
        assert r["name"] in names and len(names) <= keep                          # rotation WebDAV via PROPFIND + DELETE
        save_config({"backup_webdav_password": "faux"})
        assert client.post("/api/backups").json()["remote"]["ok"] is False
        # le mot de passe WebDAV n'est jamais écrit dans l'archive
        import zipfile
        z = zipfile.ZipFile(backup.backup_path(r["name"]))
        assert "backup_webdav_password" not in z.read("config.json").decode()
    finally:
        srv.shutdown()
        save_config({"backup_webdav_url": "", "backup_webdav_user": "", "backup_webdav_password": "", "backup_remote_path": ""})


def test_photo_duplicates_by_perceptual_hash(client):
    from PIL import ImageDraw
    from app.services import media

    def photo(w, h, shapes, quality=90):
        im = Image.new("RGB", (w, h), (60, 90, 140))
        d = ImageDraw.Draw(im)
        for box, col in shapes:
            d.rectangle([box[0] * w, box[1] * h, box[2] * w, box[3] * h], fill=col)
        buf = io.BytesIO(); im.save(buf, "JPEG", quality=quality); return buf.getvalue()
    a = [((0.1, 0.5, 0.9, 0.7), (230, 230, 230)), ((0.4, 0.2, 0.6, 0.8), (200, 30, 30)), ((0.0, 0.8, 1.0, 1.0), (40, 120, 40))]
    b = [((0.2, 0.1, 0.4, 0.4), (250, 200, 0)), ((0.6, 0.6, 0.95, 0.95), (10, 10, 10))]
    first = photo(1600, 1000, a)
    sid = client.post("/api/spots", data={"data": json.dumps({"registration": "F-HPH1", "aircraft": "ATR 72", "aircraft_icao": "AT76", "date": "2026-07-01T10:00"})},
                      files={"image": ("a.jpg", first, "image/jpeg")}).json()["spot"]["id_spotting"]
    assert client.get(f"/api/spots/{sid}").json()["phash"]
    # même image redimensionnée, recompressée et renommée → détectée
    again = photo(640, 400, a, quality=55)
    m = client.post("/api/spots/check-photo", files={"image": ("IMG_0001.jpg", again, "image/jpeg")}).json()["matches"]
    assert m and m[0]["id_spotting"] == sid and m[0]["distance"] <= 6
    # autre image → pas de correspondance ; et un spot ne se signale pas lui-même à l'édition
    assert client.post("/api/spots/check-photo", files={"image": ("b.jpg", photo(1600, 1000, b), "image/jpeg")}).json()["matches"] == []
    assert client.post("/api/spots/check-photo", data={"exclude_id": str(sid)}, files={"image": ("c.jpg", again, "image/jpeg")}).json()["matches"] == []
    # deux spots avec la même photo → listés comme doublon ; un ancien spot sans empreinte est rattrapé
    sid2 = client.post("/api/spots", data={"data": json.dumps({"registration": "F-HPH2", "aircraft": "ATR 72", "aircraft_icao": "AT76", "date": "2026-07-02T10:00"})},
                       files={"image": ("a2.jpg", again, "image/jpeg")}).json()["spot"]["id_spotting"]
    d = client.get("/api/spots/duplicates", params={"limit": 100000}).json()
    assert any({p["a"]["id"], p["b"]["id"]} == {sid, sid2} for p in d["pairs"])
    from app.core import execute
    execute("UPDATE spotting SET phash = NULL WHERE id_spotting = ?", (sid,))
    assert media.backfill_phash() >= 1 and client.get(f"/api/spots/{sid}").json()["phash"]


def test_global_search_finds_test_registration_and_msn(client):
    _post_spot(client, registration="F-HSRC", aircraft="Airbus A321neo", aircraft_icao="A21N", msn="7777", flight_type="test", test_registration="F-WWSR")
    for term, field in (("F-WWSR", "test_registration"), ("wwsr", "test_registration"), ("7777", "msn")):
        r = client.get("/api/search", params={"q": term}).json()
        assert any(s["registration"] == "F-HSRC" for s in r["spots"]), term
        assert any(a["registration"] == "F-HSRC" for a in r["airframes"]), term
    hit = next(s for s in client.get("/api/search", params={"q": "F-WWSR"}).json()["spots"] if s["registration"] == "F-HSRC")
    assert hit["test_registration"] == "F-WWSR"


def test_free_place_instead_of_airport(client):
    # texte libre dans le champ « aéroport » : devient un lieu, avec le fuseau de l'aéroport le plus proche des coordonnées
    s = _post_spot(client, registration="F-PLG1", airport="Plage du Touquet", lat=50.52, lng=1.59, date="2026-06-10T10:00")
    assert s["airport"] is None and s["place"] == "Plage du Touquet"
    assert s["date_utc"] == "2026-06-10T08:00:00Z"                          # Europe/Paris, heure d'été
    # ville choisie dans les suggestions : lieu + coordonnées, aéroport vide
    s2 = _post_spot(client, registration="F-PLG2", airport="", place="Biscarrosse, Nouvelle-Aquitaine, France", lat=44.39, lng=-1.17)
    assert s2["airport"] is None and s2["place"].startswith("Biscarrosse") and s2["lat"] == 44.39
    # un aéroport reconnu reste un aéroport, et efface un éventuel lieu
    s3 = _post_spot(client, registration="F-PLG3", airport="lfbo")
    assert s3["airport"] == "LFBO" and s3["place"] is None
    upd = client.put(f"/api/spots/{s2['id_spotting']}", data={"data": json.dumps({"airport": "LFBO", "place": ""})}).json()
    assert (upd.get("spot") or upd)["airport"] == "LFBO" and (upd.get("spot") or upd)["place"] is None
    # le réglage « aéroport par défaut » ne s'applique pas quand un lieu est donné
    client.put("/api/settings", json={"default_airport": "LFPG"})
    s4 = _post_spot(client, registration="F-PLG4", place="Meeting de La Baule", lat=47.28, lng=-2.39)
    s5 = _post_spot(client, registration="F-PLG5")
    client.put("/api/settings", json={"default_airport": ""})
    assert s4["airport"] is None and s4["place"] == "Meeting de La Baule" and s5["airport"] == "LFPG"
    # recherche, filtre, carte, doublon
    assert s["id_spotting"] in {x["id_spotting"] for x in client.get("/api/spots", params={"search": "Touquet"}).json()["items"]}
    assert s["id_spotting"] in {x["id_spotting"] for x in client.get("/api/spots", params={"place": "Plage du Touquet"}).json()["items"]}
    assert "Plage du Touquet" in client.get("/api/spots/facets").json()["places"]
    assert any(p["name"] == "Plage du Touquet" for p in client.get("/api/spots/map").json()["places"])
    assert any(x["registration"] == "F-PLG1" for x in client.get("/api/search", params={"q": "Touquet"}).json()["spots"])
    dup = client.post("/api/spots/check-duplicate", json={"registration": "F-PLG1", "airport": "Plage du Touquet", "date": "2026-06-10T15:00"}).json()
    assert len(dup["duplicates"]) == 1


def test_places_search_uses_geocoder(client, monkeypatch):
    import httpx
    from app.services import aircraft

    def handler(req):
        assert req.url.params["name"] == "Biscarrosse" and req.url.params["language"] == "fr"
        return httpx.Response(200, json={"results": [{"name": "Biscarrosse", "latitude": 44.39, "longitude": -1.17, "country_code": "FR",
                                                       "country": "France", "admin1": "Nouvelle-Aquitaine", "admin2": "Landes", "timezone": "Europe/Paris"},
                                                      {"name": "Biscarrosse", "latitude": 1.0, "longitude": 2.0, "country_code": "XX", "country": "Ailleurs", "admin1": "Région X"}]})
    monkeypatch.setattr(aircraft, "client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    r = client.get("/api/places/search", params={"q": "Biscarrosse", "lang": "fr"}).json()
    assert r[0] == {"label": "Biscarrosse (Landes), France", "name": "Biscarrosse", "detail": "Landes · Nouvelle-Aquitaine · France",
                    "lat": 44.39, "lng": -1.17, "country": "FR", "tz": "Europe/Paris"}
    assert r[1]["label"] == "Biscarrosse (Région X), Ailleurs"          # sans département : la région distingue l'homonyme
    monkeypatch.undo()
    assert client.get("/api/places/search", params={"q": "Biscarrosse"}).json() == []      # hors ligne : pas d'erreur, aéroports seulement


def test_spot_without_registration(client):
    base = client.get("/api/stats").json()["totals"]["registrations"]
    r = client.post("/api/spots", data={"data": json.dumps({"aircraft": "Dassault Rafale", "aircraft_icao": "RFAL", "airport": "Plage du Touquet",
                                                            "date": "2026-06-11T10:00"})}, files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 422                                              # jamais par accident : il faut le demander explicitement
    ids = []
    for _ in range(2):
        s = client.post("/api/spots", data={"data": json.dumps({"unknown_registration": True, "aircraft": "Dassault Rafale", "aircraft_icao": "RFAL",
                                                                "place": "Meeting de La Baule", "date": "2026-06-11T10:00"})},
                        files={"image": ("p.jpg", jpeg_bytes(), "image/jpeg")}).json()["spot"]
        assert s["registration"].startswith("SANS-IMMAT-") and s["country"] is None
        ids.append(s["id_spotting"])
    assert client.get("/api/stats").json()["totals"]["registrations"] == base          # pas des « avions identifiés »
    assert client.get("/api/stats").json()["totals"]["spots"] >= 2
    regs_ = {client.get(f"/api/spots/{i}").json()["registration"] for i in ids}
    assert len(regs_) == 2                                                   # deux spots anonymes ne sont jamais fusionnés
    assert client.get(f"/api/airframe/{sorted(regs_)[0]}").json()["spots"] == 1
    # identifier l'avion plus tard : il prend sa vraie immatriculation et compte comme avion
    up = client.put(f"/api/spots/{ids[0]}", data={"data": json.dumps({"registration": "F-RAFA"})}).json()
    assert (up.get("spot") or up)["registration"] == "F-RAFA" and (up.get("spot") or up)["country"] == "FR"
    assert client.get("/api/stats").json()["totals"]["registrations"] == base + 1
    # vider l'immatriculation d'un avion identifié sans le demander est refusé ; avec la case, on repasse en « inconnu »
    assert client.put(f"/api/spots/{ids[0]}", data={"data": json.dumps({"registration": ""})}).status_code == 422
    up = client.put(f"/api/spots/{ids[0]}", data={"data": json.dumps({"registration": "", "unknown_registration": True})}).json()
    assert (up.get("spot") or up)["registration"].startswith("SANS-IMMAT-")


def test_patrol_lifecycle(client):
    def post(d, **kw):
        return client.post("/api/spots", data={"data": json.dumps(d)}, files={"image": ("p.jpg", jpeg_bytes((10, 200, 90)), "image/jpeg")}, **kw)
    base = client.get("/api/stats").json()["totals"]["registrations"]
    r = post({"registration": "F-TPF01", "aircraft": "Dassault Alpha Jet", "owner": "Patrouille de France", "airport": "LFBO",
              "date": "2026-07-14T11:00", "tags": [],
              "patrol": {"name": "Patrouille de France", "members": [
                  {"registration": "F-TPF02"}, {"registration": "F-TPF03", "aircraft": "Alpha Jet E"},
                  {"unknown_registration": True}, {"registration": "f-tpf02"}]}})     # doublon dans la saisie ignoré
    assert r.status_code == 200, r.text
    main = r.json()["spot"]
    pat = main["patrol"]
    assert pat["name"] == "Patrouille de France" and len(pat["members"]) == 4
    members = {m["registration"]: m for m in pat["members"]}
    assert "F-TPF02" in members and "F-TPF03" in members and sum(k.startswith("SANS-IMMAT-") for k in members) == 1
    # un seul fichier photo pour toute la patrouille ; l'avion saisi à part garde son modèle, les autres héritent
    full = [client.get(f"/api/spots/{m['id_spotting']}").json() for m in pat["members"]]
    assert len({f["image"] for f in full}) == 1 and all(f["airport"] == "LFBO" and f["date"].startswith("2026-07-14") for f in full)
    assert {f["registration"]: f["aircraft"] for f in full}["F-TPF03"] == "Alpha Jet E"
    assert {f["registration"]: f["aircraft"] for f in full}["F-TPF02"] == "Dassault Alpha Jet"
    # 3 avions identifiés de plus, l'inconnu n'est pas compté
    assert client.get("/api/stats").json()["totals"]["registrations"] == base + 3
    # la liste expose la patrouille et se filtre dessus
    items = client.get("/api/spots", params={"patrol": pat["id"], "limit": 100}).json()["items"]
    assert len(items) == 4 and all(i["patrol_name"] == "Patrouille de France" for i in items)
    assert "Patrouille de France" in client.get("/api/spots/patrol-names").json()
    # une patrouille ne se signale pas comme doublon de photo
    assert not any(p["a"]["id"] in {m["id_spotting"] for m in pat["members"]} and p["b"]["id"] in {m["id_spotting"] for m in pat["members"]}
                   for p in client.get("/api/spots/duplicates", params={"limit": 1000}).json()["pairs"])
    # même avion, même jour, même lieu : refusé (409) tant qu'on ne force pas
    again = post({"registration": "F-TPF09", "airport": "LFBO", "date": "2026-07-14T12:00",
                  "patrol": {"members": [{"registration": "F-TPF02"}]}})
    assert again.status_code == 409
    # renommer et ajouter un avion depuis la fiche
    up = client.put(f"/api/spots/{main['id_spotting']}", data={"data": json.dumps({"patrol": {"name": "PAF", "members": [{"registration": "F-TPF04"}]}})}).json()
    assert up["spot"]["patrol"]["name"] == "PAF" and len(up["spot"]["patrol"]["members"]) == 5
    # supprimer un membre garde la photo des autres
    victim = next(m for m in up["spot"]["patrol"]["members"] if m["registration"] == "F-TPF04")
    img = main["image"]
    assert client.delete(f"/api/spots/{victim['id_spotting']}").status_code == 200
    assert media_file_exists(img)
    # retirer un avion de la patrouille
    sid = next(m["id_spotting"] for m in client.get(f"/api/spots/{main['id_spotting']}").json()["patrol"]["members"] if m["registration"] == "F-TPF03")
    assert client.put(f"/api/spots/{sid}", data={"data": json.dumps({"patrol": None})}).json()["spot"]["patrol"] is None
    # quand il n'en reste qu'un, la patrouille se dissout
    for m in client.get(f"/api/spots/{main['id_spotting']}").json()["patrol"]["members"][1:]:
        client.delete(f"/api/spots/{m['id_spotting']}")
    assert client.get(f"/api/spots/{main['id_spotting']}").json()["patrol"] is None
    assert media_file_exists(img)
    client.delete(f"/api/spots/{main['id_spotting']}")
    assert media_file_exists(img)                                  # l'avion détaché garde la photo
    client.delete(f"/api/spots/{sid}")
    assert media_file_exists(img)                                  # à la corbeille : le fichier reste récupérable
    assert client.delete("/api/trash").status_code == 200          # vidage : la photo n'est plus référencée nulle part
    assert not media_file_exists(img)


def test_trash_restore_and_purge(client):
    from app.services import trash
    tag = client.post("/api/tags", json={"name": "corbeille-test"}).json()
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "F-TRSH1", "aircraft": "Airbus A320", "airport": "LFBO",
                                                            "date": "2026-05-01T10:00", "tags": [tag["name"]]})},
                    files={"image": ("a.jpg", jpeg_bytes((1, 2, 3)), "image/jpeg")}).json()["spot"]
    sid, img = r["id_spotting"], r["image"]
    d = client.delete(f"/api/spots/{sid}").json()
    assert d["trash"] and client.get(f"/api/spots/{sid}").status_code == 404
    assert client.get("/api/spots", params={"registration": "F-TRSH1"}).json()["total"] == 0
    assert any(i["label"].startswith("F-TRSH1") for i in client.get("/api/trash").json()["items"])
    assert media_file_exists(img)
    back = client.post(f"/api/trash/{d['trash']}/restore").json()
    assert back["kind"] == "spot"
    s = client.get(f"/api/spots/{back['id']}").json()
    assert s["registration"] == "F-TRSH1" and s["image"] == img and [t["name"] for t in s["tags"]] == ["corbeille-test"]
    # suppression groupée, puis purge définitive d'une seule entrée
    out = client.post("/api/spots/bulk", json={"ids": [back["id"]], "action": "delete"}).json()
    assert len(out["trash"]) == 1
    assert client.delete(f"/api/trash/{out['trash'][0]}").status_code == 200
    assert not media_file_exists(img)
    # un vol aussi
    f = client.post("/api/flights", json={"date": "2026-05-02", "dep_icao": "LFBO", "arr_icao": "LFPO", "registration": "F-TRSH2"}).json()
    fid = f["flight"]["id_flight"] if "flight" in f else f["id_flight"]
    tf = client.delete(f"/api/flights/{fid}").json()["trash"]
    assert client.get(f"/api/flights/{fid}").status_code == 404
    assert client.post(f"/api/trash/{tf}/restore").json()["kind"] == "flight"
    # corbeille désactivée : suppression immédiate
    client.put("/api/settings", json={"trash_days": 0})
    r2 = client.post("/api/spots", data={"data": json.dumps({"registration": "F-TRSH3", "aircraft": "Airbus A320", "airport": "LFBO",
                                                             "date": "2026-05-03T10:00"})},
                     files={"image": ("a.jpg", jpeg_bytes((9, 8, 7)), "image/jpeg")}).json()["spot"]
    assert client.delete(f"/api/spots/{r2['id_spotting']}").json()["trash"] is None
    assert not media_file_exists(r2["image"])
    client.put("/api/settings", json={"trash_days": 30})
    # purge par ancienneté
    r3 = client.post("/api/spots", data={"data": json.dumps({"registration": "F-TRSH4", "aircraft": "Airbus A320", "airport": "LFBO",
                                                             "date": "2026-05-04T10:00"})}).json()["spot"]
    t3 = client.delete(f"/api/spots/{r3['id_spotting']}").json()["trash"]
    from app.core import execute
    execute("UPDATE trash SET deleted_at = '2000-01-01T00:00:00Z' WHERE id_trash = ?", (t3,))
    assert trash.purge_old() >= 1 and client.post(f"/api/trash/{t3}/restore").status_code == 404


def test_outings_auto_grouping(client):
    def mk(reg, date, airport="LFBO", **kw):
        return client.post("/api/spots", data={"data": json.dumps({"registration": reg, "aircraft": "Airbus A320", "aircraft_icao": "A320",
                                                                   "airport": airport, "date": date, **kw})}).json()["spot"]
    a = mk("F-OUT01", "2031-03-04T09:00"); b = mk("F-OUT02", "2031-03-04T11:30"); c = mk("F-OUT03", "2031-03-05T10:00")
    d = mk("F-OUT04", "2031-03-04T12:00", airport="LFPO")
    assert a["outing_id"] == b["outing_id"] != c["outing_id"] and d["outing_id"] not in (a["outing_id"], c["outing_id"])
    lst = client.get("/api/outings", params={"year": "2031"}).json()
    assert lst["total"] == 3 and lst["items"][0]["day"] == "2031-03-05"
    o = client.get(f"/api/outings/{a['outing_id']}").json()
    assert o["n"] == 2 and o["regs"] == 2 and o["new_regs"] == 2 and [s["registration"] for s in o["spots"]] == ["F-OUT01", "F-OUT02"]
    assert o["next_id"] == d["outing_id"] and o["airport_info"]["icao"] == "LFBO"
    assert client.get("/api/spots", params={"outing": a["outing_id"]}).json()["total"] == 2
    assert client.get(f"/api/spots/{a['id_spotting']}").json()["outing"]["n"] == 2
    # nom et notes
    r = client.put(f"/api/outings/{a['outing_id']}", json={"name": "Journée test", "notes": "beau temps"}).json()
    assert r["name"] == "Journée test" and r["notes"] == "beau temps"
    # déplacer un spot de jour : il change de sortie, l'ancienne se vide et disparaît
    client.put(f"/api/spots/{c['id_spotting']}", data={"data": json.dumps({"date": "2031-03-04T15:00"})})
    assert client.get(f"/api/spots/{c['id_spotting']}").json()["outing_id"] == a["outing_id"]
    assert client.get("/api/outings", params={"year": "2031"}).json()["total"] == 2
    # corbeille puis restauration : le spot retrouve sa sortie
    tid = client.delete(f"/api/spots/{b['id_spotting']}").json()["trash"]
    assert client.get(f"/api/outings/{a['outing_id']}").json()["n"] == 2
    new = client.post(f"/api/trash/{tid}/restore").json()["id"]
    assert client.get(f"/api/spots/{new}").json()["outing_id"] == a["outing_id"]


def test_heic_upload_and_preview(client):
    import pillow_heif
    pillow_heif.register_heif_opener()
    im = Image.new("RGB", (800, 600), (30, 90, 160))
    ex = Image.Exif(); ex[0x010F] = "Apple"; ex[0x0110] = "iPhone 15"; ex[0x0112] = 6
    buf = io.BytesIO(); im.save(buf, "HEIF", exif=ex.tobytes())
    a = client.post("/api/media/analyze", files={"image": ("IMG_1.HEIC", buf.getvalue(), "image/heic")}, params={"ocr": False}).json()
    assert a["exif"]["camera"] == "Apple iPhone 15"
    pv = client.post("/api/media/preview", files={"image": ("IMG_1.HEIC", buf.getvalue(), "image/heic")})
    assert pv.status_code == 200 and pv.headers["content-type"] == "image/jpeg" and Image.open(io.BytesIO(pv.content)).size == (600, 800)
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "F-HEIC1", "aircraft": "Airbus A320", "airport": "LFBO",
                                                            "date": "2026-05-05T10:00"})},
                    files={"image": ("IMG_1.HEIC", buf.getvalue(), "image/heic")}).json()["spot"]
    assert r["image"].endswith(".webp") and (r["image_w"], r["image_h"]) == (600, 800) and r["camera"] == "Apple iPhone 15"


def media_file_exists(rel):
    from app.services.media import DIRS
    return (DIRS["images"] / rel).is_file()


def test_patrol_import_export_roundtrip(client):
    csv_data = ("registration,airport,place,date,patrol\n"
                "F-ZPA1,,Plage de Biscarrosse,2026-08-01T15:00,Patrouille Test\n"
                "F-ZPA2,,Plage de Biscarrosse,2026-08-01T15:00,Patrouille Test\n"
                "F-ZPA3,,Plage de Biscarrosse,2026-08-02T15:00,Patrouille Test\n").encode()
    prev = client.post("/api/import/preview", files={"file": ("p.csv", csv_data, "text/csv")}, data={"kind": "spots"}).json()
    res = client.post("/api/import/commit", data={"token": prev["token"], "kind": "spots", "mapping": json.dumps(prev["mapping"])}).json()
    assert res["imported"] == 3, res
    a, b, c = (client.get("/api/spots", params={"registration": r}).json()["items"][0] for r in ("F-ZPA1", "F-ZPA2", "F-ZPA3"))
    assert a["place"] == "Plage de Biscarrosse" and a["patrol_id"] == b["patrol_id"] != c["patrol_id"]     # une patrouille par jour
    out = client.get("/api/export/spots.csv").text
    assert "patrol" in out.splitlines()[0] and "Patrouille Test" in out and "Plage de Biscarrosse" in out


def test_simple_patrol_is_one_spot(client):
    def post(d):
        return client.post("/api/spots", data={"data": json.dumps(d)}, files={"image": ("p.jpg", jpeg_bytes((200, 30, 30)), "image/jpeg")})
    assert client.get("/api/settings").json()["patrol_mode"] == "simple"          # mode par défaut
    assert post({"patrol": {"simple": True, "name": " "}, "aircraft": "Alpha Jet"}).status_code == 422
    base = client.get("/api/stats").json()["totals"]
    r = post({"aircraft": "Dassault Alpha Jet", "aircraft_icao": "ALPH", "airport": "LFBO", "date": "2026-09-01T10:00",
              "patrol": {"simple": True, "name": "Patrouille de France", "size": 8}})
    assert r.status_code == 200, r.text
    s = r.json()["spot"]
    assert s["registration"] == "PATROUILLE-DE-FRANCE" and s["is_patrol"] == 1 and s["patrol_size"] == 8 and s["country"] is None
    assert s["patrol_name"] == "Patrouille de France" and s["patrol"] is None
    t = client.get("/api/stats").json()["totals"]
    assert t["spots"] == base["spots"] + 1 and t["registrations"] == base["registrations"] + 1       # un spot, un « avion »
    # même patrouille un autre jour : même clé, deux spots, toujours un seul « avion »
    s2 = post({"airport": "LFBO", "date": "2026-09-02T10:00", "patrol": {"simple": True, "name": "patrouille de france"}}).json()["spot"]
    assert s2["registration"] == s["registration"]
    assert client.get("/api/stats").json()["totals"]["registrations"] == base["registrations"] + 1
    assert post({"airport": "LFBO", "date": "2026-09-02T12:00", "patrol": {"simple": True, "name": "Patrouille de France"}}).status_code == 409
    # renommer et changer l'effectif
    up = client.put(f"/api/spots/{s['id_spotting']}", data={"data": json.dumps({"registration": "x", "patrol": {"name": "PAF", "size": 7}})}).json()["spot"]
    assert up["registration"] == "PAF" and up["patrol_size"] == 7 and up["patrol_name"] == "PAF" and up["is_patrol"] == 1
    # supprimer garde la patrouille propre : plus aucune ligne orpheline
    client.delete(f"/api/spots/{s['id_spotting']}")
    client.delete(f"/api/spots/{s2['id_spotting']}")
    from app.core import q as _q
    assert not _q("SELECT 1 FROM patrols p WHERE NOT EXISTS (SELECT 1 FROM spotting s WHERE s.patrol_id = p.id_patrol)")


def test_search_follows_airframe_group_and_sites_facet(client):
    def post(d):
        return client.post("/api/spots", data={"data": json.dumps(d)})
    post({"registration": "F-WZZA", "msn": "7001", "manufacturer": "Airbus", "aircraft": "Airbus A320", "airport": "LFBO", "date": "2026-10-01T10:00"})
    post({"registration": "D-AZZA", "msn": "7001", "manufacturer": "Airbus", "aircraft": "Airbus A320", "airport": "EDDM", "date": "2026-10-05T10:00"})
    old = client.get("/api/spots", params={"search": "F-WZZA"}).json()["items"]
    assert {i["registration"] for i in old} == {"F-WZZA", "D-AZZA"}              # l'ancienne immat ramène le nouvel avion
    g = client.get("/api/search", params={"q": "F-WZZA"}).json()
    assert {s["registration"] for s in g["spots"]} >= {"F-WZZA", "D-AZZA"} and {a["registration"] for a in g["airframes"]} >= {"F-WZZA", "D-AZZA"}
    sites = client.get("/api/spots/facets").json()["sites"]
    assert {"kind": "airport", "value": "EDDM"}.items() <= next(x for x in sites if x["value"] == "EDDM").items()
    assert sites[0]["last"] >= sites[-1]["last"] and all(x["n"] >= 1 for x in sites)


def test_patrol_country_and_unknown_filter(client):
    def post(d):
        return client.post("/api/spots", data={"data": json.dumps(d)})
    s = post({"airport": "LFBO", "date": "2026-10-10T10:00", "patrol": {"simple": True, "name": "Breitling Jet Team", "country": "fr"}}).json()["spot"]
    assert s["country"] == "FR"
    assert client.get("/api/spots/patrol-countries").json()["breitling jet team"] == "FR"
    assert "FR" in client.get("/api/spots/countries").json()
    up = client.put(f"/api/spots/{s['id_spotting']}", data={"data": json.dumps({"patrol": {"name": "Breitling Jet Team", "country": "ch"}})}).json()["spot"]
    assert up["country"] == "CH"
    up = client.put(f"/api/spots/{s['id_spotting']}", data={"data": json.dumps({"description": "x"})}).json()["spot"]
    assert up["country"] == "CH"                                   # modifier autre chose ne touche pas la nationalité
    u = post({"unknown_registration": True, "aircraft": "Rafale", "airport": "LFBO", "date": "2026-10-11T10:00"}).json()["spot"]
    got = client.get("/api/spots", params={"unknown": True, "limit": 500}).json()["items"]
    assert u["id_spotting"] in {i["id_spotting"] for i in got} and all(i["registration"].startswith("SANS-IMMAT-") for i in got)


def test_rarity_badge_and_filter(client, monkeypatch):
    from app.services import collection, refdb
    monkeypatch.setattr(refdb, "type_counts", lambda: {"A388": 12, "A320": 40000})
    assert [collection.rarity_tier(n) for n in (12, 100, 1000, 9000, 40000)] == ["legendary", "epic", "rare", "uncommon", "common"]
    client.post("/api/spots", data={"data": json.dumps({"registration": "F-HRAR", "aircraft_icao": "A388", "airport": "LFPG"})})
    client.post("/api/spots", data={"data": json.dumps({"registration": "F-HCOM", "aircraft_icao": "A320", "airport": "LFPG"})})
    got = client.get("/api/spots?rare=1").json()
    regs = [s["registration"] for s in got["items"]]
    assert "F-HRAR" in regs and "F-HCOM" not in regs
    mine = next(s for s in got["items"] if s["registration"] == "F-HRAR")
    assert any(b["code"] == "rarity" and b["tier"] == "legendary" for b in mine["badges"])
    com = client.get("/api/spots?rarity=common").json()["items"]
    assert any(x["registration"] == "F-HCOM" for x in com) and all(x["registration"] != "F-HRAR" for x in com)
    assert any(b["code"] == "rarity" and b["tier"] == "common" for b in next(x for x in com if x["registration"] == "F-HCOM")["badges"])


def test_photo_export_has_iptc_and_xmp(client):
    import io as _io
    from PIL import Image
    buf = _io.BytesIO()
    Image.new("RGB", (64, 48), (30, 90, 200)).save(buf, "JPEG")
    client.put("/api/settings", json={"photographer": "Jean"})
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "F-HEXP", "aircraft": "Airbus A320", "aircraft_icao": "A320",
                                                          "owner": "Air France", "airport": "LFBO", "date": "2026-05-01T10:30"})},
                    files={"image": ("a.jpg", buf.getvalue(), "image/jpeg")})
    sid = r.json()["spot"]["id_spotting"]
    out = client.get(f"/api/export/spots/{sid}/photo.jpg")
    assert out.status_code == 200 and out.content[:2] == b"\xff\xd8"
    assert b"http://ns.adobe.com/xap/1.0/" in out.content and b"Photoshop 3.0" in out.content
    assert b"F-HEXP" in out.content and b"Jean" in out.content and b"LFBO" in out.content
    Image.open(_io.BytesIO(out.content)).verify()
    z = client.get(f"/api/export/photos.zip?ids={sid}")
    assert z.status_code == 200 and z.content[:2] == b"PK"


def test_watchlist_falls_back_to_free_hex_lookup(client, monkeypatch):
    import httpx
    from app.services import opensky
    seen = []

    def handler(req):
        seen.append(str(req.url))
        if "opensky" in req.url.host:
            return httpx.Response(429)
        return httpx.Response(200, json={"ac": [{"hex": "39bd85", "lat": 43.6, "lon": 1.4, "alt_baro": 12000, "gs": 400, "track": 90, "flight": "AFR123 "}]})
    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: orig(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    monkeypatch.setattr(opensky, "_throttle", lambda name: None)
    opensky._src_off.clear()
    out = opensky._free_by_hex(["39bd85"])
    assert out["39bd85"]["callsign"] == "AFR123" and out["39bd85"]["on_ground"] is False
    assert any("/hex/39bd85" in u for u in seen)


def test_airshow_merge_plan_and_program(client):
    def spot(reg, typ, day, ap="LFPO"):
        r = client.post("/api/spots", data={"data": json.dumps({"registration": reg, "aircraft_icao": typ, "airport": ap, "date": f"{day}T10:00"})})
        assert r.status_code in (200, 201), r.text
    for reg, typ, day in (("F-HMA1", "A320", "2041-06-06"), ("F-HMA2", "A321", "2041-06-07"), ("F-HMA3", "A320", "2041-06-08")):
        spot(reg, typ, day)
    outs = [o for o in client.get("/api/outings?year=2041").json()["items"]]
    assert len(outs) == 3
    other = client.post("/api/spots", data={"data": json.dumps({"registration": "F-HMB1", "aircraft_icao": "A320", "airport": "LFBO", "date": "2041-06-07T10:00"})})
    assert other.status_code in (200, 201)
    ids = [o["id"] for o in outs if o["airport"] == "LFPO"]
    bad = client.post("/api/outings/merge", json={"ids": [ids[0], next(o["id"] for o in client.get("/api/outings?year=2041").json()["items"] if o["airport"] == "LFBO")]})
    assert bad.status_code == 422 and "different_sites" in bad.text
    ok = client.post("/api/outings/merge", json={"ids": ids, "name": "Meeting test", "kind": "airshow"})
    assert ok.status_code == 200
    mid = ok.json()["id"]
    d = client.get(f"/api/outings/{mid}").json()
    assert d["day"] == "2041-06-06" and d["end_day"] == "2041-06-08" and d["n"] == 3 and len(d["days"]) == 3 and d["kind"] == "airshow"
    # un nouveau spot sur un jour couvert rejoint la sortie fusionnée
    spot("F-HMA4", "A320", "2041-06-07")
    assert client.get(f"/api/outings/{mid}").json()["n"] == 4
    # programme : détection du type et de l'immatriculation, vu automatiquement
    assert client.post(f"/api/outings/{mid}/items", json={"label": "A321"}).json()["match_kind"] == "type"
    assert client.post(f"/api/outings/{mid}/items", json={"label": "F-HMA3"}).json()["match_kind"] == "registration"
    assert client.post(f"/api/outings/{mid}/items", json={"label": "Patrouille de France"}).json()["match_kind"] == "free"
    items = client.get(f"/api/outings/{mid}").json()["items"]
    assert [i["seen"] for i in items] == [True, True, False]
    client.put(f"/api/outings/items/{items[2]['id']}", json={"done": True})
    assert client.get(f"/api/outings/{mid}").json()["items"][2]["seen"] is True
    # séparation
    assert client.post(f"/api/outings/{mid}/split").status_code == 200
    assert len([o for o in client.get("/api/outings?year=2041").json()["items"] if o["airport"] == "LFPO"]) == 3
    # planification : un meeting à venir sur 3 jours absorbe les sorties existantes du site
    pl = client.post("/api/outings", json={"day": "2041-06-06", "end_day": "2041-06-08", "airport": "LFPO", "name": "Meeting planifié"}).json()["id"]
    p = client.get(f"/api/outings/{pl}").json()
    assert p["n"] == 4 and p["kind"] == "airshow" and p["end_day"] == "2041-06-08"
    future = client.post("/api/outings", json={"day": "2042-05-01", "end_day": "2042-05-02", "place": "Cerny"}).json()["id"]
    f = client.get(f"/api/outings/{future}").json()
    assert f["n"] == 0 and len(f["days"]) == 2
    assert client.delete(f"/api/outings/{future}").status_code == 200


def test_daytime_weather_wind_filters(client):
    from app.core import db
    ids = {}
    for reg, el in (("F-HDAY", 30), ("F-HGLD", 2), ("F-HDWN", -8), ("F-HNGT", -20)):
        r = client.post("/api/spots", data={"data": json.dumps({"registration": reg, "aircraft_icao": "A320", "airport": "LFBO", "date": "2043-03-01T07:00"})})
        sid = r.json()["spot"]["id_spotting"]
        ids[reg] = sid
        conn = db()
        conn.execute("UPDATE spotting SET sun_elevation = ? WHERE id_spotting = ?", (el, sid))
        conn.commit()
    conn = db()
    conn.execute("UPDATE spotting SET metar_json = ? WHERE id_spotting = ?", (json.dumps({"summary": "rain", "wind_kt": 22}), ids["F-HDAY"]))
    conn.execute("UPDATE spotting SET metar_json = ? WHERE id_spotting = ?", (json.dumps({"summary": "clear", "wind_kt": 3}), ids["F-HGLD"]))
    conn.commit()
    regs = lambda qs: {s["registration"] for s in client.get(f"/api/spots?year=2043&{qs}").json()["items"]}
    assert regs("daytime=day") == {"F-HDAY"} and regs("daytime=golden") == {"F-HGLD"}
    assert regs("daytime=dawn") == {"F-HDWN"} and regs("daytime=dusk") == set() and regs("daytime=night") == {"F-HNGT"}
    assert regs("weather=rain") == {"F-HDAY"} and regs("weather=clear") == {"F-HGLD"} and regs("weather=none") == {"F-HDWN", "F-HNGT"}
    assert regs("wind=strong") == {"F-HDAY"} and regs("wind=calm") == {"F-HGLD"}


def test_extra_aircraft_on_same_photo_do_not_inherit_identity(client):
    import io as _io
    from PIL import Image
    buf = _io.BytesIO(); Image.new("RGB", (64, 48), (200, 90, 30)).save(buf, "JPEG")
    data = {"registration": "F-HMU1", "aircraft": "Airbus A320", "aircraft_icao": "A320", "owner": "Air France", "airport": "LFBO", "date": "2044-02-02T10:00",
            "patrol": {"members": [{"registration": "F-HMU2", "inherit_aircraft": False, "aircraft_icao": "B738", "owner": "Ryanair"},
                                   {"registration": "F-HMU3", "inherit_aircraft": True}]}}
    r = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("a.jpg", buf.getvalue(), "image/jpeg")})
    assert r.status_code in (200, 201), r.text
    got = {s["registration"]: s for s in client.get("/api/spots?year=2044").json()["items"]}
    assert set(got) == {"F-HMU1", "F-HMU2", "F-HMU3"}
    assert got["F-HMU2"]["aircraft_icao"] == "B738" and got["F-HMU2"]["owner"] == "Ryanair"
    assert got["F-HMU3"]["aircraft_icao"] == "A320"
    assert len({s["thumb"] for s in got.values()}) == 1                 # une seule photo partagée


def test_editing_common_info_updates_other_aircraft_of_the_photo(client):
    import io as _io
    from PIL import Image
    buf = _io.BytesIO(); Image.new("RGB", (64, 48), (10, 120, 30)).save(buf, "JPEG")
    data = {"registration": "F-HSY1", "aircraft_icao": "A320", "airport": "LFBO", "date": "2045-02-02T10:00",
            "patrol": {"members": [{"registration": "F-HSY2", "inherit_aircraft": False, "aircraft_icao": "B738"}]}}
    r = client.post("/api/spots", data={"data": json.dumps(data)}, files={"image": ("a.jpg", buf.getvalue(), "image/jpeg")})
    assert r.status_code in (200, 201), r.text
    by = lambda: {s["registration"]: s for s in client.get("/api/spots?year=2045").json()["items"]}
    first = by()["F-HSY1"]
    edit = {"date": "2045-02-03T09:30", "airport": "LFPG", "description": "Deux avions", "rating": 4, "tags": []}
    up = client.put(f"/api/spots/{first['id_spotting']}", data={"data": json.dumps(edit)})
    assert up.status_code == 200, up.text
    sec = client.get(f"/api/spots/{by()['F-HSY2']['id_spotting']}").json()
    assert sec["airport"] == "LFPG" and sec["date"].startswith("2045-02-03T09:30") and sec["description"] == "Deux avions" and sec["rating"] == 4
    assert sec["aircraft_icao"] == "B738" and sec["registration"] == "F-HSY2"      # l'identité de l'avion ne bouge pas
    assert sec["outing"]["day"] == "2045-02-03"


def test_country_from_operator_for_military_serial(client):
    from app.services import registration as regs
    assert regs.country_of("QA400") is None
    assert regs.country_for("QA400", "Qatar Emiri Air Force") == "QA"
    assert regs.country_for("31+05", "Luftwaffe") == "DE"
    assert regs.country_for("F-GXLN", "Airbus") == regs.country_of("F-GXLN") == "FR"
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "QA400", "owner": "Qatar Emiri Air Force", "date": "2046-03-04"})})
    assert r.status_code in (200, 201), r.text
    sid = r.json()["spot"]["id_spotting"]
    assert client.get(f"/api/spots/{sid}").json()["country"] == "QA"
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "ZZ9901", "date": "2046-03-05"})})
    sid2 = r.json()["spot"]["id_spotting"]
    assert client.get(f"/api/spots/{sid2}").json()["country"] in (None, "")
    client.put(f"/api/spots/{sid2}", data={"data": json.dumps({"owner": "Armée de l'Air"})})
    assert client.get(f"/api/spots/{sid2}").json()["country"] == "FR"


def test_manual_country_override(client):
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "ZZ9902", "date": "2046-04-01"})})
    sid = r.json()["spot"]["id_spotting"]
    assert not client.get(f"/api/spots/{sid}").json()["country"]
    put = lambda d: client.put(f"/api/spots/{sid}", data={"data": json.dumps(d)})
    assert put({"registration": "ZZ9902", "country": "qa"}).status_code == 200
    assert client.get(f"/api/spots/{sid}").json()["country"] == "QA"
    # une modification ultérieure sans toucher au pays le conserve
    put({"registration": "ZZ9902", "owner": "Quelqu'un"})
    assert client.get(f"/api/spots/{sid}").json()["country"] == "QA"
    # « Auto » relance la détection
    put({"registration": "F-ZZZZ", "country": ""})
    assert client.get(f"/api/spots/{sid}").json()["country"] == "FR"
    assert put({"country": "france"}).status_code == 422


def test_heliports_and_small_fields(client):
    from app.services import geo
    a = geo.airport("LF3624")                      # code SIA d'un terrain absent d'airportsdata
    assert a and a["icao"] == "LF3624" and a["kind"] == "airfield" and a["tz"] == "Europe/Paris"
    assert geo.airport("FR-0001")["kind"] == "heliport"
    assert [x["icao"] for x in client.get("/api/airports/search", params={"q": "LF362"}).json()][:1] == ["LF3623"]
    assert client.get("/api/airports/LF3624").json()["name"].startswith("Grange Dieu")
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "F-ZHEL", "date": "2047-05-01", "airport": "LF3624"})})
    assert client.get(f"/api/spots/{r.json()['spot']['id_spotting']}").json()["airport"] == "LF3624"
    # code inconnu de toute base (LF999) : conservé comme terrain, pas rangé en « lieu »
    r = client.post("/api/spots", data={"data": json.dumps({"registration": "F-ZHE2", "date": "2047-05-02", "airport": "LF999"})})
    d = client.get(f"/api/spots/{r.json()['spot']['id_spotting']}").json()
    assert d["airport"] == "LF999" and not d.get("place")
    assert geo.airport("LFBO")["name"] and geo.airport("TLS")["icao"] == "LFBO"



def test_custom_airfield(client):
    from app.services import geo
    assert geo.airport("ZZHEL1") is None
    body = {"code": "zzhel1", "name": "Hôpital Test", "kind": "heliport", "city": "Toulouse", "country": "FR", "lat": 43.6, "lng": 1.4}
    r = client.post("/api/airport-pages", json=body)
    assert r.status_code == 200, r.text
    assert client.post("/api/airport-pages", json=body).status_code == 409
    assert client.post("/api/airport-pages", json={**body, "code": "a"}).status_code == 422
    a = geo.airport("ZZHEL1")
    assert a["kind"] == "heliport" and a["custom"] and a["tz"] == "Europe/Paris"
    items = client.get("/api/airport-pages").json()["items"]
    row = next(i for i in items if i["icao"] == "ZZHEL1")      # visible dans la liste sans aucun spot
    assert row["n"] == 0 and row["custom"] and row["lat"] == 43.6
    assert client.get("/api/airports/search", params={"q": "hôpital test"}).json()[0]["icao"] == "ZZHEL1"
    s = client.post("/api/spots", data={"data": json.dumps({"registration": "F-ZHE4", "date": "2047-08-01", "airport": "ZZHEL1"})})
    assert client.get(f"/api/spots/{s.json()['spot']['id_spotting']}").json()["airport"] == "ZZHEL1"
    assert client.get("/api/airport-pages").json()["items"][0]["icao"] != "x"
    assert client.put("/api/airport-pages/custom/ZZHEL1", json={**body, "name": "Autre nom"}).json()["name"] == "Autre nom"
    assert client.delete("/api/airport-pages/custom/ZZHEL1").status_code == 200
    assert geo.airport("ZZHEL1") is None


def test_fleet_overrides_correct_rarity(client):
    from app.services import refdb
    base = refdb.type_counts()
    assert base["A337"] == 6 and base["RFAL"] >= 250          # table d'effectifs corrigés, même sans base de référence
    r = client.put("/api/settings", json={"fleet_overrides": {"zz9z": 7}})
    assert r.status_code == 200
    assert refdb.type_counts()["ZZ9Z"] == 7
    client.put("/api/settings", json={"fleet_overrides": {"A337": 5}})
    assert refdb.type_counts()["A337"] == 5                   # ta valeur l'emporte sur la table
    client.put("/api/settings", json={"fleet_overrides": {}})
    assert refdb.type_counts()["A337"] == 6
    assert "items" in client.get("/api/refdb/fleet").json()


def test_special_variants_are_new_models(client):
    from app.services import actypes
    mk = actypes.model_key
    assert mk("A332", "Airbus A330-200 MRTT", 1) == "MRTT" != mk("A332", "Airbus A330-200", 0) == "A332"
    assert mk("A332", "Airbus A330-200", 1) == "A332/MIL"                    # A330 sous cocarde militaire : autre appareil
    assert mk("B744", "Boeing 747-400 Dreamlifter", 0) == "LCF"
    assert mk("RFAL", "Rafale B", 1) == "RFAL" and mk("K35T", None, 1) == mk("K35R", None, 1)
    assert mk("A3ST") != mk("A337") and mk(None, "Airbus A330-243") == "A332"
    make = lambda i, **d: client.post("/api/spots", data={"data": json.dumps({"date": "2048-01-0%d" % i, **d})}).json()["spot"]
    a = make(1, registration="F-ZMA1", aircraft_icao="A332", aircraft="Airbus A330-200", military=False)
    b = make(2, registration="F-ZMA2", aircraft_icao="A332", aircraft="Airbus A330-200 MRTT", military=True)
    c = make(3, registration="F-ZMA3", aircraft_icao="A332", aircraft="Airbus A330-200", military=False)
    badges = lambda s: [x["code"] for x in client.get(f"/api/spots/{s['id_spotting']}").json().get("badges", [])]
    assert "first_type" in badges(a)
    assert "first_type" in badges(b)                    # premier MRTT : nouveau modèle malgré l'A330-200 déjà vu
    assert "first_type" not in badges(c)
    ids = {s["id_spotting"] for s in client.get("/api/spots", params={"type": "MRTT", "year": 2048}).json()["items"]}
    assert ids == {b["id_spotting"]}


def test_multi_tag_filter(client):
    mk = lambda reg, tags: client.post("/api/spots", data={"data": json.dumps({"registration": reg, "date": "2049-02-01", "tags": tags})}).json()["spot"]["id_spotting"]
    a, b, c = mk("F-ZTG1", ["zt-alpha", "zt-beta"]), mk("F-ZTG2", ["zt-alpha"]), mk("F-ZTG3", ["zt-beta"])
    ids = {t["name"]: t["id_tag"] for t in client.get("/api/tags").json()}
    both = f"{ids['zt-alpha']},{ids['zt-beta']}"
    get = lambda **p: {s["id_spotting"] for s in client.get("/api/spots", params={"year": 2049, **p}).json()["items"]}
    assert get(tag=str(ids["zt-alpha"])) == {a, b}
    assert get(tag=both) == {a}                                  # toutes les étiquettes
    assert get(tag=both, tag_mode="any") == {a, b, c}            # au moins une
    assert client.get("/api/spots/map", params={"tag": both}).status_code == 200


def test_aircraft_joins_simple_patrol_by_name(client):
    post = lambda d: client.post("/api/spots", data={"data": json.dumps({"date": "2050-03-01", **d})}).json()["spot"]
    put = lambda i, d: client.put(f"/api/spots/{i}", data={"data": json.dumps(d)}).json()["spot"]
    simple = post({"patrol": {"simple": True, "name": "Équipe Zéphyr", "size": 7}})
    assert simple["is_patrol"] and simple["patrol_id"]
    # avion identifié après coup, avec le même nom de groupe (casse et accents ignorés)
    a = post({"registration": "F-ZPA1", "patrol": {"name": "equipe zephyr", "members": []}})
    assert a["patrol_id"] == simple["patrol_id"]
    b = post({"registration": "F-ZPB1", "date": "2050-03-09", "patrol": {"name": "Équipe Zéphyr", "members": [{"registration": "F-ZPB2"}]}})
    assert b["patrol_id"] == simple["patrol_id"]
    ids = {s["id_spotting"] for s in client.get("/api/spots", params={"patrol": simple["patrol_id"]}).json()["items"]}
    assert {simple["id_spotting"], a["id_spotting"], b["id_spotting"]} <= ids and len(ids) == 4
    # une modification sur un avion ne réécrit pas les autres photos de la patrouille
    put(a["id_spotting"], {"date": "2050-04-01", "description": "autre jour"})
    assert client.get(f"/api/spots/{b['id_spotting']}").json()["date"].startswith("2050-03-09")
    # la patrouille simple liste ses avions identifiés ; l'index indique où l'avion sera rattaché
    detail = client.get(f"/api/spots/{simple['id_spotting']}").json()
    assert {m["registration"] for m in detail["patrol_members"]} >= {"F-ZPA1", "F-ZPB1", "F-ZPB2"}
    idx = {p["name"]: p for p in client.get("/api/spots/patrol-index").json()}
    assert idx["Équipe Zéphyr"]["simple"] == 1 and idx["Équipe Zéphyr"]["n"] == 4
