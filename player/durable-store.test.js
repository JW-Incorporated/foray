/* player/durable-store.js — the store an eviction does not orphan (#40).

   WHAT THIS SUITE IS FOR
   The defect being fixed is silent data loss, so the tests are written around the
   ways this file could itself lose data rather than around its getters. Four of
   them are the acceptance criteria named in the issue:

     - MIGRATION: existing `cp_*` values are read, carried across, and never
       deleted — a listener mid-Foray when this ships must not lose their place
       TO THE FIX.
     - A REFUSED `navigator.storage.persist()`: a request a browser may say no
       to, which must change nothing except a recorded fact.
     - A FAILING WRITE SURFACES rather than vanishing, which is the whole point:
       `catch (_) {}` is how "silently forgot you" happens.
     - HYDRATION NEVER CLOBBERS THIS SESSION, because the fix racing the first
       paint is the one way it could cause the defect it fixes.

   No dependencies and no browser: every tier is injected, which is what makes
   the failure paths reachable at all. The IndexedDB adapter is tested separately
   (`idb-tier.test.js`) against a fake IDB — the split is deliberate, so the merge
   logic here is never obscured by request plumbing.
*/

import test from "node:test";
import assert from "node:assert/strict";

import {
  DurableStore, createDurableStore, localStorageTier, requestPersistence, isNewer,
  DEFAULT_PREFIX, HEALTH_KEY, LOCAL_STALE_KEY, MAX_FAULTS, preferencesTier, MAX_CONSECUTIVE_TIER_FAILURES,
  vaultTier, VAULT_PLUGIN, DEVICE_ONLY_KEYS,
  deferredPrefixesFor, engineDataDeletion, OWNER_TIER, EXTERNALLY_OWNED,
  OWNERSHIP_DEFERRED, OWNERSHIP_EXTERNAL, OWNERSHIP_RELEASED,
  PERSIST_GRANTED, PERSIST_DENIED, PERSIST_UNSUPPORTED, PERSIST_ERROR, PERSIST_UNKNOWN,
} from "./durable-store.js";
import { ForayProgressStore, makeProgress, readProgress, progressKey, listProgress } from "./foray-progress.js";
import { OWNED_PREFIXES } from "./engine-contract.js";
import { FAULT_KINDS } from "./engine-vocabulary.js";

/* ---------- fakes ----------

   `FakeLocal` implements the four members of the Storage interface the tier
   actually uses, and can fail the two ways a real one does: `QuotaExceededError`
   on write (a full 5 MB bucket) and `SecurityError` on everything (cookies
   blocked, some private modes). */
class FakeLocal {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failWrites = false;
    this.blocked = false;
    /* Per-key refusals, for the case a global switch cannot model: a bucket
       that is full for ONE big write while a durable tier still takes it. */
    this.refuse = null;
    this.refuseRemove = null;
  }
  get length() {
    if (this.blocked) throw securityError();
    return this.map.size;
  }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) {
    if (this.blocked) throw securityError();
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.blocked) throw securityError();
    if (this.failWrites) throw quotaError();
    if (this.refuse && this.refuse(k)) throw quotaError();
    this.map.set(k, String(v));
  }
  removeItem(k) {
    if (this.refuseRemove && this.refuseRemove(k)) throw securityError();
    this.map.delete(k);
  }
}

function quotaError() {
  const e = new Error("The quota has been exceeded.");
  e.name = "QuotaExceededError";
  return e;
}
function securityError() {
  const e = new Error("access is denied for this document");
  e.name = "SecurityError";
  return e;
}

/** An async, "durable" tier — stands in for IndexedDB and for the native
    Preferences tier the app will register later. */
function fakeDurable({ name = "idb", rows = {}, failWrite = false, failRead = false } = {}) {
  const store = new Map(Object.entries(rows));
  const tier = {
    name, sync: false, durable: true,
    store,
    reads: 0,
    writes: [],
    failWrite,
    failRead,
    async readAll(prefix) {
      tier.reads += 1;
      if (tier.failRead) throw new Error("readAll failed");
      const out = new Map();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(k, v) {
      if (tier.failWrite) throw new Error("put failed");
      tier.writes.push(k);
      store.set(k, String(v));
    },
    async remove(k) {
      if (tier.failWrite) throw new Error("delete failed");
      store.delete(k);
    },
  };
  return tier;
}

const ID = "grilling-history-1";
const PROGRESS_KEY = progressKey(ID);

/* `row_` rather than `row`: the trailing underscore keeps it out of the way of
   the local `const row = …` a couple of tests below want to use. */

function row_(over = {}) {
  return JSON.stringify(makeProgress({
    forayId: ID, title: "The history of grilling",
    elapsedSec: 1180, totalSec: 3673, index: 9,
    now: "2026-08-16T10:00:00.000Z", ...over,
  }));
}

/* ---------- the namespace and the facade ---------- */

test("the store owns the legacy cp_ prefix and nothing else", () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  assert.equal(s.prefix, DEFAULT_PREFIX);
  assert.ok(s.owns("cp_interests"));
  assert.ok(s.owns(PROGRESS_KEY));
  assert.ok(!s.owns("interests"));
  assert.ok(!s.owns("foray:cp_x"));
});

test("reads answer from memory before hydration — the first paint is not slower", () => {
  // Constructed over a localStorage that already has state, and asked for it
  // synchronously. No await anywhere: this is the property that let the whole
  // change happen without rewriting a single caller as async.
  const local = new FakeLocal({ cp_interests: '{"a":1}', [PROGRESS_KEY]: row_() });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable()] });
  assert.equal(JSON.parse(s.getItem("cp_interests")).a, 1);
  assert.equal(readProgress(s, ID).elapsed_sec, 1180);
});

test("a write lands in localStorage synchronously, before any queue is drained", () => {
  const local = new FakeLocal();
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  s.setItem("cp_interests", '{"a":2}');
  assert.equal(local.map.get("cp_interests"), '{"a":2}');
  assert.equal(idb.store.has("cp_interests"), false, "the durable write is behind, by design");
});

test("a write reaches the durable tier once the queue drains", async () => {
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  s.setItem("cp_interests", '{"a":3}');
  await s.flush();
  assert.equal(idb.store.get("cp_interests"), '{"a":3}');
});

test("writes reach the durable tier in the order they were made", async () => {
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  s.setItem("cp_a", "1");
  s.setItem("cp_b", "2");
  s.setItem("cp_a", "3");
  await s.flush();
  assert.deepEqual(idb.writes, ["cp_a", "cp_b", "cp_a"]);
  assert.equal(idb.store.get("cp_a"), "3");
});

test("length and key() enumerate the owned namespace, which is what listProgress walks", () => {
  const local = new FakeLocal({ [PROGRESS_KEY]: row_(), "cp_foray:other": row_({ forayId: "other" }) });
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  assert.equal(s.length, 2);
  const keys = [s.key(0), s.key(1)];
  assert.ok(keys.includes(PROGRESS_KEY));
  assert.equal(s.key(9), null);
  assert.equal(s.key(-1), null);
});

test("an unowned key passes through to localStorage and is not enumerated", () => {
  const local = new FakeLocal();
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  s.setItem("theme", "dark");
  assert.equal(local.map.get("theme"), "dark");
  assert.equal(s.getItem("theme"), "dark");
  assert.equal(s.length, 0, "the store's contract is the cp_ namespace, and it says so");
});

test("removeItem clears both tiers", async () => {
  const local = new FakeLocal({ [PROGRESS_KEY]: row_() });
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: row_() } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  s.removeItem(PROGRESS_KEY);
  await s.flush();
  assert.equal(s.getItem(PROGRESS_KEY), null);
  assert.equal(local.map.has(PROGRESS_KEY), false);
  assert.equal(idb.store.has(PROGRESS_KEY), false);
});

/* ---------- migration: the guarantee that nothing is lost to the fix ---------- */

test("MIGRATION: an existing cp_ row in localStorage is carried into the durable tier", async () => {
  const local = new FakeLocal({ cp_profile_id: '"p-abc"', cp_interests: '{"x":0.5}', [PROGRESS_KEY]: row_() });
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.equal(idb.store.get("cp_profile_id"), '"p-abc"');
  assert.equal(idb.store.get("cp_interests"), '{"x":0.5}');
  assert.equal(JSON.parse(idb.store.get(PROGRESS_KEY)).elapsed_sec, 1180);
});

test("MIGRATION: localStorage still has every row afterwards — nothing is deleted to move it", async () => {
  // The one guarantee that matters on ship day. localStorage is a MIRROR, not a
  // staging area, so there is no window in which a row exists in neither place.
  const before = { cp_profile_id: '"p-abc"', cp_sb_session: '{"user_id":"u1"}', [PROGRESS_KEY]: row_() };
  const local = new FakeLocal({ ...before });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable()] });
  await s.hydrate();
  for (const [k, v] of Object.entries(before)) assert.equal(local.map.get(k), v, `${k} was moved, not copied`);
});

test("MIGRATION: the anonymous session token is carried like everything else", async () => {
  // ADR-0005: auth.uid() from this token is the ONLY identity. #40 calls losing
  // it "the most damaging silent failure in the app".
  const session = '{"user_id":"u-1","access_token":"a","refresh_token":"r","expires_at":9}';
  const local = new FakeLocal({ cp_sb_session: session });
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.equal(idb.store.get("cp_sb_session"), session);
  assert.equal(JSON.parse(s.getItem("cp_sb_session")).user_id, "u-1");
});

test("MIGRATION: how many rows moved is in health(), not something to take on trust", async () => {
  const local = new FakeLocal({ cp_a: "1", cp_b: "2" });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable()] });
  await s.hydrate();
  assert.equal(s.health().tiers.idb.migrated, 2);
  assert.equal(s.health().hydrated, true);
});

test("MIGRATION: a row the durable tier already has is not rewritten every launch", async () => {
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  const local = new FakeLocal({ cp_a: "1", cp_b: "2" });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.deepEqual(idb.writes, ["cp_b"]);
});

test("MIGRATION: hydrate() is memoised, so ten callers cost one read per tier", async () => {
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  await Promise.all([s.hydrate(), s.hydrate(), s.hydrate()]);
  await s.hydrate();
  assert.equal(idb.reads, 1);
});

/* ---------- eviction: the defect, from the other side ---------- */

test("EVICTION: localStorage wiped, durable tier intact — the position comes back", async () => {
  // This is the listener the issue is about: 20 minutes into a 61-minute Foray,
  // back a week later, localStorage swept by Safari.
  const local = new FakeLocal();                      // evicted: empty
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: row_(), cp_profile_id: '"p-abc"' } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  assert.equal(s.getItem(PROGRESS_KEY), null, "before hydration there is genuinely nothing");
  await s.hydrate();
  assert.equal(readProgress(s, ID).elapsed_sec, 1180);
  assert.equal(JSON.parse(s.getItem("cp_profile_id")), "p-abc");
});

test("EVICTION: a restored row is written back into localStorage, so the fast path has it too", async () => {
  const local = new FakeLocal();
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: row_() } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.equal(local.map.get(PROGRESS_KEY), row_());
});

/* ---------- hydration must not clobber this session ---------- */

test("CLOBBER: a value written before hydration finishes survives it", async () => {
  // The fix causing the defect: page reads an evicted (empty) cp_interests,
  // writes defaults, and only then hears back from IndexedDB. Without this rule
  // the defaults would win and the profile would be gone.
  const local = new FakeLocal();
  const idb = fakeDurable({ rows: { cp_interests: '{"learned":0.9}' } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  s.setItem("cp_interests", '{"default":0.1}');
  await s.hydrate();
  assert.equal(s.getItem("cp_interests"), '{"default":0.1}');
});

test("CLOBBER: and the session's value is pushed DOWN over the durable one", async () => {
  const idb = fakeDurable({ rows: { cp_interests: '{"learned":0.9}' } });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  s.setItem("cp_interests", '{"default":0.1}');
  await s.hydrate();
  assert.equal(idb.store.get("cp_interests"), '{"default":0.1}');
});

test("CLOBBER: a key REMOVED this session is not resurrected by hydration", async () => {
  // "Start over" clears a Foray's row. A durable copy that comes back afterwards
  // would undo the only destructive thing a listener can ask for.
  const local = new FakeLocal({ [PROGRESS_KEY]: row_() });
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: row_() } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  s.removeItem(PROGRESS_KEY);
  await s.hydrate();
  assert.equal(s.getItem(PROGRESS_KEY), null);
  await s.flush();
  assert.equal(idb.store.has(PROGRESS_KEY), false);
});

/* ---------- conflicts ---------- */

test("CONFLICT: the row with the later updated_at wins", async () => {
  const older = row_({ elapsedSec: 100, now: "2026-08-10T00:00:00.000Z" });
  const newer = row_({ elapsedSec: 2000, now: "2026-08-15T00:00:00.000Z" });
  const local = new FakeLocal({ [PROGRESS_KEY]: older });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable({ rows: { [PROGRESS_KEY]: newer } })] });
  await s.hydrate();
  assert.equal(readProgress(s, ID).elapsed_sec, 2000);
});

test("CONFLICT: a local row that is newer is kept, not overwritten by the durable copy", async () => {
  const older = row_({ elapsedSec: 100, now: "2026-08-10T00:00:00.000Z" });
  const newer = row_({ elapsedSec: 2000, now: "2026-08-15T00:00:00.000Z" });
  const local = new FakeLocal({ [PROGRESS_KEY]: newer });
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: older } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.equal(readProgress(s, ID).elapsed_sec, 2000);
  assert.equal(idb.store.get(PROGRESS_KEY), newer, "and it is pushed down");
});

test("CONFLICT: local wins when neither side is dated — a coin flip is not an answer", async () => {
  const local = new FakeLocal({ cp_interests: '{"local":1}' });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable({ rows: { cp_interests: '{"idb":1}' } })] });
  await s.hydrate();
  assert.equal(s.getItem("cp_interests"), '{"local":1}');
});

