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
      lsSet(key, list.reduce((v, f) => f(v), lsGet(key, fallback)));
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
    token with 400 (401 on some versions) and `error: "invalid_grant"` or
    `error_code: "refresh_token_not_found"`. Anything else -- a 429, a 5xx, no
    answer, a body it did not recognise -- is transient: keep the account and
    let the queued rows retry. */
const DEAD_REFRESH_CODES = new Set(["invalid_grant", "refresh_token_not_found"]);
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
      if (!p.node_id || (p.direction !== "up" && p.direction !== "down")) return null;
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

function interestSliderRow(node) {
  const value = typeof state.interests[node.id] === "number" ? state.interests[node.id] : Math.max(0, node.weight);
  const pct = Math.round(value * 100);
  const isRoot = node.parent === null;
  return `<div class="interest-row${isRoot ? " interest-row-root" : ""}">
    <div class="interest-row-head">
      <span class="interest-row-name">${esc(node.label)}</span>
    </div>
    <div class="interest-row-controls">
      <input type="range" class="interest-slider" role="slider"
        min="0" max="1" step="0.01" value="${value}"
        data-interest-id="${esc(node.id)}"
        aria-label="${esc(node.label)} interest"
        aria-valuemin="0" aria-valuemax="1" aria-valuenow="${value}"
        aria-valuetext="${pct}%">
      <span class="interest-row-pct">${pct}%</span>
      <button type="button" class="interest-reset" data-interest-reset="${esc(node.id)}"${controlLabelAttr("Back to 4a's pick", `${node.label}: back to 4a's pick`)}
        ${value === Math.max(0, node.weight) ? "disabled" : ""}>Back to 4a's pick</button>
    </div>
  </div>`;
}

function renderInterests() {
  /* Was a direct `document.body.className = "view-page"`, the one render
     function that never got routed through setBodyClass when that helper was
     introduced — so the Interests page dropped `ui-v2` itself, not just the
     runtime classes, and rendered the whole page off the pre-cutover sheet. */
  setBodyClass("view-page");
  const groups = interestGroups();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Interests</h2><p class="sub">Drag a slider to change what 4a suggests.</p></div>
      </div>
      ${groups.map(interestGroupHtml).join("")}
    </div>`;
  bindInterestsControls($("#view"));
}

/* ONE NAME PER BLOCK (audit round 2, visual-17). Every root is always a row of
   its own group, and a leaf joins only once the listener has moved it, so for
   a new listener EVERY group was a heading over one card with the same name —
   "Adventure" over "Adventure", the page twice as long as its content. The
   heading is only there to gather a root's sub-topics; with none, the card
   names itself. */
function interestGroupHtml(g) {
  return `
        <div class="interest-group">
          ${g.rows.length > 1 ? `<h3 class="interest-group-label">${esc(g.root.label)}</h3>` : ""}
          ${g.rows.map(interestSliderRow).join("")}
        </div>`;
}

function bindInterestsControls(scope) {
  scope.querySelectorAll("[data-interest-id]").forEach(input => {
    if (input._bound) return;
    input._bound = true;
    const id = input.dataset.interestId;
    const apply = () => {
      const v = Math.max(0, Math.min(1, Number(input.value)));
      setInterest(id, v);
      saveInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
      input.setAttribute("aria-valuenow", String(v));
      input.setAttribute("aria-valuetext", `${Math.round(v * 100)}%`);
      const row = input.closest(".interest-row");
      const pct = row?.querySelector(".interest-row-pct");
      if (pct) pct.textContent = `${Math.round(v * 100)}%`;
      const resetBtn = row?.querySelector("[data-interest-reset]");
      const node = nodeById(id);
      if (resetBtn && node) resetBtn.disabled = v === Math.max(0, node.weight);
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
  });
  scope.querySelectorAll("[data-interest-reset]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      const id = btn.dataset.interestReset;
      const node = nodeById(id);
      if (!node) return;
      setInterest(id, Math.max(0, node.weight));
      saveInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
      renderInterests();
    });
  });
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
   composed a keyboard-open inset with the keyboard-SHUT dock.

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
   unrated gets through unless its show is rated clean. */
function familySafe(item) {
  if (!item || typeof item !== "object") return false;
  if (item.explicit === true) return false;
  if (branchOf(item) === "comedy") return false;
  if (item.explicit === false) return true;
  const show = catalogShowForItem(item);
  return Boolean(show && show.explicit === false);
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
const FOLLOW_TOGGLE = { offText: "+ Follow", onText: "✓ Followed", offLabel: "Follow show", onLabel: "Followed" };
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
  document.querySelectorAll(`[data-show-star="${CSS.escape(id)}"]`).forEach(b => {
    setToggleLabel(b, isShowStarred(id), FOLLOW_TOGGLE);
    b.classList.toggle("on", isShowStarred(id));
  });
}

/* Text label, not a bare glyph like starBtn -- this button sits alone in a
   page header rather than beside a play control in a dense row, so it needs
   to read on its own. */
function showStarBtn(show_id) {
  const on = isShowStarred(show_id);
  const { text, attr } = toggleMarkup(on, FOLLOW_TOGGLE);
  return `<button class="show-star ${on ? "on" : ""}" data-show-star="${esc(show_id)}"${attr}>${text}</button>`;
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
   recomputed per render and resolvable by id for the detail page. */
const GENERATED_PLAYLIST_COUNT = 3;
const GENERATED_PLAYLIST_SIZE = 6;
const GENERATED_PLAYLIST_MIN = 3;
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
  const out = [];
  for (const { n } of leaves) {
    const items = byTopic.get(n.id)
      .filter(it => !slotItemIds.has(it.id))
      .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || String(a.id).localeCompare(String(b.id)))
      .slice(0, GENERATED_PLAYLIST_SIZE);
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
   page matches Home's card whenever Home shows it). */
function generatedPlaylistById(id) {
  const m = /^gen-(.+)$/.exec(String(id || ""));
  if (!m) return null;
  const node = nodeById(m[1]);
  if (!node || node.parent === null) return null;
  const onLeaf = poolFiltered().filter(it => (it.topics || []).includes(node.id));
  const slots = state.cardSlots || [];
  const slotItemIds = new Set(slots.flatMap(sl => (sl.items || []).map(it => it.id)).concat(slots.map(sl => sl.item?.id)).filter(Boolean));
  const unslotted = onLeaf.filter(it => !slotItemIds.has(it.id));
  const items = (unslotted.length >= GENERATED_PLAYLIST_MIN ? unslotted : onLeaf)
    .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")) || String(a.id).localeCompare(String(b.id)))
    .slice(0, GENERATED_PLAYLIST_SIZE);
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

/* U-05 (D5, D7): the same interest-based generator U-03's "Playlists for
   you" reuses -- today's subject queues, `state.cardSlots`, built once per
   session by buildCards() (re-dealt once more if the first-run Preferences
   picks change its inputs — redealAfterOnboardingPicks) -- filtered to the
   branches whose label matches
   the typed query and projected through the existing subjectQueueById() so
   a generated match renders and opens exactly like a Home "Playlists for
   you" generated card (same #/playlist/subject-<branch> route, same
   isSubject/withMirror shape). No new backend, no new scoring: this reads
   cardSlots as they already are, it does not rebuild or re-rank them for
   the query the way buildPlaylist's topic scorer does. */
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

   WHICH FIELDS, AND WHY NOT THE REST. Measured over the 1,534-item pool as
   serialized JSON, key name included, bytes per item:

     kept       id 52 · title 62 · show 32 · duration_min 18
                apple_collection_id 33 · apple_track_id 31 · topics 39   = 268 B
     not kept   audio_url 182 · artwork_url 161 · apple_episode_url 134
                hook 97 · duration_sec 20                                = 594 B

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

   THE ARITHMETIC against savePlaylists' cap of 50 and SearchEngine.DEFAULT_CAP's
   10 picks. Measured over all 1,534 items, the MEAN part is 268 B → 2.7 KB of
   parts, plus a 0.5 KB `item_ids` mirror and ~0.2 KB of metadata → ~3.4 KB a
   playlist, ~168 KB for a full 50 (from ~33 KB before). The WORST case is worth
   naming rather than rounding away: the largest single part is 468 B, and 50
   playlists of the ten longest-titled episodes in the catalogue come to ~252 KB.
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
const PLAYLIST_PART_FIELDS = ["title", "show", "duration_min", "apple_collection_id", "apple_track_id", "topics"];

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
  let all = lsGet("cp_playlists", null);
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
     enforces the 50 cap on a store that already holds more. */
  if (touched) lsSet("cp_playlists", all);
  return all;
}

function savePlaylists(all) { return lsSet("cp_playlists", all.slice(0, 50).map(withMirror)); }

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
  return ok;
}

/** The Up Next page is a LIVE VIEW of `cp_queue`: every write repaints it when
    it is showing, and the writes' own callers do not (the reorder handlers used
    to call `renderQueue()` themselves — that path is gone, so one list cannot be
    painted twice). Scroll is kept where it was: a render replaces `#view`'s
    content and would otherwise land the listener at the top. Best-effort on
    `scrollY`/`scrollTo`, which the test harness does not have. */
function repaintQueuePage() {
  if (currentHash() !== "#/queue") return;
  const y = typeof window.scrollY === "number" ? window.scrollY : null;
  const held = queueFocusBefore();
  renderQueue();
  if (y != null && typeof window.scrollTo === "function") window.scrollTo(0, y);
  queueFocusAfter(held);
}

/* THE REPAINT KEEPS THE LISTENER'S PLACE (audit round 2 review). A live view
   replaces #view's content, so the control a keyboard or VoiceOver user had
   just pressed — ▶ on an Up Next row, the playing row's ❚❚ when an episode
   ends and the next one chains — was destroyed and focus fell to <body>, the
   top of the page. Only ↑/↓/✕ restored it (afterQueueMove/afterQueueRemove,
   which still run after this and still win). The same control on the same
   episode gets focus back; if that row has left, the control at the same
   position in the list, else the page heading. */
const QUEUE_FOCUS_ATTRS = ["data-play", "data-reorder-up", "data-reorder-down", "data-dequeue"];

function queueFocusBefore() {
  const view = $("#view");
  const active = document.activeElement;
  if (!view || !active || active === view || typeof active.getAttribute !== "function") return null;
  let inView = false;
  for (let n = active; n; n = n.parentElement) if (n === view) { inView = true; break; }
  if (!inView) return null;
  for (const attr of QUEUE_FOCUS_ATTRS) {
    const id = active.getAttribute(attr);
    if (id == null) continue;
    const peers = typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(`[${attr}]`)] : [];
    return { attr, id, index: Math.max(0, peers.indexOf(active)) };
  }
  return null;
}

function queueFocusAfter(held) {
  if (!held) return;
  const view = $("#view");
  if (!view) return;
  let target = queueButtonFor(held.attr, held.id);
  if (!target) {
    const peers = typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(`[${held.attr}]`)] : [];
    target = peers[Math.min(held.index, peers.length - 1)] || (typeof view.querySelector === "function" ? view.querySelector("h2") : null);
  }
  if (target && target !== document.activeElement) focusQuietly(target);
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
     - The end of both is the end. "And then more of what fits" — pulling in
       recommendations once the list runs out — is the rest of issue #691 and is
       not built here; the exploration floor governs what it will pick. */
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

/** The injected state `player/continuation.js` reads, from this page's own. */
function continuationState(currentId = null) {
  return {
    queue: queueIds(),
    playList: state.playList,
    playChainId: state.playChainId,
    playListCursor: state.playListCursor,
    isPlayable: isPlayableId,
    items: liveEpisode,
    currentId,
  };
}

/** What plays after `finishedId`, with no writes: `{ nextId, rest, fromList }`
    — see `planAfterEnded` in player/continuation.js, which holds the Up Next
    model above. Shared by the end of an episode and by the steering wheel's
    and the sheet's ⏭, which mean the same thing: a skip is the end reached
    early. */
function planAfterEnded(finishedId) {
  const rules = continuationRules();
  if (!rules) return { nextId: null, rest: null, fromList: false };
  return rules.planAfterEnded(continuationState(), finishedId);
}

/** What plays after `finishedId`, or null. Applies the plan's one write (the
    finished episode leaves Up Next) and moves the chain on to the pick. */
function nextAfterEnded(finishedId) {
  const rules = continuationRules();
  if (!rules) return null;
  const step = rules.nextAfterEnded(continuationState(), finishedId);
  if (step.rest) saveQueueIds(step.rest);
  if (step.nextId) {
    state.playChainId = step.state.playChainId;
    if (step.fromList) state.playListCursor = step.state.playListCursor;
  }
  return step.nextId;
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
  isSaved(id) { return isSaved(id); },
  toggleSaved(id) { toggleStar(id); return isSaved(id); },
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
       the plan must start from where the engine now is. */
    state.playChainId = id;
    if (h.fromList) state.playListCursor = id;
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
  const nextId = nextAfterEnded(id);
  refreshEpisodeNavigation();
  if (!nextId) return;
  return startChained(nextId, ctx);
}

function startChained(nextId, ctx) {
  const nextItem = liveEpisode(nextId);
  if (!nextItem || !window.ForayPlayer) return;
  /* Called synchronously (the play belongs to this turn, as the end-of-episode
     event's), with a synchronous throw folded into the same rejection path. */
  let started;
  try {
    started = Promise.resolve(window.ForayPlayer.play(nextItem, { why: whyFor(nextId, nextItem) }));
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

/* A3.2 — tapping a chip goes to "shows in this category" (renderCategory),
   reusing taxonomy_node_ids overlap across the existing 220-show curated
   catalogue. Zero new data needed: the join is entirely against fields
   already fetched (state.taxonomy, state.catalog). Deliberately an <a>, not
   a <button> wired through JS, so it is a normal navigable link (right-click
   "open in new tab" etc. keep working, same reasoning as showNameLink).

   SINCE 2026-09-13 THIS HAS EXACTLY ONE CALLER: renderShow's chip strip,
   built from a show's OWN `taxonomy_node_ids`. The browse pills on #/shows
   used to call it too and no longer do — see `browseTile` below for the
   measurement that moved them. That is not a dead route left standing: an id
   that reaches this function comes off a show record, so `showsForCategory`
   returns at least that show BY CONSTRUCTION and the page it links to can
   never be the empty one the founder reported. The pills were the opposite
   case — they emit taxonomy ROOTS, and roots are almost never what a show is
   tagged with. Same renderer, two populations, and only one of them joined.
   test/category-browse.test.js pins both halves. */
function taxonomyChip(nodeId) {
  const node = (state.taxonomy?.nodes || []).find(n => n.id === nodeId);
  const label = esc(node?.label || nodeId);
  return `<a class="fy-chip" href="#/category/${esc(encodeURIComponent(nodeId))}">${label}</a>`;
}

/* Every catalogue show whose taxonomy_node_ids includes nodeId — the exact
   overlap check A3.2 calls for. Once Stage 3b's breadth catalogue becomes
   client-searchable this should extend to it too (separate card); for now
   it reads only state.catalog, the curated 220-show set. */
function showsForCategory(nodeId) {
  return (state.catalog?.shows || []).filter(s => (s.taxonomy_node_ids || []).includes(nodeId));
}

/* Shared shell for both the category list (A3.2) and the all-shows index
   (A3.3) — same "back, heading, sub, list-of-show-result-rows" shape
   renderShow/renderPlaylistDetail already use, and reuses showResultRow so a
   row here looks and behaves exactly like a Shows-search result.

   `above` is raw HTML dropped between the header and the A–Z list. It exists
   for the Shows page's editorial rows; the category page passes nothing and
   is byte-identical to what it rendered before.

   `subtitle` IS OPTIONAL (founder, 2026-09-13: "On the search page, delete
   '220 shows in 4a's…'"). It is not dropped as a parameter because the
   OTHER caller still wants one: renderCategory's "N shows in 4a's
   catalogue" is the only thing on that page that says how big the category
   is, and it is not a restatement of the heading the way the Shows page's
   was. An empty subtitle renders no `<p class="sub">` at all rather than an
   empty one, so the heading does not sit above a blank line's worth of
   leading.

   THE HEADER CARRIES NO SEARCH FIELD (founder, 2026-09-13, superseding his
   own report of an hour earlier). A `headExtra` slot used to exist here, and
   the Shows page used it to render the search field INSIDE `.page-head` so
   that the collapsing header's scroll-up would bring the field back. The
   field now lives at the BOTTOM of the search page instead (see
   renderAllShows and `#sh-compose` in styles.css), where it is always on
   screen — so "scroll up to reveal it" has nothing left to reveal, and the
   slot, its `.page-head-stacked` layout modifier and the branch that chose
   between two header shapes are all deleted rather than left standing as a
   second, unused mechanism.

   `.page-head` KEEPS ITS JOB and keeps its collapse: it still carries the ‹
   button and the page title, which are the things a header is for, and
   onWindowScroll still hides and re-shows it exactly as it has since
   2026-09-05 (test/collapsing-header-scroll.test.js). Nothing about that
   mechanism changed; only the field stopped riding along inside it. */
/* `shows === null` IS "THE CATALOGUE DID NOT LOAD", and it is a different page
   from an empty list (audit 2026-09-22, theme G). `state.catalog` is
   `fetchJson`'s answer, which is `null` for a 404, a parse error and a dead
   network alike — and "No shows here yet." painted over that null was a claim
   about 4a's catalogue standing in for a failed fetch, on a page whose search
   box could still find shows through the endpoints. The empty-list copy is now
   reachable only when the catalogue answered. */
/* NO ‹ ON A TAB ROOT (audit round 2, visual-6). Search, Create and Library are
   where the tab bar puts you, not a page pushed on top of one, so a back
   button there only duplicated the Home tab — a boxed ‹ under the borderless
   ☰ and ↻ that Home, the fourth tab, never had. Apple shows none on a tab's
   root. The pages you are SENT to (a show, an episode, a Foray, a category,
   Up Next, a playlist) keep theirs. `tabRoot` because this template is also
   the category page's, and that one is pushed. */
function renderShowIndexPage(title, subtitle, shows, above = "", { tabRoot = false } = {}) {
  setBodyClass("view-page");
  const list = shows === null
    ? `<div class="show-index-failed">${failedNoteHtml("Couldn't load the show list.")}</div>`
    : shows.length
      ? `<div class="show-results show-index">${shows.map(showResultRow).join("")}</div>`
      : `<p class="note">No shows here yet.</p>`;
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        ${tabRoot ? "" : `<a class="back" href="#/">‹</a>`}
        <div>
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ""}
        </div>
      </div>
      ${above}
      ${list}
    </div>`;
  if (shows === null) bindRetry($("#view .show-index-failed"), retryCatalog);
}

/** The Retry behind a failed catalogue: the same fetch init() made, then the
    same page repainted from whatever it answered. A second failure lands on the
    same failed state with a fresh button, never on an empty-list claim. */
async function retryCatalog() {
  /* THE PAGE THAT ASKED IS THE ONLY PAGE THAT REPAINTS (audit round 3,
     app-1-15; races-7's rule for retryForayDocs). The fetch is bounded but can
     take seconds, and a listener who moved on meanwhile had that page re-rendered
     under them — scroll, an in-progress show-page search and focus all lost. The
     catalogue is still kept; only the repaint is the asking page's. */
  const stillHere = renderToken();
  const catalog = await fetchJson("data/catalog-client.json");
  if (catalog) state.catalog = catalog;
  if (!stillHere()) return;
  renderCurrentPage();
  /* The retried page is the page's real paint (audit round 2, nav-3): its name
     reaches the document, and focus the replaced Retry button took with it
     lands on the heading. */
  pageDidPaint();
}

/** The catalogue's shows, or `null` when the catalogue itself never loaded — the
    one question both catalogue-backed pages have to ask before they may count. */
function catalogShowsOrNull() {
  return state.catalog ? (state.catalog.shows || []) : null;
}

/* A3.2's landing page. An unknown nodeId still renders — same "absence is a
   real state, not an error" rule renderShow's not-found guard follows —
   falling back to the raw id as its own label, and an empty result list
   getting the shared "No shows here yet" copy rather than a dead end.

   NO COUNT WITHOUT A CATALOGUE: "0 shows" over a failed fetch was the same
   false claim as the empty-state sentence under it, so both wait on the
   catalogue having answered. */
function renderCategory(nodeId) {
  const node = (state.taxonomy?.nodes || []).find(n => n.id === nodeId);
  const label = node?.label || nodeId;
  if (catalogShowsOrNull() === null) { renderShowIndexPage(label, "", null); return; }
  const shows = showsForCategory(nodeId).slice().sort((a, b) => a.title.localeCompare(b.title));
  renderShowIndexPage(label, countLabel(shows.length, "show"), shows);
}

/* A3.3 — the all-shows browsable index. A-Z over the full curated catalogue;
   category grouping is the Shows-search tab's job already (browse by
   category lives one tap away via any show's taxonomy chips), so this stays
   a single flat alphabetical list rather than duplicating that navigation.

   SINCE 2026-09-03 IT IS ALSO THE "Shows" MENU DESTINATION: everything
   show-shaped lives here now, because the founder asked for the show search
   and the "Shows we vouch for" row off Home and onto this page (items 1 and
   5). In order: search, the starred-shows shortcut, the editorial row, then
   A-Z. That order is deliberate \u2014 search answers "does this show exist
   here", which is why someone opens this page on purpose, and the A-Z list
   is the fallback for someone who does not know what they are looking for,
   so it goes last rather than pushing the search box under 220 rows.

   The tabbed "Playlists | Shows" switcher that used to wrap this search on
   Home went away with it. It existed only to time-share one strip of the
   home screen between two different questions; the playlist builder now
   lives on #/playlists and the show search here, so there is nothing left to
   toggle between. renderShowSearchResults - local-first paint plus the
   breadth endpoint - is unchanged.

   The old browse-all link is gone rather than moved (item 6): it was a link
   from Home to THIS page, and the menu's own "Shows" item is now that
   affordance. Nothing else in the app linked to it. */
/* U-05 (docs/ui-transition-plan.md): every taxonomy ROOT, for a "browse
   subjects" pill row on the Shows page (v2 only). Distinct from leafNodes()
   above the same way taxonomyNodes() is -- a root has `parent === null` --
   and this stays its own tiny helper rather than reusing subjectLabel's
   inline find, because that one looks up ONE root by id and this needs all
   of them, sorted for a stable pill order across renders. */
function taxonomyRootNodes() {
  return (state.taxonomy?.nodes || []).filter(n => n.parent === null).slice().sort((a, b) => a.label.localeCompare(b.label));
}

/* `decodeURIComponent` throws a URIError on a lone `%` — and a hash is
   user-authored text that anyone can type or paste. The other routes get away
   with the bare call because their ids come from our own links; this one is
   the shape a person types by hand. An undecodable query is not a query, so it
   degrades to "" and the caller lands on the plain browse page. */
function safeDecode(s) {
  try { return decodeURIComponent(String(s || "")); } catch (_) { return ""; }
}

/* U-05: the "browse subjects" pill row the mockup's Search screen shows
   above an active query (docs/ux/foray-mockup.jsx SearchScreen). v2-only —
   v1's Shows page had no such row and must not grow one (offline/v1
   behaviour unchanged is this card's own acceptance line).
   ---------------------------------------------------------------------
   FOUNDER, 2026-09-13 (issue #684): "clicking on any of the tiles on the
   search page gives 0 results. It should just search for that text."

   HE IS RIGHT, AND THE NUMBER IS WHY. These pills used to render
   `taxonomyChip`, i.e. a link to `#/category/<root id>`, and
   `showsForCategory` is an EXACT `taxonomy_node_ids.includes(id)` overlap
   that never walks children. Measured against the committed catalogue
   (data/taxonomy.json + data/catalog-client.json, 2026-09-13):

     41 pills rendered. 32 of them match ZERO shows. Only 9 taxonomy roots
     appear in any curated show's `taxonomy_node_ids` at all — shows are
     tagged with LEAVES (`science/materials`, `comedy/casual-hangs`), and a
     root is a leaf's parent, not one of its ids.

   So this was never about tagging being sparse or about #679 untagging one
   show. It is a root/leaf mismatch, and it made four fifths of the browse
   furniture on this page a set of buttons that reliably say "No shows here
   yet."

   WHY SEARCH AND NOT A DESCENDANT WALK. Teaching showsForCategory to expand
   a root (the fix docs/product/suggested-shows-requirements.md §6.7
   proposes) was measured too: it takes the 32 empty pills down to 4, with a
   median of 4 shows behind a pill, because it can still only ever answer out
   of the curated 220. Searching the pill's own label reaches the same local
   catalogue AND the breadth endpoint AND the directory: measured live the
   same day, every one of the 41 labels returns between 10 and 50 shows,
   median 37, none empty. The founder's fix is both the simpler change and
   the better answer, and it degrades the way the search box already does
   rather than the way a join does.

   THE PILL STAYS A PILL. Same `.fy-chip` class, same row, same styling; only
   its destination changed, so nothing in styles.css moves.

   STILL AN <a> TO A REAL ROUTE, not a button wired through JS — taxonomyChip's
   reasoning holds unchanged, and a search you can link to is strictly better
   than one you can only reach by tapping. `#/shows/q/<q>` rather than
   `#/shows?q=<q>` because `renderCurrentPage` matches with anchored regexes
   and an exact `h === "#/shows"`: a path segment is the shape that router
   already speaks, a query string would have to be taught to every branch.

   The prefix is a LITERAL, not an interpolated helper, for the same reason
   every other in-app link in this file is (test/app-security.test.js's "every
   interpolated href passes through safeUrl" rule): `safeUrl` gates schemes via
   `new URL`, which throws on a bare hash, so a hash route must be visibly
   constant in the template instead. The round trip from this href back through
   the router is pinned in test/category-browse.test.js rather than held
   together by a shared constant. */
function browseTile(nodeId) {
  const node = (state.taxonomy?.nodes || []).find(n => n.id === nodeId);
  const label = node?.label || nodeId;
  return `<a class="fy-chip" href="#/shows/q/${esc(encodeURIComponent(label))}">${esc(label)}</a>`;
}

function browsePillsHtml() {
  const roots = taxonomyRootNodes();
  if (!roots.length) return "";
  return `<div class="sh-browse-pills">${roots.map(n => browseTile(n.id)).join("")}</div>`;
}

/* THE BROWSE FURNITURE \u2014 everything on this page that is a SUGGESTION rather
   than an ANSWER: the browse-subjects pill row, the starred-shows shortcut,
   the "Shows we vouch for" editorial row, and the A\u2013Z index itself.

   Two nodes, not one wrapper, because the A\u2013Z list is rendered by
   renderShowIndexPage AFTER `above` and the two therefore cannot be enclosed
   in a single element without reshaping the template the category page
   shares. Missing nodes are filtered out rather than guarded at each call
   site, so this is safe on a page that has no search box at all. */
function showBrowseSections() {
  return [$("#sh-browse"), $("#view .show-index"), $("#view .show-index-failed")].filter(Boolean);
}

/* Tracks whether the Shows-page search field currently holds focus. A flag
   rather than `document.activeElement`: the field lives in an innerHTML
   template that is thrown away and rebuilt on every render, so the only
   honest source of truth is the focus/blur pair bound alongside it. Reset by
   renderAllShows on every render. */
let showSearchFieldFocused = false;

/* When that focus landed, in ms. Read by exactly one thing —
   maybeDismissKeyboardOnScroll — for exactly one reason, spelled out in that
   function's header: on iOS the keyboard's own arrival fires scroll events,
   so "the user scrolled" and "the keyboard just opened" are the same signal
   for a moment, and a dismiss-on-scroll rule with no settle window tears the
   keyboard down the instant it comes up. */
let showSearchFocusedAt = 0;

/* Founder, 2026-09-13: "The cards below the search box are kind of helpful
   initially, but should go away when I click on the search box to start
   typing."

   THE RULE, in one line: the browse furniture is visible exactly when the
   field is NOT focused AND the query is empty. Everything else follows from
   that single predicate rather than from a pile of event-specific branches.

     focus (tap the box)      -> hidden, immediately, before a single
                                 keystroke. FOCUS, not first-keystroke, and
                                 that is deliberate: on a phone the tap is
                                 what raises the keyboard and reflows the
                                 page, so doing both movements at once is one
                                 settling motion instead of two, and the
                                 first result then lands directly under the
                                 field instead of being inserted above 220
                                 unrelated rows. It is also what the report
                                 literally says ("when I click on the search
                                 box").
     blur with an empty box   -> back. Dismissing the keyboard on an empty
                                 field is "never mind", and browse is the
                                 page's resting state.
     blur with a live query   -> STAYS hidden. The results are the answer the
                                 listener is reading; pushing them down the
                                 page to re-expose the catalogue is the exact
                                 clutter being complained about.
     Escape                   -> clears the field, clears the results, blurs,
                                 and so lands on the "blur with an empty box"
                                 case: browse comes back. (Desktop only; a
                                 phone keyboard has no Escape, which is why
                                 blur has to be a restorer in its own right.)
     deleting the query while still focused -> stays hidden. You are still
                                 mid-search with the keyboard up; one blur
                                 brings the catalogue back. */
function updateShowBrowseVisibility() {
  const input = $("#sh-input");
  const hide = showSearchFieldFocused || !!(input && input.value.trim());
  /* THE PAGE'S HEIGHT GOES WITH THE FURNITURE, and it is worth writing down
     what that costs because #684 reports it as motion. Measured in Chromium at
     390x844 against the shipped page: with the A-Z index showing,
     `document.documentElement.scrollHeight` is 17809 px; the moment the field
     takes focus it is 844. A listener who had scrolled the catalogue and then
     reached for the field — which since #683 is a fixed pill at the BOTTOM of
     the screen, i.e. the thing you tap WITHOUT scrolling back up — goes from
     scrollY 4000 to 0.

     THAT MOVEMENT IS INHERENT TO HIDING THE CATALOGUE, not a defect in how it
     is hidden, and this function deliberately does NOT try to soften it. An
     explicit `scrollPageTo(0)` here was written and then measured: Chromium
     applies its own clamp synchronously, in the same turn as the `hidden`
     writes, so the viewport is already at 0 before anything else can read it
     and the extra call changed nothing observable. It was removed rather than
     kept as a line that looks like a fix. If the settling still reads badly on
     a device, the thing to revisit is #681's rule — hide on focus, and hide
     the A-Z index along with the cards — not this write. */
  for (const el of showBrowseSections()) el.hidden = hide;
  /* THE SAME PREDICATE, INVERTED, decides the ✕ beside the pill (Apple
     Podcasts swaps its idle Home button for one the moment the field is
     live). Deliberately not a second rule: "there is a search in progress"
     is one fact about this page, and the browse furniture going away and the
     dismiss button arriving are the same event seen from two sides. A
     separate predicate would be one more thing to drift. */
  const dismiss = $("#sh-dismiss");
  if (dismiss) dismiss.hidden = !hide;

  /* THE TAB BAR GOES AWAY WHILE THE FIELD HOLDS FOCUS (founder, 2026-09-14,
     with a screenshot of it wedged between the pill and the keyboard: "when
     the search bar is up, this home ribbon should go away"). Apple Podcasts
     shows nothing in that strip, and his own reference screenshot of it —
     which this whole row was built against — is the target.

     ON `showSearchFieldFocused`, NOT ON `hide`, and the difference is not an
     oversight. `hide` answers "is there a search in progress", which stays
     true across a blur with a live query — and that is the state where the
     listener is READING RESULTS with the keyboard gone. Taking the app's only
     navigation away from someone reading a page of results traps them: there
     would be no way off the search page but to empty the field. What the
     founder is describing, and what Apple actually does, is narrower: the bar
     yields to the KEYBOARD, for as long as the keyboard is up. Focus is that
     fact, it is the fact this function is already built out of, and no second
     listener is needed to observe it.

     A CLASS ON <body>, NOT `hidden` ON THE ELEMENT. `.tab-bar` carries
     `display: flex`, and any author `display` beats the UA sheet's
     `[hidden] { display: none }` at any specificity — the exact cascade trap
     renderTabBar's own header documents and test/home-layout.test.js's BUG 3
     exists to catch. `body.sh-searching .tab-bar { display: none }` is an
     author rule that outranks `.tab-bar`, so it wins on the terms the
     cascade actually judges.

     AND IT IS THE SAME CLASS THAT PAYS FOR IT. `--sh-dock` (styles.css) is
     the sum of the room already taken at the bottom edge, and `--tab-bar-h`
     is one of its terms. A bar that left without that term leaving with it
     would drop the pill by exactly the bar's height at the moment the bar
     vanished — the founder's report is a pill that MOVES, so fixing it by
     introducing one more way for it to move would be a poor trade. One class
     switches the visibility and the arithmetic together, which is the only
     reason they cannot disagree. */
  document.body.classList.toggle("sh-searching", showSearchFieldFocused);
}

/* "Never mind" — empty the field, drop the painted results (the same reset a
   deleted query already gets), and let go of focus, so the page lands back on
   its browse state by the ordinary rule rather than by a special case.

   ONE PATH, TWO TRIGGERS: Escape on a desktop keyboard, and the ✕ button for
   a thumb. Extracted the day the button was added, rather than copied, so the
   two can never answer differently. */
function dismissShowSearch(input) {
  if (!input) return;
  /* THE IN-FLIGHT SEARCH GOES WITH THE QUERY (audit round 2, races-2). This
     emptied the field and the painted results but left the debounce tick and
     the token alone, so a ✕ inside the 250 ms window let the pending tick run
     `runShowSearchCostly` for a query nobody could see: the cleared query's
     rows, episodes and CTA popped in under an empty field, and
     `noteShowQueryInRoute` wrote its address back. A keystroke that deletes the
     text always bumped the token; the button that does the same job must too. */
  supersedeShowSearch();
  input.value = "";
  clearShowSearchResults();
  /* And the address: dismissing on `#/shows/q/Science` left the query in the
     URL, so a reload or a return brought "Science" back (audit 2026-09-22). */
  noteShowQueryInRoute("");
  showSearchFieldFocused = false;
  if (typeof input.blur === "function") input.blur();
  updateShowBrowseVisibility();
}

/* `initialQuery` is #/shows/q/<q>'s payload — the browse tiles' destination
   (see `browseTile`) and anything else that wants to land on this page with
   an answer already on it. Empty string is the ordinary #/shows arrival and
   is byte-identical to what this rendered before.

   IT DOES NOT FOCUS THE FIELD. On a phone, focus raises the keyboard, and a
   listener who tapped "Science" asked to SEE shows, not to type. The query
   is in the box so it can be edited, the results are painted, and the
   keyboard stays down. */
function renderAllShows(initialQuery = "") {
  const query = String(initialQuery || "").trim();
  const catalogShows = catalogShowsOrNull();
  const shows = catalogShows && catalogShows.slice().sort((a, b) => a.title.localeCompare(b.title));
  /* NO SUBTITLE (founder, 2026-09-13: "On the search page, delete '220 shows
     in 4a's\u2026'"). renderCategory keeps its own \u2014 see renderShowIndexPage. */
  /* THE FIELD IS A COMPOSE BAR AT THE BOTTOM (founder, 2026-09-13: "We should
     likely also move the search bar down to the bottom - model it after most
     other text boxes, for example in the Claude app or Apple Podcasts").

     `#sh-compose` is `position: fixed` (styles.css), so where it appears in
     this template decides only two things, and neither is where it is
     painted:

       TAB / READING ORDER. It is emitted FIRST, ahead of the results and the
       browse furniture, because it is this page's primary control \u2014 the
       reason anyone opens #/shows \u2014 and a keyboard or VoiceOver user should
       reach it without walking 220 catalogue rows. Visually it is last;
       those two orders disagree here on purpose, and the visual one is the
       founder's ask.

       LIFETIME. It is inside `#view`, so the next render throws it away with
       the rest of the page and there is nothing to tear down by hand. A
       fixed element parked on `<body>` would outlive the page that owns it.

     THE SHAPE IS APPLE PODCASTS', matched against the founder's own
     screenshots of it rather than guessed: a FLOATING ROW inset from both
     screen edges \u2014 a translucent rounded pill holding the field, with the
     page's content scrolling visibly behind it \u2014 and a circular companion
     button beside the pill. The wrapper is a real element, not `position:
     fixed` on `#sh-form`, precisely because the row holds two siblings: the
     pill and that button.

     THE COMPANION BUTTON IS A DISMISS, AND ONLY WHEN THERE IS SOMETHING TO
     DISMISS. Apple's idle state puts a Home button there and swaps it for a
     circular \u2715 on focus. We do not copy the Home half: Apple has no tab bar
     in that screenshot \u2014 their floating Home pill IS their navigation \u2014
     whereas `.tab-bar` already carries Home two rows below this one, and a
     second Home button inside the search row would be the same destination
     twice. So the slot is EMPTY when idle and holds the \u2715 when the field is
     focused or holds a query, which is the half of Apple's pattern that does
     something we lack.

     And it fills a gap this page already had in writing: the Escape handler
     below notes that Escape is "desktop only; a phone keyboard has no
     Escape". This button is that key, for a thumb \u2014 it runs the identical
     path, `dismissShowSearch`, rather than a parallel implementation.

     NOTHING IN THE TRAILING SLOT. Apple's pill has a microphone there; we
     have no dictation, and a glyph that does nothing is worse than an empty
     slot. It held a "Go" submit button until 2026-09-14, and the founder
     deleted it on sight: "since the search results are live, the 'go' button
     is useless, delete it."

     HE IS RIGHT, AND THE REASON IS IN THIS FILE. G2's standing decision was
     "keep the button, keep Enter, make neither required" \u2014 written when the
     button was the only way to run a search at all. S-02 then made the
     results filter live on every keystroke (see the three bindings below),
     which retired the button's job without retiring the button: by the time
     a thumb travelled to it, the results it would have produced were already
     on screen. A control whose only effect is to skip a 250ms debounce on
     work that has already finished is not a shortcut, it is furniture.

     THE FORM AND ITS `submit` HANDLER STAY. Deleting the button is not
     deleting the path: `submit` is what a phone keyboard's return key fires,
     and that is how the keyboard is DISMISSED from inside the field. A
     `<form>` with no submit control still submits on Enter, so the return
     key keeps working and keeps skipping the debounce; what is gone is only
     the tappable duplicate of it.

     The leading magnifier is kept: it is what tells you the pill is a search
     field rather than a compose box. */
  /* ONE NAME PER DESTINATION (audit 2026-09-22): the tab bar calls this page
     Search, so its heading does too — it was "Shows" here and in the drawer. The
     field searches shows, episodes and playlists, so the placeholder says more
     than "shows by name". */
  renderShowIndexPage("Search", "", shows, `
      <div id="sh-compose">
        <form id="sh-form" role="search" autocomplete="off">
          <svg class="sh-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>
          <input id="sh-input" type="text" maxlength="120" placeholder="Search shows and episodes\u2026" aria-label="Search shows and episodes" ${SEARCH_INPUT_ATTRS}>
        </form>
        <button id="sh-dismiss" type="button" aria-label="Clear search" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>
        </button>
      </div>
      <p id="sh-note" class="note" role="status" aria-live="polite" hidden></p>
      <div id="sh-partial-note" hidden></div>
      <div id="sh-empty-offer" hidden></div>
      <p id="sh-offline-note" class="note" hidden>${OFFLINE_SEARCH_NOTE}</p>
      <div id="fy-search-results" hidden></div>
      <!-- The shows tier's eyebrow (audit round 2, visual-16): Episodes and
           Playlists label their tiers, and the first one was the only bare
           list. styles.css hides it whenever #sh-results is hidden, so
           paintShowResults needs no second switch to keep them in step. -->
      <h3 class="sh-results-head">Shows</h3>
      <div id="sh-results" class="show-results" hidden></div>
      <div id="ep-search-results" hidden></div>
      <div id="pl-search-results" hidden></div>
      <div id="sh-browse">
        <!-- ABOVE the browse cloud, not below it (visual pass 1, 2026-09-23):
             below, the page's one non-chip action sat exactly under the
             floating search pill at scroll 0 on a 390x844 phone. Apple keeps
             its Library shortcuts at the top of Search for the same reason.
             ONLY WHEN THERE IS SOMETHING BEHIND IT (audit round 2, p-first-12):
             on a fresh install this was the page's first tappable row and it
             led to "0 shows you follow". Apple hides an empty Library shortcut;
             so does this. Library still lists the section, with its own empty
             note, so the feature stays discoverable. -->
        ${Object.keys(starredShowsMap()).length ? `<a class="page-link-row" href="#/starred-shows">Followed shows \u203a</a>` : ""}
        ${browsePillsHtml()}
        ${vouchForHtml()}
      </div>`, { tabRoot: true });
  /* The page reserves room at its bottom edge for a bar that is fixed and so
     occupies none of its own. Added AFTER renderShowIndexPage, which writes
     document.body.className wholesale through setBodyClass() and would
     otherwise wipe it \u2014 and that same wholesale write is what removes this
     class again on navigation away, so it needs no cleanup of its own. */
  document.body.classList.add("sh-compose");

  /* S-02 (docs/search-plan.md, founder feedback F2: "Shows search should
     filter live as you type. Hitting Go should not be required.").

     THREE BINDINGS, AND THE SPLIT BETWEEN THEM IS THE WHOLE CARD:

       input   -> the LOCAL pass only, every keystroke, no network, no episode
                  search, no playlist CTA. Measured (docs/search-plan.md §1.6):
                  0.010-0.074 ms median over the curated 220, 0.004-2.1 ms over
                  S-03's 10,113-row index — inside a 16 ms frame either way.
                  Then a 250 ms trailing debounce for everything that costs
                  something.
       submit  -> the same thing with the debounce SKIPPED. The keyboard's
                  return key is the only thing that lands here now — the Go
                  button was deleted 2026-09-14 (see the compose-bar comment
                  above for why, and for why this path outlived it: return is
                  how a phone keyboard is dismissed from inside the field).
       focus   -> S-03's lazy index load, once. Never at init(): the decode is
                  ~113 ms measured, and it must not sit on the boot path or on
                  a keystroke.

     WHY THE COSTLY PASSES MOVED (each of the three was measured in §1.5, and
     naively adding an `input` listener would have multiplied all three by the
     keystroke):
       - `renderEpisodeSearchResults` is a SECOND network call, and the
         SLOWER of the two;
       - the breadth pass is a network call, 0.4-1.1 s;
       - `renderPlaylistSearchResults`'s CTA schedules `topicSearchStatus()`, a
         full relaxation scan this repo's own source measures at 1.3-8 s cold.
     All three now run on the debounce tick only — see `runShowSearchCostly` —
     each behind its own hot-query cache or the idle queue, and all three are
     measured into the ONE `search` diagnostics record that tick writes. */
  $("#sh-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#sh-input");
    const query = input.value.trim();
    if (!query) return;
    renderShowSearchResults(query);
    /* AND THE KEYBOARD COMES DOWN (audit round 2, search-3). The two comments
       above say return "is how the keyboard is DISMISSED from inside the
       field", and the Go button was deleted on that premise — but nothing here
       ever let go of the field, and a `preventDefault`ed submit leaves WebKit's
       keyboard exactly where it was. The blur lands on the "blur with a live
       query" case of updateShowBrowseVisibility: results stay, browse furniture
       stays hidden, the tab bar returns. */
    if (typeof input.blur === "function") input.blur();
  });

  /* A fresh render starts from the resting state: nothing focused, browse
     furniture showing. Without this a return to #/shows after leaving it
     mid-search would open with the catalogue already hidden.

     `#/shows/q/<q>` is the one arrival that is NOT resting: the field is
     seeded first so `updateShowBrowseVisibility`'s single predicate ("the
     field is focused OR holds a query") hides the browse furniture for the
     ordinary reason rather than through a second rule. */
  showSearchFieldFocused = false;
  /* A NEW MOUNT SUPERSEDES EVERY PASS THE OLD ONE STARTED (audit 2026-09-22).
     The token was only ever bumped by a keystroke, so type "radio", tap Home
     and tap Search again inside the directory pass's ~0.5 s and the old pass
     still held the current token — its "radio" results painted above the
     browse list, under an empty field, for a query nobody could see. */
  supersedeShowSearch();
  if (query) {
    const seed = $("#sh-input");
    if (seed) seed.value = query;
  }
  /* This page IS the Search tab's last stop, with or without a query; the tab
     bar reads it back when the lit tab is tapped from a pushed page. */
  rememberSearchTabHash(query ? "#/shows/q/" + encodeURIComponent(query) : "#/shows");
  updateShowBrowseVisibility();

  const input = $("#sh-input");
  if (input) {
    input.addEventListener("input", () => { onShowSearchInput(input.value); updateShowBrowseVisibility(); });
    /* Once. `loadShowIndex` is itself idempotent (it returns the in-flight
       promise, then the resolved index), so a second focus costs nothing and
       this needs no `{ once: true }` — which would be wrong anyway, since a
       first attempt that failed offline should be retried on a later focus. */
    input.addEventListener("focus", () => {
      loadShowIndex();
      showSearchFieldFocused = true;
      /* The two things scroll-to-dismiss needs, both stamped here rather than
         in the scroll handler, because here is where the event actually is.
         Re-baselining `lastScrollY` matters as much as the timestamp: without
         it the first post-focus scroll is measured against wherever the page
         last sat, and a stale baseline can hand the handler a large fake
         downward delta on the very first frame after focus. */
      showSearchFocusedAt = Date.now();
      /* TO THE TOP, ON FOCUS (founder, 2026-09-17: "When I click search, it
         jumps down to the bottom, so then I need to scroll up to find the top
         search result for shows.")

         The compose pill is `position: fixed` at the bottom edge, so it needs
         no scrolling to be reachable — but the page under it is the full A–Z
         show list, 17,712px tall as measured on 2026-09-17. iOS scrolls a
         focused field into view against the LAYOUT viewport as the keyboard
         comes up, and on a document that tall the correction lands thousands of
         pixels down. Results then paint at the TOP of the page, above where the
         listener is now standing, which is the "scroll up to find the top
         result" in the report.

         Desktop Chrome hides this: typing collapses the document to one
         viewport (the browse list is hidden while searching) and the browser
         clamps scrollY back to 0 on its own. Measured in a 390px harness — jump
         to 6000, type, land at 0, first result at y=125. That clamp is the
         browser being helpful, not a contract, and iOS with a keyboard up does
         not do it. So the page says where it wants to be instead of hoping.

         Before the results exist, not after: the scroll has to be settled while
         the keyboard animates, or it fights the listener's own first scroll.

         ONLY WHEN THE FIELD IS EMPTY, and that qualifier is the whole rule
         rather than a detail. The first draft scrolled on EVERY focus, which
         broke the opposite case just as badly: a listener scrolled down into
         their results who taps the field to edit the query got yanked back to
         the top — the same rudeness, pointed the other way. It also made the
         very next upward scroll read as a large DOWNWARD delta (the page had
         just moved to 0 under it), so `maybeDismissKeyboardOnScroll` blurred the
         field and dropped the keyboard. Caught by
         test/playwright/tests/search-chrome-dock.spec.js's "a downward scroll
         blurs the field; an upward one does not", in a real browser, which is
         the only place that arithmetic is observable.

         An empty field is the case the founder reported: you are STARTING a
         search, whatever is under you is the A-Z browse list, and the results
         will paint at the top. A field with a query in it means you are already
         reading results, and where you are standing is where you chose to be. */
      if (!input.value.trim()) scrollPageTo(0);
      /* Re-baselined AFTER the scroll above, and that order is the whole of it.
         `maybeDismissKeyboardOnScroll` measures a DELTA against this; a
         baseline captured before we move leaves the next frame comparing the
         new position against the old one and reading a large fake downward
         delta, which blurs the field and drops the keyboard the instant the
         listener starts typing.

         Read, not assumed to be 0. `scrollPageTo` moves a real viewport to 0,
         but it is deliberately a no-op where there is nothing to move (its own
         guard, for the node:vm suites), and asserting a position the viewport
         never took is how this handler would start lying about the baseline.
         Caught by test/keyboard-chrome-and-scroll.test.js's up-scroll case. */
      lastScrollY = window.scrollY || 0;
      updateShowBrowseVisibility();
    });
    input.addEventListener("blur", () => {
      showSearchFieldFocused = false;
      updateShowBrowseVisibility();
    });
    /* Escape is the desktop "never mind". The ✕ button below is the same
       thing for a thumb, which is why both call one function. */
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      dismissShowSearch(input);
    });
  }

  const dismiss = $("#sh-dismiss");
  if (dismiss) {
    /* `mousedown`, NOT `click`, and that is the whole reason this is not a
       one-liner. The button is only on screen while the field holds focus or
       a query; pressing it blurs the field first, `updateShowBrowseVisibility`
       then hides the button, and the `click` that would have followed lands on
       an element that is no longer there — so on a desktop the button does
       nothing at all. `mousedown` fires before focus moves. `preventDefault`
       stops the press from stealing focus in the first place, so there is no
       blur/refocus flicker either. Touch devices synthesise mousedown from a
       tap, so one listener covers both. */
    dismiss.addEventListener("mousedown", (e) => {
      if (typeof e.preventDefault === "function") e.preventDefault();
      dismissShowSearch(input);
    });
    /* AND `click`, for the keyboard (audit 2026-09-22, qa row 62). Enter and
       Space on a <button> fire `click`, never `mousedown`, so a keyboard or
       switch user reached a named, focusable control that did nothing. A
       key-made click has `detail === 0`; a pointer's has already been handled
       by the mousedown above, so it is skipped rather than run twice. */
    dismiss.addEventListener("click", (e) => {
      if (e && e.detail !== 0) return;
      dismissShowSearch(input);
    });
  }

  /* LAST, after every listener is bound, because this paints into the nodes
     above and then runs the same costly pass a submit would — a pass that can
     resolve at any point and must not land on a half-wired page. It is
     `renderShowSearchResults`, the SUBMIT path, verbatim: a tile IS a submit
     the listener did not have to type.

     AND IT LOADS THE INDEX (audit round 2, search-6). S-03 tied the index to
     the first FOCUS so a listener who never searches never pays the decode;
     #684 then made every browse pill a `#/shows/q/<label>` arrival, which
     never focuses the field on purpose. So a pill, a return via ‹ and a reload
     all ran their local pass over the curated 220 only, with the 10,113-row
     index — the thing that makes search feel instant — never fetched until the
     field was tapped. A query arriving here IS a search, which is the case
     S-03's lazy rule was written to serve, not to skip; `#/shows` without a
     query still fetches nothing. `repaintShowSearchForIndex` merges the rows
     in when the index lands. */
  if (query) {
    loadShowIndex();
    renderShowSearchResults(query);
  }
}

/* Stage 3b (docs/show-pages-plan.md §Stage 3, kanban t_567b570f): full
   per-show episode list, fetched on demand from the backend endpoint rather
   than the curated discover-pool ceiling `episodesForShow` gives (median 7
   episodes). Maps a full-catalogue row into the same shape `snapshot()`
   already knows how to normalize (id/title/hook/show/audio_url/duration_min)
   and seeds it into `state.itemIndex` — bindPlay/toggleStar both read
   `state.itemIndex[id]` first, so a full-catalogue row plays and stars
   exactly like a curated one. No new row UI needed; every episode gets a
   real, playable audio_url straight from the endpoint, never a link-out. */
/** THE ONE IDENTITY OF A SHOW-EPISODE ROW (audit round 3, app-1-3/app-1-5).
    The feed's guid when it has one; otherwise the SAME fallback the list
    endpoint mints (api/shows/[show_id]/episodes.ts toLiveEpisode:
    `noguid:<title>:<published_at>`). The show-scoped search endpoint passes a
    null guid straight through, and building the id as `${show}--${ep.guid}`
    made every guid-less row `<show>--null`: one itemIndex slot, so each row's
    ▶ played the last row's audio. Rows from the endpoints carry `guid`, never
    `id`, so this is also what two fetched pages are compared by. */
function showEpisodeGuid(ep) {
  if (!ep) return "";
  if (ep.guid != null && String(ep.guid) !== "") return String(ep.guid);
  return `noguid:${ep.title ?? ""}:${ep.published_at ?? ""}`;
}

function fullCatalogueRowToEpRowItem(show, ep) {
  const id = `${show.show_id}--${showEpisodeGuid(ep)}`;
  return snapshot(id, {
    show: show.title,
    /* THE SHOW'S ID RIDES ON THE SNAPSHOT (audit round 2 review of
       p-switcher-7): `snapshot()` keeps it, and without it an episode saved or
       queued from a breadth show's page rendered its show name as plain text in
       Library, Up Next and on #/episode — the title join reaches only the
       curated 220 and whatever of the show index happens to be loaded. */
    show_id: show.show_id || null,
    title: ep.title,
    hook: ep.description_text || "",
    /* THE SHOW'S ARTWORK, which this mapping did not carry (founder,
       2026-09-21: the car shows no art alongside the blank credits).

       `api/shows/:id/episodes` returns no per-episode image, and most podcasts
       do not set one -- the show's square is the right art for its episodes and
       is what Apple Podcasts displays. Without it, EVERY episode played from a
       show page reached `mediaMetadata` with `artwork_url: null`, so the lock
       screen and the car fell back to the 4a icon. Curated pool episodes carry
       their own and were unaffected, which is why this only shows up on the
       breadth path -- the one the founder actually listens on. */
    artwork_url: show.artwork_url || null,
    audio_url: ep.audio_url,
    duration_min: ep.duration_seconds ? Math.round(ep.duration_seconds / 60) : null,
    duration_sec: ep.duration_seconds ?? null,
    topics: [],
    // A1.2/A1.1/A1.5: Stage 3b's endpoint carries the publisher's own
    // publish date/description/chapters directly on each episode row —
    // pass them straight through so renderEpisode/epRow/archivedRow can
    // render them. `description` is deliberately the full text, kept
    // separate from `hook` above (4a's curated one-liner stays as-is).
    release_date: ep.published_at || null,
    description: ep.description_text || null,
    chapters: Array.isArray(ep.chapters) ? ep.chapters : null,
  });
}

/* S-06 (kanban t_be4c1793): `cursor` is the API's own opaque keyset cursor
   (episodeCursor.ts) — when present the next page continues strictly after
   that episode rather than restarting from the top. Omitting it (the
   original call shape every existing caller/test still uses) fetches page 1
   exactly as before, so this stays backward compatible.

   `nextCursor` in the return value is the API's `next_cursor` — null means
   "no more pages," which is the ONLY signal renderShow is allowed to treat
   as "the full list is now loaded" (see its own honesty rule below: a
   present cursor must never be silently dropped by a caller that stops
   paging on its own accord). */
/* ---------- the first page of a show's episodes, remembered ----------------

   FOUNDER, 2026-09-18: "I've had to load Lex's entire episode list multiple
   times now and each time takes many seconds to load."

   Nothing was cached. `fetchShowEpisodes` passed `cache: "no-cache"`, which
   forces a revalidation against the origin on EVERY call, and no caller kept
   the answer — so every visit to a show page paid the full round trip again,
   and so did every "load more" page the listener had already scrolled past.

   WHAT IS CACHED, and what deliberately is not. The FIRST page only, per show.
   That is the page every visit starts from and therefore the one that is paid
   for repeatedly; deeper pages are reached by scrolling, which is a thing you
   did on purpose and do not usually repeat. Caching the whole keyset walk would
   also mean storing an unbounded list per show against a cursor scheme whose
   invalidation rules we do not control.

   STALE-WHILE-REVALIDATE, not a read-through cache. A podcast gains episodes;
   a cache that served yesterday's list until it expired would answer the
   founder's complaint by creating a subtler one. So a cached page paints
   IMMEDIATELY and a fetch still goes out behind it, and the list is replaced
   only if the answer actually differs — see `renderShow`. The listener sees
   episodes in one frame instead of several seconds, and still sees today's.

   TTL exists only to bound how stale the FIRST paint can be, not to gate the
   refresh. The refresh is unconditional.

   In memory, not durable. `state` dies with the tab, which is the right
   lifetime for a list the API can re-derive cheaply; an IndexedDB copy would
   add an eviction policy and a schema for no gain the founder asked about. */
const SHOW_EPISODES_TTL_MS = 30 * 60 * 1000;

/** Cached first pages, `show_id -> { at, episodes, nextCursor, stale }`.
    BOUNDED (audit round 3, app-1-11): an LRU of SHOW_EPISODES_CACHE_MAX shows —
    Map insertion order is the recency order, a hit moves to the end — with the
    expired entries swept on every insert. Unbounded, every show visited kept its
    whole first page (descriptions included) alive for the session. */
const showEpisodesCache = new Map();
const SHOW_EPISODES_CACHE_MAX = 10;

/** The cached first page, or null when absent or past its TTL. */
function cachedShowEpisodes(show_id) {
  const hit = showEpisodesCache.get(show_id);
  if (!hit) return null;
  if (Date.now() - hit.at > SHOW_EPISODES_TTL_MS) { dropShowEpisodes(show_id); return null; }
  showEpisodesCache.delete(show_id);
  showEpisodesCache.set(show_id, hit);
  return hit;
}

function cacheShowEpisodes(show_id, payload) {
  const now = Date.now();
  for (const [k, v] of showEpisodesCache) if (now - v.at > SHOW_EPISODES_TTL_MS) dropShowEpisodes(k);
  showEpisodesCache.delete(show_id);
  showEpisodesCache.set(show_id, { ...payload, at: now });
  while (showEpisodesCache.size > SHOW_EPISODES_CACHE_MAX) dropShowEpisodes(showEpisodesCache.keys().next().value);
}

/** Forget a show's cached page AND the publisher text its rows put in
    `state.itemIndex` (app-1-11). The row snapshots stay — ids must keep
    resolving for stars, Up Next and history — but trimmed the way the durable
    tier stores them (`storableEpisode`: a short hook, no description), which is
    what the episode page already shows for such an episode after a reload. A
    catalogue episode is never touched. */
function dropShowEpisodes(show_id) {
  showEpisodesCache.delete(show_id);
  const prefix = `${show_id}--`;
  for (const id of Object.keys(state.itemIndex)) {
    if (!id.startsWith(prefix) || state.poolIds.has(id)) continue;
    const snap = state.itemIndex[id];
    if (snap && snap.description != null) state.itemIndex[id] = { ...storableEpisode(snap), chapters: snap.chapters ?? null };
  }
}

/** First-page fetches currently in flight, by show id.
 *
 *  Two callers now want the same page at almost the same moment: the prefetch
 *  fired when a listener presses a show link, and `renderShow` a fraction of a
 *  second later. Without this they are two round trips for one answer, and the
 *  prefetch buys nothing at all — the page would start its own.
 *
 *  Deduped on the FIRST PAGE only. Deeper pages are reached by scrolling, which
 *  is deliberate and not raced.
 */
const showEpisodesInFlight = new Map();

/**
 * Start a show's first page BEFORE the listener arrives on its page.
 *
 * FOUNDER, 2026-09-21: "it should be preloaded by the time I open the show
 * (perhaps we can get clever about loading most recent episodes for the top
 * shows in a search result while still on a search page, or somehow speed this
 * up)".
 *
 * Bound to `pointerdown`, which fires on press rather than on release — worth
 * 100-200 ms of head start on a phone, and more if the listener is scrolling and
 * pauses on a row. By the time `renderShow` asks, the request is in flight and
 * `showEpisodesInFlight` hands it the same promise rather than starting a second.
 *
 * DELIBERATELY NOT a prefetch of every show in a search result. That is the
 * founder's other suggestion and it is the more expensive one: ten results is
 * ten feed fetches and ten cache entries for the one the listener opens, paid on
 * every keystroke's worth of results. A press is a much stronger signal than a
 * result, and it arrives early enough to be worth almost as much.
 *
 * Fire-and-forget by construction: the result lands in `showEpisodesCache` and
 * a rejection is swallowed, because a prefetch that fails must cost nothing —
 * `renderShow` will ask again and handle the failure in the one place that knows
 * how to paint it.
 */
function prefetchShowEpisodes(show_id) {
  if (!show_id || cachedShowEpisodes(show_id) || showEpisodesInFlight.has(show_id)) return;
  fetchShowEpisodes(show_id).then((r) => {
    if (r && Array.isArray(r.episodes) && r.episodes.length) {
      cacheShowEpisodes(show_id, { episodes: r.episodes, nextCursor: r.nextCursor, stale: !!r.stale, show: r.show });
    }
  }).catch(() => { /* a prefetch that fails costs nothing */ });
}

/** One delegated listener for every show link on the page, present and future. */
function bindShowPrefetch() {
  if (typeof document.addEventListener !== "function") return;
  document.addEventListener("pointerdown", (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href^="#/show/"]');
    if (!a) return;
    const href = a.getAttribute("href") || "";
    /* The route parser, not a slice (app-1-16): a `/q/<query>` tail is not
       part of the id. */
    const id = parseShowRoute(href)?.id;
    if (id) prefetchShowEpisodes(id);
  }, { passive: true });
}

async function fetchShowEpisodes(show_id, cursor) {
  if (!cursor) {
    const live = showEpisodesInFlight.get(show_id);
    if (live) return live;
  }
  const p = fetchShowEpisodesUncached(show_id, cursor);
  if (!cursor) {
    showEpisodesInFlight.set(show_id, p);
    /* Cleared however it settles. A rejected promise left in the map would make
       every later attempt replay the same failure. */
    p.finally(() => { if (showEpisodesInFlight.get(show_id) === p) showEpisodesInFlight.delete(show_id); });
  }
  return p;
}

async function fetchShowEpisodesUncached(show_id, cursor) {
  try {
    const path = `api/shows/${encodeURIComponent(show_id)}/episodes`;
    const url = cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
    /* `cache: "no-cache"` is gone. It forced a full revalidation round trip on
       every single call — the HTTP cache was never allowed to answer, so the
       endpoint's own `Cache-Control` could not help either. `"default"` lets a
       fresh response be reused and a stale one be revalidated, which is what
       those headers are for. Our own `showEpisodesCache` sits above this and is
       what makes the first paint instant; this is the second line of defence,
       and it is the one that also covers the deeper pages.

       BOUNDED (audit round 2, states-4). This was the one `/api/*` call the
       2026-09-23 "no request waits forever" review did not reach: a bare fetch
       to API_ORIGIN, which in the native shell — no service worker, no
       NET_TIMEOUT_MS — could sit on a stalled socket for good, and with it the
       show page on "Loading episodes…" with no Try again, while
       `showEpisodesInFlight` handed every later visit to the same show the same
       hung promise. Same AbortController + withDeadline shape as fetchApiJson;
       past the bound it answers exactly what a failed fetch answers, so the
       `failed` outcome and its Try again fire through the one writer. */
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const res = await withDeadline(
      fetch(apiUrl(url), ctl ? { signal: ctl.signal } : undefined),
      API_DEADLINE_MS,
      () => { try { if (ctl) ctl.abort(); } catch (_) { /* nothing left to free */ } return null; }
    );
    if (!res) return { episodes: null, nextCursor: null, error: "timeout" };
    if (!res.ok) return { episodes: null, nextCursor: null, error: `status ${res.status}` };
    const body = await res.json();
    return {
      episodes: body.episodes || [],
      nextCursor: body.next_cursor || null,
      /* THE PUBLISHER'S OWN SHOW DESCRIPTION (founder, 2026-09-21: "the show
         description looks like it's something we generated. Is there a field
         from the show's host that we can pull instead?").

         There is, and it has been arriving here all along — this function was
         simply dropping it. `api/shows/:id/episodes` returns a `show` header,
         and on the live-fetch path (the one production runs — there is no
         DATABASE_URL, and that endpoint's own comment says the DB branch is
         dormant) it carries `description` straight from the feed's
         `<channel><description>`, sanitised to text by
         `backend/src/feeds/parser.ts`. Verified against production on
         2026-09-21: `lex-fridman-podcast` returns his real channel blurb.

         Kept as the whole header rather than just the description: `title` and
         `image` come with it, and a breadth show that is not in `catalog.json`
         has no other source for either. */
      show: body.show || null,
      // `degraded` (no-DB live-fetch failure, S-02) and `stale` (DB-mode
      // cached-stale) are two different backends' names for the same
      // "this isn't a fresh fetch, say so" signal — surfaced identically.
      stale: !!(body.stale || body.degraded),
      error: body.error || null,
    };
  } catch (e) {
    return { episodes: null, nextCursor: null, error: e && e.message || "network error" };
  }
}

/* A2.5: "Similar shows" — deterministic taxonomy-overlap similarity, zero new
   data needed (docs/product requirements audit note: taxonomy_node_ids
   already sits on every catalog.json show record, unused for this purpose
   until now). Score = count of taxonomy_node_ids shared with `show`; a show
   sharing none is not "weakly similar", it is unrelated, so it is filtered
   out rather than padded in (same "honest sparse/empty beats padding" rule
   buildPlaylist's tiering already follows). Ties broken by show_id so the
   order is stable and pinnable in a test, not accidentally date- or
   insertion-order-dependent. Returns [] (never throws) for a show with no
   taxonomy_node_ids of its own — there is nothing to overlap against. */
function similarShows(show, limit = 6) {
  const nodeIds = new Set(show?.taxonomy_node_ids || []);
  if (!nodeIds.size) return [];
  const all = state.catalog?.shows || [];
  return all
    .filter(s => s.show_id !== show.show_id)
    .map(s => ({ show: s, shared: (s.taxonomy_node_ids || []).filter(id => nodeIds.has(id)).length }))
    .filter(x => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.show.show_id.localeCompare(b.show.show_id))
    .slice(0, limit)
    .map(x => x.show);
}

/* Reuses showResultRow verbatim (same "names a SHOW, not a playable item"
   rule the shows-search results already follow) rather than inventing a
   second show-card markup for the same kind of link. Renders nothing (not
   an empty section) when there is no overlap — matches every other join on
   this page (moreFromShow, the "no episodes" branch above). */
function similarShowsSection(show) {
  const shows = similarShows(show);
  if (!shows.length) return "";
  return `<section class="ep-more">
    <h3>Similar shows</h3>
    <div class="show-results">${shows.map(showResultRow).join("")}</div>
  </section>`;
}

/* ---------- "used in these forays" (show page, requirements B3/Q6) ----------

   The reverse of foraySourcesHtml's join: that surface starts from a resolved
   Foray and asks "which shows is this made of"; this starts from a show and
   asks "which forays draw on it". The actual segment/source walk happens in
   player/foray-resolve.js's foraysReferencingShow, bridged through
   player/client.js — app.js itself is NOT allowed to enumerate the pool of
   segments/sources beyond the one fetch-assignment line below (see
   tools/mobile/prepare-webdir.test.js's "nothing in the app browses the
   segment pool" premise, #327): the mobile bundle ships only the segments
   its bundled Forays reference, so a surface that walked the pool directly
   here would render complete on the website and silently short in the app.

   Read synchronously off window.ForayPlayer, same trade-off forayCards()
   already makes for the home screen's Foray row: on a cold load where the
   player module has not evaluated yet, the footer is simply absent until the
   next render rather than blocking renderShow on an await. */
function foraysUsingShow(show) {
  if (!show || !window.ForayPlayer || typeof window.ForayPlayer.foraysUsingShow !== "function") return [];
  if (!state.forays) return [];
  const names = [show.title, TITLE_ALIASES[show.title]].filter(Boolean);
  /* Same two-call shape as forayCards(): the published rows exactly as before,
     then the drafts the test-track switch admitted. */
  return withTestTrackDrafts(opts => window.ForayPlayer.foraysUsingShow(state.forays, names, {
    segmentsDoc: state.segments,
    sourcesDoc: state.segmentSources,
    ...opts,
  }));
}

/* Deliberately its own <footer>, never mixed into the episode list above it —
   requirements doc's B1 rule (forays stay visually distinct from episodes
   everywhere) applies here too: this is 4a's own cross-reference, not
   anything the show itself published. */
function showForaysHtml(show) {
  const forays = foraysUsingShow(show);
  if (!forays.length) return "";
  return `<footer class="show-forays">
    <h3 class="show-forays-h">Used in the following forays</h3>
    <p class="show-forays-note">Not part of ${esc(show.title)}'s own catalogue — each of these forays plays a moment from one of its episodes.</p>
    ${forays.map(f => `<a class="show-forays-row" href="#${esc(forayRoutePath(f.id))}">
      <span class="show-forays-title">${esc(f.title)}</span>${f.status === "published" ? "" : `<span class="show-forays-draft">draft</span>`}
    </a>`).join("")}
  </footer>`;
}

/* S-06 (kanban t_be4c1793): renders the count label honestly for however
   much of the full-catalogue list this render has actually loaded so far.
   `fullyLoaded` (closure var in renderShow, passed in) must be the ONLY
   thing that flips this to a bare, unqualified total — a page that still
   carries a next_cursor is, by definition, not the whole show, and this
   function is the one place that rule is enforced so no call site can
   accidentally claim otherwise.

   FOUNDER CALL 2026-09-13 — the partial-load branch renders NOTHING.
   It used to read "100+ episodes loaded so far — more available", and
   Wyatt's verdict was "delete that, it's useless info". He is right twice
   over now: it was always a hedge nobody asked for, and since the "Show
   more episodes" control came out in this same change there is no longer
   any way for a listener to act on "more available" — it would be a
   subtitle advertising a door that no longer exists.

   What does NOT collapse with it:
     - the `fullyLoaded` branch, which states a TRUE total and is the only
       branch allowed to. Falling back to that shape for a partial load
       (a bare "100 episodes") is exactly the false-completeness claim the
       honesty rule forbids, so the partial case says nothing at all
       rather than saying something wrong;
     - the stale note, promoted here to a standalone sentence. "Couldn't
       refresh" is a failure the listener can act on (come back on a
       better connection); silence about it would be a
       different lie from the one we just deleted. */
function showEpisodeCountLabel({ loadedCount, fullyLoaded, curatedCount, isBreadthTier, stale, loadError, loadState }) {
  /* THE LOADING BRANCH MOVED IN HERE (issue #687). It used to be written by
     hand, inline, into renderShow's initial `innerHTML` — a second author for
     this one label, with its own phrasing, that the fetch's terminal paths
     never revisited. That is the same two-writers-one-state defect this issue
     is about, on the subtitle instead of the body, and leaving it in place
     while fixing the body would have been fixing one half of a matched pair.
     Now the initial render calls this function with `loadState: "loading"`
     and there is exactly one place the subtitle is ever composed.

     The count is still stated while loading when we have one: those curated
     episodes are on screen and playable right now, so naming them is a fact,
     not a hedge. What is gone with the inline version is the breadth-tier
     branch's "4a's wider catalogue — loading full episode list…", which
     explained our catalogue's internal tiering to a listener who has no idea
     what a tier is (founder's standing instruction: don't blame it on 4a). */
  if (loadState === "loading") {
    /* ALWAYS the plain placeholder while loading — the curated count is no
       longer stated here, and this is a correction to my own 2026-09-21 change.

       The old branch named the curated count on the reasoning, written in the
       comment above, that "those curated episodes are on screen and playable
       right now, so naming them is a fact, not a hedge". That premise was TRUE
       until the same day's other edit stopped painting curated rows while
       loading (paintBody, below) — after which the subtitle asserted a count of
       episodes the body underneath was not showing. A listener saw
       "33 episodes · loading the rest…" over "Loading episodes…" and zero rows.

       That is precisely the subtitle/body contradiction issue #687 exists to
       remove, reintroduced by a body-only fix that left its own justification
       standing 550 lines away. A count and the rows it labels must come from
       the same state.

       ONE SENTENCE PER OUTCOME (audit round 2, states-8). While the BODY carries
       a status — "Loading episodes…", "Couldn't load these episodes.", "No
       episodes yet." — this label is EMPTY. It used to say the same thing a
       second time in its own words, 200 px above the body's: two regions that
       agreed on the state and still read as a page repeating itself. The
       subtitle speaks only where rows are on screen: a count for a loaded list,
       and the catalogue count over the curated rows, whose failure line now
       lives under those rows beside its Try again (paintBody). */
    return "";
  }
  if (loadedCount === 0) {
    return curatedCount
      ? `${curatedCount} episode${curatedCount === 1 ? "" : "s"} in 4a's catalogue`
      : "";
  }
  const staleNote = stale ? " (showing the last saved list — couldn't refresh just now)" : "";
  if (fullyLoaded) {
    return `${loadedCount} episode${loadedCount === 1 ? "" : "s"}${staleNote}`;
  }
  // Partial load: no count, because any count we could state here would
  // either hedge uselessly or claim a completeness we do not have.
  return stale ? "Showing the last saved list — couldn't refresh just now." : "";
}

/* S-06: local-filter search over whatever full-catalogue pages have been
   loaded into this render so far. This is the FALLBACK path only — S-07
   (kanban t_6baccaa0, api/episodes/search.ts) shipped a real show-scoped
   full-catalogue search endpoint, which searchShowEpisodesScoped() below
   asks first; this function only runs when that call fails/degrades, so
   the search box still works (against whatever pages happen to be in
   memory) rather than going dark. Matches against title + description
   text of the raw API episode records already held in `loaded`,
   case-insensitive substring, same idiom searchShows() uses for names. */
function filterLoadedEpisodes(loadedRaw, query) {
  const q = query.trim().toLowerCase();
  if (!q) return loadedRaw;
  return loadedRaw.filter((ep) => {
    const title = String(ep.title || "").toLowerCase();
    const desc = String(ep.description_text || "").toLowerCase();
    return title.includes(q) || desc.includes(q);
  });
}

/* S-06: asks S-07's show-scoped episode-search endpoint
   (GET /api/episodes/search?show=<id>&q=<query>), which fetches the show's
   OWN live feed server-side and filters the FULL episode list — not just
   whatever pages this render happens to have loaded via fetchShowEpisodes.
   This is the real, full-catalogue search the card asks for; the local
   `filterLoadedEpisodes` fallback above only runs when this call itself
   fails or comes back `degraded` (rate limit, feed fetch error, endpoint
   unreachable), so the box degrades to "searching loaded episodes" rather
   than going silent. Returns `{ episodes: null }` on any failure/degrade —
   callers branch on that exactly like fetchShowEpisodes' null convention. */
async function searchShowEpisodesScoped(show_id, query) {
  const data = await fetchApiJson(`api/episodes/search?show=${encodeURIComponent(show_id)}&q=${encodeURIComponent(query)}&limit=25`);
  if (!data || data.degraded || !Array.isArray(data.episodes)) return { episodes: null };
  return { episodes: data.episodes };
}

/* S-06(b) / #560 item 7 / requirements §6.8: a breadth show page that survives
   a reload.

   THE BUG, stated exactly. `showById` resolves `state.catalog` (the curated
   220) and then `state.breadthShowCache`, which is IN-MEMORY and populated
   only by a search response THIS SESSION. So `#/show/1234567890` rendered
   "Show not found." on a cold open, a shared link, a reload, or a restored
   tab — every way of reaching a breadth show that is not "I just searched for
   it", which is every way a link is actually used.

   WHICH PATH ANSWERS, AND WHY — the card asks for this to be argued rather
   than assumed:

     1. THE LOADED INDEX, if it is already in memory. Free, no network. It is
        in memory exactly when the listener searched before tapping, which is
        the common in-session case.
     2. OTHERWISE THE ENDPOINT, one row over the wire. NOT the index: fetching
        436 KB and paying a ~50 ms decode to render one show page would be a
        worse trade than one ~200 ms round trip for one row, and a cold open of
        a shared link is precisely when the index is not loaded. So this never
        triggers an index fetch.

   A genuine miss — the endpoint answers with `show: null` — still renders
   "Show not found." That is a real state, not an error, and the endpoint
   returns 200 for it deliberately so the client can tell it apart from a dead
   endpoint (which `fetchApiJson` also reports as `null`).

   RE-ENTRY IS BOUNDED: the seed goes into `state.breadthShowCache` first, so
   the `renderShow` call below takes the resolving branch and cannot come back
   here. If the seed somehow did not take, the guard is that we only re-render
   when `showById` now answers. */
/** `#/show/<id>` or `#/show/<id>/q/<query>`, parsed once, both halves DECODED
    (safeDecode). The `/q/` half is the show page's own episode search, kept in
    the address so ‹ back from an episode, a reload or a shared link comes back
    to the search rather than the bare list (audit 2026-09-22). An id never
    carries a raw `/`: every producer encodes it. */
function parseShowRoute(hash = currentHash()) {
  const m = /^#\/show\/([^/]+)(?:\/q\/(.*))?$/.exec(hash);
  if (!m) return null;
  return { id: safeDecode(m[1]), query: m[2] === undefined ? "" : safeDecode(m[2]) };
}

function showRouteHash(show_id, query = "") {
  return `#${showRoutePath(show_id, query)}`;
}

/** The same route without its `#`, for an href template (`href="#${…}"`): the
    app-security census reads an href that OPENS with an interpolation as an
    outside URL owed to safeUrl, and an in-app route is not one (the way
    playlistRoute is written into `href="#/${…}"`). */
function showRoutePath(show_id, query = "") {
  const q = String(query || "").trim();
  return `/show/${encodeURIComponent(show_id)}${q ? "/q/" + encodeURIComponent(q) : ""}`;
}

/** `#/foray/<id>`, encoded (audit round 3, app-2-13) — the one producer of a
    Foray route, as showRouteHash is of a show's and playlistRoute of a
    playlist's. The router decodes the segment (forayRouteId), so an id carrying
    `/`, `#`, `?` or `%` broke routing from every surface that only HTML-escaped. */
function forayRouteHash(id) {
  return `#${forayRoutePath(id)}`;
}

/** Without its `#`, for an href template (see showRoutePath). */
function forayRoutePath(id) {
  return `/foray/${encodeURIComponent(id)}`;
}

/** Whether the page on screen is `show_id`'s — compared DECODED: the hash
    carries the encoded id, and comparing it with the raw one never matched an
    id that needed encoding. */
function onShowRoute(show_id) {
  const r = parseShowRoute();
  return !!r && r.id === show_id;
}

function resolveMissingShow(show_id) {
  const view = $("#view");
  /* S-05: a `pi:` id has no fallback lookup at all — see showById's own
     header for why `api/shows/search?id=` (a different id space) can never
     answer one, and why that is correct today rather than a gap: no
     shard-index release is published yet. Rendering the honest empty state
     immediately, with no "Loading show…" flash for a fetch that would
     never have resolved this id anyway. */
  if (typeof show_id === "string" && show_id.startsWith("pi:")) {
    if (view) view.innerHTML = statusPageHtml({ title: "Show", note: "Show not found. Search for it again to open it.", back: "#/shows" });
    return;
  }
  const fromIndex = showIndex
    ? showIndex.rows.find((r) => r.show_id === show_id)
    : null;
  if (fromIndex) {
    state.breadthShowCache[show_id] = {
      show_id: fromIndex.show_id, title: fromIndex.title, artwork_url: null,
      editorial_note: null, taxonomy_node_ids: [], tier: fromIndex.tier,
    };
    renderShow(show_id, parseShowRoute()?.query || "");
    return;
  }

  /* Every state here carries a page head with ‹ (audit 2026-09-22). These three
     pages are reached almost only through stale or shared links, which is
     exactly when there is nothing else on screen to leave by.

     AND A DEAD ENDPOINT IS NOT A MISSING SHOW. The endpoint answers a genuine
     miss with 200 and `show: null` precisely so the client can tell it from a
     failure, which `fetchApiJson` reports as `null` — and this branch used to
     throw that distinction away and say "Show not found." for both. A show we
     could not ask about now says so, with "Try again" wired to this same
     lookup. */
  if (view) view.innerHTML = statusPageHtml({ title: "Show", note: "Loading show…", back: "#/shows" });
  const isCurrentRender = renderToken();
  fetchApiJson(`api/shows/search?id=${encodeURIComponent(show_id)}`).then((data) => {
    /* Navigated away while the row was in flight — repainting #view now would
       clobber whatever page the listener is actually on. The same render-token
       rule renderShow's own episode fetch follows, plus the route itself for a
       caller that renders a show outside the router. (The route check compared
       the raw hash with the DECODED id, so an id that needed encoding never
       matched and the page stayed on "Loading show…"; onShowRoute decodes.) */
    if (!isCurrentRender() || !onShowRoute(show_id)) return;
    const v = $("#view");
    if (data === null) {
      if (v) {
        v.innerHTML = statusPageHtml({ title: "Show", note: "Couldn't load this show.", back: "#/shows", retry: true });
        bindRetry(v, () => resolveMissingShow(show_id));
      }
      return;
    }
    const row = data?.show || null;
    if (!row) {
      if (v) v.innerHTML = statusPageHtml({ title: "Show", note: "Show not found.", back: "#/shows" });
      return;
    }
    state.breadthShowCache[show_id] = row;
    if (showById(show_id)) renderShow(show_id, parseShowRoute()?.query || "");
  }); // fetchApiJson swallows network/parse errors to null — the `data === null` branch above is that case
}

function renderShow(show_id, initialQuery = "") {
  setBodyClass("view-page");
  const show = showById(show_id);
  if (!show) { resolveMissingShow(show_id); return; }
  rememberShardShow(show);
  fullPool(); // populate itemIndex/poolIds so curated-pool episode rows can play in-app
  const curatedEps = episodesForShow(show);
  const ctx = "show-" + show.show_id;
  const chips = (show.taxonomy_node_ids || []).map(taxonomyChip).join("");
  /* A3.1/Q3: a breadth-tier show (found via the full-catalogue search
     endpoint, never curated) has zero discover-pool episodes by construction
     — discover.json only ever holds the curated 220's hand-picked episodes.
     That is not the same as "this show genuinely has none" (the curated-tier
     empty state below), so it gets its own honest, non-alarming copy instead
     of implying the show is empty. Stage 3b's async fetch below (kanban
     t_567b570f) supersedes this once it resolves; until then this stays the
     safe degrade for the curated-pool-only render. */
  const isBreadthTier = show.tier === "breadth";
  const showArt = showArtworkUrl(show);

  const head = `
    <div class="page-head">
      <a class="back" href="#/">‹</a>
      <div>
        <h2>${esc(show.title)}${explicitBadge(show.explicit)}</h2>
        <!-- EMPTY. paintCount() fills it on the very next statement after
             this template is installed, and is the only thing that ever
             writes it — see paintEpisodeOutcome. An initial value composed
             here would be a second author for one label (issue #687). -->
        <p class="sub" data-show-count></p>
      </div>
    </div>
    <!-- ONE HERO: art, Follow and its note are one centred block (styles.css
         .show-hero, visual pass 1). The title stays in the page head. -->
    <div class="show-hero">
      ${showArt ? `<img class="show-art" src="${esc(safeUrl(showArt))}" alt="">` : ""}
      ${showStarBtn(show.show_id)}
      <p class="note show-follow-note">${esc(FOLLOW_NOTE)}</p>
    </div>
    <!-- The publisher's own description. EMPTY at first paint and filled by
         paintShowDescription() when the episode fetch resolves (or instantly
         from the cache on a revisit) - it comes from the feed, which this page
         does not have yet when the template is installed. One writer, the same
         rule the count label above follows.
         NO BACKTICKS IN THIS COMMENT: it sits inside a template literal, so one
         would end the string. Caught by node --check. -->
    <div data-show-description hidden></div>
    <!-- NO EDITORIAL NOTE HERE. Founder, 2026-09-21: "Delete the 'why it's in
         4a' field from anything the user can read."

         It briefly sat under the publisher's description, labelled as ours. The
         label was not the problem: a second blurb about the same show is noise
         whoever it is attributed to, and the publisher's own words are the ones
         that belong on a show page.

         editorial_note STAYS IN THE DATA and is still load-bearing -- it is what
         showsWeVouchFor filters on to pick the "Shows we vouch for" rail. That is
         curation deciding what to surface, which is not the same thing as showing
         a listener our copy. Nothing renders its text any more, and
         test/show-description-source.test.js pins that.

         NO BACKTICKS IN THIS COMMENT: it sits inside a template literal, so one
         would end the string. Caught by node --check, twice now. -->
    ${chips ? `<div class="fy-chips">${chips}</div>` : ""}`;

  /* S-06: the search box is a real requirement from Wyatt's original ask,
     not a nice-to-have — but it searches full-catalogue episode data, so it
     stays hidden until at least one full-catalogue page has loaded (curated-
     pool-only episodes are already all on-screen with nothing to search
     for). bindShowEpisodeSearch() below reveals it the moment page 1 lands. */
  const searchBox = `
    <div class="show-ep-search" data-show-ep-search hidden>
      <form data-show-ep-search-form role="search" autocomplete="off">
        <input data-show-ep-search-input type="text" maxlength="120" placeholder="Search this show's episodes…" aria-label="Search this show's episodes" ${SEARCH_INPUT_ATTRS}>
      </form>
      <p class="note" data-show-ep-search-note role="status" aria-live="polite" hidden></p>
      <div data-show-ep-search-failed hidden></div>
    </div>`;

  /* THE EPISODE CONTAINER IS EMITTED EMPTY (issue #687, founder screenshot
     2026-09-14 showing "Couldn't load this show's episodes right now." and
     "Fetching this show's episodes… Check back soon." on screen at the same
     time).

     It used to be composed right here, inline, and that was the bug — not the
     wording. A body painted once, synchronously, before the fetch resolves,
     with no error branch and nothing that ever revisits it, is a CLAIM ABOUT
     THE FETCH made by something that will never learn how the fetch turned
     out. Two of the three terminal outcomes then called paintCount() alone,
     so the optimistic placeholder outlived a failure and an empty result and
     sat there contradicting the subtitle beside it, permanently.

     Everything this template used to decide is now decided by
     paintEpisodeOutcome() below, which is called on EVERY terminal path
     including this one (the "loading" outcome, on the line after the binds).
     The page is still never blank — the first paint happens synchronously in
     the same task, exactly as before — it just happens through the one writer
     instead of beside it. */
  $("#view").innerHTML = `<div class="page">${head}${searchBox}<div data-show-episodes></div>
  ${similarShowsSection(show)}
  <div data-show-forays>${showForaysHtml(show)}</div>
  </div>`;
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindShowStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));

  // ---- Pagination + in-page search state for this render only. A fresh
  // renderShow() call (new navigation) gets a fresh closure — nothing here
  // survives or leaks across shows. ----
  let loaded = [];          // raw API episode records, the page(s) fetched, in server order
  /* True only once a page comes back with next_cursor: null. Since the
     "Show more episodes" control was removed (2026-09-13) nothing here
     advances past page 1, so in practice this is "page 1 was the whole
     show" — still exactly the question showEpisodeCountLabel and
     paintSearchNote need answered, and still answered by the API rather
     than assumed. */
  let fullyLoaded = false;
  let anyStale = false;     // whether the list on screen came from a stale/degraded answer; the latest answer decides
  let lastLoadError = null;
  /* WHAT STATE THE EPISODE CONTAINER IS ACTUALLY IN (issue #687). Four
     values, one of which used to be invisible to the code entirely:

       "loading" — the fetch is in flight. Used to be a string painted once
                   into the initial innerHTML and then forgotten; it is a
                   STATE, and the only reason the bug existed is that nothing
                   modelled it as one, so nothing could leave it.
       "loaded"  — the fetch returned episodes. The only state in which the
                   search box, the scoped-search modes and paintList() mean
                   anything.
       "empty"   — the fetch succeeded and the show has no episodes.
       "failed"  — the fetch failed.

     This is the variable the container and the subtitle are BOTH derived
     from, which is the whole fix: they cannot contradict each other because
     there is no longer anything for them to disagree about. */
  let loadState = "loading";
  /* Seeded from the address (see parseShowRoute): a return to this page puts
     the listener back inside the search they left. */
  let searchQuery = String(initialQuery || "");
  /* S-06/S-07 wiring: `searchMode` tracks which result set the container is
     currently showing so paintSearchNote() can label it honestly.
       "idle"     — no query typed; showing the full `loaded` list.
       "loading"  — a scoped-search request is in flight for the current query.
       "scoped"   — S-07's endpoint answered for the CURRENT query (real,
                    full-catalogue search results — the honest, non-hedged case).
       "fallback" — S-07 failed/degraded for the current query; falling back
                    to filtering whatever pages are loaded, hedged per the
                    card's partial-list-honesty rule. */
  let searchMode = "idle";
  let scopedResults = [];   // populated only when searchMode === "scoped"
  let searchToken = 0;      // guards a slow/superseded scoped-search response
  let searchDebounceTimer = null;

  const container = () => $("#view [data-show-episodes]");
  const countLabelEl = () => $("#view [data-show-count]");
  const searchWrap = () => $("#view [data-show-ep-search]");
  const searchNote = () => $("#view [data-show-ep-search-note]");
  const searchFailed = () => $("#view [data-show-ep-search-failed]");
  /* IDENTITY, NOT PRESENCE: every show page has a `[data-show-episodes]`, so
     presence alone let show A's late fetch paint into show B (see renderToken). */
  const isCurrentRender = renderToken();
  const stillMounted = () => isCurrentRender() && !!container();

  function bindRows(c) {
    bindPickLogging(c);
    bindStars(c);
    bindUpNext(c);
    bindPlay(c);
  }

  /* The full-catalogue list, search-aware. PRIVATE to paintBody() now — it is
     what "loaded" looks like, not a thing a caller gets to choose. It was
     public-ish before, and the fact that exactly one of three outcomes
     remembered to call it is issue #687. */
  function paintList(c) {
    const visible = searchMode === "scoped" ? scopedResults : filterLoadedEpisodes(loaded, searchQuery);
    if (searchQuery.trim() && !visible.length && searchMode !== "loading") {
      c.innerHTML = `<p class="note">No episodes match ${quoteQuery(esc(searchQuery.trim()))}.</p>`;
      return;
    }
    /* Family Mode's one predicate here too (data-integrity-4): these rows carry
       no rating of their own, so the show's catalogue rating decides. */
    const rows = visible.map((ep) => fullCatalogueRowToEpRowItem(show, ep)).filter(familyAllows);
    if (!rows.length && visible.length) { c.innerHTML = `<p class="note">${esc(FAMILY_HIDES_NOTE)}</p>`; return; }
    c.innerHTML = rows.map((item, i) => epRow(item, i, ctx, -1)).join("");
    bindRows(c);
  }

  /* NO COPY THAT BLAMES 4a (founder's standing instruction, given twice;
     issue #687 repeats it). What was here read "Fetching this show's
     episodes — 4a is adding full episode lists for shows outside its curated
     picks. Check back soon." and "No episodes from this show are in 4a's
     catalogue right now." Both explain OUR catalogue's internal structure to
     a listener who came here for a podcast, and one of them was a promise
     ("check back soon") that nothing in the system actually keeps.

     The breadth-tier distinction went with them. It was never a difference
     the listener could see or act on — it is a fact about which of our two
     ingestion paths found the show — and encoding it in the empty state is
     how "4a's wider catalogue" ended up on a phone screen. `isBreadthTier`
     is still handed to showEpisodeCountLabel — a tier-specific subtitle would
     be composed there and nowhere else — but since the round-2 audit
     (states-8) no outcome's copy reads it: the "…yet." variant it used to pick
     went with the doubled empty-state sentence. */
  /* `failed` offers "Try again" rather than "Pull to refresh" (audit
     2026-09-22): there is no pull gesture on this page, and a failure the
     listener cannot act on from where they are standing is a dead end. The
     button re-runs `loadEpisodes` below — the same fetch — through
     `failedNoteHtml`, the convention every failed list now shares. */
  const BODY_PLACEHOLDER = {
    loading: "Loading episodes…",
    empty: "No episodes yet.",
    failed: "Couldn't load these episodes.",
    /* Under a curated show's rows when the FULL list failed (states-2): the rows
       on screen are real, so "these episodes" would be wrong; what is missing
       is the rest. */
    failedCurated: "Couldn't load the full list.",
  };

  /* THE ONE WRITER OF THE EPISODE CONTAINER (issue #687).

     Every path that changes what should be on screen goes through here, and
     it derives the answer from `loadState` rather than being told what to
     paint — so there is no call site that can paint the wrong thing, and no
     outcome that can forget to paint at all.

     THE CURATED ROWS BRANCH IS THE SUBTLE ONE, and getting it wrong would
     have traded one contradiction for another. A breadth show's full-list
     fetch failing is a real failure and the subtitle says so. But a CURATED
     show's fetch failing while its curated episodes are already on screen is
     not an empty screen — those rows are real, playable, and the best thing
     we have. Replacing them with "Couldn't load these episodes" would delete
     working content to display an error about content the listener cannot
     tell is missing. So: real rows whenever we have any, a placeholder only
     when we have none. The subtitle covers the difference honestly
     ("N episodes in 4a's catalogue (couldn't load the full list)"), which is
     what it is for. */
  function paintBody() {
    const c = container();
    if (!c) return;
    if (loadState === "loaded") { paintList(c); return; }
    /* WHILE LOADING, SHOW THE PLACEHOLDER — NOT the curated rows (founder,
       2026-09-21: "it first shows some old episodes that were already loaded,
       then all the latest episodes show up. That is bad ... it probably makes
       sense to just show no episodes for a second until all the most recent
       episodes show up").

       The curated rows are a handful of hand-picked episodes from the discover
       pool, often years old. Painting them first and replacing them a moment
       later is a visible jump that makes the page look wrong twice: once for
       showing stale episodes as if they were the list, and again for moving
       under the listener's thumb.

       THE ARGUMENT BELOW STILL HOLDS FOR `failed`, and is why this is a split
       rather than a deletion: when the fetch has FAILED those rows are the best
       thing we have, they are real and playable, and replacing them with
       "Couldn't load these episodes" would delete working content to display an
       error about content the listener cannot tell is missing. The difference is
       that `loading` is a state that RESOLVES — the stale rows buy a second of
       false content and then take it away — while `failed` is terminal. */
    if (loadState !== "loading" && curatedEps.length) {
      /* AND A WAY FORWARD UNDER THE ROWS (audit round 2, states-2). This branch
         returned before the `failed` branch below, so every one of the 220
         catalogue shows — the ones Home and Search link to — lost its Try again
         the moment its full-list fetch failed: the rows were real, the subtitle
         said "couldn't load the full list", and nothing on the page could run
         the fetch again. Theme G's rule ("failed — say it failed, and offer Try
         again wired to the SAME fetch") holds here too; the rows stay, the
         failure line and its button sit under them, and the subtitle keeps to
         the count (showEpisodeCountLabel: one sentence per outcome). */
      const rows = curatedEps.map((item, i) => epRow(item, i, ctx, -1)).join("");
      c.innerHTML = loadState === "failed" ? rows + failedNoteHtml(BODY_PLACEHOLDER.failedCurated) : rows;
      bindRows(c);
      if (loadState === "failed") bindRetry(c, retryEpisodes);
      return;
    }
    /* NOT esc()'d, and that is deliberate rather than an oversight: every
       value here is a literal from the frozen map three lines up, written in
       this file, containing no markup — the same footing as every other
       `<p class="note">…</p>` on this page (see resolveMissingShow). Running
       an HTML escaper over a constant you wrote yourself buys no safety and
       costs correctness: it turns the apostrophe in "Couldn't" into `&#39;`
       in the DOM, which is what the string looks like to anything reading
       textContent. */
    if (loadState === "failed") {
      c.innerHTML = failedNoteHtml(BODY_PLACEHOLDER.failed);
      bindRetry(c, retryEpisodes);
      return;
    }
    c.innerHTML = `<p class="note">${BODY_PLACEHOLDER[loadState] || BODY_PLACEHOLDER.loading}</p>`;
  }

  function paintCount() {
    const el = countLabelEl();
    if (!el) return;
    el.textContent = showEpisodeCountLabel({
      loadedCount: loaded.length,
      fullyLoaded,
      curatedCount: curatedEps.length,
      isBreadthTier,
      stale: anyStale,
      loadError: loaded.length === 0 ? lastLoadError : null,
      loadState,
    });
  }

  /* THE TERMINAL PATHS' ONLY ENTRY POINT. Taking the outcome as its argument
     and writing BOTH regions is the entire structural fix for issue #687: the
     body and the subtitle can no longer describe different outcomes, because
     no caller is able to update one without the other. Compare what it
     replaced — three `return`s, two of which called paintCount() alone. */
  function paintEpisodeOutcome(outcome) {
    loadState = outcome;
    paintBody();
    paintCount();
    /* A terminal paint is when the page has its real height: re-apply a
       back-step scroll restore that the "loading" paint clamped. */
    if (outcome !== "loading") pageDidPaint();
  }

  function paintSearchNote() {
    const note = searchNote();
    const failed = searchFailed();
    if (!note) return;
    const clearFailed = () => { if (failed) { failed.innerHTML = ""; failed.hidden = true; } };
    if (!searchQuery.trim()) { note.hidden = true; clearFailed(); return; }
    note.hidden = false;
    clearFailed();
    if (searchMode === "loading") {
      note.textContent = "Searching…";
      return;
    }
    if (searchMode === "scoped") {
      // The honest, non-hedged case: S-07 searched the show's FULL episode
      // list server-side, not just whatever this render has paged in.
      note.textContent = `${countLabel(scopedResults.length, "episode")} found.`;
      return;
    }
    // "fallback": S-07 failed or degraded for this query. Partial-list
    // honesty rule (card acceptance criterion): a search box that quietly
    // filtered only what happened to be in memory would read as "no
    // results" for an episode on a page that hasn't loaded yet — label the
    // scope explicitly rather than imply this searched the whole show.
    const matchCount = filterLoadedEpisodes(loaded, searchQuery).length;
    if (fullyLoaded) {
      note.textContent = `${countLabel(matchCount, "match", "matches")} in ${countLabel(loaded.length, "episode")}.`;
      return;
    }
    /* A FAILED SEARCH IS PAINTED AS ONE (audit round 2, states-10). This read
       "(N of the full list loaded so far)" — copy from the pagination era,
       when "Show more episodes" could grow `loaded`; that control was removed
       on 2026-09-13 and nothing advances past page 1, so "so far" promised a
       load that will never come. It says what was searched and why, in the
       page's own failed-state shape, with Try again wired to the same
       `runSearch` that failed. */
    note.hidden = true;
    if (!failed) return;
    failed.innerHTML = failedNoteHtml(`${matchCount} match${matchCount === 1 ? "" : "es"} — searching the ${loaded.length} loaded episodes only; the connection didn't answer for the rest.`);
    failed.hidden = false;
    bindRetry(failed, runSearch);
  }

  /* REMOVED 2026-09-13: paintMoreButton() / loadNextPage(), the "Show more
     episodes" control. Founder report: "there is a 'Show more episodes'
     button which tries to do something but fails."

     WHY IT FAILED — the defect, stated exactly, because the same shape can
     recur anywhere a paginated list grows underneath a filtered view.

     The control's visibility was decided by `fullyLoaded || !nextCursor`
     ALONE. That is a fact about the PAGINATION, and it was used to decide
     the chrome for a container that, while a search is running, is not
     showing the paginated list at all. Once S-07's scoped search answered,
     `searchMode === "scoped"` and paintList() rendered `scopedResults` — a
     server-side search over the show's FULL catalogue, a result set that
     has nothing to do with `loaded` and grows not at all when another page
     of `loaded` arrives. The button kept rendering anyway, because the
     cursor was still non-null.

     So pressing it ran the whole of loadNextPage honestly and to
     completion: disable, "Loading…", fetch page 2 with the right cursor,
     append to `loaded`, repaint. And the repaint painted `scopedResults`,
     which were byte-for-byte what was already on screen. The button
     flickered and the list did not move. Nothing errored; nothing was
     logged; the work was real and the outcome was invisible. That is what
     "tries to do something but fails" looks like from the outside.

     Two things worth carrying forward rather than forgetting with the
     button: (1) the same click DID work in "idle" and "fallback" mode, so
     this was a mode-dependent no-op, the kind a happy-path test never
     sees — test/show-page-pagination.test.js had five passing tests over
     this control and not one of them typed in the search box; (2) the
     pagination underneath is NOT the broken part and is untouched —
     api/shows/:id/episodes still keysets, and fetchShowEpisodes still
     takes and returns a cursor. What is gone is only this page's UI for
     walking it. Reaching older episodes is now the search box's job,
     which is the one path that actually searches the whole catalogue. */

  function revealSearchIfEligible() {
    const wrap = searchWrap();
    if (wrap && loaded.length) wrap.hidden = false;
    /* A search carried in the address runs once there is something to search:
       the field is only shown, and the scoped endpoint only meaningful, once a
       page of episodes is in. */
    if (loaded.length && searchQuery.trim() && !restoredSearchRan) {
      restoredSearchRan = true;
      const input = $("#view [data-show-ep-search-input]");
      if (input) input.value = searchQuery;
      runSearch();
    }
  }
  let restoredSearchRan = false;

  /* Debounced (250ms) so a fast typist doesn't fire a request per
     keystroke — S-07's endpoint does a live feed fetch server-side on a
     cache miss, so this isn't free. `searchToken` guards a slow response
     from a superseded query clobbering a newer one's results, same pattern
     showSearchToken uses for the Shows-page search above. */
  function runSearch() {
    /* NOT ON A PAGE THE LISTENER HAS LEFT (review 2026-09-23). The debounce
       timer outlives a navigation, and the rewrite below would stamp this
       show's address onto the entry of whatever page they moved to — Home on
       screen, `#/show/<id>/q/ai` in the address, and a reload opening the
       show. Checked first, before anything writes. */
    if (!isCurrentRender()) return;
    const query = searchQuery;
    /* The address follows the search, in place — no history entry per
       keystroke, and ‹ still leaves the page in one step. */
    rewriteRouteInPlace(showRouteHash(show.show_id, query));
    if (!query.trim()) {
      searchMode = "idle";
      paintBody();
      paintSearchNote();
      return;
    }
    searchMode = "loading";
    paintSearchNote();
    const myToken = ++searchToken;
    searchShowEpisodesScoped(show.show_id, query).then(({ episodes }) => {
      if (myToken !== searchToken) return; // superseded by a newer query
      if (!stillMounted()) return; // navigated away
      if (episodes !== null) {
        searchMode = "scoped";
        scopedResults = episodes;
      } else {
        searchMode = "fallback";
        scopedResults = [];
      }
      /* Through paintBody(), not paintList(), even though `loadState` is
         necessarily "loaded" here (the search box only reveals once episodes
         land). One writer means one writer — a second entry point into the
         container is how the first one grew a hole. */
      paintBody();
      paintSearchNote();
    });
  }

  function onSearchInputChange() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(runSearch, 250);
  }

  const searchForm = $("#view [data-show-ep-search-form]");
  const searchInput = $("#view [data-show-ep-search-input]");
  if (searchForm && searchInput) {
    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      searchQuery = searchInput.value || "";
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      runSearch(); // Enter/submit runs immediately, no debounce wait
    });
    // Live-filter as the user types — debounced (see runSearch's header).
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value || "";
      onSearchInputChange();
    });
  }

  /* THE FIRST PAINT, and it is a terminal path like any other — the terminal
     path of "nothing has happened yet". Synchronous, in the same task as the
     innerHTML above it, so the page is on screen with its curated rows before
     a frame is drawn, exactly as when this was baked into the template.
     Placed immediately before the fetch that will supersede it, so the four
     outcomes of one load read as four calls to one function. */
  /* A CACHED FIRST PAGE PAINTS NOW (founder, 2026-09-18 — Lex's list taking
     many seconds on every visit). "loading" is still the terminal path when
     there is nothing cached; when there is, the list is on screen in this same
     task and the fetch below becomes a background refresh. */
  const cached = cachedShowEpisodes(show.show_id);
  if (cached && cached.episodes.length) {
    /* NOT `anyStale = cached.stale` (audit 2026-09-22). The cache entry's flag
       is a true fact about the response that was STORED, but the subtitle words
       it as a present-tense failure — "couldn't refresh just now" — and at this
       line no refresh has been attempted: the one that will decide it is the
       fetch directly below. So the first paint claims nothing about freshness,
       and the refresh's own answer (a failure, or its own `stale`) is what sets
       the flag, in either direction. */
    loaded = cached.episodes;
    fullyLoaded = cached.nextCursor === null;
    paintEpisodeOutcome("loaded");
    paintShowDescription(cached.show);
    revealSearchIfEligible();
  } else {
    paintEpisodeOutcome("loading");
  }

  /* THE ONE FETCH, named so "Try again" can run it again (audit 2026-09-22,
     theme G). A retry that was a separate "reload" path would be a second
     author for the same outcome — the shape issue #687 removed from this page. */
  function loadEpisodes() {
    fetchShowEpisodes(show.show_id).then(({ episodes, nextCursor: nc, stale, error, show: header }) => {
      if (!stillMounted()) return; // navigated away before the fetch resolved

      /* THE DESCRIPTION FIRST, BEFORE ANY OUTCOME BRANCH (audit 2026-09-22). It
         used to be painted on the success path only, so a show whose feed parsed
         but held no episodes — the emptiest page in the app — withheld the one
         paragraph the response did carry. "A description is not part of the
         list" was already this function's rule; it now holds on every branch,
         including the unchanged-list return below. A failure carries no header,
         and then the slot is left exactly as it was. */
      if (header) paintShowDescription(header);

      if (episodes === null) {
        /* A FAILED REFRESH BEHIND A GOOD CACHED LIST CHANGES NOTHING IN THE LIST.
           Replacing a list the listener is already reading with "couldn't load"
           because the revalidation missed would be a regression introduced by
           the cache — the episodes are right there and still valid. The error is
           only terminal when there is nothing painted.

           But it IS now a refresh that failed, which is exactly what the
           subtitle's "couldn't refresh just now" says — so that sentence is
           painted here, at the moment it becomes true, rather than at first
           paint from a flag some earlier visit stored. */
        if (cached && cached.episodes.length) {
          anyStale = true;
          paintCount();
          return;
        }
        lastLoadError = error || "load failed";
        paintEpisodeOutcome("failed");
        return;
      }

      if (episodes.length === 0) {
        if (cached && cached.episodes.length) return; // same reasoning as above
        paintEpisodeOutcome("empty");
        return;
      }

      cacheShowEpisodes(show.show_id, { episodes, nextCursor: nc, stale: !!stale, show: header });

      /* FRESHNESS FROM THIS ANSWER, BEFORE THE UNCHANGED-LIST RETURN (audit
         2026-09-22). `anyStale` used to be sticky and set only below that
         return, so a refresh that SUCCEEDED with the same list left "couldn't
         refresh just now" standing for the rest of the visit — while the cache
         entry had just been rewritten `stale: false` one line up. Whether the
         list changed and whether it is fresh are two questions; the early
         return answers only the first, so the count repaints even when the
         rows do not. */
      anyStale = !!stale;
      paintCount();

      /* REPAINT ONLY ON A REAL CHANGE. The common case is that the refresh
         agrees with what is already on screen, and repainting then would throw
         away the listener's scroll position and any "load more" pages they had
         already pulled in — turning a silent background refresh into a visible
         jump. The subtitle is not the list, and was repainted just above. */
      if (cached && sameEpisodeList(cached.episodes, episodes)) return;

      loaded = episodes;
      fullyLoaded = nc === null;
      paintEpisodeOutcome("loaded");
      revealSearchIfEligible();
    });
  }

  /* "Try again" on the failed body: back to `loading` through the one writer,
     then the same fetch. `lastLoadError` is cleared first so the subtitle does
     not go on saying "couldn't" over a second attempt that is in flight. */
  function retryEpisodes() {
    lastLoadError = null;
    paintEpisodeOutcome("loading");
    loadEpisodes();
  }

  loadEpisodes();
}

/**
 * Fill the show page's description slot from the PUBLISHER'S feed.
 *
 * FOUNDER, 2026-09-21: "the show description looks like it's something we
 * generated. Is there a field from the show's host that we can pull instead?"
 *
 * It did, and there is. What the page showed was `editorial_note` — 220 lines of
 * our own curatorial copy in `data/catalog.json`, one per curated show ("the
 * widest bench in fusion/fission podcasting"). Good writing, but it is not the
 * show's description and it reads as ours because it IS ours. It now sits below
 * this, labelled as ours.
 *
 * The publisher's own text needed no new plumbing at all: it is parsed from the
 * feed's channel-level description by `backend/src/feeds/parser.ts`, returned by
 * `api/shows/:id/episodes` in its `show` header, and was being discarded by
 * `fetchShowEpisodes`, which kept only the episode list.
 *
 * TWO REASONS THIS IS A STRICT IMPROVEMENT, not a swap:
 *   - Every show gets one. `editorial_note` exists for the 220 curated shows
 *     only; the ~19,900 breadth shows had no description at all.
 *   - It is the publisher's, so it is right by construction and stays right
 *     when they rewrite it.
 *
 * ESCAPED, not rendered as HTML. This is third-party text from an arbitrary
 * feed. The episode page's linkifier could be pointed at it later, but that is
 * a deliberate second step with its own tests, not something to inherit by
 * accident.
 */
function paintShowDescription(header) {
  const el = $("#view [data-show-description]");
  if (!el) return;
  const text = header && typeof header.description === "string" ? header.description.trim() : "";
  if (!text) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = `<p class="show-description">${esc(text)}</p>`;
  el.hidden = false;
}

/** Do two fetched pages hold the same episodes, in the same order? Identity
    only — a description edit upstream is not a reason to yank the list out from
    under someone who is reading it.
    BY GUID, NOT `id` (audit round 3, app-1-3): endpoint rows carry `guid` and no
    `id`, so comparing `id` was `undefined !== undefined` on every row and any
    two pages of the same length (every 100-row first page) read as unchanged —
    a new episode at the top never repainted. */
function sameEpisodeList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (showEpisodeGuid(a[i]) !== showEpisodeGuid(b[i])) return false;
  return true;
}

function touchPlaylistPlayed(id) {
  const all = playlists();
  const p = all.find(x => x.id === id);
  if (p) { p.last_played_at = new Date().toISOString(); savePlaylists(all); }
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
  if (!savePlaylists([playlist, ...playlists()])) {
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
}

/* ---------- views ---------- */

/* `currentContinue()` / `bannerHtml()` — the v1 Continue banner — lived here
   until visual pass 1 (2026-09-23). They had no caller since the U-11 cutover
   (renderHome always renders Home v2, whose "Jump back in" reads the player's
   position store), and the only thing keeping them alive was two tests that
   called the function directly. Dead markup guarded by tests reads as
   coverage and is not; both went, with their CSS (`.banner`, `#banner-slot`). */

/* What actually connects the episodes in a subject queue is one fact: they
   share a taxonomy branch. Say that plainly via the real shows involved,
   rather than implying a curatorial narrative ("the fusion reactor tour")
   the grouping doesn't actually have. */
function subjectBlurb(slot) {
  const shows = [...new Set(slot.items.map(it => it.show))];
  if (shows.length === 1) return `All from ${shows[0]}.`;
  if (shows.length === 2) return `From ${shows[0]} and ${shows[1]}.`;
  return `From ${shows[0]}, ${shows[1]}, and ${shows.length - 2} more.`;
}

/* "Starts with …" LEADS the hook, and closes its own sentence only when the
   title has not already. Two defects, one line (audit 2026-09-22, qa rows 136 and
   148): the full stop was appended unconditionally, so 210 of the pool's 2,167
   titles read `Starts with "…Save The World?."`; and the clause came AFTER the
   blurb, so on a short screen — where styles.css clamps the hook to one line —
   the episode title, the one concrete thing the card says, was the part cut. */
function startsWithLine(title) {
  const t = String(title || "").trim();
  return `Starts with ${quoteQuery(esc(t) + (/[.?!…]$/.test(t) ? "" : "."))}`;
}

/** Why a Stretch card is there, as a sentence the listener can read on a phone
    (audit round 2, a11y-11 — it was a tooltip). Uppercase "Outside" on purpose:
    the returning-listener popup's own sentence is the lowercase one, and
    test/listener-copy.test.js finds that one by its case. */
const STRETCH_WHY = "Outside your usual subjects, on purpose.";

function miniCard(slot) {
  const item = slot.item;
  /* ONE POPULATION FOR THE COUNT AND THE DURATION (audit 2026-09-22). `|| 0`
     summed only the episodes whose length is known and printed that beside a
     count of all of them — "3 episodes · 1h 20m" when one of the three had no
     `duration_min` (8 such items ship in data/discover.json). A total is stated
     only when it is a total; otherwise the line keeps the count alone. */
  const allTimed = slot.items.length > 0 && slot.items.every(it => episodeMinutes(it) > 0);
  const totalMin = allTimed ? slot.items.reduce((s, it) => s + episodeMinutes(it), 0) : 0;
  /* The tag is the word; the reason is visible text in the hook (below), not a
     `title=` tooltip a phone never shows (audit round 2, a11y-11). */
  const stretch = slot.role === "stretch";
  const stretchTag = stretch ? `<span class="mc-stretch">Stretch</span>` : "";
  /* A CARD WITH A STRETCHED LINK (audit 2026-09-22, qa row 78). The card used
     to be the <a>, with the star <button> nested inside it — invalid HTML that a
     screen reader read as one link named "Education … Save", and whose star
     only avoided following the link through bindStars' preventDefault. The
     subject title is now the one real <a>; styles.css stretches its ::after
     over the card, and the star is a sibling lifted above it. */
  return `<div class="mini-card" data-branch="${esc(slot.branch)}">
    ${item.artwork_url ? `<img src="${esc(safeUrl(artUrl(item.artwork_url, CARD_ART_PX)))}" alt="" loading="lazy" decoding="async" width="56" height="56">` : `<div class="art-ph"></div>`}
    <div class="mc-info">
      <p class="mc-kicker">${stretchTag}${joinMeta(countLabel(slot.items.length, "episode"), fmtDur(totalMin))}</p>
      <h3><a class="mc-link" href="#/${esc(playlistRoute({ isSubject: true, branch: slot.branch }))}">${esc(subjectLabel(slot.branch))}</a></h3>
      <p class="mc-hook">${startsWithLine(item.title)} ${esc(subjectBlurb(slot))}${stretch ? ` ${STRETCH_WHY}` : ""}</p>
    </div>
    ${starBtn(item.id)}
  </div>`;
}

/* WHAT A FORAY IS, in one sentence, written ONCE (audit 2026-09-22, persona
   #18/#37/#45/#83). It was a literal inside the first-run sheet below — the only
   place in the product that said it — and that sheet is one-shot: "Skip for now"
   sets `cp_intro_dismissed` and nothing ever re-opens it. So the sentence is
   hoisted here and the Forays page subtitle reads it too, which gives the
   explanation a permanent home and makes skipping the sheet cost nothing. One
   constant, so the page and the sheet cannot drift into two descriptions.
   WORDED FROM THE MECHANISM (review 2026-09-23). It said we "clip" podcasts and
   "stitch them into one seamless listen", which docs/DECISIONS.md's 2026-08-11
   playback ruling rejects by name — it reads as the Stitcher/Luminary
   behaviour: "Copy must follow the mechanism: no user-facing language implying
   we produce a new audio file." A foray plays each moment from the show's own
   feed, in turn. test/listener-copy.test.js now fails on the old verbs.

   ONLY WHAT THE LISTED FORAYS DO (audit round 2, p-first-11 / p-foray-11). It
   promised "the best moment of each episode ... with a narrator between them"
   directly above the one Foray a newcomer can play, which has no narration and
   plays four moments from one episode. So it says "moments", and the narrator
   clause appears only while a Foray this listener can see actually carries
   narration. A function, not a constant, for that one clause; still ONE
   sentence for the Forays page and the first-run sheet. */
function forayAbout() {
  const narrated = forayCards().some(f => Array.isArray(f?.items) && f.items.some(i => i?.type === "narration"));
  return `One subject, heard across several podcasts: moments from their episodes, played in turn from each show's own feed${narrated ? ", with a narrator between them" : ""}.`;
}

/* First-time explanation/consent screen (docs/ux/foray-m3-prototype.html +
   docs/ux/README.md § "First-time vs. returning user"). Ports the INTENT of
   the prototype's `V.signinNew` screen into the shipped stack — not a literal
   port, same relationship PR #357's intro-popup fix already established.

   This is deliberately a SEPARATE gate from showIntroPopupOnce()'s
   cp_intro_dismissed flag. That flag alone is not a real "never used this
   app" signal — it also flips true the moment this screen (or the old popup)
   is dismissed, and a fresh device with a corrupted/partial localStorage
   write could have history but no dismissed flag. The real signal is the
   absence of any trace of prior use: no history, no saves, no playlists.
   `cp_intro_dismissed` is intentionally NOT part of this check — this screen
   must never reappear for an existing user just because that one flag is
   unset (see the test for exactly that case). */
function isGenuineFirstTimeUser() {
  return (
    pickedHistory().length === 0 &&
    Object.keys(savedMap()).length === 0 &&
    playlists().length === 0
  );
}

/* A PLAYING FORAY DEFERS ONBOARDING; IT DOES NOT RECLASSIFY THE LISTENER
   (audit round 2, p-first-5, and its review). A newcomer whose whole use of 4a
   was a shared Foray link met the Welcome sheet over their own playing Foray.
   The first fix counted the Foray's resume row as prior use — which sent the
   same newcomer to the RETURNING-user popup instead (still a modal over the
   Foray), and its "Got it" then wrote `cp_intro_dismissed`, so the Welcome and
   Preferences steps — the interest picks that re-deal Home — never showed on
   any later visit: the product's one viral path always skipped the survey.
   The listener is still first-time; the sheets simply wait while a Foray is
   sounding (or loading, or in its seam beat), and the next Home after it
   stops offers them. Read through the bridge; an absent or older module has
   no Foray to wait for. */
function forayHoldsOnboarding() {
  try {
    const s = window.ForayPlayer && typeof window.ForayPlayer.forayStatus === "function"
      ? window.ForayPlayer.forayStatus() : null;
    return Boolean(s && !s.ended && (s.running || s.playing || s.loading || s.gap));
  } catch (_) { return false; }
}

/** Home's onboarding: the first-run sheet for a genuine newcomer, else the
    returning-user popup — neither while a Foray is playing. */
let onboardingAfterSettle = false;
function offerHomeOnboarding() {
  /* NOT BEFORE THE STORE HAS ANSWERED (app-1-1): "genuine first-time user" is
     read from cp_history / cp_saved / cp_playlists, and before hydration a
     returning listener's are simply not in memory yet -- they were offered the
     first-run sheet. Offered again once it settles, if Home is still up. */
  if (storageWaiting()) {
    if (!onboardingAfterSettle) {
      onboardingAfterSettle = true;
      afterStorageSettles(() => { onboardingAfterSettle = false; if (currentHash() === "#/") offerHomeOnboarding(); });
    }
    return;
  }
  if (onboardingHeld || forayHoldsOnboarding()) return;
  if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();
}

/* ---------- U-09: Preferences chips — subtree write path ----------

   docs/curation/interest-survey-plan.md §4.1: an answer is a SUBTREE
   expansion, never an exact match on the chip's own root id — tagging depth
   is inconsistent (some subjects are tagged only on the root, e.g.
   `true-crime`; others only on children, e.g. `engineering`), so writing just
   the root would silently miss the pool entirely for half the chips. The
   taxonomy is capped at two levels (root -> leaf, taxonomy-review-2026-08.md
   §3.5), so one parent-lookup covers every descendant — no recursion needed. */
function expandTaxonomyPick(rootId) {
  return taxonomyNodes().filter(n => n.id === rootId || n.parent === rootId).map(n => n.id);
}

/* §4.3: SEED_LIFT = 0.20, damped by /sqrt(d) so picking many chips doesn't
   overwhelm any one of them ("I like everything" should barely move anything)
   — worth about four finishes or two and a half thumbs-ups (§4.4), never a
   fact. Added on top of whatever loadInterests() already seeded (authored
   default or a returning-format restore), never a replacement value, and
   through the same clamp nudgeTopics uses elsewhere. */
const ONBOARDING_SEED_LIFT = 0.20;

/** THE TYPED SUBJECT, RESOLVED (audit round 2, p-first-3). The field used to
    accept only an exact top-level label, so "health", "news", "travel" and
    "cooking" — the words a newcomer types — matched nothing: 24 of the 41
    roots are not chips and most carry compound labels ("Health & Fitness").
    Now a typed word matches a label whole (case-insensitive), then any WORD of
    a root's label, then any word of a leaf's label ("cooking" -> Cooking
    Science under Food). Roots before leaves, so "science" is the Science root
    and not Materials science. Returns the node, or null when nothing in the
    taxonomy answers to the word — never an invented node nothing in the pool
    carries. */
function resolveTypedSubject(typed) {
  const q = String(typed || "").trim().toLowerCase();
  if (!q) return null;
  const nodes = taxonomyNodes();
  const words = (n) => String(n.label || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const exact = nodes.find(n => String(n.label || "").toLowerCase() === q);
  if (exact) return exact;
  const roots = nodes.filter(n => n.parent === null);
  const leaves = nodes.filter(n => n.parent !== null);
  return roots.find(n => words(n).includes(q)) || leaves.find(n => words(n).includes(q)) || null;
}

/** Applies a Preferences pick: `pickedRootIds` from the chip grid, plus an
    optional typed subject (see resolveTypedSubject) — the mockup's "Or type
    a subject yourself…" field reaches the same write path a chip tap would.
    Returns false (no write, no _interestsGen bump) when nothing was picked
    and nothing typed matched, so a caller can tell a real Skip from a
    Continue with an empty/unmatched form; otherwise the ROOT ids the picks
    resolved to (a typed leaf counts for its root), which the re-deal reserves
    slots for. */
function applyOnboardingPicks(pickedRootIds, typedSubject) {
  const ids = [...(pickedRootIds || [])];
  const typedNode = resolveTypedSubject(typedSubject);
  if (typedNode && !ids.includes(typedNode.id)) ids.push(typedNode.id);
  if (!ids.length) return false;

  const lift = ONBOARDING_SEED_LIFT / Math.sqrt(ids.length);
  const targets = new Set(ids.flatMap(expandTaxonomyPick));
  targets.forEach(id => {
    if (id in state.interests) {
      setInterest(id, Math.max(0, Math.min(1, state.interests[id] + lift)));
    }
  });
  saveInterests();
  state._interestsGen = (state._interestsGen || 0) + 1;
  const byId = new Map(taxonomyNodes().map(n => [n.id, n]));
  return [...new Set(ids.map(id => (byId.get(id)?.parent) || id))];
}

/** U-09's third acceptance line ("picking three chips changes the FIRST Home
    render's ranking"), which shipped unmet in PR #503 (audit, 2026-09-10):
    Home's "Suggested" is `state.cardSlots`, dealt once per session by
    `buildCards()` in init() — BEFORE this sheet opens over Home, from the
    pre-pick default weights — and renderHomeV2() only rebuilds an EMPTY
    cardSlots. applyOnboardingPicks() changed the inputs of that deal without
    anything re-running it, so the picks showed up on the next session's Home
    and not the one the listener landed on. This re-runs the deal.

    Before re-dealing it UNDOES the pre-pick deal's memory. buildCards()
    records what it dealt as though the listener saw it: `cp_recent_branches`
    (a -0.35 ranking penalty on the next deal) and `cp_seen` (demotes those
    episodes behind unseen ones within their subject's chain). That deal was
    painted under a modal sheet the listener has been answering, not browsed
    — and counting it as seen would penalise exactly the subjects the picks
    just lifted (+0.20/sqrt(n), at most +0.20, against a -0.35 penalty), so a
    listener who picked the very subjects the default deal happened to show
    would watch them VANISH from the Home their picks were meant to shape.
    Only the pre-pick deal's own entries are removed: the last `dealt.length`
    branches buildCards() appended, and the dealt episode ids.

    No-op when nothing has been dealt yet — a boot that has not reached
    init()'s buildCards(), or an empty pool — because renderHomeV2() already
    rebuilds an empty cardSlots lazily and there is no memory to undo. The
    caller repaints (renderCurrentPage()); this only rebuilds state, the same
    split the family-mode toggle in init() already uses. */
function redealAfterOnboardingPicks(pickedRoots = []) {
  const dealt = state.cardSlots || [];
  if (!dealt.length) return;
  /* Undo only a deal that was RECORDED (app-1-7). Recording waits for storage
     to settle, so a deal still waiting has written nothing: undoing it used to
     cut the previous session's entries off cp_recent_branches, and then its
     recorder fired anyway. The re-deal below supersedes it instead. */
  if (lastDealRecorded) {
    const dealtIds = new Set(dealt.flatMap(sl => (sl.items || []).map(it => it.id)));
    lsSet("cp_seen", stringList(lsGet("cp_seen", [])).filter(id => !dealtIds.has(id)));
    const recent = stringList(lsGet("cp_recent_branches", []));
    lsSet("cp_recent_branches", recent.slice(0, Math.max(0, recent.length - dealt.length)));
  }
  buildCards({ reserve: Array.isArray(pickedRoots) ? pickedRoots : [] });
}

/* The 17 top-level nodes with measured pool depth (>= 50 items AND several
   distinct shows — interest-survey-plan.md §3.2), so every chip is backed by
   enough content to fill a queue on day one. Ids only; labels are read live
   off state.taxonomy so a taxonomy relabel never drifts out of sync with
   this list. */
const PREFS_CHIP_IDS = [
  "history", "comedy", "engineering", "business", "health", "society",
  "science", "true-crime", "culture", "psychology", "food", "craft",
  "nature", "medicine", "music", "personal-journals", "sports",
];

/** Explanation + consent, not an interview, then an optional Preferences
    pane — the mockup's Welcome and Preferences screens (docs/ux/foray-
    mockup.jsx, `WelcomeScreen`/`PrefsScreen`) as ONE modal sheet with two
    panes swapped in place, per D2 / card U-09 (docs/ui-transition-plan.md,
    #132). SKIPPABLE AT EVERY STEP:

      Step 1 (Welcome) — two value props, the M3 prototype's `finishOnb`/
      `skipOnb` preference-INTERVIEW step has no counterpart here and this
      still does not build one (see the test that pins that). The second
      prop is illustrated with a live, non-interactive SegmentStrip
      (player/segment-strip.js's segmentStripHtml, U-04) over the first
      listable Foray, when one exists — degrades to nothing otherwise, the
      same "no Foray, no strip" rule the component already guarantees.
      "Skip for now" dismisses immediately, with no interest write. "Get
      started" advances to step 2 WITHOUT dismissing yet.

      Step 2 (Preferences) — the taxonomy chip grid (PREFS_CHIP_IDS) plus
      the mockup's tucked-away "Or type a subject yourself…" field. Neither
      the mockup's account-connector buttons ("Continue with Apple/Google")
      nor "Import subscriptions/listening history" are built here —
      connector features, explicitly out of scope per D2/C5. "Skip" dismisses
      with no interest write (Generalist: today's taxonomy defaults stand).
      "Show my picks" applies the picks via applyOnboardingPicks() — the
      FIXED U-07 write path (taxonomyNodes() includes roots, so a root-level
      chip actually persists) — then dismisses, and when something was
      written re-deals Home's card slots and repaints, so the FIRST Home the
      listener lands on already ranks by the picks (the card's third
      acceptance line; see redealAfterOnboardingPicks()).

    Both steps' exits set the SAME cp_intro_dismissed flag showIntroPopupOnce()
    already uses, so this flow and the older popup can never both show on the
    same visit and neither shows again after. */
/* ---------- ONE OWNER FOR "A MODAL IS OPEN" (audit 2026-09-22, theme E) ----------

   Before this, nothing in the app owned the question. Eight sheets — the
   first-run explainer, the intro popup, the Foray feedback sheet, both speed
   pickers, Delete my data, Narration voice, Playback diagnostics — each
   declared `role="dialog"` + `aria-modal="true"` and then implemented none of
   what those attributes promise: focus stayed behind the scrim, Tab walked the
   covered page, Escape did nothing, and a screen reader kept reading the page
   underneath. Each one also wrote `body.fy-sheet-open` with its own add/remove
   pair, so the Foray speed menu could stack two copies (and one Cancel took the
   lock off with a sheet still up), and a back gesture over the feedback sheet —
   which lives inside #view and dies with it — left `overflow: hidden` on
   <body> with no sheet on screen. The full-screen Now Playing sheet had no
   dialog semantics at all.

   The fix the audit asked for, at the level the defect is at: ONE owner, and
   every sheet opens and closes through it.

     openSheet(wrap, opts)  remember what had focus; take the rest of the page
                            out of reach (`inert` on every sibling up the tree
                            from the sheet, except `keepReachable`); move focus
                            into the panel; keep Tab inside it; route Escape to
                            the sheet's own close; single instance per element
                            and per id; derive the body class from the stack.
     closeSheet(wrap)       undo exactly what open did, hand focus back, and
                            re-derive the body class. Idempotent.
     closeAllSheets() /     ASK each sheet to close through its own handler (a
     closeSheetsWithin(el)  sheet may refuse — Delete my data never vanishes
                            mid-delete), for navigation and for a page render
                            that is about to destroy the sheet's DOM.

   THE BODY CLASS IS A FUNCTION OF THE STACK, not a flag toggled by eight
   callers. `setBodyClass()` asks `sheetBodyClasses()` instead of carrying
   `fy-sheet-open` forward blindly, and an entry whose element has left the
   document is dropped first — so a sheet that died with #view can no longer
   leave the page scroll-locked.

   `--kb-inset` is the other half of theme E and lives in styles.css: every
   `.fy-panel` sits on the keyboard's top edge, so a sheet with a text field
   (feedback note, "Type DELETE") is no longer stranded behind it.

   Focus goes to the PANEL, not its first control: the panel carries the
   dialog's name, so a screen reader announces the dialog, and focusing a text
   field would throw a soft keyboard over the sheet the instant it opened.

   player/client.js is an ES module and cannot import from this classic
   script, so the owner is published as `window.ForaySheets` for the Now
   Playing sheet and the mini player's speed picker. app.js runs first (the
   module is deferred), so it is always there by the time either can open. */
const SHEET_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const sheetStack = [];
const SHEET_KEEPS_PLAYER_CLASS = "fy-sheet-keeps-player";
const sheetManagedClasses = new Set(["fy-sheet-open", SHEET_KEEPS_PLAYER_CLASS]);
let sheetKeysBound = false;

function sheetIsLive(entry) {
  /* `isConnected` is undefined on the node:vm DOM stubs several suites use;
     only an explicit `false` means the element has left the document. */
  return !!entry && !!entry.wrap && entry.wrap.isConnected !== false;
}

function sheetFocusables(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll(SHEET_FOCUSABLE)].filter(
    (el) => !el.hidden && !(typeof el.closest === "function" && el.closest("[hidden]")),
  );
}

function focusQuietly(el) {
  if (!el || typeof el.focus !== "function") return;
  try { el.focus({ preventScroll: true }); } catch (_) { /* a detached node */ }
}

/* Every sibling of the sheet, and of each of its ancestors up to <body>, is
   taken out of reach — the page, the tab bar, the mini player, another sheet
   underneath. `inert` (not only `aria-hidden`) because it removes pointer AND
   keyboard AND assistive-technology access in one attribute. Only elements
   this call actually changed are recorded, so closing restores exactly what
   opening did and never un-inerts something another sheet still needs. */
function inertOutside(wrap, keepReachable) {
  const changed = [];
  const keep = (el) => keepReachable.some((sel) => typeof el.matches === "function" && el.matches(sel));
  let node = wrap;
  while (node && node.parentElement && node !== document.body) {
    const parent = node.parentElement;
    for (const sib of [...(parent.children || [])]) {
      if (sib === node || keep(sib)) continue;
      const tag = String(sib.tagName || "").toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (typeof sib.hasAttribute === "function" && sib.hasAttribute("inert")) continue;
      if (typeof sib.setAttribute !== "function") continue;
      sib.setAttribute("inert", "");
      changed.push(sib);
    }
    node = parent;
  }
  return changed;
}

function releaseInert(entry) {
  for (const el of entry.inerted) {
    if (typeof el.removeAttribute === "function") el.removeAttribute("inert");
  }
  entry.inerted = [];
  /* Hand back what this sheet LIFTED from a sheet below it (see liftInertFrom),
     if that sheet is still open. */
  for (const { el, owner } of entry.lifted || []) {
    if (!sheetStack.includes(owner) || typeof el.setAttribute !== "function") continue;
    el.setAttribute("inert", "");
    owner.inerted.push(el);
  }
  entry.lifted = [];
}

/**
 * A SHEET OPENED OVER ANOTHER MAY ALREADY BE INERT (review 2026-09-23).
 * The voice, diagnostics and delete sheets are built at startup as hidden
 * <body> children, so expanding Now Playing inerts them with everything else;
 * the drawer stays reachable over Now Playing (F17) and opens them, and
 * `openSheet` only un-hid the wrap. The new sheet came up inert — its scrim,
 * Close and rows ignored every tap — over a drawer and topbar it had just
 * inerted itself: on a phone with no Escape key, the app was stuck.
 * So an `inert` on the wrap or its ancestors that a sheet BELOW set is lifted
 * for as long as this one is open, and handed back when it closes.
 */
function liftInertFrom(wrap) {
  const lifted = [];
  for (let n = wrap; n && n !== document.body; n = n.parentElement) {
    if (typeof n.hasAttribute !== "function" || !n.hasAttribute("inert")) continue;
    const owner = sheetStack.find((s) => s.inerted.includes(n));
    if (!owner) continue; // someone else's inert is not ours to lift
    n.removeAttribute("inert");
    owner.inerted = owner.inerted.filter((x) => x !== n);
    lifted.push({ el: n, owner });
  }
  return lifted;
}

/**
 * An element added to <body> while a sheet is open joins what the top sheet
 * took out of reach (review 2026-09-23). `inertOutside` runs once, when the
 * sheet opens, and the first-run explainer opens from Home's render BEFORE
 * `renderTabBar` creates the tab bar on a first visit — so the first modal a
 * new listener saw left the four tab links live behind it, where assistive
 * tech that ignores aria-modal could reach them (and a tab navigation
 * dismisses onboarding for good). Kept-reachable chrome stays reachable.
 */
function inertUnderOpenSheet(el) {
  pruneDeadSheets();
  const top = sheetStack[sheetStack.length - 1];
  if (!top || !el || typeof el.setAttribute !== "function") return;
  if (typeof top.wrap.contains === "function" && top.wrap.contains(el)) return;
  if (typeof el.hasAttribute === "function" && el.hasAttribute("inert")) return;
  if ((top.keep || []).some((sel) => typeof el.matches === "function" && el.matches(sel))) return;
  el.setAttribute("inert", "");
  top.inerted.push(el);
}

/** Drop entries whose element has left the document (a sheet that lived in
    #view and died with a render), releasing what they held. */
function pruneDeadSheets() {
  for (let i = sheetStack.length - 1; i >= 0; i--) {
    if (sheetIsLive(sheetStack[i])) continue;
    releaseInert(sheetStack[i]);
    sheetStack.splice(i, 1);
  }
}

/** The body classes the open sheets imply. Read by setBodyClass(), so a page
    render keeps a lock that is still true and drops one that is not. */
function sheetBodyClasses() {
  pruneDeadSheets();
  const out = new Set(sheetStack.map((s) => s.bodyClass));
  /* A sheet that keeps the PLAYER reachable lifts it over its scrim (audit
     round 2 review of p-first-5) — only while the TOP sheet is such a one, so
     a modal opened over it covers the bar again. */
  const top = sheetStack[sheetStack.length - 1];
  if (top && (top.keep || []).includes("#foray-player")) out.add(SHEET_KEEPS_PLAYER_CLASS);
  return [...out];
}

function syncSheetBodyClasses() {
  const want = new Set(sheetBodyClasses());
  for (const cls of sheetManagedClasses) document.body.classList.toggle(cls, want.has(cls));
}

/** The one document keydown listener for every overlay. Bound lazily by the
    first `openSheet` and by `bindDrawerChrome`, whichever comes first. */
function bindOverlayKeys() {
  if (sheetKeysBound || typeof document.addEventListener !== "function") return;
  document.addEventListener("keydown", onSheetKeydown);
  sheetKeysBound = true;
}

function onSheetKeydown(e) {
  /* The drawer sits over every sheet (F17) and has its own rules: while it is
     open the keys are its, or Escape over Now Playing would collapse the sheet
     under a drawer that stayed. */
  if (drawerIsOpen()) { onDrawerKeydown(e); return; }
  pruneDeadSheets();
  const top = sheetStack[sheetStack.length - 1];
  if (!top) return;
  if (e.key === "Escape" || e.key === "Esc") {
    e.preventDefault();
    top.requestClose();
    return;
  }
  if (e.key !== "Tab") return;
  /* The trap is belt and braces behind `inert`: a WebView without `inert`
     support still keeps Tab inside the dialog. */
  const items = sheetFocusables(top.panel);
  const active = document.activeElement;
  const inside = !!(active && typeof top.panel.contains === "function" && top.panel.contains(active));
  /* WHAT THE SHEET KEEPS REACHABLE IS INSIDE THE TRAP (review 2026-09-23).
     The Now Playing sheet leaves the topbar and the drawer reachable (F17: the
     ☰ at every moment), but the trap only knew the panel: Tab wrapped from the
     sheet's last control to its first and never reached the ☰, and with the
     drawer opened by pointer the next Tab yanked focus out of the drawer back
     into the covered sheet. The kept chrome now sits in the cycle, in document
     order ahead of the sheet: … → last control → ☰ (→ the drawer's links, when
     it is open) → first control → … */
  const kept = keptFocusables(top);
  const inKept = !!(active && kept.includes(active));
  if (!items.length && !kept.length) { e.preventDefault(); focusQuietly(top.panel); return; }
  const cycle = [...kept, ...items];
  if (inKept || (kept.length && inside)) {
    const at = cycle.indexOf(active);
    if (at >= 0) {
      e.preventDefault();
      focusQuietly(cycle[(at + (e.shiftKey ? cycle.length - 1 : 1)) % cycle.length]);
      return;
    }
  }
  if (!items.length) { e.preventDefault(); focusQuietly(top.panel); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (!inside || active === first || active === top.panel)) {
    e.preventDefault(); focusQuietly(last);
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault(); focusQuietly(first);
  }
}

/** The focusable controls inside the chrome a sheet keeps reachable
    (`keepReachable`), in the order given — the ☰ first, then an open drawer's
    links. A closed drawer is `hidden`, so it contributes nothing. */
function keptFocusables(entry) {
  const out = [];
  for (const sel of entry.keep || []) {
    let roots = [];
    try { roots = typeof document.querySelectorAll === "function" ? [...document.querySelectorAll(sel)] : []; } catch (_) { roots = []; }
    for (const root of roots) {
      if (root.hidden) continue;
      for (const el of sheetFocusables(root)) if (!out.includes(el)) out.push(el);
    }
  }
  return out;
}

/**
 * Open `wrap` as THE modal. Returns its stack entry.
 * @param {Element} wrap  the sheet's outermost element (`.fy-sheet`, or the
 *   Now Playing `.fp-sheet`); appended to <body> if it is not in the document.
 * @param {object} [opts]
 * @param {Element} [opts.panel]  what focus goes to and Tab cycles within;
 *   default the `[role="dialog"]` inside `wrap`, else `wrap`.
 * @param {Function} [opts.onRequestClose]  what Escape / navigation call — the
 *   sheet's OWN close, which must end in closeSheet(wrap). Default: closeSheet.
 * @param {string} [opts.bodyClass]  the body lock this sheet implies.
 * @param {string[]} [opts.keepReachable]  selectors left out of `inert`.
 * @param {Element} [opts.returnFocus]  where focus goes on close when the
 *   element that opened the sheet is gone.
 */
function openSheet(wrap, opts = {}) {
  if (!wrap) return null;
  pruneDeadSheets();
  const already = sheetStack.find((s) => s.wrap === wrap);
  if (already) return already;
  /* SINGLE INSTANCE BY ID: a second, different element claiming the same id
     (the Foray speed menu, built fresh on each open) replaces the first
     rather than stacking over it with duplicate ids. */
  if (wrap.id) {
    const twin = sheetStack.find((s) => s.wrap.id === wrap.id);
    if (twin) closeSheet(twin.wrap, { removeIfOwned: true });
  }
  if (wrap.isConnected === false || !wrap.parentElement) document.body.appendChild(wrap);
  bindOverlayKeys();
  const panel = opts.panel
    || (typeof wrap.querySelector === "function" && wrap.querySelector('[role="dialog"]'))
    || wrap;
  const opener = document.activeElement || null;
  /* OPENED FROM THE DRAWER: the drawer has already closed (`onDrawerAction`,
     capture phase), so the button that opened this sheet is inside a hidden
     panel by the time the sheet closes. Focus goes to the ☰ instead — the
     control the listener would press to get back to where they were. */
  const fromDrawer = !!(opener && typeof opener.closest === "function" && opener.closest("#drawer"));
  const entry = {
    wrap, panel,
    requestClose: typeof opts.onRequestClose === "function" ? opts.onRequestClose : () => closeSheet(wrap),
    bodyClass: opts.bodyClass || "fy-sheet-open",
    opener,
    returnFocus: opts.returnFocus || (fromDrawer ? $("#menu-btn") : null),
    inerted: [],
    lifted: [],
    keep: opts.keepReachable || [],
  };
  sheetManagedClasses.add(entry.bodyClass);
  wrap.hidden = false;
  entry.lifted = liftInertFrom(wrap);
  entry.inerted = inertOutside(wrap, entry.keep);
  sheetStack.push(entry);
  syncSheetBodyClasses();
  if (typeof panel.getAttribute === "function" && panel.getAttribute("tabindex") == null
      && typeof panel.setAttribute === "function") {
    panel.setAttribute("tabindex", "-1");
  }
  focusQuietly(panel);
  bindPanelDrag(entry);
  return entry;
}

/* ---------- a sheet moves, and every panel can be pulled down ----------

   Audit round 2, touch-4 and touch-8. Every `.fy-panel` in the app paints the
   same 38×4 handle the Now Playing sheet does — "so a fifth sheet cannot look
   like a different product" (client.js) — and only Now Playing answered a
   drag: eight false affordances, learned on the one sheet that taught the
   gesture. And no sheet had any motion at all: Now Playing appeared with a
   hard cut and, dismissed by a pull, vanished from mid-screen.

   THE OWNER BINDS THE GESTURE, because the owner is the one place every sheet
   already passes through: `openSheet` knows the panel and knows how to ask the
   sheet to close (`entry.requestClose`, the same path Escape takes). The
   decision — how far, what counts as a flick, and the rule that a pull
   started inside a scrolled body is a scroll — is player/sheet-drag-dismiss.js,
   read through `window.ForayPlayer.sheetDrag` (a classic script cannot import
   it), so the Now Playing sheet and these panels drag by one rule. Absent
   bridge (a harness, a page paired with an older cached module): no drag, and
   the handle is what it was.

   THE MOTION IS ONE FUNCTION PAIR for both sheet kinds: `slideIn` unhides a
   panel at its own height and releases it to 0 through the transition
   styles.css gives it; `slideOut` sends it to its height and reports when it
   has settled (`transitionend`, or a timer a beat longer than the transition,
   because a `display: none` mid-flight or a tab in the background fires no
   event). `prefers-reduced-motion` is honoured HERE, once, by not moving at
   all — styles.css switches the transitions off for the same query, and a
   caller that waited for a transition that never runs would hang on the
   timer. */
const SHEET_MOTION_MS = 220;   // styles.css: `.fp-sheet` and `.fy-panel` transitions are .22s

function reducedMotion() {
  try {
    return !!(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (_) { return false; }
}

/** Force a style flush so a property written before this and one written after
    it are two states the transition can run between. */
function reflow(el) {
  try { if (typeof el.getBoundingClientRect === "function") el.getBoundingClientRect(); } catch (_) { /* a stub */ }
}

function canSlide(el, px) {
  return !!(el && el.style && typeof el.style.setProperty === "function" && px > 0) && !reducedMotion();
}

/** Unhidden and off the bottom, then released to rest. `noMotionClass` is the
    caller's "no transition" class (the sheet's dragging class), put on for the
    first write so the panel jumps to its start rather than sliding there. */
function slideIn(el, prop, px, noMotionClass) {
  if (!canSlide(el, px)) return false;
  if (noMotionClass && el.classList) el.classList.add(noMotionClass);
  el.style.setProperty(prop, `${px}px`);
  reflow(el);
  if (noMotionClass && el.classList) el.classList.remove(noMotionClass);
  el.style.setProperty(prop, "0px");
  return true;
}

/** Sent to its full height from wherever it is; `done` runs once, when it has
    settled. Returns false — and runs nothing — when it cannot move, so the
    caller closes at once. */
function slideOut(el, prop, px, done) {
  if (!canSlide(el, px)) return false;
  let settled = false;
  let timer = null;
  const onEnd = (e) => { if (!e || e.target === el) finish(); };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer != null) clearTimeout(timer);
    if (typeof el.removeEventListener === "function") el.removeEventListener("transitionend", onEnd);
    done();
  };
  if (typeof el.addEventListener === "function") el.addEventListener("transitionend", onEnd);
  timer = setTimeout(finish, SHEET_MOTION_MS + 80);
  reflow(el);
  el.style.setProperty(prop, `${px}px`);
  return true;
}

function panelHeightPx(el) {
  try {
    const h = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect().height : 0;
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch (_) { return 0; }
}

/** Drag-to-dismiss on a `.fy-panel`, bound once per panel. The Now Playing
    sheet (`.fp-sheet`) binds its own in client.js against the same module;
    this is the same wiring for the panels the owner builds or is handed. */
function bindPanelDrag(entry) {
  const panel = entry && entry.panel;
  if (!panel || panel._dragBound || typeof panel.addEventListener !== "function") return;
  if (!panel.classList || typeof panel.classList.contains !== "function" || !panel.classList.contains("fy-panel")) return;
  panel._dragBound = true;
  const gest = () => (window.ForayPlayer && window.ForayPlayer.sheetDrag) || null;
  let drag = null;
  let pointer = null;
  /* The property is named in full here, not through a constant: styles.css
     reads `--fy-panel-dy` and test/ui-tokens.test.js accepts a token nothing
     declares only when a `setProperty` names it. */
  const paint = (px) => {
    if (!panel.style || typeof panel.style.setProperty !== "function") return;
    panel.style.setProperty("--fy-panel-dy", `${px > 0 ? px : 0}px`);
    panel.classList.toggle("fy-panel-dragging", px > 0);
  };
  panel.addEventListener("pointerdown", (e) => {
    const g = gest();
    if (!g || pointer != null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const t = e.target;
    /* A press on a control is that control's — the same rule client.js keeps
       for the scrub thumb; `summary` because the Developer disclosure lives
       in a panel too. */
    if (t && typeof t.closest === "function" && t.closest("button, a, input, select, textarea, summary, label")) return;
    const fromHandle = !!(t && typeof t.closest === "function" && t.closest(".fy-grab"));
    drag = g.start(e.clientY, e.timeStamp, { fromHandle, atTop: (panel.scrollTop || 0) <= 0 });
    pointer = e.pointerId;
    /* CAPTURED (audit round 3, app-2-10), as the Foray strip's is: a mouse has
       no implicit capture, so a release over the scrim or outside the window
       never reached this panel and left the drag stuck — displaced, and
       ignoring every later press. */
    try { panel.setPointerCapture?.(e.pointerId); } catch (_) { /* capture is best-effort */ }
  });
  panel.addEventListener("pointermove", (e) => {
    const g = gest();
    if (!drag || !g || e.pointerId !== pointer) return;
    drag = g.move(drag, e.clientY, e.timeStamp);
    paint(g.offset(drag));
  });
  /* NON-passive, or the cancel is ignored: the panel is its own scroller and
     only a cancelled touchmove keeps a pull-down at scrollTop 0 from becoming
     a rubber-band scroll (touch-2, the same mechanism on the Now Playing
     sheet and the Foray strip). */
  panel.addEventListener("touchmove", (e) => {
    const g = gest();
    if (drag && g && g.claimsTouch(drag) && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
  }, { passive: false });
  panel.addEventListener("pointerup", (e) => {
    const g = gest();
    if (!drag || !g || e.pointerId !== pointer) return;
    const { dismiss } = g.end(drag);
    drag = null;
    pointer = null;
    if (!dismiss) { paint(0); return; }
    /* The release transition applies from wherever the finger left it. Then
       the sheet's OWN close (Escape's path): a sheet that declines — Delete my
       data mid-delete — springs back, and one that closed is reset while
       hidden so its next open starts at rest. */
    panel.classList.remove("fy-panel-dragging");
    const finish = () => { entry.requestClose(); paint(0); };
    if (!slideOut(panel, "--fy-panel-dy", panelHeightPx(panel), finish)) finish();
  });
  const cancel = (e) => {
    if (!drag || e.pointerId !== pointer) return;
    drag = null;
    pointer = null;
    paint(0);
  };
  panel.addEventListener("pointercancel", cancel);
  /* Capture lost without a pointerup (the window lost focus, the element was
     hidden) is a cancel. After a pointerup the drag is already over, so the
     implicit release that follows it finds nothing to undo. */
  panel.addEventListener("lostpointercapture", cancel);
}

/** Close `wrap` if the owner holds it: lift what open did, hide it, hand focus
    back. Sheets above it close first — they were opened over it. Returns
    whether anything was open. `removeIfOwned` also removes the element (for
    sheets built fresh on each open). */
function closeSheet(wrap, { removeIfOwned = false } = {}) {
  const i = sheetStack.findIndex((s) => s.wrap === wrap);
  if (i === -1) return false;
  while (sheetStack.length - 1 > i) closeSheet(sheetStack[sheetStack.length - 1].wrap);
  const [entry] = sheetStack.splice(i, 1);
  releaseInert(entry);
  wrap.hidden = true;
  if (removeIfOwned && typeof wrap.remove === "function") wrap.remove();
  syncSheetBodyClasses();
  /* An opener inside a hidden subtree (a drawer button after the drawer
     closed) cannot take focus — `focus()` on it is a silent no-op and focus
     falls to <body>, which is the "where am I" a screen-reader user reports.
     Skip it so `returnFocus` gets its turn. */
  const back = [entry.opener, entry.returnFocus].find(
    (el) => el && el.isConnected !== false && typeof el.focus === "function" && el !== document.body
      && !inHiddenSubtree(el),
  );
  /* ONLY IF THE SHEET STILL HOLDS FOCUS (audit round 2, touch-8). A close can
     now settle a beat after it was asked — the sheet slides out first — and
     a navigation under Now Playing lands focus on the new page's heading in
     that beat (`landOnPage`). Handing it back to the opener then would take it
     off the page the listener just asked for. Focus that is inside the sheet,
     on <body>, or stranded in something hidden is the sheet's to return;
     focus that has moved on is left where it is. */
  const active = document.activeElement;
  const held = !active || active === document.body || inHiddenSubtree(active)
    || (typeof wrap.contains === "function" && wrap.contains(active));
  if (held) focusQuietly(back);
  return true;
}

/** Whether `el` or any ancestor carries `hidden` — a node that cannot be
    rendered, and therefore cannot be focused. */
function inHiddenSubtree(el) {
  for (let n = el; n; n = n.parentElement) if (n.hidden) return true;
  return false;
}

/** Ask every open sheet to close through its own handler, top first. A sheet
    that declines (Delete my data while it is deleting) stays. */
function closeAllSheets() {
  pruneDeadSheets();
  for (const entry of [...sheetStack].reverse()) {
    if (sheetStack.includes(entry)) entry.requestClose();
  }
}

/** The sheets living inside `root` — asked to close before a render replaces
    it, so the owner's stack and the body lock never outlive their DOM. */
function closeSheetsWithin(root) {
  if (!root || typeof root.contains !== "function") return;
  for (const entry of [...sheetStack].reverse()) {
    if (!sheetStack.includes(entry) || !root.contains(entry.wrap)) continue;
    entry.requestClose();
    if (sheetStack.includes(entry)) closeSheet(entry.wrap); // its DOM is about to go regardless
  }
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

function openSheetCount() {
  pruneDeadSheets();
  return sheetStack.length;
}

if (typeof window !== "undefined") {
  window.ForaySheets = { openSheet, closeSheet, closeAllSheets, openSheetCount, slideIn, slideOut };
}

/* ---------- ONCE MEANS ONCE, INCLUDING WITHIN A SINGLE VISIT ----------

   Both `…Once` functions below guarded only on PERSISTED state — "is this a
   first-time profile" and "has the intro been dismissed" — and neither of
   those flips until the listener actually dismisses the sheet. So two renders
   of Home before that dismissal mount two sheets, with duplicate element ids,
   stacked over each other.

   Home re-renders on its own: `refreshForayDirectory("boot")` is fired
   unawaited by init() and, when a newer directory is adopted, repaints every
   Foray surface — and `isForaySurface("#/")` is true, so Home is one of them.
   The whole defect is therefore a RACE between that fetch landing and the
   listener's thumb, invisible on a fast machine and reliable on a slow one.

   Found 2026-09-13 by test/playwright/drawer-and-close.spec.js, which failed
   in CI inside its own `openApp()` helper: `#first-time-sheet-skip` resolved
   to two elements, and before that a three-minute click timeout where the
   duplicate sheet intercepted every click aimed at the first. Reproduced
   locally only under `CI=1` (two workers, all specs in parallel) — a
   single-spec run never showed it.

   The fix is at the level the bug is at: a function whose name promises ONCE
   must be idempotent against its own output, not merely against a flag it has
   not written yet. Neither the repaint nor the directory refresh is wrong;
   both are wanted. `true` rather than `false` on the early return because the
   return value means "the first-time explainer owns this visit" — answering
   `false` while a sheet is on screen would let the caller open the OLDER
   intro popup on top of it (`if (!showFirstTimeExplainerOnce())
   showIntroPopupOnce()`), which is the same bug wearing a different id.

   ORDER MATTERS, AND IT IS THE SEMANTIC GATES FIRST. The idempotency check is
   LAST, after "is this a first-time profile" and "has the intro been
   dismissed", because it is a guard against this function's own output and
   nothing more — it must never be able to answer a question about WHO the
   listener is. A first draft put it first and turned
   test/first-time-onboarding.test.js red in CI: that suite's DOM stub answers
   `querySelector` with a fresh truthy element for every selector, so the check
   short-circuited and an EXISTING user was reported as seeing the first-time
   screen. The stub is crude, but the tests were right and the order was wrong.

   MUTATION: delete either early return below and
   test/onboarding-sheet-once.test.js fails on the duplicate-mount assertion.

   PARKED FOR THE VISIT (audit round 2, p-first-4). A tap on the dimmed area
   above the panel — a stray thumb, a peek at Home behind it — used to end
   onboarding for good, and lose the chips picked so far; the drawn handle,
   meanwhile, did nothing. The scrim, Escape, a navigation, hardware back and
   the drag the handle now answers are all "not now, for this visit":
   `cp_intro_dismissed` is written only by the two Skip buttons and the
   Preferences step's primary — the considered presses. `firstRunParked` is
   this-visit state, a sibling of the on-screen check above, and returns
   `true` for the same reason that check does: the explainer owns the visit,
   so the returning-user popup must not take its place. */
let firstRunParked = false;
/* True only for the one re-render a finished "Delete my data" does (persist-2):
   Home repainted under the delete sheet must not open onboarding over the
   result. `deleteMyData` sets it around its `route()` and clears it after. */
let onboardingHeld = false;

function showFirstTimeExplainerOnce() {
  if (!isGenuineFirstTimeUser()) return false;
  if (lsGet("cp_intro_dismissed", false)) return false;
  if ($("#first-time-sheet") || firstRunParked) return true;   // already on screen, or parked, this visit

  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "first-time-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  /* NOT aria-modal (audit round 2 review of p-first-5): `aria-modal="true"`
     keeps VoiceOver's cursor inside the dialog, so the player this sheet keeps
     reachable (ONBOARDING_KEEPS_REACHABLE) was reachable only by Tab. The
     modality is `inert` on everything else, which `openSheet` applies. */
  panel.setAttribute("aria-modal", "false");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");
  panel.append(grab);

  const body = ddEl("div", "ft-step-body");
  panel.append(body);

  wrap.append(scrim, panel);

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    closeSheet(wrap, { removeIfOwned: true });
  };
  const park = () => {
    firstRunParked = true;
    closeSheet(wrap, { removeIfOwned: true });
  };
  /* The player stays reachable (audit round 2, p-first-5): Home defers this
     sheet while a Foray is sounding (`offerHomeOnboarding`), but a paused or
     restored bar can still sit under it, and the mini bar's ▶ and ↺15 must not
     go inert with the page. Reachable means ABOVE the scrim as well as out of
     `inert`: `body.fy-sheet-keeps-player` lifts #foray-player over the z-70
     sheet and lifts the panel off the bar (styles.css), or a tap on the bar
     landed on the scrim and only parked the sheet. */
  openSheet(wrap, { panel, onRequestClose: park, keepReachable: ONBOARDING_KEEPS_REACHABLE });
  scrim.addEventListener("click", park);

  /* Live SegmentStrip illustration for the second value prop — reads off
     window.ForayPlayer exactly as forayCards()/renderForay() do (app.js is a
     classic script and cannot import player/segment-strip.js). Absent
     module, absent forays, or a Foray with no segments all degrade to no
     strip, never an error. */
  function welcomeStripHtml() {
    const player = window.ForayPlayer;
    if (!player || typeof player.resolve !== "function" || typeof player.segmentStripHtml !== "function") return "";
    if (!state.forays) return "";
    const first = forayCards()[0];
    if (!first) return "";
    try {
      const r = resolveListedForay(first.id);
      if (!r) return "";
      /* mergeNarration: a card is 210px of content box and a generated Foray
         is now ~56 items, 40 of them bridges — one bar each overflows the card
         and paints over its neighbour. Merging each run of back-to-back
         bridges into one violet bar (sized by the run's real total) is the fix;
         it is safe HERE and only here because nothing scrubs a card's strip.
         See collapseNarrationRuns in player/segment-strip.js. */
      return player.segmentStripHtml(r.playable, { size: "sm", mergeNarration: true }) || "";
    } catch (_) {
      // Malformed segments/sources data must not break the first-run Home
      // render — "degrades to nothing" (this function's own contract) has to
      // hold even when the player module throws, not just when it's absent.
      return "";
    }
  }

  function renderWelcome() {
    body.innerHTML = "";
    const title = ddEl("h3", null, "4a picks podcast episodes for you");
    title.id = "first-time-sheet-title";
    panel.setAttribute("aria-labelledby", "first-time-sheet-title");
    const sub = ddEl("p", "fy-sheet-sub", "A podcast app that listens to you first. Two things make it different:");

    const propLearn = ddEl("div", "ft-value-prop");
    propLearn.append(
      ddEl("h4", null, "Suggestions that actually learn"),
      ddEl("p", "fy-sheet-sub",
        "Episode picks tuned to your subjects and the voices you trust — sharper every time you listen.")
    );

    const propForay = ddEl("div", "ft-value-prop");
    propForay.append(
      ddEl("h4", null, "Forays: one subject, many shows"),
      ddEl("p", "fy-sheet-sub", forayAbout())
    );
    const stripHtml = welcomeStripHtml();
    if (stripHtml) {
      const stripWrap = ddEl("div", "ft-strip-wrap");
      stripWrap.innerHTML = stripHtml;
      propForay.append(stripWrap);
    }

    const props = ddEl("div", "ft-value-props");
    props.append(propLearn, propForay);

    const actions = ddEl("div", "fy-sheet-actions");
    const skip = ddEl("button", "fy-sheet-cancel", "Skip for now");
    skip.type = "button";
    skip.id = "first-time-sheet-skip";
    const go = ddEl("button", "fy-sheet-go", "Get started");
    go.type = "button";
    go.id = "first-time-sheet-go";
    actions.append(skip, go);

    body.append(title, sub, props, actions);
    if (stripHtml) applyStripGrowIfBridged(propForay);

    skip.addEventListener("click", dismiss);
    go.addEventListener("click", () => { renderPreferences(); landOnStep(); });
  }

  /* A STEP SWAP LANDS FOCUS ON THE NEW STEP'S TITLE (audit round 2, a11y-5).
     "Get started" empties the dialog's body, which destroys the focused button:
     focus fell to <body> inside an open modal, and the new `aria-labelledby`
     is a name change, which nothing announces. The qa 64 rule — every action
     that destroys the element just activated puts focus somewhere that
     survived — applied here. The title is the programmatic target
     (tabindex=-1, the same way `landOnPage` treats a page heading), so the
     step is read and Tab continues from its top. Not on the FIRST render: the
     owner has just focused the panel, which announces the dialog with its
     name, and that is the right first thing to hear. */
  function landOnStep() {
    const title = $("#first-time-sheet-title");
    if (!title) return;
    if (typeof title.getAttribute !== "function" || title.getAttribute("tabindex") == null) title.setAttribute("tabindex", "-1");
    focusQuietly(title);
  }

  function applyStripGrowIfBridged(scope) {
    if (window.ForayPlayer && typeof window.ForayPlayer.applyStripGrow === "function") {
      window.ForayPlayer.applyStripGrow(scope);
    }
  }

  function renderPreferences() {
    body.innerHTML = "";
    const picked = new Set();

    const title = ddEl("h3", null, "What are you into?");
    title.id = "first-time-sheet-title";
    panel.setAttribute("aria-labelledby", "first-time-sheet-title");
    const sub = ddEl("p", "fy-sheet-sub", "This is how 4a tunes your suggestions. Pick a few, or skip — 4a learns either way, from what you play.");

    const chips = ddEl("div", "fy-chips");
    chips.id = "first-time-sheet-chips";
    PREFS_CHIP_IDS.forEach(id => {
      const node = nodeById(id);
      if (!node) return; // taxonomy drift: never render a chip for a node that no longer exists
      const chip = ddEl("button", "fy-chip", node.label);
      chip.type = "button";
      chip.dataset.chip = id;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        if (picked.has(id)) { picked.delete(id); chip.classList.remove("on"); chip.setAttribute("aria-pressed", "false"); }
        else { picked.add(id); chip.classList.add("on"); chip.setAttribute("aria-pressed", "true"); }
      });
      chips.append(chip);
    });

    const typedWrap = ddEl("div", "ft-typed-wrap");
    const typedInput = ddEl("input");
    typedInput.type = "text";
    typedInput.id = "first-time-sheet-typed";
    typedInput.className = "ft-typed-input";
    typedInput.placeholder = "Or type a subject yourself…";
    typedInput.setAttribute("aria-label", "Type a subject yourself");
    /* A TYPED MISS IS SAID, AND THE SHEET STAYS (audit round 2, p-first-3). A
       word nothing in the taxonomy answers to used to close the sheet exactly
       as a match did, so the newcomer's first typed act was a silent no-op. */
    const typedNote = ddEl("p", "ft-typed-note", "");
    typedNote.id = "first-time-sheet-typed-note";
    typedNote.setAttribute("role", "status");
    /* NEVER `hidden` (audit round 2 review): a live region outside the
       accessibility tree when its text changes, which then appears with the
       text already in place, is usually not read (VoiceOver in WKWebView in
       particular), so a VoiceOver newcomer pressing "Show my picks" heard
       nothing. It stays in the tree, empty when there is nothing to say. */
    typedInput.addEventListener("input", () => { setStatusText(typedNote, ""); });
    typedWrap.append(typedInput, typedNote);

    const actions = ddEl("div", "fy-sheet-actions");
    const skip = ddEl("button", "fy-sheet-cancel", "Skip");
    skip.type = "button";
    skip.id = "first-time-sheet-prefs-skip";
    const go = ddEl("button", "fy-sheet-go", "Show my picks");
    go.type = "button";
    go.id = "first-time-sheet-prefs-go";
    actions.append(skip, go);

    body.append(title, sub, chips, typedWrap, actions);

    skip.addEventListener("click", dismiss);
    go.addEventListener("click", () => {
      const typed = typedInput.value.trim();
      if (typed) {
        const node = resolveTypedSubject(typed);
        if (!node) {
          /* Cleared, then said on the next frame — announce()'s idiom — so the
             region sees a change even when the same word misses twice (the
             helper skips identical text, and an unchanged node says nothing). */
          const said = `No subject called ${quoteQuery(typed)} yet. Try one of the chips above.`;
          setStatusText(typedNote, "");
          const say = () => setStatusText(typedNote, said);
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(say); else say();
          return;
        }
        /* The word resolved: its subject's chip lights, so the pick is shown
           as the same thing a tap would have made it. */
        const rootId = node.parent || node.id;
        const chip = chips.querySelector(`[data-chip="${rootId}"]`);
        if (chip && !picked.has(rootId)) { picked.add(rootId); chip.classList.add("on"); chip.setAttribute("aria-pressed", "true"); }
      }
      const applied = applyOnboardingPicks([...picked], typed);
      dismiss();
      /* Only when something was actually written: an empty form is a Skip in
         all but name, and the Home already under the sheet is the right Home
         for it. Otherwise re-deal and repaint, so the FIRST Home the listener
         lands on ranks by their picks (U-09's acceptance line; see
         redealAfterOnboardingPicks), with the picked subjects in the top-tier
         slots (p-first-1). renderCurrentPage(), not route(): nothing about
         the location changed, and route() is the back-stack's entry point
         (#488). */
      if (applied) {
        redealAfterOnboardingPicks(applied);
        renderCurrentPage();
      }
    });
  }

  renderWelcome();
  return true;
}

/* First-run explainer (#128 follow-up). Used to be a permanent card at the top
   of the home screen — after the first read it was dead weight that pushed the
   subject cards down the screen for good. It is now a one-time popup shown
   right after the very first app open (gated on the same cp_intro_dismissed
   flag, so an existing install that already dismissed the card never sees it
   again) and nothing about it lives in the home layout any more.

   Returning users, and first-time users who already saw
   showFirstTimeExplainerOnce() this visit, are the only ones who reach this
   function — renderHome() calls the two in sequence and short-circuits here
   when the explainer just showed, so a first-ever visit never shows both. */
function showIntroPopupOnce() {
  if (lsGet("cp_intro_dismissed", false)) return;
  /* The same guard, for the same reason and in the same position (after the
     persisted gate, never before it) as `showFirstTimeExplainerOnce` above.
     This one is reachable by RETURNING users, who are not
     `isGenuineFirstTimeUser()`, so it has only ever had the one flag between
     it and a duplicate mount. `introParked` is the same this-visit state the
     first-run sheet keeps. */
  if ($("#intro-sheet") || introParked) return;
  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "intro-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  // Not aria-modal, for the first-run sheet's reason: the player stays reachable.
  panel.setAttribute("aria-modal", "false");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = ddEl("h3", null, "4a picks podcast episodes for you");
  title.id = "intro-sheet-title";
  panel.setAttribute("aria-labelledby", "intro-sheet-title");

  const sub = ddEl("p", "fy-sheet-sub",
    /* It described the retired four-card Home ("Grouped into four topic
       queues…"), so the first thing a returning listener read was about a
       screen they were not looking at (audit 2026-09-22, persona row 23). It
       describes the Home that ships, and it is where a listener who skipped
       the first-run sheet learns what a foray is.
       Review 2026-09-23: no "stitch clips" (the 2026-08-11 playback ruling —
       see forayAbout), and only what Home renders: the stretch pick is in
       Forays for you and Suggested (pickWithStretchFloor, the cardSlots
       stretch role), not in Playlists, which are mostly the listener's own.
       Audit round 2 (p-first-11): the Forays row has a stretch pick only when
       the listed Forays span more than one subject, and with one published
       Foray it cannot. The sentence asks the SAME pick Home renders
       (foraysForYouPicks) instead of assuming. */
    `A foray plays moments from several shows, straight from each show's own feed, one after another. Below them are your playlists and episodes picked for you. The episodes ${foraysForYouPicks()?.stretchIndex >= 0 ? "and the forays each " : ""}include one pick outside your usual subjects, on purpose.`);

  const actions = ddEl("div", "fy-sheet-actions");
  const ok = ddEl("button", "fy-sheet-go", "Got it");
  ok.type = "button";
  ok.id = "intro-sheet-ok";
  actions.append(ok);

  panel.append(grab, title, sub, actions);
  wrap.append(scrim, panel);

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    closeSheet(wrap, { removeIfOwned: true });
  };
  /* The same rule as the first-run sheet (p-first-4): only "Got it" is the
     considered press; everything else parks it for this visit. */
  const park = () => {
    introParked = true;
    closeSheet(wrap, { removeIfOwned: true });
  };
  openSheet(wrap, { panel, onRequestClose: park, keepReachable: ONBOARDING_KEEPS_REACHABLE });
  scrim.addEventListener("click", park);
  ok.addEventListener("click", dismiss);
}

/** What the two onboarding sheets leave reachable: the player, so audio that
    a shared Foray link started stays controllable under them (p-first-5). */
const ONBOARDING_KEEPS_REACHABLE = ["#foray-player"];
let introParked = false;

/* One result row per matched show -- deliberately not epRow/miniCard: a show
   search result has no play control, duration, or star (it names a SHOW, not
   a playable item), and links straight to the page Stage 1 already built. */
/* P-03 (docs/search-parity-plan.md): THE BYLINE. The only half of "index the
   author and search it" that survives measurement — see `rankShows`'s header in
   search-engine.js for why the ranking half was built, measured against the live
   directory over 20 host-name queries, and refused.

   WHAT IT IS FOR. After P-02 the list is mostly rows the DIRECTORY chose, and
   Apple matches on an author index we do not have. So a listener who types
   "andrew huberman" gets *Huberman Lab* at the top of a list where nothing
   visible on the row contains a word they typed, and the rows under it look
   like noise. The byline is the row saying why it is there.

   GATED ON THE FIELD, NOT ON `source === "apple"`, deliberately. Today only
   `mapAppleShow` populates `artist_name` (no committed catalogue row has an
   author — that is P-03a's whole point), so the gate is self-limiting now AND
   correct the day a re-harvest gives breadth rows one, with no second edit here.

   `showResultRow` is shared with `similarShowsSection` and A3.5's "shows we
   vouch for", both of which render curated rows: those carry no `artist_name`,
   so they are byte-identical to before. `test/show-search-ranking.test.js` pins
   both directions. */
function showResultRow(show) {
  const art = showArtworkUrl(show);
  const by = typeof show?.artist_name === "string" ? show.artist_name.trim() : "";
  /* `title=` carries the whole name: styles.css clamps the row's title to two
     lines (audit round 2, search-11), so a 125-character title is cut on
     screen, and hover and a long-press tooltip still have all of it. */
  return `<a class="show-result" href="#/show/${encodeURIComponent(show.show_id)}" title="${esc(show.title)}">
    ${art ? rowArtImg(art) : `<span class="show-result-art show-result-art-blank"></span>`}
    <span class="show-result-text">
      <span class="show-result-title">${esc(show.title)}</span>
      ${by ? `<span class="show-result-by">${esc(by)}</span>` : ""}
    </span>
  </a>`;
}

/* A3.5: "Shows we vouch for" — a show-level editorial row (requirements audit
   note: 220/220 catalog.json shows already carry `editorial_note`, unused as a
   browse surface until now — only the four topic-based subject cards
   (buildCards/cards4) and forays (forayListHtml) serve as an editorial front
   door today, and both are episode/topic-shaped, not show-shaped). Per the
   requirements doc's B1 separation rule this is its own distinctly-labeled
   section, never blended into an episode row or a foray row — it reuses
   showResultRow verbatim (same "names a SHOW, not a playable item" rule
   similarShowsSection already follows) rather than inventing a second
   show-card markup.

   Every show qualifies (all 220 carry a non-empty editorial_note), so
   "curated" here means a deterministic day-rotating sample rather than a
   hand-maintained allow-list — a fixed set would either need constant
   upkeep as the catalogue grows or go stale immediately. Seeded by calendar
   day (UTC `YYYY-MM-DD` of `now`), NOT Math.random: every visitor and every
   render on the same day sees the same set (no layout jitter from a refresh),
   and a test can pin the exact output by passing a fixed `now` rather than
   stubbing global Date. Base order is show_id-sorted before the seeded
   shuffle runs, so the result is never insertion-order-dependent (same
   tie-breaking discipline similarShows uses). */
function dayOfYearSeed(now) {
  const key = now.toISOString().slice(0, 10); // UTC YYYY-MM-DD
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/* A linear-congruential shuffle (Fisher-Yates driven by an LCG), not
   Math.random — the whole point of dayOfYearSeed is a result a test can
   reproduce by passing the same `now`, and Math.random cannot be seeded. */
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showsWeVouchFor(limit = 8, now = new Date()) {
  const shows = (state.catalog?.shows || [])
    .filter(s => s.editorial_note && s.editorial_note.trim())
    .slice()
    /* CODEPOINT order, not localeCompare (audit round 3, app-2-9): with no
       locale argument that collates in the DEVICE's locale, and under lt, et,
       cs and sk the committed ids sort differently — so the seeded shuffle
       picked a different "same set for every visitor" there. */
    .sort((a, b) => (a.show_id < b.show_id ? -1 : a.show_id > b.show_id ? 1 : 0));
  if (!shows.length) return [];
  return seededShuffle(shows, dayOfYearSeed(now)).slice(0, limit);
}

/* Renders nothing (not an empty section) when there is no editorially-noted
   show in the catalogue — matches similarShowsSection's and moreFromShow's
   own absence rule. */
function vouchForHtml() {
  const shows = showsWeVouchFor();
  if (!shows.length) return "";
  return `<section class="ep-more fy-vouch">
    <h3>Shows 4a vouches for</h3>
    <div class="show-results">${shows.map(showResultRow).join("")}</div>
  </section>`;
}

/* ---------- Shows search (Stage 2, docs/show-pages-plan.md) ----------

   A separate affordance from #pl-form's topic playlist builder, on purpose
   (plan §2, kanban card scope): the two ask different questions ("what
   should I listen to" vs "does this show exist here") and are never merged
   into one result list or one search mode. They were kept apart by a tab
   strip on Home until 2026-09-03; now they are kept apart by living on two
   pages — this one on #/shows, the builder on #/playlists.

   A3.1/Q3: this must reach 4a's FULL breadth catalogue, not just the 220
   curated shows shipped in data/catalog-client.json — "the user should
   never notice any limitations based on our own limited curation." The
   curated set is searched locally first (instant, no network) as the fast
   first pass; the full-breadth backend endpoint (kanban t_8d1a6a58,
   backend/src/catalog/searchBreadthShows.ts) is queried in parallel and its
   results are appended once they land, deduped against what's already
   showing. A network failure degrades to the curated-only results silently
   — never a broken/blank state (matches showsForCategory's and renderShow's
   own "absence is a real state, not an error" rule). */
/* S-07 / G1 (docs/search-plan.md §3, docs/DECISIONS.md 2026-09-11). The
   founder ruled OPTION B: the typed Shows-search query may leave the device,
   unconditionally, and docs/legal/privacy-policy.md §2 was rewritten to say so
   rather than the code being gated on a local miss.

   THIS CONSTANT IS THE RELEASE TRIPWIRE'S SOURCE FLAG, not a behaviour switch,
   and nothing in this file reads it. `test/release-gates.test.js` does: a
   release build fails to start if this is true WHILE the policy still carries
   the old absolute no-transmission sentence. It is set now because the claim
   it makes is true now — the debounced passes below reach
   `api/shows/search` and `api/episodes/search` on every query, hit or miss.
   Turning it off without also restoring a local-miss gate would be a lie about
   the same code, which is the one thing that suite exists to prevent. */
const SHOWS_SEARCH_OFF_DEVICE = true;

/* THE KEYBOARD A SEARCH FIELD ASKS FOR (audit round 2, search-3), shared by
   the Search page's field and the show page's episode field so the two cannot
   drift. `enterkeyhint="search"` labels the return key; the other three stop
   iOS rewriting a host's name ("fridman" -> "Friedman") and capitalising the
   first letter of a query that is matched case-insensitively anyway. The type
   stays `text`, not `search`: WebKit draws its own clear button inside a
   `search` input, beside the page's ✕. */
const SEARCH_INPUT_ATTRS = 'enterkeyhint="search" autocorrect="off" autocapitalize="none" spellcheck="false"';

/* WHAT AN OFFLINE SEARCH CAN HONESTLY SAY (audit round 2, states-9). It read
   "Showing shows available offline", which was written from the engine's side
   (which TIERS answered) and read from the listener's as a promise: nothing is
   available offline — the rows are title projections of the curated 220 and
   the on-device index, and every tap on one needs the network (there is no
   download feature, and that is deliberate: persona 71). Shown only above a
   non-empty list; an empty offline search says so in `#sh-note` instead. */
const OFFLINE_SEARCH_NOTE = "You're offline — these are show names 4a already knows. Episodes need a connection.";

/* WHERE THE SEARCH TAB LAST WAS (audit round 2, search-5). Round 1 put the
   query in the address (`#/shows/q/<q>`) so ‹ restores it; the tab bar's
   Search entry still linked the bare root, so the gesture the founder actually
   uses — open a result, tap Search — landed on an empty browse page with the
   query, the results and the scroll gone. Written by the one place the address
   is written (`noteShowQueryInRoute`) and by the page's own mount, so it can
   never disagree with the address the page last had. */
let lastSearchTabHash = "#/shows";
function rememberSearchTabHash(hash) { lastSearchTabHash = hash; }

let showSearchToken = 0; // guards a slow in-flight fetch from clobbering a newer query's results

/* WHAT IS ON THE SCREEN RIGHT NOW, and it has to be module state rather than a
   closure because more than one pass paints into `#sh-results` for a single
   query and they do not all originate from the same call (adversarial review
   2026-09-12, defect 5).

   The show index is loaded lazily on the first focus, so it routinely lands in
   the MIDDLE of a query that has already been answered by the catalogue and
   directory passes. `repaintShowSearchForIndex` used to re-run the LOCAL pass
   with the current token — which is not a supersession, so no guard stopped it
   — and the endpoint's rows vanished until the next keystroke, taking the
   majority of the list with them now that P-02 makes the directory the bigger
   half. `runShowSearchCostly`'s own `shown` variable had the mirror-image
   problem: it was a snapshot taken before the index landed, so the next merge
   to complete would repaint from it and undo the index's rows instead.

   One record, written by the only function that paints, read by everyone who
   merges. `query` and `token` are both here because either alone can go stale:
   a repeat of the same query gets a new token, and a superseded token can
   belong to the same query text. */
let showSearchPainted = { token: -1, query: "", rows: [] };

/* S-02: the debounce timer, and `showSearchToken` now guards it as well as the
   in-flight responses. A fast retype must CANCEL the pending tick, not merely
   drop its answer — otherwise ten keystrokes inside 250 ms would still fire
   ten costly passes, each of which would then discover it had been superseded
   after paying for itself. Two mechanisms, because they fail at different
   moments: `clearTimeout` stops work that has not started, the token drops
   work that has already started. */
let showSearchDebounceTimer = null;
const SHOW_SEARCH_DEBOUNCE_MS = 250;
/* The keystroke pass's answer the pending tick will build on, kept beside the
   timer so a return key pressed inside the debounce can run that tick NOW with
   the rows it was going to use — rather than bump the token and paint the local
   pass a second time (audit round 2, search-7). Null whenever no tick is owed. */
let showSearchPendingLocal = null;

/** THE SEARCH PAGE'S QUERY LIVES IN THE ADDRESS (audit 2026-09-22). A typed
    search changed only the field, so ‹ back from a show opened the Search page
    empty — the query, its results and the scroll offset gone — and a reload or
    a shared link did the same. `#/shows/q/<q>` already existed for the browse
    pills; a settled query now writes it, in place, and clearing writes it back
    to `#/shows`. Only while the Search page is the page on screen. */
function noteShowQueryInRoute(query) {
  if (!/^#\/shows($|\/)/.test(currentHash())) return;
  const q = String(query || "").trim();
  const hash = q ? "#/shows/q/" + encodeURIComponent(q) : "#/shows";
  rememberSearchTabHash(hash);
  rewriteRouteInPlace(hash);
}

/** Invalidate every show-search pass in flight and forget what they painted:
    the work that has not started (the debounce tick) and the work that has
    (the token). Called when the page that owned them is replaced. */
function supersedeShowSearch() {
  showSearchToken++;
  showSearchPainted = { token: -1, query: "", rows: [] };
  showSearchPendingLocal = null;
  if (showSearchDebounceTimer) { clearTimeout(showSearchDebounceTimer); showSearchDebounceTimer = null; }
}

/** Is `query` the search already on the page under the CURRENT token — painted,
    with its costly passes pending, in flight or answered? Both halves of the
    record are read, for the reason its own comment gives: a repeat of the same
    text gets a new token only when something here decides it should. */
function isShowSearchCurrent(query) {
  if (showSearchPainted.token !== showSearchToken || showSearchPainted.query !== query) return false;
  /* A search that has recorded a failure is not one to leave alone: the passes
     that failed cached nothing, so running it again is the retry — whether the
     listener presses Try again, return, or types the query over. */
  return !(showSearchFailure.token === showSearchToken && (showSearchFailure.shows || showSearchFailure.episodes));
}

/* Below this many hits from the prefix pass, the debounce tick also runs the
   LINEAR scan over the index (12.9-19.9 ms measured over 19,904 rows, 4.1 ms
   median over the committed 10,113-row cut — either way too expensive for a
   keystroke, and pointless when the prefix pass already filled the list). */
const SHOW_PREFIX_UNDERDELIVERS_BELOW = 10;

/** Monotonic where available (S-01, docs/search-plan.md): `performance.now()`
    in a browser, `Date.now()` in the node:vm test harness that has no
    `performance` global. Never used for anything but a duration -- this
    repo's own #195 rule against wall-clock assertions applies to the record
    this feeds, not just to tests. */
function nowMs() {
  return (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now() : Date.now();
}

/* ---------- S-03: the client-side show index ----------

   `data/show-index.tsv` — 10,113 shows, 436 KB raw / 201 KB gzipped, built by
   `tools/build-show-index.mjs` (whose header carries the whole design
   argument, including why this fetch is UNPINNED). Three rules live here and
   nowhere else:

   1. LAZY, ON FIRST FOCUS OF `#sh-input`. Never at `init()`. The decode is
      ~113 ms measured; on the boot path that is a visible stall for a listener
      who came to press play. The one other asker is a Foray page whose
      credited shows the catalogue cannot link (audit round 2, p-foray-2), and
      it asks only AFTER that page has painted (joinForayCreditsToShowIndex).
   2. UNPINNED — a bare `fetch`, not `fetchJson`, and the parentheses are
      left off that name ON PURPOSE: tools/mobile/prepare-webdir.mjs derives
      the native bundle's data list by counting literal CALL SITES of that
      helper in this file, and a mention of its name followed by an open
      parenthesis — even inside a comment — is counted as one of them, so it
      is written bare here and pinned by that file's own derivation test.
      `fetchJson` appends
      `?_fdid=<deploy id>` and `sw.js:handleData`'s tagged branch answers a
      bare 504 for a pinned file the generation does not hold, so a pinned
      fetch of a file that is not in `deploy-manifest.json` fails HARD, online
      and offline alike (docs/search-plan.md §1.5). Unpinned goes through the
      untagged branch: origin first, generation cache second.
   3. ABSENCE IS A REAL STATE. A failed or 404ing index is not an error the
      listener ever sees: `localShowMatches` falls back to the curated 220 and
      the debounced breadth endpoint still answers. A later focus retries. */
const SHOW_INDEX_PATH = "data/show-index.tsv";
let showIndex = null;          // { keys, rows } once decoded
let showIndexPromise = null;   // the in-flight load, so N focuses cost one fetch

function loadShowIndex() {
  if (showIndex) return Promise.resolve(showIndex);
  if (showIndexPromise) return showIndexPromise;
  showIndexPromise = (async () => {
    try {
      /* BOUNDED (audit round 2, states-4): a hung fetch here never reached the
         `finally` that clears `showIndexPromise`, so every later focus was
         handed the same hung promise and the index never loaded for the rest
         of the session — the opposite of this header's "a later focus
         retries". Past the bound it answers null like a failure, the promise
         clears, and the next focus asks again. */
      /* THE BODY IS INSIDE THE DEADLINE TOO (audit round 3, app-2-5), as in
         fetchApiJson: headers inside the bound and then a stalled body left
         `await res.text()` — and so this promise — pending for the session. */
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const text = await withDeadline(
        (async () => {
          const res = await fetch(SHOW_INDEX_PATH, ctl ? { cache: "no-cache", signal: ctl.signal } : { cache: "no-cache" });
          return res && res.ok ? await res.text() : null;
        })(),
        DATA_DEADLINE_MS,
        () => { try { if (ctl) ctl.abort(); } catch (_) { /* nothing left to free */ } return null; }
      );
      if (text == null) return null;
      const parsed = SearchEngine.parseShowIndex(text);
      /* An empty parse is a failure, not an empty index: it means the file
         arrived truncated or in a shape `parseShowIndex` does not read, and
         adopting it would permanently shadow the curated pass with nothing. */
      if (!parsed.rows.length) return null;
      showIndex = parsed;
      repaintShowSearchForIndex();
      return showIndex;
    } catch (_) {
      return null; // offline, blocked, or a 504 from the worker — see rule 3
    } finally {
      showIndexPromise = null;
    }
  })();
  return showIndexPromise;
}

/** The index landing mid-query must IMPROVE the list already on screen — a
    listener who typed before it resolved would otherwise keep the 220-show
    answer until the next keystroke.

    IT MERGES, IT DOES NOT REPAINT FROM SCRATCH, and it does not touch the
    episode section at all (adversarial review 2026-09-12, defect 5). This ran
    `paintShowSearchLocal(query, showSearchToken)` — the CURRENT token, so no
    supersession guard applied and nothing stopped it — which threw away every
    row the catalogue and directory passes had already merged in, and then, once
    P-05 put the episode tier on that same function, cleared the endpoint's
    episode rows too. Two sections reverted to the local-only answer with no way
    back until the next keystroke, and under P-02 the discarded directory rows
    are the majority of the list.

    THE SHOW INDEX IS A SHOW INDEX. It says nothing whatsoever about episodes,
    so there is no honest reason for its arrival to repaint `#ep-search-results`
    — that section belongs to the keystroke and to the episode endpoint. */
function repaintShowSearchForIndex() {
  const input = $("#sh-input");
  const query = input && String(input.value || "").trim();
  if (!query) return;
  const localShows = localShowMatches(query);
  const existing = paintedShowRows(query, showSearchToken, null);
  if (!existing) { paintShowResults(query, localShows, showSearchToken); return; }
  const additions = mergeShowRows(query, existing, localShows);
  if (additions) appendShowResults(query, additions, showSearchToken);
}

/** Curated 220 + the index's PREFIX answer, merged and ranked once by
    `SearchEngine.searchShows` so the two sources cannot produce two orders.
    Curated records win a duplicate id deliberately: they carry `artwork_url`
    and `editorial_note`, which the index's title projection does not. */
/* BOUNDED WORK PER PASS (audit round 3, app-2-2). Measured on the committed
   data/show-index.tsv: `t` has 2,497 prefix rows, `the` 2,056 plus 1,099 from
   the scan, `pod` 2,512 scan rows — and every one was turned into markup, then
   re-deduped and re-painted on each later pass, up to six times per query. Each
   pass now hands over at most SHOW_PASS_LIMIT rows (its best, by the same
   comparator it ranks with), and the list paints SHOW_RESULTS_PAINT_STEP rows
   at a time behind a "Show more shows" button. Nobody reads row 2,000 of a
   one-letter query; they type another letter. */
const SHOW_PASS_LIMIT = 200;
const SHOW_RESULTS_PAINT_STEP = 50;

function localShowMatches(query) {
  const curated = state.catalog?.shows || [];
  if (!showIndex) return SearchEngine.searchShows(query, curated);
  const seen = new Set(curated.map((s) => s.show_id));
  const fromIndex = SearchEngine.prefixSearchShows(query, showIndex, SHOW_PASS_LIMIT)
    .filter((s) => !seen.has(s.show_id));
  return SearchEngine.searchShows(query, curated.concat(fromIndex));
}

/* ---------- S-05: the hot-query cache ----------

   `fetchApiJson` passes `{ cache: "no-cache" }` (measured, docs/search-plan.md
   §1.5), so the browser's own HTTP cache is defeated BY DESIGN and the
   endpoint's `max-age=300` buys the app nothing — a retype of a query typed
   three seconds ago pays the whole 0.4-1.1 s round trip again. So the cache
   has to live here.

   FIFO-with-wholesale-clear, following `SEARCH_CACHE_MAX`/`searchCache` above
   rather than inventing a second cache convention in the same file: every
   entry is a pure function of its key and cheap to rebuild, so evicting all
   of them on overflow is fine and needs no LRU bookkeeping. Session-scoped,
   never persisted — a reload gets fresh results, which is the right default
   for a catalogue that refreshes nightly.

   ONLY SUCCESSFUL RESPONSES ARE CACHED. A failed fetch resolves `null` and is
   not an answer; caching it would turn one bad moment on a train into a
   permanently empty breadth pass for that query.

   THE REFUSAL THIS CARD IS REALLY ABOUT: no warm-up ping, no keep-warm cron.
   Measured (§1.4): forced-MISS ttfb 0.72-0.88 s, repeat-HIT 0.41-1.12 s — a
   ~0.3 s delta on a ~0.8 s wall time, because a Vercel HIT does not invoke
   the function at all. Cold start is not what makes search feel slow; the
   round trip is, and S-03 is what removes it. A scheduled warm-up job would
   buy a third of the wrong number. */
const SHOW_BREADTH_CACHE_MAX = 200;
const showBreadthQueryCache = new Map();

/** ---------- S-05: the shard-backed show index (4a-shows-pipeline-plan.md §3.2) ----------

   A THIRD source alongside S-03's title-only `show-index.tsv` (still the
   INSTANT local pass, unchanged, and still first — see `localShowMatches`)
   and the catalogue/directory passes above: a richer per-show row (author,
   artwork, episode count, curated flag) fetched from the shard published by
   S-04a/b and proxied same-origin through `api/shows/index/[...path].ts`
   (S-05's own file — see its header for the CORS/Fable-ruling context and
   for why no CSP change lands with this card).

   OFFLINE (D9): the fetch is skipped entirely, not attempted-and-failed —
   `navigator.onLine === false` is checked BEFORE building the request, the
   same guard `renderEpisodeSearchResults` already uses for the identical
   reason (this file's "absence is a real state, a network-only feature
   does not get a spinner that will never resolve" rule). Skipped means
   zero requests, which is the card's literal acceptance criterion, not an
   approximation of it — a request that starts and is expected to fail
   would still be a request.

   IN-MEMORY FIRST, THEN CACHE STORAGE. `shardMemoryCache` is a session-
   scoped `Map<shardKey, rows[]>` — the same trip cost the hot-query cache
   above exists to avoid. Beneath it, the Cache Storage entry (this
   session's `caches.open(SHARD_CACHE_NAME)`) survives a reload and is
   checked before any network request; the entry named on the card ("in-
   memory + Cache Storage") is deliberately two tiers, not one, because
   Cache Storage read/write is itself an async round trip through the
   browser's own storage layer and paying it on every keystroke inside one
   session would be silly when a plain Map already answers for free.

   VERSION-TAGGED CACHE STORAGE ENTRIES (S-04c, Fable ruling FR-t_546eac9f-2):
   a Cache Storage entry used to carry no release-version tag at all, so once
   a real shows-index release existed it could never invalidate a
   previously-cached shard until browser eviction — this was the exact
   follow-up S-04a/b's own header named. `api/shows/index/[...path].ts` now
   answers every request with an `X-Shows-Index-Version` header carrying the
   pointer's `release_tag` (the same export_version-derived tag
   `tools/shows/publish-release.mjs:releaseTagFor` produces); this module
   stores that tag ALONGSIDE the rows in the same Cache Storage entry
   (`{ version, rows }`, see `readShardFromCacheStorage`/
   `writeShardToCacheStorage`) and `fetchShardRows` compares it against the
   most recently seen version (`lastSeenShardVersion`, updated from every
   successful network fetch this session) before trusting a Cache Storage
   hit — a version mismatch is treated as a cache miss and the shard is
   re-fetched, overwriting the stale entry. `SHARD_CACHE_NAME`'s `-v1`
   suffix remains as a manual escape hatch (bump it to invalidate the whole
   cache at once, e.g. if the entry shape itself ever changes again) but is
   no longer the ONLY invalidation path. */
const SHARD_CACHE_NAME = "foray-shows-index-v1";
const shardMemoryCache = new Map(); // shardKey -> rows[] | null (null = "fetched, came back empty/unavailable")

/** The most recently observed `X-Shows-Index-Version` from a successful
    shard/index fetch THIS session — null until the first one lands. Used
    only to decide whether a Cache Storage hit is stale (see
    `fetchShardRows`); never persisted itself, so a fresh page load always
    trusts a Cache Storage entry's OWN stored version until a live network
    response says otherwise — exactly the "in-memory first, but Cache
    Storage survives a reload" posture this section's header already
    describes, extended to the version tag itself. */
let lastSeenShardVersion = null;

/** True only when the runtime has told us we are offline. A browser that
    never sets `navigator.onLine` (or an older WebKit) defaults to "assume
    online" — the same posture `renderEpisodeSearchResults` already takes —
    rather than silently disabling the shard pass everywhere that API is
    absent. */
function isOfflineForShardSearch() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Reads `shards/<key>.json` from Cache Storage, or null on any miss/error
    (a private-browsing context that refuses `caches.open`, a corrupt entry,
    Cache Storage genuinely absent). Never throws — this is a best-effort
    read on the way to a network fetch, not a source of truth.

    RETURNS `{ version, rows }`, NOT BARE ROWS (S-04c) — `fetchShardRows`
    needs the stored version to decide whether this hit is stale before it
    can be trusted; a caller wanting only the rows reads `.rows`. An entry
    written before this change (bare `rows[]`, from `-v1`'s original shape)
    reads back as `Array.isArray(parsed)` and is treated as `{ version:
    null, rows: parsed }` — version `null` never matches a real tag, so an
    old entry is correctly treated as stale exactly once (re-fetched, then
    rewritten in the new shape) rather than thrown away as corrupt. */
async function readShardFromCacheStorage(shardKey) {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(SHARD_CACHE_NAME);
    const res = await cache.match(`shards/${shardKey}.json`);
    if (!res) return null;
    const parsed = await res.json();
    if (Array.isArray(parsed)) return { version: null, rows: parsed }; // pre-S-04c entry shape
    if (parsed && Array.isArray(parsed.rows)) return { version: parsed.version ?? null, rows: parsed.rows };
    return null;
  } catch (_) {
    return null;
  }
}

/** Writes a successfully-fetched shard's rows, tagged with the version that
    produced them, into Cache Storage, keyed the same way
    `readShardFromCacheStorage` reads. Best-effort and silent on failure —
    a shard search that works this session but cannot persist is still a
    working search, matching every other cache in this file's "caching
    failing is never the same as searching failing" posture. */
async function writeShardToCacheStorage(shardKey, rows, version) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(SHARD_CACHE_NAME);
    await cache.put(`shards/${shardKey}.json`, new Response(JSON.stringify({ version: version ?? null, rows }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (_) {
    // Cache Storage write failures (quota, private browsing) are silent —
    // see this section's own header.
  }
}

/** Fetches one shard's rows through S-05's same-origin proxy, checking the
    in-memory cache, then Cache Storage, before any network request. Returns
    `[]` on any miss/failure/offline (never throws, never null) so every
    caller can treat the result uniformly — S-05's own "absence is a real
    state" rule, same as every other pass in this file.

    ONLY A SUCCESSFUL FETCH IS MEMOIZED (review finding, 2026-09-15): a
    failed/degraded response used to be cached as `null` right alongside a
    real empty shard, so one transient failure (a cold-start 502, the
    pipeline's own "no release published yet" 404 before S-04a/b's
    SHARD_TOO_LARGE bug is fixed) permanently suppressed that shard for the
    rest of the session — every later keystroke landing on the same prefix
    would read the cached failure and never retry, unlike every other
    fetch-backed cache in this file (`showBreadthQueryCache`,
    `showDirectoryQueryCache` both key ONLY on `data`'s presence). A
    genuinely empty shard (the release exists and this prefix has no rows)
    is still memoized as `[]`, which is the correct "asked, got nothing"
    answer.

    A CACHE STORAGE HIT IS DISCARDED WHEN STALE (S-04c, FR-t_546eac9f-2):
    if this session has already seen a network response with a NEWER/
    DIFFERENT version tag than the Cache Storage entry carries
    (`lastSeenShardVersion`), the stored rows are treated as a miss and a
    fresh network fetch runs instead — the entry is then overwritten with
    the current version, self-healing on next read. A Cache Storage hit
    whose version is unknown-but-unconfronted (no network fetch has run
    yet this session to compare against) is trusted, matching the
    "Cache Storage survives a reload, checked before any network request"
    posture the rest of this section already documents — this is a
    staleness check against what THIS session has actually observed, not a
    guarantee no newer release exists anywhere. */
async function fetchShardRows(shardKey) {
  if (shardMemoryCache.has(shardKey)) return shardMemoryCache.get(shardKey);
  if (isOfflineForShardSearch()) return []; // D9: no request, not a failed one — and not memoized

  const cached = await readShardFromCacheStorage(shardKey);
  if (cached && (lastSeenShardVersion === null || cached.version === lastSeenShardVersion)) {
    shardMemoryCache.set(shardKey, cached.rows);
    return cached.rows;
  }

  /* Under the same deadline as fetchApiJson: a shard that never answers is a
     failed pass, so the search can say so and offer Try again. */
  const got = await withDeadline((async () => {
    try {
      const res = await fetch(apiUrl(`api/shows/index/shards/${encodeURIComponent(shardKey)}.json`), { cache: "no-cache" });
      if (res && res.ok) {
        return {
          data: await res.json(),
          version: res.headers && typeof res.headers.get === "function" ? res.headers.get("X-Shows-Index-Version") : null,
        };
      }
    } catch (_) { /* a failure is the null below */ }
    return { data: null, version: null };
  })(), API_DEADLINE_MS, () => ({ data: null, version: null }));
  const data = got.data;
  const version = got.version;
  if (version) lastSeenShardVersion = version;
  if (!Array.isArray(data)) return []; // failure/unavailable: not memoized, so a later search retries
  shardMemoryCache.set(shardKey, data);
  if (data.length) writeShardToCacheStorage(shardKey, data, version);
  return data;
}

/** Maps one shard row (`{ id, t, a, i, u, img, n, c }`,
    `tools/shows/shard-build.mjs:toShardRow`'s shape) to the show record
    shape every other search source already produces — the same fields
    `mapAppleShow` (`api/_lib/appleShowSearch.ts`) and the catalogue
    endpoint answer with, so `mergeShowRows`/`showResultRow`/`showById` need
    no shard-specific branch anywhere else in this file. `show_id` is
    `pi:<id>` — a PodcastIndex row id, deliberately namespaced so it can
    never collide with a curated `show_id` slug or an Apple `collectionId`
    string (both already live in this same id space via `breadthShowCache`)
    — matching `showById`'s own `pi:` branch and the new `#/show/pi:<n>`
    route. */
function mapShardRow(row) {
  return {
    show_id: `pi:${row.id}`,
    title: row.t || "",
    artwork_url: row.img || null,
    artist_name: row.a || null,
    editorial_note: null,
    taxonomy_node_ids: [],
    tier: row.c ? "curated" : "breadth",
    source: "shard",
  };
}

/* ---------- P-02: the DIRECTORY pass (docs/search-parity-plan.md) ----------

   Its own cache, bounded and cleared by the same FIFO-with-wholesale-clear
   rule as `showBreadthQueryCache` directly above. A SECOND map rather than a
   second field on the first, because the two passes answer at different times
   and either can fail alone: one shared entry would mean a directory failure
   poisoned the catalogue answer for that query, or a catalogue answer arriving
   first cached an entry the directory half would then never be allowed to fill.

   THE ONLY GATE LEFT ON THE DIRECTORY, and it is a LENGTH floor rather than
   anything about what the local pass found. Measured 2026-09-12 over 25
   listener queries (docs/search-parity-plan.md §2.1's own three among them):

     - Every one of the 25 gained rows from the directory after dedup:
       minimum +2, median +17, maximum +25. There is no query where the local
       pass was enough, so "ask when the local pass was thin" has nothing to
       key on.
     - An exact local match does not mean done. `radiolab` (1 exact local hit)
       gains 18, `crime junkie` (2 exact) gains 24, `99% invisible` (1 exact)
       gains 6 — and what arrives is the network and the spinoffs a listener is
       reaching for ("The 99% Invisible Breakdown", "Hard Fork Live").
     - STRONG-MATCH COUNT ANTI-CORRELATES WITH RELEVANCE at short lengths, so
       a threshold on it is worse than none. `tim` returns TEN strong local
       matches, all `prefix` (Timothy Keller Sermons, Timcast IRL, Tiny
       Matters...) and NOT ONE of them is The Tim Ferriss Show, which Apple
       returns at position 5. A threshold of 10 — the value already in this
       file as `SHOW_PREFIX_UNDERDELIVERS_BELOW` — would suppress the one show
       the listener meant, BECAUSE the local pass delivered plenty.
     - The "strong, not substring" distinction P-02 proposed as a first cut is
       INERT: across all 25 listener queries the local result contained ZERO
       `substring` matches. Substring hits only appear at 1-3 characters (`h`:
       97 of 450 rows), i.e. only at the lengths where you do not want to ask.

   Which leaves the length floor, and 3 is where it belongs: at 1-2 characters
   the local pass already returns 54-450 rows and Apple's answer is noise (`h`
   -> "Handsome", "Happier"), while at 3 the directory is already load-bearing
   (`tim`, `lex`). This is also the deck's own ">= 3 characters" line.

   WHAT THIS COSTS, because the card says to say it rather than assume it is
   free. Vercel -> Apple calls over that 25-query sample go from 2 to 25
   (12.5x). `appleShowBucket` is 20 calls / 60 s and — per its own header — PER
   WARM INSTANCE, not global, so this is not a cap and must not be reported as
   one; the honest statement is that one warm instance refuses past ~6-10
   active searches a minute and `api/shows/search.ts` now makes that refusal
   harmless (the catalogue rows still come back) and non-compounding (a short
   edge TTL instead of `no-store`). Client -> endpoint calls double, because
   this is a separate request; see `runShowSearchCostly` for why it is separate. */
const SHOW_DIRECTORY_MIN_QUERY_LENGTH = 3;
const showDirectoryQueryCache = new Map();

function showBreadthCacheKey(query) {
  return String(query || "").trim().toLowerCase();
}

/** P-02's dedup key for DIRECTORY rows. Lowercase, every run of
    non-letter/non-digit to one space, trim.

    MUST STAY CHARACTER FOR CHARACTER IDENTICAL to
    `api/_lib/appleShowSearch.ts:normaliseShowTitle`, and it is not left to
    discipline: `test/show-search-fallthrough.test.js` reads both files and
    compares the two expressions, the same way `test/show-search-ranking.test.js`
    pins the bucket table against `backend/src/catalog/searchBreadthShows.ts`.
    Unicode property escapes rather than `\W`, which is ASCII-only — "99%
    Invisible" and "伊藤洋一のRound Up World Now！" both have to normalise
    sensibly. */
/* FOLDED TOO (audit round 2, search-9): a precomposed "é" is \p{L}, so
   "Café X" and "Cafe X" never met as one show and an Apple copy of an index
   title rendered twice. NFKD, then the combining marks go, in both copies.
   NORMALISE FIRST, LOWERCASE LAST — foldDiacritics' order (search-engine.js;
   round-2 review): a compatibility letter such as mathematical-bold "𝐁" has no
   lowercase mapping, so lowercasing before NFKD left it an uppercase "B" and
   "𝐁𝟑𝟒𝐧’𝐬 …" never met the plain "B34n's …" from the other source. */
function normaliseShowTitle(title) {
  return String(title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/* P-02's dedup key was exact normalised EQUALITY, and the shape Apple actually
   varies is a SUBTITLE, which equality cannot see (adversarial review
   2026-09-12, defect 3).

   MEASURED ON THE COMMITTED CATALOGUE, not argued. Joining `data/catalog.json`
   to `data/catalog-breadth.json` by `apple_collection_id` gives 164 rows whose
   titles can be compared directly, because `catalog-breadth.json`'s title IS
   Apple's `collectionName`. FIVE of the 164 disagree, and every one of them
   is a suffix or a subtitle rather than a different name:

     The Twenty Minute VC (20VC)            | …(20VC): Venture Capital | Startup Funding | The Pitch
     The TWIML AI Podcast                   | …(formerly This Week in Machine Learning & …)
     omega tau                              | omega tau - English only
     Around the House with Eric G           | …with Eric G®: Upgrade Your Home Like a Pro
     Ask Lisa: The Psychology of Parenting  | Ask Lisa: The Psychology of Raising Tweens & Teens

   Under equality all five render twice: typing `twenty minute vc` puts the
   curated row and the Apple row side by side, one of them now wearing a byline.
   The STEM — the title cut at its first subtitle separator, then normalised —
   collapses all five, and equality collapses none of them.

   THE INVERSE COST IS REAL AND IS WRITTEN DOWN HERE rather than left for the
   next reviewer to rediscover, because it was documented nowhere before. Apple
   rows are title-deduped against catalogue rows, so ANY title rule silently
   suppresses a genuinely different show that shares the key — the exact
   "'The Daily' is not one show" case `mergeShowRows` invokes to justify the
   other half of the rule. Measured the same way, the 220 curated titles against
   all 19,787 breadth titles, counting only pairs whose `apple_collection_id`s
   differ: equality already suppresses 7. The stem suppresses 9. The two it adds
   are named, because they ARE the trade:

     Dan Carlin's Hardcore History  <>  Dan Carlin's Hardcore History: Addendum
     In The Dark                    <>  In The Dark (Bigfoot, Dogmen, Aliens, …)

   AND NO TITLE RULE CAN SEPARATE THOSE FROM THE FIVE ABOVE — "X: Addendum" and
   "omega tau - English only" are the same string shape. Five duplicates
   collapsed against two spin-offs suppressed is the measured trade, taken
   deliberately and reversible by reverting this function. The way OUT of the
   trade is not a cleverer string rule but an identity key: `catalog.json`
   carries `apple_collection_id` for every curated row and would dedup all five
   exactly, with nothing suppressed — but `data/catalog-client.json`, the cut
   the client actually holds, does not ship that field, and adding it is a
   data + `deploy-manifest.json` + byte-pinned-file change rather than this one.

   SEPARATORS ARE THE ONES THE DATA USES, AND NO MORE THAN THAT. A BARE HYPHEN
   IS NOT ONE: it needs surrounding spaces, or "Sword-and-Scale" loses
   everything after its first word. `(` and `[` need a leading space for the
   same reason. An empty stem is never a dedup key, exactly as an empty
   normalised title is never one.

   AND A PIPE IS NOT ONE EITHER, WHICH IS A MEASUREMENT AND NOT A STYLE CHOICE.
   `|` was in the first version of this set. On the committed catalogue it earns
   NOTHING — the same 5 of 5 collapse and the same 2 extra suppressions occur
   with it and without it, because all five real cases cut at `:`, ` - ` or
   ` (` first. Live it costs: with `|` in the set, `tim ferriss`, `sam harris`
   and `lex fridman` each lose exactly one row, and it is the same row every
   time — a derivative feed named `<the real show> | 5 minute podcast
   summaries`, whose stem becomes the real show's whole title. A pipe is a list
   separator, not a subtitle marker; `:`, ` - ` and ` (` are subtitle markers.
   Zero gain against three named losses is not a close call.

   MUST STAY CHARACTER FOR CHARACTER IDENTICAL to
   `api/_lib/appleShowSearch.ts:showTitleDedupStem`, pinned the same way
   `normaliseShowTitle` is — `test/show-search-fallthrough.test.js` reads both
   files and compares the expressions. */
const SHOW_TITLE_SUBTITLE_SEPARATOR = /\s[–—]\s|\s-\s|:|\s\(|\s\[/u;

function showTitleDedupStem(title) {
  const raw = String(title || "");
  const cut = raw.search(SHOW_TITLE_SUBTITLE_SEPARATOR);
  return normaliseShowTitle(cut > 0 ? raw.slice(0, cut) : raw);
}
/** BOTH KEYS, because the stem is an ADDITION to exact equality and not a
    replacement for it, and the committed catalogue says so in both directions.

    Replacing equality with the stem broke a pair equality had been collapsing
    correctly: `It's a Material World: Materials Science Podcast` (curated) and
    `It's a Material World | Materials Science Podcast` (Apple). Their full
    normalised titles are identical — the only difference is which separator the
    two publishers typed — but their stems are not, because one side cuts at
    `:` and the other has nothing to cut at. A rule that answers only on stems
    is therefore not a superset of the one it replaces.

    MEASURED WITH BOTH, over the 164 rows that join `data/catalog.json` to
    `data/catalog-breadth.json` by `apple_collection_id`: every one of the 164
    collapses (equality alone left 5 standing; the stem alone left this one).
    Over the 220 curated titles against all 19,787 breadth titles, pairs with
    different `apple_collection_id`s that collapse: 7 with equality alone, 10
    with both — and 8 of those 10 are the SAME show under a second Apple
    collection id, which is the thing this rule exists to collapse. The two that
    are genuinely different shows are named in `showTitleDedupStem` above; they
    are the whole cost of the change. */
function showDedupKeys(title) {
  const keys = [];
  for (const k of [normaliseShowTitle(title), showTitleDedupStem(title)]) {
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/* S-01's diagnostics call site (docs/search-plan.md, `player/diagnostic-log.js`'s
   `search` entry kind). ONE call per completed search. QUERY LENGTH, NEVER THE
   QUERY TEXT -- `diag.search`'s own guard would drop a string in `qLen` to
   null, but the discipline starts here: nothing downstream of this line ever
   holds the literal query. Guarded the same way `forayNoteTapFailure` is
   guarded (`player/client.js`): a record that will not write, or does not
   exist yet on an older bundle, must not break the search it is measuring. */
function recordSearchDiagnostic(fields) {
  try {
    if (typeof window.forayRecordSearch === "function") window.forayRecordSearch(fields);
  } catch (_) {
    // A diagnostics write failing is not a reason to break search.
  }
}

/** Back to the unfiltered A-Z list — NOT to an empty results box with a "no
    shows match" note for a query the listener just deleted (S-02's own
    acceptance line). Since 2026-09-13 that list is itself hidden while the
    search field holds focus (see updateShowBrowseVisibility), so on a
    deleted query this clears the answer and the browse furniture returns on
    blur; the two are deliberately separate, and this function does not
    unhide anything on its own. */
function clearShowSearchResults() {
  // Nothing is painted any more, so no later pass may merge onto what was.
  showSearchPainted = { token: -1, query: "", rows: [] };
  const note = $("#sh-note");
  const results = $("#sh-results");
  const eps = $("#ep-search-results");
  const pls = $("#pl-search-results");
  if (results) { results.innerHTML = ""; results.hidden = true; }
  if (note) { note.textContent = ""; note.hidden = true; }
  if (eps) { eps.innerHTML = ""; eps.hidden = true; }
  if (pls) { pls.innerHTML = ""; pls.hidden = true; }
  paintShowSearchEmptyOffer(null);
  for (const id of ["#sh-partial-note", "#fy-search-results"]) {
    const el = $(id);
    if (el) { el.innerHTML = ""; el.hidden = true; }
  }
  /* The offline note explains a search. With the search gone it explained
     nothing, and stayed up after the connection came back (qa row 103). */
  const offline = $("#sh-offline-note");
  if (offline) offline.hidden = true;
}

/* WHICH SEARCH HAS HEARD FROM EVERY PASS THAT COULD ADD A SHOW (audit
   2026-09-22, theme G). `token` is the showSearchToken whose catalogue,
   directory and shard passes have all settled; `failed` is whether any of them
   failed rather than answered. Until the current token is recorded here, an
   empty list is "still searching", never "nothing found" — the old paint said
   `No results for "huberman".` on the keystroke, for the ~250 ms debounce plus
   118-561 ms of round trip, and then ten results arrived under it. */
let showSearchSettled = { token: -1 };

/* WHICH HALF OF THE CURRENT SEARCH FAILED (audit round 2, states-7). Round 1's
   settled-search rule painted "Part of this search didn't load" through the
   EMPTY branch of `paintShowResults` only — so a dead breadth pass or a dead
   episode endpoint failed silently whenever the local pass found anything, and
   the episode pass never reported a failure at all; on Wi-Fi with no internet
   the Episodes section simply never appeared under a few curated rows and the
   listener concluded 4a had no episodes for the query. One record per token,
   reset by the keystroke that starts a search, written by the show passes when
   they settle and by the episode pass when it answers, painted by
   `paintShowSearchPartialNote` regardless of how many rows are on the page. */
let showSearchFailure = { token: -1, shows: false, episodes: false };

function noteShowSearchFailure(query, myToken, half) {
  if (myToken !== showSearchToken) return;
  if (showSearchFailure.token !== myToken) showSearchFailure = { token: myToken, shows: false, episodes: false };
  showSearchFailure[half] = true;
  paintShowSearchPartialNote(query, myToken);
}

/** THE ONE PLACE THE FAILURE LINE LIVES. Above the rows, below `#sh-note`, so
    it reads the same over a full list and over an empty one; "Try again" is the
    same search from the top. Not painted offline: there the offline note (or
    the empty note) already says why the network passes did not answer, and a
    retry with no connection is a button that does nothing (search-12). */
function paintShowSearchPartialNote(query, myToken) {
  const box = $("#sh-partial-note");
  if (!box) return;
  if (myToken !== showSearchToken) return;
  const failed = showSearchFailure.token === myToken && (showSearchFailure.shows || showSearchFailure.episodes);
  if (!failed || isOfflineForShardSearch()) { box.innerHTML = ""; box.hidden = true; return; }
  box.innerHTML = failedNoteHtml("Part of this search didn't load.");
  box.hidden = false;
  /* The plain submit path: a search with a recorded failure is not "current"
     to `isShowSearchCurrent`, so this runs it again from the top. */
  bindRetry(box, () => { if (myToken === showSearchToken) renderShowSearchResults(query); });
}

/** Paints one set of show rows into `#sh-results`, or the honest empty state.
    Token-guarded so a slow costly pass cannot repaint over a newer query.

    S-05/D9: `#sh-offline-note` is shown whenever the runtime reports offline
    AND there are rows for it to explain — the local/curated pass still answers
    instantly offline, and the note says what those rows are (names 4a already
    knows, no episodes). An EMPTY offline search says "You're offline" in
    `#sh-note` itself, as one line: it used to stack "No shows found", "Showing
    shows available offline" and "Part of this search didn't load" over an empty
    list, each true, together contradictory (audit round 2, search-12). */
function paintShowResults(query, shows, myToken) {
  if (myToken !== showSearchToken) return; // a newer query already superseded this one
  const note = $("#sh-note");
  const results = $("#sh-results");
  const offlineNote = $("#sh-offline-note");
  if (!note || !results) return;
  const offline = isOfflineForShardSearch();
  if (offlineNote) offlineNote.hidden = !(offline && shows.length > 0);
  /* Recorded whether or not there is anything to draw, and BEFORE the empty
     branch returns: "nothing matched" is a painted answer like any other, and a
     later merge has to append to it rather than to whatever the last non-empty
     query left behind (defect 5). */
  showSearchPainted = { token: myToken, query, rows: shows };
  if (!shows.length) {
    results.innerHTML = "";
    results.hidden = true;
    /* NOTHING IS "NOT FOUND" UNTIL EVERY PASS HAS ANSWERED (audit 2026-09-22).
       The keystroke pass is local; the three passes that reach past the
       curated 220 are still owed, so an empty local answer is a SEARCHING
       state, and says so. `runShowSearchCostly` repaints through here once
       the last of them settles, and only then can the list be empty for real.

       SCOPED TO SHOWS. The note sits above the Episodes and Playlists
       sections, which answer on their own schedule; an unqualified "No
       results" printed directly above a full Episodes list denied the rows
       beneath it. It names what it searched.

       "…in 4a's catalogue" until 2026-09-14. The founder's standing
       instruction is "don't blame it on 4a", and that trailing clause was
       doing exactly that; a search that found nothing says so, and nothing
       about whose catalogue fell short. */
    const settled = showSearchSettled.token === myToken;
    note.textContent = !settled ? `Searching for ${quoteQuery(query)}…`
      : offline ? `You're offline — no shows found for ${quoteQuery(query)}.`
      : `No shows found for ${quoteQuery(query)}.`;
    note.hidden = false;
    paintShowSearchEmptyOffer(settled ? { query } : null);
    return;
  }
  note.hidden = true;
  paintShowSearchEmptyOffer(null);
  /* A PAGE OF ROWS AT A TIME (app-2-2). The cap belongs to this token and
     query, so a later pass appending beneath keeps whatever the listener
     already revealed, and a new query starts from one step again. The painted
     record above stays the whole list, so dedupe and upgrade still see every
     row. */
  if (showSearchPaintCap.token !== myToken || showSearchPaintCap.query !== query) {
    showSearchPaintCap = { token: myToken, query, n: SHOW_RESULTS_PAINT_STEP };
  }
  const cap = showSearchPaintCap.n;
  const more = shows.length - cap;
  results.innerHTML = shows.slice(0, cap).map(showResultRow).join("")
    + (more > 0 ? `<button type="button" class="fy-script-more" data-sh-more>Show more shows</button>` : "");
  results.hidden = false;
  const moreBtn = more > 0 && typeof results.querySelector === "function" ? results.querySelector("[data-sh-more]") : null;
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      if (myToken !== showSearchToken) return;
      showSearchPaintCap = { token: myToken, query, n: cap + SHOW_RESULTS_PAINT_STEP };
      paintShowResults(query, showSearchPainted.rows, myToken);
    });
  }
}

/** How many of the current query's rows are painted (app-2-2). */
let showSearchPaintCap = { token: -1, query: "", n: SHOW_RESULTS_PAINT_STEP };

/* THE ROW CACHES ARE BOUNDED TOO (app-2-2). `showById` resolves a tapped
   directory or shard row from these, so they must hold what is on screen — and
   they held every row every query had ever received, for the session. Oldest
   first out past SHOW_ROW_CACHE_MAX; a query hands over at most a few hundred,
   so the rows of the list on screen are always inside the bound. The order is
   kept apart from the object because an Apple id is an integer-like key, and
   an object lists those numerically, not by insertion. */
const SHOW_ROW_CACHE_MAX = 1000;
const showRowCacheOrder = { breadth: new Set(), shard: new Set() };
function cacheShowRow(kind, row) {
  if (!row || !row.show_id) return;
  const map = kind === "shard" ? state.shardShowCache : state.breadthShowCache;
  const order = showRowCacheOrder[kind];
  map[row.show_id] = row;
  order.delete(row.show_id);
  order.add(row.show_id);
  while (order.size > SHOW_ROW_CACHE_MAX) {
    const oldest = order.values().next().value;
    order.delete(oldest);
    delete map[oldest];
  }
}

/** WHAT A SETTLED, EMPTY SHOWS SEARCH OFFERS INSTEAD OF A DEAD END (audit
    2026-09-22, the unconditional half of the browse-pill finding): a QUERY
    THAT IS A SUBJECT'S OWN NAME (a browse pill lands here with its label) gets
    that subject's narrower categories that DO hold shows, as chips. The pill
    stays an ordinary search for its own text (founder, #684); this is only
    what the empty answer offers next, and every chip leads to a page with at
    least one show on it.

    The "a pass that failed says so, with Try again" half that used to live
    here moved to `paintShowSearchPartialNote`, which paints it over a full list
    as well as an empty one (states-7).

    `null` clears it — every non-empty paint and every cleared query. */
function paintShowSearchEmptyOffer(opts) {
  const box = $("#sh-empty-offer");
  if (!box) return;
  if (!opts) { box.innerHTML = ""; box.hidden = true; return; }
  const { query } = opts;
  const parts = [];
  const wanted = String(query || "").trim().toLowerCase();
  const node = (state.taxonomy?.nodes || []).find(n => String(n.label || "").toLowerCase() === wanted);
  if (node) {
    const within = (state.taxonomy?.nodes || [])
      .filter(n => (n.id === node.id || String(n.id).startsWith(`${node.id}/`)) && showsForCategory(n.id).length > 0)
      .slice(0, 8);
    if (within.length) {
      parts.push(`<p class="note">Shows filed under ${esc(node.label)}:</p>
        <div class="fy-chips">${within.map(n => taxonomyChip(n.id)).join("")}</div>`);
    }
  }
  box.innerHTML = parts.join("");
  box.hidden = parts.length === 0;
}

/** The rows on screen for `query` under `myToken`, or `fallback` when the
    record belongs to some other query or token. Every merge starts here rather
    than from a variable it captured earlier, so passes that complete out of
    order cannot undo each other (defect 5). */
function paintedShowRows(query, myToken, fallback) {
  return (showSearchPainted.token === myToken && showSearchPainted.query === query)
    ? showSearchPainted.rows
    : fallback;
}

/** THE ONE MERGE RULE, named once because four callers share it: the index's
    scan pass, the catalogue pass, the directory pass, and the index landing
    mid-query. Returns the rows to put BENEATH `existing`, ranked among
    themselves, or null when nothing was added so a caller can skip a repaint.

    IT NO LONGER RE-RANKS `existing`, AND THAT IS THE FIX FOR THE SECOND HALF
    OF #684 (founder: "the page jumps around a lot within a second or so").
    This used to return `SearchEngine.rankShows(query, existing.concat(
    additions))` — a fresh sort of the WHOLE list every time a pass landed.
    Measured in a real Chromium at 390x844 against the shipped page, with the
    two endpoints held at their reported live latencies (test/playwright/
    tests/search-result-stability.spec.js is that measurement, kept):

      t=107 ms   the local pass paints 20 rows.
      t=882 ms   the catalogue pass merges 10 more. The list re-sorts.
      t=1692 ms  the directory pass merges 12 more, and they land at INDEX 2 —
                 every row from the third down moves 74 px per inserted row,
                 222 px in that sample, a second and a half after the listener
                 started reading them.

    So the complaint is not that the list grows. It is that it grows in the
    middle. Ranking additions among themselves and appending them means the
    list only ever grows DOWNWARD: a row that has been painted keeps its
    position for the life of the query, and the only thing a later pass can do
    is add more underneath.

    WHAT THIS COSTS, said plainly: a directory row that outranks everything
    local no longer jumps to the top — it sits below the local answer, in
    order, with the rest of its own pass. That is a real ranking concession and
    it is the intended trade. The passes arrive best-source-first already
    (curated local, then the catalogue endpoint, then Apple's directory), so
    the append order is close to the rank order anyway; and a list that
    reshuffles under a thumb is worth less than a slightly worse order that
    holds still.

    DEDUP IS BY `show_id` FOR EVERYTHING and additionally by title STEM for
    APPLE ROWS ONLY (`source === "apple"`, stamped by `mapAppleShow`).

    WHY BY TITLE AT ALL, when `show_id` for an Apple row already IS its
    `apple_collection_id`: Apple returns the same show under several collection
    ids. Measured 2026-09-12, `lex fridman` -> THREE distinct ids all titled
    "Lex Fridman Podcast". An id-only dedup shows the listener all three, so the
    title half is the half doing the work there, not belt-and-braces.

    WHY NOT TO CATALOGUE ROWS. Two genuinely different shows can share a title
    ("The Daily" is not one show), and a catalogue row carries artwork, a chart
    rank and an editorial note that a title collision would throw away. The
    endpoint is authoritative about its own rows; it is only the directory's
    answer that needs collapsing. Both sides apply the same rule to the same
    rows — `api/shows/search.ts` merges Apple beneath the catalogue server-side,
    and this merges whatever arrives beneath what is already painted. */
/** A "directory-sourced" row is one reached through Apple's breadth
    directory or the PodcastIndex shard index — the two sources whose
    `show_id` lives in a namespace (`collectionId` / `pi:<id>`) that
    cannot collide with a curated/catalogue `show_id`, so `mergeShowRows`'s
    `ids.has` check can never catch "the same show, reached through two
    sources" for them and a title-based check is the only defense. An
    untagged row (local index / catalogue / directory-of-catalogue passes
    that don't set `source`) has no such id-collision problem against
    OTHER untagged rows — that's the deliberate "'The Daily' is not one
    show" carve-out `mergeShowRows` has always preserved for pure
    catalogue-vs-catalogue collisions, and this function must not weaken
    it. */
function isDirectorySourcedShow(s) {
  return s.source === "apple" || s.source === "shard";
}

/** Direction-agnostic title dedup across all 4 show-search sources
    (local/index, catalogue, directory/Apple, shard).

    kanban t_5e674545 (Fable ruling FR-t_546eac9f-2): before this, a NEW
    row was checked against titles collected from EARLIER-arriving rows,
    but only in one direction, and only for directory-sourced incoming
    rows. If a directory-sourced row (Apple or shard) painted BEFORE the
    catalogue/local row for the same title arrived, the later untagged
    row carried no `source` flag requiring a title check and was never
    checked against the earlier row's title keys — it could duplicate on
    screen. Fixed by tracking two key sets:

      - `titleKeys`: every accepted row's title keys, any source. A
        directory-sourced incoming row is checked against this set
        (unchanged from before — this is the direction that already
        worked).
      - `directoryTitleKeys`: only directory-sourced accepted rows'
        title keys. An untagged incoming row is checked against THIS
        set (the fix — makes the untagged-arrives-second case symmetric
        with the already-working directory-arrives-second case).

    An untagged row is never checked against another untagged row's
    keys — `directoryTitleKeys` only ever gains entries from
    directory-sourced rows — which is exactly the existing "two
    genuinely different shows can share a title" carve-out: pure
    catalogue-vs-catalogue collisions are still governed by `show_id`
    alone, per `ids.has` above. */
function mergeShowRows(query, existing, incoming) {
  const ids = new Set(existing.map((s) => s.show_id));
  const titleKeys = new Set();
  const directoryTitleKeys = new Set();
  for (const s of existing) {
    const keys = showDedupKeys(s.title);
    for (const k of keys) titleKeys.add(k);
    if (isDirectorySourcedShow(s)) for (const k of keys) directoryTitleKeys.add(k);
  }
  const additions = [];
  for (const s of incoming) {
    if (ids.has(s.show_id)) continue;
    const keys = showDedupKeys(s.title);
    const directorySourced = isDirectorySourcedShow(s);
    const collides = directorySourced
      ? keys.some((k) => titleKeys.has(k))
      : keys.some((k) => directoryTitleKeys.has(k));
    if (collides) continue;
    ids.add(s.show_id);
    for (const k of keys) titleKeys.add(k);
    if (directorySourced) for (const k of keys) directoryTitleKeys.add(k);
    additions.push(s);
  }
  if (!additions.length) return null;
  return SearchEngine.rankShows(query, additions);
}

/** THE OTHER HALF OF THE MERGE (audit round 2, search-1): a row `mergeShowRows`
    would DROP as already painted — the same id, or the same title where either
    side is directory-sourced (its own collision rule, restated) — may still
    know something the painted row does not. The index carries titles only, so
    its rows paint with no artwork and no byline; the catalogue, directory and
    shard passes bring both for the same shows a moment later. Returns a new
    row list with those fields filled in, in the SAME order and with the same
    identities (id, title, href), or null when nothing was learned. Only fields
    the painted row LACKS are taken: a curated row's own artwork is never
    replaced by Apple's copy of it. */
function upgradeShowRows(existing, incoming) {
  if (!existing.length || !incoming.length) return null;
  const byId = new Map();
  const byDirectoryKey = new Map();
  for (const s of incoming) {
    if (!s || !s.show_id) continue;
    if (!byId.has(s.show_id)) byId.set(s.show_id, s);
    if (isDirectorySourcedShow(s)) {
      for (const k of showDedupKeys(s.title)) if (!byDirectoryKey.has(k)) byDirectoryKey.set(k, s);
    }
  }
  let learned = false;
  const out = existing.map((row) => {
    let richer = byId.get(row.show_id) || null;
    if (!richer) {
      const keys = showDedupKeys(row.title);
      if (isDirectorySourcedShow(row)) {
        richer = incoming.find((s) => s && s !== row && keys.some((k) => showDedupKeys(s.title).includes(k))) || null;
      } else {
        richer = keys.map((k) => byDirectoryKey.get(k)).find(Boolean) || null;
      }
    }
    if (!richer) return row;
    const patch = {};
    if (!row.artwork_url && richer.artwork_url) patch.artwork_url = richer.artwork_url;
    if (!(typeof row.artist_name === "string" && row.artist_name.trim()) && typeof richer.artist_name === "string" && richer.artist_name.trim()) {
      patch.artist_name = richer.artist_name;
    }
    if (!Object.keys(patch).length) return row;
    learned = true;
    return { ...row, ...patch };
  });
  return learned ? out : null;
}

/** Puts `additions` beneath whatever is already painted for `query` under
    `myToken`, and repaints. The one call site shape every merging pass now
    uses, so none of them can accidentally reorder the list by hand.

    `paintShowResults` still writes `#sh-results.innerHTML` wholesale rather
    than inserting at the end, and deliberately: the leading rows of the new
    string are byte-identical to the ones already there, so their geometry is
    unchanged and nothing above the insertion point moves — which is the
    property that was actually broken. A DOM-level append would additionally
    keep the existing nodes alive, but it would also need `insertAdjacentHTML`
    taught to the ~30 node:vm element stubs in `test/`, and a second painting
    path guarded by a `typeof` check is the "fallback nobody exercises" shape
    this repo keeps deleting. One path. */
function appendShowResults(query, additions, myToken) {
  const existing = paintedShowRows(query, myToken, null);
  paintShowResults(query, existing ? existing.concat(additions) : additions, myToken);
}

/** THE KEYSTROKE PATH. Local only: no fetch, no playlist CTA, nothing deferred.
    Returns what it painted plus its own timings, which the costly pass folds
    into the one diagnostics record.

    P-05 PUT THE EPISODE TIER ON THIS TICK, and the sentence above changed from
    "no episode search" because of it. What runs here is `localEpisodeMatches` —
    a substring scan over `cp_saved` + `cp_queue`, tens of entries, no fetch and
    nothing deferred — NOT the endpoint, which stays behind the 250 ms debounce
    in `runShowSearchCostly` exactly where #662 put it. `localMs`/`paintedMs`
    cover both local passes because both are this one paint; the endpoint half
    keeps its own `epMs`. */
function paintShowSearchLocal(query, myToken) {
  const localStart = nowMs();
  /* A fresh search starts with nothing failed: the record and its line belong
     to the token that is about to paint. */
  showSearchFailure = { token: myToken, shows: false, episodes: false };
  paintShowSearchPartialNote(query, myToken);
  paintForaySearchResults(query, myToken);
  const localShows = localShowMatches(query);
  const localMs = nowMs() - localStart;
  paintShowResults(query, localShows, myToken);
  const localEpisodes = paintLocalEpisodeSearch(query, myToken);
  return { localShows, localEpisodes, localMs, paintedMs: nowMs() - localStart };
}

/* WAITING FOR THE LISTENER TO STOP, NOT FOR A FREE FRAME (round-2 audit,
   perf-3). Vocabulary priming is one synchronous pass measured at 0.2-2.7 s on
   a laptop, and the native shell has no `requestIdleCallback`, so `whenIdle`
   fell back to a 0 ms timer and ran it on the next task after the search
   documents landed — seconds into a cold launch, exactly when the listener
   starts tapping. Its own comment said it must not compete with a tap in the
   first second; that is a condition on the LISTENER, so it is measured on
   them: `whenQuiet` waits until nothing has been touched, typed or scrolled
   for `PRIME_QUIET_MS`, then hands the work to `whenIdle`. A query typed
   before then warms the same ctx itself, so nothing is lost by waiting. */
let lastInteractionAt = 0;
let PRIME_QUIET_MS = 1500;

function noteInteraction() { lastInteractionAt = Date.now(); }

/** Run `fn` once the listener has been still for `quietMs`, then when idle. */
function whenQuiet(fn, quietMs = PRIME_QUIET_MS) {
  const check = () => {
    const wait = lastInteractionAt + quietMs - Date.now();
    if (wait > 0) { setTimeout(check, wait); return; }
    whenIdle(fn, 2000);
  };
  setTimeout(check, quietMs);
}

/** Run `fn` when the main thread is actually free, with a deadline.
 *
 *  `init()` has scheduled its vocabulary priming this way since the H bug
 *  (kanban t_838a13c0); this is that idiom named once so the search tick can
 *  use it too. `setTimeout(fn, 0)` is NOT the same thing and the difference is
 *  the whole of finding 2 (client audit 2026-09-12): a zero timeout buys ONE
 *  paint turn and then runs on the very next task, so CPU-bound work behind it
 *  still lands on top of whatever the listener does next. `requestIdleCallback`
 *  waits for a frame with time left in it, and the `timeout` is the promise
 *  that a permanently busy thread does not mean "never".
 *
 *  Falls back to the 0 ms timeout where `requestIdleCallback` is absent —
 *  older WebKit, the native shell, and every node:vm harness in `test/`. */
function whenIdle(fn, timeoutMs = 2000) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: timeoutMs });
  else setTimeout(fn, 0);
}

/* THE COST FLOOR ON THE INDEX SCAN (defect 1, 2026-09-13). Derived from a
   measurement, not chosen: see the long note at the call site in
   `runShowSearchCostly` for the table it comes from and for why a floor on
   query LENGTH is the right shape of gate where a floor on LOCAL HIT COUNT was
   not. Kept separate from `SHOW_DIRECTORY_MIN_QUERY_LENGTH` even though both
   are 3 today — one bounds a local CPU cost, the other bounds calls to Apple,
   and tying them would make either number impossible to move on its evidence. */
const SHOW_SCAN_MIN_QUERY_LENGTH = 3;

/** THE DEBOUNCE TICK. Everything §1.5 measured as expensive, in one place:
    the index's linear scan (only on searches long enough to pay for it), the
    breadth endpoint (only on a hot-cache miss), the episode endpoint (only on
    ITS hot-cache miss), and the playlist section whose CTA schedules a 1.3-8 s
    relaxation scan.

    ONE DIAGNOSTICS RECORD PER COMPLETED SEARCH, AND A SEARCH IS NOT COMPLETE
    UNTIL EVERY SLOW HALF HAS ANSWERED (finding 2, client audit 2026-09-12).
    The record used to be written the moment the SHOWS half landed, which is
    why two multi-second passes could sit on this tick with nothing measuring
    them: `painted_ms` was stamped from the local pass alone, the episode
    endpoint — the slower of the two — was not in the record at all, and the
    CTA's relaxation scan ran after the record was already on disk. Three
    halves now report into one entry through `settle` below, which fires when
    the last of them is in. `recordSearchDiagnostic`'s "exactly one call per
    search" contract (test/search-probe-record.test.js) is unchanged: this
    makes the one call later, not twice. */
function runShowSearchCostly(query, myToken, local) {
  /* NOT a captured snapshot: `paintedShowRows` re-reads what is actually on the
     page every time, so the show index landing between two of these passes is
     not undone by whichever one completes next (defect 5). */
  const shown = () => paintedShowRows(query, myToken, local.localShows);

  const record = {
    qLen: query.length,
    localMs: local.localMs,
    localHits: local.localShows.length,
    paintedMs: local.paintedMs,
    netMs: null, netHits: null,
    dirMs: null, dirHits: null,
    epMs: null, epHits: null,
    ctaMs: null,
    shardMs: null, shardHits: null,
    path: null,
  };
  /* Three halves owed, plus S-05's shard pass; `settle` is called exactly
     once by each, on EVERY exit path including the early returns — a half
     that decided not to run still has to say so, or the record never fires
     at all and a superseded search goes unrecorded. A fetch that never
     settles is the one case with no record, which was already true of the
     breadth half alone: `fetchApiJson` swallows errors to `null` but cannot
     invent an answer for a socket that simply hangs. */
  let owed = 5;
  /* The render that asked, so a search settling after the listener left the
     page does not report a paint of some other page (see pageDidPaint below). */
  const onScreen = renderToken();
  const settle = (patch) => {
    Object.assign(record, patch);
    if (--owed !== 0) return;
    recordSearchDiagnostic(record);
    /* THE SEARCH PAGE'S TERMINAL PAINT (audit round 2, nav-3): every pass has
       answered, so the page is as tall as this query will make it. A ‹ back to
       the results whose scroll restore was clamped by the first, shorter paint
       re-applies it here, as the show and Foray pages do from theirs. */
    if (onScreen()) pageDidPaint();
  };

  /* THE THREE PASSES THAT CAN ADD A SHOW — catalogue, directory, shard — and
     the moment the last of them has answered (audit 2026-09-22, theme G). This
     is a separate count from `owed` because the episode and playlist halves
     cannot change whether any SHOW was found, and "no shows" must not wait on
     them. Each pass reports exactly once, on every exit path, whether it
     answered or failed; a pass that decided not to run answered "nothing to
     add". When the count reaches zero this token is recorded as settled, and
     an empty list is repainted as the real "No shows found" it now is. */
  let showPassesOwed = 3;
  let showPassFailed = false;
  const showPassDone = (failed) => {
    if (failed) showPassFailed = true;
    if (--showPassesOwed > 0) return;
    if (myToken !== showSearchToken) return; // superseded: the newer query owns the note
    showSearchSettled = { token: myToken };
    /* Reported whether or not the list is empty (states-7): the line that says
       a pass failed sits above the rows, not only in their absence. */
    if (showPassFailed) noteShowSearchFailure(query, myToken, "shows");
    const rows = paintedShowRows(query, myToken, local.localShows);
    if (!rows.length) paintShowResults(query, rows, myToken);
  };

  /* THE SCAN PASS, GATED ON COST RATHER THAN ON HOW MANY ROWS THE DEVICE
     ALREADY PAINTED, and that swap is the whole of defect 1 (2026-09-13).

     WHAT THE OLD GATE WAS AND WHY IT STOPPED BEING TRUE. It read
     `shown().length < SHOW_PREFIX_UNDERDELIVERS_BELOW` — skip the scan once
     the prefix pass has filled the list — and that was sound while the
     comparator read the BUCKET first, because then a word-start row could
     never outrank the prefix rows already on screen and scanning for it bought
     nothing but latency. P-08 (docs/search-parity-plan.md) interposed a MATCH
     TIER above the bucket precisely so a popular word-start row CAN lead a
     wall of prefix rows; this gate was not revisited, so the pass that FINDS
     those rows is still switched off exactly when there are prefix rows for
     them to beat.

     THE MEASURED CONSEQUENCE, over the committed data/show-index.tsv and
     data/catalog-client.json (2026-09-13): `daily` returns 25 local rows from
     curated + prefix, the scan is skipped, and THE DAILY — `chart_rank` 1,
     `show_id` 1200361736, a row the device is physically holding — is ABSENT
     from the client's answer. With the scan it is 17 of 218. This is a REACH
     gap, not the ranking gap P-09/P-10 describe: P-10 explains the 17, it does
     not explain the absence. `history`, `american`, `money` and `science` also
     skip the scan and lose 82, 20, 32 and 86 rows respectively (their own
     intended shows were already curated, so those four lose breadth rather
     than the named show — the audit expected absence there and the measurement
     says otherwise). Off-network, or in the ~250 ms + RTT window before the
     endpoint lands, none of it is reachable.

     WHY A LENGTH FLOOR IS THE COST GATE, and why 3. The scan's cost tracks its
     HIT COUNT (it allocates a record per hit and sorts them), not the index
     size, so the cheap thing to test before paying it is the only proxy
     available without scanning: query length. Measured on the committed index
     (2026-09-13, desktop node, 15 reps per query with a forced GC between
     them, worst case taken over the highest-hit 1..6-character substrings of
     real titles, which is the adversarial population, not a friendly battery):

       floor      worst scan median   worst p95   worst query
       no gate    331 ms              473 ms      `l`   (5,332 hits)
       >= 2       220 ms              917 ms      `e `  (8,517 hits)
       >= 3       139 ms              319 ms      `dcast ` (2,477 hits)

     The bar was "stay under `l`'s ~500 ms", and >= 3 is the only floor that
     clears it on BOTH statistics. It also costs nothing in reach: every query
     in the measured defect is five characters or more, and at one or two
     characters the local pass already returns 404-938 rows, so there is no
     named show to be absent from — the same argument
     `SHOW_DIRECTORY_MIN_QUERY_LENGTH` makes two hundred lines up, reached
     independently and landing on the same number.

     WHAT THIS COSTS, because deleting a gate must not be reported as free. The
     old gate and the cost were ANTI-correlated — the queries with plenty of
     local rows are the same queries with thousands of scan hits — so today the
     app almost never pays a big scan (worst actually reached over the same
     population: 18 ms median). After this, a >= 3-character search pays up to
     139 ms median on the DEBOUNCE TICK. It is not on a keystroke, the local
     rows are already painted before it runs, and `mergeShowRows` only
     repaints when the scan added something.

     `SHOW_PREFIX_UNDERDELIVERS_BELOW` is deliberately left declared: it is
     cited by name as a counterexample both above (the directory gate) and in
     test/show-search-fallthrough.test.js, whose `tim` case already argues that
     a count of local hits is the wrong gate for a pass like this one. That
     argument was always about this constant; it simply had not been applied
     here.

     `scanShowIndex` returns word-start and substring hits only, so there is
     nothing here to dedupe against the prefix answer beyond the curated rows. */
  if (showIndex && query.trim().length >= SHOW_SCAN_MIN_QUERY_LENGTH) {
    const scanned = SearchEngine.scanShowIndex(query, showIndex, SHOW_PASS_LIMIT);
    const additions = mergeShowRows(query, shown(), scanned);
    if (additions) appendShowResults(query, additions, myToken);
  }

  /* The dedup rule itself now lives in `mergeShowRows`, shared with the index
     repaint so the two cannot drift. What stays here is the side effect that is
     specific to an ENDPOINT answer: seeding `state.breadthShowCache` so
     `showById` can resolve a row once it is tapped, and so a richer record
     (artwork, editorial note) replaces the index's title-only row. It runs for
     every row received, including the ones the dedup then drops. */
  const mergeBreadth = (breadthShows) => {
    for (const s of breadthShows) cacheShowRow("breadth", s);
    /* THE PAINTED ROW IS UPGRADED, NOT ONLY THE CACHE (audit round 2,
       search-1). The comment above promised that a richer record "replaces
       the index's title-only row", and it did — in the cache `showById` reads
       on tap, never on the page. So the index's prefix hits, the strongest
       matches and the top of the list, stayed blank grey squares for the life
       of the query while weaker rows beneath them arrived with artwork. Same
       row, same index, same href: only the art and the byline change, so
       #684's "a painted row keeps its position" holds. */
    const upgraded = upgradeShowRows(shown(), breadthShows);
    if (upgraded) paintShowResults(query, upgraded, myToken);
    const additions = mergeShowRows(query, shown(), breadthShows);
    if (additions) appendShowResults(query, additions, myToken);
  };

  const cacheKey = showBreadthCacheKey(query);
  const cached = showBreadthQueryCache.get(cacheKey);
  if (cached) {
    mergeBreadth(cached);
    settle({
      netMs: 0, netHits: cached.length,
      path: myToken !== showSearchToken ? "superseded" : "local+cache",
    });
    showPassDone(false);
  } else {
    /* THE CATALOGUE PASS, and it no longer carries `&fallthrough=1` under any
       condition — P-02 moved that to its own request below. This one exists to
       be FAST: measured 118 ms median against the live endpoint, versus
       381-561 ms on the two requests that actually performed a fall-through.
       Folding the directory into this request would have delayed the
       `chart_rank` 101-200 rows — the tier only this endpoint has — by 3-5x on
       every search, to no benefit, since nothing about the catalogue answer
       depends on Apple's. */
    const netStart = nowMs();
    fetchApiJson(`api/shows/search?q=${encodeURIComponent(query)}&limit=25`).then((data) => {
      const netMs = nowMs() - netStart;
      const superseded = myToken !== showSearchToken;
      const breadthShows = data?.shows || [];
      /* THE SAME TEST THE DIRECTORY PASS APPLIES BELOW (audit round 2,
         search-4 — an incomplete fix of the 2026-09-12 defect 2, which was
         applied to the sibling request in this function and not to this one).
         `api/shows/search.ts` answers an unreadable breadth catalogue with 200,
         `shows: []`, `degraded: true`; that was cached here as THE answer for
         the session and reported as a pass that answered, so a cold-start
         failure left "No shows found" with no Try again for every retype of
         that query. A degraded reply is not an answer: not cached, and
         reported as the failure it is. */
      const answered = !!data && !data.degraded;
      if (answered) {
        if (showBreadthQueryCache.size >= SHOW_BREADTH_CACHE_MAX) showBreadthQueryCache.clear();
        showBreadthQueryCache.set(cacheKey, breadthShows);
      }
      if (!superseded && breadthShows.length) mergeBreadth(breadthShows);
      settle({
        netMs, netHits: answered ? breadthShows.length : null,
        path: superseded ? "superseded" : answered ? "local+net" : "local-only",
      });
      showPassDone(!answered);
    }); // fetchApiJson already swallows network/parse errors and resolves null — no .catch needed
  }

  /* ---------- P-02: THE DIRECTORY PASS, a THIRD pass and a SECOND request ----------

     The order a listener experiences is local (0.28 ms median, already
     painted before this function ran) -> catalogue (118 ms) -> directory
     (381-561 ms). All three merge into one growing list; none of them waits
     for a later one.

     WHY A SEPARATE REQUEST rather than `&fallthrough=1` on the pass above.
     `api/shows/search.ts` awaits Apple before replying, so one merged request
     would move the catalogue rows from 118 ms to 381-561 ms — worst case the
     2 s Apple timeout — for every search. The local paint is untouched either
     way, so this is not a keystroke regression in either design; it is the
     `chart_rank` 101-200 tier arriving late, and there is no reason for it to.
     Two requests also make this card's "a directory failure or timeout must
     leave the local list exactly as it was" structural rather than argued:
     the directory pass can only ever CALL `mergeBreadth`, which only ever
     appends, and `fetchApiJson` resolves `null` on any failure — there is no
     path from an Apple problem to a shorter list. The cost is one extra
     endpoint invocation per uncached search; the two URLs are distinct edge
     cache keys and both are `max-age=300`, so repeats are absorbed there.

     THE FLOOR IS THE ONLY GATE, and `shown` is deliberately not consulted —
     not its length, not its match strengths. The measurement that killed every
     threshold is in `SHOW_DIRECTORY_MIN_QUERY_LENGTH`'s own comment above. */
  const directoryKey = showBreadthCacheKey(query);
  const cachedDirectory = showDirectoryQueryCache.get(directoryKey);
  if (directoryKey.length < SHOW_DIRECTORY_MIN_QUERY_LENGTH) {
    settle({ dirMs: null, dirHits: null }); // "this half did not run", a real state
    showPassDone(false);
  } else if (cachedDirectory) {
    if (myToken === showSearchToken) mergeBreadth(cachedDirectory);
    settle({ dirMs: 0, dirHits: cachedDirectory.length });
    showPassDone(false);
  } else {
    const dirStart = nowMs();
    fetchApiJson(`api/shows/search?q=${encodeURIComponent(query)}&limit=25&fallthrough=1`).then((data) => {
      const dirMs = nowMs() - dirStart;
      const rows = data?.shows || [];
      /* HTTP 200 IS NOT "THE DIRECTORY ANSWERED" (adversarial review
         2026-09-12, defect 2), and `data` being non-null only ever meant the
         TRANSPORT worked. `api/shows/search.ts` replies 200 with
         `fallthrough: {attempted: true, error: "rate-limited"}` and ZERO
         directory rows whenever the limiter trips or Apple errors or times out
         — by design, so that a directory problem never costs the listener the
         catalogue rows — and it replies 200 with `degraded: true, shows: []`
         when the breadth catalogue itself cannot be read. Both used to be
         written into `showDirectoryQueryCache` as THE answer for that query,
         and the cache is session-lived, so one rate-limit trip on a train
         removed the whole directory tier for that query until a reload. The
         10 s edge TTL `api/shows/search.ts` argues will "flatten the storm" was
         irrelevant, because no second request was ever made.

         THE TEST THAT SHOULD HAVE CAUGHT IT DID NOT, because the fixture was
         more forgiving than the endpoint: `mount({directoryOk: false})` models
         a NON-200, which `fetchApiJson` resolves to `null` — the one shape this
         endpoint never sends on a limiter trip. `mount({directoryError: …})`
         now models the shape it does send. */
      const answered = !!data && !data.degraded && !(data.fallthrough && data.fallthrough.error);
      if (answered) {
        if (showDirectoryQueryCache.size >= SHOW_BREADTH_CACHE_MAX) showDirectoryQueryCache.clear();
        showDirectoryQueryCache.set(directoryKey, rows);
      }
      /* The rows still MERGE either way. A degraded reply carries the
         catalogue's own rows, and `mergeShowRows` only ever appends — refusing
         them would make a directory failure cost the listener something, which
         is the whole thing P-02 promised it never would. */
      if (myToken === showSearchToken && rows.length) mergeBreadth(rows);
      /* `dirHits` is the DIRECTORY's hit count and nothing else. Reporting
         `rows.length` on a trip that returned no directory rows at all made
         limiter trips invisible to P-06's diagnostics — a full count for a pass
         that fetched nothing. `null` is the existing "this half is unknown"
         value and it is the honest one here. */
      settle({ dirMs, dirHits: answered ? rows.length : null });
      /* A degraded or limiter-tripped answer is a pass that did NOT answer, for
         the same reason it is not cached above: the empty list it leaves is a
         fact about this moment's network, and the listener is told so. */
      showPassDone(!answered);
    }); // fetchApiJson swallows network/parse errors to null — a failed directory pass adds nothing and removes nothing
  }

  /* ---------- S-05: THE SHARD PASS, a FOURTH pass and a THIRD request ----------

     Skipped entirely (settled as "did not run", zero requests) offline —
     see `fetchShardRows`'s own header for D9. Otherwise fetches the one
     shard the query's longest token keys into (`SearchEngine.shardKeyForQuery`),
     ranks its rows (`SearchEngine.rankShardRows`, exact > prefix > word-start
     > substring, curated boost, AND-filtered on every token), maps them to
     the shared show-record shape (`mapShardRow`) and merges through the same
     `mergeBreadth`/`mergeShowRows` path every other source uses — so a shard
     row dedupes against a curated/catalogue/directory row exactly as those
     dedupe against each other, and `state.shardShowCache` is seeded the same
     way `state.breadthShowCache` is, so a tapped `pi:` result resolves
     through `showById` without a second network round trip. */
  const shardKey = SearchEngine.shardKeyForQuery(query);
  if (isOfflineForShardSearch()) {
    settle({ shardMs: null, shardHits: null }); // D9: no request, a real "did not run" state
    showPassDone(false);
  } else if (!shardKey) {
    settle({ shardMs: null, shardHits: null });
    showPassDone(false);
  } else {
    const shardStart = nowMs();
    fetchShardRows(shardKey).then((rows) => {
      const shardMs = nowMs() - shardStart;
      /* Its best SHOW_PASS_LIMIT (app-2-2): rankShardRows takes no limit, and a
         shard can hold thousands of rows. */
      const ranked = SearchEngine.rankShardRows(query, rows).slice(0, SHOW_PASS_LIMIT);
      const mapped = ranked.map(mapShardRow);
      for (const s of mapped) cacheShowRow("shard", s);
      if (myToken === showSearchToken && mapped.length) mergeBreadth(mapped);
      settle({ shardMs, shardHits: mapped.length });
      showPassDone(false); // fetchShardRows folds its own failures into [], so it cannot report one
    }); // fetchShardRows never throws/rejects (see its own header) — no .catch needed
  }

  renderEpisodeSearchResults(query, myToken, (epMs, epHits) => settle({ epMs, epHits }), local.localEpisodes);
  renderPlaylistSearchResults(query, myToken, (ctaMs) => settle({ ctaMs }));
}

/** Every keystroke. Local pass now; everything expensive on a 250 ms trailing
    debounce, cancelled by the next keystroke. */
function onShowSearchInput(rawValue) {
  const query = String(rawValue || "").trim();
  /* THE SAME QUERY IS NOT A NEW SEARCH (audit round 2, search-7). A trailing
     space trims to the text already on the page, and this used to bump the
     token and repaint the LOCAL rows over a list the catalogue, directory and
     shard passes had already grown — the list collapsed for the 250 ms until
     the tick re-merged it from the caches. #684's append-only rule made that
     repaint the only thing left that can make the list shrink. If the pending
     tick is still owed it stays owed; if the passes are in flight they keep
     the token; if they answered, the answer stands. */
  if (query && isShowSearchCurrent(query)) return;
  const myToken = ++showSearchToken; // supersedes any in-flight costly pass
  if (showSearchDebounceTimer) clearTimeout(showSearchDebounceTimer);
  showSearchDebounceTimer = null;
  showSearchPendingLocal = null;
  if (!query) { clearShowSearchResults(); noteShowQueryInRoute(""); return; }
  const local = paintShowSearchLocal(query, myToken);
  showSearchPendingLocal = local;
  showSearchDebounceTimer = setTimeout(() => {
    showSearchDebounceTimer = null;
    showSearchPendingLocal = null;
    if (myToken !== showSearchToken) return; // a newer keystroke already owns the page
    noteShowQueryInRoute(query);   // the query has settled: the address can say so
    runShowSearchCostly(query, myToken, local);
  }, SHOW_SEARCH_DEBOUNCE_MS);
}

/** Enter, the Go button, and every existing caller: the same two passes with
    the debounce SKIPPED — the exact idiom the show page's episode search
    already ships (`onSearchInputChange`/`runSearch`, above).

    FOR THE QUERY ALREADY ON THE PAGE IT SKIPS THE DEBOUNCE AND NOTHING ELSE
    (audit round 2, search-7). Return inside the 250 ms window used to bump the
    token: the passes the tick was about to start were discarded, both endpoint
    requests fired again, and the list stayed local-only for a second round
    trip. Now a pending tick runs immediately with the rows it already had, and
    a search whose passes are in flight or answered is left alone — the return
    key's remaining job is to put the keyboard away (the submit handler). */
function renderShowSearchResults(query) {
  noteShowQueryInRoute(query);
  if (isShowSearchCurrent(query)) {
    if (!showSearchDebounceTimer) return; // in flight or answered: nothing to skip
    clearTimeout(showSearchDebounceTimer);
    showSearchDebounceTimer = null;
    const local = showSearchPendingLocal;
    showSearchPendingLocal = null;
    runShowSearchCostly(query, showSearchToken, local);
    return;
  }
  const myToken = ++showSearchToken;
  if (showSearchDebounceTimer) { clearTimeout(showSearchDebounceTimer); showSearchDebounceTimer = null; }
  showSearchPendingLocal = null;
  const local = paintShowSearchLocal(query, myToken);
  runShowSearchCostly(query, myToken, local);
}

/* U-05 (docs/ui-transition-plan.md D7): the Playlists section under Shows
   and Episodes results. Unlike renderEpisodeSearchResults this is entirely
   LOCAL/SYNCHRONOUS -- both sources (cp_playlists, cardSlots) are already
   in memory, so there is no fetch to guard against staleness beyond the
   same `myToken` check every section here shares (a fast retype still must
   not let a slow show-search token's residual call clobber a newer one,
   though nothing here awaits anything itself).

   ORDER (the card's own "own playlists first, then generated" rule): the
   listener's own matching playlists lead, each exactly as renderPlaylists
   already renders one row (`.pl-row`, same fields, same #/playlist/:id
   link) so a playlist opened from Search is indistinguishable from one
   opened from the Playlists page. Generated candidates follow, visibly
   badged "Generated for you" (D5's own wording, reused verbatim rather than
   inventing new copy for the same concept) -- the reader must be able to
   tell the two apart before tapping, same principle as U-03's Home badge.

   THE CTA (the card's own #135 retarget, D8): "Create a playlist about X"
   appears when no own/generated playlist matched AND the topic scorer CAN
   build one — see createPlaylistCtaHtml for why the gate is that way round.
   The CTA is presentation only: tapping it hands off to the Create page's
   own #cr-form flow (through `location.hash` + prefilling the input) rather
   than calling buildPlaylist() here, so this card adds no second path that
   can create a playlist -- there remains exactly one (bindCreateFormSubmit),
   matching D8's "the Foray half is not built, Playlist creation stays
   today's flow" scope. */
/* The Playlists section while the topic scan behind the CTA is still owed —
   see "AND IT SAYS SO WHILE IT IS OWED" below. A status line, not a claim:
   it names the work, not an outcome. */
const CTA_PENDING_HTML = `<p class="note" role="status" data-cta-pending>Still looking for playlists…</p>`;

function renderPlaylistSearchResults(query, myToken, reportCtaMs = () => {}) {
  const container = $("#pl-search-results");
  if (!container) { reportCtaMs(null); return; } // page markup not present (e.g. a caller that reuses renderShowIndexPage without it)
  if (myToken !== showSearchToken) { reportCtaMs(null); return; } // superseded before this ran

  const own = playlists().filter(p => playlistMatchesQuery(p, query));
  const ownIds = new Set(own.map(p => p.id));
  const generated = generatedPlaylistCandidatesForQuery(query).filter(p => !ownIds.has(p.id));

  if (!own.length && !generated.length) {
    /* THE DEFER IS LOAD-BEARING (review finding, fresh-context Opus pass):
       createPlaylistCtaHtml() calls topicSearchStatus(), which runs the
       exact same SearchEngine.searchWithRelaxation() scan buildPlaylist()
       does -- 1.3-8s on a cold cache per that function's own documented
       measurement (see buildPlaylist's SEARCH_CACHE_MAX comment). Calling
       it synchronously from here, on every show-name search that matches
       no playlist (the COMMON case -- e.g. "fridman"), would freeze the
       whole Shows page.

       `setTimeout(…, 0)` WAS NOT ENOUGH, and that is finding 2 of the
       2026-09-12 client audit. A zero timeout buys one paint turn and then
       runs on the very next task — so the listener saw their results paint
       and then watched the page stop responding for seconds, on the COMMON
       path (a show-name query matching no playlist). `whenIdle` waits for a
       frame with room in it and keeps a deadline, which is what `init()`'s
       vocabulary priming has done since the H bug; the fallback for a host
       without `requestIdleCallback` is the old zero timeout.

       AND IT IS TIMED. The scan is now the `ctaMs` field of the one `search`
       diagnostics entry, so the next time it grows nobody has to guess: it
       was invisible before precisely because the record was written from the
       local pass and closed before this ran.

       AND IT SAYS SO WHILE IT IS OWED (persona audit #28, 2026-09-22). The
       defer only chose WHEN the scan blocks; the results still painted, the
       page looked finished, and then taps went nowhere for seconds before a
       section grew at the bottom. Loading claims nothing, but it does not
       hide either: the section holds CTA_PENDING_HTML - the one line that
       says work is still going - from this synchronous paint (so the frame
       whenIdle waits for shows it) until the scan answers, and then becomes
       the CTA or goes away. A shorter lock needs the scan off the main
       thread (a Worker over search-engine.js), which is a separate change.

       Guard with `myToken` so a fast retype's OLD deferred computation can
       never clobber a newer query's freshly-painted own/generated section
       (a newer query, or a cleared field, owns the container outright). */
    container.innerHTML = CTA_PENDING_HTML;
    container.hidden = false;
    whenIdle(() => searchDataSettled().then(() => {
      if (myToken !== showSearchToken) { reportCtaMs(null); return; } // a newer query already superseded this one
      /* Belt to the router's supersede (app-2-3): a section no longer in the
         document is nobody's, so the multi-second scan is not run for it. */
      if (container.isConnected === false) { reportCtaMs(null); return; }
      const ctaStart = nowMs();
      /* A scan that throws must not leave "Still looking" up for good: the
         pending line is a promise that this callback always ends it. */
      let cta = "";
      try { cta = createPlaylistCtaHtml(query); } catch (err) { console.warn("[search] playlist CTA scan failed", err); }
      reportCtaMs(nowMs() - ctaStart);
      if (!cta) { container.innerHTML = ""; container.hidden = true; return; } // answered: nothing to offer
      container.innerHTML = cta;
      container.hidden = false;
      bindCreatePlaylistCta(container);
    }));
    return;
  }

  const row = (p, generated) => `
    <a class="pl-row" href="#/${esc(playlistRoute(p))}">
      <div class="info">
        <div class="t">${esc(p.title)}${generated ? ` <span class="fy-badge fy-badge-generated">Generated for you</span>` : ""}</div>
        <div class="s">${playlistLengthLabel(p)}</div>
      </div>
      <span class="chev">\u203a</span>
    </a>`;

  container.innerHTML = `<section class="ep-more fy-playlist-search">
    <h3>Playlists</h3>
    <div class="show-results">
      ${own.map(p => row(p, false)).join("")}
      ${generated.map(p => row(p, true)).join("")}
    </div>
  </section>`;
  container.hidden = false;
  reportCtaMs(null); // the scan never ran: a playlist already matched
}

/* U-05 (#135, D7/D8): appears in place of a Playlists section when no
   own/generated playlist matched the query and the topic scorer CAN build
   one. `topicSearchStatus` runs the exact same scorer buildPlaylist() would,
   read-only (see its own header for why this must not itself create a
   playlist). Retargeted from Foray to Playlist per D8: the mockup's
   SearchScreen CTA offers "Create a Foray about X"; Foray generation stays
   out of the UI (D8), so this offers a Playlist instead, handed to Create's
   own form rather than a new creation path.

   THE GATE IS INVERTED FROM WHAT SHIPPED (audit round 2, search-2). U-05
   carried the mockup's condition — offer the CTA when the query has no strong
   result — over from a Foray, which can be made about anything, to a Playlist,
   which is built by the very scorer that just said "empty". So the page's one
   primary button was offered on "joe rogan", "npr" and "knitting", where the
   build was certain to fail a second later on another page with "Not much on
   … yet", and withheld on "fusion energy", where one tap would have built a
   real playlist. Offered only when the tap yields a playlist: `ok` or `sparse`
   (a sparse playlist is a real, disclosed one — see buildPlaylist). On
   `empty`, nothing: the Shows and Episodes sections are the answer. */
function createPlaylistCtaHtml(query) {
  const status = topicSearchStatus(query).status;
  if (status !== "ok" && status !== "sparse") return "";
  return `<div class="sh-create-cta">
    <button type="button" class="fy-btn fy-main" data-create-playlist="${esc(query)}">
      Create a playlist about ${quoteQuery(esc(query))}
    </button>
  </div>`;
}

/* Hands off to Create's own, single creation path (#cr-form's
   bindCreateFormSubmit) rather than calling buildPlaylist() from here --
   see createPlaylistCtaHtml's header for why a second creation path is out
   of scope. It used to hand off to #/playlists' form; that builder is gone
   (p-first-6).

   THE QUERY RIDES IN MODULE STATE, NOT ON A TIMER (audit round 3, app-2-11).
   This navigated and then prefilled on a setTimeout(0), assuming the
   hashchange render would run first. The spec does not order a timer task
   against a hashchange task, so on a slow WebView the timer could win, find no
   #cr-form and land the listener on an empty Create page. Now the query waits
   in `pendingCreateQuery` and renderCreate consumes it once its form is bound —
   whenever that render happens. */
let pendingCreateQuery = null;

function bindCreatePlaylistCta(scope) {
  const btn = scope.querySelector("[data-create-playlist]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    pendingCreateQuery = btn.dataset.createPlaylist || "";
    location.hash = "#/create";
  });
}


/* Episodes section under Shows search (S-07, kanban t_6baccaa0): a separate
   result block below the show list, backed by api/episodes/search.ts. Same
   "guard a slow in-flight fetch with a token" pattern as the show-search
   breadth fetch above, sharing the same showSearchToken so a fast retype
   supersedes both in lockstep.

   Offline degrades to nothing rendered — this is a network-only feature
   (Apple's public index / a show's live feed), there is no local episode
   index to fall back to for a query outside the curated pool, matching this
   file's own "absence is a real state" convention rather than a spinner
   that never resolves. */

/* S-05, THE EPISODE HALF (finding 4, client audit 2026-09-12).

   The shows half got the hot-query cache, the pre-fetch supersession check and
   the diagnostics row; the episode half — the SLOWER of the two endpoints —
   got none of the three and fired on every debounce tick. Same cache, same
   rules, same reasons as `showBreadthQueryCache` above (FIFO with a wholesale
   clear, successful responses only, session-scoped and never persisted:
   `fetchApiJson` passes `cache: "no-cache"`, so a retype otherwise pays the
   whole round trip again, and a failure remembered as an answer would turn one
   bad moment on a train into a permanently empty Episodes section).

   Keyed on the same normalized query, because the endpoint lowercases and
   trims server-side exactly as the shows one does. */
const EPISODE_SEARCH_CACHE_MAX = 200;
const episodeSearchQueryCache = new Map();

/* ---------- P-05 piece 2: THE INSTANT EPISODE TIER (docs/search-parity-plan.md
   §4, rewritten 2026-09-12) ----------

   P-05 as written asked episodes to "ride the same two-pass shape" as shows.
   Episodes already had the SECOND half — `renderEpisodeSearchResults` fires in
   parallel with the show passes, paints its own container, shares
   `showSearchToken`, and never blocks the show list. What was missing is the
   FIRST half, and the honest version of it is much smaller than the shows one,
   because the device holds almost no episodes.

   WHAT IS ACTUALLY RESIDENT, measured 2026-09-12. `data/catalog-client.json` is
   220 shows / 100 KB carrying `episode_count` and NO episodes — zero episodes
   are on the device at boot. The only persisted episode corpus is the
   listener's own: `cp_saved` (stars) and `cp_queue` (Up Next), tens of items.
   So that is what this tier searches.

   AND THAT IS NOT A SHORTFALL — IT IS THE MECHANISM. Pocket Casts' instant
   episode tier is your subscriptions, not the world's episodes; it reaches the
   directory for everything else, exactly as the endpoint below does. Read this
   as "the local tier is the listener's own library", not as "we could not
   afford the real one".

   THOUGH WE ALSO COULD NOT AFFORD THE REAL ONE, and the number is recorded so
   nobody re-litigates it from taste. A title+show_id index built from the one
   episode corpus that exists (`data/episode-archive.json.gz`, 98 shows / 73,719
   episodes) is 4.35 MB raw / 1,486 KB gzip. Extrapolated to the 10,113 shows
   `data/show-index.tsv` already covers: ~150 MB gzip against §2.3's 400 KB
   budget — 375x over. Server-side it needs a datastore production does not
   have (`api/episodes/search.ts`'s own header: DB-mode "not implemented …
   production has no DATABASE_URL today") plus a refresh job over ~10k feeds.
   A prebuilt episode index is a project, not a card. Revisit only if P-04
   concludes the local tier should hold episodes at all.

   IT RUNS ON THE KEYSTROKE, INSIDE THE TOKEN GUARD, AND IT IS O(saved). Called
   from `paintShowSearchLocal` — the same tick as the local SHOW pass, before
   the 250 ms debounce and therefore before any network call. #662 just took
   two multi-second passes off this tick and nothing here may put work back on
   it: the scan is over `cp_saved` + `cp_queue` (tens of entries), never over
   `state.itemIndex`, which grows with every rendered row AND would resurface a
   previous query's Apple results as if they were the listener's own. */
const LOCAL_EPISODE_TIER_MAX = 5;

/** THE SHOW NAMES ONE ROW CAN BE RECOGNISED BY, normalised. Every episode key
    below is scoped by one of these, and the two sides of the merge name the
    show differently — a locally saved episode's id carries the SLUG
    (`lex-fridman-podcast`) while the endpoint's row carries the DISPLAY TITLE
    ("Lex Fridman Podcast") — so both are offered and `normaliseShowTitle`
    (P-02's rule, reused rather than re-derived) is what makes them meet. */
function episodeDedupScopes(ep) {
  const out = [];
  for (const v of [ep && ep.show_title, ep && ep.show_id]) {
    const n = normaliseShowTitle(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length ? out : [""];
}

/* The dedup keys shared by both tiers (`episodeDedupKeys` below; the single-key
    `episodeDedupKey` it grew out of had no caller and was deleted in audit round
    3, app-2-15). `guid` when the row has one — the closest
    thing to a stable episode identity either side supplies — falling back to
    the normalised title. BOTH forms are scoped by the show, and the guid form
    is scoped for a reason that is not symmetry:

    A GUID RECOVERED FROM AN ID IS NOT KNOWN TO BE A GUID. `localEpisodeIdentity`
    above reads `<show_id>--<guid>`, which is a real feed guid for a show-page
    save and an editorial slug for a curated pool item, and nothing on this side
    can tell those apart. An unscoped `g:` key would therefore let the curated
    ids `show-a--intro` and `show-b--intro` both derive `g:intro` and collapse
    two unrelated episodes into one row. Scoped by show they cannot.

    Show was already part of the title key, for the older version of the same
    problem: episode titles collide hard across shows ("Episode 1",
    "Introduction"). */

/** EVERY key a row can be recognised by, because one is never enough here, and
    two rows are the same episode when their key SETS INTERSECT.

    TWO REASONS THE SET IS BIGGER THAN THE KEY. The show scope is ambiguous —
    slug on one side, display title on the other — so every scope the row can
    name gets a key. And a row that HAS a guid still carries its title key,
    because the guid halves of the two tiers agree only for a show-page save:
    for a curated pool item the local suffix is an editorial slug the feed will
    never match, and there it is the title key that does the work. Before this,
    a `g:` key and a `t:` key could never meet, so an episode saved from a show
    page was rendered twice — once with a filled star, once with an empty one
    (adversarial review 2026-09-12, defect 4). */
function episodeDedupKeys(ep) {
  const guid = ep && ep.guid ? String(ep.guid).trim() : "";
  const title = normaliseShowTitle(ep && ep.title);
  const keys = [];
  for (const scope of episodeDedupScopes(ep)) {
    if (guid) keys.push("g:" + scope + "|" + guid);
    keys.push("t:" + title + "|" + scope);
  }
  return keys;
}

/** The TWO id shapes a device-resident episode can have, and the identity each
    one carries. Both are minted in this file, so this reads our own format
    rather than guessing at one:

      `apple:<show_id>:<guid>`  `paintEpisodeSearchResults` below, for a row the
                                listener starred straight out of a search.
      `<show_id>--<guid>`       `fullCatalogueRowToEpRowItem`, for a row saved
                                from a show page or the full-catalogue list —
                                and the suffix there is the feed's REAL guid.

    THE SECOND SHAPE WAS NOT READ AT ALL before this (adversarial review
    2026-09-12, defect 4), which made cross-tier dedup structurally impossible
    for every episode saved from a show page: it yielded `guid: null` and so
    keyed by title, while its endpoint twin — endpoint rows ALWAYS carry a guid
    (`api/episodes/search.ts`) — keyed by guid. A `t:` key can never equal a
    `g:` key, so the listener saw the episode they had starred twice, once with
    a filled star and once with an empty one, and starring the second copy made
    a second `cp_saved` entry for the same episode.

    THE CURATED POOL SHARES THE SECOND SHAPE AND NOT ITS MEANING, which is why
    what comes back is a CANDIDATE and not an answer: `data/discover.json`'s
    2,160 ids are `<show-slug>--<episode-slug>`, so the suffix there is an
    editorial slug that no feed will ever agree with. `episodeDedupKeys` below
    therefore matches on a SET of keys rather than trusting this one. */
function localEpisodeIdentity(id) {
  const s = String(id);
  const parts = s.split(":");
  if (parts[0] === "apple" && parts.length >= 3) return { show_id: parts[1], guid: parts.slice(2).join(":") };
  const cut = s.indexOf("--");
  if (cut > 0) return { show_id: s.slice(0, cut), guid: s.slice(cut + 2) };
  return { show_id: null, guid: null };
}

/** Projects one device-resident snapshot into the SAME row shape
    `api/episodes/search.ts` returns, so the paint and the dedup below have one
    vocabulary rather than two. `_localId` carries the real storage id through,
    because that id is what `starBtn`/`upNextBtn` read: a saved episode must
    render already-starred here, and it would not if this minted a fresh
    `apple:` id for it. */
function localEpisodeRow(id, snap) {
  const { show_id, guid } = localEpisodeIdentity(id);
  return {
    _localId: id,
    /* THE LISTENER'S OWN SNAPSHOT, CARRIED WHOLE AND NEVER RE-DERIVED
       (adversarial review 2026-09-12, defect 1). Everything below this line is
       the ENDPOINT's row shape, which is strictly THINNER than a stored
       snapshot — no `artwork_url`, no `topics`, no `release_date`, no
       `explicit`, no `apple_*`, no `chapters`. Projecting a real episode down
       to it and then snapshotting THAT back under the real storage id is how
       one keystroke used to blank a saved episode's artwork and topics for the
       rest of the session. `rowFor` renders a local row from this field, never
       from the projection. */
    _localSnapshot: snap,
    show_id,
    show_title: snap.show || null,
    title: snap.title,
    guid,
    description_text: snap.hook || "",
    published_at: snap.release_date || null,
    duration_seconds: snap.duration_sec != null
      ? snap.duration_sec
      : (snap.duration_min != null ? snap.duration_min * 60 : null),
    audio_url: snap.audio_url || null,
    source: "local",
  };
}

/** The listener's own episodes matching `query`, title matches before
    show-only matches, capped. Matching the SHOW name as well as the episode
    title is not a nicety: a listener who types "huberman" is looking for their
    saved Huberman episodes, whose titles rarely contain the host's name —
    that is §2.2's finding, one layer down. Description text is deliberately
    NOT matched (`filterLoadedEpisodes` does, on the show page, where the pool
    is one show): across a mixed library it surfaces rows whose connection to
    the query is invisible in the row itself. */
function localEpisodeMatches(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const byTitle = [];
  const byShow = [];
  const seen = new Set();
  const consider = (id, snap) => {
    if (!id || !snap || !snap.title || seen.has(id)) return;
    seen.add(id);
    if (String(snap.title).toLowerCase().includes(q)) byTitle.push(localEpisodeRow(id, snap));
    else if (String(snap.show || "").toLowerCase().includes(q)) byShow.push(localEpisodeRow(id, snap));
  };
  const saved = savedMap();
  for (const id of Object.keys(saved)) consider(id, saved[id]);
  /* Up Next resolves through the same three-way rule every other id-list
     surface uses (`rowsForIds`); an "unnamed" row is an id with no snapshot
     behind it and has no title to match, so it cannot appear here. */
  for (const row of queueRows()) {
    if (row.state === "unnamed") continue;
    consider(row.id, row.item);
  }
  return byTitle.concat(byShow).slice(0, LOCAL_EPISODE_TIER_MAX);
}

/** Paints one episode answer, or the honest nothing. Split out of the fetch so
    a cache hit and a fresh response cannot drift into two renderers.

    TWO TIERS, ONE LIST. `localEpisodes` paints first and always; the endpoint's
    rows are merged BENEATH them, never interleaved and never re-sorted — the
    endpoint's own order is Apple's relevance ranking and re-sorting it here
    would throw that away, the same rule `mergeBreadth` holds for shows. A row
    the listener already has is shown once, in the local tier, because that is
    the copy whose star and Up Next state are real. */
function paintEpisodeSearchResults(query, data, container, localEpisodes) {
  const local = localEpisodes || [];
  const seen = new Set();
  for (const ep of local) for (const k of episodeDedupKeys(ep)) seen.add(k);
  const localKeys = new Set(seen);
  const remote = [];
  /* The endpoint's rows that are ON SCREEN: the ones painted below, plus the
     ones a local row already shows (audit round 2 review of honesty-11). */
  let endpointShown = 0;
  for (const ep of (data?.episodes || [])) {
    const keys = episodeDedupKeys(ep);
    if (keys.some((k) => seen.has(k))) {
      if (keys.some((k) => localKeys.has(k))) endpointShown++;
      continue;
    }
    for (const k of keys) seen.add(k);
    remote.push(ep);
    endpointShown++;
  }
  if (!local.length && !remote.length) {
    container.innerHTML = "";
    container.hidden = true;
    return 0;
  }
  /* The caption is an attribution, so it may only sit on rows Apple produced.
     With no local tier it stays on the heading, byte-identical to what shipped
     before this card; with one, it becomes a divider ABOVE the endpoint's rows,
     because a heading caption would silently claim the listener's own saved
     episodes came from Apple's index. */
  const fromApple = (data?.source || []).includes("apple") && remote.length > 0;
  const ctx = "episode-search-" + query;
  /* A SEARCH PAINT MAY NEVER WRITE OVER A REAL STORED EPISODE (adversarial
     review 2026-09-12, defect 1 — and the rule this tier's own header already
     claimed). `snapshot()` ends `state.itemIndex[id] = snap`, and `rowsForIds`
     reads `state.itemIndex` for anything liveEpisode() accepts — so Up Next, the
     Library screen and `toggleStar`'s `cp_saved` write all read back whatever
     this function last put there. Before this, one keystroke over a starred,
     in-pool episode replaced its artwork, topics and release date with nulls
     for the rest of the session, and then on disk at the next star toggle.

     THE SPLIT IS BY ID PROVENANCE, not by row contents. A REMOTE row's id is
     minted here (`apple:…`) and collides with nothing, so it still goes through
     `snapshot()` — that is how a tapped Apple result becomes playable and
     starrable at all. A LOCAL row's id is the listener's OWN storage id, so it
     renders from what is already under that id: the live `state.itemIndex`
     entry when the pool has one, otherwise the listener's own snapshot carried
     through `_localSnapshot`, which is registered rather than merely read
     because an episode saved in an earlier session has no `itemIndex` entry yet
     and `toggleStar` would then persist `{}` over it. Either way the value
     written is a FULL snapshot, never the endpoint's thinner projection. */
  const rowFor = (ep, i) => {
    if (ep._localId) {
      const item = state.itemIndex[ep._localId] || snapshot(ep._localId, ep._localSnapshot || {
        show: ep.show_title || ep.show_id,
        show_id: ep.show_id || null,
        title: ep.title,
        hook: ep.description_text || "",
        audio_url: ep.audio_url,
        duration_min: ep.duration_seconds ? Math.round(ep.duration_seconds / 60) : null,
        duration_sec: ep.duration_seconds ?? null,
        topics: [],
      });
      return epRow(item, i, ctx, -1);
    }
    const id = `apple:${ep.show_id}:${ep.guid || (ep.title + "--" + i)}`;
    /* THE SAME SNAPSHOT THE SHOW PAGE WOULD HAVE MADE (audit round 2,
       search-8 and p-switcher-7 — the 2026-09-21 car-artwork report was fixed
       in `fullCatalogueRowToEpRowItem` only, and this is the other producer of
       playable breadth rows). The endpoint's row is thinner than a stored
       snapshot, but three things it does carry, or that resolve locally, were
       dropped on the floor here: `show_id` (so the show name links to the
       show page for the 19.9k breadth shows and not only the curated 220),
       `published_at` (the date every other row shows) and the show's artwork
       — Apple's `artworkUrl600` when the endpoint passes it, else the show
       record `showById` already holds from the show passes. Without the art,
       the lock screen and CarPlay fell back to the 4a icon for any episode
       played from Search. */
    const item = snapshot(id, {
      show: ep.show_title || ep.show_id,
      show_id: ep.show_id || null,
      title: ep.title,
      hook: ep.description_text || "",
      audio_url: ep.audio_url,
      duration_min: ep.duration_seconds ? Math.round(ep.duration_seconds / 60) : null,
      duration_sec: ep.duration_seconds ?? null,
      release_date: ep.published_at || null,
      artwork_url: ep.artwork_url || showArtworkUrl(showById(ep.show_id)) || null,
      topics: [],
    });
    return epRow(item, i, ctx, -1);
  };
  const localRows = local.map((ep, i) => rowFor(ep, i));
  const remoteRows = remote.map((ep, i) => rowFor(ep, local.length + i));
  /* HOW MANY THE ENDPOINT HELD BACK (audit round 2, honesty-11). The section is
     cut to ten rows on purpose (see the `limit=10` note in
     renderEpisodeSearchResults) and stopped at a round number with nothing
     saying whether that was all of them, while the show page's own search says
     "38 episodes found." The endpoint now reports `total` — the matches it
     mapped before the cut — and `capped` when Apple filled its over-fetch, in
     which case the count is a floor and says so with a `+`. */
  /* `total` is the endpoint's count BEFORE the dedup against the listener's
     own saved and queued episodes, so it is compared with every endpoint row on
     screen — the ones a local row already shows included — not with the rows
     left below the divider. Comparing with those said "Showing 7 of 10" over
     ten visible rows whenever the listener searched for something they had
     saved (audit round 2 review). */
  const total = Number(data?.total);
  const heldBack = Number.isFinite(total) && total > endpointShown && remote.length > 0;
  const countNote = heldBack ? `<span class="note">Showing ${endpointShown} of ${total}${data?.capped ? "+" : ""}</span>` : "";
  const appleNote = fromApple ? `<span class="note">from Apple's index</span>` : "";
  const notes = [countNote, appleNote].filter(Boolean).join(" ");
  container.innerHTML = `<section class="ep-more fy-episode-search">
    <h3>Episodes${!local.length && notes ? ` ${notes}` : ""}</h3>
    ${localRows.join("")}
    ${local.length && notes ? `<div class="note fy-episode-search-more">${notes}</div>` : ""}
    ${remoteRows.join("")}
  </section>`;
  container.hidden = false;
  bindPickLogging(container);
  bindStars(container);
  bindUpNext(container);
  bindPlay(container);
  return local.length + remote.length;
}

/* ---------- THE FORAYS GROUP (audit round 2, p-foray-4) ----------

   Search could not find a Foray: typing "startup" or "venture debt" returned
   shows, episodes and a playlist CTA, never "The types of capital a startup
   can raise" — the one thing 4a made about that subject. D8 keeps Foray
   GENERATION out of the UI; nothing ever said published Forays should be left
   out of search results, and Search is the door an Apple Podcasts switcher
   opens first. Local, synchronous, on the keystroke: the list `forayCards()`
   already holds for Home, Library and #/forays (published + unlocked, the
   test-track drafts when the switch is on), matched on title, summary and the
   running order's slot titles, rendered in the `#/forays` list's own row shape
   so a Foray found here looks like a Foray found there. */
const FORAY_SEARCH_MAX = 3;

/** Every query token must appear somewhere in the Foray's own words. The
    tokens are the listener's, split on whitespace, matched as folded
    substrings (so "cafe" finds "Café" the way the show passes do). */
function foraySearchMatches(query) {
  const tokens = SearchEngine.foldDiacritics(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (const f of forayCards()) {
    const text = SearchEngine.foldDiacritics([
      f.title, f.summary, ...((Array.isArray(f.slots) ? f.slots : []).map((s) => s && s.title)),
    ].filter(Boolean).join(" "));
    if (tokens.every((t) => text.includes(t))) hits.push(f);
  }
  return hits.slice(0, FORAY_SEARCH_MAX);
}

function paintForaySearchResults(query, myToken) {
  const container = $("#fy-search-results");
  if (!container) return [];
  if (myToken !== showSearchToken) return [];
  const hits = foraySearchMatches(query);
  if (!hits.length) {
    container.innerHTML = "";
    container.hidden = true;
    return [];
  }
  container.innerHTML = `<section class="ep-more fy-foray-search">
    <h3>Forays</h3>
    ${forayRowsHtml(hits, { inSection: true })}
  </section>`;
  container.hidden = false;
  return hits;
}

/** THE KEYSTROKE HALF, called from `paintShowSearchLocal`. Paints the local
    tier alone — the endpoint's rows are not here yet and this must not wait for
    them — and hands the rows back so the debounced pass can merge beneath
    exactly what the listener is already looking at. Token-guarded like every
    other painter on this page. */
function paintLocalEpisodeSearch(query, myToken) {
  const container = $("#ep-search-results");
  if (!container) return [];
  if (myToken !== showSearchToken) return []; // superseded before this ran
  const local = localEpisodeMatches(query);
  if (!local.length) {
    /* Nothing of the listener's matches. Leave the container cleared rather
       than leaving the PREVIOUS query's rows on screen — "absence is a real
       state", and a stale Episodes section under a fresh query is a lie the
       endpoint would take 369 ms to correct. */
    container.innerHTML = "";
    container.hidden = true;
    return [];
  }
  paintEpisodeSearchResults(query, null, container, local);
  return local;
}

function renderEpisodeSearchResults(query, myToken, report = () => {}, localEpisodes = null) {
  const container = $("#ep-search-results");
  if (!container) { report(null, null); return; } // page markup not present (e.g. category page reusing renderShowIndexPage)

  /* The local tier normally arrives from the keystroke pass. `renderShowSearch-
     Results` and the tests call this directly, so recompute rather than assume
     — it is a scan over tens of stored items, not something worth a flag. */
  const local = localEpisodes || localEpisodeMatches(query);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    /* OFFLINE IS WHERE THE LOCAL TIER EARNS ITS KEEP, so it must not be wiped
       here. Before P-05 this branch cleared the container because there was
       genuinely nothing to show without the network; now the listener's own
       saved and queued episodes are still answerable, and they are exactly
       what someone searching on a plane is looking for. The fetch is still
       skipped — a network-only feature does not get a spinner that will never
       resolve (this file's "absence is a real state" rule). */
    paintEpisodeSearchResults(query, null, container, local);
    report(null, null);
    return;
  }

  /* THE TOKEN IS CHECKED BEFORE THE FETCH, not only on its response. The
     shows half has done this since S-05; here the check existed only inside
     the `.then`, so a superseded tick still spent the round trip — on a phone,
     on the slower of the two endpoints, once per keystroke that outran the
     debounce. */
  if (myToken !== showSearchToken) { report(null, null); return; }

  const cacheKey = showBreadthCacheKey(query);
  const cached = episodeSearchQueryCache.get(cacheKey);
  if (cached) {
    paintEpisodeSearchResults(query, cached, container, local);
    report(0, (cached.episodes || []).length);
    return;
  }

  /* `limit=10` IS NOW A PROMISE OF TEN ROWS, which it was not (defect 2,
     2026-09-13). Apple's `entity=podcastEpisode` returns far fewer rows than
     the number asked for when that number is small — measured the same day,
     `history` yielded 4 rows at an ask of 10 and 38 at an ask of 50 — and the
     endpoint used to forward this 10 straight through, so the Episodes
     section was 4 rows long on a query with hundreds of episodes behind it.
     `api/episodes/search.ts` now over-fetches from Apple and takes the
     caller's cut after mapping, so this number is the section length and
     nothing else. It stays 10 deliberately: the fix was the endpoint's
     shortfall, not the section's height, and how tall that section should be
     is a layout decision with an owner. */
  const epStart = nowMs();
  fetchApiJson(`api/episodes/search?q=${encodeURIComponent(query)}&limit=10`).then((data) => {
    const epMs = nowMs() - epStart;
    /* Not a degraded reply either (search-4's rule, applied here as well): a
       limiter trip or an Apple outage answers 200 with `degraded: true` and
       no rows, and remembering that for the session would make one bad
       moment a permanently empty Episodes section for the query. */
    if (data && !data.degraded) {
      if (episodeSearchQueryCache.size >= EPISODE_SEARCH_CACHE_MAX) episodeSearchQueryCache.clear();
      episodeSearchQueryCache.set(cacheKey, data);
    }
    if (myToken !== showSearchToken) { report(epMs, null); return; } // superseded — drop this response
    /* A FAILED ENDPOINT PASS LEAVES THE LOCAL TIER EXACTLY AS IT WAS — the
       same structural promise P-02 made the show list. `data` is null on any
       network or parse failure (`fetchApiJson` swallows both), and this
       repaints the local rows rather than falling through to a clear. Only the
       ENDPOINT half is unknown in that case, which is what `epHits: null`
       already says — and, since audit round 2 (states-7), what the page says
       too: the failure used to reach the diagnostics record and never the
       screen. A degraded reply (`degraded: true`, the limiter or Apple down)
       is the same failure wearing a 200. */
    if (!data || data.degraded) noteShowSearchFailure(query, myToken, "episodes");
    /* `epHits` stays the ENDPOINT's hit count, not the painted total. It is a
       diagnostics field about the slow half (docs/search-plan.md's `search`
       entry) and quietly folding device-resident rows into it would make every
       historical comparison wrong. */
    paintEpisodeSearchResults(query, data, container, local);
    report(epMs, data ? (data.episodes || []).length : null);
  });
}

/* HOME IS THE FOUR SUBJECT CARDS AND THE RESUME BANNER. NOTHING ELSE.
   (Founder instruction, 2026-09-03, after the first TestFlight build: "the
   home page has so much clutter … Home should be the four cards.")

   That is a layout invariant as much as a product one. `.cards4` is the
   only `flex: 1` child of `.home`, the one-screen column, so ANY sibling
   added here takes its height straight off the four cards. While `.home` was
   a FIXED-height column that starved them to 0px and overflowed on top of
   whatever followed — shipped as a visible bug twice, #433 (the vouch row)
   and again before it. #464 made the column `min-height` and gave `.cards4`
   a floor, so the failure now degrades to a taller scrolling page instead of
   crushed cards. That is a backstop, not a licence: the product is one
   screen, and what was wrong both times was putting a second surface inside
   it.

   So everything that used to compete for this space now has its own menu
   destination, and that is where it goes back to if it comes back:

     "Shows we vouch for" (vouchForHtml)   -> Shows      (#/shows)
     show search (#sh-form/#sh-results)     -> Shows      (#/shows)
     "Browse all shows" link                -> gone; Shows IS that page
     playlist builder (#pl-form)            -> Playlists  (#/playlists), then Create (#/create) since 2026-09-23
     foray list + "Jump back in"            -> Forays     (#/forays)

   test/home-information-architecture.test.js asserts each of those in both
   directions — absent here, present there — so a future re-add fails CI
   rather than shipping. */
/* CUTOVER (U-11, founder override 2026-09-06): renderHome() used to branch
   on the retired `cp_ui_v2` flag and render the old four-card Home inline
   when it was off. That branch was unreachable and has been removed; the
   old implementation is preserved verbatim in
   archive/legacy-ui-2026-09/app.js.pre-cutover-2026-09-06 (see that
   directory's README to restore it). */
function renderHome() {
  return renderHomeV2();
}

/* ==================================================================== */
/* U-03: HOME v2 — four sections plus the greeting, behind cp_ui_v2       */
/* (docs/ui-transition-plan.md, kanban t_6e8343b6, resolves gate #123)   */
/* ==================================================================== */

/* Top to bottom, per the card: greeting; Jump back in; Forays for you;
   Playlists for you; Suggested. "Shared with you" and "Build your
   own" are explicitly out of scope (D10/D8) — not stubbed, not commented
   out, simply never written.

   THE FLOOR (Wyatt's decision, resolves #123): "Forays for you" and
   "Suggested" EACH reserve at least one slot for a STRETCH pick —
   something outside the listener's top interest tier, on purpose, visibly
   labelled "Stretch" with a bridge line stating why it's being suggested.
   A row reason ("Because you finish every Odd Lots") is allowed elsewhere
   but never on the stretch slot itself — that is the whole point of a
   stretch: it is not being justified by what the listener already likes.

   Suggested REUSES buildCards()'s existing tiering (top 60% of
   branches by average interest vs. the rest) rather than re-implementing
   it — that function already computes exactly this split for the
   flag-off four-card Home, and a second copy is a second place for the
   two to quietly disagree about what a stretch pick is. Forays for you
   applies the same helper independently, over Foray topics rather than
   episode branches, since Forays are a different pool with different
   membership. */

/** Generic stretch-floor picker (D1/#123), shared by both "for you"
    sections so there is exactly one implementation of "the floor" to keep
    correct. `branchFn` maps a candidate to its topic/subject id;
    `scoreFn` maps a candidate to its interest score. Reserves the FIRST
    slot for a candidate from a branch outside the top ~60% of branches by
    average score — recomputed exactly like buildCards()'s own
    `topBranchIds`, so the two thresholds cannot drift apart — falling
    back to ordinary top-ranked-first when there is no lower tier to draw
    from at all (e.g. every candidate shares one branch). Returns
    `{ picks, stretchIndex }`: `picks` is `take` candidates, in render
    order; `stretchIndex` is the position of the stretch pick within
    `picks`, or -1 if none could be found (never render a fake stretch
    label over an ordinary pick). */
function pickWithStretchFloor(candidates, { branchFn, scoreFn, take }) {
  if (!candidates.length) return { picks: [], stretchIndex: -1 };

  const byBranch = new Map();
  candidates.forEach(c => {
    const b = branchFn(c);
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(c);
  });
  const branchAvg = [...byBranch.entries()].map(([b, items]) => ({
    b, avg: items.reduce((s, i) => s + scoreFn(i), 0) / items.length,
  })).sort((x, y) => y.avg - x.avg);
  const topCount = Math.max(1, Math.ceil(branchAvg.length * 0.6));
  const topBranchIds = new Set(branchAvg.slice(0, topCount).map(x => x.b));

  const stretchBranch = branchAvg.filter(x => !topBranchIds.has(x.b))[0]?.b ?? null;
  const stretchPick = stretchBranch
    ? [...byBranch.get(stretchBranch)].sort((x, y) => scoreFn(y) - scoreFn(x))[0]
    : null;

  const rest = candidates
    .filter(c => c !== stretchPick)
    .sort((x, y) => scoreFn(y) - scoreFn(x));

  const picks = (stretchPick ? [stretchPick] : []).concat(rest).slice(0, take);
  const stretchIndex = stretchPick ? picks.indexOf(stretchPick) : -1;
  return { picks, stretchIndex };
}

/** The bridge line D1's copy rule requires on every stretch pick: it must
    state WHY the pick is being suggested despite sitting outside the
    listener's usual subjects, never a row reason implying it matches
    their taste (that's what the non-stretch "Because you finish every X"
    line is for, and it is deliberately never used here). Takes the
    subject label so the sentence names the actual branch, matching how
    every other Home string prefers a real name over a generic one. */
function stretchBridgeLine(subjectLabelText) {
  return `Outside your usual subjects — a deliberate change of pace into ${esc(subjectLabelText)}.`;
}

function greetingWord(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/* The greeting is a fact about NOW, and a page left open overnight kept saying
   "Good evening" at 7am (audit 2026-09-22, qa row 193): it was computed once per
   render and nothing re-rendered Home on return. `refreshGreeting` runs from the
   foreground hook in init() and rewrites the one word, only when it changed —
   not the whole of Home under the listener's thumb. */
function refreshGreeting(now = new Date()) {
  const el = document.querySelector(".hv2-greeting-word");
  if (el) setStatusText(el, greetingWord(now));
}

function homeGreeting() {
  const word = greetingWord();
  return `<div class="hv2-greeting">
    <span class="hv2-greeting-word">${word}</span>
    <span class="hv2-greeting-brand">4a</span>
  </div>`;
}

/* ---------- Home's one play button ----------

   FOUNDER, 2026-09-24: "Add a play button at the Home Screen level and start
   playing whatever is first in that list (whether it be Suggested or a
   Playlist or whatever)".

   ONE control under the greeting. It plays the first PLAYABLE thing on Home,
   walking the rails in the order Home draws them — Jump back in, Forays for
   you, Playlists for you, Suggested — and within a rail, its cards in order. A
   rail whose cards cannot play (a Foray that does not resolve, a playlist whose
   episodes have all left the catalogue) is passed over rather than stopped at:
   a button that names a thing and then fails is worse than one that names the
   next thing. It is not rendered at all only when nothing on Home can play.

   Each kind starts the way its own page starts it, through the same code:
     foray     the Foray page's main button — `playForay`, resuming where the
               listener left it (`forayResume`), else from the top;
     episode   a row's ▶ (`startEpisodePlay`);
     playlist  its first playable row, with the playlist's rows as the list
               continuous playback goes on through — a saved playlist, a
               generated one, or a Suggested subject queue alike (the detail
               page's `playlistCtx`, so a real playlist's `last_played_at` is
               stamped exactly as a row's ▶ stamps it).

   Its name says what it will play ("Play <title>"), because "Play" alone on a
   screen of twenty things answers nothing. */

/** Home's rails as candidate lists, in render order. Each rail is the data the
    rail itself draws from, so the order cannot drift from what is on screen. */
/* `picks` is renderHomeV2's one computation of the rails' contents (audit round
   3, app-2-12): computed once per render and handed to the button AND the rail
   renderers, instead of each of them re-running every pick (generatedPlaylists
   walks and sorts the whole pool) a second time. Absent, each is computed here,
   as before. */
function homePlayRails(picks = homeRailPicks()) {
  const rails = [];
  rails.push(picks.jumpBackIn.map(c =>
    c.kind === "foray" ? { kind: "foray", id: c.id, title: c.title }
      : c.kind === "episode" ? { kind: "episode", item: c.item, title: c.title }
        : { kind: "playlist", playlist: playlistById(c.id) }));
  const forays = picks.forays;
  rails.push(forays ? forays.picks.concat(forays.drafts).map(f => ({ kind: "foray", id: f.id, title: f.title })) : []);
  const { own, generated } = picks.playlists;
  rails.push(own.concat(generated).map(p => ({ kind: "playlist", playlist: p })));
  rails.push((state.cardSlots || []).map(slot => ({ kind: "playlist", playlist: subjectQueueById("subject-" + slot.branch) })));
  return rails;
}

/** A candidate made concrete, or null when it cannot play right now. */
function homePlayable(c) {
  if (c.kind === "foray") {
    const r = resolveListedForay(c.id);
    if (!r || !Array.isArray(r.playable) || !r.playable.length) return null;
    return { kind: "foray", r, title: c.title || r.title || c.id };
  }
  if (c.kind === "episode") {
    const item = c.item && c.item.id ? (liveEpisode(c.item.id) || c.item) : null;
    if (!item || !item.audio_url) return null;
    return { kind: "episode", item, title: c.title || item.title || "this episode", list: [], ctx: null };
  }
  const p = c.playlist;
  if (!p) return null;
  const rows = resolveParts(p).filter(r => r.state === "live" && isPlayableId(r.item.id));
  if (!rows.length) return null;
  const ctx = playlistCtx(p);
  return {
    kind: "playlist", title: p.title || "this playlist", ctx,
    item: liveEpisode(rows[0].item.id),
    list: rows.map(r => ({ id: r.item.id, ctx })),
  };
}

/** What Home's play button will play, or null (nothing on Home can). */
/** Every Home rail's picks, once. */
function homeRailPicks() {
  return { jumpBackIn: jumpBackInEntries(), forays: foraysForYouPicks(), playlists: playlistsForYouPicks() };
}

function homePlayTarget(picks) {
  for (const rail of homePlayRails(picks)) {
    for (const c of rail) {
      const t = homePlayable(c);
      if (t) return t;
    }
  }
  return null;
}

/* The target the rendered button names. Set at render time and read at the
   press, so the press plays exactly what the label promised. */
let homePlayPending = null;

function homePlayHtml(picks) {
  const t = homePlayTarget(picks);
  homePlayPending = t;
  if (!t) return "";
  return `<div class="hv2-play-row">
    <button type="button" class="hv2-play" data-home-play aria-label="${esc(`Play ${t.title}`)}">
      <span class="hv2-play-glyph" aria-hidden="true">▶</span>
      <span class="hv2-play-text">Play</span>
      <span class="hv2-play-title">${esc(t.title)}</span>
    </button>
  </div>`;
}

function bindHomePlay(scope) {
  const btn = scope && typeof scope.querySelector === "function" ? scope.querySelector("[data-home-play]") : null;
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener("click", () => playHomeTarget(homePlayPending, btn));
}

/** The press. The loading mark is the row ▶'s (`data-loading`, which
    styles.css breathes and holds still under Reduce Motion), and a second
    press while it is set does nothing: the impatient thumb is not a second
    start. */
async function playHomeTarget(t, btn = null) {
  const player = window.ForayPlayer;
  if (!t || !player) return false;
  if (btn && btn.dataset.loading === "1") return false;
  if (btn) { btn.dataset.loading = "1"; btn.setAttribute("aria-busy", "true"); }
  try {
    return t.kind === "foray" ? await startHomeForay(player, t.r) : await startHomeEpisode(player, t);
  } finally {
    if (btn) { delete btn.dataset.loading; btn.removeAttribute("aria-busy"); }
  }
}

async function startHomeEpisode(player, t) {
  const item = t.item;
  if (!item || !item.audio_url) return false;
  /* IS IT ALREADY THE PLAYER'S? A paused one resumes where it is; a playing
     one is left alone — this button says "Play", so it never pauses. */
  if (player.isCurrent?.(item.id)) {
    if (!player.isPlaying?.(item.id)) await player.togglePlayback?.();
    return true;
  }
  return startEpisodePlay(item.id, item, { ctx: t.ctx, list: t.list });
}

async function startHomeForay(player, r) {
  const live = player.forayStatus?.();
  if (live && live.forayId === r.id) {
    if (!live.running) await player.forayToggle?.();
    return true;
  }
  let resume = null;
  try { resume = player.forayResume?.(r.id, { resolved: r }) || null; } catch (_) { resume = null; }
  /* The call into the player comes before any await: the tap is the gesture
     Safari lets audio start inside (#225, the Foray page's own rule). */
  const at = resume ? { startElapsedSec: resume.elapsedSec } : { startIndex: 0 };
  let started;
  try {
    started = Promise.resolve(player.playForay(r, { ...at, discoverDoc: state.discover }));
  } catch (err) {
    started = Promise.reject(err);
  }
  logEvent("foray_play", {
    foray_id: r.id, segments: r.playable.length,
    resumed_from_sec: resume ? Math.round(resume.elapsedSec) : null,
  });
  let report = null;
  try {
    report = await started;
  } catch (err) {
    console.warn("[4a] Foray start failed", err);
    try { player.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
    noteTapFailure("start", err);
    return false;
  }
  if (!report) {
    /* Superseded (another start took the player mid-load) is not failed. */
    const now = player.forayStatus?.();
    if (now && now.forayId !== r.id) return false;
    try { player.reportPlayFailure?.(null); } catch (_) { /* the bar is best-effort */ }
    return false;
  }
  trySyncEvents();
  return true;
}

/** "Jump back in": forayResumeRows() plus the ordinary-episode continue
    banner, as one horizontal scroller — the mockup's own shape for this
    section (docs/ux/foray-mockup.jsx `HomeScreen`'s first row). Degrades
    to "" when neither has anything to resume, so the section simply does
    not render rather than showing an empty rail. */
/**
 * "Jump back in" — FORAYS, PODCASTS AND PLAYLISTS, most recent first.
 *
 * FOUNDER, 2026-09-18: "Only forays are in the jump back in section, podcasts
 * and playlists should be there too."
 *
 * WHY ONLY FORAYS WERE THERE, because the episode card was not missing — it was
 * unreachable. It came from `currentContinue()`, which reads `cp_lastpick`, and
 * that key has three gates the founder's own listening fails:
 *
 *   1. `cp_lastpick` was written ONLY when `state.poolIds.has(id)` — the discover
 *      pool. An episode opened from a show page (Lex's episode list, which is
 *      what he was listening to) is not in the pool, so nothing was ever
 *      recorded for it.
 *   2. It is gated on `duration_min > commute + 5`, so a short episode never
 *      qualified however recently it was played.
 *   3. It records what you TAPPED, not what you PLAYED or how far you got.
 *
 * So the episode card now comes from the same durable pointer that restores the
 * now-playing ribbon (`player/episode-progress.js` + `PositionStore`), which has
 * none of those three problems: it is written when playback actually starts, for
 * any episode from anywhere, and the position behind it is the real one.
 *
 * PLAYLISTS need no new storage at all — `last_played_at` has been stamped on
 * every play since #558, and two other surfaces already sort by it. They were
 * simply never offered here.
 *
 * ORDERED BY RECENCY ACROSS ALL THREE, not grouped by kind. A rail that always
 * put Forays first would reproduce the complaint the day a Foray was the oldest
 * thing on it. Forays carry no timestamp in `forayResumeList`'s rows, so they
 * sort on the store's own `updated_at` where present and fall to the end
 * otherwise — deliberately conservative: an unknown time must not out-rank a
 * known one.
 */
function jumpBackInV2Html(cards = jumpBackInEntries()) {
  if (!cards.length) return "";
  return `<section class="hv2-section hv2-jbi">
    <h2 class="hv2-title">Jump back in</h2>
    <div class="hv2-hscroll">${cards.map(c => jumpBackInCardHtml(c, { inSection: true })).join("")}</div>
  </section>`;
}

/** The rail's contents as data — one array of `{kind, at, ...}`, sorted, capped.
    Split out from the markup so the ORDERING is testable without parsing HTML. */
function jumpBackInEntries(limit = 6) {
  const entries = [];

  for (const p of forayResumeRows()) {
    entries.push({
      /* `updated_at`, the shape `forayResumeList` actually returns — spelling
         this `updatedAt` silently sorted every Foray to the end of the rail,
         which is the founder's complaint with the kinds swapped round. */
      kind: "foray", id: p.id, at: p.updated_at || null,
      title: p.title || p.id, sub: "Foray", percent: p.percent, left: p.label,
    });
  }

  const ep = lastEpisodeCard();
  if (ep) entries.push(ep);

  /* `.filter(p => p.last_played_at)` and not "or created": a playlist you built
     and never played is not something you are jumping BACK into. It has its own
     home on the playlists page.

     WHERE YOU ARE IN IT, like the Foray and episode cards beside it (audit
     round 2, honesty-7): the rail mixed three grammars — a bar and "N min
     left" on those two, a bare "12 episodes" here — though the playlist page
     itself knew "3 played". The card reads `hasOpened` (history OR a stored
     position) — the page's next-up marker's reading; the page's own header
     count moved to the player's "played" verdict in honesty-6.
     NO ZERO (round-2 review; copy-13, "a zero is not a fact worth a line"): a
     played playlist can reach 0 here once its ids age out of the 200-entry
     history ring, and the card then said "0 of 12 played" over an empty bar
     beside "12 episodes" — the page drops its "0 played" the same way. */
  const history = new Set(pickedHistory());
  for (const p of playlists().filter(p => p.last_played_at)) {
    const rows = resolveParts(p);
    const played = rows.filter(r => hasOpened(r.item.id, history)).length;
    entries.push({
      kind: "playlist", id: p.id, at: p.last_played_at,
      title: p.title || p.name || "Playlist",
      sub: playlistLengthLabel(p),
      percent: rows.length && played ? Math.round((played / rows.length) * 100) : null,
      left: rows.length && played ? `${played} of ${rows.length} played` : "",
    });
  }

  /* An entry with no timestamp sorts last rather than first — an unknown time
     must never out-rank a known one. */
  return entries
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, limit);
}

/** The episode entry, from the durable pointer the ribbon restores from. */
function lastEpisodeCard() {
  const player = window.ForayPlayer;
  if (typeof player?.lastEpisodeCard !== "function") return null;
  try {
    const r = player.lastEpisodeCard();
    if (!r) return null;
    /* Seeded into the item index so a tap can play it without waiting for a
       catalogue that may not hold it at all — the pointer's snapshot carries
       `audio_url` precisely so this is possible.
       NEVER OVER A RICHER ENTRY (audit round 3, app-2-1), exactly as
       playerPointerEpisode seeds it: the pointer carries seven fields, and
       Home renders on every open, so an unguarded snapshot replaced the played
       episode's pool or show-page entry — notes, chapters, date, topics — with
       the thin pointer for the rest of the session. */
    if (!state.itemIndex[r.id]) snapshot(r.id, r);
    return {
      /* `item` is the snapshot itself, carried so the card can render a play
         button: `playBtn` needs `audio_url` to decide whether to render at all,
         and `title` for its aria-label. */
      kind: "episode", id: r.id, at: r.updated_at || null, item: r,
      title: r.title || r.id, sub: r.show || "",
      percent: r.percent, left: r.label,
    };
  } catch (_) {
    return null;
  }
}

/* A TAG NAMES WHAT ITS SECTION DOES NOT (audit round 2, visual-9). Every card
   in Home's "Jump back in" rail opened with an amber JUMP BACK IN tag directly
   under the "Jump back in" heading — the section's name, restated on each card
   in it. `inSection` is the renderer saying "the heading above already says
   this"; a card on a MIXED surface (a rail of several kinds, a search result)
   leaves it off and keeps the tag, which is the one place it tells the
   listener something. */
function jumpBackInCardHtml(c, { inSection = false } = {}) {
  const bar = typeof c.percent === "number"
    ? `<span class="fy-bar"><span class="fy-bar-fill" data-pct="${esc(String(c.percent))}"></span></span>`
    : "";
  const left = c.left ? `<span class="hv2-jbi-left">${esc(c.left)}</span>` : "";
  const sub = c.sub ? `<span class="hv2-jbi-sub">${esc(c.sub)}</span>` : "";
  /* The `picked` logging attributes ride on the episode card only, as before —
     a Foray and a playlist are not pool episodes and `bindPickLogging`'s
     handler reads `data-ep` as an episode id. */
  const ev = c.kind === "episode"
    ? ` data-ev="picked" data-ep="${esc(c.id)}" data-ctx="jbi-episode"`
    : "";
  /* PLAY WITHOUT OPENING THE EPISODE (founder, 2026-09-21: "It would be good if
     there were a play button directly on that card, as it is I need to press the
     card then press play").

     Episodes only. A Foray and a playlist are sequences whose card is a way IN to
     a running order, and a one-tap play on either would be choosing a starting
     point on the listener's behalf; an episode has exactly one thing to play.

     `playBtn` is the same control every row and card already uses, so it inherits
     `bindPlay` (already called on this page) and with it the `preventDefault` +
     `stopPropagation` that stops the press ALSO following the card's own link —
     the exact reason that handler has them. It renders "" when the item has no
     `audio_url`, which is the honest outcome for a card we cannot play from.

     `lastEpisodeCard` has already `snapshot()`ed the row into `state.itemIndex`,
     which is where `bindPlay` looks the id up — so the button can play an episode
     the catalogue has never heard of, which is the whole point of the pointer. */
  const play = c.kind === "episode" ? playBtn(c.item, "jbi-episode") : "";
  const id = esc(encodeURIComponent(c.id));
  /* THE `#/` IS LITERAL IN THE TEMPLATE, and only the route segment and the id
     are interpolated — the form every other link in this file uses.

     Two earlier drafts got this wrong and the security suite caught both. The
     first built one `c.href` string and interpolated it whole, which
     "every interpolated href and src passes through safeUrl" rejects. The
     obvious repair — wrapping it in `safeUrl` — would have been WORSE than
     noisy: `safeUrl` admits http(s) only and answers "#" for anything else, so
     every in-app route here would have become a dead link. The real rule
     underneath that test is that a link's SCHEME must be fixed by the code and
     never carried in data, and a literal `#/` prefix is how this file says so. */
  const route = c.kind === "foray" ? "foray" : c.kind === "playlist" ? "playlist" : "episode";
  /* A CARD WITH A STRETCHED LINK (audit 2026-09-22, qa row 78): the title is
     the one real <a> (styles.css stretches its ::after over the card) and the
     play button is its SIBLING, lifted above it — not a <button> inside an <a>,
     which is invalid HTML that reads as "link, …, Play …" to a screen reader
     and only behaved on a pointer because bindPlay calls preventDefault. The
     `picked` attributes ride on the link, which is what bindPickLogging binds. */
  return `
    <div class="hv2-jbi-card">
      ${inSection ? "" : `<span class="hv2-jbi-kicker">Jump back in</span>`}
      <a class="hv2-jbi-title hv2-jbi-link" href="#/${route}/${id}"${ev}>${esc(c.title)}</a>
      ${sub}${bar}${left}${play}
    </div>`;
}

/** One Foray card for "Forays for you", carrying its SegmentStrip (U-04) —
    the one component the plan names as what makes a Foray legible as a
    different object from an episode. Resolves each Foray through the same
    bridge welcomeStripHtml() (U-09) already uses; a Foray whose segments
    fail to resolve degrades to a card with no strip, never an error, same
    contract as that function's own try/catch. `stretch` renders the
    visible label plus the required bridge line naming the Foray's own
    subject; a non-stretch card gets neither. */
function forayCardV2Html(foray, { stretch = false, draft = false } = {}) {
  const player = window.ForayPlayer;
  const r = resolveListedForay(foray.id);
  let stripHtml = "";
  if (r && typeof player?.segmentStripHtml === "function") {
    try {
      /* mergeNarration — same reason as welcomeStripHtml() above: a card is not
         a scrub target, so a run of bridges may be one bar. */
      stripHtml = player.segmentStripHtml(r.playable, { size: "sm", mergeNarration: true }) || "";
    } catch (_) {
      stripHtml = ""; // malformed segments/sources must not break Home
    }
  }
  /* How long, and what it is made of (audit round 2, p-foray-8): the card was
     a title and a strip, and the strip's length is only in its aria-label. */
  const facts = forayFactsLabel(r, player);
  const subject = subjectLabel((foray.topic || "").split("/")[0]);
  return `<a class="hv2-foray-card${stretch ? " hv2-stretch" : ""}" href="#${esc(forayRoutePath(foray.id))}">
    ${stretch ? `<span class="hv2-stretch-tag">Stretch</span>` : ""}
    ${draft ? `<span class="hv2-draft-tag">draft</span>` : ""}
    <span class="hv2-foray-title">${esc(foray.title)}</span>
    ${facts ? `<span class="hv2-foray-sub">${esc(facts)}</span>` : ""}
    ${stripHtml}
    ${stretch ? `<p class="hv2-bridge">${stretchBridgeLine(subject)}</p>` : ""}
  </a>`;
}

/** "Forays for you" (D1, U-03/U-04): the published (+ explicitly unlocked)
    Forays, floored per pickWithStretchFloor over each Foray's own topic
    root. Renders nothing when there are no listable Forays at all —
    absence is a real state here, same convention forayListHtml() and
    every other optional Home block already follow.

    THE TEST TRACK (showDraftsOn): the four picks are chosen from exactly the
    list they were chosen from before — the switch never enters the floor or
    the interest ranking — and the drafts it admitted are APPENDED after them,
    every one, badged "draft", in draftTrackOrder. Appended rather than pooled
    because the founder turned this on to find a specific generated Foray, and
    a four-card pick over six candidates would hide two of them. */
/** The "Forays for you" pick: the four cards, which one is the stretch (-1 for
    none), and the test-track drafts appended after them — or null when there
    is nothing to list. One function, so the row Home renders and any sentence
    ABOUT that row (the intro popup's stretch claim, p-first-11) read the same
    answer. */
function foraysForYouPicks() {
  if (!state.forays || !window.ForayPlayer) return null;
  const { listed, drafts } = splitTestTrackDrafts(opts => window.ForayPlayer.listForays(state.forays, opts));
  if (!listed.length && !drafts.length) return null;
  const { picks, stretchIndex } = pickWithStretchFloor(listed, {
    branchFn: f => (f.topic || "other").split("/")[0],
    scoreFn: f => interestScore({ topics: [(f.topic || "other").split("/")[0]] }),
    take: 4,
  });
  return { picks, stretchIndex, drafts };
}

function foraysForYouHtml(pick = foraysForYouPicks()) {
  if (!pick) return "";
  const { picks, stretchIndex, drafts } = pick;
  return `<section class="hv2-section hv2-forays">
    <h2 class="hv2-title">Forays for you</h2>
    <div class="hv2-hscroll">${picks.map((f, i) => forayCardV2Html(f, { stretch: i === stretchIndex })).join("")}${drafts.map(f => forayCardV2Html(f, { draft: true })).join("")}</div>
  </section>`;
}

/** The one-line notice Home carries while the test track is on, so a device
    left with the switch flipped says so on the first screen rather than
    quietly listing work nobody published. */
function testTrackNoticeHtml() {
  if (!showDraftsOn()) return "";
  return `<p class="hv2-test-track note">Showing draft Forays — test track</p>`;
}

/** One playlist card for "Playlists for you" — own recent playlists render
    exactly like a subject queue's card (shared shape, #276), generated
    ones carry the "Generated for you" badge D5 requires so a listener
    never mistakes a generated grouping for one they built. */
function playlistCardV2Html(p, { generated = false } = {}) {
  const count = (p.items || []).length;
  return `<a class="hv2-playlist-card" href="#/${esc(playlistRoute(p))}">
    ${generated ? `<span class="hv2-generated-badge">Generated for you</span>` : ""}
    <span class="hv2-playlist-title">${esc(p.title)}</span>
    <span class="hv2-playlist-sub">${countLabel(count, "episode")}</span>
  </a>`;
}

/** "Playlists for you" (D5): the listener's own recent playlists first,
    then up to three generated from state.interests (generatedPlaylists():
    the strongest interest leaves, filled from the discover pool). NOT the
    card slots — F14: that made this section "Episodes for you" (now "Suggested")
    regrouped. */
/** The rail's playlists, in the order it draws them: own recent first, then
    generated. One function, so the rail and Home's play button (homePlayTarget)
    cannot disagree about which playlist is first. */
function playlistsForYouPicks() {
  const own = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created || "").localeCompare(a.last_played_at || a.created || ""))
    .slice(0, 3);
  return { own, generated: generatedPlaylists() };
}

function playlistsForYouHtml({ own, generated } = playlistsForYouPicks()) {
  if (!own.length && !generated.length) return "";
  const cards = own.map(p => playlistCardV2Html(p, { generated: false }))
    .concat(generated.map(p => playlistCardV2Html(p, { generated: true })));
  return `<section class="hv2-section hv2-playlists">
    <h2 class="hv2-title">Playlists for you</h2>
    <div class="hv2-hscroll">${cards.join("")}</div>
  </section>`;
}

/** One episode card for "Suggested" — miniCard()'s existing markup
    plus the visible bridge line D1's copy rule requires on a stretch
    slot, which miniCard() itself does not render (its "Stretch" tag is a
    hover-only `title`, pinned as-is elsewhere and left untouched here).
    Composes rather than forks: the card body is exactly miniCard(slot),
    with the bridge line appended after it for a stretch slot only. */
function miniCardV2(slot) {
  const card = miniCard(slot);
  if (slot.role !== "stretch") return card;
  // Insert the bridge line just before the card's closing tag.
  const bridge = `<p class="hv2-bridge">${stretchBridgeLine(subjectLabel(slot.branch))}</p></div>`;
  return card.replace(/<\/div>$/, bridge);
}

/** "Suggested": buildCards()'s ranked discover-pool picks, i.e.
    state.cardSlots verbatim — the SAME floor buildCards() already
    computes for the flag-off four-card Home, so this section and that
    one can never disagree about which slot is the stretch. renderHomeV2()
    guarantees state.cardSlots is already built before this runs (same as
    v1's own renderHome()), so this only guards a caller that invokes this
    function directly (e.g. a future test). */
function suggestedHtml() {
  if (!state.cardSlots.length) return "";
  return `<section class="hv2-section hv2-suggested">
    <h2 class="hv2-title">Suggested</h2>
    <div class="hv2-cards">${state.cardSlots.map(miniCardV2).join("")}</div>
  </section>`;
}

function renderHomeV2() {
  setBodyClass("view-home");
  if (!state.cardSlots.length) buildCards();
  const picks = homeRailPicks();
  $("#view").innerHTML = `
    <div class="home hv2-home">
      ${homeGreeting()}
      ${homePlayHtml(picks)}
      ${testTrackNoticeHtml()}
      ${jumpBackInV2Html(picks.jumpBackIn)}
      ${foraysForYouHtml(picks.forays)}
      ${playlistsForYouHtml(picks.playlists)}
      ${suggestedHtml()}
    </div>`;

  offerHomeOnboarding();

  sizeProgressBars($("#view"));
  if (window.ForayPlayer && typeof window.ForayPlayer.applyStripGrow === "function") {
    window.ForayPlayer.applyStripGrow($("#view"));
  }

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
  bindHomePlay($("#view"));
}

/* ---------- Forays page (#/forays) ----------

   The menu destination the foray list moved to (founder instruction, item 2:
   "get rid of the recommended foray at the top of Home. Move it into a page
   accessible via the menu exclusively for Forays").

   "Jump back in" moves here WITH the list rather than staying on Home. The
   two render the same `.fy-home-row` markup and read as one block, so
   splitting them would have left Home with a row that looks exactly like the
   thing the founder asked to remove. Both are still gated by the same
   visibility rule (forayCards / forayResumeRows) — an unpublished Foray is
   listed only to someone who arrived with its `?foray=` link this session. */
/* THE THREE STATES, AND WHAT THE PAGE SAYS ABOVE THEM (audit 2026-09-22).

   It used to be synchronous and take `forayCards()` at face value — and that
   function answers `[]` for "the player module has not evaluated yet", for "the
   Forays document failed to load" and for "there genuinely are none" alike. So a
   cold deep link, a slow phone or a stale cache painted "0 forays" and "No forays
   right now", and nothing ever repainted it. The detail route one screen away
   already awaited the player and named each failure; this page threw that
   distinction away. Now:

     loading — the module is not here yet: say so, claim nothing, wait for it the
               bounded way `renderForay` does, then paint again.
     failed  — the module never came, or the document did not load: say which,
               with "Try again" wired to the thing that failed.
     empty   — only when both are here and the list really is empty.

   NO COUNT IN THE SUBTITLE. "1 foray" was the page's only line of text, and it
   told a listener who skipped the first-run sheet nothing about what a Foray
   IS — which, after that sheet, nothing in the app said again (persona audit
   #18/#37/#45/#83: "Skip for now" deleted the product's only explanation of
   itself). The subtitle is now that explanation, from the same constant the
   sheet uses, so the two cannot drift and the sheet's "Skip for now" is no
   longer destructive: the sentence has a permanent home a tap away. */
function renderForays() {
  setBodyClass("view-page");
  const head = `
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>Forays</h2>
        </div>
      </div>
      <p class="note fy-about">${esc(forayAbout())}</p>`;
  const paintStatus = (body) => { $("#view").innerHTML = `<div class="page">${head}${body}</div>`; };

  if (!window.ForayPlayer) {
    paintStatus(`<p class="note">Loading…</p>`);
    playerBridge().then((player) => {
      if ((location.hash || "") !== "#/forays") return; // the listener has moved on
      if (player) { renderForays(); return; }
      /* A module that FAILED gets the reload, a module that is merely slow gets
         the re-await — see playerModuleFailed(). */
      if (playerModuleFailed()) {
        paintStatus(reloadNoteHtml("The player didn't load."));
        bindReload($("#view"));
        return;
      }
      paintStatus(failedNoteHtml("The player didn't load."));
      bindRetry($("#view"), renderForays);
    });
    return;
  }
  if (!state.forays) {
    paintStatus(failedNoteHtml("Couldn't load forays right now."));
    bindRetry($("#view"), retryForayDocs);
    return;
  }

  const list = forayCards();
  const resume = forayResumeRows();
  $("#view").innerHTML = `
    <div class="page">
      ${head}
      ${jumpBackInHtml(resume)}
      ${list.length
        ? forayListHtml({ inSection: true })
        : `<p class="note">No forays right now — 4a puts these together by hand, so they arrive a few at a time.</p>`}
    </div>`;
  sizeProgressBars($("#view"));
}

/* One playable row = one play control, never two — and there is no other
   kind of control any more (product rule, 2026-09-02, Joey: "we should be
   able to play all podcasts from the app. If we can't, let's fix that.").
   The prior "Listen in your podcast app ↗" link-out is gone entirely: it is
   not what a missing audio_url degrades to, it is deleted. An item with
   audio_url gets the in-app ▶ button. An item WITHOUT one (a genuine
   ingestion edge case — see notPlayableNote()) gets an honest inline note
   instead of a fake button or an external hop — never both, never neither
   silently. */
/** Where the listener is in one episode, as the PLAYER reads it (audit
    2026-09-22, persona #78: "nothing on any list tells me which episodes I
    already played, or how far in I am"). One reading — `episodeProgress` in
    player/episode-progress.js, the same one "Jump back in" uses — reached
    through the bridge, because app.js cannot import it and a second copy of
    "what counts as finished" here is how the two would come to disagree.
    `null` when the bridge has not arrived: a row then shows no mark, which
    claims nothing, rather than a guess. */
/** An episode's length in seconds: its `duration_sec` when it has one, else
    its minutes (docs/DECISIONS.md 2026-09-23, "One duration dialect"), else
    null. ONE helper for every reader (audit round 3, app-2-7): the notes'
    timestamp guard used the rounded minutes alone and turned real stamps in
    the last half-minute into dead text. `upperBound` is for a guard: minutes
    are ROUNDED, so the true length can be up to 29 s past `min * 60`. */
function itemDurationSec(item, { upperBound = false } = {}) {
  if (Number(item?.duration_sec) > 0) return Number(item.duration_sec);
  const min = Number(item?.duration_min);
  return min > 0 ? min * 60 + (upperBound ? 29 : 0) : null;
}

function rowProgress(item) {
  const bridge = window.ForayPlayer;
  if (!item?.id || typeof bridge?.episodeProgress !== "function") return null;
  const durSec = itemDurationSec(item);
  try { return bridge.episodeProgress(item.id, durSec); } catch (_) { return null; }
}

/** Has the listener opened this episode? `cp_history` OR a stored position.
    History alone decayed: it is a 200-entry ring, so a playlist's "N played"
    silently fell as the listener started other episodes (audit 2026-09-22) —
    positions are one row per episode and are never rotated out. */
function hasOpened(id, history) {
  if (!id) return false;
  if (history.has(id)) return true;
  const p = rowProgress({ id });
  return !!p && p.state !== "unplayed";
}

/* NUMBERS MEAN ORDER (audit round 2, visual-10). Every episode list wore the
   numbered circle Up Next uses — a show's episodes (newest as "1"), search
   results, Saved, History, "More from this show" — so a Saved list read as a
   playlist the listener never built. Apple numbers its queue and nothing
   else; here the number stays where the order IS the content: a playlist's
   detail page (ctx "playlist-…", "subject-…", "generated-…", where the
   highlighted number is "start here") and Up Next (upNextRow, which always
   numbers). styles.css indents the second tier only when a number is there. */
const ORDERED_ROW_CTX = /^(playlist|subject|generated)-/;
function orderedRowCtx(ctx) {
  return ORDERED_ROW_CTX.test(String(ctx || ""));
}

function epRow(item, idx, ctx, nextIdx) {
  const inApp = playBtn(item, ctx);
  const unavailable = inApp ? "" : notPlayableNote();
  const dateStr = fmtDate(item.release_date);
  const prog = rowProgress(item);
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  return `<div class="ep-row">
    ${orderedRowCtx(ctx) ? `<span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>` : ""}
    <div class="info">
      <div class="t"><a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}</div>
      <div class="s">${joinMeta(showNameLink(item.show, item.show_id), fmtDur(episodeMinutes(item)), esc(dateStr), progHtml)}</div>
    </div>
    ${inApp}${starBtn(item.id)}${upNextBtn(item.id, item)}${unavailable}
  </div>`;
}

/* The only thing that fills the control slot when an episode genuinely has
   no audio_url — never a link elsewhere. As of the Stage 3b RSS ingestion
   (kanban t_567b570f), this is a rare, named edge case, not a routine
   degrade: an episode never enters the catalogue without a real enclosure
   (ingestShowFeed.ts drops any item with none), so this only fires for the
   small number of pre-existing curated-pool items a one-off backfill could
   not resolve — a members-only/paywalled episode absent from the public RSS
   feed, or a video-only enclosure with no audio track (see
   tools/refresh/backfill-audio.mjs's UNRESOLVED report: 8 of 1855+27 items,
   0.43%, as of 2026-09-03). Plain text, no href, nothing to click — an
   honest dead end beats a button that does nothing and a link that leaves
   the app.

   No `title=` (audit round 2, a11y-11): a tooltip is unreachable on a phone
   and is not the control's name to a screen reader. The explanation lives as
   visible text on the episode page (NOT_PLAYABLE_WHY); a row has room for
   the chip alone, and "Not available to play" explains itself. */
function notPlayableNote() {
  return `<span class="not-playable">Not available to play</span>`;
}
const NOT_PLAYABLE_WHY = "4a could not get an audio file for this episode, so it cannot play here.";

/* A part the live pool no longer carries, rendered from what the playlist saved
   (#276). It keeps its number and its place, so the count above it stays true.
   It has no in-app audio to play (`audio_url` is deliberately not persisted
   because it moves) — as of 2026-09-03 there is no link-out fallback for
   that any more, product rule: 4a plays everything itself or says so
   honestly, it never sends a listener elsewhere. So an aged-out part gets
   the same notPlayableNote() plain-text state epRow gives a genuine
   ingestion edge case, not a link to another app.

   IT KEEPS ITS STAR, and that closes a loop rather than decorating the row:
   `cp_saved` holds whole snapshots, and hydratePlaylistParts reads it, so a
   starred part is one the migration can always name again. Starring an aged-out
   episode is the one action that makes it permanently recoverable. It works
   because renderPlaylistDetail seeds the snapshot into `state.itemIndex`, which
   toggleStar requires; an `unnamed` part has no snapshot to store, so it gets no
   star.

   NO "+ Up Next" (audit round 2, p-impatient-10). It had one from Stage 1, when
   the row still linked out to another app; #452 removed the link-out and the
   button stayed, offering to queue an episode the same row says cannot play.
   `addToQueue` refuses such an id anyway; not drawing the control is what keeps
   the row from promising it. */
function archivedRow(item, idx, ctx) {
  const named = !!item.title;
  const unavailable = named ? notPlayableNote() : "";
  const dateStr = named ? fmtDate(item.release_date) : "";
  return `<div class="ep-row gone">
    ${orderedRowCtx(ctx) ? `<span class="q-num">${idx + 1}</span>` : ""}
    <div class="info">
      <div class="t">${named ? `<a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}` : "Episode no longer in the catalogue"}</div>
      <div class="s">${named
        ? joinMeta(showNameLink(item.show, item.show_id), fmtDur(episodeMinutes(item)), esc(dateStr))
        : "Saved before 4a kept episode details"}</div>
    </div>
    ${named ? starBtn(item.id) : ""}${unavailable}
  </div>`;
}

/* The one honest sentence about a shortfall, or nothing. Says what happened and
   what can be done about it, and does not imply the listener did anything —
   ageing out of the pool is the app's doing, not theirs. */
function partsNote(rows) {
  const archived = rows.filter(r => r.state === "archived").length;
  const unnamed = rows.filter(r => r.state === "unnamed").length;
  if (!archived && !unnamed) return "";
  const parts = [];
  if (archived) {
    const one = archived === 1;
    parts.push(`${archived} episode${one ? " is" : "s are"} not available right now, so ${one ? "it" : "they"} cannot play — ${one ? "it stays listed" : "they stay listed"} so you can see where ${one ? "it fits" : "they fit"} in the playlist.`);
  }
  if (unnamed) {
    const one = unnamed === 1;
    /* EVERY plural agrees, verbs included. The first draft pluralised the noun and
       not the verb, so a listener with exactly one gap read "if the episode
       return" — and the note a reviewer reads is never the one that ships to them.
       It also no longer claims rebuilding REPLACES this playlist: buildPlaylist
       mints a new id and prepends a new playlist, leaving this one untouched. */
    parts.push(`${unnamed} episode${one ? " was" : "s were"} saved before 4a kept episode details and cannot be named yet — ${one ? "it" : "they"} will fill in if the episode${one ? " returns" : "s return"} to the catalogue, and building the same playlist again from the Playlists page gives you a fresh one from what 4a has today.`);
  }
  return `<p class="note">${esc(parts.join(" "))}</p>`;
}

function renderPlaylistDetail(id) {
  setBodyClass("view-page");
  const p = playlistById(id) || subjectQueueById(id) || generatedPlaylistById(id);
  /* A gone playlist still gets a real page head, ‹ included: with ‹ now
     going back one real step (see § in-app history) instead of always
     Home, an entry for a just-removed playlist sits one step behind the
     Playlists list, so landing here with no ‹ at all would be a dead end
     for whoever tapped a now-stale link (e.g. from the drawer). */
  if (!p) {
    $("#view").innerHTML = statusPageHtml({ title: "Playlist", note: "Playlist not found.", back: "#/playlists" });
    return;
  }
  fullPool(); // populate itemIndex
  const rows = resolveParts(p);
  /* An archived part goes into the snapshot cache under its own id so the rest of
     the app can describe it: without this, starring one is a no-op (toggleStar
     needs a snapshot) and a `picked` from one reports no topics.

     This is safe ONLY because liveness is liveEpisode(), not "is in itemIndex":
     a part carries no audio_url, so a seeded part cannot read as playable.
     While it was the latter, this loop was the bug: it taught the cache the id, and
     the next render of the same playlist called the part live again. The absence
     check is kept because the pool's copy is always the better one, and a second
     render must not replace a full snapshot with a partial. */
  for (const r of rows) {
    if (r.state === "archived" && !state.itemIndex[r.item.id]) state.itemIndex[r.item.id] = r.item;
  }
  const history = new Set(pickedHistory());
  /* The "next" marker belongs on the next part that can actually be opened.
     Both it and the count below read `hasOpened` — history OR a stored position
     — so neither can regress when the 200-entry history ring rotates an
     episode out (audit 2026-09-22). */
  const nextIdx = rows.findIndex(r => r.state === "live" && !hasOpened(r.item.id, history));
  /* "PLAYED" MEANS FINISHED, the same word the rows use (audit round 2,
     honesty-6). This counted `hasOpened` — history OR any stored position — so a
     playlist read "2 played" above rows that said "31 min left" and nothing at
     all: one screen, two definitions. The count now reads the player's own
     verdict (`rowProgress`, state "played") per row, so the header and the row
     labels cannot disagree; `hasOpened` stays what the next-up marker asks. */
  const played = rows.filter(r => rowProgress(r.item)?.state === "played").length;
  const ctx = playlistCtx(p);

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${joinMeta(countLabel(rows.length, "episode"), p.isSubject ? "picked for you" : (p.isGenerated ? "generated for you" : "playlist"), played ? `${played} played` : "")}</p>
        </div>
      </div>
      ${p.sparse ? `<p class="note">Only found a few on this — here's what 4a has.</p>` : ""}
      ${p.relaxed === "duration" ? `<p class="note">Couldn't match the length you asked for — here's what 4a found without it.</p>` : ""}
      ${partsNote(rows)}
      ${rows.map((r, i) => r.state === "live" ? epRow(r.item, i, ctx, nextIdx) : archivedRow(r.item, i, ctx)).join("")}
      ${(p.isSubject || p.isGenerated) ? "" : `<button class="danger" id="pl-remove">remove this playlist</button>`}
    </div>`;

  if (!p.isSubject && !p.isGenerated) $("#pl-remove")?.addEventListener("click", () => {
    savePlaylists(playlists().filter(x => x.id !== p.id));
    logEvent("playlist_removed", { playlist_id: p.id });
    leaveRemovedPlaylist();
  });
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
}

/* Resolve an episode id for `#/episode/:id` — the direct fix for "Open
   episode" leaving 4a (mini-player's `openLink`, player/client.js). No new
   fetch, no new data file; four sources, freshest first:

     1. `state.itemIndex` — populated by fullPool(), show pages, search.
     2. `storedEpisode()` — a star's snapshot, or the one Up Next / a play /
        a picked link wrote (theme A, audit 2026-09-22).
     3. THE PLAYER'S OWN POINTER. "Open episode" on the restored now-playing bar
        said "Episode not found" about the episode that was playing, whenever
        the app launched on any route but Home: the pointer's snapshot only
        reached `itemIndex` as a side effect of Home rendering its Jump back in
        card. The pointer carries everything this page needs, so it is a
        source in its own right rather than a thing Home happens to seed. */
function resolveEpisode(id) {
  const pool = hydrationPool(); // populate/reuse itemIndex — never throws (#276)
  return pool[id] || storedEpisode(id) || playerPointerEpisode(id);
}

/** The player's durable now-playing pointer, when it is `id` — seeded into the
    item index exactly as lastEpisodeCard() seeds it, or null. Never throws: the
    player module may be absent (a stale service-worker cache) or predate it. */
function playerPointerEpisode(id) {
  try {
    const r = window.ForayPlayer?.lastEpisodeCard?.();
    if (!r || !r.id || (id && r.id !== id)) return null;
    /* Never over a richer entry already in the index (a pool row, a show
       page's full row with its description). */
    return state.itemIndex[r.id] || snapshot(r.id, r);
  } catch (_) {
    return null;
  }
}

/* A1.8: "More from this show" — display-only, no new data (the join already
   exists as episodesForShow, docs/requirements audit note). item.show is only
   ever a name string here (discover.json/itemIndex never carry show_id — the
   same gap showNameLink already works around), so this resolves the show
   record the same way showNameLink does (showIdForShowName -> showById) before
   reusing episodesForShow/epRow exactly as renderShow does. Independent of
   Stage 3b ingestion: works fine on today's curated pool and just grows once
   that lands, per the card's own framing. Renders nothing (not an empty
   section) when there is no show match or no other episodes — absence is a
   real state, matching every other join on this page. */
function moreFromShow(item) {
  const showId = showIdForShowName(item.show);
  const show = showId ? showById(showId) : null;
  if (!show) return "";
  const eps = episodesForShow(show).filter(e => e.id !== item.id).slice(0, 8);
  if (!eps.length) return "";
  const ctx = "episode-more-" + item.id;
  return `<section class="ep-more">
    <h3>More from this show</h3>
    ${eps.map((e, i) => epRow(e, i, ctx, -1)).join("")}
  </section>`;
}

/* A1.5: chapter markers, requirement-doc "these are two different use cases
   and need two different solutions" (Joey's Q5 answer). Deliberately its own
   <section>, never touching player/segment-strip.js's markup or classes —
   a chapter is the PUBLISHER's own structure for one episode; a foray
   segment is 4a's own cross-episode stitch. Conflating the two would make
   an episode's own chapter list look like it was 4a's editorial work, which
   it explicitly is not. Renders nothing (not an empty section) when there
   are no chapters — matches every other absence-is-a-real-state section on
   this page (moreFromShow, similarShowsSection, showForaysHtml). */
function fmtChapterTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0)); // floored like the player's clocks (arch-drift-10)
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/* ---------- episode descriptions that are worth reading (founder, 2026-09-17)

   "For episodes that have good descriptions with links and timestamps for
   chapters through the conversation, the formatting in 4a needs to improve
   dramatically, such that it's readable and I can click the links, including to
   time stamps within the episode (those then result in jumping to that
   timestamp in 4a)."

   The description arrived as one `esc()`'d blob inside a single <p>. Every URL
   a publisher wrote was dead text, every timestamp was dead text, and a long
   sponsor URL made the whole page pan sideways (the other half of today's
   fix). `white-space: pre-line` was carrying the entire burden of "formatting".

   WHAT THIS DOES NOT DO, and why. It does not render publisher HTML. The feed's
   `description_html` is parsed and stored by `backend/src/catalog/
   ingestShowFeed.ts` and read straight back out by `rowToEpisode` — and then
   DROPPED at the API boundary: `api/shows/[show_id]/episodes.ts` and
   `api/episodes/search.ts` both return `description_text` only, so the markup
   has never reached a client. Carrying it is a change to `api/**`, which is
   unlisted in `tools/ci/path-policy.mjs` and therefore makes a whole PR wait on
   a human merge click (CLAUDE.md), so it is its own PR and its own sanitizer.
   Everything here works on the plain text we already ship, today.

   SO THIS IS A LINKIFIER, and it is deliberately a small one: escape
   everything, then promote two shapes — an http(s) URL, and a timestamp — into
   controls. Nothing else in the text can become markup, because the only HTML
   in the output is the HTML this function writes. */

/** `1:02:45` / `12:34` / `4:07` -> seconds. Null for anything that is not a
    timestamp, INCLUDING an out-of-range minute or second, which is how a score
    ("a 65:40 split") or a ratio stays plain text. */
function parseTimestampSeconds(raw) {
  const m = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/.exec(String(raw).trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/* URL first in the alternation so a timestamp inside a URL's path or query is
   never lifted out of it. Trailing `.,;:)]}` are excluded from the match rather
   than trimmed afterwards — a URL at the end of a sentence is the common case
   and the full stop belongs to the sentence. */
const DESC_TOKEN_RE = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:)\]}])|(\b(?:\d{1,3}:)?\d{1,2}:[0-5]\d\b)/g;

/**
 * The description as safe HTML: text escaped, URLs linked, timestamps turned
 * into seek controls.
 *
 * `durationSec` (optional) is the honesty guard. A timestamp past the end of
 * the episode is not a chapter mark — it is a phone number, a date, a score, or
 * a timestamp for a DIFFERENT episode the publisher pasted in — and a control
 * that seeks somewhere the audio does not reach is worse than plain text. When
 * the duration is unknown nothing is filtered, because refusing every timestamp
 * on an episode whose length we failed to record would be the wrong default.
 */
function episodeDescriptionHtml(text, durationSec = null) {
  const src = String(text ?? "");
  if (!src) return "";
  /* A LINE THAT STARTS WITH A TIMESTAMP IS A CHAPTER ROW (audit round 2,
     touch-10). Publishers write chapter lists one stamp per line, and an
     inline stamp's hit box can only grow into the leading it has (~2px each
     way at this line height) before it overlaps the stamp on the next line —
     where the LATER button wins the hit test, so a tap on the bottom of one
     chapter's stamp seeked to the next. A stamp-led line is the chapter list's
     own shape, so it renders as the chapter list's own control: the whole line
     is one 44px `.ep-chapter-row` button. Only when nothing else on the line
     is a control of its own (a URL or a second stamp) — a link inside a button
     is invalid, and two stamps on one line are not a chapter. The newline
     after a row is dropped: the row is a block, and under `pre-line` a newline
     opening the next run would paint an empty line under every chapter.
     Every other line goes through the ONE tokeniser below
     (`episodeDescriptionTokens`), which the Now Playing sheet shares. */
  return episodeNotesTokens(src, durationSec).map(descTokenHtml).join("");
}

/** THE NOTES AS LINE-AWARE TOKENS — the chapter-row promotion above AND the
    inline tokens, in one pass, for both surfaces (audit round 2 review of
    touch-10). The promotion used to live only in the HTML renderer, so the
    Now Playing sheet (which reads tokens) drew every chapter-list stamp as a
    ~21px inline `.ep-ts` — the target touch-10 cut on the promise that a
    stamp-led line is a 44px `.ep-chapter-row`. Now the sheet gets the row too.

      { kind: "chapter", secs, stamp, title, label }   a whole stamp-led line
      …and every kind `episodeDescriptionTokens` emits, with a "\n" text token
      between lines (none after a chapter row: the row is a block). */
function episodeNotesTokens(text, durationSec = null) {
  const src = String(text ?? "");
  if (!src) return [];
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const chapter = descChapterToken(lines[i], durationSec);
    if (chapter) { out.push(chapter); continue; }
    out.push(...episodeDescriptionTokens(lines[i], durationSec));
    if (i < lines.length - 1) out.push({ kind: "text", text: "\n" });
  }
  return out;
}

/* `01:23 Title`, `(1:02:45) Title`, `- 12:34 - Title`: an optional bullet or
   bracket, the stamp, an optional closing bracket and separator, the rest. */
const DESC_STAMP_LINE_RE = /^[ \t]*(?:[-–—•*·][ \t]*)?[([]?((?:\d{1,3}:)?\d{1,2}:[0-5]\d)\b[)\]]?[ \t]*(?:[-–—:|][ \t]*)?(.*?)\r?$/;

function descChapterToken(line, durationSec) {
  const m = DESC_STAMP_LINE_RE.exec(line);
  if (!m) return null;
  const [, stamp, rest] = m;
  const secs = parseTimestampSeconds(stamp);
  if (secs === null || (durationSec !== null && secs > durationSec)) return null;
  DESC_TOKEN_RE.lastIndex = 0;
  if (DESC_TOKEN_RE.test(rest)) return null;
  const title = rest.trim();
  return { kind: "chapter", secs, stamp, title, label: `Play from ${stamp}${title ? `, ${title}` : ""}` };
}

/** One token as safe HTML: a chapter row, a link, an inline seek stamp, or
    escaped prose. */
function descTokenHtml(t) {
  if (t.kind === "chapter") {
    return `<button type="button" class="ep-chapter-row" data-ts="${esc(String(t.secs))}" aria-label="${esc(t.label)}"><span class="ep-chapter-time">${esc(t.stamp)}</span><span class="ep-chapter-title">${esc(t.title)}</span></button>`;
  }
  return descInlineTokenHtml(t);
}

/** One inline token as safe HTML — URLs linked, in-range timestamps as inline
    seek buttons, the rest escaped. */
function descInlineTokenHtml(t) {
  if (t.kind === "link") {
    /* `rel="noopener noreferrer"` because these point off our origin. The
       token's href is already through `safeUrl`; it goes through again here
       because "every interpolated href passes through safeUrl" is a rule
       test/app-security.test.js reads off this line, not off the tokeniser. */
    return `<a href="${esc(safeUrl(t.href))}" target="_blank" rel="noopener noreferrer">${esc(t.text)}</a>`;
  }
  if (t.kind === "stamp") {
    return `<button type="button" class="ep-ts" data-ts="${esc(String(t.secs))}" aria-label="${esc(t.label)}">${esc(t.text)}</button>`;
  }
  return esc(t.text);
}

/**
 * The description as TOKENS — prose, links and seek stamps — the one pass that
 * recognises a URL or a timestamp in publisher text. `episodeDescriptionHtml`
 * above renders them for the episode page; the Now Playing sheet renders the
 * same tokens as DOM nodes (client.js `paintNotes`, through `window.ForayNotes`
 * below), because that file builds nothing from an HTML string. Audit round 2,
 * p-switcher-2: the sheet used to paint the same text dead, so the founder's
 * 2026-09-17 ruling held on one of the two surfaces that show the notes.
 *
 *   { kind: "text",  text }
 *   { kind: "link",  text, href }          href already through `safeUrl`
 *   { kind: "stamp", text, secs, label }   label is the control's accessible name
 *
 * `safeUrl` returns "#" for any scheme but http(s), so a script-bearing or
 * inline-data URL cannot become a live href even though the regex would not
 * have matched one in the first place. Belt and braces, and it is the same
 * helper every other href in this file goes through. (The scheme names are
 * spelled around rather than written out: the `no ... URL is constructed
 * anywhere in the source` invariant in test/app-security.test.js greps this
 * file for them, comments included, and it is a better rule than any one
 * comment's convenience.)
 */
function episodeDescriptionTokens(text, durationSec = null) {
  const src = String(text ?? "");
  const out = [];
  if (!src) return out;
  let last = 0;
  DESC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DESC_TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    let [whole, url, stamp] = m;
    if (url) {
      /* BALANCED PARENTHESES STAY IN THE URL (audit round 3, app-2-8; the GFM
         autolink rule). The pattern leaves a trailing `)` to the sentence, which
         cut `…/wiki/Mercury_(planet)` to `…/wiki/Mercury_(planet`. A `)` right
         after the match is taken back while the URL has an unclosed `(`. */
      const opens = (u) => u.split("(").length - 1;
      const closes = (u) => u.split(")").length - 1;
      while (src[m.index + url.length] === ")" && opens(url) > closes(url)) url += ")";
      whole = url;
      DESC_TOKEN_RE.lastIndex = m.index + url.length;
      out.push({ kind: "link", text: url, href: safeUrl(url) });
    } else {
      const secs = parseTimestampSeconds(stamp);
      const inRange = secs !== null && (durationSec === null || secs <= durationSec);
      out.push(inRange
        ? { kind: "stamp", text: stamp, secs, label: `Play from ${stamp}` }
        : { kind: "text", text: whole });
    }
    last = m.index + whole.length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

if (typeof window !== "undefined") {
  window.ForayNotes = { tokens: episodeDescriptionTokens, lines: episodeNotesTokens };
}

/* COLLAPSED BY DEFAULT (founder, 2026-09-18): "When I'm listening to a podcast
   with a lot of notes the episode page is just notes; the default should be I
   mostly see album artwork and need to intentionally scroll somewhere to see
   notes."

   Some publishers write two thousand words of links, sponsor copy and chapter
   lists into every episode. Rendered in full and in flow, that is the entire
   page: the artwork, the play button and "more from this show" all get pushed
   off the first screen by the least important thing on it.

   A NATIVE `<details>`, not a JS toggle. It needs no script (the page is
   `script-src 'self'` with no inline handlers), it is keyboard- and
   screen-reader-accessible for free, it holds its own state, and browser find-
   in-page can still open it. A hand-rolled class-swap would be more code and
   less accessible.

   NOT a line-clamp with a fade. A clamp still renders the whole block into the
   layout and still needs a control to undo it — it just makes the page a fixed
   amount of notes instead of an unbounded amount, and the founder's ask is
   about what the page IS by default, not about how tall the notes are.

   Chapters stay OUT of this and remain visible: they are navigation, not prose —
   short, scannable, and now individually tappable to seek. Burying the one part
   of the notes that does something would be the wrong half to hide. */
function episodeDescriptionSectionHtml(item) {
  if (!item.description) return "";
  const durationSec = itemDurationSec(item, { upperBound: true });
  return `<details class="ep-description">
      <summary class="ep-description-toggle">Episode notes</summary>
      <p class="ep-description-text">${episodeDescriptionHtml(item.description, durationSec)}</p>
    </details>`;
}

function episodeChaptersHtml(item) {
  const chapters = Array.isArray(item.chapters) ? item.chapters : [];
  if (!chapters.length) return "";
  /* Each row is a seek control now, for the same reason the timestamps in the
     description are: a chapter list you cannot jump from is a table of contents
     with no page numbers. `data-ts` is the one contract both share, so
     `bindEpisodeSeeks` binds them in a single pass. */
  return `<section class="ep-chapters">
    <h3>Chapters</h3>
    <ol class="ep-chapters-list">
      ${chapters.map(c => {
        /* `== null` FIRST, because `Number(null)` is 0 and `Number("")` is 0 —
           a chapter with no recorded start would otherwise render as a control
           that seeks confidently to the beginning. Caught by a test. */
        const secs = c.start_time_seconds == null ? NaN : Number(c.start_time_seconds);
        const time = esc(fmtChapterTime(c.start_time_seconds));
        const title = esc(c.title || "");
        return Number.isFinite(secs)
          ? `<li><button type="button" class="ep-chapter-row" data-ts="${esc(String(secs))}"><span class="ep-chapter-time">${time}</span><span class="ep-chapter-title">${title}</span></button></li>`
          : `<li><span class="ep-chapter-time">${time}</span><span class="ep-chapter-title">${title}</span></li>`;
      }).join("")}
    </ol>
  </section>`;
}

/**
 * One delegated listener for every `data-ts` control on the page — the
 * description's timestamps and the chapter rows alike.
 *
 * PLAY THEN SEEK, in that order, and only ever on this episode. `ForayPlayer`
 * starts an item at 0 (`manager.play(0)`), so a jump is "make this the current
 * item if it is not already, then move the clock". When it IS already current,
 * the seek alone is the whole action — restarting would throw away the thing
 * the listener is in the middle of.
 */
function bindEpisodeSeeks(scope, item) {
  /* PER ELEMENT, with the `_bound` guard — `bindPlay`/`bindStars`'s idiom, and
     not a delegated listener on `scope`.
     The first draft delegated from `#view`, which is the one node on this page
     that OUTLIVES the render: `renderEpisode` replaces its innerHTML but never
     the element, so every visit to an episode page added another listener, each
     closing over its own `item`. Visit three episodes and one tap on a
     timestamp runs three handlers, two of which start playing an episode the
     listener is no longer looking at. Binding to the buttons themselves means
     the listeners die with the markup they belong to. */
  scope.querySelectorAll("[data-ts]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const secs = Number(btn.dataset.ts);
      if (!Number.isFinite(secs)) return;
      try {
        if (!window.ForayPlayer || !window.ForayPlayer.canPlay(item)) return;
        /* Play only when this is not already the current episode — a restart
           would throw away the thing the listener is in the middle of. Then
           seek, always: that is the whole of what the control promises. */
        /* CURRENT, not playing (audit round 3, app-2-4): a paused current
           episode is seeked, not restarted — and resumed, because a tap on a
           stamp asks to hear it. */
        const current = typeof window.ForayPlayer.isCurrent === "function"
          ? window.ForayPlayer.isCurrent(item.id)
          : window.ForayPlayer.isPlaying(item.id);
        if (!current) {
          /* THE ONE START PATH (audit round 3, app-2-4). This called
             ForayPlayer.play() directly, so an episode started from a chapter
             or a timestamp never reached History, never logged play_started
             and left the previous list's ⏮/⏭ chain in place. startEpisodePlay
             does all of that, reports a refused start (not a superseded one),
             and carries the stamp as the START offset (races-1: the load begins
             at the timestamp rather than seeking after). A stamp starts this
             episode alone: no list, no playlist context. */
          await startEpisodePlay(item.id, item, { ctx: null, list: [], startOffset: secs });
          return;
        }
        await window.ForayPlayer.seekTo(secs);
        if (!window.ForayPlayer.isPlaying(item.id)) await window.ForayPlayer.togglePlayback?.();
      } catch (err) {
        /* A seek that cannot happen is not a reason to break the page — the
           same rule the rest of this file's playback bindings follow. But a
           PLAY that threw says so (review 2026-09-23, persona #4 on a sibling
           control): the same report bindPlay makes, not a tap that does
           nothing and says nothing. */
        console.warn("[4a] timestamp play failed", err);
        try { window.ForayPlayer?.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
        noteTapFailure("start", err);
      }
    });
  });
}

function renderEpisode(id) {
  setBodyClass("view-page");
  const item = resolveEpisode(id);
  if (!item) {
    /* With a ‹ (audit 2026-09-22): this page is reached through stale links —
       a queued id whose snapshot is gone, a search row from an earlier session —
       and a sentence with no way back was a dead end. */
    $("#view").innerHTML = statusPageHtml({ title: "Episode", note: "Episode not found." });
    return;
  }
  // populate itemIndex/poolIds so "more from this show" rows can play in-app;
  // never throws — no catalogue yet is a reason to skip that row's play button,
  // not to lose the whole page (same rule hydrationPool already follows).
  if (state.session && state.session.episodes) {
    try { fullPool(); } catch (_) { /* catalogue not really there yet */ }
  }
  const dateStr = fmtDate(item.release_date);
  /* The row's "Played" / "NN min left" follows the listener onto the page
     (audit round 2, honesty-5): it used to vanish on the way in. */
  const prog = rowProgress(item);
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2 class="fp-s-title">${esc(item.title)}${explicitBadge(item.explicit)}</h2>
          <p class="fp-s-show">${joinMeta(item.show ? showNameLink(item.show, item.show_id) : "", fmtDur(episodeMinutes(item)), esc(dateStr), progHtml)}</p>
        </div>
      </div>
      ${item.artwork_url ? `<img class="ep-art" src="${esc(safeUrl(item.artwork_url))}" alt="" decoding="async" width="600" height="600">` : ""}
      ${item.hook ? `<p class="fp-s-why">${esc(item.hook)}</p>` : ""}
      <div class="ep-actions">${item.audio_url ? playBtn(item) : notPlayableNote()}${starBtn(item.id)}${upNextBtn(item.id, item)}</div>
      ${item.audio_url ? "" : `<p class="note">${esc(NOT_PLAYABLE_WHY)}</p>`}
      ${episodeDescriptionSectionHtml(item)}
      ${episodeChaptersHtml(item)}
      ${moreFromShow(item)}
    </div>`;
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
  bindEpisodeSeeks($("#view"), item);
}

/* The count printed here is `resolveParts(p).length` — the SAME call
   renderPlaylistDetail maps into rows, deliberately, so "7 parts" and five rows
   cannot come apart again (#276). It is a saved-length question, not a pool
   question, so this view needs no catalogue to answer it honestly. */
/* ---------- Up Next page (#/queue, docs/listening-queue-plan.md Stage 1) ----------

   Reachable from the drawer nav in the same place "Playlists" lives today
   (plan §1 Q4). Reuses the ep-row/gone visual language resolveParts/epRow/
   archivedRow already establish, per the plan's "same UI affordances,
   separate storage" rule (§2) — this page does not read or write
   cp_playlists, only cp_queue via queueRows().

   Reorder + remove live HERE, not on the row controls that add to the queue
   (epRow/archivedRow/renderEpisode/renderShow) — the plan's control-density
   note (§1 Q3) rules out stacking a fourth/fifth icon onto rows that already
   sit at their mobile-width ceiling. Play uses the existing single-episode
   playBtn/epRow-style playback; what plays after it is continuous playback's
   decision (§ continuous playback), and Up Next comes first there. */
function renderQueue() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so a live queued item can play in-app
  const rows = queueRows();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Up Next</h2>${rows.length ? `<p class="sub">${rows.length} queued</p>` : ""}</div>
      </div>
      ${rows.length
        ? rows.map((r, i) => upNextRow(r, i, rows.length)).join("")
        : `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"));
  bindUpNextReorder($("#view"));
}

/* One row: the SAME playable shape epRow/archivedRow already give (so a
   queued row looks and behaves like every other episode row in the app), plus
   up/down reorder controls and a remove control this page owns exclusively
   (see renderQueue's header comment for why those do not live on the add-side
   controls). `unnamed` (an id with neither a live pool entry nor a saved
   snapshot) still gets a row — a count that disagrees with what is on screen
   is the #276 defect this whole file works to avoid — just with no title,
   no play, no star, matching the `unnamed` branch resolveParts already draws
   for a playlist part with nothing to name it. */
function upNextRow(r, idx, total) {
  const { item, id, state } = r;
  const named = state !== "unnamed";
  const playable = state === "live";
  /* `UP_NEXT_CTX` on the ▶, so bindPlay knows a play from THIS page moves its
     row to the top (the Up Next model, § continuous playback). */
  const inApp = playable ? playBtn(item, UP_NEXT_CTX) : "";
  const title = named ? esc(item.title) : "Episode no longer available";
  /* The same "Played" / "NN min left" mark every other episode row carries
     (audit round 2, honesty-5): a half-finished queued episode looked fresh. */
  const prog = playable ? rowProgress(item) : null;
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  /* One sentence for the unnamed state, and it is about THIS page (copy-9): it
     used to say "Removed from your history", on a page that is not History,
     about an id that is still right there in the list. */
  const sub = state === "live"
    ? joinMeta(esc(item.show || ""), fmtDur(episodeMinutes(item)), progHtml)
    : state === "archived"
      ? joinMeta(esc(item.show || ""), fmtDur(episodeMinutes(item)), "not available right now")
      : "4a no longer has this episode's details";
  /* `.is-current` names the row the bar is on — playing OR paused — which the
     ❚❚ glyph alone signalled before (p-impatient-6). Repainted by
     `noteQueuePlaybackMoved` when playback moves. */
  let isCurrent = false;
  try { isCurrent = !!window.ForayPlayer?.isCurrent?.(id); } catch (_) { /* no player yet */ }
  return `<div class="ep-row up-next-row ${playable ? "" : "gone"}${isCurrent ? " is-current" : ""}"${isCurrent ? ' aria-current="true"' : ""}>
    <span class="q-num">${idx + 1}</span>
    <div class="info">
      <div class="t">${title}</div>
      <div class="s">${sub}</div>
    </div>
    ${inApp}${named ? starBtn(item.id) : ""}
    <div class="up-next-reorder">
      <button class="reorder up" data-reorder-up="${esc(id)}" ${idx === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
      <button class="reorder down" data-reorder-down="${esc(id)}" ${idx === total - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
    </div>
    <button class="up-next-remove" data-dequeue="${esc(id)}" aria-label="Remove from Up Next">✕</button>
  </div>`;
}

/* AFTER A REORDER OR A REMOVE, THE LISTENER IS STILL WHERE THEY WERE (audit
   2026-09-22: two a11y findings and a persona, one cause). Every press used to
   end in `renderQueue()` and nothing else: the pressed button was destroyed, so
   focus fell to <body> and a keyboard or screen-reader user had to tab in from
   the top of the document for every single step; nothing announced the new
   position; and on a phone the row moved out from under the thumb, so the ↑
   now under it belonged to the episode that had just moved DOWN — three fast
   taps shuffled three different episodes one place each.

   The render is `saveQueueIds`'s now (the page is a live view of the list, see
   `repaintQueuePage`); what follows it is this. Focus goes to the same episode's button in its new row
   (the other arrow once it reaches an end, where its own is disabled), the
   page scrolls by exactly how far that button moved so it lands back under
   the finger, and the new position is announced. A remove focuses the ✕ of
   the row that took its place. */
function queueButtonFor(attr, id) {
  const view = $("#view");
  if (!view) return null;
  return [...view.querySelectorAll(`[${attr}]`)].find((b) => b.getAttribute(attr) === id) || null;
}

function buttonTop(btn) {
  if (!btn || typeof btn.getBoundingClientRect !== "function") return null;
  const r = btn.getBoundingClientRect();
  return r && Number.isFinite(r.top) ? r.top : null;
}

function afterQueueMove(id, dir, topBefore) {
  const ids = queueIds();
  const pos = ids.indexOf(id) + 1;
  const same = dir < 0 ? "data-reorder-up" : "data-reorder-down";
  const other = dir < 0 ? "data-reorder-down" : "data-reorder-up";
  let target = queueButtonFor(same, id);
  if (!target || target.disabled) target = queueButtonFor(other, id);
  const topAfter = buttonTop(target);
  if (topBefore != null && topAfter != null && topAfter !== topBefore && typeof window.scrollBy === "function") {
    window.scrollBy(0, topAfter - topBefore);
  }
  focusQuietly(target);
  if (pos > 0) announce(`Moved to position ${pos} of ${ids.length}.`);
}

function afterQueueRemove(index) {
  const view = $("#view");
  const left = view ? [...view.querySelectorAll("[data-dequeue]")] : [];
  focusQuietly(left[Math.min(index, left.length - 1)] || (view && view.querySelector("h2")));
  announce(left.length ? "Removed from Up Next." : "Removed from Up Next. Up Next is empty.");
}

function bindUpNextReorder(scope) {
  scope.querySelectorAll("[data-reorder-up]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.reorderUp;
      const top = buttonTop(btn);
      /* The repaint is `saveQueueIds`'s (the page is a live view of the list);
         these handlers only write, then put the listener back where they were. */
      moveQueueItem(id, -1);
      afterQueueMove(id, -1, top);
    });
  });
  scope.querySelectorAll("[data-reorder-down]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.reorderDown;
      const top = buttonTop(btn);
      moveQueueItem(id, 1);
      afterQueueMove(id, 1, top);
    });
  });
  scope.querySelectorAll("[data-dequeue]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const index = queueIds().indexOf(btn.dataset.dequeue);
      removeFromQueue(btn.dataset.dequeue);
      afterQueueRemove(Math.max(0, index));
    });
  });
}

/* ---------- Library (#/library, docs/ux/foray-mockup.jsx's LibraryScreen) ----------

   Card t_a1e7a69c. One AGGREGATE view over four things that already live in
   localStorage and already have their own render paths — this page adds no
   new per-item UI, only a new place that lists what is already there:

     Saved     cp_saved   via savedMap()     — reuses epRow/archivedRow
     History   cp_history via pickedHistory()— reuses epRow/archivedRow
     Playlists cp_playlists via playlists()  — reuses the same summary row
                                                renderPlaylists() prints, capped
     Up Next   cp_queue   via queueIds()     — same treatment as playlists,
                                                for the reason below

   Playlists and Up Next are LINKED, not embedded (Joey's call is made here,
   for the PR to explain): both already have a real page (#/playlists,
   #/queue) with its own controls (build/remove, reorder/dequeue) that this
   aggregate view has no room for at mobile width — Library shows a short
   summary (title + count, capped at 5) that opens straight into the real
   page, the same "browse here, act there" split the mockup itself draws
   between LibraryScreen and the screens it links out to (`playForay`/
   `openShow` in the mockup, `#/playlist/:id` and `#/show/:id` here). Saved
   and History get the FULL row treatment (epRow/archivedRow) because
   Library IS their only page — there is no separate #/saved or #/history to
   defer to.

   Every link on this page is in-app: episode rows resolve through
   epRow/archivedRow (which already only ever link within 4a or, for a part
   with no in-app audio, out to the episode's own listening app — the same
   fallback every other row in the app already uses, never a new one), and
   the Playlists/Up Next summaries link to their own in-app pages. Nothing
   here introduces a new external link-out.

   History is newest-first (`pickedHistory()` appends, so the raw array is
   oldest-first) and capped at the same 20 rows for the same reason renderHome
   caps its rails — a scroll-forever list is not what "recently listened"
   means. Saved has no cap: an unbounded star list is the one honest reading
   of "everything you saved". */
/* This one's href is `#${...}` rather than a bare `${...}` — the leading `#`
   is a literal prefix, not part of the interpolation, so it reads the same
   as every other in-app hash link (`#/playlist/` + esc(id), etc.) rather
   than a URL built entirely from a variable, which is exactly the shape
   test/app-security.test.js's static safeUrl-guard checks for
   (CLAUDE.md § Conventions: "all href/src through safeUrl()" — that rule is
   for links that can carry an attacker-controlled scheme; an in-app hash
   route built from this module's own constant strings and `playlists()`/
   `queueIds()` ids, which esc() already escapes, is not one). */
function libSummaryRow(hashPath, title, sub) {
  return `<a class="pl-row" href="#${esc(hashPath)}">
    <div class="info">
      <div class="t">${esc(title)}</div>
      <div class="s">${esc(sub)}</div>
    </div>
    <span class="chev">›</span>
  </a>`;
}

function libSection(title, bodyHtml) {
  return `<div class="lib-section">
    <div class="lib-section-head">${esc(title)}</div>
    ${bodyHtml}
  </div>`;
}

/* FORAYS AND FOLLOWED SHOWS ARE LIBRARY SECTIONS (founder, 2026-09-22: "Forays
   into Library, no new tab"; audit personas 32 and 50). The tab bar lit Library
   for #/forays and every Foray page while Library listed no Forays, and the only
   way to the shows a listener followed was a row inside the Search page's browse
   furniture, hidden the moment the field was focused. Both are LINKED, capped at
   five like Playlists, and open their real page for the rest — the "browse here,
   act there" split the header above describes. */
const LIBRARY_SECTION_CAP = 5;

function libraryForaysHtml() {
  /* The player module lists Forays; until it has loaded, the count is unknown,
     and an unknown count is not zero — offer the way in, claim nothing. */
  if (!state.forays || !window.ForayPlayer) return libSummaryRow("/forays", "All forays", "");
  const list = forayCards();
  if (!list.length) return `<p class="note">No forays to show yet.</p>`;
  const progress = forayProgressLabels();
  return list.slice(0, LIBRARY_SECTION_CAP).map(f =>
    libSummaryRow(`/foray/${encodeURIComponent(f.id)}`, f.title || f.id,
      forayListSubLabel(f, progress))).join("")
    + (list.length > LIBRARY_SECTION_CAP ? `<a class="lib-more" href="#/forays">All ${list.length} forays ›</a>` : "");
}

function libraryFollowedHtml() {
  const followed = Object.values(starredShowsMap())
    .sort((a, b) => (b.starred_at || "").localeCompare(a.starred_at || ""));
  if (!followed.length) return `<p class="note">No followed shows yet — follow a show from its page to keep it here.</p>`;
  return `<div class="show-results">${followed.slice(0, LIBRARY_SECTION_CAP).map(starredShowRow).join("")}</div>`
    + (followed.length > LIBRARY_SECTION_CAP ? `<a class="lib-more" href="#/starred-shows">All ${followed.length} followed shows ›</a>` : "");
}

function renderLibrary() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so saved/history rows can play in-app

  /* Family Mode reaches Library too (data-integrity-4). An "unnamed" row has
     nothing in it to hide. */
  const family = (r) => r.state === "unnamed" || familyAllows(r.item);
  const savedRows = rowsForIds(Object.keys(savedMap())).filter(family);
  const historyIds = pickedHistory().slice().reverse().slice(0, 20);
  const historyRows = rowsForIds(historyIds).filter(family);
  const allPlaylists = playlists();
  const queued = queueIds();

  const rowHtml = (r, i, ctx) => r.state === "live" ? epRow(r.item, i, ctx, -1) : archivedRow(r.item, i, ctx);
  // History's "unnamed" case (an id neither live in the pool nor covered by a
  // cp_saved snapshot) is real and common -- unlike Saved, a history entry was
  // never necessarily starred. archivedRow's "unnamed" copy ("Saved before 4a
  // kept episode details") is written for the saved/playlist snapshot path and
  // would misname what happened here, so History gets its own honest fallback
  // for that one state rather than reusing archivedRow's wording.
  const historyRowHtml = (r, i) => r.state === "unnamed"
    ? `<div class="ep-row gone"><div class="info"><div class="t">No longer available</div><div class="s">Previously played, no longer available</div></div></div>`
    : rowHtml(r, i, "library-history");

  const savedHtml = savedRows.length
    ? savedRows.map((r, i) => rowHtml(r, i, "library-saved")).join("")
    : `<p class="note">Nothing saved yet — tap ☆ on an episode to keep it here.</p>`;

  const historyHtml = historyRows.length
    ? historyRows.map((r, i) => historyRowHtml(r, i)).join("")
    : `<p class="note">No listening history yet — episodes you play show up here.</p>`;

  const playlistsHtml = allPlaylists.length
    ? allPlaylists.slice(0, 5).map(p =>
        libSummaryRow(`/${playlistRoute(p)}`, p.title, playlistLengthLabel(p))).join("")
      + (allPlaylists.length > 5 ? `<a class="lib-more" href="#/playlists">All ${allPlaylists.length} playlists ›</a>` : "")
    /* It said "build one from the home screen", and the builder left Home on
       2026-09-03 — the note named the one screen certain not to have it. It
       names the Create tab, and links there. */
    : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`;

  const queueHtml = queued.length
    ? libSummaryRow("/queue", "Up Next", `${queued.length} queued`)
    : `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h2>Library</h2></div>
      </div>
      ${libSection("Forays", libraryForaysHtml())}
      ${libSection("Followed shows", libraryFollowedHtml())}
      ${libSection("Saved", savedHtml)}
      ${libSection("Playlists", playlistsHtml)}
      ${libSection("Up Next", queueHtml)}
      ${libSection("History", historyHtml)}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));

  /* A COLD OPEN BEFORE THE PLAYER MODULE (review 2026-09-23). The Forays
     section can only list once the player is up, and the forayCards() header
     says every page that lists Forays must close that gap itself — as
     renderForays does. Nothing else repaints Library when the module lands. */
  if (!window.ForayPlayer && state.forays) {
    const isCurrentRender = renderToken();
    playerBridge().then(player => {
      if (player && isCurrentRender() && currentHash() === "#/library") renderCurrentPage();
    });
  }
}

/* THE LIST, AND ONE DOOR TO THE BUILDER (audit round 2, p-first-6; founder
   question 4, default taken): the `#pl-form` builder that lived here is gone —
   see the removal note above `bindPickLogging`. The empty state says the same
   sentence Library's does, and both point at Create. */
function renderPlaylists() {
  setBodyClass("view-page");
  const all = playlists();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Playlists</h2>${all.length ? `<p class="sub">${all.length} built</p>` : ""}</div>
      </div>
      <a class="page-link-row" href="#/create">Build a playlist ›</a>
      ${all.length ? all.map(p => `
        <a class="pl-row" href="#/${esc(playlistRoute(p))}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${joinMeta(playlistLengthLabel(p), playedOnLabel(p.last_played_at))}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`}
    </div>`;
}

/* ---------- Create (#/create, U-06 / docs/ui-transition-plan.md D7+D8) ----------

   The mockup's Create screen (docs/ux/foray-mockup.jsx CreateScreen), restyled
   under the ui-v2 tokens, with the **Foray | Playlist** toggle rendered but the
   Foray half permanently disabled: "Foray generation stays out of the UI for
   now" (D8) -- the pipeline exists, its key and segment pool don't, and a
   toggle that silently did nothing would be worse than one that says so.
   Playlist mode is NOT a new builder: it is today's buildPlaylist() (the same
   function #/playlists' form calls), reached through the new chrome, so a
   playlist built from here and one built from the old Playlists page produce
   byte-identical cp_playlists entries (the card's acceptance line).

   The mockup's ~20/~40/~75 minute LENGTH picker is Foray-specific (it sizes a
   stitched run of segments) and has no meaning for a playlist of whole
   episodes, so D8 explicitly excludes it here -- showing it would imply a
   knob that does nothing.

   The mockup's phase machine (idle -> building -> done) fakes progress with a
   fixed step list and a timer with no backing work. buildPlaylist() is real,
   synchronous work with no intermediate stages to report, so this reuses only
   the honest part of that shape -- a "Building…" transient long enough for
   the browser to paint before the synchronous call blocks the main thread
   (the same bindPlaylistFormSubmit fix, same reason) -- and then either opens
   the built playlist (the mockup's "done" destination) or shows why not. No
   invented step list, because inventing one here would be exactly the kind of
   promise D8 forbids: a progress bar for work that is not actually happening
   in stages. */

const CREATE_SUBJECT_SUGGESTIONS = [
  "The history of the Fed", "Mechanical watches", "Small launch economics",
];

function createToggleHtml() {
  return `<div class="cr-toggle" role="group" aria-label="Create mode">
    <button type="button" class="cr-toggle-btn is-on" data-cr-mode="playlist" aria-pressed="true">Playlist</button>
    <button type="button" class="cr-toggle-btn is-disabled" data-cr-mode="foray" disabled aria-disabled="true" aria-pressed="false"
        aria-describedby="cr-foray-note">Foray</button>
  </div>
  <p class="note cr-foray-note" id="cr-foray-note">Custom Forays aren't available yet — you can still build a playlist below.</p>`;
}

/** Loading-state guard around #cr-form's submit -- the same shape as
    bindPlaylistFormSubmit (see that function's header for why the
    setTimeout(0) is load-bearing) because this calls the exact same
    buildPlaylist(), just from the new screen's form. Kept as a separate
    function rather than a shared one because the two forms' DOM (note
    element id, disabled-label text) differ enough that forcing a shared
    signature would need extra parameters for no real reuse -- U-02's own
    history (two `#pl-form` mounts sharing one handler) is the caution here:
    that ended with only one of the two mounts still using it. */
/* ONE BUILD AT A TIME (review 2026-09-23). The suggestion pills call the
   submit handler directly, so the disabled Build button never had a say: on a
   cold boot the build waits for the search data, a tap looked like nothing,
   and a second tap (on the same pill or another) queued a second playlist and
   a second navigation. The flag covers every entry point; the pills are also
   disabled so the page says so. */
let createBuildPending = false;

/* THE PENDING STATE IS PAINTED FROM THE FLAG, ONTO WHATEVER CREATE PAGE IS ON
   SCREEN (audit round 2, races-3). The build waits on `whenSearchDataReady`,
   which since round 1 can be a 30 s wait on a cold start; a listener who left
   and came back found fresh, enabled pills that did nothing (the flag was
   still set) and a Build button that said Build. Now every render of the page
   asks the flag, and the build's end restores the button on the page that is
   there THEN — not the detached one it started from. `"Build"` is the
   button's one label, so no captured original is needed. */
function paintCreatePending(pending) {
  const view = $("#view");
  if (!view) return;
  view.querySelectorAll("[data-cr-subject]").forEach(p => { p.disabled = pending; });
  const form = $("#cr-form");
  const btn = form && typeof form.querySelector === "function" ? form.querySelector("button[type='submit']") : null;
  if (!btn) return;
  btn.disabled = pending;
  setControlLabel(btn, pending ? "Building…" : "Build", null);
}

function bindCreateFormSubmit(e) {
  e.preventDefault();
  if (createBuildPending) return;
  const form = e.currentTarget;
  const input = form.querySelector("input[type='text']");
  const query = input.value.trim();
  if (!query) return;
  createBuildPending = true;
  paintCreatePending(true);
  const staleNote = $("#cr-note");
  if (staleNote) staleNote.hidden = true;
  whenSearchDataReady(() => {
    try {
      const result = buildPlaylist(query);
      logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0, source: "create" });
      /* ONLY IF CREATE IS STILL THE PAGE ON SCREEN (audit round 2, races-3).
         The wait above can outlast the listener's patience; a build that
         finished while they were on Home or in a show yanked them to the new
         playlist from wherever they were. The playlist is already saved
         either way — Library and #/playlists list it — so a listener who
         moved on loses nothing but the jump. The route is the test, not the
         render token: a listener who left and CAME BACK to Create is looking
         at "Building…" (painted from the flag above) and expects the result
         to land. */
      const onCreate = currentHash() === "#/create";
      if (result.status === "ok" || result.status === "sparse") {
        if (onCreate) location.hash = "#/" + playlistRoute(result.playlist);
      } else if (onCreate) {
        const note = $("#cr-note"); // the live page's note, never the one captured before the wait
        if (note) {
          note.textContent = result.status === "unsaved"
            ? "That playlist could not be saved — this device has no storage space left. Removing a playlist you have finished with frees enough for a new one."
            : result.suggestions.length
              ? `Not much on ${quoteQuery(query)} yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
              : `Not much on ${quoteQuery(query)} yet — try different words.`;
          note.hidden = false;
        }
      }
    } finally {
      createBuildPending = false;
      paintCreatePending(false);
    }
  });
}

function renderCreate() {
  setBodyClass("view-page");
  $("#view").innerHTML = `
    <div class="page cr-page">
      <div class="page-head">
        <div><h2>Create</h2><p class="sub">Name a subject and 4a builds a playlist from across the catalogue.</p></div>
      </div>
      ${createToggleHtml()}
      <form id="cr-form" autocomplete="off">
        <input id="cr-input" type="text" maxlength="120" placeholder="e.g. the semiconductor supply chain" aria-label="Subject for your playlist">
        <button type="submit">Build</button>
      </form>
      <div class="cr-suggestions">
        ${CREATE_SUBJECT_SUGGESTIONS.map(s => `<button type="button" class="fy-chip" data-cr-subject="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>
      <p id="cr-note" class="note" hidden></p>
    </div>`;

  $("#cr-form").addEventListener("submit", bindCreateFormSubmit);
  /* A build that is still waiting on the search documents is shown as one,
     on this render too (races-3): the page says why a tap does nothing. */
  paintCreatePending(createBuildPending);
  /* A SUGGESTION BUILDS (audit 2026-09-22, persona 26). The pill used to fill
     the field and raise the keyboard, and building took a second tap on a Build
     button the keyboard now covered — so the tap read as a miss. Nobody who
     taps a canned suggestion wants to type: the field is filled (so the
     listener can see what was asked for) and the same submit path runs, with
     no focus. The founder's ruling on the Search tiles (#684: a tile runs the
     search for its own label) is the same rule. */
  $("#view").querySelectorAll("[data-cr-subject]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (createBuildPending) return;   /* a build is already on its way */
      const form = $("#cr-form");
      const input = $("#cr-input");
      if (input) input.value = btn.dataset.crSubject;
      if (form) bindCreateFormSubmit({ preventDefault() {}, currentTarget: form });
    });
  });
  /* A Search CTA's hand-off (app-2-11): prefilled and submitted through the
     same path, now that the form exists. Consumed once. */
  if (pendingCreateQuery !== null) {
    const query = pendingCreateQuery;
    pendingCreateQuery = null;
    const form = $("#cr-form");
    const input = $("#cr-input");
    if (input) input.value = query;
    if (form && !createBuildPending) bindCreateFormSubmit({ preventDefault() {}, currentTarget: form });
  }
}

/* ---------- Forays (#128) ----------

   A Foray is one ordered run of 32 SEGMENTS drawn from nine episodes of five
   shows — not an episode, and not a playlist of episodes. The running order
   lives in data/forays.json, the timestamps in data/segments.json, the audio in
   data/segment-sources.json; the join, the queue and the position maths all
   live in player/foray-resolve.js, where they are tested. This section is the
   surface: it renders what that returns and drives the transport.

   ── The draft rule ────────────────────────────────────────────────────────
   Only a founder may publish a Foray (a founder action; HUMAN-ACTIONS.md #2 asked
   for it until it was dropped on 2026-09-24). As of 2026-08-30
   ONE is published — `capital-types-1` — so exactly one is listed for an
   ordinary visitor and the other three are not. The rule has not changed; the
   data has. (It used to read "every Foray is a draft, so none is listed", which
   is the sentence this change falsified.)

   A DRAFT is still reachable — by asking for one by id:

       https://jw-incorporated.github.io/foray/?foray=grilling-history-2

   That is the CURRENT grilling Foray (#226). `grilling-history-1`, the
   61-minute assembly that drifted off plot, was retired from the file on
   2026-09-22 (#236), so its old link no longer opens anything.

   That link opens the Foray once (`enterForayFromQuery` rewrites the hash) and
   the parameter then stays in the URL as the unlock token — changing
   `location.hash` leaves the query string alone, so the unlock holds while the
   founder moves around the app. It is deliberately NOT persisted to
   localStorage: an unpublished Foray should not start appearing for someone who
   once opened a link on a shared machine. Nothing is bypassed and nothing is
   published by opening it — the status in the data file is unchanged, and the
   page says so on the page. */

function forayParam() {
  try {
    const raw = new URLSearchParams(location.search).get("foray");
    return raw && raw.trim() ? raw.trim() : null;
  } catch (_) { return null; }
}

/** Ids the visitor named explicitly. Today that is at most one. */
function unlockedForays() {
  const id = forayParam();
  return id ? [id] : [];
}

/* ── The test track: "Show draft Forays" ──────────────────────────────────

   Wyatt, 2026-09-11: "I can't see these forays in the app, please fix that."
   "These" are the GENERATED Forays — `data/forays.json` rows carrying
   `generated: true` — which land as `status: "draft"` because publishing is a
   founder action and the generator is not a founder.
   The visitor rule above is untouched, and so is every Foray's status: this
   is a per-device switch in the drawer, OFF by default, that lets the person
   who owns the device ask for every draft at once, the way `?foray=` asks for
   one. When it is off, nothing below is reachable and every surface renders
   exactly what it rendered before the switch existed (test/draft-forays-
   switch.test.js pins that byte for byte).

   `cp_show_drafts` goes through lsGet/lsSet like every other `cp_` key (§
   storage above; durable tier + localStorage mirror), is listed in
   docs/legal/privacy-policy.md §1 and counted by test/data-deletion.test.js,
   and is wiped by "Delete my data" with the rest. It is deliberately NOT read
   inside `player/` — that tree is pure, so the switch travels to the resolver
   as the `showDrafts` OPTION every visibility call below passes. */
function showDraftsOn() { return lsGet("cp_show_drafts", false); }

/* ---------- K-01: the founder's voice-engine probe switch ----------

   `docs/bundled-voice-plan.md` K-01 asks for the measurement to reach a phone
   behind the same unlock discipline HUMAN-ACTIONS.md #29 used — a hidden
   affordance, not a product feature. That instrument itself is gone (D-01
   deleted it, and `test/release-gates.test.js` keeps it deleted by name, so
   nothing here reuses its identifiers). On `main` today the shape that
   discipline has taken is `showDraftsOn` directly above: a `cp_` key, off by
   default, a
   drawer toggle that reads `<thing>: on|off`, and NOTHING RENDERED AT ALL
   while it is off. This follows it exactly rather than inventing a second
   idiom for the same job — there is one founder, and two ways of hiding a
   founder switch is one too many to explain over a phone.

   WHY A SWITCH AND THEN A BUTTON, rather than one button. The probe is a
   90-second synthesis loop that pins a CPU; a stray tap on it during a drive
   is a measurement nobody asked for and a battery reading nobody can use. The
   switch is the deliberate act; the button is the run. When the switch is off
   the run button is not merely disabled — it is not in the DOM, so the drawer
   is byte-identical to what shipped before this card (the same claim
   `test/draft-forays-switch.test.js` makes about its own switch, and
   `test/voice-probe-switch.test.js` makes here).

   `cp_voice_probe` goes through lsGet/lsSet like every other `cp_` key, has
   its row in `docs/legal/privacy-policy.md` §1, is counted by
   `test/data-deletion.test.js`, and is wiped by "Delete my data". `player/`
   never reads it — `ForayPlayer.runVoiceProbe()` takes no flag, because the
   decision of whether to offer the run belongs to the page. */
function voiceProbeOn() { return lsGet("cp_voice_probe", false); }

/** The visibility options every Foray surface hands the bridge: the `?foray=`
    unlock AND the switch, together, so no call site can pass one and forget
    the other.

    `showDrafts` is an OVERRIDE rather than a fixed field, because
    `splitTestTrackDrafts` needs both answers for the same unlock set: today's
    list, and then the same list with the drafts admitted. It built both option
    objects inline until the 2026-09-12 client audit — this function documents
    itself as the thing that stops a call site forgetting an option, and the one
    call site that needed a variant was the one that went around it. */
function forayViewOpts(overrides = {}) {
  return { unlocked: unlockedForays(), showDrafts: showDraftsOn(), ...overrides };
}

/** Order for the drafts the SWITCH admitted (never for the published list,
    whose order is the file's): generated ones newest first — the generator
    appends to `data/forays.json` as each lands and stamps no date, so the
    file's own order is the arrival order and its reverse is "newest first" —
    then any hand-authored draft in file order. */
function draftTrackOrder(drafts) {
  const generated = drafts.filter(f => f.generated === true).reverse();
  const authored = drafts.filter(f => f.generated !== true);
  return generated.concat(authored);
}

/** `listFn(opts)` -> `{ listed, drafts }`: the list a surface shows today,
    and — only when the switch is on — the drafts it admitted, in
    draftTrackOrder (an empty array otherwise). Two calls rather than one so
    `listed` is the SAME call, with the SAME options, that ran before the
    switch existed: with it off the second call never happens. */
function splitTestTrackDrafts(listFn) {
  const listed = listFn(forayViewOpts({ showDrafts: false }));
  if (!showDraftsOn()) return { listed, drafts: [] };
  const seen = new Set(listed.map(f => f.id));
  const drafts = draftTrackOrder(listFn(forayViewOpts({ showDrafts: true })).filter(f => !seen.has(f.id)));
  return { listed, drafts };
}

/** The two halves as one list: today's, then the test-track drafts. */
function withTestTrackDrafts(listFn) {
  const { listed, drafts } = splitTestTrackDrafts(listFn);
  return drafts.length ? listed.concat(drafts) : listed;
}

/* The player is an ES module and this is a classic script, so the bridge may
   not exist yet at first render. Wait for it once, rather than polling — and
   give up rather than hanging if the module failed to load at all, so a broken
   deploy shows a message instead of an empty page. */
const PLAYER_WAIT_MS = 5000;

function playerBridge() {
  if (window.ForayPlayer) return Promise.resolve(window.ForayPlayer);
  /* EACH WAIT CLEANS UP AFTER ITSELF (audit round 3, app-2-14). On the broken-
     deploy path the event never fires, and every visit to #/forays, Library or
     a Try again used to leave one listener and its closure attached for the
     session: finish() resolved but removed nothing. */
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("forayplayer:ready", finish);
      clearTimeout(timer);
      resolve(window.ForayPlayer || null);
    };
    window.addEventListener("forayplayer:ready", finish, { once: true });
    timer = setTimeout(finish, PLAYER_WAIT_MS);
  });
}

/* "STILL LOADING" IS NOT "FAILED TO LOAD" (audit round 2, states-6). A null
   bridge after the wait means one of two things, and the page used to answer
   both with a Try again that could only help with the first. Module scripts
   are deferred and run before `DOMContentLoaded`, so once parsing has finished
   (`readyState` is no longer "loading") every deferred module has either run
   — and the bridge would be here — or failed to fetch, parse or evaluate. That
   is `waitForStorage()`'s exact reading of the same event, applied to the
   other thing the module publishes. While the document is still parsing the
   module may simply be slow, and re-awaiting it (Try again) is right. */
function playerModuleFailed() {
  if (window.ForayPlayer) return false;
  /* NOT `readyState !== "loading"`: "interactive" comes BEFORE the deferred
     modules run (see `deferredScriptsRan`), so a module still downloading was
     called failed and offered a reload of the whole slow graph. */
  return deferredScriptsRan;
}

/* ---------- per-segment feedback (the learning loop's input) ----------

   The mockup's thumbs, and they are deliberately asymmetric: up is one silent
   tap, down opens a sheet and asks what missed. That asymmetry is the design's
   actual point — "not for me" is nearly useless to a learning job on its own,
   and a listener who has just been annoyed is the one moment they will tell you
   why. The vote is only committed when the sheet is submitted; dismissing it
   leaves the segment unvoted, exactly as `voteDown` does in the mockup.

   The event shape is NOT invented here. `docs/curation/events-client-integration
   -spec.md` §2 defines `thumbs` as `{direction, node_id, episode_slug?}` with
   `node_id` mandatory, and §4 records that no thumbs UI existed yet. A segment
   carries `topic` — a real taxonomy node id, checked against data/taxonomy.json
   — so it maps straight onto that contract with nothing made up. */

const FB_CHIPS = [
  "Not my subject", "Didn't like the voice", "Leans too far left",
  "Leans too far right", "Too surface-level", "Too in-the-weeds",
  "Bad audio quality", "Heard this already", "Just not this show",
];

/** The reasons that are about the SUBJECT, and so may move the interest
    profile. "Just not this show" is a show-level signal, not a topic one
    (docs/DECISIONS.md, the learning-job entry); the voice, the audio and
    "heard this already" say nothing about the subject at all. */
const TOPIC_REASONS = new Set(["Not my subject", "Too surface-level", "Too in-the-weeds"]);

function forayFeedback() { return lsGet("cp_foray_feedback", {}); }

function feedbackFor(segmentId) { return forayFeedback()[segmentId] || null; }

/** Record (or clear) a vote and emit the event. `reasons`/`note` only ever ride
    a down-vote — an up-vote has nothing to explain. */
/** The interest nudge a stored vote applied: +0.08 for an up, -0.08 for a down
    with a subject-shaped reason, 0 for anything else (p-foray-6). */
function voteNudge(vote) {
  if (!vote || !vote.direction) return 0;
  if (vote.direction === "up") return 0.08;
  return (vote.reasons || []).some(r => TOPIC_REASONS.has(r)) ? -0.08 : 0;
}

function setFeedback(entry, direction, { reasons = [], note = "" } = {}) {
  const all = forayFeedback();
  const segId = entry.segment_id;
  if (!segId) return;
  /* A VOTE REPLACES THE ONE BEFORE IT, nudge included (audit round 3, app-2-6).
     Clearing a vote, or changing it, used to leave the old nudge in place, so
     up, clear, up drove a topic to 1.0 in about thirteen taps. The previous
     vote's nudge is undone in the same step that applies the new one. */
  const undo = -voteNudge(all[segId]);
  if (!direction) delete all[segId];
  else all[segId] = { direction, reasons, note, ts: new Date().toISOString() };
  lsSet("cp_foray_feedback", all);

  if (direction) {
    logEvent("thumbs", {
      direction,
      node_id: entry.topic || null,
      episode_slug: entry.item_id || null,
      segment_id: segId,
      foray_id: state.foray ? state.foray.id : null,
      reasons,
      note: note.trim() || null,
    });
    /* A thumb is an action the listener took, so it moves the same weights
       playing something does — just harder, and in whichever direction.
       ONLY WHEN THE REASON IS ABOUT THE SUBJECT (audit round 2, p-foray-6): a
       down-vote for "Bad audio quality" or "Didn't like the voice" used to
       lower interest in the whole subject exactly like "Not my subject", so
       complaining about one host's microphone made Home show fewer startup
       episodes. The sheet promises specificity; the reasons now mean it. A
       down-vote with no subject-shaped reason is recorded as an event only. */
    const net = undo + voteNudge({ direction, reasons });
    if (net) nudgeTopics([entry.topic], net);
    trySyncEvents();
  } else if (undo) {
    /* A cleared vote logs nothing yet: the events contract only knows
       up/down (backend/src/types/events.ts ThumbsPayloadSchema), and a row the
       learning job cannot parse is worse than a missing retraction. The
       server-side half is recorded as a follow-up. */
    nudgeTopics([entry.topic], undo);
  }
  paintFeedback(segId);
}

function paintFeedback(segmentId) {
  const vote = feedbackFor(segmentId)?.direction || "";
  $("#view").querySelectorAll(`[data-seg-id="${CSS.escape(segmentId)}"]`).forEach(btn => {
    btn.classList.toggle("on", btn.dataset.thumb === vote);
    btn.setAttribute("aria-pressed", btn.dataset.thumb === vote ? "true" : "false");
  });
}

function thumbsHtml(entry) {
  // No taxonomy node means nowhere for the signal to land, and a control that
  // silently does nothing is worse than no control.
  if (!entry.segment_id || !entry.topic) return "";
  const vote = feedbackFor(entry.segment_id)?.direction || "";
  /* NAMED BY THE SHOW, NOT BY THE CURATION CODE. These used to read "More like
     ORI-1" — the same editorial shorthand the left gutter used to print, and
     the same reason it is gone: a screen reader was being handed a string from
     the spreadsheet a producer built the Foray in. `forayBeatName` is the one
     place that decides what a beat is called out loud, so the play button and
     the thumbs cannot name the same beat two different ways. */
  const named = forayBeatName(entry);
  const one = (dir, glyph, label) =>
    `<button type="button" class="fy-thumb ${vote === dir ? "on" : ""}" data-thumb="${dir}"
        data-seg-id="${esc(entry.segment_id)}" aria-pressed="${vote === dir}"
        aria-label="${esc(label)} ${esc(named)}">${glyph}</button>`;
  return `<div class="fy-fb">
    ${one("up", "👍", "More like")}${one("down", "👎", "Less like")}
  </div>`;
}

/* ---------- a beat's credit: whose work is this? ---------- */

/** An authored narration beat — 4a's own writing, read by 4a's own voice. The
    other authored type is `segment` (somebody else's tape); a `jingle` is
    neither and is credited to nobody. */
function isForayNarration(entry) {
  return entry?.type === "narration";
}

/* WHICH CATALOGUE SHOW A BEAT BELONGS TO, or null when nothing joins.

   Two joins, asked in this order, and the order is the point:

     1. THE IDENTIFIER, carried from the source row's id prefix by
        `showIdFromSourceId` in player/foray-resolve.js. It is only a candidate
        there — that module is pure and has no catalogue — so it is verified
        here, against the catalogue this surface already holds. An id that does
        not resolve is not linked; a `#/show/…` route for a show nothing knows
        renders "Show not found.", which is worse than plain text.
     2. THE TITLE, via `showIdForShowName`, which every other show link in the
        app already uses.

   Measured on the committed data (98 source rows): the identifier join answers
   for 76 and the title join for 78, and the first set is entirely INSIDE the
   second — so today the identifier join adds no linkable row the title join
   would have missed, and deleting it would not change a single rendered page.
   It is asked first anyway, because a publisher can reword a title and cannot
   reword the id we harvested the episode under; the only test that separates
   the two is therefore a synthetic renamed-show case, and it is labelled as
   such in test/foray-row-links.test.js.

   Across the eight committed Forays' 131 tape beats: 67 link by identifier, 9
   more by title, and 55 do not link at all. That 55 is almost entirely the two
   hand-curated grilling Forays and `capital-types-1`, whose small independent
   shows were never in the curated 220; all four GENERATED Forays link every
   beat they have. A show that does not join renders exactly today's plain text.

   Narration is excluded rather than falling through: a narration entry has no
   `show`, so the title join would return null anyway, but saying so here is
   what keeps the narrator's credit from ever being asked to be a link. */
function forayShowId(entry) {
  if (!entry || isForayNarration(entry)) return null;
  if (entry.show_id && showById(entry.show_id)) return entry.show_id;
  return showIdForShowName(entry.show);
}

/* ONE NAME FOR THE NARRATOR (audit round 2, p-foray-12): the credit, the
   header and the accessible name each spelled it differently ("AI Narrator",
   "4a's narrator", "4a's AI Narrator"). The player owns the name
   (`segment-strip.js` NARRATOR_NAME, which its own summary speaks); this page
   reads it through the bridge. The Foray page never renders without the
   bridge, so the fallback is a plain noun, not a second spelling. */
function narratorName() {
  return window.ForayPlayer?.narratorName || "the narrator";
}

/* The credit that leads a row's meta line: a link to the show, the show's name
   as plain text when it does not join, or the narrator's name for a beat we
   wrote.

   The narrator's credit is deliberately NOT a link. There is no 4a show page to send
   anyone to, and a control that navigates nowhere is worse than a label — the
   same rule `thumbsHtml` keeps. It carries the same class and sits in the same
   slot as a show credit so the two row kinds read as siblings: one credits a
   podcast, one credits us. */
function forayCreditHtml(entry) {
  if (isForayNarration(entry)) {
    return `<span class="fy-credit is-narrator">${esc(narratorName())}</span>`;
  }
  if (!entry.show) return "";
  const showId = forayShowId(entry);
  /* A real <a href>, not a button wired through JS, for the reason written
     against `taxonomyChip`: right-click, long-press and open-in-new-tab are
     browser behaviours a handler cannot fake. And a SIBLING of the play button
     rather than inside it, for the reason written against `thumbsHtml`: an
     interactive element inside a button is invalid HTML whose click never
     survives the parent's handler. */
  return showId
    ? `<a class="fy-credit show-link" href="#${esc(showRoutePath(showId))}">${esc(entry.show)}</a>`
    : `<span class="fy-credit" data-credit-show="${esc(entry.show)}">${esc(entry.show)}</span>`;
}

/** What a beat is called when it is spoken aloud — for the play button's
    accessible name and the thumbs'. The show and the beat's own `why` is what
    a listener would use to tell two rows apart; the curation code
    (`entry.label`) never was, and is no longer rendered anywhere on this page. */
function forayBeatName(entry) {
  if (isForayNarration(entry)) return `narration by ${narratorName()}`;
  return [entry.show, entry.why].filter(Boolean).join(", ") || "this clip";
}

/* ---------- a narration beat's transcript ---------- */

/* HOW LONG IS "LONG", AND WHY THIS NUMBER.

   Measured over the 157 scripted narration items in the four committed
   generated Forays. The lengths are not a smooth curve; they cluster by the
   beat's authored `mode`:

     hinge   36 items    95–134 chars
     frame   76 items    71–166, then a gap, then 305–1057
     marker   4 items   223–250
     patch   35 items   358–627
     carry    6 items   941–1332

   So there is a real empty band between 250 and 305: no committed script is
   anywhere in it. Every threshold inside that band partitions the committed
   data IDENTICALLY — 84 items render whole, 73 collapse — so the choice within
   it is arbitrary by construction, and the honest pick is its midpoint, which
   is as far as possible from the nearest real script on either side. A round
   200 or 300 would NOT have been arbitrary: 200 cuts through the markers and
   300 through the long frames, and either produces a "Show more" that reveals
   a line and a half.

   The clamp is SIX lines rather than four so that the tallest uncollapsed
   script (250 chars) and a collapsed one occupy about the same height — the
   card is one size whether or not it has a control on it. */
const NARRATION_CLAMP_CHARS = 277;

/* The transcript, and the control that opens it.

   The text is always in the DOM in full: the collapse is CSS (`-webkit-line-
   clamp` on `.fy-script.is-clamped`), so "Show more" is one class toggle, the
   card grows in place and every row below it moves down — no modal, no inner
   scroller, no second copy of the script to keep in sync. It also means a
   screen reader and a find-in-page reach the whole script while it is visually
   collapsed, which is the right trade for a transcript.

   The control is a SIBLING of the play button, not inside it — same invalid-
   HTML rule as the thumbs and the show link. */
function narrationScriptHtml(entry) {
  const script = typeof entry.script === "string" ? entry.script.trim() : "";
  if (!isForayNarration(entry) || !script) return "";
  const long = script.length > NARRATION_CLAMP_CHARS;
  const id = `fy-script-${esc(String(entry.ord))}`;
  const text = `<p class="fy-script${long ? " is-clamped" : ""}" id="${id}">${esc(script)}</p>`;
  const cites = citesHtml(entry);
  if (!long) return `<div class="fy-script-wrap">${text}${cites}</div>`;
  return `<div class="fy-script-wrap">
    ${text}
    <button type="button" class="fy-script-more" data-script-for="${id}"
        aria-expanded="false" aria-controls="${id}">Show more</button>
    ${cites}
  </div>`;
}

/* F-103: what the narrator's claims rest on, when the producer has recorded it.

   ABSENT IS THE NORMAL CASE and must look exactly like today: every committed
   Foray predates the pipeline change, and by the producer's honesty rule a page
   the verifier did not confirm ships no `cites` at all rather than shipping its
   unconfirmed sources as support. So silence here means "nothing confirmed",
   never "nothing was written", and the UI says nothing rather than implying
   either.

   A tape cite links to the cited show's page through the same two joins a tape
   beat's own credit uses; a print cite links out when it has a URL and is plain
   text when it does not. `player/foray-resolve.js` has already dropped any cite
   that could not be resolved, so nothing here can render an empty citation. */
function citesHtml(entry) {
  const cites = Array.isArray(entry.cites) ? entry.cites : [];
  if (!cites.length) return "";
  const one = (c) => {
    if (c.kind === "tape") {
      const showId = c.show_id && showById(c.show_id) ? c.show_id : showIdForShowName(c.show);
      const name = showId
        ? `<a class="show-link" href="#${esc(showRoutePath(showId))}">${esc(c.show)}</a>`
        : esc(c.show);
      return `<li>${name}${c.episode_title ? ` — ${esc(c.episode_title)}` : ""}</li>`;
    }
    const pub = c.url
      ? `<a class="show-link" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.publication)}</a>`
      : esc(c.publication);
    return `<li>${pub}</li>`;
  };
  return `<div class="fy-cites">
    <p class="fy-cites-head">Sources</p>
    <ul>${cites.map(one).join("")}</ul>
  </div>`;
}

/* Expand a transcript in place. Delegated rather than per button, so a Foray
   with forty narration beats costs one listener.

   NOTHING REPAINTS THIS LIST, so nothing has to restore the open state:
   `paintForay` and `paintFeedback` — the only two things that touch the running
   order after it is built — toggle classes on elements they find, and never
   rewrite `innerHTML`. The list is built once by `renderForay`, which only runs
   on a route change, and a route change is supposed to forget. */
/* BOUND ONCE, FROM init() (audit 2026-09-22). This used to be called from
   every renderForay, adding one more click listener to the persistent `#view`
   each time — `#view` outlives every render, only its innerHTML is replaced.
   With two listeners the second read the aria-expanded the first had just
   written and toggled it straight back, so "Show more" worked on odd visits to
   a Foray page and was dead on even ones. `stopPropagation` does not stop a
   sibling listener on the same node; binding once is the fix, and the
   delegation is why once is enough — the same argument onBackClick makes. */
function onForayScriptClick(e) {
  const btn = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-script-for]") : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const view = $("#view");
  const text = view ? view.querySelector(`#${CSS.escape(btn.dataset.scriptFor)}`) : null;
  if (!text) return;
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", open ? "false" : "true");
  setControlLabel(btn, open ? "Show more" : "Show less", null);
  text.classList.toggle("is-clamped", open);
}

function forayRow(entry) {
  const dur = window.ForayPlayer ? window.ForayPlayer.fmtSpan(entry.duration_sec) : "";
  /* HTML, not text, and named so — the credit is a link when the show joins.
     The duration stays escaped text and is joined on afterwards so a credit
     that comes back empty (a beat with no show at all) does not leave a
     dangling separator. */
  const credit = forayCreditHtml(entry);
  /* WHICH EPISODE (audit round 2, p-foray-5). The row said the show and the
     length, and the episode a clip came from lived only in the credits block
     at the foot of the page, so a caption about "his" shares or "Kahl" had
     nothing on the row to hang on. A narration beat has no episode. */
  const episode = !isForayNarration(entry) && entry.episode_title
    ? `<span class="fy-ep">${esc(entry.episode_title)}</span>` : "";
  const metaHtml = [credit, episode, dur ? esc(dur) : ""].filter(Boolean).join(" · ");
  /* The credit line is hoisted OUT of the play button, because a link inside a
     button is invalid HTML whose click never survives the parent's handler —
     the same rule that put the thumbs outside it. It reads in the same place it
     always did: the 52px curation-code gutter that used to indent this line is
     gone, so the hoisted line lands flush left where the indented one used to
     start. */
  /* THE LISTENER GETS A SENTENCE; THE REASON STAYS FOR US. It printed
     `Can't play: ${entry.reason}`, and the reasons are foray-resolve's own —
     "segment X is not in data/segments.json" — so the showcase page named a
     JSON file on our server to a listener (audit 2026-09-22, persona row 62).
     The raw reason rides on `data-reason`, where a field report can read it off
     the page and nobody reads it aloud. */
  if (!entry.playable) {
    return `<div class="fy-row is-out">
      <div class="fy-meta">${metaHtml}</div>
      <div class="fy-play-row">
        <div class="fy-jump">
          <div class="fy-body">
            <p class="fy-why">${esc(entry.why)}</p>
            <p class="fy-out" data-reason="${esc(entry.reason || "unresolved")}">This clip isn't available right now.</p>
          </div>
        </div>
      </div>
      ${narrationScriptHtml(entry)}
    </div>`;
  }
  /* The row used to BE the button. It cannot be any more: a thumb inside a
     button is invalid HTML and its click never survives the parent's handler.
     So the row is a container, the play affordance is the button inside it, and
     `data-fy` — which paintForay and the transport both key on — moves with the
     button, not with the container. */
  return `<div class="fy-row">
    <div class="fy-meta">${metaHtml}</div>
    <div class="fy-play-row">
      <button type="button" class="fy-jump${entry.why ? "" : " is-bare"}" data-fy="${esc(String(entry.queueIndex))}"
          data-fy-name="${esc(forayBeatName(entry))}" aria-label="${esc(forayJumpLabel(forayBeatName(entry), ""))}">
        <div class="fy-body">
          <p class="fy-why">${esc(entry.why)}</p>
        </div>
        <span class="fy-state" aria-hidden="true"></span>
      </button>
      ${thumbsHtml(entry)}
    </div>
    ${narrationScriptHtml(entry)}
  </div>`;
}

/** A clip row's accessible name, by where the listener is. The ▶ / ✓ that shows
    it on screen is a CSS glyph in an aria-hidden span, so for a screen reader
    the row's state lived nowhere: twelve identical "Play …" buttons, with no way
    to tell the one sounding now or the nine already heard (audit 2026-09-22).
    paintForay writes this beside the classes, from the same comparison. */
function forayJumpLabel(name, where) {
  if (where === "playing") return `Now playing: ${name}`;
  if (where === "played") return `Played. Play again: ${name}`;
  return `Play ${name}`;
}

function foraySlotHtml(slot) {
  if (!slot.entries.length) {
    return `<section class="fy-slot">
      <h3>${esc(slot.title)}</h3>
      <p class="note">Nothing in this part yet.</p>
    </section>`;
  }
  return `<section class="fy-slot">
    <h3>${esc(slot.title)}</h3>
    ${slot.entries.map(forayRow).join("")}
  </section>`;
}

/* ---------- the feedback sheet ---------- */

/* One sheet per page, reused for whichever segment was thumbed down. Built with
   the page (hidden) rather than on demand so there is no second render path to
   keep escaped. */
function feedbackSheetHtml() {
  return `<div class="fy-sheet" id="fy-sheet" hidden>
    <div class="fy-scrim" id="fy-scrim"></div>
    <div class="fy-panel" role="dialog" aria-modal="true" aria-labelledby="fy-sheet-title">
      <div class="fy-grab" aria-hidden="true"></div>
      <h3 id="fy-sheet-title">What missed for you?</h3>
      <p class="fy-sheet-sub" id="fy-sheet-sub"></p>
      <div class="fy-chips">${FB_CHIPS.map(c =>
        `<button type="button" class="fy-chip" data-chip="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div>
      <input id="fy-sheet-note" type="text" maxlength="200" placeholder="In your own words…" aria-label="What missed, in your own words">
      <div class="fy-sheet-actions">
        <button type="button" class="fy-sheet-cancel" id="fy-sheet-cancel">Cancel</button>
        <button type="button" class="fy-sheet-go" id="fy-sheet-go" disabled>Pick at least one</button>
      </div>
    </div>
  </div>`;
}

/** The segment the open sheet is about. Null when it is closed. */
let fbTarget = null;

function openFeedbackSheet(entry) {
  fbTarget = entry;
  const sheet = $("#fy-sheet");
  if (!sheet) return;
  $("#fy-sheet-sub").textContent =
    `About ${entry.show || "this clip"} — the more specific, the faster your picks get good.`;
  $("#fy-sheet-note").value = "";
  sheet.querySelectorAll("[data-chip]").forEach(c => setChipPressed(c, false));
  syncSheetCta();
  openSheet(sheet, { onRequestClose: closeFeedbackSheet });
}

function closeFeedbackSheet() {
  // Dismissing must NOT record the down-vote — the mockup only commits it on
  // submit, and a vote with no reason is the signal this sheet exists to avoid.
  fbTarget = null;
  const sheet = $("#fy-sheet");
  if (sheet) { closeSheet(sheet); sheet.hidden = true; }
}

/** A reason chip's selection, for the eye AND the ear. It was a class and a
    tint only, so a screen-reader user could not tell which reasons they had
    picked; the onboarding chips and the thumbs already wrote aria-pressed. */
function setChipPressed(chip, on) {
  chip.classList.toggle("on", on);
  chip.setAttribute("aria-pressed", on ? "true" : "false");
}

function sheetPicks() {
  return [...$("#fy-sheet").querySelectorAll("[data-chip].on")].map(c => c.dataset.chip);
}

function syncSheetCta() {
  const any = sheetPicks().length > 0 || $("#fy-sheet-note").value.trim().length > 0;
  const go = $("#fy-sheet-go");
  go.disabled = !any;
  setControlLabel(go, any ? "Tune my picks" : "Pick at least one", null);
}

function bindFeedback(r) {
  const bySegment = new Map(r.entries.filter(e => e.segment_id).map(e => [e.segment_id, e]));

  $("#view").querySelectorAll("[data-thumb]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = bySegment.get(btn.dataset.segId);
      if (!entry) return;
      const current = feedbackFor(entry.segment_id)?.direction || "";
      const dir = btn.dataset.thumb;
      // A second tap on the live vote clears it, in either direction — down
      // included, so undoing does not force the sheet open again.
      if (current === dir) return setFeedback(entry, null);
      if (dir === "up") return setFeedback(entry, "up");
      openFeedbackSheet(entry);
    });
  });

  const sheet = $("#fy-sheet");
  if (!sheet) return;
  sheet.querySelectorAll("[data-chip]").forEach(chip => {
    chip.addEventListener("click", () => { setChipPressed(chip, chip.getAttribute("aria-pressed") !== "true"); syncSheetCta(); });
  });
  $("#fy-sheet-note").addEventListener("input", syncSheetCta);
  $("#fy-scrim").addEventListener("click", closeFeedbackSheet);
  $("#fy-sheet-cancel").addEventListener("click", closeFeedbackSheet);
  $("#fy-sheet-go").addEventListener("click", () => {
    if (!fbTarget) return closeFeedbackSheet();
    setFeedback(fbTarget, "down", { reasons: sheetPicks(), note: $("#fy-sheet-note").value });
    closeFeedbackSheet();
  });
}

/* ---------- where this came from ---------- */

/* The publisher credit block. This is not decoration: a Foray plays nine
   episodes straight from their own enclosure URLs, so the download lands on the
   publisher's numbers — and until now the listener had no single place that said
   whose work they had spent an hour with, or how to go and get more of it. The
   grouping and the links are computed in player/foray-sources.js, where they are
   tested; this only renders them. */
function foraySourcesHtml(r, player) {
  // Deployed asynchronously from player/client.js (service worker, cache), so a
  // returning visitor can briefly hold a new app.js against an older module.
  // Losing the credit block is a missing section; throwing here is a blank page.
  if (typeof player.forayCredits !== "function") return "";
  const { credits, summary } = player.forayCredits(r, { discoverDoc: state.discover, collectionIds: showIndexCollectionIds(r) });
  if (!credits.length) return "";
  const clips = (n) => esc(countLabel(n, "clip"));
  /* THE ARROW SAYS WHERE IT GOES (audit round 2, p-foray-2). It was labelled
     "Open X on Apple Podcasts" for every show, while for a show with no known
     Apple id it opens a SEARCH results page. `linkKind` exists in
     player/foray-sources.js "so a surface can be honest about it". */
  const outLabel = (c) => c.linkKind === "apple-show"
    ? `Open ${c.show} on Apple Podcasts`
    : `Search Apple Podcasts for ${c.show}`;
  const rows = credits.map(c => `
    <div class="fy-src">
      <div class="fy-src-head">
        <span class="fy-src-show">${showNameLink(c.show)}</span>
        <span class="fy-src-meta">${clips(c.clips)} · ${esc(player.fmtSpan(c.seconds))}</span>
        <a class="fy-src-out" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener"
           data-src-show="${esc(c.show)}" data-link-kind="${esc(c.linkKind || "")}" aria-label="${esc(outLabel(c))}">↗</a>
      </div>
      <ul class="fy-src-eps">${c.episodes.map(e =>
        `<li>${esc(e.title)} <span>${clips(e.clips)}</span></li>`).join("")}</ul>
    </div>`).join("");
  return `<section class="fy-sources">
    <h3>Where this came from</h3>
    <p class="fy-src-note">${esc(summary)}. Every clip plays from the show's own feed.</p>
    ${rows}
  </section>`;
}

/** Show -> Apple collection id for this Foray's shows, from the show index's
    breadth rows (whose id IS the collection id; a curated row's id is a slug
    and is skipped). Upgrades the ↗ from a search to the show's own Apple page
    wherever the index knows the show — the same exact, unique title join. */
function showIndexCollectionIds(r) {
  const out = {};
  for (const show of new Set((r?.entries || []).map(e => e?.show).filter(Boolean))) {
    const id = showIndexIdForTitle(show);
    if (id && /^\d+$/.test(id)) out[show] = id;
  }
  return out;
}

/* THE JOIN THAT NEEDS THE INDEX, AFTER THE PAGE IS UP (p-foray-2). The index is
   ~200 KB and never on the boot path (the S-03 rules above loadShowIndex), so
   the page paints with what the catalogue knows and, only when some credited
   show has no page of its own, asks for the index once and relinks in place:
   the row credits, then the "Where this came from" block. Nothing is re-rendered
   that the transport owns. */
function joinForayCreditsToShowIndex(r, player) {
  if (showIndex) return;
  const unlinked = (r?.entries || []).some(e => e?.playable && e.show && !isForayNarration(e) && !forayShowId(e));
  if (!unlinked) return;
  loadShowIndex().then((idx) => {
    if (!idx || state.foray !== r) return;   // failed, or the listener has moved on
    relinkForayCredits(r, player);
  });
}

function relinkForayCredits(r, player) {
  const view = $("#view");
  if (!view) return;
  view.querySelectorAll(".fy-credit[data-credit-show]").forEach((span) => {
    const show = span.dataset.creditShow;
    const id = showIdForShowName(show);
    if (id) span.outerHTML = `<a class="fy-credit show-link" href="#${esc(showRoutePath(id))}">${esc(show)}</a>`;
  });
  const src = view.querySelector(".fy-sources");
  if (src) {
    src.outerHTML = foraySourcesHtml(r, player);
    bindSourceLinks(r);
  }
}

function bindSourceLinks(r) {
  $("#view").querySelectorAll("[data-src-show]").forEach(a => {
    a.addEventListener("click", () => {
      logEvent("source_opened", { foray_id: r.id, show: a.dataset.srcShow });
    });
  });
}

/* THE HEADER'S NUMBERS COME FROM THE STRIP'S MODEL (audit 2026-09-22, theme L).
   It used to count `r.playable.length` as "segments" — narrator bridges
   included — directly above a strip announcing a different number, and
   `r.shows`, which counts shows whose clips will never play, above a credits
   block that refuses to. `player.stripTally` is one definition for all three.

   AN ESTIMATE IS SAID TO BE ONE. A narrated Foray's bridges are timed from
   their script length until real audio exists, which is ~40% of the runtime
   on the ones that have them; printing that as "43:07" presented a
   character count as a stopwatch. When any item's duration is not measured,
   the runtime reads "about 43 min".

   An older cached module with no `stripTally` gets the runtime alone rather
   than counts from a second definition — a missing number is not a wrong
   one. */
/* ONE DIALECT FOR A FORAY'S LENGTH (audit round 2, p-foray-8): the header
   printed a measured runtime as a clock ("51:22") and an estimated one as
   "about 43 min", so one page wrote a length two ways, and no list said it at
   all. Minutes everywhere now, "about" when estimated; the ticking clock
   beside the scrubber keeps its clock shape. */
function forayRuntimeLabel(player, tally, totalSec) {
  if (typeof player?.fmtSpan !== "function") return "";
  return `${tally && tally.estimated ? "about " : ""}${player.fmtSpan(totalSec)}`;
}

/** "51 min · 22 clips · 7 shows": how long a Foray is and what it is made of,
    for every row and card that lists one (p-foray-8). The counts are the
    strip's own (`stripTally`), the narrator's clips counted as clips the way
    the strip counts them; "" when there is nothing resolved to read. */
function forayFactsLabel(r, player) {
  if (!r) return "";
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  return joinMeta(
    forayRuntimeLabel(player, tally, r.totalSec),
    tally ? countLabel(tally.clips + tally.bridges, "clip") : "",
    tally && tally.shows ? countLabel(tally.shows, "show") : "",
  );
}

function forayHeadSub(r, player) {
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  const parts = [];
  if (tally) {
    /* THE STRIP'S OWN WORDS (integration, 2026-09-22). L4 made every piece of a
       Foray a "clip" — the strip's label, the mini bar's "clip N of M", ‹‹/››
       — with the narrator's clips counted as the narrator's. L5's header
       counted tape only and said "with narration", so over a narrated Foray
       the header said "11 clips" and the strip beneath it "56 clips". One
       count now: the same total, split the same way the strip splits it. */
    const from = tally.shows ? ` from ${countLabel(tally.shows, "show")}` : "";
    parts.push(tally.bridges
      ? `${countLabel(tally.clips + tally.bridges, "clip")}: ${tally.clips}${from} and ${tally.bridges} from ${narratorName()}`
      : `${countLabel(tally.clips, "clip")}${from}`);
  }
  parts.push(forayRuntimeLabel(player, tally, r.totalSec));
  return joinMeta(...parts);
}

/* The back link on this page goes to `#/forays`, not `#/`. enterForayFromQuery's
   whole point is that a `?foray=` link lands somewhere the unlocked DRAFT is
   still listed, so the back button is not a dead end for the one person
   reviewing it. That list moved off Home to `#/forays` on 2026-09-03, so this
   link moved with it. */
async function renderForay(id) {
  setBodyClass("view-page");
  /* Every status this page can stop on has a ‹ back to the list, and each
     failure offers "Try again" wired to the thing that failed (audit
     2026-09-22, theme G). "Reload the page" was browser advice inside a native
     shell that has no page to reload, and it threw away where the listener
     was; the retry re-runs this route, which re-awaits the player, or re-fetches
     the three Foray documents. */
  $("#view").innerHTML = statusPageHtml({ note: "Loading…", back: "#/forays" });

  const player = await playerBridge();
  // Another route may have won while we waited for the module.
  if (forayRouteId() !== id) return;

  if (!player) {
    /* Failed outright — reload; merely slow — re-await (playerModuleFailed). */
    if (playerModuleFailed()) {
      $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "The player didn't load.", back: "#/forays", reload: true });
      bindReload($("#view"));
      return;
    }
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "The player didn't load.", back: "#/forays", retry: true });
    bindRetry($("#view"), () => renderForay(id));
    return;
  }
  if (!state.forays) {
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "Couldn't load forays right now.", back: "#/forays", retry: true });
    bindRetry($("#view"), retryForayDocs);
    return;
  }

  /* `forayViewOpts()` carries the `?foray=` unlock AND the test-track switch:
     a draft the switch listed must open and play through this same call, or
     the list would advertise a page that answers "isn't available". */
  const r = player.resolve(state.forays, {
    id,
    segmentsDoc: state.segments,
    sourcesDoc: state.segmentSources,
    ...forayViewOpts(),
  });
  // Same answer for "no such Foray" and "not published": a client that
  // distinguishes them announces the existence of unpublished work.
  if (!r) {
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "That foray isn't available.", back: "#/forays" });
    return;
  }
  state.foray = r;
  state.forayPainted = null;   // fresh DOM: the paint guard must not skip it

  const draft = r.foray.status !== "published";
  /* Which door the draft came through decides what the page says about it:
     "by name" is the `?foray=` unlock, today's sentence exactly; otherwise
     the test-track switch let it in, and the sentence says so. */
  const draftNote = !draft ? ""
    : unlockedForays().includes(r.id) ? "Draft — not published. You opened it by name; nobody else sees it."
    : "Draft — not published. Shown because \"Show draft Forays\" is on in Settings; nobody else sees it.";
  /* TWO POPULATIONS, AND ONLY ONE OF THEM IS "BELOW" (audit 2026-09-22).
     `r.unplayable` is the union of the entries that resolved but will not play
     — which ARE rows in the running order below, marked "Can't play" — and the
     items hydration dropped (a segment id missing from data/segments.json),
     which never become entries and so are listed nowhere. "3 can't play —
     listed below" over a running order listing none of them pointed at rows
     that do not exist. Each is now counted and said separately. */
  const shownOut = r.entries.filter(e => !e.playable).length;
  const missing = Math.max(0, r.unplayable.length - shownOut);
  /* Read the resume point BEFORE anything is wired up: it decides the clock the
     page opens on, which rows are already ticked off, and what the main button
     says. Against the LIVE runtime AND the live segment count, so a repaired
     data file cannot leave someone resuming past the end of a Foray that got
     shorter, or paint a running order that is entirely behind them.

     Still guarded, for a narrower reason than the one that used to be written
     here. The service worker no longer refreshes app.js and the ES module on
     separate schedules — since #233 both are revalidated on every load and a
     page that falls back to the cache is pinned to it — but the module is loaded
     from a deferred module script tag, and the native shells run with no worker
     at all. An older or not-yet-evaluated module costs the resume offer, which
     is a missing banner rather than a page stuck on "Loading…". */
  /* `resolved` is the freshness half of #40, and it is about STORED state rather
     than about the worker: a `cp_` position written days ago can name a segment
     that a later `data/forays.json` moved or dropped, however fresh both the code
     and the data are. With the resolved Foray in hand the player looks the stored
     SEGMENT up in the live order instead of trusting the stored index — so a
     segment that moved resumes to the same audio, and one that is gone degrades
     to a clamped clock with no row marked current, rather than seeking somewhere
     wrong. */
  /* `includeFinished` (audit round 2, honesty-2): a finished Foray used to open
     exactly like one never touched, no banner, no mark. It now says "Played"
     with a "Play again" beside it, the finished episode's word. Split here so
     `resume` keeps meaning "a place to start from", which a finished Foray is
     not: its main button starts from the top, as before. */
  const point = typeof player.forayResume === "function"
    ? player.forayResume(r.id, { totalSec: r.totalSec, itemCount: r.playable.length, resolved: r, includeFinished: true })
    : null;
  const played = point && point.finished ? point : null;
  const resume = played ? null : point;
  state.forayResume = resume;
  forayPaintedLive = null;
  /* The document changed under a stored position. Nothing user-facing — the
     resume already degraded correctly — but it is the one signal that says how
     often real listeners hit it, and #40 is explicit that a stale-data event must
     be visible in the data rather than inferred later. */
  if (resume && typeof player.forayDriftIsClean === "function" && !player.forayDriftIsClean(resume)) {
    logEvent("foray_progress_drift", {
      foray_id: r.id, drift: resume.drift,
      elapsed_sec: Math.round(resume.elapsedSec), index: resume.index,
    });
  }
  const nudge = forayNudgeSteps(player);

  $("#view").innerHTML = `
    <div class="page foray">
      <div class="page-head">
        <a class="back" href="#/forays">‹</a>
        <div>
          <h2>${esc(r.title)}</h2>
          <p class="sub">${esc(forayHeadSub(r, player))}</p>
        </div>
      </div>
      ${draft ? `<p class="fy-draft">${draftNote}</p>` : ""}
      ${r.foray.summary ? `<p class="fy-summary">${esc(r.foray.summary)}</p>` : ""}
      <div class="fy-transport">
        ${resume ? `<div class="fy-resume" id="fy-resume">
          <div class="fy-bar"><span class="fy-bar-fill" id="fy-bar-fill"></span></div>
          <p class="fy-resume-line">
            <span class="fy-resume-at">Jump back in at ${esc(player.fmtClock(resume.elapsedSec))}</span>
            <span class="fy-resume-left">${esc(resume.label)}</span>
          </p>
          <button type="button" class="fy-restart" id="fy-restart">Start over</button>
        </div>` : ""}
        ${played ? `<div class="fy-resume fy-played" id="fy-resume">
          <div class="fy-bar"><span class="fy-bar-fill" data-pct="100"></span></div>
          <p class="fy-resume-line">
            <span class="fy-resume-left">${esc(played.label)}</span>
          </p>
          <button type="button" class="fy-restart" id="fy-restart">Play again</button>
        </div>` : ""}
        <!-- Plain bars, replaced wholesale by the SegmentStrip component in
             mountForayStrip below (#128). They stay in the markup as the
             fallback for a page paired with an older cached module, and are the
             only reason this element is never empty. -->
        <div class="fy-strip" id="fy-strip">${r.playable.map((_, i) =>
          `<span class="fy-seg" data-seg="${i}"><i class="fy-seg-fill"></i></span>`).join("")}</div>
        <div class="fy-times"><span id="fy-now">0:00</span><span id="fy-total"></span></div>
        <!-- THE SEEK PAIR STAYS THE SEEK PAIR (audit 2026-09-22, persona 58).
             The two buttons beside Play were previous/next clip, so the
             gesture every other player has taught — missed a sentence, tap
             back — threw the listener to the top of an eleven-minute clip.
             ↺15 / 30↻ nudge on the Foray's own clock here, as they do in the
             Now Playing sheet; previous/next clip have their own row below,
             labelled in words. The numbers come from the player bridge so this
             page and the sheet cannot disagree about a step. -->
        <div class="fy-controls">
          <button type="button" class="fy-btn" id="fy-back" aria-label="Back ${nudge.back} seconds">↺ ${nudge.back}</button>
          <button type="button" class="fy-btn fy-main" id="fy-play"${controlLabelAttr("▶ Play", "Play")}>▶ Play</button>
          <button type="button" class="fy-btn" id="fy-fwd" aria-label="Forward ${nudge.fwd} seconds">${nudge.fwd} ↻</button>
          <!-- Playback speed (#242). On the transport row rather than in a settings
               screen, because this is the surface a listener is looking at when
               they decide a segment is slow — and its current value is the label,
               so it is legible without opening anything. The label and the
               accessible name both come from the player bridge, so this button and
               the mini-player's cannot word the same speed two ways. It opens the
               speed menu (a dialog, openRateMenu), and says so the way the
               sheet's button does (audit round 2, player-9): VoiceOver reads
               "pop-up button" before the tap, not a surprise after it. -->
          <button type="button" class="fy-btn fy-rate" id="fy-rate" aria-label="Playback speed" aria-haspopup="dialog">1×</button>
        </div>
        <!-- The guillemets are decoration: the accessible name is the words
             alone, or VoiceOver opens with "single left-pointing angle
             quotation mark" (visual pass 1 review, 2026-09-23). -->
        <div class="fy-clips">
          <button type="button" class="fy-clip" id="fy-prev" aria-label="Previous clip">‹ Previous clip</button>
          <button type="button" class="fy-clip" id="fy-next" aria-label="Next clip">Next clip ›</button>
        </div>
        <!-- A start that failed says so HERE, and a screen reader hears it
             without moving focus off the button that was just pressed. -->
        <p class="fy-error" id="fy-error" role="status" aria-live="polite" hidden></p>
      </div>
      ${shownOut ? `<p class="note">${countLabel(shownOut, "clip")} can't play — marked below.</p>` : ""}
      ${missing ? `<p class="note">${countLabel(missing, "clip")} from this foray couldn't be found, so ${missing === 1 ? "it's" : "they're"} left out.</p>` : ""}
      ${r.slots.map(foraySlotHtml).join("")}
      ${foraySourcesHtml(r, player)}
      ${feedbackSheetHtml()}
    </div>`;

  /* The clock beside the scrubber keeps its clock shape — it sits opposite a
     ticking one — but an estimate carries a "~" so it cannot pass for a
     measurement (same `stripTally` flag as the header above). */
  const tally = typeof player.stripTally === "function" ? player.stripTally(r.playable) : null;
  $("#fy-total").textContent = `${tally && tally.estimated ? "~" : ""}${player.fmtClock(r.totalSec)}`;
  mountForayStrip(r, player);
  // Optional-chained deliberately. This runs BEFORE every binder, so if the
  // markup and this line ever disagree the throw would take the whole transport
  // down with it — an unfilled progress bar is a far better failure. CI catches
  // the disagreement itself: the hook is pinned in player/foray-playback.test.js.
  if (resume) { const fill = $("#fy-bar-fill"); if (fill) fill.style.width = `${resume.percent}%`; }
  if (played) sizeProgressBars($("#view"));
  bindFeedback(r);
  bindSourceLinks(r);
  bindForayTransport(r, player, resume);
  pageDidPaint();   // the real page is up: a clamped back-step restore can land now
  joinForayCreditsToShowIndex(r, player);
}

/* The strip is the signature element (#128) and it is BUILT IN THE PLAYER
   MODULE, `player/segment-strip.js` — show colours, the capsule per source
   episode, the gap that makes a cross-episode seam visible, the narrator
   bridges and the accessible label all live there, and the Now Playing sheet
   (#133) will mount the same component rather than a second copy of it.

   No position is passed. The bars this page renders are handed straight over to
   `paintForay`/`paintSegFill`, which repaint past/current/upcoming four times a
   second from the live clock; mounting with a position too would mean two
   writers for one set of classes, disagreeing for one frame on every load.

   The fallback is not defensive noise. `renderForay` reaches this line only
   because `player.resolve` answered, so the module IS evaluated — but app.js
   and the module are separate cache entries and a page can be paired with an
   older module that has no `stripInto`. That one gets the template's plain bars
   and the sizing this function has always done — proportional, uncoloured and
   uncapsuled, which is what shipped before this change, rather than an empty
   strip. `.fy-seg`'s fallback tone in styles.css exists for exactly those bars:
   they carry no tone class, and the bordered grey they used to be would now be
   invisible, since the coloured bar has no border. */
function mountForayStrip(r, player) {
  const strip = $("#fy-strip");
  if (!strip) return;
  if (typeof player?.stripInto === "function") {
    player.stripInto(strip, r.playable, { size: "lg" });
    return;
  }
  sizeForayStrip(r);
}

/* Each segment's share of the strip is its share of the runtime. Set as a DOM
   property, never as a style attribute — the page CSP is style-src 'self'. */
function sizeForayStrip(r) {
  const strip = $("#fy-strip");
  if (!strip) return;
  r.playable.forEach((item, i) => {
    const seg = strip.children[i];
    if (!seg) return;
    seg.style.flexGrow = String(Math.max(1, Math.round(segLenOf(item))));
  });
}

/* A queue item's authored length, which has to be THE SAME length
   `player/foray-resolve.js` measures the Foray's clock in — that agreement is
   what keeps the bar's width, the bar's fill and a click's destination pointing
   at the same second. `stripElapsedAt` below maps a click onto `r.totalSec`, so
   any item this measures differently from `itemRuntimeSec` puts a click in the
   wrong place by the difference.

   It therefore asks the player, which owns the rule. `app.js` is a classic
   browser script and cannot `import` from `player/`, so the bridge carries it;
   the local arithmetic below is a fallback for the case where the player module
   has not booted, and it mirrors `itemRuntimeSec` branch for branch —
   INCLUDING the `duration_sec` fallthrough a narration item relies on, because
   a bridge measured as 0 s here would size to a 1px bar while occupying real
   seconds of the clock the click is mapped onto. */
function segLenOf(item) {
  const player = typeof window !== "undefined" ? window.ForayPlayer : null;
  if (typeof player?.itemLen === "function") return player.itemLen(item);
  // `isNum`, not `??`: `??` passes NaN straight through, so an
  // `authored_end_sec: NaN` would measure 0 here and its real length in
  // foray-resolve.js — the exact drift this shared helper exists to prevent.
  const num = (n) => typeof n === "number" && Number.isFinite(n);
  const end = num(item?.authored_end_sec) ? item.authored_end_sec : item?.end_sec;
  const start = item?.start_sec;
  if (num(start) && num(end) && end > start) return end - start;
  return num(item?.duration_sec) && item.duration_sec > 0 ? item.duration_sec : 0;
}

/* Where in the WHOLE Foray a click on the strip landed, in seconds, or null
   when the geometry cannot answer (no pointer coordinates, a strip with no
   width yet). Null is a real answer here, not a failure — the caller falls back
   to the segment that was hit, which is what the strip did before it could
   scrub.

   THE BARS ARE MEASURED, not assumed to tile the row evenly. This used to be a
   flat `frac * totalSec`, justified by a comment saying the gaps between the
   bars were "a fraction of a second". That was true of a uniform 2px gap and
   stopped being true with #128: a cross-episode seam is a wider break than a
   within-episode one and the seams fall where the EPISODES change, so the error
   no longer cancels along the row. Measured on `capital-types-1` at a 362px
   strip, separators are 20% of the width and a flat map lands up to 120 s from
   the pointer — far enough to be a different segment, in a control whose whole
   contract is "the position under the pointer is the position you get".

   So: find the bar the pointer is over and take the position INSIDE it. A click
   in a seam resolves to the boundary, which is the honest reading of a gap. */
function stripElapsedAt(e, r) {
  const strip = $("#fy-strip");
  if (!strip || typeof strip.getBoundingClientRect !== "function") return null;
  const x = e && typeof e.clientX === "number" ? e.clientX : null;
  return stripElapsedAtX(x, strip.getBoundingClientRect(), stripBarBoxes(strip), r);
}

/* The same question for a clientX and boxes the CALLER measured — at the click
   for a tap, or before the zoom for a held gesture (bindStripZoomScrub), whose
   release must not read the live rects: by then the zoom transform is being
   removed, and under reduced motion the strip is drawn un-zoomed while the
   finger is still in zoomed space (audit round 2, touch-1). One answer for
   both, so the two commits cannot drift. */
function stripElapsedAtX(x, rect, boxes, r) {
  if (x == null || !Number.isFinite(x) || !rect || !(rect.width > 0) || !r) return null;
  const measured = stripElapsedFromBoxes(boxes, x, rect, r);
  if (measured != null) return measured;
  if (!Number.isFinite(r.totalSec)) return null;
  const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return frac * r.totalSec;
}

/** The bars' boxes, or null when any bar cannot report one. */
function stripBarBoxes(strip) {
  const bars = strip && strip.children ? [...strip.children] : [];
  const boxes = [];
  for (const bar of bars) {
    if (typeof bar.getBoundingClientRect !== "function") return null;
    const box = bar.getBoundingClientRect();
    if (!box || !(box.width > 0)) return null;
    boxes.push(box);
  }
  return boxes;
}

/* The same question answered from the bars' own boxes, or null when they cannot
   answer it — a strip that has not been laid out, a bar count that disagrees
   with the queue, or a DOM whose elements do not report distinct geometry. Null
   rather than a confident wrong answer: the caller still has the flat map, which
   is approximate but never nonsense. */
function stripElapsedFromBoxes(boxes, x, rect, r) {
  const count = Array.isArray(r.playable) ? r.playable.length : -1;
  if (!boxes || boxes.length !== count || boxes.length === 0) return null;

  let spanned = 0;
  for (const box of boxes) spanned += box.width;
  // The bars have to actually TILE the row: each one starting at or after the
  // end of the last, and the whole set no wider than the strip. Anything else
  // is a DOM that is not laying out (or a stub reporting one box for every
  // element), and a per-bar answer read off it would be wrong with confidence.
  if (spanned > rect.width + 1) return null;
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].left + 0.5 < boxes[i - 1].left + boxes[i - 1].width) return null;
  }

  let acc = 0;
  for (let i = 0; i < boxes.length; i++) {
    const len = segLenOf(r.playable[i]);
    if (x < boxes[i].left) return acc;                     // in the seam before it
    if (x <= boxes[i].left + boxes[i].width) {
      return acc + ((x - boxes[i].left) / boxes[i].width) * len;
    }
    acc += len;
  }
  return acc;                                               // past the last bar
}

/* The floating magnifier bubble itself (V2). ONE element for the whole page,
   built lazily on first use and reused across gestures/strips — a Foray page
   can be re-rendered mid-session (`paintForay`) and a bubble tied to a stale
   strip element would leak. Appended to `document.body` (not `#fy-strip` or
   `#foray-player`) because `position: fixed` coordinates are viewport-
   relative and a `transform: scale()` ancestor (the zooming strip itself)
   would otherwise warp them — the exact trap `zoomOriginPercent`'s own
   header calls out for the strip's own rect. */
let bubbleEls = null;

function bubbleDomEl(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function ensureBubbleEls() {
  if (bubbleEls) return bubbleEls;
  const bubble = bubbleDomEl("div", "fy-strip-bubble");
  bubble.hidden = true;
  const viewport = bubbleDomEl("div", "fy-strip-bubble__viewport");
  const marker = bubbleDomEl("div", "fy-strip-bubble__marker");
  bubble.append(viewport, marker);
  document.body.append(bubble);
  bubbleEls = { bubble, viewport };
  return bubbleEls;
}

/* Press-and-hold zoom-to-scrub on #fy-strip (V1 in-place zoom + V2 floating
   bubble).

   Joey, live iPhone testing: "a brief click just jumps ahead to that
   location; if I press and hold then there's a bubble view that pops up
   showing a zoomed-in portion of the timeline and the location of the
   scrubber/where I'm trying to jump to" — the iOS text-cursor-magnifier
   pattern. V1 shipped the in-place scaled strip; this also floats a small
   bubble ABOVE the touch point (never under the thumb) showing a genuinely
   magnified crop of the strip around it, tracking the finger as it drags.

   THE STATE MACHINE IS NOT HERE. player/strip-scrub-gesture.js decides tap
   vs hold vs drag as pure data, and now also the bubble's position/content-
   offset arithmetic (`bubblePosition`, `bubbleContentOffset`); this function
   only owns the real pointerdown/pointermove/pointerup listeners and the
   real setTimeout, and translates the module's state into DOM.

   THE SEEK IS THE CALLER'S, THROUGH `commit`. A plain tap still commits in
   `#fy-strip`'s `click` handler (bound just above this call site); a gesture
   that entered zoom commits HERE, on `pointerup`, through the same
   `commitStripSeek` the click handler uses — one implementation of "where did
   they drop it", two entry points. This file shipped believing a `click`
   follows every release; it does for a mouse, and WebKit and Chrome on
   Android both withhold it once a touch has moved past tap slop (and WebKit
   again once the touchmove below is cancelled), so on a phone the whole
   gesture — zoom, bubble, marker — ended in nothing (audit round 2, touch-1).
   The release position is read against the PRE-zoom rect and bar boxes,
   mapped through the origin the zoom was drawn with (`unzoomedX`), never
   from a rect measured at release — see `stripElapsedAtX`. A mouse does still
   deliver the click after a committed release, and `_seekCommitted` tells the
   click handler that one has been answered.

   `setPointerCapture` keeps events routed to the strip even though scaling
   moves it visually out from under the finger mid-gesture — without it a
   drag toward the zoomed edge would silently stop delivering pointermove. */
function bindStripZoomScrub(r, player, commit = null) {
  const strip = $("#fy-strip");
  const gest = player?.scrubGesture;
  if (!strip || !gest) return;

  let gesture = null;
  let holdTimer = null;
  let pointerId = null;
  let preZoomRect = null;
  let preZoomBoxes = null;
  let zoomOriginPct = null;

  const clearHoldTimer = () => {
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
  };

  /* `preZoomRect` (and the bars' boxes with it) is captured once, before any
     zoom transform exists — re-measuring mid-zoom would feed the origin math a
     box already distorted by the previous frame's scale() (see
     zoomOriginPercent's own header). It is cleared on release so the next
     gesture measures fresh. */
  const measurePreZoom = () => {
    if (preZoomRect) return;
    preZoomRect = strip.getBoundingClientRect();
    preZoomBoxes = stripBarBoxes(strip);
  };
  const applyZoomVisual = (clientX) => {
    measurePreZoom();
    const pct = gest.originPercent(clientX, preZoomRect);
    if (pct == null) return;
    zoomOriginPct = pct;
    // CSSOM, not a style attribute — the page CSP is style-src 'self', same
    // rule segment-strip.js and paintSegFill already live under.
    strip.style.setProperty("--zoom-origin", `${pct}%`);
    strip.style.setProperty("--zoom-scale", String(gest.ZOOM_SCALE));
    strip.classList.add("is-zooming");
  };

  /* Where a zoomed release lands in the hour, from what was measured BEFORE
     the zoom. A bridge without `unzoomedX` (an older cached module) gets the
     finger's own x, which is what the mapping returns whenever the origin was
     anchored under the finger — every move re-anchors it there. */
  const zoomedElapsedAt = (clientX) => {
    if (!preZoomRect) return null;
    const x = typeof gest.unzoomedX === "function"
      ? gest.unzoomedX(clientX, preZoomRect, zoomOriginPct, gest.ZOOM_SCALE)
      : clientX;
    return stripElapsedAtX(x, preZoomRect, preZoomBoxes, r);
  };

  /* The bubble's cloned content is built ONCE per gesture, at the moment it
     first opens — not per-frame — because it is a snapshot of the strip's
     bars (fill widths included), not a live mirror; a gesture is at most a
     few seconds and the underlying Foray position does not repaint the
     strip during a hold (the pointer has captured input). Re-cloning every
     pointermove would be wasted DOM churn for no visible difference. */
  const openBubble = (clientX, clientY) => {
    measurePreZoom();
    const { bubble, viewport } = ensureBubbleEls();
    viewport.replaceChildren();
    const clone = strip.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.remove("is-zooming");
    clone.style.setProperty("width", `${preZoomRect.width}px`);
    clone.style.setProperty("height", `${preZoomRect.height}px`);
    clone.style.setProperty("transform-origin", "0 0");
    viewport.append(clone);
    bubble.hidden = false;
    updateBubble(clientX, clientY);
  };

  const updateBubble = (clientX, clientY) => {
    if (!preZoomRect || !bubbleEls || bubbleEls.bubble.hidden) return;
    const { bubble, viewport } = bubbleEls;
    const clone = viewport.firstElementChild;
    if (!clone) return;
    const viewportBox = { width: window.innerWidth, height: window.innerHeight };
    const pos = gest.bubblePosition(clientX, clientY, viewportBox);
    if (pos) {
      bubble.style.setProperty("width", `${pos.width}px`);
      bubble.style.setProperty("height", `${pos.height}px`);
      bubble.style.setProperty("left", `${pos.left}px`);
      bubble.style.setProperty("top", `${pos.top}px`);
    }
    const offset = gest.bubbleContentOffset(clientX, preZoomRect, gest.BUBBLE_WIDTH, gest.BUBBLE_SCALE);
    if (offset != null) {
      clone.style.setProperty(
        "transform",
        `translateX(${offset}px) scale(${gest.BUBBLE_SCALE})`,
      );
    }
  };

  const closeBubble = () => {
    if (!bubbleEls) return;
    bubbleEls.bubble.hidden = true;
    bubbleEls.viewport.replaceChildren();
  };

  const clearZoomVisual = () => {
    strip.classList.remove("is-zooming");
    strip.style.removeProperty("--zoom-origin");
    strip.style.removeProperty("--zoom-scale");
    preZoomRect = null;
    preZoomBoxes = null;
    zoomOriginPct = null;
    closeBubble();
  };

  const finish = () => {
    clearHoldTimer();
    gesture = gest.end(gesture);
    clearZoomVisual();
    pointerId = null;
  };

  strip.addEventListener("pointerdown", (e) => {
    // One gesture at a time; a second finger touching the strip mid-hold is
    // not a scrub, and letting it interrupt the first would jump the preview.
    if (pointerId != null) return;
    // Right/middle-click never means "press and hold" on desktop; only the
    // primary pointer starts a gesture.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    /* A new press is a new question: whatever the LAST gesture turned out to
       be must not swallow this one's click. (Reset here rather than in the
       click handler because a touch scroll that the browser takes over never
       produces a click at all, so a flag cleared only by a click would sit
       armed and eat the next genuine tap.) */
    strip._scrollGesture = false;
    strip._seekCommitted = false;
    pointerId = e.pointerId;
    gesture = gest.start(e.clientX, e.clientY);
    if (typeof strip.setPointerCapture === "function") {
      try { strip.setPointerCapture(pointerId); } catch { /* unsupported in some test DOMs; degrades to normal bubbling */ }
    }
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      gesture = gest.holdTimeout(gesture);
      if (gesture.zooming) { applyZoomVisual(e.clientX); openBubble(e.clientX, e.clientY); }
    }, gest.HOLD_MS);
  });

  strip.addEventListener("pointermove", (e) => {
    if (pointerId == null || e.pointerId !== pointerId || !gesture) return;
    const wasZooming = gesture.zooming;
    gesture = gest.move(gesture, e.clientX, e.clientY);
    /* The finger went mostly VERTICAL before a scrub began: the listener is
       scrolling the running order, not aiming at a second of the hour
       (audit 2026-09-22 — the sticky strip sits in the path of every scroll
       flick, and this used to end in a seek). Let go of the pointer so the
       page can have it, and arm the click handler to ignore the click a
       mouse release would still deliver. `touch-action: pan-y` in
       styles.css is what lets a touch flick actually scroll. */
    if (gesture.scrolled) {
      strip._scrollGesture = true;
      if (typeof strip.releasePointerCapture === "function") {
        try { strip.releasePointerCapture(pointerId); } catch { /* already released */ }
      }
      finish();
      return;
    }
    if (gesture.zooming) {
      // Entered zoom by dragging past tolerance rather than by waiting out
      // the hold timer — the timer would otherwise still fire later and flip
      // the visual back on (harmlessly, since holdTimeoutGesture is a no-op
      // once already zooming, but there is no reason to let it run).
      if (!wasZooming) clearHoldTimer();
      applyZoomVisual(e.clientX);
      if (!wasZooming) openBubble(e.clientX, e.clientY);
      else updateBubble(e.clientX, e.clientY);
    }
  });

  strip.addEventListener("pointerup", (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    /* Read BEFORE finish(): it clears the pre-zoom measurements. A gesture
       that never zoomed is a tap, and a tap's click commits it. */
    const at = gesture && gesture.zooming ? zoomedElapsedAt(e.clientX) : null;
    finish();
    if (at == null) return;
    strip._seekCommitted = true;
    if (typeof commit === "function") commit(at);
  });
  strip.addEventListener("pointercancel", (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    finish();
  });
  /* A ZOOMED SCRUB KEEPS THE FINGER (review 2026-09-23). `touch-action: pan-y`
     is read once, at pointerdown, so the browser owns every vertical pan even
     after the hold has entered zoom: a thumb that drifted down or diagonally
     before moving sideways started a page scroll, the browser fired
     pointercancel, and `finish()` dropped the zoom and the bubble with no seek.
     Cancelling the touchmove while zoomed is the one way `pan-y` still allows
     to keep the page still. NON-passive, or the browser ignores the cancel.
     A still-pending gesture is left alone, so a flick still scrolls. */
  strip.addEventListener("touchmove", (e) => {
    if (gesture && gesture.zooming && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
  }, { passive: false });
}

/* The fill inside the bar the listener is currently inside — the one thing on
   this page that has to move continuously, and the reason it is painted above
   `paintForay`'s segment-change guard.

   It also makes the seam beat visible: for the 0.5 s between two segments the
   fill sits still at a boundary, so the pause you hear is a pause you can see.

   Which bar to fill comes from the CLOCK, not from the caller's index: the two
   agree (`forayPosition()` reports a segment's start until that segment is the
   one actually loaded), and deriving it from the same `segmentAtElapsed` the
   scrubber uses is what stops the bar and the click destination from drifting
   apart. `started` is only a gate — with nothing played and nothing stored,
   every bar stays empty rather than filling the first one to 0%.

   Widths are DOM properties, never style attributes (CSP `style-src 'self'`). */
function paintSegFill(started, elapsedSec) {
  const strip = $("#fy-strip");
  const player = window.ForayPlayer;
  if (!strip || !state.foray || !started) return;
  if (typeof player?.segmentAt !== "function") return;
  const at = player.segmentAt(state.foray.playable, elapsedSec);
  if (!at) return;
  const fill = fillOf(strip, at.index);
  if (!fill) return;
  const len = segLenOf(state.foray.playable[at.index]);
  const pct = len > 0 ? Math.max(0, Math.min(100, (at.into / len) * 100)) : 0;
  fill.style.width = `${pct}%`;
}

function fillOf(strip, i) {
  const seg = strip.children ? strip.children[i] : null;
  return seg && seg.children ? seg.children[0] : null;
}

const FORAY_IDLE = { index: -1, playing: false, ended: false, elapsedSec: 0 };

/* THE TWO THINGS A FAILED START MAY SAY, and there are only two because only
   two can be acted on.

   Autoplay refusal is not a fault. The browser is holding audio back until it is
   certain a person asked for it, which is a rule we live under rather than a bug
   — so it gets a plain instruction and the play button beneath it is the
   affordance, never a red line about an error. Everything else is a segment that
   did not arrive, where the connection is the first thing to check.

   Matched on the player's telemetry STRING rather than a structured field on
   purpose: app.js and player/client.js are cached and refreshed independently by
   the service worker (see the note in `renderForay`), so this page is regularly
   paired with a module of a different vintage. `NotAllowedError` is a DOM
   exception name — it is stable in both directions across that skew. */
/* WORDED FOR BOTH HOMES OF THIS FILE (audit 2026-09-22, qa row 141). The same
   bytes run in a browser tab and inside the Capacitor shell, where there is no
   visible browser and no reload button, so "your browser" and "reload the page"
   were instructions a phone listener could not follow. */
const FY_AUTOPLAY_HINT = "4a couldn't start the audio on its own — press play again and it will start.";
const FY_START_FAILED = "That clip couldn't load. Check the connection, then press play.";
/* A control that threw while the Foray was already running is a third thing, and
   it must not claim a segment failed to load: nothing did, the audio is still
   going, and the honest report is that the button did not take. */
const FY_TAP_FAILED = "That didn't register. Try it again, or restart 4a if it keeps happening.";

const FY_VOICE_FALLBACK = "Your chosen voice isn't installed; using the best available.";

function forayFailureCopy(signal) {
  return /NotAllowedError/.test(String(signal ?? "")) ? FY_AUTOPLAY_HINT : FY_START_FAILED;
}

/** Say it on the page. `signal` is whatever evidence there is — the player's own
    error line, or a caught exception — and null clears the line. */
function paintForayFailure(signal) {
  const copy = signal ? forayFailureCopy(signal) : "";
  // A browser being careful about audio is not an error, and must not be dressed
  // as one. styles.css tones `.is-hint` down to a note.
  paintForayNotice(copy, copy === FY_AUTOPLAY_HINT);
}

/** The one writer of the Foray page's notice line. It is a live region, so an
    unchanged message is not written again — see setStatusText. */
function paintForayNotice(text, hint) {
  const err = $("#fy-error");
  if (!err) return;
  err.hidden = !text;
  setStatusText(err, text);
  err.classList.toggle("is-hint", Boolean(text) && Boolean(hint));
}

/* Every tap on this page's transport goes through one of these two (#225).

   The click handlers are `async`, so a call that threw became an unhandled
   promise rejection: a console line, and a page that did not move a pixel. On a
   phone there is no console, which makes that outcome indistinguishable from a
   dead app — the founder's report was "starting it was difficult, not sure why".

   THEY DIFFER IN WHAT THEY MAY ASSUME, which is why they are two functions.
   A start that threw got nowhere, so the "this Foray is live" flag that the
   intent-paint set is a lie and has to go, or the next press of the main button
   means pause instead of another attempt. A control that threw while the Foray
   was ALREADY running is the opposite: the audio is still going, the player's own
   state is still the truth, and clearing the page's flags would leave a button
   labelled "Pause" that means "start" — the very confusion this issue is about.
   That one says so and touches nothing; the next tick owns the state. */
/* The record's copy of a failed tap (#225), and the only evidence that outlives
   the message on screen.

   A console line is not evidence on a phone — that is the whole reason #225 was
   reported as "several errors" with no error in it. `cp_diag` already holds the
   browser's side of a refusal (`play.rejected` becomes a `stop/autoplay` entry);
   this is the page's side, the exception that actually came back out of
   `playForay`, which nothing else in the record can see.

   WRAPPED, AND THE WRAP IS THE POINT. This runs inside the two guards that are
   this page's last defence against an unhandled rejection. A diagnostic that
   threw here would take the on-screen message down with it and restore the exact
   failure mode the issue is about: a tap that does nothing and says nothing.
   `record()` and `save()` are both written never to throw — but the function on
   `window` comes from a module the service worker refreshes independently of this
   file (see the vintage note in `renderForay`), so "never throws" is a property
   of a version, not of this call. Checked, and caught anyway.

   THE NAME, NEVER THE MESSAGE. `err.message` carries URLs and prose, and this
   record is built to be pasted into an issue. `player/diagnostic-log.js` drops
   anything that is not a bare identifier, so a message would be discarded there
   regardless; sending only the name means the rule is visible on both sides. */
function noteTapFailure(phase, err) {
  /* READ THE NAME IN ITS OWN GUARD. `err` is whatever was thrown, and reading a
     property off it can itself throw — a Proxy, a getter, an object from another
     realm. Folded into the guard below, a failure here would skip the write
     entirely, so the one error too strange to describe would also be the one that
     left no trace. `null` is a worse answer than `TypeError` and a far better one
     than silence. */
  let name = null;
  try { name = err?.name ?? null; } catch (_) { name = null; }
  try {
    if (typeof window.forayNoteTapFailure === "function") {
      window.forayNoteTapFailure(phase, name);
    }
  } catch (_) {
    /* A record that will not write is not a reason to lose the line on screen. */
  }
}

async function guardForayStart(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] start failed", err);
    state.forayPlaying = null;
    state.forayPainted = null;
    /* THE PAINT FIRST AND THE RECORD LAST, but the record lands either way.

       The order: the bridge comes from a module the service worker refreshes
       independently of this file, which is why it is wrapped at all. A `try`
       covers a throw and not a slow synchronous write, and every statement
       between the catch and the paint is one that can stand between a listener
       and the only thing on screen telling them what happened. #225 is a
       listener-facing bug, so the listener is served first.

       The `finally`: the argument to `paintForayFailure` is built before the call,
       and `String(err)` and both template reads throw on an exotic or hostile
       `err` — the same hazard `diagnostic-log.js`'s `asText` exists for. Without
       the `finally`, moving the record after the paint would mean that a failure
       to paint costs the record too, in exactly the case the evidence matters
       most: the surface did not appear, which IS this issue's literal symptom.

       And the signal is built in its own guard first, because that argument is
       evaluated BEFORE the call: `String(err)` and both template reads throw on a
       hostile `err`, and an exception raised here would escape this catch block
       and become the unhandled rejection the whole guard exists to prevent.
       "Error" is a poor description and it still reaches the listener as the
       ordinary load-failure line, which is the honest fallback — something failed
       and pressing play again is the thing to do. */
    let signal = "Error";
    try {
      signal = err?.name ? `${err.name}: ${err.message ?? ""}` : String(err);
    } catch (_) { /* an error too strange to describe is still an error */ }
    try {
      paintForayFailure(signal);
    } finally {
      noteTapFailure("start", err);
    }
    return null;
  }
}

async function guardForayTap(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] control failed", err);
    paintForayNotice(FY_TAP_FAILED, false);
    // Last, for the reason given in `guardForayStart` above.
    noteTapFailure("control", err);
    return null;
  }
}

/** The ↺ / ↻ step sizes, from the player bridge so the Foray page, the Now
    Playing sheet and the mini bar name one number; the fallback is the same
    pair player/media-session.js exports, for a page paired with an older
    cached module. */
function forayNudgeSteps(player) {
  try {
    const s = player && typeof player.nudgeSteps === "function" ? player.nudgeSteps() : null;
    if (s && Number.isFinite(s.back) && Number.isFinite(s.fwd)) return { back: s.back, fwd: s.fwd };
  } catch (_) { /* fall through to the documented pair */ }
  return { back: 15, fwd: 30 };
}

function bindForayTransport(r, player, resume = null) {
  const onChange = (s) => paintForay(s);
  const nudge = forayNudgeSteps(player);

  /* The discover pool is the only document we have that carries per-show
     artwork, and a lock screen wants a picture (#27). Passed from here rather
     than resolved inside the player because app.js is the side that owns the
     fetch; its absence costs the OS the publisher’s square and nothing else.
     Spread into all three entry points below so a new one cannot forget it. */
  const forayOpts = { onChange, discoverDoc: state.discover };

  /* Both funnels are a `guardForayStart`, and the call into the player is the
     FIRST thing inside it — no await, no lookup, nothing between the tap and
     `playForay`. Safari only lets audio start inside the gesture that asked for
     it, and the gesture is spent by the first thing that waits (#225). Clearing
     the failure line is cleared in the same breath, because the message from the
     last attempt is not evidence about this one — inside the guard, so even that
     cannot become the unhandled rejection this whole thing is about. */
  const start = (index) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startIndex: index, ...forayOpts })));
  const startAt = (elapsedSec) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startElapsedSec: elapsedSec, ...forayOpts })));
  /* The main button, pressed cold. With a stored position that means RESUME —
     the whole point of the feature — and an explicit index (a row, the strip)
     always wins, because the listener just named a segment. */
  /* FROM `state.forayResume`, NOT THE BIND-TIME `resume` (audit round 3,
     app-3-1). The closure was the point captured when the page rendered, so
     after play -> advance -> close the bar, Play restarted from that old point
     (or 0) and the player's next save overwrote the real one. paintForay
     re-reads the stored point when this Foray goes from live to cold. */
  const startOrResume = () => state.forayResume ? startAt(state.forayResume.elapsedSec) : start(0);

  $("#fy-restart")?.addEventListener("click", async () => {
    if (typeof player.clearForayResume === "function") player.clearForayResume(r.id);
    logEvent("foray_restart", { foray_id: r.id, from_sec: Math.round(state.forayResume?.elapsedSec || resume?.elapsedSec || 0) });
    resume = null;
    state.forayResume = null;
    $("#fy-resume")?.remove();
    await start(0);
  });

  /* Playback speed (#242, popup menu #349). Bound BEFORE the "nothing playable"
     bail-out below and labelled from the stored value, because neither depends
     on this Foray: the speed is global (one `cp_rate` for the app — a speed is
     a fact about the listener, not about the audio), it is settable before
     anything has started, and a Foray with no playable segments still leaves a
     listener who may want to set it for the next one. `paintForay` relabels it
     on every tick from the snapshot, so a change made in the mini-player's
     sheet shows up here too **while a Foray is live** — `notifyForay` has
     nothing to notify when the player is on a single episode, so in that one
     case this button keeps its label until the page is rendered again. Stated
     rather than fixed: the value itself is always right (it lives in
     `cp_rate`, which both controls read), the stale thing is a label on a page
     whose Foray is not the thing playing, and a rate-only broadcast channel is
     more machinery than that is worth.

     THE BUTTON USED TO CYCLE ON TAP — one press silently jumped straight to
     the next stop, with no way to see the other five without repeated taps or
     to tell where "next" would land. Every major podcast app (Apple, Spotify,
     Overcast, Pocket Casts) opens a menu naming every stop instead. Tapping
     `#fy-rate` now opens that menu; nothing changes until a stop is tapped. */
  const rateBtn = $("#fy-rate");
  if (rateBtn && typeof player.rateStops === "function" && typeof player.setPlaybackRate === "function") {
    paintRateButton(player, player.playbackRate());
    rateBtn.addEventListener("click", () => guardForayTap(() => {
      openRateMenu(player, (rate) => paintRateButton(player, rate));
    }));
  }

  // Nothing playable is not a disabled-looking button that still fires: say it
  // with the control's own state, so the page and the behaviour agree.
  if (!r.playable.length) {
    ["#fy-play", "#fy-next", "#fy-prev", "#fy-back", "#fy-fwd"].forEach(sel => { $(sel).disabled = true; });
    setControlLabel($("#fy-play"), "Nothing to play", null);
    return;
  }

  $("#fy-play").addEventListener("click", async () => {
    if (playerHasForay(r)) return guardForayTap(() => player.forayToggle());
    // Only the real start is an event. Logging a pause as a play is the kind of
    // small lie that makes a metric useless six months later.
    logEvent("foray_play", {
      foray_id: r.id, segments: r.playable.length,
      resumed_from_sec: state.forayResume ? Math.round(state.forayResume.elapsedSec) : null,
    });
    await startOrResume();
  });
  // Before anything has started, every transport button means "start it" — a
  // next that begins at segment 2 silently drops the opening of the Foray.
  $("#fy-next").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayNext()) : startOrResume());
  $("#fy-prev").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayPrevious()) : startOrResume());
  /* The nudges seek on the Foray's clock (`player.nudge`, the same function the
     sheet's ↺15 / 30↻ and the mini bar's ↺15 call); before anything has
     started they start it, like every other transport button here. */
  $("#fy-back").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.nudge(-nudge.back)) : startOrResume());
  $("#fy-fwd").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.nudge(nudge.fwd)) : startOrResume());

  $("#view").querySelectorAll("[data-fy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.dataset.fy);
      if (playerHasForay(r)) await guardForayTap(() => player.forayJump(index));
      else await start(index);
    });
  });

  /* The strip is a scrubber, not 32 buttons.

     It looked like a scrubber from the day it shipped — a proportional bar of
     the whole hour — and behaved like a row of jump targets, snapping to the
     head of whichever segment you hit. Thirty-two minutes in, "back a bit" is
     the gesture people make, and there was no way to make it: `foraySeek` was
     implemented and tested in player/client.js and nothing on the page called
     it. Now the position under the pointer is the position you get, cold or
     playing, using the same `startElapsedSec` path the resume banner uses.

     The exact-segment jump did not go away — it is the running-order rows,
     which are also the keyboard-reachable half of this control. */
  /* ONE COMMIT for the strip: a tap's click and a zoomed gesture's release
     (bindStripZoomScrub, on pointerup) both land here. */
  const commitStripSeek = (at) => (playerHasForay(r) ? guardForayTap(() => player.foraySeek(at)) : startAt(at));
  $("#fy-strip").addEventListener("click", async (e) => {
    /* A gesture bindStripZoomScrub read as a SCROLL (mostly vertical, before
       any scrub began) is not a position in the hour. Without this, the click
       a release delivers seeked to wherever the finger happened to stop. */
    if (e.currentTarget && e.currentTarget._scrollGesture) {
      e.currentTarget._scrollGesture = false;
      return;
    }
    /* A zoomed gesture was committed on its release; the click a MOUSE still
       delivers after it must not seek a second time (a touch sends none). */
    if (e.currentTarget && e.currentTarget._seekCommitted) {
      e.currentTarget._seekCommitted = false;
      return;
    }
    /* Position FIRST, and only then look for a bar. The strip is 32 bars with a
       2px gap between each, which is roughly a fifth of its width — requiring a
       `[data-seg]` hit before reading the coordinate made every one of those
       gaps a dead zone, and "a click anywhere on it is a position in the hour"
       has to be true or the control is lying. */
    const at = stripElapsedAt(e, r);
    if (at != null) return commitStripSeek(at);
    // No coordinate to work from (a synthetic or assistive click). Fall back to
    // the bar that was hit, which is what the strip did before it could scrub.
    const seg = e.target.closest("[data-seg]");
    if (!seg) return;
    const index = Number(seg.dataset.seg);
    return playerHasForay(r) ? guardForayTap(() => player.forayJump(index)) : start(index);
  });

  bindStripZoomScrub(r, player, commitStripSeek);

  /* Re-entering the page mid-Foray must paint the segment that is actually
     audible, and route this page's callback at the live player — otherwise the
     old, detached DOM keeps getting the updates and this one never moves.

     With nothing live, the page opens on the STORED position rather than at
     zero: the clock reads where they left off and the rows behind it are already
     ticked. A resume offer that leaves the page looking untouched is a resume
     offer nobody believes. */
  const live = player.watchForay(onChange);
  paintForay(live && live.forayId === r.id ? live : FORAY_IDLE);
}

/** Is the player already inside THIS Foray? Pressing play on a Foray that is
    already loaded must resume it, not rebuild the queue from segment 1. */
function playerHasForay(r) {
  return Boolean(state.forayPlaying === r.id);
}

/** The speed button's visible label AND its accessible name, both from the
    bridge (#242). `aria-label` on a button REPLACES its text, so a screen reader
    is told only what this sets — which is why the value has to be in it. Written
    in one place rather than at each of the three call sites so a relabel cannot
    update one and forget the other. */
function paintRateButton(player, rate) {
  const btn = $("#fy-rate");
  /* BOTH label functions, for the same module-skew reason the binder checks both
     of its own. The bind-time call is NOT inside `guardForayTap`, so a module
     vintage carrying `rateLabel` but not `rateAriaLabel` would throw during
     `renderForay` — a blank page, from a missing accessible name. */
  if (!btn || typeof player?.rateLabel !== "function" || typeof player?.rateAriaLabel !== "function") return;
  const label = player.rateLabel(rate);
  const aria = player.rateAriaLabel(rate);
  /* The memo checks BOTH, and the second half is not symmetry — it is a bug this
     had. `paintForay` runs at 4 Hz for a value that changes once an hour, so the
     early return is worth having; but the markup ships `1×` as the button's text,
     so on the ordinary first bind at normal speed the label already MATCHED and the
     `aria-label` was never written. The button then kept the markup's bare
     "Playback speed", and a screen-reader user was told what the control does and
     never what it is set to — for every listener who had not changed the speed,
     which is most of them. */
  if (btn.textContent === label && btn.getAttribute("aria-label") === aria) return;
  setControlLabel(btn, label, aria);
}

/** The speed picker (#349): a modal listing every stop on the ladder, tap one
    to set it, tap outside or Cancel to leave the current speed alone. Same
    fy-sheet/fy-scrim/fy-panel skeleton as the intro popup and the down-vote
    sheet — one modal pattern for the whole app, not a third one-off.

    Built and torn down on open/close rather than kept in the markup, same
    choice showIntroPopupOnce made: this menu is opened rarely (compared to
    the 4 Hz paintForay tick) and its content (which stop is "current") is
    stale the instant it is left mounted across a rate change made elsewhere,
    so there is nothing to gain from keeping it around between opens. */
function openRateMenu(player, onChange) {
  if (typeof player.rateStops !== "function") return;
  const stops = player.rateStops();
  const current = typeof player.playbackRate === "function" ? player.playbackRate() : null;

  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "rate-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = ddEl("h3", null, "Playback speed");
  title.id = "rate-sheet-title";
  panel.setAttribute("aria-labelledby", "rate-sheet-title");

  const list = ddEl("div", "rate-options");
  for (const stop of stops) {
    const isCurrent = stop === current;
    const opt = ddEl("button", "rate-option" + (isCurrent ? " on" : ""),
      typeof player.rateLabel === "function" ? player.rateLabel(stop) : `${stop}×`);
    opt.type = "button";
    if (isCurrent) opt.setAttribute("aria-current", "true");
    opt.addEventListener("click", () => {
      const applied = player.setPlaybackRate(stop);
      onChange(applied);
      close();
    });
    list.append(opt);
  }

  const actions = ddEl("div", "fy-sheet-actions");
  const cancel = ddEl("button", "fy-sheet-cancel", "Cancel");
  cancel.type = "button";
  actions.append(cancel);

  panel.append(grab, title, list, actions);
  wrap.append(scrim, panel);

  /* ONE INSTANCE (audit 2026-09-22): this menu is built fresh on every open
     with a fixed id, and nothing stopped a second activation (a repeated
     Enter, key-repeat) mounting a second `#rate-sheet` over the first — two
     modals, duplicate ids, and one Cancel taking the scroll lock off with a
     sheet still up. openSheet() replaces an open sheet with the same id
     rather than stacking on it, the way the mini player's own picker always
     did (`closeRatePicker()` first). */
  const close = () => closeSheet(wrap, { removeIfOwned: true });
  openSheet(wrap, { panel, onRequestClose: close });
  scrim.addEventListener("click", close);
  cancel.addEventListener("click", close);
}

/** The only thing that changes 4x a second. Deliberately not a re-render: the
    running order is 32 rows and rebuilding it would fight the scroll position
    and drop focus. */
/** Which Foray the page last painted LIVE (app-3-1), so a cold tick can tell
    "just stopped" from "never started". Reset by every renderForay. */
let forayPaintedLive = null;

/** Re-read this Foray's stored resume point into `state.forayResume` and repaint
    the banner's words from it (app-3-1). A finished Foray has no resume point. */
function refreshForayResume() {
  const r = state.foray;
  const player = window.ForayPlayer;
  if (!r || !player || typeof player.forayResume !== "function") return;
  let point = null;
  try {
    point = player.forayResume(r.id, { totalSec: r.totalSec, itemCount: (r.playable || []).length, resolved: r, includeFinished: true });
  } catch (_) { point = null; }
  state.forayResume = point && !point.finished ? point : null;
  const at = $("#fy-resume .fy-resume-at");
  const left = $("#fy-resume .fy-resume-left");
  if (state.forayResume && typeof player.fmtClock === "function") {
    setStatusText(at, `Jump back in at ${player.fmtClock(state.forayResume.elapsedSec)}`);
    if (state.forayResume.label) setStatusText(left, state.forayResume.label);
  }
}

function paintForay(s) {
  if (!state.foray) return;
  /* SOMEBODY ELSE'S FORAY IS NOT THIS PAGE'S NEWS. `watchForay` points the live
     player's callback at whichever page rendered last, so with Foray A playing in
     the mini bar, opening Foray B's page (the home rail does exactly this) fed
     A's ticks into B's paint: B's button read "Pause" and pressing it paused A.
     The first paint has always been gated this way — `renderForay` compares
     `live.forayId === r.id` — and the ticks after it were not. `FORAY_IDLE`
     carries no id and must still get through: it is this page saying "nothing". */
  if (s.forayId && s.forayId !== state.foray.id) return;
  /* A START THAT FAILED IS NOT A LIVE FORAY (#225).

     `playForay` paints its intent before it awaits the load — deliberately, so a
     tapped row lights up immediately — which means an index arrives on this page
     a moment BEFORE the audio is known to exist. When the load or the play is
     then refused, that index was the only thing standing, and everything below
     read it as "playing": the resume banner hid itself, the button relabelled,
     and `state.forayPlaying` made the next press of the main button mean PAUSE
     rather than a retry. Two controls that had meant the same thing now meant
     different things, with nothing on screen to say why — which is the whole of
     the founder's report.

     An error with nothing playing, nothing loading and no beat running is a
     failed start, and the page goes back to being cold with a line that says so. */
  const failed = Boolean(s.error) && !s.playing && !s.loading && !s.gap;
  const live = s.index >= 0 && !failed;
  state.forayPlaying = live ? state.foray.id : null;
  /* LIVE -> COLD RE-READS THE STORED POINT (audit round 3, app-3-1). The resume
     point was read once, at render; after the listener played on and closed
     the bar, the cold page (clock, banner, and the Play the next press runs)
     fell back to that stale point, or to 0. */
  if (live) forayPaintedLive = state.foray.id;
  else if (forayPaintedLive === state.foray.id) {
    forayPaintedLive = null;
    refreshForayResume();
  }

  /* Nothing loaded — cold, or the mini bar was just closed. Fall back to the
     stored resume point rather than repainting the page as untouched: the
     banner above still says "Jump back in at 23:14" and the button still
     resumes there, so a clock reading 0:00 underneath it would be the page
     contradicting itself. */
  const resume = live ? null : state.forayResume;
  /* THE COLD CLOCK IS THE STORED POINT, AND ONLY THAT — the same expression the
     main button starts from, so the two cannot disagree.

     It used to read `s.elapsedSec` first, which is right while something is live
     and wrong the moment a start fails: `forayPosition()` answers with the failed
     segment's own start, so a refused jump to segment 20 left the clock reading
     37:31 over a button that goes to 19:40. A phantom position is worse than a
     stale one, because the listener can act on it. */
  const elapsed = live ? (s.elapsedSec || 0) : (resume?.elapsedSec || 0);

  const now = $("#fy-now");
  if (now && window.ForayPlayer) now.textContent = window.ForayPlayer.fmtClock(elapsed);

  /* Everything before this index is behind the listener. While something is
     playing that is the live segment; before anything has started it is the
     stored resume point, so a page opened cold shows the hour already half
     ticked off instead of pretending it was never touched. */
  const mark = live ? s.index : (resume?.index ?? -1);
  paintSegFill(mark >= 0, elapsed);

  // The offer only means anything while stopped; once it is playing, the
  // transport IS the progress and a second "jump back in" is noise. A start that
  // failed is stopped, so the offer — and the "Start over" inside it — comes back.
  const banner = $("#fy-resume");
  if (banner) banner.hidden = live;

  const playBtn = $("#fy-play");
  if (playBtn) {
    // Three different "not playing" states, and they mean different things:
    // paused mid-segment, never started but with a stored position, and cold.
    //
    // A seam beat is a FOURTH, and it reads as playing: the Foray is running,
    // it is between two segments on purpose, and the button has to mean "stop"
    // for the half second the silence lasts. Labelling that half second
    // "Loading…" would be the app apologising for its own edit.
    //
    // `s.running` FIRST (audit 2026-09-22): it is the player's
    // `transportIsRunning()`, the same answer `forayToggle` decides the press
    // by. `playing || gap` is the belief alone, and in the #689 drift it said
    // "▶ Resume" over sound while the press paused. The fallback is for a
    // player module of an older vintage, which sends no `running`.
    //
    // A FINISHED Foray is a fifth state, not a paused one: there is nothing to
    // resume, the lock screen has already dropped its transport, and the press
    // starts it from the top (`setRunning`'s ended branch in player/client.js).
    const running = typeof s.running === "boolean" ? s.running : (s.playing || s.gap);
    const started = live || elapsed > 0;
    //
    // FIVE states, and the accessible name has all of them: it used to have
    // two, so the button read "Loading…" and announced "Play" — hiding the one
    // moment the app is asking the listener to wait — and a voice-control user
    // saying "Resume" matched nothing. The name is the text without its glyph.
    const [text, name] = running ? ["❚❚ Pause", "Pause"]
      : s.loading ? ["Loading…", "Loading, please wait"]
      : s.ended ? ["▶ Start over", "Start over"]
      : started ? ["▶ Resume", "Resume"]
      : ["▶ Play", "Play"];
    setControlLabel(playBtn, text, name);
  }
  // The beat, for CSS: the strip holds still at a boundary for 0.5 s and this
  // is how a stylesheet can say so without the page inventing new copy.
  $("#fy-strip")?.classList.toggle("is-seam", Boolean(s.gap));
  /* Whether anybody is IN this Foray, for CSS. Without it the strip has no way
     to tell "nobody has started" from "every segment is still ahead of you",
     and the browsing state — the shape of the Foray, every bar at full
     opacity — would render as a strip dimmed to 0.28 from end to end. `mark` is the same
     index the row highlights use, so the strip and the running order agree
     about whether the listener is anywhere. */
  $("#fy-strip")?.classList.toggle("has-position", mark >= 0);

  /* The speed, relabelled from the snapshot (#242), so a change made in the
     mini-player's Now Playing sheet reaches this button too — there is one speed
     and two controls, and a stale label on either is the app disagreeing with
     itself about a value the listener just set.

     GUARDED, and the guard is the whole of it. app.js and the ES module are cached
     and refreshed independently by the service worker (see the note in
     `renderForay`), so this page is regularly paired with a module of a different
     vintage; an older one sends no `rate`, and `FORAY_IDLE` carries none either for
     the same reason it carries no id. Painting anyway would put "1×" on the button
     — `rateLabel` normalises `undefined` to normal speed — and silently contradict
     a listener who is at 1.5x. Skipping leaves the label it was bound with, which
     is still right, because the value lives in `cp_rate` rather than in the tick.

     A first draft also fell back to `window.ForayPlayer?.playbackRate?.()` here.
     That was dead code and a mutation test proved it: an older module has no
     `playbackRate` either, so the fallback is `undefined` in the one case it was
     written for, and removing it changed no test. */
  if (s.rate != null) paintRateButton(window.ForayPlayer, s.rate);

  // The player's own words are telemetry, not copy. Say the one thing a
  // listener can act on, and keep the detail in the console.
  /* V-01's live-narration notice shares the line: shown only when there is no
     real error claiming it — a load failure is the more urgent message, and
     this one is informational ("still working, just not with the exact voice
     you picked"). Checked here, ahead of the `forayPainted` gate below, because
     it has to show up (and clear) on the FIRST tick.

     ONE WRITE PER TICK, AND ONLY A CHANGE IS A WRITE (audit 2026-09-22, qa row
     66). `#fy-error` is an aria-live region and this runs at 4 Hz. It used to
     be two writes a tick — `paintForayFailure(null)` cleared the line, then
     the hint block wrote it back — so a screen reader re-announced the hint
     four times a second for as long as the Foray played, while a comment here
     claimed it was "painted only once per fallback". Now the line's one
     message is decided first and `paintForayNotice` skips an unchanged one. */
  if (s.error) paintForayFailure(s.error);
  else if (s.voiceFallback) paintForayNotice(FY_VOICE_FALLBACK, true);
  else paintForayFailure(null);

  /* The row and strip classes only change when the segment does, and this runs
     on every position tick. Guard it: 32 rows x 4 Hz of class churn for a value
     that changes once a minute is work nobody asked for.

     Keyed on the LIVE index, not the raw one: a start that failed at segment 12
     has to clear the highlight it painted a moment ago, and keying on `s.index`
     — which does not change when the load fails — would skip that repaint and
     leave a row lit under a message saying nothing is playing. */
  const liveIndex = live ? s.index : -1;
  if (state.forayPainted === liveIndex) return;
  state.forayPainted = liveIndex;

  $("#view").querySelectorAll("[data-fy]").forEach(row => {
    const i = Number(row.dataset.fy);
    const playing = i === liveIndex;
    const played = mark >= 0 && i < mark;
    row.classList.toggle("is-playing", playing);
    row.classList.toggle("is-played", played);
    if (playing) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
    if (row.dataset.fyName) {
      setControlLabel(row, null, forayJumpLabel(row.dataset.fyName, playing ? "playing" : played ? "played" : ""));
    }
  });
  const strip = $("#fy-strip");
  if (strip) {
    [...strip.children].forEach((seg, i) => {
      seg.classList.toggle("is-playing", i === liveIndex);
      /* WHERE THE LISTENER IS, which is not the same claim as "audio is
         running" and comes apart on a cold load: `mark` is then the STORED
         position and `liveIndex` is -1. The strip dims everything that is
         neither played nor here, and the fill inside a bar is only shown on the
         bar the listener is in, so without this the resume point rendered as a
         dim empty bar under a banner offering to jump back into it. */
      seg.classList.toggle("is-here", i === mark);
      seg.classList.toggle("is-played", mark >= 0 && i < mark);
      // A bar the listener has passed is full; one they have not reached is
      // empty. The bar they are INSIDE is left alone — paintSegFill already
      // set it this same tick, and clobbering it here would drop the fill to
      // zero for a quarter of a second at every segment change.
      if (mark >= 0 && i !== mark) {
        const fill = fillOf(strip, i);
        if (fill) fill.style.width = i < mark ? "100%" : "0%";
      }
    });
  }
}

/** The Forays this visitor may see on the Forays page (#/forays). As of 2026-08-30 that is
    ONE — `capital-types-1` is published — plus any draft reached by name. It
    was empty for everyone before that.

    It reads the bridge synchronously rather than awaiting it, so on a cold load
    where the module has not evaluated yet it answers `[]` — which is NOT a claim
    that there are none, and no caller may paint it as one. The two pages that
    list Forays now close the gap themselves (audit 2026-09-22, theme G):
    `renderForays` awaits the bridge before it will say "No forays right now",
    and `restoreNowPlayingRibbon` repaints Home once when the module arrives
    after Home's first paint. Recorded in docs/curation/foray2-capital.md §11c. */
/** One listed Foray, resolved through the same `forayViewOpts()` gate every
    Foray this page opens goes through, or null (no module, no documents, a
    draft the viewer may not see, or data the resolver threw on). The one way a
    LIST surface (Home's cards, the Forays list, Library, Jump back in, the
    welcome strip) reads a Foray's running order, so none of them can resolve
    it by a rule of its own. */
function resolveListedForay(id) {
  const player = window.ForayPlayer;
  if (!id || !state.forays || typeof player?.resolve !== "function") return null;
  try {
    return player.resolve(state.forays, {
      id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources, ...forayViewOpts(),
    }) || null;
  } catch (_) {
    return null;   // malformed segments/sources must not break a list
  }
}

function forayCards() {
  if (!state.forays || !window.ForayPlayer) return [];
  /* Published + `?foray=`-unlocked first, in file order, exactly as before;
     the test-track drafts (switch on) follow — see withTestTrackDrafts. */
  return withTestTrackDrafts(opts => window.ForayPlayer.listForays(state.forays, opts));
}

/* Renamed from forayHomeHtml on 2026-09-03: this list is no longer on Home.
   The `.fy-home*` class names stay as they are — renaming them would touch
   every foray style for no behaviour, and `.fy-home-row` is still an accurate
   description of the row shape. */
/* `inSection`: the list sits under the page's own "Forays" heading, so a
   published row's FORAY tag only restated it (audit round 2, visual-9). A
   draft keeps its tag — "draft" is news the heading does not carry. */
function forayListHtml({ inSection = false } = {}) {
  const list = forayCards();
  if (!list.length) return "";
  return forayRowsHtml(list, { inSection });
}

/** THE ONE FORAY ROW (audit round 2 review): the #/forays list and Search's
    Forays group both render through here, so "a Foray found here looks like a
    Foray found there" is the code and not a comment — the search group used to
    hand-copy the old row and kept the FORAY tag under its own "Forays" heading
    (visual-9) with no length or progress line (p-foray-8).
    HOW LONG, AND HOW FAR (audit round 2, p-foray-8 / honesty-2): a row was a
    tag and a title, so nothing before a Foray's own page said how long it
    was, and a finished Foray looked never opened. The kicker already says
    "draft", so the sub line leaves it out. */
function forayRowsHtml(list, { inSection = false } = {}) {
  const progress = forayProgressLabels();
  return `<div class="fy-home">${list.map(f => {
    const sub = forayListSubLabel(f, progress, { draftTag: false });
    return `
    <a class="fy-home-row" href="#${esc(forayRoutePath(f.id))}">
      ${inSection && f.status === "published" ? "" : `<span class="fy-home-kicker">foray${f.status === "published" ? "" : " · draft"}</span>`}
      <span class="fy-home-title">${esc(f.title)}</span>
      ${sub ? `<span class="fy-home-sub">${esc(sub)}</span>` : ""}
    </a>`;
  }).join("")}</div>`;
}

/** Every listed Foray's progress label by id: "Played" for a finished one,
    "N min left" for a part-played one. NO cap, because this is data, not the
    rail (honesty-12). */
function forayProgressLabels() {
  return new Map(forayResumeRows({ limit: Infinity, includeFinished: true }).map(p => [p.id, p.label]));
}

/** A list row's second line: draft tag, progress, then length and makeup,
    JOINED, never one in place of another (honesty-12: a part-played draft's
    "20 min left" used to replace its "draft"). */
function forayListSubLabel(f, progress, { draftTag = true } = {}) {
  return joinMeta(
    draftTag && f.status !== "published" ? "draft" : "",
    progress.get(f.id) || "",
    forayFactsLabel(resolveListedForay(f.id), window.ForayPlayer),
  );
}

/* "Jump back in" — the mockup's own heading for a part-played Foray, and the
   home screen's half of resuming.

   Gated through the SAME visibility rule as the list above, deliberately. A
   stored position is not permission: `player/foray-resolve.js` decided that an
   unpublished Foray is reachable only by asking for it by id, and the unlock is
   pointedly not persisted so that opening a draft link on a shared machine does
   not leave it on someone else's home screen. A resume row that ignored that
   would reintroduce exactly the leak that rule closed — so with no `?foray=` in
   the URL, a draft's progress is remembered and simply not advertised. */
/** Ask the player to repaint the mini bar from the stored pointer, once the
    bridge exists. Re-renders home afterwards so "Jump back in" picks up the
    restored episode on the same paint rather than on the next navigation. */
function restoreNowPlayingRibbon() {
  /* `late` is the module arriving AFTER Home's first paint — and then Home is
     repainted whether or not a ribbon came back (audit 2026-09-22). That first
     paint read `forayCards()` with no module to read it through, so its Forays
     rail was missing for a listener who had never played anything, and until
     now only a restored episode ever triggered the repaint that fixed it. */
  const go = (late) => {
    try {
      /* WHATEVER WAS PLAYED LAST (persona audit 2026-09-22, the car tier): a
         part-played Foray that is newer than the last episode takes the bar;
         otherwise the episode pointer does, as before. */
      const restored = restoreLastForayRibbon(window.ForayPlayer)
        || window.ForayPlayer?.restoreLastEpisode?.();
      /* Seed the restored episode on EVERY route, not only via Home's render:
         the bar's "Open episode" link points at #/episode/<id>, and on a cold
         start anywhere else nothing else would ever put it in the index. */
      if (restored) playerPointerEpisode(null);
      if ((restored || late) && isHomeRoute()) renderCurrentPage();
    } catch (_) { /* a ribbon that cannot be restored is not a reason to fail boot */ }
  };
  /* THE LANE FIRST (NE-22). Inside the iOS shell the player cannot restore
     anything until engineHello has said whether the native engine or the page
     plays; until then both restores would answer a promise, and a promise is
     truthy, so the episode fallback below would never run. Everywhere else
     `engineModePending` answers false at once and this stays synchronous. */
  const whenLaneKnown = (late) => {
    const p = window.ForayPlayer;
    let pending = false;
    try { pending = typeof p?.engineModePending === "function" && p.engineModePending() === true; } catch (_) { pending = false; }
    if (!pending) return go(late);
    Promise.resolve(p.whenEngineReady()).then(() => go(late), () => go(late));
  };
  if (window.ForayPlayer) whenLaneKnown(false);
  else window.addEventListener("forayplayer:ready", () => whenLaneKnown(true), { once: true });
}

/** The part-played Foray for the bar, when it is the most recent thing played —
    or null, and the caller falls back to the episode pointer.

    Resolved HERE because only the page holds the three Foray documents, and
    through `forayViewOpts()` like every other Foray this page opens: a draft
    the listener may not see resolves to null and is never advertised on the
    bar. The resume point is read with the resolved running order in hand, so a
    Foray whose segments moved resumes to the same audio (#40). Every step is
    capability-checked: an older player module simply has no Foray ribbon. */
function restoreLastForayRibbon(player) {
  if (!player || typeof player.lastPlayedForay !== "function" || typeof player.restoreForay !== "function") return null;
  if (!state.forays) return null;
  const id = player.lastPlayedForay();
  if (!id) return null;
  const r = player.resolve(state.forays, {
    id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources, ...forayViewOpts(),
  });
  if (!r) return null;
  const at = player.forayResume(id, { resolved: r });
  if (!at) return null;
  return player.restoreForay(r, { startElapsedSec: at.elapsedSec, discoverDoc: state.discover || null });
}

/** True when the current route is the home screen — the only page whose content
    changes as a result of the restore. */
function isHomeRoute() {
  return currentHash() === "#/";
}

/* `limit` and `includeFinished` belong to the CALLER (audit round 2,
   honesty-12 / honesty-2). The 3-row cap is the Home rail's layout; Library
   reused this helper as its data source and inherited the cap, so a fourth
   part-played Foray there showed an empty subtitle. A finished Foray is left
   off Jump back in (founder question 3: finished things leave the rail,
   episodes and Forays alike), but its own rows say "Played". */
function forayResumeRows({ limit = 3, includeFinished = false } = {}) {
  if (typeof window.ForayPlayer?.forayResumeList !== "function") return [];
  const visible = new Set(forayCards().map(f => f.id));
  /* `foraysDoc` is FD-05: a row whose Foray is no longer in the directory reads
     `drift: "dropped"` and is not offered — the visibility set below already
     excludes it (it is not listed), and the drift is what a test can name. */
  /* `resolveFor` (audit 2026-09-22, qa row 163): the row's percent and "min
     left" are read against the Foray as it resolves NOW, through the same
     `forayViewOpts()` gate every other Foray this page opens goes through —
     not against the runtime stored when the row was written. */
  const player = window.ForayPlayer;
  const resolveFor = typeof player.resolve === "function" && state.forays ? resolveListedForay : null;
  return player.forayResumeList({ foraysDoc: state.forays, resolveFor })
    .filter(p => visible.has(p.id) && p.drift !== "dropped" && (includeFinished || !p.finished) && p.label)
    .slice(0, limit);
}

function jumpBackInHtml(rows) {
  if (!rows.length) return "";
  return `<div class="fy-home fy-jbi">${rows.map(p => `
    <a class="fy-home-row fy-jbi-row" href="#${esc(forayRoutePath(p.id))}">
      <span class="fy-home-kicker">Jump back in</span>
      <span class="fy-home-title">${esc(p.title || p.id)}</span>
      <span class="fy-bar"><span class="fy-bar-fill" data-pct="${esc(String(p.percent))}"></span></span>
      <span class="fy-jbi-left">${esc(p.label)}</span>
    </a>`).join("")}</div>`;
}

/** Bar widths are a DOM property, never a style attribute — the page CSP is
    `style-src 'self'` and test/app-security.test.js gates it. */
function sizeProgressBars(scope) {
  scope.querySelectorAll(".fy-bar-fill[data-pct]").forEach(fill => {
    const pct = Math.max(0, Math.min(100, Number(fill.dataset.pct) || 0));
    fill.style.width = `${pct}%`;
  });
}

/* ---------- drawer ---------- */

function renderDrawer() {
  ensureInterestsDrawerLink();
  /* `|| ""` on both sides, same guard playlistsForYouHtml already carries: a
     playlist() backfills `created` on read, but this must not depend on that —
     a record that somehow still carries neither field must not throw
     `localeCompare` out of undefined and blank the drawer on every navigation
     (#558 item 1). */
  const recent = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created || "").localeCompare(a.last_played_at || a.created || ""))
    .slice(0, 5);
  $("#drawer-playlists").innerHTML = recent.map(p =>
    `<a class="drawer-item" href="#/${esc(playlistRoute(p))}">${esc(p.title)}</a>`).join("")
    || `<p class="drawer-empty">No playlists yet</p>`;
  /* Every switch's label, from the one registry `drawerToggle` fills. This was
     five ad-hoc lines — three unguarded, two guarded, each spelling its own
     on/off — and the sixth switch is what made that a shape rather than a
     list (finding 6, client audit 2026-09-12). */
  paintDrawerToggles();
  /* K-01: whether the RUN button exists at all. The toggle's own label is
     painted above with the others; this is the control that appears and
     disappears with it, which no label line can express. */
  syncVoiceProbeRun();
  /* NE-22d: the engine's Developer rows, which exist only where an engine
     answered (see § the engine's Developer rows). */
  syncEngineDevRows();
}

/* ---------- THE DRAWER IS A MODAL, WITH THE SAME CONTRACT AS A SHEET ----------

   Audit round 2, nav-5 (with touch-7 and a11y-4 folded in). The drawer is
   painted over everything (z 80/81) and behaved like a modal in no other
   sense: a drag on its scrim, or on the panel itself when its content fit the
   screen, scrolled the page behind it — close the drawer and you had lost
   your place; Escape did nothing; opening moved no focus and closing returned
   none; Tab walked out of it into the page; the ☰ said nothing about what it
   controls. Every sheet had all of that from the owner (`openSheet`) and the
   drawer, not being a sheet, had none.

   The same contract, from the same helpers: `body.drawer-open` locks the page
   scroll the way `body.fp-expanded` does (styles.css also gives the panel
   `overscroll-behavior: contain` and the scrim `touch-action: none`); the page,
   the tab bar and the player go `inert` through `inertOutside` — the topbar
   stays reachable (the ☰ must work at every moment, F17), so does the scrim
   (its tap closes the drawer) and so does the page's live region; focus moves
   to the first link on open. ON CLOSE, focus goes back to the ☰ only for a
   DISMISSAL (Escape, the scrim, hardware back): a link that navigates hands
   focus to the new page's heading through `landOnPage`, and a button that
   opens a sheet hands it to the ☰ through `openSheet`'s own drawer rule —
   returning it here first would make both of those think focus had survived.
   Not on the sheet stack, deliberately: the drawer is navigation chrome that
   sits OVER sheets (F17), never under them, and the one thing the stack would
   add — Escape — is `onDrawerKeydown`, which takes precedence while it is open
   (`onSheetKeydown` yields). */
const DRAWER_KEEPS_REACHABLE = [".topbar", "#drawer-overlay", "#a11y-status"];
let drawerInerted = [];

function drawerIsOpen() {
  const drawer = $("#drawer");
  return !!(drawer && !drawer.hidden);
}

function openDrawer(open, { toMenu = false } = {}) {
  const drawer = $("#drawer");
  const overlay = $("#drawer-overlay");
  const menu = $("#menu-btn");
  const was = !!(drawer && !drawer.hidden);
  drawer.hidden = !open;
  overlay.hidden = !open;
  if (menu && typeof menu.setAttribute === "function") {
    menu.setAttribute("aria-expanded", open ? "true" : "false");
    if (typeof menu.getAttribute !== "function" || !menu.getAttribute("aria-controls")) menu.setAttribute("aria-controls", "drawer");
  }
  document.body.classList.toggle("drawer-open", !!open);
  if (open) {
    renderDrawer();
    if (was) return;                       // a re-render of an open drawer: nothing to take again
    drawerInerted = inertOutside(drawer, DRAWER_KEEPS_REACHABLE);
    const first = sheetFocusables(drawer)[0];
    if (!first && typeof drawer.setAttribute === "function"
        && (typeof drawer.getAttribute !== "function" || drawer.getAttribute("tabindex") == null)) {
      drawer.setAttribute("tabindex", "-1");
    }
    focusQuietly(first || drawer);
    return;
  }
  for (const el of drawerInerted) if (typeof el.removeAttribute === "function") el.removeAttribute("inert");
  drawerInerted = [];
  if (was && toMenu) focusQuietly(menu);
}

/** The drawer's half of the keyboard contract, reached through the one overlay
    listener (`onSheetKeydown`) while the drawer is open: Escape closes it and
    puts focus back on the ☰; Tab cycles the topbar and the drawer — the same
    belt-and-braces behind `inert` the sheets keep, for a WebView without it,
    and the reason a Tab from the ☰ walks into the open drawer rather than
    back into a covered sheet. */
function onDrawerKeydown(e) {
  if (!drawerIsOpen()) return;
  if (e.key === "Escape" || e.key === "Esc") {
    if (typeof e.preventDefault === "function") e.preventDefault();
    openDrawer(false, { toMenu: true });
    return;
  }
  if (e.key !== "Tab") return;
  const cycle = [];
  for (const root of [$(".topbar"), $("#drawer")]) {
    if (!root || root.hidden) continue;
    for (const el of sheetFocusables(root)) if (!cycle.includes(el)) cycle.push(el);
  }
  if (!cycle.length) return;
  if (typeof e.preventDefault === "function") e.preventDefault();
  const at = cycle.indexOf(document.activeElement);
  const next = at < 0
    ? (e.shiftKey ? cycle[cycle.length - 1] : cycle[0])
    : cycle[(at + (e.shiftKey ? cycle.length - 1 : 1)) % cycle.length];
  focusQuietly(next);
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

   Android's back was the raw WebView back: with the drawer or the Now
   Playing sheet open it closed the overlay AND stepped the page underneath
   (the drawer and the sheets push no history entry, so the step was a real
   one), and on a first page it left the app with the sheet still up. Every
   Android app treats back as "dismiss the top-most thing"; this is that
   ordering, in one place, beside the ownership model the drawer and the
   sheets already follow: the drawer (it sits over everything), then the top
   sheet through its own close (Escape's path — a sheet may decline), then one
   step of the app's own history, else leave the app. iOS has no back button
   and registers the same listener harmlessly. `docs/DECISIONS.md` 2026-09-23
   records the order. */
function handleBack() {
  if (drawerIsOpen()) { openDrawer(false, { toMenu: true }); return "drawer"; }
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

/** Register with the Capacitor App plugin when the shell provides it. Returns
    whether a listener was installed — false on the web, where the browser's
    own back is the right one. */
function bindHardwareBack(win = window) {
  let app = null;
  try { app = win && win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.App; } catch (_) { app = null; }
  if (!app || typeof app.addListener !== "function") return false;
  try {
    app.addListener("backButton", () => {
      if (handleBack() === "exit" && typeof app.exitApp === "function") app.exitApp();
    });
  } catch (_) { return false; }
  return true;
}

if (typeof window !== "undefined") {
  window.ForayNav = { handleBack, landOnPage, announce };
}

/* ---------- THE DRAWER LEAVES WHEN IT IS USED (founder, 2026-09-23) ----------

   "When I select Playback Diagnostics from the menu, the menu should
   automatically collapse but it does not." And the consequence, reported
   with it: "When I click outside the menu on the playback diagnostics, the
   menu does not collapse when it should. If I click above the playback
   diagnostics, where I can see a corner of the Home Screen, it will collapse
   both the menu and the playback diagnostics."

   WHAT WAS WRONG. The drawer closed for exactly one kind of item — a link,
   because `route()` closes it on navigation and the old click handler
   mirrored that for `<a>` — and for nothing else. Every button in it (Playback
   diagnostics, Narration voice, Delete my data, the probe's RUN) opened its
   sheet UNDER a drawer that stayed put: the sheet's `openSheet` then inerted
   the drawer and its overlay (both are outside the sheet), so the panel that
   paints on top of everything (z 81, over the sheet's 70) took no taps at
   all, and which of the two overlapping scrims a tap fell through to — the
   drawer's (inert) or the sheet's — is exactly the ambiguity the founder
   describes: nothing from most of the screen, both from one corner. Fixing
   the one item would leave the next button with the same bug.

   THE RULE, in one place: any control chosen from the drawer that has a
   DESTINATION — a page, a sheet — closes the drawer FIRST, in the capture
   phase, before the control's own handler runs. So a sheet never opens under
   the drawer, never inerts it, and its opener is already gone by the time
   `openSheet` records what to hand focus back to (that case is handled there:
   focus returns to the ☰). What STAYS open is declared on the control, not
   listed here: a settings switch flips in place (Joey, 2026-08-31 — the
   drawer must not close on a toggle; `drawerToggle` marks its buttons
   `data-drawer-stay`), and the Developer disclosure's <summary> only
   expands. A tap on the overlay closes the drawer and nothing else, whatever
   is under it — the Now Playing sheet keeps the drawer reachable (F17), so
   that is a real state; a tap on a sheet's scrim closes that sheet only.
   test/drawer-ownership.test.js pins each of these. */
const DRAWER_STAYS_OPEN_FOR = "[data-drawer-stay], summary";

function onDrawerAction(e) {
  const t = e && e.target;
  const item = t && typeof t.closest === "function" ? t.closest("a, button, summary") : null;
  if (!item) return;
  if (typeof item.closest === "function" && item.closest(DRAWER_STAYS_OPEN_FOR)) return;
  openDrawer(false);
  sameHashTap(item, e);
}

/** The ☰, the overlay, the wordmark, Escape and the drawer's own leave rule.
    Bound once from init(). */
function bindDrawerChrome() {
  $("#menu-btn").addEventListener("click", () => openDrawer($("#drawer").hidden));
  $("#drawer-overlay").addEventListener("click", () => openDrawer(false, { toMenu: true }));
  /* CAPTURE, deliberately: the drawer closes before the item acts, not after —
     see the block comment above. */
  $("#drawer").addEventListener("click", onDrawerAction, true);
  bindOverlayKeys();
  const mark = $(".wordmark");
  if (mark) mark.addEventListener("click", (e) => sameHashTap(mark, e));
}

/* ---------- U-02: the four-tab bar (docs/ui-transition-plan.md) ----------

   Built and appended in JS, exactly like the diagnostics/delete-my-data
   controls just above and for the identical reason stated on those: this
   card's owned files are app.js and styles.css (index.html is outside the
   auto-merge allowlist), so the bar cannot be a static element in
   index.html.

   APPENDED/REMOVED, NOT `hidden`-toggled. test/home-layout.test.js's own
   BUG 3 documents why: `[hidden] { display: none }` is a UA-stylesheet
   rule, and ANY author `display` declaration (which `.tab-bar { display:
   flex }` in styles.css necessarily is) beats it at any specificity. A
   `hidden` attribute on this element would therefore render anyway the
   moment its own display rule existed — exactly the bug that suite exists
   to catch. Appending only when the flag is on, and removing it the moment
   the flag goes off, sidesteps that cascade question entirely instead of
   relying on getting it right. */
const TAB_ROUTES = [
  { key: "home", label: "Home", hash: "#/",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>' },
  { key: "search", label: "Search", hash: "#/shows",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' },
  { key: "create", label: "Create", hash: "#/create",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>' },
  { key: "library", label: "Library", hash: "#/library",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M15 3v5h5"/></svg>' },
];

/** Which tab a hash belongs to, for highlighting `aria-current`. EVERY ROUTE
    LIGHTS A TAB (audit 2026-09-22): Home; everything shows/episode/category-
    shaped to Search, including a browse pill's `#/shows/q/<label>` (the old
    `shows$` missed it, so tapping a pill ON the Search page un-lit Search);
    playlist/subject-queue-shaped to Create; and everything the listener keeps —
    Library's own sections (Up Next, Forays, Followed shows) and their Interests
    — to Library. Anything else is rendered as Home by the router, so it is
    Home here too: the two fallbacks used to disagree by construction, and an
    unrecognised hash showed the Home screen under a bar that said nowhere. */
function tabForHash(hash) {
  const h = currentHash(hash);
  if (/^#\/(shows($|\/)|show\/|category\/)/.test(h)) return "search";
  if (/^#\/(playlists$|playlist\/|subject\/|create$)/.test(h)) return "create";
  if (/^#\/(library$|queue$|forays$|foray\/|starred-shows$|interests$)/.test(h)) return "library";
  if (/^#\/episode\//.test(h)) return "search"; // reached from a show/search result
  return "home";
}

function onTabBarClick(e) {
  const a = e.target && typeof e.target.closest === "function" ? e.target.closest(".tab-btn") : null;
  if (!a) return;
  const href = currentHash(a.getAttribute("href"));
  const here = currentHash();
  if (href === here) { e.preventDefault(); scrollPageTo(0); return; }
  /* THE LIT SEARCH TAB GOES BACK TO THE SEARCH, NOT TO AN EMPTY PAGE (audit
     round 2, search-5). The tab's href is the bare root; from a result the
     listener opened (`#/show/<id>`, an episode) or from the results themselves
     (`#/shows/q/<q>`) that differs, so the browser navigated to `#/shows` and
     the query, the rows and the scroll went with it — round 1 taught ‹ to
     keep the query and not the tab. On the results page the tap is the
     same-tab gesture: to the top. From a pushed page it pops to the search
     that was left, which is what Apple's active tab does; a tab that was
     left at its root still pops to the root, by the ordinary navigation. */
  if (href === "#/shows" && tabForHash(here) === "search") {
    if (/^#\/shows\/q\//.test(here)) { e.preventDefault(); scrollPageTo(0); return; }
    if (lastSearchTabHash !== "#/shows") { e.preventDefault(); location.hash = lastSearchTabHash; }
  }
}

/** Renders (or removes) the tab bar to match the flag, and syncs which tab
    reads as current. Called from renderCurrentPage() so every navigation —
    real or a settings-toggle refresh — keeps it in sync, same as the
    drawer's own settings text. */
function renderTabBar() {
  let bar = $("#tab-bar");
  if (!bar) {
    bar = document.createElement("nav");
    bar.className = "tab-bar";
    bar.id = "tab-bar";
    for (const t of TAB_ROUTES) {
      const a = document.createElement("a");
      a.className = "tab-btn";
      a.href = t.hash;
      a.dataset.tabKey = t.key;
      a.innerHTML = `${t.icon}<span>${esc(t.label)}</span>`;
      bar.append(a);
    }
    /* TAPPING THE TAB YOU ARE ON TAKES YOU TO THE TOP (audit 2026-09-22) — the
       standard gesture in every iOS app. Assigning the hash that is already
       current fires no hashchange, so route() never ran and the tap did
       nothing at all. Delegated once, on the bar that lives for the page. */
    bar.addEventListener("click", onTabBarClick);
    document.body.append(bar);
    /* Created under an open sheet (the first-run explainer on a first visit):
       out of reach like everything else behind it. */
    inertUnderOpenSheet(bar);
  }
  const active = tabForHash(location.hash);
  bar.querySelectorAll(".tab-btn").forEach((a) => {
    if (a.dataset.tabKey === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

/* ---------- the drawer's switches, in ONE shape ----------

   Six of them now, and until the 2026-09-12 client audit there were five
   copies of one idea: three bound by hand in `init()` against markup in
   index.html, two injected by near-identical fifteen-line twins
   (`bindDraftsControl`, `bindVoiceProbeControl`), and five ad-hoc label lines
   in `renderDrawer` — three unguarded, two guarded, each spelling its own
   on/off. Disclosure and test coverage were good; the COST was the sixth
   switch, which is exactly what `cp_interlude` needed.

   So: one `drawerToggle(id, label, read, write)`. A switch declares where its
   state lives and what a tap does; the helper owns everything that was being
   copied — adopting the button from index.html or appending one, binding the
   click exactly once, and registering the label so `renderDrawer` paints it
   with the rest.

   APPENDED, NOT `hidden`-TOGGLED, for the reason `renderTabBar`'s comment
   states and `test/home-layout.test.js`'s BUG 3 established: any author
   `display` declaration beats the UA stylesheet's `[hidden]` rule.

   A TAP NEVER CLOSES THE DRAWER (`renderCurrentPage`, never `route()` —
   test/drawer-settings-toggle.test.js's rule), and `repaint` is what says
   whether the page behind it has to be redrawn at all. */
const drawerToggles = [];

/**
 * @param {string}   id      the element id, in index.html or appended here
 * @param {string}   label   the text before the colon, e.g. "Family mode"
 * @param {Function} read    () => boolean — the CURRENT state, read fresh
 * @param {Function} write   (next: boolean) => void — persist it, log it
 * @param {object}   [opts]
 * @param {string[]} [opts.words]    the two state words, `[off, on]`
 * @param {boolean}  [opts.repaint]  redraw the page behind the drawer too
 * @param {Element}  [opts.into]     the container to append to — the drawer,
 *   unless it is a founder switch, which goes in `drawerDevGroup()`
 */
function drawerToggle(id, label, read, write, { words = ["off", "on"], repaint = false, into = null } = {}) {
  const drawer = $("#drawer");
  if (!drawer) return;
  if (!drawerToggles.some(t => t.id === id)) drawerToggles.push({ id, label, read, words });
  let btn = $("#" + id);
  if (!btn) {
    btn = ddEl("button", "drawer-item as-btn", "");
    btn.type = "button";
    btn.id = id;
    (into || drawer).appendChild(btn);
  }
  if (btn._drawerToggleBound) return; // init() runs once, but a re-bind must never stack handlers
  btn._drawerToggleBound = true;
  /* A SWITCH IS A SWITCH TO A SCREEN READER (audit round 2, a11y-8). These were
     plain buttons whose only state cue was the word after the colon, so
     VoiceOver read "Family mode: off, button" and, on activation, nothing —
     it does not re-read a focused button's changed text. `role="switch"` with
     `aria-checked` (painted with the label below) is what Settings' own
     toggles expose — "Family mode, switch, off" — and the flip is said. */
  btn.setAttribute("role", "switch");
  /* A switch flips IN the drawer and has nowhere to go, so the drawer stays
     (Joey, 2026-08-31). Declared on the control: `onDrawerAction` closes the
     drawer for everything that does not say this. */
  btn.dataset.drawerStay = "1";
  btn.addEventListener("click", () => {
    write(!read());
    renderDrawer();
    if (repaint) renderCurrentPage();
    /* NO announce() HERE (audit round 2 review). The switch stays focused and
       `paintDrawerToggles` flips its aria-checked in place, which VoiceOver and
       TalkBack already speak ("on"); a live-region line on top made every tap
       say it twice ("on", then "Family mode on"). Family mode's repaint
       redraws #view, not the drawer, so the focused switch survives it. */
  });
}

/** Every registered switch's label, read fresh. Guarded per element because a
    page can mount without one (a harness with a partial drawer) — the three
    unguarded lines this replaced threw on exactly that. The visible text keeps
    its "Family mode: off"; the NAME is the label alone, because the switch's
    own checked state already says on or off and "Family mode: off, switch, on"
    would say both. */
function paintDrawerToggles() {
  for (const t of drawerToggles) {
    const btn = $("#" + t.id);
    if (!btn) continue;
    const on = !!t.read();
    setControlLabel(btn, `${t.label}: ${t.words[on ? 1 : 0]}`, t.label);
    btn.setAttribute("aria-checked", String(on));
  }
}

/** The listener's three, in the drawer's reading order: two from index.html,
    the jingle appended. The founder's two are `bindDeveloperToggles`', which
    `init()` binds later so they land in the Developer group below the
    listener's settings. ("Open in", once a sixth switch, was deleted on
    2026-09-22 — it chose a link-out that no longer existed.) */
function bindDrawerToggles() {
  drawerToggle("family-toggle", "Family mode", familyMode, (on) => {
    lsSet("cp_family", on);
    logEvent("family_mode", { on });
    buildCards();
  }, { repaint: true });

  drawerToggle("autoadvance-toggle", "Continuous playback", autoAdvanceOn, (on) => {
    lsSet("cp_autoadvance", on);
    logEvent("autoadvance_pref", { on });
    /* The switch changes what the END of the playing episode does, so a
       player that was handed the plan ahead (the native engine's
       setContinuation) must hear it now, not at the next play (NE-13). */
    refreshEpisodeNavigation();
  });

  /* §13's jingle (player/interlude.js). THE CONTROL THE PRIVACY POLICY ALREADY
     PROMISED: `docs/legal/privacy-policy.md` lists `cp_interlude` as "On unless
     you turn it off", and until the 2026-09-12 client audit there was no way to
     turn it off — `writeInterludePref` and `PlayerQueueManager.setInterludeEnabled`
     were each called from their own test and nowhere else, and `client.js` read
     the key once at boot. A disclosed setting with no surface is a disclosure
     that is not true. */
  drawerToggle("interlude-toggle", "Jingle between clips", interludeOn, setInterludeOn);
}

/* ---------- the Developer group (2026-09-22 audit, founder ruling R8) ----------

   "Show draft Forays", "Voice engine probe" and "Playback diagnostics" are the
   founder's field-report tools, and they sat among a listener's three real
   settings: the persona audit read them as debug switches shipped to everyone,
   and one of them offers a button that blocks for ~90 seconds. They must stay
   REACHABLE — the founder files reports from a car with them — so they are not
   hidden behind an unlock. They are grouped instead: one collapsed "Developer"
   disclosure at the bottom of Settings, directly above "Delete my data" (which
   stays the drawer's last item, by `bindDeleteControl`'s rule).

   A native <details>, so it opens from a tap, Enter or Space and announces its
   state with no script, and it starts CLOSED on every launch. Built once;
   every caller gets the same element — remembered on the drawer itself, the
   way `ensureInterestsDrawerLink` remembers its link, so a lookup that cannot
   see appended nodes can never build a second group. */
function drawerDevGroup() {
  const drawer = $("#drawer");
  if (!drawer) return null;
  if (drawer._devGroup) return drawer._devGroup;
  const group = ddEl("details", "drawer-dev", null);
  group.id = "drawer-dev";
  group.appendChild(ddEl("summary", "drawer-item", "Developer"));
  drawer.appendChild(group);
  drawer._devGroup = group;
  return group;
}

/** The founder's two switches, into the Developer group. */
function bindDeveloperToggles() {
  const into = drawerDevGroup();
  if (!into) return;
  /* The founder's test track (see § showDraftsOn). No event is logged: this is
     his own switch, not listener behaviour worth a row. */
  drawerToggle("drafts-toggle", "Show draft Forays", showDraftsOn,
    (on) => lsSet("cp_show_drafts", on), { repaint: true, into });

  /* K-01's measurement switch (see § voiceProbeOn). Its RUN button is not a
     switch and is added/removed by `syncVoiceProbeRun` instead. */
  drawerToggle("voice-probe-toggle", "Voice engine probe", voiceProbeOn,
    (on) => lsSet("cp_voice_probe", on), { into });
}

/** The run control, created on demand by `renderDrawer`. Returns nothing; the
    element is found by id like every other drawer control. */
function syncVoiceProbeRun() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const toggle = $("#voice-probe-toggle");
  const existing = $("#voice-probe-run");
  if (!voiceProbeOn()) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const run = ddEl("button", "drawer-item as-btn", "Run the voice engine probe");
  run.type = "button";
  run.id = "voice-probe-run";
  /* Immediately after the toggle, not at the end of the drawer: "Delete my
     data" is the last item by the rule `bindDeleteControl` states, and a
     control that appears BELOW it would be the one a scrolled thumb lands on
     instead. */
  if (toggle && toggle.parentNode) toggle.parentNode.insertBefore(run, toggle.nextSibling);
  else (drawerDevGroup() || drawer).appendChild(run);
  run.disabled = Boolean(voiceProbeRunning);   // a control rebuilt mid-run is still busy (app-3-11)
  run.addEventListener("click", () => runVoiceProbe());
}

/* ---------- the engine's Developer rows (NE-22d) ----------

   The four rows the M1 car test drives (docs/native-engine-m1-car-test.md,
   "Before it can be run" item 2), in the Developer group above "Playback
   diagnostics":

     Playback engine: Automatic / Native / Web (applies after restart)  NE-17
     Pause hold: forever / none                                          NE-16
     Simulate system termination                                         NE-24
     Session probe                                                       NE-25c

   THE PLAYER DECIDES WHICH EXIST AND SENDS THEIR COMMANDS. app.js is a classic
   script with no engine client of its own, so every row reads
   `ForayPlayer.engineDeveloperStatus()` (null: no rows at all, which is the
   web, Android and a shell with no engine) and sends through
   `ForayPlayer.engineDeveloperSend()` (player/client.js, over the NE-21 engine
   client's engineSend). Nothing here reaches the bridge directly, so a page
   with no engine cannot send one of these by any path.

   APPENDED AND REMOVED, NEVER `hidden` (the reason `syncVoiceProbeRun` gives).
   Painted by `renderDrawer` like every other drawer label, from the ENGINE's
   answer: the pause hold is its snapshot, the engine setting is what it
   confirmed storing, and a one-shot row says what the engine replied to the
   last tap ("armed", or why it refused). A row with a send in flight is
   disabled, so a double tap is one command. */
const ENGINE_OVERRIDE_ORDER = ["auto", "native", "web"];
const ENGINE_OVERRIDE_WORDS = { auto: "Automatic", native: "Native", web: "Web" };

/** Why the engine refused, in words (engine-contract.js REFUSALS, plus the
    page-side `bridge-error`). An unlisted reason is shown as sent. */
const ENGINE_REFUSAL_WORDS = {
  "not-loaded": "play and pause an episode first",
  "engine-busy": "pause playback first",
  "capability-off": "not available on this build",
  relinquished: "the web player has playback until the app restarts",
  "unknown-cmd": "this build does not know that command",
  "bridge-error": "the app did not answer",
};

/** The last reply to each one-shot row, this page load. */
const engineDevOutcome = {};
const engineDevInFlight = new Set();

function engineDevStatus() {
  const p = window.ForayPlayer;
  if (!p || typeof p.engineDeveloperStatus !== "function" || typeof p.engineDeveloperSend !== "function") return null;
  try { return p.engineDeveloperStatus() || null; } catch (_) { return null; }
}

function engineRefusalWords(reply) {
  const reason = reply && reply.reason ? String(reply.reason) : "bridge-error";
  return ENGINE_REFUSAL_WORDS[reason] || reason;
}

/** The word after "Pause hold:" for a snapshot holdPolicy ("forever" | "none"
    | "until:<minutes>"), or "not known" before the engine has said. */
function holdPolicyWord(policy) {
  if (policy === "forever" || policy === "none") return policy;
  const m = /^until:(\d+)$/.exec(policy || "");
  return m ? `${m[1]} min` : "not known";
}

const ENGINE_DEV_ROWS = [
  {
    id: "engine-mode-override", cmd: "setModeOverride",
    paint(btn, st) {
      const word = ENGINE_OVERRIDE_WORDS[st.override] || "not known";
      const now = st.lane === "native" ? "Native" : "Web";
      setControlLabel(btn, `Playback engine: ${word} (applies after restart) · now ${now}`,
        `Playback engine: ${word}, applies after restart. Running now: ${now}`);
    },
    next(st) {
      const i = ENGINE_OVERRIDE_ORDER.indexOf(st.override);
      return { mode: ENGINE_OVERRIDE_ORDER[(i + 1) % ENGINE_OVERRIDE_ORDER.length] };
    },
  },
  {
    id: "engine-hold-policy", cmd: "setHoldPolicy", role: "switch",
    paint(btn, st) {
      setControlLabel(btn, `Pause hold: ${holdPolicyWord(st.holdPolicy)}`, "Pause hold forever");
      btn.setAttribute("aria-checked", String(st.holdPolicy === "forever"));
    },
    next(st) { return { policy: st.holdPolicy === "forever" ? "none" : "forever" }; },
  },
  {
    id: "engine-simulate-termination", cmd: "simulateTermination", oneShot: true,
    title: "Simulate system termination",
    armed: "armed. Lock the phone: the app saves its place and closes",
  },
  {
    id: "engine-session-probe", cmd: "probeSession", oneShot: true,
    title: "Session probe",
    armed: "armed. Lock the phone now; it speaks in 10 seconds",
  },
];

function paintEngineDevRow(row, btn, st) {
  btn.disabled = engineDevInFlight.has(row.id);
  if (!row.oneShot) { row.paint(btn, st); return; }
  const out = engineDevOutcome[row.id];
  const text = !out ? row.title
    : out.ok ? `${row.title}: ${row.armed}`
      : `${row.title}: refused, ${engineRefusalWords(out)}`;
  setControlLabel(btn, text, text);
}

async function tapEngineDevRow(row) {
  if (engineDevInFlight.has(row.id)) return null;
  const st = engineDevStatus();
  if (!st || !Array.isArray(st.commands) || !st.commands.includes(row.cmd)) { renderDrawer(); return null; }
  const args = row.next ? row.next(st) : undefined;
  engineDevInFlight.add(row.id);
  renderDrawer();
  let reply = null;
  try {
    reply = await window.ForayPlayer.engineDeveloperSend(row.cmd, args);
  } catch (_) {
    reply = null;
  } finally {
    engineDevInFlight.delete(row.id);
  }
  const answer = reply || { ok: false, reason: "bridge-error" };
  if (row.oneShot) engineDevOutcome[row.id] = { ok: !!answer.ok, reason: answer.reason };
  renderDrawer();
  /* The one-shot rows change their words in place, which a screen reader
     does not re-read on a focused button; the switch and the setting are
     said by their own state. */
  if (row.oneShot) {
    const btn = $("#" + row.id);
    if (btn) announce(btn.textContent);
  }
  return answer;
}

/** Create, paint or remove the engine rows. Called from `renderDrawer`, and
    once the player module has said which lane plays. */
function syncEngineDevRows() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const st = engineDevStatus();
  const cmds = st && Array.isArray(st.commands) ? st.commands : [];
  const want = ENGINE_DEV_ROWS.filter((row) => cmds.includes(row.cmd));
  for (const row of ENGINE_DEV_ROWS) {
    if (want.includes(row)) continue;
    const gone = $("#" + row.id);
    if (gone) gone.remove();
  }
  if (!want.length) return;
  const group = drawerDevGroup() || drawer;
  const diag = $("#diag-open");
  const before = diag && diag.parentNode === group ? diag : null;
  for (const row of want) {
    let btn = $("#" + row.id);
    if (!btn) {
      btn = ddEl("button", "drawer-item as-btn drawer-wrap", "");
      btn.type = "button";
      btn.id = row.id;
      /* A setting changes IN the drawer (the switches' rule, Joey 2026-08-31). */
      btn.dataset.drawerStay = "1";
      if (row.role) btn.setAttribute("role", row.role);
      if (before) group.insertBefore(btn, before);
      else group.appendChild(btn);
      btn.addEventListener("click", () => tapEngineDevRow(row));
    }
    paintEngineDevRow(row, btn, st);
  }
}

/** The rows appear only once the lane is known: engineHello answers up to 5 s
    after launch, so a drawer painted before then has no engine to ask. */
function bindEngineDevRows() {
  const whenLane = () => {
    const p = window.ForayPlayer;
    const ready = p && typeof p.whenEngineReady === "function" ? p.whenEngineReady() : null;
    Promise.resolve(ready).then(syncEngineDevRows, syncEngineDevRows);
  };
  if (window.ForayPlayer) whenLane();
  else window.addEventListener("forayplayer:ready", whenLane, { once: true });
}

/** Run the probe and show its numbers where the founder can copy them: the
    Playback-diagnostics sheet, which is already the one copyable surface on
    the phone (HUMAN-ACTIONS.md #21). The record is written into `cp_diag` by
    `ForayPlayer.runVoiceProbe()` itself, so the sheet's own refresh picks it
    up — this function opens the sheet and paints the human-readable summary
    into its status line so the answer is legible before anyone scrolls.

    GUARDED THE SAME WAY EVERY FORAY TAP IS (#225): a rejected promise here
    must not become a console line nobody has open. */
/* ONE PROBE AT A TIME (audit round 3, app-3-11). Nothing guarded a second
   tap: a founder who reopened the drawer and pressed RUN again (nothing else
   shows a run is under way for its ~90 s, and reopening the sheet clears its
   status line) started a second engine load beside the first, both writing
   the one status line in whatever order they finished. While a run is in
   flight the control is disabled, and a second call reopens the sheet, says
   it is running, and hands back the same promise. */
let voiceProbeRunning = null;
const VOICE_PROBE_RUNNING_LINE = "Running the voice probe — this takes about 90 seconds.";
function runVoiceProbe() {
  if (voiceProbeRunning) {
    const ui = diagSheet();
    openDiagSheet();
    ui.status.textContent = VOICE_PROBE_RUNNING_LINE;
    return voiceProbeRunning;
  }
  const run = runVoiceProbeOnce();
  voiceProbeRunning = run;
  const btn = $("#voice-probe-run");
  if (btn) btn.disabled = true;
  const done = () => {
    if (voiceProbeRunning !== run) return;
    voiceProbeRunning = null;
    const b = $("#voice-probe-run");
    if (b) b.disabled = false;
  };
  run.then(done, done);
  return run;
}

async function runVoiceProbeOnce() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  ui.status.textContent = VOICE_PROBE_RUNNING_LINE;
  if (!player || typeof player.runVoiceProbe !== "function") {
    ui.status.textContent = "The player hasn't loaded, so the probe can't run.";
    return null;
  }
  try {
    const record = await player.runVoiceProbe();
    refreshDiagSheet();
    const out = typeof player.formatVoiceProbe === "function"
      ? player.formatVoiceProbe(record)
      : { text: "", verdict: { go: false, failures: ["no verdict available"] } };
    ui.status.textContent = record && record.ok
      ? `${out.text}\n  go/no-go: ${out.verdict.go ? "GO" : `NO — ${out.verdict.failures.join("; ")}`}`
      : `The probe could not measure anything: ${record && record.reason ? record.reason : "unknown"}. `
        + `The record above says the same thing — copy it.`;
    return record;
  } catch (_) {
    ui.status.textContent = "The probe failed to run. Copy the record above and say what build this is.";
    return null;
  }
}

/* The Interests page (#/interests, U-07) is reachable from Settings, but
   index.html's drawer markup is not among this card's owned files and is
   unlisted/human-merge-gated (CLAUDE.md path-policy) — editing it would pull
   this whole change off the auto-merge path for one nav link. Injected once
   into the drawer instead, immediately after `.drawer-section-label`
   ("Settings" — the drawer's only section label today, per index.html), the
   same place a founder editing index.html by hand would put it. If the
   drawer ever grows a second `.drawer-section-label`, this must switch to a
   text-matched lookup rather than "the first one found". Guarded by a flag
   on the drawer element so repeated renderDrawer() calls (every
   `openDrawer(true)`) don't stack duplicate links. */
function ensureInterestsDrawerLink() {
  const drawer = $("#drawer");
  if (!drawer || drawer._interestsLinkAdded) return;
  drawer._interestsLinkAdded = true;
  const label = document.querySelector(".drawer-section-label");
  const link = document.createElement("a");
  link.className = "drawer-item";
  link.href = "#/interests";
  link.textContent = "Interests";
  if (label && label.parentNode) {
    label.parentNode.insertBefore(link, label.nextSibling);
  } else {
    drawer.appendChild(link);
  }
}

/* ---------- delete my data (#42) ----------

   WHY THIS EXISTS
   Google Play's Data Safety form asks whether users can request that their data
   be deleted, and until this control existed the only honest answer was No — a
   store-submission blocker, and long before that a real gap: a listener who
   wanted out had nothing but their browser's site-data screen, which cannot
   touch the rows already sent to our database.

   WHAT "DELETE" MEANS HERE, exactly, because a control that clears half of it
   and says "done" is worse than no control at all:

     1. BOTH LOCAL TIERS. Every `cp_` key, in `localStorage` AND in the IndexedDB
        database, enumerated FROM THE TIERS THEMSELVES (`DurableStore.purge`) and
        then re-read to prove they are gone. There is deliberately no key list in
        this file: the audit behind `docs/legal/privacy-policy.md` found **20**
        keys where every earlier count said 11, two of them patterned
        (`cp_foray:<id>`, `cp_pos:<id>`), and a list typed here would rot exactly
        the way that count did. In the native app the Preferences tier is a third
        tier, and `purge()` reaches it the same way.
     1b. THE EVENT QUEUE, which is NOT a `cp_` key: M3 moved it into its own
        IndexedDB database (`foray_events`, `player/event-log.js`), outside the
        enumeration above. Until the 2026-09-22 audit this control said "This
        device is clear" while every event row survived there — episode ids,
        positions, the old profile id — and the unsynced ones were then uploaded
        under the NEW anonymous account the next launch mints. `clearEventLog()`
        purges it and re-reads it, and its answer is folded into `ok`.
        `test/data-deletion.test.js` enumerates every database and cache the
        shipped code opens, so a third store cannot appear unaccounted for.
     2. THE SERVER ROWS. Every per-user table's row-level-security policy is
        `for all` (`backend/migrations/supabase/0001_auth_and_rls.sql`), so this
        client can delete its own rows under its own `auth.uid()`. It was a
        missing request, never a missing permission.
     3. NOT THE ANONYMOUS ACCOUNT ROW ITSELF, and the UI says so in words.
        Deleting a Supabase auth user needs the admin API and a service-role key,
        and a key that can delete any account cannot ship inside a public web
        page (this repo's automation is deliberately keyless — CLAUDE.md). What
        this control can do, and does, is cut the link: the token and the local
        id are two of the 20 keys, so the next event creates a NEW anonymous
        account instead of re-attaching to the old one. What stays behind is a row
        with no name, email, phone number or password — and `app_users` plus the
        events keyed to it are deleted, so it is an empty shell. Removing the
        shell is `HUMAN-ACTIONS.md` #14.
     4. NOT THE PUBLISHER AND ATTRIBUTION HOSTS. Playing a segment points an
        `<audio>` element at the publisher's own URL, so 43 first-hop hosts —
        several of them ad-attribution prefixes the publisher put there — saw
        this listener's IP address directly. We never received it and cannot
        delete it. The policy discloses that (§4) and this control must not imply
        otherwise, which is why one line of the sheet says so.

   TWO ORDERING RULES, both load bearing:
     - PLAYBACK STOPS FIRST, without flushing. A running player writes a position
       roughly every 15 seconds and a Foray resume row with it, so a clear
       underneath live playback is undone one tick later.
     - REMOTE BEFORE LOCAL. `cp_sb_session` is the only credential that can
       delete the server rows, and clearing local destroys it. So a remote
       failure STOPS the run with the device untouched and the token intact,
       rather than stranding rows nothing can ever reach again. It is also why
       nothing on that path is worded as a success: a false success is the worst
       outcome this control can produce. */

/* The per-user tables an anonymous client owns rows in, in deletion order —
   `events` first because it is the only table this client writes and therefore
   the one the promise rests on, `app_users` last because everything else keys to
   it. The list is pinned against the RLS migration by
   `test/data-deletion.test.js`, so a new per-user table cannot appear there
   without this list failing. */
const SB_USER_TABLES = [
  "events", "saved_items", "user_interests", "sessions", "session_items",
  "subscriptions", "taxonomy_nodes", "learning_cursor", "app_users",
];

/** Three outcomes per table, and the difference between them is the whole
    honesty of this feature. `absent` is a 404: the table is not in this project's
    API at all, so it holds no rows of ours — a true statement, not a shrug. */
const DEL_DELETED = "deleted";
const DEL_ABSENT = "absent";
const DEL_FAILED = "failed";
/* A fourth, for a table whose delete policy this build cannot rely on: the
   DELETE was accepted and no row came back, so we cannot say one was removed. */
const DEL_UNCONFIRMED = "unconfirmed";

/* Tables whose own-rows DELETE policy is not known to be live (round-3 review,
   L6). `learning_cursor` gets `own_delete_learning_cursor` from
   supabase/0003, which is NOT applied to production (founder Q3); under 0002
   the table is deny-all, and a DELETE there is a 204 that removes nothing. So
   for these the request asks for the deleted rows back, and only rows it SAW
   removed count as deleted. An empty answer is "unconfirmed", never "deleted",
   and the sheet says so. Take a table off this list once its policy is live. */
const SB_DELETE_UNVERIFIED = new Set(["learning_cursor"]);

/**
 * The account this device already has — never a new one.
 *
 * `ensureAnonSession()` signs up when it finds no token, which is right for
 * syncing and absurd here: creating an account in order to delete one would
 * leave a fresh row behind and delete nothing. A stale token is refreshed if we
 * can; if the refresh fails we try the token we have and let the server's answer
 * be the answer.
 *
 * A REFRESH IS SAVED THE MOMENT IT ARRIVES (round-2 audit, persist-1). Supabase
 * rotates refresh tokens: the one we send is spent by the call that answers it.
 * This used to return the refreshed session without storing it, so a run that
 * then hit one failing table left `cp_sb_session` holding a spent token — every
 * retry 401'd, and the next event sync's own refresh failed and signed up a NEW
 * account, stranding the rows the "remote before local" rule exists to keep
 * reachable. It is written through `lsSet`, and ALSO held in `rotatedSession`,
 * because a store that refused the write would otherwise hand the retry the
 * spent token all the same.
 */
let rotatedSession = null;

async function existingAnonSession() {
  const now = Math.floor(Date.now() / 1000);
  const stored = lsGet("cp_sb_session", null);
  /* Only while the store still holds the token this module spent: a newer
     session written since (a sync's own refresh) is the newer truth. */
  const s = rotatedSession && stored && stored.refresh_token === rotatedSession.spent
    ? rotatedSession.session
    : stored;
  if (!s || !s.access_token || !s.user_id) return null;
  if (s.expires_at && s.expires_at - 60 > now) return s;
  if (s.refresh_token) {
    const res = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    const r = res.ok ? res.body : null;
    if (r && r.access_token) {
      /* `r.user.id` is not assumed to exist. A refresh response without a `user`
         object is not a shape we have seen, but reading through it would throw a
         TypeError out of the whole deletion — and the id we already hold is the
         same account by definition, since this is a refresh of its own token. */
      const fresh = {
        user_id: (r.user && r.user.id) || s.user_id,
        access_token: r.access_token,
        refresh_token: r.refresh_token || s.refresh_token,
        expires_at: r.expires_at || now + 3600,
      };
      rotatedSession = { spent: stored && stored.refresh_token, session: fresh };
      lsSet("cp_sb_session", fresh);
      return fresh;
    }
  }
  return s;
}

/** One authenticated DELETE, filtered to this account's own rows. */
async function sbDeleteOwnRows(table, session) {
  const verify = SB_DELETE_UNVERIFIED.has(table);
  const url = `${SB_URL}/rest/v1/${table}?user_id=eq.${encodeURIComponent(session.user_id)}${verify ? "&select=user_id" : ""}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + session.access_token,
        Prefer: verify ? "return=representation" : "return=minimal",
      },
    });
    if (res.ok && verify) {
      let rows = null;
      try { rows = await res.json(); } catch (_) { rows = null; }
      const removed = Array.isArray(rows) ? rows.length : 0;
      return { table, state: removed > 0 ? DEL_DELETED : DEL_UNCONFIRMED, status: res.status };
    }
    if (res.ok) return { table, state: DEL_DELETED, status: res.status };
    // Not in the API schema => no rows of ours are in it. Anything else — 401,
    // 403, 409, 500 — is a refusal we must not round down to success.
    if (res.status === 404) return { table, state: DEL_ABSENT, status: 404 };
    return { table, state: DEL_FAILED, status: res.status };
  } catch (_) {
    // Offline, DNS, CSP, a dropped connection: no answer at all.
    return { table, state: DEL_FAILED, status: 0 };
  }
}

/**
 * Sign the account out EVERYWHERE, on the server: every refresh token it was
 * ever issued stops working (`POST /auth/v1/logout?scope=global`, with the
 * account's own access token — no administrative key needed).
 *
 * WHY A DELETION DOES THIS (review of #773, 2026-09-24). Clearing the device
 * destroys this copy of the token, not the others. A phone backup made by a
 * build before the device-only vault holds `cp_sb_session` in three places,
 * and restoring it onto a new phone put the deleted account's live refresh
 * token back in the app, which re-attached to it. Revoked here, that copy is
 * dead wherever it is, which is what the privacy policy's §3 and §7 promise.
 */
async function sbRevokeSessions(session) {
  try {
    const res = await fetch(SB_URL + "/auth/v1/logout?scope=global", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + session.access_token },
    });
    return { ok: Boolean(res.ok), status: res.status };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

/**
 * Delete every server row this device's account owns, then revoke its sign-in.
 *
 * `ok` is false if ANY table refused or the revocation failed, and the caller
 * must then not clear local storage — see the ordering rules above. The
 * revocation comes LAST: it needs the token the row DELETEs need, and a retry
 * after a failed table must still be able to reach the rows.
 */
/* A REMOTE STEP THAT ALREADY SUCCEEDED, remembered for the retry (audit round
   3, app-3-6). A run whose server step succeeded and whose local clear did not
   says "Close 4a fully and try again". The retry used to start from scratch:
   with cp_sb_session gone it said the device was "never signed in" (the rows
   were deleted a moment ago), and with a surviving expired token it refreshed
   a token this module had just revoked, every DELETE 401'd, and the sheet said
   the server copy was NOT deleted and left the device uncleared. So the success
   is kept here -- in memory, deliberately not a `cp_` key: it names the
   account the run deleted, and the purge must not have to spare it -- and a
   retry for that same account (or with no token left) reports it as done
   without a request. Across a relaunch the memory is gone, and what keeps the
   retry honest there is that cp_sb_session is removed FIRST, on its own, the
   moment the server step succeeds (deleteMyData). */
let ddRemoteDone = null;

async function deleteRemoteData() {
  if (ddRemoteDone) {
    const stored = lsGet("cp_sb_session", null);
    if (!stored || !stored.user_id || stored.user_id === ddRemoteDone.userId) {
      return { ok: true, attempted: true, alreadyDeleted: true, tables: [], failed: [], unconfirmed: ddRemoteDone.unconfirmed || [], deleted: 0, userId: ddRemoteDone.userId };
    }
  }
  const session = await existingAnonSession();
  if (!session) return { ok: true, attempted: false, tables: [], deleted: 0 };
  const tables = [];
  for (const t of SB_USER_TABLES) tables.push(await sbDeleteOwnRows(t, session));
  const failed = tables.filter(r => r.state === DEL_FAILED);
  const revoked = failed.length === 0 ? await sbRevokeSessions(session) : null;
  return {
    ok: failed.length === 0 && Boolean(revoked && revoked.ok),
    attempted: true,
    tables,
    failed,
    // Accepted, but no row seen removed: not counted, and not called deleted.
    unconfirmed: tables.filter(r => r.state === DEL_UNCONFIRMED).map(r => r.table),
    revoked,
    deleted: tables.filter(r => r.state === DEL_DELETED).length,
    userId: session.user_id,
  };
}

/**
 * Clear everything this device holds about the listener: the event queue
 * (`clearEventLog`) and every `cp_` key in every tier (`clearStoredKeys`).
 *
 * The real work for the keys is `DurableStore.purge()`, which enumerates the tiers rather
 * than the facade and verifies afterwards. The fallback in `clearStoredKeys` matters and is not
 * decoration: app.js and `player/client.js` deploy independently through the
 * service worker, so a page can be running with no store published — and then
 * `localStorage` is reachable and IndexedDB is not. That case reports `ok: false`
 * with a reason, because a cleared mirror is not cleared storage.
 */
async function clearLocalData() {
  /* FIRST, before any await, AND HERE RATHER THAN IN `stopForDataDeletion()` (#264). `purge()` empties
     both tiers of every `cp_` key including `cp_diag`, but the player module holds
     that ring IN MEMORY — so without this the next time the listener pockets their
     phone, the record is written straight back under a key they just asked to be
     emptied. It belongs in THIS function and not in the stop, because the stop runs
     before the server step and a remote failure leaves the device untouched on
     purpose; clearing there destroyed the record on a path that promises not to. */
  try {
    if (typeof window.forayForgetDiagnostics === "function") window.forayForgetDiagnostics();
  } catch (_) { /* a diagnostic that will not clear is not a reason to refuse a deletion */ }

  /* The pre-module buffer (`logEvent` before `window.forayEventLog` exists) is
     event rows in memory, and `flushBufferedEvents()` would hand them to the
     queue this function is about to empty. */
  _bufferedEvents = [];
  /* THE KEYS FIRST, THE QUEUE LAST (review 2026-09-23), and nothing logged in
     between (`dataDeletionInProgress`). The queue used to be emptied first, so
     a storage fault raised by the key purge landed a fresh row — under a fresh
     profile id — in a queue already reported empty. */
  dataDeletionInProgress = true;
  localClears++;
  rotatedSession = null;
  try {
    const local = await clearStoredKeys();
    const events = await clearEventLog();
    const shards = await clearShardCache();
    /* One `ok` for the whole device. A clear `cp_` namespace beside a surviving
       event queue is exactly the false "This device is clear" this replaced. */
    return { ...local, ok: Boolean(local.ok) && Boolean(events.ok) && Boolean(shards.ok), events, shards };
  } finally {
    dataDeletionInProgress = false;
  }
}

/**
 * Drop the Shows-search shard cache (round-2 audit, persist-4).
 *
 * Its rows are public, but WHICH rows it holds is not: one entry per two-letter
 * prefix of the longest word the listener searched for, so the set of keys is
 * a trace of their searches. It is a cache — losing it costs one re-fetch — so
 * it goes with everything else. `caches.delete` answers false for a bucket that
 * was never opened, which is a clear bucket, not a failure; only a throw is.
 */
async function clearShardCache() {
  if (typeof caches === "undefined" || !caches || typeof caches.delete !== "function") return { ok: true, reason: "no-cache-storage" };
  try {
    await caches.delete(SHARD_CACHE_NAME);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "shard-cache", error: errLabel(err) };
  }
}

/**
 * Empty the outbound event queue (`player/event-log.js`, database
 * `foray_events`) and report whether the re-read found it empty.
 *
 * With no queue published there is nothing this page can open to check, and
 * that is reported as not-done rather than assumed done: the queue and the
 * store arrive together from `player/client.js`, so its absence means the
 * module did not load, which `clearStoredKeys` reports too.
 */
async function clearEventLog() {
  const log = window.forayEventLog;
  if (!log || typeof log.purge !== "function") return { ok: false, remaining: null, reason: "no-event-log" };
  try {
    const out = await log.purge();
    return out && typeof out === "object" ? out : { ok: false, remaining: null, reason: "no-answer" };
  } catch (err) {
    return { ok: false, remaining: null, reason: "purge-failed", error: errLabel(err) };
  }
}

/** Every `cp_` key in every tier — see `DurableStore.purge()`. */
async function clearStoredKeys() {
  const store = storageBackend();
  if (!store) return { ok: false, keys: [], remaining: [], reason: "no-storage" };
  if (typeof store.purge === "function") {
    /* `purge()` is written not to throw, but "written not to throw" is not a
       guarantee, and a throw here would leave the control stuck mid-delete
       (`ddBusy`) with a spinner and no way out. Report it as what it is. */
    try { return await store.purge(); }
    catch (err) { return { ok: false, keys: [], remaining: [], reason: "purge-failed", error: errLabel(err) }; }
  }

  /* EVERY read here is guarded, not just the writes. This branch exists for the
     browser where storage is degraded, and `SecurityError` (blocked cookies, some
     private modes) comes out of `length` and `getItem` exactly as readily as out
     of `removeItem`. Review found the unguarded ones. */
  const keys = [];
  try {
    const n = Number(store.length) || 0;
    for (let i = 0; i < n; i++) {
      const k = store.key(i);
      if (typeof k === "string" && k.startsWith("cp_")) keys.push(k);
    }
  } catch (err) {
    return { ok: false, keys: [], remaining: [], reason: "no-storage", error: errLabel(err) };
  }
  // Collected before removing: removing while enumerating shifts every index
  // after it, which silently skips half the keys.
  const remaining = [];
  for (const k of keys) {
    let gone = false;
    try { store.removeItem(k); gone = store.getItem(k) === null; } catch (_) { gone = false; }
    if (!gone) remaining.push(k);
  }
  return { ok: false, keys, remaining, reason: "no-durable-tier" };
}

/** An error's name, for a status line a listener reads. Never the message: a
    browser's storage error text is not English anyone asked for. */
function errLabel(err) {
  return err && err.name ? String(err.name) : "error";
}

/**
 * Everything the sheet says, in one place, so the wording is testable without a
 * browser and cannot drift from the result.
 *
 * Two rules it is written to, both pinned by `test/data-deletion.test.js`:
 *   - EVERY sentence is inside the copy budget (CLAUDE.md principle 4, ≤ 18
 *     words), because these are the words a listener reads at the one moment
 *     they are least inclined to re-read anything.
 *   - IT CLAIMS ONLY WHAT WAS OBSERVED. A `DELETE` returns 204 whether or not a
 *     row matched, so "deleted from 8 tables" would be a number we did not
 *     measure. "Your rows on our server are deleted" is true either way.
 */
function deletionMessage(result) {
  const { state, remote, local } = result;
  /* No storage vocabulary reaches the listener here — no "key", no "tier", no
     error class. Those are in `result.local` for diagnostics. The audit found
     this line reading "0 key(s) would not clear.": a count that could be zero
     while the sentence said something failed, in a word nobody uses. */
  if (state === "unconfirmed") return "Type DELETE to confirm.";
  if (state === "busy") return "Deleting…";
  if (state === "remote-failed") {
    /* Every table answered but the sign-in could not be revoked: the rows ARE
       gone, and saying otherwise would be its own untruth. */
    if (remote && Array.isArray(remote.failed) && !remote.failed.length && remote.revoked && !remote.revoked.ok) {
      return "Your rows on 4a's server are deleted, but its sign-in is NOT switched off yet. Nothing on this device was touched, so you can try again.";
    }
    return "What 4a's server kept about you was NOT deleted. Nothing on this device was touched, so you can try again.";
  }
  const server = remote && remote.deviceOnly
    ? "What 4a's server kept about you was left in place, as you chose."
    : !remote || !remote.attempted
      ? "No sign-in remains on this device, so nothing on 4a's server is reachable from it."
      /* A table the server accepted the DELETE for but showed no removed row
         (SB_DELETE_UNVERIFIED): claiming it is gone would be a false success. */
      : Array.isArray(remote.unconfirmed) && remote.unconfirmed.length
        ? "What 4a's server kept about you is deleted, except possibly one bookkeeping record."
        : "What 4a's server kept about you is deleted.";
  if (local && local.ok) return `Done. ${server} This device is clear.`;
  return `${server} This device is NOT fully clear. ${deviceNotClearReason(local)}`;
}

/** Why the device is not clear, in the listener's words: the first reason that
    applies, and always something to do next where there is one. */
function deviceNotClearReason(local) {
  const reason = local && local.reason;
  if (reason === "no-storage") return "This device gives 4a nowhere to store anything.";
  if (reason === "no-durable-tier") return "Part of this device's storage is out of reach. Close 4a fully and try again.";
  if (reason === "purge-failed") return "Storage refused the delete. Close 4a fully and try again.";
  if (local && Array.isArray(local.unverified) && local.unverified.length) {
    return "Storage could not be checked afterwards. Close 4a fully and try again.";
  }
  if (local && Array.isArray(local.remaining) && local.remaining.length) {
    return "Some of what 4a saved here would not clear. Close 4a fully and try again.";
  }
  if (local && local.events && !local.events.ok) {
    return "The record of what you played here would not clear. Close 4a fully and try again.";
  }
  return "Some of what 4a saved here would not clear. Close 4a fully and try again.";
}

/* The sheet and the drawer button are built in JavaScript rather than written
   into `index.html`, for the same mechanical reason `player/client.js` builds the
   whole mini-player that way: `index.html` is outside the auto-merge allowlist
   (`tools/ci/path-policy.mjs`), and this control should not need a founder merge
   to reach the listener it is for. createElement + textContent throughout — the
   page CSP is strict and none of this text is user-supplied anyway. */
let ddUi = null;
let ddBusy = false;

function ddEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** What the control covers and what it cannot. Every line is read by a listener,
    so every line is inside the copy budget (CLAUDE.md principle 4). */
const DD_COVERS = [
  "This device: everything 4a stored here, including the record of what you played.",
  "4a's server: the events this device sent, and what it keeps about this device.",
  "Your anonymous account row stays. It holds no name, email or phone number.",
  "Publisher and ad hosts saw your IP as audio played. 4a cannot delete that.",
];

const DD_DEVICE_ONLY_COST = "After this, what 4a's server kept about you can no longer be deleted.";

function buildDeleteSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "dd-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel dd-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Delete my data");
  title.id = "dd-title";
  panel.setAttribute("aria-labelledby", "dd-title");

  const list = ddEl("ul", "dd-covers");
  for (const line of DD_COVERS) list.append(ddEl("li", null, line));

  const label = ddEl("label", "dd-label", "Type DELETE to confirm");
  label.setAttribute("for", "dd-confirm");
  const input = ddEl("input", "dd-input");
  input.id = "dd-confirm";
  input.type = "text";
  input.setAttribute("maxlength", "12");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  const actions = ddEl("div", "fy-sheet-actions");
  const cancel = ddEl("button", "fy-sheet-cancel", "Cancel");
  cancel.type = "button";
  const go = ddEl("button", "fy-sheet-go dd-go", "Delete everything");
  go.type = "button";
  go.disabled = true;
  actions.append(cancel, go);

  /* Offered only after a remote failure, and never before: it is the honest
     escape hatch for someone who cannot reach the server and still wants this
     device cleared, and it states the cost on its own face. */
  const deviceOnly = ddEl("button", "dd-device-only", "Clear this device only");
  deviceOnly.type = "button";
  deviceOnly.hidden = true;
  /* The cost the button's label cannot carry (round-2 audit, persist-7). This
     device's token is the only credential that reaches the server copy, and
     this clear erases it — so "try again" stops being true the moment it runs.
     Shown beside the button, before the tap, and left up after it. */
  const deviceOnlyCost = ddEl("p", "fy-sheet-sub dd-device-only-cost", DD_DEVICE_ONLY_COST);
  deviceOnlyCost.hidden = true;
  /* BEFORE THE TAP FOR A SCREEN READER TOO (audit round 2 review): the
     sentence sat AFTER the button in DOM order and was not linked to it, so
     VoiceOver and TalkBack read "Clear this device only, button" and the one
     irreversible choice on the sheet could be taken before the cost was heard.
     It now comes first in the panel, and the button is described by it. */
  deviceOnlyCost.id = "dd-device-only-cost";
  deviceOnly.setAttribute("aria-describedby", deviceOnlyCost.id);

  const status = ddEl("p", "dd-status");
  status.id = "dd-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(
    ddEl("div", "fy-grab"), title,
    ddEl("p", "fy-sheet-sub", "This cannot be undone. Here is what it covers."),
    list, label, input, actions, deviceOnlyCost, deviceOnly, status,
  );
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, input, go, cancel, deviceOnly, deviceOnlyCost, status };
}

function deleteSheet() {
  if (!ddUi) ddUi = buildDeleteSheet();
  return ddUi;
}

/** The confirmation itself, and the ONLY thing that permits a deletion.
    Deliberately a typed word rather than a second click: the sheet's own buttons
    sit where a scrim tap or a mis-hit lands, and one stray click must not be
    able to delete a listener's account. */
function deleteConfirmed() {
  return Boolean(ddUi) && String(ddUi.input.value || "").trim().toUpperCase() === "DELETE";
}

function syncDeleteCta() {
  if (!ddUi) return;
  // BOTH destructive buttons answer to the typed word. The device-only one is
  // still destructive — it is the same clear with the server step skipped.
  const armed = !ddBusy && deleteConfirmed();
  ddUi.go.disabled = !armed;
  ddUi.deviceOnly.disabled = !armed;
}

/* Opening always DISARMS. The drawer item is the surface a stray tap lands on,
   and a sheet that reopened still holding a typed `DELETE` would turn the second
   stray tap into a deletion. Review found this: closing cleared the field, and
   reopening without closing did not. */
function openDeleteSheet() {
  const ui = deleteSheet();
  ui.input.value = "";
  ui.status.textContent = "";
  ui.deviceOnly.hidden = true;
  ui.deviceOnlyCost.hidden = true;
  ddBusy = false;
  syncDeleteCta();
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeDeleteSheet });
}

function closeDeleteSheet() {
  if (!ddUi || ddBusy) return;     // never vanish mid-delete
  closeSheet(ddUi.root);
  ddUi.root.hidden = true;
  ddUi.input.value = "";
  syncDeleteCta();
}

/**
 * Delete it all. Returns the result rather than only painting it, so the
 * ordering and the failure paths are testable.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.deviceOnly] skip the server step — offered only after a
 *   remote failure, so that someone offline can still clear their device having
 *   been told plainly that the rows remain.
 */
async function deleteMyData({ deviceOnly = false } = {}) {
  // A second click while the first run is in flight would race two purges and
  // two DELETEs against one token.
  if (ddBusy) return { ok: false, state: "busy", remote: null, local: null };
  /* The confirmation gates BOTH paths, device-only included: it is the same
     destructive clear with the server step skipped, and its button is only ever
     on screen after a failure — which is exactly when someone is jabbing at the
     sheet. */
  if (!deleteConfirmed()) {
    const out = { ok: false, state: "unconfirmed", remote: null, local: null };
    paintDeletion(out);
    return out;
  }
  ddBusy = true;
  deletionEpoch += 1;
  syncDeleteCta();
  if (ddUi) ddUi.status.textContent = "Deleting…";

  /* try/finally, because `ddBusy` is what disables the buttons AND what stops
     `closeDeleteSheet` dismissing a run mid-flight. Review proved the cost of
     getting this wrong: one throw left the sheet reading "Deleting…" forever with
     Cancel, the scrim and the confirm button all dead until a reload. */
  try {
    // Stop first, and write nothing on the way out.
    try {
      const player = window.ForayPlayer;
      if (player && typeof player.stopForDataDeletion === "function") {
        await player.stopForDataDeletion();
      }
    } catch (_) { /* an unstoppable player is not a reason to refuse a deletion */ }

    /* Then wait out any event sync already running (persist-8), so its POST
       cannot land after the `events` DELETE. Bounded: a sync stuck on a dead
       socket must not hold the deletion, and the `syncOutlived()` checks
       inside it stop it writing anything once it wakes. */
    if (syncsInFlight.size) {
      await withDeadline(Promise.allSettled([...syncsInFlight]), SYNC_SETTLE_MS, () => null);
    }

    const remote = deviceOnly
      ? { ok: true, attempted: false, deviceOnly: true, tables: [], deleted: 0 }
      : await deleteRemoteData();
    if (remote && !remote.ok) {
      // The device is untouched on purpose: its token is the only way back to
      // those rows.
      const out = { ok: false, state: "remote-failed", remote, local: null };
      paintDeletion(out);
      return out;
    }

    /* The server rows are gone and the sign-in revoked: remember it for a
       retry, and drop the now-dead token FIRST and on its own, so a purge
       that fails part-way can never leave a retry holding it (app-3-6). */
    if (remote && remote.attempted && remote.ok && !remote.deviceOnly) {
      ddRemoteDone = { userId: remote.userId || null, unconfirmed: remote.unconfirmed || [] };
      rotatedSession = null;
      try { const st = storageBackend(); if (st) st.removeItem("cp_sb_session"); } catch (_) { /* the purge below tries again */ }
    }

    const local = await clearLocalData();
    const out = { ok: Boolean(local.ok), state: local.ok ? "done" : "local-incomplete", remote, local };

    /* In-memory state outlives storage, so a page left as it was would still show
       a resume rail and thumbs that no longer exist anywhere. Interests are reset
       to taxonomy defaults, which `loadInterests` does WITHOUT writing.
       `buildCards()` is deliberately not called: it writes `cp_recent_branches`
       and `cp_seen`, which would put two of the 20 keys straight back.
       Bump `_interestsGen` here too, same as nudgeTopics does on every
       pick/play/thumbs — otherwise buildPlaylist's `searchCache` (keyed on
       [query, familyMode, _interestsGen]) would happily serve back a
       pre-wipe, interest-ranked result for the exact same query, silently
       undercutting "reset personalization". */
    state.interests = {};
    interestsSetThisSession = new Set();
    loadInterests();
    state._interestsGen = (state._interestsGen || 0) + 1;
    state.forayResume = null;
    state.forayPlaying = null;
    state.foray = null;
    state.forayPainted = null;
    /* And this is the one action the app does not log. `logEvent` writes
       `cp_events` and mints `cp_profile_id`, and the next sync would create a
       fresh anonymous account — telling our server about a deletion by starting a
       new identity. */
    paintDeletion(out);
    /* The re-render happens UNDER the open sheet, and a device just emptied is
       exactly the profile the first-time explainer opens for — it used to slide
       up over "This device is clear" (persist-2). Held for this one render
       only; the next real navigation shows it as it would on a new install. */
    onboardingHeld = true;
    try { route(); } finally { onboardingHeld = false; }
    return out;
  } finally {
    ddBusy = false;
    syncDeleteCta();
  }
}

/* How long `deleteMyData` waits for an event sync already in flight. `let`, so
   a suite can shorten it. */
let SYNC_SETTLE_MS = 5000;

function paintDeletion(result) {
  if (!ddUi) return;
  ddUi.status.textContent = deletionMessage(result);
  ddUi.deviceOnly.hidden = result.state !== "remote-failed";
  ddUi.deviceOnlyCost.hidden = !(result.state === "remote-failed" || (result.remote && result.remote.deviceOnly));
  syncDeleteCta();
}

/* ---------- V-01: the narration voice picker ----------

   `docs/ios-controls-and-voice-plan.md` V-01. A drawer item — "Narration
   voice" — built and bound the same way `bindDiagnosticsControl()`/
   `bindDeleteControl()` are: appended in JS above "Delete my data", because
   `index.html`'s drawer markup is outside this card's owned files (same
   constraint `ensureInterestsDrawerLink` states). The card asked for it
   "next to Playback diagnostics"; since the 2026-09-22 audit (R8) that item
   lives in the collapsed Developer group, and this one is a listener setting,
   so it sits directly ABOVE that group, still next to it and still above
   "Delete my data".

   DESIGN COMMENT (posted to the card before this was written): there is no
   separate `#/settings` route on `main` post-U-11 — `cp_ui_v2` is retired
   and "Settings" is the drawer's own section label (`index.html`'s
   `.drawer-section-label`). So this ships with exactly one home, the drawer,
   and there is no "before/after U-02" move pending.

   THE THREE ROW KINDS, and why they look different on purpose:
     - INSTALLED, SELECTABLE — a radio-shaped row with an Audition button.
     - ON THE LIST BUT MISSING — greyed, no Audition (there is nothing to
       audition), with the exact Settings path text — no Open Settings
       button (see `buildVoiceRow`'s own comment: `@capacitor/app` has no
       such native method, and a button promising an action the shell
       cannot perform is worse than no button). iOS constraint stated in the
       copy itself: a third-party app can only open its OWN Settings page
       (`UIApplication.openSettingsURLString`), never deep-link to Voices —
       so the text alone gets a listener there, one screen at a time.
     - WEB SPEECH (`path: "web-speech"`, quality `"unknown"`) — installed
       rows only, no greyed section and no Open Settings button, because
       `speechSynthesis.getVoices()` exposes no install state at all.

   A CURATED LIST, NOT "EVERYTHING INSTALLED" (founder decision 2026-09-10,
   after the first real listen: "those voices were all so bad. Samantha was
   the least worst"). The first cut rendered every voice `listVoices()`
   returned, and on iOS 17+ that is dominated by Apple's novelty catalogue —
   Albert, Bad News, Bahh, Bells, Boing, Bubbles, Cellos, Wobble, Zarvox …
   — and the Eloquence set (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
   Shelley), all reported at the same `default` tier as Samantha compact.
   `ForayTtsPlugin.swift`'s `installedVoices()` does not filter
   `voiceTraits.isNoveltyVoice`, and this page cannot ask it to (the plugin is
   outside this card's owned files), so the page renders ONLY the names in
   `VOICE_ALLOWLIST`, in that fixed order, and hides every other installed
   voice. Same name at several tiers (compact + enhanced + premium): the best
   one only, labelled with its tier. */

/** The voices the picker shows, in this order. Samantha is the only survivor
    of the first cut's five (Ava, Evan, Nathan, Zoe are gone by founder
    decision); the rest are a TRIAL SET for the founder to download and
    compare — a greyed row is how a voice is tried: download it in Settings,
    return, the list refreshes on `visibilitychange`.

    NAMES AND HOW EACH WAS VERIFIED (2026-09-10). Apple publishes no list of
    Spoken Content voice names; nothing here has been read off a device by
    anyone in this repo (`mobile/plugins/foray-tts/README.md`'s own honesty
    note). "verified" = the name appears, with that locale and tier, in a
    `speechVoices()` dump from a real device (gist.github.com/Koze/d1de49c2…,
    iOS 13) AND/OR in two independent third-party listings of the
    Settings → Voices screen (help.scriptation.com "better playback voices",
    thefreereader.app "expressive Apple voices"). A row whose name could not
    be confirmed is marked `unverified: true` HERE, not in its description
    (audit round 2, copy-12: "unverified name" on a row is a note about this
    allowlist, not about the voice, and a listener cannot act on it); if it
    never shows up as installed after a download, the name is wrong, not the
    download. Descriptions are accent · gender ONLY: the tier comes from the
    plugin's own `quality` field (voiceQualityLabel), so a row does not say
    "Enhanced" twice, and which voices ship compact-by-default on iOS 18 is
    NOT verified here, so no row claims it. */
const VOICE_ALLOWLIST = Object.freeze([
  { name: "Samantha", about: "American · female" },
  { name: "Allison", about: "American · female" },
  { name: "Susan", about: "American · female" },
  { name: "Joelle", about: "American · female" },
  { name: "Tom", about: "American · male" },
  { name: "Nicky", about: "American · female", unverified: true },
  { name: "Aaron", about: "American · male", unverified: true },
  { name: "Daniel", about: "British · male" },
  { name: "Serena", about: "British · female" },
  { name: "Karen", about: "Australian · female" },
  { name: "Moira", about: "Irish · female" },
  { name: "Tessa", about: "South African · female" },
  { name: "Rishi", about: "Indian · male" },
]);

/** The `lang` this page asks `listVoices()` for. A bare primary subtag on
    purpose: both native halves match the exact locale FIRST AND ALONE
    (`ForayTtsPlugin.swift` `candidates(_:language:)`, `ForayTtsPlugin.java`
    `candidates`), so `"en-US"` could never return Daniel (en-GB), Karen
    (en-AU), Moira, Tessa or Rishi while any en-US voice was installed — and
    Samantha compact always is. `"en"` matches no exact locale, so both
    halves widen to every `en-*` voice; the web shim's `languageMatches`
    does the same by construction. Mirrors `player/default-voice.js`'s
    `VOICE_LIST_LANG` (a classic script cannot import it). */
const VOICE_LIST_LANG = "en";

/** Quality rank for comparing the SAME NAME at several tiers — mirrors
    `player/default-voice.js`'s `qualityRank` (same constraint: no import
    from a classic script). Never used to relabel: the label shown is always
    the plugin's own `quality` string. */
function voiceQualityRank(quality) {
  switch (String(quality || "").toLowerCase()) {
    case "premium": case "very-high": return 5;
    case "enhanced": case "high": return 4;
    case "default": case "normal": return 3;
    case "low": return 1;
    case "very-low": return 0;
    default: return 2;
  }
}

/** Is a `listVoices()` entry English at all? `en-*`, or Android's `eng-*`. */
function voiceIsEnglish(v) {
  const p = String((v && v.language) || "").toLowerCase().split(/[-_]/)[0];
  return p === "en" || p === "eng";
}

/** The allowlist joined against what the device reports: one entry per
    allowlisted name, in allowlist order, carrying the BEST installed voice of
    that name (or `null` when none is). Everything else `listVoices()`
    returned — novelty, Eloquence, Siri, other-name Enhanced downloads — is
    dropped here and never reaches a row. Pure, so the suite can pin it. */
function curateVoices(voices) {
  const list = Array.isArray(voices) ? voices : [];
  return VOICE_ALLOWLIST.map((entry) => {
    const wanted = entry.name.toLowerCase();
    let best = null;
    for (const v of list) {
      if (!v || typeof v.identifier !== "string" || !v.identifier) continue;
      if (String(v.name || "").toLowerCase() !== wanted) continue;
      if (!voiceIsEnglish(v)) continue;
      if (!best || voiceQualityRank(v.quality) > voiceQualityRank(best.quality)) best = v;
    }
    return { name: entry.name, about: entry.about, installed: best };
  });
}

/** The exact path text V-01 specifies, verbatim — a listener reads this
    because the button can only open the app's own Settings page, never
    deep-link to Voices (`UIApplication.openSettingsURLString`'s own limit). */
const VOICE_SETTINGS_PATH = "Settings \u2192 Accessibility \u2192 Spoken Content \u2192 Voices \u2192 English";

/** The fixed audition line: a count to ten, nothing else. It was a count to
    twenty with two spoken "Marker" phrases (H3's stopwatch line); the founder
    cut it on 2026-09-10 ("reduce the script to just counting to ten, it was
    so bad listening to them for so long"). H3's stopwatch reading still
    works against this line, start to the final "ten"; the predicted seconds
    halve, and HUMAN-ACTIONS.md H3 carries the dated note. DELIBERATELY NOT
    LABELLED WITH A CLAIMED SECOND COUNT, for the same reason as before: the
    word count is not tuned to any seconds-per-word rate, so a spoken "ten
    seconds" would be a claim this text cannot back up in whatever voice the
    listener picks. (It is spoken at 1x, never the listener's playback speed,
    since the founder's 2026-09-24 ruling — see `auditionVoiceRow`.) */
const AUDITION_LINE = "one, two, three, four, five, six, seven, eight, nine, ten.";

let voiceUi = null;
let voiceState = { voices: [], path: "none", loading: false, selected: null, auditioning: null, notice: "" };
const VOICE_SHEET_SUB = "Pick which voice reads 4a's narration. Tap Preview to hear it count to ten, at the speed narration uses.";

/** Quality label from `listVoices()`'s own `quality` field — never re-derived,
    per the card ("quality label from `qualityRank`"): the plugin already
    knows its own tiers and this page must not invent a second opinion about
    what "premium" means on a platform it cannot introspect. `"unknown"`
    (Web Speech) reads as a bare noun rather than a fabricated tier word. */
function voiceQualityLabel(v) {
  if (!v || !v.quality || v.quality === "unknown") return "voice";
  return v.quality;
}

function buildVoiceSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "voice-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel voice-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Narration voice");
  title.id = "voice-title";
  panel.setAttribute("aria-labelledby", "voice-title");

  /* "at the speed narration uses", not "at your playback speed" (audit round
     3, app-3-8): a Preview has spoken at NARRATION_RATE (1x) since the
     2026-09-24 ruling, whatever the listener's speed. listener-copy pins this
     sentence against auditionVoice's rate. */
  const sub = ddEl("p", "fy-sheet-sub", VOICE_SHEET_SUB);
  /* ONLY WHEN THERE ARE DIMMED VOICES (review 2026-09-23). This sentence was
     part of the fixed subtitle, and the sheet also opens on the Web Speech path
     in a desktop browser, which never shows a dimmed row — so a desktop listener
     read about greyed voices that do not exist and a phone they are not using.
     `paintVoiceList` shows it exactly when it renders a missing (native) row. */
  const missingNote = ddEl("p", "fy-sheet-sub voice-missing-note",
    "Dimmed voices are free to download from your phone's Settings, and appear here when you come back.");
  missingNote.hidden = true;

  /* A RADIO GROUP, OWNED (audit 2026-09-22, qa row 81). The rows were
     `role="radio"` with no radiogroup around them, so a screen reader gave no
     group name and no "2 of 5", and arrow keys did nothing. */
  const list = ddEl("div", "voice-list");
  list.id = "voice-list";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-labelledby", "voice-title");

  const notice = ddEl("p", "dd-status voice-notice");
  notice.id = "voice-notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.hidden = true;

  const actions = ddEl("div", "fy-sheet-actions");
  const close = ddEl("button", "fy-sheet-cancel", "Close");
  close.type = "button";
  actions.append(close);

  panel.append(ddEl("div", "fy-grab"), title, sub, missingNote, list, notice, actions);
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, list, notice, close, missingNote };
}

function voiceSheet() {
  if (!voiceUi) voiceUi = buildVoiceSheet();
  return voiceUi;
}

/** One row: an installed voice (selectable, with Audition) or a recommended
    name that is not installed (greyed, with the Settings path and an Open
    Settings button). Built with createElement/textContent like every other
    sheet in this file — the CSP is strict and index.html is out of reach. */
function buildVoiceRow({ installed, name, sub, id, selected, tabStop }) {
  const row = ddEl("div", `voice-row${installed ? "" : " voice-row-missing"}${selected ? " voice-row-selected" : ""}`);
  if (id) row.dataset.voiceId = id;

  const text = ddEl("div", "voice-row-text");
  text.append(ddEl("div", "voice-row-name", name), ddEl("div", "voice-row-sub", sub));

  if (installed) {
    /* THE RADIO IS THE NAME, NOT THE ROW. The row used to be the radio and
       held the Preview button inside it — a control nested in a control, so
       the radio announced as "Samantha, …, Audition, radio button" and Preview
       was a second tab stop inside the first. Now the radio and Preview are
       siblings in a plain row, and only ONE radio in the group is a tab stop
       (the chosen one, or the first): arrows move between them, as a native
       radio group's do. */
    const choice = ddEl("div", "voice-row-choice");
    choice.setAttribute("role", "radio");
    choice.setAttribute("aria-checked", selected ? "true" : "false");
    choice.dataset.voiceId = id;
    /* The display name, for the arrow keys: `moveVoiceChoice` selects a
       NEIGHBOUR and must announce it by name like a click does. */
    choice.dataset.voiceName = name;
    choice.tabIndex = tabStop ? 0 : -1;
    choice.append(text);
    choice.addEventListener("click", () => selectVoiceRow(id, name));
    choice.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectVoiceRow(id, name); return; }
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (step) { e.preventDefault(); moveVoiceChoice(id, step); }
    });
    row.append(choice);

    const btn = ddEl("button", "voice-row-audition", voiceState.auditioning === id ? "Playing\u2026" : "Preview");
    btn.type = "button";
    btn.disabled = voiceState.auditioning === id;
    /* Named with the voice: five identical "Preview" buttons tell a screen
       reader nothing about which voice each one speaks in. */
    btn.setAttribute("aria-label", `Preview ${name}`);
    btn.addEventListener("click", (e) => { e.stopPropagation(); return auditionVoiceRow(id); });
    row.append(btn);
  } else {
    row.append(text);
    /* NO OPEN SETTINGS BUTTON HERE, deliberately — confirmed by reading
       `@capacitor/app@8.1.1`'s own `AppPlugin` interface
       (`mobile/node_modules/@capacitor/app/dist/esm/definitions.d.ts`):
       `exitApp`, `getInfo`, `getState`, `getLaunchUrl`, `minimizeApp`,
       `getAppLanguage`, `toggleBackButtonHandler`, `addListener`,
       `removeAllListeners` — nothing that opens Settings. A button whose
       label promises an action the shipped shell cannot perform is worse
       than no button: the path text below is the ONLY thing this row can
       honestly offer a listener today. Wiring a real native "open Settings"
       call needs a small addition to a Capacitor plugin
       (`mobile/plugins/foray-audio` or a new one) — out of this card's
       owned files (`app.js`/`player/`/`test/` only) — and is a follow-up
       card's job, not a silently-swallowed `.catch()` in this one. */
  }
  return row;
}

function paintVoiceNotice(text) {
  const ui = voiceSheet();
  ui.notice.textContent = text || "";
  ui.notice.hidden = !text;
}

/** Which identifier the sheet paints as chosen: the stored/session choice
    from `currentVoice()`, else (when nothing is stored) the same default
    rule narration uses (`player/default-voice.js`, re-exported as
    `ForayPlayer.defaultVoice`), applied to THIS list. One rule, two readers;
    a page-side copy of "Samantha's best tier" would be the second opinion
    `voiceQualityLabel`'s comment already refuses to hold about tiers. */
function selectedVoiceId(player) {
  if (!player) return null;
  const chosen = typeof player.currentVoice === "function" ? player.currentVoice() : null;
  if (chosen) return chosen;
  return typeof player.defaultVoice === "function" ? player.defaultVoice(voiceState.voices) : null;
}

function paintVoiceList() {
  const ui = voiceSheet();
  const player = window.ForayPlayer;
  const selected = selectedVoiceId(player);
  voiceState.selected = selected;

  const rows = [];
  let anyMissing = false;
  const curated = curateVoices(voiceState.voices);
  /* The group's one tab stop: the chosen voice, or the first when none is. */
  const stopId = curated.some((e) => e.installed && e.installed.identifier === selected)
    ? selected
    : (curated.find((e) => e.installed)?.installed.identifier ?? null);
  for (const entry of curated) {
    const v = entry.installed;
    if (v) {
      rows.push(buildVoiceRow({
        installed: true,
        name: entry.name,
        /* No "unknown language" piece: a fact the plugin did not report is
           left out, not printed as a shrug (audit round 2, copy-12). */
        sub: [entry.about, voiceQualityLabel(v), v.language].filter(Boolean).join(" \u00b7 "),
        id: v.identifier,
        selected: v.identifier === selected,
        tabStop: v.identifier === stopId,
      }));
      continue;
    }
    /* Web Speech (`path: "web-speech"`) has no install state at all: no
       greyed section, no Open Settings button, per the design comment. Only
       a native path (`"native"`) can honestly say "not downloaded". */
    if (voiceState.path !== "native") continue;
    anyMissing = true;
    rows.push(buildVoiceRow({
      installed: false,
      name: entry.name,
      sub: `${entry.about} \u00b7 Not downloaded \u2014 ${VOICE_SETTINGS_PATH}`,
    }));
  }

  /* THE REBUILD MUST NOT THROW THE LISTENER OUT OF THE SHEET (audit
     2026-09-22). Every select and every Audition repaints this list, which
     destroyed the row or button that had just been activated — focus fell to
     <body>, behind the scrim, and a keyboard or screen-reader user had to find
     their way back into the dialog from the top of the document after every
     single action. Remember what had focus, by voice, and put it back on the
     same voice's row (or its Audition button, unless that is now disabled
     while it plays). */
  const had = document.activeElement;
  const hadRow = had && typeof ui.list.contains === "function" && ui.list.contains(had)
    && typeof had.closest === "function" ? had.closest("[data-voice-id]") : null;
  const focusVoice = hadRow ? hadRow.dataset.voiceId : null;
  /* An Audition press rebuilds the button DISABLED while it plays, so focus
     waits on the row; `returnToAudition` remembers to take it back to the
     button on the repaint that re-enables it. */
  const focusAudition = !!(had && had.classList && had.classList.contains("voice-row-audition"))
    || (focusVoice != null && voiceState.returnToAudition === focusVoice);
  voiceState.returnToAudition = null;

  if (ui.missingNote) ui.missingNote.hidden = !anyMissing || voiceState.loading;
  ui.list.innerHTML = "";
  if (voiceState.loading) {
    ui.list.append(ddEl("p", "voice-loading", "Looking for voices\u2026"));
  } else if (!rows.length) {
    ui.list.append(ddEl("p", "voice-loading",
      voiceState.voices.length
        ? "None of the voices 4a suggests are installed on this device."
        : "No voices reported by this device."));
  } else {
    rows.forEach((r) => ui.list.append(r));
  }
  if (focusVoice) {
    const row = rows.find((r) => r.dataset.voiceId === focusVoice);
    const btn = row && focusAudition ? row.querySelector(".voice-row-audition") : null;
    if (btn && btn.disabled) voiceState.returnToAudition = focusVoice;
    /* The row is a plain container since L4; the radio inside it is what takes focus. */
    const choice = row && typeof row.querySelector === "function" ? row.querySelector(".voice-row-choice") : null;
    focusQuietly(btn && !btn.disabled ? btn : (choice || row));
  }
}

/* THE NEWEST ASK WINS (audit round 3, app-3-10). openVoiceSheet and the
   return-to-app refresh can overlap, and whichever listVoices() answered LAST
   won -- the older one included, so a voice just downloaded in Settings could
   vanish from the list again. Only the latest call writes. */
let voiceRefreshSeq = 0;
async function refreshVoiceList() {
  const player = window.ForayPlayer;
  if (!player || typeof player.listVoices !== "function") return;
  const seq = ++voiceRefreshSeq;
  voiceState.loading = true;
  paintVoiceList();
  try {
    const out = await player.listVoices({ lang: VOICE_LIST_LANG });
    if (seq !== voiceRefreshSeq) return;
    voiceState.voices = (out && out.voices) || [];
    voiceState.path = (out && out.path) || "none";
  } catch (_) {
    if (seq !== voiceRefreshSeq) return;
    voiceState.voices = [];
    voiceState.path = "none";
  } finally {
    if (seq === voiceRefreshSeq) {
      voiceState.loading = false;
      paintVoiceList();
    }
  }
}

function selectVoiceRow(id, name) {
  const player = window.ForayPlayer;
  if (!player || typeof player.setNarrationVoice !== "function") return;
  player.setNarrationVoice(id);
  logEvent("voice_pref", { voice: id });
  /* Said, not only shown: the notice is the sheet's polite live region, so the
     choice is announced — a radio that changes with no word is a silent
     change to how 4a narrates. */
  paintVoiceNotice(name ? `${name} selected.` : "");
  paintVoiceList();
}

/** Arrow keys in the voice radio group: select the neighbour (a native radio
    group selects on arrow, so this does too) and put focus back on it, since
    selecting repaints the list and the old node is gone. Wraps at the ends. */
function moveVoiceChoice(id, step) {
  const ui = voiceSheet();
  const ids = [...ui.list.querySelectorAll(".voice-row-choice")].map((c) => c.dataset.voiceId);
  const at = ids.indexOf(id);
  if (at < 0 || ids.length < 2) return;
  const next = ids[(at + step + ids.length) % ids.length];
  const target = [...ui.list.querySelectorAll(".voice-row-choice")].find((c) => c.dataset.voiceId === next);
  /* WITH ITS NAME (review 2026-09-23, an integration seam): selectVoiceRow
     grew a `name` so a choice is announced ("Samantha selected."), and this
     one-argument call wrote "" instead — the arrow keys, the path added for
     keyboard and screen-reader users, were the one path that wiped the notice. */
  selectVoiceRow(next, target?.dataset.voiceName || "");
  if (target && typeof target.focus === "function") target.focus();
}

/** V-01's Audition: speak the fixed counting line, in this row's voice, at
    1x — the speed every synthesized narration line is spoken at since the
    founder's 2026-09-24 ruling ("1x for now, but maybe we change later"), so
    the Preview sounds like the narration it previews. It used to speak at the
    current playback speed, doubling as H3's stopwatch test of the rate curve
    above 1x; narration no longer uses that part of the curve. The speed is
    `player/client.js`'s `auditionVoice`, not this function's. Guarded the
    same way every Foray tap is (#225): a rejected promise here must not
    become a console line nobody has open. */
/* ONLY THE LATEST PREVIEW OWNS THE ROW (audit round 3, app-3-10). A Preview
   tapped on Daniel while Samantha's was still speaking set auditioning to
   Daniel; Samantha's promise then settled (or was cut off) and its finally
   cleared auditioning and repainted, so Daniel's button read "Preview" again
   while he spoke, and the first run's notice could overwrite the second's. */
let auditionSeq = 0;
async function auditionVoiceRow(id) {
  const player = window.ForayPlayer;
  if (!player || typeof player.auditionVoice !== "function") return;
  const seq = ++auditionSeq;
  voiceState.auditioning = id;
  paintVoiceList();
  try {
    const result = await player.auditionVoice(AUDITION_LINE, id);
    if (seq !== auditionSeq) return;
    /* Native mode: the engine owns the one audio session and will not speak
       over an episode it is playing (NE-22, OQ-5). */
    if (result && result.ok === false && result.reason === "engine-busy") {
      paintVoiceNotice("Pause playback to preview");
    } else if (result && result.ok === false && result.reason === "narration-loaded") {
      /* Web player: a preview would cut the narrator's line off, paused or
         not (player/client.js auditionVoice), so pausing would not help. */
      paintVoiceNotice("Preview is unavailable while the narrator is on a line.");
    } else if (result && result.voiceFallback) {
      paintVoiceNotice("Your chosen voice isn't installed; using the best available.");
    } else {
      paintVoiceNotice("");
    }
  } catch (_) {
    if (seq !== auditionSeq) return;
    paintVoiceNotice("That voice could not be auditioned. Try again.");
  } finally {
    if (seq === auditionSeq && voiceState.auditioning === id) {
      voiceState.auditioning = null;
      paintVoiceList();
    }
  }
}

function openVoiceSheet() {
  const ui = voiceSheet();
  paintVoiceNotice("");
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeVoiceSheet });
  refreshVoiceList();
}

function closeVoiceSheet() {
  if (!voiceUi) return;
  closeSheet(voiceUi.root);
  voiceUi.root.hidden = true;
}

/** Appended to the drawer at startup, after the listener's switches and
    directly above the Developer group (see `init()`), so it is a listener
    setting among listener settings and never below "Delete my data". Bound
    once. */
function bindVoiceControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#voice-open")) return;
  const btn = ddEl("button", "drawer-item as-btn", "Narration voice");
  btn.type = "button";
  btn.id = "voice-open";
  drawer.appendChild(btn);
  btn.addEventListener("click", openVoiceSheet);

  const ui = voiceSheet();
  ui.close.addEventListener("click", closeVoiceSheet);
  ui.scrim.addEventListener("click", closeVoiceSheet);

  /* Refresh on return, per the card: a voice downloaded in Settings must
     appear without the listener having to close and reopen the sheet. Only
     while the sheet is actually open — a background tab re-resolving voices
     for a sheet nobody can see would be wasted work every single time the
     app regains focus. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!voiceUi || voiceUi.root.hidden) return;
    refreshVoiceList();
  });
}

/* ---------- playback diagnostics (#264) ----------

   THE ENTIRE POINT OF THIS SURFACE IS WHERE IT CAN BE READ. The record it shows
   exists because two founder reports came out of a car with no numbers in them,
   and the instrument that was supposed to carry those numbers wrote them to
   `console.warn` — "a console line nobody has open", in `player/client.js`'s own
   words. So this is a drawer item and a sheet: reachable on a phone, in a car,
   with no devtools, and copyable.

   READ-ONLY AND LOCAL. There is no network call anywhere below, by design and not
   by omission — `cp_diag` is deliberately outside the `cp_events` pipeline, which
   has no consent gate (`player/diagnostic-log.js`'s header carries the argument).
   `test/diagnostics-surface.test.js` asserts that, because "we forgot to add it to
   the sync" and "it must never be in the sync" look identical in a diff.

   The text itself is rendered by `formatDiagnosticReport` in the player module, not
   here: app.js is a classic script and cannot import it, so it arrives over
   `window.forayDiagnosticReport` exactly as the storage health record does. Built
   with createElement/textContent like the delete sheet above, for the same two
   reasons — the CSP is strict, and `index.html` is outside the auto-merge
   allowlist. */
let diagUi = null;

const DIAG_SUB =
  "Technical details about how audio played on this device. "
  + "Stored here only, never sent anywhere. "
  + "Copy this into a bug report if asked for it.";

function buildDiagSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "diag-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel diag-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Playback diagnostics");
  title.id = "diag-title";
  panel.setAttribute("aria-labelledby", "diag-title");

  /* A readonly <textarea> and not a <pre>, and that is the phone decision. A long
     <pre> on iOS gives a tap-and-hold selection that stops at the visible box; a
     textarea's Select All takes the whole record, scrolls inside its own frame,
     and cannot be edited into something that misreports what was measured. */
  const text = ddEl("textarea", "diag-text");
  text.id = "diag-text";
  text.setAttribute("readonly", "readonly");
  text.setAttribute("spellcheck", "false");
  text.setAttribute("aria-labelledby", "diag-title");

  const actions = ddEl("div", "fy-sheet-actions");
  const close = ddEl("button", "fy-sheet-cancel", "Close");
  close.type = "button";
  const copy = ddEl("button", "fy-sheet-go diag-copy", "Copy");
  copy.type = "button";
  actions.append(close, copy);

  /* Clear is the founder's loop: clear, drive, copy. Three earlier drives in a
     200-entry ring make the drive under test hard to find. It is destructive only
     of diagnostics, so it does not carry the delete sheet's typed confirmation —
     but it is set apart from Copy so a mis-hit does not land on it. */
  const clear = ddEl("button", "diag-clear", "Clear the record");
  clear.type = "button";

  const status = ddEl("p", "dd-status");
  status.id = "diag-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(
    ddEl("div", "fy-grab"), title,
    ddEl("p", "fy-sheet-sub", DIAG_SUB),
    text, actions, clear, status,
  );
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, text, copy, clear, close, status };
}

function diagSheet() {
  if (!diagUi) diagUi = buildDiagSheet();
  return diagUi;
}

/** The record, or an honest sentence about why there is not one. A blank box is
    the one answer this surface must never give: it reads as "nothing went wrong"
    when it can also mean "the player module never loaded". */
function diagText() {
  if (typeof window.forayDiagnosticReport !== "function") {
    return "The player module has not loaded on this page, so there is no record to show. "
      + "Play something and open this again.";
  }
  try {
    const out = String(window.forayDiagnosticReport() || "");
    return out || "Nothing recorded yet. Play a foray and come back.";
  } catch (err) {
    return `The record could not be read: ${err && err.message ? err.message : String(err)}`;
  }
}

/* NE-26 (docs/native-engine-plan.md): the record WITH the native engine's rows
   merged in — the page's ring and the engine's 2,000-row file ring, by wall
   clock, under one header that says which engine played. It needs one bridge
   call (engineRead 'diagnostics'), so it is a promise, and the synchronous
   `diagText()` above stays the instant answer and the fallback. Null when the
   player module has not published it (an older module, or none at all). */
function diagTextWithEngine() {
  if (typeof window.forayDiagnosticReportWithEngine !== "function") return null;
  let pending;
  try {
    pending = Promise.resolve(window.forayDiagnosticReportWithEngine());
  } catch (err) {
    pending = Promise.reject(err);
  }
  /* A merged report that failed is not a blank box either: the page's own
     record, and its own honest sentence, are what `diagText()` gives. */
  return pending.then((out) => String(out || "") || diagText(), () => diagText());
}

/* Which paint of the box is current. A merged report lands a bridge call
   later, and by then the listener may have pressed Clear or closed the sheet;
   a late answer must not paint cleared rows back into the box. */
let diagPaint = 0;

function refreshDiagSheet() {
  const ui = diagSheet();
  diagPaint++;
  ui.text.value = diagText();
}

function openDiagSheet() {
  const ui = diagSheet();
  refreshDiagSheet();
  ui.status.textContent = "";
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeDiagSheet });
  /* The page's record shows at once; the engine's rows join it when the one
     read answers, so the header a founder reads on screen is the one Copy
     takes. */
  const paint = diagPaint;
  const merged = diagTextWithEngine();
  if (merged) {
    merged.then((text) => {
      if (paint === diagPaint && !ui.root.hidden) ui.text.value = text;
    });
  }
}

function closeDiagSheet() {
  if (!diagUi) return;
  diagPaint++;
  closeSheet(diagUi.root);
  diagUi.root.hidden = true;
}

/**
 * Put the record on the clipboard.
 *
 * Two paths, because the async Clipboard API is not available everywhere this
 * app runs — it needs a secure context, and WKWebView has historically refused
 * it. The fallback selects the whole record so the listener's own Copy gesture
 * takes all of it rather than the visible box, and the status line SAYS which
 * happened. A copy that silently did nothing is worse than one that asks.
 */
async function copyDiagnostics() {
  const ui = diagSheet();
  /* NE-26: Copy takes the record with the engine's rows merged in, read ONCE,
     now — not whatever the box held when it opened — and shows what it took.

     THE CLIPBOARD IS ASKED INSIDE THE TAP. The merged text is a bridge call
     away, and WebKit grants clipboard writes only within the user's gesture; a
     writeText after that await can be refused as outside it. A ClipboardItem
     whose content is a PROMISE is WebKit's own answer to exactly this: the
     write is requested synchronously, and the text fills it when it resolves.
     Where that is missing, the text is awaited and written the old way, and a
     refusal falls through to selection as it always has. */
  const merged = diagTextWithEngine();
  if (merged) {
    diagPaint++;
    const paint = diagPaint;
    const clip = navigator.clipboard;
    if (clip && typeof clip.write === "function" && typeof ClipboardItem === "function" && typeof Blob === "function") {
      try {
        const wrote = clip.write([new ClipboardItem({
          "text/plain": merged.then((text) => new Blob([text], { type: "text/plain" })),
        })]);
        const text = await merged;
        if (paint === diagPaint) ui.text.value = text;
        await wrote;
        ui.status.textContent = "Copied to the clipboard.";
        return true;
      } catch (_) { /* fall through: the text is in the box, and writeText or selection takes it */ }
    }
    const text = await merged;
    if (paint === diagPaint) ui.text.value = text;
  }
  const body = ui.text.value;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(body);
      ui.status.textContent = "Copied to the clipboard.";
      return true;
    }
  } catch (_) { /* fall through to selection: a refused clipboard is not an error */ }
  try {
    ui.text.focus();
    if (typeof ui.text.select === "function") ui.text.select();
  } catch (_) { /* nothing left to try */ }
  ui.status.textContent = "The record is selected. Use your device's copy to take it.";
  return false;
}

function clearDiagnostics() {
  const ui = diagSheet();
  if (typeof window.forayDiagnosticClear === "function") {
    try {
      window.forayDiagnosticClear();
      refreshDiagSheet();
      ui.status.textContent = "Cleared. The next thing you play starts a fresh record.";
      return true;
    } catch (_) { /* fall through to the honest message */ }
  }
  ui.status.textContent = "There is nothing to clear on this page.";
  return false;
}

/** Appended at startup to the Developer group, which sits ABOVE "Delete my
    data" — see the note in `init()`. Bound once, like the control below it. */
function bindDiagnosticsControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#diag-open")) return;
  const btn = ddEl("button", "drawer-item as-btn", "Playback diagnostics");
  btn.type = "button";
  btn.id = "diag-open";
  (drawerDevGroup() || drawer).appendChild(btn);
  btn.addEventListener("click", openDiagSheet);

  const ui = diagSheet();
  ui.close.addEventListener("click", closeDiagSheet);
  ui.scrim.addEventListener("click", closeDiagSheet);
  ui.copy.addEventListener("click", () => copyDiagnostics());
  ui.clear.addEventListener("click", () => clearDiagnostics());
}

/** Appended to the drawer at startup. Bound once — `init()` is the only caller,
    and a second call must not stack a second button or a second listener. */
function bindDeleteControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#delete-data")) return;
  const btn = ddEl("button", "drawer-item as-btn dd-open", "Delete my data");
  btn.type = "button";
  btn.id = "delete-data";
  drawer.appendChild(btn);
  btn.addEventListener("click", openDeleteSheet);

  const ui = deleteSheet();
  ui.input.addEventListener("input", syncDeleteCta);
  ui.cancel.addEventListener("click", closeDeleteSheet);
  ui.scrim.addEventListener("click", closeDeleteSheet);
  ui.go.addEventListener("click", () => deleteMyData());
  ui.deviceOnly.addEventListener("click", () => deleteMyData({ deviceOnly: true }));
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
  else if (h === "#/create") renderCreate();
  else if (h === "#/forays") renderForays();
  else if (h === "#/queue") renderQueue();
  else if (h === "#/library") renderLibrary();
  else if (h === "#/starred-shows") renderStarredShows();
  else if (h === "#/interests") renderInterests();
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
  openDrawer(false);
  /* A NAVIGATION closes whatever modal was up — a back gesture over a sheet
     used to leave it stranded over a different page (the speed menu, the
     delete sheet) — through each sheet's own close, so a sheet that must not
     vanish (Delete my data mid-delete) still refuses. Only when the hash
     actually changed: route() is also how a settings toggle or a finished
     deletion re-renders the page UNDER an open sheet on purpose. */
  if (h !== previousHash) closeAllSheets();
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
  const box = view.querySelector(".page-head");
  return (box && box.querySelector("h2")) || null;
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
  const lost = !active || active === document.body || active.isConnected === false
    || !!(typeof active.closest === "function" && active.closest("#drawer"));
  if (lost) {
    const greeting = home && view && typeof view.querySelector === "function" ? view.querySelector(".hv2-greeting") : null;
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

/* The one normalisation of the hash every route decision reads. THREE
   SPELLINGS OF HOME ("", "#", "#/") rendered the same page and were three
   different things to everything else: tabForHash lit no tab for two of them,
   and on a bare URL the Home tab's `#/` was a real hash change, so the first
   Home tap of every session pushed an entry and the next back press did
   nothing (audit 2026-09-22). init() also rewrites a bare arrival to `#/` in
   place, so the address the history holds agrees with this. */
function currentHash(hash = location.hash) {
  return !hash || hash === "#" ? "#/" : hash;
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
  const rails = view && typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(".hv2-hscroll")] : [];
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
  const rails = view && typeof view.querySelectorAll === "function" ? [...view.querySelectorAll(".hv2-hscroll")] : [];
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
     deliberately NOT re-indented, so this change stays a few lines. */
  try {
  await waitForStorage();
  const directory = forayDirectoryBridge();
  if (directory && !pinnedDeployId) {
    try { directory.start({ localPointerUrl: pinnedUrl(FORAY_DIRECTORY_POINTER) }); } catch (_) { /* seed only */ }
  }
  [
    state.validated, state.taxonomy, state.discover,
    state.forays, state.segments, state.segmentSources, state.catalog,
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

  bindDrawerChrome();
  /* Android's back button, ordered like every other overlay close — see
     `handleBack`. A no-op on the web and on iOS. */
  bindHardwareBack();
  $("#view").addEventListener("click", onBackClick);
  $("#view").addEventListener("click", onForayScriptClick);   // once — see its header
  /* The listener's settings switches, in one call — see `bindDrawerToggles`.
     They land ABOVE everything bound below, so "Delete my data" stays last where
     a scrolled thumb expects it. */
  bindDrawerToggles();
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

init();

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

if ("serviceWorker" in navigator && shouldRegisterServiceWorker(window)) {
  /* AFTER THE FIRST PAINT (round-2 audit, perf-4). Registered here, at script
     end, the worker's install — every file in the manifest — ran while init()
     was still fetching the boot documents, on the first visit of every
     listener. It waits for the first page and then for an idle moment. */
  firstPagePainted.then(() => whenIdle(() => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* progressive */ });
  }));
  /* Feature-detected rather than assumed: `navigator.serviceWorker` is somebody
     else's object, and a page that threw here would lose everything below it. */
  if (typeof navigator.serviceWorker.addEventListener === "function") {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e && e.data;
      if (!msg || msg.source !== "foray-sw") return;
      /* By the time this fires, `pinnedDeployId` is already set synchronously
         (see the top of this file) if this load fell back at all — this
         assignment is now a REDUNDANT confirmation, not the establishing
         write, kept only as a safety net for a message that legitimately
         arrives with a different id than the synchronous read found (there is
         no such path today, but it costs nothing and a future one should not
         have to remember this). A `deployId` of null (an unretained/unknown
         generation on the worker's side) intentionally does not clear an
         already-set pin — see sw.js's `handleData` fail-safe for the matching
         reasoning.

         `pin: false` (round-3 audit, app-3-5) is a fallback of a file that does
         not read data (search-engine.js, a player module) while this app.js
         may well be live: the notice goes up, the pin does not, or new code
         would be paired with the previous generation's data. A worker from
         before that field sends none, which keeps the old meaning (pin). */
      /* "generation-changed" is broadcast to every open page on each
         promotion (round-3 audit, app-3-3). A page that is not pinned and
         already runs the announced deploy loaded it live and is current:
         telling it "one version behind" was false after every deploy, and the
         bar covers the Foray transport. A pinned page, or one that cannot
         name its own deploy, is still told. */
      if (msg.reason === "generation-changed" && !pinnedDeployId && pageDeployId && msg.deployId === pageDeployId) return;
      const adoptsPin = msg.reason === "stale-shell" && msg.pin !== false;
      if (adoptsPin && msg.deployId) pinnedDeployId = msg.deployId;
      /* FD-01: the web's pinned-generation path records the same fact the shell's
         boot row does — where the documents came from, and which deploy id. */
      if (adoptsPin) {
        const tag = `sw-cache@${pinnedDeployId || "unknown"}`;
        noteDataSource({
          phase: "stale-shell", source: "sw-cache", version: pinnedDeployId || "unknown",
          files: { forays: tag, segments: tag, sources: tag },
        });
      }
      showShellNotice(msg.reason);
    });
  }
}
