/* GV-65 (W3-20): the Qwen dossier selection pass and its OpenAI-compatible
 * client.
 *
 * Offline: every model call goes to an injected fake fetch that returns the
 * recorded OpenAI-format replies in fixtures/dossiers/qwen-select-*.json, the
 * dossiers are synthetic and live in a temp dir, and globalThis.fetch is
 * replaced by a thrower for the whole file so an un-injected request fails
 * the suite instead of reaching the network.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDossier, validateManifest } from "./schema.mjs";
import {
  API_KEY_ENV,
  API_KEY_FILE_ENV,
  BASE_URL_ENV,
  DEFAULT_MODEL,
  LlmConfigError,
  MODEL_ENV,
  createChatClient,
  llmConfig,
} from "./llm.mjs";
import {
  BUILDER,
  REPLY_SCHEMA,
  SCHEMA_NAME,
  buildPrompt,
  codePath,
  main,
  parseArgs,
  selectDossiers,
  selectNode,
  selectRecordPath,
} from "./qwen-select.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures", "dossiers");
const GOOD = JSON.parse(fs.readFileSync(path.join(FIX, "qwen-select-reply.json"), "utf8"));
const BAD = JSON.parse(fs.readFileSync(path.join(FIX, "qwen-select-bad.json"), "utf8"));
const KEY = "sk-foray-test-0123456789abcdef";
const BASE = "http://litellm.test:4000/";
const NODE = "engineering/energy-fusion";
const T0 = Date.UTC(2026, 9, 13, 2, 0, 0);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

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
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gv65-select-"));
  made.push(d);
  return d;
};

const SID_A = "a1b2c3d4e5f6";
const SID_B = "0f1e2d3c4b5a";
/* Passage texts carry the characters a careless rewrite would change:
   curly quotes, an en dash, a non-breaking space, a trailing space. */
const TEXTS = [
  "The Larkspur Tokamak is an experimental fusion device that first produced plasma in 1997.",
  "See the photo gallery for more pictures of the site.",
  "Claims that the device reached “ignition” in 2004 were disputed by the review panel – later work found no net gain.",
  "Its magnetic field of 5.3 tesla confines a deuterium plasma for up to 30 seconds. ",
  "The town nearby hosts an annual summer fair.",
];

function makeDossier(id = NODE, label = "Fusion & energy systems", texts = TEXTS) {
  return {
    version: 1,
    node_id: id,
    label,
    built_at: "2026-10-12T08:00:00.000Z",
    builder: "code",
    sources: [
      { sourceId: SID_A, url: "https://en.wikipedia.org/wiki/Larkspur_Tokamak", publication: "Wikipedia", title: "Larkspur Tokamak", retrievedAt: "2026-10-12T08:00:00.000Z", sha256: "a".repeat(64), license: "CC BY-SA 4.0" },
      { sourceId: SID_B, url: "https://example.org/fusion", publication: "example.org", title: "Fusion notes", retrievedAt: "2026-10-12T08:00:02.000Z", sha256: "b".repeat(64), license: "unknown" },
    ],
    passages: texts.map((text, n) => {
      const sid = n < 3 ? SID_A : SID_B;
      return { docId: `dossier:${id}:${sid}:${n}`, sourceId: sid, text, offset: n * 200 };
    }),
    missing: [],
  };
}

/* A dossier dir as build.mjs leaves it: the dossier files plus manifest.json. */
function seedDir(dossiers = [makeDossier()]) {
  const dir = tmpDir();
  const nodes = {};
  for (const d of dossiers) {
    const file = `${d.node_id.replace(/\//g, "__")}.json`;
    const text = `${JSON.stringify(d, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, file), text);
    nodes[d.node_id] = { label: d.label, file, sha256: sha256(Buffer.from(text)), passages: d.passages.length, sources: d.sources.length, built_at: d.built_at, missing: [] };
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ version: 1, updated_at: "2026-10-12T08:00:05.000Z", nodes }, null, 2)}\n`);
  return dir;
}

/* replies: an array of OpenAI-format bodies (or {status} / Error), served in
   order; the last one repeats. Every request is logged. */
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

const client = (fetchImpl, extra = {}) => createChatClient({ baseUrl: BASE, apiKey: KEY, model: "local-worker", fetchImpl, now: () => T0, ...extra });
const read = (f) => fs.readFileSync(f);

