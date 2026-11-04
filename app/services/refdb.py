"""Base de référence des appareils (hors-ligne) : Mode-S ↔ immatriculation ↔ type ↔ opérateur.

Deux sources téléchargeables, cumulables (fusion) :
- tar1090-db (Mictronics), sur GitHub : ~ 10 Mo compressés, très à jour pour l'immatriculation, le type
  et le nom de l'opérateur ;
- la base d'appareils d'OpenSky Network : plus volumineuse (~ 100 Mo) mais elle donne le **code OACI
  de l'opérateur** (AFR, EZY…), ce qui permet de reconstituer une flotte complète sans AirLabs.
Après fusion, les codes OACI connus sont propagés aux appareils dont seul le nom d'opérateur est connu.
Un fichier peut aussi être importé à la main : format tar1090/readsb (champs séparés par « ; » :
icao;immat;type;flags;desc;année;opérateur) ou CSV avec en-tête de la base OpenSky.

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
OPENSKY_BUCKET = "https://s3.opensky-network.org/data-samples/metadata/"
OPENSKY_FALLBACK = OPENSKY_BUCKET + "aircraftDatabase.csv"
SOURCES = {"tar1090": DEFAULT_URL, "opensky": None}

# Mots ignorés pour rapprocher les noms d'opérateur (« Air France S.A. » ≈ « AIR FRANCE »)
_STOP = {"sa", "s", "a", "ag", "ltd", "limited", "inc", "co", "corp", "company", "plc", "gmbh", "spa", "srl", "sas",
         "bv", "nv", "as", "asa", "ab", "oy", "llc", "jsc", "pjsc", "the", "de", "airlines", "airline", "airways", "aviation", "air lines"}

_state: dict = {"running": False, "phase": None, "rows": 0, "error": None, "started": None, "bytes": 0, "total_bytes": 0}
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
            out.update({"count": int(meta.get("count", 0)), "imported_at": meta.get("imported_at"), "source": meta.get("source"),
                        "with_operator_icao": int(meta.get("with_operator_icao", 0) or 0)})
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


def _has_col(c: sqlite3.Connection, col: str) -> bool:
    return any(r["name"] == col for r in c.execute("PRAGMA table_info(aircraft)"))


def by_operator(name: str | list[str] | None, icao: str | None = None, limit: int = 4000) -> list[dict]:
    """Appareils d'un opérateur : par code OACI, puis par nom (exact, puis simplifié).

    Les deux critères sont cumulés : un appareil connu seulement par le nom de son opérateur
    complète ceux qui portent déjà le code OACI.
    """
    c = _conn()
    if not c:
        return []
    names = [n for n in ([name] if isinstance(name, str) else (name or [])) if n]
    found: dict[str, dict] = {}
    if icao and re.fullmatch(r"[A-Za-z]{3}", icao):
        for r in c.execute("SELECT * FROM aircraft WHERE operator_icao = ? LIMIT ?", (icao.upper(), limit)):
            found[r["icao24"]] = r
    keys = {_opkey(n) for n in names} - {""}
    norms = {_norm(n) for n in names} - {""}
    if norms:
        q = f"SELECT * FROM aircraft WHERE ownop_norm IN ({','.join('?' * len(norms))}) LIMIT ?"
        for r in c.execute(q, (*norms, limit)):
            found.setdefault(r["icao24"], r)
    if keys and _has_col(c, "op_key"):
        q = f"SELECT * FROM aircraft WHERE op_key IN ({','.join('?' * len(keys))}) LIMIT ?"
        for r in c.execute(q, (*keys, limit)):
            found.setdefault(r["icao24"], r)
    return list(found.values())[:limit]


def dominant_operators(icao: str) -> list[str]:
    """Noms d'opérateur dominants pour un code OACI (au moins 30 % du plus fréquent)."""
    c = _conn()
    if not c or not re.fullmatch(r"[A-Za-z]{3}", icao or ""):
        return []
    rows = c.execute("SELECT ownop, COUNT(*) n FROM aircraft WHERE operator_icao = ? AND ownop IS NOT NULL AND ownop <> '' "
                     "GROUP BY ownop ORDER BY n DESC LIMIT 20", (icao.upper(),)).fetchall()
    if not rows:
        return []
    top = rows[0]["n"]
    return [r["ownop"] for r in rows if r["n"] >= 0.3 * top]


