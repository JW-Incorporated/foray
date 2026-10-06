/* ui/foray.js — Foray page (#/foray/<id>): rows, feedback sheet, credits, sources, renderForay.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Forays (#128) ----------

   A Foray is one ordered run of 32 SEGMENTS drawn from nine episodes of five
   shows — not an episode, and not a playlist of episodes. The running order
   lives in data/forays.json, the timestamps in data/segments.json, the audio in
   data/segment-sources.json; the join, the queue and the position maths all
   live in player/foray-resolve.js, where they are tested. This section is the
   surface: it renders what that returns and drives the transport.

   ── The draft rule ────────────────────────────────────────────────────────
   Only a founder may publish a Foray (a founder action; HUMAN-ACTIONS.md #2 asked
   for it until it was dropped on 2026-09-24). As of 2026-08-30
   ONE is published — `capital-types-1` — so exactly one is listed for an
   ordinary visitor and the other three are not. The rule has not changed; the
   data has. (It used to read "every Foray is a draft, so none is listed", which
   is the sentence this change falsified.)

   A DRAFT is still reachable — by asking for one by id:

       https://jw-incorporated.github.io/foray/?foray=grilling-history-2

   That is the CURRENT grilling Foray (#226). `grilling-history-1`, the
   61-minute assembly that drifted off plot, was retired from the file on
   2026-09-22 (#236), so its old link no longer opens anything.

   That link opens the Foray once (`enterForayFromQuery` rewrites the hash) and
   the parameter then stays in the URL as the unlock token — changing
   `location.hash` leaves the query string alone, so the unlock holds while the
   founder moves around the app. It is deliberately NOT persisted to
   localStorage: an unpublished Foray should not start appearing for someone who
   once opened a link on a shared machine. Nothing is bypassed and nothing is
   published by opening it — the status in the data file is unchanged, and the
   page says so on the page. */

function forayParam() {
  try {
    const raw = new URLSearchParams(location.search).get("foray");
    return raw && raw.trim() ? raw.trim() : null;
  } catch (_) { return null; }
}

/** Ids the visitor named explicitly. Today that is at most one. */
function unlockedForays() {
  const id = forayParam();
  return id ? [id] : [];
}

/* ── The test track: "Show draft Forays" ──────────────────────────────────

   Wyatt, 2026-09-11: "I can't see these forays in the app, please fix that."
   "These" are the GENERATED Forays — `data/forays.json` rows carrying
   `generated: true` — which land as `status: "draft"` because publishing is a
   founder action and the generator is not a founder.
   The visitor rule above is untouched, and so is every Foray's status: this
   is a per-device switch in the drawer, OFF by default, that lets the person
   who owns the device ask for every draft at once, the way `?foray=` asks for
   one. When it is off, nothing below is reachable and every surface renders
   exactly what it rendered before the switch existed (test/draft-forays-
   switch.test.js pins that byte for byte).

   `cp_show_drafts` goes through lsGet/lsSet like every other `cp_` key (§
   storage above; durable tier + localStorage mirror), is listed in
   docs/legal/privacy-policy.md §1 and counted by test/data-deletion.test.js,
   and is wiped by "Delete my data" with the rest. It is deliberately NOT read
   inside `player/` — that tree is pure, so the switch travels to the resolver
   as the `showDrafts` OPTION every visibility call below passes. */
function showDraftsOn() { return lsGet("cp_show_drafts", false); }

/* ---------- K-01: the founder's voice-engine probe switch ----------

   `docs/bundled-voice-plan.md` K-01 asks for the measurement to reach a phone
   behind the same unlock discipline HUMAN-ACTIONS.md #29 used — a hidden
   affordance, not a product feature. That instrument itself is gone (D-01
   deleted it, and `test/release-gates.test.js` keeps it deleted by name, so
   nothing here reuses its identifiers). On `main` today the shape that
   discipline has taken is `showDraftsOn` directly above: a `cp_` key, off by
   default, a
   drawer toggle that reads `<thing>: on|off`, and NOTHING RENDERED AT ALL
   while it is off. This follows it exactly rather than inventing a second
   idiom for the same job — there is one founder, and two ways of hiding a
   founder switch is one too many to explain over a phone.

   WHY A SWITCH AND THEN A BUTTON, rather than one button. The probe is a
   90-second synthesis loop that pins a CPU; a stray tap on it during a drive
   is a measurement nobody asked for and a battery reading nobody can use. The
   switch is the deliberate act; the button is the run. When the switch is off
   the run button is not merely disabled — it is not in the DOM, so the drawer
   is byte-identical to what shipped before this card (the same claim
   `test/draft-forays-switch.test.js` makes about its own switch, and
   `test/voice-probe-switch.test.js` makes here).

   `cp_voice_probe` goes through lsGet/lsSet like every other `cp_` key, has
   its row in `docs/legal/privacy-policy.md` §1, is counted by
   `test/data-deletion.test.js`, and is wiped by "Delete my data". `player/`
   never reads it — `ForayPlayer.runVoiceProbe()` takes no flag, because the
   decision of whether to offer the run belongs to the page. */
function voiceProbeOn() { return lsGet("cp_voice_probe", false); }

/** The visibility options every Foray surface hands the bridge: the `?foray=`
    unlock AND the switch, together, so no call site can pass one and forget
    the other.

    `showDrafts` is an OVERRIDE rather than a fixed field, because
    `splitTestTrackDrafts` needs both answers for the same unlock set: today's
    list, and then the same list with the drafts admitted. It built both option
    objects inline until the 2026-09-12 client audit — this function documents
    itself as the thing that stops a call site forgetting an option, and the one
    call site that needed a variant was the one that went around it. */
function forayViewOpts(overrides = {}) {
  return { unlocked: unlockedForays(), showDrafts: showDraftsOn(), ...overrides };
}

/** Order for the drafts the SWITCH admitted (never for the published list,
    whose order is the file's): generated ones newest first — the generator
    appends to `data/forays.json` as each lands and stamps no date, so the
    file's own order is the arrival order and its reverse is "newest first" —
    then any hand-authored draft in file order. */
function draftTrackOrder(drafts) {
  const generated = drafts.filter(f => f.generated === true).reverse();
  const authored = drafts.filter(f => f.generated !== true);
  return generated.concat(authored);
}

/** `listFn(opts)` -> `{ listed, drafts }`: the list a surface shows today,
    and — only when the switch is on — the drafts it admitted, in
    draftTrackOrder (an empty array otherwise). Two calls rather than one so
    `listed` is the SAME call, with the SAME options, that ran before the
    switch existed: with it off the second call never happens. */
