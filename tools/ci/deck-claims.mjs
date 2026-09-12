/* The deck-drift rule, made mechanical.
 *
 * WHAT DRIFT IS, AND WHERE IT LIVES
 * This repo plans in "decks": a markdown file under `docs/` whose cards are
 * `#### <CARD-ID> · <title> — <size>` headings, and whose landed cards carry a
 * DONE marker written into that heading. A machinery audit on 2026-09-12 found
 * the false-claim rate is not evenly spread. Decks whose PRs edit the deck in
 * the SAME commit that lands the card (`ui-transition`, `foray-directory`,
 * `ios-controls`, `search`) had a 0% false-claim rate. The drift is entirely in
 * the decks where the marker is written separately from the work — and it runs
 * in BOTH directions: `bundled-voice-plan.md` marked K-02 DONE on the strength
 * of a module (`backend/src/generation/phonemize.ts`) that has no production
 * caller, while `search-plan.md` left S-05/S-06/S-08 reading as outstanding
 * after PRs #657 and #658 landed them.
 *
 * WHAT THIS CHECKS, AND WHY IT IS THE WEAK VERSION
 * The strong version — "every card is either DONE-with-a-merged-PR or listed as
 * outstanding" — was considered and rejected. It cannot be written without false
 * alarms: a deck mid-flight legitimately has cards that are neither (blocked on
 * a human gate, superseded, or simply next), and "listed as outstanding" has no
 * machine-readable form across eight decks that each write their status section
 * differently. A check that cries wolf is worse than no check, because the first
 * thing anyone does with one is stop reading it.
 *
 * So this asserts three things that are true of every deck in the repo today and
 * that no honest edit would ever break:
 *
 *   1. A DONE marker must name its evidence — a PR number (`#657`) or a branch
 *      (`feat/bundled-voice-k-deck`) — on the same heading. This is the exact
 *      property the audit found correlates with accuracy, turned into a rule: a
 *      claim you have to attach a merge to is a claim you have to check. It is
 *      also what makes every OTHER claim auditable later, by hand or by machine.
 *
 *   2. A repo path named in a DONE heading must exist. A card that says "DONE …
 *      `backend/src/generation/d5Triple.ts`" after that file was deleted and
 *      replaced by `d5Pair.ts` is drift with no defence. Matched on BASENAME,
 *      not full path, because decks abbreviate directories freely
 *      (`web/foray-tts.js` for `mobile/plugins/foray-tts/web/foray-tts.js`) and
 *      flagging that would be the cry-wolf failure above. Only the HEADING is
 *      scanned, never the card body: a card's `**Ask:**` bullets name files the
 *      card is asking someone to CREATE, which are supposed not to exist yet.
 *
 *   3. A card ID appears at most once per deck. Two `#### S-05` headings mean one
 *      of them is stale, and a reader has no way to tell which.
 *
 * What this deliberately does NOT do is read git history. `actions/checkout@v4`
 * clones at depth 1, so any rule phrased as "the status line's date must be
 * within N commits of the last content change" is unevaluable on the runner
 * exactly where it would need to run — it would either be skipped (a gate
 * certifying nothing) or red for the wrong reason.
 *
 * Pure functions over plain data; `deck-claims.test.mjs` runs them against
 * fixtures AND against the real `docs/` tree.
 */

import fs from "node:fs";
import path from "node:path";

/* A card heading: two to four hashes, then an ID like `S-05`, `FD-01`, `G-42a`,
   then the ` · ` separator every deck in this repo uses. The separator is what
   keeps prose headings ("### 1.4 Live state") out of the card set. */
export const CARD_HEADING_RE = /^#{2,4}\s+([A-Z]{1,3}-\d{1,3}[a-z]?)\s+·\s*(.*)$/;

/* The DONE marker, in every form the decks use: `**DONE**`, `DONE (#657, …)`,
   `— **DONE 2026-09-06, PR #498**`. Word-boundaried so "UNDONE" is not a match. */
export const DONE_RE = /\bDONE\b/;

