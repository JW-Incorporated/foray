/* GV-28 (W3-07, docs/roadmap/generation-v2.md): the Embedder interface. The
   openai embedder runs against a fake fetch, the transformers one against an
   injected createEmbedder; no model is downloaded and no socket is opened. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BGE_SMALL_EN_V15 } from "../corpus/embedder.mjs";
import { createPassageEmbedder, EMBEDDER_KINDS, openAIEmbedConfig, STUB_DIM, stubVector, transformersSpec } from "./embedder.mjs";

const ENV = {
  FORAY_EMBED_URL: "http://embed.test:4000/",
  FORAY_EMBED_MODEL: "bge-small-en-v1.5",
  FORAY_EMBED_KEY: "sk-test",
  FORAY_EMBED_DIM: "3",
};

/** A fake fetch that records each call and answers with `reply(body)`. */
function fakeFetch(reply, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = reply(JSON.parse(init.body));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { fetch, calls };
}

test("the stub is deterministic, 64-dim, never zero, and texts sharing words point the same way", async () => {
  const e = await createPassageEmbedder({ kind: "stub" });
  assert.equal(e.model.dim, STUB_DIM);
  assert.equal(e.model.name, "stub-hash");
  assert.equal(e.countTokens, undefined, "no tokenizer unless asked");
  const [a, b, c, d] = await e.embed(["Germ theory won", "germ THEORY won!", "unrelated words entirely", ""]);
  assert.equal(a.length, 64);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
  assert.ok(d.some((x) => x !== 0));
  assert.deepEqual(Array.from(stubVector("Germ theory won")), Array.from(a));
  const tok = await createPassageEmbedder({ kind: "stub", tokenizer: true, queryPrefix: "q: ", passagePrefix: "p: " });
  assert.equal(tok.countTokens("one two  three"), 3);
  assert.equal(tok.model.query_prefix, "q: ");
  assert.equal(tok.model.passage_prefix, "p: ");
});

test("the openai embedder sends the documented request and returns vectors in input order", async () => {
  const { fetch, calls } = fakeFetch((body) => ({
    object: "list",
    /* Answered out of order: placement must follow each item's index. */
    data: body.input.map((_, i) => ({ object: "embedding", index: i, embedding: [i, 1, 2] })).reverse(),
  }));
  const e = await createPassageEmbedder({ kind: "openai", env: ENV, fetch });
  assert.deepEqual(e.model, {
    name: "bge-small-en-v1.5",
    revision: "main",
    dim: 3,
    pooling: "server",
    normalized: 1,
    query_prefix: "",
    passage_prefix: "",
  });
  assert.equal(e.countTokens, undefined, "no tokenizer: the store falls back to chars/4");
  const out = await e.embed(["first", "second"]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "http://embed.test:4000/v1/embeddings");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer sk-test");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.deepEqual(call.body, { model: "bge-small-en-v1.5", input: ["first", "second"], encoding_format: "float" });
  assert.ok(out[0] instanceof Float32Array);
  assert.deepEqual(out.map((v) => v[0]), [0, 1], "placed by each item's index");
  assert.deepEqual(await e.embed([]), []);
  assert.equal(calls.length, 1, "an empty batch sends nothing");

  const noKey = fakeFetch((body) => ({ data: body.input.map((_, i) => ({ index: i, embedding: [1, 0, 0] })) }));
  const anon = await createPassageEmbedder({ kind: "openai", env: { ...ENV, FORAY_EMBED_KEY: "" }, fetch: noKey.fetch });
  await anon.embed(["x"]);
  assert.equal(noKey.calls[0].init.headers.authorization, undefined);
});

test("the openai embedder refuses a dimension mismatch and a short or failed answer", async () => {
  const wrongDim = fakeFetch((body) => ({ data: body.input.map((_, i) => ({ index: i, embedding: [1, 2, 3, 4] })) }));
  const e = await createPassageEmbedder({ kind: "openai", env: ENV, fetch: wrongDim.fetch });
  await assert.rejects(e.embed(["a"]), /dimension mismatch: bge-small-en-v1\.5 returned 4 dims, FORAY_EMBED_DIM says 3/);

  const short = fakeFetch(() => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
  await assert.rejects((await createPassageEmbedder({ kind: "openai", env: ENV, fetch: short.fetch })).embed(["a", "b"]), /1 vectors for 2 inputs/);

  const dup = fakeFetch(() => ({ data: [{ index: 0, embedding: [1, 2, 3] }, { index: 0, embedding: [1, 2, 3] }] }));
  await assert.rejects((await createPassageEmbedder({ kind: "openai", env: ENV, fetch: dup.fetch })).embed(["a", "b"]), /repeated index/);

  const failed = fakeFetch(() => "upstream down", { status: 502 });
  await assert.rejects((await createPassageEmbedder({ kind: "openai", env: ENV, fetch: failed.fetch })).embed(["a"]), /HTTP 502 upstream down/);
});

test("openAIEmbedConfig names the missing variable; FORAY_EMBED_DIM is required", () => {
  assert.throws(() => openAIEmbedConfig({ ...ENV, FORAY_EMBED_URL: "" }), /FORAY_EMBED_URL is not set/);
  assert.throws(() => openAIEmbedConfig({ ...ENV, FORAY_EMBED_MODEL: undefined }), /FORAY_EMBED_MODEL is not set/);
  assert.throws(() => openAIEmbedConfig({ ...ENV, FORAY_EMBED_DIM: undefined }), /FORAY_EMBED_DIM must be a positive integer/);
  assert.throws(() => openAIEmbedConfig({ ...ENV, FORAY_EMBED_DIM: "3.5" }), /FORAY_EMBED_DIM/);
  const cfg = openAIEmbedConfig({ ...ENV, FORAY_EMBED_QUERY_PREFIX: "query: ", FORAY_EMBED_REVISION: "r2" });
  assert.equal(cfg.url, "http://embed.test:4000");
  assert.equal(cfg.query_prefix, "query: ");
  assert.equal(cfg.revision, "r2");
});

test("the transformers embedder delegates to tools/corpus createEmbedder and keeps its tokenizer", async () => {
  const seen = [];
  const createEmbedder = async (opts) => {
    seen.push(opts);
    return {
      model: opts.model,
      encode: async (texts) => texts.map(() => new Float32Array(384).fill(1)),
      countTokens: (t) => t.length,
    };
  };
  const e = await createPassageEmbedder({ kind: "transformers", createEmbedder, allowRemote: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, BGE_SMALL_EN_V15);
  assert.equal(seen[0].allowRemote, false);
  assert.deepEqual(e.model, transformersSpec(BGE_SMALL_EN_V15));
  assert.equal(e.model.revision, "main+q8", "quantization is part of the vector space");
  assert.equal(e.model.query_prefix, BGE_SMALL_EN_V15.query_prefix);
  assert.equal(e.model.passage_prefix, "");
  assert.equal(e.countTokens("abcd"), 4);
  assert.equal((await e.embed(["x", "y"])).length, 2);
});

test("an unknown kind is refused", async () => {
  assert.deepEqual(EMBEDDER_KINDS, ["stub", "transformers", "openai"]);
  await assert.rejects(createPassageEmbedder({ kind: "anthropic" }), /unknown embedder kind "anthropic"/);
  await assert.rejects(createPassageEmbedder(), /unknown embedder kind/);
});
