package bridge.replay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import bridge.DpsBroadcaster;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import org.junit.Test;

/**
 * Replays the ~24k-envelope real-world seed corpus ({@code overlay/test/fixtures/captures}'s
 * README, "baseline-session.ndjson.gz") end-to-end through {@code CaptureReplay} - the Java
 * mirror of {@code overlay/test/baseline-session.test.ts} - as a scale/robustness check for
 * issue #192 (PRD §6.5): the harness must survive a real, messy capture (instance churn,
 * reconnects, thousands of stat updates) without throwing, the same bar the TS harness already
 * holds itself to.
 *
 * <p><b>Known harness limitation</b> (discovered via this test; see {@code docs/dps-engine.md}
 * "Capture replay (Java)"): the local player's own damage normally reaches {@link
 * bridge.dps.DpsEngine} through a client-side estimate ({@code PlayerShootPacket} to a
 * seeded-RNG {@code Projectile} to {@code EnemyHitPacket}), and that estimate needs weapon
 * projectile min/max damage from the extracted game asset list ({@code
 * assets.IdToAsset#getIdProjectileMinDmg}/{@code MaxDmg}, backed by {@code
 * assets/xml/Objects.xml}) - data only present on a real game install, never in a bare JUnit
 * environment. So {@code Projectile.getDamage()} is always {@code 0} here regardless of
 * fixture, and {@code Entity#userProjectileHit} silently drops any hit with zero projectile
 * damage - the local player's own {@code EnemyHitPacket} hits in this capture (mainID {@code
 * 5092}, resolved successfully partway through the burst once their {@code UpdatePacket}
 * arrives) never turn into attributed {@code Damage}, independent of the {@code
 * CreateSuccessPacket} bookkeeping working correctly. {@link ReplayAttributionTest}'s fixture
 * sidesteps this by carrying the local player's damage over {@code DamagePacket} instead (a
 * real, asset-independent wire path - see its Javadoc), which is also where this PR's
 * recompute-vs-recorded assertion lives. This capture's own combat (all pre-dating its first
 * {@code MapInfoPacket} - see {@link #realCombatBurstAttributesDamageToMultiplePlayers}) is
 * exercised here only as a real-world-scale robustness check, attributing other players' damage
 * via the (asset-independent) {@code DamagePacket} path same as production.
 */
public class BaselineSessionReplayTest {

    private static Path fixture() {
        return Paths.get("overlay", "test", "fixtures", "captures", "baseline-session.ndjson.gz");
    }

    @Test
    public void replaysEndToEndWithoutExceptions() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes = CaptureReplay.loadCapture(fixture());
        assertTrue("expected the committed baseline corpus to be sizeable, got " + envelopes.size(),
            envelopes.size() > 20_000);

        DpsBroadcaster broadcaster = new DpsBroadcaster();
        CaptureReplay.ReplayStats stats = CaptureReplay.replay(envelopes, broadcaster);

        assertTrue("expected most envelopes to be fed as real packets, got " + stats,
            stats.fed > 15_000);
        assertEquals("every envelope type in this real capture should map to a known PacketType: "
                + stats.unknownTypeCounts,
            0, stats.skippedUnknown);
    }

    @Test
    public void realCombatBurstAttributesDamageToMultiplePlayers() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes = CaptureReplay.loadCapture(fixture());

        long firstMapInfoTime = Long.MAX_VALUE;
        for (CaptureReplay.PacketEnvelope e : envelopes) {
            if ("MapInfoPacket".equals(e.type)) { firstMapInfoTime = e.time; break; }
        }
        assertTrue("expected a MapInfoPacket in the fixture", firstMapInfoTime != Long.MAX_VALUE);

        // The only combat in this fixture is the pre-recording burst still in progress when
        // capture started (see class Javadoc) - replay just that slice, before the first
        // instance change resets engine state.
        DpsBroadcaster broadcaster = new DpsBroadcaster();
        CaptureReplay.replayUntil(envelopes, broadcaster, firstMapInfoTime - 1);

        String snapshotJson = broadcaster.snapshotJson();
        assertTrue("expected the real capture's own combat burst to attribute damage to someone",
            snapshotJson != null);

        JsonObject data = JsonParser.parseString(snapshotJson).getAsJsonObject().getAsJsonObject("data");
        JsonArray enemies = data.getAsJsonArray("enemies");
        assertTrue("expected at least one damaged enemy", enemies.size() > 0);

        boolean anyPlayerDamaged = false;
        for (int i = 0; i < enemies.size(); i++) {
            JsonArray players = enemies.get(i).getAsJsonObject().getAsJsonArray("players");
            for (int j = 0; j < players.size(); j++) {
                if (players.get(j).getAsJsonObject().get("damage").getAsInt() > 0) {
                    anyPlayerDamaged = true;
                }
            }
        }
        assertTrue("expected at least one player with nonzero attributed damage", anyPlayerDamaged);
    }
}
