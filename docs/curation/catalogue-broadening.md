# Broadening the catalogue — the PodcastIndex bulk dump, measured

Follow-up to `docs/curation/grilling-foray-sourcing.md` §6 option A, which
recommended the keyless PodcastIndex bulk feed dump on the strength of its
*existence* ("I measured its reachability and size; I did not download it, so
treat its column list as unverified"). This pass downloaded it, queried it, and
crawled what it nominated.

Authorised by Wyatt: *"if the current list of shows is too small then let's
broaden it."*

Two questions to answer, and the second one is the more important:

1. Does the whole 4.71M-feed index contain sources for the traditions we could
   not source at all — braai, yakitori/robata, Korean BBQ, Mexican
   barbacoa/al pastor, Filipino lechon, tandoor, churrasco, mangal/kebab, asado?
2. Is the dump a viable **ongoing ingest path** for this repo's keyless
   automation, or a one-off research tool?

Short answers: **it opened four traditions that were empty — churrasco, asado
from inside the tradition, yakitori and (thinly) Mexican — added two
Korean-language sources behind the one English Korean episode we already had,
and it proved that braai, tandoor, mangal/kebab and Filipino lechon are not
sourceable at all.** Every new source is non-English, which is its own problem
(§3). And the dump is a **research tool, not an ingest path** — §2 has the
numbers.

The machine-readable output of this pass is
`docs/curation/grilling-asr-manifest.json`.

---

## 1. What the dump actually is

Everything below was measured on 2026-08-16 on the laptop, with no local
transcription running.

| | |
|---|---|
| URL | `https://public.podcastindex.org/podcastindex_feeds.db.tgz` |
| Credential required | **none** — but see the User-Agent trap below |
| Compressed size | **1,800,345,567 bytes** (1.80 GB) |
| `Last-Modified` | Sun, 09 Aug 2026 19:17:08 GMT — **7 days stale** when fetched |
| Download | **378.0 s at 4.76 MB/s** |
| Decompress (`tar -xzf`) | **280.0 s** |
| Decompressed size | **5,040,103,424 bytes** (5.04 GB) |
| Peak disk, both files | **6.84 GB** |
| Rows | **4,710,545 feeds** in ONE table, `podcasts`, 40 columns |
| Indexes | **one** — `sqlite_autoindex_podcasts_1`, on `url`. No FTS. |
| Episode table | **none. This is the finding that shapes everything.** |
| Reader | Node 24's built-in `node:sqlite`, zero dependencies — the repo root stays dependency-free |

**The User-Agent trap, and it is a real operational gotcha.** A default `curl`
request gets **HTTP 403** with this body:

> You must set a proper User-Agent string that identifies your application.
> Sample code UA strings, default http library UA strings and generic or vague
> UA strings are not allowed.

With `ForayBot/0.1 (+https://github.com/JW-Incorporated/foray; wjduvall@gmail.com)`
it returns 206/200 immediately. So the resource is genuinely keyless, but any
runner that fetches it with a default agent fails closed with a 179-byte file
that is not a gzip. Anything we automate here must set the UA explicitly.

**Freshness.** `stats.podcastindex.org/daily_counts.json` reported 4,712,165
feeds; the dump carries 4,710,545. The dump is a weekly-ish snapshot running
about 1,600 feeds and 7 days behind the live index.

**Scale relative to us.** Our catalogue is **138,470 unique feeds** after
normalising scheme, case and trailing slash (`grilling-foray-sourcing.md` §5.1
says 138,480, counting raw strings). The dump is **34x larger**; we hold
**2.94%** of it.

---

## 2. Is it a viable ongoing ingest path? No — and the reason is structural

The keyless/$0 constraint is satisfied. Three other things are not.

**(a) It is a FEED index, and our unit of curation is the EPISODE.** There is no
episode table, no per-episode enclosure, duration, or `<podcast:transcript>`
tag. The columns that look episode-shaped — `newestEnclosureUrl`,
`newestEnclosureDuration` — describe only the single newest item. But the
question this project actually asks is *"which episode of which show explains
the tandoor?"*, and the dump cannot answer it for any show. Every real answer
in §3 came from **fetching the feed XML ourselves** after the dump nominated
the feed. The dump shortens the candidate list; it never produces the answer.

**(b) Every query is a full table scan.** With one index, on `url`, a
`LIKE '%term%'` query over 4.71M rows costs:

| query | cost |
|---|---|
| One scan of `title`, 60 terms OR'd | **651.0 s** (10.9 min) |
| One scan of `title` + `description`, 45 terms × 2 fields + 10 category columns | **1806.1 s** (30.1 min), yielding 1,013,490 rows |

So exploratory work is unworkable at one query per half hour. The fix is to
materialise a working subset once (the 1,013,490-row `subset.db`, 1.07 GB, food
/ history / culture / documentary / places / travel / cooking categories plus
any tradition-term match) and query *that* — after which every question is
instant. Building an FTS5 index over the dump would be the tidier version of
the same idea; **I did not measure that build cost**, because index-building is
sustained CPU and the whisper queue owns the machine this week.

**(c) The disk and time budget does not suit a nightly cloud runner.** 1.8 GB
down, 5.04 GB unpacked, 6.84 GB peak, ~11 min of download and ~5 min of
decompress before a single row is read — against a GitHub Actions runner's
~14 GB of scratch. Possible; wasteful every night, for a source that only
refreshes weekly anyway.

**Recommendation.** Treat the dump as a **periodic research tool** — pull it by
hand when a sourcing pass needs breadth, build the subset, throw both away.
Keep episode-level work in the existing feed-fetch path. If it ever becomes
routine, build the FTS5 index once at download time rather than paying for
repeated LIKE scans, and set the User-Agent.

**Do not commit any of it.** `data-local/` is gitignored (`.gitignore:11`,
verified with `git check-ignore`), and this pass left 7.91 GB there:
`feeds.db.tgz`, `podcastindex_feeds.db`, `subset.db`. Nothing fetched was
committed.

### 2.1 What the breadth was actually worth

The dump nominated **7,237 candidate feeds** (food/history-category feeds with
≥6 episodes active since 2022, in af/ja/ko/es/pt/tr/hi/ur/tl/fil/id/ms/zh, plus
146 English food/history feeds whose title or description names a target region
*and* a fire-cooking word).

**6,410 of those 7,237 — 88.6% — are not in our 138,470-feed catalogue.** That
is the concrete measure of what the chart-harvest ceiling was hiding, and it
corroborates the 79.6%-new figure the earlier Apple-search pass reported.

All 7,237 were then fetched and their episode titles searched: **6,942 fetched
cleanly, 295 (4.1%) errored** (dead hosts, TLS failures, timeouts).

---

## 3. What it found, tradition by tradition

Method for every candidate below: episode-level title match in the crawl →
fetch the feed → read the show and episode descriptions for the **content
gate** (is someone *explaining* something, with sourced expertise?) → measure
**ad-free delivery per episode** with the 2-byte ranged GET from
`tools/transcribe/ad-inflation.mjs` (HEAD lies; no HEAD was used) → check for
`<podcast:transcript>`.

Episode-level hits from the crawl, before any gate:

| tradition | episodes | shows |
|---|---|---|
| yakitori / robata | 97 | 43 |
| asado | 84 | 49 |
| churrasco | 66 | 39 |
| mangal / kebab | 52 | 26 |
| Mexican | 31 | 27 |
| Korean BBQ | 17 | 7 |
| tandoor | 7 | 6 |
| Filipino lechon | 4 | 4 |
| **braai** | **0** | **0** |

Raw hit counts flatter the result badly — most are recipe clips, restaurant
promos and daily-life vlogs. What survived all three gates:

### SOURCED — new, measured, content-gated

| Tradition | Show | Episode | Dur | Ratio | Transcript |
|---|---|---|---|---|---|
| **churrasco (Brazil)** | Paladar Distinto | #157 — Clarice Chwartzmann, *"Cultura e Tradição do Fogo"* | 41:54 | **1.0000** (bytes) | none |
| **asado (Rioplatense)** | Manual de parrilla (Magnolio Podcast) | "El ritual del asado: más que comida, una identidad nacional" | 9:53 | **1.0000** (bytes) | none |
| **yakitori (Japan)** | 火上料理人：The Meat Nerds (TW) | 百年燒鳥名店的老滷秘密 | 5:46 | bitrate-implied 256 kbps | none |
| **churrasco, 2nd** | 火上料理人：The Meat Nerds (TW) | 巴西Churrasco炭火烤肉 | 17:56 | bitrate-implied 160 kbps | none |
| **Korean BBQ** | 글로벌 미식 탐험대 \| 네모네AIM | 삼겹살's "forbidden history" | 12:35 | **1.0000** (bytes) | none |
| **Korean BBQ, 2nd** | 딩모니의 오디오 극장 | 특집) LA갈비, 그 유래는!? | 5:10 | **1.0000** (bytes) | none |
| **Mexican (al pastor)** | Contexto Culinario | CLIP: El taco al pastor #TBT | 8:08 | **1.0000** (bytes) | none |
| **Mexican (barbacoa)** | Charla Entre Cocineros | La barbacoa. | 14:51 | **1.0000** (bytes) | none |
| **Mexican (barbacoa)** | Secretos de la cocina… | T2 E20 — origin in Mesoamerica | 3:34 | **1.0000** (bytes) | none |

