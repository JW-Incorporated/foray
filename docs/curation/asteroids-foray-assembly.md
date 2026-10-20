# Assembling `asteroids-flagship-1`: the rock that ended the dinosaurs

The running order for the first hand-built flagship Foray, why each seam sits
where it does, the full narration, and the one decision that shaped everything
else: **it was mastered as a single podcast episode first and a Foray second.**

Companion to `docs/curation/segment-length-rules.md` (the gate rules),
`docs/curation/narration-craft.md` (how a seam is written) and
`docs/curation/geology-foray-assembly.md` (the assembly this one is modelled on).
The Foray itself is `data/forays.json` → `asteroids-flagship-1`. That file is
the only record of the order, and §2 below is pinned against it row by row by
`tools/foray/check-forays.test.mjs`, so the two cannot drift apart.

**Status: draft.** A founder listens before anything is published. Directive
and decision records: #1286 (comments 6280684462 and 6281226053) and tracking
issue #1425. The founder's later rulings are recorded verbatim on #1425: the
Foray may also ship as a standalone podcast episode, every clip is attributed
in the narration with a pointer to the show, and the show notes lead with the
sources. Nothing has been uploaded or published.

---

## 0. TL;DR

| | |
|---|---|
| Segments in the running order | **12** |
| Tape runtime | **1,666.6 s — 27 min 47 s** |
| Playback runtime incl. narration | **1,920.3 s** in `data/forays.json` (narration estimated at 17 chars/s); the baked file measures **1,965.4 s — 32 min 45 s** (§7) |
| Mean / median segment | **138.9 s / 134.5 s** |
| Shortest / longest | 35.0 s / 220.24 s |
| Interquartile range | 100.73 s (R-7) |
| Episodes used | **9**, from **2 shows** |
| Shows | **Geology Bites** (8 episodes, host Oliver Strimpel) and **Being an Engineer** (1 episode, host Aaron Moncur) |
| Voices | **9 scientists and engineers**, plus the two hosts asking questions |
| Narration | **14 items, 4,312 characters**: 254 s estimated at 17 chars/s, **287.5 s as rendered (14.6 % of the baked file)**; written by AI, voiced by Kokoro-82M `af_heart` |
| Segments merged | `seg-2026-10-19-asteroids` (11) and `seg-2026-10-19-asteroids-bae` (1); 0 rejected |
| `transcript_source` | **`publisher`** everywhere |
| Ad safety | All 9 enclosures downloaded and measured: delivered duration = feed duration to within 1 s, so there are no inserted ads (§6) |
| Global rules missed | **None.** D1 5/8, D5 0 uniform pairs, M4 worst is Smit at 16.7 % of segments / 13.1 % beyond his longest clip. X1 holds at all 11 seams (§5) |
| Listen | `C:/w/helpers/flagship/listen/` holds the mastered `.m4a` and `.mp3`, chapters and show notes (§7) |

