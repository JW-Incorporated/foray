/* Afterglow design tokens (Redesign 2026, direction "ambient", phase 3 step 1).
 *
 * Reads ui/tokens.css as text and pins it against docs/redesign-2026/directions/
 * ambient/BUILD-PLAN.md section 1.1 and BUILD-NOTES.md section 1. It is the
 * "rewrite" half of test/ui-tokens.test.js, written next to it instead of over it:
 * styles.css still draws every screen and ui-tokens still pins today's look until a
 * screen adopts the system, so the two files guard two stylesheets for now.
 *
 * RULING THAT FELL: "dark-only / one palette" (test-classification.md section 0,
 * U-01). This file declares two schemes, Dusk and Dawn. Nothing paints with Dawn
 * yet, so ui-tokens' "dark is declared" test is still true of every shipped page and
 * is rewritten in the PR that makes the first screen follow the OS. Also fallen,
 * "violet = 4a authored": the authored colour is Lamp.
 *
 * WHAT THIS FILE GUARANTEES (the six items test-classification.md says a rewrite
 * must keep): (1) every colour/size/shadow/radius goes through a named token, and
 * the token tables are parametrised below, not four names hard-coded; (2) AA contrast
 * for every text/background pair in both schemes, plus the worst case over every hue
 * for each Glow-tinted surface; (3) one authored scope, no stray selector that could
 * restyle today's markup; (4) ONE reduced-motion block covering every transition and
 * animation in the file; (5) fonts stay self-hosted (this file loads none); (6) no
 * inline style, no external origin.
 *
 * MUTATIONS. Each test names the one-line change to ui/tokens.css that turns it red.
 * They were run by pointing AFTERGLOW_TOKENS_CSS at an edited copy (a seam that exists
 * for exactly that: an env var, not a code path the product reads); each run's result
 * is in the PR description and docs/redesign-2026/PROGRESS.md, not just the claim.
 *
 * HARNESS AUDIT. The parser below is deliberately less forgiving than a browser: an
 * unrecognised selector head, a declaration it cannot split, or a derived-token
 * formula that stops matching the pattern the sweep parses is a failure, never a skip.
 * The Glow sweeps read their percentages and base colours OUT OF the CSS, so changing
 * a mix in ui/tokens.css moves the numbers; the chroma ceiling (0.14) and the default
 * hue are constants of BUILD-NOTES 1.2 and are named as such. The raw worst-case
 * numbers are asserted, not a truncated "passes" boolean. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ok = require("./helpers/oklab.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const TOKENS_PATH = process.env.AFTERGLOW_TOKENS_CSS || path.join(ROOT, "ui", "tokens.css");
const RAW = fs.readFileSync(TOKENS_PATH, "utf8").replace(/\r\n/g, "\n");
const STYLES = read("styles.css");

/* ------------------------------------------------------------------ parser */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function splitTop(str, sep) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseDecls(body) {
  return splitTop(body, ";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(":");
    assert.ok(i > 0, `a declaration the parser cannot split: "${d.slice(0, 60)}" in body: ${body.slice(0, 200)}`);
    return { prop: d.slice(0, i).trim(), value: norm(d.slice(i + 1)) };
  });
}
function parse(css) {
  const src = stripComments(css);
  const rules = [];
  const closeOf = (i) => {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      if (src[j] === "}" && --depth === 0) return j;
    }
    throw new Error("unbalanced braces");
  };
  (function walk(from, to, atRules) {
    let i = from, head = "";
    while (i < to) {
      const ch = src[i];
      if (ch === "{") {
        const end = closeOf(i), h = norm(head);
        head = "";
        if (/^@(media|supports|(?:-webkit-)?keyframes)\b/.test(h)) walk(i + 1, end, [...atRules, h]);
        else rules.push({ atRules, selectors: splitTop(h, ",").map(norm), decls: parseDecls(src.slice(i + 1, end)) });
        i = end + 1;
      } else { head += ch; i++; }
    }
  })(0, src.length, []);
  return rules;
}
const RULES = parse(RAW);
const STYLE_RULES = parse(STYLES);
const sameSel = (r, sels) => r.selectors.length === sels.length && sels.every((s, i) => norm(r.selectors[i]) === s);
const find = (sels, atRules = []) => {
  const hits = RULES.filter((r) => sameSel(r, sels) && r.atRules.join("|") === atRules.join("|"));
  assert.strictEqual(hits.length, 1, `exactly one rule for ${sels.join(", ")} ${atRules.join(" ")} (found ${hits.length})`);
  return Object.fromEntries(hits[0].decls.map((d) => [d.prop, d.value]));
};
const LIGHT = "@media (prefers-color-scheme: light)";
const SUPPORTS = "@supports (color: color-mix(in oklab, red, blue))";
const NOT_SUPPORTS = "@supports not (color: color-mix(in oklab, red, blue))";
const STRUCT = find([":root"]);
const DUSK = find([":root", '[data-theme="dusk"]']);
const DAWN_MEDIA = find([':root:not([data-theme="dusk"])'], [LIGHT]);
const DAWN_ATTR = find(['[data-theme="dawn"]']);
const DERIVED = find([":root", "[data-theme]", ".ag", ".room"], [SUPPORTS]);

/* Colour reading */
const resolve = (map, v, depth = 0) => {
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (!m) return v;
  assert.ok(depth < 5 && map[m[1]] !== undefined, `${v} resolves`);
  return resolve(map, map[m[1]], depth + 1);
};
const rgb = (map, name) => {
  const v = resolve(map, map[name]);
  assert.match(v, /^#[0-9A-Fa-f]{6}$/, `${name} is a six-digit hex (${v})`);
  return ok.hexToRgb(v);
};
const rgba255 = (v) => {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(v);
  assert.ok(m, `rgb(R G B / a) expected, got ${v}`);
  return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] };
};

/* ------------------------------------------------- spec tables (BUILD-PLAN 1.1) */
/* DIVERGENCE FROM THE PLAN TABLE, on purpose: it lists Dawn --ok/--warn as "same as
   Dusk". #7FCB8E on #F7F2EB is 1.9:1, so the prototype (the later source) darkens both
   in Dawn, and so does this file. One step further than the prototype: its Dawn --ok
   (#2E7D45) is 4.18:1 on --bg2, so this file uses #2A7541 (4.65:1); the AA test below
   is what proves it. */
