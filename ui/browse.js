/* ui/browse.js — Browse: the Shows index, category pages and the All Shows page.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


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
     catalogue is still kept; only the repaint is the asking page's.
     THE PAGE IS THE ROUTE, NOT THE RENDER (round-3 review, L2). renderToken
     compares the render epoch, which every renderCurrentPage bumps, same-page
     repaints included (the header's refresh, a drawer switch): one of those
     during the fetch repainted the failed state, the fetch then stored the
     catalogue, and nothing repainted, so the page said the catalogue had not
     loaded when it had. The Create build's rule (races-3): same hash, repaint. */
  const askedFrom = currentHash();
  const catalog = await fetchJson("data/catalog-client.json");
  if (catalog) state.catalog = catalog;
  if (currentHash() !== askedFrom) return;
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

/* THE SUBJECT PAGE (Redesign 2026, ambient, screen 15). A3.2's landing page, and the page a subject's name leads
   to from Discover ("History" in the field): ONE anatomy for both, Discover's result anatomy under a SectionHead
   that wears the subject's own 56 collage. Below it the subject's shows as ShowTiles, three across, each with the
   Follow badge where the show is followed (the state varies here, so the mark earns its place; Library draws none),
   then its latest episodes as Discover's compact rows. No pill wall: a subject's name is the only word the page
   needs.

   An unknown nodeId still renders - same "absence is a real state, not an error" rule renderShow's not-found
   guard follows - falling back to the raw id as its own label, and an empty list getting the shared "No shows
   here yet" copy rather than a dead end. NO COUNT WITHOUT A CATALOGUE: "0 shows" over a failed fetch was the same
   false claim as the empty-state sentence under it, so the failed page keeps the shared template, which draws
   neither. */
const SUBJECT_EPISODES = 8;

/** The first DISCOVER_TILE_ARTS covers among a subject's shows, in the order given: the 56 collage on a
    subject's tile and on its page, so the two are one picture. */
function subjectCollageArts(shows) {
  const arts = [];
  for (const show of shows) {
    const src = showArtworkUrl(show);
    if (src) arts.push({ name: show.title, src, tone: AG_TONES[arts.length % AG_TONES.length], decorative: true });
    if (arts.length === DISCOVER_TILE_ARTS) break;
  }
  return arts;
}

/** Most-charted first, then code-unit title order: the same order on every device (see discoverCompare). */
function subjectShowOrder(a, b) {
  const ra = Number.isFinite(a.chart_rank) ? a.chart_rank : Infinity;
  const rb = Number.isFinite(b.chart_rank) ? b.chart_rank : Infinity;
  return ra - rb || discoverCompare(String(a.title), String(b.title));
}

/** One show as a ShowTile: art 104, the name under it (three lines), a link to the show's page, and the
    Follow badge when the listener follows it. */
function subjectShowTile(show) {
  const followed = !!starredShowsMap()[show.show_id];
  return agShowTile({
    name: String(show.title || ""), src: showArtworkUrl(show) || "", showId: String(show.show_id), followed,
    tone: AG_TONES[agFnv1a(String(show.show_id)) % AG_TONES.length],
  });
}

/** The page's lead: the subject's 56 collage beside a SectionHead holding its name and "<n> shows". `level` 2
    when the head IS the page's title (the category page), 3 under Discover's own title. */
function subjectLeadHtml({ name, count, arts }, level = 2) {
  const items = arts.length ? arts : [{ name, tone: "amber", decorative: true }];
  return `<div class="cat-lead">${agCollage(items, { size: 56, lit: false })}${agSectionHead(name, countLabel(count, "show"), "", { level })}</div>`;
}

/** The newest episodes of the given shows from the discover pool, Family Mode applied, at most `limit`. One pass
    over the pool, not one per show (episodesForShow's cost, times a subject's shows). */
function subjectEpisodes(shows, limit = SUBJECT_EPISODES) {
  const wanted = new Set();
  for (const show of shows) {
    wanted.add(show.title);
    if (TITLE_ALIASES[show.title]) wanted.add(TITLE_ALIASES[show.title]);
  }
  return (state.discover?.items || [])
    .filter((it) => wanted.has(it.show) && familyAllows(it))
    .sort((a, b) => dateValue(b.release_date) - dateValue(a.release_date))
    .slice(0, limit);
}

