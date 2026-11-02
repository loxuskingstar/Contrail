// Mes vols : résumé, carte des trajets (orthodromies), liste par année
import { api } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, fmtDate, fmtDuration, fmtMonth, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, emptyState, menu, debounce } from '../ui.js';

export async function render(root, _p, query) {
  let year = query.year || '';
  let search = '';
  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.flights'))}</h1><div class="sub" data-sub>&nbsp;</div></div>
      <div class="actions"><button class="btn-icon glassy" data-more>${icon('ellipsis')}</button>
      <a class="btn primary" href="#/flights/new">${icon('plus', '', 18)} ${esc(t('flight.new'))}</a></div></header>
    <div data-kpis class="grid kpis"></div>
    <div class="card flush" style="margin:14px 0"><div class="map" style="height:400px;border-radius:0" data-map></div></div>
    <div class="row wrap" style="margin-bottom:12px">
      <div class="search grow">${icon('search', '', 18)}<input class="input" type="search" placeholder="${esc(t('flight.search'))}"></div>
      <div class="chips scroll" data-years></div>
    </div>
    <div data-list></div>`;
  const { createMap, greatCircle, dotIcon, fitTo } = await import('../lib/map.js');
  const map = createMap(root.querySelector('[data-map]'), { center: [30, 10], zoom: 2, scrollWheelZoom: false });
  let layer = window.L.layerGroup().addTo(map);

  async function load() {
    const res = await api('/api/flights', { query: { year, search } });
    const S = res.summary;
    root.querySelector('[data-sub]').textContent = t('flight.sub', { n: S.count });
    const unit = store.settings.units === 'imperial';
    const dist = unit ? `${fmtNum(Math.round(S.km * 0.539957))} nm` : `${fmtNum(S.km)} km`;
    root.querySelector('[data-kpis]').innerHTML = [
      ['ticket', fmtNum(S.count), t('stat.flights_l')], ['route', dist, t('flight.distance')],
      ['clock', S.minutes ? fmtDuration(S.minutes) : '—', t('flight.time')], ['map-pin', fmtNum(S.airports), t('stat.airports')],
      ['flag', fmtNum(S.countries), t('stat.countries')], ['globe', fmtNum(S.earth_laps, { maximumFractionDigits: 2 }), t('flight.laps')],
    ].map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('');
    const yrs = root.querySelector('[data-years]');
    if (!yrs.dataset.done) {
      yrs.dataset.done = 1;
      yrs.innerHTML = [`<button class="chip ${!year ? 'on' : ''}" data-y="">${esc(t('common.all'))}</button>`, ...S.years.map((y) => `<button class="chip ${year === y ? 'on' : ''}" data-y="${y}">${y}</button>`)].join('');
      yrs.querySelectorAll('[data-y]').forEach((b) => (b.onclick = () => { year = b.dataset.y; yrs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b)); load(); }));
    }
    // Carte
    layer.clearLayers();
    const pts = [];
    const airports = {};
    for (const f of res.items) {
      if (!f.dep_info || !f.arr_info) continue;
      const a = [f.dep_info.lat, f.dep_info.lng], b = [f.arr_info.lat, f.arr_info.lng];
      window.L.polyline(greatCircle(a, b), { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6', weight: 2.2, opacity: 0.75 })
        .bindPopup(`<b>${esc(f.dep_icao)} → ${esc(f.arr_icao)}</b><br>${fmtDate(f.date, { time: false })} · ${fmtNum(f.distance_km)} km`).addTo(layer);
      airports[f.dep_icao] = f.dep_info; airports[f.arr_icao] = f.arr_info;
      pts.push(a, b);
    }
    for (const [code, info] of Object.entries(airports)) window.L.marker([info.lat, info.lng], { icon: dotIcon('#fff', 10) }).bindTooltip(`${code} · ${info.city || info.name}`).addTo(layer);
    fitTo(map, pts, { maxZoom: 6 });
    // Liste
    const list = root.querySelector('[data-list]');
    if (!res.items.length) {
      list.innerHTML = `<div class="card">${emptyState('ticket', t('flight.empty'), t('flight.empty_text'), `<a class="btn primary" href="#/flights/new">${esc(t('flight.new'))}</a>`)}</div>`;
      return;
    }
    const byYear = {};
    for (const f of res.items) (byYear[f.date.slice(0, 4)] ||= []).push(f);
    list.innerHTML = Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0])).map(([y, fl]) => `
      <div class="section"><h2>${y}</h2><span class="muted small">${esc(t('flight.sub', { n: fl.length }))} · ${fmtNum(Math.round(fl.reduce((s, f) => s + (f.distance_km || 0), 0)))} km</span></div>
      <div class="list card" style="padding:6px">${fl.map((f) => `<a class="list-row" href="#/flights/${f.id_flight}/edit">
        <div style="width:58px;text-align:center"><div style="font-size:20px;font-weight:760" class="num">${f.date.slice(8, 10)}</div><div class="tiny muted">${esc(fmtMonth(f.date.slice(0, 7)))}</div></div>
        <div class="grow"><div class="ttl"><span class="mono">${esc(f.dep_icao)}</span>${icon('plane', '', 15)}<span class="mono">${esc(f.arr_icao)}</span>
          ${f.spotted_count ? `<span class="badge violet" title="${esc(t('flight.spotted_hint'))}">${icon('camera', '', 11)} ${f.spotted_count}</span>` : ''}</div>
          <div class="meta ellipsis">${flag(f.dep_info?.country)} ${esc(f.dep_info?.city || '')} → ${flag(f.arr_info?.country)} ${esc(f.arr_info?.city || '')}</div>
          <div class="meta ellipsis">${esc([f.flight_number, f.airline, f.aircraft, f.registration].filter(Boolean).join(' · '))}</div></div>
        <div class="hide-sm" style="text-align:right"><b class="num">${fmtNum(f.distance_km)} km</b><div class="small muted">${fmtDuration(f.duration_min)}</div></div></a>`).join('')}</div>`).join('');
  }
  root.querySelector('input[type=search]').addEventListener('input', debounce((e) => { search = e.target.value.trim(); load(); }, 300));
  root.querySelector('[data-more]').onclick = (e) => menu(e.currentTarget, [
    { icon: 'chart-column', label: t('flight.stats'), onClick: () => (location.hash = '#/stats?tab=flights') },
    { icon: 'share-2', label: t('share.my_flights'), onClick: async () => (await import('./shares.js')).createShareFlow({ kind: 'flights' }) },
    { icon: 'upload', label: t('flight.import'), onClick: () => (location.hash = '#/settings/data') },
    { icon: 'download', label: t('settings.export_csv'), onClick: () => (location.href = '/api/export/flights.csv') },
  ]);
  await load();
  return () => map.remove();
}
