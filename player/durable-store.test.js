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
  DEFAULT_PREFIX, HEALTH_KEY, MAX_FAULTS, MAX_CONSECUTIVE_TIER_FAILURES,
  PERSIST_GRANTED, PERSIST_DENIED, PERSIST_UNSUPPORTED, PERSIST_ERROR, PERSIST_UNKNOWN,
} from "./durable-store.js";
import { ForayProgressStore, makeProgress, readProgress, progressKey } from "./foray-progress.js";

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
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
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
