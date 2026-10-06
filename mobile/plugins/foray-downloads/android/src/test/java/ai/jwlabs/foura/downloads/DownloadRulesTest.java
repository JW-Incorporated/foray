package ai.jwlabs.foura.downloads;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.DownloadManager;

import org.junit.Test;

/**
 * PQ-22 (#29): {@link DownloadRules}, run. Plain JUnit — the rules class reads
 * no Android API but DownloadManager's compile-time {@code ERROR_*} ints — so it
 * needs no Robolectric and no device. Each test names the one-line mutation it
 * exists to catch. CI runs these: android-build.yml's native unit-test step
 * names {@code :foray-downloads} (CH-06), and its report loop fails the step
 * if this module ran no test case or skipped one.
 */
public class DownloadRulesTest {

    @Test
    public void onlyHttpAndHttpsSourcesAreAccepted() {
        /* MUTATION: drop the scheme check in source() -> file: is accepted. */
        assertEquals("https://e.example/a.mp3", DownloadRules.source("  https://e.example/a.mp3 "));
        assertEquals("http://e.example/a.mp3", DownloadRules.source("http://e.example/a.mp3"));
        assertNull(DownloadRules.source("file:///data/data/x/no_backup/foray-vault.json"));
        assertNull(DownloadRules.source("content://downloads/1"));
        assertNull(DownloadRules.source("/relative/path.mp3"));
        assertNull(DownloadRules.source("https:///nohost"));
        assertNull(DownloadRules.source(""));
        assertNull(DownloadRules.source(null));
    }

    @Test
    public void theFileNameIsTheIdsSha256() {
        /* MUTATION: return id + ".bin" -> fails. sha256("abc") is the FIPS 180-2
           test vector, so this is the same name iOS's CryptoKit gives. */
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.bin",
                DownloadRules.fileName("abc"));
        assertTrue(DownloadRules.isStoreFileName(DownloadRules.fileName("../../etc/passwd")));
        assertFalse(DownloadRules.isStoreFileName("../index.json"));
        assertFalse(DownloadRules.isStoreFileName(
                "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD.bin"));
    }

    @Test
    public void a403IsUnplayableHere() {
        /* MUTATION: `if (reason == 403) return "http 403"` -> fails. */
        assertEquals("unplayable-here", DownloadRules.failureReason(403));
        assertEquals("unplayable-here", DownloadRules.statusForReason(DownloadRules.failureReason(403)));
        assertEquals(Integer.valueOf(403), DownloadRules.httpStatus(403));
        assertEquals("http 404", DownloadRules.failureReason(404));
        assertEquals("failed", DownloadRules.statusForReason("http 404"));
    }

    @Test
    public void tooManyRedirectsIsTheSameReasonIosUses() {
        /* MUTATION: drop the ERROR_TOO_MANY_REDIRECTS case -> "download-error 1005". */
        assertEquals("too-many-redirects", DownloadRules.failureReason(DownloadManager.ERROR_TOO_MANY_REDIRECTS));
        assertNull(DownloadRules.httpStatus(DownloadManager.ERROR_TOO_MANY_REDIRECTS));
        assertEquals("no-space", DownloadRules.failureReason(DownloadManager.ERROR_INSUFFICIENT_SPACE));
        assertEquals("not-saved", DownloadRules.failureReason(DownloadManager.ERROR_FILE_ERROR));
        assertEquals(5, DownloadRules.DOWNLOAD_MANAGER_MAX_REDIRECTS);
    }

    @Test
    public void theUserAgentIsOnePrintableLine() {
        /* MUTATION: return value unchecked -> a header with a newline is sent. */
        assertEquals("4a/37 (+https://jw-incorporated.github.io/foray/)",
                DownloadRules.userAgentHeader("4a/37 (+https://jw-incorporated.github.io/foray/)"));
        assertNull(DownloadRules.userAgentHeader("4a/37\r\nX-Evil: 1"));
        assertNull(DownloadRules.userAgentHeader("   "));
        assertNull(DownloadRules.userAgentHeader(null));
    }
}