test("a recorded reply keeps only the selected passages, each byte-identical to its input, and flags the contested one", async () => {
  const dir = seedDir();
  const file = path.join(dir, "engineering__energy-fusion.json");
  const before = read(file);
  const input = JSON.parse(before.toString("utf8"));
  const { fetchImpl, calls } = fakeFetch([GOOD]);

  const r = await selectNode(NODE, { dir, client: client(fetchImpl), now: () => T0 });
  assert.equal(r.status, "selected");
  assert.equal(calls.length, 1);

  const out = JSON.parse(read(file).toString("utf8"));
  assert.deepEqual(validateDossier(out), []);
  assert.equal(out.builder, BUILDER);
  assert.equal(out.model, "local-worker");
  assert.equal(out.selected_at, new Date(T0).toISOString());
  // keep [1,3,4] -> input passages 0, 2, 3 in document order; nothing edited.
  assert.deepEqual(out.passages.map((p) => p.docId), [0, 2, 3].map((i) => input.passages[i].docId));
  out.passages.forEach((p, k) => {
    const src = input.passages[[0, 2, 3][k]];
    assert.equal(p.text, src.text);
    assert.ok(Buffer.from(p.text, "utf8").equals(Buffer.from(TEXTS[[0, 2, 3][k]], "utf8")));
    assert.equal(p.offset, src.offset);
    assert.equal(p.sourceId, src.sourceId);
  });
  assert.deepEqual(out.passages.map((p) => p.contested === true), [false, true, false]);
  assert.ok(!("contested" in out.passages[0]));
  // Everything but the selection fields is the input's.
  for (const k of ["version", "node_id", "label", "built_at", "sources", "missing"]) assert.deepEqual(out[k], input[k]);

  // The code-built bytes are kept for comparison, byte for byte.
  assert.ok(read(codePath(dir, NODE)).equals(before));
  // The selection record lists kept, dropped, contested and about_subject.
  const rec = JSON.parse(read(selectRecordPath(dir, NODE)).toString("utf8"));
  const ids = input.passages.map((p) => p.docId);
  assert.deepEqual(rec.keep, [ids[0], ids[2], ids[3]]);
  assert.deepEqual(rec.dropped, [ids[1], ids[4]]);
  assert.deepEqual(rec.contested, [ids[2]]);
  assert.deepEqual(rec.about_subject, [ids[0], ids[2]]);
  assert.equal(rec.unseen, 0);
  // The manifest now describes the selected file.
  const m = JSON.parse(read(path.join(dir, "manifest.json")).toString("utf8"));
  assert.deepEqual(validateManifest(m), []);
  assert.equal(m.nodes[NODE].sha256, sha256(read(file)));
  assert.equal(m.nodes[NODE].passages, 3);
});

test("malformed, out-of-range, empty and truncated replies leave the dossier unchanged", async () => {
  const expected = {
    malformed: "malformed_reply",
    wrong_shape: "malformed_reply",
    not_integer: "malformed_reply",
    out_of_range: "out_of_range",
    zero_index: "malformed_reply",
    contested_out_of_range: "out_of_range",
    empty_keep: "empty_keep",
    truncated: "truncated",
    no_choice: "malformed_choice",
  };
  const cases = Object.keys(BAD).filter((k) => !k.startsWith("_"));
  assert.deepEqual(cases.sort(), Object.keys(expected).sort());
  for (const name of cases) {
    const dir = seedDir();
    const file = path.join(dir, "engineering__energy-fusion.json");
    const before = read(file);
    const manifestBefore = read(path.join(dir, "manifest.json"));
    const { fetchImpl } = fakeFetch([BAD[name]]);
    const r = await selectNode(NODE, { dir, client: client(fetchImpl) });
    assert.notEqual(r.status, "selected", name);
    assert.equal(r.reason, expected[name], name);
    assert.ok(read(file).equals(before), `${name}: dossier bytes changed`);
    assert.ok(read(path.join(dir, "manifest.json")).equals(manifestBefore), `${name}: manifest changed`);
    assert.equal(fs.existsSync(codePath(dir, NODE)), false, name);
    assert.equal(fs.existsSync(selectRecordPath(dir, NODE)), false, name);
  }
  // Transport failures too: an HTTP 500, a refused connection.
  for (const reply of [{ status: 500 }, new TypeError("fetch failed")]) {
    const dir = seedDir();
    const file = path.join(dir, "engineering__energy-fusion.json");
    const before = read(file);
    const { fetchImpl } = fakeFetch([reply]);
    const r = await selectNode(NODE, { dir, client: client(fetchImpl) });
    assert.equal(r.status, "transport");
    assert.ok(read(file).equals(before));
    assert.equal(fs.existsSync(codePath(dir, NODE)), false);
  }
});

