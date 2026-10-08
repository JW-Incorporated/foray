/* ui/home.js — Today (Home, #/): the header, a hero lit by its artwork, Keep listening, Today’s picks,
   Playlists for you, Off your path. (Redesign 2026, ambient direction: see the TODAY block below.)
   A CLASSIC script like app.js, not a module: it shares app.js’s globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js’s boot (ui/boot.js) starts init(). */


/* ---------- views ---------- */

/* `currentContinue()` / `bannerHtml()` — the v1 Continue banner — lived here
   until visual pass 1 (2026-09-23). They had no caller since the U-11 cutover
   (renderHome always renders Home v2, whose "Jump back in" reads the player’s
   position store), and the only thing keeping them alive was two tests that
   called the function directly. Dead markup guarded by tests reads as
   coverage and is not; both went, with their CSS (`.banner`, `#banner-slot`).
   The same went for the subject card (`miniCard`, `subjectBlurb`, `startsWithLine`) and the
   Jump back in / Forays for you / Playlists / Suggested renderers when Today replaced them
   (2026-10-07): Today draws EpisodeRows, a StretchCard and PlaylistTiles instead. */

/* WHAT A FORAY IS, in one sentence, written ONCE (audit 2026-09-22, persona
   #18/#37/#45/#83). It was a literal inside the first-run sheet below — the only
   place in the product that said it — and that sheet is one-shot: "Skip for now"
   sets `cp_intro_dismissed` and nothing ever re-opens it. So the sentence is
   hoisted here and the Forays page subtitle reads it too, which gives the
   explanation a permanent home and makes skipping the sheet cost nothing. One
   constant, so the page and the sheet cannot drift into two descriptions.
   WORDED FROM THE MECHANISM (review 2026-09-23). It said we "clip" podcasts and
   "stitch them into one seamless listen", which docs/DECISIONS.md's 2026-08-11
   playback ruling rejects by name — it reads as the Stitcher/Luminary
   behaviour: "Copy must follow the mechanism: no user-facing language implying
   we produce a new audio file." A foray plays each moment from the show's own
   feed, in turn. test/listener-copy.test.js now fails on the old verbs.

   ONLY WHAT THE LISTED FORAYS DO (audit round 2, p-first-11 / p-foray-11). It
   promised "the best moment of each episode ... with a narrator between them"
   directly above the one Foray a newcomer can play, which has no narration and
   plays four moments from one episode. So it says "moments", and the narrator
   clause appears only while a Foray this listener can see actually carries
   narration. A function, not a constant, for that one clause; still ONE
   sentence, on the Forays page (the first-run sheet that shared it is retired, Redesign 2026). */
function forayAbout() {
  const narrated = forayCards().some(f => Array.isArray(f?.items) && f.items.some(i => i?.type === "narration"));
  return `One subject, heard across several podcasts: moments from their episodes, played in turn from each show's own feed${narrated ? ", with a narrator between them" : ""}.`;
}

/* HOME KEEPS ONE JOB: today’s picks. (Founder instruction, 2026-09-03, after the first TestFlight
   build: "the home page has so much clutter … Home should be the four cards.") The layout that
   instruction produced is gone with Today (Redesign 2026), the instruction is not: everything that
   used to compete for Home’s space has its own destination, and that is where it goes back to if
   it comes back:

     "Shows we vouch for" (vouchForHtml)   -> Shows      (#/shows)
     show search (#sh-form/#sh-results)     -> Shows      (#/shows)
     "Browse all shows" link                -> gone; Shows IS that page
     playlist builder (#pl-form)            -> Playlists  (#/playlists), then Create (#/create) since 2026-09-23
     foray list                             -> Forays     (#/forays)

   test/home-information-architecture.test.js asserts each of those in both directions — absent
   here, present there — so a future re-add fails CI rather than shipping. */
/* CUTOVER (U-11, founder override 2026-09-06): renderHome() used to branch
   on the retired `cp_ui_v2` flag and render the old four-card Home inline
   when it was off. That branch was unreachable and has been removed; the
   old implementation is preserved verbatim in
   archive/legacy-ui-2026-09/app.js.pre-cutover-2026-09-06 (see that
   directory's README to restore it). */
function renderHome() {
  return renderHomeV2();
}

/* ==================================================================== */
/* THE FLOOR (U-03, resolves gate #123), now on Today’s surfaces        */
/* (docs/ui-transition-plan.md, kanban t_6e8343b6)                       */
/* ==================================================================== */

/* "Shared with you" and "Build your own" are explicitly out of scope (D10/D8) — not stubbed, not
   commented out, simply never written.

   THE FLOOR (Wyatt’s decision, resolves #123): the picks reserve a slot for a STRETCH pick —
   something outside the listener’s top interest tier, on purpose, visibly labelled "Stretch" with a
   bridge line stating why it’s being suggested. A row reason ("Because you finish every Odd
   Lots") is allowed elsewhere but never on the stretch slot itself — that is the whole point of a
   stretch: it is not being justified by what the listener already likes.

   Today’s picks REUSE buildCards()’s existing tiering (top 60% of branches by average interest vs.
   the rest) rather than re-implementing it — a second copy is a second place for the two to quietly
   disagree about what a stretch pick is. "Off your path" draws from the same lower tier. The Foray
   hero applies the same helper independently, over Foray topics rather than episode branches,
   since Forays are a different pool with different membership; the floor’s stretch Foray is never
   "today’s foray". */

/** Generic stretch-floor picker (D1/#123), shared by both "for you"
    sections so there is exactly one implementation of "the floor" to keep
    correct. `branchFn` maps a candidate to its topic/subject id;
    `scoreFn` maps a candidate to its interest score. Reserves the FIRST
    slot for a candidate from a branch outside the top ~60% of branches by
    average score — recomputed exactly like buildCards()'s own
    `topBranchIds`, so the two thresholds cannot drift apart — falling
    back to ordinary top-ranked-first when there is no lower tier to draw
    from at all (e.g. every candidate shares one branch). Returns
    `{ picks, stretchIndex }`: `picks` is `take` candidates, in render
    order; `stretchIndex` is the position of the stretch pick within
    `picks`, or -1 if none could be found (never render a fake stretch
    label over an ordinary pick). */
function pickWithStretchFloor(candidates, { branchFn, scoreFn, take }) {
  if (!candidates.length) return { picks: [], stretchIndex: -1 };

  const byBranch = new Map();
  candidates.forEach(c => {
    const b = branchFn(c);
    if (!byBranch.has(b)) byBranch.set(b, []);
    byBranch.get(b).push(c);
  });
  const branchAvg = [...byBranch.entries()].map(([b, items]) => ({
    b, avg: items.reduce((s, i) => s + scoreFn(i), 0) / items.length,
  })).sort((x, y) => y.avg - x.avg);
  const topCount = Math.max(1, Math.ceil(branchAvg.length * 0.6));
  const topBranchIds = new Set(branchAvg.slice(0, topCount).map(x => x.b));

  const stretchBranch = branchAvg.filter(x => !topBranchIds.has(x.b))[0]?.b ?? null;
  const stretchPick = stretchBranch
    ? [...byBranch.get(stretchBranch)].sort((x, y) => scoreFn(y) - scoreFn(x))[0]
    : null;

  const rest = candidates
    .filter(c => c !== stretchPick)
    .sort((x, y) => scoreFn(y) - scoreFn(x));

  const picks = (stretchPick ? [stretchPick] : []).concat(rest).slice(0, take);
  const stretchIndex = stretchPick ? picks.indexOf(stretchPick) : -1;
  return { picks, stretchIndex };
}

