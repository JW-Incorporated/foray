/* ui/primitives.js — Afterglow's Phase 3 component primitives.
   Classic script, sharing app.js's esc()/safeUrl() and ui/icons.js's agIcon().

   These functions return inert markup only. Existing screens do not call them in
   Phase 3; each screen opts in during Phase 4. All caller text crosses esc(), every
   image source crosses safeUrl(), and icon fragments are allow-listed by agIcon(). */

const AG_BUTTON_VARIANTS = ["primary", "secondary", "quiet", "icon", "play"];
const AG_STATES = ["default", "pressed", "focus", "disabled", "loading"];
const AG_ART_SIZES = [44, 56, 72, 104, 120, 160, 280];
const AG_CONTROL_SIZES = [44, 48, 56, 88];
const AG_TONES = ["amber", "teal", "coral", "violet", "blue", "gold"];

function agChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function agAttrs(entries) {
  return entries.filter((entry) => entry[1] !== null && entry[1] !== undefined && entry[1] !== false)
    .map((entry) => ` ${esc(entry[0])}="${esc(entry[1] === true ? "" : entry[1])}"`).join("");
}

function agButton({ label, variant = "secondary", state = "default", icon = "", size = 24, controlSize = 44, pressed = null } = {}) {
  const v = agChoice(variant, AG_BUTTON_VARIANTS, "secondary");
  const s = agChoice(state, AG_STATES, "default");
  const iconMarkup = icon ? agIcon(icon, size) : "";
  const text = v === "icon" || v === "play" ? "" : `<span>${esc(label || "Action")}</span>`;
  const disabled = s === "disabled";
  const busy = s === "loading";
  return `<button class="ag-btn ag-btn-${esc(v)} ag-btn-size-${esc(agChoice(Number(controlSize), AG_CONTROL_SIZES, 44))} is-${esc(s)}"${agAttrs([
    ["type", "button"],
    ["aria-label", v === "icon" || v === "play" ? (label || "Action") : null],
    ["aria-pressed", typeof pressed === "boolean" ? String(pressed) : null],
    ["aria-disabled", disabled ? "true" : null],
    ["aria-busy", busy ? "true" : null],
    ["disabled", disabled ? true : null],
  ])}>${iconMarkup}${text}${busy ? '<span class="ag-spinner" aria-hidden="true"></span>' : ""}</button>`;
}

function agPlayButton({ label = "Play", size = 48, state = "default", playing = false } = {}) {
  const px = agChoice(Number(size), AG_CONTROL_SIZES, 48);
  const glyphSize = px === 88 ? 36 : px === 56 ? 32 : 24;
  return agButton({ label: playing ? "Pause" : label, variant: "play", icon: playing ? "pause" : "play", size: glyphSize, controlSize: px, state, pressed: playing });
}

function agSkipButton({ direction = "forward", size = 56, state = "default" } = {}) {
  const forward = direction !== "back";
  const px = agChoice(Number(size), [44, 56], 56);
  return agButton({ label: forward ? "Forward 30 seconds" : "Back 15 seconds", variant: "icon", icon: forward ? "fwd30" : "back15", size: px === 56 ? 36 : 24, controlSize: px, state });
}

