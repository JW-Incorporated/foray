/* The Windows entrypoint-guard class, gated.
 *
 * WHAT WENT WRONG (measured 2026-09-12, on the founder's own machine)
 * `tools/build-catalog-client.mjs` ended with
 *
 *     if (import.meta.url === `file://${process.argv[1]}`) main();
 *
 * On Windows `process.argv[1]` is `C:\...\tools\build-catalog-client.mjs`, so
 * the right-hand side is `file://C:\...\build-catalog-client.mjs` while
 * `import.meta.url` is `file:///C:/.../build-catalog-client.mjs`. The two can
 * never be equal. `node tools/build-catalog-client.mjs --check` — the documented
 * regenerate/verify command, and the one `test/show-page.test.js` shells out to
 * — therefore printed NOTHING and EXITED 0. A developer could edit
 * `data/catalog.json`, "regenerate", commit, and ship a stale client catalogue,
 * with a green check saying it was fine.
 *
 * Every developer on this project is on Windows and nothing in CI runs there, so
 * the class is invisible from both ends: on Linux the guard works, and on
 * Windows the failure is an exit code of 0. `tools/search-probe.mjs` had the
 * same bug (see `docs/search-plan.md`'s S-01 marker) and `tools/build-show-
 * index.mjs`'s header calls it out by name. It is not a one-off, it is an idiom
 * people copy.
 *
 * WHAT THIS ASSERTS
 * Not "every script has an entrypoint guard" — `tools/ci/crlf-guard.mjs` is a
 * script with none, and its header argues the case at length. Only: a file
 * that HAS one must use a formulation that is correct on both platforms. And,
 * for the script that actually had the bug, an executable proof that running
 * it does something.
 *
 * THE SECOND HALF OF THE CLASS (code-health CH2-41a, T2-04). `pathToFileURL`
 * fixed the drive-letter/slash mismatch but not the other one: Node REALPATHS
 * the main module before it builds `import.meta.url`, while `process.argv[1]`
 * is only made absolute. From a Windows junction or a symlinked checkout the
 * two sides name different paths, so the `pathToFileURL` form this file used to
 * bless, and the `path.resolve` form beside it, were false there too and the
 * CLI exited 0 without running. The one correct form realpaths both sides:
 * `isEntryScript(import.meta.url)` from `tools/ci/entry.mjs`. Under `tools/ci`,
 * `tools/release`, `tools/mobile` and `tools/ops` it is now the ONLY form
 * allowed; the rest of `tools/` keeps the `pathToFileURL` rule until CH2-41b
 * sweeps it.
 *
 * This test is platform-independent: the text rule holds everywhere, so a Linux
 * runner gates the Windows failure it cannot itself reproduce.
 */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TRACKED = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));

/* A main-module check of any shape: `import.meta.url === <something>` or the
   reverse. The point is to find them ALL, including the broken formulation —
   a regex that only matched the correct one would be green by construction. */
const GUARD_RE = /import\.meta\.url\s*===|===\s*import\.meta\.url/;

/**
 * `text` with comments blanked out, line structure preserved.
 *
 * Necessary, not fastidious: several files in this repo — including
 * `tools/build-catalog-client.mjs` and `tools/ci/crlf-guard.mjs` — QUOTE the
 * broken guard verbatim inside a block comment to explain why it was wrong.
 * A scanner that reads comments would flag the explanation and could only be
 * silenced by deleting the thing that stops the bug coming back.
 *
 * Deliberately crude (it does not know about `//` inside a string literal), for
 * the same reason the rest of this file is text-based: the alternative is a
 * parser dependency for a rule that is one line long. A false NEGATIVE from the
 * crudeness is the safe direction, and the executable test below is the witness
 * for the one script that actually had the bug.
 */
export function stripComments(text) {
  let out = "";
  let inBlock = false;
  for (const line of String(text).split("\n")) {
    let kept = "";
    for (let i = 0; i < line.length; i++) {
      if (inBlock) {
        if (line.startsWith("*/", i)) { inBlock = false; i++; }
        continue;
      }
      if (line.startsWith("/*", i)) { inBlock = true; i++; continue; }
      if (line.startsWith("//", i)) break;
      kept += line[i];
    }
    out += kept + "\n";
  }
  return out;
}

