import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { searchBreadthShows, type ShowSearchResult } from "../src/catalog/searchBreadthShows";
import { loadBreadthCatalog, type CatalogueShowEntry } from "../src/catalog/breadthCatalog";

/**
 * backend/src/catalog/breadthCatalog.ts + searchBreadthShows.ts — the
 * backend half of A3.1/Q3 (kanban t_8d1a6a58): show search that reaches
 * 4a's FULL breadth catalogue (curated + breadth tiers), not just the
 * 220-show curated set the client ships in data/catalog-client.json. See
 * breadthCatalog.ts's header for the merge/dedupe rule this suite proves.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 */

function fixtureCatalog(): CatalogueShowEntry[] {
  return [
    {
      show_id: "lex-fridman-podcast",
      title: "Lex Fridman Podcast",
      artwork_url: "https://example.com/lex.jpg",
      feed_url: "https://example.com/lex.xml",
      tier: "curated",
      taxonomy_node_ids: ["engineering/energy-fusion"],
      editorial_note: "Marathon technical interviews.",
    },
    {
      show_id: "111111",
      title: "Science Friday",
      artwork_url: "https://example.com/scifri.jpg",
      feed_url: "https://example.com/scifri.xml",
      tier: "breadth",
      taxonomy_node_ids: [],
      editorial_note: null,
    },
    {
      show_id: "333333",
      title: "Deep Sea Engineering Hour",
      artwork_url: null,
      feed_url: "https://example.com/dsce.xml",
      tier: "breadth",
      taxonomy_node_ids: [],
      editorial_note: null,
    },
    {
      show_id: "444444",
      title: "science of everything",
      artwork_url: null,
      feed_url: "https://example.com/soe.xml",
      tier: "breadth",
      taxonomy_node_ids: [],
      editorial_note: null,
    },
  ];
}

/* ==================================================================== */
/* 1. RANKING, PURE, AGAINST A FIXTURE MERGED CATALOGUE                  */
/* ==================================================================== */

describe("searchBreadthShows — ranking over the merged catalogue", () => {
  it("finds a breadth-tier-only show that is NOT in the curated catalogue", () => {
    // MUTATION: filter the catalog to `tier === "curated"` before scoring —
    // this assertion fails because "Deep Sea Engineering Hour" only exists
    // in the breadth tier fixture above.
    const results = searchBreadthShows("Deep Sea Engineering", 25, fixtureCatalog());
    expect(results.some((r: ShowSearchResult) => r.show_id === "333333")).toBe(true);
    expect(results.find((r) => r.show_id === "333333")?.tier).toBe("breadth");
  });

  it("an exact title match (case-insensitive) ranks first", () => {
    // MUTATION: drop the `title === q ? 0` branch so every match ranks by
    // substring position only — "Science Friday" (exact) would then tie or
    // lose to "science of everything" depending on sort stability.
    const results = searchBreadthShows("science friday", 25, fixtureCatalog());
    expect(results[0].show_id).toBe("111111");
    expect(results[0].rank).toBe(0);
  });

  it("a substring match still surfaces, ranked after exact/prefix matches", () => {
    // MUTATION: change the substring check from `.indexOf(q) !== -1` to
    // `.startsWith(q)` — "science of everything" (query "science" appears at
    // idx 0, so this one is actually a prefix match) would still pass, but
    // change the fixture query to something mid-string like "friday" and a
    // startsWith-only implementation would drop "Science Friday" entirely.
    const results = searchBreadthShows("friday", 25, fixtureCatalog());
    expect(results.some((r) => r.show_id === "111111")).toBe(true);
    expect(results[0].rank).toBe(2);
  });

  it("no match returns an empty array, not a throw", () => {
    // MUTATION: remove the early-return guard for a query that matches
    // nothing — an unguarded implementation would still return `[]` here
    // (nothing to break structurally), so this also proves an empty query
    // string short-circuits rather than matching every show.
    expect(searchBreadthShows("zzz-nonexistent-show-zzz", 25, fixtureCatalog())).toEqual([]);
    expect(searchBreadthShows("", 25, fixtureCatalog())).toEqual([]);
  });

  it("respects the limit parameter", () => {
    // MUTATION: drop the `.slice(0, limit)` call — this assertion fails
    // because all matching entries (not just `limit` of them) would return.
    const results = searchBreadthShows("science", 1, fixtureCatalog());
    expect(results.length).toBe(1);
  });

  it("ties within a rank prefer curated tier, then alphabetical", () => {
    // MUTATION: drop the tier tiebreak so both curated and breadth land in
    // title order alone — for a query where a breadth show's title sorts
    // before a same-rank curated show's title, the breadth entry would then
    // come first, and this assertion (curated first) fails.
    const catalog: CatalogueShowEntry[] = [
      { show_id: "b1", title: "Anchor Show", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null },
      { show_id: "c1", title: "Zebra Show", artwork_url: null, feed_url: null, tier: "curated", taxonomy_node_ids: [], editorial_note: null },
    ];
    const results = searchBreadthShows("show", 25, catalog);
    expect(results[0].show_id).toBe("c1"); // curated "Zebra Show" beats breadth "Anchor Show" despite alphabetical order
  });
});

