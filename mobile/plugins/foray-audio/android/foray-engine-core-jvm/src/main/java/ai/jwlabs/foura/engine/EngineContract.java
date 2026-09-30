package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * The page's commands as the core receives them: the typed half of Engine Protocol v1
 * (docs/native-engine-plan.md §5.2), the JVM twin of {@code EngineContract.Command} and
 * the types it carries in ForayEngineCore (Contract/ContractDecoding.swift).
 *
 * <p>WHAT IS HERE (cards A-24 and A-28). The core's door takes a DECODED command, so this
 * file holds the command set {@link EngineCore} acts on, the refusal tokens it answers with,
 * and the continuation hop (A-24). A-28 adds the rest of the Swift {@code EngineContract}:
 * the protocol's closed sets (read from the generated {@link EngineConstants.EngineContract},
 * so no token is retyped), and the PAGE's two rules, {@link #decidePageMode} and
 * {@link #extrapolate}, ported so the {@code handshake} and {@code snapshot} families hold
 * the JVM to the page's reading. Decoding a payload into one of these types, and
 * {@code contractAccepts}, is {@link ContractDecoding}. {@code playForay} decodes but is
 * refused {@code capability-off} until the Foray tape (A-40); {@code setModeOverride} is
 * the bridge's (the lane's Developer setting), never the core's.
 */
public final class EngineContract {
    private EngineContract() {}

    /** {@code PROTOCOL}: a page and an engine that disagree run the JS player. */
    public static final int PROTOCOL_VERSION = (int) EngineConstants.EngineContract.PROTOCOL;

    /** {@code OWNED_PREFIXES}: the shared rows the native engine owns; the trailing colons are load-bearing. */
    public static final List<String> OWNED_PREFIXES = EngineConstants.EngineContract.OWNED_PREFIXES;

    /** {@code BRIDGE_METHODS}: the three plugin methods (§5.1). */
    public static final List<String> BRIDGE_METHODS = EngineConstants.EngineContract.BRIDGE_METHODS;

    /** {@code COMMANDS}: every engineSend {@code cmd} (§5.2); anything else is {@code unknown-cmd}. */
    public static final List<String> COMMANDS = EngineConstants.EngineContract.COMMANDS;

    /** {@code EVENTS}: the {@code type} of every "engine" event (§5.4). */
    public static final List<String> EVENTS = EngineConstants.EngineContract.EVENTS;

    /** {@code READ_KINDS}: engineRead's {@code what}. */
    public static final List<String> READ_KINDS = EngineConstants.EngineContract.READ_KINDS;

    /** {@code CAPABILITIES}: what a native engine can play (§6.6), each advertised only when its families owe nothing. */
    public static final List<String> CAPABILITIES = EngineConstants.EngineContract.CAPABILITIES;

    /** {@code SNAPSHOT_MODES}: what is loaded ({@code none} spelled as the wire has it). */
    public static final List<String> SNAPSHOT_MODES = EngineConstants.EngineContract.SNAPSHOT_MODES;

    /** {@code PLAYER_STATES}: the six reducer states, spelled as their {@code type}. */
    public static final List<String> PLAYER_STATES = EngineConstants.EngineContract.PLAYER_STATES;

    /** {@code CONTRACT_KINDS}: the payloads the schema describes, in its order. */
    public static final List<String> CONTRACT_KINDS = EngineConstants.EngineContract.CONTRACT_KINDS;

    /** {@code ENGINE_MODES}: engineHello's {@code mode}. {@code legacy} is the JS lane. */
    public static final List<String> ENGINE_MODES = EngineConstants.EngineContract.ENGINE_MODES;

    /** {@code PAGE_MODES}: the page's own answer, {@link #decidePageMode}. */
    public static final List<String> PAGE_MODES = EngineConstants.EngineContract.PAGE_MODES;

    /** {@code HANDSHAKE_REASONS}: why {@link #decidePageMode} answered what it did. */
    public static final List<String> HANDSHAKE_REASONS = EngineConstants.EngineContract.HANDSHAKE_REASONS;

    /** {@code MODE_OVERRIDES}: the Developer engine setting (Automatic / Native / Web), as stored. */
    public static final List<String> MODE_OVERRIDES = EngineConstants.EngineContract.MODE_OVERRIDES;

    public static final String MODE_NATIVE = "native";
    public static final String MODE_LEGACY = "legacy";

    // ---- the page's rules (the handshake and snapshot families)

    /**
     * {@code helloRequest(pageBuild)}: the page's build stamp (a missing one is "") and the
     * protocol it speaks, in the order the page writes them.
     */
    public static JsonNode helloRequest(String pageBuild) {
        List<JsonNode.Member> members = new ArrayList<>();
        members.add(JsonNode.member("pageBuild", JsonNode.str(pageBuild == null ? "" : pageBuild)));
        members.add(JsonNode.member("protocol", JsonNode.num(PROTOCOL_VERSION)));
        return new JsonNode.Obj(members);
    }

