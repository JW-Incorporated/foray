/* ui/episode.js — Episode page (#/episode/<id>): description, chapters, timestamp seeks. Wears the Afterglow system
   (Redesign 2026, ambient): `.ag.ep` in ui/episode.css.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* Resolve an episode id for `#/episode/:id` — the direct fix for "Open
   episode" leaving 4a (mini-player's `openLink`, player/client.js). No new
   fetch, no new data file; four sources, freshest first:

     1. `state.itemIndex` — populated by fullPool(), show pages, search.
     2. `storedEpisode()` — a star's snapshot, or the one Up Next / a play /
        a picked link wrote (theme A, audit 2026-09-22).
     3. THE PLAYER'S OWN POINTER. "Open episode" on the restored now-playing bar
        said "Episode not found" about the episode that was playing, whenever
        the app launched on any route but Home: the pointer's snapshot only
        reached `itemIndex` as a side effect of Home rendering its Jump back in
        card. The pointer carries everything this page needs, so it is a
        source in its own right rather than a thing Home happens to seed. */
function resolveEpisode(id) {
  const pool = hydrationPool(); // populate/reuse itemIndex — never throws (#276)
  return pool[id] || storedEpisode(id) || playerPointerEpisode(id);
}

/** The player's durable now-playing pointer, when it is `id` — seeded into the
    item index exactly as lastEpisodeCard() seeds it, or null. Never throws: the
    player module may be absent (a stale service-worker cache) or predate it. */
function playerPointerEpisode(id) {
  try {
    const r = window.ForayPlayer?.lastEpisodeCard?.();
    if (!r || !r.id || (id && r.id !== id)) return null;
    /* Never over a richer entry already in the index (a pool row, a show
       page's full row with its description). */
    return state.itemIndex[r.id] || snapshot(r.id, r);
  } catch (_) {
    return null;
  }
}

/* A1.8: "More from this show" — display-only, no new data (the join already
   exists as episodesForShow, docs/requirements audit note). item.show is only
   ever a name string here (discover.json/itemIndex never carry show_id — the
   same gap showNameLink already works around), so this resolves the show
   record the same way showNameLink does (showIdForShowName -> showById) before
   reusing episodesForShow/epRow exactly as renderShow does. Independent of
   Stage 3b ingestion: works fine on today's curated pool and just grows once
   that lands, per the card's own framing. Renders nothing (not an empty
   section) when there is no show match or no other episodes — absence is a
   real state, matching every other join on this page. */
function moreFromShow(item) {
  const showId = showIdForShowName(item.show);
  const show = showId ? showById(showId) : null;
  if (!show) return "";
  const others = episodesForShow(show).filter(e => e.id !== item.id);
  if (!others.length) return "";
  const ctx = "episode-more-" + item.id;
  /* The Show screen's EpisodeRow (ui/show.js showEpisodeRowHtml: art 72, title, Play 44, meta, a two-line why in a 96px
     Raised row), latest first. The wrapper carries data-show-episodes so the show page's own play sync and bindings
     (bindShowPlay, showSyncPlay) repaint these rows too. Without ui/show.js (a test stub) today's epRow stands in. */
  const rows = typeof showEpisodeRowHtml === "function"
    ? showRowsLatestFirst(others).slice(0, 8).map(e => showEpisodeRowHtml(e, ctx)).join("")
    : others.slice(0, 8).map((e, i) => epRow(e, i, ctx, -1)).join("");
  return `<section class="ep-more">
    <h2>More from this show</h2>
    <div class="ep-more-rows" data-show-episodes>${rows}</div>
  </section>`;
}

/* A1.5: chapter markers, requirement-doc "these are two different use cases
   and need two different solutions" (Joey's Q5 answer). Deliberately its own
   <section>, never touching player/segment-strip.js's markup or classes —
   a chapter is the PUBLISHER's own structure for one episode; a foray
   segment is 4a's own cross-episode stitch. Conflating the two would make
   an episode's own chapter list look like it was 4a's editorial work, which
   it explicitly is not. Renders nothing (not an empty section) when there
   are no chapters — matches every other absence-is-a-real-state section on
   this page (moreFromShow, similarShowsSection, showForaysHtml). */
function fmtChapterTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0)); // floored like the player's clocks (arch-drift-10)
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/* ---------- episode descriptions that are worth reading (founder, 2026-09-17)

   "For episodes that have good descriptions with links and timestamps for
   chapters through the conversation, the formatting in 4a needs to improve
   dramatically, such that it's readable and I can click the links, including to
   time stamps within the episode (those then result in jumping to that
   timestamp in 4a)."

   The description arrived as one `esc()`'d blob inside a single <p>. Every URL
   a publisher wrote was dead text, every timestamp was dead text, and a long
   sponsor URL made the whole page pan sideways (the other half of today's
   fix). `white-space: pre-line` was carrying the entire burden of "formatting".

   WHAT THIS DOES NOT DO, and why. It does not render publisher HTML. The feed's
   `description_html` is parsed and stored by `backend/src/catalog/
   ingestShowFeed.ts` and read straight back out by `rowToEpisode` — and then
   DROPPED at the API boundary: `api/shows/[show_id]/episodes.ts` and
   `api/episodes/search.ts` both return `description_text` only, so the markup
   has never reached a client. Carrying it is a change to `api/**`, which is
   unlisted in `tools/ci/path-policy.mjs` and therefore makes a whole PR wait on
   a human merge click (CLAUDE.md), so it is its own PR and its own sanitizer.
   Everything here works on the plain text we already ship, today.

   SO THIS IS A LINKIFIER, and it is deliberately a small one: escape
   everything, then promote two shapes — an http(s) URL, and a timestamp — into
   controls. Nothing else in the text can become markup, because the only HTML
   in the output is the HTML this function writes. */

