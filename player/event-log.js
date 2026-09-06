/* player/event-log.js — the outbound telemetry queue, off the synchronous
   localStorage rewrite (M3).

   ── What this replaces ────────────────────────────────────────────────────
   `app.js`'s `logEvent()` used to read the WHOLE `cp_events` array out of
   localStorage, push one row, `JSON.stringify` the lot back — every call, on
   whatever thread called it, up to 5,000 rows. That is an O(n) synchronous
   rewrite on the hot path (a thumb, a pick, a segment boundary), and it grows
   without bound as the buffer fills. This module is a queue instead: `append()`
   returns before anything durable happens, the actual write is batched and
   deferred off the calling stack, and rows live in IndexedDB — one row per
   record, not one blob holding all of them.

   ── Shape ──────────────────────────────────────────────────────────────────
   One IndexedDB database (`foray_events`), one object store (`events`), keyed
   on an autoincrementing `id`. Deliberately its OWN database rather than a
   second object store bolted onto `player/idb-tier.js`'s `foray` database:
   that store is a key/value adapter for `cp_` keys (one row per key, keyPath
   `key`), and shoehorning a growing, autoincrementing event log into it would
   mean bumping that database's version and touching code this file has no
   business coupling to. Separate concern, separate database.

   ── The two ID spaces, and why they don't collide ─────────────────────────
   IndexedDB assigns real rows a NUMBER (the autoincrement key). The in-memory
   fallback ring (below) assigns its own counter, and prefixes it `"mem:N"` —
   a string, deliberately, so a caller holding a batch of ids from `unsynced()`
   can hand the same array straight to `markSynced()` without either space's
   numbers being mistaken for the other's. `typeof id === "number"` routes to
   IndexedDB; `typeof id === "string"` routes to the ring.

   ── Batching, not a synchronous write ─────────────────────────────────────
   `append()` pushes onto an in-memory buffer and schedules ONE flush
   (`requestIdleCallback` where it exists, `setTimeout` otherwise) rather than
   opening a transaction per call. A burst of appends inside one tick — a Foray
   boundary that fires `picked` and `session_shown` together — costs one flush,
   not two.

   ── The fallback, and why it is not decoration ────────────────────────────
   `player/idb-tier.js`'s header makes the same point about its own tier: a
   browser with no IndexedDB (or one whose quota is already exhausted) must not
   turn `logEvent` into a throw. So this module never lets a failure escape:
   a browser with no IndexedDB at all uses the ring buffer from the start: a
   browser whose IndexedDB write fails (quota, a blocked upgrade, private mode)
   catches that failure, records it in `health()`, and puts the batch that
   failed into the SAME ring buffer rather than dropping it — the event is not
   lost just because the durable tier had a bad moment. The ring is capped at
   `retention` rows, exactly like the durable cap below, so a browser stuck in
   the fallback forever still bounds its memory.

   ── Health, on the same convention as `durable-store.js` ──────────────────
   `player/durable-store.js`'s `health()` is the pattern this follows: a fault
   is recorded (never thrown), an `onFault` hook fires up to a budget so the app
   can log it once rather than loop, and `health()` is always readable — even
   with IndexedDB entirely dead — because it is assembled from memory. There is
   no `_inFault` reentrancy story to defend against here the way `durable-store`
   needs one for its own `onFault` writing back through the SAME store: this
   module's `onFault` is wired in `player/client.js` to `console.warn` only, not
   back through `logEvent`/`append`, so there is nothing to feed.

   ── What is verified and what is not ──────────────────────────────────────
   `event-log.test.js` drives this against a hand-rolled fake `IDBFactory`, in
   the same spirit as `idb-tier.test.js`'s (extended here with `add`/`get`,
   since this store is keyed on an autoincrement id rather than a fixed `key`).
   That proves the queueing, the retention cap, the quota-exhaustion fallback
   and the merge between the two id spaces. It does not and cannot prove real
   browser semantics — quota accounting, eviction, `requestIdleCallback`
   scheduling under load — which are only observable in a browser.
*/

