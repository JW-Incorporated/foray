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
     the thumbs cannot name the same beat two different ways.

     DRAWN, NOT TYPED (Tactile `foray`, BUILD-PLAN 2.17). The two votes were the
     emoji 👍 and 👎, which the Dial family bans (no text glyph standing in for an
     icon) and which drew a different picture on every platform. They are the
     sprite's check (more like this) and x (less like this), 44px targets. */
  const named = forayBeatName(entry);
  const one = (dir, icon, label) =>
    `<button type="button" class="fy-thumb ${vote === dir ? "on" : ""}" data-thumb="${dir}"
        data-seg-id="${esc(entry.segment_id)}" aria-pressed="${vote === dir}"
        aria-label="${esc(label)} ${esc(named)}">${tactileIcon(icon, "sm")}</button>`;
  return `<div class="fy-fb">
    ${one("up", "ph-check", "More like")}${one("down", "ph-x", "Less like")}
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
        ? `<a class="show-link" href="${esc(safeUrl("#" + showRoutePath(showId)))}">${esc(c.show)}</a>`
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

/* ---------- the Foray detail page, Dial (Tactile `foray`) ----------

   Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.17 and
   BUILD-NOTES 4.6. The page is a back key and a share key, the Foray's tag and
   title, the band in a well, a readout, the summary and why-line, the shows it
   draws on, its clips grouped by slot, and ONE extended Play key pinned over the
   deck. Everything the old page carried that this drops (the transport row,
   speed, the scrubbable strip, the resume banner) lives in the Now Playing
   sheet and the mini player now; the engine hooks the page keeps are `#fy-play`,
   `[data-fy]`, the thumbs, the reason sheet, the sources and `#fy-error`.

   WORDS. The prototype says "segments"; the copy rules call `segment` pipeline
   vocabulary, and Now Playing already renamed its heading "Clips" for it
   (PROGRESS.md, `now-playing` iteration 3), so this page says clips.

   EVERY STRING a listener's data can reach (a title, a show, a why-line, a
   transcript) goes through esc(); every href through safeUrl(). */

/** A clip's runtime as the mono readout: m:ss through the player's own clock. */
function forayClipClock(sec) {
  const player = window.ForayPlayer;
  if (!(Number(sec) > 0) || typeof player?.fmtClock !== "function") return "";
  return player.fmtClock(Number(sec));
}

/** The shows a Foray draws on, in first-appearance order, with the clips each
    contributes: `{ name, showId, clips }`. One list for the "From" rows, the
    station codes and the swatches, so none can disagree about who is there. */
function forayDetailShows(r) {
  const order = [];
  const by = new Map();
  for (const e of r.entries) {
    if (isForayNarration(e) || !e.show) continue;
    if (!by.has(e.show)) {
      const row = { name: e.show, showId: forayShowId(e), clips: 0 };
      by.set(e.show, row);
      order.push(row);
    }
    by.get(e.show).clips += 1;
  }
  return order;
}

/** Show name -> two-letter station code, by the band's own resolver, so the
    codes under the bars, in the swatches and in the "From" rows are the same. */
function forayStationCodes(shows) {
  return tactileStationCodes(shows.map(s => ({ id: s.name, name: s.name })));
}

/** The enamel class a show wears on the band (and on its swatch). */
function forayEnamelClass(showName, enamels) {
  const own = enamels && Object.prototype.hasOwnProperty.call(enamels, showName) ? enamels[showName] : undefined;
  return `t-band__bar--c${Number.isInteger(own) ? own : tactileHash(showName)}`;
}

/** The band's bars: the strip model with each run of back-to-back narration drawn
    as ONE hatched tick (the same merge Today's hero uses), as `tactileBand` input,
    plus the model itself so the live paint can map playable items to bars. */
function forayBandModel(r, player) {
  const model = typeof player?.stripModel === "function" ? player.stripModel(r.playable, { mergeNarration: true }) : null;
  const items = model && Array.isArray(model.segments) ? model.segments : [];
  /* The same per-foray enamels Today's card reads (tactileForayEnamels), so a show is one
     colour on the card, on this band, in the From swatches and in the player. */
  const enamels = tactileForayEnamels(items);
  const segments = items.map(s => ({
    showId: tactileForayShowKey(s),
    show: s.kind === "narration" ? "" : (s.show || ""),
    duration: s.lengthSec,
    narration: s.kind === "narration",
    enamel: s.kind === "narration" ? -1 : enamels[tactileForayShowKey(s)],
  }));
  return { items, segments, enamels };
}

