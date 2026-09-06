/**
 * IndexedDB in about a hundred lines: the durable side of offline canvassing.
 *
 * WHY not localStorage. A recorded door is field data that has to survive the phone being locked,
 * the tab being evicted while the volunteer is in a driveway, and the app being reopened an hour
 * later on the next concession road. localStorage is synchronous — it would block the thumb tap
 * that records the door — holds strings only, and shares a ~5 MB origin budget that one turf of
 * 300 doors with voter names would eat most of. IndexedDB is asynchronous, structured and roomy.
 *
 * WHY no library (idb, dexie). Three object stores and five operations do not justify a dependency
 * on the one screen whose whole point is working on one bar of rural LTE.
 *
 * WHY a memory fallback. Safari in private browsing, and some embedded webviews, refuse to open a
 * database at all. Losing the door the volunteer is standing at because the browser is fussy is
 * worse than losing it on a reload, so the queue keeps working in memory — and says so, loudly, in
 * the sync panel, because "saved" would then be a lie past the next reload.
 */

export const OUTBOX = 'outbox';
export const TURF_CACHE = 'turf_cache';
export const META = 'meta';
/**
 * Sign photos taken before their sign existed on the server (offline/photoQueue.ts).
 *
 * WHY its own store rather than rows in the outbox: these hold image blobs, they are uploaded
 * multipart rather than as JSON, and they are keyed by the sign's `client_id` because that is the
 * only identifier that exists at the moment the shutter is pressed. IndexedDB stores a Blob
 * natively, which is the other half of why this data never went anywhere near localStorage.
 */
export const PENDING_PHOTOS = 'pending_photos';
export type StoreName = typeof OUTBOX | typeof TURF_CACHE | typeof META | typeof PENDING_PHOTOS;

const DB_NAME = 'mc-canvass-field';
// v2 adds `pending_photos`. onupgradeneeded creates whatever is missing, so a phone already holding
// a v1 queue keeps every queued door across the upgrade.
const DB_VERSION = 2;
const STORES: StoreName[] = [OUTBOX, TURF_CACHE, META, PENDING_PHOTOS];

/** Each store is keyed by an in-object field, so a put is an upsert with no separate key argument. */
const KEY_PATH: Record<StoreName, string> = {
  [OUTBOX]: 'id',
  [TURF_CACHE]: 'turf_id',
  [META]: 'key',
  [PENDING_PHOTOS]: 'id',
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
let memoryOnly = false;
const memory = new Map<StoreName, Map<string, unknown>>();

/** True once anything has forced the in-memory fallback — surfaced to the volunteer, never hidden. */
export const isMemoryOnly = (): boolean => memoryOnly;

function mem(store: StoreName): Map<string, unknown> {
  let m = memory.get(store);
  if (!m) {
    m = new Map();
    memory.set(store, m);
  }
  return m;
}

function fallback(): null {
  memoryOnly = true;
  return null;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(fallback());
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(fallback());
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEY_PATH[s] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(fallback());
    // Another tab holding an older version blocks the upgrade; do not sit there waiting for it.
    req.onblocked = () => resolve(fallback());
  });
  return dbPromise;
}

function exec<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let req: IDBRequest;
    try {
      req = action(db.transaction(store, mode).objectStore(store));
    } catch (err) {
      reject(err instanceof Error ? err : new Error('IndexedDB transaction failed'));
      return;
    }
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (db) {
    try {
      return await exec<T[]>(db, store, 'readonly', (s) => s.getAll());
    } catch {
      memoryOnly = true;
    }
  }
  return [...mem(store).values()] as T[];
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb();
  if (db) {
    try {
      return await exec<T | undefined>(db, store, 'readonly', (s) => s.get(key));
    } catch {
      memoryOnly = true;
    }
  }
  return mem(store).get(key) as T | undefined;
}

export async function idbPut<T extends object>(store: StoreName, value: T): Promise<void> {
  const key = String((value as Record<string, unknown>)[KEY_PATH[store]]);
  const db = await openDb();
  if (db) {
    try {
      await exec<IDBValidKey>(db, store, 'readwrite', (s) => s.put(value));
      return;
    } catch {
      memoryOnly = true;
    }
  }
  mem(store).set(key, value);
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb();
  if (db) {
    try {
      await exec<undefined>(db, store, 'readwrite', (s) => s.delete(key));
      return;
    } catch {
      memoryOnly = true;
    }
  }
  mem(store).delete(key);
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  if (db) {
    try {
      await exec<undefined>(db, store, 'readwrite', (s) => s.clear());
    } catch {
      memoryOnly = true;
    }
  }
  mem(store).clear();
}
