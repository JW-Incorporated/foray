/* ui/library.js — Library (#/library) and the Playlists list (#/playlists).
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Library (#/library), Redesign 2026, ambient ("Afterglow") ----------

   Library is the second screen to wear the system (docs/redesign-2026/directions/
   ambient/BUILD-NOTES.md 4.5, 10.7, 10.11, 12.2; BUILD-PLAN 2.1.5). One AGGREGATE view over
   things that already live in localStorage and already have their own paths; this page
   adds no new storage:

     Forays     the forays the listener has OPENED (a progress row: started or finished,
                most recent first; a foray nobody opened is Today's and #/forays') as
                ForayTiles (the Lamp "Foray" pill, the strip, the name), six at most, and
                the Ember "All forays" link to #/forays
     Followed   followed shows (cp_starred_shows) as ShowTiles after them, nine cells in all,
                then an in-place "Show all". Everything here is followed, so a ShowTile carries NO followed badge:
                a mark would say nothing (10.7). One 3-up grid, no heads (iteration 4: the
                prototype's own structure; the Lamp "Foray" pill says which tile is which).
     Saved      cp_saved via savedMap(), the same QueueRow as Up Next, five and then "All saved"
     Playlists  cp_playlists, PlaylistTile rows
     Up Next    cp_queue via queueIds(), QueueRows: the playing row first (Fill glyph,
                the Lamp word "Playing"), then the list, each with a menu (Move up, Move
                down, Play next, Remove) and a Toast with Undo for five seconds
     History    cp_history newest first, QueueRows with a date, no menu

   WHAT THIS OVERTURNS (named, as test-classification.md asks): Library as a stack of
   legacy `.pl-row` summaries and `epRow`s with star and "+ Up Next" buttons, the
   "Forays" and "Followed shows" capped-at-five link sections, and Up Next as one
   "N queued" row that links away. The Up Next PAGE (#/queue) stays and keeps its own
   reorder, drag and swipe; the Library section is the quick view of the same list.

   THE FEW RULES THE REST FOLLOWS
     - Every interpolation goes through esc(); every href is an in-app hash route built
       from encodeURIComponent'd ids, every src goes through agArtwork()/safeUrl().
     - The Library never writes its own queue: Move up/down is `saveQueueIds` (the one
       writer of cp_queue), Remove is `removeFromQueue`, Play next is `playNextInQueue`,
       a tap on a row is `startEpisodePlay` with the Up Next context so the played row
       moves to the top (the Up Next model). `saveQueueIds` repaints this section when
       the page is showing (`repaintQueuePage` calls `repaintLibraryUpNext`).
     - A play control here is `data-lb-play`, never `data-play`: player/client.js's
       syncCardButtons rewrites a `[data-play]` button's TEXT four times a second, which
       would erase an svg glyph. Library paints its own state (`libSyncPlay`).
     - A count appears only when there is something to count, and an empty section is a
       SectionHead, one line and one button, no paragraph (BUILD-NOTES 4.5).
     - "Unknown is not empty": before the player module can list forays the grid claims
       nothing and offers the way in (the three-state rule, app.js).
     - Family Mode reaches Saved, History and Downloads (data-integrity-4), and what it
       hid is said, not denied.

   THE ROWS OF THE ORIGINAL (kept, because they were hard-won): History is newest-first
   and capped, as renderHome caps its rails -- "recently listened" is not a scroll-forever
   list. Saved had no cap; five and an in-place "All saved" keeps that honest. */

/* ONE grid (iteration 4, the prototype's and DIRECTION's own call, "Library forays are compact tiles", "art grids are
   3-up"): the forays the listener opened come first, then the shows they follow, nine cells in three rows of three.
   A ForayTile wears its Lamp "Foray" pill, so the grid needs no heads to say which is which; iteration 2's two
   labelled sections (a Fraunces head and a count over each, a quiet link under each) changed the screen's density
   and hierarchy, and the fidelity judges marked the build down for it. At most six of the nine are forays, so
   followed shows are never pushed out; the in-place "Show all" opens every one. */
const LIB_GRID_MAX = 9;
const LIB_FORAYS_MAX = 6;
/* A strip holds this many bars at most: at 3px wide and 2px apart, sixteen are 78px, which fits the narrowest tile's
   art (96 at 375, less 6 either side). A foray of fifty clips would otherwise run its bars out of the tile. */
const LIB_STRIP_BARS_MAX = 16;
const LIB_SAVED_MAX = 5;
const LIB_PLAYLISTS_MAX = 5;
const LIB_UPNEXT_MAX = 10;
const LIB_HISTORY_MAX = 20;
/* The Toast with Undo stays up this long. */
const LIB_TOAST_MS = 5000;
/* A strip bar's colour is its show's artwork hue (the palette table), muted: one fixed chroma, so a tile's strip
   never out-shouts the page. Two neighbours closer than LIB_BAR_NEAR_DEG are pushed 30 apart, as the prototype's
   segment colours are (BUILD-NOTES 1.2). The old seg-c0..7 rainbow is no longer drawn here. */
const LIB_BAR_CHROMA = 0.1;
const LIB_BAR_NEAR_DEG = 24;

/* What this page remembers between paints: nothing is stored, it is the open state of "All saved" and of the
   followed shows, the Toast's timer and the one thing Undo needs. */
const libUi = { savedOpen: false, gridOpen: false, toastTimer: null, undo: null, poll: null, currentId: null, menuFor: null };

const LIB_EMPTY = {
  grid: ["Nothing followed yet.", "Find shows", "/shows"],
  saved: ["Nothing saved yet.", "See today's picks", "/"],
  playlists: ["No playlists yet.", "Find shows", "/shows"],
  upnext: ["Nothing queued.", "See today's picks", "/"],
  history: ["Nothing played yet.", "See today's picks", "/"],
};

/* ---------- small helpers ---------- */

/** A deterministic tone for an artwork with no image (the monogram's colour), from the show's name. */
function libTone(name) {
  const tones = typeof AG_TONES !== "undefined" ? AG_TONES : ["amber"];
  const key = typeof agFnv1a === "function" ? agFnv1a(String(name || "")) : 0;
  return tones[key % tones.length];
}

/** The episode the bar is on (playing OR paused), or null. */
function libCurrentId() {
  try { return window.ForayPlayer?.currentEpisodeId?.() || null; } catch (_) { return null; }
}

function libIsPlaying(id) {
  try { return !!window.ForayPlayer?.isPlaying?.(id); } catch (_) { return false; }
}

/** Is the mini bar up? `body.fp-open` is the player's own word for it (client.js setNowPlaying). */
function libBarOpen() {
  try { return !!(document.body && document.body.classList && document.body.classList.contains("fp-open")); } catch (_) { return false; }
}

function libDownloaded(id) {
  try {
    const rec = downloadsValue().items[id];
    return !!rec && rec.status === "done";
  } catch (_) { return false; }
}

