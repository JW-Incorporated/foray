#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { env, envPresenceSummary } from "../config/env";
import { TaxonomyFileSchema } from "../types/taxonomy";
import { createEnricher } from "../enrich/createEnricher";
import { defaultCostEventSink } from "../cost/costEvents";
import { defaultBudgetGuard } from "../cost/budgetGuard";
import { buildSession } from "../curation/sessionBuilder";
import { createUserInterestsProvider } from "../curation/createUserInterestsProvider";
import {
  extractCandidatesFromMarkdown,
  normalizeCandidatesFromJson,
  type NormalizedCandidate
} from "../curation/candidateExtractor";

/**
 * `npm run build-session` — the end-to-end proof of the curation pipeline
 * (01_PROMPT.md item 8). With zero API keys configured it runs entirely in
 * dry-run mode: StubEnricher for classification/why-lines, $0 cost events,
 * and candidates sourced from docs/research/*.md's embedded JSON blocks
 * (no database required yet).
 *
 * Usage:
 *   npm run build-session
 *   npm run build-session -- --candidates path/to/candidates.json --archetype deep-learn
 *   npm run build-session -- --commute-minutes 25 --speed 1.25 --out my-session.json
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

interface CliArgs {
  taxonomyPath: string;
  candidatesPath: string | null;
  candidatesArchetype: string | null;
  commuteMinutes: number;
  playbackSpeed: number;
  sessionKey: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const today = new Date().toISOString().slice(0, 10);

  return {
    taxonomyPath: get("--taxonomy") ?? path.join(REPO_ROOT, "data", "taxonomy.json"),
    candidatesPath: get("--candidates") ?? null,
    candidatesArchetype: get("--archetype") ?? null,
    commuteMinutes: Number(get("--commute-minutes") ?? "18"),
    playbackSpeed: Number(get("--speed") ?? "1.5"),
    sessionKey: get("--session-key") ?? `${today}-morning`,
    outPath: get("--out") ?? path.join(__dirname, "..", "..", "output", `session-${today}.json`)
  };
}

function loadTaxonomy(taxonomyPath: string) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- taxonomyPath is a local CLI flag (--taxonomy) the developer running this script passes themselves, defaulting to a hardcoded repo path; never network/user input.
  const raw = fs.readFileSync(taxonomyPath, "utf-8");
  return TaxonomyFileSchema.parse(JSON.parse(raw));
}

function loadDefaultCandidates(): NormalizedCandidate[] {
  const researchDir = path.join(REPO_ROOT, "docs", "research");
  const candidates: NormalizedCandidate[] = [];

  const fusionPath = path.join(researchDir, "fusion-candidates.md");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fusionPath is built from REPO_ROOT (derived from __dirname) + hardcoded segments, not external input.
  if (fs.existsSync(fusionPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same fusionPath as above.
    const md = fs.readFileSync(fusionPath, "utf-8");
    candidates.push(...extractCandidatesFromMarkdown(md, "fusion-candidates.md", "deep-learn"));
  }

  const otherPath = path.join(researchDir, "other-slot-candidates.md");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- otherPath is built from REPO_ROOT (derived from __dirname) + hardcoded segments, not external input.
  if (fs.existsSync(otherPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same otherPath as above.
    const md = fs.readFileSync(otherPath, "utf-8");
    candidates.push(...extractCandidatesFromMarkdown(md, "other-slot-candidates.md", null));
  }

  return candidates;
}

function loadCandidatesFromFile(candidatesPath: string, defaultArchetype: string | null): NormalizedCandidate[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidatesPath is a local CLI flag (--candidates) the developer running this script passes themselves; never network/user input.
  const raw = fs.readFileSync(candidatesPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const archetype = defaultArchetype as import("../types/session").Archetype | null;
  return normalizeCandidatesFromJson(parsed, path.basename(candidatesPath), archetype);
}

// Single-seeded-user placeholder per 01_PROMPT.md constraint #7 (user_id
// everywhere even though there's one user today).
const SEEDED_USER_ID = "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("Foray session builder");
  console.log("  env:", envPresenceSummary());
  console.log(`  anthropic mode: ${env.anthropicDryRun ? "DRY-RUN (StubEnricher)" : "LIVE (AnthropicEnricher)"}`);

  const taxonomy = loadTaxonomy(args.taxonomyPath);

  const candidates = args.candidatesPath
    ? loadCandidatesFromFile(args.candidatesPath, args.candidatesArchetype)
    : loadDefaultCandidates();

  if (candidates.length === 0) {
    console.error("No candidates found — nothing to build a session from.");
    process.exitCode = 1;
    return;
  }
  console.log(`  candidates loaded: ${candidates.length}`);

  const enricher = createEnricher();
  // Personalization Step A+B (personalization-and-depth-plan.md): resolves to
  // the in-memory provider today (keyless, seeded from data/personas.json's
  // "generalist" default — see createUserInterestsProvider.ts for when a
  // real Postgres-backed provider takes over).
  const userInterestsProvider = createUserInterestsProvider();

  const result = await buildSession({
    userId: SEEDED_USER_ID,
    sessionKey: args.sessionKey,
    commuteMinutes: args.commuteMinutes,
    playbackSpeed: args.playbackSpeed,
    taxonomy,
    candidates,
    enricher,
    userInterestsProvider
  });

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- args.outPath is a local CLI flag (--out) the developer running this script passes themselves, defaulting to a hardcoded repo path; never network/user input.
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same args.outPath as above.
  fs.writeFileSync(args.outPath, JSON.stringify(result.session, null, 2) + "\n", "utf-8");

  console.log(`  session written: ${args.outPath}`);
  console.log(`  cards: ${result.session.cards.length}`);
  for (const card of result.session.cards) {
    console.log(`    [${card.archetype}] ${card.episode_id} — "${card.why_line}"`);
  }
  if (result.droppedDuplicates.length > 0) {
    console.log(`  dropped ${result.droppedDuplicates.length} duplicate candidate(s):`, result.droppedDuplicates);
  }
  if (result.diversity.warnings.length > 0) {
    console.log("  diversity warnings:", result.diversity.warnings);
  } else {
    console.log(
      `  diversity OK: ${result.diversity.distinctShows} shows, ${result.diversity.distinctBranches} taxonomy branches`
    );
  }

  const spentToday = await defaultBudgetGuard.spentToday(SEEDED_USER_ID);
  const allCostEvents = await defaultCostEventSink.all();
  console.log(
    `  cost: $${spentToday.toFixed(4)} spent today across ${allCostEvents.length} LLM call(s) (budget $${env.dailyBudgetUsd.toFixed(2)}/day)`
  );
}

main().catch((err) => {
  console.error("build-session failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
