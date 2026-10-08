/* ui/home.js — Today (#/): the Tactile Home. Header, Resume, Today's foray, Also
   today, Playlists for you, New ground.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- views ---------- */

/* `currentContinue()` / `bannerHtml()` — the v1 Continue banner — lived here
   until visual pass 1 (2026-09-23). They had no caller since the U-11 cutover
   (renderHome always renders Home v2, whose "Jump back in" reads the player's
   position store), and the only thing keeping them alive was two tests that
   called the function directly. Dead markup guarded by tests reads as
   coverage and is not; both went, with their CSS (`.banner`, `#banner-slot`). */

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
   sentence for the Forays page and the first-run sheet. */
function forayAbout() {
  const narrated = forayCards().some(f => Array.isArray(f?.items) && f.items.some(i => i?.type === "narration"));
  return `One subject, heard across several podcasts: moments from their episodes, played in turn from each show's own feed${narrated ? ", with a narrator between them" : ""}.`;
}

/* HOME IS THE FOUR SUBJECT CARDS AND THE RESUME BANNER. NOTHING ELSE.
   (Founder instruction, 2026-09-03, after the first TestFlight build: "the
   home page has so much clutter … Home should be the four cards.")

   That is a layout invariant as much as a product one. `.cards4` is the
   only `flex: 1` child of `.home`, the one-screen column, so ANY sibling
   added here takes its height straight off the four cards. While `.home` was
   a FIXED-height column that starved them to 0px and overflowed on top of
   whatever followed — shipped as a visible bug twice, #433 (the vouch row)
   and again before it. #464 made the column `min-height` and gave `.cards4`
   a floor, so the failure now degrades to a taller scrolling page instead of
   crushed cards. That is a backstop, not a licence: the product is one
   screen, and what was wrong both times was putting a second surface inside
   it.

   So everything that used to compete for this space now has its own menu
   destination, and that is where it goes back to if it comes back:

     "Shows we vouch for" (vouchForHtml)   -> Shows      (#/shows)
     show search (#sh-form/#sh-results)     -> Shows      (#/shows)
     "Browse all shows" link                -> gone; Shows IS that page
     playlist builder (#pl-form)            -> Playlists  (#/playlists), then Create (#/create) since 2026-09-23
     foray list + "Jump back in"            -> Forays     (#/forays)

   test/home-information-architecture.test.js asserts each of those in both
   directions — absent here, present there — so a future re-add fails CI
   rather than shipping. */
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
/* U-03: HOME v2 — four sections plus the greeting, behind cp_ui_v2       */
/* (docs/ui-transition-plan.md, kanban t_6e8343b6, resolves gate #123)   */
/* ==================================================================== */

/* Top to bottom, per the card: greeting; Jump back in; Forays for you;
   Playlists for you; Suggested. "Shared with you" and "Build your
   own" are explicitly out of scope (D10/D8) — not stubbed, not commented
   out, simply never written.

   THE FLOOR (Wyatt's decision, resolves #123): "Forays for you" and
   "Suggested" EACH reserve at least one slot for a STRETCH pick —
   something outside the listener's top interest tier, on purpose, visibly
   labelled "Stretch" with a bridge line stating why it's being suggested.
   A row reason ("Because you finish every Odd Lots") is allowed elsewhere
   but never on the stretch slot itself — that is the whole point of a
   stretch: it is not being justified by what the listener already likes.

   Suggested REUSES buildCards()'s existing tiering (top 60% of
   branches by average interest vs. the rest) rather than re-implementing
   it — that function already computes exactly this split for the
   flag-off four-card Home, and a second copy is a second place for the
   two to quietly disagree about what a stretch pick is. Forays for you
   applies the same helper independently, over Foray topics rather than
   episode branches, since Forays are a different pool with different
   membership. */

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
    every other Home string prefers a real name over a generic one. Plain
    text, for a surface that sets textContent (the player sheet's why line for
    a stretch tail pick, PQ-11) or for one that escapes it itself (the bridge
    card, through esc()): escaping it here would print "Craft &amp; making". */
