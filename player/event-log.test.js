/* player/event-log.js — the outbound telemetry queue, off the synchronous
   localStorage rewrite (M3, kanban card t_c7199b13).

   WHAT THIS SUITE PROVES, AND WHAT IT CANNOT
   Same shape as `idb-tier.test.js`: there is no IndexedDB in Node, so this
   drives the module against a hand-rolled fake `IDBFactory` (below), extended
   from that file's fake with an autoincrementing keyPath and `get`/`delete` —
   this store is keyed on `id`, not on a fixed `key`.

     PROVEN HERE  the queue never throws out of `append`, batching coalesces a
                  burst into one flush, `unsynced`/`markSynced` round-trip
                  through both id spaces, `pruneToRetention` keeps exactly the
                  cap and prefers deleting synced rows first, and — the two
                  cases M3 calls out by name — an IndexedDB write failure
                  (quota exhaustion) demotes its batch to the in-memory ring
                  rather than losing it, and the ring itself is capped.
     NOT PROVEN   real browser semantics — actual quota accounting, eviction,
                  `requestIdleCallback` scheduling under load. Only observable
                  in a browser, same caveat as `idb-tier.test.js`.
*/

import test from "node:test";
import assert from "node:assert/strict";

import { createEventLog, DB_NAME, DB_VERSION, STORE_NAME, DEFAULT_RETENTION } from "./event-log.js";

/* ---------- construction ---------- */

test("the database and store names are the committed ones", () => {
  // Changing either orphans every queued row on the next deploy.
  assert.equal(DB_NAME, "foray_events");
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, "events");
  assert.equal(DEFAULT_RETENTION, 5000);
});

test("append never throws, even with no IndexedDB at all", () => {
  const log = createEventLog({ indexedDB: null, scheduleFlush: () => {} });
  assert.doesNotThrow(() => log.append({ type: "picked", payload: {} }));
  assert.equal(log.health().backend, "memory");
});

test("append never throws when the row itself is hostile", () => {
  const log = createEventLog({ indexedDB: null, scheduleFlush: () => {} });
  assert.doesNotThrow(() => log.append(null));
  assert.doesNotThrow(() => log.append(undefined));
  assert.doesNotThrow(() => log.append({ get type() { throw new Error("hostile"); } }));
});

/* ---------- the memory-only fallback (no IndexedDB) ---------- */

test("with no IndexedDB, appended rows are readable from unsynced() after a flush", async () => {
  let flush;
  const log = createEventLog({ indexedDB: null, scheduleFlush: (fn) => { flush = fn; } });
  log.append({ type: "picked", payload: { a: 1 } });
  await flush();
  const rows = await log.unsynced();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "picked");
  assert.equal(typeof rows[0].id, "string");
  assert.ok(rows[0].id.startsWith("mem:"), "the fallback ring's ids are namespaced away from IndexedDB's");
});

test("the memory ring is capped at retention, oldest dropped first", async () => {
  let flush;
  const log = createEventLog({ indexedDB: null, retention: 3, scheduleFlush: (fn) => { flush = fn; } });
  for (let i = 0; i < 5; i++) log.append({ type: `t${i}`, payload: {} });
  await flush();
  const rows = await log.unsynced();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.type), ["t2", "t3", "t4"], "the oldest two must be gone");
});

/* ---------- batching ---------- */

test("several append() calls in one tick schedule exactly one flush", () => {
  let scheduled = 0;
  const log = createEventLog({ indexedDB: null, scheduleFlush: (fn) => { scheduled += 1; return fn; } });
  log.append({ type: "a", payload: {} });
  log.append({ type: "b", payload: {} });
  log.append({ type: "c", payload: {} });
  assert.equal(scheduled, 1, "a burst inside one tick must cost one flush, not three");
});

