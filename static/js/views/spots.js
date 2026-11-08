// Collection : liste détaillée, galerie, carte — filtres, sélection multiple, gestes
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtNum, fmtDate, countryName, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { tagPicker } from '../lib/fields.js';
import { esc, sheet, spotRow, spotTile, emptyState, confirmDialog, toast, errorToast, undoToast, enableSwipe, menu, debounce, $ } from '../ui.js';

const PAGE = 60;
const SCOPE_KEY = 'contrail.spotsScope';
const FILTER_KEYS = ['search', 'tag', 'tag_mode', 'airport', 'place', 'type', 'airline', 'year', 'country', 'flight_type', 'special', 'military', 'favorite', 'has_photo', 'has_audio', 'registration', 'camera', 'lens', 'livery_category', 'location_id', 'patrol', 'outing', 'unknown', 'rare', 'rarity', 'daytime', 'weather', 'wind', 'date_from', 'date_to', 'rating_min', 'no_date', 'no_time', 'has_gps', 'no_msn', 'no_type', 'has_notes', 'sort'];

export async function render(root, _p, query) {
  const filters = Object.fromEntries(FILTER_KEYS.filter((k) => query[k] !== undefined && query[k] !== '').map((k) => [k, query[k]]));
  // Lieu actif : à l'ouverture simple de la liste, seuls les spots de l'aéroport ou du lieu choisi s'affichent
  const plainEntry = !FILTER_KEYS.some((k) => k !== 'sort' && query[k]);
  let persistScope = plainEntry;
  const sites = (store.facets || (await store.refreshFacets().catch(() => null)))?.sites || [];
  if (plainEntry && sites.length) {
    let sc = null;
    try { sc = JSON.parse(localStorage.getItem(SCOPE_KEY) || 'null'); } catch { /* pas de mémoire locale */ }
    if (!sc) { const d = store.settings.default_airport; sc = d ? { airport: d } : { [sites[0].kind]: sites[0].value }; }
    const known = sites.some((x) => (sc.airport && x.kind === 'airport' && x.value === sc.airport) || (sc.place && x.kind === 'place' && x.value === sc.place));
    if (known) { if (sc.airport) filters.airport = sc.airport; else filters.place = sc.place; }
  }
  let mode = localStorage.getItem('contrail.spotsView') || 'list';
  let items = [], total = 0, loading = false, done = false, map = null;
  let selecting = false;
  const selected = new Set();
  if (!store.tags) await store.refreshTags().catch(() => (store.tags = []));

  root.innerHTML = `
    <header class="page-head"><div><h1>${esc(t('nav.spots'))}</h1><div class="sub" data-count>&nbsp;</div></div>
      <div class="actions"><a class="btn hide-sm" href="#/bulk">${icon('upload', '', 18)} ${esc(t('bulk.import_btn'))}</a><a class="btn primary hide-sm" href="#/spots/new">${icon('plus', '', 18)} ${esc(t('spot.new'))}</a>
      <button class="btn-icon glassy" data-more>${icon('ellipsis')}</button></div></header>
    <div class="stack" style="gap:12px;margin-bottom:14px">
      <button type="button" class="btn sm scope-btn" data-scope style="align-self:flex-start"></button>
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

  const renderScope = () => {
    const where = filters.airport || filters.place;
    const b = root.querySelector('[data-scope]');
    b.innerHTML = `${icon(filters.place ? 'map-pin' : 'plane-takeoff', '', 16)} ${esc(where || t('spots.scope_all'))} ${icon('chevron-down', '', 14)}`;
    b.classList.toggle('primary', !!where);
  };
  const pickScope = () => {
    const sh = sheet({ title: esc(t('spots.scope_title')), body: `<div class="stack" style="gap:6px">
      <button class="list-row" style="text-align:left" data-s="">${icon('layers', '', 20)}<div class="grow"><b>${esc(t('spots.scope_all'))}</b></div></button>
      ${sites.map((x) => `<button class="list-row" style="text-align:left" data-s="${esc(x.kind)}:${esc(x.value)}">${icon(x.kind === 'place' ? 'map-pin' : 'plane-takeoff', '', 20)}<div class="grow"><b>${esc(x.value)}</b><div class="small muted">${esc(t('spots.count', { n: x.n, nf: fmtNum(x.n) }))}${x.last ? ' · ' + fmtDate(x.last, { time: false, short: true }) : ''}</div></div></button>`).join('')}
      <p class="tiny muted">${esc(t('spots.scope_hint'))}</p></div>` });
    sh.body.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      delete filters.airport; delete filters.place;
      if (b.dataset.s) { const [kind, ...v] = b.dataset.s.split(':'); filters[kind] = v.join(':'); }
      persistScope = true;
      sh.close();
      reload();
    }));
  };

  const syncUrl = () => {
    if (persistScope) { try { localStorage.setItem(SCOPE_KEY, JSON.stringify({ airport: filters.airport || '', place: filters.place || '' })); } catch { /* ignoré */ } }

    const qs = new URLSearchParams(filters).toString();
    history.replaceState(null, '', `#/spots${qs ? '?' + qs : ''}`);
  };

  const renderActive = () => {
    const box = root.querySelector('[data-active]');
    const chips = [];
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'search' || k === 'sort' || k === 'airport' || k === 'place' || k === 'tag_mode') continue;   // portés par le sélecteur de lieu / d'étiquettes
      let label = v;
      if (k === 'tag') {
        const names = String(v).split(',').map((id) => store.tags?.find((x) => String(x.id_tag) === id.trim())?.name || id);
        label = names.join(filters.tag_mode === 'any' ? ` ${t('tags.or')} ` : ' + ');
      }
      if (k === 'country') label = `${flag(v)} ${countryName(v)}`;
      if (['special', 'favorite', 'has_photo', 'has_audio', 'unknown', 'rare'].includes(k)) label = t(`spots.f_${k}`);
      if (['daytime', 'weather', 'wind'].includes(k)) label = t(`f.${k}.${v}`);
      if (k === 'rarity') label = t(`rarity.n.${v}`);
      if (k === 'military') label = v === '1' ? t('spot.military') : t('spots.civil');
      if (k === 'flight_type') label = t(`ftype.${v}`);
      if (k === 'livery_category') label = t(`livery.${v}`);
      if (k === 'patrol') label = t('patrol.title');
      if (['has_gps', 'has_notes', 'no_msn', 'no_type', 'no_date', 'no_time'].includes(k)) label = t(`spots.f_${k}`);
      if (k === 'rating_min') label = `${'★'.repeat(Number(v))}${Number(v) < 5 ? ' +' : ''}`;
      if (k === 'date_from') label = `≥ ${fmtDate(v, { time: false })}`;
      if (k === 'date_to') label = `≤ ${fmtDate(v, { time: false })}`;
      if ((k === 'camera' || k === 'lens') && v === '__none__') label = t(`gear.none_${k}`);
      chips.push(`<button class="chip on" data-rm="${k}">${esc(label)} ${icon('x', '', 14)}</button>`);
    }
    box.innerHTML = chips.join('');
    box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { delete filters[b.dataset.rm]; if (['airport', 'place'].includes(b.dataset.rm)) persistScope = true; reload(); }));
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
      <button class="btn-icon" data-a="all" title="${esc(t('spots.select_all'))}">${icon('list-checks')}</button>
      <button class="btn-icon" data-a="tag" title="${esc(t('spots.add_tag'))}">${icon('tag')}</button>
      <button class="btn-icon" data-a="edit" title="${esc(t('bulk.edit'))}">${icon('pencil')}</button>
      <button class="btn-icon" data-a="fav" title="${esc(t('spot.favorite'))}">${icon('star')}</button>
      <button class="btn-icon" data-a="dl" title="${esc(t('export.photos'))}">${icon('download')}</button>
      <button class="btn-icon" data-a="del" title="${esc(t('common.delete'))}" style="color:var(--danger)">${icon('trash-2')}</button>
      <button class="btn-icon" data-a="x">${icon('x')}</button>`;
    bar.querySelector('[data-a=x]').onclick = () => { selecting = false; selected.clear(); selBar(); reload(true); };
    bar.querySelector('[data-a=dl]').onclick = () => { location.href = `/api/export/photos.zip?ids=${[...selected].join(',')}`; };
    bar.querySelector('[data-a=fav]').onclick = () => bulk('favorite', true);
    bar.querySelector('[data-a=edit]').onclick = bulkEdit;
    // Tout sélectionner : tous les spots du filtre en cours, pas seulement les lignes déjà affichées
    bar.querySelector('[data-a=all]').onclick = async () => {
      try {
        const { ids } = await api('/api/spots/ids', { query: filters });
        ids.forEach((i) => selected.add(i));
        results.querySelectorAll('.list-row').forEach((r) => { r.classList.add('selected'); const c = r.querySelector('.check'); if (c) c.innerHTML = icon('check', '', 14); });
        selBar();
      } catch (e) { errorToast(e); }
    };
    bar.querySelector('[data-a=del]').onclick = async () => {
      if (await confirmDialog(esc(t('spots.confirm_bulk_delete', { n: selected.size })), { danger: true, ok: t('common.delete') })) bulk('delete');
    };
    bar.querySelector('[data-a=tag]').onclick = (e) => menu(e.currentTarget, (store.tags || []).map((tg) => ({ icon: 'tag', label: tg.name, onClick: () => bulk('add_tag', tg.id_tag) })));
  }

  // Modification en masse : seuls les champs cochés sont appliqués aux spots sélectionnés
  function bulkEdit() {
    if (!selected.size) return;
    const FT = ['commercial', 'cargo', 'test', 'delivery', 'ferry', 'military', 'business', 'general', 'helicopter', 'medical', 'training', 'airshow', 'government', 'museum', 'display', 'storage', 'maintenance', 'scrapyard', 'other'];
    const rows = [
      ['country', 'spot.country', '<select name="country"><option value="">—</option></select>'],
      ['airport', 'spot.airport', '<input name="airport" maxlength="10" autocapitalize="characters" spellcheck="false">'],
      ['place', 'spot.place', '<input name="place" maxlength="80">'],
      ['owner', 'spot.owner', '<input name="owner" maxlength="80">'],
      ['aircraft', 'spot.aircraft', '<input name="aircraft" maxlength="80">'],
      ['flight_type', 'spot.flight_type', `<select name="flight_type">${FT.map((f) => `<option value="${f}">${esc(t('ftype.' + f))}</option>`).join('')}</select>`],
      ['livery', 'spot.livery', '<input name="livery" maxlength="80">'],
      ['camera', 'exif.camera', '<input name="camera" maxlength="120" list="bk-cam" autocomplete="off"><datalist id="bk-cam"></datalist>'],
      ['lens', 'exif.lens', '<input name="lens" maxlength="120" list="bk-lens" autocomplete="off"><datalist id="bk-lens"></datalist>'],
      ['day', 'bulk.day', `<input type="date" name="day"><label class="row tiny" style="gap:6px;margin-top:4px;cursor:pointer"><input type="checkbox" data-clear="day"> ${esc(t('bulk.clear_date'))}</label>`],
      ['time', 'bulk.time', `<input type="time" name="time"><label class="row tiny" style="gap:6px;margin-top:4px;cursor:pointer"><input type="checkbox" data-clear="time"> ${esc(t('bulk.clear_time'))}</label>`],
      ['rating', 'spot.rating', '<select name="rating">' + [1, 2, 3, 4, 5].map((n) => `<option value="${n}">${'★'.repeat(n)}</option>`).join('') + '</select>'],
      ['military', 'spot.military', `<select name="military"><option value="1">${esc(t('common.yes'))}</option><option value="0">${esc(t('common.no'))}</option></select>`],
    ];
    const sh = sheet({ title: esc(t('bulk.edit_title', { n: selected.size })), body: `<form class="stack" autocomplete="off"><p class="small muted">${esc(t('bulk.edit_hint'))}</p>
      ${rows.map(([k, lbl, ctl]) => `<div class="row" style="gap:10px;align-items:center"><label class="row" style="gap:8px;width:46%;margin:0"><input type="checkbox" data-use="${k}"> <span class="small">${esc(t(lbl))}</span></label><div class="grow" data-ctl="${k}">${ctl}</div></div>`).join('')}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('bulk.apply'))}</button></div></form>` });
    const form = sh.body.querySelector('form');
    sh.body.querySelector('[data-close]').onclick = sh.close;
    api('/api/gear').then((g) => {
      const fill = (id, items) => { const el = sh.body.querySelector(id); if (el) el.innerHTML = items.map((i) => `<option value="${esc(i.name)}"></option>`).join(''); };
      fill('#bk-cam', g.cameras); fill('#bk-lens', g.lenses);
    }).catch(() => {});
    api('/api/spots/countries').then((codes) => {
      form.elements.country.innerHTML = '<option value="">' + esc(t('spot.country_auto')) + '</option>' + codes.map((c) => ({ c, n: countryName(c) })).sort((x, y) => x.n.localeCompare(y.n)).map(({ c, n }) => `<option value="${esc(c)}">${flag(c)} ${esc(n)}</option>`).join('');
    }).catch(() => {});
    form.querySelectorAll('[data-ctl] input, [data-ctl] select').forEach((el) => el.addEventListener('input', () => { form.querySelector(`[data-use=${el.name || el.dataset.clear}]`).checked = true; }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const value = {};
      form.querySelectorAll('[data-use]:checked').forEach((c) => {
        const k = c.dataset.use, el = form.elements[k];
        if (k === 'day' || k === 'time') {
          // « Effacer » vide la valeur ; sinon une date / une heure doit être saisie
          if (form.querySelector(`[data-clear=${k}]`).checked) value[k] = '';
          else if (el.value) value[k] = el.value;
          return;
        }
        value[k] = el.value;
      });
      if (!Object.keys(value).length) return;
      sh.close();
      await bulk('set', value);
    };
  }

  async function bulk(action, value) {
    if (!selected.size) return;
    try {
      const r = await api('/api/spots/bulk', { method: 'POST', body: { ids: [...selected], action, value } });
      if (action === 'delete' && r.trash?.length) {
        const ids = r.trash.slice();
        toast(esc(t('common.deleted')), { type: 'success', duration: 8000, action: t('common.undo'), onAction: async () => {
          try { for (const id of ids) await api(`/api/trash/${id}/restore`, { method: 'POST' }); toast(esc(t('trash.restored')), { type: 'success' }); reload(true); } catch (e) { errorToast(e); }
        } });
      } else toast(esc(t('common.done')), { type: 'success' });
      selecting = false; selected.clear(); selBar(); reload(true);
    } catch (e) { errorToast(e); }
  }

  async function toggleFav(id) {
    await api(`/api/spots/${id}/favorite`, { method: 'PATCH' }).catch(errorToast);
    reload(true);
  }

  async function removeOne(id) {
    if (!(await confirmDialog(esc(t('spot.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
    const r = await api(`/api/spots/${id}`, { method: 'DELETE' }).catch(errorToast);
    if (r) undoToast(esc(t('common.deleted')), r.trash, { onUndo: () => reload(true) });
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
    renderScope();
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
  root.querySelector('[data-filter]').onclick = () => openFilters(filters, () => { persistScope = persistScope || !FILTER_KEYS.some((k) => k !== 'sort' && k !== 'airport' && k !== 'place' && filters[k]); reload(); });
  root.querySelector('[data-scope]').onclick = pickScope;
  root.querySelector('[data-more]').onclick = (e) => menu(e.currentTarget, [
    { icon: 'square-check', label: t('spots.select'), onClick: startSelect },
    { icon: 'palette', label: t('nav.liveries'), onClick: () => (location.hash = '#/liveries') },
    { icon: 'share-2', label: t('share.this_gallery'), onClick: () => shareGallery(filters) },
    '-',
    { icon: 'file-text', label: t('pdf.export_menu'), onClick: () => exportPdf(filters) },
    { icon: 'download', label: t('settings.export_csv'), onClick: () => (location.href = '/api/export/spots.csv') },
    { icon: 'images', label: t('export.photos_filtered'), onClick: () => exportPhotos(filters) },
  ]);

  root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  reload();
  return () => { io.disconnect(); map?.remove(); $('.sel-bar')?.remove(); };
}

async function shareGallery(filters) {
  const { createShareFlow } = await import('./shares.js');
  let target = 'all';
  for (const k of ['tag', 'airport', 'year', 'type', 'airline', 'registration']) if (filters[k]) { target = `${k}:${filters[k]}${k === 'tag' && filters.tag_mode === 'any' ? ';any' : ''}`; break; }
  if (!filters.tag && filters.special) target = 'special:1';
  if (filters.favorite) target = 'favorite:1';
  createShareFlow({ kind: 'gallery', target });
}

// Panneau de filtres : sections (Avion, Lieu & période, Prise de vue, Matériel, À compléter, Collection), compteur de résultats en direct.
const FILTER_BOOLS = [
  ['favorite', 'star'], ['special', 'sparkles'], ['has_photo', 'image'], ['has_audio', 'audio-lines'], ['has_gps', 'map-pin'], ['has_notes', 'file-text'],
];
const FILTER_TODO = [['unknown', 'circle-help'], ['no_type', 'plane'], ['no_msn', 'hash'], ['no_date', 'calendar-x'], ['no_time', 'clock']];
const FILTER_COUNTED = ['search', 'tag', 'tag_mode', 'airport', 'place', 'type', 'airline', 'year', 'country', 'flight_type', 'special', 'military', 'favorite', 'has_photo', 'has_audio', 'registration', 'camera', 'lens', 'livery_category', 'location_id', 'patrol', 'outing', 'unknown', 'rare', 'rarity', 'daytime', 'weather', 'wind', 'date_from', 'date_to', 'rating_min', 'no_date', 'no_time', 'has_gps', 'no_msn', 'no_type', 'has_notes'];

async function openFilters(filters, onApply) {
  const f = { ...filters };
  const facets = store.facets || (await store.refreshFacets().catch(() => ({ airports: [], types: [], airlines: [], years: [], countries: [], flight_types: [] })));
  const tags = store.tags || [];
  const gear = await api('/api/gear').catch(() => ({ cameras: [], lenses: [] }));
  const all = `<option value="">${esc(t('common.all'))}</option>`;
  const opt = (arr, cur, label = (v) => v) => all + arr.map((v) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
  const gopt = (arr, cur, none) => `${all}<option value="__none__" ${cur === '__none__' ? 'selected' : ''}>${esc(t(none))}</option>` + arr.map((i) => `<option value="${esc(i.name)}" ${cur === i.name ? 'selected' : ''}>${esc(i.name)}${i.count ? ` (${i.count})` : ''}</option>`).join('');
  const fixed = (k, vals, cur, label) => all + vals.map((v) => `<option value="${v}" ${String(cur) === v ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
  const sel = (k, label, html) => `<label class="field"><span>${esc(label)}</span><select data-k="${k}">${html}</select></label>`;
  const tog = ([k, ic]) => `<button type="button" class="chip fchip ${f[k] ? 'on' : ''}" data-b="${k}">${icon(ic, '', 14)} ${esc(t(`spots.f_${k}`))}</button>`;
  const sec = (title, ic, inner, open = true) => `<details class="fsec" ${open ? 'open' : ''}><summary>${icon(ic, '', 16)} <b>${esc(title)}</b> <span class="fcount" data-fc></span>${icon('chevron-down', 'chev', 16)}</summary><div class="stack fsec-body">${inner}</div></details>`;
  const hasGear = gear.cameras.length || gear.lenses.length;

  const s = sheet({ title: esc(t('spots.filters')), body: `
    <div class="stack filters-sheet" style="gap:10px">
      ${tags.length ? `<div class="field"><span>${esc(t('spot.tags'))}</span><div data-tagsel></div>
        <div class="seg" data-tagmode style="display:none;margin-top:6px"><button type="button" data-m="all">${esc(t('tags.match_all'))}</button><button type="button" data-m="any">${esc(t('tags.match_any'))}</button></div></div>` : ''}
      ${sec(t('spots.fs_aircraft'), 'plane', `
        <div class="field-row">${sel('type', t('spot.type'), opt(facets.types, f.type))}${sel('airline', t('spot.owner'), all + facets.airlines.map((a) => `<option value="${esc(a.v)}" ${f.airline === a.v ? 'selected' : ''}>${esc(a.name || a.v)}${a.name && a.name !== a.v ? ` (${esc(a.v)})` : ''}</option>`).join(''))}</div>
        <div class="field-row">${sel('country', t('spot.country'), opt(facets.countries, f.country, (c) => `${flag(c)} ${countryName(c)}`))}${sel('flight_type', t('spot.flight_type'), opt(facets.flight_types, f.flight_type, (v) => t(`ftype.${v}`)))}</div>
        <div class="field-row">${sel('livery_category', t('spot.livery'), fixed('livery_category', ['special', 'retro', 'alliance', 'commemorative', 'logojet', 'cause'], f.livery_category, (v) => t(`livery.${v}`)))}
          ${sel('rarity', t('rarity.title'), fixed('rarity', ['legendary', 'epic', 'rare', 'uncommon', 'common'], f.rarity, (v) => t(`rarity.n.${v}`)))}
          <label class="field"><span>${esc(t('spots.military_filter'))}</span><select data-k="military">${all}<option value="0" ${f.military === '0' ? 'selected' : ''}>${esc(t('spots.civil'))}</option><option value="1" ${f.military === '1' ? 'selected' : ''}>${esc(t('spot.military'))}</option></select></label></div>`)}
      ${sec(t('spots.fs_where_when'), 'map-pin', `
        <div class="field-row">${sel('airport', t('spot.airport'), opt(facets.airports, f.airport))}${(facets.places || []).length ? sel('place', t('spot.place'), opt(facets.places, f.place)) : ''}</div>
        <div class="field-row">${sel('year', t('common.year'), opt(facets.years, f.year))}
          <label class="field"><span>${esc(t('spots.date_from'))}</span><input type="date" data-k="date_from" value="${esc(f.date_from || '')}"></label>
          <label class="field"><span>${esc(t('spots.date_to'))}</span><input type="date" data-k="date_to" value="${esc(f.date_to || '')}"></label></div>`)}
      ${sec(t('spots.fs_shot'), 'sun', `
        <div class="field-row">${sel('daytime', t('f.daytime'), fixed('daytime', ['day', 'golden', 'dawn', 'dusk', 'night'], f.daytime, (v) => t(`f.daytime.${v}`)))}
          ${sel('weather', t('f.weather'), fixed('weather', ['clear', 'partly_cloudy', 'cloudy', 'rain', 'snow', 'storm', 'fog', 'none'], f.weather, (v) => t(`f.weather.${v}`)))}
          ${sel('wind', t('f.wind'), fixed('wind', ['calm', 'moderate', 'strong'], f.wind, (v) => t(`f.wind.${v}`)))}</div>
        ${sel('rating_min', t('spots.rating_min'), all + [1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${String(f.rating_min) === String(n) ? 'selected' : ''}>${'★'.repeat(n)}${n < 5 ? ' +' : ''}</option>`).join(''))}`, false)}
      ${sec(t('nav.gear'), 'aperture', hasGear ? `<div class="field-row">${sel('camera', t('exif.camera'), gopt(gear.cameras, f.camera, 'gear.none_camera'))}${sel('lens', t('exif.lens'), gopt(gear.lenses, f.lens, 'gear.none_lens'))}</div>
        <p class="tiny muted">${esc(t('spots.fs_gear_hint'))}</p>` : `<p class="small muted">${esc(t('gear.empty_text'))}</p>`, !!(f.camera || f.lens))}
      ${sec(t('spots.fs_todo'), 'circle-help', `<div class="chips wrap">${FILTER_TODO.map(tog).join('')}</div><p class="tiny muted">${esc(t('spots.fs_todo_hint'))}</p>`, !!(f.unknown || f.no_type || f.no_msn || f.no_date || f.no_time))}
      ${sec(t('spots.fs_collection'), 'bookmark', `<div class="chips wrap">${FILTER_BOOLS.map(tog).join('')}</div>
        <label class="field"><span>${esc(t('spots.sort'))}</span><select data-k="sort">${['date_desc', 'date_asc', 'created', 'registration', 'type'].map((v) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${esc(t(`sort.${v}`))}</option>`).join('')}</select></label>`)}
      <div class="row" style="justify-content:space-between;position:sticky;bottom:0;background:var(--surface);padding:8px 0 2px;gap:8px"><button class="btn ghost" data-reset>${esc(t('spots.clear_filters'))}</button><button class="btn primary grow" data-apply>${esc(t('common.apply'))}</button></div>
    </div>` });

  // Lecture des champs -> objet de filtres ; compteur de résultats (anti-rebond) et pastilles de sections actives
  const read = () => {
    const g = { ...f };
    s.body.querySelectorAll('[data-k]').forEach((el) => { if (el.value) g[el.dataset.k] = el.value; else delete g[el.dataset.k]; });
    s.body.querySelectorAll('[data-b]').forEach((c) => { if (c.classList.contains('on')) g[c.dataset.b] = '1'; else delete g[c.dataset.b]; });
    return g;
  };
  const applyBtn = s.body.querySelector('[data-apply]');
  const refresh = debounce(async () => {
    const g = read();
    s.body.querySelectorAll('.fsec').forEach((d) => {
      const n = [...d.querySelectorAll('[data-k]')].filter((el) => el.value && el.dataset.k !== 'sort').length + d.querySelectorAll('[data-b].on').length;
      const c = d.querySelector('[data-fc]'); c.textContent = n || ''; c.hidden = !n;
    });
    const query = Object.fromEntries(FILTER_COUNTED.filter((k) => g[k]).map((k) => [k, g[k]]));
    try {
      const r = await api('/api/spots', { query: { ...query, limit: 1 } });
      applyBtn.textContent = t('spots.fs_show', { n: r.total });
    } catch { applyBtn.textContent = t('common.apply'); }
  }, 250);
  s.body.addEventListener('input', refresh);
  s.body.addEventListener('change', refresh);
  s.body.querySelectorAll('[data-b]').forEach((c) => (c.onclick = () => { c.classList.toggle('on'); refresh(); }));
  if (tags.length) {
    const ids = String(f.tag || '').split(',').filter(Boolean);
    const modeBox = s.body.querySelector('[data-tagmode]');
    const syncMode = (n) => {
      modeBox.style.display = n > 1 ? '' : 'none';
      modeBox.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === (f.tag_mode === 'any' ? 'any' : 'all')));
    };
    tagPicker(s.body.querySelector('[data-tagsel]'), tags, tags.filter((tg) => ids.includes(String(tg.id_tag))), {
      allowNew: false,
      onChange: (sel2) => { if (sel2.length) f.tag = sel2.map((x) => x.id_tag).join(','); else { delete f.tag; delete f.tag_mode; } syncMode(sel2.length); refresh(); },
    });
    modeBox.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { if (b.dataset.m === 'any') f.tag_mode = 'any'; else delete f.tag_mode; syncMode(2); refresh(); }));
    syncMode(ids.length);
  }
  refresh();
  s.body.querySelector('[data-reset]').onclick = () => { for (const k of Object.keys(filters)) if (k !== 'search') delete filters[k]; s.close(); onApply(); };
  applyBtn.onclick = () => {
    const g = read();
    for (const k of Object.keys(filters)) delete filters[k];
    Object.assign(filters, g);
    s.close();
    onApply();
  };
}

async function exportPdf(filters) {
  const { openPdfExport } = await import('../lib/pdf-dialog.js');
  const params = {};
  Object.entries(filters || {}).forEach(([k, v]) => { if (v !== '' && v != null && v !== false) params[k] = v === true ? '1' : v; });
  openPdfExport({ kind: 'spots', params, title: t('pdf.spots_title'), filename: 'contrail-spots' });
}

function exportPhotos(filters) {
  const qs = new URLSearchParams();
  Object.entries(filters || {}).forEach(([k, v]) => { if (v !== '' && v != null && v !== false && k !== 'sort') qs.set(k, v === true ? '1' : v); });
  location.href = `/api/export/photos.zip?${qs}`;
}
