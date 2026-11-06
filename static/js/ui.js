// Composants d'interface : feuilles (bottom sheets), toasts, menus, confirmations, visionneuse, utilitaires
import { icon } from './lib/icons.js';
import { t, flag, countryName, fmtDate } from './i18n.js';
import { api, mediaUrl } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Texte à afficher pour une immatriculation (les spots sans immatriculation portent une valeur de substitution). */
export const regText = (r) => (typeof r === 'string' && r.startsWith('SANS-IMMAT-') ? t('spot.no_reg') : r || '');
/** Lieu d'un spot : l'aéroport, sinon le lieu libre (plage, meeting, ville…). */
/** Titre d'un spot : le nom de la patrouille (mode simple) ou l'immatriculation. */
export const regLabel = (s) => (s && s.is_patrol && s.patrol_name) || regText(s && s.registration);
export const placeText = (s) => (s && (s.airport || s.place)) || '';

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function debounce(fn, ms = 250) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- toasts
export function toast(message, { type = 'info', action, onAction, duration = 3800 } = {}) {
  let box = $('.toasts');
  if (!box) { box = el('<div class="toasts" role="status" aria-live="polite"></div>'); document.body.append(box); }
  const ic = { info: 'info', success: 'circle-check', error: 'circle-alert', warn: 'triangle-alert', star: 'sparkles' }[type] || 'info';
  const node = el(`<div class="toast ${type}">${icon(ic)}<div class="grow">${message}</div>${action ? `<button class="btn sm">${esc(action)}</button>` : ''}</div>`);
  if (action) node.querySelector('button').onclick = () => { onAction?.(); node.remove(); };
  box.append(node);
  setTimeout(() => { node.style.transition = '.3s'; node.style.opacity = '0'; setTimeout(() => node.remove(), 300); }, duration);
}

/** Confirmation d'une suppression avec bouton « Annuler » (restaure depuis la corbeille). */
export function undoToast(message, trashId, { onUndo } = {}) {
  if (!trashId) { toast(message, { type: 'success' }); return; }
  toast(message, { type: 'success', duration: 8000, action: t('common.undo'), onAction: async () => {
    try { await api(`/api/trash/${trashId}/restore`, { method: 'POST' }); toast(esc(t('trash.restored')), { type: 'success' }); onUndo?.(); } catch (e) { errorToast(e); }
  } });
}

export function errorToast(e) {
  if (e?.name === 'AbortError') return;
  const key = typeof e?.detail === 'string' ? `err.${e.detail}` : e?.offline ? 'err.offline' : 'err.generic';
  const msg = t(key) === key ? (typeof e?.detail === 'string' ? e.detail : t('err.generic')) : t(key);
  toast(esc(msg), { type: 'error' });
}

// ---------------------------------------------------------------- bottom sheet
export function sheet({ title = '', body = '', wide = false, onClose } = {}) {
  const node = el(`<div class="sheet" role="dialog" aria-modal="true">
    <div class="sheet-backdrop"></div>
    <div class="sheet-panel ${wide ? 'wide' : ''}">
      <div class="sheet-grip"></div>
      ${title !== null ? `<div class="sheet-head"><h3>${title}</h3><button class="btn-icon" data-close aria-label="${esc(t('common.close'))}">${icon('x')}</button></div>` : ''}
      <div class="sheet-body"></div>
    </div></div>`);
  const panel = node.querySelector('.sheet-panel');
  const bodyEl = node.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    setTimeout(() => node.remove(), 200);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  // Un lien suivi depuis la feuille change de page : la feuille ne doit pas rester ouverte
  window.addEventListener('hashchange', close);
  node.querySelector('.sheet-backdrop').onclick = close;
  node.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  // Glisser vers le bas pour fermer (mobile)
  const grip = node.querySelector('.sheet-grip');
  let y0 = null;
  const start = (e) => { if (panel.scrollTop > 0 && e.target !== grip) return; y0 = e.touches[0].clientY; };
  const move = (e) => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) { panel.style.transform = `translateY(${dy}px)`; panel.style.transition = 'none'; }
  };
  const end = (e) => {
    if (y0 === null) return;
    const dy = (e.changedTouches[0].clientY - y0);
    panel.style.transition = ''; panel.style.transform = '';
    y0 = null;
    if (dy > 110) close();
  };
  panel.addEventListener('touchstart', start, { passive: true });
  panel.addEventListener('touchmove', move, { passive: true });
  panel.addEventListener('touchend', end);
  document.body.append(node);
  return { node, body: bodyEl, close, panel };
}

