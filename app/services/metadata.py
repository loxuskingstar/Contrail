"""Export de photos avec métadonnées IPTC-IIM et XMP (titre, légende, mots-clés, lieu, date, GPS, auteur).

Les segments sont écrits à la main dans le JPEG : une photo d'origine n'est pas ré-encodée, les métadonnées
déjà présentes (EXIF) sont conservées, seuls les anciens blocs XMP / IPTC sont remplacés.
"""
from __future__ import annotations

import io
import struct
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image

from ..core import DIRS, get_setting, q
from . import geo

APP_NAME = "Contrail"


def keywords_for(s: dict, tags: list[str]) -> list[str]:
    out: list[str] = []
    for v in (s.get("registration") if not str(s.get("registration") or "").startswith("SANS-IMMAT") else None,
              s.get("test_registration"), s.get("aircraft_icao"), s.get("aircraft"), s.get("manufacturer"), s.get("owner"),
              s.get("airport"), s.get("livery"), *tags):
        v = (v or "").strip() if isinstance(v, str) or v is None else str(v)
        if v and v not in out:
            out.append(v)
    if s.get("military"):
        out.append("military")
    return out[:60]


def describe(s: dict) -> tuple[str, str]:
    """(titre, légende)."""
    reg = s.get("registration") or ""
    reg = "" if reg.startswith("SANS-IMMAT") else reg
    kind = s.get("aircraft") or s.get("aircraft_icao") or ""
    title = " — ".join(x for x in (reg, kind) if x)
    where = s.get("airport") or s.get("place") or ""
    ap = geo.airport(s.get("airport")) if s.get("airport") else None
    if ap:
        where = f"{ap['name']} ({ap['icao']})"
    parts = [title, s.get("owner") or "", s.get("livery") or "", where, (s.get("date") or "")[:16].replace("T", " ")]
    caption = " · ".join(p for p in parts if p)
    if s.get("notes"):
        caption += f"\n{s['notes']}"
    return title or "Spot", caption


# --------------------------------------------------------------------------- #
# IPTC-IIM (segment APP13 « Photoshop 3.0 »)
# --------------------------------------------------------------------------- #
def _ds(tag: int, value: str) -> bytes:
    b = value.encode("utf-8")[:2000]
    return b"\x1c\x02" + bytes([tag]) + struct.pack(">H", len(b)) + b


def build_iptc(s: dict, title: str, caption: str, kws: list[str], author: str, copyright_: str) -> bytes:
    data = b"\x1c\x01\x5a\x00\x03\x1b\x25\x47"            # codage UTF-8 (ESC % G)
    data += _ds(5, title[:64])
    for k in kws:
        data += _ds(25, k[:64])
    d = (s.get("date") or "")
    if len(d) >= 10:
        data += _ds(55, d[:10].replace("-", ""))
        if len(d) >= 16:
            data += _ds(60, d[11:16].replace(":", "") + "00")
    if author:
        data += _ds(80, author[:32])
    ap = geo.airport(s.get("airport")) if s.get("airport") else None
    city = (ap or {}).get("city") or s.get("place") or ""
    if city:
        data += _ds(90, city[:32])
    if (ap or {}).get("country"):
        data += _ds(100, ap["country"][:3])
    if copyright_:
        data += _ds(116, copyright_[:128])
    data += _ds(120, caption[:2000])
    data += _ds(122, author[:32]) if author else b""
    name = b"\x00\x00"
    block = b"8BIM" + struct.pack(">H", 0x0404) + name + struct.pack(">I", len(data)) + data + (b"\x00" if len(data) % 2 else b"")
    return b"Photoshop 3.0\x00" + block


# --------------------------------------------------------------------------- #
# XMP
# --------------------------------------------------------------------------- #
def _gps(v: float, pos: str, neg: str) -> str:
    a = abs(v)
    return f"{int(a)},{(a - int(a)) * 60:.5f}{pos if v >= 0 else neg}"


