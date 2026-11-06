// Détail d'une sortie : chiffres clés, météo, nouveautés et liste chronologique des spots
import { api } from '../api.js';
import { t, fmtDate, fmtNum } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { esc, pageHead, spotRow, sheet, toast, errorToast } from '../ui.js';
import { outingSite, outingTitle } from './outings.js';

const hhmm = (iso) => (iso || '').slice(11, 16);

function duration(a, b) {
  if (!a || !b) return '';
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  if (m < 1) return '';
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export async function render(root, { id }) {
  const o = await api(`/api/outings/${id}`);
  const dur = duration(o.first_at, o.last_at);
  const w = o.weather;
  const kpis = [['camera', fmtNum(o.n), t('outing.k_spots')], ['plane', fmtNum(o.regs), t('outing.k_aircraft')], ['layers', fmtNum(o.types), t('outing.k_types')],
    ['sparkles', fmtNum(o.new_regs), t('outing.k_new')], o.specials ? ['palette', fmtNum(o.specials), t('outing.k_special')] : null,
    o.military ? ['shield', fmtNum(o.military), t('outing.k_military')] : null, o.favs ? ['star', fmtNum(o.favs), t('outing.k_fav')] : null].filter(Boolean);
  root.innerHTML = `${pageHead(esc(outingTitle(o)), {
      sub: `${esc(fmtDate(o.day, { time: false, weekday: true }))}${o.name ? ` · ${esc(outingSite(o))}` : ''}${dur ? ` · ${icon('clock', '', 14)} ${esc(hhmm(o.first_at))}–${esc(hhmm(o.last_at))} (${esc(dur)})` : ''}`,
      actions: `${o.prev_id ? `<a class="btn-icon" href="#/outings/${o.prev_id}" title="${esc(t('outing.prev'))}">${icon('chevron-left')}</a>` : ''}${o.next_id ? `<a class="btn-icon" href="#/outings/${o.next_id}" title="${esc(t('outing.next'))}">${icon('chevron-right')}</a>` : ''}<button class="btn" data-edit>${icon('pencil', '', 16)} ${esc(t('common.edit'))}</button>` })}
    <div class="grid kpis" style="margin-bottom:14px">${kpis.map(([ic, v, l]) => `<div class="card kpi">${icon(ic)}<div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
    <div class="chips" style="margin-bottom:14px">
      ${o.airport ? `<a class="chip" href="#/airports/${o.airport}">${icon('map-pin', '', 14)} ${esc(o.airport_info?.name || o.airport)}</a>` : ''}
      <a class="chip" href="#/spots?outing=${o.id}">${icon('list', '', 14)} ${esc(t('outing.open_list'))}</a>
      ${w ? `<span class="chip" title="${esc(w.raw || '')}">${icon('cloud-sun', '', 14)} ${esc([w.category, w.wind ? `${w.wind.dir ?? ''}${w.wind.speed != null ? '/' + w.wind.speed + ' kt' : ''}` : '', w.temp != null ? `${w.temp}°` : ''].filter(Boolean).join(' · '))}</span>` : ''}
      ${o.top_types.map((x) => `<a class="chip" href="#/spots?outing=${o.id}&type=${encodeURIComponent(x.k)}">${esc(x.k)} · ${x.n}</a>`).join('')}</div>
    ${o.notes ? `<div class="card" style="margin-bottom:14px;white-space:pre-wrap">${esc(o.notes)}</div>` : ''}
    <div class="section"><h2>${esc(t('outing.timeline'))}</h2></div>
    <div class="card" style="padding:6px">${o.spots.map((s) => spotRow(s)).join('')}</div>`;

  root.querySelector('[data-edit]').onclick = () => {
    const sh = sheet({ title: esc(t('outing.edit')), body: `<div class="stack">
      <label class="field"><span>${esc(t('outing.name'))}</span><input data-name maxlength="120" value="${esc(o.name || '')}" placeholder="${esc(t('outing.name_ph'))}"></label>
      <label class="field"><span>${esc(t('outing.notes'))}</span><textarea data-notes rows="5">${esc(o.notes || '')}</textarea></label>
      <button class="btn primary" data-save>${esc(t('common.save'))}</button></div>` });
    sh.body.querySelector('[data-save]').onclick = async () => {
      try {
        await api(`/api/outings/${o.id}`, { method: 'PUT', body: { name: sh.body.querySelector('[data-name]').value, notes: sh.body.querySelector('[data-notes]').value } });
        sh.close(); toast(esc(t('common.saved')), { type: 'success' }); render(root, { id });
      } catch (e) { errorToast(e); }
    };
  };
}
