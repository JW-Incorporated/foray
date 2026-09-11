import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileTranscriptTextIndex,
  NullTranscriptTextIndex,
  TRANSCRIPT_TEXT_INDEX_VERSION,
  type TranscriptBodySource,
  type TranscriptBodyStat,
  type TranscriptTextIndex
} from "../src/generation/transcriptTextIndex";
import type { TranscriptCue, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * WS-H (docs/curation/generation-fix-plan-2026-09-09.md; findings F-06, F-49).
 *
 * The index tier 2 uses to decide WHICH episode to open for a claim. Everything
 * that decides whether the tape is about the claim lives elsewhere and is
 * tested in `sourceBeats.test.ts`; what is pinned here is narrower and entirely
 * mechanical: does it rank the episode that actually talks about the subject
 * first, does it refuse what the lineage gate refuses, does its disk cache
 * notice when a transcript changes underneath it, and does the Null
 * implementation return nothing so a checkout without `data-local/` behaves
 * exactly as it did before this file existed.
 */

/** A transcript body source with no filesystem behind it: cues in memory, plus
 * the mtime/size the index keys its cache on. Mirrors what
 * `FileTranscriptCueProvider` supplies, which is the whole contract. */
class FakeBodySource implements TranscriptBodySource {
  reads = 0;
  private readonly cues = new Map<string, TranscriptCue[]>();
  private readonly stats = new Map<string, TranscriptBodyStat>();

  set(guid: string, text: string[], stat: TranscriptBodyStat = { mtimeMs: 1_000, size: 100 }): void {
    this.cues.set(
      guid,
      text.map((t, i) => ({ text: t, start_sec: i * 10, end_sec: i * 10 + 10 }))
    );
    this.stats.set(guid, stat);
  }

  touch(guid: string, stat: TranscriptBodyStat): void {
    this.stats.set(guid, stat);
  }

  getCues(entry: TranscriptDigestEntry): TranscriptCue[] | null {
    this.reads += 1;
    return this.cues.get(entry.guid) ?? null;
  }

  bodyStat(entry: TranscriptDigestEntry): TranscriptBodyStat | null {
    return this.stats.get(entry.guid) ?? null;
  }
}

function entry(guid: string, title: string, showId = "practical-ai", showTitle = "Practical AI"): TranscriptDigestEntry {
  return { show_id: showId, show_title: showTitle, guid, title, cues: 3, feed_duration_sec: 3600 };
}

function withTempIndexRoot<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-text-index-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("transcriptTextIndex — ranking episodes by what they say", () => {
  it("ranks the episode that actually discusses the claim above one that mentions a word once", () => {
    const archive = [entry("a", "Episode 41"), entry("b", "Episode 42")];
    const bodies = new FakeBodySource();
    bodies.set("a", [
      "today we are talking about container orchestration and deployment pipelines",
      "nothing here concerns labelling at all beyond this single mention of labels"
    ]);
    bodies.set("b", [
      "the labels in that benchmark were wrong more often than anyone admitted",
      "an audit of the labels found thousands of mislabelled validation images",
      "so the benchmark labels set a ceiling on the accuracy anyone could report"
    ]);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      const hits = index.search("benchmark labels were wrong and set a ceiling on accuracy");
      expect(hits[0]!.entry.guid).toBe("b");
      expect(hits[0]!.score).toBeGreaterThan(hits[1]?.score ?? 0);
      expect(hits[0]!.matchedTerms).toBeGreaterThanOrEqual(3);
      expect(hits[0]!.rank).toBe(0);
    });
  });

  it("returns nothing when the claim has no content words, and nothing for a term nobody speaks", () => {
    const archive = [entry("a", "Episode 41")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["we talked about deployment pipelines for an hour"]);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(index.search("of the and it")).toEqual([]);
      expect(index.search("tokamak plasma confinement lawson")).toEqual([]);
    });
  });

  it("carries the idf it scored with, so tier 2's window search can weigh a rare word (F-61)", () => {
    /* The index is the only thing that knows which of a claim's words are rare
       in the shows the gate admits, and `selectTapeWindow` needs exactly that
       to tell a passage ABOUT a claim from one that shares the trade's
       vocabulary. One map per search, shared by every row. */
    const archive = [entry("a", "Episode 41"), entry("b", "Episode 42"), entry("c", "Episode 43")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["the model in production and the imagenet labels we audited"]);
    bodies.set("b", ["the model in production every single day"]);
    bodies.set("c", ["the model in production again and again"]);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      const hits = index.search("the imagenet model in production");
      expect(hits.length).toBeGreaterThan(0);
      const idf = hits[0]!.idf!;
      expect(idf).toBeDefined();
      /* `imagenet` is in one episode of three, `model` in all three: the rare
         word has to weigh more, and every row of one search shares one map. */
      expect(idf.get("imagenet")!).toBeGreaterThan(idf.get("model")!);
      for (const hit of hits) expect(hit.idf).toBe(idf);
    });
  });

  it("never returns — and never even indexes — an episode the caller's gate refuses", () => {
    /* §4.5's taxonomy lineage gate, passed straight down. A show the Foray's
       topic excludes must not be opened at all: that is both the correctness
       rule (F-23) and the reason a 1,700-episode archive is cheap to search. */
    const archive = [entry("a", "Episode 41", "practical-ai"), entry("b", "Episode 9", "the-bbq-central-show", "BBQ Central")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["deployment pipelines and monitoring"]);
    bodies.set("b", ["deployment pipelines and monitoring", "deployment pipelines and monitoring"]);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      const hits = index.search("deployment pipelines monitoring", { isUsable: (e) => e.show_id === "practical-ai" });
      expect(hits.map((h) => h.entry.guid)).toEqual(["a"]);
      expect(fs.existsSync(path.join(dir, "the-bbq-central-show.json"))).toBe(false);
    });
  });

  it("breaks a tie on the title bar — the one job the title still has (F-06)", () => {
    /* Two episodes whose cue text is identical, so BM25 cannot separate them.
       This is the ONLY place the title-token score is still allowed to decide
       anything in tier 2. */
    const archive = [entry("a", "Episode 41"), entry("b", "Monitoring drift in production")];
    const bodies = new FakeBodySource();
    const cues = ["we monitor drift in production every single day", "and that is how monitoring drift works"];
    bodies.set("a", cues);
    bodies.set("b", cues);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      const hits = index.search("monitoring drift in production");
      expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 6);
      expect(hits[0]!.entry.guid).toBe("b");
    });
  });

  it("F-85: a token that names an Object.prototype member indexes and searches like any other word", () => {
    /* Run 7 (2026-09-11, engineering disasters) died in research-shape with `list.push is not a
       function`: postings was a plain object, so the spoken token "constructor" resolved to
       Object.prototype.constructor. MUTATION: build postings with `{}` again → this throws. */
    const archive = [entry("a", "Episode 41"), entry("b", "Episode 42")];
    const bodies = new FakeBodySource();
    bodies.set("a", [
      "the constructor said the bridge constructor crew had no drawings for the walkway",
      "so the constructor improvised and the __proto__ of that decision was cost"
    ]);
    bodies.set("b", ["a quiet episode about hasOwnProperty and toString in code reviews"]);
    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      const hits = index.search("what the constructor crew improvised on the walkway");
      expect(hits[0]!.entry.guid).toBe("a");
      /* And the cached copy, parsed back from JSON, must read the same way. */
      const again = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(again.search("constructor walkway")[0]!.entry.guid).toBe("a");
      expect(again.search("toString reviews")[0]!.entry.guid).toBe("b");
    });
  });

  it("caps the ranking at the requested limit", () => {
    const archive = ["a", "b", "c", "d"].map((g, i) => entry(g, `Episode ${i}`));
    const bodies = new FakeBodySource();
    for (const g of ["a", "b", "c", "d"]) bodies.set(g, ["monitoring drift in production systems"]);

    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(index.search("monitoring drift production", { limit: 2 })).toHaveLength(2);
    });
  });
});

