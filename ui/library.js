/* ui/library.js — Yours, formerly Library (#/library), and the Playlists list (#/playlists).
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
     Up Next   cp_queue   via queueRows()    — the page's own list since Redesign
                                                2026 (tactile `library`): see
                                                "YOURS (TACTILE)" below. It was a
                                                summary row linking to #/queue.

   Playlists is LINKED, not embedded (Joey's call is made here, for the PR to
   explain): it already has a real page (#/playlists) with its own controls
   (build/remove) that this aggregate view has no room for at mobile width —
   Library shows a short summary (title + count, capped at 5) that opens
   straight into the real page, the same "browse here, act there" split the
   mockup itself draws between LibraryScreen and the screens it links out to
   (`playForay`/`openShow` in the mockup, `#/playlist/:id` and `#/show/:id`
   here). Saved and History get the FULL row treatment (epRow/archivedRow)
   because Library IS their only page — there is no separate #/saved or
   #/history to defer to.

   Every link on this page is in-app: episode rows resolve through
   epRow/archivedRow (which already only ever link within 4a or, for a part
   with no in-app audio, out to the episode's own listening app — the same
   fallback every other row in the app already uses, never a new one), and
   the Playlists summaries link to their own in-app pages. Nothing here
   introduces a new external link-out.

   History is newest-first (`pickedHistory()` appends, so the raw array is
   oldest-first) and capped at the same 20 rows for the same reason renderHome
   caps its rails — a scroll-forever list is not what "recently listened"
   means. Saved has no cap: an unbounded star list is the one honest reading
   of "everything you saved". */
/* The href is `"#" + hashPath` through safeUrl like every other (CLAUDE.md
   § Conventions: "all href/src through safeUrl()"; test/app-security.test.js
   reads every interpolated href, whatever it opens with). hashPath is this
   module's own constant route or an encoded id, which safeUrl passes as an
   in-app route. */
function libSummaryRow(hashPath, title, sub) {
  return `<a class="pl-row" href="${esc(safeUrl("#" + hashPath))}">
    <div class="info">
      <div class="t">${esc(title)}</div>
      <div class="s">${esc(sub)}</div>
    </div>
    <span class="chev">›</span>
  </a>`;
}

/* FORAYS AND FOLLOWED SHOWS ARE LIBRARY SECTIONS (founder, 2026-09-22: "Forays
   into Library, no new tab"; audit personas 32 and 50). The tab bar lit Library
   for #/forays and every Foray page while Library listed no Forays, and the only
   way to the shows a listener followed was a row inside the Search page's browse
   furniture, hidden the moment the field was focused. Both are Yours panels now,
   and both list everything (the Forays and Shows panels below), not five. */

/* THE FORAYS PANEL (tactile `library-forays`, BUILD-PLAN 2.13, BUILD-NOTES 4.5).
   Every Foray this listener may see, one card each, in the Forays list's own
   order. It was five summary rows ending in "All N forays", linking to #/forays;
   the cards ARE the whole list, so that link is gone (the route still resolves).

   RULING THAT FELL: "Yours' Forays is a capped summary of five rows that opens
   #/forays" (the Library section of test/foray-surfaces.test.js).

   A CARD is not a link (the Today hero's rule): the title is its one link and
   Play is the key beside the readout, siblings, each at least 44px. Between them
   is the Foray's own band at the 8px `mini` size, drawn from the same strip model
   Today's hero uses (`todayHeroModel`), so a Foray is the same object on both
   screens: a bar per clip coloured by its show, narration as solid ultramarine
   ticks. The readout under it is "about 22 min · 4 shows", then how far the
   listener is ("12 min left", "Played"), the one place that is said; a draft
   says "draft" first.

   RESUME is on the band itself: the bars the listener has played are full, the
   rest sit at 40%, and the needle stands where they stopped (the primitive's
   `progress`). A Foray not started, or finished, draws no needle and no fill: a
   finished one is "Played" in words, and a full band with a needle parked at its
   end would read as one more start line. Play is `[data-home-play]`, the press
   Today's keys use (`bindHomePlay`): the Foray is resolved at the press and
   handed to the player. */
function yoursForayProgress() {
  /* Every listed Foray's place, finished ones included, uncapped (honesty-12). */
  return new Map(forayResumeRows({ limit: Infinity, includeFinished: true }).map(p => [p.id, p]));
}

/** The band's inner width, for its bars' minimum-width arithmetic only: the
    viewport less the 16px gutters, the card's 16px padding and the well's own. */
function yoursForayBandWidth() {
  const vw = Math.max(280, Math.min(Number(window.innerWidth) || 393, 680));
  return vw - 2 * 16 - 2 * 16 - 2 * 6;
}

function yoursForayCardHtml(f, place) {
  const r = resolveListedForay(f.id);
  const hero = r && Array.isArray(r.playable) && r.playable.length ? todayHeroModel({ foray: f, r }) : null;
  const title = f.title || f.id;
  const part = place && !place.finished && Number(place.percent) > 0 ? Math.min(1, Number(place.percent) / 100) : 0;
  const readout = joinMeta(f.status !== "published" ? "draft" : "", hero ? hero.facts : "", place ? place.label : "");
  const band = hero
    ? `<div class="well yours-foray__band">${tactileBand({ kind: "mini", segments: hero.segments, renderWidth: yoursForayBandWidth(), label: hero.bandLabel, progress: part })}</div>`
    : "";
  const key = hero
    ? tactileKeycap({ size: "sm", variant: "persimmon", round: true, icon: "ph-play-fill", label: `${part ? "Resume" : "Play"} ${title}`, data: { "home-play": f.id } })
    : "";
  return `<article class="card yours-foray${part ? " is-part" : ""}">
    <h3 class="yours-foray__title"><a class="yours-foray__link" href="${esc(safeUrl("#" + forayRoutePath(f.id)))}"><span class="yours-foray__text">${esc(title)}</span></a></h3>
    ${band}
    <div class="yours-foray__foot"><span class="readout yours-foray__readout">${esc(readout)}</span>${key}</div>
  </article>`;
}

function libraryForaysHtml() {
  /* The player module lists Forays; until it has loaded, the count is unknown,
     and an unknown count is not zero — offer the way in, claim nothing. */
  /* This used to be an "All forays" row into `#/forays`; that page is now this
     panel (YOURS_LEGACY_ROUTES), so a row into it would link to itself. The page
     repaints when the player module lands (renderLibrary, last lines). */
  if (!state.forays || !window.ForayPlayer) return `<p class="note">Forays haven’t loaded yet. They show up here once they do.</p>`;
  const list = forayCards();
  if (!list.length) return `<p class="note">No forays to show yet.</p>`;
  const progress = yoursForayProgress();
  return `<div class="yours-forays">${list.map(f => yoursForayCardHtml(f, progress.get(f.id))).join("")}</div>`;
}

