# Throwaway (lens 2): how much of the fp32 onnx-community graph does ORT's CoreML EP take?
#   python ort_coreml_ep.py <model.onnx> <units ALL|CPUAndNeuralEngine|CPUOnly> <static 0|1> [pad_to]
# Partition counts come from ORT's own verbose log (stderr, grepped by the workflow).
import json, os, sys, time, glob, resource, numpy as np, onnxruntime as ort

path, units, static = sys.argv[1], sys.argv[2], sys.argv[3]
pad_to = int(sys.argv[4]) if len(sys.argv) > 4 else 0
P = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
CHUNKS = [c for ln in P["lines"] for c in ln["chunks"]]
VOICE = np.fromfile(glob.glob("mobile/models/**/af_heart.bin", recursive=True)[0], dtype=np.float32).reshape(510, 256)
so = ort.SessionOptions(); so.intra_op_num_threads = 4; so.log_severity_level = 0
opts = {"ModelFormat": "MLProgram", "MLComputeUnits": units, "RequireStaticInputShapes": static}
print("ort", ort.__version__, "model", path, "opts", opts, "pad_to", pad_to, flush=True)
t = time.perf_counter()
try:
    s = ort.InferenceSession(path, so, providers=[("CoreMLExecutionProvider", opts), "CPUExecutionProvider"])
except Exception as e:
    print("LOAD THREW", str(e)[:600]); sys.exit(0)
print("load s", round(time.perf_counter() - t, 1), "providers", s.get_providers(), flush=True)
so.log_severity_level = 3
tot_a = tot_t = 0; fin = True
for rep in range(2):  # rep 0 warm-up
    for c in CHUNKS:
        ids = c["ids"]; r = min(max(len(ids) - 2, 0), 509)
        x = ids + [0] * (pad_to - len(ids)) if pad_to else ids
        if pad_to and len(ids) > pad_to: continue
        t = time.perf_counter()
        try:
            w = s.run(None, {"input_ids": np.array([x], dtype=np.int64), "style": VOICE[r:r + 1], "speed": np.array([1.0], dtype=np.float32)})[0]
        except Exception as e:
            print("RUN THREW", str(e)[:400]); sys.exit(0)
        dt = time.perf_counter() - t
        if rep:
            tot_a += w.size / 24000; tot_t += dt; fin &= bool(np.isfinite(w).all())
print(f"RESULT ort-coreml-ep units={units} static={static} pad_to={pad_to} audio={tot_a:.1f}s synth={tot_t:.2f}s RTF={tot_t/max(tot_a,1e-9):.3f} all_finite={fin} maxrss={round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6)}MB")
