import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SLOT_TYPE_NAMES, slotTypeName } from '../src/renderer/src/alerts/slotTypeNames'

const FACTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'main',
  'resources',
  'assets',
  'facts',
  'asset-facts.json'
)

interface FactsItem {
  name: string
  bagType?: number
  slotType?: number
}

interface FactsFile {
  items: Record<string, FactsItem>
}

function loadRealFactsItems(): FactsItem[] {
  const facts = JSON.parse(readFileSync(FACTS_PATH, 'utf-8')) as FactsFile
  // bagType < 0 covers internal/ability-proc pseudo-items (e.g. "Wand of
  // Hidden Knowledge Proc") that reuse a class's weapon flavor text but
  // aren't real droppable items - see slotTypeNames.ts's doc comment.
  return Object.values(facts.items).filter((item) => (item.bagType ?? -1) >= 0)
}

describe('slotTypeNames (issue #218, spot-checked against the committed facts file)', () => {
  it('every real item whose name starts with "Wand of" maps to the id named Wand', () => {
    const items = loadRealFactsItems()
    const wands = items.filter((item) => item.name.startsWith('Wand of'))
    expect(wands.length).toBeGreaterThan(0)
    for (const item of wands) {
      expect(slotTypeName(item.slotType ?? 0)).toBe('Wand')
    }
  })

  it('every real item whose name starts with "Bow of" maps to the id named Bow', () => {
    const items = loadRealFactsItems()
    const bows = items.filter((item) => item.name.startsWith('Bow of'))
    expect(bows.length).toBeGreaterThan(0)
    for (const item of bows) {
      expect(slotTypeName(item.slotType ?? 0)).toBe('Bow')
    }
  })

  it('every real item whose name starts with "Robe of" maps to the id named Robe', () => {
    const items = loadRealFactsItems()
    const robes = items.filter((item) => item.name.startsWith('Robe of'))
    expect(robes.length).toBeGreaterThan(0)
    for (const item of robes) {
      expect(slotTypeName(item.slotType ?? 0)).toBe('Robe')
    }
  })

  it('the confirmed objectType 283 "The Hive Key" (issue #217) maps to SlotType 10, named Other', () => {
    const facts = JSON.parse(readFileSync(FACTS_PATH, 'utf-8')) as FactsFile
    const hiveKey = facts.items['283']
    expect(hiveKey?.name).toBe('The Hive Key')
    expect(hiveKey?.slotType).toBe(10)
    expect(slotTypeName(10)).toBe('Other')
  })

  it('every SlotType id present among real (droppable) facts items has a name', () => {
    const items = loadRealFactsItems()
    const slotTypesInUse = new Set(items.map((item) => item.slotType ?? 0))
    const missing = Array.from(slotTypesInUse).filter(
      (slotType) => SLOT_TYPE_NAMES[slotType] === undefined
    )
    expect(missing).toEqual([])
  })
})