test("the request carries the json_schema response_format, enable_thinking false and the key only in the header", async () => {
  const dir = seedDir();
  const { fetchImpl, calls } = fakeFetch([GOOD]);
  await selectNode(NODE, { dir, client: client(fetchImpl), nodes: JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "data", "taxonomy.json"), "utf8")).nodes });
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, "http://litellm.test:4000/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(init.headers["content-type"], "application/json");
  assert.ok(!init.body.includes(KEY), "the key is in the body");
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema: REPLY_SCHEMA, strict: true } });
  assert.equal(SCHEMA_NAME, "dossier_select");
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.model, "local-worker");
  assert.equal(body.temperature, 0);
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0);
  assert.deepEqual(REPLY_SCHEMA.required, ["keep", "contested", "about_subject"]);
  // The prompt: the label, subject sentences from the taxonomy, numbered passages.
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  const user = body.messages[1].content;
  assert.match(user, /^Subject: Fusion & energy systems\n/);
  assert.match(user, /It is a topic within Engineering\./);
  assert.match(user, /Related terms: fusion, fusion energy, tokamak/);
  TEXTS.forEach((t, i) => assert.ok(user.includes(`[${i + 1}] (`) && user.includes(t), `passage ${i + 1} not shown verbatim`));
  assert.match(body.messages[0].content, /never write/);
});

