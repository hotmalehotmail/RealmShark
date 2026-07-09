package bridge.dps;

import packets.data.StatData;

/**
 * STUB: replaced at integration.
 *
 * Minimal no-op stand-in for tomato's {@code tomato.backend.SecurityAbilityUseCheck}.
 * Only the methods invoked from {@link Entity#updateStats} are preserved (with their
 * exact signatures) so the DPS engine compiles standalone. The real implementation
 * (mana-from-stasis / mana-from-decoy security checks) is GUI-coupled and is not part
 * of the DPS calculation surface.
 */
public class SecurityAbilityUseCheck {

    // STUB: replaced at integration
    public static void checkManaFromStasis(Entity entity, StatData[] stats) {
        // no-op
    }

    // STUB: replaced at integration
    public static void checkManaFromDecoyUsed(Entity entity, StatData[] stats) {
        // no-op
    }
}
