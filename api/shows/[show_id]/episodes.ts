import { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestShowFeed } from "../../../backend/src/catalog/ingestShowFeed";
import { PostgresShowEpisodesStore } from "../../../backend/src/catalog/showEpisodesStore";

/**
 * Fetch-on-demand per-show episode list (Stage 3b, kanban t_567b570f,
 * docs/show-pages-plan.md §Stage 3). GET /api/shows/:show_id/episodes.
 *
 * This is the first Vercel serverless function in this repo — vercel.json
 * was previously static-build-only by deliberate choice (docs/DECISIONS.md).
 * Flagged explicitly in the design comment posted on the kanban card and in
 * this PR's description for Wyatt's review; reuses the existing Vercel
 * project/deploy and the already-provisioned Supabase service-role
 * connection, no new hosting account or secrets.
 *
 * Never touches audio bytes — only ever returns metadata pointers
 * (ADR-0007 / product principle #3). Degrades to cached rows on a feed
 * fetch failure, or an explicit error state — never a blank page.
 */

let showIdIndex: Map<string, string> | null = null; // show_id -> feed_url, lazily built from data/catalog*.json

function loadShowIdIndex(): Map<string, string> {
  if (showIdIndex) return showIdIndex;
  const index = new Map<string, string>();
  const ROOT = join(__dirname, "..", "..", "..");
  for (const file of ["data/catalog.json", "data/catalog-breadth.json"]) {
    try {
      const raw = readFileSync(join(ROOT, file), "utf8");
      const parsed = JSON.parse(raw) as { shows: Array<{ show_id?: string; apple_collection_id?: number; feed_url: string | null }> };
      for (const show of parsed.shows ?? []) {
        const id = show.show_id ?? (show.apple_collection_id !== undefined ? String(show.apple_collection_id) : null);
        if (id && show.feed_url && !index.has(id)) index.set(id, show.feed_url);
      }
    } catch {
      // Missing/unreadable catalog file degrades to "show not found" below — never a 500.
    }
  }
  showIdIndex = index;
  return index;
}

/**
 * Minimal structural types for the Vercel Node runtime request/response —
 * avoids adding `@vercel/node` as a new dependency to a root that is
 * deliberately dependency-free by design (root package.json's own
 * description). The runtime object shape (query, method, status().json())
 * is standard across Vercel's Node functions regardless of the SDK type
 * package being installed.
 */
interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const showId = typeof req.query.show_id === "string" ? req.query.show_id : null;
  if (!showId) {
    res.status(400).json({ error: "show_id is required" });
    return;
  }

  const feedUrl = loadShowIdIndex().get(showId);
  if (!feedUrl) {
    res.status(404).json({ error: "unknown show_id" });
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Keyless-by-default posture (CLAUDE.md): no DB configured -> explicit
    // "couldn't load" rather than a crash, matching the design's degrade rule.
    res.status(503).json({ error: "episode store not configured", show_id: showId, episodes: [] });
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const store = new PostgresShowEpisodesStore(client);
    const result = await ingestShowFeed(showId, feedUrl, store);
    const episodes = await store.episodesForShow(showId);

    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    res.status(200).json({
      show_id: showId,
      episodes,
      stale: result.status === "cached_stale",
      error: result.status === "cached_stale" || result.status === "no_cache_error" ? result.error ?? null : null
    });
  } finally {
    await client.end();
  }
}