test("CONFLICT: local wins when only the DURABLE side carries a timestamp", async () => {
  // An undated local row is not automatically the loser: it is what this session
  // has been reading, and "the other one at least has a date" is not evidence.
  const local = new FakeLocal({ cp_interests: '{"local":1}' });
  const s = new DurableStore({
    tiers: [localStorageTier(local), fakeDurable({ rows: { cp_interests: '{"updated_at":"2030-01-01T00:00:00.000Z"}' } })],
  });
  await s.hydrate();
  assert.equal(s.getItem("cp_interests"), '{"local":1}');
});

test("CONFLICT: corrupt JSON on either side resolves to local, without throwing", async () => {
  const local = new FakeLocal({ cp_a: "{not json", cp_b: '{"updated_at":"2026-08-15T00:00:00.000Z"}' });
  const s = new DurableStore({
    tiers: [localStorageTier(local), fakeDurable({ rows: { cp_a: '{"updated_at":"2030-01-01T00:00:00.000Z"}', cp_b: "also not json" } })],
  });
  await s.hydrate();
  assert.equal(s.getItem("cp_a"), "{not json");
  assert.equal(s.getItem("cp_b"), '{"updated_at":"2026-08-15T00:00:00.000Z"}');
});

test("isNewer compares updated_at, updatedAt and ts, and refuses to guess otherwise", () => {
  const a = '{"updated_at":"2026-08-15T00:00:00.000Z"}';
  const b = '{"updated_at":"2026-08-10T00:00:00.000Z"}';
  assert.equal(isNewer(a, b), true);
  assert.equal(isNewer(b, a), false);
  assert.equal(isNewer('{"ts":"2026-08-15T00:00:00.000Z"}', '{"ts":"2026-08-10T00:00:00.000Z"}'), true);
  assert.equal(isNewer('{"updatedAt":"2026-08-15T00:00:00.000Z"}', b), true);
  assert.equal(isNewer('{"updated_at":"nonsense"}', b), false);
  assert.equal(isNewer("[]", b), false);
  assert.equal(isNewer("nope", b), false);
});

/* ---------- persist(): a request a browser may refuse ---------- */

test("PERSIST: a refusal is a recorded fact and changes nothing else", async () => {
  const local = new FakeLocal();
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable()] });
  const out = await s.requestPersistence({ storage: { persist: async () => false, persisted: async () => false } });
  assert.equal(out.state, PERSIST_DENIED);
  assert.equal(s.health().persisted, PERSIST_DENIED);
  // The store still works, all of it — a refusal is not a failure path.
  s.setItem("cp_interests", '{"a":1}');
  await s.flush();
  assert.equal(local.map.get("cp_interests"), '{"a":1}');
  assert.equal(s.health().tiers.idb.writes >= 1, true);
});

test("PERSIST: a granted request is recorded, and an already-granted origin is not asked again", async () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  let asked = 0;
  const out = await s.requestPersistence({ storage: { persist: async () => { asked += 1; return true; }, persisted: async () => true } });
  assert.equal(out.state, PERSIST_GRANTED);
  assert.equal(out.already, true);
  assert.equal(asked, 0, "some engines count repeat prompts against you");
});

test("PERSIST: an engine without StorageManager reads as unsupported, not denied", async () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  assert.equal((await s.requestPersistence({})).state, PERSIST_UNSUPPORTED);
  assert.equal((await s.requestPersistence(null)).state, PERSIST_UNSUPPORTED);
  assert.equal((await s.requestPersistence({ storage: {} })).state, PERSIST_UNSUPPORTED);
});

test("PERSIST: a throwing persist() is a state, never an exception", async () => {
  const out = await requestPersistence({ storage: { persist: async () => { throw new Error("nope"); } } });
  assert.equal(out.state, PERSIST_ERROR);
  assert.match(out.error, /nope/);
});

test("PERSIST: unasked reads as unknown rather than as a granted default", () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  assert.equal(s.health().persisted, PERSIST_UNKNOWN);
});

/* ---------- a failing write must surface ---------- */

test("FAILURE: with no tier willing to take it, setItem THROWS", () => {
  // Real Storage throws on quota, and `writeProgress`'s `return false` depends
  // on it: a facade that swallowed here would make the resume store report
  // success while forgetting the listener.
  const local = new FakeLocal();
  local.failWrites = true;
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  assert.throws(() => s.setItem("cp_interests", '{"a":1}'), /no storage tier accepted cp_interests/);
});

test("FAILURE: and writeProgress therefore still returns false", () => {
  const local = new FakeLocal();
  local.failWrites = true;
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  const store = new ForayProgressStore({ storage: s });
  assert.equal(store.save({ forayId: ID, elapsedSec: 1180, totalSec: 3673 }), false);
  assert.equal(store.refusedWrites, 1, "the refusal is counted, not swallowed");
});

test("FAILURE: the fault names the tier, the operation, the key and the reason", () => {
  const local = new FakeLocal();
  local.failWrites = true;
  const s = new DurableStore({ tiers: [localStorageTier(local)], now: () => 1755300000000 });
  try { s.setItem("cp_interests", "1"); } catch (_) {}
  const h = s.health();
  assert.equal(h.ok, false);
  const f = h.faults[0];
  assert.equal(f.tier, "local");
  assert.equal(f.op, "write");
  assert.equal(f.key, "cp_interests");
  assert.match(f.error, /QuotaExceededError/);
  assert.equal(f.at, 1755300000000);
  assert.equal(h.tiers.local.failures >= 1, true);
});

test("FAILURE: onFault fires once per failure, with the fault and the health record", () => {
  const local = new FakeLocal();
  local.failWrites = true;
  const seen = [];
  const s = new DurableStore({
    tiers: [localStorageTier(local)],
    onFault: (fault, health) => seen.push([fault.key, health.ok]),
  });
  try { s.setItem("cp_interests", "1"); } catch (_) {}
  assert.deepEqual(seen, [["cp_interests", false]]);
});

test("FAILURE: a fault sink that itself fails cannot recurse", () => {
  // app.js's sink writes an event, which writes to storage. If storage is the
  // thing that is broken, that is a loop unless it is guarded.
  const local = new FakeLocal();
  local.failWrites = true;
  let calls = 0;
  const s = new DurableStore({
    tiers: [localStorageTier(local)],
    onFault: () => { calls += 1; s.setItem("cp_events", "[]"); },
  });
  try { s.setItem("cp_interests", "1"); } catch (_) {}
  assert.equal(calls, 1);
});

test("FAILURE: a working durable tier means the write DID land, so setItem does not throw", async () => {
  // localStorage full but IndexedDB fine is the common quota case, and it is a
  // success: the value is durable. The local failure is still recorded.
  const local = new FakeLocal();
  local.failWrites = true;
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  s.setItem("cp_interests", '{"a":1}');
  await s.flush();
  assert.equal(idb.store.get("cp_interests"), '{"a":1}');
  assert.equal(s.health().tiers.local.failures >= 1, true);
  assert.equal(s.health().ok, false);
});

test("FAILURE: a durable write that fails LATER is in health() after the flush", async () => {
  // The one failure setItem cannot report, because it has not happened yet. It
  // must not therefore be invisible.
  const idb = fakeDurable({ failWrite: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  s.setItem("cp_interests", '{"a":1}');       // does not throw: localStorage took it
  const h = await s.flush();
  assert.equal(h.ok, false);
  assert.equal(h.tiers.idb.failures >= 1, true);
  assert.match(h.faults.at(-1).error, /put failed/);
  assert.equal(h.pending, 0);
});

test("FAILURE: a durable tier that cannot be READ is a fault, and the session still works", async () => {
  const local = new FakeLocal({ cp_interests: '{"a":1}' });
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable({ failRead: true })] });
  await s.hydrate();
  assert.equal(s.getItem("cp_interests"), '{"a":1}');
  assert.equal(s.health().ok, false);
  assert.equal(s.health().faults[0].op, "read");
});

test("FAILURE: a localStorage blocked outright is a recorded read fault, not a crash", () => {
  const local = new FakeLocal({ cp_interests: '{"a":1}' });
  local.blocked = true;
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable()] });
  assert.equal(s.health().ok, false);
  assert.equal(s.health().faults[0].op, "read");
  assert.match(s.health().faults[0].error, /SecurityError/);
});

test("FAILURE: no tiers at all still refuses loudly and records it", () => {
  const s = new DurableStore({ tiers: [] });
  assert.throws(() => s.setItem("cp_interests", "1"), /no storage tier accepted/);
  assert.equal(s.health().ok, false);
  assert.equal(s.health().faults[0].tier, "none");
  assert.deepEqual(s.health().durableTiers, []);
  // and reads still work for the length of the session
  assert.equal(s.getItem("cp_interests"), "1");
});

test("FAILURE: faults are capped, so a permanently dead tier cannot grow without bound", () => {
  const local = new FakeLocal();
  local.failWrites = true;
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  for (let i = 0; i < MAX_FAULTS + 12; i++) {
    try { s.setItem(`cp_k${i}`, "1"); } catch (_) {}
  }
  assert.equal(s.health().faults.length, MAX_FAULTS);
  assert.equal(s.health().tiers.local.failures >= MAX_FAULTS + 12, true, "the COUNT is not capped, only the detail");
});

/* ---------- the health record itself ---------- */

test("HEALTH: the record is mirrored into storage under a cp_ key", async () => {
  const local = new FakeLocal();
  const s = new DurableStore({ tiers: [localStorageTier(local), fakeDurable({ failWrite: true })] });
  s.setItem("cp_a", "1");
  await s.flush();                                     // the durable write fails here
  const blob = JSON.parse(local.map.get(HEALTH_KEY));
  assert.equal(blob.ok, false);
  assert.equal(blob.tiers.idb.failures >= 1, true);
  assert.ok(HEALTH_KEY.startsWith("cp_"), "renaming it would be a new key, and CLAUDE.md forbids that");
});

test("HEALTH: when localStorage is the BROKEN tier the record is memory-only, and that is stated", () => {
  // The honest limit of the mirror: it cannot be written to the thing that is
  // refusing writes. `health()` is assembled from memory precisely so that this
  // case still has an answer, and `window.forayStorageHealth()` is how a human
  // reaches it.
  const local = new FakeLocal();
  local.failWrites = true;
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  try { s.setItem("cp_a", "1"); } catch (_) {}
  assert.equal(local.map.has(HEALTH_KEY), false);
  assert.equal(s.health().ok, false);
  assert.equal(JSON.parse(s.getItem(HEALTH_KEY)).ok, false, "memory still has it");
});

test("HEALTH: the diagnostic key is never treated as user state", async () => {
  // Adopting or migrating it would make one device's fault log another device's
  // truth, and would grow the namespace with something nothing reads.
  const idb = fakeDurable({ rows: { [HEALTH_KEY]: '{"ok":false}' } });
  const local = new FakeLocal({ cp_a: "1" });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  assert.equal(idb.store.has(HEALTH_KEY), true, "it was already there; we did not remove it");
  assert.deepEqual(idb.writes, ["cp_a"], "and we neither migrated it up nor rewrote it");
});

test("HEALTH: it reports which tiers are durable, honestly", async () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), fakeDurable()] });
  assert.deepEqual(s.health().durableTiers, ["idb"]);
  const localOnly = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  assert.deepEqual(localOnly.health().durableTiers, [], "no durable tier is stated, not implied");
  assert.equal(localOnly.health().tiers.local.durable, false);
});

test("HEALTH: flush() resolves with the record and pending returns to zero", async () => {
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), fakeDurable()] });
  s.setItem("cp_a", "1");
  s.setItem("cp_b", "2");
  const h = await s.flush();
  assert.equal(h.pending, 0);
  assert.equal(h.ok, true);
});

/* ---------- the wiring helper ---------- */

test("createDurableStore drops a tier it cannot have rather than faking one", () => {
  const s = createDurableStore({ localStorage: new FakeLocal(), idbTier: null });
  assert.deepEqual(s.health().durableTiers, []);
  assert.equal(Object.keys(s.health().tiers).join(","), "local");
  const none = createDurableStore({ localStorage: null, idbTier: null });
  assert.deepEqual(Object.keys(none.health().tiers), []);
});

test("createDurableStore with both tiers round-trips a Foray position through the durable one", async () => {
  const local = new FakeLocal();
  const idb = fakeDurable();
  const s = createDurableStore({ localStorage: local, idbTier: idb });
  const store = new ForayProgressStore({ storage: s });
  assert.equal(store.save({ forayId: ID, title: "t", elapsedSec: 1180, totalSec: 3673, index: 9 }), true);
  await s.flush();
  assert.equal(JSON.parse(idb.store.get(PROGRESS_KEY)).elapsed_sec, 1180);
  assert.equal(store.refusedWrites, 0);
});

test("END TO END: write, evict localStorage, reopen — the listener keeps their place", async () => {
  // The whole feature in one test. Two DurableStores over the same durable tier
  // is exactly "the same browser next week", and the wipe is the eviction.
  const idb = fakeDurable();
  const first = createDurableStore({ localStorage: new FakeLocal(), idbTier: idb });
  await first.hydrate();
  new ForayProgressStore({ storage: first }).save({
    forayId: ID, title: "The history of grilling", elapsedSec: 1180, totalSec: 3673, index: 9,
  });
  await first.flush();

  const afterEviction = createDurableStore({ localStorage: new FakeLocal(), idbTier: idb });
  await afterEviction.hydrate();
  const back = new ForayProgressStore({ storage: afterEviction }).get(ID);
  assert.equal(back.elapsed_sec, 1180);
  assert.equal(back.index, 9);
  assert.equal(back.title, "The history of grilling");
});

