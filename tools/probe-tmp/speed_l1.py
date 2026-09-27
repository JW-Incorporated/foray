# THROWAWAY probe (lens 1: squeeze the ONNX path). Not for merge.
# Every RTF printed here is on the CONTENT basis: synth seconds / audio seconds
# that the SAME ids produce at speed 1.0 (measured in the same process).
import json, sys, time, os, subprocess, glob, statistics as st
import numpy as np
import onnxruntime as ort

MODEL = "mobile/models/kokoro-v1_0-fp32.onnx"
SR = 24000
PAD, SPACE = 0, 16


def log(*a):
    print(*a, flush=True)


def style_mat(voice="af_heart"):
    f = glob.glob(f"mobile/models/**/{voice}.bin", recursive=True)[0]
    return np.fromfile(f, dtype=np.float32).reshape(510, 256)


def passage():
    p = json.load(open("tools/mobile/kokoro-probe-passage.json", encoding="utf8"))
    return [[c["ids"] for c in ln["chunks"]] for ln in p["lines"]]


def units(bucket):
    """The same passage text cut four ways."""
    lines = passage()
    out = []
    for chunks in lines:
        cores = [c[1:-1] for c in chunks]
        if bucket == "sent":
            out += [[PAD] + c + [PAD] for c in cores]
        elif bucket == "line":
            j = []
            for c in cores:
                j += ([SPACE] if j else []) + c
            out.append([PAD] + j[:510] + [PAD])
        elif bucket == "mid":
            cur = []
            for c in cores:
                if cur and len(cur) + 1 + len(c) > 250:
                    out.append([PAD] + cur + [PAD]); cur = []
                cur += ([SPACE] if cur else []) + c
            if cur:
                out.append([PAD] + cur + [PAD])
        elif bucket.startswith("short"):
            lim = int(bucket[5:] or 40)
            for c in cores:
                cur = []
                words, w = [], []
                for t in c:
                    w.append(t)
                    if t == SPACE:
                        words.append(w); w = []
                if w:
                    words.append(w)
                for w in words:
                    if cur and len(cur) + len(w) > lim:
                        out.append([PAD] + cur + [PAD]); cur = []
                    cur += w
                if cur:
                    out.append([PAD] + cur + [PAD])
    return out


def sess_opts(threads=0, opt="all", mem_pattern=True, parallel=False, arena=True, spin=True, profile=None):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.graph_optimization_level = {
        "none": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
        "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
        "ext": ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
        "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
    }[opt]
    so.enable_mem_pattern = mem_pattern
    so.enable_cpu_mem_arena = arena
    if parallel:
        so.execution_mode = ort.ExecutionMode.ORT_PARALLEL
        so.inter_op_num_threads = 2
    if not spin:
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    if profile:
        so.enable_profiling = True
        so.profile_file_prefix = profile
    return so


def make(model=MODEL, providers=("CPUExecutionProvider",), **kw):
    t = time.perf_counter()
    s = ort.InferenceSession(model, sess_opts(**kw), providers=list(providers))
    return s, time.perf_counter() - t


STY = None


def run(s, ids, speed=1.0):
    global STY
    if STY is None:
        STY = style_mat()
    row = min(max(len(ids) - 2, 0), 509)
    t = time.perf_counter()
    w = s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": STY[row:row + 1],
                     "speed": np.array([speed], dtype=np.float32)})[0]
    return time.perf_counter() - t, w


def rss_mb():
    import resource
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1e6 if sys.platform == "darwin" else r / 1e3


def cur_rss_mb():
    try:
        import psutil
        return psutil.Process().memory_info().rss / 1e6
    except Exception:
        return -1


