// Watchlist : immatriculations suivies, alertes quand l'appareil est détecté en vol
import { api, mediaUrl } from '../api.js';
import { store } from '../app.js';
import { t, fmtRelative, fmtNum, flag } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, toast, errorToast, emptyState, pageHead, confirmDialog } from '../ui.js';

export async function render(root) {
  let items = await api('/api/watchlist');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  root.innerHTML = `
    ${pageHead(esc(t('nav.watchlist')), { sub: esc(t('watch.sub')), actions: `<button class="btn" data-check>${icon('refresh-cw', '', 18)} ${esc(t('watch.check_now'))}</button>` })}
    <form class="card row" data-add style="margin-bottom:14px">
      <input class="input mono grow" name="reg" placeholder="F-HBXA" autocapitalize="characters" required style="text-transform:uppercase">
      <input class="input hide-sm" name="note" placeholder="${esc(t('watch.note'))}" style="max-width:260px">
      <button class="btn primary">${icon('plus', '', 18)} ${esc(t('watch.add'))}</button>
    </form>
    ${perm === 'default' ? `<div class="ocr-strip" style="margin-bottom:14px">${icon('bell', '', 18)}<span class="grow small">${esc(t('watch.perm_hint'))}</span><button class="btn sm" data-perm>${esc(t('notif.enable_system'))}</button></div>` : ''}
    <div data-list></div>
    <p class="tiny muted" style="margin-top:16px">${esc(t('watch.about', { n: store.settings.watch_interval_min || 5 }))}</p>`;

  const draw = () => {
    root.querySelector('[data-list]').innerHTML = items.length ? `<div class="list card" style="padding:6px">${items.map((w) => {
      const st = w.last_status || {};
      const status = w.airborne
        ? `<span class="badge green">${icon('plane-takeoff', '', 12)} ${esc(t('watch.airborne'))}</span> <span class="small">${esc([st.callsign, st.route || (st.dep ? `${st.dep}-${st.arr}` : ''), st.alt_m != null ? `${fmtNum(Math.round(st.alt_m * 3.28084 / 100) * 100)} ft` : ''].filter(Boolean).join(' · '))}</span>`
        : `<span class="small muted">${w.last_seen_at ? esc(t('watch.seen', { when: fmtRelative(w.last_seen_at) })) : esc(t('watch.not_seen'))}</span>`;
      return `<div class="list-row">
        ${w.thumb ? `<img class="thumb" src="${mediaUrl('thumbs', w.thumb)}" alt="">` : `<div class="thumb" style="display:grid;place-items:center">${icon('eye')}</div>`}
        <a class="grow" href="#/airframe/${encodeURIComponent(w.registration)}">
          <div class="ttl"><span class="mono">${esc(w.registration)}</span> ${flag(w.country)} ${w.spotted ? `<span class="badge accent">${icon('camera', '', 11)} ${w.spotted}</span>` : `<span class="badge">${esc(t('watch.never_spotted'))}</span>`}</div>
          <div class="meta ellipsis">${esc([w.aircraft, w.owner, w.note].filter(Boolean).join(' · ') || (w.icao24 ? `Mode-S ${w.icao24.toUpperCase()}` : t('watch.resolving')))}</div>
          <div>${status}</div></a>
        <label class="switch" title="${esc(t('watch.notify'))}"><input type="checkbox" data-notify="${w.id}" ${w.notify ? 'checked' : ''}><span></span></label>
        <button class="btn-icon" data-del="${w.id}">${icon('trash-2', '', 18)}</button></div>`;
    }).join('')}</div>` : `<div class="card">${emptyState('eye', t('watch.empty'), t('watch.empty_text'))}</div>`;
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(esc(t('watch.confirm_remove')), { danger: true }))) return;
      await api(`/api/watchlist/${b.dataset.del}`, { method: 'DELETE' });
      items = items.filter((x) => x.id !== Number(b.dataset.del)); draw();
    }));
    root.querySelectorAll('[data-notify]').forEach((c) => (c.onchange = async () => {
      const w = items.find((x) => x.id === Number(c.dataset.notify));
      await api(`/api/watchlist/${w.id}`, { method: 'PUT', body: { registration: w.registration, note: w.note, notify: c.checked } });
    }));
  };

  root.querySelector('[data-add]').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/watchlist', { method: 'POST', body: { registration: f.reg.value, note: f.note.value || null } });
      f.reset();
      items = await api('/api/watchlist'); draw();
      toast(esc(t('watch.added')), { type: 'success' });
    } catch (err) { errorToast(err); }
  };
  root.querySelector('[data-check]').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { const r = await api('/api/watchlist/check', { method: 'POST' }); items = r.items; draw(); toast(esc(t('watch.checked', { n: r.alerts })), { type: 'success' }); }
    catch (err) { errorToast(err); } finally { b.disabled = false; }
  };
  root.querySelector('[data-perm]')?.addEventListener('click', (e) => Notification.requestPermission().then(() => e.target.closest('.ocr-strip').remove()));
  draw();
}
