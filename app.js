/* Foray web client v4 — app shell.
   Views: home (one screen, no scroll: continue banner + 4 suggestions +
   playlist builder), playlists list, playlist detail. Hash routing.
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
 *      one) — covers the case where index.html/search-engine.js fell back but
 *      this file's own fetch was fresh.
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
const CONTINUE_MAX_AGE_H = 72;

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
const STORAGE_WAIT_MS = 5000;

function waitForStorage() {
  if (window.forayStorage) return Promise.resolve(window.forayStorage);
  if (typeof window.addEventListener !== "function") return Promise.resolve(null);
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(window.forayStorage || null); } };
    window.addEventListener("forayplayer:ready", finish, { once: true });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", finish, { once: true });
    } else {
      // Parsing already finished, so every deferred module has run. Either the
      // store is here (handled above) or it is never arriving.
      finish();
    }
    setTimeout(finish, STORAGE_WAIT_MS);
  });
}

async function storageReady() {
  const store = await waitForStorage();
  if (!store || typeof store.hydrate !== "function") return null;
  try {
    await Promise.race([
      store.hydrate(),
      new Promise(resolve => setTimeout(resolve, STORAGE_WAIT_MS)),
    ]);
  } catch (_) { /* every tier failure is already recorded in health() */ }
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

function logEvent(type, payload) {
  const row = { ts: new Date().toISOString(), type, builder: state.session?.builder || "unknown", profile: profileId(), payload };
  if (window.forayEventLog && typeof window.forayEventLog.append === "function") {
    flushBufferedEvents();
    window.forayEventLog.append(row);
  } else {
    _bufferedEvents.push(row);
  }
}

/** Hand the pre-module buffer to `window.forayEventLog` the moment it exists.
    Called from `logEvent` itself (the module may have arrived between two
    calls) and once from `init()` after `waitForStorage()` settles, matching
    how `player/client.js` publishes both bridges off the same
    `forayplayer:ready` event. */
function flushBufferedEvents() {
  if (!_bufferedEvents.length) return;
  if (!window.forayEventLog || typeof window.forayEventLog.append !== "function") return;
  const rows = _bufferedEvents;
  _bufferedEvents = [];
  for (const row of rows) window.forayEventLog.append(row);
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

async function sbAuth(path, body) {
  try {
    const res = await fetch(SB_URL + path, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
}

/* Establish/restore the anonymous session. Refresh a stored token (same user)
   when possible; only create a NEW anonymous user when there's no token or the
   refresh fails — re-signing-up every load would orphan a user per visit. */
async function ensureAnonSession() {
  const now = Math.floor(Date.now() / 1000);
  let s = lsGet("cp_sb_session", null);
  if (s && s.access_token && s.expires_at && s.expires_at - 60 > now) return s;
  if (s && s.refresh_token) {
    const r = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    if (r && r.access_token) {
      s = { user_id: r.user.id, access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || now + 3600 };
      lsSet("cp_sb_session", s);
      return s;
    }
  }
  const r = await sbAuth("/auth/v1/signup", {});
  if (r && r.access_token) {
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
      return null; // unsaved / playlist_* / family_mode / player_pref / refreshed_all — local only
  }
}

async function trySyncEvents() {
  try {
    if (!window.forayEventLog || typeof window.forayEventLog.unsynced !== "function") return;
    flushBufferedEvents();
    const unsynced = await window.forayEventLog.unsynced();
    if (!unsynced.length) return;
    const s = await ensureAnonSession();
    if (!s) return; // offline / auth unavailable — buffer persists, retry next time
    const rows = unsynced.map(e => toEventRow(e, s.user_id)).filter(Boolean);
    const syncedIds = unsynced.map(e => e.id);
    if (!rows.length) {
      await window.forayEventLog.markSynced(syncedIds); // all local-only
      await window.forayEventLog.pruneToRetention(5000);
      return;
    }
    for (let i = 0; i < rows.length; i += 500) {
      const res = await fetch(SB_URL + "/rest/v1/events", {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: "Bearer " + s.access_token,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(rows.slice(i, i + 500)),
      });
      if (!res.ok) return; // don't advance the cursor — retry the whole batch next time
    }
    await window.forayEventLog.markSynced(syncedIds);
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
    state.interests[n.id] = saved[n.id] ?? Math.max(0, n.weight);
  });
}

function saveInterests() { lsSet("cp_interests", state.interests); }

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
      state.interests[t] = Math.max(0, Math.min(1, state.interests[t] + amount));
      const parent = nodeById(t)?.parent;
      if (parent && parent in state.interests && !directlyNudged.has(parent)) {
        parentsToPropagate.add(parent);
      }
    }
  });
  parentsToPropagate.forEach(parent => {
    state.interests[parent] = Math.max(0, Math.min(1, state.interests[parent] + amount * PARENT_NUDGE_RATIO));
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
      <span class="interest-row-path">${esc(node.id)}</span>
    </div>
    <div class="interest-row-controls">
      <input type="range" class="interest-slider" role="slider"
        min="0" max="1" step="0.01" value="${value}"
        data-interest-id="${esc(node.id)}"
        aria-label="${esc(node.label)} interest"
        aria-valuemin="0" aria-valuemax="1" aria-valuenow="${value}"
        aria-valuetext="${pct}%">
      <span class="interest-row-pct">${pct}%</span>
      <button type="button" class="interest-reset" data-interest-reset="${esc(node.id)}"
        ${value === Math.max(0, node.weight) ? "disabled" : ""}>Reset to learned</button>
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
        <div><h2>Interests</h2><p class="sub">Drag a slider to overrule what 4a has learned</p></div>
      </div>
      ${groups.map(g => `
        <div class="interest-group">
          <h3 class="interest-group-label">${esc(g.root.label)}</h3>
          ${g.rows.map(interestSliderRow).join("")}
        </div>`).join("")}
    </div>`;
  bindInterestsControls($("#view"));
}

function bindInterestsControls(scope) {
  scope.querySelectorAll("[data-interest-id]").forEach(input => {
    if (input._bound) return;
    input._bound = true;
    const id = input.dataset.interestId;
    const apply = () => {
      const v = Math.max(0, Math.min(1, Number(input.value)));
      state.interests[id] = v;
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
      state.interests[id] = Math.max(0, node.weight);
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
   nothing ever clears it, and three different callers write to it — fullPool,
   bannerHtml, and renderPlaylistDetail seeding a part the pool no longer has. So
   "has an entry in itemIndex" drifts to "was mentioned at some point this
   session", which made an aged-out playlist part read as live from its second
   render onward and silently restored the exact defect #276 removes. Membership
   is rebuilt from scratch on every pool build, so it cannot accumulate. */
function fullPool() {
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(state.session.episodes)) {
    pool.push(snapshot(id, episode(id)));
    seen.add(id);
  }
  for (const item of (state.discover?.items || [])) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    pool.push(snapshot(item.id, item));
  }
  state.poolIds = seen;
  return pool;
}

function appleLink(item) {
  const cid = item.apple_collection_id;
  return item.apple_episode_url
    || (item.apple_track_id
        ? `https://podcasts.apple.com/us/podcast/id${cid}?i=${item.apple_track_id}`
        : `https://podcasts.apple.com/us/podcast/id${cid}`);
}

/* Player preference: Apple deep-links to the episode; Pocket Casts has no
   public episode-URL scheme, so it lands on the show page (verified via
   data/app-links.json research). */
function playerPref() { return lsGet("cp_player", "apple"); }

function playLink(item) {
  if (playerPref() === "pocketcasts") return `https://pca.st/itunes/${item.apple_collection_id}`;
  return appleLink(item);
}

/* In-app play button. Items with no audio_url keep the link-out to Apple
   Podcasts instead (#21 leaves ~9 unresolvable, plus video-only items) — the
   card itself stays a link either way, so nothing regresses for them.

   `ctx`, when given, is stamped on as `data-ctx` — the same "playlist-<id>"
   / "subject-<id>" / "generated-<id>" convention bindPickLogging already
   reads off a picked link's `data-ctx` (#558 item 2). It is optional and
   omitted by every non-playlist caller, so this changes nothing for them. */
