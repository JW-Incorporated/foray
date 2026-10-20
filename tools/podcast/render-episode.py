#!/usr/bin/env python3
"""Render a Foray into one podcast-ready audio file (#1457, part of #1425).

Ported from the flagship builder's bake.py / finish.py / align.py / seamcheck3.py
(asteroids-flagship-1). Input is the plan.json that tools/podcast/render-plan.mjs
writes; see docs/podcast/rendering.md.

  python render-episode.py --check                          which deps are missing
  python render-episode.py fetch   plan.json --cache DIR    download once, verify duration
  python render-episode.py bake    plan.json --out DIR      per-item master -> master.wav, bake.json
  python render-episode.py finish  --out DIR                encode mp3 + m4a, measure, report.json
  python render-episode.py all     plan.json --out DIR      fetch + bake + finish
  python render-episode.py align   plan.json --out words.json     (needs faster-whisper; slow)
  python render-episode.py seamcheck --out DIR [--seams A>B,...]  (needs faster-whisper; slow)

`bake --dry-run` prints the ffmpeg argv and the filter graph for every item and
the encode, and needs neither audio nor numpy nor ffmpeg.

Per item (float32, 44.1 kHz mono working signal):
  1. decode; a tape clip goes through a gentle speech compressor in the same
     ffmpeg call (#1451). Interview tape arrives with a 20-26 dB crest factor;
     without the compressor, matching it to narration pushes its peaks 4-8 dB over
     full scale and the only way to a -1 dBTP master is a loudnorm pass that
     silently drops to DYNAMIC mode;
  2. narration: leading/trailing pad trimmed to NARR_PAD_KEEP_SEC (#1452);
  3. level-match to the target for the OUTPUT channel layout, measured on that
     layout (#1453): -19 LUFS for a mono build, -16 for a stereo one;
  4. a 4x-oversampled peak limiter at LIMIT_DB so the per-item true peak is bounded;
  5. fades: tape 25 ms in / 80 ms out, narration 15 ms.
Assembly: shared pink room tone between items, gap chosen by seam type (#1452).
No loudness processing on the master; the encode may apply a pure gain to satisfy
the true-peak ceiling. Exit status is non-zero if the encoded true peak is over -1 dBTP.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

# ---------------------------------------------------------------- tuned constants
# Every value below is the flagship's, unchanged. The comment names the lesson.
SR = 44100                    # working sample rate
TARGET_LUFS_MONO = -19.0      # #1453: as-heard target for a mono file (Apple's podcast spec)
TARGET_LUFS_STEREO = -16.0    # #1453: as-heard target for a stereo file; the flagship matched a MONO signal to
                              #        this and got -13.1 dual-mono, then fixed it with MASTER_GAIN_DB -2.9
LIMIT_DB = -2.0               # #1451: per-item limiter ceiling, sample peak at 4x oversampling
LIMIT_OVERSAMPLE_SR = 176400  # #1451: 4 x 44.1 kHz
LIMIT_ATTACK_MS = 3           # #1451
LIMIT_RELEASE_MS = 60         # #1451
TP_MAX = -1.0                 # #1451: encoded true-peak ceiling; finish fails above it
TP_RETRY_MARGIN_DB = 0.2      # #1451: extra pull-back on each true-peak retry
TP_ATTEMPTS = 3               # #1451
GAP_SEC = {                   # #1452: designed seam gap by seam type (pads already stack; do not add blindly)
    "tape-narr": 0.45,        # GAP_TAPE_NARR in bake.py
    "narr-tape": 0.45,
    "narr-narr": 0.45,
    "tape-tape": 0.6,         # GAP_CLIP_CLIP in bake.py
}
ROOM_DB = -66.0               # #1452: room tone RMS in dBFS, never digital black
ROOM_TONE_SEC = 2.0           # #1452: length of the shared tone; each gap is a prefix of it
ROOM_TONE_SEED = 66           # #1452: fixed seed so a re-render is bit-identical
ROOM_FADE_SEC = 0.05          # #1452: fade on both ends of every gap
NARR_PAD_KEEP_SEC = 0.12      # #1452: Kokoro lines arrive with ~0.5 s of pad at each end (edge_pad_sec)
NARR_TRIM_THRESH_DB = -45.0   # #1452: silence threshold for the pad trim
TAPE_FADE_IN_SEC = 0.025      # #1452
TAPE_FADE_OUT_SEC = 0.08      # #1452
NARR_FADE_SEC = 0.015         # #1452
COMP = "acompressor=threshold=0.1:ratio=3:attack=10:release=150:knee=4"  # #1451: -20 dBFS, 3:1, 10/150 ms
ENCODE_BITRATE = "128k"       # flagship: AAC 128k m4a and MP3 128k
MASTER_TOL_LU = 0.5           # #1453: measured master must be within +-0.5 LU of the target before encoding
FETCH_DURATION_TOL_SEC = 1.5  # #1441 / #1428: delivered vs feed duration; beyond this the cut points cannot be trusted
LOUDNORM_TP = -2.0            # #1451: only used with finish --loudnorm
ALIGN_PAD_SEC = 14.0          # #1442: +-14 s window around each clip edge
ALIGN_MODEL = "base.en"       # #1442 / #1446
SEAM_LEAD_SEC = 0.3           # #1458: start each edge window just BEFORE the edge, never straddling the gap
SEAM_WINDOW_SEC = 4.5         # #1458
USER_AGENT = "4a-render-episode/1 (+https://github.com/JW-Incorporated/foray)"


class Refuse(Exception):
    """A check refused to continue; the message is for the operator."""


# ---------------------------------------------------------------- pure helpers
def target_lufs(channels):
    return TARGET_LUFS_MONO if channels == 1 else TARGET_LUFS_STEREO


def channels_of(layout):
    if layout not in ("mono", "stereo"):
        raise Refuse(f"channels must be mono or stereo (got {layout!r})")
    return 1 if layout == "mono" else 2


def url_key(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def cache_path(cache_dir, url):
    return os.path.join(cache_dir, url_key(url) + ".bin")


def limiter_filter():
    return (f"aresample={LIMIT_OVERSAMPLE_SR},alimiter=limit={10 ** (LIMIT_DB / 20):.4f}:"
            f"attack={LIMIT_ATTACK_MS}:release={LIMIT_RELEASE_MS}:level=0,aresample={SR}")


def decode_argv(ff, path, start=None, end=None, af=None):
    args = [ff, "-v", "error", "-i", path]
    if start is not None:
        args += ["-ss", f"{start:.3f}", "-to", f"{end:.3f}"]
    if af:
        args += ["-af", af]
    return args + ["-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]


def ebur_argv(ff, path):
    return [ff, "-v", "info", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]


def through_argv(ff, path, af):
    return [ff, "-v", "error", "-i", path, "-af", af, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]


def encode_argv(ff, master, meta, out, codec, gain_db=0.0):
    pre = ["-af", f"volume={gain_db}dB"] if gain_db else []
    head = [ff, "-v", "error", "-y", "-i", master, "-i", meta, "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", *pre]
    if codec == "m4a":
        return head + ["-c:a", "aac", "-b:a", ENCODE_BITRATE, "-movflags", "+faststart", out]
    return head + ["-c:a", "libmp3lame", "-b:a", ENCODE_BITRATE, "-id3v2_version", "3", out]


def fades_for(item_type):
    return (TAPE_FADE_IN_SEC, TAPE_FADE_OUT_SEC) if item_type == "clip" else (NARR_FADE_SEC, NARR_FADE_SEC)


def gap_for(seam_type):
    if seam_type not in GAP_SEC:
        raise Refuse(f"unknown seam type {seam_type!r} (known: {', '.join(sorted(GAP_SEC))})")
    return GAP_SEC[seam_type]


def seam_of(prev_type, item_type):
    return f"{'narr' if prev_type == 'narr' else 'tape'}-{'narr' if item_type == 'narr' else 'tape'}"


def find_narration(narr_dir, foray_id, item_id):
    """The rendered narration for an item: a sidecar .json {foray_id, item_id} next to
    an audio file of the same stem (tools/narration/render-foray.py's layout), or
    <narr_dir>/<item_id>.{wav,m4a,mp3,flac}. None if absent."""
    if not narr_dir or not os.path.isdir(narr_dir):
        return None
    for root, _dirs, files in os.walk(narr_dir):
        for name in files:
            if not name.endswith(".json"):
                continue
            try:
                side = json.load(open(os.path.join(root, name), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(side, dict) and side.get("item_id") == item_id and side.get("foray_id") in (foray_id, None):
                stem = os.path.join(root, name[:-5])
                for ext in (".m4a", ".wav", ".mp3", ".flac"):
                    if os.path.exists(stem + ext):
                        return stem + ext
    for ext in (".wav", ".m4a", ".mp3", ".flac"):
        p = os.path.join(narr_dir, item_id + ext)
        if os.path.exists(p):
            return p
    return None


def load_plan(path):
    plan = json.load(open(path, encoding="utf-8"))
    if plan.get("version") != 1:
        raise Refuse(f"{path}: plan version {plan.get('version')!r} is not supported (expected 1)")
    if not plan.get("items"):
        raise Refuse(f"{path}: plan has no items")
    return plan


def load_src_map(path):
    return json.load(open(path, encoding="utf-8")) if path else {}


def source_path(item, cache_dir, src_map):
    return src_map.get(item["source_id"]) or cache_path(cache_dir, item["url"])


def bake_steps(plan, ff, cache_dir, src_map, narr_dir, channels=None, strict=False):
    """Everything bake will do, as data. No audio is touched; `strict` demands the inputs exist."""
    layout = channels or plan.get("channels") or "stereo"
    nch = channels_of(layout)
    steps, missing, prev = [], [], None
    for k, it in enumerate(plan["items"]):
        if it["type"] == "clip":
            src = source_path(it, cache_dir, src_map)
            if strict and not os.path.exists(src):
                missing.append(f"{it['label']}: {src} (run `fetch` first)")
            decode = decode_argv(ff, src, it["in"], it["out"], af=COMP)
            name = it["label"]
        else:
            src = find_narration(narr_dir, plan.get("foray_id"), it["id"]) or os.path.join(narr_dir or "<narr-dir>", it["id"] + ".<ext>")
            if strict and not os.path.exists(src):
                missing.append(f"{it['id']}: no rendered narration under {narr_dir}")
            decode = decode_argv(ff, src)
            name = it["id"]
        seam = seam_of(prev, it["type"]) if prev else None
        fin, fout = fades_for(it["type"])
        steps.append({
            "i": k, "type": it["type"], "name": name, "source": src, "chapter": it.get("chapter"),
            "decode": decode, "trim_pad": it["type"] == "narr",
            "measure": ebur_argv(ff, "<item.wav>"), "target_lufs": target_lufs(nch), "channels": nch,
            "limit": through_argv(ff, "<item.wav>", limiter_filter()),
            "fade_in_sec": fin, "fade_out_sec": fout,
            "seam": seam, "gap_before_sec": gap_for(seam) if seam else None,
        })
        prev = it["type"]
    if missing:
        raise Refuse("missing inputs:\n  " + "\n  ".join(missing))
    return {"channels": layout, "target_lufs": target_lufs(nch), "limiter": limiter_filter(), "comp": COMP, "steps": steps}


def assert_linear_loudnorm(stats):
    """#1451: loudnorm only counts as linear if it says so. Called on pass-2 JSON."""
    t = stats.get("normalization_type")
    if t != "linear":
        raise Refuse(f"loudnorm ran in {t!r} mode, not linear (the premaster's true peak is too hot for the target); "
                     "refusing to ship a dynamically processed master")


def check_master_loudness(measured_i, target):
    if abs(measured_i - target) > MASTER_TOL_LU:
        raise Refuse(f"master measures {measured_i} LUFS, target {target} +-{MASTER_TOL_LU} (#1453): "
                     "items were level-matched for a different channel layout than the master")


# ---------------------------------------------------------------- tools
def find_tool(name, ffmpeg=None):
    """ffmpeg/ffprobe: --ffmpeg's directory, else PATH."""
    if ffmpeg:
        if os.path.isdir(ffmpeg):
            cand = os.path.join(ffmpeg, name)
        else:
            d, base = os.path.split(ffmpeg)
            cand = os.path.join(d, base.replace("ffmpeg", name)) if name != "ffmpeg" else ffmpeg
        for c in (cand, cand + ".exe"):
            if os.path.exists(c):
                return c
    return shutil.which(name) or name


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def pcm_from(argv):
    import numpy as np
    out = subprocess.run(argv, check=True, capture_output=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def write_wav(path, pcm, nch, subtype="FLOAT"):
    import numpy as np
    import soundfile as sf
    sf.write(path, pcm if nch == 1 else np.stack([pcm] * nch, axis=1), SR, subtype=subtype)


def ebur(ff, path):
    r = subprocess.run(ebur_argv(ff, path), capture_output=True, text=True)
    if "Summary:" not in r.stderr:
        raise Refuse(f"ebur128 gave no summary for {path}:\n{r.stderr[-400:]}")
    tail = r.stderr[r.stderr.rindex("Summary:"):]
    return {"I": float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1)),
            "LRA": float(re.search(r"LRA:\s+(-?[\d.]+) LU", tail).group(1)),
            "TP": float(re.search(r"Peak:\s+(-?[\d.inf]+) dBFS", tail).group(1))}