/* Evidence: a PR/issue reference, or a branch name in backticks. */
export const PR_RE = /#\d{2,5}\b/;
export const BRANCH_RE = /`(?:feat|fix|chore|docs|refactor|perf|test)\/[A-Za-z0-9._\-/]+`/;

/* A backticked token that looks like a repo file: has a slash, has an
   extension, optionally a `:123` line reference. Anything without a slash is a
   bare filename and too ambiguous to judge; anything with a wildcard is a glob. */
export const PATH_RE = /`([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{1,6})(?::\d+(?:,\d+)*)?`/g;

/** Every card heading in one deck's text, in order. */
export function parseCards(text) {
  const cards = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = CARD_HEADING_RE.exec(line);
    if (m) cards.push({ id: m[1], heading: line, done: DONE_RE.test(line) });
  }
  return cards;
}

/**
 * The repo-path-shaped tokens in one line, as basenames.
 *
 * Returned as basenames because that is what rule 2 compares — see the header
 * for why the full path is not the right comparison for a deck.
 */
export function pathsNamedIn(line) {
  const out = [];
  for (const m of String(line).matchAll(PATH_RE)) {
    const p = m[1];
    if (!p.includes("/")) continue; // a bare filename tells us nothing about where
    if (p.startsWith("http")) continue; // a URL that happened to lose its scheme
    out.push({ raw: p, basename: path.posix.basename(p) });
  }
  return out;
}

/**
 * Violations in one deck.
 *
 * `knownBasenames` is the set of basenames of every tracked file in the repo.
 * -> [{ deck, card, rule, detail }]
 */
export function auditDeck(deck, text, knownBasenames) {
  const problems = [];
  const cards = parseCards(text);

  const seen = new Map();
  for (const card of cards) {
    if (seen.has(card.id)) {
      problems.push({
        deck,
        card: card.id,
        rule: "duplicate-card-id",
        detail: `${card.id} heads two different cards in this deck — one of them is stale and a reader cannot tell which`,
      });
    }
    seen.set(card.id, card);

    if (!card.done) continue;

    if (!PR_RE.test(card.heading) && !BRANCH_RE.test(card.heading)) {
      problems.push({
        deck,
        card: card.id,
        rule: "done-without-evidence",
        detail:
          `${card.id} is marked DONE but its heading names no PR (#123) and no branch ` +
          "(`feat/…`). A claim with nothing to check is the shape every false claim in " +
          "this repo has had.",
      });
    }

    for (const { raw, basename } of pathsNamedIn(card.heading)) {
      if (knownBasenames.has(basename)) continue;
      problems.push({
        deck,
        card: card.id,
        rule: "done-names-missing-file",
        detail: `${card.id} is marked DONE and names \`${raw}\`, and no file called ${basename} exists in the repo`,
      });
    }
  }
  return problems;
}

/** Basenames of every tracked file, from a `git ls-files` listing. */
export function basenamesOf(files) {
  return new Set((files ?? []).filter(Boolean).map((f) => path.posix.basename(f.trim())));
}

/** Every `.md` under `docs/` that has at least one card heading. */
export function findDecks(root, files) {
  return (files ?? [])
    .filter((f) => f.startsWith("docs/") && f.endsWith(".md"))
    .filter((f) => {
      const abs = path.join(root, f);
      return fs.existsSync(abs) && parseCards(fs.readFileSync(abs, "utf8")).length > 0;
    })
    .sort();
}

/** Audit every deck under `root`. -> [{ deck, card, rule, detail }] */
export function auditAll(root, files) {
  const known = basenamesOf(files);
  return findDecks(root, files).flatMap((deck) =>
    auditDeck(deck, fs.readFileSync(path.join(root, deck), "utf8"), known)
  );
}

/** The operator-facing rendering of a non-empty `auditAll`. */
export function formatProblems(problems) {
  return [
    `${problems.length} deck claim(s) cannot be checked or are contradicted by the tree:`,
    "",
    ...problems.map((p) => `  ${p.deck} [${p.rule}] ${p.detail}`),
    "",
    "See tools/ci/deck-claims.mjs's header for what each rule is and why it is",
    "phrased the way it is.",
  ].join("\n");
}