/* THE SHOWS PANEL (tactile `library-shows`, BUILD-PLAN 2.14, BUILD-NOTES 4.5).
   Every followed show, newest follow first, as a three-column grid of art tiles
   (the prototype's `.agrid`: 12 apart, `--r-sm`, the name 13/600 on two lines
   below). It was a five-row summary that ended in "All N followed shows" and
   linked to #/starred-shows; the grid IS the whole list, so that link is gone
   (the route still resolves, and "Yours lists every followed show" is true).

   RULING THAT FELL: "Yours' Shows is a capped summary that opens
   #/starred-shows" (test/starred-shows.test.js, the Shows-page section).

   EACH TILE is a link to the show, with one thing laid over its artwork that is
   not part of the link: the ⋯ (a real 44px button whose drawn mark is a small
   quiet chip; the artwork is otherwise bare, as in the prototype). There is no
   "Following" tag: every tile in this panel is followed by definition, so the
   tag said nothing and cost a third of each face (iteration 2). ⋯ - or a long press,
   or the context menu - reveals the tile's one action, Unfollow, as a real
   button over the artwork (`hidden` until asked for, so it is out of the
   accessibility tree when closed). Opening moves focus to Unfollow; Escape,
   ⋯ again, or another tile's ⋯ closes it, and focus goes back to the ⋯. One
   tile is open at a time. Unfollow writes through `toggleShowStar` (the same
   writer the Follow button on a show page uses, and the same event) and the
   page is NOT re-rendered: the tile leaves, the readout and the Shows count
   tick down, focus goes to the next tile's ⋯. */
const YOURS_LONG_PRESS_MS = 500;

/** Followed shows, newest follow first, each resolved to what a tile needs. The
    stored entry is a SNAPSHOT from the moment of the tap: its title and artwork
    may be missing, so both fall back through the live show record. */
