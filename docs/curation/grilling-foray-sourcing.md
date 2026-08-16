# Sourcing the grilling & barbecue Foray — the non-Western half

Companion to the American arc already in hand (The BBQ Central Show with
historian Robert Moss, 112 episodes, ad-free; The British Food History Podcast,
ad-free — both in transcription). This pass went looking for the **global**
traditions: asado, churrasco, yakitori, Korean BBQ, braai, tandoor, jerk, satay,
lechon, mangal/kebab, Santa Maria, and the prehistoric fire-and-cooking origin
story.

It also answers the question the founders attached to it: **is
`data/catalog-breadth.json` big enough to support subject-led curation, or is it
biased against the very shows we can use?** Section 5 has the number. It is the
more important half of this document.

---

## 1. Method, and what "usable" means

> **Gate 1 below is SUPERSEDED by `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`**
> (Wyatt, 2026-08-16: *"Ads should not be a blocking issue as long as we can find
> the approximate right timestamp."*). Ad load is **no longer a reason to reject a
> source**. It is now measured as a **delta in seconds per episode** and decides
> only how a segment is anchored: ≤ 120 s → padded and playable; > 120 s →
> authored now, played once ADR-0007's anchor-resolution rung exists. The
> measurements below stand; the verdicts drawn from them do not. Do **not**
> re-reject a show on ad ratio alone.

Two hard gates, plus a content gate:

1. **Ad-free delivery.** The listener plays their own copy from the publisher's
   enclosure URL, so injected ads shift our timestamps off the transcript.
   Measured as `delivered bytes / feed-declared enclosure length` using a 2-byte
   ranged GET, reading the true total out of `Content-Range` — the method and
   the helpers in `tools/transcribe/ad-inflation.mjs`, whose warning holds:
   **HEAD lies on ad-inserting hosts.** Threshold `< 1.01` = ad-free. Median of
   up to 3 episodes per show (up to 2 in the §5.2 rank sample).
   - Where the feed declares `length="0"` (Megaphone, some WordPress feeds), the
     fallback is bitrate-implied: `bytes*8/itunes:duration` against the nearest
     standard bitrate at or below it. Weaker; every such row is labelled
     `bitrate-implied` and should be re-checked before we commit to the show.
   - Rows say **unmeasured** where no measurement was possible. No ratio in this
     document is estimated or inferred from the host name.
2. **A transcript, or content worth transcribing later.** `<podcast:transcript>`
   count per feed is reported as `tr=`.
3. **Content quality.** Someone has to be *explaining* something. Two shows that
   passed both technical gates are rejected below on this ground alone — same
   call as Under Seasoned BBQ Show.

Requests: `ForayBot/0.1 (+https://github.com/JW-Incorporated/foray;
wjduvall@gmail.com)`, ~1.5 s apart, 2 bytes per probe, no audio downloaded.

**One trap worth writing down.** `region` in `catalog-breadth-intl.json.gz` is
*the storefront a show charted in*, not where it is from. "The BBQ Show" and
"Grill This!" both carry `region: za` and are both American (Minnesota
butcheries; a Rochester NY brewfest). Do not read the region field as origin.

---

## 2. Shortlist — usable sources per tradition

All ratios below are measured, on 2026-08-15. `1.000` means the delivered file
is byte-identical in size to what the feed declares.

| Tradition | Show | Feed | Eps | Ad-free ratio | Transcripts | On-topic episodes |
|---|---|---|---|---|---|---|
| **Prehistoric fire / cooking hypothesis** | Origin Stories (Leakey Foundation) | `rss.libsyn.com/shows/65014/destinations/258524.xml` | 93 | **1.000** (bytes) | 9 eps | "Did Cooking Make Us Human?" (18:13); re-release (25:23); "We Eat Bugs" |
| " | THE HISTORY OF FOOD (AnthroChef) | `anthrochef.com/category/podcast-the-history-of-food/feed/` | 28 | **1.008** (bitrate-implied) | 0 | Ep 1 "Human Ancestors and Prehistoric Foragers"; Ep 12 "Herders of the Old World" |
| " | Eat This Podcast (Jeremy Cherfas) | `www.eatthispodcast.com/?feed=podcast` | 300 | **1.000** (bytes) | 36 eps | "Prehistoric cooking pots" (19:40); "New Light on Neanderthal Diets" (23:20) |
| **Jerk (Jamaica/Caribbean)** | The Moreish Podcast | `media.rss.com/the-moreish-podcast-caribbeanhistory-culture-and-cuisine/feed.xml` | 68 | **1.000** (bytes) | 8 eps | "The History of Jerk in Jamaica with Alyssa Sperry Bertrand"; "More than jerk chicken: Jamaica"; "Caribbean Food History with Dr. Candice Goucher" |
| " | Dis a Fi Mi History Podcast | `feed.podbean.com/disafimihisthttporypodcast/feed.xml` | 156 | **1.000** (bytes) | 110 eps | "Congotay! Congotay! — How Food Shapes Caribbean Identity with Candice Goucher"; "Caribbean Cuisine and History with Chef Keisha Griggs" |
| " | Heritage Food Stories (Chef Mireille) | `api.substack.com/feed/podcast/6999195.rss` | 23 | **1.000** (bytes) | 0 | "Why Caribbean Food Tastes Like Asia" (22:00); "Stories of Resistance in the British Caribbean" (38:53) |
| **Satay / SE Asia** | Satay? Okay! | `media.rss.com/satay-okay/feed.xml` | 11 | **1.000** (bytes) | 10 of 11 | Ep 1 "Satay and the Myth of Malaysian Cuisine"; Ep 6 "Sambal and the Portuguese Invasion"; Ep 5 "Spices and the Rise of Melaka" |
| " | Foodcast Cerita Makanan (id) | `anchor.fm/s/3bd2be38/podcast/rss` | 46 | **1.000** (bytes) | 0 | "Indonesian Traditional Festive Food"; "Local Cuisine from Padang" — Indonesian language |
| **Santa Maria (California)** | BBQ RADIO NETWORK | `rss.buzzsprout.com/1171697.rss` | 310 | **1.000** (bytes) | 0 | "SANTA MARIA GRILLING with BRAD WISE of RARE SOCIETY" (40:08); "Grillzilla: From Santa Maria Smoke to Backyard Paradise" (42:55) |
| **Asado (Argentina)** | BBQ RADIO NETWORK | as above | 310 | **1.000** (bytes) | 0 | "ARGENTINA OPEN FIRE COOKING with AL FRUGONI" (40:14) |
| " | The Grill Coach | `rss.buzzsprout.com/1069612.rss` | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — Argentinian Asado" (64:28) |
| " | The Pitmaster's Podcast | `rss.libsyn.com/shows/210107/destinations/1514702.xml` | 321 | **1.000** (bytes) | 0 | "Shawn Rapier talks Alacruz Argentine Grills" (78:21) |
| **Braai (South Africa)** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — South African Braai" (68:29) |
| " | Braai Day Podcast | `feeds.captivate.fm/braai-day-podcast/` | 5 | **1.000** (bytes) | 0 | "Braai Day podcast" — 5 episodes, thin |
| **Yakitori / yakiniku (Japan)** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — Yakitori BBQ!" (51:38) |
| " | 肉の丸一 肉屋の裏側ラジオ 焼肉語り | `anchor.fm/s/10f21b654/podcast/rss` | 20 | **1.000** (bytes) | 0 | 第14回 焼肉のタレの話 (yakiniku sauce); 第17回 ブラジルの焼肉 (Brazilian yakiniku); 第15–16回 1924 founding — Japanese language |
| **Korean BBQ** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — Korean BBQ" (70:03) |
| " | THE HISTORY OF FOOD | as above | 28 | **1.008** (bitrate-implied) | 0 | Ep 21 "Umami and Kimchi (Japan and Korea)" |
| " | Heritage Food Stories | as above | 23 | **1.000** (bytes) | 0 | "How Japanese Colonization Tried to Erase Korean Food" |
| **Lechon / Philippines** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — Filipino BBQ!" (46:36) |
| " | Exploring Filipino Kitchens | `www.exploringfilipinokitchens.com/episodes?format=rss` | 43 | **1.000** (bytes) | 0 | "Foodways of Negros with Reena Gamboa"; "Writing the Philippine Food, Cooking and Dining Dictionary with Edgie Polistico" — **no lechon episode found** |
| **Mexico (bonus)** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "BBQ World Tour — Mexican BBQ" (60:39) |
| " | MUY BBQ el podcast (mx) | `anchor.fm/s/10e19c2d8/podcast/rss` | 21 | **1.000** (bytes) | 0 | Spanish-language interviews with Mexican competition cooks |
| **US arc, supporting** | The Grill Coach | as above | 255 | **1.000** (bytes) | 0 | "Adrian Miller and The History of BBQ" (55:06) — author of *Black Smoke* |

### The single best find

**The Grill Coach's "BBQ World Tour"** is one ad-free show carrying a
purpose-built series across six of our traditions — braai, Korean, asado,
yakitori, Filipino, Mexican (plus Germany and Italy). Nothing else in this
sweep spans the brief that way.

**Caveat, and it is a real one:** the format is three hosts, and each episode
opens with a "highlights" segment about their own week's cooking plus listener
questions before reaching the named topic. Show notes carry no chapter marks
(`podcast:chapters`: 0). So it is a **segment** source, not a whole-episode
source, and how much of each hour is actually about the tradition is
**unverified** — I could not read it (no transcripts published, and local
transcription is off-limits this week). Listen to the braai episode before
building on it.

**Satay? Okay!** is the strongest source by content: two hosts, narrated
food-history of Malaysia, ad-free, and 10 of 11 episodes ship VTT transcripts we
can anchor for free. Verified by reading the transcripts, not inferred — e.g.
"we explore the history, cultures and cuisines of Malaysia, from the ancient
lands of Southeast Asia, all the way through to the creation of a modern day
nation."

---

## 3. Traditions with no usable source found

Stated plainly, because a negative result here is a sourcing decision, not a gap
to paper over.

- **Tandoor (India / Central Asia) — nothing.** No show, and no episode of any
  ad-free show found, that explains the tandoor. Empty Plates (`api.riverside.com/hosting/Lpu54DLU.rss`,
  35 eps, measured **1.000**) is a good Indian-food interview show but its
  nearest episode is about a vegan kebab shop. Title search of all 138,480
  catalogue shows returns **zero** hits for "tandoor"; Apple's search of the
  Indian storefront adds exactly one, a 1-episode feed called "Tandoor".
- **Mangal / kebab (Turkey, Middle East) — nothing.** The Turkish History
  Podcast (`rss.buzzsprout.com/2027808.rss`, 73 eps, measured **1.000**) is
  ad-free and well made but is dynastic and military history with no food
  episodes. Ottoman History Podcast — the obvious place to look — is
  **unmeasured**: its enclosures declare `length="0"` and carry no
  `itunes:duration`, so neither method applies; and of the 127 items in its main
  feed (mixed English and Turkish academic history) none is about food. The only
  kebab-adjacent food episode found anywhere was The Delicious Legacy's
  "Kokoretsi: The Ultimate Easter Kebab!" (Greek), and that show measures
  **1.170 — injected**.
- **Churrasco (Brazil) — no explanatory source.** What exists is interviews
  *with* Brazilians: Barbecue Base's "Everyone's favourite Brazilian, Adriano
  Andrade!" (measured **1.000**), The Pitmaster's "Bacana Grills", and — oddly
  the best of them — 肉の丸一's 第17回 on Brazilian yakiniku. A HORA DO CHÁ
  (`anchor.fm/s/34bcc864/podcast/rss`, 60 eps, Brazilian food-history, measured
  **1.000**) has no churrasco episode.
- **Braai, beyond one outsider episode.** SAFoodStories (`rss.iono.fm/rss/chan/9830`,
  13 eps, measured **1.000**) is genuinely South African but is food-business
  interviews. Item 13: An African Food Podcast (`rss.art19.com/item-13`, 94 eps,
  measured **1.006**) is African food entrepreneurs, not braai. Braai Day
  Podcast is 5 episodes.
- **Lechon specifically.** Covered only by the American Grill Coach episode.
  Exploring Filipino Kitchens is the right show and has no lechon episode.
- **Asado from Argentina or Uruguay.** Every asado source above is
  American-made. No Argentine or Uruguayan food podcast was found — see §5, the
  catalogue does not contain those storefronts and Apple's own search of them
  returns nothing usable either.

---

## 4. Rejected — and why

> **Every "injected" verdict in this table is SUPERSEDED by ADR-0008.** Usable:
> Gastropod (**measured +66 s**, and its 1.080 here was the weaker
> bitrate-implied method — §7 already flagged it for re-measurement); A Taste of
> the Past and Proof, whose ratios cross 120 s only above 100 min and 71 min of
> program respectively, so they clear it on any plausible episode length (probe
> once to confirm). Borderline and undecided until probed: The Fantastic History
> Of Food (crosses at 46.5 min). Over the threshold, and therefore **authorable
> now, playable once the locate step exists**: The Delicious Legacy, BBC The Food
> Programme, Grill This! and Hungry for History. Rejections on
> *content* (Culinary Connections, Seu Churrasco) and on *dead audio* (BBQ
> Nation) are unaffected. See ADR-0008 § "The unlock, quantified" for the
> per-show tier table.

| Show | Ad-free | Why rejected |
|---|---|---|
| Culinary Connections: Asian American Food Stories | **1.000** measured | Titles are exactly on-brief ("From Adobo to American BBQ: The Filipino Influence on American Grilling", "From Satay to Adobo", "From Tandoori to Tikka", "From Sushi to Samgyeopsal"). But: 65 episodes of 7–10 minutes, a rigid "From X to Y" title template, and interchangeable descriptions. It reads as machine-generated. Do not build on it without listening; it would be the tandoor and Korea answer if it were real. |
| Seu Churrasco (br) | **1.000** measured | 2-minute clips whose descriptions are all the same affiliate link to a cookware-review site. SEO filler. |
| BBQ Nation (au) | **unmeasured** | 297 episodes and 501 transcript tags, and the audio is gone: 4 enclosures tested (items 1, 21, 61, 121) all return **HTTP 404**, via the `op3.dev` prefix and at the `episodes.captivate.fm` origin alike. Unusable regardless of ads. |
| Grill This! | **1.073 — injected** | Has "Jamaican Jerk Chicken Wings". |
| A Taste of the Past | **1.020 — injected** | The loss that hurts: 413 episodes of food history including "Episode 305: Some Like it Hot — Jamaican Jerk History" and "Black Smoke, the African American Roots of BBQ". Just over threshold. |
| The Delicious Legacy | **1.170 — injected** | Ancient/medieval food history, 249 eps. |
| BBC The Food Programme | **1.099 — injected** | 837 episodes incl. "Smoke, Fire and Flame: Trends v Tradition". Worth knowing that BBC delivery is *not* clean for us. |
| Gastropod | **1.080 — injected** (bitrate-implied) | "Where There's Smoke, There's… Whiskey, Fish, and Barbecue!" |
| Proof (America's Test Kitchen) | **1.028 — injected** (bitrate-implied) | A 4-part "Barbecue Trailblazers" series. |
| Hungry for History | **1.461 — injected** | Highest inflation measured in this pass. |
| The Fantastic History Of Food | **1.043 — injected** | |

Also measured ad-free and kept on file as general food-history depth, without a
tradition-specific episode found: The History of American Food
(`www.spreaker.com/show/4817628/episodes/feed`, 221 eps, **1.000**, incl. "068
Wood Part II — Charcoal, BBQ & Mellowed Spirits"), おいしい歴史物語 (jp, 35 eps,
**1.000**), Morsel (13 eps, **1.000**), Smy Goodness (45 eps, **1.000**),
Japanese History Junk Food (13 eps, **1.000**), Evolutionary Insights by
Anthropology.net (290 eps, **1.000** — narration style unverified, treat with
the same suspicion as Culinary Connections), Our Prehistory (51 eps, **1.000**),
The Archaeology Show (349 eps, **1.000**).

---

## 5. Is the catalogue big enough? No — and size is the smaller problem

### 5.1 What we actually have

| | |
|---|---|
| `data/catalog-breadth.json` (us) | 19,787 shows |
| `data/catalog-breadth-intl.json.gz` (18 storefronts) | 121,786 shows |
| Overlap between the two | 1,157 feeds |
| **Unique feeds total** | **138,480** |
| Storefronts covered | 19 of Apple's ~175 |
| Apple genres walked | 110 |
| Food-genre shows, all storefronts | 1,703 (us: 199) |
| Maximum `chart_rank` present, either file | **200** |

That last row is the shape of the whole thing. `tools/harvest-catalog.mjs` sets
`CHART_LIMIT = 200` and walks *charts*. The catalogue is therefore, by
construction, "the top 200 of each of 110 genre charts in 19 countries" — and
nothing else can ever be in it. US Food coverage is 199 shows because the US
Food chart is 200 deep and one row was lost to dedupe or a failed lookup.

### 5.2 The finding that matters: chart rank predicts ad injection

If ranking correlates with monetisation, and monetisation with dynamic ad
insertion, then a chart harvest actively selects *against* the shows we can
anchor. That is testable, so I tested it.

**Method.** 70 US breadth-catalogue shows, deterministically sampled 14 per rank
band, feed fetched, up to 2 episodes probed each with the 2-byte ranged GET.
69 of 70 yielded a measurement.

| Chart rank band | Measured | Ad-free | Injected | % ad-free | Median ratio |
|---|---|---|---|---|---|
| 1–10 | 14 | 5 | 9 | 36% | 1.038 |
| 11–25 | 13 | 4 | 9 | 31% | 1.024 |
| 26–50 | 14 | 10 | 4 | 71% | 1.000 |
| 51–100 | 14 | 11 | 3 | 79% | 1.000 |
| 101–200 | 14 | 9 | 5 | 64% | 1.000 |

Collapsed: **ranks 1–25 are 33% ad-free (9/27). Ranks 26–200 are 71% ad-free
(30/42).** Yates-corrected χ² = **8.22** on 1 df — significant at p < 0.01.
Restricting to the stronger byte-ratio method only (dropping every
bitrate-implied row), the effect holds: **41% (7/17) vs 72% (26/36)**. Median
inflation among injected shows is 1.043; the worst measured was 5.116.

**So the correlation is real, and it runs the wrong way for us.** The higher a
show ranks, the less likely we can build a Foray from it. Our harvester was
pointed at exactly the wrong end of the distribution — and, worse, it stops at
rank 200, which is where the ad-free majority begins.

Caveats, honestly: n=69, one storefront, one day; rank is *within genre chart*,
so a rank-5 hobby show and a rank-5 news show are not comparable in audience;
and no genre control was applied. It is enough to act on and not enough to
publish.

### 5.3 What the bias cost us on this specific brief

- **Zero Argentine, Uruguayan, Korean, Turkish, Filipino, Indonesian, Malaysian,
  Singaporean, Jamaican, Chinese or Taiwanese storefronts** in the catalogue.
  Those are, precisely, asado, Korean BBQ, mangal, lechon, satay and jerk.
- Title search across all 138,480 shows returns: **0 braai, 0 tandoor, 0 robata,
  0 lechon, 1 churrasco** (a 5-episode music-commentary show), **1 yakitori**
  (French, 4 eps), **1 parrilla** (an NFL fantasy show), **1 satay** (which is
  Satay? Okay!, and is the one genuine hit in the set).
- **Six of the sources in §2 are not in the catalogue at all** and were found
  only by searching outside it: The Moreish Podcast, Dis a Fi Mi History,
  Heritage Food Stories, Exploring Filipino Kitchens, Braai Day Podcast,
  Foodcast Cerita Makanan — plus Empty Plates, Item 13 and A Taste of the Past
  among the near-misses. That is the whole jerk answer and most of the
  Philippines and Caribbean answer, invisible to us until this pass.
- **And the ones that *were* in the catalogue sit at the bottom of it.** Chart
  ranks of the usable in-catalogue sources: The Grill Coach 181, The Pitmaster's
  Podcast 184, A HORA DO CHÁ 191, Barbecue Base 173, Eat This Podcast 153, THE
  HISTORY OF FOOD 137, MUY BBQ 129, 肉の丸一 125, The Turkish History Podcast
  121, BBQ RADIO NETWORK 97, Satay? Okay! 66 — median **129**, and eleven of the
  thirteen below rank 200 but above rank 60. Only Origin Stories (31) and
  SAFoodStories (12) rank high. We found our sources in the last quarter of the
  chart, immediately above the cut-off — which is exactly what §5.2 predicts and
  is the strongest argument for raising `CHART_LIMIT` or abandoning charts
  altogether.

### 5.4 Scale, measured

PodcastIndex's keyless stats endpoint (`stats.podcastindex.org/daily_counts.json`,
fetched 2026-08-15):

| | |
|---|---|
| Feeds indexed | 4,712,165 |
| Episodes | 165,012,527 |
| Feeds with a new episode in 30 days | 327,265 |
| Episodes carrying a `<podcast:transcript>` | 6,433,546 |

Our 138,480 feeds are **2.9%** of the index.

---

## 6. Broadening proposal

Ranked by value per unit of effort. Every option is scored on the repo's keyless
rule (`CLAUDE.md`: this repo's cloud automation is deliberately keyless).

**A. PodcastIndex bulk feed dump — recommended, do this one.**
`https://public.podcastindex.org/podcastindex_feeds.db.tgz`. **Keyless
(verified: HTTP 206 with no credentials), measured 1,800,345,567 bytes
compressed** — one file covering the whole 4.7M-feed index. The artifact is a
gzipped SQLite database, so a query script is the only code needed and there is
no importer to write. (I measured its existence, reachability and size; I did
not download it, so treat its column list as unverified.) Effort: a download, a
decompress — budget ~10–15 GB on disk — and an afternoon. This replaces
title-guessing with real search over the whole index, in every language. Cost $0.

**B. Apple's *search* API, walked deliberately — recommended, cheap, keyless.**
Distinct from the charts we harvested: `itunes.apple.com/search?term=…&entity=podcast&country=XX`
searches the **whole storefront catalogue**, including storefronts we never
harvested. Verified working in `ar`, `uy`, `br`, `za`, `jp`, `kr`, `tr`, `ph`,
`my`, `id`, `in`, `jm`. In this pass, 897 result rows over 52 queries produced
835 unique feeds of which **665 (79.6%) are not in our catalogue**. At 1.5 s per
call, 50 terms × 20 storefronts ≈ 1,000 calls ≈ 25 minutes.
*Known weakness, measured:* relevance collapses on non-English multi-word
queries — `asado historia` in `ar` and `fuego y carne` in `uy` both returned
pages dominated by Christian devotional feeds, with nothing about food.
Single-word local terms work; phrases do not.

**C. Chart-harvest the missing storefronts — do it, but know what it does not
fix.** `node tools/harvest-catalog.mjs --regions ar,uy,cl,pe,co,kr,tr,ph,id,my,sg,jm`
already supports this. ~110 genres × 200 × 12 storefronts ≈ up to 264k rows
before dedupe; at the harvester's `THROTTLE_MS = 3000` that is ~1,320 chart
calls ≈ 66 minutes plus lookup batches. Keyless, $0. It buys language and
country coverage — and it inherits the rank ≤ 200 ceiling and the §5.2 bias
wholesale. Worth doing *after* A.

**D. PodcastIndex API — a founder decision, not a default.** `search/byterm`
would be the ideal per-tradition query, but the API **requires a key and secret
(verified: HTTP 401 unauthenticated)**. Registration is free of charge, but a
credential is exactly what `CLAUDE.md` says this repo's automation does not
carry. Flagging rather than assuming. The bulk dump (A) covers the same index
with no credential at all; the API only adds convenience and freshness.

**E. fyyd.de — keyless, verified working, low yield.** Open API, no key. Across
25 term queries it returned 33 rows in total (0–5 each) and nothing on-topic
that A or B would not also find. Not worth wiring up on its own.

**F. Podroll / `<podcast:person>` link-following — untested here.** Plausible for
finding the next Moreish Podcast from The Moreish Podcast, but I made no
measurement, so no volume estimate. Do not budget for it on my say-so.

**And the change that costs nothing:** whatever index we ingest from, **rank
candidates by measured ad-free ratio, not by chart position**. §5.2 says the two
are negatively correlated. The existing scan
(`tools/transcribe/ad-inflation.mjs`) already does the measurement; it just is
not in the selection path.

*Housekeeping for whoever picks this up:* §5.2 was produced by a throwaway
script that imports `ad-inflation.mjs`'s helpers and samples the catalogue by
`chart_rank`. It is not committed (this PR is docs-only, and `tools/transcribe/`
is owned by the live transcription workstream). If we want to re-measure — with
a genre control, or on another storefront — it belongs beside `ad-inflation.mjs`
as a committed script with a test floor, per workflow rule 6.

---

## 7. What would change these answers

- **A listen to one Grill Coach "BBQ World Tour" episode.** Six of our
  traditions currently rest on a show whose topic-segment share is unverified.
- **A listen to Culinary Connections.** If it is not machine-generated, it
  answers tandoor and Korea, and it is already measured ad-free.
- **The PodcastIndex dump.** Every "no usable source" verdict in §3 is scoped to
  what Apple's charts and Apple's search could see. Tandoor and mangal in
  particular are conclusions about *Apple*, not about podcasting.
- **Re-measuring the bitrate-implied rows** (THE HISTORY OF FOOD, Gastropod,
  Proof) with a fuller episode download, if any of them makes the final cut.
