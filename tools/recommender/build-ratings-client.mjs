#!/usr/bin/env node
/* Derives data/recommender/ratings-client.json from data/recommender/ratings.json
   (RV-15, docs/roadmap/recommender-v1.md D8; #1380).

   WHY THIS EXISTS
   ratings.json is the pipeline's file: ten slots per persona per show, the
   summary, the flags and top_reason, about 1.2 KB a show (376 KB for the
   299-show pilot). The client needs none of that bulk. It needs, per curated
   show, one rounded `fit` per kept persona, the explicit flag and the evidence
   tier, which is RV-02's client shape:

     { version, personas: [<persona_id>...],
       shows: { <show_id>: { f: "<one digit per persona, 0 = unrated>",
                             x: 0|1, t: "t"|"e"|"s" } } }

   (tools/recommender/schema.mjs validateClientFile is the one definition; the
   builder refuses to write anything it fails.) The file is budgeted at
   CLIENT_BUDGET_BYTES = 40 KB against the ~185 KB headroom the bundle audit
   measured (docs/research/bundle-budget-2026-10.md); over budget the builder
   exits 1 and writes nothing.

   DARK. Nothing on a live path reads this file: app.js never fetchJson()s it,
   so it costs zero bundle and is not in the deploy id or the SW precache. The
   parked RV-27 is the only card that will fetch it (behind
   RECOMMENDER_PRIOR = false) and adds it to UNPINNED_DATA with this budget.
   player/recommender.js decodeClientRow (RV-16) is the reader.

   WHAT IS LEFT OUT, ON PURPOSE
   - No reason or summary text. The pilot report
     (docs/research/persona-ratings-pilot-2026-10.md, "Top persona changes")
     found the top persona flips between passes for 32% of retest shows, nearly
     all near-ties among low fits, and recommends top_reason be shown only when
     the top persona's fit is 4 or more. RV-02's client shape carries no text
     at all, so that rule is honoured by omission; a later card that adds a
     reason must gate it on fit >= 4 (and the field must be added to
     schema.mjs first, or validateClientFile refuses it).
   - No breadth rows. Only curated shows (data/catalog.json, keyed show_id)
     are projected; RV-30 adds a budgeted breadth top-N from the student's
     predictions.
   - No pruned persona. `personas` is persona-profiles.json's order minus
     every profile marked `pruned: true` (RV-29's v1.1 pruning), and `f` has
     exactly one digit per kept persona.
   - No zero-filled show. A curated show with no rating, or rated only by
     pruned personas, is absent rather than "0000000000000": the client's
     prior for an absent show is "no prior", which is the truth.

   `f` digits are the persona's fit rounded half-up (multi-pass shows store a
   one-decimal mean) and clamped to 1-5; 0 means that kept persona has no
   rating for the show. `x` is 1 when the catalogue rates the show explicit OR
   the raters flagged it (either source is enough to hide it in Family mode).
   `t` is CLIENT_TIER_CODES[evidence_tier].

   Output is single-line JSON plus a newline, show keys sorted, so the --check
   drift test is a byte comparison.

   Offline and pure apart from main(): reads three committed files and writes
   one. No model call, no network.

   Usage: node tools/recommender/build-ratings-client.mjs
            [--check] [--out path] [--ratings path] [--catalog path] [--profiles path] */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { CLIENT_TIER_CODES, validateClientFile, validateRatingsFile } from "./schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** D8: the client projection's byte budget. */
export const CLIENT_BUDGET_BYTES = 40 * 1024;

/** The client file's format version (RV-02's shape, v1). */
export const CLIENT_FILE_VERSION = 1;

export const DEFAULT_PATHS = Object.freeze({
  ratings: path.join(REPO_ROOT, "data", "recommender", "ratings.json"),
  catalog: path.join(REPO_ROOT, "data", "catalog.json"),
  profiles: path.join(REPO_ROOT, "data", "recommender", "persona-profiles.json"),
  out: path.join(REPO_ROOT, "data", "recommender", "ratings-client.json"),
});

/** The kept rating personas, in persona-profiles.json order, without any
    profile marked `pruned: true`. */
export function keptPersonaIds(profiles) {
  const list = Array.isArray(profiles?.personas) ? profiles.personas : [];
  return list.filter((p) => p && typeof p.id === "string" && p.id.length > 0 && p.pruned !== true).map((p) => p.id);
}

/** One `f` digit from a ratings.json persona array: the fit (slot 0) rounded
    half-up and clamped to 1-5; 0 when there is no usable fit. */
