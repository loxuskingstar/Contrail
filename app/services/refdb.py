"""Base de référence des appareils (hors-ligne) : Mode-S ↔ immatriculation ↔ type ↔ opérateur.

Source par défaut : la base communautaire tar1090-db (Mictronics), téléchargée sur demande
depuis GitHub (~ 10 Mo compressés, ~ 500 000 appareils). Un fichier peut aussi être importé
à la main : format tar1090/readsb (champs séparés par « ; » : icao;immat;type;flags;desc;année;opérateur)
ou CSV avec en-tête de la base OpenSky (icao24, registration, typecode, model, operator…).

La base est partagée par les deux profils (données réelles et session de test) :
elle est stockée dans data/aircraft_ref.db, en dehors des données personnelles.
"""
from __future__ import annotations

import csv
import gzip
import io
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path

import httpx

from ..core import DATA_DIR, now_iso
from . import registration as regs
from .aircraft import client

log = logging.getLogger("contrail.refdb")

REF_PATH = DATA_DIR / "aircraft_ref.db"
DEFAULT_URL = "https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz"

_state: dict = {"running": False, "phase": None, "rows": 0, "error": None, "started": None}
_lock = threading.Lock()
_local = threading.local()

RE_HEX = re.compile(r"^[0-9a-f]{6}$")
RE_TYPE = re.compile(r"^[A-Z0-9]{2,4}$")


def _conn() -> sqlite3.Connection | None:
    if not REF_PATH.exists():
        return None
    c = getattr(_local, "conn", None)
    mtime = REF_PATH.stat().st_mtime
    if c is None or getattr(_local, "mtime", None) != mtime:
        if c is not None:
            c.close()
        c = sqlite3.connect(f"file:{REF_PATH}?mode=ro", uri=True, check_same_thread=False)
        c.row_factory = lambda cur, row: {d[0]: row[i] for i, d in enumerate(cur.description)}
        _local.conn, _local.mtime = c, mtime
    return c


def available() -> bool:
    return REF_PATH.exists()


def status() -> dict:
    out = {**_state, "available": available()}
    c = _conn()
    if c:
        try:
            meta = {r["k"]: r["v"] for r in c.execute("SELECT k, v FROM meta")}
            out.update({"count": int(meta.get("count", 0)), "imported_at": meta.get("imported_at"), "source": meta.get("source")})
        except sqlite3.Error:
            pass
    return out


# --------------------------------------------------------------------------- #
# Lecture
# --------------------------------------------------------------------------- #
def by_hex(hexes: list[str]) -> dict[str, dict]:
    c = _conn()
    if not c or not hexes:
        return {}
    out: dict[str, dict] = {}
    hexes = [h.lower() for h in hexes if h]
    for i in range(0, len(hexes), 500):
        chunk = hexes[i:i + 500]
        for r in c.execute(f"SELECT * FROM aircraft WHERE icao24 IN ({','.join('?' * len(chunk))})", chunk):
            out[r["icao24"]] = r
    return out


def by_reg(reg: str) -> dict | None:
    c = _conn()
    if not c:
        return None
    return c.execute("SELECT * FROM aircraft WHERE registration = ? LIMIT 1", (regs.normalize(reg),)).fetchone()


def by_operator(name: str | None, icao: str | None = None, limit: int = 3000) -> list[dict]:
    """Appareils dont l'opérateur correspond (code OACI si connu, sinon nom exact sans casse)."""
    c = _conn()
    if not c:
        return []
    rows: list[dict] = []
    if icao:
        rows = c.execute("SELECT * FROM aircraft WHERE operator_icao = ? LIMIT ?", (icao.upper(), limit)).fetchall()
    if not rows and name:
        rows = c.execute("SELECT * FROM aircraft WHERE ownop_norm = ? LIMIT ?", (_norm(name), limit)).fetchall()
    return rows


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
SCHEMA = """
CREATE TABLE aircraft (
    icao24        TEXT PRIMARY KEY,
    registration  TEXT,
    typecode      TEXT,
    description   TEXT,
    military      INTEGER NOT NULL DEFAULT 0,
    year          TEXT,
    ownop         TEXT,
    ownop_norm    TEXT,
    operator_icao TEXT
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
"""


