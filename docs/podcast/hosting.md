# Hosting the 4a podcast ourselves

Status: groundwork only (2026-10-20). Nothing here is live. There is no domain,
bucket, write token, artwork or Apple/Spotify account yet; the founder supplies
those later. The goal of this document and of `tools/podcast/` is that going live
is: **upload the audio and the feed, then point Apple and Spotify at the feed
URL.**

Why: the founder ruled on 2026-10-19 (#1425, `docs/DECISIONS.md`) that flagship
Forays ship as standalone podcast episodes, with every clip attributed and
listeners sent to the source shows. On 2026-10-20 he added: "Anything that we
can do now which is forward compatible to hosting our own podcasts is a good
idea."

## What exists

| thing | where |
|---|---|
| show-level manifest | `data/podcast/channel.json` |
| episode manifest (guid, show notes, audio keys + sha256, chapters, sources) | `data/podcast/episodes.json` |
| feed builder + validator | `node tools/podcast/build-feed.mjs` |
| render an episode (plan, fetch, bake, finish, manifest update) | `docs/podcast/rendering.md` |
| output (never committed) | `data-local/podcast/feed/feed.xml` and `chapters/<guid>.json` |

The audio files themselves are never committed. The manifest records where each
will live (its object key) and the bytes and sha256 it must have.

```
node tools/podcast/build-feed.mjs --check                        # are the manifests ready to publish?
node tools/podcast/build-feed.mjs --base-url https://HOST --include-drafts   # preview feed
node tools/podcast/build-feed.mjs --base-url https://HOST        # real feed: published episodes only
```

`--check` fails today, correctly: owner email, artwork and the channel link are
still null. It also refuses a changed guid (compared with git HEAD), duplicate
guids, a published episode without `pub_date`, bytes or sha256, a key that is not
content-addressed, and a description that does not name every source show.

## The plan

**Storage and delivery.** Cloudflare R2 (the project already uses R2) in one
bucket, public read, behind a custom domain (for example `podcast.<our domain>`;
never the `r2.dev` URL, which is rate limited and cannot be moved). The base URL
passed to the builder is that domain.

**Audio is immutable and content-addressed.** Each file lives at
`episodes/<episode guid>/<first 12 hex of its sha256>.<ext>` and is served with
`Cache-Control: public, max-age=31536000, immutable`. Because the key contains the
hash, the bytes behind a key never change, so a CDN or a player can cache it
forever and a half-finished upload can never be mistaken for a good one.

**The feed is the only mutable thing.** `feed.xml` and `chapters/<guid>.json` are
served with a short cache (`max-age=300`). Apple and Spotify poll the feed, so a
fix reaches them within minutes.

**Formats.** The feed's single enclosure is the mp3 (the most compatible). The
m4a is recorded in the manifest and uploaded as a spare; a
`podcast:alternateEnclosure` could advertise it later.

## Rules (these are what make the feed safe to move and fix)

1. **Never change a guid.** `episodes[].guid` is the episode's identity to every
   app. A new guid is a new episode: listeners get a duplicate and lose their
   place and download. `--check` compares with git HEAD and fails.
2. **Never change `podcast_guid`** in `channel.json`. It is the show's identity
   across feeds and directories. Podcasting 2.0 recommends a UUIDv5 of the feed
   URL so anyone can recompute it; the URL is unknown today, so we generated a
   random UUID. Tradeoff: it cannot be recomputed from the URL, but it also does
   not depend on a URL we might change, which is the whole point of a GUID. If the
   founder wants the UUIDv5 form, decide it **before the feed is first submitted
   anywhere**, then freeze it.
3. **Never reuse an object key.** Keys are content-addressed, so this is
   automatic: same bytes, same key; different bytes, different key.
4. **Republishing an episode = new audio key, same guid.** Re-master, run the
   manifest update (new bytes, sha256, key), upload the new object, then upload
   the feed. The old object stays (cheap, and a cached copy stays valid).
5. **The feed URL is permanent.** Pick the domain once. If it ever must move: keep
   serving the old feed with a `301` to the new URL and add
   `<itunes:new-feed-url>` to the old feed for at least a few weeks, then submit
   the move in Apple Podcasts Connect. The unchanged `podcast_guid` and episode
   guids make the move invisible to listeners.
6. **Attribution is not optional** (founder rule, #1425): the narration names the
   show for every clip, and the show notes list each source show with its Apple,
   Spotify and website links first. The builder refuses to publish an episode whose
   description does not name every source show.
7. Drafts never appear in a public feed. `status: "draft"` is the default; flipping
   to `"published"` needs a `pub_date`.

## Optional founder choice: download analytics

Hosting our own audio means we see only raw CDN requests. A prefix such as OP3
(open podcast analytics) would count downloads by redirecting through it: the
enclosure URL becomes `https://op3.dev/e/<our URL>`. It is free and open, but it
puts a third party in the download path and the URL is baked into the feed, so it
is a deliberate yes/no, not a default. The builder does not do it today.

## What the founder must supply before going live

1. A domain or subdomain for the podcast (and DNS control to point it at R2).
2. An R2 bucket for it, and a write token stored as a secret (never in the repo).
3. Square show artwork: JPEG or PNG, RGB, 1400 to 3000 px per side; record it in
   `channel.json` as `{ key: "channel/artwork-<sha256-12>.jpg", sha256, width, height }`.
4. An owner email (`channel.owner.email`), shown in directories and used for
   Apple's ownership check.
5. The final show name (the repo says "4a Forays" as a working title) and a show
   landing page for `channel.link`.
6. An Apple Podcasts Connect account and a Spotify for Creators account, to submit
   the feed URL.
7. Optional: the analytics prefix decision above; a funding link.
8. Then, per episode: set `status: "published"` and a `pub_date`.

## Future work: the upload command (not built)

There is no key, so there is no `upload` command, deliberately. Its contract, so
the work is already specified:

1. Read the manifests; refuse unless `--check` passes and the base URL is https.
2. For each published episode and the channel artwork: for every object key,
   `HEAD` it; if absent, `PUT` the local file with the immutable cache header and
   the right content type; if present, do nothing. After upload, verify the
   object's sha256 (or ETag/size) against the manifest and stop on any mismatch.
3. Upload the chapters JSON files (short cache).
4. **Put `feed.xml` last**, so the feed never points at an object that is not
   there yet.
5. Print the feed URL. Re-running is always safe (idempotent).
