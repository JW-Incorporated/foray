# 4a — NEWCOMER AUDIT

Six personas produced 83 complaints. I re-verified the load-bearing ones against the source rather than trusting the summaries; corrections to their line numbers and claims are marked inline. Everything below is quoted from files I opened this session. **No files were modified.**

---

## 1. THE FIRST FIVE MINUTES

### 0:00 — a dark rectangle with two glyphs

`init()` fetches `data/session.json` first (`app.js:11357`), then awaits nine more files in one `Promise.all` (`app.js:11379-11394`) before `state.ready = true; route();` at `app.js:11403-11405`. `index.html:61` ships `<main id="view"></main>` empty and nothing writes into it until `route()` runs. I measured the payload on disk: `discover.json` alone is **2457.7 KB**, plus `item-tags.json` 415.7 KB and `segments.json` 200.1 KB — roughly 3.5 MB cold, before one word of product appears. There is no skeleton and no spinner; the only failure copy, `"Couldn't load 4a — check your connection and reload."` (`app.js:11360`), fires only if `session.json` itself fails. Every other slow fetch shows nothing at all.

**This is the first comprehension break, and it happens before comprehension has anything to work on.** The user cannot distinguish loading from broken.

*(Correction to the brief: it claimed ten fetches in one `Promise.all`. It is one fetch then nine. Immaterial to the finding.)*

### 0:30 — the intro sheet, and the button most people press

The first-run sheet is the **only** place in the product that explains its differentiator: `"Forays: one subject, many shows"` and `"We clip the best parts of several podcasts on a subject and stitch them into one seamless listen, with a narrator bridging the gaps."` (`app.js:4117-4119`).

Both buttons are appended in this order: `actions.append(skip, go)` (`app.js:4138`), where `skip` is `"Skip for now"` (`app.js:4132`). The left button, first in the DOM, is the one that sets `cp_intro_dismissed` permanently (`skip.addEventListener("click", dismiss)`, `app.js:4143`). I grepped for a route that re-opens it. There is none.

**This is the second and more damaging break.** From here on, "Foray" appears in the drawer (`index.html:52`), as a Home section heading, and as a lowercase kicker over bare titles — and nothing in the app ever says what one is again. The differentiator becomes a nonsense word by design of the button order.

### 1:00 — Home, which contains no play button

`renderHomeV2()` renders the greeting, test-track notice, "Jump back in", "Forays for you", "Playlists for you", "Episodes for you". On a fresh install, "Jump back in" returns `""` (no history), and it is the only rail that calls `playBtn`. Everything else is a link:

- `epRow` is the only thing in the app with a real play control, and it lives one level down: `${inApp}${starBtn(item.id)}${upNextBtn(item.id)}${unavailable}` (`app.js:6569`).
- The "Episodes for you" cards route to `#/subject/<branch>` — a list page, not an episode.

Sixty seconds in, **every tappable thing on the front door is navigation.** Two taps minimum to hear audio.

### 2:00 — "Forays for you" is a section of one, and it is the wrong one

This is the finding I consider most serious in the entire audit, and I verified it by counting the data myself:

```
capital-types-1     published   items: 22   narration: 0
grilling-history-1  draft       items: 32   narration: 0
grilling-history-2  draft       items: 10   narration: 0
geology-plates-1    draft       items: 19   narration: 0
beyond-the-algorithm…  draft    items: 51   narration: 40
how-ai-actually-gets-built…  draft  items: 50  narration: 39
the-chain-reaction…  draft      items: 49   narration: 38
what-engineers-actually-do…  draft  items: 56  narration: 40
```

**The one Foray a newcomer can play contains zero narration items.** The four that carry narration (38–40 each) are all drafts, invisible without the founder's test-track switch. Ninety seconds after the onboarding sheet promised "a narrator bridging the gaps", the app delivers 22 clips butt-cut together with authored silence between them — and `player/seam-gap.js` says in its own header what that sounds like: *"That does not read as an edit. It reads as a glitch."*

The pitch and the shipped article disagree. No amount of copy fixes this one; it needs a publish.

### 3:00 — the tab bar teaches a map the drawer contradicts

