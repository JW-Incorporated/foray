/* ui/search.js — Search page (#/search): show, playlist, episode and Foray results; show-search caches.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


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

/* ---------- DISCOVER'S RESULT ROWS (Redesign 2026, ambient, screen 4) ----------

   Four row kinds, one anatomy: a RAISED row, the art at 56 on the left, a `--t-label` name
   (two lines, never an ellipsis cut mid-word), one `--t-caption` meta line, nothing else. No
   why-line on an episode (BUILD-NOTES 4.4: the product's main copy lives on Today, and a search
   result is an answer, not a pick). Each is built from the Phase-3 primitives' markup
   (`agArtwork`, `agCollage`) so a result and a gallery plate cannot drift.

   `showResultRow` above is NOT this: it is the plain row the category and show pages still use,
   and it stays until those screens are built. */

/** What a SHOW's caption says: "<n> episodes" when the catalogue knows the count (176 of the 229
    curated shows do; a directory or shard row never does), else the byline when the row carries
    one, else the word for what it is. Every result row has art and ONE meta line (DIRECTION.md,
    Discover): a title-only row is shorter, its title centres, and the list loses its shared
    baseline. A followed show says so in words as well as in the badge (a state is never only a
    mark). */
const DISCOVER_SHOW_KIND = "Podcast";
function discoverShowMeta(show, followed) {
  const n = Number(show?.episode_count);
  const by = typeof show?.artist_name === "string" ? show.artist_name.trim() : "";
  return joinMeta(followed ? "Following" : "", n > 0 ? esc(countLabel(n, "episode")) : esc(by || DISCOVER_SHOW_KIND));
}

/** One matched show. The followed badge (`i-check-circle-fill`, Ember, 20, the art's bottom-right)
    is drawn HERE and in "Where this came from" only: it marks state that varies, and in Library
    every tile is followed so a mark would say nothing (BUILD-NOTES 10.7). */
function discoverShowRow(show) {
  const followed = !!starredShowsMap()[show.show_id];
  const meta = discoverShowMeta(show, followed);
  return `<a class="dsc-row dsc-show raised" href="#/show/${encodeURIComponent(show.show_id)}" title="${esc(show.title)}">
    ${agArtwork({ name: show.title, src: showArtworkUrl(show) || "", size: 56, decorative: true, badge: followed ? "check-circle-fill" : "" })}
    <span class="dsc-copy"><span class="t-label clamp2">${esc(show.title)}</span>${meta ? `<span class="t-caption dsc-meta">${meta}</span>` : ""}</span>
  </a>`;
}

/** One matched episode, COMPACT: art, title, "<show> · <min> · <date>", and the one play control.
    The row is a link to the episode page and the play button is its SIBLING (a button inside an
    anchor is two controls on one target, test/card-anatomy.test.js). The star and the Up Next
    button the old row carried are not drawn: the episode page has both, and a result row is for
    deciding, not for filing. */
function discoverEpisodeRow(item, ctx) {
  const play = playBtn(item, ctx) || notPlayableNote();
  const art = item.artwork_url || showArtworkUrl(showById(item.show_id)) || "";
  const meta = joinMeta(esc(item.show || ""), fmtDur(episodeMinutes(item)), esc(fmtDate(item.release_date)));
  return `<article class="dsc-row dsc-ep raised">
    <a class="dsc-row-link" href="#/episode/${esc(encodeURIComponent(item.id))}">
      ${agArtwork({ name: item.show || item.title, src: art, size: 56, decorative: true })}
      <span class="dsc-copy"><span class="t-label clamp2">${esc(item.title)}${explicitBadge(item.explicit)}</span>${meta ? `<span class="t-caption dsc-meta">${meta}</span>` : ""}</span>
    </a>
    ${play}
  </article>`;
}

/** The first four distinct covers in a playlist's parts, for its 2x2 collage. A part the live pool
    no longer carries still names its show, so it still contributes a cover when it has one. */
