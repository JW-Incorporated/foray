# 04 — Personas & Retention: Audience Insights for CommutePilot

> **Name change since this memo — 2026-08-21.** This memo was researched
> against a working name, "CommutePilot," which is not the shipped
> product: the founder chose **4a** (`foray` now names only the
> stitched-audio unit — see `06-naming-study.md`, `docs/DECISIONS.md`).
> Read every "CommutePilot" below as "4a." **Applicability:** the
> persona research, retention/churn findings, and trust-in-AI evidence
> below still apply as-is. **Two items need explicit reinterpretation,
> not just a name swap:** (1) implication #10 below ("do not expand
> toward AI-hosted or AI-narrated content") is now superseded — per
> `docs/DECISIONS.md`'s 2026-09-02 entry (founder D1=A, kanban card
> `t_54913003`), 4a is adding AI-generated audio (a "foray") as a
> disclosed second capability alongside curation, so this memo's TTS
> scope boundary no longer holds as written; the underlying trust
> research (disclosure risk, AI fatigue, listeners preferring a human
> host) is still real and should inform *how* generation is disclosed,
> just not *whether* to ship it. (2) this memo's persona ordering and
> "Read for CommutePilot" framing lean on commute-centric context even
> though Edison Research data (also cited in `02-listener-market.md`)
> shows only ~11% of listening happens in cars — see
> `00-MARKET-BRIEF.md`'s positioning section for the corrected framing
> ("the commute is the wedge... not the product's identity").

Research desk memo. Scope: jobs-to-be-done for podcast discovery, evidence-based personas, churn/retention patterns in podcast apps, trust in AI recommendations, and what the research says about our own second user (a friend testing on Android). Sources are cited inline; where a search returned no citable primary source (e.g., an early query on Spotify AI DJ user sentiment returned no attributable links), the claim was dropped rather than presented as sourced.

**Method note.** Research ran across WebSearch (App Store/Play Store review synthesis, Reddit threads, industry surveys) and WebFetch (deep reads on the highest-value hits) in July 2026. Reddit's own search index returned few directly quotable threads on r/podcasts for this pass — the discovery-frustration evidence below leans more heavily on Spotify Community forum threads, App Store review language, and industry commentary (MIDiA Research, Edison Research) than on raw subreddit quotes. Flagged explicitly wherever a claim rests on secondary synthesis rather than a primary quote.

---

## 1. Jobs-to-be-done for podcast discovery

The classic JTBD frame (Christensen's milkshake study, popularized further via Spotify's own JTBD work) is that people don't "want a podcast," they hire something to do a job in a specific context. Applied to audio: JTBD research on Spotify found heavy streaming use clustered around *driving* — people were "bored with listening to the radio and liked the option" of on-demand audio as a boredom-killer with agency attached, not a passive backdrop [Railsware, JTBD Examples: Spotify, Duolingo, Uber](https://railsware.com/blog/jobs-to-be-done-examples/).

Layered on top of "kill boredom," two more jobs show up consistently in listener research:

