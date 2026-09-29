package ai.jwlabs.foura.vault;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * A-13 (docs/plans/android-assessment.md §5.3): the token store, run.
 *
 * <p>Before this, nothing executed a line of {@link ForayVaultPlugin} or
 * {@link DeviceOnlyVault}: CI compiled them into the APK and no test called
 * them. These drive the plugin through its four bridge methods, with the real
 * {@code AtomicFile} and {@code org.json} underneath (Robolectric runs the
 * framework's own code), against the app's real data directories.
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ForayVaultPluginTest {

    /** The plugin with its one bridge dependency, the Context, supplied directly. */
    static final class TestPlugin extends ForayVaultPlugin {
        private final Context context;

        TestPlugin(Context context) {
            this.context = context;
        }

        @Override
        public Context getContext() {
            return context;
        }
    }

    private Context app;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        storeFile().delete();
        new File(app.getFilesDir(), ForayVaultPlugin.FILE_NAME).delete();
    }

    private File storeFile() {
        return new File(app.getNoBackupFilesDir(), ForayVaultPlugin.FILE_NAME);
    }

    private ForayVaultPlugin loaded() {
        ForayVaultPlugin plugin = new TestPlugin(app);
        plugin.load();
        return plugin;
    }

    private static JSObject answer(ForayVaultPlugin plugin, String method, String... keyValues) {
        RecordingCall call = RecordingCall.of(method, keyValues);
        invoke(plugin, method, call);
        return call.answer();
    }

    private static String rejection(ForayVaultPlugin plugin, String method, String... keyValues) {
        RecordingCall call = RecordingCall.of(method, keyValues);
        invoke(plugin, method, call);
        return call.rejection();
    }

    private static void invoke(ForayVaultPlugin plugin, String method, RecordingCall call) {
        switch (method) {
            case "keys": plugin.keys(call); break;
            case "get": plugin.get(call); break;
            case "set": plugin.set(call); break;
            case "remove": plugin.remove(call); break;
            default: throw new IllegalArgumentException(method);
        }
    }

    private static List<String> keysOf(JSObject answer) throws Exception {
        JSONArray keys = answer.getJSONArray("keys");
        List<String> out = new ArrayList<>();
        for (int i = 0; i < keys.length(); i++) out.add(keys.getString(i));
        return out;
    }

    private String onDisk() throws IOException {
        return new String(Files.readAllBytes(storeFile().toPath()), StandardCharsets.UTF_8);
    }

    private void writeRaw(String text) throws IOException {
        File file = storeFile();
        file.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** MUTATION: {@code rows.put(key, value)} → {@code rows.put(key, "")} in
     *  {@code DeviceOnlyVault.set}, or delete {@code Collections.sort(out)} in
     *  {@code keys}: this goes red. */
    @Test
    public void roundTrip_setGetKeysRemove_andItSurvivesANewPluginInstance() throws Exception {
        ForayVaultPlugin plugin = loaded();
        // Written out of order on purpose: `keys` promises a sorted list and
        // org.json keeps insertion order, so only the sort makes this pass.
        answer(plugin, "set", "key", "user", "value", "u-7");
        answer(plugin, "set", "key", "token", "value", "tok-123");

        assertEquals("tok-123", answer(plugin, "get", "key", "token").getString("value"));
        assertEquals("u-7", answer(plugin, "get", "key", "user").getString("value"));
        assertEquals(Arrays.asList("token", "user"), keysOf(answer(plugin, "keys")));

        // A cold start: a fresh plugin reads what the last one wrote.
        ForayVaultPlugin next = loaded();
        assertEquals("tok-123", answer(next, "get", "key", "token").getString("value"));

        answer(next, "remove", "key", "token");
        assertSame("a removed row answers null, not a string", JSONObject.NULL,
            answer(next, "get", "key", "token").opt("value"));
        assertEquals(Arrays.asList("user"), keysOf(answer(next, "keys")));
    }

    /** MUTATION: {@code e.getClass().getSimpleName()} → {@code e.getMessage()} in
     *  {@code ForayVaultPlugin.failure}: org.json's parse error quotes the whole
     *  input, which is the token file, and this goes red. */
    @Test
    public void corruptFile_readsRejectWithoutQuotingTheFile() throws Exception {
        writeRaw("{\"token\": \"SECRET-tok-9");
        ForayVaultPlugin plugin = loaded();

        String get = rejection(plugin, "get", "key", "token");
        String keys = rejection(plugin, "keys");
        assertEquals("ForayVault.get failed: JSONException", get);
        assertEquals("ForayVault.keys failed: JSONException", keys);
        assertFalse(get.contains("SECRET"));
        assertFalse(keys.contains("SECRET"));
    }

    /** MUTATION: {@code return unreadableStore(e);} → {@code throw new IOException(e);}
     *  in {@code DeviceOnlyVault.readForWrite}: the account could never be saved
     *  again (audit round 3, mobile-native-7), and this goes red. */
    @Test
    public void corruptFile_recoversOnTheNextWrite() throws Exception {
        writeRaw("{\"token\": \"SECRET-tok-9");
        ForayVaultPlugin plugin = loaded();

        answer(plugin, "set", "key", "token", "value", "fresh");
        assertEquals("fresh", answer(plugin, "get", "key", "token").getString("value"));
        assertEquals(Arrays.asList("token"), keysOf(answer(plugin, "keys")));
        assertFalse("the corrupt bytes are gone from disk", onDisk().contains("SECRET"));
    }

    /** MUTATION: {@code if (rows.remove(key) != null || unreadable)} →
     *  {@code if (rows.remove(key) != null)} in {@code DeviceOnlyVault.remove}:
     *  "Delete my data" would leave the unreadable file in place, and this goes red. */
    @Test
    public void corruptFile_removeReplacesItWithAnEmptyStore() throws Exception {
        writeRaw("not json at all");
        ForayVaultPlugin plugin = loaded();

        answer(plugin, "remove", "key", "token");
        assertSame(JSONObject.NULL, answer(plugin, "get", "key", "token").opt("value"));
        assertEquals(0, keysOf(answer(plugin, "keys")).size());
    }

    /** MUTATION: {@code getNoBackupFilesDir()} → {@code getFilesDir()} in
     *  {@code ForayVaultPlugin.load}: the token lands in a directory Google
     *  backups copy (founder ruling 2026-09-24, "Option A"), and this goes red. */
    @Test
    public void theFileIsWrittenToTheNoBackupDirectory() throws Exception {
        File noBackup = app.getNoBackupFilesDir();
        File files = app.getFilesDir();
        assertNotEquals("the test can only tell the two apart if they differ", noBackup, files);

        ForayVaultPlugin plugin = loaded();
        answer(plugin, "set", "key", "token", "value", "tok-nb");

        assertTrue("the store is in getNoBackupFilesDir()", storeFile().isFile());
        assertTrue(onDisk().contains("tok-nb"));
        assertFalse("and not in getFilesDir()", new File(files, ForayVaultPlugin.FILE_NAME).exists());
    }
}
