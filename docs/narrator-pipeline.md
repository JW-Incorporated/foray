# The narration pipeline — hosting, cost, and what the player already does

Issue **#247**, part C and the two decisions that gate the ElevenLabs key. This
is the engineering third of the charter; the voice research is
`docs/research/narrator-voice.md` and the craft is
`docs/curation/narration-craft.md`.

**Nothing here called a paid API.** `tools/narrate/` is dry by construction and a
test greps every file in it for a `fetch(`, a defaulted transport, an `sk_`
literal and a key read from the environment. The pricing figures come from
public pages, fetched 2026-08-18.

## 0. The short version

| Question | Answer |
|---|---|
| Where does narration audio live? | **Object storage on our own origin over `https:` — the Supabase project already in `connect-src`.** Not git, not the app bundle |
| Does it survive the CSP? | **Yes, with no CSP change, because it is remote `https:`.** The intuitive option — bundling it — is the one that needs a CSP change and a cap change |
| Bytes, one fully narrated Foray | **11.1 MB** at 64 kbps mono (23.1 min of audio) |
| Bytes, ten | **110.9 MB** — 1.4x the entire current git pack |
| Characters, one Foray | **19,712** |
| Cost, ten Forays, 3x regeneration | **~$30**, or 296k-591k credits |
| Is the spend a rounding error? | **Yes. Say so and move on** — see §3.4 |
| Does the 840 chars/min figure survive? | **Partly.** Defensible but at the slow end, and slow understates cost. Use **1,000** |
| Do the tier figures survive? | **No.** Creator is **$22/month**, not $11, and Free has **no commercial licence** |

## 1. How far the player's narration support actually goes

Better than expected, and the gaps are not where the charter guessed.

### What is real, tested, and needs nothing from this work

- **`player/foray-queue.js`** accepts `{ type: "narration", ... }` and emits a
  queue item of `kind: "tts"`, taking the asset from `audio_url` or `asset`. A
  narration item with no asset is **dropped with a reason** rather than stalling
  the Foray, and an authored narration `id` is checked for uniqueness rather than
  trusted — a duplicate id would make one entry unreachable and play the other
  twice.
- **`player/queue-state.js`** models the whole bridge phase as one
  `transitioning(from, to)` state, with `playTransitionTTS` and
  `resetRateForTTS` effects.
- **Narration never plays at the listener's speed.** Corner case #18: a bridge is
  our own line at a pace we chose, so `resetRateForTTS` forces 1.0x on the way
  in, and a speed tap arriving *while narration is audible* is **deferred and
  applied when the line ends**, not lost and not applied mid-word.
- **A bridge always starts at zero**, never resumes mid-sentence.
- **A missing bridge cannot stall the queue.** `_playTransitionBridge` catches a
  load failure and advances past it (`_advancePastBridgeFailure`).
- **`player/seam-gap.js`** returns 0 for a bridged seam — narration is the marker
  and silence on top of it would be dead air.
- **A bridged seam is excluded from seam prefetch**, since eligibility is
  `seamGapSec > 0`. **This matters for reading any seam measurement on a narrated
  Foray**: today's 2.0 s warmed seam depends on `html-audio-backend.js` warming
  the next segment during the current one. A narrated Foray gets no warm at
  bridged seams, so the narration item itself becomes the thing that has to cover
  the next segment's load. On the measured numbers that is a *feature* — the
  backgrounded-WebView load was 9.2 s against a 2.0 s beat, and an 8 s bridge
  covers far more of it than the beat did — but it is unmeasured, and it means
  **narration is doing load-hiding work that nothing currently accounts for.**
- **`player/media-session.js`** already handles narration on the lock screen:
  a `kind: "tts"` item is titled `"Up next: <episode>"`, is credited to **Foray
  and never to a publisher**, and never carries a publisher's artwork.

### What is stubbed, missing, or contradicted

1. **Zero narration exists.** `data/forays.json` contains **no narration items at
   all** across all three Forays. Every path above is exercised only by fixtures.
