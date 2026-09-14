import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  corpusCoverage,
  corpusCoverageLine,
  corpusSafeKey,
  isLetterSpacedCue,
  LETTER_SPACED_MIN_TOKENS,
  scanNormalizedCorpus
} from "../src/generation/transcriptCorpus";
import { FileTranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * Issue #703 — the two rules that decide what of the corpus on disk is
 * readable, and the count that makes a gap impossible to miss.
 *
 * KILLING MUTATIONS THIS SUITE CATCHES, one per case below:
 *
 *  1. `corpusSafeKey` truncating the slug at any length but SIXTY, or dropping
 *     its sha1 suffix. That is the exact defect #703 hid: the fetcher wrote
 *     `slug(60)-sha1(10)` and the reader asked for `slug(80)`, so 0 of Becker's
 *     Healthcare's 990 bodies resolved and 990 medical episodes were dark on a
 *     germ-theory Foray.
 *  2. `isLetterSpacedCue` returning false for the `sigma-nutrition-radio` #595
 *     cover page — the cue that was indexed, ranked second under "Medicine" and
 *     quoted into the spine prompt as tape.
 *  3. `isLetterSpacedCue` returning TRUE for ordinary English dense in "I" and
 *     "a". Drop `REAL_ONE_LETTER_WORDS` and "I think I built. I built a thing.
 *     I don't" is exactly 50 % single-character tokens — real speech, refused.
 *  4. The minimum-token floor going away, which makes every four-word cue a
 *     coin toss.
 *  5. `corpusCoverage` counting a show as searchable when nothing in the
 *     archive names it, or when none of its rows resolves to a body. Those are
 *     the two mechanisms behind #703's 4,318 dark episodes, and a coverage
 *     report that cannot tell them apart cannot tell a reader what to fix.
 *  6. `corpusCoverageLine` staying quiet about a blind spot — the whole of
 *     #703's second ask is that a run SAYS it drew on 14 of 22 shows.
 */
describe("corpusSafeKey mirrors the name the fetcher actually wrote", () => {
  /** The rule as `tools/segments/fetch-transcripts.mjs` states it, restated
   * here so the test is an independent witness rather than a copy of the
   * implementation. */
  function fetcherSafeKey(guid: string): string {
    const slug = guid
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const hash = crypto.createHash("sha1").update(guid).digest("hex").slice(0, 10);
    return slug ? `${slug}-${hash}` : hash;
  }

  it("agrees with the fetcher on a permalink guid whose slug runs past sixty characters", () => {
    const guid = "https://blubrry.com/beckershealthcarepodcast/151213357/david-dunkle-ceo-johnson-memorial-health/";
    expect(corpusSafeKey(guid)).toBe(fetcherSafeKey(guid));
    /* The half that mattered: the slug STOPS at sixty. An 80-character prefix
       is longer than the whole name on disk, which is why `startsWith` could
       never match it. */
    expect(corpusSafeKey(guid)).toBe("https-blubrry-com-beckershealthcarepodcast-151213357-david-d-fab325fdba");
    expect(corpusSafeKey(guid).length).toBeLessThan(`${guid.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.length);
  });

  it("agrees with the fetcher on a short uuid guid, where the two truncations were always the same", () => {
    const guid = "000653d4-6ed0-4fd8-8a4c-b308014cb900";
    expect(corpusSafeKey(guid)).toBe(fetcherSafeKey(guid));
    expect(corpusSafeKey(guid)).toBe("000653d4-6ed0-4fd8-8a4c-b308014cb900-0b7bd255a8");
  });

  it("keeps two guids apart when their first sixty characters agree", () => {
    const a = "https://blubrry.com/beckershealthcarepodcast/151213357/david-dunkle-part-one/";
    const b = "https://blubrry.com/beckershealthcarepodcast/151213357/david-dunkle-part-two/";
    expect(corpusSafeKey(a)).not.toBe(corpusSafeKey(b));
  });

  it("still produces a usable key for a guid with no alphanumerics at all", () => {
    expect(corpusSafeKey("///")).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("isLetterSpacedCue separates a spelled-out page from speech", () => {
  it("refuses the sigma-nutrition-radio #595 cover page", () => {
    expect(isLetterSpacedCue("Sigm a Nutrition Prem ium T r a n s c r i p t - E p i s o d e # 5 9 5 N e u r o p l")).toBe(true);
  });

  it("keeps ordinary English that happens to be half single-letter words", () => {
    /* Five of ten tokens are "I" or "a". A rule that counts those is a rule
       that deletes conversation. */
    expect(isLetterSpacedCue("I think I built. I built a thing. I don't")).toBe(false);
  });

  it("keeps a normal sentence", () => {
    expect(isLetterSpacedCue("Semmelweis asked the doctors on his ward to wash their hands in chlorinated lime.")).toBe(false);
  });

  it("judges nothing shorter than the token floor", () => {
    const short = "T E M P R.";
    expect(short.split(/\s+/).length).toBeLessThan(LETTER_SPACED_MIN_TOKENS);
    expect(isLetterSpacedCue(short)).toBe(false);
  });

  it("is not fooled by punctuation padding the denominator", () => {
    expect(isLetterSpacedCue("G - L - A - I - S - T - E - R - , - .")).toBe(true);
  });

  it("treats empty and whitespace text as speech, not junk", () => {
    expect(isLetterSpacedCue("")).toBe(false);
    expect(isLetterSpacedCue("   ")).toBe(false);
  });
});

describe("corpusCoverage counts the corpus on disk, not the digest that was meant to describe it", () => {
  function fixture(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-corpus-"));
    const write = (dir: string, files: number) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      for (let i = 0; i < files; i += 1) fs.writeFileSync(path.join(root, dir, `e${i}.json`), "{}", "utf8");
    };
    write("indexed-show-aaaaaaaaaa", 3);
    write("no-digest-row-bbbbbbbbbb", 7);
    write("no-body-cccccccccc", 5);
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it("names the show with no digest row and the show whose rows resolve to nothing, and distinguishes them", () => {
    const { root, cleanup } = fixture();
    try {
      const coverage = corpusCoverage({
        archive: [
          { show_id: "indexed-show" },
          { show_id: "indexed-show" },
          { show_id: "indexed-show" },
          { show_id: "no-body" },
          { show_id: "no-body" }
        ],
        hasBody: (entry) => entry.show_id === "indexed-show",
        normalizedRoot: root
      });
      expect(coverage.showsOnDisk).toBe(3);
      expect(coverage.episodesOnDisk).toBe(15);
      expect(coverage.showsSearchable).toBe(1);
      expect(coverage.episodesSearchable).toBe(3);
      expect(coverage.blindSpots).toEqual([
        { showId: "no-digest-row", episodes: 7, reason: "no-digest-row" },
        { showId: "no-body", episodes: 5, reason: "no-body-resolved" }
      ]);
    } finally {
      cleanup();
    }
  });

  it("says so plainly when nothing is missing, so the healthy line is the one that changes", () => {
    const { root, cleanup } = fixture();
    try {
      const coverage = corpusCoverage({
        archive: [{ show_id: "indexed-show" }, { show_id: "no-digest-row" }, { show_id: "no-body" }],
        hasBody: () => true,
        normalizedRoot: root
      });
      expect(coverage.blindSpots).toEqual([]);
      expect(corpusCoverageLine(coverage)).toContain("3 of 3 shows searchable");
      expect(corpusCoverageLine(coverage)).toContain("the whole corpus");
    } finally {
      cleanup();
    }
  });

  it("puts every unsearchable show's NAME on the line, biggest first", () => {
    const { root, cleanup } = fixture();
    try {
      const line = corpusCoverageLine(
        corpusCoverage({ archive: [{ show_id: "indexed-show" }], hasBody: () => true, normalizedRoot: root })
      );
      expect(line).toContain("NOT SEARCHABLE");
      expect(line.indexOf("no-digest-row")).toBeLessThan(line.indexOf("no-body"));
      expect(line).toContain("warm-transcript-index.mjs");
    } finally {
      cleanup();
    }
  });

  it("reports an empty corpus rather than throwing, on a machine with no data-local", () => {
    const coverage = corpusCoverage({
      archive: [{ show_id: "anything" }],
      hasBody: () => true,
      normalizedRoot: path.join(os.tmpdir(), "foray-corpus-does-not-exist")
    });
    expect(coverage).toEqual({ showsOnDisk: 0, episodesOnDisk: 0, showsSearchable: 0, episodesSearchable: 0, blindSpots: [] });
  });
});

describe("scanNormalizedCorpus recovers the show id a digest row uses", () => {
  it("strips the safeKey hash suffix the directory carries and nothing else", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-scan-"));
    try {
      fs.mkdirSync(path.join(root, "this-podcast-will-kill-you-6eb31515b0"));
      fs.writeFileSync(path.join(root, "this-podcast-will-kill-you-6eb31515b0", "a.json"), "{}", "utf8");
      /* A show id that ENDS in something hex-looking but is not ten characters
         must survive intact, or a real show quietly loses its rows. */
      fs.mkdirSync(path.join(root, "1452376188-3d12a20e19"));
      fs.writeFileSync(path.join(root, "1452376188-3d12a20e19", "a.json"), "{}", "utf8");
      fs.mkdirSync(path.join(root, "empty-show-1234567890"));
      const scanned = scanNormalizedCorpus(root).map((s) => s.showId).sort();
      expect(scanned).toEqual(["1452376188", "this-podcast-will-kill-you"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FileTranscriptCueProvider reads the bodies the fetcher actually wrote", () => {
  function corpus(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-bodies-"));
    fs.mkdirSync(path.join(root, "beckers-3d12a20e19"));
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  function writeBody(root: string, guid: string, cues: Array<{ text: string; start_sec: number; end_sec: number }>): void {
    const file = path.join(root, "beckers-3d12a20e19", `${corpusSafeKey(guid)}.json`);
    fs.writeFileSync(file, JSON.stringify({ show_id: "beckers", guid, cues }), "utf8");
  }

  const row = (guid: string): TranscriptDigestEntry => ({
    show_id: "beckers",
    show_title: "Becker's Healthcare Podcast",
    guid,
    title: "An episode",
    cues: 2
  });

  /* MUTATION THAT KILLS THIS: put `locate`'s first lookup back on the 80-char
     prefix (`guidSlug`). This is #703's 990 dark episodes in one assertion: a
     permalink guid's 80-character prefix is LONGER than the whole name the
     fetcher wrote, so `startsWith` can never match and the body is invisible. */
  it("finds a body whose guid slug runs past sixty characters", () => {
    const { root, cleanup } = corpus();
    try {
      const guid = "https://blubrry.com/beckershealthcarepodcast/151213357/david-dunkle-ceo-johnson-memorial-health/";
      writeBody(root, guid, [{ text: "hospital margins are the story of the decade", start_sec: 0, end_sec: 10 }]);
      const provider = new FileTranscriptCueProvider(root);
      expect(provider.bodyStat(row(guid))).not.toBeNull();
      expect(provider.getCues(row(guid))?.[0]?.text).toContain("hospital margins");
    } finally {
      cleanup();
    }
  });

  it("still finds a body whose guid is short, where nothing was ever broken", () => {
    const { root, cleanup } = corpus();
    try {
      const guid = "000653d4-6ed0-4fd8-8a4c-b308014cb900";
      writeBody(root, guid, [{ text: "short guids always resolved and must keep resolving", start_sec: 0, end_sec: 10 }]);
      expect(new FileTranscriptCueProvider(root).getCues(row(guid))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  /* MUTATION THAT KILLS THIS: delete the `isLetterSpacedCue` guard in
     `readCues`. Then `sigma-nutrition-radio` #595's PDF cover page is a cue
     again, and it is the cue that ranked second under "Medicine" on the
     germ-theory map and was quoted into the spine prompt as tape. */
  it("drops a letter-spaced cue and keeps the speech around it", () => {
    const { root, cleanup } = corpus();
    try {
      const guid = "sigma-595";
      writeBody(root, guid, [
        { text: "Sigm a Nutrition Prem ium T r a n s c r i p t - E p i s o d e # 5 9 5", start_sec: 0, end_sec: 3 },
        { text: "Danny Lennon: A very big welcome to the podcast to Dr. Majid Fotuhi.", start_sec: 3, end_sec: 12 }
      ]);
      const cues = new FileTranscriptCueProvider(root).getCues(row(guid));
      expect(cues).toHaveLength(1);
      expect(cues?.[0]?.text).toContain("Danny Lennon");
    } finally {
      cleanup();
    }
  });

  /* MUTATION THAT KILLS THIS: reject the whole EPISODE on a letter-spaced cue
     instead of the cue. Measured over this corpus that refuses 506 of 5,037
     episodes to remove 0.0219 % of its cues — and it would still not refuse
     #595, whose bad cues are 3 of 1,065. */
  it("keeps a cue that spells one name inside a real sentence", () => {
    const { root, cleanup } = corpus();
    try {
      const guid = "around-the-house-1";
      writeBody(root, guid, [
        { text: "Wendy Glaister Interiors, and the name is spelled G L A I S T E R, plural.", start_sec: 0, end_sec: 8 },
        { text: "So what we did in that kitchen was pull the whole island forward by a foot.", start_sec: 8, end_sec: 18 }
      ]);
      const cues = new FileTranscriptCueProvider(root).getCues(row(guid));
      /* Both survive. Measured: the spelled name is six lone letters in a
         seventeen-token sentence (0.35), well under the ratio — so the rule is
         even narrower than the corpus scan suggested, and an episode is never
         the unit it refuses. */
      expect(cues).toHaveLength(2);
      expect(cues?.[1]?.text).toContain("pull the whole island");
    } finally {
      cleanup();
    }
  });

  /* MUTATION THAT KILLS THIS: return an empty array instead of null when every
     cue is refused. `sourceBeats` reads null as "no body on this machine" and
     an empty array as a body it can cut from, and the difference decides
     whether a beat falls back to narration or mints an empty clip. */
  it("reports a body whose every cue is junk as no body at all", () => {
    const { root, cleanup } = corpus();
    try {
      const guid = "all-junk";
      writeBody(root, guid, [{ text: "T r a n s c r i p t o f t h e w h o l e t h i n g", start_sec: 0, end_sec: 8 }]);
      expect(new FileTranscriptCueProvider(root).getCues(row(guid))).toBeNull();
    } finally {
      cleanup();
    }
  });
});
