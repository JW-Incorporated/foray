# Sourcing Foray #2 — the types of capital and funding available to startups

Target: **~1 hour of finished Foray**, which at the measured 12% yield
(`docs/curation/grilling-foray.md`) and the 75–180 s band
(`docs/curation/segment-length-rules.md` §0) means roughly 30–40 segments off
**~8 hours of tape**. This pass surfaced **25.11 hours** across **65 candidate
episodes** — 30 of them (**6.16 h**) already carrying a free timed transcript, and
35 (**18.95 h**) queued for our own ASR in
`docs/curation/foray2-asr-manifest.json`.

Companions: that manifest,
`docs/adr/0008-ad-tolerance-and-timestamp-precision.md` (the ad rule this pass
applies), `docs/curation/grilling-foray-sourcing.md` (the method this pass
copies), `docs/curation/segment-length-rules.md` (the rule in §0.3 below).

---

## 0. Headline findings

1. **The subject is over-served on one side and near-empty on the other.** Every
   arc slot about *venture capital* had a dozen candidate shows. Bank debt,
   revenue-based financing, corporate VC and grants each turned up one or two
   shows in what this pass could see — Apple's search plus ~25 feeds — and §5
   records those negatives with their scope. They are the most useful part of
   this document.
2. **VC Minute is the largest free-transcript find, and the relative cap caps
   what it can do.** 275 episodes of 60–290 s, **24 probed at ratio 1.0000
   (N=2)**, every one shipping a timed **VTT + SRT + JSON** with speaker labels.
   Read §0.3 before treating that as the answer to the CPU budget: it is not.
3. **The 20% relative cap makes VC Minute a `quote`-tier source, not a segment
   source.** `segment-length-rules.md` §0 caps a segment at **≤ 20% of its source
   episode's duration** — "above that we are not excerpting, we are
   rebroadcasting". Applied to the 24 shortlisted rows: **10 of 24 have a 20% cap
   *below* the 30 s hard floor and can yield no compliant segment at all**, and
   the remaining 14 cap out between **30 s and 51 s** — clearing the `quote`
   role's 30 s floor (four of them only just, at 30.0–33.2 s, i.e. below even the
   quote band's 35 s bottom) and never reaching the 75–180 s target band. D4 then caps quotes at
   ≤20% of segments, at most 2 adjacent, so a 35-segment Foray admits **≤ 7** of
   them: call it **~5 minutes of the hour**. Real value, free, and a fraction of
   what the raw hour count suggests. **The consequence runs the other way from
   what you would expect: this makes the ASR manifest *more* load-bearing, not
   less.** The free inventory that is *not* cap-constrained is six episodes and
   **5.02 h** (Run the Numbers ×2, Bootstrapped Founder ×3, Startup Therapy ×1).
4. **The Startup Solution (Threshold / Heidi Roizen) is the mechanics backbone.**
   41 episodes, ten on slot, all measured **1.0000 ad-free** across N=2 probes.
   No transcripts, so it is the biggest ASR line item — **2.48 h across five arc
   slots**.
5. **One show died on us.** NCI's **SBIR Innovation Lab** ships 16 timed SRTs and
   would have owned the grants slot outright. **Every enclosure tested — 3 of 26 —
   returns HTTP 404** (§5.1). This is the BBQ Nation failure mode again, and the
   transcripts fetching fine is exactly what makes it a trap.
6. **Libsyn injects, and by a per-episode amount.** The Full Ratchet's inserts
   measure 12.4 s, 22.8 s, 29.3 s and **136.7 s** on different episodes of the
   same feed (§3b). A show-level verdict would have been wrong in both directions.

---

## 1. Method

Same instruments as the grilling pass, with the ADR-0008 rule applied rather than
the superseded binary gate.

- **Ad delta.** Delivered bytes vs feed-declared enclosure length via a **2-byte
  ranged GET**, reading the true total from `Content-Range`
  (`tools/transcribe/ad-inflation.mjs`). **HEAD lies on ad-inserting hosts and was
  not used.** Every candidate below was probed **N=2** on the **same episode**, per
  ADR-0008 Decision 2 — N=1 bounds nothing.
- **Delta in seconds, not ratio.** `delta_sec = duration × (ratio − 1)`, using
  `itunes:duration`. Ratio is a screen; seconds are the measurement (ADR-0008
  option 2). Per-row ratios are omitted from the manifest because both byte counts
  are recorded on every row and the ratio is derivable from them.
- **The pad, and the two assumptions in it.** `pad = delta_max + margin`, margin ≥
  the observed spread.
  - **Every episode probed here returned byte-identical totals on both probes —
    observed spread 0.0 s.** That is weaker evidence than it looks: Gastropod's two
    probes differed by 33.4 s, so a zero spread means *we did not observe
    variance*, not *there is none*.
  - Where the delta is non-zero, the pad quoted applies ADR-0008's stated and
    **explicitly unmeasured** assumption that the margin scales with the delta at
    Gastropod's 0.505 coefficient, i.e. `pad ≈ 1.505 × delta_max`.
  - Where the delta is 0.0 s the pad is quoted as **0.0 s, which carries no margin
    and is therefore a point estimate** — the exact statistic ADR-0008 §"The pad
    must be an UPPER BOUND" forbids. These are DAI-capable hosts (Libsyn,
    transistor, Buzzsprout) that simply were not injecting on the episodes and days
    we sampled. **A non-zero nominal margin may be required before any of these
    rows plays**; ADR-0008 open question 3 is where that gets decided, and nothing
    in this document should be read as settling it.
