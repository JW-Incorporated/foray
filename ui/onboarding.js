/* ui/onboarding.js — First-run onboarding: subject picks, personas, the first-time explainer and intro popup.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* First-time explanation/consent screen (docs/ux/foray-m3-prototype.html +
   docs/ux/README.md § "First-time vs. returning user"). Ports the INTENT of
   the prototype's `V.signinNew` screen into the shipped stack — not a literal
   port, same relationship PR #357's intro-popup fix already established.

   This is deliberately a SEPARATE gate from showIntroPopupOnce()'s
   cp_intro_dismissed flag. That flag alone is not a real "never used this
   app" signal — it also flips true the moment this screen (or the old popup)
   is dismissed, and a fresh device with a corrupted/partial localStorage
   write could have history but no dismissed flag. The real signal is the
   absence of any trace of prior use: no history, no saves, no playlists.
   `cp_intro_dismissed` is intentionally NOT part of this check — this screen
   must never reappear for an existing user just because that one flag is
   unset (see the test for exactly that case). */
function isGenuineFirstTimeUser() {
  return (
    pickedHistory().length === 0 &&
    Object.keys(savedMap()).length === 0 &&
    playlists().length === 0
  );
}

/* A PLAYING FORAY DEFERS ONBOARDING; IT DOES NOT RECLASSIFY THE LISTENER
   (audit round 2, p-first-5, and its review). A newcomer whose whole use of 4a
   was a shared Foray link met the Welcome sheet over their own playing Foray.
   The first fix counted the Foray's resume row as prior use — which sent the
   same newcomer to the RETURNING-user popup instead (still a modal over the
   Foray), and its "Got it" then wrote `cp_intro_dismissed`, so the Welcome and
   Preferences steps — the interest picks that re-deal Home — never showed on
   any later visit: the product's one viral path always skipped the survey.
   The listener is still first-time; the sheets simply wait while a Foray is
   sounding (or loading, or in its seam beat), and the next Home after it
   stops offers them. Read through the bridge; an absent or older module has
   no Foray to wait for. */
function forayHoldsOnboarding() {
  try {
    const s = window.ForayPlayer && typeof window.ForayPlayer.forayStatus === "function"
      ? window.ForayPlayer.forayStatus() : null;
    return Boolean(s && !s.ended && (s.running || s.playing || s.loading || s.gap));
  } catch (_) { return false; }
}

/** Home's onboarding: the first-run sheet for a genuine newcomer, else the
    returning-user popup — neither while a Foray is playing. */
let onboardingAfterSettle = false;
function offerHomeOnboarding() {
  /* NOT BEFORE THE STORE HAS ANSWERED (app-1-1): "genuine first-time user" is
     read from cp_history / cp_saved / cp_playlists, and before hydration a
     returning listener's are simply not in memory yet -- they were offered the
     first-run sheet. Offered again once it settles, if Home is still up. */
  if (storageWaiting()) {
    if (!onboardingAfterSettle) {
      onboardingAfterSettle = true;
      afterStorageSettles(() => { onboardingAfterSettle = false; if (currentHash() === "#/") offerHomeOnboarding(); });
    }
    return;
  }
  if (onboardingHeld || forayHoldsOnboarding()) return;
  if (!showFirstTimeExplainerOnce()) showIntroPopupOnce();
}

/* ---------- U-09: Preferences chips — subtree write path ----------

   docs/curation/interest-survey-plan.md §4.1: an answer is a SUBTREE
   expansion, never an exact match on the chip's own root id — tagging depth
   is inconsistent (some subjects are tagged only on the root, e.g.
   `true-crime`; others only on children, e.g. `engineering`), so writing just
   the root would silently miss the pool entirely for half the chips. The
   taxonomy is capped at two levels (root -> leaf, taxonomy-review-2026-08.md
   §3.5), so one parent-lookup covers every descendant — no recursion needed. */
function expandTaxonomyPick(rootId) {
  return taxonomyNodes().filter(n => n.id === rootId || n.parent === rootId).map(n => n.id);
}

/* §4.3: SEED_LIFT = 0.20, damped by /sqrt(d) so picking many chips doesn't
   overwhelm any one of them ("I like everything" should barely move anything)
   — worth about four finishes or two and a half thumbs-ups (§4.4), never a
   fact. Added on top of whatever loadInterests() already seeded (authored
   default or a returning-format restore), never a replacement value, and
   through the same clamp nudgeTopics uses elsewhere. */
