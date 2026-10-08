/* Redesign 2026, Phase 3, task "tokens": the Dial (Tactile) foundation layer.
 *
 * What this pins, and what it deliberately does not.
 *
 *   PINS: the three self-hosted faces (files, budgets, the metrics the shipped
 *   bytes carry, names, axes), every token value in docs/redesign-2026/
 *   directions/tactile/BUILD-PLAN.md section 1 and BUILD-NOTES.md section 2, the
 *   two authored schemes (same names, dark declared twice and identical, the
 *   explicit light override beats the OS), WCAG AA for every text/background
 *   pair in both schemes (computed from the declared hex, not from a table in
 *   this file), the name rule that keeps the layer from moving a live screen,
 *   and the ONE reduced-motion block.
 *
 *   DOES NOT PIN: any screen. No live rule reads this layer yet, so the legacy
 *   half of test/ui-tokens.test.js still describes what the app paints and is
 *   unchanged (its ownership checks now judge the sheet without the Dial
 *   section). The rulings the plan lists as falling with this PR (U-01 dark-only,
 *   palette and type, card anatomy, no zoom) fall screen by screen in Phase 4:
 *   the Dial scheme tests below are the new guarantee, and each screen's PR
 *   retires the legacy pins for the token it stops reading.
 *
 * MUTATIONS (each run and seen red; the one-line edit is in each test's comment):
 *   - `--ink-3` -> #8A8278 (contrast); `--tap` -> 40px (size table);
 *   - rename `--dial-line` to `--line` (name rule); prefix `--paper` as
 *     `--dial-paper` (gratuitous prefix);
 *   - drop `:not([data-theme="light"])` from the OS-dark selector (explicit
 *     light loses to the OS); change one value in the `[data-theme="dark"]`
 *     copy (the two dark blocks differ);
 *   - point a @font-face at https://... (self-hosting); copy the prototype's
 *     uninstanced big-shoulders-latin.woff2 over dial-display-latin.woff2
 *     (metrics, axes, budget); set `--w-body: 800` (weight ceiling);
 *   - add `transition: transform .2s` to a rule with no reduced-motion entry,
 *     or delete `.sheet` from the block (motion).
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource } = require("./helpers/app-source.js");
const { ROOT, splitDialSection, parseRules, describeFont } = require("./helpers/dial-css.js");

const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const { dial: DIAL_CSS, legacy: LEGACY_CSS } = splitDialSection(CSS);
const DIAL = parseRules(DIAL_CSS);
const LEGACY = parseRules(LEGACY_CSS);
const ALL = parseRules(CSS);

const norm = (v) => v.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
const isReduce = (a) => /prefers-reduced-motion:\s*reduce/.test(a);

function declsOf(rules, selector, atRule) {
  const out = new Map();
  for (const r of rules) {
    if (r.at || !r.selectors.includes(selector)) continue;
    if (atRule ? !r.atRules.some((a) => a.includes(atRule)) : r.atRules.length) continue;
    for (const d of r.decls) out.set(d.prop, norm(d.value));
  }
  return out;
}

const CREAM = declsOf(DIAL, ":root");
const BAKELITE_OS = declsOf(DIAL, ':root:not([data-theme="light"])', "prefers-color-scheme: dark");
const BAKELITE_ATTR = declsOf(DIAL, ':root[data-theme="dark"]');
const LIGHT_ATTR = declsOf(DIAL, ':root[data-theme="light"]');  /* must stay empty: see the color-scheme test */

/* ------------------------------------------------------------------ fonts */

const FONT_FILES = {
  DialDisplay: { file: "fonts/dial-display-latin.woff2", weight: "700 800", maxBytes: 60 * 1024 },
  DialText: { file: "fonts/dial-text-latin.woff2", weight: "500 700", maxBytes: 80 * 1024 },
  Azeret: { file: "fonts/azeret-mono-latin.woff2", weight: "100 900", maxBytes: 26164 },
};

