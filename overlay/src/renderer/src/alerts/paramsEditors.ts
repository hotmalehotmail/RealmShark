import type { ComponentType } from 'react'
import { EnchantedDropParamsEditor } from './EnchantedDropParamsEditor'
import type { ParamsEditorProps } from './paramsEditorTypes'

export type { ParamsEditorProps } from './paramsEditorTypes'

/**
 * UI-side per-kind params-editor registry (issue #221, PRD §3/§5): keyed by
 * `AlertKind.id`, a `Record<kindId, ComponentType<ParamsEditorProps>>`. Kept
 * out of `catalog.ts` on purpose - the catalog stays React-free (the alerts
 * layering contract, `docs/notifications.md`), so a rule's *editor* lives
 * here while its *matching logic* lives there. `AlertSettings.tsx` looks up
 * `PARAMS_EDITORS[row.kindId]` per row (`settingsRows.ts`) and renders it
 * only when one is registered - a catalog entry with no params (`whiteBag`,
 * `orangeBag`) simply has none.
 * <p>
 * This file only imports pre-built editor components (never defines one
 * itself) so it can export a non-component value (`PARAMS_EDITORS` itself)
 * without tripping `react-refresh/only-export-components` - same rationale
 * as `panels/registry.ts`.
 */
export const PARAMS_EDITORS: Record<string, ComponentType<ParamsEditorProps>> = {
  enchantedDrop: EnchantedDropParamsEditor
}
