import { z } from "zod";
import { NARRATION_CHARS_PER_SEC, isTapeSource } from "../types/narration";
import type { Source } from "../types/narration";
import type { StitchedItem, StitchedNarrationItem } from "../types/stitching";

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
 * `{type, id, script?, asset?/audio_url?, mode?, slot?, duration_sec?,
 * cites?}`, a segment item is only `{type, slot?, label?, segment_id,
 * role?}`, a jingle item is only `{type, id?}`). Every function below
 * builds its output object with an EXPLICIT field list (never
 * `...spread`) for exactly this reason — a spread would silently forward
 * whatever the internal type happens to carry the day a new internal
 * field is added.
 *
 * F-103 — WHAT A NARRATED BEAT NOW SHIPS ABOUT ITS OWN GROUND. That rule
 * is unchanged; `cites` is not an exception to it. `sources` is still
 * refused, because a `Source` is the model's internal page record — it
 * carries `claimText` (the writer's restatement of an assertion, in its
 * own words, never checked as copy) and `quote` (a verbatim span of a
 * held document, which Ruling 3 / `check-narration.mjs`'s
 * `REFERENCE_LEAK_RE` bans from ever reaching a line anyone reads or
 * hears). What ships is a DERIVED shape: for each thing the page rests
 * on, the least that identifies it to a reader and lets the client link
 * it.
 *
 *   { kind: "tape",  segment_id }              -> the clip, and through
 *       the segment pool its episode and show. `show`/`title` are NOT
 *       denormalised here: `player/foray-resolve.js` already holds both
 *       pool indexes when it hydrates an item (it needs them to play the
 *       clip at all), so duplicating them into `data/forays.json` would
 *       cost bytes in a file with a bundle budget and could go stale
 *       against a re-curated pool. Agreed with the renderer, 2026-09-12.
 *   { kind: "print", publication, url? }       -> the publication, and a
 *       link when the evidence pack held one.
 *
 * AND THE HONESTY RULE, which is the reason this is a function and not a
 * field copy: CITATIONS ARE PUBLISHED ONLY FOR A PAGE THE VERIFIER
 * CONFIRMED. `verified !== true` publishes NO `cites` at all — never the
 * page's unconfirmed sources, which would present as support exactly the
 * material the verifier declined to accept as support. F-51 keeps a
 * refused page with `verified: false` rather than ending the run (the
 * veracity gate, not this mapper, is where that decision is made), and
 * F-60/F-99 keep pages that were never written against evidence in the
 * first place (`unverifiedReason`) — so an unverified page reaching here
 * is an ordinary state, not a defect, and it must reach a reader saying
 * nothing about its ground rather than something false about it.
 *
 * The absence of `cites` therefore means exactly one thing: "nothing here
 * was confirmed to rest on anything a reader can go and check." It does
 * NOT distinguish an unverified page from a page verified by SYNTHESIS
 * (F-88: a generalisation over the Foray's own earlier verified pages,
 * which rests on page ids rather than on any outside document, so its
 * `sources` is empty). Telling those two apart is worth doing and is not
 * done here: the renderer has reserved the sibling field name `basis`
 * (`basis: "synthesis"`) for it, so that when it lands it lands as a
 * named field rather than as an overloaded member of `cites`.
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

/** The modes, LOWERCASE — matches `check-narration.mjs`'s
 * `MODE_CHAR_BANDS` keys exactly (see this module's doc comment). `intro`
 * is Q-02's introduction before a clip (`types/narration.ts`). */
export const ForayNarrationModeSchema = z.enum(["hinge", "frame", "marker", "correction", "patch", "carry", "intro"]);
export type ForayNarrationMode = z.infer<typeof ForayNarrationModeSchema>;

/** K-02 (`docs/bundled-voice-plan.md`): what a narration item carries when the
 * phonemize stage has run. `engine` is an enum of one today — the deck's §11
 * non-goals forbid a second engine without a second audition — and
 * `tools/foray/check-forays.mjs`'s `TTS_ENGINES` is the matching list on the
 * validation side.
 *
 * `vocab` IS NOT COSMETIC. It is the sha of the phoneme id table these
 * phonemes were written against; the player refuses (falls back to the system
 * voice) when it disagrees with what the app was built with, which is deck §5
 * item 8's answer to "the data outlived the model". An item that could not
 * carry one does not get a `tts` block at all — see `phonemize.ts`'s
 * fallbacks. */
