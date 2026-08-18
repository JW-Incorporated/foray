/* The billable unit — what a TTS provider will actually charge us for (#247).

   ONE function decides what text gets submitted, and every other module in
   `tools/narrate/` routes through it. That is the whole point of this file, and
   it is a direct response to how this repo has been burned before: a dry run is
   only worth having if it counts the SAME characters the real call will send.
   Two code paths — "what we estimate" and "what we submit" — is how a $6
   estimate becomes a $60 bill with every test still green.

   So `billableText()` is not a formatter. It is the definition of the payload.
   `adapter.mjs` may not construct a request body any other way.

   ── Why normalisation is a COST decision, not tidiness ────────────────────

   ElevenLabs bills per CHARACTER of submitted text, spaces and punctuation
   included (`pricing.json` records the provenance and the caveat). There is no
   per-word and no per-second component, so every byte of sloppiness in a script
   file is money.

   Two normalisations therefore pay for themselves:

     - **CRLF -> LF.** This repo is developed on Windows and
       `docs/DECISIONS.md` already records a CRLF trap (never run `format:write`
       repo-wide). A script file saved with Windows line endings carries one
       extra `\r` PER LINE. On a 34-beat Foray of ~40-line scripts that is
       ~1,360 characters — real money, invisible in every editor, and it would
       otherwise differ between a Windows author and a Linux CI runner, making
       the SAME script hash differently on the two machines and re-bill.
     - **Trailing whitespace per line.** Same argument, no prosodic effect.

   And one normalisation is deliberately NOT done: internal runs of spaces and
   blank lines between paragraphs are LEFT ALONE. They are not free, but a TTS
   engine reads them as pause structure, so collapsing them silently would edit
   the performance to save a few characters. If narration copy wants to be
   tighter, that is the craft agent's call in the script, not a transform this
   module applies behind the author's back.

   ── The rate this file will NOT pretend to know ───────────────────────────

   Characters are exact. SECONDS ARE NOT. Duration is an estimate from a
   characters-per-minute rate, and the rate is an input with a default rather
   than a constant, because no narration audio exists in this repo to measure it
   against. `CHARS_PER_MIN_MEASURED` records what we DID measure and what we
   only cited — read its comment before quoting the number.
*/

/** Characters per minute of narration, for turning a duration budget into a
    character budget and back.

    **This is a DERIVED estimate with one measured factor, not a measurement of
    narration audio.** No narration audio exists in this repo yet, so nothing
    here has been checked against a rendered file.

    It is the product of two factors, and they have very different standing:

      - **chars per word: 5.88. MEASURED**, over the 69 `why` lines in
        `data/segments.json` (1,008 words, 5,924 characters) — the closest thing
        to authored narration copy the repo contains. For comparison, the 138
        verbatim ASR anchors in the same file — real transcribed speech from our
        own sources — run 5.376, and the repo's editorial prose runs 5.751. Our
        written register is denser than speech, which pushes cost UP.
      - **words per minute: ~150. CITED, NOT MEASURED.** The audiobook
        narration convention is ~150-160 wpm; documentary narration runs slower,
        ~130-150. 150 is the overlap.

    5.88 x 150 = 882. Rounded to 880.

    **This deliberately disagrees with the 840 figure** used in the first cost
    sketch for #247. 840 implies 143 wpm at our measured density, which is
    inside the documentary range and therefore not wrong — but it sits at the
    slow end, and reading a duration budget through too slow a rate UNDERSTATES
    characters and so understates cost. 880 is the same arithmetic with the
    density we actually measured. The honest planning band is 760-940; see
    `docs/narrator-pipeline.md` for the sensitivity table. */
export const CHARS_PER_MIN_MEASURED = 880;

/** The two ends of the band above, for stating a cost as a range rather than a
    point when the audience is a spend decision. */
export const CHARS_PER_MIN_LOW = 760;
export const CHARS_PER_MIN_HIGH = 940;

/**
 * The exact text a provider will be sent and will bill for.
 *
 * Every caller that needs a character count, a cache key, or a request body
 * MUST take it from here, so that all three describe one string.
 *
 * @param {string} raw  the script as authored
 * @returns {string}
 */
export function billableText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    // CRLF and lone CR -> LF. A `\r` is a billable character that no listener
    // can hear and that differs between a Windows checkout and a Linux runner.
    .replace(/\r\n?/g, "\n")
    // Trailing whitespace per line: billable, inaudible.
    .replace(/[ \t]+$/gm, "")
    // Leading/trailing blank lines around the whole script, same reason.
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * How many characters this script will be billed as.
 *
 * Counted in UTF-16 code units, matching `String.prototype.length`, because
 * that is the unit an HTTP JSON body's text field is measured in by the
 * provider's own character count. **This is a known soft spot**: a provider
 * counting Unicode code POINTS would differ from this on any astral character
 * (emoji, some CJK extensions). English-only narration is the standing
 * instruction, so the difference is zero today — `countChars` returns the same
 * number either way for any script that is actually English — and
 * `nonAsciiChars()` exists so a script that stops being English is visible
 * rather than silently mis-costed.
 *
 * @param {string} raw
 * @returns {number}
 */
export function countChars(raw) {
  return billableText(raw).length;
}

/**
 * Characters outside ASCII, which is the tripwire for the counting caveat
 * above and for the English-only ruling. Curly quotes and em-dashes land here
 * legitimately — this is a flag to look at, not an error.
 *
 * @param {string} raw
 * @returns {{count: number, samples: string[]}}
 */
export function nonAsciiChars(raw) {
  const text = billableText(raw);
  const found = text.match(/[^\x00-\x7F]/g) ?? [];
  return { count: found.length, samples: [...new Set(found)].slice(0, 12) };
}

/**
 * Estimated spoken duration. An ESTIMATE — see the header.
 *
 * @param {number} chars
 * @param {number} [charsPerMin]
 * @returns {number} seconds
 */
export function estimateDurationSec(chars, charsPerMin = CHARS_PER_MIN_MEASURED) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  if (!Number.isFinite(charsPerMin) || charsPerMin <= 0) return 0;
  return (chars / charsPerMin) * 60;
}

/**
 * The inverse, which is the direction script authoring actually needs: a beat
 * has a duration budget, and the writer needs a character budget.
 *
 * @param {number} sec
 * @param {number} [charsPerMin]
 * @returns {number} characters
 */
export function charsForDurationSec(sec, charsPerMin = CHARS_PER_MIN_MEASURED) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  if (!Number.isFinite(charsPerMin) || charsPerMin <= 0) return 0;
  return Math.round((sec / 60) * charsPerMin);
}

/**
 * Bytes of mp3 for a given duration at a given bitrate. Needed for the hosting
 * question (#247), which is about storage and transfer rather than spend.
 *
 * Returns the AUDIO STREAM size only; container overhead and ID3 tags are a
 * rounding error at these durations and are not modelled.
 *
 * @param {number} sec
 * @param {number} kbps
 * @returns {number} bytes
 */
export function mp3Bytes(sec, kbps) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  return Math.round((sec * kbps * 1000) / 8);
}
