"""METAR / TAF historiques et décodage METAR.

Sources : aviationweather.gov (historique ~15 jours) puis l'archive de l'Iowa
Environmental Mesonet (IEM) pour les dates plus anciennes.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx

from ..core import execute, q1
from .aircraft import client

log = logging.getLogger("contrail.weather")


def _parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _awc_metar(icao: str, when: datetime, c: httpx.Client) -> list[tuple[datetime, str]]:
    r = c.get("https://aviationweather.gov/api/data/metar", params={
        "ids": icao, "format": "json", "hours": 3,
        "date": (when + timedelta(hours=1)).strftime("%Y%m%d_%H%M") + "Z",
    })
    if r.status_code != 200 or not r.text.strip():
        return []
    out = []
    for m in r.json() or []:
        raw = m.get("rawOb")
        ts = m.get("obsTime") or m.get("reportTime")
        if raw and ts:
            try:
                dt = datetime.fromtimestamp(ts, timezone.utc) if isinstance(ts, (int, float)) else _parse_utc(str(ts))
                out.append((dt, raw))
            except ValueError:
                continue
    return out


def _iem_metar(icao: str, when: datetime, c: httpx.Client) -> list[tuple[datetime, str]]:
    a, b = when - timedelta(hours=2), when + timedelta(hours=2)
    params = [
        ("station", icao), ("data", "metar"), ("tz", "Etc/UTC"), ("format", "onlycomma"),
        ("latlon", "no"), ("missing", "M"), ("direct", "no"), ("report_type", "3"), ("report_type", "4"),
        ("year1", a.year), ("month1", a.month), ("day1", a.day), ("hour1", a.hour), ("minute1", a.minute),
        ("year2", b.year), ("month2", b.month), ("day2", b.day), ("hour2", b.hour), ("minute2", b.minute),
    ]
    r = c.get("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", params=params)
    if r.status_code != 200:
        return []
    out = []
    for row in csv.DictReader(io.StringIO(r.text)):
        raw, valid = row.get("metar"), row.get("valid")
        if raw and valid and raw != "M":
            try:
                out.append((datetime.strptime(valid, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc), raw))
            except ValueError:
                continue
    return out


def _awc_taf(icao: str, when: datetime, c: httpx.Client) -> str | None:
    r = c.get("https://aviationweather.gov/api/data/taf", params={
        "ids": icao, "format": "json", "date": when.strftime("%Y%m%d_%H%M") + "Z",
    })
    if r.status_code != 200 or not r.text.strip():
        return None
    data = r.json() or []
    return data[0].get("rawTAF") if data else None


def fetch_historical(icao: str, utc_iso: str) -> dict:
    when = _parse_utc(utc_iso)
    age = datetime.now(timezone.utc) - when
    obs: list[tuple[datetime, str]] = []
    taf = None
    with client() as c:
        if age < timedelta(days=14):
            try:
                obs = _awc_metar(icao, when, c)
            except (httpx.HTTPError, ValueError) as e:
                log.info("AWC METAR: %s", e)
            try:
                taf = _awc_taf(icao, when, c)
            except (httpx.HTTPError, ValueError) as e:
                log.info("AWC TAF: %s", e)
        if not obs:
            try:
                obs = _iem_metar(icao, when, c)
            except (httpx.HTTPError, ValueError) as e:
                log.info("IEM METAR: %s", e)
    if not obs:
        return {"metar": None, "taf": taf}
    # METAR le plus proche, en privilégiant ceux émis avant l'heure du spot
    best = min(obs, key=lambda o: abs((o[0] - when).total_seconds()) + (0 if o[0] <= when else 600))
    return {"metar": best[1].strip(), "taf": taf, "observed": best[0].strftime("%Y-%m-%dT%H:%M:%SZ")}


def update_spot_weather(spot_id: int) -> None:
    """Tâche de fond : associe METAR/TAF à un spot."""
    s = q1("SELECT id_spotting, airport, date_utc FROM spotting WHERE id_spotting = ?", (spot_id,))
    if not s or not s["airport"] or not s["date_utc"]:
        execute("UPDATE spotting SET weather_status='none' WHERE id_spotting=?", (spot_id,))
        return
    try:
        res = fetch_historical(s["airport"], s["date_utc"])
    except Exception as e:  # noqa: BLE001
        log.warning("Météo indisponible pour le spot %s : %s", spot_id, e)
        execute("UPDATE spotting SET weather_status='error' WHERE id_spotting=?", (spot_id,))
        return
    if res.get("metar"):
        decoded = decode_metar(res["metar"])
        decoded["observed"] = res.get("observed")
        execute("UPDATE spotting SET metar=?, metar_json=?, taf=?, weather_status='ok' WHERE id_spotting=?",
                (res["metar"], json.dumps(decoded), res.get("taf"), spot_id))
    else:
        execute("UPDATE spotting SET taf=?, weather_status='none' WHERE id_spotting=?", (res.get("taf"), spot_id))


# --------------------------------------------------------------------------- #
# Décodeur METAR
# --------------------------------------------------------------------------- #
WX_CODES = {
    "MI": "shallow", "BC": "patches", "PR": "partial", "DR": "drifting", "BL": "blowing",
    "SH": "showers", "TS": "thunderstorm", "FZ": "freezing", "DZ": "drizzle", "RA": "rain",
    "SN": "snow", "SG": "snow_grains", "IC": "ice_crystals", "PL": "ice_pellets", "GR": "hail",
    "GS": "small_hail", "UP": "unknown_precip", "BR": "mist", "FG": "fog", "FU": "smoke",
    "VA": "volcanic_ash", "DU": "dust", "SA": "sand", "HZ": "haze", "PO": "dust_whirls",
    "SQ": "squalls", "FC": "funnel_cloud", "SS": "sandstorm", "DS": "duststorm", "VC": "vicinity",
}
_RE_WIND = re.compile(r"^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$")
_RE_VIS = re.compile(r"^(\d{4})(NDV)?$")
_RE_VIS_SM = re.compile(r"^(M)?(\d+)?(?:\s?(\d)/(\d))?SM$")
_RE_CLOUD = re.compile(r"^(FEW|SCT|BKN|OVC|VV)(\d{3}|///)(CB|TCU)?$")
_RE_TEMP = re.compile(r"^(M?\d{2})/(M?\d{2})?$")
_RE_QNH = re.compile(r"^(Q|A)(\d{4})$")
_RE_WX = re.compile(r"^(\+|-|VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+|TS)$")


def _t(v: str) -> int:
    return -int(v[1:]) if v.startswith("M") else int(v)


def decode_metar(raw: str) -> dict:
    out: dict = {"raw": raw, "clouds": [], "weather": []}
    parts = raw.replace("=", "").split()
    if parts and parts[0] in ("METAR", "SPECI"):
        parts = parts[1:]
    if parts:
        out["station"] = parts[0]
    for p in parts[1:]:
        if p in ("RMK", "TEMPO", "BECMG", "NOSIG"):
            if p != "NOSIG":
                break
            continue
        if p == "CAVOK":
            out["cavok"] = True
            out["visibility_m"] = 10000
            continue
        if m := _RE_WIND.match(p):
            unit = m.group(4)
            factor = 1.94384 if unit == "MPS" else (0.539957 if unit == "KMH" else 1)
            out["wind_dir"] = None if m.group(1) == "VRB" else int(m.group(1))
            out["wind_kt"] = round(int(m.group(2)) * factor)
            if m.group(3):
                out["gust_kt"] = round(int(m.group(3)) * factor)
            continue
        if re.match(r"^\d{3}V\d{3}$", p):
            out["wind_variable"] = p
            continue
        if "visibility_m" not in out and (m := _RE_VIS.match(p)):
            out["visibility_m"] = int(m.group(1))
            continue
        if "visibility_m" not in out and (m := _RE_VIS_SM.match(p)):
            miles = float(m.group(2) or 0)
            if m.group(3):
                miles += int(m.group(3)) / int(m.group(4))
            out["visibility_m"] = int(miles * 1609)
            continue
        if m := _RE_CLOUD.match(p):
            h = m.group(2)
            out["clouds"].append({"cover": m.group(1), "ft": int(h) * 100 if h.isdigit() else None,
                                  "type": m.group(3)})
            continue
        if p in ("NSC", "SKC", "CLR", "NCD"):
            out["clouds_none"] = True
            continue
        if m := _RE_TEMP.match(p):
            out["temp_c"] = _t(m.group(1))
            if m.group(2):
                out["dew_c"] = _t(m.group(2))
            continue
        if m := _RE_QNH.match(p):
            v = int(m.group(2))
            out["qnh_hpa"] = v if m.group(1) == "Q" else round(v / 100 * 33.8639)
            continue
        if m := _RE_WX.match(p):
            intensity = {"+": "heavy", "-": "light", "VC": "vicinity"}.get(m.group(1) or "", "")
            body = m.group(2)
            codes = [WX_CODES.get(body[i:i + 2], body[i:i + 2]) for i in range(0, len(body), 2)]
            out["weather"].append({"code": p, "intensity": intensity, "items": codes})
    # Catégorie de vol (VFR / MVFR / IFR / LIFR)
    ceiling = min((c["ft"] for c in out["clouds"] if c["cover"] in ("BKN", "OVC", "VV") and c["ft"] is not None),
                  default=None)
    vis = out.get("visibility_m")
    cat = "VFR"
    if (ceiling is not None and ceiling < 500) or (vis is not None and vis < 1600):
        cat = "LIFR"
    elif (ceiling is not None and ceiling < 1000) or (vis is not None and vis < 4800):
        cat = "IFR"
    elif (ceiling is not None and ceiling <= 3000) or (vis is not None and vis <= 8000):
        cat = "MVFR"
    out["category"] = cat
    out["ceiling_ft"] = ceiling
    # Résumé simple pour l'interface
    covers = [c["cover"] for c in out["clouds"]]
    if out.get("weather"):
        main = out["weather"][0]["items"][-1]
        out["summary"] = main
    elif out.get("cavok") or out.get("clouds_none") or not covers:
        out["summary"] = "clear"
    elif "OVC" in covers or "VV" in covers:
        out["summary"] = "overcast"
    elif "BKN" in covers:
        out["summary"] = "cloudy"
    else:
        out["summary"] = "partly_cloudy"
    return out
