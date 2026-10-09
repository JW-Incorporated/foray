// api/_lib/cors.ts unit tests (S-02, kanban t_4bd3c0a3).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCors, ALLOWED_ORIGINS } from "../_lib/cors.ts";

function mockRes() {
  const headers = {};
  let statusCode = null;
  let ended = false;
  const jsonBody = { value: undefined };
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
    get body() {
      return jsonBody.value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody.value = body;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    end() {
      ended = true;
    }
  };
}

test("pins the exact allowed-origins list", () => {
  assert.deepStrictEqual(ALLOWED_ORIGINS, [
    "capacitor://localhost",
    "https://localhost",
    "https://jwlabs.ai",
    "https://jw-incorporated.github.io",
    "https://foray-web-seven.vercel.app"
  ]);
});

test("echoes ACAO for an allowed origin on a normal GET", () => {
  const res = mockRes();
  const handled = applyCors({ method: "GET", headers: { origin: "https://jwlabs.ai" } }, res);
  assert.strictEqual(handled, false);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://jwlabs.ai");
});

test("sets Vary: Origin on every response, even a disallowed/missing origin", () => {
  const res1 = mockRes();
  applyCors({ method: "GET", headers: {} }, res1);
  assert.strictEqual(res1.headers.Vary, "Origin");

  const res2 = mockRes();
  applyCors({ method: "GET", headers: { origin: "https://evil.example" } }, res2);
  assert.strictEqual(res2.headers.Vary, "Origin");
  assert.strictEqual(res2.headers["Access-Control-Allow-Origin"], undefined);
});

test("never sets Access-Control-Allow-Credentials (public read-only API)", () => {
  const res = mockRes();
  applyCors({ method: "GET", headers: { origin: "https://jwlabs.ai" } }, res);
  assert.strictEqual(res.headers["Access-Control-Allow-Credentials"], undefined);
});

test("handles an OPTIONS preflight itself: 204, methods, max-age, and tells the caller to stop", () => {
  const res = mockRes();
  const handled = applyCors({ method: "OPTIONS", headers: { origin: "capacitor://localhost" } }, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.ended, true);
  assert.strictEqual(res.headers["Access-Control-Allow-Methods"], "GET, OPTIONS");
  assert.ok(res.headers["Access-Control-Max-Age"]);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "capacitor://localhost");
});

test("an unrecognised origin is never echoed back", () => {
  const res = mockRes();
  applyCors({ method: "GET", headers: { origin: "https://not-us.example" } }, res);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], undefined);
});

/* code-health-2 CH2-40 (A1-12): cors.ts's header says every handler calls
   applyCors first, and that it reads only the lowercase `origin` header. */

test("every api handler answers CORS first: `if (applyCors(req, res)) return;` opens its default export", () => {
  /* MUTATION: delete the applyCors line from any handler (or move it below
     the method check, so a preflight gets a 405) and this goes red. */
  const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const handlers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith("_")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) handlers.push(full);
    }
  };
  walk(apiDir);
  assert.ok(handlers.length >= 4, `found ${handlers.length} handlers`);
  for (const file of handlers) {
    const src = fs.readFileSync(file, "utf8");
    const body = /export default async function handler\(req: ApiRequest, res: ApiResponse\): Promise<void> \{\s*\n\s*([^\n]*)/.exec(src);
    assert.ok(body, `${path.relative(apiDir, file)}: no default handler`);
    assert.match(body[1], /^if \(applyCors\(req, res\)\) return;/, `${path.relative(apiDir, file)} must answer CORS first`);
  }
});

test("a capitalised `Origin` key is not read (Node never produces one; see params.test.mjs)", () => {
  /* MUTATION: restore `?? req.headers.Origin` in applyCors and the origin is
     echoed: red. */
  const res = mockRes();
  applyCors({ method: "GET", headers: { Origin: "https://jwlabs.ai" } }, res);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], undefined);
  assert.strictEqual(res.headers.Vary, "Origin");
});
