package ai.jwlabs.foura.engine.parity;

import ai.jwlabs.foura.engine.JSWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The fixture families the JVM runs, one {@link FamilyRunner} each. Every other family
 * is owed in player/parity/jvm-pending.json. A porting card adds its family here and
 * burns its entry out of jvm-pending.json (moving it to "runs") in the same change; the
 * suite fails if it does one without the other.
 */
public final class JvmFamilies {
    private JvmFamilies() {}

    /** player/parity/rows.js, the module number-format's fixture names. */
    public static final String ROWS_MODULE = "player/parity/rows.js";

    /** player/parity/compare.js, the module the compare meta-family's fixture names. */
    public static final String COMPARE_MODULE = "player/parity/compare.js";

    /**
     * {@code number-format}: {@code jsonNumber(x)} is {@code JSON.stringify(x)}, the way
     * every number inside a shared row is printed. The one ENGINE family A-22 ports,
     * because it is a single pure function; {@link JSWriter} is main code, and the row
     * writer (A-23) is built on it.
     */
    public static final FamilyRunner NUMBER_FORMAT = new FamilyRunner.Pure(
            "number-format",
            ROWS_MODULE,
            Map.of(),
            Map.<String, FamilyRunner.Call>of("jsonNumber", args -> {
                Json x = args.isEmpty() ? Json.UNDEFINED : args.get(0);
                if (!(x instanceof Json.Num n)) throw new HarnessError("E_BAD_CASE", "jsonNumber takes a number");
                return new FamilyRunner.Returned(Json.str(JSWriter.jsonNumber(n.value())));
            }));

    /**
     * {@code compare}: the comparator itself, as fixtures (the Swift CompareFamily). Not
     * an engine rule but this runner's own verdict: every other family's pass or fail
     * goes through {@link Comparator}, so compare.js's decision table is replayed
     * against it, and a JVM comparator that drifts from the JS one turns this family
     * red instead of quietly turning a wrong answer green. The inputs go through the
     * codec on both sides (expand, then re-encode, as compareVerdict does), so this
     * family also pins the two codecs' round trip of every tag.
     */
    public static final FamilyRunner COMPARE = new FamilyRunner.Pure(
            "compare",
            COMPARE_MODULE,
            Map.of(),
            Map.<String, FamilyRunner.Call>of("compareVerdict", args -> {
                Json expected = Codec.encode(args.size() > 0 ? args.get(0) : Json.UNDEFINED);
                Json actual = Codec.encode(args.size() > 1 ? args.get(1) : Json.UNDEFINED);
                // `opts ?? {}`: a missing or nullish opts is no options.
                Json opts = args.size() > 2 ? args.get(2) : Json.UNDEFINED;
                Json family = opts.get("family");
                Json tolerance = opts.get("tolerance");
                List<Comparator.Difference> diffs = Comparator.compare(expected, actual,
                        family == null ? null : family.asString(),
                        tolerance == null ? null : tolerance.asNumber());
                List<Json> out = new ArrayList<>();
                for (Comparator.Difference d : diffs) {
                    Map<String, Json> m = new LinkedHashMap<>();
                    m.put("path", Json.str(d.path()));
                    m.put("why", Json.str(d.why()));
                    out.add(new Json.Obj(m));
                }
                Map<String, Json> verdict = new LinkedHashMap<>();
                verdict.put("equal", diffs.isEmpty() ? Json.TRUE : Json.FALSE);
                verdict.put("diffs", new Json.Arr(out));
                return new FamilyRunner.Returned(new Json.Obj(verdict));
            }));

    /*
     * A-23: the pure policies of the episode subset, ported from ForayEngineCore into this
     * module's main code, each family run by its runner below (the JVM twins of the Swift
     * FamilyRunners): the reducer, the rate ladder, the resume and cadence rules, the
     * transport rules, the byte-identical shared rows, the session table and its
     * audible-start invariant, and the lock-screen / remote-command mapping.
     */
    public static final FamilyRunner QUEUE_STATE = QueueStateFamily.runner();
    public static final FamilyRunner RATE = PolicyFamilies.rate();
    public static final FamilyRunner RESUME_RULES = PolicyFamilies.resumeRules();
    public static final FamilyRunner TRANSPORT = PolicyFamilies.transport();
    public static final FamilyRunner ROWS = RowsFamily.runner();
    public static final FamilyRunner SESSION = SessionFamily.runner();
    public static final FamilyRunner SESSION_INVARIANT = SessionFamily.invariantRunner();
    public static final FamilyRunner MEDIA_EPISODE = MediaEpisodeFamily.runner();

