/* ui/drawer-dev.js — Drawer developer group: voice probe, engine override rows.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- the Developer group (2026-09-22 audit, founder ruling R8) ----------

   "Show draft Forays", "Voice engine probe" and "Playback diagnostics" are the
   founder's field-report tools, and they sat among a listener's three real
   settings: the persona audit read them as debug switches shipped to everyone,
   and one of them offers a button that blocks for ~90 seconds. They must stay
   REACHABLE — the founder files reports from a car with them — so they are not
   hidden behind an unlock. They are grouped instead: one collapsed "Developer"
   disclosure at the bottom of Settings, directly above "Delete my data" (which
   stays the drawer's last item, by `bindDeleteControl`'s rule).

   A native <details>, so it opens from a tap, Enter or Space and announces its
   state with no script, and it starts CLOSED on every launch. Built once;
   every caller gets the same element — remembered on the drawer itself, the
   way `ensureInterestsDrawerLink` remembers its link, so a lookup that cannot
   see appended nodes can never build a second group. */
function drawerDevGroup() {
  const drawer = $("#drawer");
  if (!drawer) return null;
  if (drawer._devGroup) return drawer._devGroup;
  const group = ddEl("details", "drawer-dev", null);
  group.id = "drawer-dev";
  group.appendChild(ddEl("summary", "drawer-item", "Developer"));
  drawer.appendChild(group);
  drawer._devGroup = group;
  return group;
}

/** The founder's two switches, into the Developer group. */
function bindDeveloperToggles() {
  const into = drawerDevGroup();
  if (!into) return;
  /* The founder's test track (see § showDraftsOn). No event is logged: this is
     his own switch, not listener behaviour worth a row. */
  drawerToggle("drafts-toggle", "Show draft Forays", showDraftsOn,
    (on) => lsSet("cp_show_drafts", on), { repaint: true, into });

  /* K-01's measurement switch (see § voiceProbeOn). Its RUN button is not a
     switch and is added/removed by `syncVoiceProbeRun` instead. */
  drawerToggle("voice-probe-toggle", "Voice engine probe", voiceProbeOn,
    (on) => lsSet("cp_voice_probe", on), { into });
}

/** The run control, created on demand by `renderDrawer`. Returns nothing; the
    element is found by id like every other drawer control. */
