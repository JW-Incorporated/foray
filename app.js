/* Foray web client v4 — app shell.
   Views: home (rails: Jump back in, Forays / Playlists / Suggested),
   playlists list, playlist detail, shows, Forays, Library. Hash routing.
   The semantic layer (compiled concepts + tags) powers playlist building. */

/* THE GENERATION PIN, READ BEFORE ANYTHING ELSE IN THIS FILE (#233/M4).
 *
 * sw.js's `handleShell` bakes a fallen-back generation's id directly into
 * whichever CODE file it served stale, synchronously, so it is readable
 * before that file's own logic runs — never only via `postMessage`, which a
 * review correctly flagged as racy: a message sent before this file's own
 * `addEventListener("message", ...)` attaches (further down this file, after
 * `init()` has already started fetching) is simply lost, and `init()`'s first
 * `data/*.json` fetches would go out unpinned even though the code they are
 * paired with is stale.
 *
 * Two places this id can arrive from, checked in the order a real page load
 * can produce them:
 *   1. `self.__forayPinnedDeployId` — set by a `self.__forayPinnedDeployId =
 *      "<id>";` statement sw.js prepends to THIS file's own bytes, when
 *      app.js itself is what fell back. Executes as this file's very first
 *      statement, before anything below it.
 *   2. A `<meta name="foray-pin-deploy-id" content="<id>">` tag sw.js
 *      inserts into `index.html`'s `<head>` when the NAVIGATION fell back
 *      (parsed by the browser before any script tag runs, including this
 *      one). That fallback document also asks for this file as
 *      `app.js?_fdid=<id>`, which the worker answers from the same
 *      generation (round-3 audit, app-3-5), so a meta pin always names the
 *      generation this very file came from. It used to load live from a
 *      newer deploy and pin itself to the previous one's data. A fallen-back
 *      search-engine.js no longer carries a pin statement at all.
 * Either establishes the pin synchronously; no message race is possible for
 * either path. The one residual gap — `player/client.js`, a DEFERRED module
 * that can still be discovered stale after `init()`'s own fetches have
 * already gone out — is unchanged from the original design and is named in
 * sw.js's header; closing it would mean blocking every page load on that
 * module, which the founding "survive a dead zone" constraint rules out. */
let pinnedDeployId = (typeof self !== "undefined" && self.__forayPinnedDeployId) || null;
if (!pinnedDeployId && typeof document !== "undefined" && typeof document.querySelector === "function") {
  /* Defensive on `metaPin` itself, not just `document.querySelector`'s
     existence: several test harnesses in this repo (episode-page.test.js,
     first-time-onboarding.test.js, others) stub `document.querySelector` as
     an always-truthy shape with no real selector matching and no
     `getAttribute`, to keep those harnesses minimal. A real DOM's
     `querySelector` correctly returns `null` for a tag that is not there;
     this reads the attribute only when the returned object actually offers
     one, so neither shape can throw. */
  const metaPin = document.querySelector('meta[name="foray-pin-deploy-id"]');
  if (metaPin && typeof metaPin.getAttribute === "function") {
    pinnedDeployId = metaPin.getAttribute("content") || null;
  }
}
/* THE DEPLOY THIS PAGE IS RUNNING (round-3 audit, app-3-3). The deploy build
   stamps it into index.html's `<meta name="foray-deploy-id">` (committed as
   "unstamped"; tools/ci/generate-manifest.mjs). The worker announces every
   promotion to every open page as "generation-changed"; a page that already
   loaded that deploy live is not "one version behind", and the message
   handler below compares against this. null when it cannot be known (an
   unstamped checkout, a stub document), which keeps the old behaviour. */
let pageDeployId = null;
if (typeof document !== "undefined" && typeof document.querySelector === "function") {
  const metaDeploy = document.querySelector('meta[name="foray-deploy-id"]');
  const content = metaDeploy && typeof metaDeploy.getAttribute === "function" ? metaDeploy.getAttribute("content") : null;
  if (content && content !== "unstamped") pageDeployId = content;
}

const state = {
  session: null,
  validated: null,
  taxonomy: null,
  discover: null,
  interests: {},
  semantic: null,
  itemTags: null,
  forays: null,             // data/forays.json   — may be absent; see fetchJson
  segments: null,           // data/segments.json
  segmentSources: null,     // data/segment-sources.json
  catalog: null,            // data/catalog-client.json — show-level records, #/show/:id (Stage 1)
  breadthShowCache: {},     // show_id -> minimal show record from /api/shows/search (A3.1/Q3), see showById
  shardShowCache: {},       // "pi:<id>" -> mapped show record from a shard-search result (S-05), see showById
  foray: null,              // the resolved Foray currently on screen
  forayResume: null,        // its stored resume point, or null — see paintForay
  forayPlaying: null,       // id of the Foray the player is inside, or null
  forayPainted: null,       // last segment index painted onto the running order
  cardSlots: [],            // the four dealt suggestions
  itemIndex: {},            // id -> snapshot (a CACHE, never a membership test — see fullPool)
  poolIds: new Set(),       // ids the catalogue holds RIGHT NOW — rebuilt by fullPool
  ready: false,
};

const SEEN_WINDOW = 100;
const BRANCH_MEMORY = 8;

const $ = (sel, el = document) => el.querySelector(sel);

/* ---------- escaping / urls ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeUrl(u) {
  /* External SVG sprites are loaded through a relative, same-origin URL. Keep this
     allowance deliberately narrower than "relative URL": no leading slash, traversal,
     query or encoded separator can turn it into another resource or origin. */
  if (typeof u === "string" && /^ui\/icons\.svg#i-[a-z0-9-]+$/.test(u)) return u;
  try {
    const p = new URL(u);
    if (p.protocol === "https:" || p.protocol === "http:") return u;
  } catch (_) {}
  return "#";
}

/* ---------- storage ----------

   EVERY `cp_` key in this file goes through these two functions, and they are
   the whole reason issue #40's shim could be added without touching 40 call
   sites. What changed (#40) is what sits behind them.

   It used to be `localStorage`, which browsers evict: Safari clears
   script-writable storage after ~7 days without a visit, any engine can evict
   under storage pressure, and a WKWebView's storage is not durable by default.
   Everything this app knows about a listener is in here — interests, thumbs,
   positions, where they are inside a 61-minute Foray, and the Supabase anonymous
   token that IS their identity (ADR-0005). Losing it silently orphans them.

   So the backing store is now `player/durable-store.js`: the same synchronous
   Storage shape, memory-fast for reads, backed by IndexedDB, with localStorage
   kept as a mirror so nothing breaks where IndexedDB is unavailable. It is built
   in `player/client.js` and handed over on `window.forayStorage`, because that
   file is an ES module and this one is a classic script that cannot import it —
   and because `index.html` is outside the auto-merge allowlist, so adding a
   third classic script tag to the page was not on the table.

   THE FALLBACK IS NOT DECORATION. Until that module evaluates (and forever, if
   it 404s from a stale service-worker cache) these read and write raw
   localStorage, which is exactly where the value would have been anyway. The
   store's own hydration then migrates whatever was written in the meantime.
   `storageReady()` below is what stops that window from costing anything.

   Key names are untouched, deliberately — CLAUDE.md § Conventions: the `cp_`
   prefix is legacy and renaming a key wipes user state. The shim changes the
   backing store, never the keys. */

function storageBackend() {
  if (window.forayStorage) return window.forayStorage;
  return typeof localStorage !== "undefined" ? localStorage : null;
}

function lsGet(key, fallback) {
  const store = storageBackend();
  if (!store) return fallback;
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch (_) { return fallback; }
}

/** @returns {boolean} whether the value is now stored somewhere. False means the
    write was refused by every tier — callers mostly cannot act on that, but a
    function that reports it can be tested, and `window.forayStorageHealth()`
    holds the reason. The old version returned nothing and swallowed the error. */
function lsSet(key, value) {
  const store = storageBackend();
  if (!store) return false;
  try { store.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
}

/* The store arrives with `player/client.js`, which is a deferred module: it has
   evaluated by the time `init()` comes back from its first fetch, but not
   necessarily before `init()` starts. Wait for it the same bounded way
   `playerBridge()` waits for the player, then wait for HYDRATION — which is the
   part that matters, because reading `cp_interests` or `cp_sb_session` before
   IndexedDB has been consulted is how a restored profile gets overwritten by a
   fresh one. That is the fix causing the defect, and it is why this is awaited
   in `init()` rather than left to settle whenever.

   Bounded on purpose: a hung IndexedDB must cost the durable tier, never the
   page. And a `window` with no `addEventListener` cannot ever tell us the store
   arrived, so there is nothing to wait for — that is the case in the test
   harnesses, and treating it as "no store" is the same answer as a 404.

   THE TIMEOUT IS THE LAST RESORT, NOT THE ANSWER. `playerBridge()` below can
   afford to sit on its whole budget because it only ever runs on a click. This
   runs before the first paint, so spending five seconds here on a 404 would cost
   the page — the exact thing this shim is not allowed to do. Module scripts are
   deferred and always execute before `DOMContentLoaded`, so that event is an
   exact "it is not coming": if the store is not published by then, the module
   failed to load or threw, and we go on with `localStorage`. */
/* `let`, so a suite can shorten it (test/boot-path.test.js). */
let STORAGE_WAIT_MS = 5000;

/* HAVE THE DEFERRED MODULES RUN? (audit round 2 review of states-6 and
   races-4.) Per the HTML spec the parser sets `readyState` to "interactive"
   BEFORE it runs the deferred and module scripts, and DOMContentLoaded fires
   only after them -- so "readyState is no longer loading" does NOT mean the
   player module has run or failed; on a slow cell link its 28-file graph can
   still be downloading. Both readers below took it to mean exactly that: a
   slow module was offered "Reload 4a" (restarting the slow download), and a
   storage wait that timed out latched the hydration gate open for good. The
   flag flips on DOMContentLoaded, or is already true once the document is
   "complete". A stub document with neither state reads as run. */
let deferredScriptsRan = (() => {
  try {
    const rs = document.readyState;
    return rs !== "loading" && rs !== "interactive";
  } catch (_) { return true; }
})();
const deferredScriptsWaiters = [];
if (!deferredScriptsRan) {
  try {
    document.addEventListener("DOMContentLoaded", () => {
      deferredScriptsRan = true;
      for (const fn of deferredScriptsWaiters.splice(0)) {
        try { fn(); } catch (err) { console.error("after DOMContentLoaded", err); }
      }
    }, { once: true });
  } catch (_) { deferredScriptsRan = true; }
}
function afterDeferredScripts(fn) {
  if (deferredScriptsRan) fn();
  else deferredScriptsWaiters.push(fn);
}

function waitForStorage() {
  if (window.forayStorage) return Promise.resolve(window.forayStorage);
  if (typeof window.addEventListener !== "function") return Promise.resolve(null);
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(window.forayStorage || null); } };
    window.addEventListener("forayplayer:ready", finish, { once: true });
    /* Every deferred module has run (or failed) once DOMContentLoaded has
       fired: either the store is here (handled above) or it is never arriving. */
    afterDeferredScripts(finish);
    setTimeout(finish, STORAGE_WAIT_MS);
  });
}

/* WHAT THE BOUND COSTS, AND WHO WAITS PAST IT (round-2 audit, races-4).

   The five-second bound above lets the page paint on a hung IndexedDB, and
   that is right. What was wrong is that everything after it wrote as though
   hydration had happened. The store lets the FIRST writer of a key own it for
   the session (durable-store.js, property 2), so in the case the durable tier
   exists for — localStorage swept, IndexedDB intact but slow — boot's own
   writes permanently shadowed the listener's real rows: taxonomy defaults over
   learned interests on the first play, a new `cp_profile_id`, a new anonymous
   account, a reset `cp_seen`. Only the playback rate had been fixed
   (client.js, `storageHydrated`).

   So the rule is now a single gate, `storageWaiting()`: true while a published
   store's hydration has not finished, on time or late (`storageSettled`). Work
   that WRITES a key whose durable copy matters asks `afterStorageSettles()`
   instead of writing blind — the event buffer (and the profile id it mints),
   the event sync (and the account it may create), the dealt-cards memory. The
   interests profile is handled at its own writer: `saveInterests` writes only
   ids this session set, and a late hydration re-seeds the rest. */
let storageSettled = false;
const storageSettleWaiters = [];
/** The bound ran out while the player module (which publishes the store) was
    still loading: the store is LATE, not absent (audit round 2 review). */
let storageLate = false;

/** Is there a durable store whose hydration has not landed yet -- or one that
    is still on its way? With no store coming there is nothing to wait for: the
    writes go to plain localStorage, as they always have. */
function storageWaiting() {
  if (storageSettled) return false;
  const s = window.forayStorage;
  if (s && typeof s.hydrate === "function") return true;
  return storageLate;
}

/* A CEILING OF ITS OWN (audit round 2 review). The five-second bound lets the
   page PAINT past a hung IndexedDB; nothing bounded the settle, so a hydration
   that never answered (idb-tier.js has no open timeout -- a WKWebView IndexedDB
   that never calls back) held every waiter for the whole session: interests,
   the seen list and the event rows were all lost at page close. Past this the
   gate opens and they flush to the store's sync tier (or plain localStorage).
   `let`, so a suite can shorten it. */
let STORAGE_SETTLE_CEILING_MS = 30000;
let storageCeilingArmed = false;
function armStorageSettleCeiling() {
  if (storageCeilingArmed || storageSettled) return;
  storageCeilingArmed = true;
  setTimeout(() => {
    if (storageSettled) return;
    console.warn("[4a] storage never settled; writing to the local tier");
    storageLate = false;
    markStorageSettled();
  }, STORAGE_SETTLE_CEILING_MS);
}

/** Settle when THIS store's hydration lands (or the ceiling passes). */
function settleOnHydrate(store) {
  const landed = (async () => {
    try { await store.hydrate(); } catch (_) { /* every tier failure is already recorded in health() */ }
  })();
  landed.then(markStorageSettled);
  armStorageSettleCeiling();
  return landed;
}

/** The wait ended with no store. Settle only when it is KNOWN not to be coming
    (the deferred modules have run and published none); a store merely late --
    the bound passed while the module graph was still downloading -- keeps the
    gate shut until it arrives and hydrates. Latching "settled" on the timeout
    let logEvent mint a new cp_profile_id and the sync sign up a new account
    against the unhydrated store the moment it arrived (races-4, by a slow
    module instead of a slow IndexedDB). */
function settleWhenStoreArrives() {
  const arrived = () => {
    if (storageSettled) return;
    const s = window.forayStorage;
    if (s && typeof s.hydrate === "function") { storageLate = false; settleOnHydrate(s); return; }
    if (deferredScriptsRan) { storageLate = false; markStorageSettled(); }
  };
  if (deferredScriptsRan) { arrived(); return; }
  storageLate = true;
  try { window.addEventListener("forayplayer:ready", arrived, { once: true }); } catch (_) { /* no events: DOMContentLoaded below */ }
  afterDeferredScripts(arrived);
  armStorageSettleCeiling();
}

/** Run `fn` now unless a store is still hydrating, else the moment it lands. */
function afterStorageSettles(fn) {
  if (!storageWaiting()) { fn(); return; }
  storageSettleWaiters.push(fn);
}

/* THE LISTENER'S OWN ACTIONS WAIT TOO (audit round 3, app-1-1). The gate above
   covered boot's writes; a star, an Up Next edit, a follow or a play in the
   window still did read-modify-write against the unhydrated store. With
   localStorage swept and IndexedDB slow, toggleStar read `{}` and wrote
   `{thisOne}` to cp_saved, and the store's property 2 (a write this session is
   never clobbered by hydration, durable-store.js) then kept that one-row map
   over the durable Saved list for good. The same held for cp_history,
   cp_episode_snaps, cp_queue, cp_starred_shows and cp_shard_shows.

   So those writers now state an EDIT -- a function from the stored value to the
   new one -- through `editStored`. Once storage has settled it runs at once,
   exactly the old read-modify-write. Before, it is queued (one waiter per key)
   and re-run over the SETTLED value when hydration lands, so the durable rows
   and this session's taps both survive; meanwhile `storedValue` answers reads
   from the unhydrated value with the queued edits applied, so the page paints
   the tap at once. Nothing here changes hydration or weakens property 2: the
   fix is to not write early. An edit must be a pure function of its argument
   (it is re-run on every read of the overlay), and must not assume the stored
   value has the right shape. */
const pendingStoredEdits = new Map();

/** The value of `key` with any edits still waiting for storage applied.
    With none waiting it is the SHARED parse (`lsGetShared`): callers read it
    and never mutate it -- every writer goes through `editStored`, whose edit
    is handed a fresh parse. */
function storedValue(key, fallback) {
  const edits = pendingStoredEdits.get(key);
  if (!edits) return lsGetShared(key, fallback);
  return edits.reduce((v, fn) => fn(v), lsGet(key, fallback));
}

/* ONE PARSE PER STORED STRING (audit round 3, app-1-8 and perf-3). `lsGet`
   JSON.parses on every call, and the hot readers call it per row and per tick:
   every epRow's star asked isSaved -> savedMap -> a parse of the whole of
   cp_saved (a 100-row show page parsed it 100 times per paint), and the Now
   Playing sheet's row2 reads EPISODE_NAVIGATION's getters on every 4 Hz
   timeupdate, each re-parsing cp_queue and cp_saved. The parsed value is kept
   against the exact string the store returned; a write stores a new string,
   so the next read re-parses and nothing needs invalidating by hand. The
   value is SHARED: read-only for every caller. */
const lsParseMemo = new Map();
function lsGetShared(key, fallback) {
  const store = storageBackend();
  if (!store) return fallback;
  let raw;
  try { raw = store.getItem(key); } catch (_) { return fallback; }
  const hit = lsParseMemo.get(key);
  if (hit && hit.raw === raw && hit.store === store) return hit.value ?? fallback;
  let value = null;
  try { value = JSON.parse(raw); } catch (_) { value = null; }
  lsParseMemo.set(key, { raw, store, value });
  return value ?? fallback;
}

/* lsSet's answer for the last flush of each key's queued edits: a caller
   that queued an edit and must report whether it was really kept (a playlist
   save, #839) reads it from a waiter queued after its edit, which runs after
   the flush. */
const storedFlushOk = new Map();

/** Apply `fn` to `key`'s stored value: now, or over the settled store once
    hydration lands. Returns lsSet's answer now, or true for a queued edit. */
function editStored(key, fallback, fn) {
  if (!storageWaiting()) return lsSet(key, fn(lsGet(key, fallback)));
  let edits = pendingStoredEdits.get(key);
  if (!edits) {
    edits = [];
    pendingStoredEdits.set(key, edits);
    afterStorageSettles(() => {
      const list = pendingStoredEdits.get(key) || [];
      pendingStoredEdits.delete(key);
      storedFlushOk.set(key, lsSet(key, list.reduce((v, f) => f(v), lsGet(key, fallback))));
    });
  }
  edits.push(fn);
  return true;
}

