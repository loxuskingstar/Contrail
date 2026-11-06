// Répertoire des points de vue : carte, direction de visée, recommandations d'éclairage (course du soleil)
import { api } from '../api.js';
import { t, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput } from '../lib/fields.js';
import { esc, sheet, toast, errorToast, confirmDialog, emptyState, pageHead } from '../ui.js';

export async function render(root) {
  const { createMap, conePolygon } = await import('../lib/map.js');
  let locs = await api('/api/locations');
  root.innerHTML = `
    ${pageHead(esc(t('nav.locations')), { sub: esc(t('loc.sub')), actions: `<button class="btn primary" data-new>${icon('plus', '', 18)} ${esc(t('loc.new'))}</button>` })}
    <div class="card flush" style="margin-bottom:14px"><div class="map" style="height:380px;border-radius:0" data-map></div></div>
    <div data-list></div>`;
  const mapReady = createMap(root.querySelector('[data-map]')).catch(() => null);
  let lastCenter = null;
  mapReady.then((m) => m?.onMoveEnd(() => (lastCenter = m.center())));

  const draw = () => {
    mapReady.then((m) => {
      if (!m) return;
      m.clear();
      m.polygons('cones', locs.filter((l) => l.view_bearing != null).map((l) => conePolygon(l.lat, l.lng, l.view_bearing)));
      for (const l of locs) m.marker([l.lat, l.lng], { label: '', title: l.name, onClick: () => detail(l) });
      m.fit(locs.map((l) => [l.lat, l.lng]), { maxZoom: 13 });
    });
    root.querySelector('[data-list]').innerHTML = locs.length ? `<div class="grid two">${locs.map((l) => {
      const w = l.today?.windows || [];
      return `<div class="card" data-id="${l.id_location}" style="cursor:pointer">
        <div class="row between"><div><b style="font-size:16.5px">${esc(l.name)}</b><div class="small muted">${esc([l.airport, l.runways && `${t('loc.runways')} ${l.runways}`].filter(Boolean).join(' · '))}</div></div>
          ${l.view_bearing != null ? `<span class="badge accent">${icon('navigation', '', 12)} ${Math.round(l.view_bearing)}°</span>` : ''}</div>
        <div class="row small" style="margin-top:12px;gap:14px;flex-wrap:wrap">
          <span>${icon('sunrise', '', 15)} ${esc(l.today?.sunrise || '—')}</span><span>${icon('sunset', '', 15)} ${esc(l.today?.sunset || '—')}</span>
          <span class="muted">${esc(t('loc.spots_here', { n: l.spots }))}</span></div>
        <div style="margin-top:10px">${l.view_bearing == null ? `<span class="small muted">${esc(t('loc.no_bearing'))}</span>`
          : w.length ? `<div class="small"><b>${esc(t('loc.best_today'))}</b> ${w.map((x) => `<span class="badge gold">${icon('sun', '', 11)} ${x.start}–${x.end}</span>`).join(' ')}</div>`
          : `<span class="small muted">${esc(t('loc.no_window_today'))}</span>`}</div></div>`;
    }).join('')}</div>` : `<div class="card">${emptyState('binoculars', t('loc.empty'), t('loc.empty_text'))}</div>`;
    root.querySelectorAll('[data-list] [data-id]').forEach((c) => (c.onclick = () => detail(locs.find((l) => l.id_location === Number(c.dataset.id)))));
  };

  const reload = async () => { locs = await api('/api/locations'); draw(); };
  root.querySelector('[data-new]').onclick = () => editLocation(null, lastCenter, reload);

  async function detail(l) {
    const s = sheet({ title: esc(l.name), wide: true, body: `<div class="row wrap" style="margin-bottom:12px">
        <input type="date" class="input" style="width:auto" data-date value="${new Date().toISOString().slice(0, 10)}">
        <a class="btn sm" href="#/spots?location_id=${l.id_location}" data-close>${icon('camera', '', 16)} ${esc(t('loc.spots_here', { n: l.spots }))}</a>
        <a class="btn sm" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}">${icon('external-link', '', 16)} OSM</a>
        <span class="grow"></span>
        <button class="btn sm" data-edit>${icon('pencil', '', 16)} ${esc(t('common.edit'))}</button>
        <button class="btn sm danger" data-del>${icon('trash-2', '', 16)}</button></div>
      <div data-sun><div class="skeleton" style="height:220px"></div></div>
      ${l.access || l.notes ? `<div class="card" style="margin-top:12px">${l.access ? `<p><b>${esc(t('loc.access'))}</b> ${esc(l.access)}</p>` : ''}${l.notes ? `<p style="white-space:pre-wrap;margin-top:6px">${esc(l.notes)}</p>` : ''}</div>` : ''}
      ${l.best_time ? `<p class="tiny muted" style="margin-top:12px">${esc(t('loc.seasonal'))} ${esc(l.best_time)}</p>` : ''}` });
    const loadSun = async () => {
      const d = await api('/api/sun', { query: { lat: l.lat, lng: l.lng, bearing: l.view_bearing ?? '', date: s.body.querySelector('[data-date]').value, airport: l.airport || '' } });
      s.body.querySelector('[data-sun]').innerHTML = sunChart(d, l.view_bearing);
    };
    s.body.querySelector('[data-date]').onchange = loadSun;
    s.body.querySelector('[data-edit]').onclick = () => { s.close(); editLocation(l, null, reload); };
    s.body.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmDialog(esc(t('loc.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
      await api(`/api/locations/${l.id_location}`, { method: 'DELETE' });
      s.close(); reload();
    };
    loadSun().catch(errorToast);
  }

  draw();
  return () => mapReady.then((m) => m?.remove());
}

/** Courbe d'élévation du soleil sur la journée, créneaux favorables surlignés. */
export function sunChart(d, bearing) {
  const W = 640, H = 200, P = 26;
  const xs = (i) => P + (i / (d.samples.length - 1)) * (W - P * 2);
  const maxEl = Math.max(30, ...d.samples.map((s) => s.el));
  const ys = (el) => H - P - ((Math.max(-12, el) + 12) / (maxEl + 12)) * (H - P * 2);
  const idx = (hhmm) => d.samples.findIndex((s) => s.t === hhmm);
  const bands = (d.windows || []).map((w) => {
    const a = idx(w.start), b = idx(w.end);
    return `<rect x="${xs(a)}" y="${P / 2}" width="${Math.max(2, xs(b) - xs(a))}" height="${H - P * 1.5}" fill="#f59e0b" opacity=".16" rx="6"/>`;
  }).join('');
  const golden = (d.golden || []).map((w) => {
    const a = idx(w.start), b = idx(w.end);
    return `<rect x="${xs(a)}" y="${H - P - 6}" width="${Math.max(2, xs(b) - xs(a))}" height="6" fill="#fb923c" rx="3"/>`;
  }).join('');
  const path = d.samples.map((s, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(s.el).toFixed(1)}`).join(' ');
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => {
    const i = Math.min(d.samples.length - 1, Math.round((h * 60) / ((24 * 60) / d.samples.length)));
    return `<text x="${xs(i)}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, '0')}h</text>`;
  }).join('');
  return `<svg class="vchart" viewBox="0 0 ${W} ${H}">
      ${bands}<line class="grid-line" x1="${P}" x2="${W - P}" y1="${ys(0)}" y2="${ys(0)}" stroke-dasharray="4 4"/>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>${golden}${hours}
      <text x="${W - P}" y="${ys(0) - 4}" text-anchor="end">0°</text></svg>
    <div class="row wrap small" style="gap:14px;margin-top:6px">
      <span>${icon('sunrise', '', 15)} ${esc(d.sunrise || '—')}</span><span>${icon('sunset', '', 15)} ${esc(d.sunset || '—')}</span>
      <span><span class="legend-dot" style="background:#f59e0b"></span> ${esc(t('loc.sun_behind'))}</span>
      <span><span class="legend-dot" style="background:#fb923c"></span> ${esc(t('loc.golden'))}</span>
      ${d.now ? `<span class="muted">${esc(t('loc.sun_now', { az: Math.round(d.now.az), el: fmtNum(d.now.el, { maximumFractionDigits: 0 }) }))}</span>` : ''}</div>
    ${bearing == null ? `<p class="small muted" style="margin-top:8px">${esc(t('loc.no_bearing'))}</p>`
      : d.windows.length ? `<p style="margin-top:10px"><b>${esc(t('loc.recommended'))}</b> ${d.windows.map((w) => `<span class="badge gold">${w.start}–${w.end}${w.best ? ` (${esc(t('loc.optimal'))} ${w.best})` : ''}</span>`).join(' ')}</p>`
      : `<p class="small muted" style="margin-top:8px">${esc(t('loc.no_window'))}</p>`}`;
}

export function editLocation(l, center, onSaved) {
  const v = l || { name: '', lat: center?.lat ?? 46.6, lng: center?.lng ?? 2.4, view_bearing: null };
  let pick = null;
  const s = sheet({ onClose: () => pick?.then((m) => m?.remove()), title: esc(l ? t('loc.edit') : t('loc.new')), wide: true, body: `
    <form class="stack">
      <div class="map" style="height:280px" data-pick></div>
      <p class="tiny muted">${esc(t('loc.pick_hint'))}</p>
      <div class="field-row">
        <label class="field"><span>${esc(t('loc.name'))}</span><input name="name" value="${esc(v.name)}" required placeholder="${esc(t('loc.name_ph'))}"></label>
        <label class="field"><span>${esc(t('spot.airport'))}</span><div class="input-wrap"><input name="airport" value="${esc(v.airport)}" autocomplete="off"></div></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Latitude</span><input name="lat" value="${v.lat}" inputmode="decimal" required></label>
        <label class="field"><span>Longitude</span><input name="lng" value="${v.lng}" inputmode="decimal" required></label>
        <label class="field"><span>${esc(t('loc.runways'))}</span><input name="runways" value="${esc(v.runways)}" placeholder="00L/18R"></label>
      </div>
      <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap">
        <div class="compass" data-compass><span class="lbl" style="top:4px;left:50%;transform:translateX(-50%)">N</span><span class="lbl" style="right:6px;top:50%;transform:translateY(-50%)">E</span><span class="lbl" style="bottom:4px;left:50%;transform:translateX(-50%)">S</span><span class="lbl" style="left:6px;top:50%;transform:translateY(-50%)">W</span><div class="cone"></div></div>
        <div class="grow stack" style="gap:8px">
          <label class="toggle-row" style="padding:0;border:0"><span class="t">${esc(t('loc.bearing'))}</span><span class="switch"><input type="checkbox" data-hasb ${v.view_bearing != null ? 'checked' : ''}><span></span></span></label>
          <input type="range" min="0" max="359" step="1" name="view_bearing" value="${v.view_bearing ?? 0}" ${v.view_bearing == null ? 'disabled' : ''}>
          <div class="small muted" data-bval></div>
        </div>
      </div>
      <label class="field"><span>${esc(t('loc.access'))}</span><input name="access" value="${esc(v.access)}" placeholder="${esc(t('loc.access_ph'))}"></label>
      <label class="field"><span>${esc(t('spot.description'))}</span><textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('common.save'))}</button></div>
    </form>` });
  const form = s.body.querySelector('form');
  const F = (n) => form.elements[n];
  s.body.querySelector('[data-close]').onclick = s.close;
  airportInput(F('airport'));
  pick = import('../lib/map.js').then(async ({ createMap, conePolygon }) => {
    const map = await createMap(s.body.querySelector('[data-pick]'), { center: [v.lat, v.lng], zoom: l ? 15 : 5 });
    const setPos = ({ lat, lng }) => { F('lat').value = lat.toFixed(6); F('lng').value = lng.toFixed(6); refresh(); };
    const marker = map.marker([v.lat, v.lng], { label: '', draggable: true, onDragEnd: setPos });
    const refresh = () => {
      const lat = Number(F('lat').value), lng = Number(F('lng').value);
      const has = s.body.querySelector('[data-hasb]').checked;
      const b = Number(F('view_bearing').value);
      F('view_bearing').disabled = !has;
      s.body.querySelector('[data-bval]').textContent = has ? t('loc.bearing_val', { b, sun: (b + 180) % 360 }) : t('loc.no_bearing');
      s.body.querySelector('.compass .cone').style.background = has ? `conic-gradient(from ${b - 35}deg, rgb(var(--accent-rgb)/.45) 0 70deg, transparent 70deg)` : 'none';
      marker.setLatLng([lat, lng]);
      map.polygons('cone', has && !Number.isNaN(lat) ? [conePolygon(lat, lng, b, { radius: 400 })] : []);
    };
    map.onClick(setPos);
    ['change'].forEach((ev) => { F('lat').addEventListener(ev, refresh); F('lng').addEventListener(ev, refresh); });
    ['input', 'change'].forEach((ev) => { F('view_bearing').addEventListener(ev, refresh); s.body.querySelector('[data-hasb]').addEventListener(ev, refresh); });
    if (!l && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => {
      map.setView([p.coords.latitude, p.coords.longitude], 15);
      setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
    }, () => {}, { timeout: 6000 });
    refresh();
    return map;
  }).catch(() => null);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: F('name').value.trim(), lat: Number(F('lat').value), lng: Number(F('lng').value), airport: F('airport').value.trim() || null,
      runways: F('runways').value.trim() || null, access: F('access').value.trim() || null, notes: F('notes').value.trim() || null,
      view_bearing: s.body.querySelector('[data-hasb]').checked ? Number(F('view_bearing').value) : null };
    try {
      await api(l ? `/api/locations/${l.id_location}` : '/api/locations', { method: l ? 'PUT' : 'POST', body });
      toast(esc(t('common.saved')), { type: 'success' });
      s.close(); onSaved?.();
    } catch (err) { errorToast(err); }
  };
}