function yoursFollowedShows() {
  return Object.entries(starredShowsMap())
    .map(([key, raw]) => {
      const entry = raw && typeof raw === "object" ? raw : {};
      const id = typeof entry.show_id === "string" && entry.show_id ? entry.show_id : key;
      const live = showById(id);
      return {
        id,
        title: String(entry.title || (live && live.title) || "Show"),
        art: entry.artwork_url || showArtworkUrl(live) || "",
        at: String(entry.starred_at || ""),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The note a Shows panel with nothing in it says (also what Unfollow leaves
    behind when other panels still have things in them). */
const YOURS_NO_SHOWS_NOTE = "No followed shows yet — follow a show from its page to keep it here.";

function yoursShowTileHtml(s) {
  const name = tactileDisplayName(s.title);
  const img = s.art
    ? `<img src="${esc(safeUrl(artUrl(s.art, 324)))}" alt="" loading="lazy" decoding="async" width="108" height="108" referrerpolicy="no-referrer">`
    : "";
  const station = tactileStationCode(name);
  return `<li class="shows-tile" data-show-tile="${esc(s.id)}">`
    + `<a class="shows-tile__link" href="${esc(safeUrl("#/show/" + encodeURIComponent(s.id)))}" title="${esc(s.title)}">`
    + `<span class="find-art find-art--tile find-art--c${tactileHash(s.id)}" data-i="${esc(station)}">${img}</span>`
    + `<span class="shows-tile__name">${esc(name)}</span></a>`
    + `<div class="shows-tile__layer">`
    + `<button type="button" class="iconbtn shows-tile__more" data-action="${esc(yoursActionKey("show-more", s.id))}" aria-expanded="false" aria-controls="shows-actions-${esc(s.id)}" aria-label="${esc(`More for ${name}`)}">${tactileIcon("ph-dots-three")}</button>`
    + `<div class="shows-tile__actions" id="shows-actions-${esc(s.id)}" role="group" aria-label="${esc(`${name}, followed`)}" hidden>`
    + tactileKeycap({ size: "sm", variant: "paper", text: "Unfollow", label: `Unfollow ${name}`, action: yoursActionKey("unfollow", s.id) })
    + `</div></div></li>`;
}

function yoursShowsHtml() {
  const shows = yoursFollowedShows();
  if (!shows.length) return `<p class="note">${esc(YOURS_NO_SHOWS_NOTE)}</p>`;
  return `<ul class="shows-grid" id="yours-shows">${shows.map(yoursShowTileHtml).join("")}</ul>`;
}

/** The ⋯ of a tile and the group it controls, found from either one. */
function yoursShowParts(tile) {
  if (!tile || typeof tile.querySelector !== "function") return null;
  const more = tile.querySelector(".shows-tile__more");
  const actions = tile.querySelector(".shows-tile__actions");
  const link = tile.querySelector(".shows-tile__link");
  return more && actions && link ? { more, actions, link } : null;
}

/** Close whichever tile is open. `restoreFocus` puts focus back on its ⋯ (an
    Escape, or the ⋯ itself, as opposed to a press somewhere else). */
function yoursCloseShowActions({ restoreFocus = false } = {}) {
  const panel = $("#yours-panel-shows");
  if (!panel || typeof panel.querySelectorAll !== "function") return;
  if (typeof panel._clearSwallow === "function") panel._clearSwallow();
  [...panel.querySelectorAll(".shows-tile.is-open")].forEach((tile) => {
    const parts = yoursShowParts(tile);
    tile.classList.remove("is-open");
    if (!parts) return;
    parts.actions.hidden = true;
    parts.link.removeAttribute("inert");
    parts.more.setAttribute("aria-expanded", "false");
    if (restoreFocus) focusQuietly(parts.more);
  });
}

function yoursOpenShowActions(tile) {
  const parts = yoursShowParts(tile);
  if (!parts) return;
  yoursCloseShowActions();
  tile.classList.add("is-open");
  parts.actions.hidden = false;
  /* The group covers the artwork, and the link under it is covered: out of the
     tab order and the accessibility tree while it is, back when it closes. */
  parts.link.setAttribute("inert", "");
  parts.more.setAttribute("aria-expanded", "true");
  focusQuietly(parts.actions.querySelector("button"));
}

function yoursToggleShowActions(tile) {
  if (tile && tile.classList && tile.classList.contains("is-open")) yoursCloseShowActions({ restoreFocus: true });
  else yoursOpenShowActions(tile);
}

/** Unfollow: write it, take the tile out, say so, tick the counts. */
function yoursUnfollow(id) {
  const panel = $("#yours-panel-shows");
  if (!panel || typeof panel.querySelectorAll !== "function") return;
  const tiles = [...panel.querySelectorAll(".shows-tile")];
  const tile = tiles.find((t) => t.getAttribute("data-show-tile") === id);
  if (!tile || !isShowStarred(id)) return;
  const name = (tile.querySelector(".shows-tile__name") || {}).textContent || "the show";
  const at = tiles.indexOf(tile);
  toggleShowStar(id);
  if (typeof tile.remove === "function") tile.remove();
  const left = Object.keys(starredShowsMap()).length;
  yoursReadouts.shows = yoursReadoutText("shows", { shows: left });
  if (!panel.hidden) setStatusText($("#yours-readout"), yoursReadouts.shows);
  announce(`Unfollowed ${name}. ${countLabel(left, "show")} followed.`);
  if (!left) {
    /* Nothing followed and nothing anywhere else: the whole-screen empty state,
       the same screen a fresh visit to the same data draws. Otherwise this
       panel says it has nothing, and the chip strip stays. */
    if (yoursNothingYet(queueIds().length)) {
      renderLibrary();
      focusQuietly($("#view h2"));
      return;
    }
    panel.innerHTML = `<p class="note">${esc(YOURS_NO_SHOWS_NOTE)}</p>`;
    focusQuietly($("#yours-chips [aria-selected=\"true\"]") || $("#view h2"));
    return;
  }
  const rest = [...panel.querySelectorAll(".shows-tile__more")];
  focusQuietly(rest[Math.min(at, rest.length - 1)]);
}

/** One delegated listener set on the panel: ⋯, Unfollow, Escape, and the long
    press on a tile's link (which opens the same group and then swallows the
    click the release would otherwise make, so a long press never also opens
    the show). */
function bindYoursShows(panel) {
  if (!panel || panel._showsBound) return;
  panel._showsBound = true;
  const tileOf = (node) => (node && typeof node.closest === "function" ? node.closest(".shows-tile") : null);
  /* Set by the long press, used up by the click its release makes. A release
     that makes no click (the finger slid off, the browser sent a contextmenu
     instead) would leave it set, so the next gesture (pointerdown), any key and
     the group closing all clear it: the next ordinary tap always opens the show. */
  let swallowClick = false;
  panel._clearSwallow = () => { swallowClick = false; };
  panel.addEventListener("click", (e) => {
    /* The click a long press ends with. The group opened under the finger and
       covers the artwork (the link is inert), so the browser sends that click to
       the nearest ancestor of where the press began and where it ended: the
       tile, never the link. It is swallowed wherever it lands, once. */
    if (swallowClick) {
      swallowClick = false;
      if (typeof e.preventDefault === "function") e.preventDefault();
      return;
    }
    const hit = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-action]") : null;
    if (!hit || hit.disabled) return;
    const raw = hit.getAttribute("data-action") || "";
    const at = raw.indexOf(":");
    const verb = at < 0 ? raw : raw.slice(0, at);
    const id = at < 0 ? "" : raw.slice(at + 1);
    if (verb === "show-more") { if (typeof e.preventDefault === "function") e.preventDefault(); yoursToggleShowActions(tileOf(hit)); }
    else if (verb === "unfollow") { if (typeof e.preventDefault === "function") e.preventDefault(); yoursUnfollow(id); }
  });
  panel.addEventListener("keydown", (e) => {
    swallowClick = false;
    if (e.key === "Escape" && panel.querySelector(".shows-tile.is-open")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      yoursCloseShowActions({ restoreFocus: true });
    }
  });
  let press = null;
  const stopPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  panel.addEventListener("pointerdown", (e) => {
    const link = e.target && typeof e.target.closest === "function" ? e.target.closest(".shows-tile__link") : null;
    stopPress();
    swallowClick = false;
    if (!link) return;
    press = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        yoursOpenShowActions(tileOf(link));   // closes any open group, which clears the flag: set it after
        swallowClick = true;
      }, YOURS_LONG_PRESS_MS),
    };
  });
  panel.addEventListener("pointermove", (e) => {
    if (press && Math.abs((e.clientX || 0) - (press.x || 0)) + Math.abs((e.clientY || 0) - (press.y || 0)) > 10) stopPress();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => panel.addEventListener(type, stopPress));
  /* The context menu is the long press on a pointer that has one. */
  panel.addEventListener("contextmenu", (e) => {
    const link = e.target && typeof e.target.closest === "function" ? e.target.closest(".shows-tile__link") : null;
    if (!link) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    stopPress();
    yoursOpenShowActions(tileOf(link));
  });
}

/* ---------- YOURS (TACTILE): the Library as a chip strip over one list ----------

   Redesign 2026, tactile `library` (docs/redesign-2026/directions/tactile/
   BUILD-PLAN.md 2.12, BUILD-NOTES 4.5). "Yours" is the third tab; this page was
   "Library", one scroll of seven stacked sections. It is now a display-xl
   title over a readout line, a chip strip (Forays, Shows, Saved, Playlists, Up
   Next, History) and ONE panel at a time.

   RULING THAT FELL: "Library is one aggregate scroll of sections" (the header
   above, and test/library-screen.test.js). Up Next used to be a single summary
   row that linked out to #/queue; it is now the page's own list, so the thing
   the listener most often reorders is on the screen they land on.

   EVERY PANEL IS IN THE DOCUMENT, ONLY ONE IS SHOWN. A chip press hides and
   shows panels (the `hidden` attribute); it never re-renders them, so a scroll
   position, a half-read Saved list and an open action row survive a trip to
   another chip and back, and a press costs no network and no layout of the
   other panels. The hidden ones are out of the accessibility tree and their
   lazy images never load.

   THE CHIP IS MEMORY, NOT STORAGE (`state.yoursChip`). A new `cp_` key would
   have to be named in the privacy policy and counted in the data-deletion
   screen for a convenience that is cheap to lose on a reload; the page opens on
   Up Next when something is queued and on Forays otherwise.

   DOWNLOADS is a seventh chip only where the native shell's download bridge
   exists (it was a Library section for the same reason). It sits before
   History; the six the prototype draws are the six everyone else gets.

   UP NEXT IS `cp_queue`, nothing more. The playing episode is a row only when
   it is in the list, which it is whenever it was played from Up Next (the played
   row jumps to the top, `playedFromUpNext`); an episode started from Today is
   not queued and so is not drawn here, the same as the badge on the tab, which
   counts the list. `#/queue` stays as the standalone page (drag, swipe, Play
   next) the Now Playing sheet and the drawer still link to; this panel is the
   Tactile list and writes through the same `saveQueueIds`. */
const YOURS_UNDO_MS = 4000;

function yoursChipDefs() {
  const defs = [
    { key: "forays", label: "Forays" },
    { key: "shows", label: "Shows" },
    { key: "saved", label: "Saved" },
    { key: "playlists", label: "Playlists" },
    { key: "upnext", label: "Up Next" },
  ];
  if (state.downloadBridge) defs.push({ key: "downloads", label: "Downloads" });
  defs.push({ key: "history", label: "History" });
  return defs;
}

/** The chip shown now: the listener's last choice this session when it still
    exists, else Up Next with something queued, else Forays. (The first-run
    screen has no strip at all, so it never asks.) */
function yoursActiveKey(queued) {
  const keys = yoursChipDefs().map((c) => c.key);
  if (state.yoursChip && keys.includes(state.yoursChip)) return state.yoursChip;
  return queued > 0 ? "upnext" : "forays";
}

/** The readout line under the title for the chip on screen: the Up Next one is
    "5 queued · 4 hr 55 min" (the full lengths, so it holds still while an
    episode plays), the others are the count the panel lists. A count that is
    not known yet (the Forays list before the player has loaded) says nothing
    about the number. */
function yoursReadoutText(key, d) {
  switch (key) {
    case "upnext": return joinMeta(`${d.queued} queued`, d.queued ? fmtDur(d.minutes) : "");
    case "forays": return d.forays == null ? "Forays" : countLabel(d.forays, "foray");
    case "shows": return countLabel(d.shows, "show");
    case "saved": return countLabel(d.saved, "saved episode");
    case "playlists": return countLabel(d.playlists, "playlist");
    case "downloads": return "Downloads";
    default: return `${countLabel(d.history, "episode")} played`;
  }
}

/** The tabpanel a chip controls is its own panel. */
function yoursChipsHtml(active, queued) {
  return yoursChipDefs().map((c) => {
    const on = c.key === active;
    const badge = c.key === "upnext" && queued > 0 ? `<span class="chip__count readout">${esc(queued)}</span>` : "";
    const name = badge ? ` aria-label="${esc(`Up Next, ${queued} queued`)}"` : "";
    return `<button type="button" class="chip" role="tab" id="yours-chip-${esc(c.key)}" data-yours-chip="${esc(c.key)}" aria-selected="${on ? "true" : "false"}" aria-controls="yours-panel-${esc(c.key)}" tabindex="${on ? "0" : "-1"}"${name}>${on ? tactileIcon("ph-check", "sm") : ""}<span>${esc(c.label)}</span>${badge}</button>`;
  }).join("");
}

/** First run: nothing queued, followed, saved, played, built, downloaded or
    part-played. ONE `.empty` for the whole screen (BUILD-NOTES 3.16, 4.5): the
    radio mark, a sentence, the Find key. It stands in for the six panels AND
    the chip strip (the prototype draws none here: a filter over nothing reads
    as an empty result, not an empty library, and an active "Up Next" chip
    would contradict the sentence), so there is no per-chip "nothing here" line
    to disagree with it, and it is a mark and a key, never a bare sentence. The
    readout line says it too, in the mono face the readouts share. The key opens Find, the tab the app
    draws as Find (`#/shows`; `#/search` is the prototype's name for it). */
const YOURS_EMPTY_COPY = "Nothing here yet. Follow a show or play today’s foray and it lands here.";
const YOURS_EMPTY_READOUT = "Nothing saved yet";

/** Whether Yours has nothing at all to show: the whole-screen empty state. One
    definition for the page's first paint and for the repaint after a queue
    write, so a removal that empties the queue ends on the same screen a fresh
    visit to the same data would draw. The saved, history and playlist counts
    are passed when the caller already has them. */
function yoursNothingYet(queued, savedCount, historyCount, playlistCount) {
  const followedNow = Object.keys(starredShowsMap()).length;
  const saved = savedCount == null ? rowsForIds(Object.keys(savedMap())).length : savedCount;
  const history = historyCount == null ? rowsForIds(pickedHistory().slice().reverse().slice(0, 20)).length : historyCount;
  const playlistsNow = playlistCount == null ? playlists().length : playlistCount;
  const downloadsNow = state.downloadBridge && Object.values(downloadsValue().items).some((rec) => rec.status === "done");
  const forayProgressNow = window.ForayPlayer && state.forays ? forayProgressLabels().size : 0;
  /* A listener who ASKED for the Forays chip (#/forays, the drawer's Forays, Home's
     draft notice, a Foray's back key) with published forays to list is not looking at
     an empty library: before Yours, #/forays listed every published foray to anyone. */
  const publishedForays = !state.forays ? 0
    : window.ForayPlayer ? forayCards().length
    : (Array.isArray(state.forays.forays) ? state.forays.forays.length : 0);   // before the player loads: the document's own count
  const forayAsked = state.yoursChip === "forays" && publishedForays > 0;
  return queued === 0 && followedNow === 0 && saved === 0 && history === 0 && playlistsNow === 0 && !downloadsNow && !forayProgressNow && !forayAsked;
}

function yoursEmptyPanelHtml() {
  return `<div class="yours-panel yours-panel--empty" id="yours-panel-empty">${tactileEmpty({ copy: YOURS_EMPTY_COPY, action: "Find a show", href: yoursFindHash() })}</div>`;
}

/** The Find tab's own route, read from the tab bar's definition so the two
    cannot drift apart. */
function yoursFindHash() {
  const tab = typeof TAB_ROUTES !== "undefined" && Array.isArray(TAB_ROUTES) ? TAB_ROUTES.find((t) => t.key === "search") : null;
  return tab && tab.hash ? tab.hash : "#/shows";
}

function yoursPanelHtml(key, active, inner) {
  return `<div class="yours-panel" role="tabpanel" id="yours-panel-${esc(key)}" aria-labelledby="yours-chip-${esc(key)}"${key === active ? "" : " hidden"}>${inner}</div>`;
}

/* ---------- the Up Next panel ---------- */

/** Station-coloured artwork with the show's two letters under it, the Find
    screen's own `.find-art` (enamel by the show's hash), so a queued row's
    cover is the same object everywhere. The image replaces the letters. */
function yoursArtHtml(item) {
  const name = tactileDisplayName(item.show || "");
  const img = item.artwork_url
    ? `<img src="${esc(safeUrl(artUrl(item.artwork_url, 144)))}" alt="" loading="lazy" decoding="async" width="48" height="48" referrerpolicy="no-referrer">`
    : "";
  return `<span class="find-art find-art--queue find-art--c${tactileHash(item.show_id || item.show || item.id)}" data-i="${esc(tactileStationCode(name))}">${img}</span>`;
}

/** "42 min left" for the playing row: the player's own progress label when it
    has one, else the whole length. */
function yoursLeftLabel(item) {
  const prog = rowProgress(item);
  if (prog && typeof prog.label === "string" && /left$/.test(prog.label)) return prog.label;
  const len = fmtDur(episodeMinutes(item));
  return len ? `${len} left` : "";
}

function yoursIsCurrent(id) {
  try { return !!window.ForayPlayer?.isCurrent?.(id); } catch (_) { return false; }
}

/** One data-action value: "verb:id". The verb never contains a colon, so the id
    is everything after the first one. */
function yoursActionKey(verb, id) { return `${verb}:${id}`; }

function yoursActionsHtml(r, idx, total, rows) {
  const { id, item } = r;
  const title = r.state === "unnamed" ? "this episode" : item.title;
  const cur = yoursIsCurrent(id);
  /* The playing row only offers Remove (the prototype's rule): its place is the
     top, and Move up on the row under it would put an episode ahead of the one
     that is playing. */
  const above = idx > 0 ? rows[idx - 1] : null;
  const upOff = idx === 0 || (above && yoursIsCurrent(above.id));
  const downOff = idx === total - 1;
  const keys = cur ? "" : tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-up", text: "Move up", label: `Move up: ${title}`, action: yoursActionKey("up", id), disabled: upOff })
    + tactileKeycap({ size: "sm", variant: "paper", icon: "ph-arrow-down", text: "Move down", label: `Move down: ${title}`, action: yoursActionKey("down", id), disabled: downOff });
  return `<div class="yours-qtools" id="yours-tools-${esc(idx)}" role="group" aria-label="${esc(`Actions for ${title}`)}">${keys}${tactileKeycap({ size: "sm", variant: "paper", icon: "ph-trash", text: "Remove", label: `Remove from Up Next: ${title}`, action: yoursActionKey("rm", id) })}</div>`;
}

function yoursQueueRowHtml(r, idx, total, rows, openId) {
  const { id, item, state: rowState } = r;
  const named = rowState !== "unnamed";
  const playable = rowState === "live";
  const cur = playable && yoursIsCurrent(id);
  const open = openId === id;
  const title = named ? (item.title || "Episode") : "Episode no longer available";
  const showName = named ? tactileDisplayName(item.show || "") : "";
  let metaHtml;
  let metaText;
  if (cur) {
    const left = yoursLeftLabel(item);
    metaText = joinMeta("Playing", left);
    metaHtml = `<span class="tag tag--playing">${tactileIcon("needle", "sm")}<span>Playing</span></span>${left ? `<span class="readout">· ${esc(left)}</span>` : ""}`;
  } else if (playable) {
    const prog = rowProgress(item);
    const rest = prog && prog.label ? prog.label : fmtDur(episodeMinutes(item));
    metaText = joinMeta(showName, rest);
    metaHtml = `<span class="row__show">${esc(showName)}</span>${rest ? `<span class="readout">${esc(rest)}</span>` : ""}`;
  } else if (named) {
    metaText = joinMeta(showName, "not available right now");
    metaHtml = `<span class="row__show">${esc(showName)}</span><span>not available right now</span>`;
  } else {
    metaText = "4a no longer has this episode's details";
    metaHtml = `<span>${esc(metaText)}</span>`;
  }
  const position = cur ? tactileIcon("needle", "sm") : esc(idx + 1);
  const inner = `${yoursArtHtml(named ? item : { id })}<span class="row__body"><span class="row__title">${esc(title)}</span><span class="row__meta">${metaHtml}</span></span>`;
  const main = playable
    ? `<button type="button" class="row-queue__main" data-action="${esc(yoursActionKey("play", id))}" aria-label="${esc(cur ? `Pause or resume: ${title}, ${metaText}` : `Play ${title}, ${metaText}`)}">${inner}</button>`
    : `<div class="row-queue__main">${inner}</div>`;
  return `<li class="yours-qwrap" data-queue-id="${esc(id)}">
    <article class="row-queue${cur ? " is-current" : ""}"${cur ? ' aria-current="true"' : ""}>
      <span class="row-queue__position readout">${position}</span>
      ${main}
      <button type="button" class="iconbtn" data-action="${esc(yoursActionKey("more", id))}" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(`More for ${title}`)}"${open ? ` aria-controls="yours-tools-${esc(idx)}"` : ""}>${tactileIcon("ph-dots-three")}</button>
    </article>${open ? yoursActionsHtml(r, idx, total, rows) : ""}
  </li>`;
}

function yoursQueueInner(rows) {
  if (!rows.length) return `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`;
  const openId = rows.some((r) => r.id === state.yoursOpenRow) ? state.yoursOpenRow : null;
  const clearable = rows.filter((r) => !yoursIsCurrent(r.id)).length;
  const head = `<div class="yours-qhead"><span class="label yours-qlabel">Plays in this order</span>${clearable ? tactileKeycap({ size: "sm", variant: "paper", text: "Clear", label: "Clear Up Next", action: "clear" }) : ""}</div>`;
  return `${head}<ol class="yours-queue" aria-label="Up Next">${rows.map((r, i) => yoursQueueRowHtml(r, i, rows.length, rows, openId)).join("")}</ol>`;
}

/** The sum of the queued episodes' lengths, in minutes. */
function yoursQueueMinutes(rows) {
  return rows.reduce((sum, r) => sum + (r.state === "unnamed" ? 0 : episodeMinutes(r.item)), 0);
}

/* ---------- repaint: the page is a live view of cp_queue ---------- */

let yoursReadouts = {};

/** The strip and the readout, after anything that changes the badge or the Up
    Next numbers. The strip is rebuilt (the check icon and the badge are
    markup); its listeners are delegated on the strip, so nothing is rebound. */
function paintYoursChrome(rows) {
  const queued = rows.length;
  yoursReadouts.upnext = yoursReadoutText("upnext", { queued, minutes: yoursQueueMinutes(rows) });
  const active = yoursActiveKey(queued);
  const strip = $("#yours-chips");
  if (strip) {
    const had = document.activeElement && typeof document.activeElement.getAttribute === "function"
      ? document.activeElement.getAttribute("data-yours-chip") : null;
    strip.innerHTML = yoursChipsHtml(active, queued);
    if (had) focusQuietly(strip.querySelector(`[data-yours-chip="${had}"]`));
  }
  const readout = $("#yours-readout");
  setStatusText(readout, yoursReadouts[active] || "");
}

function yoursRowTops(panel) {
  const tops = new Map();
  if (!panel || typeof panel.querySelectorAll !== "function") return tops;
  panel.querySelectorAll(".yours-qwrap").forEach((el) => {
    const box = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (box && Number.isFinite(box.top)) tops.set(el.dataset.queueId, box.top);
  });
  return tops;
}

/** FLIP. Rows that kept their id are put back where they were with a
    translateY, then released to their new place on `--spring-settle`. Only
    `transform` moves: a removal closes the gap by sliding the rows under it up,
    never by animating a height. The class that carries the transition is added
    after the first write has been flushed, so the jump to the old place does
    not itself animate. A row that was not there before (an undone removal)
    simply appears. */
function yoursFlip(panel, from) {
  if (!from || !from.size || !panel || typeof panel.querySelectorAll !== "function") return;
  const moved = [];
  panel.querySelectorAll(".yours-qwrap").forEach((el) => {
    const was = from.get(el.dataset.queueId);
    if (was == null || typeof el.getBoundingClientRect !== "function" || !el.style) return;
    const dy = was - el.getBoundingClientRect().top;
    if (!dy) return;
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  });
  if (!moved.length) return;
  if (typeof reflow === "function") reflow(moved[0]);
  const release = () => moved.forEach((el) => {
    el.classList.add("is-flipping");
    el.style.transform = "";
    const done = () => el.classList.remove("is-flipping");
    if (typeof el.addEventListener === "function") el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400);
  });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(release); else release();
}