function agArtwork({ name = "Artwork", src = "", size = 72, tone = "amber", state = "default", badge = "" } = {}) {
  const px = agChoice(Number(size), AG_ART_SIZES, 72);
  const colour = agChoice(tone, AG_TONES, "amber");
  const artState = agChoice(state, ["default", "dim", "lit"], "default");
  const image = src
    ? `<img src="${esc(safeUrl(artUrl(src, px * 3)))}" alt="" loading="lazy" decoding="async" width="${esc(px)}" height="${esc(px)}">`
    : `<span class="ag-art-mono" aria-hidden="true">${esc(String(name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
  const badgeMarkup = badge ? `<span class="ag-art-badge">${agIcon(badge, 20)}</span>` : "";
  const lit = artState === "lit" || px >= 104;
  return `<span class="ag-art ag-art-${esc(px)} ag-tone-${esc(colour)} is-${esc(artState)}${lit ? ` lit-art lit-${px >= 280 ? "96" : px >= 160 ? "64" : "40"}` : ""}" role="img" aria-label="${esc(name)}">${image}${badgeMarkup}</span>`;
}

function agCollage(items = [], { size = 120, tone = "amber" } = {}) {
  const safeItems = items.slice(0, 4);
  const count = Math.max(1, safeItems.length);
  const cells = (safeItems.length ? safeItems : [{ name: "Artwork", tone }])
    .map((item) => agArtwork({ ...item, size: agChoice(Number(size), AG_ART_SIZES, 120) })).join("");
  return `<span class="ag-collage ag-collage-${esc(size)} c${esc(count)} lit-art lit-${Number(size) >= 160 ? "64" : "40"}">${cells}</span>`;
}

function agPill(label, icon = "") {
  return `<span class="ag-pill">${icon ? agIcon(icon, 20) : ""}<span>${esc(label)}</span></span>`;
}

function agChip(label, { selected = false, disabled = false } = {}) {
  return `<button class="ag-chip${selected ? " is-selected" : ""}" type="button" aria-pressed="${esc(selected ? "true" : "false")}"${disabled ? ' aria-disabled="true" disabled' : ""}>${esc(label)}</button>`;
}

function agSectionHead(title, count = "", explainer = "") {
  return `<header class="ag-section-head"><div><h3 class="t-headline">${esc(title)}</h3>${explainer ? `<p>${esc(explainer)}</p>` : ""}</div>${count ? `<span class="count">${esc(count)}</span>` : ""}</header>`;
}

function agEpisodeRow({
  title = "A clear account of a hard problem", show = "Field Notes", why = "A practical account of how ideas move into ordinary tools.",
  meta = "38 min · Today", state = "default", tone = "amber",
} = {}) {
  const rowState = agChoice(state, ["default", "pressed", "focus", "playing", "played", "downloaded", "unavailable", "loading"], "default");
  const stateLine = rowState === "playing" ? `<span class="ag-row-state">${agIcon("play-fill", 20)}Playing</span>`
    : rowState === "played" ? `<span class="ag-row-state muted">${agIcon("check-circle-fill", 20)}Played</span>`
      : rowState === "downloaded" ? `<span class="ag-row-state ok">${agIcon("download-fill", 20)}Downloaded</span>`
        : rowState === "unavailable" ? `<span class="ag-row-state warn">${agIcon("wifi-slash", 20)}Unavailable</span>` : "";
  return `<article class="ag-episode-row raised is-${esc(rowState)}">${agArtwork({ name: show, size: 72, tone, state: rowState === "unavailable" ? "dim" : "default" })}<div class="ag-row-copy"><h4 class="t-headline clamp2">${esc(title)}</h4><p class="t-caption clamp1">${esc(show)}</p><p class="t-why clamp2">${esc(why)}</p><p class="t-caption ag-row-meta">${stateLine}<span>${esc(meta)}</span></p></div>${agButton({ label: rowState === "playing" ? "Pause" : "Play", variant: "icon", icon: rowState === "playing" ? "pause" : "play", state: rowState === "unavailable" ? "disabled" : "default" })}</article>`;
}

function agQueueRow({ title = "Cooling factories without wasting water", show = "The Indicator", meta = "24 min left", state = "default", reason = "" } = {}) {
  const rowState = agChoice(state, ["default", "current", "added", "narration"], "default");
  if (rowState === "narration") {
    return `<article class="ag-queue-row raised is-narration"><span class="ag-narration-bar" aria-hidden="true"></span><div><p class="t-label">${esc(title)}</p><p class="t-caption">Narration</p></div></article>`;
  }
  return `<article class="ag-queue-row raised is-${esc(rowState)}">${agArtwork({ name: show, size: 56, tone: "blue" })}<div class="ag-row-copy">${rowState === "added" ? '<span class="eyebrow lamp">4a added</span>' : ""}<p class="t-label clamp2">${rowState === "current" ? agIcon("play-fill", 20) : ""}${esc(title)}</p><p class="t-caption">${esc(show)} · ${esc(meta)}</p>${reason ? `<p class="t-why clamp2">${esc(reason)}</p>` : ""}</div>${agButton({ label: "More", variant: "icon", icon: "dots" })}</article>`;
}

function agStrip({ size = "card", current = 1 } = {}) {
  const stripSize = agChoice(size, ["card", "player", "detail"], "card");
  const bars = [
    ["Science Vs", "teal", "w3"], ["4a narration", "narration", "w1"], ["Planet Money", "coral", "w4"],
    ["4a narration", "narration", "w1"], ["99% Invisible", "violet", "w2"],
  ].map((bar, index) => {
    const modifiers = "ag-tone-" + bar[1] + " " + bar[2] + (index === current ? " is-current" : "");
    if (stripSize === "card") return `<span class="ag-strip-bar ${esc(modifiers)}" aria-hidden="true"><span aria-hidden="true"></span></span>`;
    return `<button class="ag-strip-bar ${esc(modifiers)}" type="button" aria-label="${esc(`Seek to ${bar[0]}, ${index * 8}:00`)}"><span aria-hidden="true"></span></button>`;
  }).join("");
  return `<div class="ag-strip ag-strip-${esc(stripSize)}">${bars}</div>`;
}

function agScrubberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0;
}

function agScrubberTime(seconds, spoken = false) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const remainder = whole % 60;
  return spoken ? `${Math.floor(whole / 60)} min${remainder ? ` ${remainder} sec` : ""}`
    : `${Math.floor(whole / 60)}:${String(remainder).padStart(2, "0")}`;
}

function agSetScrubberValue(input) {
  if (!input) return;
  const scrubber = input.parentElement;
  const next = agScrubberValue(input.value);
  const duration = Math.max(0, Math.round(Number(scrubber.dataset.agDuration) || 0));
  const elapsed = Math.round(duration * next / 100);
  const remaining = Math.max(0, duration - elapsed);
  input.value = String(next);
  input.setAttribute("aria-valuetext", `${agScrubberTime(elapsed, true)} of ${agScrubberTime(duration, true)}`);
  scrubber.style.setProperty("--ag-scrub-progress", `${next}%`);
  const times = scrubber.querySelectorAll(".time");
  if (times[0]) times[0].textContent = agScrubberTime(elapsed);
  if (times[1]) times[1].textContent = `-${agScrubberTime(remaining)}`;
}

function agScrubberInput(event) {
  const input = event.target && event.target.closest ? event.target.closest("input.ag-scrub-input") : null;
  if (input) agSetScrubberValue(input);
}

function bindAgPrimitives(root) {
  if (!root) return;
  root.querySelectorAll("input.ag-scrub-input").forEach(agSetScrubberValue);
  if (root.dataset.agPrimitivesBound === "true") return;
  root.dataset.agPrimitivesBound = "true";
  root.addEventListener("input", agScrubberInput);
}

function agScrubber({ value = 42, duration = 2880, state = "default" } = {}) {
  const current = agScrubberValue(value);
  const total = Math.max(0, Math.round(Number(duration) || 0));
  const elapsed = Math.round(total * current / 100);
  const remaining = Math.max(0, total - elapsed);
  const progress = agChoice(Math.round(current / 25) * 25, [0, 25, 50, 75, 100], 0);
  const scrubState = agChoice(state, ["default", "drag"], "default");
  const bubble = scrubState === "drag" ? `<span class="ag-scrub-bubble raised" aria-hidden="true">${esc(agScrubberTime(elapsed))}</span>` : "";
  return `<div class="ag-scrubber p${esc(progress)} is-${esc(scrubState)}" data-ag-primitive="scrubber" data-ag-duration="${esc(total)}"><input class="ag-scrub-input" type="range" role="slider" min="0" max="100" step="1" value="${esc(current)}" aria-label="Playback position" aria-valuetext="${esc(`${agScrubberTime(elapsed, true)} of ${agScrubberTime(total, true)}`)}"><span class="ag-scrub-track"><span class="ag-scrub-fill"></span><span class="ag-scrub-thumb"></span>${bubble}</span><span class="time">${esc(agScrubberTime(elapsed))}</span><span class="time">-${esc(agScrubberTime(remaining))}</span></div>`;
}

function agStretchCard({ state = "default" } = {}) {
  return `<article class="ag-stretch-card raised is-${esc(state)}">${agPill("Stretch", "sparkle")}<div class="ag-bridge-arts">${agArtwork({ name: "Science Vs", size: 56, tone: "teal" })}<span class="ag-bridge-line" aria-hidden="true"></span>${agArtwork({ name: "Acquired", size: 56, tone: "coral" })}</div><p class="t-why">${esc("If insect systems held you, this asks the same question of a company.")}</p><div class="ag-card-end"><div><h4 class="t-headline clamp2">${esc("How an unusual company stayed independent")}</h4><p class="t-caption clamp1">${esc("Acquired · 42 min · Today")}</p></div>${agButton({ label: "Play", variant: "icon", icon: "play", state: state === "disabled" ? "disabled" : "default" })}</div></article>`;
}

function agForayCard({ compact = false, finished = false } = {}) {
  const art = agCollage([
    { name: "Science Vs", tone: "teal" }, { name: "Planet Money", tone: "coral" },
    { name: "99% Invisible", tone: "violet" }, { name: "Odd Lots", tone: "blue" },
  ], { size: compact ? 104 : 120 });
  if (compact) return `<article class="ag-foray-tile">${agPill("Foray")}<div class="ag-tile-art">${art}${agStrip({ size: "card" })}${finished ? `<span class="ag-done">${agIcon("check-circle-fill", 20)}</span>` : ""}</div><h4 class="t-caption clamp3">${esc("The hidden systems behind ordinary choices")}</h4></article>`;
  return `<article class="ag-foray-card raised">${art}<span class="eyebrow lamp">Foray</span><h4 class="t-headline clamp3">${esc("The hidden systems behind ordinary choices")}</h4><p class="t-caption">4 shows · 42 min</p>${agStrip({ size: "card" })}</article>`;
}

function agHeroPick() {
  return `<article class="ag-hero-pick">${agCollage([
    { name: "Science Vs", tone: "teal" }, { name: "Planet Money", tone: "coral" },
    { name: "99% Invisible", tone: "violet" }, { name: "Odd Lots", tone: "blue" },
  ], { size: 160 })}<div class="ag-hero-copy"><span class="eyebrow lamp">Today's pick</span><h4 class="t-title clamp4">${esc("The hidden systems shaping an ordinary glass of water")}</h4><p class="t-caption">4 shows Â· 42 min</p>${agPlayButton({ size: 56 })}</div><p class="t-why">${esc("A clear route from local choices to the systems moving water around them.")}</p></article>`;
}

