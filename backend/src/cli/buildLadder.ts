#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { TaxonomyFileSchema } from "../types/taxonomy";
import { LaddersFileSchema, type Ladder, type LaddersFile } from "../types/ladders";
import { buildLadderSkeleton, type EnrichedEpisode } from "../curation/ladderBuilder";
import { BANNED, wordCount, MAX_WHY_LINE_WORDS } from "../copy/rules";

/**
 * `npm run build-ladder` — regenerates one ladder in data/ladders.json from
 * the enriched episode pool (docs/curation/personalization-and-depth-plan.md
 * §6, the Step-D implementation plan). Token-light by construction: this CLI
 * makes ZERO LLM calls. It reads episodes that are already tagged
 * (depth/format/topics — currently only data/session.json has these; see
 * "known limitation" below) plus a hand-authored curator hints file (mirrors
 * docs/research/fusion-candidates.md's pattern: human-written, versioned,
 * PR-reviewed — never machine-generated prose), and writes a deterministic,
 * prerequisite-ordered rung skeleton.
 *
 * Usage:
 *   npm run build-ladder -- --node engineering/energy-fusion \
 *     --hints ../docs/research/fusion-ladder-curation.json \
 *     --ladder-id fusion-101 --status draft
 *
 * Known limitation (tracked, not fixed here): data/discover.json's ~984
 * items have no depth/format yet (only data/session.json's 27-episode
 * hand-curated pool does — see backend/src/enrich/Enricher.ts's
 * ClassificationResult vs. what's actually persisted to discover.json today).
 * Episodes matching --node in discover.json but missing depth/format are
 * reported and excluded, never silently dropped without a trace. Scaling
 * ladders past hand-curated flagships needs that enrichment persisted
 * somewhere the builder can read it — deferred, see docs/DECISIONS.md.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

interface CliArgs {
  node: string;
  ladderId: string;
  status: "draft" | "published";
  hintsPath: string | null;
  sessionPath: string;
  discoverPath: string;
  taxonomyPath: string;
  laddersPath: string;
}

interface CuratorHints {
  title?: string;
  role_hints?: Record<string, "overview" | "fundamentals" | "frontier">;
  subtopic_keys?: Record<string, string>;
  subtopic_labels?: Record<string, string>;
  goals?: Record<string, string>;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const node = get("--node") ?? "engineering/energy-fusion";
  return {
    node,
    ladderId: get("--ladder-id") ?? "fusion-101",
    status: (get("--status") as "draft" | "published" | undefined) ?? "draft",
    hintsPath: get("--hints") ?? null,
    sessionPath: get("--session") ?? path.join(REPO_ROOT, "data", "session.json"),
    discoverPath: get("--discover") ?? path.join(REPO_ROOT, "data", "discover.json"),
    taxonomyPath: get("--taxonomy") ?? path.join(REPO_ROOT, "data", "taxonomy.json"),
    laddersPath: get("--out") ?? path.join(REPO_ROOT, "data", "ladders.json")
  };
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- p is a local CLI flag (or a hardcoded repo-relative default) the developer running this script passes themselves; never network/user input.
function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

function episodeMatchesNode(topics: string[], node: string): boolean {
  return topics.includes(node) || topics.some((t) => t.startsWith(`${node}/`));
}

/**
 * Pulls the merged, node-matched, depth/format-enriched episode pool from
 * session.json ∪ discover.json (the two pools are disjoint by id — see
 * data-and-site CI's apple_track_id dedup check). discover.json items
 * matching the node but lacking depth/format are reported, not silently
 * dropped (see the CLI's module docstring).
 */
function collectEnrichedEpisodes(
  node: string,
  session: { episodes: Record<string, Record<string, unknown>> },
  discover: { items: Record<string, unknown>[] }
): { episodes: EnrichedEpisode[]; excludedUnenriched: string[] } {
  const episodes: EnrichedEpisode[] = [];
  const excludedUnenriched: string[] = [];

  for (const [id, ep] of Object.entries(session.episodes)) {
    const topics = (ep.topics as string[] | undefined) ?? [];
    if (!episodeMatchesNode(topics, node)) continue;
    const depth = ep.depth as EnrichedEpisode["depth"] | undefined;
    const format = ep.format as string | undefined;
    if (!depth || !format) {
      excludedUnenriched.push(id);
      continue;
    }
    episodes.push({
      id,
      durationMin: Number(ep.duration_min),
      depth,
      format,
      releaseDate: String(ep.release_date)
    });
  }

  for (const item of discover.items) {
    const id = item.id as string;
    const topics = (item.topics as string[] | undefined) ?? [];
    if (!episodeMatchesNode(topics, node)) continue;
    // discover.json items have no depth/format today (known limitation, see
    // module docstring) — always excluded, always reported.
    excludedUnenriched.push(id);
  }

  return { episodes, excludedUnenriched };
}