function libOffline() {
  try { return typeof navigator !== "undefined" && navigator.onLine === false; } catch (_) { return false; }
}

/** One empty section: the line, then the one button. `path` is one of the constant in-app routes in LIB_EMPTY, written
    without its `#` so the href opens with a literal `#` (an in-app route, not a URL owed to safeUrl). */
function libEmptyHtml(kind) {
  const [line, label, path] = LIB_EMPTY[kind];
  return `<div class="lb-empty"><p class="t-body">${esc(line)}</p><a class="ag-btn ag-btn-secondary" href="#${esc(path)}">${esc(label)}</a></div>`;
}

/** SectionHead (BUILD-NOTES 3): a count only when there is something to count. */
function libHead(title, count) {
  return agSectionHead(title, count > 0 ? String(count) : "");
}

function libQuietLink(label, path, spoken = "") {
  return `<a class="ag-btn ag-btn-quiet lb-more" href="#${esc(path)}"${spoken ? ` aria-label="${esc(spoken)}"` : ""}>${esc(label)}</a>`;
}

/* ---------- the grid: forays first, then followed shows ---------- */

/** Followed shows, newest follow first. Everything here is followed. */
function libFollowedShows() {
  return Object.values(starredShowsMap())
    .sort((a, b) => (b.starred_at || "").localeCompare(a.starred_at || ""))
    .map((e) => ({
      id: e.show_id,
      title: e.title || "",
      src: e.artwork_url || showArtworkUrl(showById(e.show_id)) || null,
    }));
}

/** The hue (degrees) of every show's strip colour: its artwork's hue from the palette table, a neighbour closer than
    LIB_BAR_NEAR_DEG pushed 30 further, up to three times (the prototype's rule). `names` are shows in strip order. */
function libShowHues(names) {
  const used = [];
  const out = new Map();
  const near = (h) => used.some((u) => { const d = Math.abs(u - h) % 360; return Math.min(d, 360 - d) < LIB_BAR_NEAR_DEG; });
  for (const name of names) {
    if (out.has(name)) continue;
    const pair = typeof agPaletteFor === "function" ? agPaletteFor(name) : null;
    let hue = pair ? Number(pair[0]) || 0 : 70;
    for (let tries = 0; tries < 3 && near(hue); tries++) hue = (hue + 30) % 360;
    used.push(hue);
    out.set(name, hue);
  }
  return out;
}

/** The strip along a foray tile's bottom edge, as the prototype draws it (afterglow.css .mini-strip): one bar per run
    of the same source, the narrator's runs as short Lamp bars between them (legible in greyscale, DIRECTION's colour
    rule), the bars the listener has reached lit. `elapsed` null = nothing played. A show's bar carries its hue
    (libShowHues), painted muted by libSizeStrips. */
function libForayBars(playable, elapsedSec, finished) {
  const player = window.ForayPlayer;
  if (typeof player?.stripModel !== "function" || !Array.isArray(playable) || !playable.length) return [];
  let model;
  try { model = player.stripModel(playable, { elapsed: elapsedSec > 0 ? elapsedSec : null }); } catch (_) { return []; }
  const reached = finished ? Infinity : (model.positioned && elapsedSec > 0 && Number.isInteger(model.currentIndex) ? model.currentIndex : -1);
  const runs = (model.runs || []).filter((run) => run.kind === "segment" || run.kind === "narration");
  const hues = libShowHues(runs.filter((run) => run.kind === "segment").map((run) => run.show || ""));
  const bars = [];
  for (const run of runs) {
    const narr = run.kind === "narration";
    const show = narr ? "" : (run.show || "");
    const hue = narr ? 0 : hues.get(show);
    const lit = run.from <= reached;
    const last = bars[bars.length - 1];
    if (last && last.narr === narr && last.show === show && last.lit === lit) last.grow += Math.max(1, Math.round(run.lengthSec));
    else bars.push({ show, hue, lit, narr, grow: Math.max(1, Math.round(run.lengthSec)) });
  }
  /* Too many bars for the tile: fold the two neighbours with the least runtime between them into one, wearing the
     longer one's look, until they fit. A narrator's bar is the first to go, it is the shortest. */
  while (bars.length > LIB_STRIP_BARS_MAX) {
    let at = 0;
    for (let i = 1; i < bars.length - 1; i++) if (bars[i].grow + bars[i + 1].grow < bars[at].grow + bars[at + 1].grow) at = i;
    const [a, b] = [bars[at], bars[at + 1]];
    const big = a.grow >= b.grow ? a : b;
    bars.splice(at, 2, { show: big.show, hue: big.hue, lit: big.lit, narr: big.narr, grow: a.grow + b.grow });
  }
  return bars;
}

/** The forays for the grid: the ones the listener has STARTED or FINISHED, most recent first (the same progress
    rows "Played" and "N min left" come from). A foray nobody has opened is the catalogue's, not the listener's:
    Today offers it and #/forays lists it, and the grid's "All" opens that list. This is what lets a first-run
    Library say "Nothing followed yet." and mean it. `known` is false while the player module cannot list them yet,
    `catalog` is how many are listed in all. */
function libForayList() {
  const known = !!(window.ForayPlayer && state.forays);
  if (!state.forays) return { known: true, tiles: [], total: 0, catalog: 0 };
  if (!known) return { known: false, tiles: [], total: 0, catalog: 0 };
  const list = forayCards();
  const byId = new Map(list.map((f) => [f.id, f]));
  const progress = forayProgressLabels();
  const resume = new Map();
  let started = [];
  try {
    started = forayResumeRows({ limit: Infinity, includeFinished: true });
    started.forEach((p) => resume.set(p.id, p));
  } catch (_) { /* no progress rows */ }
  const mine = started.map((p) => byId.get(p.id)).filter(Boolean);
  const tiles = mine.slice(0, libUi.gridOpen ? mine.length : LIB_FORAYS_MAX).map((f) => {
    const r = resolveListedForay(f.id);
    const names = [];
    for (const p of (r && r.playable) || []) {
      if (p && p.type !== "narration" && p.kind !== "tts" && p.show && !names.includes(p.show)) names.push(p.show);
    }
    const p = resume.get(f.id);
    const finished = !!(p && p.finished);
    return {
      id: f.id,
      title: f.title || f.id,
      shows: names.slice(0, 4).map((n) => ({ name: n, src: showArtworkUrl({ title: n }) })),
      glowShow: names[0] || f.title || f.id,
      bars: libForayBars(r && r.playable, p ? Number(p.elapsedSec) || 0 : 0, finished),
      finished,
      /* Said to a screen reader only, and whole: the draft tag, "Played" or "12 min left", then the length and makeup
         (forayListSubLabel, the one line every Foray list says; honesty-12, p-foray-8). The visible tile shows only the pill,
         the lit bars and the name, so this line is where the progress and the makeup are said. */
      sub: forayListSubLabel(f, progress),
    };
  });
  return { known: true, tiles, total: mine.length, catalog: list.length };
}

