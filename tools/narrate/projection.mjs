/* What a fully narrated Foray costs, before any script exists (#247's cost gate).

   `adapter.mjs` costs scripts we HAVE. This module costs the ones we do not:
   it turns a narration inventory and a duration budget into characters, bytes
   and dollars, so the spend decision can be made before the writing starts.

   Everything here is an ESTIMATE built on inputs recorded below. The inventory
   is measured from this repo; the per-beat durations are budgets, not
   measurements; the chars-per-minute rate is discussed in `billable.mjs`.

   ── The inventory, and why the #247 sketch was missing a third of it ──────

   The sketch counted ONE category of narration: 34 beats at 45 s. There are
   three, and two of them are forced by rules that already gate the pipeline:

     1. **Beat narration.** The 40-beat barbecue spine came back 6 strong / 10
        thin / 24 empty (`docs/curation/grilling-history-coverage.md`, quoted in
        #247). 24 + 10 = the 34 beats the sketch used. An EMPTY beat has no tape,
        so narration carries the content; a THIN beat has tape that needs
        setting up, so it needs less. Modelling them at one flat 45 s is the
        sketch's simplification and this module keeps them separate.

     2. **Cross-episode bridges — rule X1.** `docs/curation/segment-length-rules.md`
        line 956: *"cross-episode seam always carries narration"*, tier A,
        gate **yes**. This is not optional and the sketch omits it entirely.
        MEASURED from `data/forays.json` against `data/segments.json`, by
        comparing `item_id` across consecutive segments:

          grilling-history-1  32 segments, 9 episodes -> **16 cross-episode seams**
          grilling-history-2  10 segments, 6 episodes ->  **5 cross-episode seams**
          capital-types-1     22 segments, 8 episodes -> **10 cross-episode seams**

        `04_VOICE_AUDIO_SPEC.md` line 12 budgets a transition at **<= 8 s**.

     3. **Elision bridges — rule M6.** Same file, line 955: *"elided span > 5 min
        => narration required, silence not sufficient"*, gate **yes**. Not
        counted here because the elision spans are not recorded in a form this
        module can read, so it is an input with a default of 0 and a KNOWN
        UNDERCOUNT. Say so rather than quietly modelling it as zero.

   **The overlap this module does NOT pretend to resolve.** A beat narration
   sitting between two segments from different episodes already bridges that
   seam, so some X1 bridges are absorbed by category 1 and counting both is
   double-counting. How many depends on an interleaving nobody has authored yet.
   `bridgeAbsorption` is therefore an explicit 0-1 input: 1 means every
   cross-episode seam is absorbed by a beat narration and category 2 is free, 0
   means none are. The default is 0.5, which is a GUESS and is labelled as one.

   ── The other thing the sketch omits: the 0.5 s padding is BILLABLE ────────

   `04_VOICE_AUDIO_SPEC.md` line 12 asks for ~0.5 s of silence padding around
   TTS items, and `player/seam-gap.js` says that padding is "baked around a TTS
   item" — i.e. it belongs to the ASSET, not to the player's clock, and indeed
   nothing in `player/` implements it. So the pipeline owns it. Encoded silence
   costs no characters but it DOES cost bytes, so it lands in the storage
   arithmetic and not in the credit arithmetic. `padSecPerItem` carries it.
*/

import { mp3Bytes, CHARS_PER_MIN_MEASURED } from "./billable.mjs";
import { costOf } from "./adapter.mjs";

/** Narration inventory measured from this repo. See the header for provenance. */
export const SPINE = Object.freeze({
  emptyBeats: 24,
  thinBeats: 10,
  strongBeats: 6,
  totalBeats: 40,
  crossEpisodeSeams: 16,
  source: "docs/curation/grilling-history-coverage.md (6 strong / 10 thin / 24 empty) and data/forays.json grilling-history-1 (16 cross-episode seams, measured)",
});

/** Per-item duration budgets. BUDGETS, not measurements — no narration exists. */
export const BUDGETS = Object.freeze({
  emptyBeatSec: 45,
  thinBeatSec: 20,
  bridgeSec: 8,
  padSecPerItem: 1.0,
  bridgeSecSource: "docs/brief/04_VOICE_AUDIO_SPEC.md line 12: \"transition TTS <= 8 s\"",
  emptyBeatSecSource: "the #247 cost sketch's 45 s. NOT from any spec — an empty beat carrying content is a category 04_VOICE_AUDIO_SPEC.md never contemplated, and its <= 8 s transition budget is 5.6x smaller. Treat 45 s as the founder's assumption under test.",
  padSource: "04_VOICE_AUDIO_SPEC.md line 12 (~0.5 s each side). Costs bytes, not characters.",
});

