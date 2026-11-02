// Détail d'une compagnie : complétion de flotte par type, appareils vus / manquants
import { api, mediaUrl } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast, confirmDialog, emptyState, menu } from '../ui.js';

export async function render(root, params) {
  const key = params.key;
  let d = await api(`/api/fleets/${encodeURIComponent(key)}`);
  let filter = 'all';

  const draw = () => {
    const total = d.fleet.length;
    const seen = d.fleet.filter((f) => f.spotted).length;
    const pct = total ? Math.round((seen / total) * 100) : null;
    const fleet = d.fleet.filter((f) => filter === 'all' || (filter === 'seen' ? f.spotted : !f.spotted));
    root.innerHTML = `
      <header class="page-head"><div class="row" style="gap:18px">
        ${pct != null ? `<div class="ring lg" style="--p:${pct}"><b>${pct}%</b></div>` : ''}
        <div><h1>${esc(d.name)}</h1><div class="sub">${esc(key)}${d.meta.iata ? ' · ' + esc(d.meta.iata) : ''}${total ? ` · ${esc(t('fleet.completion', { seen, total }))}` : ''}</div>
        ${d.meta.fleet_fetched_at ? `<div class="tiny muted">${esc(t('fleet.updated', { date: fmtDate(d.meta.fleet_fetched_at, { time: false }), src: d.meta.fleet_source }))}</div>` : ''}</div></div>
        <div class="actions">
          ${d.airlabs && /^[A-Z]{3}$/.test(key) ? `<button class="btn" data-fetch>${icon('refresh-cw', '', 18)} ${esc(t('fleet.fetch'))}</button>` : ''}
          <button class="btn-icon glassy" data-menu>${icon('ellipsis')}</button></div></header>
      ${!total ? `<div class="card" style="margin-bottom:14px">${emptyState('building-2', t('fleet.no_fleet'), d.airlabs ? t('fleet.no_fleet_text_api') : t('fleet.no_fleet_text'),
        `<div class="row wrap" style="justify-content:center">${d.airlabs && /^[A-Z]{3}$/.test(key) ? `<button class="btn primary" data-fetch2>${esc(t('fleet.fetch'))}</button>` : ''}<button class="btn" data-import2>${icon('upload', '', 18)} ${esc(t('fleet.import'))}</button></div>`)}</div>` : ''}
      ${d.by_type.length ? `<div class="card" style="margin-bottom:14px"><div class="card-title">${esc(t('fleet.by_type'))}</div>
        <div class="hbars">${d.by_type.map((b) => `<div class="hbar"><span class="k">${esc(b.type)}</span><div class="track"><div class="fill" style="width:${(b.seen / b.total) * 100}%"></div></div><span class="n">${b.seen}/${b.total}</span></div>`).join('')}</div></div>` : ''}
      ${total ? `<div class="row between wrap" style="margin-bottom:10px"><h2 style="font-size:20px">${esc(t('fleet.fleet'))}</h2>
        <div class="seg">${['all', 'seen', 'missing'].map((f) => `<button data-f="${f}" class="${filter === f ? 'on' : ''}">${esc(t(`fleet.f_${f}`))}</button>`).join('')}</div></div>
        <div class="fleet-grid">${fleet.map((f) => f.spotted
          ? `<a class="fleet-cell seen" href="#/airframe/${encodeURIComponent(f.registration)}">${esc(f.registration)}<small>${esc(f.aircraft || '')} · ${f.spotted}×</small></a>`
          : `<div class="fleet-cell">${esc(f.registration)}<small>${esc(f.aircraft || '')}${f.status && f.status !== 'active' ? ' · ' + esc(f.status) : ''}</small></div>`).join('')}</div>` : ''}
      ${d.spotted.length ? `<div class="section"><h2>${esc(t('fleet.my_spots', { n: d.spotted.length }))}</h2></div>
        <div class="gallery">${d.spotted.map((s) => `<a class="tile ${s.thumb ? '' : 'noimg'}" href="#/airframe/${encodeURIComponent(s.registration)}">
          ${s.thumb ? `<img loading="lazy" src="${mediaUrl('thumbs', s.thumb)}" alt="">` : icon('plane', '', 32)}
          <div class="cap"><b class="mono">${esc(s.registration)}</b><small>${esc(s.aircraft || s.aircraft_icao || '')} · ${s.n}×</small></div></a>`).join('')}</div>` : ''}`;

    root.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    const fetchIt = async (btn) => {
      btn.disabled = true;
      try { d = await api(`/api/fleets/${encodeURIComponent(key)}/fetch`, { method: 'POST' }); toast(esc(t('fleet.fetched', { n: d.fleet.length })), { type: 'success' }); draw(); }
      catch (e) { errorToast(e); btn.disabled = false; }
    };
    root.querySelector('[data-fetch]')?.addEventListener('click', (e) => fetchIt(e.currentTarget));
    root.querySelector('[data-fetch2]')?.addEventListener('click', (e) => fetchIt(e.currentTarget));
    root.querySelector('[data-import2]')?.addEventListener('click', importFleet);
    root.querySelector('[data-menu]').onclick = (e) => menu(e.currentTarget, [
      { icon: 'upload', label: t('fleet.import'), onClick: importFleet },
      { icon: 'camera', label: t('fleet.see_spots'), onClick: () => (location.hash = `#/spots?airline=${encodeURIComponent(key)}`) },
      { icon: 'share-2', label: t('share.this_gallery'), onClick: async () => (await import('./shares.js')).createShareFlow({ kind: 'gallery', target: `airline:${key}`, title: d.name }) },
      total && '-',
      total && { icon: 'trash-2', label: t('fleet.clear'), danger: true, onClick: async () => {
        if (!(await confirmDialog(esc(t('fleet.clear_confirm')), { danger: true }))) return;
        await api(`/api/fleets/${encodeURIComponent(key)}`, { method: 'DELETE' });
        d = await api(`/api/fleets/${encodeURIComponent(key)}`); draw();
      } },
    ]);
  };

  function importFleet() {
    const s = sheet({ title: esc(t('fleet.import')), body: `
      <p class="small muted" style="margin-bottom:12px">${esc(t('fleet.import_hint'))}</p>
      <label class="field"><span>${esc(t('fleet.airline_name'))}</span><input data-name value="${esc(d.meta.name || d.name || '')}"></label>
      <label class="field" style="margin-top:12px"><span>${esc(t('fleet.list'))}</span><textarea data-text rows="10" placeholder="F-HBXA, A320&#10;F-HBXB, A320&#10;F-GKXA"></textarea></label>
      <label class="toggle-row"><span class="t">${esc(t('fleet.replace'))}</span><span class="switch"><input type="checkbox" data-rep checked><span></span></span></label>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-go>${esc(t('common.import'))}</button></div>` });
    s.body.querySelector('[data-go]').onclick = async () => {
      try {
        d = await api(`/api/fleets/${encodeURIComponent(key)}/import`, { method: 'POST', body: { text: s.body.querySelector('[data-text]').value, name: s.body.querySelector('[data-name]').value || null, replace: s.body.querySelector('[data-rep]').checked } });
        s.close(); draw();
      } catch (e) { errorToast(e); }
    };
  }
  draw();
}
