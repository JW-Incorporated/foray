/* The LF-checkout guard for `tools/ci/generate-manifest.mjs`.
 *
 * WHY IT IS ITS OWN FILE
 * `generate-manifest.mjs` calls `main()` at module top level — importing it
 * from a test would run the CLI and exit(2) on the usage error. The obvious
 * fix (an `import.meta.url === argv[1]` entrypoint guard) was rejected: that
 * file is the `data-and-site` manifest gate, and an entrypoint check that ever
 * misfires on a runner turns `--check` into a no-op that exits 0 — a gate
 * certifying nothing, which is the exact failure class CLAUDE.md § "A green
 * test is not evidence" is about. A pure module both sides import costs one
 * file and risks nothing.
 *
 * THE HAZARD IT GUARDS
 * The manifest hashes the bytes ON DISK. This repo commits LF and is developed
 * on Windows with `core.autocrlf=true`, so every text file in a developer
 * checkout is CRLF while the committed blob — the byte stream GitHub Pages
 * serves and `sw.js` verifies in the browser — is LF. Running `--write` there
 * rewrites all 40 entries to CRLF-derived hashes. The commit looks plausible
 * and `--check` even passes locally, but `data-and-site` fails on CI, and if it
 * somehow did not, every client's install-time hash verification would reject
 * the generation and no deploy would ever promote.
 *
 * Measured on 2026-09-03 in a `core.autocrlf=true` worktree of `main`: 37 of the 38
 * listed text files differ from their committed blobs, and `--check` reported
 * "deploy-manifest.json is stale" — advice that sends the reader to run the one
 * command that breaks it.
 *
 * WHY REFUSE RATHER THAN NORMALISE
 * Normalising (stripping `\r` before hashing) would make the hash mean "the
 * bytes with CRLF collapsed" instead of "the bytes we ship" — the same class of
 * lie one layer down — and would silently mis-hash any file that ever
 * legitimately ships CRLF.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/* Listed files whose bytes are NOT text, so git never rewrites their line
   endings and a `\r\n` inside them is ordinary binary payload rather than a
   checkout artefact.
   THIS EXCLUSION IS LOAD-BEARING, NOT DEFENSIVE: both committed icons really
   do contain `\r\n` byte pairs (verified against `git cat-file blob` on
   2026-09-03), so without it the guard fires on a clean Linux CI checkout and
   blocks every manifest run. Kept as an explicit set rather than a suffix
   guess, for the same reason generate-manifest.mjs's SHELL is explicit: a new
   binary shell file must be classified deliberately, and a text file wrongly
   listed here would silently disable the guard for it. */
export const BINARY_LISTED = new Set(["icon-180.png", "icon-512.png"]);

/**
 * Which of `files` (repo-relative, resolved against `root`) hold CRLF bytes.
 *
 * Both arguments are injected rather than derived so the guard is testable
 * without a CRLF checkout — see tools/ci/crlf-guard.test.mjs.
 * Returns POSIX-slashed paths, matching the manifest's own keys.
 */
export function crlfOffenders(root, files) {
  const bad = [];
  for (const rel of files) {
    const key = rel.split(path.sep).join("/");
    if (BINARY_LISTED.has(key)) continue;
    const abs = path.join(root, rel);
    /* A missing file is not this guard's business: sha256File reports it with a
       far better message, and swallowing it here would hide it. */
    if (!existsSync(abs)) continue;
    if (readFileSync(abs).includes("\r\n")) bad.push(key);
  }
  return bad;
}

/** The operator-facing text for a non-empty `crlfOffenders` result. */
export function crlfFatalMessage(bad) {
  return (
    "FATAL: this checkout has CRLF line endings in files the deploy manifest hashes,\n" +
    "so every hash generated here would describe bytes that are not what we ship.\n" +
    `  offenders (${bad.length}): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""}\n` +
    "\n" +
    "This is the Windows `core.autocrlf=true` checkout, NOT a stale manifest.\n" +
    "Do NOT 'fix' it by running --write: that is the failure mode this guard exists for.\n" +
    "\n" +
    "Either let CI regenerate it (tools/refresh/merge.mjs does it on the nightly's Linux\n" +
    "runner, and .github/workflows/manifest-autofix.yml does it for any other PR), or\n" +
    "renormalise first: `git config core.autocrlf false`, then re-materialise the tree\n" +
    "in a fresh clone or worktree."
  );
}