/** A ForayTile (BUILD-NOTES 3, the prototype's .ftile): the collage with the Lamp "Foray" pill at its top-left and the
    strip along its bottom edge, then the name (three lines at most) and nothing else. NO status badge: the lit bars
    say how far the listener got, and the screen-reader line says it in words; DIRECTION keeps a badge for the places
    where the state varies, and every foray here is one the listener opened. The facts the iteration-2 build printed
    under the name are not drawn (the prototype has none; the Forays page and the foray's own room carry them), but
    the screen-reader line still says them. The pill sits INSIDE the art's top-left corner, not straddling the edge
    as the prototype's does: iteration 1's judges marked the overhang down, and an inset pill keeps the tile's box
    the grid cell's box. */
function libForayTileHtml(t) {
  const arts = t.shows.length ? t.shows : [{ name: t.title, src: null }];
  const bars = t.bars.map((b) => `<i class="lb-bar${b.narr ? " lb-narr" : ""}${b.lit ? " is-lit" : ""}" data-grow="${esc(b.grow)}" data-hue="${esc(Math.round(Number(b.hue) || 0))}"></i>`).join("");
  return `<a class="lb-tile lb-foray" href="#${esc(forayRoutePath(t.id))}" data-ev="picked" data-ctx="library-foray" data-glow-show="${esc(t.glowShow)}">
    <span class="lb-art">${agCollage(arts, { size: 104 })}<span class="ag-pill lb-pill">Foray</span>${bars ? `<span class="lb-strip" aria-hidden="true">${bars}</span>` : ""}</span>
    <span class="t-caption lb-name clamp3">${esc(t.title)}</span>
    ${t.sub ? `<span class="sr-only lb-sub">${esc(t.sub)}</span>` : ""}
  </a>`;
}

function libShowTileHtml(s) {
  return `<a class="lb-tile lb-show" href="#${esc(showRoutePath(s.id))}" data-glow-show="${esc(s.title)}">
    <span class="lb-art" aria-hidden="true">${agArtwork({ name: s.title || "Show", src: s.src || "", size: 104, tone: libTone(s.title) })}</span>
    <span class="t-caption lb-name clamp3">${esc(s.title)}</span>
  </a>`;
}

/** The forays' share of the grid as markup. The foray-surface signature compares this string between a
    refresh and the page on screen (app.js foraySurfaceSignature), so a new foray repaints Library. */
function libraryForaysHtml() {
  if (!state.forays || !window.ForayPlayer) return "";
  return libForayList().tiles.map(libForayTileHtml).join("");
}

/** The one grid: the forays the listener opened (six at most), then the shows they follow, nine cells in all; "Show all"
    opens the rest in place ("Show fewer" once open). It has no head (the pill says "Foray"; a followed show needs
    no label) and is named for a screen reader by its aria-label. Under it, one quiet row: "Show all" only when
    something is left out, and the Ember "All forays" link once there is any foray to open (#/forays also lists the
    forays nobody has opened, which is what it is for). The Dock folded `#/starred-shows` into this page, so the
    toggle opens the rest here rather than linking to a page. A first run says one line, "Nothing followed yet." */
function libGridHtml() {
  const forays = libForayList();
  const shows = libFollowedShows();
  const label = 'aria-label="Forays and followed shows"';
  if (!forays.known) {
    /* The player module has not arrived: say nothing about forays, offer the way in. */
    return `<section class="lb-section lb-grid-section" data-lb-section="grid" ${label} aria-busy="true"><div class="lb-more-row">${libQuietLink("All forays", "/forays")}</div></section>`;
  }
  if (!forays.tiles.length && !shows.length) {
    return `<section class="lb-section lb-grid-section" data-lb-section="grid" ${label}>${libEmptyHtml("grid")}</section>`;
  }
  const cellsAll = forays.tiles.map(libForayTileHtml).concat(shows.map(libShowTileHtml));
  const overflow = forays.total > LIB_FORAYS_MAX || cellsAll.length > LIB_GRID_MAX;
  /* forays.tiles is already capped at six, so a seventh foray waits behind "Show all" rather than crowding out the shows. */
  const shown = libUi.gridOpen ? cellsAll : cellsAll.slice(0, LIB_GRID_MAX);
  const links = [];
  if (overflow) links.push(`<button type="button" class="ag-btn ag-btn-quiet lb-more" data-lb-grid-toggle aria-expanded="${libUi.gridOpen ? "true" : "false"}">${libUi.gridOpen ? "Show fewer" : "Show all"}</button>`);
  if (forays.tiles.length) links.push(libQuietLink("All forays", "/forays"));
  return `<section class="lb-section lb-grid-section" data-lb-section="grid" ${label}><div class="lb-grid">${shown.join("")}</div>${links.length ? `<div class="lb-more-row">${links.join("")}</div>` : ""}</section>`;
}

/* ---------- rows ---------- */

/** Which state line an EpisodeRow wears: playing, then unavailable (offline and not downloaded, or no audio),
    then played, then downloaded. */
function libRowState(r) {
  const item = r.item || {};
  if (r.state === "live" && libIsPlaying(item.id)) return "playing";
  if (r.state !== "live") return "unavailable";
  if (libOffline() && !libDownloaded(item.id)) return "unavailable";
  const p = rowProgress(item);
  if (p && p.state === "played") return "played";
  return libDownloaded(item.id) ? "downloaded" : "default";
}

function libStateLine(rowState) {
  const line = AG_ROW_LINES[rowState];
  return line ? `<span class="ag-row-state${esc(line[0])}">${agIcon(line[1], 20)}${esc(line[2])}</span>` : "";
}

/** The round 44 Play of an EpisodeRow. */
function libPlayButton({ id, title, playing, disabled, ctx }) {
  return `<button type="button" class="ag-btn ag-btn-play ag-btn-size-44 lb-play" data-lb-play="${esc(id)}" data-ctx="${esc(ctx)}" data-title="${esc(title)}" aria-label="${esc(`${playing ? "Pause" : "Play"} ${title || "this episode"}`)}"${disabled ? ' disabled aria-disabled="true"' : ""}>${agIcon(playing ? "pause" : "play", 20)}</button>`;
}

/** Saved's row, the SAME treatment as Up Next and History (iteration 2: one row throughout, not a serif 72px
    EpisodeRow among sans QueueRows): art 56, the title in the label face (two lines), one caption line (a state
    line, the show, the length) and the 44 Play. No why-line (the row is what the listener kept, not a pick) and no
    date: the date was what squeezed the show name to "Lex Fridman Po...". The title is the row's one real link;
    its ::after covers the row and Play sits above it. */
