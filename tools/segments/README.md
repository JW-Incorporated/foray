# Segment pipeline (`tools/segments/`)

Track A of epic #102. Pure, dependency-free, no-network helpers that turn what a
publisher shipped into something segment extraction can index. Dependency-free
is a constraint, not an accident — `tools/` has no `package.json` and no install
step, so any of it runs from a bare checkout in a keyless GitHub Action.

| File | Role |
|------|------|
| `transcript-normalize.mjs` | Any timestamped transcript format → one cue list (#105) |
| `merge-segments.mjs` | Agent-authored candidate segments → validated `data/segments.json` (#106) |

Primary sources: `docs/research/corpus/digests.md` entries 1
(`<podcast:transcript>` spec — the tag behind every transcript format this
directory normalizes), 9 (Podcast Namespace #254 — DAI shifts every
timestamp) and 48 (Pocket Casts ~100s chapter drift) are the evidence
behind the anchor rules `merge-segments.mjs` enforces.

## `transcript-normalize.mjs`

```js
import { normalize } from "./transcript-normalize.mjs";

const { cues, warnings } = normalize(body, mimeType);
// cues:     [{ start_sec, end_sec, text, speaker }]  sorted by start_sec
// warnings: string[]  — everything we could not read, or fixed
```

Handles the four formats actually in use, counted across the 208 live feeds in
this catalogue by declared `<podcast:transcript type=…>`:

| declared type | tags | grammar |
|---|---|---|
| `text/vtt` | 7063 | WebVTT |
| `application/srt` | 6848 | SubRip |
| `application/json` | 787 | Podcasting 2.0 JSON |
| `application/x-subrip` | 621 | SubRip |

Three things worth knowing before you use it:

- **It never throws.** Same posture as `backend/src/feeds/parser.ts`. Worst case
  is `{cues: [], warnings: [...why]}`. Check `cues.length`, not a `try`.
- **The declared type is a hint.** Mislabelling is routine, so the body is
  sniffed and content wins; a disagreement becomes a warning, not a failure.
- **Nothing is discarded silently.** Out-of-order cues are sorted and reported;
  overlapping cues are reported but deliberately *not* merged; rolling-caption
  repetition is stripped and counted. Every one of those shows up in `warnings`.

`speaker` is `null` for formats that cannot express it (SRT always), so callers
that only read `start_sec`/`end_sec`/`text` see one shape everywhere.

## `merge-segments.mjs`

The merge stage of the extraction pipeline: it distrusts the agent, validates
every candidate segment hard, rejects rather than repairs, and leaves the
existing record untouched on a violation. Build order is deliberate — the
validator lands **before** the fan-out, because an army running for a day
against a missing validator produces a day of data nobody can trust.

```
node tools/segments/merge-segments.mjs --batch <batch.json> --results <results.json>
node tools/segments/merge-segments.mjs --check [data/segments.json]   # what CI runs
```

### `data/segments.json` — the schema

The durable output of the whole pipeline. Written only by this script.

```jsonc
{
  "version": 1,
  "segments": [
    {
      "id": "lex-353-whyte#2530",          // derived: <item_id>#<round(start_sec)>
      "item_id": "lex-353-whyte",
      "topic": "engineering/energy-fusion", // must be a node in data/taxonomy.json
      "start_sec": 2530,
      "end_sec": 3110,                      // > start_sec, both ≤ reference_duration_sec
      "reference_duration_sec": 11840,      // duration of the copy these were authored against
      "start_anchor": "so the Lawson criterion is really a statement about",
      "end_anchor": "and that's why the tokamak won by default for thirty years",
      "why": "Whyte explains the Lawson criterion without hand-waving",
      "confidence": "high",                 // high | medium | low
      "transcript_source": "publisher",     // publisher | asr-local
      "dai_suspected": true,
      "source": "agent-v1",
      "batch_id": "seg-2026-08-12-a",
      "needs_review": false,
      "review_notes": ["…"]                 // present only when something was flagged
    }
  ]
}
```

Two fields carry more weight than they look like they do:

- **`transcript_source`** — an anchor is only verbatim *with respect to one
  transcript*. A record that does not say which one cannot be re-resolved
  later (A13), so provenance is recorded by the merge, never authored by the
  agent.
- **`dai_suspected`** — copied from the batch. It is what makes the file
  self-validating: `--check` can enforce ADR-0007's DAI rule offline because
  each record states which rule applied to it.

Anchors may be `null` **only** on a non-DAI item — ADR-0007 permits a DAI
source if and only if both anchors are present and non-empty. A non-DAI
segment that omits them merges with `needs_review: true`, because a publisher
can re-upload a static file too and that segment will rot when they do.

### Batch and results contract

```jsonc
// batch input — produced by the (deterministic, keyless) prepare stage
{ "batch_id": "seg-2026-08-12-a",
  "source": "agent-v1",                      // optional, defaults to agent-v1
  "episodes": [{
    "item_id": "lex-353-whyte",
    "reference_duration_sec": 11840,
    "dai_suspected": true,
    "transcript_source": "publisher",
    "transcript": { "body": "WEBVTT…", "mime_type": "text/vtt" }
  }] }

// agent results
{ "batch_id": "seg-2026-08-12-a",
  "results": { "lex-353-whyte": { "segments": [ /* 0-N candidates */ ] } } }
```

An episode with **no** authored segments is a normal answer, counted and never
an error: most episodes contain nothing worth a Foray, and a pipeline that
treats silence as failure manufactures filler.

### What counts as a verbatim anchor

The critical check, and the one where the rule has to be stated rather than
assumed. An LLM that paraphrases an anchor produces a boundary that can never
be resolved and **fails silently at playback** — nothing throws, the seek
degrades to `approximate`, the segment is skipped forever.

Both sides are canonicalised and compared as a **whole-word subsequence**:
every word of the anchor, in order, nothing added, dropped or substituted.
Canonicalisation forgives only the differences that come from *how text was
written down*, never from *someone rewriting it*:

| forgiven | rejected |
|---|---|
| case, doubled spaces, newlines, tabs | any word added, dropped or changed |
| punctuation, incl. hyphens/em-dashes (`hand-waving` == `hand waving`) | `that is` for `that's` (a word added) |
| smart vs straight apostrophes | `30 years` for `thirty years` |
| apostrophe elision (`that's` == `thats`) | synonyms, tense, plurals |
| NFKC width/ligature variants | fewer than 4 words |

Two details that are easy to get backwards: punctuation becomes a **space** so
hyphenation (a caption-writer's choice) does not matter, while apostrophes are
**deleted** so contractions do not split into two words. And digits are not
spelled out — matching what a resolver could actually find in the listener's
own transcript is the entire point.

On top of verbatim-ness, two guards that are free once the transcript is
indexed: an anchor under **4 words** is not a location, and an anchor whose
occurrences are all more than **120s** from the timestamp it claims means the
timeline cache is junk even though the words are real. An anchor that occurs
more than once merges but is flagged `needs_review`.

Anchors are searched across a flattened token stream, not per cue: an anchor
legitimately straddles a cue boundary, and that is exactly the kind an
extractor tends to pick.

## Tests

`node --test "tools/segments/*.test.mjs"` (CI runs this inside the
`data-and-site` job — see `.github/workflows/ci.yml`, which also runs
`merge-segments.mjs --check` against the committed `data/segments.json`).
Both suites carry a committed floor in `test/suite-integrity.test.js`.
Fixtures and the rules for adding more are in `fixtures/README.md`.
