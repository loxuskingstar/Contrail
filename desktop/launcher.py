"""Lanceur de bureau de Contrail : démarre le serveur en local, ouvre le navigateur et reste dans la zone de notification.

Utilisé par les installeurs Windows / macOS / Linux (aucun Docker, aucun Python à installer côté utilisateur).
Aussi lançable depuis les sources : `python desktop/launcher.py`.

Options : --data-dir DOSSIER   où vivent la base et les photos (défaut : dossier de données de l'utilisateur)
          --port N             port préféré (défaut 8765 ; un autre est pris s'il est occupé)
          --lan                accessible depuis le téléphone / les autres appareils du réseau local
          --no-browser         ne pas ouvrir le navigateur
          --no-tray            pas d'icône de notification (arrêt par --stop)
          --stop               arrête l'instance en cours
          --console            (Windows) affiche les messages dans la console qui a lancé l'application, pour diagnostiquer
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Contrail"
DEFAULT_PORT = 8765


def resource_root() -> Path:
    """Dossier des ressources : celui de PyInstaller une fois figé, la racine du dépôt sinon."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def default_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "contrail"


def healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def port_free(port: int) -> bool:
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0 if sys.platform == "win32" else 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def lan_address(port: int) -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))     # aucune donnée envoyée : sert à connaître l'interface sortante
            return f"http://{s.getsockname()[0]}:{port}"
    except OSError:
        return ""


def tray_image():
    from PIL import Image
    icon = resource_root() / "desktop" / "assets" / "icon.png"
    if not icon.exists():
        icon = resource_root() / "static" / "icons" / "icon-192.png"
    return Image.open(icon).convert("RGBA").resize((64, 64))


def show_error(message: str) -> None:
    """Fenêtre d'erreur native : une application sans console qui plante doit le dire, pas disparaître."""
    try:
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, 0x10)
        elif sys.platform == "darwin":
            safe = message.replace("\\", "\\\\").replace('"', "'")
            os.system(f'osascript -e \'display dialog "{safe}" with title "{APP_NAME}" buttons {{"OK"}} with icon stop\'')  # noqa: S605
        else:
            for cmd in (["zenity", "--error", "--title", APP_NAME, "--text", message], ["kdialog", "--error", message]):
                if os.system(f"command -v {cmd[0]} >/dev/null 2>&1") == 0:
                    import subprocess
                    subprocess.run(cmd, check=False)
                    break
    except Exception:  # noqa: BLE001
        pass