/* ======================================== the four bugs review found ==========

   All four were live in the first draft of `durable-store.js`, all four lose or
   corrupt user state, and none of them was caught by the fifty tests above. They
   are grouped here so that a future change that reintroduces one fails against a
   test that names it. */

test("REVIEW #1: a permanently failing durable tier cannot self-feed through onFault", () => {
  /* The measured loop: a durable write fails asynchronously → `_fault` → the
     app's sink logs an event → logging is a WRITE → queued to the same dead tier
     → fails → faults. `_inFault` cannot stop it: the failure arrives on a later
     tick with the guard already cleared. Review measured 400 events from ONE user
     write. Two brakes now — a notification budget and a circuit breaker.

     Synchronous version of the same loop, so the assertion is not about timing:
     a sink that writes, against tiers that both refuse. */
  const local = new FakeLocal();
  local.failWrites = true;
  let sinkCalls = 0;
  const s = new DurableStore({
    tiers: [localStorageTier(local)],
    onFault: () => { sinkCalls += 1; try { s.setItem("cp_events", "[]"); } catch (_) {} },
  });
  for (let i = 0; i < 200; i++) { try { s.setItem(`cp_k${i}`, "1"); } catch (_) {} }
  assert.ok(sinkCalls <= MAX_FAULTS, `the sink was notified ${sinkCalls} times; the budget is ${MAX_FAULTS}`);
});

test("REVIEW #1: a durable tier that keeps failing is dropped from the write path", async () => {
  const idb = fakeDurable({ failWrite: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  for (let i = 0; i < MAX_CONSECUTIVE_TIER_FAILURES + 3; i++) {
    s.setItem(`cp_k${i}`, "1");
    await s.flush();
  }
  const h = s.health();
  assert.equal(h.tiers.idb.disabled, true);
  assert.deepEqual(h.durableTiers, [], "a dropped tier is not durability, whatever it claims");
  assert.ok(h.tiers.idb.failures <= MAX_CONSECUTIVE_TIER_FAILURES,
    `it kept being asked: ${h.tiers.idb.failures} failures`);
});

test("REVIEW #1: once every durable tier is dropped, setItem goes back to throwing honestly", async () => {
  const local = new FakeLocal();
  const idb = fakeDurable({ failWrite: true });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  for (let i = 0; i < MAX_CONSECUTIVE_TIER_FAILURES; i++) { s.setItem(`cp_k${i}`, "1"); await s.flush(); }
  local.failWrites = true;
  assert.throws(() => s.setItem("cp_late", "1"), /no storage tier accepted/,
    "with the breaker open and localStorage full, nothing took the value and the caller must hear so");
});

test("REVIEW #1: a tier that recovers is not punished for an earlier failure", async () => {
  const idb = fakeDurable({ failWrite: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  s.setItem("cp_a", "1");
  await s.flush();
  idb.failWrite = false;
  s.setItem("cp_b", "2");
  await s.flush();
  assert.equal(s.health().tiers.idb.disabled, false, "consecutive failures reset on a success");
  assert.equal(idb.store.get("cp_b"), "2");
});

test("REVIEW #2: a remove DURING hydration is not resurrected by the migration", async () => {
  /* `removeItem` rides the write queue and migration used to write directly, so
     the two were unordered and migration's pre-taken snapshot wrote the row back
     down. `app.js` races hydration against a timeout and proceeds while it is
     still running, so "Start over" mid-hydration is a real sequence. */
  const row = row_();
  const local = new FakeLocal({ [PROGRESS_KEY]: row });
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  const hydrating = s.hydrate();
  s.removeItem(PROGRESS_KEY);          // mid-flight, exactly as the page can
  await hydrating;
  await s.flush();
  assert.equal(s.getItem(PROGRESS_KEY), null);
  assert.equal(local.map.has(PROGRESS_KEY), false);
  assert.equal(idb.store.has(PROGRESS_KEY), false, "the deleted position came back");

  // And it stays gone across a reload.
  const next = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  await next.hydrate();
  assert.equal(next.getItem(PROGRESS_KEY), null);
});

test("REVIEW #2: a value CHANGED during hydration is migrated at its new value", async () => {
  const local = new FakeLocal({ cp_a: "old" });
  const idb = fakeDurable();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  const hydrating = s.hydrate();
  s.setItem("cp_a", "new");
  await hydrating;
  await s.flush();
  assert.equal(idb.store.get("cp_a"), "new", "migration must read memory, not a stale snapshot");
});

test("REVIEW #3: a tier whose readAll FAILED is not blindly overwritten", async () => {
  /* "I could not look" is not "I saw nothing". The durable tier here holds 50
     minutes of progress; localStorage holds a stale mirror because an earlier
     write was refused. A transient read failure used to push the mirror down over
     the real row — permanent loss out of a recoverable state. */
  const durableRow = row_({ elapsedSec: 3000, now: "2026-08-16T12:00:00.000Z" });
  const staleLocal = row_({ elapsedSec: 60, now: "2026-08-16T10:00:00.000Z" });
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: durableRow }, failRead: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ [PROGRESS_KEY]: staleLocal })), idb] });
  await s.hydrate();
  await s.flush();
  assert.equal(JSON.parse(idb.store.get(PROGRESS_KEY)).elapsed_sec, 3000, "50 minutes of progress was overwritten");
  assert.equal(s.health().ok, false, "and the read failure is still recorded");
});

test("REVIEW #3: but a write made THIS session still reaches an unreadable tier", async () => {
  // The one class of key we know is newer than whatever is down there.
  const idb = fakeDurable({ rows: { cp_a: "theirs" }, failRead: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_b: "stale" })), idb] });
  s.setItem("cp_a", "mine");
  await s.hydrate();
  await s.flush();
  assert.equal(idb.store.get("cp_a"), "mine");
  assert.equal(idb.store.get("cp_b"), undefined, "and the unwritten mirror is left alone");
});

test("REVIEW #4: cp_storage_health is not counted as user state", () => {
  /* A persist REFUSAL writes the health record, and a refusal is the expected
     case on Safari and on any non-engaged Chromium origin — so this fired on
     essentially every real load. `length` claimed one row more than exists. */
  const local = new FakeLocal({ cp_a: "1" });
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  assert.equal(s.length, 1);
  s._recordHealth();
  assert.equal(s.length, 1, "the diagnostic key inflated the namespace");
  assert.deepEqual([s.key(0)], ["cp_a"]);
  assert.equal(s.key(1), null);
  assert.equal(s.health().keys, 1);
  assert.ok(s.getItem(HEALTH_KEY), "and it is still readable, just not user state");
});

test("localStorageTier refuses an object that is not Storage-shaped", () => {
  assert.equal(localStorageTier(null), null);
  assert.equal(localStorageTier({}), null);
  assert.equal(localStorageTier({ getItem() {} }), null);
  assert.ok(localStorageTier(new FakeLocal()));
});

/* ---------- purge: the listener asked for all of it to go (#42) ----------

   The control that calls this lives in app.js and is tested end to end in
   `test/data-deletion.test.js`. What belongs here is the store's own contract:
   which keys it finds, which tiers it clears, and — the part that decides whether
   a delete button may say "done" — what it reports when it could not finish. */

test("PURGE clears every owned key from both tiers and reports what it removed", async () => {
  const rows = {
    cp_interests: '{"a":1}', cp_seen: "[]", [PROGRESS_KEY]: row_(),
    "cp_pos:ep-1": '{"seconds":10}', "cp_pos:ep-2": '{"seconds":20}',
  };
  const local = new FakeLocal({ ...rows });
  const idb = fakeDurable({ rows: { ...rows } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();

  const out = await s.purge();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.remaining, []);
  assert.deepEqual(out.unverified, []);
  assert.deepEqual(out.keys.sort(), Object.keys(rows).sort());
  assert.deepEqual([...local.map.keys()], [], "localStorage still holds rows");
  assert.deepEqual([...idb.store.keys()], [], "the durable tier still holds rows");
  assert.equal(s.length, 0);
  assert.equal(s.getItem("cp_interests"), null);
});

test("PURGE finds a row only the durable tier has — the one a facade walk misses", async () => {
  const idb = fakeDurable({ rows: {} });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_seen: "[]" })), idb] });
  await s.hydrate();
  // Written behind the store's back, exactly as another tab (or a hydration that
  // failed on an earlier load) leaves it.
  idb.store.set("cp_pos:ep-9", '{"seconds":99}');
  assert.ok(!Array.from({ length: s.length }, (_, i) => s.key(i)).includes("cp_pos:ep-9"));

  const out = await s.purge();
  assert.ok(out.keys.includes("cp_pos:ep-9"), "the durable-only row was never targeted");
  assert.equal(out.ok, true);
  assert.deepEqual([...idb.store.keys()], []);
});

test("PURGE clears cp_storage_health, which the facade deliberately does not list", async () => {
  const local = new FakeLocal({ cp_a: "1" });
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  s._recordHealth();
  assert.equal(s.length, 1, "premise: the diagnostic is hidden from the facade");
  assert.ok(local.map.has(HEALTH_KEY));

  const out = await s.purge();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...local.map.keys()], [], "the diagnostic record survived the purge");
});

test("PURGE leaves unowned keys alone", async () => {
  const local = new FakeLocal({ cp_a: "1", other_thing: "keep me" });
  const s = new DurableStore({ tiers: [localStorageTier(local)] });
  await s.purge();
  assert.deepEqual([...local.map.keys()], ["other_thing"]);
});

test("PURGE does NOT report ok when a tier keeps the rows anyway", async () => {
  // A tier whose `remove` resolves and does nothing: the silent no-op, and the
  // only thing standing between it and a false "your data is gone" is the
  // verifying re-read.
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  idb.remove = async () => {};
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_a: "1" })), idb] });
  await s.hydrate();

  const out = await s.purge();
  assert.equal(out.ok, false, "a tier that kept its rows is not a successful deletion");
  assert.deepEqual(out.remaining, ["cp_a"]);
});

test("PURGE reports a tier it could not READ rather than calling it empty", async () => {
  const idb = fakeDurable({ rows: { cp_a: "1" }, failRead: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_a: "1" })), idb] });
  const out = await s.purge();
  assert.equal(out.ok, false, `"I could not look" is not "it is empty": ${JSON.stringify(out)}`);
  assert.deepEqual(out.unverified.map((u) => `${u.tier}:${u.phase}`), ["idb:before", "idb:after"]);
  // Both phases, and both matter: `before` means keys may have been missed,
  // `after` means the deletion cannot be confirmed.
  assert.ok(out.unverified.every((u) => /readAll failed/.test(u.reason)));
});

test("PURGE re-arms a tier the circuit breaker had dropped", async () => {
  /* The breaker exists to stop a fault loop, not to refuse a listener. A dropped
     tier that is never asked again is a tier whose rows survive a deletion. */
  const idb = fakeDurable({ rows: {}, failWrite: true });
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal()), idb] });
  for (let i = 0; i < MAX_CONSECUTIVE_TIER_FAILURES; i++) {
    s.setItem(`cp_k${i}`, "1");
    await s.flush();
  }
  assert.equal(s.health().tiers.idb.disabled, true, "premise: the breaker dropped it");

  idb.failWrite = false;
  idb.store.set("cp_left_behind", "1");
  const out = await s.purge();
  assert.ok(out.keys.includes("cp_left_behind"));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...idb.store.keys()], []);
});

test("PURGE marks every key dirty, so a late hydration cannot resurrect one", async () => {
  /* The sequence: purge finishes, and only then does a slow `readAll` from an
     earlier hydrate() come back holding the rows. Without the dirty marks it
     would adopt them and write them back up into localStorage. */
  const local = new FakeLocal({ cp_a: "1" });
  let release;
  const gate = new Promise((r) => { release = r; });
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  let reads = 0;
  const slow = {
    ...idb,
    /* Only the FIRST read — hydration's — is parked, or the purge's own read
       deadlocks on the same gate.
       AND IT SNAPSHOTS BEFORE PARKING. Review caught the first version returning
       `idb.readAll(p)` AFTER the gate opened: by then the purge had emptied the
       tier, so hydration adopted nothing and the test passed with `_dirty`
       deleted. A late read has to carry the rows it saw when it was issued —
       that is what "answers late" means. */
    async readAll(p) {
      reads += 1;
      if (reads > 1) return idb.readAll(p);
      const snapshot = await idb.readAll(p);
      await gate;
      return snapshot;
    },
  };
  const s = new DurableStore({ tiers: [localStorageTier(local), slow] });

  const hydrating = s.hydrate();
  const out = await s.purge();
  release();
  await hydrating;
  await s.flush();

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(s.getItem("cp_a"), null, "hydration put a purged row back");
  assert.deepEqual([...local.map.keys()], [], "and wrote it back into localStorage");
});

test("PURGE on a store with no tiers at all still empties memory and says ok", async () => {
  // A browser that has taken storage away: there is nothing to delete, and
  // claiming failure would be as wrong as claiming a deletion that did not happen.
  const s = new DurableStore({ tiers: [] });
  try { s.setItem("cp_a", "1"); } catch (_) { /* expected: no tier took it */ }
  const out = await s.purge();
  assert.equal(out.ok, true);
  assert.equal(s.getItem("cp_a"), null);
});

test("PURGE is safe to run twice, and the second run finds nothing", async () => {
  const local = new FakeLocal({ cp_a: "1" });
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  await s.purge();
  const second = await s.purge();
  assert.equal(second.ok, true);
  assert.deepEqual(second.keys, []);
});