`TAB_ROUTES` (`app.js:9232-9250`, read in full) is Home / **Search** / **Create** / Library. The drawer (`index.html:49-53`) is Home / **Shows** / **Playlists** / **Forays** / Up Next.

- `#/shows` is "Search" downstairs and "Shows" upstairs, and the page's own `<h2>` says "Shows".
- `#/playlists` sits under a tab called "Create".
- **Forays has no tab at all**, and `tabForHash` files `#/forays` under `library` — a page whose four sections are `libSection("Saved") / ("Playlists") / ("Up Next") / ("History")` (`app.js:7205-7208`) under the subtitle `"saved, history, playlists &amp; Up Next"` (`app.js:7203`). The tab lights up for a destination it does not list.

An Apple-trained user believes the bottom bar is the whole app. They will never open the hamburger, and therefore **will never find Forays.**

### 4:00 — the first tap on play, and the silence after it

Two compounding problems:

`bindPlay` does `const ok = await window.ForayPlayer.play(item, ...); if (!ok) { clearQueuePlaybackOrigin(); return; }` — no message, no line, nothing. The Foray page, by contrast, has a live `<p class="fy-error" id="fy-error" role="status" aria-live="polite" hidden>` (`app.js:8122`) and the copy `"That segment wouldn't load. Check the connection, then press play."` (`app.js:8526`). **The showcase surface gets the error handling; the surface a newcomer actually uses gets silence.**

Then, when the episode ends, it ends. See §3.

### Where comprehension actually breaks

In order: **(1)** a blank first second with no signal; **(2)** the Skip button that permanently deletes the only explanation of the product; **(3)** the one playable Foray not doing what the explanation promised; **(4)** two navigation systems with different names. Items 2 and 3 are the pair that matter — together they mean a newcomer meets the differentiator as an undefined word attached to an hour of unexplained audio that does not match its own pitch.

---

## 2. JARGON LEDGER

Every internal word I found in user-visible text. All line numbers below were opened and read this session unless marked **[persona-cited, not re-verified]**.

### The "segment" family — one object, five names

| Quoted string | file:line | Plain English |
|---|---|---|
| `aria-label="Previous segment"` / `"Next segment"` | `app.js:8109`, `app.js:8111` | "Previous clip" / "Next clip" |
| `isForay ? "Previous segment" : …` / `"Next segment"` | `player/client.js:2848-2849` | same |
| `` `${r.playable.length} segment${…}` `` | `app.js:7990` | "22 clips" |
| `${lost} segment${…} can't play — listed below.` | `app.js:8124` | "N clips can't play" |
| `"That segment wouldn't load. Check the connection, then press play."` | `app.js:8526` | "That clip wouldn't load…" |
| `"Jingle between segments"` | `app.js:9391` | "Jingle between clips" |
| `` show: `${show} · part ${index + 1} of ${total}` `` | `player/client.js:903` | "clip N of M" |
| `` ? `part ${Math.min(index, total-1)+1} of ${total}` `` | `player/media-session.js:426` | "clip N of M" |
| `Now on piece ${m.currentIndex + 1} of ${pieces}` | `player/segment-strip.js:422` | "clip N of M" |

The code has already decided the listener word: `forayBeatName()` returns `"this clip"` as its fallback. Nothing else follows it. Note the two counts that appear together genuinely disagree — the header counts bars, the strip counts items, so a listener sees "11 segments" and hears "piece 10 of 56".

### Broadcast / production vocabulary

| Quoted string | file:line | Plain English |
|---|---|---|
| `"Back to the running order"` | `player/client.js:624` | "Back to this Foray" |
| `` `Running order: ${parts.join(" and ")}, ${fmtSpan(m.totalSec)} in all.` `` | `player/segment-strip.js:407` | "56 clips from 5 shows, 1 hour 12 minutes in all." |
| `"Running order: nothing to play."` | `player/segment-strip.js:392` | "Nothing to play yet." |
| `"40 narrator bridges"` (assembled into the above) | `player/segment-strip.js:357` | "40 narrator links" or fold into the clip count |
| `"Barbecue: eight beats of a forty-beat history"` | `data/forays.json:284` | "Barbecue: eight chapters of a much longer history" |
| `"this act"` ×14, `"Act one"` ×1, `"last act"` ×2, `"acts back"` ×1 — **spoken aloud** and printed via `narrationScriptHtml` | `data/forays.json` (18 occurrences of these patterns; the brief claimed 30 across a wider set) | "this part", or the section's own title |

