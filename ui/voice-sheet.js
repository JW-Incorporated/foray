/* ui/voice-sheet.js — Voice picker sheet.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- V-01: the narration voice picker ----------

   `docs/ios-controls-and-voice-plan.md` V-01. A drawer item — "Narration
   voice" — built and bound the same way `bindDiagnosticsControl()`/
   `bindDeleteControl()` are: appended in JS above "Delete my data", because
   `index.html`'s drawer markup is outside this card's owned files (same
   constraint `ensureInterestsDrawerLink` states). The card asked for it
   "next to Playback diagnostics"; since the 2026-09-22 audit (R8) that item
   lives in the collapsed Developer group, and this one is a listener setting,
   so it sits directly ABOVE that group, still next to it and still above
   "Delete my data".

   DESIGN COMMENT (posted to the card before this was written): there is no
   separate `#/settings` route on `main` post-U-11 — `cp_ui_v2` is retired
   and "Settings" is the drawer's own section label (`index.html`'s
   `.drawer-section-label`). So this ships with exactly one home, the drawer,
   and there is no "before/after U-02" move pending.

   THE THREE ROW KINDS, and why they look different on purpose:
     - INSTALLED, SELECTABLE — a radio-shaped row with an Audition button.
     - ON THE LIST BUT MISSING — greyed, no Audition (there is nothing to
       audition), with the exact Settings path text — no Open Settings
       button (see `buildVoiceRow`'s own comment: `@capacitor/app` has no
       such native method, and a button promising an action the shell
       cannot perform is worse than no button). iOS constraint stated in the
       copy itself: a third-party app can only open its OWN Settings page
       (`UIApplication.openSettingsURLString`), never deep-link to Voices —
       so the text alone gets a listener there, one screen at a time.
     - WEB SPEECH (`path: "web-speech"`, quality `"unknown"`) — installed
       rows only, no greyed section and no Open Settings button, because
       `speechSynthesis.getVoices()` exposes no install state at all.

   A CURATED LIST, NOT "EVERYTHING INSTALLED" (founder decision 2026-09-10,
   after the first real listen: "those voices were all so bad. Samantha was
   the least worst"). The first cut rendered every voice `listVoices()`
   returned, and on iOS 17+ that is dominated by Apple's novelty catalogue —
   Albert, Bad News, Bahh, Bells, Boing, Bubbles, Cellos, Wobble, Zarvox …
   — and the Eloquence set (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
   Shelley), all reported at the same `default` tier as Samantha compact.
   `ForayTtsPlugin.swift`'s `installedVoices()` does not filter
   `voiceTraits.isNoveltyVoice`, and this page cannot ask it to (the plugin is
   outside this card's owned files), so the page renders ONLY the names in
   `VOICE_ALLOWLIST`, in that fixed order, and hides every other installed
   voice. Same name at several tiers (compact + enhanced + premium): the best
   one only, labelled with its tier. */

/** The voices the picker shows, in this order. Samantha is the only survivor
    of the first cut's five (Ava, Evan, Nathan, Zoe are gone by founder
    decision); the rest are a TRIAL SET for the founder to download and
    compare — a greyed row is how a voice is tried: download it in Settings,
    return, the list refreshes on `visibilitychange`.

    NAMES AND HOW EACH WAS VERIFIED (2026-09-10). Apple publishes no list of
    Spoken Content voice names; nothing here has been read off a device by
    anyone in this repo (`mobile/plugins/foray-tts/README.md`'s own honesty
    note). "verified" = the name appears, with that locale and tier, in a
    `speechVoices()` dump from a real device (gist.github.com/Koze/d1de49c2…,
    iOS 13) AND/OR in two independent third-party listings of the
    Settings → Voices screen (help.scriptation.com "better playback voices",
    thefreereader.app "expressive Apple voices"). A row whose name could not
    be confirmed is marked `unverified: true` HERE, not in its description
    (audit round 2, copy-12: "unverified name" on a row is a note about this
    allowlist, not about the voice, and a listener cannot act on it); if it
    never shows up as installed after a download, the name is wrong, not the
    download. Descriptions are accent · gender ONLY: the tier comes from the
    plugin's own `quality` field (voiceQualityLabel), so a row does not say
    "Enhanced" twice, and which voices ship compact-by-default on iOS 18 is
    NOT verified here, so no row claims it. */