function syncVoiceProbeRun() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const toggle = $("#voice-probe-toggle");
  const existing = $("#voice-probe-run");
  if (!voiceProbeOn()) {
    if (existing) existing.remove();
    for (const id of ["#voice-probe-soak", "#voice-probe-arm", "#voice-probe-reset"]) {
      const el = $(id);
      if (el) el.remove();
    }
    return;
  }
  if (existing) return;
  const run = ddEl("button", "drawer-item as-btn", "Run the voice engine probe");
  run.type = "button";
  run.id = "voice-probe-run";
  /* Immediately after the toggle, not at the end of the drawer: "Delete my
     data" is the last item by the rule `bindDeleteControl` states, and a
     control that appears BELOW it would be the one a scrolled thumb lands on
     instead. */
  if (toggle && toggle.parentNode) toggle.parentNode.insertBefore(run, toggle.nextSibling);
  else (drawerDevGroup() || drawer).appendChild(run);
  run.disabled = Boolean(voiceProbeRunning);   // a control rebuilt mid-run is still busy (app-3-11)
  run.addEventListener("click", () => runVoiceProbe());

  /* KV-R3: the optional 30-minute SOAK (docs/voice/kokoro-speed-1.5x.md §5
     item 9), iPhone only — Android's probe has no soak. Directly under the
     run control, for the reason that one sits under its switch. */
  if (!voiceSoakOffered() || !run.parentNode) return;
  const soak = ddEl("button", "drawer-item as-btn", VOICE_SOAK_START_LABEL);
  soak.type = "button";
  soak.id = "voice-probe-soak";
  run.parentNode.insertBefore(soak, run.nextSibling);
  paintVoiceSoakControl(soak);
  /* KV-R3 review: WHILE A SOAK RUNS this control STOPS it — thirty minutes
     is too long to hold a phone hostage to an instrument. */
  soak.addEventListener("click", () => (voiceProbeRunning && voiceProbeRunningSoak ? stopVoiceSoak() : runVoiceProbe("soak")));

  /* PROBE v3.1, iPhone only, under the soak. "Arm Core ML (may crash)": on
     iOS 26.4+ Apple's libBNNS crashes the Kokoro Core ML chain (FluidAudio
     #844/#889; the founder's two crashes on build 2026092705), so the probe
     refuses Core ML there (`coreml-bnns-os`) unless this is on. IN MEMORY
     ONLY, never stored: a crash relaunches the app disarmed, so it can never
     crash-loop. "Reset skipped passes": a pass that killed 4a is skipped by
     every later run until this is tapped. */
  const arm = ddEl("button", "drawer-item as-btn", "");
  arm.type = "button";
  arm.id = "voice-probe-arm";
  soak.parentNode.insertBefore(arm, soak.nextSibling);
  paintVoiceProbeArm(arm);
  arm.addEventListener("click", () => {
    voiceProbeArmCoreML = !voiceProbeArmCoreML;
    paintVoiceProbeArm(arm);
  });
  const reset = ddEl("button", "drawer-item as-btn", VOICE_PROBE_RESET_LABEL);
  reset.type = "button";
  reset.id = "voice-probe-reset";
  arm.parentNode.insertBefore(reset, arm.nextSibling);
  reset.addEventListener("click", () => resetVoiceProbeSkips());
}

/* PROBE v3.1: whether the NEXT matrix run may run Core ML on iOS 26.4+.
   Per app session, never persisted (see syncVoiceProbeRun). */
let voiceProbeArmCoreML = false;
const VOICE_PROBE_RESET_LABEL = "Reset skipped passes";

function paintVoiceProbeArm(btn) {
  setControlLabel(btn, voiceProbeArmCoreML
    ? "Arm Core ML (may crash): ON for the next run"
    : "Arm Core ML (may crash): off");
}

/** "Reset skipped passes": the passes that killed 4a run again next time. */
function resetVoiceProbeSkips() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  if (!player || typeof player.resetVoiceProbeSkips !== "function") {
    ui.status.textContent = "This build has no skipped passes to reset.";
    return Promise.resolve(null);
  }
  return Promise.resolve(player.resetVoiceProbeSkips()).then((out) => {
    ui.status.textContent = out && out.ok
      ? `Reset: ${out.cleared ?? 0} skipped pass(es) will run again on the next probe.`
      : "Could not reset the skipped passes.";
    return out;
  }, () => {
    ui.status.textContent = "Could not reset the skipped passes.";
    return null;
  });
}

const VOICE_SOAK_START_LABEL = "Start the 30-minute soak (then lock the phone)";
const VOICE_SOAK_STOP_LABEL = "Stop the soak now (keeps what it measured)";

/** The soak control's state: "Start" when idle, disabled while the matrix
    runs, and "Stop" (enabled) while a soak runs. */
function paintVoiceSoakControl(btn) {
  if (!btn) return;
  const soaking = Boolean(voiceProbeRunning) && voiceProbeRunningSoak;
  btn.disabled = Boolean(voiceProbeRunning) && !soaking;
  setControlLabel(btn, soaking ? VOICE_SOAK_STOP_LABEL : VOICE_SOAK_START_LABEL);
}

/** End a running soak early. The soak's own promise then resolves with the
    loops it finished and paints its report as usual. */
