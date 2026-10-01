package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.EngineSeams;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.RouteResume;
import android.media.AudioDeviceInfo;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.DoubleSupplier;

/**
 * ROUTE RESUME'S EARS ON ANDROID (card A-61, docs/plans/android-assessment.md §5.7): what the
 * native engine's route policy ({@code RouteResume} in the JVM core, the twin of NE-38rs) needs
 * to hear from the device, turned into the {@code routeChange} events iOS's
 * {@code AVAudioSession} gives the Swift core.
 *
 * <h2>WHICH DEVICE IS "THE ROUTE"</h2>
 * An {@code AudioDeviceCallback} on {@code AudioManager} reports devices added and removed. A
 * non-system app cannot ask Android which device its media plays through (below API 33), so the
 * route is {@link SessionMonitor.RouteTracker}'s heuristic, the same one the {@code session}
 * rows already use: the media output attached LAST that is not the built-in speaker, else the
 * speaker. A device added that becomes the route is a route coming BACK (iOS's
 * {@code newDeviceAvailable}); the route's device removed is a route LOST
 * ({@code oldDeviceUnavailable}). A device that is not the route coming or going is nothing.
 *
 * <h2>THE PAUSE STAYS BECOMING_NOISY</h2>
 * A-08's {@code ACTION_AUDIO_BECOMING_NOISY} (Media3's receiver while a deck plays, the service's
 * own while a spoken line or the jingle does, {@code FocusMapping}) is still what pauses. It
 * carries no device, so {@link #onNoisy} names the route that is going (Android sends the
 * broadcast before it removes the device, and delays the removal so apps can pause first) and
 * the removal that follows adds nothing. A removal with no broadcast before it (the platform
 * sends none when the audio was not going to move) is the loss itself. Either way the core hears
 * ONE loss per route.
 *
 * <h2>THE CLASS (the card's mapping)</h2>
 * <ul>
 *   <li>{@code car}: any device while the phone is in car UI mode ({@code UiModeManager}); Android
 *       Auto puts the phone in car mode while it projects. A car whose Bluetooth connects before
 *       its projection starts is first a {@code bluetooth} route; entering car mode then reports
 *       the route again ({@link #onCarMode}), and the reducer, which a {@code no} never clears,
 *       resumes on that second word.</li>
 *   <li>{@code bluetooth}: {@code TYPE_BLUETOOTH_A2DP}, {@code TYPE_BLUETOOTH_SCO} and the
 *       {@code TYPE_BLE_*} types. Telling a car's Bluetooth from headphones would need the device
 *       class, which needs {@code BLUETOOTH_CONNECT} on API 31+; it is NOT requested (D-A9: no),
 *       and the Bluetooth arm stays off, as on iOS.</li>
 *   <li>{@code other}: everything else (wired, USB, HDMI, the speaker).</li>
 * </ul>
 *
 * <h2>THE KEY</h2>
 * The device's type (as its {@code SESSION_PORTS} token) and its ADDRESS, which the core hashes
 * with the install's salt before it keeps or writes anything: no row ever carries an address or a
 * name. A device with no address (the speaker, most wired headsets) has no key, so it is never
 * known and never resumes. (Android 14 anonymises a Bluetooth address to its last two bytes for an
 * app without {@code BLUETOOTH_CONNECT}; that is still one car's, and still never a row.)
 *
 * <p>Main-confined: the callbacks, the receivers and the host all run on the main looper. Pure but
 * for {@link Device#of}, so {@code RouteWatcherTest} runs it on the JVM with Robolectric devices.
 */
public final class RouteWatcher implements EngineSeams.RouteReading {
    /**
     * A removal already reported the loss this long before a BECOMING_NOISY arrives: the broadcast
     * is the same loss, late, and is dropped.
     */
    public static final double NOISY_AFTER_REMOVAL_MS = 2_000;

    /** A device as the watcher keeps it: its type, the platform's id for this connection, and its address. */
    public record Device(int type, int id, @NonNull String address) {
        public Device {
            if (address == null) address = "";
        }

        public static Device of(@NonNull AudioDeviceInfo d) {
            String address;
            try {
                address = d.getAddress();
            } catch (RuntimeException e) {
                address = "";
            }
            return new Device(d.getType(), d.getId(), address == null ? "" : address);
        }

        String slot() {
            return type + ":" + id + ":" + address;
        }

        String port() {
            return SessionMonitor.RouteTracker.portToken(type);
        }

        boolean isSpeaker() {
            return SessionMonitor.PORT_SPEAKER.equals(port());
        }
    }

    private final BooleanSupplier inCar;
    private final DoubleSupplier monoMs;
    /** The media outputs attached, in attachment order. */
    private final LinkedHashMap<String, Device> outputs = new LinkedHashMap<>();
    /** The route whose loss a BECOMING_NOISY already reported, until its removal. */
    @Nullable private String lossReported;
    /** When a removal last reported a loss (monotonic ms), or NaN. */
    private double removalLossAtMs = Double.NaN;

