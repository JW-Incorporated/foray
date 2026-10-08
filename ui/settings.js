/* ui/settings.js — Settings sheet: Appearance, Dials, and the exploration floor.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Tactile (Redesign 2026, Phase 4 group G `settings`): the sheet ----------

   The knob keycap on Today and Yours opens THIS, not the drawer. What the
   direction asks of it (docs/redesign-2026/directions/tactile/BUILD-PLAN.md
   2.19, BUILD-NOTES 4):

     - it is the app's own modal (`openSheet`): `aria-modal`, the page behind it
       `inert`, focus on the sheet container (never its first button), Tab kept
       inside, Escape / the scrim / Done close it and focus goes back to the
       knob. There is no grabber: the prototype's sheet has none, and without
       it the header reads title-then-Appearance on one 4px rhythm;
     - APPEARANCE: Cream / Bakelite / Auto in a well, written to `cp_theme`
       through the storage shim and flipped on `html[data-theme]` with no reload
       (the token layer already honours the attribute; "System" removes it);
     - DIALS: a 44px well per subject, a persimmon fill from the left, the band
       needle at the value, a centre detent drawn ABOVE the fill. The hidden
       range input's `step` snaps to the detent (a selection haptic on arrival);
       the readout is the offset from 4a's setting ("+2", "−1") and is empty
       at the detent. 4a's setting is the centre detent whatever its weight is;
     - THE EXPLORATION FLOOR IS A SENTENCE, NOT A CONTROL. Product principle 1
       keeps it at about a third; a dial would invite the listener to turn it
       off. Nothing here is an input for it.

   RULING THAT FELL: "the knob opens the drawer" (ui/home.js, ui/library.js).
   The drawer itself is untouched: every other page keeps its menu button, and
   the sheet's "More settings" key hands over to it, because the drawer's
   switches (Family mode, Continuous playback, the voice picker, Delete my
   data...) have no other way in from Today and Yours, where the topbar's menu
   button is hidden. Moving them into this sheet is a later unit's work.

   WHICH DIALS. The taxonomy's ROOT subjects, three of them: the ones the
   listener has already moved first (most moved first), then the ones 4a leans
   on hardest. The interests page keeps every root and every moved leaf. */

/* The prototype's order and words: Cream / Bakelite / Auto, with the default
   (Auto = "follow the OS", stored as "system") on the right. */
const SETTINGS_THEMES = Object.freeze([
  Object.freeze({ value: "light", label: "Cream" }),
  Object.freeze({ value: "dark", label: "Bakelite" }),
  Object.freeze({ value: "system", label: "Auto" }),
]);

/** A dial is eleven positions, 0 to 10, with 4a's setting at 5. */
const SETTINGS_DIAL_MAX = 10;
const SETTINGS_DIAL_DETENT = 5;
const SETTINGS_DIAL_COUNT = 2;

const SETTINGS_DETENT_COPY = "4a's setting is the centre detent";
const SETTINGS_FLOOR_COPY = "The exploration floor stays at about a third. It is not a dial.";

/* ---------- appearance ---------- */

/** "system" | "light" | "dark". Anything else stored, or nothing, is "system". */
function settingsThemeRead() {
  const v = lsGet("cp_theme", "system");
  return v === "light" || v === "dark" ? v : "system";
}

/** Flip the scheme on <html>: "light" and "dark" are the two authored schemes
    (the attribute selects Cream or Bakelite whatever the OS says), "system"
    removes the attribute so the OS decides. No reload, nothing repainted. */
function settingsThemeApply(value) {
  try {
    const root = document.documentElement;
    if (!root || typeof root.setAttribute !== "function") return;
    if (value === "light" || value === "dark") root.setAttribute("data-theme", value);
    else if (typeof root.removeAttribute === "function") root.removeAttribute("data-theme");
  } catch (_) { /* a stub document */ }
}

/** Boot: paint the stored choice. Called at the top of init() and again once
    storage has hydrated, because the durable tier can hold a newer choice than
    localStorage did at first paint. */
function applyStoredTheme() {
  settingsThemeApply(settingsThemeRead());
}

/** The one writer: persist (through the shim, `cp_` key), then apply. */
function settingsThemeSet(value) {
  const next = value === "light" || value === "dark" ? value : "system";
  lsSet("cp_theme", next);
  settingsThemeApply(next);
  return next;
}

function settingsThemeHtml(current) {
  const buttons = SETTINGS_THEMES.map((t) => {
    const on = t.value === current;
    return `<button type="button" class="settings-seg__opt" role="radio" data-theme-choice="${esc(t.value)}" aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}">${esc(t.label)}</button>`;
  }).join("");
  return `<section class="settings-group" aria-labelledby="settings-appearance-label">
      <h3 class="settings-label" id="settings-appearance-label">Appearance</h3>
      <div class="well settings-seg" role="radiogroup" aria-labelledby="settings-appearance-label">${buttons}</div>
    </section>`;
}