function renderCategory(nodeId) {
  const node = (state.taxonomy?.nodes || []).find(n => n.id === nodeId);
  const label = node?.label || nodeId;
  if (catalogShowsOrNull() === null) { renderShowIndexPage(label, "", null); return; }
  const shows = showsForCategory(nodeId).slice().sort(subjectShowOrder);
  const episodes = subjectEpisodes(shows);
  setBodyClass("view-page");
  $("#view").innerHTML = `
    <div class="page ag cat">
      <div class="page-head cat-head">
        <a class="back ag-btn ag-btn-icon" href="#/" aria-label="Back">${agIcon("chevron-left", 24)}</a>
        ${subjectLeadHtml({ name: label, count: shows.length, arts: subjectCollageArts(shows) })}
      </div>
      ${shows.length
        ? `<div class="cat-tiles" role="list">${shows.map((show) => `<div role="listitem">${subjectShowTile(show)}</div>`).join("")}</div>`
        : `<p class="note">No shows here yet.</p>`}
      ${episodes.length
        ? `<section class="dsc-group cat-episodes">${agSectionHead("Episodes")}<div class="dsc-list">${episodes.map((item) => discoverEpisodeRow(item, "category")).join("")}</div></section>`
        : ""}
    </div>`;
  document.body.classList.add("ag-category");
  bindPlay($("#view"));
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
/* `decodeURIComponent` throws a URIError on a lone `%` — and a hash is
   user-authored text that anyone can type or paste. The other routes get away
   with the bare call because their ids come from our own links; this one is
   the shape a person types by hand. An undecodable query is not a query, so it
   degrades to "" and the caller lands on the plain browse page. */
function safeDecode(s) {
  try { return decodeURIComponent(String(s || "")); } catch (_) { return ""; }
}

/* ---------- DISCOVER'S SUBJECTS (Redesign 2026, ambient, screen 4) ----------

   The idle page is five broad heads, each a 2-up grid of SubjectTiles: a 56
   collage of the subject's own shows, its name and "<n> shows" (BUILD-NOTES
   section 4.4). It replaces the pill wall this page used to open with (a
   taxonomy-root pill for every one of 41 roots, 32 of which held no curated
   show) and, with it, "Followed shows" (Library owns those now) and the A-Z
   index of every show (the listener who does not know what they want gets
   subjects, not 220 names). The taxonomy stays internal: the five group names
   and the subjects' own labels are the only words on the page, never an id.

   WHAT A SUBJECT IS. A taxonomy ROOT with at least DISCOVER_MIN_SHOWS curated
   shows under it. A show is tagged with LEAVES ("science/materials"), so a
   root's count is the shows with any leaf below it, each counted once. A root
   with no show under it (Religion, News, Travel, Hobbies as of 2026-10-07)
   draws no tile: a tile that opens an empty search is the failure the pill
   wall had, and "1 show" is not a subject to browse. The groups are a fixed
   map from root id to head, so a root the taxonomy adds later with shows under
   it but no entry here is caught by test/discover-page.test.js rather than
   silently missing from the page.

   WHERE A TILE GOES: a search for its own label, `#/shows/q/<label>`, exactly
   what the pills did (founder, 2026-09-13, issue #684: "clicking on any of the
   tiles on the search page gives 0 results. It should just search for that
   text."). The measurement behind that is unchanged: a root is almost never a
   show's own tag, so `showsForCategory(root)` is empty for 32 of 41 roots,
   while searching the label reaches the catalogue, the directory and the
   on-device index. The count on the tile is the curated overlap and the search
   finds more, which is why it says "shows" and not "results". */
const DISCOVER_SUBJECT_GROUPS = [
  ["Science & nature", ["science", "nature", "health", "medicine", "space", "math"]],
  ["People & society", ["history", "society", "psychology", "true-crime", "relationships", "personal-journals",
    "kids-family", "philosophy", "cities", "education", "religion", "news"]],
  ["Business & work", ["business", "economics"]],
  ["Arts & culture", ["culture", "music", "comedy", "fiction", "food", "tv-film", "paranormal", "gaming",
    "sports", "adventure", "linguistics", "hobbies", "travel"]],
  ["Making & tech", ["engineering", "craft", "computing", "automotive", "aviation", "transport", "architecture", "espionage"]],
];
const DISCOVER_MIN_SHOWS = 2;
/* WHERE A LONG WORD MAY BREAK. The text column beside a 56 collage is 86px wide at 393 and 77 at 375, and
   five root labels have a word of eleven letters or more (measured over data/taxonomy.json, 2026-10-07). A
   name never ends in an ellipsis, and "Relationship / s" is worse than a cut, so those words carry one soft
   hyphen at the syllable (invisible until the line needs it, ignored by a screen reader). The set is the
   taxonomy's, not a hyphenation engine; a label added later that is too long still breaks (CSS
   `overflow-wrap: anywhere`), it just breaks without a hyphen until someone adds it here. */
const SOFT_HYPHEN = String.fromCharCode(0xAD);   // U+00AD, built rather than typed: an invisible character in source is a trap
const DISCOVER_SOFT_BREAKS = {
  Engineering: "Engi" + SOFT_HYPHEN + "neering", Architecture: "Archi" + SOFT_HYPHEN + "tecture", Linguistics: "Lin" + SOFT_HYPHEN + "guistics",
  Spirituality: "Spiri" + SOFT_HYPHEN + "tuality", Relationships: "Relation" + SOFT_HYPHEN + "ships",
};

/** A subject's name as it is DRAWN (soft breaks in); `tile.name` stays the label the search is run for. */
function discoverLabel(name) {
  return String(name).replace(/[A-Za-z]{10,}/g, (word) => DISCOVER_SOFT_BREAKS[word] || word);
}
const DISCOVER_TILE_ARTS = 4;

/** The root a taxonomy node id sits under (itself, when it is one). `null` for an id the taxonomy
    does not know — a show can carry a stale tag and must not take the page down. */
function discoverRootOf(nodeId, byId) {
  let node = byId.get(nodeId);
  for (let hops = 0; node && node.parent && hops < 8; hops++) node = byId.get(node.parent);
  return node ? node.id : null;
}

/** Code-unit order, not localeCompare: the tiles and their collages must be the same set of shows
    on every device (the same rule `showsWeVouchFor` follows, audit round 3, app-2-9). */
function discoverCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

let discoverGroupsMemo = { catalog: null, taxonomy: null, groups: [] };

/** The page's groups: `[{ name, tiles: [{ id, name, count, arts, shows }] }]` (`shows` is the subject's own set, in
    subjectShowOrder, and `count` is its length: the lead's number and the tiles under it come from the one array), empty groups dropped, tiles
    biggest first. Memoised on the two documents it reads, so typing never re-walks the catalogue. */
function discoverGroups() {
  const catalog = state.catalog;
  const taxonomy = state.taxonomy;
  if (discoverGroupsMemo.catalog === catalog && discoverGroupsMemo.taxonomy === taxonomy) return discoverGroupsMemo.groups;
  const byId = new Map((taxonomy?.nodes || []).map((n) => [n.id, n]));
  const showsByRoot = new Map();
  for (const show of (catalog?.shows || [])) {
    const roots = new Set();
    for (const id of (show.taxonomy_node_ids || [])) {
      const root = discoverRootOf(id, byId);
      if (root) roots.add(root);
    }
    for (const root of roots) {
      if (!showsByRoot.has(root)) showsByRoot.set(root, []);
      showsByRoot.get(root).push(show);
    }
  }
  const groups = DISCOVER_SUBJECT_GROUPS.map(([name, ids]) => ({
    name,
    tiles: ids
      .filter((id) => byId.has(id) && (showsByRoot.get(id) || []).length >= DISCOVER_MIN_SHOWS)
      .map((id) => {
        const shows = showsByRoot.get(id).slice().sort(subjectShowOrder);
        return { id, name: byId.get(id).label || id, count: shows.length, arts: subjectCollageArts(shows), shows };
      })
      .sort((a, b) => b.count - a.count || discoverCompare(a.name, b.name)),
  })).filter((group) => group.tiles.length);
  discoverGroupsMemo = { catalog, taxonomy, groups };
  return groups;
}

function discoverTileHtml(tile) {
  return agSubjectTile({ name: discoverLabel(tile.name), count: tile.count, items: tile.arts.length ? tile.arts : [{ name: tile.name, tone: "amber", decorative: true }], searchQuery: tile.name });
}

function discoverGroupsHtml(groups) {
  return groups.map((group) => `<section class="dsc-group" aria-label="${esc(group.name)}">
      ${agSectionHead(group.name)}
      <div class="dsc-grid">${group.tiles.map(discoverTileHtml).join("")}</div>
    </section>`).join("");
}

/** The subject a query names, for the empty page's "<Subject> is a subject" line, or `null`.
    A subject's own name matches by substring first (exact, then prefix, then anywhere, then the
    bigger one); failing that a GROUP's name does, and answers with that group's biggest subject.
    Three characters at least: one letter is a substring of nearly every name. */
function discoverSubjectMatch(query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 3) return null;
  const groups = discoverGroups();
  const rank = (name) => { const n = name.toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 9; };
  let best = null;
  for (const group of groups) {
    for (const tile of group.tiles) {
      const r = rank(tile.name);
      if (r < 9 && (!best || r < best.r || (r === best.r && tile.count > best.tile.count))) best = { r, tile };
    }
  }
  if (best) return best.tile;
  const group = groups.find((g) => g.name.toLowerCase().includes(q));
  return group ? group.tiles[0] : null;
}

