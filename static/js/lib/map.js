// Cartographie vectorielle : MapLibre GL JS + fonds OpenFreeMap (gratuits, sans clé)
// Un petit enrobage expose une API simple aux vues (marqueurs, lignes, polygones, cadrage).

const ML_JS = '/static/vendor/maplibre/maplibre-gl.js';
const ML_CSS = '/static/vendor/maplibre/maplibre-gl.css';
let loading = null;

/** Charge MapLibre à la demande (≈ 1 Mo, mis en cache ensuite par le service worker). */
export function ensureMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${ML_CSS}"]`)) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = ML_CSS;
      document.head.append(css);
    }
    const s = document.createElement('script');
    s.src = ML_JS;
    s.onload = () => resolve(window.maplibregl);
    s.onerror = () => { loading = null; reject(new Error('maplibre_unavailable')); };
    document.head.append(s);
  });
  return loading;
}

const OFM = 'https://tiles.openfreemap.org/styles/';
export const MAP_STYLES = ['auto', 'positron', 'liberty', 'bright', 'dark', 'fiord', 'osm', 'custom'];

/** Style de carte selon les réglages : OpenFreeMap (clair / sombre suivant le thème), OSM raster ou URL perso. */
export function styleFor() {
  const s = window.__store?.settings || {};
  const dark = document.documentElement.dataset.theme === 'dark';
  let mode = s.map_tiles || 'auto';
  if (!MAP_STYLES.includes(mode)) mode = 'auto';   // anciennes valeurs (carto_*) → auto
  if (mode === 'custom' && s.map_tiles_url) return s.map_tiles_url;
  if (mode === 'osm') {
    return {
      version: 8,
      sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    };
  }
  if (mode === 'auto') mode = dark ? 'dark' : 'positron';
  return OFM + mode;
}

function fallbackStyle() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim() || '#e5e7eb';
  return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': bg } }] };
}

const ll = ([lat, lng]) => [lng, lat];

/**
 * Crée une carte et attend que le style soit prêt.
 * @returns {Promise<ContrailMap>}
 */
export async function createMap(el, { center = [46.6, 2.4], zoom = 4.5, scrollZoom = true, controls = 'top-left', interactive = true } = {}) {
  const maplibregl = await ensureMapLibre();
  const map = new maplibregl.Map({
    container: el, style: styleFor(), center: ll(center), zoom, attributionControl: false,
    cooperativeGestures: false, scrollZoom, interactive, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), controls);
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  // Hors-ligne ou style injoignable : fond uni, les données restent affichées
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    map.once('load', finish);
    map.once('error', (e) => {
      if (done || map.loaded()) return;
      console.warn('Style de carte indisponible, fond uni utilisé', e?.error?.message || e);
      map.setStyle(fallbackStyle());
      map.once('styledata', finish);
    });
    setTimeout(() => {
      if (!done) { map.setStyle(fallbackStyle()); map.once('styledata', finish); setTimeout(finish, 1500); }
    }, 9000);
  });
  return new ContrailMap(map, maplibregl);
}

class ContrailMap {
  constructor(map, ml) {
    this.map = map;
    this.ml = ml;
    this.groups = new Map();
    this.ro = new ResizeObserver(() => map.resize());
    this.ro.observe(map.getContainer());
  }

  /** Marqueur HTML : kind = pin (pastille avec libellé) | dot | element */
  marker(latlng, { kind = 'pin', label = '', color, size, html, popup, popupClass, popupOffset = 14, title, draggable = false, onClick, onDragEnd, group = 'default', z } = {}) {
    let el;
    if (kind === 'element' && html) {
      el = document.createElement('div');
      el.innerHTML = html;
      el = el.firstElementChild || el;
    } else if (kind === 'dot') {
      el = document.createElement('div');
      el.className = 'mdot';
      const sz = size || 12;
      el.style.cssText = `width:${sz}px;height:${sz}px;${color ? `background:${color};` : ''}`;
    } else {
      el = document.createElement('div');
      el.className = `mpin${label === '' || label === null ? ' empty' : ''}`;
      if (color) el.style.background = color;
      el.textContent = label ?? '';
    }
    if (title) el.title = title;
    if (z) el.style.zIndex = z;
    const m = new this.ml.Marker({ element: el, draggable, anchor: 'center' }).setLngLat(ll(latlng)).addTo(this.map);
    if (popup) m.setPopup(new this.ml.Popup({ offset: popupOffset, maxWidth: '300px', className: popupClass }).setHTML(popup));
    if (onClick) el.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    if (onDragEnd) m.on('dragend', () => { const p = m.getLngLat(); onDragEnd({ lat: p.lat, lng: p.lng }); });
    const api = {
      marker: m, el,
      remove: () => m.remove(),
      setLatLng: (p) => m.setLngLat(ll(p)),
      getLatLng: () => { const p = m.getLngLat(); return { lat: p.lat, lng: p.lng }; },
    };
    if (!group.startsWith('__')) {
      if (!this.groups.has(group)) this.groups.set(group, []);
      this.groups.get(group).push(api);
    }
    return api;
  }

