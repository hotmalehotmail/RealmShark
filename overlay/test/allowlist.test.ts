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
 */
describe('capture allowlist tripwire', () => {
  it('retains every envelope type DpsTracker/LootTracker/EntityRegistry/AlertEngine consume', () => {
    // AlertEngine's set is identical to LootTracker's (it delegates all
    // detection there - issue #218) - included anyway so this test is the
    // one place that would catch either drifting from the other.
    const consumed = new Set<string>([
      ...DPS_CONSUMED,
      ...LOOT_CONSUMED,
      ...ENTITY_CONSUMED,
      ...ALERT_CONSUMED
    ])
    const missing = Array.from(consumed).filter((type) => !CAPTURE_ALLOWED_TYPES.has(type))
    expect(missing).toEqual([])
  })
})
