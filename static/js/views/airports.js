// Liste des aéroports où des spots ont été pris, triés par fréquentation
import { api } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, debounce, regFlag } from '../ui.js';

export async function render(root) {
  let items = [];
  try { items = (await api('/api/airport-pages')).items; } catch (e) { errorToast(e); }
  if (!items.length) { root.innerHTML = pageHead(esc(t('airport.title'))) + `<div class="card">${emptyState('map-pin', t('airport.empty'), t('airport.empty_text'))}</div>`; return; }
  root.innerHTML = `${pageHead(esc(t('airport.title')), { sub: esc(t('airport.count', { n: items.length, nf: fmtNum(items.length) })) })}
    <div class="search" style="margin-bottom:12px">${icon('search', '', 18)}<input class="input" type="search" data-q placeholder="${esc(t('airport.search_ph'))}" autocomplete="off"></div>
    <div class="card" style="padding:6px" data-list></div>`;
  const list = root.querySelector('[data-list]');
  const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const draw = (term = '') => {
    const k = fold(term);
    const rows = items.filter((a) => !k || fold(`${a.icao} ${a.iata || ''} ${a.name || ''} ${a.city || ''}`).includes(k));
    list.innerHTML = rows.map((a) => `<a class="list-row" href="#/airports/${esc(a.icao)}">
      <span class="mono" style="min-width:48px"><b>${esc(a.icao)}</b></span>
      <span class="grow ellipsis">${a.country ? regFlag(a.country) + ' ' : ''}${esc(a.name || a.city || '')}<span class="small muted" style="display:block">${esc(t('airport.row', { regs: a.regs, last: a.last_at ? fmtDate(a.last_at, { time: false }) : '' }))}</span></span>
      <span class="badge">${fmtNum(a.n)}×</span>${icon('chevron-right', '', 16)}</a>`).join('') || `<p class="muted" style="padding:14px">${esc(t('common.no_results'))}</p>`;
  };
  draw();
  root.querySelector('[data-q]').addEventListener('input', debounce((e) => draw(e.target.value), 150));
}
