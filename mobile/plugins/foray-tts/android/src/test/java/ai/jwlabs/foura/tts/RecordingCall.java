package ai.jwlabs.foura.tts;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.ArrayList;
import java.util.List;

/**
 * A {@link PluginCall} with no bridge behind it: it records what the plugin
 * answered instead of posting it to a WebView. Capacitor's own
 * {@code resolve}/{@code reject} overloads all end in the three methods
 * overridden here. A call registered through {@code addListener} is resolved
 * once per event, which is how {@link #resolved} doubles as the event log.
 */
final class RecordingCall extends PluginCall {
    final List<JSObject> resolved = new ArrayList<>();
    final List<String> rejected = new ArrayList<>();

    RecordingCall(String method, JSObject data) {
        super(null, "ForayTts", "test-" + method, method, data);
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
}
