// Livrées : une carte par livrée (un texte de livrée chez un exploitant), rangées dans des catégories que l'on crée,
// renomme, réordonne ; en mode « Organiser », les livrées se glissent d'une catégorie à l'autre (souris ou doigt).
import { api, mediaUrl } from '../api.js';
import { t, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, spotTile, emptyState, pageHead, sheet, menu, toast, errorToast, confirmDialog, regFlag } from '../ui.js';
import { catName, setLiveryCats } from '../lib/livery-cats.js';

const PLAIN = ['primer', 'white'];
const ICON_CHOICES = ['palette', 'sparkles', 'history', 'users', 'flag', 'heart', 'star', 'crown', 'gem', 'trophy', 'medal', 'award',
  'flame', 'zap', 'shield', 'plane', 'rocket', 'globe', 'camera', 'film', 'music', 'gamepad-2', 'party-popper', 'cake', 'rainbow',
  'leaf', 'snowflake', 'sun', 'moon', 'anchor', 'swords', 'ribbon', 'handshake', 'car', 'tag', 'target', 'swatch-book', 'wand-sparkles', 'paint-bucket'];
const SORTS = ['custom', 'recent', 'alpha', 'count'];
const LS = 'contrail.liveries';

function prefs() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* stockage indisponible */ } }

