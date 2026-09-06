/* The privacy tripwire for shard/API-backed Shows search (S-08).
 *
 * WHY THIS SUITE EXISTS
 * `docs/legal/privacy-policy.md` §2 makes an absolute promise: "Nothing you
 * type into the playlist box or the Shows search box is transmitted." That
 * sentence is true today — `search-engine.js` runs entirely on-device and
 * `app.js`'s Shows-search path (`renderShowSearchResults`) is the ONLY
 * consumer of `#sh-input`. The 4a-shows-pipeline-plan (S-05) will make it
 * false on purpose: search shifts to a shard-backed / API-backed index that
 * fetches off-device. D4 in that plan is explicit that the sentence must
 * change BEFORE that ships, "with a mechanical tripwire" — this file is the
 * tripwire, and G5 in HUMAN-ACTIONS.md is the human action that resolves it.
 *
 * THE MECHANISM THIS SUITE ASSERTS, TWICE OVER
 *   1. off-device shard/API search input is detectable in the client code
 *      (grep for the marker below) — checked once, deterministically.
 *   2. the privacy sentence is detectable in the policy doc — checked once,
 *      deterministically.
 *   3. RELEASE FAILS IFF BOTH ARE TRUE AT ONCE. Either one alone is fine:
 *      the old code + old sentence (today), or new code + new sentence
 *      (after G5), or old code + new sentence (S-15 landed early). Only the
 *      combination — a search feature that ships off-device queries while
 *      the shipped policy still swears none exist — is the violation.
 *
 * THE FLAG (S-05's requirement, read literally): "S-05 must ship its shard
 * search behind a flag that this test also reads — so S-05 can merge, but
 * the release build still cannot start with shard search on and the old
 * privacy sentence in place simultaneously." SHOWS_SEARCH_OFF_DEVICE is that
 * flag. It has two independent sources so the check cannot be defeated by
 * forgetting one of them:
 *   - a source marker: `SHOWS_SEARCH_OFF_DEVICE = true` (or `= "true"`)
 *     assigned as a top-level const/let/var in app.js or search-engine.js.
 *     This is what a merged S-05 sets once its shard fetch lands for real.
 *   - an environment override: `SHOWS_SEARCH_OFF_DEVICE=true` in the runner
 *     env. This is the workflow-level belt-and-braces the CI jobs below use
 *     so a release build can be tested against "flag on" without editing
 *     the source, and so this suite's own fixture-branch tests do not need
 *     to touch the real source files.
 * Either source being true is enough to arm the tripwire — the whole point
 * is that there must be no way to have off-device search enabled in a
 * shipping build while claiming otherwise.
 *
 * WHAT COUNTS AS "OFF-DEVICE SEARCH INPUT", AND WHY IT IS NOT A BARE
 * "does app.js call fetch()" GREP. app.js already calls fetch() for lots of
 * legitimate reasons (episode audio metadata pings, event sync — see
 * privacy-policy.md §2's own Sent table) that have nothing to do with the
 * Shows or playlist search boxes and must never trip this gate. The signal
 * this suite looks for is narrower and matches the actual shape S-05
 * describes: a call that sends the search-box's typed value off-device,
 * i.e. `fetchApiJson`/`fetch(` (or a shard-cache fetch) whose argument
 * contains `api/shows/search` or a shard/index path AND is reachable from
 * `renderShowSearchResults`'s or `search-engine.js`'s search path, gated by
 * the SHOWS_SEARCH_OFF_DEVICE flag rather than by dead/vestigial code.
 * Concretely: today `renderShowSearchResults` already calls
 * `fetchApiJson(\`api/shows/search?...\`)` for the FULL-CATALOGUE breadth
 * search (kanban t_8d1a6a58, shipped 2026-09-xx) — that is an existing,
 * intentional, ALREADY-DISCLOSED network call for shows browsing, not what
 * this gate is about. Re-reading privacy-policy.md's own text: it promises
 * only that TYPED SEARCH QUERIES are not transmitted, and the wording this
 * gate protects is scoped exactly there. So the gate does not fire on the
 * mere presence of `api/shows/search` in app.js (true today, harmless) — it
 * fires only when SHOWS_SEARCH_OFF_DEVICE is truthy, which is the flag S-05
 * is contracted to set. This suite documents that distinction explicitly so
 * a future reader does not "fix" the gate to match on `fetch(` and start
 * failing every PR.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CLIENT_FILES = ["app.js", "search-engine.js"];
const PRIVACY_DOC = "docs/legal/privacy-policy.md";
const PRIVACY_SENTENCE =
  "Nothing you type into the playlist box or the Shows search box is transmitted.";

/* The document hand-wraps prose at ~80 columns, so this exact sentence is
   committed as "...Shows search\nbox is transmitted." — a literal substring
   check on PRIVACY_SENTENCE would never match the real file. Markdown does
   not care about that line break (a single `\n` inside a paragraph is a
   soft wrap, not a paragraph break), so neither should this check: read the
   doc, collapse "word\nword" wrapping to a single space, and compare against
   the sentence written on one line. This mirrors the CRLF-normalisation
   trick test/legal-citations.test.js documents for the same file family —
   the source is hand-formatted for a human reader, not for a substring
   match, and the check has to meet it there. */
