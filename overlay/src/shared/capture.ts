import type { PacketEnvelope } from './ipc'

/**
 * Default-deny allowlist of packet/envelope types retained in the shareable
 * "Report bug" capture buffer (`overlay/src/main/index.ts`). The capture is
 * attached to a PUBLIC issue, so only gameplay packet types useful for a
 * `FakePacketSource` repro (and small, non-sensitive bridge-synthesized
 * tables) are retained. This drops chat (`TextPacket`, incl. DMs), account
 * lists, and connection/auth packets (`Hello`/`Reconnect`). Credential
 * FIELDS are separately stripped bridge-side (`PacketSerializer`); this drops
 * the whole sensitive packet TYPES.
 *
 * Lives here (not inline in `main/index.ts`) so the test suite's allowlist
 * tripwire (`overlay/test/allowlist.test.ts`) can import it too: every
 * packet-stream consumer exports the envelope types it reads, and a test
 * asserts consumed types are a subset of this set. Forgetting to extend the
 * allowlist for a new consumed type then becomes a red test instead of a
 * silently useless capture (the root cause of issue #144/#146 - a capture
 * that couldn't contain `lootBagTypes` at all).
 */
export const CAPTURE_ALLOWED_TYPES = new Set<string>([
  // gameplay / combat / world state (what DPS + panels replay)
  'UpdatePacket',
  'NewTickPacket',
  'DamagePacket',
  'EnemyHitPacket',
  'ServerPlayerShootPacket',
  'PlayerShootPacket',
  'MapInfoPacket',
  'CreateSuccessPacket',
  'QuestObjectIdPacket',
  'MovePacket',
  'GotoPacket',
  'GotoAckPacket',
  'UpdateAckPacket',
  'ClientStatPacket',
  'ShowEffectPacket',
  'NotificationPacket',
  // bridge-synthesized envelopes the overlay consumes (non-sensitive, small,
  // asset-derived tables)
  'objectNames',
  'dps',
  'lootBagTypes',
  'itemInfo',
  'enchantNames'
])

/**
 * Per-type caps within the capture ring, for high-frequency "spam" types
 * that would otherwise dominate a count-based ring and shrink its wall-clock
 * coverage. A type not listed here shares whatever headroom remains under
 * `CAPTURE_RING_CAPACITY`. Initial numbers per docs/prd-agent-observability.md
 * §6.3 - tune against a real session's type histogram if the ring still
 * skews toward one type.
 */
export const CAPTURE_TYPE_QUOTAS: Record<string, number> = {
  MovePacket: 500,
  NewTickPacket: 1000,
  UpdateAckPacket: 300,
  GotoAckPacket: 300
}

/** Total envelope cap for the capture ring (was 300 pre-#157). */
export const CAPTURE_RING_CAPACITY = 10_000

/**
 * Appends an allowlisted envelope to a capture ring buffer in place,
 * enforcing `CAPTURE_TYPE_QUOTAS` (oldest-of-that-type evicted first) and
 * then `CAPTURE_RING_CAPACITY` overall (oldest-of-any-type evicted first).
 * Non-allowlisted envelopes are silently dropped - the buffer is
 * default-deny by construction, not just by convention.
 */
export function pushCapturePacket(buffer: PacketEnvelope[], envelope: PacketEnvelope): void {
  if (!CAPTURE_ALLOWED_TYPES.has(envelope.type)) return
  buffer.push(envelope)

  const quota = CAPTURE_TYPE_QUOTAS[envelope.type]
  if (quota !== undefined) {
    let count = 0
    for (const p of buffer) if (p.type === envelope.type) count++
    while (count > quota) {
      const idx = buffer.findIndex((p) => p.type === envelope.type)
      buffer.splice(idx, 1)
      count--
    }
  }

  if (buffer.length > CAPTURE_RING_CAPACITY) {
    buffer.splice(0, buffer.length - CAPTURE_RING_CAPACITY)
  }
}
