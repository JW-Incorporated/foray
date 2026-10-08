# Dial: build notes

> **Owner decision (final, 2026-10-06 20:55 PDT): display and title face = Big
> Shoulders**, with the Big Shoulders review-candidate values in §1. Drop
> Anybody, Dela Gothic One and Archivo (fonts, tokens, @font-face) and the
> review-only font switcher (`prototype/font-preview.*`). Body stays Bricolage.
> Shoot with `--scheme light` (cream is primary; dark is a secondary check).

Everything a front-end builder needs to reproduce the "Dial" direction
without the art director. Read `DIRECTION.md` first for the point of view;
this file is the measurements. Where a number here and a sentence there
disagree, this file wins.

Conventions: all sizes in px are design sizes at 1x; author type and
spacing in `rem` (16px base) so the OS text scale works. 4px base unit.
Every colour is a `:root` token; every duration and easing is a token;
nothing is hard-coded in a component. Strict CSP: no inline `style=`, no
inline scripts, fonts self-hosted under `fonts/`. Every interpolation via
`esc()`, every URL via `safeUrl()`. Storage keys keep the `cp_` prefix.

Feasibility tags: **Web** = plain WebView CSS/JS; **Web+** = an existing
Capacitor plugin; **Native** = out of scope unless the owner asks.

---

## 1. Fonts

Self-hosted variable WOFF2, Latin subset, `font-display: swap`:

| Family | Role | File | Axes | Licence |
|---|---|---|---|---|
| Anybody (provisional, round 2) | display, title, heading | `fonts/anybody-latin.woff2` | wght 100-900, wdth 50-150 | OFL 1.1 |
| Bricolage Grotesque | text (body, rows, labels, keycaps, chips, tags) | `fonts/bricolage-grotesque-latin.woff2` | wght 200-800, wdth 75-100, opsz 12-96 | OFL 1.1 |
| Azeret Mono | readouts | `fonts/azeret-mono-latin.woff2` | wght 100-900 | OFL 1.1 |

All three are on Google Fonts under the OFL; download the variable files
(Latin subset; the prototype's copies are the Google Fonts `/* latin */`
slices) and host them locally (the CSP is `font-src 'self'`). Sizes as
shipped: Anybody 57 KB, Bricolage 132 KB, Azeret 26 KB, about 215 KB. To
get under 160 KB at build time, instance Bricolage to the only values
the app uses (wght 500-700, wdth 100, opsz at text sizes; it is never set
above 700 or below 100% width any more) and Anybody to wdth 88-112 /
wght 600-700 (the screen titles use 110, 2.1); `fonttools
varLib.instancer` does both and the text roles do not change.

**2026-10-06, round 1.** Archivo replaced Bricolage for the three large
roles after the owner's "cartoonish" verdict on the r3 headers
(`DIRECTION.md`, Typography). **Round 2, same day:** the owner found
Archivo, Plex and Instrument "a little plain" and asked for a fun face
that is not Bricolage; Anybody is the provisional display face, Archivo is
his named fallback, and the other two picks are review candidates (1.1).
Bricolage stays for every text-size role. No text or display role uses
weight 800 any more (the mono station code under the needle keeps its
800, 3.6); width 90 is back, but on Anybody, whose width axis is its
character rather than a squeeze.

```css
@font-face { font-family: "Anybody"; src: url(fonts/anybody-latin.woff2) format("woff2"); font-weight: 100 900; font-stretch: 50% 150%; font-display: swap; }
@font-face { font-family: "Bricolage"; src: url(fonts/bricolage-grotesque-latin.woff2) format("woff2"); font-weight: 200 800; font-stretch: 75% 100%; font-display: swap; }
@font-face { font-family: "Azeret"; src: url(fonts/azeret-mono-latin.woff2) format("woff2"); font-weight: 100 900; font-display: swap; }
```

Fallback stacks: `"Anybody", system-ui, sans-serif`, `"Bricolage",
system-ui, sans-serif` and `"Azeret", ui-monospace, monospace`. The
`font-stretch` range in each `@font-face` must cover the widths the tokens
ask for, or the browser silently renders width 100.

### 1.1 Review candidates for the display face (round 2)

Thirty-seven OFL families went onto the real strings
(`data-local/redesign/font-trial-r2/`, gitignored); the three that
survived went onto the real screens in both schemes at 375/393/412
(`data-local/redesign/shots/tactile/r6-fonts/<face>/`, contact sheets
first). Each is a drop-in: swap the file and these token values, nothing
else moves. All are OFL on Google Fonts. The prototype carries all four
behind the review switcher (`?font=anybody|bigshoulders|dela|archivo`).

| Candidate | File (Google Fonts, Latin) | `--font-display` | display (xl and 32) | title 24 | heading 20 | Character and measurements |
|---|---|---|---|---|---|---|
| **Anybody** (provisional) | `Anybody:wdth,wght@50..150,100..900` | `"Anybody"` | 700 / 90% / -0.01em; **screen titles 110% / 0.005em** (r7, 2.1) | 650 / 92% / -0.005em | 650 / 94% / 0 | 1970s wide American grotesque; hi-fi fascia, cassette label. Hero 3/3/3 lines, bottom 537/537/542; Now Playing 2, onboarding 2, Foray detail 4, nothing truncates or clips; holds in Bakelite (`r6-fonts/_ad/dark-anybody__*`). Screen titles one line at 375: "Today" 143px, "Find" 96 |
| Big Shoulders | `Big+Shoulders:opsz,wght@10..72,100..900` | `"BigShoulders"` | **r7:** 800 / 100% / 0.005em, `--t-display-xl` 2.75rem/3rem, `--t-display` 2.25rem/2.5rem, hero clamp unchanged at line-height 1.2 | **r7:** 750 / 100% / 0.01em, `--t-title` 1.625rem/1.875rem | **r7:** 750 / 100% / 0.01em, `--t-heading` 1.375rem/1.625rem | Chicago sign-painter's gothic, condensed, crafted; opsz follows font-size (live in the shipped file; no `font-stretch` axis, so width tokens read 100%). At the r6 sizes (750/700/700, 40/32/24/20) it carried a third less mass than Anybody ("Today" 88px to 112) and its oversized font ascent dropped the Foray detail descender out of the line box; r7 sizes it up and centres the ink (`ascent-override: 84%; descent-override: 24%`, 2.1). Measured r7 at 375/393/412: "Today" 98.5px, hero 3/2/2 lines (bottom 547/514/517), Now Playing 2 at 26px, Foray detail 4/3/3 at 44, nothing clipped. 800 is a switcher-only exception to the 700 ceiling (that ceiling was Bricolage's curl, which this face lacks); if the owner picks it, rewrite the ceiling for it. Nearest the "plain" edge; can read sporty |
| Dela Gothic One | `Dela+Gothic+One` | `"Dela"` | 400 / 100% / **0** (r7; was -0.01em), `--t-display-xl` 2.25rem/**2.625rem**, `--t-display` 1.75rem/**2.0625rem**, hero `clamp(1.5rem, 6.4vw, 1.75rem)` at line-height **1.16** | 400 / 100% / 0, `--t-title` 1.375rem/1.625rem | 400 / 100% / 0, `--t-heading` 1.125rem/1.375rem | 1970s Japanese hi-fi lettering, one black weight, the loudest fun. At the Anybody scale it overflows the hero clamp at every width and puts Now Playing on 3 lines, hence the smaller scale. Its font ascent is 1.17em against 0.85em of ink, so every clamped title clipped its descenders 6px in r6: `ascent-override: 84%; descent-override: 28%` (2.1). r7 measured at 375/393/412: hero 3 lines (gap 26/30/35, bottom 523/528/532), Foray detail 4 (gap 49/67/86), Now Playing 2 (fits by 0.8px at 375), nothing clipped |
| Archivo (owner's fallback) | `Archivo:wdth,wght@62..125,100..900` | `"Archivo"` | 700 / 92% / -0.02em | 650 / 94% / -0.015em | 650 / 96% / -0.01em | r5 values, unchanged: hero 3/2/2, bottom 537/506/509, Foray detail 3, nothing clips (`critique-r5.md`); the screen-title width in 2.1 does not apply to it |

Line heights are unchanged for Anybody and Archivo (44 / 36 / 28 / 24);
Big Shoulders takes its own in r7 (44 / 40 / 28 / 24 at 44 / 36 / 26 /
22px). IBM Plex Sans and Instrument Sans (round 1) are out of the
prototype and this table; the owner called them plain alongside Archivo.
The switcher ships in the owner's review build only; Phase 3 removes it
and the files of whichever faces the owner did not pick. Round-7 values
above (`critique-r6.md` P1) are applied in the prototype and re-measured
on the shipped files in `critique-r7.md`: every number in the table holds,
120 clamp-strip diffs are clean in all four faces at 375/393/412, and the
r7 renders (`data-local/redesign/shots/tactile/r7/`, `r7-fonts/`) show
this state. **The type is closed from the art director's side**; the
owner's pick at the switcher decides which P3 item in `critique-r7.md`
Phase 3 applies.

## 2. CSS tokens

### 2.1 Type

```css
:root {
  --font-display: "Anybody", system-ui, sans-serif;   /* display, title, heading */
  --font-text:    "Bricolage", system-ui, sans-serif; /* everything else */
  --font-mono:    "Azeret", ui-monospace, monospace;  /* readouts */

  /* size / line-height / weight / width / tracking */
  --t-display-xl: 2.5rem;   --lh-display-xl: 2.75rem; --w-display: 700; --wd-display: 90%; --tracking-display: -0.01em;
  --t-display:    2rem;     --lh-display:    2.25rem; /* same weight, width and tracking as display-xl */
  --t-title:      1.5rem;   --lh-title:      1.75rem; --w-title:   650; --wd-title:   92%; --tracking-title:   -0.005em;
  --t-heading:    1.25rem;  --lh-heading:    1.5rem;  --w-heading: 650; --wd-heading: 94%; --tracking-heading: 0;
  --t-body-lg:    1.0625rem;--lh-body-lg:    1.5rem;  --w-body:    500;
  --t-body:       0.9375rem;--lh-body:       1.3125rem;
  --t-label:      0.8125rem;--lh-label:      1rem;    --w-label:   700;
  --t-micro:      0.75rem;  --lh-micro:      1rem;    --w-micro:   600;
  --t-readout-lg: 1.75rem;  --lh-readout-lg: 2rem;    --w-readout: 500;
  --t-readout:    0.8125rem;--lh-readout:    1rem;

  --tracking-label: 0;

  /* r7 (critique-r6 P1.1) */
  --wd-screen: 110%; --tracking-screen: 0.005em;  /* the three one-word screen titles only */
}
.top__title .display-xl { font-stretch: var(--wd-screen); letter-spacing: var(--tracking-screen); }

