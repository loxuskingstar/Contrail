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
  const prefs = { base: 'default', counts: false, legend: true, color: 'kind', unit: 'year', cumul: true, speed: 1, ...loadPrefs() };
  const opts = (sel) => years.map((y) => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
  const sel = (name, cur, items) => `<select class="input" data-${name}>${items.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  root.innerHTML = `${pageHead(esc(t('gmap.title')), { sub: `<span data-sub>&nbsp;</span>` })}
    <div class="card gm-bar">
      <div class="gm-row">
        <label class="gm-f">${esc(t('gmap.from'))}<select class="input" data-from>${opts(years[0])}</select></label>
        <label class="gm-f">${esc(t('gmap.to'))}<select class="input" data-to>${opts(years[years.length - 1])}</select></label>
        <label class="gm-f">${esc(t('gmap.color'))}${sel('color', prefs.color, [['kind', t('gmap.c_kind')], ['new', t('gmap.c_new')]])}</label>
        <label class="gm-f">${esc(t('gmap.base'))}${sel('base', prefs.base, [['default', t('gmap.b_default')], ['sat_esri', t('gmap.b_esri')], ['sat_ign', t('gmap.b_ign')]])}</label>
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
  const save = () => savePrefs({ base: prefs.base, counts: prefs.counts, legend: prefs.legend, color: prefs.color, unit: prefs.unit, cumul: prefs.cumul, speed: prefs.speed });

  /* ------------------------------------------------------------------ légende */
  function drawLegend(max) {
    const box = $('[data-leg]');
    box.hidden = !prefs.legend;
    if (!prefs.legend) return;
    const colors = prefs.color === 'new'
      ? [[NEW_C, t('gmap.l_new')], [OLD_C, t('gmap.l_old')]]
      : [[KIND.airport, t('gmap.l_airport')], [KIND.location, t('gmap.l_location')], [KIND.gps, t('gmap.l_gps')]];
    const vals = [...new Set([max, Math.round(max / 4), 1].filter((v) => v >= 1))].sort((x, y) => y - x);
    const sizes = vals.map((v) => { const s = sizeFor(v, max, prefs.counts); return `<div class="gm-sz"><i style="width:${s}px;height:${s}px"></i><span>${fmtNum(v)}</span></div>`; }).join('');
    box.innerHTML = `<div class="gm-lt">${esc(t('gmap.legend'))}</div>
      <div class="gm-lc">${colors.map(([c, l]) => `<div><i class="gm-cd" style="--c:${c}"></i>${esc(l)}</div>`).join('')}</div>
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
  function paint(places, firstOf, freshFrom) {
    const max = Math.max(1, ...places.map((p) => p.count));
    const seen = new Set();
    for (const p of places) {
      seen.add(p.id);
      const size = sizeFor(p.count, max, prefs.counts);
      const fresh = (firstOf?.get(p.id) || p.first || '') >= freshFrom;
      const color = prefs.color === 'new' ? (fresh ? NEW_C : OLD_C) : (KIND[p.kind] || KIND.airport);
      let o = live.get(p.id);
      if (!o) {
        const el = document.createElement('div');
        el.className = 'gdot';
        el.innerHTML = '<div class="gdot-in"><span></span></div>';
        const m = map.marker([p.lat, p.lng], { kind: 'element', html: el.outerHTML, group: 'g', popup: ' ', popupClass: 'gpop', popupOffset: Math.round(size / 2) + 6 });
        o = { api: m, el: m.el, num: m.el.querySelector('span') };
        live.set(p.id, o);
      }
      // propriétés une à une : MapLibre garde sa position dans style.transform
      o.el.style.width = `${size}px`; o.el.style.height = `${size}px`;
      o.el.style.setProperty('--c', color); o.el.style.zIndex = String(1000 - size);
      o.el.title = `${p.name || p.airport || ''} · ${p.count}`;
      o.num.textContent = prefs.counts ? shortNum(p.count) : '';
      o.el.classList.toggle('has-n', prefs.counts);
      o.el.classList.toggle('big-n', prefs.counts && size >= 30);
      o.api.marker.getPopup().setHTML(popupHtml(p, color)).setOffset(Math.round(size / 2) + 6);
    }
    for (const [id, o] of live) if (!seen.has(id)) { o.api.remove(); live.delete(id); }
    drawLegend(max);
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
  $('[data-counts]').addEventListener('change', (e) => { prefs.counts = e.target.checked; save(); draw(); });
  $('[data-legend]').addEventListener('change', (e) => { prefs.legend = e.target.checked; save(); $('[data-leg]').hidden = !prefs.legend; if (prefs.legend) draw(); });
  $('[data-from]').value = years[0]; $('[data-to]').value = years[years.length - 1];
  window.addEventListener('hashchange', stop, { once: true });
  await draw();
}
