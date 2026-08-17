# Genre → Taxonomy Map Notes

Built 2026-07-09 (`data/genre-taxonomy-map.json`). Source: `data/catalog-breadth.json` (19,787 shows).

## Counts
- 110 distinct genres (apple_genre and chart_genre_name share the identical 110-value vocabulary; one map covers both).
- 110 map entries; confidence: 79 high / 23 medium / 8 low.
- 67 new nodes: 12 new branches (news, true-crime, religion, kids-family, fiction, tv-film, health, education, personal-journals, relationships, hobbies, travel) + 55 subtopics.

## Judgment calls
- Sports got 12 new sport-specific subtopics (soccer...fantasy) so "Baseball" etc. can be high-confidence; Swimming/Running reuse existing `sports/endurance` (+`health/fitness`) rather than new nodes.
- "Tech News" → new `news/tech` + `computing` (news framing dominates over engineering).
- Cross-branch news genres map to branch pairs: Business News → news+business, Sports News → sports+news, Entertainment News → tv-film+news.
- "Improv" reuses `comedy/casual-hangs` (its existing apple_anchor is Comedy > Improv); Stand-Up and Comedy Interviews got new comedy subtopics.
- "Comedy Fiction" and "Film History"/"Music History" double-map into both relevant branches.
- "Life Sciences" → medicine/biology + science + nature; "Wilderness" → adventure/exploration + nature; "Nutrition" → health/nutrition + food; "Language Learning" → education/language-learning + linguistics/language.
- "Pets & Animals" placed under nature (content affinity) despite Apple filing it under Kids & Family.
- Arts subgenres landed under the existing `culture` branch (books, design, fashion, performing-arts) instead of a new arts branch.
- "Government" → new `society/government` + news/politics (medium); "Non-Profit" → new `business/non-profit` + society (medium).
- "Technology" umbrella → computing + engineering (medium): the catalog mixes gadget shows with software/AI shows.
- Exact-branch umbrellas (Comedy, Sports, Music, Business, News, Fiction, TV & Film, Kids & Family, Health & Fitness, Religion & Spirituality, History, Science, Arts) are medium: branch is certain, subtopic needs per-show refinement.

## Low-confidence (queued for LLM per-show refinement)
Society & Culture, Documentary, Personal Journals, Education, Courses, How To, Leisure, Hobbies — all are topic-agnostic umbrellas or formats where the genre says nothing about subject matter.


## 2026-08-16 revision — seven genres re-pointed at child nodes

The 2026-08 taxonomy review added 45 children and deliberately left this map
alone (`taxonomy-review-2026-08.md` §7). That was right about the general case
and wrong about seven specific genres, where Apple's own label *is* the child.

**Get the baseline right first**, because the interesting claim is easy to
overstate: **72 of the 110 genres already reach a child node**, and 66 of those
did so before this change (`Baseball → sports/baseball`, `Books →
culture/books`, `Daily News → news/daily` and 63 more). The problem was never
that the map was uniformly coarse. It was coarse on exactly the branches the
taxonomy review had just given children to. After this change 38 genres map to
a bare root and nothing else.

**Reachable — changed:**

| Genre | Added | Why it is safe |
|---|---|---|
| Astronomy (200) | `space/astronomy` | The node's `apple_anchor` is literally `Science > Astronomy`; the sampled titles are astronomy shows almost without exception |
| Music History (200) | `music/music-history` | Anchor is `Music > Music History` |
| Personal Journals (200) | `personal-journals/narrative-storytelling` | The only child anchored to this genre (its sibling `oral-history` anchors to History). Kept at `low` confidence — Apple files this as a format, and a title sample is maybe a quarter narrative storytelling, the rest recovery, paranormal and chat |
| Sexuality (200) | `relationships/intimacy` | Anchor is `Health & Fitness > Sexuality`; the sample is overwhelmingly sex/intimacy shows |
| Games (200) | `gaming/tabletop` | Apple's `Leisure > Games` is the *non*-video-game bucket — board, RPG, card, poker. Video-game shows have their own genre |
| Places & Travel (200) | `travel/destinations` | Anchor matches. Dropped high → medium: 47 of 200 titles (24%) are theme-park, cruise or national-park shows wanting `travel/theme-parks` or `travel/outdoors-parks` |
| Wilderness (200) | `hobbies/outdoors` + `hobbies` | `hobbies/outdoors` is labelled "Hunting, fishing & outdoors" and 92 of 200 titles (46%) hit hunting/fishing keywords in the title alone. Dropped to medium: the climbing/MTB half is "outdoors" only in the broad sense, and `adventure/exploration` already carries that |

Additive only — no existing topic was removed from any entry.

### How the six became seven, and why a mechanical rule cannot do this

The obvious rule is "add the child whose `apple_anchor` uniquely names this
genre, where the genre currently maps to a bare root." Reproduce it and you get
**exactly 11 candidates. Eight of them are wrong**, because a *specialist* child
can be the only one anchored to a *broad* genre:

| Bad candidate | What the rule would do |
|---|---|
| Natural Sciences | every show → `nature/paleontology` |
| Life Sciences | → `nature/animal-cognition` |
| Mathematics | → `math/puzzles` |
| Social Sciences | → `psychology/decision-making` |
| Sports | → `sports/biomechanics` |
| Crafts | → `craft/woodworking` |
| Documentary | → `science/storytelling` |
| Music | → `craft/instrument-making` |
| TV & Film | → `craft/filmmaking` |

Only **three** of the seven changes above (Games, Music History, Personal
Journals) are in that candidate set at all. **Astronomy, Sexuality and
Places & Travel each have two children anchored to the same genre** —
`space/rockets` + `space/astronomy`, `health/sexuality` +
`relationships/intimacy`, `travel/destinations` + `travel/outdoors-parks` — so
they fail uniqueness, and Wilderness matches no anchor at all. Every one of the
seven was reached by reading a title sample and asking whether the node is the
*general* home for that genre or a niche that merely files under it. Anchor
uniqueness is neither necessary nor sufficient; it is a hint.

### Declined, on evidence

- **Home & Garden → `hobbies/gardening`.** Two children anchor to
  `Leisure > Home & Garden` — `craft/diy-home` and `hobbies/gardening` — and the
  titles split about half and half (93 of 200 hit gardening keywords). The genre
  already maps to `craft/diy-home`, so the mapping buys no reduction in root
  dumping and costs roughly 100 wrong tags. This is the clearest case where the
  right answer is per-show refinement.

### Not reachable at all, and why that is the honest ceiling

The 38 genres still on a bare root are there because Apple cannot express the
distinction:

- **`Food`** is the clearest case in the file: one Apple leaf for eight
  children. **No genre map will ever put a barbecue show on
  `food/grilling-bbq`** — that is per-show judgement, and it is why `food` does
  not move a single pair in this pass.
- **True Crime, History, Technology, Philosophy, Video Games** have no Apple
  subcategories at all (or, for Philosophy, two children with equal claim).
- **Music Interviews, Music Commentary, Documentary, Society & Culture,
  Education, Leisure, Hobbies** describe format or are umbrellas — they say
  nothing about subject. Note `Personal Journals` was in this list until this
  revision and has now moved, on the evidence above, to a low-confidence child.

Those branches need per-show LLM refinement or nothing.
