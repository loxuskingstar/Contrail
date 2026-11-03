// Statistiques avancées : collection, matériel photo (EXIF), vols
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, fmtMonth, fmtDate, fmtDuration, countryName, flag, locale } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, hbars, vbars, emptyState } from '../ui.js';

export async function render(root, _p, query) {
  let tab = query.tab || 'spotting';
  let year = query.year || '';
  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.stats'))}</h1><div class="sub" data-sub>&nbsp;</div></div>
      <div class="actions"><select class="select" data-year style="width:auto;border-radius:999px"></select></div></header>
    <div class="seg" style="margin-bottom:16px">
      <button data-tab="spotting">${icon('camera', '', 16)} ${esc(t('stats.tab_spotting'))}</button>
      <button data-tab="gear">${icon('scan-line', '', 16)} ${esc(t('stats.tab_gear'))}</button>
      ${store.mod('flights') ? `<button data-tab="flights">${icon('ticket', '', 16)} ${esc(t('stats.tab_flights'))}</button>` : ''}
    </div>
    <div data-body><div class="skeleton" style="height:400px"></div></div>`;
  const body = root.querySelector('[data-body]');
  const yearSel = root.querySelector('[data-year]');

  async function load() {
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    history.replaceState(null, '', `#/stats?tab=${tab}${year ? `&year=${year}` : ''}`);
    if (tab === 'flights') return drawFlights(await api('/api/stats/flights', { query: { year } }));
    const s = await api('/api/stats', { query: { year } });
    if (!yearSel.options.length) {
      yearSel.innerHTML = `<option value="">${esc(t('stats.all_time'))}</option>` + s.years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('');
    }
    root.querySelector('[data-sub]').textContent = s.first ? t('stats.since', { date: fmtDate(s.first.date, { time: false }) }) : '';
    if (!s.totals.spots) { body.innerHTML = `<div class="card">${emptyState('chart-column', t('stats.empty'))}</div>`; return; }
    tab === 'gear' ? drawGear(s) : drawSpotting(s);
  }

  function kpis(list) {
    return `<div class="grid kpis" style="margin-bottom:14px">${list.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`;
  }

  function drawSpotting(s) {
    const T = s.totals;
    const wd = [1, 2, 3, 4, 5, 6, 0];
    const wdNames = wd.map((d) => new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + d)));
    const wdMap = Object.fromEntries(s.by_weekday.map((r) => [r.k, r.n]));
    const hourMap = Object.fromEntries(s.by_hour.map((r) => [r.k, r.n]));
    const months = year ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((k) => ({ k, n: s.by_month.find((m) => m.k === k)?.n || 0 })) : s.by_month.slice(-24);
    body.innerHTML = `
      ${kpis([
        ['camera', fmtNum(T.spots), t('stat.spots')], ['scan-line', fmtNum(T.registrations), t('stat.regs')],
        ['plane', fmtNum(T.types), t('stat.types')], ['building-2', fmtNum(T.airlines), t('stat.airlines')],
        ['map-pin', fmtNum(T.airports), t('stat.airports')], ['flag', fmtNum(T.countries), t('stat.countries')],
        ['palette', fmtNum(T.special_liveries), t('stat.liveries')], ['calendar', fmtNum(T.days), t('stat.days')],
      ])}
      <div class="grid two">
        <div class="card"><div class="card-title">${esc(t('stats.top_regs'))}</div>
          <div class="list">${s.top_registrations.map((r, i) => `<a class="list-row" href="#/airframe/${encodeURIComponent(r.k)}" style="padding:7px 6px">
            <b class="muted num" style="width:20px">${i + 1}</b>${r.thumb ? `<img class="thumb" style="width:56px;height:40px" src="${mediaUrl('thumbs', r.thumb)}" alt="">` : ''}
            <div class="grow"><b class="mono">${esc(r.k)}</b><div class="meta ellipsis">${esc([r.aircraft, r.owner].filter(Boolean).join(' · '))}</div></div><span class="badge accent">${r.n}×</span></a>`).join('')}</div></div>
        <div class="card"><div class="card-title">${esc(t('stats.top_airports'))}</div>${hbars(s.top_airports, { label: (r) => `<span class="mono">${esc(r.k)}</span> <span class="muted">${esc(r.name || '')}</span>`, href: (r) => `#/spots?airport=${r.k}` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_types'))}</div>${hbars(s.top_types, { label: (r) => esc(r.k), href: (r) => `#/spots?type=${encodeURIComponent(r.k)}` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_airlines'))}</div>${hbars(s.top_airlines, { label: (r) => esc(r.label || r.k), href: (r) => `#/fleets/${encodeURIComponent(r.k)}` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_countries'))}</div>${hbars(s.top_countries, { label: (r) => `${flag(r.k)} ${esc(countryName(r.k))}`, href: (r) => `#/spots?country=${r.k}` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.manufacturers'))}</div>${hbars(s.manufacturers, { label: (r) => esc(r.k) })}</div>
      </div>
      ${s.calendar ? calendar(s.calendar, s.streak, s.best_day) : ''}
      <div class="card" style="margin-top:14px"><div class="card-title">${esc(t('stats.by_month'))}</div>${vbars(months, { label: (r) => fmtMonth(r.k) })}</div>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><div class="card-title">${esc(t('stats.by_hour'))}</div>${vbars(Array.from({ length: 24 }, (_, h) => ({ k: `${h} h`, n: hourMap[h] || 0 })), { every: 3 })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.by_weekday'))}</div>${vbars(wd.map((d, i) => ({ k: wdNames[i], n: wdMap[d] || 0 })))}</div>
      </div>
      ${!year && s.by_year.length > 1 ? `<div class="card" style="margin-top:14px"><div class="card-title">${esc(t('stats.by_year'))}</div>${vbars(s.by_year)}</div>` : ''}
      <div class="grid two" style="margin-top:14px">
        ${s.top_tags.length ? `<div class="card"><div class="card-title">${esc(t('spot.tags'))}</div>${hbars(s.top_tags, { label: (r) => `<span class="legend-dot" style="background:${esc(r.color)}"></span> ${esc(r.k)}` })}</div>` : ''}
        ${s.flight_types.length ? `<div class="card"><div class="card-title">${esc(t('spot.flight_type'))}</div>${hbars(s.flight_types, { label: (r) => esc(t(`ftype.${r.k}`)) })}</div>` : ''}
        ${s.best_day ? `<div class="card kpi">${icon('zap')}<div class="v">${s.best_day.n}</div><div class="l">${esc(t('stats.best_day', { date: fmtDate(s.best_day.k, { time: false }) }))}</div></div>` : ''}
      </div>`;
  }

  function drawGear(s) {
    if (!s.gear.length) { body.innerHTML = `<div class="card">${emptyState('camera', t('stats.no_gear'), t('stats.no_gear_text'))}</div>`; return; }
    const best = s.gear[0];
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px;display:flex;gap:16px;align-items:center">
        ${icon('trophy', '', 40)}<div><div class="card-title" style="margin-bottom:4px">${esc(t('stats.best_combo'))}</div>
        <div style="font-size:19px;font-weight:720">${esc(best.camera)}${best.lens ? ` + ${esc(best.lens)}` : ''}</div>
        <div class="muted small">${esc(t('stats.combo_detail', { n: best.n, r: best.regs }))}</div></div></div>
      <div class="card"><div class="card-title">${esc(t('stats.combos'))}</div><div class="scroll-x"><table class="tbl"><thead><tr><th>${esc(t('exif.camera'))}</th><th>${esc(t('exif.lens'))}</th><th>${esc(t('stat.spots'))}</th><th>${esc(t('stat.regs'))}</th></tr></thead>
        <tbody>${s.gear.map((g) => `<tr><td><a href="#/spots?camera=${encodeURIComponent(g.camera)}"><b>${esc(g.camera)}</b></a></td><td>${g.lens ? `<a href="#/spots?lens=${encodeURIComponent(g.lens)}">${esc(g.lens)}</a>` : '<span class="muted">—</span>'}</td><td class="num">${g.n}</td><td class="num">${g.regs}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="grid two" style="margin-top:14px">
        <div class="card"><div class="card-title">${esc(t('stats.cameras'))}</div>${hbars(s.cameras, { label: (r) => esc(r.k) })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.lenses'))}</div>${hbars(s.lenses, { label: (r) => esc(r.k) })}</div>
      </div>
      <div class="card" style="margin-top:14px"><div class="card-title">${esc(t('stats.focal'))}</div>${vbars(s.focal, { label: (r) => r.k, unit: '' })}<p class="tiny muted" style="margin-top:6px">mm</p></div>`;
  }

  function drawFlights(f) {
    if (!yearSel.options.length) yearSel.innerHTML = `<option value="">${esc(t('stats.all_time'))}</option>`;
    if (!f.count) { body.innerHTML = `<div class="card">${emptyState('ticket', t('flight.empty'))}</div>`; return; }
    body.innerHTML = `
      ${kpis([
        ['ticket', fmtNum(f.count), t('stat.flights_l')], ['route', `${fmtNum(f.km)} km`, t('flight.distance')],
        ['clock', f.minutes ? fmtDuration(f.minutes) : '—', t('flight.time')], ['map-pin', fmtNum(f.airports), t('stat.airports')],
        ['globe', fmtNum(f.earth_laps, { maximumFractionDigits: 2 }), t('flight.laps')], ['moon', `${fmtNum(f.moon_pct, { maximumFractionDigits: 1 })} %`, t('flight.to_moon')],
      ])}
      <div class="grid two">
        <div class="card"><div class="card-title">${esc(t('stats.top_routes'))}</div>${hbars(f.top_routes, { label: (r) => `<span class="mono">${esc(r.k)}</span>` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_airports'))}</div>${hbars(f.top_airports, { label: (r) => `<span class="mono">${esc(r.k)}</span> <span class="muted">${esc(r.name || '')}</span>` })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_airlines'))}</div>${hbars(f.top_airlines, { label: (r) => esc(r.k) })}</div>
        <div class="card"><div class="card-title">${esc(t('stats.top_types'))}</div>${hbars(f.top_types, { label: (r) => esc(r.k) })}</div>
        ${f.seat_types.length ? `<div class="card"><div class="card-title">${esc(t('flight.seat_type'))}</div>${hbars(f.seat_types, { label: (r) => esc(t(`seat_type.${r.k}`)) })}</div>` : ''}
        ${f.classes.length ? `<div class="card"><div class="card-title">${esc(t('flight.class'))}</div>${hbars(f.classes, { label: (r) => esc(t(`cabin_class.${r.k}`)) })}</div>` : ''}
      </div>
      <div class="grid two" style="margin-top:14px">
        <a class="card kpi" href="#/flights/${f.longest.id_flight}/edit">${icon('arrow-up')}<div class="v mono" style="font-size:20px">${esc(f.longest.dep_icao)} → ${esc(f.longest.arr_icao)}</div><div class="l">${esc(t('stats.longest'))} · ${fmtNum(f.longest.distance_km)} km</div></a>
        ${f.shortest ? `<a class="card kpi" href="#/flights/${f.shortest.id_flight}/edit">${icon('arrow-down')}<div class="v mono" style="font-size:20px">${esc(f.shortest.dep_icao)} → ${esc(f.shortest.arr_icao)}</div><div class="l">${esc(t('stats.shortest'))} · ${fmtNum(f.shortest.distance_km)} km</div></a>` : ''}
      </div>
      ${f.by_year.length > 1 ? `<div class="card" style="margin-top:14px"><div class="card-title">${esc(t('stats.by_year'))}</div>${vbars(f.by_year)}</div>` : ''}`;
  }

  root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; body.innerHTML = '<div class="skeleton" style="height:400px"></div>'; load(); }));
  yearSel.onchange = () => { year = yearSel.value; load(); };
  await load();
}


// ------------------------------------------------------------------ calendrier d'activité
function calendar(cal, streak, best) {
  const from = new Date(`${cal.from}T00:00`), to = new Date(`${cal.to}T00:00`);
  // La grille commence un lundi
  const start = new Date(from);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const vals = Object.values(cal.days).filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (n) => (!n ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const weeks = [];
  const months = [];
  for (let d = new Date(start), w = 0; d <= to; w++) {
    const col = [];
    for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
      const k = iso(d);
      const inRange = d >= from && d <= to;
      if (d.getDate() === 1 && inRange) months.push({ w, label: fmtMonth(k.slice(0, 7)) });
      col.push(inRange ? { k, n: cal.days[k] || 0 } : null);
    }
    weeks.push(col);
  }
  if (!months.length || months[0].w > 1) months.unshift({ w: 0, label: fmtMonth(cal.from.slice(0, 7)) });
  const wd = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(), { weekday: 'narrow' }).format(new Date(2024, 0, 1 + i)));
  const st = streak || {};
  return `<div class="card" style="margin-top:14px">
    <div class="card-title">${esc(t('stats.calendar'))}</div>
    <div class="cal-kpis">
      <div><b>${fmtNum(st.active_days || 0)}</b><span>${esc(t('stats.active_days'))}</span></div>
      <div><b>${fmtNum(st.longest || 0)}</b><span>${esc(t('stats.longest_streak'))}</span>${st.longest > 1 ? `<small>${esc(fmtDate(st.longest_from, { time: false, short: true }))} → ${esc(fmtDate(st.longest_to, { time: false, short: true }))}</small>` : ''}</div>
      ${st.current != null ? `<div><b>${fmtNum(st.current || 0)}</b><span>${esc(t('stats.current_streak'))}</span></div>` : ''}
      ${best ? `<div><b>${fmtNum(best.n)}</b><span>${esc(t('stats.best_day_l'))}</span><small>${esc(fmtDate(best.k, { time: false, short: true }))}</small></div>` : ''}
    </div>
    <div class="cal-scroll"><div class="cal" style="--weeks:${weeks.length}">
      <div class="cal-months">${months.map((m) => `<span style="grid-column:${m.w + 2}">${esc(m.label)}</span>`).join('')}</div>
      <div class="cal-wd">${wd.map((x, i) => `<span>${i % 2 === 0 ? esc(x) : ''}</span>`).join('')}</div>
      <div class="cal-grid">${weeks.map((col) => col.map((c) => (c ? `<a class="l${level(c.n)}" href="#/spots?search=${c.k}" title="${esc(`${fmtDate(c.k, { time: false, weekday: true })} · ${t('dash.n_spots', { n: c.n })}`)}"></a>` : '<i></i>')).join('')).join('')}</div>
    </div></div>
    <div class="cal-legend tiny muted"><span>${esc(t('stats.less'))}</span>${[0, 1, 2, 3, 4].map((l) => `<i class="l${l}"></i>`).join('')}<span>${esc(t('stats.more'))}</span></div>
  </div>`;
}
