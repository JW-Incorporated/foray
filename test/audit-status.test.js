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

/* ---------- round 2 (docs/audit/round-2/, 2026-09-23) ----------
   The same three promises for the re-run's ledger, which round 1's tests could
   not see (they read only docs/audit/*.tsv). One difference: round 2 kept two
   UNCERTAIN verdicts, and an uncertain row may move once it is re-verified
   (native-1 became reachable, then closed, during the round) — so "uncertain"
   is a disposition here, and the verdict test lets an uncertain row become
   refuted-now, fixed or deferred-device, but never simply vanish into "open".
   MUTATION: delete a row from round-2/status.tsv -> the first test goes red;
   mark a deliberate row "fixed" -> the second; edit a README count -> the third. */
const R2 = (f) => fs.readFileSync(path.join(DIR, "round-2", f), "utf8").replace(/\r\n/g, "\n");
const R2_FINDINGS = R2("findings.tsv").trimEnd().split("\n").slice(1).map((l) => {
  const c = l.split("\t");
  return { id: c[0], verdict: c[2], title: c[5] };
});
const [R2_HEAD, ...R2_ROWS] = R2("status.tsv").trimEnd().split("\n").map((l) => l.split("\t"));
const R2_STATUS = R2_ROWS.map(([id, title, disposition, where, note]) => ({ id, title, disposition, where, note }));
const R2_DISPOSITIONS = new Set([...DISPOSITIONS, "uncertain"]);

test("round 2: every finding has exactly one status row, under its own title", () => {
  assert.deepEqual(R2_HEAD, ["id", "title", "disposition", "where", "note"]);
  const seen = new Map();
  for (const s of R2_STATUS) {
    assert.ok(!seen.has(s.id), `${s.id} has two status rows`);
    seen.set(s.id, s);
    assert.ok(R2_DISPOSITIONS.has(s.disposition), `${s.id}: "${s.disposition}" is not a disposition`);
    assert.ok(s.where && s.note, `${s.id} says neither where nor why`);
  }
  for (const f of R2_FINDINGS) {
    const s = seen.get(f.id);
    assert.ok(s, `${f.id} ("${f.title.slice(0, 60)}") has no status row`);
    assert.equal(s.title, f.title.trim(), `${f.id}: the status row names a different finding`);
  }
  assert.equal(R2_STATUS.length, R2_FINDINGS.length, "the ledger has rows for findings that do not exist");
});

test("round 2: a refuted or deliberate verdict is kept, and an uncertain one is kept or re-verified", () => {
  const byId = new Map(R2_STATUS.map((s) => [s.id, s]));
  for (const f of R2_FINDINGS) {
    const d = byId.get(f.id).disposition;
    if (f.verdict === "refuted") assert.equal(d, "refuted", f.id);
    else if (f.verdict === "deliberate") assert.equal(d, "deliberate", f.id);
    else if (f.verdict === "uncertain") {
      assert.ok(["uncertain", "refuted-now", "fixed", "deferred-device"].includes(d), `${f.id}: an uncertain verdict became "${d}"`);
    } else {
      assert.equal(f.verdict, "confirmed", `${f.id}: an unknown verdict "${f.verdict}"`);
      assert.ok(!["refuted", "deliberate", "uncertain"].includes(d), `${f.id}: a confirmed finding cannot take the verifier's "${d}"`);
    }
  }
});

test("round 2: the README's STATUS table agrees with the ledger", () => {
  const readme = R2("README.md");
  const status = readme.slice(readme.indexOf("## STATUS"));
  assert.ok(status.length > 20, "round-2 README has no STATUS section");
  for (const d of R2_DISPOSITIONS) {
    const line = status.split("\n").find((l) => l.startsWith(`| ${d} `));
    assert.ok(line, `round-2 README's STATUS table has no "${d}" row`);
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    assert.equal(Number(cells[1]), R2_STATUS.filter((s) => s.disposition === d).length, `README row "${d}"`);
  }
  const all = status.split("\n").find((l) => /^\| \*\*all rows\*\*/.test(l));
  assert.ok(all, "round-2 README's STATUS table has no all-rows line");
  assert.equal(Number(all.split("|").map((c) => c.trim()).filter(Boolean)[1].replace(/\*/g, "")), R2_STATUS.length);
});

