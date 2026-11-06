// Création / édition d'un spot : photo (EXIF + OCR), remplissage auto, étiquettes, audio, brouillon hors-ligne
import { api, mediaUrl, ApiError } from '../api.js';
import { store, navigate } from '../app.js';
import { t, fmtDate, flag, countryName } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput, tagPicker, rememberAirport } from '../lib/fields.js';
import { esc, toast, errorToast, confirmDialog, stars, bindStars, pageHead, debounce, regText } from '../ui.js';
import { saveDraft, uuid } from '../offline.js';

const FLIGHT_TYPES = ['commercial', 'cargo', 'test', 'delivery', 'ferry', 'military', 'business', 'general', 'helicopter', 'medical', 'training', 'airshow', 'government', 'other'];

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// Points de vue : ceux de l'aéroport saisi d'abord, les autres regroupés dessous (la liste complète reste accessible)
function locOptions(locations, airport, selectedId) {
  const ap = String(airport || '').trim().toUpperCase();
  const opt = (l) => `<option value="${l.id_location}" ${selectedId === l.id_location ? 'selected' : ''}>${esc(l.name)}${l.airport ? ` (${esc(l.airport)})` : ''}</option>`;
  const here = ap ? locations.filter((l) => (l.airport || '').toUpperCase() === ap) : [];
  if (!here.length && !ap) return `<option value="">—</option>${locations.map(opt).join('')}`;
  const rest = locations.filter((l) => !here.includes(l));
  return `<option value="">—</option>`
    + (here.length ? `<optgroup label="${esc(t('spot.loc_here', { ap }))}">${here.map(opt).join('')}</optgroup>` : '')
    + (rest.length ? `<optgroup label="${esc(here.length ? t('spot.loc_others') : t('spot.loc_none', { ap }))}">${rest.map(opt).join('')}</optgroup>` : '');
}