**The headline:** a Foray made of first-person researchers and one rendered
voice can carry a real story. The question is posed in the first thirty
seconds ("how can anyone know what happened that day, what hit us, and is
anything like it still out there?") and the last clip answers it in the
scientist's own words. Its weakness is the one the brief predicted: two shows,
eight of the nine voices from one interviewer, one register.

---

## 1. Why this topic, and the tape it could stand on

The topic was decided before this assembly (#1425). The coverage pass found
anchorable tape in Geology Bites and Being an Engineer only. This assembly
searched every held transcript (keyword pass over all 22 show folders in
`data-local/transcripts/normalized/`) and found more inside the same two shows
than the brief listed: Hal Levison on Lucy, Richard Ernst on the Deccan Traps
and Lindy Elkins-Tanton's update on Psyche's launch. Nothing outside those two
shows was worth its cost. The Stuff You Should Know candidates were "How
Extinction Works" (2014) and "How Asteroid Mining Works" (2011). Both have
inserted ads and would need a locate pass by local ASR, which measured 0.17x
realtime on this machine. Neither beats a researcher describing their own
finding. Radiolab was not pursued, for the same reason.

| prefix | voice | role then | show | episode |
|---|---|---|---|---|
| SMIT | Jan Smit | emeritus professor of event stratigraphy, Free University of Amsterdam | Geology Bites | Resolving a Single Hour of the Cataclysm That Ended the Cretaceous 66 Million Years Ago |
| MARSH | John Marshall | professor, University of Southampton | Geology Bites | the Riddle of the Mass Extinction 360 Million Years Ago |
| ERNST | Richard Ernst | scientist in residence, Carleton University | Geology Bites | Large Igneous Provinces |
| LEV | Hal Levison | principal investigator, NASA Lucy | Geology Bites | the Mission to Jupiter's Trojan Asteroids |
| CON | Harold C. Connolly Jr. | mission sample scientist, OSIRIS-REx | Geology Bites | Bringing an Asteroid Sample Back to Earth |
| RUS | Sara Russell | Natural History Museum, London | Geology Bites | What the Asteroids Can Tell Us About the Earth |
| OH | David Oh | systems engineering manager, Psyche (JPL) | Being an Engineer | S1E58 NASA, Systems Engineering, and Sending Robots to Space |
| WEISS | Ben Weiss | deputy principal investigator, Psyche (MIT) | Geology Bites | the Mission to Psyche |
| ELK | Lindy Elkins-Tanton | principal investigator, Psyche | Geology Bites | the Origin of Earth's Water |

Being an Engineer published the David Oh interview twice: S1E58 in December 2020
(`Buzzsprout-6986392`) and a 2022 rebroadcast (`Buzzsprout-11839351`). They are
the same conversation. The original is used because it has no rebroadcast
preamble.

---

## 2. The running order

Twelve segments, in argument order. Times are cumulative tape positions.
`tools/foray/check-forays.test.mjs` compares this table with
`data/forays.json` row by row (position, label, duration and role), and checks
the slot header rows against the declared slots. Fourteen narration items sit
between and around these rows (§4). They are on the listener's clock but not
in this table.

| # | at | label | duration | role |
|---|---|---|---|---|
| | **SLOT 1 — A fingerprint in the clay** (2 segments, 6:02) | | | |
| 1 | 0:00 | SMIT-1 | 220.24 s | explanation |
| 2 | 3:40 | MARSH-1 | 141.85 s | explanation |
| | **SLOT 2 — The first hour, read from a fish** (1 segment, 3:39) | | | |
| 3 | 6:02 | SMIT-2 | 218.55 s | explanation |
| | **SLOT 3 — Did the rock act alone?** (1 segment, 1:47) | | | |
| 4 | 9:41 | ERNST-1 | 106.95 s | explanation |
| | **SLOT 4 — What the rocks are, and fetching one** (3 segments, 5:47) | | | |
| 5 | 11:28 | LEV-1 | 78.30 s | explanation |
| 6 | 12:46 | CON-1 | 106.75 s | explanation |
| 7 | 14:33 | CON-2 | 161.90 s | explanation |
| | **SLOT 5 — A world made of metal** (4 segments, 6:54) | | | |
| 8 | 17:15 | RUS-1 | 127.10 s | explanation |
| 9 | 19:22 | OH-1 | 194.50 s | explanation |
| 10 | 22:36 | WEISS-1 | 57.55 s | quote |
| 11 | 23:34 | ELK-1 | 35.00 s | quote |
| | **SLOT 6 — Could it happen again?** (1 segment, 3:38) | | | |
| 12 | 24:09 | RUS-2 | 217.95 s | explanation |

**Tape runtime 1,666.64 s (27:47). Mean 138.9 s, inside the 75–180 s target
band. Eleven seams, ten of them cross-episode, and every one of them
narrated.**

### What each segment carries, and its exact boundaries

Boundaries are word-aligned, not caption-aligned (§6). "in" is the first word
the listener hears and "out" is the last.

| label | source span | in | out |
|---|---|---|---|
| SMIT-1 | 265.95–486.19 | "Before the recent discovery in North Dakota, what did we infer…" | "…that we had to deal with a very big impact." |
| MARSH-1 | 64.75–206.60 | "In the introduction, I said that we can fairly confidently explain…" | "…the mass extinction with the asteroid. That's unusual." |
| SMIT-2 | 617.75–836.30 | "So what happened when you visited the site and took a closer look?" | "…within about two hours or something." "Exactly." |
| ERNST-1 | 1428.00–1534.95 | "We also see a correlation between the emplacement of a large igneous province and a major mass extinction." | "…and acid rain can be an important component." |
| LEV-1 | 124.30–202.60 | "Can you explain how it is that the small bodies in the solar system have survived as fossils…" | "…these are the best places to go, I think." |
| CON-1 | 332.20–438.95 | "Let's talk about OSIRIS-REx specifically now." | "…anything has high scientific value that comes back from the asteroid at this point." |
| CON-2 | 786.80–948.70 | "But the greatest hope was that our collecting mechanism…" | "We were done one week ahead of time." |
| RUS-1 | 441.10–568.20 | "So you said that among the different kinds of asteroid…" | "…some clues about the origin and see if that is the case." |
| OH-1 | 1281.70–1476.20 | "You're the engineering manager for a mission called Psyche, Journey to a Metal World…" | "…technology that we still need to develop." |
| WEISS-1 | 1628.30–1685.85 | "I probably shouldn't ask you to speculate, but love to speculate…" | "…as to where these things are coming from." |
| ELK-1 | 1162.50–1197.50 | "What are you working on at the moment?" | "…so that we can get our science." |
| RUS-2 | 1037.55–1255.50 | "There's something else that I think you mentioned to me…" | "…and how hazardous they might be." |

---

## 3. The arc

The Foray asks one question in three parts, and every segment is a clue to one
of them:

1. **How can anyone know what happened that day?** The clay layer (SMIT-1), what
   an impact does to living things (MARSH-1), and a fish that died with impact
   glass in its gills (SMIT-2). Then a complication: the Deccan lava floods were
   erupting at the same moment (ERNST-1).
2. **What hit us?** Asteroids are the unused leftovers of planet building
   (LEV-1). The best way to know one is to go and grab a piece (CON-1, CON-2).
   Some are not rubble at all but metal, the bare cores of melted worlds
   (RUS-1), and one of them is big enough to visit (OH-1, WEISS-1, ELK-1).
3. **Is anything like it still out there?** Bennu, the asteroid OSIRIS-REx
   touched, has a small chance of hitting the Earth. A planet-wrecking impact
   comes about once every hundred million years, and the work now is mapping
   them (RUS-2). The closing narration answers all three parts in order and adds
   the one fact the tape cannot hold: DART has since shown that a small
   asteroid can be pushed.

It is a question, not a chronology. The chronology would run Smit, Marshall,
Ernst and then missions in launch order. This order instead keeps the
listener's question ahead of the tape.

### Why each seam is where it is

- **SMIT-1 → MARSH-1.** Smit ends on "we had to deal with a very big impact",
  which is a conclusion with no mechanism. Marshall's episode is about a
  different extinction, but his opening answer (what impact debris does as it
  falls back, "the temperature of a grill") supplies the mechanism. He then
  says unprompted that the iridium layer is "a singular thing", which closes the
  evidence question from a second voice.
- **MARSH-1 → SMIT-2.** Marshall describes debris raining back through the air.
  Smit's Tanis passage is that rain, caught in a fish's gills, so the return to
  Smit pays off a picture the listener already has. Splitting Smit around
  Marshall also breaks what would otherwise be about seven minutes of one voice.
- **SMIT-2 → ERNST-1.** By this point the story feels settled, and Ernst
  unsettles it on purpose: the Deccan pulse brackets the extinction, and he
  calls it "a joint effort". Smit's own episode ends on the same disagreement,
  which this Foray does not play. It is the one place where two authorities
  pull against each other, and it stops the first half being a victory lap.
- **ERNST-1 → LEV-1.** This is the hinge of the whole Foray, from "what killed
  them" to "what are these things". The narration does the turn: whatever the
  volcanoes did, the iridium says a rock arrived. Levison then answers the new
  question cleanly in 78 s.
- **LEV-1 → CON-1 → CON-2.** Leftovers, then going to get one. The two Connolly
  segments are 5.8 minutes apart in the source (M6), so a narrated hinge marks
  the elision and sets up the touchdown. Arrival and surprise, then the grab and
  the leak.
- **CON-2 → RUS-1.** Narration pays the Bennu story off (the capsule landed in
  2023 with about 120 grams) and turns to a different kind of asteroid. Russell's
  answer ends by naming Psyche, so the next seam is free.
- **RUS-1 → OH-1 → WEISS-1 → ELK-1.** Psyche from four sides: the meteorite
  scientist's reason, the engineer's description, the deputy PI's bet, and the
  PI's update. The update is the reason ELK-1 exists: OH-1 (2020) and WEISS-1
  (2022) both predate the launch slip, and her 35 seconds correct them on tape
  ("we launched in 2023, and we'll get to the asteroid in 2029"). The narration
  does not have to. The two short quotes sit together as a deliberate burst
  before the longest close.
- **ELK-1 → RUS-2.** Back to the opening question, and back to Bennu, so the
  third part of the question lands on an object the listener has already met.

---

## 4. Narration

### The balance: tape-led, narrator as guide

The founder asked for narrator-led "where possible, but not if that makes the
listening quality garbage". The decision is **tape-led with a visible
narrator**, at 14.6 % of the baked file (287.5 s of 1,965.4 s). The reasons:

- The only voice that can be rendered locally and centrally is Kokoro-82M
  `af_heart`, the current central render profile (`kokoro-fp32-aac64-v1`). It is
  a good small TTS voice, but against nine real researchers it still sounds
  synthetic, with even prosody and occasional misplaced stress. Long narrator
  stretches would make the synthetic voice the most-heard voice in the episode.
- The tape is unusually complete. Every beat of the question has a researcher
  saying it in the first person, so a Carry is never needed.
- What the narrator does carry is what tape cannot: who is speaking and on which
  show, where to find more, when a recording predates an event, and five dated
  facts after the recordings (OSIRIS-REx's landing and mass, Psyche's launch
  slip, Bennu's odds and DART).

### Attribution (founder ruling, #1425)

Every clip is named, with its show, before it plays, and every clip is pointed
to again after it with a different phrase ("there's a lot more of him in his
Geology Bites episode", "if you search the show for his name", "is a good
next listen", "has hundreds more conversations like that one, on Apple
Podcasts and Spotify"). Every script also sits outside the app's
transcript-clamp band (`NARRATION_CLAMP_CHARS` 277 ± 20, pinned by
`test/foray-row-links.test.js`): four lines were lengthened or shortened to
clear it. Spoken URLs are banned (`spokenLine.js` REFERENCE_LEAK_RE), so the
links live in the show notes, and the prelude and the close both point there.

### The full narration

Mode, approximate spoken length (17 chars/s), and script. All 14 items pass
`spokenLineErrors` and `narratorStructureErrors`.

1. **prelude** (marker, 28.6 s). "Sixty-six million years ago, the age of the dinosaurs ended in a single terrible day. How can anyone know what happened that day? What actually hit us? And is anything like it still out there? Nine scientists answer, in clips from two podcasts, Geology Bites and Being an Engineer. This voice, linking them together, is synthetic, and its words were written with the help of AI, so take it as a guide, and go to the full episodes for the real thing. They're all listed in the show notes."
2. **into-smit-1** (frame, 13.1 s). "The first clue was a thin layer of clay, the same in Italy, in Denmark and under the Pacific. Jan Smit, a geologist in Amsterdam, was one of the first to read it. He's talking to Oliver Strimpel, the host of Geology Bites."
3. **into-marshall** (frame, 18.0 s). "That was Jan Smit, and there's a lot more of him in his Geology Bites episode, linked in the show notes. So something enormous hit. But how does one rock kill animals on the far side of the world? John Marshall studies mass extinctions at the University of Southampton. Same show, in an episode of his own."
4. **into-smit-2** (patch, 19.0 s). "John Marshall. His full episode is about an extinction that no rock can explain, and it's well worth your time. Back to Jan Smit. In twenty nineteen, a fossil site in North Dakota called Tanis put a clock on that falling debris. Tanis is three thousand kilometres from the crater. Listen for what turned up inside the fish."
5. **into-ernst** (frame, 18.2 s). "Jan Smit again, from Geology Bites. If you search the show for his name, you can hear the rest of that day. So, one rock. Or was it? Around the same time, a huge stretch of India was being buried under lava, flow after flow. Richard Ernst wrote the textbook on these lava floods, and he's on Geology Bites too."
6. **into-levison** (marker, 13.9 s). "Richard Ernst. His Geology Bites episode is a good next listen. Whatever the volcanoes did, the iridium says a rock arrived. So what are these rocks? Hal Levison leads NASA's Lucy mission, now flying out to a swarm of them near Jupiter."
7. **into-connolly-1** (frame, 18.0 s). "Hal Levison, on Geology Bites. If asteroids are the leftovers of planet building, the obvious move is to go and pick one up. Harold Connolly, a geologist at Rowan University, is a sample scientist on NASA's Osiris-Rex mission. In twenty eighteen, the spacecraft reached a small, dark asteroid called Bennu."
8. **into-connolly-2** (hinge, 7.5 s). "Two years of mapping later, the spacecraft went down and touched the surface, for only a few seconds. Here's what came back up."
9. **into-russell-1** (patch, 20.0 s). "Harold Connolly, from his Geology Bites episode, recorded just after that touchdown. The capsule landed in the Utah desert in September twenty twenty-three, carrying about a hundred and twenty grams of Bennu. Not every asteroid is rubble, though. Sara Russell studies meteorites at the Natural History Museum in London. Geology Bites again."
10. **into-oh** (frame, 20.1 s). "Sara Russell, on Geology Bites. We'll hear from her once more before the end. The mission she mentioned is called Psyche. David Oh, an engineer at NASA's Jet Propulsion Laboratory, was its systems engineering manager. He's talking to Aaron Moncur, on a different podcast, Being an Engineer. This was recorded in twenty twenty, before launch."
11. **into-weiss** (frame, 17.6 s). "That's David Oh. Being an Engineer has hundreds more conversations like that one, on Apple Podcasts and Spotify. So is Psyche the exposed core of a broken baby planet, or something stranger? Ben Weiss of MIT is the mission's deputy principal investigator. Oliver Strimpel asked him for his own hunch."
12. **into-elkins** (correction, 12.3 s). "Ben Weiss, on Geology Bites, in twenty twenty-two. Psyche's launch then slipped by more than a year. Here is the scientist who leads the whole mission, Lindy Elkins-Tanton, in a later episode of the same show."
13. **into-russell-2** (frame, 8.8 s). "Lindy Elkins-Tanton, on Geology Bites. One question is left, the one we started with. Could it happen again? Back to Sara Russell, and back to Bennu."
14. **close** (marker, 38.6 s). "Sara Russell, on Geology Bites. So, what hit us? A rock from space, traced in iridium, in glass, and in the gills of a fish. Is another one out there? Yes, somewhere, some day. Bennu itself has roughly a one in two thousand seven hundred chance of hitting us. The riskiest single day is a little over a hundred and fifty years from now. But we are not just waiting. In twenty twenty-two, a NASA spacecraft called DART flew into a small asteroid on purpose, and shortened its orbit by about half an hour. The dinosaurs never had that option. Every voice you heard has a full episode waiting, on Geology Bites and on Being an Engineer. Go and listen to them."

### Claims the narrator makes that the tape does not

Each is in the accompanying text here, never spoken as a citation
(narration-craft §5f).

| claim | item | source |
|---|---|---|
| OSIRIS-REx reached Bennu in 2018 | into-connolly-1 | Connolly on tape: "arrived at asteroid Bennu in December 2018" |
| touch-and-go lasted a few seconds, about two years after arrival | into-connolly-2 | NASA, OSIRIS-REx TAG event, 20 Oct 2020 (contact about 6 s) |
| the capsule landed in Utah in September 2023 with about 120 g | into-russell-1 | NASA, OSIRIS-REx sample return 24 Sep 2023; the sample mass was later reported as 121.6 g |
| Psyche's launch slipped by more than a year | into-elkins | Weiss on tape (August 2022 plan) against Elkins-Tanton on tape ("we launched in 2023") |
| Bennu's impact chance is about 1 in 2,700, and its riskiest single day is a little over 150 years away (24 September 2182) | close | NASA/JPL, Farnocchia et al. 2021, *Icarus*: total 1 in 1,750 through 2300, single most significant date 24 Sep 2182 at 1 in 2,700 |
| DART hit a small asteroid in 2022 and shortened its orbit by about half an hour | close | NASA DART, impact 26 Sep 2022; Dimorphos's orbit around Didymos shortened by 33 ± 1 min (Thomas et al. 2023, *Nature*; NASA's first estimate was 32 min) |
| Tanis is about 3,000 km from the crater; it was announced in 2019 | into-smit-2 | the same Smit episode, outside the played clips: Strimpel at 836.9 s ("now we're 3,000 kilometers away from the impact") and in his introduction ("in 2019, the announcement of a new find in North Dakota") |
| a huge stretch of India was buried under lava at around the same time | into-ernst | Smit on tape (Deccan "erupted in the space of a few tens of thousands of years, more or less coincident with the end of the Cretaceous") and Ernst on tape |

---

## 5. Rule verdicts

`node tools/foray/check-forays.mjs` exits 0:

```
asteroids-flagship-1 (draft): 12 segments, 32.0 min, mean 138.9 s, foray mode
  D1 5/8 starts per 600 s   D5 0 uniform pair(s) (reported, not gated), IQR 100.73 s
```

| rule | budget | this Foray |
|---|---|---|
| D1 rolling cut budget | ≤ 8 starts / 600 s (≤ 45 min band) | **5** |
| D2 burst rule | ≤ 2 consecutive < 60 s, then ≥ 150 s | WEISS-1 (57.55 s), ELK-1 (35.0 s), then RUS-2 (217.95 s) — passes |
| D3 mean | ≥ 90 s | **138.9 s** |
| D4 quote share | ≤ 20 %, ≤ 2 adjacent | 2 of 12 (16.7 %), and the 2 are adjacent |
| D5 uniform pairs (reported) | 0 wanted | **0** |
| D5 IQR (R-7) | ≥ 45 s | **100.73 s** |
| L2 / L3 role bounds | explanation 60–360 s, quote 30–90 s | explanation 78.3–220.24 s; quote 35.0 and 57.55 s |
| L4 soft max | > 240 s needs `long_reason` | longest is 220.24 s, none needed |
| L5 share of source episode | ≤ 20 % | worst is RUS-2 at 16.0 % of its episode |
| M1 / M2 same-episode gap | < 45 s merge; 45–180 s flag | SMIT-1 → SMIT-2 elides 131.6 s (M2 flag). Kept separate on purpose: they are not adjacent (MARSH-1 sits between), and the elided span is the Tanis discovery story, which the narration condenses |
| M3 chronology | never out of order | clean (SMIT, CON and RUS each play in source order) |
| M4 concentration | ≤ 25 % of segments; ≤ 25 % of tape beyond the longest clip | worst count is 2 of 12 (16.7 %, four episodes). Smit beyond-longest is 13.1 % of tape; by plain share, Smit is 26.3 % of tape and 22.3 % of the baked file |
| M5 / M6 same-episode seam marked; > 5 min elision ⇒ narration | required | CON-1 → CON-2 elides 5.8 min and carries `into-connolly-2` |
| X1 cross-episode seam carries narration | required | **met at all 10 cross-episode seams**, and the one same-episode seam (CON-1 → CON-2) is narrated too |
| X2 bridge names its source | flag | every item names speaker and show |

**The S1/S2 lint and A1.** `prepare-segment-batch.mjs --lint` flags RUS-1's
"So, you said…" as a cold open (S1). It is the interviewer's question, which
names its own subject, so the flag is a false positive. A1 drops 9 of the 12
cuts, and §6 explains why that is the lint, not the cuts.

---

## 6. How the cuts were made, and the ad check

1. **Ad safety, measured on our own copies.** All 9 enclosures were downloaded
   once, and `ffprobe` durations compared with each feed's declared duration:
   Smit 1679.08 / 1679, Marshall 1519.86 / 1519, Ernst 1916.75 / 1916, Levison
   2247.86 / 2247, Connolly 1520.40 / 1520, Russell 1365.21 / 1365, Weiss
   1802.99 / 1803, Elkins-Tanton 1230.55 / 1230, Oh 3150.80 / 3150. There is
   no inserted audio anywhere, so publisher timestamps describe the file we cut.
   Being an Engineer is `dai_suspected: true` at show level in
   `data/dai-classification.json`, but this episode is byte-stable, and both
   anchors are present, as F-74 requires.
2. **Word-level edges.** Publisher transcripts are timed per caption cue (2–5 s,
   up to 75 s on Being an Engineer, whose cues are paragraphs). Each in and out
   point was re-transcribed in a ±14 s window with faster-whisper `base.en`
   (word timestamps). Each cut was then placed in the silence between two words:
   the in point about 0.2 s before the first word, the out point about 0.3–0.6 s
   after the last. Each edge was checked by reading the aligned words on both
   sides, and none lands mid-word or mid-sentence. The realtime factor was 0.17x
   (672 s of audio in 3,846 s).
3. **A1 disagrees, and is wrong here.** The lint wants each anchor to be the
   head (or tail) of the run of cues that lie *wholly* inside the segment. A
   word-aligned cut that starts partway through a cue therefore always "fails",
   because the first whole cue starts a few words later than the first word
   played. `merge-segments.mjs` (the CI gate) verified all 12 anchors verbatim
   against the publisher transcripts, within its 120 s tolerance, and merged
   them, with 0 rejected.
4. **Seams checked on the encoded file.** Every one of the 24 item boundaries in the encoded `.m4a` was re-transcribed. The check ran on the bake before the last narration rewrite; that rewrite changed narration only, so every clip edge is byte-for-byte the same cut. Each tape clip ends on its last word and starts on its first ("Before", "In the introduction", "So what happened", "We also see", "Can you explain", "Let's talk", "But the greatest hope", "So you said", "You're the engineering manager", "I probably shouldn't", "What are you working on", "There's something else"). No ad, music bed or show intro sits at any edge.
5. **One id collision avoided.** The pool already held
   `jan-smit…#609` (608.6–683.8 s, the paddlefish find alone). SMIT-2 starts at
   the next question (617.75 s) instead. It is both a cleaner opening and a
   distinct id (`#618`).

---

## 7. The baked episode

The founder ruled that a flagship Foray may also ship as a standalone podcast
episode. The mastered file is the primary listening deliverable. It is local
only and never committed:

- `C:/w/helpers/flagship/listen/the-rock-that-ended-the-dinosaurs.m4a`
- `C:/w/helpers/flagship/listen/the-rock-that-ended-the-dinosaurs.mp3`
- `C:/w/helpers/flagship/listen/chapters.txt` and `show-notes.md`

Pipeline (`C:/w/helpers/flagship/scripts/bake.py`): word-aligned clip
extraction; each item level-matched to the same integrated loudness (BS.1770 via
ffmpeg `ebur128`); 25 ms fade in and 80 ms fade out on tape; 15 ms on narration;
0.45 s of shared low pink room tone at every seam, so the file never drops to
digital black; then one two-pass `loudnorm` in linear mode to podcast spec, and
AAC 128 kbps plus MP3 128 kbps with embedded chapters.

| measured | `.m4a` (AAC 128 kbps stereo) | `.mp3` (128 kbps CBR stereo) |
|---|---|---|
| duration | 1,965.4 s (32:45) | 1,965.4 s |
| integrated loudness | **−16.1 LUFS** | −16.5 LUFS |
| true peak | **−4.0 dBTP** | −4.6 dBTP |
| loudness range | 3.3 LU | 3.3 LU |
| chapters | 14, embedded | 14, embedded (ID3 CHAP) |

Measured with ffmpeg `ebur128=peak=true` on the encoded files. Per item before
processing, tape arrived at −22.6 to −26.3 LUFS, with true peaks up to −4.8
dBTP. Narration arrived at −19 LUFS (the renderer's own master). Every item
leaves the chain at −16.0 to −16.2 LUFS (mono) with a −2.0 dBTP ceiling.

Two mastering mistakes were caught by measurement and fixed, and both are in
the lessons log:

1. **v1 used `loudnorm` on the whole mix and it went dynamic.** After level
   matching, the uncompressed interview tape peaked at +8 dBTP (Connolly's
   remote call), so a linear gain could not meet the peak target, and loudnorm
   switched to dynamic mode without failing. v2 compresses each tape clip
   gently (−20 dBFS threshold, 3:1) and then limits it at 4x oversampling, so
   no whole-mix dynamics run at all.
2. **Dual-mono measures 3 LU louder.** Items matched to −16 LUFS mono produced
   a −13.1 LUFS stereo master. The encode applies −2.9 dB.

Chapters (also in `chapters.txt` and the show notes):

| at | chapter |
|---|---|
| 0:00 | Introduction |
| 0:32 | Jan Smit: a fingerprint in the clay |
| 4:28 | John Marshall: how an impact kills |
| 7:11 | Jan Smit: a fish from the first hour |
| 11:11 | Richard Ernst: did the rock act alone? |
| 13:20 | Hal Levison: the leftovers of planet building |
| 14:55 | Harold Connolly: arriving at Bennu |
| 17:04 | Harold Connolly: the grab |
| 19:54 | Sara Russell: asteroids made of metal |
| 22:24 | David Oh: a world made of metal |
| 26:03 | Ben Weiss: a hunch about Psyche |
| 27:22 | Lindy Elkins-Tanton: on the way |
| 28:11 | Sara Russell: could it happen again? |
| 32:00 | Closing: what hit us, and what we can do now |

**The narration voice, honestly.** Kokoro-82M `af_heart` (the central render
profile) is clean, intelligible and correctly levelled. It is also recognisably
synthetic: prosody is even from sentence to sentence, questions do not lift
the way a person's do, and the voice lacks the small hesitations that make
the researchers sound present. Next to nine real people it reads as a polite
announcer. Its intelligibility was checked by an ASR round trip (faster-whisper
`base.en` over every rendered line, scored by the repo's `asr-check.mjs`). The
first render caught four real defects. "Treat" vanished from the start of a
sentence. "Read in iridium" came back as "red". "Bare core" came back as
"bear". The year 2182, spelled "twenty one eighty-two", came back as "two
thousand … hundred". All four lines were rewritten and re-rendered, and the
second pass heard them correctly. What remains flagged is spelling variants
(Sara/Sarah, Oh/O, Tanis/Tannies, Moncur/Monker, kilometres/kilometers), and
an ASR mishearing of a word cannot show whether a person would mishear it.
"Tanis", "Moncur" and "Smit" (heard once as "Smith") are the names most worth
checking by ear. It is good enough that the episode works. It is not good
enough to carry a narrator-led format, which is why this one is tape-led.

**In the app instead.** `?foray=asteroids-flagship-1` on a draft-capable
build plays the same order. The 14 narration items have no `audio_url` yet,
because rendered lines are stamped only after upload, and the R2 write token
lives on the Spark. The player therefore speaks them with the device's TTS
fallback (`player/foray-queue.js` `kind: "tts"`). To hear them in the
Kokoro voice in-app, the Spark render worker renders the draft
(`render-foray.py --forays asteroids-flagship-1`) and `stamp-narration.mjs`
stamps the URLs.

---

## 8. Would I listen to it?

Yes, and I would send it to someone. It opens on a question anyone has asked,
and the first ten minutes are the best tape in the pool: a fish with impact
glass in its gills is the kind of detail people repeat. The Psyche run is the
strongest stretch of voice variety, with four people and four angles in under
seven minutes, and the PI's own 35-second update is a rare case of tape
correcting older tape.

Four honest weaknesses:

- **One interviewer.** Eight of nine episodes are Oliver Strimpel's. His
  questions are good, but the room, the mic and the register barely change
  until David Oh arrives at 19 minutes. A second show in the first half would
  help most. No anchorable one exists on this topic.
- **The synthetic narrator is the most frequent single voice.** It speaks 14
  times. Keeping each line under about 20 s (except the prelude and the close)
  is the mitigation, not a cure. A human-read narration would lift this Foray
  more than any re-cut.
- **CON-2 is engineering detail.** The grab, the leaking flap and the stowage
  decision are vivid, but the middle 40 s (bolts, the nitrogen tube) are for
  enthusiasts.
- **The ending leans on narration for its last fact.** "Can we deflect one?" is
  answered by the narrator (DART), not by tape, because no held episode covers
  DART. Russell's segment answers "could it happen again?" in her own words,
  and that is the question the opening asks.

---

## 9. What this needs from the founder

1. **Listen** to `C:/w/helpers/flagship/listen/the-rock-that-ended-the-dinosaurs.m4a`, then decide whether it publishes as a Foray, as a podcast episode, or neither.
2. **The seed budget.** `tools/mobile/prepare-webdir.mjs` is a governed path, and this PR raises its `data/forays.json` budget from 44 to 56 KB (the reason is written at `PROJECTED_DATA`). `path-policy` stays red until a founder applies `founder-approved`. The alternative is a seed rule that carries curated drafts by reference. The next flagship will need that rule anyway.
3. **The narration voice.** Kokoro `af_heart` is serviceable but plainly synthetic (§7). A human or premium read of the 14 scripts would lift this episode more than any re-cut.
