/**
 * IndexedDB access. Background context only.
 *
 * Deliberately not reachable from the content script: a content script's
 * IndexedDB belongs to the *page's* origin, so writing there would scatter the
 * archive across every site visited instead of keeping one store in the
 * extension's own origin.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FA = root.FA || {};
  root.FA.db = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Deliberately unchanged when the project was renamed to Formistory: the
  // database name is invisible to users, and renaming it would orphan every
  // record already on disk.
  const DB_NAME = "form-archive";
  // v2: one-time wipe. The v1 build captured media/social noise (volume values,
  // like toggles); rather than sift real forms out of that, the store is cleared
  // once on upgrade and repopulated only by the corrected capture gate.
  const DB_VERSION = 2;
  const STORE = "submissions";

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("by_origin", "origin");
          store.createIndex("by_updatedAt", "updatedAt");
          store.createIndex("by_signature", "formSignature");
        } else if (event.oldVersion < 2) {
          // Upgrading from the noisy v1 store: clear it once, in the same
          // upgrade transaction, so the first read after upgrade is already clean.
          event.target.transaction.objectStore(STORE).clear();
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      // Fires instead of success/error when another context still holds an older
      // connection — e.g. a viewer tab open during the v1→v2 upgrade. Without
      // this the promise never settles and every later call hangs forever.
      req.onblocked = () =>
        reject(new Error("formistory: database upgrade blocked by another open tab"));
    }).catch((err) => {
      // Allow a retry rather than caching a permanently rejected promise.
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          let result;
          try {
            result = fn(store);
          } catch (err) {
            reject(err);
            return;
          }
          // Transactions are atomic, so a service worker dying mid-write loses the
          // whole delta rather than half of it.
          // An IDBRequest whose result is undefined (a missing key, or a void
          // operation like clear/delete) must resolve to undefined, not to the
          // request object — a truthy value where the caller expects a miss.
          t.oncomplete = () =>
            resolve(result && typeof result === "object" && "result" in result ? result.result : result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  const put = (submission) => tx("readwrite", (s) => s.put(submission));
  const get = (id) => tx("readonly", (s) => s.get(id));
  const remove = (id) => tx("readwrite", (s) => s.delete(id));
  const clear = () => tx("readwrite", (s) => s.clear());
  const count = () => tx("readonly", (s) => s.count());

  function all({ limit = 200 } = {}) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const out = [];
          const t = db.transaction(STORE, "readonly");
          // A transaction can abort (quota, or a versionchange closing the
          // connection) without the request ever erroring; without these the
          // promise never settles and the viewer waits forever.
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
          // Newest first.
          const req = t.objectStore(STORE).index("by_updatedAt").openCursor(null, "prev");
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor || out.length >= limit) {
              resolve(out);
              return;
            }
            out.push(cursor.value);
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        })
    );
  }

  return { open, put, get, all, remove, clear, count, DB_NAME, STORE };
});
