package bridge.dps;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import java.util.List;
import org.junit.Test;
import packets.data.ObjectData;
import packets.data.ObjectStatusData;
import packets.data.StatData;
import packets.data.WorldPosData;
import packets.incoming.DamagePacket;
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;

/**
 * Regression test for issue #46: the DPS list reliably shows the local player's
 * own damage but most of the time drops every other player's damage.
 *
 * <p>Root cause: {@link DpsEngine#damage} only attributes a hit to an attacker
 * that is already present in {@code playerList}, and {@code playerList} is only
 * populated from {@link DpsEngine#update} when {@code CharacterClass.isPlayerCharacter}
 * recognizes the object type - which depends on {@code assets/xml/players.xml}
 * having been extracted (not guaranteed; see a real capture where {@code players}
 * stayed at 0/1 for an entire session). The local player has a dedicated bypass
 * ({@code resolveLocalPlayer}, driven by {@code EnemyHitPacket.mainID}), but other
 * players had no equivalent, so their damage silently fell into the {@code attacker
 * == null} branch and never appeared in {@code getPlayerDamageList()}.
 *
 * <p>This test never touches {@code CharacterClass} at all (mirroring the real
 * capture, where the classification never succeeded for anyone) and instead relies
 * only on the same kind of live, per-packet identity signal already used for the
 * local player: {@code ServerPlayerShootPacket.summonerId == 0} unambiguously means
 * {@code ownerId} is a real player (a direct, non-summon shot).
 */
public class DpsEngineOtherPlayerAttributionTest {

    private static ObjectData playerObject(int objectId) {
        ObjectData obj = new ObjectData();
        obj.objectType = 782; // arbitrary - deliberately not registered with CharacterClass in tests
        obj.status = new ObjectStatusData();
        obj.status.objectId = objectId;
        obj.status.pos = new WorldPosData();
        obj.status.stats = new StatData[0];
        return obj;
    }

    @Test
    public void attributesDamageFromAnotherPlayerNotClassifiedAsAPlayerType() {
        DpsEngine engine = new DpsEngine();

        int enemyId = 500;
        int otherPlayerId = 777;

        // The other player becomes visible like any other object (entityList gets an
        // entry), but - just like in the real capture - never gets classified as a
        // player type, so it's never added to playerList through the normal path.
        UpdatePacket update = new UpdatePacket();
        update.newObjects = new ObjectData[] { playerObject(otherPlayerId) };
        update.drops = new int[0];
        engine.update(update);

        // The only other signal we ever get for this player: their own direct shot
        // (summonerId == 0, per DpsTracker.ts's ingestShoot comment on the overlay side).
        ServerPlayerShootPacket shoot = new ServerPlayerShootPacket();
        shoot.ownerId = otherPlayerId;
        shoot.summonerId = 0;
        shoot.bulletId = 1;
        shoot.containerType = 1;
        engine.serverPlayerShoot(shoot);

        DamagePacket dmg = new DamagePacket();
        dmg.targetId = enemyId;
        dmg.objectId = otherPlayerId;
        dmg.damageAmount = 50;
        dmg.effects = new int[0];
        engine.damage(dmg);

        Entity enemy = null;
        for (Entity e : engine.getEntityHitList()) {
            if (e.id == enemyId) enemy = e;
        }
        assertNotNull("enemy should be in the hit list after taking damage", enemy);

        List<Damage> perPlayer = enemy.getPlayerDamageList();
        assertEquals("other player's damage should be attributed", 1, perPlayer.size());
        assertEquals(otherPlayerId, perPlayer.get(0).owner.id);
        assertEquals(50, perPlayer.get(0).getDamage());
    }
}
