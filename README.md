# 4a

Personal AI podcast curator. Long-term target: iOS app per the briefing package in `docs/brief/`. Current phase: a deployed static web menu that tests curation quality (the M2 gate) before any audio engineering.

**Live:** https://wjduvall-cmd.github.io/foray/ (deploys automatically on push to `main`)

## Layout

- `site/` — the static 4-card session menu (GitHub Pages)
- `data/` — taxonomy and session JSON (versioned; session format v1)
- `scripts/` — session build tooling (curation baked at build time for now)
- `docs/brief/` — original product briefing package (master prompt, architecture, curation spec, corner cases, roadmap)
- `docs/research/` — agent research outputs (curation practices, candidate episodes)
- `docs/adr/` — architecture decision records

## Web-test phase (2026-07)

The site presents a 4-archetype menu (Deep-learn / Stretch / Narrative / Comfort) with per-card why-lines and external playback links (Apple Podcasts, Overcast, pod.link). No audio is hosted or proxied — links hand off to the listener's podcast app, consistent with the "legally boring podcast client" constraint.
