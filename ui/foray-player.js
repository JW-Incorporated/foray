/* ui/foray-player.js — Foray player surface: the segment strip, transport bindings, rate menu, paintForay.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* THE STRIP IS GONE FROM THIS PAGE (Tactile `foray`). The Foray detail page draws its
   band with the Dial primitive (`tactileBand`, ui/foray.js) and does not scrub: a
   position is chosen on the Now Playing sheet's band, and a clip row starts the Foray
   at that clip. What stood here (`mountForayStrip`, `segLenOf`, `stripElapsedAt`, the
   zoom-scrub gesture, `paintSegFill`) served only that strip. The pure modules under
   player/ (`segment-strip.js`, `strip-scrub-gesture.js`) are untouched and keep their
   own suites; this file just no longer calls them. */

const FORAY_IDLE = { index: -1, playing: false, ended: false, elapsedSec: 0 };

/* THE TWO THINGS A FAILED START MAY SAY, and there are only two because only
   two can be acted on.

   Autoplay refusal is not a fault. The browser is holding audio back until it is
   certain a person asked for it, which is a rule we live under rather than a bug
   — so it gets a plain instruction and the play button beneath it is the
   affordance, never a red line about an error. Everything else is a segment that
   did not arrive, where the connection is the first thing to check.

   Matched on the player's telemetry STRING rather than a structured field on
   purpose: app.js and player/client.js are cached and refreshed independently by
   the service worker (see the note in `renderForay`), so this page is regularly
   paired with a module of a different vintage. `NotAllowedError` is a DOM
   exception name — it is stable in both directions across that skew. */
/* WORDED FOR BOTH HOMES OF THIS FILE (audit 2026-09-22, qa row 141). The same
   bytes run in a browser tab and inside the Capacitor shell, where there is no
   visible browser and no reload button, so "your browser" and "reload the page"
   were instructions a phone listener could not follow. */
const FY_AUTOPLAY_HINT = "4a couldn't start the audio on its own — press play again and it will start.";
const FY_START_FAILED = "That clip couldn't load. Check the connection, then press play.";
/* A control that threw while the Foray was already running is a third thing, and
   it must not claim a segment failed to load: nothing did, the audio is still
   going, and the honest report is that the button did not take. */
const FY_TAP_FAILED = "That didn't register. Try it again, or restart 4a if it keeps happening.";

const FY_VOICE_FALLBACK = "Your chosen voice isn't installed; using the best available.";

function forayFailureCopy(signal) {
  return /NotAllowedError/.test(String(signal ?? "")) ? FY_AUTOPLAY_HINT : FY_START_FAILED;
}

/** Say it on the page. `signal` is whatever evidence there is — the player's own
    error line, or a caught exception — and null clears the line. */
function paintForayFailure(signal) {
  const copy = signal ? forayFailureCopy(signal) : "";
  // A browser being careful about audio is not an error, and must not be dressed
  // as one. styles.css tones `.is-hint` down to a note.
  paintForayNotice(copy, copy === FY_AUTOPLAY_HINT);
}

/** The one writer of the Foray page's notice line. It is a live region, so an
    unchanged message is not written again — see setStatusText. */
function paintForayNotice(text, hint) {
  const err = $("#fy-error");
  if (!err) return;
  err.hidden = !text;
  setStatusText(err, text);
  err.classList.toggle("is-hint", Boolean(text) && Boolean(hint));
}

/* Every tap on this page's transport goes through one of these two (#225).

   The click handlers are `async`, so a call that threw became an unhandled
   promise rejection: a console line, and a page that did not move a pixel. On a
   phone there is no console, which makes that outcome indistinguishable from a
   dead app — the founder's report was "starting it was difficult, not sure why".

   THEY DIFFER IN WHAT THEY MAY ASSUME, which is why they are two functions.
   A start that threw got nowhere, so the "this Foray is live" flag that the
   intent-paint set is a lie and has to go, or the next press of the main button
   means pause instead of another attempt. A control that threw while the Foray
   was ALREADY running is the opposite: the audio is still going, the player's own
   state is still the truth, and clearing the page's flags would leave a button
   labelled "Pause" that means "start" — the very confusion this issue is about.
   That one says so and touches nothing; the next tick owns the state. */
