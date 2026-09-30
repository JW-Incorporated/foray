package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * J-4 (plan §5.2 {@code playForay}: "the engine re-validates structure"): the JVM twin of
 * {@code StructuralCheck} in ForayEngineCore (Policy/StructuralCheck.swift), card A-40, and like
 * it the port of {@code player/foray-structure.js}. A built Foray queue crosses the bridge into an
 * engine that did not build it, so before anything is audible the engine checks it has the
 * structure {@code buildForayQueue} guarantees, and refuses it as {@code refused-structure} with
 * EVERY problem named otherwise. The {@code foray-structure} family is the contract.
 *
 * <p>{@link #seamCensus} is the other half: what each join of a queue is, by the same seam rules
 * the engine applies ({@link SeamGap}, {@link Interlude}).
 *
 * <p>A null list is a value that is not an array; a null entry is one that is not a plain object.
 */
public final class StructuralCheck {
    private StructuralCheck() {}

    public static final String REFUSED_STRUCTURE = EngineConstants.ForayStructure.REFUSED_STRUCTURE;
    public static final List<String> QUEUE_KINDS = EngineConstants.ForayStructure.QUEUE_KINDS;
    public static final List<String> PROBLEM_CODES = EngineConstants.ForayStructure.STRUCTURE_PROBLEMS;

    /** One problem: the item's queue index (-1 for the queue itself) and its code. */
    public record Problem(int index, String code) {}

    /** {@code structuralCheck(items)}'s answer; {@code reason} is {@link #REFUSED_STRUCTURE} exactly when not ok. */
    public record Verdict(boolean ok, String reason, List<Problem> problems) {}

    /** Every problem of every item in queue order; {@code empty} (index -1) when there is no item at all. */
    public static Verdict check(List<ForayItem> items) {
        List<Problem> problems = new ArrayList<>();
        if (items != null && !items.isEmpty()) {
            Set<String> seen = new HashSet<>();
            for (int index = 0; index < items.size(); index++) {
                ForayItem item = items.get(index);
                for (String code : itemProblems(item)) problems.add(new Problem(index, code));
                String id = item == null ? null : item.id();
                if (id != null && Rows.nonEmpty(id)) {
                    if (seen.contains(id)) problems.add(new Problem(index, "duplicate-id"));
                    seen.add(id);
                }
            }
        } else {
            problems.add(new Problem(-1, "empty"));
        }
        boolean ok = problems.isEmpty();
        return new Verdict(ok, ok ? null : REFUSED_STRUCTURE, problems);
    }

    /** {@code itemProblems(item)}, in the header's order. */
    static List<String> itemProblems(ForayItem item) {
        List<String> out = new ArrayList<>();
        if (item == null) {
            out.add("not-an-object");
            return out;
        }
        if (!nonEmpty(item.id())) out.add("no-id");
        String kind = item.kind();
        if (kind == null || !QUEUE_KINDS.contains(kind)) {
            out.add("unknown-kind");
            return out;
        }
        if (kind.equals(EngineConstants.QueueState.EPISODE)) {
            if (!nonEmpty(item.audioUrl())) out.add("no-audio");
            Double start = item.startSec();
            Double end = item.endSec();
            boolean bounded = start != null && Double.isFinite(start) && start >= 0 && end != null && Double.isFinite(end)
                    && end > start;
            if (!bounded) out.add("bad-bounds");
            if (item.daiSuspected() && !(nonEmpty(item.startAnchor()) && nonEmpty(item.endAnchor()))) out.add("dai-unanchored");
            Double reference = item.referenceDurationSec();
            if (item.needsDriftCheck() && !(reference != null && Double.isFinite(reference))) out.add("no-reference");
            return out;
        }
        if (kind.equals(ForayClock.JINGLE)) {
            if (!nonEmpty(item.audioUrl())) out.add("no-audio");
        } else if (!nonEmpty(item.audioUrl()) && !nonEmpty(item.script())) {
            out.add("silent-narration");
        }
        Double duration = item.durationSec();
        if (!(duration != null && Double.isFinite(duration) && duration > 0)) out.add("no-duration");
        return out;
    }

    /** What every join of a queue is, on an automatic advance. */
    public record Census(int items, int segments, int seams, int beats, int jingles, int sameSource, int sourceChanges) {}

    /**
     * {@code seamCensus(items)}. A null entry is a null (or any falsy) one: every rule answers "no"
     * for it.
     */
    public static Census seamCensus(List<ForayItem> items) {
        List<ForayItem> list = items == null ? new ArrayList<>() : items;
        int segments = 0;
        for (ForayItem item : list) if (SeamGap.isSegment(item == null ? null : item.seam())) segments += 1;
        int seams = Math.max(0, list.size() - 1);
        int beats = 0;
        int jingles = 0;
        int sameSource = 0;
        int sourceChanges = 0;
        for (int i = 1; i < list.size(); i++) {
            ForayItem from = list.get(i - 1);
            ForayItem to = list.get(i);
            if (SeamGap.gapSec(from == null ? null : from.seam(), to == null ? null : to.seam()) > 0) beats += 1;
            Interlude.InterludeItem fromI = from == null ? null : from.interlude();
            Interlude.InterludeItem toI = to == null ? null : to.interlude();
            if (Interlude.eligible(fromI, toI)) jingles += 1;
            if (Interlude.sameSourceEpisode(fromI, toI)) sameSource += 1;
            if (from != null && to != null && SeamGap.isSegment(from.seam()) && SeamGap.isSegment(to.seam())
                    && !java.util.Objects.equals(from.sourceItemId(), to.sourceItemId())) {
                sourceChanges += 1;
            }
        }
        return new Census(list.size(), segments, seams, beats, jingles, sameSource, sourceChanges);
    }

    /** {@code nonEmpty(s)}: a string with something left after {@code trim}. */
    static boolean nonEmpty(String value) {
        return value != null && Rows.nonEmpty(value);
    }
}
