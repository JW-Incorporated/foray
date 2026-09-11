import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { z } from "zod";

/**
 * Central env access. Loads the repo-root `.env` (one level up from backend/)
 * so the single .env file described in the project brief is the source of
 * truth for both local dev and any future process.
 *
 * IMPORTANT: never log the *values* read here. Logging which keys are
 * present/absent (booleans) is fine and is how the rest of the codebase
 * decides whether to run in dry-run/stub mode.
 */

const REPO_ROOT_ENV = path.resolve(__dirname, "..", "..", "..", ".env");
const BACKEND_LOCAL_ENV = path.resolve(__dirname, "..", "..", ".env");

// Load repo-root .env first (primary per project brief), then allow an
// optional backend/.env.local to override for local-only experimentation.
// Neither file is required to exist — everything below degrades gracefully.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- REPO_ROOT_ENV is a hardcoded path built from __dirname; not external input.
if (fs.existsSync(REPO_ROOT_ENV)) {
  dotenv.config({ path: REPO_ROOT_ENV });
}
// eslint-disable-next-line security/detect-non-literal-fs-filename -- BACKEND_LOCAL_ENV is a hardcoded path built from __dirname; not external input.
if (fs.existsSync(BACKEND_LOCAL_ENV)) {
  dotenv.config({ path: BACKEND_LOCAL_ENV, override: true });
}