# ---------------------------------------------------------------- modes
def mode_speed():
    s, lt = make()
    us = units("sent")
    run(s, us[0])  # warm
    base = {}  # audio seconds at speed 1.0 per unit
    for i, u in enumerate(us):
        _, w = run(s, u, 1.0); base[i] = w.shape[-1] / SR
    content = sum(base.values())
    log("units", len(us), "content audio s @1.0", round(content, 2))
    speeds = [1.0, 1.25, 1.5, 2.0]
    res = {sp: [] for sp in speeds}
    for rep in range(3):
        for sp in speeds:
            tot = aud = 0.0; nonfin = 0
            for u in us:
                dt, w = run(s, u, sp); tot += dt; aud += w.shape[-1] / SR
                nonfin += int(not np.isfinite(w).all())
            res[sp].append((tot, aud, nonfin))
            log(f"rep{rep} speed {sp}: synth {tot:.2f}s audio {aud:.2f}s (x{content/aud:.3f} shorter) "
                f"RTF_audio {tot/aud:.3f} RTF_CONTENT {tot/content:.3f} nonfinite {nonfin}")
    for sp in speeds:
        med = st.median(r[0] for r in res[sp])
        log(f"SUMMARY speed {sp}: median synth {med:.2f}s  RTF_CONTENT {med/content:.3f}  "
            f"RTF_audio {med/st.median(r[1] for r in res[sp]):.3f}")


def mode_chunk_child(bucket, arena):
    s, lt = make(arena=(arena == "1"))
    after_load = cur_rss_mb()
    us = units(bucket)
    lens = [len(u) for u in us]
    warm = [PAD] + [SPACE] * 3 + [PAD]
    dtw, _ = run(s, us[0])  # first (cold) unit = TTFA-ish
    tot = aud = 0.0; per = []
    for rep in range(2):
        for u in us:
            dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR
            per.append((len(u), dt, w.shape[-1] / SR))
    log(f"CHUNK bucket={bucket} arena={arena} n={len(us)} tokens min/med/max={min(lens)}/{int(st.median(lens))}/{max(lens)} "
        f"load {lt:.2f}s rss_after_load {after_load:.0f}MB first_unit {dtw:.2f}s ({per[0][2]:.2f}s audio) "
        f"RTF_CONTENT {tot/aud:.3f} peak_rss {rss_mb():.0f}MB")
    # per-length RTF buckets
    for lo, hi in [(0, 40), (40, 80), (80, 140), (140, 220), (220, 330), (330, 520)]:
        sel = [p for p in per if lo <= p[0] < hi]
        if sel:
            log(f"   len[{lo},{hi}) n={len(sel)} RTF {sum(p[1] for p in sel)/sum(p[2] for p in sel):.3f}")


def mode_chunks():
    for bucket, arena in [("short24", "1"), ("short40", "1"), ("sent", "1"), ("mid", "1"), ("line", "1"),
                          ("sent", "0"), ("line", "0")]:
        subprocess.run([sys.executable, "-u", __file__, "chunkchild", bucket, arena], check=False)


def mode_threads():
    log("providers available:", ort.get_available_providers())
    us = units("sent")[:9]
    cfgs = [("t1", dict(threads=1)), ("t2", dict(threads=2)), ("t3", dict(threads=3)), ("t4", dict(threads=4)),
            ("t0(default)", dict()), ("opt=basic", dict(opt="basic")), ("opt=ext", dict(opt="ext")),
            ("opt=none", dict(opt="none")), ("mem_pattern=off", dict(mem_pattern=False)),
            ("parallel", dict(parallel=True)), ("arena=off", dict(arena=False)), ("spin=off", dict(spin=False))]
    if "XnnpackExecutionProvider" in ort.get_available_providers():
        cfgs.append(("xnnpack", dict(providers=("XnnpackExecutionProvider", "CPUExecutionProvider"))))
    content = None
    res = {k: [] for k, _ in cfgs}
    for rep in range(2):
        for name, kw in cfgs:
            s, lt = make(**kw)
            run(s, us[0])
            tot = aud = 0.0
            for u in us:
                dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR
            res[name].append(tot / aud)
            log(f"rep{rep} {name}: load {lt:.2f}s RTF_CONTENT {tot/aud:.3f}")
            del s
    for name, _ in cfgs:
        log(f"SUMMARY {name}: RTF_CONTENT median {st.median(res[name]):.3f} runs {[round(x,3) for x in res[name]]}")


