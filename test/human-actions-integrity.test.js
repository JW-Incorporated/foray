/* Guard on HUMAN-ACTIONS.md's own numbering rule.
 *
 * WHY THIS EXISTS. The file's own header says item numbers are stable IDs:
 * "never reused, never renumbered, so #1 means the same thing forever". A
 * full-repo review (2026-08-31, finding L3) found #26 reused for two
 * different actions ("Publish the Play Store listing" and "Back up the
 * Android upload key"), which is exactly the drift the rule exists to
 * prevent and which nothing here was catching. This test parses every item
 * heading in the file and fails if any numeric ID appears more than once.
 *
 * FORMAT V2 (2026-09-11): the `### N. ...` heading and the in-file `## DONE`
 * section are gone. Open items now live in `HUMAN-ACTIONS.md` as
 * `## #<N> <glyph> [<KIND>] <title> (~<eta>)` headings; closed items move
 * entirely to a sibling machine ledger, `HUMAN-ACTIONS-DONE.md`, one line
 * each (`- #<N> · <date> · done|skip · <title> — "<note>" · by <who>`). The
 * machine contract (ARCHITECTURE-decision.md §3) is explicit that a
 * duplicate `N` *across* the two files is exactly as much a numbering-reuse
 * bug as a duplicate within one of them — closing an item does not free its
 * number — so this test now checks both files, and checks them against each
 * other, rather than only re-checking the one file the old format kept
 * everything in.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const OPEN_FILE = path.join(__dirname, "..", "HUMAN-ACTIONS.md");
const DONE_FILE = path.join(__dirname, "..", "HUMAN-ACTIONS-DONE.md");

const OPEN_HEADING_RE = /^##\s+#(\d+)\b/;
const LEDGER_LINE_RE = /^-\s+#(\d+)\s+·/;

function openIds() {
  const text = fs.readFileSync(OPEN_FILE, "utf8");
  const ids = [];
  for (const line of text.split("\n")) {
    const m = OPEN_HEADING_RE.exec(line);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function ledgerIds() {
  const text = fs.readFileSync(DONE_FILE, "utf8");
  const ids = [];
  for (const line of text.split("\n")) {
    const m = LEDGER_LINE_RE.exec(line);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function dupesOf(ids) {
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
}

test("HUMAN-ACTIONS.md has at least one numbered open item", () => {
  const ids = openIds();
  assert.ok(ids.length > 0, "expected `## #N ...` headings in HUMAN-ACTIONS.md");
});

test("HUMAN-ACTIONS-DONE.md has at least one numbered ledger entry", () => {
  const ids = ledgerIds();
  assert.ok(ids.length > 0, "expected `- #N · ...` lines in HUMAN-ACTIONS-DONE.md");
});

test("HUMAN-ACTIONS.md item numbers are never reused within the open file", () => {
  const dupes = dupesOf(openIds());
  assert.deepEqual(
    dupes,
    [],
    `HUMAN-ACTIONS.md reuses item number(s) ${dupes.join(", ")} — ` +
      "item numbers are stable IDs per the file's own header and must never " +
      "repeat; give the later block the next unused number instead."
  );
});

test("HUMAN-ACTIONS-DONE.md item numbers are never reused within the ledger", () => {
  const dupes = dupesOf(ledgerIds());
  assert.deepEqual(
    dupes,
    [],
    `HUMAN-ACTIONS-DONE.md reuses item number(s) ${dupes.join(", ")} — ` +
      "ledger numbers are never reused either; give the later entry the next " +
      "unused number instead."
  );
});

test("no item number is reused across the open file and the ledger", () => {
  const open = new Set(openIds());
  const closed = new Set(ledgerIds());
  const both = [...open].filter((id) => closed.has(id));
  assert.deepEqual(
    both,
    [],
    `item number(s) ${both.join(", ")} appear in BOTH HUMAN-ACTIONS.md and ` +
      "HUMAN-ACTIONS-DONE.md — closing an item does not free its number; the " +
      "allocator is max(N in the open file union N in the ledger) + 1, never " +
      "a number already used by either file."
  );
});

/* The founder queue and the coordination board may not send anyone to a Foray
 * that data/ no longer carries (PR #741 review). Retiring `grilling-history-1`
 * left open item #2's "Worked if" asking for a status on a record that no
 * longer existed, and STATE.md's "Open it at" link opening nothing — the owner
 * following either would get nowhere, and nothing noticed.
 *
 * A RETIRED Foray is one the frozen fixture (tools/foray/fixtures/frozen, which
 * keeps real Forays verbatim after they leave data/) knows and data/forays.json
 * does not. A line may still name one, but only to say it was retired; and
 * every `?foray=<id>` link must open a Foray data/ still carries.
 *
 * MUTATION: put `?foray=grilling-history-1` back in STATE.md, or point item
 * #2's "Worked if" at `grilling-history-1` again -> red, naming the line. */
test("HUMAN-ACTIONS.md and STATE.md point at no retired Foray", () => {
  const root = path.join(__dirname, "..");
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const live = new Set(read("data/forays.json").forays.map((f) => f.id));
  const frozen = read("tools/foray/fixtures/frozen/data/forays.json").forays.map((f) => f.id);
  const retired = frozen.filter((id) => !live.has(id));
  const problems = [];
  for (const file of ["HUMAN-ACTIONS.md", "STATE.md"]) {
    fs.readFileSync(path.join(root, file), "utf8").split("\n").forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      for (const id of retired) {
        if (new RegExp(`(^|[^a-z0-9-])${id}($|[^a-z0-9-])`).test(line) && !/retired/i.test(line)) {
          problems.push(`${where} names ${id}, which data/forays.json no longer carries, without saying it was retired`);
        }
      }
      for (const m of line.matchAll(/[?&]foray=([a-z0-9][a-z0-9-]*)/g)) {
        if (!live.has(m[1])) problems.push(`${where} links ?foray=${m[1]}, which data/forays.json does not carry`);
      }
    });
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