/** `1:02:45` / `12:34` / `4:07` -> seconds. Null for anything that is not a
    timestamp, INCLUDING an out-of-range minute or second, which is how a score
    ("a 65:40 split") or a ratio stays plain text. */
function parseTimestampSeconds(raw) {
  const m = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)$/.exec(String(raw).trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/* URL first in the alternation so a timestamp inside a URL's path or query is
   never lifted out of it. Trailing `.,;:)]}` are excluded from the match rather
   than trimmed afterwards — a URL at the end of a sentence is the common case
   and the full stop belongs to the sentence. */
const DESC_TOKEN_RE = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:)\]}])|(\b(?:\d{1,3}:)?\d{1,2}:[0-5]\d\b)/g;

/**
 * The description as safe HTML: text escaped, URLs linked, timestamps turned
 * into seek controls.
 *
 * `durationSec` (optional) is the honesty guard. A timestamp past the end of
 * the episode is not a chapter mark — it is a phone number, a date, a score, or
 * a timestamp for a DIFFERENT episode the publisher pasted in — and a control
 * that seeks somewhere the audio does not reach is worse than plain text. When
 * the duration is unknown nothing is filtered, because refusing every timestamp
 * on an episode whose length we failed to record would be the wrong default.
 */
function episodeDescriptionHtml(text, durationSec = null) {
  const src = String(text ?? "");
  if (!src) return "";
  /* A LINE THAT STARTS WITH A TIMESTAMP IS A CHAPTER ROW (audit round 2,
     touch-10). Publishers write chapter lists one stamp per line, and an
     inline stamp's hit box can only grow into the leading it has (~2px each
     way at this line height) before it overlaps the stamp on the next line —
     where the LATER button wins the hit test, so a tap on the bottom of one
     chapter's stamp seeked to the next. A stamp-led line is the chapter list's
     own shape, so it renders as the chapter list's own control: the whole line
     is one 44px `.ep-chapter-row` button. Only when nothing else on the line
     is a control of its own (a URL or a second stamp) — a link inside a button
     is invalid, and two stamps on one line are not a chapter. The newline
     after a row is dropped: the row is a block, and under `pre-line` a newline
     opening the next run would paint an empty line under every chapter.
     Every other line goes through the ONE tokeniser below
     (`episodeDescriptionTokens`), which the Now Playing sheet shares. */
  return episodeNotesTokens(src, durationSec).map(descTokenHtml).join("");
}

/** THE NOTES AS LINE-AWARE TOKENS — the chapter-row promotion above AND the
    inline tokens, in one pass, for both surfaces (audit round 2 review of
    touch-10). The promotion used to live only in the HTML renderer, so the
    Now Playing sheet (which reads tokens) drew every chapter-list stamp as a
    ~21px inline `.ep-ts` — the target touch-10 cut on the promise that a
    stamp-led line is a 44px `.ep-chapter-row`. Now the sheet gets the row too.

      { kind: "chapter", secs, stamp, title, label }   a whole stamp-led line
      …and every kind `episodeDescriptionTokens` emits, with a "\n" text token
      between lines (none after a chapter row: the row is a block). */
function episodeNotesTokens(text, durationSec = null) {
  const src = String(text ?? "");
  if (!src) return [];
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const chapter = descChapterToken(lines[i], durationSec);
    if (chapter) { out.push(chapter); continue; }
    out.push(...episodeDescriptionTokens(lines[i], durationSec));
    if (i < lines.length - 1) out.push({ kind: "text", text: "\n" });
  }
  return out;
}

/* `01:23 Title`, `(1:02:45) Title`, `- 12:34 - Title`: an optional bullet or
   bracket, the stamp, an optional closing bracket and separator, the rest. */
const DESC_STAMP_LINE_RE = /^[ \t]*(?:[-–—•*·][ \t]*)?[([]?((?:\d{1,3}:)?\d{1,2}:[0-5]\d)\b[)\]]?[ \t]*(?:[-–—:|][ \t]*)?(.*?)\r?$/;

function descChapterToken(line, durationSec) {
  const m = DESC_STAMP_LINE_RE.exec(line);
  if (!m) return null;
  const [, stamp, rest] = m;
  const secs = parseTimestampSeconds(stamp);
  if (secs === null || (durationSec !== null && secs > durationSec)) return null;
  DESC_TOKEN_RE.lastIndex = 0;
  if (DESC_TOKEN_RE.test(rest)) return null;
  const title = rest.trim();
  return { kind: "chapter", secs, stamp, title, label: `Play from ${stamp}${title ? `, ${title}` : ""}` };
}

/** One token as safe HTML: a chapter row, a link, an inline seek stamp, or
    escaped prose. */