export const DB_NAME = "foray_events";
export const DB_VERSION = 1;
export const STORE_NAME = "events";

/** The retention cap from the approved design (M3): the outbound queue is not
    resumable per-user state, so a lost row past this cap costs one telemetry
    point, never a listener's place. */
export const DEFAULT_RETENTION = 5000;

/** How long an `append()` burst is allowed to sit before it is flushed. Not
    zero: several `append()` calls in the same tick (a Foray boundary logging
    two rows together) should cost one transaction, not one each. */
const DEFAULT_FLUSH_DELAY_MS = 50;

/** Budget for `onFault` notifications — the same number and the same reason as
    `durable-store.js`'s `MAX_FAULTS`: a tier that fails on every call must not
    be allowed to call the app back on every call too. */
const MAX_FAULTS = 20;

function errText(err) {
  return err && err.message ? String(err.message) : String(err ?? "unknown error");
}

/**
 * Build the event queue, or a memory-only stand-in when IndexedDB is
 * unavailable. Never throws, and the object it returns never throws either —
 * see the header.
 *
 * @param {object} [opts]
 * @param {IDBFactory} [opts.indexedDB]  injected; falls back to the global.
 * @param {number} [opts.retention]  the durable + fallback row cap (5,000 per
 *   the approved design).
 * @param {number} [opts.flushDelayMs]  how long a batch of `append()` calls is
 *   allowed to coalesce before the deferred write.
 * @param {Function} [opts.onFault]  (fault, health) — for the app to log a
 *   failure once. Must not throw; if it does, the throw is swallowed the same
 *   way `durable-store.js`'s is.
 * @param {Function} [opts.now]  injected clock, ISO string. Defaults to
 *   `new Date().toISOString()`.
 * @param {Function} [opts.scheduleFlush]  injected scheduler for tests —
 *   `(fn) => void`, called once per pending batch. Defaults to
 *   `requestIdleCallback` where it exists, else `setTimeout(fn, flushDelayMs)`.
 */
