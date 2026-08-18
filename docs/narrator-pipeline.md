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
3. ~~**Narration contributes 0 s to runtime accounting**~~ — **CLOSED, see §1.1.**
   It did, and `check-forays` warned about it: *"D1 is computed on the tape
   timeline; narration items contribute 0 s, so the budget is measured against a
   shorter clock than the listener's."* A 40-beat Foray with 23 minutes of
   narration reported a runtime ~23 minutes short of what a listener experiences.
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

## 1.1 A narration item's duration is now first-class

Item 3 above, closed. The rule lives in **one** function —
`narrationDuration()` in `player/foray-queue.js` — and
`tools/foray/check-forays.mjs` imports it rather than keeping a second copy, the
same discipline `copyRules` is shared under.

**Three sources, in precedence, and the answer always says which:**

| source | `duration_source` | where it comes from |
|---|---|---|
| `duration_sec` on the item | `measured` | **this pipeline stamps it at generation time** from the file it produced. Includes the baked padding, because it is a property of the file |
| the `script` | `estimated` | `docs/curation/narration-craft.md` §0's planning rate, **17 chars/s** — the constant that document derives all six mode budgets from, so the estimate agrees with the budget the script was written to. Rounded to the millisecond, because these values are summed into the clock D1 compares against a 600.000 s window |
| neither | `fallback` | **8 s**, the transition ceiling. Never 0: that was the bug |

**"Absent" now has a defined behaviour and it is not zero.** A missing duration
used to be free, silently, everywhere. It is now the 8 s ceiling on a bridge —
long rather than short on purpose, because an over-counted bridge lands a resume
slightly early and re-hearing four seconds of a narrator is recoverable where
skipping past tape is not — and the builder warns. `check-forays.mjs` **rejects**
the item outright, so the fallback should never be reached by anything that
passed CI; it exists so a hand-edited or half-deployed document degrades to a
visible over-estimate rather than an invisible omission.

**What the checker now rejects**, where it previously validated `id` and nothing
else:

- a narration item with **neither a `duration_sec` nor a `script`** — the
  headline: nothing can say how long it is, so it played for real seconds and
  cost zero
- a `duration_sec` that is **not a positive finite number** (`0`, `-12`, `"40"`,
  `NaN`) — `"40"` is what a hand-edited JSON file produces, and string arithmetic
  makes a runtime a concatenation rather than a sum
- a **script** under narration-craft's **50-character Hinge floor**, which is what
  a placeholder looks like. Checked in characters, not seconds, and only where a
  script exists: the floor detects a stub, and a *measured* 2.5 s recording of a
  legal 50-character Hinge is a fact about a file rather than a placeholder. Real
  TTS of 50 characters lands anywhere in roughly 2.5-3.5 s, so a seconds floor
  would have become a routine false positive the moment `tools/narrate/` started
  stamping durations. narration-craft settles which unit is authoritative: "the
  word budgets are the primitive"
- an asset that is **not `https:`**, or that carries a **token** — the same two
  lexical checks every `segment-sources` audio_url gets, now that this field is
  load-bearing