/** Which control had focus, by its data-action, so a repaint that replaced it
    can put focus back on the same control for the same episode. */
function yoursFocusBefore(panel) {
  const active = document.activeElement;
  if (!active || typeof active.getAttribute !== "function" || !panel || typeof panel.contains !== "function" || !panel.contains(active)) return null;
  const key = active.getAttribute("data-action");
  if (!key) return null;
  const all = typeof panel.querySelectorAll === "function" ? [...panel.querySelectorAll("[data-action]")] : [];
  const li = typeof active.closest === "function" ? active.closest(".yours-qwrap") : null;
  const lis = typeof panel.querySelectorAll === "function" ? [...panel.querySelectorAll(".yours-qwrap")] : [];
  return { key, index: Math.max(0, all.indexOf(active)), row: Math.max(0, lis.indexOf(li)) };
}

function yoursFocusAfter(panel, held) {
  if (!held || !panel || typeof panel.querySelectorAll !== "function") return;
  const all = [...panel.querySelectorAll("[data-action]")];
  let target = all.find((b) => b.getAttribute("data-action") === held.key);
  /* Move up on the row that has just reached the top is disabled: the other
     arrow of the same episode is where the finger was. */
  if (!target || target.disabled) {
    const at = held.key.indexOf(":");
    const verb = held.key.slice(0, at);
    const id = held.key.slice(at + 1);
    const sibling = verb === "up" ? "down" : verb === "down" ? "up" : "more";
    target = all.find((b) => b.getAttribute("data-action") === yoursActionKey(sibling, id) && !b.disabled);
  }
  /* The row itself left (Remove): the ⋯ of the row that took its place, or the
     one above it when that was the last row. */
  if (!target) {
    const mores = all.filter((b) => (b.getAttribute("data-action") || "").startsWith("more:"));
    target = mores[Math.min(held.row, mores.length - 1)] || null;
  }
  if (!target) target = $("#view h2");
  focusQuietly(target);
}

