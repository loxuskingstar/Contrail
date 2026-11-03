// Timeline d'une cellule : toutes les rencontres (spots + vols) dans le temps et sur la carte
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtDate, countryName, flag, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, badgesHtml, toast, errorToast, emptyState } from '../ui.js';
import { planespottersPhoto, photoBlock } from '../lib/photos.js';

export async function render(root, params) {
  const a = await api(`/api/airframe/${encodeURIComponent(params.reg)}`);
  const i = a.info;
  root.innerHTML = `
    ${a.cover ? `<div class="hero" style="min-height:240px;margin-top:12px"><img src="${mediaUrl('images', a.cover)}" alt=""><div class="in">
      <div class="row"><h2 class="mono" style="font-size:38px">${esc(i.registration)}</h2><span class="flag" style="font-size:30px">${flag(i.country)}</span></div>
      <div style="opacity:.9">${esc(i.aircraft || i.aircraft_icao || '')}${i.owner ? ' · ' + esc(i.owner) : ''}</div></div></div>` : ''}
    <header class="page-head" style="${a.cover ? 'padding-top:18px' : ''}">
      <div>${a.cover ? '' : `<h1 class="reg-title">${esc(i.registration)} <span class="flag">${flag(i.country)}</span></h1>`}
        <h1 class="${a.cover ? '' : 'sr'}" style="font-size:22px">${esc(t('airframe.title'))}</h1>
        <div class="sub">${esc([i.aircraft || i.aircraft_icao, i.owner, i.country && countryName(i.country), i.msn && `MSN ${i.msn}`].filter(Boolean).join(' · '))}</div></div>
      <div class="actions">
        ${store.mod('watchlist') ? `<button class="btn" data-watch>${icon(a.watch_id ? 'eye-off' : 'eye', '', 18)} ${esc(t(a.watch_id ? 'watch.remove' : 'watch.add'))}</button>` : ''}
        <button class="btn-icon glassy" data-share title="${esc(t('share.title'))}">${icon('share-2')}</button>
        <a class="btn primary" href="#/spots/new?reg=${encodeURIComponent(i.registration)}">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>
      </div>
    </header>
    ${a.cover ? '' : `<div class="ac-photo" data-ext-photo hidden style="max-width:460px;margin-bottom:14px"></div>`}
    <div class="grid kpis" style="margin-bottom:14px">
      <div class="card kpi">${icon('camera')}<div class="v">${a.spots}</div><div class="l">${esc(t('airframe.encounters'))}</div></div>
      <div class="card kpi">${icon('ticket')}<div class="v">${a.flights}</div><div class="l">${esc(t('airframe.flights'))}</div></div>
      <div class="card kpi">${icon('map-pin')}<div class="v">${a.airports.length}</div><div class="l">${esc(t('stat.airports'))}</div></div>
      <div class="card kpi">${icon('calendar')}<div class="v" style="font-size:16px">${a.first_seen ? fmtDate(a.first_seen, { time: false }) : '—'}</div><div class="l">${esc(t('airframe.first_seen'))}</div></div>
      <div class="card kpi">${icon('history')}<div class="v" style="font-size:16px">${a.last_seen ? fmtDate(a.last_seen, { time: false }) : '—'}</div><div class="l">${esc(t('airframe.last_seen'))}</div></div>
    </div>
    ${a.events.length ? `<div class="grid two">
      <div class="card"><div class="card-title">${esc(t('airframe.timeline'))}</div><div class="timeline">${a.events.map(evHtml).join('')}</div></div>
      <div class="stack"><div class="card flush"><div class="map" style="height:380px;border-radius:0" data-map></div></div>
        ${a.changes.length ? `<div class="card"><div class="card-title">${esc(t('airframe.changes'))}</div>${a.changes.map((c) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--hair)"><b>${fmtDate(c.date, { time: false })}</b> — ${esc(c.owner || '?')}${c.livery ? ` · ${esc(c.livery)}` : ''}</div>`).join('')}</div>` : ''}
      </div></div>` : `<div class="card">${emptyState('plane', t('airframe.empty'), t('airframe.empty_text'))}</div>`}`;

  // Pas encore de photo personnelle : la plus récente de Planespotters.net (avec crédit et lien)
  const ext = root.querySelector('[data-ext-photo]');
  if (ext) planespottersPhoto({ hex: i.icao24, reg: i.registration }).then((p) => { if (p && ext.isConnected) { ext.innerHTML = photoBlock(p); ext.hidden = false; } });

  let mp = Promise.resolve(null);
  if (a.events.length) {
    mp = import('../lib/map.js').then(async ({ createMap, greatCircle }) => {
      const m = await createMap(root.querySelector('[data-map]'), { scrollZoom: false });
      const pts = [], lines = [];
      let n = 0;
      for (const e of a.events) {
        if (e.kind === 'flight' && e.dep_ll && e.arr_ll) {
          lines.push({ coords: greatCircle(e.dep_ll, e.arr_ll), props: { label: `${e.dep} → ${e.arr}`, date: e.date } });
          pts.push(e.dep_ll, e.arr_ll);
        }
      }
      m.lines('flights', lines, { color: '#7c3aed', width: 2.5, dash: [2, 2], onClick: (p, at) => m.popup([at.lat, at.lng], `${esc(p.label)}<br>${fmtDate(p.date)}`) });
      const items = [];
      for (const e of a.events) {
        if (e.kind === 'spot' && e.lat != null) {
          n++;
          pts.push([e.lat, e.lng]);
          items.push({ lat: e.lat, lng: e.lng, label: n, popup: `<b>${esc(e.airport_name || e.airport)}</b><br>${fmtDate(e.date)}<br><a href="#/spots/${e.id}">${esc(t('common.open'))} →</a>` });
        }
      }
      m.clusters('spots', items);
      m.fit(pts, { maxZoom: 9 });
      return m;
    }).catch(() => null);
  }

  root.querySelector('[data-watch]')?.addEventListener('click', async () => {
    try {
      if (a.watch_id) await api(`/api/watchlist/${a.watch_id}`, { method: 'DELETE' });
      else await api('/api/watchlist', { method: 'POST', body: { registration: i.registration } });
      toast(esc(t(a.watch_id ? 'watch.removed' : 'watch.added')), { type: 'success' });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { errorToast(e); }
  });
  root.querySelector('[data-share]').onclick = async () => (await import('./shares.js')).createShareFlow({ kind: 'airframe', target: i.registration });
  return () => mp.then((m) => m?.remove());
}

function evHtml(e) {
  if (e.kind === 'flight') {
    return `<div class="tl-item flight"><div class="tl-date">${fmtDate(e.date)}</div>
      <a href="#/flights/${e.id}" style="display:block"><b>${icon('ticket', '', 15)} ${esc(e.dep)} → ${esc(e.arr)}</b>
      <span class="muted small">${esc(e.flight_number || '')}${e.seat ? ` · ${esc(t('flight.seat'))} ${esc(e.seat)}` : ''}</span></a></div>`;
  }
  return `<div class="tl-item"><div class="tl-date">${fmtDate(e.date)}</div>
    <a href="#/spots/${e.id}" class="row" style="align-items:flex-start;margin-top:4px">
      ${e.thumb ? `<img src="${mediaUrl('thumbs', e.thumb)}" style="width:92px;height:64px;object-fit:cover;border-radius:12px" alt="">` : ''}
      <div class="grow"><b>${icon('camera', '', 15)} ${esc(e.airport_name || e.airport || '—')}</b>
      <div class="small muted">${esc(e.owner || '')}${e.livery && e.livery !== 'None' ? ` · ${esc(e.livery)}` : ''}</div>${badgesHtml(e.badges, 3)}</div></a></div>`;
}