/** The subject a query NAMES, whole: "History" is the History page, "hist" is a search. Case is ignored, so a
    tile's label, the same word lower-cased and a pasted `#/shows/q/history` all land on the subject page. */
function discoverSubjectExact(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  for (const group of discoverGroups()) {
    for (const tile of group.tiles) if (tile.name.toLowerCase() === q) return tile;
  }
  return null;
}

/* Which subject's lead is on the page now (`#sh-subject`), so a keystroke that keeps the same subject repaints
   nothing: rebuilding the collage's images on every letter would flicker them. Reset by each render. */
let subjectLeadShown = "";

/** Paints, or clears, the subject lead above Discover's results: the field holds a subject's whole name. */
function paintSubjectLead(text) {
  const box = $("#sh-subject");
  if (!box) return;
  const tile = discoverSubjectExact(text);
  const key = tile ? tile.id : "";
  if (key === subjectLeadShown) return;
  subjectLeadShown = key;
  box.innerHTML = tile ? subjectLeadHtml(tile, 3) : "";
  box.hidden = !tile;
}

/* THE IDLE FURNITURE: the five subject groups (or the failed-catalogue note
   standing in for them). Visible exactly when the field holds no query; a
   result list replaces it, and clearing the field brings it back. */
function showBrowseSections() {
  return [$("#sh-browse")].filter(Boolean);
}