/** The bridge line D1's copy rule requires on every stretch pick: it must
    state WHY the pick is being suggested despite sitting outside the
    listener's usual subjects, never a row reason implying it matches
    their taste (that's what the non-stretch "Because you finish every X"
    line is for, and it is deliberately never used here). Takes the
    subject label so the sentence names the actual branch, matching how
    every other Home string prefers a real name over a generic one. */
function stretchBridgeLine(subjectLabelText) {
  return esc(stretchBridgeText(subjectLabelText));
}
/** The same sentence as plain text, for a surface that sets textContent (the
    player sheet's why line for a stretch tail pick, PQ-11) — escaping it there
    would print "Craft &amp; making". The sentence itself has nothing to escape,
    so the line above is exactly what it was. */
function stretchBridgeText(subjectLabelText) {
  return `Outside your usual subjects — a deliberate change of pace into ${String(subjectLabelText ?? "")}.`;
}


/* ---------- Home’s one play button ----------

   FOUNDER, 2026-09-24: "Add a play button at the Home Screen level and start
   playing whatever is first in that list (whether it be Suggested or a
   Playlist or whatever)".

   REDESIGN 2026 (Today): ONE control, the hero’s Play (`data-home-play`). The hero IS what is
   first on Home — today’s foray, or the first pick — so the button plays what the hero names,
   and it names it ("Play <title>"), because "Play" alone on a screen of twenty things answers
   nothing. A foray that does not resolve cannot be the hero (the next one is, else the first
   pick): a button that names a thing and then fails is worse than one that names the next
   thing. With nothing playable on Home there is no hero and no button.

   Each kind starts the way its own page starts it, through the same code:
     foray     the Foray page’s main button — `playForay`, resuming where the
               listener left it (`forayResume`), else from the top;
     episode   a row’s ▶ (`startEpisodePlay`);
     playlist  its first playable row, with the playlist’s rows as the list
               continuous playback goes on through (the detail page’s `playlistCtx`,
               so a real playlist’s `last_played_at` is stamped exactly as a row’s ▶
               stamps it) — reached today from "Keep listening". */

/** A candidate made concrete, or null when it cannot play right now. */
function homePlayable(c) {
  if (c.kind === "foray") {
    const r = resolveListedForay(c.id);
    if (!r || !Array.isArray(r.playable) || !r.playable.length) return null;
    return { kind: "foray", r, title: c.title || r.title || c.id };
  }
  if (c.kind === "episode") {
    const item = c.item && c.item.id ? (liveEpisode(c.item.id) || c.item) : null;
    if (!item || !item.audio_url) return null;
    return { kind: "episode", item, title: c.title || item.title || "this episode", list: [], ctx: null };
  }
  const p = c.playlist;
  if (!p) return null;
  const rows = resolveParts(p).filter(r => r.state === "live" && isPlayableId(r.item.id));
  if (!rows.length) return null;
  const ctx = playlistCtx(p);
  return {
    kind: "playlist", title: p.title || "this playlist", ctx,
    item: liveEpisode(rows[0].item.id),
    list: rows.map(r => ({ id: r.item.id, ctx })),
  };
}

/* The target the rendered button names. Set at render time and read at the
   press, so the press plays exactly what the label promised. */
let homePlayPending = null;

function bindHomePlay(scope) {
  const btn = scope && typeof scope.querySelector === "function" ? scope.querySelector("[data-home-play]") : null;
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener("click", () => playHomeTarget(homePlayPending, btn));
}

/** The press. The loading mark is the row ▶'s (`data-loading`, which
    styles.css breathes and holds still under Reduce Motion), and a second
    press while it is set does nothing: the impatient thumb is not a second
    start. */
async function playHomeTarget(t, btn = null) {
  const player = window.ForayPlayer;
  if (!t || !player) return false;
  if (btn && btn.dataset.loading === "1") return false;
  if (btn) { btn.dataset.loading = "1"; btn.setAttribute("aria-busy", "true"); }
  try {
    return t.kind === "foray" ? await startHomeForay(player, t.r) : await startHomeEpisode(player, t);
  } finally {
    if (btn) { delete btn.dataset.loading; btn.removeAttribute("aria-busy"); }
  }
}

async function startHomeEpisode(player, t) {
  const item = t.item;
  if (!item || !item.audio_url) return false;
  /* IS IT ALREADY THE PLAYER'S? A paused one resumes where it is; a playing
     one is left alone — this button says "Play", so it never pauses. */
  if (player.isCurrent?.(item.id)) {
    if (!player.isPlaying?.(item.id)) await player.togglePlayback?.();
    return true;
  }
  return startEpisodePlay(item.id, item, { ctx: t.ctx, list: t.list });
}

async function startHomeForay(player, r) {
  const live = player.forayStatus?.();
  if (live && live.forayId === r.id) {
    if (!live.running) await player.forayToggle?.();
    return true;
  }
  let resume = null;
  try { resume = player.forayResume?.(r.id, { resolved: r }) || null; } catch (_) { resume = null; }
  /* The call into the player comes before any await: the tap is the gesture
     Safari lets audio start inside (#225, the Foray page's own rule). */
  const at = resume ? { startElapsedSec: resume.elapsedSec } : { startIndex: 0 };
  let started;
  try {
    started = Promise.resolve(player.playForay(r, { ...at, discoverDoc: state.discover }));
  } catch (err) {
    started = Promise.reject(err);
  }
  logEvent("foray_play", {
    foray_id: r.id, segments: r.playable.length,
    resumed_from_sec: resume ? Math.round(resume.elapsedSec) : null,
  });
  let report = null;
  try {
    report = await started;
  } catch (err) {
    console.warn("[4a] Foray start failed", err);
    try { player.reportPlayFailure?.(err); } catch (_) { /* the bar is best-effort */ }
    noteTapFailure("start", err);
    return false;
  }
  if (!report) {
    /* Superseded (another start took the player mid-load) is not failed. */
    const now = player.forayStatus?.();
    if (now && now.forayId !== r.id) return false;
    try { player.reportPlayFailure?.(null); } catch (_) { /* the bar is best-effort */ }
    return false;
  }
  trySyncEvents();
  return true;
}

