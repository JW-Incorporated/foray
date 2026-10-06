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

function showFirstTimeExplainerOnce() {
  if (!isGenuineFirstTimeUser()) return false;
  if (lsGet("cp_intro_dismissed", false)) return false;
  if ($("#first-time-sheet") || firstRunParked) return true;   // already on screen, or parked, this visit

  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "first-time-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  /* NOT aria-modal (audit round 2 review of p-first-5): `aria-modal="true"`
     keeps VoiceOver's cursor inside the dialog, so the player this sheet keeps
     reachable (ONBOARDING_KEEPS_REACHABLE) was reachable only by Tab. The
     modality is `inert` on everything else, which `openSheet` applies. */
  panel.setAttribute("aria-modal", "false");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");
  panel.append(grab);

  const body = ddEl("div", "ft-step-body");
  panel.append(body);

  wrap.append(scrim, panel);

  const dismiss = () => {
    lsSet("cp_intro_dismissed", true);
    closeSheet(wrap, { removeIfOwned: true });
  };
  const park = () => {
    firstRunParked = true;
    closeSheet(wrap, { removeIfOwned: true });
  };
  /* The player stays reachable (audit round 2, p-first-5): Home defers this
     sheet while a Foray is sounding (`offerHomeOnboarding`), but a paused or
     restored bar can still sit under it, and the mini bar's ▶ and ↺15 must not
     go inert with the page. Reachable means ABOVE the scrim as well as out of
     `inert`: `body.fy-sheet-keeps-player` lifts #foray-player over the z-70
     sheet and lifts the panel off the bar (styles.css), or a tap on the bar
     landed on the scrim and only parked the sheet. */
  openSheet(wrap, { panel, onRequestClose: park, keepReachable: ONBOARDING_KEEPS_REACHABLE });
  scrim.addEventListener("click", park);

  /* Live SegmentStrip illustration for the second value prop — reads off
     window.ForayPlayer exactly as forayCards()/renderForay() do (app.js is a
     classic script and cannot import player/segment-strip.js). Absent
     module, absent forays, or a Foray with no segments all degrade to no
     strip, never an error. */
  function welcomeStripHtml() {
    const player = window.ForayPlayer;
    if (!player || typeof player.resolve !== "function" || typeof player.segmentStripHtml !== "function") return "";
    if (!state.forays) return "";
    const first = forayCards()[0];
    if (!first) return "";
    try {
      const r = resolveListedForay(first.id);
      if (!r) return "";
      /* mergeNarration: a card is 210px of content box and a generated Foray
         is now ~56 items, 40 of them bridges — one bar each overflows the card
         and paints over its neighbour. Merging each run of back-to-back
         bridges into one violet bar (sized by the run's real total) is the fix;
         it is safe HERE and only here because nothing scrubs a card's strip.
         See collapseNarrationRuns in player/segment-strip.js. */
      return player.segmentStripHtml(r.playable, { size: "sm", mergeNarration: true }) || "";
    } catch (_) {
      // Malformed segments/sources data must not break the first-run Home
      // render — "degrades to nothing" (this function's own contract) has to
      // hold even when the player module throws, not just when it's absent.
      return "";
    }
  }

  function renderWelcome() {
    body.innerHTML = "";
    const title = ddEl("h3", null, "4a picks podcast episodes for you");
    title.id = "first-time-sheet-title";
    panel.setAttribute("aria-labelledby", "first-time-sheet-title");
    const sub = ddEl("p", "fy-sheet-sub", "A podcast app that listens to you first. Two things make it different:");

    const propLearn = ddEl("div", "ft-value-prop");
    propLearn.append(
      ddEl("h4", null, "Suggestions that actually learn"),
      ddEl("p", "fy-sheet-sub",
        "Episode picks tuned to your subjects and the voices you trust — sharper every time you listen.")
    );

    const propForay = ddEl("div", "ft-value-prop");
    propForay.append(
      ddEl("h4", null, "Forays: one subject, many shows"),
      ddEl("p", "fy-sheet-sub", forayAbout())
    );
    const stripHtml = welcomeStripHtml();
    if (stripHtml) {
      const stripWrap = ddEl("div", "ft-strip-wrap");
      stripWrap.innerHTML = stripHtml;
      propForay.append(stripWrap);
    }

    const props = ddEl("div", "ft-value-props");
    props.append(propLearn, propForay);

    const actions = ddEl("div", "fy-sheet-actions");
    const skip = ddEl("button", "fy-sheet-cancel", "Skip for now");
    skip.type = "button";
    skip.id = "first-time-sheet-skip";
    const go = ddEl("button", "fy-sheet-go", "Get started");
    go.type = "button";
    go.id = "first-time-sheet-go";
    actions.append(skip, go);

    body.append(title, sub, props, actions);
    if (stripHtml) applyStripGrowIfBridged(propForay);

    skip.addEventListener("click", dismiss);
    go.addEventListener("click", () => { renderPreferences(); landOnStep(); });
  }

  /* A STEP SWAP LANDS FOCUS ON THE NEW STEP'S TITLE (audit round 2, a11y-5).
     "Get started" empties the dialog's body, which destroys the focused button:
     focus fell to <body> inside an open modal, and the new `aria-labelledby`
     is a name change, which nothing announces. The qa 64 rule — every action
     that destroys the element just activated puts focus somewhere that
     survived — applied here. The title is the programmatic target
     (tabindex=-1, the same way `landOnPage` treats a page heading), so the
     step is read and Tab continues from its top. Not on the FIRST render: the
     owner has just focused the panel, which announces the dialog with its
     name, and that is the right first thing to hear. */
  function landOnStep() {
    const title = $("#first-time-sheet-title");
    if (!title) return;
    if (typeof title.getAttribute !== "function" || title.getAttribute("tabindex") == null) title.setAttribute("tabindex", "-1");
    focusQuietly(title);
  }

  function applyStripGrowIfBridged(scope) {
    if (window.ForayPlayer && typeof window.ForayPlayer.applyStripGrow === "function") {
      window.ForayPlayer.applyStripGrow(scope);
    }
  }

  function renderPreferences() {
    body.innerHTML = "";
    const picked = new Set();

    const title = ddEl("h3", null, "What are you into?");
    title.id = "first-time-sheet-title";
    panel.setAttribute("aria-labelledby", "first-time-sheet-title");
    const sub = ddEl("p", "fy-sheet-sub", "This is how 4a tunes your suggestions. Pick a few, or skip — 4a learns either way, from what you play.");

    const chips = ddEl("div", "fy-chips");
    chips.id = "first-time-sheet-chips";
    PREFS_CHIP_IDS.forEach(id => {
      const node = nodeById(id);
      if (!node) return; // taxonomy drift: never render a chip for a node that no longer exists
      const chip = ddEl("button", "fy-chip", node.label);
      chip.type = "button";
      chip.dataset.chip = id;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        if (picked.has(id)) { picked.delete(id); chip.classList.remove("on"); chip.setAttribute("aria-pressed", "false"); }
        else { picked.add(id); chip.classList.add("on"); chip.setAttribute("aria-pressed", "true"); }
      });
      chips.append(chip);
    });

    const typedWrap = ddEl("div", "ft-typed-wrap");
    const typedInput = ddEl("input");
    typedInput.type = "text";
    typedInput.id = "first-time-sheet-typed";
    typedInput.className = "ft-typed-input";
    typedInput.placeholder = "Or type a subject yourself…";
    typedInput.setAttribute("aria-label", "Type a subject yourself");
    /* A TYPED MISS IS SAID, AND THE SHEET STAYS (audit round 2, p-first-3). A
       word nothing in the taxonomy answers to used to close the sheet exactly
       as a match did, so the newcomer's first typed act was a silent no-op. */
    const typedNote = ddEl("p", "ft-typed-note", "");
    typedNote.id = "first-time-sheet-typed-note";
    typedNote.setAttribute("role", "status");
    /* NEVER `hidden` (audit round 2 review): a live region outside the
       accessibility tree when its text changes, which then appears with the
       text already in place, is usually not read (VoiceOver in WKWebView in
       particular), so a VoiceOver newcomer pressing "Show my picks" heard
       nothing. It stays in the tree, empty when there is nothing to say. */
    typedInput.addEventListener("input", () => { setStatusText(typedNote, ""); });
    typedWrap.append(typedInput, typedNote);

    const actions = ddEl("div", "fy-sheet-actions");
    const skip = ddEl("button", "fy-sheet-cancel", "Skip");
    skip.type = "button";
    skip.id = "first-time-sheet-prefs-skip";
    const go = ddEl("button", "fy-sheet-go", "Show my picks");
    go.type = "button";
    go.id = "first-time-sheet-prefs-go";
    actions.append(skip, go);

    body.append(title, sub, chips, typedWrap, actions);

    skip.addEventListener("click", dismiss);
    go.addEventListener("click", () => {
      const typed = typedInput.value.trim();
      if (typed) {
        const node = resolveTypedSubject(typed);
        if (!node) {
          /* Cleared, then said on the next frame — announce()'s idiom — so the
             region sees a change even when the same word misses twice (the
             helper skips identical text, and an unchanged node says nothing). */
          const said = `No subject called ${quoteQuery(typed)} yet. Try one of the chips above.`;
          setStatusText(typedNote, "");
          const say = () => setStatusText(typedNote, said);
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(say); else say();
          return;
        }
        /* The word resolved: its subject's chip lights, so the pick is shown
           as the same thing a tap would have made it. */
        const rootId = node.parent || node.id;
        const chip = chips.querySelector(`[data-chip="${rootId}"]`);
        if (chip && !picked.has(rootId)) { picked.add(rootId); chip.classList.add("on"); chip.setAttribute("aria-pressed", "true"); }
      }
      const applied = applyOnboardingPicks([...picked], typed);
      dismiss();
      /* Only when something was actually written: an empty form is a Skip in
         all but name, and the Home already under the sheet is the right Home
         for it. Otherwise re-deal and repaint, so the FIRST Home the listener
         lands on ranks by their picks (U-09's acceptance line; see
         redealAfterOnboardingPicks), with the picked subjects in the top-tier
         slots (p-first-1). renderCurrentPage(), not route(): nothing about
         the location changed, and route() is the back-stack's entry point
         (#488). */
      if (applied) {
        redealAfterOnboardingPicks(applied);
        renderCurrentPage();
      }
    });
  }

  renderWelcome();
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
       see forayAbout), and only what Home renders: the stretch pick is in
       Forays for you and Suggested (pickWithStretchFloor, the cardSlots
       stretch role), not in Playlists, which are mostly the listener's own.
       Audit round 2 (p-first-11): the Forays row has a stretch pick only when
       the listed Forays span more than one subject, and with one published
       Foray it cannot. The sentence asks the SAME pick Home renders
       (foraysForYouPicks) instead of assuming. */
    `A foray plays moments from several shows, straight from each show's own feed, one after another. Below them are your playlists and episodes picked for you. The episodes ${foraysForYouPicks()?.stretchIndex >= 0 ? "and the forays each " : ""}include one pick outside your usual subjects, on purpose.`);

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