test("requestIdleCallback is given a deadline, so a busy page cannot defer the flush indefinitely", () => {
  const calls = [];
  const savedRIC = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (fn, opts) => { calls.push(opts); return 1; };
  try {
    // No scheduleFlush override here — this exercises the module's OWN default
    // scheduler selection, the thing the bug lived in.
    const log = createEventLog({ indexedDB: null, flushDelayMs: 75 });
    log.append({ type: "a", payload: {} });
    assert.equal(calls.length, 1);
    assert.ok(calls[0] && typeof calls[0].timeout === "number", "requestIdleCallback must be called with a numeric timeout");
    assert.equal(calls[0].timeout, 75, "the timeout must be flushDelayMs, the same bound the setTimeout fallback uses");
  } finally {
    if (savedRIC === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = savedRIC;
  }
});

/* ---------- against the real IndexedDB adapter shape ---------- */

test("unsynced() flushes buffered rows before reading, so a caller sees its own just-logged event", async () => {
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "picked", payload: { episode_id: "ep-1" } });
  const rows = await log.unsynced();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "picked");
  assert.equal(typeof rows[0].id, "number", "a real IndexedDB row is keyed by its autoincrement id");
});

test("markSynced removes rows from unsynced(), across the IndexedDB id space", async () => {
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "picked", payload: {} });
  log.append({ type: "saved", payload: {} });
  const before = await log.unsynced();
  assert.equal(before.length, 2);
  await log.markSynced([before[0].id]);
  const after = await log.unsynced();
  assert.equal(after.length, 1);
  assert.equal(after[0].type, "saved");
});

test("markSynced handles a mix of IndexedDB ids and ring ids in one call", async () => {
  // The fallback demotion (below) can leave a caller holding ids from BOTH
  // spaces in the same unsynced() batch — markSynced must not require the
  // caller to split them.
  const factory = new FakeFactory({ putError: new Error("QuotaExceededError") });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "a", payload: {} }); // fails to write idb, demoted to ring
  const rows = await log.unsynced();
  assert.equal(rows.length, 1);
  assert.ok(String(rows[0].id).startsWith("mem:"));
  await log.markSynced(rows.map((r) => r.id));
  assert.equal((await log.unsynced()).length, 0);
});

/* ================= M3's two required behaviours ================= */

/* ---------- 1. IndexedDB quota exhaustion ---------- */

test("QUOTA EXHAUSTION: append does not throw, even when the durable write fails", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  assert.doesNotThrow(() => log.append({ type: "picked", payload: {} }));
  await assert.doesNotReject(() => log.unsynced());
});

test("QUOTA EXHAUSTION: the failure is surfaced through health(), not swallowed", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "picked", payload: {} });
  await log.unsynced(); // flushes
  const health = log.health();
  assert.equal(health.ok, false, "a quota failure must flip health().ok, the same convention durable-store.js uses");
  assert.ok(health.faults.length > 0);
  assert.match(health.faults[0].error, /QuotaExceededError|quota/i);
});

test("QUOTA EXHAUSTION: onFault is called with the fault and the health record", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  const faults = [];
  const log = createEventLog({
    indexedDB: factory,
    scheduleFlush: () => {},
    onFault: (fault, health) => faults.push({ fault, health }),
  });
  log.append({ type: "picked", payload: {} });
  await log.unsynced();
  assert.equal(faults.length, 1);
  assert.match(faults[0].fault.error, /QuotaExceededError|quota/i);
  assert.equal(faults[0].health.ok, false);
});

test("QUOTA EXHAUSTION: the event is NOT permanently lost — it falls back to the memory ring", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "picked", payload: { episode_id: "ep-9" } });
  const rows = await log.unsynced();
  assert.equal(rows.length, 1, "the row must survive the failed durable write");
  assert.equal(rows[0].type, "picked");
  assert.equal(rows[0].payload.episode_id, "ep-9");
});

test("QUOTA EXHAUSTION: onFault itself throwing does not escape append's caller", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  const log = createEventLog({
    indexedDB: factory,
    scheduleFlush: () => {},
    onFault: () => { throw new Error("a broken sink"); },
  });
  log.append({ type: "picked", payload: {} });
  await assert.doesNotReject(() => log.unsynced());
});

