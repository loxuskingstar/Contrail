"""Authentification facultative (mono-utilisateur).

Si la variable CONTRAIL_PASSWORD est définie, l'application exige une connexion.
Sinon elle est ouverte (usage local, réseau privé ou derrière Tailscale / un reverse-proxy).
Les liens de partage publics restent accessibles sans connexion.
"""
from __future__ import annotations

import hmac
import time
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from pydantic import BaseModel

from .core import app_password, secret_key

COOKIE = "contrail_session"
MAX_AGE = 60 * 60 * 24 * 60  # 60 jours

router = APIRouter(prefix="/api/auth", tags=["auth"])
_attempts: dict[str, list[float]] = defaultdict(list)


def _signer() -> TimestampSigner:
    return TimestampSigner(secret_key(), salt="contrail-session")


def auth_enabled() -> bool:
    return bool(app_password())


def is_authenticated(request: Request) -> bool:
    if not auth_enabled():
        return True
    token = request.cookies.get(COOKIE)
    if not token:
        return False
    try:
        _signer().unsign(token, max_age=MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


PUBLIC_PREFIXES = ("/api/auth/", "/api/public/", "/api/health", "/s/")


def needs_auth(path: str) -> bool:
    if path.startswith(PUBLIC_PREFIXES):
        return False
    return path.startswith("/api/") or path.startswith("/media/")


class LoginIn(BaseModel):
    password: str


@router.get("/status")
def status(request: Request):
    return {"enabled": auth_enabled(), "authenticated": is_authenticated(request)}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    now = time.time()
    _attempts[ip] = [t for t in _attempts[ip] if now - t < 300]
    if len(_attempts[ip]) >= 8:
        raise HTTPException(429, "too_many_attempts")
    if not auth_enabled():
        return {"ok": True}
    if not hmac.compare_digest(body.password.encode(), app_password().encode()):
        _attempts[ip].append(now)
        raise HTTPException(401, "bad_password")
    _attempts.pop(ip, None)
    token = _signer().sign(b"owner").decode()
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, token, max_age=MAX_AGE, httponly=True, samesite="lax", secure=secure)
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}
