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
