// Réglages : apparence, modules, spotting, intégrations, données (sauvegardes, import/export), étiquettes, à propos
import { api } from '../api.js';
import { store, rerenderShell, applyAppearance, switchSession, resetTestSession } from '../app.js';
import { t, LANGS, setLang, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput } from '../lib/fields.js';
import { esc, sheet, toast, errorToast, confirmDialog, pageHead, promptDialog, download } from '../ui.js';
import { WIDGETS } from './dashboard.js';

const SECTIONS = ['appearance', 'modules', 'spotting', 'integrations', 'data', 'tags', 'about'];
const ACCENTS = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#10b981', '#0ea5e9', '#64748b'];

export async function render(root, params) {
  const section = SECTIONS.includes(params.section) ? params.section : 'appearance';
  root.innerHTML = `${pageHead(esc(t('nav.settings')))}
    <div class="settings-nav chips">${SECTIONS.map((s) => `<a class="chip ${s === section ? 'on' : ''}" href="#/settings/${s}">${esc(t(`settings.s_${s}`))}</a>`).join('')}</div>
    <div data-body></div>`;
  const body = root.querySelector('[data-body]');
  const S = store.settings;
  const save = async (patch, { reload = false } = {}) => {
    try {
      await store.saveSettings(patch);
      localStorage.setItem('contrail.settings', JSON.stringify(store.settings));
      toast(esc(t('common.saved')), { type: 'success', duration: 1500 });
      if (reload) rerenderShell();
    } catch (e) { errorToast(e); }
  };
  const toggle = (key, label, desc, checked) => `<label class="toggle-row"><span><span class="t">${esc(label)}</span>${desc ? `<br><span class="d">${esc(desc)}</span>` : ''}</span><span class="switch"><input type="checkbox" data-k="${key}" ${checked ? 'checked' : ''}><span></span></span></label>`;

  if (section === 'appearance') {
    body.innerHTML = `<div class="stack">
      <div class="card stack">
        <div class="field"><span>${esc(t('settings.theme'))}</span><div class="seg">${['auto', 'light', 'dark'].map((v) => `<button data-theme="${v}" class="${S.theme === v ? 'on' : ''}">${icon(v === 'auto' ? 'monitor-smartphone' : v === 'light' ? 'sun' : 'moon', '', 16)} ${esc(t(`settings.theme_${v}`))}</button>`).join('')}</div></div>
        <div class="field"><span>${esc(t('settings.accent'))}</span><div class="color-swatches">${ACCENTS.map((c) => `<button data-accent="${c}" class="${S.accent === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}
          <input type="color" value="${esc(S.accent)}" data-custom title="${esc(t('settings.custom_color'))}"></div></div>
        <label class="field"><span>${esc(t('settings.language'))}</span><select data-lang>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${S.language === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>${esc(t('settings.units'))}</span><select data-units><option value="metric" ${S.units === 'metric' ? 'selected' : ''}>${esc(t('settings.metric'))}</option><option value="imperial" ${S.units === 'imperial' ? 'selected' : ''}>${esc(t('settings.imperial'))}</option></select></label>
      </div>
      <div class="card stack"><div class="card-title" style="margin-bottom:0">${esc(t('settings.map'))}</div>
        <label class="field"><span>${esc(t('settings.map_tiles'))}</span><select data-tiles>${['auto', 'positron', 'liberty', 'bright', 'dark', 'fiord', 'osm', 'custom'].map((v) => `<option value="${v}" ${(S.map_tiles || 'auto') === v ? 'selected' : ''}>${esc(t(`settings.tiles_${v}`))}</option>`).join('')}</select></label>
        <div class="stack" data-custom-tiles ${(S.map_tiles || 'auto') === 'custom' ? '' : 'hidden'}>
          <label class="field"><span>${esc(t('settings.tiles_url'))}</span><input data-tiles-url value="${esc(S.map_tiles_url || '')}" placeholder="https://tiles.openfreemap.org/styles/liberty" spellcheck="false"></label>
        </div>
        <p class="tiny muted">${esc(t('settings.map_hint'))}</p>
      </div>
      <div class="card"><div class="card-title">${esc(t('settings.dashboard'))}</div>
        <p class="small muted" style="margin-bottom:10px">${esc(t('settings.dashboard_hint'))}</p>
        <div class="chips">${WIDGETS.map((w) => `<span class="chip ${(S.dashboard_widgets || []).includes(w) ? 'on' : ''}">${esc(t(`widget.${w}`))}</span>`).join('')}</div>
        <a class="btn sm" style="margin-top:12px" href="#/">${icon('sliders-horizontal', '', 16)} ${esc(t('dash.customize'))}</a></div>
      <div class="card"><div class="card-title">${esc(t('settings.shortcuts'))}</div>
        <div class="small stack" style="gap:6px"><div><kbd>/</kbd> ${esc(t('settings.k_search'))}</div><div><kbd>N</kbd> ${esc(t('settings.k_new'))}</div><div><kbd>←</kbd> <kbd>→</kbd> ${esc(t('settings.k_nav'))}</div><div><kbd>E</kbd> ${esc(t('settings.k_edit'))}</div></div></div>
    </div>`;
    body.querySelectorAll('[data-theme]').forEach((b) => (b.onclick = () => { body.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('on', x === b)); save({ theme: b.dataset.theme }); }));
    body.querySelectorAll('[data-accent]').forEach((b) => (b.onclick = () => { body.querySelectorAll('[data-accent]').forEach((x) => x.classList.toggle('on', x === b)); save({ accent: b.dataset.accent }); }));
    body.querySelector('[data-custom]').oninput = (e) => { store.settings.accent = e.target.value; applyAppearance(); };
    body.querySelector('[data-custom]').onchange = (e) => save({ accent: e.target.value });
    body.querySelector('[data-lang]').onchange = async (e) => {
      await store.saveSettings({ language: e.target.value });
      localStorage.setItem('contrail.lang', e.target.value);
      await setLang(e.target.value);
      rerenderShell();
    };
    body.querySelector('[data-units]').onchange = (e) => save({ units: e.target.value });
    body.querySelector('[data-tiles]').onchange = (e) => {
      body.querySelector('[data-custom-tiles]').hidden = e.target.value !== 'custom';
      save({ map_tiles: e.target.value });
    };
    body.querySelector('[data-tiles-url]').onchange = (e) => save({ map_tiles_url: e.target.value.trim() });
  }

  if (section === 'modules') {
    const mods = ['flights', 'fleets', 'radar', 'weather', 'ocr', 'locations', 'watchlist', 'gamification'];
    body.innerHTML = `<div class="card"><p class="small muted" style="margin-bottom:6px">${esc(t('settings.modules_hint'))}</p>
      ${mods.map((m) => toggle(m, t(`module.${m}`), t(`module.${m}_d`), S.modules?.[m] !== false)).join('')}</div>`;
    body.querySelectorAll('[data-k]').forEach((c) => (c.onchange = () => save({ modules: { ...S.modules, [c.dataset.k]: c.checked } }, { reload: true })));
  }

  if (section === 'spotting') {
    body.innerHTML = `<div class="stack"><div class="card stack">
        <label class="field"><span>${esc(t('settings.default_airport'))}</span><div class="input-wrap"><input data-default value="${esc(S.default_airport)}" placeholder="LFBO"></div></label>
        <label class="field"><span>${esc(t('settings.home_airports'))}</span><input data-homes value="${esc((S.home_airports || []).join(', '))}" placeholder="LFBO, LFPG"><span class="tiny muted">${esc(t('settings.home_airports_hint'))}</span></label>
      </div>
      <div class="card stack"><div class="card-title">${esc(t('settings.images'))}</div>
        <div class="field-row">
          <label class="field"><span>${esc(t('settings.image_max'))}</span><select data-imgmax>${[1600, 2048, 2560, 3200, 4096].map((v) => `<option ${S.image_max_px === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('settings.image_quality'))}</span><select data-imgq>${[70, 78, 85, 90, 95].map((v) => `<option ${S.image_quality === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        ${toggle('keep_originals', t('settings.keep_originals'), t('settings.keep_originals_d'), S.keep_originals)}
        ${toggle('share_include_notes', t('settings.share_notes'), t('settings.share_notes_d'), S.share_include_notes)}
      </div>
      <div class="card stack"><div class="card-title">${esc(t('nav.watchlist'))}</div>
        <label class="field"><span>${esc(t('settings.watch_interval'))}</span><select data-watchint>${[2, 5, 10, 15, 30, 60].map((v) => `<option value="${v}" ${S.watch_interval_min === v ? 'selected' : ''}>${v} min</option>`).join('')}</select></label>
      </div></div>`;
    airportInput(body.querySelector('[data-default]'));
    body.querySelector('[data-default]').onchange = (e) => save({ default_airport: e.target.value.trim().toUpperCase() });
    body.querySelector('[data-homes]').onchange = (e) => save({ home_airports: e.target.value.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) });
    body.querySelector('[data-imgmax]').onchange = (e) => save({ image_max_px: Number(e.target.value) });
    body.querySelector('[data-imgq]').onchange = (e) => save({ image_quality: Number(e.target.value) });
    body.querySelector('[data-watchint]').onchange = (e) => save({ watch_interval_min: Number(e.target.value) });
    body.querySelectorAll('[data-k]').forEach((c) => (c.onchange = () => save({ [c.dataset.k]: c.checked })));
  }

  if (section === 'integrations') {
    const cfg = store.config = await api('/api/config');
    const field = (k, label, hint, type = 'text') => {
      const c = cfg[k];
      return `<label class="field"><span>${esc(label)} ${c.source === 'env' ? `<span class="badge">${esc(t('settings.from_env'))}</span>` : c.set ? `<span class="badge green">${esc(t('settings.configured'))}</span>` : ''}</span>
        <input data-cfg="${k}" type="${type}" value="${esc(c.value)}" ${c.source === 'env' ? 'disabled' : ''} autocomplete="off" spellcheck="false">${hint ? `<span class="tiny muted">${hint}</span>` : ''}</label>`;
    };
    body.innerHTML = `<div class="stack">
      <div class="card stack"><div class="card-title">${esc(t('settings.i_aircraft'))}</div>
        <p class="small muted">${esc(t('settings.i_aircraft_d'))}</p>
        ${field('airlabs_api_key', 'AirLabs API key', `<a href="https://airlabs.co/signup" target="_blank" rel="noopener">airlabs.co</a> — ${esc(t('settings.airlabs_hint'))}`)}
        ${field('aviationstack_api_key', 'Aviationstack API key', `<a href="https://aviationstack.com/signup/free" target="_blank" rel="noopener">aviationstack.com</a> — ${esc(t('settings.experimental'))}`)}
      </div>
      <div class="card stack" data-refdb><div class="card-title">${icon('database', '', 15)} ${esc(t('refdb.title'))}</div><div class="skeleton" style="height:80px"></div></div>
      <div class="card stack"><div class="card-title">OpenSky Network</div>
        <p class="small muted">${esc(t('settings.opensky_d'))}</p>
        ${field('opensky_client_id', 'Client ID', '')}${field('opensky_client_secret', 'Client secret', '', 'password')}
      </div>
      <div class="card stack"><div class="card-title">${esc(t('settings.i_notify'))}</div>
        <p class="small muted">${esc(t('settings.i_notify_d'))}</p>
        ${field('ntfy_url', 'ntfy', 'https://ntfy.sh/mon-sujet-secret')}${field('webhook_url', 'Webhook (POST JSON)', '')}
        ${field('public_base_url', t('settings.public_url'), esc(t('settings.public_url_hint')))}
        ${'Notification' in window ? `<div class="row"><span class="grow small">${esc(t('settings.browser_notif'))} : <b>${esc(t(`settings.perm_${Notification.permission}`))}</b></span>${Notification.permission === 'default' ? `<button class="btn sm" data-perm>${esc(t('notif.enable_system'))}</button>` : ''}</div>` : ''}
      </div>
      <div class="card small muted">${icon('info', '', 16)} ${esc(t('settings.ocr_status'))} : <b>${cfg.ocr_available ? esc(t('settings.ocr_ok')) : esc(t('settings.ocr_missing'))}</b></div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-savecfg>${esc(t('common.save'))}</button></div></div>`;
    body.querySelector('[data-savecfg]').onclick = async () => {
      const patch = {};
      body.querySelectorAll('[data-cfg]:not([disabled])').forEach((i) => (patch[i.dataset.cfg] = i.value));
      try { store.config = await api('/api/config', { method: 'PUT', body: patch }); toast(esc(t('common.saved')), { type: 'success' }); }
      catch (e) { errorToast(e); }
    };
    body.querySelector('[data-perm]')?.addEventListener('click', () => Notification.requestPermission().then(() => render(root, params)));
    refdbCard(body.querySelector('[data-refdb]'));
  }

  if (section === 'data') {
    const draw = async () => {
      const b = await api('/api/backups');
      const inTest = store.session.profile === 'test';
      body.innerHTML = `<div class="stack">
        <div class="card stack test-card"><div class="card-title" style="margin-bottom:0;justify-content:flex-start">${icon('triangle-alert', '', 15)} ${esc(t('test.title'))}</div>
          <p class="small muted">${esc(t(inTest ? 'test.desc_in' : 'test.desc'))}</p>
          <div class="row wrap">${inTest
            ? `<button class="btn primary" data-tquit>${icon('log-out', '', 18)} ${esc(t('test.quit'))}</button><button class="btn" data-treset>${icon('rotate-ccw', '', 18)} ${esc(t('test.reset'))}</button>`
            : `<button class="btn" data-tenter>${icon('wand-sparkles', '', 18)} ${esc(t('test.enter'))}</button>`}</div></div>
        <div class="card stack"><div class="card-title">${esc(t('settings.backups'))}</div>
          <p class="small muted">${esc(t('settings.backups_d'))}</p>
          <div class="field-row">
            <label class="field"><span>${esc(t('settings.backup_interval'))}</span><select data-int>${[[0, t('settings.off')], [6, '6 h'], [12, '12 h'], [24, t('settings.daily')], [168, t('settings.weekly')]].map(([v, l]) => `<option value="${v}" ${S.backup_interval_hours === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            <label class="field"><span>${esc(t('settings.backup_keep'))}</span><select data-keep>${[3, 7, 14, 30].map((v) => `<option ${S.backup_keep === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          </div>
          ${toggle('backup_include_media', t('settings.backup_media'), t('settings.backup_media_d'), S.backup_include_media)}
          <div class="row wrap"><button class="btn primary" data-now>${icon('archive', '', 18)} ${esc(t('settings.backup_now'))}</button>
            <button class="btn" data-now-full>${icon('images', '', 18)} ${esc(t('settings.backup_full'))}</button>
            <label class="btn">${icon('rotate-ccw', '', 18)} ${esc(t('settings.restore'))}<input type="file" accept=".zip" hidden data-restore></label></div>
          ${b.items.length ? `<table class="tbl"><tbody>${b.items.map((x) => `<tr><td><b class="small">${esc(fmtDate(x.created))}</b>${x.full ? ` <span class="badge">${esc(t('settings.with_media'))}</span>` : ''}</td>
            <td class="small muted num">${fmtNum(x.size / 1024 / 1024, { maximumFractionDigits: 1 })} Mo</td>
            <td style="text-align:right"><a class="btn-icon" href="/api/backups/${encodeURIComponent(x.name)}" download>${icon('download', '', 18)}</a><button class="btn-icon" data-delb="${esc(x.name)}">${icon('trash-2', '', 18)}</button></td></tr>`).join('')}</tbody></table>`
            : `<p class="small muted">${esc(t('settings.no_backup'))}</p>`}
        </div>
        <div class="card stack"><div class="card-title">${esc(t('settings.import'))}</div>
          <p class="small muted">${esc(t('settings.import_d'))}</p>
          <div class="row wrap"><button class="btn" data-imp="spots">${icon('camera', '', 18)} ${esc(t('settings.import_spots'))}</button>
          <button class="btn" data-imp="flights">${icon('ticket', '', 18)} ${esc(t('settings.import_flights'))}</button></div></div>
        <div class="card stack"><div class="card-title">${esc(t('settings.export'))}</div>
          <div class="row wrap"><a class="btn" href="/api/export/spots.csv">${icon('download', '', 18)} ${esc(t('settings.export_spots'))}</a>
          <a class="btn" href="/api/export/flights.csv">${icon('download', '', 18)} ${esc(t('settings.export_flights'))}</a>
          <a class="btn" href="/api/export/full.json">${icon('database', '', 18)} JSON</a></div>
          <p class="tiny muted">${esc(t('settings.export_d'))}</p></div>
        <div class="card"><a class="row" href="#/drafts">${icon('cloud-upload', '', 20)}<span class="grow">${esc(t('nav.drafts'))}</span>${icon('chevron-right')}</a></div>
      </div>`;
      body.querySelector('[data-tenter]')?.addEventListener('click', (e) => { e.currentTarget.disabled = true; switchSession('test'); });
      body.querySelector('[data-tquit]')?.addEventListener('click', () => switchSession('main'));
      body.querySelector('[data-treset]')?.addEventListener('click', resetTestSession);
      body.querySelector('[data-int]').onchange = (e) => save({ backup_interval_hours: Number(e.target.value) });
      body.querySelector('[data-keep]').onchange = (e) => save({ backup_keep: Number(e.target.value) });
      body.querySelectorAll('[data-k]').forEach((c) => (c.onchange = () => save({ [c.dataset.k]: c.checked })));
      const mk = async (full, btn) => {
        btn.disabled = true;
        try { const r = await api('/api/backups', { method: 'POST', query: { include_media: full } }); toast(esc(t('settings.backup_done')), { type: 'success' }); download(`/api/backups/${encodeURIComponent(r.name)}`, r.name); draw(); }
        catch (e) { errorToast(e); btn.disabled = false; }
      };
      body.querySelector('[data-now]').onclick = (e) => mk(false, e.currentTarget);
      body.querySelector('[data-now-full]').onclick = (e) => mk(true, e.currentTarget);
      body.querySelectorAll('[data-delb]').forEach((x) => (x.onclick = async () => { if (await confirmDialog(esc(t('settings.delete_backup')), { danger: true })) { await api(`/api/backups/${encodeURIComponent(x.dataset.delb)}`, { method: 'DELETE' }); draw(); } }));
      body.querySelector('[data-restore]').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f || !(await confirmDialog(esc(t('settings.restore_confirm')), { danger: true, ok: t('settings.restore') }))) return;
        const fd = new FormData(); fd.append('file', f);
        try { const r = await api('/api/backups/restore', { method: 'POST', form: fd }); toast(esc(t('settings.restored', { name: r.safety_backup })), { type: 'success', duration: 8000 }); setTimeout(() => location.reload(), 1500); }
        catch (err) { errorToast(err); }
      };
      body.querySelectorAll('[data-imp]').forEach((x) => (x.onclick = () => importWizard(x.dataset.imp)));
    };
    await draw();
  }

  if (section === 'tags') {
    const draw = async () => {
      const tags = await store.refreshTags();
      body.innerHTML = `<div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="small muted">${esc(t('tags.count', { n: tags.length }))}</span><button class="btn sm primary" data-new>${icon('plus', '', 16)} ${esc(t('tags.new'))}</button></div>
        <div class="list">${tags.map((tg) => `<div class="list-row"><input type="color" value="${esc(tg.color)}" data-color="${tg.id_tag}" style="width:32px;height:32px;border:0;background:none;padding:0">
          <a class="grow" href="#/spots?tag=${tg.id_tag}"><b>${esc(tg.name)}</b> <span class="muted small">· ${tg.count}</span></a>
          <button class="btn-icon" data-ren="${tg.id_tag}">${icon('pencil', '', 18)}</button><button class="btn-icon" data-del="${tg.id_tag}">${icon('trash-2', '', 18)}</button></div>`).join('') || `<p class="muted small">${esc(t('tags.empty'))}</p>`}</div></div>`;
      body.querySelector('[data-new]').onclick = async () => { const n = await promptDialog(t('tags.name')); if (n?.trim()) { await api('/api/tags', { method: 'POST', body: { name: n.trim(), color: ACCENTS[Math.floor(Math.random() * ACCENTS.length)] } }).catch(errorToast); draw(); } };
      body.querySelectorAll('[data-color]').forEach((i) => (i.onchange = async () => { const tg = tags.find((x) => x.id_tag === Number(i.dataset.color)); await api(`/api/tags/${tg.id_tag}`, { method: 'PUT', body: { name: tg.name, color: i.value } }); }));
      body.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = async () => { const tg = tags.find((x) => x.id_tag === Number(b.dataset.ren)); const n = await promptDialog(t('tags.name'), { value: tg.name }); if (n?.trim()) { await api(`/api/tags/${tg.id_tag}`, { method: 'PUT', body: { name: n.trim(), color: tg.color } }); draw(); } }));
      body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog(esc(t('tags.confirm_delete')), { danger: true })) { await api(`/api/tags/${b.dataset.del}`, { method: 'DELETE' }); draw(); } }));
    };
    await draw();
  }

  if (section === 'about') {
    const cfg = store.config || await api('/api/config').catch(() => ({}));
    body.innerHTML = `<div class="stack">
      <div class="card row" style="gap:16px"><span class="side-brand" style="padding:0"><span class="logo" style="width:54px;height:54px;border-radius:18px">${icon('plane', '', 28)}</span></span>
        <div><b style="font-size:20px">Contrail</b> <span class="muted">v${esc(cfg.version || '')}</span><div class="small muted">${esc(t('about.tagline'))}</div></div></div>
      <div class="card" style="border-color:#f59e0b66"><div class="card-title">${icon('triangle-alert', '', 16)} ${esc(t('about.maintenance_title'))}</div><p class="small">${esc(t('about.maintenance'))}</p></div>
      <div class="card small"><div class="card-title">${esc(t('about.credits'))}</div>
        <p>${esc(t('about.credits_text'))}</p>
        <p class="muted" style="margin-top:8px">OpenStreetMap · OpenFreeMap · OpenMapTiles · MapLibre GL JS · Lucide · Inter · JetBrains Mono · Fraunces · Caveat · Mictronics / tar1090-db · Planespotters.net · hexdb.io · AirLabs · Aviationstack · OpenSky Network · aviationweather.gov · Iowa Environmental Mesonet · airportsdata · Tesseract OCR</p></div>
      <div class="card"><a class="row" href="/api/docs" target="_blank" rel="noopener">${icon('file-text', '', 20)}<span class="grow">${esc(t('about.api_docs'))}</span>${icon('external-link', '', 18)}</a></div>
      <div class="card"><button class="btn danger" data-logout>${icon('log-out', '', 18)} ${esc(t('auth.logout'))}</button></div>
    </div>`;
    body.querySelector('[data-logout]').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
  }
}

// ------------------------------------------------------------------ assistant d'import CSV
function importWizard(kind) {
  const s = sheet({ title: esc(t(kind === 'spots' ? 'settings.import_spots' : 'settings.import_flights')), wide: true, body: `
    <div class="stack"><p class="small muted">${esc(t(kind === 'spots' ? 'import.hint_spots' : 'import.hint_flights'))}</p>
    <label class="dropzone" style="min-height:140px"><div class="dz-in">${icon('upload', '', 34)}<b>${esc(t('import.choose'))}</b><span class="small muted">.csv</span></div><input type="file" accept=".csv,text/csv" hidden data-file></label></div>` });
  s.body.querySelector('[data-file]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('kind', kind);
    try {
      const p = await api('/api/import/preview', { method: 'POST', form: fd });
      const fieldSel = (field) => `<select data-map="${field}"><option value="">—</option>${p.headers.map((h) => `<option ${p.mapping[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
      s.body.innerHTML = `<div class="stack">
        <p><b>${esc(t('import.rows', { n: p.rows }))}</b> · ${esc(f.name)}</p>
        <div class="card"><div class="card-title">${esc(t('import.mapping'))}</div><div class="field-row">${p.fields.map((fl) => `<label class="field"><span>${esc(t(`import.f_${fl}`))}</span>${fieldSel(fl)}</label>`).join('')}</div></div>
        <div class="card" style="padding:4px 14px">
          <label class="toggle-row"><span class="t">${esc(t('import.dayfirst'))}</span><span class="switch"><input type="checkbox" data-dayfirst checked><span></span></span></label>
          ${kind === 'spots' ? `<label class="toggle-row"><span class="t">${esc(t('import.skip_dup'))}</span><span class="switch"><input type="checkbox" data-skip checked><span></span></span></label>
          <label class="toggle-row"><span><span class="t">${esc(t('import.enrich'))}</span><br><span class="d">${esc(t('import.enrich_d'))}</span></span><span class="switch"><input type="checkbox" data-enrich><span></span></span></label>
          <label class="field" style="padding:10px 0"><span>${esc(t('import.default_airport'))}</span><input data-defap placeholder="LFBO"></label>` : ''}
        </div>
        <details class="card fold"><summary>${esc(t('import.preview'))} ${icon('chevron-down', 'chev', 18)}</summary><div class="fold-body scroll-x"><table class="tbl"><thead><tr>${p.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${p.sample.map((r) => `<tr>${p.headers.map((h) => `<td class="small">${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
        <div class="row" style="justify-content:flex-end"><button class="btn primary" data-go>${icon('upload', '', 18)} ${esc(t('common.import'))}</button></div></div>`;
      s.body.querySelector('[data-go]').onclick = async (ev) => {
        ev.currentTarget.disabled = true;
        const mapping = {};
        s.body.querySelectorAll('[data-map]').forEach((x) => x.value && (mapping[x.dataset.map] = x.value));
        const fd2 = new FormData();
        fd2.append('token', p.token); fd2.append('kind', kind); fd2.append('mapping', JSON.stringify(mapping));
        fd2.append('dayfirst', s.body.querySelector('[data-dayfirst]').checked);
        if (kind === 'spots') {
          fd2.append('skip_duplicates', s.body.querySelector('[data-skip]').checked);
          fd2.append('enrich', s.body.querySelector('[data-enrich]').checked);
          fd2.append('default_airport', s.body.querySelector('[data-defap]').value.trim());
        }
        try {
          const r = await api('/api/import/commit', { method: 'POST', form: fd2 });
          s.body.innerHTML = `<div class="empty">${icon('circle-check', '', 44)}<h3>${esc(t('import.done', { n: r.imported }))}</h3>
            <p>${esc(t('import.summary', { s: r.skipped, e: r.error_count }))}</p>
            ${r.errors.length ? `<div class="metar-raw" style="text-align:left;max-height:160px;overflow:auto">${r.errors.map((x) => `L${x.line}: ${esc(x.error)}`).join('\n')}</div>` : ''}
            <a class="btn primary" href="${kind === 'spots' ? '#/spots' : '#/flights'}" data-close>${esc(t('common.open'))}</a></div>`;
          s.body.querySelector('[data-close]').onclick = s.close;
          store.facets = null;
        } catch (err) { errorToast(err); }
      };
    } catch (err) { errorToast(err); }
  };
}


// ------------------------------------------------------------------ base de référence des appareils
async function refdbCard(box) {
  let timer = null;
  const draw = async () => {
    if (!box.isConnected) { clearTimeout(timer); return; }
    const st = await api('/api/refdb').catch(() => null);
    if (!st) return;
    const phase = st.running ? t(`refdb.phase_${st.phase || 'import'}`) + (st.rows ? ` · ${fmtNum(st.rows)}` : '') : '';
    box.innerHTML = `<div class="card-title">${icon('database', '', 15)} ${esc(t('refdb.title'))}</div>
      <p class="small muted">${esc(t('refdb.desc'))}</p>
      <div class="row wrap small">${st.available
        ? `<span class="badge green">${icon('circle-check', '', 12)} ${esc(t('refdb.count', { n: fmtNum(st.count || 0) }))}</span><span class="muted">${esc(t('refdb.imported', { date: fmtDate(st.imported_at, { time: false }), src: st.source || '' }))}</span>`
        : `<span class="badge">${esc(t('refdb.none'))}</span>`}</div>
      ${st.running ? `<div class="row small">${icon('refresh-cw', '', 15)} ${esc(phase)}</div><div class="progress"><i style="width:${st.phase === 'download' ? 35 : 75}%"></i></div>` : ''}
      ${st.error ? `<p class="small" style="color:var(--danger)">${esc(t(`err.${st.error}`) === `err.${st.error}` ? st.error : t(`err.${st.error}`))}</p>` : ''}
      <div class="row wrap">
        <button class="btn ${st.available ? '' : 'primary'}" data-dl ${st.running ? 'disabled' : ''}>${icon('download', '', 18)} ${esc(t(st.available ? 'refdb.update' : 'refdb.download'))}</button>
        <label class="btn ${st.running ? 'disabled' : ''}">${icon('upload', '', 18)} ${esc(t('refdb.upload'))}<input type="file" accept=".csv,.gz,text/csv,application/gzip" hidden data-up></label>
        ${st.available && !st.running ? `<button class="btn ghost danger" data-del>${icon('trash-2', '', 18)}</button>` : ''}</div>
      <p class="tiny muted">${esc(t('refdb.credits'))}</p>`;
    box.querySelector('[data-dl]').onclick = async () => { await api('/api/refdb/download', { method: 'POST' }).catch(errorToast); draw(); };
    box.querySelector('[data-up]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData(); fd.append('file', f);
      await api('/api/refdb/upload', { method: 'POST', form: fd }).catch(errorToast);
      draw();
    };
    box.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (await confirmDialog(esc(t('refdb.delete_confirm')), { danger: true })) { await api('/api/refdb', { method: 'DELETE' }); draw(); }
    });
    clearTimeout(timer);
    if (st.running) timer = setTimeout(draw, 1500);
  };
  draw();
}
