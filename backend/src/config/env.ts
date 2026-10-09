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

/** Reads a variable, trimmed; empty or whitespace-only counts as unset.
 * Exported so `models.ts` reads its overrides by the same rule (`source` is
 * there for its pure resolvers, which a test drives without the process). */
export function readString(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = source[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Upper bound for both budget variables (RUN_BUDGET_USD, EPISODE_BUDGET_USD).
 * This is a spend-control cap, not a technical limit — anything above this is
 * almost certainly a typo (e.g. a missing decimal point) and must fail startup
 * rather than silently letting every paid operation run unmetered.
 */
const MAX_BUDGET_USD = 1000;

/**
 * WHAT ONE MEDIUM FORAY COSTS, and therefore what these two defaults have to
 * be (generation run 2026-09-09, finding F-04 / intervention I-01).
 *
 * The process cap (then `DAILY_BUDGET_USD`, now `RUN_BUDGET_USD`) defaulted
 * to $2.00 — a number chosen for the ENRICHMENT pipeline (tier-1 Haiku classification of feed episodes) before the §4
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
 * `RUN_BUDGET_USD` is $25.00 — two-and-a-half Forays at the per-Foray ceiling.
 * It MUST be at least the per-Foray ceiling: every metered call is compared
 * against the whole run budget, so a run cap below the episode cap would make
 * the episode cap unreachable and stop every run at the run cap instead.
 *
 * WHAT "RUN" MEANS (CH2-04, docs/DECISIONS.md 2026-10-07). It is the total
 * THIS PROCESS may spend. The cost sink is in memory and nothing persists it,
 * so there is no day window to reset and no second process to share with: a
 * re-run in a fresh process starts at $0 again. The variable used to be called
 * `DAILY_BUDGET_USD`, which promised a per-day cap the code never had; that
 * name is still read as a deprecated alias (see `readRunBudget`).
 */
const DEFAULT_RUN_BUDGET_USD = 25.0;
const DEFAULT_EPISODE_BUDGET_USD = 10.0;

/** The one schema both budget variables are read through; `name` labels the
 * zod issues (the thrown error names the variable separately, never the value). */
function budgetSchema(name: string): z.ZodNumber {
  return z
    .number({ invalid_type_error: name })
    .finite({ message: name })
    .nonnegative({ message: name })
    .max(MAX_BUDGET_USD, { message: name });
}

/**
 * The variable `RUN_BUDGET_USD` replaced, kept as a DEPRECATED ALIAS so an
 * operator's existing `.env` keeps working (CH2-04, docs/DECISIONS.md
 * 2026-10-07):
 *
 *   - only `DAILY_BUDGET_USD` set  -> its value is the run cap, read through
 *     the same bounded schema (a malformed value fails startup naming
 *     `DAILY_BUDGET_USD`), and ONE deprecation warning names `RUN_BUDGET_USD`;
 *   - both set to the same number -> that number, and the same one warning;
 *   - both set and they differ     -> startup fails naming both variables,
 *     because there is no safe way to guess which cap the operator meant;
 *   - only `RUN_BUDGET_USD` set, or neither -> the alias plays no part.
 *
 * "The same number" compares the parsed values, so `25` and `25.0` agree. The
 * warning and the error name variables only, never a value (this file's
 * never-log-values convention). The warning is printed once because this
 * module is evaluated once per process.
 */
const LEGACY_RUN_BUDGET_VAR = "DAILY_BUDGET_USD";

export const RUN_BUDGET_DEPRECATION_WARNING =
  `${LEGACY_RUN_BUDGET_VAR} is deprecated: rename it to RUN_BUDGET_USD in your .env. ` +
  "The cap is what one process may spend, not a per-day budget (docs/DECISIONS.md 2026-10-07).";

function readRunBudget(): number {
  const schema = budgetSchema("RUN_BUDGET_USD");
  const legacySet = process.env[LEGACY_RUN_BUDGET_VAR] !== undefined;
  if (!legacySet) return readBoundedNumber("RUN_BUDGET_USD", DEFAULT_RUN_BUDGET_USD, schema);

  const legacy = readBoundedNumber(LEGACY_RUN_BUDGET_VAR, DEFAULT_RUN_BUDGET_USD, budgetSchema(LEGACY_RUN_BUDGET_VAR));
  if (process.env.RUN_BUDGET_USD !== undefined) {
    const current = readBoundedNumber("RUN_BUDGET_USD", DEFAULT_RUN_BUDGET_USD, schema);
    if (current !== legacy) {
      throw new Error(
        `RUN_BUDGET_USD and ${LEGACY_RUN_BUDGET_VAR} are both set and differ. ${LEGACY_RUN_BUDGET_VAR} is the ` +
          "deprecated name of RUN_BUDGET_USD: delete it from your .env and keep the cap you mean in RUN_BUDGET_USD."
      );
    }
    console.warn(RUN_BUDGET_DEPRECATION_WARNING);
    return current;
  }
  console.warn(RUN_BUDGET_DEPRECATION_WARNING);
  return legacy;
}

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
  /** What this process may spend in total (`RUN_BUDGET_USD`). Per-process by
   * design — see the defaults note above. */
  runBudgetUsd: number;
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
  runBudgetUsd: readRunBudget(),
  episodeBudgetUsd: readBoundedNumber("EPISODE_BUDGET_USD", DEFAULT_EPISODE_BUDGET_USD, budgetSchema("EPISODE_BUDGET_USD")),
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
    runBudgetUsd: env.runBudgetUsd,
    episodeBudgetUsd: env.episodeBudgetUsd
  };
}
