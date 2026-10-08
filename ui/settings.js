/* ui/settings.js — the gear's Sheet, Settings, About, and the appearance setting.
   (Redesign 2026, ambient direction "Afterglow", BUILD-PLAN screen 9: Settings, Tuning, About.)
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init().

   WHAT THIS REPLACES. The drawer: a slide-in panel opened by the top bar's hamburger that carried five
   destinations (now the three tabs), the listener's switches, a Developer group and "Delete my data".
   DIRECTION.md "Information architecture" overturns "4 tabs + drawer": one gear at the top of Today opens a
   Sheet that lists Settings, Tuning (ex-Interests), About and "What 4a does", and each of the first three is a
   page of its own (#/settings, #/interests, #/about). No element with the id `drawer` is in index.html or ever
   created; test/ambient-settings.test.js pins both halves.

   WHERE THE OLD CONTROLS WENT, AND WHY THEY ARE BUILT THE WAY THEY ARE. Every switch and sheet-opening row the
   drawer had keeps its builder, its handler and its id (`family-toggle`, `diag-open`, `delete-data` ...), because
   the persona, deletion, diagnostics and voice suites pin them by id. What changed is the container: the
   controls are built once at startup into ONE host element (`#settings-host`, in sections), which is parked,
   hidden, in <body> and moved into the Settings page while that page is on screen, then parked again before
   the next page replaces #view. Moving the same nodes keeps their listeners, their running state (a voice probe
   in flight, a row waiting on the engine) and every `$("#id")` lookup the builders make, none of which survives
   being re-created per visit. `parkSettingsHost()` runs FIRST in renderCurrentPage() so the page swap can
   never take the host with it.

   THE APPEARANCE SETTING is `cp_theme`: "dusk" | "dawn" | "system" (the default). It is written through the
   storage shim and applied as `data-theme` on <html>, which ui/tokens.css reads on `:root`: "system" removes the
   attribute so the media query follows the phone, the other two pin the scheme. Applied again after the
   storage hydrates and after "Delete my data", which removes the key. */

/* ---------- appearance ---------- */

const ST_THEMES = [["dusk", "Dusk"], ["dawn", "Dawn"], ["system", "Follow system"]];
const ST_THEME_COLOR = { dusk: "#14110F", dawn: "#F7F2EB" };

/** The stored preference; anything unrecognised is "system", the default. */
function themePref() {
  const v = lsGet("cp_theme", "system");
  return ST_THEMES.some(t => t[0] === v) ? v : "system";
}

/** Which scheme paints right now: the pinned one, or the phone's for "system". */
function effectiveTheme(pref) {
  if (pref === "dusk" || pref === "dawn") return pref;
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches ? "dawn" : "dusk";
  } catch (_) { return "dusk"; }
}

/** Write the scheme onto <html>, live. "system" removes the attribute, so ui/tokens.css's own media query decides. */
function applyTheme(pref) {
  const root = document.documentElement;
  if (root && typeof root.setAttribute === "function") {
    if (pref === "dusk" || pref === "dawn") root.setAttribute("data-theme", pref);
    else if (typeof root.removeAttribute === "function") root.removeAttribute("data-theme");
  }
  /* The status bar follows the room: a meta the page already ships. A stub document has no querySelector. */
  try {
    const meta = typeof document.querySelector === "function" ? document.querySelector('meta[name="theme-color"]') : null;
    if (meta && typeof meta.setAttribute === "function") meta.setAttribute("content", ST_THEME_COLOR[effectiveTheme(pref)]);
  } catch (_) { /* a stub document */ }
}

/** Boot, late hydration and "Delete my data" all come here: read the key, paint the room. */
function applyStoredTheme() {
  applyTheme(themePref());
}

function setThemePref(pref) {
  const next = ST_THEMES.some(t => t[0] === pref) ? pref : "system";
  lsSet("cp_theme", next);
  applyTheme(next);
  return next;
}

/* ---------- segmented controls: three Chips in a radiogroup ---------- */

/** A radiogroup of 44-tall Chips, the selected one Lamp-filled (`.ag-chip.is-selected`, ui/primitives.css).
    `options` are [value, label, disabled?]; `attrs` are extra [name, value] pairs on the group.
    Roving tabindex: the selected chip is the one Tab stop, the arrows move the choice (stSegKey). */
