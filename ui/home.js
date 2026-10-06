/* ui/home.js — Home (#/): greeting, Jump back in, Forays / Playlists / Suggested rails.
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

/* What actually connects the episodes in a subject queue is one fact: they
   share a taxonomy branch. Say that plainly via the real shows involved,
   rather than implying a curatorial narrative ("the fusion reactor tour")
   the grouping doesn't actually have. */
function subjectBlurb(slot) {
  const shows = [...new Set(slot.items.map(it => it.show))];
  if (shows.length === 1) return `All from ${shows[0]}.`;
  if (shows.length === 2) return `From ${shows[0]} and ${shows[1]}.`;
  return `From ${shows[0]}, ${shows[1]}, and ${shows.length - 2} more.`;
}

/* "Starts with …" LEADS the hook, and closes its own sentence only when the
   title has not already. Two defects, one line (audit 2026-09-22, qa rows 136 and
   148): the full stop was appended unconditionally, so 210 of the pool's 2,167
   titles read `Starts with "…Save The World?."`; and the clause came AFTER the
   blurb, so on a short screen — where styles.css clamps the hook to one line —
   the episode title, the one concrete thing the card says, was the part cut. */
function startsWithLine(title) {
  const t = String(title || "").trim();
  return `Starts with ${quoteQuery(esc(t) + (/[.?!…]$/.test(t) ? "" : "."))}`;
}

/** Why a Stretch card is there, as a sentence the listener can read on a phone
    (audit round 2, a11y-11 — it was a tooltip). Uppercase "Outside" on purpose:
    the returning-listener popup's own sentence is the lowercase one, and
    test/listener-copy.test.js finds that one by its case. */
const STRETCH_WHY = "Outside your usual subjects, on purpose.";

function miniCard(slot) {
  const item = slot.item;
  /* ONE POPULATION FOR THE COUNT AND THE DURATION (audit 2026-09-22). `|| 0`
     summed only the episodes whose length is known and printed that beside a
     count of all of them — "3 episodes · 1h 20m" when one of the three had no
     `duration_min` (8 such items ship in data/discover.json). A total is stated
     only when it is a total; otherwise the line keeps the count alone. */
  const allTimed = slot.items.length > 0 && slot.items.every(it => episodeMinutes(it) > 0);
  const totalMin = allTimed ? slot.items.reduce((s, it) => s + episodeMinutes(it), 0) : 0;
  /* The tag is the word; the reason is visible text in the hook (below), not a
     `title=` tooltip a phone never shows (audit round 2, a11y-11). */
  const stretch = slot.role === "stretch";
  const stretchTag = stretch ? `<span class="mc-stretch">Stretch</span>` : "";
  /* A CARD WITH A STRETCHED LINK (audit 2026-09-22, qa row 78). The card used
     to be the <a>, with the star <button> nested inside it — invalid HTML that a
     screen reader read as one link named "Education … Save", and whose star
     only avoided following the link through bindStars' preventDefault. The
     subject title is now the one real <a>; styles.css stretches its ::after
     over the card, and the star is a sibling lifted above it. */
  return `<div class="mini-card" data-branch="${esc(slot.branch)}">
    ${item.artwork_url ? `<img src="${esc(safeUrl(artUrl(item.artwork_url, CARD_ART_PX)))}" alt="" loading="lazy" decoding="async" width="56" height="56">` : `<div class="art-ph"></div>`}
    <div class="mc-info">
      <p class="mc-kicker">${stretchTag}${joinMeta(countLabel(slot.items.length, "episode"), fmtDur(totalMin))}</p>
      <h3><a class="mc-link" href="#/${esc(playlistRoute({ isSubject: true, branch: slot.branch }))}">${esc(subjectLabel(slot.branch))}</a></h3>
      <p class="mc-hook">${startsWithLine(item.title)} ${esc(subjectBlurb(slot))}${stretch ? ` ${STRETCH_WHY}` : ""}</p>
    </div>
    ${starBtn(item.id)}
  </div>`;
}

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

