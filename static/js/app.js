// Contrail — amorçage, coquille de l'application, routeur et état partagé
import { api, setUnauthorizedHandler } from './api.js';
import { setLang, t, fmtRelative } from './i18n.js';
import { icon } from './lib/icons.js';
import { $, el, esc, toast, sheet, debounce } from './ui.js';
import { syncDrafts, countDrafts } from './offline.js';

// ---------------------------------------------------------------- état partagé
export const store = {
  settings: null,
  session: { profile: 'main' },
  config: null,
  tags: null,
  facets: null,
  async refreshTags() { this.tags = await api('/api/tags'); return this.tags; },
  async refreshFacets() { this.facets = await api('/api/spots/facets'); return this.facets; },
  async saveSettings(patch) {
    this.settings = await api('/api/settings', { method: 'PUT', body: patch });
    applyAppearance();
    return this.settings;
  },
  mod(name) { return this.settings?.modules?.[name] !== false; },
};
window.__store = store;

// ---------------------------------------------------------------- apparence
const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyAppearance() {
  const s = store.settings || {};
  const dark = s.theme === 'dark' || (s.theme !== 'light' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const hex = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#3b82f6';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root.setProperty('--accent-ink', lum > 0.68 ? '#111' : '#fff');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0e1013' : '#f5f6f8');
}
mq.addEventListener?.('change', applyAppearance);

// ---------------------------------------------------------------- navigation
const NAV = [
  { group: 'nav.g.collection' },
  { href: '#/', icon: 'house', key: 'nav.home', match: /^$/ },
  { href: '#/spots', icon: 'camera', key: 'nav.spots', match: /^spots/ },
  { href: '#/outings', icon: 'calendar-days', key: 'nav.outings', match: /^outings/ },
  { href: '#/airports', icon: 'map-pin', key: 'nav.airports', match: /^airports/ },
  { href: '#/flights', icon: 'ticket', key: 'nav.flights', match: /^flights/, mod: 'flights' },
  { href: '#/fleets', icon: 'building-2', key: 'nav.fleets', match: /^(fleets|liveries)/, mod: 'fleets' },
  { href: '#/stats', icon: 'chart-column', key: 'nav.stats', match: /^stats/ },
  { group: 'nav.g.field' },
  { href: '#/radar', icon: 'radar', key: 'nav.radar', match: /^radar/, mod: 'radar' },
  { href: '#/locations', icon: 'binoculars', key: 'nav.locations', match: /^locations/, mod: 'locations' },
  { href: '#/wishlist', icon: 'star', key: 'nav.watchlist', match: /^(wishlist|watchlist)/, mod: 'watchlist' },
  { group: 'nav.g.more' },
  { href: '#/achievements', icon: 'trophy', key: 'nav.achievements', match: /^achievements/, mod: 'gamification' },
  { href: '#/story', icon: 'wand-sparkles', key: 'nav.story', match: /^story/, mod: 'gamification' },
  { href: '#/shares', icon: 'share-2', key: 'nav.shares', match: /^shares/ },
  { href: '#/trash', icon: 'trash-2', key: 'nav.trash', match: /^trash/ },
  { href: '#/settings', icon: 'settings', key: 'nav.settings', match: /^(settings|drafts)/ },
];

const ROUTES = [
  [/^$/, 'dashboard'],
  [/^spots$/, 'spots'],
  [/^spots\/new$/, 'spot-form'],
  [/^spots\/(\d+)\/edit$/, 'spot-form', ['id']],
  [/^spots\/(\d+)\/share$/, 'spot-share', ['id']],
  [/^spots\/(\d+)$/, 'spot-detail', ['id']],
  [/^airframe\/([^/]+)$/, 'airframe', ['reg']],
  [/^flights$/, 'flights'],
  [/^flights\/new$/, 'flight-form'],
  [/^flights\/(\d+)\/edit$/, 'flight-form', ['id']],
  [/^flights\/(\d+)$/, 'flight-detail', ['id']],
  [/^fleets$/, 'fleets'],
  [/^fleets\/(.+)$/, 'fleet-detail', ['key']],
  [/^liveries$/, 'liveries'],
  [/^trash$/, 'trash'],
  [/^outings$/, 'outings'],
  [/^outings\/(\d+)$/, 'outing-detail', ['id']],
  [/^airports$/, 'airports'],
  [/^airports\/([^/]+)$/, 'airport', ['id']],
  [/^stats$/, 'stats'],
  [/^locations$/, 'locations'],
  [/^radar$/, 'radar'],
  [/^(?:wishlist|watchlist)$/, 'wishlist'],
  [/^achievements$/, 'achievements'],
  [/^story$/, 'story'],
  [/^shares$/, 'shares'],
  [/^settings(?:\/(\w+))?$/, 'settings', ['section']],
  [/^drafts$/, 'drafts'],
  [/^more$/, 'more'],
];

function currentPath() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  return { path: decodeURIComponent(path.replace(/\/$/, '')), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', hash); else location.hash = hash;
  if (replace) route();
}

let cleanup = null;
let routeToken = 0;

async function route() {
  const { path, query } = currentPath();
  const main = $('#main');
  if (!main) return;
  const token = ++routeToken;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* vue déjà démontée */ } }
  cleanup = null;
  let view = 'notfound', params = {};
  for (const [rx, name, keys] of ROUTES) {
    const m = path.match(rx);
    if (m) { view = name; (keys || []).forEach((k, i) => (params[k] = m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined)); break; }
  }
  updateNav(path);
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  const container = el('<div class="view"></div>');
  main.replaceChildren(container);
  window.scrollTo(0, 0);
  setAppbarTitle('');
  document.body.dataset.view = view;
  if (view === 'notfound') {
    container.innerHTML = `<div class="empty" style="padding-top:20vh">${icon('compass', '', 48)}<h3>${esc(t('common.not_found'))}</h3><a class="btn" href="#/">${esc(t('nav.home'))}</a></div>`;
    return;
  }
  try {
    const mod = await import(`./views/${view}.js`);
    if (token !== routeToken) return;
    cleanup = await mod.render(container, params, query);
    observeHead(container);
  } catch (e) {
    console.error(e);
    if (token !== routeToken) return;
    container.innerHTML = `<div class="empty" style="padding-top:18vh">${icon(e?.offline ? 'wifi-off' : 'circle-alert', '', 46)}
      <h3>${esc(e?.offline ? t('err.offline_view') : t('err.generic'))}</h3><p class="small">${esc(e?.message || '')}</p>
      <button class="btn" onclick="location.reload()">${icon('refresh-cw', '', 18)} ${esc(t('common.retry'))}</button></div>`;
  }
}

