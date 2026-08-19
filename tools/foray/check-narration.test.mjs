/* Tests for the narration gate. Run: node --test tools/foray/
 *
 * THE FIXTURE IS THE REAL COMMITTED DATA, ON PURPOSE — AND THAT IS A TRADE.
 * `CLAUDE.md` § "A green test is not evidence until you have broken it" names five
 * suites that shipped green while pinning nothing, and every one failed the same
 * way: the fixture was more forgiving than the thing it stood for. A hand-built
 * narration fixture would be exactly that — a beat whose sentence means, mode
 * bands, establishes/assumes graph and span set were all authored to make the
 * check under test reachable, which is the one condition in which every check
 * passes. So `base()` loads `docs/curation/narration/alcohol-forms-1`,
 * deep-clones it, and each test mutates one field.
 *
 * The cost is real and it is the opposite of the one `check-forays.test.mjs`
 * documents: that suite moved its proofs OFF live data under #236, because
 * pinning live curation made tests break whenever curation changed. This suite
 * accepts that breakage deliberately, for one reason — a narration gate whose
 * fixture is synthetic proves nothing about the narration in the repo, and the
 * narration in the repo is the whole deliverable. Two mitigations keep the cost
 * down: mutations locate sentences by PREDICATE rather than by index (an earlier
 * draft hard-coded `sentences[10]` and broke on the first script edit), and the
 * few asserted literals are chosen to be stable.
 *
 * Every test names the one-line mutation to check-narration.mjs that makes it
 * pass falsely, and every one was run against that mutation before this landed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkForay,
  checkNarration,
  loadForay,
  beatScript,
  renderReferences,
  spokenLineErrors,
  inferredTier,
  numberTokens,
  scriptSeconds,
  NARRATION_CHARS_PER_SEC,
} from "./check-narration.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORAY_ID = "alcohol-forms-1";
const FORAY_DIR = path.join(REPO_ROOT, "docs", "curation", "narration", FORAY_ID);
const BEATS_DIR = path.join(FORAY_DIR, "beats");

const base = () => structuredClone(loadForay(REPO_ROOT, FORAY_ID));
const beat = (f, id) => f.beats.find((b) => b.beat_id === id);
const claim = (f, bid, cid) => beat(f, bid).claims.find((c) => c.claim_id === cid);

/** Locate a sentence by what it is rather than by where it is, so a script edit
 *  does not silently relocate the mutation onto a different rule. */
const sentence = (f, bid, pred) => {
  const s = beat(f, bid).sentences.find(pred);
  assert.ok(s, `no matching sentence in ${bid}`);
  return s;
};
const firstClaimSentence = (f, bid) => sentence(f, bid, (s) => s.licence === "claim");

const failsWith = (f, re, why) => {
  const errs = checkForay(f).errors;
  assert.match(errs.join("\n"), re, `${why}\n--- errors were ---\n${errs.join("\n") || "(none)"}`);
};
const clean = (f, why) => {
  const errs = checkForay(f).errors;
  assert.deepEqual(errs, [], `${why}\n${errs.join("\n")}`);
};

test("the committed narration artifacts pass the gate", () => {
  const { errors } = checkNarration(REPO_ROOT);
  assert.deepEqual(errors, [], errors.join("\n"));
});

/* ------------------------------------------------------------------ sourcing */

/* Mutation: replace `for (const tok of numberTokens(c.text))` with
   `for (const tok of [])`. An invented figure then ships. */
test("a number in a claim that appears in none of its fetched spans is a violation", () => {
  const f = base();
  const c = claim(f, "beat-08", "C8.5");
  c.text = c.text.replace("18–20% ABV", "28–30% ABV");
  failsWith(f, /the number "28" is in the claim and in none of its fetched spans/, "invented ABV slipped through");
});

/* Mutation: make inferredTier() return "1" unconditionally. Any quantitative
   claim can then be declared tier 1 and skip the numeric diff entirely. */
test("a claim whose text carries a digit cannot declare tier 1", () => {
  const f = base();
  claim(f, "beat-07", "C7.5").tier = "1";
  failsWith(f, /C7\.5: text is quantitative or superlative, so tier 2 is the floor/, "tier floor not enforced");
});

