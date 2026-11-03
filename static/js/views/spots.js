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
    results.innerHTML = `<div class="spotmap"><div class="map" data-map></div><aside class="sm-panel" data-panel><div class="skeleton" style="height:100%"></div></aside></div>`;
    const [{ createMap }, shapes] = await Promise.all([import('../lib/map.js'), import('../lib/shapes.js')]);
    const [m, res] = await Promise.all([createMap(results.querySelector('[data-map]')), api('/api/spots/map', { query: filters }), shapes.loadTypes()]);
    map = m;
    root.querySelector('[data-count]').textContent = t('spots.count', { n: res.total, nf: fmtNum(res.total) });
    const panel = results.querySelector('[data-panel]');
    const places = res.places;
    const byId = new Map(places.map((p) => [p.id, p]));
    const els = new Map();
    let selected = null;
    if (!places.length) { panel.innerHTML = `<div class="sm-empty">${emptyState('map', t('map.empty'), '')}</div>`; return; }

    const placeName = (p) => p.name || (p.kind === 'gps' ? t('map.gps_point') : p.airport) || '—';
    const placeSub = (p) => [p.kind === 'airport' ? [p.airport, p.iata].filter(Boolean).join(' / ') : (p.airport_name || p.airport),
      p.city, p.country ? `${flag(p.country)} ${countryName(p.country)}` : ''].filter(Boolean).join(' · ');
    const kindIcon = { airport: 'plane', location: 'binoculars', gps: 'map-pin' };
    const period = (p) => {
      if (!p.first) return '';
      const a = fmtDate(p.first, { time: false }), b = fmtDate(p.last, { time: false });
      return a === b ? a : `${a} → ${b}`;
    };
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
    const silhouette = (a) => shapes.aircraftDataUrl(shapes.classify(a.aircraft_icao, a.aircraft), accentColor, 40);
    const spotsHref = (p) => p.location_id ? `#/spots?location_id=${p.location_id}` : (p.airport ? `#/spots?airport=${encodeURIComponent(p.airport)}` : '#/spots');

    const pinHtml = (p) => `<button type="button" class="mplace ${p.kind}" data-place="${esc(p.id)}" title="${esc(placeName(p))}">
      ${p.thumbs[0] ? `<img src="${mediaUrl('thumbs', p.thumbs[0])}" alt="">` : `<span class="mp-ic">${icon(kindIcon[p.kind], '', 14)}</span>`}
      <b>${p.count > 999 ? '999+' : p.count}</b></button>`;

    function listView() {
      selected = null;
      els.forEach((el) => el.classList.remove('sel'));
      const b = map.map.getBounds();
      const inView = places.filter((p) => b.contains([p.lng, p.lat]));
      const n = inView.reduce((s, p) => s + p.count, 0);
      panel.innerHTML = `<div class="sm-head"><div><b>${esc(t('map.in_view', { n: inView.length }))}</b><div class="tiny muted">${esc(t('map.spots_n', { n }))}</div></div>
          ${inView.length < places.length ? `<button class="btn sm" data-fitall>${icon('maximize', '', 16)} ${esc(t('map.fit_all'))}</button>` : ''}</div>
        <div class="sm-list">${inView.length ? inView.map((p) => `<button class="sm-place" data-pick="${esc(p.id)}">
          <span class="sm-thumb">${p.thumbs[0] ? `<img loading="lazy" src="${mediaUrl('thumbs', p.thumbs[0])}" alt="">` : icon(kindIcon[p.kind], '', 20)}</span>
          <span class="grow"><b>${esc(placeName(p))}</b><small>${esc(placeSub(p))}</small>
            <small class="muted">${esc(t('map.aircraft_n', { n: p.regs }))} · ${esc(t('map.types_n', { n: p.types_count }))}</small></span>
          <span class="sm-count">${fmtNum(p.count)}</span></button>`).join('') : `<p class="muted small" style="padding:16px">${esc(t('map.none_in_view'))}</p>`}</div>`;
      panel.querySelector('[data-fitall]')?.addEventListener('click', () => map.fit(places.map((p) => [p.lat, p.lng]), { maxZoom: 10 }));
      panel.querySelectorAll('[data-pick]').forEach((btn) => {
        const p = byId.get(btn.dataset.pick);
        btn.onclick = () => select(p, true);
        btn.onmouseenter = () => els.get(p.id)?.classList.add('hot');
        btn.onmouseleave = () => els.get(p.id)?.classList.remove('hot');
      });
    }

    function select(p, fly) {
      selected = p;
      els.forEach((el, id) => el.classList.toggle('sel', id === p.id));
      if (fly) map.map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.map.getZoom(), 11), duration: 500 });
      const more = p.regs - p.aircraft.length;
      panel.innerHTML = `<div class="sm-head"><button class="btn sm ghost" data-back>${icon('chevron-left', '', 16)} ${esc(t('map.all_places'))}</button></div>
        <div class="sm-detail">
          <div class="row" style="gap:10px;align-items:flex-start"><span class="sm-kind">${icon(kindIcon[p.kind], '', 18)}</span>
            <div class="grow"><h3>${esc(placeName(p))}</h3><div class="small muted">${esc(placeSub(p))}</div></div></div>
          <div class="sm-stats">
            <div><b>${fmtNum(p.count)}</b><span>${esc(t('map.k_spots'))}</span></div>
            <div><b>${fmtNum(p.regs)}</b><span>${esc(t('map.k_aircraft'))}</span></div>
            <div><b>${fmtNum(p.types_count)}</b><span>${esc(t('map.k_types'))}</span></div>
          </div>
          ${p.first ? `<div class="tiny muted">${icon('calendar', '', 13)} ${esc(period(p))}</div>` : ''}
          ${p.types.length ? `<div class="chips" style="margin-top:10px">${p.types.map((ty) => `<a class="chip" href="#/spots?type=${encodeURIComponent(ty.k)}">${esc(ty.k)} <span class="muted">${ty.n}</span></a>`).join('')}</div>` : ''}
          <a class="btn sm primary" style="margin-top:12px;width:100%" href="${spotsHref(p)}">${esc(t('map.see_spots', { n: p.count }))} →</a>
        </div>
        <div class="sm-list">${p.aircraft.map((a) => `<a class="sm-ac" href="#/spots/${a.id_spotting}">
            <span class="sm-thumb ${a.thumb ? '' : 'sil'}">${a.thumb ? `<img loading="lazy" src="${mediaUrl('thumbs', a.thumb)}" alt="">` : `<img src="${silhouette(a)}" alt="">`}</span>
            <span class="grow"><span class="row" style="gap:6px"><b class="mono">${esc(a.registration)}</b>${a.n > 1 ? `<span class="badge">×${a.n}</span>` : ''}${a.special ? `<span class="badge accent">${icon('palette', '', 11)}</span>` : ''}${a.favorite ? icon('star', 'fav', 13) : ''}</span>
              <small>${esc([a.aircraft || a.aircraft_icao, a.owner].filter(Boolean).join(' · '))}</small></span>
            <small class="muted nowrap">${a.date ? esc(fmtDate(a.date, { time: false })) : ''}</small></a>`).join('')}
          ${more > 0 ? `<a class="sm-more" href="${spotsHref(p)}">${esc(t('map.more_aircraft', { n: more }))} →</a>` : ''}</div>`;
      panel.querySelector('[data-back]').onclick = listView;
      panel.scrollTop = 0;
    }

    map.clusters('spots', places.map((p) => ({ lat: p.lat, lng: p.lng, count: p.count, html: pinHtml(p), _id: p.id, onClick: () => select(p, false) })), {
      decorate: (pt, el) => { els.set(pt._id, el); if (selected?.id === pt._id) el.classList.add('sel'); },
    });
    map.fit(places.map((p) => [p.lat, p.lng]), { maxZoom: 10 });
    const refresh = debounce(() => { if (!selected) listView(); }, 150);
    map.map.on('moveend', refresh);
    map.map.once('idle', listView);
    setTimeout(() => { if (!selected && panel.querySelector('.skeleton')) listView(); }, 800);
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
