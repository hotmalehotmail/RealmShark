package bridge;

import assets.IdToAsset;
import bridge.dps.ParseEnchants;
import packets.data.GroundTileData;
import packets.data.ObjectData;
import packets.data.ObjectStatusData;
import packets.data.StatData;
import packets.data.WorldPosData;
import packets.data.enums.StatType;
import packets.incoming.CreateSuccessPacket;
import packets.incoming.DamagePacket;
import packets.incoming.MapInfoPacket;
import packets.incoming.NewTickPacket;
import packets.incoming.QuestObjectIdPacket;
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;
import packets.data.SlotObjectData;
import packets.outgoing.EnemyHitPacket;
import packets.outgoing.InvSwapPacket;
import packets.outgoing.PlayerShootPacket;
import packets.packetcapture.register.Register;

import java.util.Random;

/**
 * Debug packet source. Emits synthetic packets through the same {@link Register}
 * pipeline the real sniffer uses, so the bridge and any UI can be developed
 * without the game or Npcap running. Enabled with the {@code --fake} flag.
 * <p>
 * Emits a stable fake player roster (via an {@link UpdatePacket} carrying
 * NAME_STAT, same shape a real client sees on entering a map), a
 * {@link CreateSuccessPacket} assigning the local player identity to the
 * first roster member, a {@link ServerPlayerShootPacket} establishing a fake
 * pet owned by the local player (to exercise minion-damage attribution),
 * an outgoing {@link EnemyHitPacket} every tick (the local player hitting an
 * enemy - the reliable, continuously-emitted local-player and focus-target
 * signal that does not depend on catching the one-shot CreateSuccessPacket),
 * and loops {@link DamagePacket}s against two distinct fake enemies attributed
 * to random roster members or the fake pet - enough surface to exercise
 * per-enemy DPS tracking, local-player focus-target attribution, minion
 * attribution, and periodic instance resets (a {@link MapInfoPacket} every
 * ~40 ticks).
 * <p>
 * Also exercises the roster/equipment surfaces the Instance panel reads: every
 * roster member carries equipment (not just the local player), some names carry
 * comma-appended title codes (so name-stripping is exercised), a non-local
 * player's weapon is swapped every ~10 ticks (so OTHER players' equipment updates
 * are exercised), and a transient 5th player joins/leaves on a cycle (so roster
 * removal via {@link UpdatePacket}.drops is exercised). The currently-hit enemy
 * also briefly drops from view and reappears every cycle (view-radius churn on a
 * still-alive, still-being-hit target), to exercise the DPS panel's sprite
 * staying resolved across a drop instead of going blank.
 * <p>
 * Each ~40-tick map life also runs a fake boss encounter, to exercise the DPS
 * panel's sticky quest-objective lock (see {@code DpsTracker.ts}): a
 * {@link QuestObjectIdPacket} arms the lock on a fake boss, and the local
 * player's own direct attack (the {@code EnemyHitPacket}/{@code PlayerShootPacket}
 * pair below) immediately targets it too, so the lock actually engages
 * (proving {@code bossDamagedByLocal} flips true - a not-yet-damaged
 * objective must NOT steal focus). Meanwhile teammates keep landing random
 * {@link DamagePacket}s on the two "add" enemies above the whole time
 * (proving the panel doesn't flip away from an engaged boss just because
 * other damage lands elsewhere). A scripted ~2.1s window mid-phase redirects
 * the local player's OWN direct attack to one of those adds continuously -
 * longer than {@code DpsTracker.ts}'s `SUSTAINED_ATTACK_MS` (2000ms) - proving
 * the sustained-attack override reclaims focus, then reverts to the boss the
 * instant attacks return to it (see {@code fightTarget}). A mid-fight phase
 * transition swaps the boss to a new objectId via {@link UpdatePacket}.drops +
 * a fresh {@code QuestObjectIdPacket} (proving the damage total carries over
 * instead of resetting, and the new phase re-engages immediately since the
 * encounter was already damaged), and the fight ends with the final phase
 * despawning with no new objective (proving focus falls back to last-hit
 * afterward).
 * <p>
 * Also registers synthetic {@link IdToAsset} entries (BagType 6/white and
 * 8/orange item ids, their ground-bag entities including a boosted white-bag
 * variant, and an off-tier filler item) and periodically drops loot-bag
 * entities into view via {@link #lootBagDrop} - an {@link UpdatePacket} whose
 * newObject is a bag carrying items in INVENTORY_0..7 plus per-slot enchant
 * codes in UNIQUE_DATA_STRING - so the Loot panel's drop detection, BagType
 * categorization, and per-item enchant/rarity display are demonstrable and
 * regression-testable with no game installed (issue #105).
 * <p>
 * Every roster member's UNIQUE_DATA_STRING stat also carries synthetic
 * per-slot enchant data ({@link #ROSTER_ENCHANTS}, encoded via
 * {@link ParseEnchants#encodeEnchantSlot}), covering all four enchant-count
 * rarity tiers (1-4 filled slots) plus unenchanted (0) gear across the roster
 * - so the overlay's rarity-border rendering (issue #107) is demonstrable and
 * regression-testable with no game installed.
 * <p>
 * Also runs a periodic equip/unequip round-trip on the local player's ability
 * slot ({@link #localSelfSwap} + {@link #localPlayerSlotDeltas}, an
 * {@link InvSwapPacket} naming the local player on both ends immediately
 * followed by the correlated {@link NewTickPacket} slot deltas - the same
 * shape a real client sends), exercising the Character/Instance panels
 * re-rendering a live equip/unequip.
 */
public class FakePacketSource {

    private static final int[] ROSTER_IDS = {1, 2, 3, 4};
    // Some names carry title/label cosmetic codes after a comma (e.g. "Bob,a0ca"),
    // the same shape a real client sends on NAME_STAT. The overlay must strip them
    // down to the bare username - these fake names exercise that stripping.
    private static final String[] ROSTER_NAMES = {"Alice", "Bob,a0ca", "Carol", "Dave,f3b1"};
    private static final int LOCAL_PLAYER_ID = ROSTER_IDS[0]; // "you" are Alice

