/* Topic-uniformity ratchet (#560 item 3, the cheap half of #547).
   Run: node --test tools/refresh/topic-uniformity.test.mjs

   `tools/refresh/topic-uniformity.mjs` measures how many shows carry ONE topic
   set on every episode. It ran in no CI job, and the number drifted from PR
   #300's 68 of 99 to 71 of 115 and then 74 of 120 without anyone being told.
   This suite runs the same helpers (`uniformTopicShows`, `substantialShows`,
   `topicKey` from ./topics.mjs) over the REAL committed data/discover.json and
   data/catalog.json.

   WHY THIS IS NOT THE GATE topics.mjs WARNS AGAINST. That warning is about a
   gate that fails on any uniform show: a uniform label is a truth on a narrow
   show, so such a gate would be red on correct data forever. This suite never
   names a show as wrong. It holds two things:
     (a) a show marked `label_scope: "general"` is, by founder ruling
         (docs/roadmap/README.md item 24), one whose show label does NOT describe
         its episodes, so for those shows uniformity is a defect by definition;
     (b) the overall count may fall but not rise. A rise means a new or relabelled
         show inherited one label on every episode. If you trip it, read that
         show's episodes (`node tools/refresh/topic-uniformity.mjs --show "<title>"`);
         if the uniform label is the truth, raise UNIFORM_CEILING in the same PR
         and name the show in the commit. When the count falls, lower the ceiling.

   Each test names the one-line mutation that turns it red. The floor for this
   suite lives in test/suite-integrity.test.js. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uniformTopicShows, substantialShows, topicKey } from "./topics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8"));

/* Measured on origin/main bec194ee (2026-10-05) with
   `node tools/refresh/topic-uniformity.mjs`: 74 of 120 shows with >= 8 episodes
   carry one topic set (2167 items, 221 shows). */
const UNIFORM_CEILING = 74;
const MIN_EPISODES = 8;

/* 13 shows are marked general on main today. A floor, not an equality, so
   marking another show general does not need this file touched. */
const GENERAL_SHOWS_FLOOR = 13;

test("the uniformity helpers flag a one-label show and pass a ranging one (guards the real-data tests below from going vacuous)", () => {
  /* MUTATION: in topics.mjs uniformTopicShows, `if (keys.size !== 1) continue;`
     -> `continue;` (it returns [] for everything). Both real-data tests below
     would then pass on any data at all; this one goes red. Also killed:
     topicKey dropping `.sort()` (the re-ordered ["b","a"] episode then reads as
     a second label and "Narrow" stops being uniform). */
  const ep = (show, topics) => ({ show, topics });
  const items = [
    ...Array.from({ length: 4 }, (_, n) => ep("Narrow", n % 2 ? ["a", "b"] : ["b", "a"])),
    ep("Ranging", ["a"]),
    ep("Ranging", ["a"]),
    ep("Ranging", ["c"]),
    ep("Ranging", ["a"]),
    ep("Tiny", ["a"]),
  ];
  assert.equal(topicKey(["b", "a", "b"]), topicKey(["a", "b"]));
  assert.deepEqual(
    uniformTopicShows(items, { minEpisodes: 2 }).map((r) => r.show),
    ["Narrow"],
    "Narrow (one label, re-ordered) is uniform; Ranging has two labels; Tiny is under the threshold"
  );
  assert.equal(substantialShows(items, { minEpisodes: 2 }), 2);
});

test("(a) no label_scope general show carries one topic set on every episode", () => {
  /* MUTATION: in data/discover.json, set every "CBC Ideas" item's `topics` to
     ["engineering/energy-fusion"] (the #547 magnet label inherited from the show
     default); CBC Ideas becomes uniform and this goes red. Also red if
     `catalog.shows.filter((s) => s.label_scope === "general")` stops matching
     (a renamed field): the GENERAL_SHOWS_FLOOR check fails instead of the loop
     passing over an empty list.

     minEpisodes is 2, not 8: a general show's episodes must each be judged no
     matter how few there are, and only a 1-episode show is trivially uniform.
     Green today: all 13 general shows have >= 2 episodes and >= 4 distinct sets. */
  const general = new Set(catalog.shows.filter((s) => s.label_scope === "general").map((s) => s.title));
  const counts = new Map();
  for (const i of discover.items) counts.set(i.show, (counts.get(i.show) || 0) + 1);
  const judged = [...general].filter((t) => (counts.get(t) || 0) >= 2);
  assert.ok(
    judged.length >= GENERAL_SHOWS_FLOOR,
    `only ${judged.length} label_scope "general" shows have >= 2 episodes in data/discover.json ` +
      `(floor ${GENERAL_SHOWS_FLOOR}); a renamed field or title mismatch would make this test vacuous`
  );
  const uniformGeneral = uniformTopicShows(discover.items, { minEpisodes: 2 }).filter((r) => general.has(r.show));
  assert.deepEqual(
    uniformGeneral.map((r) => `${r.show} (${r.episodes} episodes, ${r.topics.join(", ")})`),
    [],
    'a label_scope "general" show carries one topic set on every episode: its episodes inherited the ' +
      "show label instead of being judged (docs/roadmap/README.md item 24; relabel with tools/refresh/relabel.mjs)"
  );
});

test(`(b) the uniform-show count is a ratchet: <= ${UNIFORM_CEILING} shows with >= ${MIN_EPISODES} episodes`, () => {
  /* MUTATION: in data/discover.json, give every episode of one ranging,
     non-general show with >= 8 episodes ("Conan O'Brien Needs a Friend") its
     first episode's topic set; the count becomes 75 and only this test goes red.
     Equivalently, `UNIFORM_CEILING = 74` -> 73 goes red against today's data. */
  const uniform = uniformTopicShows(discover.items, { minEpisodes: MIN_EPISODES });
  const total = substantialShows(discover.items, { minEpisodes: MIN_EPISODES });
  assert.ok(total > 0, "no show has >= 8 episodes; data/discover.json did not load as expected");
  assert.ok(
    uniform.length <= UNIFORM_CEILING,
    `${uniform.length} of ${total} shows with >= ${MIN_EPISODES} episodes carry ONE topic set ` +
      `(ceiling ${UNIFORM_CEILING}). A show newly inherited one label on every episode. Read it with ` +
      `node tools/refresh/topic-uniformity.mjs --show "<title>"; relabel it, or if the label is the ` +
      `truth raise UNIFORM_CEILING and name the show. Uniform now:\n` +
      uniform.map((r) => `  ${r.episodes}  ${r.show}  ${r.topics.join(", ")}`).join("\n")
  );
});