function faces() {
  return DIAL.filter((r) => r.at === "@font-face").map((r) => {
    const get = (p) => (r.decls.find((d) => d.prop === p) || {}).value;
    return {
      family: (get("font-family") || "").replace(/["']/g, ""),
      src: /url\(["']?([^"')]+)["']?\)/.exec(get("src") || "")?.[1],
      weight: get("font-weight"),
      display: get("font-display"),
      ascent: get("ascent-override"),
      descent: get("descent-override"),
    };
  });
}

test("three self-hosted faces: DialDisplay, DialText, Azeret, local files, swap, within budget", () => {
  /* MUTATION: point one src at https://fonts.gstatic.com/... -> red (self-hosting);
     delete a file -> red; add 10 KB of padding to dial-display -> red (budget). */
  const got = faces();
  assert.deepStrictEqual(got.map((f) => f.family).sort(), Object.keys(FONT_FILES).sort(),
    "exactly the three Dial faces are declared (Anybody, Dela, Archivo and the font switcher are gone)");
  for (const f of got) {
    const want = FONT_FILES[f.family];
    assert.strictEqual(f.src, want.file, `${f.family} src`);
    assert.ok(/^fonts\/[\w-]+\.woff2$/.test(f.src), `${f.family} is self-hosted (font-src 'self'), never a remote URL`);
    assert.strictEqual(f.weight, want.weight, `${f.family} font-weight range`);
    assert.strictEqual(f.display, "swap", `${f.family} font-display`);
    const abs = path.join(ROOT, f.src);
    assert.ok(fs.existsSync(abs), `${f.src} is declared but not on disk`);
    const size = fs.statSync(abs).size;
    assert.ok(size <= want.maxBytes, `${f.src} is ${size} bytes, budget ${want.maxBytes}`);
  }
});

test("DialDisplay is the re-cut Big Shoulders: ascent 84% and descent 24% in the bytes, not only in CSS", () => {
  /* WebKit ignores @font-face ascent-override, so the iPhone build only matches
     if hhea / OS-2 carry the metrics (critique-r7 P3.1). MUTATION: copy
     docs/redesign-2026/directions/tactile/prototype/fonts/big-shoulders-latin.woff2
     over fonts/dial-display-latin.woff2 -> ascent 1971 and a wght 100-900 axis: red. */
  const f = describeFont(path.join(ROOT, FONT_FILES.DialDisplay.file));
  assert.strictEqual(f.upm, 2000);
  assert.deepStrictEqual(f.hhea, { ascent: 1680, descent: -480, lineGap: 0 }, "hhea = 84% / 24% of the em");
  assert.deepStrictEqual(f.typo, { ascent: 1680, descent: -480, lineGap: 0 }, "OS/2 typo agrees with hhea");
  assert.deepStrictEqual(f.win, { ascent: 1680, descent: 480 }, "OS/2 win agrees (Windows)");
  assert.deepStrictEqual(f.axes.wght, { min: 700, def: 700, max: 800 }, "instanced to wght 700-800");
  assert.deepStrictEqual(f.axes.opsz && [f.axes.opsz.min, f.axes.opsz.max], [10, 72], "opsz axis kept");
  assert.deepStrictEqual([...f.names[1]], ["DialDisplay"], "renamed: a Modified Version ships under a new name");
  const face = faces().find((x) => x.family === "DialDisplay");
  assert.strictEqual(face.ascent, "84%");
  assert.strictEqual(face.descent, "24%", "the CSS override stays for engines that read it");
});

test("DialText is Bricolage instanced to wght 500-700, width pinned, renamed; Azeret is untouched", () => {
  /* MUTATION: copy the prototype's bricolage-grotesque-latin.woff2 over
     fonts/dial-text-latin.woff2 -> a wdth axis and wght 200-800 appear: red. */
  const t = describeFont(path.join(ROOT, FONT_FILES.DialText.file));
  assert.deepStrictEqual([t.axes.wght.min, t.axes.wght.max], [500, 700]);
  assert.strictEqual(t.axes.wdth, undefined, "wdth pinned at 100: no width axis ships");
  assert.ok(t.axes.opsz, "opsz kept so text sizes get their own cut");
  assert.deepStrictEqual([...t.names[1]], ["DialText"]);
  const proto = path.join(ROOT, "docs/redesign-2026/directions/tactile/prototype/fonts/azeret-mono-latin.woff2");
  assert.ok(fs.readFileSync(path.join(ROOT, FONT_FILES.Azeret.file)).equals(fs.readFileSync(proto)),
    "Azeret is not modified, so it keeps its name and its bytes");
  assert.ok(fs.existsSync(path.join(ROOT, "fonts/LICENSES.md")), "the OFL notice travels with the fonts");
});

/* ----------------------------------------------------------------- tokens */

/* The spec, written out independently of styles.css. Source: BUILD-PLAN 1.1-1.4,
   BUILD-NOTES 2.1-2.5, with two measured corrections (see BUILD-PLAN 1.8). */
const STRUCTURAL = {
  "--dial-font-display": '"DialDisplay", system-ui, sans-serif',
  "--font-text": '"DialText", system-ui, sans-serif',
  "--font-mono": '"Azeret", ui-monospace, monospace',
  "--t-display-xl": "2.75rem", "--lh-display-xl": "3rem", "--w-display": "800", "--wd-display": "100%", "--tracking-display": "0.005em",
  "--t-display": "2.25rem", "--lh-display": "2.5rem",
  "--t-title": "1.625rem", "--lh-title": "1.875rem", "--w-title": "750", "--wd-title": "100%", "--tracking-title": "0.01em",
  "--t-heading": "1.375rem", "--lh-heading": "1.625rem", "--w-heading": "750", "--wd-heading": "100%", "--tracking-heading": "0.01em",
  "--wd-screen": "100%", "--tracking-screen": "0.005em",
  "--t-body-lg": "1.0625rem", "--lh-body-lg": "1.5rem", "--w-body": "500",
  "--t-body": "0.9375rem", "--lh-body": "1.3125rem",
  "--t-label": "0.8125rem", "--lh-label": "1rem", "--w-label": "700", "--tracking-label": "0",
  "--t-micro": "0.75rem", "--lh-micro": "1rem", "--w-micro": "600",
  "--t-readout-lg": "1.75rem", "--lh-readout-lg": "2rem", "--w-readout": "500",
  "--t-readout": "0.8125rem", "--lh-readout": "1rem",
  "--s-1": "4px", "--s-2": "8px", "--s-3": "12px", "--s-4": "16px", "--s-5": "20px",
  "--s-6": "24px", "--s-8": "32px", "--s-10": "40px", "--s-12": "48px",
  "--gap": "12px",
  "--r-sm": "8px", "--r-md": "14px", "--r-lg": "22px", "--r-pill": "999px",
  "--tap": "44px",
  "--key": "48px", "--key-lg": "56px", "--key-xl": "80px", "--key-glance": "96px",
  "--row-show": "56px", "--row-queue": "64px", "--row-episode": "72px",
  "--art-row": "56px", "--art-queue": "48px", "--art-mini": "44px", "--art-disc": "40px",
  "--deck-h": "64px", "--mini-h": "64px",
  "--safe-t": "env(safe-area-inset-top, 0px)", "--safe-b": "env(safe-area-inset-bottom, 0px)",
  "--lip": "3px", "--lip-pressed": "1px",
  "--deck-tint": "color-mix(in srgb, var(--card) 84%, transparent)",
  "--deck-blur": "blur(20px) saturate(1.3)",
  "--spring-snap": "linear(0, 0.01 2%, 0.06 4.4%, 0.25 9%, 0.56 14.5%, 0.84 20%, 1.02 26%, 1.08 31%, 1.07 36%, 1.03 44%, 1 52%, 0.99 60%, 1 70%, 1)",
  "--spring-settle": "linear(0, 0.02 3%, 0.11 8%, 0.32 15%, 0.58 24%, 0.78 33%, 0.9 43%, 0.96 55%, 0.99 70%, 1 85%, 1)",
  "--spring-sheet": "linear(0, 0.01 2%, 0.07 6%, 0.24 13%, 0.52 22%, 0.78 32%, 0.95 42%, 1.03 52%, 1.04 60%, 1.02 70%, 1 82%, 1)",
  "--ease-quick": "cubic-bezier(.2, .8, .2, 1)", "--ease-draw": "cubic-bezier(.4, 0, .2, 1)",
  "--d-snap": "220ms", "--d-settle": "320ms", "--d-sheet": "480ms", "--d-quick": "160ms", "--d-draw": "280ms",
  "--d-buffer": "1000ms", "--d-skeleton": "1200ms",
};

const CREAM_SCHEME = {
  "--paper": "#F7F0E4", "--paper-2": "#EFE6D6", "--card": "#FFFDF8",
  "--ink": "#1E1A16", "--ink-2": "#5C544B", "--ink-3": "#6C645A",
  "--dial-line": "#E2D8C6", "--rubber": "#2A2520", "--rubber-lip": "#15110E", "--on-rubber": "#F7F0E4",
  "--persimmon": "#C93F14", "--persimmon-lip": "#8E2B0C", "--persimmon-soft": "#F6D9CD",
  "--ultramarine": "#2B45C8", "--ultramarine-lip": "#1C2F8F", "--ultramarine-soft": "#D9DEF7",
  "--good": "#1F7A3E", "--warn": "#9A5B00",
  "--on-persimmon": "#FFFFFF", "--on-ultramarine": "#FFFFFF",
  "--dial-seg-c0": "#1E8C7E", "--dial-seg-c1": "#C93F14", "--dial-seg-c2": "#2B45C8", "--dial-seg-c3": "#A67A08",
  "--dial-seg-c4": "#7A3E8F", "--dial-seg-c5": "#4F7F2E", "--dial-seg-c6": "#2E7FB8", "--dial-seg-c7": "#B5406E",
  "--dial-seg-narration": "var(--ultramarine)",
  "--scrim-np": "rgba(247, 240, 228, 0.78)",
  "--shadow-card": "0 1px 0 rgba(30, 26, 22, 0.06), 0 8px 24px -12px rgba(30, 26, 22, 0.25)",
  "--shadow-deck": "0 1px 0 rgba(30, 26, 22, 0.08), 0 16px 40px -16px rgba(30, 26, 22, 0.35)",
  "--well-inset": "inset 0 2px 4px rgba(30, 26, 22, 0.12), inset 0 0 0 1px rgba(30, 26, 22, 0.06)",
};

const BAKELITE_SCHEME = {
  "--paper": "#17130F", "--paper-2": "#1F1A15", "--card": "#241E18",
  "--ink": "#F4ECDF", "--ink-2": "#BDB2A3", "--ink-3": "#948979",
  "--dial-line": "#332B24", "--rubber": "#3A332C", "--rubber-lip": "#120E0B", "--on-rubber": "#F4ECDF",
  "--persimmon": "#FF6A3A", "--persimmon-lip": "#B8431E", "--persimmon-soft": "#4A2A1E",
  "--ultramarine": "#8EA0FF", "--ultramarine-lip": "#5566C8", "--ultramarine-soft": "#26305A",
  "--good": "#5CC57A", "--warn": "#E0A14A",
  "--on-persimmon": "#1E1A16", "--on-ultramarine": "#1E1A16",
  "--dial-seg-c0": "#3FB9A8", "--dial-seg-c1": "#FF6A3A", "--dial-seg-c2": "#8EA0FF", "--dial-seg-c3": "#E0B33A",
  "--dial-seg-c4": "#B57BCB", "--dial-seg-c5": "#7FB85A", "--dial-seg-c6": "#5FAEE6", "--dial-seg-c7": "#E06A98",
  "--scrim-np": "rgba(23, 19, 15, 0.72)",
  "--shadow-card": "0 1px 0 rgba(0, 0, 0, 0.4), 0 8px 24px -12px rgba(0, 0, 0, 0.6)",
  "--shadow-deck": "0 1px 0 rgba(0, 0, 0, 0.5), 0 16px 40px -16px rgba(0, 0, 0, 0.7)",
  "--well-inset": "inset 0 2px 4px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.04)",
};

const toObj = (m) => Object.fromEntries(m);
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const pick = (m, keys) => Object.fromEntries(keys.map((k) => [k, m.get(k)]));

test("Cream and the structural tokens are exactly the spec: no missing, no extra, no drift", () => {
  /* MUTATION: `--tap: 44px` -> 40px (or any one value) -> red, naming the token;
     add a stray `--foo: 1px` to the Dial :root -> red (no extras). */
  assert.deepStrictEqual(sorted(toObj(CREAM)), sorted({ ...STRUCTURAL, ...CREAM_SCHEME }));
});

test("Bakelite redeclares exactly the scheme-dependent tokens, under the OS query and under data-theme", () => {
  /* MUTATION: drop `:not([data-theme="light"])` from the OS block -> red (an
     explicit Light choice would lose to an OS set to dark). Change one value in
     the [data-theme="dark"] copy -> red (the two dark blocks differ). */
  assert.deepStrictEqual(sorted(toObj(BAKELITE_OS)), sorted(BAKELITE_SCHEME), "the OS-dark block");
  assert.deepStrictEqual(sorted(toObj(BAKELITE_ATTR)), sorted(BAKELITE_SCHEME), "the [data-theme=dark] block, identical");
  assert.strictEqual(DIAL.filter((r) => r.selectors.includes(':root:not([data-theme="light"])')).length, 1);
  assert.deepStrictEqual(toObj(LIGHT_ATTR), {},
    "[data-theme=light] declares nothing: its colours are the :root Cream values");
});

test("the Dial section declares no color-scheme anywhere (index.html's dark-only meta must keep applying)", () => {
  /* index.html ships <meta name="color-scheme" content="dark">, which only takes effect while the root's
     computed color-scheme is `normal`. A `color-scheme` on :root (or on a :root scheme block) makes the
     viewport scrollbar and every UA surface follow the OS instead: light on the dark #151119 page.
     The PR that drops the meta and paints Cream on a screen adds it back, with this test.
     MUTATION: add `color-scheme: light dark;` to the Dial `:root` (or `color-scheme: dark;` to either
     Bakelite block) -> red here, and the whole-sheet guard in test/ui-tokens.test.js goes red too. */
  const hits = DIAL.filter((r) => !r.at && r.decls.some((d) => d.prop === "color-scheme"))
    .map((r) => r.selectors.join(", "));
  assert.deepStrictEqual(hits, []);
});

test("every literal colour Cream declares is re-owned by Bakelite (a scheme cannot leak a value into the other)", () => {
  /* MUTATION: delete `--warn` from both dark blocks -> red naming --warn. */
  const literal = (v) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v);
  const mustFlip = [...CREAM].filter(([, v]) => literal(v)).map(([k]) => k);
  const missing = mustFlip.filter((k) => !BAKELITE_OS.has(k) || !BAKELITE_ATTR.has(k));
  assert.deepStrictEqual(missing, []);
  const same = mustFlip.filter((k) => CREAM.get(k) === BAKELITE_OS.get(k));
  assert.deepStrictEqual(same, [], "a token that reads the same in both schemes is not scheme-dependent; take it out of the dark blocks");
});

test("the deck falls back to solid card where translucency is off or unsupported", () => {
  /* MUTATION: delete the @supports block -> red. */
  const rt = declsOf(DIAL, ":root", "prefers-reduced-transparency");
  assert.strictEqual(rt.get("--deck-tint"), "var(--card)");
  assert.strictEqual(rt.get("--deck-blur"), "none");
  assert.strictEqual(declsOf(DIAL, ":root", "@supports not (backdrop-filter: blur(1px))").get("--deck-tint"), "var(--card)");
});

test("the Now Playing tint is a registered colour that starts at paper", () => {
  /* MUTATION: change the @property initial-value -> red. */
  const prop = DIAL.find((r) => r.at === "@property --np-tint");
  assert.ok(prop, "@property --np-tint");
  const get = (p) => prop.decls.find((d) => d.prop === p).value;
  assert.strictEqual(get("syntax").replace(/["']/g, ""), "<color>");
  assert.strictEqual(get("initial-value"), CREAM.get("--paper"));
});

/* --------------------------------------------------------------- contrast */

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/* [foreground, background, minimum, why]. 4.5 for text, 3 for components, large
   text and icons (BUILD-NOTES 2.2). The BUILD-NOTES table's first nine rows are
   here, plus the pairs it left implicit: secondary text on a card and on a well
   (paper-2) and persimmon / ultramarine on a card. Segment enamels are bars: 3:1
   on the well, 3.5:1 in Bakelite as the notes say. */
const PAIRS = [
  ["--ink", "--paper", 4.5], ["--ink", "--card", 4.5], ["--ink", "--paper-2", 4.5],
  ["--ink-2", "--paper", 4.5], ["--ink-2", "--card", 4.5], ["--ink-2", "--paper-2", 4.5],
  ["--ink-3", "--paper", 4.5], ["--ink-3", "--card", 4.5], ["--ink-3", "--paper-2", 4.5],
  ["--on-rubber", "--rubber", 4.5], ["--on-persimmon", "--persimmon", 4.5], ["--on-ultramarine", "--ultramarine", 4.5],
  ["--persimmon", "--paper", 3], ["--persimmon", "--card", 3], ["--persimmon", "--paper-2", 3],
  ["--ultramarine", "--paper", 4.5], ["--ultramarine", "--card", 4.5],
  ["--good", "--paper", 4.5], ["--warn", "--paper", 4.5],
  ...Array.from({ length: 8 }, (_, i) => [`--dial-seg-c${i}`, "--paper-2", 3]),
];

for (const [scheme, tokens] of [["Cream", { ...toObj(CREAM) }], ["Bakelite", { ...toObj(CREAM), ...toObj(BAKELITE_OS) }]]) {
  test(`WCAG AA, ${scheme}: every text and UI pair clears its threshold`, () => {
    /* MUTATION: `--on-rubber` -> #17130F makes Bakelite's rubber key 1.49:1;
       `--ink-3` -> #8A8278 puts the Cream rows under 4.5 (and
       `--dial-seg-c3` -> #B8860B, the notes' original mustard, fails the well
       row at 2.63:1: the table in BUILD-NOTES overstated it). */
    const fails = [];
    for (const [fg, bg, min] of PAIRS) {
      const [a, b] = [tokens[fg], tokens[bg]];
      assert.ok(/^#[0-9a-f]{6}$/i.test(a) && /^#[0-9a-f]{6}$/i.test(b), `${fg}/${bg} are literal hex in ${scheme}`);
      const need = scheme === "Bakelite" && fg.startsWith("--dial-seg") ? 3.5 : min;
      const got = ratio(a, b);
      if (got < need) fails.push(`${fg} ${a} on ${bg} ${b}: ${got.toFixed(2)}:1 < ${need}`);
    }
    assert.deepStrictEqual(fails, []);
  });
}

/* ---------------------------------------------------------------- the name rule */

const jsWrites = new Set([...readAppSource().matchAll(/setProperty\(\s*["'](--[\w-]+)["']/g)].map((m) => m[1]));
const legacyNames = new Set();
/* The reduce-motion block is shared (it collapses the Dial duration tokens), so
   what it declares is not a legacy owner. */
for (const r of LEGACY) {
  if (r.atRules.some(isReduce)) continue;
  for (const d of r.decls) if (d.prop.startsWith("--")) legacyNames.add(d.prop);
}
for (const n of jsWrites) legacyNames.add(n);
const dialNames = new Set([...CREAM.keys(), ...BAKELITE_OS.keys()].filter((k) => k.startsWith("--")));

test("no Dial token redeclares a name a legacy token owns, so declaring the layer cannot move a live screen", () => {
  /* MUTATION: rename `--dial-line` to `--line` in the Dial block -> red naming
     --line (the legacy sheet and every `body.ui-v2` page read their own --line). */
  const clash = [...dialNames].filter((n) => legacyNames.has(n));
  assert.deepStrictEqual(clash, [], "a Dial token with a legacy-owned name ships as --dial-<name>");
  assert.ok(legacyNames.has("--gutter") && !dialNames.has("--gutter"),
    "--gutter is the plan's 16px and the legacy token already carries it: not declared twice");
  const legacyGutter = declsOf(LEGACY, ":root").get("--gutter");
  assert.strictEqual(legacyGutter, "16px", "the legacy token still has the plan's value");
});

test("the --dial- prefix is used only where a legacy token owns the bare name", () => {
  /* MUTATION: rename `--paper` to `--dial-paper` -> red (nothing legacy owns
     --paper; the prefix would be noise that every Phase 4 screen has to learn). */
  const gratuitous = [...dialNames].filter((n) => n.startsWith("--dial-") && !legacyNames.has(`--${n.slice(7)}`));
  assert.deepStrictEqual(gratuitous, []);
  const prefixed = [...dialNames].filter((n) => n.startsWith("--dial-")).sort();
  assert.deepStrictEqual(prefixed, [
    "--dial-font-display", "--dial-line",
    ...Array.from({ length: 8 }, (_, i) => `--dial-seg-c${i}`), "--dial-seg-narration",
  ].sort(), "the full set of collisions, so a new one is a decision");
});

/* ------------------------------------------------------------------- type */

test("type roles read their own tokens, in rem, with the weight ceilings and no uppercase", () => {
  /* MUTATION: `--w-body: 500` -> 800 -> red (text face ceiling 700); change
     `--t-body` to 14px -> red (rem, and body never below 15px); add
     `text-transform: uppercase` to any Dial rule -> red. */
  const roles = {
    ".display-xl": ["--t-display-xl", "--lh-display-xl", "--w-display", "--wd-display", "--tracking-display"],
    ".display": ["--t-display", "--lh-display", "--w-display", "--wd-display", "--tracking-display"],
    ".title": ["--t-title", "--lh-title", "--w-title", "--wd-title", "--tracking-title"],
    ".heading": ["--t-heading", "--lh-heading", "--w-heading", "--wd-heading", "--tracking-heading"],
  };
  for (const [sel, toks] of Object.entries(roles)) {
    const d = declsOf(DIAL, sel);
    assert.strictEqual(d.get("font-family"), "var(--dial-font-display)", `${sel} family`);
    const joined = [...d.values()].join(" ");
    for (const t of toks) assert.ok(joined.includes(`var(${t})`), `${sel} does not read ${t}`);
  }
  for (const sel of [".readout", ".readout-lg"]) {
    const d = declsOf(DIAL, sel);
    assert.ok(/var\(--font-mono\)/.test(d.get("font")), `${sel} is the mono face`);
    assert.strictEqual(d.get("font-variant-numeric"), "tabular-nums", `${sel} is tabular`);
  }
  for (const [k, v] of CREAM) {
    if (/^--t-/.test(k)) assert.ok(/^[\d.]+rem$/.test(v), `${k} is in rem (${v})`);
  }
  const px = (k) => parseFloat(CREAM.get(k)) * 16;
  assert.ok(px("--t-body") >= 15 && px("--t-body-lg") >= 15, "body is never below 15px");
  for (const k of ["--w-display", "--w-title", "--w-heading"]) assert.ok(+CREAM.get(k) <= 800, `${k} <= 800`);
  for (const k of ["--w-body", "--w-label", "--w-micro", "--w-readout"]) assert.ok(+CREAM.get(k) <= 700, `${k} <= 700 (DialText ceiling)`);
  assert.ok(!/text-transform\s*:\s*uppercase/i.test(DIAL_CSS), "no uppercase anywhere in the layer");
});

/* ----------------------------------------------------------------- motion */

test("the sheet has exactly one reduced-motion block, last, that collapses every Dial duration and spring", () => {
  /* MUTATION: delete `.sheet { transition-property: opacity; }` -> red; change
     `--d-quick: 120ms` -> 1ms -> red; add a second `@media (prefers-reduced-motion`
     block anywhere -> red. */
  const blocks = ALL.filter((r) => r.atRules.some(isReduce));
  assert.strictEqual(new Set(blocks.map((r) => r.atRules.join("|"))).size, 1, "one block");
  assert.strictEqual((CSS.match(/@media\s*\(\s*prefers-reduced-motion/g) || []).length, 1, "one @media in the file, comments aside");
  assert.ok(ALL[ALL.length - 1].atRules.some(isReduce), "it sits LAST so it outranks every rule it names");

  const root = declsOf(ALL, ":root", "prefers-reduced-motion");
  assert.deepStrictEqual(sorted(toObj(root)), sorted({
    "--d-snap": "1ms", "--d-settle": "1ms", "--d-sheet": "1ms", "--d-draw": "1ms", "--d-quick": "120ms",
    "--spring-snap": "linear(0, 1)", "--spring-settle": "linear(0, 1)", "--spring-sheet": "linear(0, 1)",
  }));
  assert.strictEqual(declsOf(ALL, ".keycap:active", "prefers-reduced-motion").get("transform"), "none");
  /* The lip counter-translates on press, so reduced motion must still the lip AND the face at the
     press rules' own specificity (a bare `.keycap:active` loses to `:active:not(:disabled)`).
     MUTATION: delete `.keycap:active:not(:disabled)::after` from the block -> the lip still drops. */
  for (const sel of [".keycap:active:not(:disabled)", ".keycap:active:not(:disabled)::after", ".keycap[data-pressed=\"true\"]::after"]) {
    assert.strictEqual(declsOf(ALL, sel, "prefers-reduced-motion").get("transform"), "none", `${sel} does not move under reduced motion`);
  }
  const draw = declsOf(ALL, ".band[data-draw]", "prefers-reduced-motion");
  assert.strictEqual(draw.get("stroke-dashoffset"), "0");
  assert.strictEqual(draw.get("animation"), "none");
  assert.strictEqual(declsOf(ALL, ".sheet", "prefers-reduced-motion").get("transition-property"), "opacity");
  const vt = ALL.find((r) => r.selectors.includes("::view-transition-group(*)") && r.atRules.some(isReduce));
  assert.ok(vt && vt.selectors.includes("::view-transition-old(*)") && vt.selectors.includes("::view-transition-new(*)"));
  assert.strictEqual(vt.decls.find((d) => d.prop === "animation-duration").value, "1ms");
});

test("every animation and transition in the sheet is stilled by the block or runs on the collapsing tokens", () => {
  /* A transition passes when it reads only `--d-*` durations (the block collapses
     them) or its selector is listed in the block with `transition: none` /
     `animation: none`. MUTATION: add `.x { transition: transform .2s ease }` to
     any non-media rule -> red naming `.x`. The Dial layer has no transition of
     its own today, so the Dial half of this cannot fail on today's data; it is the
     guard for the keycap, band, sheet and needle tasks that follow. */
  const stilled = new Set();
  for (const r of ALL) {
    if (!r.atRules.some(isReduce)) continue;
    for (const d of r.decls) {
      if ((d.prop === "transition" || d.prop === "animation") && norm(d.value).startsWith("none")) r.selectors.forEach((s) => stilled.add(s));
    }
  }
  const onTokens = (v) => {
    const times = v.match(/(?:^|[\s,])[\d.]+m?s\b/g);
    return !times && /var\(--d-(?:snap|settle|sheet|quick|draw|buffer|skeleton)\)/.test(v);
  };
  const loose = [];
  for (const r of ALL) {
    if (r.at || r.atRules.length) continue;
    for (const d of r.decls) {
      if (!["transition", "transition-property", "animation", "animation-name"].includes(d.prop)) continue;
      const v = norm(d.value);
      if (v === "none" || v === "initial" || onTokens(v)) continue;
      if (d.prop === "transition-property" || d.prop === "animation-name") continue;
      for (const sel of r.selectors) if (!stilled.has(sel)) loose.push(`${sel} { ${d.prop}: ${v} }`);
    }
  }
  assert.deepStrictEqual(loose, [], "an animation or transition Reduce Motion does not still");
  const dialLiteral = [];
  for (const r of DIAL) {
    for (const d of r.decls || []) {
      if (/^(transition|animation)/.test(d.prop) && /[\d.]+m?s\b/.test(d.value) && !/var\(--d-/.test(d.value)) dialLiteral.push(`${(r.selectors || [])[0]} ${d.prop}`);
    }
  }
  assert.deepStrictEqual(dialLiteral, [], "Dial rules take durations from tokens, never literals");
});

test("every Dial duration is declared once, as a motion token on :root", () => {
  /* Review nit (p3-primitives, second look): the buffering pulse and skeleton
     shimmer each set their own `--d-*: 1000ms` inside the component rule. A
     duration is a token decision, so it lives in the :root MOTION block beside
     the others, and components only read it.
     MUTATION: put `--d-buffer: 1000ms;` back into `.band--buffering .needle`
     -> red naming that selector. */
  const local = [];
  for (const r of DIAL) {
    if (r.at || (r.atRules || []).some(isReduce)) continue;
    if ((r.selectors || []).every((s) => s.startsWith(":root"))) continue;
    for (const d of r.decls || []) {
      if (/(?:^|[\s,(])[\d.]+m?s\b/.test(d.value)) local.push(`${(r.selectors || []).join(", ")} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(local, [], "a component rule declares its own duration");
  for (const k of ["--d-buffer", "--d-skeleton"]) assert.ok(CREAM.has(k), `${k} is a :root motion token`);
});