const ONBOARDING_SEED_LIFT = 0.20;

/** THE TYPED SUBJECT, RESOLVED (audit round 2, p-first-3). The field used to
    accept only an exact top-level label, so "health", "news", "travel" and
    "cooking" — the words a newcomer types — matched nothing: 24 of the 41
    roots are not chips and most carry compound labels ("Health & Fitness").
    Now a typed word matches a label whole (case-insensitive), then any WORD of
    a root's label, then any word of a leaf's label ("cooking" -> Cooking
    Science under Food). Roots before leaves, so "science" is the Science root
    and not Materials science. Returns the node, or null when nothing in the
    taxonomy answers to the word — never an invented node nothing in the pool
    carries. */
function resolveTypedSubject(typed) {
  const q = String(typed || "").trim().toLowerCase();
  if (!q) return null;
  const nodes = taxonomyNodes();
  const words = (n) => String(n.label || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const exact = nodes.find(n => String(n.label || "").toLowerCase() === q);
  if (exact) return exact;
  const roots = nodes.filter(n => n.parent === null);
  const leaves = nodes.filter(n => n.parent !== null);
  return roots.find(n => words(n).includes(q)) || leaves.find(n => words(n).includes(q)) || null;
}

/** Applies a Preferences pick: `pickedRootIds` from the chip grid, plus an
    optional typed subject (see resolveTypedSubject) — the mockup's "Or type
    a subject yourself…" field reaches the same write path a chip tap would.
    Returns false (no write, no _interestsGen bump) when nothing was picked
    and nothing typed matched, so a caller can tell a real Skip from a
    Continue with an empty/unmatched form; otherwise the ROOT ids the picks
    resolved to (a typed leaf counts for its root), which the re-deal reserves
    slots for. */
function applyOnboardingPicks(pickedRootIds, typedSubject) {
  const ids = [...(pickedRootIds || [])];
  const typedNode = resolveTypedSubject(typedSubject);
  if (typedNode && !ids.includes(typedNode.id)) ids.push(typedNode.id);
  if (!ids.length) return false;

  const lift = ONBOARDING_SEED_LIFT / Math.sqrt(ids.length);
  const targets = new Set(ids.flatMap(expandTaxonomyPick));
  targets.forEach(id => {
    if (id in state.interests) {
      setInterest(id, Math.max(0, Math.min(1, state.interests[id] + lift)));
    }
  });
  saveInterests();
  state._interestsGen = (state._interestsGen || 0) + 1;
  const byId = new Map(taxonomyNodes().map(n => [n.id, n]));
  return [...new Set(ids.map(id => (byId.get(id)?.parent) || id))];
}

/* ---------- PKG-13: personas as a cold-start prior (#70) ----------

   data/personas.json (loaded at init into state.personas) carries preset
   weight vectors over top-level taxonomy nodes: `{id, label, description,
   seed_confidence, weights:[{node_id, weight}]}`. The five directed personas
   seed at 0.35, `generalist` at 0.15. */

/** The persona with this id, or null (unknown id, or personas.json absent). */
function personaById(id) {
  return (state.personas?.personas || []).find(p => p && p.id === id) || null;
}

/** Applies a persona pick as a DECAYING PRIOR, never as config (issue #70:
    "A persona pick is allowed only as a decaying cold-start prior, never as
    persisted config ... Observed signal must overtake it").

    It writes nothing of its own: no persona key is stored and nothing reads
    the persona back. Each weighted root and its leaves (the same subtree
    expansion a chip pick uses) is lifted by `seed_confidence × weight` ON
    TOP of whatever loadInterests() seeded, through the same clamp
    applyOnboardingPicks and nudgeTopics use. From then on the lift is just
    part of the weight every play and thumb moves, so observed signal decays
    it away: the largest lift any persona gives (0.35 × 1.0) is undone by five
    subject thumbs-down (5 × 0.08), and test/personas-client.test.js pins that.

    Returns false (no write, no _interestsGen bump) for an unknown persona or
    one that lifts nothing; otherwise the ROOT ids it lifted, the same shape
    applyOnboardingPicks returns, for the re-deal. */
function applyPersonaPick(id) {
  const persona = personaById(id);
  if (!persona) return false;
  const roots = [];
  (persona.weights || []).forEach(({ node_id, weight } = {}) => {
    const lift = persona.seed_confidence * weight;
    if (!(lift > 0)) return; // a zero (generalist's `news`) or malformed weight lifts nothing
    let touched = false;
    expandTaxonomyPick(node_id).forEach(n => {
      if (n in state.interests) {
        setInterest(n, Math.max(0, Math.min(1, state.interests[n] + lift)));
        touched = true;
      }
    });
    const root = nodeById(node_id)?.parent || node_id; // a leaf weight counts for its root
    if (touched && !roots.includes(root)) roots.push(root);
  });
  if (!roots.length) return false;
  saveInterests();
  state._interestsGen = (state._interestsGen || 0) + 1;
  return roots;
}

/** U-09's third acceptance line ("picking three chips changes the FIRST Home
    render's ranking"), which shipped unmet in PR #503 (audit, 2026-09-10):
    Home's "Suggested" is `state.cardSlots`, dealt once per session by
    `buildCards()` in init() — BEFORE this sheet opens over Home, from the
    pre-pick default weights — and renderHomeV2() only rebuilds an EMPTY
    cardSlots. applyOnboardingPicks() changed the inputs of that deal without
    anything re-running it, so the picks showed up on the next session's Home
    and not the one the listener landed on. This re-runs the deal.

    Before re-dealing it UNDOES the pre-pick deal's memory. buildCards()
    records what it dealt as though the listener saw it: `cp_recent_branches`
    (a -0.35 ranking penalty on the next deal) and `cp_seen` (demotes those
    episodes behind unseen ones within their subject's chain). That deal was
    painted under a modal sheet the listener has been answering, not browsed
    — and counting it as seen would penalise exactly the subjects the picks
    just lifted (+0.20/sqrt(n), at most +0.20, against a -0.35 penalty), so a
    listener who picked the very subjects the default deal happened to show
    would watch them VANISH from the Home their picks were meant to shape.
    Only the pre-pick deal's own entries are removed: the last `dealt.length`
    branches buildCards() appended, and the dealt episode ids.

    No-op when nothing has been dealt yet — a boot that has not reached
    init()'s buildCards(), or an empty pool — because renderHomeV2() already
    rebuilds an empty cardSlots lazily and there is no memory to undo. The
    caller repaints (renderCurrentPage()); this only rebuilds state, the same
    split the family-mode toggle in init() already uses. */
function redealAfterOnboardingPicks(pickedRoots = []) {
  const dealt = state.cardSlots || [];
  if (!dealt.length) return;
  /* Undo only a deal that was RECORDED (app-1-7). Recording waits for storage
     to settle, so a deal still waiting has written nothing: undoing it used to
     cut the previous session's entries off cp_recent_branches, and then its
     recorder fired anyway. The re-deal below supersedes it instead. */
  if (lastDealRecorded) {
    const dealtIds = new Set(dealt.flatMap(sl => (sl.items || []).map(it => it.id)));
    lsSet("cp_seen", stringList(lsGet("cp_seen", [])).filter(id => !dealtIds.has(id)));
    const recent = stringList(lsGet("cp_recent_branches", []));
    lsSet("cp_recent_branches", recent.slice(0, Math.max(0, recent.length - dealt.length)));
  }
  buildCards({ reserve: Array.isArray(pickedRoots) ? pickedRoots : [] });
}

/* ---------- ONCE MEANS ONCE, INCLUDING WITHIN A SINGLE VISIT ----------

   Both `…Once` functions below guarded only on PERSISTED state — "is this a
   first-time profile" and "has the intro been dismissed" — and neither of
   those flips until the listener actually dismisses the sheet. So two renders
   of Home before that dismissal mount two sheets, with duplicate element ids,
   stacked over each other.

   Home re-renders on its own: `refreshForayDirectory("boot")` is fired
   unawaited by init() and, when a newer directory is adopted, repaints every
   Foray surface — and `isForaySurface("#/")` is true, so Home is one of them.
   The whole defect is therefore a RACE between that fetch landing and the
   listener's thumb, invisible on a fast machine and reliable on a slow one.

   Found 2026-09-13 by test/playwright/drawer-and-close.spec.js, which failed
   in CI inside its own `openApp()` helper: `#first-time-sheet-skip` resolved
   to two elements, and before that a three-minute click timeout where the
   duplicate sheet intercepted every click aimed at the first. Reproduced
   locally only under `CI=1` (two workers, all specs in parallel) — a
   single-spec run never showed it.

   The fix is at the level the bug is at: a function whose name promises ONCE
   must be idempotent against its own output, not merely against a flag it has
   not written yet. Neither the repaint nor the directory refresh is wrong;
   both are wanted. `true` rather than `false` on the early return because the
   return value means "the first-time explainer owns this visit" — answering
   `false` while a sheet is on screen would let the caller open the OLDER
   intro popup on top of it (`if (!showFirstTimeExplainerOnce())
   showIntroPopupOnce()`), which is the same bug wearing a different id.

   ORDER MATTERS, AND IT IS THE SEMANTIC GATES FIRST. The idempotency check is
   LAST, after "is this a first-time profile" and "has the intro been
   dismissed", because it is a guard against this function's own output and
   nothing more — it must never be able to answer a question about WHO the
   listener is. A first draft put it first and turned
   test/first-time-onboarding.test.js red in CI: that suite's DOM stub answers
   `querySelector` with a fresh truthy element for every selector, so the check
   short-circuited and an EXISTING user was reported as seeing the first-time
   screen. The stub is crude, but the tests were right and the order was wrong.

   MUTATION: delete either early return below and
   test/onboarding-sheet-once.test.js fails on the duplicate-mount assertion.

   PARKED FOR THE VISIT (audit round 2, p-first-4). A tap on the dimmed area
   above the panel — a stray thumb, a peek at Home behind it — used to end
   onboarding for good, and lose the chips picked so far; the drawn handle,
   meanwhile, did nothing. The scrim, Escape, a navigation, hardware back and
   the drag the handle now answers are all "not now, for this visit":
   `cp_intro_dismissed` is written only by the two Skip buttons and the
   Preferences step's primary — the considered presses. `firstRunParked` is
   this-visit state, a sibling of the on-screen check above, and returns
   `true` for the same reason that check does: the explainer owns the visit,
   so the returning-user popup must not take its place.

   REDESIGN 2026: the "sheet" in all of the above is now the first-run Room
   (`#onboarding-room`, below). Every rule here carries over unchanged except the
   ones that named a scrim or the Preferences step: the Room has no scrim, and
   only its two buttons write `cp_intro_dismissed`. */
let firstRunParked = false;
/* True only for the one re-render a finished "Delete my data" does (persist-2):
   Home repainted under the delete sheet must not open onboarding over the
   result. `deleteMyData` sets it around its `route()` and clears it after. */
let onboardingHeld = false;

function showFirstTimeExplainerOnce() {
  if (!isGenuineFirstTimeUser()) return false;
  if (lsGet("cp_intro_dismissed", false)) return false;
  if ($("#onboarding-room") || firstRunParked) return true;   // already on screen, or parked, this visit
  openOnboardingRoom({ replay: false });
  return true;
}

/* ---------- REDESIGN 2026 (ambient): THE FIRST-RUN ROOM ----------

   The two-step sheet (Welcome, then a chip grid) is retired. A newcomer meets ONE full-screen Room
   (BUILD-NOTES 4.7, 11.2): four real show artworks, one lit at a time, light the room; the first foray's
   strip draws itself in; the copy follows; the buttons hold the bottom. "Show my picks" goes to Today
   (the strip travels to the hero collage), "Skip for now" lands on Today with no sheet.

   WHAT FELL WITH THE SHEET. The Preferences step (17 subject chips and a typed-subject field) is gone: it
   asked a newcomer to declare what observation will learn within a few plays, and the direction's Tuning
   (less, 4a's pick, more) is where a subject is changed on purpose. applyOnboardingPicks, resolveTypedSubject
   and the re-deal stay: they are the write path Tuning and the persona prior (applyPersonaPick) share.

   WHICH SHOWS. The first listable foray's shows, in running order (their art lights the strip's colours
   too), then the discover pool's shows to make four. Every colour comes from numbers (agGlowFor, the
   palette hue); a show's name never reaches a style. */
const ONBOARDING_TITLE = "Hear things outside your lane.";
const ONBOARDING_BODY = "4a picks a few podcasts a day and says why. No account.";
const ONBOARDING_CYCLE_MS = 6000;      // each artwork holds the Room this long
const ONBOARDING_LEAVE_MS = 420;       // --m-sheet: the strip travels, then the Room lets go
const ONBOARDING_DRAW_MS = 1200;       // the strip draws in over this, the last bar included
const ONBOARDING_BAR_MS = 280;         // --m-ui: one bar's own scale-in
const ONBOARDING_PLAYED = 0.18;        // how far into the foray the strip is lit when it is drawn (whole bars: the ones whose middle is behind it)
const ONBOARDING_BAR_MAX = 8;          // more shows' bars than this are condensed (the strip is 343px wide, and a light sits between bars)
const ONBOARDING_CONDENSED = 7;        // ... into this many

/** Up to four {name, src}: the first foray's distinct shows, then the pool's. */
function onboardingShows(r = null) {
  const out = [];
  const add = (name, src) => {
    const n = String(name || "").trim();
    if (!n || out.length >= 4 || out.some(s => s.name === n)) return;
    out.push({ name: n, src: src || showArtworkUrl({ title: n }) || "" });
  };
  try {
    for (const p of (r && r.playable) || []) if (p && p.type !== "narration" && p.kind !== "tts") add(p.show, p.artwork_url);
    for (const it of (state.discover && state.discover.items) || []) if (it && it.artwork_url) add(it.show, it.artwork_url);
  } catch (_) { /* malformed data draws fewer sleeves, never an error */ }
  return out;
}

/** The first listable foray resolved, or null. */
function onboardingForay() {
  try {
    const first = forayCards()[0];
    return first ? resolveListedForay(first.id) : null;
  } catch (_) { return null; }
}

/** The strip's bars as {s: show|null, d: seconds, f: 0|1}: one bar per run of a show, a narration light between every
    two bars. It is a drawing of the foray's shape, not a readout (aria-hidden), so the rhythm is the design's: the
    prototype puts one light at every boundary, and so do we, at a fixed width and one gap, never only where the feed
    happens to carry narration (that left some neighbours 4px apart and others 20px, and read as a block).
    Neighbours that name one show (two episodes back to back, or two separated only by narration) are one bar. More than
    ONBOARDING_BAR_MAX bars become ONBOARDING_CONDENSED, each named for the show that holds most of it. `f` is 1 for the
    bars the first ONBOARDING_PLAYED of the foray has gone by and 0 for the rest: whole bars only, at rest, never a bar
    half lit (a half-lit bar read as two segments run together). [] when the player module or the foray is absent. */
function onboardingBars(r) {
  const player = window.ForayPlayer;
  if (!r || !player || typeof player.stripModel !== "function") return [];
  let model;
  try { model = player.stripModel(r.playable, { mergeNarration: true }); } catch (_) { return []; }
  const oneRun = (list) => list.reduce((out, b) => {
    const last = out[out.length - 1];
    if (last && last.s === b.s) last.d += b.d; else out.push({ s: b.s, d: b.d });
    return out;
  }, []);
  let runs = oneRun((model && model.segments || [])
    .filter(g => g.kind !== "narration" && String(g.show || "").trim())
    .map(g => ({ s: String(g.show), d: Math.max(1, Number(g.lengthSec) || 0) })));
  if (runs.length > ONBOARDING_BAR_MAX) {
    const sum = runs.reduce((t, b) => t + b.d, 0);
    const n = ONBOARDING_CONDENSED, per = sum / n, out = [];
    let i = 0;
    for (let k = 0; k < n; k++) {
      const tally = new Map();
      let got = 0;
      while (i < runs.length && (got < per || k === n - 1)) {
        tally.set(runs[i].s, (tally.get(runs[i].s) || 0) + runs[i].d);
        got += runs[i].d; i++;
      }
      let best = null;
      tally.forEach((v, s) => { if (best === null || v > tally.get(best)) best = s; });
      if (best !== null) out.push({ s: best, d: got });
    }
    runs = oneRun(out);
  }
  const total = runs.reduce((t, b) => t + b.d, 0);
  const lit = total * ONBOARDING_PLAYED;
  let start = 0;
  const bars = [];
  runs.forEach((b, k) => {
    if (k) bars.push({ s: null, d: 0, f: 0 });
    bars.push({ s: b.s, d: b.d, f: start + b.d / 2 < lit ? 1 : 0 });
    start += b.d;
  });
  return bars;
}

/** A bar's colour: the show's artwork hue, nudged 30 degrees (up to three times) when it sits within 24 degrees
    of a bar already drawn, at the lightness band the scheme reads. Numbers only. */
function onboardingBarColours(bars) {
  const light = agGlowLightness() >= 0.6 ? 0.70 : 0.52;
  const used = [];
  const byShow = new Map();
  return bars.map(b => {
    if (!b.s) return "";
    if (!byShow.has(b.s)) {
      const hc = agPaletteFor(b.s) || [0, 0.1];
      let hue = ((Number(hc[0]) % 360) + 360) % 360;
      const near = (x) => used.some(u => { const d = Math.abs(u - x) % 360; return Math.min(d, 360 - d) < 24; });
      for (let tries = 0; near(hue) && tries < 3; tries++) hue = (hue + 30) % 360;
      used.push(hue);
      byShow.set(b.s, `oklch(${light} 0.13 ${hue.toFixed(0)})`);
    }
    return byShow.get(b.s);
  });
}

/** The Room's markup. Text and attributes cross esc(); artwork markup is agArtwork's (esc + safeUrl inside). */
function onboardingRoomHtml(shows, barCount) {
  const sleeves = shows.map((s, k) =>
    `<span class="ob-sleeve${k === 0 ? " is-lit" : ""}">${agArtwork({ name: s.name, src: s.src, size: 104 })}</span>`).join("");
  const strip = barCount
    ? `<div class="ob-strip" aria-hidden="true">${'<span class="ob-bar"></span>'.repeat(barCount)}</div>`
    : "";
  return `<div class="ob-layers" aria-hidden="true"><span class="ob-layer"></span><span class="ob-layer"></span></div>
  <div class="ob-inner">
    <p class="ob-wordmark">4a</p>
    <div class="ob-mid">
      <div class="ob-arts" aria-hidden="true">${sleeves}</div>
      ${strip}
      <h2 class="t-display ob-title" id="onboarding-title">${esc(ONBOARDING_TITLE)}</h2>
      <p class="t-body ob-body">${esc(ONBOARDING_BODY)}</p>
    </div>
    <div class="ob-actions">
      <button type="button" class="ag-btn ag-btn-primary" id="onboarding-go">${esc("Show my picks")}</button>
      <button type="button" class="ag-btn ag-btn-secondary" id="onboarding-skip">${esc("Skip for now")}</button>
    </div>
  </div>`;
}

/** `url("...")` for a --ob-art custom property: safeUrl()'d, with the characters that could end the string
    percent-encoded, or `none` for no art (safeUrl answers "#" for a URL it refuses, and `url("#")` is the page itself). */
function onboardingCssUrl(src) {
  const u = src ? safeUrl(artUrl(src, 400)) : "";
  return u && u !== "#" ? 'url("' + String(u).replace(/["\\\r\n]/g, c => encodeURIComponent(c)) + '")' : "none";
}

/** Opens the Room as THE modal. `replay` is Settings' "What 4a does": the same Room for a listener who has been
    here before, which writes nothing and keeps where they were. */
function openOnboardingRoom({ replay = false } = {}) {
  const r = onboardingForay();
  const shows = onboardingShows(r);
  const bars = onboardingBars(r);
  const wrap = ddEl("div", "room ag ob-room");
  wrap.id = "onboarding-room";
  wrap.setAttribute("role", "dialog");
  /* NOT aria-modal, for the reason the sheets never were (audit round 2, p-first-5): `inert` on everything else
     is the modality, and aria-modal would trap VoiceOver's cursor. */
  wrap.setAttribute("aria-modal", "false");
  wrap.setAttribute("aria-labelledby", "onboarding-title");
  wrap.innerHTML = onboardingRoomHtml(shows, bars.length);
  const all = (sel) => (typeof wrap.querySelectorAll === "function" ? [...wrap.querySelectorAll(sel)] : []);
  const one = (sel) => (typeof wrap.querySelector === "function" ? wrap.querySelector(sel) : null);

  /* Light: the Room, the lit sleeve and the strip all read the first show's colour; the artwork is the backdrop. */
  const layers = all(".ob-layer");
  if (layers[0]) { layers[0].style.setProperty("--ob-art", onboardingCssUrl(shows[0] && shows[0].src)); layers[0].classList.add("is-on"); }
  if (shows[0]) agSetGlow(wrap, shows[0].name);
  const arts = all(".ob-sleeve .ag-art");
  arts.forEach((el, k) => { if (shows[k]) agSetGlow(el, shows[k].name, "--art-glow"); });
  const strip = one(".ob-strip");
  if (strip) {
    const colours = onboardingBarColours(bars);
    const n = bars.length;
    strip.style.setProperty("--ob-step", `${n > 1 ? Math.round((ONBOARDING_DRAW_MS - ONBOARDING_BAR_MS) / (n - 1)) : 0}ms`);
    all(".ob-bar").forEach((el, k) => {
      const b = bars[k];
      if (!b) return;
      el.style.setProperty("--i", String(k));
      if (!b.s) { el.classList.add("is-narr"); return; }   // a light is a fixed width; only a show's bar shares the width by runtime
      el.style.setProperty("flex-grow", String(Math.max(1, Math.round(b.d))));
      if (colours[k]) el.style.setProperty("--c", colours[k]);
      if (b.f) el.classList.add("is-lit");
    });
  }

  /* The Room cycles through the artworks; a still Room holds the first (Reduce Motion, or one artwork). */
  let timer = null, at = 0, front = 0;
  if (shows.length > 1 && layers.length > 1 && !reducedMotion() && typeof setInterval === "function") {
    timer = setInterval(() => {
      at = (at + 1) % shows.length;
      const next = layers[front ? 0 : 1], prev = layers[front];
      next.style.setProperty("--ob-art", onboardingCssUrl(shows[at].src));
      next.classList.add("is-on"); prev.classList.remove("is-on");
      front = front ? 0 : 1;
      arts.forEach((el, k) => { const sleeve = el.parentElement; if (sleeve && sleeve.classList) sleeve.classList.toggle("is-lit", k === at); });
      agSetGlow(wrap, shows[at].name);
    }, ONBOARDING_CYCLE_MS);
  }

  let leaving = false;
  const stop = () => { if (timer !== null && typeof clearInterval === "function") clearInterval(timer); timer = null; };
  const landOnToday = () => {
    const mark = document.querySelector(".td-wordmark");
    if (mark) focusQuietly(mark);
  };
  /* Dismissal fades the Room over --m-sheet (the shared Reduce Motion block turns that into a 200ms crossfade). A
     considered "Show my picks" also sends the strip to the hero collage, unless motion is reduced. */
  const leave = (travel) => {
    if (leaving) return;
    leaving = true;
    stop();
    let travelled = false;
    if (travel && strip && !reducedMotion()) {
      try {
        const to = document.querySelector(".td-hero-art");
        const from = strip.getBoundingClientRect();
        const dest = to && to.getBoundingClientRect();
        if (dest && dest.width > 0 && from.width > 0) {
          const k = Math.min(1, dest.width / from.width);
          wrap.style.setProperty("--ob-dx", `${Math.round(dest.left + dest.width / 2 - (from.left + from.width / 2))}px`);
          wrap.style.setProperty("--ob-dy", `${Math.round(dest.top + dest.height / 2 - (from.top + from.height / 2))}px`);
          wrap.style.setProperty("--ob-k", k.toFixed(3));
          wrap.classList.add("is-travelling");
          travelled = true;
        }
      } catch (_) { /* a stub or a missing hero: the Room just fades */ }
    }
    wrap.classList.add("is-leaving");
    /* The fade's own length (the strip's trip ends it at --m-sheet, a plain fade at --m-ui; Reduce Motion is 200ms),
       plus a little slack so the Room is gone rather than cut. */
    const gone = reducedMotion() ? 240 : travelled ? ONBOARDING_LEAVE_MS + 40 : 320;
    setTimeout(() => { closeSheet(wrap, { removeIfOwned: true }); landOnToday(); }, gone);
  };
  /* Dismissal is the two buttons; Escape, a navigation and hardware back park the Room for this visit and
     write nothing (p-first-4): the listener has not answered. */
  const dismiss = (travel) => {
    if (!replay) lsSet("cp_intro_dismissed", true);
    leave(travel);
  };
  const park = () => {
    if (leaving) return;
    leaving = true;
    stop();
    firstRunParked = true;
    closeSheet(wrap, { removeIfOwned: true });
    const held = document.activeElement;
    if (!held || held === document.body) landOnToday();   // Escape on a Room opened by nothing: focus has no opener to go back to
  };
  openSheet(wrap, { panel: wrap, onRequestClose: park, keepReachable: [] });
  const go = one("#onboarding-go"), skip = one("#onboarding-skip");
  if (go) go.addEventListener("click", () => {
    dismiss(true);
    if (replay && currentHash() !== "#/") location.hash = "#/";
  });
  if (skip) skip.addEventListener("click", () => dismiss(false));
  return wrap;
}

/** Settings' "What 4a does": the Room again, for anyone, any time. */
function showWhatFouraDoes() {
  if ($("#onboarding-room")) return;
  openOnboardingRoom({ replay: true });
}

/* First-run explainer (#128 follow-up). Used to be a permanent card at the top
   of the home screen — after the first read it was dead weight that pushed the
   subject cards down the screen for good. It is now a one-time popup shown
   right after the very first app open (gated on the same cp_intro_dismissed
   flag, so an existing install that already dismissed the card never sees it
   again) and nothing about it lives in the home layout any more.

   Returning users, and first-time users who already saw
   showFirstTimeExplainerOnce() this visit, are the only ones who reach this
   function — renderHome() calls the two in sequence and short-circuits here
   when the explainer just showed, so a first-ever visit never shows both. */
function showIntroPopupOnce() {
  if (lsGet("cp_intro_dismissed", false)) return;
  /* The same guard, for the same reason and in the same position (after the
     persisted gate, never before it) as `showFirstTimeExplainerOnce` above.
     This one is reachable by RETURNING users, who are not
     `isGenuineFirstTimeUser()`, so it has only ever had the one flag between
     it and a duplicate mount. `introParked` is the same this-visit state the
     first-run sheet keeps. */
  if ($("#intro-sheet") || introParked) return;
  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "intro-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  // Not aria-modal, for the first-run sheet's reason: the player stays reachable.
  panel.setAttribute("aria-modal", "false");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = ddEl("h3", null, "4a picks podcast episodes for you");
  title.id = "intro-sheet-title";
  panel.setAttribute("aria-labelledby", "intro-sheet-title");

  const sub = ddEl("p", "fy-sheet-sub",
    /* It described the retired four-card Home ("Grouped into four topic
       queues…"), so the first thing a returning listener read was about a
       screen they were not looking at (audit 2026-09-22, persona row 23). It
       describes the Home that ships, and it is where a listener who skipped
       the first-run sheet learns what a foray is.
       Review 2026-09-23: no "stitch clips" (the 2026-08-11 playback ruling —
       see forayAbout), and only what Home renders: the stretch pick is in
       Today's picks (the cardSlots stretch role, todayPicks), not in Playlists,
       which are mostly the listener's own. Redesign 2026 (Today): the Forays
       row and Suggested are gone, so the sentence no longer branches on
       whether a stretch Foray exists — the hero is never the floor's stretch
       Foray, and the picks always carry the stretch card. */
    `A foray plays moments from several shows, straight from each show's own feed, one after another. Below it are today's picks and your playlists. The picks include one outside your usual subjects, on purpose.`);

  const actions = ddEl("div", "fy-sheet-actions");
  const ok = ddEl("button", "fy-sheet-go", "Got it");
  ok.type = "button";
  ok.id = "intro-sheet-ok";
  actions.append(ok);

  panel.append(grab, title, sub, actions);
  wrap.append(scrim, panel);

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    closeSheet(wrap, { removeIfOwned: true });
  };
  /* The same rule as the first-run sheet (p-first-4): only "Got it" is the
     considered press; everything else parks it for this visit. */
  const park = () => {
    introParked = true;
    closeSheet(wrap, { removeIfOwned: true });
  };
  openSheet(wrap, { panel, onRequestClose: park, keepReachable: ONBOARDING_KEEPS_REACHABLE });
  scrim.addEventListener("click", park);
  ok.addEventListener("click", dismiss);
}

/** What the two onboarding sheets leave reachable: the player, so audio that
    a shared Foray link started stays controllable under them (p-first-5). */
const ONBOARDING_KEEPS_REACHABLE = ["#foray-player"];
let introParked = false;