const DUSK_SPEC = {
  "--bg0": "#14110F", "--bg1": "#1D1916", "--bg2": "#272220",
  "--ag-text": "#F5EEE4", "--text-2": "#B9AFA3", "--text-3": "#9A9188",
  "--ember": "#F0A64B", "--ember-ink": "#14110F",
  "--lamp": "#F3E7D3", "--lamp-ink": "#14110F", "--lamp-text": "#F3E7D3",
  "--rim": "rgb(243 231 211 / 0.10)", "--overlay": "rgb(243 231 211 / 0.06)",
  "--shadow-1": "0 1px 2px rgb(10 6 4 / 0.40)", "--shadow-2": "0 8px 24px rgb(10 6 4 / 0.35)",
  "--ok": "#7FCB8E", "--warn": "#E9B46A",
  "--mix-veil": "28%", "--mix-row": "18%", "--mix-wash": "40%", "--mix-room": "15%", "--cast-mix": "14%", "--lit-mix": "55%",
  "--glow-l": "0.66",
};
const DAWN_SPEC = {
  "--bg0": "#F7F2EB", "--bg1": "#FDFAF5", "--bg2": "#EFE8DF",
  "--ag-text": "#1E1A17", "--text-2": "#5E564E", "--text-3": "#6B635A",
  "--ember": "#8E520E", "--ember-ink": "#FFFFFF",
  "--lamp": "#FFFFFF", "--lamp-ink": "#1E1A17", "--lamp-text": "#55391A", "--lamp-edge": "#E0D6C8",
  "--rim": "rgb(255 255 255 / 0.80)", "--overlay": "rgb(255 255 255 / 0.55)",
  "--shadow-1": "0 1px 2px rgb(60 40 20 / 0.10)", "--shadow-2": "0 8px 24px rgb(60 40 20 / 0.10)",
  "--ok": "#2A7541", "--warn": "#8A5A12",
  "--mix-veil": "24%", "--mix-row": "18%", "--mix-wash": "40%", "--mix-room": "20%", "--cast-mix": "9%", "--lit-mix": "40%",
  "--glow-l": "0.56",
};

/* ===================================================================== tests */

test("Dusk declares every colour token with the plan's value, on :root and any data-theme=dusk root", () => {
  /* MUTATION: change --bg0 to #141110 in the Dusk block -> red, naming --bg0. */
  for (const [name, want] of Object.entries(DUSK_SPEC)) assert.strictEqual(DUSK[name], want, `Dusk ${name}`);
});

test("Dawn declares every colour token with the plan's value, in the media-query block and the attribute block alike", () => {
  /* MUTATION: change --ember to #8E520F in the data-theme="dawn" block only -> red (the two
     blocks disagree, and the attribute block no longer matches the plan). */
  for (const [name, want] of Object.entries(DAWN_SPEC)) {
    assert.strictEqual(DAWN_MEDIA[name], want, `Dawn (media) ${name}`);
    assert.strictEqual(DAWN_ATTR[name], want, `Dawn (attribute) ${name}`);
  }
  const strip = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== "--glow"));
  assert.deepStrictEqual(strip(DAWN_MEDIA), strip(DAWN_ATTR), "the two Dawn blocks are declaration-identical (--glow aside, which the root-only rule below owns)");
});

test("Dawn re-owns every token Dusk declares: no scheme token is left reading the other scheme's value", () => {
  /* MUTATION: delete the --track line from the Dawn media block -> red, naming --track. */
  const missing = Object.keys(DUSK).filter((k) => !(k in DAWN_MEDIA) && !(k in DAWN_ATTR));
  assert.deepStrictEqual(missing, [], "tokens declared by Dusk and not by Dawn");
  const missingAttr = Object.keys(DUSK).filter((k) => !(k in DAWN_ATTR));
  assert.deepStrictEqual(missingAttr, [], "Dawn's attribute block re-owns them too");
  assert.ok(Object.keys(DUSK).length >= 30, "fixture assumption: the Dusk block is the whole palette, not a stub");
});

test("the default Glow is a root-only declaration: a themed panel inherits the live Glow, never resets it", () => {
  /* MUTATION: add --glow: oklch(0.56 0.12 60) to the data-theme="dawn" block -> red. A panel that
     redeclared --glow would ignore the Glow script writes on <html>. */
  for (const m of [DUSK, DAWN_ATTR]) assert.strictEqual(m["--glow"], undefined, "no --glow on a [data-theme] scheme block");
  assert.strictEqual(STRUCT["--glow"], "oklch(0.66 0.12 60)", "Dusk default Glow on :root");
  assert.strictEqual(DAWN_MEDIA["--glow"], "oklch(0.56 0.12 60)", "Dawn default Glow, OS-light");
  assert.strictEqual(find([':root[data-theme="dawn"]'])["--glow"], "oklch(0.56 0.12 60)", "Dawn default Glow, explicit");
  const prop = RULES.find((r) => r.selectors[0] === "@property --glow");
  assert.ok(prop || /@property --glow \{[^}]*syntax: '<color>'[^}]*initial-value: #8A6A4E/.test(stripComments(RAW)), "--glow is a registered <color> property");
});

test("structure tokens: seven type styles in rem, the 4px space scale, radius, size and motion, exactly as the plan has them", () => {
  /* MUTATION: change --t-title's line-height from 1.875rem to 1.75rem -> red; add an eighth
     --t-* token -> red (the seven-styles rule); change --m-room to 600ms -> red. */
  const TYPE = {
    "--t-display": [500, 32, "1.125", "var(--font-display)"],
    "--t-title": [500, 26, "30px", "var(--font-display)"],
    "--t-headline": [500, 20, "1.2", "var(--font-display)"],
    "--t-why": [400, 17, "24px", "var(--font-display)", "italic"],
    "--t-body": [400, 16, "24px", "var(--font-text)"],
    "--t-label": [600, 14, "1.3", "var(--font-text)"],
    "--t-caption": [500, 13, "18px", "var(--font-text)"],
  };
  const typeTokens = Object.keys(STRUCT).filter((k) => /^--t-/.test(k));
  assert.deepStrictEqual(typeTokens.sort(), Object.keys(TYPE).sort(), "the seven styles and nothing else");
  for (const [name, [weight, px, lh, face, style]] of Object.entries(TYPE)) {
    const m = /^(?:(italic) )?(\d+) (\d*\.?\d+)rem\/(\S+) (.+)$/.exec(STRUCT[name]);
    assert.ok(m, `${name} is a font shorthand in rem: ${STRUCT[name]}`);
    assert.strictEqual(m[1], style, `${name} style`);
    assert.strictEqual(+m[2], weight, `${name} weight`);
    assert.strictEqual(Math.round(parseFloat(m[3]) * 16 * 1000) / 1000, px, `${name} size in px`);
    const lhRem = /^([\d.]+)rem$/.exec(m[4]);
    assert.strictEqual(lhRem ? `${Math.round(parseFloat(lhRem[1]) * 16)}px` : m[4], lh, `${name} leading`);
    assert.strictEqual(m[5], face, `${name} face`);
  }
  assert.strictEqual(STRUCT["--font-text"], "'DM Sans', system-ui, sans-serif");
  const WANT = {
    "--s-1": "4px", "--s-2": "8px", "--s-3": "12px", "--s-4": "16px", "--s-5": "20px", "--s-6": "24px", "--s-8": "32px", "--s-10": "40px", "--s-12": "48px",
    "--r-xs": "4px", "--r-sm": "8px", "--r-md": "12px", "--r-lg": "16px", "--r-xl": "24px", "--r-pill": "999px", "--r-round": "50%",
    "--art-mini": "44px", "--art-queue": "56px", "--art-row": "72px", "--art-tile": "104px", "--art-foray": "120px", "--art-hero": "160px",
    "--row-episode": "96px", "--row-queue": "64px", "--row-show": "64px", "--tab-bar": "64px", "--mini": "64px", "--field": "52px", "--tap": "44px",
    "--ag-gutter": "16px", "--dock-inset": "12px",
    "--chrome-bottom": "calc(var(--tab-bar) + var(--safe-bottom) + var(--dock-inset))",
    "--chrome-bottom-mini": "calc(var(--chrome-bottom) + var(--mini) + 8px)",
    "--m-micro": "160ms", "--m-ui": "280ms", "--m-sheet": "420ms", "--m-room": "560ms",
    "--e-out": "cubic-bezier(0.2, 0.8, 0.2, 1)",
    "--e-spring": "linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077 20.4%, 1.121, 1.149 24.3%, 1.159, 1.163 27.8%, 1.154, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.001 85.5%, 1)",
    "--e-spring-soft": "linear(0, 0.013, 0.05 2.5%, 0.2 5.6%, 0.56 11.2%, 0.86 16.8%, 0.98 20.4%, 1.03 24%, 1.045 27.6%, 1.04 31.2%, 1.02 36.8%, 1.004 42.4%, 0.996 48%, 0.998 58%, 1)",
    "--seg-dim": "0.38",
  };
  for (const [k, v] of Object.entries(WANT)) assert.strictEqual(STRUCT[k], v, k);
  const wide = find([":root"], ["@media (min-width: 393px)"]);
  assert.strictEqual(wide["--ag-gutter"], "20px", "the gutter is 20 from 393");
  const car = find(['[data-posture="car"]']);
  assert.deepStrictEqual(Object.keys(car).sort(), ["--t-display", "--t-headline", "--t-label"], "car posture scales exactly display, headline, label");
  assert.match(car["--t-display"], /2\.5rem\/1\.125/, "32 x 1.25 = 40px, unitless leading kept");
  assert.match(car["--t-headline"], /1\.5625rem\/1\.2 /, "20 x 1.25 = 25px");
  assert.match(car["--t-label"], /1\.09375rem\/1\.3 /, "14 x 1.25 = 17.5px");
});

