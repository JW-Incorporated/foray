/* The LF-checkout guard for `tools/ci/generate-manifest.mjs`'s build stamp.
 *
 * WHY IT IS ITS OWN FILE
 * A pure module that the stamper, `tools/mobile/prepare-webdir.mjs` and the
 * tests all import, with no CLI attached. It costs one file and risks nothing.
 *
 * THE HAZARD IT GUARDS
 * The manifest hashes the bytes ON DISK. This repo commits LF and is developed
 * on Windows with `core.autocrlf=true`, so every text file in a developer
 * checkout is CRLF while the committed blob — the byte stream the deploys
 * (Vercel and the Pages workflow, both on Linux) serve and `sw.js` verifies in
 * the browser — is LF. A stamp computed there carries 40 CRLF-derived hashes
 * and a deploy id that no live origin will ever serve.
 *
 * Since issue #701 (2026-09-24) nothing this guards is committed: the stamp is
 * written into a BUILT tree at deploy time. The guard still refuses a CRLF
 * build (`prepare-dist.mjs`, `generate-manifest.mjs --stamp`), and
 * `prepare-webdir.mjs` leaves the seed's version stamp out rather than bundle a
 * wrong one.
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
export const BINARY_LISTED = new Set([
  "icon-180.png", "icon-512.png",
  /* The brand faces joined the manifest in audit round 2 (perf-5), and two of
     the three contain `
` byte pairs: without these the guard refused every
     manifest run, on Linux CI as much as on Windows. */
  "fonts/dm-sans-variable.woff2", "fonts/fraunces-italic-variable.woff2", "fonts/fraunces-variable.woff2",
]);

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
    "Do NOT 'fix' it by running --write or by committing a stamp: nothing here is\n" +
    "committed any more (issue #701). The deploy builds stamp it on Linux runners.\n" +
    "\n" +
    "For a local build, renormalise first: `git config core.autocrlf false`, then\n" +
    "re-materialise the tree in a fresh clone or worktree."
  );
}