function plainObject(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function stringList(v) { return Array.isArray(v) ? v.filter(x => typeof x === "string" && x) : []; }

function markStorageSettled() {
  if (storageSettled) return;
  storageSettled = true;
  flushBufferedEvents();
  for (const fn of storageSettleWaiters.splice(0)) {
    try { fn(); } catch (err) { console.error("after storage settled", err); }
  }
}

async function storageReady() {
  const store = await waitForStorage();
  if (!store || typeof store.hydrate !== "function") { settleWhenStoreArrives(); return null; }
  // Registered BEFORE the race below, so an on-time hydration has settled by
  // the time the caller resumes.
  const landed = settleOnHydrate(store);
  await Promise.race([landed, new Promise(resolve => setTimeout(resolve, STORAGE_WAIT_MS))]);
  return store;
}

function profileId() {
  let id = lsGet("cp_profile_id", null);
  if (!id) {
    id = "p-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    lsSet("cp_profile_id", id);
  }
  return id;
}

/* Buffers rows logged before `player/client.js` has evaluated and published
   `window.forayEventLog` — the same bridging pattern `waitForStorage()` above
   uses for `cp_` keys, and for the same reason: `app.js` is a classic script
   parsed before the deferred module below it, so a `logEvent` call made
   during `init()`'s own early work (a `refreshed_all` on first paint, say)
   must not be silently dropped just because the module has not arrived yet.
   Drained by `flushBufferedEvents()`, called once the module is confirmed
   present (mirroring `storageReady()`'s one-shot handoff). */
let _bufferedEvents = [];
const BUFFERED_EVENTS_CAP = 500;

/* True for the length of a "Delete my data" clear (review 2026-09-23). The
   store's purge re-arms a durable tier its breaker had switched off, and every
   remove that tier then refuses reaches `onFault` -> `forayLogEvent` -> here:
   `profileId()` minted a NEW cp_profile_id and the row landed in the queue the
   deletion had just emptied. Nothing is logged while the device is being
   emptied — the same rule that makes the deletion itself the one action the
   app never logs. */
let dataDeletionInProgress = false;

/* Bumped by every "Delete my data" run the moment it is confirmed. An event
   sync notes it when it starts; one that finds it moved has outlived a
   deletion — its session and its rows belong to an account the listener just
   deleted, so it writes nothing (round-2 audit, persist-8). `ddBusy` is NOT the
   test for that: a sync that wakes after the run has finished sees it false. */
let deletionEpoch = 0;

/** True when the sync that started at `epoch` must not write: a deletion is
    running now (`ddBusy` from the stop onward, `dataDeletionInProgress` for the
    purge), or one has run since it started. */
function syncOutlived(epoch) {
  return dataDeletionInProgress || ddBusy || epoch !== deletionEpoch;
}

/* How many times the device's rows have actually been purged. A sync whose
   POSTs all succeeded marks its rows synced unless a purge reached the queue
   meanwhile (audit round 2 review): skipping markSynced merely because a
   deletion STARTED left rows the server already held unsynced, and when that
   deletion then failed remotely (the device deliberately untouched) the next
   sync re-sent the batch — event rows carry no client id, so the server
   stored every one twice. */
let localClears = 0;

/* `ts` is for a row that HAPPENED EARLIER than it is logged: an advance or a
   position the native engine recorded while this page slept, replayed on the
   next wake (`applyEngineAdvance`, `drainEngineEvents`). Stamping those "now"
   would put a drive's positions at the moment the phone was unlocked. */
function logEvent(type, payload, { ts = null } = {}) {
  if (dataDeletionInProgress) return;
  /* `profile` is stamped when the row leaves the buffer, not here: minting it
     before hydration wrote a fresh `cp_profile_id` over the durable one
     (races-4). A row logged before storage settles waits in the buffer. */
  const row = { ts: typeof ts === "string" && ts ? ts : new Date().toISOString(), type, builder: state.session?.builder || "unknown", profile: null, payload };
  if (!storageWaiting() && window.forayEventLog && typeof window.forayEventLog.append === "function") {
    flushBufferedEvents();
    row.profile = profileId();
    window.forayEventLog.append(row);
  } else {
    _bufferedEvents.push(row);
    /* BOUNDED ONCE NOTHING IS COMING (audit round 3, app-1-12). With the
       deferred modules run and no event log published, player/client.js
       failed to load (a 404 from a stale generation, a throw), and nothing will
       ever drain this: every row of the session stayed in memory. Kept to the
       newest rows then; before that (a module still loading, storage still
       settling) the buffer is a real queue and is left whole. */
    if (_bufferedEvents.length > BUFFERED_EVENTS_CAP && deferredScriptsRan
        && !(window.forayEventLog && typeof window.forayEventLog.append === "function")) {
      _bufferedEvents.splice(0, _bufferedEvents.length - BUFFERED_EVENTS_CAP);
    }
  }
}

/** Hand the pre-module buffer to `window.forayEventLog` the moment it exists.
    Called from `logEvent` itself (the module may have arrived between two
    calls) and once from `init()` after `waitForStorage()` settles, matching
    how `player/client.js` publishes both bridges off the same
    `forayplayer:ready` event. */
function flushBufferedEvents() {
  if (!_bufferedEvents.length) return;
  if (storageWaiting()) return;
  if (!window.forayEventLog || typeof window.forayEventLog.append !== "function") return;
  const rows = _bufferedEvents;
  _bufferedEvents = [];
  for (const row of rows) {
    if (!row.profile) row.profile = profileId();
    window.forayEventLog.append(row);
  }
}

/* Durable telemetry: flush the buffered events to Supabase (ADR-0005 +
   docs/curation/events-client-integration-spec.md). Anonymous-first — every
   device gets a Supabase anonymous user; rows insert under auth.uid() and RLS
   enforces per-user isolation. Publishable key is public by design (RLS
   protects the data). Raw fetch, no SDK, to stay within the strict CSP. */
const SB_URL = "https://qjdllvqdcgacvujhclny.supabase.co";
const SB_KEY = "sb_publishable_0T8hpKCC_857G31LlCh0WA_0Rp61B3J";

/* LAB BUILDS NEVER WRITE TO PRODUCTION (Redesign 2026, docs/redesign-2026/PLAN.md).
   The "4a Lab" app (ai.jwlabs.foura.lab, built by .github/workflows/lab-build.yml)
   carries `window.__FORAY_LAB__ = true`, injected by tools/mobile/prepare-webdir.mjs
   as a classic (non-module) head script so it runs BEFORE this file. In a lab build
   there is no anonymous sign-up, no token refresh and no event POST: a redesign
   being tried on a founder's phone must not mint users or rows in the live
   Supabase project. Reads (the catalogue/search API GETs) are untouched. Read at
   call time, not captured, so the one flag decides every call below. The real
   build and the web never set it, so for them this is `false` and nothing here
   changes. test/lab-flag.test.js pins the three gates. */
function isLabBuild() {
  return typeof window !== "undefined" && window.__FORAY_LAB__ === true;
}

/* WHERE `api/*` ACTUALLY LIVES, and why naming it here is not a style choice.

   Every `api/shows/*` and `api/episodes/*` call used to be a RELATIVE path. On
   the web that resolves against the page's origin, which is GitHub Pages, where
   no such function exists (404). In the native shell the page is served from
   `capacitor://localhost`, so it resolves INSIDE the app bundle — a scheme with
   no server behind it at all. Both failures are swallowed by the callers' own
   "absence is a real state" degrade, so the app fell back to the bundled slice
   of `BUNDLED_ITEMS_PER_SHOW` (3) episodes a show and said nothing. That is the
   whole of "4a only has 3 episodes per show": the full-catalogue endpoint has
   been shipping and working, and no client has ever reached it.

   The functions are deployed by the Vercel project `foray-web` (vercel.json,
   api/package.json); this is its production alias. It is a bare origin with no
   trailing slash, and `test/api-origin.test.js` pins that shape, because
   `apiUrl()` joins with a single "/" and a trailing one would produce `//api`.

   NOT `pinnedUrl()`. That appends `_fdid=<deploy id>` so a reload cannot mix
   files from two data deploys — a statement about the STATIC bundle's
   generation. These are live functions with no deploy generation to pin, so the
   parameter would be noise the function has to ignore. */
const API_ORIGIN = "https://foray-web-seven.vercel.app";

function apiUrl(path) {
  return `${API_ORIGIN}/${String(path).replace(/^\/+/, "")}`;
}

/** One auth call, answered as `{ ok, status, body }` (audit round 3, app-1-4).
    It used to answer null for EVERYTHING that was not a 2xx, so "this refresh
    token is dead" (a 400 invalid_grant) and "the token endpoint hiccupped" (a
    429, a 5xx, a timeout) looked the same -- and the second one signed the
    device up as a new user. `status` is 0 when no answer arrived at all. */
async function sbAuth(path, body) {
  if (isLabBuild()) return { ok: false, status: 0, body: null }; // lab: no auth call leaves the device
  try {
    const res = await fetch(SB_URL + path, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { parsed = null; }
    return { ok: Boolean(res.ok), status: Number(res.status) || 0, body: parsed };
  } catch (_) { return { ok: false, status: 0, body: null }; }
}

/** Did a refresh fail because the refresh token itself is dead? Only then may
    a sync give up on the account and sign up a new one. GoTrue answers a dead
    token with 400 (401 on some versions) and `error: "invalid_grant"` or an
    `error_code` naming the token or its session: `refresh_token_not_found`,
    `refresh_token_already_used` (a rotated-out token reused: the app killed
    between the refresh answer and lsSet, or a store that refused the write,
    leaves exactly that token stored), `session_not_found`, `session_expired`,
    `user_not_found`. Without the already-used code such a device returned
    null on every sync from then on and never signed up again (round-3
    review, L1). Anything else -- a 429, a 5xx, no answer, a body it did not
    recognise -- is transient: keep the account and let the queued rows retry. */
const DEAD_REFRESH_CODES = new Set([
  "invalid_grant", "refresh_token_not_found", "refresh_token_already_used",
  "session_not_found", "session_expired", "user_not_found",
]);
function refreshTokenDead(r) {
  if (!r || (r.status !== 400 && r.status !== 401)) return false;
  const b = r.body && typeof r.body === "object" ? r.body : {};
  return [b.error, b.error_code, b.code].some(c => typeof c === "string" && DEAD_REFRESH_CODES.has(c));
}

/** Can a new `cp_sb_session` be kept? Asks the durable store (`canKeep`); a
    page with no store, or an older store without the method, answers yes —
    plain localStorage, as it always has. */
function sessionKeepable() {
  const store = window.forayStorage;
  if (!store || typeof store.canKeep !== "function") return true;
  try { return store.canKeep("cp_sb_session") !== false; } catch (_) { return false; }
}

/* Establish/restore the anonymous session. Refresh a stored token (same user)
   when possible; only create a NEW anonymous user when there's no token or the
   refresh fails — re-signing-up every load would orphan a user per visit.

   ONE AT A TIME (audit round 3, app-1-2). Two callers that overlapped each
   read "no cp_sb_session" and each called /auth/v1/signup: N anonymous users,
   the last lsSet won, and the rows posted under the others were orphaned where
   Delete my data cannot reach them. Every caller now shares the one in-flight
   answer. */
let anonSessionInFlight = null;
function ensureAnonSession(epoch = deletionEpoch) {
  if (anonSessionInFlight) return anonSessionInFlight;
  const p = ensureAnonSessionOnce(epoch);
  anonSessionInFlight = p;
  const clear = () => { if (anonSessionInFlight === p) anonSessionInFlight = null; };
  p.then(clear, clear);
  return p;
}

async function ensureAnonSessionOnce(epoch) {
  if (isLabBuild()) return null; // lab: never sign up, never refresh
  if (syncOutlived(epoch)) return null;
  const now = Math.floor(Date.now() / 1000);
  let s = lsGet("cp_sb_session", null);
  if (s && s.access_token && s.expires_at && s.expires_at - 60 > now) return s;
  /* NOTHING WE CANNOT KEEP (persist-6). Inside the app the token lives only in
     the device-only vault. When that vault could not be read, or has stopped
     taking writes, a refresh would spend the refresh token for a result that is
     not saved, and a signup would mint a second account over one we merely
     failed to read. The events wait in their queue for a launch that can. */
  if (!sessionKeepable()) return null;
  if (s && s.refresh_token) {
    const res = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    /* Asked again AFTER the await: a refresh that was already in flight when
       Delete was tapped must not write the old account's token back onto a
       device the deletion emptied (persist-8). */
    if (syncOutlived(epoch)) return null;
    const r = res.ok ? res.body : null;
    if (r && r.access_token) {
      s = { user_id: (r.user && r.user.id) || s.user_id, access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || now + 3600 };
      lsSet("cp_sb_session", s);
      return s;
    }
    /* A transient failure keeps the account (app-1-4): a new user here would
       split the listener's history across two accounts for good. */
    if (!refreshTokenDead(res)) return null;
  }
  if (syncOutlived(epoch)) return null;
  const res = await sbAuth("/auth/v1/signup", {});
  if (syncOutlived(epoch)) return null;
  const r = res.ok ? res.body : null;
  if (r && r.access_token && r.user && r.user.id) {
    s = { user_id: r.user.id, access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || now + 3600 };
    lsSet("cp_sb_session", s);
    return s;
  }
  return null;
}

/* Map a buffered event-log row (window.forayEventLog, formerly `cp_events`) to
   a canonical events-table row, or null for local-only types (see the
   client-integration spec §3). episode_id/session_id stay null; durable ids
   ride in payload as episode_slug/session_key. */
const SB_ARCHETYPES = new Set(["deep-learn", "stretch", "narrative", "comfort", "continue"]);
/* The player (player/client.js) is an ES module and cannot import from this
   classic script, so the event pipeline is handed over explicitly rather than
   duplicated. */
window.forayLogEvent = (type, payload) => logEvent(type, payload);

function toEventRow(e, userId) {
  const p = e.payload || {};
  const row = (type, payload, archetype) => ({ user_id: userId, ts: e.ts, type, archetype: archetype || null, payload });
  switch (e.type) {
    case "picked":
      return row("picked", { episode_slug: p.episode_id, topics: p.topics || [], app: p.app }, SB_ARCHETYPES.has(p.context) ? p.context : null);
    case "saved":
      return row("saved", { episode_slug: p.episode_id, topics: p.topics || [] });
    case "thumbs":
      // The canonical shape is `{direction, node_id, episode_slug?}` and
      // `node_id` is MANDATORY — the learning job keys the signal on a taxonomy
      // node, so a thumb with nowhere to land is dropped here rather than
      // inserted as a row nothing can read (events-client-integration-spec §2).
      if (!p.node_id || (p.direction !== "up" && p.direction !== "down" && p.direction !== "cleared")) return null;
      // A withdrawn vote means nothing without the vote it withdrew (app-2-6).
      if (p.direction === "cleared" && !p.replaces) return null;
      // `episode_slug` is OPTIONAL in the contract, and optional means absent —
      // the schema is `z.string().optional()`, which rejects an explicit null.
      return row("thumbs", {
        direction: p.direction,
        node_id: p.node_id,
        ...(p.episode_slug ? { episode_slug: p.episode_slug } : {}),
        // Additive context. §6 of the spec notes `up` reuses `more_like_this`
        // server-side, so the reason codes only ever ride a `down`.
        reasons: p.reasons || [],
        note: p.note || null,
        segment_id: p.segment_id || null,
        foray_id: p.foray_id || null,
        // The vote this one changed or withdrew, so the learning job can take
        // its move back (round-3 audit, app-2-6). Absent on a first vote.
        ...(p.replaces && (p.replaces.direction === "up" || p.replaces.direction === "down")
          ? { replaces: { direction: p.replaces.direction, reasons: Array.isArray(p.replaces.reasons) ? p.replaces.reasons : [] } }
          : {}),
      });
    case "session_shown":
      return row("session_built", { session_key: p.session_id, builder: e.builder || "unknown" });
    default:
      return null; // unsaved / playlist_* / family_mode / refreshed_all — local only
  }
}

/* EVERY SYNC IS KNOWN TO "DELETE MY DATA" (round-2 audit, persist-8). A sync
   already in flight when Delete was tapped went on regardless: its refresh
   could write the old `cp_sb_session` back after the purge, and its POST could
   land after the `events` DELETE. So each run is held in `syncsInFlight` for
   `deleteMyData` to wait out before it touches the server, and every step that
   writes (the session, a batch) asks `syncOutlived()` first. */
const syncsInFlight = new Set();

/* SINGLE-FLIGHT (audit round 3, app-1-2). Every call used to start its own
   syncEventsOnce(): `unsynced()` hands out rows without claiming them, so two
   overlapping runs POSTed the same rows and the events table (no client id, no
   unique key) stored each one twice -- and every action taken while storage was
   settling queued one more waiter, all of which fired together. Now: at most
   one run (`syncRun`), at most ONE follow-up behind it however many callers
   asked meanwhile (`syncFollowUp`, so a row logged mid-run still goes out), and
   at most one pre-settle waiter (`syncSettleWaiter`, the saveInterestsPending
   pattern). */
let syncRun = null;
let syncFollowUp = null;
let syncSettleWaiter = null;

function trySyncEvents() {
  const epoch = deletionEpoch;
  if (syncOutlived(epoch)) return Promise.resolve();
  /* An unread `cp_sb_session` reads as "no account", and `ensureAnonSession`
     answers that by signing up a new one (races-4). Before storage settles
     there is nothing to sync that cannot wait for it. */
  if (storageWaiting()) {
    if (!syncSettleWaiter) {
      syncSettleWaiter = new Promise(resolve => afterStorageSettles(() => { syncSettleWaiter = null; resolve(trySyncEvents()); }));
    }
    return syncSettleWaiter;
  }
  if (syncRun) {
    if (!syncFollowUp) {
      syncFollowUp = syncRun.then(() => { syncFollowUp = null; return trySyncEvents(); });
    }
    return syncFollowUp;
  }
  const run = syncEventsOnce(epoch);
  syncRun = run;
  syncsInFlight.add(run);
  /* Registered before any follow-up's `then`, so the slot is free when it runs. */
  run.finally(() => { syncsInFlight.delete(run); if (syncRun === run) syncRun = null; });
  return run;
}

async function syncEventsOnce(epoch) {
  const clearsAtStart = localClears;
  if (isLabBuild()) return; // lab: events stay in the local queue, nothing is POSTed
  try {
    if (!window.forayEventLog || typeof window.forayEventLog.unsynced !== "function") return;
    flushBufferedEvents();
    const unsynced = await window.forayEventLog.unsynced();
    if (!unsynced.length) return;
    const s = await ensureAnonSession(epoch);
    if (!s) return; // offline / auth unavailable — buffer persists, retry next time
    /* CHUNKS, EACH MARKED AS IT LANDS (audit round 3, app-1-10). Rows go up
       500 at a time, and ids used to be marked synced only after the LAST
       chunk: chunk 1 accepted, chunk 2 a 5xx, and the next sync POSTed chunk 1
       again -- stored twice, since the table has no client id. Each chunk now
       carries the ids it covers, the local-only rows between its rows
       included, and they are marked the moment its POST succeeds. */
    const chunks = [];
    let cur = { rows: [], ids: [] };
    for (const e of unsynced) {
      const row = toEventRow(e, s.user_id);
      if (row && cur.rows.length === 500) { chunks.push(cur); cur = { rows: [], ids: [] }; }
      if (row) cur.rows.push(row);
      cur.ids.push(e.id);
    }
    chunks.push(cur);
    for (const chunk of chunks) {
      if (chunk.rows.length) {
        if (syncOutlived(epoch)) return;
        const res = await fetch(SB_URL + "/rest/v1/events", {
          method: "POST",
          headers: {
            apikey: SB_KEY,
            Authorization: "Bearer " + s.access_token,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(chunk.rows),
        });
        if (!res.ok) return; // this chunk and the rest retry next time; the ones before are marked
      }
      /* This chunk landed (or was all local-only). Only a purge that reached
         the queue (or is reaching it now) makes these ids meaningless; a
         deletion merely started — which may yet fail remotely and leave the
         device as it is — does not. */
      if (dataDeletionInProgress || localClears !== clearsAtStart) return;
      await window.forayEventLog.markSynced(chunk.ids);
    }
    await window.forayEventLog.pruneToRetention(5000);
  } catch (_) { /* buffer persists, retry next time */ }
}

/* ---------- interests / topics ---------- */

function leafNodes() {
  return (state.taxonomy?.nodes || []).filter(n => n.parent !== null);
}

/* All taxonomy nodes, roots and leaves alike — the seeding/persistence set for
   interests (see loadInterests's header comment: `leafNodes()` used to be the
   seed set here too, which is the root-node bug this fixes). Kept distinct
   from leafNodes() because callers that mean "just the leaves" (none today,
   but the name invites it) must not silently start seeing roots. */
function taxonomyNodes() {
  return state.taxonomy?.nodes || [];
}

function nodeById(id) {
  return taxonomyNodes().find(n => n.id === id) || null;
}

/* Bug fix (kanban t_1cb3688a / docs/ui-transition-plan.md D6): this used to
   iterate leafNodes() only, so a declared interest in a ROOT node (e.g.
   `true-crime`) was never seeded into state.interests, and the very next
   saveInterests() call persisted an object that had silently dropped it —
   the listener's root-level pick vanished on reload with no error anywhere.
   Iterating every taxonomy node (roots AND leaves) is the whole fix;
   saveInterests() itself needed no change, since it always persisted
   whatever this function put into state.interests. */
function loadInterests() {
  const saved = lsGet("cp_interests", {});
  taxonomyNodes().forEach(n => {
    // An id this session already moved keeps the listener's own move — this
    // runs again when a late hydration lands (races-4).
    if (interestsSetThisSession.has(n.id)) return;
    state.interests[n.id] = saved[n.id] ?? Math.max(0, n.weight);
  });
}

/* The ids this session has actually set (a nudge, a slider, a reset, an
   onboarding lift). `saveInterests` may overwrite a STORED weight only for
   these (races-4): it used to write every id `loadInterests` had seeded, so a
   profile seeded from taxonomy defaults — because hydration had not landed
   within its bound — was written over the listener's learned weights on the
   first play. */
let interestsSetThisSession = new Set();

/** The one way an interest weight changes. */
function setInterest(id, value) {
  state.interests[id] = value;
  interestsSetThisSession.add(id);
}

/* Persist the profile WITHOUT ever shrinking it (2026-09-22 audit). This used
   to write `state.interests` whole, and `loadInterests` only seeds ids the
   loaded taxonomy names — so a `data/taxonomy.json` that 404'd or failed to
   parse (a partial deploy, a stale service-worker generation) left
   `state.interests` as `{}`, and the listener's first play or thumb wrote `{}`
   over their entire profile. The same write silently deleted any stored weight
   whose node a newer taxonomy had renamed or dropped.

   Two rules now: with no taxonomy loaded there is nothing this session could
   have learned, so nothing is written at all; and the write MERGES over what
   is stored, so an id this session does not know survives it. Nothing in the
   app removes an interest id on purpose — "Delete my data" clears the key
   through the store, not through here.

   And a third (round 2, races-4): a stored weight is replaced only by one this
   session SET (`interestsSetThisSession`); every other id is written only
   where the store has none. A seeded default can fill a gap, never overwrite
   what the listener taught it. The write itself waits for hydration, so
   "what the store has" is the durable profile and not an empty mirror. */
let saveInterestsPending = false;
function saveInterests() {
  if (!taxonomyNodes().length) return false;
  /* ONE waiter, however many nudges arrive before the store settles (audit
     round 2 review): each call pushed another closure, and the write they all
     make reads state.interests at settle time anyway. */
  if (storageWaiting()) {
    if (!saveInterestsPending) {
      saveInterestsPending = true;
      afterStorageSettles(() => { saveInterestsPending = false; saveInterests(); });
    }
    return true;
  }
  const stored = lsGet("cp_interests", {});
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const next = { ...base };
  for (const [id, v] of Object.entries(state.interests)) {
    if (typeof v !== "number") continue;
    if (interestsSetThisSession.has(id) || typeof base[id] !== "number") next[id] = v;
  }
  return lsSet("cp_interests", next);
}

/* How much of a leaf's own nudge also moves its parent root. Stated here per
   the card's ask ("state the ratio"): a play/thumb on a leaf is signal about
   the parent subject too, just weaker than a direct signal on the parent
   itself — half as much moves the root as moves the leaf that caused it. */
const PARENT_NUDGE_RATIO = 0.5;

/* Move a taxonomy node's weight. Clamped at BOTH ends since thumbs-down made
   the amount negative for the first time — an unclamped floor lets a few
   downvotes drive a node below zero, where it can never climb back into a menu
   however much the listener later plays of it.

   Propagates to the parent at PARENT_NUDGE_RATIO (D6, docs/ui-transition-plan.md):
   a nudge on a leaf is also weaker evidence about the root it belongs to, so
   the root moves too, just damped — HALF as much moves the root as moves any
   one leaf, by design, not "half per leaf." Propagation is therefore applied
   ONCE PER DISTINCT PARENT per call, no matter how many sibling leaves under
   that root the same call names (a multi-topic episode's `topics` array
   commonly does) — two sibling leaves must not compound into a full-strength
   nudge on their shared root. Roots have parent === null and so never
   propagate a second hop; a topic id that resolves to no taxonomy node (some
   legacy/decorative topics aren't taxonomy ids) simply moves itself, as
   before, with no parent step. A root named DIRECTLY in `topics` is excluded
   from propagation entirely (tracked via `directlyNudged`) — otherwise a
   topics array carrying both a leaf and its own parent root would move the
   root twice: once at the full amount for its own entry, once more from the
   leaf's propagation. */
function nudgeTopics(topics, amount) {
  const list = topics || [];
  const directlyNudged = new Set(list);
  const parentsToPropagate = new Set();
  list.forEach(t => {
    if (t in state.interests) {
      setInterest(t, Math.max(0, Math.min(1, state.interests[t] + amount)));
      const parent = nodeById(t)?.parent;
      if (parent && parent in state.interests && !directlyNudged.has(parent)) {
        parentsToPropagate.add(parent);
      }
    }
  });
  parentsToPropagate.forEach(parent => {
    setInterest(parent, Math.max(0, Math.min(1, state.interests[parent] + amount * PARENT_NUDGE_RATIO)));
  });
  saveInterests();
  /* Bumps the repeated-query cache key (see buildPlaylist's `searchCache`) so
     a playlist rebuild after a pick/play/thumbs nudge re-scores instead of
     silently serving a stale ranking. interestScore (used as
     searchWithRelaxation's zero-content-token rankFallback, e.g. a bare
     "comedy"/"something short" query) reads state.interests, so this is the
     one thing besides the query text and family-mode flag that can change
     what buildPlaylist should return for the exact same typed query. */
  state._interestsGen = (state._interestsGen || 0) + 1;
}

function boostTopics(topics, amount) { nudgeTopics(topics, amount); }

/* ---------- interests page (#/interests, U-07 / docs/ui-transition-plan.md D6) ----------

   Row set: every ROOT is always shown (so the listener always has something
   to set at the top level, even one they've never touched) — a root can
   ALSO independently qualify as diverged, but the "always" rule alone
   guarantees it's on the page. Additionally, any LEAF whose current weight
   has diverged from its taxonomy-authored default gets a row: exactly a
   listener override or an observed nudge (plays, thumbs, a prior slider
   drag). Rows are grouped by root: a leaf's group is its own parent id, a
   root is its own group.

   Range 0-1 (today's clamped model), NOT the old prototype's -1..1 — see the
   card: nudgeTopics clamps at zero, so a negative floor here would be a
   different design than the rest of the app already ships.

   No history feed, no evidence log (D6) — deliberately not built. */
function interestGroups() {
  const nodes = taxonomyNodes();
  const roots = nodes.filter(n => n.parent === null);
  const diverged = nodes.filter(n =>
    n.parent !== null && typeof state.interests[n.id] === "number" && state.interests[n.id] !== Math.max(0, n.weight)
  );
  const byRoot = new Map(roots.map(r => [r.id, { root: r, rows: [] }]));
  roots.forEach(r => byRoot.get(r.id).rows.push(r));
  diverged.forEach(n => {
    const g = byRoot.get(n.parent);
    if (g) g.rows.push(n);
  });
  // Stable, readable order: alphabetical by root label, leaves under a root
  // alphabetical by their own label, root row always first in its group.
  return [...byRoot.values()]
    .sort((a, b) => a.root.label.localeCompare(b.root.label))
    .map(g => ({
      root: g.root,
      rows: g.rows.sort((a, b) => (a.id === g.root.id ? -1 : b.id === g.root.id ? 1 : a.label.localeCompare(b.label))),
    }));
}

/* ---------- pool ---------- */

function episode(id) {
  const ep = state.session.episodes[id];
  if (!ep) return null;
  const v = state.validated?.episodes?.[id];
  return v ? {
    ...ep,
    apple_track_id: ep.apple_track_id ?? v.apple_track_id,
    artwork_url: v.artwork_url || ep.artwork_url || null,
    apple_episode_url: v.apple_episode_url || null,
  } : ep;
}

function snapshot(id, src) {
  const snap = {
    id, show: src.show, title: src.title,
    /* The show's own id, when the source knows it (a search result, a show-page
       row); null for the curated pool, which names shows by title only. Read by
       showNameLink so a breadth show's name links to its page (p-switcher-7). */
    show_id: src.show_id ?? null,
    apple_collection_id: src.apple_collection_id,
    apple_track_id: src.apple_track_id ?? null,
    apple_episode_url: src.apple_episode_url ?? null,
    duration_min: src.duration_min ?? null,
    artwork_url: src.artwork_url ?? null,
    topics: src.topics || [],
    // Where `topics` came from ("episode" = its own label, "show" = inherited
    // from its show; tools/refresh/merge.mjs, catalogue-personalization PKG-01).
    // Kept so a generated playlist can refuse an item whose only claim to a
    // leaf is a general show's label (PKG-04, leafPlaylistItems). null for a
    // source without it — session.json's curated episodes have none, and are
    // kept as their own labels.
    topics_source: src.topics_source ?? null,
    hook: src.hook || src.summary || src.title,
    // Audio provenance (#21) + DAI flag (#22). This projection is a whitelist,
    // so anything not named here is dropped — which is exactly how in-app
    // playback shipped invisible: every card item lost audio_url on the way
    // through, so playBtn() rendered nothing on all four cards.
    audio_url: src.audio_url ?? null,
    audio_type: src.audio_type ?? null,
    audio_bytes: src.audio_bytes ?? null,
    duration_sec: src.duration_sec ?? null,
    dai_suspected: src.dai_suspected ?? false,
    // Explicit-content flag (kanban card t_02c6bb0b): already ingested at the
    // source (tools/refresh/merge.mjs), but this whitelist projection dropped
    // it on the floor before the badge existed to read it — every pool item
    // (the vast majority of what epRow/renderEpisode actually render) would
    // otherwise silently lose the flag here, one snapshot() call after the
    // caller thought it kept it.
    explicit: src.explicit ?? null,
    // Publish date (requirement A1.2, kanban t_d5079285): present on 100% of
    // the curated pool (discover.json's own `release_date`) but this
    // whitelist projection dropped it the same way it dropped audio_url
    // above — every epRow/archivedRow/renderEpisode caller has always had
    // the raw field one layer up and never seen it here. Also kept so a
    // generated playlist (F14) can order a leaf's episodes newest first
    // from the snapshot alone; null when the source has none.
    release_date: src.release_date ?? null,
    // Full publisher description (requirement A1.1/Q8, resolved by Stage 3b:
    // RSS-sourced text is the real source, docs/show-pages-plan.md). Additive
    // to `hook` above, which stays 4a's own curated one-line editorial voice
    // — this is the publisher's own words, never a replacement for it.
    // Absent (null) for curated-pool items, which only ever had a `hook`.
    description: src.description ?? null,
    // Chapter markers (requirement A1.5, Joey's Q5: "these are two different
    // use cases" from foray segments — rendered as a wholly separate section,
    // never merged into the segment-strip UI). Stage 3b's ingestion pass
    // stores this lazily (null until a per-episode chapters-body fetch backs
    // it, see backend/src/catalog/showEpisodesStore.ts) — absence here is a
    // real, expected state, not a bug.
    chapters: src.chapters ?? null,
  };
  state.itemIndex[id] = snap;
  return snap;
}

/* `state.poolIds` is the ONLY answer to "is this episode in the catalogue right
   now", and it exists because `state.itemIndex` was being used for that and is
   not it (#276 review). `itemIndex` is a snapshot CACHE: it is session-lived,
   nothing ever clears it, and several callers write to it — fullPool, the
   pick handler's `liveEpisode` snapshot, the show/search pages, and
   renderPlaylistDetail seeding a part the pool no longer has. So
   "has an entry in itemIndex" drifts to "was mentioned at some point this
   session", which made an aged-out playlist part read as live from its second
   render onward and silently restored the exact defect #276 removes. Membership
   is rebuilt from scratch on every pool build, so it cannot accumulate. */
/* MEMOISED ON THE TWO DOCUMENTS IT READS (audit round 2, perf-10). Seventeen
   call sites rebuild this — every Up Next reorder tap re-snapshotted the whole
   2,000-item discover pool before repainting a five-row list. The pool is the
   same until `state.session` or `state.discover` is replaced (init and the
   refresh path assign whole documents; nothing pushes into `items`), and the
   `itemIndex` writes `snapshot()` makes are idempotent for the same input, so a
   cached answer is the same answer. `state.poolIds` is rebuilt with the pool,
   so the #276 property (membership never accumulates) holds: a new document is
   a new Set. The cache returns a COPY so a caller that sorts or splices the
   array (poolFiltered's callers do) cannot corrupt the next caller's. */
let poolCache = null;
function fullPool() {
  const session = state.session;
  const discover = state.discover;
  if (poolCache && poolCache.session === session && poolCache.discover === discover
      && poolCache.itemCount === (discover?.items || []).length) {
    state.poolIds = poolCache.poolIds;
    return poolCache.pool.slice();
  }
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(session.episodes)) {
    pool.push(snapshot(id, episode(id)));
    seen.add(id);
  }
  for (const item of (discover?.items || [])) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    pool.push(snapshot(item.id, item));
  }
  state.poolIds = seen;
  poolCache = { session, discover, itemCount: (discover?.items || []).length, pool, poolIds: seen };
  return pool.slice();
}

/* In-app play button. An item with no audio_url gets NO button — there is no
   link-out to another podcast app any more (#21 leaves ~9 unresolvable, plus
   video-only items; the card itself stays a link either way). The "Open in"
   setting that chose that app, and the two link builders it fed, were deleted
   together on 2026-09-22: nothing had called either builder since the link-out
   went, so the switch persisted a value nothing read (design/QA audit).

   `ctx`, when given, is stamped on as `data-ctx` — the same "playlist-<id>"
   / "subject-<id>" / "generated-<id>" convention bindPickLogging already
   reads off a picked link's `data-ctx` (#558 item 2). It is optional and
   omitted by every non-playlist caller, so this changes nothing for them.

   `data-title` is there for the repaint, not the first paint: the player's
   `syncCardButtons` flips this button to ❚❚ while its episode plays, and has to
   rename it "Pause <title>" in the same write (theme D, above setControlLabel) —
   it did not, so a playing card announced "Play …" and a voice-control user
   saying "Play" paused it. The title a row was built with is the only one the
   repaint can trust; the player's `current` is a different episode on every
   other row. */
function playBtn(item, ctx) {
  if (!item || !item.audio_url) return "";
  return `<button class="play-btn" data-play="${esc(item.id)}"${ctx ? ` data-ctx="${esc(ctx)}"` : ""} data-title="${esc(item.title || "")}"${controlLabelAttr("▶", `Play ${item.title || "this episode"}`)}>▶</button>`;
}

/* Family mode (corner-case 28): hide explicit-rated episodes and the comedy
   branch (older comedy items predate per-episode ratings). */
function familyMode() { return lsGet("cp_family", false); }

/* ---------- U-02: the ui-v2 flag (docs/ui-transition-plan.md) ----------

   cp_ui_v2 gates the whole v2 surface (tab bar, and every screen U-03+
   restyles): default OFF on the web, default ON for a native-shell build so
   the app the founders actually carry shows the new look without a manual
   toggle. There is no separate "TestFlight vs production" signal today
   (R-01 stopped shipping PR builds to TestFlight, but there is no
   store-production build yet either) -- isNativeShell() below duplicates
   shouldRegisterServiceWorker's Capacitor detection (further down this
   file) rather than sharing it, because that function answers a different
   question (should the SW register) with an inverted return and this one
   must be callable before that function's own definition site in source
   order is guaranteed relevant. When a real production channel exists this
   default should be revisited; until then "native shell" and "TestFlight"
   are the same population. */
function isNativeShell(win = window) {
  try {
    const proto = (win && win.location && win.location.protocol) || "";
    if (proto === "capacitor:" || proto === "ionic:") return true;
  } catch (_) { /* no location: not the shell */ }
  try {
    const cap = win && win.Capacitor;
    if (cap) {
      if (typeof cap.isNativePlatform === "function") return !!cap.isNativePlatform();
      if (cap.isNative) return true;
    }
  } catch (_) { /* a throwing bridge is not a "yes" */ }
  return false;
}

/** CUTOVER (U-11, founder override 2026-09-06 — see STATE.md and
    docs/ui-transition-plan.md §U-11): ui-v2 is now the only UI. The
    cp_ui_v2 flag, its localStorage override, the native-shell fallback and
    the Settings entry that flipped it are retired. The pre-cutover
    implementation (flag, toggle, old Home/menu-nav screens) is preserved
    intact in archive/legacy-ui-2026-09/ for recovery — see that directory's
    README for exact restore steps.

    `ui2On()` SURVIVED THE CUTOVER AS `return true` and four call sites went on
    branching on it, which is worse than either answer: a reader has to prove
    the constant to know the branch is dead, and the dead half is where a
    v1-shaped bug hides (finding 7, client audit 2026-09-12). The function, its
    branches, `bindUi2Control()` — which removed an element nothing created —
    and the drawer label for a switch that no longer exists are all gone. The
    `ui-v2` CLASS stays: it is what styles.css hangs the whole v2 sheet on.

    Every page-render function replaces document.body.className wholesale (see
    renderHome/renderShow/etc.), which would otherwise silently drop `ui-v2` on
    every single navigation. Route every one of those assignments through this
    instead of writing document.body.className directly. */

/* CLASSES THAT OUTLIVE A RENDER, and why a wholesale write needed an
   allowlist (founder report 2026-09-14: "when I scroll, the search text box
   moves a bunch"; and two bugs he had not reported yet, both diagnosed from
   this same line).

   `ui-v2` was not the only class on <body> that a page render must not
   destroy. Four more are written by things whose lifetime has nothing to do
   with the current page, and every one of them was being silently wiped by
   the wholesale assignment below, with nothing to put it back:

     kb-open       installKeyboardChrome, from the soft keyboard's own
                   viewport events. THE ONE THAT MATTERS HERE.
     fp-open       the mini-player, for as long as something is playing.
     fp-expanded   the Now Playing sheet, for as long as it is open.
     fy-sheet-open the modal sheets, for as long as one is open — now DERIVED
                   from the sheet owner rather than carried (see below).

   WHY kb-open IS THE INTERESTING ONE. installKeyboardChrome writes TWO
   things from one evaluation: this class on <body>, and `--kb-inset` on
   <html>. Its own comment claims they "can never disagree" because they come
   from the same `apply()`. They can, and the reason is entirely here: only
   ONE of the two lives on the element this function overwrites. A render
   with the keyboard up dropped `kb-open` and kept `--kb-inset`, and
   `#sh-compose`'s `bottom: calc(var(--kb-inset) + var(--sh-dock))` then
   composed a keyboard-open inset with the keyboard-SHUT dock. (Since the Dock,
   #sh-compose is the Dock's field row and the Dock's own `bottom` carries
   `--kb-inset` - ui/dock.css; `--sh-dock` is gone. The survival argument is
   unchanged: a class that is dropped while the inset survives still disagrees.)

   MEASURED, not reasoned (test/playwright/tests/search-chrome-dock.spec.js,
   Chromium at 390x844 with the keyboard-open state and something playing):
   the pill moved 56px across a single render, and 0px after this change.
   56px is the tab bar's height and nothing else, because Chromium reports a
   zero `env(safe-area-inset-bottom)` and because the same wholesale write
   also dropped `fp-open`, so the mini bar's term left the dock at the same
   moment — two errors partially cancelling in the one place they happen to
   be measured. On a notched iPhone the same arithmetic adds the ~34pt home
   indicator. The cancellation is not a consolation: dropping `fp-open` is
   itself the second, unreported bug — `body.fp-open`'s content reservation
   goes with it, so after navigating while something plays the now-playing
   bar covers the page's last row.

   WHAT IS DELIBERATELY NOT ON THIS LIST. `sh-compose` and `sh-searching` are
   set by the search page for the search page, and being wiped on navigation
   is precisely how they are cleaned up (see renderAllShows, which re-adds
   `sh-compose` after its own render for exactly that reason). An allowlist
   that "helpfully" preserved them would leave the compose bar's content
   reservation on every other screen in the app. The test for membership is
   not "is this class important" but "does this class describe something that
   is still true after the page underneath it changed". */
const PERSISTENT_BODY_CLASSES = ["kb-open", "fp-open", "fp-expanded"];

/* `fy-sheet-open` LEFT THIS LIST (audit 2026-09-22). Carrying it forward
   because it was THERE is how a back gesture over the Foray feedback sheet —
   which lives inside #view and dies with the render — left `overflow: hidden`
   on <body> with no sheet on screen. The modal lock is now a function of the
   sheet owner's stack (`sheetBodyClasses()`, which first drops any sheet whose
   element has left the document): a render keeps it exactly while a sheet is
   actually open. */
function setBodyClass(base) {
  const body = document.body;
  const kept = PERSISTENT_BODY_CLASSES.filter((c) => body.classList.contains(c));
  const modal = typeof sheetBodyClasses === "function" ? sheetBodyClasses() : [];
  body.className = [...new Set([base, "ui-v2", ...kept, ...modal])].join(" ");
  /* A page that lit the ROOT's Glow (the Episode page and the Foray detail write it so the Dock and the Veil share the Room's
     light) must not leave it behind: the next page, and every sheet over it, reads the scheme's own Glow again. The page that
     wants one writes it AFTER it calls this, so clearing here costs it nothing. */
  try {
    const root = document.documentElement;
    if (root && root.style && typeof root.style.removeProperty === "function") root.style.removeProperty("--glow");
  } catch (_) { /* a stub document */ }
}

/* ---------- loading / failed / empty: ONE convention (audit theme G, 2026-09-22) ----------

   The audit found the same defect at ten sites: something still loading and
   something that failed to load were both painted as a FACT about 4a — "0
   forays", "No shows here yet.", `No results for "x".`, "7 episodes" over zero
   rows. Every one of those pages knew, or could have known, which of three
   states it was in, and threw the distinction away at the paint.

   THE RULE, which every list painter now follows:

     loading — say it is loading, and claim nothing: no count, no "no results",
               no empty-state sentence. A count is painted only once the source
               that produces its rows has answered, and from those same rows.
     failed  — say it failed, in plain words, and offer "Try again" wired to
               the SAME fetch that failed. Never an empty-state claim.
     empty   — only when the source answered and the answer was "nothing".

   These helpers are the shared half: the failed line with its button, and the
   status page a route paints when it has nothing but a status to show. The
   status page always carries a real page head with ‹ — a not-found or loading
   page with no way back was a dead end reachable from any stale link, which is
   the argument `renderPlaylistDetail`'s not-found branch already wrote down and
   two sibling routes never applied.

   `note` is NOT escaped: every caller passes a literal written in this file (the
   same footing `BODY_PLACEHOLDER` in renderShow is on, and for the same reason —
   escaping a constant turns the apostrophe in "Couldn't" into `&#39;`). `title`
   can come from data, so it is. */
const RETRY_LABEL = "Try again";

/* THE ONE WAY A LISTENER'S OWN WORDS ARE QUOTED BACK (audit round 2, copy-8).
   The Create CTA used typographic quotes and every other quoted query used
   straight ones, and the two met on the empty-search screen. Apple's pair.
   Takes the text as the caller has it — already escaped when it is going into
   innerHTML, raw when it is going into textContent — and adds only the quotes. */
function quoteQuery(text) {
  return `\u201c${text}\u201d`;
}

function failedNoteHtml(note) {
  return `<div class="load-failed" role="status">
    <p class="note">${note}</p>
    <button type="button" class="fy-btn load-retry" data-retry>${RETRY_LABEL}</button>
  </div>`;
}

/* THE ONE FAILURE A RETRY CANNOT FIX (audit round 2, states-6). When
   `player/client.js` itself did not load — a 404 on a stale generation, a parse
   error, a blocked script — "Try again" re-awaits a module event that will
   never fire: five seconds of "Loading…" and the same message, for good. The
   remedy for a broken shell is a fresh document, so that failure offers a
   button that reloads rather than one that waits. A BUTTON, not the "reload
   the page" advice the 2026-09-22 audit removed: the advice named a page the
   native shell's listener cannot see; `location.reload()` reloads the shell's
   own document just the same. */
const RELOAD_LABEL = "Reload 4a";

function reloadNoteHtml(note) {
  return `<div class="load-failed" role="status">
    <p class="note">${note}</p>
    <button type="button" class="fy-btn load-retry" data-reload>${RELOAD_LABEL}</button>
  </div>`;
}

function statusPageHtml({ title = "", note, back = "#/", retry = false, reload = false }) {
  /* `back` is always one of our own routes; the "#" is written in the literal so
     no interpolated value can ever start an href (test/app-security.test.js). */
  const route = String(back).replace(/^#/, "");
  return `<div class="page">
    <div class="page-head">
      <a class="back" href="#${esc(route)}">‹</a>
      <div>${title ? `<h2>${esc(title)}</h2>` : ""}</div>
    </div>
    ${reload ? reloadNoteHtml(note) : retry ? failedNoteHtml(note) : `<p class="note">${note}</p>`}
  </div>`;
}

/** Wire the Reload button under `scope` to a fresh document. */
function bindReload(scope) {
  const btn = scope && typeof scope.querySelector === "function" ? scope.querySelector("[data-reload]") : null;
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    location.reload();
  }, { once: true });
}

/** Wire the Retry button under `scope` to `run` — the same function that
    failed, never a parallel "reload" path. Once: the retry repaints the region,
    and a second press on a button that is about to be replaced would run the
    fetch twice. */
function bindRetry(scope, run) {
  const btn = scope && typeof scope.querySelector === "function" ? scope.querySelector("[data-retry]") : null;
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    run();
  }, { once: true });
}

function poolFiltered() {
  const pool = fullPool();
  if (!familyMode()) return pool;
  return pool.filter(familySafe);
}

/* FAMILY MODE FAILS CLOSED (audit round 3, data-integrity-4; founder Q1,
   default ruling pending his word). The filter hid only `explicit === true`,
   and 516 of the pool's 2,167 episodes carry no `explicit` at all -- 157 of
   them outside comedy, from shows with explicit-rated episodes beside them
   (Lex Fridman, Ancient History Fangirl, 20VC...), plus every one of
   session.json's. The rule now, in this one predicate:
     - explicit === true            -> hidden (as before)
     - comedy                       -> hidden (as before: older items predate ratings)
     - explicit === false           -> shown
     - no rating on the episode     -> the SHOW's catalogue rating decides: shown
                                       only when catalog.json rates the show clean,
                                       hidden when it is rated explicit or unrated.
   And every list goes through it, not only the pool: the show page's curated
   and full-catalogue lists, "More from this show", and Library. The backfill of
   the 516 from the refresh pipeline's contentAdvisoryRating is a separate data
   PR; this does not wait for it. test/boot-path.test.js pins that nothing
   unrated gets through unless its show is rated clean.

   A SHOW'S "CLEAN" IS TRUSTED ONLY WHEN ITS OWN EPISODES AGREE (round-3 review,
   L1). DECISIONS.md 2026-07-09 records show-level flags as unreliable, and the
   data agrees: catalog-client.json rates Call Her Daddy, KILL TONY, Bad
   Friends, Ancient History Fangirl and 20VC clean, and 73 of the 196 shows
   rated clean have explicit-rated episodes in the pool. So an unrated episode
   inherits "clean" only from a show none of whose pool episodes is rated
   explicit. And a row that carries no topics (the show page's full-catalogue
   rows are built with `topics: []`, so branchOf says "other") takes its branch
   from the show's taxonomy_node_ids: a comedy show's back catalogue stays out,
   as comedy always has. */
function familySafe(item) {
  if (!item || typeof item !== "object") return false;
  if (item.explicit === true) return false;
  if (branchOf(item) === "comedy") return false;
  const show = catalogShowForItem(item);
  if (!(Array.isArray(item.topics) && item.topics.length) && showIsComedy(show)) return false;
  if (item.explicit === false) return true;
  return Boolean(show && show.explicit === false && !showHasExplicitEpisodes(show));
}

/** The catalogue show is filed under comedy (its taxonomy nodes). */
function showIsComedy(show) {
  const nodes = show && Array.isArray(show.taxonomy_node_ids) ? show.taxonomy_node_ids : [];
  return nodes.some((n) => typeof n === "string" && n.split("/")[0] === "comedy");
}

/* The catalogue shows at least one of whose pool episodes is rated explicit.
   Rebuilt only when the documents it reads change (the same key fullPool's own
   cache uses, plus the catalogue): fullPool hands back a fresh copy on every
   call, so its identity cannot be the key, and this runs once per row. */
let explicitShowsIndex = null;
function showHasExplicitEpisodes(show) {
  if (!show) return false;
  const session = state.session;
  const discover = state.discover;
  const shows = state.catalog?.shows;
  const itemCount = (discover?.items || []).length;
  const idx = explicitShowsIndex;
  if (!idx || idx.session !== session || idx.discover !== discover || idx.itemCount !== itemCount || idx.shows !== shows) {
    let pool;
    try { pool = session ? fullPool() : (discover?.items || []); } catch (_) { pool = discover?.items || []; }
    const set = new Set();
    for (const it of pool) {
      if (!it || it.explicit !== true) continue;
      const s = catalogShowForItem(it);
      if (s) set.add(s);
    }
    explicitShowsIndex = { session, discover, itemCount, shows, set };
  }
  return explicitShowsIndex.set.has(show);
}

/** Family Mode's answer for one row: everything when it is off. */
function familyAllows(item) {
  return !familyMode() || familySafe(item);
}

/* The catalogue record an episode belongs to: by show_id when it carries one,
   else by title (and the one alias), the join episodesForShow uses. Indexed
   once per loaded catalogue. */
let catalogShowIndex = null;
function catalogShowForItem(item) {
  const shows = state.catalog?.shows;
  if (!Array.isArray(shows)) return null;
  if (!catalogShowIndex || catalogShowIndex.shows !== shows) {
    const byId = new Map(), byTitle = new Map();
    for (const s of shows) {
      if (!s) continue;
      if (s.show_id) byId.set(s.show_id, s);
      if (s.title) byTitle.set(s.title, s);
    }
    for (const [title, alias] of Object.entries(TITLE_ALIASES)) {
      if (byTitle.has(title) && !byTitle.has(alias)) byTitle.set(alias, byTitle.get(title));
    }
    catalogShowIndex = { shows, byId, byTitle };
  }
  return (item.show_id && catalogShowIndex.byId.get(item.show_id))
    || (item.show && catalogShowIndex.byTitle.get(item.show))
    || null;
}

/* The visible half of the same flag Family Mode has quietly filtered on since
   corner-case 28 (kanban card t_02c6bb0b): every mainstream podcast app shows
   an "E" next to explicit content, and 4a never did, even though the
   publisher's <itunes:explicit> flag was captured all along. Additive only —
   Family Mode's `i.explicit !== true` filter above is untouched, this just
   makes the same field visible when Family Mode is off. Strict `=== true`
   because the field is tri-state (true/false/null) at both the episode and
   show level; false and null both mean "no badge", not "unknown = flag it".

   `role="img"`, because `aria-label` on a bare <span> is ignored by most
   screen readers (ARIA forbids it on the generic role), so VoiceOver read the
   badge as "E" (audit round 2, a11y-11). No `title=`: a tooltip a phone never
   shows is not an explanation, and the label already says the word. */
const FAMILY_HIDES_NOTE = "Family mode is on, so this show's episodes are hidden.";

function explicitBadge(isExplicit) {
  return isExplicit === true ? `<span class="explicit-badge" role="img" aria-label="Explicit">E</span>` : "";
}

/** The heading's text as a NAME — the explicit badge's "E" is not part of it
    (audit round 2, nav-7: the tab read "Some EpisodeE · 4a" and the arrival
    announcement said the same). The badge is always rendered directly after
    the title, so its text is stripped from the end; a heading with no badge
    is returned as it is. */
function headingName(head) {
  let text = String(head.textContent || "");
  const badges = typeof head.querySelectorAll === "function" ? head.querySelectorAll(".explicit-badge") : [];
  for (const b of badges) {
    const t = String(b.textContent || "");
    if (t && text.endsWith(t)) text = text.slice(0, -t.length);
  }
  return text.replace(/\s+/g, " ").trim();
}

/* THE FOUR LISTENER-FACING FORMATTERS (audit 2026-09-22, theme C). Each of these
   existed once, correctly, at the call site that first hurt, and the other call
   sites went on doing it by hand: an exact hour read "1h 0m", a one-episode
   playlist read "1 parts" on three screens and "1 part" on a fourth, a row with
   no duration read "Show ·  · date", and the Playlists page printed a raw
   `toLocaleDateString()` that can say "Invalid Date". Every count, duration,
   subtitle and date a listener reads goes through one of these now, and
   test/format-helpers.test.js holds the rule, not a list of the sites. */

/* ONE DURATION DIALECT (audit round 2, copy-2): "45 min", "1 hr", "1 hr 5 min"
   — the words Apple Podcasts uses, and the same words the player's own
   `fmtSpan` and both "left" labels use, so one row never reads "3h 5m" beside
   "185 min left". "1 hr" for an exact hour, never "1 hr 0 min" (49 episodes
   of the shipped pool are whole hours, and a subject card's summed runtime
   lands on one often). The colon clock (`fmtClock`) is for live playheads and
   scrubbers only. Whole minutes: a fraction is rounded, not printed. */
