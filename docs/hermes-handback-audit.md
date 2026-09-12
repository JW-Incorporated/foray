# What Hermes was given, what landed, and what came back

**Status:** audit, 2026-09-12, by the founder's Claude session, at Wyatt's request
("review what we expected Hermes to finish; whatever Hermes hasn't finished yet,
please do yourself"). Every line is checked against `main`, not against a deck's
own claim about itself. Where a deck's status paragraph and the code disagree, the
code wins and this file says so.

This is a point-in-time audit. The decks themselves stay authoritative for their
cards; each card that lands from here on gets its **DONE** marker in its own deck,
in the idiom `docs/release-lockstep-plan.md` uses.

> ## ⚠ SUPERSEDED THE SAME DAY IT WAS WRITTEN — read the decks, not this file
>
> This audit landed as `5923501` (#653) on **2026-09-12** and **seven commits
> overtook it within hours of the same day**. Its "outstanding" column was
> accurate for about a morning. Corrected 2026-09-12 by the machinery-audit pass;
> the body below is left as written, because a point-in-time audit that is
> silently edited is worth less than one that says when it stopped being true.
>
> **What has landed since, and what §1's table therefore gets wrong:**
>
> | this file says | actually, as of 2026-09-12 evening |
> |---|---|
> | §1 / §3: `search-plan.md` — only S-01 landed, **S-02..S-08 outstanding** | **the whole deck landed**: S-02/S-03/S-04/S-05/S-07 in #657 (`27ea7ce`), S-05's degraded header + S-06 + S-08 in #658 (`590e952`) |
> | §3: "no `tools/build-show-index.mjs` and no `data/show-index.tsv` (S-03)" | both exist. `data/show-index.tsv` is **446,334 B, 10,113 rows**, pinned `-text` in `.gitattributes` |
> | §1 / §3: `bundled-voice-plan.md` — **none of seven** K-cards landed | **K-01 (probe only), K-02, K-03, K-06, K-07 landed** in #661 (`3998b31`). K-04 and K-05 remain, and K-01's measurement is still `HUMAN-ACTIONS.md` #45 |
> | §3: "there is no `fetch-models.mjs`, no phonemize stage" | `tools/mobile/fetch-models.mjs` and `tools/narration/phonemize.py` + `backend/src/generation/phonemize.ts` all exist. **But see the K-02 caveat**: the phonemize module has no production caller, so "the stage exists" is true of the code and not of the pipeline |
> | §3: "**G-42a** … is an unblocked Hermes card that has not started" | landed in #660 (`283e20d`): `tools/generation-bench/run.mjs` with 38 tests, runs 4–9 backfilled |
> | §1 / §2: `ios-controls-and-voice-plan.md` — **L-05, L-06, M-03** outstanding | all three landed in #654 (`759089b`) |
>
> **And one place it was wrong OPTIMISTICALLY, which no later commit fixed** —
> see the M-02 correction in §1 and §2 below.
>
> The general lesson, and the reason this banner exists rather than a quiet edit:
> a hand-written audit of eight decks is stale the moment the next PR merges, and
> nothing told anyone. `tools/ci/deck-claims.mjs` (added 2026-09-12) is the
> mechanical floor under the part of this that a machine can check.

---

## 1. The seven decks

| Deck | Cards | Landed | Outstanding | Now owned by |
|---|---|---|---|---|
| `ui-transition-plan.md` | U-01..U-13 | all | — | closed |
| `release-lockstep-plan.md` | R-01..R-08 | R-01..R-07 | R-08 (human) | Wyatt |
| `ios-controls-and-voice-plan.md` | L-, V-, D-, M- | L-01..L-04, M-01, V-01, D-01 — **M-02 is listed here in error, see below** | **L-05, L-06, M-03** (all three landed in #654 after this audit) | overlord |
| `search-plan.md` | S-01..S-08 | S-01 | **S-02..S-08** | overlord |
| `bundled-voice-plan.md` | K-01..K-07 | none | **K-01..K-07** | overlord |
| `foray-directory-plan.md` | FD-01..FD-07 | all | — | closed (overlord, not Hermes) |
| `curation/foray-to-spec-roadmap.md` | G- | G-17 and the overlord's cards | G-10..G-16 (corpus) | blocked on Joey + D2 |

### Detail, with the evidence

**UI (U-cards) — closed.** U-01..U-11 landed 2026-09-06; U-12/U-13 in the founder
session (PR #550); an adversarial audit on 2026-09-10 found four acceptance gaps
(U-03, U-06, U-09, U-12), closed by PR #603, and the U-11 records by PR #604. Each
card carries its DONE marker. Nothing came back.

**Release lockstep (R-cards) — closed but for one human gate.** R-01..R-07 verified
on `main` 2026-09-10, each naming its PR. **R-08** is `HUMAN-ACTIONS.md` #44: Play
mails the testers on a track, not the developer, and the internal track has no
testers. That is a Play Console action, not code. It also gates R-07's third
acceptance item (the Play email). Nobody but Wyatt can close it.

**iOS controls and voice (L-/V-/D-/M-cards) — three cards outstanding.** L-01/L-02/L-03
landed in PR #607, L-04 and M-01 with them;
**M-02 did NOT land** — corrected 2026-09-12. Its deliverable is
`tools/mobile/probe/probe-tap.js` (the card's own **Owned:** line) and that file
does not exist; `tools/mobile/probe/` holds `probe-bridge`, `probe-outpoint` and
`install-probe` only. The card is a UI-tap probe for the dead play/pause taps of
founder feedback F11/F13, so listing it as landed says a defect was reproduced
that never was. This is the one place this audit erred in the OPTIMISTIC
direction, which is the more expensive one: an overstated outstanding column
costs a re-read, an overstated landed column closes an open bug. V-01 shipped as the voice picker
(PR #575) and was then re-scoped to Samantha-only on founder feedback; D-01 deleted
the diagnostic Foray and gates releases on its absence. **L-05** (pause, stop and
resume for spoken narration — founder feedback F12), **L-06** (Now Playing fields
match Apple Podcasts, and the record shows what was sent — F15) and **M-03** (why
did it stop: native interruption and lifecycle events in the record, then the
screen-off reproduction) were added to the deck on 2026-09-06 and 2026-09-09 and
never started. No code on `main` carries them: the only interruption handling is
`player/html-audio-backend.js`'s web path, and the iOS plugin writes no interruption
events into the record.

**Search (S-cards) — one of eight.** **S-01 landed** (PR #576): `tools/search-probe.mjs`
plus the record, which is where the *before* numbers every other card is graded
against come from. **S-02..S-08 were not started.** Checked individually: no
`input` binding with the deck's 250 ms debounce on `#sh-input` (S-02); no
`tools/build-show-index.mjs` and no `data/show-index.tsv` (S-03), so S-04's ranking
has nothing to rank; the `SEARCH_CACHE_MAX` in `app.js` is `buildPlaylist`'s
pre-existing playlist cache, which S-05 names as the *idiom to follow*, not as the
card being done; no Apple fall-through or reload-safe breadth show page (S-06); the
privacy sentence still promises what the code does not do (S-07). The deck's human
gate **G1 was ruled Option B** on 2026-09-10 (`docs/DECISIONS.md`, PR via a554fb6):
search text may leave the device, Wyatt updates the store listing, and the policy
must be made to match the code. So S-07 no longer blocks anything.

**Bundled voice (K-cards) — none of seven.** Only the deck itself landed (PR #514).
`mobile/plugins/foray-tts` holds the *platform* TTS plugin from the earlier work, not
Kokoro; there is no model, no `fetch-models.mjs`, no phonemize stage. This is the deck
that answers the founder's 2026-09-11 note that the narration voices "were all so
bad" — Samantha is the least-worst platform voice, and the whole point of K is to
stop shipping platform voices. **K-01 needs a real phone** (it is a measurement card
by design: "measure Kokoro on real phones before anything is built on it"), and
**K-04** needs that measurement before the engine is built. The parts that need
neither — K-02 (phonemes authored with the script), K-03 (the audition kit),
K-06 (size, provenance and licence gates), K-07 (records) — do not.

**Corpus supply (G-10..G-16) — blocked, not dropped.** These are Hermes cards that
cannot start: they need Joey's exporter and the credentials decision **D2/G-16**,
which is a human gate on Wyatt and Joey. G-17 (communicate the cataloguing lessons)
is done — `docs/curation/cataloguing-lessons-for-corpus.md` and issue #578.
**G-42a** (benchmark harness on the generation host) is an unblocked Hermes card
that has not started.

---

## 2. What is being done about it, and by whom

Taken over by the overlord on 2026-09-12, one agent per lane:

1. **Search deck S-02..S-08** — including S-07 as Option B (make the privacy policy
   match the code; the store listing is Wyatt's, per the G1 ruling).
2. **iOS deck L-05, L-06, M-03** — code where CI can prove it, and a named device
   gate where only a drive test can.
3. **Bundled voice K-02, K-03, K-06, K-07** — queued behind the two above; K-01 and
   K-04/K-05 follow the phone measurement, which is a founder action once the probe
   ships in a build.
4. **G-42a** — queued.

Left with Wyatt: **R-08** (Play testers on the internal track), **G-16/D2** (corpus
credentials), the **K-01 phone measurement** once its probe is in a build, and the
**store listing** sentence the G1 ruling promised.

---

## 3. The lesson this audit records

Three decks were handed over with the same shape — measured state, cards with
Ask/Owned/Done-when, named human gates — and three came back differently: the UI
deck complete, the release deck complete but for a gate nobody could close, the
search and voice decks barely started. The decks that finished are the ones whose
cards could each be proved by a test on this repo. The cards that did not start are
disproportionately the ones that begin with a measurement on hardware nobody here
has (K-01), or that need a build step and an index file before any of the rest can
be graded (S-03). **A deck should lead with the card that unblocks the others, and
that card should be the cheapest thing in the deck, not the most expensive.** Both
outstanding decks fail that test; both were written with the measurement first
because measurement is the house rule, and the measurement is exactly what neither
Hermes nor an agent here can perform.