/** The drawn band's width in CSS px, for the bars' minimum-width arithmetic and
    the station-code cut-off only: the viewport less the page gutters and the
    well's own padding. */
function forayBandWidth() {
  const vw = Math.max(280, Math.min(Number(window.innerWidth) || 393, 680));
  return vw - 2 * 16 - 2 * 10;
}

/** The index of the band bar drawing playable item `index` (a merged narration
    run draws several items as one bar), or -1. */
function forayBandBarOf(items, index) {
  return items.findIndex(b => index >= b.index && index < b.index + (b.itemCount || 1));
}

/** The band for a Foray that exists, in its well. `progress` is 0-1 along the
    runtime; `current` is the playable item the needle is in.

    THE BARS ARE THE PRIMITIVE'S; THE CODES AND THE NEEDLE ARE HTML OVER THEM.
    The band's SVG is drawn in a 1000x60 box stretched to the well with
    `preserveAspectRatio="none"`, so a glyph in it is squeezed to a third of its
    width (the codes read as faint condensed ticks) and a needle's cap is an
    ellipse. Now Playing hit the same wall and sets both as HTML (ui/now-playing.js
    `dialPaintBandCodes`); this does the same. The runs, the 24px cut-off and the
    current run are still the primitive's own: the codes are read back out of its
    markup rather than worked out a second time. Positions are `--x` custom
    properties written by `paintForayBand` (a style attribute would break the CSP). */
function forayBandHtml(band, { progress = 0, current = 0, label = "" } = {}) {
  const bar = Math.max(0, forayBandBarOf(band.items, current));
  const svg = tactileBand({
    id: "fdet-band", kind: "detail", segments: band.segments, renderWidth: forayBandWidth(),
    progress, currentIndex: bar, label,
  });
  const codes = [];
  const re = /<text class="t-band__code(?: is-current)?" data-run-start="(\d+)" data-run-end="(\d+)"(?: x="([\d.]+)" y="[\d.]+"| x="0" y="0" transform="translate\(([\d.]+) [\d.]+\)[^"]*") text-anchor="middle">([^<]*)<\/text>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    /* `m[5]` is the primitive's already-escaped code text; the rest is digits. The detail band
       (Tactile onboarding, group F) writes its centre as a translate(), the others as `x`. */
    codes.push(`<span class="fdet-code" data-run-start="${m[1]}" data-run-end="${m[2]}" data-x="${(Number(m[3] ?? m[4]) / 1000).toFixed(4)}">${m[5]}</span>`);
  }
  return `<div class="well fdet-well"><div class="fdet-stage">${svg}<div class="fdet-codes" aria-hidden="true">${codes.join("")}</div><span class="fdet-needle" aria-hidden="true"></span></div></div>`;
}

/** The unavailable Foray's well: no bars, no station labels (a code under
    nothing reads as a legend for a chart that failed to load), and the needle
    lifted off its slot. Drawn in HTML because a rotation of the primitive's
    SVG needle is stretched by its non-uniform viewBox scale. */
function forayEmptyWellHtml() {
  return `<div class="well fdet-well fdet-well--empty"><div class="fdet-stage"><div class="band band--detail band--empty" role="img" aria-label="No band: this foray isn't available right now"></div><span class="fdet-needle" aria-hidden="true"></span></div></div>`;
}

/** Back and share, the page's two keys. Back is a link (`a.back` is what the
    router's delegated handler steps history on, falling back to the Forays
    list on a cold open); share is a key, absent when there is nothing to share. */
function forayBarHtml({ share }) {
  return `<div class="fdet-bar">
    <a class="keycap keycap--sm keycap--paper back" ${routeLinkAttrs("#/forays")} aria-label="Back">${tactileIcon("ph-arrow-left")}</a>
    ${share ? tactileKeycap({ size: "sm", variant: "paper", icon: "ph-share-network", label: "Share this foray", id: "fdet-share" }) : ""}
  </div>`;
}

/** The "From" rows: a station swatch, the show's artwork, its name and how many
    clips it contributes. A row is a link when the show has a page of its own and
    plain text when it does not (a link to nothing is worse than a label). */
