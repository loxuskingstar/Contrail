// Hub mobile « Plus »
import { store } from '../app.js';
import { t } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead } from '../ui.js';

export async function render(root) {
  const groups = [
    ['nav.g.collection', [['#/stats', 'chart-column', 'nav.stats'], ['#/fleets', 'building-2', 'nav.fleets', 'fleets'], ['#/liveries', 'palette', 'nav.liveries'], ['#/flights', 'ticket', 'nav.flights', 'flights']]],
    ['nav.g.field', [['#/radar', 'radar', 'nav.radar', 'radar'], ['#/locations', 'binoculars', 'nav.locations', 'locations'], ['#/wishlist', 'star', 'nav.watchlist', 'watchlist']]],
    ['nav.g.more', [['#/achievements', 'trophy', 'nav.achievements', 'gamification'], ['#/story', 'wand-sparkles', 'nav.story', 'gamification'], ['#/shares', 'share-2', 'nav.shares'], ['#/drafts', 'cloud-upload', 'nav.drafts'], ['#/settings', 'settings', 'nav.settings']]],
  ];
  root.innerHTML = `${pageHead(esc(t('nav.more')))}
    ${groups.map(([g, items]) => {
      const vis = items.filter((i) => !i[3] || store.mod(i[3]));
      return vis.length ? `<div class="section"><h2>${esc(t(g))}</h2></div><div class="grid kpis">${vis.map(([href, ic, key]) =>
        `<a class="card kpi" href="${href}" style="display:flex;flex-direction:column;gap:6px">${icon(ic, '', 26)}<b>${esc(t(key))}</b></a>`).join('')}</div>` : '';
    }).join('')}`;
}