function stSegHtml({ options, value, ariaLabel = "", labelledBy = "", attrs = [], chipAttr = "data-st-value" }) {
  const group = agAttrs([
    ["class", "st-seg"], ["role", "radiogroup"],
    ["aria-label", ariaLabel || null], ["aria-labelledby", labelledBy || null], ...attrs,
  ]);
  const chips = options.map(([v, label, disabled]) => {
    const on = v === value;
    return `<button type="button" class="ag-chip${on ? " is-selected" : ""}" role="radio" aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}" ${esc(chipAttr)}="${esc(v)}"${disabled ? ' disabled aria-disabled="true"' : ""}>${esc(label)}</button>`;
  }).join("");
  return `<div${group}>${chips}</div>`;
}

/** Repaint one group's selection in place (no re-render, so focus stays on the chip). */
function stSegSelect(group, value) {
  if (!group || typeof group.querySelectorAll !== "function") return;
  group.querySelectorAll("[role=radio]").forEach(chip => {
    const v = chip.getAttribute("data-st-value");
    const on = v === value;
    chip.classList.toggle("is-selected", on);
    chip.setAttribute("aria-checked", on ? "true" : "false");
    chip.setAttribute("tabindex", on ? "0" : "-1");
  });
}

/** Arrow keys inside a radiogroup move the choice and focus, as native radios do. Delegated per page. */
function stSegKey(e) {
  const k = e && e.key;
  if (k !== "ArrowRight" && k !== "ArrowLeft" && k !== "ArrowDown" && k !== "ArrowUp") return;
  const chip = e.target && typeof e.target.closest === "function" ? e.target.closest("[role=radio]") : null;
  const group = chip && typeof chip.closest === "function" ? chip.closest("[role=radiogroup]") : null;
  if (!group) return;
  const all = [...group.querySelectorAll("[role=radio]")].filter(c => !c.disabled);
  const at = all.indexOf(chip);
  if (at < 0 || all.length < 2) return;
  if (typeof e.preventDefault === "function") e.preventDefault();
  const step = k === "ArrowRight" || k === "ArrowDown" ? 1 : all.length - 1;
  const next = all[(at + step) % all.length];
  focusQuietly(next);
  if (typeof next.click === "function") next.click();
}

/* ---------- page shell: the Back chevron, the title, the page's own scope ---------- */

/** The head every Settings page wears. Its title is the page's <h1> (the legacy top bar, which carried the only one, steps
    aside on these pages; axe's page-has-heading-one is what noticed) and is what pageHeading() lands focus on; `a.back` is the
    history-aware ‹ (onBackClick), with `#/` as the cold-open fallback. */
function stHeadHtml(title) {
  return `<header class="st-head"><a class="back st-back ag-btn ag-btn-icon ag-btn-size-44" href="#/" aria-label="Back">${agIcon("chevron-left")}</a><h1 class="t-title">${esc(title)}</h1></header>`;
}

function stPageHtml(key, title, body) {
  return `<div class="ag st-page" data-st-page="${esc(key)}">${stHeadHtml(title)}${body}</div>`;
}

/* ---------- the gear's Sheet ---------- */

/** The rows, in the order the direction names them: Settings, Tuning, About, then "What 4a does". Each note is
    one short line of what is behind the row. `route` rows are pages; the last is a Sheet of its own. The routes are
    constants written here, never data, and the markup writes them after a literal "#/" like every other in-app link:
    safeUrl() admits only http(s), and would turn "#/settings" into "#", a link to nowhere. */
const ST_MENU = [
  { key: "settings", label: "Settings", note: "Appearance, downloads, your data", route: "settings" },
  { key: "tuning", label: "Tuning", note: "Less or more of each subject", route: "interests" },
  { key: "about", label: "About", note: "Version and licences", route: "about" },
  { key: "what", label: "What 4a does", note: "The short version", action: "what" },
];