function agShowTile({ followed = false } = {}) {
  return `<article class="ag-show-tile">${agArtwork({ name: "Unexplainable", size: 104, tone: "blue", badge: followed ? "check-circle-fill" : "" })}<h4 class="t-caption clamp3">${esc("Unexplainable questions from science")}</h4></article>`;
}

function agSubjectTile() {
  return `<article class="ag-subject-tile raised">${agCollage([{ name: "S", tone: "teal" }, { name: "P", tone: "coral" }, { name: "O", tone: "blue" }, { name: "H", tone: "gold" }], { size: 56 })}<div><h4 class="t-label">${esc("Science & nature")}</h4><p class="t-caption">5 shows</p></div></article>`;
}

function agPlaylistTile() {
  return `<article class="ag-playlist-tile raised">${agCollage([{ name: "S", tone: "teal" }, { name: "P", tone: "coral" }, { name: "O", tone: "blue" }, { name: "H", tone: "gold" }], { size: 120 })}<h4 class="t-headline clamp2">${esc("Slow mornings")}</h4><p class="t-caption">6 episodes · 2 hr 10 min</p><p class="t-caption ag-progress-copy">3 of 6 played</p></article>`;
}

function agSearchField({ value = "", state = "default" } = {}) {
  const fieldState = agChoice(state, ["default", "focus", "disabled"], "default");
  return `<label class="ag-search-field veil is-${esc(fieldState)}">${agIcon("magnifier", 20)}<span class="sr-only">Search</span><input type="search" value="${esc(value)}" placeholder="Search, or name a subject"${fieldState === "disabled" ? " disabled" : ""}>${value ? agButton({ label: "Clear search", variant: "icon", icon: "x" }) : ""}</label>`;
}

