import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { readEnumFlag, type FlagSource } from "./generationFlags";
import type { PromptParts } from "./promptLayout";

/**
 * GV-99 (docs/roadmap/generation-v2.md, #1286; from W7-06, covers R2-17): the
 * founder-selected voice card and exemplar seams, rendered into ONE fixed
 * block at the end of the Qwen writer's `stable` part (the voice slot GV-50
 * left in prompts/actWrite.ts), behind FORAY_WRITER_EXEMPLARS (default off).
 *
 * WHY THE STATIC PREFIX. The block pins the voice and is the same for every
 * act, round and Foray, so it belongs where the rules are: in the system
 * message the Spark's radix cache already holds after the first writer call
 * (promptLayout.ts). Nothing per-run is printed: no ids, no dates, no Foray
 * id, no act title, no selection metadata.
 *
 * DECISION 17. No voice card or exemplar ships unconditionally: the only
 * source is tools/generation/exemplars/narration-exemplars.json, written by
 * GV-42's selector (mine-exemplars.mjs `--select`) after the founder's listen.
 * The committed file is empty until then, so even with the flag on the
 * writer prompt is byte-identical to the prompt without this card, and the
 * report row says the lever was `unavailable`.
 *
 * NOT A SOURCE. The exemplars are style only. They are never in
 * `request.documents`, so a quote copied from one is refused by the quote
 * gate like any other quote of a document the act does not hold
 * (writeAct.ts `gateSeamClaims`); the block says so to the model too.
 *
 * The Anthropic writer (buildActWritePrompt) never carries the block.
 */

/** The flag (decision 17), read at call time through generationFlags. */
export const WRITER_EXEMPLARS_ENV = "FORAY_WRITER_EXEMPLARS";
export const WRITER_EXEMPLARS_MODES = ["off", "on"] as const;
export type WriterExemplarsMode = (typeof WRITER_EXEMPLARS_MODES)[number];

/** The repository root (backend/src/generation -> three levels up). */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The founder-selected file, relative to the repository root (GV-42's
 * `EXEMPLARS_FILE`). */
export const VOICE_EXEMPLARS_REL = path.join("tools", "generation", "exemplars", "narration-exemplars.json");

/* The selector's limits (mine-exemplars.mjs: MAX_EXEMPLARS,
   VOICE_CARD_MAX_WORDS, ROLES, PROVENANCE, SOURCE_KIND, DATE_RE). */