function stopVoiceSoak() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  if (!player || typeof player.stopVoiceSoak !== "function") {
    ui.status.textContent = "This build cannot stop the soak early. It ends on its own after 30 minutes.";
    return Promise.resolve(null);
  }
  ui.status.textContent = "Stopping the soak — the record will show the loops it finished.";
  const btn = $("#voice-probe-soak");
  if (btn) btn.disabled = true;
  return Promise.resolve(player.stopVoiceSoak()).then((out) => {
    if (!out || !out.ok) ui.status.textContent = `Could not stop the soak (${(out && out.reason) || "unknown"}). It ends on its own after 30 minutes.`;
    return out;
  }, () => null);
}

/** Whether this shell can soak: the iOS app (Android's plugin has no soak
    mode, and a browser has no probe at all). */
function voiceSoakOffered() {
  try {
    const cap = window.Capacitor;
    return Boolean(cap && typeof cap.getPlatform === "function" && cap.getPlatform() === "ios");
  } catch (_) {
    return false;
  }
}

/* ---------- the engine's Developer rows (NE-22d) ----------

   The four rows the M1 car test drives (docs/native-engine-m1-car-test.md,
   "Before it can be run" item 2), in the Developer group above "Playback
   diagnostics":

     Playback engine: Automatic / Native / Web (applies after restart)  NE-17
     Pause hold: forever / none                                          NE-16
     Simulate system termination                                         NE-24
     Session probe                                                       NE-25c

   THE PLAYER DECIDES WHICH EXIST AND SENDS THEIR COMMANDS. app.js is a classic
   script with no engine client of its own, so every row reads
   `ForayPlayer.engineDeveloperStatus()` (null: no rows at all, which is the
   web, Android and a shell with no engine) and sends through
   `ForayPlayer.engineDeveloperSend()` (player/client.js, over the NE-21 engine
   client's engineSend). Nothing here reaches the bridge directly, so a page
   with no engine cannot send one of these by any path.

   APPENDED AND REMOVED, NEVER `hidden` (the reason `syncVoiceProbeRun` gives).
   Painted by `renderDrawer` like every other drawer label, from the ENGINE's
   answer: the pause hold is its snapshot, the engine setting is what it
   confirmed storing, and a one-shot row says what the engine replied to the
   last tap ("armed", or why it refused). A row with a send in flight is
   disabled, so a double tap is one command. */
const ENGINE_OVERRIDE_ORDER = ["auto", "native", "web"];
const ENGINE_OVERRIDE_WORDS = { auto: "Automatic", native: "Native", web: "Web" };

/** Why the engine refused, in words (engine-contract.js REFUSALS, plus the
    page-side `bridge-error`). An unlisted reason is shown as sent. */
const ENGINE_REFUSAL_WORDS = {
  "not-loaded": "play and pause an episode first",
  "engine-busy": "pause playback first",
  "capability-off": "not available on this build",
  relinquished: "the web player has playback until the app restarts",
  "unknown-cmd": "this build does not know that command",
  "bridge-error": "the app did not answer",
};

/** The last reply to each one-shot row, this page load. */
const engineDevOutcome = {};
const engineDevInFlight = new Set();

function engineDevStatus() {
  const p = window.ForayPlayer;
  if (!p || typeof p.engineDeveloperStatus !== "function" || typeof p.engineDeveloperSend !== "function") return null;
  try { return p.engineDeveloperStatus() || null; } catch (_) { return null; }
}

function engineRefusalWords(reply) {
  const reason = reply && reply.reason ? String(reply.reason) : "bridge-error";
  return ENGINE_REFUSAL_WORDS[reason] || reason;
}

/** The word after "Pause hold:" for a snapshot holdPolicy ("forever" | "none"
    | "until:<minutes>"), or "not known" before the engine has said. */
function holdPolicyWord(policy) {
  if (policy === "forever" || policy === "none") return policy;
  const m = /^until:(\d+)$/.exec(policy || "");
  return m ? `${m[1]} min` : "not known";
}