- **Transcripts.** `<podcast:transcript>` tags read from the feed, then **fetched
  and eyeballed**. A declared transcript is not a transcript: Raw Selection's feed
  declares `text/html` and the `.vtt` sibling returns **HTTP 404 with a 2,877-byte
  body** — a 404 that would have looked like a success to anything checking size.
- **Content gate.** Someone has to be *explaining* something, audio-only, with
  sourced expertise. Transcripts read where they exist; detailed show notes where
  they do not; both stated per row.
- Requests: `ForayBot/0.1 (+https://github.com/JW-Incorporated/foray;
  wjduvall@gmail.com)`, 2 bytes per probe. **No audio was downloaded and nothing
  was transcribed.**
- Discovery: Apple's keyless `itunes.apple.com/search` (option B of
  `grilling-foray-sourcing.md` §6), then direct feed fetch and title/description
  scan over ~25 feeds. Measured on **2026-08-16**.

**Founder ruling applied: English only.** No non-English candidate is listed.

---

## 2. The arc

Sixteen slots (fourteen headline subjects; A6 and A11 each split into a filled
and an unfilled half). "Free" means a timed transcript already exists.

| # | Slot | State | Lead source |
|---|---|---|---|
| A1 | The landscape — every kind of capital, and why VC is the wrong default for most | **filled** | Full Ratchet 18 (ASR) + VC Minute 033/150 (free, quote-tier) |
| A2 | Bootstrapping and revenue funding | **filled, free** | The Bootstrapped Founder 309, VC Minute 109/163 |
| A3 | Friends and family | **thin** | Startup Solution *In-law Investors* (ASR); VC Minute 254 is anecdote, not explanation |
| A4 | Angels and syndicates | **filled** | Full Ratchet 33/34 (ASR) + VC Minute 131/151 (free) |
| A5 | Accelerators | **filled** | Full Ratchet 17, YC *How Startup Fundraising Works* (both ASR) |
| A6 | VC by stage: pre-seed → seed → A | **filled** | VC Minute 140/228 (free) + Full Ratchet 14 (ASR) |
| A6b | …and **growth** | **NOT SOURCED** | see §5.2 |
| A7 | Venture debt | **filled, free** | Run the Numbers *Venture Debt Explained* (SRT) |
| A8 | Revenue-based financing | **filled, free** | Bootstrapped Founder 309/328, VC Minute 164/165/166 |
| A9 | Bank debt and SBA lending | **filled (acquisition lending only)** | Acquiring Minds *SBA Lender Roundtable* (ASR); §5.3 on what is missing |
| A10 | Grants and non-dilutive (SBIR, NSF) | **filled, with a caveat** | Feel the Boot 89, Propel(x) NSF (both ASR); VC Minute 075 free but 156 s |
| A11 | Crowdfunding — equity | **filled** | Full Ratchet 40 + CrowdCrux *Atombeam / StartEngine* (both ASR, both priority 1) |
| A11b | Crowdfunding — **rewards, as a form of capital** | **NOT SOURCED** | see §5.4 |
| A12 | Strategic / corporate VC | **filled** | Full Ratchet 235 (ASR); Tank Talks as a demoted second source |
| A13 | Private equity and secondaries | **filled** | Raw Selection ×2, Startup Solution *Secondary Showdown*, Capital Allocators 448 |
| A14 | Mechanics — dilution, preferences, SAFEs vs priced, valuation, control | **filled, part free** | VC Minute ×7 (free, quote-tier) + Startup Solution ×6 + Full Ratchet 10/13/84 |

**On the brief's warning.** A1, A2, A3, A8, A9, A10, A11 and A13 are 8 of the 14
headline subjects and none of them is a VC talking about VC. The VC-side voices
are concentrated in A4, A6, A12 and A14, where they are the right witness. The
biggest anti-monoculture lever is A2/A8, where the best tape is a **bootstrapper
narrating his own funding contract** (Bootstrapped Founder 309) and **a founder
comparing revenue-based investing to VC after doing both** (VC Minute 164–166).

---

## 3. Measured ad delta, per show

`Δ` is per-episode seconds, N=2 probes of the same episode, observed spread 0.0 s
on all. Tier per ADR-0008: PADDABLE if `pad ≤ 120 s`.

| Show | Host | Episodes probed | Δ range | Tier |
|---|---|---|---|---|
| VC Minute | Buzzsprout | **24** | **0.0 s** (24/24 at ratio 1.0000) | PADDABLE |
| The Startup Solution | Libsyn (dest 4055412) | **10** | **0.0 s** (10/10 at 1.0000) | PADDABLE |
| The Bootstrapped Founder | transistor via `2.gum.fm`→op3→pdcn→pdst→podtrac | 3 | 0.0 s | PADDABLE |
| Run the Numbers | anchor.fm / Spotify | 2 | 0.0 s | PADDABLE |
| Startup Therapy | transistor | 1 | 0.0 s | PADDABLE |
| Acquiring Minds | transistor | 1 | 0.0 s | PADDABLE |
| The Private Equity Podcast (Raw Selection) | Buzzsprout | 3 | 0.0 s | PADDABLE |
| Feel the Boot | Blubrry | 2 | 0.0 s | PADDABLE |
| Crowdfunding Demystified (CrowdCrux) | Libsyn (dest 223937) | 1 | 0.0 s | PADDABLE |
| Capital Allocators | `pscrb.fm` prefix → Libsyn | 1 | 0.0 s | PADDABLE |
| Tank Talks | Substack | 1 | 0.0 s | PADDABLE |
| The Propel(x) Podcast | Simplecast | 1 | 0.0 s | PADDABLE |
| Y Combinator Startup Podcast | anchor.fm | 2 | 0.0 s | PADDABLE |
| Startups For the Rest of Us | Castos via `prfx.byspotify.com` | 1 | 0.0 s | PADDABLE |
| **The Full Ratchet** | Libsyn (dest 204448) | **14** | **12.4 – 136.7 s** | 13 PADDABLE, **1 LOCATE-REQUIRED** |
| All About Grants (NIH) | `grants.nih.gov`, self-hosted | 1 | **uncomputable** | **UNTIERED** — see §3c |

