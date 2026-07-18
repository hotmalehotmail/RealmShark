import { describe, expect, it } from 'vitest'
import { FiredAlertStore } from '../src/renderer/src/alerts/store'
import type { AlertPayload } from '../src/renderer/src/alerts/types'

const PAYLOAD: AlertPayload = { title: 'White bag!', body: 'Potion of Life' }

describe('FiredAlertStore (issue #218)', () => {
  it('append adds an entry with a unique id and notifies subscribers', () => {
    const store = new FiredAlertStore()
    const seen: number[] = []
    store.subscribe((alerts) => seen.push(alerts.length))

    const alert = store.append(PAYLOAD, ['whiteBag'], 1000)

    expect(alert.payload).toBe(PAYLOAD)
    expect(alert.matchedKindIds).toEqual(['whiteBag'])
    expect(store.getAll()).toHaveLength(1)
    expect(seen).toEqual([1])
  })

  it('bounds the log at 200 entries, oldest dropped first', () => {
    const store = new FiredAlertStore()
    for (let i = 0; i < 210; i++) {
      store.append(PAYLOAD, ['whiteBag'], i)
    }
    const all = store.getAll()
    expect(all).toHaveLength(200)
    expect(all[0].time).toBe(10) // the first 10 (times 0..9) were evicted
    expect(all[all.length - 1].time).toBe(209)
  })

  it('unsubscribe stops future notifications', () => {
    const store = new FiredAlertStore()
    const seen: number[] = []
    const unsubscribe = store.subscribe((alerts) => seen.push(alerts.length))
    store.append(PAYLOAD, ['whiteBag'], 1000)
    unsubscribe()
    store.append(PAYLOAD, ['orangeBag'], 2000)
    expect(seen).toEqual([1])
  })

  it('reset clears the session log', () => {
    const store = new FiredAlertStore()
    store.append(PAYLOAD, ['whiteBag'], 1000)
    store.reset()
    expect(store.getAll()).toEqual([])
  })
})