function splitTestTrackDrafts(listFn) {
  const listed = listFn(forayViewOpts({ showDrafts: false }));
  if (!showDraftsOn()) return { listed, drafts: [] };
  const seen = new Set(listed.map(f => f.id));
  const drafts = draftTrackOrder(listFn(forayViewOpts({ showDrafts: true })).filter(f => !seen.has(f.id)));
  return { listed, drafts };
}

/** The two halves as one list: today's, then the test-track drafts. */
function withTestTrackDrafts(listFn) {
  const { listed, drafts } = splitTestTrackDrafts(listFn);
  return drafts.length ? listed.concat(drafts) : listed;
}

/* The player is an ES module and this is a classic script, so the bridge may
   not exist yet at first render. Wait for it once, rather than polling — and
   give up rather than hanging if the module failed to load at all, so a broken
   deploy shows a message instead of an empty page. */
const PLAYER_WAIT_MS = 5000;

function playerBridge() {
  if (window.ForayPlayer) return Promise.resolve(window.ForayPlayer);
  /* EACH WAIT CLEANS UP AFTER ITSELF (audit round 3, app-2-14). On the broken-
     deploy path the event never fires, and every visit to #/forays, Library or
     a Try again used to leave one listener and its closure attached for the
     session: finish() resolved but removed nothing. */
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("forayplayer:ready", finish);
      clearTimeout(timer);
      resolve(window.ForayPlayer || null);
    };
    window.addEventListener("forayplayer:ready", finish, { once: true });
    timer = setTimeout(finish, PLAYER_WAIT_MS);
  });
}

/* "STILL LOADING" IS NOT "FAILED TO LOAD" (audit round 2, states-6). A null
   bridge after the wait means one of two things, and the page used to answer
   both with a Try again that could only help with the first. Module scripts
   are deferred and run before `DOMContentLoaded`, so once parsing has finished
   (`readyState` is no longer "loading") every deferred module has either run
   — and the bridge would be here — or failed to fetch, parse or evaluate. That
   is `waitForStorage()`'s exact reading of the same event, applied to the
   other thing the module publishes. While the document is still parsing the
   module may simply be slow, and re-awaiting it (Try again) is right. */
function playerModuleFailed() {
  if (window.ForayPlayer) return false;
  /* NOT `readyState !== "loading"`: "interactive" comes BEFORE the deferred
     modules run (see `deferredScriptsRan`), so a module still downloading was
     called failed and offered a reload of the whole slow graph. */
  return deferredScriptsRan;
}

/* ---------- per-segment feedback (the learning loop's input) ----------

   The mockup's thumbs, and they are deliberately asymmetric: up is one silent
   tap, down opens a sheet and asks what missed. That asymmetry is the design's
   actual point — "not for me" is nearly useless to a learning job on its own,
   and a listener who has just been annoyed is the one moment they will tell you
   why. The vote is only committed when the sheet is submitted; dismissing it
   leaves the segment unvoted, exactly as `voteDown` does in the mockup.

   The event shape is NOT invented here. `docs/curation/events-client-integration
   -spec.md` §2 defines `thumbs` as `{direction, node_id, episode_slug?}` with
   `node_id` mandatory, and §4 records that no thumbs UI existed yet. A segment
   carries `topic` — a real taxonomy node id, checked against data/taxonomy.json
   — so it maps straight onto that contract with nothing made up. */

const FB_CHIPS = [
  "Not my subject", "Didn't like the voice", "Leans too far left",
  "Leans too far right", "Too surface-level", "Too in-the-weeds",
  "Bad audio quality", "Heard this already", "Just not this show",
];

/** The reasons that are about the SUBJECT, and so may move the interest
    profile. "Just not this show" is a show-level signal, not a topic one
    (docs/DECISIONS.md, the learning-job entry); the voice, the audio and
    "heard this already" say nothing about the subject at all. */
const TOPIC_REASONS = new Set(["Not my subject", "Too surface-level", "Too in-the-weeds"]);

/* Read through the pending-edit overlay and written through editStored
   (round-3 review, L1): a thumb given before hydration lands shows at once and
   lands on the durable votes rather than replacing them. Read-only. */
function forayFeedback() { return plainObject(storedValue("cp_foray_feedback", {})); }

function feedbackFor(segmentId) { return forayFeedback()[segmentId] || null; }

/** Record (or clear) a vote and emit the event. `reasons`/`note` only ever ride
    a down-vote — an up-vote has nothing to explain. */
/** The interest nudge a stored vote applied: +0.08 for an up, -0.08 for a down
    with a subject-shaped reason, 0 for anything else (p-foray-6). */
function voteNudge(vote) {
  if (!vote || !vote.direction) return 0;
  if (vote.direction === "up") return 0.08;
  return (vote.reasons || []).some(r => TOPIC_REASONS.has(r)) ? -0.08 : 0;
}

function setFeedback(entry, direction, { reasons = [], note = "" } = {}) {
  const all = forayFeedback();
  const segId = entry.segment_id;
  if (!segId) return;
  /* A VOTE REPLACES THE ONE BEFORE IT, nudge included (audit round 3, app-2-6).
     Clearing a vote, or changing it, used to leave the old nudge in place, so
     up, clear, up drove a topic to 1.0 in about thirteen taps. The previous
     vote's nudge is undone in the same step that applies the new one. */
  const prev = all[segId] && all[segId].direction ? all[segId] : null;
  const undo = -voteNudge(prev);
  const vote = direction ? { direction, reasons, note, ts: new Date().toISOString() } : null;
  editStored("cp_foray_feedback", {}, (v) => {
    const next = { ...plainObject(v) };
    if (vote) next[segId] = vote;
    else delete next[segId];
    return next;
  });

  /* The event says which vote it replaces, and a withdrawn vote is logged as
     "cleared" (round-3 audit, app-2-6): the learning job takes the replaced
     vote's move back (backend interestLearning.ts), so the server counts up,
     clear, up once, as this device does. */
  const replaces = prev ? { direction: prev.direction, reasons: Array.isArray(prev.reasons) ? prev.reasons : [] } : null;
  if (direction || replaces) {
    logEvent("thumbs", {
      direction: direction || "cleared",
      node_id: entry.topic || null,
      episode_slug: entry.item_id || null,
      segment_id: segId,
      foray_id: state.foray ? state.foray.id : null,
      reasons: direction ? reasons : [],
      note: direction ? note.trim() || null : null,
      replaces,
    });
  }
  if (direction) {
    /* A thumb is an action the listener took, so it moves the same weights
       playing something does — just harder, and in whichever direction.
       ONLY WHEN THE REASON IS ABOUT THE SUBJECT (audit round 2, p-foray-6): a
       down-vote for "Bad audio quality" or "Didn't like the voice" used to
       lower interest in the whole subject exactly like "Not my subject", so
       complaining about one host's microphone made Home show fewer startup
       episodes. The sheet promises specificity; the reasons now mean it. A
       down-vote with no subject-shaped reason is recorded as an event only. */
    const net = undo + voteNudge({ direction, reasons });
    if (net) nudgeTopics([entry.topic], net);
    trySyncEvents();
  } else if (replaces) {
    if (undo) nudgeTopics([entry.topic], undo);
    trySyncEvents();
  }
  paintFeedback(segId);
}

