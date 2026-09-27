# Throwaway: wall/CPU RTF of small TTS fallbacks on the same passage text, same arm64 runner.
import json, sys, time, numpy as np
which = sys.argv[1]
p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
lines = [ln["text"] for ln in p["lines"]]

def bench(label, gen, sr, speeds=(1.0,)):
    gen(lines[0][:80], 1.0)  # warm-up
    base = None
    for sp in speeds:
        W = C = A = 0
        for tx in lines:
            w0 = time.perf_counter(); c0 = time.process_time()
            a = gen(tx, sp)
            W += time.perf_counter() - w0; C += time.process_time() - c0; A += a / sr if isinstance(a, int) else len(np.asarray(a).reshape(-1)) / sr
        if base is None: base = A
        print(f"SMALL {label} speed {sp}: audio {A:.1f}s content {base:.1f}s wall {W:.2f}s cpu {C:.2f}s wallRTF_content {W/base:.4f} cpuRTF_content {C/base:.4f}")

if which.startswith("kitten"):
    from kittentts import KittenTTS
    name = {"kitten-nano": "KittenML/kitten-tts-nano-0.8", "kitten-mini": "KittenML/kitten-tts-mini-0.8"}[which]
    t = time.time(); m = KittenTTS(name); print("load s", round(time.time() - t, 1), name)
    vs = getattr(m, "available_voices", None); print("voices", vs)
    v = "Jasper" if vs and "Jasper" in vs else (vs[0] if vs else None)
    bench(which, lambda tx, sp: m.generate(tx, voice=v, speed=sp), 24000, (1.0, 1.5))
elif which == "piper":
    from piper import PiperVoice
    v = PiperVoice.load("models/en_US-lessac-medium.onnx")
    sr = v.config.sample_rate
    def g(tx, sp):
        n = 0
        for ch in v.synthesize(tx): n += len(ch.audio_int16_bytes) // 2
        return n
    bench("piper-lessac-medium", g, sr)
