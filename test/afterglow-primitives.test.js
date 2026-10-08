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

test("the 44px row play button is outlined and unfilled", () => {
  /* MUTATION (run red): delete the `.ag-btn-play.ag-btn-size-44` override. */
  const html = run(markupContext(), "agPlayButton({ size: 44 })");
  assert.match(html, /class="ag-btn ag-btn-play ag-btn-size-44/);
  assert.match(CSS, /\.ag \.ag-btn-play\.ag-btn-size-44 \{[^}]*width: var\(--tap\);[^}]*height: var\(--tap\);[^}]*background: transparent;[^}]*box-shadow: inset/s);
});

test("current queue rows expose a visible Playing caption", () => {
  /* MUTATION (run red): replace the current-row `Playing` caption with an empty string. */
  const current = run(markupContext(), 'agQueueRow({ state: "current" })');
  assert.match(current, /<span class="ag-row-state">Playing<\/span>/);
  assert.match(current, /<p class="t-label clamp2">[\s\S]*?play-fill[\s\S]*?Cooling factories/);
  assert.strictEqual((current.match(/Playing/g) || []).length, 1);
});

test("detail strips render thumbnails and grow the current bar upward by four pixels", () => {
  /* MUTATION (run red): remove `ag-strip-thumbs` from the detail-strip markup. */
  const detail = run(markupContext(), 'agStrip({ size: "detail", current: 4 })');
  assert.match(detail, /class="ag-strip-thumbs"/);
  assert.match(CSS, /\.ag \.ag-strip-detail \.ag-strip-bar:not\(\.ag-tone-narration\)::after \{[^}]*width: var\(--s-5\);[^}]*height: var\(--s-5\);[^}]*background:/s);
  assert.match(CSS, /\.ag \.ag-strip-detail \.ag-strip-bar \{[^}]*align-items: flex-end/s);
  assert.match(CSS, /\.ag \.ag-strip-detail \.ag-strip-visual \{ height: var\(--s-6\); \}/);
  assert.match(CSS, /\.ag \.ag-strip-detail \.ag-strip-bar\.is-current > \.ag-strip-visual \{ height: calc\(var\(--s-6\) \+ var\(--s-1\)\); \}/);
  assert.doesNotMatch(CSS, /\.ag-strip-bar\.is-current[^}]*scaleY/);
});

test("SubjectTile exposes default and pressed states in the gallery", () => {
  /* MUTATION (run red): remove `agSubjectTile({ state: "pressed" })` from agGalleryCards(). */
  const ctx = markupContext();
  assert.match(run(ctx, 'agSubjectTile({ state: "pressed" })'), /ag-subject-tile raised is-pressed/);
  const gallery = run(ctx, "agGalleryMarkup()");
  assert.strictEqual((gallery.match(/<small>subject pressed<\/small><article class="ag-subject-tile raised is-pressed"/g) || []).length, 2, "pressed SubjectTile appears in Dusk and Dawn");
  assert.match(CSS, /\.ag \.ag-subject-tile\.is-pressed \{[^}]*background: var\(--bg2\);[^}]*box-shadow: inset/s);
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

/* Every `opacity` below 1 in primitives.css, outside @keyframes, as { selector, value }.
   Raw scan of the whole stylesheet (comments stripped), including rules nested in @media. */
function translucentRules(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out = [];
  for (const rule of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of rule[2].matchAll(/(?:^|;)\s*opacity:\s*([0-9.]+)/g)) {
      if (Number(decl[1]) < 1) out.push({ selector: rule[1].trim(), value: Number(decl[1]) });
    }
  }
  return out;
}

