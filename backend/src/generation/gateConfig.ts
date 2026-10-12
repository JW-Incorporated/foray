import { readFlag, type FlagParser, type FlagSource } from "./generationFlags";

/**
 * GV-15 (docs/roadmap/generation-v2.md, W5-02): the gate configuration.
 *
 * IT STARTS EMPTY ON PURPOSE. Each gate card adds its own key to `GateConfig`
 * and its own row to `GATE_TABLE` (key, env var, parser, default) in the same
 * PR as the behaviour and the test behind it, so no gate flag ever exists
 * without a gate, and this card does not track the others. The planned keys
 * and their owning cards are listed in docs/curation/generation-architecture.md
 * §12.
 *
 * NO STAGE MODULE READS process.env FOR A GATE. `runForayPipeline` resolves
 * the config once per run (`RunPipelineOptions.gates` over
 * `readGateConfig()`), and each gate card threads its own key into the stage
 * options that need it (decision 34).
 *
 * Read at call time through `generationFlags.ts` (decision 5): a malformed
 * value throws naming the variable, never its value.
 */

/* Each gate card adds `key: Type` here. Empty until the first one lands. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- see above: gate cards add the keys.
export interface GateConfig {}

/** One row of the declarative table. */
export interface GateTableEntry<T = unknown> {
  key: string;
  env: string;
  parse: FlagParser<T>;
  default: T;
}

/**
 * Builds a table, refusing a key or an env name used twice: two rows for one
 * variable would make the later row silently shadow the earlier one.
 */
export function defineGateTable(entries: readonly GateTableEntry[]): readonly GateTableEntry[] {
  const keys = new Set<string>();
  const envs = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new Error(`gate table: duplicate key ${entry.key}`);
    if (envs.has(entry.env)) throw new Error(`gate table: duplicate env name ${entry.env}`);
    keys.add(entry.key);
    envs.add(entry.env);
  }
  return Object.freeze([...entries]);
}

/** The gate table. Each gate card appends its row. */
export const GATE_TABLE: readonly GateTableEntry[] = defineGateTable([]);

/**
 * The gate config in force for `source`. Pure: reads only `source`, and only
 * when called. An unset variable gives the row's default.
 */
export function readGateConfig(source: FlagSource = process.env, table: readonly GateTableEntry[] = GATE_TABLE): GateConfig {
  const config: Record<string, unknown> = {};
  for (const entry of table) config[entry.key] = readFlag(entry.env, entry.parse, entry.default, source);
  return config as GateConfig;
}

/** `overrides` over `readGateConfig()`, once per run. */
export function resolveGateConfig(overrides: Partial<GateConfig> = {}, source: FlagSource = process.env): GateConfig {
  const merged: Record<string, unknown> = { ...readGateConfig(source) };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) merged[key] = value;
  return merged as GateConfig;
}
