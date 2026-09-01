# Feed fixture corpus

Real RSS feeds fetched on 2026-07-07 with the project's honest User-Agent
(`Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)`),
used by `test/parser.test.ts` to exercise the lenient parser against actual
publisher weirdness rather than hand-crafted XML. Per 01_PROMPT.md item 8
("build a fixture corpus of >=20 real-world weird feeds"), this is a starter
set of 8 varied hosts; grow it as new weirdness turns up in real usage.

| File | Show | Host | Notes |
|---|---|---|---|
| `lexfridman.xml` | Lex Fridman Podcast | self-hosted (WordPress/PowerPress) | truncated to 100 items (see below) |
| `titans-of-nuclear.xml` | Titans of Nuclear | Libsyn | 475 items, under 2MB — not truncated |
| `catalyst.xml` | Catalyst with Shayle Kann | Megaphone (known DAI host) | truncated to 100 items |
| `omegatau.xml` | omega tau | self-hosted (Podlove), audio via Libsyn `traffic.libsyn.com/secure/...` | see TLS + zero-duration notes below |
| `conan.xml` | Conan O'Brien Needs a Friend | Simplecast | truncated to 100 items |
| `fall-of-civilizations.xml` | Fall of Civilizations | Anchor/Spotify-for-Podcasters | small (21 items, ~58 KB) |
| `cleantechies.xml` | CleanTechies Podcast | Substack | HTML-in-CDATA show notes |
| `cbc-ideas.xml` | CBC Ideas | CBC's own podcasting CMS | |
| `malicious-doctype-entity-bomb.xml` | n/a — hand-crafted | n/a | **not a real feed.** Adversarial regression fixture for GHSA-8r6m-32jq-jx6q (fast-xml-parser DOCTYPE/entity-expansion DoS); see `test/parser.test.ts`'s dedicated "security regression" describe block. |

## Truncation (corner case 7: enormous back catalogs)

`lexfridman.xml`, `catalyst.xml`, and `conan.xml` were over ~2 MB as fetched
(2.09 MB / 2.24 MB / 2.73 MB). Per the fixture-corpus instructions, each was
truncated to its first 100 `<item>` entries (channel-level metadata and the
closing tags preserved) to keep the repo lean while still exercising
"first-sync back-catalog cap" behavior. `titans-of-nuclear.xml` (475 items,
1.34 MB) and `cleantechies.xml` (289 items, 1.58 MB) were left intact since
they're under the 2 MB line even with their full item count.

## Real-world weirdness encountered while collecting these

