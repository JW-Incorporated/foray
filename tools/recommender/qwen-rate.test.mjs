/* RV-20 (docs/roadmap/recommender-v1.md D1; #1163 item 17.1): the dormant
   direct-Qwen rater path.

   Offline: every model call goes to an injected fake fetch serving the
   recorded OpenAI-format replies in fixtures/qwen-reply.json and
   fixtures/qwen-bad.json; globalThis.fetch is replaced by a thrower for the
   whole file, so an un-injected request fails the suite instead of reaching
   LiteLLM, the Spark or any other host. The batch, the persona profiles and
   the results live in a temp root; the rubric is the committed one, copied.

   Every test names the one-line mutation of qwen-rate.mjs that turns it red;
   each was run red before this suite was committed. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMerge } from "./merge-rating-results.mjs";
import {
  DEFAULT_MODEL,
  MAX_REPLY_TOKENS,
  REPLY_INVALID,
  SCHEMA_NAME,
  main,
  rateBatch,
  resultsPathFor,
} from "./qwen-rate.mjs";
import { createChatClient } from "../corpus/dossiers/llm.mjs";
import { schemaForShow, validateResultsFile } from "./schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const GOOD = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "qwen-reply.json"), "utf8"));
const BAD = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "qwen-bad.json"), "utf8"));
const RUBRIC = fs.readFileSync(path.join(ROOT, "docs", "curation", "rating-rubric-v1.md"), "utf8");
const KEY = "sk-foray-test-0123456789abcdef";
const ENV = { FORAY_LLM_BASE_URL: "http://litellm.test:4000", FORAY_LLM_API_KEY: KEY };
const T0 = Date.UTC(2026, 9, 14, 3, 0, 0);
const PERSONAS = ["comfort-companion", "mechanism-hunter"];
const FLAGS_OFF = { explicit: false, harassment: false, medical_financial_advice: false, injection_suspected: false };

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`network call in a fixture-only suite: ${url}`);
  };
});
const made = [];
after(() => {
  globalThis.fetch = realFetch;
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const profile = (id, label) => ({
  id,
  label,
  seed_persona_id: "curious-engineer-maker",
  taxonomy_affinity: { engineering: 0.8 },
  context: `${label} listens with full attention.`,
  rates_up: [`${label}: the evidence shows what it promises.`],
  rates_down: ["Most of the runtime is anecdote."],
  return_question: "Would this listener play a second episode this week?",
});

const pack = (key, tier, over = {}) => ({
  show_key: key,
  title: `Show ${key}`,
  tier,
  taxonomy_node_ids: ["engineering"],
  label_scope: null,
  cadence_hint: "weekly",
  typical_duration_min: 60,
  episode_count_band: "50-199",
  explicit: false,
  editorial_note: null,
  blurb: "Engineersˆtalkˆthroughˆindustrialˆaccidents.",
  feed_description: null,
  episodes: [],
  transcript_windows: [],
  flags_prescan: { injection_suspected: false },
  ...over,
});

/* A temp root as prepare-rating-batch.mjs leaves it: the rubric, the profiles,
   the batch file. A joint batch lists every profile persona (the merge
   requires it); an isolated one lists one. */
function seed({ shows = null, mode = "joint" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv20-qwen-"));
  made.push(root);
  const rubricPath = "docs/curation/rating-rubric-v1.md";
  const profilesPath = "data/recommender/persona-profiles.json";
  fs.mkdirSync(path.join(root, "docs", "curation"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "recommender"), { recursive: true });
  fs.writeFileSync(path.join(root, rubricPath), RUBRIC);
  const profilesText = `${JSON.stringify({ version: 1, rubric_version: 1, personas: [profile("mechanism-hunter", "Mechanism hunter"), profile("comfort-companion", "Comfort companion")] }, null, 2)}\n`;
  fs.writeFileSync(path.join(root, profilesPath), profilesText);
  const packs = shows ?? [
    pack("1000000001", "episode-metadata", { flags_prescan: { injection_suspected: true } }),
    pack("1000000002", "show-metadata"),
    pack("curated-show", "transcript", { explicit: true, transcript_windows: [{ episode_title: "One", position: "opening", text: "Weˆbeginˆwithˆtheˆvalve." }] }),
  ];
  const listed = mode === "joint" ? PERSONAS : [mode.slice("isolated:".length)];
  const batch = {
    batch_id: `pilot-1-${mode.replace(/:/g, "-")}-20261014-abcd1234`,
    rubric_version: 1,
    rubric_path: rubricPath,
    profiles_path: profilesPath,
    profiles_sha256: createHash("sha256").update(profilesText).digest("hex"),
    mode,
    pass: 1,
    persona_order: Object.fromEntries(packs.map((p, i) => [p.show_key, i % 2 ? [...listed].reverse() : [...listed]])),
    shows: packs,
  };
  const batchPath = path.join(root, "data-local", "recommender", "batches", `rating-batch-${batch.batch_id}.json`);
  fs.mkdirSync(path.dirname(batchPath), { recursive: true });
  fs.writeFileSync(batchPath, `${JSON.stringify(batch, null, 2)}\n`);
  return { root, batch, batchPath, resultsPath: resultsPathFor(batch.batch_id, root) };
}

/* replies: OpenAI-format bodies, {status} or an Error, served in order; the
   last one repeats. Every request is logged. */
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    if (r && typeof r.status === "number") return { status: r.status, text: async () => "upstream error body" };
    return { status: 200, text: async () => JSON.stringify(r) };
  };
  return { fetchImpl, calls };
}

