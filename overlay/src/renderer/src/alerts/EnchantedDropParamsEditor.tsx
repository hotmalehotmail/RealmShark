import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import type { EnchantedDropParams } from './catalog'
import { buildDisplayNameIndex, fuzzySearchItemNames } from './itemNameSearch'
import type { ParamsEditorProps } from './paramsEditorTypes'
import { SLOT_TYPE_NAMES, slotTypeName } from './slotTypeNames'
import type { Tier } from './types'
import { useItemNameCatalog } from './useItemNameCatalog'

/** Debounce before re-running the fuzzy search on a keystroke (soak #234 - "optimize the search bar performance further"), on top of `fuzzySearchItemNames`'s own `MIN_QUERY_LENGTH` floor. */
const SEARCH_DEBOUNCE_MS = 150

/** Gap between the item-name input and the portaled suggestion dropdown, and the viewport margin it's clamped to. */
const SUGGESTIONS_GAP = 2
const VIEWPORT_MARGIN = 8
/** Matches the dropdown's own `max-h-32` (8rem) - the worst-case height used to decide whether it should open upward instead of measuring the actual (variable) rendered height. */
const SUGGESTIONS_MAX_HEIGHT = 128

/** Rarity tier display names (PRD §3: "the UI shows the names, not numbers") - matches `sprites/enchantRarity.ts`'s tier scale. */
const TIER_NAMES: Record<Tier, string> = {
  1: 'uncommon',
  2: 'rare',
  3: 'legendary',
  4: 'divine'
}
const TIERS: readonly Tier[] = [1, 2, 3, 4]
const SLOT_TYPE_IDS: readonly number[] = Object.keys(SLOT_TYPE_NAMES).map(Number)

const TEXT_INPUT_CLASS =
  'w-full rounded border border-edge bg-surface-2 px-1 py-0.5 text-2xs text-fg'

function TierSelect({
  value,
  onChange
}: {
  value: Tier
  onChange: (tier: Tier) => void
}): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value) as Tier)}>
      {TIERS.map((t) => (
        <option key={t} value={t}>
          {TIER_NAMES[t]}
        </option>
      ))}
    </Select>
  )
}

/**
 * `enchantedDrop`'s params editor (PRD §3, the richest one): a global tier
 * dropdown, plus add/remove override rows for SlotType categories
 * (`slotTypeNames.ts`) and item names (fuzzy search over the widened
 * `itemNames` table, `useItemNameCatalog.ts` + `itemNameSearch.ts`; stored
 * lowercased per PRD §3 "item overrides match ... case-insensitively", shown
 * resolved back to their canonical cased form via `buildDisplayNameIndex`).
 * Most-specific-wins resolution itself lives in `catalog.ts`'s
 * `enchantedDrop.match` - this component only edits the params object.
 * Registered under `paramsEditors.ts`.
 * <p>
 * The item-name field used to be a plain `<input list>` bound to a
 * `<datalist>` of every catalog name (~11.4k) - rendering all of them into
 * the DOM on every keystroke regardless of what was typed was the reported
 * "laggy" item-override editor (soak #232). It's now a small fuzzy-filtered
 * suggestion list (`fuzzySearchItemNames`, capped at a handful of matches,
 * debounced `SEARCH_DEBOUNCE_MS` and skipped below `MIN_QUERY_LENGTH`
 * characters - soak #234) shown only while the field is focused and
 * non-empty. The suggestion dropdown itself is portaled to `document.body`
 * (same pattern as `ui/Tooltip.tsx`) rather than absolutely positioned
 * in-flow: `PanelFrame`'s content wrapper is `overflow-auto` (its frame
 * `overflow-hidden`), so an in-flow dropdown gets clipped the moment it
 * would extend past the panel's own edge - reported as "the dropdown menu
 * is cut off" against the Notifications settings panel (soak #234).
 */
