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
      subsequent call inheriting one dead promise. NOR IS A CLOSED ONE (audit
      round 3, player-rest-2): the browser can close a connection it opened
      successfully (WebKit's "Connection to Indexed Database server lost" after
      a background, "Clear site data"), after which every `transaction()` throws
      InvalidStateError. `idbConnection` forgets the handle on `close` and
      `versionchange`, and `withStore` retries once on a fresh connection.
      `event-log.js` shares both rather than keeping a copy.

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
/** How long one transaction may stay open before it is abandoned (audit round
    3, player-rest-1). WKWebView can leave a transaction that never fires
    complete, error or abort after the app has been backgrounded (client.js
    records it), and DurableStore runs every durable write on one serial queue,
    so one silent transaction used to stall them all, the vault's copy of the
    auth token included. On the deadline the transaction is aborted, the call
    rejects with a TimeoutError (a fault the store records), and the connection
    is dropped so the next call opens a fresh one. */
export const IDB_TX_DEADLINE_MS = 5000;

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
  txDeadlineMs = IDB_TX_DEADLINE_MS,
} = {}) {
  const factory = factoryIn ?? (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!factory || typeof factory.open !== "function") return null;

  const open = idbConnection(() => openDb(factory, dbName, version, storeName));
  const txOpts = { deadlineMs: txDeadlineMs };

  return {
    name: "idb",
    sync: false,
    durable: true,

    /** Every owned row, as a Map. The filter is in JS because the namespace is
        tiny and a key range would be one more thing to get subtly wrong. */
    async readAll(prefix) {
      const rows = await withStore(open, storeName, "readonly", (s) => s.getAll(), txOpts);
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
        s.put({ key, value, updated_at: new Date().toISOString() }), txOpts);
    },

    async remove(key) {
      await withStore(open, storeName, "readwrite", (s) => s.delete(key), txOpts);
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
 * A memoised connection (hazard 2): `open()` resolves the one live IDBDatabase,
 * and `open.drop()` forgets it. A failed open is never cached, and neither is a
 * connection the browser has since closed: `close` and `versionchange` drop it,
 * so the next call opens a fresh one instead of every call throwing
 * InvalidStateError for the rest of the page's life (audit round 3,
 * player-rest-2). Shared with `event-log.js`.
 *
 * @param {() => Promise<IDBDatabase>} openDb
 * @returns {(() => Promise<IDBDatabase>) & {drop: () => void}}
 */
export function idbConnection(openDb) {
  let dbPromise = null;
  const forget = (p) => { if (dbPromise === p) dbPromise = null; };
  const open = () => {
    if (!dbPromise) {
      const p = openDb().then((db) => {
        try {
          db.onclose = () => forget(p);
          db.onversionchange = () => {
            try { db.close(); } catch (_) { /* already closing */ }
            forget(p);
          };
        } catch (_) { /* a handle that refuses handlers is still a handle */ }
        return db;
      }, (err) => {
        forget(p);   // hazard 2: never cache a failure as the answer
        throw err;
      });
      dbPromise = p;
    }
    return dbPromise;
  };
  open.drop = () => { dbPromise = null; };
  return open;
}

/**
 * Run one transaction and resolve with its (last) request's result AFTER the
 * transaction commits — see hazard 1 in the header for why the handlers are
 * wired before `fn` runs. `open` is an `idbConnection`.
 *
 * Bounded by `deadlineMs` (player-rest-1): a transaction that has not settled
 * by then is aborted and the connection dropped. A connection the browser
 * closed (`transaction()` throws InvalidStateError) is dropped and the call
 * retried ONCE on a fresh one (player-rest-2).
 */
export function withStore(open, storeName, mode, fn, { deadlineMs = IDB_TX_DEADLINE_MS } = {}, retried = false) {
  return open().then((db) => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(storeName, mode); } catch (err) {
      if (err?.name === "InvalidStateError" && typeof open.drop === "function") {
        open.drop();
        if (!retried) { withStore(open, storeName, mode, fn, { deadlineMs }, true).then(resolve, reject); return; }
      }
      reject(err);
      return;
    }
    let result;
    /* One settlement, whichever comes first: the transaction's own events or
       the deadline (player-rest-1). */
    let timer = null;
    let settled = false;
    const settle = (fn2, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn2(v);
    };
    tx.oncomplete = () => settle(resolve, result);
    tx.onerror = () => settle(reject, tx.error || new Error("indexedDB transaction failed"));
    tx.onabort = () => settle(reject, tx.error || new Error("indexedDB transaction aborted"));
    if (deadlineMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settle(reject, Object.assign(new Error(`indexedDB transaction did not settle within ${deadlineMs} ms`), { name: "TimeoutError" }));
        try { tx.abort(); } catch (_) { /* already finished, or the connection is gone */ }
        if (typeof open.drop === "function") open.drop();
      }, deadlineMs);
    }
    let req;
    try { req = fn(tx.objectStore(storeName)); } catch (err) { settle(reject, err); return; }
    if (req) req.onsuccess = () => { result = req.result; };
    // No per-request onerror: a failed request aborts the transaction, and
    // tx.onabort/onerror is the single place that rejection belongs.
  }));
}