def mode_profile():
    us = units("sent")
    for sp in (1.0, 1.5):
        s, _ = make(profile=f"prof_{sp}")
        run(s, us[0], sp)
        for u in us:
            run(s, u, sp)
        f = s.end_profiling()
        ev = json.load(open(f))
        by_op, by_pre, tot = {}, {}, 0
        for e in ev:
            if e.get("cat") != "Node" or not e.get("name", "").endswith("_kernel_time"):
                continue
            d = e["dur"]; tot += d
            op = e.get("args", {}).get("op_name", "?")
            by_op[op] = by_op.get(op, 0) + d
            nm = e["name"][:-len("_kernel_time")]
            parts = [p for p in nm.split("/") if p]
            pre = "/".join(parts[:2]) if len(parts) > 2 else (parts[0] if parts else nm)
            by_pre[pre] = by_pre.get(pre, 0) + d
        log(f"PROFILE speed={sp} total kernel time {tot/1e6:.2f}s")
        for k, v in sorted(by_op.items(), key=lambda x: -x[1])[:22]:
            log(f"  op {k:28s} {v/1e6:7.2f}s {100*v/tot:5.1f}%")
        for k, v in sorted(by_pre.items(), key=lambda x: -x[1])[:22]:
            log(f"  module {k:40s} {v/1e6:7.2f}s {100*v/tot:5.1f}%")


def mode_ortver():
    # parent: alternate versions in venvs (each child prints one RTF)
    vers = sys.argv[2].split(",")
    res = {v: [] for v in vers}
    for rep in range(3):
        for v in vers:
            out = subprocess.run([f"venv{v}/bin/python", "-u", __file__, "verchild"], capture_output=True, text=True)
            line = [l for l in out.stdout.splitlines() if l.startswith("VER")]
            log(f"rep{rep} {v}: {line[0] if line else out.stdout[-400:] + out.stderr[-800:]}")
            if line:
                res[v].append(float(line[0].split("RTF_CONTENT ")[1].split()[0]))
    for v in vers:
        if res[v]:
            log(f"SUMMARY ort {v}: RTF_CONTENT median {st.median(res[v]):.3f} runs {res[v]}")


def mode_verchild():
    us = units("sent")
    s, lt = make()
    run(s, us[0])
    tot = aud = 0.0; nf = 0
    for u in us:
        dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR; nf += int(not np.isfinite(w).all())
    log(f"VER ort {ort.__version__} load {lt:.2f}s RTF_CONTENT {tot/aud:.3f} nonfinite {nf} peak_rss {rss_mb():.0f}MB")


# ---------------------------------------------------------------- fp16
def float_tensors(m, elem):
    import onnx
    inf = onnx.shape_inference.infer_shapes(m)
    typed = {vi.name for vi in inf.graph.value_info if vi.type.tensor_type.elem_type == elem}
    order, prod = [], {}
    for n in m.graph.node:
        for o in n.output:
            if o in typed and o not in prod:
                prod[o] = (n.name, n.op_type); order.append(o)
    return order, prod


def scan(model_path, elem, inputs, batch, stop_at_first_nonfinite=False):
    """Expose intermediate tensors in batches; return {tensor: (maxabs, nonfinite)}."""
    import onnx
    from onnx import helper
    m = onnx.load(model_path)
    order, prod = float_tensors(m, elem)
    log(f"scan {model_path}: {len(m.graph.node)} nodes, {len(order)} typed tensors (elem {elem})")
    keep = list(m.graph.output)
    stats = {}
    for b in range(0, len(order), batch):
        names = order[b:b + batch]
        del m.graph.output[:]
        m.graph.output.extend(keep)
        m.graph.output.extend([helper.make_tensor_value_info(n, elem, None) for n in names])
        so = sess_opts(opt="none")
        try:
            s = ort.InferenceSession(m.SerializeToString(), so, providers=["CPUExecutionProvider"])
        except Exception as e:
            log("scan batch load threw", str(e)[:300]); continue
        outs = [o.name for o in s.get_outputs()]
        for ids in inputs:
            row = min(len(ids) - 2, 509)
            try:
                r = s.run(None, {"input_ids": np.array([ids], dtype=np.int64), "style": style_mat()[row:row + 1],
                                 "speed": np.array([1.0], dtype=np.float32)})
            except Exception as e:
                log("scan run threw", str(e)[:300]); continue
            for n, v in zip(outs, r):
                if n not in prod or v.size == 0:
                    continue
                a = v.astype(np.float32)
                fin = np.isfinite(a)
                mx = float(np.abs(a[fin]).max()) if fin.any() else float("nan")
                old = stats.get(n, (0.0, False))
                stats[n] = (max(old[0], mx) if mx == mx else old[0], old[1] or (not fin.all()))
        del s
        if stop_at_first_nonfinite and any(stats[n][1] for n in names if n in stats):
            break
    return stats, order, prod