function paintFeedback(segmentId) {
  const vote = feedbackFor(segmentId)?.direction || "";
  $("#view").querySelectorAll(`[data-seg-id="${CSS.escape(segmentId)}"]`).forEach(btn => {
    btn.classList.toggle("on", btn.dataset.thumb === vote);
    btn.setAttribute("aria-pressed", btn.dataset.thumb === vote ? "true" : "false");
  });
}

function thumbsHtml(entry) {
  // No taxonomy node means nowhere for the signal to land, and a control that
  // silently does nothing is worse than no control.
  if (!entry.segment_id || !entry.topic) return "";
  const vote = feedbackFor(entry.segment_id)?.direction || "";
  /* NAMED BY THE SHOW, NOT BY THE CURATION CODE. These used to read "More like
     ORI-1" — the same editorial shorthand the left gutter used to print, and
     the same reason it is gone: a screen reader was being handed a string from
     the spreadsheet a producer built the Foray in. `forayBeatName` is the one
     place that decides what a beat is called out loud, so the play button and
     the thumbs cannot name the same beat two different ways. */
  const named = forayBeatName(entry);
  const one = (dir, glyph, label) =>
    `<button type="button" class="fy-thumb ${vote === dir ? "on" : ""}" data-thumb="${dir}"
        data-seg-id="${esc(entry.segment_id)}" aria-pressed="${vote === dir}"
        aria-label="${esc(label)} ${esc(named)}">${glyph}</button>`;
  return `<div class="fy-fb">
    ${one("up", "👍", "More like")}${one("down", "👎", "Less like")}
  </div>`;
}

/* ---------- a beat's credit: whose work is this? ---------- */

/** An authored narration beat — 4a's own writing, read by 4a's own voice. The
    other authored type is `segment` (somebody else's tape); a `jingle` is
    neither and is credited to nobody. */
function isForayNarration(entry) {
  return entry?.type === "narration";
}

/* WHICH CATALOGUE SHOW A BEAT BELONGS TO, or null when nothing joins.

   Two joins, asked in this order, and the order is the point:

     1. THE IDENTIFIER, carried from the source row's id prefix by
        `showIdFromSourceId` in player/foray-resolve.js. It is only a candidate
        there — that module is pure and has no catalogue — so it is verified
        here, against the catalogue this surface already holds. An id that does
        not resolve is not linked; a `#/show/…` route for a show nothing knows
        renders "Show not found.", which is worse than plain text.
     2. THE TITLE, via `showIdForShowName`, which every other show link in the
        app already uses.

   Measured on the committed data (98 source rows): the identifier join answers
   for 76 and the title join for 78, and the first set is entirely INSIDE the
   second — so today the identifier join adds no linkable row the title join
   would have missed, and deleting it would not change a single rendered page.
   It is asked first anyway, because a publisher can reword a title and cannot
   reword the id we harvested the episode under; the only test that separates
   the two is therefore a synthetic renamed-show case, and it is labelled as
   such in test/foray-row-links.test.js.

   Across the eight committed Forays' 131 tape beats: 67 link by identifier, 9
   more by title, and 55 do not link at all. That 55 is almost entirely the two
   hand-curated grilling Forays and `capital-types-1`, whose small independent
   shows were never in the curated 220; all four GENERATED Forays link every
   beat they have. A show that does not join renders exactly today's plain text.

   Narration is excluded rather than falling through: a narration entry has no
   `show`, so the title join would return null anyway, but saying so here is
   what keeps the narrator's credit from ever being asked to be a link. */
function forayShowId(entry) {
  if (!entry || isForayNarration(entry)) return null;
  if (entry.show_id && showById(entry.show_id)) return entry.show_id;
  return showIdForShowName(entry.show);
}

/* ONE NAME FOR THE NARRATOR (audit round 2, p-foray-12): the credit, the
   header and the accessible name each spelled it differently ("AI Narrator",
   "4a's narrator", "4a's AI Narrator"). The player owns the name
   (`segment-strip.js` NARRATOR_NAME, which its own summary speaks); this page
   reads it through the bridge. The Foray page never renders without the
   bridge, so the fallback is a plain noun, not a second spelling. */
function narratorName() {
  return window.ForayPlayer?.narratorName || "the narrator";
}

/* The credit that leads a row's meta line: a link to the show, the show's name
   as plain text when it does not join, or the narrator's name for a beat we
   wrote.

   The narrator's credit is deliberately NOT a link. There is no 4a show page to send
   anyone to, and a control that navigates nowhere is worse than a label — the
   same rule `thumbsHtml` keeps. It carries the same class and sits in the same
   slot as a show credit so the two row kinds read as siblings: one credits a
   podcast, one credits us. */
function forayCreditHtml(entry) {
  if (isForayNarration(entry)) {
    return `<span class="fy-credit is-narrator">${esc(narratorName())}</span>`;
  }
  if (!entry.show) return "";
  const showId = forayShowId(entry);
  /* A real <a href>, not a button wired through JS, for the reason written
     against `taxonomyChip`: right-click, long-press and open-in-new-tab are
     browser behaviours a handler cannot fake. And a SIBLING of the play button
     rather than inside it, for the reason written against `thumbsHtml`: an
     interactive element inside a button is invalid HTML whose click never
     survives the parent's handler. */
  return showId
    ? `<a class="fy-credit show-link" href="#${esc(showRoutePath(showId))}">${esc(entry.show)}</a>`
    : `<span class="fy-credit" data-credit-show="${esc(entry.show)}">${esc(entry.show)}</span>`;
}

/** What a beat is called when it is spoken aloud — for the play button's
    accessible name and the thumbs'. The show and the beat's own `why` is what
    a listener would use to tell two rows apart; the curation code
    (`entry.label`) never was, and is no longer rendered anywhere on this page. */
function forayBeatName(entry) {
  if (isForayNarration(entry)) return `narration by ${narratorName()}`;
  return [entry.show, entry.why].filter(Boolean).join(", ") || "this clip";
}