def ebur_pcm(ff, pcm, tmp, nch):
    write_wav(tmp, pcm, nch)
    return ebur(ff, tmp)


def ffprobe_duration(fp, path):
    r = run([fp, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path])
    return float(r.stdout.strip())


# ---------------------------------------------------------------- signal
def trim_silence(pcm):
    import numpy as np
    win = int(0.01 * SR)
    n = len(pcm) // win
    rms = np.sqrt(np.mean(pcm[: n * win].reshape(n, win) ** 2, axis=1) + 1e-12)
    loud = np.where(20 * np.log10(rms) > NARR_TRIM_THRESH_DB)[0]
    if not len(loud):
        return pcm
    a = max(0, loud[0] * win - int(NARR_PAD_KEEP_SEC * SR))
    b = min(len(pcm), (loud[-1] + 1) * win + int(NARR_PAD_KEEP_SEC * SR))
    return pcm[a:b]


def fade(pcm, fin, fout):
    import numpy as np
    n_in, n_out = int(fin * SR), int(fout * SR)
    if n_in:
        pcm[:n_in] *= np.linspace(0, 1, n_in, dtype=np.float32) ** 2
    if n_out:
        pcm[-n_out:] *= np.linspace(1, 0, n_out, dtype=np.float32) ** 2
    return pcm