/** The word after "Route sharing:" for the policy the engine confirmed
    storing ("default" | "longFormAudio"), or "not known" before a tap. */
function routeSharingWord(policy) {
  if (policy === "longFormAudio") return "Long-form";
  if (policy === "default") return "Default";
  return "not known";
}

const ENGINE_DEV_ROWS = [
  {
    id: "engine-mode-override", cmd: "setModeOverride",
    paint(btn, st) {
      const word = ENGINE_OVERRIDE_WORDS[st.override] || "not known";
      const now = st.lane === "native" ? "Native" : "Web";
      setControlLabel(btn, `Playback engine: ${word} (applies after restart) · now ${now}`,
        `Playback engine: ${word}, applies after restart. Running now: ${now}`);
    },
    next(st) {
      const i = ENGINE_OVERRIDE_ORDER.indexOf(st.override);
      return { mode: ENGINE_OVERRIDE_ORDER[(i + 1) % ENGINE_OVERRIDE_ORDER.length] };
    },
  },
  {
    id: "engine-hold-policy", cmd: "setHoldPolicy", role: "switch",
    paint(btn, st) {
      setControlLabel(btn, `Pause hold: ${holdPolicyWord(st.holdPolicy)}`, "Pause hold forever");
      btn.setAttribute("aria-checked", String(st.holdPolicy === "forever"));
    },
    next(st) { return { policy: st.holdPolicy === "forever" ? "none" : "forever" }; },
  },
  {
    /* NE-40 (DV-8): the M3 drive's optional `.longFormAudio` arm. Stored by
       the engine and applied at the NEXT launch, like the engine setting; the
       Copy header's `routeSharing=` says which policy a launch ran. */
    id: "engine-route-sharing", cmd: "setRouteSharing",
    paint(btn, st) {
      const word = routeSharingWord(st.routeSharing);
      setControlLabel(btn, `Route sharing: ${word} (applies after restart)`,
        `Route sharing: ${word}, applies after restart`);
    },
    next(st) { return { policy: st.routeSharing === "longFormAudio" ? "default" : "longFormAudio" }; },
  },
  {
    id: "engine-simulate-termination", cmd: "simulateTermination", oneShot: true,
    title: "Simulate system termination",
    armed: "armed. Lock the phone: the app saves its place and closes",
  },
  {
    id: "engine-session-probe", cmd: "probeSession", oneShot: true,
    title: "Session probe",
    armed: "armed. Lock the phone now; it speaks in 10 seconds",
  },
];

function paintEngineDevRow(row, btn, st) {
  btn.disabled = engineDevInFlight.has(row.id);
  if (!row.oneShot) { row.paint(btn, st); return; }
  const out = engineDevOutcome[row.id];
  const text = !out ? row.title
    : out.ok ? `${row.title}: ${row.armed}`
      : `${row.title}: refused, ${engineRefusalWords(out)}`;
  setControlLabel(btn, text, text);
}

async function tapEngineDevRow(row) {
  if (engineDevInFlight.has(row.id)) return null;
  const st = engineDevStatus();
  if (!st || !Array.isArray(st.commands) || !st.commands.includes(row.cmd)) { renderDrawer(); return null; }
  const args = row.next ? row.next(st) : undefined;
  engineDevInFlight.add(row.id);
  renderDrawer();
  let reply = null;
  try {
    reply = await window.ForayPlayer.engineDeveloperSend(row.cmd, args);
  } catch (_) {
    reply = null;
  } finally {
    engineDevInFlight.delete(row.id);
  }
  const answer = reply || { ok: false, reason: "bridge-error" };
  if (row.oneShot) engineDevOutcome[row.id] = { ok: !!answer.ok, reason: answer.reason };
  renderDrawer();
  /* The one-shot rows change their words in place, which a screen reader
     does not re-read on a focused button; the switch and the setting are
     said by their own state. */
  if (row.oneShot) {
    const btn = $("#" + row.id);
    if (btn) announce(btn.textContent);
  }
  return answer;
}