**On "beats" specifically, since you asked:** `grilling-history-2` is `status: "draft"`, so it does not reach an ordinary visitor today — but it renders through the normal path the moment it publishes or anyone uses `?foray=`. Worth knowing before you rule: `docs/curation/grilling-history-assembly.md` records the title as *deliberately* unflattering — the point was to admit the Foray covers 8 of 40 beats rather than overpromise a history of barbecue. **The honesty is right; the word carrying it is the one word a listener cannot decode.** "Eight chapters of a much longer history" keeps the disclosure and loses the jargon.

### Raw developer strings shown to listeners

| Quoted string | file:line | Plain English |
|---|---|---|
| `<p class="fy-out">Can't play: ${esc(entry.reason \|\| "unresolved")}</p>` | `app.js:7811` | "This clip isn't available right now." |
| ↳ feeding it: `` reason: `segment ${raw.segment_id} is not in data/segments.json` `` | `player/foray-resolve.js:304` | (keep in diagnostics only) |
| ↳ `` reason: `episode ${seg.item_id} is not in data/segment-sources.json` `` | `player/foray-resolve.js:312` | (diagnostics only) |
| ↳ `reason: "not an object"` | `player/foray-resolve.js:265` | (diagnostics only) |
| ↳ `"not queued"` | `player/foray-resolve.js:472` | (diagnostics only) |

A listener is being shown the name of a JSON file on a server they have never heard of, on the product's showcase page.

### Settings and secondary screens

| Quoted string | file:line | Plain English |
|---|---|---|
| `"Show draft Forays"` | `app.js:9395` | hide behind a debug unlock |
| `"Voice engine probe"` | `app.js:9400` | hide behind a debug unlock |
| `"Run the voice engine probe"` | `app.js:9416` | hide behind a debug unlock |
| `"What the player measured on this device: seam gaps, load deadlines, out-point overshoot, stops, resume decisions, and any press that didn't take."` | `app.js:10376-10377` | "Technical details about how audio played on this device. Stored here only, never sent anywhere." |
| `"That control didn't take. Try it again, or reload the page if it keeps happening."` | `app.js:8530` | "That didn't register. Try again." |
| `"Audition"` (button label) | `app.js:10168` | "Preview" |
| `"Tap Audition to hear it count to ten… Greyed voices are free downloads — fetch one in Settings…"` | `app.js:10127` | "Tap Preview to hear a sample line. Dimmed voices are free to download from Settings." |
| `"None of 4a's trial voices are installed here."` | `app.js:10251` | "None of the voices 4a suggests are installed on this device." |
| `"Reset to learned"` | `app.js:536` | "Back to 4a's pick" |
| `"Drag a slider to overrule what 4a has learned"` | `app.js:552` | "Drag a slider to change what 4a suggests" |
| `"Every clip plays from the show's own feed, so the download counts for them."` | `app.js:7974` | "Plays from the show's own feed." (or cut) |
| `<span class="hv2-stretch-tag">Stretch</span>` | `app.js:6388` | "Something different" — see §4 |

Taxonomy ids printed under each Interests slider (`engineering/energy-fusion`) — **[persona-cited; I verified the surrounding rows at `app.js:525-552` but did not isolate the id-printing line]**.

---

## 3. NEEDLESS DEVIATIONS vs. DELIBERATE ONES

### 3a. Needless — no benefit, nothing recorded

**Continuous playback is off, and the code cites a rule that was reversed.** This is the clearest instance in the audit of an implementation that is simply stale. `app.js:1595` is `function autoAdvanceOn() { return lsGet("cp_autoadvance", false); }`, and the comment above it (`app.js:1573-1594`) opens: *"CLAUDE.md product principle #1 explicitly bans 'autoplay chains' as a dark pattern."*

That is no longer what CLAUDE.md says. Principle 1 now reads, verbatim: *"**Continuous playback is NOT a dark pattern here and is wanted** — founder ruling, 2026-09-14: 'autoplay chains' should not be banned… I just want more podcasts to play while I'm in the car and can't pick something out for myself." When an episode ends, keep playing: the rest of the list, and then more of what fits.*

