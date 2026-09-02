# 02 — Listener Market Research

> **Name change since this memo — 2026-08-21.** This memo was researched
> against a working name, "CommutePilot," which is not the shipped
> product: the founder chose **4a** as the app name (`foray` now names
> only the stitched-audio unit 4a assembles — see `06-naming-study.md`,
> `docs/DECISIONS.md`). Read every "CommutePilot" below as "4a."
> **Applicability:** the market-sizing data, listener behavior research,
> and pricing benchmarks below hold regardless of app name and still
> apply as-is. **One finding needs an explicit flag, not just a name
> swap:** this memo's own §"Implications" leans on car/commute framing as
> the primary wedge even though its own data (line below) shows only
> **11% of listening happens in cars** vs. 67% at home. That tension was
> carried forward into the "CommutePilot" name itself and into
> `04-personas-retention.md`'s persona ordering — it is not resolved by
> this banner. `00-MARKET-BRIEF.md`'s positioning section already
> corrects for it ("the commute is the wedge and the founding ritual —
> not the product's identity"); treat that later document, not this
> memo's own commute-heavy framing, as the current word on how central
> commute framing should be.

Desk: Marketing / Market Research. Date: 2026-07-07. Product under study:
**CommutePilot** — a personal AI podcast curator, 4-card curated commute menu,
curiosity/learning-focused, anti-echo-chamber, iOS-first RSS client, single-user today
with multi-user monetization planned later (see `docs/brief/06_ROADMAP.md`, M7).

Method: web research via Edison Research (Infinite Dial, Share of Ear, The Podcast
Consumer), eMarketer, Ofcom, Sounds Profitable, Patreon, RevenueCat/Adapty subscription
benchmarks, and podcast-app vendor pricing pages. Every stat below is tagged with its
source year — treat anything without a citation as inference and it is labeled as such.
Numbers pulled from SEO aggregator posts (the "X podcast statistics 2026" genre) are
used only when they cite a primary source I could also independently verify; where I
could not verify a number's original source, I've excluded it or flagged it as soft.

---

## 1. Listening market

- **US monthly reach is at an all-time high.** Edison Research's *Infinite Dial 2026*
  puts monthly podcast listeners among Americans 12+ at **58% (≈167 million people)**,
  up from 55% in 2025. Weekly listenership grew faster than monthly, from **40% to
  45%** year-over-year (2025→2026).
  [The Infinite Dial 2026](https://www.edisonresearch.com/the-infinite-dial-2026/),
  [Broadcast Dialogue recap](https://broadcastdialogue.com/2026-infinite-dial-highlights-continued-podcast-online-audio-growth/)

- **2025 baseline:** Infinite Dial 2025 had weekly listening at 40% and monthly at 55%
  of Americans 12+, "record highs" at the time.
  [Infinite Dial 2025](https://www.edisonresearch.com/the-infinite-dial-2025/),
  [Podnews recap](https://podnews.net/press-release/edison-research-infinite-dial-2025)

- **Global monthly listeners** (eMarketer): ~507M (2023) → ~547M (2024) → ~584M (2025,
  est.) → ~619M (2026 projected) → ~652M (2027 projected).
  [eMarketer Global Podcast Listener Forecast](https://www.emarketer.com/content/global-podcast-listener-forecast-2022-2026)

- **US podcast ad spend** crossed **$2.51B in 2025**, projected to exceed $3B by 2028 —
  a proxy for how monetizable the medium has become, relevant background for our own
  future pricing conversations even though we're not an ad-supported product.
  [eMarketer-sourced aggregator](https://www.learningrevolution.net/podcast-stats/)

- **Volume of listening per active listener** is high: weekly listeners report roughly
  **8 episodes/week** and about **7–7.7 hours/week** of listening time.
  [Aggregated from Edison/industry surveys](https://keywordseverywhere.com/blog/podcast-listeners-stats/) —
  flagged as a **soft number**: several SEO aggregators cite this same figure without a
  traceable primary source; treat as directionally right (multiple shows per week,
  single-digit hours) rather than precise.

- **Where listening actually happens — this is the important one for us.** Edison's
  *Share of Ear* study (reported March 2025, "Home Beats Car for Podcast Listening
  Time") breaks daily podcast listening **time** down as: **Home 67%, Work 16%, Car
  11%, Other 6%**.
  [Edison: Most Podcast Listening Is At Home](https://www.edisonresearch.com/most-podcast-listening-is-at-home/),
  [Radio Ink recap](https://radioink.com/2025/03/06/edison-home-beats-car-for-podcast-listening-time/)

- **Car listening reach (not share of time) is bigger than the share-of-time number
  implies.** Edison's *The Podcast Consumer 2025* separately reports **31%** of
  Americans 18+ who drove/rode in a car in the last month listen to podcasts in their
  primary vehicle at all, and **44%** of those with CarPlay/Android Auto use those
  systems specifically to listen to podcasts while driving.
  [Podcast Consumer 2025 press release](https://podnews.net/press-release/podcast-consumer-2025)

- **In-car audio format share** (Edison Share of Ear, Q2/Q3 2025): AM/FM radio still
  dominates the car at **57% of in-car listening time** (75% reach); streaming music
  and SiriusXM each take ~15%; in-car listening is **29% of all audio consumption**
  across contexts (this is total audio — music, radio, podcasts — not podcasts alone).
  [National Public Media recap](https://www.nationalpublicmedia.com/insights/articles/am-fm-radio-continues-to-dominate-in-car-listening/)

- **CarPlay/Android Auto penetration**: as of Q2 2025, roughly one-third of Americans
  13+ have CarPlay or Android Auto in their primary vehicle; among those who have it
  and drove in the past month, ~83% use it regularly. Infinite Dial 2025 similarly
  found 28% have CarPlay (22% actively use it) and 19% have Android Auto (13% actively
  use it).
  [Radio Ink](https://radioink.com/2025/07/31/in-car-audio-behavior-shifts-with-carplay-android-auto-growth/),
  [Infinite Dial 2025 summary](https://www.edisonresearch.com/the-infinite-dial-2025/)

- **Smart speakers**: ~20% of podcast listeners use smart speakers weekly for
  podcasts; smartphones + car dashboards dominate overall device share in North
  America.
  [Aggregated from Edison-sourced industry commentary](https://commandyourbrand.com/which-devices-are-people-using-to-listen-to-podcasts-in-2025/)

- **Podcast listeners over-index on income/education**: 51–58% of monthly podcast
  consumers are college-educated (vs. 46% general population), and 56% earn $75K+/year
  (vs. 48% general population).
  [Edison-sourced demographic summary](https://podscan.fm/blog/podcast-statistics-for-marketers-2025)

**⚠️ Flag — contradicts a core product assumption.** CommutePilot is built around
"I get in my car, the app has a session ready" as the primary use occasion. The
Share-of-Ear data says podcast listening is **overwhelmingly a home-listening behavior
(67% of time) and only 11% of time happens in the car** — home beats car roughly 6:1 on
a time basis. The reach numbers are friendlier (31% of drivers listen to podcasts
in-car at all; 44% of CarPlay/Android Auto users do), meaning "car" is a real and
non-trivial *occasion* even if it's a minority of total *listening hours*. See
Implications §1.

---

## 2. Discovery pain

- **Word of mouth still leads discovery**, but its lead is narrower than product
  folklore assumes and is highly age-skewed. Ofcom's UK 2025 Audio Report: word of
  mouth cited by **34%** of adults overall as a discovery channel, rising to **45–47%**
  among some listener segments for friends/family recommendations specifically; among
  **18–34s, social media (63%)** outweighs word of mouth (the 34% overall figure drops
  in relative importance for this cohort).
  [Ofcom Audio Report 2025 PDF](https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/data/statistics/2025/audio-report-2025/audio-report-2025.pdf),
  [summary via adambowie.com](https://www.adambowie.com/blog/2025/05/ofcom-podcast-survey-and-audio-report-2025/)

- **US-specific discovery ranking** (2024–2025 industry surveys): searching a podcast
  app's own directory led at **40%**; recommendations from friends/family/colleagues
  **37%**; YouTube alone **40%**, and YouTube + social platforms combined account for
  **61%** of all podcast discoveries — a meaningful shift away from pure word-of-mouth
  toward platform algorithms in the last 2–3 years.
  [The Podcast Host discovery stats roundup](https://www.thepodcasthost.com/business-of-podcasting/podcast-discovery-stats-2024/),
  [Podnews summary](https://podnews.net/update/podcast-discovery-tph)

- **Discovery friction is real but not universal.** Just over a quarter of podcast
  listeners say they struggle to find new content; roughly two-thirds say it's easy to
  find shows they're interested in — a genuinely split picture, not unanimous pain.
  Among people who *stopped* listening to podcasts (UK data), **34%** cited "I can't
  find any podcasts that interest me" as the reason — discovery failure is a churn
  driver, not just an onboarding annoyance.
  [The Podcast Host / Ofcom-sourced](https://www.thepodcasthost.com/promotion/podcast-discoverability/)

- **Subscription-list size vs. active rotation**: the average listener subscribes to
  roughly **6–7 shows**, and about **22%** of listeners maintain larger libraries (70+
  subscriptions) — but actively-engaged rotation is much smaller: most listeners report
  sticking to **3–5 favorite shows** day to day. This is the clearest quantified
  version of "the discovery problem" — people accumulate subscriptions but don't
  actually rotate in new ones.
  [Aggregated industry stats](https://podcastatistics.com/) — **soft number**, multiple
  aggregator sites repeat this figure without a single traceable Edison/Nielsen primary
  source; treat the *shape* (small active rotation, larger dormant subscription list)
  as reliable, the exact "6 vs 7" digit as approximate.

- **Industry commentary confirms discovery is podcasting's known unsolved problem.**
  Trade press headlines through 2025–2026 ("Is Discovery Still A Problem?", "Can AI Fix
  the Podcast Discovery Problem?", Sounds Profitable's *Podcast Discovery Playbook
  2026*) treat discoverability as a persistent, unsolved, actively-debated issue rather
  than something platforms have already cracked — Sounds Profitable frames it
  explicitly as "a 12-month system, not a 12-week push," i.e., no one has a clean
  answer yet.
  [Podcast Business Journal](https://podcastbusinessjournal.com/is-discovery-still-a-problem/),
  [The Podcast Host](https://www.thepodcasthost.com/business-of-podcasting/podcast-discovery-problem/),
  [Sounds Profitable Discovery Playbook 2026 landing page](https://soundsprofitable.com/research/the-podcast-discovery-playbook-2026/)

- **YouTube's rise as a discovery/consumption channel is the biggest recent structural
  shift.** A July 2026 Forbes piece reports podcast listeners increasingly use YouTube
  and social media for discovery over dedicated podcast-app directories — relevant
  because CommutePilot is explicitly RSS-native and Spotify/YouTube-second-class per
  the architecture brief; the dominant discovery surface in the market is one we've
  deliberately chosen not to build on.
  [Forbes, July 2026](https://www.forbes.com/sites/frankracioppi/2026/07/07/podcast-listeners-use-youtube--social-media-for-podcast-discovery/)

---

## 3. Completion & engagement behavior

- **Completion rates are high relative to other media** — commonly cited benchmarks put
  average episode completion around **70%**, with some genres (true crime) reaching
  **~85%**; "anything above 70%" is treated industry-wide as a healthy completion
  benchmark.
  [Aggregated podcast analytics commentary](https://podrewind.com/blog/podcast-completion-rate-analysis) —
  soft/aggregate number, sourced from hosting-platform analytics blogs rather than a
  single named study; consistent across multiple independent sources so the ~70% range
  is reasonably trustworthy as an order of magnitude.

- **Session length**: average listening session is reported around **38 minutes**,
  rising to **~52 minutes** for educational/business-genre shows specifically — i.e.,
  our target genre (learning-oriented content) already produces longer per-session
  engagement than the average podcast.
  [Simplecast 2025 listening insights](https://blog.simplecast.com/podcast-listening-insights-for-2025-what-podcasters-need-to-know) —
  soft number.

- **Playback speed usage**: the most recent hard survey number is from 2019
  (Statista/Edison): **26%** of US podcast listeners used increased playback speed, up
  from 19% the year prior — no equivalently rigorous 2024–2026 replacement was found in
  this research pass; anecdotal/community sources (Reddit, podcast-host blogs) suggest
  1.3–1.5x is a common "typical power-user" setting, and comprehension research finds
  **no significant recall loss up to 1.5x**, with **5–10% recall degradation at 2x for
  unfamiliar/dense material**.
  [Statista 2019 figure](https://www.statista.com/statistics/912409/united-states-increasing-playback-speed-podcasts/),
  [comprehension-at-speed commentary](https://blog.descontrolepodcast.com/speed-listening-are-we-missing-the-point-at-2x-playback/) —
  **flagging the 2019 data point as stale**; treat "meaningful minority use
  faster-than-1x playback, especially for familiar/lower-density content" as the safe
  inference, not a precise current percentage.

- **Back-catalog vs. new-release listening**: I could not find a clean, sourced
  2024–2026 statistic quantifying the back-catalog/new-release split at the
  whole-market level in this research pass. What is available: **46%** of listens
  happen within 24 hours of an episode's release (per aggregator stats), implying a
  substantial new-release-driven listening pattern for at least a plurality of episode
  consumption, with the remainder presumably back-catalog/binge — but this is
  **inference**, not a directly sourced split.
  [Aggregator](https://www.loopexdigital.com/blog/podcast-statistics) — soft number.

---

## 4. Willingness to pay

- **Overcast Premium**: $14.99/year (raised from $9.99/year in November 2024 — its
  first price increase in eight years). Ad removal + custom uploads are the paid
  unlock; core playback stays free.
  [Podcast News Daily](https://www.podcastnewsdaily.com/news/overcast-has-first-price-hike-in-eight-years/article_d3cd3aea-a82c-11ef-9abd-6f996564a59c.html)

- **Pocket Casts Plus**: $3.99/month or $39.99/year (raised from a $14.99/year legacy
  rate for pre-2023 subscribers). A higher **Patron** tier exists at $9.99/month or
  $99.99/year. Notably, in March 2025 Pocket Casts made its web/Mac/Windows apps fully
  free, narrowing what Plus actually gates (folders, Smart Shuffle, bookmarks, chapter
  preselection, watch apps, 20GB cloud storage).
  [Pocket Casts pricing support](https://support.pocketcasts.com/knowledge-base/pocket-casts-plus-pricing/),
  [9to5Google, March 2025](https://9to5google.com/2025/03/11/pocket-casts-web-free/)

- **Castro Plus**: $3.99/month or $24.99/year, one-week free trial, gates power-user
  features (trim silence, voice enhancement, sideloading, mono-mix, chapters).
  [Castro pricing page](https://castro.fm/blog/pricing-updates)

- **Pattern across all three prosumer podcast apps**: converge tightly on **$3.99/month
  or $25–40/year** for a "remove friction / add power features" tier — none gate core
  playback. This is the closest direct analog to what a future CommutePilot
  subscription price point would face in the market. No public subscriber-count
  figures were found for any of the three (Overcast, Pocket Casts, Castro don't
  disclose numbers) — **could not verify** market size at the individual-app level.

- **Podcast creator-side monetization is large and growing**, useful context even
  though CommutePilot doesn't host content: Patreon reports podcasters earned **$629M
  in 2025** (up 33% YoY), the platform's single largest content category, across
  **7.6M paid memberships** and 47,000+ earning podcasters. Apple Podcasts
  Subscriptions supports 500,000+ paid shows with channel subscriptions up 41% YoY;
  Apple takes 30% of subscription revenue in year one, 15% after, plus a $19.99/year
  program fee.
  [Variety, April 2026](https://variety.com/2026/digital/news/patreon-podcaster-earnings-2025-biggest-content-category-1236710779/),
  [Tubefilter](https://www.tubefilter.com/2026/04/08/patreon-podcasts-annual-revenue-629-million/),
  [PodPosted Apple Subscriptions review](https://www.podposted.com/resources/apple-podcasts-subscriptions)

- **iOS subscription-app conversion benchmarks (2025, RevenueCat/Adapty State of
  Subscription Apps)**: Media & Entertainment apps see a median trial-to-paid
  conversion of **43.8%**; Utilities lead trial-to-paid at **35.0%** and post the
  highest 12-month LTV per trial user (**$68.90**) and best first-renewal retention
  (**58.1%**) of any category. "Hard paywall" designs convert download-to-paid at a
  median **12.1%**, vs. just **2.2%** for freemium. Popular trial length is 5–9 days
  (used by 52% of apps), though longer 17–32 day trials convert best (**45.7%**).
  [RevenueCat State of Subscription Apps 2025](https://www.revenuecat.com/state-of-subscription-apps-2025/),
  [Adapty trial-conversion benchmarks](https://adapty.io/blog/trial-conversion-rates-for-in-app-subscriptions/)

---

## 5. The learning-listener niche

- **Educational podcasts are a real and growing category, not a niche footnote**:
  ~**17% of total podcast uploads** in 2025 are categorized as educational, one of the
  fastest-growing upload categories; language-learning and investing content are cited
  as the fastest-growing *paid* subcategories.
  [Aggregated 2025 Apple Podcasts chart commentary](https://electroiq.com/stats/apple-podcast-statistics/) —
  soft number (uploads share, not listening-time share; a large upload share doesn't
  necessarily mean proportionate listening share).

- **Session-length signal for the category**: educational/business podcast sessions
  average **~52 minutes** vs. ~38 minutes overall — the learning-oriented listener
  engages longer per sitting than the average podcast listener, directly relevant to
  how much curated content per "session" CommutePilot should assemble.
  [Simplecast 2025](https://blog.simplecast.com/podcast-listening-insights-for-2025-what-podcasters-need-to-know) —
  soft number, same caveat as §3.

- **Adjacent "listen to learn" audio markets are large and growing fast.** Audible:
  ~15M+ active global subscribers, ~58% US, ~$4.3B estimated 2025 subscription revenue,
  71% annual retention, controls an estimated 60–70% of the global audiobook market.
  Global audiobook market estimates range from ~$10B (2025) to low-teens billions
  depending on methodology, with double-digit-to-mid-20s% CAGR projected through the
  early 2030s across every research firm surveyed — directionally consistent even
  though absolute-dollar estimates vary by source.
  [Aggregated audiobook market research](https://www.grandviewresearch.com/industry-analysis/audiobooks-market),
  [subscriber/retention figures](https://scoop.market.us/audiobooks-statistics/)

- **Book-summary / microlearning apps** (Blinkist and peers Headway, Shortform):
  Blinkist alone reports **40M users** (up from a previously reported 14M —
  order-of-magnitude growth, though the exact timeframe of that jump wasn't
  independently verified in this pass). In its own user survey (n=3,500, US), **87.5%**
  say they make life changes based on what they learn via the app, and **~70%** of
  users prefer listening over reading the content.
  [Blinkist company materials](https://www.blinkist.com/magazine/posts/inside-story-blinkist-started-self-help-revolution) —
  **self-reported vendor data, not independently audited**; treat directionally, not as
  precise.

- **Psychological research supports a distinct "curious/learning" listener
  disposition.** A peer-reviewed 2022 study (PLoS One, n=306, 240 podcast listeners)
  found **openness to experience** (B=.45, p=.040), **interest-based curiosity**
  (B=.65, p=.013), and **need for cognition** (B=.51, p=.016) each significantly and
  positively predicted podcast listening, while **need to belong** negatively predicted
  it (B=-.38, p=.046) — podcasting, unlike social media, attracts people motivated by
  information-seeking/curiosity rather than social connection. This is a genuine
  academic anchor (not an aggregator stat) for "curiosity-driven, not social/FOMO-
  driven" as the core listener psychographic CommutePilot should design for.
  [PLoS One via PMC, 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8985929/)

- **General motivation surveys** reinforce this: 63% of listeners say podcasts give
  them access to "more in-depth conversations and interviews than other media," and
  podcasts are frequently described in industry commentary as the preferred medium for
  "learning while multitasking" (commute, chores, workouts).
  [Aggregated 2025 listener-motivation summary](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8985929/) —
  soft number, industry-commentary tier rather than primary research, cited for
  directional support only.

---

## Implications for CommutePilot

1. **Reframe "commute" as the anchor occasion, not the only occasion — the data does
   not support car-exclusive framing.** Edison Share of Ear puts car listening at only
   **11% of podcast listening time** vs. **67% at home** (2025 data). CommutePilot's
   whole architecture (offline-first downloads, car-safe voice UX, session cadence
   keyed to commute times) is built for a use-case that is real (31% of drivers *do*
   listen to podcasts in-car; 44% of CarPlay/Auto users do) but is a **minority of
   total listening hours** even for people who own the behavior. **Decision-ready
   implication**: don't narrow the product's mental model to "car app." The
   session-builder and 4-card menu format should work equally well for a
   home-listening or gym-listening trigger, not just a GPS-detected commute — this is
   cheap to keep general (the roadmap already treats "pre-morning/pre-evening" as
   configurable cron, not GPS-locked) and meaningfully de-risks the total addressable
   occasion count. *(Fact, flagged as contradicting the founding car-first framing.)*

2. **The CarPlay/Android Auto build-out (M6 stretch) is well-justified even though car
   is a minority of listening time.** Reach data (44% of CarPlay/Auto owners use it for
   podcasts; ~33% of CarPlay-owning respondents actively use CarPlay at all in 2025)
   shows the car occasion is concentrated among exactly the tech-forward,
   habit-forming users CommutePilot should acquire first. **Inference**: prioritize
   CarPlay entitlement application early (already a roadmap decision) not because it
   captures the most listening *hours*, but because it captures a high-intent,
   high-retention *occasion* that's hard to serve well with a generic client — this is
   CommutePilot's differentiation wedge, not its volume play.

3. **Discovery pain is real but partial (roughly a quarter to a third of listeners
   actively struggle), and word-of-mouth is eroding relative to algorithmic/social
   discovery (YouTube + social ≈ 61% of discovery in 2024–2025 data).** CommutePilot's
   anti-echo-chamber, serendipity-floor curation design is aimed at exactly this
   friction, but the market data suggests the sharper pain point isn't "I can't find
   anything" (most people say discovery is *easy*) — it's "the things I find don't
   actually match what I'd enjoy" and "I default to social/algorithmic feeds I don't
   fully trust." **Decision-ready implication**: the product's differentiator should be
   pitched as *curation quality and trustworthiness*, not raw discovery/search —
   CommutePilot isn't competing with "search a directory," it's competing with "scroll
   YouTube and hope," which is a lower bar to clear on quality but a harder bar to
   clear on habit formation (YouTube already owns the attention).

4. **The "subscribe to 6-7 shows, actively rotate only 3-5" pattern validates the core
   product thesis.** If listeners genuinely accumulate podcast subscriptions faster
   than they rotate them into active listening, that's a direct empirical argument for
   a curator that actively resurfaces and re-ranks from an existing subscription graph
   rather than only pushing new discovery — CommutePilot's "continue" cards and
   taste-graph re-ranking (already in the M5 roadmap) are targeting a documented
   behavior, not a hypothesized one. Treat the exact "6-7 / 3-5" digits as soft, but the
   *shape* (subscribe more than you rotate) as reliably supported across multiple
   independent sources.

5. **Pricing envelope: $3.99/month or ~$25-40/year is the established
   prosumer-podcast-app price point** (Overcast $14.99/yr, Pocket Casts $39.99/yr or
   $3.99/mo, Castro $24.99/yr or $3.99/mo — all 2024-2025 data). CommutePilot's future
   monetization phase (M7) should anchor to this band by default rather than
   positioning as a premium/luxury product — none of the three comparable apps gate
   core playback, only power features, which matches CommutePilot's own architecture
   (curation/session-building is the differentiated value, so that's what should be
   gated, not audio playback itself). **Decision-ready**: budget for ~$4/month or
   ~$30/year as the anchor price to validate against, not a general "media app" price
   point.

6. **Utility-category subscription economics favor CommutePilot's positioning over an
   "entertainment" framing.** RevenueCat/Adapty 2025 benchmarks show Utilities apps
   lead trial-to-paid conversion (35.0%), best first-renewal retention (58.1%), and
   highest 12-month LTV ($68.90) of any category — outperforming generic Entertainment
   (19.1% trial-to-paid). **Decision-ready implication**: when CommutePilot eventually
   builds a paywall (M7), position and market it as a *utility that saves you
   decision-fatigue time* (a curation tool), not as an entertainment subscription —
   this framing should also shape onboarding copy and App Store category selection
   later.

7. **A hard paywall converts ~5x better than freemium (12.1% vs 2.2% download-to-paid,
   2025 data), but that's in tension with CommutePilot's single-user, RSS-client
   positioning.** Podcast clients live or die on trust and habit before monetization;
   freemium-with-a-generous-free-tier (matching Overcast/Pocket Casts/Castro's own
   model — free playback, paid power features) is the safer analog for a
   podcast-adjacent app, even though it converts worse on paper, because the comparable
   apps in this exact space all chose freemium, not hard paywalls. **Inference**, worth
   revisiting explicitly at the M7 gate rather than defaulting to whichever benchmark
   looks best in isolation.

8. **The "curious, high-need-for-cognition, low-need-to-belong" listener profile
   (PLoS One 2022, n=306) is a genuine psychographic anchor for the curation spec**,
   not just marketing color. It supports two concrete product choices already in
   `03_CURATION_SPEC.md`/`05_CORNER_CASES.md`-adjacent thinking: (a) why-lines and
   intros should appeal to *curiosity and information value*, not social proof
   ("everyone's listening to this") — the target user is measurably less motivated by
   belonging/social signals than the average media consumer; (b) the serendipity floor
   (recommending excellent-and-adjacent content outside the demonstrated-interest
   cluster) is well-matched to a population that scores high on openness to
   experience, i.e., these users are more likely than average to actually reward being
   stretched, not just soothed.

9. **The learning-audio market (audiobooks + microlearning apps) dwarfs podcasting's
   dedicated "educational" niche in dollar terms and growth rate** — Audible alone is a
   ~$4.3B/year subscription business growing at double-digit CAGR, and Blinkist-style
   summary apps report tens of millions of users. This is **inference**, not a direct
   CommutePilot data point, but it's a meaningful sanity check: the "listen to learn"
   appetite CommutePilot is built to serve is proven at a market level by adjacent
   categories, even though podcasting's own "educational" tag is a comparatively modest
   ~17% of uploads (not necessarily of listening time — that split wasn't found). Read
   this as: the target psychographic is well-established and monetizes well elsewhere;
   CommutePilot's bet is that curation, not content creation, is the missing layer for
   that same appetite inside podcasting specifically.

10. **Data gaps to flag honestly, not paper over.** No reliable, sourced 2024–2026
    figure was found for: (a) exact back-catalog vs. new-release listening split at
    market level (only a soft 46%-within-24-hours proxy); (b) current playback-speed
    adoption (most recent hard number is from 2019); (c) any competitor's actual
    subscriber counts (Overcast/Pocket Casts/Castro don't publish them). Before using
    any of these as inputs to a business-plan number (e.g., "X% of our users will use
    1.5x speed" or "we expect Overcast-level penetration"), commission fresh primary
    research (a short survey of CommutePilot's actual early users) rather than leaning
    on these stale/soft industry figures.

---

*Research limitations: this pass relied on WebSearch/WebFetch against public web
sources in a single session; no paid research databases (Statista Pro, Edison's full
underlying datasets, Sounds Profitable's paywalled PDF reports) were accessed, so
several figures are secondhand via aggregator sites rather than primary-source PDFs.
Where a stat could only be found on SEO-aggregator "podcast statistics 2026"-style
pages without a traceable primary citation, it is explicitly marked "soft number" above
and should not be treated as precise.*