    public RouteWatcher(@NonNull BooleanSupplier inCar, @NonNull DoubleSupplier monoMs) {
        this.inCar = inCar;
        this.monoMs = monoMs;
    }

    /** The devices already attached when the callback is registered: known, and never events. */
    public void seed(@NonNull Iterable<Device> devices) {
        for (Device d : devices) track(d);
    }

    /** Devices came: the route coming back, when one of them became it. */
    @NonNull
    public List<EngineInput.RouteChange> onAdded(@NonNull Iterable<Device> devices) {
        Device before = current();
        for (Device d : devices) {
            // Back again: a later removal of it is a new loss.
            if (d.slot().equals(lossReported)) lossReported = null;
            track(d);
        }
        Device after = current();
        if (after == null || after.isSpeaker()) return Collections.emptyList();
        if (before != null && before.slot().equals(after.slot())) return Collections.emptyList();
        return one(change(false, after));
    }

    /** Devices went: the route lost, when the route's device went and no BECOMING_NOISY said so already. */
    @NonNull
    public List<EngineInput.RouteChange> onRemoved(@NonNull Iterable<Device> devices) {
        Device before = current();
        boolean routeGone = false;
        for (Device d : devices) {
            if (outputs.remove(d.slot()) != null && before != null && before.slot().equals(d.slot())) routeGone = true;
        }
        if (!routeGone || before.isSpeaker()) return Collections.emptyList();
        if (before.slot().equals(lossReported)) {
            // The broadcast named it already: the removal is the same loss.
            lossReported = null;
            return Collections.emptyList();
        }
        removalLossAtMs = monoMs.getAsDouble();
        return one(change(true, before));
    }

    /**
     * {@code ACTION_AUDIO_BECOMING_NOISY}: the loss of the route that is going, or null when a
     * removal reported it a moment ago. With no route tracked it is a loss that names no port
     * (A-26's shape), which pauses and can never be matched.
     */
    @Nullable
    public EngineInput.RouteChange onNoisy() {
        double now = monoMs.getAsDouble();
        if (!Double.isNaN(removalLossAtMs) && now - removalLossAtMs >= 0 && now - removalLossAtMs <= NOISY_AFTER_REMOVAL_MS) {
            return null;
        }
        Device route = current();
        if (route == null || route.isSpeaker()) return new EngineInput.RouteChange(true);
        lossReported = route.slot();
        return change(true, route);
    }

    /**
     * Car UI mode changed. Entering it reports the current route again, now classed {@code car}
     * (a car's Bluetooth connected before its projection started).
     */
    @NonNull
    public List<EngineInput.RouteChange> onCarMode(boolean entered) {
        if (!entered) return Collections.emptyList();
        Device route = current();
        if (route == null || route.isSpeaker()) return Collections.emptyList();
        return one(change(false, route));
    }

    /** The route our audio goes to now ({@code EngineNow.route}), or null with no output tracked. */
    @Nullable
    @Override
    public EngineInput.RoutePort currentRoute() {
        Device route = current();
        return route == null ? null : new EngineInput.RoutePort(route.port(), route.address());
    }

    /** The {@code route} facts the service's dump shows: the port and class, never an address. */
    @NonNull
    public String describe() {
        Device route = current();
        return "outputs=" + outputs.size() + " route=" + (route == null ? "none" : route.port())
                + " class=" + (route == null ? "none" : classOf(route.type(), inCar.getAsBoolean()).token)
                + " car=" + inCar.getAsBoolean();
    }

    /** The class of a device of {@code type}, in or out of car mode (the card's mapping). */
    @NonNull
    public static RouteResume.RouteClass classOf(int type, boolean inCar) {
        if (inCar) return RouteResume.RouteClass.CAR;
        switch (type) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_BLE_BROADCAST:
                return RouteResume.RouteClass.BLUETOOTH;
            default:
                return RouteResume.RouteClass.OTHER;
        }
    }

    /** The last-attached output that is not the speaker, else the speaker, else null. */
    @Nullable
    private Device current() {
        Device last = null;
        Device speaker = null;
        for (Device d : outputs.values()) {
            if (d.isSpeaker()) speaker = d;
            else last = d;
        }
        return last != null ? last : speaker;
    }

    private void track(Device d) {
        if (d == null || !SessionMonitor.RouteTracker.isMediaOutput(d.type())) return;
        outputs.remove(d.slot());
        outputs.put(d.slot(), d);
    }

    private EngineInput.RouteChange change(boolean lost, Device d) {
        return new EngineInput.RouteChange(lost, d.port(), d.address(), classOf(d.type(), inCar.getAsBoolean()));
    }

    private static List<EngineInput.RouteChange> one(EngineInput.RouteChange change) {
        List<EngineInput.RouteChange> out = new ArrayList<>(1);
        out.add(change);
        return out;
    }
}
