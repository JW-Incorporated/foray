/* PKG-11 (docs/roadmap/corpus.md): the R2 S3 client on a fake client. The
   fake has the SDK client's one method, `send(cmd)`, and switches on
   `cmd.constructor.name`, so the real ListObjectsV2Command /
   GetObjectCommand classes are built (no request is ever made). The
   S3Client class is injected to capture the constructor arguments, the env
   is a plain object and readFile is a stub, so no test opens a network
   connection, reads a real credential file or prints a secret. Every
   credential below is invented. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createR2Client, getObject, listPrefix, loadR2Credentials, sha256 } from "./r2-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/* Fake client: two ListObjectsV2 pages chained by a continuation token. A
   call budget stops a client that never passes the token from looping. */
function pagedClient() {
  const seen = [];
  return {
    seen,
    async send(cmd) {
      assert.equal(cmd.constructor.name, "ListObjectsV2Command");
      seen.push(cmd.input);
      if (seen.length > 4) throw new Error("token never passed back");
      if (cmd.input.ContinuationToken === undefined) {
        return {
          IsTruncated: true,
          NextContinuationToken: "page-2",
          Contents: [{ Key: "transcripts/normalized/a/1.json", Size: 10, ETag: '"e1"', LastModified: new Date(0) }],
        };
      }
      if (cmd.input.ContinuationToken === "page-2") {
        return {
          IsTruncated: false,
          Contents: [
            { Key: "transcripts/normalized/a/2.json", Size: 20, ETag: '"e2"' },
            { Key: "transcripts/normalized/b/3.json", Size: 30, ETag: '"e3"' },
          ],
        };
      }
      throw new Error(`unexpected token ${cmd.input.ContinuationToken}`);
    },
  };
}

/* (a) Both pages arrive, in order, and the second request carries the first
   page's NextContinuationToken.
   Mutation that turns this red: in listPrefix send
   `ContinuationToken: undefined` instead of `token` (page 1 repeats until the
   fake's call budget throws). */
test("listPrefix concatenates two pages and passes the continuation token back", async () => {
  const client = pagedClient();
  const got = [];
  for await (const o of listPrefix(client, "bkt", "transcripts/normalized/")) got.push(o);
  assert.deepEqual(
    got.map((o) => [o.key, o.size, o.etag]),
    [
      ["transcripts/normalized/a/1.json", 10, '"e1"'],
      ["transcripts/normalized/a/2.json", 20, '"e2"'],
      ["transcripts/normalized/b/3.json", 30, '"e3"'],
    ],
  );
  assert.deepEqual(
    client.seen.map((i) => [i.Bucket, i.Prefix, i.ContinuationToken]),
    [
      ["bkt", "transcripts/normalized/", undefined],
      ["bkt", "transcripts/normalized/", "page-2"],
    ],
  );
});

/* (b) The body is read whole through Body.transformToByteArray into a Buffer,
   and sha256Meta is the farm's `sha256` user metadata, not the ETag.
   sha256("hello") is the well-known
   2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.
   Mutation that turns this red: in getObject return
   `sha256Meta: res.ETag` (the etag is not the body hash). */
test("getObject returns the body Buffer and the sha256 metadata", async () => {
  const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const client = {
    async send(cmd) {
      assert.equal(cmd.constructor.name, "GetObjectCommand");
      assert.deepEqual([cmd.input.Bucket, cmd.input.Key], ["bkt", "transcripts/normalized/a/1.json"]);
      return {
        ContentLength: 5,
        ETag: '"5d41402abc4b2a76b9719d911017c592"',
        Metadata: { sha256: HELLO_SHA },
        Body: { transformToByteArray: async () => new Uint8Array(Buffer.from("hello")) },
      };
    },
  };
  const got = await getObject(client, "bkt", "transcripts/normalized/a/1.json");
  assert.ok(Buffer.isBuffer(got.body));
  assert.equal(got.body.toString("utf8"), "hello");
  assert.equal(sha256(got.body), HELLO_SHA);
  assert.equal(got.sha256Meta, HELLO_SHA);
  assert.equal(got.size, 5);
});

/* (c) The credential file resolves through the lowercased alias table in
   both spellings a founder may write: the Cloudflare dashboard's
   (`Access_Key_ID = …`, `Secret_Access_Key = …`, `S3_API_Endpoint = …`)
   and the env-var spelling HUMAN-ACTIONS #138 step 2 prescribes
   (`R2_ACCESS_KEY_ID=` … `R2_BUCKET=`, no spaces). Logging the result never
   shows the secret or the key id.
   Mutations that turn this red: in r2-client.mjs toJSON return
   `secretAccessKey: this.secretAccessKey` too (the stringify check), or drop
   `.toLowerCase()` from parseCredentialsText (the dashboard spelling stops
   resolving), or remove "r2_access_key_id" from ALIASES.accessKeyId (the
   #138 spelling stops resolving). */
