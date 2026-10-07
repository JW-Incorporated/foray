/* ui/gallery.js — lab-only Afterglow component gallery.
   Registered at #/gallery only when the native lab flag is true or the URL has
   ?gallery=1. Production navigation cannot reach it. */

function galleryAllowed() {
  const optedIn = new URLSearchParams(location.search || "").get("gallery") === "1";
  return isLabBuild() || optedIn;
}

function agGalleryState(label, markup) {
  return `<div class="ag-gallery-state"><small>${esc(label)}</small>${markup}</div>`;
}

function agGallerySection(title, body, classes = "") {
  return `<section class="ag-gallery-section ${esc(classes)}"><h3 class="t-headline">${esc(title)}</h3>${body}</section>`;
}

function agGalleryButtons() {
  const states = ["default", "pressed", "focus", "disabled", "loading"];
  const variants = [
    ["Primary", "primary", "play"], ["Secondary", "secondary", "plus"],
    ["Quiet", "quiet", "bookmark"], ["Icon", "icon", "share"], ["Play", "play", "play"],
  ];
  return `<div class="ag-gallery-stack">${variants.map((variant) => `<div class="ag-gallery-states">${states.map((state) => agGalleryState(state, agButton({ label: variant[0], variant: variant[1], icon: variant[2], state }))).join("")}</div>`).join("")}</div>`;
}

function agGalleryControls() {
  return `<div class="ag-gallery-stack"><div class="ag-gallery-states">${[44, 48, 56, 88].map((size) => agGalleryState(`play ${size}`, agPlayButton({ size }))).join("")}${agGalleryState("back 15", agSkipButton({ direction: "back" }))}${agGalleryState("forward 30", agSkipButton())}</div><div class="ag-gallery-states">${agGalleryState("default", agChip("Science"))}${agGalleryState("selected", agChip("Science", { selected: true }))}${agGalleryState("disabled", agChip("Science", { disabled: true }))}${agGalleryState("badge", agPill("Stretch", "sparkle"))}</div>${agSectionHead("Today's picks", "6", "Chosen from shows followed and subjects saved.")}${agSearchField()}${agSearchField({ value: "fusion", state: "focus" })}${agGalleryState("scrubber default", agScrubber({ value: 42 }))}${agGalleryState("scrubber drag", agScrubber({ value: 63, state: "drag" }))}${agStrip({ size: "player", current: 2 })}${agStrip({ size: "detail", current: 4 })}</div>`;
}

function agGalleryArtwork() {
  const sizes = [44, 56, 72, 104, 120, 160, 280];
  const arts = sizes.map((size, index) => agArtwork({ name: `Artwork ${size}`, size, tone: AG_TONES[index], state: size >= 104 ? "lit" : "default" })).join("");
  const collages = [1, 2, 3, 4].map((count) => agCollage([
    { name: "Science Vs", tone: "teal" }, { name: "Planet Money", tone: "coral" },
    { name: "99% Invisible", tone: "violet" }, { name: "Odd Lots", tone: "blue" },
  ].slice(0, count), { size: 104 })).join("");
  return `<div class="ag-gallery-stack"><div class="ag-gallery-art-row">${arts}</div><div class="ag-gallery-art-row">${collages}</div></div>`;
}

function agGalleryRows() {
  const states = ["default", "pressed", "focus", "playing", "played", "downloaded", "unavailable", "loading"];
  return `<div class="ag-gallery-stack">${states.map((state) => agGalleryState(state, agEpisodeRow({ state }))).join("")}${agGalleryState("queue", agQueueRow())}${agGalleryState("current", agQueueRow({ state: "current" }))}${agGalleryState("4a added", agQueueRow({ state: "added", reason: "A shorter follow-up on a subject saved yesterday." }))}${agGalleryState("narration", agQueueRow({ state: "narration", title: "Why the next show belongs here" }))}</div>`;
}

function agGalleryCards() {
  return `<div class="ag-gallery-stack">${agHeroPick()}<div class="ag-gallery-grid">${["default", "pressed", "focus", "disabled", "loading"].map((state) => agGalleryState(`stretch ${state}`, agStretchCard({ state }))).join("")}${agForayCard()}${agForayCard({ compact: true })}${agForayCard({ compact: true, finished: true })}${agShowTile()}${agShowTile({ followed: true })}${agSubjectTile()}${agPlaylistTile()}</div></div>`;
}