const client = (fetchImpl) => createChatClient({ baseUrl: ENV.FORAY_LLM_BASE_URL, apiKey: KEY, model: DEFAULT_MODEL, fetchImpl, now: () => T0 });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const quiet = () => {};

test("exits 2 without a LiteLLM key", async () => {
  /* MUTATION (run red): in main, `return 0` instead of `return 2` after the
     LlmConfigError -- the dormant state would look like a finished run. */
  const s = seed();
  const { fetchImpl, calls } = fakeFetch([GOOD]);
  for (const env of [{}, { FORAY_LLM_BASE_URL: ENV.FORAY_LLM_BASE_URL }]) {
    const errors = [];
    const code = await main(["--batch", s.batchPath], { env, root: s.root, fetchImpl, log: quiet, error: (l) => errors.push(l) });
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /#1163 item 17\.1/);
    assert.match(errors.join("\n"), /no request was made/);
  }
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(s.resultsPath), false);
});

test("the request has json_schema, the rubric first and enable_thinking false", async () => {
  /* MUTATION (run red): in buildSystemPrompt, put the personas' profiles
     before the rubric (the cacheable prefix is the rubric; the show is last).
     Also run red: drop `{ tier: pack.tier }` from the schemaForShow call, and
     (in llm.mjs, reverted) drop `chat_template_kwargs`. */
  const s = seed();
  const { fetchImpl, calls } = fakeFetch([GOOD]);
  const logs = [];
  const code = await main(["--batch", s.batchPath], { env: ENV, root: s.root, fetchImpl, now: () => T0, log: (l) => logs.push(l), error: (l) => logs.push(l) });
  assert.equal(code, 0, logs.join("\n"));
  assert.equal(calls.length, 3, "one call per show");
  const { url, init, body } = calls[0];
  assert.equal(url, "http://litellm.test:4000/v1/chat/completions");
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!init.body.includes(KEY), "the key is in the body");
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, "local-heavy");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, MAX_REPLY_TOKENS);
  assert.equal(MAX_REPLY_TOKENS, 2500);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  const first = s.batch.shows[0];
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: SCHEMA_NAME, schema: schemaForShow(s.batch.persona_order[first.show_key], { tier: first.tier }), strict: true },
  });
  assert.equal(body.response_format.json_schema.schema.properties.personas.properties["mechanism-hunter"].properties.confidence.maximum, 0.7);

  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  const [system, user] = body.messages.map((m) => m.content);
  assert.ok(system.startsWith(RUBRIC.trim().slice(0, 200)), "the system message opens with the rubric");
  const rubricEnd = system.indexOf(RUBRIC.trim().slice(-120));
  const profilesAt = system.indexOf('"id": "mechanism-hunter"');
  assert.ok(rubricEnd >= 0 && profilesAt > rubricEnd, "the rubric comes before the profiles");
  assert.ok(!/seed_persona_id|taxonomy_affinity/.test(system), "mixture-model fields are not shown to the rater");
  assert.ok(!system.includes(first.title), "the show is not in the cacheable prefix");
  assert.ok(user.includes(first.title) && user.includes(first.blurb), "the show's pack is in the user message, datamarked as built");
  assert.ok(user.includes(s.batch.persona_order[first.show_key].join(", ")));
  // The system prefix is identical for every show of the batch.
  assert.ok(calls.every((c) => c.body.messages[0].content === system));
  // The run ends by naming the merge into the Qwen ratings file, not ratings.json.
  assert.match(logs.join("\n"), /merge-rating-results\.mjs --results .* --into data\/recommender\/ratings-qwen\.json/);

  // An isolated batch shows the rater that one persona's profile only.
  const iso = seed({ mode: "isolated:mechanism-hunter" });
  const isoFetch = fakeFetch([GOOD]);
  await rateBatch({ batch: iso.batch, client: client(isoFetch.fetchImpl), resultsPath: iso.resultsPath, root: iso.root, limit: 1, now: () => T0 });
  const isoBody = isoFetch.calls[0].body;
  assert.ok(isoBody.messages[0].content.includes('"id": "mechanism-hunter"'));
  assert.ok(!isoBody.messages[0].content.includes("comfort-companion"), "a persona the batch does not ask for is not shown");
  assert.deepEqual(isoBody.response_format.json_schema.schema.properties.personas.required, ["mechanism-hunter"]);
});

