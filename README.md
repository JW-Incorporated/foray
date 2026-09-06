# 4a

Personal AI podcast curator, codenamed internally after its unit of listening:
a **foray** — a curated, cross-episode, continuously-playable audio session
stitched from a listener's subscribed shows. Long-term target: an iOS app per
the briefing package in `docs/brief/`. The project is well past the early
web-menu prototype phase: it now has a full playback engine, native app
shells, a backend curation pipeline, and a published foray a real visitor can
open and listen to end to end.

**Live:** https://jw-incorporated.github.io/foray/ (GitHub Pages, deploys
automatically on push to `main`; production preview also served from
`foray-web-seven.vercel.app`)

## Layout

- Root (`index.html`, `app.js`, `styles.css`, `search-engine.js`, `sw.js`) —
  the static web client: browse/search shows and episodes, and play forays.
  Deployed as-is with no build step (see `vercel.json` /
  `tools/web/prepare-dist.mjs`).
- `player/` — the playback/queue engine shared by the web client and the iOS
  app (ES module; mirrored by hand against `ios/ForayKit` so the two stay
  diffable — see `docs/mobile-shell.md`). Handles queueing, seam gaps between
  episodes, playback rate, resumable position, and progress tracking.
- `backend/` — Node.js + TypeScript curation core: feed ingest, episode
  identity/dedup, enrichment, cost-metered generation, and the engine that
  assembles a foray. Local-first (`npm install && npm test`, no cloud
  services or API keys required). See `backend/README.md`.
- `mobile/` — the shipping iOS and Android app shell (Capacitor wrapping the
  web player). Platform projects are generated on demand and not committed;
  see `mobile/README.md` and `docs/mobile-shell.md`.
- `ios/ForayKit` — a CI-tested pure-Swift reference package (state machine,
  Tier-1 voice-intent grammar). No longer the shipping app, but still live
  and exercised by CI; see `ios/README.md`.
- `data/` — taxonomy, catalog, foray, and session JSON (versioned).
- `tools/` — build, harvest, classify, transcribe, narrate, and refresh
  tooling that produces the data above and prepares the deployable site.
- `test/` — root-level app tests (naming, security, data deletion, topic
  integrity, diagnostics surface, etc.).
- `docs/` — `brief/` (original product briefing package), `adr/`
  (architecture decision records), `research/` (agent research outputs),
  `product/`, `curation/`, `legal/`, `ux/`, `store/`, plus operating and
  status docs (`DECISIONS.md`, `roles.md`, `mobile-shell.md`, and others).

## Current phase (2026-08)

The repo has a **published foray** (`capital-types-1`) that any visitor can
reach without a special URL — the first time any foray has been visible to a
general visitor rather than gated behind `?foray=`. Native iOS/Android shells
build in CI, and the backend curation pipeline, playback engine, and search
are all live and tested. See `STATE.md` for the current detailed status and
`docs/DECISIONS.md` for the history of how the project got here.

For contributor and AI-agent operating rules (decision authority, workflow,
review gates), read `CLAUDE.md` first.
