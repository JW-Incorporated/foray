# Retrieval on the Spark: deployment kit and runbook

GV-66 in [`docs/roadmap/generation-v2.md`](../roadmap/generation-v2.md) (from W3-22; covers GP-09 and R1-09), tracking issue #1286.

This runbook moves the transcript index and the corpus to the DGX Spark, so that the retrieval server (GV-16), its remote bodies (GV-54), the passage store (GV-28, GV-48) and the nightly chain run there. The kit is in [`tools/passage-index/deploy/`](../../tools/passage-index/deploy/). **Merging it installs nothing.** It does nothing until someone with hands on the Spark follows these steps.

## Who does what (D8)

Ruling D8 in [`docs/DECISIONS.md`](../DECISIONS.md) governs every step:

- Joey does the physical care and the OS upkeep.
- **Only the founder places secrets.** Here that means the R2 read key for `foray-transcriptions` and the retrieval token.
- Agents change the Spark only through merged PRs plus the **`spark-live` tag, which only the founder moves.** The Spark runs the code at that tag, never `main` or a branch.

No agent SSHes to the Spark, places a secret or moves the tag. The orchestrator's only live steps are on a generation box: setting `FORAY_RETRIEVAL_URL` and running `pull-archive.mjs`.

### Live steps

Every step that needs the Spark, a secret, the founder PC or R2. Nothing in this table is done by merging the kit.

| # | Live step | Who |
| --- | --- | --- |
| 1 | Disk budget sign-off from the R2 inventory (`sync-r2.mjs --list-only`) | Founder |
| 2 | Land the units through a Hermes repo PR and move `spark-live` to a commit that holds this kit | Joey (PR), Founder (approval and tag) |
| 3 | System setup: Node, the `foray` user, the data directory, `npm ci`, the embed runtime | Joey |
| 4 | Secrets: the R2 read key file, the retrieval token file, `/etc/foray/retrieval.env` | Founder |
| 5 | Body transfer: the normalized bodies and `corpus-digest.json` from the founder PC to the Spark | Founder or Joey |
| 6 | First build: stream-index, legacy map, warm, ingest, embed | Joey |
| 7 | Start the server, check `/healthz`, rebuild the shortlists, publish it on the tailnet over HTTPS | Joey (HTTPS certificates in the Tailscale admin console: Founder) |
| 8 | Record the measured disk and RAM numbers on #1286 | Joey |
| 9 | Enable the nightly timer, only as "Known gaps" allows | Joey, after the Founder's OK |
| 10 | Point generation at it: the token on the generation box, then `FORAY_RETRIEVAL_URL` and `pull-archive.mjs` | Founder (token), Orchestrator (URL and pull) |
| 11 | Rollback, when needed | Orchestrator (unset the URL), Joey (stop the units) |

## What runs where

| Where | What | Notes |
| --- | --- | --- |
| Spark | `foray-retrieval.service`: `serve.mjs` -> `backend/src/cli/retrievalServer.ts` | Long-lived. BM25 index resident, bodies only in R2 read through a 50 GB cue cache (`--r2`), the passage store and the query embedder. Binds **127.0.0.1:7311 only**. |
| Spark | `foray-index-nightly.timer` -> `foray-index-nightly.service`: `nightly.mjs` | 03:30. Stream-index delta from R2, warm, ingest, embed, reload, shortlists. Niced and CPU-capped. |
| Spark | SGLang behind LiteLLM (the Qwen lane) | Not part of this kit. It goes first (OQ-07), so both units yield to it. |
| Spark | `tailscale serve` | TLS on the tailnet, proxying to the loopback port. The only way another box reaches the server. |
| Founder PC | `data-local/transcripts/normalized/` (about 462 MB, 5,041 bodies, 22 shows) and `corpus-digest.json` | The source of the one-time body transfer (step 5). Most of these bodies were fetched from publishers by `tools/segments/fetch-transcripts` and are **not in R2**. |
| Generation box (the founder PC today; the Spark itself later) | `pull-archive.mjs`, and once GV-95 lands the pipeline's retrieval client | Reads the server over `https://` on the tailnet, or `http://127.0.0.1:7311` on the Spark itself. |

