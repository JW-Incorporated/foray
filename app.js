/* Foray web client v4 — app shell.
   Views: home (one screen, no scroll: continue banner + 4 suggestions +
   playlist builder), playlists list, playlist detail. Hash routing.
   The semantic layer (compiled concepts + tags) powers playlist building. */

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

function logEvent(type, payload) {
  const events = lsGet("cp_events", []);
  const builder = state.session?.builder || "unknown";
  events.push({ ts: new Date().toISOString(), type, builder, profile: profileId(), payload });
  lsSet("cp_events", events.slice(-5000));
}

/* Durable telemetry: flush the buffered events to Supabase (ADR-0005 +
   docs/curation/events-client-integration-spec.md). Anonymous-first — every
   device gets a Supabase anonymous user; rows insert under auth.uid() and RLS
   enforces per-user isolation. Publishable key is public by design (RLS
   protects the data). Raw fetch, no SDK, to stay within the strict CSP. */
const SB_URL = "https://qjdllvqdcgacvujhclny.supabase.co";
const SB_KEY = "sb_publishable_0T8hpKCC_857G31LlCh0WA_0Rp61B3J";

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

/* Map a buffered cp_events entry to a canonical events-table row, or null for
   local-only types (see the client-integration spec §3). episode_id/session_id
   stay null; durable ids ride in payload as episode_slug/session_key. */
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
    case "finished":
      // Web hands playback to external apps and cannot observe real position —
      // the Done button is a declared click, so source is manual_stopgap (spec §1.2).
      return row("finished", { episode_slug: p.episode_id, topics: p.topics || [], percent_complete: 1, source: "manual_stopgap" });
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
    const events = lsGet("cp_events", []);
    const since = lsGet("cp_synced_ts", "");
    const unsynced = events.filter(e => e.ts > since);
    if (!unsynced.length) return;
    const s = await ensureAnonSession();
    if (!s) return; // offline / auth unavailable — buffer persists, retry next time
    const lastTs = unsynced[unsynced.length - 1].ts;
    const rows = unsynced.map(e => toEventRow(e, s.user_id)).filter(Boolean);
    if (!rows.length) { lsSet("cp_synced_ts", lastTs); return; } // all local-only
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
    lsSet("cp_synced_ts", lastTs);
  } catch (_) { /* buffer persists, retry next time */ }
}

/* ---------- interests / topics ---------- */

function leafNodes() {
  return (state.taxonomy?.nodes || []).filter(n => n.parent !== null);
}

function loadInterests() {
  const saved = lsGet("cp_interests", {});
  leafNodes().forEach(n => {
    state.interests[n.id] = saved[n.id] ?? Math.max(0, n.weight);
  });
}

function saveInterests() { lsSet("cp_interests", state.interests); }

/* Move a taxonomy node's weight. Clamped at BOTH ends since thumbs-down made
   the amount negative for the first time — an unclamped floor lets a few
   downvotes drive a node below zero, where it can never climb back into a menu
   however much the listener later plays of it. */
function nudgeTopics(topics, amount) {
  (topics || []).forEach(t => {
    if (t in state.interests) {
      state.interests[t] = Math.max(0, Math.min(1, state.interests[t] + amount));
    }
  });
  saveInterests();
}

function boostTopics(topics, amount) { nudgeTopics(topics, amount); }

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
   card itself stays a link either way, so nothing regresses for them. */
function playBtn(item) {
  if (!item || !item.audio_url) return "";
  return `<button class="play-btn" data-play="${esc(item.id)}" aria-label="Play ${esc(item.title)}">▶</button>`;
}

/* Family mode (corner-case 28): hide explicit-rated episodes and the comedy
   branch (older comedy items predate per-episode ratings). */
function familyMode() { return lsGet("cp_family", false); }

function poolFiltered() {
  const pool = fullPool();
  if (!familyMode()) return pool;
  return pool.filter(i => i.explicit !== true && branchOf(i) !== "comedy");
}

function fmtDur(min) {
  if (!min) return "";
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
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
   failure mode above. This lands in DurableStore's localStorage tier, where
   `cp_events` (5,000 entries) is already several times any of these figures, so it
   is not the largest thing in there; and lsSet reports a refused write rather than
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
    if (hydratePlaylistParts(p, sources)) touched = true;
  }
  /* Deliberately not through savePlaylists(): a read must not be the thing that
     enforces the 50 cap on a store that already holds more. */
  if (touched) lsSet("cp_playlists", all);
  return all;
}

