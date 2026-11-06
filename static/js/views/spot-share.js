// Partage en image d'un spot : éditeur de carte (modèles, formats, informations affichées, couleurs, cadrage)
import { api, mediaUrl } from '../api.js';
import { t, fmtDate, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, toast, regLabel } from '../ui.js';
import { FONTS, loadFonts, loadImage, drawCover, drawContain, rrect, rgba, fit, fitSize, wrap, barcode, dashed, grain, flagEmoji, canvasBlob } from '../lib/canvas.js';
import { drawAircraft, loadTypes, classify, typeName } from '../lib/shapes.js';
import { PALETTES } from './story.js';

const FORMATS = { portrait: [1080, 1350], square: [1080, 1080], story: [1080, 1920], landscape: [1920, 1080] };
const INFOS = ['airline', 'airport', 'date', 'exif', 'weather', 'badges', 'brand'];

// `auto(a, f)` : taille du canevas pour le format Auto, calculée pour que la zone photo ait exactement
// les proportions de l'image (aucun recadrage). Les modèles sans `auto` (carte de collection, aux
// proportions fixes) affichent la photo entière sur fond flouté.
const TEMPLATES = {
  frame: { palette: { accent: '#2563eb', accent2: '#64748b', bg: '#ffffff', ink: '#111418' }, draw: drawFrame,
    auto: (a, f) => [1080, Math.round(46 + 988 / a + frameCaption(f, 1))] },
  full: { palette: { accent: '#ffffff', accent2: '#cbd5e1', bg: '#000000', ink: '#ffffff' }, draw: drawFull,
    auto: (a) => (a >= 1 ? [1600, Math.round(1600 / Math.min(a, 3))] : [Math.round(1600 * Math.max(a, 0.5)), 1600]) },
  polaroid: { palette: { accent: '#1e3a8a', accent2: '#b45309', bg: '#d6cfc2', ink: '#1f2937' }, draw: drawPolaroid,
    auto: (a) => { const pw = 1080 * 0.78, b = pw * 0.055; return [1080, Math.round(110 + b + (pw - 2 * b) / a + pw * 0.3 + 470)]; } },
  card: { palette: 'contrail', draw: drawCard },
  boarding: { palette: { accent: '#1d4ed8', accent2: '#e11d48', bg: '#dbe4f0', ink: '#0f172a' }, draw: drawBoarding,
    auto: (a, f) => [1080, Math.round(140 + 96 + 940 / a + boardingInfoH(f, 1, 3))] },
  sheet: { palette: { accent: '#c2410c', accent2: '#78716c', bg: '#f6f3ee', ink: '#1c1917' }, draw: drawSheet,
    auto: (a, f) => [1080, Math.round(70 + 940 / a + sheetTextH(f, 1) + 28)] },
};

function palette(o) {
  const tp = TEMPLATES[o.template] || TEMPLATES.frame;
  if (o.palette === 'custom' && o.colors) return { ...o.colors };
  const p = o.palette && o.palette !== 'auto' ? PALETTES[o.palette] : (typeof tp.palette === 'string' ? PALETTES[tp.palette] : tp.palette);
  return { ...(p || PALETTES.contrail) };
}

// ------------------------------------------------------------------ informations du spot
function facts(s, o) {
  const ex = [s.camera, s.focal && `${s.focal} mm`, s.aperture && `f/${s.aperture}`, s.shutter && `${s.shutter} s`, s.iso && `ISO ${s.iso}`].filter(Boolean).join(' · ');
  const ap = s.airport_info;
  const m = s.metar_decoded;
  const wx = m ? [t(`wx.${m.summary}`), m.temp_c != null && `${m.temp_c} °C`, m.wind_kt != null && `${m.wind_dir != null ? String(m.wind_dir).padStart(3, '0') + '°' : 'VRB'} ${m.wind_kt} kt`].filter(Boolean).join(' · ') : '';
  const special = (s.badges || []).find((b) => b.code === 'special_livery');
  const badges = (s.badges || []).filter((b) => ['first_type', 'special_livery', 'most_spotted', 'flown', 'golden_hour', 'twilight', 'night', 'military'].includes(b.code))
    .map((b) => (b.code === 'special_livery' && b.cat && b.cat !== 'special' ? t(`livery.${b.cat}`) : t(`badge.${b.code}`, b.n ? { n: b.n } : undefined)));
  return {
    reg: regLabel(s), isPatrol: !!s.is_patrol, flag: flagEmoji(s.country), country: s.country ? countryName(s.country) : '',
    type: s.aircraft || typeName(s.aircraft_icao) || s.aircraft_icao || '', code: s.aircraft_icao || '',
    airline: o.info.airline ? s.owner || '' : '',
    airport: o.info.airport && (ap || s.airport) ? (ap ? `${ap.city || ap.name} · ${ap.iata || ap.icao}` : s.airport) : '',
    airportCode: s.airport || '', airportName: ap?.name || '',
    date: o.info.date && s.date ? fmtDate(s.date) : '', dateShort: s.date ? fmtDate(s.date, { time: false, short: true }) : '',
    exif: o.info.exif ? ex : '', weather: o.info.weather ? wx : '', badges: o.info.badges ? badges : [],
    livery: s.livery && s.livery !== 'None' ? s.livery : '', special: !!special, msn: s.msn || '', encounters: s.encounters || 1,
    cls: classify(s.aircraft_icao, s.aircraft), signature: o.signature || '', focal: s.focal || '',
  };
}

