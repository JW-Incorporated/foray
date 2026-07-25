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

function buildCards() {
  const pool = poolFiltered();
  const history = new Set(pickedHistory());
  const seen = new Set(lsGet("cp_seen", []));
  const byBranch = {};
  pool.forEach(i => { (byBranch[branchOf(i)] = byBranch[branchOf(i)] || []).push(i); });

  const recentBranches = lsGet("cp_recent_branches", []);
  const ranked = Object.keys(byBranch)
    .map(b => {
      const avg = byBranch[b].reduce((s, i) => s + interestScore(i), 0) / byBranch[b].length;
      const penalty = recentBranches.includes(b) ? 0.35 : 0;
      return { b, s: avg + (Math.random() - 0.5) * 0.7 - penalty };
    })
    .sort((x, y) => y.s - x.s)
    .map(x => x.b);

  state.cardSlots = ranked.slice(0, 4).map((branch, i) => {
    const items = byBranch[branch];
    const unseen = items.filter(it => !history.has(it.id) && !seen.has(it.id)).sort(() => Math.random() - 0.5);
    const seenNotPlayed = items.filter(it => !history.has(it.id) && seen.has(it.id)).sort(() => Math.random() - 0.5);
    const played = items.filter(it => history.has(it.id));
    const chain = unseen.concat(seenNotPlayed, played);
    return { slot: i + 1, branch, item: chain[0] || null };
  }).filter(sl => sl.item);

  lsSet("cp_recent_branches", recentBranches.concat(state.cardSlots.map(sl => sl.branch)).slice(-BRANCH_MEMORY));
  rememberSeen(state.cardSlots.map(sl => sl.item.id));
}

/* Hand-crafted why-lines survive where they exist. */
function whyFor(id, item) {
  const curated = state.session.cards.find(c => c.episode_id === id);
  return curated ? curated.why_line : (item.hook || "");
}

/* ---------- query interpreter (playlist builder) ---------- */

const STOPWORDS = new Set(["a","an","the","about","series","playlist","of","on","for","me","my","give","build","make","with","to","and","or","in","podcast","podcasts","episode","episodes","show","shows","some","something","want","i","please","that","stuff","things"]);

const ALIASES = {
  bbq: ["barbecue", "grill"], barbeque: ["barbecue"],
  cooking: ["food", "culinary"], rome: ["roman"], ww2: ["war"],
  plane: ["aviation", "aircraft"], planes: ["aviation", "aircraft"],
  car: ["automotive"], cars: ["automotive"], ocean: ["sea", "marine"],
};

function tokenize(q) {
  const base = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
  const expanded = new Set(base);
  base.forEach(w => (ALIASES[w] || []).forEach(a => expanded.add(a)));
  return [...expanded];
}

function tagDF(term) {
  if (!state._dfMemo) state._dfMemo = new Map();
  if (state._dfMemo.has(term)) return state._dfMemo.get(term);
  const tagsMap = state.itemTags?.tags || {};
  let n = 0;
  for (const tags of Object.values(tagsMap)) {
    if (tags.some(tag => term.length < 4 ? (tag === term || tag.split("-").includes(term)) : tag.includes(term))) n++;
  }
  state._dfMemo.set(term, n);
  return n;
}

function interpretQuery(q) {
  const tokens = tokenize(q);
  const filters = [];
  const topicBoosts = new Set();
  const mods = state.semantic?.modifiers || {};
  const concepts = state.semantic?.concepts || {};

  const contentTokens = tokens.filter(tok => {
    if (mods[tok]) { filters.push(mods[tok]); return false; }
    return true;
  });

  const groups = contentTokens.map(tok => {
    const terms = new Map([[tok, 1]]);
    const addTerm = (t, w) => terms.set(t, Math.max(terms.get(t) || 0, w));
    const others = contentTokens.filter(o => o !== tok);

    for (const [cid, c] of Object.entries(concepts)) {
      if (!c.terms?.includes(tok)) continue;
      const related = new Set(c.related || []);
      const supported = others.length === 0 || others.some(o => {
        if (c.terms.includes(o)) return true;
        return Object.entries(concepts).some(([oid, oc]) =>
          oc.terms?.includes(o) && (related.has(oid) || (oc.related || []).includes(cid)));
      });
      const wTerm = supported ? 0.6 : 0.25;
      const wRelated = supported ? 0.25 : 0.1;
      c.terms.forEach(t => addTerm(t, wTerm));
      if (supported) (c.topics || []).forEach(t => topicBoosts.add(t));
      (c.related || []).forEach(rid => {
        const rc = concepts[rid];
        if (rc) rc.terms?.forEach(t => addTerm(t, wRelated));
      });
    }
    for (const [t, w] of [...terms]) {
      if (w >= 1) continue;
      const df = tagDF(t);
      if (df > 60) terms.delete(t);
      else if (df > 25) terms.set(t, w * 0.4);
    }
    return { token: tok, terms };
  });

  return { groups, filters, topicBoosts };
}

