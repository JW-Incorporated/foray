# Throwaway (lens 2, Apple-native acceleration). NEVER merged.
# One engine config per process so ru_maxrss is that config's own peak.
#   python kokoro_coreml.py ort   <speed> <tag>                 ORT fp32 CPU (4 threads)
#   python kokoro_coreml.py coreml <speed> <tag> <models_dir> <cu>   7-stage laishere chain
#   python kokoro_coreml.py compare <outdir>                    mel-corr vs ORT fp32
# RTF is reported on the CONTENT basis: synth seconds / audio seconds of the SAME
# chunk rendered at speed 1.0 (read back from the ort_s1 run's npz).
import json, os, sys, time, glob, resource, numpy as np

SR = 24000
P = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
CHUNKS = [c for ln in P["lines"] for c in ln["chunks"]]
VOICE = np.fromfile(glob.glob("mobile/models/**/af_heart.bin", recursive=True)[0], dtype=np.float32).reshape(510, 256)
OUT = "out"; os.makedirs(OUT, exist_ok=True)


def row(ids):  # the app's convention (KokoroOrtProbeEngine): unpadded count, clamped
    return min(max(len(ids) - 2, 0), 509)


def maxrss_mb():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6)  # bytes on macOS


def run_all(synth, tag, speed):
    # pass 1 = warm-up (first chunk is the cold one), pass 2 = timed
    cold = None
    for i, c in enumerate(CHUNKS):
        t = time.perf_counter(); synth(c["ids"]); dt = time.perf_counter() - t
        if i == 0: cold = dt
    audios, times = [], []
    for c in CHUNKS:
        t = time.perf_counter(); w = synth(c["ids"]); dt = time.perf_counter() - t
        audios.append(np.asarray(w, dtype=np.float32).flatten()); times.append(dt)
    base = None
    if os.path.exists(f"{OUT}/ort_s1.npz"):
        z = np.load(f"{OUT}/ort_s1.npz"); base = [z[f"a{i}"].size / SR for i in range(len(CHUNKS))]
    sec = [a.size / SR for a in audios]
    content = base if base else sec
    fin = [bool(np.isfinite(a).all()) for a in audios]
    for i, c in enumerate(CHUNKS):
        print(f"  chunk {i:2d} ids={len(c['ids']):3d} audio={sec[i]:5.2f}s synth={times[i]*1000:7.1f}ms finite={fin[i]} peak={float(np.nanmax(np.abs(audios[i]))):.3f}")
    rtf_content = sum(times) / sum(content)
    print(f"RESULT {tag} speed={speed} chunks={len(CHUNKS)} cold_first={cold:.2f}s audio={sum(sec):.1f}s content_audio={sum(content):.1f}s synth={sum(times):.2f}s "
          f"RTF_rendered={sum(times)/sum(sec):.3f} RTF_content={rtf_content:.3f} all_finite={all(fin)} maxrss={maxrss_mb()}MB")
    np.savez(f"{OUT}/{tag}.npz", **{f"a{i}": a for i, a in enumerate(audios)})


def ort_engine(speed, tag):
    import onnxruntime as ort
    so = ort.SessionOptions(); so.intra_op_num_threads = 4
    t = time.perf_counter()
    path = glob.glob("mobile/models/**/kokoro-v1_0-fp32.onnx", recursive=True)[0]
    s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    print("ort", ort.__version__, "model", path, round(os.path.getsize(path) / 1e6, 1), "MB load", round(time.perf_counter() - t, 2), "s")
    sp = np.array([speed], dtype=np.float32)
    def synth(ids):
        r = row(ids)
        return s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": VOICE[r:r + 1], "speed": sp})[0]
    run_all(synth, tag, speed)


