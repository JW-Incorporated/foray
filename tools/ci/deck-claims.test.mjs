/* Tests for the deck-drift rule (tools/ci/deck-claims.mjs).
 *
 * Two halves, and both are load-bearing:
 *   - fixtures, where every test names the mutation that kills it;
 *   - the real `docs/` tree, which is what makes this a gate rather than a
 *     self-consistent toy. The last test is the one that goes red when someone
 *     writes a DONE marker with nothing behind it.
 */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditAll,
  auditDeck,
  basenamesOf,
  findDecks,
  formatProblems,
  parseCards,
  pathsNamedIn,
} from "./deck-claims.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN = basenamesOf(["backend/src/generation/d5Pair.ts", "tools/build-show-index.mjs"]);

/* ------------------------------------------------------------ parseCards */

test("a card heading is recognised at any depth, and prose headings are not", () => {
  /* MUTATION: drop the `·` from CARD_HEADING_RE. "### 1.4 Live state at
     revision time" does not match anyway, but "## S-05 something" would start
     matching section headings that merely begin with an ID-shaped token, and
     the audit would start judging prose. The `·` is the separator every deck in
     this repo actually uses, which is why it is the anchor. */
  const cards = parseCards(
    [
      "# A deck",
      "**Status:** whatever",
      "### Track B — one card per gate",
      "#### S-05 · Cache the hot queries — **S** — **DONE** (#657, 2026-09-12)",
      "### FD-01 · Instrument the shell — **S** — agent",
      "## G-42a · A benchmark harness — **M**",
      "### 1.4 Live state at revision time (2026-09-10 13:30Z)",
      "#### Not a card at all",
    ].join("\n")
  );
  assert.deepEqual(
    cards.map((c) => [c.id, c.done]),
    [
      ["S-05", true],
      ["FD-01", false],
      ["G-42a", false],
    ]
  );
});

test("UNDONE is not DONE", () => {
  /* MUTATION: drop the word boundaries from DONE_RE. A card that says the work
     was UNDONE would read as landed, which is the worst possible direction for
     this check to fail in. */
  const [card] = parseCards("#### S-01 · Something — **S** — the U-07 work was UNDONE by #600");
  assert.equal(card.done, false);
});

/* --------------------------------------------------------- pathsNamedIn */

test("only backticked, slashed, extensioned tokens count as repo paths", () => {
  /* MUTATION: drop the `p.includes("/")` filter. `d5Triple.ts` written without
     a directory would then be judged, and so would every prose mention of a
     bare filename — including ones that are deliberately hypothetical. A deck
     that writes a path with a directory is making a locatable claim; one that
     writes a bare name is not. */
  const named = pathsNamedIn(
    "DONE; `backend/src/d5Pair.ts` and `check-forays.mjs` and `docs/` and `tools/segments/*.mjs`, see `app.js:8100`"
  );
  assert.deepEqual(
    named.map((n) => n.raw),
    ["backend/src/d5Pair.ts"]
  );
});

test("a `path.ts:123` line reference is stripped, not treated as a different file", () => {
  /* MUTATION: drop the `(?::\d+...)?` group. `finalizeForay.ts:568` would stop
     matching entirely and the rule would silently skip every path a deck cites
     with a line number — which is most of the interesting ones. */
  const named = pathsNamedIn("DONE `backend/src/generation/d5Pair.ts:568` and `tools/build-show-index.mjs:275,280`");
  assert.deepEqual(
    named.map((n) => n.basename),
    ["d5Pair.ts", "build-show-index.mjs"]
  );
});

/* ------------------------------------------------------------- auditDeck */

test("a DONE card with no PR and no branch is a violation", () => {
  /* MUTATION: delete the `done-without-evidence` block, or make the condition
     `PR_RE.test(...) || true`. This is the rule the audit's own measurement
     argues for: the decks whose DONE markers are written in the same commit as
     the PR that lands the card have a 0% false-claim rate, and the decks whose
     markers float free are where all of the drift is. */
  const problems = auditDeck(
    "docs/x.md",
    "#### S-05 · Cache the hot queries — **S** — **DONE** (2026-09-12)",
    KNOWN
  );
  assert.deepEqual(problems.map((p) => p.rule), ["done-without-evidence"]);
  assert.match(formatProblems(problems), /done-without-evidence/);
});

test("a PR number or a branch name each satisfy the evidence rule", () => {
  /* MUTATION: drop BRANCH_RE from the condition. `bundled-voice-plan.md`'s
     seven K-cards cite a branch rather than a PR number and would all go red,
     which is the false alarm that would get this whole check deleted. */
  assert.deepEqual(auditDeck("d", "#### S-05 · x — **DONE** (#657, 2026-09-12)", KNOWN), []);
  assert.deepEqual(auditDeck("d", "#### K-02 · x — **DONE** (2026-09-12, `feat/bundled-voice-k-deck`)", KNOWN), []);
  assert.deepEqual(auditDeck("d", "#### U-01 · x — **DONE 2026-09-06, PR #498**", KNOWN), []);
});