/**
 * "Jump back in" — FORAYS, PODCASTS AND PLAYLISTS, most recent first.
 *
 * FOUNDER, 2026-09-18: "Only forays are in the jump back in section, podcasts
 * and playlists should be there too."
 *
 * WHY ONLY FORAYS WERE THERE, because the episode card was not missing — it was
 * unreachable. It came from `currentContinue()`, which reads `cp_lastpick`, and
 * that key has three gates the founder's own listening fails:
 *
 *   1. `cp_lastpick` was written ONLY when `state.poolIds.has(id)` — the discover
 *      pool. An episode opened from a show page (Lex's episode list, which is
 *      what he was listening to) is not in the pool, so nothing was ever
 *      recorded for it.
 *   2. It is gated on `duration_min > commute + 5`, so a short episode never
 *      qualified however recently it was played.
 *   3. It records what you TAPPED, not what you PLAYED or how far you got.
 *
 * So the episode card now comes from the same durable pointer that restores the
 * now-playing ribbon (`player/episode-progress.js` + `PositionStore`), which has
 * none of those three problems: it is written when playback actually starts, for
 * any episode from anywhere, and the position behind it is the real one.
 *
 * PLAYLISTS need no new storage at all — `last_played_at` has been stamped on
 * every play since #558, and two other surfaces already sort by it. They were
 * simply never offered here.
 *
 * ORDERED BY RECENCY ACROSS ALL THREE, not grouped by kind. A rail that always
 * put Forays first would reproduce the complaint the day a Foray was the oldest
 * thing on it. Forays carry no timestamp in `forayResumeList`'s rows, so they
 * sort on the store's own `updated_at` where present and fall to the end
 * otherwise — deliberately conservative: an unknown time must not out-rank a
 * known one.
 */
/** The rail's contents as data — one array of `{kind, at, ...}`, sorted, capped.
    Split out from the markup so the ORDERING is testable without parsing HTML. */
function jumpBackInEntries(limit = 6) {
  const entries = [];

  for (const p of forayResumeRows()) {
    entries.push({
      /* `updated_at`, the shape `forayResumeList` actually returns — spelling
         this `updatedAt` silently sorted every Foray to the end of the rail,
         which is the founder's complaint with the kinds swapped round. */
      kind: "foray", id: p.id, at: p.updated_at || null,
      title: p.title || p.id, sub: "Foray", percent: p.percent, left: p.label,
    });
  }

  const ep = lastEpisodeCard();
  if (ep) entries.push(ep);

  /* `.filter(p => p.last_played_at)` and not "or created": a playlist you built
     and never played is not something you are jumping BACK into. It has its own
     home on the playlists page.

     WHERE YOU ARE IN IT, like the Foray and episode cards beside it (audit
     round 2, honesty-7): the rail mixed three grammars — a bar and "N min
     left" on those two, a bare "12 episodes" here — though the playlist page
     itself knew "3 played". The card reads `hasOpened` (history OR a stored
     position) — the page's next-up marker's reading; the page's own header
     count moved to the player's "played" verdict in honesty-6.
     NO ZERO (round-2 review; copy-13, "a zero is not a fact worth a line"): a
     played playlist can reach 0 here once its ids age out of the 200-entry
     history ring, and the card then said "0 of 12 played" over an empty bar
     beside "12 episodes" — the page drops its "0 played" the same way. */
  const history = new Set(pickedHistory());
  for (const p of playlists().filter(p => p.last_played_at)) {
    const rows = resolveParts(p);
    const played = rows.filter(r => hasOpened(r.item.id, history)).length;
    entries.push({
      kind: "playlist", id: p.id, at: p.last_played_at,
      title: p.title || p.name || "Playlist",
      sub: playlistLengthLabel(p),
      percent: rows.length && played ? Math.round((played / rows.length) * 100) : null,
      left: rows.length && played ? `${played} of ${rows.length} played` : "",
    });
  }

  /* An entry with no timestamp sorts last rather than first — an unknown time
     must never out-rank a known one. */
  return entries
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, limit);
}

/** The episode entry, from the durable pointer the ribbon restores from. */
function lastEpisodeCard() {
  const player = window.ForayPlayer;
  if (typeof player?.lastEpisodeCard !== "function") return null;
  try {
    const r = player.lastEpisodeCard();
    if (!r) return null;
    /* Seeded into the item index so a tap can play it without waiting for a
       catalogue that may not hold it at all — the pointer's snapshot carries
       `audio_url` precisely so this is possible.
       NEVER OVER A RICHER ENTRY (audit round 3, app-2-1), exactly as
       playerPointerEpisode seeds it: the pointer carries seven fields, and
       Home renders on every open, so an unguarded snapshot replaced the played
       episode's pool or show-page entry — notes, chapters, date, topics — with
       the thin pointer for the rest of the session. */
    if (!state.itemIndex[r.id]) snapshot(r.id, r);
    return {
      /* `item` is the snapshot itself, carried so the card can render a play
         button: `playBtn` needs `audio_url` to decide whether to render at all,
         and `title` for its aria-label. */
      kind: "episode", id: r.id, at: r.updated_at || null, item: r,
      title: r.title || r.id, sub: r.show || "",
      percent: r.percent, left: r.label,
    };
  } catch (_) {
    return null;
  }
}

/** The "Forays for you" pick: the four cards, which one is the stretch (-1 for
    none), and the test-track drafts appended after them — or null when there
    is nothing to list. One function, so the row Home renders and any sentence
    ABOUT that row (the intro popup's stretch claim, p-first-11) read the same
    answer. */
function foraysForYouPicks() {
  if (!state.forays || !window.ForayPlayer) return null;
  const { listed, drafts } = splitTestTrackDrafts(opts => window.ForayPlayer.listForays(state.forays, opts));
  if (!listed.length && !drafts.length) return null;
  const { picks, stretchIndex } = pickWithStretchFloor(listed, {
    branchFn: f => (f.topic || "other").split("/")[0],
    scoreFn: f => interestScore({ topics: [(f.topic || "other").split("/")[0]] }),
    take: 4,
  });
  return { picks, stretchIndex, drafts };
}

/** The one-line notice Home carries while the test track is on, so a device
    left with the switch flipped says so on the first screen rather than
    quietly listing work nobody published. */
function testTrackNoticeHtml() {
  if (!showDraftsOn()) return "";
  return `<p class="hv2-test-track note">Showing draft Forays — test track</p>`;
}

/** "Playlists for you" (D5): the listener's own recent playlists first,
    then up to three generated from state.interests (generatedPlaylists():
    the strongest interest leaves, filled from the discover pool). NOT the
    card slots — F14: that made this section "Episodes for you" (now "Suggested")
    regrouped. */
/** The rail's playlists, in the order it draws them: own recent first, then
    generated. One function, so the rail and Home's play button (homePlayTarget)
    cannot disagree about which playlist is first. */
function playlistsForYouPicks() {
  const own = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created || "").localeCompare(a.last_played_at || a.created || ""))
    .slice(0, 3);
  /* A generated playlist whose saved copy is drawn beside it, holding the same
     episodes, is that copy: drawing both is two identical cards. */
  return { own, generated: generatedPlaylists().filter(g => !currentCopyOf(g, own)) };
}

