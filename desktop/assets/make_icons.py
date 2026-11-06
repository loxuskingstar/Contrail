"""Génère icon.png / icon.ico / icon.icns à partir de static/icons/icon-512.png (à relancer si l'icône change)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
src = Image.open(root.parent.parent / "static" / "icons" / "icon-512.png").convert("RGBA")
src.save(root / "icon.png")
src.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
src.resize((1024, 1024), Image.LANCZOS).save(root / "icon.icns")
print("icônes générées")
