import type { PacketEnvelope } from './ipc'

/**
 * Envelope types the chat probe retains while armed - everything needed to pin
 * how chat channels (party in particular) are distinguished on the wire, which
 * is the #222 blocker (`docs/prd-notifications.md` §6):
 *
 * - `TextPacket` - every incoming chat message (local/party/guild/PMs).
 * - `PlayerTextPacket` - the client's own OUTGOING chat, captured client-side
 *   so a self-sent message is observable even if the server never echoes it
 *   back as a `TextPacket` (whether it does is one of the facts to pin).
 * - The party packets - to see which party traffic arrives as chat vs. as a
 *   party-specific packet (`PartyListMessagePacket` etc.).
 *
 * `ChatHelloPacket` (outgoing chat-service handshake) is deliberately NOT
 * probed: it isn't needed for shape-pinning and handshake packets are where
 * session/auth-ish fields tend to live.
 *
 * PRIVACY: these types are exactly the ones `CAPTURE_ALLOWED_TYPES`
 * (`shared/capture.ts`) deliberately excludes, because bug captures and
 * session recordings are built to be attached to PUBLIC GitHub issues. The
 * probe exists to observe them anyway - locally, explicitly user-armed, into
 * a file that is never bundled into any capture. Keep these two paths
 * separate forever: never feed this buffer into `CaptureRing`, and never add
 * these types to the allowlist (`overlay/test/chatProbe.test.ts` pins the
 * disjointness).
 */
export const CHAT_PROBE_TYPES = new Set<string>([
  'TextPacket',
  'PlayerTextPacket',
  'PartyListMessagePacket',
  'IncomingPartyInvitePacket',
  'IncomingPartyMemberInfoPacket',
  'PartyActionResultPacket',
  'PartyMemberAddedPacket',
  'PartyRequestResponsePacket'
])

/**
 * Memory bound while armed (oldest evicted first). Chat is low-volume - a
 * verification session produces dozens of envelopes, not thousands - so this
 * only matters if the probe is left armed and forgotten for a whole session.
 */
export const CHAT_PROBE_MAX_ENTRIES = 2000

/** Whether the probe is armed, and how many envelopes it holds so far (live count in the Status panel). */
export interface ChatProbeStatus {
  active: boolean
  captured: number
}

/** Result of stopping the probe: where the NDJSON landed (null when nothing was captured - no file is written). */
export interface ChatProbeResult {
  file: string | null
  captured: number
}

/**
 * The probe's filter + bounded buffer, pure TypeScript (no Electron/fs) so
 * it's directly unit-testable - same split as `SessionRecordingWriter` vs.
 * `main/sessionRecorder.ts`. The Electron-facing wrapper owning file output
 * is `main/chatProbe.ts`.
 */
export class ChatProbeBuffer {
  private entries: PacketEnvelope[] = []

  /** Retains the probe-typed envelopes from a batch, evicting oldest beyond {@link CHAT_PROBE_MAX_ENTRIES}. */
  push(packets: PacketEnvelope[]): void {
    for (const env of packets) {
      if (!CHAT_PROBE_TYPES.has(env.type)) continue
      this.entries.push(env)
      if (this.entries.length > CHAT_PROBE_MAX_ENTRIES) this.entries.shift()
    }
  }

  get size(): number {
    return this.entries.length
  }

  /** Returns everything retained (arrival order) and empties the buffer. */
  drain(): PacketEnvelope[] {
    const drained = this.entries
    this.entries = []
    return drained
  }
}
