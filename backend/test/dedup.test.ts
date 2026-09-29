import { describe, it, expect } from "vitest";
import { computeIdentityKey, groupDuplicates, isSameEpisode, normalizeTitle } from "../src/identity/dedup";

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  it("strips noise tags like (Video) / [Explicit]", () => {
    expect(normalizeTitle("Episode 42 (Video)")).toBe("episode 42");
    expect(normalizeTitle("Episode 42 [Explicit]")).toBe("episode 42");
  });

  it("treats diacritics as equivalent to plain letters", () => {
    expect(normalizeTitle("Café Society")).toBe(normalizeTitle("Cafe Society"));
  });

  /* Round-3 review (L6): lowercasing ran before NFKD, so a compatibility
     letter decomposed to an uppercase one that survived, and "™" became the
     letters "TM".
     MUTATION: lowercase first again -- "ℌello" keeps its capital H; drop the
     symbol strip -- "Hard Fork™" gains "tm". */
  it("folds letterlike symbols and compatibility letters the way plain titles fold", () => {
    expect(normalizeTitle("Hard Fork™")).toBe(normalizeTitle("Hard Fork"));
    expect(normalizeTitle("Brand® Talk")).toBe("brand talk");
    expect(normalizeTitle("ℌello")).toBe("hello");
    expect(normalizeTitle("Ｆｕｌｌ Ｗｉｄｔｈ")).toBe("full width");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeTitle("Too    many     spaces")).toBe("too many spaces");
  });
});

describe("computeIdentityKey", () => {
  it("combines normalized title and a date bucket", () => {
    const key = computeIdentityKey({ title: "My Episode", publishedAt: "2024-01-15T10:00:00Z", durationSeconds: 1800 });
    expect(key).toBe("my episode::2024-01-15");
  });

  it("uses 'unknown-date' when publishedAt is missing", () => {
    const key = computeIdentityKey({ title: "My Episode", publishedAt: null, durationSeconds: null });
    expect(key).toBe("my episode::unknown-date");
  });
});

describe("isSameEpisode — composite identity (corner case 3)", () => {
  it("matches identical title/date/duration", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(true);
  });

  it("matches within +/-1 day and +/-90s duration tolerance (audio vs video feed of same show)", () => {
    const a = { title: "Ep 1 (Audio)", publishedAt: "2024-01-15T23:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 1 (Video)", publishedAt: "2024-01-16T02:00:00Z", durationSeconds: 1860 };
    expect(isSameEpisode(a, b)).toBe(true);
  });

  it("rejects when date is more than 1 day apart", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 1", publishedAt: "2024-01-18T00:00:00Z", durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(false);
  });

  it("rejects when duration differs by more than 90s (both known)", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 2100 };
    expect(isSameEpisode(a, b)).toBe(false);
  });

  it("rejects on different titles even with same date/duration", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 2", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(false);
  });

  it("does not match on title alone when one side has a date and the other doesn't", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "Ep 1", publishedAt: null, durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(false);
  });

  it("title match with missing duration on one side still requires date match (duration check is non-blocking, not skipped-entirely)", () => {
    const a = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: null };
    const b = { title: "Ep 1", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 5000 };
    expect(isSameEpisode(a, b)).toBe(true);
  });

  it("never matches two empty titles", () => {
    const a = { title: "", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "", publishedAt: "2024-01-15T00:00:00Z", durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(false);
  });
});

describe("groupDuplicates", () => {
  it("groups a same-show audio+video feed pair, leaves unrelated episodes ungrouped", () => {
    const candidates = [
      { id: "audio-1", title: "Episode Ten", publishedAt: "2024-03-01T00:00:00Z", durationSeconds: 1800 },
      { id: "video-1", title: "Episode Ten", publishedAt: "2024-03-01T00:00:00Z", durationSeconds: 1815 },
      { id: "unrelated-1", title: "A Totally Different Episode", publishedAt: "2024-03-02T00:00:00Z", durationSeconds: 900 }
    ];
    const groups = groupDuplicates(candidates);
    expect(groups.get("audio-1")).toBe(groups.get("video-1"));
    expect(groups.has("unrelated-1")).toBe(false);
  });

  it("transitively groups a chain of near-duplicates", () => {
    const candidates = [
      { id: "a", title: "Rebroadcast Special", publishedAt: "2024-05-01T00:00:00Z", durationSeconds: 1800 },
      { id: "b", title: "Rebroadcast Special", publishedAt: "2024-05-02T00:00:00Z", durationSeconds: 1800 },
      { id: "c", title: "Rebroadcast Special", publishedAt: "2024-05-03T00:00:00Z", durationSeconds: 1800 }
    ];
    const groups = groupDuplicates(candidates);
    expect(groups.get("a")).toBe(groups.get("c"));
  });

  it("returns an empty map when nothing duplicates", () => {
    const candidates = [
      { id: "a", title: "Unique One", publishedAt: "2024-01-01T00:00:00Z", durationSeconds: 100 },
      { id: "b", title: "Unique Two", publishedAt: "2024-02-01T00:00:00Z", durationSeconds: 200 }
    ];
    expect(groupDuplicates(candidates).size).toBe(0);
  });
});

/* Round-3 audit, lane L6 (backend-rest-22): letters and digits in any script
   survive normalisation, so non-Latin titles dedup and key distinctly. */
describe("normalizeTitle keeps non-Latin letters", () => {
  it("keeps CJK, Cyrillic, Greek and Arabic letters", () => {
    expect(normalizeTitle("伊藤洋一のRound Up World Now")).toBe("伊藤洋一のround up world now");
    expect(normalizeTitle("Новости: выпуск 5")).toBe("новости выпуск 5");
    expect(normalizeTitle("Ελληνικά!")).toBe("ελληνικα");
    expect(normalizeTitle("حلقة ٣")).not.toBe("");
  });

  it("still strips diacritics in any script and punctuation", () => {
    expect(normalizeTitle("Café — Society")).toBe("cafe society");
    expect(normalizeTitle("Ÿöü")).toBe("you");
  });

  it("two fully non-Latin audio/video twins now match, and two different ones do not share a key", () => {
    const a = { title: "第五回 宇宙の話", publishedAt: "2026-01-01T00:00:00Z", durationSeconds: 1800 };
    const b = { title: "第五回 宇宙の話 (Video)", publishedAt: "2026-01-01T06:00:00Z", durationSeconds: 1830 };
    const c = { title: "第六回 海の話", publishedAt: "2026-01-01T00:00:00Z", durationSeconds: 1800 };
    expect(isSameEpisode(a, b)).toBe(true);
    expect(isSameEpisode(a, c)).toBe(false);
    expect(computeIdentityKey(a)).not.toBe(computeIdentityKey(c));
  });
});