- one over the **180 s Carry hard max** ("the narrator is never the longest item
  in the Foray"), which is also dropped from the clock rather than left to flip
  the D1 band and bury the real error under artefacts of it
- a **duplicate narration id**, which `buildForayQueue` otherwise silently
  rewrites to `${forayId}#${index}` — a safe failure and a baffling one
- a **`slot` the Foray does not declare**, and a bridge that **opens** a Foray
  with no slot at all: it has no preceding item to inherit one from, so it renders
  at the bottom of the running order instead of the top

Past the **150 s soft max** it warns, and it warns whenever part of D1's clock is
*estimated* rather than measured — a D1 verdict resting on a character count is
only as good as the speaking rate §6 says nobody has measured yet.

**One thing it deliberately does NOT reject: an unvoiced bridge.** A narration
item with no usable `audio_url`/`asset` is **excluded from the clock and warned
about** (and counted as `narration_unvoiced` in the report, so nothing pretends it
does not exist), because `buildForayQueue` *drops* it so a missing line cannot
stall a Foray — and if the checker counted what the player will not play, the two
gates would demand different `runtime_sec` values and one of them would be
permanently red. `player/foray-playback.test.js` asserts `totalSec` matches the
committed `runtime_sec` to within a second, so this is not hypothetical.
Rejecting it outright would also forbid the ordinary pre-audio state. Note what
this does not weaken: the rejection above is about an item that *plays* and costs
nothing; one that plays nothing and costs nothing is consistent.

**"Usable" is `audio_url ?? asset`, copied from the player verbatim rather than
paraphrased, and this is the subtlety that survived one review.** `??` falls
through only on `null`/`undefined`, so a present-but-useless `audio_url` — `""`,
`"   "`, `0`, `false` — *shadows* a perfectly good `asset` and the player drops
the item. The first version of this check asked "is either one non-empty", saw the
good `asset`, and counted seconds the player would never play: the same gate
divergence, on a narrower trigger. A test now asserts the two gates agree on nine
combinations, including all four shadowing cases.

**Is a bridge a D1 segment start? No — and the clock is still the listener's.**
`segment-length-rules.md` §5c caps "the number of **segment starts**" in "any
rolling 600-second window of Foray **playback**". Those are two different words
and the fix turns on both:

- *Not a start.* A narration item is not a segment; every companion rule in the
  same box is about tape. The rule's mechanism is §2a's non-habituating
  re-orientation cost — an unfamiliar voice, room and level, unannounced — and a
  bridge is the opposite of unannounced: §6b makes narration the *marker* of the
  move, and `player/seam-gap.js` already spends **0 s** of silence at a bridged
  seam for exactly that reason. Counting the bridge would charge D1 twice for one
  move. It is also the same voice at the same level every time, in every Foray.
  And narration is *already* budgeted, separately and more tightly, by
  narration-craft §0's ≤ 25 % share, 2-in-a-row cap and own anti-uniformity rule;
  a D1 start would be a second budget on the same quantity.
- *But it occupies the clock.* §5c says "playback", so a bridge's duration
  advances the window and sets the budget band.

Net effect, stated plainly because it cuts both ways: within a band D1 gets
**easier** to pass, since the same starts spread over a longer clock; at a band
edge it gets **harder**, since 44 minutes of tape plus 8 of narrator is a
52-minute Foray and drops from N=8 to N=6. Both are §5c's own text. **If the
founders want a bridge to cost a cut, it is one line** — push the clock for a
narration item too — and the test that proves the current ruling names that
mutation.

**Two clocks, kept apart.** `runtime_sec` is the listener's (tape + narration)
and is what the data file must state; the per-segment rules — D2, D3's mean,
D5's spread, L2/L3/L4, M3, and **M4's denominator** — all stay on the tape sum,
because they are rules about tape. M4 especially: dividing an episode's seconds
by the listener's clock would let a Foray buy its way under the 25 % cap by
adding narrator, without rebalancing the sourcing by one second.

**Where it propagated.** `itemRuntimeSec()` is now the only definition of "how
long is this item". `forayRuntimeSec`, `segmentStarts`, `segmentAtElapsed`,
`forayElapsed` and `progressSegments` call it directly; `app.js`'s `segLenOf`
reaches it through `ForayPlayer.itemLen` on the bridge, since `app.js` is a
classic browser script and cannot import from `player/`. There were **three**
private copies of that subtraction — `forayRuntimeSec`'s inline reduce,
`foray-resolve.js`'s `lengthOf`, and `app.js`'s `segLenOf` — and narration was
worth 0 s in all three. Which is the point: copies of a rule do not fail
independently, they fail identically and then get fixed one at a time.

A bridge gets a `progressSegments` row with a real `durationSec` and a **null
id**: it has to have the row, or every segment after it claims a Foray-clock
start earlier than the listener reaches, and it must not have an id, or a stored
row could anchor a resume to a line that never resumes mid-sentence.

`resolveForay` also gained **`tapeSec`** — seconds of somebody else's audio,
which is a different question from how long the Foray is and has a different
consumer. `forayCredits` sums per-show seconds and the narrator has no publisher
to credit, so attribution is owed against `tapeSec` and not `totalSec`. It is
exposed rather than left to each caller to re-derive, which is how the two clocks
got conflated in the first place.

**Three adjacent defects found in review and fixed.**

1. `foray-resolve.js` recovered an item's authored position by parsing
   `${forayId}#${n}` out of its queue id. A narration item keeps its *authored*
   id (`nar-7`), so the parse returned null and the bridge was reported
   `playable: false` with reason "not queued" — a running order would have shown
   it as dropped. (Not *every* bridge: one whose id was blank or duplicated got
   the positional id and parsed fine.) Queue items now carry `ord`.
2. **`app.js`'s `segLenOf` measured a bridge as 0 s** while `stripElapsedAt`
   mapped a click onto `totalSec`, which now includes it. On a 100 s + 40 s + 60 s
   Foray the strip's bars summed to 161 units against a 200 s clock, and a click
   on the left edge of the third bar resolved to 125.5 s — 14.5 s before that
   segment begins. The bar's width, its fill and the click's destination now come
   from one number again.
3. **`forayElapsed` froze the Foray clock for a bridge's whole length.** It
   subtracted `start_sec` to convert a playhead into an offset, and a narration
   item has no in-point — it is a whole file of our own that always starts at
   zero — so a missing `start_sec` read as "no progress". Up to 180 s of a
   transport display that does not move, and any progress row written during a
   bridge storing the bridge's start.

Also, a bridge now **inherits the slot it plays inside** when it does not declare
one. `groupBySlot` groups on `slot`, so a null one collected every bridge into a
trailing untitled section — invisible while bridges were reported unplayable, and
a running order out of authored order now that they are not.

**Still not decided here**, and both are recommendations to the founder rather
than changes:

- **0.5 s padding vs the 2.0 s seam beat** (`HUMAN-ACTIONS.md` #3). The runtime
  work needed no number: the beat is wall clock the manager spends and has never
  been part of authored runtime, and the padding is baked into the asset, so a
  *measured* duration carries it for free while an *estimated* one deliberately
  does not guess it. `player/seam-gap.js`'s existing 2.0 s is untouched.
  **Recommendation: keep both, as #3 already argues** — they do different jobs,
  and a measured `duration_sec` makes the question invisible to the clock.
- **The ≤ 8 s transition budget vs 12 s where an attribution is required.**
  narration-craft §0 and §2b have **already ruled** for the 12 s exception, on the
  argument that naming a source properly costs 8-12 words before the bridge says
  anything; `04_VOICE_AUDIO_SPEC.md` still says 8 s flat. That reasoning is not
  re-litigated here. What is genuinely open is that **nothing enforces either
  number** — the checker gates only the 180 s hard max, because a per-mode
  transition budget needs a `mode` field the schema does not have.
  **Recommendation: write the exception into the brief so it stops contradicting
  the ruling, and treat "is the exception worth a `mode` field" as the real
  question.** Rejecting a script for being off-mode is #226's rule and needs that
  field; it is the next piece of the review gate, not part of this change.

### Recommendations for `player/`, which this work deliberately did not touch

#224 is open there and the seam behaviour is under active measurement, so these
are recommendations rather than changes.

- ~~Give the narration record a **`duration_sec`**~~ — **done, §1.1.** What is
  left on this pipeline's side is the *stamping*: `tools/narrate/` must write
  `duration_sec` from the audio it generated, or every narrated Foray ships with
  an `estimated` clock and the checker says so on every run.
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

**The quota figures in that table were NOT verified in this pass.** Only the
ElevenLabs pricing was re-fetched (2026-08-18). Supabase's 1 GB / 5 GB free and
250 GB Pro allowances, GitHub Pages' 100 GB soft bandwidth limit, and the 2 GB
per-file Release limit are quoted from general knowledge and should be confirmed
before anyone commits to a tier. **The 11.1 MB per play is ours and is
arithmetic**, so the shape of the table survives whatever the quotas turn out to
be: storage is trivial, egress is what binds, and caching is what moves it.

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

**A dry run never writes cache entries**, and **neither does a failed call.**
Both are the same bug wearing different clothes: an entry written for a
generation that did not happen makes every later run believe the audio exists and
skip the beat, so the Foray ships with a silent gap and no error anywhere.

The second half of that was live until the review of PR #253 caught it, and it
took **two** attempts to fix, which is worth recording because the first attempt
read as correct.

`transport` **wraps** `fetch` in production — it is not `fetch` itself — and
**`fetch` resolves for 429 and 500**, rejecting only on a network-level failure.
So the natural `await transport(...)` followed by `cache.record(...)` caches
rate-limits and server errors as successes.

The first fix accepted any result whose `ok` was not literally `false` and whose
`status` was absent or 2xx. That sounds like a check and is not one: the most
natural wrapper anyone would write —

```js
const r = await fetch(...); const b = await r.arrayBuffer();
return { bytes: b.byteLength };          // forgets ok and status
```

affirms nothing, denies nothing, and sailed straight through, caching a 429's
JSON error body as voiced audio. **Absence of contrary evidence is not a positive
assertion.**

So the rule is now genuinely positive. A generation is recorded only if the
result **affirms** success — `ok === true`, or a numeric 2xx `status` — with no
contradicting signal, and returns real audio bytes. An `ok` that is present but
not strictly `true` contradicts; so does a status that is non-2xx, or present but
unreadable. Bytes are counted from a number, `byteLength` or `size`, so a
`Buffer`, `Uint8Array`, `ArrayBuffer`, `DataView` or `Blob` all work — but not a
bare `.length`, which would let a forwarded error string or a `content-length`
header masquerade as audio.

Anything else records nothing, so a retry re-bills — **which is the correct
direction, because paying twice is recoverable and a permanently skipped beat is
not.** The corollary for whoever writes the real transport: it must read the
response body and forward `ok`/`status`. Handing `fetch` itself to the adapter
yields a bare `Response`, whose body has never been read, and is rejected.

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
- **Every hosting quota except our own byte arithmetic** — see the note in §2.3d.
  Supabase's and GitHub's allowances were not re-fetched.
- **How much of rule X1 beat narration absorbs** — needs an authored interleaving.
- **Rule M6's elision bridges**, a known undercount.
- **Whether `media-src` blocking bundled audio on `capacitor://localhost` is
  observed.** It is inferred — from the `img-src` precedent in
  `docs/mobile-shell.md` §2.3, and from the probe page needing `media-src 'self'`
  to play its bundled tone. **Nothing was executed to confirm it for `media-src`
  specifically.** It also does not gate the recommendation, which needs no CSP
  change; it only rules out bundling, which the 3 MB cap rules out anyway.
