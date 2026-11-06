// Sorties de spotting : une journée (ou un meeting sur plusieurs jours) sur un site, regroupant automatiquement les spots
import { api, mediaUrl } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput } from '../lib/fields.js';
import { esc, pageHead, emptyState, errorToast, debounce, sheet, toast } from '../ui.js';

const PAGE = 30;

/** Libellé d'une sortie : son nom, sinon le site. */
export const outingSite = (o) => o.airport
  ? `${o.airport}${o.airport_info?.city ? ` · ${o.airport_info.city}` : ''}`
  : (o.place || '—');
export const outingTitle = (o) => o.name || outingSite(o);

/** « sam. 6 juin » ou « 6 – 8 juin 2031 » pour une sortie de plusieurs jours. */
export function outingDates(o, { weekday = true } = {}) {
  if (!o.end_day) return fmtDate(o.day, { time: false, weekday });
  return `${fmtDate(o.day, { time: false, short: true })} → ${fmtDate(o.end_day, { time: false, short: true })}`;
}

/** Feuille de planification d'un meeting (avant l'événement : les spots viendront s'y ranger tout seuls). */
export function planSheet(onDone) {
  const today = new Date().toISOString().slice(0, 10);
  const sh = sheet({ title: esc(t('outing.plan_title')), body: `<div class="stack">
    <p class="small muted">${esc(t('outing.plan_hint'))}</p>
    <label class="field"><span>${esc(t('outing.name'))}</span><input data-name maxlength="120" placeholder="${esc(t('outing.name_ph'))}"></label>
    <div class="field-row"><label class="field"><span>${esc(t('outing.from'))}</span><input type="date" data-day value="${today}"></label>
      <label class="field"><span>${esc(t('outing.to'))}</span><input type="date" data-end value="${today}"></label></div>
    <div class="field-row"><label class="field"><span>${esc(t('spot.airport'))}</span><div class="input-wrap"><input data-ap maxlength="4" placeholder="LFFQ" autocomplete="off"></div></label>
      <label class="field"><span>${esc(t('spot.place'))}</span><input data-place maxlength="80"></label></div>
    <button class="btn primary" data-go>${esc(t('outing.plan_go'))}</button></div>` });
  const $ = (k) => sh.body.querySelector(`[data-${k}]`);
  airportInput($('ap'));
  $('day').onchange = () => { if ($('end').value < $('day').value) $('end').value = $('day').value; };
  $('go').onclick = async () => {
    try {
      const r = await api('/api/outings', { method: 'POST', body: { day: $('day').value, end_day: $('end').value, airport: $('ap').value.trim().toUpperCase(), place: $('place').value.trim(), name: $('name').value, kind: 'airshow' } });
      sh.close(); toast(esc(t('common.saved')), { type: 'success' }); onDone(r.id);
    } catch (e) { errorToast(e); }
  };
}