/* The record's copy of a failed tap (#225), and the only evidence that outlives
   the message on screen.

   A console line is not evidence on a phone — that is the whole reason #225 was
   reported as "several errors" with no error in it. `cp_diag` already holds the
   browser's side of a refusal (`play.rejected` becomes a `stop/autoplay` entry);
   this is the page's side, the exception that actually came back out of
   `playForay`, which nothing else in the record can see.

   WRAPPED, AND THE WRAP IS THE POINT. This runs inside the two guards that are
   this page's last defence against an unhandled rejection. A diagnostic that
   threw here would take the on-screen message down with it and restore the exact
   failure mode the issue is about: a tap that does nothing and says nothing.
   `record()` and `save()` are both written never to throw — but the function on
   `window` comes from a module the service worker refreshes independently of this
   file (see the vintage note in `renderForay`), so "never throws" is a property
   of a version, not of this call. Checked, and caught anyway.

   THE NAME, NEVER THE MESSAGE. `err.message` carries URLs and prose, and this
   record is built to be pasted into an issue. `player/diagnostic-log.js` drops
   anything that is not a bare identifier, so a message would be discarded there
   regardless; sending only the name means the rule is visible on both sides. */
function noteTapFailure(phase, err) {
  /* READ THE NAME IN ITS OWN GUARD. `err` is whatever was thrown, and reading a
     property off it can itself throw — a Proxy, a getter, an object from another
     realm. Folded into the guard below, a failure here would skip the write
     entirely, so the one error too strange to describe would also be the one that
     left no trace. `null` is a worse answer than `TypeError` and a far better one
     than silence. */
  let name = null;
  try { name = err?.name ?? null; } catch (_) { name = null; }
  try {
    if (typeof window.forayNoteTapFailure === "function") {
      window.forayNoteTapFailure(phase, name);
    }
  } catch (_) {
    /* A record that will not write is not a reason to lose the line on screen. */
  }
}

async function guardForayStart(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] start failed", err);
    state.forayPlaying = null;
    state.forayPainted = null;
    /* THE PAINT FIRST AND THE RECORD LAST, but the record lands either way.

       The order: the bridge comes from a module the service worker refreshes
       independently of this file, which is why it is wrapped at all. A `try`
       covers a throw and not a slow synchronous write, and every statement
       between the catch and the paint is one that can stand between a listener
       and the only thing on screen telling them what happened. #225 is a
       listener-facing bug, so the listener is served first.

       The `finally`: the argument to `paintForayFailure` is built before the call,
       and `String(err)` and both template reads throw on an exotic or hostile
       `err` — the same hazard `diagnostic-log.js`'s `asText` exists for. Without
       the `finally`, moving the record after the paint would mean that a failure
       to paint costs the record too, in exactly the case the evidence matters
       most: the surface did not appear, which IS this issue's literal symptom.

       And the signal is built in its own guard first, because that argument is
       evaluated BEFORE the call: `String(err)` and both template reads throw on a
       hostile `err`, and an exception raised here would escape this catch block
       and become the unhandled rejection the whole guard exists to prevent.
       "Error" is a poor description and it still reaches the listener as the
       ordinary load-failure line, which is the honest fallback — something failed
       and pressing play again is the thing to do. */
    let signal = "Error";
    try {
      signal = err?.name ? `${err.name}: ${err.message ?? ""}` : String(err);
    } catch (_) { /* an error too strange to describe is still an error */ }
    try {
      paintForayFailure(signal);
    } finally {
      noteTapFailure("start", err);
    }
    return null;
  }
}

async function guardForayTap(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] control failed", err);
    paintForayNotice(FY_TAP_FAILED, false);
    // Last, for the reason given in `guardForayStart` above.
    noteTapFailure("control", err);
    return null;
  }
}