const VOICE_ALLOWLIST = Object.freeze([
  { name: "Samantha", about: "American · female" },
  { name: "Allison", about: "American · female" },
  { name: "Susan", about: "American · female" },
  { name: "Joelle", about: "American · female" },
  { name: "Tom", about: "American · male" },
  { name: "Nicky", about: "American · female", unverified: true },
  { name: "Aaron", about: "American · male", unverified: true },
  { name: "Daniel", about: "British · male" },
  { name: "Serena", about: "British · female" },
  { name: "Karen", about: "Australian · female" },
  { name: "Moira", about: "Irish · female" },
  { name: "Tessa", about: "South African · female" },
  { name: "Rishi", about: "Indian · male" },
]);

/** The `lang` this page asks `listVoices()` for. A bare primary subtag on
    purpose: both native halves match the exact locale FIRST AND ALONE
    (`ForayTtsPlugin.swift` `candidates(_:language:)`, `ForayTtsPlugin.java`
    `candidates`), so `"en-US"` could never return Daniel (en-GB), Karen
    (en-AU), Moira, Tessa or Rishi while any en-US voice was installed — and
    Samantha compact always is. `"en"` matches no exact locale, so both
    halves widen to every `en-*` voice; the web shim's `languageMatches`
    does the same by construction. Mirrors `player/default-voice.js`'s
    `VOICE_LIST_LANG` (a classic script cannot import it). */
const VOICE_LIST_LANG = "en";

/** Quality rank for comparing the SAME NAME at several tiers — mirrors
    `player/default-voice.js`'s `qualityRank` (same constraint: no import
    from a classic script). Never used to relabel: the label shown is always
    the plugin's own `quality` string. */
function voiceQualityRank(quality) {
  switch (String(quality || "").toLowerCase()) {
    case "premium": case "very-high": return 5;
    case "enhanced": case "high": return 4;
    case "default": case "normal": return 3;
    case "low": return 1;
    case "very-low": return 0;
    default: return 2;
  }
}

/** Is a `listVoices()` entry English at all? `en-*`, or Android's `eng-*`. */
function voiceIsEnglish(v) {
  const p = String((v && v.language) || "").toLowerCase().split(/[-_]/)[0];
  return p === "en" || p === "eng";
}

/** The allowlist joined against what the device reports: one entry per
    allowlisted name, in allowlist order, carrying the BEST installed voice of
    that name (or `null` when none is). Everything else `listVoices()`
    returned — novelty, Eloquence, Siri, other-name Enhanced downloads — is
    dropped here and never reaches a row. Pure, so the suite can pin it. */
function curateVoices(voices) {
  const list = Array.isArray(voices) ? voices : [];
  return VOICE_ALLOWLIST.map((entry) => {
    const wanted = entry.name.toLowerCase();
    let best = null;
    for (const v of list) {
      if (!v || typeof v.identifier !== "string" || !v.identifier) continue;
      if (String(v.name || "").toLowerCase() !== wanted) continue;
      if (!voiceIsEnglish(v)) continue;
      if (!best || voiceQualityRank(v.quality) > voiceQualityRank(best.quality)) best = v;
    }
    return { name: entry.name, about: entry.about, installed: best };
  });
}

/** The exact path text V-01 specifies, verbatim — a listener reads this
    because the button can only open the app's own Settings page, never
    deep-link to Voices (`UIApplication.openSettingsURLString`'s own limit). */
const VOICE_SETTINGS_PATH = "Settings \u2192 Accessibility \u2192 Spoken Content \u2192 Voices \u2192 English";

/** The fixed audition line: a count to ten, nothing else. It was a count to
    twenty with two spoken "Marker" phrases (H3's stopwatch line); the founder
    cut it on 2026-09-10 ("reduce the script to just counting to ten, it was
    so bad listening to them for so long"). H3's stopwatch reading still
    works against this line, start to the final "ten"; the predicted seconds
    halve, and HUMAN-ACTIONS.md H3 carries the dated note. DELIBERATELY NOT
    LABELLED WITH A CLAIMED SECOND COUNT, for the same reason as before: the
    word count is not tuned to any seconds-per-word rate, so a spoken "ten
    seconds" would be a claim this text cannot back up in whatever voice the
    listener picks. (It is spoken at 1x, never the listener's playback speed,
    since the founder's 2026-09-24 ruling — see `auditionVoiceRow`.) */
