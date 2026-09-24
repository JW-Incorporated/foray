/* U-01 (docs/ui-transition-plan.md): the ui-v2 design tokens.
 *
 * Two floors, both on the SAME block for a reason: it is easy to define every
 * token AND leak a raw hex value elsewhere, which defeats the entire point of
 * a token system (a designer changing `--amber` in one place would silently
 * miss every hardcoded copy). Neither floor alone catches that.
 *
 * MUTATION: hardcode any one of the nine palette hex values anywhere in
 * styles.css outside the `body.ui-v2 { ... }` definition block -> the second
 * test goes red. Run individually and confirmed red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

/* The nine tokens named in docs/ui-transition-plan.md U-01 and issue #127,
   with the exact hex values the card specifies. Order matches the card's own
   listing so a diff against the spec is a visual one. */
const TOKENS = {
  "--bg": "#151119",
  "--surface": "#1F1A26",
  "--surface2": "#2A2333",
  "--line": "#332B3E",
  "--text": "#F4F0E8",
  "--muted": "#9C93A8",
  "--faint": "#6E6579",
  "--amber": "#F2A33C",
  "--violet": "#A78BFA",
};

/* Isolates the `body.ui-v2 { ... }` block that DEFINES the tokens (the first
   rule with that exact selector — the one this file writes the custom
   properties into, not a later rule that merely USES var(--amber) etc). A
   plain string search for the selector text would also match a comment or a
   nested reference; anchoring on the brace-delimited block and taking only
   its first occurrence is what makes "outside this block" in the second test
   mean something precise. */
function tokenBlock() {
  const start = CSS.indexOf("body.ui-v2 {");
  assert.notEqual(
    start, -1,
    "styles.css has no `body.ui-v2 {` block at all -- the ui-v2 token scope is gone"
  );
  const end = CSS.indexOf("\n}", start);
  assert.notEqual(end, -1, "the body.ui-v2 token block never closes at column 0");
  return { start, end: end + 2, text: CSS.slice(start, end) };
}

test("every ui-v2 token is defined on the body.ui-v2 scope with the spec's hex value", () => {
  const { text } = tokenBlock();
  const missing = [];
  for (const [name, hex] of Object.entries(TOKENS)) {
    const re = new RegExp(
      `${name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}:\\s*${hex}\\b`,
      "i"
    );
    if (!re.test(text)) missing.push(`${name}: ${hex}`);
  }
  assert.deepStrictEqual(
    missing, [],
    `these ui-v2 tokens are missing or wrong inside body.ui-v2: ${missing.join(", ")}`
  );
});

test("no ui-v2 palette hex literal appears outside the token definition block", () => {
  const { start, end } = tokenBlock();
  const before = CSS.slice(0, start);
  const after = CSS.slice(end);
  const outsideLines = (before + "\n" + after).split(/\r?\n/);

  /* Track comment state across lines so a continuation line inside a
     multiline /* ... *\/ comment (no leading `*` or `/*` of its own) is
     still recognised as prose, not code. */
  const offenders = [];
  for (const [name, hex] of Object.entries(TOKENS)) {
    const re = new RegExp(hex, "i");
    let comment = false;
    for (const rawLine of outsideLines) {
      const trimmed = rawLine.trim();
      const wasInComment = comment;
      if (/\/\*/.test(trimmed) && !/\*\//.test(trimmed)) comment = true;
      else if (/\*\//.test(trimmed)) comment = false;
      if (!re.test(rawLine)) continue;
      if (wasInComment || /^\/\*/.test(trimmed) || /^\*/.test(trimmed)) continue;
      /* A DIFFERENT custom property declared with this same value (e.g.
         `--seg-narration: #A78BFA` in :root, which predates ui-v2 and is the
         SegmentStrip's own pre-existing narration colour -- a legitimate
         alias by a different name, not a hardcoded copy of the ui-v2 token).
         Anything that is not itself a `--name: #hex` declaration is a real,
         unnamed hardcode and must fail. */
      if (/^--[\w-]+:\s*#[0-9a-f]{3,8}\b/i.test(trimmed)) continue;
      offenders.push(`${name} (${hex}): "${trimmed}"`);
    }
  }
  assert.deepStrictEqual(
    [...new Set(offenders)], [],
    "a ui-v2 palette value is hardcoded outside the token block, and outside any " +
      `other named custom property, so it cannot be tracing var(--token):\n${[...new Set(offenders)].join("\n")}`
  );
});

/* KILLED BY: deleting the only consumer of --amber (`.ui-v2-mine`) or
   --violet (`.ui-v2-authored`) so the declared token becomes orphaned --
   defined but never read via var(). NOT killed by renaming the DECLARATION
   alone (e.g. `--amber:` -> `--amber-x:`): that leaves `var(--amber)` in the
   consuming rule intact, so this test stays green on that mutation -- but
   the first test above ("every ui-v2 token is defined...") catches that case
   instead, since the renamed declaration no longer matches `--amber: #F2A33C`.
   The two tests together cover both failure directions; this one specifically
   guards against "declared but nothing reads it". */
test("the amber/violet split is actually consumed, not just declared", () => {
  assert.match(
    CSS, /var\(--amber\)/,
    "--amber is declared but nothing in styles.css reads it via var(--amber)"
  );
  assert.match(
    CSS, /var\(--violet\)/,
    "--violet is declared but nothing in styles.css reads it via var(--violet)"
  );
});

/* The self-hosted fonts (U-01: Fraunces display/italic wordmark + DM Sans
   body), self-hosted under fonts/ per issue #127's ruling against a Google
   Fonts origin. KILLED BY: pointing an @font-face src at a fonts.gstatic.com
   (or any http(s)) URL instead of a local fonts/*.woff2 path. */
test("fonts are self-hosted under fonts/, never fetched from a third-party origin", () => {
  const faceBlocks = [...CSS.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.ok(faceBlocks.length >= 3, "expected at least 3 @font-face rules (Fraunces x2, DM Sans)");
  for (const block of faceBlocks) {
    const src = /src:\s*url\(["']?([^"')]+)["']?\)/.exec(block);
    assert.ok(src, `an @font-face rule has no src: ${block}`);
    assert.ok(
      src[1].startsWith("fonts/") && src[1].endsWith(".woff2"),
      `@font-face src "${src[1]}" is not a local fonts/*.woff2 path -- self-hosting is not optional (issue #127)`
    );
  }
  for (const rel of [
    "fonts/fraunces-variable.woff2",
    "fonts/fraunces-italic-variable.woff2",
    "fonts/dm-sans-variable.woff2",
  ]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, rel)),
      `${rel} is referenced by styles.css but not on disk`
    );
  }
});

/* ======================================================================
   THEME I (audit 2026-09-22): NO LIVE RULE MAY READ A TOKEN v2 DOES NOT OWN
   ======================================================================

   WHY THE TESTS ABOVE PASSED WHILE THE PALETTE WAS BROKEN. They enumerate
   what ui-v2 ADDED — nine names, their hexes, no stray copies. None of that
   says anything about the names v1 rules still READ. Five of those
   (`--surface-2`, `--text-dim`, `--accent`, `--gold`, `--shadow`) were never
   defined on `body.ui-v2`, so on a phone set to Light they resolved to
   `:root`'s light block while the page stayed dark: near-white artwork
   blocks, invisible shadows, v1 blue in five controls, gold where amber
   belongs. And the segment strip's tones, declared only on `:root`, flipped
   to variants tuned for #faf7f2 — a black hatch on a near-black page.

   So this test enumerates what is READ, not what was added: every
   `var(--name)` in a live declaration, each checked against where the name is
   defined. A name passes when:
     (a) a rule whose selector list includes `body.ui-v2` declares it — the
         v2 page owns it outright; or
     (b) it is component-scoped — declared only by ordinary rules (never on
         `:root`, never inside a colour-scheme query), so its value comes
         from the component it is set on; or
     (c) JavaScript writes it, and the write is found in the source (a claim,
         checked — not an allowlist that can outlive the writer); or
     (d) it is a `:root` STRUCTURAL token: no colour in its value, and no
         `prefers-color-scheme` block redefines it, so there is no second
         value for the OS to choose.
   Anything else is a v1 value that can reach a v2 page, and fails.

   MUTATIONS (each run, each red):
     - delete `--gold: var(--amber);` from the body.ui-v2 block -> fails
       naming --gold (a colour on :root, overridden by nothing v2 owns);
     - change the segment palette's selector back to plain `:root` -> fails
       naming every --seg-* tone and --seg-hatch (redefined by the light block);
     - rename the `--kb-inset` setProperty in app.js -> fails naming
       --kb-inset (read by CSS, written by nobody). */

/** Every rule in the sheet with its at-rule context, comments removed. A tiny
    brace walker rather than a regex, because the colour-scheme blocks NEST a
    `:root { }` inside `@media { }` and a flat regex cannot tell the light
    `:root` from the dark one. */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules = [];
  const stack = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      /* A style rule: its body runs to the next close brace (style-rule
         bodies in this file never nest). */
      const end = src.indexOf("}", i);
      const body = src.slice(i + 1, end);
      rules.push({
        selectors: prelude.split(",").map((s) => s.trim()),
        atRules: stack.slice(),
        decls: body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
          const c = d.indexOf(":");
          return { prop: d.slice(0, c).trim(), value: d.slice(c + 1).trim() };
        }),
      });
      i = end;
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