    private static final int[] ENEMY_IDS = {100_000, 100_001};
    // objectTypes for the two fake enemies - resolved to names via IdToAsset
    // (see the synthetic assets/ObjectID.list used for local testing). Unlike
    // players, enemies carry no NAME_STAT, so their name comes from the type.
    private static final int[] ENEMY_TYPES = {1900, 1901};

    // The two phases of a fake boss encounter - a new objectId per phase, like a
    // real multi-phase boss (e.g. Oryx). QuestObjectIdPacket locks DPS focus onto
    // whichever of these is currently the quest objective; see loop()'s offset-based
    // boss-encounter schedule.
    private static final int[] BOSS_PHASE_IDS = {100_002, 100_003};
    private static final int[] BOSS_PHASE_TYPES = {1902, 1903};

    // A fake pet owned by the local player, to exercise minion-damage attribution.
    private static final int PET_ID = 50;

    // Weapon the local player "fires" (must exist in the loaded assets/ObjectID.list
    // with projectile damage) so the engine can compute self-damage from the
    // outgoing PlayerShoot -> EnemyHit projectile path.
    private static final int WEAPON_ID = 4000;

    // The local player's equipped skin (SKIN_ID, an objectType), so the overlay's
    // Character panel can render a skinned sprite in fake mode.
    private static final int LOCAL_SKIN_ID = 2500;

    // Each roster member's 4 equipped slots (INVENTORY_0..3: weapon/ability/armor/
    // ring, each an item objectType), so the Instance panel renders EVERY player's
    // loadout, not just the local one. The local player's slot 0 must be WEAPON_ID -
    // the self-damage path fires it. Values are arbitrary plausible objectTypes; the
    // overlay resolves them through the shared Sprite path (real atlas sprite if
    // assets loaded, else a stable per-type placeholder colour).
    private static final int[][] ROSTER_EQUIPMENT = {
        {WEAPON_ID, 4100, 4200, 4300}, // Alice (local)
        {4001, 4101, 4201, 4301},      // Bob
        {4002, 4102, 4202, 4302},      // Carol
        {4003, 4103, 4203, 4303}       // Dave
    };

    // Per-roster-member filled-enchant-slot counts (weapon/ability/armor/ring),
    // 0-4 each - the rarity derivation issue #107 uses (0=common/no border,
    // 1=uncommon, 2=rare, 3=legendary, 4=divine), and the same encoded slots
    // feed the item tooltip's enchant-id list (issue #109; ids resolve to the
    // bare-id fallback headless). Alice covers all four tiers in one row; Bob
    // is fully unenchanted (known-empty slots - the tooltip's "No
    // enchantments" state); Carol mixes tiers; Dave (null) sends no
    // UNIQUE_DATA_STRING stat at all (tooltip shows no enchant section).
    private static final int[][] ROSTER_ENCHANTS = {
        {1, 2, 3, 4}, // Alice (local): one of each tier
        {0, 0, 0, 0}, // Bob: fully unenchanted
        {4, 0, 2, 0}, // Carol: mixed
        null          // Dave: no enchant stat at all
    };

    // A non-local player whose weapon we periodically swap, to prove OTHER players'
    // equipment updates render (not just the local player's) - the merge/render path
    // is identical for every objectId. Cycling the weapon objectType changes the
    // icon (a distinct placeholder colour per type even without real assets).
    private static final int SWAP_PLAYER_ID = ROSTER_IDS[1]; // Bob
    private static final int[] SWAP_WEAPONS = {4001, 4010, 4020, 4030};

    // A transient player who joins then leaves on a cycle, so the roster is exercised
    // reacting to players LEAVING (UpdatePacket.drops), not only joining.
    private static final int TRANSIENT_ID = 5;
    private static final String TRANSIENT_NAME = "Eve,7f2c";
    private static final int[] TRANSIENT_EQUIPMENT = {4005, 4105, 4205, 4305};
    private static final int[] TRANSIENT_ENCHANTS = {2, 0, 4, 1};

    // Loot panel demo (issue #105): the ground-bag ENTITIES the drop tracker
    // watches for - one per tracked color (6 = white, 8 = orange/ST - see
    // docs/asset-pipeline.md), plus a boosted white-bag variant proving the
    // bridge's lootBagObjectTypes covers more than one entity per color and the
    // tracker detects them all. Seeded from the committed asset-facts.json
    // (issue #189) so --fake traffic carries the REAL object ids and names -
    // real bag entities are Class=Container identified only by their id string
    // ("Loot Bag <N>[ Boost]"), so inventing Class=Bag entries here validated a
    // scan that matches nothing on live assets (the loot saga, soaks
    // #113/#144). The old synthetic ids remain as fallback for a build whose
    // jar predates the facts resource.
    private static final assets.facts.AssetFacts FACTS = assets.facts.AssetFacts.loadBundled();
    private static final int WHITE_BAG_ICON_TYPE = factsEntityType(6, false, 9000);
    private static final int ORANGE_BAG_ICON_TYPE = factsEntityType(8, false, 9001);
    private static final int BOOSTED_WHITE_BAG_ICON_TYPE = factsEntityType(6, true, 9002);
    // Item objectTypes seeded with a BagType: white + orange (both tracked),
    // and a BagType-3 filler (NOT tracked - an item sharing a bag which must
    // never appear in the Loot panel, proving per-item filtering). Real item
    // ids from the facts file, or the legacy synthetic ids without it.
    private static final int WHITE_ITEM_TYPE = factsItemType(6, 9100);
    private static final int ORANGE_ITEM_TYPE = factsItemType(8, 9200);
    private static final int FILLER_ITEM_TYPE = factsItemType(3, 9300);

