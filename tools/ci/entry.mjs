/* One answer to "was this module run as a script, or imported?"
 *
 *     import { isEntryScript } from "../ci/entry.mjs";
 *     if (isEntryScript(import.meta.url)) main();
 *
 * WHY A HELPER (code-health CH2-41a, T2-04). The repo had five spellings of
 * this one line, and every one but generate-manifest.mjs's was wrong somewhere:
 *
 *   - `path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))`
 *   - `import.meta.url === pathToFileURL(process.argv[1]).href`
 *     Node REALPATHS the main module before it builds `import.meta.url`, but
 *     `process.argv[1]` is only made absolute. From a Windows junction or a
 *     symlinked checkout the two sides name different paths, the guard is
 *     false, and the CLI exits 0 having done nothing — reproduced with
 *     `node <junction>/tools/mobile/inject-splash.mjs android /nonexistent
 *     --check`, which printed nothing and exited 0.
 *   - `process.argv[1].endsWith("tools/release/watch-release.mjs")`
 *     Survives a junction (it compares names), and fires when ANY entry script
 *     with the same name imports the module.
 *   - `file://${process.argv[1]}` — never equal on Windows; the original bug,
 *     see tools/entrypoint-guards.test.mjs.
 *
 * REALPATH ON BOTH SIDES, CASE-FOLDED ON WINDOWS (moved here from
 * generate-manifest.mjs, round-2 review). A path that cannot be realpathed
 * (it does not exist) falls back to `path.resolve`, so the answer is false
 * rather than a throw at import time. Windows paths are compared without case
 * because a shell can report `c:\` where Node reports `C:\`.
 *
 * WHERE IT LIVES. tools/ci/ because the sparse checkouts in path-policy.yml,
 * pr-hygiene.yml and automerge-nightly.yml fetch only `tools/ci`, and their
 * scripts import this. Node builtins only, for the same reason.
 *
 * tools/entrypoint-guards.test.mjs makes this the only guard form allowed under
 * tools/ci, tools/release, tools/mobile and tools/ops (CH2-41b widens it to the
 * rest of tools/), and runs it through a real junction.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function realOrSelf(p) {
  let r;
  try { r = realpathSync(p); } catch (_) { r = path.resolve(p); }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** True when `a` and `b` name the same file or directory once both are
 *  realpathed (case-folded on Windows). Exported for generate-manifest.mjs's
 *  `--stamp` refusal ("is this directory the checkout I live in?"), which asks
 *  the same junction-proof question as the guard below and must not grow a
 *  second spelling of it. */
export function samePath(a, b) {
  return realOrSelf(a) === realOrSelf(b);
}

/** True when the module whose `import.meta.url` is `importMetaUrl` is the
 *  script Node was asked to run (`argv1`, default `process.argv[1]`); false
 *  when it was imported, and when there is no script (`node -e`, a REPL). */
export function isEntryScript(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return samePath(argv1, fileURLToPath(importMetaUrl));
}