function discoverPlaylistArts(p) {
  const arts = [];
  const seen = new Set();
  for (const part of resolveParts(p)) {
    const item = part.item || {};
    const src = item.artwork_url || showArtworkUrl(showById(item.show_id)) || "";
    if (!src || seen.has(src)) continue;
    seen.add(src);
    arts.push({ name: item.show || item.title || p.title, src, tone: AG_TONES[arts.length % AG_TONES.length], decorative: true });
    if (arts.length === 4) break;
  }
  return arts.length ? arts : [{ name: p.title, tone: "amber", decorative: true }];
}

/** One matched playlist: the listener's own, or one 4a generated for them (said in Lamp, the colour
    of what 4a authored). */
function discoverPlaylistRow(p, generated) {
  const meta = joinMeta(esc(playlistLengthLabel(p)), generated ? `<span class="dsc-gen">Generated for you</span>` : "");
  return `<a class="dsc-row dsc-pl raised" href="#/${esc(playlistRoute(p))}">
    ${agCollage(discoverPlaylistArts(p), { size: 56, lit: false })}
    <span class="dsc-copy"><span class="t-label clamp2">${esc(p.title)}</span><span class="t-caption dsc-meta">${meta}</span></span>
  </a>`;
}

/** One matched Foray (a Foray 4a made on the subject, p-foray-4): a Lamp eyebrow, the title and the
    list's own length/progress line. It carries no cover: a Foray's running order is not resolved
    for a search row, and a letter in a gold tile says so rather than inventing one. */
function discoverForayRow(f, progress) {
  const sub = forayListSubLabel(f, progress, { draftTag: false });
  return `<a class="dsc-row dsc-foray raised" href="#${esc(forayRoutePath(f.id))}">
    ${agArtwork({ name: f.title, size: 56, tone: "gold", decorative: true })}
    <span class="dsc-copy">${f.status === "published" ? "" : `<span class="eyebrow lamp">Draft</span>`}<span class="t-label clamp2">${esc(f.title)}</span>${sub ? `<span class="t-caption dsc-meta">${esc(sub)}</span>` : ""}</span>
  </a>`;
}

/** A results group: a SectionHead and its rows. `aside` is a caption under the rows (the episode
    group's "Showing 7 of 10" and its attribution), already escaped. */
function discoverGroupHtml(cls, title, rows, aside = "") {
  return `<section class="dsc-group ${cls}">
    ${agSectionHead(title)}
    <div class="dsc-list">${rows}</div>
    ${aside ? `<p class="t-caption dsc-aside">${aside}</p>` : ""}
  </section>`;
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
/* 150 ms (was 250, Redesign 2026): the direction's number (BUILD-NOTES 4.4, "debounced 150ms"). The
   keystroke pass is local and immediate either way; this is only how long the costly passes wait
   for the listener to stop. A tick that fires on a pause the listener did not mean costs two endpoint
   calls, which the hot-query caches absorb on a retype. */
const SHOW_SEARCH_DEBOUNCE_MS = 150;
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
  hideDiscoverEmpty();
  paintMakePlaylist("");
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
    /* REDESIGN 2026: the "No shows found" line is gone. Once EVERY group has answered and every
       one was empty, the page says so in the EmptyState (paintDiscoverEmpty); before that this
       is a searching page and says only that. A search whose Shows group is empty but whose
       Episodes or Playlists are not paints nothing here: those rows are the answer, and a line
       about shows above them denied it. */
    const answered = showSearchAnswered.token === myToken;
    if (answered) { note.textContent = ""; note.hidden = true; }
    else { note.textContent = `Searching for ${quoteQuery(query)}…`; note.hidden = false; }
    return;
  }
  note.hidden = true;
  hideDiscoverEmpty();
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
  results.innerHTML = shows.slice(0, cap).map(discoverShowRow).join("")
    + (more > 0 ? `<button type="button" class="ag-btn ag-btn-quiet dsc-more" data-sh-more>Show more shows</button>` : "");
  results.hidden = false;
  const moreBtn = more > 0 && typeof results.querySelector === "function" ? results.querySelector("[data-sh-more]") : null;
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      if (myToken !== showSearchToken) return;
      showSearchPaintCap = { token: myToken, query, n: cap + SHOW_RESULTS_PAINT_STEP };
      paintShowResults(query, showSearchPainted.rows, myToken);
      /* FOCUS LANDS ON WHAT WAS REVEALED (round-3 review, L2; the a11y-6 /
         nav-3 rule for a replaced control). The repaint destroys the focused
         button, and focus fell to <body>: a keyboard or VoiceOver user was
         sent back to the top of the document. The first new row takes it, or
         the next "Show more shows" when there is no row to take it. */
      const painted = typeof results.querySelectorAll === "function" ? results.querySelectorAll(".dsc-show") : [];
      const target = painted[cap] || (typeof results.querySelector === "function" ? results.querySelector("[data-sh-more]") : null);
      if (target && typeof target.focus === "function") target.focus();
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

