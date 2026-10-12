import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  corpusCoverage,
  corpusCoverageLine,
  corpusFingerprint,
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
 *  7. GV-39: `corpusFingerprint` depending on archive order, ignoring a row's
 *     content digest, hashing rows whose body is not on disk, or giving an
 *     empty corpus anything but the stable sha256 of nothing. Named per case
 *     in the last describe block.
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

describe("GV-39 — corpusFingerprint freezes which corpus a run read", () => {
  /** sha256 of the empty string: the fingerprint of a corpus with no body. */
  const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const rows = [
    { show_id: "geology-bites", guid: "g-1", sha256: "a".repeat(64), bytes: 1200 },
    { show_id: "geology-bites", guid: "g-2", sha256: "b".repeat(64), bytes: 1300 },
    { show_id: "tpwky", guid: "t-1", sha256: "c".repeat(64), bytes: 900 },
    /* A machine-local corpus-digest row: no content digest, size only. */
    { show_id: "tpwky", guid: "t-2", bytes: 4096 }
  ];
  const all = () => true;

  /* MUTATION THAT KILLS THIS: drop `lines.sort()`. Archive order is whichever
     digest file named a row first, so an unsorted hash moves when the digests
     are merged differently and the corpus has not changed at all. */
  it("does not depend on archive order", () => {
    const forward = corpusFingerprint({ archive: rows, hasBody: all, indexVersion: 2 });
    const reversed = corpusFingerprint({ archive: [...rows].reverse(), hasBody: all, indexVersion: 2 });
    const shuffled = corpusFingerprint({ archive: [2, 0, 3, 1].map((i) => rows[i]!), hasBody: all, indexVersion: 2 });
    expect(reversed.sha256).toBe(forward.sha256);
    expect(shuffled.sha256).toBe(forward.sha256);
    expect(forward.rows).toBe(4);
    expect(forward.shows).toBe(2);
  });

  /* MUTATION THAT KILLS THIS: hash only `${show_id}\t${guid}`. A re-fetched
     transcript keeps its guid and changes its bytes, which is exactly the
     corpus change that must not pass for a pipeline change. */
  it("changes when one row's sha256 changes", () => {
    const before = corpusFingerprint({ archive: rows, hasBody: all, indexVersion: 2 });
    const edited = rows.map((r) => (r.guid === "g-2" ? { ...r, sha256: "d".repeat(64) } : r));
    expect(corpusFingerprint({ archive: edited, hasBody: all, indexVersion: 2 }).sha256).not.toBe(before.sha256);
  });

  /* MUTATION THAT KILLS THIS: hash '' instead of `bytes:<n>` for a row with no
     sha256. Such a row is weaker evidence, so it is counted, but it still has
     to move the hash when its size does. */
  it("hashes a row without a sha256 by its size, and counts it", () => {
    const before = corpusFingerprint({ archive: rows, hasBody: all, indexVersion: 2 });
    expect(before.rowsHashedBySize).toBe(1);
    const resized = rows.map((r) => (r.guid === "t-2" ? { ...r, bytes: 4097 } : r));
    expect(corpusFingerprint({ archive: resized, hasBody: all, indexVersion: 2 }).sha256).not.toBe(before.sha256);
  });

  /* MUTATION THAT KILLS THIS: hash every archive row whether or not its body
     resolves. The digest is unchanged when a body goes missing, and the corpus
     the run could read is not. Real bodies on a real cue provider, so the
     `hasBody` the CLI passes is the one under test. */
  it("changes when a body is removed from disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-fingerprint-"));
    try {
      const showDir = path.join(root, "beckers-3d12a20e19");
      fs.mkdirSync(showDir);
      const digest = (guid: string, sha: string): TranscriptDigestEntry & { sha256: string; bytes: number } => ({
        show_id: "beckers",
        show_title: "Becker's Healthcare Podcast",
        guid,
        title: "An episode",
        cues: 1,
        sha256: sha,
        bytes: 100
      });
      const archive = [digest("ep-one", "1".repeat(64)), digest("ep-two", "2".repeat(64))];
      for (const row of archive) {
        fs.writeFileSync(
          path.join(showDir, `${corpusSafeKey(row.guid)}.json`),
          JSON.stringify({ show_id: "beckers", guid: row.guid, cues: [{ text: "margins are the story", start_sec: 0, end_sec: 5 }] }),
          "utf8"
        );
      }
      const fingerprintOf = () => {
        const provider = new FileTranscriptCueProvider(root);
        return corpusFingerprint({
          archive,
          hasBody: (entry) => provider.bodyStat(entry as TranscriptDigestEntry) !== null,
          indexVersion: 2
        });
      };
      const both = fingerprintOf();
      expect(both.rows).toBe(2);
      fs.rmSync(path.join(showDir, `${corpusSafeKey("ep-two")}.json`));
      const one = fingerprintOf();
      expect(one.rows).toBe(1);
      expect(one.sha256).not.toBe(both.sha256);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /* MUTATION THAT KILLS THIS: return '' (or a timestamp) for a corpus with no
     body. CI and a fresh checkout have none, and two such reports must still
     compare equal on the fingerprint. */
  it("gives an archive with no bodies rows 0 and a stable empty hash", () => {
    const none = corpusFingerprint({ archive: rows, hasBody: () => false, indexVersion: 2 });
    expect(none).toEqual({ sha256: EMPTY_SHA256, rows: 0, rowsHashedBySize: 0, shows: 0, indexVersion: 2, extra: null });
    expect(corpusFingerprint({ archive: [], hasBody: all, indexVersion: 2 }).sha256).toBe(EMPTY_SHA256);
  });

  /* MUTATION THAT KILLS THIS: drop either passthrough. The index version is
     part of the snapshot (a rebuilt index changes what sourcing finds), and
     `extra` is the passage-index checksum's slot (R1-09). */
  it("carries the index version and the extra checksum through", () => {
    const fp = corpusFingerprint({ archive: rows, hasBody: all, indexVersion: 7, extra: { passageIndex: "abc" } });
    expect(fp.indexVersion).toBe(7);
    expect(fp.extra).toEqual({ passageIndex: "abc" });
  });
});