function descTokenHtml(t) {
  if (t.kind === "chapter") {
    return `<button type="button" class="ep-chapter-row" data-ts="${esc(String(t.secs))}" aria-label="${esc(t.label)}"><span class="ep-chapter-time">${esc(t.stamp)}</span><span class="ep-chapter-title">${esc(t.title)}</span></button>`;
  }
  return descInlineTokenHtml(t);
}

/** One inline token as safe HTML — URLs linked, in-range timestamps as inline
    seek buttons, the rest escaped. */
function descInlineTokenHtml(t) {
  if (t.kind === "link") {
    /* `rel="noopener noreferrer"` because these point off our origin. The
       token's href is already through `safeUrl`; it goes through again here
       because "every interpolated href passes through safeUrl" is a rule
       test/app-security.test.js reads off this line, not off the tokeniser. */
    return `<a href="${esc(safeUrl(t.href))}" target="_blank" rel="noopener noreferrer">${esc(t.text)}</a>`;
  }
  if (t.kind === "stamp") {
    return `<button type="button" class="ep-ts" data-ts="${esc(String(t.secs))}" aria-label="${esc(t.label)}">${esc(t.text)}</button>`;
  }
  return esc(t.text);
}

/**
 * The description as TOKENS — prose, links and seek stamps — the one pass that
 * recognises a URL or a timestamp in publisher text. `episodeDescriptionHtml`
 * above renders them for the episode page; the Now Playing sheet renders the
 * same tokens as DOM nodes (client.js `paintNotes`, through `window.ForayNotes`
 * below), because that file builds nothing from an HTML string. Audit round 2,
 * p-switcher-2: the sheet used to paint the same text dead, so the founder's
 * 2026-09-17 ruling held on one of the two surfaces that show the notes.
 *
 *   { kind: "text",  text }
 *   { kind: "link",  text, href }          href already through `safeUrl`
 *   { kind: "stamp", text, secs, label }   label is the control's accessible name
 *
 * `safeUrl` returns "#" for any scheme but http(s), so a script-bearing or
 * inline-data URL cannot become a live href even though the regex would not
 * have matched one in the first place. Belt and braces, and it is the same
 * helper every other href in this file goes through. (The scheme names are
 * spelled around rather than written out: the `no ... URL is constructed
 * anywhere in the source` invariant in test/app-security.test.js greps this
 * file for them, comments included, and it is a better rule than any one
 * comment's convenience.)
 */
