import { useId, useState } from 'react'
import { Button } from '../ui/Button'
import type { EnchantedDropParams } from './catalog'
import type { ParamsEditorProps } from './paramsEditorTypes'
import { SLOT_TYPE_NAMES, slotTypeName } from './slotTypeNames'
import type { Tier } from './types'
import { useItemNameCatalog } from './useItemNameCatalog'

/** Rarity tier display names (PRD §3: "the UI shows the names, not numbers") - matches `sprites/enchantRarity.ts`'s tier scale. */
const TIER_NAMES: Record<Tier, string> = {
  1: 'uncommon',
  2: 'rare',
  3: 'legendary',
  4: 'divine'
}
const TIERS: readonly Tier[] = [1, 2, 3, 4]
const SLOT_TYPE_IDS: readonly number[] = Object.keys(SLOT_TYPE_NAMES).map(Number)

const SELECT_CLASS = 'rounded border border-edge bg-surface-2 px-1 py-0.5 text-2xs text-fg'
const INPUT_CLASS = `${SELECT_CLASS} min-w-0 flex-1`

function TierSelect({
  value,
  onChange
}: {
  value: Tier
  onChange: (tier: Tier) => void
}): React.JSX.Element {
  return (
    <select
      className={SELECT_CLASS}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as Tier)}
    >
      {TIERS.map((t) => (
        <option key={t} value={t}>
          {TIER_NAMES[t]}
        </option>
      ))}
    </select>
  )
}

/**
 * `enchantedDrop`'s params editor (PRD §3, the richest one): a global tier
 * dropdown, plus add/remove override rows for SlotType categories
 * (`slotTypeNames.ts`) and item names (autocomplete over the widened
 * `itemNames` table, `useItemNameCatalog.ts`; stored lowercased per PRD §3
 * "item overrides match ... case-insensitively"). Most-specific-wins
 * resolution itself lives in `catalog.ts`'s `enchantedDrop.match` - this
 * component only edits the params object. Registered under `paramsEditors.ts`.
 */
export function EnchantedDropParamsEditor({
  params,
  onChange
}: ParamsEditorProps): React.JSX.Element {
  const p = params as unknown as EnchantedDropParams
  const itemNames = useItemNameCatalog()
  const itemDatalistId = useId()

  const [newSlotType, setNewSlotType] = useState<number | undefined>(undefined)
  const [newSlotTier, setNewSlotTier] = useState<Tier>(p.tier)
  const [newItemName, setNewItemName] = useState('')
  const [newItemTier, setNewItemTier] = useState<Tier>(p.tier)

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
            <select
              className={INPUT_CLASS}
              value={selectedSlotType}
              onChange={(e) => setNewSlotType(Number(e.target.value))}
            >
              {availableSlotTypes.map((id) => (
                <option key={id} value={id}>
                  {slotTypeName(id) ?? `Slot ${id}`}
                </option>
              ))}
            </select>
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
            <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
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
          <input
            className={INPUT_CLASS}
            list={itemDatalistId}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            placeholder="Item name"
          />
          <datalist id={itemDatalistId}>
            {itemNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <TierSelect value={newItemTier} onChange={setNewItemTier} />
          <Button variant="ghost" size="xs" onClick={commitAddItem} disabled={!newItemName.trim()}>
            + add
          </Button>
        </div>
      </div>
    </div>
  )
}
