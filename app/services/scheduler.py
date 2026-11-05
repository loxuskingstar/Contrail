"""Planificateur interne (asyncio) : sauvegardes automatiques, watchlist, météo en attente."""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta

from ..core import get_settings, q
from . import backup, opensky, weather, wishes
from .notify import notify, texts

log = logging.getLogger("contrail.scheduler")


async def _backup_loop() -> None:
    while True:
        try:
            hours = float(get_settings().get("backup_interval_hours") or 0)
            if hours > 0:
                last = backup.last_backup_time()
                if last is None or datetime.now() - last >= timedelta(hours=hours):
                    info = await asyncio.to_thread(backup.create_backup)
                    log.info("Sauvegarde automatique : %s", info["name"])
        except Exception as e:  # noqa: BLE001
            log.exception("Sauvegarde automatique en échec")
            title, body = texts("backup_failed", error=str(e)[:200])
            notify("backup", title, body, "#/settings/data")
        await asyncio.sleep(600)


async def _watch_loop() -> None:
    await asyncio.sleep(20)
    while True:
        interval = 5
        try:
            s = get_settings()
            interval = max(2, int(s.get("watch_interval_min") or 5))
            if s.get("modules", {}).get("watchlist", True):
                await asyncio.to_thread(opensky.check_watchlist)
                await asyncio.to_thread(wishes.sync)
                await asyncio.to_thread(wishes.reminders)
        except Exception:  # noqa: BLE001
            log.exception("Vérification de la watchlist en échec")
        await asyncio.sleep(interval * 60)


async def _weather_retry_loop() -> None:
    """Rattrape les spots créés hors-ligne ou pendant une panne d'API météo."""
    await asyncio.sleep(60)
    while True:
        try:
            if get_settings().get("modules", {}).get("weather", True):
                rows = q("SELECT id_spotting FROM spotting WHERE (weather_status IS NULL OR weather_status IN "
                         "('pending','error')) AND airport IS NOT NULL AND date_utc IS NOT NULL LIMIT 10")
                for r in rows:
                    await asyncio.to_thread(weather.update_spot_weather, r["id_spotting"])
                    await asyncio.sleep(3)
        except Exception:  # noqa: BLE001
            log.exception("Rattrapage météo en échec")
        await asyncio.sleep(1800)


def start() -> list[asyncio.Task]:
    if os.environ.get("CONTRAIL_DISABLE_SCHEDULER") == "1":
        return []
    return [asyncio.create_task(c()) for c in (_backup_loop, _watch_loop, _weather_retry_loop)]