export async function render(root, params, query) {
  const editing = !!params.id;
  // Lieu en cours : celui choisi dans la liste des spots (sinon l'aéroport par défaut)
  let scope = {};
  try { scope = JSON.parse(localStorage.getItem('contrail.spotsScope') || 'null') || {}; } catch { /* pas de mémoire locale */ }
  let scopeLL = null;
  if (!editing && scope.place && !query.airport && !query.place) {
    const site = ((store.facets || (await store.refreshFacets().catch(() => null)))?.sites || []).find((x) => x.kind === 'place' && x.value === scope.place);
    if (site && site.lat != null) scopeLL = [site.lat, site.lng];
  }
  const s = editing ? await api(`/api/spots/${params.id}`) : {
    registration: query.reg || '', airport: query.airport || (query.place ? '' : scope.airport || (scope.place ? '' : store.settings.default_airport) || ''),
    place: query.place || (query.airport ? '' : scope.place || ''), lat: query.lat ?? scopeLL?.[0] ?? null, lng: query.lng ?? scopeLL?.[1] ?? null, date: /^\d{4}-\d{2}-\d{2}$/.test(query.date || '') ? `${query.date}T${nowLocal().slice(11)}` : nowLocal(),
    icao24: query.icao24 || '', tags: [], military: 0, favorite: 0, rating: null,
  };
  const isUnknown = typeof s.registration === 'string' && s.registration.startsWith('SANS-IMMAT-');
  if (isUnknown) s.registration = '';
  const [tags, locations] = await Promise.all([
    store.tags ? Promise.resolve(store.tags) : store.refreshTags().catch(() => []),
    store.mod('locations') ? api('/api/locations').catch(() => []) : Promise.resolve([]),
  ]);
  // Patrouille : « simple » = un seul spot nommé (tient lieu d'immatriculation), « détaillé » = un spot par avion
  const simpleOnly = !!s.is_patrol || (!editing && (store.settings.patrol_mode || 'simple') === 'simple');
  let imageFile = null, audioFile = null, removeImage = false, removeAudio = false, dateTouched = editing;
  let recorder = null;

  root.innerHTML = `
    ${pageHead(esc(editing ? t('spot.edit') : t('spot.new')), { compact: false, sub: editing ? `<span class="mono">${esc(s.registration)}</span>` : esc(t('spot.new_sub')) })}
    <form class="stack" style="gap:16px" novalidate>
      <div class="dropzone ${s.image ? 'has' : ''}" data-drop tabindex="0">
        ${s.image ? `<img class="preview" src="${mediaUrl('images', s.image)}" alt="">` : ''}
        <div class="dz-in" ${s.image ? 'hidden' : ''}>${icon('image-plus', '', 40)}<b>${esc(t('spot.photo_drop'))}</b><span class="small muted">${esc(t('spot.photo_hint'))}</span></div>
        <div class="dz-tools" ${s.image ? '' : 'hidden'}><button type="button" class="btn-icon" data-rmimg title="${esc(t('common.remove'))}">${icon('trash-2', '', 18)}</button></div>
        <input type="file" accept="image/*,.heic,.heif" hidden data-file>
      </div>
      <div data-analysis></div>

      <div class="card stack">
        ${simpleOnly ? `<label class="row small" style="gap:8px;cursor:pointer"><input type="checkbox" name="patrol_simple" ${s.is_patrol ? 'checked disabled' : ''}> <b>${esc(t('patrol.simple_toggle'))}</b></label>
        <div class="stack" data-patsimple hidden>
          <div class="field-row">
            <label class="field" style="flex:2"><span>${esc(t('patrol.name'))}</span><input name="patrol_sname" list="patrol-names" value="${esc(s.patrol_name)}" placeholder="${esc(t('patrol.name_ph'))}" autocomplete="off"></label>
            <label class="field"><span>${esc(t('patrol.size'))} <span class="tiny" style="font-weight:500">· ${esc(t('common.optional'))}</span></span><input name="patrol_size" value="${esc(s.patrol_size)}" inputmode="numeric" placeholder="8"></label>
          </div>
          <label class="field"><span>${esc(t('patrol.country'))} <span class="tiny" style="font-weight:500">· ${esc(t('common.optional'))}</span></span>
            <select name="patrol_country"><option value="">—</option>${s.country ? `<option value="${esc(s.country)}" selected>${flag(s.country)} ${esc(countryName(s.country))}</option>` : ''}</select></label>
          <p class="tiny muted">${esc(t('patrol.simple_hint'))}</p>
        </div>` : ''}
        <div data-regblock class="stack">
        <label class="field"><span>${esc(t('spot.registration'))}</span>
          <div class="input-wrap"><input class="input big" name="registration" value="${esc(s.registration)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="F-HBXA" required>
          <button type="button" class="btn-icon" data-lookup title="${esc(t('spot.lookup'))}">${icon('wand-sparkles')}</button></div></label>
        <label class="row small" style="gap:8px;cursor:pointer"><input type="checkbox" name="unknown_registration" ${isUnknown ? 'checked' : ''}> <span>${esc(t('spot.unknown_reg'))}</span> <span class="tiny muted">${esc(t('spot.unknown_reg_hint'))}</span></label>
        <div data-lookup-res></div>
        </div>
        <div data-dup></div>
        <div data-photodup></div>
        <div class="field-row">
          <label class="field"><span>${esc(t('spot.aircraft'))}</span><input name="aircraft" value="${esc(s.aircraft)}" placeholder="Airbus A320-214"></label>
          <label class="field"><span>${esc(t('spot.type_code'))}</span><input name="aircraft_icao" value="${esc(s.aircraft_icao)}" placeholder="A320" autocapitalize="characters"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>${esc(t('spot.owner'))}</span><input name="owner" value="${esc(s.owner)}" placeholder="Air France"></label>
          <label class="field"><span>${esc(t('spot.airline_icao'))}</span><input name="airline_icao" value="${esc(s.airline_icao)}" placeholder="AFR" maxlength="4" autocapitalize="characters"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>${esc(t('spot.msn'))}</span><input name="msn" value="${esc(s.msn)}" inputmode="text"></label>
          <label class="field"><span>${esc(t('spot.manufacturer'))}</span><input name="manufacturer" value="${esc(s.manufacturer)}"></label>
        </div>
      </div>

      <div class="card stack">
        <div class="field-row">
          <label class="field"><span>${esc(t('spot.airport_or_place'))}</span><div class="input-wrap"><input name="airport" value="${esc(s.airport || s.place)}" ${!s.airport && s.place ? 'data-kind="place"' : ''} placeholder="${esc(t('spot.place_ph'))}" autocomplete="off"></div></label>
          <label class="field"><span>${esc(t('spot.date'))}</span><input type="datetime-local" name="date" value="${esc((s.date || '').slice(0, 16))}"></label>
        </div>
        <div class="field"><span>${esc(t('spot.tags'))}</span><div data-tags></div></div>
      </div>

      ${simpleOnly ? '' : `<details class="card fold" data-patrol ${s.patrol ? 'open' : ''}>
        <summary>${icon('users', '', 18)} ${esc(t('patrol.title'))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body stack">
          <label class="field"><span>${esc(t('patrol.name'))} <span class="tiny" style="font-weight:500">· ${esc(t('common.optional'))}</span></span>
            <input name="patrol_name" list="patrol-names" value="${esc(s.patrol?.name)}" placeholder="${esc(t('patrol.name_ph'))}" autocomplete="off"></label>
          ${s.patrol ? `<div class="stack" style="gap:6px"><span class="tiny muted">${esc(t('patrol.members'))}</span><div class="row wrap" style="gap:6px">${s.patrol.members.map((m) => `<a class="chip ${m.id_spotting === s.id_spotting ? 'on' : ''}" href="#/spots/${m.id_spotting}">${esc(regText(m.registration))}</a>`).join('')}</div></div>` : ''}
          <div class="stack" style="gap:8px" data-pat-rows></div>
          <div><button type="button" class="btn sm" data-pat-add>${icon('plus', '', 16)} ${esc(t('patrol.add'))}</button></div>
          <p class="tiny muted">${esc(t('patrol.hint'))}</p>
          ${s.patrol ? `<label class="row small" style="gap:8px;cursor:pointer"><input type="checkbox" name="patrol_leave"> <span>${esc(t('patrol.leave'))}</span></label>` : ''}
        </div>
      </details>`}
      <datalist id="patrol-names"></datalist>

      <details class="card fold" ${s.livery || s.description || s.flight_type || s.test_registration || s.location_id ? 'open' : ''}>
        <summary>${icon('sliders-horizontal', '', 18)} ${esc(t('spot.more_details'))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body stack">
          <label class="field"><span>${esc(t('spot.livery'))}</span><input name="livery" value="${esc(s.livery && s.livery !== 'None' ? s.livery : '')}" placeholder="${esc(t('spot.livery_ph'))}">
            <span class="row" style="gap:6px;margin-top:6px"><button type="button" class="chip" data-primer style="height:28px;font-size:12.5px">${icon('paint-bucket', '', 14)} ${esc(t('livery.primer_chip'))}</button><button type="button" class="chip" data-white style="height:28px;font-size:12.5px">${icon('paint-bucket', '', 14)} ${esc(t('livery.white_chip'))}</button></span></label>
          <div class="field-row">
            <label class="field"><span>${esc(t('spot.flight_type'))}</span><select name="flight_type"><option value="">—</option>${FLIGHT_TYPES.map((f) => `<option value="${f}" ${s.flight_type === f ? 'selected' : ''}>${esc(t(`ftype.${f}`))}</option>`).join('')}</select></label>
            ${locations.length ? `<label class="field"><span>${esc(t('spot.location'))}</span><select name="location_id">${locOptions(locations, s.airport, s.location_id)}</select></label>` : ''}
          </div>
          <label class="field optional"><span>${esc(t('spot.test_registration'))} <span class="tiny" style="font-weight:500">· ${esc(t('common.optional'))}</span></span>
            <input name="test_registration" value="${esc(s.test_registration)}" placeholder="${esc(t('spot.test_registration_ph'))}" autocapitalize="characters" autocomplete="off" spellcheck="false">
            <span class="tiny muted">${esc(t('spot.test_registration_hint'))}</span></label>
          <div class="card" style="padding:2px 14px;background:transparent;box-shadow:none">
            <label class="toggle-row"><span class="t">${esc(t('spot.military'))}</span><span class="switch"><input type="checkbox" name="military" ${s.military ? 'checked' : ''}><span></span></span></label>
            <label class="toggle-row"><span class="t">${esc(t('spot.favorite'))}</span><span class="switch"><input type="checkbox" name="favorite" ${s.favorite ? 'checked' : ''}><span></span></span></label>
            <div class="toggle-row"><span class="t">${esc(t('spot.rating'))}</span>${stars(s.rating || 0)}</div>
          </div>
          <label class="field"><span>${esc(t('spot.description'))}</span><textarea name="description" rows="3">${esc(s.description)}</textarea></label>
        </div>
      </details>

      <details class="card fold" ${s.atc_audio ? 'open' : ''}>
        <summary>${icon('radio', '', 18)} ${esc(t('spot.audio'))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body stack" data-audio-box>
          <div data-audio-current>${s.atc_audio ? `<audio controls src="${mediaUrl('audio', s.atc_audio)}"></audio>` : ''}</div>
          <div class="row wrap">
            <label class="btn sm">${icon('upload', '', 16)} ${esc(t('spot.audio_file'))}<input type="file" accept="audio/*" hidden data-audio></label>
            ${window.MediaRecorder ? `<button type="button" class="btn sm" data-rec>${icon('mic', '', 16)} ${esc(t('spot.audio_record'))}</button>` : ''}
            ${s.atc_audio ? `<button type="button" class="btn sm danger" data-rmaudio>${icon('trash-2', '', 16)} ${esc(t('common.remove'))}</button>` : ''}
          </div>
          <p class="tiny muted">${esc(t('spot.audio_hint'))}</p>
        </div>
      </details>

      <details class="card fold">
        <summary>${icon('camera', '', 18)} ${esc(t('spot.exif'))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body stack">
          <div class="field-row">
            <label class="field"><span>${esc(t('exif.camera'))}</span><input name="camera" value="${esc(s.camera)}"></label>
            <label class="field"><span>${esc(t('exif.lens'))}</span><input name="lens" value="${esc(s.lens)}"></label>
          </div>
          <div class="field-row">
            <label class="field"><span>${esc(t('exif.focal'))}</span><input name="focal" value="${esc(s.focal)}" inputmode="decimal"></label>
            <label class="field"><span>${esc(t('exif.aperture'))}</span><input name="aperture" value="${esc(s.aperture)}" inputmode="decimal"></label>
            <label class="field"><span>ISO</span><input name="iso" value="${esc(s.iso)}" inputmode="numeric"></label>
            <label class="field"><span>${esc(t('exif.shutter'))}</span><input name="shutter" value="${esc(s.shutter)}"></label>
          </div>
          <p class="tiny muted">${esc(t('spot.exif_hint'))}</p>
        </div>
      </details>
      <input type="hidden" name="icao24" value="${esc(s.icao24)}">
      <input type="hidden" name="lat" value="${esc(s.lat ?? '')}"><input type="hidden" name="lng" value="${esc(s.lng ?? '')}">

      <div class="sticky-actions glass">
        <a class="btn ghost" href="${editing ? `#/spots/${s.id_spotting}` : '#/spots'}">${esc(t('common.cancel'))}</a>
        <button class="btn primary grow" type="submit">${icon('check', '', 18)} ${esc(t('common.save'))}</button>
      </div>
    </form>`;

  const form = root.querySelector('form');
  const F = (n) => form.elements[n];
  const drop = root.querySelector('[data-drop]');
  const fileInput = root.querySelector('[data-file]');
  const picker = tagPicker(root.querySelector('[data-tags]'), tags, s.tags || []);
  let rating = s.rating || 0;
  root.querySelector('[data-stars]').dataset.value = rating;
  bindStars(root, (v) => (rating = v));
  // Ville choisie dans les suggestions : ses coordonnées alimentent la carte et le fuseau horaire
  let placeLL = null;
  airportInput(F('airport'), { getLL: () => ((F('airport').dataset.kind === 'place' || (s.place && F('airport').value === s.place)) && F('lat').value && F('lng').value ? [Number(F('lat').value), Number(F('lng').value)] : null), onPick: (a) => {
    if (a.label && a.lat != null) { F('lat').value = a.lat; F('lng').value = a.lng; placeLL = [String(a.lat), String(a.lng)]; }
    else if (placeLL && F('lat').value === placeLL[0]) { F('lat').value = ''; F('lng').value = ''; placeLL = null; }
    checkDup();
  } });
  const locSel = F('location_id');
  const refreshLocs = () => {
    if (!locSel) return;
    const cur = locSel.value ? Number(locSel.value) : null;
    locSel.innerHTML = locOptions(locations, F('airport').dataset.kind === 'place' ? '' : F('airport').value, cur);
  };
  ['input', 'change', 'blur'].forEach((ev) => F('airport').addEventListener(ev, refreshLocs));
  F('airport').addEventListener('input', () => { if (placeLL && F('lat').value === placeLL[0]) { F('lat').value = ''; F('lng').value = ''; placeLL = null; } });
  // Immatriculation inconnue : on désactive le champ (l'avion pourra être identifié plus tard en modifiant le spot)
  const unk = F('unknown_registration');
  const syncUnknown = () => { F('registration').disabled = unk.checked; F('registration').required = !unk.checked; if (unk.checked) F('registration').value = ''; };
  unk.addEventListener('change', syncUnknown);
  syncUnknown();
  F('date').addEventListener('input', () => (dateTouched = true));

  // ------------------------------------------------------------ photo
  const isImg = (f) => !!f && (f.type?.startsWith('image/') || /\.(heic|heif)$/i.test(f.name || ''));
  const isHeic = (f) => /^image\/hei[cf]/i.test(f.type || '') || /\.(heic|heif)$/i.test(f.name || '');
  // Les navigateurs (hors Safari) ne savent pas afficher le HEIC : le serveur renvoie un aperçu JPEG
  async function previewSrc(file) {
    if (isHeic(file) && navigator.onLine) {
      try {
        const fd = new FormData(); fd.append('image', file);
        const r = await fetch('/api/media/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (r.ok) return URL.createObjectURL(await r.blob());
      } catch { /* aperçu indisponible : on retombe sur le fichier brut */ }
    }
    return URL.createObjectURL(file);
  }
  const setPreview = (file) => {
    imageFile = file;
    removeImage = false;
    drop.classList.add('has');
    drop.querySelector('img.preview')?.remove();
    const img = document.createElement('img');
    img.className = 'preview';
    previewSrc(file).then((u) => { if (imageFile === file) img.src = u; });
    drop.prepend(img);
    drop.querySelector('.dz-in').hidden = true;
    drop.querySelector('.dz-tools').hidden = false;
    analyze(file);
    checkPhoto(file);
  };
  // Photo déjà enregistrée ? (empreinte perceptuelle : fonctionne même si le fichier a été redimensionné ou renommé)
  const checkPhoto = async (file) => {
    const box = root.querySelector('[data-photodup]');
    box.innerHTML = '';
    if (!navigator.onLine) return;
    try {
      const fd = new FormData(); fd.append('image', file); if (s.id_spotting) fd.append('exclude_id', s.id_spotting);
      const r = await api('/api/spots/check-photo', { method: 'POST', form: fd });
      box.innerHTML = r.matches.length ? `<div class="ocr-strip warn">${icon('copy', '', 18)}
        <span class="small grow">${esc(t('spot.photo_dup', { n: r.matches.length }))}</span>
        ${r.matches.map((d) => `<a class="chip" href="#/spots/${d.id_spotting}" target="_blank">${esc(d.registration)} · ${esc(fmtDate(d.date, { time: false }))}</a>`).join('')}</div>` : '';
    } catch { box.innerHTML = ''; }
  };
  drop.addEventListener('click', (e) => { if (!e.target.closest('.dz-tools')) fileInput.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.onchange = () => fileInput.files[0] && setPreview(fileInput.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (isImg(f)) setPreview(f); });
  root.querySelector('[data-rmimg]').onclick = () => {
    imageFile = null; removeImage = true;
    drop.classList.remove('has'); drop.querySelector('img.preview')?.remove();
    drop.querySelector('.dz-in').hidden = false; drop.querySelector('.dz-tools').hidden = true;
    root.querySelector('[data-analysis]').innerHTML = '';
  };
  // Coller une image depuis le presse-papiers
  const onPaste = (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => isImg(x)); if (f) setPreview(f); };
  document.addEventListener('paste', onPaste);

  async function analyze(file) {
    const box = root.querySelector('[data-analysis]');
    if (!navigator.onLine) { box.innerHTML = `<div class="ocr-strip small">${icon('wifi-off', '', 16)} ${esc(t('spot.analyze_offline'))}</div>`; return; }
    box.innerHTML = `<div class="ocr-strip small">${icon('scan-text', '', 16)} ${esc(t('spot.analyzing'))}</div>`;
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await api('/api/media/analyze', { method: 'POST', form: fd, query: { ocr: store.mod('ocr'), airport: F('airport').value.trim() } });
      const ex = res.exif || {};
      if (ex.datetime && !dateTouched) F('date').value = ex.datetime;
      for (const k of ['camera', 'lens', 'focal', 'aperture', 'iso', 'shutter']) if (ex[k] != null && !F(k).value) F(k).value = ex[k];
      if (ex.lat != null) { F('lat').value = ex.lat; F('lng').value = ex.lng; }
      if (res.nearest_airport && !F('airport').value) F('airport').value = res.nearest_airport.icao;
      const parts = [];
      const cands = res.ocr?.candidates || [];
      if (cands.length) {
        parts.push(`${icon('scan-text', '', 16)} <span>${esc(t('spot.ocr_found'))}</span>` + cands.slice(0, 4).map((c) => `<button type="button" class="chip" data-reg="${esc(c.registration)}">${flag(c.country)} <span class="mono">${esc(c.registration)}</span></button>`).join(''));
        if (!F('registration').value) { F('registration').value = cands[0].registration; lookup(); }
      } else if (store.mod('ocr') && res.ocr?.available) parts.push(`${icon('scan-text', '', 16)} <span class="muted">${esc(t('spot.ocr_none'))}</span>`);
      const exBits = [ex.camera, ex.lens, ex.focal && `${ex.focal} mm`, ex.aperture && `f/${ex.aperture}`, ex.shutter, ex.iso && `ISO ${ex.iso}`].filter(Boolean);
      if (exBits.length) parts.push(`<span class="small muted" style="width:100%">${icon('camera', '', 14)} ${esc(exBits.join(' · '))}</span>`);
      if (ex.datetime) parts.push(`<span class="small muted">${icon('clock', '', 14)} ${esc(fmtDate(ex.datetime))}</span>`);
      if (res.nearest_airport) parts.push(`<span class="small muted">${icon('map-pin', '', 14)} ${esc(res.nearest_airport.name)}</span>`);
      box.innerHTML = parts.length ? `<div class="ocr-strip">${parts.join('')}</div>` : '';
      box.querySelectorAll('[data-reg]').forEach((b) => (b.onclick = () => { F('registration').value = b.dataset.reg; lookup(true); }));
      checkDup();
    } catch (e) {
      box.innerHTML = '';
      if (!e.offline) errorToast(e);
    }
  }

  // ------------------------------------------------------------ remplissage automatique
  let lastLookup = editing ? s.registration : '';
  async function lookup(force = false) {
    const reg = F('registration').value.trim();
    const out = root.querySelector('[data-lookup-res]');
    if (!reg || (!force && reg.toUpperCase() === lastLookup)) return;
    lastLookup = reg.toUpperCase();
    out.innerHTML = `<div class="lookup-card small">${icon('refresh-cw', '', 16)} ${esc(t('spot.looking_up'))}</div>`;
    try {
      const d = await api(`/api/lookup/aircraft/${encodeURIComponent(reg)}`);
      F('registration').value = d.registration;
      const fill = { aircraft: d.aircraft, aircraft_icao: d.aircraft_icao, owner: d.owner, airline_icao: d.airline_icao, msn: d.msn, manufacturer: d.manufacturer, icao24: d.icao24 };
      let filled = 0;
      for (const [k, v] of Object.entries(fill)) if (v && !F(k).value) { F(k).value = v; filled++; }
      if (d.military && !editing) F('military').checked = true;
      const src = (d.sources || []).map((x) => t(`source.${x}`)).join(', ');
      out.innerHTML = `<div class="lookup-card">${d.country ? `<span class="flag" style="font-size:26px">${flag(d.country)}</span>` : icon('plane', '', 24)}
        <div class="grow"><b>${esc(d.aircraft || d.aircraft_icao || t('spot.unknown_aircraft'))}</b>
        <div class="small muted">${esc([d.owner, d.country && countryName(d.country), d.msn && `MSN ${d.msn}`].filter(Boolean).join(' · '))}</div>
        <div class="tiny muted">${d.found ? esc(t('spot.lookup_sources', { src: src || '—', n: filled })) : esc(t('spot.lookup_none'))}</div></div>
        ${(d.sources || []).includes('history') ? `<a class="badge accent" href="#/airframe/${encodeURIComponent(d.registration)}" target="_blank">${icon('history', '', 12)} ${esc(t('spot.seen_before'))}</a>` : ''}</div>`;
      checkDup();
    } catch (e) {
      out.innerHTML = e.offline ? `<div class="lookup-card small muted">${icon('wifi-off', '', 16)} ${esc(t('spot.lookup_offline'))}</div>` : '';
    }
  }
  F('registration').addEventListener('blur', () => lookup());
  F('registration').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(true); } });
  const PRIMER = /\bprimers?\b|appr[eê]ts?\b|non\s?peint|unpainted|bare\s?metal|sin\s?pintar|未塗装|プライマー/i;
  const primerFlight = () => { if (PRIMER.test(F('livery').value) && !F('flight_type').value) F('flight_type').value = 'test'; };   // « Vol d'essai »
  F('livery').addEventListener('input', primerFlight);
  form.querySelector('[data-primer]')?.addEventListener('click', () => { F('livery').value = 'Primer'; primerFlight(); });
  form.querySelector('[data-white]')?.addEventListener('click', () => { F('livery').value = t('livery.white'); });
  F('registration').addEventListener('input', (e) => { const p = e.target.selectionStart; e.target.value = e.target.value.toUpperCase(); e.target.setSelectionRange(p, p); });
  root.querySelector('[data-lookup]').onclick = () => lookup(true);

  // ------------------------------------------------------------ doublons
  const checkDup = debounce(async () => {
    const reg = F('registration').value.trim(), ap = F('airport').value.trim(), date = F('date').value;
    const box = root.querySelector('[data-dup]');
    if (!reg || !ap || !date || !navigator.onLine) { box.innerHTML = ''; return; }
    try {
      const r = await api('/api/spots/check-duplicate', { method: 'POST', body: { registration: reg, airport: ap, date, exclude_id: s.id_spotting || null } });
      box.innerHTML = r.duplicates.length ? `<div class="ocr-strip warn">${icon('triangle-alert', '', 18)}
        <span class="small grow">${esc(t('spot.dup_warning', { n: r.duplicates.length }))}</span>
        ${r.duplicates.map((d) => `<a class="chip" href="#/spots/${d.id_spotting}" target="_blank">#${d.id_spotting}</a>`).join('')}</div>` : '';
    } catch { box.innerHTML = ''; }
  }, 400);
  ['change', 'blur'].forEach((ev) => { F('airport').addEventListener(ev, checkDup); F('date').addEventListener(ev, checkDup); F('registration').addEventListener(ev, checkDup); });

  // ------------------------------------------------------------ audio
  const audioInput = root.querySelector('[data-audio]');
  const setAudio = (file) => {
    audioFile = file; removeAudio = false;
    root.querySelector('[data-audio-current]').innerHTML = `<audio controls src="${URL.createObjectURL(file)}"></audio><div class="tiny muted">${esc(file.name || '')}</div>`;
  };
  audioInput.onchange = () => audioInput.files[0] && setAudio(audioInput.files[0]);
  root.querySelector('[data-rmaudio]')?.addEventListener('click', () => { removeAudio = true; audioFile = null; root.querySelector('[data-audio-current]').innerHTML = ''; });
  const recBtn = root.querySelector('[data-rec]');
  if (recBtn) recBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const started = Date.now();
      const tick = setInterval(() => { recBtn.innerHTML = `<span class="rec-dot"></span> ${Math.floor((Date.now() - started) / 1000)} s · ${esc(t('spot.audio_stop'))}`; if (Date.now() - started > 120000) recorder?.stop(); }, 250);
      recorder.onstop = () => {
        clearInterval(tick);
        stream.getTracks().forEach((tr) => tr.stop());
        const mime = recorder.mimeType || 'audio/webm';
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        setAudio(new File(chunks, `atc-${Date.now()}.${ext}`, { type: mime }));
        recorder = null;
        recBtn.innerHTML = `${icon('mic', '', 16)} ${esc(t('spot.audio_record'))}`;
      };
      recorder.start();
    } catch { toast(esc(t('spot.mic_denied')), { type: 'error' }); }
  };

  // ------------------------------------------------------------ patrouille : autres avions de la photo
  const patRows = root.querySelector('[data-pat-rows]') || document.createElement('div');
  const addPatRow = () => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.gap = '8px';
    row.innerHTML = `<input class="grow" data-pr placeholder="${esc(t('patrol.reg_ph'))}" autocapitalize="characters" autocomplete="off" spellcheck="false" style="min-width:0">
      <label class="row tiny" style="gap:4px;white-space:nowrap;cursor:pointer"><input type="checkbox" data-pu> ${esc(t('patrol.unknown'))}</label>
      <button type="button" class="btn sm ghost" data-px aria-label="${esc(t('common.remove'))}">${icon('x', '', 16)}</button>`;
    const inp = row.querySelector('[data-pr]'), unkBox = row.querySelector('[data-pu]');
    unkBox.onchange = () => { inp.disabled = unkBox.checked; if (unkBox.checked) inp.value = ''; };
    row.querySelector('[data-px]').onclick = () => row.remove();
    patRows.append(row);
    inp.focus();
  };
  const addBtn = root.querySelector('[data-pat-add]');
  if (addBtn) addBtn.onclick = () => { root.querySelector('[data-patrol]').open = true; addPatRow(); };
  api('/api/spots/patrol-names').then((names) => { root.querySelector('#patrol-names').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join(''); }).catch(() => {});
  // Nationalité de la patrouille : liste des pays, pré-remplie d'après les passages précédents du même nom
  const cSel = form.elements.patrol_country;
  if (cSel) {
    Promise.all([api('/api/spots/countries'), api('/api/spots/patrol-countries')]).then(([codes, known]) => {
      const cur = cSel.value;
      cSel.innerHTML = '<option value="">—</option>' + codes.map((c) => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n))
        .map(({ c, n }) => `<option value="${esc(c)}">${flag(c)} ${esc(n)}</option>`).join('');
      cSel.value = cur;
      const guess = () => { const k = known[F('patrol_sname').value.trim().toLowerCase()]; if (k && !cSel.value) cSel.value = k; };
      F('patrol_sname').addEventListener('change', guess);
      F('patrol_sname').addEventListener('blur', guess);
    }).catch(() => {});
  }
  // Mode simple : la patrouille remplace l'immatriculation
  const patSimple = form.elements.patrol_simple;
  const syncPatrol = () => {
    const on = !!patSimple?.checked;
    root.querySelector('[data-patsimple]')?.toggleAttribute('hidden', !on);
    root.querySelector('[data-regblock]').hidden = on;
    F('registration').required = !on && !unk.checked;
  };
  if (patSimple) { patSimple.addEventListener('change', syncPatrol); syncPatrol(); }

  // ------------------------------------------------------------ enregistrement
  form.onsubmit = async (e) => {
    e.preventDefault();
    const asPatrol = !!patSimple?.checked;
    if (asPatrol && !F('patrol_sname').value.trim()) { F('patrol_sname').focus(); toast(esc(t('err.patrol_name_required')), { type: 'error' }); return; }
    const reg = F('registration').value.trim();
    if (!asPatrol && !reg && !unk.checked) { F('registration').focus(); toast(esc(t('err.registration_required')), { type: 'error' }); return; }
    const data = {};
    for (const k of ['registration', 'aircraft', 'aircraft_icao', 'owner', 'airline_icao', 'msn', 'manufacturer', 'airport', 'date', 'livery', 'flight_type', 'description', 'camera', 'lens', 'focal', 'aperture', 'iso', 'shutter', 'icao24', 'lat', 'lng', 'test_registration']) data[k] = F(k).value.trim();
    data.unknown_registration = unk.checked;
    // Lieu choisi dans les suggestions : on l'enregistre comme lieu ; un texte libre est classé par le serveur
    const isPlace = F('airport').dataset.kind === 'place';
    data.place = isPlace ? data.airport : '';
    if (isPlace) data.airport = '';
    data.location_id = F('location_id')?.value || null;
    data.military = F('military').checked;
    data.favorite = F('favorite').checked;
    data.rating = rating || null;
    data.tags = picker.value();
    if (asPatrol) data.patrol = { simple: true, name: F('patrol_sname').value.trim(), size: F('patrol_size').value.trim(), country: F('patrol_country').value };
    const members = asPatrol ? [] : [...patRows.children].map((r) => ({ registration: r.querySelector('[data-pr]').value.trim(), unknown_registration: r.querySelector('[data-pu]').checked }))
      .filter((m) => m.registration || m.unknown_registration);
    const patName = F('patrol_name')?.value.trim() || '';
    if (asPatrol) { /* déjà renseigné */ }
    else if (editing && s.patrol && F('patrol_leave')?.checked) data.patrol = null;
    else if (members.length || patName || (editing && s.patrol)) data.patrol = { name: patName, members };
    if (removeImage) data.remove_image = true;
    if (removeAudio) data.remove_audio = true;
    if (!editing) data.draft_uuid = uuid();
    if (data.airport) rememberAirport(data.airport.toUpperCase());
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;

    const asDraft = async () => {
      await saveDraft({ data, image: imageFile, audio: audioFile });
      toast(esc(t('drafts.saved')), { type: 'success' });
      navigate('#/drafts');
    };
    if (!editing && !navigator.onLine) { await asDraft(); return; }
    const send = async (force = false) => {
      const fd = new FormData();
      fd.append('data', JSON.stringify({ ...data, force }));
      if (imageFile) fd.append('image', imageFile, imageFile.name || 'photo.jpg');
      if (audioFile) fd.append('audio', audioFile, audioFile.name || 'audio.webm');
      return api(editing ? `/api/spots/${s.id_spotting}` : '/api/spots', { method: editing ? 'PUT' : 'POST', form: fd, query: { force } });
    };
    try {
      let res;
      try {
        res = await send();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.detail?.code === 'duplicate') {
          const ok = await confirmDialog(esc(t('spot.dup_confirm', { n: err.detail.duplicates.length })), { ok: t('spot.save_anyway') });
          if (!ok) { btn.disabled = false; return; }
          res = await send(true);
        } else throw err;
      }
      store.facets = null;
      if (data.tags.some((x) => typeof x === 'string')) store.refreshTags().catch(() => {});
      afterSave(res);
      navigate(`#/spots/${res.spot.id_spotting}`, { replace: editing });
    } catch (err) {
      btn.disabled = false;
      if (err.offline && !editing) { await asDraft(); return; }
      errorToast(err);
    }
  };

  // Photo reçue via la cible de partage du système (Android : « Partager vers Contrail »)
  if (!editing && query.shared && 'caches' in window) {
    caches.open('contrail-share').then(async (c) => {
      const res = await c.match('/shared-image');
      if (!res) return;
      const name = decodeURIComponent(res.headers.get('x-filename') || 'photo.jpg');
      setPreview(new File([await res.blob()], name, { type: res.headers.get('content-type') || 'image/jpeg' }));
      c.delete('/shared-image');
    }).catch(() => {});
  }
  if (!editing && query.reg) lookup(true);
  if (!editing) setTimeout(() => F('registration').focus({ preventScroll: true }), 200);
  return () => { document.removeEventListener('paste', onPaste); recorder?.stop(); };
}