    /**
     * {@code decideMode}'s answer. {@code relinquish} is true when an engine MIGHT be running
     * natively and the page is about to run the JS player anyway.
     */
    public record PageDecision(String mode, String reason, boolean relinquish) {}

    /**
     * {@code decideMode({platform, methodPresent, hello})}: does this page drive a native
     * engine? {@code hello} is engineHello's answer as sent, or null for no answer (a JSON
     * null is the same case). {@code mode} is checked BEFORE {@code protocol}, because a
     * {@code {mode: "legacy", reason}} stub carries no protocol. The engine never calls this to
     * decide anything; the bridge's tests check every hello it builds against it (a native
     * answer the page would refuse is a bridge that silently runs the JS player).
     */
    public static PageDecision decidePageMode(String platform, boolean methodPresent, JsonNode hello) {
        if (platform == null || !EngineConstants.EngineContract.ENGINE_PLATFORMS.contains(platform)) {
            return new PageDecision("js", "not-ios", false);
        }
        if (!methodPresent) return new PageDecision("js", "no-method", false);
        if (hello == null || hello instanceof JsonNode.Null) return new PageDecision("js", "no-hello", true);
        ContractDecoding.HelloResponse response;
        try {
            response = ContractDecoding.HelloResponse.decode(hello);
        } catch (ContractDecoding.ContractError e) {
            return new PageDecision("js", "bad-hello", true);
        }
        if (!MODE_NATIVE.equals(response.mode())) return new PageDecision("js", "engine-legacy", false);
        Long protocol = response.protocolVersion();
        if (protocol == null || protocol != PROTOCOL_VERSION) return new PageDecision("js", "protocol-mismatch", true);
        return new PageDecision("native", "native", false);
    }

    /**
     * {@code extrapolate(snapshot, receivedAtMs, nowMs)}: where the playhead is {@code nowMs}
     * after a snapshot arrived at {@code receivedAtMs}, by the page's own receipt clock. Frozen
     * while {@code inSeamGap}, {@code buffering} or not {@code running}; clamped to
     * [0, durationSec] when the duration is known; a clock that went backwards counts as no
     * time. Each parameter is what the JS reads: a non-finite number is null, the three flags
     * are {@code === true}. {@code Math.max}/{@code Math.min} are JavaScript's
     * ({@link JSMath}): they differ from Java's on a signed zero.
     */
    public static double extrapolate(Double positionSec, Double durationSec, boolean inSeamGap, boolean buffering,
                                     boolean running, Double effectiveRate, Double receivedAtMs, Double nowMs) {
        Double posOrNull = finite(positionSec);
        double pos = posOrNull == null ? 0 : posOrNull;
        Double durFinite = finite(durationSec);
        Double dur = durFinite != null && durFinite > 0 ? durFinite : null;
        if (inSeamGap || buffering || !running) return clamp(pos, dur);
        Double rateFinite = finite(effectiveRate);
        double rate = rateFinite != null && rateFinite > 0 ? rateFinite : 0;
        double elapsedMs = 0;
        Double received = finite(receivedAtMs);
        Double now = finite(nowMs);
        if (received != null && now != null) elapsedMs = JSMath.max(0, now - received);
        return clamp(pos + (rate * elapsedMs) / 1000, dur);
    }

    private static double clamp(double x, Double dur) {
        return JSMath.max(0, dur == null ? x : JSMath.min(dur, x));
    }

    private static Double finite(Double value) {
        return value == null || Double.isNaN(value) || Double.isInfinite(value) ? null : value;
    }

    /**
     * {@code REFUSALS}: why an engineSend was refused, fully expanded. The order is the
     * generated list's, and a JUnit test holds the two to one order.
     */
    public enum Refusal {
        NOT_LOADED("not-loaded"),
        NO_NEXT("no-next"),
        NO_PREVIOUS("no-previous"),
        ENDED("ended"),
        REFUSED_STRUCTURE("refused-structure"),
        CAPABILITY_OFF("capability-off"),
        SESSION_FAILED_CANNOT_INTERRUPT_OTHERS("session-failed:cannot-interrupt-others"),
        SESSION_FAILED_CANNOT_START_PLAYING("session-failed:cannot-start-playing"),
        SESSION_FAILED_OTHER("session-failed:other"),
        ENGINE_BUSY("engine-busy"),
        RELINQUISHED("relinquished"),
        UNKNOWN_CMD("unknown-cmd");

        public final String token;

        Refusal(String token) {
            this.token = token;
        }
    }