const RULES = parseRules(CSS);
const APP_JS = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const PLAYER_JS = fs.readdirSync(path.join(ROOT, "player"))
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  .map((f) => fs.readFileSync(path.join(ROOT, "player", f), "utf8"))
  .join("\n");

const inSchemeQuery = (d) => d.atRules.some((a) => /prefers-color-scheme/.test(a));
const isColour = (v) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/i.test(v);

function tokenOwnership() {
  const reads = new Map(); // name -> [selector text of each reading rule]
  const defs = new Map();  // name -> [{ selectors, atRules, value }]
  for (const r of RULES) {
    for (const d of r.decls) {
      if (d.prop.startsWith("--")) {
        if (!defs.has(d.prop)) defs.set(d.prop, []);
        defs.get(d.prop).push({ selectors: r.selectors, atRules: r.atRules, value: d.value });
      }
      for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!reads.has(m[1])) reads.set(m[1], []);
        reads.get(m[1]).push(r.selectors.join(", "));
      }
    }
  }
  const jsWrites = (name) =>
    [APP_JS, PLAYER_JS].some((src) => src.includes(`setProperty("${name}"`) || src.includes(`setProperty('${name}'`));

  const verdicts = new Map();
  for (const name of reads.keys()) {
    const ds = defs.get(name) || [];
    const v2Owned = ds.some((d) => d.atRules.length === 0 && d.selectors.includes("body.ui-v2"));
    const onRoot = ds.filter((d) => d.selectors.includes(":root"));
    const componentScoped = ds.length > 0 && onRoot.length === 0 && !ds.some(inSchemeQuery);
    const structural = onRoot.length > 0
      && !ds.some(inSchemeQuery)
      && onRoot.every((d) => !isColour(d.value));
    let why = null;
    if (v2Owned) why = "v2";
    else if (componentScoped) why = "component";
    else if (ds.length === 0 && jsWrites(name)) why = "js";
    else if (structural) why = "structural";
    verdicts.set(name, why);
  }
  return { reads, defs, verdicts };
}

test("no live rule reads a token that the ui-v2 page does not own", () => {
  const { reads, verdicts } = tokenOwnership();
  const leaks = [...verdicts].filter(([, why]) => why === null).map(([name]) =>
    `${name} (read by e.g. \`${reads.get(name)[0]}\`)`);
  assert.deepStrictEqual(leaks, [],
    "these tokens are read by live rules but can resolve to a v1 value on a ui-v2 page — " +
      "define or alias them inside `body.ui-v2`:\n" + leaks.join("\n"));
});

