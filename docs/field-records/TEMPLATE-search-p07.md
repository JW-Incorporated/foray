# Search listening test (P-07) — <YYYY-MM-DD>, build <build number>

<!-- TEMPLATE. Copy this file to docs/field-records/<YYYY-MM-DD>-search-p07.md and fill
     it in. Do not edit this template itself. The card is docs/search-parity-plan.md
     P-07; the founder's steps are the HUMAN-ACTIONS.md item titled "Search listening
     test (P-07)". -->

One run of the P-07 listening test: five searches the founder chose, typed (not pasted)
into the Shows page search on a phone. The question is not a number. It is whether he
found the show he meant without thinking about it. Every **no** becomes a test case.

| | |
|---|---|
| Date and time | |
| Tester | |
| Phone and iOS version | |
| Build under test (the Copy header's `build=`) | |
| Network (Wi-Fi or cellular) | |

## The five searches

**Typed** is exactly what went into the box, typos included. **Position** is where the
intended show appeared in the list (1 = top), or `not found`. **Found it without
thinking?** is yes or no. A show that was there but needed a scroll or a second look
is a no.

| # | Typed | The show you meant | Position | Found it without thinking? | Note |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

## Playback diagnostics

Developer → Playback diagnostics → Copy, taken after the fifth search. Each search
writes one `search` line: `qLen` (the query's length, never its text), the local,
breadth (`net`), Apple directory (`dir`) and episode (`ep`) passes as `ms/hits`, the
playlist scan (`cta`), `painted`, `path` and `hidden`. Match each line to a row above
by its order and `qLen`.

```
<paste the Copy here>
```

## What each miss becomes

Filled in by the session that files this record. For each **no**, one case in
`tools/search-probe.mjs`:

- `PARITY_CASES` (`{ query, target }`) when the miss is about what the endpoint and
  the Apple directory return (a multi-word or person query, or a show missing from
  every pass);
- `SCAN_REACH_CASES` (`{ query, target }`) when the miss is about the on-device index
  pass ranking a one-word query's show too low.

| # | Typed (lowercase, trimmed) | Target title | List | Follow-up task or PR |
|---|---|---|---|---|
| | | | | |

## Verdict

One sentence: did search find what the founder meant without thinking, on this build?