2. **`tools/foray/check-forays.mjs` barely validates narration.** A narration
   item needs a non-empty `id` and nothing else — no script, no asset, no beat
   binding, no slot. **A narration item with no script and no audio passes the
   checker.** Given #226's rule that a script must be rejectable for being
   off-beat exactly as tape is, this is the gap that matters most, and it is in a
   file this work did not touch.
3. **Narration contributes 0 s to runtime accounting**, and `check-forays`
   already warns about it: *"D1 is computed on the tape timeline; narration items
   contribute 0 s, so the budget is measured against a shorter clock than the
   listener's."* A 40-beat Foray with 23 minutes of narration would report a
   runtime ~23 minutes short of what a listener experiences. The narration record
   needs a duration field before any narrated Foray's runtime means anything.
4. **The ~0.5 s TTS padding is implemented nowhere.** `04_VOICE_AUDIO_SPEC.md`
   line 12 asks for it and `player/seam-gap.js` says it is *"baked around a TTS
   item"* — i.e. it belongs to the **asset**, not the player's clock. Nothing in
   `player/` implements it and no asset exists to carry it. **This pipeline owns
   it**: encode leading and trailing silence into the file. It costs no
   characters and it does cost bytes, which is why `projection.mjs` carries
   `padSecPerItem` in the byte arithmetic and not the credit arithmetic. The
   spec divergence itself (0.5 s padding vs the 2.0 s seam beat) is still
   `HUMAN-ACTIONS.md` #3 and is **not** resolved here.
5. **The device-TTS fallback does not exist.** The spec says a missing TTS asset
   falls back to `AVSpeechSynthesizer` reading the why-line. There is **no
   `speechSynthesis`, no `AVSpeechSynthesizer` and no utterance code anywhere in
   the repo** — zero matches. Today a missing asset means the line is silently
   skipped. That is a safe failure and it is not the specified one.
6. **The 8 s bridge budget and the 45 s beat are different jobs, and only one is
   specified.** `04_VOICE_AUDIO_SPEC.md` budgets a transition at **≤ 8 s**. The
   #247 cost sketch budgets an empty beat at **45 s** — 5.6x more. That is not a
   contradiction, because an empty beat carrying content is a category the brief
   never contemplated: the brief only ever imagined narration *joining* tape, not
   *replacing* it. But it means **45 s has no spec behind it** and is the
   founder's assumption under test.

### Recommendations for `player/`, which this work deliberately did not touch

#224 is open there and the seam behaviour is under active measurement, so these
are recommendations rather than changes.

- Give the narration record a **`duration_sec`**, written by this pipeline at
  generation time, and feed it into runtime accounting and `progressSegments`.
  This is the single highest-value player-adjacent change and it unblocks item 3
  above.
- Decide whether the **0.5 s padding** is baked into the asset (this pipeline) or
  spent by the manager. Baking it is cheaper and matches `seam-gap.js`'s comment;
  it also means the padding survives into a downloaded file for free.
- Consider whether a bridged seam should be **prefetched after all**. It is
  excluded today because it gets no beat, but the *reason* for warming is to hide
  a load, and a bridged seam still has a load to hide — it just has narration
  covering it instead of silence. Worth a measurement before a change.

## 2. Hosting — the genuine open question

Narration is the first audio asset we own. Every segment today streams from one
of ~41 publisher CDNs and the repo stores only URLs and timestamps.

### 2.1 The finding that decides it: `media-src https:` blocks bundled audio

`index.html`'s CSP is:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:;
media-src https:; connect-src 'self' https://…supabase.co; …
```

`media-src` is **`https:` with no `'self'`, no `capacitor:` and no `blob:`.**

This is the **exact bug `img-src` already had and had fixed.** `docs/mobile-shell.md`
§2.3: `img-src` gained `'self'` because the iOS shell's origin is
`capacitor://localhost`, a custom scheme, and *"the app's own bundled icons match
neither `https:` nor `data:`. They would be blocked outright."*

**Bundled narration audio is in precisely that position.** Under
`capacitor://localhost`, a relative `narration/beat-7.mp3` resolves to
`capacitor://localhost/narration/beat-7.mp3` — which matches neither `https:` nor
anything else in `media-src`, and is blocked.

