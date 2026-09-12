/* K-02's phonemize stage, driven through the real interpreter.
 *
 * `docs/bundled-voice-plan.md` K-02. The stage is Python because misaki is
 * Python (the card says so), and this repo's suites are Node — so the honest
 * options were "test the Python by running it" or "test nothing". This runs it.
 *
 * WHAT IS ACTUALLY EXERCISED HERE, and what is not. misaki is NOT installed on
 * this machine (or on CI), so nothing below produces a phoneme string. What
 * below does exercise, against the real file:
 *
 *   - the lexicon loader, against the real 83-term lexicon;
 *   - the term-matching rule, which is the half that decides whether an
 *     override is applied at all, including the `ch'arki` apostrophe case that
 *     `narrator-voice.md`'s Appendix says a plain \b regex gets wrong;
 *   - the substitution PLAN — which overrides apply, in which order, with
 *     overlaps resolved — which is the half that decides whether the lexicon
 *     survives the trip to the phone;
 *   - the duration estimate;
 *   - the refusal: with no backend installed, every mode that would emit
 *     phonemes exits non-zero and says which command fixes it.
 *
 * THE REFUSAL IS THE MOST IMPORTANT TEST IN THIS FILE. A phonemizer that fell
 * back to "something else that produces IPA" would emit a string that does not
 * match the vocabulary the app was built against; the player's version check
 * would then reject every item, after the Foray had been published. Refusing
 * costs a build. Guessing costs a release.
 *
 * Every test names the mutation that turns it red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(HERE, "phonemize.py");

/** `python3` on CI and macOS, `python` on Windows. Tried in that order and the
    first one that answers `--version` wins. A suite that silently skipped when
    neither existed would be a suite that reads as coverage and is not — so the
    absence of any interpreter is a loud failure, not a skip. */
const PYTHON = (() => {
  for (const exe of ["python3", "python", "py"]) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return exe;
  }
  return null;
})();

/** A JS value as a Python expression. JSON is NOT valid Python — `null`, `true`
    and `false` are all NameErrors — so every value crosses the boundary through
    `json.loads`, which is the one encoding both languages agree on. */
const lit = (v) => `json.loads(${JSON.stringify(JSON.stringify(v))})`;

/** Run a snippet with the module importable, and parse its single JSON line. */
function pyJson(snippet) {
  const code = `import json,sys;sys.path.insert(0, ${JSON.stringify(HERE)});import phonemize as P\n${snippet}`;
  const r = spawnSync(PYTHON, ["-c", code], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `python failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("a Python interpreter is available — this suite does not silently skip", () => {
  assert.ok(PYTHON, "no python3/python/py on PATH; K-02's stage cannot be exercised at all");
});

/* ---------- the lexicon ---------- */

test("the stage reads the same lexicon the plugin and the checker read", () => {
  /* One lexicon, three consumers: `foray-tts.js` applies it on the system-voice
     path, `check-forays.mjs` enforces it on the kokoro path, and this stage
     produces it. A second copy would be three rules that agree until they do not.
     MUTATION: point LEXICON_PATH at a copy of the file. */
  const out = pyJson("print(json.dumps({'n': len(P.load_lexicon()), 'path': str(P.LEXICON_PATH)}))");
  assert.equal(out.n, 83, "the committed lexicon has 83 terms");
  assert.ok(out.path.replace(/\\/g, "/").endsWith("mobile/plugins/foray-tts/lexicon/hard-terms.json"));
});

test("an unreadable lexicon degrades to 'no overrides', not to a crash", () => {
  /* The same degradation `check-forays.mjs`'s loader documents: 83 null IPAs
     already enforce nothing, so the failure mode is today's behaviour rather
     than a new one.
     MUTATION: let the read raise. */
  const out = pyJson("from pathlib import Path;print(json.dumps(P.load_lexicon(Path('no/such/file.json'))))");
  assert.deepEqual(out, []);
});

/* ---------- the matching rule ---------- */

test("terms match on word boundaries, case-insensitively, with apostrophes interior", () => {
  /* `narrator-voice.md`'s Appendix says explicitly that a plain \b regex breaks
     on `ch'arki` and has to special-case it. `foray-tts.js`'s `findMatches`
     solves it with lookarounds; this is the same solution, and this test is
     what keeps the two in step.
     MUTATION: use `\b` — the `ch'arki` cases invert. */
  const cases = [
    ["A glass of sake.", "sake", true],
    ["A glass of SAKE.", "sake", true],
    ["for goodness' sakes", "sake", false],
    ["the namesake district", "sake", false],
    ["dried ch'arki, salted", "ch'arki", true],
    ["charki without the mark", "ch'arki", false],
    ["ch'arkis plural", "ch'arki", false],
  ];
  const snippet = `print(json.dumps([bool(P.term_pattern(t).search(s)) for s,t,_ in ${lit(cases)}]))`;
  assert.deepEqual(pyJson(snippet), cases.map((c) => c[2]));
});