function fmtDur(min) {
  if (!min) return "";
  const n = Math.round(Number(min));
  if (!(n > 0)) return "";
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** ONE SOURCE FOR AN EPISODE'S LENGTH (audit round 2, honesty-1). The catalogue
    carries two: `duration_min`, often Apple's rounded listing length, and
    `duration_sec`, the seconds the player's clock and every "left" label count
    against. For 19 shipped items they disagreed by a minute or more (one row
    read "45 min · 53 min left", because the progress label on the same line
    counts against duration_sec). The seconds win whenever they are known; the
    minute count is the fallback for an item that has none (an archived
    playlist part keeps no duration_sec). tools/check-durations.mjs gates the
    data so the two cannot drift by a minute again. */
function episodeMinutes(item) {
  const sec = Number(item?.duration_sec);
  if (sec > 0) return Math.round(sec / 60);
  const min = Number(item?.duration_min);
  return min > 0 ? min : 0;
}

/* "1 episode", "2 episodes" — the one plural. `many` is for the irregular
   ones ("match" -> "matches"). Numbers only: a caller with a string count has
   a bug upstream this must not paper over. */
function countLabel(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

/* A playlist's length, on every surface that shows one. The noun is "episode"
   because that is what a listener put in it and what the detail page already
   said; "part" is the word a Foray's sections use (docs/audit/persona-synthesis.md
   §2), and a playlist being "12 parts" on one screen and "12 episodes" on the
   next was the same list described two ways. */
function playlistLengthLabel(p) {
  return countLabel(resolveParts(p).length, "episode");
}

/* The " · " joiner for a row's second line. Empty pieces are dropped rather than
   left between two separators — a feed with no duration was "Show ·  · Sep 12",
   and one with no date either ended "Show · ". Pieces arrive already escaped
   (a show name is often a link), so this only joins; it never escapes. */
function joinMeta(...pieces) {
  return pieces.filter(Boolean).join(" · ");
}

/* "played Sep 21, 2026", or nothing. A corrupt `last_played_at` (the store is
   hand-editable localStorage) says nothing rather than "played Invalid Date". */
function playedOnLabel(at) {
  const d = fmtDate(at, { local: true });
  return d ? `played ${d}` : "";
}

/* A1.2: episode publish date, plain-English formatting shared by epRow,
   archivedRow, and renderEpisode. Returns "" (never "Invalid Date") for a
   missing or unparseable value — absence is a real state, not an error,
   matching every other formatter on this page.

   Formats in UTC deliberately: both source shapes this ever sees are
   effectively date-only — discover.json's `release_date` (a bare
   YYYY-MM-DD) and Stage 3b's `published_at` (typically UTC-midnight
   ISO). Formatting in the *runtime's local* timezone (the previous
   version's bug) rolls a UTC-midnight timestamp back to the previous
   calendar day for anyone west of UTC — most of the Americas — showing
   a wrong publish date for a large share of the real user base. UTC is
   the one timezone every visitor and every CI runner agrees on.

   `{ local: true }` is for an INSTANT rather than a calendar date — "played
   <date>" is when this listener pressed play, which is a local-day fact; the
   UTC rule above would move an evening play to tomorrow for everyone east of
   UTC. Same guard, same shape, only the timezone differs.

   THE YEAR IS SAID ONLY WHEN IT IS NOT THIS ONE (audit round 2, copy-15):
   "Sep 12" for an episode released this year, "Nov 3, 2025" for an older
   one — Apple Podcasts' rule, and on a phone the spare ", 2026" was what
   pushed a row's progress label onto a second line. "This year" is judged in
   the same zone the date is written in (UTC for a release date, local for a
   played-on instant), so a New Year's Eve release never reads as next year.
   `now` is a parameter so the rule can be tested against a fixed clock. */
function fmtDate(dateStr, { local = false, now = new Date() } = {}) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const thisYear = local ? d.getFullYear() === now.getFullYear() : d.getUTCFullYear() === now.getUTCFullYear();
  const opts = { month: "short", day: "numeric" };
  if (!thisYear) opts.year = "numeric";
  if (!local) opts.timeZone = "UTC";
  return d.toLocaleDateString("en-US", opts);
}

function branchOf(item) {
  const t = item.topics?.[0] || "";
  return t.split("/")[0] || "other";
}

function interestScore(item) {
  const ts = item.topics || [];
  if (!ts.length) return 0.5;
  const vals = ts.map(t => state.interests[t] ?? 0.5);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/* ---------- a control's words: what it shows and what it is called ----------

   THE RULE (audit 2026-09-22, theme D): a control whose visible text changes has
   its accessible name written by the SAME call, because `aria-label` REPLACES a
   button's text for a screen reader. Seven controls broke this the same way —
   the name was set once at build time and the text changed underneath it: the
   show star said "★ Starred" and announced "Star show", every play button said
   ❚❚ and announced "Play …", the Foray's main button said "Loading…" and
   announced "Play". Each was a correct label, written once, and never kept.

   So text and name go through `setControlLabel` together, a two-state control
   through `setToggleLabel`, and an HTML builder through `controlLabelAttr` from
   the same spec — never a hand-written `aria-label="…"` beside a ternary.
   test/toggle-labels.test.js holds the rule for the whole file: a control's
   text may only change through here.

   `label` is dropped (not duplicated) when it equals the text, so a plain-text
   button keeps speaking its own words. player/client.js carries its own
   `paintControl` for the same rule: it is an ES module that must run in its
   test harness without this file, and this file must run without it. */
function setControlLabel(btn, text, label) {
  if (!btn) return;
  if (text != null && btn.textContent !== text) btn.textContent = text;
  if (label && label !== text) btn.setAttribute("aria-label", label);
  else btn.removeAttribute("aria-label");
}

/** A status line's text, written only when it changes. An aria-live region
    announces every write, and several of these are painted from a 4 Hz tick. */
function setStatusText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setToggleLabel(btn, on, spec) {
  setControlLabel(btn, on ? spec.onText : spec.offText, on ? spec.onLabel : spec.offLabel);
}

/** The build-time half of setToggleLabel: the text, and the attribute that
    names it, from one spec — so the first paint and every repaint agree. */
function controlLabelAttr(text, label) {
  return label && label !== text ? ` aria-label="${esc(label)}"` : "";
}
function toggleMarkup(on, spec) {
  const text = on ? spec.onText : spec.offText;
  return { text: esc(text), attr: controlLabelAttr(text, on ? spec.onLabel : spec.offLabel) };
}

/* The listener's words for the two "keep this" actions (docs/audit/persona-synthesis.md
   §2, and the Apple vocabulary the founder asked for): an EPISODE is Saved, a
   SHOW is Followed. They used to be "Save" (never the state), "Star show" /
   "Unstar show", "★ Starred" and a page headed "Starred Shows" — three words
   for two ideas. Storage keys (`cp_saved`, `cp_starred_shows`) are unchanged. */
const SAVE_TOGGLE = { offText: "☆", onText: "★", offLabel: "Save episode", onLabel: "Saved" };
/* Redesign 2026 (ambient, show page): the words are "Follow" and "Following", and the state is a
   FILL change as well as a word: the Regular `i-plus` becomes the Fill `i-check-circle-fill`
   (BUILD-NOTES 4.x, "toggle fills"), so the toggle never rests on colour alone. The old
   "+ Follow" / "✓ Followed" pair put a text glyph where the icon now is. */
const FOLLOW_TOGGLE = { offText: "Follow", onText: "Following", offLabel: "Follow", onLabel: "Following" };
/* WHAT FOLLOWING DOES NOT DO, said where the tap happens (review 2026-09-23).
   Apple's Follow delivers new episodes; 4a's is a bookmark (no feed, no
   notifications, nothing added anywhere — CLAUDE.md principle 2), and the audit
   verdict warned a switcher would wait for episodes that never come. The line
   used to live only on #/starred-shows, a page the tap never shows. Whether the
   word stays "Follow" is a founder noun ruling still open (docs/audit/
   qa-synthesis.md); this line is right under either word.
   SAID AS WHAT FOLLOW IS, NOT AS WHAT IS MISSING (audit round 2, copy-14):
   "4a doesn't add its new episodes anywhere" read like a bug report. The
   meaning is unchanged — no feed, nothing queued — and stated the way round
   a listener can use. */
const FOLLOW_NOTE = "Following keeps a show one tap away in your Library. New episodes stay on the show's page; nothing is queued for you.";
const UP_NEXT_TOGGLE = { offText: "+ Up Next", onText: "✓ Up Next", offLabel: "Add to Up Next", onLabel: "In Up Next" };
/* Keeping a playlist 4a made (founder, 2026-09-25: "we should add a feature to
   save playlists"). Once saved the control reads "Saved" and is a state, not an
   action: "Open your copy" is a separate link beside it. See savePlaylistCopy. */
const SAVE_PLAYLIST_TOGGLE = { offText: "Save to my playlists", onText: "✓ Saved", offLabel: "Save to my playlists", onLabel: "Saved to your playlists" };

/* ---------- stars ---------- */

function savedMap() { return plainObject(storedValue("cp_saved", {})); }
function isSaved(id) { return id in savedMap(); }

function toggleStar(id) {
  const had = Boolean(savedMap()[id]);
  let entry = null;
  if (!had) {
    const snap = state.itemIndex[id];
    if (!snap) return;
    /* TRIMMED LIKE EVERY OTHER STORED SNAPSHOT (app-1-8): `{ ...snap }` kept
       a breadth episode's whole publisher description twice (as `hook` and
       as `description`) plus its chapters, so a heavy Saved list reached
       hundreds of KB of the localStorage mirror's 5 MB. */
    entry = savableEpisode({ ...snap, saved_at: new Date().toISOString() });
  }
  /* An edit, not a write (app-1-1): before storage settles it waits and is
     replayed over the durable Saved list. Every entry is brought to the
     trimmed shape as it passes (app-1-8), so an old untrimmed list shrinks on
     the next star. */
  const ok = editStored("cp_saved", {}, (m) => {
    const out = plainObject(m);
    for (const k of Object.keys(out)) out[k] = savableEpisode(out[k]);
    if (had) delete out[id]; else out[id] = entry;
    return out;
  });
  /* A REFUSED WRITE LEAVES THE STAR AS IT WAS (app-1-8): lsSet's answer used
     to be ignored, so a full store showed a star that the next reload lost.
     The buttons below repaint from storage, so they show what was kept; the
     save is logged and nudges interests only once it is. */
  if (ok) {
    if (had) {
      logEvent("unsaved", { episode_id: id });
    } else {
      boostTopics(entry.topics, 0.05);
      logEvent("saved", { episode_id: id, topics: entry.topics });
    }
  }
  /* The Now Playing sheet's Save reads `EPISODE_NAVIGATION.isSaved`; a star
     pressed on a row while the sheet is open has to reach it too — AFTER the
     write (audit round 2 review): the sheet paints synchronously from storage,
     and refreshed first it painted the pre-toggle state, which stayed wrong
     while paused (no render ticks to correct it). */
  refreshEpisodeNavigation();
  document.querySelectorAll(`[data-star="${CSS.escape(id)}"]`).forEach(b => {
    setToggleLabel(b, isSaved(id), SAVE_TOGGLE);
    b.classList.toggle("on", isSaved(id));
  });
}

/* `data-star` goes through esc() like every other interpolation (CLAUDE.md
   § Conventions). It did not, and #276 is what made that reachable from STORAGE
   rather than only from a fresh fetch: a playlist part's id is persisted in
   `cp_playlists` and replayed into this attribute on every visit, so a feed value
   that once broke out would keep breaking out. Escaping does not affect
   toggleStar's `[data-star="…"]` lookup — the browser decodes the entity back to
   the raw id before the selector ever sees it. */
function starBtn(id) {
  const on = isSaved(id);
  const { text, attr } = toggleMarkup(on, SAVE_TOGGLE);
  return `<button class="star ${on ? "on" : ""}" data-star="${esc(id)}"${attr}>${text}</button>`;
}

/* "+ Up Next" row control (docs/listening-queue-plan.md Stage 1, plan §1 Q3).
   Additive to the row — sits beside starBtn/playBtn, never replaces either.
   Label is always "Up Next" (never bare "queue"), per plan §3. Once added the
   control shows a plain "in Up Next" state rather than disappearing, mirroring
   starBtn's on/off toggle so the row keeps giving feedback without navigating
   away — the plan's explicit "browse and add without losing your place" ask. */
function upNextBtn(id, item = null) {
  if (!id) return "";
  const on = isQueued(id);
  /* NO BUTTON FOR WHAT addToQueue REFUSES (audit round 2 review of
     p-impatient-10). The refusal moved into addToQueue, but epRow and the
     episode page still drew "+ Up Next" beside "Not available to play", and a
     tap turned it "✓ Up Next" while nothing was added. `liveEpisode` is the
     same definition addToQueue checks, so the button and the refusal agree;
     a row builder that holds the item passes it, and a row whose own item
     carries audio keeps its button (bindUpNext paints from the queue either
     way, so a refusal is never shown as a success). */
  if (!on && !(item && item.audio_url) && !liveEpisode(id)) return "";
  const { text, attr } = toggleMarkup(on, UP_NEXT_TOGGLE);
  return `<button class="up-next ${on ? "on" : ""}" data-upnext="${esc(id)}"${attr}>${text}</button>`;
}

/* ---------- starred shows (follow-lite) ----------

   Requirement A2.4 / Joey's Q2 answer: "yes, add starred shows, and a
   section for all of your starred shows. It is not the home page but is
   somewhat easily accessible." Deliberately NOT subscribe semantics — no
   notifications, no auto-download, no algorithmic surfacing — just a
   lightweight marker, mirroring the existing episode star (`cp_saved`)
   pattern exactly, keyed on show_id instead of episode id. Same "state
   observed, never declared" principle: starring a show changes nothing
   about what the app recommends or fetches. */
function starredShowsMap() { return plainObject(storedValue("cp_starred_shows", {})); }
function isShowStarred(id) { return id in starredShowsMap(); }

function toggleShowStar(id) {
  const had = Boolean(starredShowsMap()[id]);
  let entry = null;
  if (had) {
    logEvent("show_unstarred", { show_id: id });
  } else {
    const show = showById(id);
    if (!show) return;
    entry = {
      show_id: show.show_id,
      title: show.title,
      artwork_url: show.artwork_url || null,
      starred_at: new Date().toISOString(),
    };
    logEvent("show_starred", { show_id: id });
  }
  editStored("cp_starred_shows", {}, (m) => {
    const out = plainObject(m);
    if (had) delete out[id]; else out[id] = entry;
    return out;
  });
  document.querySelectorAll(`[data-show-star="${CSS.escape(id)}"]`).forEach(b => paintFollow(b, isShowStarred(id)));
}

/* THE FOLLOW BUTTON (Redesign 2026, ambient, show page): a Secondary button whose state is a
   FILL change. Unfollowed is the Regular `i-plus` and "Follow"; followed is the Fill
   `i-check-circle-fill` (Ember) and "Following", with the Secondary ring in Ember and a
   soft overlay fill, so the toggle is carried by shape, word and fill, never by colour alone.
   It is a text button on purpose (it sits alone under the title and must read on its own).

   ONE WRITER of its words: followFillHtml() builds the icon and the word, followName() the
   accessible name (the word, then the show: "Following Lex Fridman Podcast" contains the
   visible text, so the name carries the label), and both the first paint (showStarBtn) and
   the repaint after a tap (paintFollow) call them, so the two cannot disagree. The text is
   written through innerHTML because the button holds an icon as well as a word; the helper
   below is still the only place the words change (test/toggle-labels.test.js). */
function followFillHtml(on) {
  return `${agIcon(on ? "check-circle-fill" : "plus", 24)}<span>${esc(on ? FOLLOW_TOGGLE.onText : FOLLOW_TOGGLE.offText)}</span>`;
}
function followName(on, title) {
  const word = on ? FOLLOW_TOGGLE.onLabel : FOLLOW_TOGGLE.offLabel;
  return title ? `${word} ${title}` : word;
}
function paintFollow(btn, on) {
  if (!btn) return;
  const title = btn.dataset && btn.dataset.followName ? String(btn.dataset.followName) : "";
  btn.innerHTML = followFillHtml(on);
  btn.setAttribute("aria-label", followName(on, title));
  btn.classList.toggle("is-following", on);
}
function showStarBtn(show_id) {
  const on = isShowStarred(show_id);
  const title = (showById(show_id) || {}).title || "";
  return `<button type="button" class="ag-btn ag-btn-secondary sh-follow${on ? " is-following" : ""}" data-show-star="${esc(show_id)}" data-follow-name="${esc(title)}" aria-label="${esc(followName(on, title))}">${followFillHtml(on)}</button>`;
}

function bindShowStars(scope) {
  scope.querySelectorAll("[data-show-star]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleShowStar(btn.dataset.showStar);
    });
  });
}

/* ---------- Starred Shows page (#/starred-shows) ----------

   Reachable from the drawer, deliberately NOT on the home screen (Joey's
   framing: "somewhat easily accessible" but distinct from home). Renders
   exactly what cp_starred_shows holds -- no fetch, no ranking, no
   algorithmic surfacing. An empty state is a real, renderable state, same
   convention as every other page in the app. Reuses showResultRow's visual
   language (artwork + title, no play/star/duration controls -- a show,
   not a playable item) rather than inventing a second show-card shape. */
function starredShowRow(entry) {
  /* The stored entry is a SNAPSHOT taken when the star was tapped, so it
     carries whatever `artwork_url` the show record had then — null for the 53
     shows harvested without one. Fall back through the live show record so a
     starred show is never blanker than the same show is on any other surface. */
  const art = entry.artwork_url || showArtworkUrl(showById(entry.show_id));
  return `<a class="show-result" href="#/show/${encodeURIComponent(entry.show_id)}" title="${esc(entry.title)}">
    ${art ? rowArtImg(art) : `<span class="show-result-art show-result-art-blank"></span>`}
    <span class="show-result-title">${esc(entry.title)}</span>
  </a>`;
}

/* Back goes to #/shows: since 2026-09-03 this page is reached from the Shows
   page (the drawer entry came off with the five-page menu), so the back
   button returns there rather than to a home screen that no longer links here. */
function renderStarredShows() {
  setBodyClass("view-page");
  const starred = Object.values(starredShowsMap())
    .sort((a, b) => (b.starred_at || "").localeCompare(a.starred_at || ""));

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/library">‹</a>
        <div>
          <h2>Followed shows</h2>
          <p class="sub">${countLabel(starred.length, "show")} you follow</p>
        </div>
      </div>
      ${starred.length
        ? `<div class="show-results">${starred.map(starredShowRow).join("")}</div>`
        : `<p class="note">No followed shows yet — tap Follow on a show's page to keep it here.</p>`}
      <p class="note">${esc(FOLLOW_NOTE)}</p>
    </div>`;
}

/* ---------- the four suggestions ---------- */

function pickedHistory() { return stringList(storedValue("cp_history", [])); }

/** THE ONE WRITER OF `cp_history`. Three call sites (a play button, a picked
    link, a continuous-playback advance) each carried their own copy of this
    append, and none of them kept anything but the id — so a breadth episode
    played from a show page came back in Library as "No longer available"
    (audit 2026-09-22, theme A). The snapshot is what lets it come back. */
function recordHistory(id) {
  if (!id) return;
  rememberEpisode(id);
  /* LAST-PLAYED ORDER, not first-played (audit round 2, honesty-3). This
     appended only on a first play, so a replay left the episode where it was
     and Library → History — which presents the ring's tail as "most recent" —
     could lead with something heard weeks ago while yesterday's re-listen sat
     off the end. Every other reader of `cp_history` tests membership only
     (`hasOpened`, `branchChain`, the keep set above), so the order is free to
     mean what the page says it means. */
  editStored("cp_history", [], (h) => stringList(h).filter(x => x !== id).concat(id).slice(-200));
}

function rememberSeen(ids) {
  const seen = stringList(lsGet("cp_seen", [])).filter(id => !ids.includes(id)).concat(ids);
  lsSet("cp_seen", seen.slice(-SEEN_WINDOW));
}

/* Freshness-ordered, unseen-first chain for one branch's candidate queue.
   Real release_date recency (present on 100% of the pool) replaces pure
   shuffle — a small honest slice of 03_CURATION_SPEC.md's real "freshness"
   scoring component, not faked from fields the client doesn't have (depth/
   format/evergreen only exist on the ~27-episode curated set, not the
   1000+-item discover pool — see docs/DECISIONS.md 2026-07-30). */
function branchChain(items, history, seen) {
  /* dateValue, not `new Date(x || 0)` (audit round 3, app-1-13): an
     unparseable date made the comparator NaN, and a sort over an inconsistent
     comparator leaves the order to the engine, so a branch's lead episode
     could be arbitrary. dateValue reads it as 0, the oldest. */
  const byRecency = (a, b) => dateValue(b.release_date) - dateValue(a.release_date);
  const unseen = items.filter(it => !history.has(it.id) && !seen.has(it.id)).sort(byRecency);
  const seenNotPlayed = items.filter(it => !history.has(it.id) && seen.has(it.id)).sort(byRecency);
  const played = items.filter(it => history.has(it.id)).sort(byRecency);
  return unseen.concat(seenNotPlayed, played);
}

/* The 4-slot menu: variety by construction (03_CURATION_SPEC.md), not by
   chance. One slot is a structural exploration floor — a branch the user
   hasn't weighted highly, picked deliberately rather than left to random
   jitter possibly landing on it or not. The other 3 come from the user's
   real highest-interest branches (state.interests: taxonomy defaults,
   refined by local overrides and observed signal). No live backend exists
   for this static site (docs/DECISIONS.md 2026-07-30), so this runs
   entirely client-side on data the client actually has — it is not the
   full relevance+freshness+quality-fatigue formula in scoring.ts, which
   needs depth/format/evergreen fields the discover pool doesn't carry. */
/* `reserve`: subjects the listener NAMED a moment ago (the first-run picks —
   see redealAfterOnboardingPicks). AN EXPLICIT PICK IS A FACT, NOT A NUDGE
   (audit round 2, p-first-1): the pick's +0.20/√n lift is smaller than this
   deal's ±0.25 jitter and than the authored defaults' head start (Engineering
   0.9, History 0.8), so measured over the shipped pool a newcomer who picked
   Comedy, Food and Sports saw all three on Home 1% of the time and none of
   them 29%. The interest weights stay a bounded prior (interest-survey-plan
   §4.3: unpicked subjects are never pushed down); what changes is THIS deal —
   the top-tier slots go to the named subjects first, in jittered order, and
   the stretch slot is never one of them. */
function buildCards({ reserve = [] } = {}) {
  const pool = poolFiltered();
  const history = new Set(pickedHistory());
  /* stringList: a stored value of the wrong shape (older-build data, a
     corrupt restore) threw here, inside init, on every launch (audit round 3,
     app-3-13). */
  const seen = new Set(stringList(lsGet("cp_seen", [])));
  const byBranch = {};
  pool.forEach(i => { (byBranch[branchOf(i)] = byBranch[branchOf(i)] || []).push(i); });

  const recentBranches = stringList(lsGet("cp_recent_branches", []));
  const branches = Object.keys(byBranch)
    .map(b => ({
      b,
      avgInterest: byBranch[b].reduce((s, i) => s + interestScore(i), 0) / byBranch[b].length,
      recentlyShown: recentBranches.includes(b)
    }));

  const byInterestDesc = [...branches].sort((x, y) => y.avgInterest - x.avgInterest);
  const topCount = Math.max(1, Math.ceil(byInterestDesc.length * 0.6));
  const topBranchIds = new Set(byInterestDesc.slice(0, topCount).map(x => x.b));

  // Stretch: pick from branches outside the user's top interest tier,
  // preferring one not shown recently, breaking ties toward higher signal
  // among that lower tier (better-than-random exploration, not top-tier).
  const named = new Set((reserve || []).filter(b => byBranch[b]));
  const stretchCandidates = byInterestDesc
    .filter(x => !topBranchIds.has(x.b) && !named.has(x.b))
    .sort((x, y) => (x.recentlyShown === y.recentlyShown ? y.avgInterest - x.avgInterest : x.recentlyShown ? 1 : -1));
  const stretchBranch = stretchCandidates[0]?.b ?? null;

  const jittered = byInterestDesc
    .filter(x => x.b !== stretchBranch)
    .map(x => ({ b: x.b, s: x.avgInterest + (Math.random() - 0.5) * 0.5 - (x.recentlyShown ? 0.35 : 0) }))
    .sort((x, y) => y.s - x.s)
    .map(x => x.b);
  const topRanked = jittered.filter(b => named.has(b)).concat(jittered.filter(b => !named.has(b)));

  const chosenBranches = (stretchBranch ? [stretchBranch] : []).concat(topRanked).slice(0, 4);

  state.cardSlots = chosenBranches.map((branch, i) => {
    const chain = branchChain(byBranch[branch], history, seen);
    return {
      slot: i + 1,
      branch,
      role: branch === stretchBranch ? "stretch" : "top",
      item: chain[0] || null,
      items: chain.slice(0, SUBJECT_QUEUE_SIZE)
    };
  }).filter(sl => sl.item);

  /* What was dealt is remembered once storage has settled, and re-read then:
     written before a late hydration, these two lists replaced the listener's
     durable ones for good and the seen window started over (races-4). */
  const dealtBranches = state.cardSlots.map(sl => sl.branch);
  const dealtIds = state.cardSlots.flatMap(sl => sl.items.map(it => it.id));
  /* EACH DEAL HAS AN EPOCH (audit round 3, app-1-7). A deal made while storage
     is settling is recorded later; if a newer deal replaces it first (the
     first-run picks re-deal), its recorder stands down, so the pre-pick deal is
     never counted as seen after all. `lastDealRecorded` tells the re-deal
     whether there is anything of this deal to undo. */
  const epoch = ++dealEpoch;
  lastDealRecorded = false;
  afterStorageSettles(() => {
    if (epoch !== dealEpoch) return;
    lsSet("cp_recent_branches", stringList(lsGet("cp_recent_branches", [])).concat(dealtBranches).slice(-BRANCH_MEMORY));
    rememberSeen(dealtIds);
    lastDealRecorded = true;
  });
}
let dealEpoch = 0;
let lastDealRecorded = false;

function subjectLabel(branch) {
  return (state.taxonomy?.nodes || []).find(n => n.id === branch && n.parent === null)?.label || branch;
}

/* Subject queues are today's auto-built groupings (state.cardSlots), distinct
   from user-saved playlists (cp_playlists) — same shape so renderPlaylistDetail
   can render either, but not persisted and not removable.

   ANY REAL BRANCH IS ANSWERABLE (audit 2026-09-22). This used to find the
   branch among the four dealt this load or answer "Playlist not found" — and
   the four are re-dealt at random on every boot, with a penalty against the
   ones just shown, so reloading `#/subject/history`, restoring the tab or
   sending the link to anyone was "not found" most of the time.

   Two sources, in order. A branch dealt THIS load answers with its slot, so the
   Home card and the page it opens agree on what is in it. Any other branch is
   built from the catalogue alone — the branch's episodes, newest first, ties
   by id, the same size as a slot — with no history, no seen-list and no
   randomness in it, so the same hash gives the same queue on every reload and
   every device until the catalogue itself changes. */
const SUBJECT_QUEUE_SIZE = 3;

function subjectItemsForBranch(branch) {
  const slot = (state.cardSlots || []).find(sl => sl.branch === branch);
  if (slot) return slot.items;
  const items = poolFiltered()
    .filter(i => branchOf(i) === branch)
    .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || String(a.id).localeCompare(String(b.id)))
    .slice(0, SUBJECT_QUEUE_SIZE);
  return items.length ? items : null;
}

function subjectQueueById(id) {
  const m = /^subject-(.+)$/.exec(id);
  if (!m) return null;
  const items = subjectItemsForBranch(m[1]);
  if (!items) return null;
  const slot = { branch: m[1], items };
  /* `items` in the same shape a saved playlist now carries (#276), so
     resolveParts and renderPlaylistDetail stay one code path. Nothing here is
     persisted — today's queue is rebuilt every load — so the projection costs
     nothing and every part resolves `live` by construction. */
  return withMirror({
    id, title: subjectLabel(slot.branch), items: slot.items.map(playlistPart),
    sparse: false, isSubject: true,
  });
}

/* Generated playlists (D5, and founder feedback F14, 2026-09-08: "playlists are
   now the same as Episodes for you, which is not the intent"). The first
   implementation projected the day's card slots (state.cardSlots) into
   playlist cards, so "Playlists for you" was "Episodes for you" (now
   "Suggested") regrouped.
   A generated playlist is a THEMED LIST: the listener's strongest interest
   LEAVES (never the roots the card slots already cover), each filled from the
   discover pool with the newest episodes on that leaf, excluding any episode a
   card slot is already showing. Pure over state, no persistence, no backend;
   recomputed per render and resolvable by id for the detail page.

   WHAT A LEAF'S LIST MAY HOLD (catalogue-personalization PKG-04; #547 fix 3,
   #558 item 5, #560 item 3). One leaf's newest six used to be whatever the
   pool held newest on it, so one prolific show could fill the whole list, and
   an episode of a broad ("general") show sat on a leaf only because its SHOW
   was labelled there. leafPlaylistItems is the one rule both generators use:
   at most GENERATED_PER_SHOW_CAP items from one show, and an item whose topics
   were inherited from a `label_scope: "general"` show is refused (its own
   per-episode label is kept). The MIN check runs on what survives. */
const GENERATED_PLAYLIST_COUNT = 3;
const GENERATED_PLAYLIST_SIZE = 6;
const GENERATED_PLAYLIST_MIN = 3;
/* The same rule as search-engine.js PER_SHOW_CAP (2), which keeps one show
   from filling a topic search's results; restated rather than imported so the
   generator does not borrow the search ranker's diversify(). */
const GENERATED_PER_SHOW_CAP = 2;

/** Titles of the shows the catalogue marks `label_scope: "general"` (broad
    shows whose show-level label does not describe each episode; PKG-02). */
function generalShowTitleSet() {
  return new Set((state.catalog?.shows || [])
    .filter(s => s.label_scope === "general")
    .map(s => s.title));
}

/** One leaf's playlist items from `candidates` (pool items already on the
    leaf): drop the ones whose only claim to it is a general show's label,
    newest first (ties by id), at most GENERATED_PER_SHOW_CAP per show, up to
    GENERATED_PLAYLIST_SIZE. The caller applies GENERATED_PLAYLIST_MIN. */
function leafPlaylistItems(candidates, { generalShowTitles }) {
  const sorted = candidates
    .filter(it => !(it.topics_source === "show" && generalShowTitles.has(it.show)))
    .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || String(a.id).localeCompare(String(b.id)));
  const perShow = new Map();
  const out = [];
  for (const it of sorted) {
    if (out.length >= GENERATED_PLAYLIST_SIZE) break;
    const n = perShow.get(it.show) || 0;
    if (n >= GENERATED_PER_SHOW_CAP) continue;
    perShow.set(it.show, n + 1);
    out.push(it);
  }
  return out;
}

function generatedPlaylists() {
  const pool = poolFiltered();
  const slots = state.cardSlots || [];
  const slotBranches = new Set(slots.map(sl => sl.branch));
  const slotItemIds = new Set(slots.flatMap(sl => (sl.items || []).map(it => it.id)).concat(slots.map(sl => sl.item?.id)).filter(Boolean));
  const byTopic = new Map();
  for (const it of pool) {
    for (const t of (it.topics || [])) {
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t).push(it);
    }
  }
  const leaves = taxonomyNodes()
    .filter(n => n.parent !== null && !slotBranches.has(n.parent) && byTopic.has(n.id))
    .map(n => ({ n, w: state.interests[n.id] ?? 0 }))
    .filter(x => x.w > 0)
    .sort((a, b) => (b.w - a.w) || a.n.id.localeCompare(b.n.id));
  const generalShowTitles = generalShowTitleSet();
  const out = [];
  for (const { n } of leaves) {
    const items = leafPlaylistItems(byTopic.get(n.id).filter(it => !slotItemIds.has(it.id)), { generalShowTitles });
    if (items.length < GENERATED_PLAYLIST_MIN) continue;
    out.push(withMirror({
      id: "gen-" + n.id, branch: n.id, title: n.label || n.id,
      items: items.map(playlistPart), sparse: false, isSubject: false, isGenerated: true,
    }));
    if (out.length >= GENERATED_PLAYLIST_COUNT) break;
  }
  return out;
}
/* ANY REAL LEAF IS ANSWERABLE (audit round 3, app-1-6; qa 116's rule for
   #/subject/). This used to look the id up in generatedPlaylists(), whose top-3
   cut and slot-parent filter exist only to choose what HOME shows -- and the
   card slots are re-dealt at random every boot. So a reload, a relaunch
   (relaunchRoute), a Jump back in card or a shared link said "Playlist not
   found" whenever the leaf's root was dealt this time or interests had moved it
   out of the top three. Now the id resolves from the catalogue alone: the leaf
   exists and holds at least GENERATED_PLAYLIST_MIN pool episodes, newest first,
   leaving out the episodes the card slots show where enough remain (so the
   page matches Home's card whenever Home shows it). The chosen episodes go
   through the same leafPlaylistItems as Home's card (PKG-04: per-show cap,
   no inherited general labels), so the two can never list different ids. */
function generatedPlaylistById(id) {
  const m = /^gen-(.+)$/.exec(String(id || ""));
  if (!m) return null;
  const node = nodeById(m[1]);
  if (!node || node.parent === null) return null;
  const onLeaf = poolFiltered().filter(it => (it.topics || []).includes(node.id));
  const slots = state.cardSlots || [];
  const slotItemIds = new Set(slots.flatMap(sl => (sl.items || []).map(it => it.id)).concat(slots.map(sl => sl.item?.id)).filter(Boolean));
  const unslotted = onLeaf.filter(it => !slotItemIds.has(it.id));
  const items = leafPlaylistItems(unslotted.length >= GENERATED_PLAYLIST_MIN ? unslotted : onLeaf,
    { generalShowTitles: generalShowTitleSet() });
  if (items.length < GENERATED_PLAYLIST_MIN) return null;
  return withMirror({
    id: "gen-" + node.id, branch: node.id, title: node.label || node.id,
    items: items.map(playlistPart), sparse: false, isSubject: false, isGenerated: true,
  });
}

/* U-05 (docs/ui-transition-plan.md D7): does one of the listener's OWN
   saved playlists (cp_playlists) already cover this query? A plain
   substring check, same shape as searchShows() -- title first (the
   listener's own name for it), then each part's own topics, so a playlist
   titled "History Kick" still surfaces for a query naming one of its
   episodes' actual subjects even though the title itself doesn't. NOT
   routed through SearchEngine.interpretQuery/tokenize (same reasoning
   show-search.test.js pins for searchShows: a listener's own playlist name
   is not a topic query, and stripping "the"/"on" would break a literal
   name match). `playlistSpine` (not resolveParts) so a query still matches
   an archived part's stored topics without needing the live pool. */
function playlistMatchesQuery(playlist, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  if (String(playlist.title || "").toLowerCase().includes(q)) return true;
  return playlistSpine(playlist).some(part =>
    (part.topics || []).some(t => String(t).toLowerCase().includes(q)));
}

/* U-05 (D5, D7): Search's generated-playlist matches are Home's own generated
   playlists -- generatedPlaylists() above, the listener's strongest interest
   LEAVES ordered by state.interests, each filled with that leaf's newest pool
   episodes -- kept where the leaf's title contains the typed query (a plain
   case-insensitive substring). So a match renders and opens exactly like the
   Home card (same #/playlist/gen-<leaf> route, same withMirror shape, resolved
   on the detail page by generatedPlaylistById). No new backend, no new
   scoring: nothing is rebuilt or re-ranked for the query the way
   buildPlaylist's topic scorer does. */
function generatedPlaylistCandidatesForQuery(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  return generatedPlaylists().filter(p => String(p.title).toLowerCase().includes(q));
}

/* Hand-crafted why-lines survive where they exist. */
function whyFor(id, item) {
  const curated = state.session.cards.find(c => c.episode_id === id);
  return curated ? curated.why_line : (item.hook || "");
}

/* ---------- query interpreter (playlist builder) ----------
   The actual matching/scoring logic lives in search-engine.js (loaded
   before this script, see index.html) — pure, DOM-free, and shared with
   tools/test-search.mjs's search-quality battery. `searchCtx` is the
   session-lifetime memoization context it reads/writes (its per-term
   frequency caches); build it once real data is loaded. */

function searchCtx() {
  if (!state._searchCtx) {
    state._searchCtx = { semantic: state.semantic, itemTags: state.itemTags, discover: state.discover };
  }
  return state._searchCtx;
}

/* THE TWO SEARCH-ONLY DOCUMENTS LOAD AFTER THE FIRST PAINT (audit 2026-09-22,
   persona #43 — cold boot). `data/semantic-index.json` (58.5 KB) and
   `data/item-tags.json` (407.2 KB) — 465.7 KB of the 3.52 MB init() used to
   await before painting anything, 97 KB of 791 KB gzipped — are read only by
   the topic scorer (`scoredResultsFor`, via `searchCtx()` and `state.itemTags`),
   which Home's first paint never runs. So init() starts them after `route()`,
   and the three paths that DO score a topic wait for them here first:
   the two playlist builders and Search's create-a-playlist check.

   A ctx built before they land must not survive them: search-engine.js
   memoizes term frequencies ON the ctx and must never have `itemTags` swapped
   under a used one, so the ctx is dropped whole and rebuilt, and the
   repeated-query cache (which stores results scored against the old ctx) is
   cleared with it.

   Memoized, and reset when either came back null, so a failure is retried by
   the next search rather than remembered for the session. A harness or page
   that already holds both documents never fetches. */
let searchDataLoading = null;
/* True once init() has asked for them. Until then nothing is owed — a page
   rendered outside a full boot scores with whatever is in `state`, exactly as
   before — so a caller waits only on a load that has actually been started. */
let searchDataWanted = false;

function loadSearchData() {
  searchDataWanted = true;
  if (state.semantic && state.itemTags) return Promise.resolve();
  if (!searchDataLoading) {
    /* Bounded (SEARCH_DATA_DEADLINE_MS): past it the load counts as failed, so
       a waiting build runs degraded and "Still looking" ends, instead of both
       waiting on a socket that will never answer. */
    searchDataLoading = withDeadline(Promise.all([
      fetchJson("data/semantic-index.json"),
      fetchJson("data/item-tags.json"),
    ]), SEARCH_DATA_DEADLINE_MS, () => [null, null]).then(([semantic, itemTags]) => {
      state.semantic = semantic;
      state.itemTags = itemTags;
      state._searchCtx = null;
      searchCache.clear();
      if (!semantic || !itemTags) searchDataLoading = null;
    });
  }
  return searchDataLoading;
}

/** Run `fn` on a later task once the search documents are in (or have failed —
    a scorer with no tags is today's degraded answer, not a hang). The later
    task is the one the builders always used, so the button's "Building…" gets
    a frame to paint before the synchronous scan. */
function whenSearchDataReady(fn) {
  /* Nothing owed: the same one-task defer the builders always had, scheduled
     NOW rather than from a resolved promise — a microtask hop would move the
     build behind any timer queued in the meantime. */
  if (!searchDataWanted || (state.semantic && state.itemTags)) { setTimeout(fn, 0); return; }
  loadSearchData().then(() => setTimeout(fn, 0));
}

/** The load init() started (re-asked if it failed), or nothing to wait for. */
function searchDataSettled() {
  return searchDataWanted ? loadSearchData() : Promise.resolve();
}

/* ---------- playlists ---------- */

/* "give me a series about fusion" is a prompt, not a name. Derive a clean
   title from the meaningful words of the ask.

   Used to keep only the first 4 words after stripping stopwords, which is why
   "history of organized crime in southern california" (stopwords "of"/"in"
   removed, leaving 5 real words) became "History Organized Crime Southern" —
   the word that actually pins the topic, "California", was silently dropped.
   A playlist title with the wrong last word reads as a typo, not a topic.

   Now: keep up to 8 significant words (room for a real subject + qualifier),
   then fall back to a character budget so a long tail of short words doesn't
   blow past what a card can show — but the budget always cuts on a whole
   word, never mid-word or mid-final-noun. */
const ACRONYMS = new Set(["ai", "bbq", "ww2", "ww1", "f1", "nasa", "diy", "cia", "fbi", "nfl", "nba", "mlb", "ufc", "tv"]);
const TITLE_MAX_WORDS = 8;
const TITLE_MAX_CHARS = 60;

/* EVERY SCRIPT'S LETTERS ARE LETTERS (audit round 3, app-1-14). The split was
   `/[^a-z0-9]+/`, so é, ü, ñ and every non-Latin script were separators:
   "Pokémon lore" was saved as "Pok Mon Lore", "café culture" as "Caf Culture",
   and a Cyrillic or Japanese query as "Playlist". Now a word is a run of
   letters, marks and digits in any script (NFC first, so a decomposed accent
   stays inside its word), and it is capitalised by code point with the
   locale's rule. The stopword and acronym lists are ASCII and still match. */
function capitalizeWord(w) {
  const [first = "", ...rest] = [...w];
  return first.toLocaleUpperCase() + rest.join("");
}
function prettyTitle(query) {
  const raw = String(query).normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  let words = raw.filter(w => !SearchEngine.STOPWORDS.has(w));
  if (!words.length) words = raw;
  words = words.slice(0, TITLE_MAX_WORDS).map(w => ACRONYMS.has(w) ? w.toUpperCase() : capitalizeWord(w));

  // Trim from the end, whole words only, until the title fits the char budget.
  while (words.length > 1 && words.join(" ").length > TITLE_MAX_CHARS) words.pop();

  return words.join(" ") || "Playlist";
}

/* ---------- what a saved playlist keeps (#276) ----------

   A playlist used to persist `item_ids` and nothing else and resolve them, at
   render time, against whatever `data/discover.json` currently held. That pool
   moves: the nightly refresh rotates episodes through it on the web, and after
   #274 the native bundle ships a per-show slice (622 of 1,534 items, measured
   there at roughly three weeks per show). So ids left the pool, the parts behind
   them vanished with nothing said, and the list asserted a count the detail view
   could not render — "7 parts" over five rows.

   THE RULE THAT REPLACES IT: the pool can no longer change the length of a
   playlist. Each part carries its own row in `items`, both views count the same
   resolved array (resolveParts), and the pool's only remaining power is to
   UPGRADE a row it still recognises — artwork, a why-line, in-app playback.

   WHICH FIELDS, AND WHY NOT THE REST. Measured over the 2,167-item pool as
   serialized JSON, key name included, bytes per item (re-measured 2026-10-04
   when `release_date` joined the list; the first measurement, over 1,534
   items, was 268 B kept):

     kept       id 54 · title 63 · show 32 · duration_min 18
                apple_collection_id 33 · apple_track_id 31 · topics 39
                release_date 28                                          = 298 B
     not kept   audio_url 183 · artwork_url 161 · apple_episode_url 134
                hook 98 · duration_sec 20                                = 596 B

   `audio_url` is both the most expensive field and the only one that ROTS. A
   copied enclosure URL that has since moved renders a play button that fails,
   which is strictly worse than the link-out an absent one already degrades to
   (see playBtn) — so in-app playback comes from the live pool only, never from a
   playlist. `artwork_url` is 161 B that epRow never renders. `apple_episode_url`
   is derivable from the two Apple ids that are kept (`id<collection>?i=<track>`),
   and nothing links out to Apple any more anyway. `hook` feeds the player's why-line, which only a live part
   reaches, and `duration_sec` only the player; epRow prints `duration_min`.

   `topics` is kept even though nothing renders it, because without it an
   archived part cannot be starred at all (toggleStar bails when itemIndex has no
   snapshot) and a `picked` from one would report no topics — a playlist play is
   the strongest intent signal in the app, and it would silently stop teaching.
   At 39 B it is the cheapest field that does not rot.

   `release_date` is kept (catalogue-personalization PKG-11, #558 item 8)
   because archivedRow prints it: an archived part renders from this row alone,
   and without the field its date line went blank the day the episode left the
   pool. 28 B, and a publish date never rots.

   THE ARITHMETIC against savePlaylists' cap of 50 and SearchEngine.DEFAULT_CAP's
   10 picks. Measured over all 2,167 items, the MEAN part is 298 B → 3.0 KB of
   parts, plus a 0.5 KB `item_ids` mirror and ~0.2 KB of metadata → ~3.6 KB a
   playlist, ~178 KB for a full 50 (from ~33 KB before). The WORST case is worth
   naming rather than rounding away: the largest single part is 496 B, and 50
   playlists of the ten longest-titled episodes in the catalogue come to ~267 KB.
   A blanket self-sufficient copy would be ~861 B a part — ~430 KB — for the worse
   failure mode above. This lands in DurableStore's localStorage tier — the event
   queue (M3) moved off it into IndexedDB, so it is no longer the comparison point
   here, but the playlist bytes above are still well inside what that tier already
   held; and lsSet reports a refused write rather than
   swallowing it, which buildPlaylist now ACTS on rather than discarding. All four
   figures are asserted against the real catalogue in
   test/playlist-durability.test.js, so widening the whitelist turns CI red rather
   than this comment stale.

   `item_ids` STAYS, as a derived mirror, and that is deliberate rather than
   leftover: a listener whose service worker is still serving an older `app.js`
   reads `p.item_ids.length` in renderPlaylists and would throw on its absence,
   blanking the whole view for the length of the update window. 47 B a part buys
   immunity to that. `items` is authoritative — nothing in this file reads
   `item_ids` except the compatibility paths that predate it. */
