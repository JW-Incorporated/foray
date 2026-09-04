/* `tools/mobile/minify.mjs` — the bundle's comment-and-whitespace stripper.
 *
 * What is at stake: the shipped program must be the source program with its prose
 * removed and NOTHING else changed — no renamed identifier (stack traces), no
 * rewritten syntax, no re-encoded string, no file type it was not asked to touch.
 * Every test names the one-line mutation that makes it fail; each was run.
 * `prepare-webdir.test.mjs` covers the transform's place in the build (order against
 * the derivation, the source tree left alone, the real bundle under `node --check`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MINIFY_LOADERS, MINIFY_OPTIONS, MinifyError, isMinified, loadMinifier, minifyLoader, minifySource,
} from "./minify.mjs";
import { buildPlan, SHELL_ONLY_FILES } from "./prepare-webdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

test("comments and whitespace go; identifiers, strings, templates and regexes stay", () => {
  /* The template literal and the regex literal are the two places a regex-based
     stripper gets wrong, and the reason this is a parser (minify.mjs's header).
     MUTATION (ran): `minifyIdentifiers: true` in MINIFY_OPTIONS — `longLocalName`
     becomes a one-letter name and the identifier assertion fails.
     MUTATION 2 (ran): remove `legalComments: "none"` — esbuild's default keeps the
     `/*!`-style comment below, and the "legal comment" assertion fails. */
  const src = [
    "/* block comment */",
    "/*! legal comment — esbuild keeps these by default */",
    "function alpha() { // line comment",
    "  const longLocalName = `// not a comment /* nor this */`;",
    "  const re = /\\/\\/x/;",
    "  return [longLocalName, re];",
    "}",
  ].join("\n");
  const out = minifySource("x.js", src);
  assert.ok(!out.includes("block comment") && !out.includes("line comment"), `a comment survived: ${out}`);
  assert.ok(!out.includes("legal comment"), `a legal comment survived: ${out}`);
  assert.ok(out.includes("`// not a comment /* nor this */`"), `the template literal was damaged: ${out}`);
  assert.ok(out.includes("/\\/\\/x/"), `the regex literal was damaged: ${out}`);
  assert.ok(out.includes("longLocalName"), `a local identifier was renamed: ${out}`);
  assert.ok(out.includes("function alpha("), `the function was renamed: ${out}`);
  assert.ok(!/\n\s/.test(out), `indentation survived: ${JSON.stringify(out)}`);
});

test("syntax is not rewritten: no folding, no sequencing, no dropped statements", () => {
  /* "The source with its prose removed", not "a different program that behaves the
     same". MUTATION (ran): `minifySyntax: true` — `1+2` folds to `3`, the `if`
     becomes `x&&y()`, and `debugger` is dropped. */
  const out = minifySource("x.js", "const a = 1 + 2;\nif (x) { y(); }\ndebugger;\n");
  assert.ok(out.includes("1+2"), `constant folding happened: ${out}`);
  assert.ok(out.includes("if(x)"), `the if was rewritten: ${out}`);
  assert.ok(out.includes("debugger"), `a statement was dropped: ${out}`);
});

test("non-ASCII text ships as UTF-8, not as escape sequences", () => {
  /* `index.html` declares `<meta charset="utf-8">`; the source has em dashes and
     accented names in user-facing strings, and `—` is five bytes longer than
     the character. MUTATION (ran): remove `charset` from MINIFY_OPTIONS. */
  const out = minifySource("x.js", 'const s = "café — naïve";');
  assert.ok(out.includes("café — naïve"), `non-ASCII was escaped: ${out}`);
});

test("CRLF input produces the same bytes as LF input, with no CR in the output", () => {
  /* A Windows checkout (`core.autocrlf=true`) hands the minifier CRLF text, and a
     bundle built there should measure what CI measures. The template literal
     spanning lines is what makes this observable: outside a template, whitespace
     is stripped and there is nothing to normalise.

     THIS TEST CANNOT FAIL ON TODAY'S DEPENDENCY, said out loud (CLAUDE.md § A green
     test is not evidence, point 5). The first draft of `minifySource` normalised
     CRLF itself and this test named that line as its mutation; the mutation
     SURVIVED, because esbuild normalises line terminators on its own, in JS and in
     CSS custom-property values alike (measured). The redundant line was removed
     and this test kept: it is the pin that an esbuild upgrade still does so. The
     mutation that fails it is an esbuild that preserves `\r`, which is the thing
     it is here to notice. */
  const lf = "const t = `line one\nline two`;\nconst u = 1;\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = minifySource("x.js", lf);
  const b = minifySource("x.js", crlf);
  assert.ok(a.includes("line one\nline two"), `the template's newline was lost: ${JSON.stringify(a)}`);
  assert.equal(b, a, "CRLF input minified to different bytes than LF input");
  assert.ok(!b.includes("\r"), "a carriage return reached the output");
});