The code still implements the banned version, three times over in `advanceQueueOnEnded`: `if (!autoAdvanceOn()) return;` (`app.js:1660`), `if (!wasFromQueue) return;` (`app.js:1661`), and `if (!nextId) return;` (`app.js:1670`, commented "no pulling in more content"). The same stale citation appears again in `player/client.js:1527-1529`: *"the queue is one item (`SINGLE_ITEM`, product principle 1 — no autoplay chains), so `next`/`previous` are absent"* — which is why the steering-wheel skip buttons are dead. **Three separate surfaces built against a superseded rule.** This is not a design disagreement; it is drift.

**The car's play button is inert after launch.** `restoreLastEpisode()` (`player/client.js:2185-2200`) calls `setNowPlaying(rec, null)` then `render()` — which publishes full metadata to `navigator.mediaSession`. But `media.setActions(...)` is called in exactly two places, inside `play()` (`client.js:2108`) and `playForay()` (`client.js:2585`), and in neither the boot nor the restore path. **A session that publishes metadata but no handlers** is precisely founder report F5, quoted in the code at `client.js:1516`: *"pressed play on the car's controls, nothing happened."*

**A network stall is invisible and the app lies about it.** `client.js:2073-2075` subscribes `playing`, `waiting`, `stalled`, `ended` — and routes all four to `diag.mediaEvent(type)` only. Nothing paints. The header at `client.js:2061-2063` even says `waiting`/`stalled` "are the shape a network stall takes." The events are already captured; they just have one consumer.

**An error state names a gesture that does not exist.** `failed: "Couldn't load these episodes. Pull to refresh."` (`app.js:3166`). I grepped: `pull to refresh` appears twice in the whole file — that string and a comment at `app.js:2822` — and there is no touch handler implementing it. There is no Retry button beside it.

**A setting wired to nothing.** `drawerToggle("player-toggle", "Open in", () => playerPref() === "apple", …, { words: ["Pocket Casts (show page)", "Apple Podcasts"] })` (`app.js:9374-9377`). Its value reaches `playerPref()` (`app.js:702`), whose only non-label consumer is `playLink()` (`app.js:704`) — and my grep returns `playLink` exactly twice in 11,692 lines: its own definition and a comment at `app.js:1305`. **Nothing calls it.** The link-out it fed was removed by product rule; the switch outlived the feature, and it names a competitor in a three-item settings list.

**↻ means reload everywhere in software; here it navigates.** `app.js:11492-11497`: `buildCards(); logEvent("refreshed_all", {}); if ((location.hash||"#/") === "#/") renderHome(); else location.hash = "#/";`. The button is fixed in the topbar on every route (`index.html:37`). One tap on the universal refresh glyph discards your page and your scroll position. The only place its real meaning is written is `aria-label="New suggestions"`, which sighted users never see.

**No played/in-progress state on any episode row.** `epRow` (`app.js:6559-6571`) renders position number, title, `show · duration · date`, and three controls. No dot, no "NN min left", no progress bar, no mark-as-played. The app stores history and playback positions; it just does not render either where a listener scans. Episode 1 and episode 40 of a show look identical whether finished or never opened.

**Developer switches in every listener's Settings.** `bindDrawerToggles()` (`app.js:9364-9402`) appends "Show draft Forays" (`9395`) and "Voice engine probe" (`9400`) unconditionally — the comment at `9393` calls the first one *"his own switch, not listener behaviour"*, but nothing in the code restricts it to him. Flipping the second surfaces a button that blocks for ~90 seconds.

**Two dismiss controls flanking one destructive one.** `row2.append(rateBtn, openLink, forayLink, stopBtn, collapse)` (`player/client.js:636`) — "Stop" (`633`) immediately left of "Close" (`626`), plus a third dismiss in the grab row. *However*, see 3b: the persona's claim that Stop loses your place is **false**, and the arrangement itself is a recorded decision.

### 3b. Deliberate — recorded, principled, leave alone