function stMenuRowHtml(row) {
  const copy = `<span class="st-row-copy"><span class="st-row-label t-label">${esc(row.label)}</span><span class="st-row-note t-caption">${esc(row.note)}</span></span>${agIcon("chevron-right")}`;
  return row.route
    ? `<li><a class="st-row" href="#/${esc(row.route)}" data-st-menu="${esc(row.key)}">${copy}</a></li>`
    : `<li><button type="button" class="st-row" data-st-menu="${esc(row.key)}">${copy}</button></li>`;
}

/** A Sheet built from the Afterglow primitives: the veil header (56, with the grabber and a 44px close),
    a body, and a scrim. `.fy-sheet` / `.fy-scrim` are the app's one modal shell (z 70, above the player);
    `.ag` puts the tokens in scope; `data-sheet-drag` is how openSheet knows the panel answers a pull down. */
function stSheetHtml({ id, title, label, body }) {
  return `<div class="ag fy-sheet st-sheet" id="${esc(id)}" hidden><div class="fy-scrim" data-st-scrim></div>`
    + `<div class="ag-sheet st-panel" role="dialog" aria-modal="true" aria-label="${esc(label || title)}" data-sheet-drag>`
    + `<header class="ag-sheet-head veil"><span class="ag-grabber" aria-hidden="true"></span><h2 class="t-headline">${esc(title)}</h2>`
    + `<button type="button" class="ag-btn ag-btn-icon ag-btn-size-44" aria-label="Close" data-st-close>${agIcon("x")}</button></header>`
    + `<div class="ag-sheet-body st-sheet-body">${body}</div></div></div>`;
}

let stMenuOpen = null;   // { wrap, gear, hash } while the gear's Sheet is up; `hash` is the page it opened over

function settingsMenuIsOpen() {
  return !!(stMenuOpen && stMenuOpen.wrap && stMenuOpen.wrap.isConnected !== false && !stMenuOpen.wrap.hidden);
}

/** Slide a freshly opened panel up from the bottom (the sheet owner's own motion; a no-op under Reduce Motion). */
function stSlideIn(panel) {
  try { slideIn(panel, "--fy-panel-dy", panelHeightPx(panel), "fy-panel-dragging"); } catch (_) { /* a stub */ }
}

function stOpenSheet(wrap, { onClose } = {}) {
  const tpl = document.createElement("div");
  tpl.innerHTML = wrap;
  const node = tpl.firstElementChild || tpl.children[0];
  if (!node) return null;
  document.body.appendChild(node);
  const panel = node.querySelector ? node.querySelector('[role="dialog"]') : null;
  const close = () => onClose();
  /* Focus goes back to whatever held it when the Sheet opened (the owner records it): the gear, or the About row. */
  const entry = openSheet(node, { panel: panel || node, onRequestClose: close });
  const scrim = node.querySelector ? node.querySelector("[data-st-scrim]") : null;
  const x = node.querySelector ? node.querySelector("[data-st-close]") : null;
  if (scrim) scrim.addEventListener("click", close);
  if (x) x.addEventListener("click", close);
  if (panel) stSlideIn(panel);
  return { node, panel, entry };
}

/** Close a Sheet this file built: slide it down, then hand focus back through the owner and remove it. `after`
    runs once it is gone. A Sheet opened WHILE another is still closing would be closed with it (the owner closes
    every sheet above the one it is closing), so anything that follows a close waits for it.

    FOCUS, in the two cases that are not "the listener tapped X": a row of the gear's Sheet is a link, and the
    navigation it makes is what started the close (`navigated`). route() lands focus on the new page's heading, but it
    runs while the Sheet is still up (or, under Reduce Motion, closes it just before it renders), so focus is on the link;
    and the owner would hand it to the gear, which on every page but Today is the top bar's and stays. So a
    navigation's close hands focus NOWHERE (the owner is told there is nowhere to return to), and whenever focus is
    lost once the Sheet is gone, the new page's heading takes it, exactly as landOnPage puts it for any other
    navigation. Deferred one microtask, so under Reduce Motion it runs after the render, not before. A plain close (the
    X, Escape, the scrim) hands focus back to the gear through the owner and never loses it. */