/* ==================================================================== */
/* TODAY — Redesign 2026, ambient direction ("Afterglow"), phase 4.      */
/*                                                                      */
/* Home is a room lit by its hero's artwork. docs/redesign-2026/         */
/* directions/ambient/BUILD-NOTES.md §4.1 (the screen), §10.3 (the hot   */
/* spot), §10.5 (collages never crop a square), §10.6 (the hero title)   */
/* and BUILD-PLAN.md §2.1.3 are the numbers; ui/today.css is where they  */
/* live, ui/primitives.css supplies the art, collage, pill, button and   */
/* stretch-card treatments this file only composes.                      */
/*                                                                      */
/* RULINGS THIS SCREEN OVERTURNS, by name (test-classification.md §0):   */
/*   - "Home section order and content" (U-03; founder 2026-09-18, 09-24):*/
/*     hero, Keep listening, Today's picks, Playlists for you, Off your   */
/*     path replace greeting / Jump back in / Forays for you / Playlists  */
/*     / Suggested. The exploration floor survives (below).               */
/*   - "Wordmark once on Home": the wordmark is the header's left edge.   */
/*   - "Card/row anatomy" on Home: rows are the 96px EpisodeRow.          */
/* WHAT IT KEEPS: Home's one Play button (founder 2026-09-24) is the      */
/* hero's Play and starts what the hero names; every row's Play is a      */
/* toggle; continuous playback goes on through the rest of the picks;     */
/* the stretch floor (below); the test-track notice; Jump back in's data  */
/* (jumpBackInEntries) now feeds "Keep listening".                        */
/*                                                                      */
/* THE FLOOR, restated for this layout (resolves #123, D1): the Stretch   */
/* card is always in "Today's picks", never first and never last, and     */
/* always carries its bridge sentence; "Off your path" is a second,       */
/* labelled share of the day drawn only from subjects OUTSIDE the         */
/* listener's top interest tier. Neither ever wears a taste-match reason. */
/* ==================================================================== */

const TODAY_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TODAY_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/* Picks in the list: four to six rows, the Stretch card among them. */
const TODAY_PICKS_MAX = 6;
const TODAY_OFFPATH_MAX = 3;
/* The first-run hero's one extra line. Written once: DIRECTION.md "Hero screens". */
const TODAY_FIRST_RUN_NOTE = "4a found today’s picks. No account, no setup.";
const TODAY_OFFPATH_NOTE = "About a third of each day sits outside your usual subjects. This is today’s third.";
const TODAY_OFFLINE_NOTE = "Offline. Downloaded items play.";

/** "Monday, 5 October": a fact about NOW, so a page left open overnight corrects it
    (`refreshGreeting`, run from the foreground hook in init()). */
function todayDateLine(now = new Date()) {
  return `${TODAY_DAYS[now.getDay()]}, ${now.getDate()} ${TODAY_MONTHS[now.getMonth()]}`;
}

/* The date line is a fact about NOW, and a page left open overnight kept saying
   yesterday's date (audit 2026-09-22, qa row 193, which was about the greeting
   word this line replaced): it was computed once per render and nothing
   re-rendered Home on return. `refreshGreeting` runs from the foreground hook in
   init() and rewrites the one line, only when it changed — not the whole of Home
   under the listener's thumb. */
function refreshGreeting(now = new Date()) {
  const el = document.querySelector(".td-date");
  if (el) setStatusText(el, todayDateLine(now));
}

/** A show's artwork URL by its name (the discover pool's first episode art), or null. */
function todayShowArt(name) {
  return name ? showArtworkUrl({ title: name }) : null;
}

/** Is this device offline right now? `navigator.onLine === false` is the only reading
    that is a fact: `true` only means "a network interface is up". */
function todayOffline() {
  try { return typeof navigator !== "undefined" && navigator.onLine === false; } catch (_) { return false; }
}

/** Downloaded to the device (player/download-store.js `done`), so it plays offline. */
function todayDownloaded(id) {
  try {
    const rec = downloadsValue().items[id];
    return !!rec && rec.status === "done";
  } catch (_) { return false; }
}

/** An episode that cannot be played right now: offline and not on the device. Rows draw it "Unavailable" with Play
    disabled (todayRowState), and the hero and the continuous-play list follow the same fact. */
function todayEpisodeBlocked(id) {
  return todayOffline() && !todayDownloaded(id);
}

/** Observed, not declared: a listener is new until something has been played or is part-played. */
function todayIsFirstRun(entries = jumpBackInEntries()) {
  return entries.length === 0 && pickedHistory().length === 0;
}

/** Today's foray as the hero, or null (no module, no documents, nothing that resolves and plays).
    Drafts are never the hero: the test-track switch lists them on #/forays and says so here. */
function todayForayHero(pick = foraysForYouPicks()) {
  if (!pick) return null;
  const player = window.ForayPlayer;
  for (let i = 0; i < pick.picks.length; i++) {
    if (i === pick.stretchIndex) continue;   // the floor's foray is a stretch: not "today's"
    const f = pick.picks[i];
    const target = homePlayable({ kind: "foray", id: f.id, title: f.title });
    if (!target) continue;
    const names = [];
    for (const p of target.r.playable) {
      if (p && p.type !== "narration" && p.show && !names.includes(p.show)) names.push(p.show);
    }
    const tally = typeof player?.stripTally === "function" ? player.stripTally(target.r.playable) : null;
    const showCount = tally && tally.shows ? tally.shows : names.length;
    return {
      kind: "foray", id: f.id, title: f.title,
      route: forayRoutePath(f.id),
      shows: names.slice(0, 4).map(n => ({ name: n, src: todayShowArt(n) })),
      glowShow: names[0] || f.title,
      meta: joinMeta(showCount ? countLabel(showCount, "show") : "", forayRuntimeLabel(player, tally, target.r.totalSec)),
      metaParts: [showCount ? countLabel(showCount, "show") : "", forayRuntimeLabel(player, tally, target.r.totalSec)].filter(Boolean),
      why: String(f.summary || ""),
      target,
    };
  }
  return null;
}

/** An episode as the hero (first run, or no foray to offer). */
function todayEpisodeHero(item, branch = "") {
  if (!item) return null;
  const target = homePlayable({ kind: "episode", item, title: item.title });
  if (!target) return null;
  return {
    kind: "ep", id: item.id, title: item.title || "",
    route: `/episode/${encodeURIComponent(item.id)}`,
    shows: [{ name: item.show || "", src: item.artwork_url || null }],
    glowShow: item.show || "",
    meta: joinMeta(item.show || "", fmtDur(episodeMinutes(item))),
    why: String(item.hook || ""),
    target,
    item,
    branch,
  };
}

/** The ordered picks for the list, the Stretch among them, from the deal (`state.cardSlots`).
    `{ rows: [{ item, branch, stretch, familiar? }] }`, four to six long when the pool allows.
    Computed once per deal: nothing here is random, so a repaint (the ribbon arriving late, a
    settings switch) draws the same list rather than re-rolling it. */
let todayPicksMemo = { slots: null, value: null };
function todayPicks() {
  const slots = state.cardSlots || [];
  if (todayPicksMemo.slots === slots && todayPicksMemo.value) return todayPicksMemo.value;
  const playable = (it) => !!(it && it.audio_url);
  const seen = new Set();
  const take = (it) => (playable(it) && !seen.has(it.id) ? (seen.add(it.id), true) : false);
  const tops = slots.filter(s => s.role !== "stretch");
  const stretchSlot = slots.find(s => s.role === "stretch" && playable(s.item)) || null;
  if (stretchSlot) seen.add(stretchSlot.item.id);
  const rows = [];
  tops.forEach(s => {
    const lead = (s.items || []).find(take);
    if (lead) rows.push({ item: lead, branch: s.branch, stretch: false });
  });
  /* Second episodes of the top subjects fill the list to the cap (leaving room for the Stretch). */
  const room = TODAY_PICKS_MAX - (stretchSlot ? 1 : 0);
  for (let pass = 0; rows.length < room && pass < 3; pass++) {
    for (const s of tops) {
      if (rows.length >= room) break;
      const more = (s.items || []).find(take);
      if (more) rows.push({ item: more, branch: s.branch, stretch: false });
    }
  }
  if (stretchSlot) {
    /* Never first, never last: index 2 when the list is long enough, else the middle. */
    const at = rows.length >= 3 ? 2 : rows.length >= 2 ? 1 : rows.length;
    const familiar = rows[0] ? rows[0].item : null;
    rows.splice(at, 0, {
      item: stretchSlot.item, branch: stretchSlot.branch, stretch: true,
      familiar: familiar ? { name: familiar.show || "", src: familiar.artwork_url || null } : null,
    });
  }
  const value = { rows, stretchBranch: stretchSlot ? stretchSlot.branch : null };
  todayPicksMemo = { slots, value };
  return value;
}

