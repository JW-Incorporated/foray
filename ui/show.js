/* ui/show.js — Show page (#/show/<id>): episode fetching and caching, similar shows, renderShow.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


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
  /* Past its TTL the ROW goes, but the text its rows put in itemIndex stays
     (round-3 review, L2): this runs before the refetch has answered, and an
     offline or failed refetch re-seeds nothing, so trimming here took the
     Episode notes off every episode page of this show for the session. The
     trim is LRU eviction's (cacheShowEpisodes), and a successful refetch
     replaces the rows anyway. */
  if (Date.now() - hit.at > SHOW_EPISODES_TTL_MS) { showEpisodesCache.delete(show_id); return null; }
  showEpisodesCache.delete(show_id);
  showEpisodesCache.set(show_id, hit);
  return hit;
}

function cacheShowEpisodes(show_id, payload) {
  const now = Date.now();
  // Expired rows are swept (the row only, as above); the text trim is eviction's.
  for (const [k, v] of showEpisodesCache) if (now - v.at > SHOW_EPISODES_TTL_MS) showEpisodesCache.delete(k);
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
  /* A STARRED episode keeps its text (round-3 review, L2): its star's snapshot
     holds up to 4000 characters of description, but resolveEpisode reads
     itemIndex first, so a trimmed entry hid notes a reload would show. */
  const saved = savedMap();
  for (const id of Object.keys(state.itemIndex)) {
    if (!id.startsWith(prefix) || state.poolIds.has(id) || saved[id]) continue;
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
   buildPlaylist's tiering already follows). Equal overlap prefers the
   candidate with FEWER taxonomy_node_ids in total (a Jaccard-style share:
   one shared node out of one is closer than one out of four), so a crowded
   row is not cut alphabetically (#560 item 9; measured in
   docs/research/similar-shows-eval-2026-10.md). show_id is only the final
   key, so the order is stable and pinnable in a test, not accidentally date-
   or insertion-order-dependent. Returns [] (never throws) for a show with no
   taxonomy_node_ids of its own — there is nothing to overlap against.

   `label_scope: "general"` (catalogue-personalization PKG-03, founder ruling
   24 in docs/roadmap/README.md) marks a broad show whose labels describe a
   slice of its episodes, not the show — SYSK is not a materials-science show.
   Overlap on such a label is not similarity, so a general show gets no
   Similar shows row and is never offered as one. */
function similarShows(show, limit = 6) {
  if (show?.label_scope === "general") return [];
  const nodeIds = new Set(show?.taxonomy_node_ids || []);
  if (!nodeIds.size) return [];
  const all = state.catalog?.shows || [];
  return all
    .filter(s => s.show_id !== show.show_id && s.label_scope !== "general")
    .map(s => ({ show: s, shared: (s.taxonomy_node_ids || []).filter(id => nodeIds.has(id)).length }))
    .filter(x => x.shared > 0)
    .sort((a, b) => b.shared - a.shared
      || (a.show.taxonomy_node_ids || []).length - (b.show.taxonomy_node_ids || []).length
      || a.show.show_id.localeCompare(b.show.show_id))
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
function showEpisodeCountLabel({ loadedCount, familyHidden = 0, fullyLoaded, curatedCount, isBreadthTier, stale, loadError, loadState }) {
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
  /* Every loaded row hidden by Family mode: the body says so
     (FAMILY_HIDES_NOTE), and one sentence per outcome means this says nothing. */
  if (loadedCount === 0 && familyHidden > 0) return "";
  if (loadedCount === 0) {
    return curatedCount
      ? `${curatedCount} episode${curatedCount === 1 ? "" : "s"} in 4a's catalogue`
      : "";
  }
  const staleNote = stale ? " (showing the last saved list — couldn't refresh just now)" : "";
  const familyNote = familyHidden > 0 ? ` (${familyHidden} hidden by Family mode)` : "";
  if (fullyLoaded) {
    return `${loadedCount} episode${loadedCount === 1 ? "" : "s"}${familyNote}${staleNote}`;
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
        the common in-session case. (Since catalogue-personalization PKG-10 the
        page it paints is then upgraded in the background by the one-row
        lookup below, because an index row carries no taxonomy nodes — see
        upgradeBreadthShowRow. The listener never waits on that lookup.)
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
    /* The index row is enough to paint the page, not to finish it: it carries
       no taxonomy nodes, so no chips and no Similar shows. Ask for the full row
       behind the paint (catalogue-personalization PKG-10). */
    upgradeBreadthShowRow(show_id);
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

/* AN INDEX-SEEDED BREADTH SHOW IS UPGRADED TO ITS API ROW (catalogue-
   personalization PKG-10, finishing #560 item 4).

   resolveMissingShow's index branch paints from the loaded show index, which
   holds a title and a tier and nothing else, so its seed carries
   `taxonomy_node_ids: []` — and it returned before the `api/shows/search?id=`
   fetch ran. Once the backend stopped zeroing breadth nodes (PKG-09), that
   early return was the one thing keeping a breadth show page that had been
   reached through search from showing its chips and its Similar shows. This
   asks for the same row the fetch path asks for, behind the page already on
   screen.

   ONLY AN ANSWER WITH NODES CHANGES ANYTHING. A failed fetch, a miss, or a row
   whose nodes are empty leaves the seeded page exactly as it is — no flash, no
   error state over a page that is working. A repaint that would draw the same
   page again is not worth the flicker.

   The repaint supersedes the seeded render first (`renderEpoch++`, the step
   renderCurrentPage takes before it repaints): that render's episode fetch is
   still in flight, and left current it would paint into the upgraded page's
   list and bind its own search handlers beside the new render's. */
function upgradeBreadthShowRow(show_id) {
  const isCurrentRender = renderToken();
  fetchApiJson(`api/shows/search?id=${encodeURIComponent(show_id)}`).then((data) => {
    /* Navigated away while the row was in flight — the same guard as
       resolveMissingShow's fetch path. */
    if (!isCurrentRender() || !onShowRoute(show_id)) return;
    const row = data?.show || null;
    if (!row || !Array.isArray(row.taxonomy_node_ids) || !row.taxonomy_node_ids.length) return;
    state.breadthShowCache[show_id] = { ...state.breadthShowCache[show_id], ...row };
    renderEpoch++;
    renderShow(show_id, parseShowRoute()?.query || "");
  }); // fetchApiJson swallows network/parse errors to null, which the row guard above ignores
}

/* ---------- Redesign 2026 (ambient): the show page's Room and its EpisodeRows ----------

   The numbers are docs/redesign-2026/directions/ambient/BUILD-NOTES.md section 10 item 10 and
   section 3 (EpisodeRow), drawn by ui/show.css. The page has two Afterglow parts and nothing else
   changed under them: THE ROOM (a scheme-following `.room` lit by the show's own colour, with the
   art at 160, the title, the count, Follow and its note) and THE EPISODES (EpisodeRows, latest
   first). The search field, the publisher's description, the subject chips, similar shows and the
   Forays that use the show keep the markup they had; their screens re-skin them later.

   THE ROW IS TODAY'S ROW. showEpisodeRowHtml() draws the same anatomy as todayEpisodeRow() (art 72,
   title as the one stretched link, Play 44, a meta line, a two-line why) with Today's own helpers
   and `.td-row` styling, so the two lists cannot drift apart; what differs is only what a show page
   knows: the show is the page, so the meta line is length and date, and the why-line is the first
   words of the publisher's own description (episodeRowSnippet), never ours. Save and Up Next are on
   the episode page (BUILD-NOTES item 11), not on a row, exactly as on Today.

   Its Play carries `data-sh-play`, not `data-play`: syncCardButtons() in the player repaints every
   `[data-play]` as a glyph-text button, which would wipe the row's icon (Today's `data-td-play` is
   the same fork). The page repaints its own rows from the player, below. */

/** `url("...")` for the --room-art custom property: safeUrl()'d, with the characters that could end
    the string percent-encoded, or `none` (safeUrl answers "#" for a URL it refuses, and `url("#")`
    is the page itself). */
function showCssUrl(src) {
  const u = src ? safeUrl(artUrl(src, 400)) : "";
  return u && u !== "#" ? 'url("' + String(u).replace(/["\\\r\n]/g, c => encodeURIComponent(c)) + '")' : "none";
}

/** The Room. `<h2>` stays the page's heading (landOnPage names the page by `.sh-head h2`); the count
    label is EMPTY here and filled by paintCount() alone (issue #687). */
function showRoomHtml(show, showArt) {
  return `<section class="room ag sh-room" data-sh-room data-glow-show="${esc(show.title)}">
    <div class="sh-bar"><a class="ag-btn ag-btn-icon sh-back back" href="#/" aria-label="Back">${agIcon("chevron-left", 24)}</a></div>
    <div class="sh-art">${agArtwork({ name: show.title, src: showArt || "", size: 160, state: "lit" })}</div>
    <div class="sh-head">
      <h2 class="t-title clamp3 sh-title">${esc(show.title)}${explicitBadge(show.explicit)}</h2>
      <p class="t-caption sh-sub" data-show-count></p>
    </div>
    ${showStarBtn(show.show_id)}
    <p class="t-caption sh-note show-follow-note">${esc(FOLLOW_NOTE)}</p>
  </section>`;
}

/** Light: the Room and the art are lit by the show (BUILD-NOTES 1.2). The colour is a pair of
    numbers from palette.js, and the backdrop is set through the CSSOM (an inline style attribute
    is not allowed under the CSP).

    TWO STEPS, in this order, on purpose: showRoomLight() is computed BEFORE the Room is in the DOM,
    because agGlowFor() reads the live --glow-l (a getComputedStyle, which flushes style); showApplyRoom()
    then only writes. Read after the Room exists, that flush would run the Room's first style at the
    default Glow and the write would TRANSITION it: a 200ms colour crossfade at every mount under
    Reduce Motion (the gates' reduced-motion check caught exactly that), and a flash of the default
    Glow otherwise. */
function showRoomLight(show, showArt) {
  return { glow: agGlowFor(show.title), art: showCssUrl(showArt) };
}

function showApplyRoom(scope, light) {
  if (!scope || typeof scope.querySelector !== "function" || !light) return;
  const room = scope.querySelector("[data-sh-room]");
  if (!room || !room.style || typeof room.style.setProperty !== "function") return;   // a stub document has no CSSOM
  room.style.setProperty("--glow", light.glow);
  room.style.setProperty("--room-art", light.art);
  const art = room.querySelector(".sh-art .ag-art");
  if (art && art.style && typeof art.style.setProperty === "function") art.style.setProperty("--art-glow", light.glow);
}

/** Latest first. Only when EVERY row carries a date: a mixed list keeps the order it arrived in,
    because a comparator over missing dates is not a total order and would shuffle rows. A copy, and Array sort is stable
    (every engine this app runs on), so equal dates keep the order they arrived in. */
function showRowsLatestFirst(rows) {
  const stamp = (r) => Date.parse(r.release_date || "");
  if (!rows.length || !rows.every((r) => Number.isFinite(stamp(r)))) return rows;
  return [...rows].sort((a, b) => stamp(b) - stamp(a));
}

/** What a row's second line says: state, length, date. The date goes when a state line is shown (a
    96px row at 375 has no room for both), as on Today. */
function showRowMetaHtml(rowState, item) {
  const dur = fmtDur(episodeMinutes(item));
  const date = rowState === "default" ? fmtDate(item.release_date) : "";
  const parts = [];
  if (dur) parts.push(`<span class="dur">${esc(dur)}</span>`);
  if (date) parts.push(`<span>${esc(date)}</span>`);
  return `${todayStateLine(rowState)}${parts.join('<span class="td-sep" aria-hidden="true"></span>')}`;
}

/** One EpisodeRow on a show page (see the block comment above). `ctx` is the page's play list name. */
function showEpisodeRowHtml(item, ctx) {
  const rowState = todayRowState(item);
  const pct = todayEpisodePct(item);
  const id = esc(encodeURIComponent(item.id));
  const playing = rowState === "playing";
  const blocked = rowState === "unavailable";
  const why = episodeRowSnippet(item);
  return `<article class="raised td-row sh-row is-${esc(rowState)}" data-sh-ep="${esc(item.id)}">
    ${todayArt({ name: item.show, src: item.artwork_url, size: 72, dim: blocked, pct })}
    <h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#/episode/${id}" data-ev="picked" data-ep="${esc(item.id)}" data-ctx="${esc(ctx)}">${esc(item.title || "")}</a>${explicitBadge(item.explicit)}</h3>
    ${item.audio_url ? todayPlayButton({ size: 44, label: `${playing ? "Pause" : "Play"} ${item.title || "this episode"}`, attrs: ` data-sh-play="${esc(item.id)}" data-ctx="${esc(ctx)}" data-title="${esc(item.title || "")}"`, disabled: blocked, icon: playing ? "pause" : "play" }) : ""}
    <p class="t-caption td-row-meta">${showRowMetaHtml(rowState, item)}</p>
    ${why ? `<p class="t-why clamp2 td-row-why">${esc(why)}</p>` : ""}
  </article>`;
}

/** A show page's list of EpisodeRows: latest first, and the rows Family Mode hides never reach it
    (the caller filtered them). */
function showEpisodeRowsHtml(items, ctx) {
  return showRowsLatestFirst(items).map((item) => showEpisodeRowHtml(item, ctx)).join("");
}

/** Repaint every row's playing state from the player, the single authority: the row class, the Play
    glyph and its name, and the Lamp "Playing" caption (as todaySyncPlay does for Today). */
function showSyncPlay() {
  const scope = document.querySelector("[data-show-episodes]");
  const player = window.ForayPlayer;
  if (!scope || !player || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-sh-ep]").forEach(row => {
    const id = row.dataset.shEp;
    let on = false;
    try { on = !!player.isPlaying?.(id); } catch (_) { on = false; }
    if (row.classList.contains("is-playing") === on) return;
    row.classList.toggle("is-playing", on);
    const btn = row.querySelector("[data-sh-play]");
    const meta = row.querySelector(".td-row-meta");
    if (btn) {
      btn.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${btn.dataset.title || "this episode"}`);
      btn.innerHTML = agIcon(on ? "pause" : "play", 20);
    }
    if (meta) {
      const line = meta.querySelector(".ag-row-state");
      if (line) line.remove();
      if (on) meta.insertAdjacentHTML("afterbegin", todayStateLine("playing"));
    }
  });
}

let showPollTimer = null;
function showStartPoll() {
  if (showPollTimer || typeof setInterval !== "function") return;
  showPollTimer = setInterval(() => {
    if (!document.querySelector("[data-show-episodes]")) { clearInterval(showPollTimer); showPollTimer = null; return; }
    showSyncPlay();
  }, 1000);
}

/** A row's Play: a row showing Pause pauses (the rule bindPlay learned, founder 2026-09-22); anything
    else starts that episode with the page's rows as the continuous-play list. */
async function showPlayPress(btn, scope) {
  const id = btn.dataset.shPlay;
  const player = window.ForayPlayer;
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !player) return;
  if (player.isCurrent?.(id)) { await player.togglePlayback(); showSyncPlay(); return; }
  const list = [...scope.querySelectorAll("[data-sh-play]")].filter(b => !b.disabled).map(b => ({ id: b.dataset.shPlay, ctx: b.dataset.ctx }));
  await startEpisodePlay(id, item, { ctx: btn.dataset.ctx || null, list });
  showSyncPlay();
}

function bindShowPlay(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-sh-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); showPlayPress(btn, scope); });
  });
}

function renderShow(show_id, initialQuery = "") {
  setBodyClass("view-page");
  const show = showById(show_id);
  if (!show) { resolveMissingShow(show_id); return; }
  /* The Room is the page's own top: the legacy bar steps aside, as on Today (ui/show.css). This is AFTER the missing-show
     guard on purpose: every status page (loading, not found, couldn't load, `pi:`) has no Room, so it keeps the legacy bar
     and #view's top padding, which clear the status bar; hiding them left its page head and Back under a notch. */
  try { document.body.classList.add("view-show"); } catch (_) { /* a stub document */ }
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

  /* THE ROOM IS OUTSIDE `.page` (Redesign 2026, ambient): it runs edge to edge under the status bar,
     lit by the show; the legacy `.page-head` and `.show-hero` it replaces are gone. Everything the
     page still draws in the old style (description, subject chips, the search field, similar
     shows, Forays) sits in `.page` below it. */
  const head = `
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
  const roomLight = showRoomLight(show, showArt);   // before the Room exists: see showRoomLight
  $("#view").innerHTML = `${showRoomHtml(show, showArt)}<div class="page sh-body">${head}${searchBox}<div class="ag sh-eps"><div data-show-episodes></div></div>
  ${similarShowsSection(show)}
  <div data-show-forays>${showForaysHtml(show)}</div>
  </div>`;
  showApplyRoom($("#view"), roomLight);
  bindPickLogging($("#view"));
  bindShowStars($("#view"));
  showStartPoll();

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
    bindShowPlay(c);
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
    c.innerHTML = showEpisodeRowsHtml(rows, ctx);
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
      const rows = showEpisodeRowsHtml(curatedEps, ctx);
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
    /* The count is of the rows on screen (round-3 review, L1): with Family
       mode on, paintList hides rows, and "120 episodes" above fewer rows, or
       above FAMILY_HIDES_NOTE, is the count/row disagreement #276/#687 name. */
    const shownCount = familyMode()
      ? loaded.filter((ep) => familyAllows(fullCatalogueRowToEpRowItem(show, ep))).length
      : loaded.length;
    el.textContent = showEpisodeCountLabel({
      loadedCount: shownCount,
      familyHidden: loaded.length - shownCount,
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