  clear(group = 'default') {
    for (const m of this.groups.get(group) || []) m.remove();
    this.groups.set(group, []);
  }

  _setSource(id, data) {
    const src = this.map.getSource(id);
    if (src) { src.setData(data); return false; }
    this.map.addSource(id, { type: 'geojson', data });
    return true;
  }

  /**
   * Points regroupés en clusters quand la carte est dézoomée.
   * points = [{ lat, lng, count = 1, label, popup, title, onClick }]
   * Les clusters et les points isolés sont des marqueurs HTML (aucune dépendance aux polices du style) ;
   * un clic sur un cluster zoome jusqu'à son éclatement.
   */
  clusters(id, points, { radius = 46, maxZoom = 13, decorate } = {}) {
    const byId = new Map(points.map((p, i) => [i, p]));
    const data = {
      type: 'FeatureCollection',
      features: points.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { i, n: p.count || 1 } })),
    };
    const old = this._clusterState?.get(id);
    if (old) { old.markers.forEach((m) => m.remove()); this.map.off('render', old.onRender); }
    if (this.map.getSource(id)) this.map.getSource(id).setData(data);
    else {
      this.map.addSource(id, { type: 'geojson', data, cluster: true, clusterRadius: radius, clusterMaxZoom: maxZoom,
        clusterProperties: { total: ['+', ['get', 'n']] } });
      // Couche invisible : nécessaire pour que la source soit calculée et interrogeable
      this.map.addLayer({ id: `${id}-hit`, type: 'circle', source: id, paint: { 'circle-radius': 1, 'circle-opacity': 0 } });
    }
    const markers = new Map();
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const seen = new Set();
      for (const f of this.map.querySourceFeatures(id)) {
        const p = f.properties;
        const key = p.cluster ? `c${p.cluster_id}` : `p${p.i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (markers.has(key)) continue;
        const [lng, lat] = f.geometry.coordinates;
        let m;
        if (p.cluster) {
          const total = p.total || p.point_count;
          const size = Math.round(30 + Math.min(26, Math.log2(total + 1) * 5));
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'mcluster';
          el.style.width = el.style.height = `${size}px`;
          el.textContent = total > 999 ? `${Math.round(total / 100) / 10}k` : total;
          el.setAttribute('aria-label', `${total}`);
          el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const src = this.map.getSource(id);
            const z = await src.getClusterExpansionZoom(p.cluster_id);
            this.map.easeTo({ center: [lng, lat], zoom: Math.min(z + 0.3, 18), duration: 450 });
          });
          m = new this.ml.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(this.map);
        } else {
          const pt = byId.get(p.i);
          const mk = this.marker([lat, lng], { kind: pt.html ? 'element' : 'pin', html: pt.html, label: pt.label ?? '', popup: pt.popup, title: pt.title, onClick: pt.onClick, color: pt.color, group: `__${id}` });
          decorate?.(pt, mk.el);
          m = mk.marker;
        }
        markers.set(key, m);
      }
      for (const [k, m] of markers) if (!seen.has(k)) { m.remove(); markers.delete(k); }
    };
    const onRender = () => { if (!scheduled && this.map.isSourceLoaded(id)) { scheduled = true; requestAnimationFrame(update); } };
    this.map.on('render', onRender);
    this._clusterState ||= new Map();
    this._clusterState.set(id, { markers, onRender });
    requestAnimationFrame(update);
  }

  /** Lignes (ex. orthodromies) : lines = [{ coords: [[lat,lng]...], props }] */
  lines(id, lines, { color = accent(), width = 2.2, opacity = 0.85, dash = null, onClick } = {}) {
    const data = { type: 'FeatureCollection', features: lines.map((l, i) => ({ type: 'Feature', id: i, properties: { ...(l.props || {}), _i: i }, geometry: { type: 'LineString', coordinates: l.coords.map(ll) } })) };
    try {
      if (this._setSource(id, data)) {
        const paint = { 'line-color': color, 'line-width': width, 'line-opacity': opacity };
        if (dash) paint['line-dasharray'] = dash;
        this.map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint });
        if (onClick) {
          this.map.on('click', id, (e) => onClick(e.features[0].properties, e.lngLat));
          this.map.on('mouseenter', id, () => (this.map.getCanvas().style.cursor = 'pointer'));
          this.map.on('mouseleave', id, () => (this.map.getCanvas().style.cursor = ''));
        }
      }
    } catch (e) { console.warn(e); }
  }

  /** Polygones remplis (ex. cônes de visée) : polys = [[[lat,lng]...], ...] */
  polygons(id, polys, { color = accent(), opacity = 0.18 } = {}) {
    const data = { type: 'FeatureCollection', features: polys.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [p.map(ll)] } })) };
    try {
      if (this._setSource(id, data)) {
        this.map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': color, 'fill-opacity': opacity } });
        this.map.addLayer({ id: `${id}-line`, type: 'line', source: id, paint: { 'line-color': color, 'line-width': 1, 'line-opacity': 0.7 } });
      }
    } catch (e) { console.warn(e); }
  }

  popup(latlng, html) {
    return new this.ml.Popup({ offset: 10, maxWidth: '300px' }).setLngLat(ll(latlng)).setHTML(html).addTo(this.map);
  }

  fit(points, { maxZoom = 11, padding = 40 } = {}) {
    if (!points.length) return;
    if (points.length === 1) { this.map.jumpTo({ center: ll(points[0]), zoom: Math.min(maxZoom, 11) }); return; }
    const b = new this.ml.LngLatBounds();
    for (const p of points) b.extend(ll(p));
    this.map.fitBounds(b, { padding, maxZoom, duration: 0 });
  }

  setView(latlng, zoom) { this.map.flyTo({ center: ll(latlng), zoom: zoom ?? this.map.getZoom(), duration: 600 }); }
  bounds() { const b = this.map.getBounds(); return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }; }
  center() { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; }
  onClick(fn) { this.map.on('click', (e) => fn({ lat: e.lngLat.lat, lng: e.lngLat.lng })); }
  onMoveEnd(fn) { this.map.on('moveend', fn); }
  remove() { this.ro.disconnect(); this.map.remove(); }
}

function accent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
}

// ------------------------------------------------------------------ géométrie
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
  // Longitudes continues : la ligne franchit l'antiméridien sans traverser toute la carte
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360;
    while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360;
  }
  return pts;
}

export function destination(lat, lng, bearing, meters) {
  const R = 6371000, d = meters / R, b = toRad(bearing), p1 = toRad(lat), l1 = toRad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), toDeg(l2)];
}

/** Cône indiquant la direction de visée d'un point de vue. */
export function conePolygon(lat, lng, bearing, { radius = 600, spread = 35 } = {}) {
  const pts = [[lat, lng]];
  for (let a = bearing - spread; a <= bearing + spread; a += 5) pts.push(destination(lat, lng, a, radius));
  pts.push([lat, lng]);
  return pts;
}

export function haversineKm(a, b) {
  const R = 6371.0088, dp = toRad(b[0] - a[0]), dl = toRad(b[1] - a[1]);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const PLANE_PATH = 'M12 2c.7 0 1.2.9 1.2 2v5.2l7.3 4.3c.3.2.5.5.5.9v1.3l-7.8-2.4v4.3l2 1.5v1.4l-3.2-.9-3.2.9v-1.4l2-1.5v-4.3L3 15.7v-1.3c0-.4.2-.7.5-.9l7.3-4.3V4c0-1.1.5-2 1.2-2z';

/** Icône d'avion rendue en ImageData pour une couche symbole (rotation gérée par le GPU). */
export function planeImage(color, px = 56) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.scale(px / 24, px / 24);
  const p = new Path2D(PLANE_PATH);
  g.lineJoin = 'round';
  g.lineWidth = 1.4;
  g.strokeStyle = '#ffffff';
  g.stroke(p);
  g.fillStyle = color;
  g.fill(p);
  return g.getImageData(0, 0, px, px);
}