function stCloseSheet(node, after, { navigated = false } = {}) {
  if (!node) return;
  const panel = typeof node.querySelector === "function" ? node.querySelector('[role="dialog"]') : null;
  const done = () => {
    if (navigated) {
      const entry = sheetStack.find((s) => s.wrap === node);
      if (entry) { entry.opener = null; entry.returnFocus = null; }
    }
    closeSheet(node, { removeIfOwned: true });
    /* Not when another Sheet follows (`after`): it takes focus next, and gives it back to the gear. */
    if (typeof after !== "function") {
      Promise.resolve().then(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active.isConnected === false) landOnPage({ navigated: false });
      });
    }
    if (typeof after === "function") after();
  };
  if (!panel || !slideOut(panel, "--fy-panel-dy", panelHeightPx(panel), done)) done();
}

function closeSettingsMenu(after) {
  const open = stMenuOpen;
  if (!open) { if (typeof after === "function") after(); return; }
  stMenuOpen = null;
  const gear = open.gear;
  if (gear && typeof gear.setAttribute === "function") gear.setAttribute("aria-expanded", "false");
  stCloseSheet(open.wrap, after, { navigated: open.hash !== currentHash() });
}

/** The gear's Sheet. `gear` is the button that opened it: focus goes back there, and it carries aria-expanded. */
function openSettingsMenu(gear) {
  if (settingsMenuIsOpen()) return stMenuOpen;
  const body = `<ul class="st-menu" role="list">${ST_MENU.map(stMenuRowHtml).join("")}</ul>`;
  const built = stOpenSheet(stSheetHtml({ id: "st-menu", title: "4a", label: "4a menu", body }), { onClose: () => closeSettingsMenu() });
  if (!built) return null;
  stMenuOpen = { wrap: built.node, gear: gear || null, hash: currentHash() };
  if (gear && typeof gear.setAttribute === "function") gear.setAttribute("aria-expanded", "true");
  built.node.addEventListener("click", onSettingsMenuClick);
  return stMenuOpen;
}

function onSettingsMenuClick(e) {
  const row = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-st-menu]") : null;
  if (!row) return;
  const key = row.getAttribute("data-st-menu");
  if (key === "what") {
    if (typeof e.preventDefault === "function") e.preventDefault();
    closeSettingsMenu(() => openWhatSheet());
    return;
  }
  /* The page already on screen: assigning its own hash fires no hashchange, so the Sheet would stay. Close it. */
  const href = typeof row.getAttribute === "function" ? row.getAttribute("href") : null;
  if (href && currentHash(href) === currentHash()) {
    if (typeof e.preventDefault === "function") e.preventDefault();
    closeSettingsMenu();
  }
  /* Any other row is a link: route() closes every Sheet when the hash changes. */
}

/** The gear: Today's own button, and the top bar's on every other page. Both open the one Sheet. */
function bindSettingsGear(btn) {
  if (!btn || btn._stGear || typeof btn.addEventListener !== "function") return;
  btn._stGear = true;
  if (typeof btn.setAttribute === "function") {
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
  }
  btn.addEventListener("click", () => {
    if (settingsMenuIsOpen()) closeSettingsMenu(); else openSettingsMenu(btn);
  });
}

/** Bound once from init(): the top bar's gear, and the wordmark's same-page tap (it used to live in the drawer's chrome). */
function bindSettingsChrome() {
  bindSettingsGear($("#menu-btn"));
  bindOverlayKeys();
  const mark = $(".wordmark");
  if (mark && typeof mark.addEventListener === "function") mark.addEventListener("click", (e) => sameHashTap(mark, e));
}

/* ---------- "What 4a does": the introduction, again, from anywhere ---------- */

let stWhatOpen = null;

function whatSheetBodyHtml() {
  return `<p class="t-body">${esc("4a picks a few podcasts a day and says why each one is there.")}</p>`
    + `<p class="t-body">${esc("About a third of each day sits outside your usual subjects.")}</p>`
    + `<p class="t-body"><strong>Forays.</strong> ${esc(forayAbout())}</p>`
    + `<p class="t-caption st-note">${esc("No account needed. Audio plays from each show's own feed.")}</p>`;
}

function closeWhatSheet() {
  const open = stWhatOpen;
  if (!open) return;
  stWhatOpen = null;
  stCloseSheet(open);
}

