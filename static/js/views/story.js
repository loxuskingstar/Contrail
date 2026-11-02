// Générateur d'image récapitulative (format story / post / paysage)
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, toast } from '../ui.js';

const FORMATS = { story: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], landscape: [1920, 1080] };
const STATS = ['spots', 'registrations', 'types', 'airlines', 'airports', 'countries', 'special_liveries', 'days', 'flights', 'km'];
const STYLES = ['glass_dark', 'glass_light', 'accent', 'minimal'];

export async function render(root) {
  const opts = JSON.parse(localStorage.getItem('contrail.story') || 'null') || {
    format: 'story', style: 'glass_dark', year: String(new Date().getFullYear()), stats: ['spots', 'registrations', 'types', 'airlines', 'airports', 'countries'],
    bg: null, title: '', showTop: true,
  };
  const [base, photos] = await Promise.all([api('/api/stats'), api('/api/spots', { query: { has_photo: true, limit: 40, sort: 'date_desc' } })]);
  root.innerHTML = `
    ${pageHead(esc(t('nav.story')), { sub: esc(t('story.sub')) })}
    <div class="story-wrap">
      <div class="story-preview"><canvas data-canvas></canvas></div>
      <div class="card stack">
        <label class="field"><span>${esc(t('story.format'))}</span><div class="seg" data-g="format" style="flex-wrap:wrap">${Object.keys(FORMATS).map((f) => `<button data-v="${f}">${esc(t(`story.f_${f}`))}</button>`).join('')}</div></label>
        <label class="field"><span>${esc(t('story.style'))}</span><div class="seg" data-g="style" style="flex-wrap:wrap">${STYLES.map((s) => `<button data-v="${s}">${esc(t(`story.s_${s}`))}</button>`).join('')}</div></label>
        <div class="field-row">
          <label class="field"><span>${esc(t('story.period'))}</span><select data-year><option value="">${esc(t('stats.all_time'))}</option>${base.years.map((y) => `<option ${opts.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('story.title'))}</span><input data-title value="${esc(opts.title)}" placeholder="${esc(t('story.title_ph'))}"></label>
        </div>
        <div class="field"><span>${esc(t('story.stats'))}</span><div class="chips">${STATS.filter((s) => store.mod('flights') || !['flights', 'km'].includes(s)).map((s) => `<button class="chip" data-stat="${s}">${esc(t(`story.st_${s}`))}</button>`).join('')}</div></div>
        <label class="toggle-row"><span class="t">${esc(t('story.show_top'))}</span><span class="switch"><input type="checkbox" data-top ${opts.showTop ? 'checked' : ''}><span></span></span></label>
        <div class="field"><span>${esc(t('story.background'))}</span><div class="hscroll" style="margin:0" data-bgs>
          <button class="tile" data-bg="" style="width:84px;aspect-ratio:3/4;display:grid;place-items:center;border:0">${icon('palette', '', 22)}</button>
          ${photos.items.map((p) => `<button class="tile" data-bg="${esc(p.image)}" style="width:84px;aspect-ratio:3/4;border:0;padding:0"><img src="${mediaUrl('thumbs', p.thumb)}" alt=""></button>`).join('')}</div></div>
        <div class="row"><button class="btn primary grow" data-dl>${icon('download', '', 18)} ${esc(t('story.download'))}</button>
          ${navigator.canShare ? `<button class="btn" data-share>${icon('share-2', '', 18)}</button>` : ''}</div>
      </div>
    </div>`;
  const canvas = root.querySelector('[data-canvas]');
  let data = null;
  const imgCache = new Map();

  const sync = () => {
    root.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === opts[g.dataset.g])));
    root.querySelectorAll('[data-stat]').forEach((b) => b.classList.toggle('on', opts.stats.includes(b.dataset.stat)));
    root.querySelectorAll('[data-bg]').forEach((b) => (b.style.outline = (b.dataset.bg || null) === (opts.bg || null) ? '3px solid var(--accent)' : 'none'));
    localStorage.setItem('contrail.story', JSON.stringify(opts));
  };

  async function loadData() {
    const [s, f] = await Promise.all([api('/api/stats', { query: { year: opts.year } }), store.mod('flights') ? api('/api/stats/flights', { query: { year: opts.year } }) : Promise.resolve({})]);
    data = { ...s.totals, flights: f.count || 0, km: f.km || 0, top_type: s.top_types[0], top_airport: s.top_airports[0], top_airline: s.top_airlines[0], top_country: s.top_countries[0] };
  }

  const loadImg = (src) => {
    if (!src) return Promise.resolve(null);
    if (imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    imgCache.set(src, p);
    return p;
  };

  async function draw() {
    if (!data) return;
    const [W, H] = FORMATS[opts.format];
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#3b82f6';
    const light = opts.style === 'glass_light' || opts.style === 'minimal';
    const ink = light ? '#0e1525' : '#ffffff';
    const sub = light ? 'rgba(14,21,37,.6)' : 'rgba(255,255,255,.75)';
    const font = css.getPropertyValue('--font');
    const u = Math.min(W, H) / 1080;

    // Fond
    const bg = await loadImg(opts.bg ? mediaUrl('images', opts.bg) : null);
    if (opts.style === 'minimal') { c.fillStyle = '#f6f7fb'; c.fillRect(0, 0, W, H); }
    else if (bg && opts.style !== 'accent') {
      const r = Math.max(W / bg.width, H / bg.height);
      c.drawImage(bg, (W - bg.width * r) / 2, (H - bg.height * r) / 2, bg.width * r, bg.height * r);
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, light ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.05)');
      g.addColorStop(1, light ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.82)');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else {
      const g = c.createLinearGradient(0, 0, W, H);
      if (opts.style === 'glass_light') { g.addColorStop(0, '#eef2ff'); g.addColorStop(1, '#fdf2f8'); }
      else { g.addColorStop(0, accent); g.addColorStop(1, '#0b1020'); }
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      // halos
      for (const [x, y, r, col] of [[W * 0.15, H * 0.12, W * 0.6, accent], [W * 0.95, H * 0.7, W * 0.7, '#ec4899']]) {
        const rg = c.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, col + '88'); rg.addColorStop(1, col + '00');
        c.fillStyle = rg; c.fillRect(0, 0, W, H);
      }
    }

    const pad = 80 * u;
    // En-tête
    c.fillStyle = ink;
    c.font = `700 ${30 * u}px ${font}`;
    c.globalAlpha = 0.85;
    c.fillText('✈  CONTRAIL', pad, pad + 20 * u);
    c.globalAlpha = 1;
    const title = opts.title || (opts.year ? t('story.default_title_year', { y: opts.year }) : t('story.default_title'));
    c.font = `800 ${86 * u}px ${font}`;
    const titleY = opts.format === 'landscape' ? pad + 130 * u : H * 0.2;
    wrapText(c, title, pad, titleY, W - pad * 2, 92 * u);

    // Tuiles de statistiques
    const keys = opts.stats.slice(0, opts.format === 'landscape' ? 6 : 8);
    const cols = opts.format === 'landscape' ? 3 : 2;
    const rows = Math.ceil(keys.length / cols);
    const gap = 24 * u;
    const top3 = opts.showTop && opts.format !== 'landscape' ? 300 * u : 0;
    const gridTop = opts.format === 'landscape' ? titleY + 70 * u : Math.max(titleY + 110 * u, H - pad - top3 - 90 * u - rows * (200 * u + gap));
    const tileW = opts.format === 'landscape' ? (W * 0.62 - pad - gap * (cols - 1)) / cols : (W - pad * 2 - gap * (cols - 1)) / cols;
    const tileH = opts.format === 'landscape' ? 190 * u : 200 * u;
    keys.forEach((k, i) => {
      const x = pad + (i % cols) * (tileW + gap), y = gridTop + Math.floor(i / cols) * (tileH + gap);
      glassRect(c, x, y, tileW, tileH, 36 * u, light);
      c.fillStyle = ink;
      c.font = `800 ${74 * u}px ${font}`;
      c.fillText(k === 'km' ? fmtNum(data.km) : fmtNum(data[k] || 0), x + 32 * u, y + 105 * u);
      c.fillStyle = sub;
      c.font = `600 ${28 * u}px ${font}`;
      c.fillText(t(`story.st_${k}`) + (k === 'km' ? '' : ''), x + 32 * u, y + 155 * u);
    });

    // Tops
    if (opts.showTop) {
      const lines = [
        data.top_type && [t('story.top_type'), `${data.top_type.k} · ${data.top_type.n}×`],
        data.top_airport && [t('story.top_airport'), `${data.top_airport.k} · ${data.top_airport.n}×`],
        data.top_airline && [t('story.top_airline'), `${data.top_airline.label || data.top_airline.k}`],
        data.top_country && [t('story.top_country'), countryName(data.top_country.k)],
      ].filter(Boolean);
      let x, y, w;
      if (opts.format === 'landscape') { x = W * 0.62 + gap; y = gridTop; w = W - x - pad; }
      else { x = pad; y = gridTop + rows * (tileH + gap); w = W - pad * 2; }
      const h = Math.min(lines.length, 4) * 66 * u + 40 * u;
      if (lines.length) {
        glassRect(c, x, y, w, h, 36 * u, light);
        lines.forEach(([l, v], i) => {
          const ly = y + 62 * u + i * 66 * u;
          c.fillStyle = sub; c.font = `600 ${26 * u}px ${font}`; c.fillText(l, x + 32 * u, ly);
          c.fillStyle = ink; c.font = `700 ${32 * u}px ${font}`;
          const tw = c.measureText(v).width;
          c.fillText(fit(c, v, w * 0.55), x + w - 32 * u - Math.min(tw, w * 0.55), ly);
        });
      }
    }
    c.fillStyle = sub;
    c.font = `500 ${22 * u}px ${font}`;
    c.fillText(new Date().toLocaleDateString(), pad, H - pad * 0.6);
  }

  const redraw = () => { sync(); draw(); };
  root.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = () => { opts[g.dataset.g] = b.dataset.v; redraw(); })));
  root.querySelectorAll('[data-stat]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.stat;
    opts.stats = opts.stats.includes(k) ? opts.stats.filter((x) => x !== k) : [...opts.stats, k];
    redraw();
  }));
  root.querySelectorAll('[data-bg]').forEach((b) => (b.onclick = () => { opts.bg = b.dataset.bg || null; redraw(); }));
  root.querySelector('[data-year]').onchange = async (e) => { opts.year = e.target.value; await loadData(); redraw(); };
  root.querySelector('[data-title]').oninput = (e) => { opts.title = e.target.value; redraw(); };
  root.querySelector('[data-top]').onchange = (e) => { opts.showTop = e.target.checked; redraw(); };
  const blob = () => new Promise((res) => canvas.toBlob(res, 'image/png'));
  root.querySelector('[data-dl]').onclick = async () => {
    const b = await blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = `contrail-${opts.year || 'all'}-${opts.format}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  root.querySelector('[data-share]')?.addEventListener('click', async () => {
    const file = new File([await blob()], 'contrail.png', { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Contrail' }).catch(() => {});
    else toast(esc(t('story.share_unsupported')), { type: 'warn' });
  });
  await loadData();
  redraw();
}

function glassRect(c, x, y, w, h, r, light) {
  c.save();
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.fillStyle = light ? 'rgba(255,255,255,.62)' : 'rgba(255,255,255,.12)';
  c.shadowColor = 'rgba(0,0,0,.18)'; c.shadowBlur = 40; c.shadowOffsetY = 12;
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 2;
  c.strokeStyle = light ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.22)';
  c.stroke();
  c.restore();
}

function fit(c, text, max) {
  if (c.measureText(text).width <= max) return text;
  while (text.length > 1 && c.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}

function wrapText(c, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '', yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (c.measureText(test).width > maxW && line) { c.fillText(line, x, yy); line = w; yy += lh; }
    else line = test;
  }
  c.fillText(line, x, yy);
}
