/* Tests for the enclosure downloader (issue #120). Run:
     node --test tools/transcribe/

   NOTHING HERE TOUCHES THE NETWORK. Every rule that matters in fetch-audio.mjs
   is a pure function over numbers and strings — disk arithmetic, resume
   decisions, backoff, URL handling — precisely so it can be tested without
   hitting a publisher's CDN. Downloading in a test suite would violate the
   politeness the module exists to enforce, and would make CI depend on a third
   party's uptime.

   The two tests worth reading first are the disk ones. The high-water test is
   the one standing between this tool and a silently filled laptop disk, and the
   git-tracking test is the one standing between us and a repository full of
   committed mp3s. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DEFAULT_MAX_RESIDENT_BYTES, DEFAULT_MIN_FREE_BYTES, DOWNLOAD_DIR, ROOT, UA,
  DiskBudgetError, DiskGuardError, SelectionError, UnusableUrlError, FetchAudioError,
  HostGate, ResidentLedger,
  assertFreeSpace, backoffDelayMs, cleanup, estimateBytes, extensionFor, fetchEpisode,
  fmtBytes, hostOf, loadCheckpoint, mergeCheckpoint, parseContentRange, parseRetryAfter,
  partPathFor, provenance, resumePlan, safeFileName, saveCheckpoint, selectEpisodes, updateCheckpoint,
  shouldRetryStatus, targetPath, verifyResumeResponse,
} from "./fetch-audio.mjs";
/* Imported from the owner rather than restated — the same rule the module
   under test follows for `UA`. A literal "en" here would be a copy of a header
   value whose whole point is that one definition serves every fetcher. */
import { ACCEPT_LANGUAGE } from "../segments/politeness.mjs";

const item = (over = {}) => ({ id: "show--ep", audio_url: "https://cdn.example.com/a.mp3", topics: ["science/physics"], ...over });

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "foray-audio-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/* ------------------------------------------------------------- selection */

test("selects by explicit ids, in the order asked", () => {
  const pool = { items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })] };
  const { selected } = selectEpisodes(pool, { ids: ["c", "a"] });
  assert.deepEqual(selected.map((i) => i.id), ["c", "a"]);
});

test("an unknown id is an error, not a quietly shorter list", () => {
  // The whole point of LESSONS.md's rule: a run that fetches 2 of the 3
  // episodes you named, and says "done", is worse than one that stops.
  const pool = { items: [item({ id: "a" })] };
  assert.throws(() => selectEpisodes(pool, { ids: ["a", "nope"] }), (e) => {
    assert.ok(e instanceof SelectionError);
    assert.equal(e.code, "SELECTION");
    assert.match(e.message, /nope/);
    return true;
  });
});

test("topic filter matches the branch, not just the exact node", () => {
  const pool = { items: [
    item({ id: "a", topics: ["science/physics"] }),
    item({ id: "b", topics: ["science"] }),
    item({ id: "c", topics: ["history/rome"] }),
  ] };
  assert.deepEqual(selectEpisodes(pool, { topic: "science" }).selected.map((i) => i.id), ["a", "b"]);
  assert.deepEqual(selectEpisodes(pool, { topic: "history/rome" }).selected.map((i) => i.id), ["c"]);
});

test("a topic nobody carries is an error", () => {
  assert.throws(() => selectEpisodes({ items: [item()] }, { topic: "sports/curling" }), SelectionError);
});

test("items without a usable enclosure are skipped with a reason, not dropped", () => {
  const pool = { items: [
    item({ id: "a" }),
    item({ id: "b", audio_url: null }),
    item({ id: "c", audio_url: "http://cdn.example.com/x.mp3" }),
  ] };
  const { selected, skipped } = selectEpisodes(pool, { ids: ["a", "b", "c"] });
  assert.deepEqual(selected.map((i) => i.id), ["a"]);
  assert.deepEqual(skipped, [
    { id: "b", reason: "no enclosure url" },
    { id: "c", reason: "non-https enclosure" },
  ]);
});

