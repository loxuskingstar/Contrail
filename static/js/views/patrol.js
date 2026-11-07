// Fiche d'une patrouille : passages (jour + lieu), avions identifiés, historique, fusion et renommage
import { api, mediaUrl } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, regText, regFlag, sheet, toast, errorToast, menu, confirmDialog } from '../ui.js';

export async function render(root, { id }) {
  const p = await api(`/api/patrols/${id}`);
  const name = p.name || t('patrol.title');
  const place = (o) => esc(o.airport_name ? `${o.airport} · ${o.airport_name}` : (o.airport || o.place || '—'));
  const years = p.by_year.length ? `${p.by_year[0].y}${p.by_year.length > 1 ? '–' + p.by_year[p.by_year.length - 1].y : ''}` : '';
  const max = Math.max(1, ...p.by_year.map((y) => y.n));
  const kpis = [['users', p.n_passages, t('patrol.k_passes')], p.aircraft.length ? ['plane', p.aircraft.length, t('patrol.k_aircraft')] : null,
    ['camera', p.spots, t('outing.k_spots')], p.size ? ['users', p.size, t('patrol.k_size')] : null].filter(Boolean);
  const firstSpot = (o) => o.simple_id || o.spots[0];
  root.innerHTML = `${pageHead(esc(name), {
    sub: `${regFlag(p.country)} ${esc(t('patrols.passages', { n: p.n_passages }))}${years ? ' · ' + esc(years) : ''}${p.simple ? ' · ' + esc(t('patrols.simple')) : ''}`,
    actions: `<a class="btn" href="#/spots?patrol=${p.id}">${icon('list', '', 16)} ${esc(t('outing.open_list'))}</a><button class="btn-icon" data-more aria-label="${esc(t('common.more'))}">${icon('ellipsis')}</button>` })}
    <div class="grid kpis" style="margin-bottom:14px">${kpis.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
    <div class="row wrap" style="gap:8px;margin-bottom:14px">
      <a class="btn primary" href="#/spots/new?patrol_simple=${encodeURIComponent(p.name)}">${icon('plus', '', 16)} ${esc(t('patrol.add_pass'))}</a>
      <a class="btn" href="#/spots/new?patrol=${encodeURIComponent(p.name)}">${icon('plane', '', 16)} ${esc(t('patrol.add_aircraft'))}</a></div>
    ${p.aircraft.length ? `<div class="card" style="margin-bottom:14px"><div class="card-title">${icon('plane', '', 18)} ${esc(t('patrol.fleet'))} · ${p.aircraft.length}</div>
      <div class="stack" style="gap:0">${p.aircraft.map((a) => `<div class="list-row" style="padding:8px 0;gap:10px">
        <a class="row grow" style="gap:10px;min-width:0;text-decoration:none;color:inherit" href="#/airframe/${encodeURIComponent(a.registration)}">
          <div style="width:44px;height:44px;border-radius:9px;overflow:hidden;background:var(--surface-2);flex:none">${a.thumb ? `<img src="${mediaUrl('thumbs', a.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</div>
          <div class="grow" style="min-width:0"><div class="mono"><b>${esc(regText(a.registration))}</b></div><div class="small muted ellipsis">${esc(a.aircraft || '')}${a.owner ? ' · ' + esc(a.owner) : ''}</div></div></a>
        <span class="badge" title="${esc(t('patrol.of_n', { n: p.n_passages }))}">${esc(t('patrol.in_passes', { n: a.passages, total: p.n_passages }))}</span>
        <button class="btn-icon" data-detach="${a.id}" title="${esc(t('patrol.detach'))}" aria-label="${esc(t('patrol.detach'))}">${icon('x', '', 16)}</button></div>`).join('')}</div></div>` : ''}
    ${p.by_year.length > 1 || p.airports.length ? `<div class="grid two" style="margin-bottom:14px">
      ${p.by_year.length > 1 ? `<div class="card"><div class="card-title">${esc(t('patrol.by_year'))}</div><div style="display:flex;align-items:flex-end;gap:6px;height:90px">${p.by_year.map((y) =>
        `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%" title="${y.y}: ${y.n}"><div style="width:100%;max-width:30px;border-radius:4px 4px 0 0;background:var(--accent);height:${Math.max(4, Math.round(y.n / max * 64))}px"></div><span class="small muted" style="font-size:10px">${y.y}</span></div>`).join('')}</div></div>` : ''}
      ${p.airports.length ? `<div class="card"><div class="card-title">${esc(t('patrol.places'))}</div><div class="chips">${p.airports.map((a) => `<a class="chip" href="#/spots?patrol=${p.id}&airport=${encodeURIComponent(a.k)}" title="${esc(a.name || '')}">${esc(a.k)} · ${a.n}</a>`).join('')}</div></div>` : ''}</div>` : ''}
    <div class="card flush list"><div class="card-title" style="padding:14px 16px 0">${icon('history', '', 18)} ${esc(t('patrol.timeline'))}</div>
      ${p.passages.map((o, i) => `<a class="list-row" href="#/spots/${firstSpot(o)}">
        <div style="width:52px;height:52px;border-radius:10px;overflow:hidden;background:var(--surface-2);flex:none">${o.thumb ? `<img src="${mediaUrl('thumbs', o.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</div>
        <div class="grow" style="min-width:0"><div><b>${o.date ? esc(fmtDate(o.date, { time: false })) : '—'}</b> <span class="muted">· ${place(o)}</span></div>
          <div class="small muted ellipsis">${o.aircraft.length ? o.aircraft.map((a) => esc(regText(a.registration))).join(', ') : esc(o.size ? t('patrol.n_aircraft', { n: o.size }) : t('patrol.pass_simple'))}</div></div>
        <span class="badge slate">#${p.passages.length - i}</span>${icon('chevron-right', '', 16)}</a>`).join('')}</div>`;

  root.querySelector('[data-more]').onclick = (e) => menu(e.currentTarget, [
    { icon: 'pencil', label: t('patrol.rename'), onClick: () => renameSheet(p, () => render(root, { id })) },
    { icon: 'git-merge', label: t('patrol.merge'), onClick: () => mergeSheet(p) },
  ]);
  root.querySelectorAll('[data-detach]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('patrol.detach_confirm'), { title: t('patrol.detach'), danger: true }))) return;
    try { await api(`/api/patrols/${p.id}/detach/${b.dataset.detach}`, { method: 'POST' }); render(root, { id }); } catch (err) { errorToast(err); }
  }));
}

function renameSheet(p, done) {
  const s = sheet({ title: esc(t('patrol.rename')), body: `<form class="stack"><label class="field"><span>${esc(t('patrol.name'))}</span><input class="input" name="name" value="${esc(p.name)}" maxlength="80" required></label>
    <p class="tiny muted">${esc(t('patrol.rename_hint'))}</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('common.save'))}</button></div></form>` });
  s.body.querySelector('[data-close]').onclick = s.close;
  s.body.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/patrols/${p.id}`, { method: 'PUT', body: { name: e.target.elements.name.value } });
      s.close();
      if (r.merged) location.hash = `#/patrols/${r.id}`; else done();
    } catch (err) { errorToast(err); }
  };
}

async function mergeSheet(p) {
  const others = (await api('/api/patrols')).items.filter((x) => x.id !== p.id);
  const s = sheet({ title: esc(t('patrol.merge')), body: `<div class="stack"><p class="small muted">${esc(t('patrol.merge_hint', { name: p.name }))}</p>
    ${others.length ? `<select class="input" data-into>${others.map((o) => `<option value="${o.id}">${esc(o.name || t('patrol.title'))} · ${esc(t('patrols.passages', { n: o.passages }))}</option>`).join('')}</select>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" data-go>${esc(t('patrol.merge'))}</button></div>` : `<p class="small muted">${esc(t('patrols.empty'))}</p>`}</div>` });
  s.body.querySelector('[data-close]')?.addEventListener('click', s.close);
  s.body.querySelector('[data-go]')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/patrols/${p.id}/merge`, { method: 'POST', body: { into: Number(s.body.querySelector('[data-into]').value) } });
      s.close(); toast(esc(t('common.saved')), { type: 'success' }); location.hash = `#/patrols/${r.id}`;
    } catch (err) { errorToast(err); }
  });
}
