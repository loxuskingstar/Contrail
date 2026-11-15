// Catégories de livrées (éditables) : liste partagée par la page Livrées, les filtres et les libellés
import { api } from '../api.js';
import { t, has } from '../i18n.js';

let cache = null;

export async function liveryCats(force = false) {
  if (!cache || force) cache = await api('/api/livery-categories').catch(() => cache || []);
  return cache;
}
export const setLiveryCats = (list) => { cache = list; };
export const catName = (c) => (c?.name || (c && has(`livery.${c.code}`) ? t(`livery.${c.code}`) : c?.code || ''));
export function catLabel(code, fallback = code) {
  const c = cache?.find((x) => x.code === code);
  return c ? catName(c) : has(`livery.${code}`) ? t(`livery.${code}`) : fallback;
}