function libEpisodeRowHtml(r, ctx) {
  const item = r.item || {};
  const named = r.state !== "unnamed" && !!item.title;
  const rowState = libRowState(r);
  const playing = rowState === "playing";
  const id = item.id;
  if (!named) {
    return `<article class="raised ag-queue-row lb-row lb-qrow lb-nomenu lb-gone is-unavailable">${agArtwork({ name: "Episode", size: 56, tone: "amber", state: "dim" })}
      <div class="ag-row-copy"><p class="t-label clamp2">Episode no longer in the catalogue</p><p class="t-caption">Saved before 4a kept episode details</p></div></article>`;
  }
  const dur = fmtDur(episodeMinutes(item));
  const parts = [`<span class="lb-ell">${esc(item.show || "")}</span>`];
  if (dur) parts.push(`<span class="dur">${esc(dur)}</span>`);
  const playable = r.state === "live" && !!item.audio_url;
  return `<article class="raised ag-queue-row lb-row lb-qrow lb-saved is-${esc(rowState)}" data-lb-ep="${esc(id)}">
    ${agArtwork({ name: item.show || item.title, src: item.artwork_url || showArtworkUrl({ title: item.show }) || "", size: 56, tone: libTone(item.show), state: rowState === "unavailable" ? "dim" : "default" })}
    <div class="ag-row-copy">
      <h4 class="t-label clamp2 lb-ep-title"><a class="lb-link" href="#/episode/${esc(encodeURIComponent(id))}" data-ev="picked" data-ep="${esc(id)}" data-ctx="${esc(ctx)}">${esc(item.title)}</a></h4>
      <p class="t-caption ag-row-meta lb-meta">${libStateLine(rowState)}${parts.join('<span class="lb-sep" aria-hidden="true"></span>')}</p>
    </div>
    ${playable ? libPlayButton({ id, title: item.title, playing, disabled: rowState === "unavailable", ctx }) : ""}
  </article>`;
}

/** One QueueRow (BUILD-NOTES 3): art 56, title (2 lines), a caption, and, in Up Next only, the 44 menu button.
    A tap anywhere on the row plays it (a button laid over the row, under the menu), so the play context is the
    row's. `o.current` marks the playing row: the Fill glyph, the Lamp word "Playing", the --glow-row ground. */
function libQueueRowHtml(r, o) {
  const item = r.item || {};
  const id = item.id || r.id;
  const named = r.state !== "unnamed" && !!item.title;
  const playable = r.state === "live" && !!item.audio_url;
  const title = named ? item.title : "Episode no longer available";
  const current = !!o.current;
  const running = current && libIsPlaying(id);
  /* The caption: Playing (when current), a date (History), the show, and what is left or how long. */
  let rest = "";
  if (named) {
    const prog = playable ? rowProgress(item) : null;
    /* Up Next says "Played" for a queued episode already finished (audit round 2, honesty-5: a queued row must not
       look fresh); History is all played, so there it keeps the length. */
    const left = prog && prog.label && (prog.state !== "played" || o.upnext) ? prog.label : fmtDur(episodeMinutes(item));
    const date = o.date ? fmtDate(item.release_date) : "";
    rest = [date, item.show || "", r.state === "archived" ? "not available right now" : left].filter(Boolean).join(" · ");
  } else rest = "4a no longer has this episode's details";
  const lead = current ? `<span class="ag-row-state">Playing</span>` : "";
  /* On the Up Next PAGE the cover also carries the two gestures (ui/queue.js): a swipe left removes (`data-swipe-id`), and a
     hold lifts the row to drag it (`data-drag-handle`, rows with a menu only: the playing row stays first). There is no
     handle glyph: the direction gives the row one trailing control, the menu, and its Move up / Move down are how a
     keyboard or switch user reorders. */
  const drags = !!(o.page && o.menu);
  const cover = playable
    ? `<button type="button" class="lb-cover" data-lb-play="${esc(id)}"${o.page ? ` data-swipe-id="${esc(id)}"` : ""}${drags ? ` data-drag-handle="${esc(id)}" aria-describedby="up-next-drag-hint"` : ""} data-ctx="${esc(o.ctx)}" data-title="${esc(item.title || "")}" aria-label="${esc(`${running ? "Pause" : "Play"} ${item.title || "this episode"}`)}"></button>`
    : "";
  const menu = o.menu
    ? `<button type="button" class="ag-btn ag-btn-icon lb-dots" data-lb-menu="${esc(id)}" aria-haspopup="dialog" aria-label="${esc(`More for ${title}`)}">${agIcon("dots", 24)}</button>`
    : "";
  return `<article class="raised ag-queue-row lb-row lb-qrow${o.page ? " qp-row" : ""}${current ? " is-current" : ""}${o.menu ? "" : " lb-nomenu"}${playable ? "" : " lb-gone"}" data-lb-q="${esc(id)}"${current ? ' aria-current="true"' : ""}>
    ${agArtwork({ name: item.show || title, src: item.artwork_url || "", size: 56, tone: libTone(item.show), state: playable ? "default" : "dim" })}
    <div class="ag-row-copy">
      <p class="t-label">${current ? agIcon("play-fill", 20) : ""}${esc(title)}</p>
      <p class="t-caption ag-row-meta">${lead}<span class="lb-ell">${current ? "· " : ""}${esc(rest)}</span></p>
    </div>
    ${cover}${menu}${o.page ? '<span class="qp-under" aria-hidden="true">Remove</span>' : ""}
  </article>`;
}

/* ---------- Saved ---------- */

function libSavedHtml(rows, hidden) {
  const total = rows.length;
  const shown = libUi.savedOpen ? rows : rows.slice(0, LIB_SAVED_MAX);
  const note = hidden > 0 ? `<p class="note">${esc(`Family mode is on, so ${hidden} saved episode${hidden === 1 ? " is" : "s are"} hidden.`)}</p>` : "";
  let body;
  if (!total) body = hidden > 0 ? note : libEmptyHtml("saved");
  else {
    body = `<div class="lb-stack">${shown.map((r) => libEpisodeRowHtml(r, "library-saved")).join("")}</div>${note}`;
    if (total > LIB_SAVED_MAX) {
      body += `<button type="button" class="ag-btn ag-btn-quiet lb-more" data-lb-saved-toggle aria-expanded="${libUi.savedOpen ? "true" : "false"}">${libUi.savedOpen ? "Show fewer" : "All saved"}</button>`;
    }
  }
  return `<section class="lb-section" data-lb-section="saved">${libHead("Saved", total)}${body}</section>`;
}

/* ---------- Playlists ---------- */

/** A PlaylistTile as a row: a 56 collage of up to four episode arts, the name, "6 episodes, 2 hr 10 min", and, once
    started, "3 of 6 played" in Ember. */