export const MAX_EXEMPLARS = 2;
export const VOICE_CARD_MAX_WORDS = 60;
const ROLES = ["act-introduction", "full-intro", "bridge", "act-exit"] as const;
const PROVENANCES = ["claude-pipeline-historic", "qwen-pipeline"] as const;
const SOURCE_KINDS = ["committed", "candidate"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

/** One selected seam, as `selectExemplars` writes it. selectedBy and
 * listenedOn are the founder's listen: an exemplar without them was never
 * selected and is refused. */
export const VoiceExemplarSchema = z.object({
  role: z.enum(ROLES),
  text: nonBlank,
  forayId: nonBlank,
  itemIds: z.array(nonBlank).min(1),
  sourceKind: z.enum(SOURCE_KINDS),
  provenance: z.enum(PROVENANCES),
  selectedBy: nonBlank,
  listenedOn: z.string().regex(DATE_RE)
});

/** narration-exemplars.json (GV-42's file; `exemplarsFileProblems` is the
 * selector's side of the same rules). */
export const VoiceExemplarsFileSchema = z.object({
  version: z.literal(1),
  voiceCard: z
    .object({ text: nonBlank, words: z.number().int().positive() })
    .refine((card) => wordCount(card.text) <= VOICE_CARD_MAX_WORDS, `the voice card is over ${VOICE_CARD_MAX_WORDS} words`)
    .refine((card) => card.words === wordCount(card.text), "voiceCard.words is not the text's word count")
    .nullable(),
  exemplars: z.array(VoiceExemplarSchema).max(MAX_EXEMPLARS)
});

export type VoiceExemplar = z.infer<typeof VoiceExemplarSchema>;
export type VoiceExemplarsFile = z.infer<typeof VoiceExemplarsFileSchema>;

/** A usable file and the hash of its bytes (line endings normalised to LF, so
 * a CRLF checkout of the same commit hashes the same). */
export interface LoadedVoiceExemplars {
  file: VoiceExemplarsFile;
  fileSha: string;
}

/** What the report row records under `levers.exemplars` (the swap runner's
 * E3 expectation, tools/generation-bench/swap-experiment.mjs). `on`: the
 * block was in the writer's prefix, built from these exemplars (the
 * selector's run ids, `<forayId>:<first itemId>`) and this file. `unavailable`:
 * the flag was on but the file is missing, empty, invalid or unselected, so
 * the prompt carried nothing. Absent from the row when the flag is off. */
export interface ExemplarsLever {
  mode: "on" | "unavailable";
  exemplarIds: string[];
  fileSha: string | null;
}

const cache = new Map<string, LoadedVoiceExemplars | null>();

/** FORAY_WRITER_EXEMPLARS: `off` (default) or `on`; any other value throws
 * naming only the variable (generationFlags.readEnumFlag). */
export function writerExemplarsMode(source: FlagSource = process.env): WriterExemplarsMode {
  return readEnumFlag(WRITER_EXEMPLARS_ENV, WRITER_EXEMPLARS_MODES, "off", source);
}

/**
 * The founder-selected file under `root`, read once per process and root (the
 * loadSegmentPool pattern, segmentPoolLookup.ts). Null, logged once, for a
 * missing, unreadable, empty (no voice card and no exemplar) or invalid file,
 * including one whose exemplars lack selectedBy / listenedOn.
 */
export function loadVoiceExemplars(root: string = REPO_ROOT): LoadedVoiceExemplars | null {
  const file = path.resolve(root, VOICE_EXEMPLARS_REL);
  if (cache.has(file)) return cache.get(file)!;
  const loaded = readVoiceExemplars(file);
  cache.set(file, loaded);
  return loaded;
}

/** Forget every cached read (tests; a long-lived process never needs it). */
export function clearVoiceExemplarsCache(): void {
  cache.clear();
}

function readVoiceExemplars(file: string): LoadedVoiceExemplars | null {
  const skip = (why: string): null => {
    console.warn(`voiceExemplars: ${why}; the writer's voice slot stays empty`);
    return null;
  };
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed repo-relative path under a caller-given root, not external input.
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return skip(`no exemplar file at ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return skip(`${file} is not JSON`);
  }
  const parsed = VoiceExemplarsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return skip(`${file} fails the exemplar schema (${issue ? `${issue.path.join(".") || "$"}: ${issue.message}` : "invalid"})`);
  }
  if (parsed.data.voiceCard === null && parsed.data.exemplars.length === 0) return skip(`${file} holds no founder-selected voice card or exemplar`);
  return { file: parsed.data, fileSha: createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex") };
}

/** The mode-gated read the writer prompt uses: null when the flag is off
 * (the file is not even read) or the file is not usable. */
export function writerVoiceExemplars(source: FlagSource = process.env, root?: string): LoadedVoiceExemplars | null {
  return writerExemplarsMode(source) === "on" ? loadVoiceExemplars(root) : null;
}

/** The block's last line: a fixed separator, restating that the examples are
 * not documents. */
export const VOICE_BLOCK_END = "END OF THE VOICE EXAMPLES. Their words are not documents: never quote or cite them.";

/**
 * The voice block: 'VOICE CARD' and the card's text, then the seams heading
 * and each exemplar with its role, then the fixed end line. A pure function
 * of the card and the exemplars' roles and texts: no ids, dates, selector
 * names or per-run text, so it is the same bytes for every act, round and
 * Foray.
 */
export function voicePrefixBlock(file: VoiceExemplarsFile): string {
  const lines: string[] = [];
  if (file.voiceCard) lines.push("VOICE CARD", file.voiceCard.text.trim(), "");
  if (file.exemplars.length > 0) {
    lines.push(
      file.exemplars.length === 1
        ? "ONE SEAM IN THIS VOICE (style only - never quote it, never reuse its facts)"
        : "TWO SEAMS IN THIS VOICE (style only - never quote them, never reuse their facts)"
    );
    file.exemplars.forEach((e, i) => lines.push(`${i + 1} (${e.role}): ${e.text.trim()}`));
    lines.push("");
  }
  lines.push(VOICE_BLOCK_END);
  return lines.join("\n");
}

/** Between `stable` and the voice block: the blank line actWrite.ts's voice
 * slot uses (`stableFor`). */
export const VOICE_SLOT_SEPARATOR = "\n\n";

/**
 * The prompt parts with the voice block appended to the end of `stable`;
 * `parts` itself (unchanged) when there is nothing to append. The single
 * call site is the Qwen writer's prompt builder (prompts/actWrite.ts).
 */
export function withExemplarPrefix(parts: PromptParts, loaded: LoadedVoiceExemplars | null): PromptParts {
  if (!loaded) return parts;
  return { ...parts, stable: `${parts.stable}${VOICE_SLOT_SEPARATOR}${voicePrefixBlock(loaded.file)}` };
}

/** The lever as the report records it, for a run with the flag on. */
export function exemplarProvenance(loaded: LoadedVoiceExemplars | null): ExemplarsLever {
  if (!loaded) return { mode: "unavailable", exemplarIds: [], fileSha: null };
  return { mode: "on", exemplarIds: loaded.file.exemplars.map((e) => `${e.forayId}:${e.itemIds[0]}`), fileSha: loaded.fileSha };
}

/** `levers.exemplars` for the report row: undefined when the flag is off,
 * else the provenance of what the writer's prefix carries. Throws on a
 * malformed flag, naming only the variable. */
export function writerExemplarsLever(source: FlagSource = process.env, root?: string): ExemplarsLever | undefined {
  return writerExemplarsMode(source) === "on" ? exemplarProvenance(loadVoiceExemplars(root)) : undefined;
}
