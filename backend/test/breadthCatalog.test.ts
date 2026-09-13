import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  searchBreadthShows,
  showMatchBucket,
  SHOW_MATCH_EXACT,
  SHOW_MATCH_PREFIX,
  SHOW_MATCH_WORD_START,
  SHOW_MATCH_SUBSTRING,
  SHOW_MATCH_NONE,
  showMatchTier,
  popularityBand,
  type ShowSearchResult,
} from "../src/catalog/searchBreadthShows";
import { loadBreadthCatalog, type CatalogueShowEntry } from "../src/catalog/breadthCatalog";

/**
 * backend/src/catalog/breadthCatalog.ts + searchBreadthShows.ts — the
 * backend half of A3.1/Q3 (kanban t_8d1a6a58): show search that reaches
 * 4a's FULL breadth catalogue (curated + breadth tiers), not just the
 * 220-show curated set the client ships in data/catalog-client.json. See
 * breadthCatalog.ts's header for the merge/dedupe rule this suite proves.
 *
 * THE TWIN (client audit 2026-09-12). `searchBreadthShows` ranks by the same
 * rule as `search-engine.js:searchShows`, and section 3 of this suite is what
 * makes that a fact rather than an intention: it loads the real client module
 * and asserts the two orders agree row for row over the real catalogue. The
 * reason the SERVER's order matters at all, given that `app.js:mergeBreadth`
 * re-ranks everything it receives, is the `limit` cut - the server truncates
 * BEFORE the client ever sees the list, so a row dropped here is dropped for
 * good. See searchBreadthShows.ts's header for the measurement.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 */

/** The real `search-engine.js`, loaded the way a browser would load it: a
    classic script in a `node:vm` context with a `window` to hang itself on.
    Not `require`d, because the backend is CommonJS-compiled TypeScript with no
    type declarations for that file and no `allowJs` - and the point of this
    suite is to run the CLIENT's own bytes, not a copy of them.

    `Intl` is handed to the sandbox deliberately. `compareTitles` falls back to
    code-unit order when `Intl` is absent, and the server-side tie-break uses a
    real collator, so a sandbox without `Intl` would compare two different
    orders and call a genuine agreement a failure. */
interface ClientSearchEngine {
  searchShows(query: string, shows: unknown[]): Array<{ show_id: string }>;
  showMatchBucket(title: string, q: string): { bucket: number; idx: number };
  SHOW_MATCH_EXACT: number;
  SHOW_MATCH_PREFIX: number;
  SHOW_MATCH_WORD_START: number;
  SHOW_MATCH_SUBSTRING: number;
  SHOW_MATCH_NONE: number;
}

let clientEngine: ClientSearchEngine | null = null;
function clientRule(): ClientSearchEngine {
  if (clientEngine) return clientEngine;
  const repoRoot = path.resolve(__dirname, "..", "..");
  const src = fs.readFileSync(path.join(repoRoot, "search-engine.js"), "utf8");
  const sandbox: { window: { SearchEngine?: ClientSearchEngine }; Intl: typeof Intl; console: typeof console } = {
    window: {},
    Intl,
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: "search-engine.js" }).runInContext(sandbox);
  const engine = sandbox.window.SearchEngine;
  if (!engine) throw new Error("search-engine.js did not publish window.SearchEngine");
  clientEngine = engine;
  return engine;
}

/**
 * The first result, or a red test that says the list was empty.
 *
 * `backend/tsconfig.json` sets `noUncheckedIndexedAccess`, so `results[0]` is
 * `ShowSearchResult | undefined` and reading a field off it does not typecheck.
 * Four assertions in this file did exactly that and were the ONLY four type
 * errors in the whole backend — invisible because no CI job ever ran `tsc`
 * (fixed in the same change as this one: `.github/workflows/ci.yml`'s `backend`
 * job now runs `npm run typecheck`).
 *
 * The guard is written as a throw rather than `!` or a widened tsconfig on
 * purpose. `!` would silence the compiler and leave the runtime failure as
 * "cannot read properties of undefined", three frames from the assertion that
 * cares; this names the actual condition — a ranking test with nothing to rank
 * — which is the failure a mutation to `searchBreadthShows` that returns `[]`
 * would produce.
 */