export const ForayTtsSchema = z
  .object({
    engine: z.literal("kokoro"),
    model: z.string().trim().min(1),
    vocab: z.string().trim().min(1)
  })
  .strict();
export type ForayTts = z.infer<typeof ForayTtsSchema>;

/** F-103: one thing a narrated beat rests on, as `data/forays.json`
 * carries it. Two shapes, discriminated on `kind` — mirroring the writer's
 * own tape/print split (`types/narration.ts`'s `SourceSchema`) without
 * carrying any of that shape's internals. `.strict()` on both, so a field
 * cannot be bolted on here without `check-forays.mjs` gaining the matching
 * rule (they would disagree immediately, and `finalizeForay` runs the
 * checker over every candidate).
 *
 * The published vocabulary is LOWERCASE and snake_case — `segment_id`, not
 * `segmentId` — because that is `data/forays.json`'s convention and this
 * module is the one place the pipeline's internal casing is converted (see
 * the module doc comment's MODE CASING note, which this follows). */
export const ForayTapeCiteSchema = z
  .object({
    kind: z.literal("tape"),
    /** The clip's id in the Foray's own segment pool. `check-forays.mjs`
     * requires it to RESOLVE there, which is what stops a citation the
     * client would silently drop from ever being the state on main — the
     * renderer's `resolveCites` drops an unjoinable entry rather than
     * drawing an empty bullet, so an unresolvable id would show a reader
     * nothing while this file believed it had shipped provenance. */
    segment_id: z.string().trim().min(1)
  })
  .strict();
export type ForayTapeCite = z.infer<typeof ForayTapeCiteSchema>;

export const ForayPrintCiteSchema = z
  .object({
    kind: z.literal("print"),
    /** One of the evidence pack's document titles (F-27/F-30/F-32: a
     * publication is a held document's `title`, never free text the writer
     * made up). */
    publication: z.string().trim().min(1),
    /** Present only when the held document had one AND it is http(s) — see
     * `citeUrl` below for why a URL that is neither is dropped rather than
     * published. */
    url: z.string().trim().min(1).optional()
  })
  .strict();
export type ForayPrintCite = z.infer<typeof ForayPrintCiteSchema>;

export const ForayCiteSchema = z.discriminatedUnion("kind", [ForayTapeCiteSchema, ForayPrintCiteSchema]);
export type ForayCite = z.infer<typeof ForayCiteSchema>;

