// Carte globale : tous les lieux où tu as spotté, période réglable et lecture animée (année / trimestre / mois / semaine)
import { api } from '../api.js';
import { t, fmtNum, fmtDate, flag, countryName, locale } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast } from '../ui.js';

const KIND = { airport: '#3b82f6', location: '#10b981', gps: '#f59e0b' };
const NEW_C = '#ef4444', OLD_C = '#94a3b8';
const MIN_PLAIN = 10, MIN_COUNT = 22, MAX_SIZE = 46;
const BASE_MS = { year: 1400, quarter: 1100, month: 800, week: 380 };

const PREF_KEY = 'ct_gmap';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (s) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Découpe [start, end] (dates ISO) en étapes d'une année, d'un trimestre, d'un mois ou d'une semaine. */
function buildSteps(unit, start, end) {
  const out = [];
  let d = utc(start);
  const e = utc(end);
  if (unit === 'year') d = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  else if (unit === 'quarter') d = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  else if (unit === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  else d = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5);               // lundi de la semaine
  const monthFmt = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  while (d <= e && out.length < 800) {
    let next, label;
    if (unit === 'year') { next = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)); label = String(d.getUTCFullYear()); }
    else if (unit === 'quarter') {
      next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1));
      label = t('gmap.quarter', { q: d.getUTCMonth() / 3 + 1, y: d.getUTCFullYear() });
    } else if (unit === 'month') { next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); label = cap(monthFmt.format(d)); }
    else { next = new Date(d.getTime() + 7 * 864e5); label = t('gmap.week_of', { d: fmtDate(iso(d), { time: false, short: true }) }); }
    out.push({ from: iso(d), to: iso(new Date(next.getTime() - 864e5)), label });
    d = next;
  }
  return out;
}

const sizeFor = (count, max, withCount) => {
  const lo = withCount ? MIN_COUNT : MIN_PLAIN;
  return Math.round(lo + (MAX_SIZE - lo) * Math.sqrt(count / Math.max(1, max)));
};
const shortNum = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

