#!/usr/bin/env python3
"""How fast can one box render Foray narration with Kokoro? A MEASUREMENT, not a plan.

Wyatt, 2026-09-27: "We got a DGX spark. How quickly could that generate
narration? I assume much faster than 1x. Maybe good to put a test on GitHub for
Joey to run at some point."

Rendering narration centrally is the BACK-POCKET option. The live plan is
on-device Kokoro (`docs/kokoro-voices-in-app-plan.md`, and
`docs/voice/kokoro-speed-1.5x.md` §3's "floors only" row, which is where "free
on the GPU box" was last written down without a number). The founder has not
adopted server rendering ("worried about scaling... keep that in our back
pocket"), so this file only produces the number that decision would need. It
writes nothing outside `data-local/` and uploads nothing anywhere.

WHAT IT RENDERS, and why each piece is the app's own:

  * the Kokoro v1.0 weights: the ONNX exports `tools/mobile/fetch-models.mjs`
    pins (fp32 = iOS, q8f16 = Android), sha256-checked against THAT file's
    text, and the PyTorch checkpoint `kokoro` loads (hexgrad/Kokoro-82M),
    pinned below by commit and sha256 because the app never ships it;
  * Heart (`af_heart`, pinned in fetch-models.mjs) and Echo (`am_echo`, whose
    sha256 the plan deck records until KV-01 adds its pin) as the SAME
    `voices/*.bin` style matrices for every backend;
  * PHONEMES, not text: the probe passage's committed ids, and for the
    catalogue every narration script in `data/forays.json` run through
    `phonemize.py` (lexicon first, misaki en-US, espeak-ng fallback) and cut by
    its `sentence_chunks` rule, one inference per chunk, style row
    `len(ids) - 2`, exactly as the phone does.

BACKENDS (each skipped with a printed reason when it cannot run here):

  torch-cuda-{fp32,bf16,fp16}   `kokoro`'s KModel on the GPU; bf16/fp16 are
                                torch.autocast (weights fp32, matmul/conv/LSTM
                                in half), and each is checked for NaN/Inf
  torch-cpu-{fp32,bf16}         the same model on the CPU
  ort-cuda-<model>              onnxruntime's CUDA execution provider
  ort-cpu-<model>-t<N>          onnxruntime on the CPU at N intra-op threads

WORKLOADS:
  (a) probe      the 15-chunk passage in tools/mobile/kokoro-probe-passage.json
  (b) catalogue  every narrated Foray in data/forays.json, per voice, per speed
  (c) batched    torch only: padded batches of 1/4/16/64 catalogue chunks,
                 with a fidelity check against unbatched output (the ONNX
                 graph is batch-1, so ORT is reported as unsupported)
  (d) speeds     1.0 and 1.5 for (a) and (b)

x-real-time (xRT) = audio seconds produced / wall seconds. Above 1 is faster
than real time. Output: results.md (one table to paste) + results.json.

USAGE
    python tools/narration/bench-narration.py --smoke     # any machine, CPU, 2 chunks, ~1 min
    python tools/narration/bench-narration.py             # the full run (DGX Spark: see the doc)
    python tools/narration/bench-narration.py --only torch-cuda
    python tools/narration/bench-narration.py --check     # what can run here, then exit

Setup, expected run time and what to paste back: docs/voice/spark-benchmark.md.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import gc
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
import traceback
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PASSAGE_PATH = REPO_ROOT / "tools" / "mobile" / "kokoro-probe-passage.json"
FORAYS_PATH = REPO_ROOT / "data" / "forays.json"
FETCH_MODELS_PATH = REPO_ROOT / "tools" / "mobile" / "fetch-models.mjs"
DEFAULT_WORK_DIR = REPO_ROOT / "data-local" / "narration-bench"

SAMPLE_RATE = 24000
STYLE_DIM = 256
STYLE_ROWS = 510
VOICE_BYTES = 522240  # 510 x 256 x float32, the size fetch-models.mjs pins

DEFAULT_VOICES = ["af_heart", "am_echo"]  # D1: Heart (default) and Echo
DEFAULT_SPEEDS = [1.0, 1.5]
DEFAULT_BATCH_SIZES = [1, 4, 16, 64]
DEFAULT_ORT_THREADS = [1, 4, 10, 20]
DEFAULT_EXTRAPOLATE = [1000, 10000]
WARMUP_CHUNKS = 2

VOICE_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{voice}.bin"

# Echo has no pin in fetch-models.mjs yet (KV-01 adds it). This is the sha256
# #844's audition recorded on first download, which docs/kokoro-voices-in-app-plan.md
# quotes, and which Hugging Face's own LFS oid for the file equals (checked
# 2026-09-27). A pin in fetch-models.mjs, once it exists, wins over this.
RECORDED_VOICE_PINS = {
    "am_echo": {"sha256": "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3", "bytes": VOICE_BYTES},
}

# The PyTorch checkpoint `kokoro.KModel` loads. The app never ships it, so it
# has no pin in fetch-models.mjs; it is pinned HERE by the repository commit
# (never `main`) and by sha256 (Hugging Face's LFS oid for the .pth; the
# config.json hash was measured 2026-09-27). Same weights as the ONNX exports:
# onnx-community's files are an export of this checkpoint, and config.json's
# vocab equals tools/narration/kokoro-vocab.json id for id.
TORCH_REPO = "hexgrad/Kokoro-82M"
TORCH_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
TORCH_FILES = {
    "config.json": {"sha256": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f", "bytes": 2351},
    "kokoro-v1_0.pth": {"sha256": "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4", "bytes": 327212226},
}
TORCH_URL = "https://huggingface.co/{repo}/resolve/{rev}/{name}"

ONNX_MODEL_NAMES = {"fp32": "kokoro-v1_0-fp32.onnx", "q8f16": "kokoro-v1_0-q8f16.onnx"}


def log(msg: str) -> None:
    print(msg, flush=True)


# ================================================================ weights


def read_pins(path: Path = FETCH_MODELS_PATH) -> dict:
    """The ONNX model and voice pins, parsed out of fetch-models.mjs so there
    is one table of hashes in the repository (render-audition.py does the same)."""
    src = path.read_text(encoding="utf-8")
    models = {
        name: {"name": name, "url": url, "sha256": sha, "bytes": int(n)}
        for name, url, sha, n in re.findall(
            r'name: "(kokoro-v1_0-[a-z0-9]+\.onnx)",\s*url: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: (\d+)', src
        )
    }
    voices = {
        v: {"sha256": sha, "bytes": int(n)}
        for v, sha, n in re.findall(r'\["([a-z]{2}_[a-z]+)", "([0-9a-f]{64})", (\d+)\]', src)
    }
    return {"models": models, "voices": voices}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _download(url: str, dest: Path) -> None:
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "foray-narration-bench"})
    with urllib.request.urlopen(req, timeout=300) as resp, part.open("wb") as fh:
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            fh.write(block)
    part.replace(dest)


class Unavailable(RuntimeError):
    """A backend or workload that cannot run here, with the reason."""


def ensure_file(name: str, url: str, sha256: str, size: int, dest_dir: Path, search: list[Path], allow_download: bool) -> Path:
    """A verified local copy of one pinned file. Looks in `search` first (the
    gitignored places the repo's other tools already put weights), then
    downloads into `dest_dir`. A hash mismatch is never used."""
    for d in [dest_dir, *search]:
        p = d / name
        if p.exists() and p.stat().st_size == size and sha256_file(p) == sha256:
            return p
    if not allow_download:
        raise Unavailable(f"{name} is not on disk and --no-download was given")
    dest = dest_dir / name
    log(f"  fetching {name} ({size:,} bytes) from {url}")
    _download(url, dest)
    got = sha256_file(dest)
    if got != sha256 or dest.stat().st_size != size:
        dest.unlink(missing_ok=True)
        raise Unavailable(f"{name}: downloaded sha256 {got} does not match the pin {sha256}")
    return dest


EXTRA_WEIGHT_DIRS: list[Path] = []  # --weights-dir


def weight_search_dirs() -> list[Path]:
    return [
        *EXTRA_WEIGHT_DIRS,
        REPO_ROOT / "mobile" / "models",
        REPO_ROOT / "data-local" / "voice-audition" / "model",
        REPO_ROOT / "data-local" / "voice-audition" / "voices",
    ]


def load_voices(voices: list[str], work_dir: Path, allow_download: bool) -> dict:
    """voice id -> {"matrix": np (510, 256) float32, "sha256", "pinned_by"}."""
    import numpy as np

    pins = read_pins()["voices"]
    out = {}
    for v in voices:
        pin = pins.get(v)
        by = "fetch-models.mjs"
        if pin is None:
            pin = RECORDED_VOICE_PINS.get(v)
            by = "recorded (docs/kokoro-voices-in-app-plan.md)"
        if pin is None:
            raise Unavailable(f"{v} has no pin in fetch-models.mjs and no recorded sha256 here")
        path = ensure_file(f"{v}.bin", VOICE_URL.format(voice=v), pin["sha256"], pin["bytes"],
                           work_dir / "voices", weight_search_dirs(), allow_download)
        m = np.fromfile(path, dtype=np.float32).reshape(STYLE_ROWS, STYLE_DIM)
        out[v] = {"matrix": m, "sha256": pin["sha256"], "pinned_by": by}
    return out


def style_row_index(ids: list[int]) -> int:
    """D3 / phonemize.py `style_row`: the unpadded length, clamped."""
    return max(0, min(len(ids) - 2, STYLE_ROWS - 1))


# ============================================================== workloads


def _load_phonemize():
    spec = importlib.util.spec_from_file_location("foray_phonemize", Path(__file__).resolve().parent / "phonemize.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def shortest(chunks: list[list[int]], n: int) -> list[list[int]]:
    """--smoke's sample: the n shortest chunks, in their original order. It
    checks that every code path runs, on the cheapest inputs there are."""
    keep = sorted(sorted(range(len(chunks)), key=lambda i: len(chunks[i]))[:n])
    return [chunks[i] for i in keep]


def probe_chunks(smoke: bool = False) -> list[list[int]]:
    """The probe passage's committed chunk ids, in order."""
    doc = json.loads(PASSAGE_PATH.read_text(encoding="utf-8"))
    ids = [c["ids"] for line in doc.get("lines", []) for c in (line.get("chunks") or []) if c.get("ids")]
    if not ids:
        raise Unavailable("the probe passage carries no chunk ids")
    return shortest(ids, 2) if smoke else ids


def catalogue(work_dir: Path, smoke: bool) -> dict:
    """Every narrated Foray's narration as chunk ids.

    Phonemized with phonemize.py (misaki + lexicon + espeak-ng fallback),
    cached under work_dir keyed by the scripts' own hash, so a re-run skips the
    ~minute of spaCy/misaki. A chunk the model cannot sing (`UnsingablePhoneme`)
    is COUNTED and left out, never silently dropped from the report."""
    doc = json.loads(FORAYS_PATH.read_text(encoding="utf-8"))
    forays = []
    for f in doc.get("forays", []):
        items = [i for i in f.get("items", []) if i.get("type") == "narration" and str(i.get("script", "")).strip()]
        if items:
            forays.append({"id": f.get("id"), "status": f.get("status"),
                           "items": [{"id": i.get("id"), "script": i["script"].strip()} for i in items]})
    if not forays:
        raise Unavailable("data/forays.json has no narrated Forays")
    if smoke:
        forays = forays[:1]
        forays[0]["items"] = forays[0]["items"][:2]
    blob = json.dumps([[f["id"], [[i["id"], i["script"]] for i in f["items"]]] for f in forays], ensure_ascii=False)
    fp = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
    cache = work_dir / f"catalogue-{fp}.json"
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        if cached.get("fingerprint") == fp:
            return cached
    except (OSError, ValueError):
        pass
    try:
        P = _load_phonemize()
        g2p = P.load_backend()
    except Exception as exc:  # MissingBackend or an import error inside misaki
        raise Unavailable(f"cannot phonemize the catalogue: {exc}") from exc
    entries, vocab = P.load_lexicon(), P.load_vocab()
    log(f"  phonemizing {sum(len(f['items']) for f in forays)} narration items from {len(forays)} Forays (misaki + espeak-ng)")
    out = []
    for f in forays:
        chunks, unsingable, chars = [], 0, 0
        for it in f["items"]:
            chars += len(it["script"])
            res = P.phonemize_script(it["script"], entries, g2p)
            for piece in P.sentence_chunks(res["phonemes"]):
                try:
                    chunks.append(P.ids_for(piece, vocab))
                except P.UnsingablePhoneme:
                    unsingable += 1
        if smoke:
            chunks = shortest(chunks, 2)
        out.append({"id": f["id"], "status": f["status"], "items": len(f["items"]), "chars": chars,
                    "chunks": chunks, "unsingable_chunks": unsingable})
    result = {"fingerprint": fp, "vocab": P.vocab_sha(vocab), "forays": out}
    work_dir.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result) + "\n", encoding="utf-8")
    del g2p
    gc.collect()
    return result


