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

from .core import APP_NAME, APP_VERSION, STATIC_DIR, ensure_dirs, set_profile, _profile
from .db import init_db
from .routers import field, fleets, flights, io, misc, share, spots, stats, wishes
from .services import collection, gamification, media, refdb, sandbox, scheduler

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("contrail")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    collection.recategorize()
    gamification.sync_definitions()
    tasks = scheduler.start()
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


for r in (auth.router, misc.router, spots.router, flights.router, stats.router, fleets.router, field.router, share.router, io.router, wishes.router):
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
