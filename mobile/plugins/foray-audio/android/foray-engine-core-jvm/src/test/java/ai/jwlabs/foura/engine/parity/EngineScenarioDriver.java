package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.ContractDecoding;
import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckPolicy;
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
import ai.jwlabs.foura.engine.EngineTimer;
import ai.jwlabs.foura.engine.Interlude;
import ai.jwlabs.foura.engine.JSMath;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaAction;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.NarratorReading;
import ai.jwlabs.foura.engine.PlayerQueueState;
import ai.jwlabs.foura.engine.ResumeRules;
import ai.jwlabs.foura.engine.SeamGap;
import ai.jwlabs.foura.engine.SessionPolicy;
import ai.jwlabs.foura.engine.Vocabulary;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The JVM driver for {@code {setup, steps, expect: {checkpoints, ops}}} scenarios (plan
 * §6.2; cards A-24 and A-40): runner.js {@code runScenario}, over {@link EngineCore} instead of
 * {@code PlayerQueueManager}. The JVM twin of the Swift EngineScenarioDriver
 * (ForayEngineParity/EngineScenarioDriver.swift), the Foray tape included.
 *
 * <p>WHAT IT IS. The fake world around the core, in the op-log grammar the JS fakes write
 * (player/parity/fakes.js): a deck that logs {@code load:<id>@<s>}, {@code play},
 * {@code pause}, {@code seek:<s>}, {@code rate:<r>}, {@code outPoint:<s>} exactly as
 * FakeBackend does, and a store that logs {@code store.save:<id>@<s>} (or, with
 * {@code setup.positionEvents}, {@code store.set:cp_pos:<id>} and {@code event.position:...}).
 * Everything else the core commands (the session, grace, timers, rows, diagnostics) is logged as
 * a native-only {@code n.*} token, which the comparator strips.
 *
 * <p>TIMING IS THE JS RUNNER'S. A step that JS awaits settles here too: loads the fake resolves
 * at once land (in issue order) and a started deck confirms {@code playing}, before the next
 * step. A call with {@code await: false} is fed and NOT settled. {@code setup.backend.holdLoads}
 * holds loads until a {@code deck: "loaded"} step lands them.
 *
 * <p>THE SEAM BEAT'S CLOCK (A-40) is the JS scheduler's. {@code setup.scheduler: "manual"} is
 * fakes.js {@code manualScheduler}: the monotonic clock moves ONLY on a {@code clock} step, and
 * the beat's one timer fires when that step passes it. Otherwise it is {@code instantScheduler}:
 * the beat fires as the step settles, and the clock moves a second per step. The {@code engine}
 * target (the prepare family, runner.js {@code runEngineScenario}) always runs on the manual clock
 * and drives the core through the CONTRACT (engineSend payloads), with a standby deck that
 * prepares and hands over as reference-engine.js's WarmingBackend does; its op log holds only the
 * deck's tokens and {@code n.prepare:} / {@code n.prepare-seek:} / {@code n.handover:}, which the
 * prepare families assert. Since A-62 (NE-45s) the standby deck REMEMBERS its source (a handover
 * demotes the outgoing deck without dropping what it holds, so a prepare of that source is a
 * same-source seek, {@code n.prepare-seek:}), the window opens for an item with no out-point from
 * its duration, and a load already inside its window at its first play opens it then
 * (WarmingBackend {@code _windowAtStart}).
 *
 * <p>THE NARRATION OVERLAY runs against two more fakes in the JS fakes' grammar: a synthesiser
 * (fakes.js {@code fakeTts}, every shape: refuse, voiceFallback, {@code onFinished: false},
 * {@code transport: false}, a rejecting pause, a resume answer, {@code state}) that logs
 * {@code tts.speak:<text>@<rate>}, {@code tts.pause}, {@code tts.resume} and {@code tts.stop},
 * and a jingle player ({@code fakeInterlude}) that logs {@code interlude.start} /
 * {@code .refused} / {@code .stop} / {@code .ended:<reason>} / {@code .release}. Their answers land
 * when the step settles, before any load, as the JS awaits resolve.
 *
 * <p>THE DRIVER ALSO CHECKS WHAT NO OP LOG CAN SHOW (plan §4.4): the audible-start invariant on
 * EVERY turn; {@code play} only on a deck whose current load reported {@code ready}; at most one
 * audible source at a time; every grace begin has an end, and none is open when the scenario
 * ends; the silence node only while the transport runs. A broken one appends a {@code !...} token
 * to the op log (never stripped), so the case goes red with the evidence in its diff.
 *
 * <p>THE MANAGER REMAINDER (card A-63, the JVM twin of NE-39s; NE-39j recorded it) adds, on the
 * manager target, fakes.js's opt-in shapes of the same fakes:
 * <ul>
 *   <li>{@code setup.backend.prefetch} ({@code true} or {@code "loses"}): the core's
 *       {@code prepare} is the manager's ASK and is logged {@code prefetch:<id>@<s>}; a later load
 *       of that item at that offset is WARM (it lands at once), unless the race was lost
 *       ({@code "loses"}); a {@code deck: "window"} step is the deck's playhead watch reaching the
 *       prefetch lead ({@link DeckEvent.PrepareWindow});</li>
 *   <li>{@code setup.backend.coldLoadMs} (manual clock only): a load that finds nothing warm waits
 *       that long on the scenario clock, and its {@code load:} op, like FakeBackend's, is written
 *       when it lands;</li>
 *   <li>{@code setup.backend.slowFirstPlay}: the first play's confirmation waits for the next
 *       pause (SlowPlayBackend);</li>
 *   <li>{@code setup.telemetry: ["rate.snapped"]}: the core's {@code rate kind=snapped}
 *       diagnostics row, written as the JS telemetry line
 *       {@code telemetry:rate.snapped requested=<JSON> applied=<r>};</li>
 *   <li>the {@code positionTimer} view: whether the periodic position writer is armed.</li>
 * </ul>
 * Two of NE-39j's shapes are REFUSED, as the Swift driver refuses them, because what they model is
 * the JS manager's awaits, which one synchronous native turn does not have (their cases are the
 * jsOnly {@code manager-await} family): {@code setup.tts.pause: "held"} and
 * {@code setup.settledEvents}.
 */
public final class EngineScenarioDriver {
    /**
     * A deliberately broken core, for the mutation tests: the fault is injected into the core's
     * OUTPUT (or into what the fakes report), so what is proven is that the driver's checks, and
     * the fixtures, catch a core that behaves this way.
     */
    public enum Mutation {
        /** {@code deckPlay} right after every {@code deckLoad}: a play before the deck is ready. */
        PLAY_ON_LOAD,
        /** A {@code deckPlay} at the head of any turn that begins lostToInterruption. */
        PLAY_WHILE_LOST,
        /**
         * A load commanded inside a seam beat reaches the deck only once the beat's deadline has
         * passed: the next item is loaded AFTER the beat instead of inside it (a seam costing gap +
         * load, the defect the beat's absolute deadline exists to prevent).
         */
        LOAD_AFTER_BEAT,
        /** The synthesiser reports every {@code didCancel} as {@code didFinish}: an interrupted line ADVANCES. */
        CANCEL_AS_FINISHED,
        /** Every {@code didFinish} is taken as the CURRENT line's, whatever utterance it was about. */
        FINISHED_CLAIMS_CURRENT_LINE,
        /** The silence node started at the head of every turn that begins with the transport not running. */
        SILENCE_WHILE_NOT_RUNNING,
        /**
         * A-62: warming back to THE BEAT's rule (before NE-45j): a {@code prepare} reaches the
         * standby deck only from a PLAYING item, and only across a seam that gets a beat
         * ({@code SeamGap.gapSec(...) > 0}), so every seam with a narration line in it is cold.
         */
        WARM_BY_THE_BEAT
    }

    /**
     * One scenario's outcome: {@code encoded} is {@code {checkpoints, ops}}, the shape of the
     * case's expect; {@code violations} every broken check, in order (also in the op log);
     * {@code plays} the item each {@code play} started.
     */
    public record Run(Json encoded, List<String> violations, List<EngineCommand> commands, List<String> plays,
                      int maxAudibleSources, EngineState finalState) {}

    private final Mutation mutation;
    private final boolean forayTape;
    private final Map<Integer, List<JsonNode>> inlineBuilds;

    /**
     * {@code forayTape}: the core runs with {@link EngineConfig#forayTapeEnabled}, and a Foray a
     * scenario plays is the PAGE's build from {@code player/parity/scenario-builds.json}. Off, the
     * driver is M1's exactly (the manager-episode family runs so). {@code inlineBuilds}: a test's
     * own page builds, by step index, for a case that is not in a fixture file.
     */
    public EngineScenarioDriver(Mutation mutation, boolean forayTape, Map<Integer, List<JsonNode>> inlineBuilds) {
        this.mutation = mutation;
        this.forayTape = forayTape;
        this.inlineBuilds = inlineBuilds == null ? Map.of() : Map.copyOf(inlineBuilds);
    }

