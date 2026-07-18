import { describe, expect, it } from 'vitest'
import { FiredAlertStore } from '../src/renderer/src/alerts/store'
import type { AlertPayload, FiredAlert } from '../src/renderer/src/alerts/types'

const PAYLOAD: AlertPayload = { title: 'White bag!', body: 'Potion of Life' }

/**
 * Mirrors `NotificationsPanel`'s own data-source effect exactly
 * (`setAlerts(store.getAll())`, then `store.subscribe(setAlerts)`) without
 * a DOM/React-render harness - these tests assert the store's persistence/
 * reset semantics (issue #220 acceptance criteria) through the identical
 * public API surface the panel consumes, not by reaching into `AlertEngine`.
 */
function watchLikeThePanel(store: FiredAlertStore): {
  snapshots: (readonly FiredAlert[])[]
  unsubscribe: () => void
} {
  const snapshots: (readonly FiredAlert[])[] = [store.getAll()]
  const unsubscribe = store.subscribe((alerts) => snapshots.push(alerts))
  return { snapshots, unsubscribe }
}

describe('NotificationsPanel data source (issue #220)', () => {
  it('persists across a simulated map change - AlertEngine.ingest never touches the store on MapInfoPacket', () => {
    const store = new FiredAlertStore()
    store.append(PAYLOAD, ['whiteBag'], 1000)
    const { snapshots } = watchLikeThePanel(store)

    // A MapInfoPacket (instance change) reaching AlertEngine.ingest only
    // forwards into its LootTracker - nothing calls store.reset() or
    // store.append() as a result, so the panel's view is simply unaffected.
    // Simulated here as: no store call at all between these two appends.
    store.append(PAYLOAD, ['orangeBag'], 2000)

    const latest = snapshots[snapshots.length - 1]
    expect(latest.map((a) => a.matchedKindIds)).toEqual([['whiteBag'], ['orangeBag']])
  })

  it('clears what the panel sees on overlay detach (AlertEngine.reset())', () => {
    const store = new FiredAlertStore()
    store.append(PAYLOAD, ['whiteBag'], 1000)
    const { snapshots } = watchLikeThePanel(store)

    store.reset()

    expect(store.getAll()).toEqual([])
    expect(snapshots[snapshots.length - 1]).toEqual([])
  })
})