    /*
     * A-24: the engine's functional core for episodes (EngineCore, main code), driven through
     * the manager-episode scenarios by EngineScenarioDriver, which also checks the
     * audible-start invariant on every turn; and the episode deck's rules (DeckPolicy).
     */
    public static final FamilyRunner MANAGER_EPISODE = ManagerEpisodeFamily.runner();
    public static final FamilyRunner DECK_EPISODE = DeckEpisodeFamily.runner();

    /*
     * A-25: the rest of the deck's rules, ported with the ExoPlayer deck (foray-audio's
     * ExoDeck): the native out-point (three layers and a windowed watchdog, over runner.js's
     * driven clock), the deck's guards, and the standby deck's decisions (DeckPolicy).
     */
    public static final FamilyRunner OUTPOINT = DeckFamilies.outpoint();
    public static final FamilyRunner DECK = DeckFamilies.deck();

    /*
     * A-28: the contract the Android bridge speaks (ContractDecoding, main code): every
     * payload's accept / refuse answer, the page's decideMode and extrapolate, and the
     * diagnostics rows' closed vocabularies (TokenAdmission).
     */
    public static final FamilyRunner CONTRACT = ContractFamilies.contract();
    public static final FamilyRunner SNAPSHOT = ContractFamilies.snapshot();
    public static final FamilyRunner HANDSHAKE = ContractFamilies.handshake();
    public static final FamilyRunner DIAG_TOKENS = ContractFamilies.diagTokens();

    /*
     * A-29: the lane's once-per-process decision and its strike rules across launches
     * (EngineMode, main code), which foray-audio's EngineOwnership wraps.
     */
    public static final FamilyRunner ENGINE_MODE = EngineModeFamily.runner();

    /*
     * A-40: the Foray tape (EngineCore with forayTapeEnabled, main code) and its policies: the
     * seam beat (SeamGap), ADR-0007's ladder (SeekPolicy), the jingle's rule (Interlude), the
     * Foray clock (ForayClock), J-4's structural check (StructuralCheck), the Foray's resume
     * rules (ForayProgressRules), the Foray half of the lock screen (media), and the tape's
     * scenarios through the manager surface (manager-foray) and the contract with the standby
     * deck (prepare).
     */
    public static final FamilyRunner SEAM_GAP = ForayFamilies.seamGap();
    public static final FamilyRunner SEEK_POLICY = ForayFamilies.seekPolicy();
    public static final FamilyRunner INTERLUDE = ForayFamilies.interlude();
    public static final FamilyRunner FORAY_CLOCK = ForayFamilies.forayClock();
    public static final FamilyRunner FORAY_STRUCTURE = ForayFamilies.forayStructure();
    public static final FamilyRunner FORAY_PROGRESS = ForayProgressFamily.runner();
    public static final FamilyRunner MEDIA = ForayFamilies.media();
    public static final FamilyRunner MANAGER_FORAY = ForayTapeFamilies.managerForay();
    public static final FamilyRunner PREPARE = ForayTapeFamilies.prepare();

    /*
     * A-41: the narrator's rules (SpeechRules, main code): the default voice (the founder's Samantha
     * ruling, player/default-voice.js), the pronunciation lexicon's matcher (foray-tts.js
     * buildIpaOverrides), and what reaches the synthesiser (the text, the voice, 1x whatever the
     * listener's speed) through EngineCore with the Foray tape on.
     */
    public static final FamilyRunner DEFAULT_VOICE = SpeechFamilies.defaultVoice();
    public static final FamilyRunner LEXICON = SpeechFamilies.lexicon();
    public static final FamilyRunner SPEECH_RATE = SpeechFamilies.speechRate();

    /** Every registered runner. */
    public static final List<FamilyRunner> ALL = List.of(COMPARE, NUMBER_FORMAT, QUEUE_STATE, RATE, RESUME_RULES, TRANSPORT, ROWS,
            SESSION, SESSION_INVARIANT, MEDIA_EPISODE, MANAGER_EPISODE, DECK_EPISODE, OUTPOINT, DECK, CONTRACT, SNAPSHOT, HANDSHAKE,
            DIAG_TOKENS, ENGINE_MODE, SEAM_GAP, SEEK_POLICY, INTERLUDE, FORAY_CLOCK, FORAY_STRUCTURE, FORAY_PROGRESS, MEDIA,
            MANAGER_FORAY, PREPARE, DEFAULT_VOICE, LEXICON, SPEECH_RATE);
}