/* ---------- a narration beat's transcript ---------- */

/* HOW LONG IS "LONG", AND WHY THIS NUMBER.

   Measured over the 157 scripted narration items in the four committed
   generated Forays. The lengths are not a smooth curve; they cluster by the
   beat's authored `mode`:

     hinge   36 items    95–134 chars
     frame   76 items    71–166, then a gap, then 305–1057
     marker   4 items   223–250
     patch   35 items   358–627
     carry    6 items   941–1332

   So there is a real empty band between 250 and 305: no committed script is
   anywhere in it. Every threshold inside that band partitions the committed
   data IDENTICALLY — 84 items render whole, 73 collapse — so the choice within
   it is arbitrary by construction, and the honest pick is its midpoint, which
   is as far as possible from the nearest real script on either side. A round
   200 or 300 would NOT have been arbitrary: 200 cuts through the markers and
   300 through the long frames, and either produces a "Show more" that reveals
   a line and a half.

   The clamp is SIX lines rather than four so that the tallest uncollapsed
   script (250 chars) and a collapsed one occupy about the same height — the
   card is one size whether or not it has a control on it. */
const NARRATION_CLAMP_CHARS = 277;

/* The transcript, and the control that opens it.

   The text is always in the DOM in full: the collapse is CSS (`-webkit-line-
   clamp` on `.fy-script.is-clamped`), so "Show more" is one class toggle, the
   card grows in place and every row below it moves down — no modal, no inner
   scroller, no second copy of the script to keep in sync. It also means a
   screen reader and a find-in-page reach the whole script while it is visually
   collapsed, which is the right trade for a transcript.

   The control is a SIBLING of the play button, not inside it — same invalid-
   HTML rule as the thumbs and the show link. */
function narrationScriptHtml(entry) {
  const script = typeof entry.script === "string" ? entry.script.trim() : "";
  if (!isForayNarration(entry) || !script) return "";
  const long = script.length > NARRATION_CLAMP_CHARS;
  const id = `fy-script-${esc(String(entry.ord))}`;
  const text = `<p class="fy-script${long ? " is-clamped" : ""}" id="${id}">${esc(script)}</p>`;
  const cites = citesHtml(entry);
  if (!long) return `<div class="fy-script-wrap">${text}${cites}</div>`;
  return `<div class="fy-script-wrap">
    ${text}
    <button type="button" class="fy-script-more" data-script-for="${id}"
        aria-expanded="false" aria-controls="${id}">Show more</button>
    ${cites}
  </div>`;
}

/* F-103: what the narrator's claims rest on, when the producer has recorded it.

   ABSENT IS THE NORMAL CASE and must look exactly like today: every committed
   Foray predates the pipeline change, and by the producer's honesty rule a page
   the verifier did not confirm ships no `cites` at all rather than shipping its
   unconfirmed sources as support. So silence here means "nothing confirmed",
   never "nothing was written", and the UI says nothing rather than implying
   either.

   A tape cite links to the cited show's page through the same two joins a tape
   beat's own credit uses; a print cite links out when it has a URL and is plain
   text when it does not. `player/foray-resolve.js` has already dropped any cite
   that could not be resolved, so nothing here can render an empty citation. */
function citesHtml(entry) {
  const cites = Array.isArray(entry.cites) ? entry.cites : [];
  if (!cites.length) return "";
  const one = (c) => {
    if (c.kind === "tape") {
      const showId = c.show_id && showById(c.show_id) ? c.show_id : showIdForShowName(c.show);
      const name = showId
        ? `<a class="show-link" href="#${esc(showRoutePath(showId))}">${esc(c.show)}</a>`
        : esc(c.show);
      return `<li>${name}${c.episode_title ? ` — ${esc(c.episode_title)}` : ""}</li>`;
    }
    const pub = c.url
      ? `<a class="show-link" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.publication)}</a>`
      : esc(c.publication);
    return `<li>${pub}</li>`;
  };
  return `<div class="fy-cites">
    <p class="fy-cites-head">Sources</p>
    <ul>${cites.map(one).join("")}</ul>
  </div>`;
}

/* Expand a transcript in place. Delegated rather than per button, so a Foray
   with forty narration beats costs one listener.

   NOTHING REPAINTS THIS LIST, so nothing has to restore the open state:
   `paintForay` and `paintFeedback` — the only two things that touch the running
   order after it is built — toggle classes on elements they find, and never
   rewrite `innerHTML`. The list is built once by `renderForay`, which only runs
   on a route change, and a route change is supposed to forget. */
/* BOUND ONCE, FROM init() (audit 2026-09-22). This used to be called from
   every renderForay, adding one more click listener to the persistent `#view`
   each time — `#view` outlives every render, only its innerHTML is replaced.
   With two listeners the second read the aria-expanded the first had just
   written and toggled it straight back, so "Show more" worked on odd visits to
   a Foray page and was dead on even ones. `stopPropagation` does not stop a
   sibling listener on the same node; binding once is the fix, and the
   delegation is why once is enough — the same argument onBackClick makes. */
function onForayScriptClick(e) {
  const btn = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-script-for]") : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const view = $("#view");
  const text = view ? view.querySelector(`#${CSS.escape(btn.dataset.scriptFor)}`) : null;
  if (!text) return;
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", open ? "false" : "true");
  setControlLabel(btn, open ? "Show more" : "Show less", null);
  text.classList.toggle("is-clamped", open);
}