def check_model(path, label, reps_chunks=3, reps_lines=2, timing=True):
    s, lt = make(model=path)
    sent, lines = units("sent"), units("line")
    nf_c = nf_l = 0; worst = []
    for rep in range(reps_chunks):
        for i, u in enumerate(sent):
            _, w = run(s, u)
            if not np.isfinite(w).all():
                nf_c += 1; worst.append(f"sent{i}")
    for rep in range(reps_lines):
        for i, u in enumerate(lines):
            _, w = run(s, u)
            if not np.isfinite(w).all():
                nf_l += 1; worst.append(f"line{i}")
    rtf = None
    if timing:
        tot = aud = 0.0
        for u in sent:
            dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR
        rtf = tot / aud
    log(f"CHECK {label}: size {os.path.getsize(path)/1e6:.1f}MB load {lt:.2f}s nonfinite chunks {nf_c}/{reps_chunks*len(sent)} "
        f"lines {nf_l}/{reps_lines*len(lines)} {sorted(set(worst))} RTF_CONTENT {rtf if rtf is None else round(rtf,3)} peak_rss {rss_mb():.0f}MB")
    return nf_c + nf_l, s


def compare(path_a, path_b, label):
    """Deterministic? then report SNR of b vs a on 4 chunks; also save wavs."""
    import wave
    sa, _ = make(model=path_a); sb, _ = make(model=path_b)
    us = units("sent")[:4]
    os.makedirs("wavs", exist_ok=True)
    for i, u in enumerate(us):
        _, a1 = run(sa, u); _, a2 = run(sa, u); _, b = run(sb, u)
        a1, a2, b = a1.ravel(), a2.ravel(), b.ravel()
        n = min(len(a1), len(a2), len(b))
        def snr(x, y):
            e = np.sum((x[:n] - y[:n]) ** 2); return 10 * np.log10(np.sum(x[:n] ** 2) / max(e, 1e-12))
        log(f"COMPARE {label} chunk{i}: len a {len(a1)} b {len(b)}  SNR(fp32 vs fp32 rerun) {snr(a1,a2):.1f}dB  SNR(fp32 vs variant) {snr(a1,b):.1f}dB")
        for tag, x in (("fp32", a1), (label, b)):
            if not np.isfinite(x).all():
                continue
            with wave.open(f"wavs/{label}_{i}_{tag}.wav", "wb") as wf:
                wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
                wf.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def convert(src, dst, op_block=None, node_block=None):
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16, DEFAULT_OP_BLOCK_LIST
    m = onnx.load(src)
    ob = sorted(set(DEFAULT_OP_BLOCK_LIST) | set(op_block or []))
    m16 = convert_float_to_float16(m, keep_io_types=True, op_block_list=ob, node_block_list=list(node_block or []))
    onnx.save(m16, dst)
    log(f"converted {dst}: {os.path.getsize(dst)/1e6:.1f}MB op_block+={sorted(set(op_block or []))} node_block={len(node_block or [])}")