const AUDITION_LINE = "one, two, three, four, five, six, seven, eight, nine, ten.";

let voiceUi = null;
let voiceState = { voices: [], path: "none", loading: false, selected: null, auditioning: null, notice: "" };
const VOICE_SHEET_SUB = "Pick which voice reads 4a's narration. Tap Preview to hear it count to ten, at the speed narration uses.";

/** Quality label from `listVoices()`'s own `quality` field — never re-derived,
    per the card ("quality label from `qualityRank`"): the plugin already
    knows its own tiers and this page must not invent a second opinion about
    what "premium" means on a platform it cannot introspect. `"unknown"`
    (Web Speech) reads as a bare noun rather than a fabricated tier word. */
function voiceQualityLabel(v) {
  if (!v || !v.quality || v.quality === "unknown") return "voice";
  return v.quality;
}

function buildVoiceSheet() {
  const root = ddEl("div", "fy-sheet");
  root.id = "voice-sheet";
  root.hidden = true;

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel voice-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = ddEl("h3", null, "Narration voice");
  title.id = "voice-title";
  panel.setAttribute("aria-labelledby", "voice-title");

  /* "at the speed narration uses", not "at your playback speed" (audit round
     3, app-3-8): a Preview has spoken at NARRATION_RATE (1x) since the
     2026-09-24 ruling, whatever the listener's speed. listener-copy pins this
     sentence against auditionVoice's rate. */
  const sub = ddEl("p", "fy-sheet-sub", VOICE_SHEET_SUB);
  /* ONLY WHEN THERE ARE DIMMED VOICES (review 2026-09-23). This sentence was
     part of the fixed subtitle, and the sheet also opens on the Web Speech path
     in a desktop browser, which never shows a dimmed row — so a desktop listener
     read about greyed voices that do not exist and a phone they are not using.
     `paintVoiceList` shows it exactly when it renders a missing (native) row. */
  const missingNote = ddEl("p", "fy-sheet-sub voice-missing-note",
    "Dimmed voices are free to download from your phone's Settings, and appear here when you come back.");
  missingNote.hidden = true;

  /* A RADIO GROUP, OWNED (audit 2026-09-22, qa row 81). The rows were
     `role="radio"` with no radiogroup around them, so a screen reader gave no
     group name and no "2 of 5", and arrow keys did nothing. */
  const list = ddEl("div", "voice-list");
  list.id = "voice-list";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-labelledby", "voice-title");

  const notice = ddEl("p", "dd-status voice-notice");
  notice.id = "voice-notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.hidden = true;

  const actions = ddEl("div", "fy-sheet-actions");
  const close = ddEl("button", "fy-sheet-cancel", "Close");
  close.type = "button";
  actions.append(close);

  panel.append(ddEl("div", "fy-grab"), title, sub, missingNote, list, notice, actions);
  root.append(scrim, panel);
  document.body.appendChild(root);
  return { root, scrim, panel, list, notice, close, missingNote };
}

function voiceSheet() {
  if (!voiceUi) voiceUi = buildVoiceSheet();
  return voiceUi;
}

/** One row: an installed voice (selectable, with Audition) or a recommended
    name that is not installed (greyed, with the Settings path and an Open
    Settings button). Built with createElement/textContent like every other
    sheet in this file — the CSP is strict and index.html is out of reach. */