test("no primitive state dims real text: translucency is reserved for disabled controls and non-text parts", () => {
  /* Review blocker (ambient p3-primitives it2): `.is-loading .ag-row-copy { opacity: .55 }` and
     `.ag-stretch-card.is-loading { opacity: .7 }` composited text-2 to 3.15:1 (Dusk) and 2.51:1
     (Dawn), under AA. Disabled controls are exempt from WCAG 1.4.3; artwork, strip bars and the
     invisible native range input carry no text.
     MUTATION (run red): re-add `.ag .ag-episode-row.is-loading .ag-row-copy { opacity: .55; }`.
     MUTATION (run red): re-add `.ag .ag-stretch-card.is-loading { opacity: .7; }`. */
  const allowed = /is-disabled|:disabled|\.ag-art\.is-dim|\.ag-strip-visual|\.ag-scrub-input/;
  const rules = translucentRules(CSS);
  assert.ok(rules.length >= 4, "the scan sees the known translucent rules (disabled, dim art, strip, range input)");
  for (const { selector, value } of rules) {
    for (const part of selector.split(",")) {
      assert.match(part.trim(), allowed, `opacity ${value} on "${part.trim()}" dims real text`);
    }
  }
  assert.ok(translucentRules(".ag .x.is-loading .ag-row-copy { opacity: .55; }").length === 1, "the scanner itself finds a dimmed loading rule");
});

test("a loading row or card keeps its copy and shows the spinner on its own Play control", () => {
  /* MUTATION (run red): change `state: AG_BUSY[rowState]` to `state: "default"` in agEpisodeRow(). */
  const ctx = markupContext();
  for (const code of ['agEpisodeRow({ state: "loading" })', 'agStretchCard({ state: "loading" })']) {
    const html = run(ctx, code);
    const button = html.match(/<button[^>]*>[\s\S]*?<\/button>/g).pop();
    assert.match(button, /aria-busy="true"/, `${code} Play control is busy`);
    assert.match(button, /class="ag-spinner"/, `${code} Play control spins`);
    assert.doesNotMatch(button, /disabled/, `${code} Play control stays enabled`);
  }
  assert.match(run(ctx, 'agEpisodeRow({ state: "unavailable" })'), /aria-disabled="true"/);
  assert.match(run(ctx, 'agStretchCard({ state: "disabled" })'), /aria-disabled="true"/);
  assert.match(run(ctx, 'agStretchCard({ state: "<x>" })'), /class="ag-stretch-card raised is-default"/, "an unknown card state falls back to default");
});

test("an EpisodeRow state line sends its class modifier and caption through esc()", () => {
  /* Hard limit: every interpolation goes through esc(), even a value from a constant table
     (Codex review, ambient p3-primitives round 4). The recording esc() sees each value spliced.
     MUTATION (run red): change `${esc(line[0])}` to `${line[0]}` in agEpisodeRow().
     MUTATION (run red): change `${esc(line[2])}` to `${line[2]}` in agEpisodeRow(). */
  const ctx = markupContext();
  const realEsc = ctx.esc;
  const seen = [];
  ctx.esc = (value) => { seen.push(value); return realEsc(value); };
  const lines = run(ctx, "AG_ROW_LINES");
  assert.deepStrictEqual(Object.keys(lines).sort(), ["downloaded", "played", "playing", "unavailable"]);
  for (const [state, [modifier, , caption]] of Object.entries(lines)) {
    seen.length = 0;
    const html = run(ctx, `agEpisodeRow({ state: ${JSON.stringify(state)} })`);
    assert.ok(html.includes(`<span class="ag-row-state${modifier}">`), `${state}: state line rendered`);
    assert.ok(seen.includes(modifier), `${state}: modifier ${JSON.stringify(modifier)} went through esc()`);
    assert.ok(seen.includes(caption), `${state}: caption ${JSON.stringify(caption)} went through esc()`);
  }
  ctx.esc = realEsc;
});