/** Zone photo, ou à défaut panneau typographique avec la silhouette du type. */
function photoOrPlaceholder(c, img, x, y, w, h, o, P, f, { radius = 0 } = {}) {
  c.save();
  if (radius) { rrect(c, x, y, w, h, radius); c.clip(); }
  if (img && o.fit === 'contain') drawContain(c, img, x, y, w, h);
  else if (img) drawCover(c, img, x, y, w, h, o.focusY, o.focusX);
  else {
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, P.accent); g.addColorStop(1, rgba(P.accent2, 1));
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.translate(x + w / 2, y + h / 2);
    c.rotate(-0.5);
    drawAircraft(c, f.cls, Math.min(w, h) * 0.9, { fill: rgba('#ffffff', 0.9), outline: null });
  }
  c.restore();
}

function brandMark(c, x, y, size, color, align = 'left') {
  c.save(); c.fillStyle = color; c.globalAlpha = 0.85; c.textAlign = align;
  c.font = `700 ${size}px ${FONTS.sans}`; c.fillText('✈ CONTRAIL', x, y); c.restore();
}

function badgeRow(c, list, x, y, maxW, u, bg, ink) {
  let bx = x;
  c.font = `650 ${22 * u}px ${FONTS.sans}`;
  for (const b of list) {
    const tw = c.measureText(b).width + 28 * u;
    if (bx + tw > x + maxW) break;
    c.fillStyle = bg; rrect(c, bx, y, tw, 40 * u, 20 * u); c.fill();
    c.fillStyle = ink; c.fillText(b, bx + 14 * u, y + 28 * u);
    bx += tw + 10 * u;
  }
}

// ------------------------------------------------------------------ modèles
/** Hauteur de la légende du modèle « cadre » (format portrait), selon les informations affichées. */
function frameCaption(f, u) {
  const lines = [[f.airport, f.date].filter(Boolean).join(' · '), f.weather, f.exif].filter(Boolean).length;
  return (96 + 70 + 42 + lines * 38 + (f.badges.length ? 54 : 0) + 64) * u;
}

async function drawFrame(c, W, H, img, f, o, P) {
  const land = !o.auto && W > H;
  const u = o.auto ? W / 1080 : Math.min(W, H) / 1080;
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  const m = 46 * u;
  const pw = land ? W * 0.64 : W - m * 2;
  let ph = land ? H - m * 2 : H - Math.max(frameCaption(f, u), H * 0.24) - m;
  if (o.auto) ph = pw / o.aspect;
  photoOrPlaceholder(c, img, m, m, pw, ph, o, P, f);
  const x = land ? m * 2 + pw : m + 10 * u, w = land ? W - x - m : W - m * 2 - 20 * u;
  let y = land ? m + 90 * u : m + ph + 96 * u;
  const sub = rgba(P.ink, 0.6);
  c.fillStyle = P.ink;
  const rs = fitSize(c, f.reg, w - 80 * u, (land ? 92 : 84) * u, 800, FONTS.mono);
  c.font = `800 ${rs}px ${FONTS.mono}`;
  c.fillText(f.reg, x, y);
  const rw = c.measureText(f.reg).width;
  c.font = `${rs * 0.6}px ${FONTS.sans}`; c.fillText(f.flag, x + rw + 18 * u, y - 6 * u);
  c.fillStyle = P.accent; c.fillRect(x, y + 22 * u, 70 * u, 6 * u);
  y += 70 * u;
  c.fillStyle = P.ink; c.font = `600 ${34 * u}px ${FONTS.sans}`;
  y = wrap(c, [f.type, f.airline].filter(Boolean).join(' · '), x, y, w, 42 * u, land ? 3 : 1);
  c.fillStyle = sub; c.font = `500 ${27 * u}px ${FONTS.sans}`;
  const lines = [[f.airport, f.date].filter(Boolean).join(' · '), f.weather, f.exif].filter(Boolean);
  for (const l of lines) { if (land) y = wrap(c, l, x, y + 4 * u, w, 36 * u, 2); else { c.fillText(fit(c, l, w), x, y + 4 * u); y += 38 * u; } }
  if (f.badges.length) badgeRow(c, f.badges, x, y + 6 * u, w, u, rgba(P.accent, 0.12), P.accent);
  const by = H - (land ? m : 28 * u);
  if (f.signature) { c.fillStyle = sub; c.font = `500 ${24 * u}px ${FONTS.sans}`; c.fillText(`© ${f.signature}`, x, by); }
  if (o.info.brand) brandMark(c, (land ? x + w : W - m), by, 22 * u, sub, 'right');
}