export function confirmDialog(message, { title = t('common.confirm'), ok = t('common.ok'), danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: esc(title),
      body: `<p class="muted" style="margin-bottom:18px">${message}</p>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>${esc(t('common.cancel'))}</button>
        <button class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(ok)}</button></div>`,
      onClose: () => { if (!done) resolve(false); },
    });
    s.body.querySelector('[data-no]').onclick = () => s.close();
    s.body.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); s.close(); };
    setTimeout(() => s.body.querySelector('[data-yes]').focus(), 50);
  });
}

export function promptDialog(label, { value = '', title = '', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const field = multiline
      ? `<textarea rows="6" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const s = sheet({
      title: esc(title || label),
      body: `<label class="field"><span>${esc(label)}</span>${field}</label>
        <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" data-close>${esc(t('common.cancel'))}</button>
        <button class="btn primary" data-yes>${esc(t('common.ok'))}</button></div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const inp = s.body.querySelector('input,textarea');
    s.body.querySelector('[data-close]').onclick = () => s.close();
    const ok = () => { done = true; resolve(inp.value); s.close(); };
    s.body.querySelector('[data-yes]').onclick = ok;
    if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => inp.focus(), 60);
  });
}

// ---------------------------------------------------------------- menu contextuel
export function menu(anchor, items) {
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  const node = el(`<div class="menu-pop" role="menu"></div>`);
  for (const it of items) {
    if (it === '-') { node.append(el('<hr>')); continue; }
    if (!it) continue;
    const b = el(`<button role="menuitem" class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'circle-help', '', 18)}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); node.remove(); it.onClick?.(); };
    node.append(b);
  }
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight;
  let left = Math.min(r.right - w, window.innerWidth - w - 10);
  left = Math.max(10, left);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 6);
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  setTimeout(() => {
    const off = (e) => { if (!node.contains(e.target)) { node.remove(); document.removeEventListener('pointerdown', off); } };
    document.addEventListener('pointerdown', off);
  });
  return node;
}

// ---------------------------------------------------------------- visionneuse
export function lightbox(items, index = 0) {
  // items : [{src, caption}]
  let i = index, scale = 1, tx = 0, ty = 0;
  const node = el(`<div class="lightbox">
    <img alt="">
    <button class="btn-icon lb-close" aria-label="${esc(t('common.close'))}">${icon('x')}</button>
    ${items.length > 1 ? `<button class="btn-icon lb-prev">${icon('chevron-left')}</button><button class="btn-icon lb-next">${icon('chevron-right')}</button>` : ''}
    <div class="lb-cap"></div></div>`);
  const img = node.querySelector('img');
  const show = () => {
    scale = 1; tx = 0; ty = 0; apply();
    img.src = items[i].src;
    node.querySelector('.lb-cap').innerHTML = items[i].caption || '';
  };
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const go = (d) => { i = (i + d + items.length) % items.length; show(); };
  const close = () => { node.remove(); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
  node.querySelector('.lb-close').onclick = close;
  node.querySelector('.lb-prev')?.addEventListener('click', () => go(-1));
  node.querySelector('.lb-next')?.addEventListener('click', () => go(1));
  img.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.5; tx = ty = 0; apply(); });
  node.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 0.87))); if (scale === 1) tx = ty = 0; apply(); }, { passive: false });
  // Gestes tactiles : pincer pour zoomer, glisser pour naviguer
  let pts = new Map(), d0 = 0, s0 = 1, x0 = 0, y0 = 0, tx0 = 0, ty0 = 0;
  node.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, e);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); s0 = scale; }
    else { x0 = e.clientX; y0 = e.clientY; tx0 = tx; ty0 = ty; }
  });
  node.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; scale = Math.min(6, Math.max(1, s0 * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / d0)); apply(); }
    else if (scale > 1) { tx = tx0 + e.clientX - x0; ty = ty0 + e.clientY - y0; apply(); }
  });
  const up = (e) => {
    if (pts.size === 1 && scale === 1 && pts.has(e.pointerId)) {
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 120) close();
    }
    pts.delete(e.pointerId);
  };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  document.addEventListener('keydown', key);
  document.body.append(node);
  show();
}

// ---------------------------------------------------------------- fragments réutilisables
export function emptyState(ic, title, text = '', actionHtml = '') {
  return `<div class="empty">${icon(ic, '', 44)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${actionHtml}</div>`;
}

export function pageHead(title, { sub = '', actions = '', compact = false } = {}) {
  return `<header class="page-head ${compact ? 'compact' : ''}"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</header>`;
}

export function regFlag(country) {
  return country ? `<span class="flag" title="${esc(countryName(country))}">${flag(country)}</span>` : '';
}

const BADGE_STYLE = {
  first_type: ['accent', 'sparkles'], first_airline: ['violet', 'building-2'], first_airport: ['green', 'map-pin'],
  seen_again: ['slate', 'history'], most_spotted: ['gold', 'trophy'], special_livery: ['rose', 'palette'], primer: ['green', 'paint-bucket'], white: ['slate', 'paint-bucket'],
  flown: ['violet', 'ticket'], military: ['slate', 'shield'], night: ['night', 'moon'], golden_hour: ['gold', 'sunset'], rarity: ['rose', 'gem'],
};

export function badgeHtml(b, { withIcon = true } = {}) {
  const [cls, ic] = BADGE_STYLE[b.code] || ['slate', 'tag'];
  let label = t(`badge.${b.code}`, b.n ? { n: b.n } : undefined);
  if (b.code === 'rarity') label = t(`rarity.${b.tier}`, { n: b.n });
  if (b.code === 'special_livery' && b.cat && b.cat !== 'special') label = t(`livery.${b.cat}`);
  return `<span class="badge ${cls}">${withIcon ? icon(ic, '', 12) : ''}${esc(label)}</span>`;
}

export function badgesHtml(list = [], max = 4) {
  return `<div class="badges">${list.slice(0, max).map((b) => badgeHtml(b)).join('')}</div>`;
}

export function tagChips(tags = []) {
  return tags.map((tg) => `<span class="chip" style="height:26px;font-size:12px"><span class="sw" style="background:${esc(tg.color)}"></span>${esc(tg.name)}</span>`).join('');
}

export function spotTile(s, { href = `#/spots/${s.id_spotting}` } = {}) {
  const corner = [s.favorite ? `<span class="badge">${icon('star', '', 11)}</span>` : '', s.atc_audio ? `<span class="badge">${icon('radio', '', 11)}</span>` : '',
    s.livery_category ? `<span class="badge">${icon(['primer', 'white'].includes(s.livery_category) ? 'paint-bucket' : 'palette', '', 11)}</span>` : '',
    s.patrol_id ? `<span class="badge" title="${esc(s.patrol_name || t('patrol.title'))}">${icon('users', '', 11)}</span>` : ''].join('');
  const sub = `${s.is_patrol && s.patrol_size ? esc(t('patrol.n_aircraft', { n: s.patrol_size })) + ' · ' : ''}${esc(s.aircraft_icao || s.aircraft || '')}${s.owner ? ' · ' + esc(s.owner) : ''}`;
  if (s.thumb) {
    return `<a class="tile" href="${href}"><img loading="lazy" src="${mediaUrl('thumbs', s.thumb)}" alt="${esc(regLabel(s))}"><div class="corner">${corner}</div>
      <div class="cap"><b class="mono">${esc(regLabel(s))}</b> ${regFlag(s.country)}<small class="ellipsis">${sub}</small></div></a>`;
  }
  // Spot sans photo : vignette typographique
  return `<a class="tile noimg" href="${href}">${icon('plane', '', 20)}<div class="corner">${corner}</div>
    <div class="cap"><b class="mono" style="font-size:17px">${esc(regLabel(s))}</b> ${regFlag(s.country)}<small class="ellipsis">${sub}</small>
    <small class="ellipsis">${esc(placeText(s))}${s.date ? ' · ' + fmtDate(s.date, { time: false, short: true }) : ''}</small></div></a>`;
}

export function spotRow(s, { selectable = false, selected = false } = {}) {
  const thumb = s.thumb ? `<img class="thumb" loading="lazy" src="${mediaUrl('thumbs', s.thumb)}" alt="">`
    : `<div class="thumb" style="display:grid;place-items:center;font-family:var(--mono);font-weight:650;font-size:12.5px">${esc(s.aircraft_icao || '') || icon('plane')}</div>`;
  return `<a class="list-row ${selected ? 'selected' : ''}" href="#/spots/${s.id_spotting}" data-id="${s.id_spotting}">
    ${selectable ? `<span class="check">${selected ? icon('check', '', 14) : ''}</span>` : ''}
    ${thumb}
    <div class="grow">
      <div class="ttl"><span class="mono">${esc(regLabel(s))}</span>${regFlag(s.country)}${s.favorite ? `<span style="color:#d97706">${icon('star', '', 14)}</span>` : ''}${s.patrol_id ? `<span class="muted" title="${esc(s.patrol_name || t('patrol.title'))}">${icon('users', '', 14)}</span>` : ''}</div>
      <div class="meta ellipsis">${s.is_patrol && s.patrol_size ? esc(t('patrol.n_aircraft', { n: s.patrol_size })) + ' · ' : ''}${esc(s.aircraft || s.aircraft_icao || '—')}${s.owner ? ' · ' + esc(s.owner) : ''}</div>
      <div class="meta ellipsis">${esc(placeText(s))}${placeText(s) ? ' · ' : ''}${fmtDate(s.date)}</div>
    </div>
    <div class="hide-sm" style="max-width:40%">${badgesHtml(s.badges, 3)}</div>
  </a>`;
}

// Glisser une ligne vers la gauche pour révéler des actions (mobile)
export function enableSwipe(container, { onFav, onDelete }) {
  container.querySelectorAll('.swipe').forEach((wrap) => {
    const content = wrap.querySelector('.swipe-content');
    let x0 = null, y0 = 0, dx = 0, horizontal = null;
    content.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null; content.style.transition = 'none'; }, { passive: true });
    content.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (horizontal === null) { horizontal = Math.abs(mx) > Math.abs(my) + 4; if (horizontal) wrap.classList.add('swiping'); }
      if (!horizontal) return;
      dx = Math.min(0, Math.max(-160, mx + (wrap.classList.contains('open') ? -152 : 0)));
      content.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    content.addEventListener('touchend', () => {
      content.style.transition = '';
      if (horizontal) {
        const open = dx < -70;
        wrap.classList.toggle('open', open);
        content.style.transform = open ? 'translateX(-152px)' : '';
        setTimeout(() => wrap.classList.remove('swiping'), 260);
      }
      x0 = null;
    });
    content.addEventListener('click', (e) => { if (wrap.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); content.style.transform = ''; setTimeout(() => wrap.classList.remove('open'), 260); } }, true);
    wrap.querySelector('.fav')?.addEventListener('click', () => onFav(wrap.dataset.id));
    wrap.querySelector('.del')?.addEventListener('click', () => onDelete(wrap.dataset.id));
  });
}