function applyHints(episodes: EnrichedEpisode[], hints: CuratorHints): EnrichedEpisode[] {
  return episodes.map((ep) => {
    const roleHint = hints.role_hints?.[ep.id];
    const subtopicKey = hints.subtopic_keys?.[ep.id];
    const subtopicLabel = subtopicKey ? hints.subtopic_labels?.[subtopicKey] : undefined;
    return {
      ...ep,
      ...(roleHint ? { roleHint } : {}),
      ...(subtopicKey ? { subtopicKey } : {}),
      ...(subtopicLabel ? { subtopicLabel } : {})
    };
  });
}

/** Same copy-rule preflight tools/refresh/merge.mjs runs before writing —
 * fail fast, before touching data/ladders.json, rather than reddening CI. */
function validateCopy(ladder: Ladder): string[] {
  const errors: string[] = [];
  const check = (label: string, text: string, maxWords: number) => {
    if (wordCount(text) > maxWords) errors.push(`${label}: ${wordCount(text)}w > ${maxWords}: "${text}"`);
    for (const rx of BANNED) if (rx.test(text)) errors.push(`${label}: banned ${rx}: "${text}"`);
  };
  check(`ladder "${ladder.id}" title`, ladder.title, 100); // titles aren't word-capped, just banned-word-checked
  for (const rung of ladder.rungs) {
    check(`rung "${rung.id}" goal`, rung.goal, MAX_WHY_LINE_WORDS);
  }
  return errors;
}

function loadOrInitLaddersFile(laddersPath: string): LaddersFile {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- laddersPath is a local CLI flag (--out) or hardcoded default; never network/user input.
  if (!fs.existsSync(laddersPath)) {
    return { version: 1, built_at: new Date().toISOString(), ladders: [] };
  }
  return LaddersFileSchema.parse(readJson(laddersPath));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log("Foray ladder builder");
  console.log(`  node: ${args.node}`);

  const taxonomy = TaxonomyFileSchema.parse(readJson(args.taxonomyPath));
  if (!taxonomy.nodes.some((n) => n.id === args.node)) {
    console.error(`Node "${args.node}" not found in ${args.taxonomyPath} — refusing to build an orphan ladder.`);
    process.exitCode = 1;
    return;
  }

  const session = readJson<{ episodes: Record<string, Record<string, unknown>> }>(args.sessionPath);
  const discover = readJson<{ items: Record<string, unknown>[] }>(args.discoverPath);

  const { episodes, excludedUnenriched } = collectEnrichedEpisodes(args.node, session, discover);
  if (excludedUnenriched.length > 0) {
    console.warn(
      `  WARN: ${excludedUnenriched.length} matching episode(s) excluded (no depth/format yet): ${excludedUnenriched.join(", ")}`
    );
  }
  if (episodes.length === 0) {
    console.error(`No enriched episodes found for node "${args.node}" — nothing to build.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  enriched candidate episodes: ${episodes.length}`);

  const hints: CuratorHints = args.hintsPath ? readJson<CuratorHints>(args.hintsPath) : {};
  const hintedEpisodes = applyHints(episodes, hints);

  const title = hints.title ?? args.node;
  const goals = hints.goals ?? {};

  let ladder: Ladder;
  try {
    ladder = buildLadderSkeleton({ ladderId: args.ladderId, node: args.node, title, episodes: hintedEpisodes, goals });
  } catch (err) {
    console.error("Ladder assembly failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }
  ladder.status = args.status;

  const copyErrors = validateCopy(ladder);
  if (copyErrors.length > 0) {
    console.error("COPY RULE FAILURES:\n" + copyErrors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const laddersFile = loadOrInitLaddersFile(args.laddersPath);
  const idx = laddersFile.ladders.findIndex((l) => l.id === ladder.id);
  if (idx >= 0) laddersFile.ladders[idx] = ladder;
  else laddersFile.ladders.push(ladder);
  laddersFile.built_at = new Date().toISOString();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- args.laddersPath is a local CLI flag (--out) or hardcoded repo-relative default; never network/user input.
  fs.writeFileSync(args.laddersPath, JSON.stringify(laddersFile, null, 2) + "\n", "utf-8");

  console.log(`  ladder written: ${args.laddersPath}`);
  console.log(`  ladder "${ladder.id}" (${ladder.status}): ${ladder.rungs.length} rungs, ${ladder.estimated_total_min} min total`);
  for (const rung of ladder.rungs) {
    console.log(`    [${rung.level}${rung.subtopic ? ` — ${rung.subtopic}` : ""}] ${rung.id}: ${rung.episode_ids.join(", ")}`);
  }
}

main();