test("a selection where everything is unfetchable throws rather than returning []", () => {
  const pool = { items: [item({ id: "a", audio_url: null })] };
  assert.throws(() => selectEpisodes(pool, { ids: ["a"] }), (e) => e instanceof SelectionError && /unfetchable/.test(e.message));
});

test("refuses to fetch the whole catalogue with no filter at all", () => {
  assert.throws(() => selectEpisodes({ items: [item()] }, {}), SelectionError);
});

test("limit caps the selection", () => {
  const pool = { items: ["a", "b", "c", "d"].map((id) => item({ id })) };
  assert.equal(selectEpisodes(pool, { topic: "science", limit: 2 }).selected.length, 2);
});

test("a non-discover shape is a named error", () => {
  assert.throws(() => selectEpisodes({ nope: true }, { ids: ["a"] }), SelectionError);
});

test("the real data/discover.json is the shape this module assumes", async () => {
  const pool = JSON.parse(await readFile(join(ROOT, "data", "discover.json"), "utf8"));
  const withAudio = pool.items.find((i) => i.audio_url);
  assert.ok(withAudio, "discover.json should contain at least one playable item");
  const { selected } = selectEpisodes(pool, { ids: [withAudio.id] });
  assert.equal(selected[0].id, withAudio.id);
  assert.ok(estimateBytes(selected[0]) > 0);
});

/* ------------------------------------------------------------------ urls */

test("extension comes from the path, never the query string", () => {
  assert.equal(extensionFor("https://h/a.mp3"), ".mp3");
  assert.equal(extensionFor("https://h/a.m4a?utm_source=x&ext=.exe"), ".m4a");
  assert.equal(extensionFor("https://h/traffic/redirect/audio"), ".mp3");
  assert.equal(extensionFor("https://h/a.php?f=b.mp3"), ".mp3");
  assert.equal(extensionFor("https://h/a.exe"), ".mp3", "unknown extensions collapse to .mp3");
});

test("episode ids cannot escape the download dir", () => {
  // Ids are data from a JSON file. Treating them as path components is the
  // classic way a downloader writes to somewhere it shouldn't.
  for (const evil of ["../../etc/passwd", "..\\..\\windows\\system32\\a", "/absolute/thing", "a/../../b"]) {
    const name = safeFileName(evil, "https://h/a.mp3");
    assert.ok(!name.includes("/") && !name.includes("\\"), name);
    assert.ok(!name.startsWith("."), name);
    const p = targetPath(evil, "https://h/a.mp3", "/tmp/dl");
    assert.ok(p.length > "/tmp/dl".length);
  }
});

test("an id with nothing usable in it is a named error, not a random filename", () => {
  for (const bad of ["", null, undefined, "///", "..."]) {
    assert.throws(() => safeFileName(bad, "https://h/a.mp3"), UnusableUrlError);
  }
});

test("normal ids survive sanitisation legibly", () => {
  assert.equal(safeFileName("lex-fridman-podcast--don-lincoln-physics", "https://h/x.mp3"),
    "lex-fridman-podcast--don-lincoln-physics.mp3");
});

test("the part file is the final path plus .part", () => {
  assert.equal(partPathFor("/d/a.mp3"), "/d/a.mp3.part");
});

test("provenance keeps the publisher's declared URL even when the CDN differs", () => {
  // Corner case #1. This is the assertion that stops a future refactor from
  // "helpfully" caching the resolved URL and quietly stealing download counts.
  const it = item({ id: "e1", audio_url: "https://dts.podtrac.com/redirect.mp3/media.blubrry.com/x/a.mp3" });
  const p = provenance(it, { resolvedUrl: "https://dcs-cached.megaphone.fm/REAL123.mp3?key=abc", bytes: 10 });
  assert.equal(p.url, it.audio_url);
  assert.equal(p.declared_host, "dts.podtrac.com");
  assert.equal(p.resolved_host, "dcs-cached.megaphone.fm");
  assert.ok(!JSON.stringify(p).includes("REAL123"), "the resolved URL itself is never stored");
});

test("dai_suspected is carried into the report but changes nothing about selection", () => {
  const pool = { items: [item({ id: "a", dai_suspected: true }), item({ id: "b", dai_suspected: false })] };
  assert.equal(selectEpisodes(pool, { topic: "science" }).selected.length, 2);
  assert.equal(provenance(pool.items[0]).dai_suspected, true);
});

