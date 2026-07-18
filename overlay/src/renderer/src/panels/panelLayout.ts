import type { PanelInstance } from '../../../shared/panels'
import { PANEL_REGISTRY } from './registry'

// Positions are chosen so the default 'md'-size panels don't overlap: status
// sits top-left, dps below it with enough vertical clearance, and console
// off to the side entirely - see registry.ts for the md dimensions this
// assumes.
export function defaultLayout(): PanelInstance[] {
  return [
    { id: 'status', type: 'status', anchor: { pos: 'tl', x: 2, y: 2 }, size: 'md', zIndex: 1 },
    { id: 'dps', type: 'dps', anchor: { pos: 'tl', x: 2, y: 30 }, size: 'md', zIndex: 2 },
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

// A `closable` (programmatically-spawned) panel's selection lives in a
// non-persisted context (e.g. dpsDetailContext.ts), so persisting the panel
// instance itself would restore an empty shell on next launch with no way to
// restore what it was showing. Exclude such panels both when saving (so they
// never reach panels.json) and when loading (so a panels.json written before
// this fix - or by an older build - doesn't resurrect a stray empty one).
export function isPersistablePanel(panel: PanelInstance): boolean {
  return !PANEL_REGISTRY[panel.type]?.closable
}