function passesFilters(item, filters) {
  for (const f of filters) {
    if (f.type === "duration_max" && !(item.duration_min && item.duration_min <= f.value)) return false;
    if (f.type === "duration_min" && !(item.duration_min && item.duration_min >= f.value)) return false;
    if (f.type === "branch" && !f.value.includes(branchOf(item))) return false;
    if (f.type === "recency_days") {
      const d = new Date(item.release_date || 0);
      if ((Date.now() - d.getTime()) / 86400000 > f.value) return false;
    }
  }
  return true;
}

function scoreMatch(item, interp) {
  const title = item.title.toLowerCase();
  const hook = (item.hook || "").toLowerCase();
  const show = item.show.toLowerCase();
  const topics = (item.topics || []).join(" ").toLowerCase();
  const tags = state.itemTags?.tags?.[item.id] || [];

  const hitText = (text, t) =>
    t.length < 4 ? new RegExp("\\b" + t + "\\b").test(text) : text.includes(t);
  const hitTag = (tag, t) =>
    t.length < 4 ? (tag === t || tag.split("-").includes(t)) : tag.includes(t);

  let sum = 0;
  let matchedGroups = 0;
  for (const group of interp.groups) {
    let best = 0;
    for (const [t, w] of group.terms) {
      let f = 0;
      if (tags.some(tag => hitTag(tag, t))) f += 2.5;
      if (hitText(topics, t)) f += 3;
      if (hitText(title, t)) f += 2;
      if (hitText(hook, t)) f += 1.5;
      if (hitText(show, t)) f += 1;
      best = Math.max(best, f * w);
    }
    if (best >= 1.2) matchedGroups++;
    const df = tagDF(group.token);
    sum += best * (df <= 10 ? 1.35 : df <= 30 ? 1 : 0.75);
  }
  for (const tb of interp.topicBoosts) {
    if ((item.topics || []).includes(tb)) sum += 2;
  }
  return { sum, matched: matchedGroups };
}

function searchWithRelaxation(interp, minScore) {
  const attempt = (filters) => {
    const pool = poolFiltered().filter(i => passesFilters(i, filters));
    if (!interp.groups.length) {
      return pool.map(i => ({ i, sum: interestScore(i), matched: 0 }))
        .sort((a, b) => b.sum - a.sum);
    }
    return pool.map(i => ({ i, ...scoreMatch(i, interp) }))
      .filter(x => x.matched > 0 && x.sum > minScore)
      .sort((a, b) => b.matched - a.matched || b.sum - a.sum);
  };
  let results = attempt(interp.filters);
  let relaxed = null;
  if (!results.length && interp.filters.some(f => f.type.startsWith("duration"))) {
    results = attempt(interp.filters.filter(f => !f.type.startsWith("duration")));
    if (results.length) relaxed = "duration";
  }
  if (!results.length && interp.filters.length) {
    results = attempt([]);
    if (results.length) relaxed = "all";
  }
  return { results, relaxed };
}

/* ---------- playlists ---------- */

/* "give me a series about fusion" is a prompt, not a name. Derive a clean
   title from the meaningful words of the ask. */
const ACRONYMS = new Set(["ai", "bbq", "ww2", "ww1", "f1", "nasa", "diy", "cia", "fbi", "nfl", "nba", "mlb", "ufc", "tv"]);