    public EngineScenarioDriver(Mutation mutation, boolean forayTape) {
        this(mutation, forayTape, null);
    }

    public EngineScenarioDriver(Mutation mutation) {
        this(mutation, false, null);
    }

    public EngineScenarioDriver() {
        this(null, false, null);
    }

    public Run run(FixtureCase testCase, Codec.Context context) {
        Json rawSetup = testCase.raw().get("setup");
        Json rawSteps = testCase.raw().get("steps");
        if (rawSetup == null || rawSteps == null || rawSteps.asList() == null) {
            throw new HarnessError("E_BAD_CASE", "case " + testCase.id() + " is not a scenario");
        }
        World world = new World(Codec.expandInputs(rawSetup, context), mutation, forayTape, testCase.id());
        world.inlineBuilds = inlineBuilds;
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
            world.stepIndex = index;
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
        /** The {@code setup} keys this driver implements; any other is refused, never ignored. */
        static final Set<String> SETUP_KEYS = new HashSet<>(Arrays.asList("target", "positions", "positionEvents", "rate",
                "backend", "catalogue", "session", "seamGapSec", "view", "scheduler", "seamGapEvents", "forayBuild", "capabilities",
                "tts", "interlude", "interludeEnabled", "voice", "narrationTicks", "preview", "telemetry"));
        /** NE-39j's shapes of the JS manager's awaits, refused with the reason (the jsOnly {@code manager-await} family). */
        static final String AWAIT_ONLY = "it models the JS manager's awaits, which a synchronous native turn does not have"
                + " (the jsOnly manager-await family)";
        /** runner.js {@code TELEMETRY_EVENTS}: the telemetry lines a scenario may record. */
        static final Set<String> TELEMETRY_EVENTS = Set.of("rate.snapped");
        /** runner.js {@code VIEW_KEYS}: what a scenario may add to its checkpoints. */
        static final Set<String> VIEW_KEYS = new HashSet<>(Arrays.asList("outPoint", "seamGapRemainingMs", "timersLive", "positionSec",
                "narrationSec", "narrationPlayhead", "narrationTicks", "lastVoiceFallback", "wasPlaying",
                "positionTimer"));
        /** The timers the JS manager runs on its injected scheduler: the beat and the pulse. */
        static final Set<EngineTimer> SCHEDULER_TIMERS = Set.of(EngineTimer.SEAM_BEAT, EngineTimer.NARRATION_TICK);
        /** A fixed wall clock (rows are stamped with it) and a monotonic one that moves a second per step. */
        static final double WALL_MS = 1_790_000_000_000.0;
        static final double STEP_MS = 1000;

        final EngineCore core;
        final Mutation mutation;
        final boolean positionEvents;
        final Json catalogue;
        final boolean sessionFails;
        final String caseId;
        final boolean forayTape;
        /** runner.js {@code runEngineScenario}: the contract, the standby deck, T. */
        final boolean engineTarget;
        /** fakes.js {@code manualScheduler}. */
        final boolean manualClock;
        final List<String> view;
        final boolean seamGapEvents;
        int stepIndex = 0;
        Map<Integer, List<JsonNode>> inlineBuilds = Map.of();

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
        /** The standby deck (reference-engine.js WarmingBackend), engine target only. */
        DeckPolicy.Warm warm;
        String currentUrl;
        /**
         * WarmingBackend {@code _standbyUrl} (NE-45j): the source the standby deck holds, what it
         * last prepared or what the last handover demoted onto it.
         */
        String standbyUrl;
        /** WarmingBackend {@code _loadCount} / {@code _windowCheckedFor}: one automatic window check per load, at its first play. */
        int loadCount;
        Integer windowCheckedFor;
        /** WarmingBackend {@code rate}: the deck's own, for the window's wall clock. */
        double deckRate = 1;
        /** A window that opened at a play, fed to the core when that turn is over (the JS calls it from inside {@code play()}). */
        Integer windowAtStart;
        /** The core's timers that are armed, and when each is due (monotonic). */
        final Map<EngineTimer, Double> timerDue = new EnumMap<>(EngineTimer.class);
        /** The synthesiser and the jingle player, null when not wired. */
        FakeNarrator narrator;
        FakeJingle jingle;
        /** Their answers, delivered when the step settles, before any load. */
        final List<EngineInput> answers = new ArrayList<>();
        /**
         * NE-47 (A-66): the preview deck (fakes.js {@code fakePreview}): the urls whose load fails,
         * the load in flight, and whether the preview is sounding.
         */
        final Set<String> previewFailUrls = new HashSet<>();
        Integer previewToken;
        Integer previewReadyToken;
        boolean previewAudible = false;
        /** What is audible besides the deck. */
        boolean auditionSpeaking = false;
        boolean narrationSpeaking = false;
        boolean silenceOn = false;
        /** The narration pulses the surface saw ({@code narrationTicks}). */
        int pulses = 0;
        final boolean pulseWired;
        /** A {@code dispose} in progress: the deck's release is {@code release}, as FakeBackend logs it. */
        boolean disposing = false;
        /** {@code LOAD_AFTER_BEAT}'s withheld loads. */
        final List<DeckCommand> deferredLoads = new ArrayList<>();
        /**
         * A-63 (NE-39s): FakeBackend's prefetch contract ({@code setup.backend.prefetch}): null
         * without one, else whether the warm load loses its race.
         */
        final Boolean prefetchLoses;
        /** The {@code <id>@<s>} keys asked for and not yet loaded (FakeBackend {@code _warmed}). */
        final Set<String> warmed = new HashSet<>();
        /**
         * {@code setup.backend.coldLoadMs}: what a load with nothing warm costs on the manual clock,
         * and the loads waiting it out (in issue order).
         */
        final double coldLoadMs;
        final List<ColdLoad> coldLoads = new ArrayList<>();
        /** {@code setup.backend.slowFirstPlay}: the first play's confirmation, held until the next pause. */
        boolean slowFirstPlay;
        Integer heldConfirmation;
        /**
         * {@code setup.telemetry}, and the value the last {@code setRate} was handed, as the page
         * handed it (a snapped row names the REQUEST, a string included).
         */
        final Set<String> telemetry;
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
        /** runner.js {@code returned}: what {@code returns} steps recorded for the next checkpoint. */
        final List<Json> returned = new ArrayList<>();
        /** Refusals the core answered in the current engine command. */
        final List<String> refusals = new ArrayList<>();
        int cmdSeq = 0;
        /** Whether the transport ran when the current turn began. */
        boolean runningAtEntry = false;

        record Load(int token, String itemId) {}

        record ColdLoad(DeckCommand command, double dueMs) {}

        World(Json setup, Mutation mutation, boolean forayTape, String caseId) {
            if (!(setup instanceof Json.Obj fields)) throw new HarnessError("E_BAD_CASE", "setup must be an object");
            if (fields.fields().containsKey("settledEvents")) {
                throw new HarnessError("E_BAD_CASE", "setup.settledEvents is refused: " + AWAIT_ONLY
                        + "; the native snapshot follows every turn");
            }
            if ("held".equals(JsArgs.at(JsArgs.at(setup, "tts"), "pause").asString())) {
                throw new HarnessError("E_BAD_CASE", "setup.tts.pause \"held\" is refused: " + AWAIT_ONLY);
            }
            for (String key : fields.fields().keySet()) {
                if (!SETUP_KEYS.contains(key)) {
                    throw new HarnessError("E_BAD_CASE", "setup." + key + " is not implemented by the JVM scenario driver");
                }
            }
            String target = JsArgs.at(setup, "target").asString();
            if (!"manager".equals(target) && !"engine".equals(target)) {
                throw new HarnessError("E_SCENARIO_TARGET", "the JVM scenario driver runs target manager or engine, got "
                        + Json.show(JsArgs.at(setup, "target")));
            }
            engineTarget = "engine".equals(target);
            boolean tape = forayTape;
            List<Json> caps = JsArgs.at(setup, "capabilities").asList();
            if (engineTarget && caps != null) tape = tape && caps.contains(Json.str("foray"));
            this.forayTape = tape;
            // Without the tape the core has no beat, which is exactly a manager built with
            // `seamGapSec: 0`. Any other beat there is a case this driver cannot run.
            Json gap = JsArgs.at(setup, "seamGapSec");
            if (!tape && !JsArgs.isUndefined(gap) && !(gap instanceof Json.Num n && n.value() == 0)) {
                throw new HarnessError("E_BAD_CASE", "setup.seamGapSec " + Json.show(gap)
                        + " needs the Foray tape; without it the JVM scenario driver runs only 0");
            }
            Json scheduler = JsArgs.at(setup, "scheduler");
            if (JsArgs.isUndefined(scheduler) || "instant".equals(scheduler.asString())) {
                manualClock = engineTarget;
            } else if ("manual".equals(scheduler.asString())) {
                manualClock = true;
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.scheduler is manual or instant, got " + Json.show(scheduler));
            }
            List<String> viewList = new ArrayList<>();
            Json viewField = JsArgs.at(setup, "view");
            if (!JsArgs.isUndefined(viewField)) {
                if (viewField.asList() == null) throw new HarnessError("E_BAD_CASE", "setup.view is a list of view keys");
                for (Json key : viewField.asList()) {
                    String name = key.asString();
                    if (name == null || !VIEW_KEYS.contains(name)) {
                        throw new HarnessError("E_BAD_CASE", "unknown view key " + Json.show(key) + " (one of "
                                + String.join(", ", new TreeSet<>(VIEW_KEYS)) + ")");
                    }
                    if (name.equals("timersLive") && !manualClock) {
                        throw new HarnessError("E_BAD_CASE", "view \"timersLive\" needs setup.scheduler = \"manual\"");
                    }
                    viewList.add(name);
                }
            }
            view = viewList;
            pulseWired = JsArgs.isTrue(JsArgs.at(setup, "narrationTicks"));
            if (view.contains("narrationTicks") && !pulseWired) {
                throw new HarnessError("E_BAD_CASE", "view \"narrationTicks\" needs setup.narrationTicks = true");
            }
            Json tts = JsArgs.at(setup, "tts");
            if (JsArgs.isUndefined(tts) && engineTarget) {
                // reference-engine.js always wires fakeTts (`this.tts = fakeTts({log})`), so on the
                // engine target a spoken line is spoken without asking.
                narrator = new FakeNarrator(new Json.Obj(Map.of()));
            } else if (JsArgs.isNullish(tts) || (tts instanceof Json.Bool b && !b.value())) {
                narrator = null;
            } else if (tts instanceof Json.Bool) {
                narrator = new FakeNarrator(new Json.Obj(Map.of()));
            } else if (tts instanceof Json.Obj) {
                narrator = new FakeNarrator(tts);
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.tts is a boolean or an object");
            }
            Json interlude = JsArgs.at(setup, "interlude");
            if (JsArgs.isNullish(interlude) || (interlude instanceof Json.Bool b && !b.value())) {
                jingle = null;
            } else if (interlude instanceof Json.Bool) {
                jingle = new FakeJingle(false);
            } else if (interlude instanceof Json.Obj) {
                jingle = new FakeJingle(JsArgs.isTrue(JsArgs.at(interlude, "refuse")));
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.interlude is a boolean or an object");
            }
            seamGapEvents = JsArgs.isTrue(JsArgs.at(setup, "seamGapEvents"));
            this.caseId = caseId;
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
            double gapSec;
            if (JsArgs.isUndefined(gap)) {
                gapSec = SeamGap.DEFAULT_GAP_SEC;
            } else if (gap.asNumber() != null) {
                gapSec = gap.asNumber();
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.seamGapSec must be a number, got " + Json.show(gap));
            }
            String voice = JsArgs.at(setup, "voice").asString();
            boolean interludeEnabled = !(JsArgs.at(setup, "interludeEnabled") instanceof Json.Bool b && !b.value());
            core = new EngineCore(new EngineConfig("parity", SessionPolicy.HoldPolicy.DEFAULT, rate, tape, gapSec, false, false,
                    pulseWired, jingle != null, interludeEnabled, false, voice), positions);
            Json backend = JsArgs.at(setup, "backend");
            holdLoads = JsArgs.isTrue(JsArgs.at(backend, "holdLoads"));
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
            Json preview = JsArgs.at(setup, "preview");
            if (!JsArgs.isUndefined(preview)) {
                if (!(preview instanceof Json.Obj)) throw new HarnessError("E_BAD_CASE", "setup.preview is an object ({failUrls})");
                List<Json> urls = JsArgs.at(preview, "failUrls").asList();
                if (urls != null) {
                    for (Json url : urls) if (url.asString() != null) previewFailUrls.add(url.asString());
                }
            }
            Json prefetch = JsArgs.at(backend, "prefetch");
            if (JsArgs.isUndefined(prefetch) || isFalse(prefetch)) {
                prefetchLoses = null;
            } else if (prefetch instanceof Json.Bool) {
                prefetchLoses = false;
            } else if ("loses".equals(prefetch.asString())) {
                prefetchLoses = true;
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.backend.prefetch is true or \"loses\", got " + Json.show(prefetch));
            }
            if (prefetchLoses != null && engineTarget) {
                throw new HarnessError("E_BAD_CASE",
                        "setup.backend.prefetch is the manager target's; the engine target's standby deck always prepares");
            }
            Json cold = JsArgs.at(backend, "coldLoadMs");
            if (JsArgs.isUndefined(cold)) {
                coldLoadMs = 0;
            } else if (cold instanceof Json.Num n && Double.isFinite(n.value()) && n.value() > 0 && Math.rint(n.value()) == n.value()) {
                coldLoadMs = n.value();
            } else {
                throw new HarnessError("E_BAD_CASE", "setup.backend.coldLoadMs is a positive whole number of ms");
            }
            if (coldLoadMs > 0 && (!manualClock || engineTarget || holdLoads)) {
                throw new HarnessError("E_BAD_CASE",
                        "setup.backend.coldLoadMs needs the manager target on setup.scheduler = \"manual\", without holdLoads");
            }
            slowFirstPlay = JsArgs.isTrue(JsArgs.at(backend, "slowFirstPlay"));
            Set<String> events = new HashSet<>();
            Json names = JsArgs.at(setup, "telemetry");
            if (!JsArgs.isUndefined(names)) {
                if (names.asList() == null) throw new HarnessError("E_BAD_CASE", "setup.telemetry is a list of event names");
                for (Json name : names.asList()) {
                    String text = name.asString();
                    if (text == null || !TELEMETRY_EVENTS.contains(text)) {
                        throw new HarnessError("E_BAD_CASE", "setup.telemetry is a list of "
                                + String.join(", ", new TreeSet<>(TELEMETRY_EVENTS)));
                    }
                    events.add(text);
                }
            }
            telemetry = events;
            reading = new DeckReading(0.0, defaultDuration, false, false);
        }

