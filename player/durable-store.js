/* Durable user state — the store a browser eviction does not orphan (#40).

   ── The defect ────────────────────────────────────────────────────────────
   Every piece of state this app has ever learned about a listener lives in
   `localStorage` under the legacy `cp_` prefix: their interests, their thumbs,
   their episode positions, the Supabase anonymous token that IS their identity
   (ADR-0005), and — since resume shipped — where they are inside a 61-minute
   Foray. `localStorage` is evictable. Safari clears script-writable storage
   after ~7 days without a visit, every engine can evict under storage pressure,
   and a WKWebView's storage is not durable by default. So the listener we most
   want, the one part-way through an hour who comes back next week, is exactly
   the one who loses their place — and losing it after having it is worse than
   never having had it.

   ── What this is ──────────────────────────────────────────────────────────
   A Storage-shaped SYNCHRONOUS facade over an ordered list of TIERS.

     getItem / setItem / removeItem / key / length      ← unchanged callers
       memory (authoritative for reads, always current)
         ├─ sync tiers    localStorage         (fast, evictable, may throw)
         └─ async tiers   IndexedDB            (write-behind, larger quota)
                          Capacitor Preferences (native, #40's "app tomorrow")

   The facade is synchronous because every caller is: `lsGet`/`lsSet` in app.js,
   `PositionStore`, `ForayProgressStore`, and the render loop that writes a
   position 12 times a minute. Making those async would have meant rewriting the
   player's effect loop to fix a storage bug, which is the kind of trade that
   turns a fix into an outage. So reads come out of memory, hydrated
   synchronously from localStorage at construction and asynchronously from the
   durable tiers a moment later; writes go to memory and localStorage
   synchronously and ride a serial queue down to the durable tiers.

   ── Three properties this file is written to guarantee ─────────────────────

   1. NOTHING IS EVER DELETED TO MIGRATE IT. `localStorage` is a MIRROR, not a
      staging area. `hydrate()` copies local-only rows down into the durable
      tiers and durable-only rows back up into localStorage, and removes
      nothing. A listener mid-Foray when this ships cannot lose their place to
      the fix, because the fix only ever adds a copy.

   2. A WRITE THIS SESSION IS NEVER CLOBBERED BY HYDRATION. Hydration races the
      first paint. Without a rule, a page that read an empty `cp_interests`
      (because localStorage was evicted), wrote taxonomy defaults, and only then
      heard back from IndexedDB would overwrite the real profile with defaults —
      the fix causing the defect. Every key written since construction is
      `_dirty` and hydration will not touch it. Callers should still await
      `hydrate()` before their first write; `_dirty` is the belt to that braces.

   3. A FAILED WRITE IS DETECTABLE. The code this replaces was `catch (_) {}` in
      four places, which is how "silently forgot you" happens. Here:
        - `setItem` THROWS when no tier accepted responsibility, so
          `writeProgress`'s existing `return false` keeps meaning what it says;
        - every failure lands in `health()` with tier, op, key and message;
        - `onFault` fires once per failure so the app can log an event;
        - the health record is mirrored to `cp_storage_health` best-effort.
      `health()` is always readable even when every tier is dead, because it
      lives in memory.

   ── What this does NOT fix, stated rather than assumed ─────────────────────
   IndexedDB is not immune to eviction. Safari's ~7-day sweep covers ALL
   script-writable storage for the origin, IndexedDB included, and Chromium
   evicts a whole origin bucket at once. So a second tier does not by itself
   defeat eviction, and this file does not claim it does. What the second tier
   actually buys is:
     - the failure modes are INDEPENDENT where they can be: localStorage is a
       hard ~5 MB cap that throws `QuotaExceededError`, and is unavailable
       outright in some contexts (blocked cookies raise `SecurityError`), where
       IndexedDB has a share-of-disk quota and its own availability;
     - `navigator.storage.persist()` protects quota-managed storage, which is
       the tier model this file is built on — see `requestPersistence`, and note
       that it is a REQUEST a browser may refuse;
     - it is the substrate the native shell replaces with `UserDefaults` /
       `SharedPreferences`, which genuinely are not evictable — that is #40's
       "app tomorrow" and this tier list is the seam it drops into.
   The Safari "7 days with no visit" case has no JavaScript fix at all: the real
   remedies are an installed (Home Screen) web app and a server-side copy under
   the anonymous session. Both are recorded in the PR body, not implemented
   here.

   Pure by construction: no `localStorage`, `indexedDB` or `navigator` reference
   of its own. Everything is injected, which is what makes the failure paths
   testable without a browser.
*/

