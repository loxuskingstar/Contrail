// Carte globale : tous les lieux où tu as spotté, avec une période réglable et une lecture animée année par année
import { api } from '../api.js';
import { t, fmtNum, fmtDate, flag, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast } from '../ui.js';

export async function render(root) {
  let facets;
  try { facets = await api('/api/spots/facets'); } catch (e) { errorToast(e); return; }
  const years = (facets.years || []).slice().sort();
  if (!years.length) { root.innerHTML = pageHead(esc(t('gmap.title'))) + `<div class="card">${emptyState('map', t('map.empty'), '')}</div>`; return; }
  const opts = (sel) => years.map((y) => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
  root.innerHTML = `${pageHead(esc(t('gmap.title')), { sub: `<span data-sub>&nbsp;</span>` })}
    <div class="card row wrap" style="gap:10px;align-items:center;margin-bottom:12px">
      <label class="row small" style="gap:6px">${esc(t('gmap.from'))}<select class="input" data-from style="width:auto">${opts(years[0])}</select></label>
      <label class="row small" style="gap:6px">${esc(t('gmap.to'))}<select class="input" data-to style="width:auto">${opts(years[years.length - 1])}</select></label>
      <button class="btn sm" data-play>${icon('play', '', 14)} ${esc(t('gmap.play'))}</button>
      <label class="row small" style="gap:6px;margin-left:auto">${esc(t('gmap.color'))}
        <select class="input" data-color style="width:auto"><option value="kind">${esc(t('gmap.c_kind'))}</option><option value="new">${esc(t('gmap.c_new'))}</option></select></label>
    </div>
    <div class="grid kpis" style="margin-bottom:12px" data-kpis></div>
    <div class="map" data-map style="height:calc(100dvh - 330px);min-height:420px"></div>`;
  const { createMap } = await import('../lib/map.js');
  const map = await createMap(root.querySelector('[data-map]'));
  const $ = (s) => root.querySelector(s);
  const KIND = { airport: '#2563eb', location: '#16a34a', gps: '#f59e0b' };
  let fitted = false, seq = 0;

  async function draw() {
    let a = $('[data-from]').value, b = $('[data-to]').value;
    if (a > b) { [a, b] = [b, a]; }
    const mine = ++seq;
    let res;
    try { res = await api('/api/spots/map', { query: { date_from: `${a}-01-01`, date_to: `${b}-12-31` } }); } catch (e) { errorToast(e); return; }
    if (mine !== seq) return;                       // une requête plus récente est partie entre-temps
    const places = res.places;
    const max = Math.max(1, ...places.map((p) => p.count));
    const colorMode = $('[data-color]').value;
    map.clear('g');
    for (const p of places) {
      const size = Math.round(10 + 30 * Math.sqrt(p.count / max));
      const fresh = p.first && p.first.slice(0, 4) >= a && colorMode === 'new' ? p.first.slice(0, 4) === b : false;
      const color = colorMode === 'new' ? (fresh ? '#ef4444' : '#64748b') : (KIND[p.kind] || '#2563eb');
      const name = p.name || p.airport || '—';
      const href = p.location_id ? `#/spots?location_id=${p.location_id}` : (p.airport ? `#/spots?airport=${encodeURIComponent(p.airport)}` : '#/spots');
      const range = `${esc(fmtDate(p.first, { time: false }))} → ${esc(fmtDate(p.last, { time: false }))}`;
      map.marker([p.lat, p.lng], {
        kind: 'dot', size, color: `${color}cc`, group: 'g', title: `${name} · ${p.count}`,
        popup: `<b>${esc(name)}</b><div class="small muted">${p.country ? flag(p.country) + ' ' + esc(countryName(p.country)) + ' · ' : ''}${esc(t('spots.count', { n: p.count, nf: fmtNum(p.count) }))}</div>
          <div class="small muted">${t('gmap.regs', { n: p.regs })} · ${range}</div><a href="${href}">${esc(t('gmap.open'))} →</a>`,
      });
    }
    const countries = new Set(places.map((p) => p.country).filter(Boolean));
    $('[data-kpis]').innerHTML = [['map-pin', places.length, t('gmap.k_places')], ['camera', res.total, t('outing.k_spots')], ['globe', countries.size, t('gmap.k_countries')]]
      .map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div></div>`).join('');
    $('[data-sub]').textContent = a === b ? a : `${a} – ${b}`;
    if (!fitted && places.length) { map.fit(places.map((p) => [p.lat, p.lng]), { maxZoom: 8 }); fitted = true; }
  }

  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; $('[data-play]').innerHTML = `${icon('play', '', 14)} ${esc(t('gmap.play'))}`; };
  $('[data-play]').onclick = () => {
    if (timer) { stop(); return; }
    $('[data-play]').innerHTML = `${icon('pause', '', 14)} ${esc(t('gmap.pause'))}`;
    $('[data-from]').value = years[0]; $('[data-to]').value = years[0]; draw();
    timer = setInterval(() => {
      const i = years.indexOf($('[data-to]').value);
      if (i >= years.length - 1 || !root.isConnected) { stop(); return; }
      $('[data-to]').value = years[i + 1]; draw();
    }, 1400);
  };
  ['[data-from]', '[data-to]', '[data-color]'].forEach((s) => $(s).addEventListener('change', () => { stop(); draw(); }));
  $('[data-from]').value = years[0]; $('[data-to]').value = years[years.length - 1];
  window.addEventListener('hashchange', stop, { once: true });
  await draw();
}
