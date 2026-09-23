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