def attach_console() -> None:
    """Windows : une application « fenêtrée » n'a pas de console ; on se rattache à celle qui l'a lancée (cmd / PowerShell)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        if ctypes.windll.kernel32.AttachConsole(-1) or ctypes.windll.kernel32.AllocConsole():
            sys.stdout = sys.stderr = open("CONOUT$", "w", buffering=1, encoding="utf-8")  # noqa: SIM115
    except Exception:  # noqa: BLE001
        pass


def open_folder(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        os.system(f'open "{path}"')  # noqa: S605
    else:
        os.system(f'xdg-open "{path}" >/dev/null 2>&1 &')  # noqa: S605


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir")
    ap.add_argument("--port", type=int, default=int(os.environ.get("CONTRAIL_PORT", DEFAULT_PORT)))
    ap.add_argument("--lan", action="store_true")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-tray", action="store_true")
    ap.add_argument("--stop", action="store_true")
    ap.add_argument("--console", action="store_true")
    args = ap.parse_args()
    if args.console:
        attach_console()

    data = Path(args.data_dir or os.environ.get("CONTRAIL_DATA_DIR") or default_data_dir()).expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True)
    port_file, stop_file = data / ".port", data / ".stop"

    # Instance déjà lancée : on ne démarre pas un second serveur, on rouvre simplement le navigateur
    running = int(port_file.read_text()) if port_file.exists() and port_file.read_text().strip().isdigit() else 0
    if running and healthy(running):
        if args.stop:
            stop_file.write_text("stop")
            return 0
        if not args.no_browser:
            webbrowser.open(f"http://localhost:{running}")
        return 0
    if args.stop:
        return 0
    stop_file.unlink(missing_ok=True)

    # Une version « fenêtrée » n'a pas de console : la sortie va dans un fichier journal
    if (getattr(sys, "frozen", False) or sys.stdout is None) and not args.console:
        log = open(data / "contrail.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stderr = log
        try:
            import faulthandler
            faulthandler.enable(file=log)       # plantage natif : au moins une trace dans le journal
        except Exception:  # noqa: BLE001
            pass
    print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} démarrage de Contrail ({sys.platform}, Python {sys.version.split()[0]})", flush=True)

    port = args.port if port_free(args.port) else free_port()
    host = "0.0.0.0" if args.lan or os.environ.get("CONTRAIL_LAN") == "1" else "127.0.0.1"    # noqa: S104
    os.environ["CONTRAIL_DATA_DIR"] = str(data)
    sys.path.insert(0, str(resource_root()))

    import uvicorn
    from app.main import app
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_config=None, access_log=False))
    failure: list[str] = []

    def serve():
        try:
            server.run()
        except BaseException:  # noqa: BLE001 — le détail doit finir dans le journal et dans la fenêtre d'erreur
            failure.append(traceback.format_exc())
            traceback.print_exc()
    thread = threading.Thread(target=serve, name="contrail-server", daemon=True)
    thread.start()
    deadline = time.monotonic() + 40
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.1)
    if not server.started:
        detail = (failure[-1] if failure else "").strip().splitlines()[-1:] or ["démarrage trop long ou port inaccessible"]
        print("Le serveur n'a pas démarré.", detail, file=sys.stderr)
        show_error(f"Contrail n'a pas pu démarrer.\n\n{detail[0]}\n\nDétails : {data / 'contrail.log'}")
        return 1
    port_file.write_text(str(port))
    url = f"http://localhost:{port}"
    print(f"Contrail démarré sur {url} (données : {data})", flush=True)
    if not args.no_browser:
        webbrowser.open(url)

    quit_now = threading.Event()

    def watch():     # arrêt demandé par `--stop`, ou serveur tombé
        while not quit_now.is_set():
            if stop_file.exists() or not thread.is_alive():
                quit_now.set()
                break
            time.sleep(0.5)
        server.should_exit = True
        tray = holder.get("tray")
        if tray:
            tray.stop()
    holder: dict = {}
    threading.Thread(target=watch, daemon=True).start()

    tray_ok = False
    if not args.no_tray:
        try:
            import pystray
            lan = lan_address(port) if host == "0.0.0.0" else ""    # noqa: S104
            items = [pystray.MenuItem("Ouvrir Contrail", lambda: webbrowser.open(url), default=True)]
            if lan:
                items.append(pystray.MenuItem(f"Sur le réseau : {lan}", lambda: webbrowser.open(lan)))
            items += [pystray.MenuItem("Ouvrir le dossier de données", lambda: open_folder(data)),
                      pystray.MenuItem("Quitter", lambda: quit_now.set())]
            holder["tray"] = pystray.Icon("contrail", tray_image(), APP_NAME, pystray.Menu(*items))
            tray_ok = True
            holder["tray"].run()        # bloque jusqu'à « Quitter » (sur macOS, doit tourner dans le thread principal)
        except Exception as e:  # noqa: BLE001 — pas de zone de notification (Linux sans AppIndicator, session sans écran…)
            print(f"Icône de notification indisponible ({e}) : arrêt avec « contrail --stop ».", flush=True)
    if not tray_ok:
        while not quit_now.is_set():
            time.sleep(0.5)
    quit_now.set()
    server.should_exit = True
    thread.join(timeout=10)
    for f in (port_file, stop_file):
        f.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 — jamais de fermeture silencieuse
        trace = traceback.format_exc()
        try:
            folder = default_data_dir()
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "contrail-crash.log").write_text(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\n{trace}", encoding="utf-8")
        except Exception:  # noqa: BLE001
            folder = Path(".")
        show_error(f"Contrail a rencontré une erreur et doit s'arrêter.\n\n{trace.strip().splitlines()[-1]}\n\nDétails : {folder / 'contrail-crash.log'}")
        sys.exit(1)
