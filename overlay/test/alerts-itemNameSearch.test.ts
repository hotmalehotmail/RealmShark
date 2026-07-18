import { describe, expect, it } from 'vitest'
import {
  buildDisplayNameIndex,
  fuzzySearchItemNames
} from '../src/renderer/src/alerts/itemNameSearch'

const NAMES = [
  'Bow of Covert Havens',
  'Bow of the Void',
  'Wand of the Fallen Sanctuary',
  'Sword of Acclaim',
  'Bringer of Justice'
]

describe('fuzzySearchItemNames (soak #232 - item-override editor lag)', () => {
  it('returns no suggestions for an empty or whitespace-only query', () => {
    expect(fuzzySearchItemNames('', NAMES)).toEqual([])
    expect(fuzzySearchItemNames('   ', NAMES)).toEqual([])
  })

  it('matches case-insensitively as a subsequence, not just a substring', () => {
    // "bch" is not a substring of any name, but is a subsequence of "Bow of Covert Havens".
    expect(fuzzySearchItemNames('bch', NAMES)).toEqual(['Bow of Covert Havens'])
  })

  it('ranks a prefix match above a non-prefix subsequence match', () => {
    const namesWithScatteredMatch = [...NAMES, 'A Bowl of Stew']
    const results = fuzzySearchItemNames('bow', namesWithScatteredMatch)
    expect(results.slice(0, 2)).toEqual(
      expect.arrayContaining(['Bow of Covert Havens', 'Bow of the Void'])
    )
    // "A Bowl of Stew" contains "bow" as a substring but not a prefix - ranks below both "Bow of ..." names.
    expect(results.indexOf('A Bowl of Stew')).toBeGreaterThan(results.indexOf('Bow of the Void'))
  })

  it('caps results at the given limit even when more names match', () => {
    const manyNames = Array.from({ length: 50 }, (_, i) => `Item ${i} of Testing`)
    expect(fuzzySearchItemNames('item', manyNames, 5)).toHaveLength(5)
  })

  it('excludes names that are not a subsequence of the query at all', () => {
    expect(fuzzySearchItemNames('xyz123', NAMES)).toEqual([])
  })
})

describe('buildDisplayNameIndex (soak #232 - item-override display name)', () => {
  it('resolves a lowercased override key back to its canonical cased name', () => {
    const index = buildDisplayNameIndex(NAMES)
    expect(index.get('bow of covert havens')).toBe('Bow of Covert Havens')
    expect(index.get('sword of acclaim')).toBe('Sword of Acclaim')
  })

  it('has no entry for a name absent from the catalog', () => {
    const index = buildDisplayNameIndex(NAMES)
    expect(index.get('some renamed or removed item')).toBeUndefined()
  })
})