test("every main-module guard in the repo uses pathToFileURL, not a `file://` template", () => {
  /* MUTATION: put ``if (import.meta.url === `file://${process.argv[1]}`) main();``
     back into any one of these files. That file's CLI becomes a silent no-op on
     every developer machine in this project and this test names it.

     The scan is over every tracked `.mjs`/`.js` rather than a list, because the
     list is the thing that goes stale: this bug survived in exactly the one file
     that nobody thought to look at while seven others had already been fixed. */
  const offenders = [];
  for (const rel of TRACKED) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = stripComments(fs.readFileSync(abs, "utf8"));
    for (const line of text.split("\n")) {
      if (!GUARD_RE.test(line)) continue;
      if (line.includes("pathToFileURL")) continue;
      offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "these entrypoint guards are silently FALSE on Windows, so the script's " +
      "CLI does nothing and exits 0:\n" + offenders.join("\n")
  );
});

test("the scan reads code, not the comments that explain the bug", () => {
  /* MUTATION: drop `stripComments` from the scan above. The repo's own
     explanations of this bug — which quote the broken line verbatim, on purpose,
     so it does not come back — would be reported as offenders, and the only way
     to get CI green again would be to delete the explanations. */
  const src = [
    "/* The old form was:",
    "     if (import.meta.url === `file://${process.argv[1]}`) main();",
    "   and it is false on Windows. */",
    "// if (import.meta.url === `file://${process.argv[1]}`) main();",
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();",
  ].join("\n");
  const flagged = stripComments(src)
    .split("\n")
    .filter((l) => GUARD_RE.test(l) && !l.includes("pathToFileURL"));
  assert.deepStrictEqual(flagged, []);
});

test("build-catalog-client.mjs --check actually runs and says so", () => {
  /* The executable half, and the one that caught the bug in the first place.
     `test/show-page.test.js` asserts the same thing for the same reason; this
     copy is here so the entrypoint rule above has a live witness next to it that
     does not depend on the player suite existing.

     MUTATION: revert the guard in tools/build-catalog-client.mjs. `out` becomes
     the empty string and both assertions fail. Note that an assertion on the
     EXIT CODE alone would not: the broken script exited 0. */
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "build-catalog-client.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(out.trim(), "", "--check produced no output at all — main() never ran");
  assert.match(out, /up to date/);
});

test("data/catalog-client.json and tools/foray/*.mjs are pinned to LF", () => {
  /* THE OTHER HALF OF THE WINDOWS CLASS, and the reason the test above can pass
     on a developer machine at all.

     `data/catalog-client.json`: `--check` compares the file's BYTES against a
     fresh LF derivation, so a CRLF checkout fails it on a clean tree.

     `tools/foray/*.mjs`: `backend/src/generation/finalizeForay.ts` dynamically
     imports `check-forays.mjs`, vite-node INLINES it, and Vite strips the
     shebang with `hashbangRE = /^#!.*\n/` — which does not match `\r\n`. On a
     CRLF checkout the `\r` survives, the shebang lands inside the function body,
     and the module dies with `SyntaxError: Invalid or unexpected token`, taking
     five `finalizeForay.test.ts` tests with it. Green on Linux CI, red on every
     machine this is developed on.

     MUTATION: delete either `-text` line from `.gitattributes`. This goes red on
     a Windows checkout — and, honestly, stays green on Linux, where git writes
     LF whatever the attribute says. That is the limit of testing a checkout
     property from inside the checkout, and it is still worth pinning: the
     failing direction is the one the developers are on. */
  const attrs = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  assert.match(attrs, /^tools\/foray\/\*\.mjs -text$/m);
  assert.match(attrs, /^data\/catalog-client\.json -text$/m);

  for (const rel of ["data/catalog-client.json", "tools/foray/check-forays.mjs", "tools/foray/check-narration.mjs"]) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    assert.ok(!bytes.includes("\r\n"), `${rel} has CRLF bytes in this checkout — the -text attribute is not in effect`);
  }
});