test("hostOf tolerates junk", () => {
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf("https://CDN.Example.com/a.mp3"), "cdn.example.com");
});

test("the User-Agent is honest and carries contact info (corner case #8)", () => {
  assert.match(UA, /Foray/);
  assert.match(UA, /@/, "a UA with no way to reach us is not an honest one");
});

/* THE ONE EXCEPTION TO "NOTHING HERE TOUCHES THE NETWORK", and it does not: it
   replaces `globalThis.fetch` and asserts on the request that WOULD have gone
   out. There is no other seam — `fetchEpisode` calls the global directly — and
   the header below is worth a stubbed fetch because its absence is invisible
   from inside this module and fatal from outside it.

   WHAT IT GUARDS. Node's fetch sends `accept-language: *` by default, and
   Captivate's edge answers THAT with `404 Missing redirect URL` on every
   `episodes.captivate.fm/episode/<guid>.mp3` redirector. `politeness.mjs`
   records the header being verified both ways (`*` -> 404, `en` -> 302) after
   it cost an afternoon in #226, and re-verified when an ad-inflation scan
   without it drew 404 on every Captivate enclosure (#316).

   THIS DOWNLOADER DID NOT SEND IT until decode-and-compare asked it for a
   Captivate episode. The probes had sent it since #316 and this file never
   did, so the two disagreed about how to ask one host for one file — and a 404
   here is not a soft failure: `shouldRetryStatus` does not retry a 404, so the
   whole of Captivate was un-downloadable by the transcription pipeline,
   silently, on a missing header. That is the #316 shape exactly, one directory
   over.

   MUTATION: delete the `"Accept-Language": ACCEPT_LANGUAGE` line from
   `fetchEpisode`. Verified failing (byte diff confirmed):
     the downloader sends Accept-Language, or Captivate 404s every enclosure
   Reverted. */
test("the downloader sends Accept-Language, or Captivate 404s every enclosure", async () => {
  /* minFreeBytes: 0 — this test is about the request header, not the disk
     guard (that has its own direct tests above), and defaulting to
     DEFAULT_MIN_FREE_BYTES (5 GiB) made it depend on how much real free space
     happens to be on whatever machine runs the suite. Verified failing on a
     host with a small tmpfs `/tmp` (a 512 MB `os.tmpdir()`, common in
     container sandboxes) with the default: `DiskGuardError: only 504.2 MB
     free, need 5.0 GB — refusing to start`, thrown from `fetchEpisode`'s own
     assertFreeSpace() call before the header this test cares about was ever
     inspected. Pinning minFreeBytes to 0 removes that dependency the same
     way this suite already isolates itself from the network. */
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers || {} });
    return new Response(Buffer.alloc(4096, 0x61), {
      status: 200,
      headers: { "content-length": "4096", etag: '"abc"' },
    });
  };
  try {
    await withTempDir(async (dir) => {
      const url = "https://episodes.captivate.fm/episode/95c360e7.mp3";
      const got = await fetchEpisode(
        { id: "captivate--ep", audio_url: url, audio_bytes: 4096 },
        { dir, checkpointPath: join(dir, "checkpoint.json"), minFreeBytes: 0 },
      );
      assert.equal(got.bytes, 4096);
    });
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(seen.length, 1, "one request, one episode");
  const headers = seen[0].headers;
  assert.equal(headers["Accept-Language"], ACCEPT_LANGUAGE);
  assert.equal(ACCEPT_LANGUAGE, "en", "the value Captivate was verified to accept");
  assert.equal(headers["User-Agent"], UA, "still the honest identity, unchanged");

  // Corner case #1: the publisher's declared URL, never a resolved CDN one.
  assert.equal(seen[0].url, "https://episodes.captivate.fm/episode/95c360e7.mp3");
});

/* --------------------------------------------------------- disk arithmetic */