test("a recorded reply becomes a valid per-show result", async () => {
  /* MUTATION (run red): in showFromReply, keep the reply's `evidence_tier`
     instead of the pack's (`{ ...obj }` without the override) -- the
     transcript and episode-metadata shows are then filed as show-metadata.
     Also run red: drop the OR of the pack's injection pre-scan. */
  const s = seed();
  const { fetchImpl } = fakeFetch([GOOD]);
  const out = await rateBatch({ batch: s.batch, client: client(fetchImpl), resultsPath: s.resultsPath, root: s.root, now: () => T0 });
  assert.equal(out.complete, true);
  assert.deepEqual(out.outcomes.map((o) => o.status), ["rated", "rated", "rated"]);
  const doc = readJson(s.resultsPath);
  assert.deepEqual(validateResultsFile(doc, { personaIds: PERSONAS, showKeys: s.batch.shows.map((p) => p.show_key) }), []);
  assert.equal(doc.model, "local-heavy");
  assert.equal(doc.batch_id, s.batch.batch_id);
  assert.equal(doc.profiles_sha256, s.batch.profiles_sha256);
  assert.equal(doc.rated_at, new Date(T0).toISOString());
  assert.deepEqual(Object.fromEntries(Object.entries(doc.results).map(([k, v]) => [k, v.evidence_tier])), {
    "1000000001": "episode-metadata",
    "1000000002": "show-metadata",
    "curated-show": "transcript",
  });
  assert.equal(doc.results["1000000001"].flags.injection_suspected, true, "the pack's pre-scan is OR'd in");
  assert.equal(doc.results["curated-show"].flags.explicit, true, "the pack's explicit flag is OR'd in");
  assert.deepEqual(doc.results["1000000002"].flags, FLAGS_OFF);
  assert.equal(typeof doc.results["1000000002"].personas["mechanism-hunter"].fit, "number");
  // And the ordinary merge accepts it.
  const merged = runMerge({ resultsPath: s.resultsPath, batchPath: s.batchPath, root: s.root, now: new Date(T0) });
  assert.equal(merged.ok, true, JSON.stringify(merged.problems));
  assert.equal(Object.keys(readJson(path.join(s.root, "data", "recommender", "ratings.json")).shows).length, 3);
});

test("a bad reply sets not_rated_because and the run continues", async () => {
  /* MUTATION (run red): in rateBatch, `throw new Error(...)` where an invalid
     reply is recorded as REPLY_INVALID -- one bad reply would end the batch. */
  const cases = Object.keys(BAD).filter((k) => !k.startsWith("_"));
  assert.ok(cases.length >= 9);
  for (const name of cases) {
    const s = seed({ shows: [pack("1000000002", "show-metadata"), pack("1000000003", "show-metadata")] });
    const { fetchImpl, calls } = fakeFetch([BAD[name], GOOD]);
    const out = await rateBatch({ batch: s.batch, client: client(fetchImpl), resultsPath: s.resultsPath, root: s.root, now: () => T0 });
    assert.equal(calls.length, 2, name);
    assert.deepEqual(out.outcomes.map((o) => o.status), ["invalid", "rated"], name);
    const doc = readJson(s.resultsPath);
    const refused = doc.results["1000000002"];
    assert.equal(refused.not_rated_because, REPLY_INVALID, name);
    assert.equal(refused.personas, null, name);
    assert.equal(refused.summary, null, name);
    assert.equal(doc.results["1000000003"].not_rated_because, null, name);
    assert.deepEqual(validateResultsFile(doc, { personaIds: PERSONAS, showKeys: ["1000000002", "1000000003"] }), [], name);
  }
});