function episodeDescriptionTokens(text, durationSec = null) {
  const src = String(text ?? "");
  const out = [];
  if (!src) return out;
  let last = 0;
  DESC_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = DESC_TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    let [whole, url, stamp] = m;
    if (url) {
      /* BALANCED PARENTHESES STAY IN THE URL (audit round 3, app-2-8; the GFM
         autolink rule). The pattern leaves a trailing `)` to the sentence, which
         cut `…/wiki/Mercury_(planet)` to `…/wiki/Mercury_(planet`. A `)` right
         after the match is taken back while the URL has an unclosed `(`. */
      const opens = (u) => u.split("(").length - 1;
      const closes = (u) => u.split(")").length - 1;
      while (src[m.index + url.length] === ")" && opens(url) > closes(url)) url += ")";
      whole = url;
      DESC_TOKEN_RE.lastIndex = m.index + url.length;
      out.push({ kind: "link", text: url, href: safeUrl(url) });
    } else {
      const secs = parseTimestampSeconds(stamp);
      const inRange = secs !== null && (durationSec === null || secs <= durationSec);
      out.push(inRange
        ? { kind: "stamp", text: stamp, secs, label: `Play from ${stamp}` }
        : { kind: "text", text: whole });
    }
    last = m.index + whole.length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

if (typeof window !== "undefined") {
  window.ForayNotes = { tokens: episodeDescriptionTokens, lines: episodeNotesTokens };
}

/* FOUR LINES BY DEFAULT (founder, 2026-09-18, kept; the disclosure it ruled on is what Afterglow overturns).

   "When I'm listening to a podcast with a lot of notes the episode page is just notes; the default should be I
   mostly see album artwork and need to intentionally scroll somewhere to see notes."

   That still holds: the notes open on four lines of --t-body (BUILD-NOTES 4.7: "4-line clamp + More quiet
   button"), so the artwork, the actions and "more from this show" are never pushed off the first screens by
   the least important thing on the page. What changed is the control. The page used to hide the notes in a
   native <details> ("Episode notes" and a chevron); a clamp shows the start of them, which is the part that
   tells a listener whether to open the rest. The ruling that fell is test/episode-description-links.test.js's
   "the description renders inside a closed <details>".

   The clamp is CSS (`.is-clamped`, ui/episode.css); the "More" button is only shown when the text really runs
   past four lines (bindEpisodeNotes measures once the page is laid out), and a focus that lands on a control
   inside the clamped text (a timestamp reached by keyboard) opens it, so nothing focusable is ever clipped.
   The text goes through episodeDescriptionHtml (esc() for every character, safeUrl() for every href, timestamps
   as Chips that seek) exactly as before. Chapters stay OUT of this and remain visible: they are navigation,
   not prose, and burying the one part of the notes that does something would be the wrong half to hide. */
function episodeDescriptionSectionHtml(item) {
  if (!item.description) return "";
  const durationSec = itemDurationSec(item, { upperBound: true });
  return `<section class="ep-description">
      <h2>Show notes</h2>
      <p class="ep-description-text is-clamped" id="ep-notes-text">${episodeDescriptionHtml(item.description, durationSec)}</p>
      <button type="button" class="ag-btn ag-btn-quiet ep-notes-more" aria-expanded="false" aria-controls="ep-notes-text">More</button>
    </section>`;
}

function episodeChaptersHtml(item) {
  const chapters = Array.isArray(item.chapters) ? item.chapters : [];
  if (!chapters.length) return "";
  /* Each row is a seek control now, for the same reason the timestamps in the
     description are: a chapter list you cannot jump from is a table of contents
     with no page numbers. `data-ts` is the one contract both share, so
     `bindEpisodeSeeks` binds them in a single pass. */
  return `<section class="ep-chapters">
    <h2>Chapters</h2>
    <ol class="ep-chapters-list">
      ${chapters.map(c => {
        /* `== null` FIRST, because `Number(null)` is 0 and `Number("")` is 0 —
           a chapter with no recorded start would otherwise render as a control
           that seeks confidently to the beginning. Caught by a test. */
        const secs = c.start_time_seconds == null ? NaN : Number(c.start_time_seconds);
        const time = esc(fmtChapterTime(c.start_time_seconds));
        const title = esc(c.title || "");
        return Number.isFinite(secs)
          ? `<li><button type="button" class="ep-chapter-row" data-ts="${esc(String(secs))}"><span class="ep-chapter-time">${time}</span><span class="ep-chapter-title">${title}</span></button></li>`
          : `<li><span class="ep-chapter-time">${time}</span><span class="ep-chapter-title">${title}</span></li>`;
      }).join("")}
    </ol>
  </section>`;
}

/**
 * One delegated listener for every `data-ts` control on the page — the
 * description's timestamps and the chapter rows alike.
 *
 * PLAY THEN SEEK, in that order, and only ever on this episode. `ForayPlayer`
 * starts an item at 0 (`manager.play(0)`), so a jump is "make this the current
 * item if it is not already, then move the clock". When it IS already current,
 * the seek alone is the whole action — restarting would throw away the thing
 * the listener is in the middle of.
 */
function bindEpisodeSeeks(scope, item) {
  /* PER ELEMENT, with the `_bound` guard — `bindPlay`/`bindStars`'s idiom, and
     not a delegated listener on `scope`.
     The first draft delegated from `#view`, which is the one node on this page
     that OUTLIVES the render: `renderEpisode` replaces its innerHTML but never
     the element, so every visit to an episode page added another listener, each
     closing over its own `item`. Visit three episodes and one tap on a
     timestamp runs three handlers, two of which start playing an episode the
     listener is no longer looking at. Binding to the buttons themselves means
     the listeners die with the markup they belong to. */
  scope.querySelectorAll("[data-ts]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const secs = Number(btn.dataset.ts);
      if (!Number.isFinite(secs)) return;
      try {
        if (!window.ForayPlayer || !window.ForayPlayer.canPlay(item)) return;
        /* Play only when this is not already the current episode — a restart
           would throw away the thing the listener is in the middle of. Then
           seek, always: that is the whole of what the control promises. */
        /* CURRENT, not playing (audit round 3, app-2-4): a paused current
           episode is seeked, not restarted — and resumed, because a tap on a
           stamp asks to hear it. */
        const current = typeof window.ForayPlayer.isCurrent === "function"
          ? window.ForayPlayer.isCurrent(item.id)
          : window.ForayPlayer.isPlaying(item.id);
        /* CURRENT BUT NOTHING LOADED IS A START (round-3 review, L2): a bar
           restored after a relaunch, or an episode that has ended, is current
           and not playing, and the toggle below started it outside
           startEpisodePlay, so no play_started, no History, and the old chain
           and engine plan stayed. Only a loaded (paused) episode is resumed. */
        const loaded = current && (typeof window.ForayPlayer.isLoadedCurrent === "function"
          ? window.ForayPlayer.isLoadedCurrent(item.id)
          : true);
        if (!current || !loaded) {
          /* THE ONE START PATH (audit round 3, app-2-4). This called
             ForayPlayer.play() directly, so an episode started from a chapter
             or a timestamp never reached History, never logged play_started
             and left the previous list's ⏮/⏭ chain in place. startEpisodePlay
             does all of that, reports a refused start (not a superseded one),
             and carries the stamp as the START offset (races-1: the load begins
             at the timestamp rather than seeking after). A stamp starts this
             episode alone: no list, no playlist context. */
          await startEpisodePlay(item.id, item, { ctx: null, list: [], startOffset: secs });
          return;
        }
        await window.ForayPlayer.seekTo(secs);
        if (!window.ForayPlayer.isPlaying(item.id)) await window.ForayPlayer.togglePlayback?.();
      } catch (err) {
        /* A seek that cannot happen is not a reason to break the page — the
           same rule the rest of this file's playback bindings follow. But a
           PLAY that threw says so (review 2026-09-23, persona #4 on a sibling
           control): the same report bindPlay makes, not a tap that does
           nothing and says nothing. */
        console.warn("[4a] timestamp play failed", err);
        try { window.ForayPlayer?.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
        noteTapFailure("start", err);
      }
    });
  });
}