def build_xmp(s: dict, title: str, caption: str, kws: list[str], author: str, copyright_: str) -> bytes:
    e = escape
    alt = lambda text: f'<rdf:Alt><rdf:li xml:lang="x-default">{e(text)}</rdf:li></rdf:Alt>'
    d = (s.get("date") or "")
    iso = d[:19] + ("" if len(d) > 16 else "") if d else ""
    lat, lng = s.get("lat"), s.get("lng")
    if lat is None and s.get("airport"):
        ap = geo.airport(s["airport"])
        lat, lng = (ap or {}).get("lat"), (ap or {}).get("lng")
    ap = geo.airport(s.get("airport")) if s.get("airport") else None
    props = [f"<dc:title>{alt(title)}</dc:title>", f"<dc:description>{alt(caption)}</dc:description>",
             f"<dc:subject><rdf:Bag>{''.join(f'<rdf:li>{e(k)}</rdf:li>' for k in kws)}</rdf:Bag></dc:subject>",
             f"<xmp:CreatorTool>{APP_NAME}</xmp:CreatorTool>"]
    if author:
        props.append(f"<dc:creator><rdf:Seq><rdf:li>{e(author)}</rdf:li></rdf:Seq></dc:creator>")
    if copyright_:
        props.append(f"<dc:rights>{alt(copyright_)}</dc:rights>")
    if iso:
        props.append(f"<photoshop:DateCreated>{e(iso)}</photoshop:DateCreated>")
    if s.get("favorite"):
        props.append("<xmp:Rating>5</xmp:Rating>")
    loc = ap or {}
    if loc.get("city") or s.get("place"):
        props.append(f"<photoshop:City>{e(loc.get('city') or s.get('place'))}</photoshop:City>")
    if loc.get("country"):
        props.append(f"<photoshop:Country>{e(loc['country'])}</photoshop:Country>")
    if lat is not None and lng is not None:
        props.append(f"<exif:GPSLatitude>{_gps(lat, 'N', 'S')}</exif:GPSLatitude><exif:GPSLongitude>{_gps(lng, 'E', 'W')}</exif:GPSLongitude>")
    xml = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
           '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" '
           'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
           'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/">'
           f'{"".join(props)}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
    return b"http://ns.adobe.com/xap/1.0/\x00" + xml.encode("utf-8")


# --------------------------------------------------------------------------- #
# Injection dans le JPEG
# --------------------------------------------------------------------------- #
def inject(jpeg: bytes, xmp: bytes, iptc: bytes) -> bytes:
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("not_a_jpeg")
    out, i, n = [b"\xff\xd8"], 2, len(jpeg)
    head: list[bytes] = []          # APP0 / EXIF conservés, métadonnées neuves ensuite
    while i + 4 <= n and jpeg[i] == 0xFF:
        m = jpeg[i + 1]
        if m == 0xDA or m == 0xD9:
            break
        ln = struct.unpack(">H", jpeg[i + 2:i + 4])[0]
        seg = jpeg[i:i + 2 + ln]
        body = seg[4:]
        old_xmp = m == 0xE1 and body.startswith(b"http://ns.adobe.com/xap/1.0/\x00")
        old_iptc = m == 0xED and body.startswith(b"Photoshop 3.0\x00")
        if not (old_xmp or old_iptc):
            head.append(seg)
        i += 2 + ln
    mk = lambda marker, payload: bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload
    keep_first = [h for h in head if h[1] in (0xE0, 0xE1)]
    rest = [h for h in head if h not in keep_first]
    return b"".join(out + keep_first + [mk(0xE1, xmp[:65500]), mk(0xED, iptc[:65500])] + rest) + jpeg[i:]


def _source_jpeg(s: dict) -> bytes | None:
    """JPEG d'origine si conservé, sinon image traitée convertie (qualité 93, sans ré-échantillonnage)."""
    stem = Path(s["image"]).stem if s.get("image") else None
    if not stem:
        return None
    sub = str(Path(s["image"]).parent)
    for p in (DIRS["originals"] / sub).glob(f"{stem}.*"):
        b = p.read_bytes()
        if b[:2] == b"\xff\xd8":
            return b
    full = DIRS["images"] / s["image"]
    if not full.is_file():
        return None
    with Image.open(full) as im:
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=93, optimize=True)
        return buf.getvalue()


def export_spot(s: dict) -> tuple[bytes, str] | None:
    """(JPEG avec métadonnées, nom de fichier) ou None sans photo."""
    raw = _source_jpeg(s)
    if raw is None:
        return None
    tags = [r["name"] for r in q("SELECT t.name FROM spotting_tags st JOIN tags t USING(id_tag) WHERE st.id_spotting = ?", (s["id_spotting"],))]
    title, caption = describe(s)
    kws = keywords_for(s, tags)
    author = str(get_setting("photographer") or "")
    cr = str(get_setting("copyright") or "") or (f"© {datetime.now().year} {author}" if author else "")
    data = inject(raw, build_xmp(s, title, caption, kws, author, cr), build_iptc(s, title, caption, kws, author, cr))
    reg = "".join(c for c in (s.get("registration") or "spot") if c.isalnum() or c in "-_") or "spot"
    return data, f"{reg}_{(s.get('date') or '')[:10] or s['id_spotting']}_{s['id_spotting']}.jpg"
