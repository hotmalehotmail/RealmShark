/**
 * Derives an equipped item's rarity-border tier from its enchant data, carried
 * on the wire in a player's `UNIQUE_DATA_STRING` stat (StatType #80 -
 * packets/data/enums/StatType.java). That raw stat string already crosses the
 * bridge unfiltered (PacketSerializer reflects every StatData field verbatim -
 * see docs/bridge-server.md), so this module ports the same decode
 * `bridge.dps.ParseEnchants`/`bridge.dps.PcStatsDecoder` do Java-side, rather
 * than adding a synthetic bridge envelope: it keeps the rarity computation on
 * the same per-objectId merge timeline as `equipment`/`skin`/dyes already use
 * (EntityRegistry.tsx's `mergeStats`, DpsTracker.ts's `mergeCosmetics`), so it
 * updates from both `UpdatePacket` and `NewTickPacket` deltas for free.
 *
 * Wire shape: `UNIQUE_DATA_STRING.stringStatValue` is 4 comma-separated
 * per-slot codes (weapon/ability/armor/ring - same order as INVENTORY_0..3).
 * Each code is a six-bit (base64url-like) encoded byte blob: 1 header byte +
 * a little-endian uint16 `type` (must equal 1026) + up to 4 little-endian
 * int16 enchant ids, terminated by -3 (-2 = locked, -1 = empty slot, skipped
 * rather than terminating).
 *
 * Rarity derivation (see docs/overlay-ui-style.md "Rarity roles" and
 * docs/overlay-renderer.md for how this was verified): the count of an item's
 * FILLED enchant slots maps directly to RotMG Exalt's own rarity-border tiers -
 * 1 filled slot = uncommon (green), 2 = rare (blue), 3 = legendary (purple),
 * 4 = divine (gold); 0 filled slots (or no UNIQUE_DATA_STRING at all) is
 * common/unenchanted and renders no border.
 */

/** Highest rarity tier (an item can have at most 4 enchant slots filled). */
const MAX_RARITY_TIER = 4

function sixBitCharValue(c: string): number {
  const code = c.charCodeAt(0)
  if (code >= 48 && code <= 57) return code + 4 // '0'-'9' -> 52-61
  if (code >= 65 && code <= 90) return code - 65 // 'A'-'Z' -> 0-25
  if (code >= 97 && code <= 122) return code - 71 // 'a'-'z' -> 26-51
  if (c === '-') return 62
  if (c === '_') return 63
  if (c === '=') return 0 // padding
  return code
}

/** Port of `bridge.dps.PcStatsDecoder.sixBitStringToBytes` (Java). */
function sixBitStringToBytes(s: string): Uint8Array {
  const indexPadding = s.indexOf('=')
  const stringLength = s.length
  const padding = indexPadding > -1 ? stringLength - indexPadding : 0
  const output = new Uint8Array(Math.max(0, Math.floor(stringLength / 4) * 3 - padding))
  let o = 0
  for (let i = 0; i + 3 < stringLength; i += 4) {
    const value1 = sixBitCharValue(s[i])
    const value2 = sixBitCharValue(s[i + 1])
    const c3 = s[i + 2]
    const c4 = s[i + 3]
    const value3 = sixBitCharValue(c3)
    const value4 = sixBitCharValue(c4)

    output[o] = ((value1 << 2) | (value2 >> 4)) & 0xff
    if (c3 !== '=') {
      output[1 + o] = (((value2 & 0b001111) << 4) | (value3 >> 2)) & 0xff
      if (c4 !== '=') {
        output[2 + o] = (((value3 & 0b000011) << 6) | value4) & 0xff
      }
    }
    o += 3
  }
  return output
}

/** Reads a little-endian, sign-extended int16 at `offset` (matches Java's `BufferReader.readShort`). */
function readInt16LE(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8)
  return (value << 16) >> 16
}

/**
 * Port of `bridge.dps.ParseEnchants.extractEnchantIds` (Java): decodes one
 * slot's raw enchant code into the list of filled enchant ids (skipping
 * locked/empty slots, stopping at the terminator). Returns an empty list for
 * a missing/malformed code, matching the Java behaviour.
 */
export function extractEnchantIds(code: string | null | undefined): number[] {
  const ids: number[] = []
  if (!code) return ids

  const bytes = sixBitStringToBytes(code)
  const expectedSize = 1 + 2 + 8 // header + type + up to 4 enchant shorts
  const trimmed = bytes.length > expectedSize ? bytes.subarray(0, expectedSize) : bytes
  if (trimmed.length < 3) return ids

  const type = trimmed[1] | (trimmed[2] << 8)
  if (type !== 1026) return ids

  let offset = 3
  while (offset + 1 < trimmed.length) {
    const enchantId = readInt16LE(trimmed, offset)
    offset += 2
    if (enchantId === -3) break // terminator
    if (enchantId === -2 || enchantId === -1) continue // locked / empty
    ids.push(enchantId)
  }
  return ids
}

/** One slot's rarity tier: the count of its filled enchant slots, capped at {@link MAX_RARITY_TIER}. */
export function slotRarityTier(code: string | null | undefined): number {
  return Math.min(extractEnchantIds(code).length, MAX_RARITY_TIER)
}

/**
 * Decodes a full `UNIQUE_DATA_STRING` value into a rarity tier per equipped
 * slot (weapon/ability/armor/ring - same order as `equipment`/INVENTORY_0..3).
 * Always returns exactly 4 entries; a missing/short value fills the rest with
 * tier 0 (common/no border).
 */
export function equipmentRarityFromUniqueDataString(value: string | null | undefined): number[] {
  const slots = (value ?? '').split(',')
  const result = [0, 0, 0, 0]
  for (let i = 0; i < result.length; i++) {
    result[i] = slotRarityTier(slots[i])
  }
  return result
}

/** Tailwind ring-color utility class per rarity tier (see docs/overlay-ui-style.md "Rarity roles"). Tier 0 has no entry (no border). */
export const RARITY_RING_CLASS: Record<number, string> = {
  1: 'ring-1 ring-rarity-uncommon',
  2: 'ring-1 ring-rarity-rare',
  3: 'ring-1 ring-rarity-legendary',
  4: 'ring-1 ring-rarity-divine'
}