function buildVoiceRow({ installed, name, sub, id, selected, tabStop }) {
  const row = ddEl("div", `voice-row${installed ? "" : " voice-row-missing"}${selected ? " voice-row-selected" : ""}`);
  if (id) row.dataset.voiceId = id;

  const text = ddEl("div", "voice-row-text");
  text.append(ddEl("div", "voice-row-name", name), ddEl("div", "voice-row-sub", sub));

  if (installed) {
    /* THE RADIO IS THE NAME, NOT THE ROW. The row used to be the radio and
       held the Preview button inside it — a control nested in a control, so
       the radio announced as "Samantha, …, Audition, radio button" and Preview
       was a second tab stop inside the first. Now the radio and Preview are
       siblings in a plain row, and only ONE radio in the group is a tab stop
       (the chosen one, or the first): arrows move between them, as a native
       radio group's do. */
    const choice = ddEl("div", "voice-row-choice");
    choice.setAttribute("role", "radio");
    choice.setAttribute("aria-checked", selected ? "true" : "false");
    choice.dataset.voiceId = id;
    /* The display name, for the arrow keys: `moveVoiceChoice` selects a
       NEIGHBOUR and must announce it by name like a click does. */
    choice.dataset.voiceName = name;
    choice.tabIndex = tabStop ? 0 : -1;
    choice.append(text);
    choice.addEventListener("click", () => selectVoiceRow(id, name));
    choice.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectVoiceRow(id, name); return; }
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (step) { e.preventDefault(); moveVoiceChoice(id, step); }
    });
    row.append(choice);

    const btn = ddEl("button", "voice-row-audition", voiceState.auditioning === id ? "Playing\u2026" : "Preview");
    btn.type = "button";
    btn.disabled = voiceState.auditioning === id;
    /* Named with the voice: five identical "Preview" buttons tell a screen
       reader nothing about which voice each one speaks in. */
    btn.setAttribute("aria-label", `Preview ${name}`);
    btn.addEventListener("click", (e) => { e.stopPropagation(); return auditionVoiceRow(id); });
    row.append(btn);
  } else {
    row.append(text);
    /* NO OPEN SETTINGS BUTTON HERE, deliberately — confirmed by reading
       `@capacitor/app@8.1.1`'s own `AppPlugin` interface
       (`mobile/node_modules/@capacitor/app/dist/esm/definitions.d.ts`):
       `exitApp`, `getInfo`, `getState`, `getLaunchUrl`, `minimizeApp`,
       `getAppLanguage`, `toggleBackButtonHandler`, `addListener`,
       `removeAllListeners` — nothing that opens Settings. A button whose
       label promises an action the shipped shell cannot perform is worse
       than no button: the path text below is the ONLY thing this row can
       honestly offer a listener today. Wiring a real native "open Settings"
       call needs a small addition to a Capacitor plugin
       (`mobile/plugins/foray-audio` or a new one) — out of this card's
       owned files (`app.js`/`player/`/`test/` only) — and is a follow-up
       card's job, not a silently-swallowed `.catch()` in this one. */
  }
  return row;
}

function paintVoiceNotice(text) {
  const ui = voiceSheet();
  ui.notice.textContent = text || "";
  ui.notice.hidden = !text;
}

/** Which identifier the sheet paints as chosen: the stored/session choice
    from `currentVoice()`, else (when nothing is stored) the same default
    rule narration uses (`player/default-voice.js`, re-exported as
    `ForayPlayer.defaultVoice`), applied to THIS list. One rule, two readers;
    a page-side copy of "Samantha's best tier" would be the second opinion
    `voiceQualityLabel`'s comment already refuses to hold about tiers. */
function selectedVoiceId(player) {
  if (!player) return null;
  const chosen = typeof player.currentVoice === "function" ? player.currentVoice() : null;
  if (chosen) return chosen;
  return typeof player.defaultVoice === "function" ? player.defaultVoice(voiceState.voices) : null;
}