const PLAYLIST_PART_FIELDS = ["title", "show", "duration_min", "apple_collection_id", "apple_track_id", "topics", "release_date"];

/** Project a pool item (or a `cp_saved` snapshot) down to a storable part.
    A whitelist, like snapshot(): a field added to the pool does not silently
    start costing 50 playlists' worth of storage. */
function playlistPart(src) {
  const part = { id: src.id };
  for (const f of PLAYLIST_PART_FIELDS) {
    if (src[f] !== undefined && src[f] !== null) part[f] = src[f];
  }
  return part;
}

/** The mirror, kept in step on every write so it can never drift from the
    spine — a stale mirror is this same disagreement one level down. */
function withMirror(p) {
  return Array.isArray(p.items) ? { ...p, item_ids: p.items.map(partId) } : p;
}

/* The pool, for hydration. `state.itemIndex` is already full by the first
   render (init() calls buildCards() -> poolFiltered() -> fullPool() before
   route()), but `playlists()` is also reachable from the drawer and from
   touchPlaylistPlayed, so this does not assume that ordering. It builds the
   pool only when nothing has yet, and never throws: no catalogue is a reason to
   leave a stub alone, not a reason to lose a view. */
function hydrationPool() {
  if (!Object.keys(state.itemIndex).length && state.session && state.session.episodes) {
    try { fullPool(); } catch (_) { /* catalogue not really there yet */ }
  }
  return state.itemIndex;
}

/* THE SECOND MIGRATION, and the self-healing that goes with it (#276).

   A playlist saved before this change holds `item_ids` and nothing else, and a
   migration cannot invent fields that were never stored. So this one RECOVERS
   what is recoverable and KEEPS — never deletes — what is not:

     · an id the live pool still has becomes a full part, snapshotted now;
     · an id the listener starred is recovered from `cp_saved`, which has held
       whole snapshots since stars shipped, so a starred episode survives even
       where the pool has moved on;
     · anything left stays a STUB — `{ id }`, which is exactly what was stored —
       keeps its position, and is retried on every read, so it upgrades itself
       the day the pool carries that episode again. The web pool rotates and the
       native slice changes with the shipped bundle, so that day is real.

   Nothing is dropped and no part loses its place, and THAT is what makes this
   safe to run whenever it happens to run. `state.discover` is null on a partial
   deploy or a stale service-worker cache, so a version of this that deleted what
   it could not resolve would empty a healthy playlist and write that verdict
   down permanently — the migration only gets one first go. The worst case here
   is an all-stub spine the next read repairs.

   @param {object} p
   @param {() => object} sources  lazily builds `{ pool, saved }`, shared across
     every playlist in one read so 50 legacy playlists cost one `cp_saved` parse
     rather than 50 — and cost nothing at all when no playlist needs them.
   @returns {boolean} whether anything changed and needs persisting. */
function hydratePlaylistParts(p, sources) {
  const hadItems = Array.isArray(p.items);
  const spine = hadItems ? p.items : playlistSpine(p);
  let changed = !hadItems;
  /* Fast path, and the reason hydration is affordable on every read: a
     fully-snapshotted playlist touches neither the pool nor cp_saved. */
  if (spine.some(part => part && part.id && !part.title)) {
    const { pool, saved } = sources();
    p.items = spine.map(part => {
      if (!part || !part.id || part.title) return part;
      const src = pool[part.id] || saved[part.id];
      if (!src) return part;
      changed = true;
      return playlistPart({ ...src, id: part.id });
    });
  } else {
    p.items = spine;
  }
  /* `items` is authoritative and `item_ids` is derived, so a disagreement between
     them is REPAIRED here rather than merely ignored. It cannot arise from a store
     this version wrote — withMirror() sees every write — but the mirror exists for
     the benefit of an older `app.js` counting from it, and a mirror that is only
     right when nothing has gone wrong is not worth the 47 B a part it costs.

     `partId` rather than `part.id` throughout, because a corrupt row must not take
     the whole app down: `playlists()` feeds the list, the detail view AND the
     drawer, so one `null` in one playlist's `items` used to throw out of all
     three — the permanent-blank failure the mirror exists to prevent, arriving
     through the repair. It also has to be STABLE for such a row, or the mirror
     disagrees forever and every read rewrites the entire store. */
  const mirror = Array.isArray(p.item_ids) ? p.item_ids : null;
  if (!changed && (!mirror || mirror.length !== p.items.length
      || p.items.some((part, i) => (mirror[i] ?? null) !== partId(part)))) {
    changed = true;
  }
  if (changed) p.item_ids = p.items.map(partId);
  return changed;
}

/** A part's id, or null for a row corrupt enough not to have one. */
function partId(part) { return part && part.id ? part.id : null; }

/** The ordered spine of a playlist: `items` when it has them, else the legacy
    `item_ids` as stubs. One definition, so resolveParts and the migration cannot
    disagree about what a playlist contains. */
function playlistSpine(p) {
  if (Array.isArray(p.items)) return p.items;
  return (Array.isArray(p.item_ids) ? p.item_ids : []).map(id => ({ id }));
}

function playlists() {
  /* Through the pending-edit overlay (round-3 review, L1, app-1-1's
     remainder): a playlist built, removed or played before hydration lands
     shows at once, and lands on the durable list rather than over it. A FRESH
     parse either way: this function backfills the records it returns. */
  let all = pendingStoredEdits.has("cp_playlists") ? storedValue("cp_playlists", null) : lsGet("cp_playlists", null);
  let touched = false;
  if (all === null) {
    all = lsGet("cp_quests", []);   // migrate the old key once
    /* Only a legacy list with something IN it is migrated. An absent key used
       to be materialised as `[]` by this read, so Home's first paint after
       "Delete my data" wrote `cp_playlists` straight back into every tier of a
       device just reported clear (persist-2). */
    touched = Array.isArray(all) && all.length > 0;
  }
  if (!Array.isArray(all)) return [];   // a store this app never wrote
  /* An entry that is not an object is not a playlist, and dropping it is not data
     loss — there is nothing in it to lose. It is also the only safe answer: SIX
     places iterate this array (renderPlaylists, renderDrawer, playlistById,
     touchPlaylistPlayed, savePlaylists and the remove button's filter), and a
     `null` in it threw out of whichever ran first, blanking the list, the detail
     view and the drawer together. Guarding one call site would have moved the
     crash rather than removed it. */
  const real = all.filter(p => p && typeof p === "object");
  if (real.length !== all.length) { all = real; touched = true; }
  let cached = null;
  const sources = () => (cached ||= { pool: hydrationPool(), saved: savedMap() });
  for (const p of all) {
    if (!p.title) { p.title = prettyTitle(p.query || ""); touched = true; }
    /* A hand-edited store, a truncated write, or a cp_quests entry that never
       carried `created` leaves a record with neither `created` nor
       `last_played_at` — and every sort that orders playlists by recency
       (renderDrawer, playlistsForYouHtml) reads one of the two. Backfilling
       here, the same way the title above is backfilled, makes the record
       whole at the one place all six playlist-reading call sites pass
       through, rather than leaning on every sort site to guess a fallback
       (#558 item 1). */
    if (!p.created) { p.created = new Date().toISOString(); touched = true; }
    if (hydratePlaylistParts(p, sources)) touched = true;
  }
  /* Deliberately not through savePlaylists(): a read must not be the thing that
     enforces the 50 cap on a store that already holds more. And never before
     hydration has answered: a read-path write then is exactly the early write
     property 2 of durable-store.js keeps over the durable list for good
     (offerHomeOnboarding: cp_playlists is not in memory before hydration). The
     backfill is recomputed on every read, so nothing is lost by waiting. */
  if (touched && !storageWaiting()) lsSet("cp_playlists", all);
  return all;
}

function savePlaylists(all) { return lsSet("cp_playlists", all.slice(0, 50).map(withMirror)); }

/** Change the stored playlists by `fn` (list -> list), through editStored: now,
    or over the hydrated store once it settles, never over it (app-1-1). `fn`
    must be pure: it is re-run on every read of the overlay. A key never written
    starts from the legacy cp_quests list, as playlists() does. Returns lsSet's
    answer now, or true for a queued edit. */
function editPlaylists(fn) {
  return editStored("cp_playlists", null, (v) => {
    let base = v;
    if (base === null) {
      const legacy = lsGet("cp_quests", []);
      base = Array.isArray(legacy) ? legacy : [];
    }
    const list = Array.isArray(base) ? base.filter(x => x && typeof x === "object") : [];
    /* NO SLICE HERE (#839 review): an edit that adds refuses at the cap
       itself (buildPlaylist, savePlaylistCopy -- "the cap is said, not
       applied"), and one that stamps or removes must not be the thing that
       cuts a store already holding more than 50 (the legacy cp_quests
       migration keeps every entry; playlists()'s read path holds the same
       line). savePlaylists keeps its slice. */
    return fn(list).map(withMirror);
  });
}

/* The most playlists cp_playlists keeps (savePlaylists' slice). */
const PLAYLISTS_CAP = 50;

/* ---------- keeping a playlist 4a made (founder, 2026-09-25) ----------

   "We should add a feature to save playlists." A generated playlist
   (generatedPlaylists) and a Suggested subject queue (subjectQueueById) are
   rebuilt on every load, so what a listener liked yesterday could be gone
   today. Saving one SNAPSHOTS the items it holds right now — the same part
   shape a built playlist stores (playlistPart, #276) — into a new cp_playlists
   entry. From then on it is the listener's own: listed in Library and on the
   Playlists page, drawn as their own under "Playlists for you" (no generated
   badge), removable like any other, and it never changes by itself.

   `saved_from: { kind: "generated" | "subject", source_id }` records where it
   came from. A source's id outlives its episodes ("gen-<leaf>" and
   "subject-<branch>" are the same id on Monday and on Friday), so a copy is
   THIS playlist's copy only while it holds the source's episodes as they are
   now (currentCopyOf). That is what makes the save idempotent — the same
   source saved twice, unchanged, finds the first copy — without telling a
   listener "Saved" about a set of episodes they have never kept: once the
   source moves on, Save is offered again (a new copy beside the old one) and
   the page links to the copy they saved earlier.

   THE CAP IS SAID, NOT APPLIED. cp_playlists holds at most 50, so a 51st
   entry would push the oldest playlist off the end. A save never does that:
   with 50 already kept it is refused, and the page says so. Create's builder
   refuses the same way (buildPlaylist).

   BEFORE HYDRATION A SAVE IS PROVISIONAL. The list it can see then may not be
   the list it lands on (localStorage swept, IndexedDB slow): the durable list
   may already be full, or already hold this copy. So a save queued behind
   hydration answers "pending", the control says "Saving" and takes no second
   tap, and the real outcome — saved, already there, or full — is reported
   (and playlist_saved logged) only once the edit has run over the settled list.

   Family Mode: both sources are built from poolFiltered(), so a copy saved
   under Family Mode holds only what Family Mode showed. After that it is an own
   playlist like any other, resolved through resolveParts — which, while Family
   Mode is on, holds back an episode Family Mode hides (state "hidden"), so a
   copy saved with it off neither lists nor plays one. */
function savedFromOf(p) {
  if (!p || !p.id) return null;
  if (p.isGenerated) return { kind: "generated", source_id: p.id };
  if (p.isSubject) return { kind: "subject", source_id: p.id };
  return null;
}

function sameSource(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.source_id === b.source_id);
}

function sameIdList(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The parts a copy of `p` takes: its spine as shown now, as playlistPart snapshots. */
function copyPartsOf(p) {
  return playlistSpine(p).filter(part => part && part.id).map(playlistPart);
}

/** Does `x` hold `ids`, in that order? */
function holdsIds(x, ids) {
  return sameIdList(playlistSpine(x).map(partId), ids);
}

/** Every copy the listener has saved from `from` ({kind, source_id}). */
function savedCopiesOf(from, list = playlists()) {
  return from ? list.filter(x => sameSource(x.saved_from, from)) : [];
}

/** The listener's copy of `p` AS IT IS NOW — same source, same episodes in
    the same order — or null. */
function currentCopyOf(p, list = playlists()) {
  const from = savedFromOf(p);
  if (!from) return null;
  const ids = copyPartsOf(p).map(part => part.id);
  return savedCopiesOf(from, list).find(x => holdsIds(x, ids)) || null;
}

/* Saves queued behind hydration, by source: the callbacks waiting to hear how
   each came out. One pending save per source — a second tap waits on the first. */
const pendingPlaylistSaves = new Map();
function saveKey(from) { return from.kind + ":" + from.source_id; }
function playlistSavePending(from) { return Boolean(from) && pendingPlaylistSaves.has(saveKey(from)); }

/** Save a generated playlist or a Suggested subject queue as the listener's own.
    `onSettled(result)` hears the real outcome of a save that had to wait for
    hydration (this call then answers "pending").
    @returns {{status: "saved"|"exists"|"full"|"unsaved"|"pending"|"not-saveable", playlist?: object}} */
function savePlaylistCopy(p, onSettled) {
  const from = savedFromOf(p);
  if (!from) return { status: "not-saveable" };
  const key = saveKey(from);
  if (pendingPlaylistSaves.has(key)) {
    if (onSettled) pendingPlaylistSaves.get(key).push(onSettled);
    return { status: "pending" };
  }
  const all = playlists();
  const existing = currentCopyOf(p, all);
  if (existing) return { status: "exists", playlist: existing };
  if (all.length >= PLAYLISTS_CAP) return { status: "full" };
  const items = copyPartsOf(p);
  const ids = items.map(part => part.id);
  /* Two saves inside one millisecond (a new version saved right after the
     old) must not share an id: remove filters by it. */
  let stamp = Date.now();
  while (all.some(x => x.id === "s" + stamp)) stamp += 1;
  const copy = withMirror({
    id: "s" + stamp,
    title: p.title,
    items,
    created: new Date().toISOString(),
    last_played_at: null,
    sparse: false,
    saved_from: { kind: from.kind, source_id: from.source_id },
  });
  /* The edit re-checks both rules against the list it is handed — the SETTLED
     list, when this was queued behind hydration — and leaves it alone rather
     than duplicating or pushing an old playlist off the end. It records which
     rule it met: the last run is the one over the list that is written (the
     flush, for a queued save), so `outcome` is the truth about what landed. */
  let outcome = "saved";
  const edit = (list) => {
    if (list.some(x => sameSource(x.saved_from, from) && holdsIds(x, ids))) { outcome = "exists"; return list; }
    if (list.length >= PLAYLISTS_CAP) { outcome = "full"; return list; }
    outcome = "saved";
    return [copy, ...list];
  };
  const finish = (written) => {
    if (!written) return { status: "unsaved" };
    if (outcome === "full") return { status: "full" };
    const kept = playlists();
    if (outcome === "exists") return { status: "exists", playlist: currentCopyOf(p, kept) };
    logEvent("playlist_saved", { playlist_id: copy.id, from_kind: from.kind, from_id: from.source_id });
    /* Removed again before hydration landed: saved, and then not kept. */
    const landed = kept.find(x => x.id === copy.id);
    return landed ? { status: "saved", playlist: landed } : { status: "removed" };
  };
  if (!storageWaiting()) return finish(editPlaylists(edit));

  editPlaylists(edit);
  const waiters = onSettled ? [onSettled] : [];
  pendingPlaylistSaves.set(key, waiters);
  afterStorageSettles(() => {   // queued after editStored's flush of cp_playlists, so it runs after it
    pendingPlaylistSaves.delete(key);
    const result = finish(storedFlushOk.get("cp_playlists") !== false);
    for (const fn of waiters) {
      try { fn(result); } catch (err) { console.error("after a playlist save settled", err); }
    }
  });
  return { status: "pending" };
}

const SAVE_PLAYLIST_NOTES = {
  saved: "Saved to your playlists. Your copy stays as it is now.",
  exists: "This playlist is already in your playlists.",
  pending: "Saving. 4a is still opening your playlists.",
  full: `You have ${PLAYLISTS_CAP} playlists, the most 4a keeps. Remove one to save this.`,
  unsaved: "This playlist could not be saved — this device has no storage space left.",
};

/** The Save control a generated playlist's or a subject queue's page carries.
    Saved, the button is a state and no longer an action (aria-disabled, and
    its click does nothing), and "Open your copy" is its own link beside it —
    so a second tap on Save, a double tap or VoiceOver's double activation,
    never leaves the page. */
function savePlaylistControlHtml(p) {
  const from = savedFromOf(p);
  const pending = playlistSavePending(from);
  const all = playlists();
  const copy = pending ? null : currentCopyOf(p, all);
  const on = Boolean(copy);
  const ids = copyPartsOf(p).map(part => part.id);
  const earlier = on || pending ? null : savedCopiesOf(from, all).find(x => !holdsIds(x, ids));
  const { text, attr } = toggleMarkup(on, SAVE_PLAYLIST_TOGGLE);
  return `<div class="pl-save-wrap">
        <button type="button" class="pl-save${on ? " on" : ""}" id="pl-save"${attr}${on || pending ? ` aria-disabled="true"` : ""}>${text}</button>
        <a class="pl-save-open" id="pl-save-open" href="#/${on ? esc(playlistRoute(copy)) : "playlists"}"${on ? "" : " hidden"}>Open your copy</a>
        ${earlier ? `<p class="note">You saved an earlier version of this playlist. <a href="#/${esc(playlistRoute(earlier))}">Open that copy</a></p>` : ""}
        <p class="note pl-save-note" id="pl-save-note" role="status">${pending ? esc(SAVE_PLAYLIST_NOTES.pending) : ""}</p>
      </div>`;
}

function bindSavePlaylist(p) {
  const btn = $("#pl-save");
  if (!btn) return;
  const from = savedFromOf(p);
  const paint = (result) => {
    if ($("#pl-save") !== btn) return;   // the page this control was on has gone
    const saved = result.status === "saved" || result.status === "exists";
    setToggleLabel(btn, saved, SAVE_PLAYLIST_TOGGLE);
    btn.classList.toggle("on", saved);
    if (saved || result.status === "pending") btn.setAttribute("aria-disabled", "true");
    else btn.removeAttribute("aria-disabled");
    const open = $("#pl-save-open");
    if (open) {
      if (saved && result.playlist) open.setAttribute("href", "#/" + playlistRoute(result.playlist));
      open.hidden = !(saved && result.playlist);
    }
    const note = SAVE_PLAYLIST_NOTES[result.status];
    setStatusText($("#pl-save-note"), note || "");
  };
  /* A page drawn while a save waits on hydration says how it came out. */
  if (playlistSavePending(from)) pendingPlaylistSaves.get(saveKey(from)).push(paint);
  btn.addEventListener("click", (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (btn.getAttribute("aria-disabled") === "true") return;   // saved, or saving: a state, not an action
    paint(savePlaylistCopy(p, paint));
  });
}

/* ---------- Up Next (cp_queue) ----------

   docs/listening-queue-plan.md Stage 1. `cp_queue` is a NEW key, deliberately
   not shaped like `cp_playlists` (plan §2) — one flat, ordered array of
   episode ids, fully separate storage from playlists (an episode can be in
   both at once; they answer different questions). One global list in v1, not
   multiple named queues (plan §1 Q1).

   NAMING (plan §3): every user-facing string for this feature says "Up Next",
   never bare "queue" — `player/queue-manager.js`/`queue-state.js` already own
   that word for a foray's internal segment ordering, and confusing the two is
   exactly the collision CLAUDE.md's ownership section warns about. Internal
   names here (`cp_queue`, `queueIds`, `renderQueue`) are implementation detail
   and are fine to say "queue" — nothing here renders to the screen. */

function queueIds() {
  const ids = storedValue("cp_queue", []);
  /* A non-string/empty entry cannot be resolved against itemIndex or savedMap
     (both keyed by real episode ids), so it can only ever render as a
     permanently-broken row — dropping it here is not data loss, it is the
     same "nothing in it to lose" guard `playlists()` applies to a corrupt
     entry (line ~810 above). */
  return Array.isArray(ids) ? ids.filter(id => typeof id === "string" && id) : [];
}

/** THE ONE WRITER OF `cp_queue`, and the one place the two things that watch it
    are told. The car's skip may have appeared or gone; and the Up Next PAGE, if
    it is on screen, is repainted — it is the one surface whose content IS this
    list, and it used to go stale while the listener watched it (audit round 2,
    p-impatient-6): an episode ended, continuous playback removed it here, and
    row 1 stayed listed with a ▶ on it and "N queued" one too many until an arrow
    was pressed, at which point the whole list jumped. */
function saveQueueIds(ids) {
  /* Before storage settles the new list is stated as the change it makes to
     the one on screen (app-1-1): what it dropped is dropped, its order is kept,
     and a queued row only the durable store holds is kept after it, not lost. */
  const before = storageWaiting() ? queueIds() : null;
  const ok = before
    ? editStored("cp_queue", [], (q) => {
      const was = new Set(before), now = new Set(ids);
      return ids.concat(stringList(q).filter(x => !was.has(x) && !now.has(x)));
    })
    : lsSet("cp_queue", ids);
  refreshEpisodeNavigation();
  repaintQueuePage();
  if (typeof syncLibraryBadge === "function") syncLibraryBadge();   // the Library tab's Up Next count (ui/episode.js)
  return ok;
}

/** The Up Next page is a LIVE VIEW of `cp_queue`: every write repaints it when
    it is showing, and the writes' own callers do not (the reorder handlers used
    to call `renderQueue()` themselves — that path is gone, so one list cannot be
    painted twice). The repaint is of the list's own section, not of `#view`, so
    the scroll and the control the listener had pressed stay where they were. */
function repaintQueuePage() {
  /* Library's Up Next section and the Up Next page are two live views of the same list (Redesign 2026, ambient): the
     section repaints in place and keeps its own menu, Toast, scroll and focus, so neither page is rebuilt under a press.
     The page's section carries `data-lb-page` (ui/queue.js), which repaintLibraryUpNext reads. */
  const h = currentHash();
  if ((h === "#/library" || h === "#/queue") && typeof repaintLibraryUpNext === "function") repaintLibraryUpNext();
}

/** Playback moved (a chained play, a tap on an Up Next row): the row that is
    now current is the one to mark. `renderQueue` reads `ForayPlayer.isCurrent`
    per row, so this is the same repaint `saveQueueIds` makes, from the one
    other event that changes what the page should show. */
function noteQueuePlaybackMoved() { repaintQueuePage(); }

function isQueued(id) { return !!id && queueIds().includes(id); }

/* Idempotent by design: tapping "+ Up Next" twice on the same row (a slow
   network re-render, a double-tap) must not duplicate the entry — the plan's
   UI never offers a way to remove a duplicate, so silently de-duping here is
   the only place that can hold that invariant. */
function addToQueue(id) {
  if (!id) return;
  /* ONLY WHAT 4a CAN PLAY (audit round 2, p-impatient-10). An aged-out playlist
     part's row already says "Not available to play"; accepting it here turned
     the button "✓ Up Next", listed the row on #/queue as "not available right
     now" with no ▶, and continuous playback then passed over it without a word
     — a false success from three places at once. `liveEpisode` is the one
     definition of playable (section header above), so the refusal cannot
     disagree with the row. */
  if (!liveEpisode(id)) return;
  const ids = queueIds();
  if (ids.includes(id)) return;
  saveQueueIds(ids.concat(id));
  /* After the id is in the list, so the prune inside keeps this snapshot. */
  rememberEpisode(id);
  logEvent("queued", { episode_id: id });
}

function removeFromQueue(id) {
  if (!id) return;
  saveQueueIds(queueIds().filter(x => x !== id));
  logEvent("unqueued", { episode_id: id });
}

/** Swap a queued episode with its neighbour. `dir` is -1 (up/earlier) or +1
    (down/later); a request that would walk off either end is a no-op, not a
    wrap-around — reordering off the visible list would look like the item
    vanished. */
function moveQueueItem(id, dir) {
  const ids = queueIds();
  const i = ids.indexOf(id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  saveQueueIds(ids);
}

/* ---------- Play next + Clear Up Next (#762, PQ-02) ----------

   The ORDER each tool produces is `player/queue-order.js`'s (PQ-01), published
   by player/client.js as `window.forayQueueOrder` the same way continuation's
   rules are — this classic script cannot import it. What lives here is the
   write (`saveQueueIds`, the one writer of `cp_queue`), the snapshot, and the
   existing `queued`/`unqueued` events. No rules (a page that loaded app.js
   without the player module) means Play next does nothing rather than guess. */
function queueOrderRules() {
  const r = window.forayQueueOrder;
  return r && typeof r.playNextOrder === "function" ? r : null;
}

/** The episode the bar is on, playing or paused; null with no player. */
function currentPlayingId() {
  try { return window.ForayPlayer?.currentEpisodeId?.() || null; } catch (_) { return null; }
}

/** Put `id` directly after the playing row (at the head with nothing playing),
    adding it when it was not queued. Refuses what 4a cannot play — the same
    `liveEpisode` gate `addToQueue` holds. True only when the list changed:
    `playNextOrder` returns the SAME array when the row is already there. */
function playNextInQueue(id) {
  if (!id || !liveEpisode(id)) return false;
  const rules = queueOrderRules();
  if (!rules) return false;
  const before = queueIds();
  const next = rules.playNextOrder(before, id, currentPlayingId());
  if (next === before) return false;
  const wasQueued = before.includes(id);
  saveQueueIds(next);
  /* After the id is in the list, so the snapshot prune keeps it (addToQueue). */
  rememberEpisode(id);
  if (!wasQueued) logEvent("queued", { episode_id: id });
  return true;
}

/** Empty Up Next except the playing row, which leaves when it ends, as it
    always has. Returns how many rows went. */
function clearQueue() {
  const rules = queueOrderRules();
  const before = queueIds();
  const left = rules ? rules.clearOrder(before, currentPlayingId()) : [];
  const removed = before.filter((x) => !left.includes(x));
  saveQueueIds(left);
  removed.forEach((x) => logEvent("unqueued", { episode_id: x }));
  return removed.length;
}

/* ---------- what "playable" means (audit 2026-09-22, theme A) ----------

   THE CURATED POOL IS NOT THE DEFINITION OF A REAL EPISODE. `state.poolIds` is
   the ~220-show discover pool, and since show pages gained the full catalogue
   most episodes a listener actually touches are not in it. Five places asked
   `state.poolIds.has(id)` anyway, so the app called its own working episodes
   gone: Up Next rows read "Episode no longer available", History read "No
   longer available", a starred show-page episode rendered unplayable in Saved,
   continuous playback stopped dead at the first one, and "Open episode" on the
   restored bar said "Episode not found" about the audio in your ears.

   The rule now: an episode is LIVE when the pool holds it (unchanged — a pool
   row keeps its link-out behaviour even without audio) or when we hold a
   snapshot of it that carries an `audio_url`. That is the question every one
   of those sites was actually asking: "can 4a play this".

   #276 STILL HOLDS, and this is why the test is `audio_url` rather than "is in
   `state.itemIndex`". `itemIndex` is a cache that `renderPlaylistDetail` seeds
   with archived playlist PARTS, and a part never carries `audio_url`
   (PLAYLIST_PART_FIELDS) — so a seeded part still reads archived on the second
   render, which is the defect #276 is about.

   WHERE THE SNAPSHOT COMES FROM. `toggleStar` has always written one into
   `cp_saved`. Every other add-side action (Up Next, a play, a picked link)
   stored a bare id, so a reload lost everything but the id. They now all write
   the same snapshot, into `cp_episode_snaps` — a separate key, because putting
   a queued episode in `cp_saved` would mark it saved. */
const EPISODE_SNAPS_KEY = "cp_episode_snaps";
/* History keeps 200 ids and Up Next is unbounded in principle but a few dozen
   in practice; anything referenced by neither is pruned on every write, so this
   cap is a backstop, not the usual limit. */
const EPISODE_SNAPS_CAP = 400;
/* A breadth episode's `hook` is the publisher's whole description (see
   fullCatalogueRowToEpRowItem), and `description`/`chapters` are unbounded too.
   Rows, the player's why-line and the episode page's head need none of that at
   full length, and 400 stored copies of it would be the difference between
   ~200 KB and several MB in the durable store. */
const EPISODE_SNAP_HOOK_MAX = 280;

function episodeSnaps() {
  return plainObject(storedValue(EPISODE_SNAPS_KEY, {}));
}

/* A SAVED snapshot keeps more than an add-side one (app-1-8): the episode
   page reads a star's description first (storedEpisode), and for a breadth
   episode nothing else holds it after a reload. So the hook is trimmed as
   storableEpisode trims it, and the description and chapters are kept, each
   bounded, instead of dropped. */
const SAVED_DESCRIPTION_MAX = 4000;
const SAVED_CHAPTERS_MAX = 100;
function savableEpisode(snap) {
  if (!snap || typeof snap !== "object") return snap;
  const out = storableEpisode(snap);
  const d = snap.description;
  out.description = typeof d === "string" && d.length > SAVED_DESCRIPTION_MAX
    ? d.slice(0, SAVED_DESCRIPTION_MAX - 1) + "…"
    : (d ?? null);
  out.chapters = Array.isArray(snap.chapters) ? snap.chapters.slice(0, SAVED_CHAPTERS_MAX) : (snap.chapters ?? null);
  return out;
}

function storableEpisode(snap) {
  const hook = typeof snap.hook === "string" && snap.hook.length > EPISODE_SNAP_HOOK_MAX
    ? snap.hook.slice(0, EPISODE_SNAP_HOOK_MAX - 1) + "…"
    : snap.hook;
  return { ...snap, hook, description: null, chapters: null };
}

/** Persist what we know about `id` so it can be played and described after a
    reload. A no-op for an id with no playable snapshot in hand: writing a
    partial one would promise a row we cannot play. */
function rememberEpisode(id) {
  const snap = id ? state.itemIndex[id] : null;
  if (!snap || !snap.audio_url) return;
  const stored = storableEpisode(snap);
  /* An edit (app-1-1): the keep set is read when it runs, so over the settled
     store it keeps what the durable Up Next and History name. */
  editStored(EPISODE_SNAPS_KEY, {}, (m) => pruneEpisodeSnaps(plainObject(m), id, stored));
}

function pruneEpisodeSnaps(all, id, stored) {
  const queued = new Set(queueIds());
  const keep = new Set([...queued].concat(pickedHistory(), id));
  const next = {};
  for (const k of Object.keys(all)) if (keep.has(k)) next[k] = all[k];
  next[id] = stored;
  /* THE CAP NEVER TAKES A QUEUED EPISODE (audit round 2, p-impatient-11).
     Deletion is by key insertion order — the oldest remembered first — and the
     oldest remembered are the HEAD of Up Next, the rows about to play. With a
     long Up Next and a full History the keep set passes the cap, and the front
     of the queue turned into "not available right now" on the next add. History
     keys are what the cap is for (the ring rotates them out anyway); a queued
     key is pruned only by leaving Up Next. */
  const ids = Object.keys(next).filter(k => !queued.has(k) && k !== id);
  for (const k of ids.slice(0, Math.max(0, Object.keys(next).length - EPISODE_SNAPS_CAP))) delete next[k];
  return next;
}

/** Every snapshot we hold for `id` outside the session cache: a star's first,
    because it may carry the full description, then the add-side store. */
function storedEpisode(id) {
  return savedMap()[id] || episodeSnaps()[id] || null;
}

/** The episode 4a can play for `id` right now, or null. See the section header
    for the rule. A snapshot found only in storage is seeded into
    `state.itemIndex`, because that is where `bindPlay` and the player's
    callers look it up — and seeding a PLAYABLE snapshot cannot recreate #276. */
function liveEpisode(id) {
  if (!id) return null;
  if (state.poolIds.has(id)) return state.itemIndex[id] || null;
  const cached = state.itemIndex[id];
  if (cached && cached.audio_url) return cached;
  const stored = storedEpisode(id);
  if (stored && stored.audio_url) {
    /* A copy: the stored value is the shared parse (lsGetShared, app-1-8). */
    const seeded = { ...stored };
    state.itemIndex[id] = seeded;
    return seeded;
  }
  return null;
}

/* Shared by queueRows() and the Library screen's Saved/History sections
   (`docs/ux/foray-mockup.jsx`'s LibraryScreen, kanban card t_a1e7a69c) — all
   three are "an id list plus this same three-way resolution", and having one
   definition means a fix to the liveness rule cannot land in one caller and
   not the others. `live` is liveEpisode's answer; `archived` is a snapshot we
   can describe but not play; `unnamed` is a bare id with neither — still a real
   row (a count that disagrees with its rows is #276), not a dropped one. */
function rowsForIds(ids) {
  return ids.map(id => {
    const live = liveEpisode(id);
    if (live) return { item: live, id, state: "live" };
    const stored = storedEpisode(id);
    if (stored) return { item: stored, id, state: "archived" };
    return { item: { id }, id, state: "unnamed" };
  });
}

function queueRows() { return rowsForIds(queueIds()); }

/* ---------- continuous playback (founder ruling 2026-09-14, PR #695, issue #691) ----------

   When an episode ends, keep playing. The ruling, verbatim: "I just want more
   podcasts to play while I'm in the car and can't pick something out for
   myself." CLAUDE.md principle 1 struck "no autoplay chains" the same day; see
   docs/DECISIONS.md 2026-09-14 for why hands-free is the case that clause never
   considered.

   THIS COMMENT USED TO SAY THE OPPOSITE, and the code followed it for eight days
   after the ruling (audit 2026-09-22): default OFF, a drawer switch named for its
   storage key ("Up Next auto-advance"), and a gate that only ever fired for an
   episode started from the #/queue page — so an episode played from Home, a show
   page or search ended in silence, which is the founder's car case exactly.

   What happens now, in order:
     - ON BY DEFAULT. `cp_autoadvance` survives as the off-switch for anyone who
       wants silence at the end — the ruling keeps it — and is labelled for what a
       listener recognises: "Continuous playback" (Apple's name for it).
     - UP NEXT FIRST. An episode that finishes leaves Up Next (Apple parity), and
       whatever is still in Up Next plays next. Without the removal, "Up Next
       first" would replay last week's finished list after any unrelated episode.
     - THEN THE LIST THE LISTENER CHOSE. bindPlay records the ordered row list a
       play button sat in (`state.playList`), and once Up Next has nothing
       playable left, the next row of it plays — the rest of the show page, the
       rest of Saved, the rest of a playlist. "Then", not "else" (review
       2026-09-23): the two were exclusive, so anything queued ended the list
       for good — queue [X], tap ep1 of a show, and after X nothing played.
       The list resumes after `state.playListCursor`, the last row of it that
       actually played, because the episode that just ended (X) is not in it.
     - AN UNPLAYABLE ROW IS PASSED OVER, not stopped at: stopping is the silence
       the ruling is about. liveEpisode() decides, so a show-page episode counts.
     - THEN MORE OF WHAT FITS (PQ-11, issue #691). Once Up Next and the list
       are both spent, the tail plays: `tailIds()` below hands
       `player/tail-fill.js` today's subject deal (`state.cardSlots`, the four
       slots Home dealt) and the rules walk what it builds. EVERY THIRD TAIL
       PICK IS THE STRETCH SUBJECT (README founder-question default 18), the
       exploration floor kept by construction (CLAUDE.md principle 1, ~30 %):
       one stretch position in three, never borrowed by a top slot. Nothing
       already played, queued, in the list or playing is in it. A stretch pick
       says why with the bridge line, and every tail start is announced
       ("Up next: <title>"), because the listener did not choose it. With no
       deal yet (`state.cardSlots` empty) there is no tail and the end is the
       end — the dealer is never run from here: it rolls dice and records a
       Home deal as seen. The switch below turns the tail off with the rest. */
function autoAdvanceOn() { return lsGet("cp_autoadvance", true); }

/* ---------- cp_interlude: the jingle between a Foray's segments ----------

   THE ONE `cp_` KEY THAT IS NOT JSON, and it has to stay that way: it is owned
   by `player/interlude.js`'s `readInterludePref`, which reads `"off"` and
   treats everything else — including an absent key — as ON, and `client.js`
   passes that answer to the manager at boot. `lsGet`/`lsSet` JSON-encode, so
   `lsSet("cp_interlude", false)` would store the string `"false"`, which is not
   `"off"`, which reads back as ON: the off switch would silently never work.
   These two read and write the raw word through the same `storageBackend()`
   every other key uses, so the page and the player agree on one spelling.

   Guarded like `lsGet`/`lsSet` themselves: a throwing or absent store is the
   ordinary case (a private window, a WebView with storage blocked), not an
   error, and ON is the default the policy promises. */
function interludeOn() {
  const store = storageBackend();
  if (!store) return true;
  try { return store.getItem("cp_interlude") !== "off"; } catch (_) { return true; }
}

/** Persist the setting AND tell a running player about it, so the switch is a
    setting rather than a thing that takes effect next launch.

    THE PLAYER IS THE PREFERRED WRITER, unlike every other `cp_` key on this
    page: `player/interlude.js` owns this one (it is read at boot by
    `client.js`, beside `cp_rate`'s) and its `writeInterludePref` is the only
    place that knows the stored value is the literal word `"off"`. Going
    through the bridge is also what makes the change LIVE — `client.js` reads
    the key once, at boot, so a write alone would not reach a Foray already
    playing.

    The fallback is not decoration, the same argument `storageBackend()` makes
    about `window.forayStorage`: the player module is deferred and may have
    404'd from a stale service-worker cache, or may predate this method. The
    setting must still stick, so the word is written here — and it is the only
    place in this file that spells it. */
function setInterludeOn(on) {
  const player = window.ForayPlayer;
  if (player && typeof player.setInterludeEnabled === "function") { player.setInterludeEnabled(on); return; }
  const store = storageBackend();
  try { if (store) store.setItem("cp_interlude", on ? "on" : "off"); } catch (_) { /* refused everywhere; the session still honours the flip */ }
}

/* The ordered list a play was started from — see the section header above.
   One flat field: there is one player and one thing playing. A play started
   anywhere that is not a row list (the mini bar, a Foray, Jump back in's own
   card) leaves a list that does not contain the new episode, so its end finds
   no position in it and stops — which is the honest answer for "no list". */
function setPlayList(ids, playedId = null) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter(x => typeof x === "string" && x))] : [];
  state.playList = list.length ? list : null;
  /* Where in the list we are, and which episode the chain is on. See
     `planAfterEnded`: the list continues after the cursor only while the
     episode ending is one this chain started. */
  state.playListCursor = playedId && list.includes(playedId) ? playedId : null;
  state.playChainId = playedId || null;
  refreshEpisodeNavigation();
}

function isPlayableId(id) { return Boolean(liveEpisode(id)?.audio_url); }

/* ---------- the Up Next model (founder question 9, audit round 2) ----------

   THE ROW YOU PLAY JUMPS TO THE TOP; NOTHING ELSE MOVES OR LEAVES.
   FOUNDER, 2026-09-24, reversing the round-2 default: "Playing something from
   up next removes the items above it - disagree, reverse this. That item in
   the queue jumps to the top." Playing row k from the page's ▶ moves row k to
   the top (it is what is playing) and leaves every other row where it was, in
   its order: with [a, b, c, d] queued, playing c gives [c, a, b, d]. When c
   ends it leaves, and a — Up Next's head — plays next. ⏭ is that same end
   reached early: the episode skipped leaves Up Next exactly as it would have
   at its end, and Up Next's head plays; no other row is dropped. (The round-2
   default dropped rows 1..k-1 on either path; the version before that re-served
   an abandoned row after the last one, p-impatient-7. With the played row at
   the top, "next" is always the head, so neither can happen.)
   `docs/DECISIONS.md` (2026-09-24, founder rulings) records the ruling. */

