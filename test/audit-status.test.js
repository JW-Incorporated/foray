/* docs/audit/status.tsv accounts for every audit finding, once (2026-09-23).
 *
 * The 2026-09-22 audit's findings were nearly lost once (docs/audit/README.md,
 * "WHY THIS DIRECTORY EXISTS AT ALL"). The status ledger is the record of what
 * became of each of them, and a ledger that silently drops a row reads as
 * "done" for a finding nobody touched. So: every finding row of both TSVs has
 * exactly one status row with the same title, every disposition is one of the
 * agreed words, a finding the verifier refuted or called deliberate keeps that
 * verdict, and the README's count table agrees with the ledger.
 *
 * MUTATION: delete any one row from status.tsv -> the first test goes red;
 * change a refuted row's disposition to "fixed" -> the second goes red; edit
 * one number in the README table -> the third goes red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "docs", "audit");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");

const DISPOSITIONS = new Set([
  "fixed", "already-fixed", "refuted", "deliberate", "refuted-now",
  "deferred-founder", "deferred-device", "open",
]);

function findings(src) {
  return read(`${src}-findings.tsv`).split("\n").map((line, i) => {
    const c = line.split("\t");
    return c.length >= 6 ? { src, row: i + 1, verdict: c[1], title: c[5] } : null;
  }).filter(Boolean);
}

const FINDINGS = [...findings("qa"), ...findings("persona")];
const [HEAD, ...ROWS] = read("status.tsv").trimEnd().split("\n").map((l) => l.split("\t"));
const STATUS = ROWS.map(([src, row, title, disposition, where, note]) =>
  ({ src, row: Number(row), title, disposition, where, note }));

test("every audit finding has exactly one status row, under its own title", () => {
  assert.deepEqual(HEAD, ["src", "tsvRow", "title", "disposition", "where", "note"]);
  const seen = new Map();
  for (const s of STATUS) {
    const k = `${s.src}:${s.row}`;
    assert.ok(!seen.has(k), `${k} has two status rows`);
    seen.set(k, s);
    assert.ok(DISPOSITIONS.has(s.disposition), `${k}: "${s.disposition}" is not a disposition`);
    assert.ok(s.where && s.note, `${k} says neither where nor why`);
  }
  for (const f of FINDINGS) {
    const s = seen.get(`${f.src}:${f.row}`);
    assert.ok(s, `${f.src} row ${f.row} ("${f.title.slice(0, 60)}") has no status row`);
    assert.equal(s.title, f.title.trim(), `${f.src} row ${f.row}: the status row names a different finding`);
  }
  assert.equal(STATUS.length, FINDINGS.length, "the ledger has rows for findings that do not exist");
});

test("a finding the verifier refuted or called deliberate keeps that verdict", () => {
  const byKey = new Map(STATUS.map((s) => [`${s.src}:${s.row}`, s]));
  for (const f of FINDINGS) {
    const s = byKey.get(`${f.src}:${f.row}`);
    if (f.verdict === "refuted") assert.equal(s.disposition, "refuted", `${f.src} ${f.row}`);
    if (f.verdict === "deliberate_choice") assert.equal(s.disposition, "deliberate", `${f.src} ${f.row}`);
  }
});

test("the README's STATUS table agrees with the ledger", () => {
  const readme = read("README.md");
  const count = (src, d) => STATUS.filter((s) => s.src === src && s.disposition === d).length;
  const rows = {
    "fixed": ["fixed"],
    "already-fixed": ["already-fixed"],
    "refuted": ["refuted"],
    "deliberate": ["deliberate"],
    "deferred-founder": ["deferred-founder"],
    "deferred-device": ["deferred-device"],
    "open": ["open"],
  };
  for (const [label, ds] of Object.entries(rows)) {
    const line = readme.split("\n").find((l) => l.startsWith(`| ${label}`));
    assert.ok(line, `README's STATUS table has no "${label}" row`);
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    const num = (v) => (v === "—" ? 0 : Number(v));
    const qa = ds.reduce((n, d) => n + count("qa", d), 0);
    const pe = ds.reduce((n, d) => n + count("persona", d), 0);
    assert.deepEqual([num(cells[1]), num(cells[2]), num(cells[3])], [qa, pe, qa + pe], `README row "${label}"`);
  }
});