test("the tier floor also fires on a superlative with no digits in it", () => {
  const f = base();
  claim(f, "beat-06", "C6.1").text = "Starch is the world's most abundant storage carbohydrate.";
  failsWith(f, /C6\.1: text is quantitative or superlative/, "superlative escaped the floor");
});

/* Mutation: delete the `if (c?.tier === "2" || floor === "2")` branch in the
   inference block. Reasoning to a number then looks like sourcing one. */
test("a tier 2 claim may not rest on inference", () => {
  const f = base();
  const c = claim(f, "beat-07", "C7.5");
  c.support = "inference";
  c.inferred_from = ["C7.1", "C7.2"];
  c.reasoning = "A deliberately long enough string to clear the reasoning length floor in the checker.";
  delete c.sources;
  failsWith(f, /C7\.5: a tier 2 claim may not rest on inference/, "an inferred number was accepted");
});

/* Mutation: change `c.inferred_from.length < 2` to `< 1`. */
test("an inference needs at least two claims behind it and written reasoning", () => {
  const f = base();
  claim(f, "beat-06", "C6.3").inferred_from = ["C6.1"];
  failsWith(f, /C6\.3: an inference needs at least two claims/, "one-legged inference accepted");

  const g = base();
  claim(g, "beat-06", "C6.3").reasoning = "because";
  failsWith(g, /C6\.3: an inference needs written reasoning/, "unreasoned inference accepted");
});

/* Mutation: delete the `known.has(src)` loop. An inference can then cite claim
   ids that do not exist, and renderReferences prints them as if they did. */
test("an inference may not draw on a claim that does not exist", () => {
  const f = base();
  claim(f, "beat-06", "C6.3").inferred_from = ["C6.1", "C6.404"];
  failsWith(f, /C6\.3: inferred_from names unknown claim C6\.404/, "an unfalsifiable derivation accepted");
});

/* Mutation: delete the `cited` computation in the blocked branch. A claim the
   pipeline refused to source can then be spoken anyway. */
test("a blocked claim may not be cited by a spoken sentence", () => {
  const f = base();
  beat(f, "beat-09").sentences.push({
    text: "Industrial producers simply buy the enzyme instead of growing it.",
    licence: "claim",
    claims: ["C9.6"],
  });
  failsWith(f, /C9\.6: blocked but cited by a spoken sentence/, "a blocked claim reached the script");
});

test("a blocked claim must carry spoken:false and a real block_reason", () => {
  const f = base();
  claim(f, "beat-08", "C8.7").spoken = true;
  failsWith(f, /C8\.7: a blocked claim must carry spoken: false/, "blocked-but-spoken accepted");

  const g = base();
  claim(g, "beat-08", "C8.7").block_reason = "no source";
  failsWith(g, /C8\.7: a blocked claim needs a block_reason/, "a three-word excuse accepted");
});

/* Mutation: lower MIN_QUOTE_CHARS to 1. A one-word "span" carries no context and
   cannot be diffed against a claim. */
test("a span shorter than the floor is not a span", () => {
  const f = base();
  claim(f, "beat-06", "C6.8").sources[0].quote = "Honey is sweet.";
  failsWith(f, /quote is 15 chars; a span under 40 is not a span/, "a fragment accepted as evidence");
});

test("a source missing its publication, pinned revision or retrieval date is rejected", () => {
  const f = base();
  delete claim(f, "beat-06", "C6.1").sources[0].pinned_url;
  failsWith(f, /missing pinned_url/, "an unpinnable tertiary source accepted");

  const g = base();
  claim(g, "beat-06", "C6.1").sources[0].retrieved = "2026";
  failsWith(g, /retrieved must be an ISO date/, "a vague retrieval date accepted");

  const h = base();
  delete claim(h, "beat-06", "C6.1").sources[0].publication;
  failsWith(h, /missing publication/, "an unattributed span accepted");
});

/* Mutation: delete the `!s.pinned_url.includes(s.revision)` check. `revision`
   can then say one thing while the permalink fetches another, and "pinned" is
   decoration. */
test("pinned_url and revision must agree", () => {
  const f = base();
  claim(f, "beat-06", "C6.1").sources[0].revision = "9999999";
  failsWith(f, /pinned_url does not contain revision "9999999"/, "revision drifted from the permalink");
});

/* Mutation: replace the duplicate-id error with `continue`. A Map keeps the last
   entry silently, so a sentence would resolve to evidence its author never wrote. */