function agGalleryFeedback() {
  return `<div class="ag-gallery-stack">${agGalleryState("toast", agToast())}${agGalleryState("skeleton row", agSkeleton("row"))}${agGalleryState("skeleton art", agSkeleton("art"))}${agGalleryState("empty", agEmptyState())}<div class="ag-gallery-sheet-stage">${agGalleryState("sheet default", agSheet({ preview: true }))}${agGalleryState("sheet drag", agSheet({ preview: true, state: "drag" }))}</div><button class="ag-btn ag-btn-secondary" type="button" data-ag-open-sheet="">Open sheet</button></div>`;
}

function agGalleryGlowSwatches() {
  const hues = ["amber", "gold", "teal", "blue", "violet", "coral"];
  return `<div class="ag-glow-swatches">${hues.map((tone) => `<span class="ag-glow-swatch ag-tone-${esc(tone)}" role="img" aria-label="${esc(`${tone} Glow`)}"></span>`).join("")}</div>`;
}

function agGalleryPanel(theme) {
  const isDawn = theme === "dawn";
  const rowsTitle = "Rows · every state";
  return `<article class="ag ag-gallery-scheme" data-theme="${esc(theme)}"><h2 class="ag-gallery-title t-title">${esc(isDawn ? "Dawn" : "Dusk")}<span>${esc(isDawn ? "paper room" : "warm room")}</span></h2>${agGallerySection("Glow range", agGalleryGlowSwatches())}${agGallerySection("Buttons · every state", agGalleryButtons())}${agGallerySection("Controls", agGalleryControls())}${agGallerySection("Artwork and collages", agGalleryArtwork())}${agGallerySection(rowsTitle, agGalleryRows())}${agGallerySection("Cards and tiles", agGalleryCards())}${agGallerySection("Dock and tab bar", `<div class="ag-gallery-stack">${agDock({ active: "today", label: theme + " Today navigation" })}${agDock({ active: "discover", withField: true, receded: true, label: theme + " Discover navigation" })}${agMiniPlayer({ state: "paused" })}${agMiniPlayer({ state: "buffering" })}${agMiniPlayer({ state: "drag" })}</div>`)}${agGallerySection("Sheets, toast, loading and empty", agGalleryFeedback())}${agIconGallery()}${agSheet({ open: false })}</article>`;
}

function agGalleryMarkup() {
  return `<div class="ag ag-gallery" data-theme="dusk"><header class="ag-gallery-head"><h1 class="t-display">Afterglow primitives</h1><p>One treatment per component, with each state visible in Dusk and Dawn.</p></header>${agGalleryPanel("dusk")}${agGalleryPanel("dawn")}</div>`;
}

let agGallerySheetOpener = null;

function agGalleryCloseSheet(sheet) {
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  document.removeEventListener("keydown", agGallerySheetKeys, true);
  const panel = sheet.closest(".ag-gallery-scheme");
  if (panel) [...panel.children].forEach((child) => { child.inert = false; });
  if (agGallerySheetOpener && typeof agGallerySheetOpener.focus === "function") agGallerySheetOpener.focus();
  agGallerySheetOpener = null;
}

function agGalleryOpenSheet(button) {
  const panel = button && button.closest(".ag-gallery-scheme");
  const sheet = panel && panel.querySelector("[data-ag-live-sheet]");
  if (!sheet) return;
  agGallerySheetOpener = button;
  [...panel.children].forEach((child) => { if (child !== sheet) child.inert = true; });
  sheet.hidden = false;
  document.addEventListener("keydown", agGallerySheetKeys, true);
  const first = sheet.querySelector("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (first) first.focus();
}

function agGalleryTrapFocus(event, sheet) {
  const focusable = [...sheet.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
  else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
}

function agGallerySheetKeys(event) {
  const sheet = document.querySelector("[data-ag-live-sheet]:not([hidden])");
  if (!sheet) return;
  if (event.key === "Escape") { event.preventDefault(); agGalleryCloseSheet(sheet); }
  else if (event.key === "Tab") agGalleryTrapFocus(event, sheet);
}

function bindGalleryPrimitives(root) {
  bindAgPrimitives(root);
  if (!root || root.dataset.agBound === "true") return;
  root.dataset.agBound = "true";
  root.addEventListener("click", (event) => {
    const open = event.target.closest && event.target.closest("[data-ag-open-sheet]");
    if (open) { agGalleryOpenSheet(open); return; }
    const close = event.target.closest && event.target.closest("[data-ag-live-sheet] .ag-sheet-head button");
    if (close) agGalleryCloseSheet(close.closest("[data-ag-live-sheet]"));
  });
}

function renderGallery() {
  if (!galleryAllowed()) { renderHome(); return; }
  setBodyClass("gallery-page");
  const view = $("#view");
  view.innerHTML = agGalleryMarkup();
  bindGalleryPrimitives(view);
}