export async function render(root) {
  let data = await api('/api/liveries');
  let cats = data.categories;
  setLiveryCats(cats);
  const p = prefs();
  let active = cats.some((c) => c.code === p.active) ? p.active : '';
  let sort = SORTS.includes(p.sort) ? p.sort : 'custom';
  let editing = false;

  const reload = async () => {
    data = await api('/api/liveries');
    cats = data.categories;
    setLiveryCats(cats);
    if (active && !cats.some((c) => c.code === active)) active = '';
    draw();
  };

  const sorted = (groups) => {
    const g = [...groups];
    if (editing || sort === 'custom') return g;
    if (sort === 'recent') return g.sort((a, b) => (b.last || '').localeCompare(a.last || ''));
    if (sort === 'alpha') return g.sort((a, b) => a.livery.localeCompare(b.livery, undefined, { sensitivity: 'base' }));
    return g.sort((a, b) => b.n - a.n || (b.last || '').localeCompare(a.last || ''));
  };

  const card = (g) => {
    const c = g.cover || {};
    const regs = g.regs.slice(0, 2).join(', ') + (g.regs.length > 2 ? ` +${g.regs.length - 2}` : '');
    return `<div class="lv-card ${c.thumb ? '' : 'noimg'}" data-key="${esc(g.key)}" tabindex="0" role="button" aria-label="${esc(g.livery)}">
      ${c.thumb ? `<img loading="lazy" src="${mediaUrl('thumbs', c.thumb)}" alt="" draggable="false">` : `<span class="lv-ph">${icon('palette', '', 22)}</span>`}
      <div class="corner">${g.regs.length > 1 ? `<span class="badge" title="${esc(t('livery.unique', { n: g.regs.length }))}">${icon('users', '', 11)} ${g.regs.length}</span>` : ''}
        ${g.manual ? `<span class="badge" title="${esc(t('livery.manual'))}">${icon('pin', '', 11)}</span>` : ''}</div>
      <div class="cap"><b>${esc(g.livery)}</b><small class="ellipsis"><span class="mono">${esc(regs)}</span> ${regFlag(g.country)}${g.owner ? ' · ' + esc(g.owner) : ''}</small></div>
      ${editing ? `<button class="lv-grip" type="button" aria-label="${esc(t('livery.drag'))}">${icon('grip-vertical', '', 16)}</button>
        <button class="lv-move" type="button" aria-label="${esc(t('livery.move_to'))}">${icon('arrow-left-right', '', 15)}</button>` : ''}
    </div>`;
  };

  const head = (c, i, list) => `<div class="section lv-head" data-cat-head="${c.code}">
      <h2>${icon(c.icon, '', 20)} ${esc(catName(c))}</h2>
      <span class="row" style="gap:4px">
        <span class="muted small">${esc(t('livery.n_liveries', { n: c.liveries }))}${c.unique ? ' · ' + esc(t('livery.unique', { n: c.unique })) : ''}</span>
        ${editing ? `${!c.plain ? `<button class="btn-icon sm" data-up="${c.code}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('livery.up'))}">${icon('arrow-up', '', 16)}</button>
          <button class="btn-icon sm" data-down="${c.code}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="${esc(t('livery.down'))}">${icon('arrow-down', '', 16)}</button>` : ''}
          <button class="btn-icon sm" data-edit="${c.code}" aria-label="${esc(t('livery.edit_cat'))}">${icon('pencil', '', 16)}</button>` : ''}
      </span></div>`;

  const draw = () => {
    const specials = cats.filter((c) => !c.plain), plain = cats.filter((c) => c.plain);
    const totalObs = specials.reduce((s, c) => s + c.count, 0), totalLiv = specials.reduce((s, c) => s + c.liveries, 0);
    const visible = (c) => editing || c.liveries > 0;
    const chip = (c) => `<button class="chip ${active === c.code ? 'on' : ''}" data-c="${c.code}">${icon(c.icon, '', 14)} ${esc(catName(c))} · ${c.liveries}</button>`;
    const shown = cats.filter((c) => (active ? c.code === active : (editing || !c.plain)) && (visible(c) || active === c.code));
    const anyLivery = cats.some((c) => c.liveries);
    root.innerHTML = `
      ${pageHead(esc(t('nav.liveries')), {
        sub: esc(`${t('livery.n_liveries', { n: totalLiv })} · ${t('livery.sub', { n: totalObs })}`),
        actions: editing
          ? `<button class="btn" data-new>${icon('folder-plus', '', 18)} <span class="hide-sm">${esc(t('livery.new_cat'))}</span></button>
             <button class="btn primary" data-edit-mode>${icon('check', '', 18)} ${esc(t('livery.done'))}</button>`
          : `${anyLivery ? `<button class="btn" data-edit-mode>${icon('arrow-up-down', '', 18)} ${esc(t('livery.organize'))}</button>` : ''}
             <button class="btn-icon" data-more aria-label="${esc(t('common.more'))}">${icon('ellipsis', '', 20)}</button>`,
      })}
      ${anyLivery || editing ? `
        <div class="lv-bar ${editing ? 'sticky' : ''}">
          <div class="chips scroll">
            <button class="chip ${!active ? 'on' : ''}" data-c="">${esc(t('common.all'))} · ${totalLiv}</button>
            ${specials.filter(visible).map(chip).join('')}
            ${plain.filter(visible).length ? '<span class="chip-sep"></span>' : ''}${plain.filter(visible).map(chip).join('')}
          </div>
          ${!editing ? `<div class="seg lv-sort hide-sm">${SORTS.map((s) => `<button data-sort="${s}" class="${sort === s ? 'on' : ''}">${esc(t(`livery.sort_${s}`))}</button>`).join('')}</div>` : ''}
        </div>
        ${editing ? `<p class="small muted lv-hint">${icon('info', '', 15)} ${esc(t('livery.edit_hint'))}</p>` : ''}
        ${shown.map((c, i, list) => `
          <section class="lv-sec" data-cat="${c.code}">
            ${head(c, specials.indexOf(c) >= 0 ? specials.indexOf(c) : i, c.plain ? plain : specials)}
            ${c.plain ? `<p class="small muted" style="margin:-4px 0 12px">${esc(t(`livery.${c.code}_hint`))}</p>` : ''}
            <div class="lv-gallery ${editing ? 'editing' : ''}" data-cat="${c.code}">${sorted(c.groups).map(card).join('')}
              ${!c.groups.length ? `<div class="lv-empty">${icon(editing ? 'move' : 'palette', '', 18)} ${esc(t(editing ? 'livery.drop_here' : 'livery.empty_cat'))}</div>` : ''}</div>
          </section>`).join('')}`
        : `<div class="card">${emptyState('palette', t('livery.empty'), t('livery.empty_text'))}</div>`}`;
    bind();
  };

  const bind = () => {
    root.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
      if (b.dataset.dropped) { delete b.dataset.dropped; return; }
      active = b.dataset.c; savePrefs({ ...prefs(), active }); draw();
    }));
    root.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { sort = b.dataset.sort; savePrefs({ ...prefs(), sort }); draw(); }));
    root.querySelectorAll('[data-edit-mode]').forEach((b) => (b.onclick = () => { editing = !editing; draw(); }));
    root.querySelector('[data-new]')?.addEventListener('click', () => editCategory(null));
    root.querySelector('[data-more]')?.addEventListener('click', (e) => moreMenu(e.currentTarget));
    root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editCategory(cats.find((c) => c.code === b.dataset.edit))));
    root.querySelectorAll('[data-up], [data-down]').forEach((b) => (b.onclick = () => moveCategory(b.dataset.up || b.dataset.down, b.dataset.up ? -1 : 1)));
    root.querySelectorAll('.lv-card').forEach((c) => {
      const key = c.dataset.key;
      c.onclick = (e) => {
        if (e.target.closest('.lv-grip')) return;
        if (e.target.closest('.lv-move')) { e.stopPropagation(); moveMenu(e.target.closest('.lv-move'), key); return; }
        if (c.dataset.dragged) { delete c.dataset.dragged; return; }
        openGroup(key);
      };
      c.onkeydown = (e) => { if (e.key === 'Enter') openGroup(key); };
    });
    if (editing) enableDrag(); else { dragCleanup?.(); dragCleanup = null; }
  };

  // ------------------------------------------------------------ catégories
  const moreMenu = async (anchor) => {
    const all = await api('/api/livery-categories?all=1').catch(() => []);
    const removed = all.filter((c) => c.disabled);
    menu(anchor, [
      { icon: 'folder-plus', label: t('livery.new_cat'), onClick: () => editCategory(null) },
      ...SORTS.map((s) => ({ icon: sort === s ? 'check' : 'arrow-up-down', label: t(`livery.sort_${s}`), onClick: () => { sort = s; savePrefs({ ...prefs(), sort }); draw(); } })),
      '-',
      ...removed.map((c) => ({ icon: 'rotate-ccw', label: `${t('livery.restore')} « ${catName(c)} »`,
        onClick: async () => { await api(`/api/livery-categories/${c.code}/restore`, { method: 'POST' }).catch(errorToast); reload(); } })),
      { icon: 'rotate-ccw', label: t('livery.reset_order'), onClick: async () => {
        if (!(await confirmDialog(esc(t('livery.reset_confirm'))))) return;
        await api('/api/liveries/reset', { method: 'POST' }).catch(errorToast);
        reload();
      } },
    ]);
  };

  const moveCategory = async (code, dir) => {
    const list = cats.filter((c) => !c.plain).map((c) => c.code);
    const i = list.indexOf(code), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const byCode = Object.fromEntries(cats.map((c) => [c.code, c]));
    cats = [...list.map((c) => byCode[c]), ...cats.filter((c) => c.plain)];
    draw();
    root.querySelector(`[data-cat-head="${code}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    try { await api('/api/livery-categories/reorder', { method: 'POST', body: { codes: list } }); } catch (e) { errorToast(e); reload(); }
  };

  const editCategory = (c) => {
    let ic = c?.icon || 'palette';
    const def = c?.builtin ? t(`livery.${c.code}`) : '';
    const s = sheet({ title: esc(c ? t('livery.edit_cat') : t('livery.new_cat')), body: `
      <form class="stack" data-f>
        <label class="field"><span>${esc(t('livery.cat_name'))}</span><input name="name" maxlength="60" value="${esc(c?.name || '')}" placeholder="${esc(def || t('livery.cat_name_ph'))}" ${c?.builtin ? '' : 'required'}>
          ${c?.builtin ? `<span class="tiny muted">${esc(t('livery.builtin_name_hint', { name: def }))}</span>` : ''}</label>
        <div class="field"><span>${esc(t('livery.cat_icon'))}</span><div class="lv-icons">${ICON_CHOICES.map((n) => `<button type="button" data-ic="${n}" class="${n === ic ? 'on' : ''}" aria-label="${n}">${icon(n, '', 18)}</button>`).join('')}</div></div>
        ${c?.plain ? '' : `<label class="field"><span>${esc(t('livery.keywords'))}</span><textarea name="keywords" rows="2" maxlength="500" placeholder="${esc(t('livery.keywords_ph'))}">${esc(c?.keywords || '')}</textarea>
          <span class="tiny muted">${esc(t('livery.keywords_hint'))}</span></label>`}
        <div class="row between wrap" style="margin-top:4px">
          ${c && !c.locked ? `<button type="button" class="btn danger" data-del>${icon('trash-2', '', 16)} ${esc(t('livery.delete_cat'))}</button>` : c?.locked ? `<span class="tiny muted">${icon('lock', '', 13)} ${esc(t('livery.locked'))}</span>` : '<span></span>'}
          <button class="btn primary">${icon('check', '', 18)} ${esc(t('common.save'))}</button>
        </div>
      </form>` });
    s.body.querySelectorAll('[data-ic]').forEach((b) => (b.onclick = () => {
      ic = b.dataset.ic; s.body.querySelectorAll('[data-ic]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    s.body.querySelector('[data-f]').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name') || '', icon: ic, ...(fd.has('keywords') ? { keywords: fd.get('keywords') || '' } : {}) };
      try {
        if (c) await api(`/api/livery-categories/${c.code}`, { method: 'PUT', body });
        else { const n = await api('/api/livery-categories', { method: 'POST', body }); if (!editing) active = n.code; }
        s.close(); toast(esc(t('common.saved')), { type: 'success', duration: 1400 });
        reload();
      } catch (err) { errorToast(err); }
    };
    s.body.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(esc(t('livery.delete_confirm', { name: catName(c) })), { danger: true, ok: t('common.delete') }))) return;
      try { await api(`/api/livery-categories/${c.code}`, { method: 'DELETE' }); s.close(); reload(); } catch (err) { errorToast(err); }
    });
    setTimeout(() => s.body.querySelector('input[name=name]')?.focus(), 60);
  };

  // ------------------------------------------------------------ livrées
  const findGroup = (key) => { for (const c of cats) { const g = c.groups.find((x) => x.key === key); if (g) return [g, c]; } return [null, null]; };

  const moveTo = async (key, code, index = null) => {
    const target = cats.find((c) => c.code === code);
    if (!target) return;
    const keys = target.groups.map((g) => g.key).filter((k) => k !== key);
    keys.splice(index === null ? keys.length : index, 0, key);
    try {
      await api('/api/liveries/reorder', { method: 'POST', body: { category: code, keys } });
      const [, from] = findGroup(key);
      if (from && from.code !== code) toast(esc(t('livery.moved', { name: catName(target) })), { type: 'success', duration: 1600 });
    } catch (e) { errorToast(e); }
    const y = window.scrollY;
    await reload();
    window.scrollTo(0, y);
  };

  const moveMenu = (anchor, key) => {
    const [, from] = findGroup(key);
    menu(anchor, cats.filter((c) => c.code !== from?.code).map((c) => ({ icon: c.icon, label: catName(c), onClick: () => moveTo(key, c.code) })));
  };

  const openGroup = async (key) => {
    let g;
    try { g = await api(`/api/liveries/group?key=${encodeURIComponent(key)}`); } catch (e) { errorToast(e); return; }
    const cur = g.category;
    const s = sheet({ title: esc(g.livery), wide: true, body: `
      <div class="stack" style="gap:16px">
        <div class="lv-facts">
          ${g.owner ? `<span class="chip">${icon('building-2', '', 14)} ${esc(g.owner)}</span>` : ''}
          ${g.regs.map((r) => `<a class="chip mono" href="#/airframe/${encodeURIComponent(r)}">${esc(r)}</a>`).join('')}
          ${g.types.map((x) => `<span class="chip mono">${esc(x)}</span>`).join('')}
          <span class="chip">${icon('camera', '', 14)} ${esc(t('livery.sub', { n: g.n }))}</span>
          ${g.last ? `<span class="chip">${icon('calendar', '', 14)} ${esc(fmtDate(g.last, { time: false }))}</span>` : ''}
        </div>
        <div class="field"><span>${esc(t('livery.category'))}</span>
          <div class="chips" data-cats>
            <button type="button" class="chip ${g.manual ? '' : 'on'}" data-set="">${icon('wand-sparkles', '', 14)} ${esc(t('livery.auto'))}</button>
            ${cats.map((c) => `<button type="button" class="chip ${g.manual && c.code === cur ? 'on' : ''} ${!g.manual && c.code === cur ? 'auto' : ''}" data-set="${c.code}">${icon(c.icon, '', 14)} ${esc(catName(c))}</button>`).join('')}
          </div>
          <span class="tiny muted">${esc(g.manual ? t('livery.manual_hint') : t('livery.auto_hint', { name: catName(cats.find((c) => c.code === cur)) }))}</span></div>
        <form class="field" data-rename><span>${esc(t('livery.rename'))}</span>
          <div class="row"><input class="input grow" name="livery" value="${esc(g.livery)}" maxlength="120" required><button class="btn">${icon('pencil', '', 16)} <span class="hide-sm">${esc(t('livery.rename_btn'))}</span></button></div>
          <span class="tiny muted">${esc(t('livery.rename_hint', { n: g.n }))}</span></form>
        <div class="gallery">${g.spots.map((x) => spotTile(x)).join('')}</div>
      </div>` });
    s.body.querySelectorAll('[data-set]').forEach((b) => (b.onclick = async () => {
      try {
        await api('/api/liveries/group', { method: 'PUT', body: { key, category: b.dataset.set } });
        s.close(); reload();
      } catch (e) { errorToast(e); }
    }));
    s.body.querySelector('[data-rename]').onsubmit = async (e) => {
      e.preventDefault();
      const v = new FormData(e.target).get('livery').trim();
      if (!v || v === g.livery) return;
      try {
        await api('/api/liveries/group', { method: 'PUT', body: { key, livery: v } });
        s.close(); toast(esc(t('common.saved')), { type: 'success', duration: 1400 }); reload();
      } catch (err) { errorToast(err); }
    };
  };

  // ------------------------------------------------------------ glisser-déposer (pointeur : souris, doigt, stylet)
  let dragCleanup = null;
  const enableDrag = () => {
    dragCleanup?.();
    let st = null;
    const down = (e) => {
      const cardEl = e.target.closest('.lv-card');
      if (!cardEl || e.button > 0) return;
      const viaGrip = !!e.target.closest('.lv-grip');
      if (e.pointerType !== 'mouse' && !viaGrip) return;   // au doigt : la poignée, pour laisser défiler la page
      if (e.target.closest('.lv-move')) return;
      st = { card: cardEl, x0: e.clientX, y0: e.clientY, id: e.pointerId, from: cardEl.parentElement, idx: [...cardEl.parentElement.children].indexOf(cardEl), active: false };
      if (viaGrip) e.preventDefault();
    };
    // L'élément touché ne quitte jamais sa place dans le DOM (sinon le navigateur annule le geste tactile) :
    // une silhouette marque l'emplacement d'arrivée, la carte d'origine est seulement sortie de la mise en page.
    const start = () => {
      const r = st.card.getBoundingClientRect();
      st.dx = st.x0 - r.left; st.dy = st.y0 - r.top;
      st.ghost = st.card.cloneNode(true);
      st.ghost.classList.add('lv-ghost');
      Object.assign(st.ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
      document.body.append(st.ghost);
      st.ph = document.createElement('div');
      st.ph.className = 'lv-slot';
      st.card.after(st.ph);
      st.card.classList.add('lv-src');
      document.body.classList.add('lv-drag-on');
      st.active = true;
      navigator.vibrate?.(8);
      scroll();
    };
    const scroll = () => {
      if (!st?.active) return;
      const m = 90, y = st.y;
      if (y < m) window.scrollBy(0, -Math.ceil((m - y) / 6));
      else if (y > window.innerHeight - m) window.scrollBy(0, Math.ceil((y - (window.innerHeight - m)) / 6));
      st.raf = requestAnimationFrame(scroll);
    };
    const move = (e) => {
      if (!st || e.pointerId !== st.id) return;
      st.x = e.clientX; st.y = e.clientY;
      if (!st.active) {
        if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) return;
        start();
      }
      e.preventDefault();
      st.ghost.style.transform = `translate(${e.clientX - st.dx}px, ${e.clientY - st.dy}px) scale(1.04) rotate(-1deg)`;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      root.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
      st.chip = null;
      const chip = under?.closest('.lv-bar [data-c]');
      if (chip && chip.dataset.c) { chip.classList.add('drop-on'); st.chip = chip.dataset.c; st.ph.hidden = true; return; }
      st.ph.hidden = false;
      const target = under?.closest('.lv-card:not(.lv-src)');
      const gal = under?.closest('.lv-gallery');
      if (target && gal) {
        const r = target.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const ref = after ? target.nextSibling : target;
        if (ref !== st.ph && ref?.previousSibling !== st.ph) gal.insertBefore(st.ph, ref);
      } else if (gal && !under.closest('.lv-slot')) {
        const cards = gal.querySelectorAll('.lv-card:not(.lv-src)');
        const last = cards[cards.length - 1];
        if (!last || e.clientY > last.getBoundingClientRect().bottom - 4) gal.insertBefore(st.ph, gal.querySelector('.lv-empty'));
        gal.classList.add('drop-on');
      }
    };
    const up = async (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s0 = st; st = null;
      if (!s0.active) return;
      cancelAnimationFrame(s0.raf);
      s0.ghost.remove();
      s0.card.classList.remove('lv-src');
      s0.card.dataset.dragged = '1';
      document.body.classList.remove('lv-drag-on');
      root.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
      const key = s0.card.dataset.key;
      const gal = s0.ph.parentElement;
      const before = [...gal.children].filter((x) => x.matches('.lv-card, .lv-slot') && x !== s0.card);
      const idx = before.indexOf(s0.ph);
      const same = gal === s0.from && (s0.ph.previousElementSibling === s0.card || s0.card.nextElementSibling === s0.ph);
      s0.ph.remove();
      if (s0.chip) {
        const b = root.querySelector(`.lv-bar [data-c="${s0.chip}"]`);
        if (b) b.dataset.dropped = '1';
        return moveTo(key, s0.chip);
      }
      if (e.type === 'pointercancel' || same) return;
      gal.insertBefore(s0.card, before[idx + 1] || gal.querySelector('.lv-empty'));   // retour visuel immédiat
      moveTo(key, gal.dataset.cat, idx);
    };
    const cancel = (e) => { if (st?.active) up(e); else st = null; };
    root.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    dragCleanup = () => {
      root.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  };

  draw();
  return () => { dragCleanup?.(); document.body.classList.remove('lv-drag-on'); document.querySelectorAll('.lv-ghost').forEach((x) => x.remove()); };
}

