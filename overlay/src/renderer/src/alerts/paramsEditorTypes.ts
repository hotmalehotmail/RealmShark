/**
 * Shared type for `paramsEditors.ts`'s UI-side registry (issue #221) - kept
 * in its own type-only file so neither the registry module nor an editor
 * component module needs a value import from the other (`paramsEditors.ts`
 * imports the editor component; the editor component imports this type).
 */
export interface ParamsEditorProps {
  /** The kind's currently-resolved params (catalog defaults + user overrides - `resolveRuleSettings`). */
  params: Record<string, unknown>
  /** Replaces the full params object; `AlertSettings.tsx` writes it into `rules[kindId].params` and saves (debounced). */
  onChange: (next: Record<string, unknown>) => void
}
