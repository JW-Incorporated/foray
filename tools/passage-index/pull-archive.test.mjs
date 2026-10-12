/* GV-16 (from W3-08; docs/roadmap/generation-v2.md): pull-archive.mjs writes
   the retrieval server's archive as this box's corpus digest, and the serve.mjs
   launcher points at the server entry.

   Every test runs against a fake HTTP server on an ephemeral loopback port, or
   no server at all; nothing reaches a real retrieval server, R2 or a model.
   The read-back half of the acceptance (loadTranscriptArchive over the pulled
   digest gives the server's item ids) runs in backend/test/retrievalServer.test.ts,
   where the backend loader is importable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { archiveUrl, digestFromArchive, parsePullArgs, pullArchive, PullArchiveError } from "./pull-archive.mjs";
import { REPO_ROOT, SERVE_ENTRY, serveArgs } from "./serve.mjs";

const ROWS = [
  { show_id: "gv16-alpha", show_title: "Alpha", guid: "a1", title: "Weekly roundup", cues: 4, enclosure_url: "https://cdn.example/a1.mp3" },
  { show_id: "gv16-alpha", show_title: "Alpha", guid: "a2", title: "Weekly roundup", cues: 3, item_id_suffix: "abc123" },
  { show_id: "gv16-beta", show_title: "Beta", guid: "https://example.com/permalink/b1/", title: "Beta one", cues: 2 },
];

/** A fake retrieval server: answers /v1/archive with `respond(req)`. */
async function fakeServer(respond) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const { status = 200, payload, raw, gzip = false } = respond(req);
    const json = Buffer.from(raw ?? JSON.stringify(payload));
    const body = gzip ? gzipSync(json) : json;
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (gzip) headers["content-encoding"] = "gzip";
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "gv16-pull-"));
}

test("pulls /v1/archive with the bearer token, decodes gzip, strips item_id_suffix and writes the digest atomically", async () => {
  /* MUTATIONS THAT KILL THIS: drop the item_id_suffix strip in
     digestFromArchive (a2 keeps "abc123"); drop the authorization header (the
     fake sees none); copy the payload's generated_at into the digest's own
     generated_at (the digest then claims the server's time, not the pull's). */
  const srv = await fakeServer(() => ({ payload: { generated_at: "2026-10-01T00:00:00.000Z", transcripts: ROWS }, gzip: true }));
  const dir = tmp();
  try {
    const out = join(dir, "transcripts", "corpus-digest.json");
    const result = await pullArchive({ url: `${srv.url}/`, out, token: "s3cret", now: () => new Date("2026-10-11T12:00:00.000Z") });
    assert.equal(result.rows, 3);
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].url, "/v1/archive");
    assert.equal(srv.seen[0].headers.authorization, "Bearer s3cret");
    assert.match(String(srv.seen[0].headers["accept-encoding"]), /gzip/);
    const digest = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(digest.version, 1);
    assert.equal(digest.generated_at, "2026-10-11T12:00:00.000Z");
    assert.deepEqual(digest.pulled_from, { url: srv.url, archive_generated_at: "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(digest.summary, { transcripts: 3 });
    const { item_id_suffix: _dropped, ...a2 } = ROWS[1];
    assert.deepEqual(digest.transcripts, [ROWS[0], a2, ROWS[2]]);
    assert.ok(digest.transcripts.every((r) => !("item_id_suffix" in r)));
    // Only the digest is left behind: no tmp sibling.
    assert.deepEqual(readdirSync(join(dir, "transcripts")), ["corpus-digest.json"]);
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused answer (HTTP error, bad row, not JSON, empty archive) leaves the existing digest byte for byte", async () => {
  /* MUTATION THAT KILLS THIS: in pullArchive, write the payload before
     digestFromArchive validates it (or validate rows lazily, after the
     write) — the old file is replaced by the bad answer. */
  const cases = [
    { name: "HTTP_401", respond: () => ({ status: 401, payload: { error: "missing or wrong bearer token" } }) },
    { name: "BAD_ARCHIVE", respond: () => ({ payload: { transcripts: [ROWS[0], { show_id: "gv16-alpha", title: "no guid" }] } }) },
    { name: "BAD_ARCHIVE", respond: () => ({ payload: { rows: ROWS } }) },
    { name: "BAD_ARCHIVE", respond: () => ({ raw: "{not json" }) },
    { name: "EMPTY_ARCHIVE", respond: () => ({ payload: { transcripts: [] } }) },
  ];
  for (const c of cases) {
    const srv = await fakeServer(c.respond);
    const dir = tmp();
    try {
      const out = join(dir, "corpus-digest.json");
      const before = JSON.stringify({ version: 1, transcripts: [ROWS[0]] });
      writeFileSync(out, before, "utf8");
      await assert.rejects(pullArchive({ url: srv.url, out }), (e) => e instanceof PullArchiveError && e.code === c.name, c.name);
      assert.equal(readFileSync(out, "utf8"), before, c.name);
      assert.deepEqual(readdirSync(dir), ["corpus-digest.json"], c.name);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // --allow-empty writes an empty digest on purpose.
  const digest = digestFromArchive({ transcripts: [] }, { allowEmpty: true, now: () => new Date(0) });
  assert.deepEqual(digest.transcripts, []);
});

test("parsePullArgs: --url or FORAY_RETRIEVAL_URL, the token from the environment or its file (never argv), --out resolved", () => {
  const dir = tmp();
  try {
    const tokenFile = join(dir, "token.txt");
    writeFileSync(tokenFile, "from-file\n", "utf8");
    const a = parsePullArgs(["--out", join(dir, "x.json")], { FORAY_RETRIEVAL_URL: "http://box:7311", FORAY_RETRIEVAL_TOKEN_FILE: tokenFile });
    assert.equal(a.url, "http://box:7311");
    assert.equal(a.token, "from-file");
    assert.equal(a.out, join(dir, "x.json"));
    assert.equal(a.allowEmpty, false);
    const b = parsePullArgs(["--url", "http://other:1", "--allow-empty", "--timeout-ms", "5"], { FORAY_RETRIEVAL_TOKEN: " t0k " });
    assert.equal(b.url, "http://other:1");
    assert.equal(b.token, "t0k");
    assert.equal(b.timeoutMs, 5);
    assert.equal(b.allowEmpty, true);
    assert.match(b.out, /data-local[\\/]transcripts[\\/]corpus-digest\.json$/);
    assert.throws(() => parsePullArgs([], {}), (e) => e instanceof PullArchiveError && e.code === "USAGE");
    assert.equal(archiveUrl("http://box:7311///"), "http://box:7311/v1/archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve.mjs launches the backend retrieval server entry and passes every flag through", () => {
  /* MUTATION THAT KILLS THIS: rename SERVE_ENTRY (or the backend file) — the
     launcher would spawn a path that does not exist. */
  assert.equal(SERVE_ENTRY, "src/cli/retrievalServer.ts");
  assert.ok(existsSync(join(REPO_ROOT, "backend", SERVE_ENTRY)));
  const argv = ["--host", "0.0.0.0", "--shows", "a,b", "--port", "0"];
  const out = serveArgs(argv);
  assert.deepEqual(out, argv);
  assert.notEqual(out, argv);
});
