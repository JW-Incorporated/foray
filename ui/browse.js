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
