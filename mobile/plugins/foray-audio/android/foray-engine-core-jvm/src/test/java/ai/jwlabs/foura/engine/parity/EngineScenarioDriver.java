package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineConstants;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.EngineNow;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.JSMath;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaAction;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.PlayerQueueState;
import ai.jwlabs.foura.engine.ResumeRules;
import ai.jwlabs.foura.engine.SessionPolicy;
import ai.jwlabs.foura.engine.Vocabulary;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The JVM driver for {@code {setup, steps, expect: {checkpoints, ops}}} scenarios (plan
 * §6.2; card A-24): runner.js {@code runScenario}, over {@link EngineCore} instead of
 * {@code PlayerQueueManager}. The JVM twin of the Swift EngineScenarioDriver
 * (ForayEngineParity/EngineScenarioDriver.swift), the manager target without the Foray tape.
 *
 * <p>WHAT IT IS. The fake world around the core, in the op-log grammar the JS fakes write
 * (player/parity/fakes.js): a deck that logs {@code load:<id>@<s>}, {@code play},
 * {@code pause}, {@code seek:<s>}, {@code rate:<r>}, {@code outPoint:<s>} exactly as
 * FakeBackend does, and a store that logs {@code store.save:<id>@<s>} (or, with
 * {@code setup.positionEvents}, {@code store.set:cp_pos:<id>} and
 * {@code event.position:...}). Everything else the core commands (the session, grace,
 * timers, rows, diagnostics) is logged as a native-only {@code n.*} token, which the
 * comparator strips, so a report shows it and the verdict ignores it.
 *
 * <p>TIMING IS THE JS RUNNER'S. A step that JS awaits settles here too: loads the fake
 * resolves at once land (in the order they were issued) and a started deck confirms
 * {@code playing}, before the next step. A call with {@code await: false} is fed and NOT
 * settled, so two such calls in a row are two turns with both loads still in flight.
 * {@code setup.backend.holdLoads} holds loads until a {@code deck: "loaded"} step lands them.
 * The monotonic clock moves a second per step, so nothing in one step is "within 500 ms" of
 * another unless a case says so.
 *
 * <p>THE DRIVER ALSO CHECKS WHAT NO OP LOG CAN SHOW (plan §4.4):
 * <ul>
 *   <li>the audible-start invariant on EVERY turn ({@link SessionPolicy#audibleStartViolations},
 *       the rule the {@code session-invariant} family pins);
 *   <li>{@code play} only on a deck whose current load reported {@code ready};
 *   <li>at most one audible source at a time;
 *   <li>every grace begin has an end, and none is open when the scenario ends.
 * </ul>
 * A broken one appends a {@code !...} token to the op log (never stripped), so the case goes
 * red with the evidence in its diff.
 *
 * <p>THE MANAGER REMAINDER's episode cases (code-health-3 CH3-17; the Swift driver's NE-39s
 * shapes, fakes.js's opt-in shapes of the same fakes): {@code setup.backend.slowFirstPlay}
 * holds the first play's confirmation until the next pause (SlowPlayBackend);
 * {@code setup.telemetry: ["rate.snapped"]} writes the core's {@code rate kind=snapped} row as
 * the JS telemetry line {@code telemetry:rate.snapped requested=<JSON> applied=<r>}; the
 * {@code positionTimer} view is whether the periodic position writer is armed.
 *
 * <p>The Foray tape's steps and setup (the seam beat's manual clock, the engine target, the
 * page's builds, the warming window's {@code backend.prefetch} and {@code coldLoadMs}), the
 * synthesiser and the jingle are A-40's and A-41's: a case that asks for one is refused by
 * name, never guessed at.
 */
public final class EngineScenarioDriver {
    /**
     * A deliberately broken core, for the mutation tests: the fault is injected into the
     * core's OUTPUT, so what is proven is that the driver's checks catch a core that behaves
     * this way.
     */
    public enum Mutation {
        /** {@code deckPlay} right after every {@code deckLoad}: a play before the deck is ready. */
        PLAY_ON_LOAD,
        /** A {@code deckPlay} at the head of any turn that begins lostToInterruption. */
        PLAY_WHILE_LOST
    }

    /**
     * One scenario's outcome: {@code encoded} is {@code {checkpoints, ops}}, the shape of the
     * case's expect; {@code violations} every broken check, in order (also in the op log);
     * {@code plays} the item each {@code play} started.
     */
    public record Run(Json encoded, List<String> violations, List<EngineCommand> commands, List<String> plays,
                      int maxAudibleSources, EngineState finalState) {}

    private final Mutation mutation;

    public EngineScenarioDriver(Mutation mutation) {
        this.mutation = mutation;
    }

    public EngineScenarioDriver() {
        this(null);
    }

    public Run run(FixtureCase testCase, Codec.Context context) {
        Json rawSetup = testCase.raw().get("setup");
        Json rawSteps = testCase.raw().get("steps");
        if (rawSetup == null || rawSteps == null || rawSteps.asList() == null) {
            throw new HarnessError("E_BAD_CASE", "case " + testCase.id() + " is not a scenario");
        }
        World world = new World(Codec.expandInputs(rawSetup, context), mutation);
        List<Json> steps = rawSteps.asList();
        for (int index = 0; index < steps.size(); index++) {
            Json step = steps.get(index);
            if (!(step instanceof Json.Obj o)) {
                throw new HarnessError("E_BAD_CASE", "step " + index + " of " + testCase.id() + " is not an object");
            }
            List<String> verbs = new ArrayList<>();
            for (String key : o.fields().keySet()) if (World.VERBS.contains(key)) verbs.add(key);
            if (verbs.size() != 1) {
                throw new HarnessError("E_UNKNOWN_VERB", "step " + index + " of " + testCase.id() + " has no single known verb");
            }
            world.step(verbs.get(0), o, context);
        }
        world.settle();
        world.checkpoint("end");
        world.finish();
        return new Run(world.encoded(), world.violations, world.commands, world.plays, world.maxAudible, world.core.state());
    }

