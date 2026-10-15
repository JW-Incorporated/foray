# Persona rating profiles v1

Card RV-01 of `docs/roadmap/recommender-v1.md` (issue #1380). The data is
`data/recommender/persona-profiles.json`; the validator is
`tools/recommender/profiles.mjs` (`node tools/recommender/profiles.mjs` prints
each persona's word count and exits 1 on any problem); the tests are
`tools/recommender/profiles.test.mjs`.

These are the 13 listener profiles the persona-rating agents read before they
rate a show. Each agent rates every show once per persona (RV-08, RV-10), so a
profile is a rating instrument, not a marketing persona. Nothing on a live app
path reads the file. The runner prompt (RV-10) quotes the profiles verbatim, so
the orchestrator reads all 13 before wave 2 starts.

## What a profile is, and what it is not

The research behind the plan is specific about what moves a model's rating
(research notes §5.2, summarised in the plan's RV-01 card):

- **Operational statements, not biography.** Biographical detail does not add
  rating variance (Kambhatla et al. 2025), and demographic personas invite
  caricature (Cheng et al. 2023). So there are no ages, jobs, cities or genders
  here. Each profile is 250-400 words of testable preferences.
- **Every statement names something an evidence pack can show**: episode
  length, publish cadence, ad markers, host turn-taking, show-notes structure,
  transcript wording, explicit marking. "Likes good shows" is not a statement;
  "the transcript walks through a causal chain step by step" is.
- **Examples calibrate.** Each persona names 3 shows it loves and 3 it quits,
  all from `data/catalog.json`, with one line each on why. This is few-shot
  calibration and does more than any description.
- **Explicit non-preferences** (`does_not_care_about`) stop the rater filling a
  gap with its own taste.
- **No persona is a genre.** Each carries 7-8 `taxonomy_affinity` weights over
  root nodes of `data/taxonomy.json`, positive and negative, and its statements
  are about how a show is made and listened to, which cuts across topics.

## The axes

Every persona sits on three axes (research §5.1):

| axis | values | what it captures |
|---|---|---|
| `why` | `learn`, `keep-up`, `entertained`, `absorbed`, `accompanied` | why they press play |
| `how` | `lean-in`, `lean-back` | attentive and intolerant of filler, or listening alongside something else and intolerant of dense argument |
| `form.length` | `short`, `medium`, `long`, `any` | the episode length they lean to |
| `form.ad_tolerance` | `low`, `medium`, `high` | how much ad load they sit through |
| `form.polish` | `matters`, `indifferent` | whether production quality changes their rating |
| `form.explicit` | `dealbreaker`, `tolerated` | explicit language |

`form` is the research's third axis ("form tolerances"). The card's file shape
listed only `why` and `how` under `axes`; `form` was added because it is what
tells apart two personas that share `why` and `how`, and the validator refuses
two personas that agree on all six values.

| id | why | how | length | ads | polish | explicit | seed_persona_id |
|---|---|---|---|---|---|---|---|
| mechanism-hunter | learn | lean-in | long | low | indifferent | tolerated | curious-engineer-maker |
| commute-explainer | learn | lean-back | medium | medium | matters | tolerated | generalist |
| maker-tinkerer | learn | lean-back | long | medium | indifferent | tolerated | curious-engineer-maker |
| practical-improver | learn | lean-in | medium | low | indifferent | tolerated | health-and-performance |
| history-deep-diver | absorbed | lean-in | long | medium | indifferent | tolerated | history-and-ideas |
| news-current | keep-up | lean-in | short | low | indifferent | tolerated | generalist |
| slow-news-contextualist | keep-up | lean-back | medium | medium | indifferent | tolerated | history-and-ideas |
| banter-regular | entertained | lean-back | long | high | indifferent | tolerated | comedy-and-culture |
| sharp-comedy | entertained | lean-in | medium | medium | matters | tolerated | comedy-and-culture |
| narrative-binger | absorbed | lean-in | medium | low | matters | tolerated | true-crime-and-story |
| true-crime-careful | absorbed | lean-back | medium | medium | matters | tolerated | true-crime-and-story |
| comfort-companion | accompanied | lean-back | long | high | indifferent | tolerated | generalist |
| family-listener | accompanied | lean-back | short | medium | matters | dealbreaker | generalist |

The card listed `history-deep-diver` as "learn/absorbed". It is recorded as
`absorbed`: its statements are about immersion in a period across many hours,
and placing it under `learn` would have made a three-way collision with
`mechanism-hunter` and `practical-improver`.

### `seed_persona_id` and `taxonomy_affinity` (D11)

Rating personas are new ids, not the six onboarding personas of
`data/personas.json` (decision D11). `seed_persona_id` names the onboarding
persona each one grew from, so a listener who picked an onboarding persona
starts with a sensible mixture. `taxonomy_affinity` (weights in -1..1 over root
nodes only) lets the client module (RV-16) infer a persona mixture from the
listener's interest weights without storing a persona id and without a new
`cp_` key. `data/personas.json` and `backend/src/types/personas.ts` are not
edited.

## Pairs that share why and how

Four pairs share both `why` and `how`. Each pair differs on at least one form
value (checked by the validator) and on a `does_not_care_about` entry, which is
what the rater should use to keep them apart:

| pair | form difference | the `does_not_care_about` that separates them |
|---|---|---|
| mechanism-hunter / practical-improver | length long vs medium | the hunter does not care about host personality or polish but needs the mechanism; the improver "does not care about storytelling" yet needs an applicable step, and does not care whether hosts are famous |
| commute-explainer / maker-tinkerer | length medium vs long; polish matters vs indifferent | the commuter does not care whether the subject is their specialty or about depth past the first explanation; the maker does not care about tight editing and tolerates loose, wandering talk |
| history-deep-diver / narrative-binger | length long vs medium; ads medium vs low; polish indifferent vs matters | the diver does not care about sound design or episode length; the binger does not care about subject matter or whether it teaches anything |
| comfort-companion / family-listener | length long vs short; ads high vs medium; polish; explicit tolerated vs dealbreaker | the companion does not care about novelty, depth, ad load or polish; the family listener does not care about depth for adults or recency |

## Dealbreakers are shared

The research warns against a persona whose dealbreakers no other persona
shares: it rates everything low and carries no information. Every
`stops_listening_when` entry falls under a theme that at least one other
persona also holds, as a dealbreaker, a `rates_down` statement or a quit:

| dealbreaker theme | personas |
|---|---|
| long stretches with no substance of the kind they came for | mechanism-hunter (no mechanism), maker-tinkerer (no tool), practical-improver (no step), sharp-comedy (no joke) |
| padding or housekeeping before the content | commute-explainer, news-current, sharp-comedy |
| voices talking over each other | commute-explainer, slow-news-contextualist |
| shouting, sneering, hosts turning on each other | slow-news-contextualist, comfort-companion |
| graphic violence, or jokes about real deaths | true-crime-careful, comfort-companion, family-listener |
| claims presented as settled without sources or explanation | mechanism-hunter, history-deep-diver, true-crime-careful |
| today's headlines standing in for background | history-deep-diver, slow-news-contextualist |
| nothing new since the last episode | news-current (reruns), narrative-binger (no reveal in three episodes) |
| hosts reacting to a story instead of telling it | narrative-binger, true-crime-careful (quits conversational retelling), history-deep-diver (quits chat around cases) |
| a company or funding story in place of the work | maker-tinkerer, mechanism-hunter (quits founder stories and funding chatter) |
| sales pitches inside the advice | practical-improver, maker-tinkerer |
| a lecture or formal interview, or hosts with no rapport, where a hang was expected | banter-regular, sharp-comedy (quits sincere interviews), comfort-companion (wants warm hosts) |
| explicit language or frightening content with children present | family-listener, true-crime-careful and comfort-companion (graphic detail) |

## Why each persona exists

**mechanism-hunter.** The listener who wants to understand how things work,
and the core of the catalogue's engineering and science shelf. It separates
dense technical interviews from friendly overviews of the same topic, which no
genre label can do: `omega-tau` and `stuff-you-should-know` both cover
materials and machines.

**commute-explainer.** The same wish to learn, under the opposite constraint:
attention split with the road, 20-40 minutes, no rewinding. It rewards one
clear voice and one finished idea, and it should rate down exactly the dense
shows the mechanism-hunter rates up.

**maker-tinkerer.** Learning through craft. It tolerates the loose, wandering
shop talk the mechanism-hunter quits, as long as tools, materials and settings
keep coming up. It is what makes the woodworking, machining, brewing and
lutherie shows rateable on their own terms.

**practical-improver.** Learning in order to change something this week:
training, sleep, eating, money. Its distinct signal is evidence quality and
actionability, and its distinct dealbreaker is a sponsor pitch woven into the
advice, which matters in the health shelf.

**history-deep-diver.** Long-form narrative history, the strongest single
listening habit in the curated catalogue. It values length, primary sources
and context, and it quits the bite-sized and the chatty versions of the same
period.

**news-current.** The one persona for which cadence and recency decide the
rating. It is how daily specialist news (launch-industry, materials, startups)
gets a rater who wants it, and how evergreen shows get a rater who does not.

**slow-news-contextualist.** Keeping up without the churn: weekly analysis of
running stories, calm delivery, background first. It splits analysis shows from
reaction shows on the same subject, which is a tone judgement a rater can make
from a transcript.

**banter-regular.** Chat shows and host rapport. It tolerates ads, length and
spiky roasting, and does not need to learn anything. It is the persona that
rates the catalogue's large comedy-chat shelf up, so the others are free to
rate it down.

**sharp-comedy.** Comedy judged by laughs per minute and by craft: structured
formats, characters, workshopped jokes. It disagrees with banter-regular on
meandering chat, which is the disagreement that makes both columns useful.

**narrative-binger.** Produced, serialised storytelling: tape, scenes, music,
cliffhangers. Production polish decides its rating, and it rates down the
conversational retelling of stories it would otherwise love.

**true-crime-careful.** Real cases told with care for the people involved,
with sources. It exists because true crime splits sharply on tone, and a show's
treatment of victims is visible in its transcript and notes.

**comfort-companion.** Familiar, kind voices in the background for hours.
Novelty and depth do not matter; warmth, a long back catalogue and standalone
episodes do. It rates the abrasive comedy shows down and the gentle
long-running ones up.

**family-listener.** Listening with children in the car. Explicit language is
the one hard dealbreaker in the set, and it is the only persona with a strong
positive weight on `kids-family`. Without it the children's shows have no rater
who wants them.

## The pruning rule

Thirteen personas is a starting point, not a finding. After the gold set
(RV-19), a persona is kept only if:

- its `fit` column has pairwise correlation **< 0.85** with every other
  persona's column, and
- it is the top-rated persona for **at least 3%** of shows (v1.0 only; v1.1
  replaced this test, see "v1.1 pruning" below).

A pair at or above 0.85 is merged (the one with the higher top-persona share
is kept; the other gets `pruned: true, merged_into: "<id>"`), and a persona
under 3% is pruned. RV-29 applies this as v1.1, bumps the file's `version` to 2
and records the table here under "v1.1 pruning". The research expects 8-10 of
13 to survive. Twelve personas that collapse into four clusters are four
personas with extra cost.

## v1.1 pruning (RV-29, 2026-10-15): all 13 kept

These are the gold-set numbers (RV-19, 2,978 shows; [`docs/research/persona-ratings-gold-2026-10.md`](../research/persona-ratings-gold-2026-10.md)), read against the rule above:

| persona | top-persona share | top share, chart top-25 shows | shows at fit >= 4 | highest correlation with another persona | rule says |
|---|---|---|---|---|---|
| banter-regular | 23.9% | | 459 | 0.62 (sharp-comedy) | keep |
| comfort-companion | 24.1% | | 476 | 0.41 (family-listener) | keep |
| commute-explainer | 11.9% | | 259 | < 0.41 | keep |
| news-current | 7.8% | | 108 | < 0.41 | keep |
| practical-improver | 6.8% | | 111 | < 0.41 | keep |
| narrative-binger | 5.9% | | 151 | 0.52 (true-crime-careful) | keep |
| mechanism-hunter | 4.7% | | 120 | 0.48 (slow-news-contextualist) | keep |
| maker-tinkerer | 4.1% | 2.4% | 151 | 0.48 (mechanism-hunter) | keep |
| slow-news-contextualist | 3.6% | 2.7% | 114 | 0.48 (mechanism-hunter) | keep |
| history-deep-diver | 2.9% | 4.7% | 57 | < 0.41 | **prune** |
| family-listener | 2.8% | 2.7% | 77 | 0.41 (comfort-companion) | **prune** |
| sharp-comedy | 0.9% | 1.1% | 44 | 0.62 (banter-regular) | **prune** |
| true-crime-careful | 0.6% | 0.9% | 30 | 0.52 (narrative-binger) | **prune** |

The chart top-25 column is filled in only where the decision needs it. "< 0.41" means the persona is in none of the five most correlated pairs, the highest of which is 0.41.

**No pair reaches 0.85**: the highest is 0.62, so nothing merges. The 3% share rule would prune four personas and keep 9, inside the research's expected 8-10. **v1.1 does not apply the share rule. It keeps all 13, and `persona-profiles.json` stays at `version` 1, unchanged**, so every existing rating stays valid against `profiles_sha256`. The reasons:

1. **Top-persona share measures argmax wins, not whether a persona is useful.** Two broad personas, comfort-companion and banter-regular, are the top persona for 48% of all shows, because they like a little of everything. A narrow persona loses the argmax on almost every show it likes, because the broad persona is close behind. This holds even where its genre is popular: on the 449 chart top-25 shows, true-crime-careful is the top persona for 0.9% and sharp-comedy for 1.1%. The share rule was meant as a proxy for redundancy, and the correlation column already measures redundancy directly. No persona is redundant.
2. **Every pruned candidate has real supply.** Each one rates 30-77 gold shows at fit 4 or more, which is roughly 260-680 across the 26k catalogue at the same rate. That is enough to fill a served list. Their top-50s lead with their intended roots: kids-family is 50% of family-listener's, true-crime 62% of true-crime-careful's, history 42% of history-deep-diver's and comedy 44% of sharp-comedy's (eval §4).
3. **Pruning removes a listener, not a cost.** The client projection is 12.6 KB of a 40 KB budget with all 13 personas, so pruning saves nothing that binds. Pruning true-crime-careful would serve a listener who wants victim-centred true crime through narrative-binger, a persona that is 0.52 correlated with it and does not share its dealbreakers. Family-listener carries the explicit-content sensitivity that no other persona has.

**The replacement rule, for v1.2 and later:**
- Merge any pair at r >= 0.85, unchanged.
- Prune a persona only when its fit >= 4 supply falls under 0.5% of the gold set (15 shows).
- Revisit both once RV-27 sends real listener feedback: the per-listener persona mixture weights will show which personas listeners actually load on, and that is the measure the share rule was standing in for.

The research's expectation of 8-10 survivors was a prior, and this table is the evidence.

The related map finding goes to the eval, not to the profiles. In `tools/recommender/eval.mjs`, commute-explainer should join the `deep-learn` archetype set: it is the top persona for 32 of 128 deep-learn shows, and adding it lifts overall archetype precision from 0.439 to 0.595 ([`persona-ratings-eval-2026-10.md`](../research/persona-ratings-eval-2026-10.md)). That change, and the eval floors that follow it, is its own card.

## Changing a profile

Edit `data/recommender/persona-profiles.json` and run
`node tools/recommender/profiles.mjs`. The validator checks: 250-400 words over
the prose fields (`context`, every list entry, every example's `why`,
`return_question`); `rates_up` 6-10, `rates_down` 4-6, `stops_listening_when`
2-4, `does_not_care_about` 2-4; exactly 3 `loves` and 3 `quits`, each a
`show_id` in `data/catalog.json`, none in both lists; 4-10 `taxonomy_affinity`
entries on root nodes with weights in -1..1; `seed_persona_id` one of the six
in `data/personas.json` or null; unique kebab-case ids; no two personas with the
same three `loves`; no two personas equal on `why`, `how` and every `form`
value. Ratings already made against a profile are not re-made automatically:
a changed profile after the pilot means a new rubric pass for that persona's
column.