/* ==================================================================== */
/* 2. INTEGRATION AGAINST THE REAL COMMITTED CATALOGUE FILES             */
/* ==================================================================== */

describe("loadBreadthCatalog — real committed data/catalog*.json", () => {
  it("loads and merges the real files without throwing, curated + breadth both present", () => {
    // MUTATION: rename a field read in breadthCatalog.ts (e.g.
    // `apple_collection_id` to `collection_id`) — every breadth show would
    // then be dropped by the falsy-id guard, collapsing breadthCount to 0.
    const entries = loadBreadthCatalog();
    const curatedCount = entries.filter((e) => e.tier === "curated").length;
    const breadthCount = entries.filter((e) => e.tier === "breadth").length;
    expect(curatedCount).toBeGreaterThan(100); // ~220 curated shows
    expect(breadthCount).toBeGreaterThan(1000); // ~10k breadth shows, minus in_curated overlap
  });

  it("no show_id is duplicated across the merged index", () => {
    // MUTATION: remove the `seenIds` dedupe check in breadthCatalog.ts — a
    // breadth show marked in_curated but not correctly filtered, or an id
    // collision, would then appear twice and this Set-size check fails.
    const entries = loadBreadthCatalog();
    const ids = entries.map((e) => e.show_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty show_id and title", () => {
    // MUTATION: drop either guard clause (curated's show_id/title check, or
    // breadth's apple_collection_id/title check) — a malformed source row
    // would then produce an entry with an empty id, failing this loop.
    const entries = loadBreadthCatalog();
    for (const e of entries) {
      expect(e.show_id).toBeTruthy();
      expect(e.title).toBeTruthy();
    }
  });

  it("a real breadth-tier-only show is findable via searchBreadthShows", () => {
    // MUTATION: hardcode searchBreadthShows to only scan curated entries —
    // this fails because the picked show is confirmed breadth-tier below.
    const entries = loadBreadthCatalog();
    const breadthOnly = entries.find((e) => e.tier === "breadth");
    expect(breadthOnly).toBeTruthy();
    if (!breadthOnly) return;
    const results = searchBreadthShows(breadthOnly.title, 25, entries);
    expect(results.some((r) => r.show_id === breadthOnly.show_id)).toBe(true);
  });

  it("client-shipped catalog-client.json stays a strict subset of the merged curated tier", () => {
    // MUTATION: this is a sanity check on the merge, not the merge logic
    // itself — it would only fail if catalog-client.json started carrying a
    // show_id catalog.json doesn't have, which would mean the two curated
    // sources have drifted out of sync (a real data bug this test is meant
    // to catch, matching test/show-page.test.js's existing sync check).
    const ROOT = path.resolve(__dirname, "..", "..");
    const clientCatalog = JSON.parse(
      fs.readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8")
    ) as { shows: Array<{ show_id: string }> };
    const entries = loadBreadthCatalog();
    const mergedIds = new Set(entries.map((e) => e.show_id));
    for (const s of clientCatalog.shows) {
      expect(mergedIds.has(s.show_id)).toBe(true);
    }
  });
});