function prettyTitle(query) {
  const raw = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let words = raw.filter(w => !STOPWORDS.has(w));
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

function buildPlaylist(query) {
  const interp = interpretQuery(query);
  if (!interp.groups.length && !interp.filters.length) return null;
  const { results } = searchWithRelaxation(interp, 2);
  const picks = results.slice(0, 10);
  if (picks.length < 2) return null;
  const playlist = {
    id: "q" + Date.now(),
    query: query.trim(),
    title: prettyTitle(query),
    item_ids: picks.map(x => x.i.id),
    created: new Date().toISOString(),
    last_played_at: null,
  };
  savePlaylists([playlist, ...playlists()]);
  return playlist;
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

function miniCard(slot) {
  const item = slot.item;
  const why = whyFor(item.id, item);
  return `<a class="mini-card" data-branch="${esc(slot.branch)}"
      href="${esc(safeUrl(playLink(item)))}" target="_blank" rel="noopener"
      data-ev="picked" data-ep="${item.id}" data-ctx="card-${esc(slot.branch)}">
    ${item.artwork_url ? `<img src="${esc(safeUrl(item.artwork_url))}" alt="" loading="lazy">` : `<div class="art-ph"></div>`}
    <div class="mc-info">
      <p class="mc-show">${esc(item.show)}${item.duration_min ? ` · ${fmtDur(item.duration_min)}` : ""}</p>
      <h3>${esc(item.title)}</h3>
      <p class="mc-hook">${esc(why)}</p>
    </div>
    ${starBtn(item.id)}
  </a>`;
}

function renderHome() {
  document.body.className = "view-home";
  if (!state.cardSlots.length) buildCards();
  $("#view").innerHTML = `
    <div class="home">
      <div id="banner-slot">${bannerHtml()}</div>
      <div class="cards4">${state.cardSlots.map(miniCard).join("")}</div>
      <form id="pl-form" autocomplete="off">
        <input id="pl-input" type="text" maxlength="120" placeholder="build me a playlist…">
        <button type="submit">Go</button>
      </form>
      <p id="pl-note" class="note" hidden></p>
    </div>`;

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
    const p = buildPlaylist(query);
    logEvent("playlist_built", { query, found: p ? p.item_ids.length : 0 });
    if (p) {
      location.hash = "#/playlist/" + p.id;
    } else {
      const note = $("#pl-note");
      note.textContent = "Couldn't find enough for that — try different words.";
      note.hidden = false;
    }
  });

  bindPickLogging($("#view"));
  bindStars($("#view"));
}

function epRow(item, idx, ctx, nextIdx) {
  return `<div class="ep-row">
    <span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>
    <div class="info">
      <div class="t">${esc(item.title)}</div>
      <div class="s">${esc(item.show)} · ${fmtDur(item.duration_min)}</div>
    </div>
    ${starBtn(item.id)}
    <a class="go" href="${esc(safeUrl(playLink(item)))}" target="_blank" rel="noopener"
       data-ev="picked" data-ep="${item.id}" data-ctx="${ctx}">Play</a>
  </div>`;
}

function renderPlaylistDetail(id) {
  document.body.className = "view-page";
  const p = playlistById(id);
  if (!p) { $("#view").innerHTML = `<div class="page"><p class="note">Playlist not found.</p></div>`; return; }
  fullPool(); // populate itemIndex
  const items = p.item_ids.map(i => state.itemIndex[i]).filter(Boolean);
  const history = new Set(pickedHistory());
  const nextIdx = items.findIndex(i => !history.has(i.id));
  const played = items.filter(i => history.has(i.id)).length;

  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2>${esc(p.title)}</h2>
          <p class="sub">${items.length}-part playlist · ${played} played</p>
        </div>
      </div>
      ${items.map((item, i) => epRow(item, i, "playlist-" + p.id, nextIdx)).join("")}
      <button class="danger" id="pl-remove">remove this playlist</button>
    </div>`;

  $("#pl-remove").addEventListener("click", () => {
    savePlaylists(playlists().filter(x => x.id !== p.id));
    logEvent("playlist_removed", { playlist_id: p.id });
    location.hash = "#/playlists";
  });
  bindPickLogging($("#view"));
  bindStars($("#view"));
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
