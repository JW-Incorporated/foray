/* Issue #182, restructured by issue #236. Two jobs, on two different data sets,
 * and keeping them apart is the point.
 *
 *   1. THE GATE, against the LIVE committed data (`live` below). CI runs this
 *      file (tools/ci/run-suites.mjs discovers it), so a Foray whose running
 *      order breaks D1 or D5 turns `data-and-site` red and cannot merge.
 *   2. THE PROOFS, against a COMMITTED FIXTURE (`fixture` below,
 *      `tools/foray/fixtures/boundary/`). #182's acceptance is explicit:
 *      "verified by deliberately reordering to break a rule and confirming CI
 *      goes red — not by inspection". Every rule is therefore broken on purpose,
 *      and the D1/D5 cases go one further and spawn the real CLI against a
 *      mutated checkout to assert exit code 1. A checker that is only ever run on
 *      passing data is not a checker.
 *
 * WHY THE PROOFS MOVED OFF THE LIVE DATA (#236)
 * They used to break `data/forays.json`'s `grilling-history-1`, whose exact shape
 * — 32 items, 3,673.03 s, the 620.5 s span, the GRID-3 reinstatement — was what
 * made four of them expressible. That is live curation. Pinning it here meant a
 * curator could not change a Foray without a test migration, which is precisely
 * backwards for the product's core activity, and it meant these tests were
 * testing today's curation rather than the checker.
 *
 * The fix is not to rewrite the proofs against whatever data exists. Four of them
 * are properties of an order that sits EXACTLY on D1's budget, and a Foray with
 * D1 headroom cannot host them — rewriting them to fit would leave them green
 * while destroying what they prove, which is the failure mode this repo has hit
 * repeatedly. So the boundary conditions were extracted into a fixture whose only
 * job is to sit on them. `tools/foray/fixtures/README.md` derives every number.
 *
 * WHAT IS STILL ASSERTED ABOUT THE LIVE DATA, and how
 * Only things that are true of ANY Foray: it passes, its report is consistent
 * with its own items, its §2 running-order table agrees with the data row for
 * row (which pins every label, role and duration — so the aggregates the old
 * literals pinned are functions of things still pinned), its labels resolve, its
 * copy obeys the copy rules, its sources resolve. Nothing here names a count, a
 * runtime or a segment of a live Foray as a literal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import copyRules from "../../backend/src/copy/rules.js";
import {
  checkForays,
  loadFiles,
  d1Budget,
  d5UniformPairs,
  iqr,
  maxStartsInWindow,
  D1_WINDOW_SEC,
  L4_SOFT_MAX_SEC,
  M4_LONG_CLIP_SEC,
  M4_SHARE_MAX,
  phonemeProblems,
  scriptMentions,
  lexiconEntries,
  TTS_ENGINES,
  LEXICON_PATH,
} from "./check-forays.mjs";

const { BANNED, wordCount, MAX_WHY_LINE_WORDS } = copyRules;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "check-forays.mjs");

/* ---------------------------------------------------------- the two data sets */

/** The live committed curation. Read-only in this file: nothing below mutates a
    clone of it, because a mutation proof that needs a particular duration is a
    proof that owns the data it needs. */
const live = loadFiles(REPO_ROOT);

/** The committed boundary fixture — four files in the same shape, loaded by the
    same loader, so `--root` can point the real CLI at it unchanged. */
const FIXTURE_ROOT = path.join(HERE, "fixtures", "boundary");
const fixture = loadFiles(FIXTURE_ROOT);

/** A throwaway copy of the FIXTURE. Every mutation below starts here. */
const fx = () => structuredClone(fixture);
/** The fixture's one Foray, in a clone or in the original. */
const boundary = (f) => f.forays.forays[0];

const forayBy = (f, id) => f.forays.forays.find((x) => x.id === id);
const errorsFor = (f) => checkForays(f).errors;
const segmentItems = (foray) => foray.items.filter((i) => i.type === "segment");
const durationOf = (f, segmentId) => {
  const s = f.segments.segments.find((x) => x.id === segmentId);
  return s.end_sec - s.start_sec;
};
/** Every D5 line the checker emitted for one Foray. There is exactly one
    shape of them since F-102 — a warning — and the tests below count warnings
    against the durations rather than asking which regime a Foray is in. The
    helper that answered THAT question (`cutUnderQ01`, Q-04/F-96) went with the
    gate; its `boundary` sniff survives nowhere because no verdict turns on it
    any more. */
