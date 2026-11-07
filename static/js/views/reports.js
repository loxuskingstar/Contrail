// Bilan d'une année : chiffres, premières, classements, meilleures photos (imprimable)
import { api, mediaUrl } from '../api.js';
import { t, fmtNum, fmtDate, flag, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, regText } from '../ui.js';

export async function render(root, { year } = {}) {
  let years;
  try { years = (await api('/api/reports/years')).years; } catch (e) { errorToast(e); return; }
  if (!years.length) { root.innerHTML = pageHead(esc(t('report.title'))) + `<div class="card">${emptyState('file-text', t('report.empty'), '')}</div>`; return; }
  const y = year && years.includes(String(year)) ? String(year) : years[0];
  let r;
  try { r = await api(`/api/reports/year/${y}`); } catch (e) { errorToast(e); return; }
  const sel = `<select class="input" data-year style="width:auto">${years.map((v) => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const tt = r.totals, pv = r.previous;
  const delta = (cur, prev) => {
    if (!pv || prev === undefined || prev === null) return '';
    const key = cur > prev ? 'report.vs_up' : cur < prev ? 'report.vs_down' : 'report.vs_same';
    return `<div class="tiny ${cur >= prev ? 'good' : 'muted'}" style="margin-top:2px">${esc(t(key, { n: Math.abs(cur - prev), y: r.year - 1 }))}</div>`;
  };
  const kpi = (ic, v, l, extra = '') => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div>${extra}</div>`;
  const maxM = Math.max(1, ...r.months);
  const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(document.documentElement.lang || 'fr', { month: 'short' }).format(new Date(2000, i, 1)));
  const list = (items, fmt) => items.length ? `<div class="stack" style="gap:6px">${items.map((x, i) => {
    const w = Math.round((x.n / items[0].n) * 100);
    return `<div style="position:relative;border-radius:8px;overflow:hidden;background:var(--surface-2)"><div style="position:absolute;inset:0;width:${w}%;background:rgb(var(--accent-rgb) / .16)"></div>
      <div class="row between" style="position:relative;padding:6px 10px;gap:8px"><span class="ellipsis small"><b>${i + 1}.</b> ${fmt(x)}</span><b class="small">${fmtNum(x.n)}</b></div></div>`;
  }).join('')}</div>` : `<p class="small muted">—</p>`;
  const firsts = (items, fmt) => items.length ? `<div class="chips">${items.slice(0, 14).map((x) => `<a class="chip" href="#/spots/${x.id}">${fmt(x)}</a>`).join('')}${items.length > 14 ? `<span class="chip">+${items.length - 14}</span>` : ''}</div>` : `<p class="small muted">${esc(t('report.none'))}</p>`;
  const card = (ic, title, body) => `<div class="card"><div class="card-title">${icon(ic, '', 18)} ${esc(title)}</div>${body}</div>`;
  const ap = (x) => `${x.country ? flag(x.country) + ' ' : ''}${esc(x.label || x.k)} <span class="muted">${esc(x.k)}</span>`;

  root.innerHTML = `${pageHead(esc(t('report.title', { y })), { sub: esc(t('report.sub', { spots: tt.spots, days: tt.days })), actions: `${sel}<button class="btn" data-print data-noprint>${icon('file-text', '', 16)} ${esc(t('report.print'))}</button>` })}
    <div class="grid kpis" style="margin-bottom:14px">${kpi('camera', tt.spots, t('outing.k_spots'), delta(tt.spots, pv?.spots))}${kpi('plane', tt.types, t('report.k_types'), delta(tt.types, pv?.types))}
      ${kpi('tag', tt.regs, t('report.k_regs'))}${kpi('building-2', tt.airlines, t('report.k_airlines'))}${kpi('map-pin', tt.airports, t('report.k_airports'), delta(tt.airports, pv?.airports))}${kpi('globe', tt.countries, t('report.k_countries'))}
      ${kpi('calendar-days', tt.days, t('report.k_days'))}${kpi('star', tt.favorites || 0, t('report.k_fav'))}</div>
    <div class="card" style="margin-bottom:14px"><div class="card-title">${icon('chart-column', '', 18)} ${esc(t('report.by_month'))}</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:110px">${r.months.map((n, i) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%" title="${MONTHS[i]}: ${n}">
        <span class="tiny muted">${n || ''}</span><div style="width:100%;max-width:34px;border-radius:4px 4px 0 0;background:var(--accent);height:${n ? Math.max(4, Math.round(n / maxM * 70)) : 2}px;opacity:${n ? 1 : .25}"></div><span class="tiny muted">${esc(MONTHS[i])}</span></div>`).join('')}</div>
      ${r.best_day ? `<p class="small muted" style="margin:10px 0 0">${icon('trophy', '', 14)} ${esc(t('report.best_day', { date: fmtDate(r.best_day.day, { time: false }), n: r.best_day.n, where: r.best_day.airport || '' }))}</p>` : ''}</div>
    <div class="grid two" style="margin-bottom:14px">
      ${card('sparkles', t('report.first_types', { n: r.firsts.types.length }), firsts(r.firsts.types, (x) => esc(x.label || x.k)))}
      ${card('building-2', t('report.first_airlines', { n: r.firsts.airlines.length }), firsts(r.firsts.airlines, (x) => esc(x.label || x.k)))}
      ${card('map-pin', t('report.first_airports', { n: r.firsts.airports.length }), firsts(r.firsts.airports, (x) => esc(x.k)))}
      ${card('globe', t('report.first_countries', { n: r.firsts.countries.length }), firsts(r.firsts.countries, (x) => `${flag(x.k)} ${esc(countryName(x.k))}`))}</div>
    <div class="grid two" style="margin-bottom:14px">
      ${card('plane', t('report.top_types'), list(r.top.types, (x) => esc(x.label || x.k)))}
      ${card('building-2', t('report.top_airlines'), list(r.top.airlines, (x) => esc(x.label || x.k)))}
      ${card('map-pin', t('report.top_airports'), list(r.top.airports, ap))}
      ${card('globe', t('report.top_countries'), list(r.top.countries, (x) => `${flag(x.k)} ${esc(countryName(x.k))}`))}</div>
    ${r.photos.length ? `<div class="card" style="margin-bottom:14px"><div class="card-title">${icon('image', '', 18)} ${esc(t('report.best_photos'))}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">${r.photos.map((p) => `<a href="#/spots/${p.id}" style="display:block"><div style="aspect-ratio:3/2;border-radius:10px;overflow:hidden;background:var(--surface-2)"><img src="${mediaUrl('thumbs', p.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>
        <div class="small mono" style="margin-top:4px">${esc(regText(p.registration))}${p.favorite ? ' ★' : ''}</div></a>`).join('')}</div></div>` : ''}
    ${r.special.length ? card('paint-bucket', t('report.special'), `<div class="chips">${r.special.map((x) => `<a class="chip" href="#/spots/${x.id}">${esc(regText(x.registration))} · ${esc(x.livery || x.aircraft || '')}</a>`).join('')}</div>`) : ''}`;
  root.querySelector('[data-year]').onchange = (e) => { location.hash = `#/reports/${e.target.value}`; };
  root.querySelector('[data-print]').onclick = () => window.print();
}
