/**
 * Item-name lookup helpers for `EnchantedDropParamsEditor`'s item-override
 * row (soak #232). Split out from the component so both are plain,
 * unit-testable functions:
 *
 * - `fuzzySearchItemNames` replaces the old `<input list>`/`<datalist>`,
 *   which rendered all ~11.4k names from `useItemNameCatalog()` into the DOM
 *   on every keystroke regardless of what was typed - the reported "laggy"
 *   item-override editor. This only ever returns up to `limit` matches, so
 *   the editor renders a handful of suggestion rows, not thousands of
 *   `<option>`s. Still scores every name against the query (soak #234:
 *   "optimize the search bar performance further"), so it also refuses to
 *   search at all below `MIN_QUERY_LENGTH` characters - a 1-2 character query
 *   matches thousands of the ~11.4k names anyway (useless ranking, worst-case
 *   scoring cost) - and `EnchantedDropParamsEditor` additionally debounces
 *   the query so a fast typist doesn't re-run a scan on every keystroke.
 * - `buildDisplayNameIndex` resolves an already-stored override key (always
 *   lowercased - see `EnchantedDropParamsEditor.setItemOverride`) back to its
 *   canonical, properly-cased catalog name, so the override list shows e.g.
 *   "Bow of Covert Havens" instead of the raw lowercased storage key.
 */

/**
 * Case-insensitive subsequence match: every character of `query`, in order,
 * somewhere in `target`. Scores contiguous runs and prefix matches higher so
 * "bow" ranks "Bow of Covert Havens" above an unrelated name that merely
 * contains b/o/w scattered through it. Returns `null` when `query` isn't a
 * subsequence of `target` at all.
 */
function fuzzyScore(query: string, target: string): number | null {
  let queryIndex = 0
  let score = 0
  let lastMatchIndex = -1
  for (
    let targetIndex = 0;
    targetIndex < target.length && queryIndex < query.length;
    targetIndex++
  ) {
    if (target[targetIndex] === query[queryIndex]) {
      score += lastMatchIndex === targetIndex - 1 ? 3 : 1
      lastMatchIndex = targetIndex
      queryIndex++
    }
  }
  if (queryIndex < query.length) return null
  if (target.startsWith(query)) score += 10
  return score
}

/** Below this many characters, `fuzzySearchItemNames` returns no suggestions rather than scoring the full ~11.4k-name catalog against a near-useless query (soak #234). */
export const MIN_QUERY_LENGTH = 3

/** Fuzzy-filters `names` against `query`, best matches first, capped at `limit`. Empty/whitespace-only query, or one shorter than {@link MIN_QUERY_LENGTH}, returns no suggestions. */
export function fuzzySearchItemNames(
  query: string,
  names: readonly string[],
  limit = 8
): readonly string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length < MIN_QUERY_LENGTH) return []

  const scored: { name: string; score: number }[] = []
  for (const name of names) {
    const score = fuzzyScore(trimmed, name.toLowerCase())
    if (score !== null) scored.push({ name, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return scored.slice(0, limit).map((s) => s.name)
}

/** lowercased name -> canonical (properly-cased) catalog name, for resolving a stored (lowercased) override key back to something human-readable. */
export function buildDisplayNameIndex(names: readonly string[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const name of names) index.set(name.toLowerCase(), name)
  return index
}
