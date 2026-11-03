// Tableau de bord modulable (widgets)
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, fmtDate, fmtMonth, fmtRelative } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { achName } from '../lib/ach.js';
import { esc, sheet, spotTile, hbars, vbars, emptyState, toast } from '../ui.js';

export const WIDGETS = ['hero', 'quick', 'goals', 'recent', 'on_this_day', 'month_chart', 'top_types', 'achievements', 'watchlist', 'flights', 'map', 'sun'];

function greeting() {
  const h = new Date().getHours();
  return t(h < 6 ? 'dash.hello_night' : h < 12 ? 'dash.hello_morning' : h < 18 ? 'dash.hello_afternoon' : 'dash.hello_evening');
}

export async function render(root) {
  const d = await api('/api/dashboard');
  const widgets = (store.settings.dashboard_widgets || WIDGETS).filter((w) => WIDGETS.includes(w));
  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(greeting())}</h1><div class="sub">${esc(t('dash.sub', { n: fmtNum(d.totals.spots), m: fmtNum(d.month) }))}</div></div>
    <div class="actions"><button class="btn-icon glassy" data-custom title="${esc(t('dash.customize'))}">${icon('sliders-horizontal')}</button></div></header>
    <div class="stack" style="gap:16px" data-widgets></div>`;
  const box = root.querySelector('[data-widgets]');
  const cleanups = [];
  for (const w of widgets) {
    const html = renderWidget(w, d);
    if (!html) continue;
    const node = document.createElement('section');
    node.dataset.widget = w;
    node.innerHTML = html;
    box.append(node);
    if (w === 'map') cleanups.push(await mountMap(node));
    if (w === 'sun') mountSun(node);
    if (w === 'goals') node.querySelector('[data-goals]')?.addEventListener('click', (e) => { e.preventDefault(); goalSheet(); });
  }
  if (!d.totals.spots) {
    box.insertAdjacentHTML('afterbegin', `<div class="card">${emptyState('camera', t('dash.empty_title'), t('dash.empty_text'),
      `<div class="row wrap" style="justify-content:center"><a class="btn primary" href="#/spots/new">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>
       <a class="btn" href="#/settings/data">${icon('upload', '', 18)} ${esc(t('dash.import'))}</a>
       ${store.session.profile !== 'test' ? `<button class="btn ghost" data-try-test>${icon('wand-sparkles', '', 18)} ${esc(t('dash.try_test'))}</button>` : ''}</div>`)}</div>`);
    box.querySelector('[data-try-test]')?.addEventListener('click', async () => (await import('../app.js')).switchSession('test'));
  }
  root.querySelector('[data-custom]').onclick = () => customize(widgets);
  return () => cleanups.forEach((c) => c?.());
}

function renderWidget(w, d) {
  const T = d.totals;
  switch (w) {
    case 'hero': {
      const h = d.hero;
      const strip = `<div class="glass-strip">
        <div><b>${fmtNum(T.spots)}</b><small>${esc(t('stat.spots'))}</small></div>
        <div><b>${fmtNum(T.regs)}</b><small>${esc(t('stat.regs'))}</small></div>
        <div><b>${fmtNum(T.types)}</b><small>${esc(t('stat.types'))}</small></div>
        <div><b>${fmtNum(T.airlines)}</b><small>${esc(t('stat.airlines'))}</small></div>
        <div><b>${fmtNum(T.countries)}</b><small>${esc(t('stat.countries'))}</small></div></div>`;
      if (!h) {
        // Pas encore de photo : les chiffres clés suffisent, sans en-tête décoratif
        const k = [['camera', T.spots, 'stat.spots'], ['scan-line', T.regs, 'stat.regs'], ['plane', T.types, 'stat.types'], ['building-2', T.airlines, 'stat.airlines'], ['flag', T.countries, 'stat.countries']];
        return `<div class="grid kpis">${k.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${fmtNum(v)}</div><div class="l">${esc(t(l))}</div></div>`).join('')}</div>`;
      }
      return `<a class="hero" href="#/spots/${h.id_spotting}"><img src="${mediaUrl('images', h.image)}" alt="">
        <div class="in"><div class="small" style="opacity:.85">${esc(h.airport || '')} · ${fmtDate(h.date, { time: false })}</div>
        <h2 class="mono">${esc(h.registration)}</h2><div style="opacity:.9">${esc(h.aircraft || '')}${h.owner ? ' · ' + esc(h.owner) : ''}</div>${strip}</div></a>`;
    }
    case 'quick': {
      const items = [
        ['#/spots/new', 'camera', t('spot.new')],
        store.mod('flights') && ['#/flights/new', 'ticket', t('flight.new')],
        store.mod('radar') && ['#/radar', 'radar', t('nav.radar')],
        store.mod('gamification') && ['#/story', 'wand-sparkles', t('nav.story')],
      ].filter(Boolean);
      return `<div class="grid kpis">${items.map(([href, ic, lbl]) => `<a class="card kpi" href="${href}" style="display:flex;align-items:center;gap:10px">${icon(ic, '', 22)}<b style="font-size:14.5px">${esc(lbl)}</b></a>`).join('')}</div>`;
    }
    case 'recent':
      if (!d.recent.length) return '';
      return `<div class="section"><h2>${esc(t('dash.recent'))}</h2><a href="#/spots">${esc(t('common.see_all'))}</a></div>
        <div class="hscroll">${d.recent.map((s) => spotTile(s)).join('')}</div>`;
    case 'on_this_day':
      if (!d.on_this_day.length) return '';
      return `<div class="section"><h2>${icon('history', '', 20)} ${esc(t('dash.on_this_day'))}</h2></div>
        <div class="hscroll">${d.on_this_day.map((s) => spotTile(s)).join('')}</div>`;
    case 'goals': return goalsWidget(d);
    case 'month_chart': {
      if (!d.months.length) return '';
      const map = Object.fromEntries(d.months.map((m) => [m.k, m.n]));
      const now = new Date();
      const rows = [];
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        rows.push({ k, n: map[k] || 0 });
      }
      return `<div class="card"><div class="card-title">${esc(t('dash.last12'))}<a href="#/stats">${esc(t('nav.stats'))}</a></div>${vbars(rows, { label: (r) => fmtMonth(r.k), highlightLast: true })}</div>`;
    }
    case 'top_types':
      if (!d.top_types.length) return '';
      return `<div class="card"><div class="card-title">${esc(t('dash.top_types'))}</div>${hbars(d.top_types, { label: (r) => esc(r.k), href: (r) => `#/spots?type=${encodeURIComponent(r.k)}` })}</div>`;
    case 'achievements': {
      if (!store.mod('gamification')) return '';
      const tot = d.achievements_total || {};
      const R = tot.rank || {};
      const pct = R.next_min ? Math.round((((tot.points || 0) - R.min) / (R.next_min - R.min)) * 100) : 100;
      return `<a class="card" href="#/achievements" style="display:flex;gap:16px;align-items:center">
        <div class="ring" style="--p:${pct}"><b>${R.level || 1}</b></div>
        <div class="grow" style="min-width:0"><div class="card-title" style="margin-bottom:4px">${esc(t('nav.achievements'))}</div>
        <div style="font-weight:700">${esc(t(`ach.rank.${R.key || 'novice'}`))} <span class="muted small">· ${fmtNum(tot.points || 0)} ${esc(t('ach.points'))}</span></div>
        <div class="muted small">${esc(t('dash.ach_progress', { n: tot.unlocked || 0, total: tot.total || 0 }))}</div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">${d.achievements.map((a) => `<span class="ach-medal t-${a.tier}" style="width:34px;height:34px;font-size:17px;border-radius:10px" title="${esc(achName(a.code, a.level))}"><span>${a.icon}</span></span>`).join('')}</div></div>
        ${icon('chevron-right')}</a>`;
    }
    case 'watchlist':
      if (!store.mod('watchlist') || !d.watchlist.length) return '';
      return `<div class="card"><div class="card-title">${esc(t('nav.watchlist'))}<a href="#/watchlist">${esc(t('common.see_all'))}</a></div>
        <div class="list">${d.watchlist.map((w) => `<a class="list-row" href="#/airframe/${encodeURIComponent(w.registration)}">
          <span class="legend-dot" style="background:${w.airborne ? 'var(--ok)' : 'var(--muted)'}"></span>
          <b class="mono grow">${esc(w.registration)}</b>
          <span class="small muted">${w.airborne ? esc(t('watch.airborne')) + (w.last_status?.callsign ? ' · ' + esc(w.last_status.callsign) : '') : (w.last_seen_at ? esc(t('watch.seen', { when: fmtRelative(w.last_seen_at) })) : esc(t('watch.not_seen')))}</span></a>`).join('')}</div></div>`;
    case 'flights':
      if (!store.mod('flights') || !d.flights.n) return '';
      return `<a class="card" href="#/flights" style="display:flex;gap:14px;align-items:center">${icon('globe', '', 34)}
        <div class="grow"><div class="card-title" style="margin-bottom:4px">${esc(t('nav.flights'))}</div>
        <div><b>${fmtNum(d.flights.n)}</b> ${esc(t('stat.flights_l'))} · <b>${fmtNum(Math.round(d.flights.km))}</b> km · ${esc(t('flight.earth_laps', { n: fmtNum(d.flights.km / 40075, { maximumFractionDigits: 2 }) }))}</div></div>${icon('chevron-right')}</a>`;
    case 'map':
      if (!d.totals.spots) return '';
      return `<div class="card flush"><div class="map" style="height:280px;border-radius:0" data-map></div></div>`;
    case 'sun':
      if (!store.mod('locations')) return '';
      return `<div class="card" data-sun hidden><div class="card-title">${esc(t('dash.sun_today'))}<a href="#/locations">${esc(t('nav.locations'))}</a></div><div data-sun-body></div></div>`;
  }
  return '';
}

