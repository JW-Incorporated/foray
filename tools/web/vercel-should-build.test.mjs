/* The Vercel Ignored Build Step's rules.
 *
 * FOUNDER, 2026-09-21: "$134 for this month. Most of that was build CPU
 * minutes." Every push to every branch ran two npm installs to copy twenty
 * static files, and most pushes here change nothing Vercel serves.
 *
 * WHAT THIS SUITE IS FOR. The saving is worth little and the risk is real: a
 * rule that skips a build it should have run leaves production on older bytes,
 * and nobody finds out until a listener hits a 404. So most of what is pinned
 * below is the FAILING OPEN — every way the decision can be uncertain, and that
 * each one builds anyway.
 *
 * Exit codes are Vercel's and are backwards from intuition: 1 = build,
 * 0 = skip. They are compared as numbers here rather than as booleans so a
 * future reader cannot mistake which way round they go.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decide, pathMatters, IGNORED_PREFIXES, IGNORED_PATTERNS, EXCEPTIONS } from "./vercel-should-build.mjs";

const BUILD = 1;
const SKIP = 0;

/* ---------- the deployed surface builds --------------------------------- */

test("every file prepare-dist.mjs actually deploys forces a build", () => {
  /* Read off `prepare-dist.mjs`'s own SHELL/RUNTIME_DATA/EXTRAS lists. If that
     file starts deploying something new, the new path is not on the deny-list
     and therefore builds by default — which is the whole reason this is a
     deny-list. MUTATION: add "app.js" to IGNORED_PREFIXES. */
  for (const p of [
    "index.html", "app.js", "search-engine.js", "styles.css", "sw.js",
    "manifest.json", "deploy-manifest.json", "icon-180.png", "icon-512.png",
    "data/session.json", "data/forays.json", "data/catalog-client.json",
    "vercel.json",
  ]) {
    assert.equal(pathMatters(p), true, `${p} is served and must build`);
  }
});

test("the api functions and the backend source they import force a build", () => {
  /* `api/**` is the functions themselves; `backend/src/**` is their import
     closure (parser, conditionalGet, ingestShowFeed, the stores). A change to
     either changes what the endpoint does. */
  assert.equal(pathMatters("api/shows/search.ts"), true);
  assert.equal(pathMatters("api/package.json"), true);
  assert.equal(pathMatters("backend/src/feeds/parser.ts"), true);
  assert.equal(pathMatters("backend/package.json"), true);
});

test("a player module builds, but a player TEST does not", () => {
  /* The subtle one. `prepare-dist.mjs` deploys `player/*.js` and not
     `player/*.test.js`, and both live in that directory — so the prefix is
     ignored and every non-test .js under it is rescued.
     MUTATION: drop the player rescue from EXCEPTIONS — the first assertion
     fails and a real player change would stop deploying. */
  assert.equal(pathMatters("player/client.js"), true);
  assert.equal(pathMatters("player/episode-progress.js"), true);
  assert.equal(pathMatters("player/episode-progress.test.js"), false);
  assert.equal(pathMatters("player/client.test.js"), false);
});

test("a NEW player module builds without anyone updating this file", () => {
  /* The property that makes the deny-list safe: nobody has to remember. */
  assert.equal(pathMatters("player/not-written-yet.js"), true);
});

test("the build script itself builds, but its test does not", () => {
  assert.equal(pathMatters("tools/web/prepare-dist.mjs"), true);
  assert.equal(pathMatters("tools/web/vercel-should-build.mjs"), true);
  assert.equal(pathMatters("tools/web/vercel-should-build.test.mjs"), false);
});

test("the one deployed file under docs/ builds", () => {
  /* `EXTRAS` in prepare-dist.mjs. Everything else under docs/ is prose. */
  assert.equal(pathMatters("docs/ux/foray-m3-prototype.html"), true);
  assert.equal(pathMatters("docs/DECISIONS.md"), false);
});

/* ---------- what may be skipped ----------------------------------------- */