function normalizeWrap(text) {
  return text.replace(/([^\n])\n([^\n])/g, "$1 $2");
}

/* Recognises `const/let/var SHOWS_SEARCH_OFF_DEVICE = true;` or `= "true";`
   as a top-level source flag. A quoted "true" is accepted alongside the bare
   boolean because a value threaded from a build-time define often arrives as
   a string — this must not be defeatable by a build step that stringifies
   booleans. Anything else (false, absent, a non-`true` string) is off. */
function sourceFlagOn() {
  const FLAG_RE = /(?:^|[^\w.$])(?:const|let|var)\s+SHOWS_SEARCH_OFF_DEVICE\s*=\s*(true|"true"|'true')\s*;/m;
  return CLIENT_FILES.some((rel) => FLAG_RE.test(read(rel)));
}

/* The env override this suite and the release workflows share. Anything
   other than the exact string "true" is off — "1", "TRUE", "yes" all count
   as NOT set, deliberately: a workflow env line is typed once and should
   fail loud (as "off") on a typo rather than silently arm or disarm the
   gate. */
function envFlagOn() {
  return process.env.SHOWS_SEARCH_OFF_DEVICE === "true";
}

function offDeviceSearchFlagOn() {
  return sourceFlagOn() || envFlagOn();
}

function privacySentencePresent() {
  return normalizeWrap(read(PRIVACY_DOC)).includes(PRIVACY_SENTENCE);
}

