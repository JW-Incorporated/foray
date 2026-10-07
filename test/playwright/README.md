# Playwright browser-integration suite (M4, kanban card t_504fd5fd)

Real-Chromium coverage for the four scenarios named in the M4 spec — module
load timeout, worker restart mid-request, partial cache population, offline
reload — on top of (never replacing) the fast `node:vm`-based
`test/sw-generation.test.js` suite one directory up.

## Why this directory is separate from `test/`

- `tools/ci/run-suites.mjs` and `test/suite-integrity.test.js` both discover
  suites by `*.test.{js,mjs,cjs}` under `player/`, `test/`, `tools/`
  (`SUITE_RE`/`SCANNED_DIRS` in both files). This directory's specs are named
  `*.spec.js` under `test/playwright/`, so neither scanner ever sees them —
  intentional: they need a real Chromium binary and take seconds per test,
  not milliseconds, and do not belong in the fast loop `npm test` runs on
  every suite floor check.
- It carries its own `package.json` and dependencies (`@playwright/test`),
  the same pattern `tools/corpus/` uses for its own dependency-carrying
  suites — the repo root stays dependency-free.

## Running locally

```sh
cd test/playwright
npm install
npx playwright install --with-deps chromium   # first time only
npm test
```

`npm test` runs `copy-sw.mjs` first (via the `pretest` script) to refresh
`fixture/sw.js` from the real, current `sw.js` — always the file under test,
never a hand-maintained copy. See `copy-sw.mjs`'s and `fixture/app.js`'s own
headers for why the fixture app is a deliberately minimal stand-in for the
real `app.js`, not a copy of it.

## First-run timing (#70)

`tests/first-run-timing.spec.js` is #70's "a first-time user reaches a
playable card in < 90 s, and in < 10 s if they skip everything" and "returning
users never see it again", recorded on every run instead of once by hand. It
serves the real site from `lib/site-server.mjs` (as `drawer-and-close.spec.js`
does) in a fresh Chromium profile and walks three paths:

1. **Skip** — the first-time sheet, "Skip for now", then a playable Home
   control (the Home ▶ or a card's ▶, visible and hit-testable at its centre)
   within 10 s of the page's first paint.
2. **Persona** — "Get started", one persona from the `data/personas.json` row
   lit, "Show my picks", then a playable control within 90 s of first paint.
3. **Returning** — a second browser context built from the first one's saved
   storage after a Skip never sees `#first-time-sheet` or `#intro-sheet`.

Both clock ends are the page's own `performance.now()`. Playwright presses
the buttons with no reading time, so the number is the app's share of the
budget (boot, data load, sheet, re-deal, repaint); the rest is the
listener's. The spec aborts every request that is not to its own site server,
logs no events and adds nothing to `app.js`. The mutation each test kills is
named in the spec's header.

**Evidence.** Each test attaches its screenshots and a
`first-run-timing.json` through `testInfo.attach`. They land in the HTML
report (`playwright-report/`, written when `CI` is set). Each timed test also
prints one `[first-run-timing] {...}` line with first paint, sheet shown,
playable and elapsed milliseconds, so the numbers can be read in the job log.
The CI job does not upload `playwright-report/` as an artifact yet, so until
it does, the log line is the evidence a reviewer can link to. Run locally to
see the screenshots: `npx playwright test tests/first-run-timing.spec.js --reporter=html`,
then `npx playwright show-report`.

**Load sensitivity.** The skip bound is real time on a shared machine. A
single-worker local run measured 2-8 s first paint to playable, and most of
that was the boot before the sheet appears. A box saturated by other work can
push it toward the 10 s bound. The bound is #70's acceptance number, so it is
not raised here. A red skip test with a large `sheetShownMs` means the boot was
slow, and a large gap between `sheetShownMs` and `playableMs` means Skip itself
was slow.

## CI

Wired into `.github/workflows/ci.yml` as its own `playwright` job — see that
file's header comment for why it starts **advisory-only** (non-required) for
one cycle rather than blocking `protect-main` on day one.