This is not inference from first principles. **The repo has already measured it,
in a different context and written it down.** `tools/mobile/probe/install-probe.test.mjs`
says the probe page's CSP differs from the shipped page's *in exactly one way* —
`media-src 'self'` instead of `media-src https:` — **specifically so it can play
its bundled tone**, and `tools/mobile/ios-ci.mjs` calls that difference a
*"ONE-LINE, ZERO-RISK obstacle"*. A page needed `'self'` added to
`media-src` to play a local audio file. That is the whole argument.

Two consequences, and the second is the useful one:

- The existing CSP tests would **not** catch this. `shell-invariants.test.mjs`
  asserts only that `media-src` *includes `https:`*. The mechanical test that
  checks every local `href`/`src` in `index.html` against its governing directive
  would not see it either, because a narration URL arrives at runtime from
  `data/forays.json`, not from the markup.
- **Remote `https:` hosting needs no CSP change at all, on web or native.**
  `media-src https:` already permits any https origin. So the counterintuitive
  result: **hosting narration off-origin is the CSP-compatible option, and
  bundling it with the app is the one that needs a policy change.**

### 2.2 The byte arithmetic

One fully narrated Foray, on the inventory and budgets in §3.1:

| | |
|---|---|
| Narration audio | **23.1 min** (22.4 min speech + 1 s padding per item) |
| Characters | **19,712** |
| Bytes at 64 kbps mono | **11.1 MB** |
| Ten Forays | **110.9 MB** |

Bitrate is the only real lever:

| kbps | one Foray | ten |
|---|---|---|
| 32 | 5.5 MB | 55.4 MB |
| **64 (recommended)** | **11.1 MB** | **110.9 MB** |
| 96 | 16.6 MB | 166.3 MB |
| 128 (API default) | 22.2 MB | 221.8 MB |

**64 kbps mono is the recommendation and 32 should be resisted.** Narration sits
directly against publisher tape at every seam, and an audible quality drop at the
join is the exact artefact the 2.0 s beat exists to smooth over. 32 kbps saves
6 MB a Foray and spends it on sounding like a worse product.

### 2.3 The four candidate homes, with numbers

**a) In the repo, served by GitHub Pages.** The zero-new-infrastructure option,
and the one the charter is right to be suspicious of.

The current git pack is **74.85 MiB (78.5 MB)** and the repo contains **zero
committed audio files**. Adding ten Forays' final takes is **+110.9 MB → 2.4x the
repo**. And git cannot delta-compress mp3, so **every regeneration is a new full
blob kept forever**: at the sketch's 3x factor, ten Forays is **+332.6 MB → 5.2x
the repo**, permanently, for audio of which two thirds is superseded. A shallow
clone does not help a contributor who needs history, and `data/` already carries
62 MB of pipeline inputs. **Reject.**

**b) Bundled in the app.** `tools/mobile/prepare-webdir.mjs` **fails** above
**3.00 MB** and the bundle is at **2.63 MB** — **370 kB of headroom.** One
Foray's narration is **11.1 MB: 30x the remaining headroom and 3.7x the entire
cap.** Ten is 110.9 MB. Bundling would require raising the cap by ~37x, and the
cap is the only thing standing between the bundle and the 16 MB classification
file. Plus the CSP change in §2.1. **Reject as a default**; see §2.4 for the one
version of this that survives.

**c) GitHub Releases as a blob store.** Free, out of git history, 2 GB/file. But
asset URLs redirect to `objects.githubusercontent.com`, which makes them awkward
to pin, and the CORS posture is not ours to set — which is the thing #29 already
got stuck on. **Viable fallback, not the recommendation.**