/**
 * Project one fully narrated Foray.
 *
 * @param {object} [opts]
 * @param {object} [opts.spine]        override the inventory
 * @param {object} [opts.budgets]      override the duration budgets
 * @param {number} [opts.charsPerMin]
 * @param {number} [opts.bridgeAbsorption] 0-1, how much of X1 a beat narration
 *   already covers. Default 0.5 and it is a GUESS.
 * @param {number} [opts.regenFactor]  how many times a script is voiced before
 *   it is final. 3 in the #247 sketch.
 * @param {number} [opts.kbps]         output bitrate for the byte estimate
 * @param {number} [opts.elisionBridges] rule M6; default 0 and a known undercount
 * @param {object} pricing             parsed pricing.json
 * @returns {object}
 */
export function projectForay(opts = {}, pricing = {}) {
  const spine = { ...SPINE, ...(opts.spine ?? {}) };
  const b = { ...BUDGETS, ...(opts.budgets ?? {}) };
  const charsPerMin = opts.charsPerMin ?? CHARS_PER_MIN_MEASURED;
  const absorption = opts.bridgeAbsorption ?? 0.5;
  const regen = opts.regenFactor ?? 1;
  const kbps = opts.kbps ?? 64;
  const elision = opts.elisionBridges ?? 0;

  const beatItems = spine.emptyBeats + spine.thinBeats;
  const bridgeItems = Math.round(spine.crossEpisodeSeams * (1 - absorption)) + elision;

  const beatSec = spine.emptyBeats * b.emptyBeatSec + spine.thinBeats * b.thinBeatSec;
  const bridgeSec = bridgeItems * b.bridgeSec;
  const speechSec = beatSec + bridgeSec;

  // Characters are billed; padding is silence and bills nothing.
  const chars = Math.round((speechSec / 60) * charsPerMin);
  const items = beatItems + bridgeItems;
  // Bytes DO carry the padding, on both sides of every item.
  const audioSec = speechSec + items * b.padSecPerItem;
  const bytes = mp3Bytes(audioSec, kbps);

  const charsWithRegen = chars * regen;
  const cost = costOf(chars, pricing);
  const costWithRegen = costOf(charsWithRegen, pricing);

  return {
    items: { beatItems, bridgeItems, total: items },
    seconds: { beatSec, bridgeSec, speechSec, audioSec },
    chars, charsWithRegen, regenFactor: regen,
    // Only the FINAL generation is kept, so bytes do not multiply by regen.
    bytes, kbps,
    cost, costWithRegen,
    charsPerMin,
    caveats: [
      elision === 0 ? "rule M6 elision bridges counted as 0 — a KNOWN UNDERCOUNT, the spans are not recorded in a readable form" : null,
      `bridgeAbsorption ${absorption} is a guess: it is how much of rule X1 a beat narration already covers, and no interleaving has been authored`,
      "45 s per empty beat is the sketch's assumption, not a spec — the brief's transition budget is <= 8 s",
      "chars-per-minute is derived, not measured against rendered narration audio",
    ].filter(Boolean),
  };
}

/**
 * Which tier a monthly credit burn lands in.
 *
 * @param {number} credits
 * @param {object} pricing
 * @param {object} [opts]
 * @param {boolean} [opts.useRollover] rollover allows a burst to 3x quota
 * @returns {object|null} the cheapest sufficient tier
 */
export function tierFor(credits, pricing, opts = {}) {
  const mult = opts.useRollover ? (pricing?.rollover?.max_balance_multiple_of_quota ?? 1) : 1;
  const tiers = (pricing?.tiers ?? [])
    .filter((t) => t.commercial_license)
    .sort((a, b) => a.price_usd_month - b.price_usd_month);
  for (const t of tiers) {
    if (t.credits_per_month * mult >= credits) {
      return { ...t, capacity: t.credits_per_month * mult, rolloverApplied: mult > 1 };
    }
  }
  return null;
}