async function drawFull(c, W, H, img, f, o, P) {
  const u = Math.min(W, H) / 1080;
  photoOrPlaceholder(c, img, 0, 0, W, H, o, P, f);
  const g = c.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.78)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const tg = c.createLinearGradient(0, 0, 0, H * 0.18);
  tg.addColorStop(0, 'rgba(0,0,0,.35)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = tg; c.fillRect(0, 0, W, H * 0.18);
  const pad = 64 * u;
  if (o.info.brand) brandMark(c, pad, pad + 10 * u, 26 * u, '#ffffff');
  if (f.badges.length) {
    c.font = `650 ${22 * u}px ${FONTS.sans}`;
    let bx = W - pad;
    for (const b of f.badges.slice(0, 2)) {
      const tw = c.measureText(b).width + 28 * u;
      bx -= tw;
      c.fillStyle = 'rgba(0,0,0,.45)'; rrect(c, bx, pad - 18 * u, tw, 40 * u, 20 * u); c.fill();
      c.fillStyle = '#fff'; c.fillText(b, bx + 14 * u, pad + 10 * u);
      bx -= 10 * u;
    }
  }
  let y = H - pad;
  const sub = 'rgba(255,255,255,.82)';
  c.fillStyle = sub; c.font = `500 ${26 * u}px ${FONTS.sans}`;
  const lines = [f.exif, f.weather, [f.airport, f.date].filter(Boolean).join(' · ')].filter(Boolean);
  if (f.signature) lines.unshift(`© ${f.signature}`);
  for (const l of lines) { c.fillText(fit(c, l, W - pad * 2), pad, y); y -= 38 * u; }
  y -= 12 * u;
  c.fillStyle = '#fff'; c.font = `600 ${36 * u}px ${FONTS.sans}`;
  c.fillText(fit(c, [f.type, f.airline].filter(Boolean).join(' · '), W - pad * 2), pad, y);
  y -= 36 * u + 24 * u;
  const rs = fitSize(c, f.reg, W - pad * 2 - 100 * u, 130 * u, 800, FONTS.mono);
  c.font = `800 ${rs}px ${FONTS.mono}`; c.fillStyle = P.accent;
  c.fillText(f.reg, pad, y);
  const rw = c.measureText(f.reg).width;
  c.font = `${rs * 0.55}px ${FONTS.sans}`; c.fillText(f.flag, pad + rw + 20 * u, y - 8 * u);
}

async function drawPolaroid(c, W, H, img, f, o, P) {
  const land = !o.auto && W > H;
  const u = o.auto ? W / 1080 : Math.min(W, H) / 1080;
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  grain(c, W, H, 0.06);
  // Format carré : polaroid réduit pour laisser la place à la légende en dessous
  const pw = land ? H * 0.82 * 0.86 : W * (o.auto ? 0.78 : Math.min(0.78, (H / W) * 0.56));
  const border = pw * 0.055, photoH = o.auto ? (pw - border * 2) / o.aspect : pw - border * 2;
  const ph = border + photoH + pw * 0.3;
  const cx = land ? W * 0.36 : W / 2;
  const cy = land ? H / 2 : o.auto ? 110 * u + ph / 2 : Math.max(ph / 2 + 50 * u, H * (H > W * 1.4 ? 0.42 : 0.4));
  c.save();
  c.translate(cx, cy); c.rotate(-0.035);
  c.shadowColor = 'rgba(0,0,0,.28)'; c.shadowBlur = 40 * u; c.shadowOffsetY = 16 * u;
  c.fillStyle = '#fbfaf7'; c.fillRect(-pw / 2, -ph / 2, pw, ph);
  c.shadowColor = 'transparent';
  photoOrPlaceholder(c, img, -pw / 2 + border, -ph / 2 + border, pw - border * 2, photoH, o, P, f);
  c.fillStyle = P.accent;
  c.font = `600 ${pw * 0.085}px ${FONTS.hand}`;
  const capY = -ph / 2 + border + photoH + pw * 0.12;
  c.fillText(fit(c, `${f.reg} ${f.flag}`, pw - border * 2), -pw / 2 + border * 1.4, capY);
  c.fillStyle = rgba(P.ink, 0.8);
  c.font = `600 ${pw * 0.05}px ${FONTS.hand}`;
  c.fillText(fit(c, [f.airportCode, f.dateShort].filter(Boolean).join(' · '), pw - border * 2.8), -pw / 2 + border * 1.4, capY + pw * 0.08);
  c.restore();
  // légende à côté / en dessous
  const tx = land ? W * 0.66 : 80 * u, ty = land ? H * 0.32 : cy + ph / 2 + 100 * u;
  const tw = land ? W - tx - 80 * u : W - 160 * u;
  c.fillStyle = P.ink; c.font = `italic 600 ${46 * u}px ${FONTS.serif}`;
  let y = wrap(c, [f.type, f.airline].filter(Boolean).join(', '), tx, ty, tw, 54 * u, 2);
  c.fillStyle = rgba(P.ink, 0.65); c.font = `500 ${26 * u}px ${FONTS.sans}`;
  for (const l of [f.airport, f.date, f.weather, f.exif].filter(Boolean)) {
    if (y > H - 100 * u) break;
    c.fillText(fit(c, l, tw), tx, y + 6 * u); y += 38 * u;
  }
  if (f.signature) { c.fillStyle = P.accent2; c.font = `600 ${40 * u}px ${FONTS.hand}`; c.fillText(`— ${f.signature}`, tx, Math.min(y + 50 * u, H - 60 * u)); }
  if (o.info.brand) brandMark(c, W - 60 * u, H - 50 * u, 20 * u, rgba(P.ink, 0.6), 'right');
}

