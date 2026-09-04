/* The nightly merge's deploy-manifest step — tools/refresh/manifest-step.mjs.
 *
 * WHAT IS ACTUALLY AT STAKE. This step exists to stop a `github-actions[bot]`
 * commit from ever being pushed to a nightly PR. `protect-main` sets
 * `require_extra_approval_for_unattributed_changes: true`, so a bot commit
 * demands one approving review, and GitHub forbids a PR's author from approving
 * their own PR — PR #443 and PR #456 both deadlocked that way on 2026-09-03,
 * green on every required check and unmergeable by the only person looking.
 * If this step silently stops running, nothing goes red: `manifest-autofix.yml`
 * pushes the bot commit again and nightly PRs quietly go back to needing a
 * human who cannot help. So "did it run, and did it run the right command" is
 * the thing to pin, not the manifest's contents (`generate-manifest.mjs
 * --check` in the required `data-and-site` job already pins those).
 *
 * THE HARNESS IS NOT MORE FORGIVING THAN THE REAL THING. The runner is injected
 * rather than faked-around: `stampDeployManifest` calls whatever `run` it is
 * given with the same argument the real one gets, so a test observes the real
 * decision and the real path. The one thing not exercised here is the
 * subprocess itself — deliberately, because the real subprocess rewrites
 * `deploy-manifest.json` and `sw.js` in the checkout, and on the Windows
 * development checkout that is precisely the corruption `tools/ci/crlf-guard.mjs`
 * exists to refuse. `merge-topics.test.mjs` covers the other half: that the
 * real `merge.mjs` consults this step at all.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT KILLS IT, per CLAUDE.md § "A
 * green test is not evidence until you have broken it". Each was applied and
 * observed to fail before this file was committed.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.
 */

import { test } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

import {
  MANIFEST_SCRIPT,
  OUTPUT_REDIRECT_VARS,
  manifestSkipReason,
  stampDeployManifest,
} from "./manifest-step.mjs";

/* Collects what stampDeployManifest did, so nothing is asserted by inference. */
function spy() {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    run: (script) => calls.push(script),
    log: (line) => logs.push(line),
  };
}

// ------------------------------------------------------------ the decision --

test("an ordinary nightly run — no overrides — restamps the manifest", () => {
  /* The default path, and the entire point of the change. If this ever returns
     a skip reason, nightly PRs go back to carrying a bot fixup commit and
     deadlocking on an approval nobody can give.
     KILLED BY: `if (redirected.length === 0) return "nothing to do";` in
     manifestSkipReason. */
  assert.equal(manifestSkipReason({}), null);
  const s = spy();
  const out = stampDeployManifest({ env: {}, run: s.run, log: s.log });
  assert.equal(out.ran, true);
  assert.equal(out.reason, null);
  assert.deepEqual(s.calls, [MANIFEST_SCRIPT]);
});

test("it runs generate-manifest.mjs, and that file is really there", () => {
  /* A wrong or moved path would make execFileSync fail at runtime on the
     nightly runner, in the one place nobody watches. Resolving it against the
     real filesystem is what makes this test more than a string comparison.
     KILLED BY: `new URL("../ci/generate-manifest.mjs", ...)` ->
     `new URL("../ci/manifest.mjs", ...)` in manifest-step.mjs. */
  assert.ok(MANIFEST_SCRIPT.endsWith("generate-manifest.mjs"), MANIFEST_SCRIPT);
  assert.ok(existsSync(MANIFEST_SCRIPT), `${MANIFEST_SCRIPT} does not exist`);
});

test("EITHER redirected output path skips the step, not only the first one", () => {
  /* merge-topics.test.mjs sets both, but a future test setting only the tags
     path must be just as safe. Checking one variable and not the other is a
     one-character bug that would only ever be hit by a test that does not exist
     yet — i.e. it would land green and bite later.
     KILLED BY: `const redirected = env.MERGE_DISCOVER_PATH ? ["MERGE_DISCOVER_PATH"] : [];`
     in manifestSkipReason. */
  for (const v of OUTPUT_REDIRECT_VARS) {
    const reason = manifestSkipReason({ [v]: "/tmp/somewhere" });
    assert.ok(reason, `${v} alone did not skip the manifest step`);
    assert.match(reason, new RegExp(v));
  }
  assert.deepEqual(OUTPUT_REDIRECT_VARS, ["MERGE_DISCOVER_PATH", "MERGE_TAGS_PATH"]);
});