- **Search field at the bottom.** The founder checked his own phone: *"the text field on Apple Podcasts search is definitely on the bottom. Let me share some pictures, they seem to have nailed it."* (`styles.css:1289-1293`), and the pill was built against those screenshots (`styles.css:1295-1306`). Do not move it.
- **No downloads.** Web `fetch()` cannot read CORS-less podcast CDN bytes, and the only workaround — proxying — is banned outright by principle 3 ("Never rehost/proxy/transform episode audio"). Native-only by construction, filed as #29.
- **Starring a show is inert.** Principle 2 ("State observed, never declared") plus the anti-echo-chamber floor. A followed-shows rail on Home is the exact failure mode `docs/brief/03_CURATION_SPEC.md` was written to prevent.
- **The Stretch slot and its bridge line.** Principle 1's ~30% exploration floor, plus copy rule 4: *"Stretch picks must state their bridge."* Test-pinned as a 1:1 invariant.
- **The disabled Foray half of the Create toggle.** D8: the pipeline exists, its key and segment pool do not; honest-disabled beats silently-inert.
- **"Stop" existing at all, separately labelled.** U-13 was adopted *because* the ✕ used to stop playback and the founder lost his place. The current arrangement is the fix, not the bug.
- **Browse cards hiding on search focus.** Founder #681, 2026-09-13, verbatim in `app.js:2114-2118`.

### 3c. Where a persona's Apple claim was NOT substantiated — flagging honestly

You asked for this explicitly, so here it is plainly:

1. **"Apple's search field is at the top."** Directly contradicted by your own recorded observation at `styles.css:1291-1293`. The persona argued for reversing a decision that came from your screenshots. **Reject that half.** What survives is only the *name* mismatch: the tab says "Search", the page's `<h2>` says "Shows".
2. **"Apple Podcasts has no disabled-with-apology control."** A universal claim about another app's entire surface. Unverifiable from this repo and almost certainly too strong. The load-bearing half — Apple has no top-level *Create* tab — is fair.
3. **"Stop next to Close, and only one keeps your place."** The premise is false. `stopAndClose()` opens with `if (persist) persistForayProgress({ force: true });` under the comment *"Closing the bar is not 'I am done with this Foray', it is 'get this off my screen'. Keep the resume point."* **Do not add a confirmation dialog** — there is nothing to confirm. What survives is cosmetic: Stop and Close share one CSS rule, so the labels do all the disambiguating work.
4. **"Apple shows a Download control inline on episode rows."** True in substance (Apple is download-first) but no file here measures Apple's UI; placement varies by surface. It does not change the conclusion, because downloads are blocked on web by CORS regardless.
5. **Several personas made no Apple comparison at all** (the Stretch/"your usual subjects" complaints, "Episodes for you"). Those stand or fall on 4a's own internal consistency, which is the stronger ground anyway.

---

## 4. EXPLANATION DEBT

Deliberate choices that read as bugs because nothing tells the listener why. One sentence each.

