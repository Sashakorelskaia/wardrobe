// Everything lives in this browser. No server, no account, no upload.

const DB_NAME = "wardrobe";
const DB_VERSION = 1;
const STORE = "items";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const result = fn(store);
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
      })
  );
}

export function allItems() {
  return tx("readonly", (s) => s.getAll());
}

export function putItem(item) {
  return tx("readwrite", (s) => s.put(item));
}

export function getItem(id) {
  return tx("readonly", (s) => s.get(id));
}

export function deleteItem(id) {
  return tx("readwrite", (s) => s.delete(id));
}

export function newId() {
  return (crypto.randomUUID?.() || String(Date.now() + Math.random())).replace(/-/g, "").slice(0, 12);
}
