import { describe, it, expect, vi } from "vitest";

/* Round-3 audit, lane L6 (backend-rest-1): parseFeed's "never throws" contract
   holds even if a per-item helper throws. The duration normaliser is made to
   throw for one poisoned item; that item becomes a warning and the rest of
   the feed still parses. */
vi.mock("../src/feeds/duration", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/feeds/duration")>();
  return {
    ...real,
    normalizeDuration: (raw: string | null) => {
      if (raw === "POISON") throw new RangeError("simulated item failure");
      return real.normalizeDuration(raw);
    }
  };
});

import { parseFeed } from "../src/feeds/parser";

describe("parseFeed isolates a throwing item", () => {
  it("skips the bad item with a warning and keeps the others", () => {
    const xml = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>x</title>
      <item><title>Good one</title><guid>a</guid><itunes:duration>60</itunes:duration></item>
      <item><title>Poisoned</title><guid>b</guid><itunes:duration>POISON</itunes:duration></item>
      <item><title>Good two</title><guid>c</guid></item>
    </channel></rss>`;
    let feed: ReturnType<typeof parseFeed> | undefined;
    expect(() => {
      feed = parseFeed(xml);
    }).not.toThrow();
    expect(feed!.episodes.map((e) => e.guid)).toEqual(["a", "c"]);
    expect(feed!.warnings.some((w) => /item #1 skipped: simulated item failure/.test(w))).toBe(true);
  });
});
