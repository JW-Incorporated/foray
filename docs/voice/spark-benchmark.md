# Kokoro narration benchmark on the DGX Spark (measure only)

**Status:** a measurement kit, 2026-09-27. Nothing here changes how Foray narration is made or played.

**The founder's question:** *"We got a DGX spark. How quickly could that generate narration? I assume much faster than 1x. Maybe good to put a test on GitHub for Joey to run at some point."*

**Why only a measurement:** narration is rendered on the phone (`docs/kokoro-voices-in-app-plan.md`). Rendering it centrally is a back-pocket option that the founder has **not** adopted ("worried about scaling… keep that in our back pocket"). `docs/voice/kokoro-speed-1.5x.md` §3 lists it as "free on the GPU box" with no number attached. This kit supplies that number. It writes only under `data-local/` (gitignored) and uploads nothing.

## What it measures

`tools/narration/bench-narration.py` renders the app's own inputs:

- **Weights:** the Kokoro v1.0 ONNX export pinned in `tools/mobile/fetch-models.mjs`, and the PyTorch checkpoint `kokoro` loads (`hexgrad/Kokoro-82M` at a fixed commit, sha256-pinned in the script). Every file is sha256-checked before use.
- **Voices:** Heart (`af_heart`) and Echo (`am_echo`), the same `voices/*.bin` files for every backend.
- **Phonemes, not text:** the chunk ids already committed in the probe passage. The catalogue goes through `phonemize.py` (lexicon, misaki en-US, espeak-ng fallback) and is cut by its `sentence_chunks` rule, one inference per chunk, as on the phone.

| Backend | What it is |
|---|---|
| `torch-cuda-fp32` / `-bf16` / `-fp16` | `kokoro`'s `KModel` on the GPU. bf16 and fp16 use `torch.autocast`, with two parts kept in fp32 (see the note below the table). Every chunk is checked for NaN/Inf. |
| `torch-cpu-fp32` / `-bf16` | The same model on the 20 Arm cores. On the CPU, bf16 also keeps the LSTMs in fp32, because oneDNN has no bf16 LSTM on CPUs without native bf16. |
| `ort-cuda-fp32` | onnxruntime's CUDA execution provider on the fp32 ONNX graph (the iOS model). |
| `ort-cpu-fp32-t{1,4,10,20}` | onnxruntime on the CPU at 1, 4, 10 and 20 threads. |

**The two fp32 parts in the bf16/fp16 rows:**

- **The STFT/iSTFT head.** cuFFT has no half-precision FFT for Kokoro's n_fft of 20.
- **The SineGen harmonic source.** It integrates phase with a cumulative sum, which bf16 cannot hold.

These are the same parts `kokoro-speed-1.5x.md` option 4 keeps fp32 in its mixed-precision ONNX export.

Any backend that can't run is skipped, and the report says why (for example, "this onnxruntime build has no CUDAExecutionProvider").

| Workload | What it is |
|---|---|
| (a) probe | The 15-chunk passage in `tools/mobile/kokoro-probe-passage.json`. |
| (b) catalogue | All narration of every Foray in `data/forays.json` (four narrated Forays today), per voice. GPU backends only by default. |
| (c) batched | PyTorch only. Padded batches of 1, 4, 16 and 64 chunks, with a fidelity check against unbatched output. The pinned ONNX graph takes one input at a time. |
| (d) speed | 1.0 and 1.5 for (a) and (b). |

**Reported:** x-real-time (xRT = audio seconds ÷ wall seconds), per-chunk p50/p95 latency, finite y/n, peak GPU memory (PyTorch allocator), GPU power (nvidia-smi `power.draw`), load time and cold first-chunk time. From these it extrapolates to "N thousand Forays ≈ X hours" and GPU kWh.

**Read the extrapolation carefully:**

- It is based on the measured mean per-Foray time, summed over both voices.
- Rows whose basis is "measured catalogue" assume one process with no batching.
- Rows whose basis is "batched, batch N" use the batched throughput instead. Batching is measured on one voice, and every voice costs the same.
- CPU rows are "estimated from probe xRT" unless you pass `--catalogue-cpu`.
- The kWh figure is **GPU power only**. It leaves out the CPU, memory and the rest of the box. Pass `--system-watts <wall-meter W>` to add a whole-box column.

## Setup on the DGX Spark

The Spark runs DGX OS (Ubuntu 24.04, aarch64) with CUDA 13 on a GB10 (compute capability 12.1). `kokoro` and `misaki` need **Python 3.10–3.12**. Pick one of the two routes below; A is quicker to get right.

### Route A: NVIDIA's PyTorch container (NGC)

The command follows NVIDIA's DGX Spark PyTorch playbook ([NVIDIA/dgx-spark-playbooks, `nvidia/pytorch-fine-tune`](https://github.com/NVIDIA/dgx-spark-playbooks/tree/main/nvidia/pytorch-fine-tune), which uses `nvcr.io/nvidia/pytorch:25.11-py3`). Any newer `-py3` tag from [the NGC catalog](https://catalog.ngc.nvidia.com/orgs/nvidia/containers/pytorch) should also work. The container's Python is 3.12.