/* ---------- the Afterglow page: actions, notes, title fit, the Up Next flight ----------

   The three controls are this page's own (`data-ep-play`, `data-ep-save`, `data-ep-upnext`), not the legacy
   `.play-btn` / `.star` / `.up-next` glyph buttons: those are repainted from TEXT by app.js's toggles
   (setToggleLabel) and the player's syncCardButtons (paintControl), both of which write `textContent` and would
   wipe the sprite glyph inside an icon button. Same actions underneath (startEpisodePlay, toggleStar,
   addToQueue, playNextInQueue); the page repaints its own three from the stores (episodeSyncControls), so a Save
   made from the Now Playing sheet, or an episode that ends, shows here within a second. */

/** Reduce Motion asked for: the flight and the badge's bump are skipped and the count changes in place. */
function episodeReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_) { return false; }
}

function episodePlayLabel(title, playing) {
  return `${playing ? "Pause" : "Play"} ${title || "this episode"}`;
}

/** The icon-only tools, as markup. Save is the bookmark (Regular, Fill when saved); Add to Up Next is the queue glyph,
    the check-circle Fill once it is in the list (a state change is a fill, never only a colour). */
function episodeToolHtml(kind, id, on) {
  const save = kind === "save";
  const label = save ? (on ? "Saved" : "Save episode") : (on ? "In Up Next" : "Add to Up Next");
  const icon = save ? (on ? "bookmark-fill" : "bookmark") : (on ? "check-circle-fill" : "queue");
  return `<button type="button" class="ag-btn ag-btn-icon ep-tool${on ? " is-on" : ""}" data-ep-${save ? "save" : "upnext"}="${esc(id)}" aria-label="${esc(label)}">${agIcon(icon, 24)}</button>`;
}

function episodeActionsHtml(item) {
  const id = item.id;
  const playable = !!item.audio_url;
  /* NO UP NEXT FOR WHAT addToQueue REFUSES: the same definition upNextBtn() draws by (liveEpisode). */
  const queueable = isQueued(id) || playable || !!liveEpisode(id);
  return `<div class="ep-actions">
        ${playable
          ? `<button type="button" class="ag-btn ag-btn-primary ep-play" data-ep-play="${esc(id)}" data-state="idle" aria-label="${esc(episodePlayLabel(item.title, false))}">${agIcon("play", 24)}<span>Play</span></button>`
          : notPlayableNote()}
        ${episodeToolHtml("save", id, isSaved(id))}
        ${queueable ? episodeToolHtml("upnext", id, isQueued(id)) : ""}
      </div>
      ${playable ? `<button type="button" class="ag-btn ag-btn-quiet ep-next" data-ep-playnext="${esc(id)}">Play next</button>` : ""}`;
}

/** Paint the three controls from the player and the stores. Compared first, written only on a change. */
function episodeSyncControls() {
  try { episodePaintControls(); } catch (_) { /* a repaint that cannot run is not a reason to fail the tap that asked for it */ }
}
function episodePaintControls() {
  const page = document.querySelector(".ag.ep");
  if (!page || typeof page.getAttribute !== "function") return;   // a stub document has no real nodes
  const play = page.querySelector("[data-ep-play]");
  if (play) {
    let on = false;
    try { on = !!(window.ForayPlayer && window.ForayPlayer.isPlaying?.(play.dataset.epPlay)); } catch (_) { on = false; }
    const want = on ? "playing" : "idle";
    if (play.dataset.state !== want) {
      play.dataset.state = want;
      play.setAttribute("aria-label", episodePlayLabel(page.dataset.title, on));
      play.innerHTML = `${agIcon(on ? "pause" : "play", 24)}<span>${on ? "Pause" : "Play"}</span>`;
    }
  }
  for (const [attr, kind, isOn] of [["data-ep-save", "save", isSaved], ["data-ep-upnext", "upnext", isQueued]]) {
    const btn = page.querySelector(`[${attr}]`);
    if (!btn) continue;
    const id = btn.getAttribute(attr);
    const on = !!isOn(id);
    if (btn.classList.contains("is-on") === on) continue;
    /* REPLACED, NOT MUTATED. Under Reduce Motion the tokens turn every colour change into a 200ms crossfade, and a tool
       whose colour flips (Ember once saved or queued) would run one: the state change is the new button, drawn in its final
       state, with the focus the old one held. The binding is by `_bound`, so only the new node is wired. */
    const fresh = document.createElement("div");
    fresh.innerHTML = episodeToolHtml(kind, id, on);
    const next = fresh.firstElementChild;
    const held = document.activeElement === btn;
    btn.replaceWith(next);
    if (page._epItem) bindEpisodeActions(page, page._epItem);
    if (held && typeof next.focus === "function") next.focus();
  }
}

let episodePollTimer = null;
function episodeStartPoll() {
  if (episodePollTimer || typeof setInterval !== "function") return;
  episodePollTimer = setInterval(() => {
    if (!document.querySelector(".ag.ep")) { clearInterval(episodePollTimer); episodePollTimer = null; return; }
    episodeSyncControls();
  }, 1000);
}

/* THE LIBRARY TAB'S COUNT (BUILD-NOTES "Up Next add"). The Library tab carries the number of episodes in Up Next as a
   small Ember badge, on every page: renderTabBar() and saveQueueIds() (the one writer of cp_queue) call this, and the
   tab bar rewrites its anchors' contents when the glyph changes, so the badge is re-drawn from the list each time and is
   never state of its own. While the Up Next flight is in the air the count is held, so it changes when the art lands. */