/* ═══════ CH2-41a (T2-04): one isEntryScript, realpath on both sides ═══════ */

const ENTRY = path.join(ROOT, "tools", "ci", "entry.mjs");

/* The trees where `isEntryScript` is the only allowed guard. CH2-41b widens
   this to every `tools/` subtree and retires the `pathToFileURL` rule above. */
const HELPER_TREES = ["tools/ci/", "tools/release/", "tools/mobile/", "tools/ops/"];

/** A link to `target` inside a fresh temp dir: a junction on Windows (no
 *  privilege needed), a symlink elsewhere. Returns `{ link, cleanup }`, or null
 *  when the platform refuses (the caller skips). */
function linkTo(target) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), "entry-link-"));
  const link = path.join(holder, "linked");
  const cleanup = () => {
    try { fs.unlinkSync(link); } catch (_) { try { fs.rmdirSync(link); } catch (_) { /* best effort */ } }
    try { fs.rmdirSync(holder); } catch (_) { /* best effort */ }
  };
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (_) {
    cleanup();
    return null;
  }
  return { link, cleanup };
}

/** One probe CLI per guard form: each prints RAN when its guard says "I am
 *  the entry script". The three legacy forms are the ones this card swept out
 *  of the four trees (`path.resolve`: most of tools/mobile; `pathToFileURL`:
 *  the form the first rule in this file blesses; basename `endsWith`:
 *  upload-retry.mjs and watch-release.mjs). */
const PROBE_FORMS = {
  "path.resolve":
    'import path from "node:path";\nimport { fileURLToPath } from "node:url";\n' +
    'if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) console.log("RAN");\n',
  pathToFileURL:
    'import { pathToFileURL } from "node:url";\n' +
    'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log("RAN");\n',
  endsWith:
    'if (String(process.argv[1] || "").split(String.fromCharCode(92)).join("/").endsWith("/probe.mjs")) console.log("RAN");\n',
  isEntryScript:
    `import { isEntryScript } from ${JSON.stringify(pathToFileURL(ENTRY).href)};\n` +
    'if (isEntryScript(import.meta.url)) console.log("RAN");\n',
};

/** `{ form: ranBool }` for `node <dir>/<form>/probe.mjs`, one per form. */
function runProbes(dir) {
  const out = {};
  for (const form of Object.keys(PROBE_FORMS)) {
    const r = spawnSync(process.execPath, [path.join(dir, form, "probe.mjs")], { encoding: "utf8" });
    out[form] = r.stdout.trim() === "RAN";
  }
  return out;
}