test("byte estimates prefer the publisher's declared length", () => {
  assert.equal(estimateBytes({ audio_bytes: 123, duration_sec: 600 }), 123);
  assert.equal(estimateBytes({ duration_sec: 600 }), 600 * 16000);
  assert.equal(estimateBytes({ duration_min: 10 }), 600 * 16000);
  assert.equal(estimateBytes({ audio_bytes: 0, duration_sec: 0 }), 120 * 1024 * 1024, "length=0 means unknown, not empty");
  assert.equal(estimateBytes({}), 120 * 1024 * 1024);
});

test("the disk guard refuses to start below the free-space threshold", () => {
  assert.throws(() => assertFreeSpace({ freeBytes: 3 * 1024 ** 3, minFreeBytes: 5 * 1024 ** 3 }), (e) => {
    assert.ok(e instanceof DiskGuardError);
    assert.equal(e.code, "DISK_GUARD");
    assert.match(e.message, /refusing to start/);
    return true;
  });
  assert.equal(assertFreeSpace({ freeBytes: 6 * 1024 ** 3, minFreeBytes: 5 * 1024 ** 3 }), true);
});

test("unknown free space is a refusal, not an optimistic start", () => {
  for (const v of [NaN, null, undefined, -1]) {
    assert.throws(() => assertFreeSpace({ freeBytes: v, minFreeBytes: 1 }), DiskGuardError);
  }
});

test("the shipped thresholds are sane", () => {
  assert.ok(DEFAULT_MIN_FREE_BYTES >= 2 * 1024 ** 3, "too low to protect the machine");
  assert.ok(DEFAULT_MAX_RESIDENT_BYTES <= DEFAULT_MIN_FREE_BYTES, "the resident cap must fit inside the margin we insist on");
});

test("the ledger admits, accounts and releases", () => {
  const l = new ResidentLedger({ maxResidentBytes: 1000 });
  assert.equal(l.admit("a", 400), true);
  assert.equal(l.admit("b", 400), true);
  assert.equal(l.resident, 800);
  assert.equal(l.admit("c", 400), false, "no room right now");
  l.release("a");
  assert.equal(l.admit("c", 400), true);
  assert.equal(l.resident, 800);
  assert.equal(l.inFlight, 2);
});

test("a file that can never fit throws instead of waiting forever", () => {
  // The difference between "wait" and "impossible" is the difference between a
  // slow run and a run that hangs at 0% and then claims success.
  const l = new ResidentLedger({ maxResidentBytes: 1000 });
  assert.throws(() => l.admit("huge", 1001), (e) => {
    assert.ok(e instanceof DiskBudgetError);
    assert.match(e.message, /--max-resident-gb/);
    return true;
  });
  assert.throws(() => l.admit("bad", 0), DiskBudgetError);
  assert.throws(() => l.admit("bad", NaN), DiskBudgetError);
});

test("double-admitting the same episode is an error", () => {
  const l = new ResidentLedger({ maxResidentBytes: 1000 });
  l.admit("a", 100);
  assert.throws(() => l.admit("a", 100), DiskBudgetError);
});

test("resizing to the server's real length re-accounts, and overflowing is fatal", () => {
  const l = new ResidentLedger({ maxResidentBytes: 1000 });
  l.admit("a", 100);
  assert.equal(l.resize("a", 300), 300);
  assert.equal(l.highWater, 300);
  assert.throws(() => l.resize("a", 1200), DiskBudgetError);
  assert.throws(() => l.resize("ghost", 10), DiskBudgetError);
});

test("releasing something never admitted is a no-op", () => {
  const l = new ResidentLedger({ maxResidentBytes: 1000 });
  assert.equal(l.release("ghost"), 0);
});

