# Design judge rubric (pairwise)

The judge compares **two screenshots, A and B**, and says which one is the
better-designed mobile app screen. It never scores either one in isolation.
Pairwise judgement is steadier than absolute scores: "which is better" is a
question a judge answers consistently, "is this a 7" is not.

Read this file and `protocol.md` before judging. The judge sees only the two
images and this rubric. It does not know which image is 4a, which is a
reference app, or which is a deliberately degraded variant, and it must not
guess and reason from that guess.

## What to ignore

- **Content you would not see in the product.** App Store listing frames often
  carry marketing captions, device bezels or a coloured backdrop around the
  screen. Judge the app UI inside the frame; do not reward or punish the
  caption, the backdrop or the bezel.
- **Claims about quality.** Award laurels ("Editors' Choice", "Apple Design
  Award", "App of the Day"), press quotes, star ratings, review quotes and
  download counts are someone else's verdict, not design. They carry zero
  weight; if one sits over part of the UI, judge the UI you can see.
- **The frame's hardware.** A camera cut-out, rounded screen corner or bezel
  that covers part of a framed screenshot belongs to the frame, not to the
  app. Do not count it as clipping or a safe-area fault.
- **Subject matter.** A podcast list is not better or worse than a tide chart.
  Judge how well each screen presents whatever it is presenting.
- **Image resolution and crop**, unless the UI itself is blurry or clipped.
- **Light versus dark** as such. Judge how well the chosen scheme is executed.
- **Fixture artifacts** in our own renders: placeholder text, a 0:21 / 1:00
  playback clock, grey artwork placeholders. These are test data, not design.

## The dimensions

For each one, decide whether A or B is better, or whether they are even. You do
not need a verdict on every dimension; skip one that the pair gives no evidence
on (for example iconography on a screen with no icons).

| # | Dimension | Definition | What "better" looks like |
|---|---|---|---|
| 1 | Visual hierarchy | How clearly the screen tells the eye what to look at first, second, third. | One obvious primary element; secondary and tertiary content visibly step down in size, weight, colour or position; nothing competes with the primary for no reason. |
| 2 | Typography | Choice, scale and handling of type. | A small, deliberate type scale (few sizes, few weights) applied consistently; comfortable line length and line height; type that has character without hurting legibility; no accidental mixes of families. |
| 3 | Colour and material | Palette, contrast, surfaces, depth, translucency, shadows. | A palette with a clear relationship between its colours; accents used sparingly and with meaning; surfaces and depth that explain layering; nothing garish, muddy or arbitrary. |
| 4 | Spacing and alignment rhythm | Margins, gutters, padding, and the grid edges share. | Consistent gutters; content sharing a few strong edges; spacing that groups related items and separates unrelated ones; room to breathe without wasted space; nothing cramped or drifting off the line. |
| 5 | Iconography | Icons and glyphs: style, weight, size, meaning. | One coherent icon family at matched weight and optical size; icons that are instantly legible; no text characters standing in for icons unless deliberate. |
| 6 | Imagery use | How artwork, photos and illustrations are framed and used. | Imagery that is sharp, consistently cropped and radiused, sized to its importance, and that carries meaning or mood instead of filling space. |
| 7 | Consistency | Whether the same thing looks the same everywhere on the screen. | Like elements (rows, cards, buttons, chips, radii) share one treatment; no one-off styles; states are distinguishable but related. |
| 8 | 2026 platform fit | How at home the screen is on a 2026 phone: iOS 27 (Liquid Glass) and Android with Material 3 Expressive. | Respects the platform's current idiom: translucent, layered chrome and floating controls (Liquid Glass) or expressive shape, colour and motion cues (M3 Expressive); sensible safe areas and bottom-reachable controls; does not look like a 2015 web page in an app wrapper. Platform-specific is not required; feeling current is. |
| 9 | Distinctiveness and brand | Whether the screen has its own recognisable point of view. | You could tell which app this is with the logo covered; a voice that is coherent and intentional, not generic template, and not novelty that costs usability. |
| 10 | Clarity of information | How fast a user understands what the screen is for and what they can do. | Purpose readable in a second or two; labels and data are unambiguous; the primary action is obvious; no clutter, truncation or overlap that hides meaning. |
| 11 | Polish and detail | Craft at the pixel level. | Crisp edges, aligned baselines, consistent radii and strokes, careful empty and long-text handling, no clipping, overlaps, stray borders or orphaned elements. |
| 12 | Visible accessibility signals | What the image itself shows about accessibility. | Text and controls with strong contrast (WCAG AA as a floor), tap targets that look at least 44pt, meaning not carried by colour alone, readable minimum text size. A judge cannot test a screen reader from a picture; judge only what is visible. |

## The verdict

The overall verdict is **holistic, not a sum.** Do not count dimension wins.
One severe failure (unreadable text, a broken layout, a garish palette) can
outweigh several small wins on the other side, and a screen can lose most
dimensions narrowly and still be clearly the better design.

Ask: *if a design-literate person had to ship one of these two screens in a
2026 App Store app, which would they ship?*

A **tie** is allowed when the two are genuinely equivalent or when the
differences pull in opposite directions with equal weight. Do not use a tie to
avoid a hard call; use it when the call really is even.

## What the judge returns

Exactly this shape (the protocol collects it as JSON):

```json
{
  "winner": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "decisive_reasons": [
    "2 or 3 short sentences, each naming a dimension and the concrete thing seen",
    "..."
  ],
  "dimensions": { "visual_hierarchy": "A" | "B" | "even" | "n/a", "...": "..." }
}
```

- `decisive_reasons` is required: **two or three** reasons, each tied to a
  dimension and to something visible in the images ("B's rows share one left
  edge; A's indent varies by 5-13px row to row"), never a generic adjective
  ("B is cleaner").
- `dimensions` is optional and advisory. It exists to make disagreement between
  judges diagnosable, not to compute the verdict.
