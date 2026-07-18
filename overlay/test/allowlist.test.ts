import { describe, expect, it } from 'vitest'
import { CAPTURE_ALLOWED_TYPES } from '../src/shared/capture'
import { CONSUMED_ENVELOPE_TYPES as ALERT_CONSUMED } from '../src/renderer/src/alerts/AlertEngine'
import { CONSUMED_ENVELOPE_TYPES as DPS_CONSUMED } from '../src/renderer/src/dps/DpsTracker'
import { CONSUMED_ENVELOPE_TYPES as LOOT_CONSUMED } from '../src/renderer/src/loot/LootTracker'
import { CONSUMED_ENVELOPE_TYPES as ENTITY_CONSUMED } from '../src/renderer/src/sprites/EntityRegistry'

/**
 * The #144/#146 failure class (PRD §1/§6.2): a tracker starts consuming a new
 * envelope type, nobody remembers to add it to `CAPTURE_ALLOWED_TYPES`
 * (src/shared/capture.ts), and every future bug capture for that scenario is
 * silently useless - the type simply never appears in `recentPackets`. This
 * test turns that into a red test instead: every gameplay/behavior consumer's
 * declared `CONSUMED_ENVELOPE_TYPES` must be retained by the capture ring.
 *
 * `ItemInfoProvider`'s `itemInfo`/`enchantNames` are deliberately excluded -
 * see its own `CONSUMED_ENVELOPE_TYPES` doc comment.
 *
 * `TextPacket` (`AlertEngine`'s chat detector, issue #222) is also a
 * **deliberate, named exemption**: `docs/prd-notifications.md` §6 requires
 * `CAPTURE_ALLOWED_TYPES` to stay frozen against chat specifically - bug
 * captures and disk recordings go to public GitHub issues / a user's own
 * disk, and chat includes DMs, so it must never enter either. This is a
 * privacy floor, not an oversight - do not "fix" it by adding `TextPacket` to
 * `CAPTURE_ALLOWED_TYPES`. The accepted cost: chat-rule bugs are never
 * reproducible from a capture (synthetic `FakePacketSource` fixtures only -
 * see `docs/overlay-testing.md`'s chat caveat).
 */
describe('capture allowlist tripwire', () => {
  const TEXT_PACKET_EXEMPTION = new Set(['TextPacket'])

  it('retains every envelope type DpsTracker/LootTracker/EntityRegistry/AlertEngine consume', () => {
    // AlertEngine's set is LootTracker's loot-detection types plus its own
    // chat-detector types (CreateSuccessPacket/TextPacket, issue #222) -
    // included anyway so this test is the one place that would catch a
    // shared type (e.g. UpdatePacket) drifting between the two.
    const consumed = new Set<string>([
      ...DPS_CONSUMED,
      ...LOOT_CONSUMED,
      ...ENTITY_CONSUMED,
      ...ALERT_CONSUMED
    ])
    const missing = Array.from(consumed).filter(
      (type) => !CAPTURE_ALLOWED_TYPES.has(type) && !TEXT_PACKET_EXEMPTION.has(type)
    )
    expect(missing).toEqual([])
  })

  it('TextPacket stays out of CAPTURE_ALLOWED_TYPES despite AlertEngine consuming it (PRD §6 privacy floor)', () => {
    expect(ALERT_CONSUMED).toContain('TextPacket')
    expect(CAPTURE_ALLOWED_TYPES.has('TextPacket')).toBe(false)
  })
})