function bindForayTransport(r, player, resume = null) {
  const onChange = (s) => paintForay(s);

  /* The discover pool is the only document we have that carries per-show
     artwork, and a lock screen wants a picture (#27). Passed from here rather
     than resolved inside the player because app.js is the side that owns the
     fetch; its absence costs the OS the publisher’s square and nothing else.
     Spread into both entry points below so a new one cannot forget it. */
  const forayOpts = { onChange, discoverDoc: state.discover };

  /* Both funnels are a `guardForayStart`, and the call into the player is the
     FIRST thing inside it — no await, no lookup, nothing between the tap and
     `playForay`. Safari only lets audio start inside the gesture that asked for
     it, and the gesture is spent by the first thing that waits (#225). Clearing
     the failure line is cleared in the same breath, because the message from the
     last attempt is not evidence about this one — inside the guard, so even that
     cannot become the unhandled rejection this whole thing is about. */
  const start = (index) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startIndex: index, ...forayOpts })));
  const startAt = (elapsedSec) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startElapsedSec: elapsedSec, ...forayOpts })));
  /* The key, pressed cold. With a stored position that means RESUME — the whole
     point of the feature — and an explicit index (a row) always wins, because
     the listener just named a clip. */
  /* FROM `state.forayResume`, NOT THE BIND-TIME `resume` (audit round 3,
     app-3-1). The closure was the point captured when the page rendered, so
     after play -> advance -> close the bar, Play restarted from that old point
     (or 0) and the player's next save overwrote the real one. paintForay
     re-reads the stored point when this Foray goes from live to cold. */
  const startOrResume = () => state.forayResume ? startAt(state.forayResume.elapsedSec) : start(0);

  // Nothing playable is not a disabled-looking key that still fires: say it with
  // the control's own state, so the page and the behaviour agree.
  if (!r.playable.length) {
    const play = $("#fy-play");
    if (play) {
      play.disabled = true;
      paintForayPin({ word: "Nothing to play", read: "", name: "Nothing to play", running: false });
    }
    return;
  }

  $("#fy-play").addEventListener("click", async () => {
    if (playerHasForay(r)) return guardForayTap(() => player.forayToggle());
    /* A FINISHED Foray's key says "Start over", and that is a different act from
       a first play: the finished mark goes, the stored row goes, and it is logged
       as a restart rather than as a play (a pause logged as a play is the kind of
       small lie that makes a metric useless six months later). */
    if (state.forayFinished) {
      if (typeof player.clearForayResume === "function") player.clearForayResume(r.id);
      logEvent("foray_restart", { foray_id: r.id, from_sec: Math.round(state.forayResume?.elapsedSec || resume?.elapsedSec || 0) });
      resume = null;
      state.forayResume = null;
      state.forayFinished = false;
      await start(0);
      return;
    }
    // Only the real start is an event. Logging a pause as a play is the same lie.
    logEvent("foray_play", {
      foray_id: r.id, segments: r.playable.length,
      resumed_from_sec: state.forayResume ? Math.round(state.forayResume.elapsedSec) : null,
    });
    await startOrResume();
  });

  $("#view").querySelectorAll("[data-fy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.dataset.fy);
      if (playerHasForay(r)) await guardForayTap(() => player.forayJump(index));
      else await start(index);
    });
  });

  /* Re-entering the page mid-Foray must paint the clip that is actually
     audible, and route this page's callback at the live player — otherwise the
     old, detached DOM keeps getting the updates and this one never moves.

     With nothing live, the page opens on the STORED position rather than at
     zero: the key says Resume and the band's needle stands where they left off.
     A resume offer that leaves the page looking untouched is a resume offer
     nobody believes. */
  const live = player.watchForay(onChange);
  paintForay(live && live.forayId === r.id ? live : FORAY_IDLE);
}

/** Is the player already inside THIS Foray? Pressing play on a Foray that is
    already loaded must resume it, not rebuild the queue from segment 1. */
function playerHasForay(r) {
  return Boolean(state.forayPlaying === r.id);
}

/** The only thing that changes 4x a second. Deliberately not a re-render: the
    running order is dozens of rows and rebuilding it would fight the scroll
    position and drop focus. */
/** Which Foray the page last painted LIVE (app-3-1), so a cold tick can tell
    "just stopped" from "never started". Reset by every renderForay. */
let forayPaintedLive = null;

/** Re-read this Foray's stored resume point into `state.forayResume` (and whether
    the stored row says it was played to the end into `state.forayFinished`). */
function refreshForayResume() {
  const r = state.foray;
  const player = window.ForayPlayer;
  if (!r || !player || typeof player.forayResume !== "function") return;
  let point = null;
  try {
    point = player.forayResume(r.id, { totalSec: r.totalSec, itemCount: (r.playable || []).length, resolved: r, includeFinished: true });
  } catch (_) { point = null; }
  state.forayResume = point && !point.finished ? point : null;
  state.forayFinished = Boolean(point && point.finished);
}