    /** {@code RELINQUISH_CAPS}: the capability the page needed and the engine lacks, or {@code all}. */
    public enum RelinquishCap {
        EPISODE("episode"),
        CONTINUATION("continuation"),
        RESTORE("restore"),
        FORAY("foray"),
        ALL("all");

        public final String token;

        RelinquishCap(String token) {
            this.token = token;
        }
    }

    /**
     * {@code $defs.hop}: one continuation hop (continuation.js). {@code planSeq} and
     * {@code hopSeq} order it, {@code nextId} names what it plays; the whole hop (its
     * {@code item}, its {@code lastEpisodeRow}) is kept as sent in {@code node}.
     */
    public record Hop(int planSeq, int hopSeq, String nextId, JsonNode node) {
        public Hop {
            Objects.requireNonNull(nextId, "nextId");
            Objects.requireNonNull(node, "node");
        }
    }

    /**
     * One engineSend command with its args (§5.2), the episode subset. Where the plan names
     * no argument the name is NE-11j's, from engine-contract.js {@code COMMAND_ARGS}.
     */
    public sealed interface Command permits Command.PlayEpisode, Command.PlayForay, Command.SetContinuation, Command.Play,
            Command.Pause, Command.Toggle, Command.Next, Command.Previous, Command.SeekBy, Command.SeekTo, Command.Jump,
            Command.Stop, Command.SetRate, Command.SetVoice, Command.SetInterludeEnabled, Command.SetPageVisible,
            Command.AckAdvances, Command.AckEvents, Command.RestoreBar, Command.Purge, Command.Relinquish, Command.Audition,
            Command.SetModeOverride, Command.SetHoldPolicy, Command.ProbeSession, Command.SimulateTermination {

        /**
         * {@code item} is the page's queue item (only its {@code id} is the contract's; the
         * rest is kept as sent). {@code lastEpisodeRow} is {@code makeLastEpisode(item)}
         * without {@code updated_at}, stored verbatim plus the play's stamp. {@code startSec}
         * and {@code moved} are null when absent.
         */
        record PlayEpisode(JsonNode item, Double startSec, Boolean moved, JsonNode lastEpisodeRow) implements Command {}

        /**
         * playForay's args (§5.2; M2), decoded so the contract's accept/refuse answer is the
         * page's (A-28). The core refuses it {@code capability-off} until the Foray tape (A-40).
         * {@code items} are the page's queue items as sent; {@code voiceId} is required and may
         * be null.
         */
        record PlayForay(String forayId, String title, List<JsonNode> items, JsonNode buildReport, Double startElapsedSec,
                         boolean isLocalFile, boolean allowAdPad, String voiceId) implements Command {
            public PlayForay {
                items = Collections.unmodifiableList(new ArrayList<>(items));
            }
        }

        record SetContinuation(int planSeq, boolean autoAdvance, List<Hop> chain, Hop previous) implements Command {
            public SetContinuation {
                chain = Collections.unmodifiableList(new ArrayList<>(chain));
            }
        }

        record Play() implements Command {}

        record Pause() implements Command {}

        record Toggle() implements Command {}

        record Next() implements Command {}

        record Previous() implements Command {}

        record SeekBy(double deltaSec) implements Command {}

        record SeekTo(double sec) implements Command {}

        record Jump(int index) implements Command {}

        /** {@code persist: false} is data deletion. */
        record Stop(boolean persist) implements Command {}

        /** The requested rate; null for every value that is not a number (snapped to 1x). */
        record SetRate(Double rate) implements Command {}

        /** The narration voice, null for the synthesiser's own pick. */
        record SetVoice(String voiceId) implements Command {}

        record SetInterludeEnabled(boolean on) implements Command {}

        record SetPageVisible(boolean visible) implements Command {}

        record AckAdvances(int upToSeq) implements Command {}

        record AckEvents(int upToSeq) implements Command {}

        record RestoreBar() implements Command {}

        record Purge() implements Command {}

        record Relinquish(RelinquishCap cap) implements Command {}

        record Audition(String text, String voiceId) implements Command {}

        /** The Developer engine setting ({@code MODE_OVERRIDES}): the bridge's, in every lane, never the core's. */
        record SetModeOverride(String mode) implements Command {}

        record SetHoldPolicy(SessionPolicy.HoldPolicy policy) implements Command {}

        /** Developer only (NE-25c): the host's. */
        record ProbeSession() implements Command {}

        /** Developer only (NE-24): persist the restore record now; the host exits at the next background entry. */
        record SimulateTermination() implements Command {}

        Command PLAY = new Play();
        Command PAUSE = new Pause();
        Command TOGGLE = new Toggle();
        Command NEXT = new Next();
        Command PREVIOUS = new Previous();
    }
}
