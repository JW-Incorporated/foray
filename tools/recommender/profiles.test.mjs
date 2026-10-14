/* Persona rating profiles (RV-01, docs/roadmap/recommender-v1.md).
   Run: node --test tools/recommender/profiles.test.mjs

   The committed data/recommender/persona-profiles.json is checked against the
   real catalogue, taxonomy and onboarding personas; every rule is then broken
   once in a copy of the committed file. Each test names the one-line mutation
   that turns it red. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, loadContext, validateProfiles, wordCount, PROFILE_LIMITS } from "./profiles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ctx = loadContext(ROOT);
const committed = loadProfiles(join(ROOT, "data", "recommender", "persona-profiles.json"));
const copy = () => structuredClone(committed);
const codes = (problems) => problems.map((p) => p.split(":")[0]);
const onlyOne = (doc, i) => ({ ...doc, personas: [doc.personas[i]] });

/* MUTATION: set one `loves[].show_id` in data/recommender/persona-profiles.json
   to "nope" -> red (unknown_show). The second half guards the same rule against
   a validator that stopped looking the id up. */
test("the committed profiles validate against the real catalogue and taxonomy", () => {
  assert.deepEqual(validateProfiles(committed, ctx), []);
  assert.equal(committed.personas.length, 13);
  const bad = copy();
  bad.personas[0].loves[0].show_id = "nope";
  assert.deepEqual(codes(validateProfiles(bad, ctx)), ["unknown_show"]);
});

/* MUTATION: `minWords: 0` in PROFILE_LIMITS -> red. */
test("a persona under 250 words is a problem", () => {
  const doc = onlyOne(copy(), 0);
  const p = doc.personas[0];
  const cut = (s) => s.split(/\s+/).slice(0, 3).join(" ");
  p.context = cut(p.context);
  for (const k of ["rates_up", "rates_down", "stops_listening_when", "does_not_care_about"]) p[k] = p[k].map(cut);
  for (const e of [...p.loves, ...p.quits]) e.why = cut(e.why);
  assert.ok(wordCount(p) < PROFILE_LIMITS.minWords);
  assert.deepEqual(codes(validateProfiles(doc, ctx)), ["too_short"]);
});

/* MUTATION: delete the `if (n > L.maxWords) add("too_long", ...)` line -> red. */
test("a persona over 400 words is a problem", () => {
  const doc = onlyOne(copy(), 0);
  const p = doc.personas[0];
  p.context += " and keeps listening".repeat(60);
  assert.ok(wordCount(p) > PROFILE_LIMITS.maxWords);
  assert.deepEqual(codes(validateProfiles(doc, ctx)), ["too_long"]);
});

/* MUTATION: `if (p.seed_persona_id !== null && false)` (skip the lookup) -> red. */
test("an unknown seed_persona_id is a problem; null is allowed", () => {
  const doc = onlyOne(copy(), 0);
  doc.personas[0].seed_persona_id = "curious-engineer";
  assert.deepEqual(codes(validateProfiles(doc, ctx)), ["unknown_seed_persona"]);
  doc.personas[0].seed_persona_id = null;
  assert.deepEqual(validateProfiles(doc, ctx), []);
  assert.ok(ctx.seedPersonaIds.has("curious-engineer-maker"));
  assert.equal(ctx.seedPersonaIds.size, 6);
});

/* MUTATION: in loadContext, `taxonomy.nodes.map((n) => n.id)` (drop the
   `parent === null` filter, so any node id is accepted) -> red. */
test("taxonomy_affinity must name root nodes only", () => {
  const taxonomy = JSON.parse(readFileSync(join(ROOT, "data", "taxonomy.json"), "utf8"));
  const child = taxonomy.nodes.find((n) => n.parent !== null);
  assert.ok(child, "the taxonomy has at least one non-root node");
  const doc = onlyOne(copy(), 0);
  doc.personas[0].taxonomy_affinity[0].node_id = child.id;
  assert.deepEqual(codes(validateProfiles(doc, ctx)), ["not_a_root_node"]);
  doc.personas[0].taxonomy_affinity[0].node_id = "nope";
  assert.deepEqual(codes(validateProfiles(doc, ctx)), ["not_a_root_node"]);
});

/* MUTATION: `if (false && new Set(ids).size !== ids.length)` (remove the Set
   size check) -> red. */
test("every persona id is unique and kebab-case", () => {
  const dup = copy();
  dup.personas[1].id = dup.personas[0].id;
  assert.ok(codes(validateProfiles(dup, ctx)).includes("duplicate_id"));
  const ids = committed.personas.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const snake = onlyOne(copy(), 0);
  snake.personas[0].id = "Mechanism_Hunter";
  assert.deepEqual(codes(validateProfiles(snake, ctx)), ["bad_id"]);
});

/* MUTATIONS: (a) delete the `same_loves` line in the pairwise loop -> red;
   (b) make axisKey return `[a.why, a.how].join("|")` (ignore form) -> red:
   the committed file's why+how pairs differ only by form, and must pass. */
test("two personas with the same loves, or the same why, how and form, are a problem", () => {
  const loves = copy();
  loves.personas[1].loves = structuredClone(loves.personas[0].loves);
  assert.ok(codes(validateProfiles(loves, ctx)).includes("same_loves"));
  const axes = copy();
  axes.personas[1].axes = structuredClone(axes.personas[0].axes);
  assert.ok(codes(validateProfiles(axes, ctx)).includes("same_axes"));
  const pairs = new Map();
  for (const p of committed.personas) {
    const k = `${p.axes.why}|${p.axes.how}`;
    pairs.set(k, [...(pairs.get(k) || []), p.id]);
  }
  const pair = [...pairs.values()].find((ids) => ids.length > 1);
  assert.ok(pair, "the committed file has a why+how pair that only form tells apart");
  const both = { ...committed, personas: committed.personas.filter((p) => pair.slice(0, 2).includes(p.id)) };
  assert.deepEqual(validateProfiles(both, ctx), []);
});
