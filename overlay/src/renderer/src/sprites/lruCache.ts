/**
 * A fixed-capacity least-recently-used memo cache. Backed by a `Map`, which
 * preserves insertion order, so the oldest still-untouched key is always
 * `keys().next()`: `get` re-inserts a hit to mark it most-recently-used, and
 * `set` evicts from the front once `size` exceeds `max`.
 *
 * Used by `SpriteProvider` to bound its cropped/dyed-sprite caches, whose keys
 * are combinatorial (objectType × size × dye × enchant × animation frame) and
 * so grow monotonically over a long session as new player loadouts are seen -
 * an unbounded `Map` there was the renderer heap's dominant leak. An actively
 * animating sprite keeps re-touching its own frame keys, so eviction naturally
 * targets loadouts that have left view rather than the current working set.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined && !this.map.has(key)) return undefined
    // Re-insert so this key becomes most-recently-used (moves to the Map's tail).
    this.map.delete(key)
    this.map.set(key, value as V)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