def operators(prefix: str = "", limit: int = 30) -> list[dict]:
    """Opérateurs connus de la base (pour l'autocomplétion des flottes)."""
    c = _conn()
    if not c:
        return []
    like = f"{_norm(prefix)}%"
    return c.execute("SELECT MAX(ownop) name, MAX(operator_icao) icao, COUNT(*) n FROM aircraft WHERE ownop_norm LIKE ? "
                     "GROUP BY ownop_norm ORDER BY n DESC LIMIT ?", (like, limit)).fetchall()


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _opkey(s: str | None) -> str:
    """Nom d'opérateur simplifié : sans formes juridiques ni « airlines / airways »."""
    words = [w for w in _norm(s).split() if w not in _STOP]
    return " ".join(words)


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
    operator_icao TEXT,
    op_key        TEXT
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


def import_file(path: Path, source: str, merge: bool = True) -> int:
    """Importe un fichier ; s'il existe déjà une base, les deux sont fusionnées (aucune donnée perdue)."""
    # Lecture en flux : la base OpenSky dépasse 100 Mo, inutile de la charger en mémoire
    with open(path, "rb") as fh:
        gz = fh.read(2) == b"\x1f\x8b"
    stream = (gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="") if gz
              else open(path, encoding="utf-8", errors="replace", newline=""))
    try:
        return _import_stream(stream, source, merge)
    finally:
        stream.close()


def _import_stream(stream, source: str, merge: bool) -> int:
    fmt, rows = _rows_from_text(stream)
    tmp = REF_PATH.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    existing = merge and REF_PATH.exists()
    if existing:
        src = sqlite3.connect(f"file:{REF_PATH}?mode=ro", uri=True)
        dst = sqlite3.connect(str(tmp))
        src.backup(dst)
        src.close()
        c = dst
        cols = {r[1] for r in c.execute("PRAGMA table_info(aircraft)")}
        if "op_key" not in cols:   # base créée par la v1.3
            c.execute("ALTER TABLE aircraft ADD COLUMN op_key TEXT")
            for (own,) in c.execute("SELECT DISTINCT ownop FROM aircraft WHERE ownop IS NOT NULL").fetchall():
                c.execute("UPDATE aircraft SET op_key = ? WHERE ownop = ?", (_opkey(own) or None, own))
        meta = {k: v for k, v in c.execute("SELECT k, v FROM meta")}
    else:
        c = sqlite3.connect(str(tmp))
        c.executescript(SCHEMA)
        meta = {}
    # Priorité des champs : tar1090 est plus à jour (immatriculation, type, opérateur) ;
    # OpenSky apporte surtout le code OACI de l'opérateur et comble les vides.
    if fmt == "opensky":
        upd = ("registration=COALESCE(aircraft.registration, excluded.registration), typecode=COALESCE(aircraft.typecode, excluded.typecode), "
               "description=COALESCE(aircraft.description, excluded.description), year=COALESCE(aircraft.year, excluded.year), "
               "ownop=COALESCE(aircraft.ownop, excluded.ownop), ownop_norm=COALESCE(aircraft.ownop_norm, excluded.ownop_norm), "
               "op_key=COALESCE(aircraft.op_key, excluded.op_key), operator_icao=COALESCE(excluded.operator_icao, aircraft.operator_icao)")
    else:
        upd = ("registration=COALESCE(excluded.registration, aircraft.registration), typecode=COALESCE(excluded.typecode, aircraft.typecode), "
               "description=COALESCE(excluded.description, aircraft.description), military=MAX(aircraft.military, excluded.military), "
               "year=COALESCE(excluded.year, aircraft.year), ownop=COALESCE(excluded.ownop, aircraft.ownop), "
               "ownop_norm=COALESCE(excluded.ownop_norm, aircraft.ownop_norm), op_key=COALESCE(excluded.op_key, aircraft.op_key), "
               "operator_icao=COALESCE(aircraft.operator_icao, excluded.operator_icao)")
    sql = ("INSERT INTO aircraft(icao24, registration, typecode, description, military, year, ownop, ownop_norm, operator_icao, op_key) "
           f"VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(icao24) DO UPDATE SET {upd}")
    batch, n = [], 0

    def flush():
        nonlocal batch
        c.executemany(sql, batch)
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
        op_icao = (op_icao or "").strip().upper() or None
        if op_icao and not re.fullmatch(r"[A-Z]{3}", op_icao):
            op_icao = None
        batch.append((icao, reg, typ, (desc or "").strip() or None, mil, (year or "").strip() or None, op, _norm(op) or None,
                      op_icao, _opkey(op) or None))
        n += 1
        if len(batch) >= 20000:
            flush()
            _state["rows"] = n
    flush()
    if n == 0:
        c.close()
        tmp.unlink(missing_ok=True)
        raise ValueError("refdb_empty")
    _state["phase"] = "index"
    if not existing:
        c.execute("CREATE INDEX idx_reg ON aircraft(registration)")
        c.execute("CREATE INDEX idx_op ON aircraft(ownop_norm)")
        c.execute("CREATE INDEX idx_opicao ON aircraft(operator_icao)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_opkey ON aircraft(op_key)")
    propagated = _propagate_operator_icao(c)
    total = c.execute("SELECT COUNT(*) FROM aircraft").fetchone()[0]
    with_icao = c.execute("SELECT COUNT(*) FROM aircraft WHERE operator_icao IS NOT NULL").fetchone()[0]
    import json as _json
    sources = {}
    try:
        sources = _json.loads(meta.get("sources") or "{}")
    except ValueError:
        sources = {}
    if meta.get("source") and not sources:
        sources[meta["source"]] = {"rows": int(meta.get("count", 0) or 0), "at": meta.get("imported_at")}
    sources[f"{source} ({fmt})"] = {"rows": n, "at": now_iso()}
    c.execute("DELETE FROM meta")
    c.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("count", str(total)), ("imported_at", now_iso()), ("source", " + ".join(sources)),
        ("sources", _json.dumps(sources)), ("with_operator_icao", str(with_icao)), ("propagated", str(propagated))])
    c.commit()
    c.close()
    tmp.replace(REF_PATH)
    _local.conn = None
    log.info("Base de référence : %s lignes importées (%s), %s appareils, %s avec code OACI opérateur (%s propagés)",
             n, fmt, total, with_icao, propagated)
    return n


