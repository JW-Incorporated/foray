# Throwaway round 2: which Kokoro export + provider is FINITE and FAST on Apple-silicon ORT.
import json, sys, time, glob, os, numpy as np, onnxruntime as ort
variant, prov = sys.argv[1], sys.argv[2]
print("ort", ort.__version__, "variant", variant, "provider", prov, "cpus", os.cpu_count())
model = f"models/{variant}.onnx"
print("size MB", round(os.path.getsize(model)/1e6, 1))
voice = glob.glob("mobile/models/**/af_heart.bin", recursive=True)[0]
style = np.fromfile(voice, dtype=np.float32).reshape(510, 256)
p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
so = ort.SessionOptions()
providers = ["CPUExecutionProvider"] if prov == "cpu" else [("CoreMLExecutionProvider", {"MLComputeUnits": "ALL"}), "CPUExecutionProvider"]
t = time.time()
try:
    s = ort.InferenceSession(model, so, providers=providers)
except Exception as e:
    print("LOAD THREW", str(e)[:800]); sys.exit(0)
print("load s", round(time.time()-t, 1))
tot_a = tot_t = 0
for ln in p["lines"]:
    ids = ln["ids"]; row = min(max(len(ids) - 2, 0), 509); t = time.time()
    try:
        out = s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": style[row:row+1], "speed": np.array([1.0], dtype=np.float32)})
        w = out[0]; sec = w.shape[-1] / 24000; dt = time.time() - t
        tot_a += sec; tot_t += dt
        print(len(ids), "ok", round(sec, 1), "s audio in", round(dt, 2), "s; finite", bool(np.isfinite(w).all()), "peak", round(float(np.nanmax(np.abs(w))), 3))
    except Exception as e:
        print(len(ids), "THREW", str(e)[:800])
if tot_a: print("RTF(synth/audio)", round(tot_t / tot_a, 2))