**d) Supabase Storage — the recommendation.** The project already exists and is
**already in the CSP's `connect-src`** (`https://…supabase.co`), so this is not
new infrastructure. It is S3-compatible, CDN-fronted, and **CORS is ours to
configure** — which is the property that makes offline download (#29) possible
for narration when it is not possible for publisher tape.

Cost: 110.9 MB of storage is comfortably inside the free tier's 1 GB. **Egress is
the number that breaks first**, at 11.1 MB per Foray play if nothing caches:

| Quota | Foray plays/month |
|---|---|
| Supabase free, 5 GB | **450** |
| Supabase Pro, 250 GB ($25/mo) | 22,546 |
| GitHub Pages soft limit, 100 GB | 9,018 |

**450 plays/month on the free tier is the real constraint** — not storage, and
not synthesis. It is also the number caching moves, which is §2.4.

### 2.4 "The one asset we can cache freely" — true, and worth less than it sounds

The charter's hopeful note is **correct on rights and half-correct on mechanism.**

**True:** narration is ours. There is no publisher, no licence and no product
principle 3 ("never rehost/proxy/transform episode audio") — that principle is
about *episode* audio, and narration is not an episode. So narration is the one
audio asset we may cache, bundle, pre-download, re-encode, loudness-normalise or
ship in an app binary without a rights question. Everything below is a mechanism
question only.

What it actually buys, per surface:

- **Web: real.** `sw.js` is already cache-first for the shell. Narration can join
  it and become genuinely offline, which converts the 450-plays/month egress
  ceiling into a per-listener-per-Foray cost instead of a per-play one. This is
  the single biggest win available and it needs an `sw.js` cache entry, a
  `foray-v5` bump (already `HUMAN-ACTIONS.md` #9) and nothing else.
- **Native: not by service worker, at all.** Measured on the iOS Simulator,
  `navigator.serviceWorker` **does not exist** under `capacitor://localhost`
  (`hasServiceWorkerApi: false`). There is no SW to add a cache entry to. So the
  native path must be #29's native download tier — and here the ownership *does*
  buy something concrete: **#29 is native-only because of CORS on publisher CDNs,
  and narration has no such problem** because we set its CORS headers. Narration
  is therefore the first asset #29 could download on *web* as well as native.
- **Bundling in the app: still no**, on the arithmetic in §2.3b, and this is
  where the ownership argument runs out. Rights were never the blocker; 370 kB of
  headroom is. A *single* Foray's narration at 32 kbps is 5.5 MB against a 3 MB
  cap — it does not fit even at the quality we should not ship.

### 2.5 The recommendation

1. **Store narration in Supabase Storage**, one object per narration item, keyed
   by the content hash in §4 so the URL changes when the audio does and no cache
   anywhere needs invalidating.
2. **Serve it over `https:`.** No CSP change, web or native. Do **not** bundle.
3. **Write the absolute URL into `data/forays.json`'s narration items.** The
   builder already reads `audio_url`/`asset`.
4. **Encode 64 kbps mono mp3 with the 0.5 s padding baked in.**
5. **Add narration to `sw.js`'s cache list** and bump the generation. This is the
   change that moves the egress ceiling.
6. **Do not commit audio to git.** Commit the cache index (§4) instead: text,
   diffable, and enough to prove what was generated from what.

## 3. Cost — checking the numbers I was given

### 3.1 The inventory, which was missing a third of itself

The sketch counted **one** category of narration: 34 beats × 45 s. There are
three, and two are forced by rules that already gate the pipeline.

1. **Beat narration.** The 40-beat spine came back 6 strong / 10 thin / 24 empty,
   and 24 + 10 = the 34 the sketch used. Modelled here as 24 × 45 s + 10 × 20 s
   rather than a flat 34 × 45 s, because a thin beat has tape to set up and an
   empty one has content to carry.
2. **Cross-episode bridges — rule X1, and the sketch omits it entirely.**
   `docs/curation/segment-length-rules.md` line 956: *"cross-episode seam always
   carries narration"*, tier A, gate **yes**. Not optional. **Measured** from
   `data/forays.json` against `data/segments.json` by comparing `item_id` across
   consecutive segments:

   | Foray | segments | episodes | cross-episode seams |
   |---|---|---|---|
   | `grilling-history-1` | 32 | 9 | **16** |
   | `grilling-history-2` (shipped) | 10 | 6 | **5** |
   | `capital-types-1` | 22 | 8 | **10** |

3. **Elision bridges — rule M6.** Line 955: *"elided span > 5 min ⇒ narration
   required, silence not sufficient"*, gate **yes**. **Counted as zero, and that
   is a known undercount** — the elision spans are not recorded in a form the
   tool can read. The projection says so in its own output rather than modelling
   it as absent.

**One honest hole:** a beat narration sitting between two segments from different
episodes already bridges that seam, so some X1 bridges are absorbed by category 1
and counting both double-counts. How many depends on an interleaving nobody has
authored. `bridgeAbsorption` is an explicit 0-1 input defaulting to **0.5, which
is a guess and is labelled as one.**

### 3.2 The 840 chars/min figure: defensible, at the slow end, and slow is the wrong direction to err

**It cannot be verified against our own narration, and it is worth being clear
why.** No narration audio exists, and `data/transcript-availability.json` records
that transcript **bodies are never fetched or stored** (#104) — so there is no
paired text-and-duration anywhere in the repo to measure a speaking rate from.
The 840 figure is a standard speaking-rate estimate and it stays one.

What *can* be done is decompose it. `chars/min = chars-per-word × words-per-minute`,
and one of those factors is measurable on the copy we would actually narrate:

| corpus | words | chars | **chars/word** |
|---|---|---|---|
| ASR anchors in `data/segments.json` — real transcribed speech from our sources | 1,890 | 10,160 | **5.376** |
| `why` lines — our own written copy, closest thing to narration | 1,008 | 5,924 | **5.877** |
| repo editorial prose | 14,806 | 85,153 | **5.751** |

**Our written register is denser than speech.** So:

- 840 chars/min implies **143 wpm** at our measured density. That is inside
  documentary-narration practice (~130-150) and below audiobook convention
  (~150-160). **Not wrong.**
- At 150 wpm — the overlap of the two conventions — our density gives
  **882 chars/min**.
- And **the provider's own figure is higher than both**: the pricing page quotes
  10,000 credits as ~10 minutes and 121,000 as ~121 minutes, i.e. exactly
  **1,000 credits per minute**, which at 1 credit/character is **1,000
  chars/min**.

**The direction of the error matters more than its size.** Characters are billed
and the budget is a *duration*, so **a low chars/min rate understates the
character count and therefore understates cost.** 840 is the cheapest of the
three readings.

**Verdict: 840 survives as defensible but should not be the planning number. Use
1,000** — it is the provider's own, it errs expensive, and the whole span is only
19% wide:

| chars/min | chars/Foray | cost/Foray (1x) | 10 Forays at 3x |
|---|---|---|---|
| 760 | 17,024 | ~$0.85 | ~$25.54 |
| **840** — the sketch | 18,816 | ~$0.94 | ~$28.22 |
| 880 — our measured density at 150 wpm | 19,712 | ~$0.99 | ~$29.57 |
| 940 | 21,056 | ~$1.05 | ~$31.58 |
| **1,000** — the provider's own implied rate | 22,400 | ~$1.12 | ~$33.60 |

### 3.3 The tier figures: two are wrong, and one of them removes an option

Re-verified against the live pricing page on 2026-08-18. The scraped file in
`data-local/corpus/markdown/040-elevenlabs-pricing-official.md` **has no date
anywhere in it** — only a `url:` and a `fetched: … (200)` header — so it could not
be aged, only re-checked. **Every tier name, price and credit figure in it still
matches the live page. It has not drifted.** But it carries a trap, and the
sketch inherited it.

| Tier | Monthly | Credits | Commercial licence |
|---|---|---|---|
| Free | $0 | 10,000 | **NO** |
| **Starter** | **$6** | 30,000 | yes |
| Creator | **$22** (not $11) | 121,000 | yes |
| Pro | $99 | 600,000 | yes |
| Scale | $299 | 1,800,000 | yes |

1. **Creator is $22/month, not $11.** The pricing card renders as
   *"$22 First month 50% off / $11per month"* and a scrape reads $11 as the
   price. The FAQ on the same page disambiguates: *"Creator $22 (121,000 credits,
   $11 for the first month)"*. **So the "$6-11/month tiers" the sketch aimed at
   contain exactly one standing tier: Starter at $6.** Annual billing is 10x
   monthly, which does put Starter at a $5/month equivalent.
2. **Free has no commercial licence, and this removes an option nobody costed.**
   Verbatim: *"The free plan does not include a commercial license and cannot be
   used for any commercial purpose."* Free also requires attributing
   `elevenlabs.io` in the title. **So there is no free pilot whose output can
   ship.** The lowest usable tier is Starter, $6.
3. **"One credit per character" is right as a ceiling and may be half.** True for
   all models in the UI. For **API** generations on Flash/Turbo the FAQ says
   *"between 0.5 and 1 credit per character"*, `docs/models` says Flash v2.5 is
   *"50% lower price per character for API generations"*, and the API price list
   is $0.05/1K vs $0.10/1K — a clean 2x. **But no primary page publishes a
   numeric per-model multiplier**, so 0.5 is strongly-implied-and-uncited. The
   tool reports a band rather than a point.
4. **A second multiplier axis exists and is unquantified.** The phrase *"excluding
   credit multipliers"* refers to Voice Library community voices, whose owners set
   a multiplier that stacks on the model rate. The mechanism is documented; the
   values are not published anywhere I could reach. **A community voice can cost
   more per character than the model rate implies** — a reason to prefer a
   first-party voice, and a live unknown rather than a solved input.
5. **Rollover is real and useful here.** Unused credits roll over up to two
   months, to a ceiling of 3x the monthly quota. Narration generation is bursty —
   a Foray is authored and then voiced in one go — so a tier can absorb about
   three times its monthly number.
6. **Could not verify: the per-1,000-credit overage rate.** It is deliberately
   not public (*"displayed when you enable usage based billing"*), and the primary
   help-centre host returns HTTP 403 to automated fetches. Figures circulating on
   third-party blogs are not recorded as fact. The best *primary* proxy is the
   pricing page's "Extra minutes" row: ~$0.20/min on Starter.

### 3.4 So is the spend a rounding error? Yes.

**Ten fully narrated Forays, with the sketch's 3x regeneration factor, cost about
$30 of synthesis. One time.**

Even at the most expensive reading in every dimension — 1,000 chars/min, no Flash
discount, zero bridge absorption — it does not reach $70. A single Foray is
**~$1**, or ~$3 with 3x regeneration.

**This changes how much ceremony the decision deserves.** The right framing is not
"can we afford narration" but "which tier gives enough monthly throughput", and
that is a much smaller question:

- **Starter, $6/mo (30k credits)** covers **one Foray per month with no
  regeneration**. With rollover, one Foray at 1.5x regeneration. Too slow for a
  corpus build, fine for a pilot.
- **Creator, $22/mo (121k credits)** covers **~two Forays a month at 3x
  regeneration** — the right tier for actual production.
- **Pro, $99/mo (600k credits)** does the whole **ten-Foray corpus at 3x in a
  single month**, and on the API Flash rate (~0.5 credits/char) with a good
  margin. Cancel after.

**Recommendation: start on Starter ($6) to voice two or three beats and hear
whether the voice is right at all — that is a $6 question, not a $99 one. Move to
Creator or a single month of Pro once the voice is settled.** The regeneration
factor is where the real money is, and it is bought down by getting the voice and
the script right on a handful of beats before generating 34 of them.

**The thing actually worth being careful about is not the money.** It is #226's
rule: *a narration script must be rejectable for being off-beat, exactly as tape
is.* 34 fluent narration beats are far more expensive to un-ship than to
generate, and `check-forays.mjs` currently validates a narration item's `id` and
nothing else (§1, item 2). **The review gate is the expensive part of this
pipeline, not the credits.**

## 4. Idempotence and the cache-invalidation rule

`tools/narrate/cache.mjs`. A re-run must never re-bill for an unchanged script.

**A cache entry is keyed by a sha256 of exactly four things**, and is invalidated
by exactly those four, each of which genuinely produces different audio:

1. **the script text**, canonicalised — a single character of punctuation counts,
   because punctuation is prosody to a TTS engine and is billed besides
2. **the voice id**
3. **the model id**
4. **the output format** (bitrate / sample rate)

**And nothing else.** Re-running the pipeline, re-ordering beats, renaming a beat,
re-titling the Foray, editing a `why` line, moving a script between Forays, or
changing the estimate's chars-per-minute rate all leave every key untouched.
**Beat identity is deliberately not in the key**: the same sentence voiced for two
beats is one billable generation, and keying by beat would pay twice for one file.

Two ways a cache like this leaks money, both closed:

- **Canonicalisation drift.** If the key hashed raw text while the request
  submitted normalised text, re-saving a script in an editor that flips LF to
  CRLF would change every key and re-bill the whole Foray, with no audible
  difference and nothing visible in a diff. Both the key and the payload come
  from one `billableText()`, so **a line-ending change is a cache hit.** This is
  not hypothetical: `.gitattributes` records a real CRLF incident in this repo,
  and `git add` on these very files emitted CRLF warnings. A `\r` per line on a
  34-beat Foray of ~40-line scripts is ~1,360 billable, inaudible characters.
- **A key that omits an input which changes the audio**, so a voice or model
  switch silently serves the old narrator from cache — cheaper, and worse, because
  it ships the wrong product. `assertKeyInputsComplete()` therefore **throws** if a
  caller passes any generation parameter this module does not know how to hash.

**A dry run never writes cache entries.** A dry run that recorded them would make
the next run believe the audio exists and skip it forever — a Foray shipping with
no narration and no error. That is the most damaging bug available here and it has
its own test.

The index is committed; the audio is not. It is text, diffable, key-sorted for a
stable diff, and enough to prove what was generated from what.

## 5. What `tools/narrate/` is, and how a key makes it real

| File | Job |
|---|---|
| `billable.mjs` | The payload definition. One `billableText()`, plus char counting, duration and byte estimates |
| `cache.mjs` | Content hashing and the invalidation rule in §4 |
| `adapter.mjs` | The dry-run adapter. `buildRequest()`, `plan()`, `planForay()`, and a `synthesize()` that refuses |
| `projection.mjs` | Cost before any script exists — the §3 inventory and arithmetic |
| `pricing.json` | The verified snapshot, with provenance and every caveat |
| `narrate.mjs` | CLI: `--project`, or a scripts file for exact per-beat counts |
| `narrate.test.mjs` | 32 tests, each naming the one-line mutation that kills it |

```
node tools/narrate/narrate.mjs --project
node tools/narrate/narrate.mjs scripts.json --voice VOICE_ID --cache index.json
```

**The one design idea.** A dry run is worthless if it counts a different string
than the real call sends, so the defence is structural rather than a comment
asking people to be careful: **`buildRequest()` produces the real HTTP request,
and the dry run reports the character count of that request's body.** There is no
second "estimated text" path. To make the estimate wrong you have to make the
request wrong, in the same direction by the same amount — a bug that shows up as
broken audio rather than a surprise invoice. A test hands the adapter a transport
that captures what it was given and asserts the captured body is
character-identical to what the dry run reported.

**Adding a key is the only change needed.** `createAdapter({ apiKey })` flips
`synthesize()` from refusing to posting `buildRequest()` through an injected
`transport`. No other file changes. `transport` is deliberately **not** defaulted
to `fetch`, so a missing argument cannot become a live paid call.

**What has never executed:** the request shape is transcribed from the published
API reference and has **never been sent to the provider**. Expect the first real
run to need a correction there, and treat that as the plan rather than a defect.

## 6. What this pass could not settle

- **The speaking rate of our narrator.** Not measurable until something is
  voiced. One beat synthesised at Starter would settle it, and would also settle
  the 45 s beat budget.
- **The per-model credit multiplier**, and the Voice Library multiplier entirely.
- **The per-1,000-credit overage rate** — not public, primary source 403s.
- **Whether 192 kbps needs Creator or Pro.** The API reference says Creator; the
  pricing page advertises it as a Pro upgrade. Unresolvable from public sources.
  Irrelevant at the recommended 64 kbps.
- **How much of rule X1 beat narration absorbs** — needs an authored interleaving.
- **Rule M6's elision bridges**, a known undercount.
- **Whether `media-src` blocking bundled audio on `capacitor://localhost` is
  observed.** It is inferred — from the `img-src` precedent in
  `docs/mobile-shell.md` §2.3, and from the probe page needing `media-src 'self'`
  to play its bundled tone. **Nothing was executed to confirm it for `media-src`
  specifically.** It also does not gate the recommendation, which needs no CSP
  change; it only rules out bundling, which the 3 MB cap rules out anyway.