test("PURGE then a fresh write: the store keeps working, which is how resume recovers", async () => {
  const local = new FakeLocal({ [PROGRESS_KEY]: row_() });
  const idb = fakeDurable({ rows: { [PROGRESS_KEY]: row_() } });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();
  await s.purge();

  const store = new ForayProgressStore({ storage: s });
  assert.equal(store.save({
    forayId: ID, title: "The history of grilling", elapsedSec: 42, totalSec: 3673, index: 0, force: true,
  }), true);
  await s.flush();
  assert.equal(readProgress(s, ID).elapsed_sec, 42);
  assert.ok(idb.store.has(PROGRESS_KEY), "the new row is not durable");
  assert.equal(store.refusedWrites, 0);
});

test("PURGE: a tier that cannot be ENUMERATED at all is unverified, with nothing left behind", async () => {
  /* The gap review found: every other unreadable-tier case raises a FAULT, and a
     fault writes `cp_storage_health`, which lands in `remaining` — so `ok: false`
     was coming out for the wrong reason and the `unverified` half of the `ok`
     rule was never independently asserted. A tier with no `readAll` raises no
     fault, leaves `remaining` empty, and must STILL refuse to report success:
     a whole tier we could not look inside is not a tier we cleared. */
  const opaque = {
    name: "opaque", sync: false, durable: true,
    async write() {}, async remove() {},
    // no readAll, and none is coming
  };
  const s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_a: "1" })), opaque] });
  const out = await s.purge();
  assert.deepEqual(out.remaining, [], "nothing is left behind, and that is not the point");
  assert.deepEqual(out.unverified.map((u) => `${u.tier}:${u.phase}`), ["opaque:before", "opaque:after"]);
  assert.equal(out.ok, false, "an un-enumerable tier must not be reported as cleared");
  assert.equal(out.faults, 0, "and it is not a fault — there was nothing to fail");
});

test("PURGE reports a row written while it was verifying — memory is what getItem answers", async () => {
  /* `remaining` is assembled from the tiers AND from memory, because memory is
     what `getItem` answers from: a row still in it is still the listener's data,
     whatever the tiers say. The reachable case is a write that lands after the
     removals — here, from inside the verifying read itself, which is the only way
     to time it deterministically. (`app.js` stops the player before deleting so
     this is not the ordinary case; it is why the line exists anyway.) */
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  let s = null;
  let reads = 0;
  const watcher = {
    ...idb,
    async readAll(p) {
      reads += 1;
      const rows = await idb.readAll(p);
      if (reads === 2) s.setItem("cp_late", "1");   // the verification pass
      return rows;
    },
  };
  s = new DurableStore({ tiers: [localStorageTier(new FakeLocal({ cp_a: "1" })), watcher] });

  const out = await s.purge();
  assert.equal(reads, 2, "premise: one read to find the keys, one to verify");
  assert.deepEqual(out.remaining, ["cp_late"], `a row readable through the facade went unreported: ${JSON.stringify(out)}`);
  assert.equal(out.ok, false);
  assert.equal(s.getItem("cp_late"), "1", "and it really is still readable");
});

test("PURGE never leaves a diagnostic record of its OWN failure behind", async () => {
  /* A fault writes `cp_storage_health`, so without the suppression in `purge()` a
     permanently failing tier turns deleting that key into creating it: every
     failed run would report a key the purge itself wrote, and a listener who
     asked for deletion would be left with a NEW row. What they get instead is an
     honest failure naming only what really survived. */
  const idb = fakeDurable({ rows: { cp_a: "1" } });
  idb.remove = async () => { throw new Error("delete failed"); };
  const local = new FakeLocal({ cp_a: "1" });
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.hydrate();

  const out = await s.purge();
  assert.equal(out.ok, false, "the tier kept the row, so this is a failure");
  assert.ok(out.faults > 0, "premise: a fault was raised, and a fault writes the health record");
  assert.deepEqual(out.remaining, ["cp_a"], "only the row that really survived");
  assert.equal(local.map.has(HEALTH_KEY), false, "the purge wrote a key into the storage it was emptying");
  assert.equal(s.health().ok, false, "and the fault is still reported through health()");
});

test("PURGE restores health recording afterwards, even when it threw", async () => {
  // The suppression is scoped to the call. A store that stopped recording faults
  // after one purge would go quietly blind for the rest of the session.
  const idb = fakeDurable({ rows: {} });
  idb.readAll = async () => { throw new Error("boom"); };
  const local = new FakeLocal();
  const s = new DurableStore({ tiers: [localStorageTier(local), idb] });
  await s.purge();
  s._recordHealth();
  assert.ok(local.map.has(HEALTH_KEY), "health recording never came back on");
});

/* ---------- a mirror that refused a write (2026-09-22 audit, property 4) ----------

   The revert: localStorage refuses ONE write (a full bucket), IndexedDB takes
   it, `setItem` returns normally because something did. Next launch, hydration
   compared the stale mirror with the good durable row, found no timestamp on
   either — `cp_queue`, `cp_saved`, `cp_interests`, `cp_sb_session` and a dozen
   more carry none — let local win, and pushed it DOWN over the good copy. The
   listener's change was undone and then lost for good.

   MUTATION THAT KILLS THESE: drop `staleHere.has(k) ||` from `_doHydrate`'s
   conflict line — the three per-key tests go red, the durable row overwritten. */

/** "The same browser tomorrow": a new store over the same two backings. */
function relaunch(local, idb) {
  return new DurableStore({ tiers: [localStorageTier(local), idb] });
}

for (const key of ["cp_queue", "cp_sb_session", "cp_interests"]) {
  test(`a write localStorage refused is still there next launch, and the durable copy survives — ${key}`, async () => {
    const before = JSON.stringify({ v: "before" });
    const after = JSON.stringify({ v: "after" });
    const local = new FakeLocal({ [key]: before });
    const idb = fakeDurable({ rows: { [key]: before } });
    const first = relaunch(local, idb);
    await first.hydrate();

    local.refuse = (k) => k === key;
    assert.doesNotThrow(() => first.setItem(key, after), "premise: a durable tier took it, so nothing throws");
    await first.flush();
    assert.equal(local.map.get(key), before, "premise: the mirror kept the OLD value");
    assert.equal(idb.store.get(key), after, "premise: the durable tier holds the new one");

    const second = relaunch(local, idb);
    await second.hydrate();
    await second.flush();
    assert.equal(second.getItem(key), after, "the change was reverted on relaunch");
    assert.equal(idb.store.get(key), after, "and the stale mirror was pushed down over the good copy");
  });
}

test("the stale mark clears once localStorage takes the key again, and the ledger row goes with it", async () => {
  const local = new FakeLocal({ cp_saved: '["a"]' });
  const idb = fakeDurable({ rows: { cp_saved: '["a"]' } });
  const first = relaunch(local, idb);
  await first.hydrate();
  local.refuse = (k) => k === "cp_saved";
  first.setItem("cp_saved", '["a","b"]');
  await first.flush();
  assert.deepEqual(JSON.parse(idb.store.get(LOCAL_STALE_KEY)), ["cp_saved"], "the refusal is written down");

  local.refuse = null;                      // the bucket has room again
  const second = relaunch(local, idb);
  await second.hydrate();
  await second.flush();
  assert.equal(local.map.get("cp_saved"), '["a","b"]', "adopting the durable row repaired the mirror");
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false, "a repaired mirror leaves no ledger behind");

  // Third launch: an ordinary local-wins conflict is ordinary again.
  const third = relaunch(local, idb);
  await third.hydrate();
  assert.equal(third.getItem("cp_saved"), '["a","b"]');
});

test("a later write localStorage ACCEPTS clears the mark in the same session", async () => {
  const local = new FakeLocal();
  const idb = fakeDurable();
  const s = relaunch(local, idb);
  await s.hydrate();
  local.refuse = (k) => k === "cp_rate";
  s.setItem("cp_rate", "1.5");
  local.refuse = null;
  s.setItem("cp_rate", "2");
  await s.flush();
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false);
  const next = relaunch(local, idb);
  await next.hydrate();
  assert.equal(next.getItem("cp_rate"), "2");
});

test("a removal localStorage refused does not come back from the mirror next launch", async () => {
  const local = new FakeLocal({ cp_lastpick: '{"id":"x"}' });
  const idb = fakeDurable({ rows: { cp_lastpick: '{"id":"x"}' } });
  const first = relaunch(local, idb);
  await first.hydrate();
  local.refuseRemove = (k) => k === "cp_lastpick";
  first.removeItem("cp_lastpick");
  await first.flush();
  assert.ok(local.map.has("cp_lastpick"), "premise: the mirror kept the row");
  assert.equal(idb.store.has("cp_lastpick"), false, "premise: the durable tier removed it");

  local.refuseRemove = null;
  const second = relaunch(local, idb);
  await second.hydrate();
  await second.flush();
  assert.equal(second.getItem("cp_lastpick"), null, "the removed row was resurrected from the mirror");
  assert.equal(idb.store.has("cp_lastpick"), false, "and migrated back down");
  assert.equal(local.map.has("cp_lastpick"), false, "the ghost is cleared from the mirror too");
});

test("the ledger is bookkeeping: never readable, never counted, and a healthy mirror never writes it", async () => {
  const local = new FakeLocal();
  const idb = fakeDurable();
  const s = relaunch(local, idb);
  await s.hydrate();
  s.setItem("cp_seen", "[]");
  await s.flush();
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false, "a mirror that took every write needs no ledger");

  local.refuse = (k) => k === "cp_history";
  s.setItem("cp_history", '["a"]');
  await s.flush();
  assert.ok(idb.store.has(LOCAL_STALE_KEY), "premise: the ledger exists now");
  assert.equal(s.getItem(LOCAL_STALE_KEY), null, "the app can read the ledger");
  assert.equal(s.length, 2, "the ledger inflated the namespace");
  assert.equal(local.map.has(LOCAL_STALE_KEY), false, "the ledger was written to the tier it describes");
});

test("PURGE removes the ledger with everything else and does not write it back", async () => {
  const local = new FakeLocal({ cp_queue: '["a"]' });
  const idb = fakeDurable({ rows: { cp_queue: '["a"]' } });
  const s = relaunch(local, idb);
  await s.hydrate();
  local.refuse = (k) => k === "cp_queue";
  s.setItem("cp_queue", '["a","b"]');
  await s.flush();
  assert.ok(idb.store.has(LOCAL_STALE_KEY), "premise");

  local.refuse = null;
  const out = await s.purge();
  await s.flush();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...idb.store.keys()], [], "the purge left a row in the durable tier");
  assert.deepEqual([...local.map.keys()], []);
});

test("a corrupt ledger row costs the old rule, never the hydration", async () => {
  const local = new FakeLocal({ cp_rate: "1" });
  const idb = fakeDurable({ rows: { cp_rate: "2", [LOCAL_STALE_KEY]: "{not json" } });
  const s = relaunch(local, idb);
  await s.hydrate();
  assert.equal(s.getItem("cp_rate"), "1", "local wins, as it did before the ledger existed");
  assert.equal(s.health().hydrated, true);
});

/* ---------- the native tier: Capacitor Preferences (#40, 2026-09-22 audit) ----------

   The header used to draw this tier while nothing built it, so inside the
   shipping app both live tiers were script-evictable. These pin that it exists,
   that it is absent on the web rather than broken, and that it is the tier a
   WebView sweep cannot take. The fake bridge speaks the plugin's own method
   names (`keys`/`get`/`set`/`remove`) through `nativePromise`, the call
   `mobile/plugins/foray-tts/web/foray-tts.js` makes. */

function fakeBridge({ native = true, plugin = true, fail = false } = {}) {
  const prefs = new Map();
  const calls = [];
  return {
    prefs,
    calls,
    isNativePlatform: () => native,
    isPluginAvailable: (n) => plugin && n === "Preferences",
    async nativePromise(name, method, opts = {}) {
      calls.push(`${name}.${method}`);
      if (fail) throw new Error(`"${name}" plugin is not implemented on ios`);
      if (method === "keys") return { keys: [...prefs.keys()] };
      if (method === "get") return { value: prefs.has(opts.key) ? prefs.get(opts.key) : null };
      if (method === "set") { prefs.set(opts.key, opts.value); return {}; }
      if (method === "remove") { prefs.delete(opts.key); return {}; }
      throw new Error(`unknown method ${method}`);
    },
  };
}

test("NATIVE: no tier on the web, on a non-native platform, or on a build without the plugin", () => {
  assert.equal(preferencesTier(null), null, "a browser tab has no window.Capacitor");
  assert.equal(preferencesTier({}), null, "a bridge with no nativePromise is not a bridge");
  assert.equal(preferencesTier(fakeBridge({ native: false })), null);
  assert.equal(preferencesTier(fakeBridge({ plugin: false })), null);
  const tier = preferencesTier(fakeBridge());
  assert.equal(tier.name, "native");
  assert.equal(tier.durable, true);
  assert.equal(tier.sync, false);
});

test("NATIVE: a write reaches Preferences, and survives the WebView losing BOTH script tiers", async () => {
  /* The whole reason the tier exists: iOS may clear a WKWebView's localStorage
     AND IndexedDB. UserDefaults is not in that sweep. */
  const bridge = fakeBridge();
  const first = createDurableStore({
    localStorage: new FakeLocal(), idbTier: fakeDurable(), nativeTier: preferencesTier(bridge),
  });
  await first.hydrate();
  first.setItem("cp_sb_session", '{"user_id":"u-1"}');
  await first.flush();
  assert.equal(bridge.prefs.get("cp_sb_session"), '{"user_id":"u-1"}');
  assert.ok(bridge.calls.includes("Preferences.set"), "the plugin was addressed by its registered name");

  const swept = createDurableStore({
    localStorage: new FakeLocal(), idbTier: fakeDurable(), nativeTier: preferencesTier(bridge),
  });
  await swept.hydrate();
  assert.equal(swept.getItem("cp_sb_session"), '{"user_id":"u-1"}', "the listener became a new account");
  assert.deepEqual(swept.health().durableTiers, ["native", "idb"]);
});

