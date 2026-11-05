// Succès : rang et points, séries à paliers (bronze → diamant), succès presque débloqués
import { api } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, sheet } from '../ui.js';
import { TIERS, roman } from '../lib/ach.js';

const CATS = ['all', 'spotting', 'collection', 'field', 'flights'];
const STATES = ['all', 'progress', 'done'];

export async function render(root) {
  const res = await api('/api/achievements');
  let cat = 'all', state = 'all';
  try { ({ cat = 'all', state = 'all' } = JSON.parse(localStorage.getItem('contrail.ach') || '{}')); } catch { /* préférences indisponibles */ }

  // Regroupement par série, paliers dans l'ordre
  const series = new Map();
  for (const a of res.items) {
    if (!series.has(a.series)) series.set(a.series, { key: a.series, icon: a.icon, category: a.category, levels: [] });
    series.get(a.series).levels.push(a);
  }
  for (const s of series.values()) {
    s.done = s.levels.filter((l) => l.unlocked_at).length;
    s.next = s.levels.find((l) => !l.unlocked_at) || null;
    s.value = s.levels[0].value;
    s.complete = !s.next;
    s.last = [...s.levels].reverse().find((l) => l.unlocked_at) || null;
  }
  const R = res.rank;
  const rankPct = R.next_min ? Math.round(((res.points - R.min) / (R.next_min - R.min)) * 100) : 100;
  const near = [...series.values()].filter((s) => s.next && s.next.progress > 0).sort((a, b) => b.next.progress - a.next.progress).slice(0, 4);

  const fmtVal = (s, v) => (['flight_km', 'airport_span', 'longest_flight'].includes(s.levels[0].metric) ? `${fmtNum(v)} km` : fmtNum(v));
  const pips = (s) => `<div class="ach-pips">${s.levels.map((l) => `<span class="pip t-${l.tier} ${l.unlocked_at ? 'on' : ''}" title="${esc(`${roman(l.level)} · ${fmtVal(s, l.target)} · ${t(`ach.tier.${l.tier}`)}`)}"></span>`).join('')}</div>`;
  const seriesCard = (s) => {
    const lvl = s.last ? s.last.level : 0;
    const tgt = s.next || s.levels[s.levels.length - 1];
    const tier = s.last?.tier || 'none';
    return `<div class="card ach-series ${s.complete ? 'complete' : ''} ${s.done ? '' : 'locked'}" data-series="${esc(s.key)}" role="button" tabindex="0" style="cursor:pointer">
      <div class="ach-medal t-${tier}"><span>${s.icon}</span>${lvl ? `<b>${roman(lvl)}</b>` : ''}</div>
      <div class="grow" style="min-width:0">
        <div class="row between" style="gap:8px"><b class="ellipsis">${esc(t(`ach.s.${s.key}.name`))}</b><span class="tiny muted nowrap">${s.done}/${s.levels.length}</span></div>
        <div class="small muted">${esc(s.complete ? t('ach.series_done') : t(`ach.s.${s.key}.desc`, { n: fmtVal(s, tgt.target), count: tgt.target }))}</div>
        ${s.complete ? `<div class="tiny" style="color:var(--accent);margin-top:6px">${esc(t('ach.unlocked_on', { date: fmtDate(s.last.unlocked_at, { time: false }) }))}</div>`
          : `<div class="progress t-${tgt.tier}" style="margin-top:8px"><i style="width:${Math.round(tgt.progress * 100)}%"></i></div>
             <div class="row between tiny muted" style="margin-top:4px"><span>${fmtVal(s, s.value)} / ${fmtVal(s, tgt.target)}</span><span class="tier-label t-${tgt.tier}">${esc(t(`ach.tier.${tgt.tier}`))} · +${tgt.points}</span></div>`}
        ${pips(s)}
      </div></div>`;
  };

  // Fiche détaillée d'une série : palier en cours, paliers précédents et suivants, progression
  const openSeries = (s) => {
    const next = s.next, last = s.last;
    const step = (l) => {
      const state = l.unlocked_at ? 'done' : l === next ? 'next' : 'todo';
      const left = Math.max(0, l.target - s.value);
      return `<div class="ach-step ${state}">
        <div class="ach-medal t-${l.tier} sm"><span>${s.icon}</span><b>${roman(l.level)}</b></div>
        <div class="grow" style="min-width:0">
          <div class="row between" style="gap:8px"><b>${esc(t(`ach.tier.${l.tier}`))} · ${roman(l.level)}</b>
            <span class="tiny muted nowrap">${esc(state === 'done' ? t('ach.step_done') : state === 'next' ? (last ? t('ach.step_next') : t('ach.step_first')) : t('ach.step_todo'))}</span></div>
          <div class="small muted">${esc(t(`ach.s.${s.key}.desc`, { n: fmtVal(s, l.target), count: l.target }))}</div>
          ${state === 'done' ? `<div class="tiny" style="color:var(--accent);margin-top:4px">${icon('check', '', 12)} ${esc(t('ach.unlocked_on', { date: fmtDate(l.unlocked_at, { time: false }) }))} · +${l.points}</div>`
            : `<div class="progress t-${l.tier}" style="margin-top:8px"><i style="width:${Math.round(l.progress * 100)}%"></i></div>
               <div class="row between tiny muted" style="margin-top:4px"><span>${fmtVal(s, s.value)} / ${fmtVal(s, l.target)} · ${Math.round(l.progress * 100)} %</span><span>${esc(t('ach.remaining', { n: fmtVal(s, left) }))} · +${l.points} ${esc(t('ach.points'))}</span></div>`}
        </div></div>`;
    };
    sheet({ title: esc(t(`ach.s.${s.key}.name`)), body: `<div class="stack" style="gap:10px">
      <div class="row" style="gap:14px"><div class="ach-medal t-${last?.tier || 'none'}"><span>${s.icon}</span>${last ? `<b>${roman(last.level)}</b>` : ''}</div>
        <div class="grow"><div class="small muted">${esc(t('ach.current_value'))}</div><div style="font-size:26px;font-weight:700">${fmtVal(s, s.value)}</div>
        <div class="tiny muted">${esc(t('ach.levels_done', { n: s.done, total: s.levels.length }))}${s.complete ? ' · ' + esc(t('ach.series_done')) : ''}</div></div></div>
      ${s.levels.map(step).join('')}</div>` });
  };

  const draw = () => {
    const list = [...series.values()].filter((s) => (cat === 'all' || s.category === cat)
      && (state === 'all' || (state === 'done' ? s.complete : !s.complete)));
    const groups = cat === 'all' ? ['spotting', 'collection', 'field', 'flights'] : [cat];
    root.innerHTML = `
      ${pageHead(esc(t('nav.achievements')), { sub: esc(t('dash.ach_progress', { n: res.unlocked, total: res.total })) })}
      <div class="card ach-rank">
        <div class="ach-rank-badge"><span>${icon('award', '', 30)}</span><b>${R.level}</b></div>
        <div class="grow" style="min-width:0">
          <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:700">${esc(t('ach.rank_title'))}</div>
          <div class="ach-rank-name">${esc(t(`ach.rank.${R.key}`))}</div>
          <div class="progress" style="margin:10px 0 6px"><i style="width:${rankPct}%"></i></div>
          <div class="row between small muted wrap" style="gap:6px"><span><b style="color:var(--text)">${fmtNum(res.points)}</b> / ${fmtNum(res.total_points)} ${esc(t('ach.points'))}</span>
            <span>${R.next ? esc(t('ach.to_next', { n: fmtNum(R.next_min - res.points), rank: t(`ach.rank.${R.next}`) })) : esc(t('ach.max_rank'))}</span></div>
        </div>
        <div class="ach-tiers">${TIERS.map((tr) => `<div class="t-${tr}"><span class="pip t-${tr} on"></span><b>${res.tiers[tr].unlocked}</b><small>/${res.tiers[tr].total}</small></div>`).join('')}</div>
      </div>
      ${near.length && state !== 'done' ? `<div class="section"><h2>${esc(t('ach.almost'))}</h2></div>
        <div class="grid two">${near.map(seriesCard).join('')}</div>` : ''}
      <div class="row between wrap" style="margin:22px 0 10px;gap:10px">
        <div class="chips scroll">${CATS.map((c) => `<button class="chip ${cat === c ? 'on' : ''}" data-cat="${c}">${esc(c === 'all' ? t('common.all') : t(`ach.cat.${c}`))}</button>`).join('')}</div>
        <div class="seg">${STATES.map((s) => `<button data-state="${s}" class="${state === s ? 'on' : ''}">${esc(t(`ach.state_${s}`))}</button>`).join('')}</div>
      </div>
      ${groups.map((g) => {
        const items = list.filter((s) => s.category === g).sort((a, b) => Number(a.complete) - Number(b.complete) || (b.next?.progress || 0) - (a.next?.progress || 0));
        if (!items.length) return '';
        const all = [...series.values()].filter((s) => s.category === g);
        const lv = all.reduce((n, s) => n + s.done, 0), tot = all.reduce((n, s) => n + s.levels.length, 0);
        return `<div class="section"><h2>${esc(t(`ach.cat.${g}`))}</h2><span class="muted small">${lv}/${tot}</span></div>
          <div class="grid two">${items.map(seriesCard).join('')}</div>`;
      }).join('') || `<p class="muted" style="padding:20px 0">${esc(t('ach.none_here'))}</p>`}`;
    root.querySelectorAll('[data-series]').forEach((c) => {
      const open = () => openSeries(series.get(c.dataset.series));
      c.onclick = open;
      c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
    root.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { cat = b.dataset.cat; save(); draw(); }));
    root.querySelectorAll('[data-state]').forEach((b) => (b.onclick = () => { state = b.dataset.state; save(); draw(); }));
  };
  const save = () => { try { localStorage.setItem('contrail.ach', JSON.stringify({ cat, state })); } catch { /* stockage indisponible */ } };
  draw();
}
