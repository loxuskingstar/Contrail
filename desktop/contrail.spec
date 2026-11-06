# -*- mode: python ; coding: utf-8 -*-
# Construit l'application autonome (Python + dépendances + interface) : `pyinstaller desktop/contrail.spec`
import os
import re
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
VERSION = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', open(os.path.join(ROOT, "app", "core.py"), encoding="utf-8").read()).group(1)
ICON = {"win32": "icon.ico", "darwin": "icon.icns"}.get(sys.platform, "icon.png")

hidden = (collect_submodules("uvicorn") + collect_submodules("tzdata") + collect_submodules("app") + collect_submodules("pystray")
          + ["multipart", "python_multipart", "itsdangerous"])
datas = ([(os.path.join(ROOT, "static"), "static"),
          (os.path.join(ROOT, "app", "fixtures"), os.path.join("app", "fixtures")),
          (os.path.join(SPECPATH, "assets", "icon.png"), os.path.join("desktop", "assets"))]
         + collect_data_files("airportsdata") + collect_data_files("tzdata"))

a = Analysis(
    [os.path.join(SPECPATH, "launcher.py")],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "pytest", "matplotlib", "numpy", "scipy", "pandas", "lxml", "IPython", "setuptools"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Contrail", console=False, icon=os.path.join(SPECPATH, "assets", ICON),
          disable_windowed_traceback=True)
coll = COLLECT(exe, a.binaries, a.datas, name="Contrail")
if sys.platform == "darwin":
    app = BUNDLE(coll, name="Contrail.app", icon=os.path.join(SPECPATH, "assets", "icon.icns"),
                 bundle_identifier="org.contrail.app", version=VERSION,
                 info_plist={"CFBundleDisplayName": "Contrail", "CFBundleShortVersionString": VERSION,
                             "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "11.0"})
