# THROWAWAY: ORT CPU fp32 model.onnx on the passage's sentence CHUNKS at speed 1.0 vs 1.5, same VM, content-basis RTF.
import json, sys, time, glob, os, numpy as np, onnxruntime as ort
threads = int(sys.argv[1]) if len(sys.argv) > 1 else 0
fastmath = len(sys.argv) > 2 and sys.argv[2] == "1"
print("ort", ort.__version__, "cpus", os.cpu_count(), "threads", threads)
voice = glob.glob("mobile/models/**/af_heart.bin", recursive=True)[0]
style = np.fromfile(voice, dtype=np.float32).reshape(510, 256)
p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
so = ort.SessionOptions()
if threads: so.intra_op_num_threads = threads
if fastmath: so.add_session_config_entry("mlas.enable_gemm_fastmath_arm64_bfloat16", "1")
print("fastmath", fastmath)
s = ort.InferenceSession("models/model.onnx", so, providers=["CPUExecutionProvider"])
chunks = [c for ln in p["lines"] for c in ln["chunks"]]
def run(c, sp):
    ids = c["ids"]; row = min(max(len(ids) - 2, 0), 509)
    t = time.time()
    w = s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": style[row:row+1], "speed": np.array([sp], dtype=np.float32)})[0]
    return w.shape[-1] / 24000, time.time() - t, bool(np.isfinite(w).all())
run(chunks[0], 1.0)  # cold
a1 = s1 = a15 = s15 = 0
for i, c in enumerate(chunks):
    for sp in (1.0, 1.5):
        a, dt, fin = run(c, sp)
        print(f"chunk {i:2d} ids {len(c['ids']):3d} speed {sp} audio {a:5.2f}s synth {dt:.3f}s finite {fin}")
        if sp == 1.0: a1 += a; s1 += dt
        else: a15 += a; s15 += dt
import resource
print(f"SUMMARY ort-fp32 {ort.__version__} fastmath={fastmath} threads={threads} speed1.0 RTF {s1/a1:.3f} (audio {a1:.1f}s synth {s1:.2f}s) | speed1.5 audio {a15:.1f}s synth {s15:.2f}s RTF(own) {s15/a15:.3f} RTF(content) {s15/a1:.3f} | maxrss MB {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6:.0f}")