/** The namespace this store owns. CLAUDE.md § Conventions: the legacy `cp_`
    prefix stays — renaming a key wipes user state, so the shim changes the
    BACKING STORE and never the key names. */
export const DEFAULT_PREFIX = "cp_";

/** Where the health record is mirrored, so a fault survives a reload even
    though nothing reads it to decide anything. Prefixed like everything else. */
export const HEALTH_KEY = "cp_storage_health";

/** Faults are kept for inspection, not forever — a permanently broken tier
    would otherwise grow this without bound. */
export const MAX_FAULTS = 20;

/* ---------- persistence: a request, not a setting ---------- */

export const PERSIST_GRANTED = "granted";
export const PERSIST_DENIED = "denied";
export const PERSIST_UNSUPPORTED = "unsupported";
export const PERSIST_ERROR = "error";
export const PERSIST_UNKNOWN = "unknown";

/**
 * Ask the browser to exempt this origin's storage from eviction.
 *
 * `navigator.storage.persist()` is a REQUEST. Chromium grants it silently from
 * engagement/installation heuristics, Firefox may prompt, and Safari does not
 * meaningfully honour it. A refusal is the expected case, not an error, and it
 * changes nothing about how this store behaves — both tiers still work, and the
 * refusal is recorded so "your place may not survive a week" is a fact in the
 * data rather than an assumption in a comment.
 *
 * Never throws: a rejected promise, a missing API and a hostile shim all come
 * back as one of the five states above.
 *
 * @param {object|null} nav  a `navigator`-shaped object; injected for tests
 * @returns {Promise<{state: string, already: boolean, error?: string}>}
 */
export async function requestPersistence(nav) {
  const sm = nav && nav.storage;
  if (!sm || typeof sm.persist !== "function") {
    return { state: PERSIST_UNSUPPORTED, already: false };
  }
  try {
    if (typeof sm.persisted === "function" && (await sm.persisted())) {
      // Already granted on a previous visit. Asking again is not free and not
      // needed, and some engines count repeat prompts against you.
      return { state: PERSIST_GRANTED, already: true };
    }
    const granted = await sm.persist();
    return { state: granted ? PERSIST_GRANTED : PERSIST_DENIED, already: false };
  } catch (err) {
    return { state: PERSIST_ERROR, already: false, error: errText(err) };
  }
}

/* ---------- tiers ---------- */

/**
 * A tier is the whole contract, and it is small on purpose — a native
 * Preferences tier is ~20 lines against this shape.
 *
 * @typedef {object} DurableTier
 * @property {string} name
 * @property {boolean} sync      true = readable and writable synchronously
 * @property {boolean} [durable] true = expected to outlive localStorage
 * @property {(prefix: string) => Map<string,string>} [snapshot]  sync tiers only
 * @property {(prefix: string) => Promise<Map<string,string>>} [readAll]  async tiers only
 * @property {(key: string, value: string) => void|Promise<void>} write
 * @property {(key: string) => void|Promise<void>} remove
 */

