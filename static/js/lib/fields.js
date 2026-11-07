// Champs réutilisables : autocomplétion d'aéroport, sélecteur d'étiquettes
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, debounce, sheet } from '../ui.js';
import { icon } from './icons.js';

const RECENT_KEY = 'contrail.recentAirports';
const CACHE_KEY = 'contrail.airportCache';

function cacheAirports(list) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    for (const a of list) c[a.icao] = { icao: a.icao, iata: a.iata, name: a.name, city: a.city, country: a.country };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* quota */ }
}

export function rememberAirport(icao) {
  if (!icao) return;
  const r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== icao);
  r.unshift(icao);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 8)));
}

function offlineSearch(q) {
  const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  const ql = q.toLowerCase();
  return Object.values(c).filter((a) => `${a.icao} ${a.iata || ''} ${a.name} ${a.city}`.toLowerCase().includes(ql)).slice(0, 8);
}

/** Aperçu d'un lieu sur une carte (feuille). */
export function previewPlace({ lat, lng, label = '' }) {
  if (lat == null || lng == null) return;
  const node = sheet({ title: esc(label), body: `<div data-pm style="height:320px;border-radius:12px;overflow:hidden;background:var(--bg)"></div>
    <p class="tiny muted" style="margin-top:8px">${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}</p>` });
  setTimeout(async () => {
    const host = document.querySelector('.sheet [data-pm]');
    if (!host) return;
    try {
      const { createMap } = await import('./map.js');
      const m = await createMap(host, { center: [lat, lng], zoom: 11 });
      m.marker([lat, lng], { kind: 'pin', label: '' });
    } catch { host.innerHTML = `<div class="muted small" style="padding:20px">${esc(t('err.generic'))}</div>`; }
  }, 60);
  return node;
}

/** Transforme un <input> en champ aéroport avec suggestions (en ligne et hors-ligne). */
export function airportInput(input, { onPick, getLL } = {}) {
  const wrap = input.closest('.input-wrap') || input.parentElement;
  wrap.style.position = 'relative';
  let list = null, items = [], sel = -1;
  const close = () => { list?.remove(); list = null; };
  // Petite icône carte à droite du champ : aperçu du lieu choisi (ville ou lieu situé)
  let mapBtn = null;
  const syncMap = () => {
    const ll = getLL?.();
    if (ll && !mapBtn) {
      mapBtn = document.createElement('button');
      mapBtn.type = 'button';
      mapBtn.className = 'btn-icon ac-map';
      mapBtn.title = t('spot.preview_map');
      mapBtn.setAttribute('aria-label', t('spot.preview_map'));
      mapBtn.innerHTML = icon('map', '', 18);
      mapBtn.onclick = () => { const p = getLL?.(); if (p) previewPlace({ lat: p[0], lng: p[1], label: input.value }); };
      wrap.append(mapBtn);
    }
    if (mapBtn) mapBtn.hidden = !ll;
    if (getLL) input.style.paddingRight = ll ? '44px' : '';
  };
  const pick = (a) => {
    if (a.label) {                       // ville ou lieu : on garde son libellé et ses coordonnées pour l'enregistrement
      input.value = a.label;
      input.dataset.kind = 'place';
      input.dataset.name = a.label;
    } else {
      input.value = a.icao;
      input.dataset.name = a.name;
      delete input.dataset.kind;
      rememberAirport(a.icao);
    }
    close();
    onPick?.(a);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    syncMap();
  };
  const show = (arr) => {
    items = arr;
    sel = -1;
    close();
    if (!arr.length) return;
    list = document.createElement('div');
    list.className = 'ac-list';
    list.innerHTML = arr.map((a, i) => a.label
      ? `<div class="ac-item" data-i="${i}"><b>${icon('map-pin', '', 16)}</b><span class="grow ellipsis">${esc(a.label)}<br><span class="tiny muted">${esc(a.detail || t('spot.place_city'))}</span></span><button type="button" class="btn-icon ac-pv" data-pv="${i}" title="${esc(t('spot.preview_map'))}" aria-label="${esc(t('spot.preview_map'))}">${icon('map', '', 18)}</button></div>`
      : `<div class="ac-item" data-i="${i}"><b>${esc(a.icao)}</b><span class="grow ellipsis">${esc(a.name)}<br><span class="tiny muted">${esc(a.city || '')}${a.iata ? ' · ' + esc(a.iata) : ''}</span></span></div>`).join('');
    list.querySelectorAll('.ac-item').forEach((n) => n.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pv = e.target.closest('[data-pv]');
      if (pv) { const a = items[Number(pv.dataset.pv)]; previewPlace({ lat: a.lat, lng: a.lng, label: a.label }); return; }   // aperçu sans choisir
      pick(items[Number(n.dataset.i)]);
    }));
    wrap.append(list);
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    let airports = [];
    try {
      airports = await api('/api/airports/search', { query: { q, limit: 8 } });
      cacheAirports(airports);
      if (document.activeElement === input) show(airports);
    } catch {
      show(offlineSearch(q));
      return;
    }
    // Villes et lieux : un second appel, pour ne pas retarder l'affichage des aéroports
    if (q.length >= 3 && navigator.onLine) {
      try {
        const places = await api('/api/places/search', { query: { q } });
        if (places.length && document.activeElement === input && input.value.trim() === q) show([...airports.slice(0, 5), ...places]);
      } catch { /* service de géocodage indisponible : les aéroports suffisent */ }
    }
  }, 180);
  input.addEventListener('input', () => { delete input.dataset.kind; syncMap(); });   // le texte modifié à la main n'est plus un lieu choisi
  input.addEventListener('input', search);
  syncMap();
  input.addEventListener('focus', () => {
    if (input.value.trim()) return;
    const recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    show(recents.map((c) => cache[c] || { icao: c, name: '', city: '' }));
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!list) return;
    const n = list.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') { sel = Math.min(n.length - 1, sel + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(items[sel]); return; }
    else if (e.key === 'Escape') { close(); return; }
    n.forEach((x, i) => x.classList.toggle('on', i === sel));
  });
}