/** "Off your path": two or three episodes from subjects OUTSIDE the top interest tier (the same
    60% cut buildCards and pickWithStretchFloor use), none already on the page. Deterministic. */
function todayOffPath(excludeIds, stretchBranch) {
  const pool = poolFiltered();
  const history = new Set(pickedHistory());
  const seen = new Set(stringList(lsGet("cp_seen", [])));
  const byBranch = {};
  pool.forEach(i => { (byBranch[branchOf(i)] = byBranch[branchOf(i)] || []).push(i); });
  const ranked = Object.keys(byBranch).map(b => ({
    b, avg: byBranch[b].reduce((s, i) => s + interestScore(i), 0) / byBranch[b].length,
  })).sort((x, y) => (y.avg - x.avg) || (x.b < y.b ? -1 : 1));
  const top = new Set(ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.6))).map(x => x.b));
  const out = [];
  for (const { b } of ranked) {
    if (top.has(b) || b === stretchBranch) continue;
    const lead = branchChain(byBranch[b], history, seen).find(it => it.audio_url && !excludeIds.has(it.id));
    if (!lead) continue;
    excludeIds.add(lead.id);
    out.push({ item: lead, branch: b });
    if (out.length >= TODAY_OFFPATH_MAX) break;
  }
  return out;
}

/** The "Keep listening" entry: the most recent thing the listener is PART-WAY through. A
    playlist with a play date but no progress, or a finished thing, is not mid-listen. */
function todayKeepEntry(entries = jumpBackInEntries()) {
  return entries.find(e => typeof e.percent === "number" && e.percent >= 0 && e.percent < 100) || null;
}

/** The covers for a playlist tile: up to four episode arts. */
function todayPlaylistCard(p, generated, history) {
  const rows = resolveParts(p);
  const covers = rows.filter(r => r.item).slice(0, 4).map(r => ({ name: r.item.show || r.item.title || "", src: r.item.artwork_url || null }));
  const allTimed = rows.length > 0 && rows.every(r => r.item && episodeMinutes(r.item) > 0);
  const totalMin = allTimed ? rows.reduce((s, r) => s + episodeMinutes(r.item), 0) : 0;
  const played = rows.filter(r => r.item && hasOpened(r.item.id, history)).length;
  return {
    title: p.title || p.name || "Playlist", route: `/${playlistRoute(p)}`, covers, generated,
    meta: joinMeta(countLabel(rows.length, "episode"), fmtDur(totalMin)),
    played: rows.length && played ? `${played} of ${rows.length} played` : "",
  };
}

/* ---------- Today's markup ---------- */

/** The 44px (row) or 56px (hero) round Play. `attrs` is built by the caller from esc()'d parts. */
function todayPlayButton({ size = 44, label, attrs = "", disabled = false, icon = "play" }) {
  const glyph = size === 56 ? 28 : 20;
  return `<button type="button" class="ag-btn ag-btn-play ag-btn-size-${size}"${attrs} aria-label="${esc(label)}"${disabled ? ' disabled aria-disabled="true"' : ""}>${agIcon(icon, glyph)}</button>`;
}

/** An artwork with an optional Ember progress rim inside its bottom edge (a started episode). */
function todayArt({ name, src, size = 72, dim = false, pct = null }) {
  let art = agArtwork({ name: name || "Artwork", src: src || "", size, state: dim ? "dim" : "default" });
  if (typeof pct === "number" && pct >= 0) {
    const rim = `<span class="td-rim" aria-hidden="true"><i class="td-rim-fill" data-pct="${esc(String(Math.max(0, Math.min(100, Math.round(pct)))))}"></i></span>`;
    art = art.replace(/<\/span>$/, rim + "</span>");
  }
  return art;
}

/** What a row's state line says: playing, then unavailable offline, then played, then downloaded. */
function todayRowState(item) {
  const player = window.ForayPlayer;
  try { if (player?.isPlaying?.(item.id)) return "playing"; } catch (_) { /* a stub player */ }
  if (todayOffline()) return todayDownloaded(item.id) ? "downloaded" : "unavailable";
  const p = rowProgress(item);
  if (p && p.state === "played") return "played";
  return todayDownloaded(item.id) ? "downloaded" : "default";
}

function todayStateLine(rowState) {
  const line = AG_ROW_LINES[rowState];
  return line ? `<span class="ag-row-state${esc(line[0])}">${agIcon(line[1], 20)}${esc(line[2])}</span>` : "";
}

/** The second line of a row: state, show, length, date. The show gives way (ellipsis) before the rest. */
function todayMetaHtml(rowState, item) {
  const dur = fmtDur(episodeMinutes(item));
  /* A row that carries a state line (Playing, Unavailable, Downloaded, Played) gives up its date: the state is the news, and a
     96px row at 375 has no room for the word, the show, the length AND the day. */
  const date = rowState === "default" ? fmtDate(item.release_date || item.published_at) : "";
  const parts = [`<span class="td-ell">${esc(item.show || "")}</span>`];
  if (dur) parts.push(`<span class="dur">${esc(dur)}</span>`);
  if (date) parts.push(`<span>${esc(date)}</span>`);
  return `${todayStateLine(rowState)}${parts.join('<span class="td-sep" aria-hidden="true"></span>')}`;
}

/** The progress of a started episode, as a percent, or null. */
function todayEpisodePct(item) {
  const p = rowProgress(item);
  return p && p.state === "in-progress" && typeof p.percent === "number" ? p.percent : null;
}

/** One EpisodeRow (BUILD-NOTES §3): art 72, title, Play 44, meta, a two-line why. The title is the
    row's one real link (its ::after covers the row); Play is a sibling above it. */
function todayEpisodeRow(row) {
  const item = row.item;
  const rowState = row.state || todayRowState(item);
  const pct = row.pct !== undefined ? row.pct : todayEpisodePct(item);
  const id = esc(encodeURIComponent(item.id));
  const playing = rowState === "playing";
  const blocked = rowState === "unavailable";
  const why = row.why !== undefined ? row.why : item.hook;
  return `<article class="raised td-row is-${esc(rowState)}" data-td-ep="${esc(item.id)}" data-branch="${esc(row.branch || "")}">
    ${todayArt({ name: item.show, src: item.artwork_url, size: 72, dim: rowState === "unavailable", pct })}
    <h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#/episode/${id}" data-ev="picked" data-ep="${esc(item.id)}" data-ctx="today">${esc(item.title || "")}</a></h3>
    ${item.audio_url ? todayPlayButton({ size: 44, label: `${playing ? "Pause" : "Play"} ${item.title || "this episode"}`, attrs: ` data-td-play="${esc(item.id)}" data-title="${esc(item.title || "")}"`, disabled: blocked, icon: playing ? "pause" : "play" }) : ""}
    <p class="t-caption td-row-meta">${todayMetaHtml(rowState, item)}</p>
    ${why ? `<p class="t-why clamp2 td-row-why">${esc(why)}</p>` : ""}
  </article>`;
}

