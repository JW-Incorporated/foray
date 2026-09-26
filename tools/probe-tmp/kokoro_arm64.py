# Throwaway: reproduce the phone's `inference-threw` on Apple-silicon CPU ORT.
import json, sys, time, glob, numpy as np, onnxruntime as ort
print("ort", ort.__version__, "providers", ort.get_available_providers())
model = glob.glob("mobile/models/**/kokoro-v1_0-q8f16.onnx", recursive=True)[0]
voice = glob.glob("mobile/models/**/af_heart.bin", recursive=True)[0]
style = np.fromfile(voice, dtype=np.float32).reshape(510, 256)
p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
levels = {"ALL": ort.GraphOptimizationLevel.ORT_ENABLE_ALL, "EXTENDED": ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
          "BASIC": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC, "DISABLE": ort.GraphOptimizationLevel.ORT_DISABLE_ALL}
for name, lvl in levels.items():
    so = ort.SessionOptions(); so.graph_optimization_level = lvl
    try:
        s = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    except Exception as e:
        print(name, "LOAD THREW", str(e)[:1500]); continue
    for ln in p["lines"]:
        ids = ln["ids"]; row = min(max(len(ids) - 2, 0), 509); t = time.time()
        try:
            out = s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": style[row:row+1], "speed": np.array([1.0], dtype=np.float32)})
            sec = out[0].shape[-1] / 24000
            print(name, len(ids), "ok", round(sec, 1), "s audio in", round(time.time() - t, 2), "s; finite", bool(np.isfinite(out[0]).all()))
        except Exception as e:
            print(name, len(ids), "THREW", str(e)[:1500])