test("an output var set to the REAL file is not a redirect, so the manifest still restamps", () => {
  /* Reviewer finding, 2026-09-03. merge.mjs resolves an env value against the
     CWD and a default against the repo root; a value that lands on the same
     file changed exactly what the manifest describes. Deciding on presence
     alone would let an explicitly-set default path skip the restamp, and the
     #443 deadlock would return with nothing going red.
     KILLED BY: `const redirected = OUTPUT_REDIRECT_VARS.filter((k) => env[k]);`
     in manifestSkipReason — presence alone, the pre-review behaviour. */
  const real = { MERGE_DISCOVER_PATH: "data/discover.json", MERGE_TAGS_PATH: path.join(ROOT, "data", "item-tags.json") };
  assert.equal(manifestSkipReason(real, ROOT), null);
  /* ...and the SAME relative string from a different CWD is a different file,
     so it IS a redirect. The decision is about the file, not the string. */
  assert.match(manifestSkipReason({ MERGE_DISCOVER_PATH: "data/discover.json" }, tmpdir()), /MERGE_DISCOVER_PATH/);
});

test("a skipped run does not invoke the generator at all", () => {
  /* The skip is a SAFETY property, not a tidy-output one: running the real
     generator during a redirected merge rewrites deploy-manifest.json and sw.js
     in a checkout the test never intended to touch.
     KILLED BY: deleting the `if (reason) { ...; return ... }` early return in
     stampDeployManifest. */
  const s = spy();
  const out = stampDeployManifest({ env: { MERGE_TAGS_PATH: "/tmp/t.json" }, run: s.run, log: s.log });
  assert.equal(out.ran, false);
  assert.ok(out.reason);
  assert.deepEqual(s.calls, []);
});

test("the skip is announced on stdout, because a silent skip is indistinguishable from a bug", () => {
  /* This line is what merge-topics.test.mjs reads to prove the real merge.mjs
     reached this code at all.
     KILLED BY: deleting the `log(\`MANIFEST: skipped — ${reason}.\`);` line. */
  const s = spy();
  stampDeployManifest({ env: { MERGE_DISCOVER_PATH: "/tmp/d.json" }, run: s.run, log: s.log });
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /^MANIFEST: skipped — /);
  assert.match(s.logs[0], /MERGE_DISCOVER_PATH/);
});

test("a run that DID restamp says so, naming both files it changed", () => {
  /* The nightly runner prompt tells the agent to `git add` those two files. A
     line that does not name them is a line the agent cannot act on.
     KILLED BY: deleting the final `log("MANIFEST: deploy-manifest.json ...")`
     line in stampDeployManifest. */
  const s = spy();
  stampDeployManifest({ env: {}, run: s.run, log: s.log });
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /deploy-manifest\.json/);
  assert.match(s.logs[0], /sw\.js/);
});

// ------------------------------------------------------------- the failure --

test("a generator failure is fatal and says DO NOT COMMIT, rather than being swallowed", () => {
  /* The data files are ALREADY written when this runs. Continuing past a failed
     regeneration produces exactly the tree the whole change exists to prevent:
     data files updated, manifest stale, `data-and-site` red, and the bot fixup
     commit — the unmergeable one — pushed to repair it.
     KILLED BY: replacing the `try { run(...) } catch { throw ... }` in
     stampDeployManifest with a bare `run(MANIFEST_SCRIPT);`, which lets the raw
     execFileSync error out with no instruction attached... */
  const s = spy();
  assert.throws(
    () =>
      stampDeployManifest({
        env: {},
        log: s.log,
        run: () => {
          throw new Error("Command failed: generate-manifest.mjs --write");
        },
      }),
    (err) => {
      assert.match(err.message, /DO NOT COMMIT/);
      assert.match(err.message, /deploy-manifest\.json/);
      /* ...and the cause must survive, or the CRLF refusal — the whole
         local-development safety story — is replaced by a generic message. */
      assert.match(err.message, /generate-manifest\.mjs --write/);
      return true;
    }
  );
});

test("a failure is not reported as a successful restamp", () => {
  /* KILLED BY: wrapping the `run(...)` call in `try { ... } catch (e) {}` in
     stampDeployManifest — the step then returns { ran: true } after doing
     nothing, and merge.mjs commits a stale manifest believing it is current. */
  const s = spy();
  let returned = "did not return";
  try {
    returned = stampDeployManifest({
      env: {},
      log: s.log,
      run: () => {
        throw new Error("boom");
      },
    });
  } catch {
    returned = "threw";
  }
  assert.equal(returned, "threw");
  assert.deepEqual(s.logs, [], "a failed run must not log a success line");
});