/** Sélecteur d'étiquettes : sélection multiple, création à la volée (saisie) ou filtre (allowNew: false).
 *  Jusqu'à 12 étiquettes : simples pastilles. Au-delà : étiquettes choisies en haut, recherche et liste défilante. */
export function tagPicker(container, allTags, selected = [], { allowNew = true, onChange = null } = {}) {
  const keyOf = (tg) => (tg.id_tag ? String(tg.id_tag) : `new:${tg.name}`);
  const chosen = new Map(selected.map((tg) => [keyOf(tg.id_tag || tg.name ? tg : { name: tg }), tg.id_tag || tg.name ? tg : { name: tg }]));
  const extra = [];
  const compact = allTags.length > 12;
  let query = '';
  const dot = (tg) => `<span class="sw" style="background:${esc(tg.color || '#64748b')}"></span>`;
  const changed = () => onChange?.([...chosen.values()]);
  const toggle = (tg) => { const k = keyOf(tg); chosen.has(k) ? chosen.delete(k) : chosen.set(k, tg); changed(); };
  const create = (name) => {
    name = name.trim();
    if (!name) return;
    const known = [...allTags, ...extra].find((x) => x.name.toLowerCase() === name.toLowerCase());
    const tg = known || { name, color: '#64748b' };
    if (!known) extra.push(tg);
    chosen.set(keyOf(tg), tg);
    changed();
  };

  const drawSimple = () => {
    const all = [...allTags, ...extra];
    container.innerHTML = `<div class="chips">${all.map((tg) => `<button type="button" class="chip ${chosen.has(keyOf(tg)) ? 'on' : ''}" data-key="${esc(keyOf(tg))}">${dot(tg)}${esc(tg.name)}</button>`).join('')}${allowNew ? `<button type="button" class="chip" data-add>${icon('plus', '', 14)} ${esc(t('tags.new'))}</button>` : ''}</div>`;
    container.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => { toggle(all.find((x) => keyOf(x) === b.dataset.key)); b.classList.toggle('on'); }));
    const add = container.querySelector('[data-add]');
    if (!add) return;
    add.onclick = () => {
      const inp = document.createElement('input');
      inp.className = 'input';
      inp.style.cssText = 'height:32px;width:150px;border-radius:999px;font-size:13px';
      inp.placeholder = t('tags.name');
      add.replaceWith(inp);
      inp.focus();
      let done = false;
      const commit = () => { if (done) return; done = true; create(inp.value); drawSimple(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { done = true; drawSimple(); } });
      inp.addEventListener('blur', commit);
    };
  };

  const drawCompact = (keepFocus = false) => {
    const all = [...allTags, ...extra];
    const q = query.trim().toLowerCase();
    const rows = all.filter((tg) => !q || tg.name.toLowerCase().includes(q))
      .sort((x, y) => (y.count || 0) - (x.count || 0) || x.name.localeCompare(y.name));
    const exact = all.some((x) => x.name.toLowerCase() === q);
    const sel = [...chosen.values()];
    container.innerHTML = `<div class="tagsel">
      <div class="tagsel-head"><div class="chips tagsel-chosen">${sel.length ? sel.map((tg) => `<button type="button" class="chip on" data-rm="${esc(keyOf(tg))}" title="${esc(t('common.remove'))}">${dot(tg)}${esc(tg.name)} ${icon('x', '', 13)}</button>`).join('') : `<span class="small muted">${esc(t('tags.none_selected'))}</span>`}</div>
        ${sel.length > 1 ? `<button type="button" class="btn ghost sm" data-clear>${esc(t('tags.clear'))}</button>` : ''}</div>
      <div class="tagsel-search">${icon('search', '', 15)}<input class="input" data-q value="${esc(query)}" placeholder="${esc(t(allowNew ? 'tags.search_new' : 'tags.search'))}" autocomplete="off" enterkeyhint="done"></div>
      <div class="tagsel-list" role="listbox" aria-multiselectable="true">${rows.map((tg) => `<button type="button" class="tagsel-row ${chosen.has(keyOf(tg)) ? 'on' : ''}" role="option" aria-selected="${chosen.has(keyOf(tg))}" data-key="${esc(keyOf(tg))}">
          <span class="tagsel-check">${chosen.has(keyOf(tg)) ? icon('check', '', 13) : ''}</span>${dot(tg)}<span class="grow ellipsis">${esc(tg.name)}</span>${tg.count != null ? `<span class="tiny muted">${tg.count}</span>` : ''}</button>`).join('')
        || `<div class="small muted" style="padding:10px">${esc(t('tags.no_match'))}</div>`}
        ${allowNew && q && !exact ? `<button type="button" class="tagsel-row create" data-create>${icon('plus', '', 14)} <span class="grow">${esc(t('tags.create', { name: query.trim() }))}</span></button>` : ''}</div></div>`;
    container.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { chosen.delete(b.dataset.rm); changed(); drawCompact(); }));
    container.querySelector('[data-clear]')?.addEventListener('click', () => { chosen.clear(); changed(); drawCompact(); });
    container.querySelectorAll('.tagsel-row[data-key]').forEach((b) => (b.onclick = () => {
      const tg = all.find((x) => keyOf(x) === b.dataset.key);
      toggle(tg);
      const list = container.querySelector('.tagsel-list'), top = list.scrollTop;
      drawCompact(true);
      container.querySelector('.tagsel-list').scrollTop = top;
    }));
    container.querySelector('[data-create]')?.addEventListener('click', () => { create(query); query = ''; drawCompact(true); });
    const inp = container.querySelector('[data-q]');
    inp.addEventListener('input', () => { query = inp.value; drawCompact(true); });
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!q) return;
      const first = rows.find((tg) => tg.name.toLowerCase() === q) || (rows.length === 1 ? rows[0] : null);
      if (first) { if (!chosen.has(keyOf(first))) toggle(first); } else if (allowNew) create(query);
      query = ''; drawCompact(true);
    });
    if (keepFocus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  };

  (compact ? drawCompact : drawSimple)();
  return {
    value: () => [...chosen.values()].map((tg) => (tg.id_tag ? tg.id_tag : tg.name)),
    ids: () => [...chosen.values()].filter((tg) => tg.id_tag).map((tg) => tg.id_tag),
  };
}