async function mountMap(node) {
  const { createMap } = await import('../lib/map.js');
  const res = await api('/api/spots/map');
  const mp = createMap(node.querySelector('[data-map]'), { scrollZoom: false }).then((m) => {
    m.clusters('spots', res.places.map((c) => ({ lat: c.lat, lng: c.lng, count: c.count, label: c.count > 99 ? '99+' : c.count,
      onClick: () => (location.hash = c.location_id ? `#/spots?location_id=${c.location_id}` : `#/spots?airport=${encodeURIComponent(c.airport || '')}`),
      title: `${c.name || c.airport || ''} · ${t('dash.n_spots', { n: c.count })}` })));
    m.fit(res.places.map((c) => [c.lat, c.lng]), { maxZoom: 8 });
    return m;
  }).catch(() => null);
  return () => mp.then((m) => m?.remove());
}

async function mountSun(node) {
  const locs = await api('/api/locations').catch(() => []);
  const useful = locs.filter((l) => l.today?.windows?.length);
  if (!useful.length) return;
  node.querySelector('[data-sun]').hidden = false;
  node.querySelector('[data-sun-body]').innerHTML = `<div class="list">${useful.slice(0, 5).map((l) => `
    <div class="list-row">${icon('sun', '', 20)}<div class="grow"><b>${esc(l.name)}</b> <span class="muted small">${esc(l.airport || '')}</span>
    <div class="small">${l.today.windows.map((w) => `${w.start}–${w.end}`).join(' · ')}</div></div></div>`).join('')}</div>`;
}