test("a duplicated claim_id inside one beat is rejected", () => {
  const f = base();
  const b = beat(f, "beat-06");
  b.claims.push({ ...structuredClone(b.claims[0]), text: "Something else entirely, at length enough to pass." });
  failsWith(f, /duplicate claim_id C6\.1/, "a shadowed claim accepted");
});

/* ------------------------------------------------------- the spoken line */

/* Mutation: delete the REFERENCE_LEAK_RE branch in spokenLineErrors(). This is
   the founder's ruling of 2026-08-19 and the only thing enforcing it in the repo. */
test("reference apparatus may not appear in a spoken line", () => {
  const f = base();
  firstClaimSentence(f, "beat-06").text = "The article on starch in wikipedia sets out the polymer.";
  failsWith(f, /reference apparatus in a spoken line/, "a citation was read aloud");
});

test("a bare domain and a page citation are both caught as references", () => {
  const f = base();
  firstClaimSentence(f, "beat-07").text = "The detail is set out at britannica.com for anyone who wants it.";
  failsWith(f, /reference apparatus in a spoken line/, "a domain was read aloud");

  const g = base();
  firstClaimSentence(g, "beat-07").text = "The maltster's own handbook covers all of it at pp. 40 and after.";
  failsWith(g, /reference apparatus in a spoken line/, "a page citation was read aloud");
});

/* Mutation: delete the `/\d/` branch. §5d requires numbers "written as spoken"
   because a numeral is an untested instruction to a TTS voice. */
test("a digit in a spoken line is a violation", () => {
  const f = base();
  sentence(f, "beat-07", (s) => s.text.includes("sixty-three")).text =
    "Alpha-amylase peaks between 63 and 70 degrees Celsius.";
  failsWith(f, /digit in a spoken line/, "a numeral reached the script");
});

/* Mutation: empty BANNED_HEDGES. */
test("a banned hedge in a spoken line is a violation", () => {
  const f = base();
  firstClaimSentence(f, "beat-08").text = "Many historians believe the mould came from a toxic relative.";
  failsWith(f, /banned hedge "many historians believe"/, "an unattributed hedge accepted");
});

/* Mutation: shorten BANNED_ADJECTIVES back to the five-word list it shipped
   with, which omitted three of §5c's own bans. */
test("§5c's banned adjectives are enforced in full, not the short list", () => {
  for (const adj of ["surprising", "extraordinary", "striking"]) {
    const f = base();
    firstClaimSentence(f, "beat-06").text = `That asymmetry is the ${adj} thing about the whole subject.`;
    failsWith(f, new RegExp(`banned adjective "${adj}"`), `${adj} accepted`);
  }
});

/* Mutation: delete the BANNED_OPENERS loop. "Now" as a throat-clearing opener is
   on §5c's list verbatim, and the committed script carried one until review. */
test("§5c's throat-clearing openers are caught sentence-initially only", () => {
  const f = base();
  firstClaimSentence(f, "beat-08").text = "Now the part that changes the arithmetic is the timing.";
  failsWith(f, /§5c banned opener "now"/, "a throat-clearing opener accepted");

  /* And not mid-sentence, or the rule would be unusable in English. */
  const g = base();
  firstClaimSentence(g, "beat-08").text = "The mould is by now already releasing sugar into the mash.";
  assert.doesNotMatch(checkForay(g).errors.join("\n"), /banned opener/, "false positive on mid-sentence 'now'");
});

/* Mutation: delete the rhetorical-question branch. §5c permits one only where
   "the tape answers immediately", and a Carry has no tape to answer with, so the
   narrator answers itself — which §5c names as a padding pattern. */
test("a rhetorical question is rejected in a beat with no tape", () => {
  const f = base();
  firstClaimSentence(f, "beat-06").text = "Was the sugar already free, or was it locked up as starch?";
  failsWith(f, /rhetorical question in a beat with no tape/, "the narrator asked itself a question");

  /* Mutation: hard-code hasTape:false. A covered beat may ask one, because the
     tape is what answers it. */
  const g = base();
  beat(g, "beat-06").coverage_verdict = "strong";
  firstClaimSentence(g, "beat-06").text = "Was the sugar already free, or was it locked up as starch?";
  assert.doesNotMatch(
    checkForay(g).errors.join("\n"),
    /rhetorical question/,
    "a covered beat must still be allowed one"
  );
});

