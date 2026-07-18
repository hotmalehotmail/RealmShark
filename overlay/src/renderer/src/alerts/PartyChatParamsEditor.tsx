import { useState } from 'react'
import { Button } from '../ui/Button'
import type { PartyChatParams } from './catalog'
import type { ParamsEditorProps } from './paramsEditorTypes'

const TEXT_INPUT_CLASS =
  'w-full rounded border border-edge bg-surface-2 px-1 py-0.5 text-2xs text-fg'

/**
 * `partyChat`'s params editor (issue #222): a plain add/remove keyword list -
 * empty means every party message matches (`catalog.ts`'s `partyChat.match`
 * doc comment). Deliberately the simplest editor in `paramsEditors.ts`'s
 * registry - no autocomplete/fuzzy-search machinery like
 * `EnchantedDropParamsEditor`'s item names, since keywords are free text, not
 * a lookup against a known catalog.
 */
export function PartyChatParamsEditor({ params, onChange }: ParamsEditorProps): React.JSX.Element {
  const p = params as unknown as PartyChatParams
  const keywords = p.keywords ?? []
  const [newKeyword, setNewKeyword] = useState('')

  const update = (next: string[]): void => {
    onChange({ ...p, keywords: next } as unknown as Record<string, unknown>)
  }

  const commitAdd = (): void => {
    const trimmed = newKeyword.trim()
    if (!trimmed || keywords.includes(trimmed)) return
    update([...keywords, trimmed])
    setNewKeyword('')
  }

  const removeKeyword = (keyword: string): void => {
    update(keywords.filter((k) => k !== keyword))
  }

  return (
    <div className="flex flex-col gap-1 text-2xs">
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
