# Foray #2 — THE TYPES OF CAPITAL AND FUNDING AVAILABLE TO STARTUPS

> ## STATUS 2026-08-30 — this is the first `published` Foray. Read §11 before quoting anything here.
>
> `data/forays.json` now says `"status": "published"` on `capital-types-1`, so it
> is listed on the home screen for an ordinary visitor rather than reachable only
> by `?foray=capital-types-1`. Every checker output quoted further down this
> document still prints `(draft)`, because those blocks are dated records of the
> runs that produced them and are deliberately not rewritten. **§11 says why this
> Foray was the one, and — more importantly — what is still not true of it.**

The second complete Foray. **22 segments, 51 min 22 s of tape**, in listening
order across eight arc slots, drawn from eight ad-free episodes of seven shows
(The Bootstrapped Founder contributes two). Batch `seg-2026-08-16-foray2-capital-a` merged **26** segments;
22 are in this running order and §7 says which four are held back and why. The
pool in `data/segments.json` now holds **62**.

Constrained by `docs/curation/segment-length-rules.md` (how long, how often),
`docs/adr/0007-segment-anchoring.md` (what a boundary is),
`docs/adr/0008-ad-tolerance-and-timestamp-precision.md` (what ad load costs) and
`tools/segments/README.md` (the batch/results contract and the verbatim-anchor
rule). Sourcing and per-episode ad measurements:
`docs/curation/foray2-capital-sourcing.md` and
`docs/curation/foray2-asr-manifest.json`. Method copied from
`docs/curation/grilling-foray.md`.

---

## 0. TL;DR

| | |
|---|---|
| Segments in the running order | **22** |
| Tape runtime | **3,082.43 s — 51 min 22 s** |
| Segments merged this batch | **26** (0 rejected); 4 held out of the running order |
| Mean / median segment | **140.1 s / 137.8 s** |
| Shortest / longest | 72.7 s / 259.9 s |
| Interquartile range | 71.75 s (R-7) |
| Source tape read | **12 transcripts, 8 h 46 m** — 9 of our own ASR (6 h 27 m) + 3 free publisher transcripts (2 h 18 m) |
| Episodes in the Foray | **8 of 12** — four dropped whole, all for the same reason (§6.1) |
| Yield on playable tape | **14.7 %** of 5 h 49 m |
| Yield on all tape read | **9.8 %** of 8 h 46 m |
| Topic ids | **3 nodes** — `economics/markets` 11, `business/startups` 9, `business/founders` 2. See §8 |
| `transcript_source` | `asr-local` on 5 episodes, `publisher` on 3 |
| `dai_suspected` | **false** on all eight played sources |
| Global rules missed | **None.** D1 passes at 5 of a budget of 6; D5 passes on the gated pairwise reading with 0 violations. §5 |

**The headline finding is not the runtime, it is that four of the nine ASR
episodes cannot be played at all.** All four are The Full Ratchet, and all four
carry dynamically inserted advertising — which we could only see once we held the
audio. That removed the arc's spine (ep 18, the taxonomy episode), corporate VC
(235), the accelerator mechanics (17) and half the crowdfunding slot (40). §6.1
is the measurement and §3 is what it cost. The gap was closed by fetching **three
free publisher transcripts** that needed no ASR at all — Run the Numbers on
venture debt and two Bootstrapped Founder episodes — which is why this Foray has
a venture-debt slot and an earnings-share slot that the original arc did not
plan.

