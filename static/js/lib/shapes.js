// Silhouettes d'appareils vues de dessus (nez vers le haut) et classification par code OACI.
// Utilisées par le radar (icônes pivotées par MapLibre) et par les cartes de partage sans photo.

export const CLASSES = ['jumbo', 'wide', 'narrow', 'regional', 'turboprop', 'bizjet', 'light', 'heli', 'fighter', 'glider', 'balloon', 'drone', 'unknown'];
const SCALE = { jumbo: 1.25, wide: 1.13, narrow: 1, regional: 0.9, turboprop: 0.92, bizjet: 0.8, light: 0.72, heli: 0.82,
  fighter: 0.86, glider: 0.78, balloon: 0.7, drone: 0.76, unknown: 0.88 };

let typesPromise = null;
let TYPES = {};
/** Charge la table des types (code OACI → [nom, classe]). */
export function loadTypes() {
  if (!typesPromise) {
    typesPromise = fetch('/static/data/aircraft_types.json').then((r) => r.json()).then((d) => (TYPES = d.types || {})).catch(() => ({}));
  }
  return typesPromise;
}
/** Liste des types connus (pour les listes de saisie assistée). */
export const typeList = () => Object.entries(TYPES).map(([code, e]) => ({ code, name: e[0] }));
export const typeName = (code) => (code && TYPES[code.toUpperCase()]?.[0]) || null;

const DESC = [
  [/helicop|hélicop|\bH1[2-7]\d\b|robinson|\bAW1\d\d/i, 'heli'], [/glider|planeur|discus|ventus/i, 'glider'],
  [/balloon|ballon|airship/i, 'balloon'], [/A380|747|A340|An-?124|C-?17\b/i, 'jumbo'],
  [/A33\d|A35\d|7[6-8]7|MD-?11|A300|A310|777/i, 'wide'], [/A3[12]\d|A220|737|757|717|C919/i, 'narrow'],
  [/CRJ|ERJ|E1[79]\d|Fokker|Avro RJ|146|Superjet/i, 'regional'],
  [/ATR|Dash ?8|DHC|Saab 340|King Air|Caravan|PC-?12|TBM|Hercules|A400/i, 'turboprop'],
  [/Citation|Challenger|Global|Gulfstream|Falcon|Learjet|Phenom|Legacy|PC-?24|Hawker/i, 'bizjet'],
  [/Rafale|Mirage|F-?1[568]|F-?35|Eurofighter|Tornado|Alpha ?Jet|Gripen/i, 'fighter'],
  [/Cessna 1\d\d|Piper|Robin|Cirrus|Diamond|Mooney|Bonanza|Socata|Jodel/i, 'light'],
];
export function classify(code, desc) {
  const e = code && TYPES[code.toUpperCase()];
  if (e) return e[1];
  for (const [rx, c] of DESC) if (desc && rx.test(desc)) return c;
  return 'unknown';
}

// ------------------------------------------------------------------ géométrie (repère -50…50, nez en y négatif)
function fuselage(p, len, w, noseRound = 0.9) {
  const t = -len / 2, b = len / 2, r = w / 2;
  p.moveTo(0, t);
  p.bezierCurveTo(r * noseRound, t, r, t + w * 0.9, r, t + w * 1.6);
  p.lineTo(r * 0.9, b - w * 1.4);
  p.quadraticCurveTo(r * 0.5, b, 0, b);
  p.quadraticCurveTo(-r * 0.5, b, -r * 0.9, b - w * 1.4);
  p.lineTo(-r, t + w * 1.6);
  p.bezierCurveTo(-r, t + w * 0.9, -r * noseRound, t, 0, t);
  p.closePath();
}
/** Aile en flèche symétrique : racine en (±rootX, y), bord d'attaque reculé de sweep au saumon. */
function wings(p, { y, span, root, tip, sweep, rootX = 3 }) {
  const s = span / 2;
  for (const k of [1, -1]) {
    p.moveTo(k * rootX, y);
    p.lineTo(k * s, y + sweep);
    p.lineTo(k * s, y + sweep + tip);
    p.lineTo(k * rootX, y + root);
    p.closePath();
  }
}
function engine(p, x, y, w, l) { p.roundRect(x - w / 2, y, w, l, w / 2); }

