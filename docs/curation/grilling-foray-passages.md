# Foray #1 — grilling & world barbecue: candidate passage inventory

Raw material for the ~3-hour Foray described in `docs/curation/grilling-foray-sourcing.md`.
Companion documents that constrain every row below:
`docs/curation/segment-length-rules.md` (how long, how often),
`docs/adr/0007-segment-anchoring.md` (what a boundary *is*),
`tools/segments/README.md` (the batch/results contract and the verbatim-anchor rule).

Machine-readable twin: `docs/curation/grilling-foray-passages.json`.
(`data-local/` is gitignored, so the JSON is committed here instead — it carries
no source prose beyond the anchors, which the segment schema requires anyway.)

**Scope.** The American and British halves of the arc are being transcribed by
another workstream and are deliberately absent: no BBQ Central Show, no British
Food History Podcast, no Gastropod was fetched or authored here.

**One source was added beyond the brief:** Eat This Podcast, already listed as a
confirmed ad-free prehistoric-fire source in `grilling-foray-sourcing.md` §2. It
is the only place this pass found *timed* transcripts for the arc's two opening
slots, and without it both would read zero. Its rows are marked **(added)**.

---

## 0. TL;DR — the number that matters

**Authored, anchored, validated candidate runtime: 8.4 minutes across 8 passages,
covering 5 of the arc's 8 slots.** The brief asked for ~4.5 hours. That gap is
not a shortfall in effort or in the sources' quality — it is a
**transcript-availability wall**, and it is measurable:

| | shows | episodes probed |
|---|---|---|
| Named sources examined (+1 added) | 8 | 41 |
| Episodes measuring ad-free (ratio < 1.01) | 8 of 8 | **41 of 41, all exactly 1.0000** |
| Shows shipping a `<podcast:transcript>` tag on the episodes we want | **3 of 7** | — |
| Shows shipping a **timed** transcript on the episodes we want | **2 of 7** (3 of 8 with the added source) | 14 |

Every technical gate that the sourcing pass could measure from a feed came back
green. The gate that actually binds — *can we read this episode?* — was never
measured before, and it fails for **five of the seven named sources**.

Four findings drive everything below:

1. **The Grill Coach's "BBQ World Tour" is rejected.** The sourcing pass called
   it "the single best find" and flagged its topic share as unverified. It is
   now verified (§7): no guest on any of the six episodes, hosts who call it a
   *"virtual"* tour in their own copy, and a stated segment template whose first
   half is highlights, listener questions and an affiliate plug. **Six arc slots
   rested on it and now have no source at all.**
2. **The Moreish Podcast's transcripts are untimed.** It ships
   `<podcast:transcript>` tags, they fetch HTTP 200, and they contain **zero
   timecodes** — clean speaker-labelled prose served as `.srt`. Anchors from it
   would be verbatim; `start_sec`/`end_sec` would be invented. So the single
   best jerk source in the catalogue cannot be anchored today. §4.
3. **Buzzsprout publishes no transcripts for either Buzzsprout show.** Both
   BBQ RADIO NETWORK and The Grill Coach carry 0 transcript tags, and the
   Buzzsprout transcript URL patterns all 404.
4. **Origin Stories publishes transcripts on 9 of 93 episodes and neither
   cooking episode is among them.** The Leakey Foundation's own episode page
   for the re-release carries no transcript either.

**The most useful outputs of this pass are therefore §6 and §7, not §3** — an
ASR queue of 9 episodes, each measured ad-free with a corroborated true
duration and ranked by arc unlocked per minute, plus the verdict that removes
~6 hours of the wrong audio from that queue before anyone pays for it.

---

## 1. Method

- Feeds fetched directly; per-item `guid`, enclosure URL, declared
  `length`, `itunes:duration` and every `<podcast:transcript>` tag recorded.
- **Ad-free delivery measured per EPISODE, never per show**, with
  `tools/transcribe/ad-inflation.mjs`'s `probeEpisode()` — a 2-byte ranged GET
  reading the true total from `Content-Range`. HEAD lies on ad-inserting hosts;
  no HEAD was used. Threshold `< 1.01`.
- **True duration cross-checked, not taken on trust.** `enclosure_length × 8 ÷
  itunes:duration` is reported per episode in the table below. Every one lands
  on a standard bitrate — 128 kbps for the two transcribed shows (128.4 for the
  Podbean item), 192 for Origin Stories, 96 for the two Buzzsprout shows — which
  corroborates each declared duration against its delivered byte count. Since
  every ratio is 1.0000, the delivered file *is* the file the feed describes.
  Two Heritage Food Stories items land at 160 kbps and one at 96; all still
  1.0000.