test("a DONE card that names a file the repo does not have is a violation", () => {
  /* MUTATION: delete the `done-names-missing-file` block. This is the live case
     that prompted the rule: `docs/curation/listening-quality-plan.md` still
     instructed an agent to edit `d5Triple.ts`, deleted in 1ac3d4f and replaced
     by `d5Pair.ts`, months after the replacement landed. */
  const problems = auditDeck(
    "docs/x.md",
    "#### Q-03 · The triple — **DONE** (#600); `backend/src/generation/d5Triple.ts`",
    KNOWN
  );
  assert.deepEqual(problems.map((p) => p.rule), ["done-names-missing-file"]);
  assert.match(problems[0].detail, /d5Triple\.ts/);
});

test("an abbreviated directory is NOT a violation — the match is on basename", () => {
  /* MUTATION: compare the full path instead of the basename. Five DONE cards in
     the real decks abbreviate a directory (`web/foray-tts.js` for
     `mobile/plugins/foray-tts/web/foray-tts.js`, `player/client.js` written as
     `mobile/www/player/client.js`), and all five would go red on arrival. A
     check that is red the day it lands teaches everyone to ignore it, which is
     the disease, not the cure. */
  assert.deepEqual(auditDeck("d", "#### Q-03 · x — **DONE** (#600); `src/d5Pair.ts`", KNOWN), []);
});

test("a card body's unbuilt deliverables are not judged — only the heading is", () => {
  /* MUTATION: scan `card.body` instead of `card.heading`. K-03 in
     `bundled-voice-plan.md` is DONE for the kit it built and its **Ask** bullet
     names `mobile/plugins/foray-tts/voices.json` — a file a LATER card creates.
     A body-scanning version flags that, and it is not wrong, it is unbuilt. */
  const problems = auditDeck(
    "docs/x.md",
    [
      "#### K-03 · The audition kit — **DONE** (2026-09-12, `feat/bundled-voice-k-deck`)",
      "- **Ask:** record the shipped voice ids in `mobile/plugins/foray-tts/voices.json`.",
    ].join("\n"),
    KNOWN
  );
  assert.deepEqual(problems, []);
});

test("the same card ID twice in one deck is a violation", () => {
  /* MUTATION: drop the `seen` map. Two `#### S-05` headings mean one is stale
     and a reader has no way to tell which — the exact ambiguity a deck exists
     to remove. */
  const problems = auditDeck(
    "docs/x.md",
    ["#### S-05 · first — **DONE** (#657)", "#### S-05 · second — **DONE** (#658)"].join("\n"),
    KNOWN
  );
  assert.deepEqual(problems.map((p) => p.rule), ["duplicate-card-id"]);
});

test("a card that is not DONE is not judged at all", () => {
  /* MUTATION: drop the `if (!card.done) continue;` guard. Every unstarted card
     in every deck would demand a PR number, which no unstarted card can have.
     This check only ever judges CLAIMS. */
  assert.deepEqual(auditDeck("d", "#### K-04 · The engine — **L** — *design comment first*", KNOWN), []);
  assert.deepEqual(auditDeck("d", "#### K-04 · The engine, see `backend/src/gone.ts` — **L**", KNOWN), []);
});

/* ----------------------------------------------------- the real docs tree */

const TRACKED = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter(Boolean);

test("the real docs/ tree has decks to check, so this is not vacuously green", () => {
  /* MUTATION: narrow CARD_HEADING_RE until it matches nothing. `auditAll` would
     return [] and the gate below would pass while checking nothing — the
     failure mode `test/suite-integrity.test.js`'s header calls "strictly worse
     than no floor at all". The floor is deliberately below today's 8 so that
     retiring a finished deck is not a CI failure. */
  const decks = findDecks(ROOT, TRACKED);
  assert.ok(decks.length >= 5, `only ${decks.length} deck(s) found: ${decks.join(", ")}`);

  const cards = decks.flatMap((d) => parseCards(fs.readFileSync(path.join(ROOT, d), "utf8")));
  assert.ok(cards.filter((c) => c.done).length >= 20, `only ${cards.filter((c) => c.done).length} DONE card(s)`);
});

test("every DONE claim in every deck names its evidence and the files it names exist", () => {
  /* THE GATE. Red the moment a deck claims a card landed without saying which
     PR or branch landed it, or names a file that is not there.

     MUTATION: add `#### Z-99 · x — **DONE** (2026-09-12)` to any deck. */
  const problems = auditAll(ROOT, TRACKED);
  assert.deepEqual(problems, [], problems.length ? "\n" + formatProblems(problems) : "");
});