test("CH2-41a: through a junction/symlink only the isEntryScript guard runs its CLI; the path.resolve and pathToFileURL forms exit 0 having done nothing", (t) => {
  /* T2-04, reproduced on Windows through a junction. Node realpaths the main
     module before it builds import.meta.url; process.argv[1] is only made
     absolute. So from a linked checkout the legacy forms compare two different
     paths, and the CLI is a silent no-op that exits 0. From the real path every
     form runs, which is why nobody saw it.
     MUTATION (run): drop realpathSync from tools/ci/entry.mjs (compare
     path.resolve(argv1) with fileURLToPath(url)) -> isEntryScript is false
     through the link -> red. */
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "entry-real-")));
  try {
    for (const [form, src] of Object.entries(PROBE_FORMS)) {
      fs.mkdirSync(path.join(real, form));
      fs.writeFileSync(path.join(real, form, "probe.mjs"), src);
    }
    const linked = linkTo(real);
    if (!linked) return t.skip("this platform refuses to create a junction or symlink");
    try {
      assert.deepStrictEqual(
        runProbes(real),
        { "path.resolve": true, pathToFileURL: true, endsWith: true, isEntryScript: true },
        "from the real path every form runs"
      );
      assert.deepStrictEqual(
        runProbes(linked.link),
        { "path.resolve": false, pathToFileURL: false, endsWith: true, isEntryScript: true },
        "through the link: the path.resolve and pathToFileURL forms are silent no-ops, the helper runs"
      );
    } finally {
      linked.cleanup();
    }
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("CH2-41a: the basename endsWith guard also fires when the module is merely IMPORTED by another file of the same name; isEntryScript does not", () => {
  /* The endsWith form survives a junction by accident (it compares names, not
     paths), and pays for it the other way: any entry script whose name ends the
     same way runs the imported module's CLI as a side effect of the import.
     MUTATION (run): make isEntryScript compare basenames -> the helper's probe
     prints RAN when merely imported -> red. */
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "entry-import-")));
  try {
    for (const [form, src] of Object.entries(PROBE_FORMS)) {
      fs.mkdirSync(path.join(real, form, "lib"), { recursive: true });
      fs.writeFileSync(path.join(real, form, "lib", "probe.mjs"), src);
      fs.writeFileSync(path.join(real, form, "probe.mjs"), 'import "./lib/probe.mjs";\n');
    }
    assert.deepStrictEqual(
      runProbes(real),
      { "path.resolve": false, pathToFileURL: false, endsWith: true, isEntryScript: false },
      "only the basename form mistakes an importer for itself"
    );
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("CH2-41a acceptance: node <junction>/tools/mobile/inject-splash.mjs android <missing dir> --check exits 1 with the error, as from the real path", (t) => {
  /* The exact reproduction in T2-04: through a junction this exited 0 with no
     output, so a step that called it would have "passed".
     MUTATION (run): put inject-splash.mjs's old guard back
     (`path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))`)
     -> exit 0, empty stderr -> red. */
  const linked = linkTo(path.join(ROOT, "tools"));
  if (!linked) return t.skip("this platform refuses to create a junction or symlink");
  try {
    const missing = path.join(os.tmpdir(), "entry-guards-no-such-res-dir");
    const run = (tools) =>
      spawnSync(process.execPath, [path.join(tools, "mobile", "inject-splash.mjs"), "android", missing, "--check"], {
        encoding: "utf8",
      });
    const viaReal = run(path.join(ROOT, "tools"));
    const viaLink = run(linked.link);
    assert.strictEqual(viaReal.status, 1, viaReal.stderr);
    assert.match(viaReal.stderr, /inject-splash failed/);
    assert.strictEqual(viaLink.status, 1, `through the junction: exit ${viaLink.status}, stderr ${JSON.stringify(viaLink.stderr)}`);
    assert.match(viaLink.stderr, /inject-splash failed/);
  } finally {
    linked.cleanup();
  }
});

test("CH2-41a: isEntryScript(importMetaUrl) — the plain path, another file, no argv[1], and (Windows) a differently cased drive letter", async () => {
  /* MUTATION (run): drop the win32 case-fold from tools/ci/entry.mjs -> the
     flipped drive letter is false -> red on Windows (a shell that reports
     c:\ where Node reports C:\). */
  const url = pathToFileURL(ENTRY).href;
  const { isEntryScript } = await import(url);
  assert.strictEqual(isEntryScript(url, ENTRY), true, "the plain path");
  assert.strictEqual(isEntryScript(url, path.join(ROOT, "tools", "ci", "not-entry.mjs")), false, "another file");
  assert.strictEqual(isEntryScript(url, undefined), false, "no argv[1] (node -e, a REPL)");
  assert.strictEqual(isEntryScript(url, ""), false, "an empty argv[1]");
  if (process.platform === "win32") {
    const flipped = ENTRY[0] === ENTRY[0].toUpperCase()
      ? ENTRY[0].toLowerCase() + ENTRY.slice(1)
      : ENTRY[0].toUpperCase() + ENTRY.slice(1);
    assert.strictEqual(isEntryScript(url, flipped), true, "the drive letter cased differently");
  }
});

/** Is `spec`, imported from repo file `rel`, tools/ci/entry.mjs? */
function isEntrySpecifier(rel, spec) {
  if (!spec.startsWith(".")) return false;
  return path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) === "tools/ci/entry.mjs";
}

/** The rule's offences for one source file in HELPER_TREES (`code` has its
 *  comments stripped already). */
