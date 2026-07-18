import type { NotificationsSettings } from '../../../shared/settings'
import { resolveRuleSettings } from './catalog'
import type { AlertKind, RuleSettings } from './types'

/**
 * One row of the notifications settings view (issue #221, PRD §5): a catalog
 * kind plus its currently-resolved settings (catalog defaults with any user
 * override merged on top - `catalog.ts`'s `resolveRuleSettings`). Kept as a
 * plain, React-free function so "rule rows are generated from the catalog"
 * (the settings-UI acceptance criterion) is directly testable without a DOM -
 * `AlertSettings.tsx` just maps this array to JSX and looks up
 * `paramsEditors.ts`'s `PARAMS_EDITORS[row.kindId]` for the optional params
 * editor.
 */
export interface RuleRow {
  kindId: string
  title: string
  settings: RuleSettings
}

/**
 * Builds one row per catalog entry, in catalog order (the same order the
 * dispatcher's banner priority uses - `catalog.ts`). A future catalog entry
 * needs no settings-UI change to appear here: `test/alerts-settingsRows.test.ts`
 * proves this with a synthetic entry.
 */
export function buildRuleRows(
  catalog: readonly AlertKind[],
  settings: NotificationsSettings
): RuleRow[] {
  return catalog.map((kind) => ({
    kindId: kind.id,
    title: kind.title,
    settings: resolveRuleSettings(kind, settings)
  }))
}