/* THE RULES LIVE IN `player/continuation.js` (NE-13, docs/native-engine-plan.md
   §5.5) — Up Next first, then the list, the chain and its cursor, all of it.
   They moved so the native engine can be handed the next eight hops as data
   while this page sleeps; this file gathers the inputs and does the writes.
   `player/client.js` publishes the module as `window.forayContinuation`, the
   same bridge `forayStorage` uses, because this classic script cannot import.

   No player module means no rules — and nothing to play with them: every
   caller below is reached from `window.ForayPlayer`, which the same module
   graph publishes after the rules, so "no rules" answers "nothing next"
   exactly when there is no player to ask. */
function continuationRules() {
  const rules = window.forayContinuation;
  return rules && typeof rules.planAfterEnded === "function" ? rules : null;
}

/* ---------- the tail: "and then more of what fits" (PQ-11, #691) ----------

   The tail-fill rule lives in `player/tail-fill.js`, published by
   player/client.js as `window.forayTailFill` beside the continuation rules.

   NEVER buildCards() FROM HERE. The dealer calls Math.random, rewrites
   `state.cardSlots` and records `cp_recent_branches` / `cp_seen` — a getter
   that ran it (EPISODE_NAVIGATION.next is read on every lock-screen install)
   would re-deal Home behind the listener's back and record a deal they never
   saw. No deal yet means no tail.

   THE TAIL IS ONE LIST FOR THE WHOLE WALK. buildTail places the stretch
   subject at positions 3, 6, 9 of what it builds, so a tail rebuilt from
   scratch after each pick (with that pick now in history, so excluded) would
   put the stretch back at position 3 every time while the walk always takes
   position 1: the stretch pick would never play. `state.tailPlayed` holds the
   picks of the walk in progress; they are left OUT of `exclude`, so the build
   is the same list each time, and taken out of the RESULT instead. A walk is
   in progress while the chain sits on its latest pick; any other chain (a
   tap, ◀◀ onto a list row) starts afresh, and history excludes what played. */
function tailPlayedNow() {
  const walked = Array.isArray(state.tailPlayed) ? state.tailPlayed : [];
  return walked.length && walked[walked.length - 1] === state.playChainId ? walked : [];
}

/** The ids the rules may play once Up Next and the list are spent. */
function tailIds(currentId = null) {
  const tf = window.forayTailFill;
  if (!tf || typeof tf.buildTail !== "function") return [];
  if (!Array.isArray(state.cardSlots) || !state.cardSlots.length) return [];
  const walked = new Set(tailPlayedNow());
  const exclude = new Set([...pickedHistory(), ...queueIds(), ...(state.playList || []), currentId]
    .filter(id => id && !walked.has(id)));
  try {
    return tf.buildTail({ slots: state.cardSlots, exclude: [...exclude] }).filter(id => !walked.has(id));
  } catch (_) { return []; }
}

/** The injected state `player/continuation.js` reads, from this page's own.
    `tail` feeds every reader of the rules: the end of an episode, the plan the
    native engine is handed, AND the skip (EPISODE_NAVIGATION.next and the
    switch-off path of advanceQueueOnEnded) — a skip is the end reached early,
    so ⏭ past the last row of a list reaches into the tail too. */
function continuationState(currentId = null) {
  return {
    queue: queueIds(),
    playList: state.playList,
    playChainId: state.playChainId,
    playListCursor: state.playListCursor,
    tail: tailIds(currentId),
    isPlayable: isPlayableId,
    items: liveEpisode,
    currentId,
  };
}

/** What plays after `finishedId`, with no writes:
    `{ nextId, rest, fromList, fromTail }` — see `planAfterEnded` in
    player/continuation.js, which holds the Up Next model above. Shared by the
    end of an episode and by the steering wheel's and the sheet's ⏭, which mean
    the same thing: a skip is the end reached early. */
function planAfterEnded(finishedId) {
  const rules = continuationRules();
  if (!rules) return { nextId: null, rest: null, fromList: false, fromTail: false };
  return rules.planAfterEnded(continuationState(), finishedId);
}

/** What plays after `finishedId`, as `{ nextId, fromTail }` (`nextId` null
    when nothing does). Applies the plan's one write (the finished episode
    leaves Up Next) and moves the chain on to the pick; a tail pick also joins
    the walk in progress (`state.tailPlayed`, see tailPlayedNow) and leaves the
    list cursor where it was — the tail is after the list, not part of it. */
function nextAfterEnded(finishedId) {
  const rules = continuationRules();
  if (!rules) return { nextId: null, fromTail: false };
  const step = rules.nextAfterEnded(continuationState(), finishedId);
  if (step.rest) saveQueueIds(step.rest);
  if (step.nextId) {
    const walked = tailPlayedNow();
    state.playChainId = step.state.playChainId;
    if (step.fromList) state.playListCursor = step.state.playListCursor;
    if (step.fromTail) state.tailPlayed = [...walked, step.nextId];
  }
  return { nextId: step.nextId || null, fromTail: Boolean(step.fromTail) };
}

/** A tap on row k of the Up Next page started playing: row k jumps to the
    top and every other row keeps its place and its order (the model above;
    founder, 2026-09-24). Called from bindPlay once the play has been
    accepted, so a refused play moves nothing. The played row stays until it
    ends — that is what "the finished episode leaves Up Next" has always
    meant. */
function playedFromUpNext(id) {
  const ids = queueIds();
  const at = ids.indexOf(id);
  if (at > 0) saveQueueIds([id, ...ids.filter(x => x !== id)]);
  else noteQueuePlaybackMoved();
}

/** The `data-ctx` an Up Next row's ▶ carries, so bindPlay can tell a play
    started from the page that OWNS the list from one started anywhere else. */
const UP_NEXT_CTX = "upnext";

/**
 * The steering wheel's next/previous for an ordinary episode (review
 * 2026-09-23), and the sheet's own ⏭, Up Next link and Save (audit round 2,
 * p-impatient-7 / p-switcher-5). The player's surface asks
 * `ForayPlayer.setEpisodeNavigation`'s object at the moment it installs the
 * lock-screen actions and paints the sheet, and nothing ever called it, so the
 * car's skip stayed greyed out with a full Up Next. GETTERS, so every install
 * reads the list as it is now: `next` exists exactly when `planAfterEnded` has
 * something to play.
 *
 * PREVIOUS IS ALWAYS THERE FOR AN EPISODE, and it means what it means in every
 * podcast player and on the Foray's own previous (audit round 2, p-car-5):
 * restart, unless we are within the restart window of the start AND the chosen
 * list has a playable row before this one — then that row. It used to be the
 * previous row or nothing, so forty minutes into episode 3 a driver's ◀◀ landed
 * at the start of episode 2, and an episode started from the mini bar or Jump
 * back in had a dead button. The window is the player's (`RESTART_WINDOW_SEC`
 * in player/transport-policy.js, read through `previousMeansRestart`), not a
 * second copy.
 */
/* The store player/bookmarks.js is handed: the page's own tiered read/write.
   The key (`cp_bookmarks`, bookmarks.js KEY) is that module's; the key
   inventory in test/data-deletion.test.js scans player/*.js and finds it
   there, and privacy-policy.md §1 has its row. "Delete my data" clears it by
   prefix like every other `cp_` row. */
const BOOKMARK_STORE = { get: lsGet, set: lsSet };

const EPISODE_NAVIGATION = {
  get next() {
    const cur = window.ForayPlayer?.currentEpisodeId?.();
    if (!cur || !planAfterEnded(cur).nextId) return null;
    return () => playNextAfter(cur, "skip");
  },
  get previous() {
    const cur = window.ForayPlayer?.currentEpisodeId?.();
    if (!cur) return null;
    return () => {
      const list = state.playList || [];
      const i = list.indexOf(cur);
      const prev = i > 0 ? list.slice(0, i).reverse().find(isPlayableId) : null;
      const restart = window.ForayPlayer.previousMeansRestart?.() !== false;
      if (!prev || restart) return window.ForayPlayer.seekTo?.(0);
      state.playChainId = prev;
      state.playListCursor = prev;
      return startChained(prev, "skip");
    };
  },
  /* The sheet's three staples (founder question 10: link and Save now, the
     sleep timer parked). Read by player/client.js's row2 paint; the page owns
     Up Next and the stars, the player owns the sheet. */
  get upNextCount() { return queueIds().length; },
  get nextItem() {
    const cur = window.ForayPlayer?.currentEpisodeId?.();
    const plan = cur ? planAfterEnded(cur) : null;
    const id = plan ? plan.nextId : queueIds()[0];
    /* A queued or saved episode is usually not in today's session document, so the session alone answered null
       and the sheet's Up Next peek vanished for exactly the listener who has an Up Next. The stored snapshot is
       what Up Next itself plays from (liveEpisode). MUTATION: drop the `||` tail and a queued episode outside the
       session gives null. */
    const item = id ? (episode(id) || state.itemIndex[id] || storedEpisode(id)) : null;
    if (!item) return null;
    /* PROVENANCE FROM THE PICK'S SOURCE, not from whether a hook exists (whyFor falls back to item.hook, so nearly every
       catalogue episode has a reason). 4a made the pick only when the continuation took it from the tail ("more of what
       fits"); an entry in Up Next is the listener's own, and the list is the one they started from. Only a 4a pick
       carries a why-line to the sheet — the SAME line startChained will give it (chainedWhy), so a stretch pick shows
       its bridge in the preview as it does on play. */
    const source = plan?.fromTail ? "tail" : (plan?.fromList ? "list" : "queue");
    return { ...item, source, why: source === "tail" ? (chainedWhy(id, item, true) || "") : "" };
  },
  isSaved(id) { return isSaved(id); },
  toggleSaved(id) { toggleStar(id); return isSaved(id); },
  /* Bookmarks inside episodes (#30, PQ-13). The sheet's Bookmark hands over
     the position it paints; the RULES (dedupe, caps, row shape) are
     player/bookmarks.js's, published as `window.forayBookmarks`, and the write
     is the page's own lsGet/lsSet. Device-only (roadmap Q3): no logEvent, no
     sync. Null when the player module has not published the rules. */
  addBookmark(id, sec, durationSec) {
    const b = window.forayBookmarks;
    if (!b) return null;
    const bm = b.addBookmark(BOOKMARK_STORE, { episodeId: id, sec, durationSec });
    if (bm) announce("Bookmarked.");
    return bm;
  },
  bookmarksFor(id) {
    const b = window.forayBookmarks;
    return b ? b.listBookmarks(BOOKMARK_STORE, id) : [];
  },
};

/** Tell the player the answer changed (a play, an Up Next edit), so the OS
    re-reads EPISODE_NAVIGATION now rather than at the next play. */
function refreshEpisodeNavigation() {
  try { window.ForayPlayer?.setEpisodeNavigation?.(EPISODE_NAVIGATION); } catch (_) { /* best-effort */ }
  sendContinuation();
}

/* ---------- the native engine's half of continuous playback (NE-13) ----------

   Under the native engine (docs/native-engine-plan.md §5.5) the page is not
   awake when an episode ends in a car, so it cannot answer "what next" then.
   It answers AHEAD: every time the answer could change — a play, an Up Next
   edit, the Continuous playback switch — `refreshEpisodeNavigation` above also
   hands the player `setContinuation({planSeq, autoAdvance, chain})`, the next
   eight hops `player/continuation.js` plans from this page's own state. The
   engine walks them only while `autoAdvance` is on, and offers "next" whenever
   the chain is non-empty, switch or no switch, as EPISODE_NAVIGATION does.

   The JS player has no `setContinuation` (it asks EPISODE_NAVIGATION at the
   moment it needs the answer), so on the web and Android this is a no-op;
   NE-22 gives the native branch of `player/client.js` one that forwards it. */

/** Plans are ordered by `planSeq`, and a hop the engine walked names its plan,
    so the number must keep rising across page loads too — the engine may still
    hold a plan from before a reload. Wall-clock ms, bumped past the last one. */
let lastPlanSeq = 0;
function nextPlanSeq() {
  lastPlanSeq = Math.max(lastPlanSeq + 1, Date.now());
  return lastPlanSeq;
}

/* Also called straight after each play this page starts: the plan starts from
   the episode now playing, and until `play()` resolves the player is still on
   the one before (setPlayList's refresh runs ahead of the tap's play). Only
   the plan, not setEpisodeNavigation: the JS player installs its own
   lock-screen actions at play time, and this must change nothing there. */
function sendContinuation() {
  const player = window.ForayPlayer;
  if (!player || typeof player.setContinuation !== "function") return;
  const rules = continuationRules();
  if (!rules) return;
  try {
    const current = player.currentEpisodeId?.() || null;
    player.setContinuation(rules.continuationPlan(continuationState(current), {
      planSeq: nextPlanSeq(),
      autoAdvance: autoAdvanceOn(),
    }));
  } catch (_) { /* best-effort, like the navigation above: a plan is re-sent on the next change */ }
}

/* THE LEDGER: `cp_engine_applied`, page-owned. When the engine walked hops or
   recorded positions while this page slept, the next attach hands them over
   and this page applies each ONCE — it logs `play_started` and `position`
   rows, and those leave the device. The watermark is written BEFORE each
   row: a crash in between costs one row, where the other order would repeat
   it on every attach until the engine's ack landed. The decisions (what is
   new, in what order, at what time) are `planAdvanceApply`/`planEventDrain`
   in player/continuation.js; this only executes their steps. */
const ENGINE_APPLIED_KEY = "cp_engine_applied";

/** Apply one hop the engine played: Up Next as it stood after it, the chain
    and cursor, `play_started` (ctx `autoadvance`, at the time the engine
    played it) and history. Returns whether it applied — false for a hop at or
    below the watermark, so a log delivered twice is a no-op the second time. */
function applyEngineAdvance(hop) {
  const rules = continuationRules();
  if (!rules) return false;
  const { steps } = rules.planAdvanceApply(lsGet(ENGINE_APPLIED_KEY, null), [hop]);
  for (const step of steps) {
    lsSet(ENGINE_APPLIED_KEY, step.applied);
    const h = step.hop;
    const id = h.nextId;
    /* The page handed the engine this item itself; seed it back the way
       liveEpisode caches a stored snapshot, so history keeps a nameable row
       after a reload that emptied the pool. */
    if (!state.itemIndex[id] && h.item && h.item.audio_url) state.itemIndex[id] = h.item;
    /* The chain first: saving Up Next re-plans (refreshEpisodeNavigation), and
       the plan must start from where the engine now is. A tail hop (PQ-11) is
       applied like a list hop — the chain moves on to it — except that the
       list cursor stays where it was (the tail is after the list), and it
       joins the tail walk so the next plan continues the same tail. */
    const walked = tailPlayedNow();
    state.playChainId = id;
    if (h.fromList) state.playListCursor = id;
    if (h.fromTail) state.tailPlayed = [...walked, id];
    if (Array.isArray(h.queueAfter)) saveQueueIds(h.queueAfter.filter(x => typeof x === "string" && x));
    else refreshEpisodeNavigation();
    const item = liveEpisode(id) || h.item || {};
    logEvent("play_started", { episode_id: id, topics: item.topics || [], ctx: "autoadvance" }, { ts: step.ts });
    recordHistory(id);
  }
  if (steps.length) trySyncEvents();
  return steps.length > 0;
}

/** Replay the engine's `pendingEvents` through `logEvent` with their original
    timestamps (plan §5.5: the `position` event type is unchanged, so the
    privacy disclosure is too). Returns how many rows were logged. */
function drainEngineEvents(events) {
  const rules = continuationRules();
  if (!rules) return 0;
  const { steps } = rules.planEventDrain(lsGet(ENGINE_APPLIED_KEY, null), events);
  let logged = 0;
  for (const step of steps) {
    lsSet(ENGINE_APPLIED_KEY, step.applied);
    if (!step.row) continue;
    logEvent(step.row.type, step.row.payload, { ts: step.row.ts });
    logged++;
  }
  if (logged) trySyncEvents();
  return logged;
}

/* Handed to the player (a classic script cannot export): in native mode
   player/client.js's attach applies the engine's pending hops and position
   events through these two, then acks them (NE-22). */
window.forayEngineLedger = { applyEngineAdvance, drainEngineEvents };

/** Called from `ForayPlayer.onEpisodeEnded` (player/client.js) with the id of
    the episode that just finished ordinary (non-Foray) playback. The player
    deliberately never reports `ended` for a Foray, which has its own
    segment-advance machinery.

    Runs unconditionally — the rules above, not the caller, decide whether
    anything happens — because the player module intentionally knows nothing
    about Up Next or lists; it only reports "this finished playing" once per
    episode. */
function advanceQueueOnEnded(id) {
  /* THE FINISHED EPISODE LEAVES UP NEXT WITH THE SWITCH OFF TOO (audit round
     3, app-1-9). The removal lived only inside the advance, so with continuous
     playback off a finished row stayed at the top of Up Next with its ▶, and
     the next advance (the switch turned on, a later episode ending) replayed
     it. The switch decides whether anything PLAYS, not whether the finished
     row leaves. saveQueueIds tells the car's skip and repaints the page. */
  if (!autoAdvanceOn()) {
    const plan = planAfterEnded(id);
    if (plan.rest) saveQueueIds(plan.rest);
    return;
  }
  return playNextAfter(id, "autoadvance");
}

/** Play whatever follows `id` — the end of an episode, or the car's skip. */
function playNextAfter(id, ctx) {
  if (!window.ForayPlayer) return;
  /* A skip and the natural end are one rule (the Up Next model): the episode
     leaves Up Next, nothing else does, and the head plays. */
  const step = nextAfterEnded(id);
  refreshEpisodeNavigation();
  if (!step.nextId) return;
  return startChained(step.nextId, ctx, { fromTail: step.fromTail });
}

/** The line under the title for a chained play. A stretch tail pick gets the
    bridge line naming its subject (D1's copy rule: a pick from outside the
    listener's usual subjects says why, never "because you like X"); anything
    else keeps whyFor's curated line or hook. Plain text: the sheet sets it
    with textContent, so it is stretchBridgeText, not the escaped
    stretchBridgeLine Home writes into HTML ("Craft &amp; making"). */
function chainedWhy(nextId, nextItem, fromTail) {
  if (fromTail) {
    const reason = window.forayTailFill?.tailReason?.(state.cardSlots, nextId);
    if (reason && reason.role === "stretch") return stretchBridgeText(subjectLabel(reason.branch));
  }
  return whyFor(nextId, nextItem);
}

function startChained(nextId, ctx, { fromTail = false } = {}) {
  const nextItem = liveEpisode(nextId);
  if (!nextItem || !window.ForayPlayer) return;
  /* Called synchronously (the play belongs to this turn, as the end-of-episode
     event's), with a synchronous throw folded into the same rejection path. */
  let started;
  try {
    started = Promise.resolve(window.ForayPlayer.play(nextItem, { why: chainedWhy(nextId, nextItem, fromTail) }));
  } catch (err) {
    started = Promise.reject(err);
  }
  return started
    .then(ok => {
      /* A chained play the browser refuses (autoplay policy is per element on
         mobile) is already recorded by the player's own diagnostics as
         `source: "autoplay"` (diagnostic-log.js); no new event type is logged
         here, because every event type is a disclosure in the privacy policy. */
      if (!ok) return;
      logEvent("play_started", { episode_id: nextId, topics: nextItem.topics || [], ctx });
      recordHistory(nextId);
      /* A tail pick is the app's choice, not the listener's: say what is now
         playing, once it actually is (a refused play announces nothing). */
      if (fromTail) announce(`Up next: ${nextItem.title || ""}`);
      sendContinuation();
      /* The Up Next page, if showing, marks the row that is now current. */
      noteQueuePlaybackMoved();
      trySyncEvents();
    }, (err) => {
      /* A THROW SAYS SO, as bindPlay's does (review 2026-09-23): this used to
         be an unhandled rejection and a silent stop. */
      console.warn("[4a] chained play failed", err);
      try { window.ForayPlayer.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
      noteTapFailure("start", err);
    });
}

/* One row per saved part, in saved order, each tagged with what the live pool
   can still do for it. `resolveParts(p).length` is the number BOTH views print,
   so the count and the contents cannot disagree — that is the whole of #276, and
   it is one function rather than two so a change cannot land in one view only.

     live       the pool has it: full row, artwork, in-app play.
     archived   the pool does not, but the saved part names it: the row renders
                from the part and links out. "Label, never exclude" (#226) is the
                catalogue rule written FOR playlists — shows useless for Forays
                are kept because playlists want them — so dropping a part the app
                can still describe works against the reason it is there.
     unnamed    a legacy id with no snapshot behind it and no pool entry. Still a
                row, because a count that agrees with nothing is the defect, and
                still recoverable — see hydratePlaylistParts.

   LIVENESS COMES FROM `state.poolIds`, NOT FROM `state.itemIndex`, and the
   difference is the whole reason this comment is here. The first version asked
   `state.itemIndex[part.id]`, which is a snapshot cache that nothing clears and
   that this very function's caller writes archived parts into — so the SECOND
   render of the same playlist in one page session found the archived part in the
   cache, called it live, dropped its label and its note, and put the next-up
   marker on a row that cannot be played. The fix worked exactly once and then
   restored the defect. `poolIds` is rebuilt from scratch by fullPool and means
   only "the catalogue holds this right now".

   liveEpisode() keeps that property (audit 2026-09-22, theme A): outside the
   pool it asks for an `audio_url`, which a seeded part never has, so a part
   stays archived on every render — while an episode the listener starred or
   queued from a show page, which we DO hold a playable snapshot of, is live. */
function resolveParts(p) {
  const spine = playlistSpine(p);
  return spine.map(part => {
    const id = part && part.id ? part.id : null;
    const live = liveEpisode(id);
    /* FAMILY MODE HOLDS A STORED PART BACK TOO. A generated source is built
       from poolFiltered, but a playlist the listener keeps — built, or saved
       from a source while Family Mode was off — holds whatever it held then.
       With Family Mode on, such an episode is "hidden": it keeps its place and
       its number (the count stays true), and it is neither drawn with a play
       button nor offered to Home's play button (homePlayable reads "live"). */
    if (live && !familyAllows(live)) return { item: live, part, state: "hidden" };
    if (live) return { item: live, part, state: "live" };
    if (part && part.title) return { item: part, part, state: "archived" };
    return { item: part || {}, part, state: "unnamed" };
  });
}

function playlistById(id) { return playlists().find(p => p.id === id); }

/** The `data-ctx` a playlist's rows carry ("playlist-…", "subject-…",
    "generated-…") — what bindPickLogging and startEpisodePlay read, and what
    stamps a real playlist's `last_played_at`. The detail page and Home's play
    button both start a playlist, so both name it through this. */
function playlistCtx(p) {
  return (p.isSubject ? "subject-" : (p.isGenerated ? "generated-" : "playlist-")) + p.id;
}

/* ONE SPELLING OF A PLAYLIST'S ROUTE (audit 2026-09-22). Jump back in's card
   percent-encoded the id and every other producer did not, while the router
   decoded neither `#/playlist/` nor `#/subject/` — so the first id carrying a
   `/` (a generated playlist's is `gen-history/technology`) would have been
   "Playlist not found" from the one card that encoded it. Every producer now
   calls this, and the router decodes. Returns the route AFTER `#/`, so the `#`
   stays a literal at the call site (the safeUrl guard's convention). */
function playlistRoute(p) {
  return p && p.isSubject
    ? "subject/" + encodeURIComponent(p.branch)
    : "playlist/" + encodeURIComponent(p && p.id);
}

/* ---------- shows (#/show/:id, Stage 1 of docs/show-pages-plan.md) ----------

   `show_id` is the join key catalog.json carries and app.js has never read
   before this. It is not guaranteed to line up with an episode's `show` string
   forever (docs/show-pages-plan.md §1) — today it does for 220/221 discover-pool
   shows, verified when this landed, with one gap: Lingthusiasm's catalog.json
   title carries a subtitle ("Lingthusiasm - A podcast that's enthusiastic about
   linguistics") that its discover.json `show` field does not ("Lingthusiasm"),
   so the exact-title fallback below would miss it. TITLE_ALIASES exists for
   exactly that one show and is not expected to grow — a second alias is a sign
   the underlying assumption (title strings agree) needs revisiting, not that
   this list needs a third line. */
const TITLE_ALIASES = {
  "Lingthusiasm - A podcast that's enthusiastic about linguistics": "Lingthusiasm",
};

/* A3.1/Q3: the curated 220-show catalogue first, then the breadth-search
   cache (populated by renderShow when a show_id isn't in the curated set —
   see there) so a show page for a breadth-tier show found via Shows search
   still resolves once its record has been fetched once this session.

   S-05: a `pi:<id>` id (a raw PodcastIndex row id from the shard index,
   never one of catalog.json's own show_id slugs — see
   `tools/shows/shard-build.mjs:toShardRow`) resolves from
   `state.shardShowCache`, populated the same way `breadthShowCache` is:
   the moment a shard-search result lands, before the listener ever taps
   it. There is deliberately no id-map/network fallback for a `pi:` id that
   is NOT in that cache (e.g. a cold open of a shared `#/show/pi:<n>` link)
   — S-04a/b's release pipeline is not live yet (SHARD_TOO_LARGE, tracked
   separately), so there is no published shard/id-map to resolve against;
   `resolveMissingShow` below renders the honest "Show not found." rather
   than querying `api/shows/search`, which is keyed on a different id space
   entirely and would never answer a `pi:` id correctly. */
function showById(id) {
  if (typeof id === "string" && id.startsWith("pi:")) {
    return state.shardShowCache[id] || rememberedShardShow(id);
  }
  return (state.catalog?.shows || []).find(s => s.show_id === id)
    || state.breadthShowCache[id]
    || null;
}

/* A `#/show/pi:<n>` PAGE THAT SURVIVES A RELOAD (audit 2026-09-22, theme A).

   The app links to `#/show/pi:<n>` from its own search results, but the only
   thing that could resolve one was `state.shardShowCache`, filled by a search
   THIS session — so reloading the page the app had just shown, restoring the
   tab, or opening the link from a Followed row said "Show not found." There is
   still no id-map to ask (see showById's header), so the answer is the one
   theme A gives episodes: keep the record we already had. A pi: show is
   remembered when its page renders, and a followed one is resolved from its
   `cp_starred_shows` record, which already carries the same title and art. */
const SHARD_SHOWS_KEY = "cp_shard_shows";
const SHARD_SHOWS_CAP = 50;

function rememberShardShow(show) {
  if (!show || typeof show.show_id !== "string" || !show.show_id.startsWith("pi:")) return;
  const entry = {
    show_id: show.show_id, title: show.title || "", artwork_url: show.artwork_url || null,
    artist_name: show.artist_name || null, editorial_note: null, taxonomy_node_ids: [],
    tier: show.tier || "breadth", source: "shard",
  };
  /* An edit (app-1-1), so a visit before storage settles is added to the
     durable list rather than replacing it. */
  editStored(SHARD_SHOWS_KEY, {}, (all) => {
    const next = plainObject(all);
    delete next[show.show_id];            // re-insert last, so the cap evicts the oldest visit
    next[show.show_id] = entry;
    const ids = Object.keys(next);
    for (const k of ids.slice(0, Math.max(0, ids.length - SHARD_SHOWS_CAP))) delete next[k];
    return next;
  });
}

function rememberedShardShow(id) {
  const all = storedValue(SHARD_SHOWS_KEY, {});
  const hit = (all && all[id]) || null;
  if (hit) return hit;
  const followed = starredShowsMap()[id];
  return followed
    ? { show_id: id, title: followed.title || "", artwork_url: followed.artwork_url || null,
        editorial_note: null, taxonomy_node_ids: [], tier: "breadth", source: "shard" }
    : null;
}

/* Every discover-pool episode belonging to a show, joined by show_id first and
   falling back to a title match (with the one known alias) for the show
   catalog.json doesn't carry an id-matched title for. Never assumes the join —
   an empty result is a real, renderable state (a valid show_id with zero
   episodes), not an error.

   Sorted newest-first by `release_date` (Joey's Q7 answer: "Newest first, no
   filter for now"). `dateValue` treats a missing OR unparseable date as
   epoch-0 so it always sorts last and the comparator is never NaN (an
   unparseable-but-present string previously produced `Invalid Date - Invalid
   Date` = NaN, which sorts indeterminately, not last as the old comment
   claimed). */
function dateValue(dateStr) {
  const t = dateStr ? new Date(dateStr).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}
function episodesForShow(show) {
  if (!show) return [];
  const pool = (state.discover?.items || []);
  const wanted = new Set([show.title, TITLE_ALIASES[show.title]].filter(Boolean));
  /* familyAllows: a show page skipped Family Mode entirely (data-integrity-4). */
  return pool.filter(it => wanted.has(it.show) && familyAllows(it))
    .sort((a, b) => dateValue(b.release_date) - dateValue(a.release_date));
}

/* A show's artwork, with the discover pool as the fallback source.

   53 of catalog.json's 220 shows carry `artwork_url: null` — whole harvest
   batches where tools/harvest-catalog.mjs's iTunes lookup found no match
   (`artworkUrl600 ?? null`), landing in contiguous index blocks rather than
   scattered. Every render site then took its `show.artwork_url ? img : blank`
   else-branch and drew a flat grey square. "Shows we vouch for" samples 8 of
   220 by day-of-year seed, so on a typical day one or two of the eight are
   blank next to six that resolve — which reads as one broken show rather than
   a quarter of the catalogue, and is how this reached a device.

   The show record is derived data; the discover pool is not, and it carries a
   live 600x600 https artwork URL for all 1946 of its items. So whenever the
   show has any episode in the pool the correct image is ALREADY in memory —
   the show record simply doesn't reference it.

   Returns null, never "", when there is genuinely nothing: callers render the
   grey `.show-result-art-blank` placeholder for that, and a real absence stays
   a renderable state, same rule as everywhere else in this file.

   WHY AN INDEX AND NOT `episodesForShow(show).find(...)`, which is the obvious
   one-liner and was the first version of this: `#/shows` renders all 220
   catalog shows through showResultRow, 53 of them miss the early return above,
   and episodesForShow builds the FULL matched array before one element is
   taken — so the obvious version costs 53 whole passes over a 1946-item pool
   plus 53 intermediate arrays, per navigation. Measured at 59.7ms per render
   on desktop Node against 0.03ms before, and an iOS WKWebView is several times
   slower than that; renderCategory and similarShowsSection pay smaller
   versions of the same. The index is built once per pool and is ~0.

   It is keyed on the pool ARRAY's identity, not on a boot flag: `init()`
   assigns `state.discover` exactly once and never mutates `items`, but the
   suites reassign it per test, and an index that outlived a reassignment would
   answer for the previous fixture — a stale-cache bug that reads as a passing
   test. Identity comparison costs nothing and cannot get that wrong.

   The join is episodesForShow's, restated as two lookups because a Set-per-
   call is what made the one-liner expensive: exact title first, then the one
   TITLE_ALIASES entry. If that list ever grows past its single documented
   entry, both places have to learn about it.

   Backfilling catalog.json's 53 nulls is still the root fix. This is what
   makes the UI right in the meantime, and on the next show that harvests
   without a match. */
let _artByShowTitle = null;
let _artIndexPool = null;

/* ARTWORK AT THE SIZE IT IS DRAWN (round-2 audit, perf-2). Every catalogue and
   pool artwork URL is Apple's `…/600x600bb.jpg`, and the idle Search tab drew
   all 220 catalogue rows at once, each fetching and decoding a 600 px image
   for a 44 px box — megabytes of cell data before the listener typed. Apple's
   image CDN (`*.mzstatic.com`) serves any `<w>x<h>bb` size from the same path,
   so a row asks for the size it paints; any other host's URL is left alone,
   because a rewrite it does not understand is a broken image. The episode page
   and Now Playing keep 600: that art IS the page. */
const ROW_ART_PX = 132;   // a 44 px row at the 3x density of a current iPhone
/* Home's subject card draws its artwork at 56 px (styles.css `.mini-card img`),
   so 168 at 3x. It was the one list image left at 600 after the row fix — the
   finding named it and the lane's img sites stopped short of it (round-2 sweep). */
const CARD_ART_PX = 168;

function artUrl(url, px) {
  const u = String(url || "");
  if (!/^https:\/\/[a-z0-9-]+\.mzstatic\.com\//i.test(u)) return u;
  return u.replace(/\/\d+x\d+bb\.(jpg|jpeg|png|webp)$/i, `/${px}x${px}bb.$1`);
}

/** A list row's artwork: small, lazy, decoded off the main thread, and with
    its box reserved so a late image cannot shift the row. */
function rowArtImg(url) {
  return `<img class="show-result-art" src="${esc(safeUrl(artUrl(url, ROW_ART_PX)))}" alt="" loading="lazy" decoding="async" width="44" height="44">`;
}

function showArtworkUrl(show) {
  if (!show) return null;
  if (show.artwork_url) return show.artwork_url;
  const pool = (state.discover?.items || []);
  if (_artIndexPool !== pool) {
    _artIndexPool = pool;
    _artByShowTitle = new Map();
    // First wins, matching `.find()`'s "first episode carrying artwork".
    for (const it of pool) {
      if (it.artwork_url && !_artByShowTitle.has(it.show)) _artByShowTitle.set(it.show, it.artwork_url);
    }
  }
  return _artByShowTitle.get(show.title)
    || _artByShowTitle.get(TITLE_ALIASES[show.title])
    || null;
}

/* ---------- show-name links (Stage 4 of docs/show-pages-plan.md) ----------

   epRow/archivedRow/renderEpisode only ever have an episode's `show` string
   (discover.json/itemIndex never carry show_id) — the reverse of
   episodesForShow's join. Same two-step rule as Stage 1: match catalog.json's
   `title` first, then TITLE_ALIASES for the one show (Lingthusiasm) whose
   catalog title and discover `show` string disagree. Returns null (never
   throws) when no show record matches, e.g. state.catalog not loaded yet or a
   show discover.json carries that catalog.json doesn't — the caller falls
   back to plain text, matching renderShow's own "absence is a real state, not
   an error" rule. */
function showIdForShowName(showName) {
  if (!showName) return null;
  const shows = state.catalog?.shows || [];
  let s = shows.find(sh => sh.title === showName);
  if (!s) {
    const aliasedTitle = Object.keys(TITLE_ALIASES).find(k => TITLE_ALIASES[k] === showName);
    if (aliasedTitle) s = shows.find(sh => sh.title === aliasedTitle);
  }
  /* THEN THE SHOW INDEX (audit round 2, p-foray-2): the curated 220 is not the
     set of shows this app can open. Every show in the published Foray was a
     plain name with no page, while `data/show-index.tsv` — the 10,113 rows the
     Shows search already links through — carries some of them. Consulted only
     once it has loaded (it is never fetched for this); see showIndexIdForTitle
     for why the match is exact and unique. */
  return s ? s.show_id : showIndexIdForTitle(showName);
}

/* The show index as an EXACT, UNIQUE title -> id join. Exact because a fuzzy
   title would attach one publisher's page to another's credit (the rule
   player/foray-sources.js keeps for Apple ids); unique because two rows with
   one title are two shows, and guessing between them is the same error. Built
   once per decoded index: the Foray page asks for ~30 names. */
let showIndexTitles = null;
let showIndexTitlesFor = null;
function showIndexIdForTitle(title) {
  if (!title || !showIndex) return null;
  if (showIndexTitlesFor !== showIndex) {
    showIndexTitles = new Map();
    for (const r of showIndex.rows) {
      showIndexTitles.set(r.title, showIndexTitles.has(r.title) ? null : r.show_id);
    }
    showIndexTitlesFor = showIndex;
  }
  return showIndexTitles.get(title) || null;
}

/* The show-name text as a link to its show page, or plain escaped text when
   no show record joins (see showIdForShowName). Never returns an empty
   string for a truthy showName, so callers can drop it straight into the
   existing `${esc(item.show)}` slot without an extra guard. */
/* `showId` FIRST, WHEN THE ROW KNOWS IT (audit round 2, p-switcher-7). The
   title lookup only reaches the 220 curated shows, so under an episode from
   any of the ~19,900 breadth shows the show name was plain text and "go to
   the show from an episode" failed everywhere but the curated set. A search
   result carries the endpoint's `show_id` — an id the endpoint has already
   checked resolves (api/episodes/search.ts drops any hit that does not) — so
   that is the link, and the title join stays the fallback for rows that never
   had an id (the curated pool). */
function showNameLink(showName, showId = null) {
  const label = esc(showName || "");
  const id = showId || showIdForShowName(showName);
  /* Through showRoutePath (showRouteHash without its #), which encodes (audit round 3, app-1-16): the router
     decodes the segment, so an id carrying `%`, `/` or `#` misrouted from here. */
  return id ? `<a class="show-link" href="#${esc(showRoutePath(id))}">${label}</a>` : label;
}

/* Through editPlaylists, as a pure edit: a stamp made before hydration lands
   (a saved copy is playable from the moment it is saved) must not write the
   unhydrated list over the durable one. Only a playlist that exists is
   stamped, so a stale ctx never materialises the key. */
function touchPlaylistPlayed(id) {
  if (!playlists().some(x => x.id === id)) return;
  const at = new Date().toISOString();   // fixed once: the edit is re-run on every overlay read
  editPlaylists(list => list.map(x => (x.id === id ? { ...x, last_played_at: at } : x)));
}

/* Honest rich/sparse/empty contract (product principle #1: an honest
   sparse/empty answer beats padding a list with off-topic filler). Tiering
   rule itself lives in SearchEngine.classifyResults — one definition shared
   with tools/test-search.mjs so the harness validates exactly what ships. */
/* Shows the user has already picked from (cp_history) -- diversify() gently
   down-weights these so results favor discovery over what's already
   familiar (CLAUDE.md principle #1). poolFiltered() below populates
   state.itemIndex as a side effect, so this must run after that call. */
function listenedShows() {
  return new Set(pickedHistory().map(id => state.itemIndex[id]?.show).filter(Boolean));
}

/* Repeated-query cache (H bug, kanban t_838a13c0): a typo fix, back button, or
   re-tap resubmits the exact same query text against a ctx/pool that has not
   changed, and scoreMatch() was re-scanning and re-scoring the whole
   ~1,880-item pool from scratch every time -- 3.4-6s even fully warm (see the
   card's fleet-2 measurement). `interpretQuery` + `searchWithRelaxation`'s
   output (everything through ranking, BEFORE classifyResults) is a pure
   function of (query text, family-mode flag, interests weights) given a pool
   that is otherwise fixed for the session -- state.discover/state.session are
   fetched once in init() and never reassigned, so the pool a query scores
   against cannot change mid-session; the one thing that visibly changes
   without a page reload is `state.interests` (nudgeTopics, on every
   pick/play/thumbs), which is why `state._interestsGen` is bumped there and
   folded into this key. Deliberately CACHES BEFORE classifyResults, not
   after: classifyResults reads `listenedShows()`, which changes on every pick
   independent of the query -- caching past that point would serve a stale
   listened-show penalty. classifyResults itself is O(results), not
   O(catalogue), so leaving it uncached costs nothing.
   Same bounded-eviction spirit as search-engine.js's PATTERN_CACHE_MAX /
   patternCache (a session tab is long-lived and every distinct query text is
   a new key) -- clearing wholesale on overflow is fine since every entry is a
   pure function of its key and cheap to rebuild. */
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

/* U-05 (docs/ui-transition-plan.md D7): read-only topic-match classification,
   shared with buildPlaylist() below via the same `searchCache` (same cache
   key shape, so typing into Search costs nothing extra once the Playlists
   builder -- or a prior Search -- has already scored the same query this
   session). Exists because renderShowSearchResults needs to know whether a
   query clears the topic scorer's "strong result" bar (to decide the
   Create-a-playlist CTA) WITHOUT buildPlaylist's side effect of persisting a
   new `cp_playlists` entry -- a listener must be able to type into search
   without silently accumulating playlists they never asked to save.
   PRESENTATION-ONLY, per the card's explicit scope line: this calls
   SearchEngine.interpretQuery/searchWithRelaxation/classifyResults exactly as
   buildPlaylist does and changes NOTHING about how they score or rank; it only
   chooses not to act on the result the way buildPlaylist does. */
/* Returns `{ status, relaxed }` — not a bare status string. `relaxed` mirrors
   buildPlaylist's own (#558 item 3): both functions read and write the SAME
   `searchCache` entry for a given key, so if either one cached `{ results }`
   without `relaxed`, whichever function ran second would read that entry back
   and silently lose the signal regardless of what its own code did. Today's
   one caller only compares `.status` to "empty", where `relaxed` is always
   null (searchWithRelaxation only sets it when relaxation found results), so
   this changes nothing visible yet — it exists so the cache the two functions
   share never disagrees about what it holds. */
/** The scored pass both `topicSearchStatus` and `buildPlaylist` need, and the
    ONE place that decides what goes in `searchCache`.
 *
 *  Extracted from the two of them (finding 9, client audit 2026-09-12): they
 *  carried eight identical lines each — the same `interpretQuery`, the same
 *  empty guard, the same `poolFiltered()`, the same three-part cache key, the
 *  same miss-then-insert. Two copies of a cache key is the duplication that
 *  actually bites: the two functions SHARE the entry (that is the point — a
 *  search costs nothing once the builder has scored the same query), so the day
 *  one copy learns about a new input and the other does not, whichever ran
 *  first silently answers for the other with the wrong pool.
 *
 *  `null` means the query said nothing to score — no groups and no filters —
 *  which both callers report as `status: "empty"` rather than as an error.
 *
 *  CACHES BEFORE classifyResults, NOT AFTER, which is why that call stays at
 *  the two call sites: `classifyResults` reads `listenedShows()`, which changes
 *  on every pick independent of the query, so caching past this point would
 *  serve a stale listened-show penalty. It is O(results), not O(catalogue), so
 *  leaving it uncached costs nothing. */
function scoredResultsFor(query) {
  const ctx = searchCtx();
  const interp = SearchEngine.interpretQuery(query, ctx);
  if (!interp.groups.length && !interp.filters.length) return null;
  const pool = poolFiltered(); // also refreshes state.itemIndex/state.poolIds (side effect)
  const cacheKey = JSON.stringify([query, familyMode(), state._interestsGen || 0]);
  let cached = searchCache.get(cacheKey);
  if (!cached) {
    const { results, relaxed } = SearchEngine.searchWithRelaxation(pool, interp, 2, state.itemTags, interestScore);
    cached = { results, relaxed };
    if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.clear();
    searchCache.set(cacheKey, cached);
  }
  return { interp, cached };
}

function topicSearchStatus(query) {
  const scored = scoredResultsFor(query);
  if (!scored) return { status: "empty", relaxed: null };
  const status = SearchEngine.classifyResults(scored.cached.results, { listenedShows: listenedShows() }).status;
  return { status, relaxed: scored.cached.relaxed || null };
}

function buildPlaylist(query) {
  /* THE CAP IS SAID, NOT APPLIED (as savePlaylistCopy): with 50 kept, building
     a 51st would silently push the oldest off the end of savePlaylists' slice —
     possibly a saved copy the listener was told "stays as it is now". */
  if (playlists().length >= PLAYLISTS_CAP) return { status: "full", suggestions: [] };
  const scored = scoredResultsFor(query);
  if (!scored) return { status: "empty", suggestions: [] };
  const { interp, cached } = scored;
  const { status, picks } = SearchEngine.classifyResults(cached.results, { listenedShows: listenedShows() });

  if (status === "empty") {
    return { status: "empty", suggestions: SearchEngine.suggestAdjacentTopics(interp, searchCtx()) };
  }

  /* `relaxed` was computed by searchWithRelaxation and thrown away here until
     #558 item 3: "podcasts about fusion under 20 minutes" could silently come
     back with hour-long episodes and nothing said. Stored on the playlist,
     same shape as `sparse`, so renderPlaylistDetail can disclose it exactly
     once, the honest-answer principle that already governs sparse/empty. */
  const playlist = withMirror({
    id: "q" + Date.now(),
    query: query.trim(),
    title: prettyTitle(query),
    items: picks.map(x => playlistPart(x.i)),
    created: new Date().toISOString(),
    last_played_at: null,
    sparse: status === "sparse",
    relaxed: cached.relaxed || null,
  });
  /* A refused write is reported rather than assumed away (#276 review). lsSet has
     returned a boolean since #40 and this was discarding it, so a store at quota
     produced a playlist the home screen then navigated to and the detail view
     rendered as "Playlist not found." — a dead end with no explanation. Pre-#276
     that was hard to reach; taking a full store from ~33 KB to ~168 KB is what
     makes it worth handling. */
  if (!editPlaylists(list => [playlist, ...list.filter(x => x.id !== playlist.id)])) {
    return { status: "unsaved", suggestions: [] };
  }
  return { status, playlist };
}

/* REMOVED 2026-09-23 (audit round 2, p-first-6; founder question 4, default
   taken): `bindPlaylistFormSubmit`, the `#pl-form` builder on #/playlists. Two
   builders with two vocabularies met the newcomer in their first minutes —
   the Create tab ("e.g. the semiconductor supply chain", Build) and the drawer's
   Playlists page ("build me a playlist…", Go) — and Library's empty state
   pointed at one while the Search CTA pointed at the other. The 2026-09-03
   order that kept this form ("keep all that only on the Playlists page") was
   about taking the builder OFF HOME and predates the Create tab (U-06,
   2026-09-06), which D7 calls "today's builder restyled": a replacement, not a
   sibling. One builder now, on Create (`bindCreateFormSubmit`); #/playlists is
   the list, with one link to it. The H-bug setTimeout(0)/"Building…" guard and
   its reasoning live on in the Create handler, which was written from this one. */

/* ---------- shared wiring ---------- */

function bindPickLogging(scope) {
  scope.querySelectorAll("[data-ev='picked']").forEach(a => {
    a.addEventListener("click", () => {
      const id = a.dataset.ep;
      logEvent("picked", { episode_id: id, topics: (state.itemIndex[id] && state.itemIndex[id].topics) || [], app: a.dataset.app || "Apple Podcasts", context: a.dataset.ctx });

      recordHistory(id);

      const m = /^playlist-(.+)$/.exec(a.dataset.ctx || "");
      if (m) touchPlaylistPlayed(m[1]);

      /* NO "LAST PICK" RECORD (audit round 3, data-integrity-8). This used to
         store a full, untrimmed snapshot of every picked episode in
         `cp_lastpick`, which nothing has read since the Continue banner
         (`bannerHtml`) was deleted in visual pass 1 (2026-09-23) — "Jump back
         in" reads the player's own position store. A record kept for no
         purpose fails data minimisation, so the write is gone and the stored
         key is removed once (forgetRetiredKeys below). */
      trySyncEvents();
    });
  });
}

/* Keys the app no longer writes, removed from every storage tier once the
   durable store has hydrated — before that, a removal from the localStorage
   mirror would be undone by the IndexedDB copy migrating back. The privacy
   policy's row for each says it is retired. */
const RETIRED_STORAGE_KEYS = ["cp_lastpick"];
function forgetRetiredKeys() {
  const store = storageBackend();
  if (!store) return;
  for (const key of RETIRED_STORAGE_KEYS) {
    /* Only when present: a removal is a durable-tier write, and a device that
       never held the key has nothing to forget. */
    try { if (store.getItem(key) !== null) store.removeItem(key); } catch (_) { /* best-effort: nothing reads it */ }
  }
}
/* Queued straight onto the settle waiters, not through afterStorageSettles():
   at script evaluation the store has not been published yet, so that would run
   it at once against the bare mirror. markStorageSettled() runs every waiter
   exactly once, on hydration or at the ceiling. */
storageSettleWaiters.push(forgetRetiredKeys);

/* Every in-app play button. A tap on one also records the LIST it sat in — the
   other play buttons in `scope` carrying the same `data-ctx` (a show page's
   episodes, Library's Saved, one playlist), in on-screen order — so continuous
   playback can go on to the next row of what the listener was looking at (see
   § continuous playback). Before 2026-09-22 this took an `origin` flag and only
   a play from #/queue could ever chain; that gate is gone with the ruling. */
function bindPlay(scope) {
  scope.querySelectorAll("[data-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async (e) => {
      // The button sits inside the card's <a>; without this the link-out fires
      // and the browser navigates away mid-play.
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.play;
      const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
      if (!item || !window.ForayPlayer) return;
      /* A BUTTON SHOWING "❚❚" MUST PAUSE.
         FOUNDER, 2026-09-22: "the pause button on jump back in does not work,
         while the pause button on now playing does work."
         `syncCardButtons` in player/client.js repaints every `[data-play]` whose
         id is the current episode as "❚❚" — so this button becomes a pause
         button on screen — and everything below this line is a PLAY. Pressing it
         rebuilt the queue and restarted the episode.
         The mirror case is the same defect and was the next report waiting to
         happen: pause from the bar, press this card's "▶", and `play()` starts
         from zero instead of resuming. `isCurrent` covers both directions, so
         the card delegates to the player whenever it is showing the player's own
         item, and only starts something new when it is not.
         Returned before `logEvent("play_started")` and the history append below:
         a pause is not a start, and counting it as one would put the episode in
         `cp_history` again on every toggle. */
      if (window.ForayPlayer.isCurrent?.(id)) {
        await window.ForayPlayer.togglePlayback();
        return;
      }
      await startEpisodePlay(id, item, {
        ctx: btn.dataset.ctx || null,
        list: [...scope.querySelectorAll("[data-play]")].map(b => ({ id: b.dataset.play, ctx: b.dataset.ctx })),
      });
    });
  });
}