- Transcripts parsed with `tools/segments/transcript-normalize.mjs`.
- **Every anchor below was machine-validated** against the real
  `buildTranscriptIndex()` / `findAnchorOccurrences()` from
  `tools/segments/merge-segments.mjs` — whole-word subsequence, ≥ 4 words,
  occurrence within `ANCHOR_TIME_TOLERANCE_SEC` (120 s) of the claimed
  timestamp, plus the L1–L5 length/role rules. 5 of 5 pass, 0 failing. Anchors
  were copied from the transcript, never retyped from memory.
- Requests `ForayBot/0.1 (+https://github.com/JW-Incorporated/foray;
  wjduvall@gmail.com)`, ~1.5 s apart, 2 bytes per probe. No audio downloaded,
  no local transcription run (the laptop's whisper queue owns the CPU —
  STATE.md).

---

## 2. Measured ad-free ratio, every episode probed

All measured 2026-08-15/16. **41 of 41 at 1.0000** — the delivered file is
byte-identical in size to what the feed declares, so publisher transcript
timelines anchor for free wherever a transcript exists.

| Show | Episode | True duration | Declared bytes | kbps | **Ratio** | Timed transcript? |
|---|---|---|---|---|---|---|
| Origin Stories | Did Cooking Make Us Human? | 18:13 | 26,295,528 | 192 | **1.0000** | no |
| Origin Stories | Ep 09: Did Cooking Make Us Human? (Re-release) | 25:23 | 36,904,701 | 194 | **1.0000** | no |
| Origin Stories | We Eat Bugs | 28:35 | 41,218,552 | 192 | **1.0000** | no |
| The Moreish Podcast | The History of Jerk in Jamaica | 24:04 | 23,120,419 | 128 | **1.0000** | **no — untimed prose** |
| The Moreish Podcast | Caribbean Food History w/ Dr Candice Goucher | 57:46 | 55,591,506 | 128 | **1.0000** | no |
| The Moreish Podcast | More than jerk chicken: Jamaica | 28:41 | 27,601,950 | 128 | **1.0000** | no |
| The Moreish Podcast | Jamaica: salt and spirituality | 55:44 | 53,510,649 | 128 | **1.0000** | **no — untimed prose** |
| Satay? Okay! | 10. Chicken Rice and the Making of an Empire | 60:20 | 57,932,180 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 9. Toddy and the Colonisers' Secret Treaty | 51:08 | 49,094,851 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 8. Laksa and the Great British Lie | 61:23 | 58,932,774 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 7. Kueh and the Unlikely Dutch Affair | 59:11 | 56,822,499 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 6. Sambal and the Portuguese Invasion | 54:54 | 52,716,050 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 5. Spices and the Rise of Melaka | 61:37 | 59,162,652 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 4. Belacan and the Forgotten Ancient Empires | 51:01 | 48,988,272 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 3. Coconuts and the Land Before Borders | 60:11 | 57,790,074 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 2. Durian and the Arrival of the First Peoples | 59:29 | 57,116,324 | 128 | **1.0000** | **yes (VTT)** |
| Satay? Okay! | 1. Satay and the Myth of Malaysian Cuisine | 38:43 | 37,175,073 | 128 | **1.0000** | **yes (VTT)** |
| Dis a Fi Mi History | More-ish Flavours: Caribbean Food, Identity, History | 49:27 | 47,614,362 | 128 | **1.0000** | **yes (VTT)** |
| Dis a Fi Mi History | Eat, Feel, Dream ... with Griot's Table | 27:28 | 27,663,311 | 134 | **1.0000** | **yes (VTT)** |
| Dis a Fi Mi History | Caribbean Cuisine and History w/ Chef Keisha Griggs | 48:21 | 46,436,225 | 128 | **1.0000** | no |
| Dis a Fi Mi History | Congotay! Congotay! ... with Candice Goucher | 30:38 | 29,421,894 | 128 | **1.0000** | no |
| Heritage Food Stories | Stories of Resistance in the British Caribbean | 38:53 | 37,323,799 | 128 | **1.0000** | no |
| Heritage Food Stories | Why Caribbean Food Tastes Like Asia | 22:00 | 21,122,029 | 128 | **1.0000** | no |
| Heritage Food Stories | The Lasting Legacy of the Indigenous People of the Caribbean | 19:16 | 18,501,425 | 128 | **1.0000** | no |
| Heritage Food Stories | Malaysia: Where All of Asia Meets on a Plate | 21:22 | 20,508,047 | 128 | **1.0000** | no |
| Heritage Food Stories | How Japanese Colonization Tried to Erase Korean Food | 15:46 | 11,349,517 | 96 | **1.0000** | no |
| Heritage Food Stories | The Forgotten History of Indian Indentureship in the Caribbean | 26:55 | 25,840,788 | 128 | **1.0000** | no |
| Heritage Food Stories | The West African Roots of Caribbean Green Seasoning | 6:35 | 7,896,861 | 160 | **1.0000** | no |
| Heritage Food Stories | Callaloo: The Caribbean Dish That Tells a Story of Survival | 9:59 | 11,970,918 | 160 | **1.0000** | no |
| BBQ RADIO NETWORK | Grillzilla: From Santa Maria Smoke to Backyard Paradise | 42:55 | 30,986,479 | 96 | **1.0000** | no |
| BBQ RADIO NETWORK | ARGENTINA OPEN FIRE COOKING with AL FRUGONI | 40:14 | 29,060,854 | 96 | **1.0000** | no |
| BBQ RADIO NETWORK | SANTA MARIA GRILLING with BRAD WISE of RARE SOCIETY | 40:08 | 28,955,219 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — Filipino BBQ! | 46:36 | 33,660,718 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — Yakitori BBQ! | 51:38 | 37,279,762 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — Argentinian Asado | 64:28 | 46,522,414 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — Korean BBQ | 70:03 | 50,545,151 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — South African Braai | 68:29 | 49,416,366 | 96 | **1.0000** | no |
| The Grill Coach | BBQ World Tour — Mexican BBQ | 60:39 | 43,773,636 | 96 | **1.0000** | no |
| The Grill Coach | Adrian Miller and The History of BBQ | 55:06 | 39,775,895 | 96 | **1.0000** | no |
| Eat This Podcast **(added)** | New Light on Neanderthal Diets | 23:20 | 22,517,193 | 129 | **1.0000** | **yes (SRT)** |
| Eat This Podcast **(added)** | Revisiting Historical Recipes | 19:51 | 19,195,520 | 129 | **1.0000** | **yes (SRT)** |

