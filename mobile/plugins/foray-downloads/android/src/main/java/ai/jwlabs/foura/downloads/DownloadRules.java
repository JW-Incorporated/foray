package ai.jwlabs.foura.downloads;

import android.app.DownloadManager;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Every RULE the Android download store follows, kept apart from the store so a
 * plain JUnit test can check each one without a phone, a DownloadManager or a
 * network ({@code DownloadRulesTest}). Issue #29; docs/roadmap/player-features.md
 * PQ-22. The Android twin of the iOS {@code DownloadPolicy.swift}: the names,
 * events and failure reasons are the same strings, and
 * {@code tools/mobile/foray-downloads.test.mjs} pins them against each other and
 * against {@code player/download-bridge.js}.
 *
 * <p>Nothing here touches the disk or opens a connection. The only Android
 * symbols are DownloadManager's {@code ERROR_*} ints, which are compile-time
 * constants and so are inlined into this class.
 *
 * <p>THE REDIRECT CAP IS iOS-ONLY. iOS follows at most eight redirects, counted
 * in its own probe session. On Android the transfer runs inside the system's
 * download provider, which follows redirects itself with a FIXED cap of five
 * ({@code MAX_REDIRECTS = 5} in AOSP's {@code DownloadThread}) and offers no
 * request option to change it or to be asked about each hop. A sixth redirect
 * fails the download with {@code ERROR_TOO_MANY_REDIRECTS}, which this class
 * maps to the same {@code too-many-redirects} reason iOS uses. So Android's
 * cap is five, not eight; a chain of six to eight hops downloads on an iPhone
 * and fails here. Measurement prefixes in front of podcast hosts run two or
 * three deep, so five covers them. Android has no probe at all, and so no
 * request with any method but the transfer's own GET.
 */
final class DownloadRules {
    private DownloadRules() {}

    // ── the wire (player/download-bridge.js) ──────────────────────────────────

    static final String PLUGIN_NAME = "ForayDownloads";
    static final String EVENT_PROGRESS = "downloadProgress";
    static final String EVENT_DONE = "downloadDone";
    static final String EVENT_FAILED = "downloadFailed";

    // ── where files live ──────────────────────────────────────────────────────

    /** The directory name under both {@code getNoBackupFilesDir()} (where the
     *  finished files and the index live) and {@code getExternalFilesDir(null)}
     *  (where DownloadManager writes before the move). Same name as iOS's. */
    static final String DIRECTORY_NAME = "foray-downloads";

    /** The JSON index, beside the audio files in the no-backup directory, so
     *  {@code removeAll} deleting the directory deletes the index with them. */
    static final String INDEX_FILE_NAME = "index.json";

    /** How often the store asks DownloadManager for progress while anything is
     *  in flight (ms). DownloadManager has no progress callback. */
    static final long PROGRESS_POLL_MS = 2000L;

    /** DownloadManager's own redirect cap, recorded here because nothing can
     *  set it (see the class comment). Never passed to the system. */
    static final int DOWNLOAD_MANAGER_MAX_REDIRECTS = 5;

    // ── failure reasons (download-store.js keeps `reason` on failed rows) ────

    static final String REASON_TOO_MANY_REDIRECTS = "too-many-redirects";
    static final String REASON_UNPLAYABLE_HERE = "unplayable-here";
    static final String REASON_BAD_URL = "bad-url";
    static final String REASON_CANCELLED = "cancelled";
    static final String REASON_NOT_SAVED = "not-saved";
    static final String REASON_INTERRUPTED = "interrupted";
    static final String REASON_NO_SPACE = "no-space";

    // ── sources ───────────────────────────────────────────────────────────────

    /**
     * The enclosure URL a call may ask for: an absolute {@code http} or
     * {@code https} URL with a host, trimmed; else null. Anything else
     * ({@code file:}, {@code content:}, a relative string) is refused before a
     * request exists, so the page cannot make the store copy a local file.
     * MUTATION: accept any scheme -> {@code onlyHttpAndHttpsSourcesAreAccepted}.
     */
    static String source(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        try {
            URI uri = new URI(s);
            String scheme = uri.getScheme();
            if (scheme == null) return null;
            String lower = scheme.toLowerCase(java.util.Locale.ROOT);
            if (!lower.equals("http") && !lower.equals("https")) return null;
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return null;
            return s;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * The page's {@code 4a/<build> (+site)} string, used as given when it is one
     * printable ASCII line of at most 256 characters; else null, and
     * DownloadManager sends its own default. Same rule as iOS's
     * {@code userAgentHeader}.
     */
    static String userAgentHeader(String value) {
        if (value == null) return null;
        String ua = value.trim();
        if (ua.isEmpty() || ua.length() > 256) return null;
        for (int i = 0; i < ua.length(); i++) {
            char c = ua.charAt(i);
            if (c < 0x20 || c >= 0x7F) return null;
        }
        return ua;
    }

    // ── files ─────────────────────────────────────────────────────────────────

    /**
     * The stored file's name: SHA-256 of the episode id, lowercase hex, plus
     * {@code .bin} — the same name iOS gives the same episode. A hash, not the
     * id, so an id with {@code /}, {@code ..} or a space can never name a path
     * outside the directory.
     * MUTATION: return {@code id + ".bin"} -> {@code theFileNameIsTheIdsSha256}.
     */
    static String fileName(String id) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(68);
            for (byte b : digest) sb.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
            return sb.append(".bin").toString();
        } catch (NoSuchAlgorithmException e) {
            /* Every Android runtime ships SHA-256; this cannot happen. */
            throw new IllegalStateException(e);
        }
    }

    /** Whether {@code name} is a file this store could have written: 64
     *  lowercase hex digits and {@code .bin}. {@code fileSrc({ path })} answers
     *  only for such names. */
    static boolean isStoreFileName(String name) {
        if (name == null || name.length() != 68 || !name.endsWith(".bin")) return false;
        for (int i = 0; i < 64; i++) {
            char c = name.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    // ── DownloadManager's verdicts ────────────────────────────────────────────

    /**
     * The reason a FAILED row carries, from DownloadManager's
     * {@code COLUMN_REASON}. That column holds the HTTP status when the host
     * answered with an error, else one of the {@code ERROR_*} codes.
     * <ul>
     *   <li>403 is {@code unplayable-here}: the host refuses this client, and a
     *       retry will not change that (download-store.js keys the same status
     *       on 403).</li>
     *   <li>Any other HTTP status is {@code http <status>}, as on iOS.</li>
     *   <li>{@code ERROR_TOO_MANY_REDIRECTS} is {@code too-many-redirects}: the
     *       provider's fixed five-hop cap (class comment).</li>
     *   <li>{@code ERROR_INSUFFICIENT_SPACE} is {@code no-space}; a file error
     *       is {@code not-saved}; anything else {@code download-error <code>}.</li>
     * </ul>
     * MUTATION: map 403 to {@code "http 403"} -> {@code a403IsUnplayableHere}.
     */
    static String failureReason(int reason) {
        if (reason == 403) return REASON_UNPLAYABLE_HERE;
        if (isHttpStatus(reason)) return "http " + reason;
        switch (reason) {
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return REASON_TOO_MANY_REDIRECTS;
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return REASON_NO_SPACE;
            case DownloadManager.ERROR_FILE_ERROR:
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                return REASON_NOT_SAVED;
            default:
                return "download-error " + reason;
        }
    }

    /** The HTTP status for {@code downloadFailed}'s {@code status} field when
     *  {@code COLUMN_REASON} held one, else null. */
    static Integer httpStatus(int reason) {
        return isHttpStatus(reason) ? Integer.valueOf(reason) : null;
    }

    static boolean isHttpStatus(int reason) {
        return reason >= 100 && reason <= 599;
    }

    /** The record status a failure leaves: {@code unplayable-here} for that
     *  reason, else {@code failed} (which the page offers to retry). */
    static String statusForReason(String reason) {
        return REASON_UNPLAYABLE_HERE.equals(reason) ? "unplayable-here" : "failed";
    }
}