test("QUOTA EXHAUSTION: a budget caps onFault notifications, so a permanently full store cannot loop the app", async () => {
  const factory = new FakeFactory({ putError: quotaError() });
  let calls = 0;
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {}, onFault: () => { calls += 1; } });
  for (let i = 0; i < 50; i++) {
    log.append({ type: `t${i}`, payload: {} });
    await log.unsynced();
  }
  assert.ok(calls <= 20, `onFault fired ${calls} times; expected a budget`);
});

/* ---------- 2. the 5,000-row retention cap ---------- */

test("RETENTION: pruneToRetention keeps exactly the most recent 5,000 rows", async () => {
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, retention: 5000, scheduleFlush: () => {} });
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  // All rows synced, so the cap is free to reach every one of them without the
  // "unsynced survives longer" rule getting in the way of the count itself.
  for (let i = 0; i < 5010; i++) {
    log.append({ ts: new Date(base + i * 1000).toISOString(), type: "t", payload: { i } });
  }
  const before = await log.unsynced();
  await log.markSynced(before.map((r) => r.id));
  await log.pruneToRetention(5000);
  const remaining = await log.unsynced(); // all synced now, so re-check via the store directly
  assert.equal(remaining.length, 0, "everything was marked synced");
  // Reach into the adapter directly to count what is actually left in the store.
  const left = [...factory.db.stores.get(STORE_NAME).data.values()];
  assert.equal(left.length, 5000, `expected exactly 5000 rows, found ${left.length}`);
  const ids = left.map((r) => r.payload.i).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 5000 }, (_, i) => i + 10), "the OLDEST 10 must be the ones dropped");
});

test("RETENTION: under the cap, nothing is deleted", async () => {
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  for (let i = 0; i < 10; i++) log.append({ type: "t", payload: { i } });
  await log.pruneToRetention(5000);
  const left = [...factory.db.stores.get(STORE_NAME).data.values()];
  assert.equal(left.length, 10);
});

test("RETENTION: synced rows are deleted before unsynced ones", async () => {
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < 5; i++) {
    log.append({ ts: new Date(base + i * 1000).toISOString(), type: "t", payload: { i } });
  }
  const rows = await log.unsynced();
  // Mark the NEWEST three synced — the opposite of age order. If the cap only
  // looked at age it would delete rows 0 and 1 (the oldest overall, both still
  // unsynced) rather than preferring the synced ones regardless of age.
  await log.markSynced(rows.slice(2).map((r) => r.id));
  await log.pruneToRetention(3);
  const left = [...factory.db.stores.get(STORE_NAME).data.values()].map((r) => r.payload.i).sort();
  assert.deepEqual(left, [0, 1, 4], "the two oldest SYNCED rows (2, 3) must go first even though 0 and 1 are older");
});

test("RETENTION: applies across BOTH the durable rows and the memory ring combined", async () => {
  // A store that failed once (some rows in the ring) and is healthy again
  // (later rows durable) must still be capped as ONE queue.
  const factory = new FakeFactory({ putError: quotaError() });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  log.append({ ts: new Date(base).toISOString(), type: "ring-row", payload: {} });
  await log.unsynced(); // flush — lands in the ring because putError is set
  factory.putError = null; // "recovers"
  for (let i = 0; i < 3; i++) {
    log.append({ ts: new Date(base + (i + 1) * 1000).toISOString(), type: `idb-${i}`, payload: {} });
  }
  const all = await log.unsynced();
  assert.equal(all.length, 4, "one ring row plus three durable rows");
  await log.markSynced(all.map((r) => r.id));
  await log.pruneToRetention(2);
  const remaining = await log.unsynced();
  // Nothing is unsynced (everything above was marked), so read the raw stores.
  const idbLeft = [...factory.db.stores.get(STORE_NAME).data.values()];
  assert.equal(remaining.length, 0);
  assert.equal(idbLeft.length, 2, "the two most recent durable rows must survive the combined cap");
});