/* Mutation: delete the seam_sentences loop in the item block. Seam sentences are
   spoken words authored by the LEVEL 2 agent — the one place a parent writes
   prose — and they were entirely ungated until review found it. */
test("an item's seam sentences carry every rule a beat sentence carries", () => {
  const cases = [
    ["According to wikipedia.org, the answer is the same.", /reference apparatus in a spoken line/],
    ["It peaks at 63 degrees and stops there.", /digit in a spoken line/],
    ["It is often said that the two routes are the same.", /banned hedge/],
    ["That is a striking way to put it.", /banned adjective "striking"/],
    ["Now the two routes meet.", /banned opener "now"/],
    ["So which route did the world actually take?", /rhetorical question in a beat with no tape/],
  ];
  for (const [text, re] of cases) {
    const f = base();
    f.threads[0].items[0].seam_sentences = [text];
    failsWith(f, re, `seam sentence went ungated: ${text}`);
  }
});

test("a sentence licensed as a claim must cite a claim_id", () => {
  const f = base();
  firstClaimSentence(f, "beat-06").claims = [];
  failsWith(f, /licensed "claim" but cites no claim_id/, "an unsourced assertion accepted");
});

test("a sentence may not cite a claim that does not exist", () => {
  const f = base();
  firstClaimSentence(f, "beat-06").claims = ["C6.99"];
  failsWith(f, /cites unknown claim C6\.99/, "a dangling evidence binding accepted");
});

/* ---------------------------------------------- the cross-sibling contract */

/* Mutation: replace the `establishedBy.has(k)` error with `continue`. This is the
   defect a narrow-focus agent structurally cannot see — two beats explaining the
   same thing — and the parent contract is its only defence. */
test("two sibling beats may not establish the same key", () => {
  const f = base();
  beat(f, "beat-08").establishes.push("starch-is-a-glucose-polymer");
  failsWith(
    f,
    /"starch-is-a-glucose-polymer" is established by both beat-06 and beat-08/,
    "duplicated explanation accepted"
  );
});

/* Mutation: delete the `!earlier && !declared.has(k)` error. */
test("a beat may not assume a key nothing earlier establishes and nothing declares", () => {
  const f = base();
  beat(f, "beat-07").assumes.push("distillation-concentrates");
  failsWith(f, /beat-07 assumes "distillation-concentrates"/, "an unestablished antecedent accepted");
});

/* Mutation: drop `.filter((c) => c?.polarity === "requires")` when building
   `declared`. A thread would then satisfy an assumption with a criterion saying
   the opposite — silent, because the key names match either way. */
test('a "forbids" start criterion does not satisfy an assumption', () => {
  const f = base();
  const s3 = f.threads[0].start_criteria.find((c) => c.polarity === "forbids");
  assert.ok(s3, "the committed thread must carry a forbids criterion for this test to mean anything");
  beat(f, "beat-06").establishes = beat(f, "beat-06").establishes.filter((k) => k !== s3.key);
  beat(f, "beat-07").assumes = [s3.key];
  failsWith(f, new RegExp(`beat-07 assumes "${s3.key}"`), "a negative criterion satisfied an assumption");
});

/* Mutation: delete the `!isStr(c?.check)` error. Vague criteria make levels 1 and
   3 both unfalsifiable, which narration-architecture §4 is written against. */
test("a criterion without a check is rejected", () => {
  const f = base();
  delete f.threads[0].end_criteria[0].check;
  failsWith(f, /a criterion without a check is a wish/, "an uncheckable criterion accepted");

  const g = base();
  delete g.threads[0].start_criteria[0].polarity;
  failsWith(g, /start criterion needs polarity/, "a criterion with no polarity accepted");
});

/* ------------------------------------------------------- numbers and budgets */

/* Mutation: delete the `n !== c.spoken_number` comparison. The number the
   listener hears then drifts from the artifacts the day a blocked route lands. */
test("a self-checked number is compared against the artifacts", () => {
  const f = base();
  f.threads[0].routes.push("bought-enzyme-route");
  failsWith(f, /C6\.12 speaks 4 but thread\.routes holds 5/, "the spoken count drifted from the artifacts");
});