test("NATIVE: it gets the first word — an evicted mirror adopts the native row over IndexedDB's", async () => {
  const bridge = fakeBridge();
  bridge.prefs.set("cp_rate", "1.5");
  const s = createDurableStore({
    localStorage: new FakeLocal(), idbTier: fakeDurable({ rows: { cp_rate: "1" } }),
    nativeTier: preferencesTier(bridge),
  });
  await s.hydrate();
  assert.equal(s.getItem("cp_rate"), "1.5");
});

test("NATIVE: only owned keys are read, and an unreadable plugin is a fault, not a crash", async () => {
  const bridge = fakeBridge();
  bridge.prefs.set("someone_else", "x");
  bridge.prefs.set("cp_seen", "[]");
  const rows = await preferencesTier(bridge).readAll(DEFAULT_PREFIX);
  assert.deepEqual([...rows.keys()], ["cp_seen"]);

  const dead = fakeBridge({ fail: true });
  const s = createDurableStore({ localStorage: new FakeLocal({ cp_seen: "[]" }), nativeTier: preferencesTier(dead) });
  await s.hydrate();
  assert.equal(s.getItem("cp_seen"), "[]", "the session still works on localStorage");
  assert.equal(s.health().ok, false, "and the dead tier is reported");
});

test("NATIVE: purge clears the native tier too, so Delete my data reaches UserDefaults", async () => {
  const bridge = fakeBridge();
  bridge.prefs.set("cp_interests", "{}");
  bridge.prefs.set("cp_pos:ep-1", '{"seconds":3}');
  const s = createDurableStore({
    localStorage: new FakeLocal(), idbTier: fakeDurable(), nativeTier: preferencesTier(bridge),
  });
  await s.hydrate();
  const out = await s.purge();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([...bridge.prefs.keys()], []);
});

test("NATIVE: the player wires the tier into the store it publishes", async () => {
  /* The first version of this claim was a header diagram with nothing behind
     it, so the wiring is pinned where it happens rather than trusted. */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const call = /const storage = createDurableStore\(\{[\s\S]*?\}\);/.exec(src);
  assert.ok(call, "client.js no longer builds the store where this test looks");
  assert.match(call[0], /nativeTier:\s*preferencesTier\(/, "the native tier is not wired");
});


/* ---------- the device-only vault (round-2 audit persist-6, founder ruling 2026-09-24) ----------

   "Option A": the auth token stays on the device and out of the phone's
   backups; every other row stays where it is and IS backed up. Inside the shell
   `cp_sb_session` therefore lives in the `ForayVault` plugin (Keychain
   this-device-only / Android no-backup storage) and in NO backed-up tier:
   not localStorage, not IndexedDB, not Preferences. These pin that routing, the
   copy-then-remove migration of a token an earlier build left behind, that a
   vault which fails never costs the account, and that Delete my data reaches
   it. The fake bridge serves BOTH plugins from separate maps, so "the token is
   in Preferences" and "the token is in the vault" are different facts. */

const TOKEN = '{"user_id":"u-1","access_token":"at","refresh_token":"rt","expires_at":1}';
const TOKEN_2 = '{"user_id":"u-1","access_token":"at2","refresh_token":"rt2","expires_at":2}';

function shellBridge({ vaultPlugin = true, failVaultRead = false, failVaultWrite = false } = {}) {
  const maps = { Preferences: new Map(), [VAULT_PLUGIN]: new Map() };
  const b = {
    prefs: maps.Preferences,
    vault: maps[VAULT_PLUGIN],
    failVaultRead,
    failVaultWrite,
    calls: [],
    isNativePlatform: () => true,
    isPluginAvailable: (n) => n === "Preferences" || (vaultPlugin && n === VAULT_PLUGIN),
    async nativePromise(name, method, opts = {}) {
      b.calls.push(`${name}.${method}`);
      const m = maps[name];
      if (!m) throw new Error(`"${name}" plugin is not implemented`);
      if (name === VAULT_PLUGIN && b.failVaultRead && (method === "keys" || method === "get")) {
        throw new Error("errSecInteractionNotAllowed");
      }
      if (name === VAULT_PLUGIN && b.failVaultWrite && method === "set") {
        throw new Error("errSecMissingEntitlement");
      }
      if (method === "keys") return { keys: [...m.keys()] };
      if (method === "get") return { value: m.has(opts.key) ? m.get(opts.key) : null };
      if (method === "set") { m.set(opts.key, opts.value); return {}; }
      if (method === "remove") { m.delete(opts.key); return {}; }
      throw new Error(`unknown method ${method}`);
    },
  };
  return b;
}

function shellStore(bridge, { local = new FakeLocal(), idb = fakeDurable() } = {}) {
  const store = createDurableStore({
    localStorage: local, idbTier: idb,
    nativeTier: preferencesTier(bridge), vault: vaultTier(bridge),
  });
  return { store, local, idb };
}

test("VAULT: the only device-only key is the auth token", () => {
  assert.deepEqual([...DEVICE_ONLY_KEYS], ["cp_sb_session"]);
  assert.equal(VAULT_PLUGIN, "ForayVault");
});

test("VAULT: no vault on the web, on a non-native bridge, or on a build without the plugin", () => {
  assert.equal(vaultTier(null), null, "a browser tab has no window.Capacitor");
  assert.equal(vaultTier({}), null);
  assert.equal(vaultTier({ ...shellBridge(), isNativePlatform: () => false }), null);
  assert.equal(vaultTier(shellBridge({ vaultPlugin: false })), null);
  const t = vaultTier(shellBridge());
  assert.equal(t.name, "vault");
  assert.equal(t.vault, true);
  assert.equal(t.sync, false);
});

test("VAULT: in the shell the token is written to the vault and to NO backed-up tier", async () => {
  /* MUTATION: drop the `_confined` branch in setItem -> the token lands in
     localStorage, IndexedDB and Preferences, and this fails three ways. */
  const bridge = shellBridge();
  const { store, local, idb } = shellStore(bridge);
  await store.hydrate();
  store.setItem("cp_sb_session", TOKEN);
  await store.flush();
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN);
  assert.equal(local.map.has("cp_sb_session"), false, "localStorage is in the WebView's backed-up data");
  assert.equal(idb.store.has("cp_sb_session"), false, "so is IndexedDB");
  assert.equal(bridge.prefs.has("cp_sb_session"), false, "and UserDefaults / SharedPreferences");
  assert.equal(store.getItem("cp_sb_session"), TOKEN, "the session still reads it");
  assert.ok(bridge.calls.includes(`${VAULT_PLUGIN}.set`), "addressed by the plugin's registered name");
});

test("VAULT: every other row stays in the backed-up tiers and never enters the vault", async () => {
  const bridge = shellBridge();
  const { store, local, idb } = shellStore(bridge);
  await store.hydrate();
  store.setItem("cp_interests", '{"food":0.9}');
  await store.flush();
  assert.equal(local.map.get("cp_interests"), '{"food":0.9}');
  assert.equal(idb.store.get("cp_interests"), '{"food":0.9}');
  assert.equal(bridge.prefs.get("cp_interests"), '{"food":0.9}');
  assert.deepEqual([...bridge.vault.keys()], [], "the vault is for the token alone");
});

test("VAULT: next launch reads the account from the vault, with every WebView tier intact", async () => {
  const bridge = shellBridge();
  const first = shellStore(bridge);
  await first.store.hydrate();
  first.store.setItem("cp_sb_session", TOKEN);
  await first.store.flush();

  const second = shellStore(bridge, { local: first.local, idb: first.idb });
  assert.equal(second.store.getItem("cp_sb_session"), null, "not in localStorage, so unknown until hydration");
  await second.store.hydrate();
  assert.equal(second.store.getItem("cp_sb_session"), TOKEN, "the listener became a new account");
});

test("VAULT MIGRATION: an earlier build's token is moved into the vault, then out of all three backed-up tiers", async () => {
  /* The upgrade path. MUTATION: skip `_moveLegacyIntoVault` -> the copies stay
     in the backup, which is the defect. */
  const bridge = shellBridge();
  bridge.prefs.set("cp_sb_session", TOKEN);
  const local = new FakeLocal({ cp_sb_session: TOKEN, cp_seen: "[]" });
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN, cp_seen: "[]" } });
  const { store } = shellStore(bridge, { local, idb });
  assert.equal(store.getItem("cp_sb_session"), TOKEN, "the first paint still knows the account");
  await store.hydrate();
  await store.flush();
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN);
  assert.equal(local.map.has("cp_sb_session"), false);
  assert.equal(idb.store.has("cp_sb_session"), false);
  assert.equal(bridge.prefs.has("cp_sb_session"), false);
  assert.equal(store.getItem("cp_sb_session"), TOKEN, "and it never stopped being readable");
  assert.equal(local.map.get("cp_seen"), "[]", "nothing else moved");
  assert.equal(store.health().tiers.vault.migrated, 1);
});

test("VAULT MIGRATION: a vault that refuses the write leaves every old copy where it was", async () => {
  /* Copy first, remove second. MUTATION: evict regardless of the vault write
     -> the only copies of the account are gone. */
  const bridge = shellBridge({ failVaultWrite: true });
  bridge.prefs.set("cp_sb_session", TOKEN);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN } });
  const { store } = shellStore(bridge, { local, idb });
  await store.hydrate();
  await store.flush();
  assert.equal(bridge.vault.has("cp_sb_session"), false);
  assert.equal(local.map.get("cp_sb_session"), TOKEN);
  assert.equal(idb.store.get("cp_sb_session"), TOKEN);
  assert.equal(bridge.prefs.get("cp_sb_session"), TOKEN);
  assert.equal(store.getItem("cp_sb_session"), TOKEN);
  assert.equal(store.health().ok, false, "and the refusal is on the record");
});

test("VAULT MIGRATION: a vault that cannot be READ moves nothing and removes nothing", async () => {
  /* "Could not look" is not "has none": writing the old copy over a vault we
     could not read could replace a newer account. */
  const bridge = shellBridge({ failVaultRead: true });
  bridge.vault.set("cp_sb_session", TOKEN_2);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const { store } = shellStore(bridge, { local });
  await store.hydrate();
  await store.flush();
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2, "the vault's row was not overwritten");
  assert.equal(local.map.get("cp_sb_session"), TOKEN, "the old copy was not removed");
  assert.equal(store.canKeep("cp_sb_session"), false);
});

test("VAULT MIGRATION: a tier we could not read keeps what it may hold when nothing else has the token", async () => {
  /* localStorage swept, IndexedDB unreadable this launch (it may hold the
     account), vault empty. MUTATION: drop the "nothing to move" guard -> the
     blind eviction deletes the only copy from IndexedDB. */
  const bridge = shellBridge();
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN }, failRead: true });
  const { store } = shellStore(bridge, { idb });
  await store.hydrate();
  await store.flush();
  assert.equal(idb.store.get("cp_sb_session"), TOKEN);
  assert.equal(store.getItem("cp_sb_session"), null);
});

test("VAULT: the vault's copy wins over a backed-up one, which is then removed", async () => {
  const bridge = shellBridge();
  bridge.vault.set("cp_sb_session", TOKEN_2);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const { store } = shellStore(bridge, { local });
  await store.hydrate();
  await store.flush();
  assert.equal(store.getItem("cp_sb_session"), TOKEN_2);
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2, "not overwritten by the older copy");
  assert.equal(local.map.has("cp_sb_session"), false);
});

test("VAULT: a token written before hydration lands is not clobbered, and the old copies still go", async () => {
  const bridge = shellBridge();
  bridge.vault.set("cp_sb_session", TOKEN);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const { store } = shellStore(bridge, { local });
  store.setItem("cp_sb_session", TOKEN_2);
  await store.hydrate();
  await store.flush();
  assert.equal(store.getItem("cp_sb_session"), TOKEN_2);
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2);
  assert.equal(local.map.has("cp_sb_session"), false);
});

test("VAULT: removing the token removes it from the vault and from every other tier", async () => {
  const bridge = shellBridge();
  bridge.vault.set("cp_sb_session", TOKEN);
  bridge.prefs.set("cp_sb_session", TOKEN);
  const { store, local } = shellStore(bridge, { local: new FakeLocal({ cp_sb_session: TOKEN }) });
  store.removeItem("cp_sb_session");
  await store.flush();
  assert.equal(bridge.vault.has("cp_sb_session"), false);
  assert.equal(bridge.prefs.has("cp_sb_session"), false);
  assert.equal(local.map.has("cp_sb_session"), false);
  await store.hydrate();
  assert.equal(store.getItem("cp_sb_session"), null, "and hydration does not bring it back");
});

test("VAULT PURGE: Delete my data empties the vault and verifies it", async () => {
  /* MUTATION: stop `_readTiers` asking the vault -> a row the vault holds that
     memory never saw survives a purge that reports ok. */
  const bridge = shellBridge();
  const { store } = shellStore(bridge);
  await store.hydrate();
  store.setItem("cp_seen", "[]");
  await store.flush();
  /* Another launch wrote the token; this session's memory never saw it. */
  bridge.vault.set("cp_sb_session", TOKEN_2);
  const out = await store.purge();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.keys.includes("cp_sb_session"), JSON.stringify(out.keys));
  assert.deepEqual([...bridge.vault.keys()], []);
  assert.deepEqual([...bridge.prefs.keys()], []);
});

test("VAULT PURGE: a vault that cannot be read makes the purge report NOT ok", async () => {
  const bridge = shellBridge();
  const { store } = shellStore(bridge);
  await store.hydrate();
  store.setItem("cp_sb_session", TOKEN);
  await store.flush();
  bridge.failVaultRead = true;
  const out = await store.purge();
  assert.equal(out.ok, false);
  assert.ok(out.unverified.some((u) => u.tier === "vault"), JSON.stringify(out.unverified));
});