/* ---------- the substitution plan ---------- */

test("only terms with an AUTHORED ipa are planned", () => {
  /* The lexicon's own honesty note: 82 of 83 `ipa` fields are null because
     nobody has authored or verified them. A term with no override has nothing
     to substitute, and inventing one here would put an unverified claim into
     the one artefact whose job is to be exact.
     MUTATION: drop the `if not ipa: continue` guard — `koji` is planned with
     an ipa of None and the substitution emits "None" into the phoneme string. */
  const lex = [{ term: "sake", ipa: "ˈsɑːkeɪ" }, { term: "koji", ipa: null }];
  const out = pyJson(`print(json.dumps(P.plan_overrides("The sake and the koji.", ${lit(lex)})))`);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "sake");
});

test("the plan is in source order, so the substitution can walk the string once", () => {
  /* MUTATION: drop the sort — the walk in `phonemize_script` then slices
     backwards and silently drops text between overrides. */
  const lex = [{ term: "braai", ipa: "braɪ" }, { term: "asado", ipa: "aˈsaðo" }];
  const out = pyJson(`print(json.dumps(P.plan_overrides("First an asado, later a braai.", ${lit(lex)})))`);
  assert.deepEqual(out.map((h) => h.term), ["asado", "braai"]);
  assert.ok(out[0].start < out[1].start);
});

test("overlapping terms resolve longest-first at a position, never both", () => {
  /* Two overrides covering the same characters would substitute twice and
     produce a phoneme string with the word in it twice.
     MUTATION: drop the `cursor` check — both hits are kept. */
  const lex = [{ term: "binchō", ipa: "biɲtɕoː" }, { term: "binchōtan", ipa: "biɲtɕoːtaɰ̃" }];
  const out = pyJson(`print(json.dumps(P.plan_overrides("Japanese binchōtan charcoal.", ${lit(lex)})))`);
  assert.equal(out.length, 1);
  assert.equal(out[0].term, "binchōtan", "the longer match wins");
});

test("the plan is deterministic across runs — the card's own acceptance", () => {
  /* "Running the stage twice on the same script is byte-identical." A dict
     iteration order, a set, or a hash seed leaking into the output would break
     it, and the failure would be a Foray that re-publishes with different
     phonemes for no reason.
     MUTATION: build the plan from a `set` instead of a sorted list. */
  const lex = [
    { term: "sake", ipa: "ˈsɑːkeɪ" }, { term: "braai", ipa: "braɪ" },
    { term: "asado", ipa: "aˈsaðo" }, { term: "barbacoa", ipa: "barbaˈkoa" },
  ];
  const script = "An asado, a braai, a barbacoa, and sake to finish.";
  const once = pyJson(`print(json.dumps(P.plan_overrides(${JSON.stringify(script)}, ${lit(lex)})))`);
  const twice = pyJson(`print(json.dumps(P.plan_overrides(${JSON.stringify(script)}, ${lit(lex)})))`);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.map((h) => h.term), ["asado", "braai", "barbacoa", "sake"]);
});