/** Repaint the Up Next panel in place. Called by `repaintQueuePage` (app.js)
    after every write to cp_queue and every playback move while #/library is the
    page. Returns whether there was a panel to paint. */
function repaintYoursQueue() {
  /* The whole-screen empty state has no Up Next panel. The first thing queued
     (from the Now Playing sheet, say) ends it: paint the page again, with the
     listener's chip kept. */
  if ($("#yours-panel-empty")) {
    if (queueRows().length) renderLibrary();
    return true;
  }
  const panel = $("#yours-panel-upnext");
  if (!panel) return false;
  const rows = queueRows();
  /* The reverse of the above: the last queued episode left and nothing else is
     saved, followed, played or built. A page with six panels and a chip strip
     over nothing is not what a visit to the same data draws, so paint it again
     and it becomes the whole-screen empty state. Any one thing elsewhere keeps
     the panels, with Up Next's own note. */
  if (!rows.length && yoursNothingYet(0)) {
    const heldFocus = yoursFocusBefore(panel);
    state.yoursOpenRow = null;
    renderLibrary();
    /* The control that had focus left with the panel; the heading is where
       focus goes when its row is gone (yoursFocusAfter's last resort). */
    if (heldFocus) focusQuietly($("#view h2"));
    return true;
  }
  const held = yoursFocusBefore(panel);
  const from = yoursRowTops(panel);
  if (state.yoursOpenRow && !rows.some((r) => r.id === state.yoursOpenRow)) state.yoursOpenRow = null;
  panel.innerHTML = yoursQueueInner(rows);
  yoursFlip(panel, from);
  paintYoursChrome(rows);
  yoursFocusAfter(panel, held);
  return true;
}