test("VAULT: canKeep says yes on the web, and in the shell only once the vault has been read", async () => {
  const web = createDurableStore({ localStorage: new FakeLocal(), idbTier: fakeDurable() });
  assert.equal(web.canKeep("cp_sb_session"), true, "no vault: localStorage keeps it, as always");
  const { store } = shellStore(shellBridge());
  assert.equal(store.canKeep("cp_interests"), true, "an ordinary key is always keepable");
  assert.equal(store.canKeep("cp_sb_session"), false, "before hydration, absence means nothing");
  await store.hydrate();
  assert.equal(store.canKeep("cp_sb_session"), true);
});

test("VAULT: a vault the circuit breaker dropped cannot keep the token, and setItem says so", async () => {
  const bridge = shellBridge();
  const { store } = shellStore(bridge);
  await store.hydrate();
  bridge.failVaultWrite = true;
  for (let i = 0; i < MAX_CONSECUTIVE_TIER_FAILURES; i++) {
    store.setItem("cp_sb_session", TOKEN);
    await store.flush();
  }
  assert.equal(store.canKeep("cp_sb_session"), false);
  assert.throws(() => store.setItem("cp_sb_session", TOKEN), /device-only store is unavailable/);
  assert.equal(store.health().tiers.vault.disabled, true);
});

test("VAULT: a ledger entry for the token with no localStorage copy left to overrule is simply dropped", async () => {
  const bridge = shellBridge();
  bridge.vault.set("cp_sb_session", TOKEN_2);
  const idb = fakeDurable({ rows: { [LOCAL_STALE_KEY]: '["cp_sb_session"]', cp_sb_session: TOKEN } });
  const { store } = shellStore(bridge, { idb });
  await store.hydrate();
  await store.flush();
  assert.equal(store.getItem("cp_sb_session"), TOKEN_2);
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false, "the ledger row named only the token, so it goes");
});

test("VAULT: health() names the vault and what it holds; the web reports none", async () => {
  const { store } = shellStore(shellBridge());
  await store.hydrate();
  assert.deepEqual(store.health().vault, { tier: "vault", read: true, keys: ["cp_sb_session"] });
  assert.equal(store.health().tiers.vault.deviceOnly, true);
  assert.equal(store.health().tiers.native.deviceOnly, false);
  assert.deepEqual(store.health().durableTiers, ["native", "idb"], "the vault protects one key, not the rows");
  const web = createDurableStore({ localStorage: new FakeLocal() });
  assert.equal(web.health().vault, null);
});

test("VAULT: the player wires the vault into the store it publishes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const call = /const storage = createDurableStore\(\{[\s\S]*?\}\);/.exec(src);
  assert.ok(call, "client.js no longer builds the store where this test looks");
  assert.match(call[0], /vault:\s*vaultTier\(/, "the vault is not wired, so the token rides the backup again");
});

test("VAULT: a new token the vault refuses does not take the old copies with it", async () => {
  /* The same copy-then-remove rule for a write made this session (a refresh).
     MUTATION: evict after a failed vault write -> the backed-up copy, the last
     durable trace of the account, is gone with nothing in its place. */
  const bridge = shellBridge({ failVaultWrite: true });
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const { store } = shellStore(bridge, { local });
  await store.hydrate();
  store.setItem("cp_sb_session", TOKEN_2);
  await store.flush();
  assert.equal(bridge.vault.has("cp_sb_session"), false);
  assert.equal(local.map.get("cp_sb_session"), TOKEN);
  assert.equal(store.getItem("cp_sb_session"), TOKEN_2, "the session still has the new one in memory");
});

/* ---------- follow-up review of #773 (2026-09-24) ----------

   Four findings against the merged vault change, each pinned by a test that
   fails on f33caadf. */

/** The build BEFORE the vault: the same three backed-up tiers, no vault, so
    `cp_sb_session` is an ordinary key and the stale-mirror ledger covers it. */
function preVaultStore(bridge, local, idb) {
  return createDurableStore({ localStorage: local, idbTier: idb, nativeTier: preferencesTier(bridge) });
}

test("VAULT MIGRATION: an old build's ledger is OBEYED — the newer durable token is moved into the vault, not localStorage's spent one", async () => {
  /* The pre-vault build refreshed the token (Supabase spent rt), localStorage
     refused the write, Preferences and IndexedDB took it, and the ledger says
     so. MUTATION (f33caadf): drop the ledger entry for a confined key instead
     of obeying it -> localStorage's spent TOKEN is written into the vault and
     the good TOKEN_2 is evicted from every tier: the next refresh fails and the
     app signs up a new account. */
  const bridge = shellBridge();
  bridge.prefs.set("cp_sb_session", TOKEN);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN } });
  const old = preVaultStore(bridge, local, idb);
  await old.hydrate();
  local.refuse = (k) => k === "cp_sb_session";
  old.setItem("cp_sb_session", TOKEN_2);
  await old.flush();
  assert.equal(local.map.get("cp_sb_session"), TOKEN, "premise: localStorage kept the spent token");
  assert.equal(idb.store.get("cp_sb_session"), TOKEN_2, "premise: IndexedDB took the new one");
  assert.match(idb.store.get(LOCAL_STALE_KEY) || "", /cp_sb_session/, "premise: the ledger names it");
  local.refuse = null;

  const { store } = shellStore(bridge, { local, idb });
  await store.hydrate();
  await store.flush();
  assert.equal(store.getItem("cp_sb_session"), TOKEN_2, "the session reads the spent token");
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2, "the vault took the spent token");
  assert.equal(local.map.has("cp_sb_session"), false);
  assert.equal(idb.store.has("cp_sb_session"), false);
  assert.equal(bridge.prefs.has("cp_sb_session"), false);
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false, "the entry leaves once the localStorage copy has gone");
  assert.equal(bridge.prefs.has(LOCAL_STALE_KEY), false);
});

test("VAULT MIGRATION: an old build's ledger ghost — a token removed durably while localStorage refused — never reaches the vault", async () => {
  /* The durable half of Delete my data removed the token; localStorage refused
     the removal. MUTATION (f33caadf): drop the ledger entry -> the deleted
     account's token is read from localStorage and migrated into the vault,
     the resurrection persist-6 exists to prevent. */
  const bridge = shellBridge();
  bridge.prefs.set("cp_sb_session", TOKEN);
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN } });
  const old = preVaultStore(bridge, local, idb);
  await old.hydrate();
  local.refuseRemove = (k) => k === "cp_sb_session";
  old.removeItem("cp_sb_session");
  await old.flush();
  assert.equal(local.map.get("cp_sb_session"), TOKEN, "premise: the ghost is in localStorage");
  assert.equal(idb.store.has("cp_sb_session"), false, "premise: durably removed");
  assert.match(idb.store.get(LOCAL_STALE_KEY) || "", /cp_sb_session/, "premise: the ledger names it");
  local.refuseRemove = null;

  const { store } = shellStore(bridge, { local, idb });
  await store.hydrate();
  await store.flush();
  assert.equal(store.getItem("cp_sb_session"), null, "the deleted account came back");
  assert.equal(bridge.vault.has("cp_sb_session"), false, "the deleted account's token was moved into the vault");
  assert.equal(local.map.has("cp_sb_session"), false, "the ghost is removed, not left for the next launch");
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false);
  assert.equal(bridge.prefs.has(LOCAL_STALE_KEY), false);
});

test("VAULT MIGRATION: a vault that refuses the ledger-directed move keeps the ledger, so the next launch still gets it right", async () => {
  /* MUTATION: drop the entry at hydration rather than once the localStorage
     copy is gone -> the refused move leaves no ledger, and the next launch
     moves the spent token. */
  const bridge = shellBridge({ failVaultWrite: true });
  const local = new FakeLocal({ cp_sb_session: TOKEN });
  const idb = fakeDurable({ rows: { cp_sb_session: TOKEN_2, [LOCAL_STALE_KEY]: '["cp_sb_session"]' } });
  bridge.prefs.set("cp_sb_session", TOKEN_2);
  bridge.prefs.set(LOCAL_STALE_KEY, '["cp_sb_session"]');
  const first = shellStore(bridge, { local, idb });
  await first.store.hydrate();
  await first.store.flush();
  assert.equal(first.store.getItem("cp_sb_session"), TOKEN_2);
  assert.equal(bridge.vault.has("cp_sb_session"), false, "premise: the vault refused");
  assert.match(idb.store.get(LOCAL_STALE_KEY) || "", /cp_sb_session/, "the ledger entry was dropped too early");

  bridge.failVaultWrite = false;
  const second = shellStore(bridge, { local, idb });
  await second.store.hydrate();
  await second.store.flush();
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2);
  assert.equal(local.map.has("cp_sb_session"), false);
  assert.equal(idb.store.has(LOCAL_STALE_KEY), false);
});

test("VAULT: a refreshed token the vault refuses once is retried, and canKeep says no until it lands", async () => {
  /* The token's only durable home is the vault now. MUTATION (f33caadf): no
     retry -> after one refused write the refreshed session lives in memory
     only, the vault still holds the spent token, canKeep says yes, and the
     next launch signs up a new account. */
  const bridge = shellBridge();
  const { store } = shellStore(bridge);
  await store.hydrate();
  store.setItem("cp_sb_session", TOKEN);
  await store.flush();
  bridge.failVaultWrite = true;
  store.setItem("cp_sb_session", TOKEN_2);           // the refresh
  await store.flush();
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN, "premise: the vault refused the refresh");
  assert.equal(store.canKeep("cp_sb_session"), false, "a second refresh now would spend the token the vault holds");

  bridge.failVaultWrite = false;
  await store.flush();                               // pagehide / visibilitychange
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2, "the refreshed token was never retried");
  assert.equal(store.canKeep("cp_sb_session"), true);
});

test("VAULT: canKeep itself retries a refused write, so the next sync's check is the retry", async () => {
  const bridge = shellBridge();
  const { store } = shellStore(bridge);
  await store.hydrate();
  bridge.failVaultWrite = true;
  store.setItem("cp_sb_session", TOKEN_2);
  await store.flush();
  bridge.failVaultWrite = false;
  assert.equal(store.canKeep("cp_sb_session"), false, "still unsaved at the moment of asking");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bridge.vault.get("cp_sb_session"), TOKEN_2, "asking did not retry");
  assert.equal(store.canKeep("cp_sb_session"), true);
});

test("VAULT: a vault error that quotes the vault's contents never reaches the health record, the backed-up mirror or the fault sink", async () => {
  /* Android's org.json ends a parse error with the whole input, i.e. the token
     file. MUTATION: keep the vault's error text as-is in `_fault` -> the
     refresh token is written to cp_storage_health in localStorage (backed up)
     and handed to the app's logger. */
  const SECRET = "rt-SECRET-4e1f";
  const bridge = shellBridge();
  const real = bridge.nativePromise;
  bridge.nativePromise = async (name, method, opts) => {
    if (name === VAULT_PLUGIN && method === "keys") {
      throw new Error('ForayVault.keys failed: Unterminated string at character 90 of {"cp_sb_session":"{\\"refresh_token\\":\\"' + SECRET);
    }
    return real(name, method, opts);
  };
  const seen = [];
  const local = new FakeLocal();
  const store = createDurableStore({
    localStorage: local, idbTier: fakeDurable(),
    nativeTier: preferencesTier(bridge), vault: vaultTier(bridge),
    onFault: (fault) => seen.push(JSON.stringify(fault)),
  });
  await store.hydrate();
  assert.equal(store.health().ok, false, "premise: the vault read faulted");
  assert.match(store.health().tiers.vault.lastError, /ForayVault\.keys failed/, "the call is still named");
  assert.doesNotMatch(JSON.stringify(store.health()), new RegExp(SECRET));
  assert.doesNotMatch(local.map.get(HEALTH_KEY) || "", new RegExp(SECRET), "the token was mirrored into a backed-up tier");
  assert.ok(seen.length > 0);
  for (const f of seen) assert.doesNotMatch(f, new RegExp(SECRET), "the token reached the fault sink");
});

/* ---------- single writer: the native engine's rows (NE-23, native-engine plan §4.6) ----------

   On the iOS shell the engine writes `cp_pos:*`, `cp_foray:*` and
   `cp_last_episode` straight into UserDefaults — the rows the Preferences tier
   holds — so the page is a second writer that can be STALE. These pin the four
   acceptance criteria of the card (a stale mirror never reaches Preferences, a
   deleted row is never resurrected, a refused write changes nothing, the
   deferred migration runs once) and the wiring that makes them apply on iOS
   and nowhere else. `native` below is the Preferences tier; the engine is
   modelled as the thing that has written it. */

/** A fake durable tier that also records removals, and whose reads can be
    held open (`gate`) to model a WKWebView IndexedDB that answers late. */
function ownerTier(name, rows = {}, { gate = null } = {}) {
  const tier = fakeDurable({ name, rows });
  const read = tier.readAll.bind(tier);
  const remove = tier.remove.bind(tier);
  tier.removed = [];
  tier.readAll = async (prefix) => { if (gate) await gate; return read(prefix); };
  tier.remove = async (k) => { tier.removed.push(k); return remove(k); };
  return tier;
}

const isOwnerKey = (k) => OWNED_PREFIXES.some((p) => k.startsWith(p));
const ownerWrites = (tier) => tier.writes.filter(isOwnerKey);
const sorted = (m) => [...m].filter(([k]) => k !== HEALTH_KEY).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The iOS shell's store: deferral from construction. */
function iosStore({ local = {}, native = {}, idb = {}, gate = null, onFault = null } = {}) {
  const tiers = {
    local: new FakeLocal(local),
    native: ownerTier("native", native),
    idb: ownerTier("idb", idb, { gate }),
  };
  const store = createDurableStore({
    localStorage: tiers.local, nativeTier: tiers.native, idbTier: tiers.idb,
    deferredPrefixes: OWNED_PREFIXES, onFault,
  });
  return { store, ...tiers };
}