let libraryBadgeHold = false;
function syncLibraryBadge() {
  if (libraryBadgeHold) return;
  /* BEST-EFFORT CHROME: this runs inside saveQueueIds() (the one writer of cp_queue) and renderTabBar(), so a throw here
     would break an Up Next write for the sake of a number. A stub document, or a tab bar not built yet, is not an error. */
  try {
    const tab = document.querySelector('#tab-bar .tab-btn[data-tab-key="library"]');
    if (!tab || typeof tab.getAttribute !== "function" || typeof tab.querySelector !== "function") return;
    let n = 0;
    try { n = queueIds().length; } catch (_) { n = 0; }
    let countBadge = tab.querySelector(".tab-count");
    if (n <= 0) {
      if (countBadge) countBadge.remove();
      if (tab.getAttribute("aria-label") !== null) tab.removeAttribute("aria-label");
      return;
    }
    const shown = n > 9 ? "9+" : String(n);
    if (!countBadge) {
      countBadge = document.createElement("span");
      countBadge.className = "tab-count";
      countBadge.setAttribute("aria-hidden", "true");
      tab.appendChild(countBadge);
    }
    if (countBadge.textContent !== shown) countBadge.textContent = shown;
    const name = `Library, ${n} in Up Next`;
    if (tab.getAttribute("aria-label") !== name) tab.setAttribute("aria-label", name);
  } catch (_) { /* the number is decoration; the list is the truth */ }
}

/** Up Next add: the artwork flies to the Library tab's icon and the badge bumps 1 to 1.3 to 1 (420ms, --e-spring).
    Under Reduce Motion, with no artwork or no tab to fly to, the count just changes. `add` performs the write. */
