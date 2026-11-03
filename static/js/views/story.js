// Générateur d'image récapitulative (story / post / paysage) : 8 styles, palettes et couleurs personnalisables
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, countryName, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, toast } from '../ui.js';
import { FONTS, loadFonts, loadImage, drawCover, rrect, rgba, fit, fitSize, wrap, barcode, dashed, flaps, grain, canvasBlob } from '../lib/canvas.js';
import { drawAircraft, loadTypes, classify } from '../lib/shapes.js';

const FORMATS = { story: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], landscape: [1920, 1080] };
const STATS = ['spots', 'registrations', 'types', 'airlines', 'airports', 'countries', 'special_liveries', 'days', 'flights', 'km'];

export const PALETTES = {
  contrail: { accent: '#3b82f6', accent2: '#22d3ee', bg: '#0b1220', ink: '#ffffff' },
  sunset: { accent: '#f97316', accent2: '#db2777', bg: '#1a0d1a', ink: '#ffffff' },
  aurora: { accent: '#10b981', accent2: '#06b6d4', bg: '#04151a', ink: '#ecfeff' },
  night: { accent: '#818cf8', accent2: '#c084fc', bg: '#0f0b24', ink: '#eef2ff' },
  tricolore: { accent: '#e11d48', accent2: '#1d4ed8', bg: '#ffffff', ink: '#0f172a' },
  sand: { accent: '#b45309', accent2: '#15803d', bg: '#fbf3e4', ink: '#1c1917' },
  mono: { accent: '#111111', accent2: '#71717a', bg: '#f4f4f5', ink: '#111111' },
  amber: { accent: '#ffd23f', accent2: '#ff9f1c', bg: '#0d0d0f', ink: '#f5f5f4' },
};

// ------------------------------------------------------------------ données
function statItems(d, o) {
  const items = [];
  for (const k of o.stats) {
    const v = k === 'km' ? d.km : d[k] || 0;
    items.push({ k, v: fmtNum(v), label: t(`story.st_${k}`) });
  }
  return items;
}
function tops(d) {
  return [
    d.top_type && [t('story.top_type'), d.top_type.label || d.top_type.k, d.top_type.n],
    d.top_airport && [t('story.top_airport'), d.top_airport.k, d.top_airport.n],
    d.top_airline && [t('story.top_airline'), d.top_airline.label || d.top_airline.k, d.top_airline.n],
    d.top_country && [t('story.top_country'), countryName(d.top_country.k), d.top_country.n],
  ].filter(Boolean);
}
const titleOf = (o) => o.title || (o.year ? t('story.default_title_year', { y: o.year }) : t('story.default_title'));

// ------------------------------------------------------------------ styles
const THEMES = {
  glass_dark: { palette: 'contrail', font: 'sans', draw: drawGlass(false) },
  glass_light: { palette: { accent: '#2563eb', accent2: '#ec4899', bg: '#eef2ff', ink: '#0f172a' }, font: 'sans', draw: drawGlass(true) },
  gradient: { palette: 'sunset', font: 'sans', draw: drawGradient },
  minimal: { palette: { accent: '#2563eb', accent2: '#94a3b8', bg: '#f7f7f5', ink: '#111418' }, font: 'sans', draw: drawMinimal },
  boarding: { palette: { accent: '#1d4ed8', accent2: '#e11d48', bg: '#dbe4f0', ink: '#0f172a' }, font: 'mono', draw: drawBoarding },
  departures: { palette: 'amber', font: 'mono', draw: drawDepartures },
  editorial: { palette: { accent: '#c2410c', accent2: '#0f172a', bg: '#f3eee4', ink: '#141414' }, font: 'serif', draw: drawEditorial },
  blueprint: { palette: { accent: '#ffffff', accent2: '#93c5fd', bg: '#123e7c', ink: '#ffffff' }, font: 'mono', draw: drawBlueprint },
};

function resolvePalette(o) {
  const th = THEMES[o.style] || THEMES.glass_dark;
  if (o.palette === 'custom' && o.colors) return { ...o.colors };
  const p = o.palette && o.palette !== 'auto' ? PALETTES[o.palette] : (typeof th.palette === 'string' ? PALETTES[th.palette] : th.palette);
  return { ...(p || PALETTES.contrail) };
}
function resolveFont(o) {
  const th = THEMES[o.style] || THEMES.glass_dark;
  return FONTS[o.font && o.font !== 'auto' ? o.font : th.font] || FONTS.sans;
}

function layout(W, H) {
  const u = Math.min(W, H) / 1080;
  return { u, pad: 80 * u, land: W > H };
}

function brand(c, x, y, size, color, family = FONTS.sans) {
  c.save();
  c.fillStyle = color;
  c.font = `700 ${size}px ${family}`;
  c.globalAlpha = 0.9;
  c.textBaseline = 'alphabetic';
  c.fillText('✈  CONTRAIL', x, y);
  c.restore();
}

function footer(c, W, H, L, d, o, color) {
  c.save();
  c.fillStyle = color;
  c.globalAlpha = 0.7;
  c.font = `500 ${22 * L.u}px ${FONTS.sans}`;
  const left = o.signature ? `© ${o.signature}` : fmtDate(new Date().toISOString().slice(0, 10), { time: false });
  c.fillText(left, L.pad, H - L.pad * 0.6);
  if (d.since && !o.year) {
    c.textAlign = 'right';
    c.fillText(t('story.since', { date: fmtDate(d.since, { time: false }) }), W - L.pad, H - L.pad * 0.6);
  }
  c.restore();
}

