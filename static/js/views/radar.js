// Radar en direct (OpenSky Network) centré sur la position de l'utilisateur
import { api } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast } from '../ui.js';

const REFRESH_MS = 12000;

export async function render(root) {
  const { createMap, planeIcon, dotIcon } = await import('../lib/map.js');
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
  const map = createMap(root.querySelector('[data-map]'), { center: home || [43.63, 1.37], zoom: 9 });
  map.zoomControl.setPosition('bottomright');
  const layer = window.L.layerGroup().addTo(map);
  const markers = new Map();
  let timer = null, aborter = null, me = null, stopped = false;

  if (!home && homeAp) api(`/api/airports/${homeAp}`).then((a) => map.setView([a.lat, a.lng], 9)).catch(() => {});
  const locate = (fly = true) => navigator.geolocation?.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    me?.remove();
    me = window.L.marker(ll, { icon: dotIcon('#0ea5e9', 16), zIndexOffset: 1000 }).addTo(map);
    if (fly) map.setView(ll, 10);
  }, () => fly && toast(esc(t('radar.no_geo')), { type: 'warn' }), { enableHighAccuracy: true, timeout: 8000 });
  if (!home && !homeAp) locate(true);

  const color = (s) => (s.watch ? '#ef4444' : s.spotted ? '#16a34a' : s.on_ground ? '#94a3b8' : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6');

  async function refresh() {
    if (stopped || document.hidden) return;
    const b = map.getBounds();
    const status = root.querySelector('[data-status]');
    const area = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
    if (area > 100) { status.innerHTML = `${icon('search', '', 16)} ${esc(t('radar.zoom_in'))}`; layer.clearLayers(); markers.clear(); return; }
    aborter?.abort();
    aborter = new AbortController();
    try {
      const res = await api('/api/radar', { query: { lamin: b.getSouth().toFixed(3), lomin: b.getWest().toFixed(3), lamax: b.getNorth().toFixed(3), lomax: b.getEast().toFixed(3) }, signal: aborter.signal });
      const seen = new Set();
      for (const s of res.states) {
        seen.add(s.icao24);
        let m = markers.get(s.icao24);
        const ic = planeIcon(s.track, color(s), s.watch ? 34 : 26);
        if (!m) {
          m = window.L.marker([s.lat, s.lng], { icon: ic, zIndexOffset: s.watch ? 800 : 0 }).addTo(layer);
          m.on('click', () => detail(m.state));
          markers.set(s.icao24, m);
        } else {
          m.setLatLng([s.lat, s.lng]);
          m.setIcon(ic);
        }
        m.state = s;
        m.bindTooltip(`${s.callsign || s.icao24}${s.registration ? ' · ' + s.registration : ''}`, { direction: 'top', offset: [0, -12] });
      }
      for (const [k, m] of markers) if (!seen.has(k)) { layer.removeLayer(m); markers.delete(k); }
      if (res.error === 'rate_limited') status.innerHTML = `${icon('triangle-alert', '', 16)} ${esc(t('radar.rate_limited'))}`;
      else status.innerHTML = `${icon('radar', '', 16)} ${esc(t('radar.count', { n: res.states.length }))} · <span class="muted">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      status.innerHTML = `${icon('wifi-off', '', 16)} ${esc(e.offline ? t('err.offline') : t('radar.error'))}`;
    }
  }

  async function detail(s) {
    const sh = sheet({ title: `<span class="mono">${esc(s.callsign || s.icao24.toUpperCase())}</span>`, body: `<div class="skeleton" style="height:120px"></div>` });
    const info = await api(`/api/lookup/hex/${s.icao24}`, { query: { callsign: s.callsign || '' } }).catch(() => ({}));
    const reg = info.registration || s.registration;
    const alt = s.alt_m != null ? (store.settings.units === 'imperial' ? `${fmtNum(Math.round(s.alt_m * 3.28084))} ft` : `${fmtNum(Math.round(s.alt_m * 3.28084 / 100) * 100)} ft · ${fmtNum(Math.round(s.alt_m))} m`) : '—';
    const spd = s.velocity != null ? `${fmtNum(Math.round(s.velocity * 1.94384))} kt` : '—';
    sh.body.innerHTML = `
      <div class="row" style="margin-bottom:14px">${icon('plane', '', 30)}<div class="grow">
        <div style="font-size:22px;font-weight:760" class="mono">${esc(reg || '—')}</div>
        <div class="muted">${esc([info.aircraft || info.aircraft_icao, info.owner].filter(Boolean).join(' · ') || t('radar.unknown'))}</div></div>
        ${s.watch ? `<span class="badge rose">${icon('eye', '', 12)} ${esc(t('nav.watchlist'))}</span>` : ''}${info.spotted ? `<span class="badge green">${icon('camera', '', 12)} ${info.spotted}×</span>` : ''}</div>
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
        ${reg && store.mod('watchlist') && !s.watch ? `<button class="btn" data-watch>${icon('eye', '', 18)} ${esc(t('watch.add'))}</button>` : ''}
      </div>`;
    sh.body.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => sh.close()));
    sh.body.querySelector('[data-watch]')?.addEventListener('click', async () => {
      try { await api('/api/watchlist', { method: 'POST', body: { registration: reg } }); toast(esc(t('watch.added')), { type: 'success' }); sh.close(); }
      catch (e) { errorToast(e); }
    });
  }

  const schedule = () => { clearInterval(timer); timer = setInterval(refresh, REFRESH_MS); };
  map.on('moveend', () => { refresh(); schedule(); });
  root.querySelector('[data-locate]').onclick = () => locate(true);
  root.querySelector('[data-legend]').onclick = () => sheet({ title: esc(t('radar.legend')), body: `<div class="stack">
    ${[['#ef4444', t('radar.l_watch')], ['#16a34a', t('radar.l_spotted')], ['var(--accent)', t('radar.l_air')], ['#94a3b8', t('radar.l_ground')]]
      .map(([c, l]) => `<div class="row"><span class="legend-dot" style="background:${c};width:14px;height:14px"></span>${esc(l)}</div>`).join('')}
    <p class="small muted">${esc(t('radar.about'))}</p></div>` });
  const vis = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', vis);
  refresh();
  schedule();
  return () => { stopped = true; clearInterval(timer); aborter?.abort(); map.remove(); document.body.classList.remove('radar-mode'); document.removeEventListener('visibilitychange', vis); };
}