/** The StretchCard (BUILD-NOTES §3): a Lamp pill, the familiar show and the stretch joined by a lit
    line, the bridge sentence, then the pick. The bridge states WHY, never "because you like X". */
function todayStretchCard(row) {
  const item = row.item;
  const rowState = todayRowState(item);
  const playing = rowState === "playing";
  const blocked = rowState === "unavailable";
  const id = esc(encodeURIComponent(item.id));
  const left = row.familiar ? todayArt({ name: row.familiar.name, src: row.familiar.src, size: 56 }) : "";
  const right = todayArt({ name: item.show, src: item.artwork_url, size: 56, dim: rowState === "unavailable" });
  return `<article class="raised ag-stretch-card td-stretch is-${esc(rowState)}" data-td-ep="${esc(item.id)}" data-branch="${esc(row.branch || "")}">
    ${agPill("Stretch", "sparkle")}
    <div class="ag-bridge-arts">${left}<span class="ag-bridge-line" aria-hidden="true"></span>${right}</div>
    <p class="t-why td-bridge">${stretchBridgeLine(subjectLabel(row.branch))}</p>
    <div class="ag-card-end">
      <div>
        <h3 class="t-headline clamp2"><a class="td-link" href="#/episode/${id}" data-ev="picked" data-ep="${esc(item.id)}" data-ctx="today">${esc(item.title || "")}</a></h3>
        <p class="t-caption td-row-meta">${todayMetaHtml(rowState, item)}</p>
      </div>
      ${item.audio_url ? todayPlayButton({ size: 44, label: `${playing ? "Pause" : "Play"} ${item.title || "this episode"}`, attrs: ` data-td-play="${esc(item.id)}" data-title="${esc(item.title || "")}"`, disabled: blocked, icon: playing ? "pause" : "play" }) : ""}
    </div>
  </article>`;
}

function todaySectionHead(title, count, explainer) {
  return `<div class="td-head2"><h2 class="t-headline">${esc(title)}</h2>${count ? `<span class="t-caption count">${esc(String(count))}</span>` : ""}</div>${explainer ? `<p class="t-body td-explainer">${esc(explainer)}</p>` : ""}`;
}

/** The foray hero's meta beside Play. The column beside the collage leaves ~109px after Play and the gap, which holds
    "4 shows · 19 min" (the prototype's, ~98px) on ONE line but not "1 show · about 43 min" (131px). Rather than let that
    wrap mid-line and strand the separator ("1 show ·" / "about 43 min"), a meta that will not fit stacks its two parts,
    one per line, with the separator carried for screen readers only. Either way no line ever breaks inside a part. */
const TODAY_META_ONE_LINE_MAX = 17;
function todayForayMetaHtml(hero) {
  const parts = Array.isArray(hero.metaParts) ? hero.metaParts : [];
  const stacked = parts.length === 2 && String(hero.meta).length > TODAY_META_ONE_LINE_MAX;
  if (!stacked) return `<p class="t-caption td-hero-meta num">${esc(hero.meta)}</p>`;
  return `<p class="t-caption td-hero-meta num is-stacked"><span>${esc(parts[0])}</span><span class="sr-only"> · </span><span>${esc(parts[1])}</span></p>`;
}

/** HeroPick (BUILD-NOTES §3, §10.6): the collage, the eyebrow, the title (four lines, no ellipsis), the
    meta, Ember Play 56 under the collage's bottom edge, and the why-line across the full width. */
function todayHeroHtml(hero, { firstRun }) {
  /* Offline, the hero plays only what is on the device. A foray streams each clip from its show's own feed (a download is a
     whole episode; nothing in the foray start path reads one), so offline it cannot start; an episode hero plays if downloaded.
     A press that cannot succeed is not offered: Play is disabled and the art dims, as a row's is (todayRowState). */
  const blocked = todayOffline() && (hero.kind === "foray" || !todayDownloaded(hero.id));
  /* Typographic apostrophes (U+2019) in what is drawn, as the prototype's Fraunces sets them; the landmark names below stay ASCII. */
  const eyebrow = firstRun ? "Today’s picks" : hero.kind === "foray" ? "Today’s foray" : "Today’s pick";
  const art = agCollage(hero.shows.map(s => ({ name: s.name, src: s.src })), { size: 160 });
  /* The landmark is named for what the hero IS, not for the eyebrow: a first run's eyebrow is "Today's picks", which is also the list's
     region, and two landmarks with one name is an axe `landmark-unique` failure. */
  const landmark = hero.kind === "foray" ? "Today's foray" : "Today's pick";
  return `<section class="td-hero${blocked ? " is-unavailable" : ""}" aria-label="${esc(landmark)}"${hero.branch ? ` data-branch="${esc(hero.branch)}"` : ""}>
    <a class="td-hero-art" href="#${esc(hero.route)}" tabindex="-1" aria-hidden="true">${art}</a>
    <div class="td-hero-copy">
      <span class="eyebrow lamp">${esc(eyebrow)}</span>
      <h2 class="t-title clamp4 td-hero-title"><a class="td-link" href="#${esc(hero.route)}"${hero.kind === "ep" ? ` data-ev="picked" data-ep="${esc(hero.id)}" data-ctx="today"` : ""}>${esc(hero.title)}</a></h2>
      ${hero.kind === "foray" ? "" : `<p class="t-caption td-hero-meta">${esc(hero.meta)}</p>`}
      ${blocked ? `<p class="t-caption td-hero-meta td-hero-unavail">${agIcon("wifi-slash", 20)}<span>Unavailable offline</span></p>` : ""}
      <div class="td-hero-actions">${todayPlayButton({ size: 56, label: `Play ${hero.title}`, attrs: " data-home-play", disabled: blocked })}${hero.kind === "foray" ? todayForayMetaHtml(hero) : ""}</div>
    </div>
    ${hero.why ? `<p class="t-why td-why">${esc(hero.why)}</p>` : ""}
    ${firstRun ? `<p class="t-body td-first-run">${esc(TODAY_FIRST_RUN_NOTE)}</p>` : ""}
  </section>`;
}

function todayPlaylistTile(c) {
  return `<a class="raised ag-playlist-tile td-ptile" href="#${esc(c.route)}">
    ${agCollage(c.covers.length ? c.covers : [{ name: c.title }], { size: 120 })}
    ${c.generated ? `<span class="t-caption td-generated">Generated for you</span>` : ""}
    <h3 class="t-headline clamp2">${esc(c.title)}</h3>
    <p class="t-caption td-ptile-meta">${esc(c.meta)}</p>
    ${c.played ? `<p class="t-caption ag-progress-copy">${esc(c.played)}</p>` : ""}
  </a>`;
}

function todayHeaderHtml(loading) {
  return `<header class="td-head">
    <h1 class="td-wordmark" tabindex="-1">4a</h1>
    <button type="button" class="ag-btn ag-btn-icon td-gear" data-today-gear aria-label="Settings, Tuning and About"${loading ? ' disabled aria-disabled="true"' : ""}>${agIcon("gear", 24)}</button>
  </header>
  <p class="t-caption td-date">${esc(todayDateLine())}</p>`;
}