function readString(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/* Unvalidated numeric read with a silent fallback. This branch had removed
 * it (readBoundedNumber replaced its only caller), but main added a new one
 * for EPISODE_BUDGET_USD while this PR was open, so it is restored verbatim
 * rather than either side being changed. EPISODE_BUDGET_USD therefore still
 * has exactly the lenient parsing this PR fixes for DAILY_BUDGET_USD — a
 * deliberate scope boundary, not an oversight: picking its upper bound is a
 * spend-control call, not a merge decision. Follow-up, not this PR. */
function readNumber(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Upper bound for DAILY_BUDGET_USD. This is a spend-control cap, not a
 * technical limit — anything above this is almost certainly a typo (e.g. a
 * missing decimal point) and must fail startup rather than silently letting
 * every paid operation run unmetered.
 */
const MAX_DAILY_BUDGET_USD = 1000;

/**
 * WHAT ONE MEDIUM FORAY COSTS, and therefore what these two defaults have to
 * be (generation run 2026-09-09, finding F-04 / intervention I-01).
 *
 * `DAILY_BUDGET_USD` defaulted to $2.00 — a number chosen for the ENRICHMENT
 * pipeline (tier-1 Haiku classification of feed episodes) before the §4
 * generation pipeline existed. Run 1 could only be started at all by setting
 * `DAILY_BUDGET_USD=1000 EPISODE_BUDGET_USD=1000` in the environment; on the
 * shipped default the guard would have halted the run inside Act 1, and the
 * run log recorded that as an intervention rather than a fix.
 *
 * The arithmetic, from the builders' OWN per-call estimates — every
 * `Anthropic*Builder` meters `estimatedInputTokens * in + MAX_OUTPUT_TOKENS *
 * out` before it calls, so these are the numbers the guard actually compares
 * against, not a separate model of them. Rates from `config/models.ts`
 * (opus $5/$25, sonnet $2/$10, haiku $1/$5 per MTok). A medium Foray is §3's
 * "proven shape": 3-4 acts, 5-7 slots, 28-36 beats.
 *
 *   §4.1 understand      2 haiku  (~500 in, 200/400 out max)      ≈ $0.004
 *   §4.2 research        ≤3 haiku web-search calls
 *                        (3 searches @ $0.01 + 800 out max each)  ≈ $0.104
 *   §4.3 spine           1 opus   (~3,000 in, 8,000 out max)      ≈ $0.215
 *   §4.4 deepen          4 sonnet (~4,000 in, 4,000 out max)      ≈ $0.192
 *   §4.7 narrate         36 beats x 2 writer  (2,000 out max)
 *                              + 2 verifier (1,000 out max)       ≈ $2.808
 *   §4.8 continuity      3 sonnet (~1,500 in, 500 out max)        ≈ $0.024
 *                                                          total  ≈ $3.35
 *
 * Two things that estimate deliberately does NOT do. It does not assume the
 * ≤1.5-calls-per-beat target the fix plan is aiming at — it assumes FOUR
 * narration calls per beat, close to run 1's measured 4.2, because a budget
 * sized for the target stops every run until the target is met. And it bills
 * `max_tokens` rather than tokens actually produced, exactly as the guard
 * does, so real spend lands well under it.
 *
 * `EPISODE_BUDGET_USD` stays at $10.00: the top of §9.2's founder-approved
 * ~$5-10/Foray phase-1 range, and ~3x the estimate above, which is the
 * headroom a retry-heavy Foray needs before a human should be told to look.
 *
 * `DAILY_BUDGET_USD` becomes $25.00 — two-and-a-half Forays at the per-Foray
 * ceiling, leaving room for the enrichment pipeline's own tier-1/tier-2 spend
 * on the same day. It MUST be at least the per-Foray ceiling: generation calls
 * are not tier-prefixed, so `BudgetGuard` scores them tier 1, whose cutoff is
 * the full daily budget; a daily cap below the episode cap would make the
 * episode cap unreachable and stop every run at the daily one instead.
 */
const DEFAULT_DAILY_BUDGET_USD = 25.0;
const DEFAULT_EPISODE_BUDGET_USD = 10.0;

const dailyBudgetSchema = z
  .number({ invalid_type_error: "DAILY_BUDGET_USD" })
  .finite({ message: "DAILY_BUDGET_USD" })
  .nonnegative({ message: "DAILY_BUDGET_USD" })
  .max(MAX_DAILY_BUDGET_USD, { message: "DAILY_BUDGET_USD" });

/**
 * Reads a required, schema-validated numeric budget/spend-control value.
 *
 * Unlike a generic "read with fallback", this never silently substitutes a
 * default for malformed input: a genuinely *unset* variable uses `fallback`,
 * but a variable that is present — including an empty/whitespace-only string
 * — and fails the schema (negative, NaN, empty, or over the configured max)
 * throws and fails startup fast. The error message names only the variable
 * NAME — never the offending value — per this file's never-log-values
 * convention.
 */
function readBoundedNumber(name: string, fallback: number, schema: z.ZodNumber): number {
  const present = process.env[name];
  if (present === undefined) return fallback;
  const raw = present.trim();
  const n = raw.length === 0 ? NaN : Number(raw);
  const result = schema.safeParse(n);
  if (!result.success) {
    throw new Error(`Invalid value for environment variable ${name}`);
  }
  return result.data;
}

export interface Env {
  anthropicApiKey: string | undefined;
  podcastIndexApiKey: string | undefined;
  podcastIndexApiSecret: string | undefined;
  dailyBudgetUsd: number;
  /**
   * Per-Foray (per-generation-episode) spend ceiling (docs/curation/
   * generation-architecture.md §9.2, founder decision 2026-08-31: "Set
   * generous now (~$5-10/Foray)"). Defaults to the top of that
   * founder-approved range. Enforced by BudgetGuard.checkAndRecord only
   * when a caller passes an episodeId/sessionId — purely additive, does
   * not change behavior for callers that don't scope by episode.
   */
  episodeBudgetUsd: number;
  databaseUrl: string | undefined;
  userAgent: string;
  /** true when no ANTHROPIC_API_KEY is configured -> StubEnricher must be used */
  readonly anthropicDryRun: boolean;
  /** true when no Podcast Index credentials configured -> client runs dry-run */
  readonly podcastIndexDryRun: boolean;
}

export const env: Env = {
  anthropicApiKey: readString("ANTHROPIC_API_KEY"),
  podcastIndexApiKey: readString("PODCASTINDEX_API_KEY"),
  podcastIndexApiSecret: readString("PODCASTINDEX_API_SECRET"),
  dailyBudgetUsd: readBoundedNumber("DAILY_BUDGET_USD", DEFAULT_DAILY_BUDGET_USD, dailyBudgetSchema),
  episodeBudgetUsd: readNumber("EPISODE_BUDGET_USD", DEFAULT_EPISODE_BUDGET_USD),
  databaseUrl: readString("DATABASE_URL"),
  userAgent: "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)",
  get anthropicDryRun(): boolean {
    return this.anthropicApiKey === undefined;
  },
  get podcastIndexDryRun(): boolean {
    return this.podcastIndexApiKey === undefined || this.podcastIndexApiSecret === undefined;
  }
};

/** Safe-for-logs summary — booleans only, never raw values. */
export function envPresenceSummary(): Record<string, boolean | number> {
  return {
    anthropicApiKeyPresent: env.anthropicApiKey !== undefined,
    podcastIndexKeyPresent: env.podcastIndexApiKey !== undefined,
    podcastIndexSecretPresent: env.podcastIndexApiSecret !== undefined,
    databaseUrlPresent: env.databaseUrl !== undefined,
    dailyBudgetUsd: env.dailyBudgetUsd
  };
}