test("CSS: comments go; nesting, env(), custom properties and !important stay", () => {
  /* The stylesheet uses all four (`docs/mobile-shell.md`, `test/home-layout.test.js`
     for `env(safe-area-inset-top)`), and a CSS printer that dropped or reordered any
     of them would change layout on a device while every JS test stayed green.
     MUTATION (ran): map `.css` to the `js` loader in MINIFY_LOADERS — the transform
     throws on the first selector. */
  const css = [
    "/* prose */",
    ".topbar {\n  padding-top: env(safe-area-inset-top);\n}",
    "@media (prefers-color-scheme: light) {\n  :root {\n    --bg: #fff;\n  }\n}",
    ".home {\n  .cards4 {\n    display: grid;\n  }\n}",
    "[hidden] {\n  display: none !important;\n}",
  ].join("\n");
  const out = minifySource("styles.css", css);
  assert.ok(!out.includes("prose"), `a CSS comment survived: ${out}`);
  assert.ok(out.includes("env(safe-area-inset-top)"), `env() was rewritten: ${out}`);
  assert.ok(out.includes("--bg:"), `a custom property was dropped: ${out}`);
  assert.ok(out.includes("prefers-color-scheme:light"), `the media query was rewritten: ${out}`);
  assert.ok(out.includes(".home{.cards4{display:grid}}"), `nesting was flattened or lost: ${out}`);
  assert.ok(out.includes("display:none!important"), `!important was dropped: ${out}`);
  assert.ok(out.length < css.length, "the stylesheet did not shrink");
});

test("only .js and .css are minified; JSON, HTML and images are somebody else's", () => {
  /* JSON is re-serialised by prepare-webdir.mjs (no parser needed); index.html is
     the injection target and is copied by string position; PNGs are bytes.
     MUTATION (ran): add `".html": "js"` to MINIFY_LOADERS — `isMinified("index.html")`
     flips and prepare-webdir would push index.html through a JS parser. */
  assert.deepEqual(Object.keys(MINIFY_LOADERS).sort(), [".css", ".js"]);
  assert.equal(minifyLoader("app.js"), "js");
  assert.equal(minifyLoader("player/client.js"), "js");
  assert.equal(minifyLoader("styles.css"), "css");
  for (const rel of ["index.html", "data/session.json", "manifest.json", "icon-512.png"]) {
    assert.equal(isMinified(rel), false, `${rel} would be minified`);
    assert.throws(() => minifySource(rel, "{}"), MinifyError);
  }
  /* And the options say what they mean: every flag that changes the program is
     spelled `false`, so a reader sees the decision rather than a default. */
  assert.equal(MINIFY_OPTIONS.minifyWhitespace, true);
  assert.equal(MINIFY_OPTIONS.minifySyntax, false);
  assert.equal(MINIFY_OPTIONS.minifyIdentifiers, false);
  assert.equal(MINIFY_OPTIONS.legalComments, "none");
  assert.ok(Object.isFrozen(MINIFY_OPTIONS));
});

test("REAL REPO: every shipped JS and CSS file is a fixed point of the transform, and shrinks", () => {
  /* `minifySource` re-parses its own output and demands byte equality; that guard
     is what stands in for `node --check` inside the build. Exercised on the files
     that actually ship, so an esbuild upgrade that changed its output on a real
     construct fails here rather than on a founder's Mac.
     MUTATION (ran): flip `if (again !== code)` to `if (again === code)` in
     `minifySource` — every real file then throws. */
  const plan = [...buildPlan(ROOT), ...SHELL_ONLY_FILES.map((f) => f.src)].filter(isMinified);
  assert.ok(plan.length >= 25, `only ${plan.length} minified files in the plan`);
  let source = 0;
  let shipped = 0;
  for (const rel of plan) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const out = minifySource(rel, text);
    assert.equal(minifySource(rel, out), out, `${rel} is not a fixed point`);
    assert.ok(out.length < text.length, `${rel} did not shrink`);
    source += Buffer.byteLength(text.replace(/\r\n/g, "\n"));
    shipped += Buffer.byteLength(out);
  }
  /* Measured 2026-09-04: 303,181 of 1,097,948 (0.276). Comments alone leave 0.417. */
  assert.ok(shipped / source < 0.35, `shipped/source is ${(shipped / source).toFixed(3)} — whitespace is not being stripped`);
});

test("REAL REPO: the minifier is the pinned esbuild, resolved from tools/mobile/", () => {
  /* The version is pinned exactly in tools/mobile/package.json because the bundle's
     bytes are measured against budgets; a floating version is a bundle that changes
     size with nobody's commit. This asserts the installed module IS that version, so
     a stray global or hoisted install cannot quietly substitute another.
     MUTATION (ran): change the pin in package.json to a range (`^0.28.2`) — the
     assertion below fails on the spelling before any install could drift. */
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  const pinned = pkg.devDependencies?.esbuild;
  assert.match(pinned, /^\d+\.\d+\.\d+$/, `esbuild is not pinned exactly: ${pinned}`);
  assert.equal(loadMinifier().version, pinned, "the installed esbuild is not the pinned version");
  assert.match(pkg.scripts?.test, /node --test$/, "the test script must forward its arguments (CLAUDE.md § Verify before committing)");
});