function settingsBindTheme(sheet) {
  const group = sheet.querySelector(".settings-seg");
  if (!group) return;
  const opts = () => [...group.querySelectorAll("[data-theme-choice]")];
  const choose = (btn, { focus = false } = {}) => {
    const next = settingsThemeSet(btn.getAttribute("data-theme-choice"));
    for (const o of opts()) {
      const on = o.getAttribute("data-theme-choice") === next;
      o.setAttribute("aria-checked", on ? "true" : "false");
      o.setAttribute("tabindex", on ? "0" : "-1");
    }
    if (focus) focusQuietly(btn);
    const t = SETTINGS_THEMES.find((x) => x.value === next);
    announce(`Appearance: ${t ? t.label : next}.`);
  };
  group.addEventListener("click", (e) => {
    const btn = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-theme-choice]") : null;
    if (btn) choose(btn);
  });
  /* A radiogroup moves with the arrows (one tab stop, the chosen option's). */
  group.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    const list = opts();
    const at = list.findIndex((o) => o === (e.target && typeof e.target.closest === "function" ? e.target.closest("[data-theme-choice]") : null));
    if (at < 0) return;
    if (typeof e.preventDefault === "function") e.preventDefault();
    choose(list[(at + step + list.length) % list.length], { focus: true });
  });
}

/* ---------- dials ---------- */

/** 4a's own weight for a subject: the detent. */
function settingsAnchor(node) {
  const w = node && typeof node.weight === "number" ? node.weight : 0;
  return Math.max(0, Math.min(1, w));
}

/** Position 0..10 for a stored weight. 4a's setting is 5; below it the dial
    spans 0 to that weight, above it that weight to 1, so the whole 0..1 range
    is reachable whatever the anchor is. A weight within half a hundredth of
    the anchor (or a subject nothing has set) reads as the detent. */
function settingsDialPosition(value, anchor) {
  if (typeof value !== "number" || !Number.isFinite(value)) return SETTINGS_DIAL_DETENT;
  const v = Math.max(0, Math.min(1, value));
  if (Math.abs(v - anchor) < 0.005) return SETTINGS_DIAL_DETENT;
  let pos;
  if (v < anchor) pos = anchor > 0 ? (SETTINGS_DIAL_DETENT * v) / anchor : SETTINGS_DIAL_DETENT;
  else pos = anchor < 1 ? SETTINGS_DIAL_DETENT + (SETTINGS_DIAL_DETENT * (v - anchor)) / (1 - anchor) : SETTINGS_DIAL_DETENT;
  return Math.max(0, Math.min(SETTINGS_DIAL_MAX, Math.round(pos)));
}

/** The weight a position stands for. The detent is EXACTLY 4a's setting. */
function settingsDialValue(pos, anchor) {
  const p = Math.max(0, Math.min(SETTINGS_DIAL_MAX, Math.round(Number(pos))));
  if (!Number.isFinite(p) || p === SETTINGS_DIAL_DETENT) return anchor;
  const v = p < SETTINGS_DIAL_DETENT
    ? anchor * (p / SETTINGS_DIAL_DETENT)
    : anchor + (1 - anchor) * ((p - SETTINGS_DIAL_DETENT) / SETTINGS_DIAL_DETENT);
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

/** "+2", "−1" (a true minus), and nothing at all at the detent. */
function settingsDialReadout(pos) {
  const d = pos - SETTINGS_DIAL_DETENT;
  if (!d) return "";
  return (d > 0 ? "+" : "−") + Math.abs(d);
}

/** What a screen reader says for the slider's value. */
function settingsDialValueText(pos) {
  const d = pos - SETTINGS_DIAL_DETENT;
  if (!d) return "4a's setting";
  return (d > 0 ? "plus " : "minus ") + Math.abs(d);
}

/** The subjects that get a dial: moved ones first (by how far), then the ones
    4a weights highest, ties by name. */
function settingsDialNodes(limit = SETTINGS_DIAL_COUNT) {
  const roots = taxonomyNodes().filter((n) => n.parent === null);
  const moved = (n) => {
    const v = state.interests[n.id];
    return typeof v === "number" ? Math.abs(v - settingsAnchor(n)) : 0;
  };
  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));
  const touched = roots.filter((n) => moved(n) >= 0.005).sort((a, b) => moved(b) - moved(a) || byLabel(a, b));
  const rest = roots.filter((n) => moved(n) < 0.005).sort((a, b) => settingsAnchor(b) - settingsAnchor(a) || byLabel(a, b));
  return touched.concat(rest).slice(0, limit);
}

function settingsDialHtml(node, index) {
  const pos = settingsDialPosition(state.interests[node.id], settingsAnchor(node));
  const nameId = `settings-dial-${index}-name`;
  return `<div class="settings-dial">
        <div class="settings-dial__top"><span class="settings-dial__name" id="${nameId}">${esc(node.label)}</span><span class="readout settings-dial__read" data-dial-read aria-hidden="true">${esc(settingsDialReadout(pos))}</span></div>
        <div class="well knobtrack" data-dial-id="${esc(node.id)}">
          <input type="range" class="knobtrack__input" min="0" max="${SETTINGS_DIAL_MAX}" step="1" value="${pos}" aria-labelledby="${nameId}" aria-valuetext="${esc(settingsDialValueText(pos))}">
          <i class="knobtrack__fill" aria-hidden="true"></i><i class="knobtrack__detent" aria-hidden="true"></i><i class="knobtrack__needle" aria-hidden="true"></i>
        </div>
      </div>`;
}

