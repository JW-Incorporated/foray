package ai.jwlabs.foura.notify;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.ArrayList;
import java.util.List;

/**
 * A {@link PluginCall} with no bridge behind it: it records what the plugin
 * answered instead of posting it to a WebView (foray-vault's test helper, same
 * shape). Capacitor's own {@code resolve}/{@code reject} overloads all end in the
 * methods overridden here, and a listener's event IS a {@code resolve} on the
 * kept-alive {@code addListener} call, so every answer and every event lands in
 * {@link #resolved} or {@link #rejected}.
 */
final class RecordingCall extends PluginCall {
    final List<JSObject> resolved = new ArrayList<>();
    final List<String> rejected = new ArrayList<>();

    RecordingCall(String method, JSObject data) {
        super(null, "ForayNotify", "test-" + method, method, data);
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
}