function glassRect(c, x, y, w, h, r, light) {
  c.save();
  rrect(c, x, y, w, h, r);
  c.fillStyle = light ? 'rgba(255,255,255,.66)' : 'rgba(255,255,255,.10)';
  c.shadowColor = 'rgba(0,0,0,.16)'; c.shadowBlur = 36; c.shadowOffsetY = 10;
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 2;
  c.strokeStyle = light ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.2)';
  c.stroke();
  c.restore();
}

function statGrid(c, items, x, y, w, L, { cols, tileH, gap, card, valueColor, labelColor, family, valueFont = FONTS.sans }) {
  const tileW = (w - gap * (cols - 1)) / cols;
  items.forEach((it, i) => {
    const tx = x + (i % cols) * (tileW + gap), ty = y + Math.floor(i / cols) * (tileH + gap);
    card?.(tx, ty, tileW, tileH);
    const s = fitSize(c, it.v, tileW - 60 * L.u, 76 * L.u, 800, valueFont);
    c.fillStyle = valueColor;
    c.font = `800 ${s}px ${valueFont}`;
    c.fillText(it.v, tx + 30 * L.u, ty + tileH * 0.56);
    c.fillStyle = labelColor;
    c.font = `600 ${26 * L.u}px ${family}`;
    c.fillText(fit(c, it.label, tileW - 60 * L.u), tx + 30 * L.u, ty + tileH * 0.56 + 44 * L.u);
  });
  return y + Math.ceil(items.length / cols) * (tileH + gap) - gap;
}

function drawGlass(light) {
  return async (c, W, H, d, o, P, F) => {
    const L = layout(W, H);
    const bg = o.bg ? await loadImage(mediaUrl('images', o.bg)) : null;
    if (bg) {
      drawCover(c, bg, 0, 0, W, H, o.focus ?? 0.5);
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(P.bg, light ? 0.15 : 0.05));
      g.addColorStop(1, rgba(P.bg, light ? 0.88 : 0.85));
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else {
      c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
      for (const [x, y, r, col] of [[W * 0.1, H * 0.1, W * 0.75, P.accent], [W, H * 0.75, W * 0.8, P.accent2]]) {
        const rg = c.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, rgba(col, light ? 0.35 : 0.55)); rg.addColorStop(1, rgba(col, 0));
        c.fillStyle = rg; c.fillRect(0, 0, W, H);
      }
    }
    const sub = rgba(P.ink, 0.7);
    brand(c, L.pad, L.pad + 20 * L.u, 28 * L.u, P.ink);
    c.fillStyle = P.ink;
    c.font = `800 ${84 * L.u}px ${F}`;
    const titleY = L.land ? L.pad + 140 * L.u : H * 0.2;
    wrap(c, titleOf(o), L.pad, titleY, (L.land ? W * 0.6 : W) - L.pad * 2, 92 * L.u, 3);
    const items = statItems(d, o).slice(0, L.land ? 6 : 8);
    const cols = L.land ? 3 : 2, gap = 22 * L.u, tileH = 196 * L.u;
    const rows = Math.ceil(items.length / cols);
    const topH = o.showTop ? 70 * L.u * Math.min(4, tops(d).length) + 40 * L.u : 0;
    const gridW = L.land ? W * 0.62 - L.pad : W - L.pad * 2;
    const gy = L.land ? titleY + 80 * L.u : Math.max(titleY + 120 * L.u, H - L.pad * 1.6 - topH - (topH ? gap : 0) - rows * (tileH + gap) + gap);
    const end = statGrid(c, items, L.pad, gy, gridW, L, { cols, tileH, gap, family: FONTS.sans, valueColor: P.ink, labelColor: sub,
      card: (x, y, w, h) => glassRect(c, x, y, w, h, 32 * L.u, light) });
    if (o.showTop) {
      const list = tops(d).slice(0, 4);
      const x = L.land ? W * 0.62 + gap : L.pad, y = L.land ? gy : end + gap, w = L.land ? W - x - L.pad : W - L.pad * 2;
      if (list.length) {
        glassRect(c, x, y, w, topH, 32 * L.u, light);
        list.forEach(([l, v], i) => {
          const ly = y + 62 * L.u + i * 70 * L.u;
          c.fillStyle = sub; c.font = `600 ${25 * L.u}px ${FONTS.sans}`; c.textAlign = 'left'; c.fillText(l, x + 30 * L.u, ly);
          c.fillStyle = P.ink; c.font = `700 ${31 * L.u}px ${FONTS.sans}`; c.textAlign = 'right'; c.fillText(fit(c, v, w * 0.55), x + w - 30 * L.u, ly);
          c.textAlign = 'left';
        });
      }
    }
    footer(c, W, H, L, d, o, P.ink);
  };
}

