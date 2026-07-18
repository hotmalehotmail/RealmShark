import { describe, expect, it } from 'vitest'
import { PingPlayer, type PingAudio } from '../src/renderer/src/alerts/sound'

describe('PingPlayer (issue #219, PRD §4 "Sound")', () => {
  it('plays on the first call', () => {
    const plays: number[] = []
    const player = new PingPlayer(() => ({
      volume: 1,
      play: () => plays.push(1)
    }))

    player.play(1, 0)

    expect(plays).toEqual([1])
  })

  it('coalesces plays within ~700ms to at most once', () => {
    const plays: number[] = []
    const player = new PingPlayer(() => ({
      volume: 1,
      play: () => plays.push(1)
    }))

    player.play(1, 0)
    player.play(1, 100)
    player.play(1, 699)
    expect(plays).toEqual([1])

    player.play(1, 700)
    expect(plays).toEqual([1, 1])
  })

  it('volume <= 0 mutes entirely - no audio is even constructed', () => {
    let constructed = 0
    const player = new PingPlayer(() => {
      constructed++
      return { volume: 1, play: () => {} }
    })

    player.play(0, 0)
    player.play(-1, 1000)

    expect(constructed).toBe(0)
  })

  it('forwards a clamped volume to the constructed audio', () => {
    const volumes: number[] = []
    let stored = 1
    const player = new PingPlayer((): PingAudio => ({
      get volume(): number {
        return stored
      },
      set volume(v: number) {
        stored = v
        volumes.push(v)
      },
      play: () => {}
    }))

    player.play(1.5, 0)
    player.play(0.4, 1000)

    expect(volumes).toEqual([1, 0.4])
  })
})
