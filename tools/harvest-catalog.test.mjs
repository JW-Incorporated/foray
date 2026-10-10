/* tools/harvest-catalog.mjs fetches through harvest-merge's politeFetchJson,
 * the ONE retry policy for Apple's iTunes endpoints (CH2-32,
 * docs/roadmap/code-health-2.md T1-19). The policy itself is pinned with a fake
 * fetch in tools/harvest-merge.test.mjs; this suite proves the harvester obeys
 * it rather than a private copy.
 *
 * The harvester runs `main()` when loaded, so it is driven as the operator runs
 * it: a child `node tools/harvest-catalog.mjs --genres 0 --out <tmp>` with a
 * preload that replaces `fetch` with a scripted fake (no network) and makes
 * `setTimeout` immediate (the 3 s throttle and backoffs cost nothing here).
 * `--genres 0` means one request — Apple's genre tree — then an empty harvest
 * written to the temp file.
 *
 * Every test names the mutation that kills it.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARVESTER = path.join(ROOT, "tools", "harvest-catalog.mjs");

const PRELOAD = `
const script = JSON.parse(process.env.FAKE_FETCH_SCRIPT);
let n = 0;
globalThis.setTimeout = (fn) => setImmediate(fn);
globalThis.fetch = async (url) => {
  const step = script[Math.min(n, script.length - 1)];
  n++;
  process.stderr.write("FAKE_FETCH " + url + "\\n");
  if (step.throw) throw new TypeError(step.throw);
  return { status: step.status, ok: step.status >= 200 && step.status < 300, json: async () => step.body ?? {} };
};
`;

const GENRE_TREE = { "26": { id: "26", name: "Podcasts", subgenres: {} } };

function runHarvester(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-catalog-"));
  try {
    const preload = path.join(dir, "fake-fetch.mjs");
    fs.writeFileSync(preload, PRELOAD);
    const out = path.join(dir, "breadth.json");
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, HARVESTER, "--genres", "0", "--out", out], {
      env: { ...process.env, FAKE_FETCH_SCRIPT: JSON.stringify(script) },
      encoding: "utf8",
      timeout: 60_000,
    });
    const fetches = (r.stderr.match(/^FAKE_FETCH /gm) || []).length;
    const written = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, fetches, written };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a 404 from Apple fails on the FIRST request, not after four", () => {
  /* RED before CH2-32: the harvester's private fetchJson retried every
     failure, so a 404 (or a malformed id batch's 400) was requested 4 times
     behind 3+6+12+24 s of sleeps before it was skipped.
     MUTATION: retry any !res.ok in politeFetchJson -> fetches = 4. */
  const r = runHarvester([{ status: 404 }]);
  assert.strictEqual(r.fetches, 1, r.stderr);
  assert.strictEqual(r.status, 1, "the genre tree is the one request a run cannot skip");
  assert.match(r.stderr, /HTTP 404/);
  assert.strictEqual(r.written, null);
});

test("a 503 and a thrown fetch are retried, and the run completes", () => {
  /* MUTATION: drop the 5xx rule or let a thrown fetch escape in
     politeFetchJson -> the genre tree is never fetched and the run exits 1. */
  const r = runHarvester([{ status: 503 }, { throw: "fetch failed" }, { status: 200, body: GENRE_TREE }]);
  assert.strictEqual(r.fetches, 3, r.stderr);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /HARVEST_COMPLETE/);
  assert.deepStrictEqual(r.written.shows, []);
});

test("the harvester keeps no fetcher of its own", () => {
  /* The card's acceptance grep. MUTATION: paste a private fetchJson with its
     own retry rule back in -> `attempt` reappears and the import is unused. */
  const src = fs.readFileSync(HARVESTER, "utf8");
  assert.match(src, /import \{[^}]*\bpoliteFetchJson\b[^}]*\} from "\.\/harvest-merge\.mjs"/,
    "tools/harvest-catalog.mjs must import politeFetchJson from ./harvest-merge.mjs");
  assert.doesNotMatch(src, /attempt/, "a private retry loop is back in tools/harvest-catalog.mjs");
  assert.doesNotMatch(src, /\bfetch\(/, "every request goes through politeFetchJson");
});