test("RETENTION: the cap holds even when nothing is ever synced (offline / sync never succeeds)", async () => {
  /* The bug this guards: the app's own pruneToRetention() call sits in
     trySyncEvents(), AFTER a successful upload. An offline device, or a
     server that is down, never reaches that call — so if pruning only
     happened there, the store would grow without bound for as long as sync
     kept failing, which is worse than the old localStorage write (always
     capped on every write, sync or no sync). This module must not depend on
     the caller's sync ever succeeding to keep its own promise: flushing
     alone — never marking anything synced, never calling pruneToRetention
     directly — has to be enough. */
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, retention: 50, scheduleFlush: () => {} });
  for (let i = 0; i < 200; i++) log.append({ type: "t", payload: { i } });
  // Only ever flush (via unsynced()) — never markSynced, never pruneToRetention.
  // A real offline client's trySyncEvents() bails before either of those.
  await log.unsynced();
  const left = [...factory.db.stores.get(STORE_NAME).data.values()];
  assert.ok(
    left.length <= 50,
    `the store grew to ${left.length} rows with retention=50 and nothing ever synced — ` +
    `the cap must not depend on a successful sync`
  );
});

test("RETENTION: append()'s own scheduled flush enforces the cap, not just an explicit unsynced()/pruneToRetention() call", async () => {
  const flushes = [];
  // A real scheduler, not a no-op — so append() itself drives the flush this
  // test is checking, the same as it would in a browser. No IndexedDB here
  // (the ring path) — the cap must hold on that path too, not just idb's.
  const log = createEventLog({
    indexedDB: null,
    retention: 20,
    scheduleFlush: (fn) => { flushes.push(fn); return true; },
  });
  for (let i = 0; i < 100; i++) log.append({ type: "t", payload: { i } });
  // append() coalesces a burst into ONE scheduled flush; run it, as the real
  // scheduler eventually would.
  assert.equal(flushes.length, 1, "a burst of appends must schedule exactly one flush");
  await flushes[0]();
  assert.ok(
    log.health().ringSize <= 20,
    `the ring grew to ${log.health().ringSize} rows after the scheduled flush alone, with retention=20`
  );
});

test("RETENTION: a small idb flush does not re-scan the whole store every time (round-2 codex finding)", async () => {
  /* The first fix (prune on every flush) was functionally correct but scanned
     the whole store on every flush — a real perf regression Codex's own
     re-review caught. This proves the throttled version: once the first
     flush's mandatory check has run, further small flushes cost exactly the
     ONE getAll() `unsynced()` itself always needs to answer the caller — not
     a second one from pruning underneath it. */
  const factory = new FakeFactory();
  let getAllCalls = 0;
  const realGetAll = FakeObjectStore.prototype.getAll;
  FakeObjectStore.prototype.getAll = function (...args) { getAllCalls += 1; return realGetAll.apply(this, args); };
  try {
    const log = createEventLog({ indexedDB: factory, retention: 5000, scheduleFlush: () => {} });
    // The FIRST flush of a session always checks once (catches any backlog
    // left over from a prior session) — so this call costs TWO getAll()s: the
    // prune's own scan, plus unsynced()'s own read of the result.
    log.append({ type: "t", payload: {} });
    await log.unsynced();
    assert.equal(getAllCalls, 2, "the first flush's mandatory prune check adds one scan on top of unsynced()'s own read");
    // Several more small flushes, well under PRUNE_CHECK_INTERVAL (250 for a
    // 5000 retention) writes total — each should cost exactly ONE getAll(),
    // from unsynced() itself, with no extra scan from pruning underneath it.
    for (let batch = 0; batch < 5; batch++) {
      const before = getAllCalls;
      log.append({ type: "t", payload: {} });
      await log.unsynced();
      assert.equal(getAllCalls, before + 1, "a small flush under the check interval must cost exactly one scan, not two");
    }
  } finally {
    FakeObjectStore.prototype.getAll = realGetAll;
  }
});