## Disk and RAM budget

These are the estimates the code makes, from the W3-01 inventory (GV-06) and the W3-05, W3-07 and W3-08 designs (GV-09, GV-28, GV-16). **None of them has been measured on the Spark yet.** Step 8 replaces each "estimate" with a measured number.

**Disk**, all under `/var/lib/foray/retrieval` (the repo's `data-local/`):

| Item | Size | Source |
| --- | --- | --- |
| Copied normalized bodies (`transcripts/normalized/`) | about 462 MB | the founder PC today |
| R2 normalized bodies | N bytes, **not mirrored** | `sync-r2.mjs --list-only` (step 1) gives N |
| BM25 postings caches (`transcripts/index/`) | estimate 0.4 x the bytes streamed | stream-index's disk guard (`POSTINGS_FACTOR`) |
| Passages file (`passage-index/nightly-passages.jsonl`) | estimate 1.1 x the bytes streamed, transient | removed after a successful embed |
| Passage store (`passage-index/passages.db`) | the passage text, plus 1-2M chunk vectors x 384 floats = 1.5-3 GB | GV-28 |
| Cue cache (`passage-index/cue-cache/`) | at most 50 GB | `--cue-cache-gb 50` in the server unit |
| Embedding weights (`models/`) | bge-small-en-v1.5, tens of MB | downloaded once at the first embed |
| Free-space floor | 20 GB kept free | stream-index refuses below it (`--min-free-gb`, exit 2) |

Outside `data-local/`: the embed runtime `tools/corpus/embed/node_modules` (about 373 MB), `backend/node_modules` and `tools/foraycorpus-export/node_modules`.

The founder signs off on (0.4 + 1.1) x (N + 462 MB) + the passage store + 50 GB + 20 GB free, before step 6. If disk is short, lower `--cue-cache-gb` in the server unit: cold episodes then fall back to per-body R2 GETs of about 100-300 ms each.

**RAM.** The Spark's 128 GB are unified memory shared with SGLang, whose KV cache comes first.

- The server is capped at `MemoryMax=16G`, with a 12 GB V8 heap (`NODE_OPTIONS=--max-old-space-size=12288`). Resident postings for every show are unmeasured. The dense index (brute force over 1-2M x 384 floats) is 1.5-3 GB outside the heap.
- The nightly is capped at `MemoryMax=12G`. Its `indexBodies` child holds one show's term counts at a time. The embedder runs bge-small on the CPU.
- Re-streaming the largest show costs up to about 306 MB.

Both caps are proposals. If the journal shows `JavaScript heap out of memory` or the unit is OOM-killed, raise the cap in a PR (D8), not by hand on the box.

## Install

Run every command as an admin on the Spark (aarch64, DGX OS / Ubuntu 24.04). The paths are fixed by the unit files.

1. **Code at the tag.** The same read-only, root-owned checkout the render worker uses ([`tools/narration/spark/README.md`](../../tools/narration/spark/README.md)):

   ```sh
   sudo git clone https://github.com/JW-Incorporated/foray.git /opt/foray   # first time only
   sudo git -C /opt/foray fetch --tags origin
   sudo git -C /opt/foray checkout --detach spark-live
   ```

2. **Node.** `/usr/bin/node --version` must print v22.13 or later (or v24). The server opens the passage store through `node:sqlite` without `--experimental-sqlite`, which needs 22.13 or later. Ubuntu's own `nodejs` package is too old, so install it from NodeSource or equivalent.

3. **Dependencies**, as root, in the checkout:

   ```sh
   cd /opt/foray
   sudo npm ci --prefix backend                      # tsx, which starts the server and indexBodies
   sudo npm ci --prefix tools/foraycorpus-export     # the AWS SDK for the R2 reads
   sudo npm install --prefix tools/corpus/embed      # the transformers embed runtime, about 373 MB
   ```

   The third line needs the founder's approval (the GV-28 founder need). The alternative is an embedding model served on the second box: then both units run `--embedder openai` and `/etc/foray/retrieval.env` fills in the `FORAY_EMBED_*` names. Change both units together, in one PR.

4. **The user and the data directory.** The checkout stays read-only. Every tool writes under the repo's `data-local/`, so that path is a symlink to the one writable directory:

   ```sh
   getent group foray || sudo groupadd --system foray
   sudo useradd --system --gid foray --home-dir /var/lib/foray/retrieval --shell /usr/sbin/nologin foray
   sudo install -d -o root -g foray -m 0755 /var/lib/foray
   sudo install -d -o foray -g foray -m 0750 /var/lib/foray/retrieval
   sudo ln -sfn /var/lib/foray/retrieval /opt/foray/data-local
   sudo install -d -o root -g foray -m 0750 /etc/foray
   ```

5. **Secrets (the founder, nobody else).**

   ```sh
   sudo install -m 0640 -o root -g foray /dev/null /etc/foray/retrieval.token
   openssl rand -hex 32 | sudo tee /etc/foray/retrieval.token > /dev/null
   sudo install -m 0640 -o root -g foray /dev/null /etc/foray/r2-read.env    # then write the R2 READ key into it
   sudo install -m 0640 -o root -g foray /opt/foray/tools/passage-index/deploy/retrieval.env.example /etc/foray/retrieval.env
   sudoedit /etc/foray/retrieval.env
   ```

   In `/etc/foray/retrieval.env`, set `FORAY_RETRIEVAL_TOKEN_FILE=/etc/foray/retrieval.token` and `R2_CREDENTIALS_FILE=/etc/foray/r2-read.env`. The credentials file uses the format in [`tools/foraycorpus-export/README.md`](../../tools/foraycorpus-export/README.md) and needs **Object Read** on `foray-transcriptions` only. Nothing in this kit writes to R2. No value goes into a unit file, the repo, a chat or an issue.

## Body transfer

The 5,041 normalized bodies on the founder PC are the plan's "move the 5,041 transcripts onto the Spark". Most were fetched from publishers by `tools/segments/fetch-transcripts` and are **not in R2**, so streaming R2 alone would lose them. Copy them and `corpus-digest.json` over the tailnet. `<spark>` is the Spark's tailnet name and `<admin>` the admin account on it.

From the founder PC, in WSL (Git Bash has no rsync):

```sh
cd "/mnt/c/Users/wjduv/Desktop/Vibe Coding/foray/data-local/transcripts"
find normalized -type f -name '*.json' | wc -l          # expect about 5041
find normalized -type f -name '*.json' -print0 | sort -z | xargs -0 sha256sum > bodies.sha256
rsync -a --info=stats1 normalized corpus-digest.json bodies.sha256 <admin>@<spark>:foray-transfer/
```

Without WSL, the same from Git Bash with tar over ssh: `tar -cf - normalized corpus-digest.json bodies.sha256 | ssh <admin>@<spark> 'mkdir -p foray-transfer && tar -C foray-transfer -xf -'`.

Then on the Spark:

```sh
cd ~/foray-transfer && sha256sum --quiet -c bodies.sha256      # must print nothing
sudo install -d -o foray -g foray -m 0750 /var/lib/foray/retrieval/transcripts
sudo rsync -a --chown=foray:foray ~/foray-transfer/normalized/ /var/lib/foray/retrieval/transcripts/normalized/
sudo install -o foray -g foray -m 0640 ~/foray-transfer/corpus-digest.json /var/lib/foray/retrieval/transcripts/corpus-digest.json
```

The bodies are public podcast transcripts; the copy stays inside the tailnet and on the two machines.

## First build

Each command runs as `foray`, with the unit's environment file and sandbox, through this helper (define it in the admin shell):

```sh
fr() { sudo systemd-run --quiet --wait --pipe --collect --uid=foray --gid=foray --nice=10 \
  --working-directory=/opt/foray -p EnvironmentFile=/etc/foray/retrieval.env -p CPUQuota=400% \
  -p ProtectSystem=strict -p ReadWritePaths=/var/lib/foray/retrieval /usr/bin/node "$@"; }
P=/opt/foray/data-local/passage-index/nightly-passages.jsonl
```

1. **The copied bodies.**

   ```sh
   fr tools/passage-index/stream-index.mjs --source local --full --passages-out $P | tee ~/build-local.log
   ```

2. **The legacy map**, from a listing of the bucket root (ListObjectsV2 only), then GV-53's resolver:

   ```sh
   fr --input-type=module -e '
     import { createR2Client, listPrefix, loadR2Credentials } from "./tools/foraycorpus-export/r2-client.mjs";
     import { classifyKey } from "./tools/foraycorpus-export/inventory.mjs";
     const creds = await loadR2Credentials();
     const client = await createR2Client(creds);
     for await (const o of listPrefix(client, creds.bucket, "")) if (classifyKey(o.key) === "legacy-root") console.log(o.key);
   ' | sudo -u foray tee /var/lib/foray/retrieval/passage-index/legacy-keys.txt | wc -l      # expect about 7531
   fr tools/generation/warm-transcript-index.mjs --resolve-legacy /opt/foray/data-local/passage-index/legacy-keys.txt
   ```

3. **R2: the farm-normalized bodies and the legacy whisper bodies.** Read "Known gaps" first: a show in both this build and step 1 keeps only this build's bodies.

   ```sh
   fr tools/passage-index/stream-index.mjs --source r2-all --full --passages-out $P | tee ~/build-r2.log
   comm -12 <(grep -o 'rebuild [^ ]*' ~/build-local.log | sort -u) <(grep -o 'rebuild [^ ]*' ~/build-r2.log | sort -u)
   ```

   The `comm` line lists the shows both builds wrote. It must print nothing. If it prints any show, stop and report the list on #1286 (see "Known gaps").

4. **Digest rows and the supply report** (GV-53). Post the supply report on #1163.

   ```sh
   fr tools/generation/warm-transcript-index.mjs --from-staged
   fr tools/generation/warm-transcript-index.mjs --supply-report
   ```

5. **Passage store** (GV-28). The first embed downloads the bge-small weights once into `data-local/models/`. Remove the passages file only after the embed succeeds, or the next nightly ingests it again and re-embeds every episode in it.

   ```sh
   fr --experimental-sqlite tools/passage-index/index-db.mjs ingest --passages $P
   fr --experimental-sqlite tools/passage-index/index-db.mjs embed --embedder transformers && sudo rm $P
   ```

stream-index exits 2 on `DISK_SPACE` before it reads a single body: free space, then run it again.

## The server unit

[`foray-retrieval.service`](../../tools/passage-index/deploy/foray-retrieval.service) runs, as `foray`:

```
/usr/bin/node tools/passage-index/serve.mjs --host 127.0.0.1 --port 7311 --r2 --cue-cache-gb 50 \
  --passages-db /opt/foray/data-local/passage-index/passages.db --embedder transformers
```

with `EnvironmentFile=/etc/foray/retrieval.env`, `MemoryMax=16G` and `ProtectSystem=strict` (only `/var/lib/foray/retrieval` writable). It needs the passage store from the first build, so enable it after step 5. Copy the units; do not link them:

```sh
sudo cp /opt/foray/tools/passage-index/deploy/foray-retrieval.service \
        /opt/foray/tools/passage-index/deploy/foray-index-nightly.service \
        /opt/foray/tools/passage-index/deploy/foray-index-nightly.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now foray-retrieval.service
journalctl -u foray-retrieval.service -n 50
```

Then rebuild the shortlists once. The token goes to curl from a file descriptor, never on its command line:

```sh
auth() { sudo sed 's/^/Authorization: Bearer /' /etc/foray/retrieval.token; }
curl -sS -X POST -H 'content-type: application/json' -H @<(auth) -d '{}' http://127.0.0.1:7311/v1/shortlist/rebuild
```

**Remote access: TLS on the tailnet, never plain http on the LAN.** The server binds 127.0.0.1 only. The bearer token must never cross a network in plain http, so the server is never bound to the LAN address (192.168.0.72) or 0.0.0.0, and `FORAY_RETRIEVAL_URL` never names that address over plain http. Another box reaches it through `tailscale serve`, which terminates TLS with the tailnet's certificate and proxies to the loopback port. The founder enables HTTPS certificates in the Tailscale admin console (DNS, HTTPS Certificates) and limits the Spark's tailnet ACL to the generation boxes.

```sh
sudo tailscale serve --bg http://127.0.0.1:7311
tailscale serve status        # shows https://<spark>.<tailnet>.ts.net -> http://127.0.0.1:7311
```

`tailscale serve` proxies from loopback, so the server cannot tell a tailnet request from a local one. That is why the token stays required on every `/v1` route even though the bind is loopback.

## The nightly timer

[`foray-index-nightly.timer`](../../tools/passage-index/deploy/foray-index-nightly.timer) starts [`foray-index-nightly.service`](../../tools/passage-index/deploy/foray-index-nightly.service) at 03:30 local time (`Persistent=true` runs a missed night once at boot). The service runs:

```
/usr/bin/node tools/passage-index/nightly.mjs --source r2 --url http://127.0.0.1:7311 --embedder transformers
```

at `Nice=10`, `CPUQuota=400%`, idle I/O class and `MemoryMax=12G`, so it yields to SGLang (OQ-07). It talks to the server over loopback, so its token never leaves the box. Enable it only as "Known gaps" allows:

```sh
sudo systemctl enable --now foray-index-nightly.timer
systemctl list-timers foray-index-nightly.timer
tail -n 8 /var/lib/foray/retrieval/passage-index/nightly.log     # one JSON line per step, {step: "nightly"} last
```

## Known gaps

Two limits of the merged code decide what the first build and the timer may do. Both need a follow-up card; neither is a Spark setting.

1. **stream-index builds each show from one source.** A run rebuilds a show from the source it lists and replaces that show's postings and manifest rows. A show with bodies on the founder PC **and** in R2 keeps only the bodies of whichever build ran last. Step 3's `comm` line detects this. If it lists any show, the fix is a stream-index source that merges local and R2 per show. Until then, report the list on #1286 and keep going only with the founder's OK, knowing those shows lost their copied bodies.
2. **`nightly.mjs` accepts only `--source r2` or `--source local`.** After an `r2-all` build, a nightly `--source r2` run sees every show that has legacy rows as changed, because the listing lacks the legacy keys. It then rebuilds those shows from the farm-normalized bodies alone and drops their legacy episodes, every night. Shows with only legacy bodies, or only copied bodies, are reported `gone` and kept. So **enable the timer only after `nightly.mjs` accepts `--source r2-all`** (follow-up), or on an index built with `--source r2` and no legacy bodies. Until then, run the delta by hand with `fr tools/passage-index/stream-index.mjs --source r2-all --passages-out $P`, then steps 4-5 and a reload, as often as the corpus changes. Regenerate the legacy map first (step 2), or it goes stale.

## Pointing generation at it

The server is inert until a generation box points at it. On that box:

1. **The token (founder).** Put the same token in a file only that user can read, for example `~/.foray/retrieval.token`, and set `FORAY_RETRIEVAL_TOKEN_FILE` to it. Never put it in argv, the repo or a chat.
2. **The URL (orchestrator).** On the Spark itself: `FORAY_RETRIEVAL_URL=http://127.0.0.1:7311`. On any other box: `FORAY_RETRIEVAL_URL=https://<spark>.<tailnet>.ts.net`, the `tailscale serve` address. Never a plain `http://` URL to a non-loopback host.
3. **The archive (orchestrator).** Keep a copy of the box's own digest, then pull the server's, so every derived item id matches the server:

   ```sh
   cp data-local/transcripts/corpus-digest.json data-local/transcripts/corpus-digest.before-pull.json
   node tools/passage-index/pull-archive.mjs
   ```

   `pull-archive.mjs` reads `FORAY_RETRIEVAL_URL` and the token from the environment and replaces `corpus-digest.json` whole, only when the answer validates.

The pipeline reads `FORAY_RETRIEVAL_URL` only once GV-95 (W3-11) lands. Until then only `pull-archive.mjs` uses it, and generation keeps today's local path. `FORAY_RETRIEVAL_MODE` stays `bm25` until the replay gate (GV-88) passes (decision 23).

## /healthz checks and the corpus guard

`/healthz` is open (counts only, no token):

```sh
curl -sS http://127.0.0.1:7311/healthz                  # on the Spark
curl -sS https://<spark>.<tailnet>.ts.net/healthz       # from a generation box
```

It answers `{indexVersion, shows, episodes, archiveGeneratedAt}`. Check after the first build, after each nightly and after each tag move:

- `episodes` is close to the line count of `/var/lib/foray/retrieval/passage-index/episodes.jsonl`;
- `shows` matches the shows in the build logs, less any the journal reports as left out (a stale cache with no body to rebuild from);
- `archiveGeneratedAt` moves forward after a nightly that streamed something.

A `/v1` route without the token must answer 401: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7311/v1/reload` prints `401`.

The run-start corpus integrity guard, GV-101 (W3-26, roadmap PKG-23), lands in a later wave. It checks the remote manifest at the start of a run. When it merges, its check joins this list.

## Rollback

1. **Generation (orchestrator):** unset `FORAY_RETRIEVAL_URL` on the generation box. Every run takes today's local path again. If `pull-archive.mjs` replaced the box's digest, restore `corpus-digest.before-pull.json`, or rebuild it from the box's own bodies with `node tools/generation/warm-transcript-index.mjs`.
2. **The Spark (Joey):**

   ```sh
   sudo tailscale serve reset
   sudo systemctl disable --now foray-index-nightly.timer foray-retrieval.service
   sudo rm /etc/systemd/system/foray-retrieval.service /etc/systemd/system/foray-index-nightly.service /etc/systemd/system/foray-index-nightly.timer
   sudo systemctl daemon-reload
   ```

The index, the bodies and the passage store stay in `/var/lib/foray/retrieval` until someone removes them. The secrets stay in `/etc/foray` until the founder removes them.

**After the founder moves `spark-live`:** repeat install step 1, re-copy the units, then `sudo systemctl daemon-reload && sudo systemctl restart foray-retrieval.service`.

## Privacy

- **No query logging.** Search requests carry beat claims. The server logs one JSON line per event to the journal with counts, latencies and a 12-hex sha256 prefix per query, never the query text. It writes only index caches built from transcripts and node shortlists built from taxonomy labels and transcripts, never from a request. The nightly has no query text at all.
- **Loopback bind plus token.** The server listens on 127.0.0.1 only, every `/v1` route needs the bearer token, and the only path from another box is TLS on the tailnet. This replaces the card's original "LAN bind plus token": a LAN bind would send the token in plain http.
- **R2 read only.** The Spark holds a read key for `foray-transcriptions`. Nothing here writes to R2 or publishes a Foray.
- No new data about listeners is collected, so the privacy policy is unchanged.
