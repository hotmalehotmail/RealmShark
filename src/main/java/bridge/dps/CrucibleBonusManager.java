package bridge.dps;

/**
 * STUB: replaced at integration.
 *
 * Stand-in for tomato's {@code tomato.backend.data.CrucibleBonusManager}. The full
 * implementation tracks crucible bonuses from packets / the RealmShark API and derives a
 * per-player damage multiplier. Only the public signature consumed by the DPS math
 * ({@link Entity#playerStatsMultiplier()}) is preserved here; a separate fidelity agent
 * supplies the real class. Keep this signature byte-for-byte identical.
 */
public class CrucibleBonusManager {

    // STUB: replaced at integration. Real implementation returns the multiplicative
    // crucible damage bonus for the local player; 1.0 means "no bonus".
    public static double getPlayerDamageMultiplier() {
        return 1.0;
    }
}