def room_tone(sec, rng):
    import numpy as np
    n = int(sec * SR)
    white = rng.standard_normal(n + 4096).astype(np.float32)
    b = np.zeros(3, dtype=np.float32)
    out = np.empty_like(white)
    for i, w in enumerate(white):  # Paul Kellet's economy pink filter
        b[0] = 0.99765 * b[0] + w * 0.0990460
        b[1] = 0.96300 * b[1] + w * 0.2965164
        b[2] = 0.57000 * b[2] + w * 1.0526913
        out[i] = b[0] + b[1] + b[2] + w * 0.1848
    out = out[4096:]
    out *= (10 ** (ROOM_DB / 20)) / (np.sqrt(np.mean(out ** 2)) + 1e-12)
    return out


# ---------------------------------------------------------------- subcommands
def cmd_fetch(a):
    plan = load_plan(a.plan)
    ff = find_tool("ffmpeg", a.ffmpeg)
    fp = find_tool("ffprobe", a.ffmpeg)
    src_map = load_src_map(a.src_map)
    seen, bad = set(), []
    os.makedirs(a.cache, exist_ok=True)
    for it in plan["items"]:
        if it["type"] != "clip" or it["source_id"] in seen:
            continue
        seen.add(it["source_id"])
        path = source_path(it, a.cache, src_map)
        if a.dry_run:
            print(json.dumps({"source": it["source_id"], "url": it["url"], "path": path, "exists": os.path.exists(path)}))
            continue
        if not os.path.exists(path):
            if it["source_id"] in src_map:
                raise Refuse(f"{it['source_id']}: --src-map names {path}, which does not exist")
            print(f"fetch {it['source_id']} -> {path}", flush=True)
            req = urllib.request.Request(it["url"], headers={"User-Agent": USER_AGENT})
            tmp = path + ".part"
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as fh:
                shutil.copyfileobj(r, fh)
            os.replace(tmp, path)
        got = ffprobe_duration(fp, path)
        want = it["feed_duration_sec"]
        verdict = abs(got - want) <= FETCH_DURATION_TOL_SEC
        print(f"{it['source_id'][:60]:60s} feed {want:8.1f}s delivered {got:8.1f}s {'ok' if verdict else 'MISMATCH'}")
        if not verdict:
            bad.append(f"{it['source_id']}: delivered {got:.1f}s, feed says {want}s")
    if bad:
        raise Refuse("delivered duration differs from the feed by more than "
                     f"{FETCH_DURATION_TOL_SEC} s (dynamic ad insertion or a re-encode?); the committed cut points "
                     "cannot be trusted on this audio. Locate the clips by ASR instead (the locate step, #1428):\n  "
                     + "\n  ".join(bad))
    return 0