**The two finds that matter.**

- **Paladar Distinto #157** is the first genuinely Brazilian explanatory
  churrasco source this project has found. Clarice Chwartzmann is a *gaúcha*
  from Passo Fundo, Rio Grande do Sul, who learned churrasco as a child; the
  episode's stated subject is "a cultura e a tradição dos assados e das
  celebrações ao redor do fogo". A tradition bearer, not a host who read up.
  The earlier pass could find only interviews *with* Brazilians on American
  shows.
- **Manual de parrilla** is the first **Rioplatense** asado source. Every asado
  source in the previous pass was American-made — the sourcing doc's §3 says
  plainly "No Argentine or Uruguayan food podcast was found". This one is
  published by Magnolio Podcast, and the episode is explicitly about
  why asado is part of the cultural DNA of Uruguayans and Argentines, from
  gaucho roots to the family Sunday. Caveat kept honest: the show as a whole is
  a single-narrator tips-and-technique show; this one episode is the cultural
  entry and the other three are cuts, fire-lighting and choripán.

**The Meat Nerds** (Taiwan, 6 episodes) is the only explanatory yakitori source
found anywhere in 4.71M feeds. The tare episode is real mechanism — the
century-old "mother pot", the preservation and ageing science behind why it does
not spoil, why raw meat never touches the sauce. Two honest caveats: its
enclosures declare `length="1"`, so only the weaker bitrate-implied method
applies; and its emoji-heavy notes and 6-episode run warrant the same suspicion
as Culinary Connections until somebody listens.

