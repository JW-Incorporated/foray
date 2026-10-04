/* The ad-pad stamper (tools/segments/stamp-ad-pad.mjs, DAI-03). Run:
   node --test tools/segments/stamp-ad-pad.test.mjs

   Every test names the one-line mutation that turns it red. Fixtures are
   inline; nothing here reads or writes live data/. */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAMPED_FIELDS, stampSources, checkSources, serialise } from "./stamp-ad-pad.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools", "segments", "stamp-ad-pad.mjs");

const row = (id, extra = {}) => ({
  id,
  show: "A Show",
  audio_url: `https://media.example.com/${id}.mp3`,
  duration_sec: 2400,
  dai_suspected: true,
  ...extra,
});
const decode = (item_id, delta, at) => ({
  item_id, probed_at: at, method: "decode", decoded_duration_sec: 2400 + delta,
});
const doc = (...sources) => ({ version: 1, built_at: "2026-10-01T00:00:00Z", notes: "n", provenance: {}, sources });
const ledger = (...probes) => ({ version: 1, notes: "n", probes });
const gastropod = ledger(
  decode("ep-1", 66.1, "2026-10-01T00:00:00Z"),
  decode("ep-1", 32.7, "2026-10-03T00:00:00Z"),
);
const without = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

test("a source with two usable probes gets the seven stamped fields and nothing else changes", () => {
  // MUTATION: write `ad_pad_sec = r.delta_max_sec` -> 66.1, not 99.5.
  const input = doc(row("ep-1", { ad_free_ratio: 1 }), row("ep-2"));
  const before = structuredClone(input);
  const out = stampSources(input, gastropod);
  assert.deepEqual(out.stamped, ["ep-1"]);
  assert.deepEqual(out.refused, []);
  assert.deepEqual(out.untouched, []);
  const stamped = out.doc.sources[0];
  assert.deepEqual(
    Object.fromEntries(STAMPED_FIELDS.map((f) => [f, stamped[f]])),
    {
      ad_delta_sec: 66.1,
      ad_delta_probes: 2,
      ad_delta_spread_sec: 33.4,
      ad_pad_sec: 99.5,
      ad_tier: "PADDABLE",
      ad_pad_method: "decode",
      ad_pad_measured_at: "2026-10-03T00:00:00Z",
    },
  );
  assert.equal(STAMPED_FIELDS.length, 7);
  assert.ok(!STAMPED_FIELDS.includes("ad_free_ratio"), "the legacy field is never stamped");
  assert.deepEqual(without(stamped, STAMPED_FIELDS), before.sources[0], "the legacy ad_free_ratio survives");
  assert.deepEqual(out.doc.sources[1], before.sources[1], "a row the ledger does not name is untouched");
  assert.deepEqual(without(out.doc, ["sources"]), without(before, ["sources"]));
  assert.deepEqual(input, before, "the input doc is not mutated");
});

test("a source with one probe is listed as refused and its row is deep-equal to the input", () => {
  // MUTATION: in stampSources, drop the `continue` after pushing a refusal -> the row is stamped with undefineds.
  const input = doc(row("ep-1", { ad_pad_sec: 10, ad_tier: "PADDABLE" }));
  const out = stampSources(input, ledger(decode("ep-1", 30, "2026-10-01T00:00:00Z")));
  assert.deepEqual(out.stamped, []);
  assert.deepEqual(out.refused, [{ item_id: "ep-1", reason: "n<2" }]);
  assert.deepEqual(out.doc.sources[0], input.sources[0]);
});

test("a ledger item_id with no source row is ignored, not invented", () => {
  // MUTATION: `if (!row) { untouched.push(itemId); continue; }` -> push a new row instead -> two rows.
  const input = doc(row("ep-1"));
  const out = stampSources(input, ledger(decode("ep-9", 10, "2026-10-01T00:00:00Z"), decode("ep-9", 12, "2026-10-02T00:00:00Z")));
  assert.equal(out.doc.sources.length, 1);
  assert.deepEqual(out.doc.sources, input.sources);
  assert.deepEqual(out.untouched, ["ep-9"]);
  assert.deepEqual(out.stamped, []);
});

