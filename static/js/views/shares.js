// Partage public : liens sécurisés révocables
import { api } from '../api.js';
import { store } from '../app.js';
import { t, fmtDate, fmtRelative } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast, copyText, emptyState, pageHead, confirmDialog } from '../ui.js';

export function shareUrl(token) {
  const base = (store.config?.public_base_url?.value || '').replace(/\/$/, '') || location.origin;
  return `${base}/s/${token}`;
}

function targetLabel(s) {
  if (s.kind === 'flights') return t('share.k_flights');
  if (!s.target) return t(`share.k_${s.kind}`);
  return `${t(`share.k_${s.kind}`)} · ${s.target}`;
}

export function createShareFlow({ kind, target = null, title = '' }) {
  const s = sheet({ title: esc(t('share.create')), body: `
    <form class="stack">
      <p class="small muted">${esc(t('share.what', { what: targetLabel({ kind, target }) }))}</p>
      <label class="field"><span>${esc(t('share.title_label'))}</span><input name="title" value="${esc(title)}" placeholder="${esc(t('share.title_ph'))}"></label>
      <label class="field"><span>${esc(t('share.expires'))}</span><select name="exp">
        <option value="">${esc(t('share.never'))}</option><option value="1">${esc(t('share.days', { n: 1 }))}</option><option value="7">${esc(t('share.days', { n: 7 }))}</option>
        <option value="30" selected>${esc(t('share.days', { n: 30 }))}</option><option value="365">${esc(t('share.days', { n: 365 }))}</option></select></label>
      <p class="tiny muted">${esc(t('share.privacy'))}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary">${icon('link', '', 18)} ${esc(t('share.generate'))}</button></div>
    </form>` });
  s.body.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const sh = await api('/api/shares', { method: 'POST', body: { kind, target, title: f.title.value || null, expires_days: f.exp.value ? Number(f.exp.value) : null } });
      const url = shareUrl(sh.token);
      s.body.innerHTML = `<div class="stack"><p>${esc(t('share.ready'))}</p>
        <div class="row"><input class="input mono grow" readonly value="${esc(url)}"><button class="btn-icon glassy" data-copy>${icon('copy')}</button></div>
        <div class="row" style="justify-content:flex-end">${navigator.share ? `<button class="btn" data-native>${icon('share-2', '', 18)} ${esc(t('share.native'))}</button>` : ''}
        <a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">${icon('external-link', '', 18)} ${esc(t('common.open'))}</a></div></div>`;
      s.body.querySelector('[data-copy]').onclick = () => copyText(url).then(() => toast(esc(t('common.copied')), { type: 'success' }));
      s.body.querySelector('[data-native]')?.addEventListener('click', () => navigator.share({ title: sh.title || 'Contrail', url }).catch(() => {}));
      copyText(url).then((ok) => ok && toast(esc(t('common.copied')), { type: 'success' }));
    } catch (err) { errorToast(err); }
  };
}

export async function render(root) {
  if (!store.config) store.config = await api('/api/config').catch(() => ({}));
  const load = async () => {
    const list = await api('/api/shares');
    root.querySelector('[data-list]').innerHTML = list.length ? `<div class="list card" style="padding:6px">${list.map((s) => {
      const expired = s.expires_at && new Date(s.expires_at) < new Date();
      return `<div class="list-row" style="${s.revoked || expired ? 'opacity:.5' : ''}">${icon(s.kind === 'flights' || s.kind === 'flight' ? 'ticket' : s.kind === 'airframe' ? 'plane' : 'images', '', 22)}
        <div class="grow"><b>${esc(s.title || targetLabel(s))}</b>
          <div class="meta">${esc(targetLabel(s))} · ${esc(t('share.views', { n: s.views }))} · ${fmtRelative(s.created_at)}</div>
          <div class="tiny muted">${s.revoked ? esc(t('share.revoked')) : expired ? esc(t('share.expired')) : s.expires_at ? esc(t('share.expires_on', { date: fmtDate(s.expires_at, { time: false }) })) : esc(t('share.never'))}</div></div>
        ${!s.revoked && !expired ? `<button class="btn-icon" data-copy="${s.token}" title="${esc(t('common.copy'))}">${icon('copy', '', 18)}</button>
          <a class="btn-icon" href="/s/${s.token}" target="_blank" rel="noopener">${icon('external-link', '', 18)}</a>
          <button class="btn-icon" data-revoke="${s.token}" title="${esc(t('share.revoke'))}" style="color:var(--danger)">${icon('x', '', 18)}</button>`
          : `<button class="btn-icon" data-purge="${s.token}">${icon('trash-2', '', 18)}</button>`}</div>`;
    }).join('')}</div>` : `<div class="card">${emptyState('share-2', t('share.empty'), t('share.empty_text'))}</div>`;
    root.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copyText(shareUrl(b.dataset.copy)).then(() => toast(esc(t('common.copied')), { type: 'success' }))));
    root.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(esc(t('share.revoke_confirm')), { danger: true, ok: t('share.revoke') }))) return;
      await api(`/api/shares/${b.dataset.revoke}`, { method: 'DELETE' }).catch(errorToast); load();
    }));
    root.querySelectorAll('[data-purge]').forEach((b) => (b.onclick = async () => { await api(`/api/shares/${b.dataset.purge}/purge`, { method: 'DELETE' }); load(); }));
  };
  root.innerHTML = `
    ${pageHead(esc(t('nav.shares')), { sub: esc(t('share.sub')), actions: `<button class="btn" data-new-g>${icon('images', '', 18)} ${esc(t('share.k_gallery'))}</button>${store.mod('flights') ? `<button class="btn" data-new-f>${icon('ticket', '', 18)} ${esc(t('share.k_flights'))}</button>` : ''}` })}
    <div data-list></div>
    <p class="tiny muted" style="margin-top:14px">${esc(t('share.base_hint'))}</p>`;
  root.querySelector('[data-new-g]').onclick = () => createShareFlow({ kind: 'gallery', target: 'all' });
  root.querySelector('[data-new-f]')?.addEventListener('click', () => createShareFlow({ kind: 'flights' }));
  await load();
}