export async function afterSave(res) {
  window.dispatchEvent(new Event('contrail-local-action'));
  toast(esc(t('common.saved')), { type: 'success', duration: 2000 });
  if (res.crossref?.length) {
    const reg = res.spot?.registration || res.flight?.registration;
    const key = res.spot ? 'crossref.spot' : 'crossref.flight';
    toast(`<b>${esc(t(key, { reg, n: res.crossref.length }))}</b>`, { type: 'star', duration: 7000, action: t('nav.airframe'), onAction: () => (location.hash = `#/airframe/${encodeURIComponent(reg)}`) });
  }
  (res.wishes || []).slice(0, 3).forEach((w) => toast(`<b>${esc(t('wish.done_head'))}</b><br>${esc(w.title)}`,
    { type: 'star', duration: 6500, action: t('common.open'), onAction: () => (location.hash = '#/wishlist') }));
  if (res.achievements?.length) {
    const { achName, achDesc, parseCode } = await import('../lib/ach.js');
    // Un toast par série (palier le plus haut), trois au maximum
    const best = new Map();
    for (const code of res.achievements) best.set(parseCode(code).series, code);
    const list = [...best.values()];
    list.slice(0, 3).forEach((code) => toast(`<b>${esc(t('ach.unlocked'))}</b><br>${esc(achName(code))} · ${esc(achDesc(code))}`,
      { type: 'star', duration: 6000, action: t('common.open'), onAction: () => (location.hash = '#/achievements') }));
    if (list.length > 3) toast(esc(t('ach.more_unlocked', { n: list.length - 3 })), { type: 'star', duration: 6000, action: t('common.open'), onAction: () => (location.hash = '#/achievements') });
  }
}
