// Traqueur de livrées spéciales, groupées par catégorie
import { api } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, spotTile, emptyState, pageHead } from '../ui.js';

const ICONS = { retro: 'history', alliance: 'users', commemorative: 'sparkles', logojet: 'flag', cause: 'heart', special: 'palette' };

export async function render(root) {
  const groups = await api('/api/liveries');
  const total = groups.reduce((s, g) => s + g.count, 0);
  let active = '';
  const draw = () => {
    root.innerHTML = `
      ${pageHead(esc(t('nav.liveries')), { sub: esc(t('livery.sub', { n: total })) })}
      ${groups.length ? `<div class="chips scroll" style="margin-bottom:16px">
        <button class="chip ${!active ? 'on' : ''}" data-c="">${esc(t('common.all'))} · ${total}</button>
        ${groups.map((g) => `<button class="chip ${active === g.category ? 'on' : ''}" data-c="${g.category}">${icon(ICONS[g.category], '', 14)} ${esc(t(`livery.${g.category}`))} · ${g.count}</button>`).join('')}</div>
        ${groups.filter((g) => !active || g.category === active).map((g) => `
          <div class="section"><h2>${icon(ICONS[g.category], '', 20)} ${esc(t(`livery.${g.category}`))}</h2><span class="muted small">${esc(t('livery.unique', { n: g.unique }))}</span></div>
          <div class="gallery">${g.items.map((s) => spotTile({ ...s, owner: s.livery })).join('')}</div>`).join('')}`
        : `<div class="card">${emptyState('palette', t('livery.empty'), t('livery.empty_text'))}</div>`}`;
    root.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { active = b.dataset.c; draw(); }));
  };
  draw();
}
