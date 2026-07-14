import type { PacketEnvelope } from './ipc'

/**
 * Packet types retained in the "Report bug" / "Capture now" ring buffer. The
 * capture is attached to a PUBLIC GitHub issue, so only gameplay packet types
 * useful for FakePacketSource repro are retained - an allowlist (default-deny)
 * so a new or unexpected packet type can't leak. This drops chat (TextPacket,
 * incl. DMs), account lists, and connection/auth packets (Hello/Reconnect).
 * Credential FIELDS are separately stripped bridge-side (PacketSerializer);
 * this drops the whole sensitive packet TYPES.
 *
 * Default-deny by design: a packet-stream consumer that needs a new type here
 * must add it deliberately (see the `CONSUMED_ENVELOPE_TYPES` tripwire test in
 * `overlay/test/allowlist.test.ts`), never silently.
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
  // bridge-synthesized envelopes the overlay consumes (non-sensitive)
  'objectNames',
  'dps',
  'lootBagTypes'
])

/**
 * Total envelopes retained across the whole ring (`CaptureRing`), spam types
 * included. Sized against GitHub's 25 MB attachment limit for the gzipped
 * capture file (est. 3-10 MB for 10k envelopes) - see docs/overlay-testing.md.
 */
export const CAPTURE_RING_CAPACITY = 10_000

/**
 * Per-type caps for high-frequency "spam" types that would otherwise dominate
 * a plain count-based ring and starve wall-clock coverage of everything else
 * (a real session emits far more `MovePacket`/`NewTickPacket` than anything
 * else). Initial guesses (PRD §11 open question 1) - tune against a real
 * session's type histogram. Types not listed here share whatever's left of
 * `CAPTURE_RING_CAPACITY` after these quotas, via `CAPTURE_SHARED_BUDGET`.
 */
export const CAPTURE_TYPE_QUOTAS: Record<string, number> = {
  MovePacket: 500,
  NewTickPacket: 1000,
  UpdateAckPacket: 300,
  GotoAckPacket: 300
}

/** Remaining budget shared by every allowlisted type with no quota of its own. */
export const CAPTURE_SHARED_BUDGET =
  CAPTURE_RING_CAPACITY - Object.values(CAPTURE_TYPE_QUOTAS).reduce((sum, n) => sum + n, 0)

/**
 * Fixed-capacity, allowlist-filtered packet ring for the "Report bug" /
 * "Capture now" capture. Spam types (`CAPTURE_TYPE_QUOTAS`) get their own
 * bounded sub-buffer so they can't crowd out everything else; every other
 * allowlisted type shares `CAPTURE_SHARED_BUDGET`. `snapshot()` merges and
 * re-sorts by `envelope.time` since the sub-buffers are appended to
 * independently and would otherwise interleave out of order.
 */
export class CaptureRing {
  private readonly quotaBuffers = new Map<string, PacketEnvelope[]>()
  private readonly sharedBuffer: PacketEnvelope[] = []

  push(envelope: PacketEnvelope): void {
    if (!CAPTURE_ALLOWED_TYPES.has(envelope.type)) return

    const quota = CAPTURE_TYPE_QUOTAS[envelope.type]
    if (quota !== undefined) {
      let buffer = this.quotaBuffers.get(envelope.type)
      if (!buffer) {
        buffer = []
        this.quotaBuffers.set(envelope.type, buffer)
      }
      buffer.push(envelope)
      if (buffer.length > quota) buffer.shift()
    } else {
      this.sharedBuffer.push(envelope)
      if (this.sharedBuffer.length > CAPTURE_SHARED_BUDGET) this.sharedBuffer.shift()
    }
  }

  /** All retained envelopes, chronological order. */
  snapshot(): PacketEnvelope[] {
    const all = [...this.sharedBuffer, ...Array.from(this.quotaBuffers.values()).flat()]
    all.sort((a, b) => a.time - b.time)
    return all
  }

  clear(): void {
    this.quotaBuffers.clear()
    this.sharedBuffer.length = 0
  }
}
