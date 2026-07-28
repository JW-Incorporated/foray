# Default persona set v1 (issue #8)

Joey's product-research call, closing out `docs/curation/persona-catalogue-fit.md`'s
starting point. Ships as `data/personas.json` — 5 personas + Generalist.

## Market evidence

- **Comedy is the single biggest US podcast genre by reach: 43.6%**, ahead of News
  (23.7%) and Society & Culture (21.2%). (Edison Research, *The Infinite Dial 2026*)
- **True crime is a consistent top-3 genre on Apple's charts** and skews toward a
  female audience the rest of Foray's catalogue (founder-skewed toward
  engineering/history) does not reach today.
- Genre demographic skew, relevant to which personas diversify the audience:
  **Health 63% female**, **Arts 54% female**, **Sports 13% female (87% male)**,
  **Technology 26% female (74% male)**. (Edison Research, *The Infinite Dial 2026*)
- News leads on weekdays; comedy/entertainment spikes on weekends — a scheduling
  signal for later, not something personas encode.

Sources: [Infinite Dial 2026 — Radio Ink](https://radioink.com/2026/03/13/infinite-dial-2026-radios-biggest-audience-is-going-digital/), [Infinite Dial 2026 — National Public Media](https://www.nationalpublicmedia.com/insights/articles/audio-continues-to-break-listening-records-2026-infinite-dial-report/), [Apple Podcasts 2026 Top Charts — Coruzant](https://coruzant.com/news/apple-podcasts-the-2026-top-charts-best-shows-how-to-discover-hidden-gems/)

## The set

| Persona | Primary market signal | Catalogue fit at ship time |
|---|---|---|
| Curious Engineer/Maker | niche, but exactly who a curiosity-first curator attracts | Strong (engineering 116, science 70, craft 47) |
| History & Ideas | maps to Society & Culture's 21.2% reach | Strong (history 115, society 50, culture 45) |
| Health & Performance | strong genre reach, 63% female — diversifies the founder-skewed catalogue | Strong (health 50, medicine 41, psychology 43) |
| True Crime & Story | top-3 genre nationally, strong female skew — Joey flagged this as the persona to weight up | **Thin (true-crime 40)** — shipping anyway; see gap below |
| Comedy & Culture | #1 genre by reach (43.6%) | Strong on comedy (99); tv-film thin (8) |
| Generalist (default) | — | broad, unchanged from the existing mechanism |

**Cut:** Software/Tech & AI — catalogue has only 9 computing items, too thin to
serve a dedicated persona today. Revisit once a sourcing wave fills it.
**Deferred:** News — 0 items by design; can't be served until feed polling ships
(`docs/DECISIONS.md`, 2026-07-09).

## True Crime & Story: weighted up per Joey's steer

Primary weight is 1.0 (max), the only persona at that ceiling. Secondary branches
(`personal-journals` 0.6, `psychology` 0.5, `relationships` 0.4, `paranormal` 0.4,
`fiction` 0.3) lean into story-driven, psychologically-textured content adjacent to
true crime rather than narrowing to true-crime alone — this is deliberate breadth
within the persona, not a hedge on catalogue thinness.

**Shipping now, thin catalogue accepted.** Filed as a follow-up sourcing task:
grow `true-crime` beyond 40 items before this persona's sessions can sustain daily
variety at the depth the other four personas already have.

## Comedy & Culture: the open question

Comedy is the biggest genre nationally and Joey wants it — but Foray's positioning
(curiosity-first, anti-echo-chamber, explicitly not mass-market) doesn't
automatically win mainstream comedy listeners the way it wins engineering or
history listeners. The catalogue is already strong on raw comedy volume (99 items),
so the gap isn't supply — it's **which slice of comedy fits the product**:
interview-style, sharp/curious comedy (think: comedians talking ideas, not clip
shows) is a more natural fit than pure stand-up/clip-based comedy. This is a
sourcing-and-positioning question, not a weight-vector problem, and is open for
Joey to define further — filed as a follow-up.

## Follow-ups filed

- Content-sourcing wave: deepen `true-crime` (40 → target ~80-100 to match the
  other four personas' depth) before promoting this persona in onboarding.
- Product question (Joey): define what "comedy that fits Foray" means concretely
  (show examples, sub-branches to lean into) so sourcing and hook-writing can
  target it — see "the open question" above.
- Revisit Software/Tech & AI persona once `computing` has real depth (currently 9
  items); tracked as a cut, not a rejection.

## Mechanism note

No code changes — `PersonasFileSchema` and the seed-confidence resolver
(`backend/src/curation/userInterests.ts`) already existed (issue #8's
mechanism-plus-generalist-default groundwork). This is a data-only change:
`data/personas.json` now has 6 personas instead of 1. `seed_confidence: 0.35` for
all 5 new personas — deliberately low relative to real observed signal, same
reasoning as the existing `generalist` value (0.15), just slightly higher since a
directed pick is a stronger prior than "broad, no lane yet."