        // ---- steps

        void step(String verb, Json.Obj step, Codec.Context context) {
            if (!manualClock) monoMs += STEP_MS;
            Map<String, Json> fields = step.fields();
            if (engineTarget) {
                engineStep(verb, fields, context);
                return;
            }
            switch (verb) {
                case "call" -> {
                    call(fields, context);
                    // JS awaits an ordinary call to its end; `await: false` leaves it in flight.
                    if (!isFalse(fields.get("await"))) settle();
                }
                case "settle" -> settle();
                case "clock" -> {
                    if (!manualClock) throw new HarnessError("E_BAD_CASE", "\"clock\" needs setup.scheduler = \"manual\"");
                    advance(fields.get("clock"), fields.get("every"));
                }
                case "deck" -> {
                    deck(fields);
                    settle();
                }
                case "tts" -> {
                    tts(fields);
                    settle();
                }
                case "interlude" -> {
                    interlude(fields);
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
                    if (!isFalse(fields.get("await"))) settle();
                }
                case "checkpoint" -> checkpoint(checkpointName(fields));
                default -> throw new HarnessError("E_UNKNOWN_VERB", "the \"" + verb + "\" verb has no JVM scenario driver");
            }
        }

        private static boolean isFalse(Json value) {
            return value instanceof Json.Bool b && !b.value();
        }

        private static String checkpointName(Map<String, Json> fields) {
            Json name = fields.get("checkpoint");
            if (name == null || name.asString() == null) throw new HarnessError("E_BAD_CASE", "a checkpoint needs a name");
            return name.asString();
        }

        /**
         * The synthesiser's own reports (runner.js {@code tts}): {@code finish} is
         * {@code didFinish} for the line it is speaking (only to a bridge that offers
         * {@code onFinished}); {@code silent} is the session taken from under the line.
         */
        private void tts(Map<String, Json> fields) {
            FakeNarrator fake = narrator;
            if (fake == null) throw new HarnessError("E_BAD_CASE", "\"tts\" needs setup.tts");
            String event = fields.get("tts") == null ? null : fields.get("tts").asString();
            if ("finish".equals(event)) {
                int seq = fake.current != null ? fake.current : 0;
                fake.word = NarratorReading.IDLE;
                narrationSpeaking = false;
                if (fake.onFinished) feed(narratorEnd(new EngineInput.NarratorEvent.Finished(seq)));
            } else if ("silent".equals(event)) {
                int seq = fake.current != null ? fake.current : 0;
                fake.word = NarratorReading.IDLE;
                narrationSpeaking = false;
                feed(narratorEnd(new EngineInput.NarratorEvent.Cancelled(seq)));
            } else if ("finishPrevious".equals(event)) {
                if (fake.previous == null) throw new HarnessError("E_BAD_CASE", "no earlier utterance to finish");
                feed(narratorEnd(new EngineInput.NarratorEvent.Finished(fake.previous)));
            } else if ("releasePause".equals(event)) {
                throw new HarnessError("E_BAD_CASE", "tts \"releasePause\" is refused: " + AWAIT_ONLY);
            } else {
                throw new HarnessError("E_BAD_CASE", "unknown tts event " + Json.show(fields.get("tts")) + " (finish, silent)");
            }
        }

