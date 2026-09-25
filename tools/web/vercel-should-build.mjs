/* Vercel's Ignored Build Step: decide whether this commit can change anything
 * Vercel actually serves.
 *
 * FOUNDER, 2026-09-21: "My vercel bill was very high, $134 for this month. Most
 * of that was build CPU minutes."
 *
 * WHY THE BILL IS BUILD MINUTES RATHER THAN TRAFFIC. Every push to every branch
 * triggers a full preview build, and a full build here is expensive for a
 * no-build static site: `installCommand` runs TWO npm installs (`api` and
 * `backend`, the latter carrying `@anthropic-ai/sdk`) before
 * `prepare-dist.mjs` copies about twenty files. The copying is free; the
 * installs are not.
 *
 * And this repo pushes a great deal that Vercel does not serve: test suites,
 * `docs/`, `ios/`, `mobile/`, `.github/`, `STATE.md` and `HUMAN-ACTIONS.md`.
 * (Until issue #701 it also pushed a `chore: auto-regenerate deploy-manifest.json`
 * commit onto nearly every PR, which on its own doubled the builds per pull
 * request; the stamp is generated at build time now and that commit is gone.)
 *
 * ── THE RULE, AND WHY IT IS SHAPED THIS WAY ─────────────────────────────────
 *
 * It is a DENY-LIST of paths that provably cannot reach `dist/` or `api/`, and
 * it FAILS OPEN: anything not on the list, and any situation it cannot read
 * confidently, builds.
 *
 * The alternative — an allow-list mirroring `prepare-dist.mjs`'s `SHELL`,
 * `RUNTIME_DATA` and `playerSources()` — is the obvious shape and is the wrong
 * one. Those lists change, and a list that has drifted OUT OF DATE in the
 * allow-list direction silently stops deploying a file that has started
 * mattering. In the deny-list direction the same drift merely costs a build
 * nobody needed. One failure mode is a production 404 that nobody sees until a
 * listener hits it; the other is a few cents.
 *
 * PREVIEWS ARE THE EXCEPTION (2026-09-23): a non-production build first has
 * to be ASKED for — see "previews are opt-in only" below — and there the rule
 * fails CLOSED, because a skipped preview harms nobody.
 *
 * Exit codes are Vercel's, and they are backwards from intuition:
 *   exit 1 -> BUILD.  exit 0 -> SKIP.
 *
 * Wired as `ignoreCommand` in `vercel.json`. `tools/web/vercel-should-build.test.mjs`
 * owns the rules.
 */

import { execFileSync } from "node:child_process";

/** BUILD. Named so the call sites read as decisions rather than as exit codes. */
const BUILD = 1;
/** SKIP. */
const SKIP = 0;

/**
 * Paths that cannot change what Vercel serves.
 *
 * Each entry is checked as a prefix against a repo-relative path with forward
 * slashes. Order does not matter; `EXCEPTIONS` below is what rescues the few
 * files that live under an ignored prefix and ARE deployed.
 */
export const IGNORED_PREFIXES = [
  "test/",              // root suites — never served
  "docs/",              // prose; nothing under docs/ deploys (security-11)
  "ios/",               // reference material, not the shipping app
  "mobile/",            // the Capacitor shell; its own build path entirely
  ".github/",           // CI
  ".claude/",           // agent config
  "backend/test/",      // tests, not the src the functions import
  "api/_test/",
  "tools/",             // except tools/web/, see EXCEPTIONS — this script included
  "archive/",
  "data-local/",        // gitignored in practice; listed so a stray add is free
  "audio-cache/",
  "player/",            // except player/*.js, see EXCEPTIONS — the TESTS are here too
];

/**
 * Files under an ignored prefix that ARE deployed, so a change to one must
 * build. Checked before `IGNORED_PREFIXES`.
 *
 * `player/` is the subtle one: `prepare-dist.mjs` deploys `player/*.js` but not
 * `player/*.test.js`, and both live in that directory. So the prefix is ignored
 * and every non-test file under it is rescued — which means a NEW player module
 * builds (correct) and only a test does not.
 */
/* The deploy stamp's modules (issue #701): `prepare-dist.mjs` imports them to
   write deploy-manifest.json, the Foray directory pointer and sw.js's BUILD_ID
   into dist/, so a change to one changes the bytes Vercel serves exactly as a
   change to prepare-dist.mjs itself does. Named, not a `tools/ci/` prefix: the
   rest of that directory is CI policy and never reaches a deploy. */
