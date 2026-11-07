"""Images (EXIF, conversion WebP, miniatures), audio et OCR local."""
from __future__ import annotations

import io
import logging
import shutil
import uuid
from datetime import datetime
from fractions import Fraction
from pathlib import Path

from PIL import ExifTags, Image, ImageFilter, ImageOps

from ..core import DIRS, get_setting
from . import registration as regs

try:                                    # photos HEIC / HEIF (iPhone, certains Android) : lecture via pillow-heif
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF = True
except Exception:  # noqa: BLE001 — bibliothèque absente ou incompatible : le reste de l'application fonctionne
    HEIF = False

log = logging.getLogger("contrail.media")

Image.MAX_IMAGE_PIXELS = 200_000_000  # photos de reflex plein format OK, bombes de décompression non
THUMB_PX = 640

ALLOWED_AUDIO = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".webm", ".flac"}
MAX_AUDIO_BYTES = 25 * 1024 * 1024


# --------------------------------------------------------------------------- #
# EXIF
# --------------------------------------------------------------------------- #
def _num(v):
    try:
        if isinstance(v, tuple) and len(v) == 2:
            return v[0] / v[1] if v[1] else None
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_to_deg(values, ref) -> float | None:
    try:
        d, m, s = (_num(x) for x in values)
        deg = d + m / 60 + s / 3600
        return -deg if ref in ("S", "W") else deg
    except (TypeError, ValueError):
        return None


def extract_exif(img: Image.Image) -> dict:
    out: dict = {}
    try:
        exif = img.getexif()
    except Exception:  # noqa: BLE001
        return out
    if not exif:
        return out
    base = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
    try:
        sub = {ExifTags.TAGS.get(k, k): v for k, v in exif.get_ifd(ExifTags.IFD.Exif).items()}
    except Exception:  # noqa: BLE001
        sub = {}
    tags = {**base, **sub}

    make = str(tags.get("Make") or "").strip().strip("\x00")
    model = str(tags.get("Model") or "").strip().strip("\x00")
    if make and model and not model.lower().startswith(make.split()[0].lower()):
        out["camera"] = f"{make.title() if make.isupper() else make} {model}"
    elif model or make:
        out["camera"] = model or make
    lens = str(tags.get("LensModel") or "").strip().strip("\x00")
    if lens and lens.lower() not in ("----", "unknown"):
        out["lens"] = lens
    if (f := _num(tags.get("FocalLength"))) is not None:
        out["focal"] = round(f, 1)
    if (f35 := tags.get("FocalLengthIn35mmFilm")):
        out["focal35"] = int(f35)
    if (fn := _num(tags.get("FNumber"))) is not None:
        out["aperture"] = round(fn, 1)
    iso = tags.get("ISOSpeedRatings") or tags.get("PhotographicSensitivity")
    if isinstance(iso, (tuple, list)):
        iso = iso[0] if iso else None
    if iso:
        try:
            out["iso"] = int(iso)
        except (TypeError, ValueError):
            pass
    if (et := _num(tags.get("ExposureTime"))):
        out["shutter"] = f"1/{round(1/et)}" if et < 1 else f"{et:g}s"
        if et < 1:
            frac = Fraction(et).limit_denominator(16000)
            out["shutter"] = f"{frac.numerator}/{frac.denominator}" if frac.numerator != 1 else f"1/{frac.denominator}"
    dto = tags.get("DateTimeOriginal") or tags.get("DateTime")
    if dto:
        try:
            out["datetime"] = datetime.strptime(str(dto).strip("\x00")[:19], "%Y:%m:%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M")
        except ValueError:
            pass
    try:
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
        if gps:
            g = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps.items()}
            lat = _gps_to_deg(g.get("GPSLatitude"), g.get("GPSLatitudeRef"))
            lng = _gps_to_deg(g.get("GPSLongitude"), g.get("GPSLongitudeRef"))
            if lat is not None and lng is not None and not (lat == 0 and lng == 0):
                out["lat"], out["lng"] = round(lat, 6), round(lng, 6)
    except Exception:  # noqa: BLE001
        pass
    return out


# --------------------------------------------------------------------------- #
# Stockage optimisé : WebP redimensionné + miniature
# --------------------------------------------------------------------------- #
def open_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def preview_jpeg(data: bytes, max_px: int = 1600) -> bytes:
    """JPEG d'aperçu (orientation corrigée) : pour afficher dans le navigateur une photo qu'il ne sait pas lire (HEIC)."""
    img = ImageOps.exif_transpose(open_image(data))
    img = img.convert("RGB")
    img.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def dhash(img: Image.Image) -> str:
    """Empreinte de différence 9×8 : stable après redimensionnement, recompression ou léger ajustement de couleur."""
    g = img.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    px = list(getattr(g, "get_flattened_data", g.getdata)())
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (px[row * 9 + col] > px[row * 9 + col + 1])
    return f"{bits:016x}"


def hash_bytes(data: bytes) -> str:
    return dhash(ImageOps.exif_transpose(open_image(data)))


