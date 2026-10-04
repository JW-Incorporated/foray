#!/usr/bin/env node
/**
 * The weekly merge audit (#129, OPS-07): the pure part and a thin CLI.
 *
 * WHY THIS EXISTS. Auto-merge lands bot PRs on green under data/, docs/,
 * player/, tools/, test/ and the rest of ALLOWED_PREFIXES with no human read.
 * Nothing watched what merged. The lesson the gate removal taught is that
 * removing a human gate raises the bar on whatever is upstream of it, and the
 * cheapest thing upstream is a weekly ledger: every PR that merged, which of
 * them nobody read, which touched a governed path, whether a test floor fell
 * in the same week, and whether the kill switch is still thrown.
 *
 * WHAT IT IS NOT. It has no keys and makes no requests. The workflow that
 * runs it (OPS-08, `.github/workflows/merge-audit.yml`) gathers the inputs with
 * `gh api`, hands them over as files, and posts the rendered body as ONE
 * comment on the ONE evolving issue (#129). Keeping the gather out of this
 * file is what makes every line of it testable with inline fixtures, and what
 * keeps the audit itself out of the paths it audits.
 *
 * FAILURE IS LOUD. #129's hard requirement: a false all-clear here is worse
 * than no audit, because this is the only check of its class. So any thrown
 * error renders a FAILED body (`renderFailure`) that names the step, and the
 * CLI still writes it to `--out` before exiting 1, so the workflow has
 * something to post that is NOT "audit ok".
 *
 * Inputs, all produced by the caller:
 *   prs.json      REST pull objects, each extended with `files: string[]`
 *                 (the changed paths) and `reviews: { state, user:{login} }[]`.
 *   before.js     test/suite-integrity.test.js at the start of the window.
 *   after.js      the same file at the end of the window.
 *   --freeze      the AUTOMERGE_FREEZE repo variable's current value.
 *
 * Usage:
 *   node tools/audit/merge-audit.mjs --prs prs.json --floors-before before.js
 *     --floors-after after.js --since ISO --until ISO --freeze "<value>"
 *     --out body.md [--json]
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  APPROVAL_LABEL,
  isFounderLogin,
  isFreezeActive,
  pathPolicy,
  pathProblem,
} from "../ci/path-policy.mjs";

/* ───────────────────────────────── governed paths ───────────────────────── */

/**
 * Why a path counts as "governed", or null when auto-merge may land it unread.
 *
 * The plan named `pathProblem` as the primitive here, but `pathProblem` only
 * rejects MALFORMED paths (backslashes, `..`, absolute); `.github/ci.yml` is a
 * perfectly well-formed path that it returns null for. What #129 asks about is
 * the DENIED boundary, and that lives in `pathPolicy`, which runs `pathProblem`
 * first and then the deny and allow lists. So the default is this composition:
 *
 *   malformed  -> "malformed: <pathProblem's reason>"   (a human looks)
 *   denied     -> "denied: <the matching prefix>"       (the boundary itself)
 *   unlisted   -> "outside the allow-list"              (a human looks)
 *   allowed    -> null
 *
 * The verdict is `pathPolicy`'s and never re-derived here, so widening or
 * narrowing the lists in path-policy.mjs changes this audit on the same commit.
 * `auditMergedPrs` takes the function as `pathProblemFn` (the plan's name) so a
 * test can hand it a stub, and so the stub and this default have one contract:
 * a non-null string means governed.
 */
export function governedReason(file) {
  const problem = pathProblem(file);
  if (problem !== null) return `malformed: ${problem}`;
  const policy = pathPolicy([file]);
  if (policy.denied.length) return `denied: ${policy.denied[0].prefix}`;
  if (policy.unlisted.length) return "outside the allow-list";
  return null;
}

/* ─────────────────────────────────── the audit ──────────────────────────── */

/** `[since, until)` as Dates, so a PR merged exactly at `until` belongs to
 *  next week's window and never to both. A `merged_at` that does not parse is
 *  treated as "never merged", which is the fail-safe reading for a ledger of
 *  things that DID merge: it falls out of the window rather than into it. */
function mergedInWindow(mergedAt, since, until) {
  if (mergedAt == null) return false;
  const t = Date.parse(mergedAt);
  if (Number.isNaN(t)) return false;
  return t >= Date.parse(since) && t < Date.parse(until);
}