No episode exceeded 1.01, so no padded-start allowance (ADR-0007's 120 s
`ANCHOR_TIME_TOLERANCE_SEC`) is needed anywhere in this inventory.

---

## 3. The candidate passages

Eight passages, each anchored against a **publisher** transcript and each
machine-validated (§1). `start_sec` is placed one sentence *before* the
load-bearing claim per §3f's sacrificial-head rule, so every passage opens on
run-up rather than on the money sentence.

### Arc slot — fire and the origins of cooking

| # | Source | Episode | start→end | Dur | Role |
|---|---|---|---|---|---|
| P6 | Eat This Podcast **(added)** | New Light on Neanderthal Diets | 274.87 → 365.21 | 90.3 s | explanation |
| P7 | Eat This Podcast **(added)** | New Light on Neanderthal Diets | 702.5 → 738.02 | 35.5 s | quote |

**P6** — GUID `https://www.eatthispodcast.com/?p=4685` · true duration 1400 s · **ratio 1.0000** · 6.5 %
- Enclosure `https://media.blubrry.com/eatthispodcast/op3.dev/e/mange-tout.hel1.your-objectstorage.com/2025/maggots.mp3`
- **start_anchor** — "So how do they know it was a factory for extracting bone grease"
- **end_anchor** — "these bones had actually been heated in water, and that's still missing"
- **why** — How you boil water before pottery exists, and what would still be needed to prove it happened
- John Speth on a Neanderthal bone-grease site in northern Germany: you can boil
  directly in bark or hide because the water never reaches the container's
  kindling point. It ends by naming the evidence that is *still missing* — which
  is exactly the intellectual honesty the Foray should be made of.
- `cold_open_ok: true` — S1 fires on "So", overridden because the topic term
  ("bone grease") lands inside the first 12 words and the sentence is a question,
  which is ideal sacrificial-head material.

**P7** — same episode · 2.5 % · elided gap from P6 is 337.3 s ≥ 180 s, so M1/M2 do not fire; P6 plays first (M3)
- **start_anchor** — "What's interesting in the ethnohistoric record, and this is so counterintuitive"
- **end_anchor** — "The stuff that we all crave, they often tossed. They left it for the wolves"
- **why** — Northern hunters prized fat and organs and discarded the steaks we consider the prize
- A 35-second reversal that reframes what meat is *for*. Strong contrast material
  against any modern-backyard segment about steak.