test("HIGH-WATER MARK: resident bytes never exceed the cap across a full run", () => {
  // The disk-filling bug this module exists to prevent, simulated. 200 episodes
  // of wildly varying size through a 1 GiB cap; whatever the schedule does, the
  // high-water mark must stay under the cap and everything must be released.
  const CAP = 1024 ** 3;
  const l = new ResidentLedger({ maxResidentBytes: CAP });
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const queue = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, bytes: Math.max(1, Math.round(rnd() * 400 * 1024 * 1024)) }));

  const inFlight = [];
  let admittedCount = 0;
  while (queue.length || inFlight.length) {
    if (queue.length && l.admit(queue[0].id, queue[0].bytes)) {
      inFlight.push(queue.shift().id);
      admittedCount++;
    } else {
      assert.ok(inFlight.length > 0, "must never be stuck with nothing in flight");
      l.release(inFlight.shift());          // stands in for transcribe + cleanup
    }
    assert.ok(l.resident <= CAP, `resident ${l.resident} exceeded cap ${CAP}`);
  }
  assert.equal(admittedCount, 200);
  assert.equal(l.resident, 0, "everything released");
  assert.ok(l.highWater > 0 && l.highWater <= CAP, `high water ${l.highWater}`);
});

test("fmtBytes is readable", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(5 * 1024 ** 3), "5.0 GB");
});

/* ---------------------------------------------------------------- resume */

test("resume plan covers all four states of a partial file", () => {
  assert.deepEqual(resumePlan({ partialBytes: 0, expectedBytes: 100 }), { action: "start", from: 0, header: null });
  assert.deepEqual(resumePlan({ partialBytes: 40, expectedBytes: 100 }), { action: "resume", from: 40, header: "bytes=40-" });
  assert.equal(resumePlan({ partialBytes: 100, expectedBytes: 100 }).action, "complete");
  assert.equal(resumePlan({ partialBytes: 140, expectedBytes: 100 }).action, "restart");
});

test("a partial with no known expected size still resumes", () => {
  assert.deepEqual(resumePlan({ partialBytes: 40 }), { action: "resume", from: 40, header: "bytes=40-" });
});

test("garbage partial sizes fall back to starting over", () => {
  for (const p of [null, undefined, NaN, -5]) assert.equal(resumePlan({ partialBytes: p, expectedBytes: 100 }).action, "start");
});

test("Content-Range parsing", () => {
  assert.deepEqual(parseContentRange("bytes 200-1023/1024"), { from: 200, to: 1023, total: 1024 });
  assert.deepEqual(parseContentRange("bytes 0-0/*"), { from: 0, to: 0, total: null });
  for (const junk of ["", null, "items 0-1/2", "bytes */1024", "nonsense"]) assert.equal(parseContentRange(junk), null);
});

test("a 200 answer to a Range request means start over, not append", () => {
  // Appending the whole file onto a partial is how you get a corrupt mp3 that
  // transcribes as gibberish halfway through.
  const v = verifyResumeResponse({ status: 200, contentRange: null, from: 40 });
  assert.deepEqual([v.ok, v.restart], [false, true]);
});

test("a 416 means the partial is wrong; start over", () => {
  assert.equal(verifyResumeResponse({ status: 416, contentRange: null, from: 40 }).restart, true);
});

test("a good 206 at the right offset resumes", () => {
  const v = verifyResumeResponse({ status: 206, contentRange: "bytes 40-99/100", etag: '"abc"', from: 40, prevIdentity: '"abc"' });
  assert.equal(v.ok, true);
  assert.equal(v.total, 100);
});

test("a 206 from the wrong offset is refused", () => {
  assert.equal(verifyResumeResponse({ status: 206, contentRange: "bytes 0-99/100", from: 40 }).restart, true);
});

test("a file that changed identity between requests is restarted", () => {
  const v = verifyResumeResponse({ status: 206, contentRange: "bytes 40-199/200", etag: '"new"', from: 40, prevIdentity: '"old"' });
  assert.equal(v.restart, true);
  assert.match(v.reason, /changed/);
});

test("length substitutes for a missing ETag as the identity", () => {
  assert.equal(verifyResumeResponse({ status: 206, contentRange: "bytes 40-99/100", from: 40, prevIdentity: "len:100" }).ok, true);
  assert.equal(verifyResumeResponse({ status: 206, contentRange: "bytes 40-99/999", from: 40, prevIdentity: "len:100" }).restart, true);
});