    /** The world one scenario runs in. */
    static final class World {
        static final Set<String> VERBS = new HashSet<>(Arrays.asList("call", "settle", "clock", "deck", "tts", "interlude",
                "session", "lifecycle", "remote", "checkpoint"));
        /**
         * The {@code setup} keys this driver implements; any other is refused, never ignored,
         * so a case that needs the Foray tape or narration says so.
         */
        static final Set<String> SETUP_KEYS = new HashSet<>(Arrays.asList("target", "positions", "positionEvents", "rate",
                "backend", "catalogue", "session", "seamGapSec", "view", "telemetry"));
        /** The {@code setup.backend} keys of the Foray tape's warming window (A-40), refused by name. */
        static final Set<String> TAPE_BACKEND_KEYS = new HashSet<>(Arrays.asList("prefetch", "coldLoadMs"));
        /** runner.js {@code TELEMETRY_EVENTS}: the telemetry lines a scenario may record. */
        static final Set<String> TELEMETRY_EVENTS = new HashSet<>(Arrays.asList("rate.snapped"));
        /** The view keys an episode scenario may add to its checkpoints (runner.js VIEW_KEYS, the episode ones). */
        static final Set<String> VIEW_KEYS = new HashSet<>(Arrays.asList("outPoint", "positionSec", "wasPlaying", "positionTimer"));
        /** A fixed wall clock (rows are stamped with it) and a monotonic one that moves a second per step. */
        static final double WALL_MS = 1_790_000_000_000.0;
        static final double STEP_MS = 1000;

        final EngineCore core;
        final Mutation mutation;
        final boolean positionEvents;
        final Json catalogue;
        final boolean sessionFails;
        final List<String> view;

        // The fake deck (FakeBackend).
        DeckReading reading;
        final double defaultDuration;
        final Map<String, Double> durationById = new HashMap<>();
        final boolean holdLoads;
        final Set<String> failLoadFor = new HashSet<>();
        String deckItemId;
        Integer deckToken;
        Integer readyToken;
        /** FakeBackend's {@code outPoint}: set by {@code setOutPoint}, dropped by a load. */
        Double deckOutPoint;
        final List<Load> instantLoads = new ArrayList<>();
        final List<Load> heldLoads = new ArrayList<>();
        final List<Integer> confirmations = new ArrayList<>();
        /** An audition line the synthesiser is speaking (OQ-5). */
        boolean auditionSpeaking = false;
        /** A {@code dispose} in progress: the deck's release is {@code release}, as FakeBackend logs it. */
        boolean disposing = false;
        /** {@code setup.backend.slowFirstPlay}: the first play's confirmation, held until the next pause. */
        boolean slowFirstPlay;
        Integer heldConfirmation;
        /**
         * {@code setup.telemetry} and the value the last {@code setRate} was handed, as the page
         * handed it (a snapped row names the REQUEST, a string included).
         */
        final Set<String> telemetry = new HashSet<>();
        Json lastRateArg = Json.UNDEFINED;

        // What the scenario saw.
        final List<String> ops = new ArrayList<>();
        final List<Json> checkpoints = new ArrayList<>();
        int mark = 0;
        final List<String> violations = new ArrayList<>();
        final List<EngineCommand> commands = new ArrayList<>();
        final List<String> plays = new ArrayList<>();
        int maxAudible = 0;
        EngineCommand.GraceReason graceHeld;
        double monoMs = 0;

        record Load(int token, String itemId) {}