function openWhatSheet() {
  if (stWhatOpen && stWhatOpen.isConnected !== false) return stWhatOpen;
  const built = stOpenSheet(stSheetHtml({ id: "st-what", title: "What 4a does", body: whatSheetBodyHtml() }), { onClose: closeWhatSheet });
  stWhatOpen = built ? built.node : null;
  return stWhatOpen;
}

/* ---------- the switches, in ONE shape (was the drawer's drawerToggle) ---------- */

/* A switch declares where its state lives and what a tap does; this helper owns what every switch copies:
   creating the button in its section, binding the click exactly once, registering the label so
   paintSettings() paints it with the rest. APPENDED, never `hidden`-toggled, for the reason renderTabBar's
   comment states (an author `display` rule beats the UA's [hidden]). */
const settingSwitches = [];

/**
 * @param {string}   id      the element id
 * @param {string}   label   the text before the colon, e.g. "Family mode"
 * @param {Function} read    () => boolean — the CURRENT state, read fresh
 * @param {Function} write   (next: boolean) => void — persist it, log it
 * @param {object}   [opts]
 * @param {string[]} [opts.words]  the two state words, `[off, on]`
 * @param {Element}  [opts.into]   the section list to append to (default: Listening)
 */
function settingSwitch(id, label, read, write, { words = ["off", "on"], into = null } = {}) {
  const host = settingsHost();
  if (!host) return;
  if (!settingSwitches.some(t => t.id === id)) settingSwitches.push({ id, label, read, words });
  let btn = $("#" + id);
  if (!btn) {
    btn = ddEl("button", "st-item st-switch", "");
    btn.type = "button";
    btn.id = id;
    (into || settingsList("listening")).appendChild(btn);
  }
  if (btn._switchBound) return;   // init() runs once, but a re-bind must never stack handlers
  btn._switchBound = true;
  /* A SWITCH IS A SWITCH TO A SCREEN READER (audit round 2, a11y-8): role="switch" with aria-checked, painted
     with the label below — "Family mode, switch, off" — and the flip is said. */
  btn.setAttribute("role", "switch");
  btn.addEventListener("click", () => {
    write(!read());
    paintSettings();
    /* NO announce() HERE. The switch stays focused and paintSettingSwitches flips its aria-checked in place,
       which VoiceOver and TalkBack already speak; a live-region line on top said every tap twice. */
  });
}

/** Every registered switch's label, read fresh. Guarded per element because a page can mount without one (a
    harness with a partial host). The visible text keeps its "Family mode: off"; the NAME is the label alone,
    because the switch's own checked state already says on or off. */
function paintSettingSwitches() {
  for (const t of settingSwitches) {
    const btn = $("#" + t.id);
    if (!btn) continue;
    const on = !!t.read();
    setControlLabel(btn, `${t.label}: ${t.words[on ? 1 : 0]}`, t.label);
    btn.setAttribute("aria-checked", String(on));
  }
}

/** The listener's switches. The founder's two are bindDeveloperToggles' (ui/settings-dev.js). */
function bindSettingSwitches() {
  settingSwitch("family-toggle", "Family mode", familyMode, (on) => {
    lsSet("cp_family", on);
    logEvent("family_mode", { on });
    buildCards();
  });

  settingSwitch("autoadvance-toggle", "Continuous playback", autoAdvanceOn, (on) => {
    lsSet("cp_autoadvance", on);
    logEvent("autoadvance_pref", { on });
    /* The switch changes what the END of the playing episode does, so a player that was handed the plan ahead
       (the native engine's setContinuation) must hear it now, not at the next play (NE-13). */
    refreshEpisodeNavigation();
  });

  /* §13's jingle (player/interlude.js). THE CONTROL THE PRIVACY POLICY ALREADY PROMISED: docs/legal/
     privacy-policy.md lists `cp_interlude` as "On unless you turn it off". */
  settingSwitch("interlude-toggle", "Jingle between clips", interludeOn, setInterludeOn);

  /* Downloads are Wi-Fi only unless the listener says otherwise (#29). Only where downloads exist at all: off
     the shell there is no bridge, no Download control, and so nothing for this to govern. Read at each
     enqueue, so it applies to the next download, not one in flight. */
  if (state.downloadBridge) {
    settingSwitch("downloads-cellular-toggle", "Download over cellular", downloadsCellularOn, setDownloadsCellular, { into: settingsList("downloads") });
  }
}

