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
         └─ async tiers   Capacitor Preferences (native shell only: iOS
                                                UserDefaults / Android
                                                SharedPreferences — NOT evictable)
                          IndexedDB            (write-behind, larger quota)
         └─ vault         ForayVault           (native shell only, and ONLY the
                                                auth token: iOS Keychain this-
                                                device-only / Android no-backup
                                                storage — never in a phone backup)

   Every tier but the vault rides the phone's own backup, and that is intended:
   the founder ruled on 2026-09-24 that the token alone stays on the device
   (persist-6). See "the device-only vault" below.

   The Preferences tier exists only inside the native shell, where the plugin
   is registered (`mobile/package.json` has carried `@capacitor/preferences`
   since #36 and `cap sync` links it on both platforms); on the web
   `preferencesTier` answers null and the list is localStorage + IndexedDB.
   Until 2026-09-22 this diagram listed the native tier while nothing built it,
   so inside the shipping app both live tiers were script-evictable — the exact
   defect #40 names — while this header said otherwise (design/QA audit).

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
      The one exception is the auth token inside the native shell (persist-6):
      it is MOVED into the vault, and removed from the backed-up tiers only once
      the vault has taken it — so the move, too, never costs the value.
      Apart from that move, the one deletion here is `purge()` (#42), the opposite
      case: a listener asking for all of it to go. It deletes from EVERY tier and
      then re-reads them, because the tiering that protects a resume point from
      eviction is the same tiering that would leave half a listener behind.

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
        - `onFault` fires per failure, up to a budget, so the app can log an
          event — see `_fault`, and note that the app's sink WRITES, so this path
          feeds itself and needs two brakes rather than a re-entrancy flag;
        - the health record is mirrored to `cp_storage_health` best-effort.
      `health()` is always readable even when every tier is dead, because it
      lives in memory.

   4. A MIRROR THAT REFUSED A WRITE IS NOT BELIEVED NEXT LAUNCH. `setItem` only
      throws when NOTHING took the value, so a full or blocked localStorage with
      a live durable tier returns normally: the session reads the new value from
      memory, the durable tier holds it — and localStorage still holds the OLD
      one. Almost no `cp_` row carries a timestamp for `isNewer` to compare
      (`cp_queue`, `cp_saved`, `cp_interests`, `cp_sb_session` and a dozen more
      do not), so hydration's "local wins" rule used to adopt that stale mirror
      AND push it down over the good durable copy: the change was undone on the
      next launch and then lost for good, and losing `cp_sb_session` that way
      makes the listener a new anonymous account. So a key the sync tier refused
      is written down in `LOCAL_STALE_KEY` (in the durable tiers, first, because
      the sync tier is the one that just said no) and hydration takes the durable
      row for it instead. The mark clears the moment the sync tier accepts the
      key again. 2026-09-22 audit; the "localStorage refused" tests pin it.

   5. ON THE iOS SHELL, THE ENGINE'S ROWS HAVE ONE WRITER (NE-23, native-engine
      plan §4.6). The native engine writes `cp_pos:*`, `cp_foray:*` and
      `cp_last_episode` straight into UserDefaults — the same rows the
      Preferences tier holds — and a page is the one writer that can be STALE:
      loaded an hour ago, reloaded from an evicted mirror, or a service-worker
      generation behind the binary. Most of these rows carry no timestamp
      `isNewer` could compare on (and those that do are compared against a
      mirror nobody refreshed), so hydration's "local wins" used to push the
      page's stale localStorage copy down over the engine's newer row, and
      re-push a row the engine had deleted. So those prefixes are DEFERRED from
      the moment the store is constructed — see "single writer" below: read,
      never written down, until the page knows which lane plays. Only the iOS
      shell passes them (`deferredPrefixesFor`); the web and Android build the
      store exactly as before.

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
     - inside the native shell it sits beside `UserDefaults` /
       `SharedPreferences` (`preferencesTier` below), which genuinely are not
       evictable — that is #40's "app tomorrow", and it is wired, not planned.
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

/** Which keys the sync tier (localStorage) REFUSED to update while a durable
    tier took them — header, property 4. A JSON array of key names. Written to
    the durable tiers only, never to memory or the sync tier: it describes the
    sync tier's staleness, so the sync tier is the last place it could live, and
    keeping it out of memory keeps it out of `length`/`key(i)` and out of what
    the app can read. Prefixed like everything else, so `purge()` finds it. */
export const LOCAL_STALE_KEY = "cp_storage_stale";

/** Faults are kept for inspection, not forever — a permanently broken tier
    would otherwise grow this without bound. Doubles as the budget for `onFault`
    notifications; see `_fault`. */
export const MAX_FAULTS = 20;

/**
 * Consecutive failures after which an async tier is dropped from the write path.
 *
 * WHY THIS EXISTS — review found the loop it closes. The app's fault sink logs an
 * event, and logging an event is a write. A permanently failing durable tier
 * therefore self-feeds: write fails → fault → sink → write → fails → fault,
 * forever, one queued write per iteration. `_inFault` cannot stop it because the
 * failure arrives asynchronously, on a later tick, with the guard already
 * cleared. A dead tier has to stop being asked.
 *
 * Once every async tier is disabled, `setItem` starts throwing again when the
 * sync tier also refuses — which is the honest answer, not a regression.
 */
export const MAX_CONSECUTIVE_TIER_FAILURES = 5;

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

/** The Capacitor plugin name `cap sync` registers for `@capacitor/preferences`. */
export const PREFERENCES_PLUGIN = "Preferences";

/**
 * The native tier: Capacitor Preferences, i.e. iOS `UserDefaults` and Android
 * `SharedPreferences` — the one place in the shipping app that a WebView's
 * storage sweep cannot reach (#40's "app tomorrow").
 *
 * Talks to the plugin through `Capacitor.nativePromise`, the same call the
 * shell's own plugins make (`mobile/plugins/foray-tts/web/foray-tts.js`), so the
 * web page needs no import and no bundle: the plugin is already compiled into
 * the app by `cap sync` from `mobile/package.json`.
 *
 * Returns null — no tier, not a broken one — on the web (no `window.Capacitor`),
 * on a bridge that reports a non-native platform, and on a shell build whose
 * native side lacks the plugin. A build where the call fails anyway faults like
 * any other durable tier: read failure means "could not look", and five write
 * failures in a row trip the circuit breaker, so a missing plugin costs this
 * tier and nothing else.
 *
 * @param {object|null} bridge  `window.Capacitor`, or a fake
 */
export function preferencesTier(bridge, { name = "native" } = {}) {
  return nativeKvTier(bridge, PREFERENCES_PLUGIN, name);
}

/* ---------- the device-only vault (round-2 audit, persist-6) ----------

   THE FOUNDER'S RULING, 2026-09-24, "Option A": the auth token stays on the
   device and out of the phone's backups; everything else stays where it is and
   IS backed up, and the privacy policy says both plainly.

   Every tier above rides the phone's own backup. localStorage and IndexedDB
   live in the WebView's data directory, and Preferences is `UserDefaults` /
   `SharedPreferences` — all three inside the app container that iCloud / Finder
   backup and Android Auto Backup copy by default. For most rows that is what a
   listener wants (a new phone keeps their place). For `cp_sb_session` it was a
   defect: the token IS the anonymous account (ADR-0005), so restoring a backup
   taken before "Delete my data" handed the deleted account's live refresh token
   back to the app, which re-attached to it — contradicting §3/§7 of the policy
   ("it cuts the link") and the old §1 claim that the native copy "never leaves
   the device".

   So a DEVICE-ONLY key lives in exactly one durable place inside the native
   shell: the vault, `mobile/plugins/foray-vault/`.
     - iOS: a Keychain generic-password item, accessibility
       `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronizable
       — so it is not in iCloud Keychain and cannot be restored onto another
       phone. A first launch after a reinstall wipes it, because iOS keeps
       Keychain items across an uninstall and the app never used to survive one.
     - Android: a file in `getNoBackupFilesDir()`, which Auto Backup and
       device-to-device transfer always skip.
   It is NOT written to localStorage, IndexedDB or Preferences at all. On the web
   there is no vault (no `window.Capacitor`) and nothing changes: a browser has
   no phone backup to leak into.

   The migration keeps property 1's spirit — nothing is deleted until the copy
   it is moving to has taken it. A token an earlier build left in the three
   backed-up tiers is written to the vault first; only once that write has
   succeeded is it removed from them. A vault that cannot be read or written
   leaves the old copies exactly where they are. */

/** The rows that must never be in a phone backup. Only the credential: the
    founder ruled the rest of the app's data stays backed up. */
export const DEVICE_ONLY_KEYS = Object.freeze(["cp_sb_session"]);

/** The plugin name `mobile/plugins/foray-vault/` registers on both platforms. */
export const VAULT_PLUGIN = "ForayVault";

/** Both native tiers speak the same four calls (`keys`/`get`/`set`/`remove`),
    because the vault plugin copies the Preferences plugin's method shapes. */
function nativeKvTier(bridge, plugin, name) {
  if (!bridge || typeof bridge.nativePromise !== "function") return null;
  if (typeof bridge.isNativePlatform === "function" && !bridge.isNativePlatform()) return null;
  if (typeof bridge.isPluginAvailable === "function" && !bridge.isPluginAvailable(plugin)) return null;
  const call = (method, options) => bridge.nativePromise(plugin, method, options);
  return {
    name,
    sync: false,
    durable: true,
    async readAll(prefix) {
      const listed = await call("keys", {});
      const keys = Array.isArray(listed && listed.keys) ? listed.keys : [];
      const owned = keys.filter((k) => typeof k === "string" && (!prefix || k.startsWith(prefix)));
      // One bridge round trip per key, in parallel: a few dozen rows, once a launch.
      const values = await Promise.all(owned.map((key) => call("get", { key })));
      const out = new Map();
      owned.forEach((key, i) => {
        const v = values[i] && values[i].value;
        if (typeof v === "string") out.set(key, v);
      });
      return out;
    },
    async write(key, value) { await call("set", { key, value }); },
    async remove(key) { await call("remove", { key }); },
  };
}

/**
 * The vault tier: where DEVICE_ONLY_KEYS live inside the native shell, and the
 * only place they live there (see the block above).
 *
 * Null — no vault, not a broken one — on the web, on a non-native bridge, and on
 * a shell build that predates the plugin. With no vault the store behaves
 * exactly as it did before 2026-09-24, token included.
 *
 * @param {object|null} bridge  `window.Capacitor`, or a fake
 */
export function vaultTier(bridge, { name = "vault" } = {}) {
  const tier = nativeKvTier(bridge, VAULT_PLUGIN, name);
  if (tier) tier.vault = true;
  return tier;
}

/* ---------- single writer: the native engine's rows (NE-23, plan §4.6) ----------

   Three states, one way only:

     deferred  from construction, on the iOS shell. The rows are READ — the
               first paint and hydration still know every position — but
               nothing is written anywhere for them: not down into Preferences
               or IndexedDB (`_migrateUp`), not up into localStorage (`_adopt`),
               and a page write lands in memory only. Nothing is decided yet,
               so nothing is committed.
     external  hello said the native engine plays (`externallyOwned`). The
               engine is the only writer for the rest of the process: a page
               write is REFUSED with a `fault externally-owned` row and never
               throws (a throw would take `writeProgress`'s caller down over a
               row the page should not have been writing). `adoptOwnedSet`
               replaces the page's copy with the engine's rows on every attach.
     released  hello said legacy/js, or the engine relinquished
               (`releaseOwnership`). The page is the writer again, and the
               migration deferral held back runs — once — so the tiers end up
               exactly where they would have been with no deferral at all.

   WHY REPLACE-SET AND NOT TOMBSTONES (plan §13, item 15). A row the engine
   deleted is simply absent from what `engineRead("rows")` returns, and the
   page's copy of it is dropped from memory — and, on release, from every tier
   that still holds it. Tombstones would change row formats the web, Android
   and the JS lane all read; replace-set gives the same "never resurrected"
   guarantee without touching a single row.

   `cp_engine_applied` is NOT one of these: it is the page's own watermark
   (NE-13), written by the page in every mode. */

/** The states above, as `ownership().state` reports them. */
export const OWNERSHIP_DEFERRED = "deferred";
export const OWNERSHIP_EXTERNAL = "external";
export const OWNERSHIP_RELEASED = "released";

/** The `tier` of a refused write's fault, and its `error`: the page tried to
    write a row the engine owns. The token is `FAULT_KINDS`'s own spelling
    (engine-vocabulary.js), so the Copy report counts it as the engine's
    `fault externally-owned` (NE-26r); durable-store.test.js pins the two
    spellings together rather than importing the vocabulary into the store. */
export const OWNER_TIER = "engine";
export const EXTERNALLY_OWNED = "externally-owned";

/**
 * The prefixes a store should defer from construction: `prefixes` inside the
 * iOS Capacitor shell, where the native engine exists, and none anywhere else.
 *
 * The web has no engine, and Android never gains one (plan §11): deferring
 * there would hold back a migration nothing will ever release. `getPlatform()`
 * is Capacitor's own answer ("ios" | "android" | "web"); a bridge without it is
 * an older shell that predates the engine, and defers nothing.
 *
 * @param {object|null} bridge  `window.Capacitor`, or a fake
 * @param {readonly string[]} prefixes  engine-contract.js's OWNED_PREFIXES
 */
export function deferredPrefixesFor(bridge, prefixes) {
  if (!bridge || typeof bridge.getPlatform !== "function") return [];
  if (typeof bridge.isNativePlatform === "function" && !bridge.isNativePlatform()) return [];
  let platform = null;
  try { platform = bridge.getPlatform(); } catch (_) { return []; }
  return platform === "ios" && Array.isArray(prefixes) ? [...prefixes] : [];
}

/**
 * The engine's half of "Delete my data" in native mode (NE-23): stop without
 * persisting, THEN purge, and only then the page's own purge
 * (`DurableStore.purge`, which calls this first).
 *
 * The stop comes first for the reason `stopForDataDeletion` exists on the web:
 * a playing engine writes a position every few seconds, and one landing after
 * the purge is a row the listener just asked to be gone. The engine's purge is
 * what reaches what the page cannot see at all — its private keys
 * (`ForayEngine.*` in UserDefaults, outside `CapacitorStorage.`) and its
 * diagnostics file — as well as the shared rows it wrote.
 *
 * A stop the engine answers "not-loaded" (nothing playing) is not a failure;
 * only the purge's answer decides `ok`. `send` is the engine client's
 * `(cmd, args) => Promise<{ok, reason?}>`, which never rejects by contract
 * (§5.1) — and is wrapped anyway, because a delete control must finish.
 *
 * @param {(cmd: string, args: object) => Promise<{ok: boolean, reason?: string}>} send
 */
export function engineDataDeletion(send) {
  return async () => {
    let stopped = null;
    try { stopped = await send("stop", { persist: false }); } catch (_) { stopped = null; }
    const purged = await send("purge", {});
    const out = { ok: Boolean(purged && purged.ok === true), stopped: Boolean(stopped && stopped.ok === true) };
    if (purged && typeof purged.reason === "string") out.reason = purged.reason;
    return out;
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
   * @param {string[]} [opts.deferredPrefixes]  the native engine's rows, deferred
   *   from construction (NE-23; `deferredPrefixesFor`). Empty — the default —
   *   is the store as it was before the engine, and is what the web and
   *   Android get.
   */
  constructor({
    tiers = [], prefix = DEFAULT_PREFIX, onFault = null, now = null, deviceOnlyKeys = DEVICE_ONLY_KEYS,
    deferredPrefixes = [],
  } = {}) {
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
    /** Tiers whose `readAll` FAILED. Migration must not push the whole local
        namespace into a tier it could not read: "I saw nothing" and "I could not
        look" are different claims, and confusing them overwrites newer durable
        rows with a stale mirror. Review found this one. */
    this._unread = new Set();
    /** Tiers taken out of the write path by the circuit breaker. Kept here rather
        than spliced out of `_async` so `health()` still reports them. */
    this._disabled = new Set();

    this._sync = [];
    this._async = [];
    /** The device-only vault (persist-6), or null. Kept OUT of `_async`, so no
        ordinary row is ever written to it and no device-only row is ever
        written anywhere else — see `_confined`. */
    this._vault = null;
    for (const t of tiers) {
      if (!t || typeof t.write !== "function") continue;
      if (t.vault === true && !t.sync) { if (!this._vault) this._vault = t; continue; }
      (t.sync ? this._sync : this._async).push(t);
    }
    this._deviceOnly = new Set(Array.isArray(deviceOnlyKeys) ? deviceOnlyKeys.map(String) : []);
    /** True once hydration has READ the vault. Until then — and for good, when
        the read failed — a device-only key's absence means "could not look",
        never "there is none"; `canKeep` answers from this. */
    this._vaultRead = false;
    /** Device-only keys an earlier build left in a backed-up tier (or that a tier
        we could not read might still hold). Removed from those tiers once the
        vault has taken them, and not before. */
    this._legacy = new Set();
    /** Device-only keys an earlier build left in a SYNC tier (localStorage).
        The stale-mirror ledger describes exactly that copy, so an entry for one
        of these is obeyed at migration and leaves the ledger only once this
        copy is gone — see `_obeyConfinedLedger`. */
    this._legacySync = new Set();
    /** Device-only keys whose last vault write or removal FAILED. The vault is
        the key's only durable home, so such a key exists in memory alone: it
        is retried (`_retryUnsaved`) on `flush()` and whenever `canKeep` is
        asked, and `canKeep` says no until a retry lands — a refresh made now
        would spend the refresh token the vault still holds. */
    this._unsaved = new Set();
    /** Vault operations queued and not yet finished, per device-only key. */
    this._confinedInFlight = new Map();

    this._faults = [];
    this._stats = new Map();
    this._notified = 0;
    this._pending = 0;
    this._queue = Promise.resolve();
    this._persist = { state: PERSIST_UNKNOWN, already: false };
    this._hydrated = false;
    this._hydrating = null;
    this._inFault = false;
    this._inHealth = false;
    /** True for the duration of `purge()`. Suppresses the health MIRROR and the
        stale-mirror ledger, both of which would otherwise write a row into
        storage a listener has just asked to be emptied. */
    this._purging = false;
    /** Keys whose localStorage copy is older than the durable one, because the
        sync tier refused a write the durable tier accepted (property 4).
        Persisted as `LOCAL_STALE_KEY`. */
    this._stale = new Set();

    /* Single writer (NE-23; see the block above the class). `_owner` is null
       for a store nobody defers, which is every store off the iOS shell. */
    const deferred = this._ownPrefixes(deferredPrefixes);
    this._owner = deferred.length ? { prefixes: deferred, state: OWNERSHIP_DEFERRED } : null;
    /* Keys the page wrote or removed while its rows were deferred: memory only,
       committed through the ordinary path on release. */
    this._heldOps = new Set();
    /* Keys `adoptOwnedSet` set or dropped: the engine's word, committed on
       release the same way. */
    this._adopted = new Set();
    /* True once the engine's set has replaced the page's. From then on "absent"
       means "the engine deleted it", so hydration may not add a row back. */
    this._replaced = false;
    /* What hydration would have written for a deferred row and did not: a
       durable row to mirror up into localStorage, a ledger ghost to remove
       from it, and a row a durable tier lacks (`_migrateUp`). */
    this._heldMirror = new Set();
    this._heldGhost = new Set();
    this._heldMigration = new Set();
    /* Hydration's own `_migrateUp` has finished, so a release after this point
       must run the held part of it itself (`releaseOwnership`). */
    this._hydrationMigrated = false;
    /* Set only around `_purge`'s removal loop: "Delete my data" reaches a
       deferred or engine-owned row like any other (see `purge`). */
    this._purgeBypass = false;
    /** The engine's half of a purge (`engineDataDeletion`), or null. */
    this._ownerPurge = null;
    this._releasing = null;

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
    /* The engine's rows on the iOS shell (NE-23): held, or refused. Neither
       throws — nothing failed to store; the store declined to be the writer. */
    if (this._withheld(k)) { this._holdWrite(k, v); return; }
    this._mem.set(k, v);
    this._dirty.add(k);
    if (this._confined(k)) {
      /* Device-only (persist-6): the vault and nothing else. No localStorage
         write, so there is no mirror to go stale and no ledger entry. */
      if (!this._queueConfined(k, v)) {
        const last = this._faults[this._faults.length - 1];
        throw new Error(
          `no storage tier accepted ${k}: the device-only store is unavailable`
          + (last ? ` (${last.tier} ${last.error})` : "")
        );
      }
      return;
    }
    const accepted = this._writeSync(k, v);
    /* The ledger is queued BEFORE the value (property 4). If only the ledger
       lands, the next launch adopts the durable row, which is never older than
       the refused mirror; if only the value landed, the mirror would win again. */
    this._markLocal(k, accepted);
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
    if (this._withheld(k)) { this._holdWrite(k, null); return; }
    this._mem.delete(k);
    this._dirty.add(k);
    if (this._confined(k)) { this._queueConfined(k, null); return; }
    let removed = this._sync.length > 0;
    for (const t of this._sync) {
      try { t.remove(k); } catch (err) { removed = false; this._fault(t.name, "remove", err, k); }
    }
    // A removal the mirror refused leaves the mirror holding a row the durable
    // tier no longer has — the same staleness as a refused write.
    this._markLocal(k, removed);
    this._enqueue((t) => t.remove(k), k, "remove");
  }

  owns(key) { return typeof key === "string" && key.startsWith(this.prefix); }

  /**
   * Can a value written to `key` now be trusted to be there next launch — and
   * does "not there" mean there is none?
   *
   * True for every ordinary key, and for every key on a store with no vault (the
   * web). For a device-only key inside the shell it is true only once hydration
   * has read the vault and while the vault is still in the write path. The app
   * asks before it creates or refreshes an account (`app.js`
   * `ensureAnonSession`): a Supabase refresh SPENDS the old refresh token, and a
   * signup against a vault that could not be read would mint a second account
   * over the first. Neither is worth doing when the result cannot be kept.
   */
  canKeep(key) {
    const k = String(key);
    if (!this._confined(k)) return true;
    /* A value the vault refused is held in memory only. Retry it, and say no
       until the retry lands: the vault still holds the token a refresh would
       spend, so refreshing now could leave the next launch with a dead one. */
    if (this._unsaved.has(k)) { this._retryUnsaved(); return false; }
    return this._vaultRead && !this._disabled.has(this._vault.name);
  }

  /* ---------- single writer (NE-23) ---------- */

  /** `{state, prefixes}`, or null on a store that never deferred anything. */
  ownership() {
    return this._owner ? { state: this._owner.state, prefixes: [...this._owner.prefixes] } : null;
  }

  /**
   * hello said the native engine plays: it is the only writer of these rows
   * for the rest of the process.
   *
   * The owned set is the UNION of what was deferred and what hello names. The
   * contract pins both to OWNED_PREFIXES (the schema's enum), so they agree;
   * if a future engine named fewer, a key the page deferred would otherwise sit
   * in memory, never written by anyone, which is the silent kind of lost write.
   * Refused writes are faults, so the union's cost is visible.
   *
   * @param {string[]} prefixes  hello's `ownedKeyPrefixes`
   * @param {{purge?: Function}} [opts]  the engine's half of Delete my data
   *   (`engineDataDeletion(send)`), run first by `purge()`
   * @returns {boolean} false after a release: relinquish is one way per process
   */
  externallyOwned(prefixes, { purge = null } = {}) {
    if (this._owner && this._owner.state === OWNERSHIP_RELEASED) return false;
    const merged = this._ownPrefixes([...(this._owner ? this._owner.prefixes : []), ...(Array.isArray(prefixes) ? prefixes : [])]);
    if (!merged.length) return false;
    this._owner = { prefixes: merged, state: OWNERSHIP_EXTERNAL };
    if (typeof purge === "function") this._ownerPurge = purge;
    return true;
  }

  /**
   * Replace the page's copy of the engine's rows with the engine's own
   * (`engineRead("rows")` on attach, and once more before a relinquish).
   *
   * REPLACE, not merge: a row the page holds and the engine does not is a row
   * the engine deleted, and it is dropped from memory. No tier is written here —
   * the engine already wrote UserDefaults, and the page's mirrors are brought
   * into line on release (`releaseOwnership`), if the page ever becomes the
   * writer again.
   *
   * @param {Map<string,string>|Record<string,string>} rows
   * @returns {boolean} false when nothing is withheld (no deferral, or released)
   */
  adoptOwnedSet(rows) {
    if (!this._owner || this._owner.state === OWNERSHIP_RELEASED) return false;
    const incoming = new Map();
    const entries = rows instanceof Map ? rows : Object.entries(rows && typeof rows === "object" ? rows : {});
    for (const [k, v] of entries) {
      if (typeof k === "string" && typeof v === "string" && this.owns(k) && this._ownerKey(k)) incoming.set(k, v);
    }
    for (const k of [...this._mem.keys()]) {
      if (!this._ownerKey(k) || incoming.has(k)) continue;
      this._mem.delete(k);
      this._dirty.add(k);
      this._adopted.add(k);
    }
    for (const [k, v] of incoming) {
      this._mem.set(k, v);
      this._dirty.add(k);
      this._adopted.add(k);
    }
    this._replaced = true;
    return true;
  }

  /**
   * The page is the writer again: hello said legacy/js, or the engine
   * relinquished. From this call on every write is ordinary, and what the
   * deferral held back is committed ONCE (a second call returns the first
   * call's promise):
   *
   *   1. every row the page wrote while it was held, and every row the engine's
   *      set decided, goes through the ordinary write path;
   *   2. what hydration would have written — a durable row mirrored up, a
   *      ledger ghost removed — is written now;
   *   3. after a replace-set, a row any tier still holds that the engine's set
   *      does not is removed from it, so a later JS-mode launch cannot read an
   *      engine-deleted row back out of a stale mirror;
   *   4. the rows a durable tier was missing are migrated down, now if
   *      hydration has finished, or by hydration itself when it does.
   *
   * It does not wait for hydration: a WKWebView IndexedDB can leave a read
   * unsettled for good (idb-tier.js, hazard 1), and a page that relinquished
   * must be able to write positions whatever that read is doing.
   *
   * @returns {Promise<boolean>} true when this call released something
   */
  releaseOwnership() {
    if (this._releasing) return this._releasing;
    if (!this._owner) return Promise.resolve(false);
    this._owner = { prefixes: this._owner.prefixes, state: OWNERSHIP_RELEASED };
    this._releasing = this._commitHeld();
    return this._releasing;
  }

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
    /* A device-only value the vault refused has no other durable copy, so this
       is where it gets its next chance — `pagehide` and `visibilitychange` call
       this (player/client.js). */
    this._retryUnsaved();
    await this._queue;
    return this.health();
  }

  /**
   * Delete EVERY owned key from EVERY tier, then prove it by re-reading them.
   *
   * This is the storage half of the in-app "delete my data" control (#42). It
   * lives here rather than as a loop over `key(i)` in the caller because each of
   * the three things it does is a way that loop leaves data behind:
   *
   *   1. IT ENUMERATES THE TIERS, NOT MEMORY. `length`/`key(i)` walk `_mem`, and
   *      `_ownedKeys()` deliberately hides `cp_storage_health` — so a caller
   *      iterating the facade clears 19 of the 20 keys and reports success. A
   *      durable tier can also hold a row memory never saw: hydration may have
   *      failed, or another tab may have written since. Only the tiers can be
   *      asked, and only this method can ask them.
   *   2. IT RE-READS AFTERWARDS. "I called remove" is not "it is gone". Anything
   *      still there comes back in `remaining`, because a delete control that
   *      reports a success it did not achieve is worse than no control at all.
   *   3. A TIER IT CANNOT READ FORCES `ok: false`, in `unverified`. "I could not
   *      look" is not "it is empty" — the same distinction `_doHydrate` draws,
   *      for the same reason, and here it is the difference between a listener
   *      being told their data is gone and their data being gone.
   *
   * Removal goes through `removeItem`, so every key is `_dirty` and a hydration
   * that answers late cannot resurrect it.
   *
   * @returns {Promise<{ok: boolean, keys: string[], remaining: string[],
   *   unverified: {tier: string, reason: string}[], faults: number}>}
   */
  async purge() {
    /* THE ENGINE FIRST, in native mode (NE-23): stop without persisting, then
       its purge (`engineDataDeletion`), then everything below. The engine holds
       what no tier here can enumerate — its private keys and its diagnostics
       file — and a playing engine would write a position back after the page's
       purge. Its answer rides along in `engine`, and a failed one makes the
       whole purge not ok: "your data is gone" must include the engine's. */
    const engine = this._ownerPurge ? await this._runOwnerPurge() : null;
    const out = await this._purgeTiers();
    if (!engine) return out;
    return { ...out, ok: out.ok && engine.ok, engine };
  }

  async _runOwnerPurge() {
    try {
      const r = await this._ownerPurge();
      if (!r || typeof r !== "object") return { ok: false, reason: "no-answer" };
      return r.ok === true ? { ok: true } : { ok: false, reason: typeof r.reason === "string" ? r.reason : "refused" };
    } catch (err) {
      return { ok: false, reason: "engine-purge-failed", error: errText(err) };
    }
  }

  async _purgeTiers() {
    const faultsBefore = this._faults.length;
    const unverified = [];
    /* THE DIAGNOSTIC MIRROR IS OFF FOR THE DURATION, and this is a correctness
       rule rather than tidiness. `_recordHealth` writes `cp_storage_health` on
       every fault, so a permanently failing tier turns the removal of that key
       into the creation of it — the purge could never win, every failed run would
       report a key it had written itself, and a listener who asked for deletion
       would be left with a NEW row. The faults still land in `_faults`, still trip
       the breaker, and still come back to the caller in `faults`/`remaining`,
       which is where a delete control needs them. */
    this._purging = true;
    try {
      return await this._purge(unverified, faultsBefore);
    } finally {
      this._purging = false;
    }
  }

  async _purge(unverified, faultsBefore) {
    /* Re-arm every tier the circuit breaker dropped. The breaker exists to stop
       a fault loop feeding itself (see `_fault`), not to refuse a listener's
       explicit instruction — and a tier nobody asks is a tier whose rows survive
       a deletion. If it is really dead the verification pass below says so. */
    this._disabled.clear();
    /* Nothing is stale in storage that is about to be empty, and the ledger row
       itself is one of the keys `_readTiers` finds and removes below. */
    this._stale.clear();
    const targets = new Set([...this._mem.keys()].filter((k) => this.owns(k)));
    const vaultHeld = new Set();
    for (const k of await this._readTiers(unverified, "before", vaultHeld)) targets.add(k);

    const keys = [...targets].sort();
    /* A listener's instruction outranks the single-writer rule (NE-23): a
       deferred or engine-owned row is removed from every tier like any other,
       or its stale mirrors would outlive "Delete my data". Synchronous, so the
       bypass covers these removals and no page write can slip under it. */
    this._purgeBypass = true;
    try {
      for (const k of keys) this.removeItem(k);
    } finally {
      this._purgeBypass = false;
    }
    /* A device-only key's removal already reached the vault. Anything else the
       vault admits to holding (nothing this app writes, but a purge answers for
       what is there, not for what should be) is removed from it here. */
    for (const k of vaultHeld) {
      if (!this._confined(k)) this._queueOn(this._vault, (t) => t.remove(k), k, "remove");
    }
    this._legacy.clear();
    this._legacySync.clear();
    await this._queue;

    /* Belt to the `_purging` braces: a health record written by an EARLIER
       session (or before this call) is user-visible storage like any other row and
       must go, and `keys` only covers what the tiers admitted to holding. */
    if (this._mem.has(HEALTH_KEY)) {
      this.removeItem(HEALTH_KEY);
      await this._queue;
    }

    const remaining = new Set(await this._readTiers(unverified, "after"));
    /* Memory is authoritative for reads, so a row still in it is still readable
       by the app even when both tiers came back clean. The reachable case is a
       write that lands WHILE this is verifying — see the test of that name; the
       app stops the player before deleting precisely so it is not the common one. */
    for (const k of this._mem.keys()) if (this.owns(k)) remaining.add(k);

    /* One entry per tier per phase: a tier that is unreadable is unreadable in
       both passes, and reporting it twice makes a single fault look like two. */
    const seen = new Set();
    const distinct = unverified.filter((u) => {
      const id = `${u.tier}|${u.phase}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    return {
      ok: remaining.size === 0 && distinct.length === 0,
      keys,
      remaining: [...remaining].sort(),
      unverified: distinct,
      faults: this._faults.length - faultsBefore,
    };
  }

  /**
   * Every owned key any tier currently admits to holding. A tier that refuses to
   * answer is pushed to `unverified` rather than counted as empty.
   *
   * `phase` is `"before"` (finding what to delete — a failure here means keys may
   * have been missed) or `"after"` (checking the deletion — a failure here means
   * it cannot be confirmed). Both force `ok: false`, for different reasons, and a
   * human reading the record should be able to tell which happened.
   */
  async _readTiers(unverified, phase, vaultHeld = null) {
    const found = new Set();
    const take = (rows) => {
      for (const k of rows.keys()) if (this.owns(k)) found.add(k);
    };
    const cannot = (name, reason) => unverified.push({ tier: name, phase, reason });
    for (const t of this._sync) {
      if (typeof t.snapshot !== "function") { cannot(t.name, "tier cannot be enumerated"); continue; }
      try { take(t.snapshot(this.prefix)); }
      catch (err) { this._fault(t.name, "read", err); cannot(t.name, errText(err)); }
    }
    for (const t of this._async) {
      /* A tier the circuit breaker dropped is NOT skipped here. It may well hold
         rows, and being unable to clear them is exactly what the caller has to
         be told rather than have hidden behind a healthy-looking summary. */
      if (typeof t.readAll !== "function") { cannot(t.name, "tier cannot be enumerated"); continue; }
      try { take(await t.readAll(this.prefix)); }
      catch (err) { this._fault(t.name, "read", err); cannot(t.name, errText(err)); }
    }
    /* The vault is asked like every other tier: "Delete my data" has to reach
       the token, and has to say so when it cannot confirm it did (persist-6). */
    const v = this._vault;
    if (v) {
      try {
        const rows = await v.readAll(this.prefix);
        take(rows);
        if (vaultHeld) for (const k of rows.keys()) if (this.owns(k)) vaultHeld.add(k);
      } catch (err) { this._fault(v.name, "read", err); cannot(v.name, vaultErrText(err)); }
    }
    return found;
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
    for (const t of [...this._sync, ...this._async, ...(this._vault ? [this._vault] : [])]) {
      const s = this._stat(t.name);
      tiers[t.name] = {
        durable: Boolean(t.durable),
        sync: Boolean(t.sync),
        /* The vault holds DEVICE_ONLY_KEYS and nothing else (persist-6). */
        deviceOnly: t === this._vault,
        writes: s.writes,
        failures: s.failures,
        migrated: s.migrated,
        lastError: s.lastError,
        /* Taken out of the write path after MAX_CONSECUTIVE_TIER_FAILURES. A
           `durable: true, disabled: true` tier is the case a human most needs to
           see: it exists, and it is not protecting anything. */
        disabled: this._disabled.has(t.name),
      };
    }
    return {
      ok: this._faults.length === 0,
      hydrated: this._hydrated,
      /* Tiers that are BOTH durable and still in the write path. A tier the
         circuit breaker dropped is no longer durability, whatever it claims —
         `HUMAN-ACTIONS.md` #9's check reads this. */
      durableTiers: this._async.filter((t) => t.durable && !this._disabled.has(t.name)).map((t) => t.name),
      /* Null on the web. Inside the shell: the vault's name, whether hydration
         could read it, and the keys it is the only home for. */
      vault: this._vault
        ? { tier: this._vault.name, read: this._vaultRead, keys: [...this._deviceOnly].sort() }
        : null,
      persisted: this._persist.state,
      persistedAlready: Boolean(this._persist.already),
      keys: this._ownedKeys().length,
      pending: this._pending,
      tiers,
      faults: this._faults.slice(-MAX_FAULTS),
    };
  }

  /* ---------- internals ---------- */

  /** The owned namespace, WITHOUT the diagnostic key: `cp_storage_health` is not
      user state, and counting it would make `length` and `key(i)` claim a row
      nothing wrote. It is still readable through `getItem`. */
  _ownedKeys() {
    return [...this._mem.keys()].filter((k) => k !== HEALTH_KEY);
  }

  _stat(name) {
    let s = this._stats.get(name);
    if (!s) {
      s = { writes: 0, failures: 0, migrated: 0, consecutive: 0, lastError: null };
      this._stats.set(name, s);
    }
    return s;
  }

  _ok(name) {
    const s = this._stat(name);
    s.writes += 1;
    s.consecutive = 0;
  }

  /** Async tiers still worth writing to. */
  _liveAsync() {
    return this._async.filter((t) => !this._disabled.has(t.name));
  }

  /** Is `key` a device-only key on a store that HAS a vault? On the web (no
      vault) nothing is confined and every key behaves as it always has. */
  _confined(key) {
    return this._vault !== null && this._deviceOnly.has(key);
  }

  _liveVault() {
    return this._vault && !this._disabled.has(this._vault.name) ? this._vault : null;
  }

  /* ---------- single writer: internals (NE-23) ---------- */

  /** Distinct, non-empty prefixes inside this store's namespace. A prefix
      outside `cp_` names rows this store does not hold, so it defers nothing. */
  _ownPrefixes(list) {
    const out = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (typeof p === "string" && p && this.owns(p) && !out.includes(p)) out.push(p);
    }
    return out;
  }

  /** Is `key` one of the engine's rows (whatever the state)? */
  _ownerKey(key) {
    return this._owner !== null && this._owner.prefixes.some((p) => key.startsWith(p));
  }

  /** Is `key` an engine row the page may not write through right now? */
  _withheld(key) {
    return this._owner !== null && this._owner.state !== OWNERSHIP_RELEASED
      && !this._purgeBypass && this._ownerKey(key);
  }

  /** A page write (`value` a string) or removal (null) of a withheld row. */
  _holdWrite(key, value) {
    if (this._owner.state === OWNERSHIP_EXTERNAL) {
      /* REFUSED, and said so: memory and every tier stay as the engine left
         them. The string, not an Error, so the fault's `error` is the bare
         vocabulary token rather than "Error: externally-owned". */
      this._fault(OWNER_TIER, value === null ? "remove" : "write", EXTERNALLY_OWNED, key);
      return;
    }
    /* Deferred: nothing is decided, so nothing is committed. Memory keeps the
       session coherent; release commits it, and a native hello replaces it. */
    if (value === null) this._mem.delete(key); else this._mem.set(key, value);
    this._dirty.add(key);
    this._heldOps.add(key);
  }

  /** `releaseOwnership`'s body; see there for the four steps. */
  async _commitHeld() {
    const decided = [...new Set([...this._heldOps, ...this._adopted])].sort();
    this._heldOps.clear();
    this._adopted.clear();
    // 1. Through the ordinary path, now that the page is the writer.
    for (const k of decided) {
      try {
        if (this._mem.has(k)) this.setItem(k, this._mem.get(k)); else this.removeItem(k);
      } catch (_) { /* no tier took it: `setItem` already faulted, and memory still has it */ }
    }
    // 2. What hydration held back.
    for (const k of this._heldMirror) {
      if (!this._dirty.has(k) && this._mem.has(k)) this._adopt(k, this._mem.get(k));
    }
    this._heldMirror.clear();
    let ledgerChanged = false;
    for (const k of this._heldGhost) {
      if (this._dirty.has(k) || this._mem.has(k)) continue;
      let removed = this._sync.length > 0;
      for (const t of this._sync) {
        try { t.remove(k); } catch (err) { removed = false; this._fault(t.name, "remove", err, k); }
      }
      if (removed && this._stale.delete(k)) ledgerChanged = true;
    }
    this._heldGhost.clear();
    if (ledgerChanged) this._persistStale();
    // 3. Replace-set reaches the tiers.
    if (this._replaced) this._sweepOwnerRows();
    // 4. The migration down, if hydration already ran its own.
    if (this._hydrationMigrated) await this._runHeldMigration();
    await this._queue;
    return true;
  }

  /**
   * After a replace-set, remove every engine row a tier holds that memory does
   * not: localStorage now, the durable tiers on the queue (they must be read
   * first, and a tier that cannot be read keeps what it has — "could not look"
   * is not "has none", and removing blind is not needed to be correct).
   * Re-checked against memory when each removal's turn comes, so a row the
   * page writes after the release is never swept.
   */
  _sweepOwnerRows() {
    for (const t of this._sync) {
      let snap = null;
      try { snap = typeof t.snapshot === "function" ? t.snapshot(this.prefix) : null; }
      catch (err) { this._fault(t.name, "read", err); continue; }
      if (!snap) continue;
      for (const k of snap.keys()) {
        if (!this._ownerKey(k) || this._mem.has(k)) continue;
        try { t.remove(k); } catch (err) { this._fault(t.name, "remove", err, k); }
      }
    }
    const tiers = this._liveAsync();
    if (!tiers.length) return;
    this._pending += 1;
    const done = () => { this._pending -= 1; };
    this._queue = this._queue.then(async () => {
      for (const t of tiers) {
        let rows = null;
        try { rows = typeof t.readAll === "function" ? await t.readAll(this.prefix) : null; }
        catch (err) { this._fault(t.name, "read", err); continue; }
        if (!rows) continue;
        for (const k of rows.keys()) {
          if (typeof k !== "string" || !this._ownerKey(k) || this._mem.has(k)) continue;
          try { await t.remove(k); this._ok(t.name); }
          catch (err) { this._fault(t.name, "remove", err, k); }
        }
      }
    }).then(done, done);
  }

  /** The part of `_migrateUp` deferral skipped, for rows nobody has written
      since (a written row already went down on the ordinary path). Clears as
      it starts, so it runs once whichever of release and hydration gets here
      second. */
  async _runHeldMigration() {
    const only = new Set([...this._heldMigration].filter((k) => !this._dirty.has(k)));
    this._heldMigration.clear();
    if (only.size) await this._migrateUp(only);
  }

  /** One queued operation on one tier, on the same serial queue as every other
      durable write, so it is ordered against them. */
  _queueOn(tier, op, key, kind) {
    if (!tier) return false;
    this._pending += 1;
    const done = () => { this._pending -= 1; };
    this._queue = this._queue.then(async () => {
      try { await op(tier); this._ok(tier.name); }
      catch (err) { this._fault(tier.name, kind, err, key); }
    }).then(done, done);
    return true;
  }

  /**
   * Write (`value` a string) or remove (`value` null) a device-only key.
   *
   * A WRITE goes to the vault, and only once the vault has taken it is the key
   * removed from every backed-up tier that might still hold an earlier build's
   * copy: a vault that refuses leaves those copies in place, so a failed write
   * never costs the listener their account.
   *
   * A REMOVAL goes everywhere at once — the vault and every other tier — because
   * a key asked to be gone is asked to be gone from all of them.
   *
   * @returns {boolean} whether a live vault took responsibility for a write
   */
  _queueConfined(key, value) {
    const vault = this._liveVault();
    if (value === null) {
      const syncClean = this._evictSync(key);
      if (!vault) this._unsaved.add(key);
      const done = this._confinedQueued(key);
      this._queue = this._queue.then(async () => {
        if (vault) {
          try { await vault.remove(key); this._ok(vault.name); this._unsaved.delete(key); }
          catch (err) { this._fault(vault.name, "remove", err, key); this._unsaved.add(key); }
        }
        await this._evictAsync(key);
        if (syncClean) await this._localCopyGone(key);
      }).then(done, done);
      return Boolean(vault);
    }
    if (!vault) { this._unsaved.add(key); return false; }
    const done = this._confinedQueued(key);
    this._queue = this._queue.then(async () => {
      try { await vault.write(key, value); this._ok(vault.name); }
      catch (err) {
        /* NOT the end of it. This key has no other durable copy now, so a
           refusal left alone would lose a refreshed token at the next app kill
           (review, 2026-09-24). `_unsaved` gets it retried and makes `canKeep`
           say no until it lands. */
        this._fault(vault.name, "write", err, key);
        this._unsaved.add(key);
        return;
      }
      /* Only the value memory still holds counts as saved: a later write of
         this key that failed is not undone by an earlier one landing. */
      if (this._mem.get(key) === value) this._unsaved.delete(key);
      if (this._evictSync(key)) await this._localCopyGone(key);
      await this._evictAsync(key);
    }).then(done, done);
    return true;
  }

  /**
   * Give every device-only key the vault refused another try, with the value
   * memory holds NOW (a removal when memory has none). Queued like any other
   * vault operation, so it is ordered against this session's writes; a retry
   * that fails puts the key straight back in `_unsaved`.
   */
  _retryUnsaved() {
    if (!this._unsaved.size || !this._liveVault()) return;
    for (const k of [...this._unsaved]) {
      /* A write or removal of this key already queued IS the retry, and it
         carries the newer value; a second one would only double the faults. */
      if (this._confinedInFlight.get(k)) continue;
      this._unsaved.delete(k);
      this._queueConfined(k, this._mem.has(k) ? this._mem.get(k) : null);
    }
  }

  /** Count a queued vault operation on `key`; returns its completion callback. */
  _confinedQueued(key) {
    this._pending += 1;
    this._confinedInFlight.set(key, (this._confinedInFlight.get(key) || 0) + 1);
    return () => {
      this._pending -= 1;
      const n = (this._confinedInFlight.get(key) || 1) - 1;
      if (n > 0) this._confinedInFlight.set(key, n); else this._confinedInFlight.delete(key);
    };
  }

  /**
   * An earlier build's localStorage copy of a device-only key is gone, so the
   * stale-mirror ledger has nothing left to describe for it: drop the entry.
   * Called from inside the queue, so it writes the ledger directly.
   */
  async _localCopyGone(key) {
    this._legacySync.delete(key);
    if (!this._stale.delete(key) || this._purging) return;
    const op = this._staleOp();
    for (const t of this._liveAsync()) {
      try { await op(t); this._ok(t.name); }
      catch (err) { this._fault(t.name, "write", err, LOCAL_STALE_KEY); }
    }
  }

  /** Remove a device-only key from the backed-up SYNC tiers. */
  _evictSync(key) {
    let clean = true;
    for (const t of this._sync) {
      try { t.remove(key); } catch (err) { clean = false; this._fault(t.name, "remove", err, key); }
    }
    return clean;
  }

  /** Remove a device-only key from the backed-up ASYNC tiers. Called from inside
      the queue, so it awaits the tiers directly rather than re-queueing. */
  async _evictAsync(key) {
    let clean = true;
    for (const t of this._liveAsync()) {
      try { await t.remove(key); this._ok(t.name); }
      catch (err) { clean = false; this._fault(t.name, "remove", err, key); }
    }
    return clean;
  }

  _loadSync() {
    for (const t of this._sync) {
      let snap = null;
      try { snap = typeof t.snapshot === "function" ? t.snapshot(this.prefix) : null; }
      catch (err) { this._fault(t.name, "read", err); continue; }
      if (!snap) continue;
      // First tier wins: the list is in preference order.
      for (const [k, v] of snap) {
        /* A device-only key in localStorage is an earlier build's copy. It is
           read (so the first paint still knows the account) and remembered, so
           hydration can move it into the vault and then take it out of here. */
        if (this._confined(k)) { this._legacy.add(k); this._legacySync.add(k); }
        if (!this._mem.has(k)) this._mem.set(k, v);
      }
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
    // Not `_async.length`: a tier the circuit breaker dropped cannot take
    // responsibility for anything, so a store whose only durable tier is dead
    // must go back to throwing when localStorage refuses too.
    if (!this._liveAsync().length) return false;
    this._pending += 1;
    const done = () => { this._pending -= 1; };
    this._queue = this._queue.then(async () => {
      for (const t of this._liveAsync()) {
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
    /* THE VAULT FIRST, and it has the only word on a device-only key: it is the
       one place a vault-aware build ever writes one. */
    let vaultRows = null;
    if (this._vault) {
      try {
        vaultRows = await this._vault.readAll(this.prefix);
        this._vaultRead = true;
      } catch (err) {
        // Could not look. The backed-up copies (if any) stay exactly where they
        // are, and `canKeep` says no until a later launch can read it.
        this._fault(this._vault.name, "read", err);
      }
      if (vaultRows) {
        for (const [k, v] of vaultRows) {
          if (typeof v !== "string" || !this._confined(k) || this._dirty.has(k)) continue;
          this._mem.set(k, v);
        }
      }
    }
    /* Device-only keys whose value an earlier build's ledger already settled
       from a durable tier this hydration — see `_obeyConfinedLedger`. */
    const ledgerWon = new Set();
    for (const t of this._async) {
      const seen = new Set();
      this._seen.set(t.name, seen);
      let rows = null;
      try {
        rows = typeof t.readAll === "function" ? await t.readAll(this.prefix) : null;
      } catch (err) {
        /* COULD NOT LOOK ≠ SAW NOTHING. Without this the empty `seen` reads as
           "the tier has none of these rows" and migration pushes the entire local
           namespace down over whatever is really there — turning a transient
           read failure into permanent loss of any durable row that was NEWER
           than the local mirror. Review found this, and the precondition is
           ordinary: localStorage refused a write, the durable tier took it, and
           the next launch cannot read the durable tier. */
        this._fault(t.name, "read", err);
        this._unread.add(t.name);
        // It may be holding an earlier build's copy of a device-only key.
        for (const k of this._deviceOnly) if (this._confined(k)) this._legacy.add(k);
        continue;
      }
      if (!rows) continue;
      /* Property 4: the keys an earlier session's localStorage refused. Read
         before the rows, because it decides who wins them. Scoped to THIS tier:
         the ledger and the values it describes ride the same queue into the
         same tier, so "the ledger names a key this tier does not hold" can only
         mean the durable tier removed it and the mirror refused to. */
      const staleHere = parseStale(rows.get(LOCAL_STALE_KEY));
      /* A device-only key has no localStorage mirror in a vault-aware build, but
         an EARLIER build's ledger entry for one still says which copy is older,
         and it is exactly the migration that has to believe it: otherwise the
         refused mirror's spent token is moved into the vault over the newer
         durable one (review, 2026-09-24). Obeyed here, before the rows. */
      let ledgerChanged = false;
      for (const k of [...staleHere]) {
        if (!this._confined(k)) continue;
        staleHere.delete(k);
        if (this._obeyConfinedLedger(k, rows, vaultRows, ledgerWon)) ledgerChanged = true;
      }
      for (const k of staleHere) this._stale.add(k);
      for (const [k, v] of rows) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        if (!this.owns(k)) continue;
        if (this._confined(k)) {
          /* An earlier build's copy in a backed-up tier. It is the account only
             when the vault has none and this session has not written one; either
             way it is moved out below, once the vault holds the key. */
          this._legacy.add(k);
          const inVault = vaultRows !== null && vaultRows.has(k);
          if (!inVault && !this._dirty.has(k) && !this._mem.has(k)) this._mem.set(k, v);
          continue;
        }
        seen.add(k);
        if (k === HEALTH_KEY) continue;          // diagnostics, never authoritative
        if (k === LOCAL_STALE_KEY) continue;     // bookkeeping, read above
        if (this._dirty.has(k)) continue;        // property 2: this session wins
        /* After a replace-set the engine's set is the truth, including about
           what it deleted — and it stays the truth for a read that lands after
           a release, too: a durable row read late is not adopted (NE-23). */
        if (this._replaced && this._ownerKey(k)) continue;
        if (this._withheld(k)) { this._hydrateHeld(k, v, staleHere, seen); continue; }
        const mine = this._mem.has(k) ? this._mem.get(k) : null;
        if (mine === null) { this._adopt(k, v); continue; }   // localStorage lost it
        if (mine === v) { this._stale.delete(k); continue; }  // the mirror caught up
        /* The mirror refused this key's last write, so `mine` is known to be the
           OLDER copy — whatever `isNewer` could or could not tell from it. */
        if (staleHere.has(k) || isNewer(v, mine)) { this._adopt(k, v); continue; }
        /* Local won the conflict, so the durable tier is holding a STALE row.
           Dropping it from `seen` is what makes `_migrateUp` push the winner
           down — without this line the tier keeps the old value forever and the
           next eviction restores a listener to a position they had already moved
           past. Caught by "a local row that is newer is kept, not overwritten". */
        seen.delete(k);
      }
      /* A key on the ledger that this tier no longer holds was REMOVED durably
         while the mirror refused the removal: the mirror's row is the ghost. */
      for (const k of staleHere) {
        if (rows.has(k) || this._dirty.has(k)) continue;
        if (this._withheld(k)) {
          /* Read as a ghost, removed from localStorage only once the page is
             the writer. After a replace-set the engine's set already decided. */
          if (!this._replaced) { this._mem.delete(k); this._heldGhost.add(k); }
          continue;
        }
        this._mem.delete(k);
        let removed = this._sync.length > 0;
        for (const t of this._sync) {
          try { t.remove(k); } catch (err) { removed = false; this._fault(t.name, "remove", err, k); }
        }
        if (removed) this._stale.delete(k);
      }
      if (staleHere.size || ledgerChanged) this._persistStale();
    }
    this._moveLegacyIntoVault(vaultRows);
    await this._migrateUp();
    /* Synchronous from here to the check: a release before this line leaves
       the held migration to us, one after it runs it itself (NE-23). */
    this._hydrationMigrated = true;
    if (this._owner && this._owner.state === OWNERSHIP_RELEASED) await this._runHeldMigration();
    this._hydrated = true;
    return this;
  }

  /**
   * Hydration's merge for an engine row the page is holding (NE-23): the same
   * choice of value the ordinary path makes — so the first paint and a later
   * release see what they always would have — with every write held back.
   */
  _hydrateHeld(k, v, staleHere, seen) {
    const mine = this._mem.has(k) ? this._mem.get(k) : null;
    if (mine === v) { this._stale.delete(k); return; }
    if (mine === null || staleHere.has(k) || isNewer(v, mine)) {
      this._mem.set(k, v);
      this._heldMirror.add(k);
      return;
    }
    /* Local won, so on release this tier needs the local row — exactly the
       ordinary path's `seen.delete`, without the push that follows it now. */
    seen.delete(k);
  }

  /**
   * An earlier build's stale-mirror ledger names a device-only key (property 4,
   * written before the vault existed). It says localStorage's copy is OLDER
   * than the one in `rows`, the durable tier the ledger rode in with:
   *
   *   - `rows` holds the key: the durable value is the account. It replaces the
   *     localStorage copy in memory, so it is the one moved into the vault. A
   *     localStorage copy that won here would carry a refresh token Supabase
   *     has already spent into the vault, and evict the good one.
   *   - `rows` does not: the durable tier REMOVED it (Delete my data) while
   *     localStorage refused to. The localStorage copy is the ghost of a deleted
   *     account, so it is dropped from memory and from localStorage and never
   *     reaches the vault.
   *
   * The vault's own copy, or one this session wrote, outranks both. The entry
   * stays on the ledger until the localStorage copy is gone, so a vault that
   * refuses the move leaves the next launch the same answer.
   *
   * @returns {boolean} whether the entry was settled, and so left `_stale`, now
   */
  _obeyConfinedLedger(k, rows, vaultRows, ledgerWon) {
    /* No localStorage copy: nothing for the ledger to overrule. */
    if (!this._legacySync.has(k)) return true;
    this._stale.add(k);
    if (this._dirty.has(k) || (vaultRows !== null && vaultRows.has(k))) return false;
    if (rows.has(k)) {
      const v = rows.get(k);
      if (!ledgerWon.has(k) && typeof v === "string") { this._mem.set(k, v); ledgerWon.add(k); }
      return false;
    }
    if (ledgerWon.has(k)) return false;
    this._mem.delete(k);
    if (!this._evictSync(k)) return false;
    this._legacySync.delete(k);
    this._stale.delete(k);
    return true;
  }

  /**
   * Move an earlier build's copy of each device-only key into the vault, then
   * out of every backed-up tier (persist-6). Queued, so it is ordered against
   * this session's own writes; and each key is re-checked when its turn comes,
   * because a write or removal made meanwhile has already done this itself.
   *
   * Nothing moves when the vault could not be read: "could not look" is not
   * "has none", and writing over a vault we could not read could replace the
   * real account with a stale copy.
   */
  _moveLegacyIntoVault(vaultRows) {
    if (!this._vault || vaultRows === null) return;
    for (const k of [...this._legacy]) {
      this._pending += 1;
      const done = () => { this._pending -= 1; };
      this._queue = this._queue.then(async () => {
        if (this._dirty.has(k)) { this._legacy.delete(k); return; }
        const vault = this._liveVault();
        if (!vault) return;
        const v = this._mem.get(k);
        /* Nothing to move: every copy we could read is gone. A tier we could
           NOT read may still hold the account, so it is not touched. */
        if (typeof v !== "string") return;
        if (vaultRows.get(k) !== v) {
          try { await vault.write(k, v); this._ok(vault.name); this._stat(vault.name).migrated += 1; }
          catch (err) { this._fault(vault.name, "migrate", err, k); return; }
        }
        const syncClean = this._evictSync(k);
        if (syncClean) await this._localCopyGone(k);
        const asyncClean = await this._evictAsync(k);
        const allRead = this._async.every((t) => !this._unread.has(t.name) && !this._disabled.has(t.name));
        if (syncClean && asyncClean && allRead) this._legacy.delete(k);
      }).then(done, done);
    }
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
    // A mirror that takes the durable value is no longer stale; one that still
    // refuses stays on the ledger for the next launch to try again.
    if (this._writeSync(key, value)) this._stale.delete(key);
  }

  /**
   * Keep the stale-mirror ledger true after a sync-tier write or removal
   * (property 4). `ok` is whether the sync tier took it.
   *
   * No sync tier means no mirror to be stale, and no live durable tier means no
   * better copy to prefer, so neither records anything.
   */
  _markLocal(key, ok) {
    if (!this._sync.length) return;
    if (ok) {
      if (this._stale.delete(key)) this._persistStale();
      return;
    }
    if (!this._liveAsync().length || this._stale.has(key)) return;
    this._stale.add(key);
    this._persistStale();
  }

  /** Queue the ledger to the durable tiers: the whole set, or a removal once it
      is empty. Never during a purge — see `_purging`. */
  _persistStale() {
    if (this._purging) return;
    this._enqueue(this._staleOp(), LOCAL_STALE_KEY, this._stale.size ? "write" : "remove");
  }

  /** The tier operation that makes a durable tier's ledger row match `_stale`. */
  _staleOp() {
    if (!this._stale.size) return (t) => t.remove(LOCAL_STALE_KEY);
    const blob = JSON.stringify([...this._stale].sort());
    return (t) => t.write(LOCAL_STALE_KEY, blob);
  }

  /**
   * Property 1, the migration itself: every row the durable tiers do not have
   * is copied down. Nothing is deleted from localStorage, then or ever.
   *
   * `migrated` is counted per tier so the migration is visible in `health()`
   * rather than being something you have to take on trust.
   */
  async _migrateUp(only = null) {
    if (!this._liveAsync().length) return;
    /* Drain first. `removeItem` rides `_queue` and these writes do not, so the
       two chains are otherwise unordered — and an unordered remove is a row that
       comes back. Draining plus the per-key liveness check below makes the
       ordering total in the only direction that can lose data. */
    await this._queue;
    const keys = this._ownedKeys();
    for (const t of this._liveAsync()) {
      const seen = this._seen.get(t.name) ?? new Set();
      const unread = this._unread.has(t.name);
      for (const k of keys) {
        if (only && !only.has(k)) continue;
        /* Re-checked here, not read from a snapshot: a key removed since this
           hydration started must not be written back down. `app.js` races
           hydration against a timeout and proceeds while it is still running, so
           a "start over" DURING hydration is a real sequence, and review proved
           it resurrected the row. */
        if (!this._mem.has(k)) continue;
        /* A device-only key never goes into a backed-up tier (persist-6);
           `_moveLegacyIntoVault` is its migration. */
        if (this._confined(k)) continue;
        /* THE CLOBBER NE-23 CLOSES. An engine row the page is holding is never
           pushed down: the durable copy may be the engine's own, newer than a
           mirror nobody refreshed (and undated, so `isNewer` cannot tell), or
           the engine may have deleted it. Remembered, and migrated on release
           if the page turns out to be the writer after all. */
        if (this._withheld(k)) { this._heldMigration.add(k); continue; }
        /* A tier we could not read gets only the keys this session wrote, which
           are the only ones we know to be newer than whatever is down there. */
        if (unread && !this._dirty.has(k)) continue;
        if (seen.has(k) && !this._dirty.has(k)) continue;
        try {
          await t.write(k, this._mem.get(k));
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
    s.consecutive += 1;
    /* The vault's error text is cut down before it is kept anywhere: this
       record is mirrored into `cp_storage_health`, a BACKED-UP tier, and handed
       to the app's fault sink, which logs it. A native error that quoted the
       vault's contents would put the token exactly where the vault keeps it
       out of (review, 2026-09-24: Android's org.json parse errors quote their
       whole input). */
    s.lastError = this._vault && tier === this._vault.name ? vaultErrText(err) : errText(err);
    const fault = { tier, op, key: key ?? null, error: s.lastError, at: this._now() };
    this._faults.push(fault);
    while (this._faults.length > MAX_FAULTS) this._faults.shift();

    /* THE CIRCUIT BREAKER. A durable tier that has failed this many times in a
       row is not coming back this session, and every further attempt is one more
       fault, one more notification, and one more write from the app's fault sink.
       Stop asking it. Reads are unaffected — hydration has already happened. */
    if (!this._disabled.has(tier) && s.consecutive >= MAX_CONSECUTIVE_TIER_FAILURES
        && (this._async.some((t) => t.name === tier) || (this._vault && this._vault.name === tier))) {
      this._disabled.add(tier);
    }

    this._recordHealth();

    /* THE NOTIFICATION BUDGET, and the reason it is not just `_inFault`.
       `_inFault` is set and cleared synchronously, so it guards a re-entrant
       sink and nothing else. An ASYNC tier failure arrives on a later tick with
       the guard already clear — and the app's sink writes an event, which is a
       write, which queues another durable write, which fails, which faults. That
       is unbounded, and review measured it at 400 events from one user write.
       Two independent brakes now: this budget, and the breaker above. */
    if (this._onFault && !this._inFault && this._notified < MAX_FAULTS) {
      this._notified += 1;
      this._inFault = true;
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
    // Not during a purge: see the note at the top of `purge()`. The record still
    // exists in memory-as-`health()`; what stops is MIRRORING it into storage a
    // listener has just asked to be emptied.
    if (this._inHealth || this._purging) return;
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

/** The ledger row, as a Set. A missing or corrupt row is an empty ledger: the
    worst that costs is the pre-fix "local wins", never a thrown hydration. */
function parseStale(raw) {
  if (typeof raw !== "string") return new Set();
  try {
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string") : []);
  } catch (_) {
    return new Set();
  }
}

/** A vault error, with anything that could be the vault's CONTENT cut off: the
    text stops at the first `{`, `"` or `'`, and at 160 characters. What is left
    (the call, the exception class, an OSStatus) is what a human needs. */
export function vaultErrText(err) {
  const full = errText(err);
  const cut = full.split(/[{"']/)[0].slice(0, 160).trim();
  return cut === full ? full : `${cut} [vault detail withheld]`;
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
  nativeTier = null,
  vault = null,
  prefix = DEFAULT_PREFIX,
  onFault = null,
  now = null,
  deferredPrefixes = [],
} = {}) {
  return new DurableStore({
    /* The native tier goes BEFORE IndexedDB. Hydration reads the async tiers in
       order and the first one to hold a row localStorage lost is the one
       adopted, so the tier a WebView sweep cannot reach gets the first word.
       The vault (persist-6) is not in that order at all: it holds the
       device-only keys and nothing else, and hydration reads it first. */
    tiers: [localStorageTier(ls), vault, nativeTier, idbTier],
    prefix,
    onFault,
    now,
    /* The native engine's rows, on the iOS shell only (NE-23): see
       `deferredPrefixesFor`, and property 5 in the header. */
    deferredPrefixes,
  });
}