export const STAMP_MODULES = [
  "tools/ci/generate-manifest.mjs",
  "tools/ci/forays-directory.mjs",
  "tools/ci/crlf-guard.mjs",
];

export const EXCEPTIONS = [
  (p) => p.startsWith("tools/web/") && !p.endsWith(".test.mjs"),
  (p) => STAMP_MODULES.includes(p),
  (p) => p.startsWith("player/") && p.endsWith(".js") && !p.endsWith(".test.js"),
];

/**
 * Rules that are not a simple prefix. Kept separate so `IGNORED_PREFIXES` can
 * keep its "must end in a slash" invariant.
 *
 * Root-level markdown is the one that earns its place: `STATE.md` and
 * `HUMAN-ACTIONS.md` are written on nearly every branch in this repo and
 * `prepare-dist.mjs` deploys no `.md` at all. A file with no slash in it is at
 * the root by definition, so this cannot reach `docs/ux/`.
 */
export const IGNORED_PATTERNS = [
  (p) => !p.includes("/") && p.endsWith(".md"),
];

/** Does this one path matter to a deploy? */
export function pathMatters(rel) {
  const p = String(rel).replace(/\\/g, "/").trim();
  if (!p) return false;
  for (const rescue of EXCEPTIONS) if (rescue(p)) return true;
  for (const prefix of IGNORED_PREFIXES) if (p.startsWith(prefix)) return false;
  for (const rule of IGNORED_PATTERNS) if (rule(p)) return false;
  return true; // fail open: anything unrecognised is assumed to matter
}

/**
 * The decision, given a list of changed paths.
 *
 * An EMPTY list builds. "No files changed" is not a thing a real push does, so
 * it means the diff could not be read — and an unreadable diff must never be
 * read as "nothing to do".
 */
export function decide(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return BUILD;
  return changedPaths.some(pathMatters) ? BUILD : SKIP;
}

/* ------------------------------------------------ previews are opt-in only */

/* FOUNDER, 2026-09-23, on the Vercel bill: "Yeah make that change" — to skipping
 * preview builds for every branch except `main` unless a PR asks for one.
 *
 * WHY THE PATH RULES ABOVE WERE NOT ENOUGH. They skip pushes that change
 * nothing Vercel serves, and that caught docs and tests. But the work that
 * dominates this repo now — fix fleets of eight parallel branches plus an
 * integration branch plus repair pushes, and the CI manifest commit on top of
 * each — edits `app.js`, `styles.css` and `player/*.js`, which ARE served. So
 * every one of those pushes paid two npm installs for a preview that nobody
 * opened. Nothing depends on a preview: the required checks are `backend` and
 * `data-and-site`, and Playwright runs in CI against its own local server.
 *
 * THIS INVERTS THE FILE'S FAIL-OPEN RULE, DELIBERATELY, AND ONLY FOR PREVIEWS.
 * Fail-open exists because a skipped PRODUCTION build leaves listeners on old
 * bytes. A skipped preview costs nobody anything, so for previews "I cannot
 * tell" means skip. Production is untouched: `main()` still returns BUILD for
 * `VERCEL_ENV === "production"` before any of this runs.
 *
 * TWO WAYS TO ASK FOR ONE:
 *   - a branch named `preview/...` — reliable, needs no network;
 *   - a `preview` label on the branch's open PR — best-effort: it is read from
 *     GitHub's unauthenticated API, which Vercel's shared build IPs can exhaust,
 *     and any failure to read it skips. Adding the label does not itself start
 *     a build; the next push (or a Redeploy in Vercel) does.
 * Either way the path rules still apply: a preview that changes nothing served
 * still skips. */

export const PREVIEW_LABEL = "preview";
export const PREVIEW_BRANCH_PREFIX = "preview/";

/** Pure: may this preview build at all? `labels` is null when they could not be read. */
export function previewAllowed({ branch, labels }) {
  if (String(branch || "").startsWith(PREVIEW_BRANCH_PREFIX)) {
    return { allow: true, reason: `branch starts with ${PREVIEW_BRANCH_PREFIX}` };
  }
  if (Array.isArray(labels) && labels.includes(PREVIEW_LABEL)) {
    return { allow: true, reason: `PR carries the "${PREVIEW_LABEL}" label` };
  }
  if (labels === null) {
    return { allow: false, reason: "PR labels could not be read; previews are opt-in, so skip" };
  }
  return { allow: false, reason: `previews are opt-in: no "${PREVIEW_LABEL}" label and branch is not ${PREVIEW_BRANCH_PREFIX}*` };
}

