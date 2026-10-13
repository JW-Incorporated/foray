# Narration render worker on the DGX Spark: deployment kit and runbook

GV-58 in [`docs/roadmap/generation-v2.md`](../../../docs/roadmap/generation-v2.md), issue #862.

This kit runs the GV-22 render worker (`render-foray.py --worker`) on the Spark as a systemd service, with an upload timer that pushes each rendered line to R2. It also covers the GB10 render-speed benchmark. **Nothing here is installed by merging it.** It does nothing until someone with hands on the Spark follows this runbook.

Founder ruling #1076 removed only **on-device** Kokoro. Central render stays, so the engine is unchanged: Kokoro-82M, fp32, onnxruntime on the CPU, the profile in [`../render-profile.json`](../render-profile.json).

## Who does what (D8)

Ruling D8 ([`docs/DECISIONS.md`](../../../docs/DECISIONS.md)) governs every step:

- Joey does the physical care and the OS upkeep.
- **Only the founder places secrets.** Here that means the R2 write token for `foray-narration` (HUMAN-ACTIONS #119, #120 and #121).
- Agents change the Spark only through merged PRs plus the **`spark-live` tag, which only the founder moves.** The Spark runs the code at that tag, never `main` or a branch. This kit only becomes installable after its PR has merged and the founder has moved `spark-live` to a commit that contains it.

No agent SSHes to the Spark, places a secret or moves the tag.

## What is in the kit

| File | What it is |
| --- | --- |
| `foray-render-worker.service` | The long-lived worker. It runs `render-foray.py --worker /var/lib/foray/render-spool --threads 4` as user `foray-render`, at `Nice=10`, with `CPUQuota=400%`, `MemoryMax=6G` and `OMP_NUM_THREADS=4`. It holds no credential. |
| `foray-render-upload.service` | One pass of `spool-upload.mjs` over the same spool, as user `foray-upload`. That user's `~/.foray/r2-narration.env` holds the token. The unit names no credential. |
| `foray-render-upload.timer` | Starts the upload service 30 s after the previous pass ends. |
| `unit.test.mjs` | A static check of the three unit files. It confirms there is no credential, the worker runs `--worker` on a spool path, threads are bounded, and the argv is one the real `render-foray.py` accepts. |

### Why the threads are bounded

The Spark's CPU is shared with SGLang's host processes, which serve the Qwen lane. A worker that took every core would slow generation, so the worker is bounded four ways:

- 4 onnxruntime intra-op threads (`--threads 4`);
- 4 OpenMP threads;
- a 400% CPU quota;
- `Nice=10`.

`CPUQuota=` and `MemoryMax=` are only enforced for a **system** unit in `/etc/systemd/system`, which is how this kit installs. A **user** unit (`systemctl --user`) gets them only with cgroup delegation (`Delegate=cpu memory` on `user@.service`). Without delegation, systemd ignores them silently and only `--threads` and `Nice=` still apply. Do not install these as user units.

### Why fp32 only

The q8f16 graph returned NaN on ARM (recorded as HW-10). `render-foray.py` only loads the fp32 graph pinned in `tools/mobile/fetch-models.mjs`. Do not change that on the Spark, and do not pass `--onnx-models q8f16` to the benchmark below.

## Install (aarch64, DGX OS / Ubuntu 24.04)

Run every command as an admin on the Spark. Paths are fixed by the unit files.

1. **Code at the tag.** Check out the repo read-only, owned by root:

   ```sh
   sudo git clone https://github.com/JW-Incorporated/foray.git /opt/foray   # first time only
   sudo git -C /opt/foray fetch --tags origin
   sudo git -C /opt/foray checkout --detach spark-live
   ```

2. **System packages.** Install espeak-ng (the G2P fallback, GPL, server side only), ffmpeg and ffprobe, Python 3.12 venv support and Node 22 (the version CI uses; the uploader is a Node script). Ubuntu 24.04's own `nodejs` package is 18, so install Node 22 from NodeSource or equivalent, so that `/usr/bin/node --version` prints `v22`. Then install rclone, which `upload-narration.mjs` calls.

   ```sh
   sudo apt-get update
   sudo apt-get install -y espeak-ng ffmpeg python3-venv python3-pip rclone
   node --version   # must print v22.x at /usr/bin/node
   ```

3. **Python environment** (outside the checkout, so a tag move never touches it):

   ```sh
   sudo python3 -m venv /opt/foray-venv
   sudo /opt/foray-venv/bin/pip install -r /opt/foray/tools/narration/requirements.txt
   ```

   Do not install torch into this venv. The benchmark below uses its own environment.

4. **Users, group and state directories.** Use two users so that the process rendering repo code cannot read the R2 token:

   ```sh
   sudo groupadd --system foray
   sudo useradd --system --gid foray --create-home --home-dir /var/lib/foray/render-home --shell /usr/sbin/nologin foray-render
   sudo useradd --system --gid foray --create-home --home-dir /home/foray-upload --shell /usr/sbin/nologin foray-upload
   sudo install -d -o root -g foray -m 0755 /var/lib/foray
   sudo install -d -o foray-render -g foray -m 2770 /var/lib/foray/render-spool
   sudo install -d -o foray-render -g foray -m 0755 /var/lib/foray/narration-weights
   ```

   The spool is setgid `foray` and both units run with `UMask=0007`. The upload user can therefore rewrite `done/<job_id>.json` and remove a staged `upload/<job_id>/` that the worker created. The spool must stay on a local disk, because a job is claimed by rename.

5. **The token (the founder, nobody else).** The founder creates `/home/foray-upload/.foray/r2-narration.env` with the R2 write token for `foray-narration`, in the format HUMAN-ACTIONS #120 describes. It must be owned by `foray-upload` with mode `600`. It must never be written into a unit file, the repo, a chat or an issue.

## Check, then smoke

Run both as the worker user, against the same weights directory the service uses:

```sh
cd /opt/foray
sudo -u foray-render /opt/foray-venv/bin/python tools/narration/render-foray.py --check
sudo -u foray-render /opt/foray-venv/bin/python tools/narration/render-foray.py --smoke \
  --weights-dir /var/lib/foray/narration-weights --out /var/lib/foray/render-home/smoke
```

- `--check` must end with `ready to render.`. It reports the model and voice pins, the Python modules, and ffmpeg and ffprobe.
- `--smoke` renders the 2 shortest lines of the first draft Foray in both voices. It is also the step that **fetches and sha256-checks the weights** into `/var/lib/foray/narration-weights`. The service runs with `--no-download`, so the resident worker never reaches the network for weights. If the smoke fails, stop and report it on #862.

## Enable the units

Copy the units; do not link them. A unit change then reaches the Spark only when someone re-copies it from a `spark-live` checkout.

```sh
sudo cp /opt/foray/tools/narration/spark/foray-render-worker.service \
        /opt/foray/tools/narration/spark/foray-render-upload.service \
        /opt/foray/tools/narration/spark/foray-render-upload.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now foray-render-worker.service
sudo systemctl enable --now foray-render-upload.timer   # only after the token in step 5 is in place
systemctl status foray-render-worker.service
journalctl -u foray-render-worker.service -n 50
```

The worker log line `worker: <profile> resident (af_heart, am_echo), spool /var/lib/foray/render-spool` means it is up and waiting for jobs.

Until the founder has placed the token, leave the timer disabled. Rendered lines then wait in `SPOOL/upload/`, and nothing records a `public_url`.

**After the founder moves `spark-live`:** repeat install step 1 and re-copy the units. Then run `sudo systemctl daemon-reload && sudo systemctl restart foray-render-worker.service`. The worker keeps code in memory, so it must restart to pick up a new tag.

## The GB10 benchmark (#862)

The benchmark measures render speed for ONNX on the CPU and PyTorch on CUDA, using the existing kit. There is no ARM build of onnxruntime-gpu for GB10 that is known to work, so any GPU render path rests on the PyTorch number.

1. Set up the benchmark environment, **separate from `/opt/foray-venv`**: Route A (the NGC PyTorch container) or Route B (a uv venv with the cu130 torch wheel) in [`docs/voice/spark-benchmark.md`](../../../docs/voice/spark-benchmark.md).
2. Stop the worker so that it does not compete with the benchmark: `sudo systemctl stop foray-render-worker.service`. Note whether the Qwen lane was busy during the run.
3. Run both backends with the fp32 ONNX model:

   ```sh
   python tools/narration/bench-narration.py --check
   python tools/narration/bench-narration.py --only torch-cuda,ort-cpu
   ```

   The ORT CPU sweep includes `t4`, the thread count the service runs at.
4. Post `results.md` from the run's output directory on **#862**, and record NA-12 and MT-09 from it. For MT-09 (`render_ms` per audio second, as in GV-22's live step), read the `ort-cpu-fp32-t4` row, which matches the service's setting.
5. Start the worker again: `sudo systemctl start foray-render-worker.service`.

## Undo

```sh
sudo systemctl disable --now foray-render-upload.timer foray-render-worker.service
sudo rm /etc/systemd/system/foray-render-worker.service /etc/systemd/system/foray-render-upload.service /etc/systemd/system/foray-render-upload.timer
sudo systemctl daemon-reload
```

The spool and the weights stay in `/var/lib/foray` until someone removes them.