test("DAI hosts never splice an unproven resume (corner case #2)", () => {
  // A DAI host stitches ads per request: byte N of today's copy is not byte N
  // of yesterday's, so a resume with nothing proving it is the same copy
  // produces audio with a seam in it and timestamps that lie.
  const unproven = verifyResumeResponse({ status: 206, contentRange: "bytes 40-99/100", from: 40, prevIdentity: null, dai: true });
  assert.equal(unproven.restart, true);
  assert.match(unproven.reason, /DAI/);
  const proven = verifyResumeResponse({ status: 206, contentRange: "bytes 40-99/100", etag: '"same"', from: 40, prevIdentity: '"same"', dai: true });
  assert.equal(proven.ok, true, "a proven identity is still allowed to resume");
});

test("an unexpected status is refused without a pointless restart", () => {
  const v = verifyResumeResponse({ status: 302, contentRange: null, from: 40 });
  assert.deepEqual([v.ok, v.restart], [false, false]);
});

/* --------------------------------------------------------------- backoff */

test("only transient statuses are retried", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(shouldRetryStatus(s), true, String(s));
  for (const s of [200, 206, 301, 400, 401, 403, 404, 410, 451]) assert.equal(shouldRetryStatus(s), false, String(s));
});

test("Retry-After is honoured in both of its legal forms", () => {
  const now = Date.parse("2026-08-11T00:00:00Z");
  assert.equal(parseRetryAfter("30", now), 30_000);
  assert.equal(parseRetryAfter("Tue, 11 Aug 2026 00:00:45 GMT", now), 45_000);
  assert.equal(parseRetryAfter("Tue, 10 Aug 2026 00:00:00 GMT", now), 0, "a past date means retry now, not negative");
  for (const junk of [null, undefined, "soon"]) assert.equal(parseRetryAfter(junk, now), null);
});

test("a 429 with Retry-After waits exactly that long, capped", () => {
  assert.equal(backoffDelayMs(1, { status: 429, retryAfter: "30" }), 30_000);
  assert.equal(backoffDelayMs(1, { status: 429, retryAfter: "99999" }), 120_000, "capped so a hostile header cannot hang the run");
});

test("backoff grows exponentially and is jittered", () => {
  const flat = { status: 503, rand: () => 0 };
  assert.equal(backoffDelayMs(1, flat), 1000);
  assert.equal(backoffDelayMs(2, flat), 2000);
  assert.equal(backoffDelayMs(3, flat), 4000);
  assert.equal(backoffDelayMs(4, flat), 8000);
  assert.equal(backoffDelayMs(1, { status: 503, rand: () => 1 }), 1300, "jitter spreads retries so a fleet does not resynchronise");
});

test("backoff returns null rather than retrying forever", () => {
  assert.equal(backoffDelayMs(5, { status: 503 }), null, "attempt budget exhausted");
  assert.equal(backoffDelayMs(1, { status: 404 }), null, "a 404 is an answer, not a hiccup");
  assert.equal(backoffDelayMs(1, { status: 403 }), null);
});

/* ------------------------------------------------------------- host gate */

test("concurrency is capped PER HOST", async () => {
  // Per-host, not per-feed: one CDN fronts hundreds of feeds, so a per-feed
  // budget would let us open 40 sockets on one origin (corner case #8).
  const gate = new HostGate({ perHost: 2, minGapMs: 0 });
  let live = 0, peak = 0;
  const job = () => gate.run("cdn.example.com", async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 15));
    live--;
  });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.equal(live, 0);
});

test("different hosts do not queue behind each other", async () => {
  const gate = new HostGate({ perHost: 1, minGapMs: 0 });
  let live = 0, peak = 0;
  const job = (h) => gate.run(h, async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 15));
    live--;
  });
  await Promise.all([job("a.com"), job("b.com"), job("c.com")]);
  assert.equal(peak, 3);
});

test("a minimum gap between starts stops a queued run arriving as a burst", async () => {
  const gate = new HostGate({ perHost: 1, minGapMs: 30 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => gate.run("cdn.example.com", async () => {})));
  assert.ok(Date.now() - t0 >= 55, `three requests took ${Date.now() - t0}ms, expected >= ~60ms of spacing`);
});