function topResult(results: ShowSearchResult[]): ShowSearchResult {
  const top = results[0];
  if (top === undefined) {
    throw new Error("expected at least one search result to rank, got an empty list");
  }
  return top;
}

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
      chart_rank: null, // curated: no chart position, and the tier term places it anyway
    },
    {
      show_id: "111111",
      title: "Science Friday",
      artwork_url: "https://example.com/scifri.jpg",
      feed_url: "https://example.com/scifri.xml",
      tier: "breadth",
      chart_rank: 1,
      taxonomy_node_ids: [],
      editorial_note: null,
    },
    {
      show_id: "333333",
      title: "Deep Sea Engineering Hour",
      artwork_url: null,
      feed_url: "https://example.com/dsce.xml",
      tier: "breadth",
      chart_rank: 40,
      taxonomy_node_ids: [],
      editorial_note: null,
    },
    {
      show_id: "444444",
      title: "science of everything",
      artwork_url: null,
      feed_url: "https://example.com/soe.xml",
      tier: "breadth",
      chart_rank: 40,
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
    //
    // The bucket is asserted through `showMatchBucket` rather than through a
    // `rank` field on the row: the row no longer carries one, because nothing
    // downstream ever read it (see searchBreadthShows.ts's header).
    const results = searchBreadthShows("science friday", 25, fixtureCatalog());
    expect(topResult(results).show_id).toBe("111111");
    expect(showMatchBucket(topResult(results).title, "science friday")).toBe(SHOW_MATCH_EXACT);
  });

  it("a substring match still surfaces, ranked after exact/prefix matches", () => {
    // MUTATION: change the substring check from `.indexOf(q) !== -1` to
    // `.startsWith(q)` — "science of everything" (query "science" appears at
    // idx 0, so this one is actually a prefix match) would still pass, but
    // change the fixture query to something mid-string like "friday" and a
    // startsWith-only implementation would drop "Science Friday" entirely.
    const results = searchBreadthShows("friday", 25, fixtureCatalog());
    expect(results.some((r) => r.show_id === "111111")).toBe(true);
    // "Science Friday": " friday" follows a space, so this is the WORD-START
    // bucket, not the plain-substring one — the bucket S-04 added on the
    // client and this file's rewrite added here.
    expect(showMatchBucket(topResult(results).title, "friday")).toBe(SHOW_MATCH_WORD_START);
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
      { show_id: "b1", title: "Anchor Show", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null, chart_rank: 1 },
      { show_id: "c1", title: "Zebra Show", artwork_url: null, feed_url: null, tier: "curated", taxonomy_node_ids: [], editorial_note: null, chart_rank: null },
    ];
    const results = searchBreadthShows("show", 25, catalog);
    expect(topResult(results).show_id).toBe("c1"); // curated "Zebra Show" beats breadth "Anchor Show" despite alphabetical order
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
/* ==================================================================== */
/* 3. THE TWIN: THIS FILE'S ORDER IS search-engine.js'S ORDER            */
/* ==================================================================== */

describe("searchBreadthShows — the four buckets and the popularity prior", () => {
  it("ranks exact, then prefix, then WORD-START, then plain substring", () => {
    /* THE BUCKET S-04 ADDED ON THE CLIENT AND THIS FILE DID NOT HAVE for the
       whole time in between. Without it, "Casual Show Talk" (a word-start hit)
       and "Antiques Roadshow Detours" (a mid-word hit) share one bucket and a
       tie-break decides — which is how the show a listener obviously meant got
       buried.

       THE MID-WORD ROW IS "Antiques Roadshow Detours" AND NOT "Ricochet
       Showcase", which is what test/show-search-ranking.test.js's equivalent
       fixture uses: "Showcase" follows a SPACE, so it is a word start too, and
       that fixture therefore passes with or without the word-start bucket (the
       alphabetical tie-break happens to order it the same way). "Roadshow"
       follows "d" — a letter, no break — so it is a genuine plain substring.

       MUTATION: delete the word-start loop from `showMatchBucket` and return
       `SHOW_MATCH_SUBSTRING` instead. The two rows collapse into one bucket,
       the title tie-break puts "Antiques…" first, and the expected four-way
       order below fails. */
    const catalog: CatalogueShowEntry[] = [
      { show_id: "sub", title: "Antiques Roadshow Detours", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null, chart_rank: 5 },
      { show_id: "word", title: "Casual Show Talk", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null, chart_rank: 5 },
      { show_id: "prefix", title: "Show Me The Numbers", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null, chart_rank: 5 },
      { show_id: "exact", title: "Show", artwork_url: null, feed_url: null, tier: "breadth", taxonomy_node_ids: [], editorial_note: null, chart_rank: 5 },
    ];
    expect(searchBreadthShows("show", 25, catalog).map((r) => r.show_id)).toEqual([
      "exact", "prefix", "word", "sub",
    ]);
    expect(showMatchBucket("Show", "show")).toBe(SHOW_MATCH_EXACT);
    expect(showMatchBucket("Show Me The Numbers", "show")).toBe(SHOW_MATCH_PREFIX);
    expect(showMatchBucket("Casual Show Talk", "show")).toBe(SHOW_MATCH_WORD_START);
    expect(showMatchBucket("Antiques Roadshow Detours", "show")).toBe(SHOW_MATCH_SUBSTRING);
  });

  it("breaks ties on the BUCKETED popularity prior, with an unranked breadth row last", () => {
    /* `chart_rank` is Apple's PER-GENRE position, so rank 3 in one genre and
       rank 8 in another are not comparable — inside a band the prior must say
       nothing and the title tie-break must decide. Both directions are pinned,
       because a test for only one of them is satisfied by deleting the prior.

       MUTATION A: compare `a.show.chart_rank` raw instead of
       `popularityBand(a.show)`. "Beta Show" (3) jumps ahead of "Alpha Show"
       (8) on a meaningless cross-genre comparison and the first case fails.
       MUTATION B: make `popularityBand` return 0 rather than the worst band
       for a null `chart_rank`. "Zzz No Rank Show" leads and the second fails. */
    const band = (title: string, chart_rank: number | null): CatalogueShowEntry => ({
      show_id: title, title, artwork_url: null, feed_url: null, tier: "breadth",
      taxonomy_node_ids: [], editorial_note: null, chart_rank,
    });
    expect(searchBreadthShows("show", 25, [band("Beta Show", 3), band("Alpha Show", 8)]).map((r) => r.title))
      .toEqual(["Alpha Show", "Beta Show"]);
    expect(searchBreadthShows("show", 25, [band("Zzz No Rank Show", null), band("Mmm Mid Show", 150), band("Aaa Top Show", 4)]).map((r) => r.title))
      .toEqual(["Aaa Top Show", "Mmm Mid Show", "Zzz No Rank Show"]);
  });

  it("puts no `rank` field on the wire, and does put `chart_rank`, which has a reader", () => {
    /* The shipped `rank` was computed on every row, serialised on every
       response and read by NOBODY: `app.js:mergeBreadth` re-buckets every row
       it receives with `SearchEngine.rankShows`. `chart_rank` replaces it and
       is not decoration — `search-engine.js:popularityBand` reads it during
       exactly that re-rank, and a row arriving without it is banded UNRANKED,
       the worst band.

       MUTATION: re-add `rank` to the returned row, or drop `chart_rank` from
       `breadthCatalog.ts`'s entry. Either half of this fails. */
    const entries = loadBreadthCatalog();
    const row = topResult(searchBreadthShows("the daily", 25, entries));
    expect(Object.prototype.hasOwnProperty.call(row, "rank")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "chart_rank")).toBe(true);
    const ranked = entries.find((e) => e.tier === "breadth" && e.chart_rank !== null);
    expect(typeof ranked?.chart_rank).toBe("number");
    expect(entries.find((e) => e.tier === "curated")?.chart_rank).toBe(null);
  });
});

