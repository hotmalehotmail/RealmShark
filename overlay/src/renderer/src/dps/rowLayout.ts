import type { PanelSize } from '../../../shared/panels'

/** Row character-sprite pixel size per panel size — also drives fixed per-row height. */
export const DPS_ROW_SPRITE_SIZE: Record<PanelSize, number> = { sm: 24, md: 32, lg: 40 }
/** Rows rendered by DpsList, including the local player's pinned last slot — roughly half the previous {sm:3,md:6,lg:12} in exchange for bigger rows, so the panel reads at a glance mid-fight. */
export const DPS_MAX_ROWS: Record<PanelSize, number> = { sm: 2, md: 3, lg: 6 }
/** Row text size (`MeterRow`'s `textSize`) per panel size — the primary name/damage text, not the badges/secondary figures that stay `2xs` regardless. */
export const DPS_ROW_TEXT_SIZE: Record<PanelSize, 'xs' | 'sm'> = { sm: 'xs', md: 'sm', lg: 'sm' }

const ROW_GAP = 4 // Tailwind space-y-1
const TARGET_HEADER_HEIGHT = 20 // DpsList's "Target: ..." line + mb-1; hidden on sm

const FRAME_CHROME = 44 // PanelFrame title bar (~28) + content area's p-2 padding (16)
const BUFFER = 10 // rounding/border slack so rows never require internal scrolling

/** Minimum row height in px — a row is never shorter than this even if the sprite is. */
export const MIN_ROW_HEIGHT = 16

export function rowHeight(size: PanelSize): number {
  return Math.max(DPS_ROW_SPRITE_SIZE[size], MIN_ROW_HEIGHT)
}

/**
 * Pixel height the `dps` panel needs at this size to show every row —
 * including the pinned local-player row — without internal scrolling.
 * Panel sizes are static presets (percentage-anchored, not continuously
 * resized), so registry.ts can't measure this from the live DOM; it calls
 * this instead of hardcoding a height that can silently drift out of sync
 * with DPS_MAX_ROWS/DPS_ROW_SPRITE_SIZE. The trend graph used to eat into
 * this budget too (PRD §4) — it's now its own panel (`dpsGraph`, issue
 * #259), so this only ever needs to fit the row list.
 */
export function dpsPanelHeight(size: PanelSize): number {
  const rows = DPS_MAX_ROWS[size]
  const rowsHeight = rows * rowHeight(size) + (rows - 1) * ROW_GAP
  const header = size === 'sm' ? 0 : TARGET_HEADER_HEIGHT
  return FRAME_CHROME + header + rowsHeight + BUFFER
}