- **Learn something in dead time.** Listeners increasingly play educational/informational content at 1.5x–2x speed specifically to convert commute minutes into learning throughput — this is reported both as a personal productivity hack and as a broader trend in "content rich in information" consumption [How-To Geek, *Listening to podcasts at 1.5x speed doesn't make me a monster*](https://www.howtogeek.com/playing-podcasts-at-high-speed-doesnt-make-me-a-monster/); forum discussion converges on 1.25x–1.5x as the sweet spot for retaining comprehension while still compressing time [Pocket Casts community forum](https://forums.pocketcasts.com/forums/topic/podcast-speed-recommendations-for-learning-english-and-personal-development/).
- **Feel less alone.** A University of Queensland study (Stephanie Tobin, ~300 adults surveyed) found podcast listeners form genuine parasocial relationships with hosts, and that listeners with stronger parasocial bonds reported lower loneliness and higher social "relatedness" — the effect held regardless of genre, and scaled with hours listened, not content type [The Podcast Host, *Listening to Podcasts Makes Us Feel Less Lonely, Study Finds*](https://www.thepodcasthost.com/business-of-podcasting/podcast-listeners-less-lonely/). The mechanism is partly neurological: the brain has voice-selective regions that respond more strongly to human vocal sound than other audio, which is why a familiar host's voice reads as company rather than noise.
- **Background company / task-pairing.** Podcast listening is structurally a *second-activity* medium — driving, chores, walking — which is itself why podcasts rarely go viral the way video does: "the complementary nature of audio means you're rarely in sharing mode when consuming" [MIDiA Research, *Podcasts have a recommendation problem*](https://www.midiaresearch.com/blog/podcasts-have-a-recommendation-problem).

Where people actually listen complicates the "commute" framing, and the numbers in circulation genuinely disagree depending on what's being measured. Edison Research's Share of Ear data — a diary-based study of total listening *time* — shows only ~11% of podcast consumption happens in a car, versus 67% at home [Edison Research, *How Do Americans Spend Their Day with Audio?*](https://www.edisonresearch.com/how-do-americans-spend-their-day-with-audio/). Within car-audio specifically, podcasts (31% monthly reach) still trail AM/FM (74%) and online audio (55%) [Edison Research Q3 2025 Share of Ear via Westwood One](https://www.westwoodone.com/blog/2025/12/08/q3-2025-edison-share-of-ear-am-fm-radio-dominates-ad-supported-audio-while-podcast-audiences-age-as-older-audiences-surge/). Elsewhere, lifestyle-press coverage cites a much higher figure — "49% of podcast listeners tune in while they're in the car" [Monster, *10 podcasts that make us wish our commute was longer*](https://www.monster.com/career-advice/article/best-podcasts-for-commuters) — but that's measuring the share of *listeners who ever listen in a car at all*, a different denominator than share of total listening *minutes*. Both can be true simultaneously: nearly half of listeners sometimes listen in the car, while the car still accounts for a minority of total minutes because at-home listening sessions run longer. Overall podcast consumption is at a record high regardless (73% of Americans consumed a podcast in 2025, up from 67% in 2024) [Edison Research, *The Infinite Dial 2025*](https://www.edisonresearch.com/the-infinite-dial-2025/). **Read for CommutePilot**: the commute is a small share of total listening minutes but a large, high-intent share of *listeners* and, critically, a moment with a hard time-box and near-zero opportunity for browsing — exactly the constrained context a curation product should own rather than trying to be a general-purpose player.

**Discovery channels, 2025.** Where people currently find new shows matters for how much weight our own recommendation surface can realistically carry. Platform-algorithm discovery is dominated by video-adjacent services — YouTube is now the service used most often for podcasts by 33% of US weekly listeners, ahead of Spotify (26%) and Apple Podcasts (14%) [Edison Research Infinite Dial 2025, via industry coverage](https://www.podcastvideos.com/articles/the-future-of-podcast-discovery-algorithms-newsletters-or-word-of-mouth/). But algorithmic reach and *trust* diverge: word of mouth — recommendations from friends, communities, and creators listeners already follow — consistently shows up as the highest-*trust* driver of trial, even where it isn't the highest-*volume* channel. That gap (high reach, lower trust for algorithms; lower reach, highest trust for a known person's recommendation) is the opening a personal curation product is built to exploit: a why-line that reads like a friend's reasoning, not a platform's engagement bait, is aiming at the trust channel rather than competing on the reach channel.

**Bottom line on JTBD**: nobody is hiring a podcast app to "browse a catalog." They're hiring it to (a) kill dead time with (b) something that teaches them, and/or (c) makes them feel accompanied — with *discovery itself* being the unsolved, actively painful part of the job (see §3), and with trust in *who* is doing the recommending mattering as much as the recommendation's accuracy.

---

## 2. Personas

Four evidence-grounded personas for a curation-led app. Each trait is tied to a finding above or below, not invented.

| | Primary job | Discovery frustration | Switch trigger | Kill criteria |
|---|---|---|---|---|
| **A. Commuter-Learner** (founding user) | Learn something in dead time | Nobody's solved podcast rec; generic top-charts feels beneath them | Why-line that references *my* actual taste graph | Audio/technical failure, not a bad pick |
| **B. Lonely-Commute Companion Seeker** | Feel less alone via familiar hosts | Apps push novelty when they want validation | Comfort treated as first-class, not fallback | Synthetic-feeling why-line breaks the parasocial illusion |
| **C. Echo-Chamber-Wary Explorer** | Escape algorithmic narrowing | "Not interested" feedback silently ignored | Transparent, explainable serendipity | Serendipity reads as noise, not curated adjacency |
| **D. Switching-Cost-Anchored Loyalist** | Keep what already works | None active — already solved discovery for themselves | An additive layer, not a migration ask | Any added friction at all |

### Persona A — The Commuter-Learner (founding user)
- **Who**: engineer, 15–20 min solo drive, listens at 1.5x, curiosity range spans from fusion energy to Damascus-steel forging.
- **Listening context**: short, high-frequency, solo, hands-busy — the highest-intent slice of listening even though it's a minority of total volume (Edison's 11%-in-car figure, above).
- **Current tools**: Apple Podcasts / Overcast, subscription list built by memory and scattered recommendations; likely already runs speed at 1.25–1.5x per the widely-cited "sweet spot" for retaining comprehension.
- **Discovery frustration**: even industry insiders admit nobody has solved podcast recommendation — "I don't think anyone has figured out the algorithm that knows exactly what [podcast] to serve to who" (Josh Clark, *Stuff You Should Know*, via [MIDiA Research](https://www.midiaresearch.com/blog/podcasts-have-a-recommendation-problem)). This persona over-indexes on "need for cognition" and openness to experience (Tobin study correlate), meaning generic top-charts recommendations feel beneath them.
- **What would make them switch**: a menu that explains *why* a pick is theirs, referencing their actual taste graph rather than generic praise — matches the explicit product bet (the why-line "referencing my context, not generic praise").
- **Kill criteria**: technical/audio failure, not a bad recommendation. This is a strong, evidence-backed distinction (see §3) — a stutter or lost position kills faster than a miss on taste.

### Persona B — The Lonely-Commute Companion Seeker
- **Who**: solo commuter or home-alone listener who returns to 3–5 trusted shows/hosts rather than exploring.
- **Listening context**: values *familiar voice* over novelty; podcasts function as parasocial company, not information delivery.
- **Current tools**: a short, static subscription list; low tolerance for churn in "their" shows.
- **Discovery frustration**: it's not that discovery is broken for them — it's that discovery UIs treat every session as a chance to push something new, when what they want is validation that today's picks include a familiar face. The Tobin research is explicit that parasocial bond, not genre, predicts reduced loneliness — so a rotating cast of strangers works against the job they're hiring the app for.
- **What would make them switch**: an app that treats "comfort" as a legitimate first-class recommendation category, not a fallback — directly matches CommutePilot's four-archetype design (deep-learn / stretch-adjacent / narrative / **comfort**).
- **Kill criteria**: an AI-generated why-line or synthetic voice that feels uncanny and breaks the illusion of a familiar presence; also, a comfort pick silently deprioritized in favor of "more optimal" discovery.

### Persona C — The Echo-Chamber-Wary Explorer
- **Who**: sophisticated media consumer, burned by years of algorithmic feeds narrowing over time on other platforms.
- **Listening context**: actively distrustful of "For You" surfaces; the 2026 AI-content backlash is sharp — only 19% of users report feeling excited about AI, down from 50% two years prior, and 54% of Americans report active "AI fatigue" that measurably reduces trust, clicks, and conversion [WebProNews / industry AI-slop coverage, 2026](https://www.webpronews.com/ai-slop-floods-social-media-in-2025-backlash-spurs-2026-reforms/); platforms are already shipping "dial it down" controls in response (Pinterest's AI content tuner) [NBC Bay Area](https://www.nbcbayarea.com/news/national-international/ai-slop-platforms-dial-it-down/4022838/).
- **Discovery frustration**: recommendation engines that ignore explicit negative feedback are a top complaint pattern — Spotify's own community forums are full of "kept recommending" threads where users report hitting "not interested" repeatedly with no effect [Spotify Community, *Removing Podcast Recommendations*](https://community.spotify.com/t5/Live-Ideas/Removing-Podcast-Recommendations/idi-p/5823405). Algorithms in general "do not understand the distinction between quality and engagement," reinforcing already-popular content into filter bubbles [The Conversation, *Feedback loops and echo chambers*](https://theconversation.com/feedback-loops-and-echo-chambers-how-algorithms-amplify-viewpoints-107935).
- **What would make them switch**: transparent, *explainable* serendipity — a system that can say "you liked the metallurgy episode, this is the same itch" rather than silently injecting novelty.
- **Kill criteria**: if the "serendipity" reads as noise rather than curated adjacency, this persona churns fastest of the four — they already have a low tolerance for algorithmic hand-waving.

### Persona D — The Switching-Cost-Anchored Loyalist (adoption-barrier persona, not a target to win outright)
- **Who**: 5+ year user of Overcast or Pocket Casts with a deep, invisible investment in their current app.
- **Listening context**: whatever the app already does well; they are not actively seeking anything.
- **Current tools**: heavily configured — e.g. Overcast loyalists cite Voice Boost and Smart Speed by name as the reason they stay, describing competitors' silence-removal as sounding "badly edited" by comparison [James Cridland, *Why Overcast is more than a podcast player*](https://james.cridland.net/blog/2024/why-overcast-is-more-than-a-podcast-player/).
- **Discovery frustration**: largely absent — they've solved discovery for themselves already, which is precisely why they're hard to acquire.
- **What would make them switch (or, realistically, add)**: not a discovery pitch. Migration research shows OPML transfers subscriptions but **not** playback history, queue state, or in-progress positions — "listening history is stored locally or in app-specific cloud and doesn't export," and rebuilding a queue after migration takes real manual effort [Podcurator, *How to Switch Podcast Apps Without Losing Everything*](https://podcurator.io/blog/podcast-platform-migration-guide-2025). This sunk cost is the single biggest reason this persona won't *replace* their player — but they might *add* a discovery layer that hands off playback to their existing app, since that avoids the migration tax entirely.
- **Kill criteria**: literally any added friction. A power user who has already achieved zero-thought defaults will not tolerate "another app to manage" — CommutePilot must be strictly additive (which its external-handoff architecture already is).

---

## 3. Churn & retention in podcast apps

**Why people leave.** Two failure modes dominate app-store and forum complaints, and they are different in kind:

1. **Technical/reliability breakage.** The most viscerally-worded reviews describe crash loops and broken sync as the final straw: one reviewer reported roughly 100 crashes a month, needing a full phone restart with only "a 50-50 chance the app would actually load," concluding "it was time to make a change to another app." Others describe queue order silently corrupting — "episodes ordered A, B, C, D, E, F would no longer play in that order... might play A twice, skip to C, or stop altogether." Notably, one reviewer switched apps **despite having just renewed an annual subscription**, showing that reliability failures override sunk-cost loyalty [App Store review synthesis via search, Apple Podcasts / iMore coverage](https://www.imore.com/how-work-around-current-podcast-app-crashing-bug).
2. **Recommendation/algorithm fatigue.** A slower-burning but very widely documented complaint: users report recommendation surfaces that ignore explicit "not interested" feedback and keep resurfacing unwanted content, which reads as the app not listening to them [Spotify Community threads](https://community.spotify.com/t5/Live-Ideas/Removing-Podcast-Recommendations/idi-p/5823405). This doesn't usually trigger instant deletion the way a crash does — it triggers *disengagement* (fewer opens, more reliance on manual subscriptions) that precedes eventual uninstall.

**Single most-cited deletion trigger, ranked**: technical reliability failure (crash / broken sync / lost position) is the more *immediate and visceral* trigger in raw review language — it's the one people describe as the final moment they deleted the app. Recommendation fatigue is the more *universal* complaint but acts on a longer fuse. This maps directly onto CommutePilot's own founding principle, stated independently of this research: *"Audio correctness is the product. A janky transition or a lost playback position... will make me stop using it faster than a bad recommendation will"* (`docs/brief/04_VOICE_AUDIO_SPEC.md`). External research corroborates that instinct rather than contradicting it.

**What loyalists cite for staying.** Not novelty — specificity. Overcast's multi-year holdouts name two concrete engineering features (Voice Boost, Smart Speed) and a minimalist design philosophy that "focused on the thing you use them 99% of the time for: actually playing the podcast," not discovery [James Cridland](https://james.cridland.net/blog/2024/why-overcast-is-more-than-a-podcast-player/). Retention in this category is won on execution of the core loop, not feature breadth.

**Switching costs as an adoption barrier, not just a retention moat.** Because OPML migration loses playback history, queue state, and in-progress positions, users protect their current app not out of satisfaction but out of dread at rebuilding state [Podcurator migration guide](https://podcurator.io/blog/podcast-platform-migration-guide-2025). This cuts both ways for us: it's a moat once we have listeners, and it's exactly the friction our external-handoff architecture (cards deep-link to Apple Podcasts / Overcast / pod.link rather than requiring migration) is designed to route around.

---

## 4. Trust in AI recommendations

This is the most consequential research area for CommutePilot because the spoken why-line is a core, non-negotiable product bet.

**When explanation helps.** A 2025 Penn State study (Yuan Sun et al., using a fictitious dating-app recommendation scenario) found that the *need* for an AI explanation is expectation-dependent, not a flat preference:
- When a system meets expectations, users trust it and don't ask for an explanation — "if the system works fine, you just go along with it; you don't need a long explanation."
- When a system **underdelivers**, users demand a detailed explanation.
- When a system **overdelivers**, users still want a brief explanation — performance alone doesn't satisfy; as the researcher put it, "it's not just performance; it's transparency."
[Penn State, *To explain or not? Need for AI transparency depends on user expectation*](https://www.psu.edu/news/research/story/explain-or-not-need-ai-transparency-depends-user-expectation)

This is a strong, directly applicable finding: it predicts that why-lines matter *most* precisely on the cards where a pick could otherwise look confusing or off-target — stretch-adjacent and serendipity-floor picks — and matter *least* on obviously-in-lane picks (a familiar show's new episode, a Continue card).

**When disclosure backfires.** Research on AI-generated news content found a "transparency dilemma": disclosing AI involvement doesn't automatically build trust, and some readers trusted content **less** after disclosure — even when the disclosure included the details they'd asked for [arXiv, *Full Disclosure, Less Trust?*](https://arxiv.org/html/2601.09620v1). The implication is not "hide the AI" but "a generic disclosure without a genuine, specific reason is worse than no disclosure" — reinforcing that why-lines must reference real, personal context (as CommutePilot's spec already requires) rather than being a boilerplate "curated for you" stamp.

**The macro backdrop is hostile to generic AI framing.** 2026 sentiment has curdled: only 19% of users report feeling excited about AI, down from 50% two years ago, and 54% of Americans report active AI fatigue that measurably reduces trust and engagement [WebProNews, AI slop coverage](https://www.webpronews.com/ai-slop-floods-social-media-in-2025-backlash-spurs-2026-reforms/); platforms are shipping user controls to dial AI content down (Pinterest's AI tuner) [NBC Bay Area](https://www.nbcbayarea.com/news/national-international/ai-slop-platforms-dial-it-down/4022838/). This is the environment CommutePilot's why-line launches into — generic "AI picked this for you" framing is now actively counter-trust, not neutral.

**Where AI-hosted audio specifically has struggled.** The Washington Post's "Your Personal Podcast," an AI-personalized news podcast, drew immediate criticism over accuracy and motive [NPR, *Questions of accuracy arise as Washington Post uses AI to create personalized podcasts*](https://www.npr.org/2025/12/13/nx-s1-5641047/washington-posts-ai-podcast). Separately, Edison Research found that while roughly 1 in 5 podcast consumers have listened to an AI-narrated podcast, listeners generally accept AI as an *assistive* tool in production but still prefer a human host executing/hosting the actual content. **This validates CommutePilot's scope boundary**: TTS is used only for intros/transitions/why-lines, never to replace or narrate the underlying podcast — exactly the line the research says listeners are comfortable with.

---

## 5. The second user (cross-platform tester dynamics)

Our first external tester is a friend on Android — a personal-network recruit, which is the standard and recommended path for solo-founder beta testing: "reaching out to your personal network... is the most straightforward approach," with realistic expectations that roughly half of a 20–25-person invite list will actually follow through [App Console Lab, *How Indie Developers Get 12 Testers*](https://appconsolelab.com/blog/how-indie-developers-get-12-testers-for-new-apps).

Two findings are directly relevant to how we should treat this tester's feedback:

- **Unstructured beats formal at this stage.** "At early stages, unstructured conversation produces more useful signal than formal bug reports" — a casual channel (text thread, Slack DM) with a personal-network tester surfaces more useful signal than a structured feedback form would [App Console Lab](https://appconsolelab.com/blog/how-indie-developers-get-12-testers-for-new-apps). Don't over-formalize the intake from a single friend-tester.
- **Cross-platform parity gaps are a real, documented dissatisfaction source — but only once parity is *promised*.** Research on cross-platform apps shows unequal feature availability between iOS and Android is a consistent driver of user frustration, and that platform users hold different baseline expectations (iOS users, in particular, expect rapid follow-up on new-OS features) [academic synthesis via search, cross-platform parity literature](https://frill.co/blog/posts/understanding-feature-parity-in-product-development-examples-and-trap). The risk is specifically about *promised-then-missing* parity, not about a known, up-front "this is web/link-based for you for now" arrangement.

**Read for CommutePilot**: our architecture already sidesteps the parity trap rather than walking into it. The web-first pivot and pod.link universal-link handoff (`docs/DECISIONS.md`, 2026-07-07 entry: "pod.link (show-level universal links; covers Android testers)") means the Android friend gets a *complete, non-degraded* experience of the actual product bet — the curated menu and the why-line — without us having promised native Android functionality we then fail to deliver. That is the correct sequencing per the research: cross-platform resentment comes from broken promises, not from an honest MVP surface.

---

## Implications for CommutePilot

1. **Build first for Persona A, the Commuter-Learner** — this is already our founding user, and the research reinforces rather than revises that choice: high need-for-cognition audiences over-index on podcast listening (Tobin study) and are exactly who benefits from explained, adjacency-aware recommendations rather than top-charts sorting.

2. **Persona C, the Echo-Chamber-Wary Explorer, is the highest-leverage *second* persona to design toward.** Their core distrust (algorithmic narrowing, ignored feedback, AI-slop fatigue) is precisely the problem our serendipity floor and anti-echo-chamber design already solve — and word-of-mouth from a skeptical-but-convinced explorer is the highest-trust discovery channel that exists (Infinite Dial 2025: friend/community recommendation remains a top driver of trial). They're primed to evangelize if we deliver.

3. **Top retention risk, rank 1 — audio/technical reliability.** External churn research independently confirms what the product brief already states as its top principle: crashes and broken playback state are the most viscerally-cited, most immediate deletion triggers in the category, overriding even recent-purchase sunk cost. No new work is implied here, but this should stay the non-negotiable quality bar as tester feedback starts arriving — don't let curation polish crowd out audio-session correctness.

4. **Top retention risk, rank 2 — recommendation/algorithm fatigue.** The Spotify "kept recommending" pattern and 2026 AI-slop backlash both point to the same failure: recommendations that ignore explicit signal. Mitigate by keeping the existing spec's discipline (a skip is weak evidence against a topic, not a taste-graph collapse) and by making "why this, and why not something you'd skip" legible via the why-line — this is a slower-burn risk than #3 but the one most likely to quietly erode engagement before an uninstall.

5. **Top retention risk, rank 3 — switching-cost inertia blocking adoption, not just retention.** Since OPML migration loses playback history and queue state, competitor loyalists won't replace their player for us. This is already handled architecturally (external playback handoff, no migration required) — the implication is to keep messaging and onboarding consistent with "this adds to what you have," never "switch to us."

6. **Verdict on the spoken why-line: STRENGTHEN, with expectation-tuned verbosity.** The Penn State finding — explanation need scales with how much a pick deviates from expectation — validates the why-line as a real trust mechanism, especially on stretch-adjacent/serendipity-floor cards where a pick could otherwise look arbitrary. It also validates the spec's already-planned auto-brief rule (drop the show-explainer after N repeat intros; minimal intro on Continue cards): don't over-explain in-lane picks. The one caution, backed by the "transparency dilemma" finding, is that a generic or boilerplate-feeling why-line is worse than none — every line must reference genuine, specific listener context, never templated praise.

7. **The comfort archetype is retention infrastructure, not a fallback slot.** The Tobin loneliness research shows parasocial bond with familiar hosts, not content novelty, predicts reduced loneliness. For Persona B, silently swapping the comfort card for a "more optimal" discovery pick works directly against the job being hired for. Protect the comfort slot in scoring logic the same way deep-learn and stretch-adjacent slots are protected.

8. **Don't build a native Android app before there's a reason to.** The cross-platform research shows parity resentment stems from *promised-then-missing* functionality, not an honest link-based MVP. The current pod.link handoff already gives the Android tester a real, undegraded experience of the core bet (menu + why-line) — this is the right sequencing, not a compromise to fix urgently.

9. **Treat the second user's feedback informally, on purpose.** Solo-founder beta research is explicit that unstructured conversation outperforms formal bug-report channels at this stage. Resist the urge to build a feedback form or structured survey for a single friend-tester; a text thread will surface better signal.

10. **Keep TTS scoped to intros/transitions — do not expand toward AI-hosted or AI-narrated content.** Edison Research shows only ~1 in 5 listeners have tried AI-narrated podcasts and most still prefer a human host; the Washington Post's AI-personalized podcast drew immediate accuracy criticism. This is already CommutePilot's scope boundary (TTS never replaces the podcast itself); the research says don't relax it as a "personalization" feature later.

---

### Sources consulted
- [Railsware — Jobs To Be Done Examples: Spotify, Duolingo, Uber](https://railsware.com/blog/jobs-to-be-done-examples/)
- [How-To Geek — Listening to podcasts at 1.5x speed doesn't make me a monster](https://www.howtogeek.com/playing-podcasts-at-high-speed-doesnt-make-me-a-monster/)
- [Pocket Casts Forum — Podcast Speed Recommendations for Learning](https://forums.pocketcasts.com/forums/topic/podcast-speed-recommendations-for-learning-english-and-personal-development/)
- [The Podcast Host — Listening to Podcasts Makes Us Feel Less Lonely, Study Finds](https://www.thepodcasthost.com/business-of-podcasting/podcast-listeners-less-lonely/)
- [MIDiA Research — Podcasts have a recommendation problem](https://www.midiaresearch.com/blog/podcasts-have-a-recommendation-problem)
- [Edison Research — How Do Americans Spend Their Day with Audio?](https://www.edisonresearch.com/how-do-americans-spend-their-day-with-audio/)
- [Westwood One — Q3 2025 Edison Share of Ear](https://www.westwoodone.com/blog/2025/12/08/q3-2025-edison-share-of-ear-am-fm-radio-dominates-ad-supported-audio-while-podcast-audiences-age-as-older-audiences-surge/)
- [Edison Research — The Infinite Dial 2025](https://www.edisonresearch.com/the-infinite-dial-2025/)
- [Spotify Community — Removing Podcast Recommendations](https://community.spotify.com/t5/Live-Ideas/Removing-Podcast-Recommendations/idi-p/5823405)
- [The Conversation — Feedback loops and echo chambers](https://theconversation.com/feedback-loops-and-echo-chambers-how-algorithms-amplify-viewpoints-107935)
- [James Cridland — Why Overcast is more than a podcast player](https://james.cridland.net/blog/2024/why-overcast-is-more-than-a-podcast-player/)
- [Podcurator — How to Switch Podcast Apps Without Losing Everything](https://podcurator.io/blog/podcast-platform-migration-guide-2025)
- [iMore — How to troubleshoot the Podcasts app crashing](https://www.imore.com/how-work-around-current-podcast-app-crashing-bug)
- [Penn State — To explain or not? Need for AI transparency depends on user expectation](https://www.psu.edu/news/research/story/explain-or-not-need-ai-transparency-depends-user-expectation)
- [arXiv — Full Disclosure, Less Trust? How the Level of Detail about AI Use in News Writing Affects Readers' Trust](https://arxiv.org/html/2601.09620v1)
- [WebProNews — AI Slop Floods Social Media in 2025, Backlash Spurs 2026 Reforms](https://www.webpronews.com/ai-slop-floods-social-media-in-2025-backlash-spurs-2026-reforms/)
- [NBC Bay Area — Fed up with AI slop? A few platforms will let you dial it down](https://www.nbcbayarea.com/news/national-international/ai-slop-platforms-dial-it-down/4022838/)
- [NPR — Questions of accuracy arise as Washington Post uses AI to create personalized podcasts](https://www.npr.org/2025/12/13/nx-s1-5641047/washington-posts-ai-podcast)
- [App Console Lab — How Indie Developers Get 12 Testers for New Apps](https://appconsolelab.com/blog/how-indie-developers-get-12-testers-for-new-apps)
- [Frill — Understanding Feature Parity in Product Development](https://frill.co/blog/posts/understanding-feature-parity-in-product-development-examples-and-trap)

### Internal documents referenced
- `docs/brief/01_PROMPT.md` — product definition, four-archetype menu, why-line spec, external playback handoff constraint
- `docs/brief/04_VOICE_AUDIO_SPEC.md` — "audio correctness is the product" principle, TTS verbosity/auto-brief rules
- `docs/DECISIONS.md` — web-first pivot, pod.link handoff covering Android testers, serendipity floor / anti-echo-chamber design, state-observed-not-declared principle
