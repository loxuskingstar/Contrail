// Champs réutilisables : autocomplétion d'aéroport, sélecteur d'étiquettes
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, debounce } from '../ui.js';
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

/** Transforme un <input> en champ aéroport avec suggestions (en ligne et hors-ligne). */
export function airportInput(input, { onPick } = {}) {
  const wrap = input.closest('.input-wrap') || input.parentElement;
  wrap.style.position = 'relative';
  let list = null, items = [], sel = -1;
  const close = () => { list?.remove(); list = null; };
  const pick = (a) => {
    input.value = a.icao;
    input.dataset.name = a.name;
    close();
    rememberAirport(a.icao);
    onPick?.(a);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const show = (arr) => {
    items = arr;
    sel = -1;
    close();
    if (!arr.length) return;
    list = document.createElement('div');
    list.className = 'ac-list';
    list.innerHTML = arr.map((a, i) => `<div class="ac-item" data-i="${i}"><b>${esc(a.icao)}</b><span class="grow ellipsis">${esc(a.name)}<br><span class="tiny muted">${esc(a.city || '')}${a.iata ? ' · ' + esc(a.iata) : ''}</span></span></div>`).join('');
    list.querySelectorAll('.ac-item').forEach((n) => n.addEventListener('mousedown', (e) => { e.preventDefault(); pick(items[Number(n.dataset.i)]); }));
    wrap.append(list);
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    try {
      const res = await api('/api/airports/search', { query: { q, limit: 8 } });
      cacheAirports(res);
      if (document.activeElement === input) show(res);
    } catch {
      show(offlineSearch(q));
    }
  }, 180);
  input.addEventListener('input', search);
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

/** Sélecteur d'étiquettes : bascule des existantes + création à la volée. */
export function tagPicker(container, allTags, selected = []) {
  const chosen = new Map(selected.map((tg) => [tg.id_tag ? String(tg.id_tag) : `new:${tg.name || tg}`, tg]));
  const extra = [];
  const draw = () => {
    const all = [...allTags, ...extra];
    container.innerHTML = `<div class="chips">${all.map((tg) => {
      const key = tg.id_tag ? String(tg.id_tag) : `new:${tg.name}`;
      return `<button type="button" class="chip ${chosen.has(key) ? 'on' : ''}" data-key="${esc(key)}"><span class="sw" style="background:${esc(tg.color || '#64748b')}"></span>${esc(tg.name)}</button>`;
    }).join('')}<button type="button" class="chip" data-add>${icon('plus', '', 14)} ${esc(t('tags.new'))}</button></div>`;
    container.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => {
      const key = b.dataset.key;
      const tg = all.find((x) => (x.id_tag ? String(x.id_tag) : `new:${x.name}`) === key);
      chosen.has(key) ? chosen.delete(key) : chosen.set(key, tg);
      b.classList.toggle('on');
    }));
    container.querySelector('[data-add]').onclick = () => {
      const btn = container.querySelector('[data-add]');
      const inp = document.createElement('input');
      inp.className = 'input';
      inp.style.cssText = 'height:32px;width:150px;border-radius:999px;font-size:13px';
      inp.placeholder = t('tags.name');
      btn.replaceWith(inp);
      inp.focus();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const name = inp.value.trim();
        if (name && ![...allTags, ...extra].some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          const tg = { name, color: '#64748b' };
          extra.push(tg);
          chosen.set(`new:${name}`, tg);
        }
        draw();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { committed = true; draw(); } });
      inp.addEventListener('blur', commit);
    };
  };
  draw();
  return { value: () => [...chosen.values()].map((tg) => (tg.id_tag ? tg.id_tag : tg.name)) };
}