function greetingWord(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/* The greeting is a fact about NOW, and a page left open overnight kept saying
   "Good evening" at 7am (audit 2026-09-22, qa row 193): it was computed once per
   render and nothing re-rendered Home on return. `refreshGreeting` runs from the
   foreground hook in init() and rewrites the one word, only when it changed —
   not the whole of Home under the listener's thumb. */
function refreshGreeting(now = new Date()) {
  const el = document.querySelector(".hv2-greeting-word");
  if (el) setStatusText(el, greetingWord(now));
}

function homeGreeting() {
  const word = greetingWord();
  return `<div class="hv2-greeting">
    <span class="hv2-greeting-word">${word}</span>
    <span class="hv2-greeting-brand">4a</span>
  </div>`;
}

/* ---------- Home's one play button ----------

   FOUNDER, 2026-09-24: "Add a play button at the Home Screen level and start
   playing whatever is first in that list (whether it be Suggested or a
   Playlist or whatever)".

   ONE control under the greeting. It plays the first PLAYABLE thing on Home,
   walking the rails in the order Home draws them — Jump back in, Forays for
   you, Playlists for you, Suggested — and within a rail, its cards in order. A
   rail whose cards cannot play (a Foray that does not resolve, a playlist whose
   episodes have all left the catalogue) is passed over rather than stopped at:
   a button that names a thing and then fails is worse than one that names the
   next thing. It is not rendered at all only when nothing on Home can play.

   Each kind starts the way its own page starts it, through the same code:
     foray     the Foray page's main button — `playForay`, resuming where the
               listener left it (`forayResume`), else from the top;
     episode   a row's ▶ (`startEpisodePlay`);
     playlist  its first playable row, with the playlist's rows as the list
               continuous playback goes on through — a saved playlist, a
               generated one, or a Suggested subject queue alike (the detail
               page's `playlistCtx`, so a real playlist's `last_played_at` is
               stamped exactly as a row's ▶ stamps it).

   Its name says what it will play ("Play <title>"), because "Play" alone on a
   screen of twenty things answers nothing. */

/** Home's rails as candidate lists, in render order. Each rail is the data the
    rail itself draws from, so the order cannot drift from what is on screen. */
/* `picks` is renderHomeV2's one computation of the rails' contents (audit round
   3, app-2-12): computed once per render and handed to the button AND the rail
   renderers, instead of each of them re-running every pick (generatedPlaylists
   walks and sorts the whole pool) a second time. Absent, each is computed here,
   as before. */
function homePlayRails(picks = homeRailPicks()) {
  const rails = [];
  rails.push(picks.jumpBackIn.map(c =>
    c.kind === "foray" ? { kind: "foray", id: c.id, title: c.title }
      : c.kind === "episode" ? { kind: "episode", item: c.item, title: c.title }
        : { kind: "playlist", playlist: playlistById(c.id) }));
  const forays = picks.forays;
  rails.push(forays ? forays.picks.concat(forays.drafts).map(f => ({ kind: "foray", id: f.id, title: f.title })) : []);
  const { own, generated } = picks.playlists;
  rails.push(own.concat(generated).map(p => ({ kind: "playlist", playlist: p })));
  rails.push((state.cardSlots || []).map(slot => ({ kind: "playlist", playlist: subjectQueueById("subject-" + slot.branch) })));
  return rails;
}

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

/** What Home's play button will play, or null (nothing on Home can). */
/** Every Home rail's picks, once. */
function homeRailPicks() {
  return { jumpBackIn: jumpBackInEntries(), forays: foraysForYouPicks(), playlists: playlistsForYouPicks() };
}

function homePlayTarget(picks) {
  for (const rail of homePlayRails(picks)) {
    for (const c of rail) {
      const t = homePlayable(c);
      if (t) return t;
    }
  }
  return null;
}

/* The target the rendered button names. Set at render time and read at the
   press, so the press plays exactly what the label promised. */
let homePlayPending = null;

function homePlayHtml(picks) {
  const t = homePlayTarget(picks);
  homePlayPending = t;
  if (!t) return "";
  return `<div class="hv2-play-row">
    <button type="button" class="hv2-play" data-home-play aria-label="${esc(`Play ${t.title}`)}">
      <span class="hv2-play-glyph" aria-hidden="true">▶</span>
      <span class="hv2-play-text">Play</span>
      <span class="hv2-play-title">${esc(t.title)}</span>
    </button>
  </div>`;
}

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

/** "Jump back in": forayResumeRows() plus the ordinary-episode continue
    banner, as one horizontal scroller — the mockup's own shape for this
    section (docs/ux/foray-mockup.jsx `HomeScreen`'s first row). Degrades
    to "" when neither has anything to resume, so the section simply does
    not render rather than showing an empty rail. */
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
function jumpBackInV2Html(cards = jumpBackInEntries()) {
  if (!cards.length) return "";
  return `<section class="hv2-section hv2-jbi">
    <h2 class="hv2-title">Jump back in</h2>
    <div class="hv2-hscroll">${cards.map(c => jumpBackInCardHtml(c, { inSection: true })).join("")}</div>
  </section>`;
}

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

/* A TAG NAMES WHAT ITS SECTION DOES NOT (audit round 2, visual-9). Every card
   in Home's "Jump back in" rail opened with an amber JUMP BACK IN tag directly
   under the "Jump back in" heading — the section's name, restated on each card
   in it. `inSection` is the renderer saying "the heading above already says
   this"; a card on a MIXED surface (a rail of several kinds, a search result)
   leaves it off and keeps the tag, which is the one place it tells the
   listener something. */
function jumpBackInCardHtml(c, { inSection = false } = {}) {
  const bar = typeof c.percent === "number"
    ? `<span class="fy-bar"><span class="fy-bar-fill" data-pct="${esc(String(c.percent))}"></span></span>`
    : "";
  const left = c.left ? `<span class="hv2-jbi-left">${esc(c.left)}</span>` : "";
  const sub = c.sub ? `<span class="hv2-jbi-sub">${esc(c.sub)}</span>` : "";
  /* The `picked` logging attributes ride on the episode card only, as before —
     a Foray and a playlist are not pool episodes and `bindPickLogging`'s
     handler reads `data-ep` as an episode id. */
  const ev = c.kind === "episode"
    ? ` data-ev="picked" data-ep="${esc(c.id)}" data-ctx="jbi-episode"`
    : "";
  /* PLAY WITHOUT OPENING THE EPISODE (founder, 2026-09-21: "It would be good if
     there were a play button directly on that card, as it is I need to press the
     card then press play").

     Episodes only. A Foray and a playlist are sequences whose card is a way IN to
     a running order, and a one-tap play on either would be choosing a starting
     point on the listener's behalf; an episode has exactly one thing to play.

     `playBtn` is the same control every row and card already uses, so it inherits
     `bindPlay` (already called on this page) and with it the `preventDefault` +
     `stopPropagation` that stops the press ALSO following the card's own link —
     the exact reason that handler has them. It renders "" when the item has no
     `audio_url`, which is the honest outcome for a card we cannot play from.

     `lastEpisodeCard` has already `snapshot()`ed the row into `state.itemIndex`,
     which is where `bindPlay` looks the id up — so the button can play an episode
     the catalogue has never heard of, which is the whole point of the pointer. */
  const play = c.kind === "episode" ? playBtn(c.item, "jbi-episode") : "";
  const id = esc(encodeURIComponent(c.id));
  /* THE `#/` IS LITERAL IN THE TEMPLATE, and only the route segment and the id
     are interpolated — the form every other link in this file uses.

     Two earlier drafts got this wrong and the security suite caught both. The
     first built one `c.href` string and interpolated it whole, which
     "every interpolated href and src passes through safeUrl" rejects. The
     obvious repair — wrapping it in `safeUrl` — would have been WORSE than
     noisy: `safeUrl` admits http(s) only and answers "#" for anything else, so
     every in-app route here would have become a dead link. The real rule
     underneath that test is that a link's SCHEME must be fixed by the code and
     never carried in data, and a literal `#/` prefix is how this file says so. */
  const route = c.kind === "foray" ? "foray" : c.kind === "playlist" ? "playlist" : "episode";
  /* A CARD WITH A STRETCHED LINK (audit 2026-09-22, qa row 78): the title is
     the one real <a> (styles.css stretches its ::after over the card) and the
     play button is its SIBLING, lifted above it — not a <button> inside an <a>,
     which is invalid HTML that reads as "link, …, Play …" to a screen reader
     and only behaved on a pointer because bindPlay calls preventDefault. The
     `picked` attributes ride on the link, which is what bindPickLogging binds. */
  return `
    <div class="hv2-jbi-card">
      ${inSection ? "" : `<span class="hv2-jbi-kicker">Jump back in</span>`}
      <a class="hv2-jbi-title hv2-jbi-link" href="#/${route}/${id}"${ev}>${esc(c.title)}</a>
      ${sub}${bar}${left}${play}
    </div>`;
}

/** One Foray card for "Forays for you", carrying its SegmentStrip (U-04) —
    the one component the plan names as what makes a Foray legible as a
    different object from an episode. Resolves each Foray through the same
    bridge welcomeStripHtml() (U-09) already uses; a Foray whose segments
    fail to resolve degrades to a card with no strip, never an error, same
    contract as that function's own try/catch. `stretch` renders the
    visible label plus the required bridge line naming the Foray's own
    subject; a non-stretch card gets neither. */
function forayCardV2Html(foray, { stretch = false, draft = false } = {}) {
  const player = window.ForayPlayer;
  const r = resolveListedForay(foray.id);
  let stripHtml = "";
  if (r && typeof player?.segmentStripHtml === "function") {
    try {
      /* mergeNarration — same reason as welcomeStripHtml() above: a card is not
         a scrub target, so a run of bridges may be one bar. */
      stripHtml = player.segmentStripHtml(r.playable, { size: "sm", mergeNarration: true }) || "";
    } catch (_) {
      stripHtml = ""; // malformed segments/sources must not break Home
    }
  }
  /* How long, and what it is made of (audit round 2, p-foray-8): the card was
     a title and a strip, and the strip's length is only in its aria-label. */
  const facts = forayFactsLabel(r, player);
  const subject = subjectLabel((foray.topic || "").split("/")[0]);
  return `<a class="hv2-foray-card${stretch ? " hv2-stretch" : ""}" href="#${esc(forayRoutePath(foray.id))}">
    ${stretch ? `<span class="hv2-stretch-tag">Stretch</span>` : ""}
    ${draft ? `<span class="hv2-draft-tag">draft</span>` : ""}
    <span class="hv2-foray-title">${esc(foray.title)}</span>
    ${facts ? `<span class="hv2-foray-sub">${esc(facts)}</span>` : ""}
    ${stripHtml}
    ${stretch ? `<p class="hv2-bridge">${stretchBridgeLine(subject)}</p>` : ""}
  </a>`;
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

function foraysForYouHtml(pick = foraysForYouPicks()) {
  if (!pick) return "";
  const { picks, stretchIndex, drafts } = pick;
  return `<section class="hv2-section hv2-forays">
    <h2 class="hv2-title">Forays for you</h2>
    <div class="hv2-hscroll">${picks.map((f, i) => forayCardV2Html(f, { stretch: i === stretchIndex })).join("")}${drafts.map(f => forayCardV2Html(f, { draft: true })).join("")}</div>
  </section>`;
}

/** The one-line notice Home carries while the test track is on, so a device
    left with the switch flipped says so on the first screen rather than
    quietly listing work nobody published. */
function testTrackNoticeHtml() {
  if (!showDraftsOn()) return "";
  return `<p class="hv2-test-track note">Showing draft Forays — test track</p>`;
}

/** One playlist card for "Playlists for you" — own recent playlists render
    exactly like a subject queue's card (shared shape, #276), generated
    ones carry the "Generated for you" badge D5 requires so a listener
    never mistakes a generated grouping for one they built. */
function playlistCardV2Html(p, { generated = false } = {}) {
  const count = (p.items || []).length;
  return `<a class="hv2-playlist-card" href="#/${esc(playlistRoute(p))}">
    ${generated ? `<span class="hv2-generated-badge">Generated for you</span>` : ""}
    <span class="hv2-playlist-title">${esc(p.title)}</span>
    <span class="hv2-playlist-sub">${countLabel(count, "episode")}</span>
  </a>`;
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

function playlistsForYouHtml({ own, generated } = playlistsForYouPicks()) {
  if (!own.length && !generated.length) return "";
  const cards = own.map(p => playlistCardV2Html(p, { generated: false }))
    .concat(generated.map(p => playlistCardV2Html(p, { generated: true })));
  return `<section class="hv2-section hv2-playlists">
    <h2 class="hv2-title">Playlists for you</h2>
    <div class="hv2-hscroll">${cards.join("")}</div>
  </section>`;
}

/** One episode card for "Suggested" — miniCard()'s existing markup
    plus the visible bridge line D1's copy rule requires on a stretch
    slot, which miniCard() itself does not render (its "Stretch" tag is a
    hover-only `title`, pinned as-is elsewhere and left untouched here).
    Composes rather than forks: the card body is exactly miniCard(slot),
    with the bridge line appended after it for a stretch slot only. */
function miniCardV2(slot) {
  const card = miniCard(slot);
  if (slot.role !== "stretch") return card;
  // Insert the bridge line just before the card's closing tag.
  const bridge = `<p class="hv2-bridge">${stretchBridgeLine(subjectLabel(slot.branch))}</p></div>`;
  return card.replace(/<\/div>$/, bridge);
}

/** "Suggested": buildCards()'s ranked discover-pool picks, i.e.
    state.cardSlots verbatim — the SAME floor buildCards() already
    computes for the flag-off four-card Home, so this section and that
    one can never disagree about which slot is the stretch. renderHomeV2()
    guarantees state.cardSlots is already built before this runs (same as
    v1's own renderHome()), so this only guards a caller that invokes this
    function directly (e.g. a future test). */
function suggestedHtml() {
  if (!state.cardSlots.length) return "";
  return `<section class="hv2-section hv2-suggested">
    <h2 class="hv2-title">Suggested</h2>
    <div class="hv2-cards">${state.cardSlots.map(miniCardV2).join("")}</div>
  </section>`;
}

function renderHomeV2() {
  setBodyClass("view-home");
  if (!state.cardSlots.length) buildCards();
  const picks = homeRailPicks();
  $("#view").innerHTML = `
    <div class="home hv2-home">
      ${homeGreeting()}
      ${homePlayHtml(picks)}
      ${testTrackNoticeHtml()}
      ${jumpBackInV2Html(picks.jumpBackIn)}
      ${foraysForYouHtml(picks.forays)}
      ${playlistsForYouHtml(picks.playlists)}
      ${suggestedHtml()}
    </div>`;

  offerHomeOnboarding();

  sizeProgressBars($("#view"));
  if (window.ForayPlayer && typeof window.ForayPlayer.applyStripGrow === "function") {
    window.ForayPlayer.applyStripGrow($("#view"));
  }

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindUpNext($("#view"));
  bindPlay($("#view"));
  bindHomePlay($("#view"));
}