/** Create, paint or remove the engine rows. Called from `renderDrawer`, and
    once the player module has said which lane plays. */
function syncEngineDevRows() {
  const drawer = $("#drawer");
  if (!drawer) return;
  const st = engineDevStatus();
  const cmds = st && Array.isArray(st.commands) ? st.commands : [];
  const want = ENGINE_DEV_ROWS.filter((row) => cmds.includes(row.cmd));
  for (const row of ENGINE_DEV_ROWS) {
    if (want.includes(row)) continue;
    const gone = $("#" + row.id);
    if (gone) gone.remove();
  }
  if (!want.length) return;
  const group = drawerDevGroup() || drawer;
  const diag = $("#diag-open");
  const before = diag && diag.parentNode === group ? diag : null;
  for (const row of want) {
    let btn = $("#" + row.id);
    if (!btn) {
      btn = ddEl("button", "drawer-item as-btn drawer-wrap", "");
      btn.type = "button";
      btn.id = row.id;
      /* A setting changes IN the drawer (the switches' rule, Joey 2026-08-31). */
      btn.dataset.drawerStay = "1";
      if (row.role) btn.setAttribute("role", row.role);
      if (before) group.insertBefore(btn, before);
      else group.appendChild(btn);
      btn.addEventListener("click", () => tapEngineDevRow(row));
    }
    paintEngineDevRow(row, btn, st);
  }
}

/** The rows appear only once the lane is known: engineHello answers up to 5 s
    after launch, so a drawer painted before then has no engine to ask. */
function bindEngineDevRows() {
  const whenLane = () => {
    const p = window.ForayPlayer;
    const ready = p && typeof p.whenEngineReady === "function" ? p.whenEngineReady() : null;
    Promise.resolve(ready).then(syncEngineDevRows, syncEngineDevRows);
  };
  if (window.ForayPlayer) whenLane();
  else window.addEventListener("forayplayer:ready", whenLane, { once: true });
}

/** Run the probe and show its numbers where the founder can copy them: the
    Playback-diagnostics sheet, which is already the one copyable surface on
    the phone (HUMAN-ACTIONS.md #21). The record is written into `cp_diag` by
    `ForayPlayer.runVoiceProbe()` itself, so the sheet's own refresh picks it
    up — this function opens the sheet and paints the human-readable summary
    into its status line so the answer is legible before anyone scrolls.

    GUARDED THE SAME WAY EVERY FORAY TAP IS (#225): a rejected promise here
    must not become a console line nobody has open. */
/* ONE PROBE AT A TIME (audit round 3, app-3-11). Nothing guarded a second
   tap: a founder who reopened the drawer and pressed RUN again (nothing else
   shows a run is under way for its ~90 s, and reopening the sheet clears its
   status line) started a second engine load beside the first, both writing
   the one status line in whatever order they finished. While a run is in
   flight the control is disabled, and a second call reopens the sheet, says
   it is running, and hands back the same promise. */
let voiceProbeRunning = null;
/* KV-R3: an iPhone runs SIX passes (the Core ML chain three ways, fp32 ORT
   at 2/3/4 threads), each at speed 1.0 and 1.5; the Core ML passes compile
   first. The founder runs it twice — unlocked, then locked right after the
   tap — and the record says which run was which. */
const VOICE_PROBE_RUNNING_LINE = "Running the voice probe — six passes at two speeds on iPhone, about five to ten minutes. "
  + "For the locked run, lock the phone now; otherwise leave the app open. "
  + "If 4a closes, just reopen it and tap the probe again; each run skips what crashed.";
/* The soak: one pass, speed 1.5, in a loop for 30 minutes. */
const VOICE_SOAK_RUNNING_LINE = "Running the 30-minute soak. Lock the phone now and leave it locked for 30 minutes. "
  + "To end it early, unlock and tap \"Stop the soak now\".";