function forayFromRowHtml(show, codes = new Map(), enamels = null) {
  const art = tactileArtFrame({ size: "mini", url: showArtworkUrl({ title: show.name }), initials: tactileStationCode(show.name) });
  const swatch = `<span class="fdet-sw ${forayEnamelClass(show.name, enamels)}" aria-hidden="true">${esc(codes.get(show.name) || "")}</span>`;
  /* The plain-text branch carries `data-credit-show`: the show index loads after the
     first paint, and `relinkForayCredits` turns a name it now knows into the link. */
  const name = show.showId
    ? `<a class="row__link" href="${esc(safeUrl("#" + showRoutePath(show.showId)))}">${esc(show.name)}</a>`
    : `<span data-credit-show="${esc(show.name)}">${esc(show.name)}</span>`;
  return `<div class="row-show fdet-from">${swatch}${art}<div class="row__body"><h3 class="row__title">${name}</h3><p class="row__meta"><span class="readout">${esc(countLabel(show.clips, "clip"))}</span></p></div></div>`;
}

/** One beat of the running order. A playable beat is a row-wide button that
    starts the Foray THERE, with its two votes beside it (siblings, never inside:
    a button in a button never survives the parent's handler). A beat that will
    not play is a plain row that says so. Narration keeps its transcript. */
function forayRow(entry, codes = new Map(), enamels = null) {
  const narration = isForayNarration(entry);
  const name = narration ? narratorName() : (entry.show || "This clip");
  const swatch = narration
    ? `<span class="fdet-sw fdet-sw--narration" aria-hidden="true"></span>`
    : `<span class="fdet-sw ${forayEnamelClass(entry.show, enamels)}" aria-hidden="true">${esc(codes.get(entry.show) || "")}</span>`;
  const sub = entry.why || (!narration && entry.episode_title) || "";
  const text = `<span class="fdet-seg__text"><span class="row__title">${esc(name)}</span>${sub ? `<span class="label fdet-seg__sub">${esc(sub)}</span>` : ""}</span>`;
  /* THE LISTENER GETS A SENTENCE; THE REASON STAYS FOR US. The resolver's reason
     is a path into our data files; it rides on `data-reason`, where a field
     report can read it off the page and nobody reads it aloud. */
  if (!entry.playable) {
    return `<div class="fdet-seg is-out">
      <div class="fdet-seg__row">${swatch}${text}</div>
      <p class="label fdet-seg__out fy-out" data-reason="${esc(entry.reason || "unresolved")}">This clip isn't available right now.</p>
      ${narrationScriptHtml(entry)}
    </div>`;
  }
  const dur = forayClipClock(entry.duration_sec);
  return `<div class="fdet-seg">
    <div class="fdet-seg__row">
      <button type="button" class="segrow${narration ? " segrow--narration" : ""}" data-fy="${esc(String(entry.queueIndex))}"
          data-fy-name="${esc(forayBeatName(entry))}" aria-label="${esc(forayJumpLabel(forayBeatName(entry), ""))}">
        ${swatch}${text}
        <span class="fdet-state" aria-hidden="true">${tactileIcon("needle", "sm")}</span>
        ${dur ? `<span class="readout fdet-seg__len">${esc(dur)}</span>` : ""}
      </button>
      ${thumbsHtml(entry)}
    </div>
    ${narrationScriptHtml(entry)}
  </div>`;
}

/** A row's accessible name, by where the listener is. The needle that shows it
    on screen is an aria-hidden icon, so for a screen reader the row's state
    lived nowhere: twelve identical "Play …" buttons, with no way to tell the one
    sounding now or the ones already heard. paintForay writes this beside the
    classes, from the same comparison. */
function forayJumpLabel(name, where) {
  if (where === "playing") return `Now playing: ${name}`;
  if (where === "played") return `Played. Play again: ${name}`;
  return `Play ${name}`;
}