| What reads as broken | Why it is actually right | The one sentence of UI copy |
|---|---|---|
| Starring a show does nothing (`app.js:945`, only readers are the button's own paint and `renderStarredShows`) | Principle 2 + the exploration floor; a follow-feed is the documented failure mode | On `#/starred-shows`: **"A bookmark, not a subscription — 4a won't push new episodes at you, but your starred shows are always here."** |
| Saved episodes fail on a plane | Web CORS + principle 3 make downloads impossible outside native | Near Saved: **"Saved episodes stream from the publisher — you'll need a connection to play them."** |
| "Forays for you" shows one card about startup finance regardless of onboarding picks | Only a founder may publish a Foray; there is currently one | While the catalogue holds one: heading reads **"Forays"**, with **"Only one Foray is published so far — 4a stitches these by hand."** |
| The Foray half of Create is greyed out | D8 — honest-disabled beats silently-inert | Attach to the control, not a standing note above the form: **"Custom Forays aren't available yet."** (and delete the duplicate `title` attribute saying the same thing 40px away) |
| "Outside your usual subjects" on day one, when `loadInterests()` seeded from authored taxonomy weights and the user has no history | The bridge line is mandated by copy rule 4 | Cold-start variant: **"A deliberate change of pace into {subject} — 4a hasn't learned your subjects yet."** |
| "Stretch" badge, bold uppercase, over a muted italic explanation | The label+bridge pairing is test-pinned | Keep the pairing; change the word to **"Something different"** and let the bridge line carry the weight typographically |
| "Episodes for you" contains no episodes | The four-queue grouping is founder feedback F14, explicitly re-affirmed | Rename the heading to **"Subjects for you"** — it is the only one of the three rails that misdescribes its own contents |
| No playlist builder on Home, though Library says there is | Nothing — this one is just wrong (see §5) | **"No playlists yet — build one on the Create tab."** |
| A Foray is an unlabelled coloured bar with a title | Forays are the deliberate difference; the explanation was one-shot | Persistent subtitle on `#/forays`: **"One subject, many shows — clips from several podcasts stitched into one listen."** Plus `forayHeadSub`'s own computed "N clips · N shows · 51:22" on every card. |

---

## 5. FIX ORDER

Grouped so edits in one file are adjacent. **[C]** = copy-only, cheap and safe. **[B]** = behavioural, needs your ruling.

### Tier 0 — content, not code

1. **[B] Publish a Foray that contains narration**, or rewrite the onboarding sentence. `capital-types-1` (22 items, 0 narration) is the only thing a newcomer can play and it does not do what the pitch says. Nothing else in this report matters as much. *(Requires a founder publish — HUMAN-ACTIONS #2.)*

### Tier 1 — `app.js`, copy-only, one pass

2. **[C] `app.js:536, 552`** — "Reset to learned" → "Back to 4a's pick"; drop the taxonomy-id line under each slider.
3. **[C] `app.js:3166`** — replace "Pull to refresh" with copy naming a real control *(pairs with #16)*.
4. **[C] `app.js:6486`** — "Episodes for you" → "Subjects for you".
5. **[C] `app.js:7811`** — stop printing `entry.reason`; one sentence, raw reason to diagnostics.
6. **[C] `app.js:7974`** — cut "so the download counts for them".
7. **[C] `app.js:7990, 8124, 8526`** — segment → clip.
8. **[C] `app.js:8109, 8111`** — aria-labels → "Previous clip" / "Next clip".
9. **[C] `app.js:8530`** — "didn't take" → "didn't register".
10. **[C] `app.js:9391`** — "Jingle between segments" → "between clips".
11. **[C] `app.js:7193`** — "build one from the home screen" → "build one on the Create tab". *(The Playlists page's own empty state already gets this right two taps away.)*
12. **[C] `app.js:10127, 10168, 10251`** — Audition → Preview; "trial voices" → "the voices 4a suggests"; "Greyed" → "Dimmed".
13. **[C] `app.js:10376-10377`** — rewrite the diagnostics description in plain English.
14. **[C] `app.js:7280-7283`** — delete the duplicate `title` attribute; move the note under the control it explains.

### Tier 2 — `app.js`, behavioural

15. **[B] `app.js:1595, 1660-1670`** — default `cp_autoadvance` to **true** and drop the `wasFromQueue` gate. The comment at `app.js:1573-1594` cites a rule CLAUDE.md reversed on 2026-09-14. Rename the switch "Continuous playback". *This is the single highest-value behavioural change and your own ruling already authorises it.*
16. **[B] `app.js:3166`** — add a Retry button wired to the same fetch.
17. **[B] `app.js:6559`** — add played / "NN min left" / progress state to `epRow`. Data already exists; this is a rendering gap.
18. **[B] `app.js:7205-7208`** — add Forays and Starred Shows as two more `libSection`s, so the tab bar stops lighting Library for pages Library does not list.
19. **[B] `app.js:9374-9377` + `691-706`** — delete the "Open in" toggle, `playerPref`, `playLink`, `appleLink` together.
20. **[B] `app.js:9395, 9400, 9416, 10520`** — gate the four founder controls behind the same hidden unlock `?foray=` already uses.
21. **[B] `app.js:9232-9250` + `index.html:49-53`** — pick one vocabulary per destination, and decide whether Forays is a tab. *Strategic; your call.*
22. **[B] `app.js:11492-11497`** — show ↻ only on Home, or make it act locally.
23. **[B] `app.js:11376-11405`** — paint a skeleton before the awaits; move the six files Home's first paint does not need after `route()`.
24. **[B] `app.js:4143`** — give the Foray explanation a permanent home so "Skip for now" stops being destructive.

### Tier 3 — `player/`

25. **[C] `player/client.js:624`** — "Back to the running order" → "Back to this Foray".
26. **[C] `player/client.js:903`**, **`player/media-session.js:426`**, **`player/segment-strip.js:392, 407, 422`** — one word ("clip") and one count throughout; the strip's spoken label is the app's most jargon-dense sentence and the one surface where the user cannot see the picture that would explain it.
27. **[C] `player/client.js:2848-2849`** — aria-labels → clip.
28. **[C] `player/foray-resolve.js:265, 304, 312, 472`** — keep raw reasons, stop surfacing them *(pairs with #5)*.
29. **[B] `player/client.js:2185-2200`** — call `media.setActions(episodeMediaSurface)` at restore. Fixes the dead car play button (F5).
30. **[B] `player/client.js:2073-2075`** — add a second consumer for `waiting`/`stalled` that paints "Buffering…".
31. **[B] `player/client.js:1527-1548`** — register `next`/`previous` on `episodeMediaSurface` when the queue has neighbours; update the stale principle-1 citation in the comment.
32. **[C] `player/client.js:633` + `styles.css:1886-1889`** — give Stop distinct visual weight. Cosmetic only; do **not** add a confirmation.

### Tier 4 — `data/`

33. **[C] `data/forays.json:284`** — retitle away from "beats" before `grilling-history-2` publishes, keeping the fragment disclosure. Consider restoring the assembly doc's "A fragment: most of the history is missing" to the summary so the title stops carrying that job alone.
34. **[B] `data/forays.json`** — regenerate narration replacing "act" (18 occurrences of the phrases I grepped) with "part" or the section's own title. This is spoken aloud.
35. **[C]** Add "beat", "segment", "act", "running order" to the banned list in `backend/test/copyRules.test.ts`, which CLAUDE.md says already gates user-facing copy in `data/*.json` — it plainly did not catch line 284.

---

## 6. WHAT THIS COULD NOT ASSESS

Stated plainly, because several conclusions above would change if any of these turned out differently.

**Nobody ran the app.** Every finding is read from source. I did not load the page, tap anything, or watch it fail. Specifically unknown:

- **Actual first-paint time.** I measured bytes on disk (`discover.json` = 2457.7 KB, ~3.5 MB total). I did not measure it over cellular, through the service worker, or inside the Capacitor shell, where gzip and caching could make the blank second much shorter — or much longer.
- **Whether the car findings reproduce.** The `setActions` gap and the `stop`→teardown path are real in the code. Whether a given head unit maps a button to `stop`, and whether CarPlay masks the missing handlers, needs a phone and a car.
- **Whether the mis-tap claims are real.** The 12px Foray strip, the 22px reorder arrows, the ~114px title column, Stop-beside-Close — these are computed from CSS, not observed. Fingers may or may not miss. Every one of them is a candidate for "measured wrong" and none should be fixed on arithmetic alone.
- **How Apple Podcasts actually behaves today.** I could not run it. Where the repo carries your own screenshot-derived record I trusted that over the personas (§3c). Where it does not, I have marked the claim unsubstantiated rather than resolving it. Four persona complaints rest partly on Apple claims I could not check.
- **Whether newcomers press "Skip for now".** My §1 claim that the left-hand button is the one most people press is an assumption about human behaviour, not a measurement. It is the load-bearing assumption behind finding #24 and it deserves one real test before you spend effort on it.
- **The audio itself.** I counted that `capital-types-1` has zero narration items. I did not listen to it. Whether 22 butt-cut clips with 2s silences actually read as a glitch is a judgement `player/seam-gap.js` makes about a different Foray, and I am extending it.
- **Coverage.** Six personas and my verification pass are not a usability study. Nobody tested with a screen reader, at accessibility text sizes, on Android, offline, or with a genuinely cold cache.

**The one thing I would put a real person in front of before any of this:** a first-time user, given the phone, asked to play one episode and then to say what a Foray is. The first five minutes in §1 is a reconstruction from source. It should be cheap to falsify, and it is the part of this report most worth falsifying.