function updateNav(path) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const item = NAV.find((n) => n.href === a.getAttribute('href'));
    a.classList.toggle('active', !!item?.match?.test(path));
  });
  const more = $('.bottomnav [data-more]');
  if (more) more.classList.toggle('active', /^(more|fleets|liveries|stats|locations|wishlist|watchlist|achievements|story|shares|settings|drafts|trash|outings)/.test(path));
}

// Le grand titre (One UI) se replie dans la barre supérieure au défilement
let headObserver;
function observeHead(container) {
  headObserver?.disconnect();
  const head = container.querySelector('.page-head h1');
  const bar = $('.appbar');
  if (!head || !bar) return;
  setAppbarTitle(head.textContent);
  headObserver = new IntersectionObserver(([en]) => bar.classList.toggle('scrolled', !en.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
  headObserver.observe(head);
}
export function setAppbarTitle(txt) { const n = $('.appbar-title'); if (n) n.textContent = txt; }

// ---------------------------------------------------------------- coquille
function renderShell() {
  const visible = NAV.filter((n) => !n.mod || store.mod(n.mod));
  // Retire les titres de groupe vides
  const items = visible.filter((n, i) => !n.group || (visible[i + 1] && !visible[i + 1].group));
  const side = items.map((n) => n.group
    ? `<div class="side-group">${esc(t(n.group))}</div>`
    : `<a class="side-link" data-nav href="${n.href}">${icon(n.icon)}<span>${esc(t(n.key))}</span></a>`).join('');
  const app = $('#app');
  app.innerHTML = `
    <aside class="sidebar" aria-label="Navigation">
      <div class="side-brand"><span class="logo">${icon('plane', '', 18)}</span>Contrail${store.session.profile === 'test' ? `<span class="env-tag">TEST</span>` : ''}</div>
      <a class="btn primary side-new" href="#/spots/new">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>
      ${side}
      <div style="margin-top:auto;padding:14px 12px 0" class="tiny muted"><span id="draft-count"></span></div>
    </aside>
    <div class="shell">
      <header class="appbar">
        <div class="appbar-title"></div>
        <button class="btn-icon" data-search title="${esc(t('search.title'))} (/)">${icon('search')}</button>
        <button class="btn-icon" data-notifs title="${esc(t('notif.title'))}">${icon('bell')}<span class="dot hidden"></span></button>
      </header>
      <main id="main" class="main"></main>
    </div>
    <nav class="bottomnav" aria-label="Navigation">
      <a data-nav href="#/">${icon('house', '', 22)}<span>${esc(t('nav.home'))}</span></a>
      <a data-nav href="#/spots">${icon('camera', '', 22)}<span>${esc(t('nav.spots'))}</span></a>
      <div class="fab-slot"><a class="fab" href="#/spots/new" aria-label="${esc(t('spot.new'))}">${icon('plus', '', 26)}</a></div>
      ${store.mod('flights') ? `<a data-nav href="#/flights">${icon('ticket', '', 22)}<span>${esc(t('nav.flights'))}</span></a>`
        : `<a data-nav href="#/stats">${icon('chart-column', '', 22)}<span>${esc(t('nav.stats'))}</span></a>`}
      <a data-more href="#/more">${icon('layout-grid', '', 22)}<span>${esc(t('nav.more'))}</span></a>
    </nav>`;
  $('[data-search]').onclick = openPalette;
  $('[data-notifs]').onclick = openNotifications;
  renderTestBanner();
}

// ---------------------------------------------------------------- session de test
function renderTestBanner() {
  document.querySelector('.test-banner')?.remove();
  const inTest = store.session.profile === 'test';
  document.body.classList.toggle('in-test', inTest);
  if (!inTest) return;
  const bar = el(`<div class="test-banner" role="status">${icon('triangle-alert', '', 16)}
    <span class="grow"><b>${esc(t('test.banner_title'))}</b><span class="t-text"> — ${esc(t('test.banner_text'))}</span></span>
    <button class="btn" data-treset title="${esc(t('test.reset'))}">${icon('rotate-ccw', '', 14)}<span>${esc(t('test.reset'))}</span></button>
    <button class="btn" data-tquit title="${esc(t('test.quit'))}">${icon('log-out', '', 14)}<span>${esc(t('test.quit'))}</span></button></div>`);
  document.querySelector('.shell')?.prepend(bar);
  const setH = () => document.body.style.setProperty('--test-h', `${bar.offsetHeight}px`);
  setH();
  new ResizeObserver(setH).observe(bar);
  bar.querySelector('[data-tquit]').onclick = () => switchSession('main');
  bar.querySelector('[data-treset]').onclick = resetTestSession;
}

async function clearDataCaches() {
  if (!('caches' in window)) return;
  for (const k of await caches.keys()) if (k.endsWith('-data') || k === 'contrail-media') await caches.delete(k);
}

export async function switchSession(profile) {
  try {
    await api('/api/session', { method: 'POST', body: { profile } });
    await clearDataCaches();
    localStorage.removeItem('contrail.settings');
    location.hash = '#/';
    location.reload();
  } catch (e) {
    const { errorToast } = await import('./ui.js');
    errorToast(e);
  }
}

export async function resetTestSession() {
  const { confirmDialog } = await import('./ui.js');
  if (!(await confirmDialog(esc(t('test.reset_confirm')), { ok: t('test.reset') }))) return;
  await api('/api/session/reset', { method: 'POST' });
  await clearDataCaches();
  location.hash = '#/';
  location.reload();
}

export function rerenderShell() {
  renderShell();
  route();
  refreshDraftCount();
  pollNotifications();
}

// ---------------------------------------------------------------- notifications
let lastNotifId = Number(localStorage.getItem('contrail.lastNotif') || 0);
let firstPoll = true;
// Les notifications issues d'une action faite dans cet onglet sont déjà affichées en toast
let suppressUntil = 0;
window.addEventListener('contrail-local-action', () => { suppressUntil = Date.now() + 90000; });
async function pollNotifications() {
  try {
    const res = await api('/api/notifications', { query: { limit: 20 } });
    const dot = $('[data-notifs] .dot');
    if (dot) { dot.textContent = res.unread > 9 ? '9+' : res.unread; dot.classList.toggle('hidden', !res.unread); }
    const fresh = res.items.filter((n) => n.id > lastNotifId).reverse();
    if (fresh.length) {
      lastNotifId = Math.max(...fresh.map((n) => n.id));
      localStorage.setItem('contrail.lastNotif', lastNotifId);
      if (!firstPoll) {
        const local = Date.now() < suppressUntil;
        for (const n of fresh.filter((x) => !(local && ['crossref', 'achievement'].includes(x.kind))).slice(-3)) {
          toast(`<b>${esc(n.title)}</b>${n.body ? `<br><span class="small muted">${esc(n.body)}</span>` : ''}`, { type: n.kind === 'achievement' ? 'star' : 'info', action: n.link ? t('common.open') : null, onAction: () => n.link && (location.hash = n.link) });
          systemNotify(n);
        }
      }
    }
    firstPoll = false;
  } catch { /* hors-ligne : on réessaiera */ }
}

function systemNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const show = (reg) => {
    const opts = { body: n.body || '', icon: '/static/icons/icon-192.png', badge: '/static/icons/icon-192.png', tag: `contrail-${n.id}`, data: { link: n.link } };
    if (reg) reg.showNotification(n.title, opts); else new Notification(n.title, opts);
  };
  navigator.serviceWorker?.getRegistration().then(show, () => show(null));
}

async function openNotifications() {
  const s = sheet({ title: esc(t('notif.title')), body: `<div class="skeleton" style="height:120px"></div>` });
  const res = await api('/api/notifications', { query: { limit: 60 } });
  const ic = { crossref: 'ticket', achievement: 'trophy', watchlist: 'eye', wishlist: 'star', backup: 'archive' };
  s.body.innerHTML = res.items.length ? `
    <div class="row" style="justify-content:flex-end;margin-bottom:8px">
      ${'Notification' in window && Notification.permission === 'default' ? `<button class="btn sm" data-perm>${icon('bell', '', 16)} ${esc(t('notif.enable_system'))}</button>` : ''}
      <button class="btn sm ghost" data-clear>${esc(t('notif.clear'))}</button></div>
    <div class="stack" style="gap:4px">${res.items.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/')}">${icon(ic[n.kind] || 'bell')}
      <div class="grow"><b>${esc(n.title)}</b>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}<div class="tiny muted">${fmtRelative(n.created_at)}</div></div></a>`).join('')}</div>`
    : `<div class="empty">${icon('bell', '', 40)}<p>${esc(t('notif.empty'))}</p>
       ${'Notification' in window && Notification.permission === 'default' ? `<button class="btn" data-perm>${esc(t('notif.enable_system'))}</button>` : ''}</div>`;
  s.body.querySelectorAll('a.notif').forEach((a) => a.addEventListener('click', () => s.close()));
  s.body.querySelector('[data-perm]')?.addEventListener('click', () => Notification.requestPermission().then(() => s.close()));
  s.body.querySelector('[data-clear]')?.addEventListener('click', async () => { await api('/api/notifications', { method: 'DELETE' }); s.close(); pollNotifications(); });
  if (res.unread) { await api('/api/notifications/read', { method: 'POST', body: null }); pollNotifications(); }
}

// ---------------------------------------------------------------- palette de recherche
function openPalette() {
  if ($('.palette')) return;
  const node = el(`<div class="palette"><div class="sheet-backdrop"></div><div class="palette-panel">
    <div class="search">${icon('search')}<input class="input" placeholder="${esc(t('search.placeholder'))}" autocomplete="off"></div>
    <div class="palette-results"><p class="muted small" style="padding:12px">${t('search.hint')}</p></div></div></div>`);
  document.body.append(node);
  const input = node.querySelector('input');
  const results = node.querySelector('.palette-results');
  const close = () => node.remove();
  node.querySelector('.sheet-backdrop').onclick = close;
  let sel = 0;
  const highlight = () => results.querySelectorAll('a').forEach((a, i) => a.classList.toggle('on', i === sel));
  input.addEventListener('keydown', (e) => {
    const links = results.querySelectorAll('a');
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { sel = Math.min(links.length - 1, sel + 1); highlight(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); highlight(); e.preventDefault(); }
    if (e.key === 'Enter' && links[sel]) { location.hash = links[sel].getAttribute('href'); close(); }
  });
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = `<p class="muted small" style="padding:12px">${t('search.hint')}</p>`; return; }
    const r = await api('/api/search', { query: { q } }).catch(() => null);
    if (!r) return;
    const grp = (title, items) => items.length ? `<div class="grp">${esc(title)}</div>${items.join('')}` : '';
    const { mediaUrl } = await import('./api.js');
    results.innerHTML = [
      grp(t('search.airframes'), r.airframes.map((a) => `<a href="#/airframe/${encodeURIComponent(a.registration)}">${icon('plane')}<span class="mono"><b>${esc(a.registration)}</b></span><span class="muted small ellipsis grow">${esc(a.aircraft || '')}</span><span class="badge">${a.n}×</span></a>`)),
      grp(t('search.spots'), r.spots.map((s) => `<a href="#/spots/${s.id_spotting}">${s.thumb ? `<img src="${mediaUrl('thumbs', s.thumb)}" alt="">` : icon('camera')}<span class="grow ellipsis"><b class="mono">${esc(s.registration)}</b> <span class="muted small">${s.test_registration && s.test_registration !== s.registration ? `<span class="mono">${esc(s.test_registration)}</span> · ` : ''}${esc(s.owner || '')} · ${esc(s.airport || '')}</span></span></a>`)),
      grp(t('search.flights'), r.flights.map((f) => `<a href="#/flights/${f.id_flight}">${icon('ticket')}<span class="grow"><b>${esc(f.dep_icao)} → ${esc(f.arr_icao)}</b> <span class="muted small">${esc(f.flight_number || '')} · ${esc(f.date)}</span></span></a>`)),
      grp(t('search.airports'), r.airports.map((a) => `<a href="#/airports/${a.icao}">${icon('map-pin')}<span class="grow"><b class="mono">${a.icao}</b> <span class="muted small">${esc(a.name)}</span></span></a>`)),
      grp(t('search.tags'), r.tags.map((tg) => `<a href="#/spots?tag=${tg.id_tag}">${icon('tag')}<span>${esc(tg.name)}</span></a>`)),
    ].join('') || `<p class="muted small" style="padding:12px">${esc(t('search.none'))}</p>`;
    sel = 0; highlight();
    results.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
  }, 200);
  input.addEventListener('input', run);
  input.focus();
}

// ---------------------------------------------------------------- brouillons & réseau
async function refreshDraftCount() {
  const n = await countDrafts().catch(() => 0);
  const box = $('#draft-count');
  if (box) box.innerHTML = n ? `<a href="#/drafts">${icon('cloud-upload', '', 14)} ${esc(t('drafts.count', { n }))}</a>` : '';
}
window.addEventListener('drafts-changed', refreshDraftCount);

function setOfflineBanner() {
  let b = $('.offline-banner');
  if (!navigator.onLine) {
    if (!b) document.body.append(el(`<div class="offline-banner">${icon('wifi-off', '', 15)} ${esc(t('offline.banner'))}</div>`));
  } else b?.remove();
}
window.addEventListener('offline', setOfflineBanner);
window.addEventListener('online', async () => {
  setOfflineBanner();
  const r = await syncDrafts();
  if (r.synced) toast(esc(t('drafts.synced', { n: r.synced })), { type: 'success' });
  if (r.failed) toast(esc(t('drafts.failed', { n: r.failed })), { type: 'warn', action: t('common.open'), onAction: () => (location.hash = '#/drafts') });
});

// ---------------------------------------------------------------- connexion
function renderLogin() {
  const app = $('#app');
  app.innerHTML = `<div class="login"><form class="card stack">
    <div class="side-brand" style="padding:0 0 6px"><span class="logo">${icon('plane', '', 20)}</span>Contrail</div>
    <p class="muted">${esc(t('auth.prompt'))}</p>
    <label class="field"><span>${esc(t('auth.password'))}</span><input type="password" autocomplete="current-password" required autofocus></label>
    <button class="btn primary block">${icon('lock', '', 18)} ${esc(t('auth.login'))}</button>
    <p class="small" style="color:var(--danger)" data-err></p></form></div>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: { password: app.querySelector('input').value } });
      location.reload();
    } catch (err) {
      app.querySelector('[data-err]').textContent = t(err.status === 429 ? 'auth.too_many' : 'auth.bad');
    }
  };
}