function stretchBridgeText(subjectLabelText) {
  return `Outside your usual subjects — a deliberate change of pace into ${String(subjectLabelText ?? "")}.`;
}

/** Every Home rail's picks, once. */
function homeRailPicks() {
  /* Resume reads the most recent part-played Foray or episode, so the cap is
     lifted: with the old six, six more recent playlists would push a half-heard
     episode out of the list before Resume ever looked at it. */
  return { jumpBackIn: jumpBackInEntries(Infinity), forays: foraysForYouPicks(), playlists: playlistsForYouPicks() };
}

/** The press on a Foray key. The loading mark is the key's (`data-loading`, which
    styles.css pulses and holds still under Reduce Motion), and a second press
    while it is set does nothing: the impatient thumb is not a second start. An
    episode's key is not here: it is `[data-play]`, bindPlay's, which already
    pauses what is playing and starts the rest through startEpisodePlay. */
async function playHomeTarget(t, btn = null) {
  const player = window.ForayPlayer;
  if (!t || !player || t.kind !== "foray") return false;
  if (btn && btn.dataset.loading === "1") return false;
  if (btn) { btn.dataset.loading = "1"; btn.setAttribute("aria-busy", "true"); }
  try {
    return await startHomeForay(player, t.r);
  } finally {
    if (btn) { delete btn.dataset.loading; btn.removeAttribute("aria-busy"); }
  }
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

/** "Forays for you" (D1, U-03/U-04): the published (+ explicitly unlocked)
    Forays, floored per pickWithStretchFloor over each Foray's own topic
    root. Renders nothing when there are no listable Forays at all —
    absence is a real state here, same convention forayListHtml() and
    every other optional Home block already follow.

    THE TEST TRACK (showDraftsOn): the four picks are chosen from exactly the
    list they were chosen from before — the switch never enters the floor or
    the interest ranking — and the drafts it admitted are APPENDED after them,
    every one, badged "draft", in draftTrackOrder. Appended rather than pooled
    because the founder turned this on to find a specific generated Foray, and
    a four-card pick over six candidates would hide two of them. */
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
    quietly listing work nobody published. Today draws one Foray, not a rail, so
    the drafts the switch admits are listed where every Foray is, under Forays;
    the notice says so and links there (a draft is Today's foray only when no
    published Foray can play). */
function testTrackNoticeHtml() {
  if (!showDraftsOn()) return "";
  return `<p class="today-notice note">Showing draft Forays — test track. <a href="#/forays">See them under Forays</a>.</p>`;
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
/* TODAY (Redesign 2026, Tactile, screen "home", branch                  */
/* redesign/tactile-home). docs/redesign-2026/directions/tactile/        */
/* BUILD-NOTES.md 4.1 is the spec; the prototype's #/home the target.    */
/* ==================================================================== */

/* Top to bottom: the header (title, the date, the knob), Resume (only while a
   listen is part-played), Today's foray, Also today, Playlists for you, New
   ground. There is no "Suggested" heading any more: its slot is "Also today",
   three picks and the Stretch bridge.

   WHAT FELL, said once (docs/redesign-2026/test-classification.md section 0,
   "Home section order and content", U-03; founder 2026-09-18 and 09-24): the
   five-section order, the greeting, the "Jump back in" rail, the "Forays for
   you" rail, the "Suggested" cards and Home's one play capsule. The floor did
   not fall: the Stretch slot is always present on Also today, carries its
   bridge sentence, and the sentence is never a taste-match reason.

   EVERY CONTROL HERE IS THE APP'S OWN ENGINE'S. A Play key is `[data-play]`
   (bindPlay, the player's syncCardButtons), "+ Up Next" is `[data-upnext]`
   (bindUpNext), the hero's Play key and Resume's Foray key are `[data-home-play]`
   (bindHomePlay), the knob is the drawer's opener (`#today-knob`, menuOpener).
   The markup comes from ui/primitives.js; nothing here draws a button of its
   own. */

const TODAY_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TODAY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 5 Oct". Written out, not toLocaleDateString: the readout is mono, and its
    shape must not move with the device's language. */
function todayDateLine(now = new Date()) {
  return `${TODAY_DAYS[now.getDay()]} ${now.getDate()} ${TODAY_MONTHS[now.getMonth()]}`;
}

/* The date is a fact about NOW, and a page left open overnight kept yesterday's
   (the greeting had the same defect, audit 2026-09-22, qa row 193). `refreshTodayDate`
   runs from the foreground hook in init() and rewrites the one line, only when it
   changed, not the whole of Home under the listener's thumb. */
function refreshTodayDate(now = new Date()) {
  const el = document.querySelector("[data-today-date]");
  if (el) setStatusText(el, todayDateLine(now));
}

const TODAY_ALSO_ROWS = 3;      // the picks before the bridge card
const TODAY_PLAYLISTS = 4;      // two rows of two
const TODAY_WHY_WORDS = 18;     // the why-line ceiling (CLAUDE.md copy rules)
const TODAY_BRIDGE_WORDS = 16;  // the bridge sentence ceiling (BUILD-NOTES 3.8)

function wordCount(text) { return String(text || "").trim().split(/\s+/).filter(Boolean).length; }

/** Two letters for artwork that has no image, the same code a band's station
    label uses. */
function todayInitials(name) { return tactileStationCode(name); }

/** One episode as the row primitive's data. `duration` is "" for an episode
    whose length is unknown (never the specimen's default). `playable` and
    `queueable` mirror what playBtn and upNextBtn refuse, so a row never offers a
    control that does nothing. */
function todayEpisodeData(item, { ctx, why = "", branch = "" } = {}) {
  const mins = episodeMinutes(item);
  return {
    branch, id: item.id, ctx, link: "episode", title: item.title || "this episode", show: item.show || "",
    duration: fmtDur(mins), artwork: item.artwork_url || "", initials: todayInitials(item.show),
    why, queued: isQueued(item.id),
    playable: Boolean(item.audio_url),
    queueable: isQueued(item.id) || Boolean(item.audio_url) || Boolean(liveEpisode(item.id)),
  };
}

/** Today's foray: the first playable Foray, the listener's own pick order first
    (the floor's stretch Foray last, drafts only if nothing else plays). A Foray
    that is already the Resume card is skipped while another can stand in, so the
    same listen is never offered twice on one screen. Null when none resolves,
    and Home then has no hero (nothing says there is one). */
function todayForayPick(picks, resumeEntry = null) {
  const f = picks && picks.forays;
  if (!f) return null;
  const stretch = f.stretchIndex >= 0 ? [f.picks[f.stretchIndex]] : [];
  const ordered = f.picks.filter((_, i) => i !== f.stretchIndex).concat(stretch, f.drafts || []);
  const playable = [];
  for (const foray of ordered) {
    const r = resolveListedForay(foray.id);
    if (r && Array.isArray(r.playable) && r.playable.length) playable.push({ foray, r });
  }
  const skip = resumeEntry && resumeEntry.kind === "foray" ? resumeEntry.id : null;
  return playable.find(p => p.foray.id !== skip) || playable[0] || null;
}

/** The hero's facts, from the running order itself: the band's bars (one per
    clip, the show's name as its colour key, narration as a tick BETWEEN bars), the
    first three shows' artwork, and "about 22 min · 4 shows".

    A generated foray interleaves a bridge with almost every cut, often several in a
    row, so drawn item by item the card's band is a run of 3px ticks with a bar
    between every few of them: a hatched texture, not bars. `mergeNarration` draws each
    run of back-to-back narration as ONE tick sized by the run's total (the founders' own
    fix for the same strip on the Foray page), so a tick is only ever where a clip ends
    and another begins. The card's band is not a scrub target, which is the one reason
    the strip keeps the merge off elsewhere; the accessible label still counts items. */
function todayHeroModel(pick) {
  const { foray, r } = pick;
  const player = window.ForayPlayer;
  const model = typeof player?.stripModel === "function" ? player.stripModel(r.playable, { mergeNarration: true }) : null;
  const items = model && Array.isArray(model.segments) ? model.segments : [];
  const segments = items.map(s => ({
    showId: s.kind === "narration" ? "narration" : (s.show || s.sourceKey || "show"),
    show: s.kind === "narration" ? "" : (s.show || ""),
    duration: s.lengthSec,
    narration: s.kind === "narration",
  }));
  const shows = [...new Set(items.filter(s => s.kind !== "narration" && s.show).map(s => s.show))];
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  const facts = joinMeta(
    forayRuntimeLabel(player, tally, r.totalSec),
    countLabel(tally ? tally.shows : shows.length, "show"),
  );
  const summary = String(foray.summary || "").trim();
  return {
    foray, r, segments, facts,
    discs: shows.slice(0, 3).map(name => ({ url: showArtworkUrl({ title: name }), initials: todayInitials(name) })),
    why: summary && wordCount(summary) <= TODAY_WHY_WORDS ? summary : "",
    bandLabel: tally
      ? `Foray band: ${countLabel(tally.clips + tally.bridges, "clip")} from ${countLabel(tally.shows, "show")}${tally.bridges ? ", with 4a narration between them" : ""}`
      : "Foray band",
  };
}

/** First run is observed, never declared: nothing listened to, nothing to resume.
    DIRECTION.md: the line takes the why-line's slot and never sits beside a
    "Because you follow..." line, which a first-run listener has not earned. */
const TODAY_FIRST_RUN_LINE = "4a starts with wide bets. Each listen narrows the dial.";
function todayIsFirstRun(picks) {
  return pickedHistory().length === 0 && !(picks && picks.jumpBackIn && picks.jumpBackIn.length);
}

function todayBandWidth() {
  /* The hero's inner width: the viewport, less 16px gutters, 20px card padding and
     the well's own 6px. Only the bars' minimum-width arithmetic reads it. */
  const vw = Math.max(280, Math.min(Number(window.innerWidth) || 393, 680));
  return vw - 2 * 16 - 2 * 20 - 2 * 6;
}

function todayHeroHtml(hero, { firstRun = false } = {}) {
  if (!hero) return "";
  const { foray } = hero;
  const path = forayRoutePath(foray.id);
  const discs = hero.discs.map(d => tactileArtFrame({ size: "disc", round: true, url: d.url, initials: d.initials })).join("");
  const why = firstRun ? TODAY_FIRST_RUN_LINE : hero.why;
  return `<section class="card card--hero today-hero" aria-labelledby="today-hero-title">
    <div class="today-hero__eyebrow">${tactileTag({ kind: "narration", text: "Today's foray" })}</div>
    <h2 class="display today-hero__title" id="today-hero-title"><a class="today-hero__link" href="${esc(safeUrl("#" + path))}">${esc(foray.title)}</a></h2>
    <div class="well today-hero__band">${tactileBand({ kind: "mini", segments: hero.segments, renderWidth: todayBandWidth(), label: hero.bandLabel })}</div>
    <div class="today-hero__meta"><span class="today-hero__discs">${discs}</span><span class="readout today-hero__facts">${esc(hero.facts)}</span></div>
    ${why ? `<p class="today-hero__why">${esc(why)}</p>` : ""}
    <div class="today-hero__keys">
      ${tactileKeycap({ size: "xl", variant: "persimmon", round: true, icon: "ph-play-fill", label: `Play ${foray.title}`, data: { "home-play": foray.id } })}
      <a class="keycap keycap--md keycap--paper today-hero__details" href="${esc(safeUrl("#" + path))}"><span class="keycap__label">Details</span></a>
    </div>
  </section>`;
}

/** The Resume card's entry: the most recent part-played Foray or episode, unless
    it is SOUNDING right now (the mini player is already that). A paused one, or
    the one the bar restored at launch, still gets its card: the bar restores the
    last episode on every launch, so hiding the card for "the player holds it"
    would hide it nearly always. A playlist is a way into a running order, not a
    place to resume, so it never stands here. */
function todayResumeEntry(picks) {
  const player = window.ForayPlayer;
  return (picks.jumpBackIn || []).find(c => {
    if (c.kind !== "episode" && c.kind !== "foray") return false;
    if (!(typeof c.percent === "number" && c.percent > 0 && c.percent < 100)) return false;
    try {
      if (c.kind === "episode" && player?.isPlaying?.(c.id)) return false;
      if (c.kind === "foray") {
        const live = player?.forayStatus?.();
        if (live && live.forayId === c.id && live.running) return false;
      }
    } catch (_) { /* a throwing bridge is not "playing" */ }
    return true;
  }) || null;
}

function todayResumeHtml(entry) {
  if (!entry) return "";
  const isForay = entry.kind === "foray";
  let art = "";
  let key = "";
  let id;
  if (isForay) {
    const r = resolveListedForay(entry.id);
    const first = r && Array.isArray(r.playable) ? r.playable.find(i => i && i.show) : null;
    art = first ? showArtworkUrl({ title: first.show }) || "" : "";
    key = r && r.playable && r.playable.length
      ? tactileKeycap({ size: "md", variant: "persimmon", round: true, icon: "ph-play-fill", label: `Resume ${entry.title}`, data: { "home-play": entry.id } })
      : "";
  } else {
    art = (entry.item && entry.item.artwork_url) || "";
    key = entry.item && entry.item.audio_url
      ? tactileKeycap({ size: "md", variant: "persimmon", round: true, icon: "ph-play-fill", swapIcon: "ph-pause-fill", label: `Play ${entry.title}`, data: { play: entry.id, title: entry.title, ctx: "resume" } })
      : "";
  }
  /* Only the route kind and the encoded id are interpolated, and the whole href
     goes through safeUrl (a route passes it; nothing else does). */
  const route = isForay ? "foray" : "episode";
  id = encodeURIComponent(entry.id);
  const pct = Math.max(0, Math.min(100, Number(entry.percent) || 0));
  return `<section class="card today-resume" aria-label="${esc(`Resume: ${entry.title}`)}">
    ${tactileArtFrame({ size: "hero", url: art, initials: todayInitials(entry.title) })}
    <div class="today-resume__body">
      <div class="today-resume__tag">${tactileTag({ kind: "playing", text: "Resume" })}</div>
      <h2 class="today-resume__title"><a class="today-resume__link" href="${esc(safeUrl("#/" + route + "/" + id))}">${esc(entry.title)}</a></h2>
      <div class="today-resume__line"><span class="well today-prog" aria-hidden="true"><span class="today-prog__fill" data-pct="${esc(String(pct))}"></span></span><span class="readout today-resume__left">${esc(entry.left || "")}</span></div>
    </div>
    <div class="today-resume__key">${key}</div>
  </section>`;
}

/** The Stretch bridge, one sentence naming both ends: where the listener already
    is and where this pick goes. It states WHY the pick sits outside their usual
    subjects and never reads as a taste match (D1). Over the word ceiling (two
    long subject names), it falls back to the one-subject sentence. */
function stretchBridgeSentence(knownLabel, stretchLabel) {
  const both = `Outside your usual subjects: from ${knownLabel} into ${stretchLabel}, on purpose.`;
  return wordCount(both) <= TODAY_BRIDGE_WORDS ? both : stretchBridgeText(stretchLabel);
}

/** The gauge's line on a first run: the default says "outside your usual subjects", which
    would declare a habit nothing has observed yet (product principle 2). The gauge stays,
    with a sentence that claims no listener state. 8 words, under the 18 ceiling. */
const TODAY_FIRST_RUN_GAUGE = "About a third of today is new ground, on purpose.";

/** The same sentence for a first run, which has no "usual subjects" to be outside
    of: nothing has been listened to, so claiming a habit would be declaring state
    the app has not observed (product principle 2). It still names both ends by
    subject and still says the change of pace is deliberate. */
function firstRunBridgeSentence(knownLabel, stretchLabel) {
  const both = `A wide bet, on purpose: from ${knownLabel} into ${stretchLabel}.`;
  return wordCount(both) <= TODAY_BRIDGE_WORDS ? both : `A wide bet, on purpose: ${stretchLabel}.`;
}

/** An Also today row's why-line on a first run: about the SUBJECT the pick sits in,
    never about the listener's habits or a show they follow (they have none yet).
    BUILD-NOTES 4.1: "subject-based why-lines (never 'your usual subjects')". */
function firstRunAlsoWhy(branch) {
  const line = `A first look at ${subjectLabel(branch)}, chosen to start wide.`;
  return wordCount(line) <= TODAY_WHY_WORDS ? line : "A first look at a new subject, chosen to start wide.";
}

/** The slots Also today draws: up to three top picks (in the order buildCards
    dealt them), and the one Stretch slot. */
function todayAlsoSlots() {
  const slots = Array.isArray(state.cardSlots) ? state.cardSlots : [];
  return {
    tops: slots.filter(s => s.role !== "stretch" && s.item).slice(0, TODAY_ALSO_ROWS),
    stretch: slots.find(s => s.role === "stretch" && s.item) || null,
  };
}

function todayBridgeData(stretch, tops, { firstRun = false } = {}) {
  /* The "known" end is the dealt top slot the listener's interests rank highest:
     the nearest thing they already like to the pick Home is stretching them to. */
  const known = [...tops].sort((a, b) =>
    interestScore({ topics: [b.branch] }) - interestScore({ topics: [a.branch] }))[0] || null;
  const stretchLabel = subjectLabel(stretch.branch);
  const sentenceFor = firstRun ? firstRunBridgeSentence : stretchBridgeSentence;
  return {
    ...todayEpisodeData(stretch.item, { ctx: "also-today", branch: stretch.branch }),
    sentence: known ? sentenceFor(subjectLabel(known.branch), stretchLabel)
      : (firstRun ? `A wide bet, on purpose: ${stretchLabel}.` : stretchBridgeText(stretchLabel)),
    /* A first run has listened to nothing, so there is no known artwork to show:
       the known end is the subject itself, drawn as a tile (BUILD-NOTES 3.8). */
    knownSubject: firstRun,
    knownArtwork: known && !firstRun ? known.item.artwork_url || "" : "",
    knownTitle: known ? subjectLabel(known.branch) : "",
    knownInitials: known ? todayInitials(subjectLabel(known.branch)) : "KN",
  };
}

function todayAlsoHtml({ firstRun = false } = {}) {
  const { tops, stretch } = todayAlsoSlots();
  if (!tops.length && !stretch) return "";
  const rows = tops.map(s => tactileEpisodeRow(todayEpisodeData(s.item, { ctx: "also-today", why: firstRun ? firstRunAlsoWhy(s.branch) : s.item.hook || "", branch: s.branch })));
  const bridge = stretch ? tactileBridgeCard(todayBridgeData(stretch, tops, { firstRun })) : "";
  /* The bridge sits second, as in the prototype: a row, the bridge, the rest. */
  const ordered = rows.length ? [rows[0], bridge, ...rows.slice(1)] : [bridge];
  return `<section class="today-sect today-also" aria-labelledby="today-also-title">
    <h2 class="heading" id="today-also-title">Also today</h2>
    <div class="today-rows">${ordered.filter(Boolean).join("")}</div>
  </section>`;
}

/** A playlist card's four artworks: distinct shows first, the same show again
    only to fill the grid. One artwork fills the whole tile. */
function todayCollageHtml(items) {
  const seen = new Set();
  const urls = [];
  for (const it of items) {
    const url = it && it.artwork_url;
    if (url && !seen.has(it.show || url)) { seen.add(it.show || url); urls.push({ url, initials: todayInitials(it.show) }); }
  }
  for (const it of items) {
    if (urls.length >= 4) break;
    if (it && it.artwork_url && !urls.some(u => u.url === it.artwork_url)) urls.push({ url: it.artwork_url, initials: todayInitials(it.show) });
  }
  if (!urls.length) return `<span class="today-collage today-collage--empty">${tactileArtFrame({ size: "row", initials: "4a" })}</span>`;
  if (urls.length === 1) return `<span class="today-collage today-collage--one">${tactileArtFrame({ size: "row", url: urls[0].url, initials: urls[0].initials })}</span>`;
  const cells = [];
  for (let i = 0; i < 4; i += 1) cells.push(urls[i % urls.length]);
  return `<span class="today-collage">${cells.map(c => tactileArtFrame({ size: "row", url: c.url, initials: c.initials })).join("")}</span>`;
}

/** One playlist card. Own playlists render exactly like a generated one (shared
    shape, #276); a generated one carries the "Generated for you" tag D5 requires
    so a listener never mistakes a grouping 4a made for one they built. "N of M
    played" is stated only when N is not zero (copy-13). */
function todayPlaylistCardHtml(p, { generated = false, history }) {
  /* Family Mode holds an episode back from the artwork too: the card's count
     stays true (a held-back part keeps its place), but its picture is only of
     what the listener may see (resolveParts state "live"). */
  const rows = resolveParts(p).filter(r => r.item);
  const total = rows.length || (p.items || []).length;
  const played = rows.filter(r => hasOpened(r.item.id, history)).length;
  const pct = total && played ? Math.round((played / total) * 100) : 0;
  const meta = joinMeta(countLabel(total, "episode"), total && played ? `${played} of ${total} played` : "");
  return `<a class="today-pcard" href="${esc(safeUrl("#/" + playlistRoute(p)))}">
    ${todayCollageHtml(rows.filter(r => r.state === "live").map(r => r.item))}
    <span class="today-pcard__name">${esc(p.title || p.name || "Playlist")}</span>
    <span class="readout today-pcard__meta">${esc(meta)}</span>
    <span class="well today-prog" aria-hidden="true"><span class="today-prog__fill" data-pct="${esc(String(pct))}"></span></span>
    ${generated ? `<span class="tag tag--narration today-pcard__badge">Generated for you</span>` : ""}
  </a>`;
}

function todayPlaylistsHtml({ own, generated }) {
  if (!own.length && !generated.length) return "";
  const history = new Set(pickedHistory());
  const cards = own.map(p => ({ p, generated: false })).concat(generated.map(p => ({ p, generated: true })))
    .slice(0, TODAY_PLAYLISTS)
    .map(c => todayPlaylistCardHtml(c.p, { generated: c.generated, history }));
  return `<section class="today-sect today-playlists" aria-labelledby="today-playlists-title">
    <h2 class="heading" id="today-playlists-title">Playlists for you</h2>
    <div class="today-pgrid">${cards.join("")}</div>
  </section>`;
}

function todayHeaderHtml() {
  /* The knob is the one pressable control on the header, so it is a real paper
     keycap in EVERY state, boot skeleton included (the prototype's loading Today
     keeps it a raised key in full ink; a flat tile read as a disabled
     placeholder). At boot the drawer is not bound yet: app.js's paintBootLoading
     remembers a press and opens the drawer once it is (settleBootKnob). */
  return `<header class="today-top">
    <div class="today-top__title"><h1 class="display-xl today-title" tabindex="-1">Today</h1><span class="readout today-top__date" data-today-date>${esc(todayDateLine())}</span></div>
    ${tactileKeycap({ size: "sm", variant: "paper", icon: "knob", label: "Settings and dials", id: "today-knob" })}
  </header>`;
}

/** Today BEFORE its documents land (Tactile `home-loading`, BUILD-PLAN 2.8).
    app.js paints this into `#view` at boot, in place of the "Loading 4a…" line,
    when the address is Today; renderHomeV2() replaces it wholesale.

    The real title row stays (it is a fact that needs no data); everything the
    documents decide is drawn as the SHAPE of what is coming, at the loaded
    layout's own sizes, so the swap moves nothing (the hero's outer height is
    pinned within 4px by test/tactile-home-loading.test.js and by the harness
    state `loading`). The region is ONE busy region: `aria-busy="true"`, every
    skeleton block `aria-hidden`, nothing here is a link, and the knob is the one control.
    `data-boot-loading` is what tools/mobile/webview-probe.mjs reads as "app.js
    ran but the first page has not landed"; it must stay on this root. */
function todayLoadingHtml() {
  const sk = (kind) => tactileSkeleton(kind, { decorative: true });
  /* The loaded order is row, the Stretch bridge, row, row (todayAlsoHtml). */
  const row = tactileSkeleton("row", { decorative: true, why: true });
  return `<div class="today today--loading" data-boot-loading role="region" aria-label="Today" aria-busy="true">
    ${todayHeaderHtml()}
    ${sk("hero")}
    <div class="today-sect" aria-hidden="true">
      <h2 class="heading">Also today</h2>
      <div class="today-rows">${row}${sk("bridge")}${row}${row}</div>
    </div>
    <div class="today-sect" aria-hidden="true">
      <h2 class="heading">Playlists for you</h2>
      <div class="today-pgrid">${sk("card")}${sk("card")}</div>
    </div>
  </div>`;
}

/* The knob opens the Settings sheet (ui/settings.js; it opened the drawer until
   the Settings screen landed, and the sheet's "More settings" hands over to the
   drawer). It names what it controls and whether it is open, like the topbar's
   ☰ does. */
function bindTodayKnob(scope) {
  const knob = scope && typeof scope.querySelector === "function" ? scope.querySelector("#today-knob") : null;
  if (!knob || knob._bound) return;
  knob._bound = true;
  knob.setAttribute("aria-controls", "settings-sheet");
  knob.setAttribute("aria-expanded", "false");
  knob.addEventListener("click", () => openSettingsSheet(knob));
}

/** The press on a Foray key (the hero's, or Resume's). The Foray is resolved at
    the press, never captured at render, so a draft that has since left the list
    is not started from a stale card. */
function bindHomePlay(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll("[data-home-play]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      const r = resolveListedForay(btn.dataset.homePlay);
      if (!r || !Array.isArray(r.playable) || !r.playable.length) return;
      return playHomeTarget({ kind: "foray", r }, btn);
    });
  });
}

function renderHomeV2() {
  setBodyClass("view-home");
  if (!state.cardSlots.length) buildCards();
  const picks = homeRailPicks();
  const resume = todayResumeEntry(picks);
  const pick = todayForayPick(picks, resume);
  const firstRun = todayIsFirstRun(picks);
  $("#view").innerHTML = `
    <div class="today">
      ${todayHeaderHtml()}
      ${testTrackNoticeHtml()}
      ${todayResumeHtml(resume)}
      ${todayHeroHtml(pick ? todayHeroModel(pick) : null, { firstRun })}
      ${todayAlsoHtml({ firstRun })}
      ${todayPlaylistsHtml(picks.playlists)}
      ${tactileGauge(firstRun ? { copy: TODAY_FIRST_RUN_GAUGE } : {})}
    </div>`;

  offerHomeOnboarding();

  sizeProgressBars($("#view"));
  bindTodayKnob($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
  bindHomePlay($("#view"));
}
