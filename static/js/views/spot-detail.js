// Fiche d'un spot : photo, données appareil, badges, météo, EXIF, audio, carte, navigation par balayage
import { api, mediaUrl } from '../api.js';
import { store, navigate } from '../app.js';
import { t, fmtDate, fmtNum, countryName, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, regText, regLabel, badgeHtml, tagChips, lightbox, menu, confirmDialog, toast, errorToast, undoToast } from '../ui.js';

const WX_ICON = { clear: 'sun', partly_cloudy: 'cloud-sun', cloudy: 'cloud', overcast: 'cloud', rain: 'cloud-rain', drizzle: 'cloud-rain', snow: 'cloud-snow', thunderstorm: 'cloud-lightning', fog: 'cloud-fog', mist: 'cloud-fog', haze: 'cloud-fog' };

// Un avion vu à plusieurs passages ne compte qu'une fois : un seul jeton par immatriculation (le spot courant, sinon le plus récent)
const distinctPlanes = (list, cur) => {
  const by = new Map();
  for (const m of list) {
    const o = by.get(m.registration);
    if (!o || m.id_spotting === cur || (o.id_spotting !== cur && String(m.date || '') > String(o.date || ''))) by.set(m.registration, m);
  }
  return [...by.values()];
};
export function weatherBlock(m, raw, taf) {
  if (!m) return '';
  const wind = m.wind_kt != null ? `${m.wind_dir != null ? String(m.wind_dir).padStart(3, '0') + '°' : 'VRB'} ${m.wind_kt}${m.gust_kt ? 'G' + m.gust_kt : ''} kt` : '—';
  const vis = m.visibility_m != null ? (m.visibility_m >= 9999 ? '≥ 10 km' : `${fmtNum(m.visibility_m / 1000, { maximumFractionDigits: 1 })} km`) : '—';
  const clouds = m.cavok ? 'CAVOK' : m.clouds?.length ? m.clouds.map((c) => `${c.cover}${c.ft != null ? ' ' + fmtNum(c.ft) + ' ft' : ''}${c.type ? ' ' + c.type : ''}`).join(', ') : t('wx.no_clouds');
  return `<div class="wx-grid">
      <div>${icon(WX_ICON[m.summary] || 'cloud-sun', '', 20)}<b>${esc(t(`wx.${m.summary}`))}</b><small>${esc(t('wx.conditions'))}</small></div>
      <div><b>${m.temp_c != null ? m.temp_c + ' °C' : '—'}</b><small>${esc(t('wx.temp'))}${m.dew_c != null ? ` · ${esc(t('wx.dew'))} ${m.dew_c}°` : ''}</small></div>
      <div><b>${esc(wind)}</b><small>${esc(t('wx.wind'))}</small></div>
      <div><b>${esc(vis)}</b><small>${esc(t('wx.visibility'))}</small></div>
      <div><b class="cat-${esc(m.category)}">${esc(m.category)}</b><small>${esc(t('wx.category'))}</small></div>
      <div><b>${m.qnh_hpa ? m.qnh_hpa + ' hPa' : '—'}</b><small>QNH</small></div>
    </div>
    <div class="small muted" style="margin-bottom:6px">${esc(t('wx.clouds'))} : ${esc(clouds)}</div>
    <div class="metar-raw">${esc(raw)}</div>
    ${taf ? `<details class="fold" style="margin-top:8px"><summary class="small">TAF ${icon('chevron-down', 'chev', 16)}</summary><div class="metar-raw" style="margin-top:6px">${esc(taf)}</div></details>` : ''}`;
}