async function drawCard(c, W, H, img, f, o, P) {
  const u = Math.min(W, H) / 1080, land = W > H;
  const bgG = c.createLinearGradient(0, 0, W, H);
  bgG.addColorStop(0, P.bg); bgG.addColorStop(1, rgba(P.accent, 0.35));
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H); c.fillStyle = bgG; c.fillRect(0, 0, W, H);
  const cw = land ? H * 0.9 * 0.72 : Math.min(W * 0.84, H * 0.84 * 0.72), ch = cw / 0.72;
  const x = land ? W * 0.08 : (W - cw) / 2, y = (H - ch) / 2;
  const r = 34 * u;
  // cadre holographique
  const holo = c.createLinearGradient(x, y, x + cw, y + ch);
  holo.addColorStop(0, P.accent); holo.addColorStop(0.5, P.accent2); holo.addColorStop(1, P.accent);
  c.save(); c.shadowColor = 'rgba(0,0,0,.4)'; c.shadowBlur = 50 * u; c.shadowOffsetY = 20 * u;
  rrect(c, x, y, cw, ch, r); c.fillStyle = holo; c.fill(); c.restore();
  const b = 16 * u;
  rrect(c, x + b, y + b, cw - b * 2, ch - b * 2, r - b / 2); c.fillStyle = '#0f1115'; c.fill();
  const ix = x + b + 22 * u, iw = cw - b * 2 - 44 * u;
  let yy = y + b + 58 * u;
  c.fillStyle = '#fff'; c.font = `800 ${fitSize(c, f.reg, iw - 90 * u, 60 * u, 800, FONTS.mono)}px ${FONTS.mono}`;
  c.fillText(f.reg, ix, yy);
  c.save(); c.translate(ix + iw - 34 * u, yy - 18 * u); drawAircraft(c, f.cls, 62 * u, { fill: P.accent2, outline: null }); c.restore();
  c.fillStyle = 'rgba(255,255,255,.7)'; c.font = `600 ${24 * u}px ${FONTS.sans}`;
  c.fillText(fit(c, [f.airline || f.country, f.flag].filter(Boolean).join(' '), iw), ix, yy + 36 * u);
  yy += 60 * u;
  const phH = ch * 0.46;
  photoOrPlaceholder(c, img, ix, yy, iw, phH, o, P, f, { radius: 14 * u });
  c.strokeStyle = rgba(P.accent2, 0.9); c.lineWidth = 3 * u; rrect(c, ix, yy, iw, phH, 14 * u); c.stroke();
  yy += phH + 26 * u;
  const rows = [[t('share_img.type'), f.code || f.type], [t('spot.msn'), f.msn], [t('spot.airport'), f.airportCode], [t('share_img.date'), f.dateShort],
    [t('share_img.encounter'), `#${f.encounters}`]].filter(([, v]) => v);
  const rowH = (y + ch - b - 80 * u - yy) / Math.max(rows.length, 1);
  rows.forEach(([k, v], i) => {
    const ry = yy + i * rowH;
    c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(ix, ry, iw, rowH - 6 * u);
    c.fillStyle = 'rgba(255,255,255,.6)'; c.font = `600 ${22 * u}px ${FONTS.sans}`; c.fillText(k.toUpperCase(), ix + 16 * u, ry + rowH * 0.58);
    c.fillStyle = '#fff'; c.font = `700 ${26 * u}px ${FONTS.mono}`; c.textAlign = 'right'; c.fillText(fit(c, v, iw * 0.55), ix + iw - 16 * u, ry + rowH * 0.6); c.textAlign = 'left';
  });
  // rareté
  const rare = f.special ? t('share_img.rare_livery') : f.badges[0] || t('share_img.common');
  c.fillStyle = P.accent2; c.font = `800 ${22 * u}px ${FONTS.sans}`;
  c.fillText(`★ ${fit(c, rare.toUpperCase(), iw * 0.7)}`, ix, y + ch - b - 32 * u);
  if (o.info.brand) { c.fillStyle = 'rgba(255,255,255,.5)'; c.font = `600 ${20 * u}px ${FONTS.sans}`; c.textAlign = 'right'; c.fillText('CONTRAIL', ix + iw, y + ch - b - 32 * u); c.textAlign = 'left'; }
  if (land) {
    const tx = x + cw + W * 0.06, tw = W - tx - 80 * u;
    c.fillStyle = P.ink; c.font = `800 ${64 * u}px ${FONTS.sans}`;
    let ty = wrap(c, f.type, tx, H * 0.34, tw, 72 * u, 2);
    c.fillStyle = rgba(P.ink, 0.7); c.font = `500 ${28 * u}px ${FONTS.sans}`;
    for (const l of [f.airport, f.date, f.weather, f.exif, f.signature && `© ${f.signature}`].filter(Boolean)) { c.fillText(fit(c, l, tw), tx, ty + 10 * u); ty += 42 * u; }
  } else if (f.signature) {
    c.fillStyle = rgba(P.ink, 0.7); c.font = `500 ${24 * u}px ${FONTS.sans}`; c.textAlign = 'center';
    c.fillText(`© ${f.signature}`, W / 2, Math.min(y + ch + 60 * u, H - 30 * u)); c.textAlign = 'left';
  }
}

