// Patrouilles : liste (passages, avions identifiés, dernière rencontre)
import { api, mediaUrl } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, debounce, regFlag } from '../ui.js';

export async function render(root) {
  let items = [];
  try { items = (await api('/api/patrols')).items; } catch (e) { errorToast(e); }
  if (!items.length) {
    root.innerHTML = pageHead(esc(t('patrols.title'))) + `<div class="card">${emptyState('users', t('patrols.empty'), t('patrols.empty_text'))}</div>`;
    return;
  }
  const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  root.innerHTML = `${pageHead(esc(t('patrols.title')), { sub: esc(t('patrols.count', { n: items.length })) })}
    <div class="search" style="margin-bottom:12px"><input class="input" data-q placeholder="${esc(t('patrols.search'))}" autocomplete="off"></div>
    <div class="card flush list" data-list></div>`;
  const list = root.querySelector('[data-list]');
  const draw = (q = '') => {
    const rows = items.filter((p) => !q || fold(p.name).includes(fold(q)));
    list.innerHTML = rows.length ? rows.map((p) => `<a class="list-row" href="#/patrols/${p.id}">
      <div class="thumb" style="width:52px;height:52px;border-radius:10px;overflow:hidden;background:var(--surface-2);flex:none">${p.thumb ? `<img src="${mediaUrl(p.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</div>
      <div class="grow" style="min-width:0"><div class="ellipsis"><b>${esc(p.name || t('patrol.title'))}</b> ${regFlag(p.country)}</div>
        <div class="small muted ellipsis">${esc(t('patrols.passages', { n: p.passages }))}${p.aircraft ? ' · ' + esc(t('patrols.aircraft', { n: p.aircraft })) : ''}${p.last_at ? ' · ' + esc(t('patrols.last', { date: fmtDate(p.last_at, { time: false }) })) : ''}</div></div>
      ${p.simple ? `<span class="badge slate">${esc(t('patrols.simple'))}</span>` : ''}<span class="badge">${fmtNum(p.passages)}×</span>${icon('chevron-right', '', 16)}</a>`).join('')
      : `<div class="small muted" style="padding:16px">${esc(t('common.no_results'))}</div>`;
  };
  draw();
  root.querySelector('[data-q]').addEventListener('input', debounce((e) => draw(e.target.value), 120));
}