// ---------------------------------------------------------------- démarrage
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

  // Page de partage public : rendu autonome, sans coquille ni authentification
  if (location.pathname.startsWith('/s/')) {
    await setLang((navigator.language || 'fr').slice(0, 2));
    store.settings = { theme: 'auto', accent: '#3b82f6' };
    applyAppearance();
    const mod = await import('./views/public.js');
    return mod.render($('#app'), { token: location.pathname.split('/')[2] });
  }

  setUnauthorizedHandler(() => { if (!document.querySelector('.login')) renderLogin(); });
  try {
    const st = await api('/api/auth/status');
    if (st.enabled && !st.authenticated) {
      await setLang(localStorage.getItem('contrail.lang') || (navigator.language || 'fr').slice(0, 2));
      applyAppearance();
      return renderLogin();
    }
    store.session = await api('/api/session').catch(() => ({ profile: 'main' }));
    store.settings = await api('/api/settings');
    localStorage.setItem('contrail.settings', JSON.stringify(store.settings));
  } catch (e) {
    // Hors-ligne au démarrage : on reprend les derniers réglages connus
    store.settings = JSON.parse(localStorage.getItem('contrail.settings') || 'null') || { theme: 'auto', accent: '#3b82f6', language: 'fr', modules: {} };
  }
  localStorage.setItem('contrail.lang', store.settings.language);
  await setLang(store.settings.language);
  applyAppearance();
  renderShell();
  setOfflineBanner();
  window.addEventListener('hashchange', route);
  await route();
  refreshDraftCount();
  api('/api/config').then((c) => (store.config = c)).catch(() => {});
  pollNotifications();
  setInterval(pollNotifications, 60000);
  if (navigator.onLine) syncDrafts().then((r) => r.synced && toast(esc(t('drafts.synced', { n: r.synced })), { type: 'success' }));

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); openPalette(); }
    if (e.key === 'n' && !typing && !e.metaKey && !e.ctrlKey && !document.querySelector('.sheet,.palette')) location.hash = '#/spots/new';
  });
}

boot();