/* THE START OF AN ORDINARY EPISODE, from any in-app control — every row's ▶
   (bindPlay above) and Home's one play button (bindHomePlay). One function, so
   Home's button inherits every rule a row's ▶ learned the hard way: the list it
   records for continuous playback, a play that fails says so, a play superseded
   mid-load is not reported or counted, and a playlist's `last_played_at`.
   `list` is the on-screen rows `{ id, ctx }` the press sat among; the ones
   sharing `ctx` are the play list. Answers whether the play was accepted and is
   still the player's own. The caller decides the isCurrent toggle first: a row
   showing ❚❚ pauses, Home's "Play …" never does. */
async function startEpisodePlay(id, item, { ctx = null, list = [], startOffset = null } = {}) {
  const listCtx = ctx || null;
  /* UP NEXT IS ITS OWN CONTINUATION (audit round 2 review). Its ▶ carries
     `data-ctx="upnext"` only as the mark that triggers `playedFromUpNext`;
     snapshotting the rows as a play list froze a second, stale copy of the
     queue, so a row the listener then removed with ✕ — or one a play from
     row 3 moved — still played next, or came back on ⏮. `planAfterEnded`
     reads the live queue first; the list is only this one episode. */
  setPlayList(listCtx && listCtx !== UP_NEXT_CTX
    ? list.filter(b => b.ctx === listCtx).map(b => b.id)
    : [id], id);
  /* A PLAY THAT FAILS SAYS SO (persona audit #4, 2026-09-22). It used to be
     `if (!ok) return;` with no try at all: a refused play said nothing, and a
     throw out of `play()` was an unhandled rejection in an async listener —
     a tap that did nothing and said nothing, which is founder report #225,
     already fixed for the Foray page by guardForayStart. The line itself
     lives on the player bar (`reportPlayFailure`), because the bar is on
     screen whichever page this button was on. */
  let ok = false;
  try {
    /* `startOffset`: a start AT a chapter or timestamp (bindEpisodeSeeks) — the
       load begins there rather than playing from the resume point and seeking
       after (races-1). Absent, the options are exactly what they always were. */
    ok = await window.ForayPlayer.play(item, startOffset == null
      ? { why: whyFor(id, item) }
      : { why: whyFor(id, item), startOffset });
  } catch (err) {
    console.warn("[4a] play failed", err);
    try { window.ForayPlayer.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
    noteTapFailure("start", err);
    return false;
  }
  if (!ok) {
    /* SUPERSEDED IS NOT FAILED (audit round 2 review). `play()` answers
       false for a row a later tap replaced mid-load; reporting that painted
       "That episode couldn't load" over the episode that IS loading. Only
       a play that is still the player's own item failed. */
    if (typeof window.ForayPlayer.isCurrent === "function" && !window.ForayPlayer.isCurrent(id)) return false;
    try { window.ForayPlayer.reportPlayFailure?.(null); } catch (_) { /* the bar is best-effort */ }
    return false;
  }
  /* A ROW SUPERSEDED MID-LOAD IS NOT PLAYED (audit round 2, p-impatient-2): `play()` now answers for its own item; this is the belt for a module of that vintage, and a module with no `isCurrent` is trusted on its `ok`. */
  if (typeof window.ForayPlayer.isCurrent === "function" && !window.ForayPlayer.isCurrent(id)) return false;
  logEvent("play_started", { episode_id: id, topics: item.topics || [] });
  recordHistory(id);
  /* A play from the Up Next page moves that row to the top (the Up Next
     model, § continuous playback); every other row stays put. */
  if (listCtx === UP_NEXT_CTX) playedFromUpNext(id);
  /* The plan starts from the episode that is now playing (see
     `sendContinuation`), so it is re-sent once the play is the player's own. */
  sendContinuation();
  /* Same "playlist-<id>" convention and the same regex bindPickLogging
     already applies to a picked link's data-ctx — bindPlay is the in-app
     play button, the PRIMARY control on every live playlist row, and it
     was the only path that never stamped `last_played_at` (#558 item 2):
     a playlist played entirely in-app kept `last_played_at: null`
     forever, which is the sort key both Home's own-playlist rail and the
     drawer use. */
  const m = /^playlist-(.+)$/.exec(listCtx || "");
  if (m) touchPlaylistPlayed(m[1]);
  trySyncEvents();
  return true;
}

function bindStars(scope) {
  scope.querySelectorAll("[data-star]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(btn.dataset.star);
    });
  });
}

/* Toggling here is deliberately different from toggleStar: tapping "+ Up Next"
   a second time does NOT remove the episode (plan §1 Q3 — the control adds;
   removal lives on the #/queue page, not on every row it can appear on, to
   keep browsing rows at their control-density ceiling). It just re-confirms
   membership, which is why addToQueue is already idempotent rather than a
   toggle. */
function bindUpNext(scope) {
  scope.querySelectorAll("[data-upnext]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.upnext;
      addToQueue(id);
      /* Painted from the QUEUE, not from the tap: addToQueue can refuse, and
         "✓ Up Next" over an unchanged cp_queue was a false success. */
      const on = isQueued(id);
      scope.querySelectorAll(`[data-upnext="${CSS.escape(id)}"]`).forEach(b => {
        setToggleLabel(b, on, UP_NEXT_TOGGLE);
        b.classList.toggle("on", on);
      });
    });
  });
  /* Play next (#762, PQ-02) on the episode page: the episode goes right after
     the playing one, queued if it was not, and its "+ Up Next" beside it is
     painted from the queue the same way — never from the tap. */
  scope.querySelectorAll("[data-playnext]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.playnext;
      if (playNextInQueue(id)) announce("Plays next.");
      const on = isQueued(id);
      scope.querySelectorAll(`[data-upnext="${CSS.escape(id)}"]`).forEach(b => {
        setToggleLabel(b, on, UP_NEXT_TOGGLE);
        b.classList.toggle("on", on);
      });
    });
  });
}

/** Say something to a screen reader without moving focus: one polite live
    region, created once on <body> OUTSIDE #view — a region inside #view is
    replaced by the very render whose result it is meant to announce, and a
    region that is new in the DOM is often not read at all. Cleared first so
    the same sentence twice ("Moved to position 2 of 5.") is still a change. */