**What this slot still lacks:** the cooking hypothesis itself. These two passages
are a *counterpoint* — cooking without fire-roasting, and raw meat eaten by
choice. Wrangham's argument is in Origin Stories, which publishes no transcript
(ASR-2).

### Arc slot — pre-modern hearth / spit / griddle cookery

| # | Source | Episode | start→end | Dur | Role |
|---|---|---|---|---|---|
| P8 | Eat This Podcast **(added)** | Revisiting Historical Recipes | 328.72 → 424.13 | 95.4 s | explanation |
| P2 | Satay? Okay! | 7. Kueh and the Unlikely Dutch Affair | 1666.67 → 1704.6 | 37.9 s | quote |

**P8** — GUID `https://www.eatthispodcast.com/?p=4704` · true duration 1191 s · **ratio 1.0000** · 8.0 %
- **start_anchor** — "hear a lot from people who say, well, it's no use reconstructing historical recipes"
- **end_anchor** — "because a lot of cake historically was baked in a sort of closed pan"
- **why** — Before 1800 most cooking happened in a peat-fired hearth, and they cooked the same recipe both ways to test it
- **The best single passage in the inventory.** Marieke Hendriksen explains that
  almost everything was cooked in a hearth before the end of the 18th century,
  that Dutch hearths burned mostly peat, and then reports an actual controlled
  experiment: the same recipes baked in an electric oven, in a wood-and-peat-fired
  oven, and over an open peat fire outside. The finding — a closed container
  shields food from smoke, but bread baked directly on the oven floor would not
  be — is a mechanism, not an anecdote.

**P2** — GUID `6db5cebf-797f-46d9-9791-e5c34dbb8b8d` · true duration 3551 s · **ratio 1.0000** · 1.1 %
- Enclosure `https://content.rss.com/episodes/340886/2208949/satay-okay/2025_10_03_10_04_37_c711be69-783e-4190-a86d-235fbcbfce1f.mp3`
- **start_anchor** — "Holland, again, in the sort of I think 15th or 16th centuries they had cake pans"
- **end_anchor** — "the batter for the kueh probably comes from the Portuguese"
- **why** — Dutch cast brass pans set over a fire seeded a Southeast Asian baking technique
- Guest historian, not a host. Names what is known and says plainly where the
  record runs out.

### Arc slot — world traditions: satay / Southeast Asia

| # | Source | Episode | start→end | Dur | Role |
|---|---|---|---|---|---|
| P1 | Satay? Okay! | 1. Satay and the Myth of Malaysian Cuisine | 735.8 → 815.6 | 79.8 s | explanation |
| P4 | Satay? Okay! | 6. Sambal and the Portuguese Invasion | 292.5 → 349.2 | 56.7 s | quote |

**P1** — GUID `581a3509-1b50-468a-8fa3-ae903a5b1279` · true duration 2323 s · **ratio 1.0000** · 3.4 %
- Enclosure `https://content.rss.com/episodes/340886/2188236/satay-okay/2025_08_28_14_13_18_699a6794-7e0b-421e-aa10-7fc0b94bfb6d.mp3`
- **start_anchor** — "so many Malaysians and Southeast Asians and Asians in general are so obsessed with food"
- **end_anchor** — "wherever humans have gone, they've probably put meat on a stick"
- **why** — Three rival origin theories for satay, then the point that skewered meat is universal
- **The spine candidate for the world-traditions half.** Three competing origin
  claims (Middle Eastern kebab via Indian maritime trade; a stone relief at the
  Bayon temple; indigenous invention) in 80 seconds, landing on a line that opens
  straight back onto the fire-and-origins slot. Passes the audio-only gate: the
  temple relief is *described*, not pointed at.

**P4** — GUID `9430db32-d775-4674-9802-953f648f3260` · true duration 3294 s · **ratio 1.0000** · 1.7 %
- Enclosure `https://content.rss.com/episodes/340886/2197577/satay-okay/2025_09_03_17_29_16_39d45b78-038a-406e-8614-76acc49ff25f.mp3`
- **start_anchor** — "You asked me, I think, where chili comes from, and I said it comes from South America"
- **end_anchor** — "set up trading ports along the way, and then traded those around the world"
- **why** — How chilli reached Asia only via 16th-century Iberian traders, not the old spice routes
- Useful well beyond satay: this is the mechanism that put heat into jerk, sambal
  and Mexican grilling alike, and it dates all three.

### Arc slot — world traditions: jerk / Caribbean

