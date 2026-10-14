/* tools/recommender/jev-rate.mjs: the dormant Jev rater path (RV-18,
   docs/roadmap/recommender-v1.md D1, D3, D7; #1163 item 17.2).

   OFFLINE. Every test injects a fake fetch and a no-op sleep; nothing here
   can reach Jev or any host. The only reply body is the SYNTHETIC
   fixtures/jev-reply.json (no key exists to record a real one). Each test
   runs against a fresh temp repo root (a two-persona profiles file and a
   batch file) and names the one-line mutation of jev-rate.mjs that turns it
   red; each was run red before this suite was committed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UA } from "../segments/politeness.mjs";
import { DATAMARK } from "./evidence.mjs";
import { FIT_LEVELS, JEV_DEFAULT_MODEL, main, resultsPathFor } from "./jev-rate.mjs";
import { runMerge, validateAgainstBatch } from "./merge-rating-results.mjs";
import { RUBRIC_VERSION } from "./schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLY = readFileSync(join(HERE, "fixtures", "jev-reply.json"), "utf8");
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PROFILES_REL = "data/recommender/persona-profiles.json";
const PERSONAS = ["p-history", "p-light"];
const ENV = { JEV_API_KEY: "test-key-not-real" };
const BATCH_ID = "gold-1-joint-20261014-jev00001";
const dm = (s) => s.replace(/\s+/g, DATAMARK);

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "rv18-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    join(root, PROFILES_REL),
    `${JSON.stringify({
      version: 1,
      personas: [
        { id: "p-history", label: "History reader", context: "Listens on long walks.", rates_up: ["Primary sources read aloud."], rates_down: ["Hosts chatting off topic."] },
        { id: "p-light", label: "Light listener", context: "Listens while cooking.", rates_up: ["Short, cheerful episodes."], rates_down: ["Dense chapters with dates."] },
      ],
    })}\n`,
  );
  return root;
}

const metadataPack = (key, title) => ({
  show_key: key,
  title,
  tier: "show-metadata",
  taxonomy_node_ids: ["food"],
  label_scope: null,
  cadence_hint: "weekly",
  typical_duration_min: 30,
  episode_count_band: "100-499",
  explicit: false,
  editorial_note: null,
  blurb: dm("Call-in cooking questions answered by a chef."),
  feed_description: null,
  episodes: [],
  transcript_windows: [],
  flags_prescan: { injection_suspected: false },
});

/** A transcript pack carrying five described episodes, windows with a
    sentinel, and two D7 fields that must never reach Jev. */
const transcriptPack = () => ({
  ...metadataPack("curated-show", "One battle"),
  tier: "transcript",
  blurb: null,
  episodes: Array.from({ length: 5 }, (_, i) => ({ title: dm(`Battle ${i + 1}`), description: dm(`The letters of soldiers at battle ${i + 1}.`), duration_min: 60, published_at: "2026-09-01" })),
  transcript_windows: [{ episode_title: dm("Battle 1"), position: "opening", text: dm("SENTINEL-WINDOW-TEXT the cannon fired at dawn") }],
  chart_rank: 7,
  artist_name: "SENTINEL-NETWORK",
});

function writeBatch(root, packs) {
  const sha = createHash("sha256").update(readFileSync(join(root, PROFILES_REL))).digest("hex");
  const batch = {
    batch_id: BATCH_ID,
    rubric_version: RUBRIC_VERSION,
    rubric_path: "docs/curation/rating-rubric-v1.md",
    profiles_path: PROFILES_REL,
    profiles_sha256: sha,
    mode: "joint",
    pass: 1,
    persona_order: Object.fromEntries(packs.map((p) => [p.show_key, ["p-light", "p-history"]])),
    shows: packs,
  };
  const path = join(root, "data-local/recommender/batches", `rating-batch-${BATCH_ID}.json`);
  write(path, `${JSON.stringify(batch, null, 2)}\n`);
  return { batch, path };
}

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });

/** A fake fetch: `respond(call)` returns a response or throws; every call is
    recorded with its parsed body. Refuses to go past `max` calls. */
function fakeFetch(respond, { max = 20 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    if (calls.length > max) throw new Error("fake fetch: too many calls");
    return respond(call);
  };
  fn.calls = calls;
  return fn;
}