function announce(text) {
  let region = $("#a11y-status");
  if (!region) {
    region = document.createElement("p");
    region.id = "a11y-status";
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = "";
  const say = () => { region.textContent = String(text || ""); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(say); else say();
}

/* ---------- THE SAME LINK, TAPPED AGAIN (audit round 2, nav-8) ----------

   A drawer link, or the wordmark, to the page already on screen was a silent
   no-op: assigning the hash that is current fires no `hashchange`, so
   `route()` — the only thing that closes every sheet and scrolls to the top —
   never ran. Under the expanded Now Playing sheet, which keeps the drawer
   reachable (F17), that left the sheet covering the page the listener had
   just asked for. The tab bar has answered this gesture since the 2026-09-22
   audit ("tapping the tab you are on takes you to the top"); this is that
   rule for the two other same-page routes, with the one addition they need:
   the sheets close, because the tab bar is inert under a sheet and these two
   are not. */
function sameHashTap(a, e) {
  if (!a || String(a.tagName || "").toUpperCase() !== "A") return false;
  const href = typeof a.getAttribute === "function" ? a.getAttribute("href") : null;
  if (!href || currentHash(href) !== currentHash()) return false;
  if (e && typeof e.preventDefault === "function") e.preventDefault();
  closeAllSheets();
  scrollPageTo(0);
  /* FOCUS IS NOT LEFT IN THE DRAWER (audit round 2 review). No hashchange
     means no route() and so no landing; from a drawer link with no sheet to
     rescue it, focus stayed on a link inside the now-hidden #drawer. landOnPage
     treats focus there as lost and puts it on the page's heading. */
  landOnPage({ navigated: false });
  return true;
}

/* ---------- HARDWARE BACK (audit round 2, nav-2) ----------

   Android's back was the raw WebView back: with the Now Playing sheet (or
   any sheet) open it closed the overlay AND stepped the page underneath
   (the sheets push no history entry, so the step was a real
   one), and on a first page it left the app with the sheet still up. Every
   Android app treats back as "dismiss the top-most thing"; this is that
   ordering, in one place, beside the ownership model the sheets follow: the
   top sheet through its own close (Escape's path — a sheet may decline), then one
   step of the app's own history, else leave the app. (The drawer that used to
   sit above the sheets in this order is gone; the gear's Sheet is a sheet.) iOS has no back button
   and registers the same listener harmlessly. `docs/DECISIONS.md` 2026-09-23
   records the order. */
function handleBack() {
  if (openSheetCount() > 0) {
    sheetStack[sheetStack.length - 1].requestClose();
    return "sheet";
  }
  if (canGoBackInApp()) {
    if (!backPending) { backPending = true; history.back(); }   // one step per press, as ‹ does
    return "history";
  }
  /* HOME BEFORE THE DOOR (audit round 2 review of nav-10). A native relaunch
     reopens the page the listener left (or a deep link opens one) with nothing
     behind it, and back used to leave the app from there — the ‹ on the same
     page falls back to Home (DECISIONS Q11). Back does what ‹ does: Home, in
     place (no entry pushed, so the next back from Home leaves). */
  if (!isHomeRoute()) {
    if (replaceHash("#/")) route();
    return "home";
  }
  return "exit";
}

/* ---------- BACK ON HOME WHILE LISTENING (A-07, docs/plans/android-assessment.md) ----------

   The bottom of the back order used to be `exitApp()` unconditionally. On
   Android that finishes the activity, and the audio plugin's
   `handleOnDestroy` stops the playback service with it: back on Home while
   listening killed the audio. Every podcast player minimizes there instead,
   and `@capacitor/app` has `minimizeApp` (Android: `moveTaskToBack`), which
   keeps the activity, the service and the WebView alive. So: with something
   loaded — playing or paused, an episode or a Foray — back on Home
   minimizes; with nothing loaded it leaves the app as before. "Loaded" is
   the player's own answer (`ForayPlayer.hasLoadedItem`, the id-less form of
   `isLoadedCurrent`): a restored bar or an ended queue is not loaded, and
   leaving from there loses nothing. A shell without `minimizeApp` keeps the
   old exit rather than doing nothing. */
function playerHasLoadedItem(win = window) {
  let player = null;
  try { player = win && win.ForayPlayer; } catch (_) { player = null; }
  if (!player || typeof player.hasLoadedItem !== "function") return false;
  try { return player.hasLoadedItem() === true; } catch (_) { return false; }
}

/** What the shell does when the back order bottoms out on Home: "minimize"
    with something loaded (and a shell that can), else "exit". */
function leaveAppFromBack(app, win = window) {
  if (playerHasLoadedItem(win) && typeof app.minimizeApp === "function") {
    try {
      const out = app.minimizeApp();
      if (out && typeof out.catch === "function") out.catch(() => {});
    } catch (_) { /* the shell refused; staying put beats killing the audio */ }
    return "minimize";
  }
  if (typeof app.exitApp === "function") app.exitApp();
  return "exit";
}

/** Register with the Capacitor App plugin when the shell provides it. Returns
    whether a listener was installed — false on the web, where the browser's
    own back is the right one. */
function bindHardwareBack(win = window) {
  let app = null;
  try { app = win && win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.App; } catch (_) { app = null; }
  if (!app || typeof app.addListener !== "function") return false;
  try {
    app.addListener("backButton", () => {
      if (handleBack() === "exit") leaveAppFromBack(app, win);
    });
  } catch (_) { return false; }
  return true;
}

if (typeof window !== "undefined") {
  /* The follow store, for the Now Playing sheet's "Where this came from" tiles (a classic script on the same page, but
     reached through this one published object like the rest of what the player layer asks of the page). `followable`
     is false for a show id the catalogue does not know, which toggleShowStar would silently refuse. */
  window.ForayNav = {
    handleBack, landOnPage, announce,
    showFollow: {
      followable: (id) => typeof id === "string" && id !== "" && Boolean(showById(id)),
      isFollowing: (id) => isShowStarred(id),
      toggle: (id) => { toggleShowStar(id); return isShowStarred(id); },
    },
  };
}

/* ---------- router ---------- */

/** Which Foray this URL asks for, or null. Routing is hash-only; `?foray=` is
    the way IN and the unlock token, not a route (see enterForayFromQuery). */
function forayRouteId() {
  const m = /^#\/foray\/(.+)$/.exec(location.hash || "#/");
  return m ? (safeDecode(m[1]) || null) : null;
}

/* `?foray=<id>` on the site root opens that Foray once, by rewriting the hash
   in place. replaceState rather than assigning location.hash: assigning fires
   hashchange and renders the page twice, and it would also put an entry in the
   history that the back button bounces off.

   After this the param does nothing but unlock — so the Foray page's back link
   reaches a real home screen, which then LISTS the unlocked draft. The first
   draft routed `#/` straight back to the Foray, which made the back button a
   no-op and the home screen unreachable for the one person who most needs to
   look at the rest of the app. */
function enterForayFromQuery() {
  const id = forayParam();
  const h = location.hash || "";
  if (!id || (h && h !== "#/" && h !== "#")) return;
  /* ONCE PER TAB, not once per load (audit 2026-09-22). The param stays in the
     URL on purpose — it is the draft unlock — so the guard above let a reload
     while on Home re-enter the Foray, and Home was reachable only by leaving it
     again. The ENTRY is now remembered for the tab's session; the UNLOCK is
     still the URL alone, and is still not persisted anywhere a shared machine
     would keep it. `sessionStorage`, not a `cp_` key: this is not listener
     state and must not outlive the tab. */
  const mark = "foray_entered:" + id;
  try {
    if (window.sessionStorage && window.sessionStorage.getItem(mark)) return;
    if (window.sessionStorage) window.sessionStorage.setItem(mark, "1");
  } catch (_) { /* no session store: fall through and enter, as before */ }
  try {
    history.replaceState(history.state ?? null, "", `${location.pathname}${location.search}#/foray/${encodeURIComponent(id)}`);
  } catch (_) { /* a hash we cannot write is a home screen, not a broken page */ }
}

/* Renders whichever page the current hash points at, WITHOUT touching the
   drawer. Split out of route() so a settings-toggle re-render (family mode,
   player pref, auto-advance) can refresh the page behind the drawer without
   the drawer-closing side effect below — those toggles are not navigation,
   the hash never changes, and closing the drawer on them is the bug this
   split fixes. route() itself still closes the drawer, for real navigation. */
function renderCurrentPage() {
  if (!state.ready) return;
  /* The Settings page's controls live in one host that is moved into the page and back (ui/settings.js). Parked
     BEFORE #view is rewritten, or the rewrite would take the host with it. */
  parkSettingsHost();
  /* Both of these belong to a page that is about to be replaced. The sheet's DOM
     and listeners die with #view, so neither can act — but a stale entry left
     pointing at a detached segment is the kind of thing that becomes a bug the
     next time someone reuses the sheet. */
  fbTarget = null;
  state.forayResume = null;
  /* And the sheets that live INSIDE #view (the Foray feedback sheet) go through
     the owner before their DOM does, so the modal lock and the `inert` they
     put on the page cannot outlive them (audit 2026-09-22). */
  closeSheetsWithin($("#view"));
  resetPageHeadScrollState();
  renderEpoch++;
  const h = currentHash();
  /* LEAVING SEARCH ENDS ITS SEARCH (audit round 3, app-2-3). The Search page's
     passes were superseded only by a keystroke, a new Search mount or ✕ — never
     by navigating away — so a pending debounce tick still fired its fetches and
     index scan, and the playlist-CTA scan (1.3-8 s cold, main thread) ran over
     the show page the listener had just opened. */
  if (!/^#\/shows($|\/)/.test(h)) supersedeShowSearch();
  /* A repaint of the page already on screen keeps its shelves where the
     listener left them (audit round 2, perf-8) — a settings switch, the late
     ribbon and ↻ all come through here without a navigation. */
  const keepRails = paintedHash === h ? railOffsets() : null;
  const forayId = forayRouteId();
  let m;
  /* EVERY PARAM ROUTE DECODES, AND DECODES SAFELY (audit 2026-09-22). The rule
     below was written for `#/episode/` and `#/shows/q/`, with a comment saying
     why, while `#/show/`, `#/category/` and `forayRouteId` kept a bare
     `decodeURIComponent` — a lone `%` in a truncated link threw out of the
     router, and on a cold load out of init() before the hashchange listener was
     bound, so the whole app was dead until a reload. `#/playlist/` and
     `#/subject/` decoded nothing at all while Jump back in's card encoded the
     id: a `gen-history/technology` playlist would have been "not found". */
  if (forayId) renderForay(forayId);
  else if ((m = /^#\/playlist\/(.+)$/.exec(h))) renderPlaylistDetail(safeDecode(m[1]));
  else if ((m = /^#\/subject\/(.+)$/.exec(h))) renderPlaylistDetail("subject-" + safeDecode(m[1]));
  /* DECODED, like `#/show/` and `#/category/` below — and unlike this line until
     2026-09-21, which is a bug that hid in plain sight for as long as episode ids
     were slugs.

     A breadth episode's id is `<show_id>--<guid>`, and a guid is very often a
     URL: `lex-fridman-podcast--https://lexfridman.com/?p=6554`. Every link to it
     goes through `encodeURIComponent`, so the hash carries
     `...--https%3A%2F%2Flexfridman.com%2F%3Fp%3D6554` — and this line handed that
     STILL-ENCODED string to `resolveEpisode`, which looked it up in an index
     keyed by the decoded id and found nothing. Every breadth episode page said
     "Episode not found"; pool episodes have plain slugs where encoding is a
     no-op, which is why nobody saw it until a Jump back in card made a breadth
     episode reachable in one tap.

     `safeDecode`, not `decodeURIComponent`: a lone `%` in a hash throws a
     URIError, and a malformed hash must not take the router down (its own
     header makes the same argument). */
  /* A timestamp link (#30) first: `h` is already canonical (currentHash), so
     this is `#/episode/<id>?t=N` — the line below would read `<id>?t=N` as
     the id. */
  else if ((m = episodeDeepLink(h))) renderEpisode(safeDecode(m.seg), { t: m.t });
  else if ((m = /^#\/episode\/(.+)$/.exec(h))) renderEpisode(safeDecode(m[1]));
  else if ((m = parseShowRoute(h))) renderShow(m.id, m.query);
  else if ((m = /^#\/category\/(.+)$/.exec(h))) renderCategory(safeDecode(m[1]));
  /* Before the bare `#/shows`, because `h === "#/shows"` is an exact match
     and would otherwise never see this one — and the browse tiles link here
     (see `browseTile`). A malformed percent-escape decodes to nothing rather
     than throwing the whole router: `decodeURIComponent` is the one call in
     this chain that can raise on user-authored input, and a bad hash must
     land on the ordinary Shows page, not a blank screen. */
  else if ((m = /^#\/shows\/q\/(.*)$/.exec(h))) renderAllShows(safeDecode(m[1]));
  else if (h === "#/shows") renderAllShows();
  else if (h === "#/playlists") renderPlaylists();
  else if (h === "#/forays") renderForays();
  else if (h === "#/queue") renderQueue();
  else if (h === "#/library") renderLibrary();
  else if (h === "#/tuning") renderInterests();
  else if (h === "#/settings") renderSettings();
  else if (h === "#/about") renderAbout();
  else if (h === "#/gallery" && galleryAllowed()) renderGallery();
  else renderHome();
  publishRenderedPageHead();
  /* Called AFTER the page paints, not before: renderTabBar() reads
     document.body's class to decide nothing (it reads location.hash
     directly), but appending it after the page's own
     document.body.className/innerHTML writes is what guarantees the bar
     survives those writes rather than a future page-render function
     clobbering an element the bar already placed. Every page above sets
     document.body.className wholesale via setBodyClass() and none of them
     touch #view's siblings, so ordering here is a belt-and-braces call, not
     a load-bearing one today — but it is the right belt to wear. */
  renderTabBar();
  paintedHash = h;
  applyRailOffsets(keepRails);
}

/* ---------- a new page starts at the top ----------

   Wyatt (2026-09-13, live bug report): "Clicking on a show jumps to a random
   point on the show page (I think it is retaining the screen position from
   the previous page), it should start at the top". His diagnosis is exactly
   right, and it is not specific to shows — measured in Chrome against this
   build: scrolled to 1500 on `#/shows`, tapping a show landed on the show
   page at 457, which is not a random number but the previous page's offset
   clamped to the shorter new document. Routing here is hash-only, a hash
   change is a same-document navigation, and the browser has no reason to
   move the viewport for one. Nothing in the router ever did it either — the
   only scroll code in this file before today is the collapsing header's.

   So: every FORWARD navigation lands at the top, for every route, not just
   shows.

   THE EXCEPTION IS REAL AND IS PRESERVED. Going BACK to a list you were
   scrolled into must return you to where you were — a blanket `scrollTo(0, 0)`
   here would make the four-tap-deep browse that ‹ exists to support
   useless. `noteNavigation` knows which kind of step this is — from the
   browser's own history entry, see § in-app history — and a back-step lands
   on the remembered position instead of the top.

   WHY THE RESTORE IS OURS AND NOT THE BROWSER'S. The browser's own
   restoration is real but it is a RACE, and adding a scroll reset to the
   forward path is enough to lose it. Measured, same build, same three taps:
   on `main`, back from a show to `#/shows` restored 4000; with a plain
   `scrollTo(0, 0)` on the forward step it restored 457 instead — 4000 clamped
   to the SHOW page's much shorter document, because the browser applies the
   restore against whatever is on screen at that instant and our re-render has
   not happened yet. Whether it later retries once the list is tall again is
   timing, not contract. So the exception is preserved by keeping the position
   ourselves and applying it AFTER the page renders, which is deterministic and
   can be tested; it also covers a page the browser never recorded at all. */
function route() {
  if (!state.ready) return;
  const h = currentHash();
  /* A timestamp link's alias (or a stray spelling of its `t`) is rewritten to
     the canonical address IN PLACE before anything records it (#30). */
  if (location.hash !== h && episodeDeepLink(location.hash)) replaceHash(h);
  /* A folded route (ROUTE_ALIASES) is rewritten in place too, so ‹ does not
     bounce off an address that now means something else. `#/create` lands on
     Discover WITH THE FIELD FOCUSED: the field is what the Create tab was for. */
  else if (location.hash !== h && Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, location.hash)) {
    if (location.hash === "#/create" && typeof dockFocusFieldNext === "function") dockFocusFieldNext();
    replaceHash(h);
  }
  const step = noteNavigation(h);
  rememberRouteForRelaunch(h);
  /* Read BEFORE the render: renderCurrentPage() replaces #view's innerHTML,
     and a shorter page clamps window.scrollY on the spot. */
  const target = step === "back" ? (navScrollY.get(h) || 0) : 0;
  const previousHash = renderedHash;
  /* The page being left is still in #view: file its shelves (perf-8). */
  if (paintedHash !== null && paintedHash === previousHash && h !== previousHash) navRailX.set(previousHash, railOffsets());
  renderedHash = h;
  pendingRestore = null;
  if (h !== previousHash) announceOwedFor = null;
  /* To the top first, THEN render: the new page is laid out with the viewport
     already where it is going rather than painted and yanked. */
  scrollPageTo(0);
  /* A NAVIGATION closes whatever modal was up — a back gesture over a sheet
     used to leave it stranded over a different page (the speed menu, the
     delete sheet) — through each sheet's own close, so a sheet that must not
     vanish (Delete my data mid-delete) still refuses. Only when the hash
     actually changed: route() is also how a settings toggle or a finished
     deletion re-renders the page UNDER an open sheet on purpose. */
  if (h !== previousHash) closeAllSheets();
  /* A page that borrowed the root's Glow for the Dock hands it back before the next page paints. */
  if (h !== previousHash && typeof forayReleaseRootGlow === "function") forayReleaseRootGlow();
  renderCurrentPage();
  if (step === "back") applyRailOffsets(navRailX.get(h));
  /* A NAVIGATION IS SAID, NOT ONLY DRAWN (audit 2026-09-22, qa row 80). Only a
     real change of page: the first route at boot and a re-render in place (a
     settings toggle, a finished deletion) keep focus exactly where it is. */
  landOnPage({ navigated: previousHash !== null && h !== previousHash });
  if (target > 0) {
    scrollPageTo(target);
    /* AN ASYNC PAGE IS ONE PARAGRAPH TALL HERE (audit 2026-09-22). A Foray page,
       an uncached show page and a show resolved over the network all paint
       "Loading…" first and their real content a tick later, so this scroll was
       clamped to ~0 — and the next scroll tick then filed 0 as the page's
       remembered position, so the second ‹ was broken too. When the restore did
       not land, it is kept, re-applied by `pageDidPaint()` once the page has
       its real height, and nothing is remembered for this page until then. */
    if ((window.scrollY || 0) < target - 1) pendingRestore = { hash: h, y: target, at: Date.now() };
  }
}

/* ---------- where a route lands focus, and what the page is called ----------

   Audit 2026-09-22, qa row 80: every navigation swapped #view's contents while
   focus stayed on a link that no longer existed — it fell to <body>, and a
   screen-reader user was returned to the top of a page they were never told
   they had left. A drawer link was worse: route() hides the drawer, taking the
   focused link with it. And the document was called "4a" on every screen.

   The rule, the one most single-page apps settle on:
     - the document title is the page's own heading, "<heading> · 4a" (Home,
       whose sections have no page heading, is plain "4a");
     - if the navigation LOST focus (on <body>, on an element the render
       removed, or inside the now-hidden drawer), focus goes to the new page's
       heading — or to #view itself when the page has none — as a programmatic
       target (tabindex=-1), so it is read and Tab continues from there;
     - if focus is somewhere that survived (a tab-bar link, a field the new page
       focused itself), it is left alone and the page's name is announced in
       the polite status region instead. Never both: focus moving already says
       it.
   `navigated: false` (a re-render, pageDidPaint) moves focus only when it was
   genuinely lost — an async page's loading paint can take a focused
   "Loading…" heading away with it — and announces only the one name a
   navigation still owes (`announceOwedFor`, audit round 2). The name is the
   heading's text WITHOUT its explicit badge (`headingName`). */
function pageHeading(view) {
  if (!view || typeof view.querySelector !== "function") return null;
  /* `.lb-head` is Library's own title row and `.sh-head` is the Redesign 2026 show page's heading (it has no `.page-head`: its Room is not a sticky bar). */
  const box = view.querySelector(".page-head") || view.querySelector(".lb-head") || view.querySelector(".st-head") || view.querySelector(".sh-head");
  /* A legacy page head titles itself with an h2 (the top bar owns the h1); a Settings page head IS the page's h1. A page that draws
     its own header (the ambient Foray detail) names itself with `data-page-heading` on its title. */
  return (box && (box.querySelector("h2") || box.querySelector("h1"))) || view.querySelector("[data-page-heading]") || null;
}

/* A NAVIGATION WHOSE NAME HAS NOT BEEN SAID YET (audit round 2, races-6). A
   Foray page paints "Loading…" first — no heading — so route()'s landing had
   no name to say and focus fell to #view; the real paint arrives through
   pageDidPaint(), which is `navigated: false` and so said nothing either. A
   screen-reader user opening a Foray heard silence. route() files the hash
   here when its landing could not name the page, and the first paint of THAT
   page that brings a name says it, once. Any other navigation clears it. */
let announceOwedFor = null;

function landOnPage({ navigated = false } = {}) {
  const view = $("#view");
  /* HOME NAMES ITSELF (audit round 2, a11y-10). It has no `.page-head` — its
     greeting is the top of the page — so both halves of the landing used to
     no-op there: nothing said on a tab-bar Home, focus on a bare #view from a
     drawer link. The document stays plain "4a"; what is SAID is the tab's own
     word, and a lost focus lands on the greeting. */
  const home = isHomeRoute();
  const head = home ? null : pageHeading(view);
  const name = head ? headingName(head) : "";
  const spoken = home ? "Home" : name;
  try { document.title = name ? `${name} · 4a` : "4a"; } catch (_) { /* a stub document */ }
  const owed = navigated || (announceOwedFor !== null && announceOwedFor === renderedHash);
  const active = document.activeElement;
  const lost = !active || active === document.body || active.isConnected === false;
  if (lost) {
    const greeting = home && view && typeof view.querySelector === "function" ? view.querySelector(".td-wordmark") : null;
    const target = head || greeting || view;
    if (!target || typeof target.focus !== "function") return;
    if (typeof target.hasAttribute !== "function" || !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch (_) { /* focus is best-effort */ }
    /* Focus on a named target says the page; focus on the bare region says
       nothing, so a navigation that could only reach #view still owes it. */
    if (target !== view) announceOwedFor = null;
    else if (owed && !spoken) announceOwedFor = renderedHash;
    return;
  }
  if (owed && spoken) {
    announce(spoken);
    announceOwedFor = null;
  } else if (navigated) {
    announceOwedFor = renderedHash;
  }
}

const ROUTE_ALIASES = Object.freeze({
  "#/create": "#/shows",
  "#/starred-shows": "#/library",
  "#/interests": "#/tuning",
});

/* The one normalisation of the hash every route decision reads. THREE
   SPELLINGS OF HOME ("", "#", "#/") rendered the same page and were three
   different things to everything else: tabForHash lit no tab for two of them,
   and on a bare URL the Home tab's `#/` was a real hash change, so the first
   Home tap of every session pushed an entry and the next back press did
   nothing (audit 2026-09-22). init() also rewrites a bare arrival to `#/` in
   place, so the address the history holds agrees with this. */
function currentHash(hash = location.hash) {
  if (!hash || hash === "#") return "#/";
  /* THREE ROUTES FOLDED INTO THEIR NEW HOMES (Redesign 2026, ambient, the Dock:
     three tabs, no drawer). The alias is read HERE so every reader of "which
     page is this" - the tab highlight, the router, back-navigation memory -
     sees one spelling, and route() rewrites the address in place (below) so
     the history holds it too. `#/create` was a tab whose page held one field;
     that field is Discover's now. `#/starred-shows` was Library's overflow
     page; Library lists every followed show. `#/interests` is Tuning. */
  if (Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, hash)) return ROUTE_ALIASES[hash];
  /* ONE SPELLING OF A TIMESTAMP LINK, too (#30): `#/play/<id>?t=N` is the
     alias, `#/episode/<id>?t=N` the page — see episodeDeepLink. route()
     writes this spelling back into the address in place. */
  const link = episodeDeepLink(hash);
  return link ? episodeDeepLinkHash(link) : hash;
}

/* ---------- a timestamp deep link (issue #30) ----------

   `#/episode/<id>?t=4050` opens that episode's page with a "Play from 1:07:30"
   button; `#/play/<id>?t=4050`, the spelling issue #30 writes, is an alias and
   is rewritten to the canonical one in place (replaceHash: no extra history
   entry, so ‹ and the back gesture do not bounce off the alias).

   THE PAGE, NOT THE PLAYER. A cold load never starts audio by itself: a
   WebView refuses media that no gesture started, and the native shell reopens
   its last route on a relaunch (cp_last_route), where a link that played on
   arrival would replay every time the app came back. So the link lands on the
   page and the button is the gesture. The button is an ordinary `data-ts`
   control, handled by bindEpisodeSeeks — the one start path, with the stamp
   as the START offset (races-1), so a tap during load begins at the stamp
   rather than seeking after.

   `t` is whole seconds (`4050`, `4050.9` floors) or a clock stamp (`1:07:30`).
   Anything else — negative, empty, a word, a broken escape — is ignored and the
   page renders as a plain episode page. The first `t=` wins. */
const EPISODE_DEEPLINK_RE = /^#\/(episode|play)\/([^?]+)(?:\?(.*))?$/;

/** `{ seg, t }` for a timestamp link (seg still encoded, t whole seconds or
    null), or null — including for a plain `#/episode/<id>`, which is the
    router's ordinary episode route. Producers encode the id, so a raw `?` is
    always the start of the query. */
function episodeDeepLink(hash) {
  const m = EPISODE_DEEPLINK_RE.exec(String(hash || ""));
  if (!m) return null;
  const [, kind, seg, query] = m;
  if (kind === "episode" && query === undefined) return null;
  return { seg, t: deepLinkOffset(query) };
}

/** The `t=` of a query string as finite, non-negative whole seconds, or null. */
function deepLinkOffset(query) {
  if (!query) return null;
  for (const pair of String(query).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== "t") continue;
    const raw = safeDecode(pair.slice(eq + 1)).trim();
    const secs = /^\d{1,9}(?:\.\d+)?$/.test(raw) ? Math.floor(Number(raw)) : parseTimestampSeconds(raw);
    return Number.isSafeInteger(secs) && secs >= 0 ? secs : null;
  }
  return null;
}

/** The canonical address of a timestamp link: the episode route, plus `?t=N`
    only when N is a real offset. */
function episodeDeepLinkHash({ seg, t }) {
  return `#/episode/${seg}${t === null || t === undefined ? "" : `?t=${t}`}`;
}

/** Is a timestamp link's target exact for this item? seekPrecision's answer
    (player/seek-policy.js) for a FOREIGN stamp with no durations to compare —
    a link was made against somebody else's copy: a downloaded file is exact
    (its timeline is frozen), a static enclosure is exact, a stitched (DAI)
    stream is approximate. app.js is a classic script and cannot import that
    module, and client.js does not publish it; this is the same two-input rule,
    read from the same fields. */
function deepLinkPrecise(item) {
  if (!item || !item.dai_suspected) return true;
  try {
    const rec = downloadsValue().items[item.id];
    return !!rec && rec.status === "done";
  } catch (_) {
    return false;
  }
}

/** The episode page's "Play from <stamp>" button for a timestamp link, or "".
    Approximate targets read "~1:07:30" (issue #30: "visibly approximate"), and
    say "about" to a screen reader, which would otherwise read the tilde. A
    target past the episode's known end draws nothing — the same honesty guard
    the notes' stamps keep — and the page is otherwise the plain episode page. */
function playFromHtml(item, t) {
  if (t === null || t === undefined || !Number.isSafeInteger(t) || t < 0) return "";
  if (!item || !item.audio_url) return "";
  const dur = itemDurationSec(item, { upperBound: true });
  if (dur !== null && t > dur) return "";
  const stamp = fmtChapterTime(t);
  const precise = deepLinkPrecise(item);
  const shown = precise ? stamp : `~${stamp}`;
  const label = precise ? `Play from ${stamp}` : `Play from about ${stamp}`;
  return `<div class="ep-play-from"><button type="button" class="up-next ep-play-from-btn${precise ? "" : " is-approximate"}" data-ts="${esc(String(t))}" aria-label="${esc(label)}">Play from ${esc(shown)}</button></div>`;
}

/* THE NATIVE SHELL REOPENS WHERE YOU LEFT (audit round 2, nav-10; founder
   question 11, default ruling). The route lived only in the URL hash, and a
   cold relaunch after iOS or Android tore the WebView down loads the bundled
   page with no hash — so a listener who backgrounded 4a on a show page came
   back to Home. Apple Podcasts reopens on the screen you left.

   The shell ONLY. On the web a bare URL means Home on purpose (qa 132): a
   shared or typed address is an arrival, not a return, and a reload keeps its
   hash anyway. So the route is filed only inside the shell, and read back only
   there, only for a bare arrival — a deep link the shell was opened with
   (a `?foray=` link, a notification) is where the listener asked to go. It is
   a cold open all the same: no stamp behind it, so ‹ keeps its href fallback. */
const LAST_ROUTE_KEY = "cp_last_route";

function rememberRouteForRelaunch(hash) {
  if (!isNativeShell()) return;
  /* NOT DURING A DELETION (audit round 2 review). deleteMyData repaints the
     page under its sheet with route() straight after reporting "This device is
     clear", and the purge had just emptied this key — so in the shell every
     successful deletion put a cp_ key back, the exact thing it already avoids
     buildCards() for. The next real navigation records the route again. */
  if (ddBusy || dataDeletionInProgress) return;
  if (lsGet(LAST_ROUTE_KEY, null) !== hash) lsSet(LAST_ROUTE_KEY, hash);
}

/** The route a bare native arrival reopens, or "#/". Only one of this app's
    own hash routes is accepted — the stored value is ours, but it is read
    back into the address bar, so it is checked like any input. */
function relaunchRoute() {
  if (!isNativeShell()) return "#/";
  const last = lsGet(LAST_ROUTE_KEY, null);
  return typeof last === "string" && /^#\/[^\s]*$/.test(last) && last.length <= 2048 ? last : "#/";
}

/* WHICH RENDER IS ON SCREEN (audit 2026-09-22, theme B). Async work used to ask
   "is something still on screen?" — `!!$("#view [data-show-episodes]")` — which
   every show page answers yes to, so show A's episodes, description and count
   painted onto show B's page when B was opened while A's fetch was in flight.
   The question is "is the render that asked still the current one?", and the
   answer is a number: renderCurrentPage() increments it, and every async
   continuation compares the value it captured. */
let renderEpoch = 0;

/** Capture the current render; the returned function answers whether it is
    still the one on screen. */
function renderToken() {
  const mine = renderEpoch;
  return () => mine === renderEpoch;
}

/* Replace the current entry's hash WITHOUT a hashchange and without dropping
   the entry's history state (the step index below lives there). Every
   in-place hash rewrite in this file goes through here — a bare
   `history.replaceState(null, …)` would erase the index and turn the next
   back-step into a "forward". Returns whether the write took. */
function replaceHash(hash) {
  try {
    history.replaceState(history.state ?? null, "", `${location.pathname}${location.search}${hash}`);
    /* A harness (or an embedder) that does not reflect replaceState into
       location.hash would leave the router reading the old one. */
    if (location.hash !== hash) location.hash = hash;
    return true;
  } catch (_) {
    return false;
  }
}

/** Rewrite the page-on-screen's own address to a new spelling of the SAME page
    (a search query joining or leaving it) — no render, no history entry. The
    router's own record of the entry follows it, so the scroll position is
    remembered under the address a later back-step will actually arrive at. */
function rewriteRouteInPlace(hash) {
  if (currentHash() === hash) return;
  if (!replaceHash(hash)) return;
  if (renderedHash !== null) {
    const y = navScrollY.get(renderedHash);
    const rails = navRailX.get(renderedHash);
    /* The same page under a new spelling: a name it still owed is still owed
       to IT, and one already said is not said again as the query changes. */
    if (announceOwedFor === renderedHash) announceOwedFor = hash;
    if (paintedHash === renderedHash) paintedHash = hash;
    renderedHash = hash;
    if (rails !== undefined) navRailX.set(hash, rails);
    if (y !== undefined) navScrollY.set(hash, y);
  }
  if (navIndex !== null) navHashes[navIndex] = hash;
}

/* THE HEADER'S ↻ REFRESHES THE PAGE YOU ARE ON (audit 2026-09-22; founder
   default R9). It re-dealt Home's suggestions and then NAVIGATED to Home from
   whatever page it was pressed on — the glyph every listener reads as "reload
   this" threw away the show list, the typed search and the scroll offset.
   Home still gets new suggestions, because that is what refreshing Home means;
   every other page re-renders in place (a show page re-asks for its episodes)
   and keeps its scroll position, through the same clamped-restore path a
   back-step uses. */
function refreshCurrentPage() {
  if (isHomeRoute()) {
    buildCards();
    logEvent("refreshed_all", {});
    renderCurrentPage();
    scrollPageTo(0);
    return;
  }
  const y = window.scrollY || 0;
  renderCurrentPage();
  if (y > 0) {
    scrollPageTo(y);
    if ((window.scrollY || 0) < y - 1) pendingRestore = { hash: renderedHash, y, at: Date.now() };
  }
}

/* A restore route() could not complete because the page had not painted yet.
   See route(). */
let pendingRestore = null;

/* HOW LONG A RESTORE MAY BE OWED (review 2026-09-23). The show page, the Foray
   page and (audit round 2, nav-3) the Search page once its last pass settles
   call pageDidPaint(); a "Show not found" page, a failed Foray and a search
   whose request hangs never do. Their clamped restore stayed owed for the
   whole visit, so every scroll on it was ignored and the next ‹ went back to
   the stale offset. A page slow enough to outlive this is one the listener has
   started using anyway. */
const PENDING_RESTORE_MS = 4000;

/** Is a clamped restore still waiting for its page? Expires, so memory always
    resumes — see PENDING_RESTORE_MS. */
function restoreStillOwed() {
  if (!pendingRestore) return false;
  if (!(Date.now() - (pendingRestore.at || 0) <= PENDING_RESTORE_MS)) {
    pendingRestore = null;
    return false;
  }
  return true;
}

/** The listener touched, wheeled or keyed the page: where they scroll from here
    is theirs, not a clamp, so the owed restore is dropped and memory resumes. */
function abandonPendingRestore() { pendingRestore = null; }

/** Called by an async page once its REAL content is on screen (the terminal
    paint: loaded, empty or failed — never "loading"). Re-applies a back-step's
    scroll restore that the loading paint clamped. One attempt: whatever the
    page's final height allows is the answer, and memory resumes after it. */
function pageDidPaint() {
  /* The page's real header is on screen now: publish ITS height (see
     publishRenderedPageHead), whether or not a restore is owed. */
  publishRenderedPageHead();
  /* ...and its real name: an async page's "Loading…" head is gone. Focus only
     moves if the loading paint took it with it (see landOnPage). */
  landOnPage({ navigated: false });
  const pending = pendingRestore;
  pendingRestore = null;
  if (!pending || pending.hash !== renderedHash) return;
  scrollPageTo(pending.y);
}

/* ---------- where a list was left, so ‹ can put you back ----------

   Recorded continuously rather than at the moment of navigation, because by
   the time `hashchange` fires on a back-step the browser may already have
   moved the viewport — the position we want is gone before anything here runs.
   The scroll listener already installed for the collapsing header ticks once
   per animation frame, so this costs one Map write per frame of scrolling and
   nothing at all when nobody is scrolling.

   Keyed by hash, so it also survives a route being reached twice by different
   paths, and unbounded only in the sense that the app has a fixed, small set
   of routes plus one entry per show/episode/playlist actually visited in a
   session — the same cardinality `navHashes` already lives with. */
const navScrollY = new Map();
let renderedHash = null;

function rememberScrollPosition() {
  /* Not while a restore is still owed: the clamped position on screen is the
     failure, not a place the listener chose, and filing it would make the next
     ‹ fail too. */
  if (renderedHash === null || restoreStillOwed()) return;
  navScrollY.set(renderedHash, window.scrollY || 0);
}

/* ---------- ...and where each shelf was left, sideways ----------

   Audit round 2, perf-8: Home's rails (Jump back in, Forays for you,
   Playlists for you) are each their own horizontal scroll container, and every
   render rebuilds them at card one. So ‹ back to Home restored the page's
   height and threw away the shelf the listener had swiped to card four — and
   a settings switch or the late now-playing ribbon, which repaint Home in
   place, did the same without any navigation at all. Apple Podcasts keeps a
   shelf's offset.

   A rail's scroll is not a window scroll (it does not reach the listener
   above), so it is READ at the two moments it is about to be lost instead:
   route() files the page being left, and renderCurrentPage() carries the page
   it is repainting across its own rebuild. Keyed by the rail's section
   (`hv2-forays`, …), not its position, so a rail that appears above another
   (Jump back in after a first play) does not hand its offset to the next. */
const navRailX = new Map();
/** The hash whose render is in #view right now — which is not `renderedHash`
    during route(), where that already names the page about to be drawn. */
let paintedHash = null;

function railKey(rail, i) {
  const section = typeof rail.closest === "function" ? rail.closest("section") : null;
  const cls = section ? String(section.className || "").split(/\s+/).find(c => c && c !== "hv2-section") : "";
  return cls || `rail-${i}`;
}

/** `{ key: scrollLeft }` for every shelf on screen that is not at its start. */
function railOffsets() {
  const view = $("#view");
  const rails = view && typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(".td-rail")] : [];
  const out = {};
  rails.forEach((rail, i) => {
    const x = Number(rail.scrollLeft) || 0;
    if (x > 0) out[railKey(rail, i)] = x;
  });
  return out;
}

function applyRailOffsets(offsets) {
  if (!offsets) return;
  const view = $("#view");
  const rails = view && typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(".td-rail")] : [];
  rails.forEach((rail, i) => {
    const x = offsets[railKey(rail, i)];
    if (x > 0) rail.scrollLeft = x;
  });
}

/* `window.scrollTo` is guarded because this file is also loaded under node:vm
   by several suites whose window stub has no scrolling at all — a router that
   throws there would take every one of them down for a cosmetic reason.

   `resetPageHeadScrollState()` afterwards re-baselines the collapsing header
   against the position we just moved to. Without it, landing at 1200 on a
   restored list reads as a 1200px downward scroll on the next real scroll
   event and collapses a header the listener never scrolled. */
function scrollPageTo(y) {
  try {
    if (typeof window.scrollTo === "function") window.scrollTo(0, y);
  } catch (_) { /* a viewport we cannot move is not a reason to lose the page */ }
  resetPageHeadScrollState();
}

/* ---------- in-app history: what the ‹ button does ----------

   Wyatt (2026-09-05, live bug report): the ‹ button jumped all the way to
   Home instead of one step back. Every page head renders a plain
   `<a class="back" href="#/">` link, which always followed that literal
   href — Shows -> a show -> an episode -> ‹ landed on the four cards, not
   on the show, exactly as reported.

   The browser already holds the right answer: routing is hash-only, every
   navigation pushes one `hashchange`-triggering history entry, and
   `history.back()` replays it. So the fix is to call `history.back()`
   INSTEAD of following the link whenever there is an in-app step to go
   back to, and to let the `#/` href stand otherwise. That fallback is the
   cold-open case — a deep link opened fresh (`#/show/x` from a share, a
   `?foray=` link) has no in-app history behind it, and `history.back()`
   there would leave the app entirely or do nothing. Home is the right
   landing for that case.

   WHICH KIND OF STEP THIS IS COMES FROM THE HISTORY ENTRY ITSELF (audit
   2026-09-22). It used to be inferred from the SHAPE of a stack of hashes:
   "landing on the hash two steps back is a back-step". That is also exactly
   what a forward tap onto the page two steps back looks like — Search tab ->
   a show -> the Search tab again — so a tab tap restored an old scroll offset
   instead of starting at the top, and silently shortened the stack by one.
   The stack shape cannot tell those apart; the browser can. So route() stamps
   every entry it renders with its position, `{ fyIdx: n }`, in the entry's own
   `history.state`, which the browser hands back when that entry is returned
   to — by ‹, a device back gesture, or the forward button alike:

     no stamp        a NEW entry (a link, a tab, a typed hash): one step on.
     stamp < ours    the browser went BACK to an entry we rendered before.
     stamp > ours    the browser went FORWARD to one.
     stamp == ours   the same entry: a re-render, or an in-place hash rewrite.

   `history.state` survives a reload, so after one the stamp is still there and
   ‹ still goes back one real step; a genuinely cold open has no stamp, starts
   at 0, and keeps the href fallback. */
let navIndex = null;          // the stamp of the entry on screen; null before the first route
const navHashes = [];         // what each stamped entry showed this page-life, by stamp

function historyIndex() {
  try {
    const st = history.state;
    return st && Number.isInteger(st.fyIdx) ? st.fyIdx : null;
  } catch (_) {
    return null;
  }
}

function stampHistory(idx) {
  try {
    const st = history.state && typeof history.state === "object" ? history.state : {};
    history.replaceState({ ...st, fyIdx: idx }, "");
  } catch (_) { /* an entry we cannot stamp reads as new next time: forward, the safe default */ }
}

/** Records the step and REPORTS WHICH KIND IT WAS: "back", "forward", or
    "same" (the entry on screen, re-rendered). An in-place rewrite of the entry
    on screen to a different hash is "forward": it is a new page. */
function noteNavigation(hash) {
  backPending = false;
  const h = hash || "#/";
  const stamped = historyIndex();
  let step;
  if (navIndex === null) {
    navIndex = stamped ?? 0;
    step = "forward";
  } else if (stamped === null) {
    navIndex += 1;
    navHashes.length = navIndex;   // a new entry discards the forward branch, as the browser does
    step = "forward";
  } else if (stamped < navIndex) {
    navIndex = stamped;
    step = "back";
  } else if (stamped > navIndex) {
    navIndex = stamped;
    step = "forward";
  } else {
    step = navHashes[navIndex] === h ? "same" : "forward";
  }
  navHashes[navIndex] = h;
  if (stamped !== navIndex) stampHistory(navIndex);
  return step;
}

function canGoBackInApp() { return (navIndex ?? 0) > 0; }

/* `history.back()` is asynchronous — the `hashchange` that actually lands the
   step comes a beat later. A second tap on ‹ inside that beat would call
   `history.back()` twice, overshooting by one page. `backPending` makes it one
   step per tap no matter how fast the taps land; `noteNavigation` (called
   from every route()) clears it once the step has actually happened. */
let backPending = false;

/* After removing a playlist: back to the list, and never with the removed
   playlist's entry left where ‹ can reach it (audit 2026-09-22 — this handled
   one referrer, so from Home, Library or the drawer the NEXT ‹ landed on
   "Playlist not found" for the thing just deleted).

   When the list is the entry immediately behind this page (Playlists -> this
   playlist), that is `history.back()`. From anywhere else the removed
   playlist's own entry is REWRITTEN to the list in place, so it is not left
   buried one step behind it. */
function leaveRemovedPlaylist() {
  if (canGoBackInApp() && navHashes[navIndex - 1] === "#/playlists") {
    backPending = true;
    history.back();
    return;
  }
  if (replaceHash("#/playlists")) route();
  else location.hash = "#/playlists";
}

/* Delegated from #view (bound once in init(), see below) rather than bound
   per-render: every page-rendering function replaces #view's innerHTML
   wholesale, and a per-render listener would have to be repeated in every
   one of them for no benefit — a click on `a.back` means the same thing on
   every page. Only that class is handled; anything else falls through
   untouched (the drawer, play buttons, star toggles, etc. bind their own
   listeners exactly as before). */
function onBackClick(e) {
  const a = e.target && typeof e.target.closest === "function" ? e.target.closest("a.back") : null;
  if (!a || !canGoBackInApp()) return;   // cold open: the href="#/" fallback stands
  e.preventDefault();
  if (backPending) return;               // the previous tap's step has not landed yet
  backPending = true;
  history.back();
}

/* A STEP BETWEEN TWO ENTRIES WITH THE SAME HASH (audit round 2, nav-1). The
   browser fires `popstate` for every traversal but `hashchange` only when the
   fragment differs, and this router listened only for the second. Two
   neighbouring entries can share a hash — a search retyped after a tab tap is
   rewritten in place to the entry behind it (rewriteRouteInPlace), and a
   removed playlist after a reload is rewritten to the list behind it
   (leaveRemovedPlaylist cannot see behind a reload) — and ‹ onto such an
   entry never reached route(): `backPending` stayed set and every later ‹
   was swallowed until some link was tapped.

   So a popstate that lands on the hash already rendered routes itself, and
   only then: when the hash differs, the hashchange that follows is the one
   route() call (route() is not made to run twice for one step), and a popstate
   that did not move between entries this router stamped (a browser's
   load-time popstate, an unstamped entry) is not a step at all. */
function onPopState() {
  if (currentHash() !== renderedHash) return;
  const stamped = historyIndex();
  if (stamped === null || stamped === navIndex) return;
  route();
}

/* ---------- collapsing page header: show/hide on scroll direction ----------

   Wyatt (2026-09-05, live bug report): the ‹ header bar collapsing out of
   view while scrolling DOWN a long episode list is intentional and "feels
   nice" — it is `.page-head`'s `position: sticky` leaving the viewport once
   `.page-head-hidden` translates it up (see styles.css). The bug is that it
   never came back except by scrolling all the way back to the literal top
   of the page, which on a show with hundreds of episodes is a real dead
   end: there was no reappear-on-scroll-up behavior at all, only the
   scroll-position-zero case sticky/CSS gives you for free.

   Standard mobile pattern, implemented directly rather than via a library
   given the app's no-build-step, single-file-classic-script shape: compare
   this scroll event's `window.scrollY` against the last one seen. Moving
   down past a small dead zone (SCROLL_HIDE_DELTA, so normal reading
   micro-jitter and rubber-band bounce don't flicker the bar) hides it;
   moving up by any amount shows it again immediately, at any scroll
   position — not just at the top. Near the very top (within the header's
   own height) it always shows, so it can never hide itself out from under
   a user who just landed on the page. */
const SCROLL_HIDE_DELTA = 10; // px of downward movement before hiding, to absorb jitter/bounce
let lastScrollY = 0;
let pageHeadHiddenNow = false;

function currentPageHead() { return $("#view .page-head"); }

function setPageHeadHidden(hidden) {
  if (hidden === pageHeadHiddenNow) return;
  pageHeadHiddenNow = hidden;
  const head = currentPageHead();
  if (head) head.classList.toggle("page-head-hidden", hidden);
  publishPageHeadHeight(head);
}

/* THE HEADER'S HEIGHT, FOR WHATEVER ELSE STICKS BENEATH IT (audit 2026-09-22,
   "A Foray page's sticky transport pins behind the sticky page header").
   `.page-head` and the Foray page's `.fy-transport` are siblings that both
   stick at the topbar's offset. Scrolling down hides the header and the
   transport pins where it was — right. Scrolling UP brings the header back
   (the behaviour Wyatt asked for, above) ON TOP of the transport, so the
   resume line and the top of the strip vanish under an opaque bar exactly when
   the listener has come back to use them. styles.css pins a visible header's
   later siblings at topbar + THIS height; a hidden header reserves nothing.
   Written on the header's own parent (a CSSOM write, CSP-safe), so a page
   whose content never reads it pays one property; and on every toggle rather
   than once per render, because the title can wrap differently after a
   rotation. `offsetHeight` ignores the hide transform, so either state
   measures the same box. */
/**
 * Publish the height of the header of the page NOW in #view (review
 * 2026-09-23). `resetPageHeadScrollState()` runs BEFORE a render replaces
 * #view, so it measured the outgoing page's header (or none) and wrote to that
 * header's soon-discarded page; `setPageHeadHidden(false)` returns early while
 * the header is already showing. So a new Foray page had no --page-head-h
 * until the header first HID, and a slow first scroll slid the transport under
 * the visible header — the audited bug. Called after the synchronous render
 * (renderCurrentPage) and after an async page's terminal paint (pageDidPaint).
 */
function publishRenderedPageHead() {
  publishPageHeadHeight(currentPageHead());
}

function publishPageHeadHeight(head) {
  const page = head && head.parentElement;
  if (!page || !page.style || typeof page.style.setProperty !== "function") return;
  const h = Math.round(Number(head.offsetHeight) || 0);
  page.style.setProperty("--page-head-h", `${h}px`);
}

/* A deliberate downward scroll puts the keyboard away (founder, 2026-09-14:
   "when I scroll, the keyboard should naturally collapse"). Standard iOS list
   behaviour, and what Apple Podcasts does on the screen this was reported
   against.

   WHY IT HANGS OFF THE HEADER'S HANDLER RATHER THAN A LISTENER OF ITS OWN.
   The question is the same question — "has the user just moved the page
   down past the dead zone" — and the answer is already computed, once per
   animation frame, by the one throttled `scroll` subscription `init()`
   registers. A second listener for one fact is how the two drift out of step
   (the comment on `rememberScrollPosition`'s piggy-back beside it makes the
   same argument for the same reason), and on a long episode list it is also a
   second handler running on a path that has to stay cheap.

   THE DEAD ZONE IS REUSED, NOT RE-PICKED. `SCROLL_HIDE_DELTA` already encodes
   "more movement than reading micro-jitter and rubber-band bounce", which is
   exactly the threshold this needs, and a second constant for the same
   judgement would let the header collapse and the keyboard dismiss at
   different flicks of the same thumb.

   THE SETTLE WINDOW IS THE PART THAT IS NOT OBVIOUS, and it is the one that
   makes a naive version of this feature unusable. On iOS the keyboard's own
   appearance moves the viewport, and the page fires `scroll` (and `resize`)
   as it does — so at the moment of focus, "the user scrolled down" and "the
   keyboard just opened" are indistinguishable from here. With no guard, the
   first frame after focus dismisses the keyboard the user has just asked
   for, every time, and the field reads as broken. `showSearchFocusedAt` plus
   `KB_SETTLE_MS` ignores movement until the keyboard has had time to finish
   arriving; the focus handler additionally re-baselines `lastScrollY` so the
   first delta measured after the window is a real one.

   NOT PROVEN OFF A PHONE, and this is the item most in need of one: that
   350ms actually covers the iOS keyboard animation on a cold first open
   (Apple's own animation is ~250ms, but the first open of a session also
   builds the keyboard). What IS proven here is the rule and the guard —
   scrolling down during the window does nothing, scrolling down after it
   blurs, scrolling up never blurs.

   UPWARD SCROLLING DELIBERATELY DOES NOT DISMISS. Same asymmetry the header
   already has: down is "I want to see more of the page", up is "I am coming
   back", and pulling the keyboard down on a user who is scrolling back
   toward the field they are typing in would be the opposite of natural. */
const KB_SETTLE_MS = 350;

function maybeDismissKeyboardOnScroll(delta) {
  if (!showSearchFieldFocused) return;
  if (delta <= SCROLL_HIDE_DELTA) return;
  if (Date.now() - showSearchFocusedAt < KB_SETTLE_MS) return;
  const input = $("#sh-input");
  /* Blur only. NOT dismissShowSearch: the query and the results it produced
     are what the listener scrolled down to read, and throwing them away
     would make a scroll destructive. The blur alone is enough for everything
     that has to follow — the keyboard goes, and the field's own blur handler
     puts the tab bar back through the one predicate. */
  if (input && typeof input.blur === "function") input.blur();
}

function onWindowScroll() {
  const y = window.scrollY || 0;
  const head = currentPageHead();
  /* Computed and consumed BEFORE the no-page-head early return below: the
     keyboard rule is about the window, not about this page's header, and a
     page that happens to have no `.page-head` must not silently opt out of
     it. (#/shows does have one today; depending on that is how this would
     quietly stop working the day the search page's chrome changed again.) */
  const delta = y - lastScrollY;
  maybeDismissKeyboardOnScroll(delta);
  if (!head) { lastScrollY = y; return; } // no page head on this page (e.g. home) — nothing to do
  if (y <= head.offsetHeight) {
    setPageHeadHidden(false);           // never hide near the very top of the page
  } else if (delta > SCROLL_HIDE_DELTA) {
    setPageHeadHidden(true);            // scrolling down past the dead zone: collapse
  } else if (delta < 0) {
    setPageHeadHidden(false);           // any upward movement: reappear immediately
  }
  lastScrollY = y;
}

/* A fresh page (new navigation, or the same page's own re-render) starts
   with its header visible and a clean scroll baseline — otherwise a header
   left hidden by the PREVIOUS page's scroll position would render already
   collapsed on a brand new page the user has not scrolled on yet. Called
   from renderCurrentPage() below, once per page render. */
function resetPageHeadScrollState() {
  pageHeadHiddenNow = false;
  lastScrollY = window.scrollY || 0;
  const head = currentPageHead();
  if (head) head.classList.remove("page-head-hidden");
  publishPageHeadHeight(head);
}

/* ---------- init ---------- */

/* BOUNDED (audit round 2, states-4 / races-7). The 2026-09-23 "no request
   waits forever" review gave `fetchApiJson` and the two search documents a
   deadline and left this one bare, on the reasoning that `data/*.json` is
   answered by the worker (NET_TIMEOUT_MS) or the bundle. A first web visit has
   no worker yet, and a pinned page or a shell with a missing file goes to the
   network — so "Loading 4a…" and the Foray page's Try again (retryForayDocs)
   could both wait on a black-holed socket for good. Past the bound the answer
   is the same `null` a failure gives, which every caller already treats as
   "absent", so the existing failed states and their Try again become
   reachable.

   ONE ARGUMENT, DELIBERATELY: `tools/mobile/prepare-webdir.mjs` derives the
   native bundle's data-file list from each `fetchJson` call's one quoted
   data/ path (and counts the call sites, so this comment names no call), so
   the bound is chosen from the path here rather than passed in.
   `let`, so a suite can shorten them. */
let DATA_DEADLINE_MS = 30000;
/* The boot document gets longer: its failure already offers Try again, and a
   slow-but-working first visit told "Couldn't load 4a" is the wrong trade. */
let BOOT_DEADLINE_MS = 45000;

function dataDeadlineMs(path) {
  return /(^|\/)session\.json$/.test(String(path)) ? BOOT_DEADLINE_MS : DATA_DEADLINE_MS;
}

async function fetchJson(path) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const attempt = (async () => {
    try {
      const res = await fetch(pinnedUrl(path), ctl ? { cache: "no-cache", signal: ctl.signal } : { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch (_) { return null; }
  })();
  return withDeadline(attempt, dataDeadlineMs(path), () => {
    try { if (ctl) ctl.abort(); } catch (_) { /* nothing left to free */ }
    return null;
  });
}

/* A3.1/Q3: a plain, unpinned fetch for /api/* backend endpoints — deliberately
   a separate helper from fetchJson, not a reuse of it. fetchJson pins every
   call to the deploy generation (pinnedUrl) because data/*.json is a static,
   versioned build artifact; /api/* is a live serverless function with no
   deploy-generation concept to pin against. Keeping this a distinct function
   (rather than making fetchJson conditionally skip pinning) also keeps
   tools/mobile/prepare-webdir.mjs's runtimeDataFiles() derivation correct —
   that scanner matches every literal fetchJson call against a data/*.json
   path to build the native bundle's data-file manifest, and pointing that
   same call at api/shows/search would incorrectly need to be either bundled
   as data or special-cased out. Same swallow-errors-to-null contract as
   fetchJson, so callers don't need their own try/catch for a down or
   unreachable endpoint. */
async function fetchApiJson(path) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const attempt = (async () => {
    try {
      const res = await fetch(apiUrl(path), ctl ? { cache: "no-cache", signal: ctl.signal } : { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch (_) { return null; }
  })();
  /* A deadline, then the same `null` a failure gives (see withDeadline). */
  return withDeadline(attempt, API_DEADLINE_MS, () => {
    try { if (ctl) ctl.abort(); } catch (_) { /* nothing left to free */ }
    return null;
  });
}

/* NO REQUEST WAITS FOREVER (review 2026-09-23). A stalled socket — a captive
   portal, a cell dead zone — never answers and never throws, so a bare `fetch`
   never settles, and every state that waits on one ("Searching for …",
   "Still looking for playlists…", a disabled "Building…") could spin for good,
   with no way to reach its failed state and its Try again. The loading rule is
   that loading ends as loaded, failed or empty; these deadlines are what make
   "failed" reachable. `let`, so a suite can shorten them. */
let API_DEADLINE_MS = 15000;
/* The two search documents are ~0.5 MB together and are fetched after the first
   paint; generous, so a slow connection still gets them. On expiry a build runs
   with the degraded scorer, as it does when they fail. */
let SEARCH_DATA_DEADLINE_MS = 30000;

/** `promise`, or `onLate()`'s value once `ms` pass without an answer. */
function withDeadline(promise, ms, onLate) {
  let timer = null;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(onLate()), ms); });
  return Promise.race([promise, late]).then(
    (v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; });
}

/* ---------- the Foray directory (FD-03; FD-01 for the diagnostics row) ----------

   WHY A PHONE NEEDED A STORE BUILD FOR A NEW FORAY, and why it no longer does.
   The native shell loads `data/forays.json`, `data/segments.json` and
   `data/segment-sources.json` from its own package (tools/mobile/prepare-webdir.mjs
   copies them in), so a merge to `main` reached the web the same minute and the
   phone never. The directory is the live site's same three files, versioned by
   the deploy id they shipped with, reachable through a small pointer
   (`data/forays-directory.json`, written by tools/ci/generate-manifest.mjs).

   The whole mechanism lives in `player/foray-directory.js`, bridged over
   `window.forayDirectory` because this file cannot import it. What THIS file
   decides is the ORDER, and the order is the design:

     1. `directory.start()` before the bundle fetches — the cache read overlaps
        them.
     2. `bootForayDirectory()` after they land and BEFORE `route()` — the cached
        set, if it validates, is what the first paint shows; otherwise the seed
        just fetched. No network here.
     3. `refreshForayDirectory("boot")` AFTER `route()`, never awaited — the
        pointer fetch cannot hold the first paint; and again on every return to
        the foreground, throttled inside the module.

   A newer set is swapped into `state` and the Foray surfaces re-render — the
   list, a Foray page, a show page's "in these Forays" footer, Home's rail. Nothing
   touches the player: a queue already playing keeps its items and its playhead
   (FD-05, pinned in test/foray-directory.test.js), and a Foray that vanished
   from the new set reads `dropped` on its resume row rather than crashing.

   THE WEB IS PINNED, THE SHELL IS NOT. A page the worker pinned to a retained
   generation (`pinnedDeployId`, #233) is running last-known code against that
   generation's data on purpose, and swapping a fresher set under it would be
   exactly the mismatched pair the pin exists to prevent — so a pinned page
   neither boots from the cache nor refreshes. Everywhere else, including the
   ordinary web, the directory runs; on the web it is belt-and-braces to the
   worker's network-first `data/`, and the sets normally agree. */

const FORAY_DIRECTORY_POINTER = "data/forays-directory.json";

function forayDirectoryBridge() {
  const d = window.forayDirectory;
  return d && typeof d.boot === "function" && typeof d.refresh === "function" ? d : null;
}

/** The three documents, swapped as one. They are ONE artifact (the join in
    player/foray-resolve.js reads all three), so no reader can see a Foray list
    from one version and a segment pool from another. */
function applyForaySet(set) {
  state.forays = set.forays ?? null;
  state.segments = set.segments ?? null;
  state.segmentSources = set.sources ?? null;
}

/** "Try again" behind a Foray page that could not load its documents (audit
    2026-09-22, theme G): the same three fetches `init()` made, swapped in as one
    set through the one swap, then the page repainted. Adopted only when ALL
    THREE came back (review 2026-09-23: it checked only the list, so a retry
    whose segments.json failed adopted a set with no segment pool, and the page
    said "N clips from this foray couldn't be found" — a network failure painted
    as a fact about the content, with its Try again gone). A second failure
    lands on the same failed state, with a fresh Try again. */
/* Pressed once, the button says so (audit round 2, races-7): it is bound
   `{ once: true }`, so without this a tap on a dead-zone connection changed
   nothing on screen and left a spent button. */
const RETRYING_LABEL = "Trying again…";

async function retryForayDocs() {
  /* THE PAGE THAT ASKED IS THE ONLY PAGE THAT REPAINTS (audit round 2, races-7).
     The three fetches are bounded now (fetchJson), but tens of seconds is still
     long enough to give up on a dead Try again and go type a Search query —
     and this used to `renderCurrentPage()` whatever was on screen when they
     finally settled, dropping that query and the keyboard. So the render epoch
     is captured before the await: a set that arrived whole repaints only a
     Foray surface (through the same in-place path a directory refresh uses);
     a set that did not repaints only the page that pressed the button, so its
     Try again is re-armed. Anything else keeps its DOM. */
  const stillHere = renderToken();
  const btn = $("#view [data-retry]");
  if (btn) { btn.disabled = true; setControlLabel(btn, RETRYING_LABEL); }
  const [forays, segments, sources] = await Promise.all([
    fetchJson("data/forays.json"),
    fetchJson("data/segments.json"),
    fetchJson("data/segment-sources.json"),
  ]);
  if (forays && segments && sources) {
    applyForaySet({ forays, segments, sources });
    if (isForaySurface(location.hash)) repaintForaySurface();
    return;
  }
  if (stillHere()) renderCurrentPage();
}

/** Where the seed came from, for the diagnostics row: in the shell it is the
    package; on the web it is the origin (the worker is network-first), unless
    the worker pinned this page to a retained generation. */
function seedDataSource() {
  if (pinnedDeployId) return "sw-cache";
  return isNativeShell() ? "bundle" : "network";
}

function noteDataSource(fields) {
  if (typeof window.forayNoteDataSource !== "function") return false;
  try { return Boolean(window.forayNoteDataSource(fields)); } catch (_) { return false; }
}

/**
 * Choose what the first paint shows: the cached directory if it validates, else
 * the seed already in `state`. Never the network. Always writes FD-01's row.
 */
async function bootForayDirectory(directory) {
  /* Handed WHOLE to the directory, which validates it through the same join the
     player uses (player/foray-resolve.js) and never enumerates the pool — the
     premise test in tools/mobile/prepare-webdir.test.mjs allows exactly this
     shape and the swap in applyForaySet, and nothing else. */
  const seed = { forays: state.forays, segments: state.segments, sources: state.segmentSources };
  let held = null;
  if (directory && !pinnedDeployId) {
    try { held = await directory.boot({ seed }); } catch (_) { held = null; }
  }
  if (held && held.source === "cache") applyForaySet(held);
  const chosen = held && held.source === "cache" ? held : seed;
  const source = held && held.source === "cache" ? "cache" : seedDataSource();
  const version = held && held.version ? held.version : (pinnedDeployId || "unknown");
  const tag = `${source}@${version}`;
  noteDataSource({
    phase: "boot", status: held ? held.why : (pinnedDeployId ? "pinned" : "no-directory"),
    source, version,
    files: {
      forays: chosen.forays ? tag : "absent",
      segments: chosen.segments ? tag : "absent",
      sources: chosen.sources ? tag : "absent",
    },
    forays: Array.isArray(state.forays?.forays) ? state.forays.forays.length : 0,
  });
}

/** Which pages read the three documents. Anything else keeps its DOM. */
function isForaySurface(hash) {
  const h = hash || "#/";
  /* `#/library` since Library grew a Forays section (review 2026-09-23): a
     foreground refresh that adopted a new set left its list stale. */
  return h === "#/" || h === "#/forays" || h === "#/library" || /^#\/(foray|show)\//.test(h);
}

/* WHAT THE PAGE ON SCREEN SHOWS OF THE FORAY SET, as a string to compare
   (audit 2026-09-22). A foreground refresh that adopted a newer set used to
   re-render the whole show or Foray page under the listener — dropping a typed
   episode search and the keyboard, collapsing every expanded script, and
   moving the scroll offset onto different content — whether or not anything
   this page shows had changed. Most adoptions change nothing here. */
function foraySurfaceSignature() {
  try {
    const r = parseShowRoute();
    if (r) {
      const show = showById(r.id);
      return show ? showForaysHtml(show) : "";
    }
    if (currentHash() === "#/library") return libraryForaysHtml();
    const id = forayRouteId();
    if (id) {
      const r = window.ForayPlayer?.resolve?.(state.forays, {
        id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources, ...forayViewOpts(),
      });
      return JSON.stringify(r ?? null);
    }
    return JSON.stringify(forayCards());
  } catch (_) {
    return null;   // cannot tell: treated as unchanged, which keeps the listener's page
  }
}

/** Repaint only what the new set changed: on a show page that is its "Used in
    the following forays" footer, in place; anywhere else the page itself. */
function repaintForaySurface() {
  const r = parseShowRoute();
  if (r) {
    const slot = $("#view [data-show-forays]");
    const show = showById(r.id);
    if (slot && show) slot.innerHTML = showForaysHtml(show);
    return;
  }
  renderCurrentPage();
}

let _directoryRefreshing = null;

/**
 * Ask the directory for a newer set and, if one arrives whole, swap it in and
 * repaint the Foray surfaces. Never throws, never awaited by `init()`.
 */
function refreshForayDirectory(trigger) {
  const directory = forayDirectoryBridge();
  if (!directory || pinnedDeployId || !state.ready) return Promise.resolve(null);
  if (_directoryRefreshing) return _directoryRefreshing;
  _directoryRefreshing = (async () => {
    let out = null;
    try {
      out = await directory.refresh({ origin: API_ORIGIN, reason: trigger });
    } catch (_) {
      out = null;
    }
    if (out && out.status === "adopted" && out.set) {
      const before = foraySurfaceSignature();
      applyForaySet(out.set);
      if (isForaySurface(location.hash) && foraySurfaceSignature() !== before) repaintForaySurface();
    }
    return out;
  })().finally(() => { _directoryRefreshing = null; });
  return _directoryRefreshing;
}

/* ---------- the soft keyboard vs. the now-playing bar (founder, 2026-09-13) ----------

   THE REPORT, verbatim: "When I'm searching episodes on a show page, the now
   playing bar is down at the bottom behind the keyboard (good). When I start
   scrolling that now playing bar eventually moves up onto the top of the
   keyboard (bad). When the keyboard is present the now playing bar should not
   be visible."

   WHY IT MOVES, which is why the fix is not a CSS-only one. `#foray-player` is
   `position: fixed; bottom: 0`, and in WKWebView "fixed" is resolved against
   the LAYOUT viewport, which the keyboard does not shrink. So at the instant
   the keyboard opens the bar stays pinned to the bottom of the layout viewport
   — underneath the keyboard, exactly as Wyatt saw. The moment the page is
   scrolled, WebKit re-anchors fixed elements to the VISUAL viewport, and the
   bar snaps up to sit on the keyboard's top edge. Nothing about the element
   changed; the coordinate space it is measured in did. No `bottom`/`inset`
   value can fix that, because both positions are the same declared `bottom: 0`.

   So: detect the keyboard, and while it is up take the bar off the screen.

   HOW WE DETECT IT — what was already here, checked first. There is no
   `@capacitor/keyboard` in mobile/package.json and no keyboard handling
   anywhere in this file, so there was nothing to reuse. Adding the Capacitor
   plugin would mean a native dependency, a `cap sync`, and a rebuild of both
   platform projects for a chrome tweak — and it would still leave the same bug
   on the web build, where there is no bridge at all. `window.visualViewport` is
   the platform answer to precisely this question, ships in WKWebView (iOS 13+),
   in the Android WebView and on the mobile web, and needs nothing installed.

   The test is `innerHeight - visualViewport.height`: the layout viewport minus
   the visible one, i.e. how much of the window something is covering. A soft
   keyboard is the only thing that takes >120px, and `offsetTop` is deliberately
   NOT folded in — it moves on scroll and on pinch-zoom, which is the signal we
   must stay insensitive to, while `height` does not move on either.

   ANDed with "an editable element holds focus", because a soft keyboard cannot
   be up without one. That conjunct costs nothing when the report's own case is
   running (the search field IS focused) and it is what makes every other cause
   of a short visual viewport — an interstitial, a rotation mid-animation, a
   WebView that mis-reports during the splash fade — unable to hide the bar.

   IT MUST NEVER STICK. A bar that stays hidden after the keyboard closes is a
   worse bug than the one being fixed, so there are two independent ways back:
   `resize` on the visual viewport (the normal one — closing the keyboard fires
   it and the inset returns to ~0), and `focusout`, which clears the class
   outright once nothing editable holds focus, covering any WebView that closes
   the keyboard without a resize. Both call the same evaluator, and the class is
   only ever the computed answer — there is no "remember that we hid it" state
   that could get stranded.

   SCOPE. This owns ONE thing: whether `#foray-player` is on screen while a
   keyboard is up (`body.kb-open`, styles.css). It does not touch the bar's
   markup, its tap target, or the Now Playing sheet — those belong to the
   player module and to the sheet work landing alongside this. */
const KEYBOARD_MIN_INSET = 120;

function keyboardIsOpen(win) {
  const vv = win && win.visualViewport;
  if (!vv || typeof vv.height !== "number" || typeof win.innerHeight !== "number") return false;
  return (win.innerHeight - vv.height) > KEYBOARD_MIN_INSET;
}

/* HOW FAR A BOTTOM-ANCHORED FIXED BAR MUST RISE to sit on the keyboard's top
   edge instead of behind it, in CSS pixels. Published as `--kb-inset` on
   <html> so CSS can use it. Two readers: the search page's compose bar
   (`#sh-compose`), and every modal sheet's `.fy-panel`, which sits on the
   keyboard's top edge so a sheet's own text field and buttons are not
   stranded behind it (audit 2026-09-22).

   ONE DETECTOR, TWO ANSWERS. This is not a second keyboard detector: it runs
   inside the same `apply()`, off the same `visualViewport` listeners, and
   returns 0 whenever installKeyboardChrome's own predicate says the keyboard
   is shut. What it adds is a MEASUREMENT where that predicate gives a
   boolean — `body.kb-open` says whether to take the now-playing bar off the
   screen, and that is all it needs to say; the compose bar additionally has
   to know HOW FAR.

   WHY `offsetTop` IS SUBTRACTED HERE THOUGH keyboardIsOpen LEAVES IT OUT, and
   why the two are not in conflict. keyboardIsOpen needs a STABLE boolean, so
   it must ignore the term that moves under scroll and pinch-zoom: a bar that
   flickered back on mid-scroll would be the original bug again. A POSITION
   needs the exact opposite — it has to track, or the field detaches from the
   keyboard the moment anything moves.

   `innerHeight - height - offsetTop` is the distance from the bottom of the
   VISIBLE viewport to the bottom of the LAYOUT viewport, and it is the right
   shift in both of the regimes installKeyboardChrome's header describes.
   Before the page is scrolled, WebKit resolves `position: fixed` against the
   layout viewport and `offsetTop` is 0, so this is the full keyboard inset —
   the bar rises by the whole of it. Once WebKit re-anchors fixed elements to
   the visual viewport (the frame the `scroll` subscription exists for) the
   visual viewport has itself moved down by that inset, `offsetTop` reports
   it, and the shift falls back toward 0 — which is what a bar already
   sitting on the keyboard's edge needs. Same formula, both regimes, no
   branch on which one we are in — because we cannot ask.

   NOT MEASURED HERE, and said plainly: that second regime cannot be
   reproduced off an iPhone. This is reasoned from the behaviour
   installKeyboardChrome's header already diagnosed on a device, and it is
   the line in this change that most needs a real phone.

   Clamped at 0 and rounded: a negative shift would push the bar off the
   bottom of the screen, and sub-pixel values make the bar shimmer as the
   viewport settles. */
function keyboardInsetPx(win) {
  const vv = win && win.visualViewport;
  if (!vv || typeof vv.height !== "number" || typeof win.innerHeight !== "number") return 0;
  const offsetTop = typeof vv.offsetTop === "number" ? vv.offsetTop : 0;
  return Math.max(0, Math.round(win.innerHeight - vv.height - offsetTop));
}

/* Guarded rather than assumed: the fake windows in test/now-playing-keyboard
   pass a document with a body and nothing else, and a WebView that hands us
   no style object is not worth throwing over — the bar simply stays at
   `bottom: 0`, which is where it sat before this variable existed. */
function setKeyboardInsetVar(doc, px) {
  const root = doc && doc.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") return;
  root.style.setProperty("--kb-inset", `${px}px`);
}

function editableHasFocus(doc) {
  const el = doc && doc.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/* Returns its own teardown so a test can prove the listeners come off again
   (and so a future embedder can unwind it); `init()` installs one for the life
   of the document and drops the handle. */
function installKeyboardChrome(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  const vv = w && w.visualViewport;
  const doc = w && w.document;
  if (!vv || !doc || !doc.body || typeof vv.addEventListener !== "function") {
    return () => {}; // no visualViewport (desktop Safari <13, jsdom, a test stub): never hide the bar
  }
  /* THE LAST VALUE WE WROTE, so a re-evaluation that reaches the same answer
     writes nothing at all. `--kb-inset` is read by `#sh-compose`'s `bottom`
     calc, so every setProperty on it invalidates style and forces a layout of
     a fixed element; doing that on a frame where the number did not change is
     pure cost, and during a scroll on a settled keyboard that is EVERY frame.
     `null` (not 0) as the initial value, so the first evaluation always
     writes — a document that has never carried the variable and one carrying
     `0px` are not the same thing to the cascade's fallback. */
  let lastInset = null;
  const apply = () => {
    const open = keyboardIsOpen(w) && editableHasFocus(doc);
    doc.body.classList.toggle("kb-open", open);
    /* Written from the SAME evaluation as the class, so the two can never
       disagree — a `kb-open` body with a stale inset would put the compose
       bar somewhere the keyboard is not. `open ? ... : 0` rather than the raw
       measurement, so that everything the class's own predicate rejects
       (nothing editable focused, an inset below the threshold, a WebView
       mis-reporting during a splash fade) leaves the bar exactly where it
       sits with no keyboard at all.

       (The "can never disagree" claim above was not true until 2026-09-14,
       and the reason was not here: setBodyClass overwrote <body> wholesale
       and dropped the class while this variable, which lives on <html>,
       survived. See PERSISTENT_BODY_CLASSES.) */
    const px = open ? keyboardInsetPx(w) : 0;
    if (px !== lastInset) {
      lastInset = px;
      setKeyboardInsetVar(doc, px);
    }
  };
  const onFocusOut = () => {
    /* Runs BEFORE focus lands on the next element, so re-evaluate on the next
       turn rather than reading a momentarily-empty activeElement. */
    setTimeout(apply, 0);
  };
  /* ONE EVALUATION PER FRAME FOR SCROLL, AND ONLY FOR SCROLL (founder,
     2026-09-14: "when I scroll, the search text box moves a bunch and tries
     to stay above the keyboard but seems to need to update every time the
     page moves").

     He is describing this handler. `visualViewport` fires `scroll` at the
     rate the compositor moves the viewport — many times per frame under
     momentum and rubber-banding — and every one of those ran a full
     measure-and-write: three layout reads (`innerHeight`, `vv.height`,
     `vv.offsetTop`) feeding a `setProperty` that a fixed element's `bottom`
     depends on. `offsetTop` genuinely changes while the viewport is moving,
     so the write was not even redundant; it was a real, per-event reposition
     of the pill. That is the "moves a bunch" he sees.

     Coalescing to one evaluation per animation frame is the same idiom, and
     the same boolean-flag implementation, the window scroll listener in
     `init()` already uses — and it is the correct granularity for both
     reasons: the browser cannot paint more than once a frame anyway, and
     reading layout once per frame is what keeps this off the
     read/write/read-again thrash path.

     RESIZE IS NOT THROTTLED, deliberately. That is the keyboard actually
     opening or closing — it fires a handful of times, it is the event the
     `kb-open` class has to be on for BEFORE the next paint (the whole point
     of the scroll subscription's own comment below), and deferring it by a
     frame is how the mini-player gets one frame on top of the keyboard. The
     two subscriptions want different things from the same evaluation, so
     they get different scheduling, which is why this is two lines rather
     than one throttled `apply`.

     NOT PROVEN OFF A PHONE: that one-per-frame is enough to make the pill
     look welded to the keyboard under iOS momentum scrolling. What IS proven
     here (test/now-playing-keyboard.test.js) is the count — N scroll events
     inside one frame produce exactly one evaluation, where they used to
     produce N. */
  let scrollScheduled = false;
  const raf = typeof w.requestAnimationFrame === "function"
    ? w.requestAnimationFrame.bind(w)
    /* A window with no rAF (a stripped WebView, the suite's fake windows):
       fall back to running inline rather than dropping the evaluation. The
       throttle is an optimisation; correctness must not depend on it. */
    : (cb) => { cb(); return 0; };
  const onViewportScroll = () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    raf(() => { scrollScheduled = false; apply(); });
  };
  vv.addEventListener("resize", apply);
  /* `scroll` is the exact moment WebKit re-anchors fixed elements — the frame
     Wyatt described the bar jumping in. Re-evaluating here means the class is
     already on before the bar can be repainted in its new place. */
  vv.addEventListener("scroll", onViewportScroll);
  doc.addEventListener("focusout", onFocusOut, true);
  apply();
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", onViewportScroll);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.body.classList.remove("kb-open");
    /* Teardown must undo the measurement as well as the class. A document
       left carrying `--kb-inset: 312px` after the listeners are gone would
       hold the compose bar a keyboard's height off the floor with nothing
       left running to correct it. `lastInset` is reset with it, so a
       re-install on the same document does not memo its way out of the first
       write. */
    lastInset = 0;
    setKeyboardInsetVar(doc, 0);
  };
}

/* ☰ AND ↻ ARE DIMMED UNTIL THEY WORK (round-2 audit, nav-9). The top bar is
   static HTML and paints at once; its listeners are bound at the end of init(),
   after every boot document has arrived, so on a slow connection both buttons
   sat there for seconds taking taps and doing nothing. Binding them earlier is
   not the answer — the drawer renders the listener's playlists and switches,
   which are storage reads before hydration, and ↻ re-deals cards from data that
   has not arrived — so they are `disabled` (dimmed, skipped, announced as
   such) until the line that binds them, and stay so on a failed boot, where
   the page's own Try again is the one thing that can help. */
function setBootChrome(ready) {
  for (const id of ["#menu-btn", "#refresh-btn"]) {
    const btn = $(id);
    if (btn) btn.disabled = !ready;
  }
}

/* Resolved once init() has put its first page on screen — or its failed-boot
   page. The service worker's registration waits on it. */
let markFirstPagePainted = () => {};
const firstPagePainted = new Promise(resolve => { markFirstPagePainted = resolve; });

/** What a boot that threw says (app-3-13); its Try again loads a fresh page. */
const BOOT_FAILED_NOTE = "4a couldn't start.";

/** What `#view` holds between app.js starting and the first `route()`. */
const BOOT_LOADING_HTML = `<div class="page" data-boot-loading><p class="note">Loading 4a…</p></div>`;

async function init() {
  /* EVERY BOOT REQUEST STARTS BEFORE THE FIRST AWAIT (round-2 audit, perf-1).
     The seven documents used to wait for `storageReady()` — which on the web
     means the whole deferred player module graph (28 files, five import levels
     deep, each revalidated by the service worker) plus IndexedDB hydration —
     and for `session.json` behind it. None of them reads storage. Hydration now
     runs beside them and is awaited only where it matters: immediately before
     `loadInterests()`, the first read-then-write. */
  /* THE FIRST PAINT HAPPENS BEFORE THE FIRST AWAIT (audit 2026-09-22, persona
     #43). The body used to be blank behind the header for as long as ~3.5 MB of
     JSON took on a cell connection — indistinguishable from broken, on the one
     screen every listener sees every session. `route()` replaces this.

     Painted HERE rather than shipped in index.html, deliberately:
     tools/mobile/webview-probe.mjs certifies a device launch partly by `#view`
     having children, as proof app.js ran under the shell's CSP. Static markup
     would satisfy that with app.js dead; this line can only exist if app.js
     executed, and the probe separately refuses a view still holding it
     (`data-boot-loading`), so a boot that hangs is not certified either. */
  const view = $("#view");
  if (view && !view.firstElementChild) view.innerHTML = BOOT_LOADING_HTML;
  /* ON HOME, THE BOOT SCREEN IS TODAY'S SKELETON (Redesign 2026, ambient): the hero and four
     rows as lamp-swept blocks, under the header, instead of a line of text. It carries the same
     `data-boot-loading` mark and the same "Loading 4a…" for a screen reader, so the webview
     probe and every "still booting" check read it exactly as they read the line above. Any
     other route keeps the line. */
  if (view && typeof todaySkeletonHtml === "function" && isHomeRoute()) {
    setBodyClass("view-home");
    view.innerHTML = todaySkeletonHtml({ boot: true });
  }
  /* Belt for index.html's `<body class="ui-v2">` (p-first-2): a cached older
     index.html without it still gets the dark design from this line on. */
  try { document.body.classList.add("ui-v2"); } catch (_) { /* a stub document */ }
  setBootChrome(false);
  const storageP = storageReady();
  const sessionP = fetchJson("data/session.json");
  /* Every one of these may come back null (fetchJson swallows a 404 and a
     parse error alike) and every consumer treats null as "absent", so a
     partial deploy costs the feature that needs the file rather than the
     site. The three Foray documents are the newest and the most likely to be
     missing from a cached service worker — see renderForay(). */
  /* `data/semantic-index.json` and `data/item-tags.json` are NOT here any more
     (audit 2026-09-22): 465.7 KB (97 KB gzipped) that only the topic scorer
     reads, and Home's first paint never scores a topic. They start after
     `route()` below, through `loadSearchData()`, which the scorer's three
     callers wait on. */
  const documentsP = Promise.all([
    fetchJson("data/validated-links.json"),
    fetchJson("data/taxonomy.json"),
    fetchJson("data/discover.json"),
    fetchJson("data/forays.json"),
    fetchJson("data/segments.json"),
    fetchJson("data/segment-sources.json"),
    /* Show-level records for #/show/:id (Stage 1, docs/show-pages-plan.md).
       data/catalog-client.json is the client-projected copy of data/catalog.json —
       tools/build-catalog-client.mjs strips fields renderShow() never reads
       (feed_url, apple_genre, cadence_hint, provenance) for a ~24% gzip saving;
       see that script's header for the measurement. */
    fetchJson("data/catalog-client.json"),
    /* Cold-start persona priors (#70; catalogue-personalization.md PKG-13):
       read by personaById()/applyPersonaPick(). A 404 or parse failure is
       null like every other document here, and every read is null-safe
       (`state.personas?.personas || []`), so a missing file costs the persona
       pick and nothing else. */
    fetchJson("data/personas.json"),
  ]);
  const session = await sessionP;
  state.session = session;
  if (!state.session) {
    /* A failure offers "Try again", wired to the same boot (theme G). Safe to
       re-run: nothing above this line binds a listener or starts the directory,
       so a second init() starts from exactly where the first one stopped. */
    $("#view").innerHTML = `<div class="page">${failedNoteHtml("Couldn't load 4a — check your connection.")}</div>`;
    bindRetry($("#view"), () => {
      $("#view").innerHTML = BOOT_LOADING_HTML;
      init();
    });
    markFirstPagePainted();
    return;
  }
  /* The Foray directory's cache read starts HERE, alongside the bundle fetches
     below, so that by the time they land the one IndexedDB read is done and
     bootForayDirectory() costs the critical path nothing. Bounded inside the
     module: a hung IndexedDB costs the cache, never the paint.
     The bridge arrives with the player module, so that much is waited for
     here — with the documents already on the wire, which is the point. */
  /* A THROW FROM HERE TO THE FIRST PAGE IS CAUGHT (audit round 3, app-3-13).
     Only route() was wrapped: a throw in the directory bookkeeping,
     loadInterests, buildCards or the ribbon rejected init() unhandled, and the
     screen stayed on "Loading 4a…" for good -- ☰ and ↻ disabled, no Try again,
     no hashchange, and no service worker (it waits on firstPagePainted). Now
     the failure paints its own Try again (a fresh document), the wiring below
     still runs, and the first page counts as painted either way. The block is
     deliberately NOT re-indented, so this change stays a few lines.

     RECOVERY IS THE FRESH LOAD, AND ONLY THAT (round-3 review, L1). Every
     throw this catches happens before `state.ready = true`, and route() and
     renderCurrentPage() return at once until then, so the hashchange and
     popstate listeners, the tab links and the drawer bound below do nothing
     after a failed boot: they are bound so the chrome is not dead, not
     because a typed route can bring the page back. That is deliberate:
     `ready` is what says the state a page renders from (cards, interests,
     the directory) was built, and rendering from half of it would trade an
     honest "couldn't start" for a page that throws or shows wrong things.
     Try again (location.reload) is the way out; the Try again note stays on
     screen whatever route the listener types. */
  try {
  await waitForStorage();
  /* The room the listener chose (Dusk, Dawn, or follow the phone), before the first route paints it. */
  applyStoredTheme();
  /* Offline downloads (#29, PQ-18): the bridge comes from player/client.js,
     which `waitForStorage` has just waited for, and is null off the shell.
     Before the first route, so a cold open on an episode page draws its
     Download control, and before `bindSettingSwitches` below, which appends the
     cellular switch only when there is a bridge. */
  bootDownloads();
  const directory = forayDirectoryBridge();
  if (directory && !pinnedDeployId) {
    try { directory.start({ localPointerUrl: pinnedUrl(FORAY_DIRECTORY_POINTER) }); } catch (_) { /* seed only */ }
  }
  [
    state.validated, state.taxonomy, state.discover,
    state.forays, state.segments, state.segmentSources, state.catalog,
    state.personas,
  ] = await documentsP;

  /* THE THREE FORAY DOCUMENTS ARE ONE ARTIFACT AT BOOT TOO (audit round 2,
     states-3). retryForayDocs adopts a set only when all three arrived, because
     a Foray list with no segment pool resolves every clip as "couldn't be
     found" — a network failure painted as a fact about the content, with the
     Try again gone. The boot path adopted whatever came back: forays.json
     present and segments.json missing (a one-file 404 or timeout on a first
     visit) painted "22 clips from this foray couldn't be found, so they're left
     out" over an empty running order, on Home's cards and on the page. Any
     null makes all three null, so the existing "Couldn't load forays right
     now" + Try again branch is what paints instead. */
  if (!state.forays || !state.segments || !state.segmentSources) applyForaySet({});

  /* FD-03: the three Foray documents just fetched are the SEED. If the directory
     holds a cached set that validates, that set replaces them before the first
     paint; the network is not consulted until after `route()` below. */
  await bootForayDirectory(directory);

  /* The one wait on hydration, bounded at five seconds (see storageReady). */
  await storageP;
  loadInterests();
  /* Hydration that overran the bound re-seeds every weight this session has
     not moved, so Home's next deal ranks by the listener's own profile rather
     than the taxonomy defaults (races-4). */
  if (storageWaiting()) {
    afterStorageSettles(() => {
      applyStoredTheme();
      loadInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
    });
  }
  buildCards();
  state.ready = true;
  enterForayFromQuery();
  /* A bare arrival is Home, and the address says so from the first paint —
     see currentHash(). In place: no hashchange, no history entry. Inside the
     native shell a bare arrival is a relaunch, and reopens the page the
     listener left (see relaunchRoute). */
  if (location.hash === "" || location.hash === "#") replaceHash(relaunchRoute());
  /* THE FIRST ROUTE MAY NOT TAKE THE APP DOWN WITH IT (audit 2026-09-22). Every
     listener this function wires — hashchange, the menu, the drawer, the
     keyboard chrome — is bound BELOW this line, so a throw out of the first
     render (a malformed percent-escape did exactly that) left a page that no
     tap and no typed hash could recover until a reload. The page that threw
     is replaced by Home; the wiring always runs. */
  try {
    route();
  } catch (err) {
    console.error("first route failed", err);
    try { renderHome(); renderTabBar(); } catch (_) { /* nothing left to try; the wiring below still runs */ }
  }
  /* THE RIBBON COMES BACK (founder, 2026-09-18: "When I come back to 4a after a
     day, the podcast I was listening to should still be in the now playing
     ribbon at the bottom.")

     AFTER `route()`, for the same reason the directory refresh below is: the
     first paint is the thing on the critical path and this is not. It loads no
     audio — it paints the bar from the stored pointer and arms the first press
     — so the cost is building the player's UI once, which pressing play would
     have done anyway.

     Guarded on the bridge existing at all: `player/client.js` is a deferred
     module and app.js is a classic script, so on a slow parse this runs before
     `window.ForayPlayer` is there. The `forayplayer:ready` event is the app's
     existing answer to exactly that race, and this rides it rather than
     inventing a poll. */
  restoreNowPlayingRibbon();
  bindShowPrefetch();
  logEvent("session_shown", { session_id: state.session.session_id });
  trySyncEvents();   // waits for storage to settle itself — see trySyncEvents
  } catch (err) {
    console.error("boot failed", err);
    const failed = $("#view");
    if (failed) {
      failed.innerHTML = `<div class="page">${failedNoteHtml(BOOT_FAILED_NOTE)}</div>`;
      bindRetry(failed, () => location.reload());
    }
  } finally {
    markFirstPagePainted();
  }

  /* FD-03, the other half: NOW ask the live origin whether there is a newer set.
     Fire-and-forget, deliberately after `route()` — the first paint is on
     screen, and a pointer fetch on a dead cell must cost nothing but a
     diagnostics row. `test/foray-directory.test.js` pins the order: awaiting
     this above `route()` turns its "paint is not blocked" test red. Repeated on
     return to the foreground, throttled inside the module. */
  refreshForayDirectory("boot");
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refreshForayDirectory("foreground");
    refreshGreeting();
  });

  /* Warm the concept-vocabulary DF caches now, while the app is idle between
     "data finished loading" and "user typed a query and hit Go", instead of
     paying it interleaved into the FIRST real playlist search (H bug, kanban
     t_838a13c0 — a fresh session's first query measured 6.6-8.1s before this
     fix). Deliberately scheduled through `whenQuiet` rather than called
     inline here: `route()` above has already painted the first screen, and
     priming is pure CPU with no UI of its own, so it must not compete with
     that paint or with an impatient user who taps into the playlist search
     within the first second (round 2, perf-3: the 0 ms fallback the native
     shell took did exactly that). searchCtx() builds the same ctx
     this call warms, so a query that arrives before priming finishes just
     resumes the memoization mid-way — nothing is wasted or redone. */
  const primeSearchVocab = () => {
    if (typeof SearchEngine !== "undefined" && SearchEngine.primeVocabulary) {
      SearchEngine.primeVocabulary(searchCtx());
    }
  };
  /* The search documents first — priming a ctx that has no vocabulary in it
     would warm nothing and then be thrown away when they land. */
  for (const type of ["pointerdown", "touchstart", "keydown", "wheel", "scroll"]) {
    window.addEventListener(type, noteInteraction, { passive: true, capture: true });
  }
  loadSearchData().then(() => whenQuiet(primeSearchVocab));

  /* Continuous playback's wiring (§ continuous playback, founder ruling
     2026-09-14). Fire-and-forget: a player that never loads (module failure,
     test harness with no `window.addEventListener`) just means it never
     fires, same as every other ForayPlayer-gated feature on this page — it
     must not hold up `init()`, which has already returned control above. */
  playerBridge().then(player => {
    if (player && typeof player.onEpisodeEnded === "function") {
      player.onEpisodeEnded(advanceQueueOnEnded);
    }
    refreshEpisodeNavigation();
  });

  bindSettingsChrome();
  /* Android's back button, ordered like every other overlay close — see
     `handleBack`. A no-op on the web and on iOS. */
  bindHardwareBack();
  $("#view").addEventListener("click", onBackClick);
  $("#view").addEventListener("click", onForayScriptClick);   // once — see its header
  /* The listener's settings switches, in one call — see `bindSettingSwitches`.
     They land ABOVE everything bound below, so "Delete my data" stays last where
     a scrolled thumb expects it. */
  bindSettingSwitches();
  /* Narration voice (V-01): a listener setting, so it stays with the switches
     above rather than inside the Developer group below (2026-09-22 audit, R8). */
  bindVoiceControl();
  /* The Developer group (R8): the founder's two switches, then the field
     record's surface (#264), all inside one collapsed disclosure. Deliberately
     ABOVE the control below: "Delete my data" must stay the drawer's last item,
     because it is the one control in there that cannot be undone and the last
     item is where a scrolled thumb lands. */
  bindDeveloperToggles();
  bindDiagnosticsControl();
  /* The engine's four rows land above "Playback diagnostics", once the player
     says which lane plays (NE-22d). */
  bindEngineDevRows();
  /* The drawer's last item, appended rather than written into index.html — see
     the § delete my data header for why, and note it is deliberately BELOW the
     two settings toggles: it is the one control in there that cannot be undone. */
  bindDeleteControl();
  $("#refresh-btn").addEventListener("click", refreshCurrentPage);
  setBootChrome(true);
  /* The router owns the viewport now (see route()), so the browser must stop
     owning it too. Left on "auto", its own restoration lands a beat AFTER
     ours and overwrites it — measured: with the restore in route() but this
     line missing, a back-step to `#/shows` still ended at 457 rather than the
     remembered 4000, because the browser re-applied its own clamped answer
     after the page had rendered. Guarded because `scrollRestoration` is
     absent on older WebKit, where "auto" is all there is and route()'s own
     restore is simply the last write instead of the losing one. */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (_) {}
  window.addEventListener("hashchange", route);
  /* ...and the traversal hashchange never reports: onto an entry with the same
     hash (audit round 2, nav-1 — see onPopState). */
  window.addEventListener("popstate", onPopState);
  /* Hides #foray-player while a soft keyboard is up (founder report,
     2026-09-13) — see installKeyboardChrome's header. Installed once for the
     life of the document: the keyboard can open on any screen with a text
     field, not just the show page's episode search, and the bar is global
     chrome, so this is deliberately NOT per-route. The teardown handle is
     dropped on purpose here; the suite calls it directly. */
  installKeyboardChrome(window);
  /* `{ passive: true }`: this listener never calls preventDefault, and
     without the flag some browsers assume it might and delay scrolling to
     find out — passive says up front that scrolling can proceed immediately.
     Throttled to one evaluation per animation frame (a plain boolean flag,
     no timer) rather than running on every fired scroll event, which on a
     long list can be many times per frame. */
  let scrollScheduled = false;
  window.addEventListener("scroll", () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      onWindowScroll();
      /* Piggy-backed on the same throttled tick rather than given a second
         scroll listener: both want exactly "the current position, once per
         frame", and two listeners for one fact is how they drift. See
         rememberScrollPosition() — this is what the ‹ button reads. */
      rememberScrollPosition();
    });
  }, { passive: true });
  /* A scroll the LISTENER starts ends any owed restore (see
     abandonPendingRestore); a scroll event alone cannot say whose it was. */
  for (const type of ["touchstart", "wheel", "keydown"]) {
    window.addEventListener(type, abandonPendingRestore, { passive: true });
  }
  /* NO PINCH ZOOM (founder, 2026-09-23: "Remove the zoom functionality."). The
     viewport meta (`maximum-scale=1, user-scalable=no`) is the declaration; this
     is the guard behind it. Safari has ignored that meta since iOS 10 and a
     WebView may follow suit in any release, but a cancelled `gesturestart` —
     WebKit's own pinch event, fired before any scale is applied — stops the
     zoom regardless. `passive: false` is required, or the preventDefault is a
     no-op; it costs nothing, because a gesture event fires once per pinch, not
     per frame like touchmove. Double-tap is `touch-action: manipulation` on
     html/body in styles.css. test/no-horizontal-scroll.test.js pins all three. */
  document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
}

/* Should this page register `sw.js`? On the web: yes — it is what makes the site
   render its last-known state in a cell dead zone. Inside the native shell
   (issue #36 §2): NO.

   The shell's assets are already local files, so a cache-first service worker
   adds a stale-cache layer in FRONT of local files and buys nothing. Worse, it
   is the classic "the app won't update" bug: a shipped build would keep serving
   the cached copy of its own bundle after an app-store update replaced it, and
   the symptom is an app that ignores new versions with no error anywhere.

   Two signals, and they are checked in SEPARATE `try` blocks on purpose. The
   origin goes first because it cannot throw: on iOS the page is served from
   `capacitor://localhost`. `window.Capacitor.isNativePlatform()` goes second —
   the bridge is injected before page scripts, so it is normally the more precise
   answer, but it is somebody else's object and calling into it can throw (a
   bridge that is not ready, a plugin-proxy getter). Sharing one `try` made the
   guard FAIL OPEN: a throwing bridge skipped the origin check too and registered
   the worker inside the shell, which is the exact case the origin check exists
   to cover.

   Deliberately NOT a hostname check. Capacitor's Android default is
   `https://localhost`, so testing for "localhost" would also disable the service
   worker for anyone serving the real site from a local dev server — a live web
   behaviour broken to fix an app one.

   Deliberately NOT a user-agent check either. Every real Foray listener is on a
   phone, so UA-sniffing here would switch the offline shell off for essentially
   the whole audience. `shell-invariants.test.mjs` asserts a mobile-web UA still
   registers. */
function shouldRegisterServiceWorker(win) {
  try {
    const proto = (win && win.location && win.location.protocol) || "";
    if (proto === "capacitor:" || proto === "ionic:") return false;
  } catch (_) { /* no location: treat as the web, and let the bridge check speak */ }
  try {
    const cap = win && win.Capacitor;
    if (cap) {
      if (typeof cap.isNativePlatform === "function") { if (cap.isNativePlatform()) return false; }
      else if (cap.isNative) return false;
    }
  } catch (_) { /* a bridge that throws is not an answer; the origin already spoke */ }
  return true;
}

/* ---------- the page's half of #233 ----------

   sw.js refuses to hand a page running last-known code a freshly fetched
   `data/*.json`, because that pair is a different program reading a file it has
   never seen. Refusing is the safe half; this is the recoverable half — the
   worker says which of the two things happened, and the page says so with a
   control that fixes it.

   Both reasons mean the same thing to a listener (this page is not the current
   version) and both are fixed by one reload, so there is one bar with one
   button. Deliberately NOT an automatic reload: a reload loop cannot be rolled
   back by reverting a commit — clients keep the worker they have until it
   updates — and a loop would take the whole site out, which is worse than the
   bug being fixed. The listener presses it, or ignores it and keeps listening. */
const SHELL_NOTICE = {
  "stale-shell": "4a is showing its last saved copy — the network didn't answer while it was starting.",
  "generation-changed": "4a updated in the background, so what you're looking at is one version behind.",
};

/* WHAT TO DO ABOUT IT, per reason — they have opposite remedies (audit
   2026-09-22, qa row 138). Both used to end "Reload to get the current version."
   beside a Reload button, and for `stale-shell` — a dead zone — reloading just
   reproduces the notice, which this file's own comment in showShellNotice
   already said. So the stale copy says WHEN a reload helps, and the button
   stays for that moment; the version-behind copy says reload helps now.
   "this page" left both sentences: inside the native shell there is no page a
   listener can see, only 4a. */
const SHELL_REMEDY = {
  "stale-shell": "Reload once you're back online.",
  "generation-changed": "Reload to get the current version.",
};

/* THE PAGE'S HALF OF THE GENERATION PIN (#233/M4, sw.js's `handleShell`).
 *
 * The worker no longer remembers which pages are running last-known code —
 * that lived in an in-memory `Set` that a browser-initiated worker eviction
 * silently emptied, which failed a pinned page OPEN the next time it asked for
 * data. The pin now lives here instead, in this page's own JS state (set
 * synchronously at the TOP of this file — see that comment for why it cannot
 * depend solely on this message listener, which attaches only after `init()`
 * has already started fetching), which cannot be evicted independently of the
 * page itself. Every `data/*.json` fetch carries `?_fdid=<that id>` so sw.js's
 * `handleData` keeps reading the SAME generation rather than whatever today's
 * pointer names. A reload clears this by simply being a new document — there
 * is nothing to clear on purpose.
 */
function pinnedUrl(path) {
  if (!pinnedDeployId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_fdid=${encodeURIComponent(pinnedDeployId)}`;
}

function showShellNotice(reason) {
  /* Own properties only. A plain object literal answers `SHELL_NOTICE["constructor"]`
     with a function, and `SHELL_NOTICE["toString"]` with another one, so a bare
     lookup would happily render `function Object() { [native code] }` into the
     bar for a reason nobody wrote. The reason comes from our own worker today —
     this is so a later one cannot make that a bug by adding a message type. */
  const said = Object.prototype.hasOwnProperty.call(SHELL_NOTICE, reason) ? SHELL_NOTICE[reason] : "";
  if (!said || shellNoticeDismissed) return;
  const view = $("#view");
  if (!view || !view.parentNode) return;
  let bar = $("#shell-notice");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "shell-notice";
    bar.className = "shell-notice";
    /* A sibling of #view, not a child: route() rewrites #view's innerHTML on
       every navigation and would wipe the bar on the first hash change. */
    view.parentNode.insertBefore(bar, view);
  }
  bar.innerHTML =
    `<p class="note">${esc(said)} ${esc(SHELL_REMEDY[reason] || "")}</p>` +
    `<button type="button" id="shell-notice-reload">Reload</button>` +
    `<button type="button" id="shell-notice-dismiss" aria-label="Dismiss this message">×</button>`;
  const reload = $("#shell-notice-reload");
  if (reload) reload.addEventListener("click", () => location.reload());
  /* Dismissable, and this is not politeness. The bar is fixed below the topbar
     and a Foray page's transport is sticky at the same offset, so while the bar
     is up it covers the scrubber and the play control. In the `stale-shell` case
     — a dead zone — pressing Reload just reproduces it, so without this the
     listener would lose the transport for the rest of the session.

     REMOVING THE ELEMENT WAS NOT ENOUGH (audit 2026-09-22). The comment here
     said the worker only speaks again on a new page load; it speaks once per
     CODE FILE it serves from the fallback (sw.js, `handleShell`), and a page
     loads ~20 of them — so the bar came back seconds after ×, again and again,
     covering the transport each time. The dismissal is now a fact about this
     page load, checked at the top. */
  const dismiss = $("#shell-notice-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      shellNoticeDismissed = true;
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
  }
}

/* Set by the bar's ×, for the life of this page load. See showShellNotice. */
let shellNoticeDismissed = false;
