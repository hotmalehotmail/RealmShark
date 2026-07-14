import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCapture, replay, replayUntil } from './replay'

const ENVELOPES = [
  { type: 'MapInfoPacket', direction: 'SERVER', time: 200, data: { name: 'M', displayName: 'D' } },
  { type: 'CreateSuccessPacket', direction: 'SERVER', time: 100, data: { objectId: 1 } }
]

function tmpFile(name: string, contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-test-'))
  const file = join(dir, name)
  writeFileSync(file, contents)
  return file
}

afterEach(() => {
  vi.useRealTimers()
})

describe('loadCapture', () => {
  it('loads a bare envelope array from plain JSON, sorted by time', () => {
    const file = tmpFile('bare.json', JSON.stringify(ENVELOPES))
    const loaded = loadCapture(file)
    expect(loaded.map((e) => e.time)).toEqual([100, 200])
  })

  it('loads a full capture object (recentPackets field) from plain JSON', () => {
    const file = tmpFile(
      'full.json',
      JSON.stringify({ version: '1.0.0', recentPackets: ENVELOPES, mainLogs: [] })
    )
    const loaded = loadCapture(file)
    expect(loaded).toHaveLength(2)
    expect(loaded[0].type).toBe('CreateSuccessPacket')
  })

  it('loads a gzipped bare envelope array (.json.gz)', () => {
    const file = tmpFile('bare.json.gz', gzipSync(JSON.stringify(ENVELOPES)))
    const loaded = loadCapture(file)
    expect(loaded).toHaveLength(2)
  })

  it('loads a gzipped full capture object (.json.gz)', () => {
    const file = tmpFile(
      'full.json.gz',
      gzipSync(JSON.stringify({ version: '1.0.0', recentPackets: ENVELOPES }))
    )
    const loaded = loadCapture(file)
    expect(loaded).toHaveLength(2)
  })
})

describe('replay / replayUntil', () => {
  it("anchors the fake clock to each envelope's own time", () => {
    const seen: number[] = []
    replay({ ingest: (packets) => seen.push(...packets.map(() => Date.now())) }, ENVELOPES)
    expect(seen).toEqual([100, 200])
  })

  it('replayUntil stops ingesting past the cutoff and parks the clock there', () => {
    const seenTypes: string[] = []
    replayUntil(
      { ingest: (packets) => seenTypes.push(...packets.map((p) => p.type)) },
      ENVELOPES,
      100
    )
    expect(seenTypes).toEqual(['CreateSuccessPacket'])
    expect(Date.now()).toBe(100)
  })

  it('fans one envelope batch out to every tracker passed', () => {
    const a: string[] = []
    const b: string[] = []
    replay(
      [
        { ingest: (packets) => a.push(...packets.map((p) => p.type)) },
        { ingest: (packets) => b.push(...packets.map((p) => p.type)) }
      ],
      ENVELOPES
    )
    expect(a).toEqual(['CreateSuccessPacket', 'MapInfoPacket'])
    expect(b).toEqual(a)
  })
})
