package ai.jwlabs.foura.engine;

/**
 * The two date rules the shared rows need from {@code Date}: the epoch-day arithmetic
 * behind {@code toISOString} ({@link JSWriter#isoString}), and {@code Date.parse} of the
 * stamps rows carry ({@code isNewer} in player/durable-store.js orders two rows by
 * them). The JVM twin of {@code JSDate} in ForayEngineCore (Persist/JSWriter.swift).
 *
 * <p>Plain arithmetic, no {@code java.time}: that is API 26, above this app's minSdk 24,
 * and a calendar library is one more definition of a date that could disagree with V8's.
 */
public final class JSDate {
    private JSDate() {}

    /** ECMA-262 TimeClip's bound: 100,000,000 days either side of the epoch. */
    public static final double MAX_EPOCH_MS = 8.64e15;

    /**
     * Days since 1970-01-01 to the proleptic Gregorian {@code {year, month, day}}.
     * Howard Hinnant's {@code civil_from_days}, exact for every day a Date can hold.
     */
    static long[] civil(long days) {
        long z = days + 719_468;
        long era = (z >= 0 ? z : z - 146_096) / 146_097;
        long doe = z - era * 146_097;
        long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        long mp = (5 * doy + 2) / 153;
        long day = doy - (153 * mp + 2) / 5 + 1;
        long month = mp < 10 ? mp + 3 : mp - 9;
        long year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        return new long[] {year, month, day};
    }

    /**
     * The inverse: (year, month 1-12, day 1-31) to days since the epoch. A day past the
     * month's end rolls into the next month, as {@code Date.UTC} and V8's ISO parser both
     * roll it.
     */
    static long days(long year, long month, long day) {
        long y = month <= 2 ? year - 1 : year;
        long era = (y >= 0 ? y : y - 399) / 400;
        long yoe = y - era * 400;
        long mp = month > 2 ? month - 3 : month + 9;
        long doy = (153 * mp + 2) / 5 + day - 1;
        long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /**
     * {@code Date.parse(text)} for the ECMAScript Date Time String Format, which is every
     * stamp a shared row's writer produces ({@code toISOString}): epoch milliseconds, or
     * null where {@code Date.parse} gives NaN.
     *
     * <pre>
     *   YYYY | +-YYYYYY, then optional -MM, then optional -DD      (UTC)
     *   then optional T HH:mm, optional :ss, optional .fraction   (1+ digits; ms kept, the rest dropped)
     *   and a date-time must end in Z or +-HH:mm (or +-HHmm)
     * </pre>
     *
     * Held to V8's answers where V8 follows the format: {@code T24:00} only as exactly
     * midnight, a day 29-31 past the month's end rolls over, {@code -000000} is refused,
     * and a lower-case {@code t}/{@code z} is accepted.
     *
     * <p>NOT PORTED, and null here, as in the Swift port: a date-time with no offset
     * (JavaScript reads it as LOCAL time, which would make a row's order depend on the
     * phone's time zone) and V8's lenient fallback for strings outside the format. No
     * writer of a shared row produces either, and null makes {@code isNewer} answer false,
     * which is the page's own answer for a row it cannot date.
     */
    public static Double parse(String text) {
        Cursor cursor = new Cursor(text);
        long year;
        char sign = cursor.takeAnyOf("+-");
        if (sign != 0) {
            Long digits = cursor.digits(6);
            if (digits == null) return null;
            if (digits == 0 && sign == '-') return null;
            year = sign == '-' ? -digits : digits;
        } else {
            Long digits = cursor.digits(4);
            if (digits == null) return null;
            year = digits;
        }
        long month = 1;
        long day = 1;
        if (cursor.take('-')) {
            Long value = cursor.digits(2);
            if (value == null || value < 1 || value > 12) return null;
            month = value;
            if (cursor.take('-')) {
                Long d = cursor.digits(2);
                if (d == null || d < 1 || d > 31) return null;
                day = d;
            }
        }
        long timeMs = 0;
        long offsetMs = 0;
        if (cursor.takeAnyOf("Tt") != 0) {
            Long hours = cursor.digits(2);
            if (hours == null || !cursor.take(':')) return null;
            Long minutes = cursor.digits(2);
            if (minutes == null || hours > 24 || minutes > 59) return null;
            long seconds = 0;
            long millis = 0;
            if (cursor.take(':')) {
                Long value = cursor.digits(2);
                if (value == null || value > 59) return null;
                seconds = value;
                if (cursor.take('.')) {
                    Long fraction = cursor.fractionMillis();
                    if (fraction == null) return null;
                    millis = fraction;
                }
            }
            if (hours == 24 && (minutes != 0 || seconds != 0 || millis != 0)) return null;
            timeMs = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
            if (cursor.takeAnyOf("Zz") != 0) {
                offsetMs = 0;
            } else {
                char offSign = cursor.takeAnyOf("+-");
                if (offSign == 0) return null; // local time: not ported (see above)
                Long offHours = cursor.digits(2);
                if (offHours == null || offHours > 23) return null;
                cursor.take(':');
                Long offMinutes = cursor.digits(2);
                if (offMinutes == null || offMinutes > 59) return null;
                offsetMs = (offHours * 60 + offMinutes) * 60_000 * (offSign == '-' ? -1 : 1);
            }
        }
        if (!cursor.atEnd()) return null;
        long epochMs = days(year, month, day) * 86_400_000L + timeMs - offsetMs;
        double value = (double) epochMs;
        return Math.abs(value) <= MAX_EPOCH_MS ? value : null;
    }

    /** A cursor over the stamp's code units; every {@code take} consumes only on a match. */
    private static final class Cursor {
        private final String s;
        private int index;

        Cursor(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return index == s.length();
        }

        boolean take(char expected) {
            if (index >= s.length() || s.charAt(index) != expected) return false;
            index++;
            return true;
        }

        /** The option taken, or 0 for none. */
        char takeAnyOf(String options) {
            if (index >= s.length() || options.indexOf(s.charAt(index)) < 0) return 0;
            return s.charAt(index++);
        }

        Long digits(int count) {
            if (index + count > s.length()) return null;
            long value = 0;
            for (int i = index; i < index + count; i++) {
                char c = s.charAt(i);
                if (c < '0' || c > '9') return null;
                value = value * 10 + (c - '0');
            }
            index += count;
            return value;
        }

        /**
         * One or more digits after the point; the first three are the milliseconds
         * ({@code .1} is 100 ms) and the rest are dropped, as V8 drops them.
         */
        Long fractionMillis() {
            int taken = 0;
            long millis = 0;
            while (index < s.length() && s.charAt(index) >= '0' && s.charAt(index) <= '9') {
                if (taken < 3) millis = millis * 10 + (s.charAt(index) - '0');
                taken++;
                index++;
            }
            if (taken == 0) return null;
            for (int i = Math.min(taken, 3); i < 3; i++) millis *= 10;
            return millis;
        }
    }
}
