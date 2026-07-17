package bridge.replay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import bridge.DpsBroadcaster;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/**
 * Replay-driven equivalent of the old hand-transcribed
 * {@code DpsEngineOtherPlayerAttributionTest} (issue #46 - the DPS list dropping every other
 * player's damage when {@code assets/xml/players.xml} classification never succeeds), now
 * written from a committed capture instead of by-eye packet transcription. The fixture
 * (`overlay/test/fixtures/captures/replay-attribution.json.gz`) additionally exercises the
 * local player's own attribution (identified via {@code CreateSuccessPacket}) and carries a
 * hand-verified recorded {@code dps} envelope, so this doubles as the PRD's "recompute vs.
 * recorded" assertion (issue #192, {@code docs/dps-engine.md} "Capture replay (Java)").
 *
 * <p>Both attacking players (objectType 782) are deliberately never classified as a player
 * character - same as the real capture behind issue #46 - so attribution can only happen via
 * {@code DpsEngine}'s live-signal bypasses ({@code resolveLocalPlayer} /
 * {@code resolveOtherPlayer}), not the {@code CharacterClass.isPlayerCharacter} gate.
 */
public class ReplayAttributionTest {

    private static Path fixture() {
        return Paths.get("overlay", "test", "fixtures", "captures", "replay-attribution.json.gz");
    }

    @Test
    public void recomputedAttributionMatchesRecordedSnapshot() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes = CaptureReplay.loadCapture(fixture());

        CaptureReplay.PacketEnvelope recorded = null;
        int dpsCount = 0;
        for (CaptureReplay.PacketEnvelope e : envelopes) {
            if ("dps".equals(e.type)) {
                recorded = e;
                dpsCount++;
            }
        }
        assertNotNull("fixture must carry a recorded dps envelope to compare against", recorded);
        assertEquals("fixture should carry exactly one recorded dps envelope, found " + dpsCount,
            1, dpsCount);

        DpsBroadcaster broadcaster = new DpsBroadcaster();
        CaptureReplay.ReplayStats stats = CaptureReplay.replayUntil(envelopes, broadcaster, recorded.time);
        assertTrue("expected every non-synthesized envelope to be fed, got " + stats,
            stats.fed >= 6);
        assertEquals("no unknown packet types expected in this fixture: " + stats,
            0, stats.skippedUnknown);

        String recomputedJson = broadcaster.snapshotJson();
        assertNotNull("recomputed snapshot should be non-null (some enemy took attributed damage)",
            recomputedJson);

        JsonObject recomputed = JsonParser.parseString(recomputedJson).getAsJsonObject();
        assertAttributionMatches(recorded.data.getAsJsonObject(), recomputed);
    }

    /**
     * Structural, tolerance-based comparison per {@code docs/dps-engine.md} ("Capture replay
     * (Java)"): same enemy id set, same attacking-player id set per enemy, and damage/fightMs
     * equal (both are deterministic ints/longs driven entirely by fed packets and the replay
     * clock seam - see {@link bridge.dps.EngineClock} - so no tolerance is needed here; a
     * larger, less controlled capture would want one). {@code dps} is derived from
     * {@code damage/fightSec} and compared with a small floating-point epsilon.
     */
    private static void assertAttributionMatches(JsonObject recordedData, JsonObject recomputed) {
        JsonObject recomputedData = recomputed.getAsJsonObject("data");
        Map<Integer, JsonObject> recordedEnemies = enemiesById(recordedData);
        Map<Integer, JsonObject> recomputedEnemies = enemiesById(recomputedData);

        assertEquals("enemy id set diverged - recorded=" + recordedEnemies.keySet()
                + " recomputed=" + recomputedEnemies.keySet(),
            recordedEnemies.keySet(), recomputedEnemies.keySet());

        for (Map.Entry<Integer, JsonObject> entry : recordedEnemies.entrySet()) {
            int enemyId = entry.getKey();
            JsonObject recordedEnemy = entry.getValue();
            JsonObject recomputedEnemy = recomputedEnemies.get(enemyId);

            assertEquals("fightMs diverged for enemy " + enemyId,
                recordedEnemy.get("fightMs").getAsLong(), recomputedEnemy.get("fightMs").getAsLong());

            Map<Integer, JsonObject> recordedPlayers = playersById(recordedEnemy);
            Map<Integer, JsonObject> recomputedPlayers = playersById(recomputedEnemy);
            assertEquals("attacking-player id set diverged for enemy " + enemyId
                    + " - recorded=" + recordedPlayers.keySet()
                    + " recomputed=" + recomputedPlayers.keySet(),
                recordedPlayers.keySet(), recomputedPlayers.keySet());

            for (Map.Entry<Integer, JsonObject> playerEntry : recordedPlayers.entrySet()) {
                int playerId = playerEntry.getKey();
                JsonObject recordedPlayer = playerEntry.getValue();
                JsonObject recomputedPlayer = recomputedPlayers.get(playerId);

                assertEquals("damage diverged for enemy " + enemyId + " player " + playerId,
                    recordedPlayer.get("damage").getAsInt(), recomputedPlayer.get("damage").getAsInt());
                assertEquals("dps diverged for enemy " + enemyId + " player " + playerId,
                    recordedPlayer.get("dps").getAsDouble(), recomputedPlayer.get("dps").getAsDouble(), 0.001);
            }
        }
    }

    private static Map<Integer, JsonObject> enemiesById(JsonObject data) {
        Map<Integer, JsonObject> byId = new HashMap<>();
        JsonArray enemies = data.getAsJsonArray("enemies");
        for (JsonElement e : enemies) {
            JsonObject enemy = e.getAsJsonObject();
            byId.put(enemy.get("id").getAsInt(), enemy);
        }
        return byId;
    }

    private static Map<Integer, JsonObject> playersById(JsonObject enemy) {
        Map<Integer, JsonObject> byId = new HashMap<>();
        JsonArray players = enemy.getAsJsonArray("players");
        for (JsonElement p : players) {
            JsonObject player = p.getAsJsonObject();
            byId.put(player.get("id").getAsInt(), player);
        }
        return byId;
    }
}