test("the paths that cannot reach a deploy are skippable", () => {
  for (const p of [
    "test/app-security.test.js",
    "docs/roles.md",
    "ios/App/Player/PlayerQueueManager.swift",
    "mobile/www/index.html",
    ".github/workflows/ci.yml",
    "backend/test/copyRules.test.ts",
    "api/test/vercel-bundle.test.mjs",
    "tools/foray/check-forays.mjs",
    "tools/ci/path-policy.mjs",
  ]) {
    assert.equal(pathMatters(p), false, `${p} cannot change what Vercel serves`);
  }
});

test("root markdown is skippable — STATE.md and HUMAN-ACTIONS.md change constantly", () => {
  /* `prepare-dist.mjs` deploys no .md at all, and these two are written on
     nearly every branch here. A path with no slash is at the root by
     definition, so this cannot reach docs/ux/. */
  assert.equal(pathMatters("STATE.md"), false);
  assert.equal(pathMatters("HUMAN-ACTIONS.md"), false);
  assert.equal(pathMatters("README.md"), false);
  assert.equal(pathMatters("docs/ux/foray-m3-prototype.html"), true, "…and the one deployed doc still builds");
  assert.ok(IGNORED_PATTERNS.length >= 1);
});

test("a docs-and-tests-only commit skips", () => {
  assert.equal(decide(["docs/roles.md", "test/app-security.test.js", "STATE.md"]), SKIP);
});

test("the CI manifest commit is the common case and it does NOT skip", () => {
  /* `chore: auto-regenerate deploy-manifest.json` lands on nearly every PR and
     touches deploy-manifest.json, sw.js and data/forays-directory.json — all
     three of which ARE deployed. It doubles the builds per PR and it is
     supposed to: those bytes are what the service worker promotes on. Pinned
     so nobody "optimises" it away and ships a stale BUILD_ID. */
  assert.equal(decide(["deploy-manifest.json", "sw.js", "data/forays-directory.json"]), BUILD);
});

/* ---------- failing open ------------------------------------------------ */

test("one deployed file among a hundred irrelevant ones still builds", () => {
  const files = Array.from({ length: 100 }, (_, i) => `test/suite-${i}.test.js`);
  assert.equal(decide(files), SKIP);
  files.push("app.js");
  assert.equal(decide(files), BUILD, "a single deployed file is enough");
});

test("an empty or unreadable diff BUILDS — it is never read as nothing to do", () => {
  /* The most important assertion here. A shallow clone with no parent commit, an
     unknown base sha, or no git at all all arrive as "no files", and the only
     safe reading of "I cannot tell" is to build.
     MUTATION: return SKIP for an empty list. This goes red, and in production
     it would silently stop deploying on any commit whose diff failed to read. */
  assert.equal(decide([]), BUILD);
  assert.equal(decide(null), BUILD);
  assert.equal(decide(undefined), BUILD);
  assert.equal(decide("app.js"), BUILD, "a non-array is not a diff either");
});

test("an unrecognised path builds", () => {
  /* The deny-list's whole safety property: a directory nobody has thought about
     is assumed to matter. MUTATION: flip the final `return true` to false. */
  assert.equal(pathMatters("some-new-top-level-thing/file.js"), true);
  assert.equal(pathMatters("newfile-at-root.json"), true);
});

test("backslashes are normalised — this repo is developed on Windows", () => {
  /* `git diff --name-only` emits forward slashes, but a caller or a future
     source might not, and a path that fails to match its own prefix would be
     read as "unrecognised" and build. That is the safe direction, so this is
     about correctness rather than safety — but silent over-building is exactly
     what this file exists to stop. */
  assert.equal(pathMatters("test\\app-security.test.js"), false);
  assert.equal(pathMatters("player\\client.js"), true);
});

test("whitespace and blank lines are not treated as paths", () => {
  assert.equal(pathMatters(""), false);
  assert.equal(pathMatters("   "), false);
  assert.equal(decide(["", "   "]), SKIP, "a diff of blanks has nothing deployed in it");
});

