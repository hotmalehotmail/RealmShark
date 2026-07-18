import type { ChatEvent } from './types'

/**
 * Shapes of the packet fields the chat detector reads, as serialized by the
 * Java bridge (Gson reflects Java field names verbatim) - see
 * `packets/incoming/TextPacket.java`, `packets/incoming/CreateSuccessPacket.java`,
 * and `packets/incoming/UpdatePacket.java`. Re-declared here (rather than
 * imported from `dps/types.ts`) to keep `alerts/` free of a dependency on
 * the `dps/` subsystem, matching this codebase's per-subsystem packet-shape
 * convention (`loot/types.ts` duplicates the same `UpdatePacket` shape for
 * the same reason).
 */
export interface TextPacketData {
  name: string
  objectId: number
  numStars: number
  bubbleTime: number
  recipient: string
  text: string
  cleanText: string
  isSupporter: boolean
  starBackground: number
}

/** `packets/incoming/CreateSuccessPacket.java`: server's own confirmation of "you are this objectId". */
export interface CreateSuccessPacketData {
  objectId: number
}

interface StatEntry {
  statTypeNum: number
  stringStatValue?: string
}

interface ObjectStatusData {
  objectId: number
  stats?: StatEntry[]
}

export interface UpdatePacketData {
  newObjects?: Array<{ status?: ObjectStatusData }>
}

/** `packets/data/enums/StatType.java`: NAME_STAT(31). */
export const NAME_STAT_TYPE_NUM = 31

/**
 * `TextPacket.recipient`'s exact literal sentinel for a party-chat message
 * (asterisks included) - pinned 2026-07-18 from a live-session chat-probe
 * capture, see `ChatEvent`'s doc comment.
 */
const PARTY_CHAT_RECIPIENT = '*Party*'

/** Local/world chat's `recipient` (empty string) - the other wire-verified shape. */
const LOCAL_CHAT_RECIPIENT = ''

/** Classifies a `TextPacket.recipient` into the verified channel shapes - see `ChatEvent.channel`'s doc comment for why unsampled shapes fall back to `'unknown'` rather than a guess. */
export function classifyChatChannel(recipient: string): ChatEvent['channel'] {
  if (recipient === PARTY_CHAT_RECIPIENT) return 'party'
  if (recipient === LOCAL_CHAT_RECIPIENT) return 'local'
  return 'unknown'
}