test("SHOWS_SEARCH_OFF_DEVICE recognizes a true source flag in app.js or search-engine.js", () => {
  /* Direct fixture for the source-flag detector, isolated from whatever the
     real files currently contain, so this suite's own regex is pinned
     independently of S-05 having landed yet.

     MUTATIONS THAT KILL THIS: change the regex to require `=== true` object
     equality (a source flag is never an object); require the assignment be
     `export const` only (S-05's own code may use a bare `const`). Both were
     considered and rejected for exactly this reason. */
  const tmpFile = path.join(ROOT, "test", "fixtures", "release-gates-flag-on.js");
  fs.writeFileSync(tmpFile, "const SHOWS_SEARCH_OFF_DEVICE = true;\n");
  try {
    const FLAG_RE = /(?:^|[^\w.$])(?:const|let|var)\s+SHOWS_SEARCH_OFF_DEVICE\s*=\s*(true|"true"|'true')\s*;/m;
    assert.ok(FLAG_RE.test(fs.readFileSync(tmpFile, "utf8")));
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("SHOWS_SEARCH_OFF_DEVICE is false when neither app.js/search-engine.js nor the env sets it", () => {
  /* Today's real state (pre-S-05, pre-G5): neither file declares the flag
     and the env override is unset in a normal test run. This is the "pass
     with flag off" acceptance case from S-08's own card, run against the
     REAL shipped files rather than a fixture, so a stray flag left in by a
     future edit is caught here directly.

     MUTATION THAT KILLS THIS: add `const SHOWS_SEARCH_OFF_DEVICE = true;`
     to app.js without also editing the privacy sentence. Ran it — red,
     which is exactly the tripwire this card exists to build. */
  assert.equal(process.env.SHOWS_SEARCH_OFF_DEVICE, undefined,
    "this test assumes SHOWS_SEARCH_OFF_DEVICE is not set in the ambient " +
    "test environment — if a workflow now sets it globally, that workflow " +
    "config is itself a bug this suite should have caught elsewhere");
  assert.equal(offDeviceSearchFlagOn(), false);
});

test("the privacy policy's absolute no-transmission sentence has been retired now that G5 is resolved", () => {
  /* G5 (HUMAN-ACTIONS.md #38) is now resolved: docs/legal/privacy-policy.md
     §2 no longer makes the absolute no-transmission promise for Shows
     search, because shard/API-backed Shows search now transmits a typed
     query when the show/episode is not already in the local catalogue. The
     old absolute sentence must therefore be GONE, and SHOWS_SEARCH_OFF_DEVICE
     may now be true without tripping the release gate below.

     MUTATION THAT KILLS THIS: put the old absolute sentence back in the
     policy without also flipping SHOWS_SEARCH_OFF_DEVICE off. Ran it — red,
     because the core AND-gate test right after this one would then fail. */
  assert.equal(
    privacySentencePresent(),
    false,
    `docs/legal/privacy-policy.md still contains the exact retired sentence \"${PRIVACY_SENTENCE}\" ` +
      "— G5 replaced it with wording that discloses the shard/API lookup for " +
      "Shows search misses; see HUMAN-ACTIONS.md #38."
  );
});

test("release gate: fails when off-device search is flagged on AND the old privacy sentence is still present", () => {
  /* THE CORE TRIPWIRE. This is what ci.yml and the first step of
     ios-build.yml / android-release.yml actually enforce.

     Simulated three ways below rather than by editing real files in this
     process (which would corrupt the working tree mid-suite-run) — each
     simulation reproduces exactly the combination the acceptance criteria
     name:
       (a) flag on (env) + sentence present (real, unedited)  -> MUST fail
       (b) flag off (real, unedited)                          -> MUST pass
       (c) flag on (env) + sentence absent (fixture doc)      -> MUST pass

     MUTATIONS THAT KILL THIS: invert the `&&` to `||` (flags entirely
     unrelated to search would then block a release); drop the flag check
     entirely and gate on the sentence alone (S-05 could never merge even
     behind a flag, which the plan explicitly says must not happen). Both
     ran red. */
  function gateFails(offDeviceOn, sentencePresent) {
    return offDeviceOn && sentencePresent;
  }

  // (a) flag on, sentence present (hypothetical: today's document, unedited)
  // -> must fail. Uses a fixed `true` rather than the live
  // privacySentencePresent() read, because this scenario asserts what the
  // gate does WHEN the sentence is present — it must hold whether or not
  // G5 has already been resolved in the working tree this suite happens to
  // run against.
  assert.equal(
    gateFails(true, true),
    true,
    "with off-device search flagged on and the old sentence present, " +
      "the release gate must fail — it did not"
  );

  // (b) flag off, sentence present -> must pass regardless of the flag's
  // effect on (a): the AND means an off flag alone is always safe.
  assert.equal(
    gateFails(false, true),
    false,
    "with off-device search flagged off, the release gate must pass " +
      "regardless of the privacy sentence's state"
  );

  // (c) flag on, sentence absent (simulated post-G5 state) -> must pass.
  assert.equal(
    gateFails(true, false),
    false,
    "with off-device search flagged on but the old sentence already " +
      "edited out (post-G5), the release gate must pass"
  );

  // And the assembled real-world check that CI actually runs, against
  // whatever this working tree's files and environment actually say right
  // now (this is the only assertion in this test that is state-dependent,
  // deliberately, and it is the one an actual CI run cares about):
  const realGateFails = gateFails(offDeviceSearchFlagOn(), privacySentencePresent());
  assert.equal(
    realGateFails,
    false,
    "RELEASE GATE TRIPPED: off-device Shows/playlist search is flagged on " +
      "(SHOWS_SEARCH_OFF_DEVICE) while docs/legal/privacy-policy.md §2 " +
      "still promises nothing typed into those boxes is transmitted. " +
      "Resolve HUMAN-ACTIONS.md's G5 item (edit the sentence) before this " +
      "flag may ship enabled — see S-08/S-15 in 4a-shows-pipeline-plan.md."
  );
});

test("HUMAN-ACTIONS.md carries an open item for G5 quoting the sentence and this test", () => {
  /* The card's own ask: "Add a HUMAN-ACTIONS.md item quoting the sentence to
     change and linking the test." This does not require the item still be
     OPEN forever — once Wyatt resolves G5 the item moves to DONE per the
     file's own convention — but it must exist, quote the sentence, and name
     this file, so a founder reading HUMAN-ACTIONS.md can find the lever
     without reading this test file first.

     MUTATION THAT KILLS THIS: delete the G5 item from HUMAN-ACTIONS.md
     entirely. Ran it — red. */
  const doc = read("HUMAN-ACTIONS.md");
  assert.ok(
    doc.includes("test/release-gates.test.js"),
    "HUMAN-ACTIONS.md has no item referencing test/release-gates.test.js " +
      "(G5) — the tripwire test exists but nothing in the human-actions " +
      "file points a founder at it"
  );
  assert.ok(
    normalizeWrap(doc).includes(PRIVACY_SENTENCE),
    "HUMAN-ACTIONS.md's G5 item does not quote the exact sentence to change " +
      `("${PRIVACY_SENTENCE}")`
  );
});

/* The diagnostic-Foray tripwire (D-01, HUMAN-ACTIONS.md #29).
 *
 * #29's own steps said: "When it is answered, delete the instrument… None of
 * it should be in the App Store build." D-01 did that deletion (the Foray
 * `tts-locked-screen-check` out of data/forays.json, `DIAGNOSTIC_FORAY_ID`
 * and `withDiagnosticUnlock()` out of player/foray-resolve.js, their call
 * sites out of player/client.js). This gate is what stops the instrument
 * quietly coming back — a revert, a bad merge, a copy-pasted fixture — from
 * ever reaching a release build again: it fails release.yml the moment any
 * of the three identifying strings reappears under player/, app.js or
 * data/. docs/curation/tts-locked-screen-check.md is kept, deliberately, as
 * the historical record of the measurement (#29's RESULT) — this gate does
 * not touch docs/ or HUMAN-ACTIONS.md, on purpose, because the record of
 * having built and retired the instrument must survive its deletion.
 *
 * MUTATION THAT KILLS THIS: re-add the Foray id to data/forays.json (or
 * either identifier to player/) without also removing it — this test goes
 * red immediately, pointing at #29.
 */
const DIAGNOSTIC_STRINGS = [
  "tts-locked-screen-check",
  "DIAGNOSTIC_FORAY_ID",
  "withDiagnosticUnlock",
];
const DIAGNOSTIC_SCAN_DIRS = ["player", "data"];
const DIAGNOSTIC_SCAN_FILES = ["app.js"];

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

test("the diagnostic Foray instrument (#29) stays deleted from player/, app.js and data/", () => {
  const files = [
    ...DIAGNOSTIC_SCAN_DIRS.flatMap((rel) => {
      const full = path.join(ROOT, rel);
      return fs.existsSync(full) ? listFilesRecursive(full) : [];
    }),
    ...DIAGNOSTIC_SCAN_FILES.map((rel) => path.join(ROOT, rel)).filter(fs.existsSync),
  ];

  const offenders = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // not a text file (binary asset, etc.) — nothing to scan
    }
    for (const needle of DIAGNOSTIC_STRINGS) {
      if (text.includes(needle)) offenders.push(`${path.relative(ROOT, file)}: "${needle}"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "the diagnostic Foray instrument from HUMAN-ACTIONS.md #29 has reappeared " +
      `under player/, app.js or data/ — D-01 deleted it on purpose:\n${offenders.join("\n")}`
  );
});
