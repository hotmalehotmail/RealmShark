package bridge.dps;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Unit tests for {@link Projectile#damageWithDefense}, the pure damage-after-defense
 * formula at the core of DPS attribution. This is deterministic and has no game/asset
 * dependency, which makes it the first ground-truth CI test for the DPS engine.
 *
 * <p>{@code conditions} is a 2-int bitmask array (condition-effect flags); {@code {0, 0}}
 * means no effects.</p>
 */
public class ProjectileTest {

    private static int[] noConditions() {
        return new int[] { 0, 0 };
    }

    @Test
    public void subtractsDefenseFromDamage() {
        // 100 dmg - 30 def = 70, well above the 10% minimum floor.
        assertEquals(70, Projectile.damageWithDefense(100, false, 30, noConditions()));
    }

    @Test
    public void armorPiercingIgnoresDefense() {
        assertEquals(100, Projectile.damageWithDefense(100, true, 30, noConditions()));
    }

    @Test
    public void flooredAtTenPercentWhenDefenseExceedsDamage() {
        // Defense exceeds damage, so the result is floored at (damage * 2) / 20 = 10% of damage.
        assertEquals(10, Projectile.damageWithDefense(100, false, 500, noConditions()));
    }

    @Test
    public void zeroBaseDamageStaysZero() {
        assertEquals(0, Projectile.damageWithDefense(0, false, 0, noConditions()));
    }

    @Test
    public void invulnerableConditionZeroesDamage() {
        // conditions[0] bit 0x1000000 = invulnerable.
        assertEquals(0, Projectile.damageWithDefense(100, false, 0, new int[] { 0x1000000, 0 }));
    }

    @Test
    public void armoredConditionRaisesDefenseByHalf() {
        // conditions[0] bit 0x2000000 → defense * 1.5; 40 * 1.5 = 60; 100 - 60 = 40.
        assertEquals(40, Projectile.damageWithDefense(100, false, 40, new int[] { 0x2000000, 0 }));
    }

    @Test
    public void exposedConditionLowersDefenseBy20() {
        // conditions[1] bit 0x20000 → defense - 20; 30 - 20 = 10; 100 - 10 = 90.
        assertEquals(90, Projectile.damageWithDefense(100, false, 30, new int[] { 0, 0x20000 }));
    }

    @Test
    public void damagingConditionAmplifiesByQuarter() {
        // conditions[1] bit 0x40 → dmg * 1.25; 100 * 1.25 = 125.
        assertEquals(125, Projectile.damageWithDefense(100, false, 0, new int[] { 0, 0x40 }));
    }

    @Test
    public void weakConditionReducesByTenth() {
        // conditions[1] bit 0x8 → dmg * 0.9; 100 * 0.9 = 90.
        assertEquals(90, Projectile.damageWithDefense(100, false, 0, new int[] { 0, 0x8 }));
    }
}
