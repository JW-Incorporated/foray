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

/* The 17 top-level nodes with measured pool depth (>= 50 items AND several
   distinct shows — interest-survey-plan.md §3.2), so every chip is backed by
   enough content to fill a queue on day one. Ids only; labels are read live
   off state.taxonomy so a taxonomy relabel never drifts out of sync with
   this list. */
const PREFS_CHIP_IDS = [
  "history", "comedy", "engineering", "business", "health", "society",
  "science", "true-crime", "culture", "psychology", "food", "craft",
  "nature", "medicine", "music", "personal-journals", "sports",
];

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
   so the returning-user popup must not take its place. */
let firstRunParked = false;
/* True only for the one re-render a finished "Delete my data" does (persist-2):
   Home repainted under the delete sheet must not open onboarding over the
   result. `deleteMyData` sets it around its `route()` and clears it after. */
let onboardingHeld = false;

/* ---------- THE TACTILE ONBOARDING SCREEN (Redesign 2026, group F) ----------

   docs/redesign-2026/directions/tactile/BUILD-NOTES.md 4.7, prototype `#/onboarding`.
   The screen is still `#first-time-sheet` and still opens through the sheet
   owner (`openSheet`), so focus moves in, Tab stays in, Escape parks it, the
   page behind is `inert`, and focus goes back where it came from. What changed
   is what it IS: a full-screen page on --paper (the sheet's scrim is the
   paper), no deck, a card carrying a live demo of TODAY's real foray, the
   founders' tagline, and two exits.

   RULINGS THAT FELL (this change, per build-loop.md section 4 step 2):
   - The two-step Welcome -> "What are you into?" sheet is gone. The prototype
     has one screen and two exits, and DIRECTION.md's "state observed, never
     declared" is the reason there is no picks step: Today's first run says
     "4a starts with wide bets. Each listen narrows the dial." The write path
     (`applyOnboardingPicks`, `applyPersonaPick`, `redealAfterOnboardingPicks`)
     stays below, tested, for the surface that asks for it next.
   - "Get started" (-> picks) is now "Play today's foray" (-> playback).

   TWO MODES, ONE SCREEN. First: the band draws in (`--d-draw`) and a needle
   travels it at 8% of the foray per second with a mono counter under the band.
   Returning (`#/onboarding/return`, a listener who skipped and wants it
   again): the same screen with nothing moving and the key says "Play". Under
   reduced motion the first mode is the still one: the draw-in is in the one
   reduced-motion block and the needle loop does not start.

   NO NETWORK WRITE. Nothing here signs up, refreshes a token or POSTs an
   event; playing goes through `playHomeTarget`, the same path as Today's key,
   whose events stay local in a lab build (test/lab-flag.test.js). */
const ONB_HEADLINE = "Podcasts, stitched around you.";
const ONB_SUB = "4a picks real shows each day and lines up the best parts into one listen.";
const ONB_PLAY = "Play today's foray";
const ONB_PLAY_AGAIN = "Play";
const ONB_SKIP = "Just show me";
const ONB_START = 0.31;      // where the demo needle starts, as a fraction of the foray
const ONB_RATE = 0.08;       // its travel: 8% of the foray per second
const ONB_TICK_MS = 100;
const ONB_ROUTE = /^#\/onboarding(\/return)?$/;

/** "8:52", or "1:02:09" past the hour: the colon clock is for the counter only. */
function onbClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Today's foray, the very one Today's hero shows, as the demo: its band, the
    shows it draws on and its length. Null when no Foray resolves (offline, a
    catalogue that has not loaded), and the screen then has no band and no Play
    key rather than a demo of nothing. */
function onboardingModel() {
  try {
    const pick = todayForayPick({ forays: foraysForYouPicks() }, null);
    if (!pick) return null;
    const hero = todayHeroModel(pick);
    if (!hero.segments.length) return null;
    const shows = [...new Set(hero.segments.filter(s => !s.narration && s.show).map(s => s.show))];
    const sum = hero.segments.reduce((t, s) => t + (Number(s.duration) || 0), 0);
    const total = sum > 0 ? sum : Number(pick.r.totalSec) || 0;
    return total > 0 ? { pick, hero, shows, total } : null;
  } catch (_) { return null; }
}