/** Hauteur du bloc d'informations de la carte d'embarquement (sous la photo). */
function boardingLines(f) { return [f.type, f.weather, f.signature && `© ${f.signature}`].filter(Boolean); }
function boardingInfoH(f, u, cols, lines = boardingLines(f).length) {
  const rows = Math.ceil(6 / cols);
  return (60 + 130 + rows * 104 + 20 + 34 + 16 + 150) * u + lines * 36 * u;
}

async function drawBoarding(c, W, H, img, f, o, P) {
  const land = !o.auto && W >= H;
  const u = o.auto ? W / 1080 : Math.min(W, H) / 1080;
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  grain(c, W, H, 0.03);
  const m = 70 * u;
  const x = m, w = W - m * 2;
  const tH = land || o.auto ? H - m * 2 : Math.min(H - m * 2, w * 1.25);
  const y = (H - tH) / 2;
  const bandH = 96 * u;
  const phW = land ? w * 0.42 : w;
  const ix = land ? x + phW + 50 * u : x + 40 * u, iw = land ? w - phW - 90 * u : w - 80 * u;
  const cols = iw > 700 * u ? 3 : 2;
  let lines = boardingLines(f);
  let phH;
  if (land) phH = tH - bandH;
  else if (o.auto) phH = w / o.aspect;
  else {
    // La photo prend ce qui reste ; en dessous d'un quart du billet, on retire des lignes de texte
    phH = tH - bandH - boardingInfoH(f, u, cols, lines.length);
    while (phH < tH * 0.26 && lines.length) { lines = lines.slice(0, -1); phH = tH - bandH - boardingInfoH(f, u, cols, lines.length); }
    phH = Math.max(phH, tH * 0.2);
  }
  c.save(); c.shadowColor = 'rgba(0,0,0,.18)'; c.shadowBlur = 50 * u; c.shadowOffsetY = 18 * u;
  rrect(c, x, y, w, tH, 34 * u); c.fillStyle = '#fff'; c.fill(); c.restore();
  const phY = y + bandH;
  c.save(); rrect(c, x, y, w, tH, 34 * u); c.clip();
  c.fillStyle = P.accent; c.fillRect(x, y, w, bandH);
  photoOrPlaceholder(c, img, x, phY, phW, phH, o, P, f);
  c.restore();
  c.fillStyle = '#fff'; c.font = `700 ${28 * u}px ${FONTS.sans}`;
  c.fillText(fit(c, `✈  ${f.airline ? f.airline.toUpperCase() : 'CONTRAIL'}`, w * 0.55), x + 36 * u, y + 60 * u);
  c.textAlign = 'right'; c.font = `600 ${22 * u}px ${FONTS.mono}`;
  c.fillText(t('story.boarding_pass').toUpperCase(), x + w - 36 * u, y + 60 * u); c.textAlign = 'left';
  const sub = rgba(P.ink, 0.5), ink = P.ink;
  let yy = land ? phY + 70 * u : phY + phH + 60 * u;
  const field = (label, value, fx, fy, size = 44, fw = iw) => {
    c.fillStyle = sub; c.font = `600 ${20 * u}px ${FONTS.sans}`; c.fillText(fit(c, label.toUpperCase(), fw - 10 * u), fx, fy);
    c.fillStyle = ink; c.font = `700 ${fitSize(c, value || '—', fw - 14 * u, size * u, 700, FONTS.mono, 14 * u)}px ${FONTS.mono}`; c.fillText(value || '—', fx, fy + (size + 8) * u);
  };
  field(t(f.isPatrol ? 'patrol.title' : 'share_img.registration'), `${f.reg}`, ix, yy, 72, iw - 80 * u);
  c.font = `${44 * u}px ${FONTS.sans}`; c.textAlign = 'right'; c.fillText(f.flag, ix + iw, yy + 70 * u); c.textAlign = 'left';
  yy += 130 * u;
  const cw = iw / cols;
  const focal = f.focal ? `${f.focal} mm` : '—';
  const cells = [[t('spot.airport'), f.airportCode], [t('share_img.date'), f.dateShort], [t('share_img.type'), f.code],
    [t('spot.msn'), f.msn], [t('share_img.encounter'), `#${f.encounters}`], [t('share_img.seat'), focal]];
  cells.forEach(([l, v], i) => field(l, v, ix + (i % cols) * cw, yy + Math.floor(i / cols) * 104 * u, 36, cw));
  yy += Math.ceil(cells.length / cols) * 104 * u + 20 * u;
  dashed(c, ix, yy, ix + iw, yy, rgba(P.ink, 0.25), 3 * u, [12 * u, 10 * u]);
  yy += 34 * u;
  const barY = y + tH - 120 * u;
  c.fillStyle = sub; c.font = `500 ${24 * u}px ${FONTS.sans}`;
  for (const l of lines) {
    if (yy + 6 * u > barY - 24 * u) break;
    c.fillText(fit(c, l, iw), ix, yy + 6 * u); yy += 36 * u;
  }
  barcode(c, ix, barY, iw, 80 * u, f.reg, ink);
}

