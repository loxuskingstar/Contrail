// Brouillons créés hors-ligne, en attente de synchronisation
import { t, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, toast, emptyState, pageHead, confirmDialog } from '../ui.js';
import { listDrafts, deleteDraft, syncDrafts } from '../offline.js';

export async function render(root) {
  const urls = [];
  const draw = async () => {
    const drafts = await listDrafts();
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.length = 0;
    root.innerHTML = `
      ${pageHead(esc(t('nav.drafts')), { sub: esc(t('drafts.sub')), actions: drafts.length ? `<button class="btn primary" data-sync ${navigator.onLine ? '' : 'disabled'}>${icon('cloud-upload', '', 18)} ${esc(t('drafts.sync'))}</button>` : '' })}
      ${drafts.length ? `<div class="list card" style="padding:6px">${drafts.map((d) => {
        let thumb = `<div class="thumb" style="display:grid;place-items:center">${icon('image')}</div>`;
        if (d.image) { const u = URL.createObjectURL(d.image); urls.push(u); thumb = `<img class="thumb" src="${u}" alt="">`; }
        return `<div class="list-row">${thumb}<div class="grow">
          <div class="ttl mono">${esc(d.data.registration || '?')}</div>
          <div class="meta">${esc(d.data.airport || '—')} · ${fmtDate(d.data.date)}${d.audio ? ` · ${icon('radio', '', 12)}` : ''}</div>
          ${d.error ? `<div class="tiny" style="color:var(--danger)">${esc(t(`err.${d.error}`) === `err.${d.error}` ? d.error : t(`err.${d.error}`))}</div>` : `<div class="tiny muted">${esc(t('drafts.waiting'))}</div>`}</div>
          <button class="btn-icon" data-del="${esc(d.uuid)}">${icon('trash-2', '', 18)}</button></div>`;
      }).join('')}</div>
      <p class="small muted" style="margin-top:12px">${esc(t('drafts.hint'))}</p>` : `<div class="card">${emptyState('cloud-upload', t('drafts.empty'), t('drafts.empty_text'))}</div>`}`;
    root.querySelector('[data-sync]')?.addEventListener('click', async () => {
      const r = await syncDrafts();
      toast(esc(t('drafts.synced', { n: r.synced })), { type: r.failed ? 'warn' : 'success' });
      draw();
    });
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(esc(t('drafts.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
      await deleteDraft(b.dataset.del); draw();
    }));
  };
  await draw();
  const on = () => draw();
  window.addEventListener('online', on);
  window.addEventListener('offline', on);
  return () => { urls.forEach((u) => URL.revokeObjectURL(u)); window.removeEventListener('online', on); window.removeEventListener('offline', on); };
}