describe("searchBreadthShows — agreement with the real search-engine.js", () => {
  it("buckets every real catalogue title exactly as search-engine.js does", () => {
    /* The bucket rule, run over all ~19,904 real titles against the client's
       own bytes rather than against a restatement of them. This is the check
       that would have gone red the day S-04 added `SHOW_MATCH_WORD_START` to
       one side only.

       MUTATION: change this file's `SHOW_WORD_BREAK` to `/\W/`. Every CJK
       title in the catalogue buckets differently from the client's, and this
       throws on the first one. */
    const client = clientRule();
    const entries = loadBreadthCatalog();
    for (const q of ["the", "show", "up"]) {
      for (const entry of entries) {
        const mine = showMatchBucket(entry.title, q);
        const theirs = client.showMatchBucket(entry.title, q).bucket;
        if (mine !== theirs) {
          throw new Error(`"${q}" on ${JSON.stringify(entry.title)}: server ${mine}, client ${theirs}`);
        }
      }
    }
    expect(SHOW_MATCH_WORD_START).toBe(client.SHOW_MATCH_WORD_START);
    expect(SHOW_MATCH_SUBSTRING).toBe(client.SHOW_MATCH_SUBSTRING);
  });

  it("keeps, at the limit cut, exactly the rows the client's rule would have kept", () => {
    /* THE DEFECT, STATED AS AN EQUALITY. The endpoint truncates to `limit`
       before the client sees anything and `mergeBreadth` cannot recover a row
       that was never sent — so the only way the cut can be right is for it to
       be taken under the order the client will display. Row for row, over the
       real committed catalogue.

       MUTATION: restore the old comparator (bucket -> `tier === "curated"` ->
       `localeCompare`), dropping the popularity band. "daily" alone then
       disagrees on 6 of its 25 rows and "show" on 14. */
    const client = clientRule();
    const entries = loadBreadthCatalog();
    for (const q of ["show", "talk", "news", "daily", "fridman"]) {
      const mine = searchBreadthShows(q, 25, entries).map((r) => r.show_id);
      const theirs = client.searchShows(q, entries).slice(0, 25).map((r) => r.show_id);
      expect({ q, ids: mine }).toEqual({ q, ids: theirs });
    }
  });

  it("never drops a word-start row to make room for a plain-substring one", () => {
    /* The consequence that costs a listener something, pinned on its own
       because the equality above could in principle be satisfied by both sides
       being wrong together. Whatever survives the cut must sit in a TIER no
       worse than anything that did not.

       THE CLAIM IS ON THE TIER AND NO LONGER ON THE BUCKET, and that is the
       whole of P-08 restated here: the popularity prior is compared above the
       prefix/word-start distinction now, so a charting word-start row (bucket
       2) legitimately survives the cut while an unranked title-initial row
       (bucket 1) does not. Asserting `worstKept <= bestDropped` on the BUCKET
       forbids exactly the improvement — it went red on `2 <= 1` the moment the
       tier landed. What must still never happen is a MID-WORD hit riding into
       the kept 25 over a word-start one, which is what the tier says.

       Measured before the word-start bucket existed, query "show": the old rule
       shipped the plain-substring "Antiques Roadshow Detours" and dropped 14
       rows the client buckets WORD-START, among them "Money Guy Show"
       (chart_rank 4).

       MUTATION: revert `showMatchBucket` to the three-bucket
       `title === q ? 0 : idx === 0 ? 1 : 2`. Word-start and plain substring
       collapse into one bucket, a substring row rides into the kept 25, and
       the last assertion fails. */
    const entries = loadBreadthCatalog();
    const q = "show";
    const kept = searchBreadthShows(q, 25, entries);
    const keptIds = new Set(kept.map((r) => r.show_id));
    const dropped = entries.filter(
      (e) => showMatchBucket(e.title, q) !== SHOW_MATCH_NONE && !keptIds.has(e.show_id)
    );
    expect(kept.length).toBe(25);
    expect(dropped.length).toBeGreaterThan(0);

    const worstKept = Math.max(...kept.map((r) => showMatchTier(showMatchBucket(r.title, q))));
    const bestDropped = Math.min(...dropped.map((e) => showMatchTier(showMatchBucket(e.title, q))));
    expect(worstKept).toBeLessThanOrEqual(bestDropped);

    /* Teeth: the catalogue really does contain plain-substring "show" hits, so
       "nothing kept is one" is a claim about the ranking rather than a vacuous
       truth about the data. */
    expect(entries.some((e) => showMatchBucket(e.title, q) === SHOW_MATCH_SUBSTRING)).toBe(true);
    expect(kept.some((r) => showMatchBucket(r.title, q) === SHOW_MATCH_SUBSTRING)).toBe(false);
  });

  it("the limit cut keeps the CHARTING word-start show, not 25 unranked title-initial ones", () => {
    /* P-08's server half, over the real committed catalogue, and the reason
       this card had to change this file at all rather than only the client.
       `api/shows/search.ts` replies with at most `limit` rows and `mergeBreadth`
       cannot recover one that was never sent — so for "history", where the
       catalogue holds far more than 25 titles BEGINNING with "history", the old
       bucket-first order filled all 25 slots with prefix rows and *Dan Carlin's
       Hardcore History* — curated, chart-listed, and plainly the answer — was
       not in the reply at all. It reached the listener only because Apple's
       directory happened to send it too.

       STATED SCALE-FREE, as a relation and not a position: every row that
       survives the cut must be in a popularity band no worse than every row
       that did not, within the same match tier and the same catalogue tier.
       A count would rot the day the harvest adds more "History …" shows.

       MUTATION: restore `if (a.bucket !== b.bucket) return a.bucket - b.bucket;`
       as the FIRST comparison in this file's sort. The unranked prefix rows
       retake the 25 slots, the named show is absent from `kept`, and the first
       assertion fails. */
    const entries = loadBreadthCatalog();
    const q = "history";
    const kept = searchBreadthShows(q, 25, entries);
    expect(kept.length).toBe(25);
    expect(kept.map((r) => r.title)).toContain("Dan Carlin's Hardcore History");

    const keptIds = new Set(kept.map((r) => r.show_id));
    const dropped = entries.filter(
      (e) => showMatchBucket(e.title, q) !== SHOW_MATCH_NONE && !keptIds.has(e.show_id)
    );
    expect(dropped.length).toBeGreaterThan(0);
    /* The comparator's three ordered keys packed into one number, most
       significant first, so "no worse than" is a single `>=`. Each component is
       a small integer with a known ceiling (tier <= 2, breadth flag <= 1, band
       <= 4), so the radix cannot collide. */
    const key = (e: CatalogueShowEntry) =>
      showMatchTier(showMatchBucket(e.title, q)) * 100
      + (e.tier === "breadth" ? 1 : 0) * 10
      + popularityBand(e);
    const worstKeptKey = Math.max(...kept.map(key));
    /* Teeth: the dropped set really does contain rows the prior bands WORSE
       than something kept, so "the cut respected the prior" is a claim about
       the ranking and not a vacuous truth about the data. */
    expect(dropped.some((e) => popularityBand(e) > Math.min(...kept.map(popularityBand)))).toBe(true);
    const jumped = dropped.filter((e) => key(e) < worstKeptKey).map((e) => e.title);
    expect(jumped).toEqual([]);
  });
});