function sheetRows(f) {
  return [[t('spot.country'), `${f.flag} ${f.country}`], [t('spot.msn'), f.msn], [t('spot.airport'), f.airport], [t('share_img.date'), f.date],
    [t('spot.weather'), f.weather], [t('spot.exif'), f.exif], [t('spot.livery'), f.livery]].filter(([, v]) => v && v.trim());
}
function sheetTextH(f, u) { return (60 + 106 + 50 + 84 + 16 + 70) * u + sheetRows(f).length * 58 * u; }

async function drawSheet(c, W, H, img, f, o, P) {
  const land = !o.auto && W > H;
  const u = o.auto ? W / 1080 : Math.min(W, H) / 1080;
  c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
  const m = 70 * u;
  const pw = land ? W * 0.55 : W - m * 2;
  const ph = land ? H - m * 2 : o.auto ? pw / o.aspect : Math.max((H - m * 2) * 0.36, Math.min((H - m * 2) * 0.5, H - m - sheetTextH(f, u) - 20 * u));
  photoOrPlaceholder(c, img, m, m, pw, ph, o, P, f, { radius: 22 * u });
  const x = land ? m * 2 + pw : m, w = land ? W - x - m : W - m * 2;
  let y = land ? m + 30 * u : m + ph + 60 * u;
  c.fillStyle = P.accent; c.font = `700 ${24 * u}px ${FONTS.sans}`;
  c.fillText(t('share_img.sheet_title').toUpperCase(), x, y);
  y += 20 * u;
  c.fillStyle = P.ink; c.font = `700 ${fitSize(c, f.reg, w, 96 * u, 700, FONTS.serif)}px ${FONTS.serif}`;
  y += 86 * u; c.fillText(f.reg, x, y);
  c.font = `italic 400 ${34 * u}px ${FONTS.serif}`; c.fillStyle = rgba(P.ink, 0.75);
  y = wrap(c, [f.type, f.airline].filter(Boolean).join(' — '), x, y + 50 * u, w, 42 * u, 2);
  const rows = sheetRows(f);
  y += 16 * u;
  const lh = 58 * u;
  for (const [k, v] of rows) {
    if (y + lh > H - m - 40 * u) break;
    c.strokeStyle = rgba(P.ink, 0.15); c.lineWidth = 2 * u; c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y); c.stroke();
    c.fillStyle = rgba(P.ink, 0.55); c.font = `600 ${21 * u}px ${FONTS.sans}`; c.fillText(k.toUpperCase(), x, y + 37 * u);
    c.fillStyle = P.ink; c.font = `500 ${25 * u}px ${FONTS.sans}`; c.textAlign = 'right';
    c.fillText(fit(c, v, w * 0.62), x + w, y + 37 * u); c.textAlign = 'left';
    y += lh;
  }
  const by = H - m * 0.6;
  if (f.signature) { c.fillStyle = rgba(P.ink, 0.6); c.font = `500 ${22 * u}px ${FONTS.sans}`; c.fillText(`© ${f.signature}`, x, by); }
  if (o.info.brand) brandMark(c, land ? x + w : W - m, by, 20 * u, rgba(P.ink, 0.5), 'right');
}