export async function render(root, params) {
  const s = await api(`/api/spots/${params.id}`);
  const ex = s.exif || {};
  const ap = s.airport_info;
  const gear = [s.camera, s.lens].filter(Boolean).join(' + ');
  const settings = [s.focal && `${s.focal} mm`, s.aperture && `f/${s.aperture}`, s.shutter && `${s.shutter} s`, s.iso && `ISO ${s.iso}`].filter(Boolean).join(' · ');

  root.innerHTML = `
    ${s.image ? `<div class="detail-hero"><img src="${mediaUrl('images', s.image)}" alt="${esc(regText(s.registration))}" data-zoom>
      <div class="nav-btns">${s.prev_id ? `<a class="btn-icon" href="#/spots/${s.prev_id}" title="${esc(t('spot.newer'))}">${icon('chevron-left')}</a>` : ''}${s.next_id ? `<a class="btn-icon" href="#/spots/${s.next_id}" title="${esc(t('spot.older'))}">${icon('chevron-right')}</a>` : ''}</div></div>` : ''}
    <header class="page-head" style="${s.image ? 'padding-top:20px' : ''}">
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:12px"><h1 class="reg-title">${esc(regLabel(s))}</h1><span class="flag" style="font-size:30px" title="${esc(countryName(s.country))}">${flag(s.country)}</span></div>
        <div class="sub" style="font-size:17px;color:var(--text-2)">${esc(s.aircraft || s.aircraft_icao || t('spot.unknown_aircraft'))}${s.owner ? ` · <b>${esc(s.owner)}</b>` : ''}</div>
        <div class="sub">${icon('map-pin', '', 15)} ${esc(ap ? `${ap.name} (${ap.icao})` : s.airport || s.place || '—')} · ${icon('calendar', '', 15)} ${fmtDate(s.date)}</div>
      </div>
      <div class="actions">
        <button class="btn-icon glassy" data-fav title="${esc(t('spot.favorite'))}" style="${s.favorite ? 'color:#f59e0b' : ''}">${icon('star')}</button>
        <a class="btn-icon glassy" href="#/spots/${s.id_spotting}/share" title="${esc(t('share_img.title'))}">${icon('image')}</a>
        <a class="btn-icon glassy" href="#/spots/${s.id_spotting}/edit" title="${esc(t('common.edit'))}">${icon('pencil')}</a>
        <button class="btn-icon glassy" data-menu>${icon('ellipsis')}</button>
      </div>
    </header>
    ${s.badges.length || s.tags.length ? `<div class="chips" style="margin:-8px 0 16px">${s.badges.map((b) => badgeHtml(b)).join('')}${tagChips(s.tags)}</div>` : ''}

    ${s.outing ? `<a class="card row" style="margin-bottom:14px" href="#/outings/${s.outing.id}">${icon('calendar-days', '', 22)}
      <div class="grow"><b>${esc(s.outing.name || t('outing.this'))}</b><div class="small muted">${esc(t('outing.of_n', { n: s.outing.n }))}</div></div>${icon('chevron-right')}</a>` : ''}
    ${s.is_patrol && s.patrol_size ? `<div class="card row" style="margin-bottom:14px">${icon('users', '', 22)}<b>${esc(t('patrol.n_aircraft', { n: s.patrol_size }))}</b></div>` : ''}
    ${s.is_patrol && s.patrol_id ? `<div class="card" style="margin-bottom:14px"><div class="card-title">${icon('users', '', 18)} ${esc(s.patrol_name || t('patrol.title'))}<a href="#/patrols/${s.patrol_id}">${esc(t('patrol.open'))} →</a></div>
      ${s.patrol_members?.length ? `<span class="tiny muted">${esc(t('patrol.identified'))} · ${distinctPlanes(s.patrol_members).length}</span><div class="row wrap" style="gap:8px;margin-top:6px">${distinctPlanes(s.patrol_members).map((m) => `<a class="chip" href="#/spots/${m.id_spotting}">${esc(regText(m.registration))}</a>`).join('')}</div>` : `<p class="small muted">${esc(t('patrol.none_identified'))}</p>`}
      <div style="margin-top:10px"><a class="btn sm" href="#/spots/new?patrol=${encodeURIComponent(s.patrol_name || '')}&date=${esc((s.date || '').slice(0, 10))}&airport=${esc(s.airport || '')}">${icon('plus', '', 14)} ${esc(t('patrol.add_aircraft'))}</a></div></div>` : ''}
    ${s.patrol ? (() => {
      const ms = s.patrol.members, planes = distinctPlanes(ms.filter((m) => !m.is_patrol), s.id_spotting), passes = ms.filter((m) => m.is_patrol);
      const when = (m) => `${m.date ? fmtDate(m.date, { time: false }) : ''}${m.airport || m.place ? ' · ' + esc(m.airport || m.place) : ''}`;
      return `<div class="card" style="margin-bottom:14px"><div class="card-title">${icon('users', '', 18)} ${esc(s.patrol.name || t('multi.on_photo'))}<a href="#/patrols/${s.patrol.id}">${esc(t('patrol.open'))} →</a></div>
        <span class="tiny muted">${esc(t('patrol.identified'))} · ${planes.length}</span>
        <div class="row wrap" style="gap:8px;margin:6px 0 ${passes.length ? 10 : 0}px">${planes.map((m) => `<a class="chip ${m.id_spotting === s.id_spotting ? 'on' : ''}" href="#/spots/${m.id_spotting}">${esc(regText(m.registration))}</a>`).join('')}</div>
        ${passes.length ? `<span class="tiny muted">${esc(t('patrol.passes'))} · ${passes.length}</span><div class="row wrap" style="gap:8px;margin-top:6px">${passes.map((m) => `<a class="chip" href="#/spots/${m.id_spotting}">${when(m)}</a>`).join('')}</div>` : ''}</div>`;
    })() : ''}
    ${s.flights.length ? `<a class="card row" style="margin-bottom:14px;background:rgb(139 92 246 / .1)" href="#/airframe/${encodeURIComponent(s.registration)}">${icon('ticket', '', 26)}
      <div class="grow"><b>${esc(t('crossref.spot', { reg: s.registration, n: s.flights.length }))}</b>
      <div class="small muted">${s.flights.map((f) => `${esc(f.dep_icao)} → ${esc(f.arr_icao)} (${fmtDate(f.date, { time: false })})`).join(' · ')}</div></div>${icon('chevron-right')}</a>` : ''}

    <div class="grid two">
      <div class="stack">
        <div class="card">
          <div class="card-title">${esc(t('spot.aircraft_info'))}<a href="#/airframe/${encodeURIComponent(s.registration)}">${esc(t('spot.timeline', { n: s.encounters }))} →</a></div>
          <dl class="kv" style="margin:0">
            ${kv(t('spot.type_code'), s.aircraft_icao)}${kv(t('spot.manufacturer'), s.manufacturer)}${kv(t('spot.msn'), s.msn)}
            ${kv(t('spot.airline_icao'), s.airline_icao)}${kv(t('spot.country'), s.country ? `${flag(s.country)} ${countryName(s.country)}` : '')}
            ${kv('Mode-S', s.icao24 ? s.icao24.toUpperCase() : '')}${kv(t('spot.flight_type'), s.flight_type ? t(`ftype.${s.flight_type}`) : '')}${kv(t('spot.test_registration'), s.test_registration)}
            ${kv(t('spot.livery'), s.livery && s.livery !== 'None' ? s.livery : '')}${kv(t('spot.military'), s.military ? t('common.yes') : '')}
            ${kv(t('spot.rating'), s.rating ? '★'.repeat(s.rating) : '')}
          </dl>
          ${s.description ? `<p style="margin-top:14px;white-space:pre-wrap">${esc(s.description)}</p>` : ''}
        </div>
        ${s.atc_audio ? `<div class="card"><div class="card-title">${icon('radio', '', 16)} ${esc(t('spot.audio'))}</div><audio controls preload="none" src="${mediaUrl('audio', s.atc_audio)}"></audio></div>` : ''}
        ${gear || settings ? `<details class="card fold" open><summary>${icon('camera', '', 18)} ${esc(t('spot.exif'))} ${icon('chevron-down', 'chev', 18)}</summary>
          <div class="fold-body"><dl class="kv" style="margin:0">${kv(t('exif.camera'), s.camera)}${kv(t('exif.lens'), s.lens)}${kv(t('exif.focal'), s.focal ? `${s.focal} mm${ex.focal35 ? ` (${ex.focal35} mm eq.)` : ''}` : '')}
          ${kv(t('exif.aperture'), s.aperture ? `f/${s.aperture}` : '')}${kv(t('exif.shutter'), s.shutter)}${kv('ISO', s.iso)}${kv(t('exif.resolution'), s.image_w ? `${s.image_w} × ${s.image_h}` : '')}</dl>
          ${s.camera ? `<a class="small" style="color:var(--accent);display:inline-block;margin-top:10px" href="#/spots?camera=${encodeURIComponent(s.camera)}">${esc(t('spot.same_camera'))} →</a>` : ''}</div></details>` : ''}
      </div>
      <div class="stack">
        ${store.mod('weather') ? `<div class="card" data-wx><div class="card-title">${icon('cloud-sun', '', 16)} ${esc(t('spot.weather'))}
          <button class="btn sm ghost" data-wxr title="${esc(t('common.refresh'))}">${icon('refresh-cw', '', 15)}</button></div>
          <div data-wxbody>${s.metar ? weatherBlock(s.metar_decoded, s.metar, s.taf)
            : `<p class="muted small">${esc(t(s.weather_status === 'pending' ? 'wx.pending' : s.weather_status === 'error' ? 'wx.error' : s.airport ? 'wx.none' : 'wx.no_airport'))}</p>`}</div>
          ${s.sun_elevation != null ? `<p class="small muted" style="margin-top:10px">${icon('sun', '', 14)} ${esc(t('spot.sun_elev', { n: fmtNum(s.sun_elevation, { maximumFractionDigits: 1 }) }))}</p>` : ''}</div>` : ''}
        <div class="card flush"><div class="map" style="height:260px;border-radius:0" data-map></div>
          ${s.location ? `<div style="padding:12px 16px" class="small">${icon('binoculars', '', 15)} <b>${esc(s.location.name)}</b></div>` : ''}</div>
      </div>
    </div>
    <p class="tiny muted center" style="margin:22px 0">${esc(t('spot.created', { date: fmtDate(s.created_at) }))} · #${s.id_spotting}</p>`;

  // Visionneuse
  root.querySelector('[data-zoom]')?.addEventListener('click', () => lightbox([{ src: mediaUrl('images', s.image), caption: `<span class="mono">${esc(s.registration)}</span> · ${esc(s.aircraft || '')}` }]));

  // Balayage gauche/droite sur mobile pour passer au spot suivant/précédent
  let x0 = null, y0 = 0;
  const ts = (e) => { if (e.target.closest('.map,audio,details')) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
  const te = (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      if (dx < 0 && s.next_id) navigate(`#/spots/${s.next_id}`);
      if (dx > 0 && s.prev_id) navigate(`#/spots/${s.prev_id}`);
    }
  };
  root.addEventListener('touchstart', ts, { passive: true });
  root.addEventListener('touchend', te);
  const keys = (e) => {
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName) || document.querySelector('.lightbox,.sheet')) return;
    if (e.key === 'ArrowLeft' && s.prev_id) navigate(`#/spots/${s.prev_id}`);
    if (e.key === 'ArrowRight' && s.next_id) navigate(`#/spots/${s.next_id}`);
    if (e.key === 'e') navigate(`#/spots/${s.id_spotting}/edit`);
  };
  document.addEventListener('keydown', keys);

  root.querySelector('[data-fav]').onclick = async (e) => {
    const r = await api(`/api/spots/${s.id_spotting}/favorite`, { method: 'PATCH' });
    e.currentTarget.style.color = r.favorite ? '#f59e0b' : '';
  };
  root.querySelector('[data-wxr]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await api(`/api/spots/${s.id_spotting}/weather`, { method: 'POST' });
      root.querySelector('[data-wxbody]').innerHTML = r.metar ? weatherBlock(r.metar_decoded, r.metar, r.taf) : `<p class="muted small">${esc(t('wx.none'))}</p>`;
    } catch (err) { errorToast(err); } finally { b.disabled = false; }
  });
  root.querySelector('[data-menu]').onclick = (e) => menu(e.currentTarget, [
    ...(s.image ? [{ icon: 'download', label: t('export.photo'), onClick: () => (location.href = `/api/export/spots/${s.id_spotting}/photo.jpg`) }] : []),
    { icon: 'history', label: t('nav.airframe'), onClick: () => navigate(`#/airframe/${encodeURIComponent(s.registration)}`) },
    { icon: 'image', label: t('share_img.title'), onClick: () => navigate(`#/spots/${s.id_spotting}/share`) },
    { icon: 'link', label: t('share.this_spot'), onClick: async () => (await import('./shares.js')).createShareFlow({ kind: 'spot', target: String(s.id_spotting) }) },
    store.mod('watchlist') && { icon: 'eye', label: t('watch.add'), onClick: async () => { try { await api('/api/watchlist', { method: 'POST', body: { registration: s.registration } }); toast(esc(t('watch.added')), { type: 'success' }); } catch (err) { errorToast(err); } } },
    { icon: 'copy', label: t('spot.duplicate'), onClick: () => navigate(`#/spots/new?${s.airport ? 'airport=' + encodeURIComponent(s.airport) : 'place=' + encodeURIComponent(s.place || '') + (s.lat != null ? `&lat=${s.lat}&lng=${s.lng}` : '')}`) },
    s.image && { icon: 'download', label: t('spot.download_photo'), onClick: () => { const a = document.createElement('a'); a.href = mediaUrl('images', s.image); a.download = `${s.registration}.webp`; a.click(); } },
    '-',
    { icon: 'trash-2', label: t('common.delete'), danger: true, onClick: async () => {
      if (!(await confirmDialog(esc(t('spot.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
      const r = await api(`/api/spots/${s.id_spotting}`, { method: 'DELETE' });
      undoToast(esc(t('common.deleted')), r.trash, { onUndo: () => navigate('#/spots') });
      navigate('#/spots');
    } },
  ]);

  // Carte
  let mp = Promise.resolve(null);
  const lat = s.lat ?? ap?.lat, lng = s.lng ?? ap?.lng;
  const mapEl = root.querySelector('[data-map]');
  if (lat != null) {
    mp = import('../lib/map.js').then(async ({ createMap, conePolygon }) => {
      const m = await createMap(mapEl, { center: [lat, lng], zoom: s.lat != null ? 14 : 11.5, scrollZoom: false });
      if (s.location?.view_bearing != null) m.polygons('cone', [conePolygon(s.location.lat, s.location.lng, s.location.view_bearing)]);
      m.marker([lat, lng], { label: '' });
      return m;
    }).catch(() => null);
  } else mapEl.outerHTML = `<div class="empty small">${icon('map-pin', '', 30)}${esc(t('spot.no_location'))}</div>`;

  return () => { mp.then((m) => m?.remove()); document.removeEventListener('keydown', keys); };
}

function kv(k, v) {
  if (v === null || v === undefined || v === '') return '';
  return `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
}