/* ---------- the host: sections of controls, parked or on the Settings page ---------- */

let settingsHostEl = null;
const settingsLists = {};

/** [key, heading]; a null heading is the Developer disclosure, which carries its own summary. */
const ST_SECTIONS = [["listening", "Listening"], ["downloads", "Downloads"], ["developer", null], ["data", "Your data"]];

/** Built once. Parked, hidden, in <body> until renderSettings() moves it into the page. */
function settingsHost() {
  if (settingsHostEl) return settingsHostEl;
  const host = ddEl("div", "st-host", null);
  host.id = "settings-host";
  host.hidden = true;
  for (const [key, heading] of ST_SECTIONS) {
    const section = ddEl(key === "developer" ? "details" : "section", key === "developer" ? "st-section st-dev" : "st-section", null);
    section.dataset.stSection = key;
    if (key === "developer") {
      section.id = "settings-dev";
      section.appendChild(ddEl("summary", "st-item st-summary", "Developer"));
    } else {
      const h = ddEl("h3", "st-section-head t-headline", heading);
      h.id = "st-h-" + key;
      section.appendChild(h);
    }
    const list = key === "developer" ? section : ddEl("div", "st-list", null);
    if (key !== "developer") section.appendChild(list);
    settingsLists[key] = list;
    host.appendChild(section);
  }
  document.body.appendChild(host);
  settingsHostEl = host;
  return host;
}

/** The list a control is appended to: a section's `.st-list` (the Developer disclosure is its own list). */
function settingsList(key) {
  settingsHost();
  return settingsLists[key] || settingsLists.listening;
}

/** The Developer disclosure (a native <details>, closed on every launch): the founder's field tools. */
function settingsDevGroup() {
  settingsHost();
  return settingsLists.developer;
}

/** Move the host into the page's slot. Called by renderSettings() after it writes the page. */
function mountSettingsHost(slot) {
  const host = settingsHost();
  if (!slot || typeof slot.appendChild !== "function") return host;
  slot.appendChild(host);
  host.hidden = false;
  return host;
}

/** Back to <body>, hidden, with every listener and every running state intact. FIRST thing renderCurrentPage()
    does, so replacing #view can never take the host with it. */
function parkSettingsHost() {
  const host = settingsHostEl;
  if (!host) return;
  if (host.parentElement && host.parentElement !== document.body) document.body.appendChild(host);
  host.hidden = true;
}

/** Everything the controls say, painted from live state. Was the drawer's renderDrawer(). */
function paintSettings() {
  if (!settingsHostEl) return;
  paintSettingSwitches();
  /* K-01: whether the RUN button exists at all. The toggle's own label is painted above with the others; this is
     the control that appears and disappears with it, which no label line can express. */
  syncVoiceProbeRun();
  /* NE-22d: the engine's Developer rows, which exist only where an engine answered. */
  syncEngineDevRows();
  syncDownloadsNote();
}

let stDownloadsNote = null;

/** No bridge, no control (downloads.js): the section says so in one line instead of showing a dead switch. */
function syncDownloadsNote() {
  const list = settingsLists.downloads;
  if (!list) return;
  if (state.downloadBridge) {
    if (stDownloadsNote && typeof stDownloadsNote.remove === "function") stDownloadsNote.remove();
    stDownloadsNote = null;
    return;
  }
  if (stDownloadsNote) return;
  stDownloadsNote = ddEl("p", "st-note t-caption", "Downloads are in the 4a apps for iPhone and Android.");
  stDownloadsNote.setAttribute("data-st-no-downloads", "");
  list.appendChild(stDownloadsNote);
}

/* ---------- the Settings page (#/settings) ---------- */

function isSettingsRoute() { return currentHash() === "#/settings"; }

function appearanceHtml() {
  const pref = themePref();
  return `<section class="st-section" aria-labelledby="st-h-appearance"><h3 class="st-section-head t-headline" id="st-h-appearance">Appearance</h3>`
    + stSegHtml({ options: ST_THEMES, value: pref, labelledBy: "st-h-appearance", attrs: [["data-st-theme", ""]] })
    + `<p class="st-note t-caption">${esc("Dusk is the warm dark room, Dawn the paper-light one. Follow system uses your phone's setting.")}</p></section>`;
}

