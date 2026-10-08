/* ui/library.js — Library (#/library). The Playlists list (#/playlists) lives in ui/playlist.js.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


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
   furniture, hidden the moment the field was focused. Forays are LINKED, capped at
   five like Playlists, and open their real page for the rest — the "browse here,
   act there" split the header above describes. Followed shows are listed WHOLE
   since #/starred-shows folded into this page (Redesign 2026, the Dock). */
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
  /* EVERY FOLLOWED SHOW, NO CAP, NO "ALL N" LINK (Redesign 2026, ambient, the Dock).
     `#/starred-shows` was this section's overflow page; it is folded into Library
     (ROUTE_ALIASES in app.js), so a cap here would send the listener to the page
     they are already on. A followed list is the listener's own and short. */
  return `<div class="show-results">${followed.map(starredShowRow).join("")}</div>`;
}

function renderLibrary() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so saved/history rows can play in-app

  /* Family Mode reaches Library too (data-integrity-4). An "unnamed" row has
     nothing in it to hide. */
  const family = (r) => r.state === "unnamed" || familyAllows(r.item);
  const allSavedRows = rowsForIds(Object.keys(savedMap()));
  const savedRows = allSavedRows.filter(family);
  const historyIds = pickedHistory().slice().reverse().slice(0, 20);
  const allHistoryRows = rowsForIds(historyIds);
  const historyRows = allHistoryRows.filter(family);
  /* WHAT FAMILY MODE HID IS SAID, NOT DENIED (round-3 review, L1). With every
     star filtered out the section said "Nothing saved yet", which is false:
     the stars exist and are only hidden. The show page says so
     (FAMILY_HIDES_NOTE); Library now does too, and counts a partial hide. */
  const familyHidNote = (hidden, what) => hidden > 0
    ? `<p class="note">Family mode is on, so ${hidden} ${what}${hidden === 1 ? " is" : "s are"} hidden.</p>`
    : "";
  const savedHidden = allSavedRows.length - savedRows.length;
  const historyHidden = allHistoryRows.length - historyRows.length;
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
    ? savedRows.map((r, i) => rowHtml(r, i, "library-saved")).join("") + familyHidNote(savedHidden, "saved episode")
    : savedHidden > 0
      ? familyHidNote(savedHidden, "saved episode")
      : `<p class="note">Nothing saved yet — tap ☆ on an episode to keep it here.</p>`;

  const historyHtml = historyRows.length
    ? historyRows.map((r, i) => historyRowHtml(r, i)).join("") + familyHidNote(historyHidden, "played episode")
    : historyHidden > 0
      ? familyHidNote(historyHidden, "played episode")
      : `<p class="note">No listening history yet — episodes you play show up here.</p>`;

  const playlistsHtml = allPlaylists.length
    ? allPlaylists.slice(0, 5).map(p =>
        libSummaryRow(`/${playlistRoute(p)}`, p.title, playlistLengthLabel(p))).join("")
      + (allPlaylists.length > 5 ? `<a class="lib-more" href="#/playlists">All ${allPlaylists.length} playlists ›</a>` : "")
    /* It said "build one from the home screen", and the builder left Home on
       2026-09-03 — the note named the one screen certain not to have it. It
       names Discover, where the Create tab's field now lives, and links there. */
    : `<p class="note">No playlists yet — <a href="#/shows">build one from Discover</a>.</p>`;

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
      ${state.downloadBridge ? libSection("Downloads", libraryDownloadsHtml(family)) : ""}
      ${libSection("History", historyHtml)}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindDownloads($("#view"));
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

/* The Playlists list (#/playlists) is ui/playlist.js's renderPlaylists: it moved there with the detail page when both were redesigned together
   (Redesign 2026, ambient). */
