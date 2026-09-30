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
 * <p>WHAT IS HERE AND WHAT IS NOT (card A-24). The core's door takes a DECODED command,
 * so this file holds the command set {@link EngineCore} acts on for episodes, the refusal
 * tokens it answers with, and the continuation hop. Decoding an engineSend payload into
 * one of these (the contract's strict reader, {@code contractAccepts}, the snapshot and
 * handshake payloads) is the bridge's, card A-28, which owes the {@code contract},
 * {@code snapshot} and {@code handshake} families. {@code playForay} arrives with the
 * Foray tape (A-40) and {@code setModeOverride} with ownership (A-29); until then a page
 * that needs them relinquishes, because the capability is never advertised.
 */
public final class EngineContract {
    private EngineContract() {}

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
    public sealed interface Command permits Command.PlayEpisode, Command.SetContinuation, Command.Play, Command.Pause,
            Command.Toggle, Command.Next, Command.Previous, Command.SeekBy, Command.SeekTo, Command.Jump, Command.Stop,
            Command.SetRate, Command.SetVoice, Command.SetInterludeEnabled, Command.SetPageVisible, Command.AckAdvances,
            Command.AckEvents, Command.RestoreBar, Command.Purge, Command.Relinquish, Command.Audition, Command.SetHoldPolicy,
            Command.ProbeSession, Command.SimulateTermination {

        /**
         * {@code item} is the page's queue item (only its {@code id} is the contract's; the
         * rest is kept as sent). {@code lastEpisodeRow} is {@code makeLastEpisode(item)}
         * without {@code updated_at}, stored verbatim plus the play's stamp. {@code startSec}
         * and {@code moved} are null when absent.
         */
        record PlayEpisode(JsonNode item, Double startSec, Boolean moved, JsonNode lastEpisodeRow) implements Command {}

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