function libPlaylistRowHtml(p, history) {
  const rows = resolveParts(p);
  const covers = rows.filter((r) => r.item).slice(0, 4).map((r) => ({ name: r.item.show || r.item.title || "", src: r.item.artwork_url || null }));
  const timed = rows.length > 0 && rows.every((r) => r.item && episodeMinutes(r.item) > 0);
  const total = timed ? rows.reduce((s, r) => s + episodeMinutes(r.item), 0) : 0;
  const played = rows.filter((r) => r.item && hasOpened(r.item.id, history)).length;
  const meta = [countLabel(rows.length, "episode"), fmtDur(total)].filter(Boolean).join(", ");
  return `<a class="raised lb-row lb-prow" href="#/${esc(playlistRoute(p))}">
    ${agCollage(covers.length ? covers : [{ name: p.title || "Playlist" }], { size: 56 })}
    <span class="lb-pcopy">
      <span class="t-label clamp2">${esc(p.title || p.name || "Playlist")}</span>
      <span class="t-caption lb-pmeta">${esc(meta)}</span>
      ${rows.length && played ? `<span class="t-caption ag-progress-copy">${esc(`${played} of ${rows.length} played`)}</span>` : ""}
    </span>
  </a>`;
}

function libPlaylistsHtml() {
  const all = playlists();
  const history = new Set(pickedHistory());
  let body;
  if (!all.length) body = libEmptyHtml("playlists");
  else {
    body = `<div class="lb-stack">${all.slice(0, LIB_PLAYLISTS_MAX).map((p) => libPlaylistRowHtml(p, history)).join("")}</div>`;
    if (all.length > LIB_PLAYLISTS_MAX) body += libQuietLink("All playlists", "/playlists");
  }
  return `<section class="lb-section" data-lb-section="playlists">${libHead("Playlists", all.length)}${body}</section>`;
}

/* ---------- Up Next ---------- */

/** The Up Next model the section draws and the menu acts on: the playing row first, then the rest of cp_queue in
    its order. The playing row is not part of the reorder (it leaves the list when it ends); a playing episode that
    was never queued still shows first, as the item the list continues from. */
function libUpNextModel() {
  const cur = libCurrentId();
  const queued = queueIds();
  const rest = queued.filter((id) => id !== cur);
  const rows = rowsForIds(rest);
  const current = cur ? (rowsForIds([cur])[0]) : null;
  return { cur, queued, rest, rows, current: current && current.state !== "unnamed" ? current : null };
}

/* `page` is the Up Next PAGE (ui/queue.js, #/queue): the same rows, menu, Toast and writers, with every row (no cap, no
   "All N" link), the page's own head in place of the section head, and the two gestures on the rows. */
function libUpNextInnerHtml(page = false) {
  const m = libUpNextModel();
  const count = m.rows.length + (m.current ? 1 : 0);
  let body;
  if (!count) body = libEmptyHtml("upnext");
  else {
    const shown = page ? m.rows : m.rows.slice(0, LIB_UPNEXT_MAX);
    const list = [];
    if (m.current) list.push(libQueueRowHtml(m.current, { current: true, upnext: true, ctx: UP_NEXT_CTX, page }));
    shown.forEach((r) => list.push(libQueueRowHtml(r, { upnext: true, ctx: UP_NEXT_CTX, menu: true, page })));
    body = `<div class="lb-stack">${list.join("")}</div>`;
    if (!page && m.rows.length > LIB_UPNEXT_MAX) body += libQuietLink(`All ${m.rows.length} in Up Next`, "/queue");
  }
  return `${page ? queuePageHeadHtml(count, m.queued.length) : libHead("Up Next", count)}${body}`;
}

function libUpNextHtml() {
  return `<section class="lb-section" data-lb-section="upnext">${libUpNextInnerHtml()}</section>`;
}

/** Rows' tops by id, for the reorder slide. */
function libRowTops(section) {
  const tops = new Map();
  if (!section || typeof section.querySelectorAll !== "function") return tops;
  section.querySelectorAll("[data-lb-q]").forEach((row) => {
    if (typeof row.getBoundingClientRect !== "function") return;
    const r = row.getBoundingClientRect();
    if (r && Number.isFinite(r.top)) tops.set(row.dataset.lbQ, r.top);
  });
  return tops;
}

/** The neighbours slide to their new places: each row that moved starts where it was and travels for --m-ui on
    --e-out (BUILD-NOTES 4.5). Transform only. Reduced motion: the stylesheet's one block forces the property list
    to opacity and colour, so the rows simply take their places. */
function libSlideRows(section, before) {
  if (!section || !before || !before.size || typeof section.querySelectorAll !== "function") return;
  const moved = [];
  section.querySelectorAll("[data-lb-q]").forEach((row) => {
    const was = before.get(row.dataset.lbQ);
    if (was === undefined || typeof row.getBoundingClientRect !== "function") return;
    const dy = was - row.getBoundingClientRect().top;
    if (!dy || !row.style) return;
    row.style.transition = "none";
    row.style.transform = `translateY(${dy}px)`;
    moved.push(row);
  });
  if (!moved.length) return;
  if (typeof section.getBoundingClientRect === "function") section.getBoundingClientRect(); // commit the start frame
  moved.forEach((row) => {
    row.style.transition = "transform var(--m-ui) var(--e-out)";
    row.style.transform = "";
    const done = () => { row.style.transition = ""; row.removeEventListener("transitionend", done); };
    row.addEventListener("transitionend", done);
  });
}

/** Repaint the Up Next section in place (called from app.js repaintQueuePage while Library is showing). `slide`
    keeps the neighbours' travel; focus stays on the control that was pressed when its row is still there. */
function repaintLibraryUpNext({ slide = false } = {}) {
  const view = $("#view");
  const section = view && typeof view.querySelector === "function" ? view.querySelector('[data-lb-section="upnext"]') : null;
  if (!section) return;
  const before = slide ? libRowTops(section) : null;
  const active = typeof document !== "undefined" && document.activeElement && typeof document.activeElement.closest === "function" && section.contains(document.activeElement)
    ? document.activeElement : null;
  /* The control that held focus, by which kind it was and for which episode, so it is found again in the new rows; and
     where it stood among its kind, so a row that has left (played from here, then chained on) hands focus to the row
     that took its place instead of to <body> (audit round 2, p-impatient-6). */
  const KINDS = [["lbMenu", "[data-lb-menu]"], ["dragHandle", "[data-drag-handle]"], ["lbPlay", "[data-lb-play]"]];
  const kind = active && active.dataset ? KINDS.find(([key]) => active.dataset[key]) : null;
  const held = kind ? { key: kind[0], id: active.dataset[kind[0]], index: Math.max(0, [...section.querySelectorAll(kind[1])].indexOf(active)), sel: kind[1] } : null;
  const page = !!(section.dataset && section.dataset.lbPage);
  libUi.currentId = libCurrentId();
  /* The page's Glow is the playing item's, set BEFORE the rows are drawn: a playing row that appears already lit
     never animates from the old colour (under Reduce Motion that would be a 200ms crossfade for nothing). */
  libSyncCast();
  section.innerHTML = libUpNextInnerHtml(page);
  bindLibrary(section);
  /* The Up Next page's own controls (Clear, the drag handles, the swipe) live in ui/queue.js. */
  if (page && typeof bindQueuePage === "function") bindQueuePage(section);
  libApplyGlow(section);
  if (slide) libSlideRows(section, before);
  if (held) {
    const peers = [...section.querySelectorAll(held.sel)];
    const again = peers.find((b) => b.dataset && b.dataset[held.key] === held.id)
      || peers[Math.min(held.index, peers.length - 1)] || (typeof section.querySelector === "function" ? section.querySelector("h2") : null);
    if (again) focusQuietly(again);
  }
}

