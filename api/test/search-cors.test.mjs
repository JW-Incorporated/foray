// api/shows/search.ts CORS wiring test (S-02, kanban t_4bd3c0a3) — see
// api/test/cors.test.mjs for the shared-module unit tests; this only
// confirms the endpoint actually calls applyCors.
import { test } from "node:test";
import assert from "node:assert";
import * as searchModule from "../shows/search.ts";

const handler = typeof searchModule.default === "function" ? searchModule.default : searchModule.default.default;

function mockRes() {
  const headers = {};
  const state = { statusCode: null, body: undefined, ended: false };
  return {
    headers,
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    end() {
      state.ended = true;
    }
  };
}

test("search.ts: OPTIONS preflight is answered by CORS, never reaches the handler body", () => {
  const req = { method: "OPTIONS", query: {}, headers: { origin: "https://jw-incorporated.github.io" } };
  const res = mockRes();
  handler(req, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://jw-incorporated.github.io");
});

test("search.ts: a normal GET from an allowed origin gets ACAO alongside the existing response", () => {
  const req = { method: "GET", query: { q: "lex" }, headers: { origin: "capacitor://localhost" } };
  const res = mockRes();
  handler(req, res);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "capacitor://localhost");
  assert.strictEqual(res.statusCode, 200);
});
