// Import en lot : glisser plusieurs photos, vérifier les lignes préremplies (EXIF, OCR, base d'appareils), tout enregistrer
import { api, ApiError } from '../api.js';
import { store } from '../app.js';
import { t } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { tagPicker } from '../lib/fields.js';
import { esc, pageHead, toast, errorToast } from '../ui.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export async function render(root) {
  if (!store.tags) await store.refreshTags().catch(() => (store.tags = []));
  const rows = [];                                  // { id, file, el, data, state }
  root.innerHTML = `${pageHead(esc(t('bulk.title')), { sub: esc(t('bulk.sub')) })}
    <div class="card stack" style="gap:12px;margin-bottom:14px">
      <label class="drop" data-drop style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px;border:2px dashed var(--line);border-radius:14px;cursor:pointer;text-align:center">
        ${icon('upload', '', 28)}<b>${esc(t('bulk.drop'))}</b><span class="small muted">${esc(t('bulk.drop_hint'))}</span>
        <input type="file" accept="image/*,.heic,.heif" multiple hidden data-file></label>
      <div class="field-row">
        <label class="field"><span>${esc(t('bulk.default_airport'))}</span><input data-airport maxlength="10" autocapitalize="characters" spellcheck="false" placeholder="${esc(t('bulk.airport_ph'))}"></label>
        <div class="field"><span>${esc(t('bulk.tags'))}</span><div data-tags></div></div>
      </div>
    </div>
    <div class="stack" style="gap:10px" data-rows></div>
    <div class="row between" style="margin-top:14px;position:sticky;bottom:12px">
      <span class="small muted" data-status></span>
      <button class="btn primary" data-save disabled>${icon('check', '', 18)} ${esc(t('bulk.save_all'))}</button></div>`;
  const $ = (s) => root.querySelector(s);
  const picker = tagPicker($('[data-tags]'), store.tags || [], []);
  const host = $('[data-rows]');

  const status = () => {
    const ok = rows.filter((r) => r.state === 'saved').length;
    $('[data-status]').textContent = rows.length ? t('bulk.status', { ok, n: rows.length }) : '';
    $('[data-save]').disabled = !rows.some((r) => r.state !== 'saved' && r.state !== 'saving');
  };
  const badge = (r, kind, text) => { r.state = kind; const b = r.el.querySelector('[data-badge]'); b.className = `badge ${kind === 'saved' ? 'green' : kind === 'error' || kind === 'dup' ? 'red' : 'slate'}`; b.textContent = text; status(); };

  function addRow(file) {
    const r = { id: uuid(), file, data: {}, state: 'analyzing', uuid: uuid() };
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div style="display:grid;grid-template-columns:96px 1fr auto;gap:12px;align-items:start">
      <div style="width:96px;height:72px;border-radius:10px;overflow:hidden;background:var(--surface-2)"><img alt="" style="width:100%;height:100%;object-fit:cover"></div>
      <div class="stack" style="gap:6px;min-width:0">
        <div class="row wrap" style="gap:6px">
          <input class="input" name="registration" placeholder="${esc(t('spot.registration'))}" autocapitalize="characters" spellcheck="false" style="width:140px;font-family:var(--mono)">
          <input class="input grow" name="aircraft" placeholder="${esc(t('spot.aircraft'))}" style="min-width:140px">
          <input class="input" name="airport" placeholder="${esc(t('spot.airport'))}" maxlength="10" autocapitalize="characters" style="width:100px">
          <input class="input" name="date" type="datetime-local" style="width:200px"></div>
        <div class="tiny muted ellipsis">${esc(file.name)} · <span data-hint></span></div></div>
      <div class="stack" style="gap:6px;align-items:flex-end"><span class="badge slate" data-badge>${esc(t('bulk.analyzing'))}</span>
        <button class="btn-icon" data-rm title="${esc(t('common.delete'))}">${icon('x', '', 16)}</button></div></div>`;
    r.el = el;
    const img = el.querySelector('img');
    img.src = URL.createObjectURL(file);
    img.onerror = () => { img.remove(); };                         // HEIC : pas d'aperçu navigateur, l'import fonctionne quand même
    el.querySelector('[data-rm]').onclick = () => { if (r.state === 'saving') return; rows.splice(rows.indexOf(r), 1); URL.revokeObjectURL(img.src); el.remove(); status(); };
    el.querySelector('[name=registration]').addEventListener('change', (e) => lookup(r, e.target.value));
    host.append(el);
    rows.push(r);
    status();
    return r;
  }
  const F = (r, n) => r.el.querySelector(`[name=${n}]`);

  async function lookup(r, reg) {
    reg = (reg || '').trim();
    if (reg.length < 3) return;
    try {
      const d = await api(`/api/lookup/aircraft/${encodeURIComponent(reg)}`);
      for (const k of ['aircraft_icao', 'owner', 'airline_icao', 'msn', 'manufacturer', 'icao24']) if (d[k]) r.data[k] = d[k];
      if (d.military) r.data.military = 1;
      if (d.aircraft && !F(r, 'aircraft').value) F(r, 'aircraft').value = d.aircraft;
      r.el.querySelector('[data-hint]').textContent = [d.owner, d.found ? '' : t('spot.lookup_none')].filter(Boolean).join(' · ');
    } catch { /* hors ligne : saisie manuelle */ }
  }

  async function analyze(r) {
    try {
      const fd = new FormData(); fd.append('image', r.file, r.file.name);
      const defAirport = $('[data-airport]').value.trim().toUpperCase();
      const a = await api('/api/media/analyze', { method: 'POST', form: fd, query: { ocr: true, airport: defAirport } });
      if (a.exif?.datetime) F(r, 'date').value = a.exif.datetime.slice(0, 16);
      const ap = defAirport || a.nearest_airport?.icao;
      if (ap) F(r, 'airport').value = ap;
      const c = a.ocr?.candidates?.[0];
      if (c && c.registration) { F(r, 'registration').value = c.registration; r.el.querySelector('[data-hint]').textContent = t('bulk.ocr_guess'); await lookup(r, c.registration); }
      badge(r, 'ready', t('bulk.ready'));
    } catch (e) { badge(r, 'ready', t('bulk.no_analysis')); }
  }

  // Analyse en parallèle limitée (l'OCR est coûteux)
  const queue = [];
  let running = 0;
  const pump = () => { while (running < 2 && queue.length) { const r = queue.shift(); running++; analyze(r).finally(() => { running--; pump(); }); } };
  const add = (files) => { for (const f of files) { if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) continue; queue.push(addRow(f)); } pump(); };
  $('[data-file]').addEventListener('change', (e) => { add([...e.target.files]); e.target.value = ''; });
  const drop = $('[data-drop]');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = ''; }));
  drop.addEventListener('drop', (e) => add([...(e.dataTransfer?.files || [])]));

  $('[data-save]').onclick = async () => {
    const btn = $('[data-save]');
    btn.disabled = true;
    const tags = picker.value();
    let done = 0;
    for (const r of rows.filter((x) => x.state !== 'saved')) {
      badge(r, 'saving', t('bulk.saving'));
      const reg = F(r, 'registration').value.trim();
      const data = { ...r.data, registration: reg || undefined, unknown_registration: !reg, aircraft: F(r, 'aircraft').value.trim() || undefined,
        airport: F(r, 'airport').value.trim().toUpperCase() || undefined, date: F(r, 'date').value || undefined, tags, draft_uuid: r.uuid };
      const fd = new FormData();
      fd.append('data', JSON.stringify(data));
      fd.append('image', r.file, r.file.name);
      try {
        await api('/api/spots', { method: 'POST', form: fd, query: { force: r.force || false } });
        badge(r, 'saved', t('bulk.saved')); done++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.detail?.code === 'duplicate') {
          r.force = true;
          badge(r, 'dup', t('bulk.duplicate'));
        } else badge(r, 'error', e.message || t('bulk.error'));
      }
    }
    store.facets = null;
    status();
    toast(esc(t('bulk.done', { n: done })), { type: done ? 'success' : 'info', action: done ? t('bulk.view') : undefined, onAction: () => { location.hash = '#/spots'; } });
    btn.disabled = !rows.some((x) => x.state !== 'saved');
  };
}
