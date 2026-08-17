/* The IndexedDB tier for DurableStore (#40).

   A deliberately boring key/value adapter: one database, one object store, one
   record per `cp_` key. No indexes, no versions beyond the first, no schema to
   migrate — the whole namespace is a few dozen small strings, so `getAll()` and
   a JS filter is both simpler and faster than anything cleverer.

   ── Why it is its own file ────────────────────────────────────────────────
   `durable-store.js` holds the merge, migration and fault logic, which is the
   part that can lose a listener's place and therefore the part that has to be
   exhaustively tested. This file is the adapter: callback-to-promise plumbing
   and nothing else. Splitting them keeps the store testable with no IndexedDB
   at all, and keeps the plumbing's real hazards in one small place.

   ── Two hazards this file exists to get right ─────────────────────────────
   1. TRANSACTION HANDLERS ARE ASSIGNED BEFORE THE REQUEST IS ISSUED. An
      IndexedDB transaction auto-commits once the event loop has no more
      requests pending against it. Awaiting a request's success and only THEN
      assigning `tx.oncomplete` is a race the transaction usually wins, and the
      promise never settles — a hang, not an error. So `withStore` wires
      `oncomplete`/`onerror`/`onabort` first and reads the request's result into
      a closure.
   2. A FAILED OPEN IS NOT CACHED AS A SUCCESS. Private-mode Safari, a blocked
      upgrade and a corrupted database all reject `open()`. The memoised promise
      is cleared on rejection so a later write can try again, rather than every
      subsequent call inheriting one dead promise.

   ── What is verified and what is not ──────────────────────────────────────
   `idb-tier.test.js` drives this against a hand-rolled fake `indexedDB` (no
   dependencies — root package.json). That proves the CALL SEQUENCE, the prefix
   filtering, the promise plumbing and every error path. It does not and cannot
   prove real browser semantics: quota behaviour, eviction, and the durability of
   a committed transaction on iOS are // AUDIT: unverified here and are only
   observable in a browser.
*/

export const DB_NAME = "foray";
export const DB_VERSION = 1;
export const STORE_NAME = "kv";

/**
 * Build an async DurableStore tier over IndexedDB, or return `null` when
 * IndexedDB is unavailable.
 *
 * Returning null rather than a stub that swallows is the point: the store's tier
 * list drops nulls, so an environment with no IndexedDB gets a localStorage-only
 * store whose `health()` reports `durableTiers: []` — an honest "this listener
 * has no durable tier" instead of a tier that appears to work.
 *
 * @param {object} [opts]
 * @param {IDBFactory} [opts.indexedDB]  injected; falls back to the global
 * @param {string} [opts.dbName]
 * @param {string} [opts.storeName]
 * @param {number} [opts.version]
 * @returns {import("./durable-store.js").DurableTier | null}
 */
export function makeIdbTier({
  indexedDB: factoryIn = null,
  dbName = DB_NAME,
  storeName = STORE_NAME,
  version = DB_VERSION,
} = {}) {
  const factory = factoryIn ?? (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!factory || typeof factory.open !== "function") return null;

  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = openDb(factory, dbName, version, storeName).catch((err) => {
        dbPromise = null;   // hazard 2: never cache a failure as the answer
        throw err;
      });
    }
    return dbPromise;
  };

  return {
    name: "idb",
    sync: false,
    durable: true,

    /** Every owned row, as a Map. The filter is in JS because the namespace is
        tiny and a key range would be one more thing to get subtly wrong. */
    async readAll(prefix) {
      const rows = await withStore(open, storeName, "readonly", (s) => s.getAll());
      const out = new Map();
      for (const row of rows ?? []) {
        if (!row || typeof row.key !== "string") continue;
        if (prefix && !row.key.startsWith(prefix)) continue;
        if (typeof row.value !== "string") continue;
        out.set(row.key, row.value);
      }
      return out;
    },

    /** `updated_at` is the tier's own bookkeeping, not the record's — the
        record's own timestamp is inside `value` and is what conflict resolution
        reads. This one is for a human looking at the database. */
    async write(key, value) {
      await withStore(open, storeName, "readwrite", (s) =>
        s.put({ key, value, updated_at: new Date().toISOString() }));
    },

    async remove(key) {
      await withStore(open, storeName, "readwrite", (s) => s.delete(key));
    },
  };
}

function openDb(factory, name, version, storeName) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = factory.open(name, version); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
      } catch (err) { reject(err); }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    // A tab holding an older version open blocks the upgrade indefinitely.
    // Rejecting means one lost durable write and a working localStorage tier,
    // which is strictly better than a promise that never settles.
    req.onblocked = () => reject(new Error("indexedDB open blocked by another tab"));
  });
}

/**
 * Run one request inside one transaction and resolve with its result AFTER the
 * transaction commits — see hazard 1 in the header for why the handlers are
 * wired before `fn` runs.
 */
function withStore(open, storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(storeName, mode); } catch (err) { reject(err); return; }
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("indexedDB transaction aborted"));
    let req;
    try { req = fn(tx.objectStore(storeName)); } catch (err) { reject(err); return; }
    if (req) req.onsuccess = () => { result = req.result; };
    // No per-request onerror: a failed request aborts the transaction, and
    // tx.onabort/onerror is the single place that rejection belongs.
  }));
}
