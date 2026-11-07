// Export PDF : fenêtre de personnalisation (format, couleur, police, couverture, contenu) + aperçu / téléchargement
import { store } from '../app.js';
import { t } from '../i18n.js';
import { icon } from './icons.js';
import { esc, sheet, toast, errorToast } from '../ui.js';

export const ACCENTS = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#10b981', '#0ea5e9', '#64748b'];
const YEAR_SECTIONS = ['kpis', 'months', 'firsts', 'top', 'photos', 'special'];
const SPOT_COLS = ['photo', 'reg', 'type', 'owner', 'livery', 'date', 'place', 'tags', 'rating', 'notes', 'msn'];
const DEFAULT_COLS = ['photo', 'reg', 'type', 'owner', 'date', 'place'];

/** Réglages PDF enregistrés (clés pdf_*), avec valeurs par défaut. */
export function pdfDefaults() {
  const S = store.settings || {};
  return {
    page: S.pdf_page || 'A4', orient: S.pdf_orient || 'portrait', accent: S.pdf_accent || '',
    font: S.pdf_font || 'modern', cover: S.pdf_cover !== false, cover_style: S.pdf_cover_style || 'band',
    photos: S.pdf_photos !== false, density: S.pdf_density || 'comfortable', footer: S.pdf_footer || '', author: S.pdf_author || '',
  };
}