export function fitDigit(ratingArray) {
  const fit = Array.isArray(ratingArray) ? ratingArray[0] : null;
  if (typeof fit !== "number" || !Number.isFinite(fit)) return 0;
  return Math.min(5, Math.max(1, Math.floor(fit + 0.5)));
}

/** The client document. `ratings` is ratings.json, `catalog` is
    data/catalog.json, `profiles` is persona-profiles.json. Throws on input
    that does not parse to the expected shape; never returns a partial file. */
export function buildRatingsClient(ratings, catalog, profiles) {
  if (!catalog || !Array.isArray(catalog.shows)) {
    throw new Error("data/catalog.json did not parse to { shows: [...] }; refusing to write an empty projection");
  }
  const ratingProblems = validateRatingsFile(ratings);
  if (ratingProblems.length > 0) {
    const first = ratingProblems.slice(0, 3).map((p) => `${p.code} at ${p.at}`).join("; ");
    throw new Error(`ratings.json is invalid (${ratingProblems.length} problem(s): ${first}); refusing to project it`);
  }
  const personas = keptPersonaIds(profiles);
  if (personas.length === 0) throw new Error("persona-profiles.json lists no kept persona; refusing to write an empty projection");

  const entries = [];
  for (const show of catalog.shows) {
    const id = show?.show_id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(ratings.shows, id)) continue;
    const rated = ratings.shows[id];
    const f = personas.map((pid) => fitDigit(rated.personas[pid])).join("");
    if (/^0*$/.test(f)) continue;
    const x = show.explicit === true || rated.flags?.explicit === true ? 1 : 0;
    entries.push([id, { f, x, t: CLIENT_TIER_CODES[rated.evidence_tier] }]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const doc = { version: CLIENT_FILE_VERSION, personas, shows: Object.fromEntries(entries) };
  const problems = validateClientFile(doc);
  if (problems.length > 0) {
    throw new Error(`the projection fails validateClientFile (${problems.map((p) => `${p.code} at ${p.at}`).slice(0, 3).join("; ")})`);
  }
  return doc;
}

/** The bytes written to disk: single-line JSON and a trailing newline. */
export function serializeClient(doc) {
  return `${JSON.stringify(doc)}\n`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Build (and write, or with `check` compare). Returns `{ code, message }`;
    code 0 written / up to date, 1 over budget, drift, or a refused input. */
export function runBuild({
  ratingsPath = DEFAULT_PATHS.ratings,
  catalogPath = DEFAULT_PATHS.catalog,
  profilesPath = DEFAULT_PATHS.profiles,
  outPath = DEFAULT_PATHS.out,
  check = false,
  budgetBytes = CLIENT_BUDGET_BYTES,
} = {}) {
  let text;
  let doc;
  try {
    doc = buildRatingsClient(readJson(ratingsPath), readJson(catalogPath), readJson(profilesPath));
    text = serializeClient(doc);
  } catch (err) {
    return { code: 1, message: `build-ratings-client: ${err.message}` };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const shows = Object.keys(doc.shows).length;
  const rel = path.relative(REPO_ROOT, outPath) || outPath;
  if (bytes > budgetBytes) {
    return { code: 1, message: `build-ratings-client: ${bytes} B for ${shows} shows is over the ${budgetBytes} B budget (D8); nothing written` };
  }
  if (check) {
    const onDisk = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (onDisk !== text) {
      return { code: 1, message: `${rel} is stale; run: node tools/recommender/build-ratings-client.mjs` };
    }
    return { code: 0, message: `${rel} is up to date (${shows} shows, ${doc.personas.length} personas, ${bytes} B of ${budgetBytes} B).` };
  }
  writeFileSync(outPath, text);
  return { code: 0, message: `wrote ${rel}: ${shows} shows, ${doc.personas.length} personas, ${bytes} B of ${budgetBytes} B.` };
}

export function parseArgs(argv) {
  const out = { check: false };
  const paths = { "--out": "outPath", "--ratings": "ratingsPath", "--catalog": "catalogPath", "--profiles": "profilesPath" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") { out.check = true; continue; }
    if (a in paths) {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a path`);
      out[paths[a]] = path.resolve(v);
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`build-ratings-client: ${err.message}`);
    return 2;
  }
  const { code, message } = runBuild(opts);
  (code === 0 ? console.log : console.error)(message);
  return code;
}

if (isEntryScript(import.meta.url)) process.exitCode = main(process.argv.slice(2));