// ------------------------------------------------------------------ vue
export async function render(root, params) {
  const s = await api(`/api/spots/${params.id}`);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('contrail.spotshare') || '{}') || {}; } catch { saved = {}; }
  const o = { template: 'frame', format: 'portrait', fit: 'cover', palette: 'auto', colors: null, focusX: 0.5, focusY: 0.5,
    info: { airline: true, airport: true, date: true, exif: true, weather: false, badges: true, brand: true }, signature: '', ...saved };
  o.info = { airline: true, airport: true, date: true, exif: true, weather: false, badges: true, brand: true, ...(saved.info || {}) };
  if (!TEMPLATES[o.template]) o.template = 'frame';
  if (o.format !== 'auto' && !FORMATS[o.format]) o.format = 'portrait';
  if (o.format === 'auto' && !s.image) o.format = 'portrait';
  o.focusX = 0.5; o.focusY = 0.5;   // le cadrage dépend de chaque photo
  const [img] = await Promise.all([s.image ? loadImage(mediaUrl('images', s.image)) : Promise.resolve(null), loadFonts(), loadTypes()]);

  root.innerHTML = `
    ${pageHead(esc(t('share_img.title')), { sub: `<span class="mono">${esc(regLabel(s))}</span> · ${esc(s.aircraft || s.aircraft_icao || '')}`, actions: `<a class="btn ghost" href="#/spots/${s.id_spotting}">${icon('chevron-left', '', 18)} ${esc(t('share_img.back'))}</a>` })}
    <div class="story-wrap">
      <div class="story-preview"><canvas data-canvas></canvas></div>
      <div class="stack">
        <div class="card stack">
          <div class="field"><span>${esc(t('share_img.template'))}</span><div class="style-grid" data-tpls>${Object.keys(TEMPLATES).map((k) => `<button type="button" data-tpl="${k}"><canvas width="120" height="150"></canvas><span>${esc(t(`share_img.t_${k}`))}</span></button>`).join('')}</div></div>
          <div class="field"><span>${esc(t('story.format'))}</span><div class="seg" data-fmt style="flex-wrap:wrap">
            ${img ? `<button data-v="auto" title="${esc(t('share_img.f_auto_hint'))}">${esc(t('share_img.f_auto'))}</button>` : ''}
            ${Object.keys(FORMATS).map((f) => `<button data-v="${f}">${esc(t(`story.f_${f}`))}</button>`).join('')}</div>
            ${img ? `<p class="tiny muted" data-auto-hint style="margin-top:6px"></p>` : ''}</div>
        </div>
        <div class="card stack">
          <div class="field"><span>${esc(t('share_img.infos'))}</span><div class="chips">${INFOS.map((k) => `<button class="chip" data-info="${k}">${esc(t(`share_img.i_${k}`))}</button>`).join('')}</div></div>
          <label class="field"><span>${esc(t('story.signature'))}</span><input data-sign value="${esc(o.signature)}" placeholder="${esc(t('story.signature_ph'))}" maxlength="40"></label>
        </div>
        <div class="card stack">
          <div class="field"><span>${esc(t('story.palette'))}</span><div class="palette-row">
            <button type="button" data-pal="auto" class="pal-auto">${esc(t('story.p_auto'))}</button>
            ${Object.entries(PALETTES).map(([k, p]) => `<button type="button" data-pal="${k}" title="${esc(t(`story.p_${k}`))}" style="--a:${p.accent};--b:${p.accent2};--c:${p.bg}"></button>`).join('')}</div></div>
          <div class="color-row">${['accent', 'accent2', 'bg', 'ink'].map((k) => `<label class="color-pick"><input type="color" data-color="${k}"><span>${esc(t(`story.c_${k}`))}</span></label>`).join('')}</div>
          ${img ? `<label class="toggle-row" data-fit-row><span><span class="t">${esc(t('share_img.fit_contain'))}</span><br><span class="d">${esc(t('share_img.fit_contain_d'))}</span></span>
            <span class="switch"><input type="checkbox" data-fit><span></span></span></label>
            <div class="field-row" data-focus-row><label class="field"><span>${esc(t('share_img.focus_x'))}</span><input type="range" min="0" max="1" step="0.01" data-fx value="0.5"></label>
            <label class="field"><span>${esc(t('share_img.focus_y'))}</span><input type="range" min="0" max="1" step="0.01" data-fy value="0.5"></label></div>`
            : `<p class="small muted">${icon('info', '', 15)} ${esc(t('share_img.no_photo'))}</p>`}
        </div>
        <div class="row wrap">
          <button class="btn primary grow" data-dl>${icon('download', '', 18)} ${esc(t('story.download'))}</button>
          ${navigator.canShare ? `<button class="btn" data-share>${icon('share-2', '', 18)} ${esc(t('share.native'))}</button>` : ''}
          ${window.ClipboardItem ? `<button class="btn" data-copy title="${esc(t('share_img.copy'))}">${icon('copy', '', 18)}</button>` : ''}
        </div>
      </div>
    </div>`;
  const canvas = root.querySelector('[data-canvas]');

  const aspect = img ? img.width / img.height : null;
  /** Options effectives : le format Auto adapte le canevas à la photo, ou bascule en « photo entière ». */
  function effective(opts) {
    const tp = TEMPLATES[opts.template] || TEMPLATES.frame;
    const f = facts(s, opts);
    if (opts.format === 'auto' && img) {
      const size = tp.auto?.(aspect, f);
      if (size) return { tp, f, W: size[0], H: size[1], opts: { ...opts, auto: true, aspect, fit: 'cover' } };
      const [W, H] = FORMATS.portrait;
      return { tp, f, W, H, opts: { ...opts, auto: false, fit: 'contain' } };
    }
    const [W, H] = FORMATS[opts.format] || FORMATS.portrait;
    return { tp, f, W, H, opts: { ...opts, auto: false } };
  }
  async function paint(cv, opts, scale = 1) {
    const e = effective(opts);
    cv.width = Math.round(e.W * scale); cv.height = Math.round(e.H * scale);
    const c = cv.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);
    await e.tp.draw(c, e.W, e.H, img, e.f, e.opts, palette(opts));
  }
  let pending = 0;
  async function draw() {
    const id = ++pending;
    const off = document.createElement('canvas');
    await paint(off, o);
    if (id !== pending) return;
    canvas.width = off.width; canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
  }
  async function thumbs() {
    for (const b of root.querySelectorAll('[data-tpl]')) {
      const tmp = document.createElement('canvas');
      await paint(tmp, { ...o, template: b.dataset.tpl, palette: 'auto', format: 'portrait' }, 0.12);
      const cv = b.querySelector('canvas'), g = cv.getContext('2d');
      const r = Math.max(cv.width / tmp.width, cv.height / tmp.height);
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(tmp, (cv.width - tmp.width * r) / 2, (cv.height - tmp.height * r) / 2, tmp.width * r, tmp.height * r);
    }
  }
  const sync = () => {
    root.querySelectorAll('[data-tpl]').forEach((b) => b.classList.toggle('on', b.dataset.tpl === o.template));
    root.querySelectorAll('[data-fmt] button').forEach((b) => b.classList.toggle('on', b.dataset.v === o.format));
    root.querySelectorAll('[data-info]').forEach((b) => b.classList.toggle('on', !!o.info[b.dataset.info]));
    root.querySelectorAll('[data-pal]').forEach((b) => b.classList.toggle('on', b.dataset.pal === o.palette));
    if (img) {
      const e = effective(o);
      const autoFmt = o.format === 'auto';
      root.querySelector('[data-fit]').checked = e.opts.fit === 'contain';
      root.querySelector('[data-fit]').disabled = autoFmt;
      root.querySelector('[data-focus-row]').hidden = e.opts.fit === 'contain' || e.opts.auto;
      root.querySelector('[data-auto-hint]').textContent = autoFmt
        ? (e.opts.auto ? t('share_img.auto_size', { w: e.W, h: e.H }) : t('share_img.auto_fixed')) : '';
    }
    const P = palette(o);
    root.querySelectorAll('[data-color]').forEach((i) => (i.value = P[i.dataset.color]));
    try { const { focusX, focusY, ...keep } = o; localStorage.setItem('contrail.spotshare', JSON.stringify(keep)); } catch { /* stockage indisponible */ }
  };
  const redraw = () => { sync(); draw(); };
  root.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => { o.template = b.dataset.tpl; if (o.palette === 'custom') o.palette = 'auto'; redraw(); }));
  root.querySelectorAll('[data-fmt] button').forEach((b) => (b.onclick = () => { o.format = b.dataset.v; redraw(); }));
  root.querySelectorAll('[data-info]').forEach((b) => (b.onclick = () => { o.info[b.dataset.info] = !o.info[b.dataset.info]; redraw(); thumbs(); }));
  root.querySelectorAll('[data-pal]').forEach((b) => (b.onclick = () => { o.palette = b.dataset.pal; redraw(); }));
  root.querySelectorAll('[data-color]').forEach((i) => (i.oninput = () => {
    if (o.palette !== 'custom') o.colors = palette(o);
    o.palette = 'custom';
    o.colors = { ...o.colors, [i.dataset.color]: i.value };
    redraw();
  }));
  root.querySelector('[data-sign]').oninput = (e) => { o.signature = e.target.value; redraw(); };
  root.querySelector('[data-fit]')?.addEventListener('change', (e) => { o.fit = e.target.checked ? 'contain' : 'cover'; redraw(); });
  root.querySelector('[data-fx]')?.addEventListener('input', (e) => { o.focusX = Number(e.target.value); redraw(); });
  root.querySelector('[data-fy]')?.addEventListener('input', (e) => { o.focusY = Number(e.target.value); redraw(); });
  const fname = () => `${regLabel(s).replace(/[\\/:*?"<>|\s]+/g, '_')}-${o.template}-${o.format}.png`;
  root.querySelector('[data-dl]').onclick = async () => {
    const b = await canvasBlob(canvas);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = fname(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  root.querySelector('[data-share]')?.addEventListener('click', async () => {
    const file = new File([await canvasBlob(canvas)], fname(), { type: 'image/png' });
    const text = [regLabel(s), s.aircraft, s.owner].filter(Boolean).join(' · ');
    if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: regLabel(s), text }).catch(() => {});
    else toast(esc(t('story.share_unsupported')), { type: 'warn' });
  });
  root.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(canvas) })]);
      toast(esc(t('share_img.copied')), { type: 'success' });
    } catch { toast(esc(t('share_img.copy_failed')), { type: 'warn' }); }
  });
  redraw();
  thumbs();
}