async function drawGradient(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, P.accent); g.addColorStop(1, P.accent2);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const bg = o.bg ? await loadImage(mediaUrl('images', o.bg)) : null;
  if (bg) { c.save(); c.globalAlpha = 0.28; c.globalCompositeOperation = 'luminosity'; drawCover(c, bg, 0, 0, W, H, o.focus ?? 0.5); c.restore(); }
  grain(c, W, H, 0.05);
  brand(c, L.pad, L.pad + 20 * L.u, 28 * L.u, P.ink);
  const items = statItems(d, o);
  const hero = items.shift();
  c.fillStyle = P.ink;
  c.font = `600 ${40 * L.u}px ${F}`;
  const ty = L.land ? L.pad + 120 * L.u : H * 0.16;
  wrap(c, titleOf(o), L.pad, ty, W - L.pad * 2, 50 * L.u, 2);
  if (hero) {
    const hs = fitSize(c, hero.v, W * (L.land ? 0.5 : 0.85), 360 * L.u, 900, F);
    c.font = `900 ${hs}px ${F}`;
    c.fillText(hero.v, L.pad - 8 * L.u, ty + 70 * L.u + hs * 0.82);
    c.font = `700 ${44 * L.u}px ${F}`;
    c.fillText(hero.label, L.pad, ty + 70 * L.u + hs * 0.82 + 64 * L.u);
  }
  // liste des autres chiffres, séparés par des filets
  const x0 = L.land ? W * 0.56 : L.pad, w = L.land ? W - x0 - L.pad : W - L.pad * 2;
  let y = L.land ? L.pad + 140 * L.u : H * 0.55;
  const rowH = (L.land ? 92 : 96) * L.u;
  const list = [...items.map((i) => [i.label, i.v]), ...(o.showTop ? tops(d).map(([l, v]) => [l, v]) : [])].slice(0, L.land ? 8 : 9);
  for (const [l, v] of list) {
    c.strokeStyle = rgba(P.ink, 0.35); c.lineWidth = 2 * L.u;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke();
    c.fillStyle = rgba(P.ink, 0.85); c.font = `500 ${30 * L.u}px ${FONTS.sans}`; c.textAlign = 'left';
    c.fillText(fit(c, l, w * 0.5), x0, y + rowH * 0.62);
    c.fillStyle = P.ink; c.font = `800 ${40 * L.u}px ${F}`; c.textAlign = 'right';
    c.fillText(fit(c, v, w * 0.48), x0 + w, y + rowH * 0.64);
    c.textAlign = 'left';
    y += rowH;
    if (y > H - L.pad * 1.6) break;
  }
  footer(c, W, H, L, d, o, P.ink);
}

async function drawMinimal(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  const sub = rgba(P.ink, 0.55);
  c.fillStyle = P.accent; c.fillRect(L.pad, L.pad, 64 * L.u, 8 * L.u);
  c.fillStyle = P.ink; c.font = `700 ${26 * L.u}px ${FONTS.sans}`;
  c.fillText('CONTRAIL', L.pad, L.pad + 60 * L.u);
  c.font = `800 ${78 * L.u}px ${F}`;
  const ty = L.land ? L.pad + 180 * L.u : H * 0.2;
  const after = wrap(c, titleOf(o), L.pad, ty, W - L.pad * 2, 86 * L.u, 3);
  const bg = o.bg ? await loadImage(mediaUrl('images', o.bg)) : null;
  let y = after + 20 * L.u;
  if (bg && !L.land) {
    const ph = Math.min(H * 0.26, (W - L.pad * 2) * 0.6);
    drawCover(c, bg, L.pad, y, W - L.pad * 2, ph, o.focus ?? 0.5);
    y += ph + 40 * L.u;
  }
  const items = statItems(d, o).slice(0, 8);
  const cols = L.land ? 4 : 2;
  const cellW = (W - L.pad * 2) / cols, cellH = 170 * L.u;
  items.forEach((it, i) => {
    const x = L.pad + (i % cols) * cellW, yy = y + Math.floor(i / cols) * cellH;
    c.strokeStyle = rgba(P.ink, 0.15); c.lineWidth = 2 * L.u;
    c.beginPath(); c.moveTo(x, yy); c.lineTo(x + cellW - 24 * L.u, yy); c.stroke();
    c.fillStyle = P.accent; c.font = `800 ${fitSize(c, it.v, cellW - 40 * L.u, 72 * L.u, 800, F)}px ${F}`;
    c.fillText(it.v, x, yy + 88 * L.u);
    c.fillStyle = sub; c.font = `600 ${25 * L.u}px ${FONTS.sans}`;
    c.fillText(fit(c, it.label, cellW - 30 * L.u), x, yy + 128 * L.u);
  });
  y += Math.ceil(items.length / cols) * cellH + 10 * L.u;
  if (o.showTop && y < H - L.pad * 3) {
    for (const [l, v] of tops(d)) {
      if (y > H - L.pad * 1.8) break;
      c.fillStyle = sub; c.font = `600 ${24 * L.u}px ${FONTS.sans}`; c.fillText(l.toUpperCase(), L.pad, y + 30 * L.u);
      c.fillStyle = P.ink; c.font = `700 ${30 * L.u}px ${FONTS.sans}`; c.textAlign = 'right';
      c.fillText(fit(c, v, W * 0.5), W - L.pad, y + 30 * L.u); c.textAlign = 'left';
      y += 58 * L.u;
    }
  }
  footer(c, W, H, L, d, o, P.ink);
}