These are exactly the kind of findings 01_PROMPT.md asks to feed back into
the corner-case corpus ("when a real-world feed breaks an assumption, add it
to the fixture corpus and fix forward"):

1. **`itunes:duration` format diversity is real, not hypothetical.** Across
   just these 8 feeds we got every format the corner-cases doc predicted:
   bare seconds (`catalyst.xml`: `2266`), `MM:SS` (`titans-of-nuclear.xml`:
   `46:50`), `H:MM:SS` with no leading zero on hours (`lexfridman.xml`:
   `3:01:52`), and zero-padded `HH:MM:SS` (`cbc-ideas.xml`, `conan.xml`,
   `omegatau.xml`, `fall-of-civilizations.xml`: `00:54:08`, `05:28:38`).
   `src/feeds/duration.ts` handles all four without a format hint.

2. **`omegatau.xml` reports `itunes:duration = 00:00:00` on real, long
   episodes.** E.g. the "Helicopter Flight Test" episode has a 110 MB
   enclosure (clearly well over an hour of audio) but an `itunes:duration`
   of literally `00:00:00`. This is a direct, real-world confirmation of
   corner case 6 ("treat all metadata as hints... recompute duration from
   the downloaded file when it matters and reconcile") — the feed's own
   duration field is not just occasionally wrong, it's sometimes a
   structural constant the publisher's tooling never fills in.

3. **`omegataupodcast.net`'s TLS certificate was expired at fetch time**
   (`CERT_HAS_EXPIRED`, verified via Node's TLS stack, not a guess). The feed
   URL itself (`https://omegataupodcast.net/show/en/feed/mp3/`) also 302-
   redirects to `https://omegataupodcast.net/omegatau-en.xml` — so fetching
   this single feed exercises both an untrusted-certificate failure mode
   *and* a same-host redirect in one shot. This fixture was captured with
   certificate validation disabled purely to get real content for the
   parser test; the redirect resolver (`src/feeds/redirect.ts`) and the
   ingest worker's real HTTPS client must NOT do this in production —
   an expired cert on a feed host should surface as a poll failure with
   backoff (`src/feeds/politeness.ts`), not a silent bypass. This is a
   good live example for corner case 8 (hosts that don't behave politely)
   even though the underlying cause here is host misconfiguration, not
   rate-limiting.

4. **`cleantechies.xml` (Substack-hosted) embeds real HTML markup — `<p>`
   tags and smart-quote entities — inside `<description>` CDATA**, e.g.
   `<![CDATA[<p>#288 Lessons from 25,000 EV Ports...</p><p>How do you
   bring...</p>]]>`. This is exactly the "HTML soup in descriptions" corner
   case 5 describes; `src/feeds/html.ts` strips it to plain text for LLM
   input while preserving paragraph breaks as newlines.

5. **All 8 fixture feeds happen to be pure-audio (`type="audio/mpeg"`
   throughout)** — none surfaced the "video enclosure in an audio feed"
   corner case (6) or a missing/zero `length` attribute. Still open: add a
   fixture that does when one is found (a good next candidate is any show
   that simulcasts video and audio feeds of the same episodes).

6. **`lexfridman.xml` (WordPress/PowerPress) emits titles with numeric HTML
   entities for a literal ampersand** — e.g. `Rise &#038; Fall of Empires`
   instead of `Rise & Fall of Empires`. This surfaced a real gap in
   `fast-xml-parser`: despite `processEntities` defaulting to `true`, it
   only decodes the five predefined named XML entities (`&amp;` `&lt;`
   `&gt;` `&quot;` `&apos;`) — **not** numeric character references like
   `&#038;` or `&#38;`, even though those are core XML, not an HTML
   extension. Verified directly against the bare library (not just our
   wrapper). Fixed forward: `src/feeds/html.ts`'s `decodeEntities()` (used
   internally by `sanitizeHtmlToText` for descriptions) is now also applied
   to both feed-level and episode-level titles in `src/feeds/parser.ts`,
   so titles never leak raw entity codes downstream (into the DB, into an
   LLM classification prompt, or onto a card).

7. **~25 of the 100 `lexfridman.xml` episodes have no `itunes:duration`
   field at all** — not malformed, just entirely absent. On a large,
   actively-maintained, popular feed this confirms corner case 5's "no
   duration (common)" is not a rare edge case worth special-casing away;
   `duration.seconds === null, reasonIfNull === "missing"` is a routine,
   expected outcome the rest of the pipeline (duration reconciliation
   against the downloaded file) must handle as the common case, not the
   exception.

8. **Megaphone (`catalyst.xml`) and Anchor/Spotify (`fall-of-civilizations.xml`)
   are both on `src/feeds/politeness.ts`'s `KNOWN_DAI_HOSTS`-adjacent list**
   (Megaphone directly; Anchor is Spotify's creator tooling and increasingly
   ad-inserted) — good candidates for exercising `dai_suspected` detection
   once duration-variance-across-fetches tracking is wired up against a
   live database.

## Regenerating

There's no checked-in fetch script (kept the fixtures directory to just the
corpus + this README). To refresh: GET each feed URL above with the honest
User-Agent, save as `<name>.xml`, and re-apply the >2MB / first-100-items
truncation rule by hand for any that grew past the threshold.