/** The test track (cp_show_drafts, off by default): every draft Foray the switch admitted, newest first, as
    plain rows under the page, each marked "draft". Home used to list them as badged cards in "Forays for
    you"; Today has no such rail, and the founder\u2019s switch exists so a generated Foray can be found. */
function todayDraftsHtml(drafts) {
  if (!drafts.length) return "";
  const rows = drafts.map(f => `<a class="raised td-draft" href="#${esc(forayRoutePath(f.id))}"><span class="eyebrow">draft</span><span class="t-label">${esc(f.title)}</span></a>`).join("");
  return `<section class="td-section" aria-label="Draft forays">${todaySectionHead("Draft forays", drafts.length)}<div class="td-stack">${rows}</div></section>`;
}

/** Skeletons for the hero and four rows, with the lamp sweep (both edges transparent). The wash stays
    at the default Glow. `boot` marks the page painted before the documents arrive (init()), which the
    webview probe reads as "still booting". */
function todaySkeletonHtml({ boot = false } = {}) {
  const row = `<div class="td-skel td-skel-row"></div>`;
  return `<div class="ag td-today td-loading"${boot ? " data-boot-loading" : ""} role="status" aria-busy="true">
    <span class="sr-only">Loading 4a…</span>
    <div class="td-wash" aria-hidden="true"></div>
    ${todayHeaderHtml(true)}
    <div class="td-hero td-hero-skel" aria-hidden="true">
      <div class="td-skel td-skel-art"></div>
      <div class="td-hero-copy"><div class="td-skel td-skel-line"></div><div class="td-skel td-skel-title"></div><div class="td-skel td-skel-play"></div></div>
    </div>
    <div class="td-section td-stack" aria-hidden="true">${row}${row}${row}${row}</div>
  </div>`;
}

/** "Keep listening": one row with an Ember progress rim. An episode plays like any row; a foray or a
    playlist resumes through Home's own start path. */
let todayKeepPending = null;
function todayKeepHtml(entry) {
  todayKeepPending = null;
  if (entry.kind === "episode") {
    const item = entry.item || {};
    const live = liveEpisode(item.id) || item;
    return todayEpisodeRow({
      item: { ...live, id: item.id, title: entry.title, show: entry.sub || live.show, artwork_url: live.artwork_url || item.artwork_url },
      pct: entry.percent, why: live.hook || "", branch: "",
    });
  }
  const cand = entry.kind === "foray" ? { kind: "foray", id: entry.id, title: entry.title } : { kind: "playlist", playlist: playlistById(entry.id) };
  const target = homePlayable(cand);
  todayKeepPending = target;
  const route = entry.kind === "foray" ? forayRoutePath(entry.id) : `/playlist/${encodeURIComponent(entry.id)}`;
  let covers = [];
  if (entry.kind === "foray" && target) {
    const names = [];
    for (const p of target.r.playable) if (p && p.type !== "narration" && p.show && !names.includes(p.show)) names.push(p.show);
    covers = names.slice(0, 4).map(n => ({ name: n, src: todayShowArt(n) }));
  } else if (cand.playlist) {
    covers = resolveParts(cand.playlist).filter(r => r.item).slice(0, 4).map(r => ({ name: r.item.show || "", src: r.item.artwork_url || null }));
  }
  const art = agCollage(covers.length ? covers : [{ name: entry.title }], { size: 104 });
  const pct = Math.max(0, Math.min(100, Math.round(entry.percent || 0)));
  return `<article class="raised td-row td-keep is-default">
    <span class="td-keep-art">${art}<span class="td-rim" aria-hidden="true"><i class="td-rim-fill" data-pct="${esc(String(pct))}"></i></span></span>
    <h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#${esc(route)}">${esc(entry.title)}</a></h3>
    ${target ? todayPlayButton({ size: 44, label: `Play ${entry.title}`, attrs: " data-td-keep" }) : ""}
    <p class="t-caption td-row-meta"><span class="td-ell">${esc(entry.sub || "")}</span>${entry.left ? `<span class="td-sep" aria-hidden="true"></span><span>${esc(entry.left)}</span>` : ""}</p>
  </article>`;
}

/** Everything Today draws, as one string. */
function todayHtml() {
  const entries = jumpBackInEntries();
  const firstRun = todayIsFirstRun(entries);
  const offline = todayOffline();
  const picks = todayPicks();
  /* ONE computation of the Foray pick per render (audit round 3, app-2-12): the hero and the test-track drafts read it. */
  const forayPick = foraysForYouPicks();
  /* Offline a foray cannot start (todayHeroHtml), so the hero falls through to an episode, and to a downloaded one when there is one. */
  let hero = firstRun || offline ? null : todayForayHero(forayPick);
  let firstPickId = null;
  if (!hero) {
    const first = (offline && picks.rows.find(r => !r.stretch && todayDownloaded(r.item.id))) || picks.rows.find(r => !r.stretch) || picks.rows[0];
    hero = todayEpisodeHero(first && first.item, first ? first.branch : "");
    if (hero && first) firstPickId = first.item.id;
  }
  /* The hero IS the first pick when no foray leads: the list starts at the second pick and its count
     drops by one. */
  const listRows = firstPickId ? picks.rows.filter(r => r.item.id !== firstPickId) : picks.rows;
  /* An episode hero plays WITH the picks as its list, so continuous playback goes on through them (the
     rest of the list, then more of what fits: founder 2026-09-14). A foray carries its own running order. */
  if (hero && hero.kind === "ep" && hero.target) {
    hero.target.ctx = "today";
    hero.target.list = [hero.id].concat(listRows.map(r => r.item.id)).filter((id, i, all) => all.indexOf(id) === i && !(id !== hero.id && todayEpisodeBlocked(id))).map(id => ({ id, ctx: "today" }));
  }
  const exclude = new Set(picks.rows.map(r => r.item.id));
  if (hero && hero.id) exclude.add(hero.id);
  const off = todayOffPath(exclude, picks.stretchBranch);
  const keep = firstRun ? null : todayKeepEntry(entries);
  const { own, generated } = playlistsForYouPicks();
  const history = new Set(pickedHistory());
  const playlists = own.map(p => todayPlaylistCard(p, false, history)).concat(generated.map(p => todayPlaylistCard(p, true, history)));
  homePlayPending = hero && !(hero.kind === "ep" && todayEpisodeBlocked(hero.id)) ? hero.target : null;

  const heroHtml = hero ? todayHeroHtml(hero, { firstRun }) : "";
  const keepHtml = keep ? todayKeepHtml(keep) : "";
  const listHtml = listRows.map(r => (r.stretch ? todayStretchCard(r) : todayEpisodeRow(r))).join("");
  return `<div class="ag td-today${offline ? " is-offline" : ""}" data-today="${firstRun ? "first-run" : "returning"}">
    <div class="td-wash" aria-hidden="true" data-glow-show="${esc(hero ? hero.glowShow : "")}"></div>
    ${todayHeaderHtml(false)}
    ${offline ? `<div class="raised td-banner t-label" role="status">${agIcon("wifi-slash", 20)}<span>${esc(TODAY_OFFLINE_NOTE)}</span></div>` : ""}
    ${testTrackNoticeHtml()}
    ${heroHtml}
    ${keepHtml ? `<section class="td-section" aria-label="Keep listening">${todaySectionHead("Keep listening")}${keepHtml}</section>` : ""}
    ${listHtml ? `<section class="td-section" aria-label="Today's picks">${todaySectionHead("Today’s picks", listRows.length)}<div class="td-stack">${listHtml}</div></section>` : ""}
    ${playlists.length ? `<section class="hv2-playlists td-section" aria-label="Playlists for you">${todaySectionHead("Playlists for you")}<div class="td-rail">${playlists.map(todayPlaylistTile).join("")}</div></section>` : ""}
    ${off.length ? `<section class="td-section" aria-label="Off your path">${todaySectionHead("Off your path", 0, TODAY_OFFPATH_NOTE)}<div class="td-stack">${off.map(r => todayEpisodeRow(r)).join("")}</div></section>` : ""}
    ${todayDraftsHtml(forayPick ? forayPick.drafts : [])}
  </div>`;
}

