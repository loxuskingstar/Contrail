// Photos d'appareils via l'API publique de Planespotters.net.
// Conditions d'utilisation respectées : appel direct depuis le navigateur (jamais via le serveur),
// URL d'image utilisées telles quelles, nom du photographe affiché et vignette liée à la page
// de la photo, réponses JSON mises en cache au plus 24 h.
import { esc } from '../ui.js';
import { t } from '../i18n.js';

const API = 'https://api.planespotters.net/pub/photos';
const TTL = 24 * 3600 * 1000;
const KEY = 'contrail.psp';

function cache() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function store(c) {
  try {
    const now = Date.now();
    for (const k of Object.keys(c)) if (now - c[k].t > TTL) delete c[k];
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* stockage indisponible */ }
}

async function query(kind, id) {
  const key = `${kind}:${id}`;
  const c = cache();
  if (c[key] && Date.now() - c[key].t < TTL) return c[key].v;
  const res = await fetch(`${API}/${kind}/${encodeURIComponent(id)}`, { referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!res.ok) throw new Error(`planespotters ${res.status}`);
  const d = await res.json();
  const p = (d.photos || [])[0];
  const v = p ? { thumb: p.thumbnail_large?.src || p.thumbnail?.src, w: p.thumbnail_large?.size?.width, h: p.thumbnail_large?.size?.height,
    link: p.link, photographer: p.photographer } : null;
  c[key] = { t: Date.now(), v };
  store(c);
  return v;
}

/** Dernière photo de l'appareil (par Mode-S, sinon par immatriculation), ou null. */
export async function planespottersPhoto({ hex, reg } = {}) {
  if (!navigator.onLine) return null;
  try {
    if (hex) {
      const v = await query('hex', hex.toUpperCase());
      if (v) return v;
    }
    if (reg) return await query('reg', reg.toUpperCase());
  } catch { /* service indisponible : pas de photo */ }
  return null;
}

/** Bloc HTML : vignette liée à la page Planespotters + crédit du photographe (obligatoires). */
export function photoBlock(p) {
  return `<a href="${esc(p.link)}" target="_blank"><img src="${esc(p.thumb)}" alt="${esc(t('photo.alt'))}" loading="lazy"></a>
    <div class="ac-credit">© ${esc(p.photographer || '')} — <a href="${esc(p.link)}" target="_blank">Planespotters.net</a></div>`;
}
