// Détail d'une sortie / d'un meeting : chiffres clés, jours, rythme, programme « à voir », météo et liste des spots
import { api } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, spotRow, sheet, toast, errorToast, confirmDialog } from '../ui.js';
import { outingSite, outingTitle, outingDates } from './outings.js';

const hhmm = (iso) => (iso || '').slice(11, 16);
const wxText = (w) => w ? [w.category, w.wind_kt != null ? `${w.wind_kt} kt` : '', w.temp != null ? `${w.temp}°` : ''].filter(Boolean).join(' · ') : '';

function duration(a, b) {
  if (!a || !b) return '';
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  if (m < 1) return '';
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

function rhythm(hours) {
  const max = Math.max(1, ...hours.map((x) => x.n));
  return `<div style="display:flex;align-items:flex-end;gap:3px;height:80px">${hours.map((x) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;height:100%" title="${x.h} h : ${x.n}">
    <div style="width:100%;max-width:24px;border-radius:4px 4px 0 0;background:var(--accent);opacity:${x.n ? 1 : .15};height:${Math.max(x.n ? 4 : 2, Math.round(x.n / max * 56))}px"></div>
    <span class="small muted" style="font-size:10px">${x.h}</span></div>`).join('')}</div>`;
}

export async function render(root, { id }) {
  const o = await api(`/api/outings/${id}`);
  const multi = o.days.length > 1;
  const air = o.kind === 'airshow';
  let dayFilter = '';
  const dur = !multi ? duration(o.first_at, o.last_at) : '';
  const w = o.weather;
  const kpis = [['camera', fmtNum(o.n), t('outing.k_spots')], ['plane', fmtNum(o.regs), t('outing.k_aircraft')], ['layers', fmtNum(o.types), t('outing.k_types')],
    ['sparkles', fmtNum(o.new_regs), t('outing.k_new')], o.rare ? ['gem', fmtNum(o.rare), t('outing.k_rare')] : null,
    o.specials ? ['palette', fmtNum(o.specials), t('outing.k_special')] : null,
    o.military ? ['shield', fmtNum(o.military), t('outing.k_military')] : null, o.patrols ? ['users', fmtNum(o.patrols), t('outing.k_patrols')] : null,
    o.favs ? ['star', fmtNum(o.favs), t('outing.k_fav')] : null].filter(Boolean);
  const seen = o.items.filter((i) => i.seen).length;

  const itemRow = (i) => `<div class="list-row" data-item="${i.id}">
    <button class="btn-icon" data-tick="${i.id}" ${i.match_kind !== 'free' ? 'disabled' : ''} aria-label="${esc(t('outing.tick'))}">${icon(i.seen ? 'circle-check' : 'circle', '', 22)}</button>
    <span class="grow ellipsis" style="${i.seen ? 'opacity:.65' : ''}">${i.time ? `<span class="mono small muted">${esc(i.time)}</span> ` : ''}${i.spot_id ? `<a href="#/spots/${i.spot_id}">${esc(i.label)}</a>` : esc(i.label)}${i.match_kind !== 'free' ? ` <span class="badge">${esc(i.match_kind === 'type' ? t('outing.match_type') : t('outing.match_reg'))}</span>` : ''}</span>
    <button class="btn-icon" data-del-item="${i.id}" aria-label="${esc(t('common.delete'))}">${icon('x', '', 18)}</button></div>`;

  const dayCards = () => `<div class="chips scroll" style="margin-bottom:14px">
    <button class="chip ${!dayFilter ? 'on' : ''}" data-day="">${esc(t('common.all'))} · ${o.n}</button>
    ${o.days.map((d) => `<button class="chip ${dayFilter === d.day ? 'on' : ''}" data-day="${d.day}" title="${esc(wxText(d.weather))}">${esc(fmtDate(d.day, { time: false, weekday: true, short: true }))} · ${d.n}${d.new ? ` · ${icon('sparkles', '', 11)}${d.new}` : ''}</button>`).join('')}</div>`;

  const spotsHtml = () => {
    const rows = dayFilter ? o.spots.filter((s) => (s.date || '').startsWith(dayFilter)) : o.spots;
    return rows.length ? rows.map((s) => spotRow(s)).join('') : `<p class="muted" style="padding:14px">${esc(t('outing.no_spot_day'))}</p>`;
  };

  const addDay = (dayFilter || o.days.find((d) => d.day >= new Date().toISOString().slice(0, 10))?.day || o.day);
  root.innerHTML = `${pageHead(esc(outingTitle(o)), {
      sub: `${air ? `<span class="badge gold">${icon('plane', '', 11)} ${esc(t('outing.airshow'))}</span> ` : ''}${esc(outingDates(o))}${o.name ? ` · ${esc(outingSite(o))}` : ''}${dur ? ` · ${icon('clock', '', 14)} ${esc(hhmm(o.first_at))}–${esc(hhmm(o.last_at))} (${esc(dur)})` : ''}`,
      actions: `${o.prev_id ? `<a class="btn-icon" href="#/outings/${o.prev_id}" title="${esc(t('outing.prev'))}">${icon('chevron-left')}</a>` : ''}${o.next_id ? `<a class="btn-icon" href="#/outings/${o.next_id}" title="${esc(t('outing.next'))}">${icon('chevron-right')}</a>` : ''}<button class="btn-icon" data-pdf title="${esc(t('pdf.export_menu'))}">${icon('file-text')}</button><button class="btn" data-edit>${icon('pencil', '', 16)} ${esc(t('common.edit'))}</button>` })}
    ${o.mergeable.length ? `<div class="card row" style="margin-bottom:14px;justify-content:space-between;gap:12px">${icon('git-merge', '', 22)}<div class="grow"><b>${esc(t('outing.merge_hint_t'))}</b><div class="small muted">${esc(t('outing.merge_hint', { n: o.mergeable.length }))}</div></div><button class="btn" data-merge>${esc(t('outing.merge'))}</button></div>` : ''}
    ${o.n ? `<div class="grid kpis" style="margin-bottom:14px">${kpis.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>` : `<div class="card muted" style="margin-bottom:14px">${esc(t('outing.planned_empty'))}</div>`}
    <div class="chips" style="margin-bottom:14px">
      <a class="btn primary" href="#/spots/new?${new URLSearchParams({ ...(o.airport ? { airport: o.airport } : { place: o.place || '' }), date: addDay })}">${icon('plus', '', 16)} ${esc(t('outing.add_spot'))}</a>
      ${o.airport ? `<a class="chip" href="#/airports/${o.airport}">${icon('map-pin', '', 14)} ${esc(o.airport_info?.name || o.airport)}</a>` : ''}
      ${o.n ? `<a class="chip" href="#/spots?outing=${o.id}">${icon('list', '', 14)} ${esc(t('outing.open_list'))}</a>` : ''}
      ${!multi && w ? `<span class="chip" title="${esc(w.raw || '')}">${icon('cloud-sun', '', 14)} ${esc(wxText(w))}</span>` : ''}
      ${o.top_types.map((x) => `<a class="chip" href="#/spots?outing=${o.id}&type=${encodeURIComponent(x.k)}">${esc(x.k)} · ${x.n}</a>`).join('')}</div>
    ${o.notes ? `<div class="card" style="margin-bottom:14px;white-space:pre-wrap">${esc(o.notes)}</div>` : ''}
    ${air || o.items.length ? `<div class="section"><h2>${esc(t('outing.program'))}${o.items.length ? ` <span class="muted small">${esc(t('outing.seen_of', { a: seen, b: o.items.length }))}</span>` : ''}</h2></div>
      <div class="card" style="margin-bottom:14px;padding:6px">
        ${o.items.length ? `<div style="height:6px;border-radius:4px;background:var(--surface-2);margin:8px 8px 4px;overflow:hidden"><div style="height:100%;width:${Math.round(seen / o.items.length * 100)}%;background:var(--accent)"></div></div>` : `<p class="small muted" style="padding:10px 12px">${esc(t('outing.program_hint'))}</p>`}
        <div data-items>${o.items.map(itemRow).join('')}</div>
        <form class="row" data-add-item style="padding:8px;gap:8px;flex-wrap:wrap"><input class="input" style="flex:1 1 100%" data-label maxlength="120" placeholder="${esc(t('outing.item_ph'))}" autocomplete="off">
          ${multi ? `<select class="input" data-iday style="flex:1 1 120px"><option value="">${esc(t('outing.every_day'))}</option>${o.days.map((d) => `<option value="${d.day}">${esc(fmtDate(d.day, { time: false, weekday: true, short: true }))}</option>`).join('')}</select>` : ''}
          <input class="input" data-itime type="time" style="flex:1 1 110px"><button class="btn primary" type="submit" aria-label="${esc(t('common.save'))}">${icon('plus', '', 16)}</button></form></div>` : ''}
    ${o.hours.length > 1 ? `<div class="card" style="margin-bottom:14px"><b>${esc(t('outing.rhythm'))}</b><div style="margin-top:10px">${rhythm(o.hours)}</div></div>` : ''}
    ${multi ? dayCards() : ''}
    ${multi && o.days.some((d) => d.weather) ? `<div class="small muted" style="margin:-6px 0 14px">${o.days.filter((d) => d.weather).map((d) => `${esc(fmtDate(d.day, { time: false, weekday: true, short: true }))} : ${esc(wxText(d.weather))}`).join(' · ')}</div>` : ''}
    <div class="section"><h2>${esc(t('outing.timeline'))}</h2></div>
    <div class="card" style="padding:6px" data-spots>${spotsHtml()}</div>`;

  root.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => {
    dayFilter = b.dataset.day;
    root.querySelectorAll('[data-day]').forEach((x) => x.classList.toggle('on', x.dataset.day === dayFilter));
    root.querySelector('[data-spots]').innerHTML = spotsHtml();
  }));
  const reload = () => render(root, { id });
  root.querySelector('[data-add-item]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = root.querySelector('[data-label]').value.trim();
    if (!label) return;
    try {
      await api(`/api/outings/${o.id}/items`, { method: 'POST', body: { label, day: root.querySelector('[data-iday]')?.value || null, time: root.querySelector('[data-itime]').value || null } });
      reload();
    } catch (err) { errorToast(err); }
  });
  root.querySelectorAll('[data-tick]').forEach((b) => (b.onclick = async () => {
    const it = o.items.find((x) => x.id === Number(b.dataset.tick));
    try { await api(`/api/outings/items/${it.id}`, { method: 'PUT', body: { done: !it.done } }); reload(); } catch (err) { errorToast(err); }
  }));
  root.querySelectorAll('[data-del-item]').forEach((b) => (b.onclick = async () => {
    try { await api(`/api/outings/items/${b.dataset.delItem}`, { method: 'DELETE' }); reload(); } catch (err) { errorToast(err); }
  }));

  const mergeSheet = () => {
    const sh = sheet({ title: esc(t('outing.merge_title')), body: `<div class="stack"><p class="small muted">${esc(t('outing.merge_text'))}</p>
      <div class="card" style="padding:6px">${o.mergeable.map((m) => `<label class="list-row"><input type="checkbox" data-m="${m.id}" checked> <span class="grow">${esc(outingDates(m))}${m.name ? ` · ${esc(m.name)}` : ''}</span></label>`).join('')}</div>
      <label class="field"><span>${esc(t('outing.name'))}</span><input data-name maxlength="120" value="${esc(o.name || '')}" placeholder="${esc(t('outing.name_ph'))}"></label>
      <button class="btn primary" data-go>${icon('git-merge', '', 16)} ${esc(t('outing.merge'))}</button></div>` });
    sh.body.querySelector('[data-go]').onclick = async () => {
      const ids = [o.id, ...[...sh.body.querySelectorAll('[data-m]')].filter((c) => c.checked).map((c) => Number(c.dataset.m))];
      try {
        const r = await api('/api/outings/merge', { method: 'POST', body: { ids, name: sh.body.querySelector('[data-name]').value, kind: 'airshow' } });
        sh.close(); toast(esc(t('outing.merged')), { type: 'success' });
        location.hash = `#/outings/${r.id}`;
        if (String(r.id) === String(id)) reload();
      } catch (err) { errorToast(err); }
    };
  };
  root.querySelector('[data-merge]')?.addEventListener('click', mergeSheet);

  root.querySelector('[data-pdf]').onclick = async () => (await import('../lib/pdf-dialog.js')).openPdfExport({ kind: 'spots', params: { outing: o.id, title: outingTitle(o), sort: 'date_asc' }, title: outingTitle(o), filename: `contrail-sortie-${o.id}` });
  root.querySelector('[data-edit]').onclick = () => {
    const sh = sheet({ title: esc(t('outing.edit')), body: `<div class="stack">
      <label class="field"><span>${esc(t('outing.name'))}</span><input data-name maxlength="120" value="${esc(o.name || '')}" placeholder="${esc(t('outing.name_ph'))}"></label>
      <label class="toggle-row"><span class="t">${esc(t('outing.airshow'))}<span class="small muted" style="display:block">${esc(t('outing.airshow_hint'))}</span></span><span class="switch"><input type="checkbox" data-kind ${air ? 'checked' : ''}><span></span></span></label>
      <div class="field-row"><label class="field"><span>${esc(t('outing.from'))}</span><input type="date" data-day value="${o.day}"></label>
        <label class="field"><span>${esc(t('outing.to'))}</span><input type="date" data-end value="${o.end_day || o.day}"></label></div>
      <label class="field"><span>${esc(t('outing.notes'))}</span><textarea data-notes rows="5">${esc(o.notes || '')}</textarea></label>
      <button class="btn primary" data-save>${esc(t('common.save'))}</button>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${o.mergeable.length ? `<button class="btn" data-merge2>${icon('git-merge', '', 16)} ${esc(t('outing.merge'))}</button>` : ''}
        ${o.end_day ? `<button class="btn" data-split>${icon('split', '', 16)} ${esc(t('outing.split'))}</button>` : ''}
        ${!o.n ? `<button class="btn danger" data-del>${icon('trash-2', '', 16)} ${esc(t('common.delete'))}</button>` : ''}</div></div>` });
    const $ = (k) => sh.body.querySelector(`[data-${k}]`);
    $('day').onchange = () => { if ($('end').value < $('day').value) $('end').value = $('day').value; };
    $('save').onclick = async () => {
      try {
        await api(`/api/outings/${o.id}`, { method: 'PUT', body: { name: $('name').value, notes: $('notes').value, kind: $('kind').checked ? 'airshow' : 'outing', day: $('day').value, end_day: $('end').value } });
        sh.close(); toast(esc(t('common.saved')), { type: 'success' }); reload();
      } catch (e) { errorToast(e); }
    };
    $('merge2')?.addEventListener('click', () => { sh.close(); mergeSheet(); });
    $('split')?.addEventListener('click', async () => {
      if (!(await confirmDialog(t('outing.split_confirm'), { ok: t('outing.split') }))) return;
      try { await api(`/api/outings/${o.id}/split`, { method: 'POST' }); sh.close(); toast(esc(t('outing.splitted')), { type: 'success' }); location.hash = '#/outings'; } catch (e) { errorToast(e); }
    });
    $('del')?.addEventListener('click', async () => {
      if (!(await confirmDialog(t('outing.delete_confirm'), { danger: true, ok: t('common.delete') }))) return;
      try { await api(`/api/outings/${o.id}`, { method: 'DELETE' }); sh.close(); location.hash = '#/outings'; } catch (e) { errorToast(e); }
    });
  };
}