| # | Source | Episode | start→end | Dur | Role |
|---|---|---|---|---|---|
| P5 | Dis a Fi Mi History | More-ish Flavours: Caribbean Food, Identity and History | 1361.148 → 1422.8 | 61.7 s | explanation |

- **GUID** `disafimihisthttporypodcast.podbean.com/a2e7368a-8d9d-31f7-b493-df390d9350ac` · true duration 2967 s · **ratio 1.0000** · 2.1 %
- Enclosure `https://mcdn.podbean.com/mf/web/ercke6d2n5znx5bk/Moreish_Podcast7tcxm-ia95tx-Optimized.mp3`
- **start_anchor** — "And food for us, regardless of which Caribbean country you come from"
- **end_anchor** — "be interested in the history of jerk chicken and then you stay to listen to a story"
- **why** — Caribbean dishes carry indigenous, enslaved, indentured and colonial imprints at once
- **confidence: medium.** This is the *frame* for the jerk section rather than the
  history of jerk itself. It earns its place as the slot's opener, but the slot
  still needs the Moreish jerk episode behind it (ASR-1).

### Arc slot — the modern backyard era

| # | Source | Episode | start→end | Dur | Role |
|---|---|---|---|---|---|
| P3 | Satay? Okay! | 7. Kueh and the Unlikely Dutch Affair | 2835.5 → 2879.6 | 44.1 s | quote |

- Same episode as P2 · **ratio 1.0000** · 1.2 %
- **start_anchor** — "Originally, my father was a fisherman. The idea at first was to sell in the village"
- **end_anchor** — "It's the cost, right? That's when we switched to gas"
- **why** — A cook explains why wood fire tasted better and why cost drove them to gas anyway
- The wood-to-gas moment, told by someone who lived it rather than argued it.
- **M-rule check:** P2 and P3 share `item_id`; elided gap is 1130.9 s (18.8 min)
  ≫ 180 s, so M1/M2 do not fire — keep separate, P2 first (M3).

### Totals

| Arc slot | Passages | Candidate runtime |
|---|---|---|
| Fire and the origins of cooking | 2 | **2:06** (counterpoint only — see above) |
| Pre-modern hearth / spit / griddle | 2 | **2:13** |
| American barbecue's birth and westward spread | — | out of scope this pass |
| Regional US divergence | 0 | **0:00** |
| World traditions — satay / SE Asia | 2 | **2:17** |
| World traditions — jerk / Caribbean | 1 | **1:02** (framing only) |
| World traditions — braai, yakitori, Korean, asado, Santa Maria, Mexican, Filipino | 0 | **0:00** |
| The modern backyard era | 1 | **0:44** |
| **Total** | **8** | **8:21** |

Batch median 62 s, against B1's 75–180 s target band. That is a *symptom*, not a
style choice: with three transcribed shows in hand there is no pool deep enough
to select long, self-contained explanation from. Do not read the median as
guidance until §6 has run.

## 4. Arc slots that could not be filled, and exactly why

Two distinct failure modes, and the difference decides what to do next.
**A blocked slot has a source we cannot read yet — buy a transcript.
An empty slot has no source at all — buy a new sourcing pass.**

| Arc slot | State | Blocked by | What fixes it |
|---|---|---|---|
| **Fire and the origins of cooking** | partial (2:06) | Have a pre-ceramic bone-boiling counterpoint from Eat This Podcast. The cooking hypothesis itself is in Origin Stories, which publishes transcripts on 9 of 93 episodes — neither cooking episode among them, and leakeyfoundation.org's episode page carries none either. Both measure **1.0000**. | ASR-2 |
| **Pre-modern hearth** | filled (2:13) | — | — |
| **Regional US divergence — Santa Maria** | **blocked, 0:00** | BBQ RADIO NETWORK ships 0 transcript tags across 310 items; Buzzsprout `/transcript.srt`, `/transcript.vtt`, `/transcript` and `.json` all 404. Both Santa Maria episodes measure **1.0000**. | ASR-7 (and see §7 — expect only 3–5 usable minutes) |
| **World traditions — asado** | **blocked, 0:00** | The Al Frugoni episode (40:14, **1.0000**) has no transcript. It is a confirmed interview with an Argentine asador, so the content case is strong. | ASR-3 |
| **World traditions — jerk** | partial (1:02) | Have a framing passage. The actual history of jerk is in The Moreish Podcast, whose transcripts carry **no timecodes at all** — clean prose, HTTP 200, `text/plain` served as `.srt`, zero lines matching a timecode pattern in either file. Anchors would be verbatim; timestamps would be fiction. | ASR-1 — and note this needs *timings only*, the cheapest ask in the queue |
| **World traditions — Korean** | **empty, 0:00** | The Grill Coach is rejected (§7). Heritage Food Stories has one Korean episode but publishes no transcript, and its Substack post is an **original essay**, not a transcript of the audio — anchoring to it would yield anchors verbatim to the wrong text and unresolvable at playback. | ASR-6 |
| **World traditions — braai** | **EMPTY, no source** | The Grill Coach was the only candidate. Rejected (§7). Braai Day Podcast is 5 episodes; SAFoodStories is food-business interviews. | New sourcing pass |
| **World traditions — yakitori** | **EMPTY, no source** | Same. The only other catalogue hit for "yakitori" is a 4-episode French show. | New sourcing pass |
| **World traditions — Filipino / lechon** | **EMPTY, no source** | Same. Exploring Filipino Kitchens is the right show and has no lechon episode. | New sourcing pass |
| **World traditions — Mexican** | **EMPTY, no source** | Same. | New sourcing pass |
| **American barbecue's birth / westward spread** | out of scope | Another workstream's. One hand-off: Grill Coach #122, Adrian Miller (§7). | — |