/** The pinned key, written from `forayPinState`. The glyphs are sprite icons the
    stylesheet chooses between by `data-playing`; only the word, the readout and
    the accessible name are written, and only when they changed (the key is read
    aloud, and this runs four times a second). */
function paintForayPin(pin) {
  const btn = $("#fy-play");
  if (!btn) return;
  setStatusText(btn.querySelector(".keycap__label"), pin.word);
  const read = btn.querySelector(".keycap__readout");
  if (read) {
    setStatusText(read, pin.read);
    read.hidden = !pin.read;
  }
  if (pin.running) btn.setAttribute("data-playing", "1"); else btn.removeAttribute("data-playing");
  setControlLabel(btn, null, pin.name || null);
}

/** The band: the filled part and the needle at the listener's place, and the run
    the needle is in drawn in `--ink`. The geometry is the primitive's own
    (`tactileBandX` over the same laid-out boxes the render used), so the needle
    and the bars cannot drift apart. The codes' and needle's positions are custom
    properties (a style attribute would break the CSP). Written only when it moves. */
function paintForayBand(elapsedSec, mark) {
  const r = state.foray;
  const band = state.forayBand;
  if (!r || !band) return;
  const frac = r.totalSec > 0 ? Math.max(0, Math.min(1, elapsedSec / r.totalSec)) : 0;
  const x = tactileBandX(band.boxes, frac);
  const bar = forayBandBarOf(band.items, mark);
  const key = `${x.toFixed(2)}/${bar}`;
  if (state.forayBandPainted === key) return;
  const first = state.forayBandPainted == null;
  state.forayBandPainted = key;
  const view = $("#view");
  const progress = view.querySelector(".fdet-well .band__progress");
  if (progress) progress.setAttribute("width", x.toFixed(2));
  const needle = view.querySelector(".fdet-well .fdet-needle");
  if (needle) needle.style.setProperty("--x", String(x / 1000));
  view.querySelectorAll(".fdet-well .fdet-code").forEach(code => {
    if (first) code.style.setProperty("--x", code.getAttribute("data-x") || "0");
    const a = Number(code.getAttribute("data-run-start"));
    const b = Number(code.getAttribute("data-run-end"));
    code.classList.toggle("is-current", bar >= a && bar <= b);
  });
}

