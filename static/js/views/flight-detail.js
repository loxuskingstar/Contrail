// Détail d'un vol : billet, carte du trajet, appareil, mise en perspective, vols voisins, export en image
import { api, mediaUrl } from '../api.js';
import { store, navigate } from '../app.js';
import { t, fmtNum, fmtDate, fmtDuration, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, menu, sheet, toast, errorToast, confirmDialog, undoToast } from '../ui.js';
import { FONTS, loadFonts, rrect, rgba, fit, fitSize, barcode, dashed, grain, canvasBlob, flagEmoji } from '../lib/canvas.js';
import { drawAircraft, loadTypes, classify, typeName } from '../lib/shapes.js';

const ord = (n) => (n === 1 ? t('flight_d.nth_1') : t('flight_d.nth', { n }));

export async function render(root, params) {
  const [f] = await Promise.all([api(`/api/flights/${params.id}`), loadTypes()]);
  const C = f.context || {};
  const D = f.dep_info || { icao: f.dep_icao }, A = f.arr_info || { icao: f.arr_icao };
  const imperial = store.settings.units === 'imperial';
  const dist = (km) => (km == null ? '—' : imperial ? `${fmtNum(Math.round(km * 0.539957))} nm` : `${fmtNum(Math.round(km))} km`);
  const typeLabel = f.aircraft || typeName(f.aircraft_icao) || f.aircraft_icao || '';
  const cls = classify(f.aircraft_icao, f.aircraft);
  const utc = (iso) => (iso ? `${iso.slice(11, 16)} UTC` : '');

  // Faits marquants : premières fois et récurrences
  const facts = [];
  if (C.overall) facts.push({ ic: 'ticket', txt: t('flight_d.f_overall', { n: ord(C.overall.n), total: C.overall.total }) });
  if (C.route) facts.push({ ic: 'route', txt: C.route.total === 1 ? t('flight_d.f_route_once') : t('flight_d.f_route', { n: ord(C.route.n), total: C.route.total }) });
  if (C.airline && (f.airline || f.airline_icao)) facts.push({ ic: 'building-2', txt: C.airline.n === 1 ? t('flight_d.f_airline_first', { a: f.airline || f.airline_icao }) : t('flight_d.f_airline', { n: ord(C.airline.n), a: f.airline || f.airline_icao }) });
  if (C.type && typeLabel) facts.push({ ic: 'plane', txt: C.type.n === 1 ? t('flight_d.f_type_first', { a: typeLabel }) : t('flight_d.f_type', { n: ord(C.type.n), a: typeLabel }) });
  if (C.airframe && f.registration && C.airframe.total > 1) facts.push({ ic: 'repeat', txt: t('flight_d.f_airframe', { n: ord(C.airframe.n), reg: f.registration }) });
  if (C.year) facts.push({ ic: 'calendar', txt: t('flight_d.f_year', { n: ord(C.year.n), y: f.date.slice(0, 4) }) });

  const side = (a, code, time, utcIso, label) => `<div class="fl-end">
      <span class="tiny muted fl-lbl">${esc(label)}</span>
      <b class="fl-code mono">${esc(a.iata || code)}</b>
      <span class="small ellipsis">${a.country ? flag(a.country) + ' ' : ''}${esc(a.city || a.name || code)}</span>
      <span class="tiny muted ellipsis">${esc(a.name || '')}${a.iata ? ` · ${esc(code)}` : ''}</span>
      ${time ? `<span class="fl-time num">${esc(time.slice(0, 5))}</span><span class="tiny muted">${esc(utc(utcIso))}</span>` : ''}
    </div>`;

  const row = (k, v, html = false) => (v ? `<div class="fkv"><span>${esc(k)}</span><b>${html ? v : esc(v)}</b></div>` : '');
  root.innerHTML = `
    <header class="page-head"><div><h1><span class="mono">${esc(f.dep_icao)}</span> ${icon('arrow-right', '', 26)} <span class="mono">${esc(f.arr_icao)}</span></h1>
      <div class="sub">${esc(fmtDate(f.date, { time: false, weekday: true }))}${f.flight_number ? ` · <span class="mono">${esc(f.flight_number)}</span>` : ''}${f.airline ? ` · ${esc(f.airline)}` : ''}</div></div>
      <div class="actions"><a class="btn" href="#/flights/${f.id_flight}/edit">${icon('pencil', '', 18)} <span class="hide-sm">${esc(t('common.edit'))}</span></a>
      <button class="btn" data-img>${icon('image', '', 18)} <span class="hide-sm">${esc(t('flight_d.image'))}</span></button>
      <button class="btn-icon glassy" data-more>${icon('ellipsis')}</button></div></header>

    <div class="fl-layout">
      <div class="stack">
        <div class="card fl-ticket">
          ${side(D, f.dep_icao, f.dep_time, C.dep_utc, t('flight.from'))}
          <div class="fl-mid">
            <span class="small muted">${f.duration_min ? esc(fmtDuration(f.duration_min)) : '&nbsp;'}</span>
            <div class="fl-line"><i></i>${icon('plane', '', 20)}<i></i></div>
            <span class="small"><b>${esc(dist(f.distance_km))}</b></span>
          </div>
          ${side(A, f.arr_icao, f.arr_time, C.arr_utc, t('flight.to'))}
        </div>
        <div class="card flush"><div class="map" data-map style="height:340px;border-radius:0"></div></div>
        ${facts.length ? `<div class="card"><div class="card-title">${esc(t('flight_d.facts'))}</div>
          <div class="fl-facts">${facts.map((x) => `<div>${icon(x.ic, '', 16)}<span>${esc(x.txt)}</span></div>`).join('')}</div></div>` : ''}
        ${f.notes ? `<div class="card"><div class="card-title">${esc(t('spot.description'))}</div><p style="white-space:pre-wrap;margin:0">${esc(f.notes)}</p></div>` : ''}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-title">${esc(t('flight_d.flight'))}</div>
          <div class="fkvs">
            ${row(t('flight.number'), f.flight_number ? `<span class="mono">${esc(f.flight_number)}</span>` : '', true)}
            ${row(t('flight.airline'), f.airline || f.airline_icao)}
            ${row(t('flight.date'), fmtDate(f.date, { time: false, weekday: true }))}
            ${row(t('flight_d.duration'), f.duration_min ? fmtDuration(f.duration_min) : '')}
            ${row(t('flight_d.distance'), dist(f.distance_km))}
            ${row(t('flight_d.speed'), C.speed_kmh ? (imperial ? `${fmtNum(Math.round(C.speed_kmh * 0.539957))} kt` : `${fmtNum(C.speed_kmh)} km/h`) : '')}
            ${row(t('flight_d.earth'), f.distance_km ? `${fmtNum((f.distance_km / 40075) * 100, { maximumFractionDigits: 1 })} %` : '')}
          </div>
        </div>
        ${f.seat || f.seat_type || f.cabin_class || f.reason ? `<div class="card"><div class="card-title">${esc(t('flight.cabin'))}</div><div class="fkvs">
            ${row(t('flight.seat'), f.seat ? `<span class="mono">${esc(f.seat)}</span>` : '', true)}
            ${row(t('flight.seat_type'), f.seat_type ? t(`seat_type.${f.seat_type}`) : '')}
            ${row(t('flight.class'), f.cabin_class ? t(`cabin_class.${f.cabin_class}`) : '')}
            ${row(t('flight.reason'), f.reason ? t(`reason.${f.reason}`) : '')}</div></div>` : ''}
        <div class="card">
          <div class="card-title">${esc(t('flight_d.aircraft'))}${f.registration ? `<a href="#/airframe/${encodeURIComponent(f.registration)}">${esc(t('nav.airframe'))} →</a>` : ''}</div>
          <div class="row" style="gap:14px;align-items:center">
            <span class="fl-sil" data-sil></span>
            <div class="grow" style="min-width:0">
              ${f.registration ? `<b class="mono" style="font-size:20px">${esc(f.registration)}</b>` : `<span class="muted small">${esc(t('flight_d.no_reg'))}</span>`}
              <div class="small ellipsis">${esc(typeLabel || '—')}</div>
              ${cls !== 'unknown' ? `<div class="tiny muted">${esc(t(`cls.${cls}`))}</div>` : ''}
            </div>
          </div>
          ${f.spots?.length ? `<div class="tiny muted" style="margin:12px 0 6px">${esc(t('flight_d.spotted', { n: f.spots.length }))}</div>
            <div class="fl-spots">${f.spots.slice(0, 8).map((s) => `<a href="#/spots/${s.id_spotting}" class="tile ${s.thumb ? '' : 'noimg'}" title="${esc(`${s.airport || ''} · ${fmtDate(s.date, { time: false })}`)}">
              ${s.thumb ? `<img loading="lazy" src="${mediaUrl('thumbs', s.thumb)}" alt="">` : icon('camera', '', 16)}</a>`).join('')}</div>`
            : f.registration ? `<p class="tiny muted" style="margin:10px 0 0">${esc(t('flight_d.not_spotted'))}</p>` : ''}
          <div data-ext-photo></div>
        </div>
        <div class="fl-nav">
          ${C.prev ? `<a class="card" href="#/flights/${C.prev.id_flight}">${icon('chevron-left', '', 18)}<span><span class="tiny muted">${esc(t('flight_d.prev'))}</span><b class="mono">${esc(C.prev.dep_icao)} → ${esc(C.prev.arr_icao)}</b><span class="tiny muted">${esc(fmtDate(C.prev.date, { time: false }))}</span></span></a>` : '<span></span>'}
          ${C.next ? `<a class="card right" href="#/flights/${C.next.id_flight}"><span><span class="tiny muted">${esc(t('flight_d.next'))}</span><b class="mono">${esc(C.next.dep_icao)} → ${esc(C.next.arr_icao)}</b><span class="tiny muted">${esc(fmtDate(C.next.date, { time: false }))}</span></span>${icon('chevron-right', '', 18)}</a>` : '<span></span>'}
        </div>
      </div>
    </div>`;

  // Silhouette du type
  const sil = root.querySelector('[data-sil]');
  const { aircraftDataUrl } = await import('../lib/shapes.js');
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
  sil.innerHTML = `<img src="${aircraftDataUrl(cls, acc, 46)}" alt="">`;

  // Photo Planespotters si l'appareil n'a jamais été spotté
  if (f.registration && !f.spots?.some((s) => s.thumb)) {
    import('../lib/photos.js').then(async ({ planespottersPhoto, photoBlock }) => {
      const p = await planespottersPhoto({ reg: f.registration });
      const box = root.querySelector('[data-ext-photo]');
      if (p && box?.isConnected) box.innerHTML = `<div class="ac-photo" style="margin-top:12px">${photoBlock(p)}</div>`;
    });
  }

  // Carte
  const { createMap, greatCircle } = await import('../lib/map.js');
  const mapReady = (D.lat != null && A.lat != null) ? createMap(root.querySelector('[data-map]'), { scrollZoom: false }).then((m) => {
    const a = [D.lat, D.lng], b = [A.lat, A.lng];
    const arc = greatCircle(a, b, 96);
    m.lines('route', [{ coords: arc }], { width: 3 });
    m.marker(a, { kind: 'pin', label: D.iata || f.dep_icao, title: D.name });
    m.marker(b, { kind: 'pin', label: A.iata || f.arr_icao, title: A.name });
    m.fit(arc, { maxZoom: 7, padding: 60 });
    return m;
  }).catch(() => null) : Promise.resolve(null);
  if (D.lat == null || A.lat == null) root.querySelector('[data-map]').closest('.card').remove();

  root.querySelector('[data-img]').onclick = () => imageSheet(f, { typeLabel, cls, dist });
  root.querySelector('[data-more]').onclick = (e) => menu(e.currentTarget, [
    { icon: 'pencil', label: t('common.edit'), onClick: () => navigate(`#/flights/${f.id_flight}/edit`) },
    { icon: 'image', label: t('flight_d.image'), onClick: () => imageSheet(f, { typeLabel, cls, dist }) },
    { icon: 'link', label: t('flight_d.share_link'), onClick: async () => (await import('./shares.js')).createShareFlow({ kind: 'flight', target: String(f.id_flight), title: `${f.dep_icao} → ${f.arr_icao}` }) },
    f.registration && { icon: 'history', label: t('nav.airframe'), onClick: () => navigate(`#/airframe/${encodeURIComponent(f.registration)}`) },
    { icon: 'arrow-left-right', label: t('flight_d.return'), onClick: () => navigate(`#/flights/new?from=${f.id_flight}&return=1`) },
    { icon: 'copy', label: t('flight_d.duplicate'), onClick: () => navigate(`#/flights/new?from=${f.id_flight}`) },
    '-',
    { icon: 'trash-2', label: t('common.delete'), danger: true, onClick: async () => {
      if (!(await confirmDialog(esc(t('flight.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
      const r = await api(`/api/flights/${f.id_flight}`, { method: 'DELETE' }).catch(errorToast);
      if (r) undoToast(esc(t('common.deleted')), r.trash, { onUndo: () => navigate('#/flights') });
      navigate('#/flights');
    } },
  ]);
  return () => mapReady.then((m) => m?.remove());
}

// ------------------------------------------------------------------ export : carte d'embarquement
const PASS_FORMATS = { landscape: [1920, 960], portrait: [1080, 1350], story: [1080, 1920] };

function drawPass(c, W, H, f, opts) {
  const { typeLabel, cls, accent, ink, bg } = opts;
  const land = W > H;
  const u = Math.min(W, H) / (land ? 960 : 1080);
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  grain(c, W, H, 0.03);
  const m = 64 * u, x = m, w = W - m * 2;
  // En portrait, le billet prend la hauteur de son contenu et se centre (story comprise)
  const acLine0 = [f.registration, opts.typeLabel].filter(Boolean).join(' · ');
  const contentH = (110 + 110 + 180 + 80 + 4 * 112 + 20 + (acLine0 ? 120 : 0) + (opts.signature ? 50 : 0) + 210) * u;
  const h = land ? H - m * 2 : Math.min(H - m * 2, contentH);
  const y = (H - h) / 2;
  c.save(); c.shadowColor = 'rgba(0,0,0,.22)'; c.shadowBlur = 50 * u; c.shadowOffsetY = 18 * u;
  rrect(c, x, y, w, h, 36 * u); c.fillStyle = '#fff'; c.fill(); c.restore();
  // Bande supérieure
  const band = 110 * u;
  c.save(); rrect(c, x, y, w, h, 36 * u); c.clip();
  c.fillStyle = accent; c.fillRect(x, y, w, band);
  c.restore();
  c.fillStyle = '#fff'; c.font = `800 ${34 * u}px ${FONTS.sans}`;
  c.fillText(fit(c, `✈  ${(f.airline || 'CONTRAIL').toUpperCase()}`, w * 0.55), x + 44 * u, y + 70 * u);
  c.textAlign = 'right'; c.font = `600 ${24 * u}px ${FONTS.mono}`;
  c.fillText(t('story.boarding_pass').toUpperCase(), x + w - 44 * u, y + 68 * u); c.textAlign = 'left';
  const D = f.dep_info || {}, A = f.arr_info || {};
  const sub = rgba(ink, 0.5);
  const stubW = land ? w * 0.28 : 0;
  const mainW = w - stubW;
  const ix = x + 52 * u, iw = mainW - 104 * u;
  let yy = y + band + (land ? 90 : 110) * u;
  // Codes et villes
  const codeSize = (land ? 150 : 170) * u;
  c.fillStyle = ink; c.font = `800 ${codeSize}px ${FONTS.mono}`;
  const dc = D.iata || f.dep_icao, ac = A.iata || f.arr_icao;
  c.fillText(dc, ix, yy + codeSize * 0.75);
  c.textAlign = 'right'; c.fillText(ac, ix + iw, yy + codeSize * 0.75); c.textAlign = 'left';
  const dw = c.measureText(dc).width, aw = c.measureText(ac).width;
  // Avion entre les deux codes
  const mx1 = ix + dw + 30 * u, mx2 = ix + iw - aw - 30 * u, my = yy + codeSize * 0.42;
  if (mx2 - mx1 > 80 * u) {
    dashed(c, mx1, my, mx2, my, rgba(ink, 0.3), 3 * u, [10 * u, 10 * u]);
    c.save(); c.translate((mx1 + mx2) / 2, my); c.rotate(Math.PI / 2);
    c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 40 * u, 0, Math.PI * 2); c.fill();
    drawAircraft(c, cls === 'unknown' ? 'narrow' : cls, 64 * u, { fill: accent, outline: null }); c.restore();
  }
  yy += codeSize + 10 * u;
  c.fillStyle = sub; c.font = `600 ${26 * u}px ${FONTS.sans}`;
  c.fillText(fit(c, `${flagEmoji(D.country)} ${D.city || D.name || f.dep_icao}`, iw / 2 - 20 * u), ix, yy);
  c.textAlign = 'right'; c.fillText(fit(c, `${A.city || A.name || f.arr_icao} ${flagEmoji(A.country)}`, iw / 2 - 20 * u), ix + iw, yy); c.textAlign = 'left';
  yy += 70 * u;
  // Champs
  const cells = [
    [t('flight.date'), fmtDate(f.date, { time: false, short: true })], [t('flight.number'), f.flight_number || '—'],
    [t('flight.dep_time'), f.dep_time ? f.dep_time.slice(0, 5) : '—'], [t('flight.arr_time'), f.arr_time ? f.arr_time.slice(0, 5) : '—'],
    [t('flight.seat'), f.seat || '—'], [t('flight.class'), f.cabin_class ? t(`cabin_class.${f.cabin_class}`) : '—'],
    [t('flight_d.duration'), f.duration_min ? fmtDuration(f.duration_min) : '—'], [t('flight.distance'), opts.dist(f.distance_km)],
  ];
  const cols = land ? 4 : 2, cw = iw / cols, rh = (land ? 100 : 112) * u;
  cells.forEach(([l, v], i) => {
    const cx = ix + (i % cols) * cw, cy = yy + Math.floor(i / cols) * rh;
    c.fillStyle = sub; c.font = `600 ${20 * u}px ${FONTS.sans}`; c.fillText(fit(c, l.toUpperCase(), cw - 16 * u), cx, cy);
    c.fillStyle = ink; c.font = `700 ${fitSize(c, v, cw - 20 * u, 38 * u, 700, FONTS.mono, 16 * u)}px ${FONTS.mono}`; c.fillText(v, cx, cy + 46 * u);
  });
  yy += Math.ceil(cells.length / cols) * rh + 10 * u;
  // Appareil
  const acLine = [f.registration, typeLabel].filter(Boolean).join(' · ');
  if (acLine) {
    dashed(c, ix, yy, ix + iw, yy, rgba(ink, 0.2), 2 * u, [8 * u, 8 * u]);
    yy += 50 * u;
    c.fillStyle = sub; c.font = `600 ${20 * u}px ${FONTS.sans}`; c.fillText(t('flight_d.aircraft').toUpperCase(), ix, yy);
    c.fillStyle = ink; c.font = `700 ${32 * u}px ${FONTS.sans}`; c.fillText(fit(c, acLine, iw), ix, yy + 44 * u);
    yy += 70 * u;
  }
  if (opts.signature) { c.fillStyle = sub; c.font = `500 ${24 * u}px ${FONTS.sans}`; c.fillText(fit(c, `© ${opts.signature}`, iw), ix, yy + 20 * u); }
  // Talon (paysage) ou code-barres (portrait)
  if (land) {
    const sx = x + mainW;
    dashed(c, sx, y + band + 20 * u, sx, y + h - 20 * u, rgba(ink, 0.3), 3 * u, [12 * u, 10 * u]);
    c.fillStyle = bg;
    c.beginPath(); c.arc(sx, y, 26 * u, 0, Math.PI); c.fill();
    c.beginPath(); c.arc(sx, y + h, 26 * u, Math.PI, 0); c.fill();
    const tx = sx + 40 * u, tw = stubW - 80 * u;
    let ty = y + band + 80 * u;
    c.fillStyle = ink; c.font = `800 ${64 * u}px ${FONTS.mono}`;
    c.fillText(fit(c, `${dc} → ${ac}`, tw), tx, ty); ty += 70 * u;
    c.fillStyle = sub; c.font = `600 ${24 * u}px ${FONTS.sans}`;
    for (const l of [fmtDate(f.date, { time: false }), f.flight_number, f.seat && `${t('flight.seat')} ${f.seat}`].filter(Boolean)) { c.fillText(fit(c, l, tw), tx, ty); ty += 38 * u; }
    c.save(); c.translate(tx, y + h - 50 * u); c.rotate(-Math.PI / 2);
    barcode(c, 0, 0, h - band - 330 * u, tw * 0.5, `${f.dep_icao}${f.arr_icao}${f.date}`, ink); c.restore();
  } else {
    barcode(c, ix, y + h - 150 * u, iw, 90 * u, `${f.dep_icao}${f.arr_icao}${f.date}`, ink);
  }
  if (opts.brand) { c.fillStyle = rgba(ink, 0.4); c.font = `700 ${18 * u}px ${FONTS.sans}`; c.textAlign = 'right'; c.fillText('✈ CONTRAIL', x + mainW - 52 * u, y + h - 30 * u); c.textAlign = 'left'; }
}

async function imageSheet(f, info) {
  await loadFonts();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('contrail.flightpass') || '{}') || {}; } catch { saved = {}; }
  const o = { format: 'landscape', accent: '#1d4ed8', bg: '#dbe4f0', signature: '', brand: true, ...saved };
  const s = sheet({ title: esc(t('flight_d.image')), body: `
    <div class="fl-pass-prev"><canvas data-cv></canvas></div>
    <div class="seg" data-fmt style="margin-top:12px">${Object.keys(PASS_FORMATS).map((k) => `<button data-v="${k}">${esc(t(`story.f_${k}`))}</button>`).join('')}</div>
    <div class="color-row" style="grid-template-columns:repeat(2,1fr);margin-top:12px">
      <label class="color-pick"><input type="color" data-c="accent" value="${o.accent}"><span>${esc(t('story.c_accent'))}</span></label>
      <label class="color-pick"><input type="color" data-c="bg" value="${o.bg}"><span>${esc(t('story.c_bg'))}</span></label></div>
    <label class="field" style="margin-top:10px"><span>${esc(t('story.signature'))}</span><input data-sign value="${esc(o.signature)}" maxlength="40" placeholder="${esc(t('story.signature_ph'))}"></label>
    <div class="row wrap" style="margin-top:14px"><button class="btn primary grow" data-dl>${icon('download', '', 18)} ${esc(t('story.download'))}</button>
      ${navigator.canShare ? `<button class="btn" data-share>${icon('share-2', '', 18)}</button>` : ''}</div>` });
  const cv = s.body.querySelector('[data-cv]');
  const draw = () => {
    const [W, H] = PASS_FORMATS[o.format] || PASS_FORMATS.landscape;
    cv.width = W; cv.height = H;
    drawPass(cv.getContext('2d'), W, H, f, { ...info, accent: o.accent, bg: o.bg, ink: '#0f172a', signature: o.signature, brand: o.brand });
    s.body.querySelectorAll('[data-fmt] button').forEach((b) => b.classList.toggle('on', b.dataset.v === o.format));
    try { localStorage.setItem('contrail.flightpass', JSON.stringify(o)); } catch { /* stockage indisponible */ }
  };
  s.body.querySelectorAll('[data-fmt] button').forEach((b) => (b.onclick = () => { o.format = b.dataset.v; draw(); }));
  s.body.querySelectorAll('[data-c]').forEach((i) => (i.oninput = () => { o[i.dataset.c] = i.value; draw(); }));
  s.body.querySelector('[data-sign]').oninput = (e) => { o.signature = e.target.value; draw(); };
  const fname = () => `vol-${f.dep_icao}-${f.arr_icao}-${f.date.slice(0, 10)}.png`;
  s.body.querySelector('[data-dl]').onclick = async () => {
    const b = await canvasBlob(cv);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = fname(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  s.body.querySelector('[data-share]')?.addEventListener('click', async () => {
    const file = new File([await canvasBlob(cv)], fname(), { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: `${f.dep_icao} → ${f.arr_icao}` }).catch(() => {});
    else toast(esc(t('story.share_unsupported')), { type: 'warn' });
  });
  draw();
}