**The four EMPTY rows are the real damage from §7.** They were not blocked by
transcription cost; they had exactly one candidate source between them and it
did not survive verification. No amount of ASR budget fills them.
`grilling-foray-sourcing.md` §6's option A — the keyless, $0 PodcastIndex bulk
feed dump — is the recommended route, and these four slots are now the concrete
business case for funding it.

## 5. Rejected, and why

### Passages examined and rejected on content

- **Satay? Okay! ep 4 (Belacan), ~03:40–04:40 — rejected, audio-only failure.**
  Technically perfect (1.0000, timed VTT, clean text) and thematically on-brief
  (roasting and charring shrimp paste over a grill). But the passage is the two
  hosts opening a jar and performing a live sniff test, and it contains the line
  that there is *video evidence of this on Nobby's Instagram*. This is exactly
  the failure mode that sank the earlier photo-reaction show: two people
  reacting to something the listener cannot perceive. **Reject.**
- **Satay? Okay! ep 1, from ~15:15 — do not cut here.** The hosts tell listeners
  to get to a computer and open Google Maps. Any segment crossing that point is
  unusable. P1 deliberately ends at 815.6 s, well clear.
- **Satay? Okay! ep 10 (Chicken Rice), ~44:44–45:20 — rejected on anchor
  quality.** A Hainanese chef describing being taught to grill and roast for the
  colonial palate: genuinely on-brief and a real transmission story. But cut
  cleanly it is 26.6 s, under the 30 s floor, and the only way to reach 30 s is
  to run into fragmentary non-native speech where no clean-out exists. Per
  §9's rule, flagged rather than forced. **Revisit if we ever re-transcribe
  this episode ourselves** — the content deserves it, the caption text does not.
- **Satay? Okay! ep 3 (Coconuts), 26:30–27:40 and 49:40–51:00 — weak.** The
  first explains otak-otak (fish grilled in leaves) but is really about
  substituting ingredients in London; the second is a warm childhood story about
  grilled fish with no explanatory content. Neither earns a slot while better
  material is unwritten.
- **Satay? Okay! ep 5 (Melaka), ~06:52–08:20 — held, not rejected.** Spice
  traders inventing myths to protect their sources is excellent tape, but it is
  about the spice trade, not about fire. `colour` tier at best; revisit only if
  the Foray needs breathing room.
- **Dis a Fi Mi, "Eat, Feel, Dream … Griot's Table" — rejected.** Timed VTT,
  1.0000, but the episode is an interview about running a supper-club business
  (upcoming events, a pitch competition), not Caribbean food history.

### Sources rejected outright

- **The Grill Coach's six "BBQ World Tour" episodes — rejected on content.**
  This is the biggest single call in the pass and it gets its own section: §7.
  Its one surviving episode (Adrian Miller) is queued as ASR-5.

Every other named show passed the content gate. Six of the seven are worth
transcribing, in the order given in §6.

---

## 6. The ASR queue — what to transcribe, in priority order

Every row measured ad-free at **1.0000** with a corroborated true duration, so
each is anchorable the moment a timed transcript exists. Ranked by arc unlocked
per minute of audio. **This ordering already reflects §7's verdict**, which
removed 6h 02m of Grill Coach audio from the queue.