/** ONE probe or soak at a time (app-3-11): both controls are disabled while
    either runs, and a second tap reopens the sheet and hands back the run
    already under way. */
let voiceProbeRunningSoak = false;
function runVoiceProbe(mode = "matrix") {
  if (voiceProbeRunning) {
    const ui = diagSheet();
    openDiagSheet();
    ui.status.textContent = voiceProbeRunningSoak ? VOICE_SOAK_RUNNING_LINE : VOICE_PROBE_RUNNING_LINE;
    return voiceProbeRunning;
  }
  const soak = mode === "soak";
  const run = soak ? runVoiceSoakOnce() : runVoiceProbeOnce();
  voiceProbeRunning = run;
  voiceProbeRunningSoak = soak;
  const runBtn = $("#voice-probe-run");
  if (runBtn) runBtn.disabled = true;
  paintVoiceSoakControl($("#voice-probe-soak"));
  const done = () => {
    if (voiceProbeRunning !== run) return;
    voiceProbeRunning = null;
    voiceProbeRunningSoak = false;
    const b = $("#voice-probe-run");
    if (b) b.disabled = false;
    paintVoiceSoakControl($("#voice-probe-soak"));
  };
  run.then(done, done);
  return run;
}

/** KV-R3: the soak, reported the way the matrix is — into the record by the
    player, and its readable summary into the sheet's status line. */
async function runVoiceSoakOnce() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  ui.status.classList.remove("dd-status-report");
  ui.status.textContent = VOICE_SOAK_RUNNING_LINE;
  if (!player || typeof player.runVoiceSoak !== "function") {
    ui.status.textContent = "This build has no soak. Update the app and try again.";
    return null;
  }
  try {
    const result = await player.runVoiceSoak();
    const record = Array.isArray(result) ? result[0] : result;
    refreshDiagSheet();
    ui.status.classList.add("dd-status-report");
    ui.status.textContent = typeof player.formatVoiceSoak === "function" && record
      ? `${player.formatVoiceSoak(record)}\nCopy the record above and paste it into the card.`
      : "The soak finished. Copy the record above.";
    return result;
  } catch (_) {
    ui.status.textContent = "The soak failed to run. Copy the record above and say what build this is.";
    return null;
  }
}

/** KV-R3: one "Play" button per pass whose speed-1.5 WAV the run kept, under
    the sheet's status line — the founder's ear on each engine at 1.5x (§5
    item 10). The phone plays it natively; nothing here holds a path.
    Replaced on every run, never stacked. */
function paintVoiceProbeListen(ui, player, records) {
  const old = $("#voice-probe-listen");
  if (old) old.remove();
  if (!player || typeof player.voiceProbeWavPasses !== "function" || typeof player.playVoiceProbeWav !== "function") return;
  const passes = player.voiceProbeWavPasses(records);
  if (!passes.length || !ui.status || !ui.status.parentNode) return;
  const box = ddEl("div", "diag-listen");
  box.id = "voice-probe-listen";
  for (const pass of passes) {
    const label = `Play ${pass} at 1.5x`;
    const btn = ddEl("button", "drawer-item as-btn", label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      Promise.resolve(player.playVoiceProbeWav(pass)).then((out) => {
        setControlLabel(btn, out && out.ok ? label : `${label} (could not play: ${(out && out.reason) || "unknown"})`);
      }, () => {});
    });
    box.appendChild(btn);
  }
  ui.status.parentNode.insertBefore(box, ui.status.nextSibling);
}