    /** Lowest-id facts entity with this bagType/boosted flag, or {@code fallback} when no facts are bundled. */
    private static int factsEntityType(int bagType, boolean boosted, int fallback) {
        if (FACTS == null || FACTS.entities == null) return fallback;
        return FACTS.entities.entrySet().stream()
            .filter(e -> e.getValue().bagType == bagType && e.getValue().boosted == boosted)
            .mapToInt(e -> Integer.parseInt(e.getKey()))
            .min()
            .orElse(fallback);
    }

    /** Registers a facts item under its real id with real name/tier/bagType, so the Loot panel and tooltips show real data. */
    private static void registerFactsItem(int type) {
        assets.facts.AssetFacts.Item item = FACTS.items.get(String.valueOf(type));
        if (item == null) return;
        IdToAsset.registerFake(
            type, "Equipment", item.bagType,
            item.tier == null ? "" : item.tier,
            item.displayId != null ? item.displayId : item.name,
            "Facts-seeded real item (" + item.name + ", asset-facts.json)."
        );
    }

    /** Lowest-id facts item with this bagType, or {@code fallback} when no facts are bundled. */
    private static int factsItemType(int bagType, int fallback) {
        if (FACTS == null || FACTS.items == null) return fallback;
        return FACTS.items.entrySet().stream()
            .filter(e -> e.getValue().bagType == bagType)
            .mapToInt(e -> Integer.parseInt(e.getKey()))
            .min()
            .orElse(fallback);
    }
    // Fresh objectId per simulated bag drop, safely above every fixed entity id
    // (roster/pet <= 50, enemies/boss in the 100_000s).
    private static final int LOOT_BAG_ID_BASE = 200_000;

    // Equip/unequip demo (issue #122): the local player's ability slot
    // (INVENTORY_1_STAT) round-trips into bag slot 6 (INVENTORY_6_STAT) and
    // back - see the class doc comment. Ticks chosen out of phase with the
    // 40-tick map-reset/24-tick transient/16-tick loot-drop schedules above,
    // purely so the three demos don't visually overlap.
    private static final int EQUIP_SWAP_ABILITY_ITEM = ROSTER_EQUIPMENT[0][1];
    private static final int EQUIP_SWAP_BAG_SLOT_ID = 6;
    private static final int EQUIP_SWAP_CYCLE_TICKS = 48;

    // Item tooltip demo (issue #109): seeds a couple of the ids above with
    // IdToAsset.registerFake's item-info fields (tier/display name/description),
    // so the hover tooltip mechanism is exercisable end-to-end even with no
    // game installed - one equipped item (WEAPON_ID, hovered via GearRow) and
    // one loot item (WHITE_ITEM_TYPE, hovered via the Loot panel). Every other
    // fake objectType deliberately stays unregistered, exercising the tooltip's
    // "no resolvable data" fallback (shows just the objectType).
    // Ticks between simulated bag drops - long enough that each is a distinct,
    // legible event rather than a flicker.
    private static final int LOOT_CYCLE_TICKS = 16;

    // Set FAKE_NO_CREATE_SUCCESS to simulate a mid-session attach: the engine
    // never sees CreateSuccessPacket and must fall back to EnemyHitPacket.mainID
    // to identify the local player (exercises DpsEngine.resolveLocalPlayer).
    private static final boolean SKIP_CREATE_SUCCESS =
        System.getenv("FAKE_NO_CREATE_SUCCESS") != null;

    private final Random rng = new Random();
    private int mapNumber = 1;

