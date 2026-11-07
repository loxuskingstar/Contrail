// Matériel photo : boîtiers, objectifs et setups. Les noms détectés par l'EXIF apparaissent d'eux-mêmes ; on peut les renommer,
// les fusionner, ajouter à la main ce qui n'est pas détecté, et composer des setups (boîtier + objectif) à choisir en un geste.
import { api } from '../api.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, sheet, toast, errorToast, confirmDialog, promptDialog, emptyState, pageHead } from '../ui.js';

export async function render(root) {
  let g = await api('/api/gear');
  root.innerHTML = `${pageHead(esc(t('nav.gear')), { sub: esc(t('gear.sub')), actions: `<button class="btn" data-new-setup>${icon('layers', '', 18)} ${esc(t('gear.new_setup'))}</button><button class="btn primary" data-new>${icon('plus', '', 18)} ${esc(t('gear.add'))}</button>` })}
    <div data-body></div>`;
  const body = root.querySelector('[data-body]');
  const reload = async () => { g = await api('/api/gear'); draw(); };

  const row = (kind, it) => `<div class="row between gear-row" data-kind="${kind}" data-name="${esc(it.name)}" style="padding:10px 4px;border-bottom:1px solid var(--line);gap:10px">
      <div class="grow" style="min-width:0"><b>${esc(it.name)}</b>
        <div class="tiny muted">${esc([it.manual ? t('gear.manual') : t('gear.detected'), it.last && t('gear.last', { d: fmtDate(it.last, { time: false }) })].filter(Boolean).join(' · '))}</div></div>
      ${it.count ? `<a class="badge accent" href="#/spots?${kind}=${encodeURIComponent(it.name)}">${icon('camera', '', 12)} ${esc(fmtNum(it.count))}</a>` : `<span class="badge">0</span>`}
      <button class="btn-icon" data-edit title="${esc(t('common.edit'))}">${icon('pencil', '', 16)}</button>
      <button class="btn-icon" data-del title="${esc(t('common.delete'))}" ${it.count ? 'disabled' : ''}>${icon('trash-2', '', 16)}</button></div>`;
  const miss = (kind) => (g.missing?.[kind] ? `<a class="row between" style="padding:10px 4px;text-decoration:none;color:inherit" href="#/spots?${kind}=__none__">
      <span class="small">${icon('circle-help', '', 16)} ${esc(t(`gear.none_${kind}`))}</span><span class="badge gold">${esc(fmtNum(g.missing[kind]))}</span></a>` : '');
  const list = (kind, items, title) => `<div class="section"><h2>${esc(title)}</h2></div>
    <div class="card" style="padding:4px 14px 4px;margin-bottom:14px">${miss(kind)}${items.length ? items.map((i) => row(kind, i)).join('') : emptyState('aperture', t('gear.empty'), t('gear.empty_text'))}</div>`;

  function draw() {
    body.innerHTML = `<div class="section"><h2>${esc(t('gear.setups'))}</h2></div>
      ${g.setups.length ? `<div class="grid two" style="margin-bottom:14px">${g.setups.map((s) => `<div class="card" data-setup="${s.id}">
        <div class="row between"><b style="font-size:16px">${esc(s.name)}</b>
          <span class="row" style="gap:2px"><button class="btn-icon" data-sedit title="${esc(t('common.edit'))}">${icon('pencil', '', 16)}</button><button class="btn-icon" data-sdel title="${esc(t('common.delete'))}">${icon('trash-2', '', 16)}</button></span></div>
        <div class="small" style="margin-top:6px">${icon('camera', '', 14)} ${esc(s.camera || '—')}</div>
        <div class="small" style="margin-top:2px">${icon('aperture', '', 14)} ${esc(s.lens || '—')}</div>
        <div class="tiny muted" style="margin-top:8px">${esc(t('gear.setup_uses', { n: s.count }))}</div></div>`).join('')}</div>`
        : `<div class="card" style="margin-bottom:14px"><p class="small muted">${esc(t('gear.no_setup'))}</p></div>`}
      ${list('camera', g.cameras, t('gear.cameras'))}${list('lens', g.lenses, t('gear.lenses'))}`;
    body.querySelectorAll('.gear-row').forEach((r) => {
      const { kind, name } = r.dataset;
      r.querySelector('[data-edit]').onclick = async () => {
        const v = await promptDialog(t('gear.rename_label'), { value: name, title: t(kind === 'camera' ? 'gear.edit_camera' : 'gear.edit_lens') });
        if (v == null || !v.trim() || v.trim() === name) return;
        try { const res = await api('/api/gear/rename', { method: 'POST', body: { kind, old: name, new: v.trim() } }); toast(t('gear.renamed', { n: res.spots })); await reload(); } catch (e) { errorToast(e); }
      };
      r.querySelector('[data-del]').onclick = async () => {
        if (!await confirmDialog(t('gear.confirm_del', { name }), { danger: true, ok: t('common.delete') })) return;
        try { await api('/api/gear', { method: 'DELETE', query: { kind, name } }); await reload(); } catch (e) { errorToast(e); }
      };
    });
    body.querySelectorAll('[data-setup]').forEach((c) => {
      const s = g.setups.find((x) => x.id === Number(c.dataset.setup));
      c.querySelector('[data-sedit]').onclick = () => setupSheet(s);
      c.querySelector('[data-sdel]').onclick = async () => {
        if (!await confirmDialog(t('gear.confirm_del', { name: s.name }), { danger: true, ok: t('common.delete') })) return;
        try { await api(`/api/gear/setups/${s.id}`, { method: 'DELETE' }); await reload(); } catch (e) { errorToast(e); }
      };
    });
  }

  function addSheet() {
    const s = sheet({ title: esc(t('gear.add')), body: `<form class="stack">
      <label class="field"><span>${esc(t('gear.kind'))}</span><select name="kind"><option value="camera">${esc(t('exif.camera'))}</option><option value="lens">${esc(t('exif.lens'))}</option></select></label>
      <label class="field"><span>${esc(t('gear.name'))}</span><input name="name" required maxlength="120" placeholder="${esc(t('gear.name_ph'))}" autofocus></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('common.save'))}</button></div></form>` });
    s.body.querySelector('[data-close]').onclick = s.close;
    s.body.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try { await api('/api/gear', { method: 'POST', body: { kind: f.kind.value, name: f.name.value } }); s.close(); await reload(); } catch (err) { errorToast(err); }
    };
  }

  function setupSheet(cur) {
    const opts = (items, v) => `<option value=""></option>${items.map((i) => `<option value="${esc(i.name)}" ${i.name === v ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}`;
    const s = sheet({ title: esc(cur ? t('gear.edit_setup') : t('gear.new_setup')), body: `<form class="stack">
      <label class="field"><span>${esc(t('gear.setup_name'))}</span><input name="name" maxlength="120" value="${esc(cur?.name || '')}" placeholder="${esc(t('gear.setup_name_ph'))}"></label>
      <label class="field"><span>${esc(t('exif.camera'))}</span><select name="camera">${opts(g.cameras, cur?.camera)}</select></label>
      <label class="field"><span>${esc(t('exif.lens'))}</span><select name="lens">${opts(g.lenses, cur?.lens)}</select></label>
      <p class="tiny muted">${esc(t('gear.setup_hint'))}</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('common.save'))}</button></div></form>` });
    s.body.querySelector('[data-close]').onclick = s.close;
    s.body.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        await api(cur ? `/api/gear/setups/${cur.id}` : '/api/gear/setups', { method: cur ? 'PUT' : 'POST', body: { name: f.name.value, camera: f.camera.value, lens: f.lens.value } });
        s.close(); await reload();
      } catch (err) { errorToast(err); }
    };
  }

  root.querySelector('[data-new]').onclick = addSheet;
  root.querySelector('[data-new-setup]').onclick = () => setupSheet(null);
  draw();
}
