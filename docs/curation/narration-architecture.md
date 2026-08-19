# Narration architecture — three levels, and the gate on each of them

The structural half of the narrator charter (#247). `narration-craft.md` answers
*how a line is written*. This document answers *who writes which lines, what
each level is responsible for checking, and how a claim is proved before it is
spoken.*

It exists because of a measurement. `alcohol-forms-coverage.md` scored the
sixty-three-beat alcohol spine at **1 strong / 15 thin / 47 empty**, with Act I —
the sixteen chained beats that are the education the founder asked for — at
**0 strong, 3 thin, 13 empty**. Its own words: *"On this catalogue Act I is not
holed, it is absent."* Podcast tape cannot carry that request. So narration
becomes the **spine** rather than the glue, and tape gets inserted where it
happens to fit. That inversion is a fact about coverage, and
`narration-craft.md` §1a is right that it is not a licence: *"tape that does not
fit its beat sounds wrong and prose that does not fit its beat sounds fine."*

**Status:** proposed, with one thread built and gated. Nothing here has been
voiced. Every second-figure is a character count divided by 17
(`player/foray-queue.js`'s `NARRATION_CHARS_PER_SEC`), and the character count
is the figure to trust.

**One vertical slice, deliberately.** `T2-sugar-unlock` — alcohol Act I beats
6–9, the fork between free sugar and locked starch — is carried from dot to
thread to beats to scripts to sourced spans to a generated reference surface.
The other fourteen threads are named and empty. A spine nobody can audit is
worth less than one thread that has been.

---

## 0. TL;DR

| | |
|---|---|
| Levels | **3.** Dots (arc) → threads → beats. Agents are narrow at every level; each level reviews the one below |
| Where it lives | `docs/curation/narration/<foray_id>/{arc,threads/,beats/,reviews/,references/}` — all on `ALLOWED_PREFIXES` |
| The gate | `tools/foray/check-narration.mjs`, exit 0 clean / 1 violation, warnings never fail |
| Thread criteria | **start and end criteria are machine-checkable or they are not criteria**, and every criterion carries a `polarity` — the negative ones do the real work (§4) |
| Review contract | the parent checks **repetition, contradiction, and un-established assumptions across siblings** — the three defects a narrow agent structurally cannot see (§5) |
| Source rule | **two tiers. Tertiary sources including Wikipedia are acceptable at both.** Tier 2 — quantitative, superlative, dated, named-entity, contested — requires every **number** in the claim to appear inside a fetched span (§6) |
| Anti-hallucination | **fetch and store a quoted span at a pinned revision.** A claim's **numbers** are diffed against its own spans by machine — names are not, and §6a says why. A tier 2 claim may never rest on inference (§7) |
| References | **never spoken.** They live in a generated markdown surface bound sentence → claim → span (§8) |
| The slice | 4 beats, 4,437 characters, **261.0 s of narration against 0 s of tape** (§9) |
| Is alcohol fundable as tape-led? | **No.** At the 25 % target it is 179 s over before one empty beat is carried; the full spine is **72.9 % narrator** (§10) |

---

## 1. What this document does not decide

- **The words.** Person, tense, register, sentence rules, the six modes, the six
  rejection tests. `narration-craft.md` owns all of it and this document defers
  to it everywhere except where §12 records an edit to it.
- **Voice.** The parallel research document's.
- **Generation, caching, cost in currency, TTS.** `tools/narrate/` and the
  cost work. Note one live discrepancy for whoever reconciles them:
  `tools/narrate/billable.mjs` uses `CHARS_PER_MIN_MEASURED = 880` (≈14.7
  chars/s) while `player/foray-queue.js` uses 17 chars/s. The two disagree by
  about 16 % and this document uses the player's number, because the player's
  number is what the listener's clock actually runs on.
- **Whether to ship the alcohol Foray.** §10 does the arithmetic and states the
  consequence. The decision is the founders'.

---

## 2. The three levels

The founder's design, and the reason for it is worth keeping in front of the
implementer: **each agent's focus is narrow, and the agent one level up is
responsible for double-checking the level below and for making the narrative
flow and connect.** Narrowness is what makes a beat specific enough to pass
R2's substitution test. Review from above is what stops narrowness from
producing four beats that do not know about each other.

| level | artifact | what one instance is | file |
|---|---|---|---|
| **1** | the **arc** | a dot: one sentence that could be true or false, at act scale | `arc.json` |
| **2** | a **thread** | a run of contiguous beats with start and end criteria | `threads/<thread_id>.json` |
| **3** | a **beat** | one spine beat's script, sentence by sentence, claim by claim | `beats/beat-NN.json` |

Two artifacts hang off the side:

| | | |
|---|---|---|
| **review** | the executed review contract for one parent over its children | `reviews/<id>.review.json` |
| **references** | the accompanying-text surface, generated | `references/<thread_id>.md` |

### 2a. Where it lives, and why not in `data/`

`docs/curation/narration/` — not `data/forays.json`. Three reasons.

1. A script exists as a **curation artifact** long before it is a playable item.
   `data/forays.json` items are the assembly's; `docs/curation/` is where the
   editorial record lives, alongside the spines and coverage reports these
   artifacts are scored against. There is precedent in the directory already:
   `grilling-foray-passages.json`, `foray2-asr-manifest.json`.
2. **The evidence must not ship to the client.** `tools/mobile/prepare-webdir.mjs`
   copies the 2.1 MB of `data/` the client fetches. The reference surface for
   sixty-three beats is large, is never spoken, and is not the player's business.
3. `docs/` is on `ALLOWED_PREFIXES` and not on `DENIED_PREFIXES`, so a
   content-only narration PR remains auto-mergeable — which is exactly why the
   reviewer pass has to happen **before push**, per `CLAUDE.md` workflow rule 7.

The hand-off to `data/forays.json` is one field mapping, and it is deliberately
lossy in one direction only:

```
item.type          = "narration"
item.id            = "<thread_id>-<item_id>"       e.g. T2-sugar-unlock-T2-A
item.script        = the item's beats' sentences, joined
item.slot          = the Foray slot the thread sits in
item.duration_sec  = absent until audio exists; the player then estimates at 17 chars/s
                     and stamps duration_source: "estimated"
```

**`claims`, `sources`, `establishes`, `assumes` and every quoted span stay
behind.** The player never sees them; `check-narration.mjs` is the only thing
that reads them, and it runs before the item is built.

### 2b. The beat file, in full

There is deliberately **no `script` field**. A stored copy of the assembled text
would be one edit away from disagreeing with the sentences it came from, and the
sentences are what carry the per-sentence licence and the evidence binding. The
script is derived (`beatScript()`), never stored.

```jsonc
{
  "schema": "narration-beat/1",
  "beat_id": "beat-07",
  "level": 3,
  "foray_id": "alcohol-forms-1",
  "thread_id": "T2-sugar-unlock",
  "spine_beat": 7,                       // integer index into the spine doc, as data/forays.json uses
  "spine_heading": "…",                  // copied, so a spine edit shows up as a diff
  "coverage_verdict": "empty",           // strong | thin | empty, from the coverage report
  "mode": "carry",                        // one of narration-craft §0's six
  "provenance": "carry-by-default",      // §2d: carry-by-default | carry-by-design
  "share_pct": 2.0,                       // the spine's own share
  "heard_audio": null,                    // §3i, required wherever the beat bridges tape
  "rejection_reason": null,               // §6c: never deleted

  "establishes": ["mash-temperature-is-a-dial", …],   // what a LATER beat may assume
  "assumes":     ["conversion-step-required-for-starch", …],  // what an EARLIER beat must have given
  "numeric_facts": ["C7.5:alpha-amylase 63-70 C", …], // one entry per figure the listener must retain

  "sentences": [
    { "text": "Steep the barley.", "licence": "claim", "claims": ["C7.1"] }
  ],

  "claims": [
    { "claim_id": "C7.5", "text": "…", "tier": "2", "tier_reason": "quantitative",
      "support": "quoted",
      "sources": [ { "source_id": "wp-mashing", "kind": "tertiary",
                     "publication": "Wikipedia", "work": "Mashing",
                     "url": "https://…", "pinned_url": "https://…&oldid=1366554333",
                     "revision": "1366554333", "retrieved": "2026-08-19",
                     "quote": "Because of the closeness in temperatures of peak activity of an α-amylase (63-70 °C) and β-amylase (55-65 °C), …" } ] }
  ]
}
```

`establishes` and `assumes` are the load-bearing pair and they are the reason
the parent contract in §5 can be mechanical rather than a vibe. They are a
**declared knowledge graph over the Foray**: a beat says what it hands forward
and what it needs handed to it, in the same file, in the same edit. Everything
§5 checks about repetition and assumed knowledge is a query over those two
arrays.

---

## 3. Level 1 — the arc

Six dots for the alcohol Foray, one per act. A dot is **never spoken**. Its job
is to be the thing every thread beneath it has to serve, and the thing the
level-1 reviewer scores threads against.

```jsonc
{ "dot_id": "D1",
  "dot": "Every alcoholic drink is the same molecule in water, so the whole subject is production rather than substance.",
  "act": 1, "beats": [1, 16],
  "threads": ["T1-molecule-and-ceiling", "T2-sugar-unlock", "T3-what-the-producer-controls", "T4-the-key"],
  "built": ["T2-sugar-unlock"] }
```

A dot has to be a sentence that could be false, for the same reason the spine's
beats are: *"Fermentation" is not a claim.* `check-narration.mjs` enforces that
a dot is a non-empty sentence; it cannot enforce that it is falsifiable, and
that is the level-1 author's job and the founders'.

**What level 1 owns that nothing else can.** Act structure, the order of
threads, and every decision that requires seeing two acts at once — the biggest
of which is §5's fourth check, whether a thread has spent a later act's payoff
early. `T2-sugar-unlock`'s closing line is *"The first question is now closed"*
and deliberately not *"the first of four questions"*, because the four-questions
frame is beat 16's to hand over. Only level 1 can see that.

---

## 4. Level 2 — threads, and the criteria that make the design falsifiable

**This is where the founder's design lives or dies, and the reason is simple:
vague criteria make levels 1 and 3 both unfalsifiable.** If a thread ends "when
the topic feels covered", level 3 cannot tell whether its beat is required and
level 1 cannot tell whether the thread delivered. The thread stops being a
contract and becomes a label on a group of beats.

So:

> **A criterion states something a listener can be asked, and names the check
> that would settle it. A criterion without a `check` field is a wish, and
> `check-narration.mjs` rejects it.**

### 4a. The two polarities, and why the negative ones matter more

Every start criterion carries `polarity: "requires" | "forbids"`.

**`requires`** is the obvious kind: something must already hold when the thread
opens, and it names the beat that established it.

```jsonc
{ "id": "S2", "polarity": "requires",
  "holds": "The listener knows a fermentation stalls between 14 and 16 per cent ABV.",
  "established_by": "beat-05", "key": "fermentation-ceiling-14-to-16",
  "check": "beat-05.establishes contains 'fermentation-ceiling-14-to-16'. Load-bearing: beat-08's claim that sake exceeds a simple mash's reach is unintelligible without it." }
```

**`forbids`** is the kind nobody writes and everybody needs:

```jsonc
{ "id": "S3", "polarity": "forbids",
  "holds": "The listener has NOT yet been told what starch is, what an enzyme does, or that any conversion step exists.",
  "key": "conversion-step-required-for-starch",
  "check": "No beat with spine_beat < 6 lists 'starch-is-a-glucose-polymer' or 'conversion-step-required-for-starch' in establishes." }
```

A negative start criterion is what **licenses** a beat to spend eleven seconds
defining starch — and what would be violated, silently, if an upstream beat
quietly explained starch first, leaving beat 6 repeating it in the house voice at
the house length with nothing to hear as wrong. The `establishes` / `assumes`
graph makes the violation a machine-detectable diff rather than something a
reader has to notice.

A `forbids` criterion **never satisfies an assumption**. That distinction is
enforced: `check-narration.mjs` collects only `requires` keys when it resolves a
beat's `assumes`, because the alternative — a thread declaring what must not be
established and having that count as establishing it — is a bug with a very
quiet failure mode.

### 4b. End criteria: "the listener can", never "the thread covers"

Four positive and one negative, for `T2-sugar-unlock`. The full text is in
`threads/T2-sugar-unlock.json`; the shape is the point:

| id | the listener can | how it is checked |
|---|---|---|
| **E1** | given grape, honey, cane, palm sap, milk, barley, rice, maize or agave, say whether it needs a conversion step | each of the nine terms occurs in the thread's assembled script on a stated side of the fork |
| **E2** | name the conversion routes and say what supplies the amylase in each | the number spoken at C6.12 equals `thread.routes.length`, checked by machine |
| **E3** | say why the mould route reaches a strength the malt route cannot | `beat-08.establishes` carries both halves, and the causal link's `support` kind is visible — it is `inference`, and a reviewer reading this criterion is told so |
| **E4** | predict one consequence of a mash temperature | the direction (hotter → sweeter) appears verbatim in a quoted span |
| **E5** | **not** name any drink as a category yet | no family-defining verb; beyond that it is level 1's call, because only level 1 can see Act III |

**E2 is the one worth studying**, because it is the pattern that generalises. The
script says *"there are four ways to do it."* Four is a fact about the artifact
set, not about the world, so it is recorded as `support: "self"` with
`self_check: "thread.routes.length"`, and the checker compares the spoken number
against the array. If a fifth route is ever sourced, the array grows, the check
fails, and the script cannot ship until the number changes. **A number that is
verified against the artifacts is stronger than a cited one**, and this is the
same mechanism `narration-craft.md` §6a already allows for a synthesis Carry,
applied to a count.

**E4 is the one that earns its keep editorially.** It catches the script that
names two temperature bands and never says what they buy — which is what a beat
written to a source rather than to a claim produces.

### 4c. What level 2 owns that level 3 cannot

**The merge.** `narration-craft.md` §2e requires adjacent empty beats in one
chain to be authored as **one** Carry item. Four beats at §4d's ~80 s planning
figure is ~320 s, past the 180 s hard max, so the merge splits — and *choosing
where* requires seeing all four beats at once.

`T2-sugar-unlock` splits at the beat 7/8 boundary, because that is where the
claim changes owner: 6–7 are the fork and the answer that uses the plant's own
enzymes; 8–9 are the answers that come from outside the plant. Splitting at 6/7
instead would put the fork alone in a 71 s item and three answers in a 178 s
item — inside the hard max by two seconds, and audibly one long list.

That decision is recorded in the thread file's `merge_rationale`, not inferred,
because the next author needs to know it was a choice.

---

## 5. The level N+1 review contract

The founder's design says agents one level up double-check the level below and
ensure the narrative flows and connects. Flow is the part everyone remembers.
The part that has to be **specified rather than assumed** is the other part:

> **A narrow-focus agent cannot tell that its beat duplicates a sibling's,
> contradicts a sibling's, or rests on something no sibling established. Those
> three are the parent's job and they are the parent's whole reason for
> existing.**

So the contract is exactly six checks, in this order. Four are mechanical and
`check-narration.mjs` runs them. Two are judgement and the review file records
them.

### C1 — repetition across siblings *(mechanical)*

One establisher per key. If two beats in a thread both list a key in
`establishes`, that is a hard error.

On the slice this caught a real one and predicted a worse one. The predicted
case: **a level-3 agent writing beat 8 in isolation would have had to define
what an amylase is** in order to say the mould secretes them — the single
highest-probability duplication in the thread, and beat 6 already spent eleven
seconds on it. The `establishes`/`assumes` split is what prevents it: beat 8
lists `conversion-step-required-for-starch` under `assumes`, and the checker
confirms beat 6 is where it came from. The caught case: beat 8's draft opened
with three sentences restating beat 7's malting mechanism as a contrast. Cut to
one clause. **The contrast is the parent's job to make once, not the child's job
to make again.**

### C2 — contradiction across siblings *(judgement, recorded)*

Two findings on four beats, and neither was visible from inside one beat.

**A source contradicting the spine.** The spine's beat 6 sentence lists apples
among the feedstocks offering free sugar. The fetched span at Wikipedia:Wine
(oldid 1369157660) says: *"Most fruits other than grapes lack sufficient
fermentable sugars, are overly acidic, and do not have enough nutrients for
yeast, necessitating winemaker intervention."* The spine's own beat 22 agrees —
cider is *"the same operation on a fruit that resists it."* So a beat-6 script
naming apples alongside grapes licenses an inference beat 22 exists to retract.
Apples were removed from beat 6 and recorded in the thread's `out_of_scope` with
the reason. **Seeing this requires holding a span and a downstream beat at the
same time**, which is precisely one level up from where either lives.

**A forward liability.** Milk is on the free-sugar side and belongs there —
lactose is a sugar, not a starch. But *S. cerevisiae* fails to grow on lactose,
and the spine's beat 25 exists because the milk alcohols needed a different
yeast. Left in, with an eight-word hedge rather than dropped, because the
classification is right and only the downstream consequence is unusual.

### C3 — assumed knowledge with no establisher *(mechanical)*

Every key a beat `assumes` must be established by a beat with a lower
`spine_beat`, **or** declared in the thread's start criteria as an open
dependency with a `requires` criterion. Anything else is an error.

On the slice this converted two silent assumptions into two recorded open
dependencies. `beat-08` assumes `fermentation-ceiling-14-to-16`, and beat 5 is
not written — the coverage report calls it *"the most expensive empty beat in the
report."* Beat 8's line *"above where a single mash can get"* is unintelligible
without it. **If beat 5 is later dropped or shortened, beat 8 must be
re-reviewed, and the level-3 agent for beat 8 has no way to know that.** The
dependency is now in a file.

### C4 — the sourcing audit *(mechanical, §§6–7)*

Tier floors, numbers-in-spans, inference limits, blocked claims not spoken,
reference leakage. §7 is the whole of it.

### C5 — flow and connection *(judgement, recorded)*

Opening, internal seams, item seam, closing. The one thing to say about it that
is not obvious: on an empty-beat spine the item-to-item seam is a
**narration-to-narration** seam, and §2e's rule that the second item be shorter
than the first is the only textural signal available — same voice, same room,
same loudness, nothing for the listener to attribute the boundary to. The slice
lands at 143.7 s then 108.9 s, and the shorter second item is doing real work.

### C6 — the escalation *(required output)*

**A parent that finds something it cannot fix must escalate rather than absorb
it.** The review file carries `escalated_to_level_1`, and on four beats it
carries three entries — two of them blocking. §9 and §10 are what those became.

Recorded as a limit of the contract: **C1 and C3 are only as good as the
`establishes` / `assumes` arrays.** A level-3 agent that under-declares what it
establishes evades C1. That is a real hole and the honest mitigation is not a
cleverer regex — it is that the parent reads the child's script against its
declared keys, which is judgement, and the review file is where the parent says
it did.

---

## 6. The source rule — two tiers, and Wikipedia is fine at both

Two rulings from the founder govern this section and they overturn a position
this project previously held.

1. **Wikipedia is an acceptable source.** The earlier position — that factually
   obvious things cannot be cited, and that tertiary sources are a smell — was
   rejected and the rejection was right. Nothing below excludes a tertiary
   source, and thirty-five of the thirty-six spans behind the vertical slice are
   tertiary.
2. **The real risk is hallucination, not insufficiently prestigious sourcing.**
   An agent inventing a plausible fact is a different failure from an agent
   citing a merely-decent source, and a rule aimed at the second does nothing
   about the first.

So the tiers are not a prestige ladder. They are a **verification** ladder, and
what rises with the tier is how mechanically the claim must be pinned. Thirty-five
of the thirty-six spans behind the vertical slice are tertiary, and the slice
passes the gate.

| | tier 1 | tier 2 |
|---|---|---|
| **what** | mechanism, definition, uncontested process fact | **quantitative, superlative, dated, about a named person / company / brand, or contested** |
| **source kinds** | any, tertiary included | any, tertiary included |
| **spans** | one fetched span containing the claim | one fetched span in which **every number in the claim appears verbatim**, checked by machine; names, dates and contest are declared and reviewed rather than inferred (§6a) |
| **may rest on inference** | yes, from ≥ 2 claims, with written reasoning | **never** |
| **escalation** | — | contested, or a factual claim about a **named living person or company**: add a second **independent** source, or frame it as U3 with the axis of disagreement named |

**Why tier 2 is where the damage is.** Numbers, superlatives, dates and named
people are the four places a fluent model invents most confidently and where
being wrong is least recoverable. They are also, exactly, where *"a touch of
history"* goes wrong: the founder's own instruction in the spine is that several
of this subject's best-loved origin stories are *"undocumented, disputed, or
demonstrably marketing"* — the monk who invented sparkling wine, the ship that
invented madeira, absinthe's madness, the etymology of "proof". Every one of
those is a tier 2 claim about a named person, place or date, and every one has a
plausible false version a model will produce on request.

**The escalation is a sub-case, not a third tier.** The founder asked for two
tiers and two is what this is. The reason the sub-case exists is that
corroboration guards against *the source being wrong*, which is a real risk but
not the one named in ruling 2 — so it is required only where a wrong source does
harm rather than merely error.

### 6a. The tier floor is inferred, not trusted

An agent that declares its own tier will declare the tier that lets it ship. So:

> **`check-narration.mjs` infers the minimum tier from the claim's own text — a
> digit anywhere, or a superlative form — and rejects a declared tier below it.**

A claim may always declare higher. It can never declare lower. This is the check
that stops "tier 1" from becoming the answer to every question, and it fired
during the slice: beat 9's blocked claim about industrial enzymes was declared
tier 1 and contains *"much of the world's cheap spirit"*. The floor caught it and
it is now tier 2 with a reason — **while still blocked**, so that unblocking it
later cannot quietly land a tier 1 assertion.

Recorded as an honest limitation: the floor does **not** infer the named-person
case. A proper-noun regex on a subject full of Latin binomials, place names and
appellations produces false positives at a rate that would make the gate
ignored, and a gate people route around is worse than no gate. Named-entity
tiering is declared, and C2/C5 are where a reviewer catches an under-declaration.

---

## 7. Fetch and verify, not cite from memory

This is the anti-hallucination mechanism and the whole point of it is that it is
mechanical.

> **An agent must fetch the source and store a verbatim span that contains the
> claim, pinned to a revision, so a checker can diff the claim against the span
> without re-researching anything.**

A citation an agent produced from memory is precisely the failure ruling 2 names.
It is also invisible to review: a plausible URL and a plausible paraphrase look
exactly like a real one. A stored span does not — it is either in the fetched
text or it is not.

### 7a. What a span record carries, and why each field is there

```jsonc
{ "source_id": "wp-mashing",
  "kind": "tertiary",                    // primary | secondary | tertiary
  "publication": "Wikipedia", "work": "Mashing",
  "url":        "https://en.wikipedia.org/wiki/Mashing",
  "pinned_url": "https://en.wikipedia.org/w/index.php?title=Mashing&oldid=1366554333",
  "revision":   "1366554333",
  "retrieved":  "2026-08-19",
  "quote":      "Because of the closeness in temperatures of peak activity of an α-amylase (63-70 °C) and β-amylase (55-65 °C), …" }
```

**`pinned_url` and `revision` are the fields that make a tertiary source
auditable.** A Wikipedia article is a moving target; `oldid` is not. Ruling 1
says Wikipedia is acceptable, and pinning the revision is what makes that
cheap-to-verify rather than a hostage to a future edit. For a DOI the `revision`
is the DOI; for a page with no version identifier, the retrieval date plus a
content hash, and a claim resting on an unpinnable source is a reason to prefer a
different source rather than to skip the field.

**The `quote` must be one contiguous verbatim span**, minimum forty characters.
Several spans per claim are allowed and normal; joining non-contiguous
fragments with an ellipsis is not, because an ellipsis is where cherry-picking
hides. `check-narration.mjs` warns above three spans from one source on one
claim — a claim needing that many is doing too much and should be two claims.

### 7b. The check that actually catches an invented figure

> **Every number token in a claim's text must appear as a substring in at least
> one of that claim's own fetched spans.**

Nine lines of code, and it is the single highest-value rule in this document.
Beat 8's claim carries *18–20 % ABV* and *14–16 %*; the check finds `18`, `20`,
`14` and `16` inside two spans from the Sake article. Change any digit and the
check fails, with no judgement involved and no re-research.

Two details from building it that matter more than they look:

- **The source used a plain hyphen for the mash temperatures (`63-70 °C`) and an
  en-dash for the sake ABV (`18–20% ABV`).** Nobody would reproduce that from
  memory, and it is why the comparison is on number tokens rather than on the
  whole string. It is also a small demonstration of the point: the exact
  characters of a real source are not what a model recalls.
- **A tier 2 claim may never rest on inference.** This is the strictest rule in
  the file and it is deliberate: reasoning your way to a number is
  indistinguishable, in the artifact, from inventing one. `support: "inference"`
  requires at least two claims it is drawn from and written reasoning, and the
  checker rejects it outright at tier 2.

### 7c. The four supports, and why "blocked" is the useful one

| `support` | means | requires |
|---|---|---|
| `quoted` | a fetched span contains it | ≥1 span; all numbers present |
| `inference` | reasoned from other claims; no span says it | ≥2 `inferred_from`, written `reasoning`, tier 1 only |
| `self` | a fact about the Foray's own artifacts | `self_check` + `spoken_number`, verified by machine |
| `blocked` | the spine asks for it; no span was found | `spoken: false`, a `block_reason`, and **no sentence may cite it** |

**`blocked` is the field that makes "well-supported" mean something.** The
alternative to a block is the drift this whole pipeline exists to stop:
"well-supported" silently becoming "I recall this being true". A blocked claim
stays in the record, with the reason and the lead that would close it, exactly as
`narration-craft.md` §6c requires of a rejected script — *label, never exclude.*

Two claims are blocked in the slice and both were asked for by name in the spine.
§9 says what they cost.

---

## 8. Where references live

Ruling 3, verbatim: *"It would be so terrible if the references were read aloud,
they should all just be in some accompanying text."*

### 8a. The distinction that makes this implementable

There are two different things a script can say about where a claim came from,
and the existing rule set already treats them separately.

| | | ruling |
|---|---|---|
| **Attribution of tape** — *"Adrian Miller, a historian of Black foodways, on The Grill Coach"* | who the next voice is | **stays spoken.** `segment-length-rules.md` X2 requires it and X1 requires narration at every cross-episode seam. Removing it would make the Foray dishonest about who is talking |
| **A reference** — a publication, an article title, a URL, a retrieval, a page number | where a *narrated* claim's evidence lives | **never spoken.** Accompanying text only |

Everything below is about the second. `check-narration.mjs` enforces it
lexically: a spoken sentence matching a URL, `wikipedia`, `oldid`, `et al`,
`according to`, `doi`, a bare domain or a page citation is a hard error.
Speaker-and-show attribution is deliberately not matched.

### 8b. What replaces on-air citation, since something must

`narration-craft.md` §5f's argument for spoken attribution was not citation
hygiene, and it does not go away when the citation does:

> "The narrator has no on-air authority of its own. Every other voice in a Foray
> arrives with a show, a guest credit and a reason to be believed. A Carry item
> arrives with none of that."

That is still true. What ruling 3 removes is one answer to it. The replacement is
to keep calibration in the script while moving the apparatus out, using **the
class of evidence** rather than the citation:

> **U5 — evidence-class attribution.** *"Genomic work reads it as an Aspergillus
> flavus that mutated and stopped making aflatoxins."*

That names what kind of evidence the claim rests on, which is what a listener can
actually use, and it is checkable — against the accompanying text, where the
paper and the article both sit. It is **not** a banned hedge: "many historians
believe" has the shape of an attribution with the subject deleted, whereas
"genomic work reads it as" names a method a reader can go and audit. The line
between the two is thin enough to be worth writing down, and §12 writes it down
in `narration-craft.md` §5e beside U1–U4.

### 8c. The surface

`references/<thread_id>.md`, **generated**:

```
node tools/foray/check-narration.mjs --references T2-sugar-unlock > \
  docs/curation/narration/alcohol-forms-1/references/T2-sugar-unlock.md
```

Never hand-maintained. A reference list that can drift from the script it
documents is worse than none, because it reads as an audit and is not one.

The binding is three hops and every hop is a field, so no prose has to be
trusted:

```
sentence.claims[] ──▶ claim.claim_id ──▶ claim.sources[].quote  (+ pinned_url, revision, retrieved)
```

The rendered page shows, per beat: the spoken script; then every spoken sentence
against the claim ids it rests on; then every claim with its tier, its support
kind, and its verbatim spans. Claims that are sourced but **not spoken** —
blocked, or cut by a craft rule — render with their reason, so the surface
records what the beat could have said and did not.

**What is not decided here.** How this reaches a listener who wants it. There is
no `context` field anywhere in `data/`, `player/foray-queue.js` or
`player/foray-resolve.js` — the nearest editorial-prose fields are a segment's
`why` and an item's `long_reason`. A per-item references surface in the player is
a real piece of work and it belongs to the client spec, not here. The generated
markdown is the committed artifact and the audit trail; the UI is a follow-up
with a named owner.

---

## 9. What the vertical slice cost

Four beats. Here is the whole bill, because the point of building one thread
rather than sixty-three was to find out what one costs.

### 9a. Measured

| | chars | sec |
|---|---|---|
| beat 6 — the fork | 1,237 | 72.8 |
| beat 7 — malting | 1,238 | 72.8 |
| beat 8 — koji | 1,030 | 60.6 |
| beat 9 — saliva and heat | 930 | 54.7 |
| **item T2-A** (beats 6+7, merged) | **2,476** | **145.6** |
| **item T2-B** (beats 8+9, merged) | **1,961** | **115.4** |
| **thread total** | **4,437** | **261.0 (4.35 min)** |
| **tape** | — | **0** |

Both items are above the 45–110 s Carry target band and inside the 150 s soft
max — the same shape §7c describes for alcohol beat 16 at 144 s — and T2-B is
shorter than T2-A, which §2e requires.

**On §5d compliance, stated precisely, because an earlier draft of this table
claimed more than it had checked.** Four of §5d's eight rows are enforced by
`check-narration.mjs` and pass: **mean sentence length** (12.00–12.57 words, and
beat 7 sits exactly on the 12.0 floor, so one word shorter turns CI red),
**maximum sentence** (longest 21 against 25), the **rhythm rule** (every beat
carries a sentence under six words), and **number form** (no digit reaches a
script). A fifth, the **≤3 numeric facts per item** cap, is enforced and binding
(§9c). Three rows are **not** mechanically checked, and two of them needed a
human eye to fix:

- **"One number per sentence."** Four sentences carry a two-ended range —
  *"between sixty-three and seventy degrees Celsius"*, *"eighteen to twenty per
  cent"*. **This document reads a range as one numeric expression**, on the rule's
  own stated ground that "a spoken number cannot be re-read" — a range is one
  quantity, re-read as a unit. That reading is a judgement and it is in §13 for a
  founder line, because the alternative reading fails the beat outright.
- **Active voice.** Beat 9's first draft inherited its spans' passive
  construction — *"maize is ground, moistened… rolled and dried"*. Rewritten
  active. **The spans are passive; the script does not have to be**, and this is a
  concrete instance of §11's pitfall 4.
- **No long participial opener.** Beat 8 opened *"Instead of germinating the
  grain, …"*. Moved to the sentence ending, which is Everett's actual advice.

Not implemented and not claimed: §2e's **anti-uniformity** rule (no three
consecutive narration items within ±20 %). It cannot fire on a two-item thread
and is listed here so it is not mistaken for covered.

**The thread's narration-to-tape ratio is 252.6 : 0.** There is no ratio. All
four beats come back empty in the coverage report — beat 7's single candidate is
rejected there as wrong on the mechanism — so this thread's local narration share
is 100 % by construction, and no whole-Foray ratio rule can be satisfied or
violated by it. That is not an artifact of choosing an unlucky thread: it is
thirteen of Act I's sixteen beats.

### 9b. Sourcing: thirty-six spans, seven works fetched for nothing, two claims blocked

| | |
|---|---|
| distinct works fetched | **24** — 23 Wikipedia articles plus one Crossref bibliographic query |
| works that supplied a span that is used | **17** |
| works fetched that produced nothing usable | **7** (Agave syrup, Fructan, α-Amylase, Yeast, Nixtamalization, Glucoamylase, Cider) |
| span records, quoted verbatim and pinned to a revision | **36** (35 distinct quotes; one passage serves two claims) |
| tertiary (Wikipedia, pinned by `oldid`) | 35 |
| primary (a DOI'd paper, as tier 2 corroboration) | 1 |
| claims total | **32** — 25 `quoted`, 4 `inference`, 1 `self`, 2 `blocked` |
| claims **blocked** for want of a span | **2** |
| claims narrowed because the span said less than the spine did | **1** |
| facts dropped for want of a span | **2** |
| sourced facts cut by a craft rule rather than by sourcing | **1** |

**Read the second and third rows together, because that ratio is the cost nobody
budgets for.** Seven of twenty-four works were fetched, read and discarded, and
the discarding is not waste — it is what "no clear source means not included"
costs when it is actually enforced rather than asserted. A pipeline that cites
from memory has none of that cost and none of the guarantee.

**The narrowing is the most important line in that table**, because it is the
mechanism doing the exact job it was built for. The spine's beat 7 claims that a
sprouting seed *"manufactures alpha-amylase and mobilises the beta-amylase
already stored in the resting grain."* The fetched spans support two weaker
facts: β-amylase is present in an inactive form prior to germination, and the
enzymes produced during germination are what break the starch down. **Neither
span assigns the manufacture to alpha-amylase specifically.** The claim is
plausible, is probably true, and is the kind of thing a model states without
hesitation. It is not spoken. The script says *"Germination wakes that one and
produces the enzymes that will break the grain's starch down"* and does not
divide the labour by enzyme.

**The two blocks, both asked for by name in the spine:**

- Japanese single-organism koji versus Chinese and Korean mixed starters (beat 8).
  Four fetches, no span. Not spoken.
- Bought exogenous enzymes and acid hydrolysis (beat 9) — the spine's third
  route. Six fetches, no span. Not spoken, **and the consequence propagates**:
  beat 6 says "four ways" rather than five, and beat 9's spine heading says
  "three more ways" where the shipped beat delivers two. The spine's own line
  licenses that — *"Any one of the three advances the beat; two is strong"* — but
  the mismatch between the heading and the beat is recorded rather than left for
  a reader to trip over.

**So the shipped thread is narrower than the spine intended, and that is the
honest cost of the mechanism.** The alternative is a thread that is exactly as
wide as the spine and asserts three things nobody fetched.

### 9c. Four rule collisions the slice found, which nothing found before it

These are the reason to build one thread all the way down rather than plan
sixty-three.

**1. §5d's numbers cap is binding, and it costs sourced facts.** *"One number per
sentence, at most three per narration item."* Written for a transition. Item T2-A
holds exactly three — the four routes, and the two temperature bands — so
alpha-amylase denaturing above 78 °C is **sourced, pinned, relevant and cut.** It
stays in the record with `spoken: false` and its reason.

The cap is satisfiable here only because two of the four beats are
non-quantitative. It is **not** satisfiable on the neighbouring pair: beats 4 and
5 are both empty and adjacent, so §2e merges them, and between them they carry
three dates (Pasteur's 1860s–70s, Hansen 1883) and two ABV figures (the 14–16 %
ceiling, sake's 18–20 %). Five numeric facts in one merged item against a cap of
three. **There is no arrangement that satisfies it**, and Act I is quantitative by
design — the spine's own words are that stating fermentation as an equation
*"rather than as a mood is what lets every later beat be quantitative."*

> **Recommendation.** Restate the cap in the form its own reason implies. The
> reason given is *"a spoken number cannot be re-read"*, which is about spacing,
> not about counting: **no more than one numeric fact per sentence, and no more
> than one per twenty seconds of narration item, minimum three.** A 143.7 s item
> then carries seven, spaced. Founder-facing, because it is a change to a written
> rule and not a reading of one.

**2. §2e's consecutive cap leaves Act I with no assembly that §4c does not
forbid, and no thread can fix it.** Beats 4 through 11 are **eight consecutive
empty beats** in the coverage report, between beat 3's Guinness-widget cut and
beat 12's gin cut. §2e merges adjacent empties into one item, caps an item at
180 s, and caps consecutive narration items at two. **Two items × 180 s = 360 s
is the hard ceiling on any run of adjacent empty beats.**

Now the arithmetic, stated at three per-beat lengths rather than one, because the
first draft of this paragraph said "no legal assembly" and a founder could
falsify that in one line:

| per carried beat | eight beats | verdict |
|---|---|---|
| §4d's 80 s planning figure | 640 s | **illegal.** 1.8× the ceiling |
| the slice's measured mean, 65.3 s | 522 s | **illegal.** 1.5× the ceiling |
| the 45 s Carry **floor** | 360 s | **legal, and exactly at the ceiling** |

So there *is* one arrangement that fits, and it is the arrangement §4c exists to
forbid: writing every Carry at the floor. `grilling-beat-cut-plan.md` already
caught someone reaching for it — "It is arithmetically real and it is exactly the
move §4c exists to forbid." **The honest statement is therefore not "Act I has no
legal assembly" but "Act I has no assembly that is not the move §4c forbids"**,
and §2e's own remedy — *"drop fan stops, or ship shorter"* — is unavailable
regardless, because Act I is a chain and the spine forbids both dropping and
reordering its links.

This is the same shape `grilling-history-coverage.md` found in Act III
(*"Beats 10, 11, 12 and 13 are four consecutive empty beats, and that breaks R6
before any ratio is computed"*) — twice as long, and in the one act that cannot
be cut.

**3. The spine's share budget cannot be met by narration at all.** Beats 4–11 are
13.5 % of runtime = **1,215 s** at the 150-minute reference. The §2e ceiling
above delivers **360 s**. That is a **3.4× shortfall**, and it is structural
rather than a budgeting error: the maximum a merged run can deliver is fixed by
the hard max and the consecutive cap, and neither is negotiable without changing
a rule.

The slice shows it in miniature. Beats 6–9 are budgeted 6.9 % = 621 s. Delivered:
**261.0 s, or 42.0 % of the argument's own budget.** A share is a statement about
how much the argument needs, decided before anyone knew what was available — and
narration cannot supply it. The consequence for a listener is that Act I's
derivation is delivered at two-fifths of the depth it was designed for, which is
a different failure from a missing beat and one no coverage vocabulary currently
names.

**4. `check-forays.mjs` would pass all of this without reading a word.** Its
narration gates are id, duplicate id, positive duration, a 50-character script
floor, the 150 s WARN and the 180 s FAIL, slot membership and an https asset.
Both slice items clear every one. That is not a criticism of it — it is a
player-facing gate and it is correct — but it is why `check-narration.mjs` exists
and why it runs upstream, on the curation artifact, before an item is built.

---

## 10. Is the alcohol Foray fundable as a tape-led product?

**No. Not at the target, not at the ceiling, and not by transcription.**

The arithmetic, from `alcohol-forms-coverage.md`'s own figures and
`narration-craft.md` §4's own formula. The tape base is set B — *"everything
admitted, thin tier included"* — **1,672.1 s (27.9 min)**, which that report
calls *"a ceiling, not a plan"* because it assumes the founder admits the Stuff
You Should Know register, and that has not been ruled on.

Covered-beat narration cost, at §4d's per-beat constants — 240 characters for a
strong beat, 780 for a thin one, 1,360 for a carried one, with beat 27 counted as
a Carry because it is thin-by-dependency and has no tape of its own:

```
1 × 240  +  14 × 780  +  1 × 1,360  =  12,520 characters  =  736.5 s
```

Then `narration_allowed = tape × ceiling / (1 − ceiling)`:

| | narration allowed | headroom over covered beats | empty beats carryable |
|---|---|---|---|
| **target 25 %** | 557.4 s | **−179.1 s** | **none. It is over the target before one empty beat is carried** |
| **ceiling 35 %** | 900.4 s | 163.9 s | **2 of 47** |
| R-essay 40 % | 1,114.7 s | 378.3 s | 4 of 47 |
| **all 47 carried** | 4,496.5 s | — | **72.9 % narrator, 102.8 min** |

**Three findings, and the second is the one that decides it.**

1. **The 25 % target is unreachable with zero carried beats.** The sixteen beats
   that have tape cost more narration in seams, Markers, Corrections and Patches
   than the target permits in total. The barbecue Foray missed its ceiling *"by
   exactly one carried chain link"*; alcohol misses its target before it starts.

2. **The 35 % ceiling funds two carried beats, and Act I needs thirteen.**
   §4c's allocation rule spends the Carry budget chain-first, so both go to Act I
   — and Act I is thirteen empty chain beats that *"cannot be reordered and
   cannot be entered late."* To carry Act I alone at the ceiling needs
   **3,299 s = 55.0 min of tape**; at the target, **88.8 min.** The catalogue's
   absolute ceiling is 27.9 min, and 6.05 min of that is inside Act I.

3. **Ruling the SYSK register out ends the discussion.** Eleven of the fifteen
   thin verdicts return to empty: 1 strong / 4 thin / 58 empty. The four survivors
   are beats 14 (two segments, 165.4 s), 26 (99.8 s), 30 (141.3 s) and 36 (96.7 s
   trimmed), so the tape base falls to **503.2 s, 8.4 minutes.** Their own
   narration cost is 231.8 s.

   | | narration allowed | headroom | carryable |
   |---|---|---|---|
   | target 25 % | 167.7 s | **−64.0 s** | **none, and over the target before it starts** |
   | ceiling 35 % | 271.0 s | +39.2 s | **0.49 of a beat, i.e. none** |

   **So a SYSK-out ruling funds zero carried beats of fifty-eight, and breaches
   the 25 % target with none carried.** An earlier draft of this paragraph put the
   tape at 403 s and concluded the Foray was over the *ceiling* too; that was
   wrong — the number came from a cue timestamp, not a duration — and the ceiling
   row clears by 39 seconds, which is half a Carry. The conclusion the founders
   need is unchanged and does not depend on the error: **there is no version of
   this catalogue, under either register ruling, in which Act I is fundable.**

**A sanity check, and not the cross-check an earlier draft claimed.** 72.9 % is
narration seconds as a fraction of delivered seconds, from per-beat character
constants over 1,672.1 s of tape. The coverage report's **72.2 %** is the
share-weighted fraction of *intended* runtime sitting on empty beats — it has no
tape term and no covered-beat-narration term in it at all. **The two measure
different quantities and their closeness is a coincidence** (uniform shares would
put the second at 74.6 %). What the pair licenses is a statement about magnitude:
by two unrelated routes, roughly three-quarters of this Foray is narration. It
does not license "the number is real", and this paragraph used to say so.

### 10a. So what is it?

**It is a narration-led product with clips, and saying so is the decision the
founders own.** At 72.9 % narrator this is not a Foray under
`narration-craft.md`'s own definitions — it is 33 points past R-essay, the line
that document draws at *"an essay with clips… a good form, competently served by
others, and not this one."*

Three options, stated so they can be chosen between rather than blended:

- **A. Ship a tape-led alcohol Foray anyway.** ~18 beats of 63, 42.9 minutes,
  ≤35 % narrator, **and no Act I.** The education the founder asked for is the
  first thing the ratio cuts, because Act I is where the tape is not. This is
  legal under every rule in the corpus and it does not answer the request.
- **B. Declare a second product mode.** Narration-led, ~70 % narrator, tape as
  evidence rather than as substance, and a name that is not "Foray". This
  answers the request. It needs a ruling on R-essay for this subject, an
  editorial gate on prose that is stronger than the tape gate rather than
  weaker — which is what §§5–7 are for — and honesty in the product surface
  about which mode a listener is getting.
- **C. Do not ship alcohol yet.** The coverage report is explicit that this is
  not fixable by transcription: *"§10's whole queue, if every hypothesis in it
  landed, would move six beats. Act I would still be eleven or twelve beats empty
  out of sixteen, and Act I is the education."* Closing it means new sourcing
  outside the current catalogue.

**The recommendation, offered as one and not as a decision.** B, with the gate in
this document as the price of admission, and a founder ruling on R-essay recorded
in `docs/DECISIONS.md` before a single Foray is generated in that mode. A is the
option that looks safest and is not: it ships the product principle *"curiosity
and learning first"* with the learning removed. Papering over the gap with
ratios — writing every Carry at the 45 s floor to squeeze under a ceiling — is
the move `narration-craft.md` §4c exists to forbid, and the barbecue cut plan
already caught someone reaching for it.

---

## 11. Pitfalls — confirmed, refuted, extended

Five were put to this work in advance. All five survive, three of them harder
than they were put.

**1. "A narrow-focus agent cannot tell that its beat duplicates a sibling's, and
the parent-checks-child contract is the only defence." Confirmed, and it is now
mechanical rather than asserted.** §5's C1 is a one-establisher-per-key check
over the declared graph, and on four beats it caught one real duplication and
structurally prevented the highest-probability one. **Extension:** the contract
is only as good as the declarations. A child that under-declares what it
establishes evades C1, and the honest mitigation is not a better regex — it is
that the parent reads the child's script against its declared keys, records that
it did, and is accountable for the reading.

**2. "'Well-supported' will silently drift into 'I recall this being true' unless
the pipeline forces a fetched, quoted span." Confirmed, and the drift is
measurable.** On four beats, three claims the spine asks for could not be
sourced: two blocked, one narrowed. **Every one of the three is plausible, and I
would have written all three from memory without noticing.** The alpha-amylase
one in particular is textbook-shaped and probably true. That is the whole case
for the mechanism: it caught things that were not obviously wrong, which is the
only kind of thing it needs to catch.

**3. "Level 2's start/end criteria are where this design lives or dies."
Confirmed, and sharpened.** The criteria that did the most work were the
**negative** ones — S3 forbidding upstream beats from explaining starch, E5
forbidding any drink from being named as a family. A positive criterion tells a
child what to deliver. A negative criterion is the only thing that tells it what
belongs to somebody else, and scope creep into a sibling's territory is the
commonest failure of a narrow agent. Any thread whose criteria are all positive
should be treated as under-specified.

**4. "Scripts written to a source read like the source." Confirmed as the
sharpest editorial risk in the pipeline, and only partly mitigated.** Beat 7's
draft followed the Malting article's own order — steeping, germination, kilning,
then mashing — because that is the order the span is in. It reads as an
encyclopedia entry with the headings removed. What fixed it was writing to the
beat's *claim* instead: the beat's claim is that mash temperature is a **dial**,
so the script front-loads the enzymes as a *harvest* and ends on the prediction,
which is not the article's shape at all.

There is no mechanical check for this and it would be dishonest to claim one.
`narration-craft.md` R2 catches prose that fits **any** beat; this is prose that
fits **this** beat and is organised by somebody else. **Two proxies worth
building, both signals rather than verdicts:** flag a beat whose sentence order
matches its longest span's clause order, and flag a beat where one `source_id`
supplies most of its spans. **Neither is implemented, and the second needs its
threshold chosen from data rather than from a guess:** span concentration in this
slice runs 20 % (beat 6), 50 % (beat 7 — five of ten spans from the Malting
article), 50 % (beat 8) and 50 % (beat 9), so a 70 % bar would fire on nothing
here while a 50 % one would fire on three of four beats. An earlier draft asserted
beat 7 tripped a 70 % bar on "five of nine spans"; beat 7 has ten. Recorded as a
request with the numbers attached, so whoever builds it need not re-measure.

**5. "A 63-beat spine at ≤25 % narration needs a great deal of tape that #278
says does not exist. Do the arithmetic and say whether it is fundable at all."
Done, in §10. It is not.** The extension is that the failure is worse than a
ratio failure: **§9c's collisions 2 and 3 leave Act I with no assembly §4c
permits, and with a share budget narration cannot meet, regardless of the
ratio.** Even given unlimited tape, eight consecutive empty beats fit inside
§2e's caps only if every Carry is written at the 45 s floor — the one move §4c
forbids — and the merge ceiling then delivers about 42 % of the depth the
argument was budgeted. The ratio is not the binding constraint. The structure is.

**One pitfall not on the list, and it is the one that would have bitten hardest.**
The design's per-level narrowness makes each agent cheap and each agent's output
locally excellent — and **locally excellent is exactly what a padded Carry
is.** `narration-craft.md` §6e: bad narration arrives in the house voice, at the
house level, in the right place, at the right length, on topic and grammatical.
A three-level agent hierarchy will produce that at scale and at speed, and the
only thing standing between it and the product is that the parent's checks are
about **relations between beats** rather than about the quality of any beat.
Every check in §5 that could be satisfied by reading one beat in isolation is a
check that is not earning its cost.

---

## 12. What this changes in `narration-craft.md`

Ruling 3 contradicts R3 as written. R3 currently requires the source be
**recorded in the script**, with on-air naming required in Patch and Carry. That
is the half that goes. The purpose stays: **a claim whose evidence nobody can
check is not asserted.**

Four edits, and they are made together because leaving any one of them would
leave the document contradicting itself in a place a script author reads:

| § | what changes |
|---|---|
| **§6a R3** | the evidence test becomes *sourced and auditable, in accompanying text, never in the spoken script*; unfilled slots and unsourced assertions stay generation-blocking |
| **§5f** | *"Every Patch and every Carry names, out loud, at least one source"* → every Patch and Carry is **sourced in accompanying text**, and the "no on-air authority" argument is answered by U5 rather than by citation |
| **§5e** | **U5 — evidence-class attribution** added beside U1–U4, with the line that separates it from a banned hedge |
| **§0, §8c** | the TL;DR bullet and the invention table updated to match, so the document does not assert the old rule in three other places |

**What does not change.** X1 and X2 in `segment-length-rules.md` — a
cross-episode seam always carries narration, and it names the speaker and the
show. Those are attribution of tape, not references, and §8a explains why the
distinction is the thing that makes ruling 3 implementable rather than
destructive.

---

## 13. What needs a founder line

Five, and the first is not small. All are recorded rather than decided here, and
all five are filed in `HUMAN-ACTIONS.md`.

1. **The product-mode question in §10a.** A, B or C for alcohol. This is the big
   one and everything else is downstream of it.
2. **§9c's numbers cap.** Restate §5d's cap as a density rule, or accept that
   Act I ships without its figures. Beats 4 and 5 cannot satisfy the current rule
   under any arrangement.
3. **§2e's consecutive cap against a chain.** Eight consecutive empty beats have
   no legal assembly, and §2e's remedy assumes droppable beats. Either the cap
   bends for a chain in a narration-led Foray, or Act I does not ship as written.
4. **Whether a two-ended range is one number or two** (§9a). §5d allows one
   number per sentence; four sentences in the slice carry a range. This document
   reads a range as one numeric expression on the rule's own stated reasoning. If
   that reading is rejected, the mash-temperature dial and sake's ABV cannot both
   be spoken, and beat 7's core claim goes with them.
5. **U5.** Whether evidence-class attribution is an acceptable substitute for
   on-air naming, given ruling 3 removes the alternative. The line between "genomic
   work reads it as" and "many historians believe" is thin, it is now written
   down, and it is worth a founder's eye because the whole honesty of a Carry
   rests on it.

---

## 14. Sources

**Internal, load-bearing throughout:** `docs/curation/narration-craft.md`
(§§0, 1a, 2a–2e, 3h, 4a–4d, 5a, 5d–5f, 6a–6e, 7c),
`docs/curation/alcohol-forms-spine.md` (§§2a–2c, 3, 4a),
`docs/curation/alcohol-forms-coverage.md` (§§0, 1, 1a, 3, 9a, 9d, 10, 12),
`docs/curation/grilling-history-coverage.md` (§§1, 2a, 2b, 7, 10, 10b),
`docs/curation/grilling-beat-cut-plan.md` (§§2, 2a, 2b, 3),
`docs/curation/segment-length-rules.md` (§§2a, 2b, 5a, 5c, 6c, 9),
`player/foray-queue.js`, `tools/foray/check-forays.mjs`,
`tools/ci/path-policy.mjs`, #226, #247, #278.

**External, fetched and pinned for the vertical slice.** Every span with its
`oldid`, retrieval date and verbatim text is in the beat files and rendered in
`references/T2-sugar-unlock.md`. Wikipedia: *Starch*, *Ethanol fermentation*,
*Amylase*, *β-Amylase*, *Saccharomyces cerevisiae*, *Grape*, *Honey*,
*Sugarcane*, *Palm wine*, *Wine*, *Malting*, *Mashing*, *Aspergillus oryzae*,
*Sake*, *Chicha*, *Tequila* — all retrieved 2026-08-19 and pinned by revision.
One primary source, as tier 2 corroboration: *Journal of Fungi*,
"Distinction Between Aspergillus oryzae and Aflatoxigenic Aspergillus flavus…",
doi:10.3390/jof12010010.
