/* Per-host politeness budget for the S-10 watchlist poller
   (tools/poll/politeness.mjs, PKG-06).
   Run:
   node --test tools/poll/politeness.test.mjs

   Every test names the one-line mutation that turns it red; each was applied to
   politeness.mjs, confirmed changed on disk, and seen to fail this suite. The
   first test is a cross-file pin: it reads backend/src/feeds/politeness.ts as
   TEXT (the TS DEFAULT_CONFIG is not exported, and this suite runs without a TS
   loader), so a constant changed on either side alone is a red suite. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_CONFIG, PolitenessBudget } from "./politeness.mjs";

const TS_PATH = new URL("../../backend/src/feeds/politeness.ts", import.meta.url);
const NOW = Date.UTC(2026, 9, 1); // fixed so no test reads the clock
const num = (s) => Number(s.replace(/_/g, ""));

test("the port's constants equal backend/src/feeds/politeness.ts's DEFAULT_CONFIG", () => {
  // MUTATION: `backoffMaxMs: 900000` -> `900001` in politeness.mjs -> red.
  const src = fs.readFileSync(TS_PATH, "utf8");
  const start = src.indexOf("const DEFAULT_CONFIG");
  assert.ok(start >= 0, "backend/src/feeds/politeness.ts no longer declares `const DEFAULT_CONFIG` -- escalate, do not loosen");
  const block = src.slice(start, src.indexOf("};", start));
  const min = block.match(/minIntervalMs:\s*([\d_]+)/);
  const base = block.match(/backoffBaseMs:\s*([\d_]+)/);
  const maxProduct = block.match(/backoffMaxMs:\s*([\d_]+)\s*\*\s*([\d_]+)/);
  const maxSingle = block.match(/backoffMaxMs:\s*([\d_]+)/);
  assert.ok(min && base && (maxProduct || maxSingle), "the TS DEFAULT_CONFIG literal no longer matches the pinned shapes -- escalate, do not loosen");
  const tsConfig = {
    minIntervalMs: num(min[1]),
    backoffBaseMs: num(base[1]),
    backoffMaxMs: maxProduct ? num(maxProduct[1]) * num(maxProduct[2]) : num(maxSingle[1]),
  };
  assert.deepEqual({ ...DEFAULT_CONFIG }, tsConfig);
  assert.deepEqual(tsConfig, { minIntervalMs: 2000, backoffBaseMs: 5000, backoffMaxMs: 900000 });
});

test("backoff doubles from base and caps at max", () => {
  // MUTATION: `backoffBaseMs * 2 ** (...)` -> `backoffBaseMs * 1 * (...)` -> red.
  const b = new PolitenessBudget();
  const host = "feeds.libsyn.com";
  const expected = [5000, 10000, 20000, 40000, 80000, 160000, 320000, 640000, 900000, 900000];
  for (let failures = 1; failures <= 10; failures++) {
    const backoff = b.recordFailure(host, NOW);
    assert.equal(backoff, expected[failures - 1], `failure ${failures}`);
    assert.equal(b.consecutiveFailuresFor(host), failures);
    assert.equal(b.msUntilAllowed(host, NOW), backoff, `blocked for exactly the backoff after failure ${failures}`);
  }
});

test("msUntilAllowed is the larger of spacing and block", () => {
  // MUTATION: `Math.max(0, blockedFor, spacedFor)` -> `Math.min(...)` -> red.
  const b = new PolitenessBudget();
  const host = "rss.art19.com";
  assert.equal(b.msUntilAllowed(host, NOW), 0, "a host never requested is allowed at once");
  b.recordRequestStart(host, NOW);
  assert.equal(b.msUntilAllowed(host, NOW + 500), 1500, "spacing alone: 2000 - 500");
  b.recordFailure(host, NOW); // blocked until NOW + 5000
  assert.equal(b.msUntilAllowed(host, NOW + 500), 4500, "block (4500) beats spacing (1500)");
  const c = new PolitenessBudget({ minIntervalMs: 60000 });
  c.recordRequestStart(host, NOW);
  c.recordFailure(host, NOW);
  assert.equal(c.msUntilAllowed(host, NOW + 1000), 59000, "spacing (59000) beats block (4000)");
  assert.equal(c.msUntilAllowed(host, NOW + 120000), 0, "never negative");
});

test("recordSuccess clears failures and the block; hostOf lowercases and passes a bad URL through", () => {
  // MUTATION: drop `s.blockedUntil = 0;` from recordSuccess -> red.
  const b = new PolitenessBudget();
  const host = PolitenessBudget.hostOf("https://Feeds.Megaphone.FM/abc?x=1");
  assert.equal(host, "feeds.megaphone.fm");
  assert.equal(PolitenessBudget.hostOf("not a url"), "not a url");
  b.recordFailure(host, NOW);
  b.recordFailure(host, NOW);
  b.recordSuccess(host);
  assert.equal(b.consecutiveFailuresFor(host), 0);
  assert.equal(b.msUntilAllowed(host, NOW), 0);
  assert.equal(b.recordFailure(host, NOW), 5000, "the next failure starts again from base");
});
