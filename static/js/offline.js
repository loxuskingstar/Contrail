// Brouillons hors-ligne (IndexedDB) et synchronisation au retour du réseau
import { api } from './api.js';

const DB_NAME = 'contrail';
const STORE = 'drafts';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'uuid' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const res = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(res?.result ?? res);
    t.onerror = () => reject(t.error);
  });
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function saveDraft({ data, image, audio }) {
  const draft = { uuid: data.draft_uuid || uuid(), data, image: image || null, audio: audio || null, created: new Date().toISOString(), error: null };
  draft.data.draft_uuid = draft.uuid;
  await tx('readwrite', (s) => s.put(draft));
  notify();
  return draft;
}

export async function listDrafts() {
  return (await tx('readonly', (s) => s.getAll())) || [];
}

export async function deleteDraft(id) {
  await tx('readwrite', (s) => s.delete(id));
  notify();
}

export async function countDrafts() {
  return (await tx('readonly', (s) => s.count())) || 0;
}

let syncing = false;
export async function syncDrafts({ force = true } = {}) {
  if (syncing || !navigator.onLine) return { synced: 0, failed: 0 };
  syncing = true;
  let synced = 0, failed = 0;
  try {
    for (const d of await listDrafts()) {
      const fd = new FormData();
      fd.append('data', JSON.stringify(d.data));
      if (d.image) fd.append('image', d.image, d.image.name || 'photo.jpg');
      if (d.audio) fd.append('audio', d.audio, d.audio.name || 'audio.webm');
      try {
        await api('/api/spots', { method: 'POST', form: fd, query: { force } });
        await deleteDraft(d.uuid);
        synced++;
      } catch (e) {
        if (e.offline) break;
        failed++;
        d.error = typeof e.detail === 'string' ? e.detail : (e.detail?.code || 'error');
        await tx('readwrite', (s) => s.put(d));
      }
    }
  } finally {
    syncing = false;
    notify();
  }
  return { synced, failed };
}

function notify() {
  countDrafts().then((n) => window.dispatchEvent(new CustomEvent('drafts-changed', { detail: n }))).catch(() => {});
}