**On the founder's balance requirement: it survived, and the accident helped.**
Of the eight episodes in the running order, **exactly one is a venture-capital
show** (Y Combinator's Startup School lecture). The other seven are a Threshold
partner talking a founder *out* of a raise, a bootstrapper narrating his own
funding contract, that bootstrapper's investor reading his own term sheet aloud,
a venture lender who has left the industry, three SBA lenders, an SBIR platform
founder and an equity-crowdfunding case study. Nobody in this Foray is a VC
selling VC.

**The 14.7 % yield is above Foray #1's 12.0 %, and the reason is source type,
not laxity.** Explainer formats carry more payload per minute than radio
conversation: the in-law case study yielded 27.8 %, the YC lecture 27.2 %, the
venture-debt interview 22.0 %. The two lowest were an 80-minute lender webinar
(11.2 %) and a crowdfunding episode that is mostly a stock pitch (6.7 %).
Per-episode numbers are in §1.

---

## 1. Sources

Seven shows, eight episodes. Every one measured **ad-free at ratio 1.0000** on
three probes, so `start_sec`/`end_sec` are the listener's own timeline and the
anchors are ADR-0007's durability backstop rather than a workaround for drift.

| `item_id` | Show / episode | True duration | Transcript | In pool | In Foray | Runtime | Yield |
|---|---|---|---|---|---|---|---|
| `tbf-309-funded` | The Bootstrapped Founder — *309: Funded!* | 1,628 s | publisher VTT | 2 | 2 | 317.6 s | 19.5 % |
| `yc-how-fundraising-works` | Y Combinator — *How Startup Fundraising Works* (Brad Flora) | 1,691.4 s | our ASR | 4 | 3 | 459.4 s | 27.2 % |
| `ss-inlaw-investors` | The Startup Solution — *The Case of the In-law Investors* | 867.5 s | our ASR | 3 | 2 | 241.0 s | 27.8 % |
| `tbf-328-tringas` | The Bootstrapped Founder — *328: Negotiating Bootstrapper Funding with Tyler Tringas* | 3,326 s | publisher VTT | 3 | 2 | 289.7 s | 8.7 % |
| `ftb-89-sbir-grants` | Feel the Boot — *89. Non-Dilutive Startup Fundraising — SBIR Grants* | 2,955.3 s | our ASR | 4 | 3 | 344.7 s | 11.7 % |
| `rtn-venture-debt` | Run the Numbers — *Venture Debt Explained* (Marshall Hawks) | 3,339 s | publisher SRT | 4 | 4 | 733.5 s | 22.0 % |
| `am-sba-lender-roundtable` | Acquiring Minds — *SBA Lender Roundtable: State of the Market* | 4,834.1 s | our ASR | 4 | 4 | 542.8 s | 11.2 % |
| `crowdcrux-557-atombeam` | Crowdfunding Demystified — *EP #557, Atombeam's StartEngine Strategy* | 2,282.7 s | our ASR | 2 | 2 | 153.7 s | 6.7 % |

The **20 % relative cap (L5) is per segment**, and the largest single segment
takes **16.6 %** of its own episode (FAM-2, 143.8 s of a 14½-minute episode).
The "Runtime" column is the Foray total; the binding rule at assembly time is M4
(§5), whose worst case is 23.8 %.

All eight are registered in `data/segment-sources.json` with the publisher's own
enclosure URL, feed, byte length and true duration. **Every `audio_url` was
verified on 2026-08-16 with a 2-byte ranged GET: HTTP 206 on all eight, and
delivered bytes byte-identical to the feed's declared length on all eight.** Two
notes on that registry:

- **`duration_sec` is the duration we measured, not the feed's.** For the five
  ASR rows it is `meta.audio_duration_sec` from `tools/transcribe/bench.py`; the
  feed's `itunes:duration` is carried alongside as `feed_declared_duration_sec`
  and disagrees by up to 1 s on these rows. `check-forays.mjs` compares
  `duration_sec` against `reference_duration_sec`, so it has to be the measured
  one.
- **The three publisher rows carry `transcript_url` and `transcript_type`.** An
  anchor is only verbatim with respect to one transcript, and for these three
  that transcript is a third party's file at a URL that can change. Recording it
  is what makes A13's re-resolution possible.

---

## 2. The running order

Migrated verbatim into `data/forays.json` (`forays[1].items`, in order), where
each entry carries the `segment_id`, the label used here, its arc slot and its
role. `tools/foray/check-forays.test.mjs` parses **this table** on every CI run
and compares position, label, duration and role against `data/forays.json`, so
the two cannot move independently.

*That was not true when this document was first committed.* It claimed the check
covered this table while the test read only `grilling-foray.md`, so for one
commit Foray #2's §2 could have drifted from the data with nothing detecting
it — the exact "silently rots" failure #182 built the check to prevent. The test
is now table-driven over both docs, with a companion assertion that every
committed Foray appears in that table.

Times are cumulative **tape** positions; real playback shifts later by the
narration bridge at each cut. Every claim in the right-hand column is inside its
own segment's boundaries.

| # | at | id | Dur | Role | Source | What it contributes |
|---|---|---|---|---|---|---|
| | | **SLOT 1 — why venture capital is the wrong default** (2 segments, 5:36) | | | | |
| 1 | 0:00 | BOOT-1 | 137.3 s | explanation | Bootstrapped Founder 309 | The power imbalance stated from the founder's side: raising a million means "inviting a voting party into your cap table" with different interests, because a VC needs **the one company in a hundred** to cover every loss on the other ninety-nine. Against that, the fund he took money from has funded **80-some companies and lost four**, and wants to be "the rising tide that lifts all the boats." Its LPs become the portfolio's mentors, so he is both mentor and mentee. |
| 2 | 2:17 | YC-1 | 198.9 s | explanation | YC / Brad Flora | The alternative to needing money first. It is cheaper than ever to build and host software and easier than ever to find users, so the move is a product plus a few users — which turns you from "the person waving the pitch deck around trying to find $20 million" into "someone whose startup is in motion." Then the worked case: **Solugen**, a chemical-manufacturing startup whose peers ask for $10–20M for a plant, built a desk-sized reactor, sold about **$10,000 a month of hydrogen peroxide to hot tub supply stores**, raised **$4M** on that, and has since raised **$400M** and built the plant. |
| | | **SLOT 2 — money from the people who know you** (2 segments, 4:00) | | | | |
| 3 | 5:36 | FAM-1 | 97.1 s | explanation | The Startup Solution | Survivorship bias defined — a data set already net of everyone who failed some prior test — and why a Silicon Valley cocktail party is one: nobody boasts about the money they lost. Then the number, from Crunchbase and CB Insights: **between 50 and 75 percent of seed companies fail after raising their seed round**, which is exactly the round the in-laws would join. Lands on the test that reframes it — would you recommend any other investment to your in-laws with more than half a chance of losing everything? |
| 4 | 7:13 | FAM-2 | 143.8 s | explanation | The Startup Solution | The mechanic amateurs miss: professional investors **earmark a reserve pool** at the time of the first cheque, commit nothing up front, and decide round by round; in her experience an investor is asked for **a third to half again** what they originally put in. Applied to this case, the in-laws should plan on **30–40 percent more** than their initial cheque — unaffordable precisely because they stretched for the first one. Closes on the trap: lose **401(k)** money in a startup and you generally **cannot claim a capital loss from a retirement account**. |
| | | **SLOT 3 — the equity round, and what it costs** (2 segments, 4:20) | | | | |
| 5 | 9:37 | YC-2 | 187.7 s | explanation | YC / Brad Flora | Why everything you read about fundraising is the wrong round. Series A and B are **$10 to $50 million**, take months, and cost hundreds of thousands in legal fees; a typical seed is **$500,000 to a couple of million**, closes in weeks or days, with no legal fees, and a $50,000 friends-and-family raise needs no lawyers at all. The reason is the instrument: YC wrote the **SAFE** in 2013, it is five pages with effectively two terms — investment amount and valuation cap, because "nobody does discounts" — it is free on the website, and Clerky sends and signs them in a few clicks. |
| 6 | 12:44 | YC-3 | 72.7 s | explanation | YC / Brad Flora | What a SAFE round does *not* hand over, and this is the answer to "if I raise money I lose control." A SAFE carries **no board seat**, creates **no shareholders at signing** (the investor gets shares in the next round, so no shares change hands), and grants **no information rights** — you choose how and when to update anyone. Founders raise millions selling **10 to 20 percent** and answer to customers instead of investors. |
| | | **SLOT 4 — investors who want earnings, not exits** (3 segments, 7:50) | | | | |
| 7 | 13:57 | CALM-1 | 146.9 s | explanation | Bootstrapped Founder 328 | The investor explains why the instrument had to be invented and then abandoned. Every standard startup document assumes the pre-seed → Series C ladder, so five years ago the fund wrote a **shared earnings agreement** from scratch whose salient feature was **founder profit sharing** — something venture structures do not contemplate, because they want every dollar reinvested in growth. A wholly custom document then created friction: local startup lawyers and co-investing angels did not know what it was. So they moved to **a standard YC SAFE plus a side letter**, on the reasoning that standardised paper is what other people can get their heads around. |
| 8 | 16:24 | BOOT-2 | 180.3 s | explanation | Bootstrapped Founder 309 | The terms, from the founder who signed them. The money is "not just runway money, it's a time machine" — a couple of months instead of multiple years. Then the mechanics: if he sells, the fund gets its ratio of shares; **until then every share is his, and if he never sells the fund never owns any part of the business**; the side letter carries the earnings share, so **any dividend he takes above a substantial six-figure salary sends a small part — "somewhere around 10 % or less" — to the fund**. His summary of the category: "It's not a unicorn hunt… it's a grazing ground for regular workhorses." |
| 9 | 19:24 | CALM-3 | 142.8 s | explanation | Bootstrapped Founder 328 | The arithmetic behind a price, said out loud by the person setting it. He works backwards from a portfolio model whose outcomes cluster at **5 to 7 times our money**, and a valuation is unreasonable when the cluster cannot support it: "if I say we're investing at a **$30,000,000** valuation and I see the clustering of outcomes around something that's worth 5 to 15, that makes no sense… I need to understand how this business is gonna be worth **$150,000,000** someday at a minimum." The 5–7× per deal is required because some fail while the fund is "shooting for **returning at least 3 times all the fund's money**." Ends by conceding it is "way more art than science." |
| | | **SLOT 5 — money that is not an investment** (3 segments, 5:44) | | | | |
| 10 | 21:47 | GR-1 | 79.8 s | explanation | Feel the Boot 89 | The scale and the door. The US government has **$700 billion in federal grants and contracts**, of which **about $4 billion is the Small Business Innovation Research programme**; eligibility is **fewer than 500 employees**, **majority owned and operated in the United States**, and innovative, **R&D-focused** work with the applicant supplying the rationale. Funded verticals run from education to space to ocean to agriculture to metrology. The constraint that decides fit: **they are not funding you to do marketing, they are funding development.** |
| 11 | 23:07 | GR-2 | 138.2 s | explanation | Feel the Boot 89 | The architecture. SBIR is a grant **and contract** programme spread across **about 11 participating agencies**; it exists because an early, risky idea an investor will not back would otherwise die — **Qualcomm started out on SBIR funding**. It has three components, of which **Phase I tests feasibility**, and applicants can be idea stage: "everyone from mom and pops who've written their idea on a napkin" to unicorns. The warning that makes it operational: **every agency has a different approach, need and expectation**, so positioning is the work. |
| 12 | 25:25 | GR-3 | 126.7 s | explanation | Feel the Boot 89 | Phase II and the strings. Roughly **12 months** after Phase I, **Phase II awards up to $1.75 million, non-dilutive, to reach an MVP**; **STTR** is the sister programme where you partner with a research institution. Both come as **either grants or contracts** — most people say grants, but some agencies, defence among them, actually award contracts, which brings deliverables and milestones. The money **never has to be paid back either way**, and a contract brings deliverables, milestones and post-award supervision against deadlines. (The guest's *"I tell people not to view this as free money"* lands at 2,425.4 s, 12.4 s **after** this segment's out-point, inside the GR-3 → GR-4 elision; it is not in the segment.) |
| | | **SLOT 6 — borrowing against the next round** (4 segments, 12:13) | | | | |
| 13 | 27:32 | VD-1 | 259.9 s | explanation | Run the Numbers | **The load-bearing segment of the Foray.** A lender at Series B or earlier is not asking whether this becomes "the next SpaceX or Anthropic or Apple" — it is estimating **the probability the company raises its next equity round in 18 to 24 months**, which is a far easier question, and "more art than science." Then the framework that makes it true: normal commercial banking has three sources of repayment (operating cash flow, balance-sheet assets, sale of the company), and venture lending replaces the first with **cash from the next equity financing**, because in "95 %, maybe even more than that 99 %" of cases the borrower is not profitable. The third source is a sale of IP — and if the company never found product-market fit, "the odds that there's a lot of IP value there is pretty negligible." |
| 14 | 31:52 | VD-2 | 149.8 s | explanation | Run the Numbers | Two lenders, two business models, and the answer to "how is this different from a bank loan." A **venture bank** treats the loan as customer acquisition — it wants to be your bank for the company's whole life — and funds it out of **deposits**: "banking 101, you take cash from people who have it and lend to people who need it." **Private credit** mirrors a VC structurally: third-party LP money from the same pensions and endowments, some of it in publicly traded BDCs, "so don't take the name private credit to say every fund there is private." It does no banking and does not care where you bank — which is one of its selling points. |
| 15 | 34:22 | VD-3 | 188.8 s | explanation | Run the Numbers | What it costs, which is the number the arc needs. A private credit fund is not holding your cash and has no other products to sell you, so it has to make an IRR; the typical delta between a venture-bank deal and a same-sized private-credit deal is **about 400 to 500 basis points** in rate and fees — and **lenders take a warrant in almost every scenario**, with private credit wanting a larger one. Venture-bank deals are commonly **sub-$20M**, and private credit "doesn't get out of bed" much under **$50 or 60 million**, because it must deploy drawn capital rather than hold an undrawn line open for 6, 12 or 18 months. Closes on the actual alternative: **instead of $100M of equity, $75M of debt.** |
| 16 | 37:30 | VD-4 | 135.1 s | explanation | Run the Numbers | The payoff, quantified. **Justin.tv** was the first company he was handed when he joined SVB in **January 2009** — "kind of when the financial world was ending, ironic given what happened to SVB about 13 years later" — it became **Twitch**, and they did **four deals** before Amazon bought it for a little under a billion dollars. Modelled afterwards, the debt preserved **$75 to $100 million of equity value** for founders, employees and existing investors versus raising the same money in equity. Then the honest frame: over-lever and it hurts, "but that's not unlike venture capital, where you can raise too much money." |
| | | **SLOT 7 — borrowing from a bank** (4 segments, 9:02) | | | | |
| 17 | 39:45 | SBA-1 | 91.3 s | explanation | Acquiring Minds | What an **airball** is, and why an SBA acquisition loan is not asset lending. A **$4–5 million loan** may sit against maybe **$100,000 of collateral** — an HVAC company's twelve to fifteen vehicles and a little inventory — because buyers price off cash flow and these are cash-flow lenders, and the searchers pricing them do the same. (The host's *"why am I going to let this guy who doesn't know what a condenser is buy an HVAC company?"* sits at 1,682.7 s, 6.7 s **before** this segment's in-point, and is not in it.) |
| 18 | 41:17 | SBA-2 | 130.8 s | explanation | Acquiring Minds | The underwriting test, stated as a number. Without at least **1.15 debt-service coverage on the last tax return** (the ASR drops the decimal point and renders it *“at least 115 debt service coverage”*; 115 as a coverage ratio is meaningless and 1.15 is the standard SBA figure) you are in policy-exception territory and effectively asking for a projection-based loan, which banks will not get comfortable with for an acquisition — and the reason ties back to the airball: with no hard assets, the bank's security *is* the historical pattern of cash flows. Buyers fixate on trailing-twelve-month numbers; **SBA requires underwriting off tax returns.** |
| 19 | 43:27 | SBA-3 | 208.3 s | explanation | Acquiring Minds | The two rule changes that decide whether a buyer can afford the deal. The **10 percent equity injection is still required**, but a **seller note on full standby** — no principal, no interest, for two years — can now count for **up to 100 percent of that 10 percent**; if the note is interest-only instead, **25 % of the 10 % must be buyer cash and 75 % can be the note**. In practice one lender caps standby-note credit at about **5 %** and wants a secondary note on top. Then the second change: sellers may now **retain equity after closing**, typically **5 to 10 percent**, where the SBA previously required a 100 percent change of ownership — and one panellist says **about half** his current transactions have a seller retaining equity, because it bridges valuation and solves licence transition. |
| 20 | 46:56 | SBA-4 | 112.5 s | explanation | Acquiring Minds | What it costs you personally, and it is not proportional. Two guarantors on one deal **both sign a 100 percent unlimited guarantee** even when one has **$2 million** of net worth and the other **$100,000** — "it's not fair… unfortunately just the way the program works." The SBA only requires a lien on a home when equity is **25 percent or more** of value. And the counter-risk of protecting yourself too well: with a $100,000 net worth you are very unlikely to get a $5 million deal done alone. It is a federal programme — **do not omit assets from the personal financial statement.** |
| | | **SLOT 8 — capital from the crowd** (2 segments, 2:33) | | | | |
| 21 | 48:48 | CF-1 | 79.3 s | explanation | Crowdfunding Demystified 557 | The ceilings, and how they force a company between instruments. **Reg CF is capped at $5 million on a rolling twelve months** — the ceiling for Reg A+ is given as the bare number, *“whereas reg A+ is 75”*, with the unit carried over from the sentence before it. They opened a Reg CF round in October, raised **$5 million in eight or nine days**, were then finished and could do nothing until the following October — so needing more capital made Reg A+ "inevitable" despite being "a lot more hassle… a lot of regulatory stuff." Campaign shape, from the person running it: "as usual with a bang, then kind of trailed off as usual." |
| 22 | 50:07 | CF-2 | 74.4 s | explanation | Crowdfunding Demystified 557 | Where retail money actually comes from, which is the cost nobody prices. The $5 million in a week came with **no paid acquisition** — "it's not advertising. I don't think we even advertise at all" — off an existing base of about **40,000 platform followers**, of whom roughly **11 to 12 thousand are investors**. The crowd is not a source of capital you can switch on; it is an asset you had to build first, and it is large enough that he cannot deal with it directly. |

### Why the slots run in this order, and what it cost to choose it

The arc walks **what you give up**, not chronology: sell equity outright (slots
1–3) → sell equity with an earnings share (4) → give up nothing (5) → borrow
against your next round (6) → borrow against your cash flow (7) → sell equity to
many strangers (8).

**That ordering was chosen by the cut budget, not by taste.** The first assembly
ran grants *after* both debt slots, and it failed D1: the grants block is three
segments averaging 115 s, and dropping it between the SBA block and the
crowdfunding pair produced a run of six starts inside 600 s. Moving grants
earlier puts the 259.9 s venture-debt opener immediately after it, which is what
breaks the run. Same lesson as Foray #1 §5, from the other direction: **slot
order is the only free variable once M3 fixes per-episode chronology, and it is
what decides D1.**

Two constraints shaped the inside of the slots:

- **M3 fixes the order of every same-episode run**, and five episodes contribute
  more than one segment. The YC lecture is the awkward one: its bootstrapping
  critique sits at 1,230 s, after the SAFE material at 837 s, so it could not
  open slot 4 ahead of slot 3's segments. That segment is now held back
  entirely (§7), but the constraint is why slot 4 has no YC voice at all.
- **Slot 4 alternates its two voices deliberately** (§6d of the length rules:
  vary the texture). CALM-1 → BOOT-2 → CALM-3 puts the founder between two
  passages from his investor rather than running both of each together.

---

## 3. What each slot got, and which stayed thin

| Slot | Segments | Runtime | Share | Verdict |
|---|---|---|---|---|
| why venture capital is the wrong default | 2 | 5:36 | 10.9 % | **Adequate, and not what was planned.** The taxonomy episode meant to carry this (Full Ratchet 18) is unplayable, so the slot argues the case rather than enumerating the instruments. |
| money from the people who know you | 2 | 4:00 | 7.8 % | **Full for its size.** One episode, but the only explanation of friends-and-family money found in the whole sourcing pass. |
| the equity round, and what it costs | 2 | 4:20 | 8.4 % | **Thin, and it is the thing most listeners came for.** Two segments from one lecture. See below. |
| investors who want earnings, not exits | 3 | 7:50 | 15.2 % | **Full, and the best-sourced slot in the Foray.** Both sides of one deal, published. |
| money that is not an investment | 3 | 5:44 | 11.2 % | **Full on SBIR, empty on everything else.** No NSF, no state grants, no R&D tax credit. |
| borrowing against the next round | 4 | 12:13 | 23.8 % | **Over-full, and it earned it.** One episode, and the cleanest source in the pass. |
| borrowing from a bank | 4 | 9:02 | 17.6 % | **Full for acquisition lending only.** See below. |
| capital from the crowd | 2 | 2:33 | 5.0 % | **Thin, and it is a content problem rather than a sourcing one.** |

**The equity slot is two segments and one voice, and that is the biggest hole.**
Everything in it comes from one YC lecture, which means the Foray explains the
SAFE and never explains a **priced round**: *preferred stock*, *pro rata* and
*option pool* appear nowhere in the running order, and *liquidation preferences*
and *valuation cap* appear exactly once each — the first inside FAM-2 at 654.8 s,
in a list of jargon the speaker is explicitly telling the listener to go and
research ("I apologise for all the jargon"), and the second inside YC-2 at
968.4 s. Named in passing is not explained. Angels, syndicates and stage
definitions have no segment at all. The sourcing pass had all of this — Full
Ratchet 10 (Brad Feld on the term sheet), 13 (the convertible note), 33/34
(syndicates) and seven VC Minute rows on exactly these mechanics — and the first
four are on the unplayable feed while VC Minute is capped to ~30-second quotes
(`foray2-capital-sourcing.md` §0.3). **This is the slot to fix next**, and the
fix is a source, not a better cut.

**The crowdfunding slot is thin because the tape is a stock pitch.** 38 minutes
of Crowdfunding Demystified yielded 2:33, a 6.7 % yield and the lowest in the
batch. §6.3 lists what was rejected: the valuation pitch ("we're 390 million…
the biggest freaking bargain on the planet"), a product explainer with no
financing content, generic founder advice, an MBA reminiscence and a Calvin
Coolidge quote. What survives is the two passages where someone states a rule or
a number. The **rewards** half of crowdfunding has no segment at all, and
`foray2-capital-sourcing.md` §5.4 already established that nothing in the crawled
surface explains rewards crowdfunding *as financing*.

**The bank slot is filled only for buying a business.** All four SBA segments are
7(a) acquisition lending. A software startup asking a bank for a term loan or a
line of credit is not covered, which is exactly the gap
`foray2-capital-sourcing.md` §5.3 recorded before any tape was read — the nearest
answer in the whole pass was a 150-second VC Minute episode on CDFIs, which the
relative cap restricts to a 30-second quote. **The slot is honest about what it
is; the Foray's title is broader than its bank content.**

**Growth-stage capital, private equity and secondaries have no slot at all.**
A6b and A13 in the sourcing doc's arc are absent: the PE and secondaries
candidates (Raw Selection ×2, Capital Allocators 448, Startup Solution *Secondary
Showdown*) were never transcribed, and growth equity was never sourced at all.

---

## 4. Per-segment rule compliance (tiers P and B)

- **L1/L2 floors.** Every segment in the running order is **≥ 72.74 s** (YC-3),
  comfortably over the 60 s `explanation` floor it carries. Across the whole pool
  of 26 the shortest is FAM-3 at 58.86 s, a `quote` against a 30 s floor, and §7
  holds it back.
- **L3 ceilings.** Longest is VD-1 at 259.88 s against the `explanation` maximum
  of 360 s. No segment in the running order is roled `quote`.
- **L4 soft maximum.** **One segment exceeds 240 s** — VD-1 at 259.88 s. It
  carries `needs_review: true` and a `long_reason` on its `data/forays.json`
  item (the interim home §9 of the length rules specifies, since neither field is
  in the schema `merge-segments.mjs` writes). The reason is stated rather than
  gestured at: the underwriting thesis and the three sources of repayment are one
  argument, and every number sits in the second half.
- **L5 relative cap.** Largest share of a source episode by a single segment is
  **16.6 %** (FAM-2). All 26 are inside 20 %.
- **L6 roles.** Two values used, `explanation` (25) and `quote` (1, held back).
  `role` is still not in the schema `merge-segments.mjs` writes, so it lives on
  each `data/forays.json` item — which is what makes **L2, L3, L4 and D4**
  machine-checked for the 22 played segments.
- **B1 median.** **137.8 s** across the 22 played (140.1 s mean); 136.2 s across
  all 26 merged. All three sit inside the 75–180 s target band.
- **Anchors.** All 52 anchors were built from the transcript actually used and
  then resolved back through the real `normalize()` → `buildTranscriptIndex()` →
  `findAnchorOccurrences()` path **before** the merge: **every one resolves
  exactly once**, every one is **≥ 9 words** (mean 15.6, longest 26), and
  `merge-segments.mjs` rejected 0 of 26.

### The boundary bug this batch found, and why it matters for Foray #1

`grilling-foray.md` §4 says of Foray #1 that "`start_sec`/`end_sec` are the word
timestamps of the anchor text itself, so the timeline cache and the anchor cannot
disagree by construction." **Taking that literally is what caught a real defect
here.**

`findAnchorOccurrences()` does not return the anchor's own times. It returns
`startTimes[i]` and `endTimes[i + n - 1]`, and `buildTranscriptIndex()` stamps
**every token in a cue with that cue's start and end**. So a resolved occurrence
is the *containing cue's* span, which for our ASR cues (5–8 s) overshoots the end
of the anchor by however much of the cue follows it.

The first assembly of this Foray took those numbers as the boundaries, and **nine
of the seventeen ASR segments therefore ended mid-sentence** — YC-1 ran on to the
word "next", YC-3 to "could", SBA-3 to "There's". That is exactly the S2
clean-out defect ("it cut off"), introduced by trusting a helper's return value
rather than the word stream. The fix was to match each anchor against the ASR
**word** array and take the first word's start and the last word's end; it moved
**22 boundaries — 12 starts and 10 ends** — and shortened the running order by
56 s. (Those two figures, and the "0 rejected of 26" in §4's anchor bullet, are
properties of the uncommitted batch run and cannot be recomputed from the tree;
§10 says why the batch files are not committed.) **After the fix all 26
`end_anchor`s land on a sentence terminal** in the transcript they were authored
against (see below).

**Foray #1 should be re-checked for the same thing.** Its ten ASR episodes went
through the same helper, and if its boundaries were also taken from
`findAnchorOccurrences()` then some of its 36 segments end a few words late as
well. This document does not assert that they do — the batch scripts were not
committed (`grilling-foray.md` §10) so it cannot be read off — but the defect is
invisible in the data, silent in the validator, and audible on playback, which is
the worst combination. **Filed as the first thing to check before anyone listens
to Foray #1.**

### S0 sacrificial head

Every boundary was placed ahead of the load-bearing claim. The pattern that
worked best here is different from Foray #1's: **seven of the 22 starts open on a
question or a hand-off rather than on content** — SBA-1 (*"What do you mean by
airball?"*), SBA-3, SBA-4, CF-1, CF-2, GR-3 and VD-4. An interviewer's question
is an ideal sacrificial head: audibly not the payload, and it names the subject.

**Two starts open mid-clause and are left there:**

| Segment | Opens on | Why it is left |
|---|---|---|
| VD-3 | *"the private credit funds, they're not holding your cash."* | The mid-roll ends ~1,794 s and this content begins at 1,800.04 s. A cleaner start exists 2 s earlier (*"I guess it's two things is that"*) and was rejected as 6 s of throat-clearing hard against an ad; that is an editorial call, not a constraint, and it is the weaker of the two mid-clause starts here. |
| SBA-4 | *"and somebody who has no net worth basically have to deal with the same personal guarantee"* | The orphan is the conjunction; this is the host completing the question that makes the answer land, and starting 6 s later opens on *"Sure. I have this discussion with clients often."* |

One further flag of the kind Foray #1 recorded for TAV-2: **BOOT-1 opens on
*"First things first. Am I still an indie hacker?"* and the load-bearing claim
(the power imbalance) arrives about 7 s in**, past the ~4 s head budget. It is
left because the identity question is what the slot is about.

### S1 cold-open — sixteen anchors fire the lexical test, fifteen unrescued

**Sixteen of the 26 `start_anchor`s open on a word in the length rules' §7
connective/pronoun list**, and **only one is rescued** by the rule's own escape
clause (a proper noun inside the first 12 words): SBA-2, which opens *"It goes
back a little bit, **Will**…"*.

*One caveat on that 16, because a future validator will report a different
number.* It counts `That's` as *that* and `It's` as *it*. The repo's only
canonicaliser, `canonical()` in `merge-segments.mjs`, deletes apostrophes rather
than splitting, so those become `thats` and `its` and match nothing in §7's list
— giving **14 fire, 13 unrescued, 50 % of anchors**. The stricter reading is the
one a human would apply and the one used above; the mechanical one is 14/13.
Either way the conclusion below is unchanged. The other fifteen would carry
`cold_open_ok: true` if the schema had the field: FAM-1, CALM-1, BOOT-2, CALM-2,
CALM-3, GR-1, GR-2, GR-3, GR-4, VD-1, VD-2, SBA-1, SBA-3, SBA-4 and CF-2.

**This is the strongest evidence either Foray has produced that S1 must not
become a gate.** Foray #1 reported six unrescued flags on 36 segments; this batch
has fifteen on 26 — **58 % of anchors**. The mechanism is not sloppiness, it is
S0: a throwaway run-up in spoken English almost always begins with a connective,
so the rule that improves the listener's experience is the rule that trips this
test. The two rules are in direct opposition, and on explainer-format tape S0
wins nearly every time. **S1 is worth keeping as a flag and is unusable as a
gate without the override field §9 of the length rules proposes.**

### S2 clean-out — evaluable on all eight episodes, and it passes on all eight

Unlike Foray #1, where `base.en` produced three near-unpunctuated transcripts and
made S2 unevaluable on a third of the episodes, every transcript here is
punctuated: the three publisher files by construction, and the five ASR files at
one sentence-ender per 12–19 words. **25 of 26 `end_anchor`s land on a sentence
terminal** (`.`, `?` or `!`) in the transcript they were authored against, after
the 22 boundary moves described above.

**The one failure is VD-3, and the distinction matters.** Its `end_anchor` ends
on *"…maybe that amount or 75 million in debt"*, and in the transcript that word
is followed by *"to to then use one of the."* — so the **anchor** does not end at
a terminal, even though `end_sec` (the containing cue's end, 1,988.80 s) does.
S2 as written in `segment-length-rules.md` §9 is a test on the anchor, so this is
a fail, not a pass with an asterisk. An earlier draft of this section claimed
26 of 26 by measuring at `end_sec` instead, which is the cue and not the anchor —
the same conflation §4's boundary bug is about, made a second time in the
reporting rather than in the data.

It is kept because it is the best boundary available: the SRT is cut at 2–4 s
intervals that rarely coincide with sentence ends, there are no word timings to
cut against, and the payload (*$100M of equity or $75M of debt*) lands intact
with about a second and a half of the host's next question after it.

### M1/M2 same-episode gaps

**No pair anywhere in the pool is inside the 45 s must-merge window.** The
tightest is **54.1 s** (GR-3 → GR-4), and it is tight on purpose: the two are
adjacent in the episode and the boundary was chosen so the gap clears 45 s rather
than by topic. **Six pairs fall in the 45–180 s "should merge" band** and all are
kept separate with a reason. `merge-segments.mjs` does not persist
`keep_separate_reason`, so this table is the record.

| Pair | Gap | Why not merged |
|---|---|---|
| GR-3 → GR-4 | 54.1 s | The elision is a program-officer aside plus "the thing is every project is different." Merging lands at 274 s and would need an L4 escape hatch for material the argument does not need. GR-4 is held back anyway (§7). |
| YC-2 → YC-3 | 60.2 s | The elision is the Asher Bio biotech example — a third case study, and YC-2 is already 188 s. Merging lands at 321 s, past the soft maximum with nothing the argument needs. |
| FAM-2 → FAM-3 | 61.2 s | The elision is the $16,000 annual gift exclusion and the IRS pointer — genuinely useful, and a US tax number that dates. Merging also lands at 264 s, past 20 % of a 14½-minute episode, so it is not available. FAM-3 is held back (§7). |
| YC-3 → YC-4 | 72.6 s | The elision is the Zapier story (three founders from Missouri, over $1M at demo day, a $100M revenue business off one round). Good, and a third worked example in a slot that already has two. YC-4 is held back (§7). |
| VD-1 → VD-2 | 134.3 s | The elision is a 130-second answer on GPU and data-centre collateral — excellent, and private-credit macro rather than how venture debt works. Held for a different Foray. |
| CALM-2 → CALM-3 | 178.6 s | The elision is his refusal to quote the deal's numbers and a reputational-enforcement aside. CALM-2 is held back (§7). |

Every pair is in chronological order within its episode (M3), both as stored and
as played.

---

## 5. The global cut-frequency rules — checked against the assembled sequence

Tier-A rules from `segment-length-rules.md` §9, evaluated by
`tools/foray/check-forays.mjs` on every CI run. Every number below was produced
by that checker, not by hand. The Foray is **51:22**, which puts it in the
**45–120 minute band, so N = 6** starts per rolling 600 s. The block below is an
excerpt: the real run also prints Foray #1's line and its three warnings.

```
capital-types-1 (draft): 22 segments, 51.4 min, mean 140.1 s
  D1 5/6 starts per 600 s   D5 0 triples, IQR 71.75 s
17 source episodes registered
WARN foray "capital-types-1": D5 (mean-deviation reading, not gated): CALM-1 / BOOT-2 / CALM-3 worst deviation 15.1 %
WARN foray "capital-types-1": D5 (mean-deviation reading, not gated): VD-2 / VD-3 / VD-4 worst deviation 19.6 %
forays ok
```

| Rule | Requirement | Measured | Verdict |
|---|---|---|---|
| **D1** | ≤ 6 segment starts per rolling 600 s | **5** — one start of headroom | **pass** |
| D2 | ≤ 2 consecutive segments < 60 s; the next ≥ 150 s | **no segment in the running order is under 60 s at all** | pass |
| D3 | mean segment duration ≥ 90 s | **140.1 s** | pass |
| D4 | ≤ 20 % of segments are `quote`; ≤ 2 adjacent | **0 / 22** | pass |
| **D5** | no 3 consecutive durations within ±20 % | **0 violations** on the gated pairwise reading; 2 on the warned mean-deviation reading | **pass** |
| D5 | whole-Foray IQR ≥ 45 s | **71.75 s** (R-7) | pass |
| M3 | same-episode segments never out of chronological order | true for all eight `item_id`s | pass |
| M4 | ≤ 25 % of segments **and** runtime from one `item_id` | worst is `rtn-venture-debt` at **18.2 % of segments, 23.8 % of runtime** | pass |
| L7 | payback: `duration ≥ 4 × (bridge + 1) + 4` | the shortest segment is 72.74 s, which permits a bridge up to 16.2 s, above the spec's 8 s cap, so **every segment satisfies L7 whatever the bridges say** | pass by construction |
| X1/X2/M5/M6 | seam marking and attribution | no bridge records exist yet | deferred |

### D1 failed three times, and here is what it cost

It failed on the first assembly (26 segments, 58:49), again after two segments
were dropped, and again after the boundary fix in §4 shortened everything by
56 s. Each time the worst window held **exactly 6 starts — the budget** — which
is where Foray #1 shipped and which `tools/foray/README.md` notes leaves no room
("one more segment and this goes red"). Three changes bought a start of headroom:

1. **The grants slot was moved ahead of both debt slots**, so the long
   venture-debt opener follows the Foray's shortest-segmented block.
2. **Four segments were dropped from the running order** (they stay in the pool
   — §7), removing 387 s.
3. **Two SBA boundaries were moved** for D5 (below), which incidentally widened
   the SBA block's spread and helped here too.

**The trade: 7 min 27 s of runtime against the first assembly, for one start of
headroom.** 51:22 that never crowds beats 58:49 that sits exactly on the line.

### D5 also failed, and the fix was a boundary rather than an order

The first assembly had **two pairwise D5 violations**, both inside the SBA block:
VD-4/SBA-1/SBA-2 at 135.1 / 122.6 / 137.1 s (ratio **1.119**) and
SBA-1/SBA-2/SBA-3 at 122.6 / 137.1 / 145.3 s (ratio **1.186**). **Reordering
cannot fix either**, because all four SBA segments come from one episode and M3
fixes their order as an integrity rule.

So the boundaries moved instead: SBA-1's out-point came in by 28 s, dropping a
passage about spotting a lender who does not really do SBA; and SBA-3's went out
by 70 s, which added the entire partial-change-of-ownership answer. **Both
boundaries are better editorially than the ones they replaced** — SBA-1 now ends
on its own argument and SBA-3 now carries the second rule change — which is worth
recording because it is the first time in either Foray that a D5 fix improved the
content rather than costing some.

**A finding about the rules.** Foray #1 concluded that "a pool whose mean is
under ~110 s cannot fill a 60-minute Foray without either breaking D1 or going
uniform." This batch's mean is **140.1 s**, 40 % above N = 6's implied 100 s
gap, and D1 *still* failed three times. The reason is that the constraint is
**local, not global**: one slot whose segments all sit near 80–140 s breaches the
window no matter how long the Foray's mean is. The sharper statement is
therefore: **D1 is a constraint on the shortest-segmented slot, not on the
Foray's mean.** The grants slot (three segments, mean 115 s) was the whole
problem here, and moving it next to the longest segment in the Foray is what
fixed it.

The two mean-deviation warnings are recorded rather than resolved away, the same
way Foray #1 recorded its three: **CALM-1/BOOT-2/CALM-3** (146.9 / 180.3 /
142.8 s, worst deviation 15.1 %) and **VD-2/VD-3/VD-4** (149.8 / 188.8 /
135.1 s, 19.6 %). Their pairwise spreads are 26 % and 40 %, so neither reads as
metronomic, and the second is inside one episode whose internal order M3 fixes.

---

## 6. What was rejected

### 6.1 Four whole episodes — and the measurement that removed them

**The Full Ratchet 17, 18, 40 and 235 are dropped entirely: 2 h 57 m of tape,
already transcribed.** All four carry **dynamically inserted advertising**, which
makes our timestamps a foreign copy's timeline and makes the out-point
unanchorable (#65 §2). `tools/foray/check-forays.mjs` refuses to let a
`dai_suspected` source carry a played segment, and that refusal is correct.

**What the sourcing pass could see, and what only the audio could.**
`foray2-capital-sourcing.md` §3b measured these four by ranged GET and recorded
byte deltas of 12.4, 52.2, 23.0 and 29.3 s, all tiered PADDABLE. What it could
not see is *where* the insert is. Holding the audio settles it:

| Episode | Our decoded duration | Feed's `itunes:duration` | Declared bytes | Delivered bytes | Insert | At the episode's own bitrate |
|---|---|---|---|---|---|---|
| 17 | 2,203.36 s | 2,149 s | 26,289,736 | 26,441,316 | 151,580 B | 96.0 kbps → **12.6 s** |
| 18 | 2,240.99 s | 2,080 s | 34,979,034 | 35,856,888 | 877,854 B | 128.0 kbps → **54.9 s** |
| 40 | 3,102.16 s | 3,048 s | 49,264,223 | 49,635,749 | 371,526 B | 128.0 kbps → **23.2 s** |
| 235 | 3,067.26 s | 3,013 s | 60,755,179 | 61,346,654 | 591,475 B | 160.0 kbps → **29.6 s** |

Three things in that table are worth more than the tiering:

1. **The implied bitrates land on nominal CBR values to within 0.003 %** —
   96.0036, 128.0037, 128.0031 and 160.0038 kbps against 96, 128, 128 and 160.
   That is what shows the extra bytes are **audio at the same encode rate** rather
   than metadata, artwork or a container difference, and it is the reason the
   byte delta can be converted to seconds at all. **The ranged-GET probe is
   measuring real inserted audio.**

   *An earlier draft claimed something stronger and empty here:* that the byte
   insert converted at that bitrate "matches `decoded_duration − (declared_bytes
   × 8 ÷ bitrate)` in every row." It does — to about 1e-13 s — because bitrate is
   *defined* as `delivered_bytes × 8 ÷ decoded_duration`, so the equality is an
   algebraic identity that holds for any four numbers whatsoever. It is not
   evidence, and calling it the cross-check ADR-0008 asked for was wrong. The
   cross-check that ADR actually wants — our decoded duration against a publisher
   transcript's last cue — **is still not available for these four**, because The
   Full Ratchet publishes no transcript. The nominal-bitrate argument above is
   what we have, and it is weaker than what ADR-0008 asked for.
2. **`itunes:duration` on this feed is short by 54 to 161 seconds.** Note what
   that does to ADR-0008's own arithmetic: `delta_sec = duration × (ratio − 1)`
   uses the declared duration and therefore understates ep 18 (52.2 s against a
   measured 54.9 s). Small here, but the method matters — **compute the delta at
   the measured bitrate, not from the declared duration.** Recorded in
   `data/segment-sources.json`'s `provenance.ad_delta_method`.
3. **The insert is not a pre-roll, and that is what settles the tier argument.**
   All four open with the **same ~19 s read for Ramp** — 0 to 19.14 s, then *"Now
   onto the episode"* at 19.4 s. (An earlier draft called it "~26.5 s and
   word-for-word identical". Both were loose: 26.5 s is the *containing cue's*
   end, not the ad's, and ep 17 says *"before **the software** is gone"* where the
   other three say *"before **this offer** is gone"* — plausibly one ASR error on
   identical audio, but not something to assert.) Eps 17, 18 and 40 were
   published in 2014 and Ramp did not exist, so on those three the read is
   inserted rather than baked in; **ep 235 is recent enough that the pre-roll
   alone proves nothing**, which is why the mid-roll below is the load-bearing
   observation for it.

   **Ep 235 carries a second Ramp read as a mid-roll at 1,783.6–1,816.2 s**,
   ending on *"Now back to the interview."* So the offset function is not
   constant: it steps partway through the episode, which is precisely the case
   ADR-0008 says "the distribution decides the outcome and the distribution is
   exactly what a byte or duration measurement cannot see."

   **And ep 17 indicts the byte method harder than point 2 does.** A ~19 s
   pre-roll against a **12.6 s** total byte delta means the delta *understates*
   that episode's inserted audio by more than 50 %. The declared byte length is
   evidently not the ad-free master's — it is some earlier assembled version — so
   `delivered − declared` is a floor on the insert, not a measurement of it. Any
   pad sized from it is undersized by an unknown amount.

**None of that makes them un-authorable.** ADR-0008 Decision 5 is explicit —
unplayable shows are authored, not played — and ADR-0007's anchors stay true
under any ad load. **No Full Ratchet segments were authored in this PR**, a scope
call rather than a rule: authoring them would add records that cannot play until
`seekPrecision()` gains a `FOREIGN` branch (ADR-0008 open question 2), and the
passages are inventoried below so a future batch does not re-read 2 h 57 m.

They are also **not registered in `data/segment-sources.json`**, which the brief
asked for. `tools/foray/check-forays.test.mjs` carries an invariant — "no source
is DAI-suspected, so every out-point is anchorable" — that is true of that file
today, and adding four DAI rows with no segments would have meant weakening a
committed gate on a PR that auto-merges with no review window, to record
measurements already committed in `docs/curation/foray2-asr-manifest.json` and in
the table above. **Five of the nine ASR episodes are registered, not nine.**
Reported rather than rounded into a pass.

**The inventory, so the CPU is not spent twice.** All timestamps are on our own
decoded copy.

| Episode | Passage | Window | What it teaches |
|---|---|---|---|
| 18 | The landscape, host-narrated | 1,918–2,202 s | The six-category map with sources for each: equity, debt, hybrid, asset-based lending, royalties/licences, grants. **This is the segment the arc lost.** |
| 18 | Asset-based lending mechanics | 972–1,096 s | Lenders advance **70–80 %** of *good* receivables (≤60 days, no government content, no customer over 10 % of the total) and **~50 %** of acceptable inventory; hidden costs include an annual audit and a **3–5 day interest float per receivable**. |
| 18 | The 20 %-growth rule, and usury | 1,096–1,195 s | Past breakeven and growing 20 %+, an asset-based loan beats equity; usury caps do not apply B2B to a licensed lender and an incorporated borrower. |
| 18 | Warrants, and what they cost | 1,195–1,360 s | Warrants exist to bridge a valuation gap; penny warrants on 20,000 shares; the next investor prices off the fully diluted table, so it is dilution by another name. |
| 18 | Angel return math | 164–245 s | 6,300 executive summaries → 108 investments → **4 of 16 winners produced 90 % of all gains**; the real hit rate is 1 in 20, and average time to liquidity is **11 years**. |
| 17 | The accelerator deal | 1,020–1,138 s | **$18,000 plus ~$300,000 of perks for 6 % of common stock** — "we sit on the cap table right next to the entrepreneurs" — plus an optional $100k note and an equity-back guarantee. |
| 17 | The selection funnel | 440–557 s | 700–900 applications → 105 interviewed → 40 → 25 → **10, just over 1 %**, an order of magnitude more selective than the best law schools. |
| 17 | The mentor month | 818–941 s | **166 mentors, 663 one-on-one meetings, 60 per CEO in one month**; "the mentors don't have the answers. The market has the answers." |
| 17 | The fund behind the programme | 1,401–1,595 s | The 6 % goes to a small four-year fund with 37+ investors that historically returns 3–5×; the 2010 class has already returned ~95 % of its capital. |
| 235 | The CVC rebuttal | 883–1,059 s | "Separation of church and state" on information flow, with the portfolio company deciding what Microsoft sees; deliberate investments in companies Microsoft competes with; "we're not aligning to Microsoft strategy." |
| 235 | How corporate capital is structured | 1,066–1,196 s | **No LP fund: off balance sheet, from the CFO, with a new vintage allocated every year**, plus a separate growth fund. This is the mechanism that makes CVC different, and nothing else in the pass explains it. |
| 40 | Why retail capital entered private markets | 1,014–1,150 s | LP minimums of ~$5M imply ~$100M of assets; the accredited test is **$200,000 of income or $1M outside your home**; **10 million such US households** and only **100–200 thousand have ever angel invested — 1 to 2 %**. |
| 40 | The SPV, and the rights it buys | 563–687 s | A **single-company vehicle per deal** is what earns anti-dilution, drag/tag and pro-rata rights that a direct-equity crowdfunding site does not get. |
| 40 | The cap-table consequence | 1,346–1,452 s | "A guy and a gal and a dog and a startup with **two thousand investors at fifty dollars a pop**" — a table no VC will look at, which "curses these companies to be forever outside the inner circle." |
| 40 | Geography as the real driver | 1,632–1,800 s | Surgical Theater got funded from Jerusalem because Valley VCs hung up on hearing *Cleveland*: "the call would last about two or three minutes and then end abruptly." |

**Ep 40 carries a second caveat beyond the ads: it is a 2014 episode that
describes JOBS Act Title III as still pending.** Any crowdfunding segment cut
from it needs framing as a period document, and the words *Reg A*, *Reg D*,
*506(c)* and *Title III* are never spoken in it.

### 6.2 Sponsor reads and housekeeping — never a boundary

Product principle #3 and the #64 ruling both say a boundary is chosen
editorially and that ads falling outside it stay incidental. These were excluded
before authoring, not cut around:

- **Run the Numbers** (55:37, ~8 min of it): two clean mid-roll blocks — Abacum,
  Brex and Metronome at **~839–1,035 s**, and RightRev, Rillet and Tabs at
  **~1,583–1,794 s** — plus the host's own recruiting pitch at ~168–207 s, a book
  plug at ~3,290–3,304 s and the outro. **VD-1 begins at 1,034.72 s and VD-3 at
  1,800.04 s, i.e. within a second and within six seconds of those blocks
  ending**, which is the tightest either Foray has cut to an advertisement and
  the reason VD-3 opens mid-clause (§4).
- **Acquiring Minds**: Smithlist ~104–205 s, Oberle Risk ~228–267 s, Aspen HR
  ~857–896 s; plus panellist self-introductions 296–431 s ("we are the nation's
  number one SBA lender"), a host testimonial 1,468–1,549 s, and each firm's
  onboarding pitch ~4,297–4,392 s.
- **Bootstrapped Founder 309**: the acquire.com sponsor is **host-read and baked
  in** — a mention at ~44–51 s and the full read at **1,437.6–~1,589.5 s**.
  Nothing was cut across either; the last usable content in the episode ends at
  1,403 s. The read itself teaches (a skill-ceiling argument, "there is a third
  option") and is sponsor-owned, so it is excluded anyway.
- **Bootstrapped Founder 328**: acquire.com again at ~3,236–3,303 s, plus wrap
  chatter and the outro. Also a **video-dependent** bit at ~247–279 s: the dog
  Bina "bit on the signature page," explicitly "for anybody who watches."
- **Feel the Boot 89**: no third-party sponsor, but a **200-second first-party
  pitch at 482.8–683 s** for the guest's own SBIR application platform, invited
  by the host, plus a second permissioned block at 2,567–2,664 s, an explicit CTA
  at 2,835–2,864 s and a like-and-subscribe outro at 2,892–2,955 s.
- **Crowdfunding Demystified 557**: host cold-open promo 3.9–173.5 s, the host's
  own book and course plugs 173.5–~281 s, a **Fulfillrite read ~1,055–1,101 s**,
  StartEngine link housekeeping 1,877–1,933 s (also visual — it describes where
  the company sits in the platform's UI), and a coaching pitch in the outro.
- **The Startup Solution** and the **YC lecture** carry **no advertising at
  all** — the only two such episodes in the batch.

### 6.3 On-topic passages rejected on quality

- **Feel the Boot's Phase III / sole-source answer** (2,664–2,750 s). "Sole
  source is a root password to government contracting," and their own Phase III
  closed in about three months. Rejected because the ASR is corrupted in the
  middle of it — *"Everything gorillas that are out there"* is certainly
  "everything goes out to bid… 800-pound gorillas" — and because the proof point
  is the guest's own company. **The closest call in the batch.**
- **Feel the Boot's application-cost answer** (2,129–2,278 s). The best numbers
  in the episode — **~160 hours** to self-file, **over 80 % rejected for
  non-compliance**, an unaddressed form on **page 270 of a 300-page
  solicitation**, ~8 months maximum to cash — and unusable as one span, because a
  product claim sits in the middle of it at ~2,168–2,182 s ("if you're on the
  system with us… turn around applications in a couple of weeks"). A segment is
  one contiguous span; there is no internal cut. **Two of the three headline
  statistics in that episode are also the seller's own unsourced market sizing**,
  which is a second reason not to put them in a listener's ear.
- **Feel the Boot minutes 13 to 32** (796–1,921 s, ~19 minutes). Founder
  psychology — immigrant family, loneliness, mentorship, hustle culture, mental
  health, a Kung Fu sparring analogy. Sincere, well told, and zero capital
  content; the host flags the drift himself at 1,921 s.
- **The venture-debt legal process** (2,114–2,490 s, four passages). **6 to 8
  weeks** from term sheet to funded, "three to five turns" of a 100-page loan and
  security agreement, the company pays **both sides' legal fees**, and a sharp
  falsifiable claim: in two decades and hundreds of deals he has **never** seen a
  process go faster or cheaper because a general counsel ran it. Real teaching,
  and it is transaction management rather than a type of capital. Held for a
  Foray about closing a deal.
- **GPU and data-centre collateral** (Run the Numbers 1,291–1,422 s). What you
  can collateralise when "these things are melting off the walls," economic
  versus *technical* depreciation of a GPU, and the dot-com fibre contrast —
  fibre was built with no customer, whereas today's data centres have signed
  offtake contracts. Excellent, and it is private-credit macro. Also the most
  perishable material in the batch.
- **The SBA market outlook** (Acquiring Minds, five passages, ~1,143–1,466 s and
  2,563–2,790 s). Buying power down ~22 % on rate moves, **40–50 % of businesses
  showing revenue decline in the first half of 2024**, a prediction that the
  lender count shrinks as COVID cash peels away, and why problem loans almost
  always start going wrong immediately after close ("you can't make a good deal
  with a bad person"). All genuinely informative, all dated within a quarter, and
  a Foray is not a market update.
- **Almost all of Crowdfunding Demystified 557.** The valuation pitch
  (1,337–1,454 s: "we're 390 million… the biggest freaking bargain on the
  planet… it's a screaming deal"), the product explainer (371–658 s: 75 % data
  reduction, 570 patents, DARPA, the F-35), investor-relations
  self-congratulation (1,575–1,670 s), management advice (1,670–1,788 s), an MBA
  reminiscence (1,788–1,877 s), a book recommendation and a Calvin Coolidge quote
  (1,933–2,107 s). **The episode's own headline totals are internally
  inconsistent** — the intro claims $8.5M of Reg CF plus $19M of Reg A+ and "over
  33 million," while the body says the first Reg CF was $2.5M and October's was
  $5M — so both kept segments were chosen to carry **caps and per-campaign
  mechanics and no cumulative totals**. One 28-second fragment was a real loss:
  crowdfunding as a **bridge to an institutional round** ("stop this crowdfunding
  raise, and go out and do an institutional shot with like a hundred million"),
  too short and welded to the valuation pitch on both sides.
- **The Startup Solution's dramatised voicemail** (83–164 s). The vivid image the
  whole episode rests on — retired in-laws who would tap a **401(k)** and take
  out a **second mortgage** for a "once in a lifetime opportunity." Rejected
  because it is a scripted composite character voiced as fiction (the episode
  says so at 841 s) and the production shift would jar mid-Foray.
- **The YC lecture's opening myth** (255–337 s). On topic and vivid — Mark Cuban
  has put **$20 million** into Shark Tank companies and "hasn't made a dime yet";
  one company met **160 investors, 39 said yes, cheques from $5k to $200k, four
  months and eighteen days, $1.6 million**. **Rejected on the audio-only gate,
  the first rejection on that ground in either Foray**: it is built on a Shark
  Tank photograph and a network diagram, and the passage narrates the legend —
  "You see at the top, the company in each one of these circles and squares."
  Unrecoverable without the picture.
- **Retool's seed round** (YC 771–836 s). A founder opened his laptop in a coffee
  shop, built a crude internal tool in minutes, talked about what early customers
  liked, and that was the pitch; now a $4 billion valuation. 65 s, and it also
  leans on a slide.
- **Bootstrapped Founder 309's incorporation logistics** (807–1,019 s). A Wyoming
  LLC versus a **Delaware C corp** for a German citizen resident in Canada, and
  the German **GmbH** contrast (€12,000 of locked-in capital, a mandatory
  in-person notary, technical bankruptcy before the bank account exists). Vivid,
  and a where-to-incorporate question rather than a type of capital. The passage
  also turns into an unpaid endorsement of two vendors.
- **The side-project covenant** (Bootstrapped Founder 328 at 1,023–1,163 s and
  309 at 1,238–1,325 s). Both sides of the same clause: any substantially similar
  business started within **12 months** belongs to the funded company, read out
  almost verbatim from the side letter, and the founder's account of what he
  negotiated. The closest thing in either episode to a restrictive covenant, and
  it is a **term of one specific instrument** rather than a property of the
  category. Held; a Foray about what investors ask for should open there.
- **QSBS** (Bootstrapped Founder 328 at 1,914–1,982 s). Stock held in a C corp
  for **five years** can be sold with essentially no capital gains tax on up to
  **$10 million**, and it is currently ambiguous whether the clock starts at the
  SAFE or at conversion — which is the whole reason the fund negotiated a right
  to convert after 18 months. Genuinely excellent, and it is US tax law with a
  stated "I'm not a tax advisor" disclaimer attached.
- **Most Favored Nation** (Bootstrapped Founder 328 at 2,045–2,251 s). The clause
  defined in plain English, attributed to YC's standard documents, and then
  steel-manned with an Apple-shares analogy. Two passages, both good, and the
  slot already carries three segments from these two episodes.

---

## 7. Four segments in the pool and not in the Foray

`data/segments.json` holds 26 new segments; the running order uses 22. All four
held-back segments are valid, merged records that a future Foray can use — the
pool is a pool, not a playlist.

| Held back | Dur | Why |
|---|---|---|
| **FAM-3** `ss-inlaw-investors#770` | 58.86 s | Dropped for D1 (§5). Roizen's three tests for any seed cheque — money you can afford to lose, money you can tie up seven years, and about half again as much for a later round — then the question she puts to founders: how would you feel if all those people lost all that money because your startup failed? **The best-written 60 seconds in the batch, and the only `quote` in the pool.** It went because it was the shortest segment in the Foray and the short leg of the tightest D1 window. |
| **YC-4** `yc-how-fundraising-works#1230` | 88.64 s | Dropped for D1 (§5). The case against bootstrapping forever, and **the only argument in the Foray against the non-dilutive route**: it is scary (always about to run out), miserable (no decent salary), distracting (consulting detours), and "there are very few examples of 100 % gigantic bootstrapped companies." Its definition is the sharpest line held out: *bootstrapping is taking the pain of fundraising and stretching it across the entire life of your company.* Losing it means slot 4 argues one side. |
| **CALM-2** `tbf-328-tringas#2299` | 146.19 s | Dropped for D1, and it was the least essential of the three CALM segments. Terms only set a default: a portfolio company sold a product asset, the written terms counted the proceeds as income and triggered a large shared-earnings payment, so they renegotiated — the cash stays on the balance sheet and earnings are owed only when the founders take it out as compensation. **The clearest statement anywhere in the batch of what an earnings share is actually assessed on.** |
| **GR-4** `ftb-89-sbir-grants#2467` | 93.58 s | Dropped for D1 and for slot balance. Phases I and II are a pipeline to making the government your **customer**: once it has funded the R&D and sees a product hitting a use case, it can award multi-million-dollar contracts to buy the technology. It is the payoff of the ladder GR-2 and GR-3 describe, and its loss is why the grants slot ends on obligations rather than on the upside. |

**All four were dropped for pacing, not for quality, and that is a different list
from Foray #1's.** There, three of the four held-back segments were the weakest
available. Here the budget bit the *shortest* available, and short is not the same
as weak — FAM-3, YC-4 and CALM-2 are three of the ten best passages read in this
pass. **This is the first concrete cost the cut budget has imposed on content in
this project**, and it is worth the founders knowing: **D1 does not select against
filler, it selects against brevity.** If that is the wrong trade, the number to
move is N, not the segments.

---

## 8. Topic ids — three nodes, and why not more

The taxonomy's business branch offers `business/startups`, `business/founders`,
`business/management`, `business/careers`, `business/marketing`,
`business/non-profit`, and the economics branch offers `economics/markets` and
`economics/crypto`. Every segment carries the most specific node that fits **what
it teaches**, and root `business` is used nowhere — which is the whole point of
PR #175 and #198.

| Topic | Played | In pool | Which, and why |
|---|---|---|---|
| `economics/markets` | **11** | 12 | CALM-1, CALM-2, CALM-3, VD-1, VD-2, VD-3, SBA-1 to SBA-4, CF-1, CF-2. **Everything whose subject is how the capital provider works**: how a fund models its own returns, how a lender underwrites, how a bank differs from a private credit fund, what the SBA's rules are, and where retail money comes from. The provider's side of the table is a market, not a startup topic. |
| `business/startups` | **9** | 11 | BOOT-1, BOOT-2, YC-1 to YC-4, GR-1 to GR-4, VD-4. **Everything whose subject is what a company should do about money** — the choice of instrument, what a round buys, what a grant programme is for, and one case study of a company that used debt instead of equity. |
| `business/founders` | **2** | 3 | FAM-1, FAM-2, FAM-3. The friends-and-family material is about the founder's relationships and obligations — the odds he is asking family to accept, and what he owes people who cannot afford a follow-on — which is a founder question before it is a finance one. |

Three decisions worth naming rather than papering over:

- **The `business/startups` / `economics/markets` split is by whose behaviour is
  being explained, and it puts VD-4 on the other side from VD-1 to VD-3.** The
  three that explain lending sit on `economics/markets`; the Twitch case study,
  which is about what a company got out of it, sits on `business/startups`. That
  is a judgement, and a future re-topic may want the four together.
- **`business/management` was refused for SBA-3 and SBA-4**, where personal
  guarantees and equity injections are arguably an owner-operator's management
  problem. They are lending rules, and the witness is a lender.
- **`business/marketing` was considered for CF-2 and refused.** It is genuinely
  about audience-building, but its claim is *where capital comes from*, so it
  sits with the other provider-side segments.

Note the asymmetry with Foray #1, which used five nodes across 36 segments where
this uses three across 26. That is the taxonomy being thinner on this subject,
not a decision: there is no node for *financing instruments*, no node for
*lending*, and no node for *venture capital*, so eleven segments about how
capital providers behave all land on one node. **If a future pass adds
`economics/venture-and-private-capital` or similar, this batch is the one to
re-topic first.**

---

## 9. Honest limits

- **Nothing here has been heard.** Every number in this document is a property of
  timestamps and transcripts. Per `segment-length-rules.md` §10 that listening is
  the experiment that should move these numbers, and it has now not happened for
  two Forays running.
- **Foray #1 may carry the boundary bug described in §4**, and checking it is the
  highest-value thing anybody can do to that Foray before listening to it.
- **The equity slot is one lecture, and the Foray therefore never explains a
  priced round.** §3. The largest content gap, and a direct consequence of §6.1.
- **`base.en` mangles proper nouns in the five ASR episodes**, and in this subject
  that is worse than in a food history: *Solugen* becomes "Solugin", *Asher Bio*
  becomes "Azure Bio", *Clerky* becomes "Clerkey", *Reg A+* becomes **"reggae
  plus"**, *SBIR* becomes "Siver", *airball* becomes "earball", *OmniSync*
  appears as five different spellings, and the SBA debt-service-coverage ratio
  loses its decimal point to become "115". **Two anchors deliberately contain a
  garble** — CF-1's `start_anchor` carries "reggae plus" and SBA-2's carries
  "earball" — because an anchor is verbatim against *our* transcript, and
  correcting the spelling would make it unresolvable. Correct today, and it means
  neither anchor would match a publisher transcript if one ever appeared. An
  argument for re-transcribing on a larger model before this pool carries more
  weight.
- **The three publisher transcripts are a third party's timeline, and two of them
  are coarse.** The Bootstrapped Founder VTTs run 20–30 s per cue (74 cues over
  1,628 s on ep 309), so a boundary inside those episodes can only land on a cue
  edge. Run the Numbers' SRT is 2–4 s per cue, which is finer but still not word
  timing — see VD-3 in §4. **Eight of the 22 played segments are therefore placed
  to cue precision and fourteen to word precision, and no field in the data
  records which.**
- ~~**One cue gap in the Run the Numbers SRT went uninvestigated.**~~
  **Withdrawn — there is no gap.** An earlier draft of this section claimed no
  cue existed between 2,848.96 s and 2,886.76 s. There are **15**, and both
  quoted figures are cue *end* times that were misread as a span. The largest
  inter-cue gap anywhere in that SRT is **11.07 s** (after 1,673.57 s), and
  VD-4's in-point at 2,867.56 s is itself a cue start. Recorded rather than
  deleted because the claim was committed, and because it is a good example of
  the failure mode this document warns about elsewhere: a truncated console
  listing read as evidence of absence.
- **`rtn-venture-debt` is 18.2 % of the Foray's segments and 23.8 % of its
  runtime.** M4's cap is 25 %, so it passes, but one 56-minute interview supplying
  nearly a quarter of the Foray is more than any single source should carry. It
  happened because it is the only episode in the batch where a practitioner
  explains one instrument end to end.
- **The four Full Ratchet episodes cost about 2 h 57 m of CPU that produced no
  segments.** The lesson is cheap and worth writing down: **fetch one enclosure
  and listen to the first 30 seconds before transcribing any feed that measures
  non-zero.** The sourcing pass had the delta and tiered it PADDABLE; PADDABLE
  means *authorable*, not *playable*, and the transcription queue did not
  distinguish them. `foray2-asr-manifest.json` should carry a `playable_today`
  field, or the queue should sort on one.
- **The role field is still lost at merge**, so `data/segments.json` alone cannot
  answer L2/L3/D4. It is carried on each `data/forays.json` item and checked
  there, which covers the 22 played segments but not the four held back in §7 —
  and it means a second Foray reusing a segment has to restate the role.
- **`data/segments.json`'s `notes` field still names only batch 1.** The merge
  script rewrites `built_at` and the whole `provenance` block on every write
  (`provenance.last_batch_id` is now `seg-2026-08-16-foray2-capital-a`) but
  carries `notes` through untouched and has no flag to update it, and the file
  must not be hand-edited. Same finding as `grilling-foray.md` §9; it has now
  under-described the file twice.
- **`tools/foray/check-forays.test.mjs` had six assertions that were snapshots of
  a one-Foray world** and this change generalised them: the Foray count, the
  held-back-segment list, the mean-deviation warning count, the source count and
  the source-id list. They now pin per Foray rather than per file, and Foray #2's
  runtime, mean, D1 and D5 numbers are pinned the same way #1's are, the
  row-for-row §2 check is now table-driven over both curation docs rather than
  hardcoded to #1's, and three assertions whose names claimed file-wide scope
  (the label-to-segment derivation, label uniqueness, and the L2/L3 role bounds)
  now actually loop every Foray instead of only `forays[0]`. **But do
  not read that as "the next Foray will not touch this file."** Foray #3 still has
  to edit five things there — the id array in the two-Foray test, the
  held-back-segment list, the per-Foray mean-deviation warning counts, the
  source-id array, and one row in `RUNNING_ORDER_DOCS` — because those are
  per-Foray *facts*, not counts. What the
  generalisation removed is whole-file snapshots that broke for no reason; the
  deliberate per-Foray edits remain, and should.

---

## 10. Reproducing this

The batch and results files are deliberately **not committed**: the batch input
embeds the full transcript body, and this repo does not host source prose (see
`docs/DECISIONS.md`). Both are regenerable from the nine ASR JSON files plus the
three publisher transcript URLs recorded in `data/segment-sources.json`.

```
node tools/segments/merge-segments.mjs --batch <batch.json> --results <results.json>
node tools/segments/merge-segments.mjs --check
node tools/foray/check-forays.mjs
node tools/foray/verify-source-audio.mjs      # live 206 check, manual
```

**One thing to know before regenerating.** `findAnchorOccurrences()` returns cue
spans, not anchor spans (§4). A rebuild that takes its boundaries from that
helper will reproduce the mid-sentence out-points this batch fixed. Match the
anchor against the ASR word stream for the five `asr-local` episodes; for the
three `publisher` episodes there are no word timings and cue boundaries are
correct by necessity.

Re-running the same batch against the merged file writes nothing
("no change — segments file left untouched"), which is the idempotence property
`merge-segments.mjs` promises; it was verified for this batch.

---

## 11. Published, 2026-08-30 — the choice, and the four things still not true

The founder asked for one Foray to be brought across the line so that the Google
Play listing could describe Forays without describing a feature no visitor can
reach. Before this change all four were `draft`, and `player/foray-resolve.js`
makes a draft reachable only by asking for it by id — so a listing that mentioned
Forays would have been a misrepresentation. This is that change, and it is one
word in `data/forays.json` plus the deliberate edit it forces in
`tools/foray/check-forays.test.mjs`.

### 11a. Why this Foray and not one of the other three

All four pass `tools/foray/check-forays.mjs` with zero errors, and did so before
this change. The gate did not choose; these did.

| | `grilling-history-1` | `grilling-history-2` | **`capital-types-1`** | `geology-plates-1` |
|---|---|---|---|---|
| Runtime | 61.2 min | 21.9 min | **51.4 min** | 40.3 min |
| Segments | 32 | 10 | **22** | 19 |
| D1 | 6 of 6 — **on the line** | 6 of 8 | **5 of 6** | 6 of 8 |
| D5 IQR (floor 45 s) | 57.81 s | 60.10 s | **71.75 s — the most headroom** | 57.53 s |
| M4 worst episode | 21.9 % | 20.0 % | **23.8 %** | 18.4 % |
| Cross-episode seams | 16 of 31 | 5 of 9 | **10 of 21** | 15 of 18 |
| Cross-episode seams **per minute** | 0.261 | 0.228 | **0.195 — the lowest** | 0.372 |
| Its own record's verdict | superseded, drifted off plot | *"a playable fragment … not a draft of the product"* | **"Global rules missed: None"** | *"the rule that matters most to a listener is not met"* |

Three things decided it.

1. **It is the only one of the four whose own assembly record describes it as
   finished.** §0 above reports "Global rules missed: **None**". `grilling-history-2`'s
   record (`grilling-history-assembly.md` §1) says the opposite in as many words —
   34 of 40 spine beats are absent, Act IV is one segment out of fifteen beats, and
   the honest description is "a playable fragment, useful for testing the player …
   and not a draft of the product". `geology-plates-1`'s record (§0) says "the gate
   is green and the rule that matters most to a listener is not met".
   `grilling-history-1` is `superseded_by` and is the fixture 103 tests need.
2. **The seam argument does not favour the alternative once it is measured per
   minute.** `grilling-history-2` has fewer cross-episode seams in absolute terms
   (5 against 10) because it is less than half as long. Per minute of listening
   this Foray has the *fewest* of the four — 0.195 against 0.228 — and a listener
   experiences a rate, not a total. A caveat in the other direction, stated because
   it cuts against the choice: a cross-episode seam is where **#224** bites (see
   11c), and 10 chances to stall in one sitting is more than 5.
3. **It carries no editorial hazard.** `grilling-history-2`'s record names a
   specific one: `MOSS-1` ships the harmony version of the civic barbecue, and
   publishing it unbridged "ships the exact reading beat 23 exists to refute". That
   defect is about who cooked American barbecue and who was credited for it, it can
   only be fixed with narration that does not exist, and it is not what should be
   the first thing a stranger hears.

### 11b. Rule X1 is unmet, here and everywhere, and it needs money

**`segment-length-rules.md` X1 — "a cross-episode seam always carries narration",
tier A, gate "yes" — is unmet at all 10 of this Foray's cross-episode seams.** So
is **X2**, and so is **M6** wherever an elided span passes five minutes.

This is not specific to the Foray that was chosen. It is unmeetable by *any*
Foray in the repo today, and it cannot be fixed by re-ordering: a Foray drawing
on N episodes has at least N−1 cross-episode seams however it is arranged, and
this one is already close to that floor (10 against a floor of 7 for its eight
episodes). What X1 needs is narration **audio**, and there is none — zero
narration items exist in `data/forays.json`, `audio-cache/` is empty, and voicing
a script is ElevenLabs spend, which is a founder decision (CLAUDE.md decision
authority #3).

**Shipping unvoiced narration to satisfy X1 on paper was considered and
rejected**, on the reasoning already recorded at `geology-foray-assembly.md` §4:
`buildForayQueue` drops a narration item with no asset, but `resolveForay` still
returns it, so `app.js` renders each one as a near-blank "Can't play: narration
has no asset" row under a banner announcing the Foray is broken. That is a worse
listener experience in exchange for a rule no gate checks. Nothing in this change
authored a narration item.

**What a listener gets instead** is `player/seam-gap.js`'s 2.0 s beat at every
auto-advanced seam — an edit marked but not explained.

### 11c. Three other things that are still not true

- **Nobody has heard it.** `HUMAN-ACTIONS.md` #8 is still open, and it is the
  item that asks a founder to listen end to end and then rule on the cut budget.
  Publishing on the founder's instruction did not perform that listening, and §9
  above still stands: every number in this document is a property of timestamps.
  If it does not hold up in the ear, one word reverts it.
- **#224 is open, and this Foray is where it was seen.** `HUMAN-ACTIONS.md` #11
  records that on a real phone this Foray "stopped at a seam and then resumed to
  the wrong place". The resume half was #263, fixed in #266. The stop half is
  #224, the prefetch that would have fixed it never shipped, and that item says
  in terms: **"expect the stop to still happen on a phone."** It fires at a seam
  that pays a media load — which is a cross-episode seam, of which this Foray has
  ten.
- **The home-screen row has an unfixed cold-load race.** `app.js`'s `forayCards()`
  reads `window.ForayPlayer` synchronously, and its own comment says that while
  the list was empty for everyone that was the right trade but "when the first
  Foray is published, this wants the same await `renderForay` does". Nothing
  re-renders home on the `forayplayer:ready` event the module already dispatches,
  so a cold load that paints home before `player/client.js` has evaluated shows a
  home screen with this Foray missing, until the visitor navigates. In practice
  `init()` awaits eight JSON fetches before `route()` and the module graph starts
  earlier, so the module almost always wins — but "almost always" is the whole
  defect. **Deliberately not fixed here**: the two harnesses that mount `app.js`
  (`test/data-deletion.test.js`, `test/diagnostics-surface.test.js`) stub
  `window.addEventListener` as a no-op, so covering an event-driven re-render
  needs harness work that does not belong in a status flip.