async function runVoiceProbeOnce() {
  const player = window.ForayPlayer;
  const ui = diagSheet();
  openDiagSheet();
  ui.status.classList.remove("dd-status-report");
  ui.status.textContent = VOICE_PROBE_RUNNING_LINE;
  if (!player || typeof player.runVoiceProbe !== "function") {
    ui.status.textContent = "The player hasn't loaded, so the probe can't run.";
    return null;
  }
  try {
    /* ONE RECORD PER PASS since KV-R2 (`cpu`, then `coreml` on iPhone); an
       older player answers one record, which is a list of one. */
    const result = await player.runVoiceProbe({ armCoreML: voiceProbeArmCoreML });
    const records = Array.isArray(result) ? result : (result ? [result] : []);
    refreshDiagSheet();
    /* KV-R3: a v3 run (records carry a speed) is one compact TABLE with a
       1.5x verdict per pass and §4's decision rule, not twelve blocks of
       K-01's go/no-go (whose 0.8 ceiling is not this card's question). */
    const table = typeof player.formatVoiceProbeTable === "function" ? player.formatVoiceProbeTable(records) : "";
    if (table && records.some((r) => r && r.speed != null)) {
      ui.status.classList.add("dd-status-report");   // a table: kept lines, fixed-width columns
      /* PROBE v3.1: say, in words, why Core ML did not run or was skipped. */
      const why = records.some((r) => r && r.reason === "coreml-bnns-os")
        ? "\nCore ML did not run: iOS 26.4 and later crash it (an Apple bug). Tap \"Arm Core ML (may crash)\" first to try it anyway."
        : "";
      const skipped = records.some((r) => r && r.reason === "skipped-killed-last-run")
        ? "\nSome passes were skipped because they closed 4a last time. \"Reset skipped passes\" runs them again."
        : "";
      ui.status.textContent = `${table}${why}${skipped}\nCopy the record above and paste it into the card.`;
      paintVoiceProbeListen(ui, player, records);
      return result;
    }
    const format = (record) => (typeof player.formatVoiceProbe === "function"
      ? player.formatVoiceProbe(record)
      : { text: "", verdict: { go: false, failures: ["no verdict available"] } });
    /* A pass that measured shows its numbers and its verdict; a pass that
       could not says why, beside the one that could. Only when NO pass
       measured does the line collapse to the reason. */
    ui.status.textContent = records.some((r) => r && r.ok)
      ? records.map((r) => {
        const out = format(r);
        return r && r.ok
          ? `${out.text}\n  go/no-go: ${out.verdict.go ? "GO" : `NO — ${out.verdict.failures.join("; ")}`}`
          : out.text;
      }).join("\n\n")
      : `The probe could not measure anything: ${records.map((r) => (r && r.reason) || "unknown").join(", ") || "unknown"}. `
        + `The record above says the same thing — copy it.`;
    return result;
  } catch (_) {
    ui.status.textContent = "The probe failed to run. Copy the record above and say what build this is.";
    return null;
  }
}

/* The Interests page (#/interests, U-07) is reachable from Settings, but
   index.html's drawer markup is not among this card's owned files and is
   unlisted/human-merge-gated (CLAUDE.md path-policy) — editing it would pull
   this whole change off the auto-merge path for one nav link. Injected once
   into the drawer instead, immediately after `.drawer-section-label`
   ("Settings" — the drawer's only section label today, per index.html), the
   same place a founder editing index.html by hand would put it. If the
   drawer ever grows a second `.drawer-section-label`, this must switch to a
   text-matched lookup rather than "the first one found". Guarded by a flag
   on the drawer element so repeated renderDrawer() calls (every
   `openDrawer(true)`) don't stack duplicate links. */
function ensureInterestsDrawerLink() {
  const drawer = $("#drawer");
  if (!drawer || drawer._interestsLinkAdded) return;
  drawer._interestsLinkAdded = true;
  const label = document.querySelector(".drawer-section-label");
  const link = document.createElement("a");
  link.className = "drawer-item";
  link.href = "#/interests";
  link.textContent = "Interests";
  if (label && label.parentNode) {
    label.parentNode.insertBefore(link, label.nextSibling);
  } else {
    drawer.appendChild(link);
  }
}