test("a throwing job still releases its slot", async () => {
  const gate = new HostGate({ perHost: 1, minGapMs: 0 });
  await assert.rejects(() => gate.run("h", async () => { throw new Error("boom"); }));
  assert.equal(await gate.run("h", async () => "ok"), "ok");
});

/* ------------------------------------------------------------ checkpoint */

test("mergeCheckpoint creates, patches and accumulates attempts", () => {
  let ck = mergeCheckpoint(null, "a", { status: "partial", bytes_done: 10 });
  assert.equal(ck.episodes.a.status, "partial");
  assert.equal(ck.version, 1);
  ck = mergeCheckpoint(ck, "a", { bytes_done: 20, bump_attempt: true });
  assert.equal(ck.episodes.a.status, "partial", "unmentioned fields survive");
  assert.equal(ck.episodes.a.bytes_done, 20);
  assert.equal(ck.episodes.a.attempts, 1);
  ck = mergeCheckpoint(ck, "a", { bump_attempt: true });
  assert.equal(ck.episodes.a.attempts, 2);
  assert.ok(!("bump_attempt" in ck.episodes.a));
  ck = mergeCheckpoint(ck, "b", { status: "complete" });
  assert.deepEqual(Object.keys(ck.episodes).sort(), ["a", "b"]);
});

test("the high-water mark in the checkpoint only ever grows", () => {
  let ck = mergeCheckpoint(null, "a", { high_water_bytes: 500 });
  ck = mergeCheckpoint(ck, "b", { high_water_bytes: 100 });
  assert.equal(ck.high_water_bytes, 500);
  ck = mergeCheckpoint(ck, "c", { high_water_bytes: 900 });
  assert.equal(ck.high_water_bytes, 900);
});

test("a killed run resumes from the checkpoint rather than from zero", async () => {
  await withTempDir(async (dir) => {
    const cp = join(dir, "checkpoint.json");
    await saveCheckpoint(mergeCheckpoint(null, "a", { status: "partial", bytes_expected: 1000, identity: '"v1"' }), cp);

    const reloaded = await loadCheckpoint(cp);          // <- the "new process"
    const entry = reloaded.episodes.a;
    assert.equal(entry.bytes_expected, 1000);
    const plan = resumePlan({ partialBytes: 400, expectedBytes: entry.bytes_expected });
    assert.deepEqual([plan.action, plan.header], ["resume", "bytes=400-"]);
    assert.equal(verifyResumeResponse({ status: 206, contentRange: "bytes 400-999/1000", etag: '"v1"', from: 400, prevIdentity: entry.identity }).ok, true);
  });
});

test("parallel downloads do not clobber each other's checkpoint entries", async () => {
  // Found by running the tool for real against two libsyn episodes: each held a
  // checkpoint snapshot taken at its start, so the one that finished last wrote
  // its stale copy over the other's entry and the file recorded one of two
  // completed downloads. A resume would then have re-fetched audio already on
  // disk — the impoliteness the checkpoint exists to prevent.
  await withTempDir(async (dir) => {
    const cp = join(dir, "checkpoint.json");
    const ids = Array.from({ length: 12 }, (_, i) => `ep${i}`);
    await Promise.all(ids.map((id, i) => updateCheckpoint(id, { status: "complete", bytes_done: i, high_water_bytes: i }, cp)));
    const ck = await loadCheckpoint(cp);
    assert.deepEqual(Object.keys(ck.episodes).sort(), [...ids].sort());
    assert.equal(ck.episodes.ep7.bytes_done, 7);
    assert.equal(ck.high_water_bytes, 11);
  });
});

test("a missing checkpoint is an empty one, and a corrupt one does not kill the run", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual((await loadCheckpoint(join(dir, "nope.json"))).episodes, {});
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json");
    assert.deepEqual((await loadCheckpoint(bad)).episodes, {});
  });
});

/* --------------------------------------------------------------- cleanup */

