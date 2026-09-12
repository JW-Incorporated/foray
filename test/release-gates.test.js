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
  /* CRLF first, and this was a real (Windows-only) red rather than a
     precaution: this repo commits LF and is developed with
     `core.autocrlf=true`, so on a developer checkout every soft wrap is
     "word\r\nword" and the collapse below leaves the `\r` sitting inside the
     sentence — a substring check for the ABSENCE of a sentence passes
     vacuously, and one for its PRESENCE fails on a file that says exactly
     what it should. test/legal-citations.test.js documents the same trick for
     the same file family; matched to it rather than re-derived. */
  return text.replace(/\r\n/g, "\n").replace(/([^\n])\n([^\n])/g, "$1 $2");
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

test("SHOWS_SEARCH_OFF_DEVICE is set true in the shipped source, because off-device Shows search is what ships (S-07/G1)", () => {
  /* THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the record of
     a ruling rather than a weakening. It read "SHOWS_SEARCH_OFF_DEVICE is
     false when neither app.js/search-engine.js nor the env sets it", which
     was true while the flag was a promise about a feature nobody had built.

     G1 (docs/search-plan.md §3, ruled by Wyatt 2026-09-11, recorded in
     docs/DECISIONS.md) chose OPTION B: the typed Shows-search query leaves
     the device unconditionally and the policy sentence changes to match. So
     app.js now declares the flag, and the honest state of this repo is
     "flag on, old sentence gone" — the (c) branch of the core gate below,
     which until now was only ever simulated.

     Asserting the flag is ON is not weaker than asserting it was off: the
     AND-gate is what protects the release, and arming one half of it for
     real is what makes the other half load-bearing. The thing that must
     never happen — flag on AND the old sentence present — is asserted
     against the live tree in the gate test below.

     MUTATION THAT KILLS THIS: delete `const SHOWS_SEARCH_OFF_DEVICE = true;`
     from app.js while `renderShowSearchResults`/`runShowSearchCostly` still
     call `api/shows/search`. Ran it — red, and rightly: the code would then
     be transmitting typed queries with the tripwire disarmed. */
  assert.equal(process.env.SHOWS_SEARCH_OFF_DEVICE, undefined,
    "this test assumes SHOWS_SEARCH_OFF_DEVICE is not set in the ambient " +
    "test environment — it must be the SOURCE flag being read here, not an " +
    "inherited env var, or this asserts nothing about the shipped files");
  assert.equal(sourceFlagOn(), true,
    "app.js (or search-engine.js) must declare `const SHOWS_SEARCH_OFF_DEVICE = true;` " +
    "while the Shows search transmits typed queries — see docs/DECISIONS.md 2026-09-11");
  assert.equal(offDeviceSearchFlagOn(), true);
});

