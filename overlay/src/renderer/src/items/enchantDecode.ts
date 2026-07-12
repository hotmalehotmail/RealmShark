/** The `type` field every valid enchant payload starts with (bridge.dps.ParseEnchants). */
const ENCHANT_TYPE_SENTINEL = 1026
/** Terminates the enchant id list (bridge.dps.ParseEnchants). -2 = locked, -1 = empty slot marker; both are skipped, not terminators. */
const TERMINATOR = -3
const LOCKED = -2
const EMPTY = -1

/**
 * Decodes a RotMG "six-bit string" into raw bytes - a client-side port of
 * `bridge.dps.PcStatsDecoder#sixBitStringToBytes`. RotMG's six-bit alphabet
 * (A-Z, a-z, 0-9, -, _, in that order, `=` padding) is byte-for-byte the
 * standard base64url alphabet, so this is plain base64url decoding.
 */
function sixBitStringToBytes(s: string): Uint8Array {
  const standard = s.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Decodes one equipped-slot's encoded enchant string into its enchant ids - a
 * client-side port of `bridge.dps.ParseEnchants#extractEnchantIds`. Needs no
 * enchant name/effect definitions (unlike `ParseEnchants#extractEnchants`,
 * which requires `assets/xml/enchantments.xml`), so it works identically
 * whether or not the bridge machine has the game installed - the item
 * tooltip resolves ids to names separately, via the `enchantNames` envelope,
 * falling back to the bare id when a name isn't available (see `ItemSprite`).
 * Returns an empty array for an empty/malformed/unenchanted string - all of
 * which mean "show nothing", not an error.
 */
export function decodeEnchantIds(code: string | null | undefined): number[] {
  if (!code) return []
  let bytes: Uint8Array
  try {
    bytes = sixBitStringToBytes(code)
  } catch {
    return []
  }
  // header(1) + type(2) + up to 4 enchants(8), matching ParseEnchants' trim.
  const maxLen = 1 + 2 + 8
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, maxLen))
  let offset = 1 // skip the header byte
  if (view.byteLength < offset + 2) return []
  const type = view.getInt16(offset, true)
  offset += 2
  if (type !== ENCHANT_TYPE_SENTINEL) return []

  const ids: number[] = []
  while (offset + 2 <= view.byteLength) {
    const id = view.getInt16(offset, true)
    offset += 2
    if (id === TERMINATOR) break
    if (id === LOCKED || id === EMPTY) continue
    ids.push(id)
  }
  return ids
}
