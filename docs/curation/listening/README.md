# Listening cards: the founder's verdicts, as data

`cards.jsonl` in this directory is the committed store of **founder listening
cards** (roadmap card GV-08 for R2-01 in `docs/roadmap/generation-v2.md`; it
covers MQ-20 and QK-30). One line is one card: the founder's verdict on one act
of one blind version of a candidate Foray. It replaces Q-06's three yes/no
questions (`docs/curation/listening-quality-plan.md`) and keeps them as the
card's `q06` answers.

## Who may append, and what

**Only the founder's own card JSON is appended**: the JSON copied from a
listening pack's page after the founder listened, pasted as given. Nothing
else goes in this file. No agent, bot or script writes a card on its own
judgement, summarises a listen into one, or edits or deletes a line already
here. The store is **append-only**: a changed mind is a new card with a later
`listenedAt` (unseal reads the latest card per label for the pairwise result),
never an edit.

This file sits under `docs/`, which auto-merges, so the rule above is the guard.
Every card must name its `listener` and the sealed `packId` it came from, and
`tools/listening/card.test.mjs` fails CI on any line that is not a valid
`listen-card/1` card, including any card with a field the schema does not
define.

Append with the tool, which validates the card and the whole store first,
refuses a duplicate `cardId`, and never rewrites an existing line:

```
node tools/listening/card.mjs append <card.json>
node tools/listening/card.mjs check
```

## What a card holds (listen-card/1)

| Field | Meaning |
|---|---|
| `schema` | `"listen-card/1"` |
| `cardId` | unique id of this card (letters, digits, `.` `_` `-`) |
| `packId` | the sealed listening pack the listen came from |
| `label` | `A`, `B` (one of two blind versions) or `solo` — never a candidate id |
| `act` | which act was heard (integer, 1 for now) |
| `listener` | who listened |
| `listenedAt` | ISO 8601 date-time with a zone, e.g. `2026-10-11T19:04:00Z` |
| `scores` | `onSubject`, `flowsAtSeams`, `oneNarrator`, `nothingFalseOrOdd`, each an integer 1–5 |
| `overall` | integer 1–5 |
| `q06` | Q-06's three answers as booleans: `oneVoice`, `everyClipIntroduced`, `anyClipCutShort` |
| `winces` | `[{ atSec, note }]`: when something jarred and a short note (at most 280 characters) |
| `preference` | `A`, `B` or `tie`. Required on an A or B card; absent on a solo card |

**No transcript text, no narration script, no candidate id.** Wince notes are
reminders, not quotes. Fields outside this table are refused.

## How a card becomes a result

A card names a blind label. Which candidate, provider and stage swap that label
was is in the pack's **key**, written by the pack builder (GV-36) to
`data-local/listening/keys/<packId>.key.json` on the machine that built the
pack. Keys are never committed (`data-local/` is gitignored).

```
node tools/listening/unseal.mjs [--cards <store.jsonl>] [--keys <dir>]
```

prints one line per pack (`promptId`, the A and B arms, the preference, A's
scores minus B's per axis) and the pairwise preference rate per stage swap
(R2-21's go/no-go). Without a pack's key it refuses and names the missing key
file.

The generation bench (`tools/generation-bench/run.mjs --wide`) joins the
cards to report rows by candidate id and prints MQ-20 as two detail columns:
`listen` (mean overall) and `lastListen` (date of the latest card). Both are
`—` on a machine without the keys, and for any candidate nobody has listened
to. The definition is in `docs/curation/generation-kpis.md`.

Per-act **review** verdicts (R2-19, GV-41) use the same axes but live locally in
`data-local/review/verdicts.jsonl`, not here.