**Three things in that table are worth more than the table.**

**a. Three prefix chains that injected nothing on the episodes measured.**
`2.gum.fm → op3.dev → pdcn.co → pdst.fm → dts.podtrac.com → media.transistor.fm`
(Bootstrapped Founder), `pscrb.fm → traffic.libsyn.com` (Capital Allocators) and
`prfx.byspotify.com → episodes.castos.com` (Startups For the Rest of Us) all
delivered byte-exact files. Our `dai_suspected`-by-host heuristic would flag all
three. Five episodes across three chains is not a general finding about prefix
services — it is a reason to measure rather than to infer from the host name.

**b. The Full Ratchet is the counter-example to show-level verdicts.** Same feed,
same destination id, fourteen episodes:

| Episode | Duration | Insert (bytes) | Δ | Pad (1.505×) | Tier |
|---|---|---|---|---|---|
| 17. The Accelerator | 2149 s | 151,580 | **12.4 s** | 18.6 s | PADDABLE |
| 84. The Cap Table p1 | 1752 s | 371,525 | **22.8 s** | 34.3 s | PADDABLE |
| 85. The Cap Table p2 | 1721 s | 371,525 | **22.8 s** | 34.3 s | PADDABLE |
| 14. The Stages of Fundraising | 2450 s | 371,034 | **22.9 s** | 34.5 s | PADDABLE |
| 33. AngelList Syndicate Investing | 2036 s | 371,526 | **22.9 s** | 34.4 s | PADDABLE |
| 10. The Term Sheet (Feld) | 3428 s | 371,064 | **23.0 s** | 34.6 s | PADDABLE |
| 13. The Convertible Note | 3368 s | 371,526 | **23.0 s** | 34.6 s | PADDABLE |
| 40. Crowdfunding (Medved) | 3048 s | 371,526 | **23.0 s** | 34.6 s | PADDABLE |
| 50. JOBS Act Title III | 3190 s | 371,523 | **23.0 s** | 34.6 s | PADDABLE |
| 34. Lone-Wolves vs Syndicates | 1638 s | 591,482 | **29.1 s** | 43.8 s | PADDABLE |
| 199. SPVs & Side Cars | 2756 s | 591,474 | **29.3 s** | 44.1 s | PADDABLE |
| 235. Corporate VC | 3013 s | 591,475 | **29.3 s** | 44.1 s | PADDABLE |
| 18. Fundraise Types & Structures | 2080 s | 877,854 | **52.2 s** | 78.6 s | PADDABLE |
| **426. Venture debt (Spreng)** | 2504 s | 2,118,773 | **136.7 s** | 205.7 s | **LOCATE-REQUIRED** |

The insert is a near-constant **~371.5 KB block** on the 129–131 kbps episodes and
**~591.5 KB** on the 161–163 kbps ones — **≈ 23 s and ≈ 29 s of audio
respectively**. Note these are **two different inserts, not one promo at two
bitrates**: a 23.0 s promo encoded at 162.4 kbps would be 466,900 bytes, not
591,482. Two episodes break the pattern, **both upward**: 18 at 52.2 s, and 426 at
136.7 s — **2.6× the next-largest insert on the feed and 11× the smallest.**
`summariseShow()`'s median across episodes would have reported this show as one
number and been wrong for every row.

**c. NIH's feed declares placeholder lengths, so the row is UNTIERED.**
`All About Grants` declares `9000000`, `11000000`, `13000000`, `14000000` — round
numbers, not file sizes. The byte ratio is therefore **uncomputable**, exactly as
on Megaphone's `length="0"` feeds, and **the "1.2133" a naive ratio produces is a
metadata artefact that must not be written down as ad load.** True delivered size
for *Preparing for Private Investment* is **16,986,608 bytes over 780 s = 174.2
kbps**, one plausible encode. The audio is served directly from `grants.nih.gov`
with no CDN or prefix in front of it, so **there is no third party positioned to
inject** — origin-side insertion is not ruled out by this measurement, and
ADR-0008 grants a tier only from a pad, which cannot be computed here. Recorded as
**UNTIERED, bitrate-implied, no ratio**.

---

## 4. The shortlist

### 4.1 Free timed transcripts — 6.16 h, zero CPU

**VC Minute** — Rich Maloy, SpringTime Ventures. Feed
`https://rss.buzzsprout.com/1970319.rss` · 275 items · **1,100 transcript tags**
(4 formats × 275). Enclosure pattern
`https://www.buzzsprout.com/1970319/episodes/<id>-<slug>.mp3`; transcript pattern
`https://www.buzzsprout.com/1970319/<id>/transcript.vtt` (also `.srt`, `.json`).
GUID is `Buzzsprout-<id>`. **All 24 rows below probed N=2 at ratio 1.0000,
Δ = 0.0 s.** The other 251 episodes on the feed are unprobed.

