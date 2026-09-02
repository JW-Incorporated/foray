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

## CI

Wired into `.github/workflows/ci.yml` as its own `playwright` job — see that
file's header comment for why it starts **advisory-only** (non-required) for
one cycle rather than blocking `protect-main` on day one.