/** What `engineRead("rows")` answers: every engine row UserDefaults holds. */
const engineRows = (native) => Object.fromEntries([...native.store].filter(([k]) => isOwnerKey(k)));

test("SINGLE WRITER: deferral is for the iOS shell only — not the web, not Android, not an older shell", () => {
  /* MUTATION: answer the prefixes for any native platform -> Android defers a
     migration nothing on Android will ever release, and its positions stop
     reaching SharedPreferences. */
  const shell = (platform, native = true) => ({ getPlatform: () => platform, isNativePlatform: () => native });
  assert.deepEqual(deferredPrefixesFor(null, OWNED_PREFIXES), [], "a browser tab has no window.Capacitor");
  assert.deepEqual(deferredPrefixesFor({}, OWNED_PREFIXES), [], "a shell with no getPlatform predates the engine");
  assert.deepEqual(deferredPrefixesFor(shell("android"), OWNED_PREFIXES), []);
  assert.deepEqual(deferredPrefixesFor(shell("web", false), OWNED_PREFIXES), []);
  assert.deepEqual(deferredPrefixesFor({ getPlatform() { throw new Error("x"); } }, OWNED_PREFIXES), []);
  assert.deepEqual(deferredPrefixesFor(shell("ios"), OWNED_PREFIXES), [...OWNED_PREFIXES]);
  const web = createDurableStore({ localStorage: new FakeLocal() });
  assert.equal(web.ownership(), null, "a store nobody defers has no owner state at all");
  const ios = createDurableStore({ localStorage: new FakeLocal(), deferredPrefixes: OWNED_PREFIXES });
  assert.deepEqual(ios.ownership(), { state: OWNERSHIP_DEFERRED, prefixes: [...OWNED_PREFIXES] });
});

test("SINGLE WRITER: the player defers the engine's rows from construction, and (no engine client yet) releases before hydrating", async () => {
  /* MUTATION: drop `deferredPrefixes` from client.js -> the pin fails; drop the
     release, or move it after `storage.hydrate()` -> on iOS every position
     would sit in memory for good, or hydration would run deferred first. */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const call = /const storage = createDurableStore\(\{[\s\S]*?\}\);/.exec(src);
  assert.ok(call, "client.js no longer builds the store where this test looks");
  assert.match(call[0], /deferredPrefixes:\s*deferredPrefixesFor\([^)]*window\.Capacitor[^)]*,\s*OWNED_PREFIXES\)/);
  assert.match(src, /import \{ OWNED_PREFIXES \} from "\.\/engine-contract\.js";/);
  const release = src.indexOf("storage.releaseOwnership()");
  const hydrate = src.indexOf("storage.hydrate()");
  assert.ok(release > call.index, "the store is released after it is built");
  assert.ok(hydrate > 0 && release < hydrate, "released before hydration, so hydration runs as it always did");
});

test("SINGLE WRITER (acceptance): a stale localStorage row beside a newer native row — page boot writes NOTHING to Preferences for it", async () => {
  /* The clobber. Engine rows carry no timestamp `isNewer` can use against an
     undated mirror, so "local wins" pushed the page's stale copy down over the
     engine's. The control store shows the defect is real; the deferred store
     must not have it. MUTATION: drop the `_withheld` skip in `_migrateUp` ->
     Preferences receives cp_pos:ep-1 = the stale 10 s. */
  const local = { "cp_pos:ep-1": '{"seconds":10}', "cp_last_episode": '{"id":"ep-0"}', cp_rate: "1.5" };
  const native = { "cp_pos:ep-1": '{"seconds":900}', "cp_last_episode": '{"id":"ep-1"}' };

  const controlNative = ownerTier("native", native);
  const control = createDurableStore({
    localStorage: new FakeLocal(local), nativeTier: controlNative, idbTier: ownerTier("idb"),
  });
  await control.hydrate();
  assert.equal(controlNative.store.get("cp_pos:ep-1"), '{"seconds":10}', "premise: without deferral the mirror clobbers the engine's row");

  const { store, native: prefs, idb, local: ls } = iosStore({ local, native });
  await store.hydrate();
  await store.flush();
  assert.deepEqual(ownerWrites(prefs), [], "Preferences received a write for an engine row");
  assert.deepEqual(ownerWrites(idb), [], "nor is any engine row mirrored into IndexedDB until the lane is known");
  assert.equal(prefs.store.get("cp_pos:ep-1"), '{"seconds":900}');
  assert.equal(ls.map.get("cp_last_episode"), '{"id":"ep-0"}', "nor up into localStorage");
  assert.ok(prefs.writes.includes("cp_rate"), "a row the engine does not own migrates exactly as before");
});

test("SINGLE WRITER: the engine's set REPLACES the page's on attach — a row absent natively is dropped from memory, other rows untouched", async () => {
  /* MUTATION: merge instead of replace (skip the drop loop) -> cp_pos:gone and
     cp_foray:old stay readable, and the page paints a position the engine deleted. */
  const { store, native, idb, local } = iosStore({
    local: { "cp_pos:gone": "1", "cp_pos:kept": "2", "cp_foray:old": "{}", cp_rate: "1.5", "cp_foray_feedback": "{}" },
  });
  await store.hydrate();
  assert.equal(store.externallyOwned(OWNED_PREFIXES), true);
  assert.equal(store.adoptOwnedSet({
    "cp_pos:kept": "20", "cp_last_episode": '{"id":"ep-9"}',
    cp_rate: "3", "cp_pos:bad": 7, // not an engine row / not a string: ignored
  }), true);
  assert.equal(store.getItem("cp_pos:gone"), null);
  assert.equal(store.getItem("cp_foray:old"), null);
  assert.equal(store.getItem("cp_pos:kept"), "20");
  assert.equal(store.getItem("cp_last_episode"), '{"id":"ep-9"}');
  assert.equal(store.getItem("cp_pos:bad"), null);
  assert.equal(store.getItem("cp_rate"), "1.5", "a page row is never taken from the engine's answer");
  assert.equal(store.getItem("cp_foray_feedback"), "{}", "the colon is load-bearing: the thumbs store is the page's");
  await store.flush();
  assert.deepEqual([...ownerWrites(native), ...ownerWrites(idb), ...native.removed, ...idb.removed], [], "adoption writes no tier");
  assert.equal(local.map.get("cp_pos:gone"), "1", "the mirror is brought into line on release, not here");
});

test("SINGLE WRITER (acceptance): a row the engine deleted is not resurrected — by a native reboot, nor by a JS launch after a relinquish", async () => {
  /* UserDefaults lost cp_pos:gone (the engine finished the episode and
     deleted it); localStorage and IndexedDB still hold the page's old copies.
     MUTATIONS: drop the `_withheld` skip in `_migrateUp` -> boot 1 writes it
     back into Preferences; skip the release's first step (committing what the
     engine's set decided) -> the relinquish leaves the stale mirrors behind,
     and a JS launch would read the row back out of them. */
  const stale = { "cp_pos:gone": '{"seconds":1200}', "cp_pos:live": '{"seconds":5}' };
  const local = new FakeLocal(stale);
  const idb = ownerTier("idb", stale);
  const native = ownerTier("native", { "cp_pos:live": '{"seconds":60}' });
  const boot = () => createDurableStore({ localStorage: local, nativeTier: native, idbTier: idb, deferredPrefixes: OWNED_PREFIXES });

  for (let i = 0; i < 2; i++) {                 // two native launches
    const s = boot();
    await s.hydrate();
    s.externallyOwned(OWNED_PREFIXES);
    s.adoptOwnedSet(engineRows(native));
    await s.flush();
    assert.equal(s.getItem("cp_pos:gone"), null, `native launch ${i + 1} reads the deleted row`);
    assert.equal(s.getItem("cp_pos:live"), '{"seconds":60}');
    assert.equal(native.store.has("cp_pos:gone"), false, `native launch ${i + 1} resurrected it in UserDefaults`);
  }

  // A relinquish: rows adopted once more, then the page becomes the writer.
  const r = boot();
  await r.hydrate();
  r.externallyOwned(OWNED_PREFIXES);
  r.adoptOwnedSet(engineRows(native));
  await r.releaseOwnership();
  assert.equal(local.map.has("cp_pos:gone"), false, "the stale mirror survived the release");
  assert.equal(idb.store.has("cp_pos:gone"), false, "IndexedDB's stale copy survived the release");
  assert.equal(local.map.get("cp_pos:live"), '{"seconds":60}', "the engine's row is mirrored up");

  // The next launch is JS mode (released before hydration, as client.js does).
  const js = boot();
  await js.releaseOwnership();
  await js.hydrate();
  await js.flush();
  assert.equal(js.getItem("cp_pos:gone"), null);
  assert.equal(native.store.has("cp_pos:gone"), false);
});

test("SINGLE WRITER: after a replace-set, release sweeps a stale copy hydration never loaded", async () => {
  /* The adoption beat IndexedDB's read, so memory never held cp_pos:late and
     the ordinary removal path never saw it. MUTATION: drop the async half of
     `_sweepOwnerRows` -> IndexedDB keeps it, and the next JS launch adopts it
     from there and migrates it back into Preferences. */
  let open;
  const gate = new Promise((r) => { open = r; });
  const { store, idb } = iosStore({ idb: { "cp_pos:late": "1" }, gate });
  const hydrated = store.hydrate();
  store.externallyOwned(OWNED_PREFIXES);
  store.adoptOwnedSet({});
  const released = store.releaseOwnership();
  open();
  await hydrated;
  await released;
  await store.flush();
  assert.equal(idb.store.has("cp_pos:late"), false);
  assert.equal(store.getItem("cp_pos:late"), null);
});

test("SINGLE WRITER: a durable read that lands AFTER the replace-set cannot put a deleted row back", async () => {
  /* IndexedDB answering late is ordinary in a WKWebView (idb-tier.js hazard 1).
     MUTATION: drop the `_replaced` guard in `_doHydrate` -> the late read
     adopts cp_pos:gone into memory and the page paints it again. */
  let open;
  const gate = new Promise((r) => { open = r; });
  const { store } = iosStore({ idb: { "cp_pos:gone": "1", cp_seen: "[]" }, gate });
  const hydrated = store.hydrate();
  store.externallyOwned(OWNED_PREFIXES);
  store.adoptOwnedSet({ "cp_pos:live": "2" });
  open();
  await hydrated;
  assert.equal(store.getItem("cp_pos:gone"), null);
  assert.equal(store.getItem("cp_pos:live"), "2");
  assert.equal(store.getItem("cp_seen"), "[]", "a page row from the same late read is adopted as ever");
});

test("SINGLE WRITER (acceptance): a refused write leaves the store untouched, does not throw, and is a `fault externally-owned`", async () => {
  /* MUTATION: hold the write in memory instead of refusing it (drop the
     external branch of `_holdWrite`) -> the stale page's 10 s is what the
     facade reads, and what a release would later commit. */
  const faults = [];
  const { store, native, idb, local } = iosStore({
    native: { "cp_pos:ep-1": "900", "cp_foray:f": "{}" },
    onFault: (f) => faults.push(f),
  });
  await store.hydrate();
  store.externallyOwned(OWNED_PREFIXES);
  store.adoptOwnedSet(engineRows(native));
  assert.equal(store.ownership().state, OWNERSHIP_EXTERNAL);

  assert.doesNotThrow(() => store.setItem("cp_pos:ep-1", "10"));
  assert.doesNotThrow(() => store.removeItem("cp_foray:f"));
  store.setItem("cp_rate", "2");                 // the page's own rows still write
  await store.flush();

  assert.equal(store.getItem("cp_pos:ep-1"), "900");
  assert.equal(store.getItem("cp_foray:f"), "{}");
  assert.deepEqual([...ownerWrites(native), ...ownerWrites(idb), ...native.removed, ...idb.removed], []);
  assert.equal(local.map.has("cp_pos:ep-1"), false);
  assert.equal(store.getItem("cp_rate"), "2");
  assert.ok(native.writes.includes("cp_rate"));

  const refused = store.health().faults.filter((f) => f.tier === OWNER_TIER);
  assert.deepEqual(refused.map(({ op, key, error }) => ({ op, key, error })), [
    { op: "write", key: "cp_pos:ep-1", error: "externally-owned" },
    { op: "remove", key: "cp_foray:f", error: "externally-owned" },
  ]);
  assert.equal(faults.length, 2, "the app's fault sink hears each refusal");
  assert.ok(FAULT_KINDS.includes(EXTERNALLY_OWNED), "the token is the engine vocabulary's own spelling (NE-26r counts it)");
});

test("SINGLE WRITER: a page write while the lane is unknown lands in memory only, and is committed on release", async () => {
  /* MUTATION: write held rows through at once (skip `_withheld` in setItem)
     -> Preferences gets the write before anyone knows who the writer is. */
  const { store, native, idb, local } = iosStore({ local: { "cp_foray:f": "{}" }, native: { "cp_foray:f": "{}" } });
  await store.hydrate();
  store.setItem("cp_pos:new", "42");
  store.removeItem("cp_foray:f");
  await store.flush();
  assert.equal(store.getItem("cp_pos:new"), "42", "the session stays coherent");
  assert.equal(store.getItem("cp_foray:f"), null);
  assert.equal(local.map.has("cp_pos:new"), false);
  assert.equal(native.store.get("cp_foray:f"), "{}", "nothing is committed while nothing is decided");
  assert.deepEqual(ownerWrites(native), []);

  await store.releaseOwnership();
  assert.equal(local.map.get("cp_pos:new"), "42");
  assert.equal(native.store.get("cp_pos:new"), "42");
  assert.equal(idb.store.get("cp_pos:new"), "42");
  assert.equal(local.map.has("cp_foray:f"), false);
  assert.equal(native.store.has("cp_foray:f"), false);
});