*Why it clears the content gate:* fetched and read. Timed to the sentence with
`<v Speaker>` labels — e.g. ep 230 opens `00:00:01.000 --> 00:00:04.019
<v Peter Walker>Don't sign a safe that your investor sends you without reading
it.` Every episode is one person making one point; there is no banter to cut.

**Read §0.3 first.** The `cap` column below is `0.2 × duration`, the most a
compliant segment may take. **Ten rows cannot yield a segment at all** (cap below
the 30 s hard floor) and are marked ✗; the other fourteen are `quote`-tier only.

| id | Episode | Dur | cap | Slot | Why it is explanation, not chat |
|---|---|---|---|---|---|
| 13852126 | 164. Exits, Ownership, Alignment and Revenue-Based Finance | 255 s | 51.0 s | A8 | RBF explained by a founder who took it |
| 13608970 | 154. Valuations are Down; Down Rounds Are Up | 252 s | 50.4 s | A14 | Carta data on down rounds |
| 12648326 | 085. Insider Round | 242 s | 48.4 s | A6 | Insider vs bridge, distinguished |
| 13609011 | 156. Option Pools and Exercise Windows | 238 s | 47.6 s | A14 | Dilution from the employee side |
| 13927018 | 172. Valuation Is Only One Part of the Term Sheet | 235 s | 47.0 s | A14 | The argument that terms beat valuation |
| 13852132 | 166. Benefits of RBI vs. Fee-Based Lenders | 227 s | 45.4 s | A8 | Deal terms, side by side |
| 13608990 | 155. Deal Structure and Stacking SAFEs (Peter Walker) | 218 s | 43.6 s | A14 | The stacking problem specifically |
| 13922218 | 171. Key Terms for Founders Negotiating Term Sheets | 213 s | 42.6 s | A14 | Control terms, named |
| 13538103 | 140. Pre-Seed or Seed? Which Are You? | 186 s | 37.2 s | A6 | Defines the stages by what each round buys |
| 13852121 | 163. Bootstrapping on Credit Cards (Curt Nichols) | 180 s | 36.0 s | A2 | The literal instrument, named |
| 13341730 | 131. Angel Investors Are Everywhere and Nowhere | 166 s | 33.2 s | A4 | Why the angel market has no directory |
| 12546535 | 075. Getting Funded On Proof and Winning Grants | 156 s | 31.2 s | A10 | Grant strategy from a grant-funded founder |
| 12900715 | 110. Using CDFIs To Get From Zero To One | 150 s | 30.0 s | A9 | The only CDFI source found in this pass. Read: "contacting your local CDFIs… most of them are government funded" |
| 12900501 | 109. Bootstrapping, Plan B (Brandon Brooks) | 150 s | 30.0 s | A2 | Bootstrapping as strategy, not fallback |
| 13852129 | ✗ 165. Retaining Ownership: RBI vs. VC | 146 s | 29.2 s | A8 | Direct A/B of the two instruments |
| 13567163 | ✗ 150. Don't Take Venture Capital (Abby Mercado) | 146 s | 29.2 s | A1 | Founder arguing the negative case from her own raise |
| 15078193 | ✗ 235. Priced Rounds Clean Cap Tables | 142 s | 28.4 s | A14 | The other side of SAFE-vs-priced |
| 12624401 | ✗ 081. About That Bridge Round | 140 s | 28.0 s | A6 | What a bridge is and what it signals |
| 15837730 | ✗ 254. Friends, Family Fools Round (Sunny Han) | 138 s | 27.6 s | A3 | First-hand: emptied two 401(k)s and borrowed from in-laws |
| 10990743 | ✗ 033. Venture Scale Returns | 136 s | 27.2 s | A1 | States the power law that makes VC unsuitable for most |
| 15037944 | ✗ 229. Seed Crust: Year of the Bridge | 129 s | 25.8 s | A6 | Why bridges became the norm |
| 15037896 | ✗ 230. Seed Crust: The Dangers of SAFEs (Peter Walker) | 106 s | 21.2 s | A14 | Carta's Head of Insights on SAFE risk |
| 15031513 | ✗ 228. Seed to Series A Graduation Rates | 92 s | 18.4 s | A6 | Numbers, not vibes — the graduation rate itself |
| 13567166 | ✗ 151. Getting Sixty Angels to Invest | 91 s | 18.2 s | A4 | Mechanics of assembling a large angel round |

**24 episodes, 4,134 s (68.9 min), of which ≤ ~7 can be used** under D4's
quote budget. Two notes for whoever wires this up:

- **The ✗ rows are not useless, they are unusable *as segments*.** They are ideal
  material for the writer, for a narrator script, or for the `recommend the
  episode` surface that `segment-length-rules.md` names as the correct output when
  the relative cap bites. If the founders want VC Minute to supply more than seven
  slots, that is a request to revisit the 20% cap for sources shorter than ~10
  minutes, and it should be asked as that rather than assumed.
- `MIN_PLAUSIBLE_BYTES = 1_000_000` in `ad-inflation.mjs` would reject an episode
  under ~81 s at this bitrate as implausible. The shortest row here (91 s /
  1,125,662 B = 99.0 kbps) clears it; shorter VC Minute episodes would not.