function customize(current) {
  const order = [...current, ...WIDGETS.filter((w) => !current.includes(w))];
  const enabled = new Set(current);
  const s = sheet({ title: esc(t('dash.customize')), body: '' });
  const draw = () => {
    s.body.innerHTML = `<p class="muted small" style="margin-bottom:10px">${esc(t('dash.customize_hint'))}</p>
      <div class="stack" style="gap:6px">${order.map((w, i) => `<div class="widget-row" draggable="true" data-w="${w}">
        <span class="muted" style="cursor:grab">${icon('grip-vertical', '', 18)}</span>
        <span class="grow" style="font-weight:600">${esc(t(`widget.${w}`))}</span>
        <button class="btn-icon" data-up="${i}" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up', '', 16)}</button>
        <button class="btn-icon" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>${icon('arrow-down', '', 16)}</button>
        <label class="switch"><input type="checkbox" data-on="${w}" ${enabled.has(w) ? 'checked' : ''}><span></span></label></div>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn primary" data-save>${esc(t('common.save'))}</button></div>`;
    s.body.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); }));
    s.body.querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); }));
    s.body.querySelectorAll('[data-on]').forEach((c) => (c.onchange = () => (c.checked ? enabled.add(c.dataset.on) : enabled.delete(c.dataset.on))));
    let dragged = null;
    s.body.querySelectorAll('.widget-row').forEach((row) => {
      row.addEventListener('dragstart', () => { dragged = row.dataset.w; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', () => {
        const from = order.indexOf(dragged), to = order.indexOf(row.dataset.w);
        if (from < 0 || to < 0 || from === to) return;
        order.splice(to, 0, order.splice(from, 1)[0]);
        draw();
      });
    });
    s.body.querySelector('[data-save]').onclick = async () => {
      await store.saveSettings({ dashboard_widgets: order.filter((w) => enabled.has(w)) });
      s.close();
      toast(esc(t('common.saved')), { type: 'success' });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    };
  };
  draw();
}