test("the spring easings are real: both start at 0 and end at 1, and only --e-spring overshoots", () => {
  /* MUTATION: replace the last stop of --e-spring-soft with 0.9 -> red. A linear() that ends short
     leaves every sheet 10% open. */
  const stops = (name) => STRUCT[name].replace(/^linear\(|\)$/g, "").split(",").map((s) => parseFloat(s.trim()));
  for (const name of ["--e-spring", "--e-spring-soft"]) {
    const s = stops(name);
    assert.strictEqual(s[0], 0, `${name} starts at 0`);
    assert.strictEqual(s[s.length - 1], 1, `${name} ends at 1`);
  }
  assert.ok(Math.max(...stops("--e-spring")) > 1.1, "--e-spring has its overshoot (about 1.16)");
  assert.ok(Math.max(...stops("--e-spring-soft")) < 1.06, "--e-spring-soft is near-critical");
});

/* ------------------------------------------------- coexistence with styles.css */
const LEGACY_NAMES = new Set([...STYLES.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const SCOPE = [".ag", ".room"];

test("a token styles.css already declares is declared here ONLY on the .ag/.room scope, never on :root or a theme root", () => {
  /* The pixel-identity rule: styles.css's rules read --text, --gutter and --seg-* and must keep
     reading their own values, so the Afterglow values of those names cannot reach them.
     MUTATION: add `--text: #F5EEE4;` to the :root rule, or `--gutter: 20px` to the Dusk block -> red. */
  const collided = new Map();
  for (const r of RULES) {
    if (r.selectors[0].startsWith("@")) continue;
    for (const d of r.decls) {
      if (!d.prop.startsWith("--") || !LEGACY_NAMES.has(d.prop)) continue;
      const scoped = r.selectors.every((s) => SCOPE.includes(s));
      assert.ok(scoped, `${d.prop} collides with a styles.css token and is declared on ${r.selectors.join(", ")}`);
      collided.set(d.prop, true);
    }
  }
  assert.deepStrictEqual([...collided.keys()].sort(),
    ["--gutter", "--seg-c0", "--seg-c1", "--seg-c2", "--seg-c3", "--seg-c4", "--seg-c5", "--seg-c6", "--seg-c7", "--seg-narration", "--text"],
    "the collision set is exactly the one the header documents (a name dropped from the scope would read the legacy value inside .ag)");
  assert.ok(LEGACY_NAMES.has("--text") && LEGACY_NAMES.has("--gutter"), "fixture assumption: styles.css really declares these");
  const scope = find(SCOPE);
  assert.strictEqual(scope["--text"], "var(--ag-text)");
  assert.strictEqual(scope["--gutter"], "var(--ag-gutter)");
  assert.strictEqual(scope["--seg-narration"], "var(--lamp)");
  assert.strictEqual(RULES.some((r) => r.decls.some((d) => d.prop === "--font-display")), false, "--font-display stays styles.css's");
});

test("every selector in the file is a new name: nothing today's markup emits or styles.css targets is restyled", () => {
  /* Class names are checked against every class styles.css selects and every class a template
     emits (app.js, ui/*.js, player/*.js, index.html). MUTATION: add a rule for `.page-head`
     (or `body`, `button`) -> red. */
  const HEADS = [/^:root/, /^\[data-theme/, /^\[data-posture="car"\]/, /^\.ag(?![\w-])/, /^\.room(?![\w-])/,
    /^\.(raised|veil|dock|dock-fade|dock-cast|lit-art|lit-40|lit-64|lit-96|eyebrow|num|time|count|dur|clamp[1-4]|t-(display|title|headline|why|body|label|caption))(?![\w-])/,
    /^::view-transition-(group|old|new)\(\*\)$/];
  const classes = new Set();
  for (const r of RULES) {
    if (r.selectors[0].startsWith("@")) continue;
    for (const s of r.selectors) {
      assert.ok(HEADS.some((h) => h.test(s)), `selector "${s}" does not start with a new name (a bare element, a legacy class, or an unknown head)`);
      for (const m of s.matchAll(/\.([A-Za-z][\w-]*)/g)) classes.add(m[1]);
    }
  }
  /* The phase-3 system files are the deliberate exceptions: icons.js, primitives.js and gallery.js emit
     only the new `.ag` subtree while legacy screens remain unchanged. Every screen-bearing ui/*.js still
     counts. MUTATION: put `class="icon"` in app.js or any other screen template -> red. */
  const systemFiles = new Set(["icons.js", "primitives.js", "gallery.js", "tabbar.js", "home.js", "onboarding.js", "foray.js", "settings.js", "interests.js", "show.js", "browse.js", "search.js", "create.js", "forays.js", "library.js", "playlist.js"]);
  /* Home (ui/home.js), Foray detail (ui/foray.js), Settings, Tuning, Show and Discover (ui/browse.js, ui/search.js, ui/create.js)
     are ADOPTED screens (Redesign 2026 phase 4): each wears `.ag`, `.room` and the type, clamp and eyebrow classes by design. A screen
     joins the list above in the PR that adopts the system, and no sooner. */
  /* THE DOCK IS THE FIRST SCREEN TO ADOPT THE SYSTEM (Redesign 2026, Phase 4 "dock"). ui/tabbar.js builds it
     (`dock veil`, `dock-fade`, `dock-cast`, and the sprite glyphs, `icon`) and player/client.js writes the
     mini bar's glyphs as `icon` (spriteIcon): those classes are emitted there ON PURPOSE, so the two files
     are exempt for exactly them. Every OTHER file is still held to "emits none of it", and every other
     class is still unemitted everywhere. MUTATION: put `class="icon"` or `class="veil"` in app.js or any
     other screen template -> red. */
  const DOCK_ADOPTED = new Set(["icon", "dock", "veil", "dock-fade", "dock-cast"]);
  const playerFiles = fs.readdirSync(path.join(ROOT, "player")).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  const emittedOutsideDock = [read("app.js"), read("index.html"), ...fs.readdirSync(path.join(ROOT, "ui")).filter((f) => f.endsWith(".js") && !systemFiles.has(f)).map((f) => read(`ui/${f}`)),
    ...playerFiles.filter((f) => f !== "client.js").map((f) => read(`player/${f}`))].join("\n");
  const emitted = emittedOutsideDock + "\n" + read("player/client.js");
  /* Playlist detail and the Playlists list (ui/playlist.js) are adopted too. */
  const legacy = new Set(STYLE_RULES.flatMap((r) => r.selectors.flatMap((s) => [...s.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]))));
  for (const c of classes) {
    assert.ok(!legacy.has(c), `class .${c} is already a styles.css selector`);
    const haystack = DOCK_ADOPTED.has(c) ? emittedOutsideDock : emitted;
    const emits = new RegExp(`class(?:Name)?\\s*=\\s*[\\\\"'\`][^"'\`]*(?<![\\w-])${c}(?![\\w-])`).test(haystack) || new RegExp(`classList\\.(?:add|toggle|contains)\\([^)]*["']${c}["']`).test(haystack);
    assert.ok(!emits, `class .${c} is emitted by today's markup`);
  }
  assert.ok(classes.size >= 15, `fixture assumption: the file defines its classes (${classes.size})`);
});

test("the file loads no font, no image and no external origin, and carries no @import", () => {
  /* MUTATION: add `@import url("https://fonts.googleapis.com/css2?family=Fraunces");` -> red.
     The three variable faces are styles.css's @font-face rules; font-src 'self' needs nothing here. */
  const css = stripComments(RAW);
  assert.ok(!/@import|@font-face|url\(|https?:|\/\/[a-z]/i.test(css), "no @import, @font-face, url() or origin in ui/tokens.css");
});

/* ------------------------------------------------------ no leaked literals */
const isPureTokens = (r) => r.decls.every((d) => d.prop.startsWith("--"));
const inReducedMotion = (r) => r.atRules.some((a) => /prefers-reduced-motion/.test(a));
const LIVE = RULES.filter((r) => !r.selectors[0].startsWith("@") && !isPureTokens(r) && !inReducedMotion(r));

test("outside the token blocks no rule carries a colour literal, a raw duration or a raw easing", () => {
  /* MUTATION: set `.raised { background: #1D1916 ... }`, or `transition: opacity 200ms ease` on
     any rule -> red, naming the rule. `transparent` and `0` are not colours/durations. */
  const bad = [];
  for (const r of LIVE) for (const d of r.decls) {
    if (d.prop.startsWith("--")) continue;   /* a token declared inside a live rule is the token tests' business */
    const here = `${r.selectors.join(", ")} { ${d.prop}: ${d.value} }`;
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i.test(d.value)) bad.push(`colour literal: ${here}`);
    if (/(^|[\s,(])\d*\.?\d+m?s\b/.test(d.value) && /^(transition|animation)/.test(d.prop)) bad.push(`raw duration: ${here}`);
    if (/\b(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)\b/.test(d.value) && /^(transition|animation)/.test(d.prop)) bad.push(`raw easing: ${here}`);
    if (d.prop === "border-radius" && !/^var\(--r-[a-z]+\)$/.test(d.value)) bad.push(`radius is not a token: ${here}`);
    if (d.prop === "font" && !/^var\(--t-[a-z]+\)$/.test(d.value)) bad.push(`font is not a type token: ${here}`);
    if (d.prop === "font-size") bad.push(`font-size outside the seven styles: ${here}`);
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(LIVE.length >= 15, "fixture assumption: the material rules are parsed");
});

/* ------------------------------------------------------------------ contrast */
const roomDusk = find([`.room[data-theme="dusk"]`]);
function pairs() {
  const dusk = DUSK, dawn = DAWN_MEDIA;
  const roomText2 = { ...DUSK, ...roomDusk };
  const out = [];
  const CORE = ["--ag-text", "--text-2", "--text-3", "--ember"];   /* the pairs contrast-check.mjs prints, whose floor the direction records as 4.86 */
  const add = (scheme, map, fg, bg, label) => out.push({ scheme, label: `${label || fg} on ${bg}`, ratio: ok.contrast(rgb(map, fg), rgb(map, bg)), fg, bg, core: CORE.includes(fg) && /^Dusk$|^Dawn$/.test(scheme) });
  for (const bg of ["--bg0", "--bg1", "--bg2"]) for (const fg of ["--ag-text", "--text-2", "--text-3"]) add("Dusk", dusk, fg, bg);
  for (const bg of ["--bg0", "--bg1", "--bg2"]) for (const fg of ["--ember", "--ok", "--warn"]) add("Dusk", dusk, fg, bg);
  add("Dusk", dusk, "--lamp", "--bg0"); add("Dusk", dusk, "--lamp-text", "--bg0");
  add("Dusk", dusk, "--ember-ink", "--ember"); add("Dusk", dusk, "--lamp-ink", "--lamp");
  for (const fg of ["--ag-text", "--text-2", "--text-3"]) add("Dusk Room", roomText2, fg, "--bg0");
  for (const bg of ["--bg0", "--bg1", "--bg2"]) for (const fg of ["--ag-text", "--text-2", "--text-3", "--ember", "--ok", "--warn"]) add("Dawn", dawn, fg, bg);
  add("Dawn", dawn, "--lamp-text", "--bg0"); add("Dawn", dawn, "--lamp-text", "--bg1");
  add("Dawn", dawn, "--ember-ink", "--ember"); add("Dawn", dawn, "--lamp-ink", "--bg0");
  return out;
}

test("WCAG AA: every text/background pair in both schemes clears 4.5:1, and the lowest is the direction's 4.86", () => {
  /* MUTATION: change Dusk --text-3 to #7A7168 (or Dawn --text-3 to #8A8279) -> red, naming the pair.
     Also asserts the contrast-check.mjs pairs are covered (the same numbers it prints). */
  const all = pairs();
  const failing = all.filter((p) => p.ratio < 4.5).map((p) => `${p.scheme}: ${p.label} = ${p.ratio.toFixed(2)}`);
  assert.deepStrictEqual(failing, [], "pairs under 4.5:1");
  const lowest = Math.min(...all.filter((p) => p.core).map((p) => p.ratio));
  assert.ok(lowest >= 4.85, `lowest text pair ${lowest.toFixed(2)} (the direction records 4.86)`);
  assert.ok(all.length >= 47, `fixture assumption: ${all.length} pairs are measured`);
  /* The pairs contrast-check.mjs prints, by value, so the two tools cannot drift apart. */
  const find2 = (scheme, fg, bg) => all.find((p) => p.scheme === scheme && p.fg === fg && p.bg === bg).ratio;
  assert.ok(Math.abs(find2("Dusk", "--ag-text", "--bg0") - 16.3) < 0.1, "text on bg0 is 16.3:1");
  assert.ok(Math.abs(find2("Dusk", "--text-3", "--bg0") - 6.1) < 0.1, "text-3 on bg0 is 6.1:1");
  assert.ok(Math.abs(find2("Dawn", "--ember", "--bg0") - 5.61) < 0.02, "Dawn Ember on paper0 is 5.61:1");
});

/* ------------------------------------------------- Glow-tinted worst cases */
/* Constants of BUILD-NOTES 1.2, not tokens: Glow's chroma is clamped to 0.14 and the sweep
   steps the hue by 10 degrees. Lightness is the scheme's own --glow-l. */
const GLOW_MAX_CHROMA = 0.14;
const HUES = Array.from({ length: 36 }, (_, i) => i * 10);

const mixOf = (name) => {
  const m = /^color-mix\(in oklab, var\((--[\w-]+)\), var\(--glow\) var\((--mix-[\w]+)\)\)$/.exec(DERIVED[name]);
  assert.ok(m, `${name} still has the formula the sweep reads: ${DERIVED[name]}`);
  return { base: m[1], mix: m[2] };
};
function sweep(scheme, build, fgs) {
  const L = parseFloat(scheme["--glow-l"]);
  const worst = {};
  for (const h of HUES) {
    const glow = ok.oklchToLab(L, GLOW_MAX_CHROMA, h);
    const bg = build(glow);
    for (const [name, fg] of Object.entries(fgs)) {
      const r = ok.contrast(fg, bg);
      if (!worst[name] || r < worst[name].r) worst[name] = { r, h };
    }
  }
  return worst;
}
const pct = (v) => parseFloat(v) / 100;
function tinted(scheme, token) {
  const { base, mix } = mixOf(token);
  const baseLab = ok.srgbToOklab(rgb(scheme, base));
  return (glow) => ok.oklabToSrgb(ok.mixLab(baseLab, glow, 1 - pct(scheme[mix])));
}
const lampOverlay = (scheme, bgRgb) => {
  const o = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(scheme["--overlay"]);
  return ok.over([+o[1] / 255, +o[2] / 255, +o[3] / 255], +o[4], bgRgb);
};
const WHITE = [1, 1, 1], BLACK = [0, 0, 0];

test("Glow-tinted surfaces: text keeps AA at the worst hue on every one, and the worst cases are pinned as numbers", () => {
  /* The formulas are read from the CSS. MUTATIONS (each -> red): --mix-veil 28% -> 50%;
     --cast-mix 14% -> 40%; --glow-l 0.66 -> 0.80 (Dusk), because the sweep takes the scheme's own
     lightness; the Dawn --mix-veil 24% -> 28% (the plan table's number, which the prototype measured
     at 4.48:1 and corrected). The pinned numbers are the prototype's (contrast-glow.mjs) to 0.01. */
  const R = {};
  const pin = (key, got, want, tol = 0.011) => {
    R[key] = got;
    assert.ok(Math.abs(got.r - want) <= tol, `${key}: ${got.r.toFixed(3)} at hue ${got.h}, pinned ${want}`);
    assert.ok(got.r >= 4.5, `${key} is under AA: ${got.r.toFixed(2)}`);
  };
  const dusk = DUSK, dawn = DAWN_MEDIA;
  const fgD = { text: rgb(dusk, "--ag-text"), "text-2": rgb(dusk, "--text-2"), "text-3": rgb(dusk, "--text-3"), lamp: rgb(dusk, "--lamp") };
  const fgW = { ink: rgb(dawn, "--ag-text"), "ink-2": rgb(dawn, "--text-2"), "ink-3": rgb(dawn, "--text-3"), "lamp-text": rgb(dawn, "--lamp-text") };
  const pick = (o, ...ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));

  /* Dusk */
  const veilD = sweep(dusk, tinted(dusk, "--glow-veil"), pick(fgD, "text", "text-2"));
  pin("Dusk Veil text", veilD.text, 10.94); pin("Dusk Veil text-2", veilD["text-2"], 5.83);
  const rowD = sweep(dusk, (g) => lampOverlay(dusk, tinted(dusk, "--glow-row")(g)), pick(fgD, "text", "text-2"));
  pin("Dusk row text", rowD.text, 10.02); pin("Dusk row text-2", rowD["text-2"], 5.34);
  const washD = sweep(dusk, tinted(dusk, "--glow-wash"), pick(fgD, "text", "text-2", "lamp"));
  pin("Dusk wash text", washD.text, 8.60); pin("Dusk wash text-2", washD["text-2"], 4.59); pin("Dusk wash lamp", washD.lamp, 8.11);
  /* Today's hot spot is a gradient layer in the screen (BUILD-PLAN 2.1.3), its 52% a screen constant:
     text-2 is 3.55:1 there, which is exactly why --on-wash-2 exists, so only that pair is asserted. */
  const HOT = 0.52, D0 = ok.srgbToOklab(rgb(dusk, "--bg0"));
  const hotD = sweep(dusk, (g) => ok.oklabToSrgb(ok.mixLab(D0, g, 1 - HOT)), { ows: rgb(dusk, "--on-wash-2"), lamp: fgD.lamp });
  pin("Dusk hot spot on-wash-2", hotD.ows, 5.49); pin("Dusk hot spot lamp", hotD.lamp, 6.27);
  /* The Room at the eyebrow's y: the mid scrim over the Glow colour, and over pure white art (the brightest possible). */
  const roomT = { ...DUSK, ...roomDusk };
  const midD = rgba255(DUSK["--scrim-mid-base"]), shareD = 1 - pct(DUSK["--mix-scrim"]);
  const scrimD = (back) => (g) => { const m = ok.mixScrim(midD.rgb, midD.a, shareD, g); return ok.over(ok.oklabToSrgb(m.lab), m.alpha, back || ok.oklabToSrgb(g)); };
  const eyeD = sweep(dusk, (g) => scrimD(null)(g), { lamp: fgD.lamp, "text-2": rgb(roomT, "--text-2") });
  pin("Dusk Room eyebrow over Glow, lamp", eyeD.lamp, 9.00); pin("Dusk Room eyebrow over Glow, text-2", eyeD["text-2"], 6.07);
  const eyeDW = sweep(dusk, (g) => scrimD(WHITE)(g), { lamp: fgD.lamp, "text-2": rgb(roomT, "--text-2") });
  pin("Dusk Room eyebrow over white art, lamp", eyeDW.lamp, 7.56); pin("Dusk Room eyebrow over white art, text-2", eyeDW["text-2"], 5.10);
  /* The head icons need only 3:1 and they sit on --scrim-head over ANY art, pure white included. */
  const headD = rgba255(DUSK["--scrim-head"]);
  const headW = ok.contrast(fgD.text, ok.over(headD.rgb.map((v) => v / 255), headD.a, WHITE));
  assert.ok(headW >= 3 && Math.abs(headW - 3.27) < 0.01, `Dusk Room head over white art ${headW.toFixed(3)}, pinned 3.27 (floor 3:1)`);
  /* The Dock casts upward: page text sits on the cast at its brightest point, the Dock's top edge. */
  const castD = sweep(dusk, (g) => ok.oklabToSrgb(ok.mixLab(D0, g, 1 - pct(dusk["--cast-mix"]))), pick(fgD, "text", "text-2", "text-3"));
  pin("Dusk Dock cast text", castD.text, 13.85); pin("Dusk Dock cast text-2", castD["text-2"], 7.39); pin("Dusk Dock cast text-3", castD["text-3"], 5.15);

  /* Dawn */
  const veilW = sweep(dawn, tinted(dawn, "--glow-veil"), pick(fgW, "ink", "ink-2"));
  pin("Dawn Veil ink", veilW.ink, 11.36); pin("Dawn Veil ink-2", veilW["ink-2"], 4.73);
  const rowW = sweep(dawn, tinted(dawn, "--glow-row"), pick(fgW, "ink", "ink-2"));
  pin("Dawn row ink", rowW.ink, 13.06); pin("Dawn row ink-2", rowW["ink-2"], 5.44);
  const washW = sweep(dawn, tinted(dawn, "--glow-wash"), pick(fgW, "ink"));
  pin("Dawn wash ink", washW.ink, 9.08);
  const W0 = ok.srgbToOklab(rgb(dawn, "--bg0"));
  const midW = rgba255(dawn["--scrim-mid-base"]), shareW = 1 - pct(dawn["--mix-scrim"]);
  const baseW = (g) => ok.oklabToSrgb(ok.mixLab(W0, g, 1 - pct(dawn["--mix-room"])));
  const scrimW = (back) => (g) => { const m = ok.mixScrim(midW.rgb, midW.a, shareW, g); return ok.over(ok.oklabToSrgb(m.lab), m.alpha, back(g)); };
  const eyeW = sweep(dawn, scrimW((g) => ok.oklabToSrgb(g)), pick(fgW, "ink", "ink-2", "lamp-text"));
  pin("Dawn Room eyebrow over Glow, ink-2", eyeW["ink-2"], 4.57); pin("Dawn Room eyebrow over Glow, lamp-text", eyeW["lamp-text"], 6.72);
  /* the Dawn artwork layer sits at --room-art-opacity over the base, so "black art" is that layer composited */
  const layer = parseFloat(dawn["--room-art-opacity"]);   /* a plain number, not a percentage */
  const eyeWB = sweep(dawn, scrimW((g) => ok.over(BLACK, layer, baseW(g))), pick(fgW, "ink", "ink-2", "lamp-text"));
  pin("Dawn Room eyebrow over black art, ink-2", eyeWB["ink-2"], 4.55); pin("Dawn Room eyebrow over black art, lamp-text", eyeWB["lamp-text"], 6.69);
  const castW = sweep(dawn, (g) => ok.oklabToSrgb(ok.mixLab(W0, g, 1 - pct(dawn["--cast-mix"]))), pick(fgW, "ink", "ink-2", "ink-3"));
  pin("Dawn Dock cast ink", castW.ink, 13.85); pin("Dawn Dock cast ink-2", castW["ink-2"], 5.77); pin("Dawn Dock cast ink-3", castW["ink-3"], 4.73);
  assert.ok(Object.keys(R).length >= 28, `fixture assumption: ${Object.keys(R).length} worst cases were measured`);
});

test("the static fallbacks for engines without color-mix are the mixes at each scheme's default Glow", () => {
  /* MUTATION: change Dusk's static --glow-veil from #402D1D to #221C19 (the prototype's neutral) -> red:
     a fallback that is not the mix at the default Glow is a different colour in the old engine than in the new. */
  const fbDusk = find([":root", '[data-theme="dusk"]'], [NOT_SUPPORTS]);
  const fbLight = find([':root:not([data-theme="dusk"])'], [NOT_SUPPORTS, LIGHT]);
  const fbDawn = find(['[data-theme="dawn"]'], [NOT_SUPPORTS]);
  assert.deepStrictEqual(fbLight, fbDawn, "the two Dawn fallback blocks are identical");
  const check = (scheme, fb, label) => {
    const g = ok.oklchToLab(parseFloat(scheme["--glow-l"]), 0.12, 60);   /* the default Glow: oklch(L 0.12 60) */
    for (const [token, mix] of [["--glow-veil", "--mix-veil"], ["--glow-row", "--mix-row"], ["--glow-wash", "--mix-wash"], ["--glow-room", "--mix-room"]]) {
      const { base } = mixOf(token);
      const want = ok.oklabToSrgb(ok.mixLab(ok.srgbToOklab(rgb(scheme, base)), g, 1 - pct(scheme[mix])));
      const got = ok.hexToRgb(fb[token]);
      got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) * 255 <= 1.01, `${label} ${token} ${fb[token]} vs ${ok.rgbToHex(want)}`));
    }
    for (const [token, baseName] of [["--scrim-mid", "--scrim-mid-base"], ["--scrim-low", "--scrim-low-base"]]) {
      const b = rgba255(scheme[baseName]), want = ok.mixScrim(b.rgb, b.a, 1 - pct(scheme["--mix-scrim"]), g);
      const got = rgba255(fb[token]), wantRgb = ok.oklabToSrgb(want.lab).map((v) => Math.round(v * 255));
      got.rgb.forEach((v, i) => assert.ok(Math.abs(v - wantRgb[i]) <= 1, `${label} ${token} channel ${i}`));
      assert.ok(Math.abs(got.a - want.alpha) <= 0.002, `${label} ${token} alpha ${got.a} vs ${want.alpha.toFixed(3)}`);
    }
  };
  check(DUSK, fbDusk, "Dusk"); check(DAWN_MEDIA, fbLight, "Dawn");
  /* and the supported formulas live only inside @supports, so a fallback is never overridden by the line it guards */
  const outside = RULES.filter((r) => !r.atRules.some((a) => a.startsWith("@supports")) && r.decls.some((d) => /color-mix\(/.test(d.value) && d.prop.startsWith("--")));
  assert.deepStrictEqual(outside.map((r) => r.selectors.join(",")), [], "a custom property holding color-mix() outside @supports");
});

/* ------------------------------------------------------------- the materials */
test("materials: Raised, Veil, Dock, Dock fade, Dock cast, Room and Lit art carry the plan's numbers", () => {
  /* MUTATIONS: .dock-fade `32px` -> `48px`; .dock-cast height 260px -> 200px; .room::before blur 64px -> 24px;
     .veil blur 20px -> 8px; .lit-96 --lit-r 96px -> 60px; the scrim's second stop `+ 56px` -> `+ 96px` -> each red. */
  const d = (sels, atRules) => find(sels, atRules);
  const raised = d([".raised"]);
  assert.strictEqual(raised.background, "linear-gradient(var(--overlay), var(--overlay)) var(--bg1)");
  assert.strictEqual(raised["box-shadow"], "inset 0 1px 0 var(--rim), var(--shadow-1), var(--shadow-2)", "lit from above by a rim, never a hairline");
  const veil = d([".veil"]);
  assert.strictEqual(veil.background, "var(--glow-veil)");
  assert.strictEqual(veil["backdrop-filter"], "blur(20px) saturate(140%)");
  assert.strictEqual(veil["-webkit-backdrop-filter"], "blur(20px) saturate(140%)");
  const dock = d([".dock"]);
  assert.strictEqual(dock["border-radius"], "var(--r-xl)");
  assert.strictEqual(dock.bottom, "calc(var(--safe-bottom) + var(--dock-inset))");
  assert.strictEqual(find([".dock > :not([hidden]) ~ :not([hidden])"])["box-shadow"], "inset 0 1px 0 var(--rim)", "rows divided by a rim, no gap");
  const fade = d([".dock-fade"]);
  assert.strictEqual(fade.height, "calc(var(--safe-bottom) + var(--dock-inset) + 44px)");
  assert.strictEqual(fade.background, "linear-gradient(transparent 0, var(--bg0) 32px)", "solid by 32px, which is 12px above the Dock's bottom edge");
  assert.strictEqual(fade["z-index"], "var(--z-dock-fade)");
  assert.strictEqual(dock["z-index"], "var(--z-dock)");
  assert.ok(STRUCT["--z-dock-fade"] === "19" && STRUCT["--z-dock"] === "20", "the fade sits one layer under the Dock");
  const cast = d([".dock-cast"]);
  assert.strictEqual(cast.height, "260px");
  assert.strictEqual(cast.background, "radial-gradient(90% 100% at 50% 100%, color-mix(in oklab, var(--glow) var(--cast-mix), transparent) 0%, transparent 100%)");
  const room = d([".room"]);
  assert.strictEqual(room.background, "var(--glow-room)", "never plain bg0: the lower half stays in the show's colour");
  assert.strictEqual(room.isolation, "isolate");
  assert.strictEqual(room["--rs1"], "calc(var(--safe-top) + 196px)");
  assert.strictEqual(room["--rs2"], "calc(var(--safe-top) + 276px)");
  const art = d([".room::before"]);
  assert.strictEqual(art.filter, "blur(64px) saturate(130%)");
  assert.strictEqual(art.opacity, "var(--room-art-opacity)");
  const scrim = d([".room::after"]).background;
  assert.strictEqual(scrim, "linear-gradient(180deg, var(--scrim-head) 0, var(--scrim-top) calc(var(--safe-top) + 56px), var(--scrim-top) var(--rs1), var(--scrim-mid) var(--rs2), var(--scrim-low) 100%)",
    "the scrim's stops are pixels from the top, never percentages");
  assert.ok(!/%\s*,|\d%\)/.test(scrim.replace("100%)", "")), "no percentage stop except the last");
  const lit = d([".lit-art"]);
  assert.match(lit["box-shadow"], /^var\(--shadow-1\), 0 0 var\(--lit-r, 40px\) calc\(var\(--lit-r, 40px\) \/ -4\) color-mix\(in oklab, var\(--art-glow, var\(--glow\)\) var\(--lit-mix\), transparent\)$/);
  assert.deepStrictEqual([40, 64, 96].map((n) => d([`.lit-${n}`])["--lit-r"]), ["40px", "64px", "96px"]);
  assert.deepStrictEqual(find([".dock-cast[data-state=\"idle\"]", "[data-posture=\"car\"] .dock-cast", "[data-posture=\"car\"] .dock-fade", "[data-posture=\"car\"] .dock"]).display, "none",
    "idle and car posture hide the cast, the fade and the Dock");
});