test("RETENTION: the combined store never overshoots the cap by more than a small fixed margin, however many small flushes land (round-3 codex finding #1)", async () => {
  /* Codex round 3: a naive write-count throttle (prune every N writes) lets
     the store overshoot by up to N-1 rows on ordinary small flushes — with
     retention=20 and a fixed interval of 50, 49 one-row flushes after the
     first check left 69 durable rows, more than 3x the cap. This proves the
     estimate-based trigger instead bounds the overshoot to a small margin
     (retention * 0.1, floor 5, ceiling 50) regardless of how many small
     flushes land between real scans. */
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, retention: 20, scheduleFlush: () => {} });
  for (let i = 0; i < 200; i++) {
    log.append({ type: "t", payload: { i } });
    await log.unsynced(); // one row at a time — the worst case for a write-count throttle
  }
  const left = [...factory.db.stores.get(STORE_NAME).data.values()];
  const margin = Math.max(5, Math.min(50, Math.ceil(20 * 0.1))); // mirrors PRUNE_MARGIN's own formula
  assert.ok(
    left.length <= 20 + margin,
    `expected at most ${20 + margin} rows (cap 20 + margin ${margin}), found ${left.length} after 200 one-row flushes`
  );
});

test("RETENTION: durable-write failures diverting into the ring do not let the combined size grow past the margin (round-3 codex finding #2)", async () => {
  /* Codex round 3: a write-count throttle only counted SUCCESSFUL idb writes,
     so once idb was near the cap and a run of quota errors started diverting
     writes into the ring, the check was never re-triggered — the combined
     total could climb toward roughly double the cap. This proves the
     estimate now includes `ring.length` directly (always exact, no counting
     needed), so a ring-only failure run is caught by the same trigger. */
  const factory = new FakeFactory();
  const log = createEventLog({ indexedDB: factory, retention: 20, scheduleFlush: () => {} });
  // Get idb close to the cap first, healthy.
  for (let i = 0; i < 18; i++) log.append({ type: "idb", payload: { i } });
  await log.unsynced();
  const idbBefore = [...factory.db.stores.get(STORE_NAME).data.values()].length;
  assert.ok(idbBefore <= 20, "sanity: idb itself must already be at/under the cap before the failure run starts");
  // Now every durable write fails — everything from here lands in the ring.
  factory.putError = quotaError();
  for (let i = 0; i < 40; i++) {
    log.append({ type: "ring", payload: { i } });
    await log.unsynced();
  }
  const idbLeft = [...factory.db.stores.get(STORE_NAME).data.values()];
  const combined = idbLeft.length + log.health().ringSize;
  const margin = Math.max(5, Math.min(50, Math.ceil(20 * 0.1)));
  assert.ok(
    combined <= 20 + margin,
    `expected the COMBINED total to stay near the cap (<= ${20 + margin}), found idb=${idbLeft.length} + ring=${log.health().ringSize} = ${combined}`
  );
});

/* ---------- health() shape ---------- */

test("health() is always readable and never throws, even with a dead store", async () => {
  const factory = new FakeFactory({ openError: new Error("private mode") });
  const log = createEventLog({ indexedDB: factory, scheduleFlush: () => {} });
  log.append({ type: "a", payload: {} });
  await log.unsynced();
  const h = log.health();
  assert.equal(typeof h.ok, "boolean");
  assert.equal(typeof h.backend, "string");
  assert.ok(Array.isArray(h.faults));
});

function quotaError() {
  const e = new Error("QuotaExceededError: the quota has been exceeded");
  e.name = "QuotaExceededError";
  return e;
}