test("S-07/G1 Option B: the policy states the lookup is unconditional, in the words the code makes true", () => {
  /* The OTHER half of S-07's contract, and the one the old absolute-sentence
     check cannot cover. Removing a false promise is not the same as making a
     true statement: a policy that simply deleted the sentence would pass the
     retirement check above while telling the reader nothing about what now
     happens to what they type.

     Two things are pinned, both against the real committed policy:
       1. the RETIRED CONDITIONAL — "if a show or episode is already in that
          local catalogue nothing you typed leaves your device" — is gone.
          This is #560 item 2 and requirements §6.11/§6.13 row 6: it was
          false as shipped (`renderShowSearchResults` fired both endpoints
          unconditionally, with no local-hit branch anywhere), and Option B
          resolves it by changing the sentence rather than the code.
       2. the REPLACEMENT is affirmative and unconditional.

     MUTATIONS THAT KILL THIS, both run:
       (a) restore the old conditional sentence to §2 — red on the first
           assertion, and the core gate below then also goes red because the
           source flag is now genuinely on.
       (b) soften the replacement back to "unless it is already on your
           device" — red on the second assertion, because the phrase that
           makes the disclosure unconditional is gone.

     WHY A PHRASE AND NOT A WHOLE PARAGRAPH: the doc is hand-wrapped prose
     that a lawyer is expected to edit (docs/legal/data-safety.md flags this
     sentence class as "worth a lawyer's eye"). Pinning the paragraph would
     make every copy-edit a red build. Pinning the CLAIM lets the wording
     move and the meaning not. */
  const policy = normalizeWrap(read(PRIVACY_DOC));
  assert.equal(
    policy.includes("nothing you typed leaves your device"),
    false,
    "docs/legal/privacy-policy.md §2 still carries the conditional promise G1 retired " +
      "(Option B, docs/DECISIONS.md 2026-09-11) — the code has no local-hit branch and " +
      "never had one, so this sentence is false as shipped."
  );
  assert.ok(
    policy.includes("It does this whether or not the show was already on your device."),
    "docs/legal/privacy-policy.md §2 must say plainly that the Shows-search lookup happens " +
      "whether or not the show is already on the device — deleting the old promise without " +
      "replacing it leaves the reader with no statement at all."
  );
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

test("G5 (#38) is recorded closed in the ledger, tied to the real sentence this test protects", () => {
  /* The card's original ask: "Add a HUMAN-ACTIONS.md item quoting the
     sentence to change and linking the test." Under format v2
     (2026-09-11), closing an item MOVES it out of HUMAN-ACTIONS.md entirely
     into the sibling machine ledger, HUMAN-ACTIONS-DONE.md — "Closed items
     are in HUMAN-ACTIONS-DONE.md — you never need it" (the live file's own
     header). So the founder-discoverability half of the old assertion no
     longer applies once G5 is resolved: there is nothing left for a founder
     to act on, and the live file the founder actually reads carries no
     trace of #38 by design.

     What must still hold, because it is the part of the original intent
     that outlives the close: the ledger's one-line record of #38 is
     genuinely the G5 item (not a same-numbered coincidence), says it was
     closed `done`, and still quotes enough of the real retired sentence to
     prove the closure is tied to the actual legal text this suite guards —
     not just a number and a label. The ledger line is machine-generated and
     length-capped (by `ha.py`, not this repo), so this checks a generous
     prefix of the sentence rather than the full 78 characters — long enough
     that nothing except this exact sentence could match, short enough to
     survive the ledger's own truncation.

     MUTATIONS THAT KILL THIS: delete the #38 line from HUMAN-ACTIONS-DONE.md
     entirely; change its status from `done` to anything else; replace the
     quoted fragment with unrelated text. All three ran red. */
  const ledger = read("HUMAN-ACTIONS-DONE.md");
  const sentencePrefix = PRIVACY_SENTENCE.slice(0, -15); // drop the trailing
  // "transmitted." verb+period — comfortably shorter than what the ledger's
  // own truncation kept when this was generated.

  const line = ledger
    .split("\n")
    .find((l) => /^-\s+#38\s+·/.test(l));

  assert.ok(
    line,
    "HUMAN-ACTIONS-DONE.md has no `- #38 · ...` ledger line — G5's closed " +
      "record is gone; see HUMAN-ACTIONS-DONE.md and this suite's header."
  );
  assert.match(
    line,
    /·\s+done\s+·/,
    `HUMAN-ACTIONS-DONE.md's #38 line is not recorded "done": "${line}"`
  );
  assert.ok(
    /G5/.test(line),
    `HUMAN-ACTIONS-DONE.md's #38 line does not mention "G5": "${line}"`
  );
  assert.ok(
    normalizeWrap(line).includes(sentencePrefix),
    "HUMAN-ACTIONS-DONE.md's #38 line does not quote the retired privacy " +
      `sentence ("${sentencePrefix}..."): "${line}"`
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
      continue; // unreadable (permissions, race with deletion) — nothing to scan
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

/* ======================================================================
   K-06: the bundled voice's licence, size and provenance gates
   (docs/bundled-voice-plan.md K-06)

   THREE PROMISES, ONE PLACE. This suite already exists to hold a release to
   what the shipped documents claim, which is exactly the shape of all three:

     (1) THE GPL STAYS ON THE SERVER. Kokoro's weights are Apache-2.0, but
         every Kokoro runtime in the wild reaches `espeak-ng` (GPL-3) for its
         text front-end. The whole architecture of this deck — phonemes are
         computed server-side and the phone receives ids — exists to keep that
         dependency out of the app binary (deck §4). A gate is what makes that
         an enforced property rather than an intention.
     (2) THE MODEL IS FETCHED, NEVER COMMITTED, AND ALWAYS VERIFIED.
     (3) THE APP HAS A SIZE CEILING WITH A STATED REASON, and a written
         trigger for moving to on-demand resources.

   WHAT THESE CANNOT DO FROM HERE, said plainly: (1) is asserted over the
   SOURCE TREE, not over a built `.ipa`/`.aab` — no Apple or Android toolchain
   exists on the machine this was written on, so the `strings`-the-binary half
   of K-06's ask is named in the deck's remaining work rather than pretended at
   here. A source gate is strictly weaker and strictly better than nothing: the
   only way `espeak` reaches the binary is by first appearing in a manifest, a
   Gradle file or a Package.swift in this tree.

   THE PINS ARE LOADED WITH `await import(...)`, because this suite is
   CommonJS (`__dirname` above) and `tools/mobile/fetch-models.mjs` is an ES
   module. A dynamic import inside an async test is the one bridge that works
   in both directions on every Node this repo supports.
   ====================================================================== */

const loadModelPins = () => import("../tools/mobile/fetch-models.mjs");

/** Everything a native build reads to decide what to link. A file walk of the
    whole repo would hit this suite's own prose and the deck that explains the
    rule, which is why the gate reads BUILD INPUTS rather than grepping the
    tree for a word. */
const NATIVE_BUILD_INPUTS = [
  "mobile/plugins/foray-tts/Package.swift",
  "mobile/plugins/foray-tts/package.json",
  "mobile/plugins/foray-tts/android/build.gradle",
  "mobile/plugins/foray-audio/android/build.gradle",
  "package.json",
];

test("K-06: no espeak dependency reaches any native build input", () => {
  /* THE LICENCE GATE. `espeak-ng` is GPL-3 and would infect an App Store
     binary; `generation-architecture.md` §1.2.1 already ruled it server-only,
     and this deck's phoneme design is what makes that possible on-device too.
     MUTATION: add `piper-phonemize` or `espeak-ng` to Package.swift's
     dependencies, or to the plugin's build.gradle — this goes red. */
  const offenders = [];
  for (const rel of NATIVE_BUILD_INPUTS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8").toLowerCase();
    for (const needle of ["espeak", "piper-phonemize", "phonemizer"]) {
      if (text.includes(needle)) offenders.push(`${rel}: "${needle}"`);
    }
  }
  assert.deepEqual(offenders, [],
    "a GPL text front-end reached a native build input — phonemes are computed on the server "
    + "(docs/bundled-voice-plan.md §4), and the app must never link espeak:\n" + offenders.join("\n"));
});

test("K-06: the model pin table is well-formed, and is honestly unfilled", async () => {
  /* CI's half of "fails on a mismatch": the download itself happens in a build
     step that does not exist yet (`.github/` needs founder-approved, deck H3),
     but the table it will read is checked on every run today. The failure this
     catches is somebody editing a URL and not the hash.
     MUTATION: half-pin an entry (bytes, no sha256) — `pinProblems` names it. */
  const { PINS, pinProblems, unfilled } = await loadModelPins();
  assert.deepEqual(pinProblems(), []);
  assert.ok(PINS.length >= 13, "one model and the twelve audition voices");
  /* Stated rather than assumed: nobody in this repo has downloaded these
     files. When that changes, this assertion is the one that has to change
     too, in a diff that says who did it. */
  assert.equal(unfilled().length, PINS.length,
    "if a pin has been filled, update this assertion and say in the PR who hashed the file");
});

test("K-06: every pinned artefact records a permissive licence and an https source", async () => {
  /* The THIRD_PARTY_NOTICES entry is written FROM this table (K-06(4)), so a
     pin with no licence is a notice that cannot be written. The deck's §11
     non-goals also forbid "any voice whose licence is not Apache/MIT", and
     this is where that becomes a check rather than a sentence.
     MUTATION: change a pin's licence to OpenRAIL-M (Supertonic's) — red. */
  const { PINS } = await loadModelPins();
  for (const p of PINS) {
    assert.match(p.licence, /^(Apache-2\.0|MIT)$/, `${p.name}: non-permissive or unrecorded licence`);
    assert.match(p.source, /^https:\/\//, `${p.name}: no source for the licence claim`);
  }
});

test("K-06: the notices file carries Kokoro, ORT and the voice data", () => {
  /* MUTATION: delete any of the three entries. An app that bundles Apache-2.0
     weights without reproducing the notice is out of compliance with the one
     term Apache-2.0 actually imposes. */
  const notices = read("docs/legal/third-party-notices.md");
  for (const want of ["Kokoro-82M", "ONNX Runtime", "Apache-2.0", "MIT"]) {
    assert.ok(notices.includes(want), `third-party-notices.md is missing ${want}`);
  }
});

/* K-06(3): the ceiling, and the arithmetic behind it, in one place so the
   number and its reason cannot drift apart.

   150 MB, from the deck: Apple's App Store cellular-download cap is 200 MB, so
   an app that crosses it stops installing away from wi-fi — which, for an app
   used while driving, is a large share of its installs. Today's measured sizes
   plus the model are the budget:

     Android release .aab   5.46 MB   (deck §2, measured)
     iOS App.app            8.3 MB    (deck §2, measured, simulator)
     Kokoro q8f16 weights  ~86 MB     (model card, Documented)
     ONNX Runtime mobile   ~10-20 MB  (Inferred — K-04 measures)
     three voice files     ~1.5 MB
                           --------
     worst case            ~116 MB, leaving ~34 MB of headroom.

   THE TRIGGER for moving to on-demand resources / Play Asset Delivery: the
   ceiling being reached, or a second language (a second model and a second
   audition). Written here, not left to be argued in the PR that hits it. */
const APP_SIZE_CEILING_MB = 150;
const APPLE_CELLULAR_CAP_MB = 200;

test("K-06: the app-size ceiling is below Apple's cellular cap, with the reason stated", () => {
  /* MUTATION: raise the ceiling above 200 — the app stops installing over
     cellular and nothing else in the repo notices. This is the test that makes
     raising it a deliberate, argued act. */
  assert.ok(APP_SIZE_CEILING_MB < APPLE_CELLULAR_CAP_MB,
    "a ceiling at or above the cellular cap is not a ceiling");
  const deck = read("docs/bundled-voice-plan.md");
  assert.ok(deck.includes("150 MB"), "the deck and this gate must name the same ceiling");
  assert.ok(deck.includes("200 MB"), "the deck must state the cellular cap the ceiling is derived from");
});

test("K-06: the measured app sizes plus the model still fit under the ceiling", () => {
  /* The arithmetic, executable. If a future measurement changes one of these
     numbers, this test is where the budget is re-argued rather than in a PR
     description nobody re-reads.
     MUTATION: change the model size to fp32's 326 MB — the sum exceeds the
     ceiling and the answer becomes "fetch it on first run", which is exactly
     the finding this test exists to surface rather than hide. */
  const androidAabMb = 5.46;
  const iosAppMb = 8.3;
  const modelMb = 86;
  const ortMb = 20;      // the top of the inferred range, deliberately
  const voicesMb = 1.5;
  const worst = Math.max(androidAabMb, iosAppMb) + modelMb + ortMb + voicesMb;
  assert.ok(worst < APP_SIZE_CEILING_MB,
    `the bundled voice would make the app ${worst.toFixed(1)} MB, over the ${APP_SIZE_CEILING_MB} MB ceiling — `
    + "the model must then be fetched on first run rather than bundled");
  assert.ok(worst > 100,
    "if this dropped below 100 MB a measurement changed and the whole budget should be re-read");
});

test("K-06: the web bundle's own model gate is wired into prepare-webdir", async () => {
  /* Two different gates for two different failures, and this pins that the
     second one is actually CALLED: `MAX_BYTES` catches "something enormous got
     in" with the wrong diagnosis, `assertNoModelWeights` catches "a model got
     in" — including the SMALL case (a 130 KB voice file) that fits under 3 MB
     and would otherwise ship silently to the website as well as the shell.
     MUTATION: delete the `assertNoModelWeights(files)` call from `prepare`. */
  const src = read("tools/mobile/prepare-webdir.mjs");
  assert.match(src, /^\s*assertNoModelWeights\(files\);$/m,
    "prepare() must call the model gate, not merely export it");
});