test("the Room's artwork is a var set by script, never an inline style: --room-art defaults to none and is read as a var", () => {
  /* MUTATION: delete `--room-art: none;` from .room -> red (a var() with no value makes the whole
     background invalid and the Glow gradient goes with it). */
  assert.strictEqual(find([".room"])["--room-art"], "none");
  assert.match(find([".room::before"]).background, /^var\(--room-art\) center \/ cover$/);
  const layered = find([".room::before"], [SUPPORTS]).background;
  assert.match(layered, /^var\(--room-art\) center \/ cover, radial-gradient\(120% 55% at 50% 18%, color-mix\(in oklab, var\(--glow\) 55%, transparent\), transparent 75%\)$/);
});

test("every material fallback lives once, in one place: no backdrop-filter, reduced transparency, more contrast, forced colours", () => {
  /* MUTATION: delete `backdrop-filter: none` from the prefers-reduced-transparency block, or change its
     `background: var(--bg1)` to `var(--glow-veil)` -> red. */
  const css = stripComments(RAW);
  for (const q of ["@supports not ((backdrop-filter: blur(1px))", "@media (prefers-reduced-transparency: reduce)", "@media (prefers-contrast: more)", "@media (forced-colors: active)"]) {
    assert.strictEqual(css.split(q).length - 1, 1, `${q} appears exactly once`);
  }
  const at = (q) => RULES.filter((r) => r.atRules.some((a) => a.startsWith(q)));
  const noBf = at("@supports not ((backdrop-filter")[0];
  assert.deepStrictEqual(noBf.selectors, [".veil"]); assert.strictEqual(noBf.decls.find((d) => d.prop === "background").value, "var(--bg1)");
  const reducedT = at("@media (prefers-reduced-transparency")[0];
  const rt = Object.fromEntries(reducedT.decls.map((d) => [d.prop, d.value]));
  assert.strictEqual(rt["backdrop-filter"], "none"); assert.strictEqual(rt["-webkit-backdrop-filter"], "none"); assert.strictEqual(rt.background, "var(--bg1)");
  assert.strictEqual(find([".lit-art"], ["@media (prefers-reduced-transparency: reduce)"])["box-shadow"], "var(--shadow-1)", "Lit art drops its glow, keeps its rim shadow");
  const more = find([".veil"], ["@media (prefers-contrast: more)"]);
  assert.strictEqual(more.background, "var(--bg0)"); assert.strictEqual(more["backdrop-filter"], "none");
  assert.strictEqual(find([".room::before"], ["@media (prefers-contrast: more)"]).opacity, "0.35");
  assert.strictEqual(find([".raised"], ["@media (prefers-contrast: more)"])["box-shadow"], "inset 0 0 0 1px var(--text-3)");
  assert.strictEqual(find([".lit-art"], ["@media (forced-colors: active)"])["box-shadow"], "none");
});

