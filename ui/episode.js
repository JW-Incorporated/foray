/* ui/episode.js — Episode page (#/episode/<id>): description, chapters, timestamp seeks.
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
  const eps = episodesForShow(show).filter(e => e.id !== item.id).slice(0, 8);
  if (!eps.length) return "";
  const ctx = "episode-more-" + item.id;
  return `<section class="ep-more">
    <h3>More from this show</h3>
    ${eps.map((e, i) => epRow(e, i, ctx, -1)).join("")}
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

/* COLLAPSED BY DEFAULT (founder, 2026-09-18): "When I'm listening to a podcast
   with a lot of notes the episode page is just notes; the default should be I
   mostly see album artwork and need to intentionally scroll somewhere to see
   notes."

   Some publishers write two thousand words of links, sponsor copy and chapter
   lists into every episode. Rendered in full and in flow, that is the entire
   page: the artwork, the play button and "more from this show" all get pushed
   off the first screen by the least important thing on it.

   A NATIVE `<details>`, not a JS toggle. It needs no script (the page is
   `script-src 'self'` with no inline handlers), it is keyboard- and
   screen-reader-accessible for free, it holds its own state, and browser find-
   in-page can still open it. A hand-rolled class-swap would be more code and
   less accessible.

   NOT a line-clamp with a fade. A clamp still renders the whole block into the
   layout and still needs a control to undo it — it just makes the page a fixed
   amount of notes instead of an unbounded amount, and the founder's ask is
   about what the page IS by default, not about how tall the notes are.

   Chapters stay OUT of this and remain visible: they are navigation, not prose —
   short, scannable, and now individually tappable to seek. Burying the one part
   of the notes that does something would be the wrong half to hide. */
function episodeDescriptionSectionHtml(item) {
  if (!item.description) return "";
  const durationSec = itemDurationSec(item, { upperBound: true });
  return `<details class="ep-description">
      <summary class="ep-description-toggle">Episode notes</summary>
      <p class="ep-description-text">${episodeDescriptionHtml(item.description, durationSec)}</p>
    </details>`;
}

function episodeChaptersHtml(item) {
  const chapters = Array.isArray(item.chapters) ? item.chapters : [];
  if (!chapters.length) return "";
  /* Each row is a seek control now, for the same reason the timestamps in the
     description are: a chapter list you cannot jump from is a table of contents
     with no page numbers. `data-ts` is the one contract both share, so
     `bindEpisodeSeeks` binds them in a single pass. */
  return `<section class="ep-chapters">
    <h3>Chapters</h3>
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
    $("#view").innerHTML = statusPageHtml({ title: "Episode", note: "Episode not found." });
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
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div>
          <h2 class="fp-s-title">${esc(item.title)}${explicitBadge(item.explicit)}</h2>
          <p class="fp-s-show">${joinMeta(item.show ? showNameLink(item.show, item.show_id) : "", fmtDur(episodeMinutes(item)), esc(dateStr), progHtml)}</p>
        </div>
      </div>
      ${item.artwork_url ? `<img class="ep-art" src="${esc(safeUrl(item.artwork_url))}" alt="" decoding="async" width="600" height="600">` : ""}
      ${item.hook ? `<p class="fp-s-why">${esc(item.hook)}</p>` : ""}
      ${playFromHtml(item, t)}
      <div class="ep-actions">${item.audio_url ? playBtn(item) : notPlayableNote()}${starBtn(item.id)}${upNextBtn(item.id, item)}${item.audio_url ? `<button type="button" class="up-next playnext" data-playnext="${esc(item.id)}" aria-label="Play next">Play next</button>` : ""}</div>
      ${item.audio_url ? "" : `<p class="note">${esc(NOT_PLAYABLE_WHY)}</p>`}
      ${downloadControlHtml(item)}
      ${episodeDescriptionSectionHtml(item)}
      ${episodeChaptersHtml(item)}
      ${moreFromShow(item)}
    </div>`;
  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindDownloads($("#view"));
  bindPlay($("#view"));
  bindEpisodeSeeks($("#view"), item);
}
