/** One catalog rule's user-configured settings (`OverlaySettings.notifications.rules`, keyed by `AlertKind.id` - see `renderer/src/alerts/catalog.ts`). */
export interface NotificationRuleSettings {
  enabled: boolean
  banner: boolean
  sound: boolean
  /**
   * Catalog-entry-specific params (e.g. `enchantedDrop`'s tier/overrides).
   * Loosely typed here since this schema is shared across every catalog
   * entry - the alerts subsystem casts to its own typed shape at the point
   * of use (`renderer/src/alerts/catalog.ts`'s `resolveRuleSettings`).
   */
  params?: Record<string, unknown>
}

/**
 * The notification system's settings slice (issue #218, PRD §5). A missing
 * `rules` entry for a given catalog kind id falls back to that kind's own
 * `defaults` at match time (`renderer/src/alerts/catalog.ts`'s
 * `resolveRuleSettings`) rather than being backfilled here - keeping this
 * default free of any dependency on the (renderer-only) catalog module.
 */
export interface NotificationsSettings {
  /** Master switch. */
  enabled: boolean
  /** 0..1; 0 = mute. */
  volume: number
  /** Keyed by `AlertKind.id`. Unknown keys (a removed catalog entry) are simply never read. */
  rules: Record<string, NotificationRuleSettings>
}

export interface OverlaySettings {
  gameWindowTitle: string
  toggleHotkey: string
  /**
   * Milliseconds per frame when animating a textile (cloth) dye's woven pattern.
   * Higher = slower animation. RotMG's own rate isn't in our assets, so this is
   * tunable.
   */
  textileAnimMs: number
  /**
   * Animated-cloth SCROLL rate: output pattern-pixels/sec per unit of the dye's
   * own `speed` (from <AnimatedDye>). Higher = faster horizontal/vertical cloth
   * scroll. Tunable because RotMG's own rate isn't in our assets.
   */
  textileScrollSpeed: number
  /**
   * Animated-cloth ROTATE rate: radians/sec per unit of the dye's `speed`.
   * Higher = faster spin for rotating (vortex) cloths.
   */
  textileRotateSpeed: number
  /**
   * "Record session to disk" toggle (PRD §7.2). When true, the main process
   * appends every allowlisted packet batch as NDJSON to a rolling
   * `userData/captures/*.ndjson.gz` file - see `overlay/src/main/sessionRecorder.ts`
   * and `docs/overlay-main-process.md`. OFF by default; toggling it applies on
   * Save, same as the other settings here.
   */
  recordSessionToDisk: boolean
  /** Notification system settings (issue #218, PRD §5) - see `NotificationsSettings`. */
  notifications: NotificationsSettings
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  gameWindowTitle: 'RotMGExalt',
  toggleHotkey: 'Alt+Shift+R',
  textileAnimMs: 200,
  textileScrollSpeed: 1.5,
  textileRotateSpeed: 0.15,
  recordSessionToDisk: false,
  notifications: { enabled: true, volume: 1, rules: {} }
}