        World(Json setup, Mutation mutation) {
            if (!(setup instanceof Json.Obj fields)) throw new HarnessError("E_BAD_CASE", "setup must be an object");
            for (String key : fields.fields().keySet()) {
                if (!SETUP_KEYS.contains(key)) {
                    throw new HarnessError("E_BAD_CASE", "setup." + key + " is not implemented by the JVM scenario driver"
                            + " (the Foray tape is A-40's, narration and the interlude A-41's)");
                }
            }
            if (!"manager".equals(JsArgs.at(setup, "target").asString())) {
                throw new HarnessError("E_SCENARIO_TARGET", "the JVM scenario driver runs target manager (the engine target"
                        + " is the Foray tape's, A-40), got " + Json.show(JsArgs.at(setup, "target")));
            }
            // Without the tape the core has no beat, which is exactly a manager built with
            // `seamGapSec: 0`. Any other beat is a case this driver cannot run, never a guess.
            Json gap = JsArgs.at(setup, "seamGapSec");
            if (!JsArgs.isUndefined(gap) && !(gap instanceof Json.Num n && n.value() == 0)) {
                throw new HarnessError("E_BAD_CASE", "setup.seamGapSec " + Json.show(gap) + " needs the Foray tape (A-40)");
            }
            List<String> viewList = new ArrayList<>();
            Json viewField = JsArgs.at(setup, "view");
            if (!JsArgs.isUndefined(viewField)) {
                if (viewField.asList() == null) throw new HarnessError("E_BAD_CASE", "setup.view is a list of view keys");
                for (Json key : viewField.asList()) {
                    String name = key.asString();
                    if (name == null || !VIEW_KEYS.contains(name)) {
                        throw new HarnessError("E_BAD_CASE", "view key " + Json.show(key) + " is not an episode view key"
                                + " (the Foray and narration views are A-40's and A-41's)");
                    }
                    viewList.add(name);
                }
            }
            view = viewList;
            this.mutation = mutation;
            positionEvents = JsArgs.isTrue(JsArgs.at(setup, "positionEvents"));
            catalogue = JsArgs.at(setup, "catalogue");
            sessionFails = "fail".equals(JsArgs.at(JsArgs.at(setup, "session"), "activation").asString());
            Map<String, ResumeRules.StoredPosition> positions = new HashMap<>();
            Json seeded = JsArgs.at(setup, "positions");
            if (seeded instanceof Json.Obj seededObj) {
                for (Map.Entry<String, Json> e : seededObj.fields().entrySet()) {
                    Double seconds = e.getValue().asNumber();
                    if (seconds == null) throw new HarnessError("E_BAD_CASE", "setup.positions." + e.getKey() + " must be a number of seconds");
                    positions.put(e.getKey(), new ResumeRules.StoredPosition(seconds, null));
                }
            }
            Double rate = JsArgs.at(setup, "rate").asNumber();
            core = new EngineCore(new EngineConfig("parity", SessionPolicy.HoldPolicy.DEFAULT, rate), positions);
            Json backend = JsArgs.at(setup, "backend");
            if (backend instanceof Json.Obj backendObj) {
                for (String key : backendObj.fields().keySet()) {
                    if (TAPE_BACKEND_KEYS.contains(key)) {
                        throw new HarnessError("E_BAD_CASE", "setup.backend." + key + " is the Foray tape's warming window (A-40)");
                    }
                }
            }
            holdLoads = JsArgs.isTrue(JsArgs.at(backend, "holdLoads"));
            slowFirstPlay = JsArgs.isTrue(JsArgs.at(backend, "slowFirstPlay"));
            Json events = JsArgs.at(setup, "telemetry");
            if (!JsArgs.isUndefined(events)) {
                if (events.asList() == null) throw new HarnessError("E_BAD_CASE", "setup.telemetry is a list of event names");
                for (Json event : events.asList()) {
                    String text = event.asString();
                    if (text == null || !TELEMETRY_EVENTS.contains(text)) {
                        throw new HarnessError("E_BAD_CASE", "setup.telemetry is a list of " + String.join(", ", TELEMETRY_EVENTS));
                    }
                    telemetry.add(text);
                }
            }
            Double duration = JsArgs.at(backend, "duration").asNumber();
            defaultDuration = duration != null ? duration : 3600;
            if (JsArgs.at(backend, "durationById") instanceof Json.Obj byId) {
                for (Map.Entry<String, Json> e : byId.fields().entrySet()) {
                    Double seconds = e.getValue().asNumber();
                    if (seconds != null) durationById.put(e.getKey(), seconds);
                }
            }
            List<Json> failing = JsArgs.at(backend, "failLoadFor").asList();
            if (failing != null) {
                for (Json id : failing) if (id.asString() != null) failLoadFor.add(id.asString());
            }
            reading = new DeckReading(0.0, defaultDuration, false, false);
        }

        // ---- steps

        void step(String verb, Json.Obj step, Codec.Context context) {
            monoMs += STEP_MS;
            Map<String, Json> fields = step.fields();
            switch (verb) {
                case "call" -> {
                    call(fields, context);
                    // JS awaits an ordinary call to its end; `await: false` leaves it in flight.
                    if (!(fields.get("await") instanceof Json.Bool b && !b.value())) settle();
                }
                case "settle" -> settle();
                case "deck" -> {
                    deck(fields);
                    settle();
                }
                case "session" -> {
                    session(fields);
                    settle();
                }
                case "lifecycle" -> {
                    lifecycle(fields, context);
                    settle();
                }
                case "remote" -> {
                    remote(fields, context);
                    if (!(fields.get("await") instanceof Json.Bool b && !b.value())) settle();
                }
                case "checkpoint" -> {
                    Json name = fields.get("checkpoint");
                    if (name == null || name.asString() == null) throw new HarnessError("E_BAD_CASE", "a checkpoint needs a name");
                    checkpoint(name.asString());
                }
                default -> throw new HarnessError("E_UNKNOWN_VERB", "the \"" + verb + "\" verb has no JVM scenario driver yet"
                        + " (clock is the Foray tape's, A-40; tts and interlude the narrating overlay's, A-41)");
            }
        }