test("a row without duration_sec is refused with reason no duration_sec", () => {
  // MUTATION: drop the duration guard in recompute -> padFromProbes throws a TypeError instead of a refusal.
  for (const bad of [undefined, 0, -1, "2400", Infinity]) {
    const input = doc(row("ep-1", { duration_sec: bad }));
    const out = stampSources(input, gastropod);
    assert.deepEqual(out.refused, [{ item_id: "ep-1", reason: "no duration_sec" }], String(bad));
    assert.deepEqual(out.doc.sources[0], input.sources[0]);
    assert.deepEqual(checkSources(input, gastropod), [], "the check skips what the writer refuses");
  }
});

test("checkSources reports a drifted spread and is silent on a faithful row", () => {
  // MUTATION: loop over ["ad_pad_sec"] instead of STAMPED_FIELDS -> the drifted spread goes unreported.
  const faithful = stampSources(doc(row("ep-1", { ad_free_ratio: 0.5 }), row("ep-2")), gastropod).doc;
  assert.deepEqual(checkSources(faithful, gastropod), []);
  // Numbers agree after rounding to 0.1; the legacy field is never compared.
  faithful.sources[0].ad_pad_sec = 99.54;
  assert.deepEqual(checkSources(faithful, gastropod), []);

  const drifted = structuredClone(faithful);
  drifted.sources[0].ad_delta_spread_sec = 30;
  drifted.sources[0].ad_pad_measured_at = "2026-10-02T00:00:00Z";
  assert.deepEqual(checkSources(drifted, gastropod), [
    { item_id: "ep-1", field: "ad_delta_spread_sec", committed: 30, recomputed: 33.4 },
    { item_id: "ep-1", field: "ad_pad_measured_at", committed: "2026-10-02T00:00:00Z", recomputed: "2026-10-03T00:00:00Z" },
  ]);
  // A hand-authored row the ledger does not name is skipped, whatever it says.
  const hand = doc(row("ep-2", { ad_pad_sec: 7, ad_tier: "PADDABLE" }));
  assert.deepEqual(checkSources(hand, gastropod), []);
});

test("an unstamped row named by a usable ledger is drift on all seven fields", () => {
  // MUTATION: in checkSources, `if (r.refused) continue;` -> `if (!r.refused) continue;` -> silent.
  const drift = checkSources(doc(row("ep-1")), gastropod);
  assert.deepEqual(drift.map((d) => d.field), [...STAMPED_FIELDS]);
  assert.ok(drift.every((d) => d.committed === undefined));
});

test("the writer preserves key order and the trailing newline", () => {
  // MUTATION: in stampSources, `delete row[field]` before assigning -> stamped keys move to the row's end.
  const input = doc(row("ep-1", { ad_pad_sec: 1, ad_tier: "PADDABLE", seek_map: "cbr" }));
  const out = stampSources(input, gastropod);
  const keys = Object.keys(out.doc.sources[0]);
  assert.deepEqual(keys.slice(0, Object.keys(input.sources[0]).length), Object.keys(input.sources[0]));
  assert.deepEqual(keys.slice(-5), ["ad_delta_sec", "ad_delta_probes", "ad_delta_spread_sec", "ad_pad_method", "ad_pad_measured_at"]);
  const text = serialise(out.doc);
  assert.equal(text.at(-1), "\n");
  assert.equal(text, JSON.stringify(out.doc, null, 2) + "\n");
  assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(input));
});

test("the CLI --dry-run writes nothing", () => {
  // MUTATION: drop `if (flags.has("--dry-run")) return 0;` -> the sources file is rewritten with the stamp.
  const dir = mkdtempSync(join(tmpdir(), "stamp-ad-pad-"));
  try {
    const ledgerPath = join(dir, "ledger.json");
    const sourcesPath = join(dir, "sources.json");
    const ledgerText = JSON.stringify(gastropod, null, 2) + "\n";
    const sourcesText = JSON.stringify(doc(row("ep-1")), null, 2) + "\n";
    writeFileSync(ledgerPath, ledgerText);
    writeFileSync(sourcesPath, sourcesText);
    const r = spawnSync(process.execPath, [SCRIPT, "--dry-run"], {
      cwd: ROOT,
      env: { ...process.env, AD_PAD_LEDGER: ledgerPath, SEGMENT_SOURCES: sourcesPath },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^stamped ep-1 pad=99\.5s tier=PADDABLE n=2$/m);
    assert.equal(readFileSync(sourcesPath, "utf8"), sourcesText);
    assert.equal(readFileSync(ledgerPath, "utf8"), ledgerText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