/* r7 (critique-r6 P1.2), review candidates only: centre the ink inside the line box */
@font-face { font-family: "Dela"; src: url(fonts/dela-gothic-one-latin.woff2) format("woff2"); font-weight: 400; font-display: swap; ascent-override: 84%; descent-override: 28%; }
@font-face { font-family: "BigShoulders"; src: url(fonts/big-shoulders-latin.woff2) format("woff2"); font-weight: 100 900; font-display: swap; ascent-override: 84%; descent-override: 24%; }
```

**Screen titles run wide (r7).** "Today", "Find" and "Yours" are the only
display-xl strings that are one word with room beside the knob, and they
take Anybody at width 110 (the extended fascia cut; measured one line at
375: "Today" 143px, "Find" 96px). The Foray detail `h1.display-xl.clamp4`
is a sentence and stays at `--wd-display` 90: at 100 the fixture hero
already costs a line. In the alternates' switcher blocks `--wd-screen`
is set to that face's display width (Big Shoulders and Dela have no
`wdth`; Archivo keeps 92).

**Clamped titles never clip ink (r7).** Dela's font ascent is 1.17em
against 0.85em of ink and Big Shoulders' 0.98em against 0.82em, so the
baseline sits low in the line box and `overflow: hidden` on a clamped
title cut the descenders of "history" (6px at Dela 36/40, 2–5px at Big
Shoulders 40–44/44). Padding the clamp box paints the next line's cap
tops when a title truncates, and the line height Dela would need (1.44em)
breaks the ≤ 540 hero rule, so the fix is the metric override above plus
the line heights in 1.1; measured clean top and bottom on every clamped
title at 375/393/412. **WebKit does not implement `ascent-override` /
`descent-override`** (Chromium 87+ and Firefox 89+ do): the fix holds on
the owner's Android phone and in the renders, not on the iPhone founder's
build. If the owner picks either face, Phase 3 re-cuts the file's
`hhea`/`OS/2` ascent and descent to those values with `fonttools` and
renames the family per the OFL's Reserved Font Name clause. Anybody
(content area 1.05em) and Archivo (1.075em) need nothing.

Role classes (`.display-xl`, `.display`, `.title`, `.heading`) set
`font-family: var(--font-display)` plus their own weight, width and
tracking tokens; the large Find tile name (`.tile--l .tile__name`) takes the
title role, every other tile name (`.tile__name`) the heading role at 17/24
(r4: the l tile was Archivo and the m/s tiles Bricolage 17/700, two faces
40px apart on one screen), and the onboarding brand mark the heading role.
Display roles that carry a sentence (`.hero .display`, `.onb__copy .display`,
the Foray detail `h1.clamp4`, `.np__text .title`) set `text-wrap: balance`
(r4: "Podcasts, stitched around / you." left its last word alone at 393
and 412; balance never adds a line, so the hero height rule is safe). `body` is
`500 var(--t-body)/var(--lh-body) var(--font-text)` at width 100%, and no
text-size role ever changes family or width. The display and title weights
(700, 650) are the heaviest any text or display role gets: Bricolage's 800
is retired, since 800 with that face's curled `y` and hooked `g` was the
"cartoonish" read. Width 90 is back on Anybody only; its width axis runs
50-150 and 90 is a normal cut of it, not a squeeze.
Readouts (`--font-mono`) always set `font-variant-numeric: tabular-nums`.
No `text-transform: uppercase` anywhere. Titles clamp with `-webkit-line-clamp`
(2 lines in rows, 3 in Now Playing, 4 on Foray detail), never a fixed height.
The hero title's `clamp(1.75rem, 7.2vw, 2rem)` (4.1) is unchanged; in
Anybody the r3 fixture title takes three lines at 375, 393 and 412, and
since the title clamps at three lines the hero bottom is bounded at 537px
at 393 (542 at 412), inside the ≤ 540px rule with 3px to spare. If a build
needs that margin back, `--wd-display: 88%` is the relief valve; below
88 Anybody starts losing the width that is its character. (Archivo's
two-line hero sat at 506.)

### 2.2 Colour

Two schemes. Default follows `prefers-color-scheme`; `html[data-theme="light"]`
and `html[data-theme="dark"]` override it (the setting lives under
`cp_theme`). Declare `color-scheme: light dark` on `:root`.

```css
:root {
  /* Cream (light) */
  --paper:      #F7F0E4;
  --paper-2:    #EFE6D6;   /* section bands, inset wells */
  --card:       #FFFDF8;
  --ink:        #1E1A16;
  --ink-2:      #5C544B;
  --ink-3:      #6F675D;
  --line:       #E2D8C6;   /* 1px contact lines only */
  --rubber:     #2A2520;   /* keycap body for "black key" variants */
  --rubber-lip: #15110E;
  --on-rubber:  #F7F0E4;

  --persimmon:      #C93F14;   /* listener's own */
  --persimmon-lip:  #8E2B0C;
  --persimmon-soft: #F6D9CD;   /* tints, selected rows */
  --ultramarine:      #2B45C8; /* what 4a authored */
  --ultramarine-lip:  #1C2F8F;
  --ultramarine-soft: #D9DEF7;
  --good:       #1F7A3E;       /* downloaded, offline-ready */
  --warn:       #9A5B00;       /* needs a connection */

  --on-persimmon:   #FFFFFF;
  --on-ultramarine: #FFFFFF;

  /* segment enamels: stable per show, index = hash(show id) % 8 */
  --seg-c0: #1E8C7E;  /* teal */
  --seg-c1: #C93F14;  /* persimmon */
  --seg-c2: #2B45C8;  /* ultramarine */
  --seg-c3: #B8860B;  /* mustard */
  --seg-c4: #7A3E8F;  /* plum */
  --seg-c5: #4F7F2E;  /* moss */
  --seg-c6: #2E7FB8;  /* sky */
  --seg-c7: #B5406E;  /* rose */
  --seg-narration: var(--ultramarine);

  --scrim-np: rgba(247, 240, 228, 0.78); /* paper scrim over artwork tint */
}