/**
 * -> { rows, zeroReview, governed }
 *
 * `humanReviewed` is true when ANY of three things is true, each a different
 * kind of evidence that a person read the PR:
 *   - an APPROVED review exists (a review, from anyone);
 *   - the founder-approved label is on it (the path-policy's own marker for
 *     "a founder read this governed PR");
 *   - the merging login is a founder's human account (`isFounderLogin`: on
 *     AUTOMERGE_AUTHORS and not the bot), because a founder clicking merge is
 *     a read even when no review object was ever filed.
 * Anything else merged unread, which is exactly what auto-merge is for, and
 * exactly what the headline counts.
 *
 * `governed` on a row is the list of its files that `pathProblemFn` flags, so
 * the report can SHOW the path rather than just a count.
 */
export function auditMergedPrs(
  prs,
  {
    since,
    until,
    pathProblemFn = governedReason,
    founderFn = isFounderLogin,
    approvalLabel = APPROVAL_LABEL,
  } = {}
) {
  if (typeof since !== "string" || typeof until !== "string") {
    throw new Error("auditMergedPrs needs ISO `since` and `until`");
  }
  const rows = [];
  for (const pr of prs ?? []) {
    if (!mergedInWindow(pr.merged_at, since, until)) continue;
    const files = Array.isArray(pr.files) ? pr.files : [];
    const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
    const labels = Array.isArray(pr.labels) ? pr.labels : [];
    const mergedBy = pr.merged_by?.login ?? "";
    const humanReviewed =
      reviews.some((r) => r?.state === "APPROVED") ||
      labels.some((l) => (l?.name ?? l) === approvalLabel) ||
      Boolean(founderFn(mergedBy));
    rows.push({
      number: pr.number,
      title: pr.title ?? "",
      url: pr.html_url ?? pr.url ?? "",
      author: pr.user?.login ?? "",
      mergedBy,
      mergedAt: pr.merged_at,
      files: files.length,
      humanReviewed,
      governed: files.filter((f) => pathProblemFn(f) != null),
    });
  }
  rows.sort((a, b) => a.number - b.number);
  return {
    rows,
    zeroReview: rows.filter((r) => !r.humanReviewed).length,
    governed: rows.filter((r) => r.governed.length).length,
  };
}

/* ──────────────────────────────────── floors ────────────────────────────── */

export const FLOORS_OPEN = "const FLOORS = {";
export const FLOORS_CLOSE = "\n};";

/** One floor line: `  "path/to/suite.test.mjs": 12,` with an optional trailing
 *  comment. The comma is part of the shape (every line in the block has one,
 *  including the last), so a stray number in a comment does not read as a floor. */
const FLOOR_LINE = /^\s*"([^"]+)":\s*(\d+)\s*,/gm;

/**
 * -> Map<suite, floor> from the `const FLOORS = {` … `};` block ONLY.
 *
 * Only that block, because suite-integrity.test.js also holds BACKEND_FLOORS
 * and SWIFT_FLOORS in the same `"path": N,` shape, and a drop there is a
 * different suite runner's business. Both markers are required: a file where
 * either has moved is a file this parser no longer understands, and guessing
 * would turn a parser change into a silent "no drops".
 */
export function parseFloors(text) {
  if (typeof text !== "string") throw new Error("parseFloors: expected the file's text");
  const open = text.indexOf(FLOORS_OPEN);
  if (open < 0) throw new Error(`parseFloors: no \`${FLOORS_OPEN}\` marker`);
  const close = text.indexOf(FLOORS_CLOSE, open + FLOORS_OPEN.length);
  if (close < 0) throw new Error("parseFloors: no closing `};` after the FLOORS marker");
  const block = text.slice(open + FLOORS_OPEN.length, close);
  const floors = new Map();
  for (const m of block.matchAll(FLOOR_LINE)) floors.set(m[1], Number(m[2]));
  return floors;
}

/**
 * -> [{ suite, before, after }] for every floor that FELL or VANISHED between
 * the two texts, sorted by suite. `after` is null when the line is gone.
 *
 * A floor that rose is good news and not reported; a suite that is new this
 * week has no `before` and is not a drop. The pattern worth surfacing (#129) is
 * the floor lowered in the same PR that removed the tests, which is invisible
 * to CI by construction because the floor and the count move together.
 */