/* ---------- the estimate ---------- */

test("est_sec is narration-craft's 17 characters per second, and nothing else", () => {
  /* `est_sec` feeds the seam and the generation-lead maths until K-04 records
     a real rendered length. A second rate here would put the pipeline and
     `player/foray-queue.js`'s `narrationDuration` on different clocks.
     MUTATION: change CHARS_PER_SEC to 20 — the assertion and the player
     disagree by 15% on every narration item. */
  const out = pyJson("print(json.dumps({'rate': P.CHARS_PER_SEC, 'sec': P.estimate_seconds('x'*170)}))");
  assert.equal(out.rate, 17);
  assert.equal(out.sec, 10);
  const queue = fs.readFileSync(path.join(ROOT, "player/foray-queue.js"), "utf8");
  assert.match(queue, /NARRATION_CHARS_PER_SEC\s*=\s*17/, "the player must use the same rate");
});

/* ---------- the refusal ---------- */

test("with no backend installed, --check reports what is missing and exits non-zero", () => {
  /* THE HONEST-FAILURE TEST. misaki is not installed here or on CI. A stage
     that reported success anyway, or that fell back to another front-end,
     would emit a phoneme string that does not match the app's vocabulary — and
     the player would reject every item AFTER publication.
     MUTATION: return 0 from `cmd_check` when the backend is missing.

     WHEN MISAKI IS INSTALLED this test must be updated, not deleted: the run
     then succeeds, and the assertion becomes "the vocab sha is reported". */
  const r = spawnSync(PYTHON, [SCRIPT, "--check"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 1, "a missing backend is a failure, not a warning");
  assert.match(r.stdout, /lexicon: 83 terms, 1 with an authored IPA/);
  assert.match(r.stdout, /backend: NOT AVAILABLE/);
  assert.match(r.stdout, /pip install -r tools\/narration\/requirements\.txt/,
    "the failure must carry the one command that fixes it");
});

test("--text refuses rather than emitting phonemes nobody produced", () => {
  /* MUTATION: catch `MissingBackend` and emit the script's own characters as
     'phonemes' — the output looks right, validates, publishes, and every
     listener hears the letters. */
  const r = spawnSync(PYTHON, [SCRIPT, "--text", "The sake was poured."], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /misaki is not installed/);
  assert.equal(r.stdout.trim(), "", "nothing is written to stdout on the refusal path");
});

test("the requirements are pinned exactly — an unpinned upgrade invalidates published data", () => {
  /* `tts.vocab` is derived from the installed backend, so a floating version
     silently changes the phoneme vocabulary every published Foray was written
     against (deck §5 item 8).
     MUTATION: change a `==` to `>=`. */
  const req = fs.readFileSync(path.join(HERE, "requirements.txt"), "utf8");
  const lines = req.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(lines.length >= 3, "the stage has real dependencies");
  for (const line of lines) {
    assert.match(line, /==\d+\.\d+/, `"${line}" is not pinned to an exact version`);
  }
  assert.ok(lines.some((l) => l.startsWith("misaki")), "misaki is the front end the card names");
});

test("nothing in the stage's dependencies is GPL — espeak is a SYSTEM package, not a wheel", () => {
  /* The licence line this whole deck is built around (§4). espeak-ng is GPL-3
     and is deliberately NOT a pip dependency: it is installed on the build
     machine, used here, and never packaged with anything that ships.
     MUTATION: add `espeakng-loader` or `phonemizer` to requirements.txt — the
     GPL then travels with our Python package, which is a different
     conversation from "it is installed on a server". */
  const req = fs.readFileSync(path.join(HERE, "requirements.txt"), "utf8");
  const lines = req.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    assert.ok(!/espeak|phonemizer|piper/i.test(line), `"${line}" would package a GPL front end`);
  }
});
