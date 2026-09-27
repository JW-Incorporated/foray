# Throwaway (lens 3, architecture): Kokoro fp32 CPU, sentence chunks, speed 1.0/1.25/1.5/2.0.
# Reports wall RTF and CPU RTF (process CPU seconds / audio seconds), BOTH on the CONTENT basis:
# denominator = audio seconds of the same chunks rendered at speed 1.0.
import json, sys, time, os, wave, numpy as np, onnxruntime as ort
threads = int(sys.argv[1]); save = len(sys.argv) > 2 and sys.argv[2] == "save"
print("ort", ort.__version__, "threads", threads or "default", "cpus", os.cpu_count())
style = np.fromfile("models/af_heart.bin", dtype=np.float32).reshape(510, 256)
p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
chunks = [c for ln in p["lines"] for c in ln["chunks"]]
chars = sum(ln["chars"] for ln in p["lines"])
so = ort.SessionOptions()
if threads: so.intra_op_num_threads = threads
s = ort.InferenceSession("models/model.onnx", so, providers=["CPUExecutionProvider"])
def run(ids, sp):
    row = min(max(len(ids) - 2, 0), 509)
    return s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": style[row:row+1], "speed": np.array([sp], dtype=np.float32)})[0].reshape(-1)
run(chunks[0]["ids"], 1.0)  # warm-up (cold first inference excluded)
content = None; res = {}
for sp in [1.0, 1.25, 1.5, 2.0]:
    per = []; wav = []
    for c in chunks:
        w0 = time.perf_counter(); c0 = time.process_time()
        w = run(c["ids"], sp)
        per.append((time.perf_counter() - w0, time.process_time() - c0, len(w) / 24000, bool(np.isfinite(w).all())))
        wav.append(w); wav.append(np.zeros(int(0.08 * 24000), np.float32))
    if content is None: content = [x[2] for x in per]
    wall = sum(x[0] for x in per); cpu = sum(x[1] for x in per); aud = sum(x[2] for x in per); C = sum(content)
    res[sp] = dict(wall=wall, cpu=cpu, audio=aud, content=C)
    print(f"speed {sp}: audio {aud:.1f}s (content {C:.1f}s, ratio {aud/C:.3f}); wall {wall:.1f}s; CPU {cpu:.1f}s; "
          f"RTF_content_wall {wall/C:.3f}; RTF_content_cpu {cpu/C:.3f}; RTF_own_audio_wall {wall/aud:.3f}; "
          f"cores_busy {cpu/wall:.2f}; finite {all(x[3] for x in per)}; worst_chunk_wall_rtf {max(x[0]/y for x,y in zip(per,content)):.3f}")
    if save:
        a = np.clip(np.concatenate(wav), -1, 1)
        with wave.open(f"out/kokoro_speed{sp}.wav", "wb") as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(24000); f.writeframes((a * 32767).astype(np.int16).tobytes())
print(f"chars {chars}; content audio {res[1.0]['audio']:.1f}s at speed 1.0 -> {chars/res[1.0]['audio']:.2f} chars per content-second")
b = res[1.0]
for sp, r in res.items():
    print(f"SUMMARY threads={threads} speed={sp} wallRTF_content={r['wall']/r['content']:.3f} cpuRTF_content={r['cpu']/r['content']:.3f} vs1.0_wall={r['wall']/b['wall']:.3f}")
import resource; print("maxrss MB", round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6))
