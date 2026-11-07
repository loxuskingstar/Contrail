// Enregistrements en tâche de fond : l'utilisateur continue à naviguer pendant qu'une pastille flottante (bas droite) suit l'envoi.
// File d'attente séquentielle (ordre conservé, pas de course sur les doublons). L'état vit dans ce module : il survit à la navigation.
import { api, ApiError } from '../api.js';
import { t, has } from '../i18n.js';
import { icon } from './icons.js';
import { esc } from '../ui.js';
import { saveDraft } from '../offline.js';

const jobs = [];                 // { id, label, state, pct, el, run, ... }
let host = null;
let busy = false;
let seq = 0;
const DONE_MS = 1800;            // la pastille « terminé » reste 1,8 s puis disparaît

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.className = 'upl-host';
  host.setAttribute('aria-live', 'polite');
  document.body.append(host);
  return host;
}

function view(job) {
  const s = job.state;
  const ic = s === 'done' ? 'check' : s === 'error' || s === 'dup' ? 'triangle-alert' : s === 'draft' ? 'file-text' : 'upload';
  const msg = s === 'queued' ? t('upl.queued')
    : s === 'sending' ? t('spot.sending', { p: Math.round(job.pct * 100) })
    : s === 'processing' ? t('spot.processing')
    : s === 'done' ? t('upl.done')
    : s === 'draft' ? t('upl.draft_saved')
    : s === 'dup' ? t('upl.dup')
    : `${t('upl.failed')}${job.error ? ` — ${job.error}` : ''}`;
  const bar = s === 'sending' ? Math.max(4, Math.round(job.pct * 100)) : s === 'processing' ? 100 : s === 'done' ? 100 : 0;
  const actions = s === 'error' ? `<button class="btn sm" data-a="retry">${esc(t('upl.retry'))}</button><button class="btn sm ghost" data-a="draft">${esc(t('upl.draft'))}</button>`
    : s === 'dup' ? `<button class="btn sm" data-a="force">${esc(t('spot.save_anyway'))}</button><button class="btn sm ghost" data-a="cancel">${esc(t('common.cancel'))}</button>` : '';
  job.el.className = `upl-item ${s}`;
  job.el.innerHTML = `<div class="upl-row">${icon(ic, '', 18)}<div class="upl-txt"><b class="ellipsis">${esc(job.label)}</b><span class="small ellipsis">${esc(msg)}</span></div>
    ${s === 'error' || s === 'dup' ? `<button class="btn-icon" data-a="cancel" aria-label="${esc(t('common.close'))}">${icon('x', '', 16)}</button>` : ''}</div>
    ${bar ? `<div class="upl-bar ${s === 'processing' ? 'busy' : ''}"><i style="width:${bar}%"></i></div>` : ''}
    ${actions ? `<div class="upl-actions">${actions}</div>` : ''}`;
  job.el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); act(job, b.dataset.a); }));
}

function remove(job) {
  job.el.classList.add('leaving');
  setTimeout(() => { job.el.remove(); }, 260);
  const i = jobs.indexOf(job);
  if (i >= 0) jobs.splice(i, 1);
}

function setState(job, state, extra = {}) {
  Object.assign(job, extra, { state });
  view(job);
}

// L'écran en cours se met à jour tout seul si c'est une liste ou la fiche concernée (jamais un formulaire en cours de saisie)
function refreshCurrentView(job, res) {
  const h = location.hash.replace(/\?.*$/, '');
  const id = res?.spot?.id_spotting;
  const onList = h === '' || h === '#' || h === '#/' || h === '#/spots' || h === '#/map' || h === '#/stats' || h === '#/reports';
  const onThisSpot = id && h === `#/spots/${id}`;
  if (onList || onThisSpot) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

async function send(job, force = false) {
  const fd = new FormData();
  fd.append('data', JSON.stringify({ ...job.data, force }));
  if (job.imageFile) fd.append('image', job.imageFile, job.imageFile.name || 'photo.jpg');
  if (job.audioFile) fd.append('audio', job.audioFile, job.audioFile.name || 'audio.webm');
  return api(job.editing ? `/api/spots/${job.id}` : '/api/spots', {
    method: job.editing ? 'PUT' : 'POST', form: fd, query: { force },
    onProgress: (r, phase) => setState(job, phase === 'upload' ? 'sending' : 'processing', { pct: r }),
  });
}

async function runJob(job, force = false) {
  try {
    const res = await send(job, force);
    setState(job, 'done', { pct: 1 });
    try { await job.onDone?.(res); } catch { /* le succès ne dépend pas des notifications annexes */ }
    refreshCurrentView(job, res);
    setTimeout(() => remove(job), DONE_MS);
    job.el.style.cursor = 'pointer';
    job.el.onclick = () => { if (res?.spot?.id_spotting) location.hash = `#/spots/${res.spot.id_spotting}`; };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.detail?.code === 'duplicate') { setState(job, 'dup'); return; }
    if (e instanceof ApiError && e.offline && !job.editing) { await toDraft(job); return; }
    setState(job, 'error', { error: has(`err.${e.message}`) ? t(`err.${e.message}`) : '' });
  }
}

async function toDraft(job) {
  try {
    await saveDraft({ data: job.data, image: job.imageFile, audio: job.audioFile });
    setState(job, 'draft');
    window.dispatchEvent(new Event('contrail-local-action'));
    setTimeout(() => remove(job), 2600);
  } catch { setState(job, 'error'); }
}

function act(job, a) {
  if (a === 'cancel') remove(job);
  else if (a === 'draft') toDraft(job);
  else if (a === 'retry') { setState(job, 'queued'); pump(); }
  else if (a === 'force') { job.force = true; setState(job, 'queued'); pump(); }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    for (let job = jobs.find((j) => j.state === 'queued'); job; job = jobs.find((j) => j.state === 'queued')) {
      setState(job, 'sending', { pct: 0 });
      const force = !!job.force;
      job.force = false;
      await runJob(job, force);
    }
  } finally { busy = false; }
}

/** Met un enregistrement en file : { editing, id, data, imageFile, audioFile, label, onDone(res) } */
export function enqueueSave(opts) {
  const job = { id: opts.id, editing: !!opts.editing, data: opts.data, imageFile: opts.imageFile || null, audioFile: opts.audioFile || null,
    label: opts.label || t('spot.new'), onDone: opts.onDone, state: 'queued', pct: 0, key: ++seq, el: document.createElement('div') };
  ensureHost().append(job.el);
  jobs.push(job);
  view(job);
  pump();
  return job;
}

export const pendingUploads = () => jobs.some((j) => j.state === 'queued' || j.state === 'sending' || j.state === 'processing');

// Fermer l'onglet pendant un envoi perdrait la photo : le navigateur demande confirmation
window.addEventListener('beforeunload', (e) => { if (pendingUploads()) { e.preventDefault(); e.returnValue = ''; } });