async function drawBoarding(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  grain(c, W, H, 0.03);
  const m = L.pad * 0.8;
  const x = m, y = L.land ? m : H * 0.08, w = W - m * 2, h = L.land ? H - m * 2 : H * 0.84;
  const r = 36 * L.u;
  // ticket avec encoches
  c.save();
  c.shadowColor = 'rgba(0,0,0,.18)'; c.shadowBlur = 50 * L.u; c.shadowOffsetY = 18 * L.u;
  rrect(c, x, y, w, h, r); c.fillStyle = '#ffffff'; c.fill();
  c.restore();
  const stubY = L.land ? null : y + h * 0.74;
  const stubX = L.land ? x + w * 0.72 : null;
  c.fillStyle = P.bg;
  if (L.land) { for (const yy of [y, y + h]) { c.beginPath(); c.arc(stubX, yy, 26 * L.u, 0, Math.PI * 2); c.fill(); } dashed(c, stubX, y + 40 * L.u, stubX, y + h - 40 * L.u, rgba(P.ink, 0.3), 3 * L.u, [12 * L.u, 10 * L.u]); }
  else { for (const xx of [x, x + w]) { c.beginPath(); c.arc(xx, stubY, 26 * L.u, 0, Math.PI * 2); c.fill(); } dashed(c, x + 40 * L.u, stubY, x + w - 40 * L.u, stubY, rgba(P.ink, 0.3), 3 * L.u, [12 * L.u, 10 * L.u]); }
  // bandeau
  const bandH = 110 * L.u;
  c.save(); rrect(c, x, y, w, bandH + r, [r, r, 0, 0]); c.clip();
  c.fillStyle = P.accent; c.fillRect(x, y, w, bandH);
  c.restore();
  c.fillStyle = '#ffffff'; c.font = `700 ${30 * L.u}px ${FONTS.sans}`;
  c.fillText('✈  CONTRAIL AIRLINES', x + 40 * L.u, y + 68 * L.u);
  c.textAlign = 'right'; c.font = `600 ${24 * L.u}px ${F}`;
  c.fillText(t('story.boarding_pass').toUpperCase(), (stubX || x + w) - 40 * L.u, y + 68 * L.u); c.textAlign = 'left';
  const ink = P.ink, sub = rgba(P.ink, 0.5);
  const iw = (stubX || x + w) - x - 80 * L.u;
  let cy = y + bandH + 70 * L.u;
  const from = d.top_airport?.k || 'XXXX';
  c.fillStyle = sub; c.font = `600 ${22 * L.u}px ${FONTS.sans}`;
  c.fillText(t('story.bp_from').toUpperCase(), x + 40 * L.u, cy);
  c.textAlign = 'right'; c.fillText(t('story.bp_to').toUpperCase(), x + 40 * L.u + iw, cy); c.textAlign = 'left';
  cy += 110 * L.u;
  c.fillStyle = ink; c.font = `800 ${120 * L.u}px ${F}`;
  c.fillText(from, x + 40 * L.u, cy);
  c.textAlign = 'right'; c.fillText(String(o.year || '∞'), x + 40 * L.u + iw, cy); c.textAlign = 'left';
  c.save(); c.translate(x + 40 * L.u + iw / 2, cy - 40 * L.u); c.rotate(Math.PI / 2);
  drawAircraft(c, 'narrow', 90 * L.u, { fill: P.accent, outline: null }); c.restore();
  cy += 30 * L.u;
  c.fillStyle = sub; c.font = `600 ${22 * L.u}px ${FONTS.sans}`;
  c.fillText(fit(c, titleOf(o), iw), x + 40 * L.u, cy + 10 * L.u);
  cy += 60 * L.u;
  const items = statItems(d, o).slice(0, L.land ? 6 : 8);
  const cols = L.land ? 3 : 2, cw = iw / cols, ch = 120 * L.u;
  items.forEach((it, i) => {
    const fx = x + 40 * L.u + (i % cols) * cw, fy = cy + Math.floor(i / cols) * ch;
    c.fillStyle = sub; c.font = `600 ${21 * L.u}px ${FONTS.sans}`; c.fillText(fit(c, it.label.toUpperCase(), cw - 20 * L.u), fx, fy + 30 * L.u);
    c.fillStyle = ink; c.font = `700 ${fitSize(c, it.v, cw - 20 * L.u, 54 * L.u, 700, F)}px ${F}`; c.fillText(it.v, fx, fy + 90 * L.u);
  });
  // talon
  const pax = (o.signature || t('story.bp_spotter')).toUpperCase();
  if (L.land) {
    const sx = stubX + 40 * L.u, sw = x + w - stubX - 80 * L.u;
    c.fillStyle = sub; c.font = `600 ${21 * L.u}px ${FONTS.sans}`; c.fillText(t('story.bp_passenger').toUpperCase(), sx, y + bandH + 70 * L.u);
    c.fillStyle = ink; c.font = `700 ${34 * L.u}px ${F}`; c.fillText(fit(c, pax, sw), sx, y + bandH + 116 * L.u);
    if (o.showTop) tops(d).slice(0, 3).forEach(([l, v], i) => {
      const yy = y + bandH + 190 * L.u + i * 90 * L.u;
      c.fillStyle = sub; c.font = `600 ${20 * L.u}px ${FONTS.sans}`; c.fillText(l.toUpperCase(), sx, yy);
      c.fillStyle = ink; c.font = `700 ${30 * L.u}px ${F}`; c.fillText(fit(c, v, sw), sx, yy + 38 * L.u);
    });
    barcode(c, sx, y + h - 150 * L.u, sw, 90 * L.u, titleOf(o), ink);
  } else {
    const sy = stubY + 60 * L.u;
    c.fillStyle = sub; c.font = `600 ${21 * L.u}px ${FONTS.sans}`; c.fillText(t('story.bp_passenger').toUpperCase(), x + 40 * L.u, sy);
    c.fillStyle = ink; c.font = `700 ${38 * L.u}px ${F}`; c.fillText(fit(c, pax, w * 0.45), x + 40 * L.u, sy + 48 * L.u);
    if (o.showTop && d.top_type) {
      c.fillStyle = sub; c.font = `600 ${21 * L.u}px ${FONTS.sans}`; c.textAlign = 'right';
      c.fillText(t('story.top_type').toUpperCase(), x + w - 40 * L.u, sy);
      c.fillStyle = ink; c.font = `700 ${38 * L.u}px ${F}`; c.fillText(fit(c, d.top_type.k, w * 0.4), x + w - 40 * L.u, sy + 48 * L.u);
      c.textAlign = 'left';
    }
    barcode(c, x + 40 * L.u, sy + 90 * L.u, w - 80 * L.u, Math.min(120 * L.u, y + h - sy - 130 * L.u), titleOf(o), ink);
  }
  c.fillStyle = rgba(P.ink, 0.6); c.font = `500 ${22 * L.u}px ${FONTS.sans}`;
  c.fillText(fmtDate(new Date().toISOString().slice(0, 10), { time: false }), x, y + h + 46 * L.u);
}

