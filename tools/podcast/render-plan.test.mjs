/* tools/podcast/render-plan.mjs, offline. Every test names the mutation it kills
 * and RUNS it: the module's source is rewritten in memory, imported from a temp
 * file, and the test's own check must fail on the mutant while passing on the real
 * module. A mutant that survives fails loudly ("SURVIVED"). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as real from "./render-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SRC = fs.readFileSync(path.join(HERE, "render-plan.mjs"), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mut-"));
let n = 0;

async function mutant(from, to) {
  assert.ok(SRC.includes(from), `mutation anchor not found: ${from}`);
  const file = path.join(TMP, `m${n++}.mjs`);
  /* The copy lives in a temp dir, so its one relative import is pinned to the real file. */
  const entry = JSON.stringify(pathToFileURL(path.join(HERE, "..", "ci", "entry.mjs")).href);
  fs.writeFileSync(file, SRC.replace(from, to).replace('"../ci/entry.mjs"', entry));
  return import(pathToFileURL(file).href);
}

/* check(mod) holds on the real module and must throw on the mutant. */
async function kills(from, to, check) {
  check(real);
  const m = await mutant(from, to);
  assert.throws(() => check(m), undefined, `SURVIVED: ${from} -> ${to}`);
}

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const episode = readJson("data/podcast/episodes.json").episodes.find((e) => e.foray_id === "asteroids-flagship-1");

/* A 4-item fixture: narr, clip, clip, narr. */
const fx = (over = {}) => ({
  foray: {
    id: "f", title: "T", slots: [{ id: "s1", title: "Slot one" }],
    items: [
      { type: "narration", id: "n1", script: "Hello.", slot: "s1" },
      { type: "segment", label: "AA-1", segment_id: "src-a#10", slot: "s1" },
      { type: "segment", label: "BB-1", segment_id: "src-b#20", slot: "s1" },
      { type: "narration", id: "n2", script: "Bye.", slot: "s1" },
    ],
  },
  segments: [
    { id: "src-a#10", item_id: "src-a", start_sec: 10.5, end_sec: 20.25 },
    { id: "src-b#20", item_id: "src-b", start_sec: 20, end_sec: 30 },
  ],
  sources: [
    { id: "src-a", show: "Show A", title: "Ann Lee on Things", audio_url: "https://a.example/a.mp3", duration_sec: 100 },
    { id: "src-b", show: "Show B", title: "Episode B", audio_url: "https://b.example/b.mp3", duration_sec: 200 },
  ],
  episode: { title: "Ep", render: { chapter_titles: { n1: "One", n2: "Two" } } },
  ...over,
});

test("the real flagship plan reproduces the committed episode's chapter titles in order; mutation: chapters taken from clips, not narrations", async () => {
  const check = (m) => {
    const plan = m.loadPlan("asteroids-flagship-1", { root: ROOT });
    assert.deepEqual(plan.chapters.map((c) => c.title), episode.chapters.map((c) => c.title));
    assert.equal(plan.chapters.length, 14);
  };
  await kills('items.filter((x) => x.type === "narr").map((x) => ({ item', 'items.filter((x) => x.type === "clip").map((x) => ({ item', check);
});

test("the real flagship plan keeps the foray's item order (26 items, 12 clips) and the committed cut points; mutation: in/out swapped", async () => {
  const forays = readJson("data/forays.json").forays.find((f) => f.id === "asteroids-flagship-1");
  const segs = new Map(readJson("data/segments.json").segments.map((s) => [s.id, s]));
  const check = (m) => {
    const plan = m.loadPlan("asteroids-flagship-1", { root: ROOT });
    assert.equal(plan.items.length, 26);
    assert.deepEqual(plan.items.map((x) => (x.type === "narr" ? x.id : x.label)), forays.items.map((x) => (x.type === "narration" ? x.id : x.label)));
    for (const c of plan.items.filter((x) => x.type === "clip")) {
      const s = segs.get(c.segment_id);
      assert.equal(c.in, s.start_sec);
      assert.equal(c.out, s.end_sec);
    }
    assert.deepEqual(plan.warnings, []);
  };
  await kills("in: seg.start_sec, out: seg.end_sec", "in: seg.end_sec, out: seg.start_sec", check);
});

test("seam types: none before the first item, tape-tape between two clips; mutation: narr treated as tape in seamType", async () => {
  const check = (m) => {
    const plan = m.buildPlan(fx());
    assert.deepEqual(plan.items.map((x) => x.seam_before), [null, "narr-tape", "tape-tape", "tape-narr"]);
    assert.deepEqual(plan.seams, [{ before_item: 1, type: "narr-tape" }, { before_item: 2, type: "tape-tape" }, { before_item: 3, type: "tape-narr" }]);
  };
  await kills('`${prevType === "narr" ? "narr" : "tape"}-', '`${prevType === "narr" ? "tape" : "tape"}-', check);
});

test("a clip carries its enclosure URL, feed duration, show, speaker and title; mutation: speaker not parsed from the title", async () => {
  const check = (m) => {
    const c = m.buildPlan(fx()).items[1];
    assert.equal(c.url, "https://a.example/a.mp3");
    assert.equal(c.feed_duration_sec, 100);
    assert.equal(c.show, "Show A");
    assert.equal(c.speaker, "Ann Lee");
    assert.equal(m.buildPlan(fx()).items[2].speaker, "BB");
  };
  await kills("const m = / on /.exec(title || \"\");", "const m = null;", check);
});

test("a segment missing from segments.json is refused by name; mutation: the guard removed", async () => {
  const check = (m) => {
    const f = fx();
    f.segments = f.segments.slice(1);
    assert.throws(() => m.buildPlan(f), /AA-1: segment src-a#10 is not in data\/segments\.json/);
  };
  await kills("if (!seg) throw new Error(", "if (false) throw new Error(", check);
});

test("a narration without a stored chapter title falls back to its slot title and warns; mutation: the warning dropped", async () => {
  const check = (m) => {
    const f = fx({ episode: { title: "Ep", render: { chapter_titles: { n1: "One" } } } });
    const plan = m.buildPlan(f);
    assert.equal(plan.chapters[1].title, "Slot one");
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /n2/);
  };
  await kills("warnings.push(", "void (", check);
});

test("a reversed segment (end <= start) is refused; mutation: the range guard removed", async () => {
  const check = (m) => {
    const f = fx();
    f.segments[0].end_sec = 5;
    assert.throws(() => m.buildPlan(f), /end <= start/);
  };
  await kills("if (!(seg.end_sec > seg.start_sec)) throw", "if (false) throw", check);
});

test("the CLI exits 2 with no Foray id and 1 for an unknown one; mutation: the id requirement dropped", async () => {
  const quiet = (fn) => {
    const e = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = e; }
  };
  const check = (m) => {
    assert.equal(quiet(() => m.main([], ROOT)), 2);
    assert.equal(quiet(() => m.main(["no-such-foray"], ROOT)), 1);
  };
  await kills("if (args.help || !args.id) {", "if (args.help) {", check);
});