function paintForay(s) {
  if (!state.foray) return;
  /* SOMEBODY ELSE'S FORAY IS NOT THIS PAGE'S NEWS. `watchForay` points the live
     player's callback at whichever page rendered last, so with Foray A playing in
     the mini bar, opening Foray B's page (the home rail does exactly this) fed
     A's ticks into B's paint: B's key read "Pause" and pressing it paused A.
     The first paint has always been gated this way — `renderForay` compares
     `live.forayId === r.id` — and the ticks after it were not. `FORAY_IDLE`
     carries no id and must still get through: it is this page saying "nothing". */
  if (s.forayId && s.forayId !== state.foray.id) return;
  /* A START THAT FAILED IS NOT A LIVE FORAY (#225).

     `playForay` paints its intent before it awaits the load — deliberately, so a
     tapped row lights up immediately — which means an index arrives on this page
     a moment BEFORE the audio is known to exist. When the load or the play is
     then refused, that index was the only thing standing, and everything below
     read it as "playing": the key relabelled, and `state.forayPlaying` made the
     next press of it mean PAUSE rather than a retry. Two controls that had meant
     the same thing now meant different things, with nothing on screen to say why
     — which is the whole of the founder's report.

     An error with nothing playing, nothing loading and no beat running is a
     failed start, and the page goes back to being cold with a line that says so. */
  const failed = Boolean(s.error) && !s.playing && !s.loading && !s.gap;
  const live = s.index >= 0 && !failed;
  state.forayPlaying = live ? state.foray.id : null;
  /* LIVE -> COLD RE-READS THE STORED POINT (audit round 3, app-3-1). The resume
     point was read once, at render; after the listener played on and closed
     the bar, the cold page (needle, key, and the Play the next press runs)
     fell back to that stale point, or to 0. */
  if (live) forayPaintedLive = state.foray.id;
  else if (forayPaintedLive === state.foray.id) {
    forayPaintedLive = null;
    refreshForayResume();
  }

  /* Nothing loaded — cold, or the mini bar was just closed. Fall back to the
     stored resume point rather than repainting the page as untouched: the key
     above still says "Resume 19:40" and still resumes there, so a needle at the
     start underneath it would be the page contradicting itself. */
  const resume = live ? null : state.forayResume;
  /* THE COLD CLOCK IS THE STORED POINT, AND ONLY THAT — the same expression the
     key starts from, so the two cannot disagree.

     It used to read `s.elapsedSec` first, which is right while something is live
     and wrong the moment a start fails: `forayPosition()` answers with the failed
     clip's own start, so a refused jump to clip 20 left the clock reading
     37:31 over a key that goes to 19:40. A phantom position is worse than a
     stale one, because the listener can act on it. */
  const elapsed = live ? (s.elapsedSec || 0) : (resume?.elapsedSec || 0);

  /* Everything before this index is behind the listener. While something is
     playing that is the live clip; before anything has started it is the stored
     resume point, so a page opened cold shows the hour already half ticked off
     instead of pretending it was never touched. */
  const mark = live ? s.index : (resume?.index ?? -1);

  /* Five states, and the key has all of them. A seam beat is a FOURTH "running":
     the Foray is between two clips on purpose, and the key has to mean "stop" for
     the half second the silence lasts; labelling that half second "Loading…" would
     be the app apologising for its own edit. `s.running` FIRST (audit
     2026-09-22): it is the player's `transportIsRunning()`, the same answer
     `forayToggle` decides the press by; `playing || gap` is the belief alone, and
     in the #689 drift it said "Resume" over sound while the press paused. The
     fallback is for a player module of an older vintage. A FINISHED Foray is a
     fifth state, not a paused one: there is nothing to resume, and the press
     starts it from the top. */
  const running = typeof s.running === "boolean" ? s.running : (s.playing || s.gap);
  const started = live || elapsed > 0;
  const ended = Boolean(s.ended) || (!live && state.forayFinished);
  paintForayPin(forayPinState({
    running: Boolean(running), loading: Boolean(s.loading), ended, started, elapsed, totalSec: state.foray.totalSec,
  }));
  const page = $("#view").querySelector(".fdet");
  if (page) page.setAttribute("data-foray-state", forayStateName({ started: started && !ended, finished: ended }));
  /* The run the needle is in is drawn in --ink only where there is a needle: a browsing or played
     page has no current run, so the mark is -1 there (and `forayBandBarOf` answers -1). */
  paintForayBand(ended ? state.foray.totalSec : elapsed, ended || !started ? -1 : mark);

  /* The player's own words are telemetry, not copy. Say the one thing a
     listener can act on, and keep the detail in the console.
     V-01's live-narration notice shares the line: shown only when there is no
     real error claiming it — a load failure is the more urgent message, and
     this one is informational ("still working, just not with the exact voice
     you picked"). Checked here, ahead of the `forayPainted` gate below, because
     it has to show up (and clear) on the FIRST tick.

     ONE WRITE PER TICK, AND ONLY A CHANGE IS A WRITE (audit 2026-09-22, qa row
     66). `#fy-error` is an aria-live region and this runs at 4 Hz: the line's one
     message is decided first and `paintForayNotice` skips an unchanged one. */
  if (s.error) paintForayFailure(s.error);
  else if (s.voiceFallback) paintForayNotice(FY_VOICE_FALLBACK, true);
  else paintForayFailure(null);

  /* The row classes only change when the clip does, and this runs on every
     position tick. Guard it: dozens of rows x 4 Hz of class churn for a value
     that changes once a minute is work nobody asked for.

     Keyed on the LIVE index, not the raw one: a start that failed at clip 12
     has to clear the highlight it painted a moment ago, and keying on `s.index`
     — which does not change when the load fails — would skip that repaint and
     leave a row lit under a message saying nothing is playing. */
  const liveIndex = live ? s.index : -1;
  if (state.forayPainted === liveIndex) return;
  state.forayPainted = liveIndex;

  $("#view").querySelectorAll("[data-fy]").forEach(row => {
    const i = Number(row.dataset.fy);
    const playing = i === liveIndex;
    const played = mark >= 0 && i < mark;
    row.classList.toggle("is-playing", playing);
    row.classList.toggle("is-played", played);
    if (playing) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
    if (row.dataset.fyName) {
      setControlLabel(row, null, forayJumpLabel(row.dataset.fyName, playing ? "playing" : played ? "played" : ""));
    }
  });
}