/* Tracks whether the Discover field currently holds focus. A flag rather than
   `document.activeElement`: the field lives in an innerHTML template that is
   thrown away and rebuilt on every render, so the only honest source of truth
   is the focus/blur pair bound alongside it. Reset by renderAllShows on every
   render. */
let showSearchFieldFocused = false;

/* When that focus landed, in ms. Read by exactly one thing —
   maybeDismissKeyboardOnScroll — for exactly one reason, spelled out in that
   function's header: on iOS the keyboard's own arrival fires scroll events,
   so "the user scrolled" and "the keyboard just opened" are the same signal
   for a moment, and a dismiss-on-scroll rule with no settle window tears the
   keyboard down the instant it comes up. */
let showSearchFocusedAt = 0;

/* THE PAGE'S ONE PREDICATE ABOUT THE FIELD, in one place: is there a query?

   Redesign 2026 (ambient) overturns two things the old rule did here, and the
   PR names them (docs/redesign-2026/test-classification.md):
     - FOCUS NO LONGER HIDES THE IDLE PAGE. It did (founder, 2026-09-13: "the
       cards below the search box ... should go away when I click on the search
       box to start typing"), because the page under it was 17,000 px of A-Z
       shows and a focus that raised the keyboard also threw the viewport
       somewhere in the middle of them. The idle page is five short grids now,
       the prototype's focused state (`?state=kb`) keeps them on screen, and a
       list that is replaced by results the moment there is text needs no
       second rule for the moment before it. The scroll-to-top on focus went
       with it: there is nothing tall enough to need it.
     - THE x APPEARS WHEN THE FIELD IS FILLED, not when it is focused. It was
       Apple's "never mind" for a focused empty field; an empty field has
       nothing to clear, and the keyboard's return key and a tap elsewhere both
       put it away.
   What stays: the tab bar and the mini player yield to the KEYBOARD for as long
   as the field has focus (`body.sh-searching`), and the page's height goes with
   the idle furniture, which is why the pill must never be the only thing that
   knows about it.

   `body.sh-searching` is a CLASS ON <body>, not `hidden` on the bars, for the
   cascade reason renderTabBar's header documents: `.tab-bar` carries
   `display: flex`, and an author `display` beats the UA sheet's
   `[hidden] { display: none }` at any specificity. The class that hides the
   bars is also the class that zeroes their terms in `--sh-dock` (styles.css),
   so the pill cannot jump when they go. */