// ------------------------------------------------------------------ objectifs de l'année
function goalsWidget(d) {
  const S = store.settings;
  const Y = d.year_totals || {};
  const goals = [['spots', S.goal_spots], ['types', S.goal_types], ['regs', S.goal_regs]].filter(([, g]) => g > 0);
  const today = new Date(d.today || Date.now());
  const start = new Date(today.getFullYear(), 0, 1), end = new Date(today.getFullYear() + 1, 0, 1);
  const elapsed = Math.max(1, (today - start) / 86400000 + 1), total = (end - start) / 86400000;
  const st = d.streak || {};
  const streak = st.current ? `<span class="badge accent">${icon('flame', '', 12)} ${esc(t('goal.streak', { n: st.current }))}</span>` : '';
  if (!goals.length) {
    return `<div class="card goal-empty"><span class="sm-kind">${icon('target', '', 18)}</span><div class="grow"><b>${esc(t('goal.title', { y: today.getFullYear() }))}</b>
      <div class="small muted">${esc(t('goal.empty'))}</div></div><button class="btn sm" data-goals>${esc(t('goal.set'))}</button></div>`;
  }
  const rows = goals.map(([k, g]) => {
    const v = Y[k] || 0;
    const pct = Math.min(100, Math.round((v / g) * 100));
    const expected = (g * elapsed) / total;              // où l'on devrait être aujourd'hui
    const projected = Math.round((v / elapsed) * total);  // projection au rythme actuel
    const left = Math.max(0, g - v), weeksLeft = Math.max(1, (total - elapsed) / 7);
    const ahead = v >= expected;
    const status = v >= g ? t('goal.reached') : ahead ? t('goal.ahead', { n: fmtNum(Math.round(v - expected)) }) : t('goal.behind', { n: fmtNum(Math.round(expected - v)) });
    return `<div class="goal-row">
      <div class="row between" style="gap:8px"><b>${esc(t(`goal.k_${k}`))}</b><span class="num"><b>${fmtNum(v)}</b><span class="muted"> / ${fmtNum(g)}</span></span></div>
      <div class="goal-bar ${v >= g ? 'done' : ahead ? 'ahead' : 'behind'}"><i style="width:${pct}%"></i><s style="left:${Math.min(100, (expected / g) * 100)}%" title="${esc(t('goal.pace_mark'))}"></s></div>
      <div class="row between tiny muted wrap" style="gap:6px"><span class="goal-st">${esc(status)}</span>
        <span>${v >= g ? '' : esc(t('goal.per_week', { n: fmtNum(Math.ceil(left / weeksLeft)) }))} · ${esc(t('goal.projection', { n: fmtNum(projected) }))}</span></div></div>`;
  }).join('');
  const vsLast = d.last_year_same_day ? Math.round((((Y.spots || 0) - d.last_year_same_day) / d.last_year_same_day) * 100) : null;
  return `<div class="card"><div class="card-title">${esc(t('goal.title', { y: today.getFullYear() }))}<a href="#" data-goals>${esc(t('common.edit'))}</a></div>
    <div class="row wrap" style="gap:6px;margin:-4px 0 10px">${streak}
      ${vsLast != null ? `<span class="badge ${vsLast >= 0 ? 'green' : ''}">${esc(t('goal.vs_last', { n: `${vsLast >= 0 ? '+' : ''}${vsLast}` }))}</span>` : ''}
      <span class="badge">${esc(t('goal.days', { n: Y.days || 0 }))}</span></div>
    <div class="stack" style="gap:14px">${rows}</div></div>`;
}

function goalSheet() {
  const S = store.settings;
  const s = sheet({ title: esc(t('goal.title', { y: new Date().getFullYear() })), body: `
    <p class="small muted" style="margin-bottom:12px">${esc(t('goal.hint'))}</p>
    <div class="stack">${['spots', 'types', 'regs'].map((k) => `<label class="field"><span>${esc(t(`goal.k_${k}`))}</span>
      <input type="number" min="0" step="1" inputmode="numeric" data-g="${k}" value="${S[`goal_${k}`] || ''}" placeholder="0"></label>`).join('')}</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" data-save>${esc(t('common.save'))}</button></div>` });
  s.body.querySelector('[data-save]').onclick = async () => {
    const patch = {};
    s.body.querySelectorAll('[data-g]').forEach((i) => (patch[`goal_${i.dataset.g}`] = Math.max(0, Math.round(Number(i.value) || 0))));
    await store.saveSettings(patch);
    s.close();
    location.reload();
  };
}