function savePlaylists(all) { return lsSet("cp_playlists", all.slice(0, 50).map(withMirror)); }

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

function buildPlaylist(query) {
  const ctx = searchCtx();
  const interp = SearchEngine.interpretQuery(query, ctx);
  if (!interp.groups.length && !interp.filters.length) {
    return { status: "empty", suggestions: [] };
  }
  const pool = poolFiltered();
  const { results } = SearchEngine.searchWithRelaxation(pool, interp, 2, state.itemTags, interestScore);
  const { status, picks } = SearchEngine.classifyResults(results, { listenedShows: listenedShows() });

  if (status === "empty") {
    return { status: "empty", suggestions: SearchEngine.suggestAdjacentTopics(interp, ctx) };
  }

  const playlist = withMirror({
    id: "q" + Date.now(),
    query: query.trim(),
    title: prettyTitle(query),
    items: picks.map(x => playlistPart(x.i)),
    created: new Date().toISOString(),
    last_played_at: null,
    sparse: status === "sparse",
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
      const item = state.itemIndex[id] || episode(id);
      if (!item || !window.ForayPlayer) return;
      const ok = await window.ForayPlayer.play(item, { why: whyFor(id, item) });
      if (!ok) return;
      logEvent("play_started", { episode_id: id, topics: item.topics || [] });
      const history = pickedHistory();
      if (!history.includes(id)) lsSet("cp_history", history.concat(id).slice(-200));
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
  return `<a class="banner" href="${esc(safeUrl(playLink(c)))}" target="_blank" rel="noopener"
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
  const totalMin = slot.items.reduce((s, it) => s + (it.duration_min || 0), 0);
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

/* First-run explainer (#128 follow-up). Used to be a permanent card at the top
   of the home screen — after the first read it was dead weight that pushed the
   four topic queues down the screen for good. It is now a one-time popup shown
   right after the very first app open (gated on the same cp_intro_dismissed
   flag, so an existing install that already dismissed the card never sees it
   again) and nothing about it lives in the home layout any more. */
function showIntroPopupOnce() {
  if (lsGet("cp_intro_dismissed", false)) return;
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

function renderHome() {
  document.body.className = "view-home";
  if (!state.cardSlots.length) buildCards();
  const resumeRows = forayResumeRows();
  $("#view").innerHTML = `
    <div class="home">
      <div id="banner-slot">${bannerHtml()}</div>
      ${jumpBackInHtml(resumeRows)}
      ${forayHomeHtml()}
      <div class="cards4">${state.cardSlots.map(miniCard).join("")}</div>
      <form id="pl-form" autocomplete="off">
        <input id="pl-input" type="text" maxlength="120" placeholder="build me a playlist…">
        <button type="submit">Go</button>
      </form>
      <p id="pl-note" class="note" hidden></p>
    </div>`;

  showIntroPopupOnce();

  const done = $("#banner-done");
  if (done) {
    done.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const c = currentContinue();
      if (c) {
        logEvent("finished", { episode_id: c.id, topics: c.topics });
        boostTopics(c.topics, 0.05);
      }
      lsSet("cp_lastpick", null);
      $("#banner-slot").innerHTML = "";
    });
  }

  $("#pl-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const query = $("#pl-input").value.trim();
    if (!query) return;
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
  });

  sizeProgressBars($("#view"));
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"));
}

/* One playable row = one play control, never two. An item with audio_url gets
   the in-app ▶ button and nothing else plays it; only an item with NO
   audio_url falls back to the external "Play" link-out. Before this a row
   with audio_url rendered both — the ▶ button AND a text link that also said
   "Play" — which is two controls doing the same job. */
function epRow(item, idx, ctx, nextIdx) {
  const inApp = playBtn(item);
  const external = inApp ? "" : `<a class="go" href="${esc(safeUrl(playLink(item)))}" target="_blank" rel="noopener"
       data-ev="picked" data-ep="${item.id}" data-ctx="${ctx}">Play</a>`;
  return `<div class="ep-row">
    <span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>
    <div class="info">
      <div class="t">${esc(item.title)}</div>
      <div class="s">${esc(item.show)} · ${fmtDur(item.duration_min)}</div>
    </div>
    ${inApp}${starBtn(item.id)}${external}
  </div>`;
}

/* A part the live pool no longer carries, rendered from what the playlist saved
   (#276). It keeps its number and its place, so the count above it stays true.
   What it cannot offer is in-app playback — `audio_url` is the field deliberately
   not persisted because it moves — so it links out instead, exactly the
   degradation playBtn() already gives an item with no audio.

   IT KEEPS ITS STAR, and that closes a loop rather than decorating the row:
   `cp_saved` holds whole snapshots, and hydratePlaylistParts reads it, so a
   starred part is one the migration can always name again. Starring an aged-out
   episode is the one action that makes it permanently recoverable. It works
   because renderPlaylistDetail seeds the snapshot into `state.itemIndex`, which
   toggleStar requires; an `unnamed` part has no snapshot to store, so it gets no
   star.

   `apple_collection_id` is what a link-out needs, and an `unnamed` part has
   neither that nor a title, so it gets no link rather than a link to
   `.../idundefined`.

   THE LINK STILL CARRIES `data-ev="picked"`, and it has to. Opening an archived
   part in another app is the same act as opening a live one, so it must reach
   bindPickLogging: otherwise it stops entering `cp_history`, and this playlist's
   own "played" count and its next-up marker would go backwards the moment an
   episode aged out — the same class of quiet regression as the one #276 is about.
   That path reads `state.itemIndex` for the topics it reports, which is why
   renderPlaylistDetail seeds the archived snapshot there and why `topics` is one
   of the persisted fields. An `unnamed` part has no link and nothing to report,
   so it logs nothing. */
function archivedRow(item, idx, ctx) {
  const named = !!item.title;
  const link = item.apple_collection_id
    ? `<a class="go" href="${esc(safeUrl(playLink(item)))}" target="_blank" rel="noopener"
         data-ev="picked" data-ep="${esc(item.id)}" data-ctx="${esc(ctx)}">Open</a>`
    : "";
  return `<div class="ep-row gone">
    <span class="q-num">${idx + 1}</span>
    <div class="info">
      <div class="t">${named ? esc(item.title) : "Part no longer in the catalogue"}</div>
      <div class="s">${named
        ? `${esc(item.show)}${item.duration_min ? ` · ${fmtDur(item.duration_min)}` : ""} · not in 4a's catalogue right now`
        : "Saved before 4a kept episode details"}</div>
    </div>
    ${named ? starBtn(item.id) : ""}${link}
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
    parts.push(`${archived} part${one ? " is" : "s are"} not in 4a's catalogue right now, so ${one ? "it" : "they"} cannot play in the app — open ${one ? "it" : "them"} in your podcast app instead.`);
  }
  if (unnamed) {
    const one = unnamed === 1;
    /* EVERY plural agrees, verbs included. The first draft pluralised the noun and
       not the verb, so a listener with exactly one gap read "if the episode
       return" — and the note a reviewer reads is never the one that ships to them.
       It also no longer claims rebuilding REPLACES this playlist: buildPlaylist
       mints a new id and prepends a new playlist, leaving this one untouched. */
    parts.push(`${unnamed} part${one ? " was" : "s were"} saved before 4a kept episode details and cannot be named yet — ${one ? "it" : "they"} will fill in if the episode${one ? " returns" : "s return"} to the catalogue, and building the same playlist again from the home screen gives you a fresh one from what 4a has today.`);
  }
  return `<p class="note">${esc(parts.join(" "))}</p>`;
}

function renderPlaylistDetail(id) {
  document.body.className = "view-page";
  const p = playlistById(id) || subjectQueueById(id);
  if (!p) { $("#view").innerHTML = `<div class="page"><p class="note">Playlist not found.</p></div>`; return; }
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
  /* The "next" marker belongs on the next part that can actually be opened. */
  const nextIdx = rows.findIndex(r => r.state === "live" && !history.has(r.item.id));
  /* Played is an id-in-history question, not a liveness one: a part played before
     it aged out stays played, and so does an unnamed one whose id is in history. */
  const played = rows.filter(r => r.item.id && history.has(r.item.id)).length;
  const ctx = (p.isSubject ? "subject-" : "playlist-") + p.id;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${rows.length} episode${rows.length === 1 ? "" : "s"}${p.isSubject ? " · today's queue" : " playlist"} · ${played} played</p>
        </div>
      </div>
      ${p.sparse ? `<p class="note">Only found a few on this — here's what we've got.</p>` : ""}
      ${partsNote(rows)}
      ${rows.map((r, i) => r.state === "live" ? epRow(r.item, i, ctx, nextIdx) : archivedRow(r.item, i, ctx)).join("")}
      ${p.isSubject ? "" : `<button class="danger" id="pl-remove">remove this playlist</button>`}
    </div>`;

  if (!p.isSubject) $("#pl-remove")?.addEventListener("click", () => {
    savePlaylists(playlists().filter(x => x.id !== p.id));
    logEvent("playlist_removed", { playlist_id: p.id });
    location.hash = "#/playlists";
  });
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"));
}

/* The count printed here is `resolveParts(p).length` — the SAME call
   renderPlaylistDetail maps into rows, deliberately, so "7 parts" and five rows
   cannot come apart again (#276). It is a saved-length question, not a pool
   question, so this view needs no catalogue to answer it honestly. */
function renderPlaylists() {
  document.body.className = "view-page";
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

  $("#pl-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const query = $("#pl-input").value.trim();
    if (!query) return;
    const result = buildPlaylist(query);
    logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.items.length : 0 });
    if (result.status === "ok" || result.status === "sparse") {
      location.hash = "#/playlist/" + result.playlist.id;
    } else {
      const note = $("#pl-note");
      note.textContent = result.status === "unsaved"
        ? "That playlist could not be saved — this device has no storage space left. Removing a playlist you have finished with frees enough for a new one."
        : result.suggestions.length
          ? `Not much on "${query}" yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
          : `Not much on "${query}" yet — try different words.`;
      note.hidden = false;
    }
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
  const one = (dir, glyph, label) =>
    `<button type="button" class="fy-thumb ${vote === dir ? "on" : ""}" data-thumb="${dir}"
        data-seg-id="${esc(entry.segment_id)}" aria-pressed="${vote === dir}"
        aria-label="${esc(label)} ${esc(entry.label)}">${glyph}</button>`;
  return `<div class="fy-fb">
    ${one("up", "👍", "More like")}${one("down", "👎", "Less like")}
  </div>`;
}