        /** An end as the (possibly broken) synthesiser reports it. */
        private EngineInput narratorEnd(EngineInput.NarratorEvent event) {
            if (mutation == Mutation.CANCEL_AS_FINISHED && event instanceof EngineInput.NarratorEvent.Cancelled c) {
                return new EngineInput.Narrator(new EngineInput.NarratorEvent.Finished(c.seq()));
            }
            if (mutation == Mutation.FINISHED_CLAIMS_CURRENT_LINE && event instanceof EngineInput.NarratorEvent.Finished) {
                EngineState.SpokenLine line = core.state().narration;
                return new EngineInput.Narrator(new EngineInput.NarratorEvent.Finished(line == null ? 0 : line.seq));
            }
            return new EngineInput.Narrator(event);
        }

        /** The jingle reporting its own end (runner.js {@code interlude: "end"}). */
        private void interlude(Map<String, Json> fields) {
            FakeJingle fake = jingle;
            if (fake == null) throw new HarnessError("E_BAD_CASE", "\"interlude\" needs setup.interlude");
            if (!"end".equals(fields.get("interlude") == null ? null : fields.get("interlude").asString())) {
                throw new HarnessError("E_BAD_CASE", "unknown interlude event " + Json.show(fields.get("interlude")));
            }
            if (!fake.active) return;
            Json rawReason = fields.get("reason");
            String reason = rawReason != null && rawReason.asString() != null ? rawReason.asString() : "ended";
            fake.active = false;
            ops.add("interlude.ended:" + reason);
            trackAudible();
            feed(new EngineInput.Interlude(new EngineInput.InterludeEvent.Ended(reason)));
        }

