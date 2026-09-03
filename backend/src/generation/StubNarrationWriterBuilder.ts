import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { Voice } from "../types/spine";
import { MODE_CHAR_BANDS, type PronunciationHint, type Source } from "../types/narration";
import type { NarrationBuildContext, NarrationWriteRequest, NarrationWriteResult, NarrationWriterBuilder } from "./NarrationWriterBuilder";

/**
 * Deterministic fake narration writer, used whenever ANTHROPIC_API_KEY is
 * absent (env.anthropicDryRun) — same role as StubSpineBuilder /
 * StubDeepenActBuilder: zero API keys, zero network calls, reproducible
 * fixtures that land INSIDE the requested mode's character band (§0) and
 * carry at least one source for Patch/Carry.
 *
 * A fixture generator, not a content-quality stand-in — the real
 * provider (AnthropicNarrationWriterBuilder) does the actual prose
 * judgement §4.7 asks for.
 */
export class StubNarrationWriterBuilder implements NarrationWriterBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async writePage(request: NarrationWriteRequest, ctx: NarrationBuildContext): Promise<NarrationWriteResult> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_write",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const [min, max] = MODE_CHAR_BANDS[request.mode];
    const target = Math.round((min + max) / 2);
    const script = padToBand(scriptSeedSentence(request), min, max, target, request.mode);

    const needsSource = request.mode === "Patch" || request.mode === "Carry";
    const sources: Source[] = needsSource
      ? [
          {
            claimText: request.claim,
            quote: `Verbatim span standing in for the claim: "${request.claim}"`,
            publication: "Stub source (dry-run — no ANTHROPIC_API_KEY configured)",
            contested: false
          }
        ]
      : [];

    const pronunciationHints: PronunciationHint[] = hardWordsIn(request.claim).map((word) => ({
      word,
      hint: `Say "${word}" as spelled — no override configured (stub fixture).`
    }));

    return { script, sources, pronunciationHints };
  }
}

function scriptSeedSentence(request: NarrationWriteRequest): string {
  const modeVerb: Record<string, string> = {
    Hinge: "closes what just played and opens",
    Frame: "sets up",
    Marker: "announces a turn in",
    Correction: "bounds a claim in",
    Patch: "supplies the missing part of",
    Carry: "carries"
  };
  const verb = modeVerb[request.mode] ?? "addresses";
  return `In the voice of a ${request.voice.register.toLowerCase()}, this line ${verb} the idea that ${lowerFirst(request.claim)}`;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

/** Repeats a deterministic filler clause (never a banned word, never a
 * digit, never a URL/citation token) until the script sits inside
 * [min, max] characters, then trims to `target` if it overshot on the
 * final repeat. Reproducible per-request via a seeded PRNG-free hash of
 * the claim text, not randomness — a stub must be reproducible across
 * runs (`AnthropicNarrationWriterBuilder`'s doc comment on this same
 * discipline). */
function padToBand(seed: string, min: number, max: number, target: number, mode: string): string {
  const fillers = [
    "That thread runs further than most listeners expect.",
    "It is worth sitting with before moving on.",
    "The record on this is more solid than the popular version suggests.",
    "Nothing about that was inevitable at the time.",
    "The people closest to it saw it differently.",
    "That detail is easy to miss and easy to underrate."
  ];
  let out = seed.trim();
  if (!out.endsWith(".")) out += ".";
  let i = hashToInt(`${seed}::${mode}`) % fillers.length;
  while (out.length < min) {
    out += ` ${fillers[i % fillers.length]}`;
    i += 1;
  }
  if (out.length > max) {
    // Trim on a sentence boundary at or before `target`/`max`, never
    // mid-word — a script a listener will hear must end on a real
    // sentence, not a truncated clause.
    const cutoff = Math.min(max, Math.max(target, min));
    const truncated = out.slice(0, cutoff);
    const lastPeriod = truncated.lastIndexOf(".");
    out = lastPeriod > min ? truncated.slice(0, lastPeriod + 1) : truncated;
  }
  return out;
}

function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}

/** Very small heuristic for "words worth a pronunciation hint": long,
 * capitalized (proper-noun-shaped) tokens, since the stub has no real
 * hard/foreign-word detector — the real provider is expected to use
 * editorial judgement here, not a heuristic. Kept intentionally simple:
 * this stage only needs the FIELD to exist (§4.7's "carry the hint field
 * in the data shape... even though nothing consumes it yet"), not a
 * correct pronunciation system. */
function hardWordsIn(claim: string): string[] {
  const words = claim.match(/[A-Za-z][A-Za-z'-]{6,}/g) ?? [];
  const capitalized = words.filter((w) => /^[A-Z]/.test(w) && w.toLowerCase() !== w);
  return [...new Set(capitalized)].slice(0, 2);
}