function forayRow(entry) {
  const dur = window.ForayPlayer ? window.ForayPlayer.fmtSpan(entry.duration_sec) : "";
  /* HTML, not text, and named so — the credit is a link when the show joins.
     The duration stays escaped text and is joined on afterwards so a credit
     that comes back empty (a beat with no show at all) does not leave a
     dangling separator. */
  const credit = forayCreditHtml(entry);
  /* WHICH EPISODE (audit round 2, p-foray-5). The row said the show and the
     length, and the episode a clip came from lived only in the credits block
     at the foot of the page, so a caption about "his" shares or "Kahl" had
     nothing on the row to hang on. A narration beat has no episode. */
  const episode = !isForayNarration(entry) && entry.episode_title
    ? `<span class="fy-ep">${esc(entry.episode_title)}</span>` : "";
  const metaHtml = [credit, episode, dur ? esc(dur) : ""].filter(Boolean).join(" · ");
  /* The credit line is hoisted OUT of the play button, because a link inside a
     button is invalid HTML whose click never survives the parent's handler —
     the same rule that put the thumbs outside it. It reads in the same place it
     always did: the 52px curation-code gutter that used to indent this line is
     gone, so the hoisted line lands flush left where the indented one used to
     start. */
  /* THE LISTENER GETS A SENTENCE; THE REASON STAYS FOR US. It printed
     `Can't play: ${entry.reason}`, and the reasons are foray-resolve's own —
     "segment X is not in data/segments.json" — so the showcase page named a
     JSON file on our server to a listener (audit 2026-09-22, persona row 62).
     The raw reason rides on `data-reason`, where a field report can read it off
     the page and nobody reads it aloud. */
  if (!entry.playable) {
    return `<div class="fy-row is-out">
      <div class="fy-meta">${metaHtml}</div>
      <div class="fy-play-row">
        <div class="fy-jump">
          <div class="fy-body">
            <p class="fy-why">${esc(entry.why)}</p>
            <p class="fy-out" data-reason="${esc(entry.reason || "unresolved")}">This clip isn't available right now.</p>
          </div>
        </div>
      </div>
      ${narrationScriptHtml(entry)}
    </div>`;
  }
  /* The row used to BE the button. It cannot be any more: a thumb inside a
     button is invalid HTML and its click never survives the parent's handler.
     So the row is a container, the play affordance is the button inside it, and
     `data-fy` — which paintForay and the transport both key on — moves with the
     button, not with the container. */
  return `<div class="fy-row">
    <div class="fy-meta">${metaHtml}</div>
    <div class="fy-play-row">
      <button type="button" class="fy-jump${entry.why ? "" : " is-bare"}" data-fy="${esc(String(entry.queueIndex))}"
          data-fy-name="${esc(forayBeatName(entry))}" aria-label="${esc(forayJumpLabel(forayBeatName(entry), ""))}">
        <div class="fy-body">
          <p class="fy-why">${esc(entry.why)}</p>
        </div>
        <span class="fy-state" aria-hidden="true"></span>
      </button>
      ${thumbsHtml(entry)}
    </div>
    ${narrationScriptHtml(entry)}
  </div>`;
}

/** A clip row's accessible name, by where the listener is. The ▶ / ✓ that shows
    it on screen is a CSS glyph in an aria-hidden span, so for a screen reader
    the row's state lived nowhere: twelve identical "Play …" buttons, with no way
    to tell the one sounding now or the nine already heard (audit 2026-09-22).
    paintForay writes this beside the classes, from the same comparison. */
function forayJumpLabel(name, where) {
  if (where === "playing") return `Now playing: ${name}`;
  if (where === "played") return `Played. Play again: ${name}`;
  return `Play ${name}`;
}

function foraySlotHtml(slot) {
  if (!slot.entries.length) {
    return `<section class="fy-slot">
      <h3>${esc(slot.title)}</h3>
      <p class="note">Nothing in this part yet.</p>
    </section>`;
  }
  return `<section class="fy-slot">
    <h3>${esc(slot.title)}</h3>
    ${slot.entries.map(forayRow).join("")}
  </section>`;
}

/* ---------- the feedback sheet ---------- */

/* One sheet per page, reused for whichever segment was thumbed down. Built with
   the page (hidden) rather than on demand so there is no second render path to
   keep escaped. */