const sel = (name, value, items) => `<label class="field"><span>${esc(t(`pdf.o_${name}`))}</span><select class="input" data-o="${name}">${items.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const sw = (name, label, checked) => `<label class="toggle-row"><span class="t">${esc(label)}</span><span class="switch"><input type="checkbox" data-o="${name}" ${checked ? 'checked' : ''}><span></span></span></label>`;

/** Champs communs de mise en page et de style (utilisés par la fenêtre d'export et par les réglages). */
export function pdfOptionsHtml(v, { photos = true, cover = true } = {}) {
  const sw1 = ['', ...ACCENTS].map((c) => `<button type="button" data-swatch="${c}" class="${(v.accent || '') === c ? 'on' : ''}" style="background:${c || 'var(--accent)'}" aria-label="${c || t('pdf.accent_ui')}" title="${c ? c : esc(t('pdf.accent_ui'))}">${c ? '' : icon('palette', '', 14)}</button>`).join('');
  return `<div class="stack pdf-opts">
    <div class="field-row">
      ${sel('page', v.page, [['A4', 'A4'], ['LETTER', 'Letter']])}
      ${sel('orient', v.orient, [['portrait', t('pdf.portrait')], ['landscape', t('pdf.landscape')]])}
    </div>
    <div class="field-row">
      ${sel('font', v.font, [['modern', t('pdf.f_modern')], ['classic', t('pdf.f_classic')]])}
      ${sel('density', v.density, [['comfortable', t('pdf.d_comfortable')], ['compact', t('pdf.d_compact')]])}
    </div>
    <div class="field"><span>${esc(t('pdf.o_accent'))}</span><div class="color-swatches" data-swatches>${sw1}
      <input type="color" value="${esc(v.accent || store.settings?.accent || '#3b82f6')}" data-custom-accent title="${esc(t('settings.custom_color'))}"></div></div>
    ${cover ? `${sw('cover', t('pdf.o_cover'), v.cover)}
      <div data-cover-opts ${v.cover ? '' : 'hidden'}>${sel('cover_style', v.cover_style, [['band', t('pdf.c_band')], ['photo', t('pdf.c_photo')], ['minimal', t('pdf.c_minimal')]])}</div>` : ''}
    ${photos ? sw('photos', t('pdf.o_photos'), v.photos) : ''}
    <div class="field-row">
      <label class="field"><span>${esc(t('pdf.o_footer'))}</span><input class="input" data-o="footer" maxlength="120" value="${esc(v.footer)}" placeholder="Contrail"></label>
      <label class="field"><span>${esc(t('pdf.o_author'))}</span><input class="input" data-o="author" maxlength="80" value="${esc(v.author)}" placeholder="${esc(store.settings?.photographer || '')}"></label>
    </div></div>`;
}

/** Lit les champs de pdfOptionsHtml dans `root`. */
export function readPdfOptions(root) {
  const o = {};
  root.querySelectorAll('[data-o]').forEach((el) => { o[el.dataset.o] = el.type === 'checkbox' ? el.checked : el.value; });
  const on = root.querySelector('[data-swatch].on');
  o.accent = on ? on.dataset.swatch : (root.querySelector('[data-custom-accent]')?.dataset.touched ? root.querySelector('[data-custom-accent]').value : '');
  return o;
}

/** Branche les interactions des pastilles de couleur et de l'option couverture. */
export function bindPdfOptions(root, onChange = () => {}) {
  root.querySelectorAll('[data-swatch]').forEach((b) => (b.onclick = () => {
    root.querySelectorAll('[data-swatch]').forEach((x) => x.classList.toggle('on', x === b));
    const ci = root.querySelector('[data-custom-accent]'); if (ci) { ci.dataset.touched = ''; if (b.dataset.swatch) ci.value = b.dataset.swatch; }
    onChange();
  }));
  const ci = root.querySelector('[data-custom-accent]');
  if (ci) ci.oninput = () => { ci.dataset.touched = '1'; root.querySelectorAll('[data-swatch]').forEach((x) => x.classList.remove('on')); onChange(); };
  const cover = root.querySelector('[data-o=cover]');
  if (cover) cover.onchange = () => { const box = root.querySelector('[data-cover-opts]'); if (box) box.hidden = !cover.checked; onChange(); };
  root.querySelectorAll('[data-o]').forEach((el) => { if (el !== cover) el.addEventListener('change', onChange); });
}

const memKey = (kind) => `contrail.pdf.${kind}`;
const loadMem = (kind) => { try { return JSON.parse(localStorage.getItem(memKey(kind))) || {}; } catch { return {}; } };
const saveMem = (kind, v) => { try { localStorage.setItem(memKey(kind), JSON.stringify(v)); } catch { /* stockage indisponible */ } };

/**
 * Ouvre la fenêtre d'export PDF.
 * kind : 'year' | 'spots' | 'spot' | 'flights' ; params : paramètres propres au document (année, filtres, identifiant…).
 */
export function openPdfExport({ kind, params = {}, title = '', filename = 'contrail' }) {
  const v = pdfDefaults();
  const mem = loadMem(kind);
  if (kind === 'spot') v.cover = false;                                     // une fiche d'une page n'a pas besoin de couverture
  const extras = { sections: mem.sections || YEAR_SECTIONS, cols: mem.cols || DEFAULT_COLS, group: mem.group || 'none', title: mem.title ?? '' };
  let extraHtml = '';
  if (kind === 'year') {
    extraHtml = `<div class="field"><span>${esc(t('pdf.o_sections'))}</span><div class="chips" data-chips="sections">${YEAR_SECTIONS.map((s) => `<button type="button" class="chip ${extras.sections.includes(s) ? 'on' : ''}" data-v="${s}">${esc(t(`pdf.s_${s}`))}</button>`).join('')}</div></div>`;
  } else if (kind === 'spots') {
    extraHtml = `<label class="field"><span>${esc(t('pdf.o_title'))}</span><input class="input" data-x="title" maxlength="120" value="${esc(params.title || '')}" placeholder="${esc(t('pdf.spots_title'))}"></label>
      <div class="field"><span>${esc(t('pdf.o_cols'))}</span><div class="chips" data-chips="cols">${SPOT_COLS.map((c) => `<button type="button" class="chip ${extras.cols.includes(c) ? 'on' : ''}" data-v="${c}">${esc(t(`pdf.col_${c}`))}</button>`).join('')}</div></div>
      <label class="field"><span>${esc(t('pdf.o_group'))}</span><select class="input" data-x="group">${[['none', t('pdf.g_none')], ['year', t('pdf.g_year')], ['day', t('pdf.g_day')], ['airport', t('pdf.g_airport')]].map(([k, l]) => `<option value="${k}" ${extras.group === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  const s = sheet({
    title: `${icon('file-text', '', 18)} ${esc(t('pdf.export_title'))}`, wide: true,
    body: `<div class="stack">${title ? `<p class="small muted" style="margin:0">${esc(title)}</p>` : ''}${extraHtml}${pdfOptionsHtml(v, { photos: kind !== 'flights', cover: true })}
      <label class="toggle-row"><span><span class="t">${esc(t('pdf.save_defaults'))}</span><br><span class="d">${esc(t('pdf.save_defaults_d'))}</span></span><span class="switch"><input type="checkbox" data-defaults><span></span></span></label>
      <div class="row wrap" style="gap:8px;justify-content:flex-end"><button class="btn" data-preview>${icon('eye', '', 16)} ${esc(t('pdf.preview'))}</button><button class="btn primary" data-dl>${icon('download', '', 16)} ${esc(t('pdf.download'))}</button></div></div>`,
  });
  const root = s.body;
  bindPdfOptions(root);
  root.querySelectorAll('[data-chips] .chip').forEach((c) => (c.onclick = () => c.classList.toggle('on')));
  const chosen = (name) => [...root.querySelectorAll(`[data-chips=${name}] .chip.on`)].map((c) => c.dataset.v);

  const buildUrl = () => {
    const o = readPdfOptions(root);
    const qs = new URLSearchParams();
    for (const [k, val] of Object.entries(o)) { if (val === '' || val === undefined) continue; qs.set(k, val === true ? '1' : val === false ? '0' : val); }
    if (kind === 'year') { const c = chosen('sections'); if (c.length) qs.set('sections', c.join(',')); }
    if (kind === 'spots') {
      const c = chosen('cols'); if (c.length) qs.set('cols', c.join(','));
      qs.set('group', root.querySelector('[data-x=group]').value);
      const ti = root.querySelector('[data-x=title]').value.trim(); if (ti) qs.set('title', ti);
      for (const [k, val] of Object.entries(params)) if (k !== 'title' && val !== '' && val != null && val !== false) qs.set(k, val === true ? '1' : val);
    } else if (kind === 'flights') {
      for (const [k, val] of Object.entries(params)) if (val) qs.set(k, val);
    }
    const path = kind === 'year' ? `year/${params.year}` : kind === 'spot' ? `spot/${params.id}` : kind;
    return { url: `/api/pdf/${path}?${qs}`, o };
  };

  const run = async (btn, mode) => {
    const { url, o } = buildUrl();
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `${icon('refresh-cw', 'spin', 16)} ${esc(t('pdf.generating'))}`;
    const win = mode === 'preview' ? window.open('', '_blank') : null;            // ouvert tout de suite : sinon bloqué par le navigateur
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status === 404 ? 'no_data' : `HTTP ${res.status}`);
      const blobUrl = URL.createObjectURL(await res.blob());
      if (mode === 'preview' && win) win.location.href = blobUrl;
      else { const a = document.createElement('a'); a.href = blobUrl; a.download = `${filename}.pdf`; document.body.append(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
      saveMem(kind, { sections: chosen('sections').length ? chosen('sections') : undefined, cols: chosen('cols').length ? chosen('cols') : undefined, group: root.querySelector('[data-x=group]')?.value });
      if (root.querySelector('[data-defaults]').checked) {
        await store.saveSettings({ pdf_page: o.page, pdf_orient: o.orient, pdf_accent: o.accent || '', pdf_font: o.font, pdf_cover: !!o.cover, pdf_cover_style: o.cover_style,
          pdf_photos: o.photos !== false, pdf_density: o.density, pdf_footer: o.footer || '', pdf_author: o.author || '' });
        localStorage.setItem('contrail.settings', JSON.stringify(store.settings));
        root.querySelector('[data-defaults]').checked = false;
        toast(esc(t('common.saved')), { type: 'success', duration: 1500 });
      }
    } catch (e) {
      win?.close();
      if (e.message === 'no_data') toast(esc(t('pdf.no_data')), { type: 'error' }); else errorToast(e);
    } finally { btn.disabled = false; btn.innerHTML = label; }
  };
  root.querySelector('[data-preview]').onclick = (e) => run(e.currentTarget, 'preview');
  root.querySelector('[data-dl]').onclick = (e) => run(e.currentTarget, 'download');
}
