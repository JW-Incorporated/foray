import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseFeed } from "../src/feeds/parser";

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures", "feeds");

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".xml"))
  .filter((f) => f !== "malicious-doctype-entity-bomb.xml") // adversarial, not a real feed — see its own describe block below
  .sort();

describe("parseFeed against real-world fixture corpus", () => {
  it("found the expected fixture files", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of fixtureFiles) {
    describe(file, () => {
      const xml = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8");
      const feed = parseFeed(xml);

      it("parses a non-empty feed title", () => {
        expect(feed.title.length).toBeGreaterThan(0);
      });

      it("parses at least one episode", () => {
        expect(feed.episodes.length).toBeGreaterThanOrEqual(1);
      });

      it("every episode has an enclosure URL (or a recorded warning explaining why not)", () => {
        for (const ep of feed.episodes) {
          if (!ep.enclosureUrl) {
            expect(ep.warnings.join(" ")).toMatch(/enclosure/i);
          } else {
            expect(ep.enclosureUrl.startsWith("http")).toBe(true);
          }
        }
      });

      it("every episode's duration is normalized to seconds, or null with a reason", () => {
        for (const ep of feed.episodes) {
          if (ep.duration.seconds === null) {
            expect(typeof ep.duration.reasonIfNull).toBe("string");
          } else {
            expect(ep.duration.seconds).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(ep.duration.seconds)).toBe(true);
          }
        }
      });

      it("sanitizes description HTML — no real markup tags survive", () => {
        // Checks for actual HTML tag names rather than "any <...>" — some
        // fixtures (omegatau.xml) have legitimate escaped citation text like
        // "Dissolution of the Soviet Union &lt;Dissolution of the Soviet
        // Union&gt;" that decodes to real angle brackets around plain words;
        // that's not markup, so a blanket bracket check produces false
        // positives on real content (see the dedicated cleantechies test
        // below for the actual HTML-in-CDATA case this guards against).
        const knownTagPattern = /<\/?(p|div|span|a|br|img|b|i|em|strong|ul|ol|li|h[1-6]|table|tr|td)\b[^>]*>/i;
        for (const ep of feed.episodes.slice(0, 20)) {
          expect(ep.descriptionText).not.toMatch(knownTagPattern);
        }
      });
    });
  }
});

describe("known real-world quirks captured in the fixture corpus", () => {
  it("lexfridman.xml: WordPress/PowerPress numeric entities (&#038;) in titles are decoded, not left literal", () => {
    const xml = fs.readFileSync(path.join(FIXTURES_DIR, "lexfridman.xml"), "utf-8");
    const feed = parseFeed(xml);
    const withAmpersand = feed.episodes.find((e) => e.title.includes("&"));
    expect(withAmpersand).toBeDefined();
    expect(withAmpersand!.title).not.toContain("&#038;");
    expect(withAmpersand!.title).not.toContain("&#38;");
  });

  it("lexfridman.xml: ~25 of 100 episodes have no itunes:duration at all (real, not a fixture artifact)", () => {
    const xml = fs.readFileSync(path.join(FIXTURES_DIR, "lexfridman.xml"), "utf-8");
    const feed = parseFeed(xml);
    const missing = feed.episodes.filter((e) => e.duration.reasonIfNull === "missing");
    // Documents corner case 5/6 concretely: duration absence is common
    // enough on a real, popular, actively-maintained feed that "missing
    // itunes:duration" must be a first-class, non-alarming outcome, not an
    // edge case the parser merely tolerates in theory.
    expect(missing.length).toBeGreaterThan(10);
  });

  it("omegatau.xml: itunes:duration of 00:00:00 on real long episodes resolves to a non-null (if garbage-looking) duration, not a crash", () => {
    const xml = fs.readFileSync(path.join(FIXTURES_DIR, "omegatau.xml"), "utf-8");
    const feed = parseFeed(xml);
    const zeroDurationEpisodes = feed.episodes.filter((e) => e.duration.raw === "00:00:00");
    // The point of this fixture: the parser must not throw and must
    // normalize "00:00:00" to 0 seconds (a legitimate, if useless, value) —
    // downstream code decides whether 0 is trustworthy, not the parser.
    expect(zeroDurationEpisodes.length).toBeGreaterThan(0);
    for (const ep of zeroDurationEpisodes) {
      expect(ep.duration.seconds).toBe(0);
    }
  });

  it("cleantechies.xml: HTML-in-CDATA show notes are stripped to text", () => {
    const xml = fs.readFileSync(path.join(FIXTURES_DIR, "cleantechies.xml"), "utf-8");
    const feed = parseFeed(xml);
    const withParagraphs = feed.episodes.find((e) => e.descriptionHtml?.includes("<p>"));
    expect(withParagraphs).toBeDefined();
    expect(withParagraphs!.descriptionText).not.toContain("<p>");
  });

  it("lexfridman.xml, catalyst.xml, conan.xml fixtures were truncated to ~100 items", () => {
    for (const file of ["lexfridman.xml", "catalyst.xml", "conan.xml"]) {
      const xml = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8");
      const feed = parseFeed(xml);
      expect(feed.episodes.length).toBeLessThanOrEqual(100);
      expect(feed.episodes.length).toBeGreaterThan(0);
    }
  });
});