const d5WarningsFor = (warnings, forayId) => warnings.filter((w) => /D5 \(reported, not gated/.test(w) && w.includes(`"${forayId}"`));
/** A fixture item and its pooled segment, by label — the two handles every
    mutation below needs. `assert` rather than `?.` so a renamed label fails as a
    missing fixture rather than as a confusing TypeError three lines later. */
const itemAt = (f, label) => {
  const item = boundary(f).items.find((i) => i.label === label);
  assert.ok(item, `the fixture has no item labelled ${label}`);
  return item;
};
const segmentAt = (f, label) => {
  const seg = f.segments.segments.find((s) => s.id === itemAt(f, label).segment_id);
  assert.ok(seg, `${label} resolves to no pooled segment`);
  return seg;
};

/* ============================================================================
   1. THE GATE — the live committed data
   ========================================================================= */

test("the committed data passes with zero errors", () => {
  const { errors } = checkForays(live);
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("the CLI exits 0 on the committed data", () => {
  const out = execFileSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.match(out, /forays ok/);
});

test("the committed Forays are the four documented ones, and all are #134's kind", () => {
  /* Pinned by id rather than by count so that adding a fourth is a deliberate
     edit here, and so a RENAME cannot pass as an addition. This is the one live
     literal that survives #236, and it is not a shape pin: it is a statement
     about WHICH Forays exist, which is exactly the kind of change that should
     cost an edit in a test.

     ORDER NO LONGER MATTERS to anything below — the `foray0` handle that made
     `forays[0]` load-bearing is gone with the proofs that used it (#236). It is
     still asserted in order because a reordering of this file is a deliberate
     edit too, and a `deepEqual` is the cheapest way to say so. */
  /* Curated Forays are pinned by id; a GENERATED Foray (`generated: true`) is admitted
     by the publish PR that lands it (requirements §6.5), so the pin lists only the curated
     ids and requires every other Foray to carry the generated bit. */
  assert.deepEqual(
    live.forays.forays.filter((f) => !f.generated).map((f) => f.id),
    ["grilling-history-1", "grilling-history-2", "capital-types-1", "geology-plates-1"]
  );
  for (const f of live.forays.forays.filter((f) => f.generated)) assert.equal(f.generated, true, f.id);
  for (const f of live.forays.forays) assert.equal(f.kind, "deep-dive", f.id);
});

test("Foray #1 is labelled superseded, so nobody re-tests the drift by accident", () => {
  /* Both grilling Forays are drafts reachable by `?foray=<id>`, and the older
     link still works. A stale draft that nothing labels stale is how the wrong
     one gets tested next week (#226). Neither field is read by the player. */
  const one = forayBy(live, "grilling-history-1");
  assert.equal(one.superseded_by, "grilling-history-2");
  assert.match(one.superseded_note, /Superseded 2026-08-17/);
  assert.ok(forayBy(live, "grilling-history-2"), "the successor must exist");
  assert.equal(forayBy(live, "grilling-history-2").superseded_by, undefined);
});

test("exactly one committed Foray is published, and it is the one that was named", () => {
  /* THIS IS THE OLD "every committed Foray is still a draft" VALVE, NARROWED BY
     ONE NAMED FORAY RATHER THAN REMOVED.

     The valve is the same one ladders have (docs/curation/ladders-client-spec.md):
     publishing is a founder action (HUMAN-ACTIONS.md #2), so a client that
     surfaces a Foray has published it in the only sense a visitor experiences.
     Its old comment said "the day it stops being true should be a deliberate
     edit" — this is that edit. On 2026-08-30 the founder asked for one Foray to
     be publishable so the Play listing could describe Forays without describing
     something no visitor can reach, and `capital-types-1` is the one chosen:
     it is the only candidate whose own assembly record reports no global rules
     missed (docs/curation/foray2-capital.md §0), and it has the lowest
     cross-episode seam rate per minute of the four.

     PINNED AS AN EXACT SET, not as "at most one published" and not by deleting
     the loop. The three Forays that stay draft are guarded exactly as hard as
     before — a second one flipping fails here, and so does this one flipping
     back. Publishing the next Foray costs one deliberate line in this array,
     which is the price the old loop charged and the whole reason it was written
     as a loop instead of about Foray #1.

     ONE THING THE OLD LOOP CAUGHT THAT THIS DOES NOT, checked rather than
     assumed: a status that is neither "draft" nor "published". `assert.equal(f
     .status, "draft")` rejected a third value directly; filtering on
     `=== "published"` does not. Mutating `geology-plates-1` to `"archived"` was
     run, and the suite still goes red — caught by "the committed data passes with
     zero errors" and by the CLI test above it, both of which reach
     `check-forays.mjs`'s own `status` enum. That is the better home for it: the
     enum is enforced by the shipping checker rather than by a loop in a test.
     But it left the enum itself pinned by NOTHING — deleting that line kept the
     suite green — so the test below this one now pins it directly. Do not delete
     that test on the grounds that this one covers the same ground; it does not,
     and that is the whole reason it exists.

     WHAT THIS TEST DOES NOT SAY: that anyone has listened to it. Nobody has
     (HUMAN-ACTIONS.md #8 is still open), and rule X1 — "a cross-episode seam
     always carries narration" — is unmet at all 10 of its cross-episode seams,
     because no narration audio exists anywhere in the repo. Neither fact is
     checkable here; both are recorded so a reader of a green suite does not
     infer them. */
  assert.ok(live.forays.forays.length > 0, "no Forays — this proved nothing");
  assert.deepEqual(
    live.forays.forays.filter((f) => f.status === "published").map((f) => f.id),
    ["capital-types-1"]
  );
});

test("`status` is an enum of exactly two values, and a third is an error", () => {
  /* THE MUTATION THIS KILLS: deleting `check-forays.mjs`'s `status` line
     entirely. Until the test above was narrowed, the live loop
     `assert.equal(f.status, "draft")` covered this by accident on the committed
     data, and the enum in the checker had no proof of its own anywhere in the
     repo — the line could be deleted and all 88 suites stayed green. That is the
     "guard that was not guarding" shape, and narrowing the loop is what exposed
     it, so it is closed here rather than left as a comment claiming the checker
     handles it.

     Run on the FIXTURE, not on the live data, for the reason stated at `fx()`: a
     proof that needs a particular value is a proof that owns the data it needs.

     Both legal values are asserted as well as the illegal one. A one-sided test
     is satisfied by `E()` on every status, which would reject the very publish
     this file now pins one line above. */
  for (const status of ["draft", "published"]) {
    const f = fx();
    boundary(f).status = status;
    assert.deepEqual(
      errorsFor(f).filter((e) => /`status`/.test(e)),
      [],
      `"${status}" is a legal status and must not be reported`
    );
  }
  for (const status of ["archived", "DRAFT", "", null, undefined]) {
    const f = fx();
    boundary(f).status = status;
    const hits = errorsFor(f).filter((e) => /`status` must be "draft" or "published"/.test(e));
    assert.equal(hits.length, 1, `${JSON.stringify(status)} must be rejected exactly once, got ${hits.length}`);
  }
});

test("every committed Foray's report is consistent with the items it lists", () => {
  /* #236 replaced three per-Foray literal pins — 32 items, 3,673.03 s, 114.8 s
     mean, and Foray #2's four — with the law they were instances of. It holds for
     Foray #4 on the day it lands, it cannot be satisfied by editing a number in
     this file, and every quantity the old pins named is recomputed from the items
     rather than compared to a remembered value.

     Honest about which lines carry independent weight, since a first draft of
     this called the whole test "strictly stronger". The recomputations do: the
     segment count, the tape sum, tape-plus-narration, the mean and the stated
     runtime are all this file's own arithmetic against the checker's. The two
     rule verdicts below (D1 within budget, D5's pairs reported) do NOT — they are
     implied by "the committed data passes with zero errors" above, and they are
     kept only because a failure here names WHICH Foray and by how much, which
     that test cannot.

     What used to be lost by dropping the literals — "an unpinned number is what
     drifted last time" — is covered by the §2 doc-table loop below, which pins
     every label, role and duration of every Foray against its doc. Mean, IQR and
     runtime are functions of those. */
  const { report } = checkForays(live);
  assert.equal(report.forays.length, live.forays.forays.length, "every Foray must be reported");
  for (const r of report.forays) {
    const foray = forayBy(live, r.id);
    const segs = segmentItems(foray);
    const where = `${r.id}: `;
    assert.equal(r.segments, segs.length, `${where}report counts ${r.segments} of ${segs.length} segment items`);
    const tape = segs.reduce((t, i) => t + durationOf(live, i.segment_id), 0);
    assert.ok(Math.abs(r.tape_runtime_sec - tape) < 0.01, `${where}tape ${r.tape_runtime_sec} vs items ${tape}`);
    /* F-89 (2026-09-11): the first Foray with jingle items showed this line had
       been asserting tape plus narration while the checker (correctly) also counts
       `jingle_sec` — the jingle sounds for real seconds. The report field is
       asserted to exist so a checker that silently stops reporting it is red here. */
    assert.equal(typeof r.jingle_sec, "number", `${where}report has no jingle_sec`);
    assert.ok(
      Math.abs(r.runtime_sec - (r.tape_runtime_sec + r.narration_sec + r.jingle_sec)) < 0.01,
      `${where}the listener's clock is not tape plus narration plus jingles`
    );
    assert.ok(Math.abs(r.mean_sec - tape / segs.length) < 0.06, `${where}mean ${r.mean_sec}`);
    assert.ok(r.d1_max_starts_in_window <= r.d1_budget, `${where}D1 ${r.d1_max_starts_in_window}/${r.d1_budget}`);
    /* Q-04 / F-102: D5's pair clause is reported on every Foray and gates
       none, so the report carries the count and no regime flag. `d5_gated` is
       asserted GONE: a flag that is permanently false is worse than no flag. */
    assert.equal(r.d5_gated, undefined, `${where}d5_gated went with the gate (F-102)`);
    assert.equal(r.d5_uniform_pairs, d5UniformPairs(segs.map((i) => durationOf(live, i.segment_id))).length, `${where}D5 pairs`);
    assert.ok(typeof r.d5_iqr_sec === "number" && r.d5_iqr_sec >= 0, `${where}IQR ${r.d5_iqr_sec} is still reported`);
    // The stated runtime is the drift detector the checker itself runs; asserted
    // here per Foray so a failure names which document is stale.
    assert.ok(
      Math.abs(r.runtime_sec - foray.runtime_sec) < 0.5,
      `${where}the document states ${foray.runtime_sec} s and the items sum to ${r.runtime_sec} s`
    );
  }
});

test("every played segment past L4's soft maximum carries both escape-hatch fields", () => {
  /* Was "Foray #2's only L4 segment carries both escape-hatch fields", which
     named VD-1 and 259.9 s. The editorial content is not the label: it is that
     going long is allowed only in exchange for saying why. `needs_review` and
     `long_reason` are not in the segment schema yet (§9 proposes them), so they
     live on the item.

     NOT asserted non-zero, unlike every other loop in this file, and the
     exception is deliberate (#236 review). L4's hatch is an exception a curator is
     ALLOWED to stop taking: dropping the one over-long segment in the committed
     data is an ordinary editorial edit, and requiring one to exist would make that
     edit cost a test edit — the defect this issue exists to remove. The hatch
     itself is not left unproven: three tests on the boundary fixture cover it
     ("L4 FAILS on a segment over 240 s with no long_reason", "L4's escape hatch is
     reachable", "L4's escape hatch needs BOTH fields"), and they own the data they
     need. What this loop is for is the live case, whenever there is one. */
  let found = 0;
  for (const f of live.forays.forays) {
    for (const item of segmentItems(f)) {
      if (durationOf(live, item.segment_id) <= L4_SOFT_MAX_SEC) continue;
      found += 1;
      assert.equal(item.needs_review, true, `${f.id} ${item.label} is past ${L4_SOFT_MAX_SEC} s without needs_review`);
      assert.ok(
        item.long_reason && item.long_reason.length > 40,
        `${f.id} ${item.label}: long_reason must say what the extra minutes do`
      );
    }
  }
  // Reported, not required: see above.
  assert.ok(found >= 0);
});

test("M4's concentration cap holds on every Foray, recomputed here rather than read off the report", () => {
  /* Was "Foray #2 draws on exactly eight episodes" — the eight is curation. The
     first #236 draft replaced it with `eps.size >= ceil(1 / 25 %)`, and review was
     right that this cannot fail on its own: a three-episode Foray necessarily puts
     one episode over 25 %, so the checker's own M4 error fires first.

     So it recomputes M4 instead. This is a second implementation of §6c's cap —
     "<= 25 % of a Foray's segments AND <= 25 % of its runtime from any single
     `item_id`" — reading the data directly, which is work "the committed data
     passes with zero errors" genuinely cannot do: that test trusts the checker's
     arithmetic, and this one does not. The mutation it exists for is a wrong
     denominator in `check-forays.mjs` (tape versus the listener's clock, or
     played versus pooled), which would pass the gate and fail here.

     The editorial claim in foray2-capital.md §0 — that only one of its episodes
     is a VC show — is NOT checked: "is this a VC show" is not a property of the
     data. An earlier version asserted no source id began with `fr-`, which was
     vacuous (no such id exists) and read as if it were checking the claim. */
  let checked = 0;
  for (const f of live.forays.forays) {
    const played = segmentItems(f).map((i) => live.segments.segments.find((s) => s.id === i.segment_id));
    const tape = played.reduce((t, s) => t + (s.end_sec - s.start_sec), 0);
    assert.ok(tape > 0, `${f.id} plays no tape`);
    const byEpisode = new Map();
    for (const s of played) {
      const e = byEpisode.get(s.item_id) ?? { n: 0, sec: 0 };
      e.n += 1; e.sec += s.end_sec - s.start_sec;
      byEpisode.set(s.item_id, e);
    }
    for (const [id, e] of byEpisode) {
      assert.ok(
        e.n / played.length <= M4_SHARE_MAX,
        `${f.id}: "${id}" is ${e.n}/${played.length} = ${(100 * e.n / played.length).toFixed(1)} % of the segments`
      );
      assert.ok(
        e.sec / tape <= M4_SHARE_MAX,
        `${f.id}: "${id}" is ${(100 * e.sec / tape).toFixed(1)} % of the tape`
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no episode was checked, so this proved nothing");
});

test("the pool segments held back from their Foray are not in any running order", () => {
  // The pool is a pool, not a playlist. Each Foray's doc names the segments it
  // authored and deliberately did not play; those must stay unplayed by EVERY
  // Foray, or the reason they were held (pacing, a rule, an expletive) is void.
  /* type-filtered: a narration item has no `segment_id`, and letting `undefined`
     into this set would inflate `used.size` and quietly satisfy the check
     below. */
  const used = new Set(live.forays.forays.flatMap((f) => segmentItems(f).map((i) => i.segment_id)));
  const held = [
    "bbqc-moss-school#1881", // MOSS-G   — grilling-foray.md §7
    "bbqc-traeger-history#2457", // TRA-4
    "bbqrn-argentina-open-fire#2292", // ARG-8
    "bfh-griddle-bakestone#1360", // GRID-3
    "ss-inlaw-investors#770", // FAM-3   — foray2-capital.md §7
    "tbf-328-tringas#2299", // CALM-2
    "ftb-89-sbir-grants#2467", // GR-4
    "yc-how-fundraising-works#1230", // YC-4
    /* The four Miller cuts M4's 25 % concentration cap would not let
       grilling-history-2 play — grilling-history-coverage.md §5b. Each advances a
       beat and each is authored; the cap is what held them, not the tape. */
    "grill-coach-adrian-miller#1346", // beat 38, the media audit
    "grill-coach-adrian-miller#1609", // beat 18, the indigenous template
    "grill-coach-adrian-miller#1964", // beat 24, skill as capital
    "grill-coach-adrian-miller#2167", // beat 38, the aesthetic shift
  ];
  for (const id of held) {
    assert.ok(live.segments.segments.some((s) => s.id === id), `${id} should be in the pool`);
    assert.ok(!used.has(id), `${id} should be held back`);
  }
  /* This used to assert the pool is EXACTLY what the Forays play plus what they
     held back. That identity is wrong about the ordinary authoring state and
     #236 removed it: a transcription batch lands segments in the pool before
     anyone places them, so an equality here turns "we have new tape to work
     with" red.

     What replaced it was `length >= used.size + held.length`, which review
     pointed out cannot fail — it is implied by the two loops above. Gone, rather
     than left sitting there reading as coverage. The duplicate-id check stays: it
     is the one part of the old identity that was doing independent work, and
     nothing else in this suite asserts the pool's ids are unique. */
  assert.equal(
    new Set(live.segments.segments.map((s) => s.id)).size,
    live.segments.segments.length,
    "the pool has duplicate segment ids"
  );
});

/* ---------------------------------------------------- the recorded mapping */

test("every label resolves to exactly one segment by (episode, duration)", () => {
  // Generated Forays carry no `label`/`label_prefixes` (the pipeline names items by slot
  // and segment_id); the derivation below is about curator-written labels only.
  // This is the derivation the migration did once. Re-running it here is what
  // makes `label` in the data trustworthy rather than decorative: if anyone
  // hand-edits a segment_id, the label no longer picks it out uniquely.
  for (const f of live.forays.forays) {
    if (f.generated) continue;
    for (const item of segmentItems(f)) {
      const dur = durationOf(live, item.segment_id);
      const episode = f.label_prefixes[item.label.split("-")[0]];
      const matches = live.segments.segments.filter(
        (s) => s.item_id === episode && Math.abs(s.end_sec - s.start_sec - dur) <= 0.06
      );
      assert.equal(matches.length, 1, `${f.id} ${item.label}: ${matches.length} segments match`);
      assert.equal(matches[0].id, item.segment_id, `${f.id} ${item.label} resolved to ${matches[0].id}`);
    }
  }
});

/* Each Foray's §2 running-order table, and where it stops. Adding a Foray means
 * adding a row here, which is the point: the doc table and `items` must not be
 * able to move independently. Foray #2 was authored with its §2 claiming this
 * test covered it while the test read only grilling-foray.md — the claim was
 * true of #1 and false of #2 for one commit.
 *
 * #236 dropped the `rows:` count from each entry. It was a second literal for
 * the same fact the data already carries, and the two had to be edited together
 * every time a Foray changed length — grilling-history-2 going from 8 segments to
 * 10 needed both. The row count is now read off the data, which makes "the doc
 * has as many rows as the Foray has segments" an assertion rather than a pair of
 * numbers somebody kept in step by hand. */
const RUNNING_ORDER_DOCS = [
  { forayId: "grilling-history-1", doc: "docs/curation/grilling-foray.md", endsBefore: "### Why the order", tldr: true, slotHeaders: true },
  { forayId: "grilling-history-2", doc: "docs/curation/grilling-history-assembly.md", endsBefore: "### 2a.", tldr: false, slotHeaders: false },
  { forayId: "capital-types-1", doc: "docs/curation/foray2-capital.md", endsBefore: "### Why the slots run", tldr: true, slotHeaders: true },
  { forayId: "geology-plates-1", doc: "docs/curation/geology-foray-assembly.md", endsBefore: "### Who each label is", tldr: true, slotHeaders: true },
];

/** `2:33` or `1:01:13` as seconds. The curation docs write every duration this
    way, and #236 review found three places where the clock half of a cell was
    parsed past and never compared. */
function clockToSec(text) {
  const parts = text.split(":").map(Number).reverse();
  assert.ok(parts.length <= 3 && parts.every((v) => Number.isFinite(v)), `unparseable clock "${text}"`);
  return parts.reduce((t, v, i) => t + v * [1, 60, 3600][i], 0);
}

test("every committed Foray has a running-order doc pinned above", () => {
  /* RUNNING_ORDER_DOCS drives a loop, and `test/suite-integrity.test.js` counts
     top-level `test(` DECLARATIONS — so deleting an entry from that array would
     delete a real test without moving the floor. This assertion is what makes
     that deletion loud instead, and it is also what stops Foray #3 landing with
     its §2 table unpinned, which is the mistake Foray #2 shipped with. */
  assert.deepEqual(
    RUNNING_ORDER_DOCS.map((d) => d.forayId),
    /* A GENERATED Foray (`generated: true`) has no curator-written running-order doc: its
       order is the pipeline's candidate file and `report.json` (requirements §6). The pin
       stays exact for every curated Foray. */
    live.forays.forays.filter((f) => !f.generated).map((f) => f.id)
  );
  for (const { doc } of RUNNING_ORDER_DOCS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, doc)), `${doc} is missing`);
  }
});

for (const { forayId, doc, endsBefore, slotHeaders } of RUNNING_ORDER_DOCS) {
  test(`data/forays.json agrees with ${path.basename(doc)} §2, row for row`, () => {
    /* #182's third consequence is that the order "silently rots": change the data
       and the doc goes stale, or the reverse, with nothing to detect the drift.
       So the doc table is parsed and compared — position, label, duration and
       role — and the two cannot move independently any more. Since #236 this is
       also the only thing pinning a live Foray's SHAPE, and it pins it against
       the doc a curator edits rather than against a literal in a test.

       If this fails because the TABLE was reformatted rather than because the
       order changed, update the regex below; do not delete the test. */
    const md = fs.readFileSync(path.join(REPO_ROOT, doc), "utf8");
    const section = md.split("## 2. The running order")[1]?.split(endsBefore)[0];
    assert.ok(section, `could not find §2 in ${doc}`);
    /* The `at` column is CAPTURED now, not skipped. It was matched as `[\d:]+` and
       thrown away, so every cumulative time in the table could be wrong and this
       still passed — the same half-checked cell as §0's spelled-out runtime
       (#236 review). */
    const rows = [...section.matchAll(/^\|\s*(\d+)\s*\|\s*([\d:]+)\s*\|\s*([A-Z]+-\d+)\s*\|\s*([\d.]+) s\s*\|\s*(\w+)\s*\|/gm)];

    const items = segmentItems(forayBy(live, forayId));
    assert.ok(rows.length > 0, `§2's table in ${doc} no longer parses as numbered rows`);
    assert.equal(rows.length, items.length, `§2 has ${rows.length} rows and ${forayId} plays ${items.length} segments`);

    let cumulative = 0;
    for (const [i, [, n, at, label, dur, role]] of rows.entries()) {
      assert.equal(Number(n), i + 1, `§2's rows are not numbered 1..${rows.length} in order`);
      assert.equal(items[i].label, label, `position ${n}: data says ${items[i].label}, doc says ${label}`);
      assert.equal(items[i].role, role, `${label}: data says ${items[i].role}, doc says ${role}`);
      const seconds = durationOf(live, items[i].segment_id);
      assert.ok(
        Math.abs(seconds - Number(dur)) <= 0.06,
        `${label}: segment is ${seconds} s, doc says ${dur} s`
      );
      /* Cumulative TAPE, which is what the table says it is ("Times are cumulative
         tape positions"). Rounded to the second in the doc, so a second of
         tolerance — enough for the rounding and not enough to hide a reordering. */
      assert.ok(
        Math.abs(clockToSec(at) - cumulative) <= 1,
        `${label}: doc puts it at ${at} (${clockToSec(at)} s) and the tape before it sums to ${cumulative.toFixed(1)} s`
      );
      cumulative += seconds;
    }

    /* The slot header rows — "**SLOT 2 — the pre-modern hearth** (12 segments,
       21:10)". Both numbers are derivable and neither was checked. Declared per
       doc and asserted in both directions, like §0's TL;DR. */
    const headers = [...section.matchAll(/\*\*SLOT \d+ [^*]*\*\*\s*\((\d+) segments?, ([\d:]+)\)/g)];
    assert.equal(headers.length > 0, slotHeaders, `${doc}: §2's slot header rows are ${headers.length ? "present but declared absent" : "declared present but missing"}`);
    if (slotHeaders) {
      const foray = forayBy(live, forayId);
      assert.equal(headers.length, foray.slots.length, `§2 has ${headers.length} slot headers and ${forayId} declares ${foray.slots.length} slots`);
      foray.slots.forEach((slot, s) => {
        const inSlot = items.filter((i) => i.slot === slot.id);
        const sec = inSlot.reduce((t, i) => t + durationOf(live, i.segment_id), 0);
        assert.equal(Number(headers[s][1]), inSlot.length, `§2's header for "${slot.id}" says ${headers[s][1]} segments, the data has ${inSlot.length}`);
        assert.ok(
          Math.abs(clockToSec(headers[s][2]) - sec) <= 1.5,
          `§2's header for "${slot.id}" says ${headers[s][2]} and the data sums to ${sec.toFixed(1)} s`
        );
      });
    }
  });
}

test("each running-order doc's §0 summary numbers are the ones the checker computes", () => {
  /* The gap review found in the first #236 draft. Dropping the `3673.03`,
     `114.8`, `57.81` and `620.5` pins moved the D1/D5 proofs onto the fixture,
     which was the point — but it also left grilling-foray.md §0's OWN summary
     ("Tape runtime 3,673.0 s", "Mean / median 114.8 s", "IQR 57.8 s") checked by
     nothing at all. The §2 loop pins rows, not totals, so the worked edit in this
     PR's own description left the suite green with three false numbers in the doc.
     A stale doc is what #182 called "the order silently rots".

     Read out of the doc and compared to the report, so it stays a doc-agreement
     check rather than becoming a literal again — and to the doc's OWN precision,
     because §0 rounds ("3,673.0" against 3673.03) and demanding more would fail
     on a rounding nobody got wrong.

     `tldr: false` is declared per doc rather than inferred, and asserted in both
     directions below: a doc that grows a §0 must be checked, and a doc that has
     one must not be able to lose it silently. */
  let checked = 0;
  for (const { forayId, doc, tldr } of RUNNING_ORDER_DOCS) {
    const md = fs.readFileSync(path.join(REPO_ROOT, doc), "utf8");
    const section = md.split("## 0. TL;DR")[1]?.split(/^## /m)[0] ?? null;
    assert.equal(
      section !== null, tldr,
      `${doc}: §0 TL;DR ${section ? "exists but is declared absent" : "is declared present but missing"}`
    );
    if (!section) continue;

    const r = checkForays(live).report.forays.find((x) => x.id === forayId);
    /** A doc figure and the tolerance its own decimal places justify. */
    const stated = (label, rx) => {
      const m = section.match(rx);
      assert.ok(m, `${doc} §0 has no parseable "${label}" row`);
      const text = m[1].replace(/,/g, "");
      const dp = (text.split(".")[1] ?? "").length;
      return { value: Number(text), tol: 0.5 * Math.pow(10, -dp), text };
    };
    const rows = [
      ["Segments in the running order", /\| Segments in the running order \| \*\*([\d,]+)\*\* \|/, r.segments],
      ["Tape runtime", /\| Tape runtime \| \*\*([\d,.]+) s/, r.tape_runtime_sec],
      ["Mean segment", /\| Mean \/ median segment \| \*\*([\d,.]+) s/, r.mean_sec],
      ["Interquartile range", /\| Interquartile range \| ([\d,.]+) s/, r.d5_iqr_sec],
    ];
    for (const [label, rx, actual] of rows) {
      const { value, tol, text } = stated(label, rx);
      assert.ok(
        Math.abs(value - actual) <= tol,
        `${doc} §0 says ${label} is ${text} and the checker computes ${actual}`
      );
      checked += 1;
    }
    /* The HUMAN-READABLE half of the same cell — "3,673.0 s — 61 min 13 s". The
       first version of this test stopped at the number, so the minutes could go
       stale on their own, which is the rot it exists to stop (#236 review). */
    const spelled = section.match(/\| Tape runtime \| \*\*[\d,.]+ s — (?:(\d+) h )?(\d+) min (\d+) s\*\* \|/);
    assert.ok(spelled, `${doc} §0's Tape runtime cell no longer spells the clock out`);
    const spelledSec = (Number(spelled[1] ?? 0) * 3600) + Number(spelled[2]) * 60 + Number(spelled[3]);
    assert.ok(
      Math.abs(spelledSec - r.tape_runtime_sec) <= 1,
      `${doc} §0 spells the tape runtime as ${spelled[0].split("— ")[1]} and the checker computes ${r.tape_runtime_sec} s`
    );
    checked += 1;
  }
  assert.ok(checked > 0, "no doc summary was checked, so this proved nothing");
});

test("labels are unique and every prefix is declared, in every Foray", () => {
  for (const f of live.forays.forays) {
    if (f.generated) continue; // pipeline items carry no curator labels (requirements §3.10)
    const labels = segmentItems(f).map((i) => i.label);
    assert.equal(new Set(labels).size, labels.length, `${f.id} has duplicate labels`);
    for (const l of labels) assert.ok(f.label_prefixes[l.split("-")[0]], `${f.id}: no prefix entry for ${l}`);
  }
});

test("GRID-3's incidental mapping in the doc agrees with label_prefixes", () => {
  // grilling-foray.md line 578 is the one committed label -> id example that
  // predates this file. It names a held-back segment, so it is checked here
  // rather than through the running order.
  assert.equal(forayBy(live, "grilling-history-1").label_prefixes.GRID, "bfh-griddle-bakestone");
});

test("L2/L3 hold for every played segment, per §4's role table", () => {
  // Computed directly rather than filtered out of the error list: a test that
  // filters an array another test already asserts is empty cannot fail on its
  // own, and reads as coverage it does not have.
  const floors = { quote: 30, explanation: 60, exchange: 75, narrative: 120 };
  const maxes = { quote: 90, explanation: 360, exchange: 480, narrative: 480 };
  let checked = 0;
  /* Generated Forays record no per-item `role` (check-forays reports "D4 not evaluated"
     for them); the D-tier duration rules cover their segments instead. */
  const curated = live.forays.forays.filter((f) => !f.generated);
  for (const f of curated) {
    for (const item of segmentItems(f)) {
      const d = durationOf(live, item.segment_id);
      assert.ok(d >= floors[item.role], `${f.id} ${item.label} (${item.role}) is ${d} s, under ${floors[item.role]}`);
      assert.ok(d <= maxes[item.role], `${f.id} ${item.label} (${item.role}) is ${d} s, over ${maxes[item.role]}`);
      checked += 1;
    }
  }
  /* A loop that silently iterates nothing is the failure this guards against.
     Derived rather than the old literal 64 (32 + 10 + 22), which had to be
     edited every time any Foray changed length — the #236 defect in miniature. */
  const expected = curated.reduce((n, f) => n + segmentItems(f).length, 0);
  assert.ok(expected > 0, "no Foray plays a segment, so this loop proved nothing");
  assert.equal(checked, expected, "every played segment of every Foray must be checked");
});

test("the Forays' own copy obeys the shared copy rules", () => {
  // Applied directly against the same BANNED list backend/test/copyRules.test.ts
  // uses, rather than filtered out of an error array another test already
  // asserts is empty. Publisher episode titles are quoted fact and are
  // deliberately not gated; what is gated is what we wrote. Every Foray, not
  // just #1: the copy rules are not about one Foray.
  let checked = 0;
  for (const f of live.forays.forays) {
    for (const text of [f.title, f.summary, ...f.slots.map((s) => s.title)]) {
      assert.ok(text, `${f.id}: a copy field is empty`);
      assert.ok(wordCount(text) <= MAX_WHY_LINE_WORDS, `${f.id}: ${wordCount(text)} words: "${text}"`);
      for (const rx of BANNED) assert.doesNotMatch(text, rx, `${f.id}: banned ${rx} in "${text}"`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no copy fields were checked");
});

test("every Foray's `topic` is a real taxonomy node", () => {
  const nodes = new Set(live.taxonomy.nodes.map((n) => n.id));
  assert.ok(nodes.size > 0, "the taxonomy is empty, so this proved nothing");
  for (const f of live.forays.forays) assert.ok(nodes.has(f.topic), `${f.id}: ${f.topic}`);
});

/* ------------------------------------------------------- the source registry */

test("every registered source is reported, and every Foray's episodes are registered", () => {
  assert.equal(checkForays(live).report.sources, live.sources.sources.length);
  const registered = new Set(live.sources.sources.map((s) => s.id));
  for (const f of live.forays.forays) {
    for (const i of segmentItems(f)) {
      const seg = live.segments.segments.find((s) => s.id === i.segment_id);
      assert.ok(registered.has(seg.item_id), `${f.id}: ${seg.item_id} is not registered`);
    }
  }
});

test("every item_id in the segment pool resolves to a source", () => {
  const registered = new Set(live.sources.sources.map((s) => s.id));
  for (const s of live.segments.segments) {
    assert.ok(registered.has(s.item_id), `${s.item_id} has no source entry`);
  }
});

test("the registry and the pool name exactly the same episodes", () => {
  /* Was a hardcoded list of the 18 source ids the curation docs name. That list
     was a third place to edit every time an episode was added, and it is the
     #236 defect again: a registry entry is not curation, but the test made it
     cost a test edit. Stated as a set identity instead, which is what the list
     was approximating — a rogue registry entry (a source nothing plays) and a
     rogue pool episode (tape nothing can resolve) both fail here, and a new
     episode lands without touching this file. */
  const registered = [...new Set(live.sources.sources.map((s) => s.id))].sort();
  const inPool = [...new Set(live.segments.segments.map((s) => s.item_id))].sort();
  assert.ok(registered.length > 0, "no sources are registered, so this proved nothing");
  assert.deepEqual(registered, inPool);
});

test("every source has the four fields a player needs", () => {
  for (const s of live.sources.sources) {
    for (const f of ["show", "title", "audio_url"]) assert.ok(s[f], `${s.id} missing ${f}`);
    assert.ok(s.duration_sec > 0, `${s.id} missing duration_sec`);
  }
});

test("every audio_url is https and free of tokens (ci.yml invariant 4, re-asserted)", () => {
  for (const s of live.sources.sources) {
    assert.match(s.audio_url, /^https:\/\//, s.id);
    assert.doesNotMatch(s.audio_url, /[?&](token|auth|api_?key|secret|password|session)=/i, s.id);
  }
});

test("every source carries a boolean dai_suspected (ci.yml invariant 5)", () => {
  for (const s of live.sources.sources) assert.equal(typeof s.dai_suspected, "boolean", s.id);
});

test("every segment on a DAI-suspected source carries both content anchors (#65, F-74)", () => {
  /* Was "no source is DAI-suspected". Since #571 rule #65 admits a dai_suspected source
     when the segment carries a start/end anchor pair (ADR-0007 content anchors are what
     make the out-point findable in a re-stitched copy); a timestamp-only segment on such
     a source is still refused. The first generated Foray (PR #583) is the first committed
     data to exercise this: ten Practical AI segments, a DAI-flagged host measured ad-free. */
  let daiSegments = 0;
  for (const s of live.sources.sources) {
    if (s.dai_suspected !== true) continue;
    for (const seg of live.segments.segments.filter((x) => x.item_id === s.id)) {
      daiSegments += 1;
      assert.ok(typeof seg.start_anchor === "string" && seg.start_anchor.trim(), `${seg.id}: no start_anchor on a dai_suspected source`);
      assert.ok(typeof seg.end_anchor === "string" && seg.end_anchor.trim(), `${seg.id}: no end_anchor on a dai_suspected source`);
    }
  }
  assert.ok(daiSegments > 0, "the rule is exercised by at least one committed segment");
});

test("each source's feed duration matches its segments' reference_duration_sec", () => {
  for (const s of live.sources.sources) {
    for (const seg of live.segments.segments.filter((x) => x.item_id === s.id)) {
      assert.ok(
        Math.abs(seg.reference_duration_sec - s.duration_sec) <= 2,
        `${s.id}: feed ${s.duration_sec} vs pool ${seg.reference_duration_sec}`
      );
    }
  }
});

test("no segment runs past the end of its episode", () => {
  for (const seg of live.segments.segments) {
    const src = live.sources.sources.find((s) => s.id === seg.item_id);
    assert.ok(seg.end_sec <= src.duration_sec + 2, `${seg.id} ends at ${seg.end_sec}`);
  }
});

test("D5's pair clause is reported on every committed Foray and gates none of them (Q-04, F-102)", () => {
  /* THE RULING `check-forays.mjs` RECORDS (F-102, 2026-09-12). "No two
     consecutive clips within 20 % of the same length" was an ERROR for one day,
     on a Foray whose tape was cut under Q-01. Q-01 and Q-04 are two cards of
     one series that moved the same quantity in opposite directions — a clip
     runs as long as the tape stays relevant; two clips in a row must not be the
     same length — and a gate can only settle that by shortening a clip or
     refusing its tape, both of which make the Foray play LESS. So the clause is
     a COUNT now: every pair is a warning on every Foray, the report carries
     `d5_uniform_pairs` and `d5_iqr_sec`, and no verdict turns on either.

     MUTATION THAT KILLS THIS: restore the gate — `if (cutUnderQ01) E(...)` in
     the D5 block — and every generated Foray whose rows carry `boundary` goes
     red here on `no D5 line is ever an error`. Ran it — red.

     WHAT IT USED TO ASSERT, kept because the numbers are the baseline: each of
     the eight committed Forays holds one to four adjacent pairs inside the band
     (measured 2026-09-12: 3 / 1 / 2 / 4 hand-cut, 1 / 3 / 1 / 3 generated), and
     every one of them is counted. */
  const { warnings, errors, report } = checkForays(live);
  let reported = 0;
  for (const f of live.forays.forays) {
    const durs = segmentItems(f).map((i) => durationOf(live, i.segment_id));
    const pairs = d5UniformPairs(durs).length;
    const r = report.forays.find((x) => x.id === f.id);
    assert.equal(r.d5_uniform_pairs, pairs, `${f.id}: the report counts ${r.d5_uniform_pairs} pairs and the durations hold ${pairs}`);
    assert.equal(r.d5_gated, undefined, `${f.id}: the regime flag went with the regime (F-102)`);
    assert.equal(d5WarningsFor(warnings, f.id).length, pairs, `${f.id}: its ${pairs} pair(s) are each reported once`);
    reported += pairs;
  }
  assert.equal(warnings.filter((w) => /D5 \(reported, not gated/.test(w)).length, reported, "every pair is reported as a warning, and nothing else is");
  assert.deepEqual(errors.filter((e) => /^D5/.test(e.replace(/^foray "[^"]*": /, ""))), [], "no D5 line is ever an error");
  assert.ok(reported > 0, "the committed Forays hold uniform pairs today, or this test proves nothing about reporting");
});

/* ============================================================================
   2. THE HELPERS, on their own — no data at all
   ========================================================================= */

test("d1Budget follows the 45 / 120 minute bands", () => {
  assert.equal(d1Budget(30 * 60), 8);
  assert.equal(d1Budget(45 * 60), 8);
  assert.equal(d1Budget(45 * 60 + 1), 6);
  assert.equal(d1Budget(120 * 60), 6);
  assert.equal(d1Budget(120 * 60 + 1), 5);
});

test("maxStartsInWindow counts starts, not gaps", () => {
  // Five starts 100 s apart span 400 s; all five sit inside one 600 s window.
  assert.equal(maxStartsInWindow([0, 100, 200, 300, 400]).count, 5);
  // Two starts 600 s apart do not: the window is half-open.
  assert.equal(maxStartsInWindow([0, 600]).count, 1);
});

test("d5UniformPairs fires only when max/min <= 1.2, whichever order the pair comes in", () => {
  assert.equal(d5UniformPairs([100, 119]).length, 1);
  assert.equal(d5UniformPairs([100, 121]).length, 0);
  assert.equal(d5UniformPairs([121, 100]).length, 0, "order within the pair must not matter");
  assert.equal(d5UniformPairs([100, 120]).length, 1, "exactly 1.2 is not over the tolerance, so it is uniform");
  /* Run 8's sixteen durations: three adjacent pairs and — the difference
     between this clause and the triple it replaced — not one uniform triple. */
  const run8 = [167.3, 69.7, 65.6, 116.7, 113.8, 174.2, 98.3, 152.1, 90.7, 176.7, 158.3, 31.9, 170.5, 130.9, 162.8, 78.0];
  assert.deepEqual(d5UniformPairs(run8).map((h) => h.index), [1, 3, 9]);
});

test("iqr uses R-7 linear interpolation", () => {
  assert.equal(iqr([1, 2, 3, 4]), 1.5); // q75 3.25, q25 1.75
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
});

/* ============================================================================
   3. THE BOUNDARY FIXTURE — the control, then the #182 acceptance proofs
   ========================================================================= */

test("the boundary fixture itself passes with zero errors", () => {
  /* THE CONTROL, and the most important test in this section. Every proof below
     mutates this fixture and asserts a specific failure; if the fixture stopped
     passing on its own, all of them would be proving that broken data is
     broken. */
  const { errors } = checkForays(fixture);
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("the CLI exits 0 on the committed fixture, so --root reaches it unchanged", () => {
  // The fixture is a real four-file checkout, not an in-memory object graph:
  // the shipped CLI can be pointed at it, which is what makes the red-CI proofs
  // below runs of the real thing rather than of a test-only construction.
  const out = execFileSync(process.execPath, [CLI, "--root", FIXTURE_ROOT], { encoding: "utf8" });
  assert.match(out, /forays ok/);
  assert.match(out, /boundary-1 \(draft\)/);
});

test("the boundary fixture shares no ids with the live data", () => {
  /* The two data sets have to stay independent in BOTH directions. A fixture id
     appearing in `data/` would ship a synthetic Foray to a listener; a live id
     appearing in the fixture would put a proof back on curation, which is the
     defect #236 exists to remove. Ids are the only handle either side has on the
     other, so this is the whole seam.

     The fixture also lives under `tools/`, which is what keeps it out of the
     shipped site: `tools/mobile/prepare-webdir.mjs` and the service worker copy
     `data/` by name. */
  const liveIds = new Set([
    ...live.forays.forays.map((f) => f.id),
    ...live.segments.segments.map((s) => s.id),
    ...live.sources.sources.map((s) => s.id),
  ]);
  const fixtureIds = [
    ...fixture.forays.forays.map((f) => f.id),
    ...fixture.segments.segments.map((s) => s.id),
    ...fixture.sources.sources.map((s) => s.id),
  ];
  assert.ok(fixtureIds.length > 0, "the fixture loaded empty, so this proved nothing");
  assert.deepEqual(fixtureIds.filter((id) => liveIds.has(id)), []);
  assert.ok(FIXTURE_ROOT.startsWith(path.join(REPO_ROOT, "tools") + path.sep), FIXTURE_ROOT);
});

test("the fixture holds one segment back, and nothing in its running order plays it", () => {
  /* `boundary-ep-held#150` exists so "put back a segment that was cut to fit the
     budget" is an edit a curator really makes rather than one this file invents.
     If anyone ever tidies the fixture by playing it, the D1 reinstatement proof
     below stops being a D1 proof and becomes a duplicate-segment proof — green,
     and about nothing. */
  const used = new Set(segmentItems(boundary(fixture)).map((i) => i.segment_id));
  const held = fixture.segments.segments.filter((s) => !used.has(s.id));
  assert.deepEqual(held.map((s) => s.id), ["boundary-ep-held#150"]);
  assert.equal(held[0].end_sec - held[0].start_sec, 120, "the 120 s is load-bearing — see the fixture README");
});

test("the fixture's numbers are the ones its README derives", () => {
  /* Literals on purpose, and the one place in this file where that is right:
     the fixture is committed data whose whole job is to hold these values, and
     tools/foray/fixtures/README.md derives every one of them from the
     [72, 148, 84, 168, 65, 88] period. A change to the fixture that was meant to
     be cosmetic fails here. */
  const r = checkForays(fixture).report.forays.find((x) => x.id === "boundary-1");
  assert.equal(r.segments, 30);
  assert.equal(r.runtime_sec, 3121, "5 x 625 s of period, less the one 168 -> 164 cut");
  assert.equal(r.tape_runtime_sec, 3121, "no narration is authored in the fixture");
  assert.equal(r.mean_sec, 104, "3121 / 30 — reported; D3's floor was retired by Q-04");
  assert.equal(r.d1_budget, 6, "52.0 min falls in §5c's 45-120 minute band");
  assert.equal(r.d5_iqr_sec, 76, "quartiles land on 72 s and 148 s");
  assert.equal(r.d5_uniform_pairs, 0, "the period alternates, so no two neighbours are inside D5's band");
});

/* ------------------------------------------------------------------- D1 */

test("D1 passes on the fixture with the budget exactly met", () => {
  /* THE FIRST #182 ACCEPTANCE PROPERTY. "Exactly met" is what every proof after
     this one leans on: with no headroom, a mutation that adds a start or moves
     a long segment out of a window has nowhere to hide.

     Mutation that kills it: raise any one duration in the fixture, or widen
     `d1Budget`'s first band past 52 minutes. Either way the budget stops being
     met exactly and the D1-only and D5-only isolations below stop isolating. */
  const r = checkForays(fixture).report.forays.find((x) => x.id === "boundary-1");
  assert.equal(r.d1_budget, 6);
  assert.equal(r.d1_max_starts_in_window, 6, "met exactly — no headroom");
});

test("the fixture's tightest seven-start span is 621.0 s, which is why D1 reads 6", () => {
  /* THE SECOND ACCEPTANCE PROPERTY, and the starts-versus-gaps distinction the
     grilling doc got wrong: a "run of six" counts six GAPS, which is bounded by
     SEVEN starts. 621 s is the span of the six windows containing the one 168 s
     segment cut to 164 s; every other seven-start span is 625 s.

     Both halves matter. 621 > 600 is why no window holds a seventh start, and
     621 - 600 = 21 s is the entire slack the D5-only swap below has to fit
     inside. Mutation: `maxStartsInWindow`'s `< windowSec` to `<=` leaves this
     assertion green and turns the one above red, which is the pair working. */
  const items = segmentItems(boundary(fixture));
  const starts = [];
  let t = 0;
  for (const i of items) { starts.push(t); t += durationOf(fixture, i.segment_id); }
  let tightest = Infinity;
  for (let i = 0; i + 6 < starts.length; i++) tightest = Math.min(tightest, starts[i + 6] - starts[i]);
  assert.equal(Math.round(tightest * 10) / 10, 621);
  assert.ok(tightest > D1_WINDOW_SEC, "a seven-start span inside the window would be a D1 failure");
  assert.ok(tightest - D1_WINDOW_SEC < 25, "the whole point of the fixture is that the margin is thin");
});

test("the fixture's D1 slack is 21 s, which is what the D5-only swap fits inside", () => {
  /* The arithmetic that joins the two acceptance proofs, asserted rather than
     left in prose: the tightest seven-start span is 621 s, so a window can lose
     21 s before it holds a seventh start, and the A-1 <-> F-1 swap moves 16 s of
     duration across the order.

     Mutation: narrow the gap — cut the 164 s segment to 160 s, say — and the
     swap starts tripping D1 as well. The isolation search below then finds zero
     isolating swaps and fails, rather than quietly retargeting onto a different
     swap. These two tests hold each other up. */
  const durations = segmentItems(boundary(fixture)).map((i) => durationOf(fixture, i.segment_id));
  const starts = [];
  let t = 0;
  for (const d of durations) { starts.push(t); t += d; }
  let tightest = Infinity;
  for (let i = 0; i + 6 < starts.length; i++) tightest = Math.min(tightest, starts[i + 6] - starts[i]);
  const slack = tightest - D1_WINDOW_SEC;
  assert.equal(slack, 21, "D1's slack");
  const moved = Math.abs(
    durationOf(fixture, itemAt(fixture, "A-1").segment_id) - durationOf(fixture, itemAt(fixture, "F-1").segment_id)
  );
  assert.equal(moved, 16, "what A-1 <-> F-1 moves");
  assert.ok(moved < slack, "the swap has to fit inside the slack, or it is a D1 proof as well as a D5 one");
});

test("D1 FAILS when the held-back segment is put back", () => {
  /* THE THIRD ACCEPTANCE PROPERTY: the sharpest possible D1 test, because it is
     an edit a curator really makes — putting back a segment that was cut to fit
     the budget. `boundary-ep-held#150` goes into the first slot at the one index
     where the five following durations are the period's tightest five-run
     (457 s), so 457 + 120 = 577 s holds seven starts against a budget of 6.

     THE ONLY error this produces is D1, and that is asserted rather than
     believed: the duration is a legal `explanation`, the episode is 3.2 % of the
     Foray, it is the only segment of its episode so M3 is trivial, and its new
     neighbouring triples are 2.0, 2.6 and 1.8 — all clear of D5. */
  const errors = errorsFor(putHeldBack(fx()));
  assert.equal(errors.length, 1, `expected D1 alone, got:\n${errors.join("\n")}`);
  assert.match(errors[0], /D1 FAIL: 7 segment starts inside a 600 s window \(budget 6/);
});

test("the CLI exits 1 on a D1-breaking order (the red-CI proof)", () => {
  const { status, stderr } = runCli(mutatedCheckout(putHeldBack));
  assert.equal(status, 1, "the CLI must exit non-zero");
  assert.match(stderr, /D1 FAIL/);
  assert.doesNotMatch(stderr, /D5 FAIL/, "this mutation must isolate D1");
});

test("D1 FAILS on a pathological shortest-first order", () => {
  // Shortest-first packs the most starts into every window. Unlike the
  // reinstatement case this trips D5 and M3 as well, which is the point: a Foray
  // can fail several tier-A rules at once and all of them must be reported, not
  // the first one found.
  const f = fx();
  boundary(f).items.sort((a, b) => durationOf(f, a.segment_id) - durationOf(f, b.segment_id));
  const kinds = new Set(errorsFor(f).map((e) => e.match(/(D\d|M\d) FAIL/)?.[0]).filter(Boolean));
  assert.ok(kinds.has("D1 FAIL"), [...kinds].join(", "));
  /* D5's pair clause is reported, never gated (Q-04, F-102) — shortest-first
     still makes uniform pairs, and they still surface as warnings. */
  assert.ok(!kinds.has("D5 FAIL"), [...kinds].join(", "));
  assert.ok(checkForays(f).warnings.some((w) => /D5 \(reported, not gated/.test(w)), "shortest-first must still surface D5's pairs");
  assert.ok(kinds.has("M3 FAIL"), [...kinds].join(", "));
});

/* ------------------------------------------------------------------- D5 */

/** The fixture as a Q-01 Foray, IN PLACE: generated, the disclosure spliced in
    first, and every pool row stamped with the `boundary` the tier-2 mint
    writes — which is what puts a Foray under the Q-04 length regime. The
    in-place shape is what `mutatedCheckout` needs. */
function stampQ01(f, boundaryKind = "sentence") {
  const foray = boundary(f);
  foray.generated = true;
  const firstSlot = Array.isArray(foray.slots) && foray.slots.length ? foray.slots[0].id : undefined;
  foray.items.unshift({
    type: "narration", id: "disclosure", mode: "marker", script: DISCLOSURE_SCRIPT,
    ...(firstSlot !== undefined ? { slot: firstSlot } : {}),
  });
  if (typeof foray.runtime_sec === "number") {
    foray.runtime_sec = +(foray.runtime_sec + Math.round((DISCLOSURE_SCRIPT.length / 17) * 1000) / 1000).toFixed(2);
  }
  for (const s of f.segments.segments) {
    s.boundary = boundaryKind;
    s.extended_by_sec = 0;
  }
  return f;
}

/** Puts the fixture's first two played clips within 10 % of each other, in
    place: the FIRST is lengthened to a tenth under the second (72 -> 134.5 s
    beside B-1's 148 s), which spreads the later starts out rather than packing
    them (the fixture sits exactly on D1's budget) and touches no other
    neighbour (148 / 84 stays outside the band). The two items lose their
    `role` so L3's per-role ceiling does not fire on the longer quote. The
    fixture never plays two neighbours inside the band by design, so this is
    the one edit that makes exactly one pair. */
function pairUp(f) {
  const items = segmentItems(boundary(f)).slice(0, 2);
  const [a, b] = items.map((i) => f.segments.segments.find((s) => s.id === i.segment_id));
  a.end_sec = +(a.start_sec + (b.end_sec - b.start_sec) / 1.1).toFixed(3);
  for (const i of items) delete i.role;
  delete boundary(f).runtime_sec;
  return f;
}

/** Nine copies of one duration, in place: every adjacent pair identical. */
function nineOfAKind(f) {
  const one = f.segments.segments[0];
  f.segments.segments = Array.from({ length: 9 }, (_, i) => ({ ...one, id: `x#${i}`, item_id: "x" }));
  f.sources.sources = [{ ...f.sources.sources[0], id: "x", duration_sec: one.reference_duration_sec }];
  boundary(f).items = f.segments.segments.map((s, i) => ({ type: "segment", label: `X-${i}`, segment_id: s.id, role: "explanation" }));
  boundary(f).label_prefixes = { X: "x" };
  delete boundary(f).runtime_sec;
  delete boundary(f).slots;
  return f;
}

test("D5 reports no pair on the fixture: the period alternates", () => {
  const r = checkForays(fixture).report.forays.find((x) => x.id === "boundary-1");
  assert.equal(r.d5_uniform_pairs, 0, "72 / 148 / 84 / 168 / 65 / 88 never puts two neighbours inside the band");
});

test("D5 WARNS on a uniform pair and never fails — whatever the tape was cut under (F-102)", () => {
  /* The same edit — the second clip stretched to 1.1x the first — on the plain
     fixture and on the same fixture stamped as Q-01 tape. One warning and no
     error, BOTH TIMES. Q-01's stamp used to be what turned the warning into a
     build failure, and the only cure for that failure at placement was to play
     less tape (F-102); the stamp is inert here now, which is the whole of the
     fix on this side.

     MUTATION THAT KILLS THIS: put the regime back — restore `const cutUnderQ01 =
     isGeneratedForay(foray) && played.some((p) => p.seg.boundary !== undefined)`
     and `if (cutUnderQ01) E(...)` in the D5 block — and the Q-01 half goes red
     on both the error list and the warning count. Ran it — red on both. */
  for (const [what, f] of [
    ["tape cut before Q-01", pairUp(fx())],
    ["tape cut under Q-01", pairUp(stampQ01(fx()))]
  ]) {
    const errs = errorsFor(f);
    assert.deepEqual(errs.filter((e) => /D5/.test(e)), [], `${what}: ${errs.join(" | ")}`);
    const warned = checkForays(f).warnings.filter((w) => /D5 \(reported, not gated/.test(w));
    assert.equal(warned.length, 1, `${what}: ${warned.join(" | ")}`);
    assert.match(warned[0], /A-1 \/ B-1 are 134\.5 \/ 148\.0 s — two consecutive clips within \+\/-20 % of the same length \(max\/min 1\.100\)/);
    assert.equal(checkForays(f).report.forays.find((x) => x.id === "boundary-1").d5_uniform_pairs, 1, `${what}: the pair is counted`);
  }
});

test("a `boundary` outside the accepted three, or a negative `extended_by_sec`, is rejected on the row", () => {
  /* G-21c: the two Q-01 fields are enumerated (`segment.boundary`) and
     validated where present, and absent on every row minted before Q-01. */
  const f = stampQ01(fx(), "paragraph");
  assert.match(errorsFor(f).join("\n"), /has boundary "paragraph"; expected one of turn, sentence, claim-only/);
  const g = stampQ01(fx());
  g.segments.segments[0].extended_by_sec = -5;
  assert.match(errorsFor(g).join("\n"), /has extended_by_sec -5; expected a non-negative number/);
  assert.deepEqual(errorsFor(stampQ01(fx(), "turn")), [], "a well-formed Q-01 Foray passes clean");
});

test("the CLI exits 0 on a uniform pair in a Q-01 Foray — a variety count is not a build failure (F-102)", () => {
  /* The green-CI proof, and the exact inverse of the assertion that stood here
     for a day ("exits 1 on a Q-01 Foray with a uniform pair"). A run that
     places two adjacent clips of near-equal length has produced a publishable
     Foray; what it must not do is play less tape to avoid saying so.

     MUTATION THAT KILLS THIS: restore the gate in the D5 block — the Q-01
     checkout exits 1. Ran it — red. */
  for (const mutate of [(f) => pairUp(stampQ01(f)), (f) => pairUp(f)]) {
    const run = runCli(mutatedCheckout(mutate));
    assert.equal(run.status, 0, run.stderr);
  }
});

test("D5's IQR is still reported at 76.0 s on the fixture, and neither clause is gated (Q-04, F-102)", () => {
  const durs = segmentItems(boundary(fixture)).map((i) => durationOf(fixture, i.segment_id));
  assert.equal(iqr(durs), 76);
  assert.equal(checkForays(fixture).report.forays.find((x) => x.id === "boundary-1").d5_iqr_sec, 76);
  /* Nine copies of one duration: an IQR of 0, which used to fail the 45 s
     floor, and eight identical adjacent pairs — the most metronomic Foray this
     fixture can express. Eight warnings, no error, on pre-Q-01 tape and on a
     Q-01 Foray alike (F-102). It publishes, and the eight-line count plus the
     zero IQR are how the report says what it sounds like. */
  for (const f of [nineOfAKind(fx()), stampQ01(nineOfAKind(fx()))]) {
    assert.deepEqual(errorsFor(f).filter((e) => /D5|interquartile/.test(e)), []);
    assert.equal(checkForays(f).warnings.filter((w) => /D5 \(reported/.test(w)).length, 8);
    assert.equal(checkForays(f).report.forays.find((x) => x.id === "boundary-1").d5_uniform_pairs, 8);
    assert.equal(checkForays(f).report.forays.find((x) => x.id === "boundary-1").d5_iqr_sec, 0);
  }
});

/* ------------------------------------------------------------- M4 (§6c) */

test("M4 passes on the fixture with room, and FAILS when one episode takes over 25 %", () => {
  /* §6c's concentration cap: "<= 25 % of a Foray's segments and <= 25 % of its
     runtime from any single `item_id`. Past that we have made an edit of one
     episode and called it a Foray."

     The fixture's six episodes are assigned by a Latin square over the period,
     so each is 5 of 30 segments and at most 17.9 % of the tape — comfortably
     inside the cap, and comfortably OUTSIDE it once the Foray is cut down to
     two episodes. Both directions are asserted, because a cap only proven in the
     failing direction is a cap that could be off by any margin. */
  const passing = checkForays(fixture).report.forays.find((x) => x.id === "boundary-1");
  assert.equal(passing.segments, 30);
  const shares = new Map();
  for (const item of segmentItems(boundary(fixture))) {
    const seg = fixture.segments.segments.find((s) => s.id === item.segment_id);
    const e = shares.get(seg.item_id) ?? { n: 0, sec: 0 };
    e.n += 1; e.sec += seg.end_sec - seg.start_sec;
    shares.set(seg.item_id, e);
  }
  assert.equal(shares.size, 6, "six episodes, one per period position");
  for (const [id, e] of shares) {
    assert.ok(e.n / 30 <= M4_SHARE_MAX, `${id} is ${e.n}/30 of the segments`);
    assert.ok(e.sec / passing.tape_runtime_sec <= M4_SHARE_MAX, `${id} is ${e.sec} s of the tape`);
  }

  // Two episodes only: 50 % of the segments each, so both fail.
  const f = fx();
  boundary(f).items = boundary(f).items.filter((i) => /^[AB]-/.test(i.label));
  delete boundary(f).runtime_sec;
  delete boundary(f).slots;
  for (const i of boundary(f).items) delete i.slot;
  /* Both clauses that can see it fire: each episode is 50 % of the segments,
     and each one's tape beyond its longest clip is around half the runtime
     (Q-04's restatement of the runtime clause). Four lines, two per episode. */
  const m4 = errorsFor(f).filter((e) => /M4 FAIL/.test(e));
  assert.equal(m4.filter((e) => /of segments/.test(e)).length, 2, m4.join("\n"));
  assert.equal(m4.filter((e) => /beyond its longest clip/.test(e)).length, 2, m4.join("\n"));
  assert.match(m4[0], /is 50\.0 % of segments/);
});

/* ---- M4, restated for clips of a minute to half an hour (Q-04) --------- */

/** A draft Foray built from `[episode, seconds]` clips in play order — the
    shape M4's two Q-04 clauses are asked about. Starts step by 100 s so M3's
    order holds within an episode. */
function builtForayByEpisode(clips, { forayId = "built-m4" } = {}) {
  const f = fx();
  const items = [];
  const seen = new Set();
  let n = 0;
  for (const [ep, sec] of clips) {
    const eid = `${forayId}-${ep}`;
    if (!seen.has(eid)) {
      seen.add(eid);
      f.sources.sources.push({
        id: eid, show: "Built Show", title: `Built episode ${ep}`,
        audio_url: `https://cdn.example/${eid}.mp3`, audio_type: "audio/mpeg",
        duration_sec: 7200, dai_suspected: false,
      });
    }
    const sid = `${eid}#${n * 100}`;
    f.segments.segments.push({ id: sid, item_id: eid, start_sec: n * 100, end_sec: n * 100 + sec, reference_duration_sec: 7200 });
    items.push({ type: "segment", slot: "one", segment_id: sid });
    n++;
  }
  f.forays.forays.push({
    id: forayId, kind: "deep-dive", status: "draft", topic: boundary(fixture).topic,
    title: "A built Foray", summary: "A built Foray",
    slots: [{ id: "one", title: "One" }], items,
  });
  return f;
}
const m4ErrorsIn = (f, forayId = "built-m4") => errorsFor(f).filter((e) => e.includes(`foray "${forayId}"`) && e.includes("M4 FAIL"));

test("M4 lets a single let-it-ride clip through whatever share of the tape it is (Q-04)", () => {
  /* THE FOUNDER'S CASE. A 1,500 s clip beside four of 100 / 125 s is 77 % of
     the tape and 20 % of the segments. Under the plain runtime share it failed
     by construction; the restated clause measures an episode's tape BEYOND its
     longest clip, which for a single clip is zero. Mutation: measure the
     share on the whole episode again — this fails at 77 %. */
  assert.deepEqual(m4ErrorsIn(builtForayByEpisode([["a", 1500], ["b", 100], ["c", 125], ["d", 100], ["e", 125]])), []);
  assert.ok(1500 / 1950 > M4_SHARE_MAX, "the case has to be over the old line to prove anything");
});

test("M4 FAILS when one episode supplies two clips over M4_LONG_CLIP_SEC (Q-04)", () => {
  /* Seven other episodes at 200 / 250 s, then *a* at 500 s and again at
     350 s: 2 of 9 segments, and 350 of 2,400 s beyond the longest (14.6 %) —
     under the share cap. Only the one-long-clip clause fires, once. Mutation:
     delete the `e.long > 1` check — no error at all. */
  const m4 = m4ErrorsIn(
    builtForayByEpisode([["b", 200], ["c", 250], ["d", 200], ["e", 250], ["f", 200], ["g", 250], ["h", 200], ["a", 500], ["a", 350]])
  );
  assert.equal(m4.length, 1, m4.join("\n"));
  assert.match(m4[0], new RegExp(`supplies 2 clips over ${M4_LONG_CLIP_SEC} s`));
});

test("M4 FAILS on an episode's tape beyond its longest clip past 25 %, and passes under it (Q-04)", () => {
  /* Seven others at 60 / 75 s (465 s), then *a* at 400 s and at 300 s: the
     300 s is *a*'s tape beyond its longest clip, 25.8 % of 1,165 s. One clip
     is long, not two; 400 / 300 is outside D5's band; 2 of 9 segments. One
     error, naming the clause. At 250 s (22.4 %) there is none. */
  const seven = [["b", 60], ["c", 75], ["d", 60], ["e", 75], ["f", 60], ["g", 75], ["h", 60]];
  const over = m4ErrorsIn(builtForayByEpisode([...seven, ["a", 400], ["a", 300]]));
  assert.equal(over.length, 1, over.join("\n"));
  assert.match(over[0], /25\.8 % of tape runtime beyond its longest clip/);
  assert.deepEqual(m4ErrorsIn(builtForayByEpisode([...seven, ["a", 400], ["a", 250]])), []);
});

/* ------------------------------------------------------- D2 / D3 / D4 / L / M */

test("no segment played by the fixture passes L4's 240 s soft maximum", () => {
  // 168 s is the fixture's longest, so L4's escape hatch is never in play in the
  // passing state — which is what lets the three hatch proofs below each set up
  // exactly one over-long segment and read the result unambiguously.
  const longest = Math.max(...segmentItems(boundary(fixture)).map((i) => durationOf(fixture, i.segment_id)));
  assert.equal(longest, 168);
  assert.ok(longest <= L4_SOFT_MAX_SEC, `longest is ${longest} s`);
});

test("L2 FAILS when an `exchange` drops under its 75 s floor", () => {
  const f = fx();
  // C-5 is the fixture's only quote, at 65 s — legal as a quote (floor 30),
  // illegal as an exchange. Relabelling it is the smallest honest break.
  itemAt(f, "C-5").role = "exchange";
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /L2 FAIL: C-5 is 65\.0 s, under the 75 s floor/);
});

test("L3 FAILS when a `quote` runs past its 90 s ceiling", () => {
  const f = fx();
  itemAt(f, "D-1").role = "quote"; // 168 s
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /L3 FAIL: D-1 is 168\.0 s, over the 90 s maximum/);
});

test("L4 FAILS on a segment over 240 s with no long_reason", () => {
  const f = fx();
  const seg = segmentAt(f, "D-1");
  seg.end_sec = seg.start_sec + 250;
  delete boundary(f).runtime_sec;
  assert.match(errorsFor(f).join("\n"), /L4 FAIL: D-1/);
});

test("L4's escape hatch is reachable — needs_review + long_reason clears it", () => {
  /* The whole point of L4 is a burden-of-proof flip: past 240 s, SAY WHY.
     An escape hatch that cannot be satisfied turns it into a silent hard cap.
     `long_reason` is one of §9's proposed additive fields and
     merge-segments.mjs does not write it, so the checker also accepts it from
     the Foray item — and this test is what proves that path actually works.

     On the fixture this is a two-line setup. The version this replaced had to
     loop every Foray and count how many hatches it had applied, because the
     segment it stretched (`moreish-jerk-jamaica#266`) was played by two live
     Forays and stretching the pooled record reached both. Nothing in the fixture
     pool is shared, which is one more thing the extraction bought. */
  const f = fx();
  const seg = segmentAt(f, "D-1");
  seg.end_sec = seg.start_sec + 250;
  delete boundary(f).runtime_sec;
  const item = itemAt(f, "D-1");
  item.needs_review = true;
  item.long_reason = "One continuous three-community answer; every cut lands mid-claim.";
  assert.deepEqual(errorsFor(f).filter((e) => /L4/.test(e)), []);
});

test("L4's escape hatch needs BOTH fields, not either", () => {
  const f = fx();
  const seg = segmentAt(f, "D-1");
  seg.end_sec = seg.start_sec + 250;
  delete boundary(f).runtime_sec;
  itemAt(f, "D-1").long_reason = "reason but no flag";
  assert.match(errorsFor(f).join("\n"), /L4 FAIL: D-1/);
});

test("D2 FAILS when two sub-60 s segments are followed by a short one", () => {
  // Nothing in the fixture is under 60 s, so D2 is never exercised by the
  // passing state. Without these three tests the rule is dead code — and its
  // trailing-pair bug lived behind exactly that gap.
  const f = fx();
  const shrink = (label, sec) => {
    const s = segmentAt(f, label);
    s.end_sec = s.start_sec + sec;
    // Relabelled `quote` (floor 30) so the shrink does not also trip L2 and
    // bury the D2 error under two failures that are not what is being proved.
    itemAt(f, label).role = "quote";
  };
  shrink("F-2", 55);
  shrink("A-2", 55);
  shrink("C-3", 100); // the recovery segment, under the 150 s floor
  delete boundary(f).runtime_sec;
  const d2 = errorsFor(f).filter((e) => /D2 FAIL/.test(e));
  assert.equal(d2.length, 1, d2.join("\n"));
  assert.match(d2[0], /two consecutive segments under 60 s at F-2 are followed by 100\.0 s/);
});

test("D2 FAILS when the Foray ENDS on two sub-60 s segments", () => {
  // The trailing-pair case: a pairwise loop reaches for a recovery segment
  // that does not exist and silently passes. There is no segment left to
  // recover, which is the violation, not an exemption.
  const f = fx();
  for (const label of ["C-5", "D-5"]) {
    const s = segmentAt(f, label);
    s.end_sec = s.start_sec + 55;
    itemAt(f, label).role = "quote";
  }
  delete boundary(f).runtime_sec;
  const d2 = errorsFor(f).filter((e) => /D2 FAIL/.test(e));
  assert.equal(d2.length, 1, d2.join("\n"));
  assert.match(d2[0], /the Foray ends on two consecutive segments under 60 s \(C-5 onward\)/);
});

test("D2 reports a run of three once, not once per overlapping pair", () => {
  const f = fx();
  for (const label of ["F-2", "A-2", "C-3"]) {
    const s = segmentAt(f, label);
    s.end_sec = s.start_sec + 55;
    itemAt(f, label).role = "quote";
  }
  delete boundary(f).runtime_sec;
  const d2 = errorsFor(f).filter((e) => /D2 FAIL/.test(e));
  assert.equal(d2.length, 1, d2.join("\n"));
  assert.match(d2[0], /3 consecutive segments under 60 s starting at F-2/);
});

test("D4 FAILS on the 20 % share clause", () => {
  const f = fx();
  for (const i of boundary(f).items) i.role = "quote";
  assert.match(errorsFor(f).join("\n"), /D4 FAIL: 30\/30 segments are `quote`/);
});

test("D4 FAILS on the adjacency clause alone, under the 20 % share", () => {
  /* Three adjacent quotes out of 30 is 10 % — legal by share, illegal by
     adjacency. Without this the share clause masks the adjacency loop, and
     deleting the loop entirely left the suite green. */
  const f = fx();
  for (const label of ["F-2", "A-2", "C-3"]) itemAt(f, label).role = "quote";
  const d4 = errorsFor(f).filter((e) => /D4 FAIL/.test(e));
  assert.equal(d4.length, 1, d4.join("\n"));
  assert.match(d4[0], /3 adjacent `quote` segments/);
  assert.doesNotMatch(d4[0], /% cap/, "the share clause must not be what fired");
});

test("an out-of-enum role is rejected (L6)", () => {
  const f = fx();
  boundary(f).items[0].role = "monologue";
  assert.match(errorsFor(f).join("\n"), /is not in the L6 enum/);
});

test("M3 FAILS when two segments from one episode play out of order", () => {
  const f = fx();
  const items = boundary(f).items;
  const a = items.findIndex((i) => i.label === "A-1");
  const b = items.findIndex((i) => i.label === "A-2");
  [items[a], items[b]] = [items[b], items[a]];
  assert.match(errorsFor(f).join("\n"), /M3 FAIL: A-1 plays at 200 s of "boundary-ep-a"/);
});

test("slots are contiguous blocks in the order `slots` declares", () => {
  const f = fx();
  const items = boundary(f).items;
  [items[0], items[items.length - 1]] = [items[items.length - 1], items[0]];
  assert.match(errorsFor(f).join("\n"), /slots are interleaved|slot blocks play as/);
});

test("an item in an undeclared slot is rejected", () => {
  const f = fx();
  boundary(f).items[0].slot = "no-such-slot";
  assert.match(errorsFor(f).join("\n"), /is not declared in `slots`/);
});

test("a label pointing at the wrong episode is rejected", () => {
  const f = fx();
  itemAt(f, "A-1").segment_id = itemAt(f, "B-1").segment_id;
  assert.match(errorsFor(f).join("\n"), /label "A-1" maps to episode/);
});

test("a segment id that is not in the pool is rejected", () => {
  const f = fx();
  boundary(f).items[0].segment_id = "not-a-real-episode#1";
  assert.match(errorsFor(f).join("\n"), /unknown segment_id/);
});

test("the same segment twice in one Foray is rejected", () => {
  const f = fx();
  boundary(f).items[5].segment_id = boundary(f).items[4].segment_id;
  assert.match(errorsFor(f).join("\n"), /appears twice/);
});

test("a stated runtime that drifts from the items is rejected", () => {
  const f = fx();
  boundary(f).runtime_sec = 3600;
  assert.match(errorsFor(f).join("\n"), /runtime_sec` says/);
});

test("a tokened audio_url is rejected as a secret leak", () => {
  const f = fx();
  f.sources.sources[0].audio_url = "https://cdn.example.com/a.mp3?token=abc123";
  assert.match(errorsFor(f).join("\n"), /tokened/);
});

test("a non-https audio_url is rejected", () => {
  const f = fx();
  f.sources.sources[0].audio_url = "http://cdn.example.com/a.mp3";
  assert.match(errorsFor(f).join("\n"), /must be https/);
});

test("a missing dai_suspected is rejected", () => {
  const f = fx();
  delete f.sources.sources[0].dai_suspected;
  assert.match(errorsFor(f).join("\n"), /dai_suspected` must be a boolean/);
});

/* #65 §2, AND THE ONE THING THAT NOW SATISFIES IT (F-74).
 *
 * The fixture's pool carries timestamps and no anchors, which is precisely the
 * segment the rule was written about, so the first case below is unchanged. The
 * second is the rule change: ADR-0007's content anchors are how a boundary is
 * located in a differently-stitched copy, so a segment that carries both of them
 * IS anchored and the flag stops deciding for it. The pair is asserted in both
 * directions on the SAME mutation, so neither branch can be satisfied by the
 * fixture happening to pass or fail for another reason. */
test("a dai_suspected source cannot carry a timestamp-only played segment (#65 §2)", () => {
  const f = fx();
  f.sources.sources.find((s) => s.id === "boundary-ep-a").dai_suspected = true;
  assert.match(errorsFor(f).join("\n"), /cannot be anchored/);
});

test("a dai_suspected source CAN carry a played segment that quotes both boundary anchors (#65, F-74)", () => {
  const f = fx();
  f.sources.sources.find((s) => s.id === "boundary-ep-a").dai_suspected = true;
  /* Every segment of that episode, not just the first: the rule is asked per
     played item, so one un-anchored row would keep the error alive and make the
     assertion below prove nothing. */
  for (const s of f.segments.segments) {
    if (s.item_id !== "boundary-ep-a") continue;
    s.start_anchor = "so the walkway hangers were doubled up";
    s.end_anchor = "and that is the load path nobody recalculated";
  }
  const errors = errorsFor(f);
  assert.deepEqual(
    errors.filter((e) => /cannot be anchored/.test(e)),
    []
  );
  /* And the whole fixture still passes, so this is an accepted Foray rather
     than one whose #65 error was traded for a different error. */
  assert.deepEqual(errors, []);
});

test("one anchor is not a boundary: an anchored in-point with no out-point is still refused (#65, F-74)", () => {
  const f = fx();
  f.sources.sources.find((s) => s.id === "boundary-ep-a").dai_suspected = true;
  for (const s of f.segments.segments) {
    if (s.item_id !== "boundary-ep-a") continue;
    s.start_anchor = "so the walkway hangers were doubled up";
    s.end_anchor = "   ";
  }
  assert.match(errorsFor(f).join("\n"), /cannot be anchored/);
});

test("a segment whose item_id has no source is rejected", () => {
  const f = fx();
  f.sources.sources = f.sources.sources.filter((s) => s.id !== "boundary-ep-a");
  assert.match(errorsFor(f).join("\n"), /nothing can resolve its audio/);
});

test("a source duration that disagrees with the pool is rejected", () => {
  const f = fx();
  f.sources.sources[0].duration_sec += 60;
  assert.match(errorsFor(f).join("\n"), /wrong episode registered/);
});

test("a banned phrase in the summary is rejected", () => {
  const f = fx();
  boundary(f).summary = "A fascinating tour of fire.";
  assert.match(errorsFor(f).join("\n"), /banned phrase/);
});

test("an over-long slot title is rejected", () => {
  const f = fx();
  boundary(f).slots[0].title = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";
  assert.match(errorsFor(f).join("\n"), /over the 18-word limit/);
});

test("`topic` must resolve to a taxonomy node", () => {
  const f = fx();
  boundary(f).topic = "food/not-a-node";
  assert.match(errorsFor(f).join("\n"), /is not a data\/taxonomy\.json node/);
});

test("an unknown item type is rejected", () => {
  const f = fx();
  boundary(f).items.splice(1, 0, { type: "advert", id: "no" });
  assert.match(errorsFor(f).join("\n"), /unknown item type/);
});

test("`kind` must be deep-dive", () => {
  const f = fx();
  boundary(f).kind = "ladder";
  assert.match(errorsFor(f).join("\n"), /`kind` must be "deep-dive"/);
});

test("two Forays may not share an id", () => {
  const f = fx();
  f.forays.forays.push(structuredClone(boundary(f)));
  assert.match(errorsFor(f).join("\n"), /duplicate foray id/);
});

/* ============================================================================
   4. NARRATION — also on the fixture, for the same reason (#236)
   ========================================================================= */

/** The fixture's own runtime with no narration, so the assertions below can say
    "unchanged" and mean it. Read from the report rather than restated. */
const FIXTURE_RUNTIME = checkForays(fixture).report.forays.find((x) => x.id === "boundary-1").runtime_sec;

/** A well-formed bridge: an id, a length something can read, and an asset — with
    no asset the player drops it, so the checker excludes it from the clock too
    (see "an unvoiced bridge" below). 40 s is a Patch, comfortably inside
    narration-craft.md §0's 20-45 s band. */
const bridge = (extra = {}) => ({
  type: "narration", id: "nar-1", audio_url: "https://cdn.example/nar-1.mp3",
  duration_sec: 40, ...extra,
});

/** A bridge timed by its script rather than by a stamped duration. */
const scripted = (chars, extra = {}) =>
  bridge({ script: "x".repeat(chars), duration_sec: undefined, ...extra });

/** Insert bridges into a fixture clone and restate its runtime, because
    `runtime_sec` is the LISTENER's clock and a bridge moves it. Returns the
    clone so a test can read the errors it actually cares about. */
function withBridges(inserts) {
  const f = fx();
  const target = boundary(f);
  /* Spliced back to front so each index still refers to the position the caller
     meant by the time its turn comes. */
  for (const { at, item } of [...inserts].sort((a, b) => b.at - a.at)) target.items.splice(at, 0, item);
  /* `sec` where the caller passes one, because a bridge timed by its SCRIPT has
     no `duration_sec` to add up. */
  const added = inserts.reduce((t, i) => t + (typeof i.sec === "number" ? i.sec : i.item.duration_sec), 0);
  if (typeof target.runtime_sec === "number") target.runtime_sec = +(target.runtime_sec + added).toFixed(2);
  return f;
}

test("a well-formed narration item is accepted between segments", () => {
  // No bridges are authored in any Foray yet (grilling-foray.md §5), but #134's
  // shape has them interleaved. A Foray that grows one must not have to change
  // this file.
  assert.deepEqual(errorsFor(withBridges([{ at: 1, item: bridge() }])), []);
});

test("a narration item without an id is rejected", () => {
  const f = fx();
  boundary(f).items.splice(1, 0, { type: "narration", script: "a bridge long enough to be a bridge and not a placeholder" });
  assert.match(errorsFor(f).join("\n"), /narration item needs an id/);
});

/* ---------- narration has to say how long it is ----------

   The gap `docs/narrator-pipeline.md` §1 item 2 records: this file validated a
   narration item's `id` and nothing else, so an item with no script and no audio
   passed — and then contributed 0 s to `runtime_sec`, to D1's window, and to
   every resume arithmetic in the player. */

test("a narration item that nothing can time is REJECTED, not silently free", () => {
  /* The headline. Mutation that kills it: delete this branch, or soften it to
     `W(...)`. Either way an item worth an unknown number of a listener's seconds
     goes back to being worth zero of ours. */
  const f = fx();
  boundary(f).items.splice(1, 0, { type: "narration", id: "nar-1" });
  assert.match(errorsFor(f).join("\n"), /has neither a `duration_sec` nor a `script`/);
});

test("a narration item is timed by EITHER a duration or a script", () => {
  // Mutation: require both. Scripts exist long before audio does —
  // narration-craft.md is explicit that the word budgets are the primitive — so
  // demanding a measured duration at authoring time would block the normal case.
  assert.deepEqual(errorsFor(withBridges([{ at: 1, item: bridge() }])), []);
  const byScript = withBridges([{ at: 1, item: scripted(340), sec: 20 }]); // 340/17 = 20.0 s
  assert.deepEqual(errorsFor(byScript), []);
});

test("a duration_sec that is not a positive finite number of seconds is rejected", () => {
  /* Mutation: accept anything truthy. `"40"` is the shape a hand-edited JSON
     file produces, and string arithmetic would make the runtime a concatenation
     rather than a sum. 0 is the shape that reintroduces the original defect
     while looking deliberate. */
  for (const bad of [0, -12, "40", null, NaN, {}]) {
    const f = fx();
    boundary(f).items.splice(1, 0, bridge({ duration_sec: bad, script: "x".repeat(340) }));
    assert.match(
      errorsFor(f).join("\n"), /must be a positive finite number of seconds/,
      `duration_sec: ${JSON.stringify(bad)} should be rejected even with a usable script beside it`
    );
  }
});

test("a narration item over the 180 s Carry hard max is rejected, and over 150 s warns", () => {
  /* narration-craft.md §0: "Carry hard max 180 s. The narrator is never the
     longest item in the Foray." Mutation: raise NARRATION_HARD_MAX_SEC, or turn
     the error into a warning — a single 20-minute "bridge" would then pass, and
     narration would be able to eat a Foray one legal item at a time. */
  const over = withBridges([{ at: 1, item: bridge({ duration_sec: 181 }) }]);
  assert.match(errorsFor(over).join("\n"), /over the 180 s Carry hard max/);
  const soft = withBridges([{ at: 1, item: bridge({ duration_sec: 160 }) }]);
  assert.deepEqual(errorsFor(soft), [], "the soft max warns; it does not fail");
  assert.match(checkForays(soft).warnings.join("\n"), /past narration-craft.md §0's 150 s Carry soft max/);
  // And the boundary is inclusive on the passing side, not off by one.
  assert.deepEqual(errorsFor(withBridges([{ at: 1, item: bridge({ duration_sec: 180 }) }])), []);
});

test("a script too short to be a bridge is rejected as a placeholder", () => {
  /* "Two million years later." is 24 characters — 1.4 s. Mutation: drop the
     NARRATION_MIN_SEC check, and a one-word stub passes and contributes 1.4 s
     instead of the real length of whatever eventually gets voiced. That is the
     original defect with a smaller number, which is harder to notice. */
  const f = fx();
  boundary(f).items.splice(1, 0, scripted(24)); // "Two million years later." is 24 characters
  assert.match(errorsFor(f).join("\n"), /24-character script, under narration-craft.md §0's 50-character Hinge floor/);
  /* The boundary is the CHARACTER figure, not the seconds figure, and the row's
     own two numbers disagree: 50 characters at narration-craft's own 17 chars/s
     is 2.94 s, so a hard-coded 3 rejected a 50-character Hinge — the documented
     minimum. Mutation: `NARRATION_MIN_SEC = 3`, and the next line fails. */
  assert.deepEqual(errorsFor(withBridges([{ at: 1, item: scripted(50), sec: 50 / 17 }])), []);
  assert.match(
    errorsFor(withBridges([{ at: 1, item: scripted(49), sec: 49 / 17 }])).join("\n"),
    /Hinge floor/,
    "one character under the documented minimum is still a placeholder"
  );
});

test("an estimated narration length is reported as an estimate; a measured one is not", () => {
  /* A D1 verdict that leans on a character count is only as good as a speaking
     rate nobody has measured (narrator-pipeline.md §6). Mutation: warn
     unconditionally, or not at all — either way the report stops distinguishing
     a fact from a projection. */
  const byScript = withBridges([{ at: 1, item: scripted(340), sec: 20 }]);
  assert.match(checkForays(byScript).warnings.join("\n"), /estimated from the script at 17 chars\/s/);
  const measured = withBridges([{ at: 1, item: bridge() }]);
  assert.doesNotMatch(checkForays(measured).warnings.join("\n"), /estimated from the script/);
});

test("a script-only bridge is counted, not excluded — generation-architecture.md §7 item 1", () => {
  /* THE TWO GATES MUST AGREE ON WHAT PLAYS. `buildForayQueue` now treats a
     script-only narration item as playable via the on-device TTS plugin
     (§7 item 1), so the player's `totalSec` INCLUDES it — and
     `player/foray-playback.test.js` asserts `totalSec` matches the committed
     `runtime_sec` to within a second. Excluding a script-only item here would
     therefore make one gate or the other permanently red the moment on-device
     narration shipped, which is now the ordinary state a script produces.

     Mutation: drop it from `timeline`/`narrations` anyway. The runtime no
     longer matches what the player will actually speak. */
  const f = fx();
  const script = "x".repeat(340); // 20.0 s at 17 chars/s
  const target = boundary(f);
  target.items.splice(1, 0, { type: "narration", id: "nar-1", script });
  target.runtime_sec = +(target.runtime_sec + 20).toFixed(2);
  assert.deepEqual(errorsFor(f), [], "an authored script-only item is not an error");
  const { warnings, report } = checkForays(f);
  assert.doesNotMatch(
    warnings.join("\n"), /has no usable/,
    "a script is usable now — no asset is needed to speak it"
  );
  assert.equal(report.forays[0].narration_sec, 20);
  assert.equal(report.forays[0].runtime_sec, FIXTURE_RUNTIME + 20, "the spoken line now counts");
});

test("a narration item with neither asset nor script is excluded from the clock and warned about", () => {
  /* The one shape that still cannot play: nothing to load AND nothing to
     speak. `buildForayQueue` drops this exact case (§7 item 1's own
     boundary), so it must still be excluded here too. */
  const f = fx();
  boundary(f).items.splice(1, 0, { type: "narration", id: "nar-1", duration_sec: 20 });
  assert.deepEqual(errorsFor(f), []);
  const { warnings, report } = checkForays(f);
  assert.match(warnings.join("\n"), /has no usable `audio_url`\/`asset`\/`script`, so the player drops it/);
  assert.equal(report.forays[0].narration_sec, 0);
  assert.equal(report.forays[0].runtime_sec, FIXTURE_RUNTIME, "unchanged: nothing will play");
});

test("the checker's runtime and the player's agree on a bridged Foray", async () => {
  /* The invariant the test above protects, asserted directly against the real
     player rather than argued about. Mutation: count an unvoiced bridge in the
     checker, or stop counting a voiced one — either way these two diverge. */
  const { resolveForay, indexSegments, indexSources } = await import("../../player/foray-resolve.js");
  const A = "https://cdn.example/nar-1.mp3";
  const cases = [
    bridge(),
    scripted(340),
    { type: "narration", id: "nar-1", script: "x".repeat(340) },
    /* THE CASE THE FIRST VERSION OF THIS TEST MISSED, and the divergence it
       missed. `buildForayQueue` resolves the asset as `audio_url ?? asset`, and
       `??` falls through only on null/undefined — so a PRESENT BUT USELESS
       `audio_url` shadows a good `asset` and the player drops the item. The
       checker's first attempt asked "is either one non-empty", saw the good
       `asset`, and counted seconds the player would never play.

       Mutation: `const url = item.audio_url ?? item.asset` back to
       `!nonEmptyString(item.audio_url) && !nonEmptyString(item.asset)` — the last
       four rows below diverge by 40 s each. */
    bridge({ audio_url: undefined, asset: A }),
    bridge({ audio_url: null, asset: A }),
    bridge({ audio_url: "", asset: A }),
    bridge({ audio_url: "   ", asset: A }),
    bridge({ audio_url: 0, asset: A }),
    bridge({ audio_url: false, asset: A }),
  ];
  for (const item of cases) {
    const f = fx();
    boundary(f).items.splice(1, 0, item);
    const checker = checkForays(f).report.forays[0].runtime_sec;
    const r = resolveForay(boundary(f), {
      segments: indexSegments(f.segments), sources: indexSources(f.sources),
    });
    assert.ok(
      Math.abs(checker - r.totalSec) < 0.5,
      `checker ${checker} vs player ${r.totalSec} for ${JSON.stringify(item).slice(0, 60)}`
    );
  }
});

test("a narration asset must be https and must not be tokened", () => {
  /* The same two lexical checks every `segment-sources` audio_url gets. This
     field only became load-bearing in this change, and the failures are the
     identical ones: an http:// media load blocked by the CSP, or a credential
     committed to a data file. Mutation: drop either regex. */
  const insecure = withBridges([{ at: 1, item: bridge({ audio_url: "http://cdn.example/n.mp3" }) }]);
  assert.match(errorsFor(insecure).join("\n"), /asset must be https/);
  const tokened = withBridges([{ at: 1, item: bridge({ audio_url: "https://cdn.example/n.mp3?token=abc" }) }]);
  assert.match(errorsFor(tokened).join("\n"), /asset looks tokened/);
  // Via `asset` too, not only `audio_url` — the player reads either.
  const viaAsset = withBridges([{ at: 1, item: bridge({ audio_url: undefined, asset: "http://cdn.example/n.mp3" }) }]);
  assert.match(errorsFor(viaAsset).join("\n"), /asset must be https/);
});

test("the Hinge floor judges the SCRIPT, not the audio", () => {
  /* A measured 2.5 s recording of a legal 50-character Hinge is a fact about a
     file, not a placeholder — and real TTS of 50 characters lands anywhere in
     roughly 2.5-3.5 s, so a seconds floor applied to `dur.sec` would have been a
     routine false positive the moment `tools/narrate/` started stamping
     durations. What the floor detects is a stub script.

     Mutation: compare `dur.sec < NARRATION_MIN_SEC` again. The first assertion
     fails, and the second stops failing for a stub script that happens to carry
     a generous stamped duration. */
  const shortAudio = withBridges([
    { at: 1, item: bridge({ duration_sec: 2.5, script: "x".repeat(50) }) },
  ]);
  assert.deepEqual(errorsFor(shortAudio), []);
  const stub = fx();
  boundary(stub).items.splice(1, 0, bridge({ duration_sec: 40, script: "TODO" }));
  assert.match(errorsFor(stub).join("\n"), /4-character script, under narration-craft.md §0's 50-character Hinge floor/);
});

test("a bridge that OPENS a Foray must declare its own slot", () => {
  /* It has no preceding item to inherit one from, so `groupBySlot` appends it to
     a trailing untitled section — the Foray renders with its first item last.
     Silent, which is why it is an error rather than a comment.
     Mutation: drop the `played.length === 0` branch. */
  const f = fx();
  boundary(f).items.unshift(bridge({ duration_sec: 40 }));
  assert.match(errorsFor(f).join("\n"), /opens the Foray, so it has no preceding item to inherit a `slot` from/);
  // Declaring one is all it takes.
  const declared = fx();
  const target = boundary(declared);
  target.items.unshift(bridge({ duration_sec: 40, slot: target.slots[0].id }));
  target.runtime_sec = +(target.runtime_sec + 40).toFixed(2);
  assert.deepEqual(errorsFor(declared), []);
});

test("an unvoiced item (neither asset nor script) is neither counted as unresolved nor erased from the report", () => {
  /* Two separate ways the report lied about the state the checker deliberately
     permits. Mutations: drop `- unvoiced` from the tally, and drop
     `narration_unvoiced` from the report. */
  const f = fx();
  const target = boundary(f);
  target.items.splice(1, 0, { type: "narration", id: "nar-1", duration_sec: 20, slot: target.items[0].slot });
  target.items.push({ type: "segment", slot: target.slots.at(-1).id, segment_id: "does-not-exist" });
  const { warnings, report } = checkForays(f);
  assert.match(warnings.join("\n"), /^foray "boundary-1": 1 item\(s\) did not resolve/m);
  assert.equal(report.forays[0].narration_unvoiced, 1);
  assert.equal(report.forays[0].narration_items, 0, "it will not play, so it is not in the clock");
});

test("a narration item with no id is dropped from the clock, like its sibling rejections", () => {
  /* It carried on with `id: null`, so an item nothing can name was still counted
     in `runtime_sec` — inconsistent with the three rejections beside it, and it
     put a second, spurious `runtime_sec` error on top of the real one.
     Mutation: remove the `continue` after the id error. */
  const f = fx();
  boundary(f).items.splice(1, 0, bridge({ id: undefined }));
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /a narration item needs an id/);
  assert.equal(checkForays(f).report.forays[0].runtime_sec, FIXTURE_RUNTIME);
});

test("a duplicate narration id is rejected rather than silently rewritten", () => {
  /* The builder renames a collision to `${forayId}#${index}` and warns, which is
     a safe failure and a baffling one — the id the author wrote is not the id
     anything plays. Segment ids and labels are already checked here; this closes
     the third case. Mutation: drop `seenNarrationIds`. */
  const f = withBridges([
    { at: 1, item: bridge() },
    { at: 5, item: bridge() },
  ]);
  assert.match(errorsFor(f).join("\n"), /narration id "nar-1" appears twice in one Foray/);
});

test("a narration item cannot declare a slot the Foray does not have", () => {
  // Mutation: drop the check. A bridge in an undeclared slot renders in a
  // trailing untitled section, out of authored order.
  const f = withBridges([{ at: 1, item: bridge({ slot: "not-a-slot" }) }]);
  assert.match(errorsFor(f).join("\n"), /declares slot "not-a-slot", which is not in `slots`/);
});

test("an over-long bridge is dropped from the clock, not left to distort every other verdict", () => {
  /* Mutation: remove the `continue` after the hard-max error. A
     `duration_sec: 1e6` bridge then drags `runtime` to 12 days, flips the D1
     band to 5, and buries the one real error under a spurious `runtime_sec`
     drift and a D1 failure that is an artefact of the first mistake. */
  const f = fx();
  boundary(f).items.splice(1, 0, bridge({ duration_sec: 1e6 }));
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /over the 180 s Carry hard max/);
  assert.equal(checkForays(f).report.forays[0].runtime_sec, FIXTURE_RUNTIME);
});

test("valid narration items are not counted as items that failed to resolve", () => {
  /* `played` is tape only, so subtracting it from the whole item list reported
     every good bridge as a failure: "4 item(s) did not resolve" for one bad
     segment and three fine bridges. Mutation: drop `- narrations.length`. */
  const f = withBridges([
    { at: 1, item: bridge() },
    { at: 5, item: bridge({ id: "nar-2" }) },
    { at: 9, item: bridge({ id: "nar-3" }) },
  ]);
  const target = boundary(f);
  target.items.push({ type: "segment", slot: target.slots.at(-1).id, segment_id: "does-not-exist" });
  assert.match(checkForays(f).warnings.join("\n"), /^foray "boundary-1": 1 item\(s\) did not resolve/m);
});

test("`runtime_sec` is the listener's clock, so a Foray that gains a bridge must restate it", () => {
  /* Mutation: compare `runtime_sec` against `tapeRuntime`. The stated runtime
     would then agree with a number no listener experiences, and the drift
     detector would stop noticing that 23 minutes of narrator had been added. */
  const f = fx();
  boundary(f).items.splice(1, 0, bridge()); // +40 s, runtime_sec untouched
  assert.match(
    errorsFor(f).join("\n"),
    /`runtime_sec` says 3121\.00 but the items sum to 3161\.00 \(3121\.00 of tape \+ 40\.00 of narration\)/
  );
});

test("the report keeps the two clocks apart", () => {
  // Mutation: report `tape_runtime_sec: runtime`. Nothing would fail, and the
  // one number that says how much of a Foray is narrator would silently be 0.
  const f = withBridges([{ at: 1, item: bridge() }, { at: 5, item: bridge({ id: "nar-2", duration_sec: 60 }) }]);
  const r = checkForays(f).report.forays[0];
  assert.equal(r.tape_runtime_sec, FIXTURE_RUNTIME);
  assert.equal(r.narration_sec, 100);
  assert.equal(r.runtime_sec, FIXTURE_RUNTIME + 100);
  assert.equal(r.narration_items, 2);
  assert.equal(r.narration_share, +(100 / (FIXTURE_RUNTIME + 100)).toFixed(4));
  // The per-segment rules are unmoved, because they are rules about tape.
  assert.equal(r.mean_sec, 104);
  assert.equal(r.d5_iqr_sec, 76);
});

/* ---------- D1 on the listener's clock, proved on a BUILT Foray -------------

   The committed boundary fixture above is one order sitting on one set of
   boundaries. These four proofs need a different order each — nine 60 s
   segments, forty of them, three unbalanced ones — so they build one per test
   and append it to a fixture clone. Synthetic segments and sources, alive only
   inside the returned clone; nothing on disk moves.

   Nine 60-second segments is the whole point of the first shape: tape-only they
   are nine starts inside one 600 s window against a budget of 8, which fails by
   exactly one. */

const NINE_SIXTIES = Array.from({ length: 9 }, () => 60);

/**
 * Append a built Foray to a fixture clone. `spec` is a list of numbers (segment
 * lengths in seconds, one synthetic episode each so M4 can never be the thing
 * that fires) and narration objects.
 */
function builtForay(spec, { forayId = "built-1" } = {}) {
  const f = fx();
  const items = [];
  let n = 0;
  for (const s of spec) {
    if (typeof s !== "number") {
      items.push({ type: "narration", audio_url: `https://cdn.example/${s.id}.mp3`, slot: "one", ...s });
      continue;
    }
    const eid = `${forayId}-ep${n}`;
    const sid = `${forayId}-seg${n}`;
    f.sources.sources.push({
      id: eid, show: "Built Show", title: `Built episode ${n}`,
      audio_url: `https://cdn.example/${eid}.mp3`, audio_type: "audio/mpeg",
      duration_sec: 3600, dai_suspected: false,
    });
    f.segments.segments.push({
      id: sid, item_id: eid, start_sec: 100, end_sec: 100 + s, reference_duration_sec: 3600,
    });
    items.push({ type: "segment", slot: "one", segment_id: sid });
    n++;
  }
  f.forays.forays.push({
    id: forayId, kind: "deep-dive", status: "draft", topic: boundary(fixture).topic,
    title: "A built Foray", summary: "A built Foray",
    slots: [{ id: "one", title: "One" }], items,
  });
  return f;
}

const d1FailsIn = (f, forayId = "built-1") =>
  errorsFor(f).some((e) => e.includes(`foray "${forayId}"`) && e.includes("D1 FAIL"));

test("the built D1 shape fails on tape alone — nine 60 s segments, budget 8", () => {
  // The control. If this ever stops failing, every assertion below is vacuous:
  // they would be proving that a passing Foray passes.
  assert.equal(d1FailsIn(builtForay(NINE_SIXTIES)), true);
});

test("D1's 600 s window is the listener's clock, and a bridge is not a segment start", () => {
  /* The same nine segments, with two 60 s bridges dropped in. Nothing about the
     tape changed; the ninth start simply now falls at 600 s of PLAYBACK instead
     of 480 s, which is §5c's "600-second window of Foray playback".

     TWO mutations kill this, in opposite directions, and that is the point:

       - stop advancing the clock for narration (`clock += entry.duration` only
         for segments) and the nine starts crowd back into one window: FAIL.
       - count a bridge AS a start (`starts.push(clock)` unconditionally) and the
         window from zero holds eight segment starts plus two bridges: also FAIL.

     Only the ruling actually implemented — narration occupies the clock, and is
     not itself a cut — passes. */
  const bridged = builtForay([
    60, 60, 60,
    { id: "nar-a", duration_sec: 60 },
    60, 60, 60,
    { id: "nar-b", duration_sec: 60 },
    60, 60, 60,
  ]);
  assert.equal(d1FailsIn(bridged), false);
  const r = checkForays(bridged).report.forays.find((x) => x.id === "built-1");
  assert.equal(r.tape_runtime_sec, 540);
  assert.equal(r.runtime_sec, 660);
  assert.equal(r.d1_max_starts_in_window, 8, "eight tape starts, not ten items");
  assert.equal(r.d1_budget, 8);
});

test("D1's budget BAND is set by the listener's clock too", () => {
  /* §5c's bands are by "total Foray duration", and a Foray's duration is what a
     listener sits through. Forty 60 s segments is 40 min of tape — band N=8 — and
     stays 40 min of tape when 9 minutes of narrator is added on top, at which
     point it is a 49-minute Foray and the band is N=6.

     Mutation: `d1Budget(tapeRuntime)`. The band stays 8 and a Foray the listener
     experiences as 49 minutes long is judged against the under-45-minute
     allowance. */
  const tape = Array.from({ length: 40 }, () => 60);
  const bare = checkForays(builtForay(tape)).report.forays.find((x) => x.id === "built-1");
  assert.equal(bare.runtime_sec, 2400);
  assert.equal(bare.d1_budget, 8);

  // Nine 60 s bridges: 540 s, taking the Foray to 49 minutes.
  const withNarration = builtForay([
    ...tape.slice(0, 20),
    ...Array.from({ length: 9 }, (_, i) => ({ id: `nar-${i}`, duration_sec: 60 })),
    ...tape.slice(20),
  ]);
  const r = checkForays(withNarration).report.forays.find((x) => x.id === "built-1");
  assert.equal(r.tape_runtime_sec, 2400);
  assert.equal(r.runtime_sec, 2940);
  assert.equal(r.d1_budget, 6, "a 49-minute Foray is in the 45-120 band");
});

test("M4's denominator stays the tape, so narration cannot buy a Foray under the cap", () => {
  /* M4 asks whether one episode dominates the SOURCING. One episode of three at
     153 s of 403 s is over the cap on both clauses; adding six minutes of
     narrator does not rebalance the sourcing by one second, so the reported
     share must not move.

     Mutation: `e.sec / runtime`. The share falls, and on a marginal Foray the
     same change would let narration buy a pass that no editorial decision
     earned. */
  const spec = [153, 149, 101];
  const bare = errorsFor(builtForay(spec)).filter((e) => e.includes("M4 FAIL"));
  const padded = errorsFor(builtForay([spec[0], spec[1], { id: "nar-a", duration_sec: 180 }, spec[2], { id: "nar-b", duration_sec: 180 }]))
    .filter((e) => e.includes("M4 FAIL"));
  assert.ok(bare.length > 0, "the built Foray has to fail M4 for this to be testing anything");
  assert.deepEqual(padded, bare);
});

test("the CLI exits 1 on a bridge nothing can time", () => {
  /* Same discipline as the D1/D5 proofs above: the real CLI, a mutated
     checkout, and the exit code — not an inspection of the code. This is also
     what proves the `player/foray-queue.js` import resolves when the CLI is
     spawned as its own process with no install step, which is the one risk the
     shared-rule import carries. (`mutatedCheckout` writes only `data/`, so this
     is not a bare-checkout test — `--root` moves the data, not the code.) */
  const root = mutatedCheckout((f) => {
    boundary(f).items.splice(1, 0, { type: "narration", id: "nar-1" });
  });
  const { status, stderr } = runCli(root);
  assert.equal(status, 1);
  assert.match(stderr, /has neither a `duration_sec` nor a `script`/);
});

/* ============================================================================
   5. §7 items 4-5 — the jingle, and generated-Foray narration validation
   ========================================================================= */

/** The exact §4.7 disclosure template, with a subject filled in. Any generated
    Foray's items[0] must be a narration item carrying this verbatim. */
const DISCLOSURE_SCRIPT =
  "This is a Foray about grilling. Much of what you'll hear is written by AI. We work hard to " +
  "get the facts right, but AI gets things wrong — so take it as a starting point, not a source.";

/** A minimal `generated: true` Foray built from the boundary fixture: the
    disclosure spliced in as items[0], with every narration item on it given a
    valid mode and a script so the baseline is clean. Callers mutate a clone. */
function generatedFixture() {
  const f = fx();
  const foray = boundary(f);
  foray.generated = true;
  const firstSlot = Array.isArray(foray.slots) && foray.slots.length ? foray.slots[0].id : undefined;
  foray.items.unshift({
    type: "narration", id: "disclosure", mode: "marker", script: DISCLOSURE_SCRIPT,
    ...(firstSlot !== undefined ? { slot: firstSlot } : {}),
  });
  if (typeof foray.runtime_sec === "number") {
    foray.runtime_sec = +(foray.runtime_sec + Math.round((DISCLOSURE_SCRIPT.length / 17) * 1000) / 1000).toFixed(2);
  }
  return f;
}

test("a well-formed generated Foray — disclosure first, moded narration — passes clean", () => {
  assert.deepEqual(errorsFor(generatedFixture()), []);
});

test("a generated Foray whose first item is not the disclosure is rejected", () => {
  const f = generatedFixture();
  boundary(f).items[0].script = "Welcome to today's Foray about grilling!";
  assert.match(errorsFor(f).join("\n"), /items\[0\] is not the required disclosure/);
});

test("a generated Foray with no narration item first is rejected the same way", () => {
  const f = generatedFixture();
  boundary(f).items.shift(); // drop the disclosure; a segment now opens the Foray
  assert.match(errorsFor(f).join("\n"), /items\[0\] is not the required disclosure/);
});

test("an admin-authored (non-generated) Foray needs no disclosure at all", () => {
  // The boundary fixture itself opens on a plain segment and carries no
  // `generated` flag — it must stay clean, which is what proves the check is
  // scoped to `generated: true` rather than firing on every Foray.
  assert.deepEqual(errorsFor(fx()), []);
});

test("a generated Foray's narration item with neither script nor asset is rejected", () => {
  const f = generatedFixture();
  boundary(f).items.splice(1, 0, { type: "narration", id: "nar-empty", mode: "hinge" });
  assert.match(errorsFor(f).join("\n"), /neither a `script` nor an `asset`/);
});

test("the same script-less, asset-less item is only a WARNING on a non-generated Foray", () => {
  // This is the existing #236 "unvoiced bridge" behaviour, unchanged — #7
  // item 5's new rule must not retroactively tighten the admin path. A
  // `duration_sec` is required to reach the unvoiced-warning path at all
  // (an item with neither `duration_sec` nor `script` is the older, always-
  // fatal "nothing can say how long it is" rejection above).
  const f = fx();
  boundary(f).items.splice(1, 0, { type: "narration", id: "nar-empty", duration_sec: 8 });
  const { errors, warnings } = checkForays(f);
  assert.deepEqual(errors, []);
  assert.match(warnings.join("\n"), /has no usable `audio_url`\/`asset`\/`script`/);
});

test("a generated Foray's narration item needs a `mode` from the mode enum", () => {
  const f = generatedFixture();
  boundary(f).items.splice(1, 0, bridge({ id: "nar-nomode", mode: undefined }));
  assert.match(errorsFor(f).join("\n"), /has no `mode`/);
});

test("an invalid `mode` value is rejected on ANY Foray, generated or not", () => {
  const generated = generatedFixture();
  boundary(generated).items.splice(1, 0, bridge({ id: "nar-badmode", mode: "essay" }));
  assert.match(errorsFor(generated).join("\n"), /not one of the narration modes/);

  const admin = fx();
  boundary(admin).items.splice(1, 0, bridge({ id: "nar-badmode", mode: "essay" }));
  assert.match(errorsFor(admin).join("\n"), /not one of the narration modes/);
});

test("a valid mode on a non-generated Foray is accepted — the enum check isn't generation-gated", () => {
  const f = withBridges([{ at: 1, item: bridge({ id: "nar-moded", mode: "patch" }) }]);
  assert.deepEqual(errorsFor(f), []);
});

test("the four committed admin-authored Forays still pass with zero errors before and after this change", () => {
  // #7 item 5's own acceptance criterion, run directly against the live data
  // rather than the fixture, so a regression here is caught even if the
  // fixture drifts.
  assert.deepEqual(checkForays(loadFiles(REPO_ROOT)).errors, []);
});

/* ---- the jingle (§7 item 4) --------------------------------------------- */

test("a jingle item is accepted with just a type and passes through untouched", () => {
  const f = fx();
  const foray = boundary(f);
  foray.items.splice(1, 0, { type: "jingle", id: "jingle-1" });
  if (typeof foray.runtime_sec === "number") foray.runtime_sec = +(foray.runtime_sec + 1.5).toFixed(2);
  assert.deepEqual(errorsFor(f), []);
});

test("a jingle needs no id at all", () => {
  const f = fx();
  const foray = boundary(f);
  foray.items.splice(1, 0, { type: "jingle" });
  if (typeof foray.runtime_sec === "number") foray.runtime_sec = +(foray.runtime_sec + 1.5).toFixed(2);
  assert.deepEqual(errorsFor(f), []);
});

test("a jingle is not a segment start for D1 purposes", () => {
  // Splicing a jingle next to an existing segment start must not change D1's
  // max-starts-in-window verdict — only `player/foray-queue.js`'s SEGMENT
  // items are starts.
  const before = checkForays(fx()).report.forays[0];
  const f = fx();
  const foray = boundary(f);
  foray.items.splice(1, 0, { type: "jingle", id: "jingle-1" });
  if (typeof foray.runtime_sec === "number") foray.runtime_sec = +(foray.runtime_sec + 1.5).toFixed(2);
  const after = checkForays(f).report.forays[0];
  assert.equal(after.d1_max_starts_in_window, before.d1_max_starts_in_window);
});

test("a jingle's `id`, when present, must be unique in the Foray", () => {
  const f = fx();
  const foray = boundary(f);
  foray.items.splice(1, 0, { type: "jingle", id: "dup" }, { type: "jingle", id: "dup" });
  if (typeof foray.runtime_sec === "number") foray.runtime_sec = +(foray.runtime_sec + 3).toFixed(2);
  assert.match(errorsFor(f).join("\n"), /id "dup" appears twice/);
});

test("`runtime_sec` must account for a jingle's duration, exactly like narration", () => {
  const f = fx();
  const foray = boundary(f);
  foray.items.splice(1, 0, { type: "jingle", id: "jingle-1" });
  // runtime_sec deliberately NOT restated — the mismatch must be caught.
  assert.match(errorsFor(f).join("\n"), /`runtime_sec` says/);
});

/* ----------------------------------------------------------------- helpers */

/** Put the held-back segment back where the fixture cut it from: the first slot,
 * at the index where the five durations that follow are the period's tightest
 * five-run. Breaks D1 and nothing else — see the test, and the README's
 * derivation of the 120 s. */
function putHeldBack(f) {
  const foray = boundary(f);
  const at = foray.items.findIndex((i) => i.label === "E-1");
  assert.ok(at > 0, "the fixture no longer has E-1 to insert before");
  foray.items.splice(at, 0, {
    type: "segment",
    slot: "one",
    label: "HELD-1",
    segment_id: "boundary-ep-held#150",
    role: "explanation",
  });
  delete foray.runtime_sec; // 31 segments obviously do not sum to 3,121 s
  return f;
}

/** Swap A-1 (72 s) and F-1 (88 s). Breaks D5 and nothing else — see the test.
 * Both are in the same slot block and the sum is unchanged, so unlike the live
 * swap this replaced, no other field has to be dropped to keep it legal. */
function swapA1AndF1(f) {
  const foray = boundary(f);
  const a = foray.items.findIndex((i) => i.label === "A-1");
  const b = foray.items.findIndex((i) => i.label === "F-1");
  assert.ok(a >= 0 && b >= 0, "the fixture no longer has A-1 and F-1 to swap");
  [foray.items[a], foray.items[b]] = [foray.items[b], foray.items[a]];
  return f;
}

/** Write a checkout containing only the four files the checker reads, with
 * `mutate` applied to parsed copies of the FIXTURE. Returns the temp root. */
function mutatedCheckout(mutate) {
  const f = fx();
  mutate(f);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-check-"));
  fs.mkdirSync(path.join(root, "data"));
  for (const [name, value] of [
    ["forays.json", f.forays],
    ["segments.json", f.segments],
    ["segment-sources.json", f.sources],
    ["taxonomy.json", f.taxonomy],
  ]) {
    fs.writeFileSync(path.join(root, "data", name), JSON.stringify(value, null, 2) + "\n");
  }
  return root;
}

function runCli(root) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "--root", root], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

/* ============================================================================
   6. A GENERATED FORAY'S OWN TIER-2 TAPE (generation finding F-49)
   ========================================================================= */

test("a Foray using a segment §4.5 tier 2 minted this run resolves, and its seconds count", () => {
  /* THE HOLE THIS CLOSES. `sourceBeats` cuts a tier-2 segment out of a
     transcript during a generation run, so it is in no file on disk yet: the
     merge path that writes `data/segments.json` runs on a curator's batch, not
     inside the run. Until F-49 nothing carried those rows anywhere, so the
     candidate named a `segment_id` this checker could not resolve — "unknown
     segment_id", the item dropped before every ordering rule, its seconds
     counted nowhere, and the Foray failed on a runtime that disagreed with its
     own items. `finalizeForay` now merges the minted segment and its
     `segment-sources` row into the files handed to this function, and
     `publishForay` writes them beside `data/forays.json`; the rows below are
     exactly what those two produce (`mintedSegmentRow` /
     `MintedSegmentSource`).

     MUTATION THAT KILLS THIS: drop either pushed row. Without the segment the
     checker reports an unknown segment_id and the runtime is 120 s short;
     without the source row it reports that the pool references an item id
     "with no entry in data/segment-sources.json — nothing can resolve its
     audio". Ran both — red, with those messages. */
  const f = fx();
  const MINTED_SEC = 120;
  f.segments.segments.push({
    id: "practical-ai--minted-episode#900",
    item_id: "practical-ai--minted-episode",
    topic: "fixture/boundary",
    start_sec: 900,
    end_sec: 900 + MINTED_SEC,
    reference_duration_sec: 3600,
    start_anchor: "so the first thing we did was",
    end_anchor: "and that is how the pipeline ended up",
    confidence: "medium",
    source: "generation-tier-2",
    needs_review: true,
  });
  f.sources.sources.push({
    id: "practical-ai--minted-episode",
    show: "Practical AI",
    title: "A minted episode",
    feed_url: "https://example.invalid/feed.xml",
    episode_guid: "guid-1",
    audio_url: "https://cdn.example/practical-ai-minted.mp3",
    audio_type: "audio/mpeg",
    duration_sec: 3600,
    dai_suspected: false,
    source: "generation-tier-2",
  });

  const b = boundary(f);
  b.items.push({ type: "segment", slot: "three", segment_id: "practical-ai--minted-episode#900", role: "explanation" });
  b.runtime_sec = +(b.runtime_sec + MINTED_SEC).toFixed(2);

  assert.deepEqual(errorsFor(f), [], "a minted tier-2 segment that travels with its source row is resolvable tape");
  const r = checkForays(f).report.forays.find((x) => x.id === b.id);
  assert.equal(r.segments, segmentItems(boundary(fixture)).length + 1, "the minted segment is counted, not dropped");
  assert.equal(r.runtime_sec, FIXTURE_RUNTIME + MINTED_SEC, "its seconds are on the listener's clock");
});

/* ====================================================================
   K-02: phonemes are authored with the script
   (docs/bundled-voice-plan.md K-02)

   The deck's load-bearing idea (§4): narration text becomes PHONEMES on our
   servers, at generation time, and the phone receives ids. What this checker
   owns is that an item CLAIMING to be phonemized actually is, and that the
   pronunciation lexicon survived the trip.

   EVERY RULE IS INERT ON A LEGACY ITEM, which is every item in
   `data/forays.json` today. The first test below is the one that proves it,
   and it is the one that would catch this card breaking the four committed
   Forays.
   ==================================================================== */

const LEX = [
  { term: "sake", ipa: "ˈsɑːkeɪ" },
  { term: "ch'arki", ipa: "tʃarki" },
  { term: "koji", ipa: null },      // in the lexicon, no authored override
];

const kokoroItem = (over = {}) => ({
  type: "narration",
  id: "n1",
  script: "The sake was poured.",
  mode: "carry",
  phonemes: "ðə ˈsɑːkeɪ wɒz pɔːd",
  tts: { engine: "kokoro", model: "1.0", vocab: "sha256:abc" },
  est_sec: 1.2,
  ...over,
});

test("K-02: an item with no `tts` block is untouched — the legacy path is not re-validated", () => {
  /* THE REGRESSION GUARD FOR THIS WHOLE CARD. Every narration item in
     `data/forays.json` is script-only with no `tts`; a rule that fired on them
     would fail the repo's own data on the day it landed.
     MUTATION: drop the `tts === undefined` early return in `phonemeProblems` —
     every committed Foray goes red and `node tools/foray/check-forays.mjs`
     stops passing. */
  assert.deepEqual(phonemeProblems({ type: "narration", id: "n1", script: "Plain." }, LEX), []);
  assert.deepEqual(phonemeProblems({ script: "The sake was poured." }, LEX), [],
    "a lexicon term in a legacy script demands nothing");
});

test("K-02: a well-formed kokoro item passes", () => {
  assert.deepEqual(phonemeProblems(kokoroItem(), LEX), []);
});

test("K-02: THE MUTATION THE CARD NAMES — drop one override and the item goes red", () => {
  /* The card's own words: "every lexicon term in `script` is reflected in
     `phonemes` (MUTATION: drop one override → red)". This is that mutation,
     executed: the script still says "sake", the phonemes no longer carry the
     lexicon's IPA for it, and the item is rejected.

     WHY IT MATTERS MORE HERE THAN ON THE SYSTEM-VOICE PATH: an iOS voice that
     ignores an IPA attribute mispronounces one word. A Kokoro item whose
     phonemes lost the override mispronounces it on EVERY device, identically,
     forever — the determinism the deck is built on cuts both ways. */
  const dropped = kokoroItem({ phonemes: "ðə seɪk wɒz pɔːd" }); // the English "sake"
  const problems = phonemeProblems(dropped, LEX);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /says "sake"/);
  assert.match(problems[0], /ˈsɑːkeɪ/);
});

test("K-02: a lexicon term with NO authored IPA demands nothing", () => {
  /* `hard-terms.json` carries 83 terms and exactly one authored IPA; that
     file's own honesty note says why. Demanding an override for a term whose
     override is deliberately `null` would be demanding that a phonemizer
     invent what the lexicon refuses to state.
     MUTATION: drop the `if (!entry.ipa) continue` guard — every kokoro item
     mentioning `koji` goes red with nothing to fix. */
  assert.deepEqual(phonemeProblems(kokoroItem({ script: "The koji was ready." }), LEX), []);
});

test("K-02: a term matched inside a longer word does not count", () => {
  /* The lexicon's own matching rule (narrator-voice.md's Appendix,
     `foray-tts.js`'s `findMatches`): case-insensitive, word boundary, with
     apostrophes as interior characters.
     MUTATION: use a bare `script.includes(term)` — "sakes" and "namesake"
     both demand the override and the checker starts rejecting correct items. */
  assert.equal(scriptMentions("for goodness' sakes", "sake"), false);
  assert.equal(scriptMentions("the namesake district", "sake"), false);
  assert.equal(scriptMentions("A glass of SAKE.", "sake"), true, "case-insensitive");
  assert.equal(scriptMentions("dried ch'arki, salted", "ch'arki"), true, "apostrophes are interior");
  assert.equal(scriptMentions("charki without the mark", "ch'arki"), false);
});

test("K-02: a kokoro item with no phonemes is rejected — the phone cannot make its own", () => {
  /* The entire licence argument (deck §4) is that there is NO text front-end
     on the device. An item that declares the engine and carries no phonemes is
     an item that will fall back to the system voice, silently, forever.
     MUTATION: treat missing phonemes as "fall back quietly" — the item ships
     and nobody learns the phonemize stage skipped it. */
  for (const bad of [undefined, "", "   ", 42]) {
    const problems = phonemeProblems(kokoroItem({ phonemes: bad }), LEX);
    assert.match(problems.join("\n"), /carries no `phonemes`/, `phonemes: ${JSON.stringify(bad)}`);
  }
});

test("K-02: model and vocab are required — a kokoro item must be version-checkable", () => {
  /* Deck §5 item 8: phonemes in the data must match the phoneme vocabulary of
     the model in the app, and the player refuses on mismatch. An item with no
     `vocab` is one the player cannot decide about, so it falls back to the
     system voice and the failure is invisible.
     MUTATION: drop either field from the required list. */
  assert.match(phonemeProblems(kokoroItem({ tts: { engine: "kokoro", model: "1.0" } }), LEX).join("\n"),
    /`tts\.vocab` must be a non-empty string/);
  assert.match(phonemeProblems(kokoroItem({ tts: { engine: "kokoro", vocab: "v" } }), LEX).join("\n"),
    /`tts\.model` must be a non-empty string/);
});

test("K-02: an unknown engine is rejected, and stops there", () => {
  /* MUTATION: accept any string as an engine — a typo'd `kokoru` then ships,
     the player falls back forever, and the phonemes ride along unused. The
     "stops there" half matters too: reporting eight more problems about an
     engine nobody recognises buries the one that matters. */
  const problems = phonemeProblems(kokoroItem({ tts: { engine: "kokoru", model: "1.0", vocab: "v" } }), LEX);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /`tts\.engine` is "kokoru", not one of kokoro/);
  assert.deepEqual(TTS_ENGINES, ["kokoro"]);
});

test("K-02: a non-object `tts` is rejected rather than read for fields", () => {
  /* MUTATION: read `tts.engine` off a string — `"kokoro".engine` is undefined,
     which reports as an unknown engine and hides the real shape error. */
  assert.match(phonemeProblems(kokoroItem({ tts: "kokoro" }), LEX).join("\n"), /must be an object/);
  assert.match(phonemeProblems(kokoroItem({ tts: ["kokoro"] }), LEX).join("\n"), /must be an object/);
});

test("K-02: est_sec must be a positive finite number when present", () => {
  /* `est_sec` feeds the seam and generation-lead maths until K-04 can record a
     real rendered length (deck K-05). A zero or a NaN there is a seam the
     player schedules for no time at all.
     MUTATION: drop the `Number.isFinite` half — NaN passes. */
  for (const bad of [0, -1, "12", NaN, Infinity]) {
    assert.match(phonemeProblems(kokoroItem({ est_sec: bad }), LEX).join("\n"), /`est_sec` is/,
      `est_sec: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(phonemeProblems(kokoroItem({ est_sec: undefined }), LEX), [], "absent is fine");
});

test("K-02: the real lexicon loads, and is the file the plugin reads", () => {
  /* One lexicon, not two. `foray-tts.js` applies it on the system-voice path
     and this checker enforces it on the kokoro path; a second copy would be
     two rules that agree until they do not.
     MUTATION: point LEXICON_PATH at a copy. */
  const entries = lexiconEntries();
  assert.ok(entries.length >= 80, `the lexicon has ${entries.length} entries, expected the committed 83`);
  assert.equal(LEXICON_PATH, "mobile/plugins/foray-tts/lexicon/hard-terms.json");
  /* Honest state, pinned: exactly one authored IPA today. When that changes,
     this assertion is where somebody says so. */
  const authored = entries.filter((e) => e.ipa);
  assert.equal(authored.length, 1, "if IPA has been authored for more terms, update this and say who verified it");
});
