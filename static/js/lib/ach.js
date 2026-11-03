// Succès : libellés communs (toasts, tableau de bord, page des succès)
import { t, fmtNum } from '../i18n.js';

export const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

/** « flight_km_40075 » → { series: 'flight_km', target: 40075 } */
export function parseCode(code) {
  const m = /^(.*)_(\d+)$/.exec(code || '');
  return m ? { series: m[1], target: Number(m[2]) } : { series: code, target: 0 };
}

export function roman(n) {
  let out = '';
  for (const [v, s] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { out += s; n -= v; }
  return out;
}

export function achName(code, level) {
  const { series } = parseCode(code);
  const base = t(`ach.s.${series}.name`);
  return level ? `${base} ${roman(level)}` : base;
}

export function achDesc(code) {
  const { series, target } = parseCode(code);
  return t(`ach.s.${series}.desc`, { n: fmtNum(target), count: target });
}
