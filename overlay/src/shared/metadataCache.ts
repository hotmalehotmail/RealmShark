import { METADATA_ENVELOPE_TYPES, type PacketEnvelope } from './ipc'

const METADATA_TYPES = new Set<string>(METADATA_ENVELOPE_TYPES)

/**
 * Latest-per-type cache of the bridge's metadata-table envelopes, kept by the
 * Electron main process (see `METADATA_ENVELOPE_TYPES`' doc comment for the
 * issue #245 late-subscriber gap this closes). Pure TS (no Electron) so it's
 * directly unit-testable, same split as `CaptureRing`/`ChatProbeBuffer`.
 * Bounded by construction: at most one envelope per metadata type.
 */
export class LatestMetadataCache {
  private readonly latest = new Map<string, PacketEnvelope>()

  /** Retains a metadata-typed envelope, replacing the previous one of its type; ignores everything else. */
  push(envelope: PacketEnvelope): void {
    if (METADATA_TYPES.has(envelope.type)) this.latest.set(envelope.type, envelope)
  }

  /** The cached envelopes (at most one per type), oldest-type-first. Empty until the first delivery arrives. */
  snapshot(): PacketEnvelope[] {
    return [...this.latest.values()]
  }
}
