/* player/idb-tier.js — the durable tier's adapter (#40).

   WHAT THIS SUITE PROVES, AND WHAT IT CANNOT
   There is no IndexedDB in Node and this repo has no dependencies, so the tests
   below drive the adapter against a hand-rolled fake `IDBFactory` — about eighty
   lines, at the bottom of this file. Be precise about what that buys:

     PROVEN HERE  the call sequence (open → upgrade → transaction → request →
                  commit), that handlers are wired before the request is issued
                  (the auto-commit race, hazard 1 in the adapter's header), that
                  a failed open is not cached as the answer, prefix filtering,
                  the record shape, and every rejection path.
     NOT PROVEN   real browser semantics — quota behaviour, eviction, whether a
                  committed transaction actually survives an iOS restart. Those
                  are // AUDIT: unverified and only observable in a browser.

   The fake is written to be HOSTILE about the one hazard that matters: its
   transaction commits synchronously after its request's success handler returns,
   so an adapter that assigned `oncomplete` after awaiting a request would hang
   here rather than passing.
*/

import test from "node:test";
import assert from "node:assert/strict";

import { makeIdbTier, DB_NAME, DB_VERSION, STORE_NAME } from "./idb-tier.js";
import { DurableStore, localStorageTier } from "./durable-store.js";

/* ---------- the tier ---------- */

test("no IndexedDB means no tier — a null, never a stub that pretends", () => {
  // A stub that swallowed would make health() claim a durable tier that is not
  // there, which is the one thing this whole change is trying to stop.
  assert.equal(makeIdbTier({ indexedDB: null }), null);
  assert.equal(makeIdbTier({ indexedDB: {} }), null);
  assert.equal(makeIdbTier({ indexedDB: { open: "not a function" } }), null);
});

test("the tier declares itself async and durable", () => {
  const tier = makeIdbTier({ indexedDB: new FakeFactory() });
  assert.equal(tier.name, "idb");
  assert.equal(tier.sync, false);
  assert.equal(tier.durable, true);
});

test("the database, version and store names are the committed ones", () => {
  // Changing any of these orphans every existing row, which is the same class of
  // mistake as renaming a cp_ key.
  assert.equal(DB_NAME, "foray");
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, "kv");
});

test("opening creates the object store keyed on `key`, once", async () => {
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory });
  await tier.write("cp_a", "1");
  await tier.write("cp_b", "2");
  assert.equal(factory.opens, 1, "the connection is memoised");
  assert.deepEqual(factory.db.stores.get(STORE_NAME).keyPath, "key");
});

test("a written row round-trips through readAll", async () => {
  const tier = makeIdbTier({ indexedDB: new FakeFactory() });
  await tier.write("cp_interests", '{"a":1}');
  const rows = await tier.readAll("cp_");
  assert.equal(rows.get("cp_interests"), '{"a":1}');
});

test("the stored record carries key, value and the tier's own timestamp", async () => {
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory });
  await tier.write("cp_a", "1");
  const rec = factory.db.stores.get(STORE_NAME).data.get("cp_a");
  assert.equal(rec.key, "cp_a");
  assert.equal(rec.value, "1");
  assert.ok(Number.isFinite(Date.parse(rec.updated_at)), "for a human reading the database");
});

test("a rewrite replaces rather than duplicating", async () => {
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory });
  await tier.write("cp_a", "1");
  await tier.write("cp_a", "2");
  assert.equal(factory.db.stores.get(STORE_NAME).data.size, 1);
  assert.equal((await tier.readAll("cp_")).get("cp_a"), "2");
});

test("readAll filters to the owned prefix", async () => {
  const factory = new FakeFactory();
  factory.seed(STORE_NAME, [
    { key: "cp_a", value: "1" },
    { key: "theme", value: "dark" },
    { key: "cp_foray:x", value: "{}" },
  ]);
  const rows = await makeIdbTier({ indexedDB: factory }).readAll("cp_");
  assert.deepEqual([...rows.keys()].sort(), ["cp_a", "cp_foray:x"]);
});

