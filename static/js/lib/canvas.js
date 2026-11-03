// Outils de dessin Canvas partagés par le générateur de story et le partage en image d'un spot.

export const FONTS = {
  sans: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  serif: '"Fraunces Variable", Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
  hand: '"Caveat", "Segoe Print", cursive',
};

let fontsReady = null;
/** Charge les polices embarquées avant de dessiner (le canvas n'attend pas les @font-face). */
export function loadFonts() {
  if (!fontsReady) {
    const specs = ['400 20px "Inter Variable"', '700 20px "Inter Variable"', '800 20px "Inter Variable"',
      '400 20px "JetBrains Mono Variable"', '700 20px "JetBrains Mono Variable"',
      '400 20px "Fraunces Variable"', '700 20px "Fraunces Variable"', 'italic 400 20px "Fraunces Variable"', '600 20px "Caveat"'];
    fontsReady = Promise.all(specs.map((f) => document.fonts.load(f).catch(() => null))).then(() => true);
  }
  return fontsReady;
}

const imgCache = new Map();
export function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

/** Image en mode « cover » dans un rectangle, avec point focal vertical (0 = haut, 1 = bas). */
export function drawCover(c, img, x, y, w, h, focusY = 0.5, focusX = 0.5) {
  const r = Math.max(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.drawImage(img, x - (dw - w) * focusX, y - (dh - h) * focusY, dw, dh);
  c.restore();
}

/**
 * Image entière dans un rectangle (aucun recadrage) : l'espace restant est rempli par la même
 * photo très floutée et assombrie. Le flou est obtenu par réduction puis agrandissement, ce qui
 * fonctionne aussi dans les navigateurs sans `ctx.filter` (Safari).
 */
export function drawContain(c, img, x, y, w, h, { dim = 0.28 } = {}) {
  const r = Math.min(w / img.width, h / img.height);
  const dw = img.width * r, dh = img.height * r;
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  if (Math.abs(dw - w) > 1 || Math.abs(dh - h) > 1) {
    const small = document.createElement('canvas');
    const sw = 28, sh = Math.max(1, Math.round((28 * img.height) / img.width));
    small.width = sw; small.height = sh;
    const g = small.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, sw, sh);
    const rc = Math.max(w / sw, h / sh) * 1.15;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, x + (w - sw * rc) / 2, y + (h - sh * rc) / 2, sw * rc, sh * rc);
    c.fillStyle = `rgba(0,0,0,${dim})`;
    c.fillRect(x, y, w, h);
    c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = Math.min(w, h) * 0.03;
  }
  c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  c.restore();
}

export function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

export function rgba(hex, a) {
  const h = (hex || '#000000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0');
  return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${a})`;
}

export function luminance(hex) {
  const h = (hex || '#000').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const inkOn = (hex) => (luminance(hex) > 0.6 ? '#0f172a' : '#ffffff');

/** Texte tronqué avec « … » pour tenir dans maxW. */
export function fit(c, text, maxW) {
  text = String(text ?? '');
  if (c.measureText(text).width <= maxW) return text;
  while (text.length > 1 && c.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}

/** Réduit la taille de police jusqu'à ce que le texte tienne ; renvoie la taille retenue. */
export function fitSize(c, text, maxW, size, weight = 700, family = FONTS.sans, min = 10) {
  let s = size;
  c.font = `${weight} ${s}px ${family}`;
  while (s > min && c.measureText(text).width > maxW) { s -= 1; c.font = `${weight} ${s}px ${family}`; }
  return s;
}

/** Texte sur plusieurs lignes ; renvoie la position y après la dernière ligne. */
export function wrap(c, text, x, y, maxW, lh, maxLines = 4) {
  const words = String(text || '').split(/\s+/);
  let line = '', lines = 0;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line, x, y); y += lh; line = w; lines++;
      if (lines >= maxLines - 1) { line = fit(c, words.slice(words.indexOf(w)).join(' '), maxW); break; }
    } else line = test;
  }
  if (line) { c.fillText(line, x, y); y += lh; }
  return y;
}

/** Code-barres décoratif reproductible (pas un vrai code lisible). */
export function barcode(c, x, y, w, h, seed = 'contrail', color = '#111') {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  c.save(); c.fillStyle = color;
  let px = x;
  while (px < x + w) {
    const bw = 1 + Math.floor(rnd() * 4) * (w / 260);
    if (rnd() > 0.38) c.fillRect(px, y, bw, h);
    px += bw + (w / 260) * (1 + Math.floor(rnd() * 2));
  }
  c.restore();
}

/** Ligne pointillée (perforation). */
export function dashed(c, x1, y1, x2, y2, color, width = 2, dash = [8, 8]) {
  c.save(); c.strokeStyle = color; c.lineWidth = width; c.setLineDash(dash);
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.restore();
}

/** Cellules « split-flap » façon tableau des départs. */
export function flaps(c, text, x, y, cell, h, { bg = '#1c1c1e', ink = '#ffd23f', font = FONTS.mono, gap = 0.12, count } = {}) {
  const chars = String(text ?? '').toUpperCase().split('');
  const n = count || chars.length;
  const g = cell * gap;
  c.save();
  c.font = `700 ${h * 0.68}px ${font}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const cx = x + i * (cell + g);
    c.fillStyle = bg;
    rrect(c, cx, y, cell, h, cell * 0.12); c.fill();
    c.fillStyle = 'rgba(0,0,0,.45)';
    c.fillRect(cx, y + h / 2 - 1, cell, 2);
    c.fillStyle = ink;
    c.fillText(chars[i] || ' ', cx + cell / 2, y + h / 2 + h * 0.03);
  }
  c.restore();
  return n * (cell + g) - g;
}

/** Grain léger pour éviter l'aspect « plat » des aplats (facultatif). */
export function grain(c, w, h, alpha = 0.035) {
  const n = document.createElement('canvas');
  n.width = n.height = 128;
  const g = n.getContext('2d');
  const d = g.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  c.save(); c.globalAlpha = alpha; c.fillStyle = c.createPattern(n, 'repeat'); c.fillRect(0, 0, w, h); c.restore();
}

/** Drapeau (emoji) : rendu par la police couleur du système, si disponible. */
export function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** Exporte le canvas en PNG et propose téléchargement / partage natif / copie. */
export async function canvasBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}