/**
 * The `localStorage` tier — kept, deliberately, as a first-class mirror.
 *
 * It is the fallback wherever IndexedDB is unavailable (and it is the ONLY tier
 * that can be written synchronously at `pagehide`, which is why a position
 * survives a backgrounded tab even when the durable write never lands: the next
 * `hydrate()` migrates it down).
 *
 * Enumerated through `length`/`key(i)` rather than `Object.keys`, because that
 * is the part of the Storage interface that is actually specified.
 */
export function localStorageTier(ls, { name = "local" } = {}) {
  if (!ls || typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
  return {
    name,
    sync: true,
    durable: false,
    snapshot(prefix) {
      const out = new Map();
      const n = Number(ls.length) || 0;
      for (let i = 0; i < n; i++) {
        let key = null;
        try { key = ls.key(i); } catch (_) { continue; }
        if (typeof key !== "string" || !key.startsWith(prefix)) continue;
        let value = null;
        try { value = ls.getItem(key); } catch (_) { continue; }
        if (typeof value === "string") out.set(key, value);
      }
      return out;
    },
    get(key) { return ls.getItem(key); },
    write(key, value) { ls.setItem(key, value); },
    remove(key) { ls.removeItem(key); },
  };
}

/* ---------- the store ---------- */

export class DurableStore {
  /**
   * @param {object} [opts]
   * @param {DurableTier[]} [opts.tiers]  in preference order; nulls are dropped,
   *   so `tiers: [localStorageTier(ls), makeIdbTier({...})]` is safe when either
   *   is unavailable
   * @param {string} [opts.prefix]
   * @param {Function} [opts.onFault]  (fault, health) — the app logs an event
   * @param {Function} [opts.now]      injected clock, so a fault has a testable ts
   */
  constructor({ tiers = [], prefix = DEFAULT_PREFIX, onFault = null, now = null } = {}) {
    this.prefix = typeof prefix === "string" && prefix ? prefix : DEFAULT_PREFIX;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._onFault = typeof onFault === "function" ? onFault : null;

    /** Authoritative for every read. Owned keys only. */
    this._mem = new Map();
    /** Written since construction. Hydration must never clobber these. */
    this._dirty = new Set();
    /** What each async tier already had at hydration, so migration writes the
        rows that are missing rather than the whole namespace every launch. */
    this._seen = new Map();

    this._sync = [];
    this._async = [];
    for (const t of tiers) {
      if (!t || typeof t.write !== "function") continue;
      (t.sync ? this._sync : this._async).push(t);
    }

    this._faults = [];
    this._stats = new Map();
    this._pending = 0;
    this._queue = Promise.resolve();
    this._persist = { state: PERSIST_UNKNOWN, already: false };
    this._hydrated = false;
    this._hydrating = null;
    this._inFault = false;
    this._inHealth = false;

    this._loadSync();
  }

  /* ---------- the Storage-shaped facade ---------- */

  /** Owned keys, in insertion order. Pass-through keys are deliberately NOT
      enumerated — see `getItem`. Every key this app uses is `cp_`-prefixed, and
      `listProgress` only ever walks `cp_foray:`. */
  get length() { return this._ownedKeys().length; }

  key(i) {
    const keys = this._ownedKeys();
    return Number.isInteger(i) && i >= 0 && i < keys.length ? keys[i] : null;
  }

  /**
   * Reads never touch a tier: memory is hydrated from localStorage before the
   * constructor returns, so the first paint is as fast as it was.
   *
   * A key OUTSIDE the owned prefix passes straight through to the sync tier and
   * is not mirrored anywhere. That keeps the store honest about its scope: it is
   * the `cp_` namespace's durable home, not a general localStorage replacement.
   */
  getItem(key) {
    const k = String(key);
    if (!this.owns(k)) return this._passGet(k);
    return this._mem.has(k) ? this._mem.get(k) : null;
  }

  /**
   * Write to memory, to every sync tier, and (behind the scenes) to every
   * durable tier.
   *
   * THROWS when nothing took responsibility — no sync tier accepted the value
   * and there is no durable tier to enqueue it to. That is real `Storage`
   * behaviour (`setItem` throws on quota) and it is what keeps
   * `writeProgress()`'s `return false` truthful. Memory is still updated first,
   * so the current session stays coherent even though the value is not durable.
   *
   * A durable write that fails LATER cannot be reported this way. It is reported
   * through `health()` and `onFault` instead — see the header, property 3.
   */
  setItem(key, value) {
    const k = String(key);
    const v = String(value);
    if (!this.owns(k)) { this._passSet(k, v); return; }
    this._mem.set(k, v);
    this._dirty.add(k);
    const accepted = this._writeSync(k, v);
    const queued = this._enqueue((t) => t.write(k, v), k, "write");
    if (!accepted && !queued) {
      // A browser that has taken storage away entirely leaves no tier to fault,
      // so record one: `health().ok` must be false here too, not merely the
      // throw's problem.
      if (!this._sync.length && !this._async.length) {
        this._fault("none", "write", new Error("no storage tier available"), k);
      }
      const last = this._faults[this._faults.length - 1];
      throw new Error(
        `no storage tier accepted ${k}` + (last ? `: ${last.tier} ${last.error}` : "")
      );
    }
  }

  /** Removing is a write too: it must survive hydration, or a "start over"
      would be undone by the durable copy the next time the page loads. */
  removeItem(key) {
    const k = String(key);
    if (!this.owns(k)) { this._passRemove(k); return; }
    this._mem.delete(k);
    this._dirty.add(k);
    for (const t of this._sync) {
      try { t.remove(k); } catch (err) { this._fault(t.name, "remove", err, k); }
    }
    this._enqueue((t) => t.remove(k), k, "remove");
  }

  owns(key) { return typeof key === "string" && key.startsWith(this.prefix); }

  /* ---------- lifecycle ---------- */

  /**
   * Pull the durable tiers up into memory, then push anything they are missing
   * back down. Memoised: every caller can call it, only the first one works.
   *
   * CALL THIS BEFORE THE FIRST WRITE. It is one `getAll` and it can run
   * concurrently with the data fetches, so it costs nothing on the critical
   * path — and reading `cp_interests` or `cp_sb_session` before it finishes is
   * how a restored profile gets overwritten by a fresh one. `_dirty` limits the
   * damage; ordering prevents it.
   */
  hydrate() {
    if (!this._hydrating) this._hydrating = this._doHydrate();
    return this._hydrating;
  }

  /** Resolves once every queued durable write has been attempted. Tests await
      it; `pagehide` calls it and cannot await, which is fine — the synchronous
      localStorage write already happened. */
  async flush() {
    await this._queue;
    return this.health();
  }

  /** Ask for eviction exemption and record the answer. Never throws; a refusal
      is a recorded fact, not a failure path. */
  async requestPersistence(nav) {
    this._persist = await requestPersistence(nav);
    if (this._persist.state !== PERSIST_GRANTED) this._recordHealth();
    return this._persist;
  }

  /**
   * The failure record. Always readable, even with every tier dead, because it
   * is assembled from memory.
   *
   * `ok` is false when any tier has ever failed a write or a read this session.
   * That is deliberately sensitive: a single lost write is the whole defect.
   */
  health() {
    const tiers = {};
    for (const t of [...this._sync, ...this._async]) {
      const s = this._stat(t.name);
      tiers[t.name] = {
        durable: Boolean(t.durable),
        sync: Boolean(t.sync),
        writes: s.writes,
        failures: s.failures,
        migrated: s.migrated,
        lastError: s.lastError,
      };
    }
    return {
      ok: this._faults.length === 0,
      hydrated: this._hydrated,
      durableTiers: this._async.filter((t) => t.durable).map((t) => t.name),
      persisted: this._persist.state,
      persistedAlready: Boolean(this._persist.already),
      keys: this._ownedKeys().length,
      pending: this._pending,
      tiers,
      faults: this._faults.slice(-MAX_FAULTS),
    };
  }

  /* ---------- internals ---------- */

  _ownedKeys() {
    return [...this._mem.keys()];
  }

  _stat(name) {
    let s = this._stats.get(name);
    if (!s) {
      s = { writes: 0, failures: 0, migrated: 0, lastError: null };
      this._stats.set(name, s);
    }
    return s;
  }

  _ok(name) { this._stat(name).writes += 1; }

  _loadSync() {
    for (const t of this._sync) {
      let snap = null;
      try { snap = typeof t.snapshot === "function" ? t.snapshot(this.prefix) : null; }
      catch (err) { this._fault(t.name, "read", err); continue; }
      if (!snap) continue;
      // First tier wins: the list is in preference order.
      for (const [k, v] of snap) if (!this._mem.has(k)) this._mem.set(k, v);
    }
  }

  _writeSync(key, value) {
    let accepted = false;
    for (const t of this._sync) {
      try { t.write(key, value); this._ok(t.name); accepted = true; }
      catch (err) { this._fault(t.name, "write", err, key); }
    }
    return accepted;
  }

  /** @returns {boolean} whether anything was queued (i.e. whether a durable
      tier exists to take responsibility for this write). */
  _enqueue(op, key, kind) {
    if (!this._async.length) return false;
    this._pending += 1;
    const done = () => { this._pending -= 1; };
    this._queue = this._queue.then(async () => {
      for (const t of this._async) {
        try { await op(t); this._ok(t.name); }
        catch (err) { this._fault(t.name, kind, err, key); }
      }
    }).then(done, done);
    return true;
  }

  _passGet(key) {
    for (const t of this._sync) {
      try {
        const v = typeof t.get === "function" ? t.get(key) : null;
        if (v != null) return v;
      } catch (_) { /* fall through */ }
    }
    // No sync tier exposes a raw getter, so an unowned read is a miss rather
    // than a guess. Callers of unowned keys are outside this store's contract.
    return null;
  }

  _passSet(key, value) {
    for (const t of this._sync) {
      try { t.write(key, value); } catch (_) { /* unowned: nothing depends on it */ }
    }
  }

  _passRemove(key) {
    for (const t of this._sync) {
      try { t.remove(key); } catch (_) { /* unowned */ }
    }
  }

  async _doHydrate() {
    for (const t of this._async) {
      let rows = null;
      try {
        rows = typeof t.readAll === "function" ? await t.readAll(this.prefix) : null;
      } catch (err) {
        this._fault(t.name, "read", err);
        continue;
      }
      const seen = new Set();
      this._seen.set(t.name, seen);
      if (!rows) continue;
      for (const [k, v] of rows) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        if (!this.owns(k)) continue;
        seen.add(k);
        if (k === HEALTH_KEY) continue;          // diagnostics, never authoritative
        if (this._dirty.has(k)) continue;        // property 2: this session wins
        const mine = this._mem.has(k) ? this._mem.get(k) : null;
        if (mine === null) { this._adopt(k, v); continue; }   // localStorage lost it
        if (mine === v) continue;
        if (isNewer(v, mine)) { this._adopt(k, v); continue; }
        /* Local won the conflict, so the durable tier is holding a STALE row.
           Dropping it from `seen` is what makes `_migrateUp` push the winner
           down — without this line the tier keeps the old value forever and the
           next eviction restores a listener to a position they had already moved
           past. Caught by "a local row that is newer is kept, not overwritten". */
        seen.delete(k);
      }
    }
    await this._migrateUp();
    this._hydrated = true;
    return this;
  }

  /**
   * Take a durable tier's value as the truth for this key, and write it back up
   * into localStorage so the fast path has it too.
   *
   * NOT marked dirty and NOT re-queued downward: the durable tier is where it
   * came from, and marking it dirty would make the next hydration ignore a
   * genuinely newer durable row.
   */
  _adopt(key, value) {
    this._mem.set(key, value);
    this._writeSync(key, value);
  }

  /**
   * Property 1, the migration itself: every row the durable tiers do not have
   * is copied down. Nothing is deleted from localStorage, then or ever.
   *
   * `migrated` is counted per tier so the migration is visible in `health()`
   * rather than being something you have to take on trust.
   */
  async _migrateUp() {
    if (!this._async.length) return;
    const rows = [...this._mem.entries()].filter(([k]) => k !== HEALTH_KEY);
    for (const t of this._async) {
      const seen = this._seen.get(t.name) ?? new Set();
      for (const [k, v] of rows) {
        if (seen.has(k) && !this._dirty.has(k)) continue;
        try {
          await t.write(k, v);
          this._ok(t.name);
          this._stat(t.name).migrated += 1;
          seen.add(k);
        } catch (err) {
          this._fault(t.name, "migrate", err, k);
        }
      }
    }
  }

  _fault(tier, op, err, key = null) {
    const s = this._stat(tier);
    s.failures += 1;
    s.lastError = errText(err);
    const fault = { tier, op, key: key ?? null, error: s.lastError, at: this._now() };
    this._faults.push(fault);
    while (this._faults.length > MAX_FAULTS) this._faults.shift();
    this._recordHealth();
    if (this._onFault && !this._inFault) {
      this._inFault = true;
      // The app's fault sink writes an event, which writes to storage, which can
      // fault. One level, no recursion.
      try { this._onFault(fault, this.health()); } catch (_) {}
      this._inFault = false;
    }
  }

  /**
   * Mirror the health record into the sync tiers and memory.
   *
   * Deliberately NOT queued to the durable tiers: a permanently failing durable
   * write would fault, which would write health, which would fault, forever.
   * Diagnostics must not be able to become the outage.
   */
  _recordHealth() {
    if (this._inHealth) return;
    this._inHealth = true;
    try {
      const blob = JSON.stringify(this.health());
      this._mem.set(HEALTH_KEY, blob);
      for (const t of this._sync) {
        try { t.write(HEALTH_KEY, blob); } catch (_) { /* memory still has it */ }
      }
    } catch (_) { /* health must never be the thing that throws */ }
    this._inHealth = false;
  }
}

