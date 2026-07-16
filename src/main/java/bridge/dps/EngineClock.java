package bridge.dps;

import java.util.function.LongSupplier;

/**
 * Seam for the {@code System.currentTimeMillis()} reads inside {@link DpsEngine} and
 * {@link Entity} (fight-timer/DPS-rate math and loot-timer bookkeeping). Production always
 * reads the real wall clock; a replayed session from the past (see {@code CaptureReplay} in
 * {@code src/test/java/bridge/replay/}) anchors this to each packet envelope's own recorded
 * {@code time} instead, so replaying old packets doesn't compute fight durations against
 * "now" (PRD §6.5 D3 - the Java analog of the TS replay harness's fake-timer anchoring).
 */
public final class EngineClock {

    private static volatile LongSupplier supplier = System::currentTimeMillis;

    private EngineClock() {}

    public static long now() {
        return supplier.getAsLong();
    }

    /** Test-only: replace the time source. Callers must {@link #reset()} when done. */
    public static void set(LongSupplier newSupplier) {
        supplier = newSupplier;
    }

    /** Restores the production default ({@code System.currentTimeMillis()}). */
    public static void reset() {
        supplier = System::currentTimeMillis;
    }
}