/** The labels on the branch's PR, [] when there is no open PR, null when unreadable. */
async function prLabels(env) {
  const owner = env.VERCEL_GIT_REPO_OWNER;
  const repo = env.VERCEL_GIT_REPO_SLUG;
  const branch = env.VERCEL_GIT_COMMIT_REF;
  if (!owner || !repo || !branch || typeof fetch !== "function") return null;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const get = async (url) => {
    const res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "foray-vercel-should-build" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    const pr = env.VERCEL_GIT_PULL_REQUEST_ID;
    if (pr) return (await get(`${api}/issues/${encodeURIComponent(pr)}/labels`)).map((l) => l.name);
    const pulls = await get(`${api}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    return pulls.flatMap((p) => (p.labels || []).map((l) => l.name));
  } catch (err) {
    console.log(`[vercel-should-build] could not read PR labels (${err.message})`);
    return null;
  }
}

/* ------------------------------------------------------------------ the CLI */

function changedFiles() {
  /* `VERCEL_GIT_PREVIOUS_SHA` is the commit Vercel last built on this branch.
     It is the honest base when it exists — a push of five commits must be
     judged on all five, not on the tip. `HEAD^` is the fallback and is only
     right for a single-commit push, so it is used only when the better answer
     is unavailable. Either way an unresolvable base returns null and builds. */
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA || "HEAD^";
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}`, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return files.length ? files : null;
  } catch (_) {
    /* A shallow clone with no parent, an unknown sha, no git at all. Every one
       of these is "I cannot tell", and the answer to that is always: build. */
    return null;
  }
}

async function main() {
  /* PRODUCTION ALWAYS BUILDS. A skipped production deploy leaves the live site
     on older bytes while `main` says otherwise, and the saving is one build a
     merge. Previews are where the volume is. */
  if (process.env.VERCEL_ENV === "production") return BUILD;

  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const labels = String(branch || "").startsWith(PREVIEW_BRANCH_PREFIX) ? [] : await prLabels(process.env);
  const preview = previewAllowed({ branch, labels });
  if (!preview.allow) {
    console.log(`[vercel-should-build] skip preview — ${preview.reason}`);
    return SKIP;
  }
  console.log(`[vercel-should-build] preview requested — ${preview.reason}`);

  const files = changedFiles();
  if (!files) return BUILD;
  const verdict = decide(files);
  /* Printed either way: a build that was skipped should say why it was skipped,
     in the one place someone reading the Vercel log will look. */
  const mattering = files.filter(pathMatters);
  if (verdict === SKIP) {
    console.log(`[vercel-should-build] skip — ${files.length} changed file(s), none deployed`);
  } else {
    console.log(`[vercel-should-build] build — ${mattering.length}/${files.length} changed file(s) are deployed:`);
    for (const f of mattering.slice(0, 10)) console.log(`  ${f}`);
  }
  return verdict;
}

/* Entrypoint guard. Compares BASENAMES rather than building a file:// URL from
   `process.argv[1]`: on Windows that path uses backslashes and needs escaping,
   and when this module is imported by a test or by `node -e` there is no argv[1]
   at all -- the first draft threw a TypeError on exactly that, which would have
   made the module unimportable. A name comparison has neither problem. */
const invokedAs = String(process.argv[1] || "").split(String.fromCharCode(92)).join("/");
if (invokedAs.endsWith("/vercel-should-build.mjs") || invokedAs.endsWith("vercel-should-build.mjs")) {
  /* Async because the label read is a fetch. A throw anywhere in main is a
     preview we could not reason about (production returned before any await),
     so it skips rather than builds. */
  /* exitCode, not process.exit(): exiting synchronously while fetch's socket
     is still closing aborts Node on Windows (libuv UV_HANDLE_CLOSING). */
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.log(`[vercel-should-build] skip preview — unexpected error: ${err && err.message}`);
      process.exitCode = process.env.VERCEL_ENV === "production" ? BUILD : SKIP;
    },
  );
}