test("credential file: dashboard and HUMAN-ACTIONS #138 spellings resolve; stringify never shows the secret", async () => {
  const files = {
    "/home/x/dash": "# from the Cloudflare dashboard\nAccess_Key_ID = AKFAKEDASH\nSecret_Access_Key = sEcReT-dash-111\nS3_API_Endpoint = https://acct.r2.cloudflarestorage.com\n",
    "/home/x/ha138": "R2_ACCESS_KEY_ID=AKFAKE138\r\nR2_SECRET_ACCESS_KEY=sEcReT-138-222\r\nR2_S3_ENDPOINT=https://acct138.r2.cloudflarestorage.com\r\nR2_BUCKET=foray-transcriptions-alt\r\n",
  };
  const readFile = async (p) => {
    if (!(p in files)) throw Object.assign(new Error("nope"), { code: "ENOENT" });
    return files[p];
  };

  const dash = await loadR2Credentials({ env: { R2_CREDENTIALS_FILE: "/home/x/dash" }, readFile });
  assert.equal(dash.accessKeyId, "AKFAKEDASH");
  assert.equal(dash.secretAccessKey, "sEcReT-dash-111");
  assert.equal(dash.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.equal(dash.bucket, "foray-transcriptions");
  const shown = JSON.stringify(dash);
  assert.ok(!shown.includes("sEcReT-dash-111"), shown);
  assert.ok(!shown.includes("AKFAKEDASH"), shown);
  assert.deepEqual(JSON.parse(shown), { accessKeyId: "<redacted>", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "foray-transcriptions" });

  const ha = await loadR2Credentials({ env: { R2_CREDENTIALS_FILE: "/home/x/ha138" }, readFile });
  assert.deepEqual(
    [ha.accessKeyId, ha.secretAccessKey, ha.endpoint, ha.bucket],
    ["AKFAKE138", "sEcReT-138-222", "https://acct138.r2.cloudflarestorage.com", "foray-transcriptions-alt"],
  );
  assert.ok(!JSON.stringify(ha).includes("sEcReT-138-222"));
});

/* (d) No env and no file: the error names the sources tried
   (R2_CREDENTIALS_FILE and the default ~/.foray/r2-credentials path) so the
   operator knows where to put the key, and carries the NO_CREDENTIALS code.
   Mutation that turns this red: in loadR2Credentials replace the catch's
   throw with `throw new R2Error("NO_CREDENTIALS", "no credentials")` (a bare
   message that names no source). */
test("missing env and file throws NO_CREDENTIALS naming R2_CREDENTIALS_FILE and the default path", async () => {
  const readFile = async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  await assert.rejects(
    loadR2Credentials({ env: { R2_ACCESS_KEY_ID: "AKONLY" }, readFile, homedir: () => "/home/nobody" }),
    (e) => {
      assert.equal(e.code, "NO_CREDENTIALS");
      assert.match(e.message, /R2_CREDENTIALS_FILE/);
      assert.match(e.message, /\.foray[\\/]r2-credentials/);
      assert.ok(!e.message.includes("AKONLY"), "never echoes a value");
      return true;
    },
  );
});

/* (e) The farm's construction, captured through an injected S3Client class:
   region auto, path-style, and both checksum options "WHEN_REQUIRED" (R2's
   one gotcha).
   Mutation that turns this red: delete the
   `responseChecksumValidation: "WHEN_REQUIRED",` line in createR2Client. */
test("createR2Client constructs the S3 client with the farm's R2 options", async () => {
  const captured = [];
  class FakeS3 {
    constructor(args) {
      captured.push(args);
    }
  }
  const creds = await loadR2Credentials({
    env: { R2_ACCESS_KEY_ID: "AKENV", R2_SECRET_ACCESS_KEY: "sEcReT-env", R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" },
    readFile: async () => {
      throw new Error("env is complete; the file must not be read");
    },
  });
  const client = await createR2Client(creds, { S3Client: FakeS3 });
  assert.ok(client instanceof FakeS3);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKENV", secretAccessKey: "sEcReT-env" },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
});

/* (f) No credential file is ever tracked. The set is `git ls-files` over the
   whole repo (what a push would publish), not a directory walk: an ignored
   local file is not a leak, a tracked one is.
   Mutation that turns this red: `git add -f` an empty file named
   tools/foraycorpus-export/fixtures/r2-credentials (run, then unstaged). */
test("git ls-files tracks no path ending in r2-credentials", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  assert.ok(tracked.length > 0, "git ls-files returned nothing");
  assert.deepEqual(
    tracked.filter((p) => p.endsWith("r2-credentials")),
    [],
  );
});
