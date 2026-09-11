/**
 * WS-B (docs/curation/generation-fix-plan-2026-09-09.md): `pipelineTokens`
 * needs the sum of `usage` off EVERY model reply across every stage of one
 * pipeline run (§4.0-4.9), and those replies are produced by seven
 * different `Anthropic*Builder` classes, called from seven different
 * stages, most of which have no other reason to talk to each other. A
 * module-level collector — record on the way out of every real API call,
 * read once at the end of `runForayPipeline` — is the option the fix plan
 * itself names ("thread a usage counter through the builders' ctx or a
 * module-level collector") and the cheaper of the two: threading a counter
 * through `ctx` would touch every builder interface's signature (`ctx` is
 * shared, read-only-by-convention context, not an output channel), where
 * this only touches each builder's call site with one line.
 *
 * HONEST LIMITATION, STATED RATHER THAN HIDDEN: this is ONE counter for
 * the WHOLE PROCESS, not one per pipeline run. That is correct today —
 * `generateForays.ts`'s batch loop runs one Foray's pipeline to
 * completion before starting the next (see that file's own `for` loop),
 * so `resetUsageTracking()` at the top of `runForayPipeline` and
 * `getUsageTotals()` at the bottom bracket exactly one run's calls. It
 * stops being correct the day two pipeline runs execute concurrently in
 * one process (§6's future progressive-generation system, or a
 * parallelised WS-D) — at that point this collector needs to become
 * per-run (an instance passed through `ctx`, or `AsyncLocalStorage`), and
 * whoever builds that concurrency should see this comment before they
 * ship a metric that silently sums two Forays' tokens into one.
 */

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  total: number;
}

/** The subset of the Anthropic SDK's `Message.usage` shape this module
 * cares about — kept narrow and structural (not importing the SDK's own
 * type) so any Anthropic* builder can pass its `response.usage` straight
 * through without an import cycle back into this module. */
export interface RecordableUsage {
  input_tokens?: number;
  output_tokens?: number;
}

let totalInputTokens = 0;
let totalOutputTokens = 0;

/** Called once, right after every real `client.messages.create(...)` in
 * every `Anthropic*Builder`. Tolerant of `undefined`/partial usage so a
 * future SDK response shape change degrades to under-counting rather than
 * throwing mid-pipeline. */
export function recordUsage(usage: RecordableUsage | null | undefined): void {
  if (!usage) return;
  if (typeof usage.input_tokens === "number") totalInputTokens += usage.input_tokens;
  if (typeof usage.output_tokens === "number") totalOutputTokens += usage.output_tokens;
}

/** Call at the start of a pipeline run — see the module doc comment's
 * limitation note on why this only brackets ONE run at a time. */
export function resetUsageTracking(): void {
  totalInputTokens = 0;
  totalOutputTokens = 0;
}

export function getUsageTotals(): TokenUsageTotals {
  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    total: totalInputTokens + totalOutputTokens
  };
}
