// Analyse d'une photo en deux temps : EXIF (quasi instantané) puis lecture de l'immatriculation (OCR, plus lente).
import { api } from '../api.js';

const HEAD = 256 * 1024;   // l'EXIF d'un JPEG tient dans les premiers Ko : inutile d'envoyer toute la photo

// Phase 1 : EXIF + aéroport le plus proche. Pour un JPEG on n'envoie que l'en-tête du fichier.
export async function analyzeExif(file) {
  const send = (blob) => { const fd = new FormData(); fd.append('image', blob, file.name || 'photo.jpg'); return api('/api/media/analyze', { method: 'POST', form: fd, query: { ocr: 'false' } }); };
  const jpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name || '');
  if (jpeg && file.size > HEAD) {
    try {
      const r = await send(file.slice(0, HEAD, 'image/jpeg'));
      if (r.exif && Object.keys(r.exif).length) return r;
    } catch { /* en-tête inexploitable : on retente avec le fichier entier */ }
  }
  return send(file);
}

// Photo réduite (2000 px, JPEG) : suffisante pour l'OCR, bien plus rapide à envoyer. Repli : fichier d'origine (HEIC...).
async function shrink(file, max = 2000) {
  try {
    if (file.size < 600 * 1024) return file;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.88));
    return blob || file;
  } catch { return file; }
}

// Phase 2 : lecture de l'immatriculation (classement favorisé par l'aéroport connu).
export async function analyzeOcr(file, airport = '') {
  const blob = await shrink(file);
  const fd = new FormData(); fd.append('image', blob, 'ocr.jpg');
  return api('/api/media/analyze', { method: 'POST', form: fd, query: { ocr: true, airport } });
}
