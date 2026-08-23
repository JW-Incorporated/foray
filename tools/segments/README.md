# Segment pipeline (`tools/segments/`)

Track A of epic #102. Dependency-free helpers that turn what a publisher
shipped into something segment extraction can index. Dependency-free is a
constraint, not an accident — `tools/` has no `package.json` and no install
step, so any of it runs from a bare checkout in a keyless GitHub Action.

| File | Role | Network |
|------|------|---------|
| `transcript-normalize.mjs` | Any timestamped transcript format → one cue list (#105) | no |
| `merge-segments.mjs` | Agent-authored candidate segments → validated `data/segments.json` (#106) | no |
| `transcript-coverage.mjs` | Joins the availability index to `data/discover.json` — the coverage number (#104) | no |
| `sweep-transcripts.mjs` | Which episodes *advertise* a transcript, indexed per show (#104) | reads feeds |
| `fetch-transcripts.mjs` | Fetches and normalises the free, anchorable transcripts (#104) | reads transcripts |
| `rank-breadth.mjs` | Which of the 19,436 uncurated feeds to sweep first (#114) | no |
| `breadth-yield.mjs` | What a breadth tranche returned per request, and what it projects to (#114) | no |
| `measure-suspects.mjs` | Do the anchorable shows actually inject? Two pools, one probe (#319/#321) | ranged GETs |
| `politeness.mjs` | The per-host gate both fetchers share: throttle, backoff, `Retry-After` | n/a |

`writeJsonAtomic` lives in `sweep-transcripts.mjs` and `fetch-transcripts.mjs`
imports it. It was copied, byte-identical, until #320 — the sixth duplicated
implementation this repo has found — and the copy stopped being harmless the
moment the original learned to retry a Windows lock. Its rename is refused with
`EPERM` while any other process holds the file open for READING, which is fine
on POSIX and is not on Win32; a 1,000-feed sweep died at feed 788 for exactly
that reason, with an intact checkpoint and nothing lost but the run. Six
attempts (one, plus five retries, pausing 100ms…500ms — 1.5s of patience) with
the temp file removed if the ladder is exhausted; any error that is not a lock
still throws at once.

The two fetchers are the only ones that touch the network, and they are polite
in the same way because they share `politeness.mjs` rather than each carrying a
copy: honest User-Agent with a contact address, a per-host minimum
interval so shows sharing a CDN cannot be burst, `Retry-After` honoured, hard
timeouts, bounded attempts. A `Retry-After` holds the gate for the **whole**
host, so one 429 quiets every worker rather than only the one that received it —
the copies each had that backwards, which is what one shared module fixes and
two drifting ones did not. **Neither ever requests audio** — that is a separate
decision behind a gate (#108), and `fetch-transcripts.mjs` asserts it per
request rather than trusting its caller.

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

## `transcript-coverage.mjs` — the number

```
node tools/segments/transcript-coverage.mjs            # human-readable, by show
node tools/segments/transcript-coverage.mjs --json     # the full report
```

Answers "how many of our curated episodes can we read for free?" — and exists
because for ten days nothing could. `data/discover.json` keys episodes on Apple
ids; `data/transcript-availability.json` keys them on the feed `<guid>`. Neither
carries the other's key, so every join returned **zero while the index held
8,012 transcripts**, and zero was exactly what everyone expected, so it read as
a finding rather than a bug.

The fix is one field: `enclosure_url`, the only value both files take verbatim
from the same feed. The sweep now records it and this joins on it, with
a title-AND-duration match as the one counted backstop. Every match reports
`via`, so a report carried by the backstop rather than the key is visibly one
to distrust. Requiring both signals is load-bearing: tried independently they
produced 7 matches on the real catalogue and all 7 were the wrong episode.

**An index without the join key is a named error, not a zero.** Producing "0%
coverage" from a pre-`enclosure_url` index is the precise bug this file exists
to end, so it refuses to.

## `fetch-transcripts.mjs` — acquisition

```
node tools/segments/fetch-transcripts.mjs --dry-run    # what would be fetched
node tools/segments/fetch-transcripts.mjs              # anchorable shows only
node tools/segments/fetch-transcripts.mjs --all-timed  # once ad-inflation has verdicts
```

ADR-0004 step 1, and the only file here that requests a transcript body.

**Default selection is anchorable, not everything.** Of 7,571 timed transcripts
in the index, 6,625 belong to shows *measured* injecting ads into the file we
receive — 8–11 minutes on the worst — so their timestamps do not describe our
audio and a segment cut from them points at the wrong moment. The default is
therefore non-DAI shows plus `AD_FREE_SHOWS`, the shows measured delivering
byte-identical: **676 transcripts across 15 shows.**

There is no longer an unmeasured pool. `tools/transcribe/ad-inflation.mjs`
probed all 27 transcript-shipping shows on 2026-08-23; the 2,573 that had never
been measured came back 89 anchorable, 2,183 injecting, and 301 unresolved
(Around the House with Eric G, whose feed declares lengths ~25% larger than it
delivers). `--all-timed` reaches the rest.

**676 is not the same as "measured clean".** It is 645 measured ad-free plus 31
measured *injecting* — Cider Chat, which is non-DAI and so passes the first
clause without the measurement ever being consulted (median 1.013). Left in
deliberately: ADR-0008 reversed a >1% rejection gate that had dropped eleven
shows, so re-adding one here is an amendment to that ADR rather than a change
to this directory. The verdict is recorded either way.

**Text lives outside the repo.** Bodies and normalised cues go to
`data-local/transcripts/` (gitignored), the shape the research corpus settled on
in #255; only `data/transcript-digests.json` is committed — hash, cue count and
covered span per transcript, enough to notice a publisher silently rewriting a
transcript we already cut segments from, without putting ~30MB of third-party
text into git history. Re-runs skip what is already on disk.

## `rank-breadth.mjs` and `breadth-yield.mjs` — running the sweep wide

The sweep will read any catalogue. #313 gave it the 220 curated shows;
`data/catalog-breadth.json` holds 19,436 more uncurated feeds, and the budget
that binds is polite requests rather than time, so the ORDER is the decision.
These two files are that decision and its scorecard. Neither touches the
network.

```
node tools/segments/rank-breadth.mjs --report                 # the priors, no file

# Tranche N is ranked on every index swept so far, which is also what makes its
# pool disjoint from them. Both flags take a comma-separated list.
node tools/segments/rank-breadth.mjs --exploit 600 --explore 400 --host-cap 40 --seed breadth-02 \
  --availability data/transcript-availability.json,data-local/breadth/availability-breadth.json \
  --out data-local/breadth/tranche-02.json

CATALOG_PATH=data-local/breadth/tranche-02.json AVAILABILITY_PATH=data-local/breadth/availability-tranche-02.json TRANSCRIPT_PROGRESS_PATH=data-local/breadth/progress-02.json   node tools/segments/sweep-transcripts.mjs --concurrency 4 --max-episode-rows 200

# The committed report covers everything swept, so --breadth and --tranche are
# lists too, paired positionally.
node tools/segments/breadth-yield.mjs \
  --breadth data-local/breadth/availability-breadth.json,data-local/breadth/availability-tranche-02.json \
  --tranche data-local/breadth/tranche-01.json,data-local/breadth/tranche-02.json \
  --out data/breadth-transcript-yield.json
```

**A path you passed and that is not there is FATAL in both tools, not skipped.**
`readAvailabilities()` used to be `filter(existsSync).map(readJson)`, and that
cost a tranche: a shell mangled the comma-separated list, the second index
silently vanished, and the run printed an entirely ordinary "priors: 219 swept
show(s), 46 host(s)" and an entirely ordinary pool of 19,373 — which was tranche
1's pool, i.e. a tranche that would have re-requested up to 500 feeds already
read and ranked them on priors that had never seen those 500 feeds. Nothing about
the output looked wrong. A tool that spends a request budget does not get to
guess which of its inputs it managed to read.

`breadth-yield.mjs` had the identical hole and a reviewer caught it: its
`--breadth` and `--tranche` lists are paired POSITIONALLY, and a list short by
one gave a whole index `arm: null` — those rows fell out of BOTH arm yields,
stayed in `breadth_all`, and vanished from the depth report, while every rate
printed still looked like a rate. `checkTranchePairing()` now refuses a pairing
that is present and wrong, before a file is opened. Passing no `--tranche` at
all is still legal: an index with no tranche reports under a null arm on
purpose.

## `measure-suspects.mjs` — replacing inference with evidence

```bash
# The shortlist the yield report already flagged (#319).
node tools/segments/measure-suspects.mjs --pool suspects

# Every OTHER anchorable show — the ones nothing has ever measured (#321).
node tools/segments/measure-suspects.mjs --pool anchorable --resume

# Feeds that publish no <enclosure length> need a different instrument:
# ADR-0008's N>=2 probes of the SAME episode. --resume re-probes the rows
# that came back with zero samples and leaves the settled ones alone.
node tools/segments/measure-suspects.mjs --pool anchorable --resume --repeat 3 \
  --host atelier.flightcast.com

# Then re-report. --measured is a LIST: both files, or the corpus number
# contradicts evidence sitting in the repo beside it.
node tools/segments/breadth-yield.mjs ... \
  --measured data/breadth-suspect-inflation.json,data/breadth-anchorable-inflation.json
```

**`dai_reason: "unknown"` is not `dai_reason: "static"`.** It means
`classifyShow` walked the redirect chain and recognised no host on it — a
negative filed as a pass. After #320 all 46 anchorable shows carried it and
10,933 timed transcripts rested on it. #319 had already measured seven shows
inferred the same way and **six of them injected**, so the inference was not a
small risk being taken knowingly; it was an untested assumption under the
whole corpus. `measurement_coverage` in the yield report now splits the
headline number into what was measured and what was merely not recognised,
because "10,933, all inferred" and "4,013 measured" are different assets.

**Judge on per-episode inserts, never on the median.** `verdict` is a median
ratio over five episodes; `disposition` is what any consumer must read. The
two disagree whenever a platform inserts into SOME episodes: the median then
measures how many of five samples drew a filled slot. The Art Bell Archive
returned a median of 1.002 — comfortably "ad-free" — with all five sampled
episodes over their declared length. Reading `verdict` would have admitted it,
and it is 1,368 transcripts.

**A 1% band is duration-blind.** 30 s on a 113-minute episode is ratio 1.004.
`impliedDeltaSec()` converts the gap to seconds at the episode's own implied
bitrate and `INSERT_EVIDENCE_SEC` is the threshold applied to that result, which
is why a long episode cannot hide a short insert.

**A gap that never changes size is a different shape from ad load — but not
necessarily an innocent one.** `constantOffsetBytes()` reports — and gates
nothing — when every sampled episode differs from its declaration by the *same*
number of bytes across a much wider spread of episode sizes. Art Bell delivers
+99,324 / +99,387 / +99,331 / +99,303 / +99,319 bytes over episodes running
51.9MB to 56.5MB: an 84-byte spread across a 4.6MB one, where every obviously
injecting show here varies (Snail Trail: +811,065 on three episodes, +1,498,237
on a fourth, −870,068 on a fifth).

That distinguishes *constant* from *proportional*; it does **not** distinguish
metadata from ads, and an earlier version of this note claimed it did. ADR-0008
lists **pre-roll only** as a real DAI configuration and says of it that "every
break is at `t = 0`, so `cum(t)` is the same constant" — so a fixed-length house
pre-roll is a constant byte offset too. Art Bell's ~99KB is ~16 s at its
bitrate: a plausible ID3v2 artwork block *and* a plausible short pre-roll.
Nothing measurable here chooses. The row keeps its `drop`, and decode-and-compare
on one episode is what would settle it — re-admitting 1,368 transcripts on the
flattering reading is the move #319 measured and found wanting.

**Variance condemns; stability does not acquit.** `--repeat N` asks for one
episode N times. `Content-Range`'s total is the length of the resource served,
so two totals for one URL mean two resources and the file is being assembled
per request — proof, not a threshold. The converse does not hold: a stitcher
may key on session, IP or time and hand one client the same stitch inside a
cache window. So a byte-stable no-denominator show stays `unresolved`, and
`measurementSplit()` reports it under `repeat_stable_no_denominator` rather
than letting it read as either a pass or a failure to measure.

**A platform verdict is not a show verdict**, and this pool proves it twice.
On blubrry, nine shows are clean and one injects — and Becker's Healthcare
(995 transcripts, clean) resolves through `ins.blubrry.com`, the same
insertion-capable hop the dirty one uses. Being able to inject is not
injecting. On libsyn the split is by final origin: all four
`content.libsyn.com` shows are clean, all four on `delivery-edge.libsyn.com`
or `teletraan.libsyn.com` inject. Neither observation is written to a host
list; see `_adswizz_note` in `dai-hosts.json` for why one dirty show must not
flag every future feed on its platform.

**The samples are the evidence; every other field is an opinion about them.**
`deriveRow()` computes all of them, and `--resume` puts carried-forward rows
back through it rather than copying them, so a signal added after a row was
measured appears on it without re-asking a publisher for bytes already
committed. Two copies of a verdict rule would let one file hold rows judged by
two standards with nothing on them saying which.

**Rank on the hosting platform, not the genre.** A `<podcast:transcript>` tag
is a feature of the platform the publisher pays for, not a choice the publisher
makes per episode, so the feed's host predicts it far better than the subject
does. Measured over the 219 curated feeds we have read: omnycontent 10 of 12
shows carry timed transcripts, buzzsprout 3 of 8, transistor 3 of 4 — and
megaphone, simplecast, art19 and acast are 87 shows with **zero** between them,
which is 26% of the breadth catalogue that can be deprioritised on evidence.
Genre is close to noise by comparison: `data/breadth-classification.json` files
Odd Lots under `sports/soccer`, so a topic-weighted rank is a rank on a
classifier's mistakes. `TOPIC_WEIGHT` is 0 and says so.

**The priors are recomputed, never listed.** `hostPriors()` reads whatever
availability indexes it is handed, so each tranche is ranked on what the last
one measured, and a platform stops being guessed at the moment it is swept.

**Two arms, because one cannot answer the question.** A purely greedy tranche
measures the shows we predicted would win, so its yield is an upper bound and
not a population estimate — and "are the remaining 19,000 feeds worth the
requests?" is a question about the population. So the tranche is a ranked
EXPLOIT head plus a uniform-random EXPLORE arm over the same pool, disjoint and
labelled, and `breadth-yield.mjs` refuses to print a pooled headline without the
split. The sampling is seeded so an interrupted run resumes onto the same
tranche rather than a fresh one.

**`--host-cap` is not tuning.** Ranked purely on expected yield the first 300
rows of the real catalogue are 300 omnycontent feeds: one platform, chosen on a
sample of twelve, discovering nothing about the other 6,000 shows on platforms
we have never read. The cap is what turns the exploit arm from "harvest the one
host we know" into "harvest it and price the others".

**Supply and anchorability are different numbers, and on breadth they diverge
by 45x.** Transcripts cluster on the big networks and the big networks inject
ads, so a timed transcript on a DAI show describes a timeline that is not the
one we receive (ADR-0007). Across two tranches, 1,500 feeds returned
**339,290** timed transcripts and **11,667** anchorable ones. The report prints
both, and counts an unresolved DAI verdict as *not* anchorable — an unknown
reported as a win is how a yield rate becomes a promise the corpus cannot keep.

**Tranche 1's own numbers moved after it was published, and not because it was
re-swept for supply.** #319 taught `classifyShow` to match the DAI host list
against the WHOLE redirect chain rather than its last hop, and tranche 1 was
swept the day before that landed. Re-resolving the only 12 rows whose verdict
could change — the classifier is monotone, so a row already DAI stays DAI and
only an anchorable row can move — flipped five Spreaker shows and took tranche 1
from **3,952 anchorable to 1,482**. Every figure below is post-#319; anything
quoting 3,952 is pre-#319 and not comparable.

**And "not DAI" still means "unrecognised", for all of it.** All **46**
anchorable shows across both tranches carry `dai_reason: "unknown"`. Not one was
positively verified as static; they are all "we did not recognise any host in
this chain", filed as a pass. That caveat now sits under 11,667 transcripts
instead of 3,952, which makes it larger rather than smaller.

`suspectAnchorable()` reports the rows where that verdict is contradicted by
something already known — and it now checks the **whole chain**, not the last
hop, which is the same defect #319 removed from `classifyShow`. An insertion
vendor is no more obliged to be the final host than a DAI platform is. Measured
across both tranches the chain scan catches **0** extra rows today; it is landed
now because the markers list is expected to grow and a marker added later would
otherwise be looked for in one position only.

**A MEASUREMENT OUTRANKS THE HEURISTIC, and the measurement is now read.** #319
spent 7 feeds and 54 ranged GETs settling tranche 1's seven suspects into
`data/breadth-suspect-inflation.json` — and nothing consulted the file, so this
tool went on reporting 1,131 net while the measurement beside it said 1,145.
`measuredDispositions()` reads it: `disposition: "recover"` un-suspects a row,
`"drop"` keeps it and relabels the reason `measured-injecting`. Read
`disposition`, never `verdict` — `verdict` is a median over five episodes and
says "ad-free" for four shows caught inserting into some of those five. Absence
is not a recovery: a show with no entry keeps whatever the heuristic said.

**734 timed transcripts are netted out across both tranches; 10,933 survive both
checks.** Labelled, never excluded — `isAnchorable` tracks the predicate
`fetch-transcripts.mjs` selects on, and the suite drives both over the whole
{null, true, false} x {on-list, off-list} grid rather than asserting agreement in
prose.

**Compute that per arm or the conclusion inverts.** `yieldOf(rows, suspects)`
takes the suspect list so each arm is netted against its own. Pooled, a tranche's
suspects and its two arms average into a number that is true of neither and reads
as both; the suite pins that the headline is not pooled.

Net anchorable transcripts per feed swept, both tranches, post-#319:

| arm | tranche 1 (500) | tranche 2 (1,000) |
|---|---|---|
| ranked EXPLOIT | 300 feeds, **3.4**/feed | 600 feeds, **15.8**/feed |
| random EXPLORE | 200 feeds, **0.7**/feed | 400 feeds, **0.7**/feed |

against a curated baseline of **3.1**/feed.

**The explore arm did not move and the exploit arm went up 4.6x, which is the
whole finding.** The population rate is what it was — 0.68 then, 0.74 now — so
none of the gain is the catalogue getting better. All of it is the ordering, and
the ordering got better for a reason the design predicted: tranche 1 ranked on
priors covering 46 hosts and its exploit head was 42 omnycontent feeds, all DAI;
tranche 2 ranked on 101 hosts and spread 600 feeds across 159 platforms, which is
what found flightcast.com (5,461 net anchorable across 7 shows), fountain.fm and
podhome.fm. `--host-cap` is what converts "harvest the one host we know" into
"price the others", and this is the tranche where that paid.

**The ranked yield is not decaying with depth.** `byRankBucket()` splits the
exploit arm into equal counts of FEEDS — the budget is requests, so a bucket is a
fixed number of requests — and nets each bucket against the suspects, because the
suspects are concentrated enough that a gross curve would measure where they
landed. Tranche 2's six buckets read 25.2, 43.3, 0.1, 6.5, 16.7, 3.2 net per
feed. That is lumpy, not monotone: the best bucket is ranks 101-200, ranks
401-500 still return 16.7/feed, and rank 600 is nowhere near the explore arm's
0.7. The variance is between PLATFORMS, not down the ranking, so there is no
depth at which this sweep should have stopped — and no evidence yet for where it
should.

The baseline itself is recomputed from `data/transcript-availability.json` on
every run rather than transcribed, which is why it tracked #316 moving the
curated pool from 587 to 676 without anyone editing this file.

**What gets committed is one row per SHOW.** Episode rows measure ~951 bytes
each. Tranche 1's 500 feeds advertised **187,049** rows worth keeping — ~170MB
uncapped, and ~6.4GB projected across the whole catalogue. Capped at 200 rows a
show the same index is 16MB, which is what `data-local/` actually holds.

Bodies and episode rows stay in gitignored `data-local/` (#255's rule).
`data/breadth-transcript-yield.json` carries counts, the DAI verdict and the
reason behind it, the arm, the tranche, the row's rank within its tranche and
the resolved chain — and nothing that scales with episodes: **measured at
1,337KB for 1,500 shows, so ~16.9MB if every feed in the catalogue is eventually
swept.** That is up from 734 bytes/show to 913, and every field that did it is
load-bearing: `enclosure_chain` and `dai_reason` are the EVIDENCE for
`dai_suspected` — a row holding only its last hop cannot be re-judged when the
host list moves, which is exactly why tranche 1 had to be re-SWEPT rather than
recomputed, and the "all of it says unknown" caveat above is checkable from this
file only because the reason is in it. `tranche` and `rank_position` are the
depth axis. Still a size `data/` can hold. The episode-row shape is not, at any
cap.

### `--max-episode-rows`, and why the sweep needed it

`sweep-transcripts.mjs` rewrites its checkpoint in full after every show. On the
curated 220 that is a 7.7MB write and the quadratic is invisible; on breadth it
is not, because the index is driven by episode rows and the ranked tranche's
head is iHeart feeds averaging 2,900 transcribed episodes each. Uncapped, a
full-catalogue run hands `JSON.stringify` a string longer than V8 will allocate
— it throws rather than slowing down. The cap bounds rows and never counts:
every yield number is computed over the whole feed before anything is sliced,
and `episode_rows_available` / `episode_rows_dropped` record exactly what was
left behind. It defaults to Infinity, so the curated index is unchanged.

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