describe("transcriptTextIndex — the disk cache, and when it must not be trusted", () => {
  it("writes one cache file per show and answers the second process without re-reading a body", () => {
    const archive = [entry("a", "Episode 41"), entry("b", "Episode 42")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["monitoring drift in production"]);
    bodies.set("b", ["retraining calendars and rollback windows"]);

    withTempIndexRoot((dir) => {
      const first = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(first.search("monitoring drift")[0]!.entry.guid).toBe("a");
      const cacheFile = path.join(dir, "practical-ai.json");
      expect(fs.existsSync(cacheFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(cacheFile, "utf8")).version).toBe(TRANSCRIPT_TEXT_INDEX_VERSION);

      const readsAfterBuild = bodies.reads;
      const second = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(second.search("monitoring drift")[0]!.entry.guid).toBe("a");
      /* The freshness check stats every body; it must never re-read one. */
      expect(bodies.reads).toBe(readsAfterBuild);
    });
  });

  it("rebuilds when a transcript body changes underneath it", () => {
    const archive = [entry("a", "Episode 41")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["monitoring drift in production"]);

    withTempIndexRoot((dir) => {
      new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir }).search("monitoring drift");
      const before = bodies.reads;

      /* The episode is re-transcribed: same guid, same neighbours, new bytes —
         the change most likely to leave a cached index quietly wrong. */
      bodies.set("a", ["retraining calendars and rollback windows"], { mtimeMs: 2_000, size: 250 });
      const after = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(after.search("monitoring drift")).toEqual([]);
      expect(after.search("retraining rollback")[0]!.entry.guid).toBe("a");
      expect(bodies.reads).toBeGreaterThan(before);
    });
  });

  it("rebuilds when an episode is added to a show, and when the cache is corrupt or of an older version", () => {
    const archive = [entry("a", "Episode 41")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["monitoring drift in production"]);

    withTempIndexRoot((dir) => {
      new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir }).search("monitoring drift");
      const cacheFile = path.join(dir, "practical-ai.json");

      // A body that was not there when the index was built.
      bodies.set("b", ["retraining calendars and rollback windows"], { mtimeMs: 3_000, size: 300 });
      const grown = new FileTranscriptTextIndex({ archive: [...archive, entry("b", "Episode 42")], bodies, indexRoot: dir });
      expect(grown.search("retraining rollback")[0]!.entry.guid).toBe("b");

      // A cache written by an older rule is discarded, not trusted.
      const stale = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      stale.version = TRANSCRIPT_TEXT_INDEX_VERSION - 1;
      fs.writeFileSync(cacheFile, JSON.stringify(stale), "utf8");
      expect(new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir }).search("monitoring drift")[0]!.entry.guid).toBe("a");

      // And so is one that is not JSON at all.
      fs.writeFileSync(cacheFile, "{ not json", "utf8");
      expect(new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir }).search("monitoring drift")[0]!.entry.guid).toBe("a");
    });
  });

  it("still searches when the cache cannot be written at all", () => {
    /* A read-only or absent `data-local/` costs a rebuild, never a failure:
       sourcing must not depend on this module's convenience. */
    const archive = [entry("a", "Episode 41")];
    const bodies = new FakeBodySource();
    bodies.set("a", ["monitoring drift in production"]);
    /* An index root whose parent is a FILE: `mkdirSync` cannot create it on any
       platform, so the write throws and is swallowed. */
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "foray-text-index-")), "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf8");
    const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: path.join(blocker, "index") });
    expect(index.search("monitoring drift")[0]!.entry.guid).toBe("a");
  });

  it("has no body on this machine for a show whose bodies are absent, and says so by returning nothing", () => {
    const archive = [entry("a", "Episode 41")];
    const bodies = new FakeBodySource(); // nothing set: no stat, no cues
    withTempIndexRoot((dir) => {
      const index = new FileTranscriptTextIndex({ archive, bodies, indexRoot: dir });
      expect(index.search("monitoring drift")).toEqual([]);
      expect(fs.existsSync(path.join(dir, "practical-ai.json"))).toBe(false);
    });
  });
});

describe("transcriptTextIndex — the Null implementation is what CI runs", () => {
  it("returns no candidates and reports that no search ran", () => {
    /* Typed as the interface on purpose: what CI runs is a `TranscriptTextIndex`
       that happens to be this one, and the call has to typecheck through the seam. */
    const index: TranscriptTextIndex = new NullTranscriptTextIndex();
    expect(index.enabled).toBe(false);
    expect(index.search("anything at all about production machine learning")).toEqual([]);
  });
});