test("cleanup deletes the audio and both of its forms", async () => {
  await withTempDir(async (dir) => {
    const cp = join(dir, "checkpoint.json");
    const url = "https://cdn.example.com/a.mp3";
    const final = targetPath("ep1", url, dir);
    await writeFile(final, Buffer.alloc(2048));
    await writeFile(partPathFor(final), Buffer.alloc(1024));
    await saveCheckpoint(mergeCheckpoint(null, "ep1", { status: "complete", path: final, url }), cp);

    const r = await cleanup("ep1", { dir, checkpointPath: cp, url });
    assert.equal(r.removed.length, 2);
    assert.equal(r.freedBytes, 3072);
    assert.equal(existsSync(final), false);
    assert.equal(existsSync(partPathFor(final)), false);
    assert.equal((await loadCheckpoint(cp)).episodes.ep1.status, "discarded");
  });
});

test("cleanup is idempotent — a finally block can call it unconditionally", async () => {
  await withTempDir(async (dir) => {
    const cp = join(dir, "checkpoint.json");
    const url = "https://cdn.example.com/a.mp3";
    await writeFile(targetPath("ep1", url, dir), Buffer.alloc(10));
    assert.equal((await cleanup("ep1", { dir, checkpointPath: cp, url })).removed.length, 1);
    assert.equal((await cleanup("ep1", { dir, checkpointPath: cp, url })).removed.length, 0);
    assert.equal((await cleanup("never-fetched", { dir, checkpointPath: cp, url })).freedBytes, 0);
  });
});

/* ------------------------------------------------- failures are never silent */

test("an unusable enclosure URL throws before any network call", async () => {
  await assert.rejects(() => fetchEpisode({ id: "e", audio_url: "not-a-url" }), (e) => {
    assert.ok(e instanceof UnusableUrlError);
    assert.equal(e.code, "UNUSABLE_URL");
    return true;
  });
});

test("every error type carries a machine-readable code", () => {
  for (const e of [
    new SelectionError("x"), new DiskGuardError("x"), new DiskBudgetError("x"),
    new UnusableUrlError("x"), new FetchAudioError("CUSTOM", "x"),
  ]) {
    assert.ok(e instanceof FetchAudioError);
    assert.ok(e.code && e.code === e.code.toUpperCase(), `${e.name} has no usable code`);
    assert.ok(e.message.length > 0);
  }
});

/* ------------------------------------------------ never commit audio (hard) */

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const isRepo = (() => { try { git(["rev-parse", "--git-dir"]); return true; } catch (_) { return false; } })();

test("the download dir is gitignored", { skip: !isRepo && "not a git checkout" }, () => {
  const dirName = basename(DOWNLOAD_DIR);
  const ignore = execFileSync("git", ["check-ignore", "-v", `${dirName}/anything.mp3`], { cwd: ROOT, encoding: "utf8" });
  assert.match(ignore, /\.gitignore/);
});

test("NOTHING under the download dir is git-tracked", { skip: !isRepo && "not a git checkout" }, () => {
  // 170 MB of mp3 in a repo is unrecoverable without a history rewrite, so this
  // assertion is cheap insurance against one careless `git add -A`.
  const dirName = basename(DOWNLOAD_DIR);
  const tracked = git(["ls-files", "--", dirName]);
  assert.equal(tracked, "", `these files must never be committed:\n${tracked}`);
  const anyAudio = git(["ls-files", "--", "*.mp3", "*.m4a", "*.wav", "*.flac", "*.opus"]);
  assert.equal(anyAudio, "", `audio committed to the repo:\n${anyAudio}`);
});

test("a real file inside the download dir stays invisible to git", { skip: !isRepo && "not a git checkout" }, async () => {
  // Proves the ignore rule against an actual file rather than a hypothetical
  // path — `git check-ignore` and `git status` have disagreed before.
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const probe = join(DOWNLOAD_DIR, "gitignore-probe.mp3");
  try {
    await writeFile(probe, Buffer.alloc(64));
    assert.equal(git(["status", "--porcelain", "--", basename(DOWNLOAD_DIR)]), "");
    assert.ok((await stat(probe)).size === 64);
  } finally {
    await rm(probe, { force: true });
  }
});

test("the module documents that this is not an archive", async () => {
  const src = await readFile(new URL("./fetch-audio.mjs", import.meta.url), "utf8");
  assert.match(src, /NOT AN ARCHIVE/i);
  assert.match(src, /export async function cleanup/);
});