function updateShowBrowseVisibility() {
  const input = $("#sh-input");
  const text = input ? input.value.trim() : "";
  for (const el of showBrowseSections()) el.hidden = !!text;
  const dismiss = $("#sh-dismiss");
  if (dismiss) dismiss.hidden = !text;
  paintMakePlaylist(text);
  paintSubjectLead(text);
  document.body.classList.toggle("sh-searching", showSearchFieldFocused);
}

/* "Never mind" — empty the field, drop the painted results (the same reset a
   deleted query already gets), and let go of focus, so the page lands back on
   its idle groups by the ordinary rule rather than by a special case.

   ONE PATH, TWO TRIGGERS: Escape on a desktop keyboard (clear and let go), and
   the x in the pill for a thumb (clear and KEEP the caret: the next thing the
   listener does with a field they just emptied is type, so `keepFocus`).
   Extracted the day the button was added, rather than copied, so the two can
   never answer differently. */
function dismissShowSearch(input, { keepFocus = false } = {}) {
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
  if (!keepFocus) {
    showSearchFieldFocused = false;
    if (typeof input.blur === "function") input.blur();
  }
  updateShowBrowseVisibility();
}

/* DISCOVER (#/shows, and #/shows/q/<q>) — Redesign 2026, ambient, screen 4.

   One page, two postures. IDLE: the title, then the five subject groups (see
   discoverGroups). TYPING: the groups give way to the results, in three (four)
   groups under their own heads: Shows, Episodes, Playlists, and the Forays 4a
   made on the subject. The field is the Dock's top row; it stays where the
   founder put it on 2026-09-13 ("model it after most other text boxes, for
   example in the Claude app or Apple Podcasts") and gains the Afterglow pill:
   52 tall, the Veil, a magnifier, "Search, or name a subject", an x when it
   holds text, and a 2px Lamp ring OUTSIDE it when it has focus.

   `initialQuery` is #/shows/q/<q>'s payload — a subject tile's destination and
   anything else that wants to land here with an answer already on it. Empty
   string is the ordinary #/shows arrival. IT DOES NOT FOCUS THE FIELD. On a
   phone, focus raises the keyboard, and a listener who tapped "Science" asked
   to SEE shows, not to type. The query is in the box so it can be edited, the
   results are painted, and the keyboard stays down.

   WHAT THE FIELD IS, markup-wise. `#sh-compose` is `position: fixed`
   (styles.css), so where it appears in this template decides two things and
   neither is where it is painted: TAB / READING ORDER (it is emitted before
   the results, because it is the page's primary control and a keyboard or
   VoiceOver user should reach it without walking the grid) and LIFETIME (it is
   inside `#view`, so the next render throws it away with the rest of the page).
   `#sh-form` is still a real <form>: `submit` is what a phone keyboard's return
   key fires, and that is how the keyboard is put away from inside the field
   (the old Go button is gone for good, founder 2026-09-14). The x lives INSIDE
   the pill now (it was a circle beside it); it is a 44px icon button, hidden
   while the field is empty.

   BODY CLASSES. `sh-compose` reserves the room the floating row takes at the
   bottom edge; `ag-discover` is the page's own scheme (the warm Afterglow
   ground) and hides the legacy top bar, whose job (a drawer, a refresh) the
   direction moves to Today's gear. Both are added AFTER this function's own
   `setBodyClass()`, which writes document.body.className wholesale and is also
   what removes them again on the next navigation. */
