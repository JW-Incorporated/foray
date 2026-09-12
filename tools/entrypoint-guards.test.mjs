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
 * Not "every script has an entrypoint guard" — `tools/ci/generate-manifest.mjs`
 * deliberately has none, and `tools/ci/crlf-guard.mjs`'s header argues the case
 * at length. Only: a file that HAS one must use `pathToFileURL`, which is the
 * only formulation that is correct on both platforms. And, for the script that
 * actually had the bug, an executable proof that running it does something.
 *
 * This test is platform-independent: the text rule holds everywhere, so a Linux
 * runner gates the Windows failure it cannot itself reproduce.
 */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
