/* Persona rating profiles: load, count, validate (RV-01,
   docs/roadmap/recommender-v1.md; decisions D4 and D11; issue #1380).

   data/recommender/persona-profiles.json holds the rating personas the
   persona-rating agents read. They are NOT the six onboarding personas of
   data/personas.json (D11): each carries `seed_persona_id`, one of those six or
   null, and `taxonomy_affinity` over ROOT nodes of data/taxonomy.json, so a
   later client module can infer a persona mixture from a listener's interests
   without storing a persona id. Nothing on a live app path reads the file.

   Keyless, no network, no model. `validateProfiles` is pure: the caller hands
   it the id sets it checks against. `loadContext(root)` reads those sets from
   the committed catalogue, taxonomy and onboarding personas, so the CLI and the
   tests check the real files the same way.

     node tools/recommender/profiles.mjs [path]   prints word counts and
                                                  problems; exits 1 on any

   THE SHAPE (one persona; docs/curation/persona-profiles-v1.md explains it):
     { id, label, seed_persona_id,
       axes: { why, how, form: { length, ad_tolerance, polish, explicit } },
       context, rates_up[6-10], rates_down[4-6], stops_listening_when[2-4],
       does_not_care_about[2-4], loves[3] {show_id, why}, quits[3] {show_id, why},
       return_question, taxonomy_affinity[4-10] {node_id, weight -1..1} }

   `axes.form` is the third axis of the research's persona design (form
   tolerances: episode length, ad load, production polish, explicit language).
   It is what tells apart two personas that share `why` and `how`. */

import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PROFILES_PATH_DEFAULT = join(REPO_ROOT, "data", "recommender", "persona-profiles.json");

/* The card's four limits plus the counts its design fixes for the other lists. */
export const PROFILE_LIMITS = {
  minWords: 250,
  maxWords: 400,
  ratesUp: [6, 10],
  ratesDown: [4, 6],
  stopsListeningWhen: [2, 4],
  doesNotCareAbout: [2, 4],
  examples: 3,
  taxonomyAffinity: [4, 10]
};

export const AXES = {
  why: ["learn", "keep-up", "entertained", "absorbed", "accompanied"],
  how: ["lean-in", "lean-back"],
  form: {
    length: ["short", "medium", "long", "any"],
    ad_tolerance: ["low", "medium", "high"],
    polish: ["matters", "indifferent"],
    explicit: ["dealbreaker", "tolerated"]
  }
};

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PERSONA_KEYS = [
  "id", "label", "seed_persona_id", "axes", "context", "rates_up", "rates_down",
  "stops_listening_when", "does_not_care_about", "loves", "quits",
  "return_question", "taxonomy_affinity"
];

export function loadProfiles(path = PROFILES_PATH_DEFAULT) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* The id sets validateProfiles checks against, read from the committed files.
   Taxonomy: ROOT nodes only (parent === null), because the client mixture
   compares affinities against root-level interest weights (D11). */
export function loadContext(root = REPO_ROOT) {
  const read = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
  const catalog = read("data/catalog.json");
  const taxonomy = read("data/taxonomy.json");
  const personas = read("data/personas.json");
  return {
    catalogShowIds: new Set(catalog.shows.map((s) => s.show_id)),
    taxonomyRootIds: new Set(taxonomy.nodes.filter((n) => n.parent === null).map((n) => n.id)),
    seedPersonaIds: new Set(personas.personas.map((p) => p.id))
  };
}

const words = (text) => (typeof text === "string" ? text.split(/\s+/).filter(Boolean).length : 0);
const sumWords = (list, pick = (x) => x) => (Array.isArray(list) ? list.reduce((n, x) => n + words(pick(x)), 0) : 0);

/* Words over the prose fields only: what the rater reads as the persona.
   Ids, labels, axes and affinity weights are structure, not description. */
export function wordCount(persona) {
  return (
    words(persona.context) +
    sumWords(persona.rates_up) +
    sumWords(persona.rates_down) +
    sumWords(persona.stops_listening_when) +
    sumWords(persona.does_not_care_about) +
    sumWords(persona.loves, (e) => e && e.why) +
    sumWords(persona.quits, (e) => e && e.why) +
    words(persona.return_question)
  );
}

const nonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/* Returns [] or a list of problem strings, each `<code>: <persona>: <detail>`. */
export function validateProfiles(doc, { catalogShowIds, taxonomyRootIds, seedPersonaIds } = {}) {
  const problems = [];
  const add = (code, who, detail) => problems.push(`${code}: ${who}: ${detail}`);

  if (!doc || typeof doc !== "object") return ["bad_document: -: not an object"];
  if (doc.version !== 1) add("bad_version", "-", `version ${JSON.stringify(doc.version)}, expected 1`);
  if (doc.rubric_version !== 1) add("bad_rubric_version", "-", `rubric_version ${JSON.stringify(doc.rubric_version)}, expected 1`);
  if (!Array.isArray(doc.personas) || doc.personas.length === 0) {
    add("no_personas", "-", "personas must be a non-empty array");
    return problems;
  }
  if (!(catalogShowIds instanceof Set) || !(taxonomyRootIds instanceof Set) || !(seedPersonaIds instanceof Set)) {
    add("no_context", "-", "catalogShowIds, taxonomyRootIds and seedPersonaIds must be Sets (see loadContext)");
    return problems;
  }

  const ids = doc.personas.map((p) => p && p.id);
  if (new Set(ids).size !== ids.length) {
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) add("duplicate_id", String(id), "persona id appears more than once");
      seen.add(id);
    }
  }

  const L = PROFILE_LIMITS;
  const inRange = (list, [lo, hi]) => Array.isArray(list) && list.length >= lo && list.length <= hi;

  doc.personas.forEach((p, i) => {
    const who = p && nonEmptyString(p.id) ? p.id : `personas[${i}]`;
    if (!p || typeof p !== "object") return add("bad_persona", who, "not an object");

    if (!nonEmptyString(p.id) || !KEBAB.test(p.id)) add("bad_id", who, `id ${JSON.stringify(p.id)} is not kebab-case`);
    for (const k of Object.keys(p)) if (!PERSONA_KEYS.includes(k)) add("unknown_field", who, k);
    if (!nonEmptyString(p.label)) add("missing_field", who, "label");
    if (!nonEmptyString(p.context)) add("missing_field", who, "context");
    if (!nonEmptyString(p.return_question)) add("missing_field", who, "return_question");

    if (p.seed_persona_id !== null && !seedPersonaIds.has(p.seed_persona_id)) {
      add("unknown_seed_persona", who, `seed_persona_id ${JSON.stringify(p.seed_persona_id)} is not in data/personas.json (null is allowed)`);
    }

    const axes = p.axes || {};
    if (!AXES.why.includes(axes.why)) add("bad_axis", who, `why ${JSON.stringify(axes.why)}`);
    if (!AXES.how.includes(axes.how)) add("bad_axis", who, `how ${JSON.stringify(axes.how)}`);
    const form = axes.form || {};
    for (const [k, allowed] of Object.entries(AXES.form)) {
      if (!allowed.includes(form[k])) add("bad_axis", who, `form.${k} ${JSON.stringify(form[k])}`);
    }

    const lists = [
      ["rates_up", L.ratesUp],
      ["rates_down", L.ratesDown],
      ["stops_listening_when", L.stopsListeningWhen],
      ["does_not_care_about", L.doesNotCareAbout]
    ];
    for (const [key, range] of lists) {
      if (!inRange(p[key], range)) add("bad_count", who, `${key} needs ${range[0]}-${range[1]} entries`);
      else if (!p[key].every(nonEmptyString)) add("bad_entry", who, `${key} has an empty entry`);
    }

    for (const key of ["loves", "quits"]) {
      const list = p[key];
      if (!Array.isArray(list) || list.length !== L.examples) {
        add("bad_count", who, `${key} needs exactly ${L.examples} shows`);
        continue;
      }
      list.forEach((e, j) => {
        if (!e || !catalogShowIds.has(e.show_id)) add("unknown_show", who, `${key}[${j}].show_id ${JSON.stringify(e && e.show_id)} is not in data/catalog.json`);
        if (!e || !nonEmptyString(e.why)) add("bad_entry", who, `${key}[${j}].why is empty`);
      });
      if (new Set(list.map((e) => e && e.show_id)).size !== list.length) add("duplicate_show", who, `${key} names a show twice`);
    }
    if (Array.isArray(p.loves) && Array.isArray(p.quits)) {
      const loved = new Set(p.loves.map((e) => e && e.show_id));
      for (const e of p.quits) if (e && loved.has(e.show_id)) add("loves_and_quits", who, `${e.show_id} is in both loves and quits`);
    }

    const aff = p.taxonomy_affinity;
    if (!inRange(aff, L.taxonomyAffinity)) add("bad_count", who, `taxonomy_affinity needs ${L.taxonomyAffinity[0]}-${L.taxonomyAffinity[1]} roots`);
    if (Array.isArray(aff)) {
      aff.forEach((a, j) => {
        if (!a || !taxonomyRootIds.has(a.node_id)) add("not_a_root_node", who, `taxonomy_affinity[${j}].node_id ${JSON.stringify(a && a.node_id)} is not a root of data/taxonomy.json`);
        if (!a || typeof a.weight !== "number" || !(a.weight >= -1 && a.weight <= 1)) add("bad_weight", who, `taxonomy_affinity[${j}].weight must be a number in -1..1`);
      });
      if (new Set(aff.map((a) => a && a.node_id)).size !== aff.length) add("duplicate_node", who, "taxonomy_affinity names a root twice");
    }

    const n = wordCount(p);
    if (n < L.minWords) add("too_short", who, `${n} words, under ${L.minWords}`);
    if (n > L.maxWords) add("too_long", who, `${n} words, over ${L.maxWords}`);
  });

  /* Pairwise rules (card acceptance): no two personas love the same three
     shows, and no two share why, how and every form tolerance -- a pair that
     agrees on all of them is one persona rated twice. */
  const loveKey = (p) => (Array.isArray(p && p.loves) ? p.loves.map((e) => e && e.show_id).sort().join("|") : null);
  const axisKey = (p) => {
    const a = (p && p.axes) || {};
    const f = a.form || {};
    return [a.why, a.how, ...Object.keys(AXES.form).map((k) => f[k])].join("|");
  };
  for (let i = 0; i < doc.personas.length; i++) {
    for (let j = i + 1; j < doc.personas.length; j++) {
      const a = doc.personas[i];
      const b = doc.personas[j];
      if (!a || !b) continue;
      if (loveKey(a) !== null && loveKey(a) === loveKey(b)) add("same_loves", `${a.id}+${b.id}`, "the two personas love the same three shows");
      if (axisKey(a) === axisKey(b)) add("same_axes", `${a.id}+${b.id}`, "the two personas share why, how and every form tolerance");
    }
  }

  return problems;
}

function main() {
  const path = process.argv[2] ? resolve(process.argv[2]) : PROFILES_PATH_DEFAULT;
  const doc = loadProfiles(path);
  for (const p of doc.personas || []) console.log(`${String(wordCount(p)).padStart(4)}  ${p.id}`);
  const problems = validateProfiles(doc, loadContext());
  for (const line of problems) console.error(line);
  console.log(problems.length === 0 ? `ok: ${doc.personas.length} personas` : `${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

if (isEntryScript(import.meta.url)) main();