    /** Start emitting fake packets on a background daemon thread. */
    public void start() {
        // Registered synchronously (not on the loop thread) so they're present
        // as early as possible; IdToAsset.reloadAssets() re-applies these after
        // any (real-mode-only, here always a no-op) background reload, so this
        // can't race away regardless of ObjectNames.init's own asset-loader
        // thread ordering.
        if (FACTS != null && FACTS.entities != null) {
            // Facts-seeded (issue #189): register every real tracked-color bag
            // entity with its REAL id name and class. Like live assets, none of
            // these matches the legacy Class=Bag scan - discovery goes through
            // the id-name rule (IdToAsset.lootBagEntityTypes), so --fake mode
            // exercises the same code path the real client does, boosted
            // variants included.
            FACTS.entities.forEach((key, entity) -> {
                if (entity.bagType != 6 && entity.bagType != 8) return;
                IdToAsset.registerFakeNamed(Integer.parseInt(key), entity.name, entity.clazz, -1);
            });
            registerFactsItem(ORANGE_ITEM_TYPE);
            registerFactsItem(FILLER_ITEM_TYPE);
            registerFactsItem(WHITE_ITEM_TYPE);
        } else {
            IdToAsset.registerFake(WHITE_BAG_ICON_TYPE, "Bag", 6);
            IdToAsset.registerFake(ORANGE_BAG_ICON_TYPE, "Bag", 8);
            IdToAsset.registerFake(BOOSTED_WHITE_BAG_ICON_TYPE, "Bag", 6);
            IdToAsset.registerFake(ORANGE_ITEM_TYPE, "Equipment", 8);
            IdToAsset.registerFake(FILLER_ITEM_TYPE, "Equipment", 3);
            IdToAsset.registerFake(
                WHITE_ITEM_TYPE, "Equipment", 6, "8",
                "Fake Potion of Testing", "A synthetic loot item seeded by --fake mode for the item tooltip demo."
            );
        }
        IdToAsset.registerFake(
            WEAPON_ID, "Equipment", -1, "UT",
            "Fake Sword of Testing", "A synthetic weapon seeded by --fake mode for the item tooltip demo."
        );

        Thread t = new Thread(this::loop, "fake-packet-source");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        int tick = 0;
        // Enter a map first, like a real client: MapInfoPacket seeds the engine's
        // RNG, which the weapon-damage roll needs (no seed -> 0-damage shots).
        Register.INSTANCE.emitPacketLogs(mapInfo());
        if (!SKIP_CREATE_SUCCESS) Register.INSTANCE.emitPacketLogs(createSuccess());
        while (!Thread.currentThread().isInterrupted()) {
            // Resend the roster and pet-ownership mapping periodically (real
            // UpdatePackets/ServerPlayerShootPackets only arrive on specific
            // events) so a client that connects even a moment late still picks
            // them up within a few seconds, not never.
            if (tick % 15 == 0) {
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
                Register.INSTANCE.emitPacketLogs(enemyUpdate());
                Register.INSTANCE.emitPacketLogs(petOwnership());
            }
            // Simulate periodic instance transitions to exercise the DPS tracker's reset.
            // Resend the roster/pet-ownership mapping right away too - a real client
            // gets a fresh burst of entity data immediately after entering a map, not
            // on some independent cadence, and waiting would leave a misleadingly
            // "unattributed" gap that doesn't reflect real play (instance changes
            // don't recur every few seconds like this fake loop's do).
            if (tick > 0 && tick % 40 == 0) {
                Register.INSTANCE.emitPacketLogs(mapInfo());
                if (!SKIP_CREATE_SUCCESS) Register.INSTANCE.emitPacketLogs(createSuccess());
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
                Register.INSTANCE.emitPacketLogs(enemyUpdate());
                Register.INSTANCE.emitPacketLogs(petOwnership());
            }
            // A transient player joins (tick%24==6) then leaves (tick%24==18) on a
            // cycle, so the roster reacts to players LEAVING via UpdatePacket.drops,
            // not only joining. Stateless schedule - safe across the periodic resets
            // (a stray leave for an already-cleared player is a harmless no-op).
            if (tick % 24 == 6) {
                Register.INSTANCE.emitPacketLogs(transientJoin());
            } else if (tick % 24 == 18) {
                Register.INSTANCE.emitPacketLogs(transientLeave());
            }
            // Equip/unequip round-trip demo (issue #122) - see class doc comment.
            // The outgoing InvSwapPacket (naming the local player on both ends)
            // is emitted first, then the correlated slot deltas ride along on
            // this tick's NewTickPacket below (see equipSwapStatus) - matching a
            // real client's ordering (the client requests the swap, the server
            // then confirms it via the next tick's stat deltas).
            int equipOffset = tick % EQUIP_SWAP_CYCLE_TICKS;
            if (equipOffset == 10) {
                // Unequip: ability slot -> bag slot. The bag slot's resulting
                // empty->populated transition is exactly the false-positive
                // LootTracker used to log as a pickup.
                Register.INSTANCE.emitPacketLogs(localSelfSwap(1, EQUIP_SWAP_BAG_SLOT_ID));
            } else if (equipOffset == 14) {
                // Re-equip: bag slot -> ability slot, restoring steady state.
                Register.INSTANCE.emitPacketLogs(localSelfSwap(EQUIP_SWAP_BAG_SLOT_ID, 1));
            }
            // Fake boss encounter, scheduled against this map's 40-tick life (see the
            // tick%40==0 instance-reset block above): phase 1 locks in at offset 2,
            // transitions to phase 2 (new objectId) at offset 20 - dropping phase 1 and
            // carrying its damage forward - and phase 2 dies at offset 38 with no
            // further QuestObjectIdPacket, so focus falls back to last-hit for the rest
            // of the map's life. Teammates' random damage (randomDamage(), below) keeps
            // landing on both fake "adds" (ENEMY_IDS) throughout, so a correct tracker
            // must never flip focus to them just from that while the boss is engaged -
            // see fightTarget() for what the local player's OWN attack targets, which is
            // what actually arms/holds/overrides the lock.
            int bossOffset = tick % 40;
            if (bossOffset == 2) {
                Register.INSTANCE.emitPacketLogs(bossUpdate(0));
                Register.INSTANCE.emitPacketLogs(questObjective(BOSS_PHASE_IDS[0]));
            } else if (bossOffset == 20) {
                Register.INSTANCE.emitPacketLogs(enemyDrop(BOSS_PHASE_IDS[0]));
                Register.INSTANCE.emitPacketLogs(bossUpdate(1));
                Register.INSTANCE.emitPacketLogs(questObjective(BOSS_PHASE_IDS[1]));
            } else if (bossOffset == 38) {
                Register.INSTANCE.emitPacketLogs(enemyDrop(BOSS_PHASE_IDS[1]));
            }
            if (bossOffset >= 2 && bossOffset < 20) {
                Register.INSTANCE.emitPacketLogs(bossDamage(BOSS_PHASE_IDS[0]));
            } else if (bossOffset >= 21 && bossOffset < 38) {
                Register.INSTANCE.emitPacketLogs(bossDamage(BOSS_PHASE_IDS[1]));
            }
            // Every LOOT_CYCLE_TICKS a fresh loot bag drops into view (a real
            // UpdatePacket.newObjects bag entity with items + enchants), so the
            // Loot panel logs it as a DROP - no pickup required. See lootBagDrop().
            if (tick > 0 && tick % LOOT_CYCLE_TICKS == 0) {
                Register.INSTANCE.emitPacketLogs(lootBagDrop(tick / LOOT_CYCLE_TICKS));
            }
            // A NewTickPacket every tick, like a real client. It carries the
            // server clock the DPS engine uses as its time base - without it the
            // engine can't measure fight duration, so every computed DPS is 0.
            // Every ~10 ticks it also carries a non-local player's weapon swap, so
            // the Instance panel shows OTHER players' equipment updating live (the
            // merge/render path is identical for every objectId), and at the two
            // equip-swap offsets above it carries that swap's correlated 2-slot
            // delta (see equipSwapStatus()).
            NewTickPacket nt = newTick(tick);
            java.util.List<ObjectStatusData> status = new java.util.ArrayList<>();
            if (tick > 0 && tick % 10 == 0) {
                status.add(weaponSwapStatus(tick));
            }
            ObjectStatusData equipSwap = equipSwapStatus(equipOffset);
            if (equipSwap != null) status.add(equipSwap);
            if (!status.isEmpty()) {
                nt.status = status.toArray(new ObjectStatusData[0]);
            }
            Register.INSTANCE.emitPacketLogs(nt);
            // The local player firing then landing a hit, every tick like a real
            // client during sustained fire: the outgoing PlayerShoot creates the
            // projectile (its damage computed from the weapon + player stats), and
            // the matching EnemyHit (same bulletId) applies it. This is the actual
            // self-DPS path, and EnemyHitPacket.mainID also identifies the local
            // player. See fightTarget() for what it targets and why.
            short bulletId = (short) (tick % 100);
            int target = fightTarget(bossOffset, tick);
            // Simulate view-radius churn: the enemy currently being fought briefly
            // drops out of the visible-object list (still alive, still landing
            // hits) then reappears - a real client does this constantly in a
            // crowded room even for a stationary melee target. Reproduces issue
            // #48: the DPS panel's sprite going blank for a live focus target
            // that's just momentarily out of view, not actually dead. Phases 12/15
            // are chosen to never land on a boss-target tick (see fightTarget) in
            // either boss phase - dropping the actual locked boss here would
            // trigger onBossDespawn and disarm the sticky lock mid-fight, which
            // isn't what this churn simulation is testing.
            int churnPhase = tick % 20;
            if (churnPhase == 12) {
                Register.INSTANCE.emitPacketLogs(enemyDrop(target));
            } else if (churnPhase == 15) {
                Register.INSTANCE.emitPacketLogs(enemyUpdate());
            }
            Register.INSTANCE.emitPacketLogs(localPlayerShoot(bulletId));
            Register.INSTANCE.emitPacketLogs(localPlayerHit(target, bulletId));
            Register.INSTANCE.emitPacketLogs(randomDamage());
            tick++;
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /**
     * What the local player's own direct attack (localPlayerShoot/localPlayerHit)
     * targets this tick - the signal that actually drives DpsTracker.ts's sticky
     * boss lock (arm/hold/override), as opposed to bossDamage()/randomDamage()
     * below, which simulate teammates' damage and must never affect focus.
     * While a boss phase is alive (`bossOffset` in its window), attacks default
     * to the boss itself - so the lock arms within a tick or two of it spawning -
     * except for an 8-tick window mid-phase (offsets 10-17 in phase 1, 28-35 in
     * phase 2) where they're redirected to one of the fake adds instead: the
     * first and last add-hit in that window are 7 ticks apart (2100ms, just past
     * DpsTracker.ts's SUSTAINED_ATTACK_MS = 2000ms), so it actually crosses the
     * threshold and exercises the sustained-attack override reclaiming focus -
     * then the last two ticks before each phase despawns (18-19 / 36-37) return
     * to the boss to exercise reclaiming focus with a direct hit. Outside any
     * boss phase, cycles between the two adds every 20 ticks, exercising plain
     * last-hit focus switching.
     */
    private int fightTarget(int bossOffset, int tick) {
        if (bossOffset >= 2 && bossOffset < 20) {
            boolean overrideWindow = bossOffset >= 10 && bossOffset < 18;
            return overrideWindow ? ENEMY_IDS[0] : BOSS_PHASE_IDS[0];
        }
        if (bossOffset >= 21 && bossOffset < 38) {
            boolean overrideWindow = bossOffset >= 28 && bossOffset < 36;
            return overrideWindow ? ENEMY_IDS[1] : BOSS_PHASE_IDS[1];
        }
        return ENEMY_IDS[(tick / 20) % ENEMY_IDS.length];
    }

    /** Assigns the local-player identity to the first roster member, same as a real CreateSuccessPacket. */
    private CreateSuccessPacket createSuccess() {
        CreateSuccessPacket p = new CreateSuccessPacket();
        p.objectId = LOCAL_PLAYER_ID;
        p.charId = 1;
        p.str = "";
        return p;
    }

    /**
     * The local player landing a hit on an enemy - an outgoing packet a real
     * client sends on every one of its own hits. mainID (and shooterID, for a
     * direct player shot) is the local player's objectId; targetId is the enemy.
     */
    private EnemyHitPacket localPlayerHit(int target, short bulletId) {
        EnemyHitPacket p = new EnemyHitPacket();
        p.time = 0;
        p.bulletId = bulletId;
        p.shooterID = LOCAL_PLAYER_ID;
        p.targetId = target;
        p.kill = false;
        p.mainID = LOCAL_PLAYER_ID;
        return p;
    }

    /** The local player firing WEAPON_ID - the outgoing packet the engine turns into a damage-carrying projectile. */
    private PlayerShootPacket localPlayerShoot(short bulletId) {
        PlayerShootPacket p = new PlayerShootPacket();
        p.time = 0;
        p.bulletId = bulletId;
        p.weaponId = WEAPON_ID;
        p.projectileId = 0;
        p.startingPos = new WorldPosData();
        p.angle = 0;
        p.isBurst = false;
        p.patternIdx = 0;
        p.attackType = 0;
        p.playerPosition = new WorldPosData();
        return p;
    }

    /** A NewTickPacket carrying an advancing server clock (~300ms/tick), the engine's time base. */
    private NewTickPacket newTick(int tick) {
        NewTickPacket p = new NewTickPacket();
        p.tickId = tick;
        p.tickTime = 300;
        p.serverRealTimeMS = tick * 300;
        p.serverLastTimeRTTMS = 0;
        p.status = new ObjectStatusData[0];
        return p;
    }

    /** Establishes that PET_ID is a summon owned by the local player. */
    private ServerPlayerShootPacket petOwnership() {
        ServerPlayerShootPacket p = new ServerPlayerShootPacket();
        p.bulletId = 0;
        p.ownerId = PET_ID;
        p.containerType = 0;
        p.startingPos = new WorldPosData();
        p.angle = 0;
        p.damage = 0;
        p.summonerId = LOCAL_PLAYER_ID;
        return p;
    }

    /** A one-time UpdatePacket introducing a stable roster of named fake players. */
    private UpdatePacket rosterUpdate() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        p.newObjects = new ObjectData[ROSTER_IDS.length];
        for (int i = 0; i < ROSTER_IDS.length; i++) {
            ObjectStatusData status = new ObjectStatusData();
            status.objectId = ROSTER_IDS[i];
            status.pos = new WorldPosData();
            // Every player carries name + 4 equipped slots; the local player also
            // gets a skin + dyes, so both the Character and Instance panels render.
            status.stats = ROSTER_IDS[i] == LOCAL_PLAYER_ID
                ? localPlayerStats(ROSTER_NAMES[i], ROSTER_EQUIPMENT[i], ROSTER_ENCHANTS[i])
                : playerStats(ROSTER_NAMES[i], ROSTER_EQUIPMENT[i], ROSTER_ENCHANTS[i]);

            ObjectData obj = new ObjectData();
            obj.objectType = 0x0300; // player class 768, matches the synthetic players.xml
            obj.status = status;
            p.newObjects[i] = obj;
        }
        return p;
    }

    /**
     * A NewTick status entry swapping SWAP_PLAYER_ID's weapon (INVENTORY_0) to a
     * cycling objectType - a mid-view equipment change on a NON-local player, which
     * the overlay merges and re-renders exactly as it does the local player's.
     */
    private ObjectStatusData weaponSwapStatus(int tick) {
        ObjectStatusData st = new ObjectStatusData();
        st.objectId = SWAP_PLAYER_ID;
        st.pos = new WorldPosData();
        st.stats = new StatData[]{
            stat(StatType.INVENTORY_0_STAT, SWAP_WEAPONS[(tick / 10) % SWAP_WEAPONS.length])
        };
        return st;
    }

    /**
     * A loot bag dropping into view: an {@link UpdatePacket} whose single
     * newObject is a loot-bag entity (a Class=Bag objectType) carrying its
     * items in INVENTORY_0..7 plus a UNIQUE_DATA_STRING of per-slot enchant
     * codes - exactly the shape a real client renders enchant pips from on
     * hover, and what the overlay's LootTracker reads. Cycles white /
     * orange / boosted-white, each with a fresh objectId, so the Loot panel
     * accumulates distinct DROP entries (no pickup required): the white bag
     * pairs an enchanted white item with an off-tier filler that must NOT be
     * listed (proving per-item filtering), the orange bag carries a
     * more-enchanted orange item, and the boosted bag proves both the boosted
     * entity's detection and a zero-enchant item. The previous bag is despawned
     * ({@link UpdatePacket}.drops) so bags don't pile up in view.
     */
    private UpdatePacket lootBagDrop(int cycle) {
        int bagObjectType;
        int[] items;
        int[] enchantCounts;
        int variant = cycle % 3;
        if (variant == 1) {
            bagObjectType = ORANGE_BAG_ICON_TYPE;
            items = new int[]{ORANGE_ITEM_TYPE};
            enchantCounts = new int[]{3};
        } else if (variant == 2) {
            bagObjectType = BOOSTED_WHITE_BAG_ICON_TYPE;
            items = new int[]{WHITE_ITEM_TYPE};
            enchantCounts = new int[]{0};
        } else {
            bagObjectType = WHITE_BAG_ICON_TYPE;
            items = new int[]{WHITE_ITEM_TYPE, FILLER_ITEM_TYPE};
            enchantCounts = new int[]{2, 0};
        }

        ObjectStatusData bag = new ObjectStatusData();
        bag.objectId = LOOT_BAG_ID_BASE + cycle;
        bag.pos = new WorldPosData();
        java.util.List<StatData> stats = new java.util.ArrayList<>();
        for (int i = 0; i < items.length; i++) {
            stats.add(invStat(i, items[i]));
        }
        stats.add(stringStat(StatType.UNIQUE_DATA_STRING, enchantUniqueDataString(enchantCounts)));
        bag.stats = stats.toArray(new StatData[0]);

        ObjectData obj = new ObjectData();
        obj.objectType = bagObjectType;
        obj.status = bag;

        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.newObjects = new ObjectData[]{obj};
        // Despawn the previous bag (the first drop, cycle 1, has no predecessor).
        p.drops = cycle > 1 ? new int[]{LOOT_BAG_ID_BASE + cycle - 1} : new int[0];
        return p;
    }

    /** One loot-bag content slot (slotIndex 0-7 -> INVENTORY_0..7, statTypeNum 8-15). */
    private static StatData invStat(int slotIndex, int value) {
        int num = StatType.INVENTORY_0_STAT.get() + slotIndex;
        StatData s = new StatData();
        s.statTypeNum = num;
        s.statType = StatType.byOrdinal(num);
        s.statValue = value;
        s.statValueTwo = -1;
        return s;
    }

    /** An UpdatePacket adding the transient player to the instance (a player joining). */
    private UpdatePacket transientJoin() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        ObjectStatusData status = new ObjectStatusData();
        status.objectId = TRANSIENT_ID;
        status.pos = new WorldPosData();
        status.stats = playerStats(TRANSIENT_NAME, TRANSIENT_EQUIPMENT, TRANSIENT_ENCHANTS);

        ObjectData obj = new ObjectData();
        obj.objectType = 0x0300; // player class 768, matches the synthetic players.xml
        obj.status = status;
        p.newObjects = new ObjectData[]{obj};
        return p;
    }

