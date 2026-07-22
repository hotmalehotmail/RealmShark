import type { PanelInstance, PanelSize } from '../../../shared/panels'
import { PANEL_REGISTRY } from './registry'

// Positions are chosen so the default 'md'-size panels don't overlap: status
// sits top-left, dps below it with enough vertical clearance (y:34 clears
// status's 248px md height down to a ~760px-tall window), and console off to
// the side entirely - see registry.ts for the md dimensions this assumes.
export function defaultLayout(): PanelInstance[] {
  return [
    { id: 'status', type: 'status', anchor: { pos: 'tl', x: 2, y: 2 }, size: 'md', zIndex: 1 },
    { id: 'dps', type: 'dps', anchor: { pos: 'tl', x: 2, y: 34 }, size: 'md', zIndex: 2 },
    { id: 'console', type: 'console', anchor: { pos: 'tl', x: 35, y: 2 }, size: 'md', zIndex: 3 },
    {
      id: 'character',
      type: 'character',
      anchor: { pos: 'tl', x: 35, y: 50 },
      size: 'md',
      zIndex: 4
    },
    {
      id: 'instance',
      type: 'instance',
      anchor: { pos: 'tl', x: 65, y: 2 },
      size: 'md',
      zIndex: 5
    },
    {
      id: 'dpsSummary',
      type: 'dpsSummary',
      anchor: { pos: 'tl', x: 65, y: 40 },
      size: 'md',
      zIndex: 6
    },
    {
      id: 'loot',
      type: 'loot',
      anchor: { pos: 'tl', x: 35, y: 75 },
      size: 'md',
      zIndex: 7
    },
    {
      id: 'notifications',
      type: 'notifications',
      anchor: { pos: 'tl', x: 65, y: 75 },
      size: 'md',
      zIndex: 8
    },
    {
      id: 'dpsGraph',
      type: 'dpsGraph',
      anchor: { pos: 'tl', x: 2, y: 62 },
      size: 'md',
      zIndex: 9
    }
  ]
}

// A saved layout is authoritative for the panels it contains (user moved/
// resized them), but panel types added in a later version won't be in an
// older panels.json. Without this, a newly-added default panel (e.g. the
// console, or issue #220's notifications panel) would never appear for
// existing users on upgrade - only on a fresh install or after clearing
// panels.json. So we keep every saved panel and append any default panel
// whose id isn't present yet.
//
// Kept in this plain `.ts` file rather than alongside the `PanelCanvas`
// component - a component file that also exports a plain function fails the
// `react-refresh/only-export-components` lint rule (same reason
// `dps/dpsDetailContext.ts` is split from its provider). This also lets
// `test/panelCanvas-notifications.test.ts` assert the issue #220 upgrade
// path (a pre-#220 saved layout gains the `notifications` panel) with a
// plain import, no DOM/React-render harness needed.
export function mergeWithDefaults(saved: PanelInstance[] | null | undefined): PanelInstance[] {
  const defaults = defaultLayout()
  if (!saved || saved.length === 0) return defaults
  const savedIds = new Set(saved.map((p) => p.id))
  const missing = defaults.filter((p) => !savedIds.has(p.id))
  return missing.length > 0 ? [...saved, ...missing] : saved
}

// An `ephemeral` (programmatically-spawned) panel's selection lives in a
// non-persisted context (e.g. dpsDetailContext.ts), so persisting the panel
// instance itself would restore an empty shell on next launch with no way to
// restore what it was showing. Exclude such panels both when saving (so they
// never reach panels.json) and when loading (so a panels.json written by an
// older build doesn't resurrect a stray empty one). This used to key on
// `closable` back when `dpsDetail` was the only closable panel; now that
// every panel except status is closable (with closing = hide, not remove),
// ordinary closed panels must keep persisting so their `hidden` flag - and
// their position for when they're toggled back on - survives a restart.
export function isPersistablePanel(panel: PanelInstance): boolean {
  return !PANEL_REGISTRY[panel.type]?.ephemeral
}

/** Default anchor a programmatically-spawned panel (`usePanelSpawn().openPanel`) appears at. */
export const SPAWN_ANCHOR = { pos: 'tl' as const, x: 15, y: 12 }

// The three state transitions behind `usePanelSpawn()` / the title-bar ✕ /
// the Status panel's toggle list, kept here as pure functions (same reason
// as mergeWithDefaults above: react-refresh lint on the component file, and
// `test/panels-closeable.test.ts` asserts them with a plain import).

/**
 * A panel counts as open only when its instance exists AND isn't hidden - a
 * closed-but-persisted panel reads as off, so the Status panel's toggle list
 * and DpsSummaryPanel's row highlight reflect what's actually on screen.
 */
export function isPanelOpen(panels: PanelInstance[], id: string): boolean {
  return panels.some((p) => p.id === id && !p.hidden)
}

/**
 * Ensures the panel is on screen and frontmost: un-hides an existing (maybe
 * hidden) instance and raises it, or spawns a new one at SPAWN_ANCHOR.
 * Returns the input array unchanged (same reference - no React re-render
 * churn) when the panel is already visible and on top.
 */
export function withPanelOpen(
  panels: PanelInstance[],
  id: string,
  type: string,
  size: PanelSize = 'lg'
): PanelInstance[] {
  const maxZ = Math.max(0, ...panels.map((p) => p.zIndex))
  const existing = panels.find((p) => p.id === id)
  if (existing) {
    if (!existing.hidden && existing.zIndex === maxZ) return panels
    return panels.map((p) => (p.id === id ? { ...p, hidden: false, zIndex: maxZ + 1 } : p))
  }
  return [...panels, { id, type, anchor: SPAWN_ANCHOR, size, zIndex: maxZ + 1 }]
}

/**
 * Closes a panel: an `ephemeral` one (dpsDetail) is removed from the array
 * outright, anything else is kept but marked `hidden` so its anchor/size/pin
 * survive - both for re-opening from the Status panel this session and,
 * via persistence, across restarts.
 */
export function withPanelClosed(panels: PanelInstance[], id: string): PanelInstance[] {
  const target = panels.find((p) => p.id === id)
  if (!target) return panels
  if (PANEL_REGISTRY[target.type]?.ephemeral) return panels.filter((p) => p.id !== id)
  return panels.map((p) => (p.id === id ? { ...p, hidden: true } : p))
}
