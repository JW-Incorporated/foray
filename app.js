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
  cardSlots: [],            // the four dealt suggestions
  itemIndex: {},            // id -> snapshot
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

/* ---------- storage ---------- */

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
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

function boostTopics(topics, amount) {
  (topics || []).forEach(t => {
    if (t in state.interests) {
      state.interests[t] = Math.min(1, state.interests[t] + amount);
    }
  });
  saveInterests();
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
  };
  state.itemIndex[id] = snap;
  return snap;
}

function fullPool() {
  const pool = [];
  const seen = new Set();
  for (const id of Object.keys(state.session.episodes)) {
    pool.push(snapshot(id, episode(id)));
    seen.add(id);
  }
  for (const item of (state.discover?.items || [])) {
    if (!seen.has(item.id)) pool.push(snapshot(item.id, item));
  }
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

function starBtn(id) {
  const on = isSaved(id);
  return `<button class="star ${on ? "on" : ""}" data-star="${id}" aria-label="Save">${on ? "★" : "☆"}</button>`;
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
  return { id, title: subjectLabel(slot.branch), item_ids: slot.items.map(it => it.id), sparse: false, isSubject: true };
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
   title from the meaningful words of the ask. */
const ACRONYMS = new Set(["ai", "bbq", "ww2", "ww1", "f1", "nasa", "diy", "cia", "fbi", "nfl", "nba", "mlb", "ufc", "tv"]);

function prettyTitle(query) {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let words = raw.filter(w => !SearchEngine.STOPWORDS.has(w));
  if (!words.length) words = raw;
  return words.slice(0, 4)
    .map(w => ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
    .join(" ") || "Playlist";
}

function playlists() {
  let all = lsGet("cp_playlists", null);
  if (all === null) {
    all = lsGet("cp_quests", []);   // migrate the old key once
    lsSet("cp_playlists", all);
  }
  let touched = false;
  for (const p of all) {
    if (!p.title) { p.title = prettyTitle(p.query || ""); touched = true; }
  }
  if (touched) lsSet("cp_playlists", all);
  return all;
}

function savePlaylists(all) { lsSet("cp_playlists", all.slice(0, 50)); }

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

  const playlist = {
    id: "q" + Date.now(),
    query: query.trim(),
    title: prettyTitle(query),
    item_ids: picks.map(x => x.i.id),
    created: new Date().toISOString(),
    last_played_at: null,
    sparse: status === "sparse",
  };
  savePlaylists([playlist, ...playlists()]);
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

      const snap = state.itemIndex[id];
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

function introHtml() {
  if (lsGet("cp_intro_dismissed", false)) return "";
  return `<div class="intro" id="home-intro">
    <button class="intro-close" id="intro-close" aria-label="Dismiss">✕</button>
    <p class="intro-tag">Four things to listen to today, grouped by topic — not a feed to scroll.</p>
    <p class="intro-body">Three queues come from what you're already into. One is deliberately something else, on purpose — tap a card to see why it's grouped and what's in it.</p>
  </div>`;
}

function renderHome() {
  document.body.className = "view-home";
  if (!state.cardSlots.length) buildCards();
  $("#view").innerHTML = `
    <div class="home">
      <div id="banner-slot">${bannerHtml()}</div>
      ${introHtml()}
      <div class="cards4">${state.cardSlots.map(miniCard).join("")}</div>
      <form id="pl-form" autocomplete="off">
        <input id="pl-input" type="text" maxlength="120" placeholder="build me a playlist…">
        <button type="submit">Go</button>
      </form>
      <p id="pl-note" class="note" hidden></p>
    </div>`;

  $("#intro-close")?.addEventListener("click", () => {
    lsSet("cp_intro_dismissed", true);
    $("#home-intro").remove();
  });

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
    logEvent("playlist_built", { query, status: result.status, found: result.playlist ? result.playlist.item_ids.length : 0 });
    if (result.status === "ok" || result.status === "sparse") {
      location.hash = "#/playlist/" + result.playlist.id;
    } else {
      const note = $("#pl-note");
      note.textContent = result.suggestions.length
        ? `Not much on "${query}" yet — try ${result.suggestions.map(s => s.label).join(", ")} instead.`
        : `Not much on "${query}" yet — try different words.`;
      note.hidden = false;
    }
  });

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"));
}

function epRow(item, idx, ctx, nextIdx) {
  return `<div class="ep-row">
    <span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>
    <div class="info">
      <div class="t">${esc(item.title)}</div>
      <div class="s">${esc(item.show)} · ${fmtDur(item.duration_min)}</div>
    </div>
    ${playBtn(item)}${starBtn(item.id)}
    <a class="go" href="${esc(safeUrl(playLink(item)))}" target="_blank" rel="noopener"
       data-ev="picked" data-ep="${item.id}" data-ctx="${ctx}">Play</a>
  </div>`;
}

function renderPlaylistDetail(id) {
  document.body.className = "view-page";
  const p = playlistById(id) || subjectQueueById(id);
  if (!p) { $("#view").innerHTML = `<div class="page"><p class="note">Playlist not found.</p></div>`; return; }
  fullPool(); // populate itemIndex
  const items = p.item_ids.map(i => state.itemIndex[i]).filter(Boolean);
  const history = new Set(pickedHistory());
  const nextIdx = items.findIndex(i => !history.has(i.id));
  const played = items.filter(i => history.has(i.id)).length;
  const ctx = (p.isSubject ? "subject-" : "playlist-") + p.id;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${items.length} episode${items.length === 1 ? "" : "s"}${p.isSubject ? " · today's queue" : " playlist"} · ${played} played</p>
        </div>
      </div>
      ${p.sparse ? `<p class="note">Only found a few on this — here's what we've got.</p>` : ""}
      ${items.map((item, i) => epRow(item, i, ctx, nextIdx)).join("")}
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

function renderPlaylists() {
  document.body.className = "view-page";
  const all = playlists();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Playlists</h2><p class="sub">${all.length} built</p></div>
      </div>
      ${all.length ? all.map(p => `
        <a class="pl-row" href="#/playlist/${esc(p.id)}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${p.item_ids.length} parts${p.last_played_at ? ` · played ${new Date(p.last_played_at).toLocaleDateString()}` : ""}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — build one from the home screen.</p>`}
    </div>`;
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

/* ---------- router ---------- */

function route() {
  if (!state.ready) return;
  openDrawer(false);
  const h = location.hash || "#/";
  let m;
  if ((m = /^#\/playlist\/(.+)$/.exec(h))) renderPlaylistDetail(m[1]);
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
  state.session = await fetchJson("data/session.json");
  if (!state.session) {
    $("#view").innerHTML = `<div class="page"><p class="note">Couldn't load Foray — check your connection and reload.</p></div>`;
    return;
  }
  [state.validated, state.taxonomy, state.discover, state.semantic, state.itemTags] = await Promise.all([
    fetchJson("data/validated-links.json"),
    fetchJson("data/taxonomy.json"),
    fetchJson("data/discover.json"),
    fetchJson("data/semantic-index.json"),
    fetchJson("data/item-tags.json"),
  ]);

  loadInterests();
  buildCards();
  state.ready = true;
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
  $("#refresh-btn").addEventListener("click", () => {
    buildCards();
    logEvent("refreshed_all", {});
    if ((location.hash || "#/") === "#/") renderHome();
    else location.hash = "#/";
  });
  window.addEventListener("hashchange", route);
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* progressive */ });
}