### THE LANGUAGE PROBLEM — read this before celebrating

**Every new tradition source found in this pass is non-English.** Spanish
(asado, Mexican), Portuguese (churrasco), Mandarin (churrasco, yakitori),
Korean. The eight passages that already exist are all English.

That is not a transcription problem and no ASR budget solves it. Dropping a
Mandarin segment into an English Foray is a **product decision** — subtitle it,
narrate over it, accept mixed-language audio, or don't use it. It needs a
founder call, and until it is made, four of the newly-sourced traditions cannot
actually reach a listener. In the manifest every row carries `language` and
`english_audio` so the queue can be filtered either way: priority-1 rows are
8,902 s English and 3,453 s non-English.

### Rejected — and why

| Show | Tradition | Ratio | Reason |
|---|---|---|---|
| Naan Curry with Sadaf and Archit | tandoor | **1.0470 — injected** | 67-min kebab episode, exactly on brief. Measured on the decoded enclosure URL (the feed's `&amp;` produced a spurious 400 first time). |
| olive (Immediate Media) | tandoor | **unmeasurable / ~1.02 bitrate-implied** | "MAUNIKA GOWARDHAN on 10 things you need to know about tandoori cooking", 45 min, a real Indian cookbook author. Megaphone declares `length="0"` on every item, so the byte method cannot run; delivered bytes imply 163.4 kbps against a 160 kbps encode, i.e. light injection. |
| Gurmelik Denemeleri | mangal | 1.0000 | Content gate. Two hosts reminiscing about childhood mangal, published by *Boş Yapma Enstitüsü* — the Idle Talk Institute. Exactly the "hosts riffing with no sourced expertise" failure we have rejected before. |
| El Mundo en un Bocado | Mexican | **1.0159 — injected** | 47-min "Tacos al Pastor \| Prog 5". |
| Colombia sabe bien | lechon | 1.0000 | Colombian *lechona*, not Filipino, and the episode is a restaurant-founder profile (family, legacy, entrepreneurship), not tradition history. |
| Acı, tatlı, mayhoş | mangal | not measured | 1,770 episodes of ~4-minute recipe segments. |
| TOROMI RADIO (MBS) | yakitori | not measured | Guest yakitori chefs, but the format is restaurant-chat radio, not explanation. |
| 肉の丸一 (Japanese butcher) | yakitori | 1.0000 (prior pass) | Re-checked its episode list this pass: it is staff and supplier interviews — the president, the factory chief, the beef buyer, a sauce manufacturer. Trade content, not tradition history. |
| Yottan, 喫茶店ラジオ, さけばやしラジオ | yakitori | not measured | Daily-life vlogs and sake pairing that merely mention 焼肉. |
| Unlock Local | tandoor | 1.0000 | Right region, and no tandoor episode. Its Delhi episode is chaat's medicinal history and street-food vendors; guests are "an aspiring chef" and family members, not scholars. |

---

## 4. Still unsourceable after searching 4.71M feeds

**This is the most valuable part of this document.** These are not "in
progress". They are answers, and the answer is no.

- **braai (South Africa) — nothing, and the negative is unusually clean.**
  **Zero** episode-level hits for `braai`, `braaivleis`, `shisa nyama` or
  `potjie` across all 7,237 crawled feeds. Feed-level search of all 4.71M
  titles and descriptions returns only: Braai Day Podcast (5 episodes), Braai
  FM (3 episodes, Afrikaans, religion), braaiboy 3Speak (5), BRAAIMCast
  (Portuguese, business), Two Truths At A Braai (society chat), "Braai ? Times"
  (1 episode), and De Dutch BBQ Nestor (Dutch competition BBQ). For scale, the
  whole index holds **10 Afrikaans-language** food/history feeds with ≥6
  episodes active since 2022. **There is no braai podcast to find.** The Foray
  cannot cover braai from podcast audio.
- **tandoor (India / Central Asia) — nothing usable.** The dump did what Apple
  could not: it surfaced two genuinely on-topic episodes where the earlier pass
  found zero. Both fail the ad gate — Naan Curry at a measured **1.0470**, olive
  at a bitrate-implied ~1.02 with `length="0"` making a clean measurement
  impossible. So the earlier verdict stands, but for a *different and better
  reason*: tandoor content exists, and it is on ad-injecting hosts.
- **mangal / kebab (Turkey, Middle East) — nothing.** 52 episode hits across 26
  shows, and every one is a recipe segment, a döner-shop joke, or hosts
  reminiscing. The single episode that addresses why the mangal ritual exists
  is from a show whose name means "Idle Talk Institute". No Turkish food-history
  podcast with sourced expertise exists in the index.
- **Filipino lechon — nothing.** Four `lechon` episode hits, all
  Colombian/Venezuelan/Spanish *lechona*. The whole index holds **5
  Tagalog-language** food/history feeds with ≥6 episodes since 2022 (Filipino
  shows also publish in English, and the English half of the sweep found no
  lechon episode either). Exploring Filipino Kitchens remains the right show
  and still has no lechon episode.

**Mexican barbacoa/al pastor is a fourth case, distinct from these:** it is
now *weakly* sourced rather than empty — three ad-free Spanish episodes
(8:08, 14:51, 3:34), none authoritative, together probably worth one 90-second
passage. Better than nothing, not a solved slot.

### What this means for the Foray

The arc's world-traditions slot can now be built from satay, jerk, asado,
churrasco, Korean and (thinly) Mexican — six traditions, four of them only in
non-English audio. **Braai, tandoor, mangal/kebab and Filipino lechon should be
cut from the plan**, or covered by a narrator over material we cannot source as
tape. Wyatt should decide that rather than wait for a sourcing pass that has
now been run to exhaustion.

---

## 5. What would change these answers

- **The language decision.** It gates four of the six sourced traditions and
  costs nothing to make.
- **A 60-second listen to 글로벌 미식 탐험대.** If it is not machine-generated it
  is the best Korean row we have; if it is, it goes the way of Culinary
  Connections. Same test as the one the passages doc asks for on the Grill
  Coach braai episode.
- **Non-podcast audio for braai and tandoor.** Both verdicts above are scoped
  to *podcasts*. Radio archives, university lecture feeds and museum audio are
  outside everything we have searched, and braai in particular is a case where
  the medium, not the subject, is the constraint.
- **A timings-only alignment mode**, still the highest-leverage item in the
  whole transcription epic: it makes the Moreish jerk episode nearly free and
  generalises to every untimed publisher transcript we hold.
- **Nothing about the dump itself.** It has been downloaded, queried and
  characterised. Re-running it will not change §4; the index does not contain
  the shows.

*Housekeeping:* the scripts for this pass (dump download, subset build,
tradition selection, the 7,237-feed episode crawler, the per-episode probe) were
throwaway and are not committed, matching the precedent set by
`grilling-foray-sourcing.md` §5.2. If we run this a second time they belong
beside `ad-inflation.mjs` as committed scripts with a test floor, per workflow
rule 6 — with two lessons baked in: **set the User-Agent**, and **stream results
to disk as you go** (the first crawl died at 6,725 of 7,237 on a libuv exit
assertion and lost everything it was holding in memory).