test("SINGLE WRITER (acceptance): after releaseOwnership the deferred migration runs ONCE — and leaves the tiers where no deferral would have", async () => {
  /* MUTATION: skip the held migration in `_commitHeld` (drop step 4) -> the
     row only localStorage had never reaches Preferences, so an eviction loses
     it. MUTATION: re-run the commit on each call -> Preferences is written
     twice. MUTATION: drop the held mirror (step 2) -> localStorage never gets
     cp_last_episode. */
  const seed = {
    local: { "cp_pos:local-only": "7", "cp_foray:both": "{}" },
    native: { "cp_last_episode": '{"id":"ep-3"}', "cp_foray:both": "{}" },
  };
  const { store, native, idb, local } = iosStore(seed);
  await store.hydrate();
  assert.equal(store.getItem("cp_last_episode"), '{"id":"ep-3"}', "deferred rows are READ");
  assert.equal(local.map.has("cp_last_episode"), false, "and not mirrored up yet");
  assert.deepEqual([...ownerWrites(native), ...ownerWrites(idb)], []);

  const first = store.releaseOwnership();
  assert.equal(store.releaseOwnership(), first, "a second call is the first call");
  assert.equal(await first, true);
  await store.releaseOwnership();
  await store.hydrate();
  await store.flush();
  assert.equal(store.ownership().state, OWNERSHIP_RELEASED);
  assert.deepEqual(ownerWrites(native).sort(), ["cp_pos:local-only"]);
  assert.deepEqual(ownerWrites(idb).sort(), ["cp_foray:both", "cp_last_episode", "cp_pos:local-only"]);
  assert.equal(local.map.get("cp_last_episode"), '{"id":"ep-3"}');

  /* The same end state as a store that never deferred. */
  const plainLocal = new FakeLocal(seed.local);
  const plainNative = ownerTier("native", seed.native);
  const plainIdb = ownerTier("idb");
  const plain = createDurableStore({ localStorage: plainLocal, nativeTier: plainNative, idbTier: plainIdb });
  await plain.hydrate();
  assert.deepEqual(sorted(native.store), sorted(plainNative.store));
  assert.deepEqual(sorted(idb.store), sorted(plainIdb.store));
  assert.deepEqual(sorted(local.map), sorted(plainLocal.map));
});

test("SINGLE WRITER: a release while hydration is still reading runs the migration when hydration finishes, once", async () => {
  /* The relinquish can beat a slow IndexedDB. MUTATION: drop the
     `_hydrationMigrated` hand-off in `_doHydrate` -> the migration is lost. */
  let open;
  const gate = new Promise((r) => { open = r; });
  const { store, native } = iosStore({ local: { "cp_pos:a": "1" }, gate });
  const hydrated = store.hydrate();
  const released = store.releaseOwnership();
  store.setItem("cp_pos:b", "2");                 // ordinary, the moment it is released
  await released;
  assert.equal(native.store.has("cp_pos:a"), false, "premise: hydration has not migrated yet");
  open();
  await hydrated;
  await store.flush();
  assert.deepEqual(ownerWrites(native).filter((k) => k === "cp_pos:a"), ["cp_pos:a"], "the held row is migrated once");
  /* cp_pos:b is written by its own setItem, and — like any row written during
     hydration, deferral or not — once more by hydration's migration. */
  assert.deepEqual([...new Set(ownerWrites(native))].sort(), ["cp_pos:a", "cp_pos:b"]);
});

test("SINGLE WRITER: a ledger ghost among the deferred rows is read as gone, and removed from localStorage only on release", async () => {
  /* The durable tier removed cp_pos:g while localStorage refused to (property
     4); its ledger says so. MUTATION: remove it from localStorage while still
     deferred -> the page writes before the lane is known; drop `_heldGhost`
     from the release -> the ghost outlives it and comes back next launch. */
  const { store, local } = iosStore({
    local: { "cp_pos:g": "1" },
    native: { [LOCAL_STALE_KEY]: JSON.stringify(["cp_pos:g"]) },
  });
  await store.hydrate();
  assert.equal(store.getItem("cp_pos:g"), null);
  assert.equal(local.map.get("cp_pos:g"), "1");
  await store.releaseOwnership();
  assert.equal(local.map.has("cp_pos:g"), false);
});

test("SINGLE WRITER: relinquish is one way — no re-owning, no adopting, and ordinary writes after it", async () => {
  /* MUTATION: let `externallyOwned` run after a release -> the engine takes the
     rows back from a page that has already become their writer. */
  const { store, native } = iosStore();
  await store.hydrate();
  store.externallyOwned(OWNED_PREFIXES);
  await store.releaseOwnership();
  assert.equal(store.externallyOwned(OWNED_PREFIXES), false);
  assert.equal(store.adoptOwnedSet({ "cp_pos:x": "1" }), false);
  assert.equal(store.getItem("cp_pos:x"), null);
  store.setItem("cp_pos:y", "5");
  await store.flush();
  assert.equal(native.store.get("cp_pos:y"), "5");
  assert.equal(await createDurableStore({ localStorage: new FakeLocal() }).releaseOwnership(), false, "nothing deferred, nothing to release");
});

test("SINGLE WRITER: Delete my data in native mode is stop{persist:false} -> the engine's purge -> the page's own, and reaches the engine's rows everywhere", async () => {
  /* MUTATIONS: purge the tiers before the engine -> the order below fails;
     leave the removal loop subject to the refusal (drop `_purgeBypass`) -> the
     stale mirrors of the engine's rows survive "Delete my data"; ignore the
     engine's answer -> a failed engine purge reports ok. */
  const order = [];
  const engine = { rows: new Map([["cp_pos:e", "9"]]), private: new Set(["ForayEngine.restore", "ForayEngine.strikes"]) };
  const send = async (cmd, args) => {
    order.push(`${cmd}${cmd === "stop" ? `:${args.persist}` : ""}`);
    if (cmd === "purge") { engine.rows.clear(); engine.private.clear(); return { ok: true }; }
    return { ok: false, reason: "not-loaded" };
  };
  const { store, native, idb, local } = iosStore({
    local: { "cp_pos:e": "1", cp_engine_applied: '{"advances":3}' },
    idb: { "cp_pos:e": "1" },
    native: { "cp_pos:e": "9" },
  });
  const nativeRemove = native.remove;
  native.remove = async (k) => { order.push(`tier-remove:${k}`); return nativeRemove(k); };
  await store.hydrate();
  store.externallyOwned(OWNED_PREFIXES, { purge: engineDataDeletion(send) });
  store.adoptOwnedSet({ "cp_pos:e": "9" });

  const out = await store.purge();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.engine, { ok: true });
  assert.deepEqual(order.slice(0, 2), ["stop:false", "purge"], "stop without persisting, then purge, before any tier");
  assert.ok(order.indexOf("tier-remove:cp_pos:e") > 1);
  assert.deepEqual(engine.private, new Set(), "the engine's private keys go with its purge");
  for (const [name, keys] of [["local", [...local.map.keys()]], ["native", [...native.store.keys()]], ["idb", [...idb.store.keys()]]]) {
    assert.deepEqual(keys.filter((k) => k.startsWith("cp_")), [], `${name} still holds ${keys}`);
  }
  assert.equal(store.ownership().state, OWNERSHIP_EXTERNAL, "the engine still owns the rows after a purge");

  const failing = iosStore();
  await failing.store.hydrate();
  failing.store.externallyOwned(OWNED_PREFIXES, { purge: engineDataDeletion(async (cmd) => (cmd === "purge" ? { ok: false, reason: "relinquished" } : { ok: true })) });
  const bad = await failing.store.purge();
  assert.equal(bad.ok, false, "a purge the engine refused is not a deletion");
  assert.deepEqual(bad.engine, { ok: false, reason: "relinquished" });
  const thrown = iosStore();
  thrown.store.externallyOwned(OWNED_PREFIXES, { purge: async () => { throw new Error("bridge gone"); } });
  const t = await thrown.store.purge();
  assert.equal(t.ok, false);
  assert.equal(t.engine.reason, "engine-purge-failed");
  const web = await createDurableStore({ localStorage: new FakeLocal({ cp_rate: "1" }) }).purge();
  assert.equal("engine" in web, false, "no engine, no engine field: the web's answer is unchanged");
});

test("SINGLE WRITER: a release that lands while hydration's own migration is mid-way still migrates the rows it skipped", async () => {
  /* The migration skips a held row, awaits a write, and the relinquish lands in
     that await: the skipped row belongs to neither the migration (already past
     it) nor the release (hydration has not finished). MUTATION: drop the
     hand-off at the end of `_doHydrate` -> Preferences never gets cp_pos:a. */
  let open;
  let started;
  const gate = new Promise((r) => { open = r; });
  const writing = new Promise((r) => { started = r; });
  const { store, native } = iosStore({ local: { "cp_pos:a": "1", cp_rate: "2" } });
  const write = native.write;
  native.write = async (k, v) => { if (k === "cp_rate") { started(); await gate; } return write(k, v); };
  const hydrated = store.hydrate();
  await writing;                                 // cp_pos:a already skipped, cp_rate in flight
  const released = store.releaseOwnership();
  open();
  await hydrated;
  await released;
  await store.flush();
  assert.deepEqual(ownerWrites(native), ["cp_pos:a"]);
});

/* ---------- audit round 3, player-rest-1: one hung tier call cannot stall the queue ---------- */

/** An IndexedDB stand-in whose FIRST write never settles, the WKWebView
    behaviour client.js records after the app has been in the background. */
function hungOnceDurable() {
  const tier = fakeDurable();
  const write = tier.write;
  let hung = false;
  tier.write = (k, v) => {
    if (!hung) { hung = true; return new Promise(() => {}); }
    return write(k, v);
  };
  return tier;
}

function hungShell({ opDeadlineMs = 30, purgeDeadlineMs = 200 } = {}) {
  const bridge = shellBridge();
  bridge.vault.set("cp_sb_session", "OLD");
  const idb = hungOnceDurable();
  const store = new DurableStore({
    tiers: [localStorageTier(new FakeLocal()), vaultTier(bridge), idb],
    opDeadlineMs, purgeDeadlineMs,
  });
  return { store, bridge, idb };
}

test("player-rest-1: a hung IndexedDB write no longer blocks the vault write of a refreshed token", async () => {
  /* MUTATION: construct with `opDeadlineMs: 0` (the old unbounded wait) or
     delete `_timed` from `_enqueue`, and the vault still holds OLD. */
  const { store, bridge } = hungShell();
  await store.hydrate();
  store.setItem("cp_pos:ep1", "{}");          // the IndexedDB write that hangs
  store.setItem("cp_sb_session", "NEW");      // queued behind it
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bridge.vault.get("cp_sb_session"), "NEW", "the refreshed token reached the vault");
  assert.ok(store.health().faults.length >= 1 || store.health().ok === false, "the hang is recorded as a fault");
});

test("player-rest-1: canKeep says no while a write of the token is still queued", async () => {
  /* MUTATION: delete the `_confinedInFlight` check in `canKeep`. */
  const { store } = hungShell({ opDeadlineMs: 60 });
  await store.hydrate();
  store.setItem("cp_pos:ep1", "{}");
  store.setItem("cp_sb_session", "NEW");
  assert.equal(store.canKeep("cp_sb_session"), false, "not saved and not failed: do not spend the token yet");
  await store.flush();
  assert.equal(store.canKeep("cp_sb_session"), true, "and yes once it has landed");
});

test("player-rest-1: purge behind a queue that will not drain reports unverified instead of hanging", async () => {
  /* Each op is bounded, but a purge still has a deadline of its own: a queue
     that has not drained by then is reported, never waited on for ever.
     MUTATION: `await this._queue` back in `_purge` and this never resolves in
     time. */
  const { store } = hungShell({ opDeadlineMs: 0, purgeDeadlineMs: 50 });
  await store.hydrate();
  store.setItem("cp_pos:ep1", "{}");
  const out = await Promise.race([store.purge(), new Promise((r) => setTimeout(() => r("hung"), 1000))]);
  assert.notEqual(out, "hung", "Delete my data finishes");
  assert.equal(out.ok, false);
  assert.ok(out.unverified.some((u) => u.tier === "queue"), JSON.stringify(out.unverified));
});

test("player-rest-4: listProgress reads a DurableStore's keys in ONE snapshot, not one rebuild per index", () => {
  /* `length` and `key(i)` each rebuild the owned-key array, so walking them
     was O(n²) in every cp_ row (3,000 cp_pos rows: ~210 ms on a desktop).
     MUTATION: delete the `storage.keys` branch in `listProgress` and the
     rebuild count is n + 1. */
  const store = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  for (let i = 0; i < 300; i++) store.setItem(`cp_pos:ep${i}`, "{\"seconds\":1}");
  store.setItem(progressKey(ID), JSON.stringify(makeProgress({ forayId: ID, title: "t", elapsedSec: 10, totalSec: 100 })));
  let rebuilds = 0;
  const owned = store._ownedKeys.bind(store);
  store._ownedKeys = () => { rebuilds += 1; return owned(); };
  const rows = listProgress(store);
  assert.equal(rows.length, 1, "the one Foray row is found");
  assert.equal(rows[0].foray_id, ID);
  assert.ok(rebuilds <= 1, `one snapshot, got ${rebuilds} rebuilds`);
});

test("player-rest-4: DurableStore.keys(prefix) is the owned keys under that prefix", () => {
  const store = new DurableStore({ tiers: [localStorageTier(new FakeLocal())] });
  store.setItem("cp_pos:a", "1");
  store.setItem("cp_foray:x", "{}");
  assert.deepEqual(store.keys("cp_foray:"), ["cp_foray:x"]);
  assert.deepEqual(store.keys().sort(), ["cp_foray:x", "cp_pos:a"]);
});
