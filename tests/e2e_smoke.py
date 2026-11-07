#!/usr/bin/env python3
"""Test de fumée du front dans un vrai navigateur (Playwright) : démarre l'application sur une base vide, crée quelques spots
puis ouvre chaque page principale en vérifiant qu'aucune erreur JavaScript n'est levée et que la page affiche du contenu.
Hors collecte pytest (nom sans « test_ ») :  python3 tests/e2e_smoke.py     (pip install playwright && playwright install chromium)"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post_spot(base: str, d: dict) -> dict:
    b = uuid.uuid4().hex
    body = f'--{b}\r\nContent-Disposition: form-data; name="data"\r\n\r\n{json.dumps(d)}\r\n--{b}--\r\n'.encode()
    req = urllib.request.Request(base + "/api/spots", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.loads(urllib.request.urlopen(req).read())["spot"]


def main() -> int:
    from playwright.sync_api import sync_playwright

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "CONTRAIL_DATA_DIR": tempfile.mkdtemp(prefix="contrail-e2e-"), "CONTRAIL_OFFLINE": "1", "CONTRAIL_DISABLE_SCHEDULER": "1"}
    srv = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)], cwd=ROOT, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(base + "/api/health", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            print("Le serveur ne démarre pas")
            return 1
        patrol = post_spot(base, {"airport": "LFBO", "date": "2026-05-01T10:00", "patrol": {"simple": True, "name": "Equipe Smoke", "size": 4}})
        post_spot(base, {"registration": "F-SMK01", "aircraft": "Airbus A320", "aircraft_icao": "A320", "airport": "LFBO", "date": "2026-05-01T11:00", "patrol": {"name": "Equipe Smoke"}})
        post_spot(base, {"registration": "F-SMK02", "aircraft": "ATR 72", "aircraft_icao": "AT76", "airport": "LFPG", "date": "2026-06-01T11:00"})
        routes = ["", "spots", f"spots/{patrol['id_spotting']}", "spots/new", "airports", "patrols", f"patrols/{patrol['patrol_id']}",
                  "flights", "stats", "wishlist", "achievements", "settings", "map", "bulk", "duplicates", "reports", "trash"]
        problems: list[str] = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1100, "height": 900})
            errs: list[str] = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errs.append(m.text))
            for r in routes:
                errs.clear()
                page.goto(f"{base}/#/{r}")
                page.wait_for_timeout(900)
                text = page.inner_text("#app, main, body")
                if errs:
                    problems.append(f"#/{r} : {errs[:2]}")
                elif len(text.strip()) < 20:
                    problems.append(f"#/{r} : page vide")
                print(("KO " if any(x.startswith(f'#/{r} ') for x in problems) else "ok ") + f"#/{r}")
            browser.close()
        for x in problems:
            print("PROBLÈME", x)
        return 1 if problems else 0
    finally:
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
