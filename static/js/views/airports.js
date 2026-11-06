// Liste des aéroports où des spots ont été pris, triés par fréquentation
import { api } from '../api.js';
import { t, fmtDate, fmtNum, flag, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, debounce, regFlag, sheet, toast } from '../ui.js';

export const KINDS = ['airport', 'heliport', 'airfield', 'seaplane', 'balloonport'];

/** Feuille d'ajout / de modification d'un aéroport, d'une hélistation ou d'un terrain absent des bases embarquées. */
export function airfieldSheet(a, onSaved) {
  const edit = !!a;
  const v = { code: '', name: '', kind: 'airport', city: '', country: '', lat: 46.6, lng: 2.4, elevation_ft: '', ...(a || {}) };
  const s = sheet({ title: esc(t(edit ? 'airfield.edit' : 'airfield.add')), wide: true, body: `<form class="stack" autocomplete="off">
    <p class="small muted">${esc(t('airfield.hint'))}</p>
    <div class="field-row">
      <label class="field"><span>${esc(t('airfield.code'))}</span><input name="code" value="${esc(v.code)}" maxlength="10" required autocapitalize="characters" spellcheck="false" placeholder="LF3624" ${edit ? 'readonly' : ''}></label>
      <label class="field"><span>${esc(t('airfield.kind'))}</span><select name="kind">${KINDS.map((k) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${esc(t('airfield.kind_' + k))}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>${esc(t('airfield.name'))}</span><input name="name" value="${esc(v.name)}" maxlength="120" required placeholder="${esc(t('airfield.name_ph'))}"></label>
    <div class="field-row">
      <label class="field"><span>${esc(t('airfield.city'))}</span><input name="city" value="${esc(v.city)}" maxlength="80"></label>
      <label class="field"><span>${esc(t('spot.country'))}</span><select name="country"><option value="">—</option>${v.country ? `<option value="${esc(v.country)}" selected>${flag(v.country)} ${esc(countryName(v.country))}</option>` : ''}</select></label>
    </div>
    <div class="field"><span>${esc(t('airfield.position'))}</span>
      <div class="row" style="gap:8px"><input class="input grow" data-find placeholder="${esc(t('airfield.find_ph'))}" enterkeyhint="search"><button type="button" class="btn" data-findbtn>${icon('search', '', 16)}</button><button type="button" class="btn" data-geo title="${esc(t('airfield.my_position'))}" aria-label="${esc(t('airfield.my_position'))}">${icon('crosshair', '', 16)}</button></div>
      <div class="chips" data-found style="margin-top:6px"></div></div>
    <div class="map" style="height:240px;border-radius:12px" data-pick></div>
    <div class="field-row">
      <label class="field"><span>Latitude</span><input name="lat" value="${v.lat}" inputmode="decimal" required></label>
      <label class="field"><span>Longitude</span><input name="lng" value="${v.lng}" inputmode="decimal" required></label>
      <label class="field"><span>${esc(t('airfield.elevation'))}</span><input name="elevation_ft" value="${v.elevation_ft ?? ''}" inputmode="numeric" placeholder="ft"></label>
    </div>
    <div class="row" style="justify-content:space-between;gap:8px">${edit ? `<button type="button" class="btn ghost danger" data-del>${icon('trash-2', '', 16)} ${esc(t('common.delete'))}</button>` : '<span></span>'}
      <span class="row"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('common.save'))}</button></span></div>
  </form>` });
  const form = s.body.querySelector('form');
  const F = (n) => form.elements[n];
  s.body.querySelector('[data-close]').onclick = s.close;
  api('/api/spots/countries').then((codes) => {
    const cur = F('country').value;
    F('country').innerHTML = '<option value="">—</option>' + codes.map((c) => ({ c, n: countryName(c) })).sort((x, y) => x.n.localeCompare(y.n))
      .map(({ c, n }) => `<option value="${esc(c)}">${flag(c)} ${esc(n)}</option>`).join('');
    F('country').value = cur;
  }).catch(() => {});
  let map = null, marker = null;
  const setPos = (lat, lng, zoom) => {
    F('lat').value = Number(lat).toFixed(6); F('lng').value = Number(lng).toFixed(6);
    marker?.setLatLng([lat, lng]);
    if (zoom) map?.setView([lat, lng], zoom);
  };
  import('../lib/map.js').then(async ({ createMap }) => {
    map = await createMap(s.body.querySelector('[data-pick]'), { center: [Number(v.lat), Number(v.lng)], zoom: edit ? 15 : 5 });
    marker = map.marker([Number(v.lat), Number(v.lng)], { label: '', draggable: true, onDragEnd: ({ lat, lng }) => setPos(lat, lng) });
    map.onClick(({ lat, lng }) => setPos(lat, lng));
    ['lat', 'lng'].forEach((k) => F(k).addEventListener('change', () => { const la = Number(F('lat').value), ln = Number(F('lng').value); if (!Number.isNaN(la) && !Number.isNaN(ln)) { marker.setLatLng([la, ln]); map.setView([la, ln], 15); } }));
  }).catch(() => {});
  const found = s.body.querySelector('[data-found]');
  const find = async () => {
    const term = s.body.querySelector('[data-find]').value.trim();
    if (term.length < 2) return;
    try {
      const rows = await api(`/api/places/search?q=${encodeURIComponent(term)}`);
      found.innerHTML = rows.length ? rows.slice(0, 6).map((r, i) => `<button type="button" class="chip" data-i="${i}">${icon('map-pin', '', 13)} ${esc(r.label)}</button>`).join('') : `<span class="small muted">${esc(t('common.no_results'))}</span>`;
      found.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
        const r = rows[Number(b.dataset.i)];
        setPos(r.lat, r.lng, 14);
        if (!F('city').value) F('city').value = r.name || '';
        if (!F('country').value && r.country) F('country').value = r.country;
        found.innerHTML = '';
      }));
    } catch { found.innerHTML = `<span class="small muted">${esc(t('airfield.find_offline'))}</span>`; }
  };
  s.body.querySelector('[data-findbtn]').onclick = find;
  s.body.querySelector('[data-find]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  s.body.querySelector('[data-geo]').onclick = () => navigator.geolocation?.getCurrentPosition((p) => setPos(p.coords.latitude, p.coords.longitude, 16), () => toast(esc(t('airfield.geo_denied')), { type: 'error' }), { timeout: 8000 });
  if (edit) s.body.querySelector('[data-del]').onclick = async () => {
    if (!window.confirm(t('airfield.delete_confirm'))) return;
    try { await api(`/api/airport-pages/custom/${encodeURIComponent(v.icao || v.code)}`, { method: 'DELETE' }); s.close(); onSaved?.(null); } catch (e) { errorToast(e); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { code: F('code').value.trim().toUpperCase(), name: F('name').value.trim(), kind: F('kind').value, city: F('city').value.trim() || null,
      country: F('country').value || null, lat: Number(F('lat').value.replace(',', '.')), lng: Number(F('lng').value.replace(',', '.')),
      elevation_ft: F('elevation_ft').value.trim() ? Math.round(Number(F('elevation_ft').value)) : null };
    if (Number.isNaN(body.lat) || Number.isNaN(body.lng)) { toast(esc(t('err.invalid_airfield')), { type: 'error' }); return; }
    try {
      const r = await api(edit ? `/api/airport-pages/custom/${encodeURIComponent(body.code)}` : '/api/airport-pages', { method: edit ? 'PUT' : 'POST', body });
      toast(esc(t('common.saved')), { type: 'success' });
      s.close(); onSaved?.(r);
    } catch (err) { errorToast(err); }
  };
}

export async function render(root) {
  let items = [];
  try { items = (await api('/api/airport-pages')).items; } catch (e) { errorToast(e); }
  const addBtn = `<button class="btn primary" data-add>${icon('plus', '', 16)} ${esc(t('airfield.add'))}</button>`;
  const reload = () => render(root);
  if (!items.length) {
    root.innerHTML = pageHead(esc(t('airport.title')), { actions: addBtn }) + `<div class="card">${emptyState('map-pin', t('airport.empty'), t('airport.empty_text'))}</div>`;
    root.querySelector('[data-add]').onclick = () => airfieldSheet(null, reload);
    return;
  }
  root.innerHTML = `${pageHead(esc(t('airport.title')), { sub: esc(t('airport.count', { n: items.length, nf: fmtNum(items.length) })), actions: addBtn })}
    <div class="grid kpis" style="margin-bottom:14px">${[['map-pin', items.length, t('nav.airports')], ['globe', new Set(items.map((a) => a.country).filter(Boolean)).size, t('airport.countries')],
      ['camera', items.reduce((s, a) => s + a.n, 0), t('outing.k_spots')], ['trophy', items[0].n ? items[0].icao : '—', t('airport.most')]].map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${typeof v === 'number' ? fmtNum(v) : esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
    <div class="card flush" style="margin-bottom:14px"><div class="map" style="height:340px;border-radius:0" data-map></div></div>
    <div class="search" style="margin-bottom:12px">${icon('search', '', 18)}<input class="input" type="search" data-q placeholder="${esc(t('airport.search_ph'))}" autocomplete="off"></div>
    <div class="card" style="padding:6px" data-list></div>`;
  const list = root.querySelector('[data-list]');
  root.querySelector('[data-add]').onclick = () => airfieldSheet(null, reload);
  const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const draw = (term = '') => {
    const k = fold(term);
    const rows = items.filter((a) => !k || fold(`${a.icao} ${a.iata || ''} ${a.name || ''} ${a.city || ''}`).includes(k));
    list.innerHTML = rows.map((a) => `<a class="list-row" href="#/airports/${esc(a.icao)}">
      <span class="mono" style="min-width:48px"><b>${esc(a.icao)}</b></span>
      <span class="grow ellipsis">${a.country ? regFlag(a.country) + ' ' : ''}${esc(a.name || a.city || '')}<span class="small muted" style="display:block">${esc(a.n ? t('airport.row', { regs: a.regs, last: a.last_at ? fmtDate(a.last_at, { time: false }) : '' }) : (a.city || ''))}</span></span>
      ${a.custom ? `<span class="badge slate" title="${esc(t('airfield.custom'))}">${icon('pencil', '', 11)}</span>` : ''}${a.kind === 'heliport' ? `<span class="badge slate">${esc(t('airfield.kind_heliport'))}</span>` : ''}
      <span class="badge">${a.n ? fmtNum(a.n) + '×' : '—'}</span>${icon('chevron-right', '', 16)}</a>`).join('') || `<p class="muted" style="padding:14px">${esc(t('common.no_results'))}</p>`;
  };
  draw();
  root.querySelector('[data-q]').addEventListener('input', debounce((e) => draw(e.target.value), 150));
  import('../lib/map.js').then(async ({ createMap }) => {
    const m = await createMap(root.querySelector('[data-map]'));
    const pts = items.filter((a) => a.lat != null);
    pts.forEach((a) => m.marker([a.lat, a.lng], { label: String(a.n), title: `${a.icao} · ${a.name || ''}`, onClick: () => { location.hash = `#/airports/${a.icao}`; } }));
    m.fit(pts.map((a) => [a.lat, a.lng]), { maxZoom: 9 });
  }).catch(() => {});
}