export const ForayNarrationItemSchema = z
  .object({
    type: z.literal("narration"),
    id: z.string().trim().min(1),
    script: z.string().trim().min(1),
    mode: ForayNarrationModeSchema,
    slot: z.string().trim().min(1).optional(),
    /* K-02's three additions, ALL OPTIONAL and all absent together. The
       `.strict()` below is what made adding them necessary rather than
       incidental: without these three lines the phonemize stage's output
       would fail this schema, which is exactly the guard `.strict()` exists
       to provide. An item with `phonemes` and no `tts`, or the reverse, is
       rejected downstream by `check-forays.mjs` rather than here — that file
       can say WHY in a sentence a curator reads, and this one cannot. */
    phonemes: z.string().trim().min(1).optional(),
    tts: ForayTtsSchema.optional(),
    est_sec: z.number().positive().finite().optional(),
    /** F-103. OPTIONAL, and NON-EMPTY whenever present: absence is the
     * empty case, so no consumer has to decide what an empty Sources list
     * means and no renderer has to guard against drawing an empty heading.
     * `.min(1)` is what makes `citesFor` returning `[]` and this field
     * being omitted the same state by construction rather than by
     * convention. */
    cites: z.array(ForayCiteSchema).min(1).optional()
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

/**
 * F-103: a print source's URL, or `undefined`.
 *
 * DROPPED RATHER THAN PUBLISHED when it is not http(s). `PrintSource.url`
 * upstream is `z.string().min(1)` — any non-empty string, because the
 * evidence pack records whatever the retriever recorded and a document
 * with no web address at all is still a source. A published citation is a
 * LINK a reader clicks, so a `url` that is not a web address is worse than
 * no `url`: the publication name alone is a complete, honest citation, and
 * a dead or non-navigable href attached to it is not. `check-forays.mjs`
 * rejects a non-http(s) `cites[].url` outright, so publishing one would
 * also fail the candidate in `finalizeForay` — dropping it here is what
 * keeps a scruffy retrieval record from costing a whole run.
 */
function citeUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  return /^https?:\/\/\S/i.test(trimmed) ? trimmed : undefined;
}

/** The deduplication key for a published citation: WHAT IT POINTS AT, and
 * nothing about which claim pointed there. A page cites the same document
 * once per claim it supports — three claims from one article are three
 * `Source` entries — and a reader wants the article listed once. The
 * claim-level detail (`claimText`, `quote`) is exactly what this module
 * refuses to publish, so there is nothing left that could distinguish two
 * entries with the same key. */
function citeKey(cite: ForayCite): string {
  return cite.kind === "tape" ? `tape:${cite.segment_id}` : `print:${cite.publication} ${cite.url ?? ""}`;
}

/**
 * F-103: what a narration item publishes about what it rests on.
 *
 * THE HONESTY GATE IS THE FIRST LINE and it is deliberately `!== true`
 * rather than `=== false`: an item that never carried a verification state
 * at all (every hand-built `StitchedNarrationItem`, and the act
 * introduction/exit seams `stitchForay.ts` assembles from prose the
 * deepen stage wrote, which no per-page verifier ever read) must publish
 * no citations for the same reason a refused page must. Absent is not
 * "assume fine".
 *
 * Returns `[]` — never `undefined` — for every "publishes nothing" case,
 * so the caller has exactly one emptiness test to make. See the module doc
 * comment for what an empty result does and does not tell a reader.
 */
export function citesFor(item: Pick<StitchedNarrationItem, "sources" | "verified">): ForayCite[] {
  if (item.verified !== true) return [];
  const out: ForayCite[] = [];
  const seen = new Set<string>();
  for (const source of item.sources ?? []) {
    const cite = citeOf(source);
    const key = citeKey(cite);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cite);
  }
  return out;
}

/** One `Source`, reduced to what a reader is shown. Field-by-field and
 * never a spread — the same rule the rest of this module follows, and the
 * one that keeps `claimText`/`quote`/`contested`/`retrieved` out of
 * `data/forays.json` on the day a new field joins `SourceSchema`. */
function citeOf(source: Source): ForayCite {
  if (isTapeSource(source)) {
    return ForayTapeCiteSchema.parse({ kind: "tape", segment_id: source.segmentId });
  }
  const url = citeUrl(source.url);
  const print: ForayPrintCite = { kind: "print", publication: source.publication };
  if (url !== undefined) print.url = url;
  return ForayPrintCiteSchema.parse(print);
}

function lowercaseMode(mode: string): ForayNarrationMode {
  const lowered = mode.toLowerCase();
  const parsed = ForayNarrationModeSchema.safeParse(lowered);
  if (!parsed.success) {
    throw new Error(`toForayItem: narration mode "${mode}" does not map to any of the check-forays.mjs modes`);
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
export function estimateScriptSeconds(chars: number): number {
  return Math.round((chars / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/** Maps ONE `StitchedItem` to its `data/forays.json`-shaped equivalent.
 * Every internal-only field (`beatIndex`, `itemId`, `startSec`/`endSec`
 * on a tape item, `narrationKind`, and everything `NarratedBeat` itself
 * carries beyond `mode`/`script`) is deliberately left out of the return
 * object below — see this module's doc comment. `sources` and `verified`
 * are read (F-103) and still not written: what leaves is `citesFor`'s
 * derived summary of them, never the records themselves. */
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
    /* F-103. Set only when non-empty — see `ForayNarrationItemSchema.cites`
       for why an empty array is not a legal published value. */
    const cites = citesFor(item);
    if (cites.length > 0) narration.cites = cites;
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
 * — a test failure here means a leak, not a style nit.
 *
 * F-103 GAVE IT SOMETHING TO GUARD. Until then `sources` and `verified`
 * could not have leaked from here whatever this module did, because
 * `stitchAct.ts` never put them on a `StitchedNarrationItem` in the first
 * place (`types/stitching.ts` is `.strict()` and had no such fields) — the
 * provenance died one hop upstream, and this list was guarding an
 * impossible mistake. The stitched item carries both now, so both are a
 * spread away from `data/forays.json` and this assertion is live. */
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