export function hbars(rows, { label = (r) => r.k, value = (r) => r.n, href } = {}) {
  if (!rows?.length) return `<p class="muted small">${esc(t('common.no_data'))}</p>`;
  const max = Math.max(...rows.map(value), 1);
  return `<div class="hbars">${rows.map((r) => {
    const k = `<span class="k" title="${esc(label(r))}">${label(r)}</span>`;
    return `<div class="hbar">${href ? `<a href="${href(r)}" class="k">${label(r)}</a>` : k}<div class="track"><div class="fill" style="width:${(value(r) / max) * 100}%"></div></div><span class="n">${value(r)}</span></div>`;
  }).join('')}</div>`;
}

function niceMax(v) {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  const m = step * p;
  return Number.isInteger(m / 2) ? m : m * 2;
}

/**
 * Histogramme en colonnes, rendu en HTML/CSS : hauteur fixe, typographie identique quel que
 * soit le nombre de colonnes, barres de 24 px maximum, grille discrète, valeur affichée
 * seulement sur le maximum (et la dernière colonne si `highlightLast`), info-bulle au survol.
 */
export function vbars(rows, { label = (r) => r.k, value = (r) => r.n, height = 168, highlightLast = false, every = 0, unit = '' } = {}) {
  if (!rows?.length) return `<p class="muted small">${esc(t('common.no_data'))}</p>`;
  const vals = rows.map(value);
  const max = Math.max(...vals);
  if (!max) return `<p class="muted small">${esc(t('common.no_data'))}</p>`;
  const top = niceMax(max);
  const n = rows.length;
  const step = every || (n > 16 ? Math.ceil(n / 8) : n > 10 ? 2 : 1);
  const iMax = vals.indexOf(max);
  const fmt = (v) => new Intl.NumberFormat(document.documentElement.lang || undefined).format(v);
  const ticks = [top, top / 2, 0];
  const cols = rows.map((r, i) => {
    const v = vals[i];
    const show = i === iMax || (highlightLast && i === n - 1);
    const dim = highlightLast && i !== n - 1 ? ' dim' : '';
    const tip = `${label(r)} · ${fmt(v)}${unit}`;
    return `<div class="cc-col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
      <i class="cc-bar${dim}${v ? '' : ' zero'}" style="height:${(v / top) * 100}%">${show && v ? `<span class="cc-val">${fmt(v)}</span>` : ''}</i></div>`;
  }).join('');
  const xl = rows.map((r, i) => `<span>${i % step === 0 || i === n - 1 && step === 1 ? esc(label(r)) : ''}</span>`).join('');
  return `<div class="cchart" style="--h:${height}px;--n:${n}" role="img">
    <div class="cc-y">${ticks.map((v) => `<span>${fmt(v)}</span>`).join('')}</div>
    <div class="cc-main">
      <div class="cc-plot"><div class="cc-grid">${ticks.map(() => '<i></i>').join('')}</div><div class="cc-cols">${cols}</div></div>
      <div class="cc-x">${xl}</div>
    </div></div>`;
}

export function stars(value, name = 'rating') {
  return `<div class="stars" data-stars="${name}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}" class="${value >= n ? 'on' : ''}" aria-label="${n}">${icon('star', '', 22)}</button>`).join('')}</div>`;
}

export function bindStars(root, onChange) {
  root.querySelectorAll('[data-stars]').forEach((box) => {
    box.querySelectorAll('button').forEach((b) => (b.onclick = () => {
      const cur = Number(box.dataset.value || 0);
      const v = Number(b.dataset.v) === cur ? 0 : Number(b.dataset.v);
      box.dataset.value = v;
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) <= v));
      onChange?.(v);
    }));
  });
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = el('<textarea style="position:fixed;opacity:0"></textarea>');
  ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); return true; } catch { return false; } finally { ta.remove(); }
}

export function download(url, filename) {
  const a = el(`<a href="${url}" download="${esc(filename || '')}"></a>`);
  document.body.append(a); a.click(); a.remove();
}
