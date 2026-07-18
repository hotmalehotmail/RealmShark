import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastQueue } from '../src/renderer/src/alerts/toastQueue'
import type { AlertPayload, FiredAlert } from '../src/renderer/src/alerts/types'

const PAYLOAD: AlertPayload = { title: 'White bag!', body: 'Potion of Life' }

function alert(id: string): FiredAlert {
  return { id, time: 0, payload: PAYLOAD, matchedKindIds: ['whiteBag'], banner: true, sound: true }
}

describe('ToastQueue (issue #219, PRD §4 "Stack capped at 3")', () => {
  let queue: ToastQueue

  beforeEach(() => {
    vi.useFakeTimers()
    queue = new ToastQueue()
  })

  afterEach(() => {
    queue.dispose()
    vi.useRealTimers()
  })

  it('shows a pushed alert immediately when a slot is free', () => {
    queue.push(alert('1'))
    expect(queue.getState()).toEqual({ visible: [alert('1')], overflow: 0 })
  })

  it('caps visible toasts at 3, queuing the rest as overflow', () => {
    for (const id of ['1', '2', '3', '4', '5']) queue.push(alert(id))
    const state = queue.getState()
    expect(state.visible.map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(state.overflow).toBe(2)
  })

  it('auto-dismisses toasts after ~5s and promotes queued ones into the freed slots', () => {
    for (const id of ['1', '2', '3', '4']) queue.push(alert(id))
    expect(queue.getState().visible.map((a) => a.id)).toEqual(['1', '2', '3'])
    expect(queue.getState().overflow).toBe(1)

    // All three visible toasts were pushed at the same simulated instant, so
    // they all expire together at +5s, promoting the one queued alert.
    vi.advanceTimersByTime(5000)

    const state = queue.getState()
    expect(state.visible.map((a) => a.id)).toEqual(['4'])
    expect(state.overflow).toBe(0)
  })

  it('a toast pushed later than others auto-dismisses on its own schedule', () => {
    queue.push(alert('1'))
    vi.advanceTimersByTime(2000)
    queue.push(alert('2'))

    vi.advanceTimersByTime(3000) // t=5000: '1' expires, '2' has 2s left
    expect(queue.getState().visible.map((a) => a.id)).toEqual(['2'])

    vi.advanceTimersByTime(2000) // t=7000: '2' expires
    expect(queue.getState().visible.map((a) => a.id)).toEqual([])
  })

  it('click-to-dismiss removes the toast immediately and promotes the next queued one', () => {
    for (const id of ['1', '2', '3', '4']) queue.push(alert(id))

    queue.dismiss('2')

    const state = queue.getState()
    expect(state.visible.map((a) => a.id)).toEqual(['1', '3', '4'])
    expect(state.overflow).toBe(0)
  })

  it('dismissing an id that is not currently visible is a no-op', () => {
    queue.push(alert('1'))
    queue.dismiss('nonexistent')
    expect(queue.getState().visible.map((a) => a.id)).toEqual(['1'])
  })

  it('notifies subscribers on push, dismiss, and auto-expire', () => {
    const seen: number[] = []
    queue.subscribe((state) => seen.push(state.visible.length))

    queue.push(alert('1'))
    queue.push(alert('2'))
    queue.dismiss('1')
    vi.advanceTimersByTime(5000)

    expect(seen).toEqual([1, 2, 1, 0])
  })

  it('dispose cancels pending auto-dismiss timers (no further state changes)', () => {
    queue.push(alert('1'))
    const seen: number[] = []
    queue.subscribe((state) => seen.push(state.visible.length))

    queue.dispose()
    vi.advanceTimersByTime(10000)

    expect(seen).toEqual([])
  })

  it('dispose clears visible/queued state, not just timers - a remount starts genuinely empty', () => {
    for (const id of ['1', '2', '3', '4']) queue.push(alert(id))
    expect(queue.getState()).toEqual({ visible: expect.any(Array), overflow: 1 })

    queue.dispose()

    expect(queue.getState()).toEqual({ visible: [], overflow: 0 })

    // A fresh push after dispose behaves like a brand-new queue.
    queue.push(alert('5'))
    expect(queue.getState()).toEqual({ visible: [alert('5')], overflow: 0 })
  })
})
