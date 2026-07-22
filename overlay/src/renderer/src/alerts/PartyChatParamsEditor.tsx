import { useState } from 'react'
import { Button } from '../ui/Button'
import type { PartyChatParams } from './catalog'
import type { ParamsEditorProps } from './paramsEditorTypes'

const TEXT_INPUT_CLASS =
  'w-full rounded border border-edge bg-surface-2 px-1 py-0.5 text-2xs text-fg'
/** Narrow, right-aligned variant for the cooldown field - `TEXT_INPUT_CLASS`'s `w-full` would otherwise fight a `w-16` override at equal Tailwind specificity (soak-visible: the field rendered full-width regardless of class order). */
const NUMBER_INPUT_CLASS =
  'w-16 rounded border border-edge bg-surface-2 px-1 py-0.5 text-right text-2xs text-fg'

/** Floor for the cooldown field (issue #269) - a blank/non-numeric edit is a no-op rather than writing `NaN`/0 into params, and any numeric edit is clamped up to this floor. */
const MIN_COOLDOWN_SECONDS = 1

/**
 * `partyChat`'s params editor (issue #222): a plain add/remove keyword list -
 * empty means every party message matches (`catalog.ts`'s `partyChat.match`
 * doc comment) - plus a cooldown field (issue #269) letting the user override
 * the catalog's default debounce window. Deliberately the simplest editor in
 * `paramsEditors.ts`'s registry - no autocomplete/fuzzy-search machinery like
 * `EnchantedDropParamsEditor`'s item names, since keywords are free text, not
 * a lookup against a known catalog.
 */
export function PartyChatParamsEditor({ params, onChange }: ParamsEditorProps): React.JSX.Element {
  const p = params as unknown as PartyChatParams
  const keywords = p.keywords ?? []
  const [newKeyword, setNewKeyword] = useState('')

  const update = (next: Partial<PartyChatParams>): void => {
    onChange({ ...p, ...next } as unknown as Record<string, unknown>)
  }

  const updateKeywords = (next: string[]): void => update({ keywords: next })

  const commitAdd = (): void => {
    const trimmed = newKeyword.trim()
    if (!trimmed || keywords.includes(trimmed)) return
    updateKeywords([...keywords, trimmed])
    setNewKeyword('')
  }

  const removeKeyword = (keyword: string): void => {
    updateKeywords(keywords.filter((k) => k !== keyword))
  }

  const cooldownSeconds = Math.round(p.cooldownMs / 1000)
  const setCooldownSeconds = (seconds: number): void => {
    const clamped = Math.max(MIN_COOLDOWN_SECONDS, Math.round(seconds))
    update({ cooldownMs: clamped * 1000 })
  }

  return (
    <div className="flex flex-col gap-2 text-2xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-muted">Cooldown (seconds)</span>
        <input
          type="number"
          min={MIN_COOLDOWN_SECONDS}
          step={1}
          className={NUMBER_INPUT_CLASS}
          value={cooldownSeconds}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (Number.isFinite(parsed)) setCooldownSeconds(parsed)
          }}
        />
      </div>
      <span className="text-fg-muted">
        Keywords {keywords.length === 0 && '(empty = every party message)'}
      </span>
      {keywords.map((keyword) => (
        <div key={keyword} className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-fg">{keyword}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => removeKeyword(keyword)}
            title="Remove keyword"
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          className={TEXT_INPUT_CLASS}
          value={newKeyword}
          onChange={(e) => setNewKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAdd()
          }}
          placeholder="Keyword"
        />
        <Button variant="ghost" size="xs" onClick={commitAdd} disabled={!newKeyword.trim()}>
          + add
        </Button>
      </div>
    </div>
  )
}
