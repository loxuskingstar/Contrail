// Page publique d'un lien de partage (galerie, spot, cellule, vol(s)) — lecture seule
import { api } from '../api.js';
import { t, fmtDate, fmtNum, flag, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, regText, lightbox, emptyState } from '../ui.js';

export async function render(app, { token }) {
  let d;
  try {
    d = await api(`/api/public/${encodeURIComponent(token)}`);
  } catch (e) {
    app.innerHTML = `<div class="login"><div class="card">${emptyState('link', t(e.status === 410 ? 'share.expired' : 'share.not_found'))}</div></div>`;
    return;
  }
  const img = (id, size = 'thumb') => `/api/public/${encodeURIComponent(token)}/media/${size}/${id}`;
  const title = d.title || (d.kind === 'airframe' ? d.registration : d.kind === 'flights' || d.kind === 'flight' ? t('share.k_flights') : t('share.k_gallery'));
  document.title = `${title} · Contrail`;
  const withImg = d.spots.filter((s) => s.has_image);
  app.innerHTML = `
    <header class="public-head">
      <div class="side-brand" style="padding:0 0 18px"><span class="logo">${icon('plane', '', 20)}</span>Contrail</div>
      <h1 style="font-size:clamp(30px,7vw,46px);font-weight:780">${esc(title)}</h1>
      <div class="row wrap" style="margin-top:12px">
        ${d.stats.spots ? `<span class="chip">${icon('camera', '', 14)} ${fmtNum(d.stats.spots)} ${esc(t('stat.spots'))}</span><span class="chip">${fmtNum(d.stats.regs)} ${esc(t('stat.regs'))}</span><span class="chip">${fmtNum(d.stats.types)} ${esc(t('stat.types'))}</span>` : ''}
        ${d.stats.flights ? `<span class="chip">${icon('ticket', '', 14)} ${fmtNum(d.stats.flights)} ${esc(t('stat.flights_l'))}</span><span class="chip">${fmtNum(d.stats.km)} km</span>` : ''}
      </div>
    </header>
    <main class="main" style="padding-bottom:48px">
      ${d.flights.length ? `<div class="card flush" style="margin-bottom:16px"><div class="map" style="height:380px;border-radius:0" data-map></div></div>
        <div class="list card" style="padding:6px;margin-bottom:16px">${d.flights.map((f) => `<div class="list-row"><div class="grow"><div class="ttl mono">${esc(f.dep_icao)} → ${esc(f.arr_icao)}</div>
          <div class="meta">${flag(f.dep_info?.country)} ${esc(f.dep_info?.city || '')} → ${flag(f.arr_info?.country)} ${esc(f.arr_info?.city || '')} · ${fmtDate(f.date, { time: false })}</div>
          <div class="meta">${esc([f.flight_number, f.airline, f.aircraft, f.registration].filter(Boolean).join(' · '))}</div></div><b class="num">${fmtNum(f.distance_km)} km</b></div>`).join('')}</div>` : ''}
      ${d.spots.length ? `<div class="gallery">${d.spots.map((s, i) => `<button class="tile ${s.has_image ? '' : 'noimg'}" data-i="${i}" style="border:0;padding:0;text-align:left;color:inherit">
          ${s.has_image ? `<img loading="lazy" src="${img(s.id_spotting)}" alt="${esc(s.registration)}">` : icon('plane', '', 32)}
          <div class="cap"><b class="mono">${esc(regText(s.registration))}</b> <span class="flag">${flag(s.country)}</span><small class="ellipsis">${esc([s.aircraft || s.aircraft_icao, s.owner].filter(Boolean).join(' · '))}</small>
          <small>${esc(s.airport || '')} · ${fmtDate(s.date, { time: false })}</small></div></button>`).join('')}</div>` : ''}
      ${!d.spots.length && !d.flights.length ? `<div class="card">${emptyState('images', t('share.public_empty'))}</div>` : ''}
      <p class="tiny muted center" style="margin-top:28px">${esc(t('share.public_footer'))}</p>
    </main>`;
  app.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
    const s = d.spots[Number(b.dataset.i)];
    if (!s.has_image) return;
    const caption = (x) => `<span class="mono">${esc(x.registration)}</span> · ${esc(x.aircraft || '')} · ${esc(x.airport_name || x.airport || '')} · ${fmtDate(x.date, { time: false })}${x.camera ? `<br><span class="small" style="opacity:.75">${esc([x.camera, x.lens, x.focal && x.focal + ' mm', x.aperture && 'f/' + x.aperture, x.shutter, x.iso && 'ISO ' + x.iso].filter(Boolean).join(' · '))}</span>` : ''}`;
    lightbox(withImg.map((x) => ({ src: img(x.id_spotting, 'image'), caption: caption(x) })), withImg.indexOf(s));
  }));
  if (d.flights.length) {
    const { createMap, greatCircle } = await import('../lib/map.js');
    const m = await createMap(app.querySelector('[data-map]'), { center: [30, 10], zoom: 1.3, scrollZoom: false }).catch(() => null);
    if (!m) return;
    const pts = [], lines = [];
    for (const f of d.flights) {
      if (!f.dep_info || !f.arr_info) continue;
      const a = [f.dep_info.lat, f.dep_info.lng], b = [f.arr_info.lat, f.arr_info.lng];
      lines.push({ coords: greatCircle(a, b) });
      m.marker(a, { kind: 'dot', size: 10 });
      m.marker(b, { kind: 'dot', size: 10 });
      pts.push(a, b);
    }
    m.lines('routes', lines, { width: 2.4 });
    m.fit(pts, { maxZoom: 6 });
  }
}