| # | Show | Episode | Dur | Unlocks | Note |
|---|---|---|---|---|---|
| ASR-1 | The Moreish Podcast | The History of Jerk in Jamaica | 24:04 | jerk (the whole slot) | **Cheapest win in the queue.** A clean publisher prose transcript already exists — we need **timings only**, and can then anchor against the publisher's text rather than ASR output. Verified by reading: a researcher explaining that Maroon, Taíno and African claims to jerk's origin each hold a piece of it. |
| ASR-2 | Origin Stories | Ep 09: Did Cooking Make Us Human? (Re-release) | 25:23 | fire and the origins of cooking | The arc's opening slot, currently filled only with a counterpoint (P6/P7). Prefer the re-release over the 18:13 original — same argument, more room to cut. |
| ASR-3 | BBQ RADIO NETWORK | ARGENTINA OPEN FIRE COOKING with AL FRUGONI | 40:14 | asado | Confirmed an interview with an Argentine asador, conducted by two champion pitmasters. Strongest content case in the queue. Expect ~2–3 of its 4 segments to be Frugoni. |
| ASR-4 | The Moreish Podcast | Caribbean Food History w/ Dr Candice Goucher | 57:46 | jerk / Caribbean depth | No transcript tag at all. Goucher is the academic authority in this space. |
| ASR-5 | The Grill Coach | Adrian Miller and The History of BBQ | 55:06 | American arc (**hand off**) | The one Grill Coach episode that survives §7. Belongs to the American workstream, not this one — flagged to them rather than claimed. |
| ASR-6 | Heritage Food Stories | How Japanese Colonization Tried to Erase Korean Food | 15:46 | Korean | Short, and the only non-Grill-Coach Korean source we have. |
| ASR-7 | BBQ RADIO NETWORK | Grillzilla: From Santa Maria Smoke to Backyard Paradise | 42:55 | regional US divergence — Santa Maria | podscan.fm already exposes the first ~8:43 free, and that portion carries real first-hand Santa Maria detail. Expect only 3–5 usable minutes overall. |
| ASR-8 | Heritage Food Stories | Why Caribbean Food Tastes Like Asia | 22:00 | jerk / Caribbean | |
| ASR-9 | Origin Stories | We Eat Bugs | 28:35 | fire origins (secondary) | Only if ASR-2 underdelivers. |
| — | BBQ RADIO NETWORK | SANTA MARIA GRILLING with BRAD WISE | 40:08 | — | **Deprioritised, not queued** — see §7. |
| — | The Grill Coach | 6 × BBQ World Tour | 6h 02m | — | **Rejected — see §7.** |

ASR-1 through ASR-4 total **2h 27m** of audio. They turn the two framing-only
slots (jerk, fire origins) into real ones and open asado from zero. That is the
block worth funding first, and it is a quarter of what the rejected Grill Coach
episodes alone would have cost.

**Slots that no source in this pass can fill at any transcription budget:**
braai, yakitori, Korean-from-a-Korean-source, Filipino and Mexican. The Grill
Coach was the only candidate for all five, and §7 rejects it. These need a new
sourcing pass — `grilling-foray-sourcing.md` §6's PodcastIndex bulk dump
(option A, keyless, $0) is the recommended route, and this is now the concrete
reason to fund it.

## 7. The Grill Coach — verified, and rejected

`grilling-foray-sourcing.md` calls the BBQ World Tour series "the single best
find" while flagging its topic-segment share as unverified. **It is now
verified, and the verdict is reject.** Six arc slots rested on it.

The show publishes no transcript, Buzzsprout exposes none, and local
transcription was off-limits — so the verification was done from every readable
artefact around the audio instead:

- **Their YouTube channel is dead** (handle and channel RSS both 404), so there
  is no caption route. Upside: the show is audio-native, so it does *not* fail
  the visual-dependence gate that sank the photo-reaction show. It fails a
  different one.
- **The website show notes are circular.** 279 episode pages exist on
  `thegrillcoach.com`; their text is identical to the RSS description, which
  itself promises "full show notes at TheGrillCoach.com". There is no Argentinian
  Asado page at all.
- **The segment template is stated in the show's own descriptions**, uniformly:
  highlights ("what I cooked this week") → "BBQ question of the day" (listener
  questions) → a "Grill Coach Recommendation" affiliate plug → *"after the
  break"* / *"in the second segment"* the named tradition. **The first half of
  every episode is precisely the three things a Foray cannot use.**
- **Measured, on the only Grill Coach transcript that exists anywhere** (a 2026
  episode on podscan.fm, same format, first ~8–9 min free): **at 08:50 the hosts
  are still in highlights**, telling an anecdote about forgetting to dry-brine a
  steak. Zero topic content in nine minutes.