def cmd_bake(a):
    import numpy as np
    plan = load_plan(a.plan)
    ff = find_tool("ffmpeg", a.ffmpeg)
    steps = bake_steps(plan, ff, a.cache, load_src_map(a.src_map), a.narr_dir, a.channels, strict=not a.dry_run)
    if a.dry_run:
        gaps = [s["gap_before_sec"] for s in steps["steps"]]
        steps["master"] = {"file": "master.wav", "subtype": "PCM_24", "channels": steps["channels"], "gaps": gaps}
        steps["encode"] = {c: encode_argv(ff, "master.wav", "chapters.ffmeta", f"{plan.get('basename', 'foray')}.{c}", c) for c in ("m4a", "mp3")}
        print(json.dumps(steps, indent=1))
        return 0
    nch = channels_of(steps["channels"])
    os.makedirs(a.out, exist_ok=True)
    tmp = os.path.join(a.out, "_tmp.wav")
    tone = room_tone(ROOM_TONE_SEC, np.random.default_rng(ROOM_TONE_SEED))
    parts, chapters, items = [], [], []
    t = 0.0
    for st in steps["steps"]:
        pcm = pcm_from(st["decode"])
        if st["trim_pad"]:
            pcm = trim_silence(pcm)
        m0 = ebur_pcm(ff, pcm, tmp, nch)
        pcm = pcm * np.float32(10 ** ((st["target_lufs"] - m0["I"]) / 20))
        write_wav(tmp, pcm, 1)
        pcm = pcm_from(through_argv(ff, tmp, limiter_filter()))
        pcm = fade(pcm, st["fade_in_sec"], st["fade_out_sec"])
        m1 = ebur_pcm(ff, pcm, tmp, nch)
        if st["gap_before_sec"]:
            gap = st["gap_before_sec"]
            parts.append(fade(tone[: int(gap * SR)].copy(), ROOM_FADE_SEC, ROOM_FADE_SEC))
            t += gap
        if st["chapter"]:
            chapters.append({"start": round(t, 3), "title": st["chapter"]})
        items.append({"i": st["i"], "type": st["type"], "label": st["name"], "at": round(t, 2), "dur": round(len(pcm) / SR, 2),
                      "seam_before": st["seam"], "in_lufs": m0["I"], "in_tp": m0["TP"], "out_lufs": m1["I"], "out_tp": m1["TP"]})
        print(f"{st['name']:16s} {m0['I']:6.1f} LUFS / {m0['TP']:5.1f} dBTP -> {m1['I']:6.1f} / {m1['TP']:5.1f}", flush=True)
        parts.append(pcm.astype(np.float32))
        t += len(pcm) / SR
    mix = np.concatenate(parts)
    write_wav(os.path.join(a.out, "master.wav"), mix, nch, subtype="PCM_24")
    os.remove(tmp)
    json.dump({"plan": os.path.abspath(a.plan), "channels": steps["channels"], "target_lufs": steps["target_lufs"],
               "duration_sec": round(len(mix) / SR, 2), "title": plan["title"], "artist": plan["artist"],
               "album": plan.get("album", plan["title"]), "comment": plan.get("comment", ""),
               "basename": plan.get("basename", "foray"), "chapters": chapters, "items": items},
              open(os.path.join(a.out, "bake.json"), "w", encoding="utf-8"), indent=1)
    print(f"bake: {len(items)} items, {len(mix) / SR:.1f} s -> {a.out}")
    return 0