/* ---------- THE EMPTY PAGE, AND "MAKE A PLAYLIST" (Redesign 2026, ambient, screen 4) ----------

   NOTHING IS "NOTHING" UNTIL EVERY GROUP HAS ANSWERED. The shows passes, the
   episode endpoint and the playlist scan answer on their own schedules, and an
   empty Shows list over a still-owed Episodes list is a SEARCHING page, not an
   empty one (audit 2026-09-22, theme G). `showSearchAnswered` is the token whose
   three halves have all reported; `runShowSearchCostly` writes it and only then
   asks whether the page is empty. The line it paints is the EmptyState
   primitive's: "Nothing named <q>." and, when the text is part of a subject's
   name, "<Subject> is a subject, <n> shows." with that subject's own tile under
   it, so the message can never contradict what the idle page offers. It replaces
   "No shows found for <q>." (which named one group of four) and the chips of
   "Shows filed under X" (a tile is the better door to the same place). */
let showSearchAnswered = { token: -1 };

function hideDiscoverEmpty() {
  const box = $("#sh-empty");
  if (box) { box.innerHTML = ""; box.hidden = true; }
}

function paintDiscoverEmpty(query, myToken) {
  if (myToken !== showSearchToken) return;
  const box = $("#sh-empty");
  if (!box) return;
  const subject = discoverSubjectMatch(query);
  const lines = [`Nothing named ${quoteQuery(query)}.`];
  /* Offline, the answer is "nothing on this device", and saying only the first half would be a
     claim about 4a's catalogue made by a phone with no signal. */
  if (isOfflineForShardSearch()) lines.push("You're offline, so only names already on this device were checked.");
  if (subject) lines.push(`${quoteQuery(subject.name)} is a subject, ${countLabel(subject.count, "show")}.`);
  box.innerHTML = agEmptyState({
    lines,
    extra: subject ? `<div class="dsc-empty-tile">${discoverTileHtml(subject)}</div>` : "",
    action: null,
  });
  box.hidden = false;
}

/* THE CREATE PATH, ON DISCOVER. Create folded into this page's one field
   (DIRECTION.md, "Information architecture"): the field both searches and builds a
   playlist from a subject, so once the text is three characters long a Primary
   button at the bottom of the results offers to MAKE a playlist from it, whether
   the results are a list or the empty page.

   Three characters, because that is where the topic scorer starts to mean
   something and where the directory pass starts too (SHOW_DIRECTORY_MIN_QUERY_
   LENGTH). It is offered whatever the results are, which overturns audit round 2,
   search-2 ("offered only when the tap yields a playlist"): that gate cost a
   1.3-8 s relaxation scan on the debounce tick and it withheld the button on the
   very page (nothing found) where the direction wants it. The honest half of the
   old rule survives at the other end: a build that cannot make a playlist says why
   under the button (`createFailureNote`, in `#sh-make-note`) and moves nothing.

   It is the ONE build (`buildPlaylistFromDiscover`, ui/create.js): same flag, same
   buildPlaylist(), same local `playlist_built` event. Nothing here writes to a
   server, so a lab build has nothing to gate; test/discover-page.test.js pins that
   the path reaches no fetch. */