test("every token a colour-scheme query redefines is re-owned on the ui-v2 scope", () => {
  /* The narrower half of the rule above, stated on its own because it is the
     failure that actually reached a screen: anything the OS appearance can
     change must have a body.ui-v2 answer, since the v2 page does not change
     with the OS. (Only names something reads — a light-block name nothing
     reads is dead weight, not a leak.)
     MUTATION: drop `body.ui-v2` from the segment palette's selector list ->
     every --seg-* tone is named. */
  const { defs, reads } = tokenOwnership();
  const unowned = [];
  for (const [name, ds] of defs) {
    if (!ds.some(inSchemeQuery) || !reads.has(name)) continue;
    const v2 = ds.some((d) => d.atRules.length === 0 && d.selectors.includes("body.ui-v2"));
    if (!v2) unowned.push(name);
  }
  assert.deepStrictEqual(unowned, [],
    `the OS colour scheme can change these on a ui-v2 page: ${unowned.join(", ")}`);
});

test("the JS-written tokens the ownership check trusts are really written by JS", () => {
  /* Keeps clause (c) above from becoming a blanket excuse: a name only passes
     as "js" when a setProperty for it exists. Pinned positively for the four
     known writers so deleting one surfaces here by name as well.
     MUTATION: rename `setProperty("--kb-inset"` in app.js -> red. */
  const { verdicts } = tokenOwnership();
  for (const name of ["--kb-inset", "--fp-sheet-dy", "--zoom-origin", "--zoom-scale"]) {
    assert.strictEqual(verdicts.get(name), "js", `${name} is read by CSS but nothing in app.js/player/ writes it`);
  }
});

/* ======================================================================
   "Delete everything" reads as destructive (audit 2026-09-22)
   ======================================================================
   The confirm button carries `fy-sheet-go dd-go`. Its red lived on `.dd-go`
   (0,1,0) while `body.ui-v2 .fy-sheet-go` (0,2,1) painted every sheet's
   primary button violet — so the one control that erases the listener's data
   looked exactly like Play. This resolves the cascade for that element the way
   a browser would, over the simple selectors this file uses, rather than
   trusting that some rule mentions `.dd-go`.

   MUTATION: delete the `body.ui-v2 .fy-sheet-go.dd-go` rule (L6's shape, kept
   at integration; its disabled twin follows it) ->
   the winner is the violet primary and this fails naming it. */