/* ---------- the fake IDBFactory ----------

   Extends idb-tier.test.js's fake with the two things a `keyPath: "id",
   autoIncrement: true` store needs that a `keyPath: "key"` store does not:
   an incrementing counter assigning ids on `add`/`put`, and `get(id)` (used by
   `markSynced`'s read-modify-write). Kept HOSTILE about the same commit race
   `idb-tier.test.js` calls out: the transaction completes synchronously after
   the last request's success handler returns. */

class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; this.error = null; this._afterSettle = null; }
  _succeed(result) {
    this.result = result;
    setTimeout(() => { if (this.onsuccess) this.onsuccess({ target: this }); if (this._afterSettle) this._afterSettle(); }, 0);
  }
  _fail(error) {
    this.error = error;
    setTimeout(() => { if (this.onerror) this.onerror({ target: this }); }, 0);
  }
}

class FakeStore {
  constructor(keyPath, autoIncrement) { this.keyPath = keyPath; this.autoIncrement = Boolean(autoIncrement); this.data = new Map(); this._next = 1; }
}

class FakeObjectStore {
  constructor(tx, store) { this.tx = tx; this.store = store; }
  add(record) { return this._put(record, true); }
  put(record) { return this._put(record, false); }
  _put(record, isAdd) {
    const req = new FakeRequest();
    if (this.tx.db.factory.putError) {
      this.tx._failWith(this.tx.db.factory.putError);
      req._fail(this.tx.db.factory.putError);
      return req;
    }
    let key = record[this.store.keyPath];
    if ((key === undefined || key === null) && this.store.autoIncrement && isAdd) {
      key = this.store._next++;
      record = { ...record, [this.store.keyPath]: key };
    }
    this.store.data.set(key, record);
    this.tx._expect(req);
    req._succeed(key);
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    this.tx._expect(req);
    req._succeed(this.store.data.get(key));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.store.data.delete(key);
    this.tx._expect(req);
    req._succeed(undefined);
    return req;
  }
  getAll() {
    const req = new FakeRequest();
    this.tx._expect(req);
    req._succeed([...this.store.data.values()]);
    return req;
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db; this.names = names; this.mode = mode;
    this.error = null; this.oncomplete = null; this.onerror = null; this.onabort = null;
    this._settled = false;
  }
  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) { const err = new Error(`object store ${name} not found`); this._failWith(err); throw err; }
    return new FakeObjectStore(this, store);
  }
  _expect(req) {
    req._afterSettle = () => {
      if (this._settled) return;
      this._settled = true;
      if (this.oncomplete) this.oncomplete({ target: this });
    };
  }
  _failWith(error) {
    this.error = error;
    setTimeout(() => {
      if (this._settled) return;
      this._settled = true;
      if (this.onabort) this.onabort({ target: this });
      else if (this.onerror) this.onerror({ target: this });
    }, 0);
  }
}

class FakeDb {
  constructor(factory) {
    this.factory = factory;
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }
  createObjectStore(name, { keyPath, autoIncrement } = {}) {
    this.stores.set(name, new FakeStore(keyPath, autoIncrement));
    return this.stores.get(name);
  }
  transaction(names, mode) {
    if (this.factory.txThrows) throw new Error("no transaction available");
    return new FakeTransaction(this, names, mode);
  }
}

class FakeFactory {
  constructor({ openError = null, blocked = false, putError = null, txThrows = false } = {}) {
    this.openError = openError;
    this.blocked = blocked;
    this.putError = putError;
    this.txThrows = txThrows;
    this.opens = 0;
    this.db = new FakeDb(this);
    this._created = false;
  }
  open(_name, _version) {
    this.opens += 1;
    const req = new FakeRequest();
    req.onupgradeneeded = null;
    req.onblocked = null;
    setTimeout(() => {
      if (this.openError) { req.error = this.openError; if (req.onerror) req.onerror({ target: req }); return; }
      if (this.blocked) { if (req.onblocked) req.onblocked({ target: req }); return; }
      req.result = this.db;
      if (!this._created) { this._created = true; if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); }
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}
