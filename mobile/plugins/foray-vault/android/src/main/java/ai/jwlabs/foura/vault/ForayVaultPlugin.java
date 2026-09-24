package ai.jwlabs.foura.vault;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;

/**
 * {@code ForayVault} on Android: the four calls {@code player/durable-store.js}'s
 * {@code vaultTier()} makes, answered from {@link DeviceOnlyVault} (round-2 audit
 * persist-6; founder ruling 2026-09-24, "Option A": the auth token stays on the
 * device and out of backups).
 *
 * <p>The method names and shapes copy {@code @capacitor/preferences}, so the web
 * half reads both native tiers with one adapter:
 * <pre>
 *   keys()              -> { keys: [String] }
 *   get({ key })        -> { value: String | null }
 *   set({ key, value })
 *   remove({ key })
 * </pre>
 * A storage error REJECTS the call; the store counts that as a fault of this
 * tier and never as "there is no account".
 */
@CapacitorPlugin(name = "ForayVault")
public class ForayVaultPlugin extends Plugin {
    /** In {@code getNoBackupFilesDir()} — the directory backups always skip. */
    static final String FILE_NAME = "foray-vault.json";

    private DeviceOnlyVault vault;

    @Override
    public void load() {
        vault = new DeviceOnlyVault(new File(getContext().getNoBackupFilesDir(), FILE_NAME));
    }

    /**
     * The rejection text for a storage error: the call and the exception's
     * CLASS, never its message, and the exception itself is not handed to
     * {@code reject} (which would log it). {@code org.json}'s parse error ends
     * with the whole input it failed on, which here is the token file, and the
     * web half keeps this text in {@code cp_storage_health} (a backed-up tier)
     * and logs it. Review, 2026-09-24.
     */
    static String failure(String method, Exception e) {
        return "ForayVault." + method + " failed: " + e.getClass().getSimpleName();
    }

    @PluginMethod
    public void keys(PluginCall call) {
        try {
            JSArray keys = new JSArray();
            for (String key : vault.keys()) keys.put(key);
            JSObject ret = new JSObject();
            ret.put("keys", keys);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(failure("keys", e));
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("ForayVault.get needs a key");
            return;
        }
        try {
            String value = vault.get(key);
            JSObject ret = new JSObject();
            ret.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(failure("get", e));
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("ForayVault.set needs a key and a string value");
            return;
        }
        try {
            vault.set(key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject(failure("set", e));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("ForayVault.remove needs a key");
            return;
        }
        try {
            vault.remove(key);
            call.resolve();
        } catch (Exception e) {
            call.reject(failure("remove", e));
        }
    }
}
