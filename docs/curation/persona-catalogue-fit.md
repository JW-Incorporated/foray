# Default personas ↔ catalogue fit (preliminary)

A first pass at Decision #2 (`personalization-and-depth-plan.md` §3a, §9): *who are
Foray's default personas, and does the catalogue we've built actually serve them?*

**Scope note.** Persona definition is Joey's call (CEO/Product). This is a
starting point + a data check, not the final set — see the tracking issue for the
full market-research task delegated to Joey's lane. What this doc settles is the
**architecture question the founders asked**: does our catalogue/taxonomy match
the personas we'll probably want? Short answer: **the taxonomy architecture fits
well; the catalogue's content distribution is founder-skewed and needs
rebalancing once personas are chosen.**

## Method
Counted the 984-item discover pool by top-level taxonomy branch (an item can hit
several). This measures *content depth per interest area* — the thing a persona
needs filled to get good menus.

## Catalogue depth by branch (top of the list)
```
engineering 116 | history 115 | comedy 99 | science 70 | business 51 |
society 50 | health 50 | craft 47 | culture 45 | psychology 43 | medicine 41 |
nature 40 | true-crime 40 | music 38 | personal-journals 38 | relationships 27 |
kids-family 26 | economics 25 | food 23 | sports 23 | philosophy 18 | cities 18 |
… computing 9 | gaming 9 | tv-film 8 | fiction 8 | aviation 5 | math 2 | travel 1
```
(`news` exists in the taxonomy but has 0 items — timely content is deferred until
feed polling exists, per `DECISIONS.md` 2026-07-09.)

## Candidate personas (STARTING POINT — Joey to validate/replace)
Drawn from what a curiosity-first curator plausibly attracts, mapped to their
high-weight branches and current catalogue depth:

| Persona (candidate) | High-weight branches | Catalogue fit today |
|---|---|---|
| **Curious Engineer/Maker** | engineering, science, craft, space | **Strong** (116/70/47) — our deepest area |
| **History & Ideas** | history, society, philosophy, culture | **Strong** (115/50/45) |
| **Health & Performance** | health, medicine, psychology, food, sports | **Strong** (50/41/43) |
| **Business & Money** | business, economics, society | **Solid** (51/25) — could deepen |
| **True Crime & Story** | true-crime, personal-journals, paranormal, fiction | **Adequate** (40/38) — thin vs the genre's real size |
| **Comedy & Culture** | comedy, culture, music, tv-film | **Strong on comedy** (99/45); tv-film thin (8) |
| **Software/Tech & AI** | computing, science, business | **WEAK (computing = 9)** — see gap #1 |
| **Generalist** (default for new users) | broad, high-exploration | Fine — draws across all of the above |

## Findings
1. **Architecture matches — keep it.** The taxonomy has a top-level branch for
   essentially every plausible persona dimension (41 branches: tech, health,
   business, true-crime, comedy, kids, sports, …). Personas are just preset weight
   vectors over branches that already exist. No taxonomy redesign needed. This
   directly answers the founders' question: *yes, the catalogue architecture fits
   the personas we'll probably want.*
2. **Content is skewed to the founder's tastes.** engineering/science/history/
   craft/fusion are deep because the catalogue was seeded from Wyatt's interests
   (`data/taxonomy.json` weights: fusion 1.0, etc.). Great for the Engineer/
   History/Health personas; a liability for others.
3. **Gap #1 — software/computing/AI is thin (computing = 9).** A large share of
   "intellectually curious" podcast listeners are software/tech people; a
   Tech/AI persona is under-served today. The catalogue leans *physical*
   engineering over *software*. Likely the biggest content gap for mass appeal.
4. **Gap #2 — true-crime under-indexes the market.** True crime is among the
   single most-listened US podcast genres; 40/984 (~4%) is light if it's a
   first-class persona. Cheap to deepen (lots of quality supply).
5. **Gap #3 — news/timely is absent by design.** Fine for now, but a
   News-oriented persona can't be served until feed polling lands.

## Recommendation
- **Personas = data (`data/personas.json`), reviewed by Joey**, as preset weight
  vectors over the existing branches (plan §5). Ship 4–6; start new users on
  **Generalist**.
- **Turn "coverage" into a recurring check** (plan §5): for each persona, does the
  catalogue have enough *fresh, quality* items in its high-weight branches to fill
  a good menu? Gaps become a content-sourcing backlog — the nightly refresh and
  future gap-curation waves target the thin branches (computing/software,
  true-crime, and whatever else Joey's personas prioritize).
- **Sequence:** Joey validates the persona set + does the market research (tracked
  issue) → we encode `personas.json` → the coverage report flags gaps → content
  waves fill them. No engine change is blocked on this; per-user weights (plan
  Step A) can read persona vectors the moment they exist.
