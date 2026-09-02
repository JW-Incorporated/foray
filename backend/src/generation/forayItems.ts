import { z } from "zod";
import { NARRATION_CHARS_PER_SEC } from "../types/narration";
import type { StitchedItem } from "../types/stitching";

/**
 * §4.8's final mapping step (docs/curation/generation-architecture.md
 * §4.8, and this stage's own task brief): takes the internal
 * `StitchedItem[]` sequence (`../types/stitching.ts`) and maps it,
 * field-for-field, into the item shape `tools/foray/check-forays.mjs`
 * actually validates against `data/forays.json` — WITHOUT invoking that
 * validator here (that is §4.9's job, explicitly out of scope for this
 * stage per the task brief's "what NOT to build" list).
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: internal-only fields never
 * leak into the mapped output. `StitchedNarrationItem`/`NarratedBeat`
 * carry `sources`, `verified`, `pronunciationHints` and `beatIndex` —
 * none of those exist in `check-forays.mjs`'s schema (see that file's
 * own item-shape checks: a narration item there is only
 * `{type, id, script?, asset?/audio_url?, mode?, slot?, duration_sec?}`,
 * a segment item is only `{type, slot?, label?, segment_id, role?}`, a
 * jingle item is only `{type, id?}`). Every function below builds its
 * output object with an EXPLICIT field list (never `...spread`) for
 * exactly this reason — a spread would silently forward whatever the
 * internal type happens to carry the day a new internal field is added.
 *
 * MODE CASING: `check-narration.mjs`'s `MODE_CHAR_BANDS` (which
 * `check-forays.mjs` imports its six-mode enum from) keys are
 * lowercase (`hinge`, `frame`, ...) while this pipeline's internal
 * `NarrationMode` type is capitalized (`Hinge`, `Frame`, ... — matching
 * `tapeSourcing.ts`'s existing `NarrationAssignmentSchema` casing, per
 * that module's own doc comment). This mapper lowercases on the way out
 * — the one place casing conversion happens, so nothing upstream of it
 * has to know `data/forays.json` disagrees with the pipeline's own
 * internal casing convention.
 */

/** `data/forays.json` segment item shape, reduced to the fields
 * `check-forays.mjs` actually reads (see that file's `item.type ===
 * "segment"` block). `.strict()` so a caller of this module notices
 * immediately if an extra field slips in, rather than only noticing at
 * `check-forays.mjs` time (§4.9, out of scope here). */
export const ForaySegmentItemSchema = z
  .object({
    type: z.literal("segment"),
    slot: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    segment_id: z.string().trim().min(1),
    role: z.enum(["quote", "explanation", "exchange", "narrative"]).optional()
  })
  .strict();
export type ForaySegmentItem = z.infer<typeof ForaySegmentItemSchema>;

/** The six modes, LOWERCASE — matches `check-narration.mjs`'s
 * `MODE_CHAR_BANDS` keys exactly (see this module's doc comment). */
export const ForayNarrationModeSchema = z.enum(["hinge", "frame", "marker", "correction", "patch", "carry"]);
export type ForayNarrationMode = z.infer<typeof ForayNarrationModeSchema>;

export const ForayNarrationItemSchema = z
  .object({
    type: z.literal("narration"),
    id: z.string().trim().min(1),
    script: z.string().trim().min(1),
    mode: ForayNarrationModeSchema,
    slot: z.string().trim().min(1).optional()
  })
  .strict();
export type ForayNarrationItem = z.infer<typeof ForayNarrationItemSchema>;

export const ForayJingleItemSchema = z
  .object({
    type: z.literal("jingle"),
    id: z.string().trim().min(1).optional()
  })
  .strict();
export type ForayJingleItem = z.infer<typeof ForayJingleItemSchema>;

export const ForayItemSchema = z.discriminatedUnion("type", [ForaySegmentItemSchema, ForayNarrationItemSchema, ForayJingleItemSchema]);
export type ForayItem = z.infer<typeof ForayItemSchema>;