export function helperTreeOffences(rel, code) {
  if (rel === "tools/ci/entry.mjs") return [];
  const out = [];
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
    .filter((m) => /\bisEntryScript\b/.test(m[1]));
  const fromEntry = imports.some((m) => isEntrySpecifier(rel, m[2]));
  for (const m of imports) {
    if (!isEntrySpecifier(rel, m[2])) out.push(`${rel}: imports isEntryScript from ${m[2]}, not tools/ci/entry.mjs`);
  }
  code.split("\n").forEach((line, i) => {
    if (/process\.argv\[1\]/.test(line) || GUARD_RE.test(line) || /import\.meta\.main\b/.test(line)) {
      out.push(`${rel}:${i + 1}: legacy entry guard: ${line.trim()}`);
    }
  });
  const definesMain = /\bfunction\s+main\s*\(|\b(?:const|let|var)\s+main\s*=/.test(code);
  const callsHelper = /\bisEntryScript\(\s*import\.meta\.url\s*\)/.test(code);
  if (definesMain && !fromEntry) out.push(`${rel}: defines main() but does not import isEntryScript from tools/ci/entry.mjs`);
  if (fromEntry && !callsHelper) out.push(`${rel}: imports isEntryScript but never calls isEntryScript(import.meta.url)`);
  return out;
}

test("CH2-41a rule: under tools/ci, tools/release, tools/mobile and tools/ops every CLI guards with isEntryScript from tools/ci/entry.mjs and no other form", () => {
  /* Every non-test .mjs in these trees that defines main() imports
     isEntryScript from tools/ci/entry.mjs, and NO file there carries another
     guard form (process.argv[1] compared any way, `import.meta.url ===`,
     import.meta.main). The scan is over tracked files, not a list, for the
     reason the first test in this file gives.
     MUTATION (run): put `if (process.argv[1] && path.resolve(process.argv[1])
     === path.resolve(fileURLToPath(import.meta.url))) main(...)` back into
     tools/mobile/release-ci.mjs -> named here. */
  const offenders = [];
  let scanned = 0;
  for (const rel of TRACKED) {
    if (!rel.endsWith(".mjs") || /\.test\.mjs$/.test(rel)) continue;
    if (!HELPER_TREES.some((d) => rel.startsWith(d))) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    offenders.push(...helperTreeOffences(rel, stripComments(fs.readFileSync(abs, "utf8"))));
  }
  assert.ok(scanned >= 29, `premise: the four trees hold at least the 29 guarded CLIs, scanned ${scanned}`);
  assert.deepStrictEqual(
    offenders,
    [],
    "these CLIs are silent no-ops from a junction or symlinked checkout:\n" + offenders.join("\n")
  );
});

test("CH2-41a rule: the offence detector names each legacy form and accepts the helper", () => {
  /* The rule above is green by construction if its detector is blind, so each
     legacy form from the swept trees, the helper imported from the wrong
     module, and a main() with no guard are fed through it here.
     MUTATION (run): drop the process.argv[1] pattern from helperTreeOffences ->
     the endsWith and realpath forms pass -> red. */
  const rel = "tools/mobile/x.mjs";
  const ok = 'import { isEntryScript } from "../ci/entry.mjs";\nfunction main() {}\nif (isEntryScript(import.meta.url)) main();\n';
  assert.deepStrictEqual(helperTreeOffences(rel, ok), []);
  const legacy = [
    "function main() {}\nif (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();\n",
    "function main() {}\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();\n",
    'const invokedAs = String(process.argv[1] || "");\nif (invokedAs.endsWith("/x.mjs")) run();\n',
    "const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));\n",
    "if (import.meta.main) run();\n",
  ];
  for (const src of legacy) assert.notDeepStrictEqual(helperTreeOffences(rel, src), [], src);
  assert.notDeepStrictEqual(
    helperTreeOffences(rel, 'import { isEntryScript } from "../ci/generate-manifest.mjs";\nfunction main() {}\nif (isEntryScript(import.meta.url)) main();\n'),
    [],
    "the helper imported from anywhere but tools/ci/entry.mjs"
  );
  assert.notDeepStrictEqual(helperTreeOffences(rel, "function main() {}\nmain();\n"), [], "a main() with no guard at all");
});
