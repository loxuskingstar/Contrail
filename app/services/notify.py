"""Notifications locales (in-app) et relais facultatif vers ntfy / webhook."""
from __future__ import annotations

import json
import logging
import threading

import httpx

from ..core import execute, get_config, now_iso
from .aircraft import client

log = logging.getLogger("contrail.notify")


SERVER_I18N = {
    "fr": {
        "crossref_spot": ("Vous avez déjà volé à bord de {reg} !", "{n} vol(s) enregistré(s) sur cet appareil."),
        "crossref_flight": ("Vous aviez déjà spotté {reg} !", "{n} observation(s) de cet appareil."),
        "achievement": ("Succès débloqué", "{name}"),
        "watch_airborne": ("{reg} est en vol", "{detail}"),
        "watch_home": ("{reg} se dirige vers {airport}", "{detail}"),
        "backup_failed": ("Échec de la sauvegarde automatique", "{error}"),
    },
    "en": {
        "crossref_spot": ("You've already flown on {reg}!", "{n} flight(s) logged on this airframe."),
        "crossref_flight": ("You had already spotted {reg}!", "{n} sighting(s) of this airframe."),
        "achievement": ("Achievement unlocked", "{name}"),
        "watch_airborne": ("{reg} is airborne", "{detail}"),
        "watch_home": ("{reg} is heading to {airport}", "{detail}"),
        "backup_failed": ("Automatic backup failed", "{error}"),
    },
    "es": {
        "crossref_spot": ("¡Ya has volado en {reg}!", "{n} vuelo(s) registrado(s) en este avión."),
        "crossref_flight": ("¡Ya habías fotografiado {reg}!", "{n} avistamiento(s) de este avión."),
        "achievement": ("Logro desbloqueado", "{name}"),
        "watch_airborne": ("{reg} está en vuelo", "{detail}"),
        "watch_home": ("{reg} se dirige a {airport}", "{detail}"),
        "backup_failed": ("Fallo de la copia automática", "{error}"),
    },
    "ja": {
        "crossref_spot": ("{reg} には搭乗済みです！", "この機体での搭乗記録：{n}件"),
        "crossref_flight": ("{reg} は撮影済みです！", "この機体の撮影記録：{n}件"),
        "achievement": ("実績を解除しました", "{name}"),
        "watch_airborne": ("{reg} が飛行中です", "{detail}"),
        "watch_home": ("{reg} が {airport} に向かっています", "{detail}"),
        "backup_failed": ("自動バックアップに失敗しました", "{error}"),
    },
}


def texts(key: str, **kw) -> tuple[str, str]:
    from ..core import get_setting

    lang = get_setting("language") or "fr"
    title, body = SERVER_I18N.get(lang, SERVER_I18N["en"]).get(key) or SERVER_I18N["en"][key]
    return title.format(**kw), body.format(**kw)


def _push_external(title: str, body: str, link: str | None, kind: str) -> None:
    ntfy = get_config("ntfy_url")
    hook = get_config("webhook_url")
    base = get_config("public_base_url").rstrip("/")
    click = f"{base}/{link}" if base and link else None
    try:
        with client() as c:
            if ntfy:
                # Publication JSON (gère l'UTF-8 dans le titre, contrairement aux en-têtes HTTP)
                from urllib.parse import urlsplit

                u = urlsplit(ntfy)
                payload = {"topic": u.path.strip("/"), "title": title, "message": body or title,
                           "tags": ["airplane"]}
                if click:
                    payload["click"] = click
                c.post(f"{u.scheme}://{u.netloc}", json=payload)
            if hook:
                c.post(hook, json={"kind": kind, "title": title, "body": body, "link": click})
    except httpx.HTTPError as e:
        log.info("Relais de notification en échec : %s", e)


def notify(kind: str, title: str, body: str = "", link: str | None = None, data: dict | None = None,
           external: bool = True) -> int:
    cur = execute(
        "INSERT INTO notifications(kind, title, body, link, data, created_at) VALUES(?,?,?,?,?,?)",
        (kind, title, body, link, json.dumps(data or {}, ensure_ascii=False), now_iso()),
    )
    if external and (get_config("ntfy_url") or get_config("webhook_url")):
        threading.Thread(target=_push_external, args=(title, body, link, kind), daemon=True).start()
    return cur.lastrowid