def coreml_engine(speed, tag, mdir, cu_name):
    import coremltools as ct
    CU = {"cpu": ct.ComputeUnit.CPU_ONLY, "ne": ct.ComputeUnit.CPU_AND_NE, "all": ct.ComputeUnit.ALL}
    # "mixed" = laishere's iOSDemo placement (ANE for the fp16 stages, ALL for the fp32 ones)
    plan = {k: (CU[cu_name] if cu_name != "mixed" else CU[v]) for k, v in
            dict(Albert="ne", PostAlbert="ne", Alignment="ne", Prosody="all", Noise="all", Vocoder="ne", Tail="all").items()}
    m, total_mb = {}, 0
    t0 = time.perf_counter()
    for k in plan:
        p = os.path.join(mdir, f"Kokoro{k}.mlpackage")
        total_mb += sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(p) for f in fs) / 1e6
        t = time.perf_counter(); m[k] = ct.models.MLModel(p, compute_units=plan[k])
        spec = m[k].get_spec()
        print(f"  load {k:10s} {time.perf_counter()-t:6.2f}s in={[i.name for i in spec.description.input]} out={[o.name for o in spec.description.output]}")
    print(f"coreml models {mdir} total {total_mb:.1f} MB, load(compile) {time.perf_counter()-t0:.1f}s cu={cu_name}")
    f16, f32 = np.float16, np.float32
    spd = np.array([speed], dtype=f16)
    def synth(ids):
        ref = VOICE[row(ids)][None, :]
        s, tim = ref[:, 128:], ref[:, :128]
        T = len(ids)
        iid = np.array([ids], dtype=np.int32); mask = np.ones((1, T), dtype=np.int32)
        a = m["Albert"].predict({"input_ids": iid, "attention_mask": mask})
        b = m["PostAlbert"].predict({"bert_dur": np.asarray(a["bert_dur"]).astype(f16), "input_ids": iid,
                                     "style_s": s.astype(f16), "speed": spd, "attention_mask": mask})
        pd = np.round(np.asarray(b["duration"]).flatten()).clip(min=1).astype(np.int32).reshape(1, -1)
        c = m["Alignment"].predict({"pred_dur": pd, "d": np.asarray(b["d"]).astype(f16), "t_en": np.asarray(b["t_en"]).astype(f16)})
        d = m["Prosody"].predict({"en": np.asarray(c["en"]).astype(f16), "style_s": s.astype(f16)})
        e = m["Noise"].predict({"F0_curve": np.asarray(d["F0"]).astype(f32), "style_timbre": tim.astype(f32)})
        f = m["Vocoder"].predict({"asr": np.asarray(c["asr"]).astype(f16), "F0_curve": np.asarray(d["F0"]).astype(f16),
                                  "N_pred": np.asarray(d["N"]).astype(f16), "x_source_0": np.asarray(e["x_source_0"]).astype(f16),
                                  "x_source_1": np.asarray(e["x_source_1"]).astype(f16), "style_timbre": tim.astype(f16)})
        return m["Tail"].predict({"x_pre": np.asarray(f["x_pre"]).astype(f32)})["audio"]
    run_all(synth, tag, speed)


def mel(x, n_fft=1024, hop=256, n_mels=80):
    from scipy.signal import stft
    fmax = SR / 2
    hz = lambda m_: 700 * (10 ** (m_ / 2595) - 1)
    mm = np.linspace(0, 2595 * np.log10(1 + fmax / 700), n_mels + 2); fr = hz(mm)
    ff = np.linspace(0, fmax, n_fft // 2 + 1); fb = np.zeros((n_mels, ff.size))
    for i in range(n_mels):
        lo, mid, hi = fr[i], fr[i + 1], fr[i + 2]
        fb[i] = np.maximum(0, np.minimum((ff - lo) / max(mid - lo, 1e-10), (hi - ff) / max(hi - mid, 1e-10)))
    _, _, Z = stft(x, fs=SR, nperseg=n_fft, noverlap=n_fft - hop)
    return np.log1p(fb @ (np.abs(Z) ** 2))


def compare():
    ref = np.load(f"{OUT}/ort_s1.npz")
    for f in sorted(glob.glob(f"{OUT}/*.npz")):
        tag = os.path.basename(f)[:-4]
        if tag == "ort_s1": continue
        z = np.load(f); corrs, lens = [], []
        for i in range(len(CHUNKS)):
            a, b = ref[f"a{i}"], z[f"a{i}"]
            lens.append(b.size / a.size)
            if not np.isfinite(b).all(): corrs.append(float("nan")); continue
            if "_s1" in tag:
                n = min(a.size, b.size); A, B = mel(a[:n]), mel(b[:n])
                corrs.append(float(np.corrcoef(A.flatten(), B.flatten())[0, 1]))
        c = [x for x in corrs if x == x]
        print(f"COMPARE {tag:24s} vs ort_s1: len_ratio mean={np.mean(lens):.3f} min={min(lens):.3f} max={max(lens):.3f}"
              + (f"  mel_corr mean={np.mean(c):.4f} min={min(c):.4f} nan_chunks={len(corrs)-len(c)}" if corrs else ""))


if __name__ == "__main__":
    kind = sys.argv[1]
    if kind == "ort": ort_engine(float(sys.argv[2]), sys.argv[3])
    elif kind == "coreml": coreml_engine(float(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5])
    elif kind == "compare": compare()