/* ---------- History ---------- */

function libHistoryHtml(rows, hidden) {
  const note = hidden > 0 ? `<p class="note">${esc(`Family mode is on, so ${hidden} played episode${hidden === 1 ? " is" : "s are"} hidden.`)}</p>` : "";
  let body;
  if (!rows.length) body = hidden > 0 ? note : libEmptyHtml("history");
  else {
    body = `<div class="lb-stack">${rows.map((r) => (r.state === "unnamed"
      ? `<article class="raised ag-queue-row lb-row lb-qrow lb-nomenu lb-gone">${agArtwork({ name: "Episode", size: 56, tone: "amber", state: "dim" })}<div class="ag-row-copy"><p class="t-label">No longer available</p><p class="t-caption">Previously played, no longer available</p></div></article>`
      : libQueueRowHtml(r, { ctx: "library-history", date: true }))).join("")}</div>${note}`;
  }
  /* History carries no count in the prototype (a count of what you played says little); the head is the title alone. */
  return `<section class="lb-section" data-lb-section="history">${libHead("History", 0)}${body}</section>`;
}

/** History as the Library draws it, read from the store: the last LIB_HISTORY_MAX played, newest first, Family Mode applied
    (an "unnamed" row has nothing in it to hide). The Up Next page (ui/queue.js) ends with this same section, so History
    continues under the queue there as it does in the prototype's Library. */
function libHistorySectionHtml() {
  const all = rowsForIds(pickedHistory().slice().reverse().slice(0, LIB_HISTORY_MAX));
  const shown = all.filter((r) => r.state === "unnamed" || familyAllows(r.item));
  return libHistoryHtml(shown, all.length - shown.length);
}

/* ---------- the page ---------- */

function libCastHtml() {
  const on = libBarOpen() || !!libCurrentId();
  return `<div class="dock-cast lb-cast" data-state="${on ? "playing" : "idle"}" aria-hidden="true"></div><div class="lb-fade" aria-hidden="true"></div>`;
}

function libToastHtml() {
  return `<div class="raised ag-toast lb-toast" role="status" aria-live="polite" data-lb-toast><span class="t-label" data-lb-toast-text></span><button type="button" class="ag-btn ag-btn-quiet" data-lb-undo>Undo</button></div>`;
}

function renderLibrary() {
  libTeardown();
  setBodyClass("view-library");
  fullPool(); // populate itemIndex/poolIds so saved/history rows can play in-app

  /* Family Mode reaches Library too (data-integrity-4). An "unnamed" row has nothing in it to hide. */
  const family = (r) => r.state === "unnamed" || familyAllows(r.item);
  const allSavedRows = rowsForIds(Object.keys(savedMap()));
  const savedRows = allSavedRows.filter(family);

  libUi.currentId = libCurrentId();
  $("#view").innerHTML = `
    <div class="ag lb-page is-settling">
      ${libCastHtml()}
      <header class="lb-head"><h2 class="t-title" tabindex="-1">Library</h2></header>
      ${libGridHtml()}
      ${libSavedHtml(savedRows, allSavedRows.length - savedRows.length)}
      ${libPlaylistsHtml()}
      ${libUpNextHtml()}
      ${state.downloadBridge ? `<section class="lb-section" data-lb-section="downloads">${libHead("Downloads", 0)}${libraryDownloadsHtml(family)}</section>` : ""}
      ${libHistorySectionHtml()}
      ${libToastHtml()}
    </div>`;

  const view = $("#view");
  /* LIGHT FIRST, before anything can force a style recalculation: the page's Glow and every tile's colour are set in
     the same task as the markup, so the first frame is already lit and nothing animates from the default (under
     Reduce Motion that would be a 200ms crossfade of the playing row for nothing). */
  libApplyGlow(view);
  bindPickLogging(view);
  bindStars(view);
  bindUpNext(view);
  bindDownloads(view);
  bindPlay(view);
  bindLibrary(view);
  libSizeStrips(view);
  libSettle(view);
  libStartPoll();

  /* A COLD OPEN BEFORE THE PLAYER MODULE (review 2026-09-23). The Forays can only list once the player is up,
     and the forayCards() header says every page that lists Forays must close that gap itself -- as renderForays
     does. Nothing else repaints Library when the module lands. */
  if (!window.ForayPlayer && state.forays) {
    const isCurrentRender = renderToken();
    playerBridge().then((player) => {
      if (player && isCurrentRender() && currentHash() === "#/library") renderCurrentPage();
    });
  }
}

/* ---------- light: every tile casts its own artwork's colour ---------- */

/** Write each tile's `--art-glow` from the palette of its first show (ui/palette.js), through the CSSOM (the CSP
    forbids an inline style ATTRIBUTE, not this). The art then casts that colour, never a black shadow. */
function libApplyGlow(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function" || typeof agSetGlow !== "function") return;
  scope.querySelectorAll("[data-glow-show]").forEach((tile) => {
    const art = tile.querySelector(".ag-collage, .ag-art");
    if (art) agSetGlow(art, tile.dataset.glowShow, "--art-glow");
  });
  libSyncCast();
}

/** THE FIRST FRAME IS THE LIT ONE. Reading the Glow lightness (palette.js) forces a style recalculation, so the page
    is styled once at the default Glow and then lit; without a guard the playing row and every tile would animate
    from the default colour (under Reduce Motion, a 200ms crossfade of nothing). The page is drawn with `.is-settling`
    (no transitions, stylesheet) and released two frames later, after the first lit frame has been painted. */
function libSettle(scope) {
  const page = scope && typeof scope.querySelector === "function" ? scope.querySelector(".lb-page") : null;
  if (!page || !page.classList) return;
  const release = () => { if (page.classList) page.classList.remove("is-settling"); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(release));
  else release();
}

/** The Dock's upward light (BUILD-NOTES 11.1): shown while the bar is up, tinted by what plays, absent otherwise. */
function libSyncCast() {
  const view = $("#view");
  const page = view && typeof view.querySelector === "function" ? view.querySelector(".lb-page") : null;
  const cast = page ? page.querySelector(".lb-cast") : null;
  if (!cast) return;
  const cur = libCurrentId();
  const on = libBarOpen() || !!cur;
  if (cast.getAttribute("data-state") !== (on ? "playing" : "idle")) cast.setAttribute("data-state", on ? "playing" : "idle");
  if (!on) return;
  /* The page's Glow is the playing item's: the cast and the playing row's ground (--glow-row) both read it. */
  const item = cur ? (state.itemIndex[cur] || storedEpisode(cur)) : null;
  if (item && item.show && typeof agSetGlow === "function") agSetGlow(page, item.show, "--glow");
  else if (page.style && typeof page.style.removeProperty === "function") page.style.removeProperty("--glow");
}