/* Mutation: delete the SPELLED lookup block. Comparing spoken_number to
   thread.routes.length is JSON-to-JSON and proves nothing about the script: the
   sentence says the number in WORDS, so without this the listener could hear
   "ninety-seven" with spoken_number 4 and the gate would be green. */
test("a self-checked number must be the word the listener actually hears", () => {
  const f = base();
  sentence(f, "beat-06", (s) => s.text.includes("four ways")).text =
    "The step that unlocks the locked half is called conversion, and there are seven ways to do it.";
  failsWith(f, /C6\.12: no sentence citing it says "four"/, "the spoken word and the count drifted apart");
});

/* Mutation: raise NARRATION_HARD_MAX_SEC to 1000. §2c calls the hard max a
   principle first: the narrator is never the longest item in the Foray. */
test("an item past the hard max fails, and past the soft max needs a recorded reason", () => {
  const f = base();
  beat(f, "beat-06").sentences.push({ text: "x".repeat(1400), licence: "head", claims: [] });
  failsWith(f, /T2-A: \d+(\.\d+)? s is past the 180 s hard max/, "an over-long narration item accepted");

  const g = base();
  beat(g, "beat-06").sentences.push({ text: "y".repeat(200), licence: "head", claims: [] });
  failsWith(g, /past the 150 s soft max and needs needs_review/, "a soft-max item shipped without a reason");
});

/* Mutation: raise NUMERIC_FACTS_PER_ITEM_MAX to 99. The cap is §5d's and it
   applies across the MERGED item, because the item is what a listener hears
   without a break. */