const MAKE_PLAYLIST_MIN_CHARS = 3;

function paintMakePlaylist(text) {
  const box = $("#sh-make");
  if (!box) return;
  const q = String(text || "").trim();
  if (q.length < MAKE_PLAYLIST_MIN_CHARS) { box.innerHTML = ""; box.hidden = true; return; }
  const painted = box.hidden ? null : box.querySelector("[data-make-playlist]");
  /* The same text is already on the button: leave it, and the pending state and the note under
     it, exactly as they are. */
  if (painted && painted.getAttribute("data-make-playlist") === q) return;
  box.innerHTML = `<button type="button" class="ag-btn ag-btn-primary dsc-make-btn" data-make-playlist="${esc(q)}">${agIcon("sparkle", 20)}<span>${esc(`Make a playlist from ${quoteQuery(q)}`)}</span></button>
    <p id="sh-make-note" class="note" role="status" hidden></p>`;
  box.hidden = false;
  const btn = box.querySelector("[data-make-playlist]");
  if (btn) btn.addEventListener("click", () => buildPlaylistFromDiscover(q, btn));
  paintMakePending(createBuildPending);
}

/** The pending state, painted from the flag onto whatever button is on screen (the same rule
    paintCreatePending follows): the build waits for the search documents and a cold start can take
    seconds, so a tap that looks like nothing is the failure to prevent. */