/* ---------- helpers ---------- */

/**
 * Is `candidate` a more recent version of the same record than `mine`?
 *
 * Every row this store holds that can conflict is a JSON object carrying an ISO
 * timestamp — `updated_at` on a progress row, `ts` on an event, `updated_at` on
 * a position. When both sides carry one, the later one wins. When either does
 * not, LOCAL WINS: `mine` is what this session has been reading and writing, and
 * silently swapping it for an equally-undated durable row would be a coin flip
 * with a listener's place in an hour-long Foray.
 */
export function isNewer(candidate, mine) {
  const a = stampOf(candidate);
  const b = stampOf(mine);
  if (a === null || b === null) return false;
  return a > b;
}

function stampOf(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  for (const field of ["updated_at", "updatedAt", "ts"]) {
    const t = Date.parse(parsed[field]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function errText(err) {
  if (!err) return "unknown error";
  const name = err.name ? String(err.name) : "";
  const msg = err.message ? String(err.message) : String(err);
  return name && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
}

/**
 * The whole thing, wired, for a browser.
 *
 * Every dependency is injected so the app can hand in what it has and tests can
 * hand in fakes. A missing `localStorage` or a missing `indexedDB` costs that
 * tier and nothing else; a store with NO tiers still works for the length of the
 * session and reports `ok: false` the moment it is asked to write, which is the
 * honest answer for a browser that has taken storage away entirely.
 */
export function createDurableStore({
  localStorage: ls = null,
  idbTier = null,
  prefix = DEFAULT_PREFIX,
  onFault = null,
  now = null,
} = {}) {
  return new DurableStore({
    tiers: [localStorageTier(ls), idbTier],
    prefix,
    onFault,
    now,
  });
}
