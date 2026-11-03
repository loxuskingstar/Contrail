"""Point d'entrée FastAPI de Contrail."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from . import auth
import asyncio

from .core import APP_NAME, APP_VERSION, STATIC_DIR, ensure_dirs, set_profile, _profile
from .db import init_db
from .routers import field, fleets, flights, io, misc, share, spots, stats
from .services import gamification, sandbox, scheduler

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("contrail")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    gamification.sync_definitions()
    tasks = scheduler.start()
    log.info("%s %s prêt — authentification %s", APP_NAME, APP_VERSION,
             "activée" if auth.auth_enabled() else "désactivée")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
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
    # Les serveurs de tuiles (OSM, CARTO) exigent un en-tête Referer : ne pas utiliser « same-origin ».
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if path.startswith("/api/") and request.method == "GET" and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store" if not path.startswith("/api/public/") else "public, max-age=60"
    return response


for r in (auth.router, misc.router, spots.router, flights.router, stats.router, fleets.router, field.router, share.router, io.router):
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