**Run the Numbers** — CJ Gustafson. Feed
`https://anchor.fm/s/10e7a9a40/podcast/rss` · 311 items · 263 transcript tags
(SRT via `transcript-files.spotifycdn.com`). Both rows Δ = 0.0 s, N=2. **The
relative cap is not binding here** (20% of 3339 s is 668 s).

| Episode | GUID | Dur | Slot |
|---|---|---|---|
| **Venture Debt Explained: How Startup Lending Actually Works (Marshall Hawks)** — enclosure `https://anchor.fm/s/10e7a9a40/podcast/play/116520939/…419466609-44100-2-4ab527ce00e0d.mp3`, transcript `https://transcript-files.spotifycdn.com/0zQCkklNnVgMD364kCW5SV/5DjC7WKsMnun27MqA7d7c4/transcript.srt` | `3fccf152-4766-4449-aa81-4f50f30f5d7d` | 3339 s | **A7** |
| Venture Debt as a Strategic Lever for Growth (Ruslan Sergeyev, Hercules Capital) — enclosure `…/play/114746859/…417091195-44100-2-1c4ee720db2d7de0.mp3` | `substack:post:144565549` | 3316 s | A7 |

*Content gate: passed by reading the SRT.* The lender's actual underwriting logic
is stated out loud — "What lenders are really doing is trying to figure out the
likelihood a company will go on to raise their next equity round." That single
sentence is the whole difference between venture debt and a bank loan, from the
person who writes the cheques. **This is the strongest single row in the pass** and,
given §0.3, the strongest free one by a wide margin.

**The Bootstrapped Founder** — Arvid Kahl. Feed
`https://feeds.transistor.fm/bootstrapped-founder` · 442 items · 870 transcript
tags (VTT + SRT at `share.transistor.fm/s/<id>/transcription.vtt`). All Δ = 0.0 s,
N=2. Relative cap not binding.

| Episode | GUID | Dur | Slot |
|---|---|---|---|
| 309: Funded! — `…/media.transistor.fm/79eb6f73/844d038c.mp3` | `2f7419c6-9a05-4155-96d6-2c4372e6465e` | 1628 s | **A8, A2** |
| 328: Negotiating Bootstrapper Funding with Tyler Tringas — `…/c54b3c3e/b4225957.mp3` | `be5e53db-6c32-4208-9408-2e2cf87e3af4` | 3326 s | **A8** |
| 304: Tyler Tringas — Investing in Bootstrapped SaaS — `…/4d69da05/c7fc067e.mp3` | `a871f7fa-513f-4e61-bbc4-fba66aeff796` | 3666 s | A8 |

*Content gate: passed by reading the VTT.* 309 is a founder explaining the
instrument he just signed — "The biggest problem in traditional VC funding is
this power imbalance… A VC wants to find the unicorn… But the Calm Company Fund
is something entirely different." **328 is the rarest tape in the whole pass: the
actual negotiation conversation between founder and investor, published.** Note
309 carries a baked-in host-read sponsor (`acquire.com`) — no DAI, just don't cut
it.

**Startup Therapy** — Wil Schroter & Ryan Rutan, Startups.com. Feed
`https://feeds.transistor.fm/startup-therapy` · 343 items · **55 SRT + 33 plain
text** (only the newer episodes; "This is BOOTSTRAPPED" has none). Δ = 0.0 s, N=2.

| Episode | GUID | Enclosure | Dur | Slot |
|---|---|---|---|---|
| The Most Expensive Equity Doesn't go to Investors | `86ab3c90-a6b9-462c-b799-049e66fc78a4` | `https://media.transistor.fm/e768bcf1/c8380df1.mp3` | 2781 s | A14 |

*Caveat, stated because it is the show's format:* two hosts in conversation, and
the transcript opens with 40 s of framing before the substance. Real dilution
content, lower density than VC Minute — budget accordingly.

### 4.2 Needs our ASR — the ten highest-value rows

Full list and ordering: `docs/curation/foray2-asr-manifest.json`. Every row below
is measured, N=2.