/** The show artwork as a 2 x 2 grid of the prototype's collage, one cell per
    show (a foray of two or three shows repeats from the first), the live image
    through tactileArtFrame -> safeUrl, the station code where a show has none. */
function onboardingCollageHtml(shows) {
  const n = shows.length;
  if (!n) return "";
  const cell = (name) => tactileArtFrame({ size: "hero", url: showArtworkUrl({ title: name }), initials: tactileStationCode(name) });
  const names = n === 1 ? [shows[0]] : Array.from({ length: 4 }, (_, i) => shows[i % n]);
  return `<span class="onb__collage${n === 1 ? " onb__collage--one" : ""}">${names.map(cell).join("")}</span>`;
}

/** The card's inside: the brand alone in the top row (a counter top-right reads
    as a fake status bar), then the artwork, the band and its readout row. */
function onboardingCardHtml(model, still) {
  const brand = `<div class="onb__wm"><span class="heading onb__brand">${tactileIcon("band")}4a</span></div>`;
  if (!model) {
    return `${brand}<div class="onb__stage"><div class="onb__art">${tactileArtFrame({ size: "hero", initials: "4a", round: true })}</div></div>`;
  }
  const { hero, shows, total } = model;
  const start = still ? 0 : ONB_START;
  return `${brand}<div class="onb__stage">
    <div class="onb__art">${onboardingCollageHtml(shows)}</div>
    <div class="well onb__well">${tactileBand({ kind: "detail", id: "onb-band", segments: hero.segments, renderWidth: todayBandWidth(), label: hero.bandLabel, progress: start })}</div>
    <div class="onb__meta" aria-hidden="true"><span class="readout"><span class="onb__now" data-onb-clock>${esc(onbClock(total * start))}</span><span class="onb__total"> / ${esc(onbClock(total))} · ${esc(countLabel(shows.length, "show"))}</span></span></div>
  </div>`;
}

/** The needle's loop and the counter that rides it. Never started under reduced
    motion, nor for the still mode, nor where there is no band to move; it stops
    itself the first tick after the sheet leaves the document. */
function startOnboardingLoop(wrap, model) {
  if (!model || typeof setInterval !== "function" || reducedMotion()) return;
  const needle = wrap.querySelector(".onb__well .needle");
  const clip = wrap.querySelector(".onb__well .band__progress");
  if (!needle || !clip) return;
  const clock = wrap.querySelector("[data-onb-clock]");
  const boxes = tactileBandLayout(tactileBandSegments(model.hero.segments), todayBandWidth(), "detail");
  const step = ONB_RATE * ONB_TICK_MS / 1000;
  let at = ONB_START;
  const timer = setInterval(() => {
    if (wrap.isConnected === false) { clearInterval(timer); return; }
    at += step;
    if (at >= 1) at = 0;
    const x = tactileBandX(boxes, at).toFixed(2);
    needle.setAttribute("transform", `translate(${x} 0)`);
    clip.setAttribute("width", x);
    if (clock) setStatusText(clock, onbClock(model.total * at));
  }, ONB_TICK_MS);
}

/** `#/onboarding` and `#/onboarding/return`: Today underneath, the screen over
    it. Today's own offer is held for the render so the two cannot both mount. */
function renderOnboardingRoute(returning) {
  onboardingHeld = true;
  try { renderHome(); } finally { onboardingHeld = false; }
  showFirstTimeExplainerOnce({ returning, forced: true });
}

