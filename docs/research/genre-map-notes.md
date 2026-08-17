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

## 2026-08-16 revision — six genres re-pointed at child nodes

The 2026-08 taxonomy review added 45 children and deliberately left this map
alone (`taxonomy-review-2026-08.md` §7). That was right about the general case
and wrong about six specific genres, where Apple's own label *is* the child.

**Reachable — changed:**

| Genre | Added | Why it is safe |
|---|---|---|
| Astronomy (200) | `space/astronomy` | The node's `apple_anchor` is literally `Science > Astronomy`; sampled titles are astronomy shows almost without exception |
| Music History (200) | `music/music-history` | Anchor is `Music > Music History` |
| Personal Journals (200) | `personal-journals/narrative-storytelling` | The only child anchored to this genre (its sibling `oral-history` anchors to History). Left at `low` confidence — Apple files this as a format |
| Sexuality (200) | `relationships/intimacy` | Anchor is `Health & Fitness > Sexuality`; the sample is sex/intimacy shows |
| Games (200) | `gaming/tabletop` | Apple's `Leisure > Games` is the *non*-video-game bucket — board, RPG, card, poker. Video-game shows have their own genre |
| Places & Travel (200) | `travel/destinations` | Anchor matches. Downgraded high → medium: ~25% of the genre is theme-park and cruise shows that belong on `travel/theme-parks` |

Additive only — no existing topic was removed from any entry.

**Not reachable, and why it stays that way.** A mechanical rule ("add the child
whose `apple_anchor` uniquely names this genre") generates eleven candidates and
five of them are wrong, because a *specialist* child can be the only one
anchored to a *broad* genre: it would put every Natural Sciences show on
`nature/paleontology`, every Mathematics show on `math/puzzles`, every Sports
show on `sports/biomechanics`, every Crafts show on `craft/woodworking`, every
Social Sciences show on `psychology/decision-making`. Anchor uniqueness is
necessary, not sufficient; the child also has to be the *general* home for that
genre. Judged by hand against a title sample, and the sample is why the list
above is six and not eleven.

Two declined on evidence rather than on the rule:

- **Home & Garden → `hobbies/gardening`.** Unique anchor, but the genre fuses
  two subjects and the titles split roughly half gardening, half home
  improvement. The shows already carry `craft/diy-home`, so the mapping would
  buy no reduction in root dumping and cost ~100 wrong tags.
- **Wilderness → `hobbies/outdoors`.** The node anchors to `Leisure > Hobbies`,
  not to Wilderness, and those shows already reach a child via
  `adventure/exploration`.

Everything else stays on its root because Apple genuinely cannot express the
distinction: **Food** has one leaf for eight children (this is the clearest
case — no genre map will ever put a barbecue show on `food/grilling-bbq`),
**True Crime**, **History**, **Technology**, **Philosophy** and **Video Games**
have no subcategories at all, and **Music Interviews** / **Music Commentary** /
**Documentary** / **Personal Journals** describe format, not subject. Those
branches need per-show LLM refinement or nothing.