| Show / episode | Feed | GUID | Dur | Δ | Transcript | Slot | Why it is explanation |
|---|---|---|---|---|---|---|---|
| **The Startup Solution — The Case of the In-law Investors** | `rss.libsyn.com/shows/477477/destinations/4055412.xml` | `f38e0333-4246-49f9-9053-c2b918d66960` | 868 s | **0.0 s** | none | **A3** | Heidi Roizen talks a Stanford fellow out of letting his in-laws pull retirement money into a friends-and-family allocation. The only explanation of F&F found in the ~25 feeds scanned. |
| **The Full Ratchet 18 — Fundraise Types, Sources & Structures (Dave Berkus)** | `rss.libsyn.com/shows/55312/destinations/204448.xml` | `http://fullratchet.net/?p=910` | 2080 s | **52.2 s** | none | **A1** | The taxonomy episode: one of the most experienced US angels enumerating the instruments. This is the Foray's spine. |
| **Acquiring Minds — SBA Lender Roundtable: State of the Market** | `feeds.transistor.fm/acquiring-minds` | `fe9ed980-e127-4368-9989-e5aeefb1d39f` | 4835 s | **0.0 s** | none | **A9** | Three SBA lenders on personal guarantees, equity requirements, forgivable seller notes and SBA rule changes. Lenders explaining lending. |
| **The Full Ratchet 235 — Why Corporate VC Gets a Bad Wrap (Tamara Steffens, Microsoft M12)** | as above | `3b2c8f86-cab6-4b8c-a18e-f47d6da53b28` | 3013 s | **29.3 s** | none | **A12** | A working CVC partner on why founders distrust CVC and what the strategic mandate actually changes. |
| **The Full Ratchet 40 — Crowdfunding & The Socialization of Finance (Jon Medved)** | as above | `http://fullratchet.net/?p=2228` | 3048 s | **23.0 s** | none | **A11** | OurCrowd's founder on why retail capital entered private markets at all. |
| **Crowdfunding Demystified EP557 — Atombeam's StartEngine Strategy** | `rss.libsyn.com/shows/58791/destinations/223937.xml` | `82b3ccc1-97fd-42bd-b2fb-3e0dd93604e0` | 2283 s | **0.0 s** | none | **A11** | $12M raised under Reg A/CF, walked through by the company that did it. The only modern equity-crowdfunding tape found in this pass. |
| **The Full Ratchet 17 — The Accelerator (Troy Henikoff)** | as above | `http://fullratchet.net/?p=887` | 2149 s | **12.4 s** | none | **A5** | Techstars Chicago's MD explaining what an accelerator buys for its 6%. Lowest delta of the 14 episodes probed on this feed. |
| **Y Combinator — How Startup Fundraising Works (Brad Flora)** | `anchor.fm/s/8c1524bc/podcast/rss` | `d67b3344-de0b-4bc9-b5b7-2da20b3bcde7` | 1691 s | **0.0 s** | none | **A5, A6** | A Startup School lecture, not an interview — single speaker, structured, no banter. |
| **Feel the Boot 89 — Non-Dilutive Startup Fundraising: SBIR Grants** | `www.feeltheboot.com/blog?format=rss` | `62101fa71e5c672c42ae55f0:6210296445ccfe2812aaebe8:6438399840f02f5420fa0dc8` | 2955 s | **0.0 s** | none | **A10** | See the caveat below — but the mechanics are all stated: 11 agencies, ~$4B/yr, Phase I ≈ $275k, Phase II ≤ $1.75M, <500 employees, "over 80% of people who apply on their own get rejected for non-compliance". |
| **The Startup Solution — How to Think About Dilution** | `rss.libsyn.com/shows/477477/…` | `11352043-2f95-48bb-8042-3fc684c664a6` | 946 s | **0.0 s** | none | **A14** | 15:46 on the single mechanic founders get wrong most often. |

**Two content caveats on that table, both of which cost a listen to resolve:**

- **Feel the Boot 89 is a vendor-adjacent interview and a video-first show.** The
  guest is Caroline Arzoo of OmniSync, which sells an SBIR application platform,
  and the episode pitches it. The SBIR *mechanics* above are verbal and cleanly
  cuttable; the platform passages are not usable. Feel the Boot also publishes to
  YouTube, so **audio-only sufficiency is unverified**. Note this is a **new** risk
  axis for this project, not a precedent: `grilling-foray-batch-1.md` records
  "Nothing failed the audio-only gate", and the four content rejections on file
  were for suspected machine generation, SEO filler, an affiliate-plugging host
  segment with no guest, and two hosts reminiscing. There is nothing to lean on
  here — listen to five minutes before spending 49 minutes of CPU.