@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* Bakelite */
  --paper:      #17130F;
  --paper-2:    #1F1A15;
  --card:       #241E18;
  --ink:        #F4ECDF;
  --ink-2:      #BDB2A3;
  --ink-3:      #948979;
  --line:       #332B24;
  --rubber:     #3A332C;   /* r2: #2E2822 sank into the sheet under the tint */
  --rubber-lip: #120E0B;
  --on-rubber:  #F4ECDF;   /* paper is dark here; rubber text follows the light ink */

  --persimmon:      #FF6A3A;
  --persimmon-lip:  #B8431E;
  --persimmon-soft: #4A2A1E;
  --ultramarine:      #8EA0FF;
  --ultramarine-lip:  #5566C8;
  --ultramarine-soft: #26305A;
  --good:       #5CC57A;
  --warn:       #E0A14A;

  --on-persimmon:   #1E1A16;
  --on-ultramarine: #1E1A16;

  --seg-c0: #3FB9A8; --seg-c1: #FF6A3A; --seg-c2: #8EA0FF; --seg-c3: #E0B33A;
  --seg-c4: #B57BCB; --seg-c5: #7FB85A; --seg-c6: #5FAEE6; --seg-c7: #E06A98;

  --scrim-np: rgba(23, 19, 15, 0.72);
}}
:root[data-theme="dark"] { /* identical block to the dark branch above */ }
```

Contrast table (WCAG, rounded). Pairs marked UI are used only for
components, large text (≥ 24px / ≥ 19px bold) or icons, where 3:1 applies.

| Pair | Cream | Bakelite |
|---|---|---|
| ink on paper | 15.2:1 | 16.5:1 |
| ink on card | 16.4:1 | 14.1:1 |
| ink-2 on paper | 6.3:1 | 9.4:1 |
| ink-3 on paper | 4.8:1 | 5.3:1 |
| on-rubber on rubber | 13.4:1 | 10.6:1 |
| on-persimmon on persimmon | 5.0:1 | 5.9:1 |
| on-ultramarine on ultramarine | 7.5:1 | 6.9:1 |
| persimmon on paper (UI) | 4.4:1 | 6.4:1 |
| ultramarine on paper | 6.6:1 | 7.5:1 |
| good on paper | 4.8:1 | 9.8:1 |
| warn on paper | 4.9:1 | 7.9:1 |
| seg-c0..7 on paper-2 (UI, bars) | ≥ 3.0:1 | ≥ 3.5:1 |

Rules:
- Persimmon and ultramarine never appear on the same control. A screen
  region (one card, one row, one toolbar) carries at most one of them.
- Text on an accent is always `--on-*`, never ink-2.
- Colour never carries meaning alone: played, queued, downloaded, current,
  narration and stretch each have an icon or a label as well.
- Artwork-tinted surfaces (Now Playing) must pass the same table against
  the computed tint; if the runtime check fails, fall back to `--paper`.

### 2.3 Space, radius, size

```css
:root {
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px;

  --gutter: 16px;            /* all three viewports */
  --gap: 12px;

  --r-sm: 8px;    /* chips, tags, small keycaps */
  --r-md: 14px;   /* cards, keycaps, rows */
  --r-lg: 22px;   /* hero cards, sheets, deck */
  --r-pill: 999px;

  --tap: 44px;
  --key: 48px;  --key-lg: 56px;  --key-xl: 80px;  --key-glance: 96px;
  --row-show: 56px; --row-queue: 64px; --row-episode: 72px;
  --art-row: 56px; --art-queue: 48px; --art-mini: 44px; --art-disc: 40px;
  --deck-h: 64px;  --mini-h: 64px;

  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
}
```

### 2.4 Material and elevation

```css
:root {
  --shadow-card:
    0 1px 0 rgba(30, 26, 22, 0.06),
    0 8px 24px -12px rgba(30, 26, 22, 0.25);
  --shadow-deck:
    0 1px 0 rgba(30, 26, 22, 0.08),
    0 16px 40px -16px rgba(30, 26, 22, 0.35);
  --well-inset:
    inset 0 2px 4px rgba(30, 26, 22, 0.12),
    inset 0 0 0 1px rgba(30, 26, 22, 0.06);
  --lip: 3px;                /* keycap lower lip at rest */
  --lip-pressed: 1px;
  --deck-tint: color-mix(in srgb, var(--card) 84%, transparent);
  --deck-blur: blur(20px) saturate(1.3);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --shadow-card: 0 1px 0 rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.6);
  --shadow-deck: 0 1px 0 rgba(0,0,0,0.5), 0 16px 40px -16px rgba(0,0,0,0.7);
  --well-inset: inset 0 2px 4px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04);
}}
@media (prefers-reduced-transparency: reduce) {
  :root { --deck-tint: var(--card); --deck-blur: none; }
}
@supports not (backdrop-filter: blur(1px)) {
  :root { --deck-tint: var(--card); }
}
```

Blur is used on exactly three things: the deck, the Now Playing sheet
header while scrolled, and modal sheets. Nothing else gets
`backdrop-filter`.

### 2.5 Motion

Springs encoded as `linear()`. Physics (mass 1) so they can be regenerated
with any spring-to-linear tool if tuned on device:

| Token | Stiffness | Damping | Duration | Use |
|---|---|---|---|---|
| `--spring-snap` | 500 | 28 | 220ms | keycap release, chip toggle, badge tick |
| `--spring-settle` | 300 | 34 (critical) | 320ms | tab indicator, dial detents, list gaps, needle snap |
| `--spring-sheet` | 180 | 22 | 480ms | Now Playing open/close, modal sheets |
| `--ease-quick` | cubic-bezier(.2,.8,.2,1) | | 160ms | fades, colour, opacity |
| `--draw-band` | cubic-bezier(.4,0,.2,1) | | 280ms | band draw-in |

```css
:root {
  --spring-snap: linear(0, 0.01 2%, 0.06 4.4%, 0.25 9%, 0.56 14.5%, 0.84 20%, 1.02 26%, 1.08 31%, 1.07 36%, 1.03 44%, 1 52%, 0.99 60%, 1 70%, 1);
  --spring-settle: linear(0, 0.02 3%, 0.11 8%, 0.32 15%, 0.58 24%, 0.78 33%, 0.9 43%, 0.96 55%, 0.99 70%, 1 85%, 1);
  --spring-sheet: linear(0, 0.01 2%, 0.07 6%, 0.24 13%, 0.52 22%, 0.78 32%, 0.95 42%, 1.03 52%, 1.04 60%, 1.02 70%, 1 82%, 1);
  --ease-quick: cubic-bezier(.2,.8,.2,1);
  --d-snap: 220ms; --d-settle: 320ms; --d-sheet: 480ms; --d-quick: 160ms; --d-draw: 280ms;
  --d-buffer: 1000ms; --d-skeleton: 1200ms; /* buffering pulse, skeleton shimmer (stilled, not collapsed, under reduced motion) */
}
@media (prefers-reduced-motion: reduce) {
  :root { --d-snap: 1ms; --d-settle: 1ms; --d-sheet: 1ms; --d-draw: 1ms; --d-quick: 120ms;
          --spring-snap: linear(0,1); --spring-settle: linear(0,1); --spring-sheet: linear(0,1); }
  /* the ONE reduced-motion block: everything else reads the tokens */
  .keycap:active { transform: none; }
  .band[data-draw] { stroke-dashoffset: 0; animation: none; }
  .sheet { transition-property: opacity; }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 1ms; }
}
```

Only `transform` and `opacity` animate; never `height`, `top` or
`box-shadow` (the keycap lip animates via a pseudo-element's `transform:
scaleY`). Scroll-driven effects go behind `@supports (animation-timeline:
scroll())`.

## 3. Component inventory

Each component: anatomy, sizes, states. Class names are suggestions; keep
them one word where possible.

### 3.1 Keycap (`.keycap`)
The primary button. A rounded rectangle (`--r-md`; `--r-pill` for round
transport keys) on a 3px lip.
- Sizes: `sm` 44x44 (icon only), `md` 48 (default, 48 high, padding 0 20),
  `lg` 56, `xl` 80 (Play in Now Playing), `glance` 96.
- Variants: `persimmon` (fill `--persimmon`, lip `--persimmon-lip`, text
  `--on-persimmon`), `ultramarine`, `rubber` (fill `--rubber`, lip
  `--rubber-lip`, text `--on-rubber`), `paper` (fill `--card`, lip `--line`,
  text `--ink`; the secondary button).
- Build: `position: relative; transform: translateY(0)`; `::after` is the
  lip (`height: var(--lip)`, same radius, positioned below). On
  `:active`/`[data-pressed]`: `transform: translateY(2px)` and the lip's
  `transform: scaleY(.33)`; release on `--spring-snap`.
- Disabled: fill `--paper-2`, lip `--line`, text `--ink-3`, no depress.
  Offline-blocked: same, plus a `cloud-slash` icon and label "Needs a
  connection".
- Focus: 2px `--ultramarine` ring at 2px offset (`:focus-visible`).
- Haptic on press (Web+): impact medium for Play/Pause, light otherwise.

### 3.2 Text button (`.textbtn`)
44px tall, label weight 700, colour `--ink`, underline on press only. Used
for "Just show me", "More", "Undo".

### 3.3 Chip (`.chip`) and tag (`.tag`)
- Chip: selectable, 36px tall, padding 0 14, `--r-pill`, fill `--paper-2`,
  text `--ink`, 15/700. Selected: fill `--ink`, text `--paper`, plus a
  check icon (not colour alone). Toggle on `--spring-snap`.
- Tag: non-interactive, 24px tall, padding 0 8, `--r-sm`, 12/600. Variants
  `stretch` (fill `--ultramarine-soft`, text `--ultramarine`, bridge icon),
  `narration` (same colours, narration icon), `downloaded` (text `--good`,
  check-circle icon), `played` (fill `--paper-2`, text `--ink-2`). One tag
  component, one treatment, everywhere.

### 3.4 Card (`.card`)
`--card` fill, `--r-md` (hero `--r-lg`), `--shadow-card`, padding 16. No
borders. A card with a Play keycap is not itself a link; the title is the
link and the keycap is a sibling (two targets, both 44+).

### 3.5 Well (`.well`)
Inset container: fill `--paper-2`, `--well-inset`, `--r-sm` or `--r-pill`.
Hosts the band, the scrubber, the gauge, segmented controls.

### 3.6 Band (`.band`)
The signature. An inline SVG (`role="img"` on cards, `role="slider"` in Now
Playing) inside a well.
- Geometry: viewBox width 1000, height per size. Each segment is a `<rect>`
  with `x`/`width` proportional to its runtime over the total. Gap between
  rects 2 units (never below 1px rendered). Minimum rendered width per
  segment 3px; if narrower, merge visually but keep the data.
  **Build (Phase 3 primitives, review follow-up):** a bar under its minimum
  is pinned at it and the other bars share the remaining width in runtime
  proportion (repeated until stable), so bars never overlap, the last one
  ends at 1000, and every segment stays individually drawn. Only when the
  minima alone exceed the width are all bars scaled down evenly. Because
  bars are then not exactly runtime-proportional, progress, the needle and
  the scrubber's pointer map through the drawn bars (`tactileBandLayout`,
  `tactileBandX`, `tactileBandFraction` in `ui/primitives.js`), so a time at
  a segment boundary always lands in the gap between those two bars.
  A band rendered without an `id` gets a fresh `dial-band-N` on each render.
  Its hatch `<pattern>` and progress `<clipPath>` ids are document-global, and
  `url(#…)` resolves to the first element with that id, so a shared default
  made every later band clip to the first band's progress (third review).
- Colours: `fill: var(--seg-cN)` with `N = hash(showId) % 8`, stable across
  the app. Narration items: `fill: var(--seg-narration)` with a diagonal
  hatch pattern (3px lines, 3px gaps, 45°) so narration reads without
  colour; minimum rendered width 8px in `detail` and `scrub`. In `mini`
  (8px) a narration item is a solid ultramarine tick, min 3px, no hatch
  (r1: 4px hatched slivers read as rendering artifacts). Un-narrated forays
  simply have no narration items.
- Sizes: `mini` 8px tall (Home and Library cards; no labels), `detail` 44px
  (Foray detail; 28px bars + 16px label row), `scrub` 56px hit area with
  28px bars (Now Playing). The mini player uses a 3px flat version
  (`.band--line`) along its top edge.
- Station codes (`detail` and `scrub`): two characters per show, mono
  11/700 `--ink-2` (the current station `--ink` 800), centred under each
  **run** of consecutive bars from one show (narration ticks between them do
  not break the run) whose combined width is ≥ 24px rendered; a narrower
  run gets no label but keeps the show name in `aria-label`. One code per
  run, never per bar: r3's un-narrated band labelled adjacent bars `BR BR`
  and `BC BC`, which reads as a legend glitch. The current-station weight
  follows the run too. Code rule: strip a leading "The "; first letter of the first
  two remaining words, upper-case; a one-word title takes its first two
  letters; a collision within one foray replaces the second letter with the
  first letter of the show's last word. (Origin Stories `OS`, BBQ Radio
  Network `BR`, The Moreish Podcast `MP`.) The same code appears in the
  credits list (24px code-in-swatch, as `.segrow .sw`) and the Now Playing
  show chip, so the code is the key. r1 used single initials; four shows in
  one real foray shared "B". **Build the run, not the bar:** the r5
  prototype's `bandHTML()` still gates a label per segment on that one bar
  being ≥ 24px, which happens to look right at 375/393 and doubles `BR BR`
  / `BC BC` at 412 on both the scrub and the detail band (the owner's phone
  width). Group adjacent same-show segments first, test the run's combined
  width, label once at the run's centre, and mark the current run by index
  range; the exact code is in `critique-r5.md`.