export function EnchantedDropParamsEditor({
  params,
  onChange
}: ParamsEditorProps): React.JSX.Element {
  const p = params as unknown as EnchantedDropParams
  const itemNames = useItemNameCatalog()
  const displayNameIndex = useMemo(() => buildDisplayNameIndex(itemNames), [itemNames])

  const [newSlotType, setNewSlotType] = useState<number | undefined>(undefined)
  const [newSlotTier, setNewSlotTier] = useState<Tier>(p.tier)
  const [newItemName, setNewItemName] = useState('')
  const [debouncedItemName, setDebouncedItemName] = useState('')
  const [newItemTier, setNewItemTier] = useState<Tier>(p.tier)
  const [itemInputFocused, setItemInputFocused] = useState(false)
  const itemInputRef = useRef<HTMLInputElement>(null)
  const [suggestionsPos, setSuggestionsPos] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedItemName(newItemName), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [newItemName])

  const itemSuggestions = useMemo(
    () => fuzzySearchItemNames(debouncedItemName, itemNames),
    [debouncedItemName, itemNames]
  )
  const showItemSuggestions = itemInputFocused && itemSuggestions.length > 0

  // Positions the portaled dropdown against the input's current viewport
  // rect (`getBoundingClientRect`, not CSS) each time it opens or its
  // content changes size (the suggestion count affects height) - opens
  // upward when there isn't room below, viewport-clamped either way, so it
  // can never be clipped by an ancestor panel's overflow.
  useLayoutEffect(() => {
    if (!showItemSuggestions || !itemInputRef.current) {
      setSuggestionsPos(null)
      return
    }
    const inputRect = itemInputRef.current.getBoundingClientRect()
    let top = inputRect.bottom + SUGGESTIONS_GAP
    if (top + SUGGESTIONS_MAX_HEIGHT > window.innerHeight - VIEWPORT_MARGIN) {
      top = inputRect.top - SUGGESTIONS_MAX_HEIGHT - SUGGESTIONS_GAP
    }
    top = Math.max(VIEWPORT_MARGIN, top)
    setSuggestionsPos({ left: inputRect.left, top, width: inputRect.width })
  }, [showItemSuggestions, itemSuggestions])

  const update = (next: Partial<EnchantedDropParams>): void => {
    onChange({ ...p, ...next } as unknown as Record<string, unknown>)
  }

  const setSlotOverride = (slotType: number, tier: Tier): void => {
    update({ slotTypeOverrides: { ...p.slotTypeOverrides, [slotType]: tier } })
  }
  const removeSlotOverride = (slotType: number): void => {
    const next = { ...p.slotTypeOverrides }
    delete next[slotType]
    update({ slotTypeOverrides: next })
  }

  const setItemOverride = (name: string, tier: Tier): void => {
    update({ itemOverrides: { ...p.itemOverrides, [name.toLowerCase()]: tier } })
  }
  const removeItemOverride = (name: string): void => {
    const next = { ...p.itemOverrides }
    delete next[name]
    update({ itemOverrides: next })
  }

  const availableSlotTypes = SLOT_TYPE_IDS.filter((id) => !(id in p.slotTypeOverrides))
  const selectedSlotType =
    newSlotType != null && availableSlotTypes.includes(newSlotType)
      ? newSlotType
      : availableSlotTypes[0]

  const commitAddSlot = (): void => {
    if (selectedSlotType == null) return
    setSlotOverride(selectedSlotType, newSlotTier)
    setNewSlotType(undefined)
    setNewSlotTier(p.tier)
  }

  const commitAddItem = (): void => {
    const trimmed = newItemName.trim()
    if (!trimmed) return
    setItemOverride(trimmed, newItemTier)
    setNewItemName('')
    setNewItemTier(p.tier)
  }

  return (
    <div className="flex flex-col gap-2 text-2xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-muted">Global tier</span>
        <TierSelect value={p.tier} onChange={(t) => update({ tier: t })} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-fg-muted">Category overrides</span>
        {Object.entries(p.slotTypeOverrides).map(([slotTypeStr, tier]) => {
          const slotType = Number(slotTypeStr)
          return (
            <div key={slotType} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-fg">
                {slotTypeName(slotType) ?? `Slot ${slotType}`}
              </span>
              <TierSelect value={tier} onChange={(t) => setSlotOverride(slotType, t)} />
              <Button
                variant="ghost"
                size="xs"
                onClick={() => removeSlotOverride(slotType)}
                title="Remove override"
              >
                ✕
              </Button>
            </div>
          )
        })}
        {availableSlotTypes.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Select
              className="min-w-0 flex-1"
              value={selectedSlotType}
              onChange={(e) => setNewSlotType(Number(e.target.value))}
            >
              {availableSlotTypes.map((id) => (
                <option key={id} value={id}>
                  {slotTypeName(id) ?? `Slot ${id}`}
                </option>
              ))}
            </Select>
            <TierSelect value={newSlotTier} onChange={setNewSlotTier} />
            <Button variant="ghost" size="xs" onClick={commitAddSlot}>
              + add
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-fg-muted">Item overrides</span>
        {Object.entries(p.itemOverrides).map(([name, tier]) => (
          <div key={name} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-fg">
              {displayNameIndex.get(name) ?? name}
            </span>
            <TierSelect value={tier} onChange={(t) => setItemOverride(name, t)} />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => removeItemOverride(name)}
              title="Remove override"
            >
              ✕
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <input
              ref={itemInputRef}
              className={TEXT_INPUT_CLASS}
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onFocus={() => setItemInputFocused(true)}
              onBlur={() => setItemInputFocused(false)}
              placeholder="Item name"
            />
            {showItemSuggestions &&
              suggestionsPos &&
              createPortal(
                <div
                  className="fixed z-[9999] max-h-32 overflow-y-auto rounded border border-edge bg-surface-2 shadow-lg"
                  style={{
                    left: suggestionsPos.left,
                    top: suggestionsPos.top,
                    width: suggestionsPos.width
                  }}
                >
                  {itemSuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="block w-full truncate px-1.5 py-0.5 text-left text-fg hover:bg-surface-3"
                      // onMouseDown (not onClick) fires before the input's
                      // onBlur - preventDefault keeps focus in the input so
                      // selecting a suggestion never races the blur that would
                      // otherwise close this list first.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setNewItemName(name)
                        setDebouncedItemName(name)
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>,
                document.body
              )}
          </div>
          <TierSelect value={newItemTier} onChange={setNewItemTier} />
          <Button variant="ghost" size="xs" onClick={commitAddItem} disabled={!newItemName.trim()}>
            + add
          </Button>
        </div>
      </div>
    </div>
  )
}
