/* Afterglow Phase 3 primitives and the lab-only gallery.
   Each test names the production-line mutation used to prove it can fail. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const PRIMITIVES = read("ui/primitives.js");
const GALLERY = read("ui/gallery.js");
const CSS = read("ui/primitives.css");

function markupContext({ search = "?gallery=1", lab = false } = {}) {
  const ctx = vm.createContext({
    URLSearchParams,
    location: { search },
    esc: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])),
    safeUrl: (value) => typeof value === "string" && (/^https?:\/\//.test(value) || /^ui\/icons\.svg#i-[a-z0-9-]+$/.test(value)) ? value : "#",
    artUrl: (value, px) => `${value}?w=${px}`,
    isLabBuild: () => lab,
  });
  vm.runInContext(read("ui/icons.js"), ctx);
  vm.runInContext(PRIMITIVES, ctx);
  vm.runInContext(GALLERY, ctx);
  return ctx;
}

const run = (ctx, code) => vm.runInContext(code, ctx);

test("button primitives expose all five states without reducing a disabled control to colour", () => {
  /* MUTATION (run red): delete `["aria-disabled", disabled ? "true" : null]` in agButton(). */
  const ctx = markupContext();
  for (const state of ["default", "pressed", "focus", "disabled", "loading"]) {
    const html = run(ctx, `agButton({ label: "Save", variant: "primary", state: ${JSON.stringify(state)} })`);
    assert.match(html, new RegExp(`is-${state}`));
    assert.doesNotMatch(html, /style=|javascript:/i);
    if (state === "disabled") assert.match(html, /aria-disabled="true"[^>]*disabled/);
    if (state === "loading") {
      assert.match(html, /aria-busy="true"/);
      assert.match(html, /class="ag-spinner"/);
    }
  }
});

