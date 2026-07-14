import { describe, expect, it } from 'vitest'
import { CAPTURE_ALLOWED_TYPES } from '../src/shared/capture'
import { CONSUMED_ENVELOPE_TYPES as DPS_CONSUMED } from '../src/renderer/src/dps/DpsTracker'
import { CONSUMED_ENVELOPE_TYPES as LOOT_CONSUMED } from '../src/renderer/src/loot/LootTracker'
import { CONSUMED_ENVELOPE_TYPES as ENTITY_CONSUMED } from '../src/renderer/src/sprites/EntityRegistry'
import { CONSUMED_ENVELOPE_TYPES as ITEM_INFO_CONSUMED } from '../src/renderer/src/items/ItemInfoProvider'

/**
 * Every packet-stream consumer exports the envelope types its `ingest`/
 * `onPacketBatch` handler reads. This test asserts each is a subset of the
 * "Report bug" capture's default-deny allowlist (`shared/capture.ts`) - so
 * forgetting to extend the allowlist for a newly-consumed type becomes a red
 * test here instead of a silently useless capture (the root cause of issue
 * #144/#146: a capture that couldn't contain `lootBagTypes` at all).
 */
describe('capture allowlist tripwire', () => {
  const consumers: Array<[string, readonly string[]]> = [
    ['DpsTracker', DPS_CONSUMED],
    ['LootTracker', LOOT_CONSUMED],
    ['EntityRegistry', ENTITY_CONSUMED],
    ['ItemInfoProvider', ITEM_INFO_CONSUMED]
  ]

  it.each(consumers)('%s only consumes allowlisted envelope types', (_name, consumed) => {
    const missing = consumed.filter((type) => !CAPTURE_ALLOWED_TYPES.has(type))
    expect(missing).toEqual([])
  })
})