test("a source scan of the selection pass finds no non-local model endpoint or SDK", () => {
  for (const f of ["llm.mjs", "qwen-select.mjs"]) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(src, /anthropic|claude|x-api-key|\/v1\/messages|api\.openai\.com|anthropicCall|relay/i, f);
    // The only network primitive is the injected fetch; no SDK imports.
    for (const [, spec] of src.matchAll(/^import .* from "([^"]+)";$/gm)) {
      assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${f} imports ${spec}`);
    }
  }
});

test("a rerun skips nodes already selected; --force reselects from the code copy", async () => {
  const other = makeDossier("health/sleep", "Sleep science", TEXTS.slice(0, 4));
  const dir = seedDir([makeDossier(), other]);
  const first = fakeFetch([GOOD]);
  const r1 = await selectDossiers({ ids: [NODE, "health/sleep"], dir, client: client(first.fetchImpl), now: () => T0 });
  assert.deepEqual(r1.map((r) => r.status), ["selected", "selected"]);
  assert.equal(first.calls.length, 2);
  const selectedBytes = read(path.join(dir, "engineering__energy-fusion.json"));

  const second = fakeFetch([GOOD]);
  const r2 = await selectDossiers({ ids: [NODE, "health/sleep"], dir, client: client(second.fetchImpl) });
  assert.deepEqual(r2.map((r) => r.status), ["skipped", "skipped"]);
  assert.equal(second.calls.length, 0);
  assert.ok(read(path.join(dir, "engineering__energy-fusion.json")).equals(selectedBytes));

  // --force starts again from the code-built copy (all 5 passages shown).
  const third = fakeFetch([BAD.out_of_range, GOOD]);
  const codeBytes = read(codePath(dir, NODE));
  const r3 = await selectNode(NODE, { dir, client: client(third.fetchImpl), force: true });
  assert.equal(r3.reason, "out_of_range");
  assert.ok(read(path.join(dir, "engineering__energy-fusion.json")).equals(selectedBytes), "a refused forced reselection changed the file");
  const r4 = await selectNode(NODE, { dir, client: client(third.fetchImpl), force: true });
  assert.equal(r4.status, "selected");
  assert.match(third.calls[1].body.messages[1].content, /\[5\] \(/);
  assert.ok(read(codePath(dir, NODE)).equals(codeBytes));
});

test("the prompt is trimmed to the token budget; unseen passages get no number and are not kept", async () => {
  const long = Array.from({ length: 6 }, (_, i) => `Passage ${i} ${"word ".repeat(250).trim()}.`);
  const d = makeDossier(NODE, "Fusion & energy systems", long);
  const { shown, messages } = buildPrompt(d, { maxPromptTokens: 1200 });
  assert.ok(shown >= 1 && shown < 6, `shown ${shown}`);
  assert.ok(messages[1].content.includes(`[${shown}] (`));
  assert.ok(!messages[1].content.includes(`[${shown + 1}] (`));
  assert.ok(messages.reduce((n, m) => n + m.content.length, 0) <= 1200 * 3.5);
  // At least one passage is shown however small the budget.
  assert.equal(buildPrompt(d, { maxPromptTokens: 1 }).shown, 1);

  const dir = seedDir([d]);
  const reply = (keep) => ({ model: "local-worker", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ keep, contested: [], about_subject: [] }) } }] });
  const refused = await selectNode(NODE, { dir, client: client(fakeFetch([reply([1, shown + 1])]).fetchImpl), maxPromptTokens: 1200 });
  assert.equal(refused.reason, "out_of_range");
  const ok = await selectNode(NODE, { dir, client: client(fakeFetch([reply([1])]).fetchImpl), maxPromptTokens: 1200 });
  assert.equal(ok.status, "selected");
  assert.equal(ok.unseen, 6 - shown);
  assert.equal(JSON.parse(read(selectRecordPath(dir, NODE)).toString("utf8")).dropped.length, 5);
});

test("llmConfig reads the backend's FORAY_LLM_* variables plus FORAY_DOSSIER_MODEL and never leaks the key", async () => {
  assert.deepEqual(llmConfig({ [BASE_URL_ENV]: BASE, [API_KEY_ENV]: KEY }), { baseUrl: BASE.trim(), apiKey: KEY, model: DEFAULT_MODEL });
  assert.equal(DEFAULT_MODEL, "local-worker");
  assert.equal(llmConfig({ [BASE_URL_ENV]: BASE, [API_KEY_ENV]: KEY, [MODEL_ENV]: "qwen-27b" }).model, "qwen-27b");
  // The key file: trimmed; FORAY_LLM_API_KEY wins when both are set.
  const dir = tmpDir();
  const kf = path.join(dir, "key");
  fs.writeFileSync(kf, `  ${KEY}\n`);
  assert.equal(llmConfig({ [BASE_URL_ENV]: BASE, [API_KEY_FILE_ENV]: kf }).apiKey, KEY);
  assert.equal(llmConfig({ [BASE_URL_ENV]: BASE, [API_KEY_ENV]: "direct", [API_KEY_FILE_ENV]: kf }).apiKey, "direct");
  const fails = (env, variable) => {
    assert.throws(() => llmConfig(env), (e) => e instanceof LlmConfigError && e.variable === variable && !e.message.includes(KEY));
  };
  fails({ [API_KEY_ENV]: KEY }, BASE_URL_ENV);
  fails({ [BASE_URL_ENV]: "ftp://x", [API_KEY_ENV]: KEY }, BASE_URL_ENV);
  fails({ [BASE_URL_ENV]: BASE }, API_KEY_ENV);
  fails({ [BASE_URL_ENV]: BASE, [API_KEY_FILE_ENV]: path.join(dir, "absent") }, API_KEY_FILE_ENV);
  fs.writeFileSync(path.join(dir, "empty"), " \n");
  fails({ [BASE_URL_ENV]: BASE, [API_KEY_FILE_ENV]: path.join(dir, "empty") }, API_KEY_FILE_ENV);

  // Transport errors carry a fixed reason, never the key or the upstream body.
  for (const [reply, reason] of [[{ status: 401 }, "http_401"], [new TypeError(`bad ${KEY}`), "network"]]) {
    await assert.rejects(client(fakeFetch([reply]).fetchImpl).complete({ messages: [], schema: {}, schemaName: "x", maxTokens: 1 }), (e) => {
      assert.equal(e.reason, reason);
      assert.ok(!e.message.includes(KEY) && !e.message.includes("upstream"));
      return true;
    });
  }
  // A stalled lane times out.
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(client(hang, { timeoutMs: 5 }).complete({ messages: [], schema: {}, schemaName: "x", maxTokens: 1 }), (e) => e.reason === "timeout");
});

test("CLI: --all selects every manifest node offline; three transport failures in a row stop the run", async () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--all", "--node", NODE]), /exclusive/);
  assert.throws(() => parseArgs(["--all", "--max-prompt-tokens", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  const opts = parseArgs(["--node", NODE, "--force", "--max-prompt-tokens", "8000", "--timeout-ms", "1000"]);
  assert.deepEqual([opts.nodes, opts.force, opts.maxPromptTokens, opts.timeoutMs], [[NODE], true, 8000, 1000]);

  const dir = seedDir([makeDossier(), makeDossier("health/sleep", "Sleep science")]);
  const env = { [BASE_URL_ENV]: BASE, [API_KEY_ENV]: KEY };
  const { fetchImpl, calls } = fakeFetch([GOOD]);
  const lines = [];
  const results = await main(["--all", "--dir", dir], { env, fetchImpl, now: () => T0, log: (s) => lines.push(s) });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [[NODE, "selected"], ["health/sleep", "selected"]]);
  assert.equal(calls.length, 2);
  assert.ok(lines.every((l) => !l.includes(KEY)));
  assert.match(lines.at(-1), /selected 2, skipped 0/);
  // Without the key the CLI refuses before any request.
  await assert.rejects(main(["--all", "--dir", dir], { env: { [BASE_URL_ENV]: BASE }, fetchImpl }), LlmConfigError);
  assert.equal(calls.length, 2);

  const ids = ["a/one", "a/two", "a/three", "a/four"];
  const down = seedDir(ids.map((id) => makeDossier(id, id)));
  const dead = fakeFetch([{ status: 503 }]);
  const r = await selectDossiers({ ids, dir: down, client: client(dead.fetchImpl) });
  assert.deepEqual(r.map((x) => x.status), ["transport", "transport", "transport"]);
  assert.equal(dead.calls.length, 3);
});