/* ---------- actions ---------- */

async function yoursPlay(id) {
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !window.ForayPlayer) return;
  /* The same rule as every row's play: a row showing the player's own item
     pauses or resumes it, anything else starts, and `UP_NEXT_CTX` is what moves
     the pressed row to the top. */
  if (window.ForayPlayer.isCurrent?.(id)) {
    await window.ForayPlayer.togglePlayback();
    return;
  }
  await startEpisodePlay(id, item, { ctx: UP_NEXT_CTX, list: [] });
}

/** ⋯ opens the 48px action row under its own row, or closes it. One row is
    open at a time. It goes through the same repaint as a queue write, so the
    rows below slide down by FLIP on `--spring-settle` (the gap opening) and
    the pressed ⋯ keeps focus. */
function yoursToggleActions(id) {
  state.yoursOpenRow = state.yoursOpenRow === id ? null : id;
  repaintYoursQueue();
}

function yoursMove(id, dir) {
  moveQueueItem(id, dir);
  const ids = queueIds();
  const pos = ids.indexOf(id) + 1;
  if (pos > 0) announce(`Moved to position ${pos} of ${ids.length}.`);
}

/** Remove, with four seconds to take it back. The removal is written at once
    (the list, the badge and the readout tick down together); Undo writes the
    id back at the place it left. */
function yoursRemove(id) {
  const ids = queueIds();
  const index = ids.indexOf(id);
  if (index < 0) return;
  removeFromQueue(id);
  showYoursUndo({ id, index });
  announce(ids.length > 1 ? "Removed from Up Next. Undo is available for four seconds." : "Removed from Up Next. Up Next is empty. Undo is available for four seconds.");
}

let yoursUndo = null;

function yoursToastHost() {
  let host = $("#yours-toast");
  if (host) return host;
  host = document.createElement("div");
  host.id = "yours-toast";
  host.className = "deck-toast yours-toast";
  host.innerHTML = tactileToast({ text: "Removed from Up Next", action: "Undo" });
  document.body.appendChild(host);
  const toast = host.querySelector(".toast");
  const undo = host.querySelector(".textbtn");
  if (undo) undo.addEventListener("click", () => undoYoursRemove());
  /* Held while touched or focused: the clock stops on a press (or when focus
     lands on Undo, so a keyboard or switch user is not raced) and runs again,
     with what was left of it, on release (or when focus leaves). */
  if (toast) {
    toast.addEventListener("pointerdown", () => pauseYoursUndo());
    toast.addEventListener("pointerup", () => resumeYoursUndo());
    toast.addEventListener("pointercancel", () => resumeYoursUndo());
    toast.addEventListener("focusin", () => pauseYoursUndo());
    toast.addEventListener("focusout", () => resumeYoursUndo());
  }
  return host;
}

function showYoursUndo(entry) {
  if (yoursUndo) clearTimeout(yoursUndo.timer);
  const host = yoursToastHost();
  yoursUndo = { ...entry, left: YOURS_UNDO_MS, started: Date.now(), timer: null };
  tactileSetToast(host.querySelector(".toast"), true);
  yoursUndo.timer = setTimeout(hideYoursUndo, YOURS_UNDO_MS);
}

function pauseYoursUndo() {
  if (!yoursUndo || yoursUndo.timer == null) return;
  clearTimeout(yoursUndo.timer);
  yoursUndo.timer = null;
  yoursUndo.left = Math.max(0, yoursUndo.left - (Date.now() - yoursUndo.started));
}

function resumeYoursUndo() {
  if (!yoursUndo || yoursUndo.timer != null) return;
  yoursUndo.started = Date.now();
  yoursUndo.timer = setTimeout(hideYoursUndo, yoursUndo.left);
}

function hideYoursUndo() {
  if (yoursUndo) clearTimeout(yoursUndo.timer);
  yoursUndo = null;
  const host = $("#yours-toast");
  if (host) tactileSetToast(host.querySelector(".toast"), false);
}

function undoYoursRemove() {
  const entry = yoursUndo;
  if (!entry) return false;
  hideYoursUndo();
  const ids = queueIds();
  if (ids.includes(entry.id)) return false;
  ids.splice(Math.min(entry.index, ids.length), 0, entry.id);
  saveQueueIds(ids);
  /* After the id is back in the list, so the snapshot prune keeps it. */
  rememberEpisode(entry.id);
  logEvent("queued", { episode_id: entry.id });
  announce("Put back in Up Next.");
  const panel = $("#yours-panel-upnext");
  focusQuietly(panel && panel.querySelector(`[data-action="${yoursActionKey("more", entry.id)}"]`));
  return true;
}

/** Clear is asked first: a sheet with the count, "Clear" and "Keep". It is the
    app's own modal (focus moves in, Tab stays in, Escape and the scrim close
    it, focus goes back to the key that opened it), dressed as the Tactile
    sheet. What is playing stays, as `clearQueue` has always done. */