test("readAll with no prefix returns everything, and skips malformed rows", async () => {
  const factory = new FakeFactory();
  factory.seed(STORE_NAME, [
    { key: "cp_a", value: "1" },
    { key: "cp_b", value: 42 },          // not a string: a hand-edited row
    { value: "orphan" },                  // no key
    null,
  ]);
  const rows = await makeIdbTier({ indexedDB: factory }).readAll("");
  assert.deepEqual([...rows.keys()], ["cp_a"]);
});

test("readAll on an empty database is an empty Map, not a throw", async () => {
  const rows = await makeIdbTier({ indexedDB: new FakeFactory() }).readAll("cp_");
  assert.equal(rows.size, 0);
});

test("remove deletes the row", async () => {
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory });
  await tier.write("cp_a", "1");
  await tier.remove("cp_a");
  assert.equal((await tier.readAll("cp_")).size, 0);
});

test("removing a key that is not there is not an error", async () => {
  const tier = makeIdbTier({ indexedDB: new FakeFactory() });
  await tier.remove("cp_nope");
});

/* ---------- the failure paths ---------- */

test("a rejected open surfaces as a rejected write, with the browser's error", async () => {
  const tier = makeIdbTier({ indexedDB: new FakeFactory({ openError: new Error("private mode") }) });
  await assert.rejects(() => tier.write("cp_a", "1"), /private mode/);
});

test("a failed open is not cached as the answer — a later write can succeed", async () => {
  // Safari in private mode, a corrupted database, a transient failure: memoising
  // the rejection would mean one bad moment costs the durable tier for the whole
  // session.
  const factory = new FakeFactory({ openError: new Error("transient") });
  const tier = makeIdbTier({ indexedDB: factory });
  await assert.rejects(() => tier.write("cp_a", "1"));
  factory.openError = null;
  await tier.write("cp_a", "1");
  assert.equal((await tier.readAll("cp_")).get("cp_a"), "1");
  assert.equal(factory.opens, 2);
});

test("a synchronous throw from open() rejects rather than escaping", async () => {
  const factory = new FakeFactory();
  factory.open = () => { throw new Error("SecurityError"); };
  await assert.rejects(() => makeIdbTier({ indexedDB: factory }).write("cp_a", "1"), /SecurityError/);
});

test("a blocked upgrade rejects instead of hanging forever", async () => {
  // Another tab holding an older version open. A promise that never settles here
  // would park the store's write queue for the rest of the session.
  const tier = makeIdbTier({ indexedDB: new FakeFactory({ blocked: true }) });
  await assert.rejects(() => tier.write("cp_a", "1"), /blocked/);
});

test("a failing request aborts the transaction and rejects once", async () => {
  const factory = new FakeFactory({ putError: new Error("QuotaExceededError") });
  const tier = makeIdbTier({ indexedDB: factory });
  await assert.rejects(() => tier.write("cp_a", "1"), /QuotaExceededError/);
});

test("a transaction that cannot be started rejects", async () => {
  const factory = new FakeFactory({ txThrows: true });
  await assert.rejects(() => makeIdbTier({ indexedDB: factory }).write("cp_a", "1"), /no transaction/);
});

test("a store that vanished rejects rather than resolving with nothing", async () => {
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory, storeName: "kv" });
  await tier.write("cp_a", "1");
  factory.db.stores.delete("kv");
  await assert.rejects(() => tier.readAll("cp_"), /object store/);
});

/* ---------- the hazard the adapter's header names ---------- */

test("the commit race: handlers are wired before the request, so nothing hangs", async () => {
  // The fake commits SYNCHRONOUSLY after the request's success handler returns.
  // An adapter that awaited the request and only then assigned `tx.oncomplete`
  // would never see the event, and this test would time out instead of passing.
  // Keeping it green is the whole reason the adapter is shaped the way it is.
  const factory = new FakeFactory();
  const tier = makeIdbTier({ indexedDB: factory });
  await tier.write("cp_a", "1");
  assert.equal((await tier.readAll("cp_")).get("cp_a"), "1");
});

/* ---------- composed with the store it exists to serve ---------- */