export async function render(root) {
  let facets;
  try { facets = await api('/api/spots/facets'); } catch (e) { errorToast(e); return; }
  const years = (facets.years || []).slice().sort();
  if (!years.length) { root.innerHTML = pageHead(esc(t('gmap.title'))) + `<div class="card">${emptyState('map', t('map.empty'), '')}</div>`; return; }
  const prefs = { base: 'default', cluster: true, counts: false, legend: true, color: 'kind', unit: 'year', cumul: true, speed: 1, ...loadPrefs() };
  const opts = (sel) => years.map((y) => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
  const sel = (name, cur, items) => `<select class="input" data-${name}>${items.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  root.innerHTML = `${pageHead(esc(t('gmap.title')), { sub: `<span data-sub>&nbsp;</span>` })}
    <div class="card gm-bar">
      <div class="gm-row">
        <label class="gm-f">${esc(t('gmap.from'))}<select class="input" data-from>${opts(years[0])}</select></label>
        <label class="gm-f">${esc(t('gmap.to'))}<select class="input" data-to>${opts(years[years.length - 1])}</select></label>
        <label class="gm-f">${esc(t('gmap.color'))}${sel('color', prefs.color, [['kind', t('gmap.c_kind')], ['new', t('gmap.c_new')]])}</label>
        <label class="gm-f">${esc(t('gmap.base'))}${sel('base', prefs.base, [['default', t('gmap.b_default')], ['sat_esri', t('gmap.b_esri')], ['sat_ign', t('gmap.b_ign')]])}</label>
        <label class="gm-sw"><input type="checkbox" data-cluster ${prefs.cluster ? 'checked' : ''}><span>${esc(t('gmap.cluster'))}</span></label>
        <label class="gm-sw"><input type="checkbox" data-counts ${prefs.counts ? 'checked' : ''}><span>${esc(t('gmap.show_counts'))}</span></label>
        <label class="gm-sw"><input type="checkbox" data-legend ${prefs.legend ? 'checked' : ''}><span>${esc(t('gmap.show_legend'))}</span></label>
      </div>
      <div class="gm-row gm-player">
        <button class="btn sm primary" data-play>${icon('play', '', 14)} ${esc(t('gmap.play'))}</button>
        <label class="gm-f">${esc(t('gmap.step'))}${sel('unit', prefs.unit, [['year', t('gmap.u_year')], ['quarter', t('gmap.u_quarter')], ['month', t('gmap.u_month')], ['week', t('gmap.u_week')]])}</label>
        <label class="gm-f">${esc(t('gmap.mode'))}${sel('cumul', prefs.cumul ? '1' : '0', [['1', t('gmap.m_cumul')], ['0', t('gmap.m_window')]])}</label>
        <label class="gm-f">${esc(t('gmap.speed'))}${sel('speed', prefs.speed, [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']])}</label>
        <input type="range" class="gm-range" data-range min="0" max="0" value="0" aria-label="${esc(t('gmap.timeline'))}">
      </div>
    </div>
    <div class="grid kpis" style="margin-bottom:12px" data-kpis></div>
    <div class="gm-wrap">
      <div class="map" data-map></div>
      <div class="gm-hud" data-hud><div class="gm-hud-t" data-hud-t></div><div class="gm-hud-s" data-hud-s></div></div>
      <div class="gm-legend" data-leg></div>
    </div>`;

  const { createMap, styleFor } = await import('../lib/map.js');
  const map = await createMap(root.querySelector('[data-map]'), { base: prefs.base === 'default' ? undefined : prefs.base });
  const $ = (s) => root.querySelector(s);

  const state = { steps: [], cur: null, bounds: null, playing: false, token: 0 };
  let fitted = false, seq = 0;
  const live = new Map();                         // id du lieu → { api, el, in, num }

  const range = () => { let a = $('[data-from]').value, b = $('[data-to]').value; if (a > b) [a, b] = [b, a]; return [a, b]; };
  const save = () => savePrefs({ base: prefs.base, cluster: prefs.cluster, counts: prefs.counts, legend: prefs.legend, color: prefs.color, unit: prefs.unit, cumul: prefs.cumul, speed: prefs.speed });

  /* ------------------------------------------------------------------ légende */
  function drawLegend(max, hasClusters = false) {
    const box = $('[data-leg]');
    box.hidden = !prefs.legend;
    if (!prefs.legend) return;
    const colors = prefs.color === 'new'
      ? [[NEW_C, t('gmap.l_new')], [OLD_C, t('gmap.l_old')]]
      : [[KIND.airport, t('gmap.l_airport')], [KIND.location, t('gmap.l_location')], [KIND.gps, t('gmap.l_gps')]];
    const vals = [...new Set([max, Math.round(max / 4), 1].filter((v) => v >= 1))].sort((x, y) => y - x);
    const sizes = vals.map((v) => { const s = sizeFor(v, max, prefs.counts); return `<div class="gm-sz"><i style="width:${s}px;height:${s}px"></i><span>${fmtNum(v)}</span></div>`; }).join('');
    box.innerHTML = `<div class="gm-lt">${esc(t('gmap.legend'))}</div>
      <div class="gm-lc">${colors.map(([c, l]) => `<div><i class="gm-cd" style="--c:${c}"></i>${esc(l)}</div>`).join('')}${hasClusters ? `<div><i class="gm-cd gm-cdm"></i>${esc(t('gmap.l_cluster'))}</div>` : ''}</div>
      <div class="gm-lt gm-lt2">${esc(t('gmap.l_size'))}</div><div class="gm-ls">${sizes}</div>`;
  }

  /* ------------------------------------------------------------------ popup */
  function popupHtml(p, color) {
    const href = p.location_id ? `#/spots?location_id=${p.location_id}` : (p.airport ? `#/spots?airport=${encodeURIComponent(p.airport)}` : '#/spots');
    const name = p.name || p.airport || '—';
    const sub = [p.country ? `${flag(p.country)} ${esc(countryName(p.country))}` : '', p.airport ? esc(p.airport) : ''].filter(Boolean).join(' · ');
    const same = p.first && p.last && p.first.slice(0, 10) === p.last.slice(0, 10);
    const per = p.first ? (same ? esc(fmtDate(p.first, { time: false })) : `${esc(fmtDate(p.first, { time: false }))} → ${esc(fmtDate(p.last, { time: false }))}`) : '';
    const chips = (p.types || []).slice(0, 4).map((x) => `<span class="gp-chip">${esc(x.k)} <b>${x.n}</b></span>`).join('');
    const extra = [p.special ? `<span class="gp-chip s">★ ${p.special}</span>` : '', p.military ? `<span class="gp-chip m">${esc(t('gmap.military'))} ${p.military}</span>` : ''].join('');
    return `<div class="gp"><div class="gp-h"><i class="gp-d" style="background:${color}"></i><div class="gp-hh"><div class="gp-t">${esc(name)}</div>${sub ? `<div class="gp-s">${sub}</div>` : ''}</div></div>
      <div class="gp-k"><div><b>${fmtNum(p.count)}</b><span>${esc(t('gmap.n_spots', { count: p.count }))}</span></div><div><b>${fmtNum(p.regs)}</b><span>${esc(t('gmap.n_planes', { count: p.regs }))}</span></div><div><b>${fmtNum(p.types_count || 0)}</b><span>${esc(t('gmap.n_types', { count: p.types_count || 0 }))}</span></div></div>
      ${chips || extra ? `<div class="gp-chips">${chips}${extra}</div>` : ''}
      ${per ? `<div class="gp-p">${icon('calendar', '', 13)} ${per}</div>` : ''}
      <a class="gp-a" href="${href}">${esc(t('gmap.open'))} ${icon('arrow-right', '', 14)}</a></div>`;
  }

  /* ------------------------------------------------------------------ dessin */
  /* ------------------------------------------------------------------ regroupement selon le zoom */
  const CLUSTER_PX = 42;
  const COLOR_OF = (cat) => (cat === 'new' ? NEW_C : cat === 'old' ? OLD_C : (KIND[cat] || KIND.airport));
  const LABEL_OF = (cat) => t({ new: 'gmap.l_new', old: 'gmap.l_old', airport: 'gmap.l_airport', location: 'gmap.l_location', gps: 'gmap.l_gps' }[cat] || 'gmap.l_airport');

  /** Regroupe les lieux dont les ronds se chevaucheraient à l'écran (distance en pixels au zoom courant). */
  function clusterize(places) {
    if (!prefs.cluster) return places.map((p) => ({ members: [p], lat: p.lat, lng: p.lng, count: p.count }));
    const pts = places.map((p) => ({ p, ...map.map.project([p.lng, p.lat]) })).sort((a, b) => b.p.count - a.p.count);
    const cell = CLUSTER_PX, grid = new Map(), out = [];
    const keyOf = (x, y) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    for (const pt of pts) { const k = keyOf(pt.x, pt.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(pt); }
    for (const seed of pts) {
      if (seed.used) continue;
      seed.used = true;
      const mem = [seed];
      const cx = Math.floor(seed.x / cell), cy = Math.floor(seed.y / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const o of grid.get(`${cx + i}:${cy + j}`) || []) {
          if (!o.used && Math.hypot(o.x - seed.x, o.y - seed.y) <= CLUSTER_PX) { o.used = true; mem.push(o); }
        }
      }
      const count = mem.reduce((n, m) => n + m.p.count, 0);
      out.push({ members: mem.map((m) => m.p), count,
        lat: mem.reduce((n, m) => n + m.p.lat * m.p.count, 0) / count, lng: mem.reduce((n, m) => n + m.p.lng * m.p.count, 0) / count });
    }
    return out;
  }

  const donut = (comp, total) => {
    let acc = 0;
    return `conic-gradient(${[...comp].sort((a, b) => b[1] - a[1]).map(([c, n]) => { const from = acc; acc += (n / total) * 100; return `${COLOR_OF(c)} ${from.toFixed(2)}% ${acc.toFixed(2)}%`; }).join(', ')})`;
  };

  function clusterPopup(it) {
    const rows = [...it.comp].sort((a, b) => b[1] - a[1]).map(([cat, n]) => `<div class="gc-r"><i class="gm-cd" style="--c:${COLOR_OF(cat)}"></i><span>${esc(LABEL_OF(cat))}</span><b>${fmtNum(n)}</b><em>${Math.round((n / it.count) * 100)} %</em></div>`).join('');
    const list = [...it.members].sort((a, b) => b.count - a.count);
    const places = list.slice(0, 6).map((p) => {
      const href = p.location_id ? `#/spots?location_id=${p.location_id}` : (p.airport ? `#/spots?airport=${encodeURIComponent(p.airport)}` : '#/spots');
      return `<a class="gc-p" href="${href}"><span>${esc(p.name || p.airport || '—')}</span><b>${fmtNum(p.count)}</b></a>`;
    }).join('');
    return `<div class="gp"><div class="gp-h"><div class="gp-hh"><div class="gp-t">${esc(t('gmap.n_places', { count: it.members.length }))}</div><div class="gp-s">${esc(t('spots.count', { n: it.count, nf: fmtNum(it.count) }))}</div></div></div>
      <div class="gc-rows">${rows}</div><div class="gc-list">${places}${list.length > 6 ? `<div class="gc-more">${esc(t('gmap.more_places', { n: list.length - 6 }))}</div>` : ''}</div></div>`;
  }

  function zoomTo(it) {
    const m = map.map;
    const lngs = it.members.map((p) => p.lng), lats = it.members.map((p) => p.lat);
    const span = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats));
    if (span < 1e-5 || m.getZoom() >= 15) { map.popup([it.lat, it.lng], clusterPopup(it)); return; }   // impossible de séparer davantage : on liste
    m.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 90, maxZoom: 16, duration: 500 });
  }

  let data = null;
  function paint(places, firstOf, freshFrom) { data = { places, firstOf, freshFrom }; render(); }

  function render() {
    if (!data) return;
    const { places, firstOf, freshFrom } = data;
    for (const p of places) {
      const fresh = (firstOf?.get(p.id) || p.first || '') >= freshFrom;
      p._cat = prefs.color === 'new' ? (fresh ? 'new' : 'old') : (KIND[p.kind] ? p.kind : 'airport');
    }
    const items = clusterize(places);
    for (const it of items) {
      it.comp = new Map();
      for (const p of it.members) it.comp.set(p._cat, (it.comp.get(p._cat) || 0) + p.count);
    }
    const max = Math.max(1, ...items.map((i) => i.count));
    const seen = new Set();
    for (const it of items) {
      const multi = it.members.length > 1;
      const p = it.members[0];
      const key = multi ? `c:${it.members.map((m) => m.id).sort().join('|')}` : p.id;
      seen.add(key);
      const size = multi ? Math.max(36, sizeFor(it.count, max, true)) : sizeFor(p.count, max, prefs.counts);
      let o = live.get(key);
      if (!o) {
        const html = multi ? '<div class="gcl"><div class="gcl-in"><span></span></div></div>' : '<div class="gdot"><div class="gdot-in"><span></span></div></div>';
        o = multi
          ? { api: map.marker([it.lat, it.lng], { kind: 'element', html, group: 'g', onClick: () => zoomTo(o.item) }) }
          : { api: map.marker([p.lat, p.lng], { kind: 'element', html, group: 'g', popup: ' ', popupClass: 'gpop' }) };
        o.el = o.api.el; o.num = o.el.querySelector('span'); o.multi = multi;
        live.set(key, o);
      }
      o.item = it;
      // propriétés une à une : MapLibre garde sa position dans style.transform
      o.el.style.width = `${size}px`; o.el.style.height = `${size}px`; o.el.style.zIndex = String(1000 - size);
      if (multi) {
        o.el.firstElementChild.style.background = donut(it.comp, it.count);
        o.num.textContent = shortNum(it.count);
        o.el.classList.toggle('big-n', size >= 52);
        o.el.title = `${t('gmap.n_places', { count: it.members.length })} · ${it.count}`;
      } else {
        const color = COLOR_OF(p._cat);
        o.el.style.setProperty('--c', color);
        o.el.title = `${p.name || p.airport || ''} · ${p.count}`;
        o.num.textContent = prefs.counts ? shortNum(p.count) : '';
        o.el.classList.toggle('has-n', prefs.counts);
        o.el.classList.toggle('big-n', prefs.counts && size >= 30);
        const off = Math.round(size / 2) + 6;
        o.api.marker.getPopup().setHTML(popupHtml(p, color)).setOffset(off);
      }
    }
    for (const [k, o] of live) if (!seen.has(k)) { o.api.remove(); live.delete(k); }
    drawLegend(max, items.some((i) => i.members.length > 1));
  }

  async function fetchMap(from, to) {
    return api('/api/spots/map', { query: { date_from: from, date_to: to } });
  }

  async function draw() {
    const [a, b] = range();
    const mine = ++seq;
    const unit = prefs.unit;
    let res, firstOf = null, freshFrom, title, label;
    try {
      if (state.cur === null) {
        res = await fetchMap(`${a}-01-01`, `${b}-12-31`);
        if (mine !== seq) return;
        // bornes réelles : de la première à la dernière date de spot dans la période
        const firsts = res.places.map((p) => p.first).filter(Boolean).sort();
        const lasts = res.places.map((p) => p.last).filter(Boolean).sort();
        state.bounds = firsts.length ? [firsts[0].slice(0, 10), lasts[lasts.length - 1].slice(0, 10)] : [`${a}-01-01`, `${b}-12-31`];
        state.steps = buildSteps(unit, state.bounds[0], state.bounds[1]);
        const r = $('[data-range]');
        r.max = Math.max(0, state.steps.length - 1);
        r.value = r.max;
        freshFrom = `${b}-01-01`;
        title = a === b ? a : `${a} – ${b}`;
      } else {
        const st = state.steps[state.cur];
        const start = prefs.cumul ? state.bounds[0] : st.from;
        res = await fetchMap(start, st.to);
        if (mine !== seq) return;
        if (!prefs.cumul && prefs.color === 'new') {
          // en mode « période seule », la première visite se lit sur le cumul depuis le début
          const cum = await fetchMap(state.bounds[0], st.to);
          if (mine !== seq) return;
          firstOf = new Map(cum.places.map((p) => [p.id, p.first]));
        }
        freshFrom = st.from;
        title = st.label;
        $('[data-range]').value = state.cur;
      }
    } catch (e) { errorToast(e); return; }
    const places = res.places;
    paint(places, firstOf, freshFrom);
    const countries = new Set(places.map((p) => p.country).filter(Boolean));
    $('[data-kpis]').innerHTML = [['map-pin', places.length, t('gmap.k_places')], ['camera', res.total, t('outing.k_spots')], ['globe', countries.size, t('gmap.k_countries')]]
      .map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div></div>`).join('');
    $('[data-sub]').textContent = a === b ? a : `${a} – ${b}`;
    $('[data-hud-t]').textContent = title;
    $('[data-hud-s]').textContent = `${t('spots.count', { n: res.total, nf: fmtNum(res.total) })} · ${t('gmap.n_places', { count: places.length })}`;
    if (!fitted && places.length) { map.fit(places.map((p) => [p.lat, p.lng]), { maxZoom: 8 }); fitted = true; }
  }

  /* ------------------------------------------------------------------ lecture */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setPlayBtn = (on) => { $('[data-play]').innerHTML = `${icon(on ? 'pause' : 'play', '', 14)} ${esc(t(on ? 'gmap.pause' : 'gmap.play'))}`; };
  const stop = () => { state.playing = false; state.token++; if (root.isConnected) setPlayBtn(false); };

  async function play() {
    if (state.playing) { stop(); return; }
    const token = ++state.token;
    state.playing = true;
    setPlayBtn(true);
    if (state.cur === null || state.cur >= state.steps.length - 1) state.cur = -1;   // départ depuis le début
    while (state.playing && token === state.token && root.isConnected) {
      if (state.cur + 1 >= state.steps.length) break;
      state.cur += 1;
      await draw();
      if (token !== state.token) return;
      await sleep(BASE_MS[prefs.unit] / prefs.speed);
    }
    if (token === state.token) stop();
  }

  function reset() { stop(); state.cur = null; draw(); }                              // retour à la vue « période complète »

  $('[data-play]').onclick = play;
  $('[data-range]').addEventListener('input', (e) => { if (state.playing) stop(); state.cur = Number(e.target.value); draw(); });
  $('[data-from]').addEventListener('change', reset);
  $('[data-to]').addEventListener('change', reset);
  $('[data-color]').addEventListener('change', (e) => { prefs.color = e.target.value; save(); draw(); });
  $('[data-unit]').addEventListener('change', (e) => { prefs.unit = e.target.value; save(); reset(); });
  $('[data-cumul]').addEventListener('change', (e) => { prefs.cumul = e.target.value === '1'; save(); state.cur === null ? draw() : (stop(), draw()); });
  $('[data-speed]').addEventListener('change', (e) => { prefs.speed = Number(e.target.value); save(); });
  $('[data-base]').addEventListener('change', (e) => { prefs.base = e.target.value; save(); map.map.setStyle(styleFor(prefs.base === 'default' ? undefined : prefs.base)); root.querySelector('.gm-wrap').classList.toggle('sat', prefs.base !== 'default'); });
  root.querySelector('.gm-wrap').classList.toggle('sat', prefs.base !== 'default');
  $('[data-cluster]').addEventListener('change', (e) => { prefs.cluster = e.target.checked; save(); render(); });
  map.map.on('zoomend', render);
  $('[data-counts]').addEventListener('change', (e) => { prefs.counts = e.target.checked; save(); draw(); });
  $('[data-legend]').addEventListener('change', (e) => { prefs.legend = e.target.checked; save(); $('[data-leg]').hidden = !prefs.legend; if (prefs.legend) draw(); });
  $('[data-from]').value = years[0]; $('[data-to]').value = years[years.length - 1];
  window.addEventListener('hashchange', stop, { once: true });
  await draw();
}