/** Deterministic, dependency-free slugifier for a slot TITLE into a slot
 * ID matching `data/forays.json`'s `slots[].id` convention (e.g. "Fire
 * and the origins of cooking" -> "fire-and-the-origins-of-cooking") —
 * `check-forays.mjs` only checks that an item's `slot` string appears in
 * the Foray's own `slots[].id` list, so the exact scheme just needs to
 * be applied consistently to both; §4.9 (out of scope here) is
 * responsible for writing the matching `slots[]` array itself. */
export function slugifySlotTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lowercaseMode(mode: string): ForayNarrationMode {
  const lowered = mode.toLowerCase();
  const parsed = ForayNarrationModeSchema.safeParse(lowered);
  if (!parsed.success) {
    throw new Error(`toForayItem: narration mode "${mode}" does not map to any of the six check-forays.mjs modes`);
  }
  return parsed.data;
}

/** Estimated script duration at narration-craft's published planning
 * rate — informational only (the mapped item does not carry a
 * `duration_sec` field; `player/foray-queue.js`'s own `narrationDuration`
 * already estimates from `script` at this exact rate, so writing a
 * second, possibly-stale estimate here would be the kind of drift this
 * codebase's `copyRules`/`NARRATION_CHARS_PER_SEC` cross-checks exist to
 * prevent). Exposed for tests and any future caller that wants the
 * number without re-deriving it. */
export function estimateScriptSeconds(script: string): number {
  return Math.round((script.length / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/** Maps ONE `StitchedItem` to its `data/forays.json`-shaped equivalent.
 * Every internal-only field (`beatIndex`, `itemId`, `startSec`/`endSec`
 * on a tape item, `narrationKind`, and everything `NarratedBeat` itself
 * carries beyond `mode`/`script`) is deliberately left out of the return
 * object below — see this module's doc comment. */
export function toForayItem(item: StitchedItem): ForayItem {
  if (item.kind === "tape") {
    const segment: ForaySegmentItem = {
      type: "segment",
      segment_id: item.segmentId,
      slot: slugifySlotTitle(item.slotTitle)
    };
    if (item.label !== undefined) segment.label = item.label;
    return ForaySegmentItemSchema.parse(segment);
  }

  if (item.kind === "narration") {
    const narration: ForayNarrationItem = {
      type: "narration",
      id: item.id,
      script: item.script,
      mode: lowercaseMode(item.mode)
    };
    if (item.slotTitle !== undefined) narration.slot = slugifySlotTitle(item.slotTitle);
    return ForayNarrationItemSchema.parse(narration);
  }

  // item.kind === "jingle"
  const jingle: ForayJingleItem = { type: "jingle" };
  if (item.id !== undefined) jingle.id = item.id;
  return ForayJingleItemSchema.parse(jingle);
}

/** Maps a full ordered `StitchedItem[]` sequence. Order is preserved
 * exactly — `check-forays.mjs`'s ordering rules (D1/D5/etc.) all read
 * `foray.items` as the total listening order, and this mapper never
 * reorders. */
export function toForayItems(items: StitchedItem[]): ForayItem[] {
  return items.map(toForayItem);
}

/** Structural round-trip guard: asserts NONE of the listed internal-only
 * field names appear as an OWN property of any mapped item. This is the
 * automated version of this stage's task brief's "internal-only fields
 * must NEVER be written into the forays.json-shaped output" requirement
 * — a test failure here means a leak, not a style nit. */
const INTERNAL_ONLY_FIELD_NAMES = ["sources", "verified", "pronunciationHints", "beatIndex", "narrationKind", "startSec", "endSec", "itemId"];
export function assertNoInternalFieldsLeaked(items: ForayItem[]): void {
  for (const [i, item] of items.entries()) {
    for (const field of INTERNAL_ONLY_FIELD_NAMES) {
      if (Object.prototype.hasOwnProperty.call(item, field)) {
        throw new Error(`toForayItems: mapped item ${i} leaked internal-only field "${field}"`);
      }
    }
  }
}