- Progress: played portion of each rect at full fill; unplayed at 40%
  opacity. Implemented as two layers: a full-opacity copy clipped with a
  `<clipPath>` whose width follows `--band-progress` (0-1).
- Needle: a 2px-wide `<rect>` 6px taller than the bars, fill `--ink`, with a
  4px round head; `transform: translateX()` from `--band-progress`. In
  `scrub`, the hit area is 44px wide centred on the needle.
- Draw-in: `stroke-dasharray` trick on a mask rect, `--d-draw`, left to
  right, once per mount. Reduced motion: no draw.
- Scrubbing (`scrub` only, Web): pointer events on the well,
  `touch-action: none` on the band only; drag moves the needle live
  (transform only), snapping to segment boundaries within 12px with a
  selection haptic (Web+); release seeks. A readout bubble (`.band-bubble`,
  mono 13, card fill, `--shadow-card`) floats 12px above the needle showing
  `show name · 12:40`. Keyboard: left/right by 15/30s, up/down by segment.
  ARIA: `aria-valuetext="12 minutes 40 of 48 minutes, Lex Fridman Podcast"`,
  updated on change only, never per second.

### 3.7 Gauge (`.gauge`)
The exploration-floor meter, drawn in the band's language so it cannot be
mistaken for a slider (r2 rendered it as a 12px pill with a thumb, and it
read as a range input). A `--r-sm` well 24px tall with 4px padding, width
100%. Inside: one bar the full inner width, `--line`, radius 2; over it,
from the left, the unfamiliar share (about 0.33) as the narration hatch
(3px/3px `--ultramarine` / `--ultramarine-soft`), radius 2. The band needle
at that x: 2px `--ink`, 8px cap 10px **above** the well, stem to the well's
bottom edge; never a cap inside the well. Heading row: "New ground" heading
20/700 left, readout `1 in 3` (mono 13, `--ink-2`) right. Caption below the
well: label 13/500 `--ink-2`, fixed copy "About a third of today sits
outside your usual subjects. 4a keeps it that way." (15 words; the limit is
18.) `role="img"` with the same text as `aria-label`; no focus, no
`:active`, no `input`.