function feedbackSheetHtml() {
  return `<div class="fy-sheet" id="fy-sheet" hidden>
    <div class="fy-scrim" id="fy-scrim"></div>
    <div class="fy-panel" role="dialog" aria-modal="true" aria-labelledby="fy-sheet-title">
      <div class="fy-grab" aria-hidden="true"></div>
      <h3 id="fy-sheet-title">What missed for you?</h3>
      <p class="fy-sheet-sub" id="fy-sheet-sub"></p>
      <div class="fy-chips">${FB_CHIPS.map(c =>
        `<button type="button" class="fy-chip" data-chip="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div>
      <input id="fy-sheet-note" type="text" maxlength="200" placeholder="In your own words…" aria-label="What missed, in your own words">
      <div class="fy-sheet-actions">
        <button type="button" class="fy-sheet-cancel" id="fy-sheet-cancel">Cancel</button>
        <button type="button" class="fy-sheet-go" id="fy-sheet-go" disabled>Pick at least one</button>
      </div>
    </div>
  </div>`;
}

/** The segment the open sheet is about. Null when it is closed. */
let fbTarget = null;

function openFeedbackSheet(entry) {
  fbTarget = entry;
  const sheet = $("#fy-sheet");
  if (!sheet) return;
  $("#fy-sheet-sub").textContent =
    `About ${entry.show || "this clip"} — the more specific, the faster your picks get good.`;
  $("#fy-sheet-note").value = "";
  sheet.querySelectorAll("[data-chip]").forEach(c => setChipPressed(c, false));
  syncSheetCta();
  openSheet(sheet, { onRequestClose: closeFeedbackSheet });
}

function closeFeedbackSheet() {
  // Dismissing must NOT record the down-vote — the mockup only commits it on
  // submit, and a vote with no reason is the signal this sheet exists to avoid.
  fbTarget = null;
  const sheet = $("#fy-sheet");
  if (sheet) { closeSheet(sheet); sheet.hidden = true; }
}

/** A reason chip's selection, for the eye AND the ear. It was a class and a
    tint only, so a screen-reader user could not tell which reasons they had
    picked; the onboarding chips and the thumbs already wrote aria-pressed. */
function setChipPressed(chip, on) {
  chip.classList.toggle("on", on);
  chip.setAttribute("aria-pressed", on ? "true" : "false");
}

function sheetPicks() {
  return [...$("#fy-sheet").querySelectorAll("[data-chip].on")].map(c => c.dataset.chip);
}

function syncSheetCta() {
  const any = sheetPicks().length > 0 || $("#fy-sheet-note").value.trim().length > 0;
  const go = $("#fy-sheet-go");
  go.disabled = !any;
  setControlLabel(go, any ? "Tune my picks" : "Pick at least one", null);
}

function bindFeedback(r) {
  const bySegment = new Map(r.entries.filter(e => e.segment_id).map(e => [e.segment_id, e]));

  $("#view").querySelectorAll("[data-thumb]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = bySegment.get(btn.dataset.segId);
      if (!entry) return;
      const current = feedbackFor(entry.segment_id)?.direction || "";
      const dir = btn.dataset.thumb;
      // A second tap on the live vote clears it, in either direction — down
      // included, so undoing does not force the sheet open again.
      if (current === dir) return setFeedback(entry, null);
      if (dir === "up") return setFeedback(entry, "up");
      openFeedbackSheet(entry);
    });
  });

  const sheet = $("#fy-sheet");
  if (!sheet) return;
  sheet.querySelectorAll("[data-chip]").forEach(chip => {
    chip.addEventListener("click", () => { setChipPressed(chip, chip.getAttribute("aria-pressed") !== "true"); syncSheetCta(); });
  });
  $("#fy-sheet-note").addEventListener("input", syncSheetCta);
  $("#fy-scrim").addEventListener("click", closeFeedbackSheet);
  $("#fy-sheet-cancel").addEventListener("click", closeFeedbackSheet);
  $("#fy-sheet-go").addEventListener("click", () => {
    if (!fbTarget) return closeFeedbackSheet();
    setFeedback(fbTarget, "down", { reasons: sheetPicks(), note: $("#fy-sheet-note").value });
    closeFeedbackSheet();
  });
}

/* ---------- where this came from ---------- */

/* The publisher credit block. This is not decoration: a Foray plays nine
   episodes straight from their own enclosure URLs, so the download lands on the
   publisher's numbers — and until now the listener had no single place that said
   whose work they had spent an hour with, or how to go and get more of it. The
   grouping and the links are computed in player/foray-sources.js, where they are
   tested; this only renders them. */
function foraySourcesHtml(r, player) {
  // Deployed asynchronously from player/client.js (service worker, cache), so a
  // returning visitor can briefly hold a new app.js against an older module.
  // Losing the credit block is a missing section; throwing here is a blank page.
  if (typeof player.forayCredits !== "function") return "";
  const { credits, summary } = player.forayCredits(r, { discoverDoc: state.discover, collectionIds: showIndexCollectionIds(r) });
  if (!credits.length) return "";
  const clips = (n) => esc(countLabel(n, "clip"));
  /* THE ARROW SAYS WHERE IT GOES (audit round 2, p-foray-2). It was labelled
     "Open X on Apple Podcasts" for every show, while for a show with no known
     Apple id it opens a SEARCH results page. `linkKind` exists in
     player/foray-sources.js "so a surface can be honest about it". */
  const outLabel = (c) => c.linkKind === "apple-show"
    ? `Open ${c.show} on Apple Podcasts`
    : `Search Apple Podcasts for ${c.show}`;
  const rows = credits.map(c => `
    <div class="fy-src">
      <div class="fy-src-head">
        <span class="fy-src-show">${showNameLink(c.show)}</span>
        <span class="fy-src-meta">${clips(c.clips)} · ${esc(player.fmtSpan(c.seconds))}</span>
        <a class="fy-src-out" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener"
           data-src-show="${esc(c.show)}" data-link-kind="${esc(c.linkKind || "")}" aria-label="${esc(outLabel(c))}">↗</a>
      </div>
      <ul class="fy-src-eps">${c.episodes.map(e =>
        `<li>${esc(e.title)} <span>${clips(e.clips)}</span></li>`).join("")}</ul>
    </div>`).join("");
  return `<section class="fy-sources">
    <h3>Where this came from</h3>
    <p class="fy-src-note">${esc(summary)}. Every clip plays from the show's own feed.</p>
    ${rows}
  </section>`;
}

/** Show -> Apple collection id for this Foray's shows, from the show index's
    breadth rows (whose id IS the collection id; a curated row's id is a slug
    and is skipped). Upgrades the ↗ from a search to the show's own Apple page
    wherever the index knows the show — the same exact, unique title join. */
function showIndexCollectionIds(r) {
  const out = {};
  for (const show of new Set((r?.entries || []).map(e => e?.show).filter(Boolean))) {
    const id = showIndexIdForTitle(show);
    if (id && /^\d+$/.test(id)) out[show] = id;
  }
  return out;
}

/* THE JOIN THAT NEEDS THE INDEX, AFTER THE PAGE IS UP (p-foray-2). The index is
   ~200 KB and never on the boot path (the S-03 rules above loadShowIndex), so
   the page paints with what the catalogue knows and, only when some credited
   show has no page of its own, asks for the index once and relinks in place:
   the row credits, then the "Where this came from" block. Nothing is re-rendered
   that the transport owns. */
function joinForayCreditsToShowIndex(r, player) {
  if (showIndex) return;
  const unlinked = (r?.entries || []).some(e => e?.playable && e.show && !isForayNarration(e) && !forayShowId(e));
  if (!unlinked) return;
  loadShowIndex().then((idx) => {
    if (!idx || state.foray !== r) return;   // failed, or the listener has moved on
    relinkForayCredits(r, player);
  });
}

function relinkForayCredits(r, player) {
  const view = $("#view");
  if (!view) return;
  view.querySelectorAll(".fy-credit[data-credit-show]").forEach((span) => {
    const show = span.dataset.creditShow;
    const id = showIdForShowName(show);
    if (id) span.outerHTML = `<a class="fy-credit show-link" href="#${esc(showRoutePath(id))}">${esc(show)}</a>`;
  });
  const src = view.querySelector(".fy-sources");
  if (src) {
    src.outerHTML = foraySourcesHtml(r, player);
    bindSourceLinks(r);
  }
}

function bindSourceLinks(r) {
  $("#view").querySelectorAll("[data-src-show]").forEach(a => {
    a.addEventListener("click", () => {
      logEvent("source_opened", { foray_id: r.id, show: a.dataset.srcShow });
    });
  });
}

/* THE HEADER'S NUMBERS COME FROM THE STRIP'S MODEL (audit 2026-09-22, theme L).
   It used to count `r.playable.length` as "segments" — narrator bridges
   included — directly above a strip announcing a different number, and
   `r.shows`, which counts shows whose clips will never play, above a credits
   block that refuses to. `player.stripTally` is one definition for all three.

   AN ESTIMATE IS SAID TO BE ONE. A narrated Foray's bridges are timed from
   their script length until real audio exists, which is ~40% of the runtime
   on the ones that have them; printing that as "43:07" presented a
   character count as a stopwatch. When any item's duration is not measured,
   the runtime reads "about 43 min".

   An older cached module with no `stripTally` gets the runtime alone rather
   than counts from a second definition — a missing number is not a wrong
   one. */
/* ONE DIALECT FOR A FORAY'S LENGTH (audit round 2, p-foray-8): the header
   printed a measured runtime as a clock ("51:22") and an estimated one as
   "about 43 min", so one page wrote a length two ways, and no list said it at
   all. Minutes everywhere now, "about" when estimated; the ticking clock
   beside the scrubber keeps its clock shape. */
function forayRuntimeLabel(player, tally, totalSec) {
  if (typeof player?.fmtSpan !== "function") return "";
  return `${tally && tally.estimated ? "about " : ""}${player.fmtSpan(totalSec)}`;
}

/** "51 min · 22 clips · 7 shows": how long a Foray is and what it is made of,
    for every row and card that lists one (p-foray-8). The counts are the
    strip's own (`stripTally`), the narrator's clips counted as clips the way
    the strip counts them; "" when there is nothing resolved to read. */
function forayFactsLabel(r, player) {
  if (!r) return "";
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  return joinMeta(
    forayRuntimeLabel(player, tally, r.totalSec),
    tally ? countLabel(tally.clips + tally.bridges, "clip") : "",
    tally && tally.shows ? countLabel(tally.shows, "show") : "",
  );
}

function forayHeadSub(r, player) {
  const tally = typeof player?.stripTally === "function" ? player.stripTally(r.playable) : null;
  const parts = [];
  if (tally) {
    /* THE STRIP'S OWN WORDS (integration, 2026-09-22). L4 made every piece of a
       Foray a "clip" — the strip's label, the mini bar's "clip N of M", ‹‹/››
       — with the narrator's clips counted as the narrator's. L5's header
       counted tape only and said "with narration", so over a narrated Foray
       the header said "11 clips" and the strip beneath it "56 clips". One
       count now: the same total, split the same way the strip splits it. */
    const from = tally.shows ? ` from ${countLabel(tally.shows, "show")}` : "";
    parts.push(tally.bridges
      ? `${countLabel(tally.clips + tally.bridges, "clip")}: ${tally.clips}${from} and ${tally.bridges} from ${narratorName()}`
      : `${countLabel(tally.clips, "clip")}${from}`);
  }
  parts.push(forayRuntimeLabel(player, tally, r.totalSec));
  return joinMeta(...parts);
}

/* The back link on this page goes to `#/forays`, not `#/`. enterForayFromQuery's
   whole point is that a `?foray=` link lands somewhere the unlocked DRAFT is
   still listed, so the back button is not a dead end for the one person
   reviewing it. That list moved off Home to `#/forays` on 2026-09-03, so this
   link moved with it. */
async function renderForay(id) {
  setBodyClass("view-page");
  /* Every status this page can stop on has a ‹ back to the list, and each
     failure offers "Try again" wired to the thing that failed (audit
     2026-09-22, theme G). "Reload the page" was browser advice inside a native
     shell that has no page to reload, and it threw away where the listener
     was; the retry re-runs this route, which re-awaits the player, or re-fetches
     the three Foray documents. */
  $("#view").innerHTML = statusPageHtml({ note: "Loading…", back: "#/forays" });

  const player = await playerBridge();
  // Another route may have won while we waited for the module.
  if (forayRouteId() !== id) return;

  if (!player) {
    /* Failed outright — reload; merely slow — re-await (playerModuleFailed). */
    if (playerModuleFailed()) {
      $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "The player didn't load.", back: "#/forays", reload: true });
      bindReload($("#view"));
      return;
    }
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "The player didn't load.", back: "#/forays", retry: true });
    bindRetry($("#view"), () => renderForay(id));
    return;
  }
  if (!state.forays) {
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "Couldn't load forays right now.", back: "#/forays", retry: true });
    bindRetry($("#view"), retryForayDocs);
    return;
  }

  /* `forayViewOpts()` carries the `?foray=` unlock AND the test-track switch:
     a draft the switch listed must open and play through this same call, or
     the list would advertise a page that answers "isn't available". */
  const r = player.resolve(state.forays, {
    id,
    segmentsDoc: state.segments,
    sourcesDoc: state.segmentSources,
    ...forayViewOpts(),
  });
  // Same answer for "no such Foray" and "not published": a client that
  // distinguishes them announces the existence of unpublished work.
  if (!r) {
    $("#view").innerHTML = statusPageHtml({ title: "Foray", note: "That foray isn't available.", back: "#/forays" });
    return;
  }
  state.foray = r;
  state.forayPainted = null;   // fresh DOM: the paint guard must not skip it

  const draft = r.foray.status !== "published";
  /* Which door the draft came through decides what the page says about it:
     "by name" is the `?foray=` unlock, today's sentence exactly; otherwise
     the test-track switch let it in, and the sentence says so. */
  const draftNote = !draft ? ""
    : unlockedForays().includes(r.id) ? "Draft — not published. You opened it by name; nobody else sees it."
    : "Draft — not published. Shown because \"Show draft Forays\" is on in Settings; nobody else sees it.";
  /* TWO POPULATIONS, AND ONLY ONE OF THEM IS "BELOW" (audit 2026-09-22).
     `r.unplayable` is the union of the entries that resolved but will not play
     — which ARE rows in the running order below, marked "Can't play" — and the
     items hydration dropped (a segment id missing from data/segments.json),
     which never become entries and so are listed nowhere. "3 can't play —
     listed below" over a running order listing none of them pointed at rows
     that do not exist. Each is now counted and said separately. */
  const shownOut = r.entries.filter(e => !e.playable).length;
  const missing = Math.max(0, r.unplayable.length - shownOut);
  /* Read the resume point BEFORE anything is wired up: it decides the clock the
     page opens on, which rows are already ticked off, and what the main button
     says. Against the LIVE runtime AND the live segment count, so a repaired
     data file cannot leave someone resuming past the end of a Foray that got
     shorter, or paint a running order that is entirely behind them.

     Still guarded, for a narrower reason than the one that used to be written
     here. The service worker no longer refreshes app.js and the ES module on
     separate schedules — since #233 both are revalidated on every load and a
     page that falls back to the cache is pinned to it — but the module is loaded
     from a deferred module script tag, and the native shells run with no worker
     at all. An older or not-yet-evaluated module costs the resume offer, which
     is a missing banner rather than a page stuck on "Loading…". */
  /* `resolved` is the freshness half of #40, and it is about STORED state rather
     than about the worker: a `cp_` position written days ago can name a segment
     that a later `data/forays.json` moved or dropped, however fresh both the code
     and the data are. With the resolved Foray in hand the player looks the stored
     SEGMENT up in the live order instead of trusting the stored index — so a
     segment that moved resumes to the same audio, and one that is gone degrades
     to a clamped clock with no row marked current, rather than seeking somewhere
     wrong. */
  /* `includeFinished` (audit round 2, honesty-2): a finished Foray used to open
     exactly like one never touched, no banner, no mark. It now says "Played"
     with a "Play again" beside it, the finished episode's word. Split here so
     `resume` keeps meaning "a place to start from", which a finished Foray is
     not: its main button starts from the top, as before. */
  const point = typeof player.forayResume === "function"
    ? player.forayResume(r.id, { totalSec: r.totalSec, itemCount: r.playable.length, resolved: r, includeFinished: true })
    : null;
  const played = point && point.finished ? point : null;
  const resume = played ? null : point;
  state.forayResume = resume;
  forayPaintedLive = null;
  /* The document changed under a stored position. Nothing user-facing — the
     resume already degraded correctly — but it is the one signal that says how
     often real listeners hit it, and #40 is explicit that a stale-data event must
     be visible in the data rather than inferred later. */
  if (resume && typeof player.forayDriftIsClean === "function" && !player.forayDriftIsClean(resume)) {
    logEvent("foray_progress_drift", {
      foray_id: r.id, drift: resume.drift,
      elapsed_sec: Math.round(resume.elapsedSec), index: resume.index,
    });
  }
  const nudge = forayNudgeSteps(player);

  $("#view").innerHTML = `
    <div class="page foray">
      <div class="page-head">
        <a class="back" href="#/forays">‹</a>
        <div>
          <h2>${esc(r.title)}</h2>
          <p class="sub">${esc(forayHeadSub(r, player))}</p>
        </div>
      </div>
      ${draft ? `<p class="fy-draft">${draftNote}</p>` : ""}
      ${r.foray.summary ? `<p class="fy-summary">${esc(r.foray.summary)}</p>` : ""}
      <div class="fy-transport">
        ${resume ? `<div class="fy-resume" id="fy-resume">
          <div class="fy-bar"><span class="fy-bar-fill" id="fy-bar-fill"></span></div>
          <p class="fy-resume-line">
            <span class="fy-resume-at">Jump back in at ${esc(player.fmtClock(resume.elapsedSec))}</span>
            <span class="fy-resume-left">${esc(resume.label)}</span>
          </p>
          <button type="button" class="fy-restart" id="fy-restart">Start over</button>
        </div>` : ""}
        ${played ? `<div class="fy-resume fy-played" id="fy-resume">
          <div class="fy-bar"><span class="fy-bar-fill" data-pct="100"></span></div>
          <p class="fy-resume-line">
            <span class="fy-resume-left">${esc(played.label)}</span>
          </p>
          <button type="button" class="fy-restart" id="fy-restart">Play again</button>
        </div>` : ""}
        <!-- Plain bars, replaced wholesale by the SegmentStrip component in
             mountForayStrip below (#128). They stay in the markup as the
             fallback for a page paired with an older cached module, and are the
             only reason this element is never empty. -->
        <div class="fy-strip" id="fy-strip">${r.playable.map((_, i) =>
          `<span class="fy-seg" data-seg="${i}"><i class="fy-seg-fill"></i></span>`).join("")}</div>
        <div class="fy-times"><span id="fy-now">0:00</span><span id="fy-total"></span></div>
        <!-- THE SEEK PAIR STAYS THE SEEK PAIR (audit 2026-09-22, persona 58).
             The two buttons beside Play were previous/next clip, so the
             gesture every other player has taught — missed a sentence, tap
             back — threw the listener to the top of an eleven-minute clip.
             ↺15 / 30↻ nudge on the Foray's own clock here, as they do in the
             Now Playing sheet; previous/next clip have their own row below,
             labelled in words. The numbers come from the player bridge so this
             page and the sheet cannot disagree about a step. -->
        <div class="fy-controls">
          <button type="button" class="fy-btn" id="fy-back" aria-label="Back ${nudge.back} seconds">↺ ${nudge.back}</button>
          <button type="button" class="fy-btn fy-main" id="fy-play"${controlLabelAttr("▶ Play", "Play")}>▶ Play</button>
          <button type="button" class="fy-btn" id="fy-fwd" aria-label="Forward ${nudge.fwd} seconds">${nudge.fwd} ↻</button>
          <!-- Playback speed (#242). On the transport row rather than in a settings
               screen, because this is the surface a listener is looking at when
               they decide a segment is slow — and its current value is the label,
               so it is legible without opening anything. The label and the
               accessible name both come from the player bridge, so this button and
               the mini-player's cannot word the same speed two ways. It opens the
               speed menu (a dialog, openRateMenu), and says so the way the
               sheet's button does (audit round 2, player-9): VoiceOver reads
               "pop-up button" before the tap, not a surprise after it. -->
          <button type="button" class="fy-btn fy-rate" id="fy-rate" aria-label="Playback speed" aria-haspopup="dialog">1×</button>
        </div>
        <!-- The guillemets are decoration: the accessible name is the words
             alone, or VoiceOver opens with "single left-pointing angle
             quotation mark" (visual pass 1 review, 2026-09-23). -->
        <div class="fy-clips">
          <button type="button" class="fy-clip" id="fy-prev" aria-label="Previous clip">‹ Previous clip</button>
          <button type="button" class="fy-clip" id="fy-next" aria-label="Next clip">Next clip ›</button>
        </div>
        <!-- A start that failed says so HERE, and a screen reader hears it
             without moving focus off the button that was just pressed. -->
        <p class="fy-error" id="fy-error" role="status" aria-live="polite" hidden></p>
      </div>
      ${shownOut ? `<p class="note">${countLabel(shownOut, "clip")} can't play — marked below.</p>` : ""}
      ${missing ? `<p class="note">${countLabel(missing, "clip")} from this foray couldn't be found, so ${missing === 1 ? "it's" : "they're"} left out.</p>` : ""}
      ${r.slots.map(foraySlotHtml).join("")}
      ${foraySourcesHtml(r, player)}
      ${feedbackSheetHtml()}
    </div>`;

  /* The clock beside the scrubber keeps its clock shape — it sits opposite a
     ticking one — but an estimate carries a "~" so it cannot pass for a
     measurement (same `stripTally` flag as the header above). */
  const tally = typeof player.stripTally === "function" ? player.stripTally(r.playable) : null;
  $("#fy-total").textContent = `${tally && tally.estimated ? "~" : ""}${player.fmtClock(r.totalSec)}`;
  mountForayStrip(r, player);
  // Optional-chained deliberately. This runs BEFORE every binder, so if the
  // markup and this line ever disagree the throw would take the whole transport
  // down with it — an unfilled progress bar is a far better failure. CI catches
  // the disagreement itself: the hook is pinned in player/foray-playback.test.js.
  if (resume) { const fill = $("#fy-bar-fill"); if (fill) fill.style.width = `${resume.percent}%`; }
  if (played) sizeProgressBars($("#view"));
  bindFeedback(r);
  bindSourceLinks(r);
  bindForayTransport(r, player, resume);
  pageDidPaint();   // the real page is up: a clamped back-step restore can land now
  joinForayCreditsToShowIndex(r, player);
}