/* ---------- round 3 (docs/audit/round-3-code/, 2026-09-25) ----------
   The code audit's ledger, held to the same three promises. Round 3 has no
   uncertain verdicts; its L7 lane ships in its own PR (#821, and the held
   #822), so the README table also counts the rows whose `where` names those,
   which keeps "fixed" from reading as "in the main fix PR" for them.
   MUTATION: delete a row from round-3-code/status.tsv -> the first test goes
   red; mark a refuted row "fixed" -> the second; edit a README count (either
   column) -> the third. Each was run. */
const R3 = (f) => fs.readFileSync(path.join(DIR, "round-3-code", f), "utf8").replace(/\r\n/g, "\n");
const R3_FINDINGS = R3("findings.tsv").replace(/\n+$/, "").split("\n").slice(1).map((l) => {
  const c = l.split("\t");
  return { id: c[0], verdict: c[3], title: c[6] };
});
const [R3_HEAD, ...R3_ROWS] = R3("status.tsv").trimEnd().split("\n").map((l) => l.split("\t"));
const R3_STATUS = R3_ROWS.map(([id, title, disposition, where, note]) => ({ id, title, disposition, where, note }));
const inL7Pr = (s) => /#82[12]\b/.test(s.where);

test("round 3: every finding has exactly one status row, under its own title", () => {
  assert.deepEqual(R3_HEAD, ["id", "title", "disposition", "where", "note"]);
  assert.equal(R3_FINDINGS.length, 186, "round 3 verified 186 findings");
  const seen = new Map();
  for (const s of R3_STATUS) {
    assert.ok(!seen.has(s.id), `${s.id} has two status rows`);
    seen.set(s.id, s);
    assert.ok(DISPOSITIONS.has(s.disposition), `${s.id}: "${s.disposition}" is not a disposition`);
    assert.ok(s.where && s.note, `${s.id} says neither where nor why`);
  }
  for (const f of R3_FINDINGS) {
    const s = seen.get(f.id);
    assert.ok(s, `${f.id} ("${f.title.slice(0, 60)}") has no status row`);
    assert.equal(s.title, f.title.trim(), `${f.id}: the status row names a different finding`);
  }
  assert.equal(R3_STATUS.length, R3_FINDINGS.length, "the ledger has rows for findings that do not exist");
});

test("round 3: a refuted or deliberate verdict is kept, and a confirmed finding never takes one", () => {
  const byId = new Map(R3_STATUS.map((s) => [s.id, s]));
  for (const f of R3_FINDINGS) {
    const d = byId.get(f.id).disposition;
    if (f.verdict === "refuted") assert.equal(d, "refuted", f.id);
    else if (f.verdict === "deliberate") assert.equal(d, "deliberate", f.id);
    else {
      assert.equal(f.verdict, "confirmed", `${f.id}: an unknown verdict "${f.verdict}"`);
      assert.ok(!["refuted", "deliberate"].includes(d), `${f.id}: a confirmed finding cannot take the verifier's "${d}"`);
    }
  }
});

test("round 3: the README's STATUS table agrees with the ledger", () => {
  const readme = R3("README.md");
  const status = readme.slice(readme.indexOf("## STATUS"));
  assert.ok(status.length > 20, "round-3 README has no STATUS section");
  for (const d of DISPOSITIONS) {
    const line = status.split("\n").find((l) => l.startsWith(`| ${d} `));
    assert.ok(line, `round-3 README's STATUS table has no "${d}" row`);
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    const rows = R3_STATUS.filter((s) => s.disposition === d);
    assert.deepEqual([Number(cells[1]), Number(cells[2])], [rows.length, rows.filter(inL7Pr).length], `README row "${d}"`);
  }
  const all = status.split("\n").find((l) => /^\| \*\*all rows\*\*/.test(l));
  assert.ok(all, "round-3 README's STATUS table has no all-rows line");
  const cells = all.split("|").map((c) => c.trim()).filter(Boolean).map((c) => Number(c.replace(/\*/g, "")));
  assert.deepEqual(cells.slice(1), [R3_STATUS.length, R3_STATUS.filter(inL7Pr).length]);
});
