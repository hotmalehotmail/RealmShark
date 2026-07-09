package bridge;

import bridge.dps.Damage;
import bridge.dps.DpsEngine;
import bridge.dps.Entity;
import com.google.gson.Gson;
import packets.Packet;
import packets.incoming.CreateSuccessPacket;
import packets.incoming.DamagePacket;
import packets.incoming.MapInfoPacket;
import packets.incoming.NewTickPacket;
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;
import packets.outgoing.EnemyHitPacket;
import packets.outgoing.PlayerShootPacket;

import java.util.ArrayList;
import java.util.List;

/**
 * Drives the ported tomato DPS engine ({@link DpsEngine}) from the live packet
 * stream and turns its state into a compact JSON snapshot for the overlay.
 * <p>
 * The engine is fed on the capture thread and read on the flush thread, so all
 * access is guarded by {@code synchronized (engine)}. Every feed is wrapped so a
 * bug in the ported engine can never take down packet capture - DPS is a nicety,
 * capture is not. The emitted envelope mirrors the packet envelopes
 * ({@code {type,direction,time,data}}) with {@code type:"dps"}.
 */
public class DpsBroadcaster {

    private final DpsEngine engine = new DpsEngine();
    private final Gson gson = new Gson();

    /** One-line engine state for the periodic diagnostic log (thread-safe read). */
    public String debugState() {
        synchronized (engine) {
            return engine.debugState();
        }
    }

    /** Feed one decoded packet into the engine (no-op for packet types DPS doesn't use). */
    /**
     * @return true if this packet changed a player's damage total (an
     * {@link EnemyHitPacket} or {@link DamagePacket}), so the caller can push a
     * fresh DPS snapshot promptly instead of waiting for the periodic cadence.
     */
    public boolean feed(Packet packet) {
        boolean damage = false;
        try {
            synchronized (engine) {
                if (packet instanceof MapInfoPacket) {
                    engine.setNewRealm((MapInfoPacket) packet);
                } else if (packet instanceof CreateSuccessPacket) {
                    CreateSuccessPacket p = (CreateSuccessPacket) packet;
                    engine.setUserId(p.objectId, p.charId, p.str);
                } else if (packet instanceof UpdatePacket) {
                    engine.update((UpdatePacket) packet);
                } else if (packet instanceof NewTickPacket) {
                    engine.updateNewTick((NewTickPacket) packet);
                } else if (packet instanceof PlayerShootPacket) {
                    engine.playerShoot((PlayerShootPacket) packet);
                } else if (packet instanceof ServerPlayerShootPacket) {
                    engine.serverPlayerShoot((ServerPlayerShootPacket) packet);
                } else if (packet instanceof EnemyHitPacket) {
                    engine.enemtyHit((EnemyHitPacket) packet);
                    damage = true;
                } else if (packet instanceof DamagePacket) {
                    engine.damage((DamagePacket) packet);
                    damage = true;
                }
            }
        } catch (Throwable t) {
            // Never let an engine bug stall capture.
            System.out.println("[bridge] dps engine feed error: " + t);
            if (System.getenv("DPS_TRACE") != null) t.printStackTrace();
        }
        return damage;
    }

    /**
     * Build the current DPS snapshot as a JSON envelope, or null if there's
     * nothing to report yet. Per enemy the local user has hit, lists each
     * attacking player's total damage and average DPS (pet/minion damage is
     * already attributed to the owning player by the engine).
     */
    public String snapshotJson() {
        try {
            Envelope env = new Envelope();
            env.time = System.currentTimeMillis();
            env.data = new Data();
            env.data.enemies = new ArrayList<>();

            synchronized (engine) {
                for (Entity enemy : engine.getEntityHitList()) {
                    if (enemy == null) continue;
                    List<Damage> perPlayer = enemy.getPlayerDamageList();
                    if (perPlayer == null || perPlayer.isEmpty()) continue;

                    long fightMs = enemy.getFightTimer();
                    double fightSec = fightMs > 0 ? fightMs / 1000.0 : 0;

                    DpsEnemy e = new DpsEnemy();
                    e.id = enemy.id;
                    e.name = enemy.name();
                    e.fightMs = fightMs;
                    e.players = new ArrayList<>();
                    for (Damage d : perPlayer) {
                        if (d == null || d.owner == null) continue;
                        DpsPlayer pl = new DpsPlayer();
                        pl.id = d.owner.id;
                        pl.name = d.owner.name();
                        pl.damage = d.damage;
                        pl.dps = fightSec > 0 ? d.damage / fightSec : 0;
                        e.players.add(pl);
                    }
                    if (!e.players.isEmpty()) env.data.enemies.add(e);
                }
            }
            if (env.data.enemies.isEmpty()) return null;
            return gson.toJson(env);
        } catch (Throwable t) {
            System.out.println("[bridge] dps snapshot error: " + t);
            return null;
        }
    }

    // --- wire shapes (field names are the protocol the overlay consumes) ---

    private static final class Envelope {
        final String type = "dps";
        final String direction = "internal";
        long time;
        Data data;
    }

    private static final class Data {
        List<DpsEnemy> enemies;
    }

    private static final class DpsEnemy {
        int id;
        String name;
        long fightMs;
        List<DpsPlayer> players;
    }

    private static final class DpsPlayer {
        int id;
        String name;
        int damage;
        double dps;
    }
}