function foraySlotHtml(slot, codes = new Map(), enamels = null) {
  if (!slot.entries.length) {
    return `<div class="fdet-slot">
      <h3 class="h17">${esc(slot.title)}</h3>
      <p class="label fdet-muted">Nothing in this part yet.</p>
    </div>`;
  }
  return `<div class="fdet-slot">
    <h3 class="h17">${esc(slot.title)}</h3>
    ${slot.entries.map(e => forayRow(e, codes, enamels)).join("")}
  </div>`;
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
  view.querySelectorAll("[data-credit-show]").forEach((span) => {
    const show = span.dataset.creditShow;
    const id = showIdForShowName(show);
    if (id) span.outerHTML = `<a class="row__link" href="${esc(safeUrl("#" + showRoutePath(id)))}">${esc(show)}</a>`;
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

/* ---------- Foray detail: state, pin, share, why ---------- */

/** What the pinned key says, from where the listener is. ONE function for the
    first paint and for every tick, so the two cannot word a state differently.

      running                   Pause            elapsed clock (the total, before a few seconds)
      loading                   Loading…         nothing
      finished (played to end)  Start over       nothing
      paused mid-way / stored   Resume           elapsed clock
      never started             Play             the runtime

    `name` is the accessible name only where the visible words are not enough
    (the key's text is its name otherwise, so a voice-control "Resume" matches). */
function forayPinState({ running = false, loading = false, ended = false, started = false, elapsed = 0, totalSec = 0 } = {}) {
  const player = window.ForayPlayer;
  const clock = (sec) => (typeof player?.fmtClock === "function" ? player.fmtClock(sec) : "");
  const span = typeof player?.fmtSpan === "function" ? player.fmtSpan(totalSec) : "";
  const at = elapsed > 3 ? clock(elapsed) : span;
  if (running) return { word: "Pause", read: at, name: "Pause", running: true };
  if (loading) return { word: "Loading…", read: "", name: "Loading, please wait", running: false };
  if (ended) return { word: "Start over", read: "", name: "Start over", running: false };
  if (started) return { word: "Resume", read: clock(elapsed), name: "", running: false };
  return { word: "Play", read: span, name: "", running: false };
}

/** The pinned key: one extended persimmon keycap, play glyph + word + mono
    readout. `data-ctl-icons` makes the play and pause glyphs sprite icons chosen
    by CSS from `data-playing`, so no engine ever writes a text glyph into it. */
function forayPinHtml(pin) {
  return `<div class="fdet-pin">
    <button type="button" class="keycap keycap--persimmon keycap--lg keycap--round keycap--pin" id="fy-play" data-ctl-icons${pin.running ? ' data-playing="1"' : ""}${pin.name ? ` aria-label="${esc(pin.name)}"` : ""}>
      ${tactileIcon("ph-play-fill")}${tactileIcon("ph-pause-fill", "", "i--swap")}
      <span class="keycap__label">${esc(pin.word)}</span>
      <span class="readout keycap__readout"${pin.read ? "" : " hidden"}>${esc(pin.read)}</span>
    </button>
  </div>`;
}

/** The page's `data-foray-state`, which the stylesheet reads: `progress` shows the
    needle and dims what is ahead, `done` shows every bar, `fresh` is the browsing
    shape of the Foray. */
function forayStateName({ started, finished }) {
  return finished ? "done" : started ? "progress" : "fresh";
}

/** The address a share carries. A published Foray is its hash route on the public
    site; a draft is the `?foray=` address that unlocks it. */
const FORAY_SHARE_BASE = "https://jw-incorporated.github.io/foray/";
function forayShareUrl(r) {
  return r.foray.status === "published"
    ? `${FORAY_SHARE_BASE}#${forayRoutePath(r.id)}`
    : `${FORAY_SHARE_BASE}?foray=${encodeURIComponent(r.id)}`;
}

/** Share the Foray: the shell's own share sheet when it has one, the browser's
    Web Share when it does, else the link on the clipboard with a spoken line. A
    dismissed sheet is not an error. No network write, so nothing for the lab flag
    to hold back. */
async function shareForay(r) {
  const url = forayShareUrl(r);
  const title = r.title;
  try {
    const native = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    if (native && typeof native.share === "function") {
      await native.share({ title, text: title, url, dialogTitle: "Share this foray" });
      return;
    }
    if (typeof navigator.share === "function") {
      await navigator.share({ title, url });
      return;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(url);
      announce("Link copied.");
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;   // the sheet was dismissed
    console.warn("[foray] share failed", err);
  }
}

function bindForayShare(r) {
  const btn = $("#fdet-share");
  if (btn) btn.addEventListener("click", () => shareForay(r));
}

/** "Why today": a reason only when one is OBSERVED, never invented (product
    principle 2). A first run says what 4a does on a first run; the stretch pick
    says it is outside the listener's usual subjects, on purpose; a subject the
    listener has moved up says so; anything else prints no why at all. Each is
    held to the 18-word ceiling. */
function forayWhyToday(r) {
  try {
    const branch = String(r.foray.topic || "").split("/")[0];
    let line = "";
    if (typeof todayIsFirstRun === "function" && todayIsFirstRun({ jumpBackIn: jumpBackInEntries(Infinity) })) {
      line = TODAY_FIRST_RUN_LINE;
    } else if (branch) {
      const picks = foraysForYouPicks();
      const stretch = picks && picks.stretchIndex >= 0 ? picks.picks[picks.stretchIndex] : null;
      if (stretch && stretch.id === r.id) line = stretchBridgeText(subjectLabel(branch));
      else if (interestScore({ topics: [branch] }) > 0.5) line = `A pick for your interest in ${subjectLabel(branch)}.`;
    }
    return line && wordCount(line) <= 18 ? line : "";
  } catch (_) {
    return "";   // a reason we cannot work out is no reason, not a broken page
  }
}

/** The next Foray the listener can open, for "Try another foray": the first listed
    one that is not this id and resolves, else the Forays list. */
function nextAvailableForayHref(skipId) {
  try {
    const next = forayCards().find(f => f.id !== skipId && resolveListedForay(f.id));
    if (next) return "#" + forayRoutePath(next.id);
  } catch (_) { /* the list is the fallback */ }
  return "#/forays";
}

/** A Foray that is not there, or not published and not unlocked (the same answer
    for both: a client that tells them apart announces unpublished work). The
    well is empty, the needle lifted, the way out is the next Foray or Yours. */
function renderForayUnavailable(id) {
  state.foray = null;
  $("#view").innerHTML = `
    <div class="page foray fdet fdet--unavailable" data-foray-state="unavailable">
      ${forayBarHtml({ share: false })}
      <header class="fdet-head">
        <div class="fdet-tags">${tactileTag({ kind: "narration", text: "Foray" })}</div>
        <h1 class="display fdet-title">This foray isn't available right now.</h1>
      </header>
      ${forayEmptyWellHtml()}
      <div class="fdet-keys">
        <a class="keycap keycap--md keycap--persimmon" ${routeLinkAttrs(nextAvailableForayHref(id))}><span class="keycap__label">Try another foray</span></a>
        <a class="keycap keycap--md keycap--paper" href="${esc(safeUrl("#/library"))}"><span class="keycap__label">Yours</span></a>
      </div>
    </div>`;
  pageDidPaint();
}

/* The back link on this page goes to `#/forays`, not `#/`. enterForayFromQuery's
   whole point is that a `?foray=` link lands somewhere the unlocked DRAFT is
   still listed, so the back button is not a dead end for the one person
   reviewing it. That list moved off Home to `#/forays` on 2026-09-03, so this
   link moved with it. */
async function renderForay(id) {
  setBodyClass("view-page view-foray");
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
  if (!r) return renderForayUnavailable(id);
  state.foray = r;
  state.forayPainted = null;   // fresh DOM: the paint guard must not skip it
  state.forayBandPainted = null;

  const draft = r.foray.status !== "published";
  /* Which door the draft came through decides what the page says about it:
     "by name" is the `?foray=` unlock, today's sentence exactly; otherwise
     the test-track switch let it in, and the sentence says so. */
  const draftNote = !draft ? ""
    : unlockedForays().includes(r.id) ? "Draft — not published. You opened it by name; nobody else sees it."
    : "Draft — not published. Shown because \"Show draft Forays\" is on in Settings; nobody else sees it.";
  /* TWO POPULATIONS, AND ONLY ONE OF THEM IS "BELOW" (audit 2026-09-22).
     `r.unplayable` is the union of the entries that resolved but will not play
     — which ARE rows in the running order below, marked "isn't available" — and
     the items hydration dropped (a segment id missing from data/segments.json),
     which never become entries and so are listed nowhere. Each is counted and
     said separately. */
  const shownOut = r.entries.filter(e => !e.playable).length;
  const missing = Math.max(0, r.unplayable.length - shownOut);
  /* Read the resume point BEFORE anything is wired up: it decides the clock the
     page opens on, which rows are already ticked off, and what the pinned key
     says. Against the LIVE runtime AND the live segment count, so a repaired
     data file cannot leave someone resuming past the end of a Foray that got
     shorter, or paint a running order that is entirely behind them.

     Still guarded: the module is loaded from a deferred script tag, and the
     native shells run with no worker at all. An older or not-yet-evaluated
     module costs the resume offer, which is a missing "Resume" rather than a
     page stuck on "Loading…". `resolved` is the freshness half of #40: a stored
     position is looked up in the live order by SEGMENT, so a clip that moved
     resumes to the same audio and one that is gone degrades to a clamped clock.
     `includeFinished` (audit round 2, honesty-2): a finished Foray says
     "Played" and its key says "Start over"; `resume` keeps meaning "a place to
     start from", which a finished Foray is not. */
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

  const shows = forayDetailShows(r);
  const codes = forayStationCodes(shows);
  const band = forayBandModel(r, player);
  state.forayBand = { ...band, boxes: tactileBandLayout(tactileBandSegments(band.segments), forayBandWidth(), "detail") };
  state.forayFinished = Boolean(played);
  const tally = typeof player.stripTally === "function" ? player.stripTally(r.playable) : null;
  const narrated = tally ? tally.bridges > 0 : r.entries.some(isForayNarration);
  const clips = tally ? tally.clips : r.entries.filter(e => !isForayNarration(e)).length;
  const facts = joinMeta(
    forayRuntimeLabel(player, tally, r.totalSec),
    countLabel(tally ? tally.shows : shows.length, "show"),
    countLabel(clips, "clip"),
  );
  const started = Boolean(resume);
  const mark = resume ? resume.index : -1;
  const progress = resume && r.totalSec > 0 ? Math.min(1, resume.elapsedSec / r.totalSec) : (played ? 1 : 0);
  const bandLabel = tally
    ? `Foray band: ${countLabel(tally.clips + tally.bridges, "clip")} from ${countLabel(tally.shows, "show")}${tally.bridges ? ", with 4a narration between them" : ""}`
    : "Foray band";
  const pin = forayPinState({ ended: Boolean(played), started, elapsed: resume ? resume.elapsedSec : 0, totalSec: r.totalSec });
  const why = forayWhyToday(r);
  const summary = String(r.foray.summary || "").trim();

  $("#view").innerHTML = `
    <div class="page foray fdet" data-foray-state="${forayStateName({ started, finished: Boolean(played) })}">
      ${forayBarHtml({ share: true })}
      <header class="fdet-head">
        <div class="fdet-tags">${tactileTag({ kind: "narration", text: "Foray" })}${played ? tactileTag({ kind: "played", text: "Played" }) : ""}</div>
        <h1 class="display-xl fdet-title">${esc(r.title)}</h1>
      </header>
      ${forayBandHtml(band, { progress, current: Math.max(0, mark), label: bandLabel })}
      <div class="fdet-lead">
        <p class="readout fdet-facts">${esc(facts)}</p>
        ${narrated ? "" : `<p class="label fdet-muted">No narration yet on this one.</p>`}
        ${draft ? `<p class="label fdet-muted fy-draft">${esc(draftNote)}</p>` : ""}
        ${summary ? `<p class="fdet-summary">${esc(summary)}</p>` : ""}
        ${why ? `<div class="fdet-why"><span class="label fdet-muted">Why today</span><p class="fdet-why__line">${esc(why)}</p></div>` : ""}
        <!-- A start that failed says so HERE, and a screen reader hears it
             without moving focus off the key that was just pressed. -->
        <p class="label fdet-notice" id="fy-error" role="status" aria-live="polite" hidden></p>
        ${shownOut ? `<p class="label fdet-muted">${esc(countLabel(shownOut, "clip"))} can't play — marked below.</p>` : ""}
        ${missing ? `<p class="label fdet-muted">${esc(countLabel(missing, "clip"))} from this foray couldn't be found, so ${missing === 1 ? "it's" : "they're"} left out.</p>` : ""}
      </div>
      ${shows.length ? `<section class="fdet-sect">
        <h2 class="heading">From</h2>
        <div class="fdet-rows">${shows.map(s => forayFromRowHtml(s, codes, band.enamels)).join("")}</div>
      </section>` : ""}
      <section class="fdet-sect" id="fdet-clips">
        <h2 class="heading">Clips</h2>
        ${r.slots.map(slot => foraySlotHtml(slot, codes, band.enamels)).join("")}
      </section>
      ${foraySourcesHtml(r, player)}
      ${feedbackSheetHtml()}
      ${forayPinHtml(pin)}
    </div>`;

  bindFeedback(r);
  bindSourceLinks(r);
  bindForayShare(r);
  bindForayTransport(r, player, resume);
  pageDidPaint();   // the real page is up: a clamped back-step restore can land now
  joinForayCreditsToShowIndex(r, player);
}
