/* ui/rows.js — Shared episode-row components: epRow, archived and family-hidden rows, parts notes.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* One playable row = one play control, never two — and there is no other
   kind of control any more (product rule, 2026-09-02, Joey: "we should be
   able to play all podcasts from the app. If we can't, let's fix that.").
   The prior "Listen in your podcast app ↗" link-out is gone entirely: it is
   not what a missing audio_url degrades to, it is deleted. An item with
   audio_url gets the in-app ▶ button. An item WITHOUT one (a genuine
   ingestion edge case — see notPlayableNote()) gets an honest inline note
   instead of a fake button or an external hop — never both, never neither
   silently. */
/** Where the listener is in one episode, as the PLAYER reads it (audit
    2026-09-22, persona #78: "nothing on any list tells me which episodes I
    already played, or how far in I am"). One reading — `episodeProgress` in
    player/episode-progress.js, the same one "Jump back in" uses — reached
    through the bridge, because app.js cannot import it and a second copy of
    "what counts as finished" here is how the two would come to disagree.
    `null` when the bridge has not arrived: a row then shows no mark, which
    claims nothing, rather than a guess. */
/** An episode's length in seconds: its `duration_sec` when it has one, else
    its minutes (docs/DECISIONS.md 2026-09-23, "One duration dialect"), else
    null. ONE helper for every reader (audit round 3, app-2-7): the notes'
    timestamp guard used the rounded minutes alone and turned real stamps in
    the last half-minute into dead text. `upperBound` is for a guard: minutes
    are ROUNDED, so the true length can be up to 29 s past `min * 60`. */
function itemDurationSec(item, { upperBound = false } = {}) {
  if (Number(item?.duration_sec) > 0) return Number(item.duration_sec);
  const min = Number(item?.duration_min);
  return min > 0 ? min * 60 + (upperBound ? 29 : 0) : null;
}

function rowProgress(item) {
  const bridge = window.ForayPlayer;
  if (!item?.id || typeof bridge?.episodeProgress !== "function") return null;
  const durSec = itemDurationSec(item);
  try { return bridge.episodeProgress(item.id, durSec); } catch (_) { return null; }
}

/** Has the listener opened this episode? `cp_history` OR a stored position.
    History alone decayed: it is a 200-entry ring, so a playlist's "N played"
    silently fell as the listener started other episodes (audit 2026-09-22) —
    positions are one row per episode and are never rotated out. */
function hasOpened(id, history) {
  if (!id) return false;
  if (history.has(id)) return true;
  const p = rowProgress({ id });
  return !!p && p.state !== "unplayed";
}

/* NUMBERS MEAN ORDER (audit round 2, visual-10). Every episode list wore the
   numbered circle Up Next uses — a show's episodes (newest as "1"), search
   results, Saved, History, "More from this show" — so a Saved list read as a
   playlist the listener never built. Apple numbers its queue and nothing
   else; here the number stays where the order IS the content: a playlist's
   detail page (ctx "playlist-…", "subject-…", "generated-…", where the
   highlighted number is "start here") and Up Next (upNextRow, which always
   numbers). styles.css indents the second tier only when a number is there. */
const ORDERED_ROW_CTX = /^(playlist|subject|generated)-/;
function orderedRowCtx(ctx) {
  return ORDERED_ROW_CTX.test(String(ctx || ""));
}

/* A FEW WORDS OF WHAT THE EPISODE IS ABOUT, under the title (founder,
   2026-10-03, with an Apple Podcasts screenshot: "episodes show a few lines of
   the description to give you a hint what it's about. This is super helpful").
   A list of titles alone — "#2560 - David Grusch" — tells a listener nothing;
   the publisher's first sentences do.

   The text is the publisher's own `description` when the row has it (feed
   episodes, via fullCatalogueRowToEpRowItem) and the row's `hook` otherwise:
   for a curated-pool episode that is 4a's one-liner, and for a stored snapshot
   it is the description's first 280 characters (EPISODE_SNAP_HOOK_MAX). Plain
   text in, plain text out — the notes' linkifier (episodeDescriptionHtml) is
   for the episode page, where a link has room to be tapped; in a row every
   pixel is already the title's tap target. Whitespace is collapsed so a
   chapter list does not arrive as one word per line, and styles.css clamps
   `.ep-hook` to two lines; the character cap here only keeps a 4,000-character
   description out of the DOM for every row of a long list. */
