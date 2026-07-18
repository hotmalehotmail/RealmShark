/**
 * SlotType id -> display name (issue #218, PRD §3 "SlotType names"). No
 * canonical id -> name table exists anywhere in the repo or the game's own
 * data dump, so this is derived empirically from the committed facts file
 * (`src/main/resources/assets/facts/asset-facts.json`, 2026-07-18 extraction)
 * by cross-referencing two independent signals:
 *
 * 1. Every playable class ships (up to) 4 starter "ST" test items named
 *    `<Class>ST<n>` (n=0 weapon, n=1 ability, n=2 armor, n=3 the universal
 *    ring - SlotType 9 for every class) - e.g. `WizardST0`=17, `WizardST1`=11,
 *    `WizardST2`=14, `WizardST3`=9. Reading these across every class pins
 *    each class's own weapon/ability/armor SlotType id exactly, with no
 *    guessing (`NecroST0`=17 confirms Necromancer's weapon shares the
 *    "Staff" id with Wizard/Mystic, not the id its item names might suggest -
 *    see point 2).
 * 2. Clustering the facts file's item names *within* each SlotType id
 *    confirms the human-facing category name - e.g. id 8's real (bagType>=0)
 *    items are overwhelmingly the "Wand of ..." family (Priest/Sorcerer/
 *    Summoner/Druid's shared weapon slot per point 1); id 11 is almost
 *    entirely "... Spell" (Wizard's ability); id 4 is "Tome of ..." (Priest's
 *    ability, NOT a weapon despite the flavor-text similarity to vanilla
 *    RotMG's Necromancer weapon name - point 1 is what pins this, the naming
 *    alone would have been a guess).
 *
 * Two ids intentionally get a generic rather than a flavor name: 0 (no real,
 * droppable facts-file item uses it - only internal/subattack pseudo-objects
 * do) and 10 (the facts file's large residual bucket - dyes, keys, potions,
 * pet-egg containers, cosmetic skins, and other non-equipment items; ~79% of
 * all facts-file items share it, confirmed via the `bagType>=0` filter in
 * `test/alerts-slotTypeNames.test.ts`).
 *
 * Spot-checked in `test/alerts-slotTypeNames.test.ts` against the live facts
 * file - e.g. every real item whose name starts with "Wand of" maps to id 8
 * ("Wand"), confirming both signals agree.
 */
export const SLOT_TYPE_NAMES: Record<number, string> = {
  0: 'Unclassified',
  1: 'Sword',
  2: 'Dagger',
  3: 'Bow',
  4: 'Tome',
  5: 'Shield',
  6: 'Light Armor',
  7: 'Heavy Armor',
  8: 'Wand',
  9: 'Ring',
  10: 'Other',
  11: 'Spell',
  12: 'Seal',
  13: 'Cloak',
  14: 'Robe',
  15: 'Quiver',
  16: 'Helm',
  17: 'Staff',
  18: 'Poison',
  19: 'Skull',
  20: 'Trap',
  21: 'Orb',
  22: 'Prism',
  23: 'Scepter',
  24: 'Katana',
  25: 'Star',
  26: 'Pet Egg',
  27: 'Wakizashi',
  28: 'Instrument',
  29: 'Mace',
  30: 'Sheath',
  31: 'Sigil'
}

/** Display name for a SlotType id, or `null` if unrecognized (e.g. a future asset update introducing a new id). */
export function slotTypeName(slotType: number): string | null {
  return SLOT_TYPE_NAMES[slotType] ?? null
}