function paintVoiceList() {
  const ui = voiceSheet();
  const player = window.ForayPlayer;
  const selected = selectedVoiceId(player);
  voiceState.selected = selected;

  const rows = [];
  let anyMissing = false;
  const curated = curateVoices(voiceState.voices);
  /* The group's one tab stop: the chosen voice, or the first when none is. */
  const stopId = curated.some((e) => e.installed && e.installed.identifier === selected)
    ? selected
    : (curated.find((e) => e.installed)?.installed.identifier ?? null);
  for (const entry of curated) {
    const v = entry.installed;
    if (v) {
      rows.push(buildVoiceRow({
        installed: true,
        name: entry.name,
        /* No "unknown language" piece: a fact the plugin did not report is
           left out, not printed as a shrug (audit round 2, copy-12). */
        sub: [entry.about, voiceQualityLabel(v), v.language].filter(Boolean).join(" \u00b7 "),
        id: v.identifier,
        selected: v.identifier === selected,
        tabStop: v.identifier === stopId,
      }));
      continue;
    }
    /* Web Speech (`path: "web-speech"`) has no install state at all: no
       greyed section, no Open Settings button, per the design comment. Only
       a native path (`"native"`) can honestly say "not downloaded". */
    if (voiceState.path !== "native") continue;
    anyMissing = true;
    rows.push(buildVoiceRow({
      installed: false,
      name: entry.name,
      sub: `${entry.about} \u00b7 Not downloaded \u2014 ${VOICE_SETTINGS_PATH}`,
    }));
  }

  /* THE REBUILD MUST NOT THROW THE LISTENER OUT OF THE SHEET (audit
     2026-09-22). Every select and every Audition repaints this list, which
     destroyed the row or button that had just been activated — focus fell to
     <body>, behind the scrim, and a keyboard or screen-reader user had to find
     their way back into the dialog from the top of the document after every
     single action. Remember what had focus, by voice, and put it back on the
     same voice's row (or its Audition button, unless that is now disabled
     while it plays). */
  const had = document.activeElement;
  const hadRow = had && typeof ui.list.contains === "function" && ui.list.contains(had)
    && typeof had.closest === "function" ? had.closest("[data-voice-id]") : null;
  const focusVoice = hadRow ? hadRow.dataset.voiceId : null;
  /* An Audition press rebuilds the button DISABLED while it plays, so focus
     waits on the row; `returnToAudition` remembers to take it back to the
     button on the repaint that re-enables it. */
  const focusAudition = !!(had && had.classList && had.classList.contains("voice-row-audition"))
    || (focusVoice != null && voiceState.returnToAudition === focusVoice);
  voiceState.returnToAudition = null;

  if (ui.missingNote) ui.missingNote.hidden = !anyMissing || voiceState.loading;
  ui.list.innerHTML = "";
  if (voiceState.loading) {
    ui.list.append(ddEl("p", "voice-loading", "Looking for voices\u2026"));
  } else if (!rows.length) {
    ui.list.append(ddEl("p", "voice-loading",
      voiceState.voices.length
        ? "None of the voices 4a suggests are installed on this device."
        : "No voices reported by this device."));
  } else {
    rows.forEach((r) => ui.list.append(r));
  }
  if (focusVoice) {
    const row = rows.find((r) => r.dataset.voiceId === focusVoice);
    const btn = row && focusAudition ? row.querySelector(".voice-row-audition") : null;
    if (btn && btn.disabled) voiceState.returnToAudition = focusVoice;
    /* The row is a plain container since L4; the radio inside it is what takes focus. */
    const choice = row && typeof row.querySelector === "function" ? row.querySelector(".voice-row-choice") : null;
    focusQuietly(btn && !btn.disabled ? btn : (choice || row));
  }
}

/* THE NEWEST ASK WINS (audit round 3, app-3-10). openVoiceSheet and the
   return-to-app refresh can overlap, and whichever listVoices() answered LAST
   won -- the older one included, so a voice just downloaded in Settings could
   vanish from the list again. Only the latest call writes. */
let voiceRefreshSeq = 0;
async function refreshVoiceList() {
  const player = window.ForayPlayer;
  if (!player || typeof player.listVoices !== "function") return;
  const seq = ++voiceRefreshSeq;
  voiceState.loading = true;
  paintVoiceList();
  try {
    const out = await player.listVoices({ lang: VOICE_LIST_LANG });
    if (seq !== voiceRefreshSeq) return;
    voiceState.voices = (out && out.voices) || [];
    voiceState.path = (out && out.path) || "none";
  } catch (_) {
    if (seq !== voiceRefreshSeq) return;
    voiceState.voices = [];
    voiceState.path = "none";
  } finally {
    if (seq === voiceRefreshSeq) {
      voiceState.loading = false;
      paintVoiceList();
    }
  }
}

function selectVoiceRow(id, name) {
  const player = window.ForayPlayer;
  if (!player || typeof player.setNarrationVoice !== "function") return;
  player.setNarrationVoice(id);
  logEvent("voice_pref", { voice: id });
  /* Said, not only shown: the notice is the sheet's polite live region, so the
     choice is announced — a radio that changes with no word is a silent
     change to how 4a narrates. */
  paintVoiceNotice(name ? `${name} selected.` : "");
  paintVoiceList();
}

/** Arrow keys in the voice radio group: select the neighbour (a native radio
    group selects on arrow, so this does too) and put focus back on it, since
    selecting repaints the list and the old node is gone. Wraps at the ends. */