export function createEventLog({
  indexedDB: factoryIn = null,
  retention = DEFAULT_RETENTION,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  onFault = null,
  now = () => new Date().toISOString(),
  scheduleFlush = null,
} = {}) {
  const factory = factoryIn ?? (typeof indexedDB !== "undefined" ? indexedDB : null);
  const hasIdb = Boolean(factory && typeof factory.open === "function");

  /* The fallback ring — see header. Always present, even when IndexedDB is
     healthy, because a mid-session failure has to land somewhere. */
  const ring = [];
  let nextRingId = 1;

  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = openDb(factory, DB_NAME, DB_VERSION, STORE_NAME).catch((err) => {
        dbPromise = null; // a failed open is not cached as the answer (idb-tier.js hazard 2)
        throw err;
      });
    }
    return dbPromise;
  };

  const pendingRows = [];
  let flushTimer = null;
  const faults = [];
  let notified = 0;
  let inFault = false;

  /* Retention enforcement (idb path) is triggered by an ESTIMATE, not a full
     scan on every flush: `pruneNow()` does a `getAll()` over the store, and
     Codex's round-2 review correctly called out that scanning on every flush
     turns each `unsynced()`/`trySyncEvents()` call into two full scans (one
     from the prune, one from the caller's own read) even when nothing needed
     deleting. Round-3 then correctly called out that a naive write-count
     throttle (prune every N writes) lets the store overshoot the cap by up to
     N-1 rows on ordinary small flushes, AND skips the check entirely when
     writes are landing in the ring (an idb failure) rather than idb — so a
     store already near the cap could grow toward roughly DOUBLE it while
     quota errors kept diverting writes to the ring.
     The fix: track a running estimate of the COMBINED size (idb rows this
     session is confident about, plus the ring, which self-caps on every push
     — see `pushRing`) and only pay for a real scan when that estimate crosses
     `cap + PRUNE_MARGIN`. Because the estimate only ever UNDER-counts idb
     rows between scans (ring pushes and the first-flush baseline are exact;
     only successful idb adds between scans are estimated, and those can only
     make the estimate an undercount, never an overcount), the real store can
     exceed `cap` by at most `PRUNE_MARGIN` rows between the estimate crossing
     the line and the scan that corrects it — a small, fixed bound, not a
     multiple of `cap` and not proportional to write volume. `ring.length` is
     always exact (it is just the live array's size, corrected on every
     `pushRing`), so a run of idb failures that diverts writes into the ring
     is reflected in the trigger immediately, not after N more writes — this
     is what fixes the "ring failures skip the check" hole a write-count
     throttle had. After any real scan, `idbCountEstimate` is reset to the
     exact idb count `pruneNow` just read (drift correction). */
  const PRUNE_MARGIN = Math.max(5, Math.min(50, Math.ceil(retention * 0.1)));
  let idbCountEstimate = null; // null until the first real scan establishes a baseline

  /* Cross-tab drift (round-4 codex finding): `idbCountEstimate` only tracks
     writes THIS instance made. `foray_events` is one shared IndexedDB
     database, so a second tab (or a second worker) can be appending to the
     same store concurrently, and its writes are invisible to this instance's
     estimate — the sum-based trigger above never sees them, so it can stay
     "confidently" under `retention + PRUNE_MARGIN` forever while the real,
     shared store climbs well past the cap. A one-shot cross-context wakeup
     is not reliable (there is no cheap "the other tab wrote a row" signal
     without a BroadcastChannel handshake this module deliberately does not
     take on), so instead: force a real scan periodically by wall-clock time,
     independent of the write-count estimate, so a store growing entirely
     from OTHER tabs still gets corrected within a bounded window rather than
     never. */
  const MAX_ESTIMATE_AGE_MS = 60_000;
  let lastScanAt = 0;

  /* Serialize flush/prune (round-6 codex finding): `flushBuffered()` and
     `pruneNow()` both read-then-write `idbCountEstimate`/`ring`/the idb
     store across `await` points. Two overlapping calls — the scheduled
     auto-flush still mid-flight while `unsynced()` or `pruneToRetention()`
     starts another — can interleave: a scan that STARTED first but reads
     from IndexedDB after a concurrent write commits can still FINISH last,
     overwriting `idbCountEstimate` with a stale, smaller count and silently
     erasing the concurrently-committed batch from the estimate. Every
     mutating entry point below is routed through this single chain so at
     most one is ever in flight at a time — same shape as
     `durable-store.js`'s `_queue`. */
  let opQueue = Promise.resolve();
  function enqueue(fn) {
    const settled = opQueue.then(fn, fn);
    opQueue = settled.then(() => {}, () => {}); // never let one failure wedge the chain
    return settled;
  }

  function pushRing(row) {
    ring.push({ ...row, id: `mem:${nextRingId++}` });
    while (ring.length > retention) ring.shift(); // oldest first — see header
  }

  function fault(op, err) {
    const rec = { op, error: errText(err), ts: now() };
    faults.push(rec);
    if (faults.length > MAX_FAULTS) faults.shift();
    if (onFault && !inFault && notified < MAX_FAULTS) {
      inFault = true;
      notified += 1;
      try { onFault(rec, health()); } catch (_) { /* the sink must not be the new failure */ }
      finally { inFault = false; }
    }
  }

  function scheduleFlushNow() {
    if (flushTimer !== null) return;
    // A timeout matters as much as the callback itself: with no timeout,
    // requestIdleCallback is free to defer this indefinitely on a busy page,
    // and rows sit only in memory (pendingRows) until this fires — a page
    // close/navigation in that window loses them. flushDelayMs is both "how
    // long a burst may coalesce" and the hard ceiling on that risk window.
    const schedule = scheduleFlush
      || (typeof requestIdleCallback === "function"
        ? (fn) => requestIdleCallback(fn, { timeout: flushDelayMs })
        : (fn) => setTimeout(fn, flushDelayMs));
    flushTimer = schedule(() => { flushTimer = null; flushBuffered(); }) ?? true;
  }

  /** Write whatever is buffered, then enforce retention when the running
      estimate says it is due (see the header comment above for why an
      estimate, not a write-count throttle, and not a full scan every time).
      Never throws — a failed write demotes its batch to the ring rather than
      losing it (see header). Checked here rather than only from the caller's
      post-sync path: `trySyncEvents()` only prunes after a successful
      upload, so an offline device or a down server would otherwise let the
      store grow past `retention` for as long as sync kept failing — worse
      than the old localStorage write, which capped on every write regardless
      of sync state. Checking here restores that guarantee unconditionally.
      Takes `cap` (defaulting to the configured `retention`) so a caller like
      `pruneToRetention(cap)` with a cap OTHER than `retention` doesn't have
      its own flush silently enforce the wrong, smaller number first —
      Codex round 5: `pruneToRetention(10000)` on a log configured with the
      default 5,000-row retention used to call this with no cap argument,
      auto-pruning to 5,000 before the caller's own, larger cap ever ran. */
  async function flushBuffered(cap = retention) {
    return enqueue(() => flushBufferedImpl(cap));
  }

  async function flushBufferedImpl(cap) {
    if (pendingRows.length) {
      const batch = pendingRows.splice(0, pendingRows.length);
      if (!hasIdb) {
        for (const row of batch) pushRing(row); // ring.length is exact — no estimate needed
      } else {
        try {
          await withStore(open, STORE_NAME, "readwrite", (s) => {
            for (const row of batch) s.add(row);
          });
          if (idbCountEstimate !== null) idbCountEstimate += batch.length;
        } catch (err) {
          fault("flush", err);
          for (const row of batch) pushRing(row); // not lost — see header
          // A durable write just failed and this batch landed in the ring
          // instead. The running estimate no longer reflects reality closely
          // enough to trust: idbCountEstimate could still be sitting near a
          // stale high-water mark from before failures started (e.g. exactly
          // `retention` after the last successful prune), while every new
          // row now piles into the ring, which self-caps at `retention` on
          // its own (see pushRing) — independently of idb's count. Left
          // alone, the two backends could each sit near `retention`
          // simultaneously (combined ~2x the promised cap) without the
          // sum-based trigger below ever firing, because the ring's own cap
          // stops it from ever pushing the sum past `retention + PRUNE_MARGIN`
          // when idbCountEstimate is small, and because a stale, too-high
          // estimate never gets corrected once idb stops taking writes.
          // Forcing a real scan (null) on every fallback write is the
          // simplest thing that is always correct: the next check below sees
          // `idbCountEstimate === null` and runs `pruneNow`, which reads the
          // combined truth and re-baselines the estimate from it.
          idbCountEstimate = null;
        }
      }
    }
    if (hasIdb && (
      idbCountEstimate === null
      || idbCountEstimate + ring.length >= cap + PRUNE_MARGIN
      || Date.parse(now()) - lastScanAt >= MAX_ESTIMATE_AGE_MS
    )) {
      await pruneNowImpl(cap);
      return true; // signals the caller a real scan already ran with this cap
    }
    return false;
  }

  /**
   * Enforce the retention cap across BOTH backends combined: delete the
   * oldest SYNCED rows first (an unsynced row is the one copy of something
   * not yet delivered, so it survives longer), and only reach into unsynced
   * rows, oldest first, if trimming synced rows alone is not enough. Does
   * NOT flush first — callers that need buffered rows counted call
   * `flushBuffered()` (which calls this itself) or `pruneToRetention()`
   * below, which does flush; this raw form exists so `flushBuffered()` can
   * call it without recursing into itself. Always ends by resetting
   * `idbCountEstimate` to the exact idb count this scan just read (minus
   * whatever it deleted) — the point of a real scan is to correct the
   * estimate's drift, not just to delete rows.
   */
  async function pruneNow(cap) {
    return enqueue(() => pruneNowImpl(cap));
  }

  async function pruneNowImpl(cap) {
    const idbReadOk = { ok: true };
    const idbRows = await readIdbAll(idbReadOk);
    const combined = [
      ...idbRows.filter(Boolean).map((r) => ({ ...r, _backend: "idb" })),
      ...ring.map((r) => ({ ...r, _backend: "ring" })),
    ];
    if (combined.length <= cap) {
      // Only trust this as an exact baseline if the read actually succeeded.
      // readIdbAll() returns [] on a FAILED read too (see its own comment),
      // and a failed read is not the same fact as "the store is empty" — if
      // it were near `cap` before this transient failure, recording 0 here
      // would let up to another `retention + PRUNE_MARGIN` writes through
      // before the next scan even fires, letting the store approach roughly
      // double the cap. Leaving the estimate `null` on a failed read means
      // the very next flush forces another real scan instead of trusting a
      // guess — the same "when in doubt, rescan" rule flushBuffered already
      // applies to its own fallback-to-ring case above.
      idbCountEstimate = idbReadOk.ok ? idbRows.filter(Boolean).length : null;
      if (idbReadOk.ok) lastScanAt = Date.parse(now());
      return;
    }
    const excess = combined.length - cap;
    const byAge = combined.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const toDelete = [];
    for (const r of byAge) { if (r.synced && toDelete.length < excess) toDelete.push(r); }
    if (toDelete.length < excess) {
      for (const r of byAge) {
        if (toDelete.length >= excess) break;
        if (!toDelete.includes(r)) toDelete.push(r);
      }
    }
    const idbIdsToDelete = toDelete.filter((r) => r._backend === "idb").map((r) => r.id);
    const ringIdsToDelete = new Set(toDelete.filter((r) => r._backend === "ring").map((r) => r.id));
    if (ringIdsToDelete.size) {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ringIdsToDelete.has(ring[i].id)) ring.splice(i, 1);
      }
    }
    let idbDeleted = 0;
    if (idbIdsToDelete.length && hasIdb) {
      try {
        await withStore(open, STORE_NAME, "readwrite", (s) => {
          for (const id of idbIdsToDelete) s.delete(id);
        });
        idbDeleted = idbIdsToDelete.length;
      } catch (err) {
        fault("prune", err);
      }
    }
    // Exact, whether or not the delete above succeeded, PROVIDED the read
    // that produced idbRows itself succeeded — see the `<= cap` branch above
    // for why a failed read must not be trusted as "found 0 rows".
    idbCountEstimate = idbReadOk.ok ? (idbRows.filter(Boolean).length - idbDeleted) : null;
    if (idbReadOk.ok) lastScanAt = Date.parse(now());
  }

  async function readIdbAll(readStatus) {
    if (!hasIdb) return [];
    try {
      return (await withStore(open, STORE_NAME, "readonly", (s) => s.getAll())) || [];
    } catch (err) {
      fault("read", err);
      if (readStatus) readStatus.ok = false;
      return [];
    }
  }

  function health() {
    return {
      ok: faults.length === 0,
      backend: hasIdb ? "idb" : "memory",
      pending: pendingRows.length,
      ringSize: ring.length,
      faults: faults.slice(-MAX_FAULTS),
    };
  }

  return {
    /** Buffer one row and schedule its flush. NEVER throws: a caller on the
        hot path (a thumb, a pick) must never fail because telemetry did.
        No caller-visible signature change from the old `logEvent` shim — the
        row shape is `{ts, type, builder, profile, payload}`; `synced` and `id`
        are this module's own bookkeeping. */
    append(row) {
      try {
        pendingRows.push({
          ts: row && row.ts ? row.ts : now(),
          type: row ? row.type : undefined,
          builder: row ? row.builder : undefined,
          profile: row ? row.profile : undefined,
          payload: row ? row.payload : undefined,
          synced: false,
        });
        scheduleFlushNow();
      } catch (err) {
        fault("append", err);
      }
    },

    /** Rows not yet marked synced, from BOTH the durable tier and the
        fallback ring. Flushes any buffered rows first so a caller who just
        called `append()` sees them. */
    async unsynced() {
      await flushBuffered();
      const idbRows = await readIdbAll();
      return [
        ...idbRows.filter((r) => r && !r.synced),
        ...ring.filter((r) => !r.synced),
      ];
    },

    /** Mark the given ids synced — ids from `unsynced()`, straight through
        (mixed IndexedDB numbers and `"mem:N"` ring ids, see header). */
    async markSynced(ids) {
      if (!ids || !ids.length) return;
      const idbIds = ids.filter((id) => typeof id === "number");
      const ringIds = new Set(ids.filter((id) => typeof id === "string"));
      if (ringIds.size) {
        for (const r of ring) if (ringIds.has(r.id)) r.synced = true;
      }
      if (idbIds.length && hasIdb) {
        try {
          await withStore(open, STORE_NAME, "readwrite", (s) => {
            for (const id of idbIds) {
              const req = s.get(id);
              req.onsuccess = () => {
                const rec = req.result;
                if (rec) { rec.synced = true; s.put(rec); }
              };
            }
          });
        } catch (err) {
          fault("markSynced", err);
        }
      }
    },

    /**
     * The public, explicit form: flush first (so just-buffered rows are
     * counted), then enforce the cap — UNLESS the flush itself already ran
     * a real scan with this exact cap (round-7 codex finding: calling
     * `pruneNow(cap)` unconditionally after `flushBuffered(cap)` meant
     * every threshold-triggered flush paid for two full-store `getAll()`
     * scans in a row, the same O(n)-per-call cost round-2's review flagged
     * in the first place). `flushBuffered()` returns whether it pruned;
     * only scan again when it didn't, so a caller like `trySyncEvents()`
     * (which wants the cap enforced right now, after marking a batch
     * synced, even when the estimate alone wouldn't have triggered it yet)
     * still gets a guaranteed prune, but never two back-to-back ones.
     */
    async pruneToRetention(cap = retention) {
      const alreadyPruned = await flushBuffered(cap);
      if (!alreadyPruned) await pruneNow(cap);
    },

    /** The failure record — same convention as `durable-store.js`'s
        `health()`: always readable, assembled from memory, never throws. */
    health,
  };
}

/* ---------- IndexedDB plumbing (idb-tier.js's two hazards apply here too) ---------- */

function openDb(factory, name, version, storeName) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = factory.open(name, version); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id", autoIncrement: true });
        }
      } catch (err) { reject(err); }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked by another tab"));
  });
}

/** Run one transaction and resolve with the LAST request's result after commit
    — hazard 1 from `idb-tier.js`'s header: handlers are wired before any
    request is issued, because a transaction auto-commits once nothing is
    pending against it, and awaiting a request before assigning `oncomplete`
    is a race the transaction usually wins. `fn` may issue several requests
    (a loop of `add`/`delete`, or a `get` that issues a `put` from inside its
    own `onsuccess`) — the transaction stays open as long as something is
    pending, so chaining a new request from inside an earlier one's handler is
    safe as long as it happens synchronously inside that handler. */
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
    // No per-request onerror: a failed request aborts the transaction, and
    // tx.onabort/onerror is the single place that rejection belongs.
    if (req) req.onsuccess = () => { result = req.result; };
  }));
}