def write_ffmeta(path, bake, total):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(";FFMETADATA1\n")
        fh.write(f"title={bake['title']}\nartist={bake['artist']}\nalbum={bake['album']}\n")
        fh.write(f"comment={bake['comment']}\n")
        ch = bake["chapters"]
        for k, c in enumerate(ch):
            end = ch[k + 1]["start"] if k + 1 < len(ch) else total
            fh.write(f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(c['start'] * 1000)}\nEND={int(end * 1000)}\ntitle={c['title']}\n")


def loudnorm_linear(ff, master, out):
    """Optional two-pass loudnorm in linear mode; refuses if it fell back to dynamic (#1451)."""
    tgt = TARGET_LUFS_STEREO if master_channels(master) == 2 else TARGET_LUFS_MONO
    base = f"loudnorm=I={tgt}:TP={LOUDNORM_TP}:LRA=11"
    r = subprocess.run([ff, "-v", "info", "-nostats", "-i", master, "-af", base + ":print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    p1 = json.loads(r.stderr[r.stderr.rindex("{"):])
    af = (base + f":measured_I={p1['input_i']}:measured_TP={p1['input_tp']}:measured_LRA={p1['input_lra']}:"
          f"measured_thresh={p1['input_thresh']}:offset={p1['target_offset']}:linear=true:print_format=json")
    r = subprocess.run([ff, "-v", "info", "-nostats", "-i", master, "-af", af, "-c:a", "pcm_s24le", "-y", out], capture_output=True, text=True)
    p2 = json.loads(r.stderr[r.stderr.rindex("{"):])
    assert_linear_loudnorm(p2)
    return p2


def master_channels(path):
    import soundfile as sf
    return sf.info(path).channels


def cmd_finish(a):
    import soundfile as sf
    ff = find_tool("ffmpeg", a.ffmpeg)
    bake = json.load(open(os.path.join(a.out, "bake.json"), encoding="utf-8"))
    master = os.path.join(a.out, "master.wav")
    info = sf.info(master)
    total = info.frames / info.samplerate
    meta = os.path.join(a.out, "chapters.ffmeta")
    write_ffmeta(meta, bake, total)
    processing = "none (gain only)"
    if a.loudnorm:
        lin = os.path.join(a.out, "master-loudnorm.wav")
        stats = loudnorm_linear(ff, master, lin)
        master, processing = lin, f"loudnorm linear (output_i {stats['output_i']})"
    master_m = ebur(ff, master)
    check_master_loudness(master_m["I"], bake["target_lufs"])
    base = bake["basename"]
    m4a, mp3 = os.path.join(a.out, base + ".m4a"), os.path.join(a.out, base + ".mp3")
    gain, finals = 0.0, {}
    for _attempt in range(TP_ATTEMPTS):
        run(encode_argv(ff, master, meta, m4a, "m4a", gain))
        run(encode_argv(ff, master, meta, mp3, "mp3", gain))
        finals = {os.path.basename(f): ebur(ff, f) for f in (m4a, mp3)}
        worst = max(v["TP"] for v in finals.values())
        if worst <= TP_MAX:
            break
        gain -= (worst - TP_MAX) + TP_RETRY_MARGIN_DB
    rep = {"duration_sec": bake["duration_sec"], "channels": bake["channels"], "target_lufs": bake["target_lufs"],
           "master": master_m, "encode_gain_db": round(gain, 2), "loudness_processing": processing,
           "final": finals, "chapters": bake["chapters"], "items": bake["items"]}
    with open(os.path.join(a.out, "chapters.txt"), "w", encoding="utf-8") as fh:
        for c in bake["chapters"]:
            s = int(c["start"])
            fh.write(f"{s // 60}:{s % 60:02d}  {c['title']}\n")
    worst = max(v["TP"] for v in finals.values())
    rep["true_peak_ok"] = worst <= TP_MAX
    json.dump(rep, open(os.path.join(a.out, "report.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({k: rep[k] for k in ("duration_sec", "master", "encode_gain_db", "final")}, indent=1))
    if not rep["true_peak_ok"]:
        raise Refuse(f"encoded true peak {worst} dBTP is over {TP_MAX} after {TP_ATTEMPTS} attempts; report.json written, nothing to ship")
    return 0


def cmd_all(a):
    a.dry_run = False
    cmd_fetch(a)
    cmd_bake(a)
    return cmd_finish(a)


def need_whisper():
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise Refuse(f"faster-whisper is not installed ({e}); pip install -r tools/podcast/requirements.txt, then the optional line")
    return WhisperModel


def window_pcm(ff, src, start, dur):
    """16 kHz mono float32 straight from ffmpeg: no PyAV (#1454)."""
    return pcm_from([ff, "-v", "error", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", src, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])


def cmd_align(a):
    """Word timestamps in a +-ALIGN_PAD_SEC window around every clip edge (#1442). Evidence only; the
    snap rule (first word of the run-up sentence - 0.25 s, last word + 0.35 s) is applied by whoever curates the cut."""
    WhisperModel = need_whisper()
    plan = load_plan(a.plan)
    ff = find_tool("ffmpeg", a.ffmpeg)
    src_map = load_src_map(a.src_map)
    model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=4)
    out = {}
    for it in plan["items"]:
        if it["type"] != "clip":
            continue
        src = source_path(it, a.cache, src_map)
        res = {}
        for edge in ("in", "out"):
            t = it[edge]
            start = max(0, t - a.pad)
            pcm = window_pcm(ff, src, start, 2 * a.pad)
            segs, _ = model.transcribe(pcm, word_timestamps=True, beam_size=5, vad_filter=False, condition_on_previous_text=False)
            res[edge] = [[round(start + w.start, 2), round(start + w.end, 2), w.word] for s in segs for w in s.words]
        out[it["label"]] = res
        print(it["label"], "done", flush=True)
    dest = os.path.join(a.out, "words.json") if os.path.isdir(a.out) else a.out
    json.dump(out, open(dest, "w", encoding="utf-8"), indent=0)
    return 0


def cmd_seamcheck(a):
    """ASR from SEAM_LEAD_SEC before each tape edge on the encoded file (#1458)."""
    WhisperModel = need_whisper()
    ff = find_tool("ffmpeg", a.ffmpeg)
    rep = json.load(open(os.path.join(a.out, "report.json"), encoding="utf-8"))
    base = next(iter(rep["final"]))
    audio = a.audio or os.path.join(a.out, base)
    want = a.seams.split(",") if a.seams else None
    model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=4)
    items = rep["items"]
    for k in range(1, len(items)):
        x, y = items[k - 1], items[k]
        name = f"{x['label']}>{y['label']}"
        if want and name not in want:
            continue
        cut, edge = x["at"] + x["dur"], y["at"]
        start = edge - SEAM_LEAD_SEC
        pcm = window_pcm(ff, audio, start, SEAM_LEAD_SEC + SEAM_WINDOW_SEC)
        segs, _ = model.transcribe(pcm, word_timestamps=True, beam_size=5, condition_on_previous_text=False, vad_filter=False)
        ws = " ".join(f"{start + w.start - cut:+.2f}{w.word}" for s in segs for w in s.words)
        print(f"[{name}] cut=0 gap={edge - cut:.2f}: {ws}", flush=True)
    return 0


def check_deps():
    rows = []
    rows.append(("python>=3.12", True, sys.version_info >= (3, 12), sys.version.split()[0]))
    for mod in ("numpy", "soundfile"):
        try:
            m = __import__(mod)
            rows.append((mod, True, True, getattr(m, "__version__", "?")))
        except ImportError as e:
            rows.append((mod, True, False, str(e)))
    for tool in ("ffmpeg", "ffprobe"):
        p = shutil.which(tool)
        rows.append((tool, True, bool(p), p or "not on PATH (or pass --ffmpeg)"))
    try:
        import faster_whisper
        rows.append(("faster-whisper (align, seamcheck)", False, True, getattr(faster_whisper, "__version__", "?")))
    except ImportError:
        rows.append(("faster-whisper (align, seamcheck)", False, False, "not installed (optional)"))
    return rows


def cmd_check(a):
    rows = check_deps()
    for name, req, ok, detail in rows:
        print(f"{'ok     ' if ok else ('MISSING' if req else 'absent ')} {name}: {detail}")
    return 0 if all(ok for _n, req, ok, _d in rows if req) else 1


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="report missing dependencies and exit")
    sub = ap.add_subparsers(dest="cmd")

    def common(p, plan=True):
        if plan:
            p.add_argument("plan")
        p.add_argument("--ffmpeg", help="ffmpeg binary or its directory (default: PATH)")
        p.add_argument("--cache", default=os.path.join("data-local", "podcast", "cache"), help="download cache, keyed by sha256(url)")
        p.add_argument("--src-map", help="JSON {source_id: local audio path}; used instead of the cache")
        p.add_argument("--narr-dir", help="rendered narration (render-foray.py layout or <id>.wav)")
        p.add_argument("--out", default=os.path.join("data-local", "podcast", "render"))
        p.add_argument("--channels", choices=("mono", "stereo"), help="override the plan's output layout")
        p.add_argument("--dry-run", action="store_true")
        p.add_argument("--loudnorm", action="store_true", help="finish: two-pass loudnorm in linear mode (refuses dynamic)")

    for name, fn in (("fetch", cmd_fetch), ("bake", cmd_bake), ("all", cmd_all)):
        p = sub.add_parser(name)
        common(p)
        p.set_defaults(fn=fn)
    p = sub.add_parser("finish")
    common(p, plan=False)
    p.set_defaults(fn=cmd_finish)
    p = sub.add_parser("align")
    common(p)
    p.add_argument("--pad", type=float, default=ALIGN_PAD_SEC)
    p.add_argument("--model", default=ALIGN_MODEL)
    p.set_defaults(fn=cmd_align)
    p = sub.add_parser("seamcheck")
    common(p, plan=False)
    p.add_argument("--audio")
    p.add_argument("--seams", help="comma list like SMIT-1>into-marshall (default: all)")
    p.add_argument("--model", default=ALIGN_MODEL)
    p.set_defaults(fn=cmd_seamcheck)
    return ap


def main(argv=None):
    ap = build_parser()
    a = ap.parse_args(argv)
    if a.check:
        return cmd_check(a)
    if not a.cmd:
        ap.print_usage(sys.stderr)
        return 2
    try:
        return a.fn(a)
    except Refuse as e:
        print(f"render-episode: REFUSED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