# =============================================================== backends


class Backend:
    name = "?"
    device = "cpu"
    supports_batch = False

    def synth(self, ids: list[int], style, speed: float):
        raise NotImplementedError

    def reset_peak(self) -> None:
        pass

    def peak_mem_mb(self):
        return None

    def close(self) -> None:
        pass


class TorchBackend(Backend):
    """`kokoro`'s KModel. `forward_with_tokens` is the library's own batch-1
    path, used unchanged for every unbatched number; `synth_batch` is this
    file's padded-batch variant of the same forward, for workload (c) only."""

    supports_batch = True

    def __init__(self, device: str, precision: str, weights: dict, cpu_threads: int | None):
        import torch
        from kokoro import KModel

        self.torch = torch
        self.device = device
        self.precision = precision
        self.name = f"torch-{device}-{precision}"
        if device == "cpu" and cpu_threads:
            torch.set_num_threads(cpu_threads)
        self.threads = torch.get_num_threads() if device == "cpu" else None
        t0 = time.perf_counter()
        self.model = KModel(repo_id=TORCH_REPO, config=str(weights["config.json"]), model=str(weights["kokoro-v1_0.pth"]))
        self.model = self.model.to(device).eval()
        if device == "cuda":
            torch.cuda.synchronize()
        self.load_sec = time.perf_counter() - t0
        self.dtype = {"fp32": None, "bf16": torch.bfloat16, "fp16": torch.float16}[precision]
        if self.dtype is not None:
            self._keep_fp32_islands()

    def _keep_fp32_islands(self):
        """Half precision everywhere EXCEPT the two places it cannot work.

        (1) The iSTFTNet head's STFT/iSTFT: cuFFT refuses half precision for
        Kokoro's n_fft of 20 (not a power of two) and bf16 FFTs do not exist,
        so under plain autocast every bf16/fp16 render would raise. (2) The
        harmonic source (SineGen): it integrates phase with a cumulative sum,
        and at bf16's 8-bit mantissa that phase is noise. These are the same
        islands docs/voice/kokoro-speed-1.5x.md option 4 keeps fp32 in its
        mixed-precision ONNX export. (3) ON THE CPU ONLY, the LSTMs: oneDNN has
        no bf16 LSTM primitive on CPUs without native bf16 (measured on the
        founder's x86 PC: "could not create a primitive descriptor"), so a
        CPU bf16 run keeps them fp32 rather than failing. Everything else
        (ALBERT, the convolutions, the linears) runs in the autocast dtype."""
        torch = self.torch
        dev = self.device
        gen = self.model.decoder.generator

        packed = torch.nn.utils.rnn.PackedSequence

        def fp32(fn):
            def run(*args):
                with torch.autocast(device_type=dev, enabled=False):
                    return fn(*[a.float() if (torch.is_tensor(a) or isinstance(a, packed)) else a for a in args])
            return run

        gen.stft.transform = fp32(gen.stft.transform)
        gen.stft.inverse = fp32(gen.stft.inverse)
        gen.m_source.forward = fp32(gen.m_source.forward)
        if dev == "cpu":
            for mod in self.model.modules():
                if isinstance(mod, torch.nn.LSTM):
                    mod.forward = fp32(mod.forward)

    def _ctx(self):
        if self.dtype is None:
            return contextlib.nullcontext()
        return self.torch.autocast(device_type=self.device, dtype=self.dtype)

    def _style(self, style):
        return self.torch.from_numpy(style).reshape(1, STYLE_DIM).to(self.device)

    def synth(self, ids, style, speed):
        torch = self.torch
        with torch.inference_mode(), self._ctx():
            x = torch.tensor([ids], dtype=torch.long, device=self.device)
            audio, _ = self.model.forward_with_tokens(x, self._style(style), speed)
        return audio.float().reshape(-1).cpu().numpy()

    def synth_batch(self, items, speed):
        """Padded batch: `items` is [(ids, style_row_vector)], one speed.

        Exact where the library masks (ALBERT attention, the packed
        DurationEncoder / TextEncoder LSTMs); this function additionally packs
        the two LSTMs `forward_with_tokens` leaves unpacked (duration and the
        F0/N `shared` LSTM) so every item's DURATIONS match its unbatched ones.
        Not exact downstream: the decoder's InstanceNorm and convolutions see
        the zero-padded tail of shorter items. How much that moves the audio is
        what workload (c)'s fidelity column measures, against the noise floor
        of two unbatched renders (Kokoro's SineGen draws random phase/noise on
        every call, so no two renders are bit-identical anyway)."""
        import numpy as np

        torch = self.torch
        m = self.model
        nn = torch.nn
        dev = self.device
        B = len(items)
        lens = [len(ids) for ids, _ in items]
        T = max(lens)
        with torch.inference_mode(), self._ctx():
            input_ids = torch.zeros((B, T), dtype=torch.long, device=dev)
            for b, (ids, _) in enumerate(items):
                input_ids[b, : len(ids)] = torch.tensor(ids, dtype=torch.long, device=dev)
            ref_s = torch.from_numpy(np.stack([s for _, s in items]).astype(np.float32)).to(dev)
            input_lengths = torch.tensor(lens, dtype=torch.long, device=dev)
            text_mask = torch.arange(T, device=dev).unsqueeze(0).expand(B, -1) + 1 > input_lengths.unsqueeze(1)
            bert_dur = m.bert(input_ids, attention_mask=(~text_mask).int())
            d_en = m.bert_encoder(bert_dur).transpose(-1, -2)
            s = ref_s[:, 128:]
            d = m.predictor.text_encoder(d_en, s, input_lengths, text_mask)
            packed = nn.utils.rnn.pack_padded_sequence(d, input_lengths.cpu(), batch_first=True, enforce_sorted=False)
            x, _ = m.predictor.lstm(packed)
            x, _ = nn.utils.rnn.pad_packed_sequence(x, batch_first=True, total_length=T)
            duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(axis=-1) / speed
            pred_dur = torch.round(duration).clamp(min=1).long()
            pred_dur = pred_dur.masked_fill(text_mask, 0)
            frames = pred_dur.sum(dim=1)
            F = int(frames.max().item())
            aln = torch.zeros((B, T, F), device=dev)
            for b in range(B):
                idx = torch.repeat_interleave(torch.arange(T, device=dev), pred_dur[b])
                aln[b, idx, torch.arange(idx.shape[0], device=dev)] = 1
            en = d.transpose(-1, -2) @ aln.to(d.dtype)
            # F0Ntrain with its `shared` LSTM packed by frame count.
            p = m.predictor
            packed = nn.utils.rnn.pack_padded_sequence(en.transpose(-1, -2), frames.cpu(), batch_first=True, enforce_sorted=False)
            xs, _ = p.shared(packed)
            xs, _ = nn.utils.rnn.pad_packed_sequence(xs, batch_first=True, total_length=F)
            F0 = xs.transpose(-1, -2)
            for block in p.F0:
                F0 = block(F0, s)
            F0 = p.F0_proj(F0).squeeze(1)
            N = xs.transpose(-1, -2)
            for block in p.N:
                N = block(N, s)
            N = p.N_proj(N).squeeze(1)
            t_en = m.text_encoder(input_ids, input_lengths, text_mask)
            asr = t_en @ aln.to(t_en.dtype)
            audio = m.decoder(asr, F0, N, ref_s[:, :128]).float()
        audio = audio.reshape(B, -1)
        spf = audio.shape[1] // F  # samples per predicted frame (600 for Kokoro v1.0)
        fr = frames.cpu().tolist()
        audio = audio.cpu().numpy()
        return [audio[b, : fr[b] * spf] for b in range(B)]

    def reset_peak(self):
        if self.device == "cuda":
            self.torch.cuda.synchronize()
            self.torch.cuda.reset_peak_memory_stats()

    def peak_mem_mb(self):
        if self.device == "cuda":
            return round(self.torch.cuda.max_memory_allocated() / 2**20, 1)
        return None

    def close(self):
        del self.model
        gc.collect()
        if self.device == "cuda":
            self.torch.cuda.empty_cache()


