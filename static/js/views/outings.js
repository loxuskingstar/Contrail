// Sorties de spotting : une journée sur un site, regroupant automatiquement les spots
import { api, mediaUrl } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, debounce } from '../ui.js';

const PAGE = 30;

/** Libellé d'une sortie : son nom, sinon le site. */
export const outingSite = (o) => o.airport
  ? `${o.airport}${o.airport_info?.city ? ` · ${o.airport_info.city}` : ''}`
  : (o.place || '—');
export const outingTitle = (o) => o.name || outingSite(o);

export async function render(root, _params, query = {}) {
  const filters = { year: query.year || '', airport: query.airport || '', search: '' };
  let items = [], total = 0, years = [], done = false, loading = false, gen = 0;
  root.innerHTML = `${pageHead(esc(t('outing.title')), { sub: `<span data-count></span>` })}
    <div class="stack" style="gap:10px;margin-bottom:14px">
      <div class="search">${icon('search', '', 18)}<input class="input" type="search" data-q placeholder="${esc(t('outing.search_ph'))}" autocomplete="off"></div>
      <div class="chips scroll" data-years></div>
      ${filters.airport ? `<div class="chips"><button class="chip on" data-noap>${icon('x', '', 14)} ${esc(filters.airport)}</button></div>` : ''}
    </div>
    <div data-list class="stack" style="gap:10px"></div><div data-more style="height:1px"></div>`;
  const list = root.querySelector('[data-list]');

  const card = (o) => `<a class="card outing" href="#/outings/${o.id}">
    <div class="o-thumbs">${o.thumbs.length ? o.thumbs.map((th) => `<img loading="lazy" src="${mediaUrl('thumbs', th)}" alt="">`).join('')
      : `<div class="o-ph">${icon('camera', '', 26)}</div>`}</div>
    <div class="o-body">
      <div class="ttl">${esc(outingTitle(o))}</div>
      <div class="meta">${esc(fmtDate(o.day, { time: false, weekday: true }))}${o.name ? ` · ${esc(outingSite(o))}` : ''}</div>
      <div class="o-stats"><span>${icon('camera', '', 14)} ${esc(t('outing.n_spots', { n: o.n }))}</span>
        <span>${icon('plane', '', 14)} ${esc(t('outing.n_aircraft', { n: o.regs }))}</span>
        ${o.new_regs ? `<span class="o-new">${icon('sparkles', '', 14)} ${esc(t('outing.n_new', { n: o.new_regs }))}</span>` : ''}
        ${o.specials ? `<span>${icon('palette', '', 14)} ${o.specials}</span>` : ''}${o.military ? `<span>${icon('shield', '', 14)} ${o.military}</span>` : ''}</div>
    </div></a>`;

  async function load(reset) {
    if (reset) { items = []; done = false; list.innerHTML = ''; gen++; }
    if (loading || done) return;
    loading = true;
    const my = gen;
    try {
      const res = await api('/api/outings', { query: { ...filters, limit: PAGE, offset: items.length } });
      if (my !== gen) return;
      total = res.total; years = res.years;
      items.push(...res.items);
      done = items.length >= total || !res.items.length;
      list.insertAdjacentHTML('beforeend', res.items.map(card).join(''));
      if (!items.length) list.innerHTML = `<div class="card">${emptyState('calendar-days', t('outing.empty'), t('outing.empty_text'))}</div>`;
      root.querySelector('[data-count]').textContent = t('outing.count', { n: total, nf: fmtNum(total) });
      const box = root.querySelector('[data-years]');
      box.innerHTML = `<button class="chip ${!filters.year ? 'on' : ''}" data-y="">${esc(t('common.all'))}</button>${years.map((y) => `<button class="chip ${filters.year === y ? 'on' : ''}" data-y="${y}">${y}</button>`).join('')}`;
      box.querySelectorAll('[data-y]').forEach((b) => (b.onclick = () => { filters.year = b.dataset.y; load(true); }));
    } catch (e) { errorToast(e); done = true; } finally { loading = false; }
  }
  root.querySelector('[data-q]').addEventListener('input', debounce((e) => { filters.search = e.target.value; load(true); }, 250));
  root.querySelector('[data-noap]')?.addEventListener('click', () => { filters.airport = ''; location.hash = '#/outings'; });
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '600px' });
  io.observe(root.querySelector('[data-more]'));
  await load(true);
  return () => io.disconnect();
}