### 3.8 Bridge card (`.bridge`)
The Stretch pick. Card, padding 16. The bridge sentence first, as the
headline: body-lg 600 `--ink`, 3 lines max, ≤ 16 words. Under it, three
columns (`grid-template-columns: 48px 1fr 72px; column-gap: 4px`): known
artwork 48 (`--r-sm`, `align-self: center`), the arc, stretch artwork 72
(`--r-md`). The arc is an inline SVG (`viewBox 0 0 100 48`, `overflow:
visible`), path `M2 30 C 22 -6, 78 -6, 98 20`, 2.5px `--ultramarine`, drawn
in on mount (`--d-draw`), **with a 3px dot at both ends** (`(2,30)` and
`(98,20)`; r3's `(2,34)` sat on the known art's corner radius, 30 touches
its edge), the far dot appearing 40ms after the stroke arrives. Same
grammar as the `bridge` icon: two dots joined by an arc. Never a single
dot — r2 put one at the known end and the round-capped stroke read as an
arrowhead pointing the wrong way. Both ends touch the artwork edges; the
arc never disappears behind the right art. Below: `stretch` tag, then
title 15/700 (2 lines), meta line with show 13 `--ink-2` (display-name
rule, 3.9), duration readout and `+ Up Next` exactly as `.row-episode`.
Play keycap `sm` at the right edge of that row. If there is no known-item
artwork (first run), the left slot shows a subject tile instead. The
sentence names both ends by subject ("Machining wears parts into tolerance;
linguistics wears words into new forms. Same slow erosion."); a line that
names neither is not a bridge.

### 3.9 Rows
- `.row-show` 56: artwork 44 `--r-sm`, name 15/700 (1 line), meta 13
  `--ink-2`, trailing follow chip (36) or chevron.
- `.row-episode` 72: artwork 56 `--r-sm`, title 15/700 (2 lines), show +
  duration readout 13 `--ink-2`, why-line 15/500 `--ink` on its own line
  below when present (the row grows to 92). Trailing: **one** Play keycap
  `sm`, nothing else (r1 trailed `+` and Play and the title got 185px).
  "+ Up Next" is a text action at the right end of the meta line: label
  13/700 `--ink-2`, plus icon 16, 44px tap height via a `::before` inset;
  after adding it reads "✓ Queued" in `--good` for 2s. The show name in the
  meta has `min-width: 112px` (72 in r2 cut six of eight rows at 393) and
  ellipsises last. If the meta still cannot fit on one line (the row with a
  downloaded mark at ≤ 393), it wraps after the show name: name alone on
  line one, readout + mark + `+ Up Next` together on line two; never the
  action alone on its own line. **Display-name rule** for meta lines only: strip a
  trailing ` - …`, ` | …`, ` with …` or ` (…)` clause from the show name
  ("Lingthusiasm", "Choiceology", "Design Matters", "The Partially Examined
  Life"); full names stay on tiles, in Find and in "From" rows. Tags inline
  after the show name. The downloaded mark (check-circle 14, `--good`)
  carries `aria-label="Downloaded"` and becomes the word in the offline
  state.
- `.iconbtn`: 44x44, no face, no lip, icon 24 `--ink-2`; pressed fill
  `--paper-2` at radius 12 on `--d-quick`. For overflow and menu openers
  only (`⋯`); keycaps are for actions that change playback or the
  collection.
- `.row-queue` 64: position readout (mono 13, `--ink-3`, 20px wide),
  artwork 48, title 15/700 (2 lines), show + remaining 13, trailing `⋯`
  as `.iconbtn`. Current row: fill `--persimmon-soft`, a needle icon
  replacing the position number, tag "Playing" (transparent fill, text
  `--persimmon` 12/700, needle icon 14) and meta "Playing · 42 min left"
  with no show name. Pressing `⋯` expands a 48px action row beneath
  (`--spring-settle` gap opening): Move up, Move down, Remove, each a paper
  keycap `sm` with a label. Remove shows a 4s undo toast.
- Minimum 8-10 rows per 852px viewport. Row padding 0 16, gap 12.

### 3.10 Mosaic tile (`.tile`)
Find's idle state. Three sizes on a 2-column grid with 12px gap: `s` 1x1
(about 170x120), `m` 2x1, `l` 2x2. Fill `--card`, `--shadow-card`, `--r-md`.
Content: a composite of 2-4 show artworks (40px discs overlapping by 12px),
the subject name in the display face at 17/24, weight 650, width 96%,
tracking -0.01em (the heading role's settings at 17px; `l` takes the title
role, 2.1), show count readout (the whole readout mono 13
`--ink-2`, one space: `14 shows`, never a mono digit beside a Bricolage
noun). `l`: 2x2 collage of 88 right, text column vertically centred beside
it (`min-height: 196`). `m`: one row, `min-height: 120`, discs left, name +
count right, centred. `s`: discs top-left, name bottom-left. The no-results
hit tile is a fill (`--ultramarine-soft`), never an outline. Size is
assigned by subject weight; order is shuffled under the floor with the
"no two neighbours from one branch" rule. Fixed count per render (about
14), no infinite scroll; a "More subjects" paper keycap at the end swaps the
set.

### 3.11 Deck (`.deck`)
Fixed to the bottom, `left/right: 16px`, `bottom: calc(var(--safe-b) + 12px)`,
`--r-lg`, `--deck-tint` + `backdrop-filter: var(--deck-blur)`, `--shadow-deck`.
Two stacked parts:
- Mini player (`.mini`, 64px, see 3.12), present only when something is
  loaded. A 1px `--line` separates it from the tab row.
- Tab row (64px): three tabs, each 44+ tall, icon 24 + label 12/600. Active:
  Phosphor Fill icon, label `--ink`, a 32x4 indicator pill (`--persimmon`)
  that slides on `--spring-settle`. Inactive: Bold icon, `--ink-2`. The Yours
  tab carries a count badge (`--ultramarine`, 18px, mono 11) when Up Next is
  non-empty.
- Collapsed (on scroll-down > 24px): labels fade out and the tab row drops
  to 48px; returns on any scroll-up. Scroll-driven behind `@supports`, else
  a scroll listener with a 100ms throttle.
- Content padding-bottom: `calc(var(--deck-h) + var(--mini-h, 0px) + var(--safe-b) + 24px)`.
- **Build (Phase 3 primitives, third review):** `.deck` carries the fixed
  position itself. Left and right are 16px plus `env(safe-area-inset-left/right)`
  (zero in portrait), so landscape notches are covered too. The gallery shows
  each deck inside a `.gallery-device` frame with `contain: layout`, which makes
  the frame the containing block for the real fixed rule. No rule may
  re-position `.deck` (`test/tactile-deck.test.js`).

### 3.12 Mini player (`.mini`)
64px: artwork 44 `--r-sm` at 10px inset, title 15/700 (1 line, ellipsis),
show 13 `--ink-2`, Play keycap 48 (persimmon, round), 30-forward keycap 44
(paper). `.band--line` 3px along the top edge (foray colours, or
`--persimmon` for an episode). The body (artwork + text) is one 44+ tall
button that opens Now Playing; the keycaps are siblings, never overlapped.
Swipe-down on the body with > 60px travel dismisses (stops playback) with
a rigid haptic and a 5s undo toast; horizontal swipes do nothing.
`role="region" aria-label="Now playing: {title}, {show}"`.
**Build (Phase 3 primitives, third review):** `tactileMiniPlayer` renders the
line as `tactileBand({ kind: "line" })`, the mini's first child, absolute at
the top edge and 22px in from each side (the prototype's inset). It shows the
foray's bars when `segments` is passed, otherwise one persimmon bar. The bars
are full height with no needle and no draw-in, and narration is a solid tick.
The line is `aria-hidden`, because the region label already names what is
playing. The width is stated rather than `auto`: an absolutely positioned SVG
with `width: auto` takes its intrinsic size, which is 50px at 3px tall.

### 3.13 Now Playing sheet (`.np`)
A full-height sheet over the app (see 4.2). Grabber 36x5 `--line` at the
top. Opens from the mini via a shared-element move of the artwork (View
Transitions: `view-transition-name: np-art` on both; FLIP fallback with the
Web Animations API) on `--spring-sheet`. Drag-to-dismiss tracks the finger
(transform only), releases on `--spring-sheet`, with a 30% travel or 0.5
px/ms velocity threshold. Focus moves to the Play keycap on open and returns
to the mini body on close. `aria-modal="true"`, background `inert`.

### 3.14 Rotary chip (`.rotary`)
Speed and sleep timer. A chip that reads a value in mono (`1.0×`, `15 min`).
Tap opens a 56px-tall horizontal detent strip in a well (the "dial") with
ticks every 0.1x / 5 min; drag across it with selection haptics; a tap on a
tick also works (every tick is 44px wide). Buttons "−" and "+" (44px) sit at
the strip's ends for keyboard and switch users.

### 3.15 Skeleton (`.skel`)
Band-shaped and row-shaped placeholders with a 1.2s shimmer (opacity only,
off under reduced motion). Match the final layout's heights exactly so
nothing jumps, and draw the **inner shapes**, not only the container (r3
painted the hero as one 405px slab, which says nothing about what is
coming). Two tones: shapes in `--line` on a `--paper-2` card.
- Hero: eyebrow pill 24×112 (`--r-sm`); three title lines 28px tall at
  88/80/40% width; the band as an 8px pill well full width; three 40px
  discs overlapping by 12 plus a 120×13 readout bar; two why-lines 17px at
  96/72%; an 80px circle and a 48×96 pill.
- Episode row: 56px square, two title lines at 90/60%, one 13px meta bar
  at 50%, a 44px square at the right.
- Playlist card: a 96px square and two bars.

### 3.16 Empty and error states (`.empty`)
One drawn mark (a 96px inline SVG of a small radio, 2px `--ink-2` stroke,
the only illustration in the app), one line of copy (≤ 18 words, speaks as
4a, no "we"), one keycap. Never a bare sentence. Example, Yours empty:
"Nothing here yet. Follow a show or play today's foray and it lands here."
Keycap "Find a show".

### 3.17 Toast (`.toast`)
Above the deck, card fill, `--shadow-deck`, 48px, text 15 + an Undo text
button. Slides up on `--spring-settle`, auto-hides after 4-5s, pauses on
touch. `role="status"`.
**Build (Phase 4 `toast`):** padding `0 8px 0 16px` (the prototype's: Undo's 44px box sits 8px from the
right edge, so the 'Undo' word lands where the prototype's does), text `--w-micro`/`--t-body`
(600, 15/21). Under reduced motion the toast is cut (listed in the one block's `transition: none` rules): the plan
says fade, but `gates.mjs` fails any transition over 1ms under that setting and a 120ms fade measured two
new violations, so a fade needs an orchestrator ruling on the gate. Yours' Remove toast runs 4s and its clock stops on a press or while focus is on the
toast, so a keyboard user who Tabs to Undo is not raced; the mini's "Player closed" toast keeps its 5s. Above the mini when
the mini is up (`.yours-toast`). Tests: `test/tactile-toast.test.js`.

### 3.18 Icons
Phosphor Bold at 24px via `<svg><use href="#ph-…">` from one sprite
inlined in `index.html`. Fill weight only for the active tab. Custom marks
(same 24 grid, 2px stroke, round caps, 2px internal gap): `skip-15`,
`skip-30` (arc with the numeral at 10/700 inside), `band` (three bars 10/6/4
wide on a baseline), `needle`, `bridge` (two 4px dots joined by an arc),
`narration` (two 3px ticks). Every icon-only button has `aria-label`; every
decorative icon has `aria-hidden="true"`.

## 4. Per-screen layout specs

Common: top padding `calc(var(--safe-t) + 12px)`, gutters 16, section gap
32, in-section gap 12. Screen titles use display-xl with 8px below to the
readout line; every tab screen has that line (Today: the date; Find: the
subject hint; Yours: the selected chip's count, "5 queued · 4 hr 55 min").
The knob button (44, paper keycap, custom `knob` mark) sits at the top
right of Today and Yours and opens Settings (which contains Dials). The
mark, third version: a **filled** disc `cx 12 cy 11 r 8` in `currentColor`;
a pointer in the keycap's face colour (`var(--k-fill)`, a groove cut into
the knob) from `(12,11)` to `(7.4,6.4)`, 2.5px, round cap; two end-stop dots
r1.4 at `(4,20.5)` and `(20,20.5)`. **Nothing above the disc**: r1's radial
tick at 12 o'clock and r2's dot at 12 o'clock both made it a stopwatch
crown, and both versions were read as a timer. If the owner still reads it
as something else at the pick, the fallback is Phosphor `faders` Bold; do
not draw a fourth knob.

Settings → Dials (`.knobtrack`): a 44px well per dial with a **persimmon**
fill from the left (the listener's own setting; ultramarine is 4a's), the
band needle at the value (2px `--ink`, 8px cap 6px above the track), and a
centre detent tick 2px × 16px at 50% drawn **above** the fill: `--ink-3`
on the well, `--on-persimmon` at 70% where it overlaps the fill (r3 put it
behind the fill, so every dial above centre showed no detent at all). The
hidden range input's `step` snaps to the detent with a selection haptic.
The per-row readout shows the offset from the detent (`+2`, `−1`, mono 13)
and is empty at the detent; the sheet-level line "4a's setting is the
centre detent" (label 13/500 `--ink-2`, not micro) says the rest. On open, focus the sheet container (`tabindex=-1`),
never the first button; focus rings on `:focus-visible` only.

**As built (`ui/settings.js`, group G).** Decisions the notes left open:
the sheet floats 8px in from each edge on the shared `.sheet` material (the
prototype's, not the bottom-docked gallery sheet's); Appearance is System /
Cream / Bakelite (the prototype's Cream / Bakelite / Auto, reordered so the
default comes first) and `System` removes `html[data-theme]`, since the token
layer knows only `light` and `dark`; `cp_theme` is applied at the top of
`init()` and again after storage hydration (a head script would have to read
`localStorage` around the shim, which the security census forbids, so a
Bakelite user can see one Cream frame before init on a cold load). A dial is
eleven positions with 4a's setting at 5 whatever the subject's weight: below
the detent the dial spans 0 to that weight, above it that weight to 1, so the
detent writes exactly 4a's value and the whole 0..1 range stays reachable
(`settingsDialPosition` / `settingsDialValue`). Three dials: the roots the
listener has moved first, then the roots 4a weights highest. At the detent the
needle sits on top of the detent tick (the same x), so the tick is seen at
every value but that one, where the needle is the mark. The knob's drawer is
not gone: the sheet's "More settings" hands over to it, because Family mode,
Continuous playback, the voice picker and Delete my data live there and the
topbar's menu button is hidden on Today and Yours.

Prototype routes for the shoot: every screen exposes its states as hash
sub-routes (`#/home/first`, `#/home/resume`, `#/home/offline`,
`#/home/loading`, `#/home/also`, `#/home/ground`, `#/library/empty`,
`#/library/upnext/open`, `#/foray/progress|done|unnarrated|unavailable`,
`#/now-playing/paused|buffering|episode|more`, `#/search/typing|none`,
`#/settings`, `#/toast`, `#/onboarding/return`), `?theme=dark` forces
Bakelite before first paint, and `prototype/routes.json` lists the matrix.

### 4.1 Today
Order top to bottom:
1. Header row: "Today" display-xl; below it the date as mono readout 13
   `--ink-2` ("Mon 5 Oct"). Knob keycap at the right, vertically centred on
   the title.
2. **Resume** (only mid-listen): card, 16 padding. Eyebrow tag top-left
   like the hero's: needle icon, fill `--persimmon-soft`, text
   `--persimmon`, reading "Resume" (r2 had no word for the state). Artwork
   80 `--r-sm` left, title 17/700 (2 lines), show 13, then one line: a 4px
   progress well (`flex: 1`) + readout "12 min left" (`flex: none`, 12
   gap). The key is the mini player's: `keycap--persimmon keycap--round` at
   `--key` 48 (same action as the mini, same key; r2's 64×48 rectangle was a
   fourth key shape). Height ≤ 128, target 124.
3. **Today's foray** hero: card `--r-lg`, padding 20. Eyebrow tag `narration`
   style reading "Today's foray". Title `clamp(1.75rem, 7.2vw, 2rem)` /
   1.125 (28/32 at 375-393, 32/36 at 412+), max 3 lines. Gaps: eyebrow →
   title 10, title → band 12, band → discs 10, discs → why 12, why → keys
   16 (r1's uniform 12 plus 32/36 at three lines made the hero 420px). Band
   `mini` (8px, bar radius 1) full width. Row: three show discs 40
   overlapping by 12 + readout "about 22 min · 4 shows". Why-line body-lg
   500 `--ink`. Keycap row: Play `xl` (80, round, persimmon) left; "Details"
   paper `md` beside it. Hero bottom ≤ 540px from the top at 393 so the
   first "Also today" row clears the mini player.
4. **Also today**: heading 20. Three `.row-episode` rows with why-lines
   (92 each), one of which is a `.bridge` card (about 180). The Stretch slot
   is always present; if the data has none, the rail still reserves it with
   a tile-backed bridge.
5. **Playlists for you**: heading 20. 2-column cards (gap 12), each with a
   2x2 artwork composite 96, name 15/700, readout "4 episodes · 2 of 4
   played" with a 4px progress well.
6. **New ground**: the `.gauge`, inside a card with 16 padding.
7. Deck padding.

States: first run → no Resume, hero copy "4a starts with wide bets. Each
listen narrows the dial." under the title; Also today rows carry
subject-based why-lines (never "your usual subjects"). Stress → titles
clamp to 3/2 lines, discs collapse to a count after 4. Offline → every
undownloaded Play keycap takes the offline-blocked state; downloaded items
get the `downloaded` tag. Loading → skeletons at the exact heights above.

### 4.2 Now Playing (full)
Full-height sheet, `--r-lg` top corners, background: a layer of the
artwork's dominant colour (Web: 32x32 canvas sample, cached in memory per session; no storage key,
review fix 2026-10-07) under `--scrim-np`, edge to edge, plus a 60% height
radial fade to `--paper` at the bottom so the transport sits on paper.
Layout at 393x852, top to bottom:
1. Grabber at `safe-t + 8`. Close is the grabber and swipe-down; a 44px
   "Collapse" icon button sits top-left for screen readers.
2. Artwork 280 square, `--r-lg`, `--shadow-card`, centred, 24 below the
   grabber. 200 at 375x667; 160 when the title needs 3 lines. Downloaded:
   a 24px `--good` check-circle badge bottom-right of the artwork.
3. Title 24/28 700 (3 lines max), 20 below the artwork; show 15/500
   `--ink-2`; chip row 8 below: for a foray, "4a narration" tag or the show
   chip (swatch 10px in `--seg-cN` + initial + name); for an episode, the
   `downloaded`/`played` tags only.
4. Band `scrub` (56 hit, 28 bars) full width, 20 below the text. Readout
   row 8 below: elapsed mono readout-lg left, remaining mono 13 right (the
   counter). Episodes show a plain persimmon fill with chapter ticks 1px
   `--ink-3` when chapters exist.
5. Transport row, pinned: `position: sticky; bottom: calc(safe-b + 16)`.
   Skip-15 keycap `lg` (56, rubber, round) · Play `xl` (80, persimmon,
   round) · Skip-30 `lg`. Gaps 24. Centre of Play at 72% of the viewport
   height or lower, never below the fold.
6. Secondary row, 16 below: rotary chip speed (`1.0×`) · rotary chip sleep
   (`Sleep · Off` / `Sleep · 15 min`, the word 15/700, the value mono) ·
   bookmark keycap `sm` · Up Next as a paper keycap `sm` (same shape as the
   bookmark) carrying a `list` icon 20 and the 18px count badge at
   `top: -4px; right: -4px`, `aria-label="Up Next, 5 queued"` (opens the
   queue in Yours). Two chips, then two keys: r3's round paper disc made
   three silhouettes on a row of four.
   Hidden in Glance posture; in Glance, Play becomes 96 and skips 64.
   Readouts: `.readout-lg` tracking -0.05em and the colon wrapped in a span
   with `margin: 0 -0.06em` (Azeret's colon has wide sidebearings).
7. At rest nothing sits under the pinned transport: everything above the
   scrolling detail is wrapped in `.np__top { min-height: calc(100% - 176px
   - var(--safe-b)) }` so the "Up next" heading peeks 24px above the dock
   edge as the scroll cue and its card is below the fold (dock is 190px;
   156px at ≤ 740px tall, same rule).
8. Scroll continues (the sheet body scrolls; the transport stays pinned):
   "Up next" card (artwork 56, title, why-line, readout), then for a foray
   "Segments" grouped by slot title (heading 17, rows of 56: initial swatch,
   show name, segment duration, a `narration` tag for narration items),
   then "Where this came from" (one `.row-show` per show with its swatch),
   then "Chapters" (rows 48, tap seeks), then "Show notes" (4 lines + "More",
   feed HTML sanitised and restyled; timestamps as chips that seek).

States: paused → Play shows the play glyph and the needle stops. Buffering →
the needle pulses opacity 1→0.4 at 1s (off under reduced motion) and the
elapsed readout shows "…". Offline/downloaded → `downloaded` tag; offline
and not downloaded → a toast "Needs a connection" and the transport
disabled except Pause. End of item → the Up next card's artwork moves into
the hero slot (shared element, `--spring-settle`) and the band redraws.
Max text size → artwork drops to 160, title 3 lines, readouts stack, the
secondary row wraps to two rows; the transport never leaves the viewport.
Foray narration vs clip → chip row as above, plus the band's hatched tick
under the needle.

### 4.3 Mini player
See 3.12. Sits on the deck; the deck is the only thing that moves when the
keyboard opens (it hides; the Find field stays).

### 4.4 Find
- Field: `position: fixed`, above the deck (`bottom: deck + 12`), 52px,
  card fill, `--shadow-deck`, `--r-pill`, 16 padding, magnifier icon,
  placeholder "Search, or name a subject". When the keyboard opens the
  deck hides and the field docks to the keyboard. Clear button 44.
- Idle: title "Find" display-xl with the readout line "Type any subject
  and 4a builds a playlist" (label 13/500 `--ink-2`, the slot Today uses
  for the date; no separate keycap — r1's keycap + hint row repeated the
  field); then the `.tile` mosaic (about 14 tiles, 2-column, 12 gap).
  "Followed shows" is a strip of 72px items (art 64, name 12/600 clamp 2,
  no mid-word breaks) at the top only when the listener follows something.
  Large tile: 2x2 collage of 88 right-aligned and vertically centred, name
  and count stacked bottom-left with 2px gap, min-height 196. The "Make a
  playlist about…" keycap's icon is Phosphor `sparkle`; the bridge mark
  means Stretch and nothing else.
- Typing: results replace the mosaic live: "Shows" (rows 56), "Episodes"
  (rows 72), "Playlists" (cards), each heading 17 with a count readout. A
  final "Make a playlist about '{query}'" ultramarine keycap row.
- No results: heading "No shows match 'fusion'." then, when a subject
  matches, "Fusion & energy systems has 5 shows." with that tile below, else
  the "Make a playlist about…" keycap only. Never a bare sentence; never
  contradicts a visible tile.
- Keyboard open: content padding-bottom grows to the keyboard height; the
  mosaic stays scrollable.

### 4.5 Yours
- Title "Yours" display-xl, knob keycap right.
- Chip strip (horizontal scroll, 36px chips, 12 gap - corrected from 8 after the i4 measurement of the prototype, 16 gutters): Forays,
  Shows, Saved, Playlists, Up Next (count badge), History. Selected chip
  per 3.3; the strip is `role="tablist"`.
- Forays: cards with `.band--mini`, title 17/700, readout, resume progress.
- Shows: 3-column art grid, 108px tiles (gap 12), `--r-sm`, name 13/600 on
  two lines below. Long-press or the `⋯` reveals Unfollow.
- Saved / History: `.row-episode` rows (72).
- Playlists: 2-column composite cards as on Today.
- Up Next: `.row-queue` rows (64), a header readout "5 queued · 2 hr 10
  min", "Clear" as a paper keycap `sm` with a confirm sheet. Reorder via the
  `⋯` action row (3.9); drag handles are not shown (drag deferred).
- Empty: per 3.16, one state for the whole screen on first run.

### 4.6 Foray detail
1. Back keycap `sm` (paper, arrow-left) top-left; share keycap `sm` top-right
   (Web+ native share of `#/foray/{id}`).
2. Tag "Foray" (narration style). Title display-xl (4 lines max).
3. Band `detail` (44 with labels), 16 below the title, inside a card-wide
   well. Needle shown only when in progress.
4. Readout row mono 13 `--ink-2`: "about 22 min · 4 shows · 8 segments".
5. Summary body-lg; why-line body 500 `--ink` under a "Why today" label 13.
6. "From": show discs 40 with names 15/700 and swatches, as `.row-show` 56.
7. "Segments" grouped by slot title: heading 17, then rows 56 (initial
   swatch 24, show name 15/700, segment runtime readout, `narration` tag
   where applicable). Tapping a row starts the foray at that segment.
8. Pinned Play as **one extended keycap**: `keycap--persimmon keycap--lg
   keycap--round`, height 56, padding `0 20px 0 14px`, play icon 28 +
   "Play" 17/700 + readout `22 min` (mono 13, `--on-persimmon` at 85%),
   right-aligned at `bottom: deck + 16`. In progress: "Resume" + `12:40`;
   finished: "Start over", no readout. (r2's 80px round key with a detached
   label pill read as two controls; 80 is reserved for the hero and the
   transport.) On this screen the bottom paper fade grows to `deck + safe-b
   + 100px` (stop at 60%) so rows fade out under the pin; the pin never
   sits on unfaded text.
   "From" rows use the 24px code-in-swatch and read "2 segments" (no bare
   letter).

States: in progress → needle on the band, label "Resume at 12:40", played
bars at full and the rest at 40%. Finished → `played` tag beside the title,
label "Start over". Un-narrated → no hatched ticks; a 13px line under the
readout row, "No narration yet on this one." Unavailable → the band renders
as an empty well with a lifted needle (rotated 20°), heading "This foray
isn't available right now.", two keycaps: "Try another foray" (persimmon,
links to the next available foray) and "Yours" (paper); the share keycap is
hidden (nothing to share), the back keycap stays. The empty well
shows **no station labels** (`.band--empty .band__labels { display: none }`);
codes under nothing read as a legend for a chart that failed to load.

### 4.7 Onboarding (first screen)
Full screen on `--paper`, no deck. Top 56% is a card `--r-lg` carrying a
live demo of today's real foray: the band `detail` draws in (`--d-draw`
then a 1.2s needle travel loop at 8% per second, off under reduced motion),
the show discs with real artwork from their published URLs, and a mono
counter running in the readout row under the band (`8:52 / 22:10 · 6
shows`, the running part `--ink`); the card's top row carries only the 4a
brand (a counter top-right reads as a fake status bar). Card height 60dvh
at ≥ 800px tall viewports, 50dvh below 700. Below: headline display 32 "Podcasts, stitched around
you." (the founders' tagline), sub body-lg "4a picks real shows each day and
lines up the best parts into one listen." (15 words). Bottom: Play keycap
`lg` full width (persimmon) "Play today's foray"; text button "Just show
me" 12 below; both above `safe-b + 16`. No account step. Returning after
skip: same screen without the animation, keycap "Play".

## 5. Motion specs (per transition)

| Transition | Trigger | What moves | Token | Fallback |
|---|---|---|---|---|
| The deck opens | mini body tap, or drag up | artwork mini→hero (shared element); sheet translateY from 100% to 0; deck translateY to +120%; mini band line scaleY/scaleX into the scrub band (opacity cross-fade 120ms) | `--spring-sheet` / `--d-sheet` | FLIP with WAAPI; reduced motion: opacity 120ms |
| The deck closes | grabber, swipe-down, back | reverse; interruptible mid-gesture; velocity > 0.5 px/ms completes | `--spring-sheet` | same |
| The card takes the stage | Play keycap on any card/row | keycap depress (2px, lip scaleY .33) then release; artwork FLIP from row to mini slot (translate + scale, 320ms); band draw-in in the mini line | `--spring-snap`, `--spring-settle`, `--d-draw` | reduced: immediate state, mini fades in |
| Detent (tab) | tab tap | indicator pill translateX; icon Bold→Fill opacity cross-fade 120ms; page cross-fade 160ms | `--spring-settle` | reduced: swap |
| Add to Up Next | "+ Up Next" on a row | a 24px artwork chip scales from the row to the Yours tab (translate+scale 320ms), badge scale 1→1.2→1 | `--spring-settle`, `--spring-snap` | reduced: badge updates |
| Queue reorder | Move up/down | the two rows swap via translateY; neighbours open/close a 64px gap | `--spring-settle` | reduced: re-render |
| Remove + undo | Remove | row height collapses via translateY of followers (not height); toast slides up | `--spring-settle` | reduced: fade |
| Band draw-in | mount | mask rect width 0→100% | `--d-draw` | none |
| Needle snap | scrub release near a boundary | translateX to the boundary | `--spring-settle` | immediate |
| Keycap | press/release | translateY 2px; lip scaleY | `--spring-snap` | colour only |
| Deck collapse | scroll-down > 24px | tab labels opacity; row height via translateY of the deck | `--d-quick` | immediate |
| End of item | playback ends | Up next artwork → hero slot (shared element); band redraw | `--spring-settle`, `--d-draw` | fade |
| Skeleton | loading | opacity shimmer 1.2s loop | n/a | static |

Every transition must be interruptible: start the next from the current
computed transform, never from the resting state. Never await an animation
before changing state.

## 6. Haptics map (Web+)

| Moment | Call |
|---|---|
| Play / pause | `Haptics.impact({ style: 'MEDIUM' })` |
| Skip 15 / 30 | `impact LIGHT` |
| Scrub detent (segment boundary, chapter tick) | `Haptics.selectionChanged()` |
| Bookmark saved | `Haptics.notification({ type: 'SUCCESS' })` |
| Add to Up Next, Follow, Save | `impact LIGHT` |
| Tab change | `selectionChanged` |
| Rotary tick (speed, sleep) | `selectionChanged` |
| Mini swipe-dismiss | `impact HEAVY` (closest to "rigid" on both platforms) |
| Keycap press (non-transport) | none (the depress is the feedback) |

Throttle to one call per 100ms; never on scroll; no-op when the plugin is
missing (web build) or the OS has haptics off. Android feedback is coarser;
do not add extra calls to compensate.

## 7. Artwork and colour extraction (Web)

- Load artwork from the published URL at runtime via `safeUrl()`; never
  commit images.
- Tint, foray: **the station's enamel.** `--np-tint` is `--seg-cN` of the
  show under the needle; when the needle crosses into another show's bar
  the tint transitions to that show's enamel over `--d-sheet` (narration
  ticks keep the previous tint). r1 averaged the four-artwork collage and
  got grey.
- Tint, episode: draw the image at 32x32 on an offscreen canvas (crossOrigin
  anonymous; on a CORS failure use the show's enamel), average in linear
  light, convert to OKLCH; if chroma < **0.07** use the show's enamel
  instead; clamp lightness to 0.45-0.6, then **floor chroma at 0.10** and
  walk it down only as far as sRGB gamut needs; cache in memory by show id
  with the URL's hash, never in storage (review fix 2026-10-07: a cp_ key family needs a privacy-policy line). (r3 used a 0.04 floor and no
  boost: Odd Lots averaged to a mauve that read as grey-brown under the
  Cream scrim. A tint is a colour or it is the enamel; nothing in between.) Apply as `--np-tint` and transition it with `@property
  --np-tint { syntax: '<color>'; inherits: true; initial-value: #F7F0E4 }`
  over `--d-sheet`.
- Contrast check: compute the contrast of `--ink` over
  `mix(--np-tint, --scrim-np)`; below 4.5:1, raise the scrim alpha to 0.9.
- Media Session artwork sizes: 96, 128, 192, 256, 384, 512 from the same
  source URL (`sizes` array); title = episode or foray title, artist = show
  (or "4a foray · 4 shows"), album = the why-line.

## 8. Accessibility checklist (per screen, visible or testable)

- Every control ≥ 44x44; transport ≥ 56; 12px between adjacent transport
  keys.
- Text ≥ 15px body, ≥ 12px micro (labels and readouts only, never body
  copy). Everything in `rem`; verify at 200% OS text scale; pinch-zoom
  enabled (`user-scalable=yes`, `touch-action: manipulation` only where
  double-tap-to-zoom conflicts with a control).
- Contrast per the table in 2.2; artwork tints checked at runtime.
- State never by colour alone: tags and icons on played, queued, downloaded,
  playing, narration, stretch; the band has station letters and hatch.
- Screen reader: mini player is one region; sheets trap and return focus;
  the band is a slider with `aria-valuetext` updated on change; queue rows
  expose Move up/down/Remove as buttons; toasts are `role="status"`.
- Reduced motion: the single block in 2.5; no marquee; skeleton static.
- Reduced transparency: the deck goes opaque (2.4).
- Keyboard: every gesture has a button twin (dismiss sheet = Collapse
  button; scrub = arrow keys; reorder = buttons).

## 9. Build order suggestion

1. Tokens (2.1-2.5) and the two schemes; a `tokens.html` gallery with every
   pair from the contrast table rendered as text-on-swatch.
2. Keycap, chip/tag, card, well, band (`mini`, `detail`, `scrub`) with real
   `data/forays.json` items; the band is the riskiest component, so prove
   it first at all three viewports.
3. Deck + mini + Now Playing sheet with the shared-element open/close.
4. Today, Foray detail, Yours (with Up Next), Find, Onboarding.
5. Haptics and media session (Web+), tint extraction, reduced-motion and
   reduced-transparency passes, then the harness renders.

## 10. Copy that ships with the components (copy rules applied)

| Where | Text |
|---|---|
| Today hero eyebrow | Today's foray |
| Today first run | 4a starts with wide bets. Each listen narrows the dial. |
| Gauge | About a third of today sits outside your usual subjects. 4a keeps it that way. |
| Offline keycap | Needs a connection |
| Find placeholder | Search, or name a subject |
| Find no results | No shows match '{q}'. {Subject} has {n} shows. |
| Yours empty | Nothing here yet. Follow a show or play today's foray and it lands here. |
| Foray un-narrated | No narration yet on this one. |
| Foray unavailable | This foray isn't available right now. |
| Onboarding sub | 4a picks real shows each day and lines up the best parts into one listen. |
| Onboarding keycaps | Play today's foray · Just show me |
| Remove toast | Removed from Up Next · Undo |

"Subject", never "topic". 4a speaks as 4a. No "fascinating", "deep dive",
"delve", "explores". Durations read "45 min / 1 hr 5 min"; the colon clock
is for the counter and scrubber only.

Tactile renders are shot with `--scheme light` (its primary scheme is the cream paper `#F7F0E4`; the harness default is dark). Do a dark-scheme pass only as a secondary check.