function renderAllShows(initialQuery = "") {
  const query = String(initialQuery || "").trim();
  const catalogShows = catalogShowsOrNull();
  setBodyClass("view-page");
  /* `catalogShows === null` IS "THE CATALOGUE DID NOT LOAD" and is a different page from a
     catalogue with no subjects (audit 2026-09-22, theme G): the failed line has a Try again; a
     loaded catalogue that yields no tile (an offline cold start with the taxonomy missing) paints
     no furniture at all, and the field is the page. */
  const idle = catalogShows === null
    ? `<div class="show-index-failed">${failedNoteHtml("Couldn't load the show list.")}</div>`
    : discoverGroupsHtml(discoverGroups());
  $("#view").innerHTML = `
    <div class="page ag disc">
      <div class="page-head disc-head">
        <div><h2 class="t-title">Discover</h2></div>
      </div>
      <div id="sh-compose" class="dock-field veil">
        <form id="sh-form" class="ag-search-field" role="search" autocomplete="off">
          ${agIcon("magnifier", 20)}
          <input id="sh-input" type="text" maxlength="120" placeholder="Search, or name a subject" aria-label="Search, or name a subject" ${SEARCH_INPUT_ATTRS}>
          <button id="sh-dismiss" class="ag-btn ag-btn-icon" type="button" aria-label="Clear search" hidden>${agIcon("x", 20)}</button>
        </form>
      </div>
      <p id="sh-note" class="note" role="status" aria-live="polite" hidden></p>
      <div id="sh-partial-note" hidden></div>
      <p id="sh-offline-note" class="note" hidden>${OFFLINE_SEARCH_NOTE}</p>
      <div id="sh-subject" class="dsc-subject" hidden></div>
      <h3 class="sh-results-head t-headline">Shows</h3>
      <div id="sh-results" class="show-results dsc-list" hidden></div>
      <div id="ep-search-results" hidden></div>
      <div id="pl-search-results" hidden></div>
      <div id="fy-search-results" hidden></div>
      <div id="sh-empty" class="dsc-empty" hidden></div>
      <div id="sh-make" class="dsc-make" hidden></div>
      <div id="sh-browse">${idle}</div>
    </div>`;
  document.body.classList.add("sh-compose", "ag-discover");
  if (catalogShows === null) bindRetry($("#view .show-index-failed"), retryCatalog);

  /* S-02 (docs/search-plan.md, founder feedback F2: "Shows search should filter live as you type.
     Hitting Go should not be required."). THREE BINDINGS, AND THE SPLIT BETWEEN THEM IS THE WHOLE
     CARD:

       input   -> the LOCAL pass only, every keystroke, no network, no episode search, no playlist
                  work (0.010-0.074 ms median over the curated 220, 0.004-2.1 ms over S-03's
                  10,113-row index: inside a 16 ms frame either way). Then a 150 ms trailing
                  debounce (SHOW_SEARCH_DEBOUNCE_MS; the direction's number, down from 250) for
                  everything that costs something.
       submit  -> the same thing with the debounce SKIPPED. The keyboard's return key is the only
                  thing that lands here.
       focus   -> S-03's lazy index load, once. Never at init(): the decode is ~113 ms measured,
                  and it must not sit on the boot path or on a keystroke. */
  $("#sh-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#sh-input");
    const text = input.value.trim();
    if (!text) return;
    renderShowSearchResults(text);
    /* AND THE KEYBOARD COMES DOWN (audit round 2, search-3): "return" is how a phone keyboard is
       dismissed from inside the field, and a `preventDefault`ed submit leaves WebKit's keyboard
       exactly where it was. The blur leaves the results on screen. */
    if (typeof input.blur === "function") input.blur();
  });

  /* A fresh render starts from the resting state: nothing focused, the idle groups showing.
     `#/shows/q/<q>` is the one arrival that is NOT resting: the field is seeded first so
     `updateShowBrowseVisibility`'s one predicate (the field holds a query) hides the groups for
     the ordinary reason rather than through a second rule. */
  showSearchFieldFocused = false;
  subjectLeadShown = "";
  /* A NEW MOUNT SUPERSEDES EVERY PASS THE OLD ONE STARTED (audit 2026-09-22): type "radio", tap
     Home and tap Discover again inside the directory pass's ~0.5 s and the old pass still held
     the current token — its "radio" results painted above the groups, under an empty field. */
  supersedeShowSearch();
  if (query) {
    const seed = $("#sh-input");
    if (seed) seed.value = query;
  }
  /* This page IS the Discover tab's last stop, with or without a query; the tab bar reads it
     back when the lit tab is tapped from a pushed page. */
  rememberSearchTabHash(query ? "#/shows/q/" + encodeURIComponent(query) : "#/shows");
  updateShowBrowseVisibility();

  const input = $("#sh-input");
  if (input) {
    input.addEventListener("input", () => { onShowSearchInput(input.value); updateShowBrowseVisibility(); });
    /* Once. `loadShowIndex` is itself idempotent (it returns the in-flight promise, then the
       resolved index), so a second focus costs nothing and this needs no `{ once: true }` —
       which would be wrong anyway, since a first attempt that failed offline should be retried
       on a later focus. */
    input.addEventListener("focus", () => {
      loadShowIndex();
      showSearchFieldFocused = true;
      /* The two things scroll-to-dismiss needs, both stamped here rather than in the scroll
         handler, because here is where the event actually is. Re-baselining `lastScrollY`
         matters as much as the timestamp: without it the first post-focus scroll is measured
         against wherever the page last sat, and a stale baseline can hand the handler a large
         fake downward delta on the very first frame after focus. (There is no scroll to the top
         any more: see updateShowBrowseVisibility for why the page no longer needs one.) */
      showSearchFocusedAt = Date.now();
      lastScrollY = window.scrollY || 0;
      updateShowBrowseVisibility();
    });
    input.addEventListener("blur", () => {
      showSearchFieldFocused = false;
      updateShowBrowseVisibility();
    });
    /* Escape is the desktop "never mind": clear, and let go. */
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      dismissShowSearch(input);
    });
  }

  const dismiss = $("#sh-dismiss");
  if (dismiss) {
    /* `mousedown`, NOT `click`, and that is the whole reason this is not a one-liner. Pressing a
       button blurs the field first; the blur hides the x (an empty field has none), and the
       `click` that would have followed lands on an element that is no longer there — so on a
       desktop the button did nothing at all. `mousedown` fires before focus moves, and
       `preventDefault` stops the press from stealing focus in the first place, so the field
       keeps the caret and the keyboard stays up for the next query. Touch devices synthesise
       mousedown from a tap, so one listener covers both. */
    dismiss.addEventListener("mousedown", (e) => {
      if (typeof e.preventDefault === "function") e.preventDefault();
      dismissShowSearch(input, { keepFocus: true });
    });
    /* AND `click`, for the keyboard (audit 2026-09-22, qa row 62). Enter and Space on a <button>
       fire `click`, never `mousedown`, so a keyboard or switch user reached a named, focusable
       control that did nothing. A key-made click has `detail === 0`; a pointer's has already
       been handled by the mousedown above, so it is skipped rather than run twice. */
    dismiss.addEventListener("click", (e) => {
      if (e && e.detail !== 0) return;
      dismissShowSearch(input, { keepFocus: true });
      if (input && typeof input.focus === "function") input.focus();
    });
  }

  /* LAST, after every listener is bound, because this paints into the nodes above and then runs
     the same costly pass a submit would — a pass that can resolve at any point and must not land
     on a half-wired page. It is `renderShowSearchResults`, the SUBMIT path, verbatim: a tile IS a
     submit the listener did not have to type. AND IT LOADS THE INDEX (audit round 2, search-6):
     S-03 tied the index to the first FOCUS so a listener who never searches never pays the
     decode; a tile, a return via ‹ and a reload all arrive with a query and never focus the
     field on purpose, so a query arriving here IS a search, which is the case S-03's lazy rule
     was written to serve, not to skip. `#/shows` without a query still fetches nothing. */
  if (query) {
    loadShowIndex();
    renderShowSearchResults(query);
  }
}