function shapeOf(cls) {
  const body = new Path2D(), extra = new Path2D();
  let rotor = null;
  switch (cls) {
    case 'jumbo':
      fuselage(body, 92, 13); wings(body, { y: -10, span: 98, root: 30, tip: 8, sweep: 30, rootX: 5 });
      wings(body, { y: 30, span: 38, root: 13, tip: 5, sweep: 10, rootX: 4 });
      for (const x of [-34, -19, 19, 34]) engine(extra, x, -6 + Math.abs(x) * 0.42, 6, 12);
      break;
    case 'wide':
      fuselage(body, 94, 12); wings(body, { y: -8, span: 96, root: 26, tip: 7, sweep: 28, rootX: 5 });
      wings(body, { y: 32, span: 36, root: 12, tip: 5, sweep: 9, rootX: 4 });
      for (const x of [-21, 21]) engine(extra, x, 0, 8, 15);
      break;
    case 'narrow':
    case 'unknown':
      fuselage(body, 90, 10); wings(body, { y: -4, span: 86, root: 21, tip: 6, sweep: 22, rootX: 4 });
      wings(body, { y: 33, span: 32, root: 11, tip: 4, sweep: 8, rootX: 3 });
      for (const x of [-17, 17]) engine(extra, x, 1, 7, 13);
      break;
    case 'regional':
      fuselage(body, 86, 9); wings(body, { y: -2, span: 74, root: 17, tip: 5, sweep: 16, rootX: 4 });
      wings(body, { y: 40, span: 28, root: 8, tip: 4, sweep: 5, rootX: 2 });
      for (const x of [-8.5, 8.5]) engine(extra, x, 18, 6, 14);
      break;
    case 'bizjet':
      fuselage(body, 80, 9); wings(body, { y: 0, span: 70, root: 16, tip: 5, sweep: 17, rootX: 4 });
      wings(body, { y: 36, span: 26, root: 8, tip: 4, sweep: 6, rootX: 2 });
      for (const x of [-8, 8]) engine(extra, x, 16, 6, 13);
      break;
    case 'turboprop':
      fuselage(body, 84, 9.5); wings(body, { y: -8, span: 92, root: 12, tip: 7, sweep: 1, rootX: 4 });
      wings(body, { y: 34, span: 32, root: 9, tip: 6, sweep: 2, rootX: 3 });
      for (const x of [-17, 17]) { engine(extra, x, -14, 7, 18); extra.rect(x - 9, -15.5, 18, 1.6); }
      break;
    case 'light':
      fuselage(body, 70, 9, 1); wings(body, { y: -12, span: 92, root: 13, tip: 11, sweep: 0, rootX: 4 });
      wings(body, { y: 26, span: 34, root: 9, tip: 7, sweep: 1, rootX: 2 });
      extra.rect(-11, -36.5, 22, 1.8);
      break;
    case 'glider':
      fuselage(body, 64, 6, 1); wings(body, { y: -10, span: 100, root: 8, tip: 4, sweep: 0, rootX: 3 });
      wings(body, { y: 28, span: 24, root: 5, tip: 4, sweep: 0, rootX: 1 });
      break;
    case 'fighter':
      fuselage(body, 88, 8, 0.6);
      body.moveTo(4, -8); body.lineTo(30, 22); body.lineTo(30, 28); body.lineTo(4, 26); body.closePath();
      body.moveTo(-4, -8); body.lineTo(-30, 22); body.lineTo(-30, 28); body.lineTo(-4, 26); body.closePath();
      wings(body, { y: -22, span: 22, root: 7, tip: 3, sweep: 4, rootX: 3 });
      break;
    case 'heli':
      body.ellipse(0, -6, 10, 18, 0, 0, Math.PI * 2);
      body.roundRect(-2, 8, 4, 36, 2);
      body.rect(-9, 40, 18, 3.5);
      rotor = new Path2D(); rotor.arc(0, -6, 42, 0, Math.PI * 2);
      extra.roundRect(-42, -7.2, 84, 2.4, 1.2);
      extra.roundRect(-1.2, -48, 2.4, 84, 1.2);
      break;
    case 'balloon':
      body.arc(0, -6, 32, 0, Math.PI * 2);
      extra.rect(-6, 28, 12, 10);
      break;
    case 'drone':
      fuselage(body, 66, 8, 1); wings(body, { y: -6, span: 96, root: 9, tip: 5, sweep: 2, rootX: 3 });
      body.moveTo(2, 24); body.lineTo(16, 34); body.lineTo(16, 38); body.lineTo(2, 31); body.closePath();
      body.moveTo(-2, 24); body.lineTo(-16, 34); body.lineTo(-16, 38); body.lineTo(-2, 31); body.closePath();
      break;
    default:
      return shapeOf('unknown');
  }
  return { body, extra, rotor };
}

/** Dessine une silhouette centrée en (0,0), nez vers le haut, dans une boîte de `size` px. */
export function drawAircraft(ctx, cls, size, { fill = '#2563eb', outline = '#ffffff', outlineWidth = 2.2, alpha = 1 } = {}) {
  const sh = shapeOf(CLASSES.includes(cls) ? cls : 'unknown');
  const k = (size / 100) * (SCALE[cls] || 1);
  ctx.save();
  ctx.scale(k, k);
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  if (sh.rotor) {
    if (fill) { ctx.fillStyle = fill; ctx.globalAlpha = alpha * 0.14; ctx.fill(sh.rotor); ctx.globalAlpha = alpha; }
    else if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = outlineWidth / k; ctx.setLineDash([6 / k, 5 / k]); ctx.stroke(sh.rotor); ctx.setLineDash([]); }
  }
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = outlineWidth / k;
    ctx.stroke(sh.body); ctx.stroke(sh.extra);
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(sh.body);
    ctx.fill(sh.extra);
  }
  ctx.restore();
}

/** Image d'icône pour une couche symbole MapLibre. */
export function aircraftImage(cls, color, px = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.translate(px / 2, px / 2);
  drawAircraft(g, cls, px * 0.86, { fill: color, outline: '#ffffff', outlineWidth: 3.2 });
  return g.getImageData(0, 0, px, px);
}

/** Petite silhouette en SVG-data URL pour l'interface (légende, listes). */
export function aircraftDataUrl(cls, color = 'currentColor', px = 40) {
  const c = document.createElement('canvas');
  const r = window.devicePixelRatio || 1;
  c.width = c.height = px * r;
  const g = c.getContext('2d');
  g.scale(r, r);
  g.translate(px / 2, px / 2);
  drawAircraft(g, cls, px * 0.9, { fill: color, outline: null });
  return c.toDataURL('image/png');
}
