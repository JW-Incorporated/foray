# Durable user state (issue #40, MP6)

Everything Foray knows about a listener lives in `localStorage` under the legacy
`cp_` prefix. Browsers evict `localStorage`. This document is the record of what
was done about that, what it does not fix, and what is still a founder decision.

Code: `player/durable-store.js` (the store), `player/idb-tier.js` (the IndexedDB
adapter), `app.js` § storage (the shim callers use), `player/client.js` (the one
place the store is constructed).

## The defect, precisely

- **Safari** clears all script-writable storage for an origin after ~7 days
  without a *user interaction* with the site. `localStorage`, IndexedDB, Cache
  API — all of it.
- **Every engine** can evict under storage pressure. Chromium evicts a whole
  origin bucket at once.
- **iOS `WKWebView`** storage is not durable by default, which is the "app
  tomorrow" half of #40.

The listener this costs is the one the product most wants: part-way through a
61-minute Foray, back the following week. Resume shipped the day before this
change (`player/foray-progress.js`), so that person now *has* a place to lose.
Losing it after having it is worse than never having had it, and losing the
`cp_sb_session` token is worse again — `auth.uid()` from the anonymous session is
the only identity there is (ADR-0005), so an eviction strands the entire learned
taste profile under a user id nothing can reach.

## What was built

A **tiered store behind a synchronous Storage-shaped facade**.

```
  getItem / setItem / removeItem / key / length     ← callers are unchanged
    memory                    authoritative for reads, always current
      ├─ sync tier   localStorage      fast, evictable, may throw
      └─ async tier  IndexedDB         write-behind, share-of-disk quota
                     (Capacitor Preferences drops in here for native)
```

**Why synchronous.** Every caller is: `lsGet`/`lsSet` in `app.js`,
`PositionStore`, `ForayProgressStore`, and a render loop that writes a position
several times a minute. Rewriting the player's effect loop to be async in order
to fix a storage bug is how a fix becomes an outage. Reads answer from memory,
hydrated synchronously from `localStorage` in the constructor and asynchronously
from the durable tiers a moment later. Writes go to memory and `localStorage`
synchronously and ride a serial queue down to the durable tiers.

**Why `app.js` does not import it.** `app.js` is a classic script and everything
under `player/` is an ES module, and `index.html` is outside the auto-merge
allowlist so a third classic script tag was not available. `player/client.js`
builds the one shared store and publishes it on `window.forayStorage`, the same
way the event pipeline is handed over. Until it appears — and permanently, if the
module 404s from a stale service-worker cache — `lsGet`/`lsSet` use raw
`localStorage`, which is where the value would have been anyway.

### Three guarantees, each with tests named after it

1. **Nothing is deleted to migrate it.** `localStorage` is a mirror, not a
   staging area. `hydrate()` copies local-only rows down into the durable tiers
   and durable-only rows back up into `localStorage`, and removes nothing, ever.
   There is no window in which a row exists in neither place.
2. **A write made this session is never clobbered by hydration.** Hydration
   races the first paint. Without a rule, a page that read an evicted (empty)
   `cp_interests`, wrote taxonomy defaults, and only then heard back from
   IndexedDB would overwrite the real profile with defaults — the fix causing the
   defect. Every key written since construction is dirty and hydration will not
   touch it. `app.js` additionally *awaits* hydration before its first write,
   concurrently with the first data fetch so it costs nothing on the critical
   path.
3. **A failed write is detectable.** `setItem` throws when no tier accepted
   responsibility, so `writeProgress`'s `return false` still means what it says.
   Every failure lands in `health()` with tier, op, key and message; `onFault`
   fires so `app.js` can log a `storage_fault` event; the record is mirrored to
   `cp_storage_health`; and `PositionStore`/`ForayProgressStore` count refused
   writes. `window.forayStorageHealth()` prints the whole record from a console.

### `navigator.storage.persist()`

Requested once, at module evaluation, and **not** awaited before anything.

It is a *request*. Chromium grants it silently from engagement/installation
heuristics; Firefox may prompt; Safari does not meaningfully honour it. **A
refusal changes nothing** — both tiers still work, no code branches on the
answer — it is recorded as `health().persisted === "denied"` so that "this
listener's state may not survive a week" is a fact in the data rather than an
assumption in a comment. The five states are `granted`, `denied`, `unsupported`,
`error`, `unknown` (not yet asked). An origin already granted is not asked again;
some engines count repeat prompts against you.

### Data freshness

`sw.js` serves the app shell cache-first and `data/*.json` network-first, so a
stored progress row can be read back against a **different** running order than
the one it was written from: a segment repaired, dropped, or moved.

An index is a *position* and stops meaning anything the moment the order
changes. So a row now records `segment_id` (the authored id) and `into_sec` (the
offset inside that segment) as well as the clock, and `resumePoint` takes the
live order and reports what it found:

| drift | what happened | what resume does |
|---|---|---|
| `exact` | the segment is where the row says | resume at the stored second |
| `moved` | the segment exists elsewhere | follow the **segment** — same audio, new clock |
| `dropped` | the segment is gone | clamp the clock to the live runtime, paint **no** row |
| `unanchored` | a row written before segment ids existed | clamp index and clock, as before |
| `unverified` | no live order was supplied (the home rail) | clamp index and clock, as before |

`moved` and `dropped` are logged as a `foray_progress_drift` event. Nothing
user-facing changes; the point is that a stale row can no longer produce a wrong
seek, and that we can see how often real listeners hit it.

## What this does NOT fix — read this before claiming it does

- **IndexedDB is not immune to eviction.** Safari's 7-day sweep and Chromium's
  bucket eviction take it too. A second tier does not defeat eviction. What it
  buys is independent *failure modes* (localStorage is a hard ~5 MB cap that
  throws `QuotaExceededError`, and is unavailable outright where cookies are
  blocked; IndexedDB has a share-of-disk quota and its own availability), the
  substrate `persist()` actually protects, and the seam the native shell
  replaces with `UserDefaults` / `SharedPreferences`, which genuinely are not
  evictable.
- **The Safari "7 days with no visit" case has no JavaScript fix at all.** The
  real remedies are an installed (Home Screen) web app, which is exempt, and a
  server-side copy under the anonymous session. Neither is implemented here.
- **Real browser storage semantics are unverified.** The IndexedDB adapter is
  tested against a hand-rolled fake `IDBFactory`, which proves the call sequence,
  the commit race, the prefix filtering and every rejection path — and cannot
  prove quota behaviour, eviction, or whether a committed transaction survives an
  iOS restart. Those are marked `// AUDIT:` in the adapter and are only
  observable in a browser.

## Still open

- **A server-side copy of resume state.** The events pipeline already reaches
  Supabase under the anonymous session, so a progress row could ride it — but
  that only helps if the *token* survived, which is the same problem one level
  up. Making it genuinely durable means an account, which is a product decision.
- **`sw.js` cache version.** This change does not touch `sw.js` (outside the
  auto-merge allowlist). `app.js` is in the precached shell, so a returning
  visitor runs the previous `app.js` for one load. That is the existing
  behaviour for every `app.js` change; it is worth a deliberate bump here because
  a storage migration wants to be crisp rather than half-applied across tabs.
  Filed as `HUMAN-ACTIONS.md` #9.
- **`#40`'s Problem 1 (bundled snapshot + TTL refresh in a native app)** is not
  in this change. It is about `fetchJson`, the bundled `prepare-webdir.mjs`
  subset and a filesystem cache, all of which depend on #36 landing. The
  freshness work here is the web half: making sure a *stale cached document*
  cannot corrupt a stored position.