test("numeric facts are capped across the merged item, not the beat", () => {
  const f = base();
  beat(f, "beat-06").numeric_facts.push("C6.12:a fourth figure");
  failsWith(f, /T2-A: 4 numeric facts against §5d's cap of 3/, "a fourth spoken figure accepted");
});

/* Mutation: restore `quantitative` to a regex for the literal word
   "quantitative" in tier_reason. The cap above then measures nothing for any
   claim whose reason happens to be worded differently — one prose edit from
   silence. */
test("a spoken quantitative claim must be declared as a numeric fact", () => {
  const f = base();
  beat(f, "beat-08").numeric_facts = [];
  failsWith(f, /C8\.5 is spoken and quantitative but appears in no numeric_facts entry/, "under-declaration accepted");

  const g = base();
  claim(g, "beat-08", "C8.5").tier_reason = "two figures the listener has to retain";
  beat(g, "beat-08").numeric_facts = [];
  failsWith(g, /C8\.5 is spoken and quantitative/, "the check depended on a word in free prose");
});

/* Mutation: delete the numeric_facts tier check. */
test("a numeric fact may not point at a tier 1 claim", () => {
  const f = base();
  beat(f, "beat-06").numeric_facts = ["C6.1:not a figure at all"];
  failsWith(f, /points at a tier 1 claim/, "a mislabelled numeric fact accepted");
});

/* Mutation: set MODE_CHAR_BANDS values to [0, 99999], or delete the band
   comparison. Before review the bands were looked up and compared to nothing —
   a documented budget the gate silently ignored. */
test("a beat outside its mode's character band is rejected", () => {
  const f = base();
  const b = beat(f, "beat-09");
  b.sentences = b.sentences.slice(0, 3);
  failsWith(f, /chars is outside the carry band 765-1870/, "an under-length Carry accepted");
});

/* Mutation: change SENTENCE_MEAN_WORDS to [0, 99]. Untested until review. */
test("§5d's sentence rules are enforced per beat", () => {
  const f = base();
  beat(f, "beat-06").sentences.push({ text: "Yes.", licence: "head", claims: [] });
  beat(f, "beat-06").sentences.push({ text: "No.", licence: "head", claims: [] });
  beat(f, "beat-06").sentences.push({ text: "Quite.", licence: "head", claims: [] });
  failsWith(f, /mean sentence length [\d.]+ words is outside §5d's 12-15/, "mean sentence length unchecked");

  /* Mutation: change SENTENCE_MAX_WORDS to 9999. */
  const g = base();
  firstClaimSentence(g, "beat-07").text =
    "The maltster steeps the barley and then lets it sprout and then kilns it and then hands the whole lot over to a brewer who chooses a temperature.";
  failsWith(g, /longest sentence is \d+ words against §5d's maximum of 25/, "sentence maximum unchecked");

  /* Mutation: change RHYTHM_TRIGGER_SEC to 999999. */
  const h = base();
  for (const s of beat(h, "beat-08").sentences) {
    if (s.text.split(/\s+/).length < 6) s.text = "The genes for the toxin are all still there in it.";
  }
  failsWith(h, /no sentence under 6 words; §5d's rhythm rule applies/, "rhythm rule unchecked");
});

/* Mutation: raise NARRATION_ITEMS_PER_THREAD_MAX to 99. */
test("a thread may not hold more narration items than §2e allows", () => {
  const f = base();
  f.threads[0].items.push({ item_id: "T2-C", mode: "carry", beats: ["beat-09"], seam_sentences: [] });
  failsWith(f, /3 narration items against §2e's cap of 2/, "a third narration item accepted");
});

/* Mutation: change the classification to include every Marker regardless of
   length. §2b defines a narration item as a Patch, a Carry, or a Marker OVER
   12 s; a shorter Marker is a transition item and must not be counted. */
test("a short Marker is a transition item and does not count against the cap", () => {
  const f = base();
  f.threads[0].items.push({ item_id: "T2-M", mode: "marker", beats: [], seam_sentences: ["A short signpost here."] });
  assert.doesNotMatch(
    checkForay(f).errors.join("\n"),
    /narration items against §2e/,
    "a 1 s Marker was counted as a narration item"
  );
});

/* Mutation: flip the comparison to `<=`. §2e requires the second of two
   consecutive narration items to be shorter, and on an all-narration stretch it
   is the only textural signal at the seam. */
test("the second of two consecutive narration items must be shorter", () => {
  const f = base();
  beat(f, "beat-09").sentences.push({ text: "z".repeat(600), licence: "head", claims: [] });
  failsWith(f, /T2-B \([\d.]+ s\) must be shorter than T2-A/, "a lengthening second item accepted");
});

/* ------------------------------------------------------------ the merge */

/* Mutation: change `placements > 1` back to a Set membership test. The test name
   promised "exactly one" and the code enforced "at least one" until review. */
test("every beat in a thread lands in exactly one item, not merely at least one", () => {
  const f = base();
  f.threads[0].items[1].beats = ["beat-08"];
  failsWith(f, /beat-09 is in no item/, "a beat lost by the merge accepted");

  const g = base();
  g.threads[0].items[1].beats = ["beat-06", "beat-08", "beat-09"];
  failsWith(g, /beat-06 is in 2 items; it must be in exactly one/, "a beat spoken twice accepted");
});

/* ------------------------------------------------- robustness and surfaces */

/* Mutation: replace the `arr()` guards with `?? []`. A checker that throws on one
   bad field reports nothing about the good data beside it, and the crash is
   indistinguishable from the tool being broken. */
test("malformed input produces findings rather than a stack trace", () => {
  for (const wreck of [
    (f) => (beat(f, "beat-06").sentences = "not an array"),
    (f) => (beat(f, "beat-06").claims = "not an array"),
    (f) => (beat(f, "beat-06").establishes = 7),
    (f) => (beat(f, "beat-06").assumes = null),
    (f) => (f.threads[0].items = {}),
    (f) => (f.threads[0].start_criteria = "nope"),
    (f) => (f.arc.dots = null),
    (f) => f.beats.push(null),
  ]) {
    const f = base();
    wreck(f);
    let r;
    assert.doesNotThrow(() => (r = checkForay(f)), "checkForay threw instead of reporting");
    assert.ok(r.errors.length > 0, "malformed input produced no finding at all");
  }
});

test("a Foray whose arc will not parse is reported, not thrown", () => {
  const foray = loadForay(REPO_ROOT, "does-not-exist");
  assert.ok(foray.loadError, "a missing arc.json must come back as loadError");
  assert.deepEqual(foray.beats, []);
});

test("the reference surface carries the spans and the script carries none of them", () => {
  const foray = loadForay(REPO_ROOT, FORAY_ID);
  const md = renderReferences(foray, "T2-sugar-unlock");
  assert.match(md, /oldid=1366554333/, "the surface must pin the revision it was fetched at");
  assert.match(md, /α-amylase \(63-70 °C\)/, "the surface must carry the verbatim span");
  assert.match(md, /BLOCKED, not spoken/, "the surface must record what was refused");
  assert.match(md, /sourced, not spoken/, "the surface must record what was cut by a craft rule");
  for (const b of foray.beats) {
    assert.doesNotMatch(beatScript(b), /oldid|wikipedia|https?:\/\//i, `${b.beat_id} speaks a reference`);
  }
});

/* Mutation: edit one character of the committed references markdown. §8c says a
   reference list that can drift from the script it documents "reads as an audit
   and is not one", and nothing checked that until review. */
test("the committed reference surface matches what the generator produces", () => {
  const onDisk = fs.readFileSync(path.join(FORAY_DIR, "references", "T2-sugar-unlock.md"), "utf8");
  const generated = renderReferences(loadForay(REPO_ROOT, FORAY_ID), "T2-sugar-unlock");
  assert.equal(
    onDisk.replace(/\r\n/g, "\n"),
    generated,
    "references/T2-sugar-unlock.md is stale — regenerate with --references"
  );
});

test("no beat file stores a script field, because a stored copy can drift", () => {
  /* Mutation: add "script": "..." to any beat JSON. The derived text and the
     stored text are then two sources of truth for what is spoken, and only one
     carries the per-sentence evidence binding. */
  for (const file of fs.readdirSync(BEATS_DIR).filter((n) => n.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(BEATS_DIR, file), "utf8"));
    assert.ok(!("script" in raw), `${file} stores a script field; it must be derived from sentences`);
    assert.ok(Array.isArray(raw.sentences) && raw.sentences.length > 0, `${file} has no sentences`);
  }
});

test("the arc, the threads and the beats cross-reference each other", () => {
  /* Mutation: delete any of the three level-1 cross-reference errors. */
  const f = base();
  f.threads[0].dot_id = "D99";
  failsWith(f, /dot_id "D99" is in no dot/, "an orphan thread accepted");

  const g = base();
  beat(g, "beat-06").thread_id = "T9-nope";
  failsWith(g, /thread_id "T9-nope" has no thread file/, "an orphan beat accepted");

  const h = base();
  h.arc.dots[0].built.push("T99-imaginary");
  failsWith(h, /names built thread "T99-imaginary" with no file/, "an imaginary built thread accepted");
});

test("spokenLineErrors is clean on the committed scripts and honest at the edges", () => {
  const foray = loadForay(REPO_ROOT, FORAY_ID);
  for (const b of foray.beats) {
    for (const s of b.sentences) {
      const errs = spokenLineErrors(s.text, "x", { hasTape: b.coverage_verdict !== "empty" });
      assert.deepEqual(errs, [], `${b.beat_id}: ${errs.join("; ")}`);
    }
  }
  assert.deepEqual(spokenLineErrors("", "x"), ["x: empty text"]);
  assert.deepEqual(spokenLineErrors(null, "x"), ["x: empty text"]);
});

test("the planning rate is the player's, not a second copy of it", () => {
  /* Mutation: change NARRATION_CHARS_PER_SEC to 14.7 (tools/narrate/billable.mjs's
     figure). Two documents then disagree about money, which is the failure
     narration-craft §4d warns about. This cannot fail on today's code and is
     written deliberately: it is the only thing that would notice the constant
     being re-derived here instead of inherited from player/foray-queue.js. */
  assert.equal(NARRATION_CHARS_PER_SEC, 17);
  assert.equal(scriptSeconds(1020), 60);
});

test("the helpers behave at the edges rather than throwing", () => {
  assert.equal(beatScript(null), "");
  assert.equal(beatScript({}), "");
  assert.deepEqual(numberTokens(null), []);
  assert.deepEqual(numberTokens("63-70 °C"), ["63", "70"]);
  assert.deepEqual(numberTokens("18–20% ABV"), ["18", "20"]);
  assert.equal(inferredTier("a plain mechanism sentence"), "1");
  assert.equal(inferredTier("it stalls at 14 per cent"), "2");
  assert.equal(inferredTier("the world's largest producer"), "2");
});

test("the committed thread still satisfies the gate after a no-op clone", () => {
  /* The control. Every proof above is a mutation of base(), so if base() were
     already dirty each one would be a demonstration that broken data is broken.
     check-forays.test.mjs's header names this as the test to look at first. */
  clean(base(), "base() is not clean, so every mutation proof above is void");
});
