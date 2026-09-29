package ai.jwlabs.foura.vault;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.ArrayList;
import java.util.List;

/**
 * A {@link PluginCall} with no bridge behind it: it records what the plugin
 * answered instead of posting it to a WebView. Capacitor's own
 * {@code resolve}/{@code reject} overloads all end in the three methods
 * overridden here, so every answer the plugin can give lands in
 * {@link #resolved} or {@link #rejected}.
 */
final class RecordingCall extends PluginCall {
    final List<JSObject> resolved = new ArrayList<>();
    final List<String> rejected = new ArrayList<>();

    RecordingCall(String method, JSObject data) {
        super(null, "ForayVault", "test-" + method, method, data);
    }

    static RecordingCall of(String method, String... keyValues) {
        JSObject data = new JSObject();
        for (int i = 0; i + 1 < keyValues.length; i += 2) data.put(keyValues[i], keyValues[i + 1]);
        return new RecordingCall(method, data);
    }

    @Override
    public void resolve(JSObject data) {
        resolved.add(data == null ? new JSObject() : data);
    }

    @Override
    public void resolve() {
        resolved.add(new JSObject());
    }

    @Override
    public void reject(String msg, String code, Exception ex, JSObject data) {
        rejected.add(msg);
    }

    /** The one answer a call got; fails the test on a rejection or on several answers. */
    JSObject answer() {
        if (!rejected.isEmpty()) throw new AssertionError(getMethodName() + " rejected: " + rejected);
        if (resolved.size() != 1) throw new AssertionError(getMethodName() + " resolved " + resolved.size() + " times");
        return resolved.get(0);
    }

    /** The one rejection a call got; fails the test if it resolved instead. */
    String rejection() {
        if (!resolved.isEmpty()) throw new AssertionError(getMethodName() + " resolved: " + resolved);
        if (rejected.size() != 1) throw new AssertionError(getMethodName() + " rejected " + rejected.size() + " times");
        return rejected.get(0);
    }
}