function episodeUpNextAdd(add) {
  const art = document.querySelector(".ag.ep .ep-hero .ag-art");
  const tab = document.querySelector('#tab-bar .tab-btn[data-tab-key="library"]');
  const target = tab && typeof tab.querySelector === "function" ? (tab.querySelector("svg") || tab) : null;
  let layer = null;
  let finished = false;
  const land = (flew) => {
    if (finished) return;
    finished = true;
    libraryBadgeHold = false;
    try { if (layer) layer.remove(); } catch (_) { /* gone */ }
    syncLibraryBadge();
    if (!flew) return;
    try {
      const badge = document.querySelector('#tab-bar .tab-btn[data-tab-key="library"] .tab-count');
      if (badge && typeof badge.animate === "function") badge.animate([{ transform: "scale(1)" }, { transform: "scale(1.3)" }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    } catch (_) { /* a bump that cannot run is not a reason to fail the add */ }
  };
  const canFly = !episodeReducedMotion() && art && target && typeof art.animate === "function" && typeof art.getBoundingClientRect === "function"
    && typeof document.body.appendChild === "function";
  if (!canFly) { add(); land(false); return; }
  let from = null, to = null;
  try { from = art.getBoundingClientRect(); to = target.getBoundingClientRect(); } catch (_) { from = null; }
  if (!from || !to || !from.width || !to.width) { add(); land(false); return; }
  libraryBadgeHold = true;
  add();
  try {
    layer = document.createElement("div");
    layer.className = "ag ep-flight-layer";
    layer.setAttribute("aria-hidden", "true");
    const clone = art.cloneNode(true);
    clone.removeAttribute("role");
    clone.removeAttribute("aria-label");
    clone.style.setProperty("left", `${from.left}px`);
    clone.style.setProperty("top", `${from.top}px`);
    clone.style.setProperty("width", `${from.width}px`);
    clone.style.setProperty("height", `${from.height}px`);
    layer.appendChild(clone);
    document.body.appendChild(layer);
    const ease = (getComputedStyle(document.documentElement).getPropertyValue("--e-spring") || "").trim() || "cubic-bezier(0.2, 0.9, 0.2, 1.05)";
    const k = to.width / from.width;
    const anim = clone.animate(
      [{ transform: "none", opacity: 1 }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${k})`, opacity: 0.6 }],
      { duration: 420, easing: ease, fill: "forwards" },
    );
    anim.onfinish = () => land(true);
    anim.oncancel = () => land(false);
    setTimeout(() => land(true), 700);   // a flight that never reports back still lands the count
  } catch (_) {
    land(false);
  }
}

function bindEpisodeActions(scope, item) {
  const id = item.id;
  const play = scope.querySelector("[data-ep-play]");
  if (play && !play._bound) {
    play._bound = true;
    play.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const player = window.ForayPlayer;
      if (!player) return;
      /* A BUTTON SHOWING "Pause" MUST PAUSE (the rule bindPlay learned, founder 2026-09-22): the page delegates to the
         player whenever it is showing the player's own item, and only starts something new when it is not. */
      if (player.isCurrent?.(id)) { await player.togglePlayback(); episodeSyncControls(); return; }
      const live = liveEpisode(id) || state.itemIndex[id] || episode(id) || item;
      await startEpisodePlay(id, live, { ctx: null, list: [{ id, ctx: null }] });
      episodeSyncControls();
    });
  }
  const save = scope.querySelector("[data-ep-save]");
  if (save && !save._bound) {
    save._bound = true;
    save.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(id);
      episodeSyncControls();
    });
  }
  const queue = scope.querySelector("[data-ep-upnext]");
  if (queue && !queue._bound) {
    queue._bound = true;
    queue.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      /* Tapping again does not remove (plan 1 Q3: the control adds; removal lives on #/queue). It re-confirms, painted
         from the QUEUE and not from the tap: addToQueue can refuse, and a flight over an unchanged list is a false success. */
      if (isQueued(id)) { addToQueue(id); episodeSyncControls(); return; }
      episodeUpNextAdd(() => addToQueue(id));
      episodeSyncControls();
    });
  }
  const next = scope.querySelector("[data-ep-playnext]");
  if (next && !next._bound) {
    next._bound = true;
    next.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (playNextInQueue(id)) announce("Plays next.");
      episodeSyncControls();
    });
  }
}

/** The notes' "More" / "Less". Shown only when the text really runs past four lines; a focus inside the clamped text
    opens it (a timestamp reached by keyboard is never clipped). */
function bindEpisodeNotes(scope) {
  const section = scope.querySelector(".ep-description");
  const text = section ? section.querySelector(".ep-description-text") : null;
  const more = section ? section.querySelector(".ep-notes-more") : null;
  if (!text || !more || section._bound) return;
  section._bound = true;
  const open = (on) => {
    text.classList.toggle("is-clamped", !on);
    more.setAttribute("aria-expanded", on ? "true" : "false");
    setControlLabel(more, on ? "Less" : "More", null);
  };
  more.addEventListener("click", () => open(more.getAttribute("aria-expanded") !== "true"));
  text.addEventListener("focusin", () => { if (more.getAttribute("aria-expanded") !== "true") open(true); });
  /* Measured once the page is laid out: text that fits four lines has nothing to open. */
  const measure = () => {
    if (!section.isConnected || more.getAttribute("aria-expanded") === "true") return;
    if (!(text.clientHeight > 0)) return;
    const runs = text.scrollHeight > text.clientHeight + 1;
    more.hidden = !runs;
    text.classList.toggle("is-faded", runs);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure); else measure();
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure).catch(() => {}); } catch (_) { /* no font API */ }
}

/** THE TITLE, FITTED (the page's one measured thing). Two rules, both for "never cut mid-word":
    1. a word wider than the box (an unbreakable token) is not broken: the size steps down 1px at a time until the
       longest word fits, to a floor of 17px (--t-title is 26);
    2. a title longer than three lines ends on a WORD, not where the engine's line clamp would cut it ("acros...").
       Its words are wrapped, those past line three are clipped out of sight (still read by a screen reader, still in
       textContent, so headingName() and the tab title keep the whole title) and the last visible word takes the
       ellipsis. The clamp itself (.clamp3) is the first paint and the no-script fallback. */
function fitEpisodeTitle(el) {
  if (!el || !el.classList || typeof getComputedStyle !== "function") return;
  const titleText = typeof el.querySelector === "function" ? el.querySelector(".ep-title-text") : null;
  if (titleText) {
    if (titleText._full === undefined) titleText._full = titleText.textContent;
    if (titleText.querySelector(".ep-w")) titleText.textContent = titleText._full;
  }
  el.classList.remove("is-fit", "is-trimmed");
  if (el.style && typeof el.style.removeProperty === "function") el.style.removeProperty("--ep-title-size");
  if (!(el.clientWidth > 0)) return;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let size = parseFloat(getComputedStyle(el).fontSize) || 26;
  while (el.scrollWidth > el.clientWidth + 1 && size > 17) {
    size -= 1;
    el.classList.add("is-fit");
    el.style.setProperty("--ep-title-size", `${(size / root).toFixed(4)}rem`);
  }
  if (!titleText || !(el.scrollHeight > el.clientHeight + 1)) return;
  /* Longer than three lines: wrap the pieces the engine breaks lines at (a word, and each part of a hyphenated word after its
     hyphen), measure which line each lands on. A hyphenated word is not one piece: it wraps across lines on its own, and its
     first line would stand for all of them. */
  const words = titleText._full.split(/\s+/).filter(Boolean);
  titleText.innerHTML = words.map((w) => (w.match(/[^-]*-|[^-]+/g) || [w]).map((p) => `<span class="ep-w">${esc(p)}</span>`).join("")).join(" ");
  el.classList.add("is-trimmed");
  const spans = [...titleText.querySelectorAll(".ep-w")];
  const tops = [];
  const lineOf = (s) => {
    const y = s.offsetTop;
    let i = tops.findIndex((t) => Math.abs(t - y) < 3);
    if (i < 0) { tops.push(y); tops.sort((p, q) => p - q); i = tops.findIndex((t) => Math.abs(t - y) < 3); }
    return i;
  };
  spans.forEach(lineOf);
  const lines = spans.map(lineOf);
  let last = -1;
  spans.forEach((s, i) => { if (lines[i] < 3) last = i; else s.classList.add("ep-cut"); });
  /* The ellipsis rides on the last visible word: if "word..." no longer fits its line, that word goes too. */
  while (last > 0) {
    spans[last].classList.add("ep-last");
    if (lineOf(spans[last]) < 3) break;
    spans[last].classList.remove("ep-last");
    spans[last].classList.add("ep-cut");
    last -= 1;
  }
}

let episodeResizeHandler = null;
function watchEpisodeTitle(el) {
  if (typeof window.addEventListener !== "function") return;
  if (episodeResizeHandler) window.removeEventListener("resize", episodeResizeHandler);
  episodeResizeHandler = () => {
    if (!el.isConnected) { window.removeEventListener("resize", episodeResizeHandler); episodeResizeHandler = null; return; }
    fitEpisodeTitle(el);
  };
  window.addEventListener("resize", episodeResizeHandler);
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (el.isConnected) fitEpisodeTitle(el); }).catch(() => {}); } catch (_) { /* no font API */ }
}

/* `t` is a timestamp link's offset in whole seconds (#30, see episodeDeepLink),
   or null. It adds the "Play from" button and nothing else: the page never
   starts playback on its own. */
function renderEpisode(id, { t = null } = {}) {
  setBodyClass("view-page");
  const item = resolveEpisode(id);
  if (!item) {
    /* With a ‹ (audit 2026-09-22): this page is reached through stale links —
       a queued id whose snapshot is gone, a search row from an earlier session —
       and a sentence with no way back was a dead end. */
    $("#view").innerHTML = agNotFoundPage();
    return;
  }
  // populate itemIndex/poolIds so "more from this show" rows can play in-app;
  // never throws — no catalogue yet is a reason to skip that row's play button,
  // not to lose the whole page (same rule hydrationPool already follows).
  if (state.session && state.session.episodes) {
    try { fullPool(); } catch (_) { /* catalogue not really there yet */ }
  }
  const dateStr = fmtDate(item.release_date);
  /* The row's "Played" / "NN min left" follows the listener onto the page
     (audit round 2, honesty-5): it used to vanish on the way in. */
  const prog = rowProgress(item);
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  /* Every colour is worked out BEFORE the markup goes in (agGlowFor reads the scheme from the live styles; a read after the
     new nodes exist would style them once with the default Glow). The page opens already lit. */
  const glow = typeof agGlowFor === "function" ? agGlowFor(item.show) : "";
  $("#view").innerHTML = `
    <div class="page ep-page">
      <div class="ag ep is-fresh" data-title="${esc(item.title || "")}">
        <div class="room ep-room" aria-hidden="true"></div>
        <div class="ep-top"><a class="back ag-btn ag-btn-icon" href="#/" aria-label="Back">${agIcon("chevron-left", 24)}</a></div>
        <div class="ep-hero">${agArtwork({ name: item.show || item.title || "Artwork", src: item.artwork_url || "", size: 160, tone: "amber", state: "lit" })}</div>
        <h1 class="t-title clamp3 ep-title" data-page-heading><span class="ep-title-text">${esc(item.title)}</span>${explicitBadge(item.explicit)}</h1>
        <p class="t-caption ep-caption">${joinMeta(item.show ? showNameLink(item.show, item.show_id) : "", fmtDur(episodeMinutes(item)), esc(dateStr), progHtml)}</p>
        ${item.hook ? `<p class="t-why clamp3 ep-reason">${esc(item.hook)}</p>` : ""}
        ${playFromHtml(item, t)}
        ${episodeActionsHtml(item)}
        ${item.audio_url ? "" : `<p class="t-caption ep-note note">${esc(NOT_PLAYABLE_WHY)}</p>`}
        ${downloadControlHtml(item)}
        ${episodeDescriptionSectionHtml(item)}
        ${episodeChaptersHtml(item)}
        ${moreFromShow(item)}
      </div>
    </div>`;
  /* From here the page is the ambient one: the legacy top bar steps aside and the body paints bg0 behind the Room.
     setBodyClass() clears the class on the next route. The Dock lives on <body>, so it reads the ROOT's Glow: set it too. */
  try { document.body.classList.add("view-episode"); } catch (_) { /* a stub document */ }
  const page = $("#view .ag.ep");
  if (page) page._epItem = item;
  if (glow) {
    forayCssVar(page, "--glow", glow);
    try { forayCssVar(document.documentElement, "--glow", glow); } catch (_) { /* a stub document */ }
    forayCssVar($("#view .ep-hero .ag-art"), "--art-glow", glow);
  }
  const room = $("#view .ep-room");
  if (room && item.artwork_url) forayCssVar(room, "--room-art", forayRoomArtValue(item.artwork_url));
  bindPickLogging($("#view"));
  bindDownloads($("#view"));
  bindPlay($("#view"));
  /* The "more from this show" rows are the Show screen's: their Play is data-sh-play (bindPlay's data-play repaint would wipe
     the glyph), bound and repainted by ui/show.js. */
  if (typeof bindShowPlay === "function") { bindShowPlay($("#view .ep-more-rows")); if (typeof showStartPoll === "function") showStartPoll(); }
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindEpisodeActions($("#view"), item);
  bindEpisodeSeeks($("#view"), item);
  bindEpisodeNotes($("#view"));
  const title = $("#view .ep-title");
  fitEpisodeTitle(title);
  if (title) watchEpisodeTitle(title);
  episodeSyncControls();
  episodeStartPoll();
  syncLibraryBadge();
  /* Nothing animates until two frames after the first paint. */
  if (page) {
    const settle = () => { if (page.classList && typeof page.classList.remove === "function") page.classList.remove("is-fresh"); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(settle));
    else setTimeout(settle, 60);
  }
}
