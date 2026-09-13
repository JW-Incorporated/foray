package ai.jwlabs.foura.tts;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * K-01's runtime on Android: ONNX Runtime, driven directly.
 *
 * <p>The iOS half ({@code KokoroOrtProbeEngine.swift}) carries the full
 * argument for why this exists, why ORT rather than sherpa-onnx or MLX, and
 * why the samples are counted and thrown away. The two differ only where the
 * platforms do, and there are exactly two places:
 *
 * <ol>
 *   <li><b>The model has to leave the APK before it can be opened.</b> Android
 *       assets are DEFLATE-compressed in the package, so there is no file
 *       descriptor to memory-map and no path to hand ORT. The alternative to
 *       extracting is {@code createSession(byte[])}, which means an 82 MB
 *       array on the JVM heap — on a phone whose default heap may be 192 MB,
 *       that is a plausible OOM AND it would corrupt the one reading this card
 *       exists to take, because peak memory is a go/no-go clause. So the asset
 *       is copied once to {@code cacheDir} and opened by path, and the copy
 *       happens in {@link #create} BEFORE any stopwatch starts, so it is not
 *       counted as model-load time. iOS needs none of this: a bundle resource
 *       is already a file.</li>
 *   <li><b>The memory figure means something different.</b> The plugin reports
 *       {@code Debug.getNativeHeapAllocatedSize()} alongside the JVM figure,
 *       because ORT's arena is native. That is the plugin's business, not
 *       this class's, and is commented there.</li>
 * </ol>
 *
 * <p>NOT A NARRATION PATH. No {@code speak}, no {@code AudioTrack}, no
 * foreground service. It answers {@link ForayTtsPlugin.KokoroProbeEngine} —
 * ids in, timings out — and nothing in {@code queue-manager.js} can reach it.
 */
final class KokoroOrtProbeEngine implements ForayTtsPlugin.KokoroProbeEngine {

    private static final String TAG = "ForayTts/kokoro";

    /** Kokoro v1.0 emits 24 kHz. A property of the model card, not of the
     *  graph — a wrong value here would scale every RTF by the ratio without
     *  changing anything a reader could see. */
    private static final double SAMPLE_RATE = 24_000d;

    /** The style matrix: 510 token-lengths x 256 floats. 510 * 256 * 4 =
     *  522,240 bytes, which is exactly what {@code fetch-models.mjs} pins. */
    private static final int STYLE_ROWS = 510;
    private static final int STYLE_DIM = 256;

    static final String VOICE_ASSET = "af_heart.bin";

    private final String modelPath;
    private final float[] style;
    private OrtEnvironment env;
    private OrtSession session;
    private String provider = "cpu";

    private KokoroOrtProbeEngine(String modelPath, float[] style) {
        this.modelPath = modelPath;
        this.style = style;
    }

    /**
     * Build one, or {@code null} when anything needed is absent or malformed.
     *
     * <p>A FAILED CONSTRUCTION IS NOT A CRASH and not a zero: the plugin
     * reports {@code engine-absent}, one of the four closed reason codes a
     * founder reads off the screen and {@code player/kokoro-probe.js} knows
     * by name.
     */
    static KokoroOrtProbeEngine create(Context ctx) {
        if (ctx == null) return null;
        try {
            byte[] raw = readAsset(ctx, VOICE_ASSET);
            int expected = STYLE_ROWS * STYLE_DIM * 4;
            if (raw == null || raw.length != expected) {
                /* A voice file of the wrong length is a build that fetched
                   something else. Refusing beats synthesizing with 256 floats
                   read out of the middle of an unrelated file, which would
                   produce sound and therefore a number. */
                Log.e(TAG, "voice asset is " + (raw == null ? "absent" : raw.length + " bytes")
                        + ", expected " + expected);
                return null;
            }
            FloatBuffer fb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
            float[] style = new float[fb.remaining()];
            fb.get(style);

            File extracted = extractModel(ctx);
            if (extracted == null) return null;
            return new KokoroOrtProbeEngine(extracted.getAbsolutePath(), style);
        } catch (Throwable t) {
            Log.e(TAG, "could not prepare the Kokoro probe engine", t);
            return null;
        }
    }

    /** The asset, on disk, reused across runs. Re-extracted when the size does
     *  not match, which is the cheap half of "is this the same file" and the
     *  only half available without hashing 82 MB on a phone. */
    private static File extractModel(Context ctx) {
        try {
            File out = new File(ctx.getCacheDir(), ForayTtsPlugin.MODEL_ASSET);
            long assetSize = -1;
            try (InputStream probe = ctx.getAssets().open(ForayTtsPlugin.MODEL_ASSET)) {
                assetSize = probe.available();
            } catch (Throwable ignored) { /* available() is a hint; fall through */ }
            if (out.exists() && assetSize > 0 && out.length() == assetSize) return out;
            try (InputStream in = ctx.getAssets().open(ForayTtsPlugin.MODEL_ASSET);
                 OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            return out;
        } catch (Throwable t) {
            Log.e(TAG, "could not extract the Kokoro model from assets", t);
            return null;
        }
    }

    private static byte[] readAsset(Context ctx, String name) {
        try (InputStream in = ctx.getAssets().open(name)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public String modelName() {
        return "kokoro-82m-v1.0-q8f16";
    }

    @Override
    public String provider() {
        return provider;
    }

    /**
     * Load the model twice: the cold figure a listener pays on first use, and
     * the warm one that decides whether deck §5 item 6's "load at app start
     * and keep the session warm" mitigation is worth anything.
     */
    @Override
    public double[] load() {
        long t0 = System.nanoTime();
        session = makeSession();
        long t1 = System.nanoTime();
        OrtSession second = makeSession();
        long t2 = System.nanoTime();
        if (second != null) {
            try { second.close(); } catch (Throwable ignored) { }
        }
        return new double[]{ (t1 - t0) / 1e6, (t2 - t1) / 1e6 };
    }

    private OrtSession makeSession() {
        try {
            if (env == null) env = OrtEnvironment.getEnvironment();
            OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
            opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            provider = "cpu";
            return env.createSession(modelPath, opts);
        } catch (Throwable t) {
            Log.e(TAG, "could not open the Kokoro session", t);
            return null;
        }
    }

    /**
     * One line. Returns {@code [0, 0]} on any failure, which
     * {@code kokoro-probe.js} turns into an unmeasured RTF — and
     * {@code probeVerdict} FAILS an unmeasured RTF rather than passing it.
     */
    @Override
    public double[] synthesize(int[] ids, double speed) {
        if (session == null || ids == null || ids.length <= 2) return new double[]{0, 0};
        long t0 = System.nanoTime();
        int samples = run(ids, speed);
        long t1 = System.nanoTime();
        return new double[]{ (t1 - t0) / 1e6, samples / SAMPLE_RATE };
    }

    private int run(int[] ids, double speed) {
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            long[] tokens = new long[ids.length];
            for (int i = 0; i < ids.length; i++) tokens[i] = ids[i];
            inputs.put("input_ids", OnnxTensor.createTensor(
                    env, LongBuffer.wrap(tokens), new long[]{1, tokens.length}));

            /* THE STYLE ROW IS CHOSEN BY THE UNPADDED LENGTH. `ids` arrives
               with a pad at each end (tools/narration/kokoro-vocab.json
               documents the encoding), so the row is `length - 2`, clamped
               because a line longer than the matrix has no row of its own and
               the last row is the least wrong answer. K-04 chunks instead. */
            int row = Math.min(Math.max(ids.length - 2, 0), STYLE_ROWS - 1);
            float[] styleRow = new float[STYLE_DIM];
            System.arraycopy(style, row * STYLE_DIM, styleRow, 0, STYLE_DIM);
            inputs.put("style", OnnxTensor.createTensor(
                    env, FloatBuffer.wrap(styleRow), new long[]{1, STYLE_DIM}));

            inputs.put("speed", OnnxTensor.createTensor(
                    env, FloatBuffer.wrap(new float[]{(float) speed}), new long[]{1}));

            try (OrtSession.Result result = session.run(inputs)) {
                Object value = result.get(0).getValue();
                /* The samples are COUNTED AND DROPPED. K-01 measures speed,
                   memory and whether the passage survives a locked screen;
                   what it sounds like is K-03's audition, rendered on a
                   workstation from the same graph and the same weights.
                   Playing it here would mean an AudioTrack, which is how this
                   file would become the narration path by accident. */
                return countSamples(value);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Kokoro inference failed", t);
            return 0;
        } finally {
            for (OnnxTensor t : inputs.values()) {
                try { t.close(); } catch (Throwable ignored) { }
            }
        }
    }

    /** The output is float[n] or float[1][n] depending on the export's leading
     *  dimension. Both are handled rather than one assumed: a re-export that
     *  added or dropped the batch axis would otherwise silently return 0
     *  samples, which reads as "infinitely fast" in an RTF. */
    private static int countSamples(Object value) {
        if (value instanceof float[]) return ((float[]) value).length;
        if (value instanceof float[][]) {
            float[][] rows = (float[][]) value;
            int n = 0;
            for (float[] r : rows) n += r.length;
            return n;
        }
        Log.e(TAG, "unexpected output type " + (value == null ? "null" : value.getClass()));
        return 0;
    }
}
