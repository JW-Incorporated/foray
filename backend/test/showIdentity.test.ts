import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { normalizeShowTitle, resetShowIdentityCache, showKeyForItem } from "../src/generation/showIdentity";
import { deriveItemId, legacyItemId, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { MintedSegmentSource } from "../src/generation/audioSourceLookup";

/**
 * GV-83 (W3-12; MQ-07): a tape item's show, as one key. The first block runs
 * against the COMMITTED data (data/segments.json, data/segment-sources.json,
 * data/catalog.json), because the card's risk is exactly the join over real
 * rows: 69 of the 255 pool rows have no `--` in their item id, and a title
 * that misses the catalogue falls back to a `title:` key.
 */

const ROOT = resolve(__dirname, "..", "..");

function readData<T>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, "data", name), "utf8")) as T;
}

afterEach(() => resetShowIdentityCache());

describe("GV-83 — showKeyForItem over the committed pool", () => {
  const pool = readData<{ segments: Array<{ id: string; item_id: string }> }>("segments.json").segments;
  const sources = readData<{ sources: Array<{ id: string; show: string }> }>("segment-sources.json").sources;
  const catalogue = readData<{ shows: Array<{ show_id: string; title: string }> }>("catalog.json").shows;
  const titleByItem = new Map(sources.map((s) => [s.id, s.show]));
  const showIdByTitle = new Map(catalogue.map((s) => [s.title, s.show_id]));

  /* MUTATION THAT KILLS THIS: drop the `title:` fallback in showKeyForItem
     (`?? ""` for a title the catalogue lacks). Ran it: red. */
  it("returns a non-empty key for every committed data/segments.json item", () => {
    expect(pool.length).toBeGreaterThan(0);
    for (const row of pool) expect(showKeyForItem(row.item_id, { root: ROOT }), row.item_id).not.toBe("");
  });

  /* MUTATION THAT KILLS THIS: skip the catalogue lookup and return
     `title:<normalized>` for every titled item. Ran it: red. */
  it("returns the catalogue show_id for every pool item whose segment-sources show matches a catalogue title", () => {
    let matched = 0;
    for (const row of pool) {
      const title = titleByItem.get(row.item_id);
      const showId = title === undefined ? undefined : showIdByTitle.get(title);
      if (showId === undefined) continue;
      matched++;
      expect(showKeyForItem(row.item_id, { root: ROOT }), row.item_id).toBe(showId);
    }
    expect(matched).toBeGreaterThan(0);
  });

  it("keys the rest by normalized title, and never splits a show the catalogue knows", () => {
    const keys = new Set(pool.map((row) => showKeyForItem(row.item_id, { root: ROOT })));
    const catalogueTitles = new Set(catalogue.map((s) => normalizeShowTitle(s.title)));
    for (const key of keys) {
      if (!key.startsWith("title:")) continue;
      expect(catalogueTitles.has(key.slice("title:".length)), key).toBe(false);
    }
    /* Measured, the card's risk: no two keys fold to one normalized title. */
    const titles = [...keys].filter((k) => k.startsWith("title:")).map((k) => k.slice(6));
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("GV-83 — showKeyForItem's resolution order", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function stagedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "gv83-show-"));
    dirs.push(root);
    mkdirSync(join(root, "data"));
    writeFileSync(
      join(root, "data", "catalog.json"),
      JSON.stringify({ shows: [{ show_id: "geology-bites", title: "Geology Bites", taxonomy_node_ids: [] }] })
    );
    writeFileSync(
      join(root, "data", "segment-sources.json"),
      JSON.stringify({
        sources: [
          { id: "rocks-1", show: "Geology  Bites!" },
          { id: "grill-1", show: "The Grill Coach" },
          { id: "other--x", show: "Rewilding Earth Podcast" }
        ]
      })
    );
    return root;
  }

  const entry: TranscriptDigestEntry = { show_id: "1202593158", show_title: "A Breadth Show", guid: "g1", title: "Episode One", cues: 10 };

  function mintedRow(id: string, guid: string): MintedSegmentSource {
    return {
      id,
      show: "The Grill Coach",
      title: "Other",
      feed_url: null,
      episode_guid: guid,
      audio_url: "https://example.invalid/a.mp3",
      audio_type: "audio/mpeg",
      duration_sec: 100,
      dai_suspected: false,
      source: "generation-tier-2"
    };
  }

  /* MUTATIONS THAT KILL THIS (each ran, red): (a) drop the archive branch of
     showKeyForItem; (b) drop the legacy fallback in archiveIndex
     (`if (!index.has(legacy)) index.set(legacy, entry.show_id);`); (c) drop
     the derived-id loop in archiveIndex. Every id below also has a title row
     ("The Grill Coach"), so an id the archive does not answer keys as
     `title:the grill coach`, never falling through to the id prefix (which is
     the archive show_id itself for a `<show_id>--<slug>` id). */
  it("a minted item resolves to its archive entry's show_id, by derived or legacy id", () => {
    const root = stagedRoot();
    const suffixed: TranscriptDigestEntry = { ...entry, guid: "g2", item_id_suffix: "ab12" };
    const archive = [suffixed];
    const derivedId = deriveItemId(suffixed);
    const legacyId = legacyItemId(suffixed);
    expect(derivedId).not.toBe(legacyId);
    const titledRows = [mintedRow(derivedId, "g2"), mintedRow(legacyId, "g2")];
    /* Control: without the archive, both ids key by their title row. */
    expect(showKeyForItem(derivedId, { newSegmentSources: titledRows, root })).toBe("title:the grill coach");
    expect(showKeyForItem(legacyId, { newSegmentSources: titledRows, root })).toBe("title:the grill coach");
    /* With it, the archive answers both, the legacy id included. */
    expect(showKeyForItem(derivedId, { archive, newSegmentSources: titledRows, root })).toBe("1202593158");
    expect(showKeyForItem(legacyId, { archive, newSegmentSources: titledRows, root })).toBe("1202593158");
    /* The archive outranks a title row filed under the same id. */
    const titled: TranscriptDigestEntry = { show_id: "geology-bites", show_title: "x", guid: "g3", title: "Other", cues: 1 };
    const minted: MintedSegmentSource[] = [mintedRow(deriveItemId(titled), "g3")];
    expect(showKeyForItem(deriveItemId(titled), { archive: [titled], newSegmentSources: minted, root })).toBe("geology-bites");
    /* Without the archive, the run's own minted source row names the show. */
    expect(showKeyForItem(deriveItemId(titled), { newSegmentSources: minted, root })).toBe("title:the grill coach");
  });

  /* MUTATION THAT KILLS THIS: match catalogue titles exactly (no
     normalizeShowTitle) — "Geology  Bites!" then keys as a title. Ran it: red. */
  it("a pool item maps its segment-sources title to the catalogue show_id, else to title:<normalized>", () => {
    const root = stagedRoot();
    expect(showKeyForItem("rocks-1", { root })).toBe("geology-bites");
    expect(showKeyForItem("grill-1", { root })).toBe("title:the grill coach");
    /* A title row outranks the id prefix. */
    expect(showKeyForItem("other--x", { root })).toBe("title:rewilding earth podcast");
  });

  it("falls back to the id prefix before '--', then to the whole id; an empty id is empty", () => {
    const root = stagedRoot();
    expect(showKeyForItem("some-show--some-episode", { root })).toBe("some-show");
    expect(showKeyForItem("lonely-item", { root })).toBe("lonely-item");
    expect(showKeyForItem("   ", { root })).toBe("");
  });

  it("a root with no catalogue files still answers from the id", () => {
    const root = mkdtempSync(join(tmpdir(), "gv83-empty-"));
    dirs.push(root);
    expect(showKeyForItem("show--ep", { root })).toBe("show");
  });

  it("normalizeShowTitle folds case, accents and punctuation", () => {
    expect(normalizeShowTitle("  Café  Society: The Podcast! ")).toBe("cafe society the podcast");
  });
});