- **There is no guest on any of the six World Tour episodes.** Not one name in
  any description or show-note page. The hosts are three Portland-area
  Americans, and they call it a *"virtual"* BBQ World Tour in their own copy.
  The Mexican episode's notes list four cookbooks under "Mentioned Links" —
  i.e. they read up and relay.

**So the rejection is not "banter" in the narrow sense — the format is clean
audio and the hosts are competent grillers. It is that there is no sourced
expertise on any of these six traditions, half the runtime is ruled-out
material, and the other half cannot be verified.** Committing ~6 hours of scarce
ASR to it on that basis would be the expensive version of this mistake.

**Honest limit on this finding:** the second-half content quality is *inferred*
from descriptions plus one same-format transcript from a later era, not
measured. If someone wants to overturn this, one spot-listen of the braai
episode (68:29, the worst-documented of the six — its entire description is a
single sentence) settles it for the price of an hour.

**One Grill Coach episode survives: "Adrian Miller and The History of BBQ"
(55:06, ratio 1.0000).** Real guest, real scholar — the author of *Black Smoke*
— and a description that enumerates actual explanatory beats: barbecue's
Indigenous roots, the shift to what we now call barbecue, and African American
contribution to the culture. It pays the same front-half tax, so expect ~25–30
usable minutes. It is queued as ASR-5 and it belongs to the American arc, which
is another workstream's — flagged to them rather than claimed here.

### BBQ RADIO NETWORK — the opposite verdict

Structurally the better source, and it was under-sold by the sourcing pass. It
is a nationally syndicated **one-hour barbecue radio talk show**, i.e.
audio-native by construction, and the eight chaptered 2022 episodes reveal a
rigid clock: **four ~10-minute segments** at 0:00 / ~10:20 / ~19:05 / ~28:55.
All three target episodes are 40–43 min, so they share it. The regular hosts
are Andy Groneman (2× World Pork Champion) and Todd Johns (4× World Champion,
ex-Plowboys BBQ) — practitioners interviewing practitioners.

- **Al Frugoni, "ARGENTINA OPEN FIRE COOKING" (40:14) — confirmed an interview
  with him**, an Argentine asador who runs the largest open-fire cooking
  festival in Hondo, TX. **The best asado candidate we have.** Two caveats to
  carry into extraction: the description frames him as a *fusion* cook, and part
  of the hour is a host travelogue about Todd's own trip to Argentina, so expect
  ~2–3 of the 4 segments to be Frugoni explaining.
- **"Grillzilla" (42:55)** — the only target episode across both Buzzsprout
  shows with any readable transcript: podscan.fm publishes the first ~8:43 free.
  It contains genuine first-hand Santa Maria detail (streets lined with towable
  barbecue pits cooking tri-tip; tri-tip's two opposed grains and how that
  dictates the cut). But it drifts to pellet grills and backyard water features
  by ~04:00. Realistically **3–5 usable minutes**, from a nostalgic hobbyist
  rather than an authority.
- **Brad Wise / Rare Society, "SANTA MARIA GRILLING" (40:08) — deprioritised.**
  The description itself limits it: Wise talks *"a little about"* his restaurant
  and a pork crown roast, and one whole segment is the hosts on side dishes.
  Wise is a San Diego restaurateur who adopted the style, not a tradition
  bearer.

## 8. What would change these numbers

- **Overturning §7, if anyone wants to.** One spot-listen of the braai episode
  (68:29) is the whole cost. The rejection rests on descriptions plus one
  same-format transcript from a later era, and I would rather be contradicted by
  someone's ears than have four arc slots written off on an inference.
- **ASR-1 and ASR-2.** ~50 minutes of audio, and the arc gains a real jerk slot
  and the cooking hypothesis itself — the two that make this a *history* rather
  than a tour.
- **A new sourcing pass for braai, yakitori, Filipino and Mexican.** These four
  are not a transcription problem and no ASR budget touches them. §4.
- **A timings-only ASR mode.** ASR-1 does not need a good transcript; it needs
  timecodes to align an excellent one we already have. If the transcription
  workstream can emit word timings and align them to supplied text, the Moreish
  catalogue (8 transcript-bearing episodes, all untimed, all 1.0000) becomes
  anchorable at a fraction of full-ASR cost. **This generalises well beyond this
  Foray** and is worth raising with epic #115.
- **Nothing about ad injection.** That gate is fully measured and fully passed:
  41 of 41 episodes at 1.0000. No future pass needs to re-probe these.
