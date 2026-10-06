package ai.jwlabs.foura.downloads;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * {@code ForayDownloads} on Android: the seven calls {@code player/download-bridge.js}
 * makes, answered from {@link DownloadStore} (issue #29;
 * docs/roadmap/player-features.md PQ-22). The web half is that file; like
 * {@code foray-vault}, this plugin has no JS entry of its own. Same names and
 * shapes as the iOS plugin (PQ-20):
 * <pre>
 *   enqueue({ id, url, userAgent, allowCellular }) -> the row (status `queued`)
 *   cancel({ id })
 *   remove({ id })                                  -> { removed }
 *   removeAll()
 *   list()                                          -> { items: [row] }
 *   usage()                                         -> { bytes, count }
 *   fileSrc({ id } | { path })                      -> { path, exists }
 * </pre>
 * and three events, {@code downloadProgress {id, bytes, total}},
 * {@code downloadDone {id, path, bytes}} and
 * {@code downloadFailed {id, reason, status}}. A row's {@code path} is the
 * file's absolute path in {@code getNoBackupFilesDir()/foray-downloads/}; the
 * page turns it into a WebView URL with Capacitor's {@code convertFileSrc}.
 *
 * <p>A bad argument or a file-system error REJECTS the call; the web half turns
 * every rejection into {@code { ok: false, reason }}. A rejection carries the
 * exception's message for an argument error (written here, e.g.
 * {@code bad-url}) and only the exception's CLASS otherwise, as
 * {@code ForayVaultPlugin.failure} does.
 */
@CapacitorPlugin(name = "ForayDownloads")
public class ForayDownloadsPlugin extends Plugin {

    private DownloadStore store;

    @Override
    public void load() {
        store = DownloadStore.get(getContext());
        store.setEmitter((name, payload) -> notifyListeners(name, payload));
        store.start();
    }

    static String failure(String method, Exception e) {
        if (e instanceof IllegalArgumentException && e.getMessage() != null) return e.getMessage();
        return "ForayDownloads." + method + " failed: " + e.getClass().getSimpleName();
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        try {
            JSObject row = store.enqueue(call.getString("id"), call.getString("url"),
                    call.getString("userAgent"), call.getBoolean("allowCellular", false));
            call.resolve(row);
        } catch (Exception e) {
            call.reject(failure("enqueue", e));
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        try {
            store.cancel(call.getString("id"));
            call.resolve();
        } catch (Exception e) {
            call.reject(failure("cancel", e));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("removed", store.remove(call.getString("id")));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(failure("remove", e));
        }
    }

    @PluginMethod
    public void removeAll(PluginCall call) {
        try {
            store.removeAll();
            call.resolve();
        } catch (Exception e) {
            call.reject(failure("removeAll", e));
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            JSArray items = new JSArray();
            for (JSObject row : store.list()) items.put(row);
            JSObject ret = new JSObject();
            ret.put("items", items);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(failure("list", e));
        }
    }

    @PluginMethod
    public void usage(PluginCall call) {
        try {
            call.resolve(store.usage());
        } catch (Exception e) {
            call.reject(failure("usage", e));
        }
    }

    @PluginMethod
    public void fileSrc(PluginCall call) {
        try {
            call.resolve(store.fileSrc(call.getString("id"), call.getString("path")));
        } catch (Exception e) {
            call.reject(failure("fileSrc", e));
        }
    }
}