```bash
git clone https://github.com/JW-Incorporated/foray.git && cd foray
git checkout feat/narration-bench-spark        # or main, once the PR is merged

docker run --gpus all -it --rm --ipc=host \
  -v $HOME/.cache/huggingface:/root/.cache/huggingface \
  -v ${PWD}:/workspace -w /workspace \
  nvcr.io/nvidia/pytorch:25.11-py3

# inside the container:
apt-get update && apt-get install -y espeak-ng
pip install --no-deps kokoro==0.9.4             # --no-deps: keep NVIDIA's own torch build
pip install "misaki[en]==0.9.4" loguru huggingface_hub transformers
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

The last line must print `True` and the GPU name. If a `pip install` replaced NVIDIA's torch (the version no longer ends in `nv…`/`a0`, or CUDA shows `False`), start a fresh container and repeat with `--no-deps` on every package.

Optional, for the onnxruntime CUDA row. It's a nightly build, see "Uncertainties" below:

```bash
pip install --pre --index-url https://aiinfra.pkgs.visualstudio.com/PublicPackages/_packaging/ort-cuda-13-nightly/pypi/simple/ onnxruntime-gpu
```

Without it, install the CPU build instead (`pip install onnxruntime`). The ORT CUDA row is then skipped with its reason, and the ORT CPU thread sweep still runs.

### Route B: a uv virtualenv on the host

This route uses PyTorch's own CUDA 13.0 wheel index (`https://download.pytorch.org/whl/cu130`). It serves `manylinux_2_28_aarch64` wheels for Python 3.12 (checked 2026-09-27: torch 2.9.0 through 2.14.0). The DGX Spark community guides use the same index ([natolambert/dgx-spark-setup](https://github.com/natolambert/dgx-spark-setup), [martimramos/dgx-spark-ml-guide](https://github.com/martimramos/dgx-spark-ml-guide)).

```bash
sudo apt-get update && sudo apt-get install -y espeak-ng git curl nodejs
curl -LsSf https://astral.sh/uv/install.sh | sh && source $HOME/.local/bin/env

git clone https://github.com/JW-Incorporated/foray.git && cd foray
git checkout feat/narration-bench-spark        # or main, once the PR is merged

uv venv --python 3.12 .venv-bench && source .venv-bench/bin/activate
uv pip install torch --index-url https://download.pytorch.org/whl/cu130
uv pip install kokoro==0.9.4 "misaki[en]==0.9.4" onnxruntime
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

The version must end in `+cu130` and CUDA must print `True`. If you see `+cpu`, pip resolved a CPU wheel. Re-run the first `uv pip install` with `--reinstall`.

For the onnxruntime CUDA row, swap the CPU build for the CUDA 13 nightly, which has a cp312 aarch64 wheel:

```bash
uv pip uninstall onnxruntime
uv pip install --pre --index-url https://aiinfra.pkgs.visualstudio.com/PublicPackages/_packaging/ort-cuda-13-nightly/pypi/simple/ onnxruntime-gpu
```

### Weights (either route)

The script downloads and verifies what it needs on first run (about 330 MB for PyTorch, 326 MB for the fp32 ONNX, and two 0.5 MB voices) into `data-local/narration-bench/`. If you already ran `node tools/mobile/fetch-models.mjs`, it reuses the verified files in `mobile/models/`. A file whose sha256 does not match its pin is never used.

## Run it

```bash
python tools/narration/bench-narration.py --check    # lists what will run and what is skipped, and why
python tools/narration/bench-narration.py            # the full run
```

**Expected time on the Spark:** an estimate, since nobody has run it there yet. Roughly **30–60 minutes**.

- The GPU rows render the whole catalogue: 4 Forays × 2 voices × 2 speeds, about 54 minutes of narration per voice at speed 1.0. They should take a few minutes each.
- The CPU rows run the probe passage only. The slowest is ORT at 1 thread.
- The first run adds the downloads and about a minute of phonemizing (cached after that).

To bound the time, use `--only torch-cuda` (GPU only) or `--skip-cpu`.

**What to paste back:** `results.md` (the tables) and `results.json`. Both are in `data-local/narration-bench/results-<timestamp>/`, and the script prints the path at the end. The WAVs in `wav/` (one probe passage per backend) are for an ear check of bf16/fp16. Keep them local, or share them only if asked.

`--smoke` runs anywhere. It uses the CPU, the 2 shortest chunks and one voice, and checks that the script works rather than measuring anything. On the founder's PC (16 threads, memory-starved, Windows) it took about 6 minutes after the downloads. On an idle machine it should take a minute or two.

## Uncertainties, stated before the run

- **PyTorch on GB10 (sm_121).** The cu130 wheels and NGC containers support Blackwell. Community reports of `sm_121` warnings exist for some builds, though. If `torch-cuda-*` fails at load, Route A is the fallback.
- **onnxruntime CUDA on aarch64 is a moving target.**
  - PyPI's `onnxruntime-gpu` 1.30.0 ships aarch64 wheels, but they are built for CUDA 12.x, which the ORT install docs give as PyPI's default. They may not load on a CUDA 13-only box.
  - The CUDA 13 build exists only on Microsoft's nightly feed ([onnxruntime#27944](https://github.com/microsoft/onnxruntime/issues/27944), [install docs](https://onnxruntime.ai/docs/install/)).
  - Several people have hand-built wheels for the Spark instead (see the [NVIDIA forum thread](https://forums.developer.nvidia.com/t/onnx-runtime-gpu-inference-on-dgx-spark-gx10-build-guide-and-prebuilt-binaries/366157)).
  - If none of these load, the row is skipped with its reason. That's acceptable, because PyTorch-on-GPU is the number that matters.
- **Memory numbers.** The GB10 has unified memory, so nvidia-smi's `memory.used` may read `[N/A]`. "Peak GPU MB" comes from PyTorch's allocator, which covers PyTorch backends only.
- **Batched rendering is not bit-equivalent.** The decoder's InstanceNorm sees the zero padding of shorter items, and Kokoro draws random phase and noise on every call anyway. The batched table therefore reports log-spectral distance to unbatched output next to the floor between two unbatched renders. A batched renderer would need a listening check before anyone trusted it.
- **The catalogue is small.** Four narrated Forays, about 55,500 characters. "10,000 Forays" assumes future Forays are the same length.