function showFirstTimeExplainerOnce({ returning = false, forced = false } = {}) {
  if (!forced) {
    if (!isGenuineFirstTimeUser()) return false;
    if (lsGet("cp_intro_dismissed", false)) return false;
    if ($("#first-time-sheet") || firstRunParked) return true;   // already on screen, or parked, this visit
  } else {
    /* The address asked for it: whichever mode is already up gives way. */
    const stale = $("#first-time-sheet");
    if (stale) closeSheet(stale, { removeIfOwned: true });
  }

  const still = returning;
  const model = onboardingModel();

  const wrap = ddEl("div", "fy-sheet onb-sheet");
  wrap.id = "first-time-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", still ? "fy-panel onb onb--still" : "fy-panel onb");
  panel.setAttribute("role", "dialog");
  /* NOT aria-modal (audit round 2, p-first-5): `aria-modal="true"` keeps
     VoiceOver's cursor inside the dialog, so the player this sheet keeps
     reachable (ONBOARDING_KEEPS_REACHABLE) was reachable only by Tab. The
     modality is `inert` on everything else, which `openSheet` applies. */
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "first-time-sheet-title");

  const card = ddEl("section", "onb__card");
  card.setAttribute("aria-label", model ? `Today's foray, ${model.hero.facts}` : "4a");
  card.innerHTML = onboardingCardHtml(model, still);

  const copy = ddEl("div", "onb__copy");
  const title = ddEl("h2", "display", ONB_HEADLINE);
  title.id = "first-time-sheet-title";
  copy.append(title, ddEl("p", "onb__sub", ONB_SUB));

  /* The keys are built here, as DOM, so the ids the rest of the app and its
     tests look for exist the moment the panel does. Their inside is the
     primitives' (tactileIcon, the keycap label span). */
  const actions = ddEl("div", "onb__actions");
  const skip = ddEl("button", model ? "textbtn" : "keycap keycap--paper keycap--lg keycap--wide", ONB_SKIP);
  skip.type = "button";
  skip.id = "first-time-sheet-skip";
  if (model) {
    const label = still ? ONB_PLAY_AGAIN : ONB_PLAY;
    const go = ddEl("button", "keycap keycap--persimmon keycap--lg keycap--wide");
    go.type = "button";
    go.id = "first-time-sheet-go";
    go.setAttribute("aria-label", label);
    go.innerHTML = `${tactileIcon("ph-play-fill")}<span class="keycap__label">${esc(label)}</span>`;
    actions.append(go);
    go.addEventListener("click", () => {
      const foray = model.pick.foray;
      dismiss();
      /* Resolved at the press, as Today's key does: a draft that has since
         left the list is not started from a stale card. */
      const r = resolveListedForay(foray.id);
      if (r && Array.isArray(r.playable) && r.playable.length) Promise.resolve(playHomeTarget({ kind: "foray", r }, null)).catch(() => {});
    });
  } else {
    skip.innerHTML = `<span class="keycap__label">${esc(ONB_SKIP)}</span>`;
  }
  actions.append(skip);

  panel.append(card, copy, actions);
  wrap.append(scrim, panel);

  /* On the address that asked for the screen, leaving it leaves the address. Only
     while the address is still the one it was opened on: a navigation closes the
     sheet through `park` AFTER the hash has changed, and when the new hash is
     itself an onboarding address (the harness walks from "#/" to
     "#/onboarding/return") rewriting it would undo the navigation. */
  const openedOn = currentHash();
  const leave = () => { if (ONB_ROUTE.test(openedOn) && currentHash() === openedOn) replaceHash("#/"); };
  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    closeSheet(wrap, { removeIfOwned: true });
    leave();
  };
  const park = () => {
    firstRunParked = true;
    closeSheet(wrap, { removeIfOwned: true });
    leave();
  };
  /* The player stays reachable (audit round 2, p-first-5): Home defers this
     sheet while a Foray is sounding (`offerHomeOnboarding`), but a paused or
     restored bar can still sit under it, and the mini bar's play and back-15 must not
     go inert with the page. Reachable means ABOVE the scrim as well as out of
     `inert`: `body.fy-sheet-keeps-player` lifts #foray-player over the z-70
     sheet and lifts the panel off the bar (styles.css), or a tap on the bar
     landed on the scrim and only parked the sheet. */
  openSheet(wrap, { panel, onRequestClose: park, keepReachable: ONBOARDING_KEEPS_REACHABLE });
  scrim.addEventListener("click", park);
  skip.addEventListener("click", dismiss);
  if (!still) startOnboardingLoop(wrap, model);
  return true;
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
       see forayAbout), and only what Home renders. Today (Redesign 2026) draws
       one Foray first, then "Also today": the picks, one of them the Stretch
       bridge (the cardSlots stretch role), then the listener's playlists, which
       are mostly their own and carry no stretch pick. So the sentence names Also
       today and nothing else as the place the outside pick is. */
    `A foray plays moments from several shows, straight from each show's own feed, one after another. Today's foray comes first, then Also today and your playlists. Also today includes one pick outside your usual subjects, on purpose.`);

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
