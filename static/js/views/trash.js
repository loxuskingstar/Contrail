// Corbeille : spots et vols supprimés, récupérables
import { api, mediaUrl } from '../api.js';
import { t, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, confirmDialog, toast, errorToast } from '../ui.js';

export async function render(root) {
  async function load() {
    const res = await api('/api/trash');
    const left = (iso) => Math.max(0, Math.ceil(res.days - (Date.now() - new Date(iso).getTime()) / 86400000));
    root.innerHTML = `${pageHead(esc(t('trash.title')), { sub: esc(res.days ? t('trash.sub', { n: res.days }) : t('trash.off')),
      actions: res.count ? `<button class="btn danger" data-empty>${icon('trash-2', '', 18)} ${esc(t('trash.empty'))}</button>` : '' })}
      ${res.count ? `<div class="card" style="padding:6px">${res.items.map((i) => `<div class="list-row" data-id="${i.id}">
        ${i.thumb ? `<img class="thumb" loading="lazy" src="${mediaUrl('thumbs', i.thumb)}" alt="">` : `<div class="thumb" style="display:grid;place-items:center">${icon(i.kind === 'flight' ? 'ticket' : 'camera', '', 22)}</div>`}
        <div class="grow"><div class="ttl">${esc(i.label || '—')}</div>
          <div class="meta">${esc(t(`trash.kind_${i.kind}`))} · ${esc(t('trash.deleted_on', { d: fmtDate(i.deleted_at, { time: false }) }))}${res.days ? ` · ${esc(t('trash.days_left', { n: left(i.deleted_at) }))}` : ''}</div></div>
        <button class="btn sm" data-restore="${i.id}">${icon('rotate-ccw', '', 16)} ${esc(t('trash.restore'))}</button>
        <button class="btn-icon" data-purge="${i.id}" title="${esc(t('trash.purge'))}" aria-label="${esc(t('trash.purge'))}">${icon('x')}</button></div>`).join('')}</div>`
        : `<div class="card">${emptyState('trash-2', t('trash.empty_title'), t('trash.empty_text'))}</div>`}`;
    root.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
      try {
        const r = await api(`/api/trash/${b.dataset.restore}/restore`, { method: 'POST' });
        toast(`${esc(t('trash.restored'))} <a href="#/${r.kind === 'flight' ? 'flights' : 'spots'}/${r.id}">${esc(t('common.open'))}</a>`, { type: 'success' });
        load();
      } catch (e) { errorToast(e); }
    }));
    root.querySelectorAll('[data-purge]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(esc(t('trash.confirm_purge')), { danger: true, ok: t('trash.purge') }))) return;
      await api(`/api/trash/${b.dataset.purge}`, { method: 'DELETE' }).catch(errorToast); load();
    }));
    root.querySelector('[data-empty]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(esc(t('trash.confirm_empty', { n: res.count })), { danger: true, ok: t('trash.empty') }))) return;
      await api('/api/trash', { method: 'DELETE' }).catch(errorToast); load();
    });
  }
  await load();
}