async function drawDepartures(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  const cellBg = '#1f1f23';
  const pad = L.pad * 0.8;
  c.fillStyle = P.accent; c.font = `800 ${46 * L.u}px ${FONTS.sans}`;
  c.fillText(`✈ ${t('story.departures').toUpperCase()}`, pad, pad + 40 * L.u);
  c.fillStyle = rgba(P.ink, 0.6); c.font = `500 ${26 * L.u}px ${FONTS.sans}`;
  c.fillText(fit(c, titleOf(o), W - pad * 2), pad, pad + 86 * L.u);
  const avail = W - pad * 2;
  const cells = L.land ? 30 : 18;
  const cell = (avail / cells) / 1.12, ch = cell * 1.45;
  let y = pad + 140 * L.u;
  c.fillStyle = rgba(P.ink, 0.45); c.font = `600 ${20 * L.u}px ${FONTS.sans}`;
  c.fillText(t('story.col_what').toUpperCase(), pad, y); c.textAlign = 'right'; c.fillText(t('story.col_count').toUpperCase(), pad + avail, y); c.textAlign = 'left';
  y += 20 * L.u;
  // Sur un vrai tableau, seules les valeurs sont sur palettes : libellé en texte, valeur en codes courts.
  const codes = [
    d.top_type && [t('story.top_type'), d.top_type.k],
    d.top_airport && [t('story.top_airport'), d.top_airport.k],
    d.top_airline && [t('story.top_airline'), d.top_airline.k],
    d.top_country && [t('story.top_country'), d.top_country.k],
  ].filter((r) => r && r[1]);
  const rows = [...statItems(d, o).map((i) => [i.label, i.v]), ...(o.showTop ? codes : [])];
  const valCells = L.land ? 8 : 5;
  const vx = pad + avail - valCells * cell * 1.12 + cell * 0.12;
  const gapY = Math.min(70 * L.u, Math.max(14 * L.u, (H - pad * 1.8 - y - rows.length * ch) / Math.max(rows.length, 1)));
  for (const [l, v] of rows) {
    if (y + ch > H - pad * 1.6) break;
    c.fillStyle = P.ink; c.font = `600 ${Math.min(ch * 0.42, 30 * L.u)}px ${FONTS.mono}`;
    c.textBaseline = 'middle';
    c.fillText(fit(c, String(l).toUpperCase(), vx - pad - 24 * L.u), pad, y + ch / 2);
    c.textBaseline = 'alphabetic';
    const vv = String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, valCells).padStart(valCells, ' ');
    flaps(c, vv, vx, y, cell, ch, { bg: cellBg, ink: P.accent, count: valCells });
    dashed(c, pad, y + ch + gapY / 2, pad + avail, y + ch + gapY / 2, rgba(P.ink, 0.12), 1, [4, 6]);
    y += ch + gapY;
  }
  c.fillStyle = P.accent2; c.font = `700 ${24 * L.u}px ${F}`;
  c.fillText(`● ${t('story.on_time')}`, pad, H - pad * 0.6);
  c.fillStyle = rgba(P.ink, 0.5); c.textAlign = 'right'; c.font = `500 ${22 * L.u}px ${FONTS.sans}`;
  c.fillText(o.signature ? `© ${o.signature}` : 'CONTRAIL', W - pad, H - pad * 0.6); c.textAlign = 'left';
}