function moveVoiceChoice(id, step) {
  const ui = voiceSheet();
  const ids = [...ui.list.querySelectorAll(".voice-row-choice")].map((c) => c.dataset.voiceId);
  const at = ids.indexOf(id);
  if (at < 0 || ids.length < 2) return;
  const next = ids[(at + step + ids.length) % ids.length];
  const target = [...ui.list.querySelectorAll(".voice-row-choice")].find((c) => c.dataset.voiceId === next);
  /* WITH ITS NAME (review 2026-09-23, an integration seam): selectVoiceRow
     grew a `name` so a choice is announced ("Samantha selected."), and this
     one-argument call wrote "" instead — the arrow keys, the path added for
     keyboard and screen-reader users, were the one path that wiped the notice. */
  selectVoiceRow(next, target?.dataset.voiceName || "");
  if (target && typeof target.focus === "function") target.focus();
}

/** V-01's Audition: speak the fixed counting line, in this row's voice, at
    1x — the speed every synthesized narration line is spoken at since the
    founder's 2026-09-24 ruling ("1x for now, but maybe we change later"), so
    the Preview sounds like the narration it previews. It used to speak at the
    current playback speed, doubling as H3's stopwatch test of the rate curve
    above 1x; narration no longer uses that part of the curve. The speed is
    `player/client.js`'s `auditionVoice`, not this function's. Guarded the
    same way every Foray tap is (#225): a rejected promise here must not
    become a console line nobody has open. */
/* ONLY THE LATEST PREVIEW OWNS THE ROW (audit round 3, app-3-10). A Preview
   tapped on Daniel while Samantha's was still speaking set auditioning to
   Daniel; Samantha's promise then settled (or was cut off) and its finally
   cleared auditioning and repainted, so Daniel's button read "Preview" again
   while he spoke, and the first run's notice could overwrite the second's. */
let auditionSeq = 0;
async function auditionVoiceRow(id) {
  const player = window.ForayPlayer;
  if (!player || typeof player.auditionVoice !== "function") return;
  const seq = ++auditionSeq;
  voiceState.auditioning = id;
  paintVoiceList();
  try {
    const result = await player.auditionVoice(AUDITION_LINE, id);
    if (seq !== auditionSeq) return;
    /* Native mode: the engine owns the one audio session and will not speak
       over an episode it is playing (NE-22, OQ-5). */
    if (result && result.ok === false && result.reason === "engine-busy") {
      paintVoiceNotice("Pause playback to preview");
    } else if (result && result.ok === false && result.reason === "narration-loaded") {
      /* Web player: a preview would cut the narrator's line off, paused or
         not (player/client.js auditionVoice), so pausing would not help. */
      paintVoiceNotice("Preview is unavailable while the narrator is on a line.");
    } else if (result && result.voiceFallback) {
      paintVoiceNotice("Your chosen voice isn't installed; using the best available.");
    } else {
      paintVoiceNotice("");
    }
  } catch (_) {
    if (seq !== auditionSeq) return;
    paintVoiceNotice("That voice could not be auditioned. Try again.");
  } finally {
    if (seq === auditionSeq && voiceState.auditioning === id) {
      voiceState.auditioning = null;
      paintVoiceList();
    }
  }
}

function openVoiceSheet() {
  const ui = voiceSheet();
  paintVoiceNotice("");
  openSheet(ui.root, { panel: ui.panel, onRequestClose: closeVoiceSheet });
  refreshVoiceList();
}

function closeVoiceSheet() {
  if (!voiceUi) return;
  closeSheet(voiceUi.root);
  voiceUi.root.hidden = true;
}

/** Appended to the drawer at startup, after the listener's switches and
    directly above the Developer group (see `init()`), so it is a listener
    setting among listener settings and never below "Delete my data". Bound
    once. */
function bindVoiceControl() {
  const drawer = $("#drawer");
  if (!drawer || $("#voice-open")) return;
  const btn = ddEl("button", "drawer-item as-btn", "Narration voice");
  btn.type = "button";
  btn.id = "voice-open";
  drawer.appendChild(btn);
  btn.addEventListener("click", openVoiceSheet);

  const ui = voiceSheet();
  ui.close.addEventListener("click", closeVoiceSheet);
  ui.scrim.addEventListener("click", closeVoiceSheet);

  /* Refresh on return, per the card: a voice downloaded in Settings must
     appear without the listener having to close and reopen the sheet. Only
     while the sheet is actually open — a background tab re-resolving voices
     for a sheet nobody can see would be wasted work every single time the
     app regains focus. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!voiceUi || voiceUi.root.hidden) return;
    refreshVoiceList();
  });
}