function forayRow(entry) {
  const dur = window.ForayPlayer ? window.ForayPlayer.fmtSpan(entry.duration_sec) : "";
  const meta = [entry.show, dur].filter(Boolean).join(" · ");
  if (!entry.playable) {
    return `<div class="fy-row is-out">
      <div class="fy-jump">
        <span class="fy-label">${esc(entry.label)}</span>
        <div class="fy-body">
          <div class="fy-meta">${esc(meta)}</div>
          <p class="fy-why">${esc(entry.why)}</p>
          <p class="fy-out">Can't play: ${esc(entry.reason || "unresolved")}</p>
        </div>
      </div>
    </div>`;
  }
  /* The row used to BE the button. It cannot be any more: a thumb inside a
     button is invalid HTML and its click never survives the parent's handler.
     So the row is a container, the play affordance is the button inside it, and
     `data-fy` — which paintForay and the transport both key on — moves with the
     button, not with the container. */
  return `<div class="fy-row">
    <button type="button" class="fy-jump" data-fy="${esc(String(entry.queueIndex))}"
        aria-label="Play ${esc(entry.label)}, ${esc(entry.show)}">
      <span class="fy-label">${esc(entry.label)}</span>
      <div class="fy-body">
        <div class="fy-meta">${esc(meta)}</div>
        <p class="fy-why">${esc(entry.why)}</p>
      </div>
      <span class="fy-state" aria-hidden="true"></span>
    </button>
    ${thumbsHtml(entry)}
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
      <a class="fy-src-head" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener"
         data-src-show="${esc(c.show)}">
        <span class="fy-src-show">${esc(c.show)} ↗</span>
        <span class="fy-src-meta">${clips(c.clips)} · ${esc(player.fmtSpan(c.seconds))}</span>
      </a>
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

function forayHeadSub(r) {
  const fmt = window.ForayPlayer ? window.ForayPlayer.fmtClock : (s => String(Math.round(s)));
  const parts = [
    `${r.playable.length} segment${r.playable.length === 1 ? "" : "s"}`,
    `${r.shows.length} show${r.shows.length === 1 ? "" : "s"}`,
    fmt(r.totalSec),
  ];
  return parts.join(" · ");
}

async function renderForay(id) {
  document.body.className = "view-page";
  $("#view").innerHTML = `<div class="page"><p class="note">Loading…</p></div>`;

  const player = await playerBridge();
  // Another route may have won while we waited for the module.
  if (forayRouteId() !== id) return;

  if (!player) {
    $("#view").innerHTML = `<div class="page"><p class="note">The player didn't load — reload the page.</p></div>`;
    return;
  }
  if (!state.forays) {
    $("#view").innerHTML = `<div class="page"><p class="note">Couldn't load forays right now.</p></div>`;
    return;
  }

  const r = player.resolve(state.forays, {
    id,
    segmentsDoc: state.segments,
    sourcesDoc: state.segmentSources,
    unlocked: unlockedForays(),
  });
  // Same answer for "no such Foray" and "not published": a client that
  // distinguishes them announces the existence of unpublished work.
  if (!r) {
    $("#view").innerHTML = `<div class="page"><p class="note">That foray isn't available.</p></div>`;
    return;
  }
  state.foray = r;
  state.forayPainted = null;   // fresh DOM: the paint guard must not skip it

  const draft = r.foray.status !== "published";
  const lost = r.unplayable.length;
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
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(r.title)}</h2>
          <p class="sub">${esc(forayHeadSub(r))}</p>
        </div>
      </div>
      ${draft ? `<p class="fy-draft">Draft — not published. You opened it by name; nobody else sees it.</p>` : ""}
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
      ${lost ? `<p class="note">${lost} segment${lost === 1 ? "" : "s"} can't play — listed below.</p>` : ""}
      ${r.slots.map(foraySlotHtml).join("")}
      ${foraySourcesHtml(r, player)}
      ${feedbackSheetHtml()}
    </div>`;

  $("#fy-total").textContent = player.fmtClock(r.totalSec);
  mountForayStrip(r, player);
  // Optional-chained deliberately. This runs BEFORE every binder, so if the
  // markup and this line ever disagree the throw would take the whole transport
  // down with it — an unfilled progress bar is a far better failure. CI catches
  // the disagreement itself: the hook is pinned in player/foray-playback.test.js.
  if (resume) { const fill = $("#fy-bar-fill"); if (fill) fill.style.width = `${resume.percent}%`; }
  bindFeedback(r);
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

  /* Playback speed (#242). Bound BEFORE the "nothing playable" bail-out below and
     labelled from the stored value, because neither depends on this Foray: the
     speed is global (one `cp_rate` for the app — a speed is a fact about the
     listener, not about the audio), it is settable before anything has started, and
     a Foray with no playable segments still leaves a listener who may want to set
     it for the next one. `paintForay` relabels it on every tick from the snapshot,
     so a change made in the mini-player's sheet shows up here too **while a Foray
     is live** — `notifyForay` has nothing to notify when the player is on a single
     episode, so in that one case this button keeps its label until the page is
     rendered again. Stated rather than fixed: the value itself is always right
     (it lives in `cp_rate`, which both controls read), the stale thing is a label
     on a page whose Foray is not the thing playing, and a rate-only broadcast
     channel is more machinery than that is worth. */
  const rateBtn = $("#fy-rate");
  /* BOTH methods checked, not just one. app.js and the module refresh
     independently, and a bridge with `playbackRate` but no `cycleRate` would bind a
     handler that throws into `guardForayTap` on every tap — a control that reports
     "that didn't take" forever. They ship together, so this is belt and braces, and
     it costs one `typeof`. */
  if (rateBtn && typeof player.playbackRate === "function" && typeof player.cycleRate === "function") {
    paintRateButton(player, player.playbackRate());
    rateBtn.addEventListener("click", () => guardForayTap(() => {
      // Synchronous, and no `playerHasForay` branch: unlike every other control on
      // this row, changing the speed is meaningful with nothing loaded and must not
      // start playback as a side effect.
      paintRateButton(player, player.cycleRate());
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

/** The Forays this visitor may see on the home screen. As of 2026-08-30 that is
    ONE — `capital-types-1` is published — plus any draft reached by name. It
    was empty for everyone before that.

    It reads the bridge synchronously rather than awaiting it, so on a cold load
    where the module has not evaluated yet the row is simply absent until the
    next render. That WAS the right trade while the list was empty for everyone.
    It is not any more, and the trade has not been re-made: nothing re-renders
    home on the `forayplayer:ready` event `player/client.js` already dispatches,
    so a cold load that paints home before the module evaluates shows a home
    screen with the published Foray missing from it until the visitor navigates.
    In practice `init()` awaits eight JSON fetches before `route()` and the
    module graph starts earlier, so the module almost always wins — "almost
    always" is the defect. Fixing it wants the same await `renderForay` does, or
    one re-render on that event; both need a harness that does not stub
    `window.addEventListener` to a no-op, which is what the two suites that mount
    this file do today. Recorded in docs/curation/foray2-capital.md §11c. */
function forayCards() {
  if (!state.forays || !window.ForayPlayer) return [];
  return window.ForayPlayer.listForays(state.forays, { unlocked: unlockedForays() });
}

function forayHomeHtml() {
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
function forayResumeRows() {
  if (typeof window.ForayPlayer?.forayResumeList !== "function") return [];
  const visible = new Set(forayCards().map(f => f.id));
  return window.ForayPlayer.forayResumeList()
    .filter(p => visible.has(p.id) && !p.finished && p.label)
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
  const recent = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created).localeCompare(a.last_played_at || a.created))
    .slice(0, 5);
  $("#drawer-playlists").innerHTML = recent.map(p =>
    `<a class="drawer-item" href="#/playlist/${esc(p.id)}">${esc(p.title)}</a>`).join("")
    || `<p class="drawer-empty">none yet</p>`;
  $("#family-toggle").textContent = `Family mode: ${familyMode() ? "on" : "off"}`;
  $("#player-toggle").textContent = `Open in: ${playerPref() === "apple" ? "Apple Podcasts" : "Pocket Casts (show page)"}`;
}

function openDrawer(open) {
  $("#drawer").hidden = !open;
  $("#drawer-overlay").hidden = !open;
  if (open) renderDrawer();
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
        shell is `HUMAN-ACTIONS.md` #16.
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
       and `cp_seen`, which would put two of the 20 keys straight back. */
    state.interests = {};
    loadInterests();
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

function route() {
  if (!state.ready) return;
  openDrawer(false);
  /* Both of these belong to a page that is about to be replaced. The sheet's DOM
     and listeners die with #view, so neither can act — but a stale entry left
     pointing at a detached segment is the kind of thing that becomes a bug the
     next time someone reuses the sheet. */
  fbTarget = null;
  state.forayResume = null;
  const h = location.hash || "#/";
  const forayId = forayRouteId();
  let m;
  if (forayId) renderForay(forayId);
  else if ((m = /^#\/playlist\/(.+)$/.exec(h))) renderPlaylistDetail(m[1]);
  else if ((m = /^#\/subject\/(.+)$/.exec(h))) renderPlaylistDetail("subject-" + m[1]);
  else if (h === "#/playlists") renderPlaylists();
  else renderHome();
}

/* ---------- init ---------- */

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
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
  /* Every one of these may come back null (fetchJson swallows a 404 and a
     parse error alike) and every consumer treats null as "absent", so a
     partial deploy costs the feature that needs the file rather than the
     site. The three Foray documents are the newest and the most likely to be
     missing from a cached service worker — see renderForay(). */
  [
    state.validated, state.taxonomy, state.discover, state.semantic, state.itemTags,
    state.forays, state.segments, state.segmentSources,
  ] = await Promise.all([
    fetchJson("data/validated-links.json"),
    fetchJson("data/taxonomy.json"),
    fetchJson("data/discover.json"),
    fetchJson("data/semantic-index.json"),
    fetchJson("data/item-tags.json"),
    fetchJson("data/forays.json"),
    fetchJson("data/segments.json"),
    fetchJson("data/segment-sources.json"),
  ]);

  loadInterests();
  buildCards();
  state.ready = true;
  enterForayFromQuery();
  route();
  logEvent("session_shown", { session_id: state.session.session_id });
  trySyncEvents();

  $("#menu-btn").addEventListener("click", () => openDrawer($("#drawer").hidden));
  $("#drawer-overlay").addEventListener("click", () => openDrawer(false));
  $("#drawer").addEventListener("click", (e) => {
    if (e.target.closest("a")) openDrawer(false);
  });
  $("#family-toggle").addEventListener("click", () => {
    lsSet("cp_family", !familyMode());
    logEvent("family_mode", { on: familyMode() });
    buildCards();
    renderDrawer();
    route();
  });
  $("#player-toggle").addEventListener("click", () => {
    lsSet("cp_player", playerPref() === "apple" ? "pocketcasts" : "apple");
    logEvent("player_pref", { player: playerPref() });
    renderDrawer();
    route();
  });
  /* The field record's surface (#264), appended for the same reason as the
     control below it and deliberately ABOVE it: "Delete my data" must stay the
     drawer's last item, because it is the one control in there that cannot be
     undone and the last item is where a scrolled thumb lands. */
  bindDiagnosticsControl();
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
  window.addEventListener("hashchange", route);
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
      if (msg && msg.source === "foray-sw") showShellNotice(msg.reason);
    });
  }
}