async function drawEditorial(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  const bg = o.bg ? await loadImage(mediaUrl('images', o.bg)) : null;
  const ink = bg ? '#ffffff' : P.ink;
  if (bg) {
    drawCover(c, bg, 0, 0, W, H, o.focus ?? 0.5);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(0.35, 'rgba(0,0,0,0)'); g.addColorStop(0.6, 'rgba(0,0,0,.1)'); g.addColorStop(1, 'rgba(0,0,0,.75)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  } else grain(c, W, H, 0.04);
  // titre de magazine
  c.fillStyle = bg ? '#ffffff' : P.accent;
  const ms = fitSize(c, 'CONTRAIL', W - L.pad * 2, 230 * L.u, 900, FONTS.serif);
  c.font = `900 ${ms}px ${FONTS.serif}`;
  c.fillText('CONTRAIL', L.pad - 6 * L.u, L.pad + ms * 0.78);
  c.fillStyle = ink; c.font = `600 ${24 * L.u}px ${FONTS.sans}`;
  const issue = `${t('story.issue')} ${o.year || '∞'} · ${t('story.annual')}`.toUpperCase();
  c.fillText(issue, L.pad, L.pad + ms * 0.78 + 46 * L.u);
  c.fillRect(L.pad, L.pad + ms * 0.78 + 66 * L.u, W - L.pad * 2, 3 * L.u);
  // gros titre en italique
  c.font = `italic 500 ${84 * L.u}px ${F}`;
  const titleY = L.land ? H * 0.55 : H * 0.6;
  wrap(c, titleOf(o), L.pad, titleY, (L.land ? W * 0.55 : W) - L.pad * 2, 92 * L.u, 3);
  // « cover lines » : chiffres en marge droite
  const items = statItems(d, o).slice(0, L.land ? 5 : 4);
  const cx = L.land ? W * 0.66 : W - L.pad - 330 * L.u;
  let y = L.land ? L.pad + ms + 120 * L.u : L.pad + ms + 150 * L.u;
  for (const it of items) {
    c.fillStyle = bg ? '#ffffff' : P.accent; c.font = `800 ${64 * L.u}px ${F}`;
    c.fillText(it.v, cx, y);
    c.fillStyle = ink; c.font = `500 ${24 * L.u}px ${FONTS.sans}`;
    c.fillText(fit(c, it.label, 320 * L.u), cx, y + 36 * L.u);
    y += 128 * L.u;
  }
  if (o.showTop && d.top_type) {
    c.fillStyle = bg ? '#ffffff' : P.accent2; c.font = `700 ${28 * L.u}px ${FONTS.sans}`;
    c.fillText(`${t('story.cover_star')} : ${fit(c, d.top_type.label || d.top_type.k, W * 0.6)}`.toUpperCase(), L.pad, H - L.pad * 1.3);
  }
  footer(c, W, H, L, d, o, ink);
}

async function drawBlueprint(c, W, H, d, o, P, F) {
  const L = layout(W, H);
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  // quadrillage
  c.strokeStyle = rgba(P.ink, 0.08); c.lineWidth = 1;
  const step = 40 * L.u;
  for (let x = 0; x < W; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y < H; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  c.strokeStyle = rgba(P.ink, 0.18);
  for (let x = 0; x < W; x += step * 5) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y < H; y += step * 5) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  // cartouche
  c.strokeStyle = P.ink; c.lineWidth = 3 * L.u;
  c.strokeRect(L.pad * 0.6, L.pad * 0.6, W - L.pad * 1.2, H - L.pad * 1.2);
  // silhouette du type favori
  const cls = classify(d.top_type?.k);
  const size = Math.min(W, H) * (L.land ? 0.62 : 0.72);
  const cx = L.land ? W * 0.32 : W / 2, cy = L.land ? H * 0.52 : H * 0.36;
  c.save(); c.translate(cx, cy);
  drawAircraft(c, cls, size, { fill: null, outline: P.ink, outlineWidth: 3 * L.u });
  c.restore();
  // cotes
  c.strokeStyle = P.accent2; c.fillStyle = P.accent2; c.lineWidth = 2 * L.u;
  const half = size * 0.5;
  c.beginPath(); c.moveTo(cx - half, cy + half + 30 * L.u); c.lineTo(cx + half, cy + half + 30 * L.u); c.stroke();
  for (const sx of [cx - half, cx + half]) { c.beginPath(); c.moveTo(sx, cy + half + 18 * L.u); c.lineTo(sx, cy + half + 42 * L.u); c.stroke(); }
  c.font = `500 ${24 * L.u}px ${F}`; c.textAlign = 'center';
  c.fillText(`${(d.top_type?.label || d.top_type?.k || t('cls.unknown')).toUpperCase()} — ${t('story.most_seen')}`, cx, cy + half + 72 * L.u);
  c.textAlign = 'left';
  // titre
  c.fillStyle = P.ink; c.font = `700 ${48 * L.u}px ${F}`;
  const tx = L.pad, ty = L.pad + 60 * L.u;
  wrap(c, titleOf(o).toUpperCase(), tx, ty, (L.land ? W * 0.55 : W) - L.pad * 2, 56 * L.u, 2);
  // tableau de nomenclature
  const items = [...statItems(d, o), ...(o.showTop ? tops(d).slice(1).map(([l, v]) => ({ label: l, v })) : [])];
  const tw = L.land ? W * 0.34 : W - L.pad * 2;
  const tx0 = L.land ? W - L.pad - tw : L.pad;
  const rowH = 64 * L.u;
  let ty0 = L.land ? L.pad + 40 * L.u : cy + half + 120 * L.u;
  const maxRows = Math.floor((H - L.pad * 1.4 - ty0) / rowH);
  const list = items.slice(0, Math.max(0, maxRows));
  c.strokeStyle = P.ink; c.lineWidth = 2 * L.u;
  list.forEach((it, i) => {
    const yy = ty0 + i * rowH;
    c.strokeRect(tx0, yy, tw, rowH);
    c.beginPath(); c.moveTo(tx0 + tw * 0.64, yy); c.lineTo(tx0 + tw * 0.64, yy + rowH); c.stroke();
    c.fillStyle = rgba(P.ink, 0.8); c.font = `500 ${24 * L.u}px ${F}`;
    c.fillText(fit(c, it.label.toUpperCase(), tw * 0.6), tx0 + 16 * L.u, yy + rowH * 0.62);
    c.fillStyle = P.ink; c.font = `700 ${30 * L.u}px ${F}`; c.textAlign = 'right';
    c.fillText(fit(c, it.v, tw * 0.33), tx0 + tw - 16 * L.u, yy + rowH * 0.64); c.textAlign = 'left';
  });
  c.fillStyle = rgba(P.ink, 0.7); c.font = `500 ${20 * L.u}px ${F}`;
  c.fillText(`CONTRAIL · ${o.signature ? `DESS. ${o.signature.toUpperCase()} · ` : ''}${fmtDate(new Date().toISOString().slice(0, 10), { time: false }).toUpperCase()}`, L.pad, H - L.pad * 0.85);
}

// ------------------------------------------------------------------ vue
export async function render(root) {
  const def = { format: 'story', style: 'glass_dark', palette: 'auto', colors: null, font: 'auto', year: String(new Date().getFullYear()),
    stats: ['spots', 'registrations', 'types', 'airlines', 'airports', 'countries'], bg: null, focus: 0.5, title: '', showTop: true, signature: '' };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('contrail.story') || '{}') || {}; } catch { saved = {}; }
  const o = { ...def, ...saved };
  if (!THEMES[o.style]) o.style = 'glass_dark';
  const [base, photos] = await Promise.all([api('/api/stats'), api('/api/spots', { query: { has_photo: true, limit: 40, sort: 'date_desc' } }), loadTypes(), loadFonts()]);
  const swatch = (k) => `<label class="color-pick" title="${esc(t(`story.c_${k}`))}"><input type="color" data-color="${k}"><span>${esc(t(`story.c_${k}`))}</span></label>`;
  root.innerHTML = `
    ${pageHead(esc(t('nav.story')), { sub: esc(t('story.sub')) })}
    <div class="story-wrap">
      <div class="story-preview"><canvas data-canvas></canvas></div>
      <div class="stack">
        <div class="card stack">
          <div class="field"><span>${esc(t('story.style'))}</span><div class="style-grid" data-styles>${Object.keys(THEMES).map((s) => `<button type="button" data-style="${s}"><canvas width="120" height="150"></canvas><span>${esc(t(`story.s_${s}`))}</span></button>`).join('')}</div></div>
          <div class="field"><span>${esc(t('story.format'))}</span><div class="seg" data-g="format" style="flex-wrap:wrap">${Object.keys(FORMATS).map((f) => `<button data-v="${f}">${esc(t(`story.f_${f}`))}</button>`).join('')}</div></div>
        </div>
        <div class="card stack">
          <div class="field"><span>${esc(t('story.palette'))}</span><div class="palette-row" data-palettes>
            <button type="button" data-pal="auto" class="pal-auto">${esc(t('story.p_auto'))}</button>
            ${Object.entries(PALETTES).map(([k, p]) => `<button type="button" data-pal="${k}" title="${esc(t(`story.p_${k}`))}" style="--a:${p.accent};--b:${p.accent2};--c:${p.bg}"></button>`).join('')}</div></div>
          <div class="color-row">${['accent', 'accent2', 'bg', 'ink'].map(swatch).join('')}</div>
          <label class="field"><span>${esc(t('story.font'))}</span><select data-font><option value="auto">${esc(t('story.p_auto'))}</option>${['sans', 'serif', 'mono'].map((f) => `<option value="${f}">${esc(t(`story.font_${f}`))}</option>`).join('')}</select></label>
        </div>
        <div class="card stack">
          <div class="field-row">
            <label class="field"><span>${esc(t('story.period'))}</span><select data-year><option value="">${esc(t('stats.all_time'))}</option>${base.years.map((y) => `<option ${o.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
            <label class="field"><span>${esc(t('story.title'))}</span><input data-title value="${esc(o.title)}" placeholder="${esc(t('story.title_ph'))}"></label>
          </div>
          <label class="field"><span>${esc(t('story.signature'))}</span><input data-sign value="${esc(o.signature)}" placeholder="${esc(t('story.signature_ph'))}" maxlength="40"></label>
          <div class="field"><span>${esc(t('story.stats'))}</span><div class="chips">${STATS.filter((s) => store.mod('flights') || !['flights', 'km'].includes(s)).map((s) => `<button class="chip" data-stat="${s}">${esc(t(`story.st_${s}`))}</button>`).join('')}</div></div>
          <label class="toggle-row"><span class="t">${esc(t('story.show_top'))}</span><span class="switch"><input type="checkbox" data-top ${o.showTop ? 'checked' : ''}><span></span></span></label>
          <div class="field"><span>${esc(t('story.background'))}</span><div class="hscroll" style="margin:0;padding:2px" data-bgs>
            <button class="tile noimg" data-bg="" style="width:78px;aspect-ratio:3/4;display:grid;place-items:center;padding:0">${icon('x', '', 20)}</button>
            ${photos.items.map((p) => `<button class="tile" data-bg="${esc(p.image)}" style="width:78px;aspect-ratio:3/4;padding:0"><img src="${mediaUrl('thumbs', p.thumb)}" alt=""></button>`).join('')}</div></div>
          <label class="field" data-focus-row><span>${esc(t('story.focus'))}</span><input type="range" min="0" max="1" step="0.01" data-focus value="${o.focus}"></label>
        </div>
        <div class="row"><button class="btn primary grow" data-dl>${icon('download', '', 18)} ${esc(t('story.download'))}</button>
          ${navigator.canShare ? `<button class="btn" data-share title="${esc(t('share.native'))}">${icon('share-2', '', 18)}</button>` : ''}</div>
      </div>
    </div>`;
  const canvas = root.querySelector('[data-canvas]');
  let data = null;

  const syncControls = () => {
    root.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === o[g.dataset.g])));
    root.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === o.style));
    root.querySelectorAll('[data-pal]').forEach((b) => b.classList.toggle('on', b.dataset.pal === o.palette));
    root.querySelectorAll('[data-stat]').forEach((b) => b.classList.toggle('on', o.stats.includes(b.dataset.stat)));
    root.querySelectorAll('[data-bg]').forEach((b) => b.classList.toggle('on', (b.dataset.bg || null) === (o.bg || null)));
    const P = resolvePalette(o);
    root.querySelectorAll('[data-color]').forEach((i) => (i.value = P[i.dataset.color]));
    root.querySelector('[data-font]').value = o.font;
    root.querySelector('[data-focus-row]').hidden = !o.bg;
    try { localStorage.setItem('contrail.story', JSON.stringify(o)); } catch { /* stockage indisponible */ }
  };

  async function loadData() {
    const [s, f] = await Promise.all([api('/api/stats', { query: { year: o.year } }), store.mod('flights') ? api('/api/stats/flights', { query: { year: o.year } }) : Promise.resolve({})]);
    data = { ...s.totals, flights: f.count || 0, km: f.km || 0, top_type: s.top_types[0], top_airport: s.top_airports[0],
      top_airline: s.top_airlines[0], top_country: s.top_countries[0], since: s.first?.date };
  }

  async function paint(cv, opts, scale = 1) {
    const [W, H] = FORMATS[opts.format];
    cv.width = W * scale; cv.height = H * scale;
    const c = cv.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.textBaseline = 'alphabetic';
    const th = THEMES[opts.style] || THEMES.glass_dark;
    await th.draw(c, W, H, data, opts, resolvePalette(opts), resolveFont(opts));
  }

  let pending = 0;
  async function draw() {
    if (!data) return;
    const id = ++pending;
    const off = document.createElement('canvas');
    await paint(off, o);
    if (id !== pending) return;
    canvas.width = off.width; canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
  }

  async function drawThumbs() {
    for (const b of root.querySelectorAll('[data-style]')) {
      const cv = b.querySelector('canvas');
      const tmp = document.createElement('canvas');
      await paint(tmp, { ...o, style: b.dataset.style, palette: 'auto', font: 'auto', format: 'portrait' }, 0.12);
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      const r = Math.max(cv.width / tmp.width, cv.height / tmp.height);
      g.drawImage(tmp, (cv.width - tmp.width * r) / 2, (cv.height - tmp.height * r) / 2, tmp.width * r, tmp.height * r);
    }
  }

  const redraw = () => { syncControls(); draw(); };
  root.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = () => { o[g.dataset.g] = b.dataset.v; redraw(); })));
  root.querySelectorAll('[data-style]').forEach((b) => (b.onclick = () => { o.style = b.dataset.style; if (o.palette === 'custom') o.palette = 'auto'; redraw(); }));
  root.querySelectorAll('[data-pal]').forEach((b) => (b.onclick = () => { o.palette = b.dataset.pal; redraw(); }));
  root.querySelectorAll('[data-color]').forEach((i) => (i.oninput = () => {
    if (o.palette !== 'custom') o.colors = resolvePalette(o);
    o.palette = 'custom';
    o.colors = { ...o.colors, [i.dataset.color]: i.value };
    redraw();
  }));
  root.querySelector('[data-font]').onchange = (e) => { o.font = e.target.value; redraw(); };
  root.querySelectorAll('[data-stat]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.stat;
    o.stats = o.stats.includes(k) ? o.stats.filter((x) => x !== k) : [...o.stats, k];
    redraw();
  }));
  root.querySelectorAll('[data-bg]').forEach((b) => (b.onclick = () => { o.bg = b.dataset.bg || null; redraw(); }));
  root.querySelector('[data-focus]').oninput = (e) => { o.focus = Number(e.target.value); redraw(); };
  root.querySelector('[data-year]').onchange = async (e) => { o.year = e.target.value; await loadData(); redraw(); drawThumbs(); };
  root.querySelector('[data-title]').oninput = (e) => { o.title = e.target.value; redraw(); };
  root.querySelector('[data-sign]').oninput = (e) => { o.signature = e.target.value; redraw(); };
  root.querySelector('[data-top]').onchange = (e) => { o.showTop = e.target.checked; redraw(); };
  const fname = () => `contrail-${o.year || 'all'}-${o.style}-${o.format}.png`;
  root.querySelector('[data-dl]').onclick = async () => {
    const b = await canvasBlob(canvas);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = fname(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  root.querySelector('[data-share]')?.addEventListener('click', async () => {
    const file = new File([await canvasBlob(canvas)], fname(), { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Contrail' }).catch(() => {});
    else toast(esc(t('story.share_unsupported')), { type: 'warn' });
  });
  await loadData();
  redraw();
  drawThumbs();
}