function playBtn(item, ctx) {
  if (!item || !item.audio_url) return "";
  return `<button class="play-btn" data-play="${esc(item.id)}"${ctx ? ` data-ctx="${esc(ctx)}"` : ""} aria-label="Play ${esc(item.title)}">▶</button>`;
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
     fy-sheet-open the modal sheets, for as long as one is open.

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
const PERSISTENT_BODY_CLASSES = ["kb-open", "fp-open", "fp-expanded", "fy-sheet-open"];

function setBodyClass(base) {
  const body = document.body;
  const kept = PERSISTENT_BODY_CLASSES.filter((c) => body.classList.contains(c));
  body.className = [base, "ui-v2", ...kept].join(" ");
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

function failedNoteHtml(note) {
  return `<div class="load-failed" role="status">
    <p class="note">${note}</p>
    <button type="button" class="fy-btn load-retry" data-retry>${RETRY_LABEL}</button>
  </div>`;
}

function statusPageHtml({ title = "", note, back = "#/", retry = false }) {
  return `<div class="page">
    <div class="page-head">
      <a class="back" href="${esc(back)}">‹</a>
      <div>${title ? `<h2>${esc(title)}</h2>` : ""}</div>
    </div>
    ${retry ? failedNoteHtml(note) : `<p class="note">${note}</p>`}
  </div>`;
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
  return pool.filter(i => i.explicit !== true && branchOf(i) !== "comedy");
}

/* The visible half of the same flag Family Mode has quietly filtered on since
   corner-case 28 (kanban card t_02c6bb0b): every mainstream podcast app shows
   an "E" next to explicit content, and 4a never did, even though the
   publisher's <itunes:explicit> flag was captured all along. Additive only —
   Family Mode's `i.explicit !== true` filter above is untouched, this just
   makes the same field visible when Family Mode is off. Strict `=== true`
   because the field is tri-state (true/false/null) at both the episode and
   show level; false and null both mean "no badge", not "unknown = flag it". */
function explicitBadge(isExplicit) {
  return isExplicit === true ? `<span class="explicit-badge" title="Explicit content" aria-label="Explicit">E</span>` : "";
}

function fmtDur(min) {
  if (!min) return "";
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
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
   the one timezone every visitor and every CI runner agrees on. */
function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
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

/* ---------- stars ---------- */

function savedMap() { return lsGet("cp_saved", {}); }
function isSaved(id) { return id in savedMap(); }

function toggleStar(id) {
  const saved = savedMap();
  if (saved[id]) {
    delete saved[id];
    logEvent("unsaved", { episode_id: id });
  } else {
    const snap = state.itemIndex[id];
    if (!snap) return;
    saved[id] = { ...snap, saved_at: new Date().toISOString() };
    boostTopics(snap.topics, 0.05);
    logEvent("saved", { episode_id: id, topics: snap.topics });
  }
  lsSet("cp_saved", saved);
  document.querySelectorAll(`[data-star="${CSS.escape(id)}"]`).forEach(b => {
    b.textContent = isSaved(id) ? "★" : "☆";
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
  return `<button class="star ${on ? "on" : ""}" data-star="${esc(id)}" aria-label="Save">${on ? "★" : "☆"}</button>`;
}

/* "+ Up Next" row control (docs/listening-queue-plan.md Stage 1, plan §1 Q3).
   Additive to the row — sits beside starBtn/playBtn, never replaces either.
   Label is always "Up Next" (never bare "queue"), per plan §3. Once added the
   control shows a plain "in Up Next" state rather than disappearing, mirroring
   starBtn's on/off toggle so the row keeps giving feedback without navigating
   away — the plan's explicit "browse and add without losing your place" ask. */
function upNextBtn(id) {
  if (!id) return "";
  const on = isQueued(id);
  return `<button class="up-next ${on ? "on" : ""}" data-upnext="${esc(id)}"
    aria-label="${on ? "In Up Next" : "Add to Up Next"}">${on ? "✓ Up Next" : "+ Up Next"}</button>`;
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
function starredShowsMap() { return lsGet("cp_starred_shows", {}); }
function isShowStarred(id) { return id in starredShowsMap(); }

function toggleShowStar(id) {
  const starred = starredShowsMap();
  if (starred[id]) {
    delete starred[id];
    logEvent("show_unstarred", { show_id: id });
  } else {
    const show = showById(id);
    if (!show) return;
    starred[id] = {
      show_id: show.show_id,
      title: show.title,
      artwork_url: show.artwork_url || null,
      starred_at: new Date().toISOString(),
    };
    logEvent("show_starred", { show_id: id });
  }
  lsSet("cp_starred_shows", starred);
  document.querySelectorAll(`[data-show-star="${CSS.escape(id)}"]`).forEach(b => {
    b.textContent = isShowStarred(id) ? "★ Starred" : "☆ Star this show";
    b.classList.toggle("on", isShowStarred(id));
  });
}

/* Text label, not a bare glyph like starBtn -- this button sits alone in a
   page header rather than beside a play control in a dense row, so it needs
   to read on its own. */
function showStarBtn(show_id) {
  const on = isShowStarred(show_id);
  return `<button class="show-star ${on ? "on" : ""}" data-show-star="${esc(show_id)}" aria-label="${on ? "Unstar show" : "Star show"}">${on ? "★ Starred" : "☆ Star this show"}</button>`;
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
  return `<a class="show-result" href="#/show/${encodeURIComponent(entry.show_id)}">
    ${art ? `<img class="show-result-art" src="${esc(safeUrl(art))}" alt="">` : `<span class="show-result-art show-result-art-blank"></span>`}
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
        <a class="back" href="#/shows">‹</a>
        <div>
          <h2>Starred Shows</h2>
          <p class="sub">${starred.length} show${starred.length === 1 ? "" : "s"} you've starred</p>
        </div>
      </div>
      ${starred.length
        ? `<div class="show-results">${starred.map(starredShowRow).join("")}</div>`
        : `<p class="note">No starred shows yet — star a show from its page to see it here.</p>`}
    </div>`;
}

/* ---------- the four suggestions ---------- */

function pickedHistory() { return lsGet("cp_history", []); }

function rememberSeen(ids) {
  const seen = lsGet("cp_seen", []).filter(id => !ids.includes(id)).concat(ids);
  lsSet("cp_seen", seen.slice(-SEEN_WINDOW));
}

/* Freshness-ordered, unseen-first chain for one branch's candidate queue.
   Real release_date recency (present on 100% of the pool) replaces pure
   shuffle — a small honest slice of 03_CURATION_SPEC.md's real "freshness"
   scoring component, not faked from fields the client doesn't have (depth/
   format/evergreen only exist on the ~27-episode curated set, not the
   1000+-item discover pool — see docs/DECISIONS.md 2026-07-30). */
function branchChain(items, history, seen) {
  const byRecency = (a, b) => new Date(b.release_date || 0) - new Date(a.release_date || 0);
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
function buildCards() {
  const pool = poolFiltered();
  const history = new Set(pickedHistory());
  const seen = new Set(lsGet("cp_seen", []));
  const byBranch = {};
  pool.forEach(i => { (byBranch[branchOf(i)] = byBranch[branchOf(i)] || []).push(i); });

  const recentBranches = lsGet("cp_recent_branches", []);
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
  const stretchCandidates = byInterestDesc
    .filter(x => !topBranchIds.has(x.b))
    .sort((x, y) => (x.recentlyShown === y.recentlyShown ? y.avgInterest - x.avgInterest : x.recentlyShown ? 1 : -1));
  const stretchBranch = stretchCandidates[0]?.b ?? null;

  const topRanked = byInterestDesc
    .filter(x => x.b !== stretchBranch)
    .map(x => ({ b: x.b, s: x.avgInterest + (Math.random() - 0.5) * 0.5 - (x.recentlyShown ? 0.35 : 0) }))
    .sort((x, y) => y.s - x.s)
    .map(x => x.b);

  const chosenBranches = (stretchBranch ? [stretchBranch] : []).concat(topRanked).slice(0, 4);

  const QUEUE_SIZE = 3;
  state.cardSlots = chosenBranches.map((branch, i) => {
    const chain = branchChain(byBranch[branch], history, seen);
    return {
      slot: i + 1,
      branch,
      role: branch === stretchBranch ? "stretch" : "top",
      item: chain[0] || null,
      items: chain.slice(0, QUEUE_SIZE)
    };
  }).filter(sl => sl.item);

  lsSet("cp_recent_branches", recentBranches.concat(state.cardSlots.map(sl => sl.branch)).slice(-BRANCH_MEMORY));
  rememberSeen(state.cardSlots.flatMap(sl => sl.items.map(it => it.id)));
}

function subjectLabel(branch) {
  return (state.taxonomy?.nodes || []).find(n => n.id === branch && n.parent === null)?.label || branch;
}

/* Subject queues are today's auto-built groupings (state.cardSlots), distinct
   from user-saved playlists (cp_playlists) — same shape so renderPlaylistDetail
   can render either, but not persisted and not removable. */
function subjectQueueById(id) {
  const m = /^subject-(.+)$/.exec(id);
  if (!m) return null;
  const slot = (state.cardSlots || []).find(sl => sl.branch === m[1]);
  if (!slot) return null;
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
   playlist cards, so "Playlists for you" was "Episodes for you" regrouped.
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
function generatedPlaylistById(id) {
  if (!/^gen-/.test(String(id || ""))) return null;
  return generatedPlaylists().find(p => p.id === id) || null;
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

function prettyTitle(query) {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let words = raw.filter(w => !SearchEngine.STOPWORDS.has(w));
  if (!words.length) words = raw;
  words = words.slice(0, TITLE_MAX_WORDS).map(w => ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));

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
   is derivable: appleLink() already falls back to `id<collection>?i=<track>`
   without it. `hook` feeds the player's why-line, which only a live part
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
    touched = true;
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
  const ids = lsGet("cp_queue", []);
  /* A non-string/empty entry cannot be resolved against itemIndex or savedMap
     (both keyed by real episode ids), so it can only ever render as a
     permanently-broken row — dropping it here is not data loss, it is the
     same "nothing in it to lose" guard `playlists()` applies to a corrupt
     entry (line ~810 above). */
  return Array.isArray(ids) ? ids.filter(id => typeof id === "string" && id) : [];
}

function saveQueueIds(ids) { return lsSet("cp_queue", ids); }

function isQueued(id) { return !!id && queueIds().includes(id); }

/* Idempotent by design: tapping "+ Up Next" twice on the same row (a slow
   network re-render, a double-tap) must not duplicate the entry — the plan's
   UI never offers a way to remove a duplicate, so silently de-duping here is
   the only place that can hold that invariant. */
function addToQueue(id) {
  if (!id) return;
  const ids = queueIds();
  if (ids.includes(id)) return;
  saveQueueIds(ids.concat(id));
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

/* Same two-source resolution resolveParts() uses for a playlist part (line
   ~850 above): `state.poolIds` for whether the catalogue still carries this
   episode "live" (never `state.itemIndex` alone — see the comment on
   resolveParts for why that distinction is load-bearing, #276), then a
   `cp_saved` snapshot for one that has aged out but was starred, then a bare
   id for one that has neither — still a real row (archivedRow already
   renders an id-only part honestly), not a silently dropped one. */
/* Shared by queueRows() and the Library screen's Saved/History sections
   (`docs/ux/foray-mockup.jsx`'s LibraryScreen, kanban card t_a1e7a69c) — all
   three are "an id list plus this same three-way resolution", and having one
   definition means a fix to the liveness rule (see the comment above
   resolveParts, #276) cannot land in one caller and not the others. */
function rowsForIds(ids) {
  return ids.map(id => {
    const live = state.poolIds.has(id) ? state.itemIndex[id] : null;
    if (live) return { item: live, id, state: "live" };
    const saved = savedMap()[id];
    if (saved) return { item: saved, id, state: "archived" };
    return { item: { id }, id, state: "unnamed" };
  });
}

function queueRows() { return rowsForIds(queueIds()); }

/* ---------- Up Next auto-advance (docs/listening-queue-plan.md §4 addendum,
   kanban card t_b9880844) ----------

   CLAUDE.md product principle #1 explicitly bans "autoplay chains" as a dark
   pattern. This feature is a genuine, deliberate exception carved out of that
   rule for exactly one purpose — continuing a list the LISTENER built and
   ordered by hand — and it is scoped as narrowly as it can be to stay
   distinguishable from the pattern the principle bans:

     - DEFAULT OFF. `cp_autoadvance` is read with a `false` fallback, same as
       `cp_family`. A fresh install and a fresh page reload never runs an
       autoplay chain nobody asked for.
     - OPT-IN, ONE PER-DEVICE TOGGLE, no per-episode variant. See the drawer
       control (`autoadvance-toggle`), same pattern as `family-toggle`/
       `player-toggle`.
     - ONLY WHEN THE FINISHED EPISODE WAS PLAYED FROM #/queue. Starting an
       unrelated episode elsewhere in the app must never silently hijack it
       into "now playing the queue" — see `queuePlaybackOrigin` below. This is
       the addendum's answer to plan §4 Q1.
     - THE QUEUE NEVER LOOPS. Reaching the end stops cleanly and says so
       (`bannerHtml`-style toast is out of scope for Stage 1; the queue page's
       own count already reflects an empty list). No pulling in more content
       to keep going — that would be the "infinite scroll" half of principle
       #1, not just the "autoplay chains" half. */
function autoAdvanceOn() { return lsGet("cp_autoadvance", false); }

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

/* Set the instant a queue-originated play is dispatched (bindPlay below,
   guarded by `origin === "queue"`), read the instant an episode ends
   (advanceQueueOnEnded). Cleared whenever ANY play starts that is NOT from
   the queue, so playing an unrelated episode mid-list can never be read as
   "still playing the queue" by a slow finish event that arrives after. One
   flat field is enough — Stage 1 has exactly one player and one Up Next
   list, never two concurrent playback sessions to disambiguate between. */
function setQueuePlaybackOrigin(id) { state.queuePlaybackOrigin = id || null; }
function clearQueuePlaybackOrigin() { state.queuePlaybackOrigin = null; }
function isPlayingFromQueue(id) { return state.queuePlaybackOrigin === id; }

/** Called from `ForayPlayer.onEpisodeEnded` (player/client.js) with the id of
    the episode that just finished ordinary (non-Foray) playback.

    Runs unconditionally — the guards below, not the caller, decide whether
    anything happens — because the player module intentionally knows nothing
    about Up Next; it only reports "this finished playing" once per episode. */
function advanceQueueOnEnded(id) {
  const wasFromQueue = isPlayingFromQueue(id);
  clearQueuePlaybackOrigin();
  if (!autoAdvanceOn()) return;
  if (!wasFromQueue) return;
  const ids = queueIds();
  const i = ids.indexOf(id);
  // Not (or no longer) in the list — reordered/removed mid-playback (plan §4
  // Q4): freeze at what was queued when playback started, i.e. do nothing
  // rather than guess at a new position.
  if (i < 0) return;
  const nextId = ids[i + 1];
  // End of the queue: stop cleanly, no loop, no pulling in more content.
  if (!nextId) return;
  const nextItem = state.poolIds.has(nextId) ? state.itemIndex[nextId] : null;
  // The next item aged out of the live pool since it was queued (archived/
  // unnamed) — nothing playable to hand to the player. Stop rather than
  // skip past it silently; a listener who reordered/removed things mid-list
  // already gets the "freeze" behavior above for the same reason.
  if (!nextItem || !nextItem.audio_url || !window.ForayPlayer) return;
  setQueuePlaybackOrigin(nextId);
  window.ForayPlayer.play(nextItem, { why: whyFor(nextId, nextItem) }).then(ok => {
    if (!ok) { clearQueuePlaybackOrigin(); return; }
    logEvent("play_started", { episode_id: nextId, topics: nextItem.topics || [], ctx: "autoadvance" });
    const history = pickedHistory();
    if (!history.includes(nextId)) lsSet("cp_history", history.concat(nextId).slice(-200));
    trySyncEvents();
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
   only "the catalogue holds this right now". */
function resolveParts(p) {
  const spine = playlistSpine(p);
  return spine.map(part => {
    const id = part && part.id ? part.id : null;
    const live = id && state.poolIds.has(id) ? state.itemIndex[id] : null;
    if (live) return { item: live, part, state: "live" };
    if (part && part.title) return { item: part, part, state: "archived" };
    return { item: part || {}, part, state: "unnamed" };
  });
}

function playlistById(id) { return playlists().find(p => p.id === id); }

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
    return state.shardShowCache[id] || null;
  }
  return (state.catalog?.shows || []).find(s => s.show_id === id)
    || state.breadthShowCache[id]
    || null;
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
  return pool.filter(it => wanted.has(it.show))
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
  return s ? s.show_id : null;
}

/* The show-name text as a link to its show page, or plain escaped text when
   no show record joins (see showIdForShowName). Never returns an empty
   string for a truthy showName, so callers can drop it straight into the
   existing `${esc(item.show)}` slot without an extra guard. */
function showNameLink(showName) {
  const label = esc(showName || "");
  const showId = showIdForShowName(showName);
  return showId ? `<a class="show-link" href="#/show/${esc(showId)}">${label}</a>` : label;
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
function renderShowIndexPage(title, subtitle, shows, above = "") {
  setBodyClass("view-page");
  const list = shows === null
    ? `<div class="show-index-failed">${failedNoteHtml("Couldn't load the show list.")}</div>`
    : shows.length
      ? `<div class="show-results show-index">${shows.map(showResultRow).join("")}</div>`
      : `<p class="note">No shows here yet.</p>`;
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
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
  const catalog = await fetchJson("data/catalog-client.json");
  if (catalog) state.catalog = catalog;
  renderCurrentPage();
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
  renderShowIndexPage(label, `${shows.length} show${shows.length === 1 ? "" : "s"}`, shows);
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
  input.value = "";
  clearShowSearchResults();
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
  renderShowIndexPage("Shows", "", shows, `
      <div id="sh-compose">
        <form id="sh-form" autocomplete="off">
          <svg class="sh-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>
          <input id="sh-input" type="text" maxlength="120" placeholder="search shows by name\u2026">
        </form>
        <button id="sh-dismiss" type="button" aria-label="Clear search" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>
        </button>
      </div>
      <p id="sh-note" class="note" hidden></p>
      <div id="sh-empty-offer" hidden></div>
      <p id="sh-offline-note" class="note" hidden>Showing shows available offline</p>
      <div id="sh-results" class="show-results" hidden></div>
      <div id="ep-search-results" hidden></div>
      <div id="pl-search-results" hidden></div>
      <div id="sh-browse">
        ${browsePillsHtml()}
        <a class="page-link-row" href="#/starred-shows">Starred shows \u203a</a>
        ${vouchForHtml()}
      </div>`);
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
    const query = $("#sh-input").value.trim();
    if (!query) return;
    renderShowSearchResults(query);
  });

  /* A fresh render starts from the resting state: nothing focused, browse
     furniture showing. Without this a return to #/shows after leaving it
     mid-search would open with the catalogue already hidden.

     `#/shows/q/<q>` is the one arrival that is NOT resting: the field is
     seeded first so `updateShowBrowseVisibility`'s single predicate ("the
     field is focused OR holds a query") hides the browse furniture for the
     ordinary reason rather than through a second rule. */
  showSearchFieldFocused = false;
  if (query) {
    const seed = $("#sh-input");
    if (seed) seed.value = query;
  }
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
  }

  /* LAST, after every listener is bound, because this paints into the nodes
     above and then runs the same costly pass a submit would — a pass that can
     resolve at any point and must not land on a half-wired page. It is
     `renderShowSearchResults`, the SUBMIT path, verbatim: a tile IS a submit
     the listener did not have to type. */
  if (query) renderShowSearchResults(query);
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
function fullCatalogueRowToEpRowItem(show, ep) {
  const id = `${show.show_id}--${ep.guid}`;
  return snapshot(id, {
    show: show.title,
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

/** Cached first pages, `show_id -> { at, episodes, nextCursor, stale }`. */
const showEpisodesCache = new Map();

/** The cached first page, or null when absent or past its TTL. */
function cachedShowEpisodes(show_id) {
  const hit = showEpisodesCache.get(show_id);
  if (!hit) return null;
  if (Date.now() - hit.at > SHOW_EPISODES_TTL_MS) { showEpisodesCache.delete(show_id); return null; }
  return hit;
}

function cacheShowEpisodes(show_id, payload) {
  showEpisodesCache.set(show_id, { ...payload, at: Date.now() });
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
    const id = safeDecode(href.slice("#/show/".length));
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
       and it is the one that also covers the deeper pages. */
    const res = await fetch(apiUrl(url));
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
    <p class="show-forays-note">Not part of ${esc(show.title)}'s own catalogue — 4a stitched a clip from it into these.</p>
    ${forays.map(f => `<a class="show-forays-row" href="#/foray/${esc(f.id)}">
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
       refresh" is a failure the listener can act on (pull to refresh,
       come back on a better connection); silence about it would be a
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
       the same state. */
    return "Loading episodes…";
  }
  if (loadError && loadedCount === 0) {
    return curatedCount
      ? `${curatedCount} episode${curatedCount === 1 ? "" : "s"} in 4a's catalogue (couldn't load the full list)`
      : `Couldn't load this show's episodes right now.`;
  }
  if (loadedCount === 0) {
    return curatedCount
      ? `${curatedCount} episode${curatedCount === 1 ? "" : "s"} in 4a's catalogue`
      : isBreadthTier
        ? "No episodes found for this show yet."
        : "No episodes found for this show.";
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
function resolveMissingShow(show_id) {
  const view = $("#view");
  /* S-05: a `pi:` id has no fallback lookup at all — see showById's own
     header for why `api/shows/search?id=` (a different id space) can never
     answer one, and why that is correct today rather than a gap: no
     shard-index release is published yet. Rendering the honest empty state
     immediately, with no "Loading show…" flash for a fetch that would
     never have resolved this id anyway. */
  if (typeof show_id === "string" && show_id.startsWith("pi:")) {
    if (view) view.innerHTML = statusPageHtml({ note: "Show not found." });
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
    renderShow(show_id);
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
  if (view) view.innerHTML = statusPageHtml({ note: "Loading show…" });
  const wanted = `#/show/${show_id}`;
  fetchApiJson(`api/shows/search?id=${encodeURIComponent(show_id)}`).then((data) => {
    /* Navigated away while the row was in flight — repainting #view now would
       clobber whatever page the listener is actually on. Same "still mounted"
       rule renderShow's own episode fetch follows. */
    if (location.hash !== wanted) return;
    const v = $("#view");
    if (data === null) {
      if (v) {
        v.innerHTML = statusPageHtml({ note: "Couldn't load this show.", retry: true });
        bindRetry(v, () => resolveMissingShow(show_id));
      }
      return;
    }
    const row = data?.show || null;
    if (!row) {
      if (v) v.innerHTML = statusPageHtml({ note: "Show not found." });
      return;
    }
    state.breadthShowCache[show_id] = row;
    if (showById(show_id)) renderShow(show_id);
  }); // fetchApiJson swallows network/parse errors to null — the `data === null` branch above is that case
}

function renderShow(show_id) {
  setBodyClass("view-page");
  const show = showById(show_id);
  if (!show) { resolveMissingShow(show_id); return; }
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
    ${showArt ? `<img class="show-art" src="${esc(safeUrl(showArt))}" alt="">` : ""}
    ${showStarBtn(show.show_id)}
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
      <form data-show-ep-search-form autocomplete="off">
        <input data-show-ep-search-input type="text" maxlength="120" placeholder="Search this show's episodes…">
      </form>
      <p class="note" data-show-ep-search-note hidden></p>
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
  ${showForaysHtml(show)}
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
  let anyStale = false;     // sticky once any page reports stale/degraded
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
  let searchQuery = "";
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
  const stillMounted = () => !!container();

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
      c.innerHTML = `<p class="note">No episodes match "${esc(searchQuery.trim())}".</p>`;
      return;
    }
    const rows = visible.map((ep) => fullCatalogueRowToEpRowItem(show, ep));
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
     still does real work in showEpisodeCountLabel; it just no longer picks
     the listener's words. */
  /* `failed` offers "Try again" rather than "Pull to refresh" (audit
     2026-09-22): there is no pull gesture on this page, and a failure the
     listener cannot act on from where they are standing is a dead end. The
     button re-runs `loadEpisodes` below — the same fetch — through
     `failedNoteHtml`, the convention every failed list now shares. */
  const BODY_PLACEHOLDER = {
    loading: "Loading episodes…",
    empty: "No episodes yet.",
    failed: "Couldn't load these episodes.",
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
      c.innerHTML = curatedEps.map((item, i) => epRow(item, i, ctx, -1)).join("");
      bindRows(c);
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
  }

  function paintSearchNote() {
    const note = searchNote();
    if (!note) return;
    if (!searchQuery.trim()) { note.hidden = true; return; }
    note.hidden = false;
    if (searchMode === "loading") {
      note.textContent = "Searching…";
      return;
    }
    if (searchMode === "scoped") {
      // The honest, non-hedged case: S-07 searched the show's FULL episode
      // list server-side, not just whatever this render has paged in.
      note.textContent = `${scopedResults.length} episode${scopedResults.length === 1 ? "" : "s"} found.`;
      return;
    }
    // "fallback": S-07 failed or degraded for this query. Partial-list
    // honesty rule (card acceptance criterion): a search box that quietly
    // filtered only what happened to be in memory would read as "no
    // results" for an episode on a page that hasn't loaded yet — label the
    // scope explicitly rather than imply this searched the whole show.
    const matchCount = filterLoadedEpisodes(loaded, searchQuery).length;
    note.textContent = fullyLoaded
      ? `${matchCount} match${matchCount === 1 ? "" : "es"} in ${loaded.length} episode${loaded.length === 1 ? "" : "s"}.`
      : `${matchCount} match${matchCount === 1 ? "" : "es"} — searching loaded episodes only (${loaded.length} of the full list loaded so far).`;
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
  }

  /* Debounced (250ms) so a fast typist doesn't fire a request per
     keystroke — S-07's endpoint does a live feed fetch server-side on a
     cache miss, so this isn't free. `searchToken` guards a slow response
     from a superseded query clobbering a newer one's results, same pattern
     showSearchToken uses for the Shows-page search above. */
  function runSearch() {
    const query = searchQuery;
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

/** Do two fetched pages hold the same episodes, in the same order? Ids only —
    a description edit upstream is not a reason to yank the list out from under
    someone who is reading it. */
function sameEpisodeList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
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

/* Loading-state guard around #pl-form's submit (H bug, kanban t_838a13c0):
   buildPlaylist() is synchronous and, in the worst case (a fresh session's
   first query, or any query that misses the repeated-query cache above), can
   take 1.3-8s on the real catalogue — with nothing before this change to
   tell the listener their tap registered. Defined once here rather than
   inline: two form instances shared it until 2026-09-03 (renderHome and
   renderPlaylists both mounted a `#pl-form`); only renderPlaylists does now,
   and the handler stays separate so a second mount point can reuse it.

   THE SETTIMEOUT(0) IS LOAD-BEARING, not decoration: disabling the button and
   swapping its label only becomes visible to the user if the browser gets a
   chance to paint before the synchronous, CPU-bound buildPlaylist() call
   blocks the main thread. Setting `disabled`/`textContent` and calling
   buildPlaylist() in the same tick produces a frozen-looking button for the
   whole stall — no paint happens until the synchronous work yields — which is
   the exact defect this guard exists to fix, just moved one line over. A
   0ms timeout is enough because the browser only needs a task-queue turn to
   flush the pending style/paint, not any particular delay.
   `finally` restores the button whether buildPlaylist ran clean, threw
   (unexpected but real user data — never let an exception leave the button
   stuck disabled), or returned early. */
function bindPlaylistFormSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.querySelector("input[type='text']");
  const btn = form.querySelector("button");
  const query = input.value.trim();
  if (!query) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building…";
  setTimeout(() => {
    try {
      const result = buildPlaylist(query);
      logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0 });
      if (result.status === "ok" || result.status === "sparse") {
        location.hash = "#/playlist/" + result.playlist.id;
      } else {
        const note = $("#pl-note");
        note.textContent = result.status === "unsaved"
          /* Says what happened and what to do, and does not blame the listener for
             a device that is out of room. */
          ? "That playlist could not be saved — this device has no storage space left. Removing a playlist you have finished with frees enough for a new one."
          : result.suggestions.length
            ? `Not much on "${query}" yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
            : `Not much on "${query}" yet — try different words.`;
        note.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }, 0);
}

/* ---------- shared wiring ---------- */

function bindPickLogging(scope) {
  scope.querySelectorAll("[data-ev='picked']").forEach(a => {
    a.addEventListener("click", () => {
      const id = a.dataset.ep;
      logEvent("picked", { episode_id: id, topics: (state.itemIndex[id] && state.itemIndex[id].topics) || [], app: a.dataset.app || "Apple Podcasts", context: a.dataset.ctx });

      const history = pickedHistory();
      if (!history.includes(id)) lsSet("cp_history", history.concat(id).slice(-200));

      const m = /^playlist-(.+)$/.exec(a.dataset.ctx || "");
      if (m) touchPlaylistPlayed(m[1]);

      /* Only a part the catalogue still holds may become the continue banner. An
         archived playlist part has a snapshot in `state.itemIndex` (seeded by
         renderPlaylistDetail so this handler can report its topics), but that
         snapshot is a PARTIAL one — no audio_url, no hook, no artwork — and
         bannerHtml() re-runs `snapshot()` over whatever cp_lastpick holds, which
         would overwrite the pool's full entry with the partial and leave a live
         episode with a play button that does nothing. Besides which, the banner
         offers to resume something the app cannot play. */
      const snap = state.poolIds.has(id) ? state.itemIndex[id] : null;
      if (snap && a.dataset.ctx !== "continue") {
        lsSet("cp_lastpick", { ...snap, ts: new Date().toISOString() });
      }
      trySyncEvents();
    });
  });
}

/* `origin` distinguishes "this play button lives on the #/queue page" (only
   caller: renderQueue) from every other row in the app (undefined/omitted).
   That distinction is the whole mechanism behind plan §4 Q1's answer: only a
   play started FROM #/queue can ever trigger auto-advance — starting an
   unrelated episode elsewhere must never be silently read as "now playing
   the queue" (see setQueuePlaybackOrigin's header). */
function bindPlay(scope, { origin = null } = {}) {
  scope.querySelectorAll("[data-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async (e) => {
      // The button sits inside the card's <a>; without this the link-out fires
      // and the browser navigates away mid-play.
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.play;
      const item = state.itemIndex[id] || episode(id);
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
      if (origin === "queue") setQueuePlaybackOrigin(id);
      else clearQueuePlaybackOrigin();
      /* A PLAY THAT FAILS SAYS SO (persona audit #4, 2026-09-22). It used to be
         `if (!ok) return;` with no try at all: a refused play said nothing, and a
         throw out of `play()` was an unhandled rejection in an async listener —
         a tap that did nothing and said nothing, which is founder report #225,
         already fixed for the Foray page by guardForayStart. The line itself
         lives on the player bar (`reportPlayFailure`), because the bar is on
         screen whichever page this button was on. */
      let ok = false;
      try {
        ok = await window.ForayPlayer.play(item, { why: whyFor(id, item) });
      } catch (err) {
        console.warn("[4a] play failed", err);
        ok = false;
        try { window.ForayPlayer.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
        noteTapFailure("start", err);
        clearQueuePlaybackOrigin();
        return;
      }
      if (!ok) {
        clearQueuePlaybackOrigin();
        try { window.ForayPlayer.reportPlayFailure?.(null); } catch (_) { /* the bar is best-effort */ }
        return;
      }
      logEvent("play_started", { episode_id: id, topics: item.topics || [] });
      const history = pickedHistory();
      if (!history.includes(id)) lsSet("cp_history", history.concat(id).slice(-200));
      /* Same "playlist-<id>" convention and the same regex bindPickLogging
         already applies to a picked link's data-ctx — bindPlay is the in-app
         play button, the PRIMARY control on every live playlist row, and it
         was the only path that never stamped `last_played_at` (#558 item 2):
         a playlist played entirely in-app kept `last_played_at: null`
         forever, which is the sort key both Home's own-playlist rail and the
         drawer use. */
      const m = /^playlist-(.+)$/.exec(btn.dataset.ctx || "");
      if (m) touchPlaylistPlayed(m[1]);
      trySyncEvents();
    });
  });
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
      scope.querySelectorAll(`[data-upnext="${CSS.escape(id)}"]`).forEach(b => {
        b.textContent = "✓ Up Next";
        b.classList.add("on");
        b.setAttribute("aria-label", "In Up Next");
      });
    });
  });
}

/* ---------- views ---------- */

function currentContinue() {
  const last = lsGet("cp_lastpick", null);
  if (!last) return null;
  const ageH = (Date.now() - new Date(last.ts).getTime()) / 3.6e6;
  const commuteMin = state.session.commute.content_minutes || 27;
  if (ageH > CONTINUE_MAX_AGE_H) return null;
  if ((last.duration_min || 0) <= commuteMin + 5) return null;
  return last;
}

function bannerHtml() {
  const c = currentContinue();
  if (!c) return "";
  snapshot(c.id, c);
  return `<a class="banner" href="#/episode/${esc(encodeURIComponent(c.id))}"
      data-ev="picked" data-ep="${c.id}" data-ctx="continue">
    ${c.artwork_url ? `<img src="${esc(safeUrl(c.artwork_url))}" alt="">` : ""}
    <div class="b-info">
      <span class="b-label">Continue</span>
      <span class="b-title">${esc(c.title)}</span>
    </div>
    <button class="b-done" id="banner-done" aria-label="Done with this">✓</button>
  </a>`;
}

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

function miniCard(slot) {
  const item = slot.item;
  /* ONE POPULATION FOR THE COUNT AND THE DURATION (audit 2026-09-22). `|| 0`
     summed only the episodes whose length is known and printed that beside a
     count of all of them — "3 episodes · 1h 20m" when one of the three had no
     `duration_min` (8 such items ship in data/discover.json). A total is stated
     only when it is a total; otherwise the line keeps the count alone. */
  const allTimed = slot.items.length > 0 && slot.items.every(it => Number(it.duration_min) > 0);
  const totalMin = allTimed ? slot.items.reduce((s, it) => s + Number(it.duration_min), 0) : 0;
  const stretchTag = slot.role === "stretch"
    ? `<span class="mc-stretch" title="Outside your usual topics, on purpose">Stretch</span>` : "";
  return `<a class="mini-card" data-branch="${esc(slot.branch)}"
      href="#/subject/${esc(slot.branch)}">
    ${item.artwork_url ? `<img src="${esc(safeUrl(item.artwork_url))}" alt="" loading="lazy">` : `<div class="art-ph"></div>`}
    <div class="mc-info">
      <p class="mc-kicker">${stretchTag}${slot.items.length} episode${slot.items.length === 1 ? "" : "s"}${totalMin ? ` · ${fmtDur(totalMin)}` : ""}</p>
      <h3>${esc(subjectLabel(slot.branch))}</h3>
      <p class="mc-hook">${esc(subjectBlurb(slot))} Starts with "${esc(item.title)}."</p>
    </div>
    ${starBtn(item.id)}
  </a>`;
}

/* WHAT A FORAY IS, in one sentence, written ONCE (audit 2026-09-22, persona
   #18/#37/#45/#83). It was a literal inside the first-run sheet below — the only
   place in the product that said it — and that sheet is one-shot: "Skip for now"
   sets `cp_intro_dismissed` and nothing ever re-opens it. So the sentence is
   hoisted here and the Forays page subtitle reads it too, which gives the
   explanation a permanent home and makes skipping the sheet cost nothing. One
   constant, so the page and the sheet cannot drift into two descriptions. */
const FORAY_ABOUT = "We clip the best parts of several podcasts on a subject and stitch them into one seamless listen, with a narrator bridging the gaps.";

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

/** Applies a Preferences pick: `pickedRootIds` from the chip grid, plus an
    optional typed subject matched against a real top-level taxonomy label
    (case-insensitive) — the mockup's "Or type a subject yourself…" field
    reaches the same write path a chip tap would when it names a real root,
    and is otherwise a no-op rather than inventing an untagged node nothing
    in the pool carries. Returns false (no write, no _interestsGen bump) when
    nothing was picked and nothing typed matched, so a caller can tell a real
    Skip from a Continue with an empty/unmatched form. */
function applyOnboardingPicks(pickedRootIds, typedSubject) {
  const ids = [...(pickedRootIds || [])];
  const typed = (typedSubject || "").trim();
  if (typed) {
    const typedNode = taxonomyNodes().find(
      n => n.parent === null && n.label.toLowerCase() === typed.toLowerCase()
    );
    if (typedNode && !ids.includes(typedNode.id)) ids.push(typedNode.id);
  }
  if (!ids.length) return false;

  const lift = ONBOARDING_SEED_LIFT / Math.sqrt(ids.length);
  const targets = new Set(ids.flatMap(expandTaxonomyPick));
  targets.forEach(id => {
    if (id in state.interests) {
      state.interests[id] = Math.max(0, Math.min(1, state.interests[id] + lift));
    }
  });
  saveInterests();
  state._interestsGen = (state._interestsGen || 0) + 1;
  return true;
}

/** U-09's third acceptance line ("picking three chips changes the FIRST Home
    render's ranking"), which shipped unmet in PR #503 (audit, 2026-09-10):
    Home's "Episodes for you" is `state.cardSlots`, dealt once per session by
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
function redealAfterOnboardingPicks() {
  const dealt = state.cardSlots || [];
  if (!dealt.length) return;
  const dealtIds = new Set(dealt.flatMap(sl => (sl.items || []).map(it => it.id)));
  lsSet("cp_seen", lsGet("cp_seen", []).filter(id => !dealtIds.has(id)));
  const recent = lsGet("cp_recent_branches", []);
  lsSet("cp_recent_branches", recent.slice(0, Math.max(0, recent.length - dealt.length)));
  buildCards();
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
      "Start listening" applies the picks via applyOnboardingPicks() — the
      FIXED U-07 write path (taxonomyNodes() includes roots, so a root-level
      chip actually persists) — then dismisses, and when something was
      written re-deals Home's card slots and repaints, so the FIRST Home the
      listener lands on already ranks by the picks (the card's third
      acceptance line; see redealAfterOnboardingPicks()).

    Both steps' exits set the SAME cp_intro_dismissed flag showIntroPopupOnce()
    already uses, so this flow and the older popup can never both show on the
    same visit and neither shows again after. */
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
   test/onboarding-sheet-once.test.js fails on the duplicate-mount assertion. */
function showFirstTimeExplainerOnce() {
  if (!isGenuineFirstTimeUser()) return false;
  if (lsGet("cp_intro_dismissed", false)) return false;
  if ($("#first-time-sheet")) return true;   // already on screen this visit

  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "first-time-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");
  panel.append(grab);

  const body = ddEl("div", "ft-step-body");
  panel.append(body);

  wrap.append(scrim, panel);
  document.body.appendChild(wrap);
  document.body.classList.add("fy-sheet-open");

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    wrap.remove();
    document.body.classList.remove("fy-sheet-open");
  };
  scrim.addEventListener("click", dismiss);

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
      const r = player.resolve(state.forays, {
        id: first.id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources,
        ...forayViewOpts(),
      });
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
      ddEl("p", "fy-sheet-sub", FORAY_ABOUT)
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
    go.addEventListener("click", renderPreferences);
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
    const sub = ddEl("p", "fy-sheet-sub", "This is how we tune your suggestions. Pick a few, or skip — we learn either way, from what you play.");

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
    typedWrap.append(typedInput);

    const actions = ddEl("div", "fy-sheet-actions");
    const skip = ddEl("button", "fy-sheet-cancel", "Skip");
    skip.type = "button";
    skip.id = "first-time-sheet-prefs-skip";
    const go = ddEl("button", "fy-sheet-go", "Start listening");
    go.type = "button";
    go.id = "first-time-sheet-prefs-go";
    actions.append(skip, go);

    body.append(title, sub, chips, typedWrap, actions);

    skip.addEventListener("click", dismiss);
    go.addEventListener("click", () => {
      const applied = applyOnboardingPicks([...picked], typedInput.value);
      dismiss();
      /* Only when something was actually written: an empty/unmatched form is
         a Skip in all but name, and the Home already under the sheet is the
         right Home for it. Otherwise re-deal and repaint, so the FIRST Home
         the listener lands on ranks by their picks (U-09's acceptance line;
         see redealAfterOnboardingPicks). renderCurrentPage(), not route():
         nothing about the location changed, and route() is the back-stack's
         entry point (#488). */
      if (applied) {
        redealAfterOnboardingPicks();
        renderCurrentPage();
      }
    });
  }

  renderWelcome();
  return true;
}

/* First-run explainer (#128 follow-up). Used to be a permanent card at the top
   of the home screen — after the first read it was dead weight that pushed the
   four topic queues down the screen for good. It is now a one-time popup shown
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
     it and a duplicate mount. */
  if ($("#intro-sheet")) return;
  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "intro-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = ddEl("h3", null, "4a picks podcast episodes for you");
  title.id = "intro-sheet-title";
  panel.setAttribute("aria-labelledby", "intro-sheet-title");

  const sub = ddEl("p", "fy-sheet-sub",
    "Grouped into four topic queues — not one long feed to scroll. Three queues are topics you're already into. One is deliberately something else, on purpose. Tap a card to open its queue and see what's in it.");

  const actions = ddEl("div", "fy-sheet-actions");
  const ok = ddEl("button", "fy-sheet-go", "Got it");
  ok.type = "button";
  ok.id = "intro-sheet-ok";
  actions.append(ok);

  panel.append(grab, title, sub, actions);
  wrap.append(scrim, panel);
  document.body.appendChild(wrap);
  document.body.classList.add("fy-sheet-open");

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    wrap.remove();
    document.body.classList.remove("fy-sheet-open");
  };
  scrim.addEventListener("click", dismiss);
  ok.addEventListener("click", dismiss);
}

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
  return `<a class="show-result" href="#/show/${encodeURIComponent(show.show_id)}">
    ${art ? `<img class="show-result-art" src="${esc(safeUrl(art))}" alt="">` : `<span class="show-result-art show-result-art-blank"></span>`}
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
    .sort((a, b) => a.show_id.localeCompare(b.show_id));
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
    <h3>Shows we vouch for</h3>
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
      who came to press play.
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
let showIndexFetchCount = 0;   // test-visible: the index is fetched at most once

function loadShowIndex() {
  if (showIndex) return Promise.resolve(showIndex);
  if (showIndexPromise) return showIndexPromise;
  showIndexFetchCount++;
  showIndexPromise = (async () => {
    try {
      const res = await fetch(SHOW_INDEX_PATH, { cache: "no-cache" });
      if (!res || !res.ok) return null;
      const parsed = SearchEngine.parseShowIndex(await res.text());
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
function localShowMatches(query) {
  const curated = state.catalog?.shows || [];
  if (!showIndex) return SearchEngine.searchShows(query, curated);
  const seen = new Set(curated.map((s) => s.show_id));
  const fromIndex = SearchEngine.prefixSearchShows(query, showIndex)
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

  let data = null;
  let version = null;
  try {
    const res = await fetch(apiUrl(`api/shows/index/shards/${encodeURIComponent(shardKey)}.json`), { cache: "no-cache" });
    if (res && res.ok) {
      data = await res.json();
      version = res.headers && typeof res.headers.get === "function" ? res.headers.get("X-Shows-Index-Version") : null;
    }
  } catch (_) {
    data = null;
  }
  if (version) lastSeenShardVersion = version;
  if (!Array.isArray(data)) return []; // failure/unavailable: not memoized, so a later search retries
  shardMemoryCache.set(shardKey, data);
  if (data.length) writeShardToCacheStorage(shardKey, data, version);
  return data;
}

/** Maps one shard row (`{ id, t, a, i, u, img, n, c }`,
    `tools/shows/shard-build.mjs:toShardRow`'s shape) to the show record
    shape every other search source already produces — the same fields
    `mapAppleShow` (`api/shows/appleShowSearch.ts`) and the catalogue
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
    `api/shows/appleShowSearch.ts:normaliseShowTitle`, and it is not left to
    discipline: `test/show-search-fallthrough.test.js` reads both files and
    compares the two expressions, the same way `test/show-search-ranking.test.js`
    pins the bucket table against `backend/src/catalog/searchBreadthShows.ts`.
    Unicode property escapes rather than `\W`, which is ASCII-only — "99%
    Invisible" and "伊藤洋一のRound Up World Now！" both have to normalise
    sensibly. */
function normaliseShowTitle(title) {
  return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
   `api/shows/appleShowSearch.ts:showTitleDedupStem`, pinned the same way
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
}

/* WHICH SEARCH HAS HEARD FROM EVERY PASS THAT COULD ADD A SHOW (audit
   2026-09-22, theme G). `token` is the showSearchToken whose catalogue,
   directory and shard passes have all settled; `failed` is whether any of them
   failed rather than answered. Until the current token is recorded here, an
   empty list is "still searching", never "nothing found" — the old paint said
   `No results for "huberman".` on the keystroke, for the ~250 ms debounce plus
   118-561 ms of round trip, and then ten results arrived under it. */
let showSearchSettled = { token: -1, failed: false };

/** Paints one set of show rows into `#sh-results`, or the honest empty state.
    Token-guarded so a slow costly pass cannot repaint over a newer query.

    S-05/D9: `#sh-offline-note` ("Showing shows available offline") is shown
    whenever the runtime reports offline, independent of whether `shows` is
    empty — the local/curated pass still answers instantly offline, so this
    is not the same state as the "No results" note below it (both can be
    visible in principle; the offline note explains WHY the shard/directory
    tiers are absent, the results note or list is WHAT the local pass found). */
function paintShowResults(query, shows, myToken) {
  if (myToken !== showSearchToken) return; // a newer query already superseded this one
  const note = $("#sh-note");
  const results = $("#sh-results");
  const offlineNote = $("#sh-offline-note");
  if (!note || !results) return;
  if (offlineNote) offlineNote.hidden = !isOfflineForShardSearch();
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
    note.textContent = settled ? `No shows found for "${query}".` : `Searching for "${query}"…`;
    note.hidden = false;
    paintShowSearchEmptyOffer(settled ? { query, myToken, failed: showSearchSettled.failed } : null);
    return;
  }
  note.hidden = true;
  paintShowSearchEmptyOffer(null);
  results.innerHTML = shows.map(showResultRow).join("");
  results.hidden = false;
}

/** WHAT A SETTLED, EMPTY SHOWS SEARCH OFFERS INSTEAD OF A DEAD END (audit
    2026-09-22, the unconditional half of the browse-pill finding). Two things,
    both only once every pass has answered:

      - A PASS THAT FAILED says so, with "Try again" wired to the same search.
        `api/shows/search.ts` answers an Apple timeout or a rate-limit trip with
        200 and zero directory rows BY DESIGN, and offline every network pass
        fails — so "no shows" over a failed pass was a permanent claim about a
        moment's network, with nothing to press.
      - A QUERY THAT IS A SUBJECT'S OWN NAME (a browse pill lands here with its
        label) gets that subject's narrower categories that DO hold shows, as
        chips. The pill stays an ordinary search for its own text (founder,
        #684); this is only what the empty answer offers next, and every chip
        leads to a page with at least one show on it.

    `null` clears it — every non-empty paint and every cleared query. */
function paintShowSearchEmptyOffer(opts) {
  const box = $("#sh-empty-offer");
  if (!box) return;
  if (!opts) { box.innerHTML = ""; box.hidden = true; return; }
  const { query, myToken, failed } = opts;
  const parts = [];
  if (failed) parts.push(failedNoteHtml("Part of this search didn't load."));
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
  if (failed) bindRetry(box, () => { if (myToken === showSearchToken) renderShowSearchResults(query); });
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
  const localShows = localShowMatches(query);
  const localMs = nowMs() - localStart;
  paintShowResults(query, localShows, myToken);
  const localEpisodes = paintLocalEpisodeSearch(query, myToken);
  return { localShows, localEpisodes, localMs, paintedMs: nowMs() - localStart };
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
  const settle = (patch) => {
    Object.assign(record, patch);
    if (--owed === 0) recordSearchDiagnostic(record);
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
    showSearchSettled = { token: myToken, failed: showPassFailed };
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
    const scanned = SearchEngine.scanShowIndex(query, showIndex);
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
    for (const s of breadthShows) state.breadthShowCache[s.show_id] = s;
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
      if (data) {
        if (showBreadthQueryCache.size >= SHOW_BREADTH_CACHE_MAX) showBreadthQueryCache.clear();
        showBreadthQueryCache.set(cacheKey, breadthShows);
      }
      if (!superseded && breadthShows.length) mergeBreadth(breadthShows);
      settle({
        netMs, netHits: data ? breadthShows.length : null,
        path: superseded ? "superseded" : data ? "local+net" : "local-only",
      });
      showPassDone(!data);
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
      const ranked = SearchEngine.rankShardRows(query, rows);
      const mapped = ranked.map(mapShardRow);
      for (const s of mapped) state.shardShowCache[s.show_id] = s;
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
  const myToken = ++showSearchToken; // supersedes any in-flight costly pass
  if (showSearchDebounceTimer) clearTimeout(showSearchDebounceTimer);
  showSearchDebounceTimer = null;
  if (!query) { clearShowSearchResults(); return; }
  const local = paintShowSearchLocal(query, myToken);
  showSearchDebounceTimer = setTimeout(() => {
    showSearchDebounceTimer = null;
    if (myToken !== showSearchToken) return; // a newer keystroke already owns the page
    runShowSearchCostly(query, myToken, local);
  }, SHOW_SEARCH_DEBOUNCE_MS);
}

/** Enter, the Go button, and every existing caller: the same two passes with
    the debounce SKIPPED — the exact idiom the show page's episode search
    already ships (`onSearchInputChange`/`runSearch`, above). */
function renderShowSearchResults(query) {
  const myToken = ++showSearchToken;
  if (showSearchDebounceTimer) { clearTimeout(showSearchDebounceTimer); showSearchDebounceTimer = null; }
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
   appears when `topicSearchStatus` reports no strong result at all -- not
   merely "no own/generated playlist matched", because a listener could
   have zero saved playlists yet the topic scorer still finds a rich set of
   episodes (that is exactly what Playlists/#pl-form already builds from).
   The CTA is presentation only: tapping it hands off to the existing
   #/playlists page's own #pl-form flow (through `location.hash` +
   prefilling the input) rather than calling buildPlaylist() here, so this
   card adds no second path that can create a playlist -- there remains
   exactly one (#pl-form's bindPlaylistFormSubmit), matching D8's "the
   Foray half is not built, Playlist creation stays today's flow" scope. */
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

       Clear the section first so nothing stale lingers, and guard with
       `myToken` so a fast retype's OLD deferred computation can never clobber
       a newer query's freshly-painted own/generated section. */
    container.innerHTML = "";
    container.hidden = true;
    whenIdle(() => {
      if (myToken !== showSearchToken) { reportCtaMs(null); return; } // a newer query already superseded this one
      const ctaStart = nowMs();
      const cta = createPlaylistCtaHtml(query);
      reportCtaMs(nowMs() - ctaStart);
      if (!cta) return; // container already cleared above
      container.innerHTML = cta;
      container.hidden = false;
      bindCreatePlaylistCta(container);
    });
    return;
  }

  const row = (p, generated) => `
    <a class="pl-row" href="#/playlist/${esc(p.id)}">
      <div class="info">
        <div class="t">${esc(p.title)}${generated ? ` <span class="fy-badge fy-badge-generated">Generated for you</span>` : ""}</div>
        <div class="s">${resolveParts(p).length} parts</div>
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

/* U-05 (#135, D7/D8): appears in place of a Playlists section when the topic
   scorer finds no strong result for the typed query at all -- i.e. neither
   an own/generated playlist match above NOR a topic-search answer rich
   enough to act on. `topicSearchStatus` runs the exact same scorer
   buildPlaylist() would, read-only (see its own header for why this must
   not itself create a playlist).  Retargeted from Foray to Playlist per D8:
   the mockup's SearchScreen CTA offers "Create a Foray about X"; Foray
   generation stays out of the UI (D8), so this offers a Playlist instead,
   handed to the existing #pl-form flow rather than a new creation path. */
function createPlaylistCtaHtml(query) {
  if (topicSearchStatus(query).status !== "empty") return "";
  return `<div class="sh-create-cta">
    <button type="button" class="fy-btn fy-main" data-create-playlist="${esc(query)}">
      Create a playlist about \u201c${esc(query)}\u201d
    </button>
  </div>`;
}

/* Hands off to #/playlists' own, single creation path (#pl-form's
   bindPlaylistFormSubmit) rather than calling buildPlaylist() from here --
   see createPlaylistCtaHtml's header for why a second creation path is out
   of scope. Navigates first so #pl-form exists, then prefills and submits
   it on the next task-queue turn (route() replaces #view synchronously on
   the hashchange handler, which runs after this click handler returns —
   same "let the browser get a paint/task turn" idiom bindPlaylistFormSubmit
   itself already documents for its own setTimeout(0)). */
function bindCreatePlaylistCta(scope) {
  const btn = scope.querySelector("[data-create-playlist]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const query = btn.dataset.createPlaylist || "";
    location.hash = "#/playlists";
    setTimeout(() => {
      const input = $("#pl-input");
      const form = $("#pl-form");
      if (!input || !form) return; // route() failed to land on #/playlists — nothing to prefill
      input.value = query;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }, 0);
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

/** Dedup key shared by both tiers. `guid` when the row has one — the closest
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
function episodeDedupKey(ep) {
  const guid = ep && ep.guid ? String(ep.guid).trim() : "";
  const scope = episodeDedupScopes(ep)[0];
  if (guid) return "g:" + scope + "|" + guid;
  return "t:" + normaliseShowTitle(ep && ep.title) + "|" + scope;
}

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
  const remote = [];
  for (const ep of (data?.episodes || [])) {
    const keys = episodeDedupKeys(ep);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    remote.push(ep);
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
     reads `state.itemIndex` for anything in `state.poolIds` — so Up Next, the
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
    const item = snapshot(id, {
      show: ep.show_title || ep.show_id,
      title: ep.title,
      hook: ep.description_text || "",
      audio_url: ep.audio_url,
      duration_min: ep.duration_seconds ? Math.round(ep.duration_seconds / 60) : null,
      duration_sec: ep.duration_seconds ?? null,
      topics: [],
    });
    return epRow(item, i, ctx, -1);
  };
  const localRows = local.map((ep, i) => rowFor(ep, i));
  const remoteRows = remote.map((ep, i) => rowFor(ep, local.length + i));
  container.innerHTML = `<section class="ep-more fy-episode-search">
    <h3>Episodes${fromApple && !local.length ? ` <span class="note">from Apple's index</span>` : ""}</h3>
    ${localRows.join("")}
    ${fromApple && local.length ? `<div class="note fy-episode-search-more">from Apple's index</div>` : ""}
    ${remoteRows.join("")}
  </section>`;
  container.hidden = false;
  bindPickLogging(container);
  bindStars(container);
  bindUpNext(container);
  bindPlay(container);
  return local.length + remote.length;
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
    if (data) {
      if (episodeSearchQueryCache.size >= EPISODE_SEARCH_CACHE_MAX) episodeSearchQueryCache.clear();
      episodeSearchQueryCache.set(cacheKey, data);
    }
    if (myToken !== showSearchToken) { report(epMs, null); return; } // superseded — drop this response
    /* A FAILED ENDPOINT PASS LEAVES THE LOCAL TIER EXACTLY AS IT WAS — the
       same structural promise P-02 made the show list. `data` is null on any
       network or parse failure (`fetchApiJson` swallows both), and this
       repaints the local rows rather than falling through to a clear. Only the
       ENDPOINT half is unknown in that case, which is what `epHits: null`
       already says.

       `epHits` stays the ENDPOINT's hit count, not the painted total. It is a
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
     playlist builder (#pl-form)            -> Playlists  (#/playlists)
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
   Playlists for you; Episodes for you. "Shared with you" and "Build your
   own" are explicitly out of scope (D10/D8) — not stubbed, not commented
   out, simply never written.

   THE FLOOR (Wyatt's decision, resolves #123): "Forays for you" and
   "Episodes for you" EACH reserve at least one slot for a STRETCH pick —
   something outside the listener's top interest tier, on purpose, visibly
   labelled "Stretch" with a bridge line stating why it's being suggested.
   A row reason ("Because you finish every Odd Lots") is allowed elsewhere
   but never on the stretch slot itself — that is the whole point of a
   stretch: it is not being justified by what the listener already likes.

   Episodes for you REUSES buildCards()'s existing tiering (top 60% of
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

function homeGreeting() {
  const h = new Date().getHours();
  const word = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `<div class="hv2-greeting">
    <span class="hv2-greeting-word">${word}</span>
    <span class="hv2-greeting-brand">4a</span>
  </div>`;
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
 *   1. `cp_lastpick` is written ONLY when `state.poolIds.has(id)` — the discover
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
function jumpBackInV2Html() {
  const cards = jumpBackInEntries();
  if (!cards.length) return "";
  return `<section class="hv2-section hv2-jbi">
    <h2 class="hv2-title">Jump back in</h2>
    <div class="hv2-hscroll">${cards.map(jumpBackInCardHtml).join("")}</div>
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
     home on the playlists page. */
  for (const p of playlists().filter(p => p.last_played_at)) {
    entries.push({
      kind: "playlist", id: p.id, at: p.last_played_at,
      title: p.title || p.name || "Playlist",
      sub: `${resolveParts(p).length} parts`,
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
       `audio_url` precisely so this is possible. */
    snapshot(r.id, r);
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

function jumpBackInCardHtml(c) {
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
  return `
    <a class="hv2-jbi-card" href="#/${route}/${id}"${ev}>
      <span class="hv2-jbi-kicker">Jump back in</span>
      <span class="hv2-jbi-title">${esc(c.title)}</span>
      ${sub}${bar}${left}${play}
    </a>`;
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
  let stripHtml = "";
  if (player && state.forays && typeof player.resolve === "function" && typeof player.segmentStripHtml === "function") {
    try {
      const r = player.resolve(state.forays, {
        id: foray.id, segmentsDoc: state.segments, sourcesDoc: state.segmentSources,
        ...forayViewOpts(),
      });
      /* mergeNarration — same reason as welcomeStripHtml() above: a card is not
         a scrub target, so a run of bridges may be one bar. */
      if (r) stripHtml = player.segmentStripHtml(r.playable, { size: "sm", mergeNarration: true }) || "";
    } catch (_) {
      stripHtml = ""; // malformed segments/sources must not break Home
    }
  }
  const subject = subjectLabel((foray.topic || "").split("/")[0]);
  return `<a class="hv2-foray-card${stretch ? " hv2-stretch" : ""}" href="#/foray/${esc(foray.id)}">
    ${stretch ? `<span class="hv2-stretch-tag">Stretch</span>` : ""}
    ${draft ? `<span class="hv2-draft-tag">draft</span>` : ""}
    <span class="hv2-foray-title">${esc(foray.title)}</span>
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
function foraysForYouHtml() {
  if (!state.forays || !window.ForayPlayer) return "";
  const { listed, drafts } = splitTestTrackDrafts(opts => window.ForayPlayer.listForays(state.forays, opts));
  if (!listed.length && !drafts.length) return "";
  const { picks, stretchIndex } = pickWithStretchFloor(listed, {
    branchFn: f => (f.topic || "other").split("/")[0],
    scoreFn: f => interestScore({ topics: [(f.topic || "other").split("/")[0]] }),
    take: 4,
  });
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
  return `<a class="hv2-playlist-card" href="#/${p.isSubject ? "subject/" + esc(p.branch) : "playlist/" + esc(p.id)}">
    ${generated ? `<span class="hv2-generated-badge">Generated for you</span>` : ""}
    <span class="hv2-playlist-title">${esc(p.title)}</span>
    <span class="hv2-playlist-sub">${count} episode${count === 1 ? "" : "s"}</span>
  </a>`;
}

/** "Playlists for you" (D5): the listener's own recent playlists first,
    then up to three generated from state.interests (generatedPlaylists():
    the strongest interest leaves, filled from the discover pool). NOT the
    card slots — F14: that made this section "Episodes for you" regrouped. */
function playlistsForYouHtml() {
  const own = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created || "").localeCompare(a.last_played_at || a.created || ""))
    .slice(0, 3);
  const generated = generatedPlaylists();
  if (!own.length && !generated.length) return "";
  const cards = own.map(p => playlistCardV2Html(p, { generated: false }))
    .concat(generated.map(p => playlistCardV2Html(p, { generated: true })));
  return `<section class="hv2-section hv2-playlists">
    <h2 class="hv2-title">Playlists for you</h2>
    <div class="hv2-hscroll">${cards.join("")}</div>
  </section>`;
}

/** One episode card for "Episodes for you" — miniCard()'s existing markup
    plus the visible bridge line D1's copy rule requires on a stretch
    slot, which miniCard() itself does not render (its "Stretch" tag is a
    hover-only `title`, pinned as-is elsewhere and left untouched here).
    Composes rather than forks: the card body is exactly miniCard(slot),
    with the bridge line appended after it for a stretch slot only. */
function miniCardV2(slot) {
  const card = miniCard(slot);
  if (slot.role !== "stretch") return card;
  // Insert the bridge line just before the anchor's closing tag.
  const bridge = `<p class="hv2-bridge">${stretchBridgeLine(subjectLabel(slot.branch))}</p></a>`;
  return card.replace(/<\/a>$/, bridge);
}

/** "Episodes for you": buildCards()'s ranked discover-pool picks, i.e.
    state.cardSlots verbatim — the SAME floor buildCards() already
    computes for the flag-off four-card Home, so this section and that
    one can never disagree about which slot is the stretch. renderHomeV2()
    guarantees state.cardSlots is already built before this runs (same as
    v1's own renderHome()), so this only guards a caller that invokes this
    function directly (e.g. a future test). */
function episodesForYouHtml() {
  if (!state.cardSlots.length) return "";
  return `<section class="hv2-section hv2-episodes">
    <h2 class="hv2-title">Episodes for you</h2>
    <div class="hv2-cards">${state.cardSlots.map(miniCardV2).join("")}</div>
  </section>`;
}

function renderHomeV2() {
  setBodyClass("view-home");
  if (!state.cardSlots.length) buildCards();
  $("#view").innerHTML = `
    <div class="home hv2-home">
      ${homeGreeting()}
      ${testTrackNoticeHtml()}
      ${jumpBackInV2Html()}
      ${foraysForYouHtml()}
      ${playlistsForYouHtml()}
      ${episodesForYouHtml()}
    </div>`;

  if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();

  sizeProgressBars($("#view"));
  if (window.ForayPlayer && typeof window.ForayPlayer.applyStripGrow === "function") {
    window.ForayPlayer.applyStripGrow($("#view"));
  }

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
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
          <p class="sub">${esc(FORAY_ABOUT)}</p>
        </div>
      </div>`;
  const paintStatus = (body) => { $("#view").innerHTML = `<div class="page">${head}${body}</div>`; };

  if (!window.ForayPlayer) {
    paintStatus(`<p class="note">Loading…</p>`);
    playerBridge().then((player) => {
      if ((location.hash || "") !== "#/forays") return; // the listener has moved on
      if (player) { renderForays(); return; }
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
        ? forayListHtml()
        : `<p class="note">No forays right now — 4a stitches these by hand, so they arrive a few at a time.</p>`}
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
function rowProgress(item) {
  const bridge = window.ForayPlayer;
  if (!item?.id || typeof bridge?.episodeProgress !== "function") return null;
  const durSec = Number(item.duration_sec) > 0 ? Number(item.duration_sec)
    : (Number(item.duration_min) > 0 ? Number(item.duration_min) * 60 : null);
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

function epRow(item, idx, ctx, nextIdx) {
  const inApp = playBtn(item, ctx);
  const unavailable = inApp ? "" : notPlayableNote();
  const dateStr = fmtDate(item.release_date);
  const prog = rowProgress(item);
  const progHtml = prog && prog.label
    ? ` · <span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  return `<div class="ep-row">
    <span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>
    <div class="info">
      <div class="t"><a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}</div>
      <div class="s">${showNameLink(item.show)} · ${fmtDur(item.duration_min)}${dateStr ? ` · ${esc(dateStr)}` : ""}${progHtml}</div>
    </div>
    ${inApp}${starBtn(item.id)}${upNextBtn(item.id)}${unavailable}
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
   the app. */
function notPlayableNote() {
  return `<span class="not-playable" title="4a could not get a playable audio file for this episode">Not available to play</span>`;
}

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
   star. */
function archivedRow(item, idx, ctx) {
  const named = !!item.title;
  const unavailable = named ? notPlayableNote() : "";
  const dateStr = named ? fmtDate(item.release_date) : "";
  return `<div class="ep-row gone">
    <span class="q-num">${idx + 1}</span>
    <div class="info">
      <div class="t">${named ? `<a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}` : "Part no longer in the catalogue"}</div>
      <div class="s">${named
        ? `${showNameLink(item.show)}${item.duration_min ? ` · ${fmtDur(item.duration_min)}` : ""}${dateStr ? ` · ${esc(dateStr)}` : ""} · not available right now`
        : "Saved before 4a kept episode details"}</div>
    </div>
    ${named ? starBtn(item.id) : ""}${named ? upNextBtn(item.id) : ""}${unavailable}
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
    parts.push(`${archived} part${one ? " is" : "s are"} not available right now, so ${one ? "it" : "they"} cannot play — ${one ? "it stays listed" : "they stay listed"} so you can see where it fits in the playlist.`);
  }
  if (unnamed) {
    const one = unnamed === 1;
    /* EVERY plural agrees, verbs included. The first draft pluralised the noun and
       not the verb, so a listener with exactly one gap read "if the episode
       return" — and the note a reviewer reads is never the one that ships to them.
       It also no longer claims rebuilding REPLACES this playlist: buildPlaylist
       mints a new id and prepends a new playlist, leaving this one untouched. */
    parts.push(`${unnamed} part${one ? " was" : "s were"} saved before 4a kept episode details and cannot be named yet — ${one ? "it" : "they"} will fill in if the episode${one ? " returns" : "s return"} to the catalogue, and building the same playlist again from the Playlists page gives you a fresh one from what 4a has today.`);
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
    $("#view").innerHTML = `<div class="page">
      <div class="page-head">
        <a class="back" href="#/playlists">‹</a>
        <div><h2>Playlist</h2></div>
      </div>
      <p class="note">Playlist not found.</p>
    </div>`;
    return;
  }
  fullPool(); // populate itemIndex
  const rows = resolveParts(p);
  /* An archived part goes into the snapshot cache under its own id so the rest of
     the app can describe it: without this, starring one is a no-op (toggleStar
     needs a snapshot) and a `picked` from one reports no topics.

     This is safe ONLY because liveness is `state.poolIds`, not "is in itemIndex".
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
  /* Played is an opened-or-not question, not a liveness one: a part played before
     it aged out stays played, and so does an unnamed one whose id is in history. */
  const played = rows.filter(r => hasOpened(r.item.id, history)).length;
  const ctx = (p.isSubject ? "subject-" : (p.isGenerated ? "generated-" : "playlist-")) + p.id;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${rows.length} episode${rows.length === 1 ? "" : "s"}${p.isSubject ? " · today's queue" : (p.isGenerated ? " · generated for you" : " playlist")} · ${played} played</p>
        </div>
      </div>
      ${p.sparse ? `<p class="note">Only found a few on this — here's what we've got.</p>` : ""}
      ${p.relaxed === "duration" ? `<p class="note">Couldn't match the length you asked for — here's what we found without it.</p>` : ""}
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
   episode" leaving 4a (mini-player's `openLink`, player/client.js). Same
   two-source pattern archivedRow already relies on: `state.itemIndex`
   first (freshest — populated by fullPool()/renderPlaylistDetail), then a
   `cp_saved` snapshot fallback (covers aged-out parts the pool no longer
   carries). No new fetch, no new data file — every field this page shows
   already lives on both sources. */
function resolveEpisode(id) {
  const pool = hydrationPool(); // populate/reuse itemIndex — never throws (#276)
  return pool[id] || savedMap()[id] || null;
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
  const s = Math.max(0, Math.round(Number(seconds) || 0));
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
  let out = "";
  let last = 0;
  DESC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DESC_TOKEN_RE.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const [whole, url, stamp] = m;
    if (url) {
      /* `safeUrl` returns "#" for any scheme but http(s), so a script-bearing
         or inline-data URL cannot become a live href here even though the regex
         above would not have matched one in the first place. Belt and braces,
         and it is the same helper every other href in this file goes through.
         (The scheme names are spelled around rather than written out: the
         `no ... URL is constructed anywhere in the source` invariant in
         test/app-security.test.js greps this file for them, comments included,
         and it is a better rule than any one comment's convenience.)
         `rel="noopener noreferrer"` because these point off our origin. */
      out += `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
    } else {
      const secs = parseTimestampSeconds(stamp);
      const inRange = secs !== null && (durationSec === null || secs <= durationSec);
      out += inRange
        ? `<button type="button" class="ep-ts" data-ts="${esc(String(secs))}" aria-label="Play from ${esc(stamp)}">${esc(stamp)}</button>`
        : esc(whole);
    }
    last = m.index + whole.length;
  }
  out += esc(src.slice(last));
  return out;
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
  const durationSec = item.duration_min ? item.duration_min * 60 : null;
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
        if (!window.ForayPlayer.isPlaying(item.id)) await window.ForayPlayer.play(item, "timestamp");
        await window.ForayPlayer.seekTo(secs);
      } catch (_) {
        /* A seek that cannot happen is not a reason to break the page — the
           same rule the rest of this file's playback bindings follow. */
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
    $("#view").innerHTML = statusPageHtml({ note: "Episode not found." });
    return;
  }
  // populate itemIndex/poolIds so "more from this show" rows can play in-app;
  // never throws — no catalogue yet is a reason to skip that row's play button,
  // not to lose the whole page (same rule hydrationPool already follows).
  if (state.session && state.session.episodes) {
    try { fullPool(); } catch (_) { /* catalogue not really there yet */ }
  }
  const dateStr = fmtDate(item.release_date);
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2 class="fp-s-title">${esc(item.title)}${explicitBadge(item.explicit)}</h2>
          <p class="fp-s-show">${item.show ? showNameLink(item.show) : ""}${item.duration_min ? ` · ${fmtDur(item.duration_min)}` : ""}${dateStr ? ` · ${esc(dateStr)}` : ""}</p>
        </div>
      </div>
      ${item.artwork_url ? `<img class="ep-art" src="${esc(safeUrl(item.artwork_url))}" alt="">` : ""}
      ${item.hook ? `<p class="fp-s-why">${esc(item.hook)}</p>` : ""}
      <div class="ep-actions">${item.audio_url ? playBtn(item) : notPlayableNote()}${starBtn(item.id)}${upNextBtn(item.id)}</div>
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
   playBtn/epRow-style playback, unchanged — no auto-advance chaining into the
   next Up Next item (plan §4, explicitly deferred). */
function renderQueue() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so a live queued item can play in-app
  const rows = queueRows();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Up Next</h2><p class="sub">${rows.length} queued</p></div>
      </div>
      ${rows.length
        ? rows.map((r, i) => upNextRow(r, i, rows.length)).join("")
        : `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"), { origin: "queue" });
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
  const inApp = playable ? playBtn(item) : "";
  const title = named ? esc(item.title) : "Episode no longer available";
  const sub = state === "live"
    ? `${esc(item.show)} · ${fmtDur(item.duration_min)}`
    : state === "archived"
      ? `${esc(item.show || "")}${item.duration_min ? ` · ${fmtDur(item.duration_min)}` : ""} · not available right now`
      : "Removed from your history — no details saved";
  return `<div class="ep-row up-next-row ${playable ? "" : "gone"}">
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

function bindUpNextReorder(scope) {
  scope.querySelectorAll("[data-reorder-up]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      moveQueueItem(btn.dataset.reorderUp, -1);
      renderQueue();
    });
  });
  scope.querySelectorAll("[data-reorder-down]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      moveQueueItem(btn.dataset.reorderDown, 1);
      renderQueue();
    });
  });
  scope.querySelectorAll("[data-dequeue]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      removeFromQueue(btn.dataset.dequeue);
      renderQueue();
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

function renderLibrary() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so saved/history rows can play in-app

  const savedRows = rowsForIds(Object.keys(savedMap()));
  const historyIds = pickedHistory().slice().reverse().slice(0, 20);
  const historyRows = rowsForIds(historyIds);
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
    ? `<div class="ep-row gone"><span class="q-num">${i + 1}</span><div class="info"><div class="t">No longer available</div><div class="s">Previously played, no longer available</div></div></div>`
    : rowHtml(r, i, "library-history");

  const savedHtml = savedRows.length
    ? savedRows.map((r, i) => rowHtml(r, i, "library-saved")).join("")
    : `<p class="note">Nothing saved yet — tap ☆ on an episode to keep it here.</p>`;

  const historyHtml = historyRows.length
    ? historyRows.map((r, i) => historyRowHtml(r, i)).join("")
    : `<p class="note">No listening history yet — episodes you play show up here.</p>`;

  const playlistsHtml = allPlaylists.length
    ? allPlaylists.slice(0, 5).map(p =>
        libSummaryRow(`/playlist/${p.id}`, p.title, `${resolveParts(p).length} part${resolveParts(p).length === 1 ? "" : "s"}`)).join("")
      + (allPlaylists.length > 5 ? `<a class="lib-more" href="#/playlists">All ${allPlaylists.length} playlists ›</a>` : "")
    : `<p class="note">No playlists yet — build one from the home screen.</p>`;

  const queueHtml = queued.length
    ? libSummaryRow("/queue", "Up Next", `${queued.length} queued`)
    : `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Library</h2><p class="sub">saved, history, playlists &amp; Up Next</p></div>
      </div>
      ${libSection("Saved", savedHtml)}
      ${libSection("Playlists", playlistsHtml)}
      ${libSection("Up Next", queueHtml)}
      ${libSection("History", historyHtml)}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
}

function renderPlaylists() {
  setBodyClass("view-page");
  const all = playlists();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Playlists</h2><p class="sub">${all.length} built</p></div>
      </div>
      <form id="pl-form" autocomplete="off">
        <input id="pl-input" type="text" maxlength="120" placeholder="build me a playlist…">
        <button type="submit">Go</button>
      </form>
      <p id="pl-note" class="note" hidden></p>
      ${all.length ? all.map(p => `
        <a class="pl-row" href="#/playlist/${esc(p.id)}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${resolveParts(p).length} parts${p.last_played_at ? ` · played ${new Date(p.last_played_at).toLocaleDateString()}` : ""}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — type above to build your first one.</p>`}
    </div>`;

  $("#pl-form").addEventListener("submit", bindPlaylistFormSubmit);
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
        title="Custom Forays aren't available yet">Foray</button>
  </div>
  <p class="note cr-foray-note">Custom Forays aren't available yet — you can still build a playlist below.</p>`;
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
function bindCreateFormSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.querySelector("input[type='text']");
  const btn = form.querySelector("button[type='submit']");
  const query = input.value.trim();
  if (!query) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building…";
  const note = $("#cr-note");
  if (note) note.hidden = true;
  setTimeout(() => {
    try {
      const result = buildPlaylist(query);
      logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0, source: "create" });
      if (result.status === "ok" || result.status === "sparse") {
        location.hash = "#/playlist/" + result.playlist.id;
      } else {
        if (note) {
          note.textContent = result.status === "unsaved"
            ? "That playlist could not be saved — this device has no storage space left. Removing a playlist you have finished with frees enough for a new one."
            : result.suggestions.length
              ? `Not much on "${query}" yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
              : `Not much on "${query}" yet — try different words.`;
          note.hidden = false;
        }
      }
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }, 0);
}

function renderCreate() {
  setBodyClass("view-page");
  $("#view").innerHTML = `
    <div class="page cr-page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Create</h2><p class="sub">Name a subject and we'll build a playlist from across the catalogue.</p></div>
      </div>
      ${createToggleHtml()}
      <form id="cr-form" autocomplete="off">
        <input id="cr-input" type="text" maxlength="120" placeholder="e.g. the semiconductor supply chain">
        <button type="submit">Build</button>
      </form>
      <div class="cr-suggestions">
        ${CREATE_SUBJECT_SUGGESTIONS.map(s => `<button type="button" class="cr-pill" data-cr-subject="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>
      <p id="cr-note" class="note" hidden></p>
    </div>`;

  $("#cr-form").addEventListener("submit", bindCreateFormSubmit);
  $("#view").querySelectorAll("[data-cr-subject]").forEach(btn => {
    btn.addEventListener("click", () => { $("#cr-input").value = btn.dataset.crSubject; $("#cr-input").focus(); });
  });
}

/* ---------- Forays (#128) ----------

   A Foray is one ordered run of 32 SEGMENTS drawn from nine episodes of five
   shows — not an episode, and not a playlist of episodes. The running order
   lives in data/forays.json, the timestamps in data/segments.json, the audio in
   data/segment-sources.json; the join, the queue and the position maths all
   live in player/foray-resolve.js, where they are tested. This section is the
   surface: it renders what that returns and drives the transport.

   ── The draft rule ────────────────────────────────────────────────────────
   Only a founder may publish a Foray (HUMAN-ACTIONS.md #2). As of 2026-08-30
   ONE is published — `capital-types-1` — so exactly one is listed for an
   ordinary visitor and the other three are not. The rule has not changed; the
   data has. (It used to read "every Foray is a draft, so none is listed", which
   is the sentence this change falsified.)

   A DRAFT is still reachable — by asking for one by id:

       https://jw-incorporated.github.io/foray/?foray=grilling-history-2

   That is the CURRENT grilling Foray (#226). `grilling-history-1` is still in
   the file and still opens, but it is marked `superseded_by` and is the
   61-minute assembly that drifted off plot, so it is the wrong link to hand
   anyone testing playback.

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
   founder action (HUMAN-ACTIONS.md #2) and the generator is not a founder.
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
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(window.ForayPlayer || null); } };
    window.addEventListener("forayplayer:ready", finish, { once: true });
    setTimeout(finish, PLAYER_WAIT_MS);
  });
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
  "Not into this topic", "Didn't like the voice", "Leans too far left",
  "Leans too far right", "Too surface-level", "Too in-the-weeds",
  "Bad audio quality", "Heard this already", "Just not this show",
];

function forayFeedback() { return lsGet("cp_foray_feedback", {}); }

function feedbackFor(segmentId) { return forayFeedback()[segmentId] || null; }

/** Record (or clear) a vote and emit the event. `reasons`/`note` only ever ride
    a down-vote — an up-vote has nothing to explain. */
function setFeedback(entry, direction, { reasons = [], note = "" } = {}) {
  const all = forayFeedback();
  const segId = entry.segment_id;
  if (!segId) return;
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
    // A thumb is an action the listener took, so it moves the same weights
    // playing something does — just harder, and in whichever direction.
    nudgeTopics([entry.topic], direction === "up" ? 0.08 : -0.08);
    trySyncEvents();
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
   what keeps "AI Narrator" from ever being asked to be a link. */
function forayShowId(entry) {
  if (!entry || isForayNarration(entry)) return null;
  if (entry.show_id && showById(entry.show_id)) return entry.show_id;
  return showIdForShowName(entry.show);
}

/* The credit that leads a row's meta line: a link to the show, the show's name
   as plain text when it does not join, or "AI Narrator" for a beat we wrote.

   "AI Narrator" is deliberately NOT a link. There is no 4a show page to send
   anyone to, and a control that navigates nowhere is worse than a label — the
   same rule `thumbsHtml` keeps. It carries the same class and sits in the same
   slot as a show credit so the two row kinds read as siblings: one credits a
   podcast, one credits us. */
function forayCreditHtml(entry) {
  if (isForayNarration(entry)) {
    return `<span class="fy-credit is-narrator">AI Narrator</span>`;
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
    ? `<a class="fy-credit show-link" href="#/show/${esc(showId)}">${esc(entry.show)}</a>`
    : `<span class="fy-credit">${esc(entry.show)}</span>`;
}

/** What a beat is called when it is spoken aloud — for the play button's
    accessible name and the thumbs'. The show and the beat's own `why` is what
    a listener would use to tell two rows apart; the curation code
    (`entry.label`) never was, and is no longer rendered anywhere on this page. */
function forayBeatName(entry) {
  if (isForayNarration(entry)) return "narration by 4a's AI Narrator";
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
        ? `<a class="show-link" href="#/show/${esc(showId)}">${esc(c.show)}</a>`
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

/* Expand a transcript in place. Bound once per render, on the list rather than
   per button, so a Foray with forty narration beats costs one listener.

   NOTHING REPAINTS THIS LIST, so nothing has to restore the open state:
   `paintForay` and `paintFeedback` — the only two things that touch the running
   order after it is built — toggle classes on elements they find, and never
   rewrite `innerHTML`. The list is built once by `renderForay`, which only runs
   on a route change, and a route change is supposed to forget. */
function bindForayScripts() {
  const view = $("#view");
  if (!view) return;
  view.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-script-for]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const text = view.querySelector(`#${CSS.escape(btn.dataset.scriptFor)}`);
    if (!text) return;
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    btn.textContent = open ? "Show more" : "Show less";
    text.classList.toggle("is-clamped", open);
  });
}

function forayRow(entry) {
  const dur = window.ForayPlayer ? window.ForayPlayer.fmtSpan(entry.duration_sec) : "";
  /* HTML, not text, and named so — the credit is a link when the show joins.
     The duration stays escaped text and is joined on afterwards so a credit
     that comes back empty (a beat with no show at all) does not leave a
     dangling separator. */
  const credit = forayCreditHtml(entry);
  const metaHtml = [credit, dur ? esc(dur) : ""].filter(Boolean).join(" · ");
  /* The credit line is hoisted OUT of the play button, because a link inside a
     button is invalid HTML whose click never survives the parent's handler —
     the same rule that put the thumbs outside it. It reads in the same place it
     always did: the 52px curation-code gutter that used to indent this line is
     gone, so the hoisted line lands flush left where the indented one used to
     start. */
  if (!entry.playable) {
    return `<div class="fy-row is-out">
      <div class="fy-meta">${metaHtml}</div>
      <div class="fy-play-row">
        <div class="fy-jump">
          <div class="fy-body">
            <p class="fy-why">${esc(entry.why)}</p>
            <p class="fy-out">Can't play: ${esc(entry.reason || "unresolved")}</p>
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
          aria-label="Play ${esc(forayBeatName(entry))}">
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
        `<button type="button" class="fy-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <input id="fy-sheet-note" type="text" maxlength="200" placeholder="Tell us in your own words…">
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
  sheet.querySelectorAll("[data-chip]").forEach(c => c.classList.remove("on"));
  syncSheetCta();
  sheet.hidden = false;
  document.body.classList.add("fy-sheet-open");
}

function closeFeedbackSheet() {
  // Dismissing must NOT record the down-vote — the mockup only commits it on
  // submit, and a vote with no reason is the signal this sheet exists to avoid.
  fbTarget = null;
  const sheet = $("#fy-sheet");
  if (sheet) sheet.hidden = true;
  document.body.classList.remove("fy-sheet-open");
}

function sheetPicks() {
  return [...$("#fy-sheet").querySelectorAll("[data-chip].on")].map(c => c.dataset.chip);
}

function syncSheetCta() {
  const any = sheetPicks().length > 0 || $("#fy-sheet-note").value.trim().length > 0;
  const go = $("#fy-sheet-go");
  go.disabled = !any;
  go.textContent = any ? "Tune my picks" : "Pick at least one";
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
    chip.addEventListener("click", () => { chip.classList.toggle("on"); syncSheetCta(); });
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
  const { credits, summary } = player.forayCredits(r, { discoverDoc: state.discover });
  if (!credits.length) return "";
  const clips = (n) => `${esc(String(n))} clip${n === 1 ? "" : "s"}`;
  const rows = credits.map(c => `
    <div class="fy-src">
      <div class="fy-src-head">
        <span class="fy-src-show">${showNameLink(c.show)}</span>
        <a class="fy-src-out" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener"
           data-src-show="${esc(c.show)}" aria-label="Open ${esc(c.show)} on Apple Podcasts">↗</a>
        <span class="fy-src-meta">${clips(c.clips)} · ${esc(player.fmtSpan(c.seconds))}</span>
      </div>
      <ul class="fy-src-eps">${c.episodes.map(e =>
        `<li>${esc(e.title)} <span>${clips(e.clips)}</span></li>`).join("")}</ul>
    </div>`).join("");
  return `<section class="fy-sources">
    <h3>Where this came from</h3>
    <p class="fy-src-note">${esc(summary)}. Every clip plays from the show's own feed, so the download counts for them.</p>
    ${rows}
  </section>`;
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
function forayRuntimeLabel(player, tally, totalSec) {
  if (tally && tally.estimated) return `about ${player.fmtSpan(totalSec)}`;
  return player.fmtClock(totalSec);
}

function forayHeadSub(r, player) {
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  const parts = [];
  if (tally) {
    const clips = `${tally.clips} clip${tally.clips === 1 ? "" : "s"}`;
    const from = tally.shows ? ` from ${tally.shows} show${tally.shows === 1 ? "" : "s"}` : "";
    parts.push(`${clips}${from}${tally.bridges ? ", with narration" : ""}`);
  }
  parts.push(forayRuntimeLabel(player, tally, r.totalSec));
  return parts.join(" · ");
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
    $("#view").innerHTML = statusPageHtml({ note: "The player didn't load.", back: "#/forays", retry: true });
    bindRetry($("#view"), () => renderForay(id));
    return;
  }
  if (!state.forays) {
    $("#view").innerHTML = statusPageHtml({ note: "Couldn't load forays right now.", back: "#/forays", retry: true });
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
    $("#view").innerHTML = statusPageHtml({ note: "That foray isn't available.", back: "#/forays" });
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
  const resume = typeof player.forayResume === "function"
    ? player.forayResume(r.id, { totalSec: r.totalSec, itemCount: r.playable.length, resolved: r })
    : null;
  state.forayResume = resume;
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
        <!-- Plain bars, replaced wholesale by the SegmentStrip component in
             mountForayStrip below (#128). They stay in the markup as the
             fallback for a page paired with an older cached module, and are the
             only reason this element is never empty. -->
        <div class="fy-strip" id="fy-strip">${r.playable.map((_, i) =>
          `<span class="fy-seg" data-seg="${i}"><i class="fy-seg-fill"></i></span>`).join("")}</div>
        <div class="fy-times"><span id="fy-now">0:00</span><span id="fy-total"></span></div>
        <div class="fy-controls">
          <button type="button" class="fy-btn" id="fy-prev" aria-label="Previous segment">‹‹</button>
          <button type="button" class="fy-btn fy-main" id="fy-play" aria-label="Play">▶ Play</button>
          <button type="button" class="fy-btn" id="fy-next" aria-label="Next segment">››</button>
          <!-- Playback speed (#242). On the transport row rather than in a settings
               screen, because this is the surface a listener is looking at when
               they decide a segment is slow — and its current value is the label,
               so it is legible without opening anything. The label and the
               accessible name both come from the player bridge, so this button and
               the mini-player's cannot word the same speed two ways. -->
          <button type="button" class="fy-btn fy-rate" id="fy-rate" aria-label="Playback speed">1×</button>
        </div>
        <!-- A start that failed says so HERE, and a screen reader hears it
             without moving focus off the button that was just pressed. -->
        <p class="fy-error" id="fy-error" role="status" aria-live="polite" hidden></p>
      </div>
      ${shownOut ? `<p class="note">${shownOut} clip${shownOut === 1 ? "" : "s"} can't play — marked below.</p>` : ""}
      ${missing ? `<p class="note">${missing} clip${missing === 1 ? "" : "s"} from this Foray couldn't be found, so ${missing === 1 ? "it's" : "they're"} left out.</p>` : ""}
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
  bindFeedback(r);
  bindForayScripts();
  bindSourceLinks(r);
  bindForayTransport(r, player, resume);
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
  const rect = strip.getBoundingClientRect();
  const x = e && typeof e.clientX === "number" ? e.clientX : null;
  if (x == null || !rect || !(rect.width > 0)) return null;
  const measured = stripElapsedFromBars(strip, x, rect, r);
  if (measured != null) return measured;
  const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return frac * r.totalSec;
}

/* The same question answered from the bars' own boxes, or null when they cannot
   answer it — a strip that has not been laid out, a bar count that disagrees
   with the queue, or a DOM whose elements do not report distinct geometry. Null
   rather than a confident wrong answer: the caller still has the flat map, which
   is approximate but never nonsense. */
function stripElapsedFromBars(strip, x, rect, r) {
  const bars = strip.children ? [...strip.children] : [];
  if (bars.length !== r.playable.length || bars.length === 0) return null;

  const boxes = [];
  let spanned = 0;
  for (const bar of bars) {
    if (typeof bar.getBoundingClientRect !== "function") return null;
    const box = bar.getBoundingClientRect();
    if (!box || !(box.width > 0)) return null;
    boxes.push(box);
    spanned += box.width;
  }
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

   THE SEEK IS NOT HERE EITHER. `#fy-strip`'s existing `click` handler
   (bound just above this call site) still does the seek, unchanged — a
   `click` fires at the release point whether or not this handler ever
   entered zoom, so "commit wherever the finger ended" falls out of the
   platform. This function must never call `foraySeek`/`startAt` itself,
   or the seek logic forks in two places that can drift.

   `setPointerCapture` keeps events routed to the strip even though scaling
   moves it visually out from under the finger mid-gesture — without it a
   drag toward the zoomed edge would silently stop delivering pointermove. */
function bindStripZoomScrub(r, player) {
  const strip = $("#fy-strip");
  const gest = player?.scrubGesture;
  if (!strip || !gest) return;

  let gesture = null;
  let holdTimer = null;
  let pointerId = null;
  let preZoomRect = null;

  const clearHoldTimer = () => {
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
  };

  /* `preZoomRect` is captured once, at pointerdown, before any zoom transform
     exists — re-measuring mid-zoom would feed the origin math a box already
     distorted by the previous frame's scale() (see zoomOriginPercent's own
     header). It is cleared on release so the next gesture measures fresh. */
  const applyZoomVisual = (clientX) => {
    if (!preZoomRect) preZoomRect = strip.getBoundingClientRect();
    const pct = gest.originPercent(clientX, preZoomRect);
    if (pct == null) return;
    // CSSOM, not a style attribute — the page CSP is style-src 'self', same
    // rule segment-strip.js and paintSegFill already live under.
    strip.style.setProperty("--zoom-origin", `${pct}%`);
    strip.style.setProperty("--zoom-scale", String(gest.ZOOM_SCALE));
    strip.classList.add("is-zooming");
  };

  /* The bubble's cloned content is built ONCE per gesture, at the moment it
     first opens — not per-frame — because it is a snapshot of the strip's
     bars (fill widths included), not a live mirror; a gesture is at most a
     few seconds and the underlying Foray position does not repaint the
     strip during a hold (the pointer has captured input). Re-cloning every
     pointermove would be wasted DOM churn for no visible difference. */
  const openBubble = (clientX, clientY) => {
    if (!preZoomRect) preZoomRect = strip.getBoundingClientRect();
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
    finish();
  });
  strip.addEventListener("pointercancel", (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    finish();
  });
}

/* The fill inside the bar the listener is currently inside — the one thing on
   this page that has to move continuously, and the reason it is painted above
   `paintForay`'s segment-change guard.

   It also makes the seam beat visible: for the 2.0 s between two segments the
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
const FY_AUTOPLAY_HINT = "Your browser held the audio back until it was sure you asked for it — press play again and it will start.";
const FY_START_FAILED = "That segment wouldn't load. Check the connection, then press play.";
/* A control that threw while the Foray was already running is a third thing, and
   it must not claim a segment failed to load: nothing did, the audio is still
   going, and the honest report is that the button did not take. */
const FY_TAP_FAILED = "That control didn't take. Try it again, or reload the page if it keeps happening.";

function forayFailureCopy(signal) {
  return /NotAllowedError/.test(String(signal ?? "")) ? FY_AUTOPLAY_HINT : FY_START_FAILED;
}

/** Say it on the page. `signal` is whatever evidence there is — the player's own
    error line, or a caught exception — and null clears the line. */
function paintForayFailure(signal) {
  const err = $("#fy-error");
  if (!err) return;
  err.hidden = !signal;
  err.textContent = signal ? forayFailureCopy(signal) : "";
  // A browser being careful about audio is not an error, and must not be dressed
  // as one. styles.css tones `.is-hint` down to a note.
  err.classList.toggle("is-hint", Boolean(signal) && forayFailureCopy(signal) === FY_AUTOPLAY_HINT);
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
    const line = $("#fy-error");
    if (line) {
      line.hidden = false;
      line.textContent = FY_TAP_FAILED;
      line.classList.remove("is-hint");
    }
    // Last, for the reason given in `guardForayStart` above.
    noteTapFailure("control", err);
    return null;
  }
}

function bindForayTransport(r, player, resume = null) {
  const onChange = (s) => paintForay(s);

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
  const startOrResume = () => resume ? startAt(resume.elapsedSec) : start(0);

  $("#fy-restart")?.addEventListener("click", async () => {
    if (typeof player.clearForayResume === "function") player.clearForayResume(r.id);
    logEvent("foray_restart", { foray_id: r.id, from_sec: Math.round(resume?.elapsedSec || 0) });
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
    ["#fy-play", "#fy-next", "#fy-prev"].forEach(sel => { $(sel).disabled = true; });
    $("#fy-play").textContent = "Nothing to play";
    return;
  }

  $("#fy-play").addEventListener("click", async () => {
    if (playerHasForay(r)) return guardForayTap(() => player.forayToggle());
    // Only the real start is an event. Logging a pause as a play is the kind of
    // small lie that makes a metric useless six months later.
    logEvent("foray_play", {
      foray_id: r.id, segments: r.playable.length,
      resumed_from_sec: resume ? Math.round(resume.elapsedSec) : null,
    });
    await startOrResume();
  });
  // Before anything has started, every transport button means "start it" — a
  // next that begins at segment 2 silently drops the opening of the Foray.
  $("#fy-next").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayNext()) : startOrResume());
  $("#fy-prev").addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayPrevious()) : startOrResume());

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
  $("#fy-strip").addEventListener("click", async (e) => {
    /* Position FIRST, and only then look for a bar. The strip is 32 bars with a
       2px gap between each, which is roughly a fifth of its width — requiring a
       `[data-seg]` hit before reading the coordinate made every one of those
       gaps a dead zone, and "a click anywhere on it is a position in the hour"
       has to be true or the control is lying. */
    const at = stripElapsedAt(e, r);
    if (at != null) {
      if (playerHasForay(r)) return guardForayTap(() => player.foraySeek(at));
      return startAt(at);
    }
    // No coordinate to work from (a synthetic or assistive click). Fall back to
    // the bar that was hit, which is what the strip did before it could scrub.
    const seg = e.target.closest("[data-seg]");
    if (!seg) return;
    const index = Number(seg.dataset.seg);
    return playerHasForay(r) ? guardForayTap(() => player.forayJump(index)) : start(index);
  });

  bindStripZoomScrub(r, player);

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
  btn.textContent = label;
  btn.setAttribute("aria-label", aria);
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
  document.body.appendChild(wrap);
  document.body.classList.add("fy-sheet-open");

  const close = () => {
    wrap.remove();
    document.body.classList.remove("fy-sheet-open");
  };
  scrim.addEventListener("click", close);
  cancel.addEventListener("click", close);
}

/** The only thing that changes 4x a second. Deliberately not a re-render: the
    running order is 32 rows and rebuilding it would fight the scroll position
    and drop focus. */
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
    // for the two seconds the silence lasts. Labelling those two seconds
    // "Loading…" would be the app apologising for its own edit.
    const running = s.playing || s.gap;
    const started = live || elapsed > 0;
    const label = running ? "❚❚ Pause" : (s.loading ? "Loading…" : (started ? "▶ Resume" : "▶ Play"));
    playBtn.textContent = label;
    playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
  }
  // The beat, for CSS: the strip holds still at a boundary for 2.0 s and this
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
  paintForayFailure(s.error);

  /* V-01: the live-narration counterpart of Audition's own notice. Only
     shown when there is no real error already claiming the line — a load
     failure is the more urgent message, and this one is informational
     ("still working, just not with the exact voice you picked"). Reuses the
     `fy-error`/`is-hint` styling `paintForayFailure` already tones down for
     the autoplay case, rather than inventing a second notice element on this
     page.

     SELF-CONTAINED, not dependent on `paintForayFailure`'s own hiding
     behaviour: the `else` branch explicitly hides/clears the line when the
     fallback flag is false, rather than relying on the call above having
     already hidden it for its own unrelated reason. Painted only once per
     fallback, not every tick: `paintForay` itself is already gated on
     `state.forayPainted` below for the segment highlight, but this line has
     to show up (and clear) on the FIRST tick either way, which can be before
     that gate's own early return — so it is checked here, ahead of it. */
  if (!s.error) {
    const err = $("#fy-error");
    if (err) {
      if (s.voiceFallback) {
        err.hidden = false;
        err.textContent = "Your chosen voice isn't installed; using the best available.";
        err.classList.add("is-hint");
      } else if (err.classList.contains("is-hint")) {
        // Only clear a hint THIS block painted — a real, non-hint error from
        // `paintForayFailure` above must not be erased by this branch.
        err.hidden = true;
        err.textContent = "";
        err.classList.remove("is-hint");
      }
    }
  }

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
    row.classList.toggle("is-playing", i === liveIndex);
    row.classList.toggle("is-played", mark >= 0 && i < mark);
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
function forayListHtml() {
  const list = forayCards();
  if (!list.length) return "";
  return `<div class="fy-home">${list.map(f => `
    <a class="fy-home-row" href="#/foray/${esc(f.id)}">
      <span class="fy-home-kicker">foray${f.status === "published" ? "" : " · draft"}</span>
      <span class="fy-home-title">${esc(f.title)}</span>
    </a>`).join("")}</div>`;
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
      const restored = window.ForayPlayer?.restoreLastEpisode?.();
      if ((restored || late) && isHomeRoute()) renderCurrentPage();
    } catch (_) { /* a ribbon that cannot be restored is not a reason to fail boot */ }
  };
  if (window.ForayPlayer) go(false);
  else window.addEventListener("forayplayer:ready", () => go(true), { once: true });
}

/** True when the current route is the home screen — the only page whose content
    changes as a result of the restore. */
function isHomeRoute() {
  const h = location.hash || "#/";
  return h === "#/" || h === "#";
}

function forayResumeRows() {
  if (typeof window.ForayPlayer?.forayResumeList !== "function") return [];
  const visible = new Set(forayCards().map(f => f.id));
  /* `foraysDoc` is FD-05: a row whose Foray is no longer in the directory reads
     `drift: "dropped"` and is not offered — the visibility set below already
     excludes it (it is not listed), and the drift is what a test can name. */
  return window.ForayPlayer.forayResumeList({ foraysDoc: state.forays })
    .filter(p => visible.has(p.id) && p.drift !== "dropped" && !p.finished && p.label)
    .slice(0, 3);
}

function jumpBackInHtml(rows) {
  if (!rows.length) return "";
  return `<div class="fy-home fy-jbi">${rows.map(p => `
    <a class="fy-home-row fy-jbi-row" href="#/foray/${esc(p.id)}">
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
    `<a class="drawer-item" href="#/playlist/${esc(p.id)}">${esc(p.title)}</a>`).join("")
    || `<p class="drawer-empty">none yet</p>`;
  /* Every switch's label, from the one registry `drawerToggle` fills. This was
     five ad-hoc lines — three unguarded, two guarded, each spelling its own
     on/off — and the sixth switch is what made that a shape rather than a
     list (finding 6, client audit 2026-09-12). */
  paintDrawerToggles();
  /* K-01: whether the RUN button exists at all. The toggle's own label is
     painted above with the others; this is the control that appears and
     disappears with it, which no label line can express. */
  syncVoiceProbeRun();
}

function openDrawer(open) {
  $("#drawer").hidden = !open;
  $("#drawer-overlay").hidden = !open;
  if (open) renderDrawer();
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

/** Which tab a hash belongs to, for highlighting `aria-current`. Every one
    of today's 13 routes maps to exactly one tab — Home, everything shows/
    episode/category-shaped to Search, playlist/subject-queue-shaped to
    Create, and library/queue/forays-shaped to Library — so switching tabs
    is a real, memorable destination rather than a guess. Returns null for
    a hash this mapping does not recognise (there is none today, but a
    future route landing here with no owner should highlight nothing rather
    than guess wrong). */
function tabForHash(hash) {
  const h = hash || "#/";
  if (h === "#/") return "home";
  if (/^#\/(shows$|show\/|category\/|starred-shows$)/.test(h)) return "search";
  if (/^#\/(playlists$|playlist\/|subject\/|create$)/.test(h)) return "create";
  if (/^#\/(library$|queue$|forays$|foray\/)/.test(h)) return "library";
  if (/^#\/episode\//.test(h)) return "search"; // reached from a show/search result
  return null;
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
    document.body.append(bar);
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
 */
function drawerToggle(id, label, read, write, { words = ["off", "on"], repaint = false } = {}) {
  const drawer = $("#drawer");
  if (!drawer) return;
  if (!drawerToggles.some(t => t.id === id)) drawerToggles.push({ id, label, read, words });
  let btn = $("#" + id);
  if (!btn) {
    btn = ddEl("button", "drawer-item as-btn", "");
    btn.type = "button";
    btn.id = id;
    drawer.appendChild(btn);
  }
  if (btn._drawerToggleBound) return; // init() runs once, but a re-bind must never stack handlers
  btn._drawerToggleBound = true;
  btn.addEventListener("click", () => {
    write(!read());
    renderDrawer();
    if (repaint) renderCurrentPage();
  });
}

/** Every registered switch's label, read fresh. Guarded per element because a
    page can mount without one (a harness with a partial drawer) — the three
    unguarded lines this replaced threw on exactly that. */
function paintDrawerToggles() {
  for (const t of drawerToggles) {
    const btn = $("#" + t.id);
    if (btn) btn.textContent = `${t.label}: ${t.words[t.read() ? 1 : 0]}`;
  }
}

/** The six, in the drawer's reading order: the listener's three from
    index.html, the listener's fourth (the jingle) appended, then the two
    founder switches. The diagnostic and destructive controls `init()` binds
    after these are not switches and stay below them. */
function bindDrawerToggles() {
  drawerToggle("family-toggle", "Family mode", familyMode, (on) => {
    lsSet("cp_family", on);
    logEvent("family_mode", { on });
    buildCards();
  }, { repaint: true });

  /* Not an on/off: the two states are two destinations, and "Open in: off"
     would be nonsense. `words` is why the helper takes a pair rather than
     hard-coding the two English words at five call sites. */
  drawerToggle("player-toggle", "Open in", () => playerPref() === "apple", (on) => {
    lsSet("cp_player", on ? "apple" : "pocketcasts");
    logEvent("player_pref", { player: playerPref() });
  }, { words: ["Pocket Casts (show page)", "Apple Podcasts"], repaint: true });

  drawerToggle("autoadvance-toggle", "Up Next auto-advance", autoAdvanceOn, (on) => {
    lsSet("cp_autoadvance", on);
    logEvent("autoadvance_pref", { on });
  });

  /* §13's jingle (player/interlude.js). THE CONTROL THE PRIVACY POLICY ALREADY
     PROMISED: `docs/legal/privacy-policy.md` lists `cp_interlude` as "On unless
     you turn it off", and until the 2026-09-12 client audit there was no way to
     turn it off — `writeInterludePref` and `PlayerQueueManager.setInterludeEnabled`
     were each called from their own test and nowhere else, and `client.js` read
     the key once at boot. A disclosed setting with no surface is a disclosure
     that is not true. */
  drawerToggle("interlude-toggle", "Jingle between segments", interludeOn, setInterludeOn);

  /* The founder's test track (see § showDraftsOn). No event is logged: this is
     his own switch, not listener behaviour worth a row. */
  drawerToggle("drafts-toggle", "Show draft Forays", showDraftsOn,
    (on) => lsSet("cp_show_drafts", on), { repaint: true });

  /* K-01's measurement switch (see § voiceProbeOn). Its RUN button is not a
     switch and is added/removed by `syncVoiceProbeRun` instead. */
  drawerToggle("voice-probe-toggle", "Voice engine probe", voiceProbeOn,
    (on) => lsSet("cp_voice_probe", on));
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
  else drawer.appendChild(run);
  run.addEventListener("click", () => runVoiceProbe());
}

/** Run the probe and show its numbers where the founder can copy them: the
    Playback-diagnostics sheet, which is already the one copyable surface on
    the phone (HUMAN-ACTIONS.md #21). The record is written into `cp_diag` by
    `ForayPlayer.runVoiceProbe()` itself, so the sheet's own refresh picks it
    up — this function opens the sheet and paints the human-readable summary
    into its status line so the answer is legible before anyone scrolls.

    GUARDED THE SAME WAY EVERY FORAY TAP IS (#225): a rejected promise here
    must not become a console line nobody has open. */
async function runVoiceProbe() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  ui.status.textContent = "Running the voice probe — this takes about 90 seconds.";
  if (!player || typeof player.runVoiceProbe !== "function") {
    ui.status.textContent = "The player module has not loaded on this page, so the probe cannot run.";
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
        the way that count did.
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
  "subscriptions", "taxonomy_nodes", "app_users",
];

/** Three outcomes per table, and the difference between them is the whole
    honesty of this feature. `absent` is a 404: the table is not in this project's
    API at all, so it holds no rows of ours — a true statement, not a shrug. */
const DEL_DELETED = "deleted";
const DEL_ABSENT = "absent";
const DEL_FAILED = "failed";

/**
 * The account this device already has — never a new one.
 *
 * `ensureAnonSession()` signs up when it finds no token, which is right for
 * syncing and absurd here: creating an account in order to delete one would
 * leave a fresh row behind and delete nothing. A stale token is refreshed if we
 * can; if the refresh fails we try the token we have and let the server's answer
 * be the answer.
 */
async function existingAnonSession() {
  const now = Math.floor(Date.now() / 1000);
  const s = lsGet("cp_sb_session", null);
  if (!s || !s.access_token || !s.user_id) return null;
  if (s.expires_at && s.expires_at - 60 > now) return s;
  if (s.refresh_token) {
    const r = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    if (r && r.access_token) {
      /* `r.user.id` is not assumed to exist. A refresh response without a `user`
         object is not a shape we have seen, but reading through it would throw a
         TypeError out of the whole deletion — and the id we already hold is the
         same account by definition, since this is a refresh of its own token. */
      return {
        user_id: (r.user && r.user.id) || s.user_id,
        access_token: r.access_token,
        refresh_token: r.refresh_token || s.refresh_token,
        expires_at: r.expires_at || now + 3600,
      };
    }
  }
  return s;
}

/** One authenticated DELETE, filtered to this account's own rows. */
async function sbDeleteOwnRows(table, session) {
  const url = `${SB_URL}/rest/v1/${table}?user_id=eq.${encodeURIComponent(session.user_id)}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + session.access_token,
        Prefer: "return=minimal",
      },
    });
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
 * Delete every server row this device's account owns.
 *
 * `ok` is false if ANY table refused, and the caller must then not clear local
 * storage — see the ordering rules above.
 */
async function deleteRemoteData() {
  const session = await existingAnonSession();
  if (!session) return { ok: true, attempted: false, tables: [], deleted: 0 };
  const tables = [];
  for (const t of SB_USER_TABLES) tables.push(await sbDeleteOwnRows(t, session));
  const failed = tables.filter(r => r.state === DEL_FAILED);
  return {
    ok: failed.length === 0,
    attempted: true,
    tables,
    failed,
    deleted: tables.filter(r => r.state === DEL_DELETED).length,
  };
}

/**
 * Clear both local tiers.
 *
 * The real work is `DurableStore.purge()`, which enumerates the tiers rather
 * than the facade and verifies afterwards. The fallback below matters and is not
 * decoration: app.js and `player/client.js` deploy independently through the
 * service worker, so a page can be running with no store published — and then
 * `localStorage` is reachable and IndexedDB is not. That case reports `ok: false`
 * with a reason, because a cleared mirror is not cleared storage.
 */
async function clearLocalData() {
  /* FIRST, AND HERE RATHER THAN IN `stopForDataDeletion()` (#264). `purge()` empties
     both tiers of every `cp_` key including `cp_diag`, but the player module holds
     that ring IN MEMORY — so without this the next time the listener pockets their
     phone, the record is written straight back under a key they just asked to be
     emptied. It belongs in THIS function and not in the stop, because the stop runs
     before the server step and a remote failure leaves the device untouched on
     purpose; clearing there destroyed the record on a path that promises not to. */
  try {
    if (typeof window.forayForgetDiagnostics === "function") window.forayForgetDiagnostics();
  } catch (_) { /* a diagnostic that will not clear is not a reason to refuse a deletion */ }

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
  if (state === "unconfirmed") return "Type DELETE to confirm.";
  if (state === "busy") return "Deleting…";
  if (state === "remote-failed") {
    return "Your server rows were NOT deleted. Nothing on this device was touched, so you can try again.";
  }
  const server = remote && remote.deviceOnly
    ? "Your rows on our server were left in place, as you chose."
    : !remote || !remote.attempted
      ? "No account token was on this device, so no server rows were reachable."
      : "Your rows on our server are deleted.";
  if (local && local.ok) return `Done. ${server} This device is clear.`;
  const why = local && local.reason === "no-durable-tier"
    ? "The durable copy is out of reach. Reload and try again."
    : local && local.reason === "no-storage"
      ? "This browser has taken storage away."
      : local && local.reason === "purge-failed"
        ? `Storage refused the delete (${local.error || "error"}).`
        : `${(local && local.remaining ? local.remaining.length : 0)} key(s) would not clear.`;
  return `${server} This device is NOT fully clear. ${why}`;
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
  "This device: every 4a key, in both storage layers.",
  "Our server: the events this device sent, and its account rows.",
  "Your anonymous account row stays. It holds no name, email or phone number.",
  "Publisher and ad hosts saw your IP as audio played. We cannot delete that.",
];

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

  const status = ddEl("p", "dd-status");
  status.id = "dd-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  panel.append(
    ddEl("div", "fy-grab"), title,
    ddEl("p", "fy-sheet-sub", "This cannot be undone. Here is what it covers."),
    list, label, input, actions, deviceOnly, status,
  );
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, input, go, cancel, deviceOnly, status };
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
  ddBusy = false;
  syncDeleteCta();
  ui.root.hidden = false;
  document.body.classList.add("fy-sheet-open");
}

function closeDeleteSheet() {
  if (!ddUi || ddBusy) return;     // never vanish mid-delete
  ddUi.root.hidden = true;
  ddUi.input.value = "";
  syncDeleteCta();
  document.body.classList.remove("fy-sheet-open");
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
    route();
    return out;
  } finally {
    ddBusy = false;
    syncDeleteCta();
  }
}

function paintDeletion(result) {
  if (!ddUi) return;
  ddUi.status.textContent = deletionMessage(result);
  ddUi.deviceOnly.hidden = result.state !== "remote-failed";
  syncDeleteCta();
}

/* ---------- V-01: the narration voice picker ----------

   `docs/ios-controls-and-voice-plan.md` V-01. A drawer item — "Narration
   voice" — built and bound the same way `bindDiagnosticsControl()`/
   `bindDeleteControl()` are: appended in JS above "Delete my data", because
   `index.html`'s drawer markup is outside this card's owned files (same
   constraint `ensureInterestsDrawerLink` states). Placed BELOW "Playback
   diagnostics", which the card's own text asks for ("next to Playback
   diagnostics"), and above the two destructive/settings toggles at the
   bottom for the same "a scrolled thumb lands here" reason those two apply
   to each other.

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
    be confirmed says "unverified name" in its own description rather than
    guessing; if it never shows up as installed after a download, the name is
    wrong, not the download. Descriptions are accent · gender · tier only:
    which voices ship compact-by-default on iOS 18 is NOT verified here, so
    no row claims it. */
const VOICE_ALLOWLIST = Object.freeze([
  { name: "Samantha", about: "American \u00b7 female \u00b7 the default; Enhanced tier is a free download" },
  { name: "Allison", about: "American \u00b7 female \u00b7 Enhanced (download)" },
  { name: "Susan", about: "American \u00b7 female \u00b7 Enhanced (download)" },
  { name: "Joelle", about: "American \u00b7 female \u00b7 Enhanced (download)" },
  { name: "Tom", about: "American \u00b7 male \u00b7 Enhanced (download)" },
  { name: "Nicky", about: "American \u00b7 female \u00b7 Enhanced (download) \u00b7 unverified name" },
  { name: "Aaron", about: "American \u00b7 male \u00b7 Enhanced (download) \u00b7 unverified name" },
  { name: "Daniel", about: "British \u00b7 male \u00b7 Enhanced (download)" },
  { name: "Serena", about: "British \u00b7 female \u00b7 Enhanced/Premium (download)" },
  { name: "Karen", about: "Australian \u00b7 female \u00b7 Enhanced/Premium (download)" },
  { name: "Moira", about: "Irish \u00b7 female \u00b7 Enhanced (download)" },
  { name: "Tessa", about: "South African \u00b7 female \u00b7 Enhanced (download)" },
  { name: "Rishi", about: "Indian \u00b7 male \u00b7 Enhanced (download)" },
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
    seconds" would be a claim this text cannot back up at whatever playback
    speed the listener has chosen. */
const AUDITION_LINE = "one, two, three, four, five, six, seven, eight, nine, ten.";

let voiceUi = null;
let voiceState = { voices: [], path: "none", loading: false, selected: null, auditioning: null, notice: "" };

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

  const sub = ddEl("p", "fy-sheet-sub",
    "Pick which voice reads 4a's narration. Tap Audition to hear it count to ten at your current playback speed. Greyed voices are free downloads \u2014 fetch one in Settings and it appears here when you return.");

  const list = ddEl("div", "voice-list");
  list.id = "voice-list";

  const notice = ddEl("p", "dd-status voice-notice");
  notice.id = "voice-notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.hidden = true;

  const actions = ddEl("div", "fy-sheet-actions");
  const close = ddEl("button", "fy-sheet-cancel", "Close");
  close.type = "button";
  actions.append(close);

  panel.append(ddEl("div", "fy-grab"), title, sub, list, notice, actions);
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, list, notice, close };
}

function voiceSheet() {
  if (!voiceUi) voiceUi = buildVoiceSheet();
  return voiceUi;
}

/** One row: an installed voice (selectable, with Audition) or a recommended
    name that is not installed (greyed, with the Settings path and an Open
    Settings button). Built with createElement/textContent like every other
    sheet in this file — the CSP is strict and index.html is out of reach. */
function buildVoiceRow({ installed, name, sub, id, selected }) {
  const row = ddEl("div", `voice-row${installed ? "" : " voice-row-missing"}${selected ? " voice-row-selected" : ""}`);
  row.setAttribute("role", installed ? "radio" : "listitem");
  if (installed) row.setAttribute("aria-checked", selected ? "true" : "false");

  const text = ddEl("div", "voice-row-text");
  text.append(ddEl("div", "voice-row-name", name), ddEl("div", "voice-row-sub", sub));
  row.append(text);

  if (installed) {
    const btn = ddEl("button", "voice-row-audition", voiceState.auditioning === id ? "Playing\u2026" : "Audition");
    btn.type = "button";
    btn.disabled = voiceState.auditioning === id;
    btn.addEventListener("click", (e) => { e.stopPropagation(); return auditionVoiceRow(id); });
    row.append(btn);
    row.addEventListener("click", () => selectVoiceRow(id));
    row.tabIndex = 0;
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectVoiceRow(id); }
    });
  } else {
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
  for (const entry of curateVoices(voiceState.voices)) {
    const v = entry.installed;
    if (v) {
      rows.push(buildVoiceRow({
        installed: true,
        name: entry.name,
        sub: `${entry.about} \u00b7 ${voiceQualityLabel(v)} \u00b7 ${v.language || "unknown language"}`,
        id: v.identifier,
        selected: v.identifier === selected,
      }));
      continue;
    }
    /* Web Speech (`path: "web-speech"`) has no install state at all: no
       greyed section, no Open Settings button, per the design comment. Only
       a native path (`"native"`) can honestly say "not downloaded". */
    if (voiceState.path !== "native") continue;
    rows.push(buildVoiceRow({
      installed: false,
      name: entry.name,
      sub: `${entry.about} \u00b7 Not downloaded \u2014 ${VOICE_SETTINGS_PATH}`,
    }));
  }

  ui.list.innerHTML = "";
  if (voiceState.loading) {
    ui.list.append(ddEl("p", "voice-loading", "Looking for voices\u2026"));
  } else if (!rows.length) {
    ui.list.append(ddEl("p", "voice-loading",
      voiceState.voices.length
        ? "None of 4a's trial voices are installed here."
        : "No voices reported by this device."));
  } else {
    rows.forEach((r) => ui.list.append(r));
  }
}

async function refreshVoiceList() {
  const player = window.ForayPlayer;
  if (!player || typeof player.listVoices !== "function") return;
  voiceState.loading = true;
  paintVoiceList();
  try {
    const out = await player.listVoices({ lang: VOICE_LIST_LANG });
    voiceState.voices = (out && out.voices) || [];
    voiceState.path = (out && out.path) || "none";
  } catch (_) {
    voiceState.voices = [];
    voiceState.path = "none";
  } finally {
    voiceState.loading = false;
    paintVoiceList();
  }
}

function selectVoiceRow(id) {
  const player = window.ForayPlayer;
  if (!player || typeof player.setNarrationVoice !== "function") return;
  player.setNarrationVoice(id);
  logEvent("voice_pref", { voice: id });
  paintVoiceNotice("");
  paintVoiceList();
}

/** V-01's Audition: speak the fixed counting line, in this row's voice, at
    the current playback speed — doubling as H3's stopwatch test. Guarded the
    same way every Foray tap is (#225): a rejected promise here must not
    become a console line nobody has open. */
async function auditionVoiceRow(id) {
  const player = window.ForayPlayer;
  if (!player || typeof player.auditionVoice !== "function") return;
  voiceState.auditioning = id;
  paintVoiceList();
  try {
    const result = await player.auditionVoice(AUDITION_LINE, id);
    if (result && result.voiceFallback) {
      paintVoiceNotice("Your chosen voice isn't installed; using the best available.");
    } else {
      paintVoiceNotice("");
    }
  } catch (_) {
    paintVoiceNotice("That voice could not be auditioned. Try again.");
  } finally {
    voiceState.auditioning = null;
    paintVoiceList();
  }
}

function openVoiceSheet() {
  const ui = voiceSheet();
  paintVoiceNotice("");
  ui.root.hidden = false;
  document.body.classList.add("fy-sheet-open");
  refreshVoiceList();
}

function closeVoiceSheet() {
  if (!voiceUi) return;
  voiceUi.root.hidden = true;
  document.body.classList.remove("fy-sheet-open");
}

/** Appended to the drawer at startup, next to "Playback diagnostics" per the
    card's own text, and ABOVE it in the drawer's build order (see
    `bindDiagnosticsControl`'s own comment for the "field record must stay
    just above Delete my data" rule this respects). Bound once. */
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
  "What the player measured on this device: seam gaps, load deadlines, "
  + "out-point overshoot, stops, resume decisions, and any press that didn't take. "
  + "It is stored on this device only and is never sent anywhere. "
  + "Copy it into a bug report.";

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

function refreshDiagSheet() {
  const ui = diagSheet();
  ui.text.value = diagText();
}

function openDiagSheet() {
  const ui = diagSheet();
  refreshDiagSheet();
  ui.status.textContent = "";
  ui.root.hidden = false;
  document.body.classList.add("fy-sheet-open");
}

function closeDiagSheet() {
  if (!diagUi) return;
  diagUi.root.hidden = true;
  document.body.classList.remove("fy-sheet-open");
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

/** Appended to the drawer at startup, ABOVE "Delete my data" — see the note in
    `init()`. Bound once, like the control below it. */
function bindDiagnosticsControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#diag-open")) return;
  const btn = ddEl("button", "drawer-item as-btn", "Playback diagnostics");
  btn.type = "button";
  btn.id = "diag-open";
  drawer.appendChild(btn);
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
  return m ? decodeURIComponent(m[1]) : null;
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
  if (!id || (h && h !== "#/")) return;
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}#/foray/${encodeURIComponent(id)}`);
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
  resetPageHeadScrollState();
  const h = location.hash || "#/";
  const forayId = forayRouteId();
  let m;
  if (forayId) renderForay(forayId);
  else if ((m = /^#\/playlist\/(.+)$/.exec(h))) renderPlaylistDetail(m[1]);
  else if ((m = /^#\/subject\/(.+)$/.exec(h))) renderPlaylistDetail("subject-" + m[1]);
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
  else if ((m = /^#\/show\/(.+)$/.exec(h))) renderShow(decodeURIComponent(m[1]));
  else if ((m = /^#\/category\/(.+)$/.exec(h))) renderCategory(decodeURIComponent(m[1]));
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
   here would make the four-tap-deep browse that `navStack` exists to support
   useless. `noteNavigation` already knows which kind of step this is (it pops
   for a back-step and pushes for a forward one), so it now says so, and a
   back-step lands on the remembered position instead of the top.

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
  const h = location.hash || "#/";
  const step = noteNavigation(h);
  /* Read BEFORE the render: renderCurrentPage() replaces #view's innerHTML,
     and a shorter page clamps window.scrollY on the spot. */
  const target = step === "back" ? (navScrollY.get(h) || 0) : 0;
  renderedHash = h;
  /* To the top first, THEN render: the new page is laid out with the viewport
     already where it is going rather than painted and yanked. */
  scrollPageTo(0);
  openDrawer(false);
  renderCurrentPage();
  if (target > 0) scrollPageTo(target);
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
   session — the same cardinality `navStack` already lives with. */
const navScrollY = new Map();
let renderedHash = null;

function rememberScrollPosition() {
  if (renderedHash === null) return;
  navScrollY.set(renderedHash, window.scrollY || 0);
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

   "Is there a step to go back to" is tracked here rather than asked of the
   browser: `history.length` counts entries from before the app loaded, and
   there is no reliable "canGoBack" available across every WebKit this ships
   to. So route() notes every hash it renders in `navStack`. Landing back on
   the hash that was two steps ago pops the stack (a real back-step);
   anything else pushes (a forward-step). More than one entry on the stack
   means `history.back()` lands inside the app; exactly one means the
   current page is the first the app rendered this session (or after a
   reload — reloading always resets the stack), so ‹ falls back to the
   href and goes Home, which is the correct behavior for a cold open. */
const navStack = [];

/** Records the step and REPORTS WHICH KIND IT WAS: "back" for a step the
    stack recognises as the page behind this one, "same" for a re-render of the
    hash already on top of the stack, "forward" for everything else.

    The return value is new; the bookkeeping is not one line different. It
    exists because route() needs to know the same thing this function already
    had to work out in order to decide whether to scroll the new page to the
    top — a back-step must keep the browser's own restored position (see
    route()'s comment), and re-deriving that from the stack at the call site
    would be a second, drifting copy of the rule below. */
function noteNavigation(hash) {
  backPending = false;
  const h = hash || "#/";
  if (navStack.length >= 2 && navStack[navStack.length - 2] === h) { navStack.pop(); return "back"; }
  if (navStack[navStack.length - 1] === h) return "same";
  navStack.push(h);
  return "forward";
}

function canGoBackInApp() { return navStack.length > 1; }

/* `history.back()` is asynchronous — the `hashchange` that actually pops the
   stack lands a beat later. A second tap on ‹ inside that beat would still
   see the pre-pop stack and call `history.back()` twice, overshooting by one
   page. `backPending` makes it one step per tap no matter how fast the taps
   land; `noteNavigation` (called from every route()) clears it once the step
   has actually happened. */
let backPending = false;

/* After removing a playlist: back to the list. When the list is the step
   immediately behind this page (the ordinary way in — Playlists ->
   this playlist), that is `history.back()`, which leaves the now-removed
   playlist's entry BEHIND the list rather than pushing a fresh one in
   front of it — otherwise the very next ‹ tap from the list would land
   back on a playlist that no longer exists. From anywhere else (e.g. a
   drawer link straight into a specific playlist, with no list entry behind
   it), there is no such step to reuse, so this navigates to the list
   directly instead. */
function leaveRemovedPlaylist() {
  if (navStack.length >= 2 && navStack[navStack.length - 2] === "#/playlists") {
    backPending = true;
    history.back();
  } else {
    location.hash = "#/playlists";
  }
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
}

/* ---------- init ---------- */

async function fetchJson(path) {
  try {
    const res = await fetch(pinnedUrl(path), { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
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
  try {
    const res = await fetch(apiUrl(path), { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
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
    set through the one swap, then the page repainted. Adopted only when the
    Foray list itself came back — a second failure must land on the same failed
    state, not on a list half-replaced by nulls. */
async function retryForayDocs() {
  const [forays, segments, sources] = await Promise.all([
    fetchJson("data/forays.json"),
    fetchJson("data/segments.json"),
    fetchJson("data/segment-sources.json"),
  ]);
  if (forays) applyForaySet({ forays, segments, sources });
  renderCurrentPage();
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
  return h === "#/" || h === "#/forays" || /^#\/(foray|show)\//.test(h);
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
      applyForaySet(out.set);
      if (isForaySurface(location.hash)) renderCurrentPage();
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
   <html> so CSS can use it; today the search page's compose bar
   (`#sh-compose`) is its only consumer.

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

async function init() {
  /* Storage hydration runs CONCURRENTLY with the first fetch, not before it: it
     is one IndexedDB read, so it costs nothing on the critical path, and it must
     finish before the first write — `loadInterests()` below is a read followed by
     a write, and doing that against a not-yet-hydrated store is how a restored
     profile gets replaced by taxonomy defaults. */
  const [, session] = await Promise.all([storageReady(), fetchJson("data/session.json")]);
  state.session = session;
  if (!state.session) {
    $("#view").innerHTML = `<div class="page"><p class="note">Couldn't load 4a — check your connection and reload.</p></div>`;
    return;
  }
  /* The Foray directory's cache read starts HERE, alongside the bundle fetches
     below, so that by the time they land the one IndexedDB read is done and
     bootForayDirectory() costs the critical path nothing. Bounded inside the
     module: a hung IndexedDB costs the cache, never the paint. */
  const directory = forayDirectoryBridge();
  if (directory && !pinnedDeployId) {
    try { directory.start({ localPointerUrl: pinnedUrl(FORAY_DIRECTORY_POINTER) }); } catch (_) { /* seed only */ }
  }
  /* Every one of these may come back null (fetchJson swallows a 404 and a
     parse error alike) and every consumer treats null as "absent", so a
     partial deploy costs the feature that needs the file rather than the
     site. The three Foray documents are the newest and the most likely to be
     missing from a cached service worker — see renderForay(). */
  [
    state.validated, state.taxonomy, state.discover, state.semantic, state.itemTags,
    state.forays, state.segments, state.segmentSources, state.catalog,
  ] = await Promise.all([
    fetchJson("data/validated-links.json"),
    fetchJson("data/taxonomy.json"),
    fetchJson("data/discover.json"),
    fetchJson("data/semantic-index.json"),
    fetchJson("data/item-tags.json"),
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

  /* FD-03: the three Foray documents just fetched are the SEED. If the directory
     holds a cached set that validates, that set replaces them before the first
     paint; the network is not consulted until after `route()` below. */
  await bootForayDirectory(directory);

  loadInterests();
  buildCards();
  state.ready = true;
  enterForayFromQuery();
  route();
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
  trySyncEvents();

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
  });

  /* Warm the concept-vocabulary DF caches now, while the app is idle between
     "data finished loading" and "user typed a query and hit Go", instead of
     paying it interleaved into the FIRST real playlist search (H bug, kanban
     t_838a13c0 — a fresh session's first query measured 6.6-8.1s before this
     fix). Deliberately scheduled via requestIdleCallback (falling back to a
     0ms timeout where it's unavailable, e.g. older WebKit/the native shell)
     rather than called inline here: `route()` above has already painted the
     first screen, and priming is pure CPU with no UI of its own, so it must
     not compete with that paint or with an impatient user who taps into the
     playlist search within the first second. searchCtx() builds the same ctx
     this call warms, so a query that arrives before priming finishes just
     resumes the memoization mid-way — nothing is wasted or redone. */
  const primeSearchVocab = () => {
    if (typeof SearchEngine !== "undefined" && SearchEngine.primeVocabulary) {
      SearchEngine.primeVocabulary(searchCtx());
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(primeSearchVocab, { timeout: 2000 });
  else setTimeout(primeSearchVocab, 0);

  /* Up Next auto-advance's wiring (docs/listening-queue-plan.md §4 addendum).
     Fire-and-forget: a player that never loads (module failure, test
     harness with no `window.addEventListener`) just means auto-advance never
     fires, same as every other ForayPlayer-gated feature on this page — it
     must not hold up `init()`, which has already returned control above. */
  playerBridge().then(player => {
    if (player && typeof player.onEpisodeEnded === "function") {
      player.onEpisodeEnded(advanceQueueOnEnded);
    }
  });

  $("#menu-btn").addEventListener("click", () => openDrawer($("#drawer").hidden));
  $("#view").addEventListener("click", onBackClick);
  $("#drawer-overlay").addEventListener("click", () => openDrawer(false));
  $("#drawer").addEventListener("click", (e) => {
    if (e.target.closest("a")) openDrawer(false);
  });
  /* Every settings switch, in one call — see `bindDrawerToggles`. They land
     ABOVE the diagnostic and destructive controls bound below, so "Delete my
     data" stays last where a scrolled thumb expects it. */
  bindDrawerToggles();
  /* The field record's surface (#264), appended for the same reason as the
     control below it and deliberately ABOVE it: "Delete my data" must stay the
     drawer's last item, because it is the one control in there that cannot be
     undone and the last item is where a scrolled thumb lands. */
  bindDiagnosticsControl();
  /* Narration voice (V-01), next to Playback diagnostics per the card's own
     text — appended immediately after it, so it lands between diagnostics
     and the destructive control at the very bottom. */
  bindVoiceControl();
  /* The drawer's last item, appended rather than written into index.html — see
     the § delete my data header for why, and note it is deliberately BELOW the
     two settings toggles: it is the one control in there that cannot be undone. */
  bindDeleteControl();
  $("#refresh-btn").addEventListener("click", () => {
    buildCards();
    logEvent("refreshed_all", {});
    if ((location.hash || "#/") === "#/") renderHome();
    else location.hash = "#/";
  });
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
  "stale-shell": "4a is showing its last saved copy — the network didn't answer while this page was loading.",
  "generation-changed": "4a updated in the background, so this page is one version behind.",
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
  if (!said) return;
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
    `<p class="note">${esc(said)} Reload to get the current version.</p>` +
    `<button type="button" id="shell-notice-reload">Reload</button>` +
    `<button type="button" id="shell-notice-dismiss" aria-label="Dismiss this message">×</button>`;
  const reload = $("#shell-notice-reload");
  if (reload) reload.addEventListener("click", () => location.reload());
  /* Dismissable, and this is not politeness. The bar is fixed below the topbar
     and a Foray page's transport is sticky at the same offset, so while the bar
     is up it covers the scrubber and the play control. In the `stale-shell` case
     — a dead zone — pressing Reload just reproduces it, so without this the
     listener would lose the transport for the rest of the session. Removing the
     element is enough: the worker only speaks again on a new page load. */
  const dismiss = $("#shell-notice-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
  }
}

if ("serviceWorker" in navigator && shouldRegisterServiceWorker(window)) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* progressive */ });
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
         reasoning. */
      if (msg.reason === "stale-shell" && msg.deployId) pinnedDeployId = msg.deployId;
      /* FD-01: the web's pinned-generation path records the same fact the shell's
         boot row does — where the documents came from, and which deploy id. */
      if (msg.reason === "stale-shell") {
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