def hamming(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()


def backfill_phash(limit: int = 5000) -> int:
    """Calcule l'empreinte des photos enregistrées avant la 1.7 (lecture de l'image déjà réduite sur disque)."""
    from ..core import execute, q
    n = 0
    for r in q("SELECT id_spotting id, image FROM spotting WHERE image IS NOT NULL AND phash IS NULL LIMIT ?", (limit,)):
        p = DIRS["images"] / r["image"]
        if not p.is_file():
            continue
        try:
            with Image.open(p) as im:
                execute("UPDATE spotting SET phash = ? WHERE id_spotting = ?", (dhash(im), r["id"]))
            n += 1
        except Exception:  # noqa: BLE001 — une image illisible ne doit pas bloquer les autres
            continue
    return n


def _effort() -> int:
    """Effort d'encodage WebP (0 = très rapide … 6 = le plus compact). 2 par défaut : ~3× plus rapide que 4, fichiers ~10 % plus gros."""
    try:
        return max(0, min(6, int(get_setting("image_effort") if get_setting("image_effort") is not None else 2)))
    except (TypeError, ValueError):
        return 2


def save_image(data: bytes, original_name: str = "") -> dict:
    img = open_image(data)
    exif = extract_exif(img)
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")

    phash = dhash(img)
    max_px = int(get_setting("image_max_px") or 2560)
    quality = int(get_setting("image_quality") or 85)
    sub = datetime.now().strftime("%Y/%m")
    stem = uuid.uuid4().hex
    rel = f"{sub}/{stem}.webp"
    full = DIRS["images"] / rel
    full.parent.mkdir(parents=True, exist_ok=True)

    # Une seule réduction (reducing_gap : décodage/échelle en deux temps, bien plus rapide sur 24 Mpx), la vignette
    # est tirée de la version réduite plutôt que de l'original.
    main = img if max(img.size) <= max_px else img.copy()
    main.thumbnail((max_px, max_px), Image.Resampling.LANCZOS, reducing_gap=2.0)
    effort = _effort()
    main.save(full, "WEBP", quality=quality, method=effort)

    th = main.copy()
    th.thumbnail((THUMB_PX, THUMB_PX), Image.Resampling.LANCZOS, reducing_gap=2.0)
    th_rel = f"{stem}.webp"
    th.save(DIRS["thumbs"] / th_rel, "WEBP", quality=78, method=min(effort, 4))

    if get_setting("keep_originals"):
        ext = Path(original_name).suffix.lower() or ".jpg"
        orig = DIRS["originals"] / sub / f"{stem}{ext}"
        orig.parent.mkdir(parents=True, exist_ok=True)
        orig.write_bytes(data)

    return {"image": rel, "thumb": th_rel, "image_w": main.width, "image_h": main.height, "phash": phash, "exif": exif}


def delete_image(rel: str | None, thumb: str | None) -> None:
    for kind, r in (("images", rel), ("thumbs", thumb)):
        if r:
            p = DIRS[kind] / r
            if p.is_file():
                p.unlink(missing_ok=True)
    if rel:
        stem = Path(rel).stem
        for p in (DIRS["originals"] / Path(rel).parent).glob(f"{stem}.*"):
            p.unlink(missing_ok=True)


def save_audio(data: bytes, filename: str) -> str:
    ext = Path(filename or "").suffix.lower() or ".webm"
    if ext not in ALLOWED_AUDIO:
        raise ValueError("unsupported_audio")
    if len(data) > MAX_AUDIO_BYTES:
        raise ValueError("audio_too_large")
    rel = f"{datetime.now():%Y/%m}/{uuid.uuid4().hex}{ext}"
    p = DIRS["audio"] / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return rel


def delete_audio(rel: str | None) -> None:
    if rel:
        (DIRS["audio"] / rel).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# OCR local (Tesseract) : plusieurs passes de prétraitement, extraction par regex
# --------------------------------------------------------------------------- #
def ocr_available() -> bool:
    return shutil.which("tesseract") is not None


def _variants(img: Image.Image):
    g = ImageOps.grayscale(ImageOps.exif_transpose(img))
    if max(g.size) > 2400:
        g.thumbnail((2400, 2400))
    elif max(g.size) < 1200:
        f = 1200 / max(g.size)
        g = g.resize((int(g.width * f), int(g.height * f)), Image.Resampling.LANCZOS)
    g = ImageOps.autocontrast(g, cutoff=1)
    yield g
    yield ImageOps.invert(g)
    yield g.filter(ImageFilter.SHARPEN).point(lambda p: 255 if p > 140 else 0)
    # Moitié inférieure : l'immatriculation est souvent sur le fuselage arrière / la dérive
    w, h = g.size
    yield g.crop((0, int(h * 0.3), w, h))


def ocr_registration(data: bytes) -> dict:
    if not ocr_available():
        return {"available": False, "candidates": [], "text": ""}
    import pytesseract

    img = open_image(data)
    texts = []
    cfg = "--psm 11 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
    for v in _variants(img):
        try:
            texts.append(pytesseract.image_to_string(v, config=cfg, timeout=20))
        except Exception as e:  # noqa: BLE001
            log.warning("OCR: %s", e)
    # Une immatriculation lue dans plusieurs passes indépendantes est plus fiable
    agg: dict[str, dict] = {}
    for txt in texts:
        for c in regs.extract_candidates(txt):
            a = agg.setdefault(c["registration"], {**c, "score": 0.0, "hits": 0})
            a["score"] += c["score"]
            a["hits"] += 1
    passes = max(len(texts), 1)
    cands = sorted(agg.values(), key=lambda c: (-c["score"], -c["hits"]))[:6]
    for c in cands:
        c["score"] = round(min(1.0, c["score"] / passes * 1.5), 2)
    return {"available": True, "candidates": cands, "text": "\n".join(texts)[:2000]}
