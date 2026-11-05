// Wishlist : appareils, modèles, compagnies, livrées, aéroports, événements… à voir ou à photographier
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtDate, fmtNum, fmtRelative, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput } from '../lib/fields.js';
import { loadTypes, typeList } from '../lib/shapes.js';
import { esc, toast, errorToast, emptyState, pageHead, confirmDialog, sheet, menu } from '../ui.js';

export const KINDS = ['aircraft', 'type', 'airline', 'livery', 'airport', 'event', 'other'];
export const KIND_ICON = { aircraft: 'plane', type: 'layers', airline: 'building-2', livery: 'palette', airport: 'map-pin', event: 'calendar-days', other: 'sparkles' };
const PREF = 'contrail.wish';

const flames = (n) => `<span class="wish-prio p${n}" title="${esc(t(`wish.prio.${n}`))}">${[1, 2, 3].map((i) => icon('flame', i <= n ? 'on' : '', 14)).join('')}</span>`;

export async function render(root) {
  await loadTypes();
  let items = await api('/api/wishes');
  let f = { kind: 'all', state: 'open', q: '' };
  try { f = { ...f, ...JSON.parse(localStorage.getItem(PREF) || '{}'), q: '' }; } catch { /* préférences indisponibles */ }
  const save = () => { try { localStorage.setItem(PREF, JSON.stringify({ kind: f.kind, state: f.state })); } catch { /* stockage indisponible */ } };
  const reload = async () => { items = await api('/api/wishes'); draw(); };

  root.innerHTML = `
    ${pageHead(esc(t('nav.watchlist')), { sub: '<span data-sub>&nbsp;</span>', actions: `
      <button class="btn" data-check title="${esc(t('wish.check_now'))}">${icon('refresh-cw', '', 18)} <span class="hide-sm">${esc(t('watch.check_now'))}</span></button>
      <a class="btn hide-sm" href="/api/wishes/export.csv" download>${icon('download', '', 18)} ${esc(t('wish.export'))}</a>
      <button class="btn primary" data-add>${icon('plus', '', 18)} ${esc(t('wish.add'))}</button>` })}
    <div data-kpis></div>
    <div class="wish-filters">
      <div class="chips scroll" data-kinds></div>
      <div class="wish-filters-row">
        <input class="input" type="search" data-q placeholder="${esc(t('wish.search'))}">
        <div class="seg" data-state></div>
      </div>
    </div>
    <div data-list></div>
    <p class="tiny muted" style="margin-top:16px">${esc(t('watch.about', { n: store.settings.watch_interval_min || 5 }))}</p>`;

  // ------------------------------------------------------------------ rendu
  const sub = (w) => {
    const bits = [];
    if (w.kind === 'aircraft') { bits.push(w.aircraft, w.owner); } else if (w.kind === 'type') { bits.push(w.value, w.family ? t('wish.family_short') : null); } else if (w.kind === 'airline') { bits.push(w.value && w.value !== w.title ? w.value : null); } else if (w.kind === 'livery') { bits.push(w.airline_key); } else if (w.kind === 'airport') { bits.push(w.value); } else if (w.kind === 'event') { bits.push(w.place, w.airport); }
    if (w.note) bits.push(w.note);
    return bits.filter(Boolean).join(' · ');
  };

  const when = (w) => {
    if (w.kind !== 'event') return '';
    const a = fmtDate(w.start_date, { time: false, short: true }), b = w.end_date && w.end_date !== w.start_date ? fmtDate(w.end_date, { time: false, short: true }) : null;
    const range = b ? `${a} → ${b}` : a;
    let cd;
    if (w.ongoing) cd = `<span class="badge green">${esc(t('wish.badge.ongoing'))}</span>`;
    else if (w.days_to_start === 0) cd = `<span class="badge green">${esc(t('wish.badge.today'))}</span>`;
    else if (w.days_to_start > 0) cd = `<span class="badge accent">${esc(t('wish.badge.in_days', { n: w.days_to_start }))}</span>`;
    else cd = `<span class="badge">${esc(t('wish.badge.over'))}</span>`;
    return `<div class="small" style="margin-top:4px">${icon('calendar', '', 14)} ${esc(range)} ${cd}</div>`;
  };

  const progress = (w) => {
    if (w.kind === 'event' || w.kind === 'other' || (w.kind === 'aircraft' && w.auto_complete === 0)) return '';
    if (w.goal_count <= 1 && w.status === 'done') return '';
    const pct = Math.min(100, Math.round((w.progress / w.goal_count) * 100));
    if (w.goal_count <= 1 && !w.progress) return '';
    return `<div class="progress" style="margin-top:8px"><i style="width:${pct}%"></i></div>
      <div class="tiny muted" style="margin-top:3px">${esc(t('wish.progress', { n: fmtNum(w.progress), total: fmtNum(w.goal_count) }))}</div>`;
  };

  const badges = (w) => {
    const b = [];
    if (w.airborne) b.push(`<span class="badge green">${icon('plane-takeoff', '', 12)} ${esc(t('watch.airborne'))}</span>`);
    if (w.status === 'done') b.push(`<span class="badge accent">${icon('circle-check', '', 12)} ${esc(t('wish.badge.done_on', { date: fmtDate(w.done_at, { time: false, short: true }) }))}</span>`);
    if (w.track && w.status === 'open' && !w.airborne) b.push(`<span class="badge">${icon('radar', '', 12)} ${esc(w.last_seen_at ? t('watch.seen', { when: fmtRelative(w.last_seen_at) }) : t('watch.not_seen'))}</span>`);
    if (w.kind !== 'event' && w.end_date && w.status === 'open') {
      b.push(w.days_left < 0 ? `<span class="badge rose">${esc(t('wish.badge.late'))}</span>` : `<span class="badge">${icon('clock', '', 12)} ${esc(t('wish.badge.deadline', { date: fmtDate(w.end_date, { time: false, short: true }) }))}</span>`);
    }
    if (w.kind === 'aircraft' && w.spotted) b.push(`<span class="badge accent">${icon('camera', '', 11)} ${w.spotted}</span>`);
    if (w.kind === 'aircraft' && w.country) b.push(flag(w.country));
    return b.length ? `<div class="row wrap" style="gap:6px;margin-top:6px">${b.join('')}</div>` : '';
  };

  const card = (w, { child = false } = {}) => {
    const lead = w.thumb ? `<img class="thumb" src="${mediaUrl('thumbs', w.thumb)}" alt="">` : `<div class="wish-ic k-${w.kind}">${icon(KIND_ICON[w.kind], '', 22)}</div>`;
    return `<div class="card wish ${w.status === 'done' ? 'done' : ''} ${child ? 'child' : ''}" data-id="${w.id}">
      ${lead}
      <div class="grow" style="min-width:0">
        <div class="row between" style="gap:8px"><b class="ellipsis ${w.kind === 'aircraft' ? 'mono' : ''}">${esc(w.title)}</b>${flames(w.priority)}</div>
        <div class="small muted ellipsis">${esc(sub(w))}</div>
        ${when(w)}${progress(w)}${badges(w)}
      </div>
      <div class="wish-act">
        ${w.status === 'open' ? `<button class="btn-icon" data-done title="${esc(t('wish.menu.done'))}">${icon('check', '', 18)}</button>` : `<button class="btn-icon" data-reopen title="${esc(t('wish.menu.reopen'))}">${icon('rotate-ccw', '', 18)}</button>`}
        <button class="btn-icon" data-menu aria-label="${esc(t('common.more'))}">${icon('ellipsis', '', 18)}</button>
      </div></div>`;
  };

  function drawKpis() {
    const open = items.filter((w) => w.status === 'open');
    const year = String(new Date().getFullYear());
    const k = [
      ['star', open.length, t('wish.kpi.open')],
      ['circle-check', items.filter((w) => w.status === 'done' && (w.done_at || '').startsWith(year)).length, t('wish.kpi.done_year')],
      ['calendar-days', open.filter((w) => w.kind === 'event' && !w.past).length, t('wish.kpi.events')],
      ['plane-takeoff', open.filter((w) => w.airborne).length, t('wish.kpi.airborne')],
    ];
    root.querySelector('[data-kpis]').innerHTML = `<div class="grid kpis wish-kpis">${k.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`;
    root.querySelector('[data-sub]').textContent = t('wish.sub');
  }

  function draw() {
    drawKpis();
    const counts = Object.fromEntries(KINDS.map((k) => [k, items.filter((w) => w.kind === k && (f.state === 'all' || w.status === f.state)).length]));
    root.querySelector('[data-kinds]').innerHTML = [['all', t('common.all'), null], ...KINDS.map((k) => [k, t(`wish.k.${k}`), KIND_ICON[k]])]
      .map(([k, label, ic]) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-kind="${k}">${ic ? icon(ic, '', 14) : ''} ${esc(label)}${k !== 'all' && counts[k] ? ` <span class="tiny muted">${counts[k]}</span>` : ''}</button>`).join('');
    root.querySelector('[data-state]').innerHTML = ['open', 'done', 'all'].map((s) => `<button data-s="${s}" class="${f.state === s ? 'on' : ''}">${esc(t(`wish.s.${s}`))}</button>`).join('');

    const q = f.q.trim().toLowerCase();
    const pass = (w) => (f.kind === 'all' || w.kind === f.kind) && (f.state === 'all' || w.status === f.state)
      && (!q || `${w.title} ${w.value || ''} ${w.note || ''} ${w.place || ''}`.toLowerCase().includes(q));
    const children = new Map();
    for (const w of items) if (w.parent_id) { (children.get(w.parent_id) || children.set(w.parent_id, []).get(w.parent_id)).push(w); }
    const shown = items.filter(pass);
    const events = shown.filter((w) => w.kind === 'event').sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.start_date || '').localeCompare(b.start_date || ''));
    const rest = shown.filter((w) => w.kind !== 'event' && !(w.parent_id && items.some((p) => p.id === w.parent_id && pass(p))))
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.priority - a.priority || (b.created_at || '').localeCompare(a.created_at || ''));
    const list = root.querySelector('[data-list]');
    if (!items.length) {
      list.innerHTML = `<div class="card">${emptyState('star', t('wish.empty'), t('wish.empty_text'), `<button class="btn primary" data-add2>${icon('plus', '', 18)} ${esc(t('wish.add'))}</button>`)}</div>`;
    } else if (!shown.length) {
      list.innerHTML = `<p class="muted" style="padding:20px 0">${esc(t('wish.none_here'))}</p>`;
    } else {
      list.innerHTML = `${events.length ? `<div class="section"><h2>${esc(t('wish.events'))}</h2></div>
        <div class="grid two">${events.map((w) => `<div class="wish-group">${card(w)}${(children.get(w.id) || []).map((c) => card(c, { child: true })).join('')}</div>`).join('')}</div>` : ''}
        ${rest.length ? `<div class="section"><h2>${esc(t('wish.wishes'))}</h2><span class="muted small">${rest.length}</span></div>
        <div class="grid two">${rest.map((w) => card(w)).join('')}</div>` : ''}`;
    }
    bind();
  }

  // ------------------------------------------------------------------ actions
  const byId = (id) => items.find((w) => w.id === Number(id));
  const afterDone = (r) => { if (r.status === 'done') toast(esc(t('wish.done_toast', { title: r.title })), { type: 'success' }); };

  function bind() {
    root.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { f.kind = b.dataset.kind; save(); draw(); }));
    root.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { f.state = b.dataset.s; save(); draw(); }));
    root.querySelector('[data-add2]')?.addEventListener('click', () => editor());
    root.querySelectorAll('.wish[data-id]').forEach((node) => {
      const w = byId(node.dataset.id);
      node.querySelector('[data-done]')?.addEventListener('click', async () => { await api(`/api/wishes/${w.id}/done`, { method: 'POST' }).catch(errorToast); await reload(); });
      node.querySelector('[data-reopen]')?.addEventListener('click', async () => { await api(`/api/wishes/${w.id}/reopen`, { method: 'POST' }).catch(errorToast); await reload(); });
      node.querySelector('[data-menu]')?.addEventListener('click', (e) => menu(e.currentTarget, [
        { icon: 'pencil', label: t('common.edit'), onClick: () => editor(w) },
        w.kind === 'event' && w.status === 'open' && { icon: 'plus', label: t('wish.menu.add_objective'), onClick: () => editor(null, { kind: 'type', parent_id: w.id }) },
        w.kind !== 'other' && w.kind !== 'event' && { icon: 'camera', label: t('wish.menu.spots'), onClick: () => spotsSheet(w) },
        w.kind === 'event' && { icon: 'camera', label: t('wish.menu.spots'), onClick: () => spotsSheet(w) },
        w.kind === 'aircraft' && { icon: 'plane', label: t('wish.menu.airframe'), onClick: () => { location.hash = `#/airframe/${encodeURIComponent(w.value)}`; } },
        w.url && { icon: 'external-link', label: t('wish.menu.link'), onClick: () => window.open(w.url, '_blank', 'noopener') },
        w.last_spot && { icon: 'image', label: t('wish.menu.open_spot'), onClick: () => { location.hash = `#/spots/${w.last_spot.id}`; } },
        { icon: 'trash-2', label: t('common.delete'), danger: true, onClick: async () => {
          if (!(await confirmDialog(esc(t('wish.confirm_delete', { title: w.title })), { danger: true }))) return;
          await api(`/api/wishes/${w.id}`, { method: 'DELETE' }).catch(errorToast); await reload();
        } },
      ].filter(Boolean)));
    });
  }

  async function spotsSheet(w) {
    const r = await api(`/api/wishes/${w.id}/spots`).catch((e) => { errorToast(e); return null; });
    if (!r) return;
    const s = sheet({ title: esc(w.title), body: r.items.length
      ? `<p class="small muted" style="margin-bottom:10px">${esc(t('wish.spots_total', { count: r.total }))}</p><div class="list">${r.items.map((x) => `<a class="list-row" href="#/spots/${x.id}">
          ${x.thumb ? `<img class="thumb" src="${mediaUrl('thumbs', x.thumb)}" alt="">` : `<div class="thumb" style="display:grid;place-items:center">${icon('camera')}</div>`}
          <div class="grow"><div class="ttl mono">${esc(x.registration)}</div><div class="meta ellipsis">${esc([x.aircraft, x.airport, fmtDate(x.date, { time: false })].filter(Boolean).join(' · '))}</div></div></a>`).join('')}</div>`
      : `<p class="muted">${esc(t('wish.spots_none'))}</p>` });
    return s;
  }

  // ------------------------------------------------------------------ feuille d'ajout / modification
  async function editor(w = null, preset = {}) {
    const sg = await api('/api/wishes/suggestions').catch(() => ({ airlines: [], liveries: [], airports: [], events: [] }));
    const v = { kind: 'aircraft', priority: 2, goal_count: 1, auto_complete: 1, track: 1, notify: 1, remind_days: 7, family: 0, ...(w || {}), ...preset };
    const val = (k) => esc(v[k] ?? '');
    const types = typeList();
    const s = sheet({ wide: true, title: esc(t(w ? 'wish.edit' : 'wish.add')), body: `
      <form class="stack" data-form style="gap:14px">
        <div class="wish-kinds" data-kinds-pick>${KINDS.map((k) => `<button type="button" class="wish-kind ${v.kind === k ? 'on' : ''}" data-k="${k}">${icon(KIND_ICON[k], '', 22)}<b>${esc(t(`wish.k.${k}`))}</b><small>${esc(t(`wish.kd.${k}`))}</small></button>`).join('')}</div>

        <label class="field" data-for="aircraft"><span>${esc(t('wish.f.registration'))}</span>
          <input class="mono" name="reg" value="${v.kind === 'aircraft' ? val('value') : ''}" placeholder="F-HBXA" autocapitalize="characters" style="text-transform:uppercase"></label>
        <label class="field" data-for="type"><span>${esc(t('wish.f.type'))}</span>
          <input name="type" list="wl-types" value="${v.kind === 'type' ? val('value') : ''}" placeholder="${esc(t('wish.ph.type'))}" autocomplete="off">
          <datalist id="wl-types">${types.map((x) => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('')}</datalist></label>
        <label class="row" data-for="type" style="gap:10px;align-items:flex-start"><span class="switch"><input type="checkbox" name="family" ${v.family ? 'checked' : ''}><span></span></span>
          <span class="small"><b>${esc(t('wish.f.family'))}</b><br><span class="muted">${esc(t('wish.f.family_hint'))}</span></span></label>
        <label class="field" data-for="airline"><span>${esc(t('wish.f.airline'))}</span>
          <input name="airline" list="wl-air" value="${v.kind === 'airline' ? val('value') : ''}" placeholder="${esc(t('wish.ph.airline'))}" autocomplete="off">
          <datalist id="wl-air">${sg.airlines.map((a) => `<option value="${esc(a.key)}">${esc(a.name || a.key)}</option>`).join('')}</datalist></label>
        <label class="field" data-for="livery"><span>${esc(t('wish.f.livery'))}</span>
          <input name="livery" list="wl-liv" value="${v.kind === 'livery' ? val('value') : ''}" placeholder="${esc(t('wish.ph.livery'))}" autocomplete="off">
          <datalist id="wl-liv">${sg.liveries.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></label>
        <label class="field" data-for="livery"><span>${esc(t('wish.f.airline_opt'))}</span>
          <input name="airline_key" list="wl-air" value="${val('airline_key')}" autocomplete="off"></label>
        <label class="field" data-for="airport"><span>${esc(t('wish.f.airport'))}</span>
          <div class="input-wrap"><input class="mono" name="apt" value="${v.kind === 'airport' ? val('value') : ''}" placeholder="LFBO" autocapitalize="characters" style="text-transform:uppercase"></div></label>

        <label class="field" data-for="event other"><span>${esc(t('wish.f.title'))}</span>
          <input name="title" value="${v.kind === 'event' || v.kind === 'other' ? val('title') : ''}" placeholder="${esc(t('wish.ph.event'))}"></label>
        <div class="field-row" data-for="event">
          <label class="field"><span>${esc(t('wish.f.start'))}</span><input type="date" name="start_date" value="${val('start_date')}"></label>
          <label class="field"><span>${esc(t('wish.f.end'))}</span><input type="date" name="end_date" value="${val('end_date')}"></label></div>
        <div class="field-row" data-for="event">
          <label class="field"><span>${esc(t('wish.f.place'))}</span><input name="place" value="${val('place')}"></label>
          <label class="field"><span>${esc(t('wish.f.event_airport'))}</span><div class="input-wrap"><input class="mono" name="eapt" value="${val('airport')}" placeholder="LFFQ" style="text-transform:uppercase"></div></label></div>
        <div class="field-row" data-for="event">
          <label class="field"><span>${esc(t('wish.f.url'))}</span><input type="url" name="url" value="${val('url')}" placeholder="https://"></label>
          <label class="field"><span>${esc(t('wish.f.remind'))}</span><input type="number" min="0" max="60" name="remind_days" value="${v.remind_days}"></label></div>

        <div class="field-row">
          <label class="field" data-for="type airline livery airport event"><span>${esc(t('wish.f.goal'))}</span><input type="number" min="1" max="999" name="goal_count" value="${v.goal_count}"></label>
          <label class="field"><span>${esc(t('wish.f.priority'))}</span><select name="priority">${[1, 2, 3].map((p) => `<option value="${p}" ${Number(v.priority) === p ? 'selected' : ''}>${esc(t(`wish.prio.${p}`))}</option>`).join('')}</select></label>
          <label class="field" data-not="event"><span>${esc(t('wish.f.deadline'))}</span><input type="date" name="deadline" value="${v.kind === 'event' ? '' : val('end_date')}"></label></div>
        <label class="field" data-not="event"><span>${esc(t('wish.f.parent'))}</span><select name="parent_id"><option value="">—</option>
          ${sg.events.filter((e) => !w || e.id !== w.id).map((e) => `<option value="${e.id}" ${Number(v.parent_id) === e.id ? 'selected' : ''}>${esc(e.title)} · ${esc(fmtDate(e.start_date, { time: false, short: true }))}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(t('wish.f.note'))}</span><textarea name="note" rows="2">${esc(v.note || '')}</textarea></label>

        <div class="stack" style="gap:10px">
          <label class="row" data-for="aircraft" style="gap:10px"><span class="switch"><input type="checkbox" name="track" ${v.track ? 'checked' : ''}><span></span></span><span class="small">${esc(t('wish.f.track'))}</span></label>
          <label class="row" data-for="aircraft type airline livery airport" style="gap:10px;align-items:flex-start"><span class="switch"><input type="checkbox" name="auto_complete" ${v.auto_complete ? 'checked' : ''}><span></span></span><span class="small"><b>${esc(t('wish.f.auto'))}</b><br><span class="muted">${esc(t('wish.f.auto_hint'))}</span></span></label>
          <label class="row" data-for="aircraft type airline livery airport event" style="gap:10px;align-items:flex-start"><span class="switch"><input type="checkbox" name="count_existing" ${w && !w.since ? 'checked' : ''}><span></span></span><span class="small"><b>${esc(t('wish.f.existing'))}</b><br><span class="muted">${esc(t('wish.f.existing_hint'))}</span></span></label>
          <label class="row" style="gap:10px"><span class="switch"><input type="checkbox" name="notify" ${v.notify ? 'checked' : ''}><span></span></span><span class="small">${esc(t('wish.f.notify'))}</span></label>
        </div>
        <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="btn" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${icon('check', '', 18)} ${esc(t('common.save'))}</button></div>
      </form>` });

    const form = s.body.querySelector('[data-form]');
    form.querySelectorAll('[data-close]').forEach((b) => (b.onclick = s.close));
    airportInput(form.apt);
    airportInput(form.eapt);
    let kind = v.kind;
    const applyKind = () => {
      form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = !n.dataset.for.split(' ').includes(kind); });
      form.querySelectorAll('[data-not]').forEach((n) => { n.hidden = n.dataset.not.split(' ').includes(kind); });
      s.body.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
    };
    s.body.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { kind = b.dataset.k; applyKind(); }));
    applyKind();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const g = (n) => form[n]?.value?.trim() || null;
      const body = {
        kind, note: g('note'), priority: Number(form.priority.value), goal_count: Number(form.goal_count.value) || 1,
        notify: form.notify.checked, auto_complete: form.auto_complete.checked, track: form.track.checked, family: form.family.checked,
        count_existing: form.count_existing.checked, parent_id: form.parent_id.value ? Number(form.parent_id.value) : null,
      };
      if (kind === 'aircraft') body.value = g('reg');
      if (kind === 'type') body.value = g('type');
      if (kind === 'airline') body.value = g('airline');
      if (kind === 'livery') { body.value = g('livery'); body.airline_key = g('airline_key'); }
      if (kind === 'airport') body.value = g('apt');
      if (kind === 'event' || kind === 'other') body.title = g('title');
      if (kind === 'event') Object.assign(body, { start_date: g('start_date'), end_date: g('end_date'), place: g('place'), airport: g('eapt'), url: g('url'), remind_days: Number(form.remind_days.value) || 0, parent_id: null });
      else body.end_date = g('deadline');
      if (!w && preset.parent_id && kind !== 'event') body.parent_id = body.parent_id || preset.parent_id;
      try {
        const r = await api(w ? `/api/wishes/${w.id}` : '/api/wishes', { method: w ? 'PUT' : 'POST', body });
        s.close();
        toast(esc(t(r.status === 'done' ? 'wish.already_done' : w ? 'wish.updated' : 'wish.added')), { type: 'success' });
        await reload();
      } catch (err) { errorToast(err); }
    };
  }

  // ------------------------------------------------------------------ branchements globaux
  root.querySelector('[data-add]').onclick = () => editor();
  root.querySelector('[data-q]').oninput = (e) => { f.q = e.target.value; draw(); };
  root.querySelector('[data-check]').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await api('/api/wishes/check', { method: 'POST' });
      items = r.items; draw();
      toast(esc(t('wish.checked', { alerts: r.alerts, done: r.done })), { type: 'success' });
    } catch (err) { errorToast(err); } finally { b.disabled = false; }
  };
  draw();
}

/** Ajout rapide depuis une autre page (fiche appareil, flotte, radar…). */
export async function quickAdd(body, { silent = false } = {}) {
  try {
    const r = await api('/api/wishes', { method: 'POST', body });
    if (!silent) toast(esc(t('wish.added')), { type: 'success', action: t('wish.open'), onAction: () => { location.hash = '#/wishlist'; } });
    return r;
  } catch (e) { errorToast(e); return null; }
}