function specificity(sel) {
  const s = sel.replace(/:not\(([^)]*)\)/g, " $1"); // :not() counts as its argument
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const tags = (s.replace(/[#.:][\w-]+|\[[^\]]+\]/g, " ").match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, cls, tags];
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Does `sel` match an ENABLED <button class="...classes"> inside
    <body class="ui-v2">? Only the shapes this question needs: an optional
    `body.ui-v2 ` ancestor and a final compound of an optional `button`,
    classes and an optional `:not(:disabled)`. A selector requiring
    `:disabled` does not match an enabled button and is skipped. */
function matchesEnabledButton(sel, classes) {
  const m = /^(?:body\.ui-v2\s+)?((?:button)?(?:\.[\w-]+)+(?::not\(:disabled\))?)$/.exec(sel);
  if (!m) return false;
  const need = (m[1].match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  return need.every((c) => classes.includes(c));
}

test("the Delete-everything button is painted by the danger token, not the violet primary", () => {
  const classes = ["fy-sheet-go", "dd-go"];
  let win = null;
  RULES.forEach((r, order) => {
    if (r.atRules.length) return;
    for (const sel of r.selectors) {
      if (!matchesEnabledButton(sel, classes)) continue;
      const bg = r.decls.filter((d) => d.prop === "background" || d.prop === "background-color").pop();
      if (!bg) continue;
      const spec = specificity(sel);
      if (!win || cmpSpec(spec, win.spec) > 0 || (cmpSpec(spec, win.spec) === 0 && order >= win.order)) {
        win = { sel, spec, order, value: bg.value };
      }
    }
  });
  assert.ok(win, "no rule paints the delete button's background at all");
  assert.match(win.value, /var\(--danger\)/,
    `the delete confirm's background is won by \`${win.sel}\` (${win.value}) — it must read var(--danger)`);
  assert.ok(/--danger:\s*#[0-9a-f]{3,8}/i.test(tokenBlock().text),
    "--danger must be defined in the body.ui-v2 token block");
});

/* ---------- --faint is for disabled and decorative only (audit 2026-09-22, qa row 79) ----------
   `--faint` #6E6579 is 3.1:1 on --surface and 2.7:1 on --surface2: under the
   4.5:1 text minimum everywhere, and on --surface2 under even the 3:1 floor for
   a control glyph. It was the token reached for on real copy ("Not available to
   play", an aged-out title, the player's timing note, "remove this playlist",
   an idle tab's label) and on Up Next's destructive ✕. The rule this pins is
   the audit's: text and live controls take `--muted`; `--faint` paints only a
   control that is disabled, a border, or one of the named exceptions below,
   each with its measured reason.
   MUTATION: put `color: var(--faint)` back on `body.ui-v2 .not-playable` (or on
   `button.up-next-remove`) -> the first test goes red. */
function hexLum(hex) {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [hexLum(a), hexLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const FAINT_TEXT_EXCEPTIONS = {
  /* A utility with no user: the census below keeps it that way. (The resting
     ☆ was the other exception, at 3.08:1 as a non-text glyph; visual pass 1's
     review moved it to --muted — a live control at the secondary-label weight,
     not a hair over the floor with a 1px stroke.) */
  "body.ui-v2 .ui-v2-text-faint": () => true,
};

test("no text or live control is painted in --faint", () => {
  const offenders = [];
  for (const r of RULES) {
    const paints = r.decls.some((d) => d.prop === "color" && /var\(--faint\b/.test(d.value));
    if (!paints) continue;
    for (const sel of r.selectors) {
      if (/:disabled\b/.test(sel) && !/:not\(:disabled\)/.test(sel)) continue;
      const ok = FAINT_TEXT_EXCEPTIONS[sel];
      if (ok && ok()) continue;
      offenders.push(sel);
    }
  }
  assert.deepEqual(offenders, [],
    `these selectors paint text or a live control in --faint (under 4.5:1): ${offenders.join(", ")} — use --muted`);
});

test("the token the copy moved to is readable on both surfaces, and --faint is not", () => {
  for (const bg of ["--surface", "--surface2", "--bg"]) {
    assert.ok(contrast(TOKENS["--muted"], TOKENS[bg]) >= 4.5, `--muted on ${bg} is under 4.5:1`);
  }
  assert.ok(contrast(TOKENS["--faint"], TOKENS["--surface2"]) < 3,
    "if --faint was lightened past 3:1 the exception list above can be revisited");
});

test("the --faint text utility has no user in the shipped markup", () => {
  const sources = ["app.js", "index.html", ...fs.readdirSync(path.join(ROOT, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).map((f) => `player/${f}`)];
  const users = sources.filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").includes("ui-v2-text-faint"));
  assert.deepEqual(users, [], "a new user of .ui-v2-text-faint paints text at 3:1 — use .ui-v2-text-muted");
});

/* ======================================================================
   VISUAL PASS 1 (2026-09-23): THE STRUCTURAL FAMILIES — radius, type, elevation
   ======================================================================
   The palette rule above ("no raw hex outside the token block") had a gap
   the audit measured: 74 radii in 12 values with `--radius` the minority
   (qa row 60), Georgia beside Fraunces on one screen (qa rows 43/47/51), and
   seven ad-hoc shadows. Each family is now ONE scale on `:root` — structural,
   no colour, so the ownership rule's clause (d) covers it — and these tests
   enforce the families the way the palette test enforces colours: every live
   declaration reads a token, and the scale is declared in order.

   MUTATIONS (each run, each red):
     - `border-radius: 12px` on any rule -> the radius test names the rule;
     - `font-family: var(--serif)` on `.topbar h1 a` -> the type test names it;
     - `font-size: 0.78rem` anywhere -> named;
     - `box-shadow: 0 6px 24px rgba(0,0,0,.28)` -> named;
     - swap `--radius-md` and `--radius-lg`'s values -> the order test fails. */

const ROOT_DECLS = (() => {
  const out = new Map();
  for (const r of RULES) {
    if (r.atRules.length || !r.selectors.includes(":root")) continue;
    for (const d of r.decls) if (d.prop.startsWith("--")) out.set(d.prop, d.value);
  }
  return out;
})();
const pxOf = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };
const remOf = (v) => { const m = /^(\d+(?:\.\d+)?)rem$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null; };
/** The last value `prop` gets on exactly `sel`, among unconditional rules. */
function lastOn(sel, prop) {
  let v = null;
  for (const r of RULES) {
    if (r.atRules.length || !r.selectors.includes(sel)) continue;
    for (const d of r.decls) if (d.prop === prop) v = d.value;
  }
  return v;
}

test("the radius scale is declared once, in order, and every corner reads it", () => {
  const scale = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];
  const px = scale.map((t) => pxOf(ROOT_DECLS.get(t)));
  assert.ok(px.every((n) => n != null), `every radius step is a px value on :root: ${px.join(",")}`);
  for (let i = 1; i < px.length; i++) assert.ok(px[i] > px[i - 1], `${scale[i]} must be larger than ${scale[i - 1]}`);
  assert.strictEqual(ROOT_DECLS.get("--radius-pill"), "999px");
  assert.strictEqual(ROOT_DECLS.get("--radius-round"), "50%");
  assert.ok(!ROOT_DECLS.has("--radius"), "`--radius` is retired; use a step of the scale");

  const offenders = [];
  for (const r of RULES) {
    for (const d of r.decls) {
      if (!/^border(-(top|bottom)-(left|right))?-radius$/.test(d.prop)) continue;
      const parts = d.value.split(/\s+(?![^(]*\))/);
      const ok = parts.every((p) => p === "0" || /^var\(--radius-(xs|sm|md|lg|xl|pill|round)\)$/.test(p));
      if (!ok) offenders.push(`${r.selectors.join(", ")} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(offenders, [], "a corner is not on the radius scale:\n" + offenders.join("\n"));
});

test("two faces by rule: every font-family reads --font-display or --font-body", () => {
  /* `--serif` and `--sans` survive only as the fallback stacks INSIDE the two
     face tokens. The diagnostics log keeps its monospace by name: it is a
     column-aligned record, not prose. */
  assert.match(ROOT_DECLS.get("--font-display") || "", /^"Fraunces",\s*var\(--serif\)$/);
  assert.match(ROOT_DECLS.get("--font-body") || "", /^"DM Sans",\s*var\(--sans\)$/);
  const ALLOWED = new Set(["var(--font-display)", "var(--font-body)", "inherit"]);
  const offenders = [];
  for (const r of RULES) {
    if (r.selectors.some((s) => /^@font-face/.test(s))) continue;
    for (const d of r.decls) {
      if (d.prop !== "font-family") continue;
      if (ALLOWED.has(d.value)) continue;
      if (r.selectors.includes(".diag-text") && /monospace/.test(d.value)) continue;
      offenders.push(`${r.selectors.join(", ")} { font-family: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(offenders, [], "a rule names a face outside the two tokens:\n" + offenders.join("\n"));
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /font-family:\s*var\(--(serif|sans)\)/,
    "no live rule reads --serif/--sans directly");
});

test("the type scale is declared in order and every font-size reads it", () => {
  const scale = ["--fs-2xs", "--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl", "--fs-glyph"];
  const rem = scale.map((t) => remOf(ROOT_DECLS.get(t)));
  assert.ok(rem.every((n) => n != null), `every type step is a rem value on :root: ${rem.join(",")}`);
  for (let i = 1; i < 7; i++) assert.ok(rem[i] > rem[i - 1], `${scale[i]} must be larger than ${scale[i - 1]}`);
  const offenders = [];
  for (const r of RULES) {
    for (const d of r.decls) {
      if (d.prop !== "font-size") continue;
      if (/^var\(--fs-(2xs|xs|sm|md|lg|xl|2xl|glyph)\)$/.test(d.value) || d.value === "inherit") continue;
      offenders.push(`${r.selectors.join(", ")} { font-size: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(offenders, [], "a size is not on the type scale:\n" + offenders.join("\n"));
});

test("elevation is four tokens, owned by v2, and every box-shadow reads one", () => {
  const family = ["--shadow-sm", "--shadow", "--shadow-lift", "--shadow-up"];
  const v2 = tokenBlock().text;
  for (const t of family) {
    assert.ok(ROOT_DECLS.has(t), `${t} is declared on :root for v1`);
    assert.ok(new RegExp(`${t}:\\s*0 `).test(v2), `${t} is restated inside body.ui-v2 (it carries a colour)`);
  }
  const offenders = [];
  for (const r of RULES) {
    for (const d of r.decls) {
      if (d.prop !== "box-shadow") continue;
      if (d.value === "none" || /^var\(--shadow(-sm|-lift|-up)?\)$/.test(d.value)) continue;
      offenders.push(`${r.selectors.join(", ")} { box-shadow: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(offenders, [], "a shadow is not on the elevation scale:\n" + offenders.join("\n"));
});

test("the two heading kinds: eyebrows are the text face, section titles the display face", () => {
  /* qa row 51: half the section labels were Fraunces, half Georgia. Every
     eyebrow now reads the same four declarations; a section title is the
     other kind. MUTATION: give `.fy-sources h3` `font-family:
     var(--font-display)` -> red. */
  const eyebrows = [".ep-description h3", ".ep-more h3", ".fy-sources h3", ".show-forays-h", ".lib-section-head", ".drawer-section-label"];
  for (const sel of eyebrows) {
    assert.strictEqual(lastOn(sel, "font-family"), "var(--font-body)", `${sel} is an eyebrow: text face`);
    assert.strictEqual(lastOn(sel, "font-size"), "var(--fs-xs)", `${sel} at the caption step`);
    assert.strictEqual(lastOn(sel, "text-transform"), "uppercase", `${sel} is small caps`);
  }
  for (const sel of ["body.ui-v2 .hv2-title", ".fy-slot h3", ".page-head h2"]) {
    assert.strictEqual(lastOn(sel, "font-family"), "var(--font-display)", `${sel} is a title: display face`);
    assert.notStrictEqual(lastOn(sel, "text-transform"), "uppercase", `${sel} is sentence case`);
  }
  /* And no v2 override quietly puts a display face back on an eyebrow. */
  for (const r of RULES) {
    if (!r.selectors.some((s) => eyebrows.some((e) => s === `body.ui-v2 ${e}`))) continue;
    assert.ok(!r.decls.some((d) => d.prop === "font-family"), `${r.selectors.join(", ")} must not restate the face`);
  }
});

test("the wordmark is one mark: the topbar and the greeting both draw Fraunces italic", () => {
  /* qa row 47. MUTATION: drop `class="wordmark"` from index.html's <h1><a>,
     or `font-style: italic` from `.topbar h1 a` -> red. */
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /<h1><a class="wordmark" href="#\/">4a<\/a>/);
  for (const sel of [".topbar h1 a", "body.ui-v2 .hv2-greeting-brand"]) {
    assert.strictEqual(lastOn(sel, "font-family"), "var(--font-display)", sel);
    assert.strictEqual(lastOn(sel, "font-style"), "italic", sel);
  }
});

/* ---------- the review of visual pass 1 (2026-09-23) ---------- */

test("the resting ☆ is a live control in --muted, amber when on", () => {
  /* MUTATION: `body.ui-v2 button.star { color: var(--faint) }` -> red here,
     and the --faint census above names it too. */
  assert.strictEqual(lastOn("body.ui-v2 button.star", "color"), "var(--muted)");
  assert.strictEqual(lastOn("body.ui-v2 button.star.on", "color"), "var(--amber)");
  assert.ok(contrast(TOKENS["--muted"], TOKENS["--surface"]) >= 4.5, "readable on the row it sits in");
});

test("dark is declared, not just painted: one colour-scheme, one authored focus ring", () => {
  /* `content="dark light"` on a dark-only palette let every UA-painted surface
     (the focus ring on a landed heading, form-control chrome, the default link
     colour) follow the OS scheme over a #151119 page. MUTATION: put
     `content="dark light"` back, or delete the `:focus-visible` rule -> red. */
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /<meta name="color-scheme" content="dark">/, "index.html declares the one scheme the sheet ships");
  assert.doesNotMatch(html, /content="dark light"|content="light dark"/);
  assert.strictEqual(lastOn("body.ui-v2", "color-scheme"), "dark", "the v2 scope tells the UA the same");
  assert.match(lastOn(":focus-visible", "outline") || "", /^2px solid var\(--amber\)$/, "the ring is ours, in the listener's colour");
  assert.strictEqual(lastOn(":focus-visible", "outline-offset"), "2px");
});

test("every editorial link inside a note is authored: violet, underlined, never the UA default", () => {
  /* Library's empty state ("build one on the Create tab") painted #9e9eff or
     #0000ee depending on the OS. MUTATION: delete `body.ui-v2 .note a` -> red. */
  assert.strictEqual(lastOn("body.ui-v2 .note a", "color"), "var(--violet)");
  assert.strictEqual(lastOn("body.ui-v2 .note a", "text-decoration"), "underline");
  /* And the rule has a user: every `<a` written inside a `.note` in app.js. */
  const notes = [...APP_JS.matchAll(/<p class="note[^"]*">(?:(?!<\/p>)[\s\S])*<a /g)];
  assert.ok(notes.length >= 1, "at least one note carries an inline link (Library's empty state)");
});

test("every violet primary button is a capsule, a control (md) or a circle — never the card/input radius", () => {
  /* Go / Build were 52px primaries at `--radius-lg`, the CARD radius, beside
     capsule Follow / Get started and the md Play. MUTATION: `#pl-form button
     { border-radius: var(--radius-lg) }` -> red, naming it. */
  const bad = [];
  const seen = [];
  for (const r of RULES) {
    if (r.atRules.length) continue;
    if (!r.decls.some((d) => d.prop === "background" && d.value === "var(--violet)")) continue;
    for (const sel of r.selectors) {
      if (!/button|\.fy-btn|\.fy-sheet-go|\.fp-play|\.fp-btn|\.play-btn/.test(sel)) continue;
      if (/:hover|:active|:disabled|\[data-playing/.test(sel)) continue;
      const base = sel.replace(/^body\.ui-v2 /, "");
      const radius = lastOn(sel, "border-radius") ?? lastOn(base, "border-radius")
        /* `.fy-btn.fy-main` inherits its corner from `.fy-btn`; `.fp-btn.fp-big` states its own. */
        ?? lastOn(base.split(".").slice(0, 2).join("."), "border-radius");
      seen.push(sel);
      if (!/^var\(--radius-(pill|md|round)\)$/.test(radius || "")) bad.push(`${sel} -> ${radius}`);
    }
  }
  assert.ok(seen.includes("body.ui-v2 #pl-form button") && seen.includes("body.ui-v2 #cr-form button"), "the census reaches Go and Build");
  assert.deepStrictEqual(bad, [], "violet primaries on the wrong radius");
  assert.strictEqual(lastOn("#pl-form button", "border-radius"), "var(--radius-pill)");
  assert.strictEqual(lastOn("#cr-form button", "border-radius"), "var(--radius-pill)");
});

test("every row and card title is the display face: a show's name in a search row included", () => {
  /* qa row 43's rule, extended past the two heading kinds to the names on
     rows and cards. `.show-result-title` was the one left in the text face;
     the first-run value-prop headings inherited it. MUTATION: `body.ui-v2
     .show-result-title { font-family: var(--font-body) }` -> red. */
  const titles = [
    "body.ui-v2 .show-result-title", ".ep-row .t", ".mc-info h3", ".fy-home-title", ".ft-value-prop h4",
    ".fy-src-show", "body.ui-v2 .hv2-jbi-title", ".b-title",
  ].filter((s) => s !== ".b-title" || RULES.some((r) => r.selectors.includes(".b-title")));
  for (const sel of titles) {
    assert.strictEqual(lastOn(sel, "font-family"), "var(--font-display)", `${sel} names something: display face`);
  }
  assert.strictEqual(lastOn("body.ui-v2 .show-result-by", "font-family"), "var(--font-body)", "the byline stays in the text face");
});

/* ======================================================================
   AUDIT ROUND 2 (2026-09-23): ONE RULE PER ROLE (theme R2-K)
   ======================================================================
   The first pass gave each family one SCALE; round 2 found the rules still
   reading three steps of it for one role — three field shapes, two transport
   specs, three section-title sizes, four gutters, rows lifted and flat in one
   column. Each role below is enumerated by the selectors that play it, so a
   rule that drifts off its step is named. (The transport family is pinned in
   test/transport-controls.test.js; rows, tags and the row number in
   test/card-anatomy.test.js; touch in test/tap-targets.test.js.) */

test("no C1 control character anywhere in the sheet: the notes chevron is the \\203A escape, not U+0083 + 'A'", () => {
  /* Round 2, visual-1: `content: "\203A"` reached disk as the bytes C2 83 41 —
     a C1 control and a literal A — and every episode page with notes drew a
     sideways letter. MUTATION: write U+0083 back in front of the "A" -> red. */
  const c1 = [...CSS].map((ch, i) => [ch.charCodeAt(0), i]).filter(([c]) => c >= 0x80 && c <= 0x9f);
  assert.deepStrictEqual(c1.map(([c, i]) => `U+${c.toString(16).padStart(4, "0")} at line ${CSS.slice(0, i).split("\n").length}`), [],
    "a C1 control character in styles.css is always a mangled escape");
  assert.strictEqual(lastOn(".ep-description-toggle::after", "content"), '"\\203A"', "the chevron is the › escape");
});

test("every range input is the listener's own material: amber, never the UA's system blue", () => {
  /* Round 2, visual-2: the Interests sliders set no accent-color and painted
     system blue. MUTATION: delete `input[type="range"] { accent-color }` -> red. */
  assert.strictEqual(lastOn('input[type="range"]', "accent-color"), "var(--amber)");
  const others = RULES.filter((r) => r.decls.some((d) => d.prop === "accent-color") && !r.selectors.includes('input[type="range"]'));
  assert.deepStrictEqual(others.map((r) => r.selectors.join(", ")), [], "no class re-colours a range input on its own");
  assert.match(APP_JS, /<input type="range" class="interest-slider"/, "fixture assumption: the sliders are range inputs");
});

test("one text field: every field reads the one element rule, and only the floating search capsule differs", () => {
  /* Round 2, visual-8: 52px at the card radius, 48px, and ~40px at the control
     radius in the body step, for one object. MUTATIONS: `.dd-input {
     border-radius: var(--radius-md) }` -> red; `#cr-input { min-height: 52px }`
     -> red; `input[type="text"] { font-size: var(--fs-md) }` -> red. */
  assert.strictEqual(lastOn('input[type="text"]', "border-radius"), "var(--radius-lg)");
  assert.strictEqual(lastOn('input[type="text"]', "min-height"), "48px");
  assert.strictEqual(lastOn('input[type="text"]', "font-size"), "var(--fs-lg)");
  /* The fields the app renders, found in its markup rather than listed. */
  const fields = new Set();
  for (const m of APP_JS.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*type="text"/g)) fields.add(`#${m[1]}`);
  if (/<input\b[^>]*\bdata-show-ep-search-input\b[^>]*type="text"/.test(APP_JS)) fields.add(".show-ep-search input");
  for (const m of APP_JS.matchAll(/ddEl\("input", "([^"]+)"\)|\.className = "([^"]+-input)"/g)) fields.add(`.${m[1] || m[2]}`);
  /* Six since round 2's p-first-6 took the second playlist builder (#pl-input)
     off #/playlists: Create's #cr-input is the one builder field left. */
  assert.ok(fields.size >= 6, `fixture assumption: the census finds the app's text fields (${[...fields]})`);
  const OWN = ["border-radius", "min-height", "height", "font-size", "padding"];
  const bad = [];
  for (const r of RULES) {
    for (const sel of r.selectors) {
      const target = [...fields].find((f) => sel === f || sel.endsWith(` ${f}`) || sel.startsWith(`${f}:`));
      if (!target || target === "#sh-input") continue; // the capsule: its field gives its box to the pill
      for (const d of r.decls) if (OWN.includes(d.prop)) bad.push(`${sel} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepStrictEqual(bad, [], "a field restating the field rule's shape");
});

test("section titles are one step: the display face at --fs-xl, 600, wherever a heading gathers cards", () => {
  /* Round 2, visual-12: Home's were --fs-xl, a Foray's running order --fs-lg
     (under a comment claiming the section step), Interests' --fs-lg at 700.
     MUTATION: `.fy-slot h3 { font-size: var(--fs-lg) }` -> red. */
  for (const sel of ["body.ui-v2 .hv2-title", ".fy-slot h3", ".interest-group-label"]) {
    assert.strictEqual(lastOn(sel, "font-size"), "var(--fs-xl)", `${sel}: the section-title step`);
    assert.strictEqual(lastOn(sel, "font-weight"), "600", `${sel}: 600`);
    assert.strictEqual(lastOn(sel, "font-family"), "var(--font-display)", `${sel}: the display face`);
  }
});

test("row titles are 600, and the display face at 700 is only a page title or the wordmark", () => {
  /* Round 2, visual-15: the same Foray was 700 on the Forays page and 600 on
     its Home card. MUTATION: `.fy-home-title { font-weight: 700 }` -> red,
     naming it. */
  const ROWS = [".ep-row .t", ".show-result-title", ".mc-info h3", ".fy-home-title", ".fy-src-show", ".interest-row-name",
    ".show-forays-title", "body.ui-v2 .hv2-jbi-title", ".ft-value-prop h4"];
  for (const sel of ROWS) {
    assert.strictEqual(lastOn(sel, "font-weight"), "600", `${sel} is a row title: 600`);
    assert.strictEqual(lastOn(sel, "font-size"), "var(--fs-lg)", `${sel} at the row-title step`);
  }
  /* A page's title, the Now Playing sheet's, another sheet's: the titles of a whole surface. */
  const TITLES_AT_700 = new Set([".page-head h2", ".fp-s-title", ".fy-panel h3"]);
  const bold = [];
  for (const r of RULES) {
    const face = r.decls.find((d) => d.prop === "font-family");
    const weight = r.decls.find((d) => d.prop === "font-weight");
    if (!face || face.value !== "var(--font-display)" || !weight || !/^(700|800|900|bold)$/.test(weight.value)) continue;
    for (const sel of r.selectors) if (!TITLES_AT_700.has(sel)) bold.push(sel);
  }
  assert.deepStrictEqual(bold, [], "a display-face 700 outside the page titles");
});

test("one gutter: pages, Home, Now Playing and the sheets all inset by --gutter", () => {
  /* Round 2, visual-13: 12 / 14 / 16 / 18. MUTATION: `.fy-panel { padding: 8px
     18px … }` -> red. */
  assert.strictEqual(ROOT_DECLS.get("--gutter"), "16px");
  const inline = (v) => { const p = String(v || "").trim().split(/\s+(?![^(]*\))/); return p.length === 1 ? p[0] : p[1]; };
  for (const sel of [".page", ".fp-sheet-scroll", ".fy-panel", "body.ui-v2 .hv2-greeting", "body.ui-v2 .hv2-title",
    "body.ui-v2 .hv2-hscroll", "body.ui-v2 .hv2-cards"]) {
    assert.strictEqual(inline(lastOn(sel, "padding")), "var(--gutter)", `${sel} insets by the gutter`);
  }
  assert.strictEqual(lastOn("body.ui-v2 .hv2-hscroll", "scroll-padding-inline"), "var(--gutter)");
});

test("rows in a list sit flat; the shadow is for cards and fields", () => {
  /* Round 2, visual-14 — the qa 53 deferral, decided: lifted, flat, lifted in
     one Library column. MUTATION: `.ep-row, .pl-row { box-shadow:
     var(--shadow) }` -> red. */
  const ROWS = [".ep-row", ".pl-row", ".show-result", ".fy-row", ".fy-src", ".fy-home-row", ".interest-row"];
  const lifted = [];
  for (const r of RULES) {
    if (r.atRules.length) continue;
    if (!r.selectors.some((s) => ROWS.includes(s.replace(/^body\.ui-v2 /, "")))) continue;
    const sh = r.decls.find((d) => d.prop === "box-shadow");
    if (sh && sh.value !== "none") lifted.push(`${r.selectors.join(", ")} { box-shadow: ${sh.value} }`);
  }
  assert.deepStrictEqual(lifted, [], "a list row carrying an elevation");
  assert.strictEqual(lastOn(".mini-card", "box-shadow"), "var(--shadow)", "a card on Home's grid is still lifted");
});

test("the Home card's branch dot is gone, with the ten raw v1 hexes that coloured it", () => {
  /* Round 2, visual-3: 29 of 39 branches fell to violet, so the dot said
     nothing and read as the Stretch tag's bullet. MUTATION: restore
     `.mc-kicker::before { … background: var(--branch-color) }` -> red. */
  assert.ok(!RULES.some((r) => r.selectors.includes(".mc-kicker::before")), "no dot");
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /--branch-color|\[data-branch=/, "and nothing left to colour one");
});

test("the one focus ring reaches the search field: the capsule draws it; no bare outline: none anywhere", () => {
  /* Round 2, a11y-3: `#sh-compose #sh-input:focus { outline: none }` out-ranked
     the ring and nothing replaced it. The rule now: an `outline: none` is
     either `:not(:focus-visible)`-qualified, or an ANCESTOR draws the ring on
     `:focus-within`. MUTATIONS: delete the `:focus-within` ring -> red; add
     `.fy-chip:focus { outline: none }` anywhere -> red. */
  const ANCESTOR_RING = { "#sh-compose #sh-form #sh-input:focus": "#sh-compose #sh-form:focus-within" };
  const bare = [];
  for (const r of RULES) {
    if (!r.decls.some((d) => d.prop === "outline" && /^(none|0)$/.test(d.value))) continue;
    for (const sel of r.selectors) {
      if (/:not\(:focus-visible\)/.test(sel)) continue;
      const ring = ANCESTOR_RING[sel];
      if (ring && lastOn(ring, "outline") === "2px solid var(--amber)") continue;
      bare.push(sel);
    }
  }
  assert.deepStrictEqual(bare, [], "an outline: none with no ring to replace it");
  assert.match(APP_JS, /<form id="sh-form"[^>]*>[\s\S]*?<input id="sh-input"[\s\S]*?<\/form>/, "the field really is inside the capsule that rings");
});

test("Reduce Motion is one block and it names every transition in the sheet", () => {
  /* Round 2, a11y-9: three strip rules honoured it; the sheet's spring-back,
     the chevron, the card press and the page head did not. MUTATIONS: add
     `transition: opacity .2s` to any rule -> red, naming it; remove `.fp-sheet`
     from the block -> red. */
  const blocks = RULES.filter((r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const covered = new Set(blocks.filter((r) => r.decls.some((d) => d.prop === "transition" && d.value === "none"))
    .flatMap((r) => r.selectors));
  const atRules = new Set(blocks.map((r) => r.atRules.join("|")));
  assert.strictEqual(atRules.size, 1, "one reduce-motion block, not one per component");
  const moving = [];
  for (const r of RULES) {
    if (r.atRules.length) continue;
    const t = r.decls.find((d) => d.prop === "transition");
    if (!t || t.value === "none") continue;
    for (const sel of r.selectors) if (!covered.has(sel)) moving.push(`${sel} { transition: ${t.value} }`);
  }
  assert.deepStrictEqual(moving, [], "a transition Reduce Motion does not stop");
  assert.ok(covered.has(".fp-sheet:not(.fp-sheet-dragging)"), "fixture assumption: the sheet's release is among them");
});

test("'N min left' is amber and bold on Home's card, as on the Forays page and the Foray page", () => {
  /* Round 2, honesty-8. MUTATION: delete `body.ui-v2 .hv2-jbi-left { … }` -> red. */
  assert.strictEqual(lastOn("body.ui-v2 .hv2-jbi-left", "color"), "var(--amber)");
  assert.strictEqual(lastOn("body.ui-v2 .hv2-jbi-left", "font-weight"), "700");
  assert.strictEqual(lastOn("body.ui-v2 .fy-jbi-left", "color"), "var(--amber)", "the Forays page's, for comparison");
  assert.strictEqual(lastOn(".fy-jbi-left", "font-weight"), "700");
});

test("Home shows the wordmark once: the greeting has it, the bar keeps only its tagline there", () => {
  /* Round 2, p-first-8: two identical italic "4a" marks ~50px apart. MUTATION:
     delete `body.view-home .topbar h1 .wordmark { display: none }` -> red. */
  assert.strictEqual(lastOn("body.view-home .topbar h1 .wordmark", "display"), "none");
  assert.ok(!RULES.some((r) => r.selectors.some((s) => /view-home .*topbar-tag/.test(s)) && r.decls.some((d) => d.value === "none")),
    "the tagline — what this app is — stays on Home");
  assert.match(APP_JS, /class="hv2-greeting-brand"/, "fixture assumption: the greeting carries the brand");
  assert.match(APP_JS, /setBodyClass\("view-home"\)/, "fixture assumption: Home's body class is view-home");
});

test("the episode page's head is two lines at most, at the size Now Playing gives the same title", () => {
  /* Round 2, visual-4: the whole title rode the sticky head at --fs-2xl (a
     fifth of the screen on a long title) and --fs-xl in the sheet. MUTATION:
     delete `.page-head .fp-s-title { … }` -> red. */
  assert.strictEqual(lastOn(".fp-s-title", "font-size"), "var(--fs-xl)", "the sheet's size");
  assert.strictEqual(lastOn(".page-head .fp-s-title", "font-size"), "var(--fs-xl)", "the same size on the episode page's head");
  assert.strictEqual(lastOn(".page-head .fp-s-title", "-webkit-line-clamp"), "2");
  assert.strictEqual(lastOn(".page-head .fp-s-title", "overflow"), "hidden");
  assert.match(APP_JS, /<div class="page-head">\s*<a class="back" href="#\/">‹<\/a>\s*<div>\s*<h2 class="fp-s-title">\$\{esc\(item\.title\)\}/,
    "fixture assumption: renderEpisode's head is an h2.fp-s-title inside .page-head");
});

test("a control marked loading has a look, and Reduce Motion stills it", () => {
  /* Round-2 sweep, finishing p-impatient-4: player/client.js marks the bar's ▶,
     the sheet's big ▶ and the tapped row's ▶ `data-loading="1"` "so styles.css
     can spin them", and no rule read the mark — the load was said only in the
     status line, not on the button the thumb was on. MUTATION: delete the
     `[data-loading="1"]` animation rule -> red; delete its line from the
     reduce-motion block -> red. */
  assert.match(PLAYER_JS, /btn\.dataset\.loading = "1"/, "fixture assumption: the player marks the bar's buttons");
  assert.match(PLAYER_JS, /b\.dataset\.loading = "1"/, "fixture assumption: and the row's");
  for (const sel of ['.play-btn[data-loading="1"]', '.fp-play[data-loading="1"]', '.fp-btn[data-loading="1"]']) {
    assert.match(String(lastOn(sel, "animation")), /^fy-loading-breathe /, `${sel} has no look`);
    const still = RULES.filter((r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)) && r.selectors.includes(sel));
    assert.ok(still.some((r) => r.decls.some((d) => d.prop === "animation" && d.value === "none")), `${sel} keeps moving under Reduce Motion`);
  }
  assert.ok(/@keyframes fy-loading-breathe/.test(CSS), "the animation it names exists");
});

test("the Up Next row the bar is on is drawn as the one that is on", () => {
  /* Round-2 sweep, finishing p-impatient-6: upNextRow marks the row
     `.is-current` + aria-current and left the look to this file; nothing drew
     it. MUTATION: delete `body.ui-v2 .up-next-row.is-current` -> red. */
  assert.match(APP_JS, /isCurrent \? " is-current" : ""/, "fixture assumption: app.js marks the row");
  assert.strictEqual(lastOn("body.ui-v2 .up-next-row.is-current", "border-color"), "var(--violet)",
    "the same mark a Foray's sounding clip row wears");
  assert.strictEqual(lastOn("body.ui-v2 .fy-row:has(.fy-jump.is-playing)", "border-color"), "var(--violet)", "for comparison");
  assert.strictEqual(lastOn("body.ui-v2 .up-next-row.is-current", "background"), "var(--surface2)");
});
