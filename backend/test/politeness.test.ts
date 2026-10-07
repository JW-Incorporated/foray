import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { PolitenessBudget, hostSuggestsDai } from "../src/feeds/politeness";

/* The one DAI host list (CH2-26, B1-03): tools/refresh/dai-hosts.json is what
   tools/refresh/dai.mjs classifies the catalogue with, so it is what this
   module must agree with. Read here independently of the module under test. */
const DAI_HOSTS_JSON = path.resolve(__dirname, "..", "..", "tools", "refresh", "dai-hosts.json");
const daiHosts: string[] = (
  JSON.parse(fs.readFileSync(DAI_HOSTS_JSON, "utf8")) as { hosts: Array<{ host: string }> }
).hosts.map((h) => h.host);

describe("PolitenessBudget", () => {
  it("allows the first request to a host immediately", () => {
    const budget = new PolitenessBudget();
    expect(budget.msUntilAllowed("example.com", 1000)).toBe(0);
  });

  it("enforces the minimum interval between requests to the same host", () => {
    const budget = new PolitenessBudget({ minIntervalMs: 5000 });
    budget.recordRequestStart("example.com", 1000);
    expect(budget.msUntilAllowed("example.com", 2000)).toBe(4000);
    expect(budget.msUntilAllowed("example.com", 6000)).toBe(0);
  });

  it("budgets are per-host, not per-feed (corner case 8)", () => {
    const budget = new PolitenessBudget({ minIntervalMs: 5000 });
    budget.recordRequestStart("shared-host.com", 1000);
    // a different feed on the SAME host is still budget-limited
    expect(budget.msUntilAllowed("shared-host.com", 2000)).toBeGreaterThan(0);
    // a different host entirely is unaffected
    expect(budget.msUntilAllowed("other-host.com", 2000)).toBe(0);
  });

  it("applies exponential backoff after failures", () => {
    const budget = new PolitenessBudget({ backoffBaseMs: 1000, backoffMaxMs: 60_000 });
    const b1 = budget.recordFailure("flaky.com", 0);
    const b2 = budget.recordFailure("flaky.com", 0);
    const b3 = budget.recordFailure("flaky.com", 0);
    expect(b1).toBe(1000);
    expect(b2).toBe(2000);
    expect(b3).toBe(4000);
  });

  it("caps backoff at backoffMaxMs", () => {
    const budget = new PolitenessBudget({ backoffBaseMs: 1000, backoffMaxMs: 5000 });
    for (let i = 0; i < 10; i++) budget.recordFailure("flaky.com", 0);
    expect(budget.recordFailure("flaky.com", 0)).toBe(5000);
  });

  it("recordSuccess resets consecutive failure count and any block", () => {
    const budget = new PolitenessBudget({ backoffBaseMs: 1000 });
    budget.recordFailure("host.com", 0);
    budget.recordFailure("host.com", 0);
    expect(budget.consecutiveFailuresFor("host.com")).toBe(2);
    budget.recordSuccess("host.com");
    expect(budget.consecutiveFailuresFor("host.com")).toBe(0);
    expect(budget.msUntilAllowed("host.com", 0)).toBe(0);
  });

  it("hostOf extracts hostname from a URL, falling back to the raw string on invalid URLs", () => {
    expect(PolitenessBudget.hostOf("https://example.com/feed.xml")).toBe("example.com");
    expect(PolitenessBudget.hostOf("not a url")).toBe("not a url");
  });
});

describe("hostSuggestsDai", () => {
  it("flags known DAI hosts (Megaphone, Acast, Art19)", () => {
    expect(hostSuggestsDai("https://feeds.megaphone.fm/catalyst")).toBe(true);
    expect(hostSuggestsDai("https://sphinx.acast.com/show/feed")).toBe(true);
    expect(hostSuggestsDai("https://rss.art19.com/show")).toBe(true);
  });

  it("does not flag unrelated hosts", () => {
    expect(hostSuggestsDai("https://lexfridman.com/feed/podcast/")).toBe(false);
  });

  // MUTATION: a literal host set back in politeness.ts (the old 6-host
  // KNOWN_DAI_HOSTS) -> red: omny.fm is on dai-hosts.json and was not on it.
  it("flags omny.fm, which tools/refresh/dai.mjs classifies DAI (B1-03)", () => {
    expect(hostSuggestsDai("https://traffic.omny.fm/d/clips/abc/audio.mp3")).toBe(true);
    expect(hostSuggestsDai("https://omny.fm/shows/x/feed")).toBe(true);
  });

  // MUTATION: any literal host set that drifts from dai-hosts.json (a host
  // added to the JSON and not the copy) -> red, naming the missing host.
  it("flags every host in tools/refresh/dai-hosts.json and its subdomains", () => {
    expect(daiHosts.length).toBeGreaterThan(6);
    for (const host of daiHosts) {
      expect(hostSuggestsDai(`https://${host}/feed`), host).toBe(true);
      expect(hostSuggestsDai(`https://cdn.${host}/a.mp3`), `cdn.${host}`).toBe(true);
    }
  });

  // MUTATION: `host.endsWith(known)` without the dot -> red.
  it("suffix match refuses a lookalike host (notmegaphone.fm)", () => {
    expect(hostSuggestsDai("https://notmegaphone.fm/feed")).toBe(false);
    expect(hostSuggestsDai("https://megaphone.fm.example.com/feed")).toBe(false);
  });
});