/* ------------------------------------------------------------- reduced motion */
test("Reduce Motion is ONE block and it covers every transition and animation this file declares", () => {
  /* Same shape as ui-tokens' test for styles.css. MUTATIONS: add `transition: opacity var(--m-ui) var(--e-out)`
     to `.dock` -> red, naming it (add `.dock` to the block's selector list, in the same change, to fix);
     add a second @media (prefers-reduced-motion) block -> red; delete `.room::before { transition: none }` -> red. */
  const css = stripComments(RAW);
  assert.strictEqual(css.split("prefers-reduced-motion").length - 1, 1, "exactly one reduced-motion block in ui/tokens.css");
  const block = RULES.filter((r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const covered = new Set(block.flatMap((r) => r.selectors));
  for (const need of [":root", ".ag *", ".ag *::before", ".ag *::after", ".room *", ".room::before", "::view-transition-group(*)"]) assert.ok(covered.has(need), `the block names ${need}`);
  const universal = block.find((r) => r.selectors.includes(".ag *"));
  const u = Object.fromEntries(universal.decls.map((d) => [d.prop, d.value]));
  assert.strictEqual(u["transition-duration"], "200ms !important", "a movement becomes a 200ms crossfade");
  assert.strictEqual(u["transition-property"], "opacity, color, background-color !important", "and only opacity and colour may transition");
  assert.strictEqual(u["animation-duration"], "1ms !important");
  assert.strictEqual(u["animation-iteration-count"], "1 !important");
  const vt = block.find((r) => r.selectors.includes("::view-transition-group(*)"));
  assert.strictEqual(vt.decls.find((d) => d.prop === "animation").value, "none !important", "View Transitions do not animate");
  assert.strictEqual(block.find((r) => sameSel(r, [".room::before"])).decls.find((d) => d.prop === "transition").value, "none !important", "the Room does not drift");
  /* every transition/animation declared outside the block is under a selector the block covers */
  const baseOf = (s) => s.replace(/::[\w-]+(\([^)]*\))?$/, "");
  const inScope = (s) => { const b = baseOf(s); return b === ":root" || b === ".ag" || b === ".room" || b.startsWith(".ag ") || b.startsWith(".room ") || covered.has(s) || covered.has(b); };
  const moving = [];
  let seen = 0;
  for (const r of RULES) {
    if (r.atRules.some((a) => /prefers-reduced-motion/.test(a)) || r.selectors[0].startsWith("@")) continue;
    for (const d of r.decls) {
      if (!/^(transition|animation)/.test(d.prop) || d.value === "none") continue;
      seen++;
      for (const s of r.selectors) if (!inScope(s)) moving.push(`${s} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(moving, [], "a transition or animation Reduce Motion does not cover");
  assert.ok(seen >= 2, `fixture assumption: the file declares transitions (the Glow on :root and .room) (${seen})`);
  /* every duration a transition reads is a motion token */
  for (const r of RULES) for (const d of r.decls) if (d.prop === "transition" && !r.atRules.some((a) => /reduced-motion/.test(a)))
    assert.match(d.value, /var\(--m-(micro|ui|sheet|room)\)/, `${r.selectors}: transition duration is a token`);
});

test("the block does not reach legacy markup: every selector in it is rooted at :root, .ag, .room or a View Transition pseudo", () => {
  /* The hard limit is "one block", but styles.css keeps its own until the last legacy screen is gone, and an
     unscoped `*` here would re-time (and re-enable, via !important) every transition the old app has.
     MUTATION: change `.ag *` to `*` in the block -> red. */
  const block = RULES.filter((r) => r.atRules.some((a) => /prefers-reduced-motion/.test(a)));
  for (const s of block.flatMap((r) => r.selectors)) assert.match(s, /^(:root|\.ag|\.room|::view-transition-(group|old|new)\(\*\))/, `unscoped selector in the block: ${s}`);
  assert.strictEqual(stripComments(STYLES).split("prefers-reduced-motion").length - 1, 1, "styles.css still has its own single block (ui-tokens guards it)");
});

/* ------------------------------------------------------------------- wiring */
test("the stylesheet is wired into the page and every shipping path: index.html, the SW generation, the web dist and the app bundle", async () => {
  /* MUTATION: remove "ui/tokens.css" from SHELL in tools/ci/generate-manifest.mjs (or tools/web/prepare-dist.mjs,
     or SHELL_FILES in tools/mobile/prepare-webdir.mjs), or drop the <link> from index.html -> red, naming the path.
     A stylesheet that ships to the page but not into the generation is the one file sw.js could not verify. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepStrictEqual(links, ["styles.css", "ui/tokens.css", "ui/primitives.css", "ui/dock.css", "ui/library.css", "ui/today.css", "ui/onboarding.css", "ui/foray-detail.css", "ui/settings.css", "ui/show.css", "ui/browse.css", "ui/forays.css"], "legacy, tokens, scoped phase-3 primitives, then the Dock, then the adopted Today, onboarding, Foray detail, Settings and show screens");
  const shell = (rel, startRe) => { const s = read(rel); const m = startRe.exec(s); assert.ok(m, `${rel}: shell list found`); return m[1]; };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/tokens\.css"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/tokens\.css"/, "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/tokens.css"), "prepare-webdir SHELL_FILES");
  assert.ok(pw.buildPlan(ROOT).includes("ui/tokens.css"), "the app bundle's copy plan carries it");
  /* The Dock's own stylesheet ships down the same four paths (MUTATION: remove "ui/dock.css" from any one of them). */
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/dock\.css"/, "generate-manifest SHELL carries the Dock's stylesheet");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/dock\.css"/, "prepare-dist SHELL carries the Dock's stylesheet");
  assert.ok(pw.SHELL_FILES.includes("ui/dock.css"), "prepare-webdir SHELL_FILES carries the Dock's stylesheet");
  assert.ok(pw.buildPlan(ROOT).includes("ui/dock.css"), "and the app bundle's copy plan");
  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(vercel.headers.some((h) => h.source === "/ui/(.*)" && /must-revalidate/.test(JSON.stringify(h.headers))), "/ui/ is revalidated like styles.css, so a token change is never served stale");
});
