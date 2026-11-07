// Client HTTP minimal pour l'API Contrail
export class ApiError extends Error {
  constructor(status, detail, offline = false) {
    super(typeof detail === 'string' ? detail : (detail?.code || `HTTP ${status}`));
    this.status = status;
    this.detail = detail;
    this.offline = offline;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body, form, signal, raw = false, query, onProgress } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      qs.set(k, v === true ? 'true' : v);
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const opts = { method, signal, credentials: 'same-origin', headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  if (form && onProgress && typeof XMLHttpRequest !== 'undefined') return xhrUpload(url, method, form, onProgress, signal);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'offline', true);
  }
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'auth_required');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res;
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  else data = await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? data);
  // Réponse servie depuis le cache du service worker en mode hors-ligne
  if (res.headers.get('x-contrail-cache') === 'offline' && data && typeof data === 'object') {
    Object.defineProperty(data, '__offline', { value: true });
  }
  return data;
}

export const get = (p, query) => api(p, { query });
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

export function mediaUrl(kind, rel) {
  return rel ? `/media/${kind}/${rel.split('/').map(encodeURIComponent).join('/')}` : '';
}

// Envoi de fichiers avec progression (fetch n'expose pas la progression de l'envoi) : onProgress(0..1, 'upload' | 'processing')
function xhrUpload(url, method, form, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total, 'upload'); };
    x.upload.onload = () => onProgress(1, 'processing');
    x.onerror = () => reject(new ApiError(0, 'offline', true));
    x.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    x.onload = () => {
      let data = null;
      try { data = (x.getResponseHeader('content-type') || '').includes('json') ? JSON.parse(x.responseText) : x.responseText; } catch { data = x.responseText; }
      if (x.status === 401) { onUnauthorized(); return reject(new ApiError(401, 'auth_required')); }
      if (x.status >= 200 && x.status < 300) return resolve(data);
      reject(new ApiError(x.status, data?.detail ?? data));
    };
    signal?.addEventListener('abort', () => x.abort());
    x.send(form);
  });
}