/** Run `change` with every transition under `page` switched off for the moment it takes the colours to settle, so a scheme
    change is a cut and not a 200ms smear of every surface (under Reduce Motion the one reduced block would otherwise turn it
    into one). The class goes on, the change is made, a style flush makes the new values the computed ones, and the class
    comes off: nothing is left to transition from. */
function stCutTransitions(page, change) {
  if (!page || !page.classList) { change(); return; }
  page.classList.add("st-swap");
  try { change(); reflow(page); } finally { page.classList.remove("st-swap"); }
}

function onSettingsClick(e) {
  const chip = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-st-value]") : null;
  const group = chip && typeof chip.closest === "function" ? chip.closest("[data-st-theme]") : null;
  if (!group || chip.disabled) return;
  const page = typeof group.closest === "function" ? group.closest(".st-page") : null;
  stCutTransitions(page, () => stSegSelect(group, setThemePref(chip.getAttribute("data-st-value"))));
}

function renderSettings() {
  setBodyClass("view-settings");
  const view = $("#view");
  view.innerHTML = stPageHtml("settings", "Settings", appearanceHtml() + `<div class="st-slot" data-st-slot></div>`);
  const page = view.querySelector ? view.querySelector(".st-page") : null;
  const slot = view.querySelector ? view.querySelector("[data-st-slot]") : null;
  mountSettingsHost(slot);
  paintSettings();
  if (page && typeof page.addEventListener === "function") {
    page.addEventListener("click", onSettingsClick);
    page.addEventListener("keydown", stSegKey);
  }
}

/* ---------- the About page (#/about) ---------- */

/** What the build can say about itself: the shell's marketing version and build number, or the web deploy id. */
function aboutVersionText() {
  const s = window.forayBuildStamp;
  if (s && typeof s === "object") {
    if (s.version) return `Version ${s.version}${s.native ? ` (${s.native})` : ""}`;
    if (s.native) return `Build ${s.native}`;
    if (s.web) return `Web build ${String(s.web).slice(0, 8)}`;
  }
  return "Web version";
}

const ST_LICENCES = [
  ["Fraunces and DM Sans", "SIL Open Font License 1.1"],
  ["Phosphor Icons", "MIT License"],
];

function renderAbout() {
  setBodyClass("view-settings");
  const licences = ST_LICENCES.map(([name, terms]) =>
    `<li class="st-lic"><span class="st-lic-name t-label">${esc(name)}</span><span class="st-lic-terms t-caption">${esc(terms)}</span></li>`).join("");
  $("#view").innerHTML = stPageHtml("about", "About",
    `<section class="st-about-mark"><p class="st-wordmark" aria-hidden="true">4a</p><p class="st-tagline t-body">${esc("A daily podcast picker.")}</p><p class="st-version t-caption num" data-st-version>${esc(aboutVersionText())}</p></section>`
    + `<section class="st-section"><button type="button" class="st-item st-link" data-st-what>What 4a does</button></section>`
    + `<section class="st-section" aria-labelledby="st-h-licences"><h3 class="st-section-head t-headline" id="st-h-licences">Licences</h3><ul class="st-lics" role="list">${licences}</ul>`
    + `<p class="st-note t-caption">${esc("Artwork and audio belong to each show's publisher. 4a plays from their own feeds.")}</p></section>`);
  const page = $("#view").querySelector ? $("#view").querySelector(".st-page") : null;
  if (page && typeof page.addEventListener === "function") {
    page.addEventListener("click", (e) => {
      const what = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-st-what]") : null;
      if (what) openWhatSheet(what);
    });
  }
  bindAboutStamp();
}

let aboutStampBound = false;

/** The stamp arrives a beat after boot (the shell answers getInfo asynchronously); the About page says it when it does. */
function bindAboutStamp() {
  if (aboutStampBound || typeof window.addEventListener !== "function") return;
  aboutStampBound = true;
  window.addEventListener("foray:build-stamp", () => {
    const view = $("#view");
    const line = view && typeof view.querySelector === "function" ? view.querySelector("[data-st-version]") : null;
    setStatusText(line, aboutVersionText());
  });
}
