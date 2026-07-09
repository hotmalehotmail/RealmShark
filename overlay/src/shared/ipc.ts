/** Channel names shared between main and renderer over the Electron IPC bridge. */
export const IPC = {
  bridgeStatus: 'bridge-status',
  packetBatch: 'packet-batch',
  interactiveChange: 'interactive-change'
} as const

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

/** One decoded packet as serialized by PacketSerializer on the Java side. */
export interface PacketEnvelope {
  type: string
  direction: 'CLIENT' | 'SERVER' | string
  time: number
  data: unknown
}
