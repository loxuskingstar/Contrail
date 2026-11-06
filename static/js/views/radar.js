// Radar en direct (OpenSky Network) centré sur la position de l'utilisateur
import { api } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast } from '../ui.js';
import { mediaUrl } from '../api.js';
import { CLASSES, aircraftImage, aircraftDataUrl, loadTypes, typeName } from '../lib/shapes.js';
import { planespottersPhoto, photoBlock } from '../lib/photos.js';

const REFRESH_MS = 12000;

export async function render(root) {
  const { createMap } = await import('../lib/map.js');
  loadTypes();
  root.innerHTML = `
    <h1 class="sr">${esc(t('nav.radar'))}</h1>
    <div class="map full" data-map></div>
    <div class="radar-ui">
      <div class="status glass" data-status>${icon('radar', '', 16)} ${esc(t('radar.loading'))}</div>
      <span class="grow"></span>
      <button class="btn-icon glassy" data-locate title="${esc(t('radar.locate'))}">${icon('locate-fixed')}</button>
      <button class="btn-icon glassy" data-legend title="${esc(t('radar.legend'))}">${icon('info')}</button>
    </div>`;
  document.body.classList.add('radar-mode');
  const home = store.settings.radar_center;
  const homeAp = (store.settings.home_airports || [])[0];
  const cm = await createMap(root.querySelector('[data-map]'), { center: home || [43.63, 1.37], zoom: 8.5, controls: 'bottom-right' });
  const map = cm.map;
  const states = new Map();
  let timer = null, aborter = null, me = null, stopped = false;

  // Avions : couche symbole GeoJSON ; une silhouette par classe d'appareil et par état,
  // générée à la demande et pivotée selon le cap par le GPU (fluide même avec des centaines d'appareils).
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
  const COLORS = { air: accent, ground: '#94a3b8', watch: '#dc2626', spotted: '#16a34a', mil: '#a16207' };
  const addIcon = (id) => {
    const m = /^ac-(\w+)-(\w+)$/.exec(id);
    if (!m || map.hasImage(id)) return;
    map.addImage(id, aircraftImage(CLASSES.includes(m[1]) ? m[1] : 'unknown', COLORS[m[2]] || accent, 72), { pixelRatio: 2 });
  };
  map.on('styleimagemissing', (e) => addIcon(e.id));
  for (const st of Object.keys(COLORS)) addIcon(`ac-narrow-${st}`);
  map.addSource('planes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'planes', type: 'symbol', source: 'planes',
    layout: {
      'icon-image': ['concat', 'ac-', ['get', 'cls'], '-', ['get', 'state']], 'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['case', ['get', 'watch'], 1.2, 1],
      'symbol-sort-key': ['case', ['get', 'watch'], 3, ['get', 'spotted'], 2, ['get', 'ground'], 0, 1],
    },
  });
  map.on('click', 'planes', (e) => { const s = states.get(e.features[0].properties.icao24); if (s) detail(s); });
  map.on('mouseenter', 'planes', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'planes', () => (map.getCanvas().style.cursor = ''));

  if (!home && homeAp) api(`/api/airports/${homeAp}`).then((a) => cm.setView([a.lat, a.lng], 8.5)).catch(() => {});
  const locate = (fly = true) => navigator.geolocation?.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    me?.remove();
    me = cm.marker(ll, { kind: 'dot', size: 16, color: '#0ea5e9', group: 'me' });
    if (fly) cm.setView(ll, 9.5);
  }, () => fly && toast(esc(t('radar.no_geo')), { type: 'warn' }), { enableHighAccuracy: true, timeout: 8000 });
  if (!home && !homeAp) locate(true);

  const stateOf = (s) => (s.watch || s.wish ? 'watch' : s.spotted ? 'spotted' : s.on_ground ? 'ground' : s.military ? 'mil' : 'air');

  async function refresh() {
    if (stopped || document.hidden) return;
    const b = cm.bounds();
    const status = root.querySelector('[data-status]');
    const area = (b.north - b.south) * (b.east - b.west);
    if (area > 600) {
      status.innerHTML = `${icon('search', '', 16)} ${esc(t('radar.zoom_in'))}`;
      map.getSource('planes')?.setData({ type: 'FeatureCollection', features: [] });
      states.clear();
      return;
    }
    aborter?.abort();
    aborter = new AbortController();
    try {
      const res = await api('/api/radar', { query: { lamin: b.south.toFixed(3), lomin: b.west.toFixed(3), lamax: b.north.toFixed(3), lomax: b.east.toFixed(3) }, signal: aborter.signal });
      states.clear();
      const features = res.states.map((s) => {
        states.set(s.icao24, s);
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: { icao24: s.icao24, track: s.track || 0, cls: s.cls || 'unknown', state: stateOf(s),
            watch: !!(s.watch || s.wish), spotted: !!s.spotted, ground: !!s.on_ground } };
      });
      map.getSource('planes')?.setData({ type: 'FeatureCollection', features });
      if (res.error === 'rate_limited') status.innerHTML = `${icon('triangle-alert', '', 16)} ${esc(t('radar.rate_limited'))}`;
      else status.innerHTML = `${icon('radar', '', 16)} ${esc(t('radar.count', { n: res.states.length }))}${res.partial ? ` <span class="muted">· ${esc(t('radar.partial'))}</span>` : ''}${res.source && res.source !== 'opensky' ? ` <span class="muted" title="${esc(t('radar.source_fallback', { src: res.source }))}">· ${esc(res.source)}</span>` : ''} · <span class="muted">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (e.status === 422) {
        status.innerHTML = `${icon('search', '', 16)} ${esc(t('radar.zoom_in'))}`;
        map.getSource('planes')?.setData({ type: 'FeatureCollection', features: [] });
        states.clear();
        return;
      }
      status.innerHTML = `${icon('wifi-off', '', 16)} ${esc(e.offline ? t('err.offline') : t('radar.error'))}`;
    }
  }

  async function detail(s) {
    const sh = sheet({ title: `<span class="mono">${esc(s.callsign || s.icao24.toUpperCase())}</span>`, body: `<div class="skeleton" style="height:220px"></div>` });
    const info = await api(`/api/lookup/hex/${s.icao24}`, { query: { callsign: s.callsign || '' } }).catch(() => ({}));
    await loadTypes();
    const reg = info.registration || s.registration;
    const code = info.aircraft_icao || s.type;
    const cls = s.cls && s.cls !== 'unknown' ? s.cls : (info.cls || 'unknown');
    const model = info.aircraft || typeName(code) || s.desc;
    const alt = s.alt_m != null ? (store.settings.units === 'imperial' ? `${fmtNum(Math.round(s.alt_m * 3.28084))} ft` : `${fmtNum(Math.round(s.alt_m * 3.28084 / 100) * 100)} ft · ${fmtNum(Math.round(s.alt_m))} m`) : '—';
    const spd = s.velocity != null ? `${fmtNum(Math.round(s.velocity * 1.94384))} kt` : '—';
    const tag = s.watch || s.wish ? `<span class="badge rose">${icon('star', '', 12)} ${esc(s.wish && !s.watch ? `${t('nav.watchlist')} · ${s.wish.title}` : t('nav.watchlist'))}</span>` : '';
    sh.body.innerHTML = `
      <div data-photo class="ac-photo"><img class="ac-sil" src="${aircraftDataUrl(cls, getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(), 120)}" alt=""></div>
      <div class="row" style="margin:14px 0">
        <img src="${aircraftDataUrl(cls, accent, 44)}" width="44" height="44" alt="" title="${esc(t(`cls.${cls}`))}">
        <div class="grow">
          <div style="font-size:22px;font-weight:750" class="mono">${esc(reg || '—')}</div>
          <div class="muted">${esc([model, info.owner].filter(Boolean).join(' · ') || t('radar.unknown'))}</div>
          <div class="tiny muted">${esc(t(`cls.${cls}`))}${code ? ` · ${esc(code)}` : ''}</div></div>
        <div class="stack" style="gap:4px;align-items:flex-end">${tag}${info.spotted ? `<span class="badge green">${icon('camera', '', 12)} ${info.spotted}×</span>` : ''}</div></div>
      <div class="wx-grid">
        <div><b>${esc(alt)}</b><small>${esc(t('radar.altitude'))}</small></div>
        <div><b>${esc(spd)}</b><small>${esc(t('radar.speed'))}</small></div>
        <div><b>${s.track != null ? Math.round(s.track) + '°' : '—'}</b><small>${esc(t('radar.heading'))}</small></div>
        <div><b>${s.vertical_rate != null ? `${s.vertical_rate > 0 ? '+' : ''}${fmtNum(Math.round(s.vertical_rate * 196.85))}` : '—'}</b><small>ft/min</small></div>
        <div><b class="mono">${esc(s.squawk || '—')}</b><small>Squawk</small></div>
        <div><b class="mono">${esc(s.icao24.toUpperCase())}</b><small>Mode-S</small></div>
      </div>
      ${info.route ? `<p style="margin:10px 0"><b>${icon('route', '', 15)} ${esc(t('radar.route'))}</b> <span class="mono">${esc(info.route)}</span></p>` : ''}
      <p class="tiny muted">${esc(s.origin_country || '')}</p>
      <div class="row wrap" style="margin-top:14px">
        <a class="btn primary" href="#/spots/new?reg=${encodeURIComponent(reg || '')}&icao24=${s.icao24}" data-close>${icon('camera', '', 18)} ${esc(t('radar.spot_it'))}</a>
        ${reg ? `<a class="btn" href="#/airframe/${encodeURIComponent(reg)}" data-close>${icon('history', '', 18)} ${esc(t('nav.airframe'))}</a>` : ''}
        ${reg && store.mod('watchlist') && !s.watch && !(s.wish && s.wish.kind === 'aircraft') ? `<button class="btn" data-watch>${icon('eye', '', 18)} ${esc(t('watch.add'))}</button>` : ''}
      </div>`;
    sh.body.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => sh.close()));
    sh.body.querySelector('[data-watch]')?.addEventListener('click', async () => {
      try { await api('/api/watchlist', { method: 'POST', body: { registration: reg } }); toast(esc(t('watch.added')), { type: 'success' }); sh.close(); }
      catch (e) { errorToast(e); }
    });
    // Photo : la vôtre si l'appareil a déjà été spotté, sinon la plus récente de Planespotters.net
    const box = sh.body.querySelector('[data-photo]');
    if (info.own_photo) {
      box.innerHTML = `<a href="#/spots/${info.own_photo.id_spotting}" data-close-photo><img src="${mediaUrl('images', info.own_photo.image)}" alt="${esc(reg || '')}"></a>
        <div class="ac-credit">${icon('camera', '', 12)} ${esc(t('radar.your_photo'))}</div>`;
      box.querySelector('[data-close-photo]').addEventListener('click', () => sh.close());
    } else {
      const ph = await planespottersPhoto({ hex: s.icao24, reg });
      if (ph && box.isConnected) box.innerHTML = photoBlock(ph);
      else if (box.isConnected) box.insertAdjacentHTML('beforeend', `<div class="ac-credit">${esc(t('radar.no_photo'))}</div>`);
    }
  }

  const schedule = () => { clearInterval(timer); timer = setInterval(refresh, REFRESH_MS); };
  cm.onMoveEnd(() => { refresh(); schedule(); });
  root.querySelector('[data-locate]').onclick = () => locate(true);
  root.querySelector('[data-legend]').onclick = () => sheet({ title: esc(t('radar.legend')), body: `<div class="stack">
    <div class="legend-grid">${[['watch', 'radar.l_watch'], ['spotted', 'radar.l_spotted'], ['air', 'radar.l_air'], ['mil', 'radar.l_mil'], ['ground', 'radar.l_ground']]
      .map(([k, l]) => `<div class="row"><span class="legend-dot" style="background:${COLORS[k]};width:12px;height:12px"></span>${esc(t(l))}</div>`).join('')}</div>
    <div class="card-title" style="margin:6px 0 0">${esc(t('radar.shapes'))}</div>
    <div class="legend-grid">${CLASSES.filter((c) => c !== 'unknown').map((c) => `<div class="row"><img src="${aircraftDataUrl(c, accent, 30)}" width="30" height="30" alt="">${esc(t(`cls.${c}`))}</div>`).join('')}</div>
    <p class="small muted">${esc(t('radar.shapes_hint'))}</p>
    <p class="small muted">${esc(t('radar.about'))}</p></div>` });
  const vis = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', vis);
  refresh();
  schedule();
  return () => { stopped = true; clearInterval(timer); aborter?.abort(); cm.remove(); document.body.classList.remove('radar-mode'); document.removeEventListener('visibilitychange', vis); };
}
