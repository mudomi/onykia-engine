const DEFAULT_DB_NAME = 'onykia-cache';
const DEFAULT_STORE_NAME = 'bytes';

export interface BytesCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export function indexedDbCache(
  dbName: string = DEFAULT_DB_NAME,
  storeName: string = DEFAULT_STORE_NAME,
): BytesCache {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) dbPromise = openDb(dbName, storeName);
    return dbPromise;
  };

  return {
    async get(key) {
      try {
        const bytes = await read(await db(), storeName, key);
        return bytes ?? null;
      } catch (err) {
        console.warn('[onykia] cache read failed:', err);
        return null;
      }
    },

    async put(key, bytes) {
      try {
        await write(await db(), storeName, key, bytes);
      } catch (err) {
        console.warn('[onykia] cache write failed:', err);
      }
    },
  };
}

export function withCache<A extends unknown[]>(
  loader: (...args: A) => Promise<Uint8Array | ArrayBuffer>,
  cache: BytesCache,
  keyOf: (...args: A) => string,
): (...args: A) => Promise<Uint8Array> {
  return async (...args: A) => {
    const key = keyOf(...args);

    const cached = await cache.get(key);
    if (cached) return cached;

    const fresh = toU8(await loader(...args));
    await cache.put(key, fresh);
    return fresh;
  };
}

function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function read(db: IDBDatabase, storeName: string, key: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
    request.onerror = () => reject(request.error);
  });
}

function write(db: IDBDatabase, storeName: string, key: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(bytes, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function toU8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
