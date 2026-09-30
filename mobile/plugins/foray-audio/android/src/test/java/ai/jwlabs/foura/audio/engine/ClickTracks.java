package ai.jwlabs.foura.audio.engine;

import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.extractor.MpegAudioUtil;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * NE-25a's click tracks, read IN PLACE from the iOS test fixtures
 * (mobile/plugins/foray-audio/ios/Tests/ForayAudioPluginTests/Fixtures/ClickTracks/, written by
 * tools/audio/make-click-tracks.py and pinned by tools/audio/click-tracks.test.mjs), so both
 * platforms measure the same files. build.gradle hands the directory to the test JVM as
 * {@code foray.clicktracks.dir}.
 *
 * <p>WHERE A HEARD SAMPLE REALLY IS. Media3 labels every sample with a media time; after a
 * seek that label comes from the file's seek map, which can be an estimate. The truth is the
 * sample's position IN THE FILE: an MP3 sample is one whole frame, and frame n of a file
 * starts {@code n x samplesPerFrame / sampleRate} seconds in; a WAV sample is a run of PCM
 * bytes at a byte offset. {@link #locate} finds the heard run in the file by its bytes. The
 * content is a ruler (a click every second, a double click every ten), so a long enough run
 * has one match, and when silence makes several positions match, the one nearest the label is
 * taken and the count is reported.
 */
@OptIn(markerClass = UnstableApi.class)
final class ClickTracks {
    private ClickTracks() {}

    /** One fixture, as click-tracks.json describes it. */
    static final class Fixture {
        final String file;
        final String kind;
        final double durationSec;

        Fixture(String file, String kind, double durationSec) {
            this.file = file;
            this.kind = kind;
            this.durationSec = durationSec;
        }

        boolean isWav() {
            return file.endsWith(".wav");
        }

        File path() {
            return new File(directory(), file);
        }

        Uri uri() {
            return Uri.fromFile(path());
        }

        @Override
        public String toString() {
            return file;
        }
    }

    static File directory() {
        String configured = System.getProperty("foray.clicktracks.dir");
        File dir = configured != null ? new File(configured) : new File("../ios/Tests/ForayAudioPluginTests/Fixtures/ClickTracks");
        if (!new File(dir, "click-tracks.json").isFile()) {
            throw new IllegalStateException("no click tracks at " + dir.getAbsolutePath() + " (foray.clicktracks.dir)");
        }
        return dir;
    }

    static List<Fixture> fixtures() {
        try {
            JSONObject json = new JSONObject(new String(Files.readAllBytes(new File(directory(), "click-tracks.json").toPath()),
                    StandardCharsets.UTF_8));
            JSONArray list = json.getJSONArray("fixtures");
            List<Fixture> out = new ArrayList<>();
            for (int i = 0; i < list.length(); i++) {
                JSONObject f = list.getJSONObject(i);
                out.add(new Fixture(f.getString("file"), f.getString("kind"), f.getDouble("durationSec")));
            }
            return out;
        } catch (IOException | JSONException e) {
            throw new IllegalStateException("click-tracks.json is unreadable", e);
        }
    }

    /** Where the heard run really starts, and how many file positions matched it. */
    static final class Location {
        final double trueSec;
        final int candidates;

        Location(double trueSec, int candidates) {
            this.trueSec = trueSec;
            this.candidates = candidates;
        }
    }

    /**
     * The file position of {@code heard} (consecutive samples, the first one the listener
     * hears first), nearest {@code labelSec} when several match; null when none does.
     */
    @Nullable
    static Location locate(Fixture fixture, List<byte[]> heard, double labelSec) throws IOException {
        byte[] file = Files.readAllBytes(fixture.path().toPath());
        return fixture.isWav() ? locateWav(file, heard, labelSec) : locateMp3(file, heard, labelSec);
    }

    // ---- MP3: one sample is one frame

    @Nullable
    private static Location locateMp3(byte[] file, List<byte[]> heard, double labelSec) {
        int offset = 0;
        // An ID3v2 tag: "ID3", version, flags, a 28-bit syncsafe size (and a footer when flagged).
        if (file.length > 10 && file[0] == 'I' && file[1] == 'D' && file[2] == '3') {
            int size = ((file[6] & 0x7f) << 21) | ((file[7] & 0x7f) << 14) | ((file[8] & 0x7f) << 7) | (file[9] & 0x7f);
            offset = 10 + size + ((file[5] & 0x10) != 0 ? 10 : 0);
        }
        List<byte[]> frames = new ArrayList<>();
        MpegAudioUtil.Header header = new MpegAudioUtil.Header();
        int samplesPerFrame = 0;
        int sampleRate = 0;
        while (offset + 4 <= file.length) {
            int data = ((file[offset] & 0xff) << 24) | ((file[offset + 1] & 0xff) << 16) | ((file[offset + 2] & 0xff) << 8)
                    | (file[offset + 3] & 0xff);
            if (!header.setForHeaderData(data) || header.frameSize <= 0 || offset + header.frameSize > file.length) break;
            byte[] frame = Arrays.copyOfRange(file, offset, offset + header.frameSize);
            // The Xing / Info (or VBRI) frame carries the seek table, not audio; Mp3Extractor skips it.
            boolean seekFrame = frames.isEmpty() && (contains(frame, "Xing") || contains(frame, "Info") || contains(frame, "VBRI"));
            if (!seekFrame) frames.add(frame);
            samplesPerFrame = header.samplesPerFrame;
            sampleRate = header.sampleRate;
            offset += header.frameSize;
        }
        if (frames.isEmpty() || heard.isEmpty() || sampleRate == 0) return null;
        double frameSec = (double) samplesPerFrame / sampleRate;
        int best = -1;
        int candidates = 0;
        for (int n = 0; n + heard.size() <= frames.size(); n++) {
            boolean match = true;
            for (int i = 0; i < heard.size() && match; i++) match = Arrays.equals(frames.get(n + i), heard.get(i));
            if (!match) continue;
            candidates++;
            if (best < 0 || Math.abs(n * frameSec - labelSec) < Math.abs(best * frameSec - labelSec)) best = n;
        }
        return best < 0 ? null : new Location(best * frameSec, candidates);
    }

    private static boolean contains(byte[] haystack, String ascii) {
        byte[] needle = ascii.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer;
            return true;
        }
        return false;
    }

    // ---- WAV: one sample is a run of PCM bytes

    @Nullable
    private static Location locateWav(byte[] file, List<byte[]> heard, double labelSec) {
        int offset = 12; // "RIFF", size, "WAVE"
        int sampleRate = 0;
        int blockAlign = 0;
        int dataStart = -1;
        int dataLength = 0;
        while (offset + 8 <= file.length) {
            String id = new String(file, offset, 4, StandardCharsets.US_ASCII);
            int size = le32(file, offset + 4);
            if (id.equals("fmt ")) {
                sampleRate = le32(file, offset + 12);
                blockAlign = (file[offset + 20] & 0xff) | ((file[offset + 21] & 0xff) << 8);
            } else if (id.equals("data")) {
                dataStart = offset + 8;
                dataLength = Math.min(size, file.length - dataStart);
                break;
            }
            offset += 8 + size + (size & 1);
        }
        if (dataStart < 0 || sampleRate == 0 || blockAlign == 0) return null;
        int total = 0;
        for (byte[] h : heard) total += h.length;
        byte[] run = new byte[total];
        int at = 0;
        for (byte[] h : heard) {
            System.arraycopy(h, 0, run, at, h.length);
            at += h.length;
        }
        // The first byte that is not unsigned 8-bit silence (0x80) anchors the search.
        int anchor = -1;
        for (int i = 0; i < run.length; i++) {
            if ((run[i] & 0xff) != 0x80) {
                anchor = i;
                break;
            }
        }
        if (anchor < 0) return null;
        int best = -1;
        int candidates = 0;
        for (int i = anchor; i < dataLength; i++) {
            if (file[dataStart + i] != run[anchor]) continue;
            int start = i - anchor;
            if (start % blockAlign != 0 || start + run.length > dataLength) continue;
            boolean match = true;
            for (int j = 0; j < run.length && match; j++) match = file[dataStart + start + j] == run[j];
            if (!match) continue;
            candidates++;
            double sec = (double) start / blockAlign / sampleRate;
            if (best < 0 || Math.abs(sec - labelSec) < Math.abs((double) best / blockAlign / sampleRate - labelSec)) best = start;
        }
        return best < 0 ? null : new Location((double) best / blockAlign / sampleRate, candidates);
    }

    private static int le32(byte[] b, int i) {
        return (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | ((b[i + 2] & 0xff) << 16) | ((b[i + 3] & 0xff) << 24);
    }
}
