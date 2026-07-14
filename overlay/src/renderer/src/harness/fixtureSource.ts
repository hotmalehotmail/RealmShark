import type { PacketEnvelope, SpritePack } from '../../../shared/ipc'
import type { HarnessSink } from './wsSource'

/** Envelopes delivered per animation frame in "instant" (default) playback - see `deliverInstant`. */
const CHUNK_SIZE = 25
/** Real-world cap on one paced-mode inter-batch delay, so a capture's long idle gaps don't stall a shot run. */
const MAX_PACED_DELAY_MS = 500

/** The shape `IPC.reportBug`/`CaptureRing.snapshot()` write - only `recentPackets` matters here (see `test/replay.ts`'s `loadCapture`, which this mirrors for the browser). */
interface CaptureFile {
  recentPackets?: PacketEnvelope[]
}

/**
 * Fetches a fixture published under `overlay/test/fixtures/` (served at the
 * harness dev server's root via `vite.harness.config.ts`'s `publicDir`).
 * Tries the gzipped form first (the convention for committed fixtures - see
 * `test/fixtures/captures/README.md`), falling back to a plain `.json` file
 * (e.g. the harness's own `gallery.json.gz`/`spritePack.json`). Accepts
 * either a bare `PacketEnvelope[]` or a full capture object
 * (`{recentPackets, ...}`).
 *
 * Vite's dev-server static file handling serves a `.gz` file with a
 * `Content-Encoding: gzip` response header, which the browser's network
 * stack transparently decodes before JS ever sees the body - so `res.text()`
 * already returns plain JSON in that case. Only fall back to manually
 * inflating via `DecompressionStream` when the server did NOT declare that
 * (e.g. a plain static host that serves `.gz` bytes verbatim), so this stays
 * correct outside Vite's dev server too.
 */
async function fetchFixtureEnvelopes(name: string): Promise<PacketEnvelope[]> {
  const gz = await fetch(`/${name}.json.gz`)
  let text: string
  if (gz.ok) {
    text =
      gz.headers.get('content-encoding') === 'gzip'
        ? await gz.text()
        : await new Response(gz.body!.pipeThrough(new DecompressionStream('gzip'))).text()
  } else {
    const plain = await fetch(`/${name}.json`)
    if (!plain.ok) throw new Error(`fixture not found: ${name} (tried .json.gz and .json)`)
    text = await plain.text()
  }
  const parsed = JSON.parse(text) as PacketEnvelope[] | CaptureFile
  const envelopes = Array.isArray(parsed) ? parsed : (parsed.recentPackets ?? [])
  return [...envelopes].sort((a, b) => a.time - b.time)
}

async function fetchSpritePack(): Promise<SpritePack | null> {
  try {
    const res = await fetch('/spritePack.json')
    if (!res.ok) return null
    return (await res.json()) as SpritePack
  } catch {
    return null
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Delivers every envelope within a handful of animation frames - the default, for a screenshot's "already mid-session" look. */
async function deliverInstant(sink: HarnessSink, envelopes: PacketEnvelope[]): Promise<void> {
  for (const batch of chunk(envelopes, CHUNK_SIZE)) {
    sink.onBatch(batch)
    await nextFrame()
  }
}

/** Delivers envelopes spaced by their original relative time deltas (capped), for watching a fixture play out like a real session. */
async function deliverPaced(sink: HarnessSink, envelopes: PacketEnvelope[]): Promise<void> {
  let lastTime = envelopes[0]?.time ?? 0
  for (const envelope of envelopes) {
    const delay = Math.min(MAX_PACED_DELAY_MS, Math.max(0, envelope.time - lastTime))
    lastTime = envelope.time
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    sink.onBatch([envelope])
  }
}

export interface FixtureSourceOptions {
  /** `?paced` - deliver respecting the fixture's own inter-envelope timing instead of near-instantly. */
  paced?: boolean
}

/**
 * Fixture data source (PRD §5.2 bullet 2): loads a committed
 * `overlay/test/fixtures/<name>.json[.gz]` capture/scenario and replays it
 * through the same `onPacketBatch`/`onSpritePack` shape the live bridge
 * would, after **rebasing timestamps** so the fixture's last envelope lands
 * at "now" - the trackers' rolling-window logic keys off `Date.now()` at
 * ingest time (`DpsTracker.ts`, `LootTracker.ts`), so an unrebased old
 * capture would read as "everything already expired." Sprites come from the
 * committed `spritePack.json` fixture (a small synthetic atlas - see
 * `docs/overlay-harness.md`), independent of whether the packet fixture
 * itself ever saw a ready sprite pack live.
 *
 * Sets `window.__harnessFixtureReady = true` once every envelope has been
 * delivered, so `e2e/shots.spec.ts` can wait deterministically instead of a
 * fixed sleep.
 */
export function startFixtureSource(
  name: string,
  sink: HarnessSink,
  opts: FixtureSourceOptions = {}
): void {
  sink.onStatus('connecting')
  window.__harnessFixtureReady = false

  void (async (): Promise<void> => {
    try {
      const envelopes = await fetchFixtureEnvelopes(name)
      sink.onStatus('connected')

      const pack = await fetchSpritePack()
      if (pack) sink.onSpritePack(pack)

      if (envelopes.length === 0) {
        window.__harnessFixtureReady = true
        return
      }

      const lastTime = envelopes[envelopes.length - 1].time
      const rebaseOffset = Date.now() - lastTime
      const rebased = envelopes.map((e) => ({ ...e, time: e.time + rebaseOffset }))

      if (opts.paced) {
        await deliverPaced(sink, rebased)
      } else {
        await deliverInstant(sink, rebased)
      }
      window.__harnessFixtureReady = true
    } catch (err) {
      console.error('[harness/fixture] failed to load fixture:', name, err)
      sink.onStatus('disconnected')
      window.__harnessFixtureReady = true
    }
  })()
}