/* ---------- behaviour ---------- */

/** Glow (BUILD-NOTES 1.2): the wash and the hero's lit art are lit by the hero's first show. */
function todayApplyGlow(scope) {
  if (!scope || typeof scope.querySelector !== "function") return;
  const wash = scope.querySelector(".td-wash");
  if (!wash || !wash.dataset || !wash.dataset.glowShow) return;
  agSetGlow(wash, wash.dataset.glowShow);
  const art = scope.querySelector(".td-hero-art .ag-collage");
  if (art) agSetGlow(art, wash.dataset.glowShow, "--art-glow");
}

/** Progress rims are widths, set through the CSSOM (an inline style attribute is not allowed). */
function todaySizeRims(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".td-rim-fill[data-pct]").forEach(fill => {
    const pct = Math.max(0, Math.min(100, Number(fill.dataset.pct) || 0));
    fill.style.setProperty("width", `${pct}%`);
  });
}

/** A hero title that cannot fit four lines steps down one style (headline) before it would be cut. */
function todayFitHeroTitle(scope) {
  if (!scope || typeof scope.querySelector !== "function") return;
  const title = scope.querySelector(".td-hero-title");
  if (title && title.classList && title.scrollHeight > title.clientHeight + 1) title.classList.add("is-compact");
}

/** Pick to play, the light moves (BUILD-NOTES §5): Glow goes to the new show over 560ms (the
    `transition: --glow` on :root) and the row's art flies to the mini player's art slot. */
function todayGlowTo(show) {
  try { agSetGlow(document.documentElement, show); } catch (_) { /* a stub document */ }
}

function todayFlipToMini(artEl) {
  try {
    if (!artEl || typeof artEl.getBoundingClientRect !== "function" || typeof artEl.animate !== "function") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;   // the art fades in place
    const slot = document.querySelector("[data-mini-art]") || document.querySelector("#foray-player .fp-art");
    if (!slot || slot.hidden) return;
    const from = artEl.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const clone = artEl.cloneNode(true);
    clone.classList.add("td-flip");
    clone.style.setProperty("left", `${from.left}px`);
    clone.style.setProperty("top", `${from.top}px`);
    clone.style.setProperty("width", `${from.width}px`);
    clone.style.setProperty("height", `${from.height}px`);
    (document.querySelector(".td-today") || document.body).appendChild(clone);
    const ease = (getComputedStyle(document.documentElement).getPropertyValue("--e-spring") || "").trim() || "cubic-bezier(0.2, 0.9, 0.2, 1.05)";
    const dx = to.left - from.left, dy = to.top - from.top, k = to.width / from.width;
    const anim = clone.animate(
      [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${k})` }],
      { duration: 560, easing: ease, fill: "forwards" },
    );
    const done = () => { try { clone.remove(); } catch (_) { /* gone */ } };
    anim.onfinish = done;
    anim.oncancel = done;
  } catch (_) { /* a flight that cannot run is not a reason to fail the play */ }
}

/** Repaint every row's playing state from the player (the single authority), including its Play
    glyph, label and the Lamp "Playing" caption. Cheap: a handful of rows. */
function todaySyncPlay() {
  const scope = document.querySelector(".td-today");
  const player = window.ForayPlayer;
  if (!scope || !player || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-td-ep]").forEach(row => {
    const id = row.dataset.tdEp;
    let on = false;
    try { on = !!player.isPlaying?.(id); } catch (_) { on = false; }
    if (row.classList.contains("is-playing") === on) return;
    row.classList.toggle("is-playing", on);
    const btn = row.querySelector("[data-td-play]");
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

let todayPollTimer = null;
function todayStartPoll() {
  if (todayPollTimer || typeof setInterval !== "function") return;
  todayPollTimer = setInterval(() => {
    if (!document.querySelector(".td-today:not(.td-loading)")) { clearInterval(todayPollTimer); todayPollTimer = null; return; }
    todaySyncPlay();
  }, 1000);
}

async function todayPlayPress(btn, scope) {
  const id = btn.dataset.tdPlay;
  const player = window.ForayPlayer;
  const item = liveEpisode(id) || state.itemIndex[id] || episode(id);
  if (!item || !player) return;
  /* A row showing Pause must pause (the same rule bindPlay learned, founder 2026-09-22). */
  if (player.isCurrent?.(id)) { await player.togglePlayback(); todaySyncPlay(); return; }
  const row = btn.closest("[data-td-ep]");
  const art = row ? row.querySelector(".ag-art") : null;
  todayGlowTo(item.show);
  /* The continuous-play list is what a listener could play: a row drawn Unavailable (offline, not downloaded) is not queued. */
  const list = [...scope.querySelectorAll("[data-td-play]")].filter(b => !b.disabled && !todayEpisodeBlocked(b.dataset.tdPlay)).map(b => ({ id: b.dataset.tdPlay, ctx: "today" }));
  const ok = await startEpisodePlay(id, item, { ctx: "today", list });
  todaySyncPlay();
  if (ok) todayFlipToMini(art);
}

function bindTodayPlay(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-td-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); todayPlayPress(btn, scope); });
  });
  scope.querySelectorAll("[data-td-keep]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); playHomeTarget(todayKeepPending, btn); });
  });
  const gear = scope.querySelector("[data-today-gear]");
  if (gear && !gear._bound) {
    gear._bound = true;
    bindSettingsGear(gear);
  }
}

let todayNetworkBound = false;
function bindTodayNetwork() {
  if (todayNetworkBound || typeof window.addEventListener !== "function") return;
  todayNetworkBound = true;
  /* Offline is a fact about this moment: the banner and the unplayable rows follow it. */
  const repaint = () => { if (isHomeRoute() && document.querySelector(".td-today:not(.td-loading)")) renderCurrentPage(); };
  window.addEventListener("offline", repaint);
  window.addEventListener("online", repaint);
}

function renderHomeV2() {
  setBodyClass("view-home");
  if (!state.cardSlots.length) buildCards();
  const view = $("#view");
  view.innerHTML = todayHtml();
  offerHomeOnboarding();
  todayApplyGlow(view);
  todaySizeRims(view);
  todayFitHeroTitle(view);
  bindPickLogging(view);
  bindTodayPlay(view);
  bindHomePlay(view);
  bindTodayNetwork();
  todayStartPoll();
}