export async function render(root, _params, query = {}) {
  const filters = { year: query.year || '', airport: query.airport || '', search: '', kind: '' };
  let items = [], total = 0, years = [], done = false, loading = false, gen = 0, picking = false;
  const picked = new Set();
  root.innerHTML = `${pageHead(esc(t('outing.title')), { sub: `<span data-count></span>`,
      actions: `<button class="btn" data-pick>${icon('git-merge', '', 16)} ${esc(t('outing.merge'))}</button><button class="btn primary" data-plan>${icon('calendar-plus', '', 16)} ${esc(t('outing.plan'))}</button>` })}
    <div class="stack" style="gap:10px;margin-bottom:14px">
      <div class="search">${icon('search', '', 18)}<input class="input" type="search" data-q placeholder="${esc(t('outing.search_ph'))}" autocomplete="off"></div>
      <div class="chips scroll" data-years></div>
      ${filters.airport ? `<div class="chips"><button class="chip on" data-noap>${icon('x', '', 14)} ${esc(filters.airport)}</button></div>` : ''}
    </div>
    <div class="card row" data-bar hidden style="margin-bottom:12px;justify-content:space-between"><span data-sel></span><span class="row"><button class="btn ghost" data-cancel>${esc(t('common.cancel'))}</button><button class="btn primary" data-do disabled>${icon('git-merge', '', 16)} ${esc(t('outing.merge'))}</button></span></div>
    <div data-list class="stack" style="gap:10px"></div><div data-more style="height:1px"></div>`;
  const list = root.querySelector('[data-list]');

  const card = (o) => `<a class="card outing ${picked.has(o.id) ? 'selected' : ''}" href="#/outings/${o.id}" data-id="${o.id}">
    <div class="o-thumbs">${o.thumbs?.length ? o.thumbs.map((th) => `<img loading="lazy" src="${mediaUrl('thumbs', th)}" alt="">`).join('')
      : `<div class="o-ph">${icon(o.kind === 'airshow' ? 'plane' : 'camera', '', 26)}</div>`}</div>
    <div class="o-body">
      <div class="ttl">${picking ? `<input type="checkbox" ${picked.has(o.id) ? 'checked' : ''} tabindex="-1"> ` : ''}${esc(outingTitle(o))}${o.kind === 'airshow' ? ` <span class="badge gold">${icon('plane', '', 11)} ${esc(t('outing.airshow'))}${o.span > 1 ? ` · ${esc(t('outing.n_days', { n: o.span }))}` : ''}</span>` : ''}</div>
      <div class="meta">${esc(outingDates(o))}${o.name ? ` · ${esc(outingSite(o))}` : ''}</div>
      ${o.n ? `<div class="o-stats"><span>${icon('camera', '', 14)} ${esc(t('outing.n_spots', { n: o.n }))}</span>
        <span>${icon('plane', '', 14)} ${esc(t('outing.n_aircraft', { n: o.regs }))}</span>
        ${o.new_regs ? `<span class="o-new">${icon('sparkles', '', 14)} ${esc(t('outing.n_new', { n: o.new_regs }))}</span>` : ''}
        ${o.specials ? `<span>${icon('palette', '', 14)} ${o.specials}</span>` : ''}${o.military ? `<span>${icon('shield', '', 14)} ${o.military}</span>` : ''}</div>`
        : `<div class="o-stats"><span>${icon('calendar-days', '', 14)} ${esc(t('outing.planned'))}</span></div>`}
    </div></a>`;

  const drawBar = () => {
    root.querySelector('[data-bar]').hidden = !picking;
    root.querySelector('[data-sel]').textContent = t('outing.selected', { n: picked.size });
    root.querySelector('[data-do]').disabled = picked.size < 2;
  };

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
      box.innerHTML = `<button class="chip ${!filters.year && !filters.kind ? 'on' : ''}" data-y="">${esc(t('common.all'))}</button>
        <button class="chip ${filters.kind === 'airshow' ? 'on' : ''}" data-kind>${icon('plane', '', 14)} ${esc(t('outing.airshows'))}</button>
        ${years.map((y) => `<button class="chip ${filters.year === y ? 'on' : ''}" data-y="${y}">${y}</button>`).join('')}`;
      box.querySelectorAll('[data-y]').forEach((b) => (b.onclick = () => { filters.year = b.dataset.y; filters.kind = ''; load(true); }));
      box.querySelector('[data-kind]').onclick = () => { filters.kind = filters.kind ? '' : 'airshow'; filters.year = ''; load(true); };
    } catch (e) { errorToast(e); done = true; } finally { loading = false; }
  }

  // Sélection pour fusionner : un clic coche la carte au lieu d'ouvrir la sortie
  list.addEventListener('click', (e) => {
    if (!picking) return;
    const c = e.target.closest('[data-id]');
    if (!c) return;
    e.preventDefault();
    const id = Number(c.dataset.id);
    picked.has(id) ? picked.delete(id) : picked.add(id);
    c.classList.toggle('selected', picked.has(id));
    const cb = c.querySelector('input[type=checkbox]'); if (cb) cb.checked = picked.has(id);
    drawBar();
  });
  const setPicking = (on) => { picking = on; picked.clear(); drawBar(); load(true); };
  root.querySelector('[data-pick]').onclick = () => setPicking(!picking);
  root.querySelector('[data-cancel]').onclick = () => setPicking(false);
  root.querySelector('[data-do]').onclick = async () => {
    try {
      const r = await api('/api/outings/merge', { method: 'POST', body: { ids: [...picked], kind: 'airshow' } });
      toast(esc(t('outing.merged')), { type: 'success' });
      location.hash = `#/outings/${r.id}`;
    } catch (e) { errorToast(e); }
  };
  root.querySelector('[data-plan]').onclick = () => planSheet((id) => { location.hash = `#/outings/${id}`; });
  root.querySelector('[data-q]').addEventListener('input', debounce((e) => { filters.search = e.target.value; load(true); }, 250));
  root.querySelector('[data-noap]')?.addEventListener('click', () => { filters.airport = ''; location.hash = '#/outings'; });
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) load(); }, { rootMargin: '600px' });
  io.observe(root.querySelector('[data-more]'));
  await load(true);
  return () => io.disconnect();
}