- **The Startup Solution's transcripts could not be read.** `threshold.vc` returns
  **HTTP 403** to our fetcher, so all ten rows rest on the feed's own show notes —
  which are unusually detailed and consistently describe Heidi *explaining*
  ("Heidi reviews how Simone landed in this position", "Heidi poses a series of
  questions… and if it is, how to set it up and use it"). Format is a narrated
  case study followed by the lesson; Roizen is a Threshold partner and Stanford
  GSB lecturer. It is **2.48 h across five arc slots**, and A3 is the one slot
  that rests on it alone. **One listen before committing that CPU** is cheap
  insurance.

### 4.3 The rest of the shortlist, in brief

All measured N=2 unless stated. Full rows in the manifest.

- **The Startup Solution**, eight more: *How to Think About Venture Capital* (855 s,
  A1/A6), *The Case of the Venture Debt Dilemma* (1222 s, A7), *The Case of the
  Carveout Conundrum* (1003 s, A14 preferences), *The Case of the 409a Freak-out*
  (687 s, A14 valuation), *The Case of the Secondary Showdown* (738 s, A13), *The
  Case of the Radical Recap* (989 s, A14 recaps), *The Case of the Downer Round*
  (764 s, A14), *The Case of the Dubious Debt* (854 s, A14 — weakest of the ten;
  it is about a personal loan to exercise options, not company capital). All
  **Δ = 0.0 s**.
- **The Full Ratchet**, six more: 10 *The Term Sheet* with Brad Feld (3428 s,
  Δ 23.0 s — the author of *Venture Deals* on control terms), 13 *The Convertible
  Note* with Bill Payne (3368 s, Δ 23.0 s — pre-SAFE, and the contrast is the
  point), 14 *The Stages of Fundraising* with Ann Winblad (2450 s, Δ 22.9 s), 33
  *AngelList Syndicate Investing* with Gil Penchina (2036 s, Δ 22.9 s), 34
  *Lone-Wolves vs VCs vs Angel Groups vs Syndicates* (1638 s, Δ 29.1 s — a solo
  taxonomy episode, and the only side-by-side of the four found in this pass), 84
  *The Cap Table Part 1* (1752 s, Δ 22.8 s). Plus 50 *SEC Vote on JOBS Act Title
  III* (3190 s, Δ 23.0 s) and 199 *SPVs, Side Cars & The Syndication Surge*
  (2756 s, Δ 29.3 s) in the reserve tier. Part 2 of the cap-table pair (1721 s,
  Δ 22.8 s) is measured but deliberately not queued.
- **The Private Equity Podcast (Raw Selection)** — `rss.buzzsprout.com/1368691.rss`,
  224 items, 52 transcript tags but **`.vtt` 404s** (see §1), so these need ASR or
  force-alignment of the HTML prose. Queued: *Secondaries Are No Longer a Liquidity
  Tool* (Adrian Siew, Rothschild & Co, `Buzzsprout-19562341`, 986 s, Δ 0.0 s) and
  *How Private Equity Is Investing in Founder-Led Software Businesses*
  (`Buzzsprout-19451873`, 1472 s, Δ 0.0 s). A third, *The Growth of the Private
  Equity Secondaries Market* (Cari Lodge, `Buzzsprout-16744502`, 1563 s), was also
  probed at Δ 0.0 s and is **not queued** — redundant with the Siew episode.
- **Capital Allocators EP.448 — Jon Madorsky, Navigating the Evolution of Private
  Equity Secondaries** — `rss.libsyn.com/shows/94820/destinations/482814.xml`,
  `66061912-aa97-46c3-9782-22c82792fd33`, 3413 s, **Δ 0.0 s** despite the
  `pscrb.fm` prefix. A13, institutional view.
- **The Propel(x) Podcast — Non-Dilutive Funding for Deeptech Startups: How the NSF
  Invests** — `feeds.simplecast.com/DskUOSmn`,
  `4c5b2a93-c1d1-4140-aacc-4cf29890d57f`, 2070 s, **Δ 0.0 s**. Guest is an NSF
  Program Director; the show notes carry chapter marks including "(29:16) Why
  should the government finance technology risk?". A10, and the non-SBIR half of
  the grants story.
- **Tank Talks — The Corporate Venture Capital Handbook (Terry Doyle, Telus Global
  Ventures)** — `api.substack.com/feed/podcast/276749.rss`,
  `substack:post:164656679`, 2999 s, **Δ 0.0 s**. A12 second source, **demoted**:
  the chapter list opens on career path and spends real time on AI verticals and
  Canadian policy. The CVC substance is the dual "investor + customer" model.
  Budget low yield.
- **Startups For the Rest of Us 797 — TinySeed Tales s5e5: Should I Raise More
  Funding?** — `feeds.castos.com/mqv6`,
  `https://permalink.castos.com/podcast/5031/episode/2136442`, 1825 s, **Δ 0.0 s**.
  A2/A5, the accelerator-for-bootstrappers angle.
- **Y Combinator — Understanding Investor Terms & Incentives** (Dalton Caldwell &
  Michael Seibel), `5bea15c4-aed5-4be2-91c1-150fcae74fe9`, 577 s, **Δ 0.0 s**. A14,
  and the cheapest row in the manifest.
- **All About Grants (NIH) — Preparing for Private Investment** —
  `grants.nih.gov/podcasts/All_About_Grants/AAG_Feed.xml`, enclosure and GUID both
  `…/episodes/Podcast%20-%20Preparing%20for%20Private%20Investment.mp3`, 780 s,
  **ad delta: no ratio computable, UNTIERED** (see §3c). The bridge row — grant-
  funded science meeting private capital. Kept for the unusual angle, not for
  volume.
- **The Full Ratchet 426 — The Future of Venture Debt (David Spreng, Runway Growth
  Capital)** — 2504 s, **Δ 136.7 s, pad 205.7 s → LOCATE-REQUIRED.** Authorable
  now, playable when ADR-0007's fourth rung exists. The only heavy-delta row in
  the pass, and Run the Numbers already covers A7 with a free transcript, so
  nothing waits on it.

---

## 5. What we could NOT source

The load-bearing half of the document. Each negative states its scope; none is a
claim about podcasting in general.

### 5.1 The grants slot nearly had a perfect source, and its audio is gone

**NCI SBIR Innovation Lab** (`rss.libsyn.com/shows/495763/destinations/4239823.xml`,
26 items) is a US federal agency explaining its own funding programme, with **16
`<podcast:transcript>` SRTs**. Episode 14, *Which Funding Opportunity Should You
Pursue? — Grants vs. Contracts* (949 s), is the grants slot written to order, and
its SRT fetches 200 and reads cleanly:

```
1
00:00:07,068 --> 00:00:12,600
MONIQUE POND: Hello and welcome to Innovation
Lab, your go to resource for all things biotech
```

**Every enclosure tested returns HTTP 404** — episodes 12, 14 and 18 (3 of 26),
each with and without a `Range` header, with `ForayBot` and with a browser UA, and
across all three URL shapes (`/clean/secure/`, `/secure/`, bare `/innovationlab/`).
404 every time, while a control request to another Libsyn show on the same host
returned 206 in the same minute. So it is this show's media, not our client and
not Libsyn.

This is BBQ Nation again, with a new wrinkle: **the transcripts still work, so
every cheap check passes.** Anything that validates a source by transcript
availability would have admitted it. Fetch one enclosure before believing a feed.

Consequence: A10 falls back to Feel the Boot 89 (vendor-adjacent, video-first) and
Propel(x) (NSF, not SBIR), plus a 156 s VC Minute row that the relative cap
restricts to a ~31 s quote. **The grants slot is filled but it is the weakest
filled slot in the arc.**

### 5.2 Growth-stage VC — not sourced

No episode was found that explains **what a Series B/C or a growth-equity round
actually buys**, how growth investors underwrite differently from early-stage ones,
or what changes in the terms. Searched, with item counts: Capital Allocators (815
items — **zero** title matches for growth equity / growth stage / continuation
fund / GP-led), The Full Ratchet (1,022), Raw Selection (224), VC Minute (275),
Swimming with Allocators (108). What exists instead is Series A content (VC Minute
258/259, Full Ratchet 371/379/413/500) and *institutional* growth-equity talk
aimed at LPs, not founders. Full Ratchet 426 gestures at hybrid debt/growth-equity
products and is LOCATE-REQUIRED. **A6b is empty and no amount of ASR fills it from
what was crawled.**

### 5.3 Bank debt for a company that is not being acquired — not sourced

A9 is filled *only* for acquisition lending. Everything found on the SBA — 484
Acquiring Minds episodes, ThinkSBA — is **SBA 7(a) used to buy an existing
business**, which is a genuine and under-covered form of capital but is not the
same question as *a software startup asking a bank for a term loan or a line of
credit*. The nearest answer in the whole pass is a **150-second** VC Minute episode
on CDFIs. Across the ~25 feeds scanned nothing explains ordinary commercial bank
credit for startups; the gap is not an ad problem or a transcript problem, it is an
absence in what we looked at.

### 5.4 Rewards crowdfunding as a *form of capital* — not sourced

Crowdfunding Demystified has 99 episodes and they are campaign case studies —
"How this New Inventor Launched a $188,763 Kickstarter", "How This Campaign
Pivoted and Raised $512,257". That is **marketing content**, and it is the right
content for its audience. Across that feed and the four other crowdfunding feeds
Apple's search surfaced, nothing explains rewards crowdfunding *as financing*:
pre-selling as working capital, the fulfilment liability it creates, what it costs
against a loan, why hardware uses it and software does not. The equity half of A11
is genuinely sourced (Reg CF / Reg A via CrowdCrux EP557 and Full Ratchet 40/50);
**the rewards half is a hole**, and a narrator (the 2026-08-16 second ruling) is
the only thing that reaches it.

### 5.5 Two smaller negatives

- **Revenue-based financing has no podcast of its own that this pass could find.**
  One Apple search for `revenue based financing podcast` returned no on-topic
  English show in its results: a Dutch politics show, a Dutch current-affairs show,
  a generic small-business show and a VC show. A8 is therefore filled entirely by
  *founders who took RBF* (VC Minute 164–166, Bootstrapped Founder 309/328) rather
  than by anyone whose subject it is. That is arguably better tape, but it is luck,
  not coverage.
- **`corporate venture capital podcast`** likewise returned nothing on-topic in
  English in its results — a Spanish investing show, a governance show, an Irish
  business show, a German-language energy show. A12 was reached by scanning
  *inside* general VC feeds, not by finding a show about CVC.

### 5.6 The over-indexing, as far as this pass can show it

The brief's warning is correct, and it shows up in the search surface rather than
only in the output. Across discovery, shows whose *subject* is venture capital were
trivially findable and largely interchangeable; shows whose subject is any other
instrument either did not surface at all (§5.5), are aimed at institutions rather
than founders (§5.2), or are aimed at a different kind of buyer entirely (§5.3,
§5.4). **Four of the fourteen headline subjects are filled by episodes found
inside VC shows** — which is fine, because the witness is right — but they had to
be found that way because no dedicated show turned up. Curation is doing real work
here; a "top startup podcasts" harvest would have produced exactly the failure the
brief describes.

---

## 6. What would change these answers

- **A decision on the relative cap for short sources.** §0.3 is the largest single
  constraint on this Foray. Ten of the 24 VC Minute rows are unusable as segments
  purely because 20% of a two-minute episode is under the 30 s floor. Either that
  is correct and VC Minute is a ~5-minute contributor, or the cap wants a
  short-source exception — a founder/rules question, not a sourcing one.
- **A listen to one Startup Solution episode.** 2.48 h of the ASR budget and one
  arc slot outright (A3) rest on show notes alone, because `threshold.vc` 403s.
- **A listen to five minutes of Feel the Boot 89.** Video-first show, vendor guest,
  and currently the primary SBIR source.
- **Anyone who can reach NCI's audio.** If SBIR Innovation Lab's enclosures come
  back — or if the same audio is hosted at `sbir.cancer.gov` — the grants slot
  upgrades from "weakest filled" to "free timed transcripts from the agency that
  runs the programme", and 49 minutes of ASR drops out of the manifest.
- **A PodcastIndex query for THIS subject.** The bulk dump was downloaded, queried
  and crawled for Foray #1 (`docs/curation/catalogue-broadening.md`), but it was
  **not queried for this brief**. Every negative in §5 is scoped to Apple's search
  and ~25 feeds; growth equity, bank credit and rewards-crowdfunding-as-finance are
  conclusions about that surface, not about podcasting, and the dump would test
  them cheaply against 4.7M feeds.
- **A timings-only alignment mode.** Raw Selection publishes untimed HTML
  transcripts and Startup Therapy publishes 33 untimed plain-text ones. Both are
  the Moreish Podcast case from `grilling-asr-manifest.json`: if the pipeline can
  emit word timings against supplied text, those rows cost a fraction of ASR.