        private void call(Map<String, Json> fields, Codec.Context context) {
            String name = fields.get("call").asString();
            if (name == null) throw new HarnessError("E_BAD_CASE", "a call step needs a name");
            Json expanded = Codec.expandInputs(fields.containsKey("args") ? fields.get("args") : new Json.Arr(List.of()), context);
            List<Json> args = expanded.asList();
            if (args == null) throw new HarnessError("E_BAD_CASE", "a call's args must be an array");
            if (fields.containsKey("returns")) {
                throw new HarnessError("E_BAD_CASE", "only a Foray's build report can be recorded (returns), which is A-40's");
            }
            Vocabulary.Source tap = Vocabulary.Source.TAP;
            switch (name) {
                case "loadQueue" -> feed(new EngineInput.Queue(new EngineInput.QueueInput.Load(items(JsArgs.arg(args, 0), "loadQueue's items"))));
                case "setQueueFromPick" -> feed(new EngineInput.Queue(new EngineInput.QueueInput.Load(
                        items(new Json.Arr(List.of(JsArgs.arg(args, 0))), "setQueueFromPick's item"))));
                case "play" -> {
                    // `play(index = 0, opts = {})`, `Number(opts?.startOffset)`.
                    Json first = JsArgs.arg(args, 0);
                    int index;
                    if (JsArgs.isUndefined(first)) {
                        index = 0;
                    } else {
                        Double number = first.asNumber();
                        if (number == null || Math.rint(number) != number) {
                            throw new HarnessError("E_BAD_CASE", "play's index must be an integer, got " + Json.show(first));
                        }
                        index = number.intValue();
                    }
                    Json opts = JsArgs.arg(args, 1);
                    Double start = JsArgs.isNullish(opts) ? null : JsArgs.at(opts, "startOffset").asNumber();
                    feed(new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(index, start, tap)));
                }
                case "resume" -> feed(new EngineInput.Command(EngineContract.Command.PLAY, tap));
                case "pause" -> feed(new EngineInput.Command(EngineContract.Command.PAUSE, tap));
                case "skipToNext" -> feed(new EngineInput.Command(EngineContract.Command.NEXT, tap));
                case "skipToPrevious" -> feed(new EngineInput.Command(EngineContract.Command.PREVIOUS, tap));
                case "stop" -> feed(new EngineInput.Command(new EngineContract.Command.Stop(true), tap));
                case "seek" -> {
                    Double seconds = JsArgs.arg(args, 0).asNumber();
                    if (seconds == null) {
                        throw new HarnessError("E_BAD_CASE", "seek's seconds must be a number, got " + Json.show(JsArgs.arg(args, 0)));
                    }
                    feed(new EngineInput.Queue(new EngineInput.QueueInput.Seek(seconds,
                            JsArgs.truthy(JsArgs.at(JsArgs.arg(args, 1), "precise")))));
                }
                case "setRate" -> {
                    lastRateArg = JsArgs.arg(args, 0);
                    feed(new EngineInput.Queue(new EngineInput.QueueInput.SetRate(lastRateArg.asNumber())));
                }
                case "setVoice" -> feed(new EngineInput.Command(new EngineContract.Command.SetVoice(JsArgs.arg(args, 0).asString()), tap));
                case "setInterludeEnabled" -> {
                    // `on !== false`.
                    boolean on = !(JsArgs.arg(args, 0) instanceof Json.Bool b && !b.value());
                    feed(new EngineInput.Command(new EngineContract.Command.SetInterludeEnabled(on), tap));
                }
                case "dispose" -> {
                    // The page tearing the player down; natively the engine's own teardown.
                    disposing = true;
                    feed(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Teardown()));
                    disposing = false;
                }
                case "playForay", "setQueueFromForay" -> {
                    // Without the Foray tape: the page-built queue, loaded (and started, for playForay).
                    feed(new EngineInput.Queue(new EngineInput.QueueInput.Load(forayQueue(JsArgs.arg(args, 0)))));
                    if (name.equals("playForay")) feed(new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(0, null, tap)));
                }
                default -> throw new HarnessError("E_UNKNOWN_EXPORT", "\"" + name + "\" is not a manager call the JVM scenario driver makes");
            }
        }

        /**
         * A lock-screen, car or headset press (runner.js {@code remote}): through the SAME
         * table the page's does ({@link MediaMapping#intent}), then into the core's remote
         * handlers as the command it stands for. Every action is installed, as runner.js's
         * surface installs every intent.
         */
        private void remote(Map<String, Json> fields, Codec.Context context) {
            Json name = fields.get("remote");
            MediaAction action = name == null || name.asString() == null ? null : MediaAction.of(name.asString());
            if (action == null) throw new HarnessError("E_BAD_CASE", "unknown remote action " + Json.show(name));
            Json details = Codec.expandInputs(fields.containsKey("details") ? fields.get("details") : new Json.Obj(Map.of()), context);
            MediaMapping.PressDetails press = new MediaMapping.PressDetails(JsArgs.at(details, "seekTime").asNumber(),
                    JsArgs.isTrue(JsArgs.at(details, "close")));
            MediaMapping.Intent intent = MediaMapping.intent(action, press, MediaMapping.SeekSteps.DEFAULT);
            if (intent == null) return; // an ignored press
            EngineInput.RemotePress command = switch (intent) {
                case MediaMapping.Intent.Play i -> new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY);
                case MediaMapping.Intent.Pause i -> new EngineInput.RemotePress(MediaMapping.RemoteCommand.PAUSE);
                case MediaMapping.Intent.Next i -> new EngineInput.RemotePress(MediaMapping.RemoteCommand.NEXT_TRACK);
                case MediaMapping.Intent.Previous i -> new EngineInput.RemotePress(MediaMapping.RemoteCommand.PREVIOUS_TRACK);
                case MediaMapping.Intent.SeekBy i -> i.offset() < 0
                        ? new EngineInput.RemotePress(MediaMapping.RemoteCommand.SKIP_BACKWARD, -i.offset())
                        : new EngineInput.RemotePress(MediaMapping.RemoteCommand.SKIP_FORWARD, i.offset());
                case MediaMapping.Intent.SeekTo i -> new EngineInput.RemotePress(MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION, i.position());
                // runner.js's surface CLOSES on stop; natively a remote stop is a pause (T-7).
                case MediaMapping.Intent.Stop i -> throw new HarnessError("E_BAD_CASE",
                        "a remote stop pauses natively (T-7) where the JS surface closes; no JVM case runs it");
            };
            feed(new EngineInput.Remote(command));
        }

        private void deck(Map<String, Json> fields) {
            String event = fields.get("deck").asString();
            if (event == null) throw new HarnessError("E_BAD_CASE", "a deck step needs an event");
            int token = deckToken != null ? deckToken : 0;
            switch (event) {
                case "ended" -> {
                    // The file ran out, or the out-point stopped it: one end. Silent and at its end.
                    reading.audible = false;
                    reading.ended = true;
                    feed(new EngineInput.Deck(new DeckEvent.Ended(token)));
                }
                case "ranOut" -> {
                    // At the end with the `ended` event not yet delivered.
                    reading.audible = false;
                    reading.ended = true;
                }
                case "error" -> {
                    Json message = fields.get("message");
                    feed(new EngineInput.Deck(new DeckEvent.Failed(token, message != null && message.asString() != null ? message.asString() : "error")));
                }
                case "time" -> reading.positionSec = requireNumber(fields.get("sec"), "deck time needs sec");
                case "duration" -> reading.durationSec = requireNumber(fields.get("sec"), "deck duration needs sec");
                case "audible" -> {
                    // `backend.paused = step.audible === false`.
                    reading.audible = !(fields.get("audible") instanceof Json.Bool b && !b.value());
                    trackAudible();
                }
                case "observedPause" -> {
                    reading.audible = false;
                    feed(new EngineInput.Deck(new DeckEvent.PausedUncommanded(token, reading.positionSec != null ? reading.positionSec : 0)));
                }
                case "loaded", "loadFailed" -> {
                    Json id = fields.get("id");
                    String wanted = id == null ? null : id.asString();
                    int at = -1;
                    for (int i = 0; i < heldLoads.size(); i++) {
                        if (wanted == null || heldLoads.get(i).itemId().equals(wanted)) {
                            at = i;
                            break;
                        }
                    }
                    if (at < 0) throw new HarnessError("E_BAD_CASE", "no held load" + (wanted == null ? "" : " for " + wanted) + " to settle");
                    Load held = heldLoads.remove(at);
                    land(held.token(), held.itemId(), event.equals("loadFailed") || failLoadFor.contains(held.itemId()));
                }
                default -> throw new HarnessError("E_BAD_CASE", "unknown deck event \"" + event + "\"");
            }
        }

        private static double requireNumber(Json value, String why) {
            Double n = value == null ? null : value.asNumber();
            if (n == null) throw new HarnessError("E_BAD_CASE", why);
            return n;
        }

        /**
         * The audio session's notifications. {@code interruptionReconciled} is the iOS PAGE's
         * route for an interruption-began notification; natively that same notification reaches
         * the engine directly, so both arrive as one input.
         */
        private void session(Map<String, Json> fields) {
            String event = fields.get("session").asString();
            if (event == null) throw new HarnessError("E_BAD_CASE", "a session step needs an event");
            switch (event) {
                case "interruptionBegan", "interruptionReconciled" -> {
                    Json reason = fields.get("reason");
                    feed(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan(reason == null ? null : reason.asString())));
                }
                case "interruptionEnded" -> {
                    if (!(fields.get("shouldResume") instanceof Json.Bool b)) {
                        throw new HarnessError("E_BAD_CASE", "session interruptionEnded needs a boolean shouldResume");
                    }
                    feed(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionEnded(b.value())));
                }
                case "routeLost", "routeAvailable" -> {
                    Json routeName = fields.get("routeName");
                    feed(new EngineInput.Session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(
                            event.equals("routeLost"), routeName == null ? null : routeName.asString(),
                            fields.get("isCarRoute") instanceof Json.Bool car && car.value()))));
                }
                case "mediaServicesReset" -> feed(new EngineInput.Session(new EngineInput.SessionEvent.MediaServicesReset()));
                default -> throw new HarnessError("E_BAD_CASE", "unknown session event \"" + event + "\"");
            }
        }

        private void lifecycle(Map<String, Json> fields, Codec.Context context) {
            String event = fields.get("lifecycle").asString();
            if (event == null) throw new HarnessError("E_BAD_CASE", "a lifecycle step needs an event");
            switch (event) {
                case "coldLaunch" -> {
                    List<EngineItem> queue = items(Codec.expandInputs(fields.containsKey("items") ? fields.get("items")
                            : new Json.Arr(List.of()), context), "coldLaunch's items");
                    Json index = fields.get("index");
                    int at = index == null || index.asNumber() == null ? 0 : index.asNumber().intValue();
                    feed(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.ColdLaunch(queue, at,
                            fields.get("autoplay") instanceof Json.Bool b && b.value())));
                }
                case "foreground" -> feed(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Foreground()));
                case "background" -> feed(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Background()));
                default -> throw new HarnessError("E_BAD_CASE", "unknown lifecycle event \"" + event + "\"");
            }
        }

        // ---- the page's side of a queue

        /** {@code loadQueue}'s items: {@code filter(Boolean)}, then each a catalogue row. */
        private static List<EngineItem> items(Json value, String what) {
            List<Json> values = value.asList();
            if (values == null) throw new HarnessError("E_BAD_CASE", what + " must be an array");
            List<EngineItem> out = new ArrayList<>();
            for (Json raw : values) {
                if (!JsArgs.truthy(raw)) continue;
                EngineItem item = EngineItem.of(node(raw));
                if (item == null) throw new HarnessError("E_BAD_CASE", what + ": an item needs a non-empty string id, got " + Json.show(raw));
                out.add(item);
            }
            return out;
        }

        /**
         * {@code playForay(foray, {resolveItem})}'s queue WITHOUT the Foray tape: the one shape
         * it can build faithfully, plain segments of catalogue rows with no ad-drift check,
         * which buildForayQueue turns into {@code {id: "<foray>#<i>", kind, audio_url,
         * start_sec, end_sec, source_item_id}}. With the tape a Foray is the page's build (A-40).
         */
        private List<EngineItem> forayQueue(Json foray) {
            String forayId = JsArgs.at(foray, "id").asString();
            List<Json> entries = JsArgs.at(foray, "items").asList();
            if (forayId == null || entries == null) throw new HarnessError("E_BAD_CASE", "playForay needs {id, items[]}");
            List<EngineItem> built = new ArrayList<>();
            for (int index = 0; index < entries.size(); index++) {
                Json entry = entries.get(index);
                String itemId = JsArgs.at(entry, "item_id").asString();
                Json row = JsArgs.at(catalogue, itemId == null ? "" : itemId);
                Double start = JsArgs.at(entry, "start_sec").asNumber();
                Double end = JsArgs.at(entry, "end_sec").asNumber();
                if (!"segment".equals(JsArgs.at(entry, "type").asString()) || !(row instanceof Json.Obj) || start == null || end == null
                        || JsArgs.isTrue(JsArgs.at(row, "dai_suspected"))) {
                    throw new HarnessError("E_BAD_CASE", "without the Foray tape the JVM driver builds only plain segments of catalogue rows");
                }
                List<JsonNode.Member> members = new ArrayList<>();
                members.add(JsonNode.member("id", JsonNode.str(forayId + "#" + index)));
                members.add(JsonNode.member("kind", JsonNode.str("episode")));
                String url = JsArgs.at(row, "audio_url").asString();
                members.add(JsonNode.member("audio_url", url == null ? JsonNode.NULL : JsonNode.str(url)));
                members.add(JsonNode.member("start_sec", JsonNode.num(start)));
                members.add(JsonNode.member("end_sec", JsonNode.num(end)));
                members.add(JsonNode.member("source_item_id", JsonNode.str(itemId)));
                for (String key : Arrays.asList("title", "show")) {
                    String text = JsArgs.at(row, key).asString();
                    if (text != null) members.add(JsonNode.member(key, JsonNode.str(text)));
                }
                built.add(EngineItem.of(new JsonNode.Obj(members)));
            }
            return built;
        }

        /** A macro-expanded value as the page would send it (keys sorted; scenario items are never byte rows). */
        static JsonNode node(Json value) {
            return switch (value) {
                case Json.Undefined u -> JsonNode.NULL;
                case Json.Null n -> JsonNode.NULL;
                case Json.Bool b -> JsonNode.bool(b.value());
                case Json.Num n -> JsonNode.num(n.value());
                case Json.Str s -> JsonNode.str(s.value());
                case Json.Arr a -> {
                    List<JsonNode> items = new ArrayList<>();
                    for (Json item : a.items()) items.add(node(item));
                    yield new JsonNode.Arr(items);
                }
                case Json.Obj o -> {
                    List<String> keys = new ArrayList<>(o.fields().keySet());
                    Collections.sort(keys);
                    List<JsonNode.Member> members = new ArrayList<>();
                    for (String key : keys) {
                        Json member = o.fields().get(key);
                        if (!(member instanceof Json.Undefined)) members.add(JsonNode.member(key, node(member)));
                    }
                    yield new JsonNode.Obj(members);
                }
            };
        }

        // ---- feeding the core

        private EngineNow now() {
            return new EngineNow(WALL_MS, monoMs, reading);
        }

        /**
         * One turn: the input, then (as the host does, before anything else) the answer to
         * any activation it asked for. The audible-start rule is checked over the whole turn,
         * from the session the turn began with.
         */
        void feed(EngineInput input) {
            SessionPolicy.Phase entry = core.state().session;
            List<String> names = new ArrayList<>();
            List<EngineCommand> output = mutate(core.handle(input, now()), entry, true);
            int rounds = 0;
            while (true) {
                apply(output, names);
                Integer request = null;
                for (EngineCommand command : output) {
                    if (command instanceof EngineCommand.SessionActivate a) request = a.requestId();
                }
                if (rounds >= 4 || request == null) break;
                rounds += 1;
                boolean ok = !sessionFails;
                names.add(ok ? SessionPolicy.TurnMarker.RESULT_OK : SessionPolicy.TurnMarker.RESULT_FAILED);
                output = core.handle(new EngineInput.SessionAnswer(new EngineInput.SessionResult(request, ok,
                        ok ? null : "cannot-start-playing", 1.0)), now());
                // A load usually follows the activation's answer, so a mutation must reach that
                // part of the turn too.
                output = mutate(output, entry, false);
            }
            for (SessionPolicy.Violation violation : SessionPolicy.audibleStartViolations(entry, names)) {
                broke("audible-start:" + violation.cmd() + "@" + entry.token);
            }
        }

        private List<EngineCommand> mutate(List<EngineCommand> output, SessionPolicy.Phase entry, boolean turnHead) {
            if (mutation == null) return output;
            List<EngineCommand> changed = new ArrayList<>();
            switch (mutation) {
                case PLAY_ON_LOAD -> {
                    for (EngineCommand command : output) {
                        changed.add(command);
                        if (command instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load) {
                            changed.add(new EngineCommand.Deck(DeckCommand.PLAY));
                        }
                    }
                }
                case PLAY_WHILE_LOST -> {
                    if (turnHead && entry == SessionPolicy.Phase.LOST_TO_INTERRUPTION) changed.add(new EngineCommand.Deck(DeckCommand.PLAY));
                    changed.addAll(output);
                }
            }
            return changed;
        }

        /** Interpret the core's commands in the fake world, logging each one. */
        private void apply(List<EngineCommand> output, List<String> names) {
            for (EngineCommand command : output) {
                commands.add(command);
                names.add(EngineCommand.turnName(command));
                switch (command) {
                    case EngineCommand.Deck d -> applyDeck(d.command());
                    case EngineCommand.WritePosition w -> ops.add(positionEvents ? "store.set:" + w.write().row().key()
                            : "store.save:" + w.write().itemId() + "@" + rounded(w.write().seconds()));
                    case EngineCommand.AppendEvent e -> {
                        EngineCommand.PendingEvent event = e.event();
                        String text = "event.position:" + event.episodeId() + "@" + number(event.seconds()) + ":"
                                + (event.duration() == null ? "null" : number(event.duration()));
                        ops.add(positionEvents ? text : "n." + text);
                    }
                    case EngineCommand.SessionActivate a -> ops.add("n.session.activate:" + a.requestId());
                    case EngineCommand.SessionDeactivate d -> ops.add(d.notifyOthers() ? "n.session.deactivate:notify" : "n.session.deactivate");
                    case EngineCommand.SessionReapplyCategory c -> ops.add("n.session.category");
                    case EngineCommand.SessionRebuild c -> ops.add("n.session.rebuild");
                    case EngineCommand.GraceBegin g -> {
                        if (graceHeld != null) broke("grace-begun-twice:" + graceHeld.token);
                        graceHeld = g.reason();
                        ops.add("n.grace.begin:" + g.reason().token);
                    }
                    case EngineCommand.GraceEnd g -> {
                        if (graceHeld == null) broke("grace-end-without-begin:" + g.outcome().token);
                        graceHeld = null;
                        ops.add("n.grace.end:" + g.outcome().token);
                    }
                    case EngineCommand.TimerArm t -> ops.add("n.timer.arm:" + t.timer().token);
                    case EngineCommand.TimerCancel t -> ops.add("n.timer.cancel:" + t.timer().token);
                    case EngineCommand.WriteRow r -> ops.add("n.row:" + r.row().key());
                    case EngineCommand.WriteRestore r -> ops.add("n.restore:" + (r.record() == null ? "removed" : r.record().mode().token));
                    case EngineCommand.Speak s -> {
                        // The audition (OQ-5): the synthesiser's own op, at the speed narration
                        // speaks at (`NARRATION_RATE`), as tts.speak logs it.
                        auditionSpeaking = true;
                        trackAudible();
                        ops.add("tts.speak:" + s.text() + "@" + number(EngineConstants.QueueManager.NARRATION_RATE)
                                + (s.voiceId() == null ? "" : ":" + s.voiceId()));
                    }
                    case EngineCommand.Emit e -> {
                        switch (e.event()) {
                            case EngineCommand.EngineEvent.Advanced a -> ops.add("n.emit:advanced");
                            case EngineCommand.EngineEvent.Error err -> ops.add("n.emit:error:" + err.code());
                        }
                    }
                    case EngineCommand.Diag d -> {
                        JsonNode sub = d.entry().field("kind");
                        if (d.entry().kind().equals("rate") && sub != null && "snapped".equals(sub.stringValue())
                                && telemetry.contains("rate.snapped")) {
                            // The manager's `rate.snapped requested=<JSON> applied=<r>`.
                            JsonNode applied = d.entry().field("applied");
                            Double rate = applied == null ? null : applied.numberValue();
                            ops.add("telemetry:rate.snapped requested=" + jsonStringify(lastRateArg) + " applied="
                                    + (rate == null ? "null" : number(rate)));
                            continue;
                        }
                        JsonNode cause = d.entry().field("cause");
                        String suffix = cause != null && cause.stringValue() != null ? ":" + cause.stringValue() : "";
                        ops.add("n.diag:" + d.entry().kind() + suffix);
                    }
                    case EngineCommand.CommandFailed f -> ops.add("n.failed:" + f.reason());
                }
            }
        }

        /** FakeBackend, command by command. */
        private void applyDeck(DeckCommand command) {
            switch (command) {
                case DeckCommand.Load load -> {
                    // A load re-points the element: paused, at the offset, no boundary.
                    deckItemId = load.itemId();
                    deckToken = load.token();
                    readyToken = null;
                    deckOutPoint = null;
                    reading.positionSec = load.startSec();
                    reading.audible = false;
                    reading.ended = false;
                    Double duration = durationById.get(load.itemId());
                    reading.durationSec = duration != null ? duration : defaultDuration;
                    ops.add("load:" + load.itemId() + "@" + rounded(load.startSec()));
                    (holdLoads ? heldLoads : instantLoads).add(new Load(load.token(), load.itemId()));
                }
                case DeckCommand.Play p -> {
                    if (deckToken == null || !deckToken.equals(readyToken)) broke("deck-play-before-ready");
                    reading.audible = true;
                    auditionSpeaking = false;
                    plays.add(deckItemId != null ? deckItemId : "?");
                    trackAudible();
                    ops.add("play");
                    if (slowFirstPlay && deckToken != null) {
                        // SlowPlayBackend: the first play settles only at the next pause.
                        slowFirstPlay = false;
                        heldConfirmation = deckToken;
                    } else if (deckToken != null) {
                        confirmations.add(deckToken);
                    }
                }
                case DeckCommand.Pause p -> {
                    reading.audible = false;
                    ops.add("pause");
                    if (heldConfirmation != null) {
                        confirmations.add(heldConfirmation);
                        heldConfirmation = null;
                    }
                }
                case DeckCommand.Seek s -> {
                    reading.positionSec = s.toSec();
                    ops.add("seek:" + rounded(s.toSec()));
                }
                case DeckCommand.SetRate r -> ops.add("rate:" + number(r.rate()));
                case DeckCommand.SetOutPoint o -> {
                    deckOutPoint = o.sec();
                    ops.add("outPoint:" + (o.sec() == null ? "null" : rounded(o.sec())));
                }
                case DeckCommand.Unload u -> {
                    deckItemId = null;
                    deckToken = null;
                    readyToken = null;
                    deckOutPoint = null;
                    reading = new DeckReading(null, null, false, false);
                    // FakeBackend's `release()` is the teardown's (`dispose`).
                    ops.add(disposing ? "release" : "n.deck.unload");
                }
            }
        }

        /**
         * A load lands (or fails). A superseded load's answer is still delivered, as the JS
         * fake resolves it: the core must be the one to ignore it.
         */
        private void land(int token, String itemId, boolean fail) {
            if (fail) {
                feed(new EngineInput.Deck(new DeckEvent.Failed(token, "missing file")));
                return;
            }
            if (deckToken != null && deckToken == token) readyToken = token;
            feed(new EngineInput.Deck(new DeckEvent.Ready(token, reading.positionSec != null ? reading.positionSec : 0, true, 0)));
        }

        /**
         * Everything in flight that the JS fakes would resolve before the next step: instant
         * loads, in issue order, then each started deck saying {@code playing}.
         */
        void settle() {
            int budget = 256;
            while (budget > 0) {
                budget -= 1;
                if (!instantLoads.isEmpty()) {
                    Load next = instantLoads.remove(0);
                    land(next.token(), next.itemId(), failLoadFor.contains(next.itemId()));
                    continue;
                }
                if (!confirmations.isEmpty()) {
                    int token = confirmations.remove(0);
                    if (deckToken != null && deckToken == token && reading.audible) {
                        feed(new EngineInput.Deck(new DeckEvent.TimeControl(token, DeckEvent.TimeControlStatus.PLAYING, null)));
                    }
                    continue;
                }
                return;
            }
            broke("settle-did-not-converge");
        }

        private void trackAudible() {
            int sources = (reading.audible ? 1 : 0) + (auditionSpeaking ? 1 : 0);
            if (sources > 1) broke("two-audible-sources");
            maxAudible = Math.max(maxAudible, sources);
        }

        private void broke(String what) {
            violations.add(what);
            ops.add("!" + what);
        }

        // ---- checkpoints and the answer

        void checkpoint(String name) {
            EngineState state = core.state();
            Map<String, Json> fields = new LinkedHashMap<>();
            fields.put("name", Json.str(name));
            List<Json> slice = new ArrayList<>();
            for (String op : ops.subList(mark, ops.size())) slice.add(Json.str(op));
            fields.put("ops", new Json.Arr(slice));
            fields.put("index", Json.num(state.currentIndex));
            // The jingle and the seam beat are the Foray tape's (A-40): never on an episode.
            fields.put("inInterlude", Json.FALSE);
            fields.put("inSeamGap", Json.FALSE);
            fields.put("playhead", state.loadedId == null ? Json.NULL : Json.str(state.loadedId));
            fields.put("rate", Json.num(state.rate));
            fields.put("state", Json.str(state.stateType()));
            for (String key : view) {
                switch (key) {
                    case "outPoint" -> fields.put(key, deckOutPoint == null ? Json.NULL : Json.num(deckOutPoint));
                    case "positionSec" -> fields.put(key, Json.num(reading.positionSec != null ? reading.positionSec : 0));
                    case "wasPlaying" -> fields.put(key, state.player instanceof PlayerQueueState.Interrupted i
                            ? Json.bool(i.wasPlaying()) : Json.NULL);
                    case "positionTimer" -> fields.put(key, Json.bool(state.positionTimerArmed));
                    default -> throw new HarnessError("E_BAD_CASE", "unknown view key " + key);
                }
            }
            checkpoints.add(new Json.Obj(fields));
            mark = ops.size();
        }

        /** The end-of-scenario checks: no grace span left open. */
        void finish() {
            if (graceHeld != null) broke("grace-never-ended:" + graceHeld.token);
        }

        Json encoded() {
            List<Json> opList = new ArrayList<>();
            for (String op : ops) opList.add(Json.str(op));
            Map<String, Json> out = new LinkedHashMap<>();
            out.put("checkpoints", new Json.Arr(checkpoints));
            out.put("ops", new Json.Arr(opList));
            return new Json.Obj(out);
        }

        /** {@code JSON.stringify(value)} for a telemetry line's scalar; a container prints as its tag. */
        static String jsonStringify(Json value) {
            return switch (value) {
                case Json.Undefined u -> "undefined";
                case Json.Null n -> "null";
                case Json.Bool b -> b.value() ? "true" : "false";
                case Json.Num n -> Double.isFinite(n.value()) ? number(n.value()) : "null";
                case Json.Str s -> JSWriter.quote(s.value());
                case Json.Arr a -> "[object]";
                case Json.Obj o -> "[object]";
            };
        }

        /** FakeBackend's {@code r(s) = Math.round(s)}, printed as JS prints a number. */
        static String rounded(double seconds) {
            return number(JSMath.round(seconds));
        }

        /** {@code `${n}`}: ECMAScript Number::toString. */
        static String number(double value) {
            return JSWriter.numberToString(value);
        }
    }
}