function openYoursClearSheet() {
  if ($("#yours-clear-sheet")) return;
  const playing = currentPlayingId();
  const rows = queueRows();
  const n = rows.filter((r) => r.id !== playing).length;
  if (!n) return;
  const keeps = rows.some((r) => r.id === playing) ? " What is playing stays." : "";
  const holder = document.createElement("div");
  holder.innerHTML = `<div class="yours-scrim" id="yours-clear-scrim"></div>${tactileSheet({
    id: "yours-clear-sheet", closeId: "yours-clear-close", title: "Clear Up Next?",
    copy: `This removes ${countLabel(n, "episode")} from Up Next.${keeps}`, primary: "Clear", secondary: "Keep",
  })}`;
  const scrim = holder.firstElementChild;
  const sheet = holder.lastElementChild;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  const opener = document.activeElement;
  const shut = () => {
    closeSheet(sheet, { removeIfOwned: true });
    if (scrim.remove) scrim.remove();
    if (!document.activeElement || document.activeElement === document.body) {
      focusQuietly($("#yours-panel-upnext [data-action=\"clear\"]") || (opener && opener.isConnected !== false ? opener : null) || $("#view h2"));
    }
  };
  openSheet(sheet, { onRequestClose: shut, keepReachable: ["#yours-clear-scrim"], returnFocus: opener && opener.isConnected !== false ? opener : null });
  const primary = sheet.querySelector(".keycap");
  const secondary = sheet.querySelector(".sheet__actions .textbtn");
  const close = sheet.querySelector(".sheet__close");
  scrim.addEventListener("click", shut);
  if (close) close.addEventListener("click", shut);
  if (secondary) secondary.addEventListener("click", shut);
  if (primary) {
    primary.addEventListener("click", () => {
      const removed = clearQueue();
      shut();
      announce(removed === 1 ? "Removed 1 episode from Up Next." : `Removed ${removed} episodes from Up Next.`);
      focusQuietly($("#view h2"));
    });
  }
}

function onYoursQueueClick(e) {
  const hit = e && e.target && typeof e.target.closest === "function" ? e.target.closest("[data-action]") : null;
  if (!hit || hit.disabled) return;
  const raw = hit.getAttribute("data-action") || "";
  const at = raw.indexOf(":");
  const verb = at < 0 ? raw : raw.slice(0, at);
  const id = at < 0 ? "" : raw.slice(at + 1);
  if (typeof e.preventDefault === "function") e.preventDefault();
  if (verb === "play") yoursPlay(id);
  else if (verb === "more") yoursToggleActions(id);
  else if (verb === "up") yoursMove(id, -1);
  else if (verb === "down") yoursMove(id, 1);
  else if (verb === "rm") yoursRemove(id);
  else if (verb === "clear") openYoursClearSheet();
}

/* ---------- chips ---------- */

/** The chosen chip, wholly in view, the strip snapped to a chip edge. A strip
    wider than the screen opens at its left end, and "Up Next", the chip the page
    opens on, is the fifth of six. The strip is scrolled from its left end just
    far enough to bring the chosen chip inside the right gutter, then on until
    the chip the left edge has cut is gone and the one after it starts at the
    gutter (the fade would show the cut chip as a sliver). What is left over on
    the right is the chips that do not fit; the last of them runs into the right
    fade, so the strip says it goes on. The prototype's fitChip, ported, with
    its single step made a snap to the next chip. Nothing to do where the strip
    does not scroll. */
function fitYoursChip(strip) {
  if (!strip || typeof strip.querySelector !== "function") return;
  const chip = strip.querySelector('[aria-selected="true"]');
  if (!chip || !(strip.clientWidth > 0)) return;
  const gutter = 16;
  strip.scrollLeft = 0;
  const edge = strip.getBoundingClientRect();
  const sel = chip.getBoundingClientRect();
  if (sel.right > edge.right - gutter) strip.scrollLeft += sel.right - (edge.right - gutter);
  const chips = Array.from(strip.querySelectorAll(".chip"));
  for (let i = 0; i < chips.length; i++) {
    const box = chips[i].getBoundingClientRect();
    if (box.left < edge.left + gutter - 1 && box.right > edge.left) {
      const next = chips[i + 1] && chips[i + 1] !== chip ? chips[i + 1].getBoundingClientRect() : null;
      strip.scrollLeft += next ? next.left - edge.left - gutter : box.right - edge.left + 2;
    }
  }
}

/** Show one panel. No render: hide the others, move the check and the roving
    tabindex, say the new count. */
function selectYoursChip(key, { focus = false } = {}) {
  const keys = yoursChipDefs().map((c) => c.key);
  if (!keys.includes(key)) return;
  /* An open Unfollow does not wait behind a chip: it would be open again on the way back. */
  yoursCloseShowActions();
  state.yoursChip = key;
  const panels = typeof $("#view").querySelectorAll === "function" ? [...$("#view").querySelectorAll(".yours-panel")] : [];
  panels.forEach((p) => { p.hidden = p.id !== `yours-panel-${key}`; });
  const queued = queueIds().length;
  const strip = $("#yours-chips");
  if (strip) strip.innerHTML = yoursChipsHtml(key, queued);
  const readout = $("#yours-readout");
  setStatusText(readout, yoursReadouts[key] || "");
  const chip = strip && strip.querySelector(`[data-yours-chip="${key}"]`);
  if (chip) {
    if (focus) focusQuietly(chip);
    fitYoursChip(strip);
  }
}

function bindYoursChips(strip) {
  if (!strip || strip._bound) return;
  strip._bound = true;
  strip.addEventListener("click", (e) => {
    const hit = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-yours-chip]") : null;
    if (hit) selectYoursChip(hit.getAttribute("data-yours-chip"), { focus: true });
  });
  /* The tab pattern: the arrows, Home and End move between chips and choose
     as they go; only the chosen one is in the Tab order. */
  strip.addEventListener("keydown", (e) => {
    const keys = yoursChipDefs().map((c) => c.key);
    const hit = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-yours-chip]") : null;
    if (!hit) return;
    const at = keys.indexOf(hit.getAttribute("data-yours-chip"));
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % keys.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + keys.length) % keys.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = keys.length - 1;
    if (to < 0) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    selectYoursChip(keys[to], { focus: true });
  });
}

/** The knob opens the Settings sheet (ui/settings.js), whose "More settings"
    hands over to the drawer, which the topbar's ☰ would open and this page
    hides. The drawer hands focus back to the ☰ when it closes, and a hidden ☰
    cannot take it, so the knob takes it (the watcher below). */
function bindYoursKnob(knob) {
  if (!knob || knob._bound) return;
  knob._bound = true;
  knob.setAttribute("aria-controls", "settings-sheet");
  knob.setAttribute("aria-expanded", "false");
  knob.addEventListener("click", () => openSettingsSheet(knob));
  /* One watcher at a time: the page is painted again for many reasons, and each
     paint makes a new knob. The old watcher is let go with the old knob. */
  const drawer = $("#drawer");
  if (yoursDrawerWatch) { yoursDrawerWatch.disconnect(); yoursDrawerWatch = null; }
  if (drawer && typeof MutationObserver === "function") {
    yoursDrawerWatch = new MutationObserver(() => {
      if (knob.isConnected === false) { if (yoursDrawerWatch) yoursDrawerWatch.disconnect(); yoursDrawerWatch = null; return; }
      if (!drawerIsOpen() && (!document.activeElement || document.activeElement === document.body)) focusQuietly(knob);
    });
    yoursDrawerWatch.observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
  }
}

