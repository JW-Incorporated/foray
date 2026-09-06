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
  dailyBudgetUsd: readBoundedNumber("DAILY_BUDGET_USD", 2.0, dailyBudgetSchema),
  episodeBudgetUsd: readNumber("EPISODE_BUDGET_USD", 10.0),
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