test("END TO END: an existing cp_ row is migrated into the real adapter's database", async () => {
  const factory = new FakeFactory();
  const local = new FakeLocal({ cp_profile_id: '"p-abc"', "cp_foray:x": '{"foray_id":"x","elapsed_sec":600,"total_sec":3600}' });
  const store = new DurableStore({
    tiers: [localStorageTier(local), makeIdbTier({ indexedDB: factory })],
  });
  await store.hydrate();
  const rows = factory.db.stores.get(STORE_NAME).data;
  assert.equal(rows.get("cp_profile_id").value, '"p-abc"');
  assert.equal(JSON.parse(rows.get("cp_foray:x").value).elapsed_sec, 600);
  assert.equal(local.map.size, 2, "and localStorage still has both");
});

test("END TO END: with localStorage wiped, hydration reads them back out of it", async () => {
  const factory = new FakeFactory();
  factory.seed(STORE_NAME, [{ key: "cp_profile_id", value: '"p-abc"' }]);
  const store = new DurableStore({
    tiers: [localStorageTier(new FakeLocal()), makeIdbTier({ indexedDB: factory })],
  });
  await store.hydrate();
  assert.equal(store.getItem("cp_profile_id"), '"p-abc"');
  assert.equal(store.health().ok, true);
});

test("END TO END: a database that will not open leaves a working localStorage-only store", async () => {
  const local = new FakeLocal({ cp_a: "1" });
  const store = new DurableStore({
    tiers: [localStorageTier(local), makeIdbTier({ indexedDB: new FakeFactory({ openError: new Error("nope") }) })],
  });
  await store.hydrate();
  store.setItem("cp_b", "2");
  await store.flush();
  assert.equal(local.map.get("cp_b"), "2", "the listener is not worse off than before this change");
  assert.equal(store.health().ok, false, "and the lost durability is recorded, not hidden");
});

/* ================================================================= the fake ==

   Just enough IndexedDB to drive the adapter, and deliberately no more. Requests
   settle on a macrotask (`setTimeout(…, 0)`) so handlers must be assigned
   synchronously by the caller, exactly as in a browser; transactions commit
   after their last request settles.
*/

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    /** Set by the transaction: the browser commits as soon as its last request
        has settled, in the SAME task — before any awaited continuation runs. */
    this._afterSettle = null;
  }
  _succeed(result) {
    this.result = result;
    setTimeout(() => {
      if (this.onsuccess) this.onsuccess({ target: this });
      if (this._afterSettle) this._afterSettle();
    }, 0);
  }
  _fail(error) {
    this.error = error;
    setTimeout(() => { if (this.onerror) this.onerror({ target: this }); }, 0);
  }
}

class FakeStore {
  constructor(keyPath) { this.keyPath = keyPath; this.data = new Map(); }
}

class FakeObjectStore {
  constructor(tx, store) { this.tx = tx; this.store = store; }
  put(record) {
    const req = new FakeRequest();
    if (this.tx.db.factory.putError) {
      this.tx._failWith(this.tx.db.factory.putError);
      req._fail(this.tx.db.factory.putError);
      return req;
    }
    this.store.data.set(record[this.store.keyPath], record);
    this.tx._expect(req);
    req._succeed(record[this.store.keyPath]);
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
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._settled = false;
  }
  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) {
      const err = new Error(`object store ${name} not found`);
      this._failWith(err);
      throw err;
    }
    return new FakeObjectStore(this, store);
  }
  /** The commit race, made hostile: the transaction completes SYNCHRONOUSLY
      after its request's success handler returns. An adapter that awaited the
      request and only then assigned `tx.oncomplete` would already have missed
      this event, and its promise would never settle. */
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
  createObjectStore(name, { keyPath }) {
    this.stores.set(name, new FakeStore(keyPath));
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
  seed(storeName, records) {
    if (!this.db.stores.has(storeName)) this.db.createObjectStore(storeName, { keyPath: "key" });
    this._created = true;
    for (const r of records) {
      if (r && typeof r === "object" && "key" in r) this.db.stores.get(storeName).data.set(r.key, r);
      else this.db.stores.get(storeName).data.set(Symbol(), r);
    }
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

class FakeLocal {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
