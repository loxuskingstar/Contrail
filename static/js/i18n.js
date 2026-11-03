// Internationalisation : FR (référence), EN, ES, JA
export const LANGS = { fr: 'Français', en: 'English', es: 'Español', ja: '日本語' };
const LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', ja: 'ja-JP' };

let dict = {};
let fallback = {};
export let lang = 'fr';

async function load(code) {
  const res = await fetch(`/static/i18n/${code}.json`, { cache: 'no-cache' });
  return res.ok ? res.json() : {};
}

export async function setLang(code) {
  lang = LANGS[code] ? code : 'fr';
  const [d, f] = await Promise.all([load(lang), lang === 'fr' ? Promise.resolve(null) : load('fr')]);
  dict = d;
  fallback = f || d;
  document.documentElement.lang = lang;
}

export function t(key, vars) {
  let s = dict[key] ?? fallback[key];
  if (s === undefined) return key;
  if (vars) {
    if (typeof s === 'object') s = (vars.count ?? vars.n) === 1 ? s.one : s.other;
    s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  } else if (typeof s === 'object') s = s.other;
  return s;
}

export const has = (key) => key in dict || key in fallback;
export const locale = () => LOCALES[lang] || 'fr-FR';

export function fmtNum(n, opts) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(locale(), opts).format(n);
}

export function fmtDate(iso, { time = true, short = false, weekday = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00' : iso.replace('Z', ''));
  if (Number.isNaN(d.getTime())) return iso;
  const opts = short ? { day: 'numeric', month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' };
  if (weekday) opts.weekday = short ? 'short' : 'long';
  if (time && iso.length > 10) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat(locale(), opts).format(d);
}

export function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { month: 'short' }).format(new Date(y, m - 1, 1));
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso, { time: false });
}

export function fmtDuration(min) {
  if (!min && min !== 0) return '—';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

let regionNames;
export function countryName(code) {
  if (!code) return '';
  try {
    regionNames = regionNames?.lang === lang ? regionNames : Object.assign(new Intl.DisplayNames([locale()], { type: 'region' }), { lang });
    return regionNames.of(code) || code;
  } catch { return code; }
}

export function flag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
