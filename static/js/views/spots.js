// Collection : liste détaillée, galerie, carte — filtres, sélection multiple, gestes
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, fmtDate, countryName, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, spotRow, spotTile, emptyState, confirmDialog, toast, errorToast, enableSwipe, menu, debounce, $ } from '../ui.js';

const PAGE = 60;
const FILTER_KEYS = ['search', 'tag', 'airport', 'type', 'airline', 'year', 'country', 'flight_type', 'special', 'military', 'favorite', 'has_photo', 'has_audio', 'registration', 'camera', 'lens', 'livery_category', 'location_id', 'sort'];

export async function render(root, _p, query) {
  const filters = Object.fromEntries(FILTER_KEYS.filter((k) => query[k] !== undefined && query[k] !== '').map((k) => [k, query[k]]));
  let mode = localStorage.getItem('contrail.spotsView') || 'list';
  let items = [], total = 0, loading = false, done = false, map = null;
  let selecting = false;
  const selected = new Set();
  if (!store.tags) await store.refreshTags().catch(() => (store.tags = []));

  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.spots'))}</h1><div class="sub" data-count>&nbsp;</div></div>
      <div class="actions"><a class="btn primary hide-sm" href="#/spots/new">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>
      <button class="btn-icon glassy" data-more>${icon('ellipsis')}</button></div></header>
    <div class="stack" style="gap:12px;margin-bottom:14px">
      <div class="row">
        <div class="search grow">${icon('search', '', 18)}<input class="input" type="search" placeholder="${esc(t('spots.search'))}" value="${esc(filters.search || '')}"></div>
        <button class="btn-icon glassy" data-filter title="${esc(t('spots.filters'))}">${icon('filter')}</button>
      </div>
      <div class="row between wrap">
        <div class="seg" role="tablist">
          <button data-mode="list">${icon('list', '', 16)}<span class="hide-sm">${esc(t('spots.view_list'))}</span></button>
          <button data-mode="grid">${icon('layout-grid', '', 16)}<span class="hide-sm">${esc(t('spots.view_grid'))}</span></button>
          <button data-mode="map">${icon('map', '', 16)}<span class="hide-sm">${esc(t('spots.view_map'))}</span></button>
        </div>
        <div class="chips scroll" data-active style="flex:1;justify-content:flex-end"></div>
      </div>
    </div>
    <div data-results></div>
    <div data-sentinel style="height:40px"></div>`;

  const results = root.querySelector('[data-results]');
  const sentinel = root.querySelector('[data-sentinel]');

  const syncUrl = () => {
    const qs = new URLSearchParams(filters).toString();
    history.replaceState(null, '', `#/spots${qs ? '?' + qs : ''}`);
  };

  const renderActive = () => {
    const box = root.querySelector('[data-active]');
    const chips = [];
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'search' || k === 'sort') continue;
      let label = v;
      if (k === 'tag') label = store.tags?.find((x) => String(x.id_tag) === String(v))?.name || v;
      if (k === 'country') label = `${flag(v)} ${countryName(v)}`;
      if (['special', 'favorite', 'has_photo', 'has_audio'].includes(k)) label = t(`spots.f_${k}`);
      if (k === 'military') label = v === '1' ? t('spot.military') : t('spots.civil');
      if (k === 'flight_type') label = t(`ftype.${v}`);
      if (k === 'livery_category') label = t(`livery.${v}`);
      chips.push(`<button class="chip on" data-rm="${k}">${esc(label)} ${icon('x', '', 14)}</button>`);
    }
    box.innerHTML = chips.join('');
    box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { delete filters[b.dataset.rm]; reload(); }));
  };

  const setMode = (m) => {
    mode = m;
    localStorage.setItem('contrail.spotsView', m);
    root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    reload();
  };

  async function loadPage() {
    if (loading || done) return;
    loading = true;
    try {
      const res = await api('/api/spots', { query: { ...filters, limit: PAGE, offset: items.length } });
      total = res.total;
      items.push(...res.items);
      done = items.length >= total || !res.items.length;
      root.querySelector('[data-count]').textContent = t('spots.count', { n: total, nf: fmtNum(total) }) + (res.__offline ? ` · ${t('offline.cached')}` : '');
      draw(res.items);
    } catch (e) {
      errorToast(e);
      done = true;
    } finally {
      loading = false;
    }
  }

  function draw(newItems) {
    if (!items.length) {
      const hasFilters = Object.keys(filters).some((k) => k !== 'sort');
      results.innerHTML = hasFilters
        ? emptyState('search', t('spots.no_match'), '', `<button class="btn" data-clear>${esc(t('spots.clear_filters'))}</button>`)
        : emptyState('camera', t('spots.empty'), t('spots.empty_text'), `<a class="btn primary" href="#/spots/new">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>`);
      results.querySelector('[data-clear]')?.addEventListener('click', () => { for (const k of Object.keys(filters)) if (k !== 'sort') delete filters[k]; reload(); });
      return;
    }
    if (mode === 'grid') {
      let g = results.querySelector('.gallery');
      if (!g) { results.innerHTML = '<div class="gallery"></div>'; g = results.querySelector('.gallery'); }
      g.insertAdjacentHTML('beforeend', newItems.map((s) => spotTile(s)).join(''));
    } else if (mode === 'list') {
      let l = results.querySelector('.list');
      if (!l) { results.innerHTML = '<div class="list card" style="padding:6px"></div>'; l = results.querySelector('.list'); }
      const html = newItems.map((s) => `<div class="swipe" data-id="${s.id_spotting}">
        <div class="swipe-actions"><button class="fav">${icon('star', '', 20)}${esc(t('spot.favorite'))}</button><button class="del">${icon('trash-2', '', 20)}${esc(t('common.delete'))}</button></div>
        <div class="swipe-content">${spotRow(s, { selectable: selecting, selected: selected.has(s.id_spotting) })}</div></div>`).join('');
      const frag = document.createElement('div');
      frag.innerHTML = html;
      enableSwipe(frag, { onFav: toggleFav, onDelete: removeOne });
      bindRows(frag);
      l.append(...frag.children);
    }
  }

  function bindRows(scope) {
    scope.querySelectorAll('.list-row').forEach((row) => {
      let timer;
      row.addEventListener('click', (e) => {
        if (!selecting) return;
        e.preventDefault();
        toggleSel(Number(row.dataset.id), row);
      });
      // Appui long : passe en mode sélection
      row.addEventListener('touchstart', () => { timer = setTimeout(() => { if (!selecting) { startSelect(); toggleSel(Number(row.dataset.id)); } }, 550); }, { passive: true });
      row.addEventListener('touchend', () => clearTimeout(timer));
      row.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selecting) startSelect(); toggleSel(Number(row.dataset.id)); });
    });
  }

  function toggleSel(id) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    results.querySelectorAll(`.list-row[data-id="${id}"]`).forEach((r) => {
      r.classList.toggle('selected', selected.has(id));
      const c = r.querySelector('.check');
      if (c) c.innerHTML = selected.has(id) ? icon('check', '', 14) : '';
    });
    selBar();
  }

  function startSelect() {
    selecting = true;
    if (mode !== 'list') setMode('list'); else reload(true);
  }

  function selBar() {
    let bar = $('.sel-bar');
    if (!selecting) { bar?.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'sel-bar glass'; document.body.append(bar); }
    bar.innerHTML = `<b>${esc(t('spots.selected', { n: selected.size }))}</b>
      <button class="btn-icon" data-a="tag" title="${esc(t('spots.add_tag'))}">${icon('tag')}</button>
      <button class="btn-icon" data-a="fav" title="${esc(t('spot.favorite'))}">${icon('star')}</button>
      <button class="btn-icon" data-a="del" title="${esc(t('common.delete'))}" style="color:var(--danger)">${icon('trash-2')}</button>
      <button class="btn-icon" data-a="x">${icon('x')}</button>`;
    bar.querySelector('[data-a=x]').onclick = () => { selecting = false; selected.clear(); selBar(); reload(true); };
    bar.querySelector('[data-a=fav]').onclick = () => bulk('favorite', true);
    bar.querySelector('[data-a=del]').onclick = async () => {
      if (await confirmDialog(esc(t('spots.confirm_bulk_delete', { n: selected.size })), { danger: true, ok: t('common.delete') })) bulk('delete');
    };
    bar.querySelector('[data-a=tag]').onclick = (e) => menu(e.currentTarget, (store.tags || []).map((tg) => ({ icon: 'tag', label: tg.name, onClick: () => bulk('add_tag', tg.id_tag) })));
  }

  async function bulk(action, value) {
    if (!selected.size) return;
    try {
      await api('/api/spots/bulk', { method: 'POST', body: { ids: [...selected], action, value } });
      toast(esc(t('common.done')), { type: 'success' });
      selecting = false; selected.clear(); selBar(); reload(true);
    } catch (e) { errorToast(e); }
  }

  async function toggleFav(id) {
    await api(`/api/spots/${id}/favorite`, { method: 'PATCH' }).catch(errorToast);
    reload(true);
  }

  async function removeOne(id) {
    if (!(await confirmDialog(esc(t('spot.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
    await api(`/api/spots/${id}`, { method: 'DELETE' }).catch(errorToast);
    reload(true);
  }

  async function drawMap() {
    results.innerHTML = '<div class="map tall" data-map></div>';
    const { createMap } = await import('../lib/map.js');
    const [m, res] = await Promise.all([createMap(results.querySelector('[data-map]')), api('/api/spots/map', { query: filters })]);
    map = m;
    root.querySelector('[data-count]').textContent = t('spots.count', { n: res.total, nf: fmtNum(res.total) });
    const pts = [], items = [];
    for (const c of res.clusters) {
      pts.push([c.lat, c.lng]);
      const thumbs = c.spots.filter((s) => s.thumb).slice(0, 6).map((s) => `<a href="#/spots/${s.id_spotting}"><img src="${mediaUrl('thumbs', s.thumb)}" alt="${esc(s.registration)}"></a>`).join('');
      const regs = c.spots.slice(0, 6).map((s) => `<a href="#/spots/${s.id_spotting}" class="mono">${esc(s.registration)}</a>`).join(', ');
      items.push({ lat: c.lat, lng: c.lng, count: c.count, label: c.count > 99 ? '99+' : c.count, popup:
        `<b>${esc(c.label || c.airport || t('spots.custom_location'))}</b> <span class="muted">· ${c.count}</span><div class="small" style="margin-top:4px">${regs}</div>
         ${thumbs ? `<div class="pop-thumbs">${thumbs}</div>` : ''}${c.airport ? `<div style="margin-top:8px"><a href="#/spots?airport=${esc(c.airport)}">${esc(t('common.see_all'))} →</a></div>` : ''}` });
    }
    map.clusters('spots', items);
    map.fit(pts, { maxZoom: 10 });
  }

  function reload(keepScroll = false) {
    const y = window.scrollY;
    syncUrl();
    renderActive();
    map?.remove(); map = null;
    items = []; done = false; results.innerHTML = '';
    if (mode === 'map') { drawMap().catch(errorToast); return; }
    results.innerHTML = `<div class="skeleton" style="height:${mode === 'grid' ? 260 : 340}px"></div>`;
    loadPage().then(() => { if (keepScroll) window.scrollTo(0, y); });
  }

  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && mode !== 'map') loadPage(); }, { rootMargin: '600px' });
  io.observe(sentinel);

  root.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  root.querySelector('input[type=search]').addEventListener('input', debounce((e) => {
    const v = e.target.value.trim();
    if (v) filters.search = v; else delete filters.search;
    reload();
  }, 300));
  root.querySelector('[data-filter]').onclick = () => openFilters(filters, reload);
  root.querySelector('[data-more]').onclick = (e) => menu(e.currentTarget, [
    { icon: 'square-check', label: t('spots.select'), onClick: startSelect },
    { icon: 'palette', label: t('nav.liveries'), onClick: () => (location.hash = '#/liveries') },
    { icon: 'share-2', label: t('share.this_gallery'), onClick: () => shareGallery(filters) },
    '-',
    { icon: 'download', label: t('settings.export_csv'), onClick: () => (location.href = '/api/export/spots.csv') },
  ]);

  root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  reload();
  return () => { io.disconnect(); map?.remove(); $('.sel-bar')?.remove(); };
}

async function shareGallery(filters) {
  const { createShareFlow } = await import('./shares.js');
  let target = 'all';
  for (const k of ['tag', 'airport', 'year', 'type', 'airline', 'registration']) if (filters[k]) { target = `${k}:${filters[k]}`; break; }
  if (!filters.tag && filters.special) target = 'special:1';
  if (filters.favorite) target = 'favorite:1';
  createShareFlow({ kind: 'gallery', target });
}

async function openFilters(filters, onApply) {
  const f = { ...filters };
  const facets = store.facets || (await store.refreshFacets().catch(() => ({ airports: [], types: [], airlines: [], years: [], countries: [], flight_types: [] })));
  const tags = store.tags || [];
  const opt = (arr, cur, label = (v) => v) => `<option value="">${esc(t('common.all'))}</option>` + arr.map((v) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
  const s = sheet({ title: esc(t('spots.filters')), body: `
    <div class="stack">
      ${tags.length ? `<div class="field"><span>${esc(t('spot.tags'))}</span><div class="chips">${tags.map((tg) => `<button class="chip ${String(f.tag) === String(tg.id_tag) ? 'on' : ''}" data-tag="${tg.id_tag}"><span class="sw" style="background:${esc(tg.color)}"></span>${esc(tg.name)}</button>`).join('')}</div></div>` : ''}
      <div class="field-row">
        <label class="field"><span>${esc(t('spot.airport'))}</span><select data-k="airport">${opt(facets.airports, f.airport)}</select></label>
        <label class="field"><span>${esc(t('spot.type'))}</span><select data-k="type">${opt(facets.types, f.type)}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>${esc(t('spot.owner'))}</span><select data-k="airline"><option value="">${esc(t('common.all'))}</option>${facets.airlines.map((a) => `<option value="${esc(a.v)}" ${f.airline === a.v ? 'selected' : ''}>${esc(a.name || a.v)}${a.name && a.name !== a.v ? ` (${esc(a.v)})` : ''}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(t('common.year'))}</span><select data-k="year">${opt(facets.years, f.year)}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>${esc(t('spot.country'))}</span><select data-k="country">${opt(facets.countries, f.country, (c) => `${flag(c)} ${countryName(c)}`)}</select></label>
        <label class="field"><span>${esc(t('spot.flight_type'))}</span><select data-k="flight_type">${opt(facets.flight_types, f.flight_type, (v) => t(`ftype.${v}`))}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>${esc(t('spots.military_filter'))}</span><select data-k="military"><option value="">${esc(t('common.all'))}</option><option value="0" ${f.military === '0' ? 'selected' : ''}>${esc(t('spots.civil'))}</option><option value="1" ${f.military === '1' ? 'selected' : ''}>${esc(t('spot.military'))}</option></select></label>
        <label class="field"><span>${esc(t('spots.sort'))}</span><select data-k="sort">${['date_desc', 'date_asc', 'created', 'registration', 'type'].map((v) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${esc(t(`sort.${v}`))}</option>`).join('')}</select></label>
      </div>
      <div class="card" style="padding:4px 14px">
        ${['favorite', 'special', 'has_photo', 'has_audio'].map((k) => `<label class="toggle-row"><span class="t">${esc(t(`spots.f_${k}`))}</span><span class="switch"><input type="checkbox" data-b="${k}" ${f[k] ? 'checked' : ''}><span></span></span></label>`).join('')}
      </div>
      <div class="row" style="justify-content:space-between"><button class="btn ghost" data-reset>${esc(t('spots.clear_filters'))}</button><button class="btn primary" data-apply>${esc(t('common.apply'))}</button></div>
    </div>` });
  s.body.querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => {
    const on = String(f.tag) === b.dataset.tag;
    s.body.querySelectorAll('[data-tag]').forEach((x) => x.classList.remove('on'));
    if (on) delete f.tag; else { f.tag = b.dataset.tag; b.classList.add('on'); }
  }));
  s.body.querySelector('[data-reset]').onclick = () => { for (const k of Object.keys(filters)) if (k !== 'search') delete filters[k]; s.close(); onApply(); };
  s.body.querySelector('[data-apply]').onclick = () => {
    s.body.querySelectorAll('[data-k]').forEach((sel) => { if (sel.value) f[sel.dataset.k] = sel.value; else delete f[sel.dataset.k]; });
    s.body.querySelectorAll('[data-b]').forEach((c) => { if (c.checked) f[c.dataset.b] = '1'; else delete f[c.dataset.b]; });
    for (const k of Object.keys(filters)) delete filters[k];
    Object.assign(filters, f);
    s.close();
    onApply();
  };
}
