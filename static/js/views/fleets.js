// Collection & flottes : compagnies, complétion, accès aux livrées spéciales
import { api } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, emptyState, debounce, promptDialog, toast, errorToast } from '../ui.js';

export async function render(root) {
  let rows = await api('/api/fleets');
  const ref = await api('/api/refdb').catch(() => ({}));
  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.fleets'))}</h1><div class="sub">${esc(t('fleet.sub', { n: rows.length }))}</div></div>
      <div class="actions">${ref.available ? `<button class="btn" data-build title="${esc(t('fleet.build_all_d'))}">${icon('database', '', 18)} <span class="hide-sm">${esc(t('fleet.build_all'))}</span></button>` : ''}
      <a class="btn" href="#/liveries">${icon('palette', '', 18)} ${esc(t('nav.liveries'))}</a>
      <button class="btn-icon glassy" data-add title="${esc(t('fleet.add'))}">${icon('plus')}</button></div></header>
    <div class="search" style="margin-bottom:14px">${icon('search', '', 18)}<input class="input" type="search" placeholder="${esc(t('fleet.search'))}"></div>
    <div data-list></div>`;
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    const list = rows.filter((r) => `${r.key} ${r.name} ${r.iata || ''}`.toLowerCase().includes(ql));
    root.querySelector('[data-list]').innerHTML = list.length ? `<div class="grid three">${list.map((r) => {
      const pct = r.completion != null ? Math.round(r.completion * 100) : null;
      return `<a class="card" href="#/fleets/${encodeURIComponent(r.key)}" style="display:flex;gap:14px;align-items:center">
        <div class="ring" style="--p:${pct ?? 0}"><b style="font-size:${pct != null ? 15 : 12}px">${pct != null ? pct + '%' : esc(r.icao || '—')}</b></div>
        <div class="grow" style="min-width:0"><div style="font-weight:700" class="ellipsis">${esc(r.name)}</div>
          <div class="small muted">${esc([r.icao, r.iata].filter(Boolean).join(' · '))}</div>
          <div class="small">${esc(t('fleet.regs_spotted', { n: r.regs }))}${r.fleet_size ? ` / ${fmtNum(r.fleet_size)}` : ''}</div>
          ${r.last ? `<div class="tiny muted">${esc(t('fleet.last', { date: fmtDate(r.last, { time: false }) }))}</div>` : ''}</div></a>`;
    }).join('')}</div>` : `<div class="card">${emptyState('building-2', t('fleet.empty'), t('fleet.empty_text'))}</div>`;
  };
  root.querySelector('[data-build]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await api('/api/fleets/build-local', { method: 'POST', body: {} });
      toast(esc(t('fleet.build_all_done', { n: r.with_fleet, a: fmtNum(r.added) })), { type: 'success', duration: 7000 });
      rows = await api('/api/fleets');
      draw(root.querySelector('input').value);
    } catch (err) { errorToast(err); }
    b.disabled = false;
  });
  root.querySelector('input').addEventListener('input', debounce((e) => draw(e.target.value), 150));
  root.querySelector('[data-add]').onclick = async () => {
    const code = await promptDialog(t('fleet.add_code'), { placeholder: 'AFR' });
    if (code?.trim()) location.hash = `#/fleets/${encodeURIComponent(code.trim().toUpperCase())}`;
  };
  draw();
}