async function run(root, batchPath, fetchImpl, { env = ENV } = {}) {
  const out = [];
  const err = [];
  const code = await main(["--batch", batchPath], { env, fetchImpl, root, now: () => NOW, sleep: async () => {}, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out, err };
}

test("exits 2 without JEV_API_KEY", async (t) => {
  // mutation: in jevConfig, `return { ok: false, code: 2, message: NO_KEY_MESSAGE }` -> `code: 0` -> exits 0
  const root = makeRoot(t);
  const fetchImpl = fakeFetch(() => ok(REPLY));
  const missing = await run(root, join(root, "no-such-batch.json"), fetchImpl, { env: {} });
  assert.equal(missing.code, 2);
  assert.match(missing.err.join("\n"), /#1163 item 17\.2/);
  const keyFile = await run(root, join(root, "no-such-batch.json"), fetchImpl, { env: { JEV_KEY_FILE: join(root, "absent.key") } });
  assert.equal(keyFile.code, 2, "an unreadable JEV_KEY_FILE is no key");
  assert.equal(fetchImpl.calls.length, 0, "no request without a key");
  assert.equal(existsSync(join(root, "data-local")), false, "nothing written");
});

test("the request body is {state, model, questions} with 5-level score criteria", async (t) => {
  // mutation: drop the last FIT_LEVELS anchor (4 levels) -> the fit questions carry 4 criteria
  const root = makeRoot(t);
  const { path } = writeBatch(root, [metadataPack("1000000001", "Kitchen calls")]);
  const fetchImpl = fakeFetch(() => ok(REPLY));
  const { code } = await run(root, path, fetchImpl);
  const { url, init, body } = fetchImpl.calls[0];
  for (const q of body.questions.filter((x) => x.type === "score")) assert.equal(q.criteria.length, 5, `${q.id} has five levels`);
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer test-key-not-real");
  assert.equal(init.headers["user-agent"], UA);
  assert.ok(!init.body.includes("test-key-not-real"), "the key goes in the header only");
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, JEV_DEFAULT_MODEL);
  assert.deepEqual(body.questions.map((q) => q.id), [
    "p-light.fit", "p-light.return", "p-history.fit", "p-history.return",
    "show.topic_fit", "show.depth", "show.accessibility", "show.binge_vs_dip", "show.format",
  ], "the batch's persona order, then the show questions; no audio sub-score is asked");
  const fit = body.questions.find((q) => q.id === "p-history.fit");
  assert.deepEqual(fit.criteria, [...FIT_LEVELS]);
  assert.equal(fit.criteria[0], "Would not finish one episode.", "level 0 is fit 1");
  assert.match(fit.instructions, /History reader/);
  assert.match(fit.instructions, /Primary sources read aloud\./);
  assert.match(fit.instructions, /Hosts chatting off topic\./);
  assert.deepEqual(Object.keys(body.questions.at(-1).criteria), ["interview", "monologue", "panel", "narrative", "news", "mixed"]);
});

test("transcript windows never leave in state", async (t) => {
  // mutation: add "transcript_windows" to STATE_FIELDS -> the window text is sent
  const root = makeRoot(t);
  const { path } = writeBatch(root, [transcriptPack()]);
  const fetchImpl = fakeFetch(() => ok(REPLY));
  await run(root, path, fetchImpl);
  assert.equal(fetchImpl.calls.length, 1);
  const { state } = fetchImpl.calls[0].body;
  const sent = fetchImpl.calls[0].init.body;
  assert.ok(!sent.includes("SENTINEL-WINDOW-TEXT"), "no transcript text leaves");
  assert.equal("transcript_windows" in state, false);
  for (const k of ["chart_rank", "artist_name", "show_key", "tier", "flags_prescan"]) assert.equal(k in state, false, `${k} is not in state`);
  assert.ok(!sent.includes("SENTINEL-NETWORK"), "no stripped field rides along");
  assert.equal(state.title, "One battle");
  assert.equal(state.episodes.length, 5, "the episode metadata is the evidence");
  assert.ok(state.note.includes(DATAMARK), "the state says what the datamark means");
});

test("a recorded reply becomes a valid results file", async (t) => {
  // mutation: in showResult, `fit: clamp(level(fit) + 1, 1, 5)` -> `fit: level(fit)` (0-4) -> p-light's fit 0 is refused
  // mutation: in jevTier, `if (tier !== "transcript") return tier;` -> `return tier;` -> the transcript show is recorded as transcript at confidence 0.8
  const root = makeRoot(t);
  const { batch, path } = writeBatch(root, [metadataPack("1000000001", "Kitchen calls"), transcriptPack()]);
  const fetchImpl = fakeFetch(() => ok(REPLY));
  const { code, err } = await run(root, path, fetchImpl);
  assert.deepEqual(err, []);
  assert.equal(code, 0);

  const doc = readJson(resultsPathFor(BATCH_ID, root));
  assert.deepEqual(validateAgainstBatch(doc, batch, { personaIds: PERSONAS }), []);
  assert.equal(doc.model, "jev-1.13.0");
  assert.equal(doc.mode, "joint");
  assert.equal(doc.profiles_sha256, batch.profiles_sha256);
  const kitchen = doc.results["1000000001"];
  assert.deepEqual(kitchen.personas["p-history"], {
    fit: 5, return_prob: 0.75, topic_fit: 4, depth: 5, accessibility: 2, binge_vs_dip: 3,
    host_style: null, production: null, ad_load: null, confidence: 0.5, reason: "",
  });
  assert.equal(kitchen.personas["p-light"].fit, 1);
  assert.equal(kitchen.personas["p-light"].return_prob, 0);
  assert.equal(kitchen.format, "narrative");
  assert.equal(kitchen.summary, "Kitchen calls");
  const battle = doc.results["curated-show"];
  assert.equal(battle.evidence_tier, "episode-metadata", "Jev never saw the windows");
  assert.equal(battle.personas["p-history"].confidence, 0.7);
  assert.equal(battle.host_count, null);

  const merged = runMerge({ resultsPath: resultsPathFor(BATCH_ID, root), root, now: NOW, into: "ratings-jev.json" });
  assert.deepEqual(merged.problems, []);
  assert.equal(merged.ok, true, "the ordinary merge takes it --into ratings-jev.json");
});

test("a malformed reply is re-asked once then skipped", async (t) => {
  // mutation: `for (let attempt = 1; attempt <= 2; attempt++)` -> `attempt <= Infinity` -> the bad show is asked until the fake refuses
  const root = makeRoot(t);
  const { batch, path } = writeBatch(root, [metadataPack("1000000001", "Garbled"), metadataPack("1000000003", "Kitchen calls")]);
  const fetchImpl = fakeFetch((call) => (call.body.state.title === "Garbled" ? ok("{\"answers\": not json") : ok(REPLY)));
  const { code } = await run(root, path, fetchImpl);
  const asked = (title) => fetchImpl.calls.filter((c) => c.body.state.title === title).length;
  assert.equal(asked("Garbled"), 2, "asked, then re-asked once");
  assert.equal(asked("Kitchen calls"), 1);
  assert.equal(code, 0, "the run goes on");
  const doc = readJson(resultsPathFor(BATCH_ID, root));
  assert.equal(doc.results["1000000001"].not_rated_because, "jev_reply_malformed");
  assert.equal(doc.results["1000000001"].personas, null);
  assert.equal(doc.results["1000000003"].not_rated_because, null);
  assert.deepEqual(validateAgainstBatch(doc, batch, { personaIds: PERSONAS }), []);
});

test("three transport failures stop the run", async (t) => {
  // mutation: drop `report.stopped = true; break;` (no stop) -> all five shows are asked
  const root = makeRoot(t);
  const packs = ["1000000011", "1000000012", "1000000013", "1000000014", "1000000015"].map((k) => metadataPack(k, `Show ${k}`));
  const { path } = writeBatch(root, packs);
  let n = 0;
  const fetchImpl = fakeFetch(async () => {
    n += 1;
    if (n === 2) return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" };
    throw new TypeError("fetch failed");
  });
  const { code, err } = await run(root, path, fetchImpl);
  assert.equal(code, 1);
  assert.equal(fetchImpl.calls.length, 3, "a transport failure is not re-asked, and the third in a row stops");
  assert.match(err.join("\n"), /stopped after 3 consecutive transport failures/);
  const doc = readJson(resultsPathFor(BATCH_ID, root));
  assert.deepEqual(doc.results, {}, "a stopped run leaves the shows unanswered, not unrated");
});

test("a rerun resumes and skips the shows already in the results file", async (t) => {
  // mutation: drop `if (Object.prototype.hasOwnProperty.call(doc.results, key)) continue;` -> the rerun asks the first show again
  const root = makeRoot(t);
  const { batch, path } = writeBatch(root, [metadataPack("1000000001", "Kitchen calls"), metadataPack("1000000003", "Late show")]);
  const first = fakeFetch((call) => (call.body.state.title === "Late show" ? Promise.reject(new TypeError("fetch failed")) : ok(REPLY)));
  const run1 = await run(root, path, first);
  assert.equal(run1.code, 1, "one show unanswered");
  const partial = readJson(resultsPathFor(BATCH_ID, root));
  assert.deepEqual(Object.keys(partial.results), ["1000000001"]);
  assert.ok(validateAgainstBatch(partial, batch, { personaIds: PERSONAS }).some((p) => p.code === "missing_show"), "a partial file cannot be merged");

  const second = fakeFetch(() => ok(REPLY));
  const run2 = await run(root, path, second);
  assert.equal(run2.code, 0);
  assert.deepEqual(second.calls.map((c) => c.body.state.title), ["Late show"]);
  const doc = readJson(resultsPathFor(BATCH_ID, root));
  assert.deepEqual(doc.results["1000000001"], partial.results["1000000001"]);
  assert.deepEqual(validateAgainstBatch(doc, batch, { personaIds: PERSONAS }), []);
});