function settingsDialsHtml(nodes) {
  return `<section class="settings-group" aria-labelledby="settings-dials-label">
      <div class="settings-group__top"><h3 class="settings-label" id="settings-dials-label">Dials</h3><p class="settings-note">${esc(SETTINGS_DETENT_COPY)}</p></div>
      ${nodes.map(settingsDialHtml).join("")}
      <p class="settings-note settings-floor">${esc(SETTINGS_FLOOR_COPY)}</p>
    </section>`;
}

/** Fill, needle, detent colour and readout follow the position. Custom
    property via CSSOM (strict CSP: no inline style attribute in the markup). */
function settingsPaintDial(track, pos) {
  if (track.style && typeof track.style.setProperty === "function") track.style.setProperty("--g", (pos / SETTINGS_DIAL_MAX).toFixed(2));
  track.setAttribute("data-over", pos > SETTINGS_DIAL_DETENT ? "true" : "false");
  const row = typeof track.closest === "function" ? track.closest(".settings-dial") : null;
  const read = row ? row.querySelector("[data-dial-read]") : null;
  setStatusText(read, settingsDialReadout(pos));   /* a readout is a status line, not a control: written only when it changes */
  const input = track.querySelector(".knobtrack__input");
  if (input) input.setAttribute("aria-valuetext", settingsDialValueText(pos));
}

function settingsBindDials(sheet) {
  for (const track of sheet.querySelectorAll(".knobtrack")) {
    const input = track.querySelector(".knobtrack__input");
    const node = nodeById(track.getAttribute("data-dial-id"));
    if (!input || !node) continue;
    const anchor = settingsAnchor(node);
    let last = Number(input.value);
    settingsPaintDial(track, last);
    input.addEventListener("input", () => {
      const pos = Math.max(0, Math.min(SETTINGS_DIAL_MAX, Math.round(Number(input.value))));
      settingsPaintDial(track, pos);
      /* The detent is the click: one selection haptic on ARRIVING at it. */
      if (pos === SETTINGS_DIAL_DETENT && last !== SETTINGS_DIAL_DETENT && typeof deckHaptic === "function") deckHaptic("selection");
      last = pos;
      setInterest(node.id, settingsDialValue(pos, anchor));
      saveInterests();
      state._interestsGen = (state._interestsGen || 0) + 1;
    });
  }
}

/* ---------- the sheet ---------- */

function settingsSheetHtml() {
  return `<div class="settings-scrim" id="settings-scrim"></div><section class="sheet settings-sheet" id="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-sheet-title" tabindex="-1" hidden>
    <header><h2 class="title" id="settings-sheet-title">Settings</h2><button type="button" class="textbtn" id="settings-done">Done</button></header>
    <div class="settings-body">
      ${settingsThemeHtml(settingsThemeRead())}
      ${settingsDialsHtml(settingsDialNodes())}
      <button type="button" class="textbtn settings-more" id="settings-more">More settings</button>
    </div>
  </section>`;
}

/** Open the sheet from the knob. One at a time. `opener` is the knob, and is
    where focus goes back to (a button does not take focus on a tap in every
    WebView, so the owner cannot rely on `document.activeElement`). */
function openSettingsSheet(opener) {
  if ($("#settings-sheet")) return;
  const knob = opener && opener.isConnected !== false ? opener : null;
  const holder = document.createElement("div");
  holder.innerHTML = settingsSheetHtml();
  const scrim = holder.firstElementChild;
  const sheet = holder.lastElementChild;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  settingsBindTheme(sheet);
  settingsBindDials(sheet);
  let done = false;
  /* The knob may have been repainted away while the sheet was up (a page
     render replaces #view); the new one is found by id. */
  const knobNow = () => (knob && knob.isConnected !== false ? knob : ($("#today-knob") || $("#yours-knob") || null));
  const setExpanded = (open) => { const k = knobNow(); if (k && typeof k.setAttribute === "function") k.setAttribute("aria-expanded", open ? "true" : "false"); };
  const shut = () => {
    if (done) return false;
    done = true;
    closeSheet(sheet, { removeIfOwned: true });
    if (scrim.remove) scrim.remove();
    setExpanded(false);
    if (!document.activeElement || document.activeElement === document.body) focusQuietly(knobNow());
    return true;
  };
  openSheet(sheet, { onRequestClose: shut, keepReachable: ["#settings-scrim"], returnFocus: knob });
  setExpanded(true);
  scrim.addEventListener("click", shut);
  sheet.querySelector("#settings-done").addEventListener("click", shut);
  sheet.querySelector("#settings-more").addEventListener("click", () => {
    shut();
    openDrawer(true);
  });
}
