// Doublons de photos : paires de spots aux photos quasi identiques, à départager
import { api, mediaUrl } from '../api.js';
import { t, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, emptyState, errorToast, toast, confirmDialog, regText } from '../ui.js';

export async function render(root) {
  let data;
  try { data = await api('/api/spots/duplicates', { query: { limit: 200 } }); } catch (e) { errorToast(e); return; }
  const draw = () => {
    if (!data.pairs.length) { root.innerHTML = pageHead(esc(t('dups.title'))) + `<div class="card">${emptyState('copy', t('dups.none'), t('dups.none_text'))}</div>`; return; }
    const side = (x, other, key) => `<div class="stack" style="gap:8px;min-width:0">
      <a href="#/spots/${x.id}" style="display:block;aspect-ratio:3/2;border-radius:12px;overflow:hidden;background:var(--surface-2)">${x.thumb ? `<img src="${mediaUrl('thumbs', x.thumb)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : ''}</a>
      <div class="small"><b class="mono">${esc(regText(x.registration))}</b><div class="muted">${esc([x.date ? fmtDate(x.date, { time: false }) : '', x.airport].filter(Boolean).join(' · '))}</div></div>
      <button class="btn sm danger" data-del="${x.id}" data-key="${key}">${icon('trash-2', '', 14)} ${esc(t('dups.delete_this'))}</button></div>`;
    root.innerHTML = `${pageHead(esc(t('dups.title')), { sub: esc(t('dups.count', { n: data.count })) })}
      <p class="small muted" style="margin:-4px 0 12px">${esc(t('dups.hint'))}</p>
      <div class="stack" style="gap:12px">${data.pairs.map((p, i) => `<div class="card" data-pair="${i}">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${side(p.a, p.b, i)}${side(p.b, p.a, i)}</div>
        <div class="row between" style="margin-top:10px"><span class="tiny muted">${esc(t('storage.dup_distance', { n: p.distance }))}</span>
          <button class="btn sm" data-keep="${i}">${icon('check', '', 14)} ${esc(t('dups.keep_both'))}</button></div></div>`).join('')}</div>`;
    root.querySelectorAll('[data-keep]').forEach((b) => (b.onclick = async () => {
      const p = data.pairs[+b.dataset.keep];
      try { await api('/api/spots/duplicates/ignore', { method: 'POST', body: { a: p.a.id, b: p.b.id } }); data.pairs.splice(+b.dataset.keep, 1); data.count--; draw(); } catch (e) { errorToast(e); }
    }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(esc(t('dups.delete_confirm')), { danger: true, ok: t('common.delete') }))) return;
      try {
        await api(`/api/spots/${b.dataset.del}`, { method: 'DELETE' });
        toast(esc(t('common.deleted')), { type: 'success' });
        data = await api('/api/spots/duplicates', { query: { limit: 200 } }); draw();
      } catch (e) { errorToast(e); }
    }));
  };
  draw();
}
