"""Point d'entrée FastAPI de Contrail."""
from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import auth
import asyncio

from .core import APP_NAME, APP_VERSION, STATIC_DIR, ensure_dirs, get_settings, set_profile, set_settings, _profile
from .db import init_db
from .routers import gear as gear_router, airports as airports_router, patrols as patrols_router, field, fleets, flights, io, misc, outings as outings_router, pdf as pdf_router, reports as reports_router, share, spots, stats, trash as trash_router, wishes
from .services import collection, gamification, geo, media, refdb, sandbox, scheduler, trash

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("contrail")


def _backfill_countries() -> None:
    """Spots sans pays (série militaire type QA400) : on le déduit de l'exploitant."""
    from .core import execute, q
    from .services import registration as regs
    for r in q("SELECT id_spotting id, registration, owner FROM spotting "
               "WHERE (country IS NULL OR country='') AND owner IS NOT NULL AND owner<>''"):
        c = regs.country_for(r["registration"], r["owner"])
        if c:
            execute("UPDATE spotting SET country=? WHERE id_spotting=?", (c, r["id"]))


def _link_patrols() -> None:
    """Avions identifiés après coup sous le nom d'une patrouille saisie en mode simple : ils la rejoignent
    (même nom, accents et casse ignorés), pour compter dans ses vues."""
    from .core import execute, q
    from .services import registration as regs
    simple: dict[str, int] = {}
    for r in q("SELECT DISTINCT p.id_patrol id, p.name FROM patrols p JOIN spotting s ON s.patrol_id = p.id_patrol "
               "WHERE s.is_patrol = 1 AND p.name IS NOT NULL ORDER BY p.id_patrol"):
        simple.setdefault(regs._fold(r["name"].strip()), r["id"])  # noqa: SLF001
    if not simple:
        return
    for r in q("SELECT id_patrol id, name FROM patrols WHERE name IS NOT NULL"):
        target = simple.get(regs._fold(r["name"].strip()))  # noqa: SLF001
        if target and target != r["id"]:
            execute("UPDATE spotting SET patrol_id = ? WHERE patrol_id = ?", (target, r["id"]))
            execute("DELETE FROM patrols WHERE id_patrol = ?", (r["id"],))


def _reclassify_fields() -> None:
    """Hélistations et terrains saisis avant leur prise en charge (code rangé à tort en « lieu ») : on les repasse en aéroports."""
    from .core import execute, q
    from .services import geo
    for table in ("spotting",):    # les sorties se rattachent d'elles-mêmes aux spots déplacés
        for r in q(f"SELECT DISTINCT place FROM {table} WHERE (airport IS NULL OR airport='') AND place GLOB '[A-Z][A-Z0-9]*' AND length(place) BETWEEN 4 AND 8"):
            a = geo.airport(r["place"])
            if a:
                execute(f"UPDATE {table} SET airport=?, place=NULL WHERE place=? AND (airport IS NULL OR airport='')", (a["icao"], r["place"]))


def _run_fixups() -> None:
    """Rattrapages de données (pays, patrouilles, terrains) : exécutés une fois par version de l'application, pas à chaque
    démarrage. Les règles de classement évoluent d'une version à l'autre ; un spot enregistré ensuite est déjà traité à l'écriture."""
    if get_settings().get("fixups_version") == APP_VERSION:
        return
    for fn, label in ((collection.recategorize, "livrées"), (_backfill_countries, "pays"), (_link_patrols, "patrouilles"),
                      (_reclassify_fields, "terrains")):
        try:
            fn()
        except Exception:  # noqa: BLE001
            log.exception("Rattrapage « %s » en échec", label)
            return                         # une nouvelle tentative aura lieu au prochain démarrage
    set_settings({"fixups_version": APP_VERSION})


def _warm_up() -> None:
    """Charge en arrière-plan ce qui coûte cher à la première utilisation (n'empêche pas le démarrage)."""
    try:
        geo.warm()
        if get_settings()["modules"].get("ocr", True) and media.ocr_engine() == "rapidocr":
            media._rapid_engine()  # noqa: SLF001
    except Exception:  # noqa: BLE001
        log.debug("Préchauffage partiel", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    gamification.sync_definitions()
    try:
        trash.purge_old()
    except Exception:  # noqa: BLE001
        log.exception("Purge de la corbeille en échec")
    _run_fixups()
    tasks = scheduler.start()
    threading.Thread(target=_warm_up, daemon=True, name="warm-up").start()   # aéroports + moteur OCR prêts avant la première photo
    threading.Thread(target=refdb.compact_file, daemon=True, name="refdb-compact").start()   # allège une ancienne base de référence
    threading.Thread(target=media.backfill_phash, daemon=True, name="phash-backfill").start()   # empreintes des photos déjà enregistrées
    log.info("%s %s prêt — authentification %s", APP_NAME, APP_VERSION,
             "activée" if auth.auth_enabled() else "désactivée")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1024)


# Taille maximale d'un envoi (octets). Les sauvegardes et la base OpenSky sont volumineuses ; le reste ne l'est pas.
_MB = 1 << 20
_BIG_UPLOADS = {"/api/refdb/upload": 1024 * _MB, "/api/backups/restore": 4096 * _MB}
_MAX_UPLOAD = int(os.environ.get("CONTRAIL_MAX_UPLOAD_MB", "120")) * _MB


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if request.method in ("POST", "PUT", "PATCH"):
        try:
            size = int(request.headers.get("content-length") or 0)
        except ValueError:
            size = 0
        if size > _BIG_UPLOADS.get(path, _MAX_UPLOAD):
            return JSONResponse({"detail": "payload_too_large"}, status_code=413)
    if auth.needs_auth(path) and not auth.is_authenticated(request):
        return JSONResponse({"detail": "auth_required"}, status_code=401)
    # Profil de données : session de test (cookie) ou lien public créé en session de test (jeton « t-… »)
    test = request.cookies.get("contrail_profile") == "test" or path.startswith("/api/public/t-")
    token = set_profile("test" if test else "main")
    try:
        if test and (path.startswith("/api/") or path.startswith("/media/")):
            await asyncio.to_thread(sandbox.ensure_sandbox)
        response = await call_next(request)
    finally:
        _profile.reset(token)
    if test:
        response.headers["X-Contrail-Profile"] = "test"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")   # pas d'intégration de l'application dans un autre site
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()")
    # Les serveurs de tuiles (OSM, CARTO) exigent un en-tête Referer : ne pas utiliser « same-origin ».
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if path.startswith("/api/") and request.method == "GET" and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store" if not path.startswith("/api/public/") else "public, max-age=60"
    if path.startswith("/static/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"  # revalidation par ETag : jamais de fichier périmé
    return response


for r in (auth.router, misc.router, spots.router, flights.router, stats.router, fleets.router, field.router, share.router, io.router, wishes.router, trash_router.router, outings_router.router, airports_router.router, patrols_router.router, reports_router.router, pdf_router.router, gear_router.router):
    app.include_router(r)


# --------------------------------------------------------------------------- #
# Frontend (PWA) : fichiers statiques + fallback SPA
# --------------------------------------------------------------------------- #
INDEX = STATIC_DIR / "index.html"


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/", include_in_schema=False)
@app.get("/s/{token}", include_in_schema=False)
def index(token: str | None = None):
    return FileResponse(INDEX, headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