test("artwork routes sources through safeUrl and escapes every caller string", () => {
  /* MUTATION (run red): change `safeUrl(artUrl(src, px * 3))` to `safeUrl(src)`. */
  const ctx = markupContext();
  const hostile = run(ctx, `agArtwork({ name: "<img onerror='x'>", src: "javascript:alert(1)", size: 104 })`);
  assert.doesNotMatch(hostile, /javascript:|<img\s+onerror/i);
  assert.match(hostile, /&lt;img onerror=&#39;x&#39;&gt;/);
  const safe = run(ctx, `agArtwork({ name: "Safe", src: "https://example.com/art.jpg", size: 104 })`);
  assert.match(safe, /src="https:\/\/example\.com\/art\.jpg\?w=312"/);
});

test("play buttons expose the pressed state that matches their play or pause action", () => {
  /* MUTATION (run red): remove `pressed: playing` from agPlayButton(). */
  const ctx = markupContext();
  assert.match(run(ctx, "agPlayButton({ playing: true })"), /aria-label="Pause"[^>]*aria-pressed="true"/);
  assert.match(run(ctx, "agPlayButton({ playing: false })"), /aria-label="Play"[^>]*aria-pressed="false"/);
});

test("scrubber markup reports its value-derived time and keeps the zero thumb at full width", () => {
  /* MUTATION (run red): change `.ag .ag-scrubber.p0` to `.ag .p0` and add `width: 0`. */
  const ctx = markupContext();
  const zero = run(ctx, "agScrubber({ value: 0, duration: 2880 })");
  const halfway = run(ctx, "agScrubber({ value: 50, duration: 2880 })");
  assert.match(zero, /class="ag-scrubber p0 is-default"[^>]*><input[^>]*value="0"[^>]*aria-valuetext="0 min of 48 min"/);
  assert.doesNotMatch(zero, /aria-valuenow=/, "the native range value must remain the single numeric source of truth");
  assert.match(zero, /class="ag-scrub-thumb"/);
  assert.doesNotMatch(CSS, /\.ag \.p0\s*\{[^}]*width:\s*0/);
  assert.match(CSS, /\.ag \.ag-scrubber\.p0\s*\{\s*--ag-scrub-progress:\s*0%/);
  assert.match(halfway, /aria-valuetext="24 min of 48 min"/);
  assert.match(halfway, /<span class="time">24:00<\/span><span class="time">-24:00<\/span>/);
});

test("the scrubber uses native range keyboard semantics and updates its reported time on input", () => {
  /* MUTATION (run red): change `type="range"` to `type="text"` in agScrubber(). */
  const ctx = markupContext();
  const html = run(ctx, "agScrubber({ value: 42, duration: 2880 })");
  assert.match(html, /<input class="ag-scrub-input" type="range" role="slider" min="0" max="100" step="1" value="42"/);
  assert.match(PRIMITIVES, /root\.addEventListener\("input", agScrubberInput\)/);
  const handled = run(ctx, `(() => {
    const attrs = {};
    const times = [{ textContent: "" }, { textContent: "" }];
    const slider = {
      dataset: { agDuration: "2880" },
      style: { setProperty(name, value) { attrs[name] = value; } },
      querySelectorAll() { return times; },
    };
    const input = {
      value: "43",
      parentElement: slider,
      setAttribute(name, value) { attrs[name] = value; },
      closest() { return input; },
    };
    agScrubberInput({ target: input });
    return { attrs, value: input.value, times: times.map((time) => time.textContent) };
  })()`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(handled)), {
    attrs: { "aria-valuetext": "20 min 38 sec of 48 min", "--ag-scrub-progress": "43%" },
    value: "43",
    times: ["20:38", "-27:22"],
  });
});

test("the gallery renders every planned primitive family, interaction state and both schemes", () => {
  /* MUTATION (run red): delete the `scrubber drag` agGalleryState() expression from agGalleryControls(). */
  const html = run(markupContext(), "agGalleryMarkup()");
  for (const marker of [
    "Buttons · every state", "Controls", "Artwork and collages", "Rows · every state", "Cards and tiles",
    "Dock and tab bar", "Sheets, toast, loading and empty", "ag-icons", "data-theme=\"dusk\"", "data-theme=\"dawn\"",
  ]) assert.ok(html.includes(marker), `gallery includes ${marker}`);
  for (const state of ["default", "pressed", "focus", "disabled", "loading", "playing", "played", "downloaded", "unavailable"]) {
    assert.ok(html.includes(`is-${state}`), `gallery includes ${state}`);
  }
  assert.strictEqual((html.match(/data-ag-primitive="scrubber"/g) || []).length, 4, "default and drag scrubbers in both schemes");
  assert.strictEqual((html.match(/class="ag-scrubber[^"]*is-drag"[^>]*data-ag-primitive="scrubber"/g) || []).length, 2, "drag scrubber in both schemes");
  assert.strictEqual((html.match(/class="ag-mini-player is-drag"[^>]*data-ag-primitive="mini-player"/g) || []).length, 2, "drag mini-player in both schemes");
  assert.strictEqual((html.match(/class="ag-sheet is-drag[^"]*" data-ag-primitive="sheet"/g) || []).length, 2, "drag sheet in both schemes");
  assert.doesNotMatch(html, /style=|<script|javascript:/i);
});

test("all interactive primitive treatments keep a token-backed 44px minimum target", () => {
  /* MUTATION (run red): replace `.ag .ag-chip { min-height: var(--tap)` with `min-height: 36px`. */
  for (const selector of [".ag .ag-btn", ".ag .ag-chip", ".ag .ag-strip-bar", ".ag .ag-tab"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, selector);
    const block = match[0];
    assert.match(block, /min-(?:width|height): var\(--tap\)/, `${selector} uses --tap`);
  }
  assert.match(CSS, /\.ag \.ag-scrubber \{[^}]*min-height: calc\(var\(--tap\)/s);
  assert.match(CSS, /\.ag \.ag-scrub-input \{[^}]*height: var\(--tap\)/s);
});

test("the primitive stylesheet adds no second reduced-motion block and the token block covers its subtree", () => {
  /* MUTATION (run red): append `@media (prefers-reduced-motion: reduce) { .ag-btn { transition: none } }` to primitives.css. */
  assert.strictEqual((CSS.match(/prefers-reduced-motion/g) || []).length, 1, "only the explanatory header may name it here");
  const tokens = read("ui/tokens.css");
  assert.strictEqual((tokens.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1);
  assert.match(tokens, /\.ag \*, \.ag \*::before, \.ag \*::after/);
  assert.match(CSS, /animation: ag-spin var\(--m-ui\)/);
  assert.match(CSS, /transition: transform var\(--m-micro\)/);
});

test("the gallery route is authorized only by the lab flag or explicit query switch", () => {
  /* MUTATION (run red): change `return isLabBuild() || optedIn` to `return true`. */
  assert.strictEqual(run(markupContext({ search: "", lab: false }), "galleryAllowed()"), false);
  assert.strictEqual(run(markupContext({ search: "?gallery=1", lab: false }), "galleryAllowed()"), true);
  assert.strictEqual(run(markupContext({ search: "", lab: true }), "galleryAllowed()"), true);
  const app = read("app.js");
  assert.match(app, /h === "#\/gallery" && galleryAllowed\(\)\) renderGallery\(\)/);
});

test("sheet behavior moves focus in, traps it, closes on Escape and restores the opener", () => {
  /* MUTATION (run red): delete `if (first) first.focus()` from agGalleryOpenSheet(). */
  assert.match(GALLERY, /if \(first\) first\.focus\(\)/);
  assert.match(GALLERY, /event\.key === "Tab"[^\n]*agGalleryTrapFocus/);
  assert.match(GALLERY, /event\.key === "Escape"[^\n]*agGalleryCloseSheet/);
  assert.match(GALLERY, /agGallerySheetOpener\.focus\(\)/);
  assert.match(GALLERY, /child\.inert = true/);
  const gateConfig = read("tools/ui-lab/lib/gates/config.mjs");
  for (const theme of ["dusk", "dawn"]) {
    assert.match(gateConfig, new RegExp(`#ag-gallery-${theme}-sheet[^\n]+#ag-gallery-${theme}-sheet-open`));
  }
});

test("the page, service worker, web dist, native bundle and UI lab all carry the gallery system", () => {
  /* MUTATION (run red): delete `"ui/primitives.css"` from tools/web/prepare-dist.mjs. */
  const index = read("index.html");
  assert.match(index, /<link rel="stylesheet" href="ui\/primitives\.css">/);
  assert.ok(index.indexOf('src="ui/icons.js"') < index.indexOf('src="ui/primitives.js"'));
  assert.ok(index.indexOf('src="ui/primitives.js"') < index.indexOf('src="ui/gallery.js"'));
  assert.ok(index.indexOf('src="ui/gallery.js"') < index.indexOf('src="ui/boot.js"'));
  for (const rel of ["tools/ci/generate-manifest.mjs", "tools/web/prepare-dist.mjs", "tools/mobile/prepare-webdir.mjs"]) {
    assert.ok(read(rel).includes('"ui/primitives.css"'), `${rel} ships primitives.css`);
  }
  const states = read("tools/ui-lab/lib/states.mjs");
  assert.match(states, /id: "gallery"[\s\S]*route: "\?gallery=1#\/gallery"[\s\S]*ready: "\.ag-gallery"/);
});

test("the gallery baseline visits every visual plate in both schemes", () => {
  /* MUTATION (run red): delete `step("cards-tiles", ...)` from galleryCaptureSteps(). */
  const html = run(markupContext(), "agGalleryMarkup()");
  const states = read("tools/ui-lab/lib/states.mjs");
  const sections = ["glow", "buttons", "controls", "artwork", "rows", "cards", "navigation", "feedback", "icons"];
  const plates = [
    "glow", "buttons-top", "buttons-lower", "controls-top", "controls-lower", "artwork",
    "rows-default", "rows-active", "rows-edge", "rows-queue", "cards-hero", "cards-stretch-top",
    "cards-stretch-lower", "cards-foray", "cards-tiles", "navigation", "feedback", "icons", "icon-sizes", "sheet-open",
  ];
  for (const theme of ["dusk", "dawn"]) {
    assert.ok(html.includes(`id="ag-gallery-${theme}-scheme"`), `${theme} panel`);
    for (const section of sections) assert.ok(html.includes(`id="ag-gallery-${theme}-${section}"`), `${theme} ${section} section`);
  }
  for (const plate of plates.filter((name) => name !== "sheet-open")) {
    assert.ok(states.includes(`step("${plate}"`), `${plate} baseline plate`);
  }
  assert.ok(states.includes('label: `${theme}-sheet-open`'), "sheet-open baseline plate");
  assert.match(states, /\.\.\.galleryCaptureSteps\("dusk"\)[\s\S]*\.\.\.galleryCaptureSteps\("dawn"\)/);
});
