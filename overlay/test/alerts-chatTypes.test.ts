import { describe, expect, it } from 'vitest'
import { classifyChatChannel } from '../src/renderer/src/alerts/chatTypes'

/**
 * Pins the wire-verified `TextPacket.recipient` shapes (issue #222,
 * `docs/prd-notifications.md` §6, verified 2026-07-18 via the Status panel's
 * chat-probe diagnostic) against `classifyChatChannel` directly - the same
 * facts `AlertEngine`'s chat detector and `docs/notifications.md` rely on.
 */
describe('classifyChatChannel (issue #222)', () => {
  it('classifies the exact literal sentinel "*Party*" as party', () => {
    expect(classifyChatChannel('*Party*')).toBe('party')
  })

  it('classifies an empty string as local/world', () => {
    expect(classifyChatChannel('')).toBe('local')
  })

  it('classifies anything else (unsampled - guild/pm sentinels) as unknown rather than guessing', () => {
    expect(classifyChatChannel('SomePlayerName')).toBe('unknown')
    expect(classifyChatChannel('*Guild*')).toBe('unknown')
  })
})