function paintMakePending(pending, button) {
  const btn = button || $("#sh-make [data-make-playlist]");
  if (!btn) return;
  const q = btn.getAttribute("data-make-playlist") || "";
  btn.disabled = !!pending;
  if (pending) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
  btn.classList.toggle("is-loading", !!pending);
  const label = btn.querySelector("span") || btn; // the span keeps the sparkle icon; a bare button is its own label
  setStatusText(label, pending ? "Building…" : `Make a playlist from ${quoteQuery(q)}`);
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
  hideDiscoverEmpty();
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
    answerDone();
  };

  /* THE THREE HALVES THAT DECIDE "NOTHING" (Redesign 2026): the shows passes above, the episode
     endpoint and the playlist group each report exactly once on every exit path. When the last
     of them is in, this token is ANSWERED, and only then can the page be empty for real: a
     Shows group with no rows over an Episodes group still owed is a searching page. The empty
     page is painted by paintDiscoverEmpty; the "Searching..." line goes with it. */
  let answersOwed = 3;
  const answerDone = () => {
    if (--answersOwed > 0) return;
    if (myToken !== showSearchToken) return; // superseded: the newer query owns the page
    showSearchAnswered = { token: myToken };
    const empty = (sel) => { const el = $(sel); return !el || el.hidden; };
    const rows = paintedShowRows(query, myToken, local.localShows);
    if (rows.length || !empty("#ep-search-results") || !empty("#pl-search-results") || !empty("#fy-search-results")) return;
    paintShowResults(query, rows, myToken);   // drops the "Searching..." line
    paintDiscoverEmpty(query, myToken);
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

  renderEpisodeSearchResults(query, myToken, (epMs, epHits) => { settle({ epMs, epHits }); answerDone(); }, local.localEpisodes);
  renderPlaylistSearchResults(query, myToken, (ctaMs) => { settle({ ctaMs }); answerDone(); });
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

/* U-05 (docs/ui-transition-plan.md D7): the Playlists group under Shows and
   Episodes results. Unlike renderEpisodeSearchResults this is entirely
   LOCAL/SYNCHRONOUS -- both sources (cp_playlists, cardSlots) are already
   in memory, so there is no fetch to guard against staleness beyond the
   same `myToken` check every section here shares (a fast retype still must
   not let a slow show-search token's residual call clobber a newer one,
   though nothing here awaits anything itself).

   ORDER (the card's own "own playlists first, then generated" rule): the
   listener's own matching playlists lead, each linking to the same
   #/playlist/:id page the Playlists page opens. Generated candidates follow,
   visibly marked "Generated for you" (D5's own wording, reused verbatim) -- the
   reader must be able to tell the two apart before tapping, same principle as
   U-03's Home badge.

   THE CREATE CTA IS NOT HERE ANY MORE (Redesign 2026). It was this section's
   fallback when nothing matched and the topic scorer could build one, and it
   cost a 1.3-8 s scan scheduled when idle ("Still looking for playlists...").
   Create folded into Discover's field: the "Make a playlist from <q>" button
   (paintMakePlaylist) belongs to the PAGE, shows under every kind of result
   once the text is three characters long, and builds in place. So this group is
   only ever a list, or nothing, and `reportCtaMs(null)` answers at once: the
   diagnostics record keeps its `ctaMs` field and says "this half did not run". */
function playlistSearchMatches(query) {
  const own = playlists().filter(p => playlistMatchesQuery(p, query));
  const ownIds = new Set(own.map(p => p.id));
  const generated = generatedPlaylistCandidatesForQuery(query).filter(p => !ownIds.has(p.id) && !currentCopyOf(p, own));
  return { own, generated };
}

function renderPlaylistSearchResults(query, myToken, reportCtaMs = () => {}) {
  const container = $("#pl-search-results");
  if (!container) { reportCtaMs(null); return; } // page markup not present (e.g. a caller that reuses renderShowIndexPage without it)
  if (myToken !== showSearchToken) { reportCtaMs(null); return; } // superseded before this ran

  const { own, generated } = playlistSearchMatches(query);
  if (!own.length && !generated.length) {
    container.innerHTML = "";
    container.hidden = true;
    reportCtaMs(null);
    return;
  }
  container.innerHTML = discoverGroupHtml(
    "fy-playlist-search",
    "Playlists",
    own.map(p => discoverPlaylistRow(p, false)).join("") + generated.map(p => discoverPlaylistRow(p, true)).join(""),
  );
  container.hidden = false;
  reportCtaMs(null); // the scan never ran: a playlist already matched, or there is nothing to offer
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
      return discoverEpisodeRow(item, ctx);
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
    return discoverEpisodeRow(item, ctx);
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
  /* `notes` is already markup-safe: the two numbers go through esc() and the rest is a literal of
     this file (an apostrophe in element text needs no entity, and a test reads it as written). */
  const countNote = heldBack ? `Showing ${esc(endpointShown)} of ${esc(total)}${data?.capped ? "+" : ""}` : "";
  const appleNote = fromApple ? "from Apple's index" : "";
  const notes = [countNote, appleNote].filter(Boolean).join(" · ");
  /* The attribution stays where its rule put it (see `fromApple`): under the group when there is
     no local tier, and as a divider ABOVE the endpoint's rows when there is one. */
  container.innerHTML = discoverGroupHtml(
    "fy-episode-search",
    "Episodes",
    `${localRows.join("")}${local.length && notes ? `<p class="t-caption dsc-aside fy-episode-search-more">${notes}</p>` : ""}${remoteRows.join("")}`,
    !local.length ? notes : "",
  );
  container.hidden = false;
  /* The compact row has a play control and a link: no star, no Up Next button, so nothing else to
     bind (the episode page carries both). */
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
  const progress = forayProgressLabels();
  container.innerHTML = discoverGroupHtml("fy-foray-search", "Forays", hits.map((f) => discoverForayRow(f, progress)).join(""));
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