/* ---------- the lists themselves ---------------------------------------- */

test("every ignored prefix ends in a slash, so it cannot match a sibling", () => {
  /* `"tools"` without the slash would also swallow a future `tools.json` at the
     root. Cheap to assert, and the failure would be silent. */
  for (const p of IGNORED_PREFIXES) {
    assert.ok(p.endsWith("/"), `${p} must end with a slash`);
  }
});

test("every exception is a function and at least one path reaches each", () => {
  /* An exception nobody can trigger is dead code that reads as protection.
     MUTATION: add a rescue for a path that cannot exist — this fails. */
  const samples = [
    "docs/ux/foray-m3-prototype.html",
    "tools/web/prepare-dist.mjs",
    "player/client.js",
  ];
  assert.equal(EXCEPTIONS.length, samples.length, "one sample per exception");
  for (const rescue of EXCEPTIONS) {
    assert.equal(typeof rescue, "function");
    assert.ok(samples.some((s) => rescue(s)), "every exception must rescue something real");
  }
});

/* ---------- previews are opt-in (founder, 2026-09-23) -------------------- */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { previewAllowed, PREVIEW_LABEL, PREVIEW_BRANCH_PREFIX } from "./vercel-should-build.mjs";

const SCRIPT = fileURLToPath(new URL("./vercel-should-build.mjs", import.meta.url));

/* Run the real CLI with a controlled environment. Everything Vercel-ish is
   stripped first so the developer's own shell cannot leak a VERCEL_ENV in. */
function runCli(extraEnv) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("VERCEL_")) delete env[k];
  return spawnSync(process.execPath, [SCRIPT], { env: { ...env, ...extraEnv }, encoding: "utf8" });
}

test("a preview with no label and an ordinary branch name is skipped", () => {
  /* MUTATION: return allow:true at the end of previewAllowed — this fails. */
  const v = previewAllowed({ branch: "audit-fix/l1-identity-nav", labels: [] });
  assert.equal(v.allow, false);
  assert.equal(previewAllowed({ branch: "fix/x", labels: ["bug", "needs-founder"] }).allow, false);
});

test("a preview is allowed by the label or by a preview/ branch", () => {
  assert.equal(previewAllowed({ branch: "fix/x", labels: [PREVIEW_LABEL] }).allow, true);
  assert.equal(previewAllowed({ branch: `${PREVIEW_BRANCH_PREFIX}search-pill`, labels: null }).allow, true);
  /* The prefix is a prefix, not a substring. */
  assert.equal(previewAllowed({ branch: "fix/preview/thing", labels: [] }).allow, false);
});

test("unreadable labels SKIP a preview — the one place this file fails closed", () => {
  /* The inverse of the path rules' fail-open, on purpose: a skipped preview
     costs nobody anything. MUTATION: treat labels === null as allow. */
  const v = previewAllowed({ branch: "fix/x", labels: null });
  assert.equal(v.allow, false);
  assert.match(v.reason, /could not be read/);
});

test("CLI: production ALWAYS builds, whatever the branch or labels", () => {
  /* MUTATION: move the preview gate above the production early-return. */
  const r = runCli({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });
  assert.equal(r.status, BUILD, r.stdout + r.stderr);
});

test("CLI: a preview whose labels cannot be read exits SKIP without touching git", () => {
  /* No VERCEL_GIT_REPO_OWNER/SLUG -> prLabels returns null without a network
     call, so this is hermetic. */
  const r = runCli({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "audit-fix/integration" });
  assert.equal(r.status, SKIP, r.stdout + r.stderr);
  assert.match(r.stdout, /skip preview/);
});

test("CLI: a preview/ branch passes the gate and falls through to the path rules", () => {
  const r = runCli({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "preview/try-this" });
  assert.match(r.stdout, /preview requested/);
  assert.ok(r.status === BUILD || r.status === SKIP, `exit ${r.status}`);
});
