// Création / édition d'un vol personnel
import { api, mediaUrl } from '../api.js';
import { navigate } from '../app.js';
import { t, fmtNum, fmtDate } from '../i18n.js';
import { icon } from '../lib/icons.js';
import { airportInput } from '../lib/fields.js';
import { esc, pageHead, confirmDialog, errorToast, toast, undoToast } from '../ui.js';
import { afterSave } from './spot-form.js';

export async function render(root, params, query = {}) {
  const editing = !!params.id;
  let f = editing ? await api(`/api/flights/${params.id}`) : { date: new Date().toISOString().slice(0, 10) };
  // Pré-remplissage : copie d'un vol ou vol retour (départ et arrivée inversés)
  if (!editing && query.from) {
    const src = await api(`/api/flights/${encodeURIComponent(query.from)}`).catch(() => null);
    if (src) {
      const keep = ['airline', 'airline_icao', 'cabin_class', 'reason'];
      const copy = query.return ? keep : [...keep, 'dep_icao', 'arr_icao', 'flight_number', 'registration', 'aircraft', 'aircraft_icao', 'seat_type', 'dep_time', 'arr_time'];
      f = { date: f.date, ...Object.fromEntries(copy.map((k) => [k, src[k]])) };
      if (query.return) { f.dep_icao = src.arr_icao; f.arr_icao = src.dep_icao; }
    }
  }
  const sel = (name, values, cur) => `<select name="${name}"><option value="">—</option>${values.map((v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(t(`${name}.${v}`))}</option>`).join('')}</select>`;
  root.innerHTML = `
    ${pageHead(esc(editing ? t('flight.edit') : t('flight.new')), { sub: editing ? `${esc(f.dep_icao)} → ${esc(f.arr_icao)} · ${fmtDate(f.date, { time: false })}` : esc(t('flight.new_sub')) })}
    <form class="stack" style="gap:16px">
      <div class="card stack">
        <div class="field-row">
          <label class="field"><span>${esc(t('flight.from'))}</span><div class="input-wrap"><input name="dep_icao" value="${esc(f.dep_icao)}" required placeholder="LFBO" autocomplete="off"></div></label>
          <label class="field"><span>${esc(t('flight.to'))}</span><div class="input-wrap"><input name="arr_icao" value="${esc(f.arr_icao)}" required placeholder="LFPG" autocomplete="off"></div></label>
        </div>
        <div data-route class="small muted"></div>
        <div class="field-row">
          <label class="field"><span>${esc(t('flight.date'))}</span><input type="date" name="date" value="${esc(f.date)}" required></label>
          <label class="field"><span>${esc(t('flight.dep_time'))}</span><input type="time" name="dep_time" value="${esc(f.dep_time)}"></label>
          <label class="field"><span>${esc(t('flight.arr_time'))}</span><input type="time" name="arr_time" value="${esc(f.arr_time)}"></label>
        </div>
      </div>
      <div class="card stack">
        <div class="field-row">
          <label class="field"><span>${esc(t('flight.number'))}</span><input name="flight_number" value="${esc(f.flight_number)}" placeholder="AF7781" autocapitalize="characters"></label>
          <label class="field"><span>${esc(t('flight.airline'))}</span><input name="airline" value="${esc(f.airline)}" placeholder="Air France"></label>
          <label class="field"><span>${esc(t('spot.airline_icao'))}</span><input name="airline_icao" value="${esc(f.airline_icao)}" maxlength="4" placeholder="AFR"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>${esc(t('spot.registration'))}</span><div class="input-wrap"><input name="registration" class="mono" value="${esc(f.registration)}" placeholder="F-HBXA" autocapitalize="characters">
            <button type="button" class="btn-icon" data-lookup>${icon('wand-sparkles', '', 18)}</button></div></label>
          <label class="field"><span>${esc(t('spot.aircraft'))}</span><input name="aircraft" value="${esc(f.aircraft)}" placeholder="Airbus A320"></label>
          <label class="field"><span>${esc(t('spot.type_code'))}</span><input name="aircraft_icao" value="${esc(f.aircraft_icao)}" placeholder="A320"></label>
        </div>
        <div data-xref></div>
      </div>
      <details class="card fold" ${f.seat || f.cabin_class || f.notes ? 'open' : ''}>
        <summary>${icon('ticket', '', 18)} ${esc(t('flight.cabin'))} ${icon('chevron-down', 'chev', 18)}</summary>
        <div class="fold-body stack">
          <div class="field-row">
            <label class="field"><span>${esc(t('flight.seat'))}</span><input name="seat" value="${esc(f.seat)}" placeholder="12A"></label>
            <label class="field"><span>${esc(t('flight.seat_type'))}</span>${sel('seat_type', ['window', 'middle', 'aisle'], f.seat_type)}</label>
          </div>
          <div class="field-row">
            <label class="field"><span>${esc(t('flight.class'))}</span>${sel('cabin_class', ['economy', 'premium', 'business', 'first', 'crew'], f.cabin_class)}</label>
            <label class="field"><span>${esc(t('flight.reason'))}</span>${sel('reason', ['leisure', 'business', 'crew', 'other'], f.reason)}</label>
            <label class="field"><span>${esc(t('flight.duration'))}</span><input name="duration_min" type="number" min="0" value="${esc(f.duration_min)}" placeholder="${esc(t('flight.auto'))}"></label>
          </div>
          <label class="field"><span>${esc(t('spot.description'))}</span><textarea name="notes" rows="3">${esc(f.notes)}</textarea></label>
        </div>
      </details>
      <div class="sticky-actions glass">
        ${editing ? `<button type="button" class="btn-icon" data-del style="color:var(--danger)">${icon('trash-2')}</button>` : ''}
        <a class="btn ghost" href="#/flights">${esc(t('common.cancel'))}</a>
        <button class="btn primary grow" type="submit">${icon('check', '', 18)} ${esc(t('common.save'))}</button>
      </div>
    </form>`;
  const form = root.querySelector('form');
  const F = (n) => form.elements[n];
  const { haversineKm } = await import('../lib/map.js');
  const routeInfo = async () => {
    const dep = F('dep_icao').value.trim(), arr = F('arr_icao').value.trim();
    if (!dep || !arr) return;
    try {
      const [a, b] = await Promise.all([api(`/api/airports/${dep}`), api(`/api/airports/${arr}`)]);
      const km = haversineKm([a.lat, a.lng], [b.lat, b.lng]);
      root.querySelector('[data-route]').innerHTML = `${icon('route', '', 15)} ${esc(a.name)} → ${esc(b.name)} · <b>${fmtNum(Math.round(km))} km</b>`;
    } catch { root.querySelector('[data-route]').textContent = ''; }
  };
  airportInput(F('dep_icao'), { onPick: routeInfo });
  airportInput(F('arr_icao'), { onPick: routeInfo });
  F('dep_icao').addEventListener('change', routeInfo);
  F('arr_icao').addEventListener('change', routeInfo);
  routeInfo();

  const xref = async () => {
    const reg = F('registration').value.trim();
    const box = root.querySelector('[data-xref]');
    if (!reg) { box.innerHTML = ''; return; }
    try {
      const r = await api('/api/spots', { query: { registration: reg.toUpperCase().replace(/\s/g, ''), limit: 6 } });
      box.innerHTML = r.total ? `<div class="ocr-strip">${icon('camera', '', 18)}<span class="small grow"><b>${esc(t('crossref.flight', { reg: reg.toUpperCase(), n: r.total }))}</b></span>
        ${r.items.filter((s) => s.thumb).slice(0, 4).map((s) => `<a href="#/spots/${s.id_spotting}" target="_blank"><img src="${mediaUrl('thumbs', s.thumb)}" style="width:54px;height:38px;border-radius:8px;object-fit:cover" alt=""></a>`).join('')}</div>` : '';
    } catch { box.innerHTML = ''; }
  };
  F('registration').addEventListener('change', xref);
  xref();
  root.querySelector('[data-lookup]').onclick = async () => {
    const reg = F('registration').value.trim();
    if (!reg) return;
    try {
      const d = await api(`/api/lookup/aircraft/${encodeURIComponent(reg)}`);
      F('registration').value = d.registration;
      if (d.aircraft && !F('aircraft').value) F('aircraft').value = d.aircraft;
      if (d.aircraft_icao && !F('aircraft_icao').value) F('aircraft_icao').value = d.aircraft_icao;
      if (d.owner && !F('airline').value) F('airline').value = d.owner;
      if (d.airline_icao && !F('airline_icao').value) F('airline_icao').value = d.airline_icao;
      xref();
    } catch (e) { errorToast(e); }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const k of ['date', 'dep_icao', 'arr_icao', 'dep_time', 'arr_time', 'flight_number', 'airline', 'airline_icao', 'registration', 'aircraft', 'aircraft_icao', 'seat', 'seat_type', 'cabin_class', 'reason', 'notes']) body[k] = F(k).value.trim() || null;
    body.duration_min = F('duration_min').value ? Number(F('duration_min').value) : null;
    if (!body.dep_icao || !body.arr_icao || !body.date) { toast(esc(t('err.airports_required')), { type: 'error' }); return; }
    try {
      const res = await api(editing ? `/api/flights/${f.id_flight}` : '/api/flights', { method: editing ? 'PUT' : 'POST', body });
      afterSave(res);
      navigate(`#/flights/${res.flight?.id_flight || ''}`);
    } catch (err) { errorToast(err); }
  };
  root.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmDialog(esc(t('flight.confirm_delete')), { danger: true, ok: t('common.delete') }))) return;
    const r = await api(`/api/flights/${f.id_flight}`, { method: 'DELETE' });
    undoToast(esc(t('common.deleted')), r.trash, { onUndo: () => navigate('#/flights') });
    navigate('#/flights');
  });
}