/**
 * `<podcast:transcript>` has two consumers that want different formats:
 * Tier-1 enrichment wants prose (`transcriptUrl`, text/plain first), and
 * segment anchoring (ADR 0007) wants a timeline (`timedTranscriptUrl`).
 * The fixture corpus carries no transcript tags at all, so these cases are
 * built inline. Real feeds publish ~2.9 transcript tags per show, so the
 * multi-tag combinations below are the common case, not the exotic one.
 */
function feedWithTranscripts(tags: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Transcript Fixtures</title>
    <item>
      <title>Episode</title>
      <guid>ep-1</guid>
      <enclosure url="https://example.com/ep1.mp3" length="1000" type="audio/mpeg" />
${tags}
    </item>
  </channel>
</rss>`;
}

function firstEpisode(tags: string) {
  const feed = parseFeed(feedWithTranscripts(tags));
  expect(feed.episodes).toHaveLength(1);
  return feed.episodes[0]!;
}

const PLAIN = '      <podcast:transcript url="https://example.com/t.txt" type="text/plain" />';
const HTML = '      <podcast:transcript url="https://example.com/t.html" type="text/html" />';
const VTT = '      <podcast:transcript url="https://example.com/t.vtt" type="text/vtt" />';
const SRT = '      <podcast:transcript url="https://example.com/t.srt" type="application/srt" />';
const SUBRIP = '      <podcast:transcript url="https://example.com/t.subrip" type="application/x-subrip" />';
const JSON_T = '      <podcast:transcript url="https://example.com/t.json" type="application/json" />';

describe("transcript format preference", () => {
  describe("transcriptUrl (Tier-1 enrichment) — behaviour must be unchanged", () => {
    it("prefers text/plain over every timed format, however they are ordered", () => {
      expect(firstEpisode([VTT, SRT, PLAIN, JSON_T].join("\n")).transcriptUrl).toBe("https://example.com/t.txt");
      expect(firstEpisode([PLAIN, VTT].join("\n")).transcriptUrl).toBe("https://example.com/t.txt");
    });

    it("falls back to application/json when there is no text/plain", () => {
      expect(firstEpisode([VTT, SRT, JSON_T].join("\n")).transcriptUrl).toBe("https://example.com/t.json");
    });

    it("falls back to the first tag when neither text/plain nor application/json is offered", () => {
      expect(firstEpisode([SRT, VTT].join("\n")).transcriptUrl).toBe("https://example.com/t.srt");
      expect(firstEpisode(HTML).transcriptUrl).toBe("https://example.com/t.html");
    });

    it("is null when the episode publishes no transcript at all", () => {
      expect(firstEpisode("").transcriptUrl).toBeNull();
    });
  });

  describe("timedTranscriptUrl / timedTranscriptType (segment anchoring)", () => {
    it("only-plain: no timed transcript exists, so both fields are null", () => {
      const ep = firstEpisode(PLAIN);
      expect(ep.transcriptUrl).toBe("https://example.com/t.txt");
      expect(ep.timedTranscriptUrl).toBeNull();
      expect(ep.timedTranscriptType).toBeNull();
    });

    it("only-vtt: picks it, and enrichment falls back to the same tag", () => {
      const ep = firstEpisode(VTT);
      expect(ep.timedTranscriptUrl).toBe("https://example.com/t.vtt");
      expect(ep.timedTranscriptType).toBe("text/vtt");
      expect(ep.transcriptUrl).toBe("https://example.com/t.vtt");
    });

    it("both-plain-and-vtt: the two consumers diverge — this is the bug this field fixes", () => {
      const ep = firstEpisode([PLAIN, VTT].join("\n"));
      expect(ep.transcriptUrl).toBe("https://example.com/t.txt");
      expect(ep.timedTranscriptUrl).toBe("https://example.com/t.vtt");
      expect(ep.timedTranscriptType).toBe("text/vtt");
    });

    it("all four timed formats present: vtt wins, in the documented preference order", () => {
      // Deliberately published in reverse preference order — the pick must
      // follow the format ranking, not document order.
      const ep = firstEpisode([JSON_T, SUBRIP, SRT, VTT, PLAIN].join("\n"));
      expect(ep.timedTranscriptUrl).toBe("https://example.com/t.vtt");
      expect(ep.timedTranscriptType).toBe("text/vtt");
    });

    it("each timed format is recognized when it is the only timed option", () => {
      const cases: [string, string, string][] = [
        [VTT, "https://example.com/t.vtt", "text/vtt"],
        [SRT, "https://example.com/t.srt", "application/srt"],
        [SUBRIP, "https://example.com/t.subrip", "application/x-subrip"],
        [JSON_T, "https://example.com/t.json", "application/json"]
      ];
      for (const [tag, url, type] of cases) {
        const ep = firstEpisode([PLAIN, HTML, tag].join("\n"));
        expect(ep.timedTranscriptUrl).toBe(url);
        expect(ep.timedTranscriptType).toBe(type);
      }
    });

    it("preference order falls through: srt, then x-subrip, then json", () => {
      expect(firstEpisode([JSON_T, SUBRIP, SRT].join("\n")).timedTranscriptType).toBe("application/srt");
      expect(firstEpisode([JSON_T, SUBRIP].join("\n")).timedTranscriptType).toBe("application/x-subrip");
      expect(firstEpisode(JSON_T).timedTranscriptType).toBe("application/json");
    });

    it("none at all: an episode with no transcript tags reports null, not undefined", () => {
      const ep = firstEpisode("");
      expect(ep.timedTranscriptUrl).toBeNull();
      expect(ep.timedTranscriptType).toBeNull();
    });

    it("untimed-only: text/plain plus text/html still yields no timed transcript", () => {
      const ep = firstEpisode([PLAIN, HTML].join("\n"));
      expect(ep.timedTranscriptUrl).toBeNull();
      expect(ep.timedTranscriptType).toBeNull();
    });

    it("tolerates a missing type attribute — no throw, no false match", () => {
      const ep = firstEpisode('      <podcast:transcript url="https://example.com/t.unknown" />');
      expect(ep.transcriptUrl).toBe("https://example.com/t.unknown"); // first-tag fallback, unchanged
      expect(ep.timedTranscriptUrl).toBeNull();
      expect(ep.timedTranscriptType).toBeNull();
    });

    it("tolerates a malformed/garbage type attribute, and still finds a real one alongside it", () => {
      const ep = firstEpisode(
        [
          '      <podcast:transcript url="https://example.com/t.junk" type="" />',
          '      <podcast:transcript url="https://example.com/t.junk2" type="not a mime type" />',
          '      <podcast:transcript url="https://example.com/t.junk3" />',
          SRT
        ].join("\n")
      );
      expect(ep.timedTranscriptUrl).toBe("https://example.com/t.srt");
      expect(ep.timedTranscriptType).toBe("application/srt");
    });

    it("matches case-insensitively and ignores charset parameters, as real feeds emit them", () => {
      const ep = firstEpisode('      <podcast:transcript url="https://example.com/t.vtt" type="TEXT/VTT; charset=utf-8" />');
      expect(ep.timedTranscriptUrl).toBe("https://example.com/t.vtt");
      expect(ep.timedTranscriptType).toBe("text/vtt"); // normalized, not the raw attribute
    });

    it("a timed tag with no url is reported as absent rather than as a fetchable pair", () => {
      const ep = firstEpisode(['      <podcast:transcript type="text/vtt" />', PLAIN].join("\n"));
      expect(ep.timedTranscriptUrl).toBeNull();
      expect(ep.timedTranscriptType).toBeNull();
    });

  });

  it("transcriptUrl is unchanged for every subset and ordering of the six real-world formats", () => {
    // The regression guard for this change: replays the pre-change selection
    // rule (text/plain, then application/json, then first tag) over every
    // subset and permutation of the formats real feeds publish, and asserts
    // the parser still agrees with it exactly. 1,957 combinations.
    const all = [PLAIN, HTML, VTT, SRT, SUBRIP, JSON_T];
    const urlOf = (tag: string) => tag.match(/url="([^"]+)"/)![1];
    const typeOf = (tag: string) => tag.match(/type="([^"]+)"/)![1];
    const legacyPick = (tags: string[]) =>
      tags.find((t) => typeOf(t) === "text/plain") ??
      tags.find((t) => typeOf(t) === "application/json") ??
      tags[0] ??
      null;

    const permutations = (tags: string[]): string[][] => {
      if (tags.length <= 1) return [tags];
      return tags.flatMap((t, i) =>
        permutations([...tags.slice(0, i), ...tags.slice(i + 1)]).map((rest) => [t, ...rest])
      );
    };

    let checked = 0;
    for (let mask = 0; mask < 1 << all.length; mask++) {
      const subset = all.filter((_, i) => mask & (1 << i));
      for (const order of permutations(subset)) {
        const expected = legacyPick(order);
        expect(firstEpisode(order.join("\n")).transcriptUrl).toBe(expected === null ? null : urlOf(expected));
        checked++;
      }
    }
    expect(checked).toBe(1957);
  });

  it("every fixture-corpus episode exposes both transcript fields as string-or-null", () => {
    for (const file of fixtureFiles) {
      const feed = parseFeed(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8"));
      for (const ep of feed.episodes) {
        expect(ep.timedTranscriptUrl === null || typeof ep.timedTranscriptUrl === "string").toBe(true);
        expect(ep.timedTranscriptType === null || typeof ep.timedTranscriptType === "string").toBe(true);
        // A type is only ever reported alongside a url.
        if (ep.timedTranscriptType !== null) expect(ep.timedTranscriptUrl).not.toBeNull();
      }
    }
  });
});

describe("security regression: GHSA-8r6m-32jq-jx6q (fast-xml-parser DOCTYPE/entity-expansion DoS)", () => {
  // malicious-doctype-entity-bomb.xml carries THREE repeated <!DOCTYPE rss [...]>
  // blocks, each declaring a chain of nested entities (a classic "billion
  // laughs" shape). On the vulnerable fast-xml-parser versions (<5.10.1),
  // each repeated DOCTYPE block reset the library's internal entity-expansion
  // counter, so a feed could carry unlimited repeated DOCTYPE blocks to
  // bypass the expansion limit entirely and hang/crash the process. This
  // test asserts the fix: parsing a feed shaped like that completes fast and
  // never throws an uncaught error, regardless of how many DOCTYPE blocks
  // it repeats.
  const maliciousXml = fs.readFileSync(
    path.join(FIXTURES_DIR, "malicious-doctype-entity-bomb.xml"),
    "utf-8"
  );

  it("rejects the adversarial DOCTYPE-bomb fixture safely: no throw, empty feed, explicit warning", () => {
    // fast-xml-parser >=5.10.1 itself now rejects a document with multiple
    // <!DOCTYPE> declarations ("Multiple DOCTYPE declarations found") —
    // exactly the hardening that closes GHSA-8r6m-32jq-jx6q (repeated
    // DOCTYPE blocks used to reset the entity-expansion counter). parseFeed()
    // catches that as a fatal parse error and returns a safe, empty feed
    // instead of throwing or hanging — confirm that contract end to end.
    let feed: ReturnType<typeof parseFeed> | undefined;
    expect(() => {
      feed = parseFeed(maliciousXml);
    }).not.toThrow();
    expect(feed!.episodes).toEqual([]);
    expect(feed!.title).toBe("");
    expect(feed!.warnings.join(" ")).toMatch(/doctype|fatal parse error/i);
  });

  it("rejects the adversarial DOCTYPE-bomb fixture in well under a second (no unbounded entity expansion)", () => {
    const start = Date.now();
    parseFeed(maliciousXml);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("a feed with many repeated DOCTYPE blocks (simulating a worse attack) is also rejected quickly, not hung", () => {
    const repeatedDoctype = `<!DOCTYPE rss [
  <!ENTITY lol0 "lol">
  <!ENTITY lol1 "&lol0;&lol0;&lol0;&lol0;&lol0;&lol0;&lol0;&lol0;&lol0;&lol0;">
]>\n`.repeat(500);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n${repeatedDoctype}` +
      `<rss version="2.0"><channel><title>t</title>` +
      `<item><guid>g</guid><enclosure url="https://example.invalid/e.mp3" length="1" type="audio/mpeg" /></item>` +
      `</channel></rss>`;

    const start = Date.now();
    let feed: ReturnType<typeof parseFeed> | undefined;
    expect(() => {
      feed = parseFeed(xml);
    }).not.toThrow();
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
    expect(feed!.episodes).toEqual([]);
  });

  it("a well-formed feed with a single, ordinary DOCTYPE still parses normally (the fix doesn't break legitimate feeds)", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE rss [ <!ENTITY pub "Foray Test Publisher"> ]>\n` +
      `<rss version="2.0"><channel><title>Normal Feed by &pub;</title>` +
      `<item><guid>g1</guid><enclosure url="https://example.invalid/e1.mp3" length="1" type="audio/mpeg" /></item>` +
      `</channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.title).toContain("Normal Feed by");
    expect(feed.episodes.length).toBe(1);
  });
});