test("a rerun skips shows already in the results file", async () => {
  /* MUTATION (run red): in rateBatch, drop the `own(doc.results, key)` skip
     -- every show would be rated (and paid for) again. */
  const s = seed();
  const first = fakeFetch([GOOD]);
  const r1 = await rateBatch({ batch: s.batch, client: client(first.fetchImpl), resultsPath: s.resultsPath, root: s.root, limit: 1, now: () => T0 });
  assert.equal(first.calls.length, 1);
  assert.equal(r1.complete, false);
  const second = fakeFetch([GOOD]);
  const r2 = await rateBatch({ batch: s.batch, client: client(second.fetchImpl), resultsPath: s.resultsPath, root: s.root, now: () => T0 });
  assert.equal(second.calls.length, 2, "only the two shows not yet in the file are rated");
  assert.deepEqual(r2.outcomes.map((o) => o.status), ["skipped", "rated", "rated"]);
  const bytes = fs.readFileSync(s.resultsPath);
  const third = fakeFetch([GOOD]);
  const r3 = await rateBatch({ batch: s.batch, client: client(third.fetchImpl), resultsPath: s.resultsPath, root: s.root, now: () => T0 + 1000 });
  assert.equal(third.calls.length, 0);
  assert.equal(r3.complete, true);
  assert.ok(fs.readFileSync(s.resultsPath).equals(bytes), "a complete file is left byte-identical");
  // A results file from another model alias is refused, not mixed.
  const other = createChatClient({ baseUrl: ENV.FORAY_LLM_BASE_URL, apiKey: KEY, model: "local-worker", fetchImpl: third.fetchImpl });
  await assert.rejects(rateBatch({ batch: s.batch, client: other, resultsPath: s.resultsPath, root: s.root }), /rated by local-heavy/);
});

test("three transport failures stop the run", async () => {
  /* MUTATION (run red): in rateBatch, drop the `break` after
     MAX_TRANSPORT_FAILURES -- a dead lane would be called for every show. */
  const shows = ["1000000011", "1000000012", "1000000013", "1000000014", "1000000015"].map((k) => pack(k, "show-metadata"));
  const s = seed({ shows });
  const down = fakeFetch([{ status: 500 }, new TypeError("fetch failed"), { status: 503 }, GOOD]);
  const r = await rateBatch({ batch: s.batch, client: client(down.fetchImpl), resultsPath: s.resultsPath, root: s.root, now: () => T0 });
  assert.equal(down.calls.length, 3);
  assert.deepEqual(r.outcomes.map((o) => o.status), ["transport", "transport", "transport"]);
  assert.equal(r.complete, false);
  assert.equal(fs.existsSync(s.resultsPath), false, "a transport failure writes nothing");
  // Failures that are not consecutive do not stop it; the CLI exits 1 when incomplete.
  const flaky = fakeFetch([{ status: 500 }, { status: 500 }, GOOD, { status: 500 }, GOOD]);
  const code = await main(["--batch", s.batchPath], { env: ENV, root: s.root, fetchImpl: flaky.fetchImpl, now: () => T0, log: quiet, error: quiet });
  assert.equal(flaky.calls.length, 5);
  assert.equal(code, 1);
  assert.equal(Object.keys(readJson(s.resultsPath).results).length, 2);
});

test("a profiles file that no longer matches the batch is refused before any request", async () => {
  /* MUTATION (run red): in loadBatchInputs, drop the profiles_sha256 check --
     the run would spend a night rating against profiles the merge refuses. */
  const s = seed();
  fs.appendFileSync(path.join(s.root, s.batch.profiles_path), " ");
  const { fetchImpl, calls } = fakeFetch([GOOD]);
  const errors = [];
  const code = await main(["--batch", s.batchPath], { env: ENV, root: s.root, fetchImpl, log: quiet, error: (l) => errors.push(l) });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /profiles_sha256/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(s.resultsPath), false);
});

test("a source scan of the Qwen path finds no non-local model endpoint or SDK", () => {
  /* MUTATION (run red): add `// see https://api.anthropic.com/v1/messages`
     to qwen-rate.mjs -- the path must only ever reach LiteLLM through llm.mjs. */
  const src = fs.readFileSync(path.join(HERE, "qwen-rate.mjs"), "utf8");
  assert.doesNotMatch(src, /anthropic|claude|x-api-key|\/v1\/messages|api\.openai\.com|anthropicCall|relay/i);
  assert.doesNotMatch(src, /\bfetch\s*\(/, "no direct fetch: the only network primitive is llm.mjs's injected fetch");
  for (const [, spec] of src.matchAll(/^import .* from "([^"]+)";$/gm)) {
    assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `qwen-rate.mjs imports ${spec}`);
  }
});