def mode_fp16():
    import onnx
    m = onnx.load(MODEL)
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    log("fp32 op histogram:", sorted(ops.items(), key=lambda x: -x[1]))
    log("random ops present:", [n.name for n in m.graph.node if n.op_type.startswith("Random")][:10])
    del m
    os.makedirs("models16", exist_ok=True)
    # 0) plain conversion (like onnx-community fp16)
    convert(MODEL, "models16/plain.onnx")
    try:
        check_model("models16/plain.onnx", "plain-fp16", timing=True)
    except Exception as e:
        log("plain-fp16 threw", str(e)[:600])
    # 1) fp32 max-abs scan: which intermediates exceed fp16 range?
    lines = units("line"); sent = units("sent")
    inputs = [lines[2], max(sent, key=len)]
    stats, order, prod = scan(MODEL, 1, inputs, batch=int(os.environ.get("SCAN_BATCH", "120")))
    big = [(n, stats[n][0]) for n in order if n in stats and stats[n][0] > 2e4]
    log(f"fp32 tensors with max|x| > 2e4: {len(big)}")
    for n, v in sorted(big, key=lambda x: -x[1])[:60]:
        log(f"   BIG {v:12.1f} {prod[n][1]:22s} {prod[n][0]}")
    near = [(n, stats[n][0]) for n in order if n in stats and 2e3 < stats[n][0] <= 2e4]
    log(f"fp32 tensors with 2e3 < max|x| <= 2e4: {len(near)}; op types: "
        f"{sorted(set(prod[n][1] for n, _ in near))}")
    # 2) fp16 plain: first non-finite tensor in topological order
    first_bad = []
    try:
        s16, o16, p16 = scan("models16/plain.onnx", 10, inputs, batch=120, stop_at_first_nonfinite=True)
        bad = [n for n in o16 if n in s16 and s16[n][1]]
        log(f"fp16 non-finite tensors found: {len(bad)}")
        for n in bad[:15]:
            log(f"   NONFINITE {p16[n][1]:22s} {p16[n][0]}  (fp32 max|x| {stats.get(n,(float('nan'),))[0]})")
        first_bad = [p16[n][0] for n in bad[:5]]
    except Exception as e:
        log("fp16 scan threw", str(e)[:600])
    # 3) mixed-precision variants
    hot = sorted({prod[n][0] for n, _ in big} | set(first_bad))
    log("node_block (hot):", hot[:80])
    broad = ["InstanceNormalization", "LayerNormalization", "ReduceMean", "ReduceSum", "Pow", "Sqrt", "Exp",
             "CumSum", "Sin", "Cos", "Atan", "Softmax", "Reciprocal"]
    variants = [("A_hotnodes", None, hot), ("B_hot+normexp", broad, hot), ("C_opsonly", broad, None)]
    finite = []
    for label, ob, nb in variants:
        dst = f"models16/{label}.onnx"
        try:
            convert(MODEL, dst, ob, nb)
            bad, _ = check_model(dst, label)
            if bad == 0:
                finite.append(dst)
                compare(MODEL, dst, label)
        except Exception as e:
            log(label, "threw", str(e)[:600])
    # 4) CoreML EP (VM: no ANE; this is a finiteness/partitioning look only)
    for dst in finite[:2]:
        try:
            s, lt = make(model=dst, providers=(("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"}), "CPUExecutionProvider"))
            nf = 0; tot = aud = 0.0
            for u in units("sent"):
                dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR; nf += int(not np.isfinite(w).all())
            log(f"COREML {dst}: load {lt:.1f}s nonfinite {nf} RTF_CONTENT {tot/aud:.3f} (VM, no ANE)")
        except Exception as e:
            log("coreml threw", str(e)[:400])


# ---------------------------------------------------------------- round 2
def mode_threads2():
    # what does intra_op_num_threads=0 resolve to? (verbose log names the pool size)
    so = sess_opts(); so.log_severity_level = 0
    import io, contextlib
    ort.set_default_logger_severity(0)
    s = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
    ort.set_default_logger_severity(3)
    del s
    import os as _o
    log("sysctl hw.physicalcpu/logicalcpu/perflevel0:", _o.popen("sysctl -n hw.physicalcpu hw.logicalcpu hw.perflevel0.physicalcpu 2>/dev/null").read().split())
    us = units("sent")[:9]
    cfgs = [("t0", dict()), ("t1", dict(threads=1)), ("t2", dict(threads=2)), ("t3", dict(threads=3)),
            ("t4", dict(threads=4)), ("t6", dict(threads=6)), ("t3 spin=off", dict(threads=3, spin=False)),
            ("t2 spin=off", dict(threads=2, spin=False))]
    res = {k: [] for k, _ in cfgs}
    for rep in range(3):
        for name, kw in cfgs:
            s, lt = make(**kw); run(s, us[0])
            tot = aud = 0.0
            for u in us:
                dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR
            res[name].append(tot / aud); log(f"rep{rep} {name}: RTF_CONTENT {tot/aud:.3f}"); del s
    for name, _ in cfgs:
        log(f"SUMMARY {name}: RTF_CONTENT median {st.median(res[name]):.3f} runs {[round(x,3) for x in res[name]]}")


