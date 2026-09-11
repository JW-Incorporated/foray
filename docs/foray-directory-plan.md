# Deck: the Foray directory — new Forays reach the app without a release

**Status:** plan to cut into kanban cards, written 2026-09-10 by the founder's Claude
session from Wyatt's brief below. Cards are **FD-**. Hermes is on
`docs/bundled-voice-plan.md` and `docs/search-plan.md`; this deck is executed by the
overlord's agents unless the founders reassign it. Companion to
`docs/curation/foray-to-spec-roadmap.md`, whose card **G-22 ("store build on merge")
this deck supersedes** — a build per Foray was the wrong fix.

The rule that governs every card, from `CLAUDE.md`: **measured beats inferred.** Every
number is tagged.

---

## 0. The brief, verbatim

Wyatt, 2026-09-10:

> "Why is a release required every time a new foray is published? Shouldn't that be
> accessed the same way shows and playlists are accessed? I would think the 'look at
> some separate directory for all shows / playlists / forays' is built into the app,
> so that whenever that directory is updated the app gets to see the new content
> without needing an update."

---

## 1. What is measured (2026-09-10, `main` @ #583)

- **The app reads exactly three files for Forays**, at boot, with the rest of its
  data: `app.js:7337–7339` — `fetchJson("data/forays.json")`,
  `fetchJson("data/segments.json")`, `fetchJson("data/segment-sources.json")`
  (requirements §6.6: "the order lives in forays.json, the timestamps in
  segments.json, the audio in segment-sources.json"). Sizes on main today: 53.8 KB,
  173.5 KB, 58.4 KB [measured].
- **On the web this is already live.** The PWA fetches `data/*.json` from the deployed
  site; `sw.js` serves `data/` network-first, tagged with the deploy's `deployId`
  from `deploy-manifest.json`, and refuses a torn deploy visibly (`stale-shell`)
  [measured: `sw.js` header, lines 4–77]. A merge to `main` is enough for a browser.
- **In the phone app it is bundled.** `tools/mobile/prepare-webdir.mjs` copies
  `data/forays.json` whole (`COPIED_WHOLE`, line ~1195) and slices
  `data/segments.json` / `data/segment-sources.json` against it (lines 175–176), and
  the Capacitor shell loads `capacitor://localhost/...` — its own package. New data
  means a new package [measured]. That is why the 2026-09-10 Foray needed release
  build 2026091009.
- **Shows do not work this way.** A show search calls the live API
  (`api/shows/search.ts`); the breadth catalogue reaches the API through
  `shows-index-pointer.json` (S-04's pointer → versioned index). The phone sees new
  shows without an update [measured: `api/`, search plan §1].
- **The shell may talk to the live site.** `index.html` CSP:
  `connect-src 'self' https://qjdllvqdcgacvujhclny.supabase.co https://foray-web-seven.vercel.app`
  and `media-src https:` [measured]. A JSON fetch from the Vercel origin is
  admissible today; nothing in `index.html` has to change for FD-03.
- **Why it was bundled:** the original audio brief — "everything local before play;
  the player should essentially never stream" (`docs/brief/04_VOICE_AUDIO_SPEC.md`)
  — written before generated Forays existed. The intent (a Foray you have opened
  keeps working offline) is kept below; "the package is the catalogue" is dropped.

---

## 2. The design in one paragraph

**The Foray directory is the live site's three data files, versioned by the deploy
id they shipped with.** The phone app fetches a small pointer
(`data/forays-directory.json`: deploy id, built-at, the three file paths, sizes,
sha256) from the live origin at boot and on return to foreground, compares it with
the version it holds (cache first, then the bundle), and when the pointer is newer it
fetches the three files, validates them with the same resolver the player already
uses, swaps them in, and caches them durably. First paint never waits on the network;
offline the app plays what it cached, and a fresh install plays the bundle. Publishing
a Foray becomes: merge to `main` → Vercel deploys → the pointer changes → every phone
picks it up on next launch. No store build.

Why not a separate object store: the files already deploy atomically with a manifest
and an id (the `sw.js` torn-deploy machinery), the sizes are a few hundred KB, and the
generation publish path already writes exactly these three files (requirements §6.5
step 4a). A second store would be a second thing to keep in step.

---

## 3. Cards

### FD-01 · Instrument how the shell loads its data today — **S** — agent
**Ask.** A `diagnostics` entry at boot recording, per data file, whether it came from
the bundle, the cache, or the network, with the deploy id it carries; the web's
`stale-shell` path records the same. This is the before-number every later card cites.
**Owned.** `app.js` (boot), `player/diagnostic-log.js`, `test/diagnostics-surface.test.js`.
**Done when.** A Playback-diagnostics copy from a phone names the source of
`forays.json`; the test proves the entry is written (mutation: drop it → red).
**Human gate.** none.

### FD-02 · The pointer and the versioned files — **S** — agent (tools/ci lane → founder label)
**Ask.** `tools/ci/generate-manifest.mjs` (which already stamps `deploy_id` into
`deploy-manifest.json` and `sw.js`) also writes `data/forays-directory.json`:
`{ version: <deploy_id>, built_at, files: { forays, segments, sources }, bytes,
sha256 }` — and every `data/*.json` the app reads stays where it is. Served
`Cache-Control: no-cache` for the pointer (same as `data/` today), long-lived for the
files (they are immutable per deploy id and the sw already pins them).
**Owned.** `tools/ci/generate-manifest.mjs` (+ `--check`), `deploy-manifest.json`,
`vercel.json` headers, `tools/ci/*.test.mjs`.
**Done when.** `--check` fails if the pointer's sha256 does not match the files; the
pointer is in the deploy manifest; a mutation that stales the pointer turns the check
red. **Human gate.** `tools/ci/` is a governed path — the overlord labels.

### FD-03 · The shell reads the directory, bundle as fallback — **M** — agent (design comment first)
**Ask.** In the Capacitor shell (and harmlessly in the PWA, where the sw already does
this): at boot, paint from the cached directory if any, else from the bundle; in the
background fetch the pointer from the live origin with a short timeout; if
`version` is newer, fetch the three files, run them through `player/foray-resolve.js`
(the join that already refuses a segment whose source or audio is missing), and only
then swap them into `state` and re-render the Foray surfaces; store the set in the
durable store (IndexedDB tier, keyed by version). Repeat on `visibilitychange` →
visible, throttled. Never block first paint; never swap in a set that fails
validation; never drop a cached set for a network error.
**Owned.** `app.js` (boot sequence around line 7317–7345, the `state.*` for the three
files), `player/foray-resolve.js` (validation entry point only), `player/durable-store.js`
/ `player/idb-tier.js` (the cache), `test/foray-directory.test.js` (new, floored),
`player/foray-resolve.test.js`.
**Done when.** With a fake fetch returning a newer pointer + valid files, the app
renders the new Foray without reload; with an invalid set it keeps the old one and
logs why; with the network down it boots from cache, then bundle; mutations named
in the test header (skip validation → red; block paint on fetch → red).
**Dependencies.** FD-02 for the pointer shape (a fixture is enough to start).
**Human gate.** none for code; **the privacy policy** — see FD-06.

### FD-04 · The bundle becomes the offline seed, not the catalogue — **S** — agent
**Ask.** `prepare-webdir.mjs` keeps copying the three files (a fresh install must
play offline), and its comment header says why they are now a seed; `#327`'s
unbounded-pool concern is answered by the same mechanism — the bundle can carry a
capped slice while the directory carries everything.
**Owned.** `tools/mobile/prepare-webdir.mjs` and its test.
**Done when.** The bundle test asserts the seed set is a subset of the directory's
files and names the cap; the shell boots with an empty seed too.

### FD-05 · Playback state survives a directory change — **S** — agent
**Ask.** Resume points (`player/foray-progress.js`) key on Foray id and item id, both
stable across versions; verify a version swap mid-session does not move the playhead,
does not drop the queue for a Foray that still exists, and marks a Foray that
disappeared as `DRIFT_DROPPED` rather than crashing. The seam prefetch (#224) must
not cache audio for a set that was never validated.
**Owned.** `player/foray-progress.js`, `player/queue-manager.js`, their tests.
**Done when.** Tests for the three cases above, each with a mutation.

### FD-06 · Records, and the privacy sentence — **S** — agent + **founder gate**
**Ask.** `docs/DECISIONS.md`: "the app reads the Foray directory from the live origin;
the package carries an offline seed" (reverses the bundling half of
`04_VOICE_AUDIO_SPEC.md`, keeps its offline intent). `docs/legal/privacy-policy.md`
already discloses calls to our own origin for search; add the directory fetch to the
same sentence, and check it against HUMAN-ACTIONS #38's "absolute no-transmission"
item and the S-07 privacy conditional — a boot-time fetch of static JSON from our own
origin carries no query, which is the case both were written to allow, but the
founders own that sentence. `STATE.md` entry; roadmap G-22 marked superseded.
**Human gate.** DECISIONS (founder-approved lane; overlord labels) and the privacy
sentence (Wyatt reads it).

### FD-07 · The publish path ends at `main` — **S** — overlord (backend lane)
**Ask.** `backend/src/cli/publishForay.ts` cuts its branch from `origin/main`, not
the checkout HEAD (F-75); `mintedSegmentRow` writes the four fields the pool gate
requires (F-78: `why` ≤ 18 words from the beat claim, `transcript_source`,
`dai_suspected`, `batch_id`); the PR body says "phones pick this up on next launch
after the deploy". `automerge-nightly.yml` merges a green `data/`-only Foray PR
(roadmap G-21b); Vercel deploys `main`; nothing else.
**Done when.** The next generated Foray reaches a phone with no store build and no
label applied by a person, and `report.json` records the deploy id it shipped in.

---

## 4. Order and estimate

FD-01 and FD-02 first (a day, parallel); FD-03 is the card (two days, design comment
first); FD-04/05 alongside it; FD-06 with the first PR that touches the policy; FD-07
on the generation branch as it lands on `main`. Everything is inside the auto-merge
lanes except FD-02 (`tools/ci/`), FD-06 (DECISIONS) and FD-07 (`backend/`), which
the overlord labels under standing approval.

## 5. Rules for the agents

One PR per card, tests green (`npm test` at the root, `node tools/ci/run-suites.mjs
--skip-install` on Windows), CRLF stays CRLF, no `format:write` repo-wide, never
`git worktree remove` a worktree whose `node_modules` is a junction into the main
checkout (it empties the target). Do not apply `founder-approved`. Cite the card id in
the PR title.