class OrtBackend(Backend):
    """The ONNX graph the phones run, through onnxruntime."""

    def __init__(self, model_path: Path, model_tag: str, provider: str, threads: int | None):
        import onnxruntime as ort

        self.device = "cuda" if provider == "cuda" else "cpu"
        self.threads = threads
        self.name = f"ort-{provider}-{model_tag}" + (f"-t{threads}" if threads else "")
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        if provider == "cuda":
            # HEURISTIC, not ORT's default EXHAUSTIVE: every chunk is a new
            # input length, and an exhaustive cuDNN search per new shape would
            # be timed as if it were synthesis.
            providers = [("CUDAExecutionProvider", {"device_id": 0, "cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]
        t0 = time.perf_counter()
        self.session = ort.InferenceSession(str(model_path), opts, providers=providers)
        self.load_sec = time.perf_counter() - t0
        got = self.session.get_providers()
        if provider == "cuda" and (not got or got[0] != "CUDAExecutionProvider"):
            raise Unavailable(f"onnxruntime fell back to {got} instead of CUDA")
        self.providers = got
        self.ort_version = ort.__version__

    def synth(self, ids, style, speed):
        import numpy as np

        out = self.session.run(None, {
            "input_ids": np.array([ids], dtype=np.int64),
            "style": style.reshape(1, STYLE_DIM).astype(np.float32),
            "speed": np.array([speed], dtype=np.float32),
        })
        return np.asarray(out[0], dtype=np.float32).reshape(-1)

    def close(self):
        del self.session
        gc.collect()


# ============================================================ GPU telemetry


class GpuSampler:
    """nvidia-smi polled in the background: power (W), memory used (MiB),
    utilisation (%). Absent or unreadable fields become None, which on the
    GB10's unified memory is expected for memory.used."""

    FIELDS = ["power.draw", "memory.used", "utilization.gpu"]

    def __init__(self, interval: float = 0.25):
        self.exe = shutil.which("nvidia-smi")
        self.interval = interval
        self.samples: list[tuple[float, float | None, float | None, float | None]] = []
        self._stop = threading.Event()
        self._thread = None

    @staticmethod
    def _num(s: str):
        try:
            return float(s.strip())
        except ValueError:
            return None

    def query(self):
        if not self.exe:
            return None
        try:
            out = subprocess.run([self.exe, f"--query-gpu={','.join(self.FIELDS)}", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        except (OSError, subprocess.SubprocessError):
            return None
        if not out:
            return None
        return [self._num(x) for x in out[0].split(",")]

    def start(self):
        if not self.exe:
            return

        def loop():
            while not self._stop.is_set():
                q = self.query()
                if q and len(q) == 3:
                    self.samples.append((time.perf_counter(), *q))
                self._stop.wait(self.interval)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def window(self, t0: float, t1: float) -> dict:
        s = [x for x in self.samples if t0 <= x[0] <= t1]
        pw = [x[1] for x in s if x[1] is not None]
        mem = [x[2] for x in s if x[2] is not None]
        ut = [x[3] for x in s if x[3] is not None]
        return {
            "gpu_watts_mean": round(statistics.fmean(pw), 1) if pw else None,
            "gpu_watts_max": round(max(pw), 1) if pw else None,
            "gpu_mem_used_max_mib": max(mem) if mem else None,
            "gpu_util_mean": round(statistics.fmean(ut), 1) if ut else None,
            "samples": len(s),
        }

    def idle_watts(self, seconds: float = 3.0):
        if not self.exe:
            return None
        vals = []
        end = time.perf_counter() + seconds
        while time.perf_counter() < end:
            q = self.query()
            if q and q[0] is not None:
                vals.append(q[0])
            time.sleep(0.25)
        return round(statistics.fmean(vals), 1) if vals else None


# ============================================================ measurement


def pct(values: list[float], q: float):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def audio_ok(a) -> tuple[bool, float]:
    import numpy as np

    finite = bool(np.isfinite(a).all()) and a.size > 0
    peak = float(np.nanmax(np.abs(a))) if a.size else 0.0
    return finite, peak


def run_sequence(backend: Backend, chunks: list[list[int]], style_matrix, speed: float, sampler: GpuSampler,
                 keep_audio: bool = False) -> dict:
    """Render chunks one inference each, in order, timing every one."""
    walls, samples, nonfinite, peak = [], 0, 0, 0.0
    kept = []
    backend.reset_peak()
    t0 = time.perf_counter()
    for ids in chunks:
        c0 = time.perf_counter()
        a = backend.synth(ids, style_matrix[style_row_index(ids)], speed)
        walls.append(time.perf_counter() - c0)
        ok, pk = audio_ok(a)
        nonfinite += 0 if ok else 1
        peak = max(peak, pk if math.isfinite(pk) else peak)
        samples += a.size
        if keep_audio:
            kept.append(a)
    t1 = time.perf_counter()
    audio_sec = samples / SAMPLE_RATE
    wall = t1 - t0
    r = {
        "chunks": len(chunks),
        "audio_sec": round(audio_sec, 3),
        "wall_sec": round(wall, 4),
        "xrt": round(audio_sec / wall, 3) if wall > 0 else None,
        "p50_ms": round(pct(walls, 0.5) * 1000, 1) if walls else None,
        "p95_ms": round(pct(walls, 0.95) * 1000, 1) if walls else None,
        "finite": nonfinite == 0,
        "nonfinite_chunks": nonfinite,
        "peak_abs": round(peak, 4),
        "peak_mem_mb": backend.peak_mem_mb(),
        **sampler.window(t0, t1),
    }
    if keep_audio:
        r["_audio"] = kept
    return r


def warmup(backend: Backend, chunks, style_matrix, n: int = WARMUP_CHUNKS, limit: float = 0.0):
    """Cold-start costs (CUDA context, cuDNN heuristics, ORT arena growth) are
    real but are not throughput; they are measured here and reported apart."""
    t0 = time.perf_counter()
    for ids in chunks[:n]:
        backend.synth(ids, style_matrix[style_row_index(ids)], 1.0)
        if limit and time.perf_counter() - t0 > limit:
            break  # the caller skips this config; do not spend another chunk on it
    return round(time.perf_counter() - t0, 3)


def log_spectral_distance(a, b) -> float | None:
    """Mean log-spectral distance in dB between two renders (n_fft 1024, hop 256),
    over their common length. A quality proxy, not a listening test."""
    import numpy as np

    n = min(a.size, b.size)
    if n < 2048:
        return None

    def spec(x):
        x = x[:n].astype(np.float64)
        frames = np.lib.stride_tricks.sliding_window_view(x, 1024)[::256] * np.hanning(1024)
        return 20 * np.log10(np.abs(np.fft.rfft(frames, axis=1)) + 1e-5)

    sa, sb = spec(a), spec(b)
    return float(np.mean(np.sqrt(np.mean((sa - sb) ** 2, axis=1))))


def run_batched(backend: TorchBackend, chunks, style_matrix, batch_sizes, sampler, fidelity_items: int = 8,
                warm: bool = True) -> list[dict]:
    """Workload (c). Chunks sorted by length first (length bucketing: least
    padding per batch, the way a catalogue renderer would schedule them)."""
    import numpy as np

    order = sorted(range(len(chunks)), key=lambda i: len(chunks[i]))
    items = [(chunks[i], style_matrix[style_row_index(chunks[i])]) for i in order]
    # Fidelity reference: the library's own batch-1 forward, twice (floor).
    fid = items[: min(fidelity_items, len(items))]
    ref = [backend.synth(ids, s, 1.0) for ids, s in fid]
    ref2 = [backend.synth(ids, s, 1.0) for ids, s in fid]
    floor = [log_spectral_distance(a, b) for a, b in zip(ref, ref2)]
    floor = [x for x in floor if x is not None]
    rows = []
    for bs in batch_sizes:
        if bs > len(items):
            continue
        try:
            if warm:
                backend.synth_batch(items[:bs], 1.0)  # warm this batch shape
            backend.reset_peak()
            samples, nonfinite, outs = 0, 0, []
            t0 = time.perf_counter()
            for k in range(0, len(items), bs):
                got = backend.synth_batch(items[k:k + bs], 1.0)
                for a in got:
                    samples += a.size
                    nonfinite += 0 if audio_ok(a)[0] else 1
                if k == 0:
                    outs = got
            t1 = time.perf_counter()
        except Exception as exc:  # an OOM at 64 is a result, not a crash
            rows.append({"batch": bs, "error": f"{type(exc).__name__}: {str(exc)[:200]}"})
            if backend.device == "cuda":
                backend.torch.cuda.empty_cache()
            continue
        # outs covers items[:bs]; compare what overlaps the fidelity set.
        lsd, len_match = [], 0
        for a, r in zip(outs[: len(ref)], ref):
            len_match += int(a.size == r.size)
            d = log_spectral_distance(a, r)
            if d is not None:
                lsd.append(d)
        n_cmp = min(len(outs), len(ref))
        wall = t1 - t0
        rows.append({
            "batch": bs,
            "chunks": len(items),
            "audio_sec": round(samples / SAMPLE_RATE, 2),
            "wall_sec": round(wall, 3),
            "xrt": round(samples / SAMPLE_RATE / wall, 2),
            "chunks_per_sec": round(len(items) / wall, 2),
            "finite": nonfinite == 0,
            "nonfinite_chunks": nonfinite,
            "peak_mem_mb": backend.peak_mem_mb(),
            "duration_match": f"{len_match}/{n_cmp}",
            "lsd_db_vs_unbatched": round(statistics.fmean(lsd), 2) if lsd else None,
            "lsd_db_floor": round(statistics.fmean(floor), 2) if floor else None,
            **sampler.window(t0, t1),
        })
    return rows


def write_wav(path: Path, audio) -> None:
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(np.nan_to_num(audio), -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())


# ============================================================ environment


def _pkg(name: str):
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return None


def environment(sampler: GpuSampler) -> dict:
    env = {
        "when": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "host_platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "python": platform.python_version(),
        "packages": {p: _pkg(p) for p in ["torch", "kokoro", "misaki", "onnxruntime", "onnxruntime-gpu", "numpy", "spacy"]},
    }
    try:
        env["git_commit"] = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
                                           capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        env["git_commit"] = None
    if sampler.exe:
        try:
            out = subprocess.run([sampler.exe, "--query-gpu=name,driver_version,power.limit", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=10).stdout.strip()
            env["nvidia_smi"] = out or None
        except (OSError, subprocess.SubprocessError):
            env["nvidia_smi"] = None
    try:
        import torch

        env["torch_cuda"] = torch.version.cuda
        env["torch_cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            env["gpu"] = torch.cuda.get_device_name(0)
            env["gpu_capability"] = ".".join(map(str, torch.cuda.get_device_capability(0)))
            env["cudnn_allow_tf32"] = torch.backends.cudnn.allow_tf32
            env["matmul_allow_tf32"] = torch.backends.cuda.matmul.allow_tf32
    except Exception:
        pass
    try:
        import onnxruntime as ort

        env["ort_providers"] = ort.get_available_providers()
    except Exception:
        pass
    try:
        with open("/proc/meminfo") as fh:
            env["mem_total_gb"] = round(int(fh.readline().split()[1]) / 2**20, 1)
    except OSError:
        pass
    return env


# ============================================================ report


def fmt(v, nd=1):
    if v is None:
        return "–"
    if isinstance(v, bool):
        return "y" if v else "**N**"
    if isinstance(v, float):
        return f"{v:,.{nd}f}"
    return str(v)


def extrapolate(results: dict, counts: list[int], system_watts: float | None) -> list[dict]:
    """"N thousand Forays ≈ X hours on this box", per config and speed, from
    the MEASURED per-Foray mean wall time summed over every voice rendered.
    A config with no catalogue run (the CPU ones by default) is estimated
    from its probe xRT and the catalogue's measured mean audio per Foray, and
    says so."""
    rows = []
    cat = [r for r in results["runs"] if r["workload"] == "catalogue"]
    mean_audio = {}  # (voice, speed) -> mean narration audio s per Foray
    for r in cat:
        mean_audio.setdefault((r["voice"], r["speed"]), []).append(r["audio_sec"])
    mean_audio = {k: statistics.fmean(v) for k, v in mean_audio.items()}
    configs = []
    for r in results["runs"]:
        if r["config"] not in configs:
            configs.append(r["config"])
    voices = results["voices"]
    for cfg in configs:
        for speed in results["speeds"]:
            per_voice, watts, basis = [], [], "measured catalogue"
            for v in voices:
                rs = [r for r in cat if r["config"] == cfg and r["speed"] == speed and r["voice"] == v]
                if rs:
                    per_voice.append(statistics.fmean([r["wall_sec"] for r in rs]))
                    watts += [r["gpu_watts_mean"] for r in rs if r.get("gpu_watts_mean") is not None]
                    continue
                pr = [r for r in results["runs"] if r["config"] == cfg and r["workload"] == "probe" and r["speed"] == speed and r.get("xrt")]
                ma = mean_audio.get((v, speed)) or (statistics.fmean([x for (vv, s), x in mean_audio.items() if s == speed]) if any(s == speed for _, s in mean_audio) else None)
                if pr and ma:
                    per_voice.append(ma / statistics.fmean([r["xrt"] for r in pr]))
                    watts += [r["gpu_watts_mean"] for r in pr if r.get("gpu_watts_mean") is not None]
                    basis = "estimated from probe xRT"
            if len(per_voice) != len(voices):
                continue
            finite = all(r["finite"] for r in results["runs"] if r["config"] == cfg)
            sec_per_foray = sum(per_voice)
            w = statistics.fmean(watts) if watts else None
            for n in counts:
                hours = n * sec_per_foray / 3600
                rows.append({
                    "config": cfg, "speed": speed, "forays": n, "voices": len(voices), "basis": basis, "finite": finite,
                    "sec_per_foray_all_voices": round(sec_per_foray, 2),
                    "hours": round(hours, 2),
                    "gpu_kwh": round(hours * w / 1000, 2) if w else None,
                    "system_kwh": round(hours * system_watts / 1000, 2) if system_watts else None,
                })
    # Batched throughput (c): measured on one voice at speed 1; every voice
    # costs the same, so a Foray costs (sum of its voices' audio) / batch xRT.
    audio_all_voices = sum(mean_audio.get((v, 1.0), 0) for v in voices)
    if audio_all_voices:
        for b in results["batched"]:
            if b.get("error") or not b.get("xrt"):
                continue
            sec = audio_all_voices / b["xrt"]
            w = b.get("gpu_watts_mean")
            for n in counts:
                hours = n * sec / 3600
                rows.append({
                    "config": b["config"], "speed": 1.0, "forays": n, "voices": len(voices),
                    "basis": f"batched, batch {b['batch']}", "finite": b["finite"],
                    "sec_per_foray_all_voices": round(sec, 2), "hours": round(hours, 2),
                    "gpu_kwh": round(hours * w / 1000, 2) if w else None,
                    "system_kwh": round(hours * system_watts / 1000, 2) if system_watts else None,
                })
    return rows


def markdown(results: dict) -> str:
    env = results["env"]
    L = []
    L.append(f"### Kokoro narration benchmark — {env.get('gpu') or env['machine']} ({env['when']})")
    L.append("")
    L.append(f"`{env['host_platform']}` · {env['cpu_count']} CPUs"
             + (f" · {env['mem_total_gb']} GB RAM" if env.get("mem_total_gb") else "")
             + f" · python {env['python']} · torch {env['packages'].get('torch')} (CUDA {env.get('torch_cuda')})"
             + f" · kokoro {env['packages'].get('kokoro')} · onnxruntime {env['packages'].get('onnxruntime-gpu') or env['packages'].get('onnxruntime')}"
             + f" · repo {env.get('git_commit')}" + (" · **SMOKE**" if results["smoke"] else ""))
    if env.get("nvidia_smi"):
        L.append(f"GPU: {env['nvidia_smi']} · idle GPU power {fmt(results.get('idle_gpu_watts'))} W")
    L.append("")
    L.append("xRT = audio seconds / wall seconds (higher is faster; 1.0 = real time). One inference per sentence chunk. "
             "Warm: each config's first chunks are rendered once before timing (cold column).")
    L.append("")
    L.append("| config | workload | voice | speed | finite | chunks | audio s | wall s | xRT | p50 ms | p95 ms | peak GPU MB | GPU W | load s | cold s |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in results["runs"]:
        L.append("| " + " | ".join([
            r["config"], r["workload"], r["voice"].split("_")[1], f"{r['speed']:g}", fmt(r["finite"]), str(r["chunks"]),
            fmt(r["audio_sec"]), fmt(r["wall_sec"], 2), fmt(r["xrt"], 2), fmt(r["p50_ms"], 0), fmt(r["p95_ms"], 0),
            fmt(r.get("peak_mem_mb"), 0), fmt(r.get("gpu_watts_mean")), fmt(r.get("load_sec"), 1), fmt(r.get("cold_sec"), 2),
        ]) + " |")
    if results["batched"]:
        L.append("")
        L.append("**Batched (torch, padded, length-bucketed; one voice, speed 1).** `LSD` = log-spectral distance to the "
                 "unbatched render in dB; `floor` = two unbatched renders against each other (Kokoro is not bit-deterministic).")
        L.append("")
        L.append("| config | batch | chunks | audio s | wall s | xRT | chunks/s | finite | peak GPU MB | GPU W | durations equal | LSD dB | floor dB |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for b in results["batched"]:
            if b.get("error"):
                L.append(f"| {b['config']} | {b['batch']} | – | – | – | – | – | – | – | – | – | – | {b['error'][:60]} |")
                continue
            L.append("| " + " | ".join([
                b["config"], str(b["batch"]), str(b["chunks"]), fmt(b["audio_sec"]), fmt(b["wall_sec"], 2), fmt(b["xrt"], 1),
                fmt(b["chunks_per_sec"], 1), fmt(b["finite"]), fmt(b.get("peak_mem_mb"), 0), fmt(b.get("gpu_watts_mean")),
                b["duration_match"], fmt(b["lsd_db_vs_unbatched"], 2), fmt(b["lsd_db_floor"], 2),
            ]) + " |")
    if results["extrapolation"]:
        L.append("")
        cat = results.get("catalogue_summary") or {}
        L.append(f"**Extrapolation** — every voice ({', '.join(results['voices'])}) per Foray, one process; unbatched unless the basis says batched. "
                 f"Basis: the {cat.get('forays', '?')} narrated Foray(s) in data/forays.json, mean "
                 f"{fmt(cat.get('mean_audio_sec_speed1'))} s of narration each at speed 1. GPU kWh uses nvidia-smi power.draw "
                 "(GPU only — not the whole box).")
        L.append("")
        L.append("| config | speed | Forays | basis | s per Foray | hours | GPU kWh | system kWh |")
        L.append("|---|---|---|---|---|---|---|---|")
        for e in results["extrapolation"]:
            L.append(f"| {e['config']}{'' if e['finite'] else ' (NON-FINITE)'} | {e['speed']:g} | {e['forays']:,} | {e['basis']} | "
                     f"{fmt(e['sec_per_foray_all_voices'])} | {fmt(e['hours'])} | {fmt(e['gpu_kwh'])} | {fmt(e['system_kwh'])} |")
    if results["skipped"]:
        L.append("")
        L.append("**Skipped:** " + "; ".join(f"`{k}`: {v}" for k, v in results["skipped"].items()))
    L.append("")
    return "\n".join(L)


# ================================================================== main


def plan_configs(args, has_cuda_torch: bool, ort_providers: list[str]) -> list[dict]:
    cfgs = []
    cpus = os.cpu_count() or 1
    if not args.skip_gpu:
        for prec in ["fp32", "bf16", "fp16"]:
            cfgs.append({"kind": "torch", "device": "cuda", "precision": prec})
        for m in args.onnx_models:
            cfgs.append({"kind": "ort", "provider": "cuda", "model": m})
    if not args.skip_cpu:
        # bf16 on the CPU is for the Spark's Neoverse V2 cores, which have
        # bf16 instructions; --smoke leaves it out (on most x86 it is emulated).
        for prec in (["fp32"] if args.smoke else ["fp32", "bf16"]):
            cfgs.append({"kind": "torch", "device": "cpu", "precision": prec})
        threads = sorted({min(t, cpus) for t in args.ort_threads})
        for m in args.onnx_models:
            for t in threads:
                cfgs.append({"kind": "ort", "provider": "cpu", "model": m, "threads": t})
    return cfgs


def cfg_name(c: dict) -> str:
    if c["kind"] == "torch":
        return f"torch-{c['device']}-{c['precision']}"
    return f"ort-{c['provider']}-{c['model']}" + (f"-t{c['threads']}" if c.get("threads") else "")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--smoke", action="store_true", help="CPU only, 2 chunks, one voice: checks the script works on any machine")
    ap.add_argument("--check", action="store_true", help="list what can run here and exit")
    ap.add_argument("--only", help="comma-separated substrings; run only configs whose name contains one (e.g. torch-cuda,ort-cpu-fp32-t20)")
    ap.add_argument("--skip-gpu", action="store_true")
    ap.add_argument("--skip-cpu", action="store_true")
    ap.add_argument("--voices", default=",".join(DEFAULT_VOICES))
    ap.add_argument("--speeds", default=",".join(f"{s:g}" for s in DEFAULT_SPEEDS))
    ap.add_argument("--batch-sizes", default=",".join(map(str, DEFAULT_BATCH_SIZES)))
    ap.add_argument("--ort-threads", default=",".join(map(str, DEFAULT_ORT_THREADS)))
    ap.add_argument("--onnx-models", default="fp32", help="fp32 (the iOS model), q8f16 (the Android model), or both")
    ap.add_argument("--torch-cpu-threads", type=int, default=None, help="default: torch's own (all cores)")
    ap.add_argument("--catalogue-cpu", action="store_true", help="also render the whole catalogue on CPU configs (slow)")
    ap.add_argument("--batched-cpu", action="store_true", help="also run batched rendering on torch CPU (slow)")
    ap.add_argument("--extrapolate", default=",".join(map(str, DEFAULT_EXTRAPOLATE)), help="Foray counts to extrapolate to")
    ap.add_argument("--system-watts", type=float, default=None, help="whole-box watts from a wall meter, for a system kWh column")
    ap.add_argument("--work-dir", default=str(DEFAULT_WORK_DIR), help="weights + caches (gitignored)")
    ap.add_argument("--out", help="output directory (default: <work-dir>/results-<timestamp>)")
    ap.add_argument("--weights-dir", action="append", default=[],
                    help="another directory to look for already-downloaded, pinned weights (repeatable)")
    ap.add_argument("--max-warmup-sec", type=float, default=120.0,
                    help="skip a config whose warm-up takes longer than this (0 = never skip)")
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--no-wavs", action="store_true", help="do not write the probe WAV per config")
    args = ap.parse_args(argv)

    args.voices = [v.strip() for v in args.voices.split(",") if v.strip()]
    args.speeds = [float(s) for s in args.speeds.split(",")]
    args.batch_sizes = [int(b) for b in args.batch_sizes.split(",")]
    args.ort_threads = [int(t) for t in args.ort_threads.split(",")]
    args.onnx_models = [m.strip() for m in args.onnx_models.split(",") if m.strip()]
    for m in args.onnx_models:
        if m not in ONNX_MODEL_NAMES:
            ap.error(f"--onnx-models: unknown {m!r}")
    if args.smoke:
        args.skip_gpu = True
        args.voices = args.voices[:1]
        args.batch_sizes = [1, 2]
        args.ort_threads = [min(4, os.cpu_count() or 1)]
        args.catalogue_cpu = True
        args.batched_cpu = True
        # Four threads: the shared founder PC measured four as its best ORT
        # setting (render-audition.py LOCAL_THREADS) and it leaves the rest usable.
        if args.torch_cpu_threads is None:
            args.torch_cpu_threads = min(4, os.cpu_count() or 1)
        # Smoke uses whichever ONNX export is already on disk, preferring the
        # small one: it checks the script, not the model.
        args.onnx_models = ["q8f16"]
    work_dir = Path(args.work_dir).resolve()
    EXTRA_WEIGHT_DIRS.extend(Path(d).resolve() for d in args.weights_dir)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out).resolve() if args.out else work_dir / f"results-{stamp}{'-smoke' if args.smoke else ''}"
    allow_dl = not args.no_download

    # ---- what can run here -----------------------------------------------
    skipped: dict[str, str] = {}
    torch_ok, torch_why, cuda_ok = False, "", False
    try:
        import torch  # noqa: F401

        try:
            import kokoro  # noqa: F401

            torch_ok = True
        except Exception as exc:
            torch_why = f"`kokoro` not importable ({type(exc).__name__}: {exc}); pip install kokoro==0.9.4"
        cuda_ok = torch.cuda.is_available()
    except Exception as exc:
        torch_why = f"torch not importable ({type(exc).__name__}: {exc})"
    ort_ok, ort_why, ort_providers = False, "", []
    try:
        import onnxruntime as ort

        with contextlib.suppress(Exception):
            ort.preload_dlls()  # ORT >= 1.21: find the CUDA/cuDNN libs torch's wheels ship
        ort_providers = ort.get_available_providers()
        ort_ok = True
    except Exception as exc:
        ort_why = f"onnxruntime not importable ({type(exc).__name__}: {exc})"

    configs = plan_configs(args, cuda_ok, ort_providers)
    if args.only:
        keys = [k.strip() for k in args.only.split(",") if k.strip()]
        configs = [c for c in configs if any(k in cfg_name(c) for k in keys)]
    runnable = []
    for c in configs:
        n = cfg_name(c)
        if c["kind"] == "torch" and not torch_ok:
            skipped[n] = torch_why
        elif c["kind"] == "torch" and c["device"] == "cuda" and not cuda_ok:
            skipped[n] = "torch.cuda.is_available() is False (CPU-only torch wheel, or no GPU)"
        elif c["kind"] == "ort" and not ort_ok:
            skipped[n] = ort_why
        elif c["kind"] == "ort" and c["provider"] == "cuda" and "CUDAExecutionProvider" not in ort_providers:
            skipped[n] = f"this onnxruntime build has no CUDAExecutionProvider (providers: {ort_providers}); see the doc for the aarch64 CUDA wheel"
        else:
            runnable.append(c)

    sampler = GpuSampler()
    env = environment(sampler)
    log(f"narration bench — {env.get('gpu') or env['machine']} · {env['cpu_count']} CPUs · python {env['python']}"
        f"{' · SMOKE' if args.smoke else ''}")
    for c in runnable:
        log(f"  will run  {cfg_name(c)}")
    for k, v in skipped.items():
        log(f"  skip      {k}: {v}")
    if args.check:
        return 0 if runnable else 1
    if not runnable:
        log("nothing can run here.")
        return 1

    # ---- weights and workloads ---------------------------------------------
    try:
        voices = load_voices(args.voices, work_dir, allow_dl)
    except Unavailable as exc:
        log(f"cannot load voices: {exc}")
        return 1
    probe = probe_chunks(args.smoke)
    cat = None
    try:
        cat = catalogue(work_dir, args.smoke)
    except Unavailable as exc:
        skipped["catalogue"] = str(exc)
        log(f"  skip      catalogue: {exc}")
    torch_weights = None
    if any(c["kind"] == "torch" for c in runnable):
        try:
            torch_weights = {
                n: ensure_file(n, TORCH_URL.format(repo=TORCH_REPO, rev=TORCH_REVISION, name=n), p["sha256"], p["bytes"],
                               work_dir / "torch", [], allow_dl)
                for n, p in TORCH_FILES.items()
            }
        except (Unavailable, OSError) as exc:
            for c in [c for c in runnable if c["kind"] == "torch"]:
                skipped[cfg_name(c)] = f"torch weights: {exc}"
            runnable = [c for c in runnable if c["kind"] != "torch"]
    onnx_paths = {}
    if any(c["kind"] == "ort" for c in runnable):
        pins = read_pins()["models"]
        for m in {c["model"] for c in runnable if c["kind"] == "ort"}:
            pin = pins.get(ONNX_MODEL_NAMES[m])
            try:
                if not pin:
                    raise Unavailable(f"no pin for {ONNX_MODEL_NAMES[m]} in fetch-models.mjs")
                onnx_paths[m] = ensure_file(pin["name"], pin["url"], pin["sha256"], pin["bytes"], work_dir / "onnx",
                                            weight_search_dirs(), allow_dl)
            except (Unavailable, OSError) as exc:
                for c in [c for c in runnable if c["kind"] == "ort" and c["model"] == m]:
                    skipped[cfg_name(c)] = f"onnx weights: {exc}"
                runnable = [c for c in runnable if not (c["kind"] == "ort" and c["model"] == m)]

    results = {
        "kind": "foray-narration-bench", "version": 1, "smoke": args.smoke, "env": env,
        "voices": args.voices, "speeds": args.speeds,
        "weights": {
            "voices": {v: {"sha256": d["sha256"], "pinned_by": d["pinned_by"]} for v, d in voices.items()},
            "torch": {"repo": TORCH_REPO, "revision": TORCH_REVISION, **{n: p["sha256"] for n, p in TORCH_FILES.items()}} if torch_weights else None,
            "onnx": {m: ONNX_MODEL_NAMES[m] for m in onnx_paths},
        },
        "precision_policy": "torch bf16/fp16 = torch.autocast; STFT/iSTFT and the SineGen harmonic source kept fp32; on CPU the LSTMs too",
        "probe": {"chunks": len(probe), "source": str(PASSAGE_PATH.relative_to(REPO_ROOT)), "smoke_sample": "2 shortest chunks" if args.smoke else None},
        "catalogue_summary": None, "runs": [], "batched": [], "extrapolation": [], "skipped": skipped,
    }
    if cat:
        results["catalogue_summary"] = {
            "forays": len(cat["forays"]), "vocab": cat["vocab"],
            "chunks": sum(len(f["chunks"]) for f in cat["forays"]),
            "unsingable_chunks": sum(f["unsingable_chunks"] for f in cat["forays"]),
            "per_foray": [{k: f[k] for k in ("id", "status", "items", "chars", "unsingable_chunks")} | {"chunks": len(f["chunks"])} for f in cat["forays"]],
        }

    sampler.start()
    results["idle_gpu_watts"] = sampler.idle_watts() if sampler.exe else None
    out_dir.mkdir(parents=True, exist_ok=True)

    def save():
        body = {k: v for k, v in results.items()}
        (out_dir / "results.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        with (out_dir / "results.md").open("w", encoding="utf-8", newline="\n") as fh:
            fh.write(markdown(results))

    for c in runnable:
        name = cfg_name(c)
        gpu = (c.get("device") == "cuda") or (c.get("provider") == "cuda")
        log(f"\n== {name}")
        backend = None
        try:
            if c["kind"] == "torch":
                backend = TorchBackend(c["device"], c["precision"], torch_weights, args.torch_cpu_threads)
            else:
                backend = OrtBackend(onnx_paths[c["model"]], c["model"], c["provider"], c.get("threads"))
        except Unavailable as exc:
            skipped[name] = str(exc)
            log(f"  skip: {exc}")
            continue
        except Exception as exc:
            skipped[name] = f"load failed: {type(exc).__name__}: {str(exc)[:300]}"
            log(f"  skip: load failed: {exc}")
            continue
        first_voice = voices[args.voices[0]]["matrix"]
        try:
            cold = warmup(backend, probe, first_voice, 1 if args.smoke else WARMUP_CHUNKS, args.max_warmup_sec)
            log(f"  loaded in {backend.load_sec:.1f} s, warm-up {cold:.2f} s")
            if args.max_warmup_sec and cold > args.max_warmup_sec:
                # A config this slow would eat the run (bf16 on a CPU without
                # native bf16 took >10 min for ONE 7-token chunk on the
                # founder's PC). Record it as a result and move on.
                skipped[name] = f"too slow to measure: warm-up took {cold:.0f} s (> --max-warmup-sec {args.max_warmup_sec:g})"
                log(f"  skip: {skipped[name]}")
                save()
                continue
            # GPU configs: every voice. CPU configs: the first voice only — the
            # graph is identical for every voice (the voice is a 256-float
            # style row), so a second voice would re-measure the same thing.
            run_voices = args.voices if gpu or args.smoke else args.voices[:1]
            meta = {"config": name, "load_sec": round(backend.load_sec, 2), "cold_sec": cold}
            for v in run_voices:
                for sp in args.speeds:
                    keep = (not args.no_wavs) and v == args.voices[0] and sp == 1.0
                    r = run_sequence(backend, probe, voices[v]["matrix"], sp, sampler, keep_audio=keep)
                    if keep:
                        import numpy as np

                        write_wav(out_dir / "wav" / f"probe-{name}-{v}.wav", np.concatenate(r.pop("_audio")))
                    results["runs"].append({**meta, "workload": "probe", "voice": v, "speed": sp, **r})
                    log(f"  probe     {v} x{sp:g}: {r['audio_sec']:.1f} s audio in {r['wall_sec']:.2f} s = {r['xrt']:.2f} xRT"
                        f" (p50 {r['p50_ms']:.0f} ms, finite {'y' if r['finite'] else 'N'})")
                    save()
            if cat and (gpu or args.catalogue_cpu):
                for v in args.voices:
                    for sp in args.speeds:
                        for f in cat["forays"]:
                            if not f["chunks"]:
                                continue
                            r = run_sequence(backend, f["chunks"], voices[v]["matrix"], sp, sampler)
                            results["runs"].append({**meta, "workload": "catalogue", "foray": f["id"], "voice": v, "speed": sp, **r})
                            log(f"  catalogue {v} x{sp:g} {f['id'][:40]}: {r['audio_sec']:.0f} s audio in {r['wall_sec']:.1f} s"
                                f" = {r['xrt']:.2f} xRT (finite {'y' if r['finite'] else 'N'})")
                            save()
            if backend.supports_batch and (gpu or args.batched_cpu):
                chunks = [ids for f in cat["forays"] for ids in f["chunks"]] if cat else probe
                for b in run_batched(backend, chunks, first_voice, args.batch_sizes, sampler,
                                     fidelity_items=2 if args.smoke else 8, warm=not args.smoke):
                    results["batched"].append({"config": name, **b})
                    if b.get("error"):
                        log(f"  batch {b['batch']}: {b['error']}")
                    else:
                        log(f"  batch {b['batch']:>3}: {b['xrt']:.1f} xRT, {b['chunks_per_sec']:.1f} chunks/s, "
                            f"durations equal {b['duration_match']}, LSD {b['lsd_db_vs_unbatched']} dB (floor {b['lsd_db_floor']})")
                    save()
            elif c["kind"] == "ort" and gpu:
                results["batched"].append({"config": name, "batch": "–", "error": "the pinned ONNX graph takes batch 1 (input_ids [1, T])"})
        except Exception as exc:
            skipped[name] = f"failed mid-run: {type(exc).__name__}: {str(exc)[:300]}"
            log(f"  FAILED: {exc}")
            traceback.print_exc()
        finally:
            backend.close()
            del backend
            gc.collect()

    sampler.stop()
    if cat:
        s1 = [r["audio_sec"] for r in results["runs"] if r["workload"] == "catalogue" and r["speed"] == 1.0]
        if s1:
            by_foray = {}
            for r in results["runs"]:
                if r["workload"] == "catalogue" and r["speed"] == 1.0:
                    by_foray.setdefault(r["foray"], []).append(r["audio_sec"])
            results["catalogue_summary"]["mean_audio_sec_speed1"] = round(
                statistics.fmean([statistics.fmean(v) for v in by_foray.values()]), 1)
    counts = [int(x) for x in args.extrapolate.split(",") if x.strip()]
    results["extrapolation"] = extrapolate(results, counts, args.system_watts)
    save()
    md = markdown(results)
    log("\n" + md)
    log(f"wrote {out_dir / 'results.md'} and {out_dir / 'results.json'}")
    if not results["runs"]:
        return 1
    if args.smoke:
        bad = [r["config"] for r in results["runs"] if not r["finite"] and r["config"].endswith("fp32")]
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
