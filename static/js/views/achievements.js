// Succès à débloquer
import { api } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { esc, pageHead } from '../ui.js';

export async function render(root) {
  const res = await api('/api/achievements');
  const pct = Math.round((res.unlocked / res.total) * 100);
  const cats = ['spotting', 'collection', 'field', 'flights'];
  root.innerHTML = `
    ${pageHead(esc(t('nav.achievements')), { sub: esc(t('dash.ach_progress', { n: res.unlocked, total: res.total })), actions: `<div class="ring lg" style="--p:${pct}"><b>${pct}%</b></div>` })}
    ${cats.map((c) => {
      const items = res.items.filter((a) => a.category === c).sort((a, b) => (b.unlocked_at ? 1 : 0) - (a.unlocked_at ? 1 : 0) || b.progress - a.progress);
      if (!items.length) return '';
      return `<div class="section"><h2>${esc(t(`ach.cat.${c}`))}</h2><span class="muted small">${items.filter((a) => a.unlocked_at).length}/${items.length}</span></div>
        <div class="grid two">${items.map((a) => `<div class="card ach ${a.unlocked_at ? 'unlocked' : 'locked'}">
          <div class="em">${a.icon}</div>
          <div class="grow"><b>${esc(t(`ach.${a.code}.name`))}</b><div class="small muted">${esc(t(`ach.${a.code}.desc`, { n: fmtNum(a.target) }))}</div>
          ${a.unlocked_at ? `<div class="tiny" style="color:var(--accent);margin-top:4px">${esc(t('ach.unlocked_on', { date: fmtDate(a.unlocked_at, { time: false }) }))}</div>`
            : `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(a.progress * 100)}%"></i></div><div class="tiny muted" style="margin-top:3px">${fmtNum(a.value)} / ${fmtNum(a.target)}</div>`}</div></div>`).join('')}</div>`;
    }).join('')}`;
}