test("a loading control swaps its glyph for the spinner instead of crowding both into one circle", () => {
  /* MUTATION (run red): restore `>${iconMarkup}${text}${busy ? '<span class="ag-spinner" ...>' : ""}` in agButton(). */
  const ctx = markupContext();
  const icon = run(ctx, 'agButton({ label: "Share", variant: "icon", icon: "share", state: "loading" })');
  assert.match(icon, /class="ag-spinner"/);
  assert.doesNotMatch(icon, /<svg class="icon/, "no glyph beside the spinner in a 44px circle");
  assert.match(run(ctx, 'agButton({ label: "Share", variant: "icon", icon: "share" })'), /<svg class="icon/);
  assert.match(run(ctx, 'agButton({ label: "Save", variant: "primary", state: "loading" })'), /class="ag-spinner"[^<]*<\/span><span>Save<\/span>/);
});

test("the spinner fills the 24px glyph slot, so an icon or play control does not change width when it starts loading", () => {
  /* Scope: a glyph-bearing control swaps glyph for spinner at the same size. A text-only
     button has no glyph to replace, so it gains the spinner and may widen (Codex round-5 nit). */
  /* MUTATION (run red): change `.ag .ag-spinner { width: var(--s-6); height: var(--s-6);` back to `--s-4`. */
  assert.match(CSS, /\.ag \.ag-spinner \{ width: var\(--s-6\); height: var\(--s-6\);/);
  assert.match(read("ui/tokens.css"), /--s-6: 24px;/);
  assert.match(read("ui/icons.js"), /size === undefined \? 24 : size/, "the default glyph the spinner replaces is 24px");
});

test("a buffering MiniPlayer keeps its Play glyph breathing and marks the group busy", () => {
  /* BUILD-NOTES §3: buffering = glyph opacity breathes 1.0 -> 0.85; no spinner.
     MUTATION (run red): pass `state: miniState === "buffering" ? "loading" : "default"` to agPlayButton() again. */
  const html = run(markupContext(), 'agMiniPlayer({ state: "buffering" })');
  assert.match(html, /class="ag-mini-player is-buffering"[^>]*aria-busy="true"/);
  assert.doesNotMatch(html, /ag-spinner/);
  assert.match(html, /ag-btn-play[^>]*>\s*<svg class="icon[^"]*"[^>]*><use href="ui\/icons\.svg#i-play"/);
  assert.doesNotMatch(run(markupContext(), 'agMiniPlayer({ state: "playing" })'), /aria-busy/);
  assert.match(CSS, /\.ag \.ag-mini-player\.is-buffering \.ag-btn-play \.icon \{ animation: ag-breathe/);
});

test("under Reduce Motion the buffering glyph holds at 0.9 instead of snapping back to full", () => {
  /* BUILD-NOTES §5 motion table: Buffering breathe, reduced = "static at 0.9". The one reduce
     block cuts every animation to 1ms x1 with no fill, so without this rule the glyph ends at 1
     and a Reduce Motion listener sees no buffering cue at all (Codex review, round 5).
     MUTATION (run red): delete `.ag .ag-mini-player.is-buffering .ag-btn-play .icon { opacity: .9; }` from ui/tokens.css. */
  const tokens = read("ui/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = tokens.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(start >= 0, "the reduce block exists");
  let depth = 0, end = start;
  for (let i = tokens.indexOf("{", start); i < tokens.length; i++) {
    if (tokens[i] === "{") depth++;
    if (tokens[i] === "}" && --depth === 0) { end = i; break; }
  }
  const block = tokens.slice(start, end);
  assert.match(block, /\.ag \.ag-mini-player\.is-buffering \.ag-btn-play \.icon \{ opacity: \.9; \}/, "the static buffering opacity lives inside the reduce block");
  assert.match(CSS, /\.ag \.ag-mini-player\.is-buffering \.ag-btn-play \.icon \{ animation: ag-breathe/, "and targets the element the breathe animates");
});

test("a disabled chip is visibly disabled, not only announced", () => {
  /* BUILD-PLAN 1.3: disabled = 40% + aria-disabled. The gallery's disabled chip used to render
     identical to the default one.
     MUTATION (run red): delete `.ag .ag-chip:disabled { opacity: .4; }`. */
  assert.match(run(markupContext(), 'agChip("Science", { disabled: true })'), /aria-disabled="true" disabled/);
  assert.match(CSS, /\.ag \.ag-chip:disabled \{ opacity: \.4; \}/);
});

test("primitive and gallery sources carry no mojibake", () => {
  /* The HeroPick caption shipped as "4 shows Â· 42 min" (a UTF-8 middle dot read as Latin-1).
     MUTATION (run red): put `Â·` back in agHeroPick()'s caption. */
  for (const [name, text] of [["ui/primitives.js", PRIMITIVES], ["ui/gallery.js", GALLERY], ["ui/primitives.css", CSS]]) {
    assert.doesNotMatch(text, /Â|â€|Ã/, `${name} has a double-encoded character`);
  }
  assert.match(run(markupContext(), "agHeroPick()"), /<p class="t-caption">4 shows · 42 min<\/p>/);
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
