// Cartographie (Leaflet + OpenStreetMap) : cartes, grand cercle, icônes
const L = () => window.L;

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTR = `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

/** Fond de carte selon les réglages : CARTO (clair/sombre suivant le thème), OSM standard ou URL personnalisée. */
export function tileConfig() {
  const s = window.__store?.settings || {};
  const dark = document.documentElement.dataset.theme === 'dark';
  const mode = s.map_tiles || 'auto';
  if (mode === 'osm') return { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR, maxZoom: 19 };
  if (mode === 'custom' && s.map_tiles_url) return { url: s.map_tiles_url, attribution: s.map_tiles_attribution || OSM_ATTR, maxZoom: 19 };
  const style = mode === 'carto_light' ? 'light_all' : mode === 'carto_dark' ? 'dark_all' : dark ? 'dark_all' : 'light_all';
  return { url: `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, attribution: CARTO_ATTR, subdomains: 'abcd', maxZoom: 20 };
}

export function createMap(el, { center = [46.6, 2.4], zoom = 5, zoomControl = true, scrollWheelZoom = true } = {}) {
  const map = L().map(el, { center, zoom, zoomControl, scrollWheelZoom, worldCopyJump: true, attributionControl: true });
  const cfg = tileConfig();
  L().tileLayer(cfg.url, {
    maxZoom: cfg.maxZoom, subdomains: cfg.subdomains || 'abc', attribution: cfg.attribution,
    // Exigé par la politique d'usage des serveurs de tuiles bénévoles
    referrerPolicy: 'strict-origin-when-cross-origin', crossOrigin: false,
  }).addTo(map);
  // La carte peut être créée dans un conteneur encore invisible
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Points intermédiaires de l'orthodromie (grand cercle) entre deux positions. */
export function greatCircle([lat1, lon1], [lat2, lon2], n = 64) {
  const p1 = toRad(lat1), l1 = toRad(lon1), p2 = toRad(lat2), l2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d === 0) return [[lat1, lon1]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  // Évite les traits horizontaux à travers la carte au passage de l'antiméridien
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360;
    while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360;
  }
  return pts;
}

export function pinIcon(label = '', color = 'var(--accent)') {
  return L().divIcon({
    className: '', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30],
    html: `<div class="pin" style="background:${color}"><span>${label}</span></div>`,
  });
}

export function dotIcon(color = 'var(--accent)', size = 14) {
  return L().divIcon({
    className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:99px;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgb(0 0 0/.4)"></div>`,
  });
}

const PLANE_PATH = 'M12 2c.7 0 1.2.9 1.2 2v5.2l7.3 4.3c.3.2.5.5.5.9v1.3l-7.8-2.4v4.3l2 1.5v1.4l-3.2-.9-3.2.9v-1.4l2-1.5v-4.3L3 15.7v-1.3c0-.4.2-.7.5-.9l7.3-4.3V4c0-1.1.5-2 1.2-2z';

export function planeIcon(track = 0, color = '#3b82f6', size = 28) {
  return L().divIcon({
    className: 'plane-marker', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${track || 0}deg)"><path d="${PLANE_PATH}" fill="${color}" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
  });
}

/** Cône indiquant la direction de visée d'un point de vue. */
export function viewCone(map, lat, lng, bearing, { radius = 600, spread = 35, color = '#3b82f6' } = {}) {
  if (bearing === null || bearing === undefined) return null;
  const pts = [[lat, lng]];
  for (let a = bearing - spread; a <= bearing + spread; a += 5) pts.push(destination(lat, lng, a, radius));
  pts.push([lat, lng]);
  return L().polygon(pts, { color, weight: 1, fillOpacity: 0.18 }).addTo(map);
}

export function destination(lat, lng, bearing, meters) {
  const R = 6371000, d = meters / R, b = toRad(bearing), p1 = toRad(lat), l1 = toRad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), toDeg(l2)];
}

export function fitTo(map, latlngs, { maxZoom = 11, padding = [30, 30] } = {}) {
  if (!latlngs.length) return;
  if (latlngs.length === 1) { map.setView(latlngs[0], Math.min(maxZoom, 11)); return; }
  map.fitBounds(L().latLngBounds(latlngs), { padding, maxZoom });
}

export function haversineKm(a, b) {
  const R = 6371.0088, dp = toRad(b[0] - a[0]), dl = toRad(b[1] - a[1]);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
