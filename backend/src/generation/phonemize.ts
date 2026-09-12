import { spawnSync } from "node:child_process";
import path from "node:path";
import { NARRATION_CHARS_PER_SEC } from "../types/narration";
import type { ForayItem, ForayNarrationItem } from "./forayItems";

/**
 * K-02 — PHONEMES ARE AUTHORED WITH THE SCRIPT
 * (`docs/bundled-voice-plan.md` K-02; §4 carries the argument.)
 *
 * The stage that runs after §4.7 "Write the narration" and before §4.9
 * publishes: every narration item gains a `phonemes` string beside its
 * `script`, a `tts` block naming the engine, model and phoneme vocabulary it
 * was written against, and an `est_sec`.
 *
 * WHY THE PIPELINE AND NOT THE PHONE. The app has no text front-end, by
 * design: misaki's out-of-vocabulary fallback is `espeak-ng`, which is GPL-3,
 * and `generation-architecture.md` §1.2.1 already ruled that server-side.
 * Phonemizing here keeps the GPL on our machines, removes a G2P port from two
 * platforms, and makes every render bit-for-bit identical across devices —
 * which restores the review gate `on-device-tts.md` §5 said on-device
 * narration had lost.
 *
 * PER PAGE, NOT PER BEAT. The act-level writer landed on 2026-09-12
 * (`writeAct.ts`, `actSeams.ts`): a page is now a stretch of prose between
 * clips, and a beat is no longer the unit anything downstream carries. This
 * stage phonemizes whatever `toForayItem` emitted as one narration item, which
 * is exactly one page.
 *
 * THE FALLBACKS THE CARD NAMES, in the order they fire:
 *
 *   1. **The phonemizer refuses** (misaki absent, espeak absent, a vocabulary
 *      it cannot report). The item is emitted UNCHANGED — script only, no
 *      `tts` block — and the Foray publishes on the platform-voice path
 *      exactly as it does today. A missing bundled voice must never be able to
 *      stop a Foray from shipping.
 *   2. **One item fails while others succeed.** Only that item loses its `tts`
 *      block. `queue-manager.js` decides per item (K-05), so a Foray may be
 *      half bundled-voice and half system-voice without anything breaking; the
 *      listener hears one notice.
 *   3. **An empty or whitespace-only script.** Nothing to phonemize; emitted
 *      unchanged. `check-forays.mjs` already rejects that item for a better
 *      reason than this stage could give.
 *
 * WHAT IT NEVER DOES: invent a phoneme string. A wrong one is worse than none,
 * because the app's version check (deck §5 item 8) would accept it and every
 * listener would hear the same wrong pronunciation, identically, forever.
 */

/** Where the stage's Python half lives, relative to the repository root. */
export const PHONEMIZER_SCRIPT = path.join("tools", "narration", "phonemize.py");

/** What a phonemizer answers for one script. `null` means "could not" — the
 *  refusal fallback above — and is the ONLY way this module learns that,
 *  because an exception from a subprocess and a missing dictionary entry are
 *  the same fact to a caller: no phonemes for this page. */
export interface Phonemized {
  phonemes: string;
  vocab: string;
  model: string;
}

/** Injected so the whole stage is testable without misaki, a subprocess, or a
 *  network. `runPhonemizer` below is the production implementation. */
export type Phonemizer = (script: string) => Phonemized | null;

/** narration-craft.md §2a's planning rate, imported rather than restated —
 *  `player/foray-queue.js`'s `narrationDuration` estimates from the same
 *  constant, and two clocks here would put the seam maths and the player's
 *  playhead on different ones. */
export function estimateSeconds(script: string): number {
  return Math.round((script.length / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/**
 * One narration item, phonemized — or returned byte-identical when it cannot
 * be.
 *
 * RETURNS THE SAME OBJECT REFERENCE on the fallback path, not a copy. That is
 * deliberate and it is what `phonemizeItems`'s own "nothing changed" claim is
 * asserted on: a stage that rebuilt every item on the way through would make
 * "this Foray was not phonemized" and "this Foray was phonemized identically"
 * indistinguishable in a diff.
 */
export function phonemizeItem(item: ForayNarrationItem, phonemize: Phonemizer): ForayNarrationItem {
  const script = typeof item.script === "string" ? item.script : "";
  if (!script.trim()) return item;
  let out: Phonemized | null = null;
  try {
    out = phonemize(script);
  } catch {
    /* A phonemizer that threw is a phonemizer that refused. The pipeline must
       not lose a written Foray to a missing system package. */
    out = null;
  }
  if (!out || !out.phonemes.trim() || !out.vocab.trim() || !out.model.trim()) return item;
  return {
    ...item,
    phonemes: out.phonemes,
    est_sec: estimateSeconds(script),
    tts: { engine: "kokoro", model: out.model, vocab: out.vocab }
  };
}

/** Every narration item in a mapped Foray. Segment and jingle items pass
 *  through untouched — they carry no script, and a stage that rewrote them
 *  would be a stage that could break tape. */
export function phonemizeItems(items: ForayItem[], phonemize: Phonemizer): ForayItem[] {
  return items.map((item) => (item.type === "narration" ? phonemizeItem(item, phonemize) : item));
}

/** How many items in a mapped Foray came out with a `tts` block. Exposed so
 *  the publish PR can say "31 of 34 pages phonemized" rather than leaving a
 *  partial run to be discovered by a listener. */
export function phonemizedCount(items: ForayItem[]): number {
  return items.filter((i) => i.type === "narration" && (i as ForayNarrationItem).tts !== undefined).length;
}

/**
 * The production phonemizer: one subprocess per Foray, not per page.
 *
 * ONE CALL FOR THE WHOLE FORAY because misaki's model load dominates a short
 * script — a 34-page Foray would otherwise pay that cost 34 times. The script
 * reads `{"items":[{id, script}]}` on `--json` and answers in the same order.
 *
 * NEVER THROWS. A missing interpreter, a missing package, a non-zero exit and
 * unparseable output are all the same fact to the caller — no phonemes — and
 * the caller's fallback is "publish on the platform-voice path", which is what
 * ships today anyway.
 */
export function runPhonemizer(
  scripts: Array<{ id: string; script: string }>,
  { repoRoot = process.cwd(), python = process.env.FORAY_PYTHON || "python3" } = {}
): Map<string, Phonemized> {
  const empty = new Map<string, Phonemized>();
  if (scripts.length === 0) return empty;
  const res = spawnSync(
    python,
    [path.join(repoRoot, PHONEMIZER_SCRIPT), "--json", "-"],
    { cwd: repoRoot, input: JSON.stringify({ items: scripts }), encoding: "utf8" }
  );
  if (res.status !== 0 || !res.stdout) return empty;
  let parsed: { items?: Array<{ id?: string; phonemes?: string; tts?: { model?: string; vocab?: string } }> };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return empty;
  }
  const out = new Map<string, Phonemized>();
  for (const row of parsed.items ?? []) {
    if (!row?.id || !row.phonemes || !row.tts?.model || !row.tts?.vocab) continue;
    out.set(row.id, { phonemes: row.phonemes, model: row.tts.model, vocab: row.tts.vocab });
  }
  return out;
}
