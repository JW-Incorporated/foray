# Share device check (PH2-06) — <YYYY-MM-DD>, build <build number>

<!-- TEMPLATE. Copy this file to docs/field-records/<YYYY-MM-DD>-share-shells.md and fill
     it in from the founder's comment on issue #71. Do not edit this template itself. The
     script is docs/share-device-check.md; the founder's step is the last step of
     HUMAN-ACTIONS #149 ("Also, while the phone is out"). -->

One run of `docs/share-device-check.md`: Share tapped on each surface, on the iPhone app
(TestFlight), iPhone Safari, a desktop browser with no share sheet and, if one was at hand,
Android Chrome. Each link was then opened cold in a fresh browser.

| | |
|---|---|
| Date | |
| Tester | |
| iPhone and iOS version | |
| Build under test (the Copy header's `build=`) | |
| Website deploy the cold opens hit (commit, at or after `292af726`) | |
| Desktop browser (step 8) | |
| Android phone and Chrome version (step 10), or "not run" | |

## Results

**Delivery** is `sheet`, `clipboard` ("Link copied" / "Link copied ✓"), `shown link`
("Copy this link" with a field), `cancelled`, or `nothing visible`. **URL** is exactly what
landed in Notes or Messages. **Cold-open result** is `opens` (the page, in a Private tab or
on a second device), `not found`, `empty`, or `not run`, plus `web` for the step 9 tap that
opened Safari rather than the app (expected until HUMAN-ACTIONS #145 / #146).

| step | surface | platform | delivery branch | URL | cold-open result | note shown beside the button |
|---|---|---|---|---|---|---|
| 1 | Foray `capital-types-1` | iPhone app | | | | |
| 1 | Foray `capital-types-1`, sheet closed | iPhone app | | — | — | |
| 2 | episode page | iPhone app | | | | |
| 3 | show page (hero) | iPhone app | | | | |
| 4 | Suggested card | iPhone app | | | | |
| 4 | playlist (that card's queue) | iPhone app | | | | |
| 5 | Now Playing, episode | iPhone app | | | | |
| 5 | Now Playing, Foray | iPhone app | | | | |
| 6 | episode of a searched show | iPhone app | | | | |
| 7 | Foray `capital-types-1` | iPhone Safari | | | | |
| 7 | episode page | iPhone Safari | | | | |
| 8 | Foray `capital-types-1` | desktop browser | | | | |
| 8 | Now Playing, episode | desktop browser | | | | |
| 9 | a link tapped in Notes, 4a installed | iPhone | — | | | |
| 10 | Foray `capital-types-1` | Android Chrome | | | | |
| 10 | episode page | Android Chrome | | | | |

## Playback diagnostics

Developer → Playback diagnostics → Copy, for any row that is not a pass.

```
<paste the Copy here>
```

## Follow-ups

Filled in by the session that files this record: one line per fail, with the task or PR
it became.

| step | what went wrong | follow-up task or PR |
|---|---|---|
| | | |