export function floorDrops(beforeText, afterText) {
  const before = parseFloors(beforeText);
  const after = parseFloors(afterText);
  const drops = [];
  for (const [suite, was] of before) {
    const now = after.has(suite) ? after.get(suite) : null;
    if (now === null || now < was) drops.push({ suite, before: was, after: now });
  }
  drops.sort((a, b) => (a.suite < b.suite ? -1 : a.suite > b.suite ? 1 : 0));
  return drops;
}

/* ─────────────────────────────────── rendering ──────────────────────────── */

const day = (iso) => String(iso).slice(0, 10);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function headline(audit) {
  const { rows, zeroReview, governed } = audit;
  return `**${rows.length} PRs merged, ${zeroReview} with zero human review, ${governed} touching a governed path.**`;
}

/**
 * GitHub rejects an issue comment longer than 65,536 characters (422), and
 * the workflow's retry cannot make a too-long body shorter: the week would end
 * as "FAILED before it could report", on exactly the busy week the ledger is
 * for. The first real week (2026-09-24 → 10-01) rendered 164 PRs to 40,186
 * characters with one governed row of 3,436, so the cap is one busy week
 * away. `BODY_BUDGET_CHARS` leaves headroom under the cap; `renderReport`
 * compacts the table rather than exceed it (see there).
 */
export const COMMENT_MAX_CHARS = 65536;
export const BODY_BUDGET_CHARS = 60000;
/** How many governed paths a compacted row still lists before "… +N more". */
export const GOVERNED_PATHS_SHOWN = 8;

function tableRow(r) {
  return `| [#${r.number}](${r.url}) | ${cell(r.title)} | ${cell(r.author)} | ${cell(r.mergedBy)} | ${r.files} | ${r.humanReviewed ? "yes" : "**none**"} | ${r.governed.length ? r.governed.map(cell).join("<br>") : "—"} |`;
}

const byNumber = (rows) => rows.map((r) => `#${r.number}`).join(", ");

/**
 * The body, from an explicit split of the rows: `table` gets a line each,
 * `reviewedByNumber` (level 1 below) and `didNotFit` (level 2) are listed by
 * number only, each under a sentence that says why. With everything in
 * `table` and both lists empty this is the plain, uncompacted report.
 */