def mode_combo():
    us = units("sent")
    for th in (3, 2):
        s, _ = make(threads=th); run(s, us[0])
        base = sum(run(s, u, 1.0)[1].shape[-1] for u in us) / SR
        res = {1.0: [], 1.5: []}
        for rep in range(3):
            for sp in (1.0, 1.5):
                tot = sum(run(s, u, sp)[0] for u in us)
                res[sp].append(tot / base)
                log(f"threads={th} rep{rep} speed {sp}: RTF_CONTENT {tot/base:.3f}")
        for sp in res:
            log(f"SUMMARY threads={th} speed {sp}: RTF_CONTENT median {st.median(res[sp]):.3f} runs {[round(x,3) for x in res[sp]]}")
        del s


def mode_profile2():
    import onnx
    m = onnx.load(MODEL, load_external_data=True)
    init = {i.name: tuple(i.dims) for i in m.graph.initializer}
    conv = {}
    for n in m.graph.node:
        if n.op_type in ("Conv", "ConvTranspose"):
            at = {a.name: (list(a.ints) if a.ints else a.i) for a in n.attribute}
            conv[n.name] = (n.op_type, init.get(n.input[1]), at.get("dilations"), at.get("group"), at.get("strides"))
    del m
    us = units("sent")
    s, _ = make(threads=3, profile="prof2")
    run(s, us[0])
    for u in us:
        run(s, u)
    ev = json.load(open(s.end_profiling()))
    by_pre, by_node, tot = {}, {}, 0
    for e in ev:
        if e.get("cat") != "Node" or not e.get("name", "").endswith("_kernel_time"):
            continue
        d = e["dur"]; tot += d
        nm = e["name"][:-len("_kernel_time")]
        parts = [p for p in nm.split("/") if p]
        for depth in (3, 4):
            pre = "/".join(parts[:depth])
            by_pre[(depth, pre)] = by_pre.get((depth, pre), 0) + d
        by_node[nm] = by_node.get(nm, 0) + d
    log(f"PROFILE2 threads=3 total {tot/1e6:.2f}s")
    for depth in (3, 4):
        for (dp, k), v in sorted(by_pre.items(), key=lambda x: -x[1]):
            if dp == depth and v / tot > 0.01:
                log(f"  d{depth} {k:55s} {v/1e6:7.2f}s {100*v/tot:5.1f}%")
    for k, v in sorted(by_node.items(), key=lambda x: -x[1])[:30]:
        log(f"  node {100*v/tot:5.1f}% {k}  {conv.get(k, '')}")
    ctot = sum(v for k, v in by_node.items() if k in conv)
    log(f"  conv nodes total {100*ctot/tot:.1f}% of {len(conv)} conv nodes")


def mode_ortver2():
    vers = sys.argv[2].split(",")
    res = {v: [] for v in vers}; rss = {v: [] for v in vers}
    for rep in range(3):
        for v in vers:
            out = subprocess.run([f"venv{v}/bin/python", "-u", __file__, "verchild2"], capture_output=True, text=True)
            line = [l for l in out.stdout.splitlines() if l.startswith("VER")]
            log(f"rep{rep} {v}: {line[0] if line else out.stdout[-400:] + out.stderr[-800:]}")
            if line:
                res[v].append(float(line[0].split("RTF_CONTENT ")[1].split()[0]))
                rss[v].append(float(line[0].split("peak_rss ")[1].split("MB")[0]))
    for v in vers:
        if res[v]:
            log(f"SUMMARY ort {v} threads=3: RTF_CONTENT median {st.median(res[v]):.3f} runs {res[v]} peak_rss median {st.median(rss[v]):.0f}MB")