    /** An UpdatePacket dropping the transient player from the instance (a player leaving). */
    private UpdatePacket transientLeave() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.newObjects = new ObjectData[0];
        p.drops = new int[]{TRANSIENT_ID};
        return p;
    }

    /**
     * One InvSwapPacket moving an item between two of the local player's own
     * slots (weapon=0/ability=1/armor=2/ring=3, bag=4..11 - see
     * packets/data/SlotObjectData.java) - see the equip/unequip demo in the
     * class doc comment.
     */
    private InvSwapPacket localSelfSwap(int fromSlotId, int toSlotId) {
        InvSwapPacket p = new InvSwapPacket();
        p.time = 0;
        p.playerWorldPos = new WorldPosData();
        p.slotFrom = new SlotObjectData();
        p.slotFrom.objectId = LOCAL_PLAYER_ID;
        p.slotFrom.slotId = fromSlotId;
        p.slotTo = new SlotObjectData();
        p.slotTo.objectId = LOCAL_PLAYER_ID;
        p.slotTo.slotId = toSlotId;
        return p;
    }

    /**
     * The correlated 2-slot stat delta for the equip-swap demo's current tick
     * offset (see {@link #localSelfSwap} and the class doc comment), or null
     * on a tick with nothing to report. Both slots change in the SAME status
     * update, like a real client's atomic swap confirmation.
     */
    private ObjectStatusData equipSwapStatus(int equipOffset) {
        if (equipOffset == 10) {
            return localPlayerSlotDeltas(
                StatType.INVENTORY_1_STAT, -1,
                StatType.INVENTORY_6_STAT, EQUIP_SWAP_ABILITY_ITEM);
        }
        if (equipOffset == 14) {
            return localPlayerSlotDeltas(
                StatType.INVENTORY_6_STAT, -1,
                StatType.INVENTORY_1_STAT, EQUIP_SWAP_ABILITY_ITEM);
        }
        return null;
    }

    /** One local-player NewTickPacket status update carrying 2 correlated slot deltas - see {@link #localSelfSwap}. */
    private ObjectStatusData localPlayerSlotDeltas(StatType typeA, int valueA, StatType typeB, int valueB) {
        ObjectStatusData st = new ObjectStatusData();
        st.objectId = LOCAL_PLAYER_ID;
        st.pos = new WorldPosData();
        st.stats = new StatData[]{stat(typeA, valueA), stat(typeB, valueB)};
        return st;
    }

    /** A numeric stat entry. */
    private static StatData stat(StatType type, int value) {
        StatData s = new StatData();
        s.statTypeNum = type.get();
        s.statType = type;
        s.statValue = value;
        s.statValueTwo = -1;
        return s;
    }

    /** A string stat entry (e.g. NAME_STAT, UNIQUE_DATA_STRING). */
    private static StatData stringStat(StatType type, String value) {
        StatData s = new StatData();
        s.statTypeNum = type.get();
        s.statType = type;
        s.stringStatValue = value;
        s.statValueTwo = -1;
        return s;
    }

    /**
     * Encodes 4 per-slot enchant counts (weapon/ability/armor/ring, 0-4 each)
     * into UNIQUE_DATA_STRING's comma-separated 4-slot wire shape - see
     * {@link ParseEnchants#getEnchantStrings}/{@link ParseEnchants#encodeEnchantSlot}.
     */
    private static String enchantUniqueDataString(int[] slotEnchantCounts) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < slotEnchantCounts.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(ParseEnchants.encodeEnchantSlot(slotEnchantCounts[i]));
        }
        return sb.toString();
    }

    /**
     * A realistic player stat block. The DPS engine reads the full base+boost
     * stat set (Entity.calculateBaseStats) plus ATTACK/CONDITION/exalt for the
     * damage multiplier, so a real client always sends all of these - the fake
     * source must too or the engine can't compute a maxed player's damage.
     *
     * @param enchantCounts filled-enchant-slot count per equipped slot (0-4 each,
     *                      weapon/ability/armor/ring) - see {@link #ROSTER_ENCHANTS}.
     *                      Null omits the UNIQUE_DATA_STRING stat entirely (this
     *                      player reports no enchant data at all - the tooltip's
     *                      no-enchant-section state).
     */
    private StatData[] playerStats(String name, int[] equipment, int[] enchantCounts) {
        StatData nameStat = new StatData();
        nameStat.statTypeNum = StatType.NAME_STAT.get();
        nameStat.statType = StatType.NAME_STAT;
        nameStat.stringStatValue = name;
        nameStat.statValueTwo = -1;

        StatData[] base = {
            nameStat,
            stat(StatType.INVENTORY_0_STAT, equipment[0]),
            stat(StatType.INVENTORY_1_STAT, equipment[1]),
            stat(StatType.INVENTORY_2_STAT, equipment[2]),
            stat(StatType.INVENTORY_3_STAT, equipment[3]),
            stat(StatType.MAX_HP_STAT, 770), stat(StatType.HP_STAT, 770),
            stat(StatType.MAX_MP_STAT, 252), stat(StatType.MP_STAT, 252),
            stat(StatType.ATTACK_STAT, 75), stat(StatType.DEFENSE_STAT, 25),
            stat(StatType.SPEED_STAT, 75), stat(StatType.DEXTERITY_STAT, 75),
            stat(StatType.VITALITY_STAT, 40), stat(StatType.WISDOM_STAT, 75),
            stat(StatType.CONDITION_STAT, 0), stat(StatType.NEW_CON_STAT, 0),
            stat(StatType.MAX_HP_BOOST_STAT, 0), stat(StatType.MAX_MP_BOOST_STAT, 0),
            stat(StatType.ATTACK_BOOST_STAT, 0), stat(StatType.DEFENSE_BOOST_STAT, 0),
            stat(StatType.SPEED_BOOST_STAT, 0), stat(StatType.DEXTERITY_BOOST_STAT, 0),
            stat(StatType.VITALITY_BOOST_STAT, 0), stat(StatType.WISDOM_BOOST_STAT, 0),
            stat(StatType.EXALTATION_BONUS_DAMAGE, 1000) // /1000 -> x1.0 multiplier
        };
        if (enchantCounts == null) return base;

        StatData[] all = new StatData[base.length + 1];
        System.arraycopy(base, 0, all, 0, base.length);
        all[base.length] = stringStat(
            StatType.UNIQUE_DATA_STRING,
            enchantUniqueDataString(enchantCounts)
        );
        return all;
    }

    /**
     * The local player's stat block: {@link #playerStats} (name + the 4 equipped
     * slots) extended with an equipped skin (SKIN_ID) and clothing/accessory dyes,
     * so the overlay's Character panel renders the player's skinned, dyed sprite +
     * loadout. Same shape a real client sends.
     */
    private StatData[] localPlayerStats(String name, int[] equipment, int[] enchantCounts) {
        StatData[] base = playerStats(name, equipment, enchantCounts);
        StatData[] extra = {
            stat(StatType.SKIN_ID, LOCAL_SKIN_ID),
            // Clothing (Tex1) / accessory (Tex2) dyes, as dye objectTypes, so the
            // dye tracking + compositing path is exercised in fake mode too.
            stat(StatType.TEX1_STAT, 4149),
            stat(StatType.TEX2_STAT, 4967)
        };
        StatData[] all = new StatData[base.length + extra.length];
        System.arraycopy(base, 0, all, 0, base.length);
        System.arraycopy(extra, 0, all, base.length, extra.length);
        return all;
    }

    /** Enemy stat block: what the defense/condition damage calc reads. */
    private StatData[] enemyStats() {
        return new StatData[]{
            stat(StatType.MAX_HP_STAT, 20000), stat(StatType.HP_STAT, 20000),
            stat(StatType.DEFENSE_STAT, 0),
            stat(StatType.CONDITION_STAT, 0), stat(StatType.NEW_CON_STAT, 0)
        };
    }

    /**
     * Introduces the two fake enemies as map objects carrying an objectType but
     * no NAME_STAT, exactly as the real client sees a monster. The bridge's
     * ObjectNames resolver turns their objectType into a display name so the
     * DPS panel can show a readable target instead of the raw id.
     */
    private UpdatePacket enemyUpdate() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        p.newObjects = new ObjectData[ENEMY_IDS.length];
        for (int i = 0; i < ENEMY_IDS.length; i++) {
            ObjectStatusData status = new ObjectStatusData();
            status.objectId = ENEMY_IDS[i];
            status.pos = new WorldPosData();
            status.stats = enemyStats(); // no NAME_STAT: named via objectType

            ObjectData obj = new ObjectData();
            obj.objectType = ENEMY_TYPES[i];
            obj.status = status;
            p.newObjects[i] = obj;
        }
        return p;
    }

    /** Drops a single enemy from view without killing it - see the churnPhase simulation in loop(). */
    private UpdatePacket enemyDrop(int enemyId) {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.newObjects = new ObjectData[0];
        p.drops = new int[]{enemyId};
        return p;
    }

    /** Boss stat block - a much higher max HP than the regular fake enemies. */
    private StatData[] bossStats() {
        return new StatData[]{
            stat(StatType.MAX_HP_STAT, 500_000), stat(StatType.HP_STAT, 500_000),
            stat(StatType.DEFENSE_STAT, 0),
            stat(StatType.CONDITION_STAT, 0), stat(StatType.NEW_CON_STAT, 0)
        };
    }

    /** Introduces one phase of the fake boss encounter (see BOSS_PHASE_IDS/TYPES). */
    private UpdatePacket bossUpdate(int phase) {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        ObjectStatusData status = new ObjectStatusData();
        status.objectId = BOSS_PHASE_IDS[phase];
        status.pos = new WorldPosData();
        status.stats = bossStats();

        ObjectData obj = new ObjectData();
        obj.objectType = BOSS_PHASE_TYPES[phase];
        obj.status = status;
        p.newObjects = new ObjectData[]{obj};
        return p;
    }

    /** Sets the quest objective to `objectId` - what a real client sees when entering/progressing a boss fight. */
    private QuestObjectIdPacket questObjective(int objectId) {
        QuestObjectIdPacket p = new QuestObjectIdPacket();
        p.objectId = objectId;
        p.list = new int[]{objectId};
        return p;
    }

    /**
     * A damage hit against the fake boss, attributed to a random roster member
     * or the fake pet - same shape as {@link #randomDamage()} but targeting the
     * boss specifically, so the boss encounter accrues its own DPS totals
     * alongside (not instead of) the regular adds' damage.
     */
    private DamagePacket bossDamage(int bossId) {
        int attacker = rng.nextInt(5) == 0 ? PET_ID : ROSTER_IDS[rng.nextInt(ROSTER_IDS.length)];

        DamagePacket p = new DamagePacket();
        p.targetId = bossId;
        p.effects = new int[0];
        p.damageAmount = 200 + rng.nextInt(800);
        p.damageProperties = rng.nextBoolean();
        p.bulletId = rng.nextInt(256);
        p.objectId = attacker;
        return p;
    }

    /**
     * A fake instance transition, to test that the DPS tracker resets on MapInfoPacket.
     * Every third map simulates entering the open-world Realm instead of a dungeon: the
     * real client sends displayName as the raw, unresolved localization key
     * ("{s.rotmg}") for it - the client resolves the key itself via a string table
     * RealmShark never sees - so this exercises DpsTracker.ts's
     * resolveInstanceDisplayName() fallback in fake mode instead of only surfacing on
     * live testing (see issue: DPS summary panel showing the raw key).
     */
    private MapInfoPacket mapInfo() {
        mapNumber++;
        boolean openRealm = mapNumber % 3 == 0;
        MapInfoPacket p = new MapInfoPacket();
        p.width = 64;
        p.height = 64;
        p.name = openRealm ? "realm" : "FakeRealm" + mapNumber;
        p.displayName = openRealm ? "{s.rotmg}" : "Fake Realm " + mapNumber;
        p.realmName = p.displayName;
        p.versionNumber = "0";
        return p;
    }

    /**
     * A damage hit against a random fake enemy, attributed to a random member of
     * the fake roster - or, ~1 in 5 hits, to the fake pet (PET_ID), to exercise
     * minion-damage attribution redirecting it back to the local player.
     */
    private DamagePacket randomDamage() {
        int attacker = rng.nextInt(5) == 0 ? PET_ID : ROSTER_IDS[rng.nextInt(ROSTER_IDS.length)];
        int target = ENEMY_IDS[rng.nextInt(ENEMY_IDS.length)];

        DamagePacket p = new DamagePacket();
        p.targetId = target;
        p.effects = new int[0];
        p.damageAmount = 50 + rng.nextInt(450);
        p.damageProperties = rng.nextBoolean();
        p.bulletId = rng.nextInt(256);
        p.objectId = attacker;
        return p;
    }
}