function renderBody({ since, until, audit, drops, freeze, table, reviewedByNumber, didNotFit }) {
  const lines = [
    `## Weekly merge audit — ${day(since)} → ${day(until)}`,
    "",
    headline(audit),
    "",
    "| PR | title | author | merged by | files | human review | governed paths |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of table) lines.push(tableRow(r));
  if (!audit.rows.length) lines.push("| — | no PRs merged in this window | | | | | |");
  if (reviewedByNumber.length) {
    lines.push(
      "",
      `_Compacted: the full ledger would exceed GitHub's comment limit. ${reviewedByNumber.length} PR(s) with a human review and no governed path are listed by number only:_ ${byNumber(reviewedByNumber)}`
    );
  }
  if (didNotFit.length) {
    lines.push(
      "",
      `**${didNotFit.length} PR(s) that NEED a read did not fit in the table above — by number, read them from the PR list:** ${byNumber(didNotFit)}`
    );
  }
  lines.push("", "### Floors");
  return finishBody(lines, { drops, freeze });
}

/**
 * The comment body. Headline first, then the number that matters in bold,
 * then the ledger, floors, the kill switch, and `_audit ok_` as the LAST line,
 * so a truncated or half-rendered body is distinguishable from a complete one
 * by looking at its tail.
 *
 * Size: a body within `maxChars` is rendered in full and byte-for-byte as
 * before. Over it, two levels, each only as far as needed, and the headline's
 * three counts never change:
 *   1. rows that have a human review AND no governed path (the ones the
 *      ledger exists to count, not to read) collapse into one by-number line,
 *      and a row's governed list is capped at `GOVERNED_PATHS_SHOWN` paths;
 *   2. if that still does not fit, table rows move from the bottom into a
 *      second, bold by-number line that says they NEED a read.
 * Numbers autolink in a same-repo comment, so nothing is lost, only its row.
 */
export function renderReport({ since, until, audit, drops, freeze, maxChars = BODY_BUDGET_CHARS }) {
  const base = { since, until, audit, drops, freeze };
  const full = renderBody({ ...base, table: audit.rows, reviewedByNumber: [], didNotFit: [] });
  if (full.length <= maxChars) return full;

  // Level 1.
  const needsALine = (r) => !r.humanReviewed || r.governed.length > 0;
  const capPaths = (r) =>
    r.governed.length > GOVERNED_PATHS_SHOWN
      ? { ...r, governed: [...r.governed.slice(0, GOVERNED_PATHS_SHOWN), `… +${r.governed.length - GOVERNED_PATHS_SHOWN} more`] }
      : r;
  const table = audit.rows.filter(needsALine).map(capPaths);
  const reviewedByNumber = audit.rows.filter((r) => !needsALine(r));
  let body = renderBody({ ...base, table, reviewedByNumber, didNotFit: [] });
  if (body.length <= maxChars) return body;

  // Level 2: shed rows from the bottom (the highest numbers) until it fits.
  const didNotFit = [];
  while (table.length && body.length > maxChars) {
    didNotFit.unshift(table.pop());
    body = renderBody({ ...base, table, reviewedByNumber, didNotFit });
  }
  return body;
}

function finishBody(lines, { drops, freeze }) {
  if (drops?.length) {
    for (const d of drops) lines.push(`- \`${d.suite}\`: ${d.before} → ${d.after === null ? "removed" : d.after}`);
  } else {
    lines.push("- none lowered or removed");
  }
  lines.push("", "### Kill switch");
  lines.push(
    isFreezeActive(freeze)
      ? `AUTOMERGE_FREEZE is set ("${String(freeze).trim()}") — auto-merge is halted`
      : "AUTOMERGE_FREEZE is not set"
  );
  lines.push("", "_audit ok_");
  return lines.join("\n") + "\n";
}

/** What gets posted when the audit itself broke. Says FAILED, names the step,
 *  and says in words that this week is unaudited, because the alternative, a
 *  missing comment, reads as "nothing to report". */
export function renderFailure(err, { step } = {}) {
  const msg = String(err?.message ?? err ?? "unknown error").split(/\r?\n/)[0];
  return [
    "## Weekly merge audit — FAILED",
    "",
    `The audit did not run to completion at step \`${step ?? "unknown"}\`: ${msg}`,
    "",
    "A false all-clear is worse than no audit; treat this week as unaudited.",
    "",
  ].join("\n");
}

/* ───────────────────────────────────── CLI ──────────────────────────────── */

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function need(argv, name) {
  const v = arg(argv, name);
  if (v === null) throw new Error(`missing ${name}`);
  return v;
}

/**
 * -> { code, out, err }. Pure over `io` so the test can run it in-process; the
 * guard at the bottom wires it to the real fs and process.
 *
 * Every phase sets `step` before it can throw, so the FAILED body names where
 * the audit died (`read prs`, `parse floors`, …) rather than just that it did.
 * The body is written to `--out` on failure too, when `--out` was given and
 * is itself writable; if writing the failure fails there is nothing left to
 * do but say so on stderr and exit 1.
 */
export function run(argv, io = {}) {
  const read = io.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const write = io.writeFile ?? ((p, s) => fs.writeFileSync(p, s));
  const outPath = arg(argv, "--out");
  let step = "arguments";
  try {
    const since = need(argv, "--since");
    const until = need(argv, "--until");
    if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
      throw new Error("--since and --until must be ISO dates");
    }
    const freeze = arg(argv, "--freeze") ?? "";

    step = "read prs";
    const prs = JSON.parse(read(need(argv, "--prs")));
    if (!Array.isArray(prs)) throw new Error("--prs must be a JSON array of pull objects");

    step = "read floors";
    const beforeText = read(need(argv, "--floors-before"));
    const afterText = read(need(argv, "--floors-after"));

    step = "audit";
    const audit = auditMergedPrs(prs, { since, until });

    step = "parse floors";
    const drops = floorDrops(beforeText, afterText);

    step = "render";
    const body = renderReport({ since, until, audit, drops, freeze });

    step = "write";
    if (outPath) write(outPath, body);

    let out = headline(audit) + "\n";
    if (argv.includes("--json")) {
      out += JSON.stringify({ rows: audit.rows, zeroReview: audit.zeroReview, governed: audit.governed, drops }) + "\n";
    }
    return { code: 0, out, err: "" };
  } catch (err) {
    const body = renderFailure(err, { step });
    let note = "";
    if (outPath) {
      try {
        write(outPath, body);
      } catch (e) {
        note = `could not write the FAILED body to ${outPath}: ${e.message}\n`;
      }
    }
    return { code: 1, out: "", err: `::error::merge audit FAILED at step ${step}: ${err?.message ?? err}\n${note}` };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { code, out, err } = run(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exit(code);
}
