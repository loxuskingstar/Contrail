"""Moteur PDF : thème personnalisable (format, couleur, police, couverture…) et composants réutilisables.

Les documents (bilan, liste de spots, fiche, carnet de vols) sont assemblés dans routers/pdf.py avec ces briques.
"""
from __future__ import annotations

import io
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

from PIL import Image as PILImage
from PIL import ImageDraw
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (BaseDocTemplate, Flowable, Frame, Image, NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

from ..core import DIRS

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "fonts"
I18N_DIR = ROOT.parent / "static" / "i18n"

PAGES = {"A4": A4, "LETTER": letter}
FONT_CHOICES = ("modern", "classic")
COVER_STYLES = ("band", "photo", "minimal")
DENSITIES = ("comfortable", "compact")

MONTHS = {
    "fr": ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
    "en": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    "es": ["ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sep.", "oct.", "nov.", "dic."],
    "ja": [f"{i}月" for i in range(1, 13)],
}
MONTHS_LONG = {
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "ja": [f"{i}月" for i in range(1, 13)],
}


# --------------------------------------------------------------------------- #
# Traductions (mêmes fichiers que l'interface)
# --------------------------------------------------------------------------- #
class Tr:
    def __init__(self, lang: str):
        self.lang = lang if lang in MONTHS else "fr"
        self.d = self._load(self.lang)
        self.fb = self.d if self.lang == "fr" else self._load("fr")

    @staticmethod
    def _load(code: str) -> dict:
        try:
            return json.loads((I18N_DIR / f"{code}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def __call__(self, key: str, **vars) -> str:
        s = self.d.get(key, self.fb.get(key))
        if s is None:
            return key
        if isinstance(s, dict):
            n = vars.get("count", vars.get("n"))
            s = s.get("one" if n == 1 else "other", "")
        return re.sub(r"\{(\w+)\}", lambda m: str(vars.get(m.group(1), "")), s)

    def date(self, iso: str | None, with_time: bool = False) -> str:
        if not iso:
            return "—"
        try:
            d = datetime.fromisoformat(iso[:16] if len(iso) > 10 else iso[:10])
        except ValueError:
            return iso[:10]
        if self.lang == "ja":
            out = f"{d.year}年{d.month}月{d.day}日"
        elif self.lang == "en":
            out = f"{d.day} {MONTHS_LONG['en'][d.month - 1][:3]} {d.year}"
        else:
            out = f"{d.day} {MONTHS['fr' if self.lang == 'fr' else 'es'][d.month - 1]} {d.year}"
        if with_time and len(iso) >= 16:
            out += f" {iso[11:16]}"
        return out

    def month(self, i: int) -> str:
        return MONTHS[self.lang][i]


def num(n) -> str:
    try:
        return f"{int(n):,}".replace(",", " ")
    except (TypeError, ValueError):
        return str(n)


# --------------------------------------------------------------------------- #
# Polices
# --------------------------------------------------------------------------- #
_registered = False
_SUBS = {"★": "*", "☆": "*", "→": ">", "←": "<", "✓": "v", "✈": "", "⚠": "!", " ": " ", " ": " "}


def _register_fonts() -> None:
    global _registered
    if _registered:
        return
    for name, file in (("CT-Sans", "Inter-Regular.ttf"), ("CT-Sans-B", "Inter-Bold.ttf"),
                       ("CT-Serif", "Fraunces-Regular.ttf"), ("CT-Serif-B", "Fraunces-Bold.ttf")):
        pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
    for fam, (n, b) in {"CT-Sans": ("CT-Sans", "CT-Sans-B"), "CT-Serif": ("CT-Serif", "CT-Serif-B")}.items():
        pdfmetrics.registerFontFamily(fam, normal=n, bold=b, italic=n, boldItalic=b)
    for cid in ("HeiseiKakuGo-W5", "HeiseiMin-W3"):
        pdfmetrics.registerFont(UnicodeCIDFont(cid))
        pdfmetrics.registerFontFamily(cid, normal=cid, bold=cid, italic=cid, boldItalic=cid)
    _registered = True


@dataclass
class Fonts:
    body: str
    bold: str
    head: str
    cjk: bool

    @classmethod
    def pick(cls, font: str, lang: str) -> "Fonts":
        _register_fonts()
        if lang == "ja":
            head = "HeiseiMin-W3" if font == "classic" else "HeiseiKakuGo-W5"
            return cls("HeiseiKakuGo-W5", "HeiseiKakuGo-W5", head, True)
        return cls("CT-Sans", "CT-Sans-B", "CT-Serif-B" if font == "classic" else "CT-Sans-B", False)


def _supported(font_name: str) -> set[int] | None:
    try:
        return set(pdfmetrics.getFont(font_name).face.charToGlyph)
    except AttributeError:
        return None          # police CID : tout le japonais est géré


def clean(text, fonts: Fonts) -> str:
    """Remplace ou retire les caractères que la police n'a pas (émojis, étoiles…), puis échappe pour Paragraph."""
    s = "" if text is None else str(text)
    if not fonts.cjk:
        ok = _supported(fonts.body) or set()
        s = "".join(_SUBS.get(ch, ch) if ord(ch) in ok or ch in _SUBS else "" for ch in s)
    else:
        s = "".join(_SUBS.get(ch, ch) for ch in s)
    return _xml_escape(s)


def plain(text, fonts: Fonts) -> str:
    """Comme clean() mais sans échappement XML (pour le texte dessiné directement sur le canevas)."""
    s = clean(text, fonts)
    return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")


# --------------------------------------------------------------------------- #
# Style personnalisable
# --------------------------------------------------------------------------- #
def _bool(v, default: bool) -> bool:
    if v is None or v == "":
        return default
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("1", "true", "yes", "on")


@dataclass
class Style:
    page: str = "A4"
    orient: str = "portrait"
    accent: str = "#3b82f6"
    font: str = "modern"
    cover: bool = True
    cover_style: str = "band"
    photos: bool = True
    density: str = "comfortable"
    footer: str = ""
    author: str = ""
    lang: str = "fr"

    @classmethod
    def build(cls, settings: dict, over: dict | None = None) -> "Style":
        over = over or {}

        def pick(key: str):
            v = over.get(key)
            return v if v not in (None, "") else settings.get(f"pdf_{key}")

        s = cls()
        page = str(pick("page") or "A4").upper()
        s.page = page if page in PAGES else "A4"
        s.orient = "landscape" if str(pick("orient")) == "landscape" else "portrait"
        acc = str(pick("accent") or settings.get("accent") or "#3b82f6")
        s.accent = acc if re.fullmatch(r"#[0-9a-fA-F]{6}", acc) else "#3b82f6"
        f = str(pick("font") or "modern")
        s.font = f if f in FONT_CHOICES else "modern"
        s.cover = _bool(pick("cover"), True)
        cs = str(pick("cover_style") or "band")
        s.cover_style = cs if cs in COVER_STYLES else "band"
        s.photos = _bool(pick("photos"), True)
        d = str(pick("density") or "comfortable")
        s.density = d if d in DENSITIES else "comfortable"
        s.footer = str(pick("footer") or "")[:120]
        s.author = str(pick("author") or settings.get("photographer") or "")[:80]
        lang = str(settings.get("language") or "fr")
        s.lang = lang if lang in MONTHS else "fr"
        return s

    @property
    def pagesize(self):
        w, h = PAGES[self.page]
        return (h, w) if self.orient == "landscape" else (w, h)

    @property
    def margin(self) -> float:
        return (12 if self.density == "compact" else 17) * mm


class Palette:
    def __init__(self, accent: str):
        self.accent = colors.HexColor(accent)
        r, g, b = self.accent.red, self.accent.green, self.accent.blue
        mix = lambda k: colors.Color(1 - (1 - r) * k, 1 - (1 - g) * k, 1 - (1 - b) * k)    # noqa: E731
        self.soft = mix(0.10)            # fond très léger
        self.mid = mix(0.30)
        self.tint = mix(0.55)
        self.dark = colors.Color(r * 0.62, g * 0.62, b * 0.62)
        self.ink = colors.HexColor("#111827")
        self.muted = colors.HexColor("#6b7280")
        self.line = colors.HexColor("#e5e7eb")
        self.surface = colors.HexColor("#f6f7f9")
        self.good = colors.HexColor("#15803d")
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        self.on_accent = colors.white if lum < 0.72 else self.ink


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
def image_file(kind: str, name: str | None) -> Path | None:
    if not name:
        return None
    base = Path(DIRS[kind]).resolve()
    p = (base / name).resolve()
    return p if p.is_file() and base in p.parents else None


def image_data(kind: str, name: str | None, size: tuple[int, int], radius: int = 0, fit: str = "cover", shade: bool = False) -> io.BytesIO | None:
    """Image redimensionnée (recadrée au format voulu) en JPEG ; coins arrondis sur fond blanc si radius > 0."""
    p = image_file(kind, name)
    if not p:
        return None
    try:
        with PILImage.open(p) as im:
            im = im.convert("RGB")
            tw, th = size
            if fit == "cover":
                ratio = max(tw / im.width, th / im.height)
                nw, nh = max(1, round(im.width * ratio)), max(1, round(im.height * ratio))
                im = im.resize((nw, nh), PILImage.LANCZOS)
                l, t = (nw - tw) // 2, (nh - th) // 2
                im = im.crop((l, t, l + tw, t + th))
            else:                                           # contain : on garde le format d'origine
                im.thumbnail((tw, th), PILImage.LANCZOS)
            if shade:                                       # voile sombre vers le bas : le titre de couverture reste lisible
                grad = PILImage.linear_gradient("L").resize(im.size)
                alpha = grad.point(lambda v: int(((v / 255) ** 1.5) * 0.88 * 255))
                im = PILImage.composite(PILImage.new("RGB", im.size, (8, 10, 16)), im, alpha)
            if radius:
                mask = ImageDraw.Draw(m := PILImage.new("L", im.size, 0))
                mask.rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=radius, fill=255)
                bg = PILImage.new("RGB", im.size, "white")
                bg.paste(im, mask=m)
                im = bg
            out = io.BytesIO()
            im.save(out, "JPEG", quality=84, optimize=True)
            out.seek(0)
            return out
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Composants graphiques
# --------------------------------------------------------------------------- #
class Heading(Flowable):
    def __init__(self, text: str, B: "Builder", level: int = 1):
        super().__init__()
        self.B, self.level = B, level
        self.text = plain(text, B.F)
        self.keepWithNext = True
        self.h = (9 if level == 1 else 6.5) * mm

    def wrap(self, aw, ah):
        self.w = aw
        return aw, self.h

    def draw(self):
        B, c = self.B, self.canv
        size = 13.5 if self.level == 1 else 9
        c.setFillColor(B.P.accent)
        if self.level == 1:
            c.roundRect(0, 1.3 * mm, 1.3 * mm, 5.2 * mm, 0.6 * mm, stroke=0, fill=1)
            c.setFillColor(B.P.ink)
            c.setFont(B.F.head, size)
            c.drawString(3.6 * mm, 1.9 * mm, _fit(self.text, B.F.head, size, self.w - 4 * mm))
        else:
            c.setFillColor(B.P.dark)
            c.setFont(B.F.bold, size)
            c.drawString(0, 1.6 * mm, _fit(self.text.upper() if not B.F.cjk else self.text, B.F.bold, size, self.w))


def _fit(text: str, font: str, size: float, width: float) -> str:
    if stringWidth(text, font, size) <= width:
        return text
    while text and stringWidth(text + "…", font, size) > width:
        text = text[:-1]
    return text.rstrip() + "…"


class KpiGrid(Flowable):
    def __init__(self, items: list[tuple], B: "Builder", cols: int = 4):
        super().__init__()
        self.items, self.B, self.cols = items, B, cols
        self.gap = 3 * mm
        self.th = (17 if B.S.density == "compact" else 21) * mm

    def wrap(self, aw, ah):
        self.w = aw
        rows = -(-len(self.items) // self.cols)
        self.h = rows * self.th + (rows - 1) * self.gap
        return aw, self.h

    def draw(self):
        B, c = self.B, self.canv
        tw = (self.w - self.gap * (self.cols - 1)) / self.cols
        for i, it in enumerate(self.items):
            value, label = it[0], it[1]
            delta = it[2] if len(it) > 2 else ""
            good = it[3] if len(it) > 3 else False
            col, row = i % self.cols, i // self.cols
            x = col * (tw + self.gap)
            y = self.h - (row + 1) * self.th - row * self.gap
            c.setFillColor(B.P.soft)
            c.roundRect(x, y, tw, self.th, 3 * mm, stroke=0, fill=1)
            c.setFillColor(B.P.accent)
            c.roundRect(x, y + 3 * mm, 0.9 * mm, self.th - 6 * mm, 0.45 * mm, stroke=0, fill=1)
            c.setFillColor(B.P.ink)
            c.setFont(B.F.head, 19)
            c.drawString(x + 4.2 * mm, y + self.th - 9.5 * mm, plain(value, B.F))
            c.setFillColor(B.P.muted)
            c.setFont(B.F.bold, 7.8)
            c.drawString(x + 4.2 * mm, y + self.th - 14 * mm, _fit(plain(label, B.F), B.F.bold, 7.8, tw - 6 * mm))
            if delta:
                c.setFillColor(B.P.good if good else B.P.muted)
                c.setFont(B.F.body, 6.8)
                c.drawString(x + 4.2 * mm, y + 2.6 * mm, _fit(plain(delta, B.F), B.F.body, 6.8, tw - 6 * mm))


class BarChart(Flowable):
    def __init__(self, labels: list[str], values: list[int], B: "Builder", height: float = 46 * mm):
        super().__init__()
        self.labels, self.values, self.B, self.h = labels, values, B, height

    def wrap(self, aw, ah):
        self.w = aw
        return aw, self.h

    def draw(self):
        B, c = self.B, self.canv
        n = len(self.values)
        top = max(self.values + [1])
        base, head = 6.5 * mm, 5.5 * mm
        ch = self.h - base - head
        slot = self.w / n
        bw = min(slot * 0.62, 15 * mm)
        c.setStrokeColor(B.P.line)
        c.setLineWidth(0.4)
        for k in (0.5, 1):
            c.line(0, base + ch * k, self.w, base + ch * k)
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.line(0, base, self.w, base)
        for i, v in enumerate(self.values):
            x = i * slot + (slot - bw) / 2
            bh = max(0.7 * mm, ch * v / top) if v else 0.7 * mm
            c.setFillColor(B.P.accent if v == top and v else (B.P.tint if v else B.P.line))
            r = min(1.4 * mm, bw / 2, bh)
            c.roundRect(x, base, bw, bh, r, stroke=0, fill=1)
            c.rect(x, base, bw, min(bh, r + 0.3 * mm), stroke=0, fill=1)          # base droite, sommet arrondi
            if v:
                c.setFillColor(B.P.ink)
                c.setFont(B.F.bold, 7.5)
                c.drawCentredString(x + bw / 2, base + bh + 1.4 * mm, str(v))
            c.setFillColor(B.P.muted)
            c.setFont(B.F.body, 7)
            c.drawCentredString(x + bw / 2, 2 * mm, plain(self.labels[i], B.F))


class RankList(Flowable):
    """Classement avec barres proportionnelles : items = [(libellé, détail, nombre)]."""

    def __init__(self, items: list[tuple], B: "Builder"):
        super().__init__()
        self.items, self.B = items, B
        self.rh, self.gap = 6.4 * mm, 1.1 * mm

    def wrap(self, aw, ah):
        self.w = aw
        n = max(1, len(self.items))
        self.h = n * self.rh + (n - 1) * self.gap
        return aw, self.h

    def draw(self):
        B, c = self.B, self.canv
        if not self.items:
            c.setFillColor(B.P.muted)
            c.setFont(B.F.body, 8.5)
            c.drawString(0, 2 * mm, "—")
            return
        top = max(it[2] for it in self.items) or 1
        for i, (label, sub, n) in enumerate(self.items):
            y = self.h - (i + 1) * self.rh - i * self.gap
            c.setFillColor(B.P.surface)
            c.roundRect(0, y, self.w, self.rh, 1.6 * mm, stroke=0, fill=1)
            c.setFillColor(B.P.mid)
            c.roundRect(0, y, max(2.5 * mm, self.w * n / top), self.rh, 1.6 * mm, stroke=0, fill=1)
            c.setFillColor(B.P.dark)
            c.setFont(B.F.bold, 8)
            c.drawString(2.2 * mm, y + 2.1 * mm, f"{i + 1}")
            txt = plain(label, B.F)
            cn = str(num(n))
            room = self.w - 12 * mm - stringWidth(cn, B.F.bold, 8.3)
            c.setFillColor(B.P.ink)
            c.setFont(B.F.body, 8.3)
            shown = _fit(txt, B.F.body, 8.3, room)
            c.drawString(7 * mm, y + 2.1 * mm, shown)
            if sub and stringWidth(shown, B.F.body, 8.3) + stringWidth(sub, B.F.body, 7) + 8 * mm < room:
                c.setFillColor(B.P.muted)
                c.setFont(B.F.body, 7)
                c.drawString(7 * mm + stringWidth(shown, B.F.body, 8.3) + 2 * mm, y + 2.2 * mm, plain(sub, B.F))
            c.setFillColor(B.P.ink)
            c.setFont(B.F.bold, 8.3)
            c.drawRightString(self.w - 2.2 * mm, y + 2.1 * mm, cn)


# --------------------------------------------------------------------------- #
# Assemblage
# --------------------------------------------------------------------------- #
class Builder:
    def __init__(self, style: Style, title: str, subtitle: str = "", kicker: str = ""):
        self.S, self.T = style, Tr(style.lang)
        self.F = Fonts.pick(style.font, style.lang)
        self.P = Palette(style.accent)
        self.title, self.subtitle, self.kicker = title, subtitle, kicker
        self.story: list = []
        self.cover_stats: list[tuple[str, str]] = []
        self.hero: io.BytesIO | None = None
        pw, ph = style.pagesize
        self.W = pw - 2 * style.margin
        self.generated = self.T.date(datetime.now().strftime("%Y-%m-%dT%H:%M"))
        compact = style.density == "compact"
        self.base_size = 8.6 if compact else 9.4
        self.styles = {
            "body": ParagraphStyle("body", fontName=self.F.body, fontSize=self.base_size, leading=self.base_size * 1.45, textColor=self.P.ink),
            "small": ParagraphStyle("small", fontName=self.F.body, fontSize=7.8, leading=10.5, textColor=self.P.muted),
            "cell": ParagraphStyle("cell", fontName=self.F.body, fontSize=7.9 if compact else 8.4, leading=10.4 if compact else 11.2, textColor=self.P.ink),
            "cellb": ParagraphStyle("cellb", fontName=self.F.bold, fontSize=7.9 if compact else 8.4, leading=10.4 if compact else 11.2, textColor=self.P.ink),
            "th": ParagraphStyle("th", fontName=self.F.bold, fontSize=7.4, leading=9, textColor=self.P.on_accent),
            "chip": ParagraphStyle("chip", fontName=self.F.body, fontSize=8, leading=14.5, textColor=self.P.dark),
            "title": ParagraphStyle("title", fontName=self.F.head, fontSize=26, leading=30, textColor=self.P.ink),
            "sub": ParagraphStyle("sub", fontName=self.F.body, fontSize=10.5, leading=14, textColor=self.P.muted),
            "cap": ParagraphStyle("cap", fontName=self.F.bold, fontSize=7.8, leading=10, textColor=self.P.ink, alignment=1),
            "capsub": ParagraphStyle("capsub", fontName=self.F.body, fontSize=6.8, leading=8.5, textColor=self.P.muted, alignment=1),
        }
        self.gap = (3.2 if compact else 5) * mm

    # ---- briques -----------------------------------------------------------
    def add(self, *flow) -> None:
        self.story.extend(flow)

    def space(self, mm_: float | None = None) -> None:
        self.story.append(Spacer(1, self.gap if mm_ is None else mm_ * mm))

    def h1(self, text: str) -> Heading:
        return Heading(text, self, 1)

    def h2(self, text: str) -> Heading:
        return Heading(text, self, 2)

    def para(self, text: str, style: str = "body", raw: bool = False) -> Paragraph:
        return Paragraph(text if raw else clean(text, self.F), self.styles[style])

    def kpis(self, items: list[tuple], cols: int | None = None) -> KpiGrid:
        cols = cols or (4 if self.W > 150 * mm else 2)
        return KpiGrid(items, self, min(cols, max(1, len(items))))

    def chips(self, labels: list[str], extra: int = 0) -> Paragraph:
        if not labels:
            return self.para("—", "small")
        bg = self.P.soft.hexval()[2:]
        bits = [f'<font backColor="#{bg}">&nbsp;{clean(x, self.F)}&nbsp;</font>' for x in labels]
        if extra > 0:
            bits.append(f'<font color="#{self.P.muted.hexval()[2:]}">+{extra}</font>')
        return Paragraph("  ".join(bits), self.styles["chip"])

    def columns(self, blocks: list[list], n: int = 2) -> Table:
        """Blocs côte à côte (chaque bloc = liste de flowables)."""
        gap = 6 * mm
        cw = (self.W - gap * (n - 1)) / n
        rows = []
        for i in range(0, len(blocks), n):
            row = []
            for j in range(n):
                row.append(blocks[i + j] if i + j < len(blocks) else "")
            rows.append(row)
        widths = []
        for j in range(n):
            widths += [cw] + ([gap] if j < n - 1 else [])
        data = [sum(([cell, ""] if k < n - 1 else [cell] for k, cell in enumerate(r)), []) for r in rows]
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), self.gap)]))
        return t

    def photo_grid(self, items: list[dict], cols: int = 3) -> Table | Spacer:
        """items = [{thumb, kind?, caption, sub}] → grille de vignettes à coins arrondis."""
        gap = 4 * mm
        cw = (self.W - gap * (cols - 1)) / cols
        iw, ih = cw, cw * 2 / 3
        px = (int(iw / mm * 9), int(ih / mm * 9))
        cells = []
        for it in items:
            data = image_data(it.get("kind", "thumbs"), it.get("thumb"), px, radius=26)
            parts = [Image(data, width=iw, height=ih)] if data else [Spacer(1, ih)]
            parts.append(Spacer(1, 1.2 * mm))
            parts.append(Paragraph(clean(it.get("caption", ""), self.F), self.styles["cap"]))
            if it.get("sub"):
                parts.append(Paragraph(clean(it["sub"], self.F), self.styles["capsub"]))
            cells.append(parts)
        if not cells:
            return Spacer(1, 1)
        rows = [cells[i:i + cols] + [""] * (cols - len(cells[i:i + cols])) for i in range(0, len(cells), cols)]
        data = [sum(([c, ""] if k < cols - 1 else [c] for k, c in enumerate(r)), []) for r in rows]
        widths = []
        for j in range(cols):
            widths += [cw] + ([gap] if j < cols - 1 else [])
        t = Table(data, colWidths=widths)
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 4 * mm)]))
        return t

    def keyvals(self, pairs: list[tuple[str, str]], cols: int = 2) -> Table:
        pairs = [(k, v) for k, v in pairs if v not in (None, "", "—")]
        if not pairs:
            return Spacer(1, 1)
        rows = []
        for i in range(0, len(pairs), cols):
            chunk = pairs[i:i + cols]
            row = []
            for k, v in chunk:
                row += [Paragraph(clean(k, self.F), self.styles["small"]), Paragraph(clean(v, self.F), self.styles["cellb"])]
            while len(row) < cols * 2:
                row += ["", ""]
            rows.append(row)
        lw = 27 * mm
        vw = (self.W - lw * cols) / cols
        t = Table(rows, colWidths=[lw, vw] * cols)
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, self.P.line),
                               ("TOPPADDING", (0, 0), (-1, -1), 3.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2),
                               ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
        return t

    def table(self, header: list[str], rows: list[list], widths: list[float], aligns: list[str] | None = None) -> Table:
        """Tableau avec en-tête répété. Les cellules sont du texte, un Paragraph ou une image (BytesIO + taille)."""
        head = [Paragraph(clean(h, self.F), self.styles["th"]) for h in header]
        body = []
        for r in rows:
            row = []
            for c in r:
                if isinstance(c, (Paragraph, Image, Flowable)):
                    row.append(c)
                else:
                    row.append(Paragraph(clean(c, self.F), self.styles["cell"]))
            body.append(row)
        t = Table([head] + body, colWidths=widths, repeatRows=1)
        pad = 3 if self.S.density == "compact" else 4.2
        st = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BACKGROUND", (0, 0), (-1, 0), self.P.accent),
              ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
              ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
              ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, self.P.surface]),
              ("LINEBELOW", (0, -1), (-1, -1), 0.6, self.P.line), ("ROUNDEDCORNERS", [2.2 * mm, 2.2 * mm, 0, 0])]
        t.setStyle(TableStyle(st))
        return t

    def title_block(self) -> None:
        """En-tête de la première page quand il n'y a pas de couverture."""
        self.add(Paragraph(clean(self.title, self.F), self.styles["title"]))
        if self.subtitle:
            self.add(Spacer(1, 1.5 * mm), Paragraph(clean(self.subtitle, self.F), self.styles["sub"]))
        self.add(Spacer(1, 2 * mm), _Rule(self), Spacer(1, 4 * mm))

    # ---- rendu --------------------------------------------------------------
    def render(self) -> bytes:
        S, F, P = self.S, self.F, self.P
        pw, ph = S.pagesize
        m = S.margin
        buf = io.BytesIO()
        header_h, footer_h = 13 * mm, 11 * mm
        doc = BaseDocTemplate(buf, pagesize=(pw, ph), leftMargin=m, rightMargin=m, topMargin=header_h + 4 * mm, bottomMargin=footer_h + 3 * mm,
                              title=plain(self.title, F), author=plain(S.author or "Contrail", F), subject=plain(self.subtitle, F), creator="Contrail")
        body_frame = Frame(m, footer_h + 3 * mm, pw - 2 * m, ph - header_h - footer_h - 7 * mm, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        cover_frame = Frame(m, m, pw - 2 * m, 5, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        story = list(self.story)
        templates = [PageTemplate(id="body", frames=[body_frame], onPage=self._decorate)]
        if S.cover:
            templates.insert(0, PageTemplate(id="cover", frames=[cover_frame], onPage=self._cover))
            story = [NextPageTemplate("body"), PageBreak()] + story
        else:
            story = self.story_with_title()
        doc.addPageTemplates(templates)
        footer_text = plain(S.footer or "Contrail", F)
        has_cover = S.cover

        class Numbered(rl_canvas.Canvas):
            def __init__(cv, *a, **k):
                super().__init__(*a, **k)
                cv._pages = []

            def showPage(cv):
                cv._pages.append(dict(cv.__dict__))
                cv._startPage()

            def save(cv):
                total = len(cv._pages)
                for i, state in enumerate(cv._pages):
                    cv.__dict__.update(state)
                    if not (has_cover and i == 0):
                        cv.setStrokeColor(P.line)
                        cv.setLineWidth(0.5)
                        cv.line(m, footer_h, pw - m, footer_h)
                        cv.setFont(F.body, 7.4)
                        cv.setFillColor(P.muted)
                        cv.drawString(m, footer_h - 4.6 * mm, _fit(footer_text, F.body, 7.4, pw - 2 * m - 30 * mm))
                        cv.drawRightString(pw - m, footer_h - 4.6 * mm, f"{i + 1} / {total}")
                    super().showPage()
                super().save()

        doc.build(story, canvasmaker=Numbered)
        return buf.getvalue()

    def story_with_title(self) -> list:
        saved, self.story = self.story, []
        self.title_block()
        head = self.story
        self.story = saved
        return head + saved

    def _decorate(self, c, doc) -> None:
        S, F, P = self.S, self.F, self.P
        pw, ph = S.pagesize
        m = S.margin
        c.saveState()
        c.setFillColor(P.accent)
        c.rect(0, ph - 2.2 * mm, pw, 2.2 * mm, stroke=0, fill=1)
        c.setFont(F.bold, 7.6)
        c.setFillColor(P.ink)
        c.drawString(m, ph - 9.2 * mm, _fit(plain(self.title, F), F.bold, 7.6, pw - 2 * m - 50 * mm))
        c.setFont(F.body, 7.4)
        c.setFillColor(P.muted)
        c.drawRightString(pw - m, ph - 9.2 * mm, self.generated)
        c.restoreState()

    def _cover(self, c, doc) -> None:
        S, F, P, T = self.S, self.F, self.P, self.T
        pw, ph = S.pagesize
        m = max(S.margin, 18 * mm)
        style = S.cover_style
        if style == "photo" and not self.hero:
            style = "band"
        c.saveState()
        stats_top = ph * (0.40 if style != "minimal" else 0.44)
        if style in ("band", "photo"):
            bh = ph * 0.58
            y0 = ph - bh
            if style == "photo":
                from reportlab.lib.utils import ImageReader
                c.drawImage(ImageReader(self.hero), 0, y0, pw, bh)
                c.setFillColor(P.accent)
                c.rect(0, y0 - 1.6 * mm, pw, 1.6 * mm, stroke=0, fill=1)
                tcol = colors.white
            else:
                c.setFillColor(P.accent)
                c.rect(0, y0, pw, bh, stroke=0, fill=1)
                c.setFillColor(colors.Color(1, 1, 1, alpha=0.07))
                c.circle(pw * 0.88, ph - bh * 0.12, bh * 0.55, stroke=0, fill=1)
                c.circle(pw * 0.70, y0 + bh * 0.05, bh * 0.30, stroke=0, fill=1)
                tcol = P.on_accent
            tw = pw - 2 * m
            ts = ParagraphStyle("ct", fontName=F.head, fontSize=40 if len(self.title) < 28 else 32, leading=(46 if len(self.title) < 28 else 38), textColor=tcol)
            para = Paragraph(clean(self.title, F), ts)
            _, th = para.wrap(tw, bh)
            ty = y0 + 20 * mm
            para.drawOn(c, m, ty)
            if self.subtitle:
                sp = Paragraph(clean(self.subtitle, F), ParagraphStyle("cs", fontName=F.body, fontSize=12.5, leading=17, textColor=tcol))
                _, sh = sp.wrap(tw, 40 * mm)
                sp.drawOn(c, m, ty - sh - 3 * mm)
            if self.kicker:
                c.setFillColor(tcol)
                c.setFont(F.bold, 9)
                c.drawString(m, ty + th + 6 * mm, plain(self.kicker.upper() if not F.cjk else self.kicker, F))
        else:
            c.setFillColor(P.accent)
            c.roundRect(m, ph - 40 * mm, 22 * mm, 2.2 * mm, 1.1 * mm, stroke=0, fill=1)
            tw = pw - 2 * m
            if self.kicker:
                c.setFillColor(P.dark)
                c.setFont(F.bold, 9)
                c.drawString(m, ph - 52 * mm, plain(self.kicker.upper() if not F.cjk else self.kicker, F))
            para = Paragraph(clean(self.title, F), ParagraphStyle("ct", fontName=F.head, fontSize=42 if len(self.title) < 26 else 32, leading=48 if len(self.title) < 26 else 38, textColor=P.ink))
            _, th = para.wrap(tw, 90 * mm)
            para.drawOn(c, m, ph - 58 * mm - th)
            if self.subtitle:
                sp = Paragraph(clean(self.subtitle, F), ParagraphStyle("cs", fontName=F.body, fontSize=13, leading=18, textColor=P.muted))
                _, sh = sp.wrap(tw, 40 * mm)
                sp.drawOn(c, m, ph - 62 * mm - th - sh)
        # chiffres clés
        stats = self.cover_stats[:4]
        if stats:
            n = len(stats)
            cw = (pw - 2 * m) / n
            y = stats_top - 12 * mm if style != "minimal" else stats_top - 8 * mm
            for i, (v, lbl) in enumerate(stats):
                x = m + i * cw
                if i:
                    c.setStrokeColor(P.line)
                    c.setLineWidth(0.6)
                    c.line(x - 4 * mm, y - 2 * mm, x - 4 * mm, y + 13 * mm)
                c.setFillColor(P.dark)
                c.setFont(F.head, 27)
                c.drawString(x, y, plain(v, F))
                c.setFillColor(P.muted)
                c.setFont(F.bold, 8.2)
                c.drawString(x, y - 6 * mm, _fit(plain(lbl, F), F.bold, 8.2, cw - 8 * mm))
        # pied de couverture
        c.setStrokeColor(P.line)
        c.setLineWidth(0.6)
        c.line(m, 24 * mm, pw - m, 24 * mm)
        c.setFillColor(P.ink)
        c.setFont(F.bold, 9)
        who = S.author or ""
        if who:
            c.drawString(m, 17 * mm, _fit(plain(who, F), F.bold, 9, pw - 2 * m - 60 * mm))
        c.setFillColor(P.muted)
        c.setFont(F.body, 8)
        c.drawString(m, 12.5 * mm, plain(f"{T('pdf.generated')} {self.generated}", F))
        c.setFillColor(P.accent)
        c.setFont(F.bold, 10)
        c.drawRightString(pw - m, 15 * mm, "Contrail")
        c.restoreState()


class _Rule(Flowable):
    def __init__(self, B: Builder):
        super().__init__()
        self.B = B

    def wrap(self, aw, ah):
        self.w = aw
        return aw, 1.2 * mm

    def draw(self):
        c = self.canv
        c.setStrokeColor(self.B.P.accent)
        c.setLineWidth(1.4)
        c.line(0, 0.6 * mm, 18 * mm, 0.6 * mm)
        c.setStrokeColor(self.B.P.line)
        c.setLineWidth(0.6)
        c.line(18 * mm, 0.6 * mm, self.w, 0.6 * mm)