/** A strip bar's colour: its show's artwork hue at the strip's lightness (the Glow's lightness, 0.04 up in Dusk and
    0.04 down in Dawn, the prototype's segColor2) and the one muted chroma. Built from numbers only. */
function libBarColour(hue) {
  const gl = typeof agGlowLightness === "function" ? agGlowLightness() : 0.66;
  const lightness = gl > 0.6 ? gl + 0.04 : gl - 0.04;
  return "oklch(" + lightness.toFixed(2) + " " + LIB_BAR_CHROMA + " " + (((Number(hue) || 0) % 360) + 360) % 360 + ")";
}

/** Bar widths and colours are DOM properties, never a style attribute (strict CSP). */
function libSizeStrips(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".lb-bar[data-grow]").forEach((bar) => {
    const grow = Math.max(1, Number(bar.dataset.grow) || 1);
    if (!bar.style) return;
    bar.style.flexGrow = String(grow);
    if (typeof bar.style.setProperty === "function") bar.style.setProperty("--c", libBarColour(bar.dataset.hue));
  });
}

/* ---------- playing state, kept live ---------- */

function libSyncPlay() {
  const view = $("#view");
  if (!view || typeof view.querySelectorAll !== "function" || !view.querySelector(".lb-page")) { libStopPoll(); return; }
  view.querySelectorAll("[data-lb-ep]").forEach((row) => {
    const id = row.dataset.lbEp;
    const on = libIsPlaying(id);
    if (row.classList.contains("is-playing") === on) return;
    row.classList.toggle("is-playing", on);
    const btn = row.querySelector("[data-lb-play]");
    const meta = row.querySelector(".lb-meta");
    if (btn) {
      btn.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${btn.dataset.title || "this episode"}`);
      btn.innerHTML = agIcon(on ? "pause" : "play", 20);
    }
    if (meta) {
      const line = meta.querySelector(".ag-row-state");
      if (line) line.remove();
      if (on) meta.insertAdjacentHTML("afterbegin", libStateLine("playing"));
    }
  });
  libSyncCast();
  /* The playing row of Up Next is structural: when what is playing changes, the section is drawn again. */
  if (libCurrentId() !== libUi.currentId) repaintLibraryUpNext();
}

function libStartPoll() {
  if (libUi.poll || typeof setInterval !== "function") return;
  libUi.poll = setInterval(libSyncPlay, 1000);
  if (libUi.poll && typeof libUi.poll.unref === "function") libUi.poll.unref();
}

function libStopPoll() {
  if (libUi.poll && typeof clearInterval === "function") clearInterval(libUi.poll);
  libUi.poll = null;
}

/** Everything the last paint left running: the poll, the Toast's timer, an open menu. */
function libTeardown() {
  libStopPoll();
  if (libUi.toastTimer && typeof clearTimeout === "function") clearTimeout(libUi.toastTimer);
  libUi.toastTimer = null;
  libUi.undo = null;
  libCloseMenu();
}

/* ---------- behaviour ---------- */

async function libPlayPress(btn) {
  const id = btn.dataset.lbPlay;
  const player = window.ForayPlayer;
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !player) return;
  /* A row showing Pause must pause (the rule bindPlay learned, founder 2026-09-22). */
  if (player.isCurrent?.(id)) { await player.togglePlayback(); libSyncPlay(); return; }
  const ctx = btn.dataset.ctx || "library-saved";
  const view = $("#view");
  /* The play list is the rows of THAT list (the same data-ctx), in on-screen order. */
  const list = view && typeof view.querySelectorAll === "function"
    ? [...view.querySelectorAll("[data-lb-play]")].map((b) => ({ id: b.dataset.lbPlay, ctx: b.dataset.ctx })) : [];
  await startEpisodePlay(id, item, { ctx, list });
  libSyncPlay();
}

function bindLibrary(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-lb-play]").forEach((btn) => {
    if (btn._lbBound) return;
    btn._lbBound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      /* A swipe on the Up Next page ends on this same button and the browser then sends it a click: that click is the
         end of the gesture, not a tap to play (ui/queue.js sets the flag, once, on a claimed swipe). */
      if (btn._lbSwallow) { btn._lbSwallow = false; return; }
      libPlayPress(btn);
    });
  });
  scope.querySelectorAll("[data-lb-menu]").forEach((btn) => {
    if (btn._lbBound) return;
    btn._lbBound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); libOpenMenu(btn.dataset.lbMenu, btn); });
  });
  scope.querySelectorAll("[data-lb-saved-toggle]").forEach((btn) => {
    if (btn._lbBound) return;
    btn._lbBound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      libUi.savedOpen = !libUi.savedOpen;
      renderLibrary();
      const again = $("#view") && $("#view").querySelector("[data-lb-saved-toggle]");
      if (again) focusQuietly(again);
    });
  });
  scope.querySelectorAll("[data-lb-grid-toggle]").forEach((btn) => {
    if (btn._lbBound) return;
    btn._lbBound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      libUi.gridOpen = !libUi.gridOpen;
      renderLibrary();
      const again = $("#view") && $("#view").querySelector("[data-lb-grid-toggle]");
      if (again) focusQuietly(again);
    });
  });
  scope.querySelectorAll("[data-lb-undo]").forEach((btn) => {
    if (btn._lbBound) return;
    btn._lbBound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); libUndo(); });
  });
}

/** The Up Next section on screen, or null. */
function libUpNextSection() {
  const view = $("#view");
  return view && typeof view.querySelector === "function" ? view.querySelector('[data-lb-section="upnext"]') : null;
}

/** The first element under #view matching `selector` whose dataset[key] is `value`: an attribute match done
    by hand, so an id never has to be escaped into a selector. */
function libFindBy(selector, key, value) {
  const view = $("#view");
  if (!view || typeof view.querySelectorAll !== "function") return null;
  return [...view.querySelectorAll(selector)].find((el) => el.dataset && el.dataset[key] === value) || null;
}

/* ---------- the Toast ---------- */

function libShowToast(text) {
  const toast = $("#view") && typeof $("#view").querySelector === "function" ? $("#view").querySelector("[data-lb-toast]") : null;
  if (!toast) return;
  setStatusText(toast.querySelector("[data-lb-toast-text]"), text);
  toast.classList.add("is-open");
  if (libUi.toastTimer) clearTimeout(libUi.toastTimer);
  libUi.toastTimer = setTimeout(libHideToast, LIB_TOAST_MS);
  if (libUi.toastTimer && typeof libUi.toastTimer.unref === "function") libUi.toastTimer.unref();
}

function libHideToast() {
  const toast = $("#view") && typeof $("#view").querySelector === "function" ? $("#view").querySelector("[data-lb-toast]") : null;
  if (toast) toast.classList.remove("is-open");
  if (libUi.toastTimer) clearTimeout(libUi.toastTimer);
  libUi.toastTimer = null;
  libUi.undo = null;
}

/** Undo puts the list back exactly as it was (the one writer, saveQueueIds) and gives the removed episode its
    snapshot back, as addToQueue does, so a row only the snapshot store knew is not turned into "unavailable". */
function libUndo() {
  const undo = libUi.undo;
  libHideToast();
  if (!undo) return;
  const before = libRowTops(libUpNextSection());
  /* saveQueueIds repaints this section (app.js repaintQueuePage); the slide then runs on the repainted rows. */
  saveQueueIds(undo.ids);
  rememberEpisode(undo.id);
  logEvent("queued", { episode_id: undo.id });
  libSlideRows(libUpNextSection(), before);
  focusQuietly(libFindBy("[data-lb-menu]", "lbMenu", undo.id));
  announce("Back in Up Next.");
}

/* ---------- the row menu (a sheet): Move up, Move down, Remove, Play next ---------- */

function libMenuItems(id) {
  const m = libUpNextModel();
  const at = m.rest.indexOf(id);
  const row = m.rows.find((r) => r.id === id);
  const playable = !!row && row.state === "live";
  return [
    { key: "up", icon: "arrow-up", label: "Move up", disabled: at <= 0 },
    { key: "down", icon: "arrow-down", label: "Move down", disabled: at < 0 || at >= m.rest.length - 1 },
    { key: "next", icon: "queue", label: "Play next", disabled: !playable || at === 0 },
    { key: "remove", icon: "x", label: "Remove", disabled: at < 0 },
  ];
}

function libCloseMenu() {
  const wrap = typeof document !== "undefined" && typeof document.getElementById === "function" ? document.getElementById("lb-menu-sheet") : null;
  libUi.menuFor = null;
  if (!wrap) return;
  closeSheet(wrap, { removeIfOwned: true });
}

function libOpenMenu(id, opener) {
  libCloseMenu();
  const m = libUpNextModel();
  const row = m.rows.find((r) => r.id === id);
  if (!row) return;
  const title = row.state === "unnamed" ? "Episode no longer available" : (row.item.title || "Episode");
  const items = libMenuItems(id);
  const wrap = document.createElement("div");
  wrap.className = "fy-sheet ag lb-sheet";
  wrap.id = "lb-menu-sheet";
  wrap.innerHTML = `<div class="fy-scrim" data-lb-scrim></div>
    <div class="fy-panel lb-panel" id="lb-menu-panel" role="dialog" aria-modal="true" aria-labelledby="lb-menu-title">
      <span class="lb-grab" aria-hidden="true"></span>
      <div class="lb-menu-head"><p class="t-headline clamp1 lb-menu-title" id="lb-menu-title">${esc(title)}</p><button type="button" class="ag-btn ag-btn-icon lb-menu-close" data-lb-close aria-label="Close">${agIcon("x", 24)}</button></div>
      <div class="lb-menu">${items.map((it) => `<button type="button" class="lb-menu-item" data-lb-do="${esc(it.key)}"${it.disabled ? ' disabled aria-disabled="true"' : ""}>${agIcon(it.icon, 24)}<span class="t-body">${esc(it.label)}</span></button>`).join("")}</div>
    </div>`;
  libUi.menuFor = id;
  wrap.querySelectorAll("[data-lb-do]").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.preventDefault(); libMenuAct(id, btn.dataset.lbDo); });
  });
  const scrim = wrap.querySelector("[data-lb-scrim]");
  if (scrim) scrim.addEventListener("click", () => libCloseMenu());
  const close = wrap.querySelector("[data-lb-close]");
  if (close) close.addEventListener("click", (e) => { e.preventDefault(); libCloseMenu(); });
  openSheet(wrap, { panel: wrap.querySelector(".lb-panel"), onRequestClose: libCloseMenu, returnFocus: opener });
}

/** Remove a row from Up Next and offer the way back: the whole list is kept for Undo, the removal is the one writer's
    (`removeFromQueue`), and the Toast says so for five seconds. The menu's Remove and the Up Next page's swipe both
    come here, so a removal by either hand has the same Undo. */
function libRemoveRow(id) {
  libUi.undo = { ids: queueIds(), id };
  removeFromQueue(id);
  libShowToast("Removed from Up Next");
  announce("Removed from Up Next.");
}

/** What a menu item does. The list is always written whole through saveQueueIds, in the order the section draws
    (the playing row first), so the order on screen and the order in storage are the same list. */
function libMenuAct(id, act) {
  libCloseMenu();
  const m = libUpNextModel();
  const at = m.rest.indexOf(id);
  if (at < 0) return;
  const before = libRowTops(libUpNextSection());
  const whole = (rest) => (m.cur && m.queued.includes(m.cur) ? [m.cur, ...rest] : rest);
  if (act === "up" && at > 0) {
    const rest = m.rest.slice();
    [rest[at - 1], rest[at]] = [rest[at], rest[at - 1]];
    saveQueueIds(whole(rest));
    announce(`Moved to position ${at} of ${rest.length}.`);
  } else if (act === "down" && at < m.rest.length - 1) {
    const rest = m.rest.slice();
    [rest[at + 1], rest[at]] = [rest[at], rest[at + 1]];
    saveQueueIds(whole(rest));
    announce(`Moved to position ${at + 2} of ${rest.length}.`);
  } else if (act === "next") {
    if (!playNextInQueue(id)) return;
    announce("Playing next.");
  } else if (act === "remove") {
    libRemoveRow(id);
  } else return;
  /* saveQueueIds has repainted the section (app.js repaintQueuePage); the neighbours now slide from where they were. */
  libSlideRows(libUpNextSection(), before);
  const view = $("#view");
  const rows = view && typeof view.querySelectorAll === "function" ? [...view.querySelectorAll("[data-lb-menu]")] : [];
  focusQuietly(libFindBy("[data-lb-menu]", "lbMenu", id) || rows[Math.min(at, rows.length - 1)] || (view && view.querySelector(".lb-head h2")));
}

/* THE LIST, AND ONE DOOR TO THE BUILDER (audit round 2, p-first-6; founder
   question 4, default taken): the `#pl-form` builder that lived here is gone --
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
        <a class="pl-row" href="#/${esc(playlistRoute(p))}">
          <div class="info">
            <div class="t">${esc(p.title)}</div>
            <div class="s">${joinMeta(playlistLengthLabel(p), playedOnLabel(p.last_played_at))}</div>
          </div>
          <span class="chev">›</span>
        </a>`).join("")
      : `<p class="note">No playlists yet — <a href="#/create">build one on the Create tab</a>.</p>`}
    </div>`;
}