const EP_ROW_SNIPPET_MAX = 220;
function episodeRowSnippet(item) {
  const raw = typeof item?.description === "string" && item.description.trim()
    ? item.description
    : (typeof item?.hook === "string" ? item.hook : "");
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  /* A hook that only repeats the title says nothing twice. */
  if (text.toLowerCase() === String(item?.title || "").trim().toLowerCase()) return "";
  if (text.length <= EP_ROW_SNIPPET_MAX) return text;
  const cut = text.slice(0, EP_ROW_SNIPPET_MAX);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > EP_ROW_SNIPPET_MAX / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

function epRow(item, idx, ctx, nextIdx) {
  const inApp = playBtn(item, ctx);
  const unavailable = inApp ? "" : notPlayableNote();
  const dateStr = fmtDate(item.release_date);
  const prog = rowProgress(item);
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  const snippet = episodeRowSnippet(item);
  return `<div class="ep-row">
    ${orderedRowCtx(ctx) ? `<span class="q-num ${idx === nextIdx ? "next" : ""}">${idx + 1}</span>` : ""}
    <div class="info">
      <div class="t"><a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}</div>
      ${snippet ? `<p class="ep-hook">${esc(snippet)}</p>` : ""}
      <div class="s">${joinMeta(showNameLink(item.show, item.show_id), fmtDur(episodeMinutes(item)), esc(dateStr), progHtml)}</div>
    </div>
    ${inApp}${starBtn(item.id)}${upNextBtn(item.id, item)}${unavailable}
  </div>`;
}

/* The only thing that fills the control slot when an episode genuinely has
   no audio_url — never a link elsewhere. As of the Stage 3b RSS ingestion
   (kanban t_567b570f), this is a rare, named edge case, not a routine
   degrade: an episode never enters the catalogue without a real enclosure
   (ingestShowFeed.ts drops any item with none), so this only fires for the
   small number of pre-existing curated-pool items a one-off backfill could
   not resolve — a members-only/paywalled episode absent from the public RSS
   feed, or a video-only enclosure with no audio track (see
   tools/refresh/backfill-audio.mjs's UNRESOLVED report: 8 of 1855+27 items,
   0.43%, as of 2026-09-03). Plain text, no href, nothing to click — an
   honest dead end beats a button that does nothing and a link that leaves
   the app.

   No `title=` (audit round 2, a11y-11): a tooltip is unreachable on a phone
   and is not the control's name to a screen reader. The explanation lives as
   visible text on the episode page (NOT_PLAYABLE_WHY); a row has room for
   the chip alone, and "Not available to play" explains itself. */
function notPlayableNote() {
  return `<span class="not-playable">Not available to play</span>`;
}
const NOT_PLAYABLE_WHY = "4a could not get an audio file for this episode, so it cannot play here.";

/* A part the live pool no longer carries, rendered from what the playlist saved
   (#276). It keeps its number and its place, so the count above it stays true.
   It has no in-app audio to play (`audio_url` is deliberately not persisted
   because it moves) — as of 2026-09-03 there is no link-out fallback for
   that any more, product rule: 4a plays everything itself or says so
   honestly, it never sends a listener elsewhere. So an aged-out part gets
   the same notPlayableNote() plain-text state epRow gives a genuine
   ingestion edge case, not a link to another app.

   IT KEEPS ITS STAR, and that closes a loop rather than decorating the row:
   `cp_saved` holds whole snapshots, and hydratePlaylistParts reads it, so a
   starred part is one the migration can always name again. Starring an aged-out
   episode is the one action that makes it permanently recoverable. It works
   because renderPlaylistDetail seeds the snapshot into `state.itemIndex`, which
   toggleStar requires; an `unnamed` part has no snapshot to store, so it gets no
   star.

   NO "+ Up Next" (audit round 2, p-impatient-10). It had one from Stage 1, when
   the row still linked out to another app; #452 removed the link-out and the
   button stayed, offering to queue an episode the same row says cannot play.
   `addToQueue` refuses such an id anyway; not drawing the control is what keeps
   the row from promising it. */
function archivedRow(item, idx, ctx) {
  const named = !!item.title;
  const unavailable = named ? notPlayableNote() : "";
  const dateStr = named ? fmtDate(item.release_date) : "";
  return `<div class="ep-row gone">
    ${orderedRowCtx(ctx) ? `<span class="q-num">${idx + 1}</span>` : ""}
    <div class="info">
      <div class="t">${named ? `<a class="ep-title-link" href="#/episode/${esc(encodeURIComponent(item.id))}">${esc(item.title)}</a>${explicitBadge(item.explicit)}` : "Episode no longer in the catalogue"}</div>
      <div class="s">${named
        ? joinMeta(showNameLink(item.show, item.show_id), fmtDur(episodeMinutes(item)), esc(dateStr))
        : "Saved before 4a kept episode details"}</div>
    </div>
    ${named ? starBtn(item.id) : ""}${unavailable}
  </div>`;
}

/* A part Family Mode holds back (resolveParts, state "hidden"): its place and
   number, and what hides it — no title, no play, no star, as the pool itself
   shows nothing of it while Family Mode is on. */
function familyHiddenRow(idx, ctx) {
  return `<div class="ep-row gone">
    ${orderedRowCtx(ctx) ? `<span class="q-num">${idx + 1}</span>` : ""}
    <div class="info">
      <div class="t">Hidden by Family Mode</div>
      <div class="s">Turn Family Mode off to see and play it.</div>
    </div>
  </div>`;
}

/* The one honest sentence about a shortfall, or nothing. Says what happened and
   what can be done about it, and does not imply the listener did anything —
   ageing out of the pool is the app's doing, not theirs. */
function partsNote(rows) {
  const archived = rows.filter(r => r.state === "archived").length;
  const unnamed = rows.filter(r => r.state === "unnamed").length;
  if (!archived && !unnamed) return "";
  const parts = [];
  if (archived) {
    const one = archived === 1;
    parts.push(`${archived} episode${one ? " is" : "s are"} not available right now, so ${one ? "it" : "they"} cannot play — ${one ? "it stays listed" : "they stay listed"} so you can see where ${one ? "it fits" : "they fit"} in the playlist.`);
  }
  if (unnamed) {
    const one = unnamed === 1;
    /* EVERY plural agrees, verbs included. The first draft pluralised the noun and
       not the verb, so a listener with exactly one gap read "if the episode
       return" — and the note a reviewer reads is never the one that ships to them.
       It also no longer claims rebuilding REPLACES this playlist: buildPlaylist
       mints a new id and prepends a new playlist, leaving this one untouched. */
    parts.push(`${unnamed} episode${one ? " was" : "s were"} saved before 4a kept episode details and cannot be named yet — ${one ? "it" : "they"} will fill in if the episode${one ? " returns" : "s return"} to the catalogue, and building the same playlist again from the Playlists page gives you a fresh one from what 4a has today.`);
  }
  return `<p class="note">${esc(parts.join(" "))}</p>`;
}