def mode_verchild2():
    us = units("sent")
    s, lt = make(threads=3)
    run(s, us[0])
    tot = aud = 0.0; nf = 0
    for u in us:
        dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR; nf += int(not np.isfinite(w).all())
    log(f"VER ort {ort.__version__} load {lt:.2f}s RTF_CONTENT {tot/aud:.3f} nonfinite {nf} peak_rss {rss_mb():.0f}MB")


# ---------------------------------------------------------------- round 3
def _conv_model(path, C, K, dil, T, elem):
    import onnx
    from onnx import helper, TensorProto, numpy_helper
    dt = np.float16 if elem == TensorProto.FLOAT16 else np.float32
    W = numpy_helper.from_array((np.random.randn(C, C, K) * 0.05).astype(dt), "W")
    B = numpy_helper.from_array(np.zeros(C, dt), "B")
    pad = dil * (K - 1) // 2
    n = helper.make_node("Conv", ["x", "W", "B"], ["y"], dilations=[dil], pads=[pad, pad], kernel_shape=[K])
    g = helper.make_graph([n], "c", [helper.make_tensor_value_info("x", elem, [1, C, T])],
                          [helper.make_tensor_value_info("y", elem, [1, C, T])], [W, B])
    onnx.save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]), path)


def mode_convbench():
    from onnx import TensorProto
    try:
        np.show_config()
    except Exception:
        pass
    T = 24000  # 5 s of audio at the generator's 4800 Hz rate
    for C, K, dil in [(128, 11, 1), (128, 11, 5), (256, 11, 1)]:
        flop = 2 * C * C * K * T
        for label, elem in (("fp32", TensorProto.FLOAT), ("fp16", TensorProto.FLOAT16)):
            path = f"conv_{C}_{K}_{dil}_{label}.onnx"
            _conv_model(path, C, K, dil, T, elem)
            for th in (1, 3):
                try:
                    s = ort.InferenceSession(path, sess_opts(threads=th), providers=["CPUExecutionProvider"])
                    x = np.random.randn(1, C, T).astype(np.float16 if label == "fp16" else np.float32)
                    s.run(None, {"x": x})
                    ts = []
                    for _ in range(5):
                        t = time.perf_counter(); s.run(None, {"x": x}); ts.append(time.perf_counter() - t)
                    m = min(ts)
                    log(f"CONV ORT {label} C={C} K={K} d={dil} threads={th}: {m*1e3:.1f} ms  {flop/m/1e9:.0f} GFLOP/s")
                except Exception as e:
                    log(f"CONV ORT {label} C={C} K={K} threads={th} threw {str(e)[:200]}")
        x = np.random.randn(C, T + 2 * dil * (K // 2)).astype(np.float32)
        W = (np.random.randn(K, C, C) * 0.05).astype(np.float32)
        ts = []
        for _ in range(5):
            t = time.perf_counter()
            y = np.zeros((C, T), np.float32)
            for k in range(K):
                y += W[k] @ x[:, k * dil:k * dil + T]
            ts.append(time.perf_counter() - t)
        log(f"CONV numpy(Accelerate) K-shifted-GEMMs fp32 C={C} K={K} d={dil}: {min(ts)*1e3:.1f} ms  {flop/min(ts)/1e9:.0f} GFLOP/s")
        col = np.random.randn(C * K, T).astype(np.float32)
        Wm = W.transpose(1, 0, 2).reshape(C, C * K).copy()
        ts = []
        for _ in range(5):
            t = time.perf_counter(); Wm @ col; ts.append(time.perf_counter() - t)
        log(f"CONV numpy(Accelerate) single GEMM fp32 C={C} K={K}: {min(ts)*1e3:.1f} ms  {flop/min(ts)/1e9:.0f} GFLOP/s")
        try:
            import coremltools as ct
            from coremltools.converters.mil import Builder as mb
            wconst = (np.random.randn(C, C, K) * 0.05).astype(np.float32)
            for prec in ("fp32", "fp16"):
                @mb.program(input_specs=[mb.TensorSpec(shape=(1, C, T))])
                def prog(x):
                    return mb.conv(x=x, weight=wconst, dilations=[dil], pad_type="same")
                for cu_name, cu in (("CPU_ONLY", ct.ComputeUnit.CPU_ONLY), ("CPU_AND_GPU", ct.ComputeUnit.CPU_AND_GPU), ("ALL", ct.ComputeUnit.ALL)):
                    try:
                        mlm = ct.convert(prog, convert_to="mlprogram", compute_units=cu,
                                         compute_precision=ct.precision.FLOAT32 if prec == "fp32" else ct.precision.FLOAT16,
                                         minimum_deployment_target=ct.target.macOS13)
                        xin = {"x": np.random.randn(1, C, T).astype(np.float32)}
                        mlm.predict(xin)
                        ts = []
                        for _ in range(5):
                            t = time.perf_counter(); mlm.predict(xin); ts.append(time.perf_counter() - t)
                        log(f"CONV CoreML {prec} {cu_name} C={C} K={K} d={dil}: {min(ts)*1e3:.1f} ms  {flop/min(ts)/1e9:.0f} GFLOP/s")
                    except Exception as e:
                        log(f"CONV CoreML {prec} {cu_name} threw {str(e)[:200]}")
        except Exception as e:
            log("coremltools unavailable", str(e)[:200])


def mode_coremlep():
    us = units("sent")
    cfgs = [("CPU EP t3", ["CPUExecutionProvider"], dict(threads=3))]
    for fmt in ("MLProgram", "NeuralNetwork"):
        for cu in ("CPUOnly", "CPUAndGPU", "ALL"):
            cfgs.append((f"CoreML {fmt} {cu}", [("CoreMLExecutionProvider", {"ModelFormat": fmt, "MLComputeUnits": cu}), "CPUExecutionProvider"], dict(threads=3)))
    for name, prov, kw in cfgs:
        try:
            ort.set_default_logger_severity(2)
            s, lt = make(providers=prov, **kw)
            ort.set_default_logger_severity(3)
            run(s, us[0])
            tot = aud = 0.0; nf = 0
            for u in us:
                dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR; nf += int(not np.isfinite(w).all())
            log(f"COREMLEP {name}: load {lt:.1f}s RTF_CONTENT {tot/aud:.3f} nonfinite {nf} peak_rss {rss_mb():.0f}MB")
            del s
        except Exception as e:
            log(f"COREMLEP {name} threw {str(e)[:300]}")


def mode_mem_child(v):
    so = sess_opts(threads=3)
    if v in ("noprepack", "noprepack+noarena"):
        so.add_session_config_entry("session.disable_prepacking", "1")
    if v in ("noarena", "noprepack+noarena"):
        so.enable_cpu_mem_arena = False
    t = time.perf_counter()
    s = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
    lt = time.perf_counter() - t
    after = cur_rss_mb()
    us = units("sent"); run(s, us[0])
    tot = aud = 0.0
    for u in us:
        dt, w = run(s, u); tot += dt; aud += w.shape[-1] / SR
    log(f"MEM ort {ort.__version__} {v}: load {lt:.2f}s rss_after_load {after:.0f}MB RTF_CONTENT {tot/aud:.3f} peak_rss {rss_mb():.0f}MB")


def mode_mem():
    for py in ("python", "venv1.30.0/bin/python"):
        for v in ("default", "noprepack", "noarena", "noprepack+noarena"):
            out = subprocess.run([py, "-u", __file__, "memchild", v], capture_output=True, text=True)
            log(([l for l in out.stdout.splitlines() if l.startswith("MEM")] or [out.stderr[-400:]])[0])


if __name__ == "__main__":
    log("ort", ort.__version__, "cpus", os.cpu_count(), "mode", sys.argv[1:])
    m = sys.argv[1]
    if m == "memchild":
        mode_mem_child(sys.argv[2])
    elif m == "chunkchild":
        mode_chunk_child(sys.argv[2], sys.argv[3])
    else:
        globals()["mode_" + m]()