function agTabBar({ active = "today", receded = false, label = "Primary" } = {}) {
  const tabs = [
    ["today", "Today", "house", "house-fill"], ["discover", "Discover", "compass", "compass-fill"], ["library", "Library", "books", "books-fill"],
  ].map((tab) => {
    const on = tab[0] === active;
    return `<button class="ag-tab" type="button"${on ? ' aria-current="page"' : ""}>${agIcon(on ? tab[3] : tab[2], receded ? 24 : 28)}<span>${esc(tab[1])}</span></button>`;
  }).join("");
  return `<nav class="ag-tabbar${receded ? " is-receded" : ""}" aria-label="${esc(label)}">${tabs}</nav>`;
}

function agMiniPlayer({ state = "playing" } = {}) {
  const miniState = agChoice(state, ["playing", "paused", "buffering", "drag"], "playing");
  const playing = miniState === "playing" || miniState === "drag";
  return `<div class="ag-mini-player is-${esc(miniState)}" data-ag-primitive="mini-player" role="group" aria-label="Now playing: Cooling the world without wasting water, The Indicator"><span class="ag-mini-progress" aria-hidden="true"></span>${agArtwork({ name: "The Indicator", size: 44, tone: "blue" })}<div class="ag-mini-copy"><p class="t-label clamp1">${esc("Cooling the world without wasting water")}</p><p class="t-caption clamp1">${esc("The Indicator")}</p></div>${agPlayButton({ size: 48, state: miniState === "buffering" ? "loading" : "default", playing })}${agSkipButton({ size: 44 })}</div>`;
}