def _rows_from_text(lines) -> tuple[str, object]:
    """Détecte le format et renvoie un itérateur de tuples normalisés."""
    first = ""
    lines = iter(lines)
    for first in lines:
        if first.strip():
            break
    head = first.strip().lower()
    if "icao24" in head and ("registration" in head or "typecode" in head):
        # Base OpenSky (CSV avec en-tête, guillemets)
        delim = ";" if head.count(";") > head.count(",") else ","
        hdr = next(csv.reader([first], delimiter=delim))
        idx = {h.strip().strip("'\"").lower(): i for i, h in enumerate(hdr)}

        def gen():
            for row in csv.reader(lines, delimiter=delim, quotechar="'" if "'" in first else '"'):
                def g(k):
                    i = idx.get(k)
                    return (row[i].strip() if i is not None and i < len(row) else "") or None
                model = g("model")
                manu = g("manufacturername")
                desc = f"{manu} {model}" if manu and model and manu.lower() not in model.lower() else (model or manu)
                op = g("operator") or g("owner")
                yield (g("icao24"), g("registration"), g("typecode"), desc, 0, (g("built") or "")[:4] or None, op, g("operatoricao"))
        return "opensky", gen()

    def gen_tar():
        for line in [first, *lines]:
            p = line.rstrip("\r\n").split(";")
            if len(p) < 3:
                continue
            flags = p[3] if len(p) > 3 else ""
            mil = 1 if flags[:1] == "1" else 0
            yield (p[0], p[1] if len(p) > 1 else None, p[2] if len(p) > 2 else None, p[4] if len(p) > 4 else None, mil,
                   p[5] if len(p) > 5 else None, p[6] if len(p) > 6 else None, None)
    return "tar1090", gen_tar()


def import_file(path: Path, source: str) -> int:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8", errors="replace")
    fmt, rows = _rows_from_text(io.StringIO(text))
    tmp = REF_PATH.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    c = sqlite3.connect(str(tmp))
    c.executescript(SCHEMA)
    batch, n = [], 0

    def flush():
        nonlocal batch
        c.executemany("INSERT OR REPLACE INTO aircraft VALUES (?,?,?,?,?,?,?,?,?)", batch)
        batch = []

    for icao, reg, typ, desc, mil, year, op, op_icao in rows:
        icao = (icao or "").strip().lower()
        if not RE_HEX.match(icao):
            continue
        reg = regs.normalize(reg) or None
        typ = (typ or "").strip().upper() or None
        if typ and not RE_TYPE.match(typ):
            typ = None
        op = (op or "").strip() or None
        batch.append((icao, reg, typ, (desc or "").strip() or None, mil, (year or "").strip() or None, op, _norm(op) or None,
                      (op_icao or "").strip().upper() or None))
        n += 1
        if len(batch) >= 20000:
            flush()
            _state["rows"] = n
    flush()
    if n == 0:
        c.close()
        tmp.unlink(missing_ok=True)
        raise ValueError("refdb_empty")
    c.execute("CREATE INDEX idx_reg ON aircraft(registration)")
    c.execute("CREATE INDEX idx_op ON aircraft(ownop_norm)")
    c.execute("CREATE INDEX idx_opicao ON aircraft(operator_icao)")
    c.executemany("INSERT INTO meta VALUES (?, ?)", [("count", str(n)), ("imported_at", now_iso()), ("source", f"{source} ({fmt})")])
    c.commit()
    c.close()
    tmp.replace(REF_PATH)
    _local.conn = None
    log.info("Base de référence importée : %s appareils (%s)", n, fmt)
    return n


def _run(fn, *args) -> None:
    try:
        _state.update(running=True, error=None, rows=0, started=time.time())
        fn(*args)
        _state.update(phase="done")
    except Exception as e:  # noqa: BLE001
        log.exception("Import de la base de référence en échec")
        _state.update(phase="error", error=str(e)[:200])
    finally:
        _state["running"] = False


def _download(url: str) -> None:
    _state["phase"] = "download"
    dest = DATA_DIR / "tmp" / "aircraft_ref_download"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with client() as c, c.stream("GET", url, timeout=httpx.Timeout(120, connect=15)) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_bytes(1 << 16):
                f.write(chunk)
    head = dest.read_bytes()[:64]
    if head[:2] != b"\x1f\x8b" and not re.match(rb"^[0-9a-fA-F]{6}[;,]|^.?icao24", head):
        raise ValueError("refdb_bad_download")
    _state["phase"] = "import"
    import_file(dest, url.split("/")[2])
    dest.unlink(missing_ok=True)


def start_download(url: str = DEFAULT_URL) -> bool:
    with _lock:
        if _state["running"]:
            return False
        threading.Thread(target=_run, args=(_download, url), daemon=True).start()
        return True


def start_import(path: Path, name: str) -> bool:
    with _lock:
        if _state["running"]:
            return False

        def job():
            _state["phase"] = "import"
            import_file(path, name)
            path.unlink(missing_ok=True)
        threading.Thread(target=_run, args=(job,), daemon=True).start()
        return True


def delete() -> None:
    REF_PATH.unlink(missing_ok=True)
    _local.conn = None
