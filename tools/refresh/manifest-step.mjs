/* The nightly merge's deploy-manifest step (HUMAN-ACTIONS #37, 2026-09-03).
 *
 * WHY THE NIGHTLY REGENERATES THE MANIFEST ITSELF
 * `deploy-manifest.json` carries a sha256 per shipped file, and the nightly
 * always rewrites `data/discover.json` + `data/item-tags.json`, both of which
 * are on the manifest's list. So every nightly PR left the manifest stale and
 * the required `data-and-site` check red, until `manifest-autofix.yml` pushed a
 * `github-actions[bot]` fixup commit to the PR branch.
 *
 * That fixup is what made nightly PRs unmergeable. `protect-main` sets
 * `require_extra_approval_for_unattributed_changes: true` — a bot-authored
 * commit demands one approving review, and GitHub forbids a PR's author from
 * approving their own PR. PR #443 and PR #456 both deadlocked exactly this way
 * on 2026-09-03: every required check green, nobody able to press merge.
 *
 * The fix is not to weaken that rule — it exists so machine-authored changes
 * get a human vouching for them. The fix is to not create an unattributed
 * commit at all: regenerate the manifest HERE, in the same run that wrote the
 * data files, so the nightly's own first commit is already correct and
 * `manifest-autofix` finds nothing to do. The autofix workflow stays as the
 * safety net for every other PR.
 *
 * Split out of merge.mjs (rather than inlined) purely so it is testable:
 * merge.mjs runs its work at module top level and cannot be imported.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const MANIFEST_SCRIPT = fileURLToPath(new URL("../ci/generate-manifest.mjs", import.meta.url));

/* The env vars that redirect merge.mjs's OUTPUTS away from the real data/
   files. merge-topics.test.mjs uses them to run the real merge against a temp
   directory. The INPUT overrides (RESOLVED_PATH, EDITS_PATH) are deliberately
   not here: reading a digest from elsewhere still produces a real data/ write
   that the manifest must describe. */
export const OUTPUT_DEFAULTS = {
  MERGE_DISCOVER_PATH: "data/discover.json",
  MERGE_TAGS_PATH: "data/item-tags.json",
};
export const OUTPUT_REDIRECT_VARS = Object.keys(OUTPUT_DEFAULTS);

/* Mirrors merge.mjs's `envPath`: an env value resolves against the CWD, a
   default against the repo root. A var set to the REAL file is not a redirect
   — deciding on mere presence would let `MERGE_DISCOVER_PATH=data/discover.json`
   skip the restamp and bring the #443 deadlock back with nothing going red. */
function isRedirected(name, env, cwd) {
  if (!env[name]) return false;
  return resolvePath(cwd, env[name]) !== resolvePath(ROOT, OUTPUT_DEFAULTS[name]);
}

/**
 * Why this run must NOT restamp the manifest, or null if it should.
 *
 * The one reason is a redirected output path. `deploy-manifest.json` describes
 * the real committed tree; a run that wrote its catalogue to a temp directory
 * changed nothing the manifest covers, so regenerating would at best be a
 * no-op and at worst — on a Windows checkout — corrupt a file the run never
 * touched. Skipping is not a convenience; it is what keeps `merge.mjs` safe to
 * exercise from a test suite.
 */
export function manifestSkipReason(env = process.env, cwd = process.cwd()) {
  const redirected = OUTPUT_REDIRECT_VARS.filter((k) => isRedirected(k, env, cwd));
  if (redirected.length === 0) return null;
  return (
    `${redirected.join(" + ")} redirected the merge outputs away from data/, so the ` +
    `real tree deploy-manifest.json describes was not modified and must not be restamped`
  );
}

/* Default runner: the same command manifest-autofix.yml runs, as a subprocess.
   A subprocess and not an import because generate-manifest.mjs runs its CLI at
   module top level — see tools/ci/crlf-guard.mjs on why that entrypoint is
   deliberately left alone. `stdio: inherit` so its CRLF refusal, which is the
   whole local-development safety story, reaches the operator verbatim. */
function runManifestScript(script) {
  execFileSync(process.execPath, [script, "--write"], { stdio: "inherit" });
}

/**
 * Regenerate deploy-manifest.json + sw.js's BUILD_ID for this merge, unless the
 * run redirected its outputs.
 *
 * -> { ran, reason }   `reason` is the skip reason when `ran` is false.
 * Throws with a commit-blocking message if the generator fails — including the
 * CRLF refusal, which is precisely the case where committing anyway would ship
 * 40 wrong hashes.
 */
export function stampDeployManifest({ env = process.env, cwd = process.cwd(), run = runManifestScript, log = console.log } = {}) {
  const reason = manifestSkipReason(env, cwd);
  if (reason) {
    log(`MANIFEST: skipped — ${reason}.`);
    return { ran: false, reason };
  }
  try {
    run(MANIFEST_SCRIPT);
  } catch (err) {
    throw new Error(
      "deploy-manifest.json could NOT be regenerated after the merge wrote " +
        "data/discover.json and data/item-tags.json (cause above). DO NOT COMMIT this " +
        "tree: the manifest is now stale against the data files, `data-and-site` would " +
        "fail on the PR, and the bot fixup that unstales it is the very commit that " +
        "makes a nightly PR unmergeable. Reason: " +
        (err && err.message ? err.message : String(err))
    );
  }
  log("MANIFEST: deploy-manifest.json regenerated and sw.js BUILD_ID restamped in this commit.");
  return { ran: true, reason: null };
}