function agDock({ active = "today", withField = false, receded = false, label = "Primary" } = {}) {
  return `<section class="ag-dock-preview dock veil">${withField ? agSearchField({ state: "focus" }) : ""}${agMiniPlayer({ state: "playing" })}${agTabBar({ active, receded, label })}</section>`;
}

function agSheet({ title = "Settings", open = true, preview = false, state = "default", id = "" } = {}) {
  const sheetState = agChoice(state, ["default", "drag"], "default");
  const classes = `ag-sheet is-${sheetState}${open ? " is-open" : ""}${preview ? " is-preview" : ""}`;
  return `<div class="${esc(classes)}"${id ? ` id="${esc(id)}"` : ""} data-ag-primitive="sheet"${preview ? "" : ` role="dialog" aria-modal="true" aria-label="${esc(title)}" data-ag-live-sheet=""`}${open ? "" : " hidden"}><header class="ag-sheet-head veil"><span class="ag-grabber" aria-hidden="true"></span><h2 class="t-headline">${esc(title)}</h2>${agButton({ label: "Close", variant: "icon", icon: "x" })}</header><div class="ag-sheet-body"><div class="ag-menu-row">${agIcon("sliders", 24)}<span>Tuning</span></div><div class="ag-menu-row">${agIcon("moon", 24)}<span>Appearance</span></div><div class="ag-menu-row">${agIcon("share", 24)}<span>Share</span></div></div></div>`;
}

function agToast({ action = true } = {}) {
  return `<div class="ag-toast raised" role="status" aria-live="polite"><span class="t-label">Removed from Up Next</span>${action ? agButton({ label: "Undo", variant: "quiet" }) : ""}</div>`;
}

function agSkeleton(kind = "row") {
  return `<span class="ag-skeleton ag-skeleton-${esc(agChoice(kind, ["row", "art", "text"], "row"))}" role="status"><span class="sr-only">Loading</span></span>`;
}

function agEmptyState() {
  return `<section class="ag-empty"><p>${esc("Nothing followed yet.")}</p>${agButton({ label: "Find shows", variant: "secondary" })}</section>`;
}
