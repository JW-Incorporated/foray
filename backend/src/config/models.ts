/* Loaded for its side effect only: `env.ts` is what calls `dotenv.config()`
   on the repo-root `.env`, and this module reads `process.env` at import
   time. Importing it here means a `FORAY_MODEL_*` override in `.env` works
   the same way `ANTHROPIC_API_KEY` does, regardless of which module the
   process happened to import first. */
import "./env";

/**
 * The ONE place a Claude model id is written down (generation run 2026-09-09,
 * finding F-03).
 *
 * WHY THIS FILE EXISTS. Every `Anthropic*Builder.ts` in `src/generation/`
 * declared its own `const MODEL = "..."` next to its own cost constants —
 * seven copies of three ids. Run 1 found all seven still pinned to the
 * previous generation (`claude-opus-4-1`, `claude-sonnet-4-5`,
 * `claude-haiku-4-5`): a production run would have been paying for and
 * reasoning with superseded models, and nothing in the repo made that visible
 * because no single file said "these are the models we use". Seven copies also
 * means an upgrade is seven edits, which is how the drift happened in the
 * first place.
 *
 * TIERS, NOT NAMES, ARE WHAT THE PIPELINE PICKS. A builder asks for the tier
 * its stage needs — the spine is the one call §4.3 calls "the single most
 * consequential" and takes `opus`; per-act and per-page work takes `sonnet`;
 * the two short §4.1/§4.2 calls take `haiku` — and this map resolves the tier
 * to an id. Changing which model serves a tier is then one edit here (or one
 * environment variable), and the *choice of tier* stays where it belongs, in
 * the stage that made it.
 *
 * COSTS LIVE NEXT TO THE IDS, deliberately. `BudgetGuard` meters an estimate
 * before every call, and that estimate is only as honest as its per-token
 * rates. When those rates lived beside a hardcoded id in seven files, an id
 * change and a rate change were two independent edits that could — and, before
 * this file, did — disagree. Here they cannot: `modelFor(tier)` and
 * `costFor(tier)` read the same row.
 *
 * OVERRIDABLE BY ENV, so a run can pin an older or a dated snapshot id without
 * a code change: `FORAY_MODEL_OPUS`, `FORAY_MODEL_SONNET`, `FORAY_MODEL_HAIKU`.
 * An override changes the id only — NOT the price. That is on purpose: the
 * guard would rather over-estimate spend against a cheaper substituted model
 * than under-estimate it against a more expensive one, and a wrong cheap
 * estimate is the failure mode that lets a run blow its ceiling silently.
 * Override the matching `FORAY_MODEL_*_USD_PER_MTOK_IN`/`_OUT` alongside it
 * when the substituted model's price differs and the estimate matters.
 */

export type ModelTier = "opus" | "sonnet" | "haiku";

export const MODEL_TIERS: readonly ModelTier[] = ["opus", "sonnet", "haiku"] as const;

/**
 * Defaults: the current Claude 5 family (2026-09). `haiku` is pinned to a
 * DATED snapshot because it is the only tier of the three whose alias still
 * resolves to a 4.x model — pinning the snapshot makes "this is deliberately
 * last-generation, not stale" reviewable, which is exactly what F-03 found
 * missing.
 */
const DEFAULT_MODEL_IDS: Record<ModelTier, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001"
};

/** Published per-million-token list prices for the default id of each tier. */
const DEFAULT_USD_PER_MTOK: Record<ModelTier, { input: number; output: number }> = {
  opus: { input: 5.0, output: 25.0 },
  sonnet: { input: 2.0, output: 10.0 },
  haiku: { input: 1.0, output: 5.0 }
};

/**
 * Anthropic's server-side `web_search` tool bills per search on top of tokens.
 * Lives here rather than in `AnthropicExternalResearcher.ts` for the same
 * reason the token rates do: it is a price, and prices belong beside the ids
 * they are attached to.
 */
export const USD_PER_WEB_SEARCH = 0.01;

export interface ModelCost {
  usdPerInputToken: number;
  usdPerOutputToken: number;
}

const ENV_ID_VAR: Record<ModelTier, string> = {
  opus: "FORAY_MODEL_OPUS",
  sonnet: "FORAY_MODEL_SONNET",
  haiku: "FORAY_MODEL_HAIKU"
};

function readNonEmpty(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readPositiveNumber(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readNonEmpty(source, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  /* A malformed price falls back rather than throwing: a bad rate makes the
     budget estimate wrong, and the published default is a far better guess
     than zero — which is what `Number("")`/`Number("abc")` would otherwise
     hand the guard, silently disabling it. */
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Pure resolver, exported so a test can drive it without mutating the process. */
export function resolveModelId(tier: ModelTier, source: NodeJS.ProcessEnv = process.env): string {
  return readNonEmpty(source, ENV_ID_VAR[tier]) ?? DEFAULT_MODEL_IDS[tier];
}

/** Pure resolver, exported for the same reason as `resolveModelId`. */
export function resolveModelCost(tier: ModelTier, source: NodeJS.ProcessEnv = process.env): ModelCost {
  const upper = tier.toUpperCase();
  const inPerMtok = readPositiveNumber(source, `FORAY_MODEL_${upper}_USD_PER_MTOK_IN`, DEFAULT_USD_PER_MTOK[tier].input);
  const outPerMtok = readPositiveNumber(source, `FORAY_MODEL_${upper}_USD_PER_MTOK_OUT`, DEFAULT_USD_PER_MTOK[tier].output);
  return { usdPerInputToken: inPerMtok / 1_000_000, usdPerOutputToken: outPerMtok / 1_000_000 };
}

/** Frozen at import so every builder in one process agrees on the same map. */
export const MODEL_IDS: Readonly<Record<ModelTier, string>> = Object.freeze({
  opus: resolveModelId("opus"),
  sonnet: resolveModelId("sonnet"),
  haiku: resolveModelId("haiku")
});

export const MODEL_COSTS: Readonly<Record<ModelTier, ModelCost>> = Object.freeze({
  opus: resolveModelCost("opus"),
  sonnet: resolveModelCost("sonnet"),
  haiku: resolveModelCost("haiku")
});

/** The model id a builder should send for its tier. */
export function modelFor(tier: ModelTier): string {
  return MODEL_IDS[tier];
}

/** The per-token rates `BudgetGuard` should be given for that same call. */
export function costFor(tier: ModelTier): ModelCost {
  return MODEL_COSTS[tier];
}

/** Safe-for-logs: ids only, never keys. Printed by the batch driver so a run's
 * log records which models it actually used rather than which ones the code
 * was written against. */
export function modelSummary(): Record<ModelTier, string> {
  return { ...MODEL_IDS };
}
