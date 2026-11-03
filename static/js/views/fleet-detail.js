// Détail d'une compagnie : complétion de flotte par type, appareils vus / manquants, exclusions
import { api, mediaUrl } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast, confirmDialog, emptyState, menu } from '../ui.js';

export async function render(root, params) {
  const key = params.key;
  let d = await api(`/api/fleets/${encodeURIComponent(key)}`);
  let filter = 'all';
  const canFetch = () => d.airlabs && /^[A-Z]{3}$/.test(key);

  const draw = () => {
    const total = d.fleet.length;
    const seen = d.fleet.filter((f) => f.spotted).length;
    const pct = total ? Math.round((seen / total) * 100) : null;
    const fleet = d.fleet.filter((f) => filter === 'all' || (filter === 'seen' ? f.spotted : !f.spotted));
    const groups = {};
    for (const f of fleet) (groups[f.family] ||= []).push(f);
    const src = { airlabs: 'AirLabs', refdb: t('fleet.src_refdb'), manual: t('fleet.src_manual') };
    root.innerHTML = `
      <header class="page-head"><div class="row" style="gap:18px">
        ${pct != null ? `<div class="ring lg" style="--p:${pct}"><b>${pct}%</b></div>` : ''}
        <div><h1>${esc(d.name)}</h1><div class="sub">${esc(key)}${d.meta.iata ? ' · ' + esc(d.meta.iata) : ''}${total ? ` · ${esc(t('fleet.completion', { seen, total }))}` : ''}</div>
        ${d.meta.fleet_fetched_at ? `<div class="tiny muted">${esc(t('fleet.updated', { date: fmtDate(d.meta.fleet_fetched_at, { time: false }), src: src[d.meta.fleet_source] || d.meta.fleet_source || '' }))}</div>` : ''}</div></div>
        <div class="actions">
          ${canFetch() ? `<button class="btn" data-fetch>${icon('refresh-cw', '', 18)} ${esc(t('fleet.fetch'))}</button>` : ''}
          <button class="btn-icon glassy" data-menu>${icon('ellipsis')}</button></div></header>
      ${d.refdb_candidates ? `<div class="ocr-strip" style="margin-bottom:14px">${icon('database', '', 18)}
        <span class="grow small">${esc(t('fleet.refdb_hint', { n: d.refdb_candidates }))}</span>
        <button class="btn sm" data-local>${esc(t('fleet.refdb_add'))}</button></div>` : ''}
      ${!total ? `<div class="card" style="margin-bottom:14px">${emptyState('building-2', t('fleet.no_fleet'), d.airlabs ? t('fleet.no_fleet_text_api') : t('fleet.no_fleet_text'),
        `<div class="row wrap" style="justify-content:center">${canFetch() ? `<button class="btn primary" data-fetch>${esc(t('fleet.fetch'))}</button>` : ''}<button class="btn" data-import2>${icon('upload', '', 18)} ${esc(t('fleet.import'))}</button></div>`)}</div>` : ''}
      ${d.by_type.length ? `<div class="card" style="margin-bottom:14px"><div class="card-title">${esc(t('fleet.by_type'))}</div>
        <div class="hbars">${d.by_type.map((b) => `<div class="hbar"><span class="k" title="${esc(b.code || '')}">${esc(b.type)}</span><div class="track"><div class="fill" style="width:${(b.seen / b.total) * 100}%"></div></div><span class="n">${b.seen}/${b.total}</span></div>`).join('')}</div></div>` : ''}
      ${total ? `<div class="row between wrap" style="margin-bottom:10px"><h2 style="font-size:18px">${esc(t('fleet.fleet'))}</h2>
        <div class="seg">${['all', 'seen', 'missing'].map((f) => `<button data-f="${f}" class="${filter === f ? 'on' : ''}">${esc(t(`fleet.f_${f}`))}</button>`).join('')}</div></div>
        <p class="tiny muted" style="margin:-4px 0 10px">${esc(t('fleet.exclude_hint'))}</p>
        ${Object.entries(groups).map(([fam, list]) => `<div class="fleet-group"><div class="fleet-group-h"><b>${esc(fam)}</b><span class="muted small">${list.filter((f) => f.spotted).length}/${list.length}</span></div>
          <div class="fleet-grid">${list.map((f) => `<div class="fleet-cell ${f.spotted ? 'seen' : ''}" data-reg="${esc(f.registration)}" tabindex="0">
            <span class="row between" style="gap:4px"><span>${esc(f.registration)}</span>${f.source === 'refdb' ? `<span class="badge" title="${esc(t('fleet.src_refdb'))}">${icon('database', '', 10)}</span>` : ''}</span>
            <small>${esc(f.spotted ? t('fleet.seen_n', { n: f.spotted }) : (f.aircraft && f.aircraft !== fam ? f.aircraft : ''))}${f.built ? ` · ${esc(f.built)}` : ''}</small></div>`).join('')}</div></div>`).join('')}` : ''}
      ${d.excluded.length ? `<details class="card fold" style="margin-top:16px"><summary>${icon('eye-off', '', 18)} ${esc(t('fleet.excluded', { n: d.excluded.length }))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body fleet-grid">${d.excluded.map((x) => `<div class="fleet-cell"><span class="row between">${esc(x.registration)}<button class="btn-icon" style="width:26px;height:26px" data-restore="${esc(x.registration)}" title="${esc(t('fleet.restore'))}">${icon('rotate-ccw', '', 14)}</button></span><small>${esc(x.aircraft || '')}</small></div>`).join('')}</div></details>` : ''}
      ${d.spotted.length ? `<div class="section"><h2>${esc(t('fleet.my_spots', { n: d.spotted.length }))}</h2></div>
        <div class="gallery">${d.spotted.map((s) => `<a class="tile ${s.thumb ? '' : 'noimg'}" href="#/airframe/${encodeURIComponent(s.registration)}">
          ${s.thumb ? `<img loading="lazy" src="${mediaUrl('thumbs', s.thumb)}" alt="">` : icon('plane', '', 20)}
          <div class="cap"><b class="mono">${esc(s.registration)}</b><small>${esc(s.aircraft || s.aircraft_icao || '')} · ${s.n}×</small></div></a>`).join('')}</div>` : ''}`;

    root.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    root.querySelectorAll('[data-fetch]').forEach((b) => b.addEventListener('click', () => fetchFleet(b)));
    root.querySelector('[data-import2]')?.addEventListener('click', importFleet);
    root.querySelector('[data-local]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api(`/api/fleets/${encodeURIComponent(key)}/complete-local`, { method: 'POST' }); d = r; toast(esc(t('fleet.refdb_added', { n: r.added })), { type: 'success' }); draw(); }
      catch (err) { errorToast(err); }
    });
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
      d = await api(`/api/fleets/${encodeURIComponent(key)}/exclude/${encodeURIComponent(b.dataset.restore)}`, { method: 'DELETE' });
      draw();
    }));
    root.querySelectorAll('.fleet-cell[data-reg]').forEach((c) => {
      const open = (ev) => {
        ev.preventDefault();
        const reg = c.dataset.reg;
        const f = d.fleet.find((x) => x.registration === reg);
        menu(c, [
          { icon: 'history', label: t('nav.airframe'), onClick: () => (location.hash = `#/airframe/${encodeURIComponent(reg)}`) },
          !f?.spotted && { icon: 'camera', label: t('spot.new'), onClick: () => (location.hash = `#/spots/new?reg=${encodeURIComponent(reg)}`) },
          '-',
          { icon: 'eye-off', label: t('fleet.exclude'), onClick: async () => { d = await api(`/api/fleets/${encodeURIComponent(key)}/exclude`, { method: 'POST', body: { registration: reg } }); draw(); } },
        ]);
      };
      c.addEventListener('click', open);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    });
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

  function fetchFleet(btn) {
    const s = sheet({ title: esc(t('fleet.fetch')), body: `
      <p class="small muted" style="margin-bottom:10px">${esc(t('fleet.fetch_hint'))}</p>
      <label class="toggle-row"><span><span class="t">${esc(t('fleet.include_light'))}</span><br><span class="d">${esc(t('fleet.include_light_d'))}</span></span>
        <span class="switch"><input type="checkbox" data-light><span></span></span></label>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" data-go>${icon('refresh-cw', '', 18)} ${esc(t('fleet.fetch'))}</button></div>` });
    s.body.querySelector('[data-go]').onclick = async (e) => {
      const go = e.currentTarget;
      go.disabled = true;
      go.innerHTML = `${icon('refresh-cw', '', 18)} ${esc(t('fleet.fetching'))}`;
      try {
        const r = await api(`/api/fleets/${encodeURIComponent(key)}/fetch`, { method: 'POST', body: { include_light: s.body.querySelector('[data-light]').checked } });
        d = r;
        s.close();
        toast(esc(t('fleet.fetched_detail', { n: r.fetch.kept, r: r.fetch.received, s: r.fetch.skipped_light })), { type: 'success', duration: 6000 });
        draw();
      } catch (err) { errorToast(err); go.disabled = false; }
    };
  }

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