        private void call(Map<String, Json> fields, Codec.Context context) {
            Json rawName = fields.get("call");
            String name = rawName == null ? null : rawName.asString();
            if (name == null) throw new HarnessError("E_BAD_CASE", "a call step needs a name");
            Json expanded = Codec.expandInputs(fields.containsKey("args") ? fields.get("args") : new Json.Arr(List.of()), context);
            List<Json> args = expanded.asList();
            if (args == null) throw new HarnessError("E_BAD_CASE", "a call's args must be an array");
            if (fields.containsKey("returns") && !(forayTape && (name.equals("playForay") || name.equals("setQueueFromForay")))) {
                throw new HarnessError("E_BAD_CASE", "only a Foray's build report can be recorded (returns: forayReport)");
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
                    feed(new EngineInput.Queue(new EngineInput.QueueInput.SetRate(JsArgs.arg(args, 0).asNumber())));
                }
                case "setVoice" -> feed(new EngineInput.Command(new EngineContract.Command.SetVoice(JsArgs.arg(args, 0).asString()), tap));
                case "setInterludeEnabled" -> {
                    // `on !== false`.
                    boolean on = !isFalse(JsArgs.arg(args, 0));
                    feed(new EngineInput.Command(new EngineContract.Command.SetInterludeEnabled(on), tap));
                }
                case "dispose" -> {
                    // The page tearing the player down; natively the engine's own teardown.
                    disposing = true;
                    feed(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Teardown()));
                    disposing = false;
                }
                case "playForay", "setQueueFromForay" -> {
                    if (forayTape) {
                        // The PAGE's build (the engine never builds a Foray, plan §3 A-1).
                        ScenarioBuilds.Build build = forayBuild(context);
                        feed(new EngineInput.Queue(new EngineInput.QueueInput.LoadForay(build.items(), build.isLocalFile(),
                                build.allowAdPad())));
                        if (name.equals("playForay") && !build.items().isEmpty()) {
                            feed(new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(0, null, tap)));
                        }
                        Json projection = fields.get("returns");
                        if (projection != null) {
                            if (!"forayReport".equals(projection.asString())) {
                                throw new HarnessError("E_BAD_CASE", "unknown returns projection " + Json.show(projection) + " (one of forayReport)");
                            }
                            if (isFalse(fields.get("await"))) {
                                throw new HarnessError("E_BAD_CASE", "a call that records what it returns must be awaited");
                            }
                            returned.add(build.report());
                        }
                    } else {
                        // Without the Foray tape: the page-built queue, loaded (and started, for playForay).
                        feed(new EngineInput.Queue(new EngineInput.QueueInput.Load(forayQueue(JsArgs.arg(args, 0)))));
                        if (name.equals("playForay")) feed(new EngineInput.Queue(new EngineInput.QueueInput.PlayIndex(0, null, tap)));
                    }
                }
                default -> throw new HarnessError("E_UNKNOWN_EXPORT", "\"" + name + "\" is not a manager call the JVM scenario driver makes");
            }
        }

        /**
         * A lock-screen, car or headset press (runner.js {@code remote}): through the SAME
         * table the page's does ({@link MediaMapping#intent}), then into the core's remote
         * handlers as the command it stands for.
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
            String event = fields.get("deck") == null ? null : fields.get("deck").asString();
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
                    reading.audible = !isFalse(fields.get("audible"));
                    trackAudible();
                }
                case "observedPause" -> {
                    reading.audible = false;
                    feed(new EngineInput.Deck(new DeckEvent.PausedUncommanded(token, reading.positionSec != null ? reading.positionSec : 0)));
                }
                case "window" -> {
                    // A-63 (NE-39s): FakeBackend `openPrefetchWindow` (only a backend with the
                    // prefetch contract has one): the deck's playhead watch reaching the prefetch
                    // lead. Whether anything is warmed is the core's call.
                    if (prefetchLoses == null) throw new HarnessError("E_BAD_CASE", "deck \"window\" needs setup.backend.prefetch");
                    if (deckToken != null) feed(new EngineInput.Deck(new DeckEvent.PrepareWindow(deckToken)));
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
            String event = fields.get("session") == null ? null : fields.get("session").asString();
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
                    // No fixture names a port: the JS lanes never resume on a reconnect, and this
                    // driver's EngineNow has no route, so no route ever becomes known here (route
                    // resume is the route-resume family's, A-61; the Swift driver since NE-38rs).
                    Json portType = fields.get("portType");
                    Json portUID = fields.get("portUID");
                    feed(new EngineInput.Session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(
                            event.equals("routeLost"), portType == null ? null : portType.asString(),
                            portUID == null ? null : portUID.asString()))));
                }
                case "mediaServicesReset" -> feed(new EngineInput.Session(new EngineInput.SessionEvent.MediaServicesReset()));
                default -> throw new HarnessError("E_BAD_CASE", "unknown session event \"" + event + "\"");
            }
        }

        private void lifecycle(Map<String, Json> fields, Codec.Context context) {
            String event = fields.get("lifecycle") == null ? null : fields.get("lifecycle").asString();
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

        /**
         * {@code clock: ms} on the manual scheduler ({@code advance}): move the clock, run what
         * came due, in due order, then settle. {@code every} moves it in steps of that many ms,
         * as an AWAKE page's timers fire; one jump is a suspended page.
         */
        private void advance(Json value, Json every) {
            Double ms = value == null ? null : value.asNumber();
            if (ms == null || !Double.isFinite(ms) || ms < 0 || Math.rint(ms) != ms) {
                throw new HarnessError("E_BAD_CASE", "clock takes whole milliseconds");
            }
            if (every == null) {
                advanceOnce(ms);
                return;
            }
            Double step = every.asNumber();
            if (step == null || !Double.isFinite(step) || step <= 0 || Math.rint(step) != step || ms % step != 0) {
                throw new HarnessError("E_BAD_CASE", "clock with `every` takes whole ms, a multiple of `every`");
            }
            double moved = 0;
            while (moved < ms) {
                advanceOnce(step);
                moved += step;
            }
        }

        private void advanceOnce(double ms) {
            monoMs += ms;
            // `manualScheduler.advance`: what is due NOW, in due order; a timer re-armed while
            // these run is due later and waits for the next move.
            List<Map.Entry<EngineTimer, Double>> due = new ArrayList<>();
            for (Map.Entry<EngineTimer, Double> e : timerDue.entrySet()) {
                if ((SCHEDULER_TIMERS.contains(e.getKey()) || e.getKey() == EngineTimer.SILENCE_CAP) && e.getValue() <= monoMs) {
                    due.add(Map.entry(e.getKey(), e.getValue()));
                }
            }
            due.sort((a, b) -> Double.compare(a.getValue(), b.getValue()));
            for (Map.Entry<EngineTimer, Double> e : due) {
                Double current = timerDue.get(e.getKey());
                if (current == null || !current.equals(e.getValue())) continue;
                timerDue.remove(e.getKey());
                feed(new EngineInput.Timer(e.getKey()));
            }
            Double until = core.state().gapUntilMono;
            if (!deferredLoads.isEmpty() && until != null && monoMs >= until) {
                List<DeckCommand> withheld = new ArrayList<>(deferredLoads);
                deferredLoads.clear();
                for (DeckCommand command : withheld) applyDeck(command);
            }
            // A-63 (NE-39s): the cold loads whose cost the clock has now paid land, in due order
            // (FakeBackend's awaited `schedule(coldLoadMs)`).
            List<ColdLoad> landing = new ArrayList<>();
            for (ColdLoad c : coldLoads) if (c.dueMs() <= monoMs) landing.add(c);
            coldLoads.removeAll(landing);
            landing.sort((a, b) -> Double.compare(a.dueMs(), b.dueMs()));
            for (ColdLoad c : landing) loadDeck(c.command());
            settle();
        }

        // ---- the engine target (runner.js `runEngineScenario`)

        private void engineStep(String verb, Map<String, Json> fields, Codec.Context context) {
            switch (verb) {
                case "call" -> engineCall(fields, context);
                case "deck" -> {
                    engineDeck(fields);
                    settle();
                }
                case "clock" -> advance(fields.get("clock"), null);
                case "settle" -> settle();
                case "checkpoint" -> checkpoint(checkpointName(fields));
                default -> throw new HarnessError("E_BAD_CASE",
                        "the engine target takes call, deck, clock, settle and checkpoint steps, not \"" + verb + "\"");
            }
        }

        /**
         * An engine COMMAND: {@code {call: "<cmd>", args?, source?, refused?}} sent as the
         * engineSend payload the page sends, decoded by the contract, and answered (the reply's
         * refusal, if any) before the next step. A {@code playForay}'s items are the page's BUILD.
         */
        private void engineCall(Map<String, Json> fields, Codec.Context context) {
            Json rawName = fields.get("call");
            String name = rawName == null ? null : rawName.asString();
            if (name == null) throw new HarnessError("E_BAD_CASE", "a call step needs a name");
            cmdSeq += 1;
            Json rawSource = fields.get("source");
            String source = rawSource != null && rawSource.asString() != null ? rawSource.asString() : "tap";
            List<JsonNode.Member> members = new ArrayList<>();
            members.add(JsonNode.member("v", JsonNode.num(EngineContract.PROTOCOL_VERSION)));
            members.add(JsonNode.member("cmdSeq", JsonNode.num(cmdSeq)));
            members.add(JsonNode.member("cmd", JsonNode.str(name)));
            members.add(JsonNode.member("source", JsonNode.str(source)));
            refusals.clear();
            String refusedBeforeSend = null;
            if (fields.containsKey("args")) {
                JsonNode args = node(Codec.expandInputs(fields.get("args"), context));
                if (name.equals("playForay") && forayTape) {
                    ScenarioBuilds.Build build = forayBuild(context);
                    if (build.items().isEmpty()) {
                        // reference-engine.js: nothing playable is refused-structure.
                        refusedBeforeSend = EngineContract.Refusal.REFUSED_STRUCTURE.token;
                    } else {
                        List<JsonNode> nodes = new ArrayList<>();
                        for (EngineItem item : build.items()) nodes.add(item.node);
                        args = replacing("items", args, new JsonNode.Arr(nodes));
                    }
                }
                members.add(JsonNode.member("args", args));
            }
            if (refusedBeforeSend != null) {
                refusals.add(refusedBeforeSend);
            } else {
                ContractDecoding.SendRequest request;
                try {
                    request = ContractDecoding.SendRequest.decode(new JsonNode.Obj(members));
                } catch (ContractDecoding.ContractError e) {
                    throw new HarnessError("E_BAD_CASE", "engine " + name + " is not a contract command: " + e.getMessage());
                }
                feed(new EngineInput.Command(request.command(), request.source()));
                settle();
            }
            Json rawWant = fields.get("refused");
            String want = rawWant == null ? null : rawWant.asString();
            String got = refusals.isEmpty() ? null : refusals.get(0);
            if (!java.util.Objects.equals(got, want)) {
                throw new HarnessError("E_BAD_CASE", "engine " + name + " answered " + (got == null ? "ok" : got) + ", the step expects "
                        + (want == null ? "ok" : want));
            }
        }

        /** The engine's deck events (runner.js {@code ENGINE_DECK_EVENTS}). */
        private void engineDeck(Map<String, Json> fields) {
            String event = fields.get("deck") == null ? null : fields.get("deck").asString();
            if (event == null) throw new HarnessError("E_BAD_CASE", "a deck step needs an event");
            switch (event) {
                case "ended", "error", "time", "duration" -> deck(fields);
                case "window" -> {
                    // WarmingBackend `openPrefetchWindow`: an audible deck with a boundary to
                    // approach: an out-point or, for an item with none (a rendered line, an
                    // episode's natural end), its duration (NE-45j).
                    boolean hasDuration = reading.durationSec != null && Double.isFinite(reading.durationSec) && reading.durationSec > 0;
                    if ((deckOutPoint != null || hasDuration) && reading.audible && deckToken != null) {
                        feed(new EngineInput.Deck(new DeckEvent.PrepareWindow(deckToken)));
                    }
                }
                case "stall" -> {
                    if (deckToken != null) feed(new EngineInput.Deck(new DeckEvent.Stalled(deckToken)));
                }
                case "flowing" -> {
                    if (deckToken != null) {
                        feed(new EngineInput.Deck(new DeckEvent.TimeControl(deckToken, DeckEvent.TimeControlStatus.PLAYING, null)));
                    }
                }
                default -> throw new HarnessError("E_BAD_CASE", "unknown engine deck event \"" + event
                        + "\" (one of ended, error, time, duration, window, stall, flowing)");
            }
        }

        /** This step's page build: the test's own, else the table's. */
        private ScenarioBuilds.Build forayBuild(Codec.Context context) {
            List<JsonNode> nodes = inlineBuilds.get(stepIndex);
            if (nodes != null) return ScenarioBuilds.build(caseId + "@" + stepIndex, nodes, false, false, 0, new Json.Arr(List.of()));
            return ScenarioBuilds.build(caseId, stepIndex, context);
        }

        /** {@code object} with {@code key} replaced (or appended). */
        static JsonNode replacing(String key, JsonNode object, JsonNode value) {
            if (!(object instanceof JsonNode.Obj o)) return object;
            List<JsonNode.Member> members = new ArrayList<>(o.members());
            int at = -1;
            for (int i = 0; i < members.size(); i++) {
                if (members.get(i).key().equals(key)) {
                    at = i;
                    break;
                }
            }
            if (at >= 0) {
                members.set(at, JsonNode.member(key, value));
            } else {
                members.add(JsonNode.member(key, value));
            }
            return new JsonNode.Obj(members);
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
         * it can build faithfully, plain segments of catalogue rows with no ad-drift check.
         * With the tape a Foray is the page's build (scenario-builds.json).
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
            // The synthesiser's `state()`, only from a bridge that answers it.
            NarratorReading word = narrator != null && narrator.stateful ? narrator.word : NarratorReading.UNKNOWN;
            return new EngineNow(WALL_MS, monoMs, reading, null, word);
        }

        /**
         * One turn: the input, then (as the host does, before anything else) the answer to
         * any activation it asked for. The audible-start rule is checked over the whole turn,
         * from the session the turn began with.
         */
        void feed(EngineInput input) {
            SessionPolicy.Phase entry = core.state().session;
            runningAtEntry = core.state().isRunning();
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
            // WarmingBackend `_windowAtStart`: a play that found its item already inside the window
            // opens it, once per load, as its own event.
            if (windowAtStart != null) {
                int token = windowAtStart;
                windowAtStart = null;
                feed(new EngineInput.Deck(new DeckEvent.PrepareWindow(token)));
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
                case SILENCE_WHILE_NOT_RUNNING -> {
                    if (turnHead && !runningAtEntry) changed.add(new EngineCommand.SilenceStart(Interlude.CEILING_SEC * 1000));
                    changed.addAll(output);
                }
                case WARM_BY_THE_BEAT -> {
                    EngineState st = core.state();
                    for (EngineCommand command : output) {
                        if (command instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Prepare p) {
                            EngineItem from = st.currentItem();
                            EngineItem to = null;
                            for (EngineItem it : st.queue) if (it.id.equals(p.itemId())) to = it;
                            boolean beat = st.player instanceof PlayerQueueState.Playing && from != null && to != null
                                    && SeamGap.gapSec(from.seam(), to.seam(), to.kind == ai.jwlabs.foura.engine.PlayerItemKind.TTS,
                                            SeamGap.AUTO_ADVANCE, core.config().seamGapSec()) > 0;
                            if (!beat) continue;
                        }
                        changed.add(command);
                    }
                }
                case LOAD_AFTER_BEAT, CANCEL_AS_FINISHED, FINISHED_CLAIMS_CURRENT_LINE -> changed.addAll(output);
            }
            return changed;
        }

        /**
         * A native-only token: logged for the report (and stripped by the comparator) on the
         * manager target; the engine target's op log is the deck's and the standby deck's only.
         */
        private void nativeOp(String token) {
            if (!engineTarget) ops.add(token);
        }

        /** Interpret the core's commands in the fake world, logging each one. */
        private void apply(List<EngineCommand> output, List<String> names) {
            for (EngineCommand command : output) {
                commands.add(command);
                names.add(EngineCommand.turnName(command));
                switch (command) {
                    case EngineCommand.Deck d -> {
                        if (mutation == Mutation.LOAD_AFTER_BEAT && d.command() instanceof DeckCommand.Load && core.state().inSeamGap()) {
                            deferredLoads.add(d.command());
                        } else {
                            applyDeck(d.command());
                        }
                    }
                    case EngineCommand.WritePosition w -> {
                        if (!engineTarget) {
                            ops.add(positionEvents ? "store.set:" + w.write().row().key()
                                    : "store.save:" + w.write().itemId() + "@" + rounded(w.write().seconds()));
                        }
                    }
                    case EngineCommand.AppendEvent e -> {
                        EngineCommand.PendingEvent event = e.event();
                        String text = "event.position:" + event.episodeId() + "@" + number(event.seconds()) + ":"
                                + (event.duration() == null ? "null" : number(event.duration()));
                        if (positionEvents && !engineTarget) {
                            ops.add(text);
                        } else {
                            nativeOp("n." + text);
                        }
                    }
                    case EngineCommand.SessionActivate a -> nativeOp("n.session.activate:" + a.requestId());
                    case EngineCommand.SessionDeactivate d -> nativeOp(d.notifyOthers() ? "n.session.deactivate:notify" : "n.session.deactivate");
                    case EngineCommand.SessionReapplyCategory c -> nativeOp("n.session.category");
                    case EngineCommand.SessionRebuild c -> nativeOp("n.session.rebuild");
                    case EngineCommand.GraceBegin g -> {
                        if (graceHeld != null) broke("grace-begun-twice:" + graceHeld.token);
                        graceHeld = g.reason();
                        nativeOp("n.grace.begin:" + g.reason().token);
                    }
                    case EngineCommand.GraceEnd g -> {
                        if (graceHeld == null) broke("grace-end-without-begin:" + g.outcome().token);
                        graceHeld = null;
                        nativeOp("n.grace.end:" + g.outcome().token);
                    }
                    case EngineCommand.TimerArm t -> {
                        timerDue.put(t.timer(), monoMs + t.afterMs());
                        nativeOp("n.timer.arm:" + t.timer().token);
                    }
                    case EngineCommand.TimerCancel t -> {
                        timerDue.remove(t.timer());
                        nativeOp("n.timer.cancel:" + t.timer().token);
                    }
                    case EngineCommand.WriteRow r -> nativeOp("n.row:" + r.row().key());
                    case EngineCommand.WriteRestore r -> nativeOp("n.restore:" + (r.record() == null ? "removed" : r.record().mode().token));
                    case EngineCommand.Speak s -> {
                        // The audition (OQ-5): the synthesiser's own op, at the speed narration
                        // speaks at (`NARRATION_RATE`), as tts.speak logs it.
                        auditionSpeaking = true;
                        trackAudible();
                        ops.add(speakOp(s.text(), EngineConstants.QueueManager.NARRATION_RATE, s.voiceId()));
                    }
                    case EngineCommand.Preview p -> applyPreview(p.command());
                    case EngineCommand.Narration n -> applyNarration(n.command());
                    case EngineCommand.Interlude i -> applyInterlude(i.command());
                    case EngineCommand.SilenceStart s -> {
                        // NE-34's rule: never while the transport is not running.
                        if (!core.state().isRunning()) broke("silence-not-running");
                        if (s.capMs() > Interlude.CEILING_SEC * 1000) broke("silence-over-the-cap");
                        silenceOn = true;
                        nativeOp("n.silence.start:" + number(s.capMs()));
                    }
                    case EngineCommand.SilenceStop s -> {
                        silenceOn = false;
                        nativeOp("n.silence.stop");
                    }
                    // The surface's `onNarrationTick`, counted, not logged: a repaint is not an act.
                    case EngineCommand.NarrationPulse p -> pulses += 1;
                    case EngineCommand.Emit e -> {
                        switch (e.event()) {
                            case EngineCommand.EngineEvent.Advanced a -> nativeOp("n.emit:advanced");
                            case EngineCommand.EngineEvent.Error err -> nativeOp("n.emit:error:" + err.code());
                            case EngineCommand.EngineEvent.Skipped s -> nativeOp("n.emit:skipped");
                        }
                    }
                    case EngineCommand.Diag d -> {
                        JsonNode kindField = d.entry().field("kind");
                        String sub = kindField == null ? null : kindField.stringValue();
                        if (d.entry().kind().equals("rate") && "snapped".equals(sub) && telemetry.contains("rate.snapped") && !engineTarget) {
                            // The manager's `rate.snapped requested=<JSON> applied=<r>`.
                            JsonNode applied = d.entry().field("applied");
                            Double value = applied == null ? null : applied.numberValue();
                            ops.add("telemetry:rate.snapped requested=" + jsonStringify(lastRateArg) + " applied="
                                    + (value == null ? "null" : number(value)));
                        } else if (d.entry().kind().equals("beat") && seamGapEvents && !engineTarget && ("begin".equals(sub) || "end".equals(sub))) {
                            // The surface's beat callback (`onSeamGapChange`), as an op.
                            ops.add("event.seamGap:" + "begin".equals(sub));
                        } else {
                            JsonNode cause = d.entry().field("cause");
                            String suffix = cause != null && cause.stringValue() != null ? ":" + cause.stringValue() : "";
                            nativeOp("n.diag:" + d.entry().kind() + suffix);
                        }
                    }
                    case EngineCommand.CommandFailed f -> {
                        refusals.add(f.reason());
                        nativeOp("n.failed:" + f.reason());
                    }
                }
            }
        }

        /** FakeBackend, command by command (and, on the engine target, WarmingBackend's standby deck). */
        void applyDeck(DeckCommand command) {
            if (command instanceof DeckCommand.Load load && !engineTarget && (prefetchLoses != null || coldLoadMs > 0)) {
                // A-63 (NE-39s): FakeBackend `load`: a warm key is spent; a cold load waits its cost
                // on the clock before it re-points the element (and logs).
                boolean warm = warmed.remove(load.itemId() + "@" + rounded(load.startSec()));
                if (!warm && coldLoadMs > 0) {
                    coldLoads.add(new ColdLoad(command, monoMs + coldLoadMs));
                    return;
                }
            }
            loadDeck(command);
        }

        /** FakeBackend, command by command, once a load is due to re-point it. */
        private void loadDeck(DeckCommand command) {
            switch (command) {
                case DeckCommand.Load load -> {
                    if (engineTarget) {
                        // `warmPromotion` at the boundary: a load that finds its source and in-point
                        // warm is a handover, said BEFORE the load.
                        double offset = JSMath.round(DeckPolicy.warmOffset(load.startSec()));
                        DeckPolicy.Promotion promotion = DeckPolicy.warmPromotion(warm, load.url(), offset, true, offset);
                        if (promotion == DeckPolicy.Promotion.PROMOTE) {
                            ops.add("n.handover:" + load.itemId() + "@" + number(offset));
                            // The roles swap: the outgoing deck, and what it holds, is the standby
                            // now (`handoverSteps` keeps the buffer).
                            standbyUrl = currentUrl;
                        }
                        warm = null;
                        currentUrl = load.url();
                        loadCount += 1;
                    }
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
                    if (engineTarget) checkWindowAtStart();
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
                case DeckCommand.SetRate r -> {
                    if (Double.isFinite(r.rate()) && r.rate() > 0) deckRate = r.rate();
                    ops.add("rate:" + number(r.rate()));
                }
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
                    if (disposing && !engineTarget) {
                        ops.add("release");
                    } else {
                        nativeOp("n.deck.unload");
                    }
                }
                case DeckCommand.Prepare p -> {
                    if (!engineTarget && prefetchLoses != null) {
                        // A-63 (NE-39s): the manager's ASK (FakeBackend `prefetch`).
                        String key = p.itemId() + "@" + rounded(p.startSec());
                        ops.add("prefetch:" + key);
                        if (!prefetchLoses) warmed.add(key);
                        return;
                    }
                    if (!engineTarget) {
                        nativeOp("n.deck.prepare:" + p.itemId());
                        return;
                    }
                    // WarmingBackend `prefetch`: the standby deck's own decision.
                    double offset = JSMath.round(DeckPolicy.warmOffset(p.startSec()));
                    switch (DeckPolicy.prefetchDecision(true, p.url(), currentUrl, warm, offset)) {
                        case ALREADY -> {
                            if (warm != null) warm = new DeckPolicy.Warm(p.itemId(), warm.url(), warm.offsetSec(), warm.ready(), warm.failed());
                        }
                        case START -> {
                            // NE-45j: preparing the source the standby already holds is a
                            // same-source SEEK there (ExoDeck's reuse, AVDeck `sameSourceIsSeek`),
                            // not a fetch.
                            boolean seek = standbyUrl != null && standbyUrl.equals(p.url());
                            warm = new DeckPolicy.Warm(p.itemId(), p.url() == null ? "" : p.url(), offset, true, false);
                            standbyUrl = p.url();
                            ops.add((seek ? "n.prepare-seek:" : "n.prepare:") + p.itemId() + "@" + number(offset));
                        }
                        default -> {}
                    }
                }
            }
        }

        /**
         * WarmingBackend {@code _windowAtStart}, at a play: once per load, an item already inside its
         * window (shorter than the lead, or started within it) opens it now. Fed when this turn is
         * over ({@link #feed}).
         */
        private void checkWindowAtStart() {
            if (windowCheckedFor != null && windowCheckedFor == loadCount) return;
            windowCheckedFor = loadCount;
            boolean opens = DeckPolicy.prefetchWindowOpens(true, deckOutPoint, deckOutPoint != null, false,
                    reading.positionSec != null ? reading.positionSec : 0, deckRate,
                    EngineConstants.HtmlAudioBackend.PREFETCH_LEAD_SEC, false, reading.durationSec);
            if (opens && deckToken != null) windowAtStart = deckToken;
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
         * Everything in flight that the JS fakes would resolve before the next step: the fakes'
         * answers, instant loads in issue order, then (on the instant scheduler) the seam beat's
         * timer, then each started deck saying {@code playing}.
         */
        void settle() {
            int budget = 256;
            while (budget > 0) {
                budget -= 1;
                if (!answers.isEmpty()) {
                    feed(answers.remove(0));
                    continue;
                }
                if (!instantLoads.isEmpty()) {
                    Load next = instantLoads.remove(0);
                    land(next.token(), next.itemId(), failLoadFor.contains(next.itemId()));
                    continue;
                }
                if (!manualClock && timerDue.containsKey(EngineTimer.SEAM_BEAT)) {
                    timerDue.remove(EngineTimer.SEAM_BEAT);
                    feed(new EngineInput.Timer(EngineTimer.SEAM_BEAT));
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

        /**
         * The preview deck (NE-47, A-66; fakes.js {@code fakePreview}), command by command. A load
         * answers at once, ready or failed ({@code setup.preview.failUrls}), when the step settles,
         * as the JS fake's awaited load resolves; a play is only ever for the load that answered
         * ready.
         */
        private void applyPreview(DeckCommand command) {
            switch (command) {
                case DeckCommand.Load load -> {
                    String target = load.url() == null ? "" : load.url();
                    previewToken = load.token();
                    previewReadyToken = null;
                    previewAudible = false;
                    ops.add("preview.load:" + target);
                    if (previewFailUrls.contains(target)) {
                        answers.add(new EngineInput.Preview(new DeckEvent.Failed(load.token(), "preview did not load")));
                    } else {
                        previewReadyToken = load.token();
                        answers.add(new EngineInput.Preview(new DeckEvent.Ready(load.token(), 0, true, 0)));
                    }
                }
                case DeckCommand.Play p -> {
                    if (previewToken == null || !previewToken.equals(previewReadyToken)) broke("preview-play-before-ready");
                    previewAudible = true;
                    trackAudible();
                    ops.add("preview.play");
                }
                case DeckCommand.Unload u -> {
                    previewToken = null;
                    previewReadyToken = null;
                    previewAudible = false;
                    ops.add("preview.stop");
                }
                default -> nativeOp("n.preview." + EngineCommand.turnName(new EngineCommand.Deck(command)));
            }
        }

        private void trackAudible() {
            int sources = (reading.audible ? 1 : 0) + (auditionSpeaking ? 1 : 0) + (narrationSpeaking ? 1 : 0)
                    + (previewAudible ? 1 : 0)
                    + (jingle != null && jingle.active ? 1 : 0);
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
            fields.put("inInterlude", Json.bool(state.inInterlude));
            fields.put("inSeamGap", Json.bool(state.inSeamGap()));
            fields.put("playhead", state.loadedId == null ? Json.NULL : Json.str(state.loadedId));
            fields.put("rate", Json.num(state.rate));
            fields.put("state", Json.str(state.stateType()));
            if (engineTarget) fields.put("nowMs", Json.num(monoMs));
            for (String key : view) {
                switch (key) {
                    case "outPoint" -> fields.put(key, deckOutPoint == null ? Json.NULL : Json.num(deckOutPoint));
                    case "seamGapRemainingMs" -> fields.put(key, Json.num(core.seamGapRemainingMs(monoMs)));
                    case "timersLive" -> {
                        int live = 0;
                        for (EngineTimer timer : timerDue.keySet()) if (SCHEDULER_TIMERS.contains(timer)) live += 1;
                        fields.put(key, Json.num(live));
                    }
                    case "positionSec" -> fields.put(key, Json.num(reading.positionSec != null ? reading.positionSec : 0));
                    case "narrationSec" -> {
                        Double sec = core.narrationElapsedSec(monoMs);
                        fields.put(key, sec == null ? Json.NULL : Json.num(sec));
                    }
                    case "narrationPlayhead" -> fields.put(key, Json.bool(state.isNarrationPlayhead()));
                    case "narrationTicks" -> fields.put(key, Json.num(pulses));
                    case "lastVoiceFallback" -> fields.put(key, state.lastVoiceFallback == null ? Json.NULL : Json.bool(state.lastVoiceFallback));
                    case "wasPlaying" -> fields.put(key, state.player instanceof PlayerQueueState.Interrupted i
                            ? Json.bool(i.wasPlaying()) : Json.NULL);
                    case "positionTimer" -> fields.put(key, Json.bool(state.positionTimerArmed));
                    default -> throw new HarnessError("E_BAD_CASE", "unknown view key " + key);
                }
            }
            if (!returned.isEmpty()) fields.put("returned", new Json.Arr(returned));
            returned.clear();
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

        /** {@code tts.speak:<text>@<rate>[:<voice>]}, fakes.js {@code fakeTts.speak}. */
        static String speakOp(String text, double rate, String voiceId) {
            return "tts.speak:" + text + "@" + number(rate) + (voiceId == null ? "" : ":" + voiceId);
        }

        /**
         * The synthesiser (fakes.js {@code fakeTts}), command by command. A bridge with no
         * transport logs nothing for pause/resume/stop and answers a resume with nothing;
         * natively a stop or a drop is followed by {@code didCancel}.
         */
        private void applyNarration(EngineCommand.NarrationCommand command) {
            FakeNarrator fake = narrator;
            if (fake == null) {
                // No synthesiser wired: a line cannot be spoken (`_speakNarration` throws), and
                // there is nothing to pause or stop.
                if (command instanceof EngineCommand.NarrationCommand.Speak s) {
                    answers.add(new EngineInput.Narrator(new EngineInput.NarratorEvent.Failed(s.seq(), "no on-device TTS plugin wired")));
                }
                return;
            }
            switch (command) {
                case EngineCommand.NarrationCommand.Speak s -> {
                    ops.add(speakOp(s.text(), s.utteranceRate(), s.voiceId()));
                    if (fake.refuse) {
                        answers.add(new EngineInput.Narrator(new EngineInput.NarratorEvent.Failed(s.seq(), "refused")));
                    } else {
                        if (fake.current != null) fake.previous = fake.current;
                        fake.current = s.seq();
                        fake.word = NarratorReading.SPEAKING;
                        narrationSpeaking = true;
                        answers.add(new EngineInput.Narrator(new EngineInput.NarratorEvent.Started(s.seq(), fake.voiceFallback)));
                    }
                }
                case EngineCommand.NarrationCommand.Pause p -> {
                    if (fake.transport) {
                        ops.add("tts.pause");
                        if (!fake.pauseRejects && fake.word == NarratorReading.SPEAKING) fake.word = NarratorReading.PAUSED;
                        if (!fake.pauseRejects) narrationSpeaking = false;
                    }
                }
                case EngineCommand.NarrationCommand.Resume r -> {
                    if (!fake.transport) {
                        answers.add(new EngineInput.Narrator(new EngineInput.NarratorEvent.Resumed(r.seq(),
                                EngineInput.NarrationResumeAnswer.NO_ANSWER)));
                    } else {
                        ops.add("tts.resume");
                        EngineInput.NarrationResumeAnswer answer;
                        if (fake.resumeAnswer != null) {
                            if (JsArgs.isTrue(JsArgs.at(fake.resumeAnswer, "accepted"))) {
                                fake.word = NarratorReading.SPEAKING;
                                answer = JsArgs.isTrue(JsArgs.at(fake.resumeAnswer, "fromStart"))
                                        ? EngineInput.NarrationResumeAnswer.FROM_START : EngineInput.NarrationResumeAnswer.CONTINUED;
                            } else {
                                String reason = JsArgs.at(fake.resumeAnswer, "reason").asString();
                                answer = new EngineInput.NarrationResumeAnswer.Refused(reason == null ? "?" : reason);
                            }
                        } else {
                            if (fake.word == NarratorReading.PAUSED) fake.word = NarratorReading.SPEAKING;
                            answer = EngineInput.NarrationResumeAnswer.CONTINUED;
                        }
                        if (!(answer instanceof EngineInput.NarrationResumeAnswer.Refused)) narrationSpeaking = true;
                        answers.add(new EngineInput.Narrator(new EngineInput.NarratorEvent.Resumed(r.seq(), answer)));
                    }
                }
                case EngineCommand.NarrationCommand.Stop s -> {
                    if (fake.transport) {
                        ops.add("tts.stop");
                        fake.word = NarratorReading.IDLE;
                        narrationSpeaking = false;
                        answers.add(narratorEnd(new EngineInput.NarratorEvent.Cancelled(s.seq())));
                    }
                }
                case EngineCommand.NarrationCommand.Discard d -> {
                    nativeOp("n.narration.discard");
                    if (fake.current != null && fake.current == d.seq()) {
                        fake.word = NarratorReading.IDLE;
                        narrationSpeaking = false;
                    }
                }
            }
            trackAudible();
        }

        /** The jingle player (fakes.js {@code fakeInterlude}). */
        private void applyInterlude(EngineCommand.InterludeCommand command) {
            FakeJingle fake = jingle;
            if (fake == null) {
                broke("interlude-without-a-player");
                return;
            }
            switch (command) {
                case START -> {
                    if (fake.refuse || fake.active) {
                        ops.add("interlude.refused");
                        // A refused `start()` is the jingle's end, in the same breath.
                        answers.add(new EngineInput.Interlude(new EngineInput.InterludeEvent.Ended("refused")));
                    } else {
                        fake.active = true;
                        ops.add("interlude.start");
                    }
                }
                case STOP -> {
                    if (fake.active) ops.add("interlude.stop");
                    fake.active = false;
                }
                case RELEASE -> ops.add("interlude.release");
            }
            trackAudible();
        }

        /** FakeBackend's {@code r(s) = Math.round(s)}, printed as JS prints a number. */
        static String rounded(double seconds) {
            return number(JSMath.round(seconds));
        }

        /** {@code `${n}`}: ECMAScript Number::toString. */
        static String number(double value) {
            return JSWriter.numberToString(value);
        }

        /**
         * {@code JSON.stringify(v)} for the scalars a {@code setRate} is handed (a template literal
         * prints {@code undefined} for an absent one).
         */
        static String jsonStringify(Json value) {
            return switch (value) {
                case Json.Undefined u -> "undefined";
                case Json.Null n -> "null";
                case Json.Bool b -> b.value() ? "true" : "false";
                case Json.Num n -> Double.isFinite(n.value()) ? number(n.value()) : "null";
                case Json.Str t -> JSWriter.quote(t.value());
                case Json.Arr a -> "[object]";
                case Json.Obj o -> "[object]";
            };
        }
    }

    /** fakes.js {@code fakeTts} with the opt-in shapes ({@code setup.tts}). */
    static final class FakeNarrator {
        final boolean refuse;
        final boolean voiceFallback;
        /** The bridge offers {@code onFinished} (an older shell does not). */
        final boolean onFinished;
        /** The bridge offers pause/resume/stop (a shell built before L-05 does not). */
        final boolean transport;
        final boolean pauseRejects;
        /** What {@code resume} answers, when the case says ({@code {accepted, fromStart, reason}}). */
        final Json resumeAnswer;
        /** The bridge answers {@code state()}. */
        final boolean stateful;
        NarratorReading word = NarratorReading.IDLE;
        /** The utterance it is speaking (or last spoke), and the one before it. */
        Integer current;
        Integer previous;

        FakeNarrator(Json shape) {
            refuse = JsArgs.isTrue(JsArgs.at(shape, "refuse"));
            voiceFallback = JsArgs.isTrue(JsArgs.at(shape, "voiceFallback"));
            onFinished = !(JsArgs.at(shape, "onFinished") instanceof Json.Bool b && !b.value());
            transport = !(JsArgs.at(shape, "transport") instanceof Json.Bool b2 && !b2.value());
            pauseRejects = "rejects".equals(JsArgs.at(shape, "pause").asString());
            resumeAnswer = JsArgs.at(shape, "resume") instanceof Json.Obj ? JsArgs.at(shape, "resume") : null;
            stateful = JsArgs.isTrue(JsArgs.at(shape, "state"));
        }
    }

    /** fakes.js {@code fakeInterlude} ({@code setup.interlude}). */
    static final class FakeJingle {
        final boolean refuse;
        boolean active = false;

        FakeJingle(boolean refuse) {
            this.refuse = refuse;
        }
    }

    /**
     * The page's build of every Foray a scenario plays: {@code player/parity/scenario-builds.json},
     * which {@code tools/parity/scenario-builds.mjs --write} emits from the real
     * {@code buildForayQueue} and run.test.js holds current. The engine never builds a Foray (plan
     * §3 A-1), so its input here is exactly what {@code playForay} carries.
     */
    static final class ScenarioBuilds {
        private ScenarioBuilds() {}

        static final String FILE = "player/parity/scenario-builds.json";

        /** One build: the items (their nodes verbatim), the ladder's options and runner.js's {@code forayReport}. */
        record Build(List<EngineItem> items, boolean isLocalFile, boolean allowAdPad, Json report) {}

        private static final Map<Path, JsonNode> TABLES = new HashMap<>();

        /** The table, read once per repo root, in key order (item nodes are kept verbatim). */
        static synchronized JsonNode table(Codec.Context context) {
            Path root = context.repoRoot();
            if (root == null) throw new HarnessError("E_BAD_CASE", "a scenario's Foray build needs the repo root, and this run has none");
            JsonNode hit = TABLES.get(root);
            if (hit != null) return hit;
            String text;
            try {
                text = Files.readString(root.resolve(FILE), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new HarnessError("E_BAD_CASE", "cannot read " + FILE + ": " + e.getMessage());
            }
            JsonNode doc = JsonNode.tryParse(text);
            if (doc == null) throw new HarnessError("E_BAD_CASE", "cannot parse " + FILE);
            JsonNode builds = doc.get("builds") == null ? new JsonNode.Obj(List.of()) : doc.get("builds");
            TABLES.put(root, builds);
            return builds;
        }

        static Build build(String caseId, int step, Codec.Context context) {
            String key = caseId + "@" + step;
            JsonNode entry = table(context).get(key);
            if (!(entry instanceof JsonNode.Obj)) {
                throw new HarnessError("E_BAD_CASE", key + " has no build in " + FILE + "; run node tools/parity/scenario-builds.mjs --write");
            }
            List<JsonNode> nodes = entry.get("items") == null || entry.get("items").arrayValue() == null ? List.of()
                    : entry.get("items").arrayValue();
            JsonNode skipped = entry.get("skipped");
            Double warnings = entry.get("warnings") == null ? null : entry.get("warnings").numberValue();
            return build(key, nodes, JsonNode.TRUE.equals(entry.get("isLocalFile")), JsonNode.TRUE.equals(entry.get("allowAdPad")),
                    warnings == null ? 0 : warnings, skipped == null ? new Json.Arr(List.of()) : ForayHarness.value(skipped));
        }

        /** One table entry ({@code {isLocalFile, allowAdPad, warnings, skipped, items}}). */
        static Build build(String key, List<JsonNode> nodes, boolean isLocalFile, boolean allowAdPad, double warnings, Json skipped) {
            List<EngineItem> items = new ArrayList<>();
            List<Json> ids = new ArrayList<>();
            for (JsonNode node : nodes) {
                EngineItem item = EngineItem.of(node);
                if (item == null) throw new HarnessError("E_BAD_CASE", key + ": a built item has no id");
                items.add(item);
                ids.add(Json.str(item.id));
            }
            Json report = JsArgs.obj("items", new Json.Arr(ids), "skipped", Codec.encode(skipped), "warnings", Json.num(warnings));
            return new Build(items, isLocalFile, allowAdPad, report);
        }
    }
}