let yoursDrawerWatch = null;

/* ---------- THE PRE-REDESIGN PAGES THAT BECAME A YOURS VIEW ----------

   Redesign 2026 (Tactile), "No pre-redesign pages left reachable". Followed
   shows (`#/starred-shows`) and the Forays list (`#/forays`) were their own
   pages, drawn in the old chrome under the new tab bar. Yours has had both as
   chips (Shows, Forays) since the `library` screen, so the pages are gone as
   places and kept as ADDRESSES: an old deep link, a bookmark, a relaunch that
   replays `cp_last_route`, or the native shell's saved route still lands, on
   the matching Yours view.

   route() rewrites the address to `#/library` in place (no history entry, so
   the back gesture does not bounce off the old spelling); renderCurrentPage()
   also answers them, for a caller that paints without routing. The chip is
   `state.yoursChip`, which is memory and not a route, so a link that means
   "Yours, on Forays" says so with `data-yours-chip-link` beside a plain
   `href="#/library"` (a cold open, a long-press and a middle-click all still
   work), and ONE capture-phase listener on the document does the choosing.
   `#/queue` is not in this table on purpose: its drag and swipe reorder have no
   Yours equivalent yet (test/up-next-gestures.test.js). */
const YOURS_LEGACY_ROUTES = Object.freeze({ "#/forays": "forays", "#/starred-shows": "shows" });

/** The Yours chip an old route stands for, or null for any other hash. */
function yoursLegacyChip(hash) {
  return Object.prototype.hasOwnProperty.call(YOURS_LEGACY_ROUTES, hash) ? YOURS_LEGACY_ROUTES[hash] : null;
}

/** The attributes of a link that opens Yours on one chip. `chip` is this
    module's own constant ("forays", "shows"), escaped regardless. */
function yoursChipLinkAttrs(chip) {
  return `href="${esc(safeUrl("#/library"))}" data-yours-chip-link="${esc(chip)}"`;
}

/** The href attribute for an in-app route, sending an old Followed-shows or
    Forays address straight to its Yours view instead of through the redirect.
    Any other route is the plain safeUrl href every link already was. */
function routeLinkAttrs(hash) {
  const chip = yoursLegacyChip(String(hash));
  return chip ? yoursChipLinkAttrs(chip) : `href="${esc(safeUrl(String(hash)))}"`;
}

/** Bound once on the document, capture phase, so it runs before the router, the
    drawer's own close and the back handler. It only CHOOSES the chip; the link
    still navigates. On Yours already the hash does not change, so no route()
    would repaint: show the panel in place instead of leaving the press dead. */
function onYoursChipLinkClick(e) {
  const hit = e && e.target && typeof e.target.closest === "function" ? e.target.closest("[data-yours-chip-link]") : null;
  if (!hit) return;
  const chip = hit.getAttribute("data-yours-chip-link");
  if (!yoursChipDefs().some((c) => c.key === chip)) return;
  state.yoursChip = chip;
  if (currentHash() === "#/library" && $("#yours-chips")) {
    if (typeof e.preventDefault === "function") e.preventDefault();
    selectYoursChip(chip, { focus: true });
    openDrawer(false);
  }
}

function renderLibrary(chip) {
  setBodyClass("view-page");
  document.body.classList.add("view-yours");
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
  const queueList = queueRows();
  /* The chip a caller asked for is set BEFORE the empty-state decision, which reads it. */
  if (typeof chip === "string" && yoursChipDefs().some((c) => c.key === chip)) state.yoursChip = chip;
  const nothingYet = yoursNothingYet(queueList.length, allSavedRows.length, allHistoryRows.length, allPlaylists.length);

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
       names the Create tab, and links there. */
    : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`;

  /* The counts the readout line quotes. Forays are unknown until the player
     module has loaded, and an unknown count is not zero. */
  const followedCount = Object.keys(starredShowsMap()).length;
  const forayCount = state.forays && window.ForayPlayer ? forayCards().length : null;
  const counts = { shows: followedCount, saved: savedRows.length, playlists: allPlaylists.length, history: historyRows.length, forays: forayCount };
  yoursReadouts = {};
  for (const c of yoursChipDefs()) yoursReadouts[c.key] = yoursReadoutText(c.key, counts);
  yoursReadouts.upnext = yoursReadoutText("upnext", { queued: queueList.length, minutes: yoursQueueMinutes(queueList) });

  if (typeof chip === "string" && yoursChipDefs().some((c) => c.key === chip)) state.yoursChip = chip;
  const active = yoursActiveKey(queueList.length);
  const readoutText = nothingYet ? YOURS_EMPTY_READOUT : yoursReadouts[active];
  const inner = nothingYet ? null : {
    forays: libraryForaysHtml(),
    shows: yoursShowsHtml(),
    saved: savedHtml,
    playlists: playlistsHtml,
    upnext: yoursQueueInner(queueList),
    downloads: state.downloadBridge ? libraryDownloadsHtml(family) : "",
    history: historyHtml,
  };

  $("#view").innerHTML = `
    <div class="page page--yours">
      <div class="page-head yours-head">
        <div>
          <h2 class="display-xl" aria-level="1">Yours</h2>
          <p class="readout yours-readout" id="yours-readout" aria-live="polite">${esc(readoutText)}</p>
        </div>
        ${tactileKeycap({ size: "sm", variant: "paper", icon: "knob", label: "Settings and dials", id: "yours-knob" })}
      </div>
      ${nothingYet ? "" : `<div class="yours-chips" id="yours-chips" role="tablist" aria-label="Yours">${yoursChipsHtml(active, queueList.length)}</div>`}
      <div class="yours-panels">
        ${nothingYet ? yoursEmptyPanelHtml() : yoursChipDefs().map((c) => yoursPanelHtml(c.key, active, inner[c.key])).join("")}
      </div>
    </div>`;

  bindYoursChips($("#yours-chips"));
  fitYoursChip($("#yours-chips"));
  bindYoursKnob($("#yours-knob"));
  bindYoursShows($("#yours-panel-shows"));
  const queuePanel = $("#yours-panel-upnext");
  if (queuePanel) queuePanel.addEventListener("click", onYoursQueueClick);

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindDownloads($("#view"));
  bindPlay($("#view"));
  bindHomePlay($("#yours-panel-forays"));

  /* A COLD OPEN BEFORE THE PLAYER MODULE (review 2026-09-23). The Forays
     section can only list once the player module is up, and the forayCards() header
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
        <div><h2>Playlists</h2>${all.length ? `<p class="sub">${countLabel(all.length, "playlist")}</p>` : ""}</div>
      </div>
      <a class="page-link-row" href="#/create">Build a playlist ›</a>
      ${all.length ? all.map(p => `
        <a class="pl-row" href="${esc(safeUrl("#/" + playlistRoute(p)))}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${joinMeta(playlistLengthLabel(p), playedOnLabel(p.last_played_at))}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`}
    </div>`;
}
