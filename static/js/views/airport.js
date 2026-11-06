// Fiche d'un aéroport : chiffres, saisonnalité, types et compagnies, points de vue, sorties, derniers spots
import { api } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, spotRow, regFlag } from '../ui.js';
import { outingTitle } from './outings.js';

const MONTHS = [...Array(12)].map((_, i) => new Date(2000, i, 1));

function bars(rows, key, label) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div style="display:flex;align-items:flex-end;gap:4px;height:90px">${rows.map((r) =>
    `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%" title="${esc(label(r))}: ${r.n}">
      <div style="width:100%;max-width:26px;border-radius:4px 4px 0 0;background:var(--accent);opacity:${r.n ? 1 : .15};height:${Math.max(r.n ? 4 : 2, Math.round(r.n / max * 66))}px"></div>
      <span class="small muted" style="font-size:10px">${esc(String(key(r)))}</span></div>`).join('')}</div>`;
}

export async function render(root, { id }) {
  const code = decodeURIComponent(id);
  const a = await api(`/api/airport-pages/${encodeURIComponent(code)}`);
  const info = a.info || {};
  const title = info.name || a.icao;
  if (!a.n) {
    root.innerHTML = pageHead(esc(title), { sub: esc([a.icao, info.city].filter(Boolean).join(' · ')) }) +
      `<div class="card muted">${esc(t('airport.none_here'))}</div>`;
    return;
  }
  const months = MONTHS.map((d, i) => ({ m: i + 1, n: (a.by_month.find((x) => x.m === i + 1) || {}).n || 0, d }));
  const monthName = (r) => r.d.toLocaleDateString(document.documentElement.lang || undefined, { month: 'long' });
  const kpis = [['camera', a.n, t('outing.k_spots')], ['plane', a.regs, t('outing.k_aircraft')], ['layers', a.types, t('outing.k_types')],
    ['calendar-days', a.n_outings, t('nav.outings')], a.specials ? ['palette', a.specials, t('outing.k_special')] : null,
    a.military ? ['shield', a.military, t('outing.k_military')] : null].filter(Boolean);
  const chip = (href, label, n) => `<a class="chip" href="${href}">${esc(label)} · ${n}</a>`;
  root.innerHTML = `${pageHead(esc(title), {
      sub: `<span class="mono">${esc(a.icao)}${info.iata ? ` / ${esc(info.iata)}` : ''}</span>${info.city ? ` · ${info.country ? regFlag(info.country) + ' ' : ''}${esc(info.city)}` : ''} · ${esc(t('airport.since', { a: fmtDate(a.first_at, { time: false }) }))}`,
      actions: `<a class="btn" href="#/spots?airport=${esc(a.icao)}">${icon('list', '', 16)} ${esc(t('outing.open_list'))}</a>` })}
    <div class="grid kpis" style="margin-bottom:14px">${kpis.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
    <div class="card" style="margin-bottom:14px"><b>${esc(t('airport.season'))}</b><div style="margin-top:10px">${bars(months, (r) => r.d.toLocaleDateString(document.documentElement.lang || undefined, { month: 'narrow' }), monthName)}</div></div>
    ${a.by_year.length > 1 ? `<div class="card" style="margin-bottom:14px"><b>${esc(t('airport.by_year'))}</b><div style="margin-top:10px">${bars(a.by_year, (r) => r.k.slice(2), (r) => r.k)}</div></div>` : ''}
    <div class="section"><h2>${esc(t('airport.top'))}</h2></div>
    <div class="chips" style="margin-bottom:8px">${a.top_types.map((x) => chip(`#/spots?airport=${esc(a.icao)}&type=${encodeURIComponent(x.k)}`, x.k, x.n)).join('')}</div>
    <div class="chips" style="margin-bottom:14px">${a.top_airlines.map((x) => chip(`#/spots?airport=${esc(a.icao)}&search=${encodeURIComponent(x.k)}`, x.k, x.n)).join('')}</div>
    ${a.locations.length ? `<div class="section"><h2>${esc(t('nav.locations'))}</h2></div><div class="card" style="padding:6px;margin-bottom:14px">${a.locations.map((l) =>
      `<a class="list-row" href="#/locations">${icon('map-pin', '', 18)}<span class="grow ellipsis"><b>${esc(l.name)}</b>${l.best_time ? `<span class="small muted" style="display:block">${esc(l.best_time)}</span>` : ''}</span>${l.view_bearing != null ? `<span class="badge accent">${icon('navigation', '', 12)} ${Math.round(l.view_bearing)}°</span>` : ''}<span class="badge">${l.n}×</span></a>`).join('')}</div>` : ''}
    ${a.outings.length ? `<div class="section"><h2>${esc(t('nav.outings'))}</h2></div><div class="card" style="padding:6px;margin-bottom:14px">${a.outings.map((o) =>
      `<a class="list-row" href="#/outings/${o.id}">${icon('calendar-days', '', 18)}<span class="grow ellipsis"><b>${esc(o.name || fmtDate(o.day, { time: false, weekday: true }))}</b>${o.name ? `<span class="small muted" style="display:block">${esc(fmtDate(o.day, { time: false }))}</span>` : ''}</span><span class="badge">${esc(t('outing.n_spots', { n: o.n }))}</span></a>`).join('')}</div>` : ''}
    <div class="section"><h2>${esc(t('airport.recent'))}</h2></div>
    <div class="card" style="padding:6px">${a.recent.map((s) => spotRow(s)).join('')}</div>`;
}