def _propagate_operator_icao(c: sqlite3.Connection) -> int:
    """Attribue le code OACI dominant d'un nom d'opérateur aux appareils qui n'ont que ce nom."""
    rows = c.execute("SELECT op_key, operator_icao, COUNT(*) n FROM aircraft WHERE op_key IS NOT NULL AND operator_icao IS NOT NULL "
                     "GROUP BY op_key, operator_icao").fetchall()
    best: dict[str, tuple[str, int, int]] = {}
    for key, icao, n in rows:
        cur = best.get(key)
        tot = (cur[2] if cur else 0) + n
        if not cur or n > cur[1]:
            best[key] = (icao, n, tot)
        else:
            best[key] = (cur[0], cur[1], tot)
    pairs = [(icao, key) for key, (icao, n, tot) in best.items() if n >= 3 and n / tot >= 0.8]
    before = c.total_changes
    c.executemany("UPDATE aircraft SET operator_icao = ? WHERE op_key = ? AND operator_icao IS NULL", pairs)
    return c.total_changes - before


def _run(fn, *args) -> None:
    try:
        _state.update(running=True, error=None, rows=0, started=time.time(), bytes=0, total_bytes=0)
        fn(*args)
        _state.update(phase="done")
    except Exception as e:  # noqa: BLE001
        log.exception("Import de la base de référence en échec")
        _state.update(phase="error", error=str(e)[:200])
    finally:
        _state["running"] = False


def _opensky_url() -> str:
    """Dernière base complète publiée par OpenSky (liste du compartiment S3), sinon l'ancienne adresse fixe."""
    try:
        with client() as c:
            r = c.get(OPENSKY_BUCKET, params={"list-type": "2", "prefix": "aircraft-database-complete-"}, timeout=30)
            keys = re.findall(r"<Key>(aircraft-database-complete-\d{4}-\d{2}\.csv)</Key>", r.text)
            if not keys:
                r = c.get(OPENSKY_BUCKET, timeout=30)
                keys = re.findall(r"<Key>(aircraft-database-complete-\d{4}-\d{2}\.csv)</Key>", r.text)
        if keys:
            return OPENSKY_BUCKET + sorted(keys)[-1]
    except httpx.HTTPError as e:
        log.warning("Liste OpenSky indisponible : %s", e)
    return OPENSKY_FALLBACK


def _download(url: str) -> None:
    _state["phase"] = "download"
    if url == "opensky":
        url = _opensky_url()
    dest = DATA_DIR / "tmp" / "aircraft_ref_download"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with client() as c, c.stream("GET", url, timeout=httpx.Timeout(300, connect=15), follow_redirects=True) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        got = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_bytes(1 << 16):
                f.write(chunk)
                got += len(chunk)
                _state["bytes"], _state["total_bytes"] = got, total
    with open(dest, "rb") as fh:
        head = fh.read(64)
    if head[:2] != b"\x1f\x8b" and not re.match(rb"^[0-9a-fA-F]{6}[;,]|^.?['\"]?icao24", head):
        raise ValueError("refdb_bad_download")
    _state["phase"] = "import"
    import_file(dest, url.split("/")[2])
    dest.unlink(missing_ok=True)


def start_download(url: str = DEFAULT_URL) -> bool:
    """`url` : adresse d'un fichier, ou « opensky » pour la dernière base OpenSky."""
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
