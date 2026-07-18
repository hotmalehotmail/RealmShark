import pingUrl from '../assets/sfx/ping.wav'

/** Minimum gap between two pings (PRD §4 "Sound") - an 8-item bag or a chat burst still machine-guns at most once per this window. */
const COALESCE_MS = 700

/**
 * The surface `PingPlayer` needs from an audio element - narrowed so tests
 * can inject a mock with no DOM/`HTMLAudioElement` available (this suite
 * runs under vitest's plain `node` environment, no jsdom -
 * `docs/overlay-testing.md`).
 */
export interface PingAudio {
  volume: number
  play(): void
}

export type AudioFactory = () => PingAudio

/**
 * Wraps a real `HTMLAudioElement` playing the bundled ping asset, restarting
 * from the top on every play and swallowing a rejected `play()` promise
 * (Chromium's autoplay policy would otherwise log an unhandled rejection;
 * `main/index.ts`'s `autoplay-policy` switch is the actual fix, this is
 * defensive belt-and-suspenders).
 */
function defaultAudioFactory(): PingAudio {
  const audio = new Audio(pingUrl)
  return {
    get volume(): number {
      return audio.volume
    },
    set volume(value: number) {
      audio.volume = value
    },
    play(): void {
      audio.currentTime = 0
      void audio.play().catch(() => {})
    }
  }
}

/**
 * Plays the bundled ping (`alerts/sound.ts`, PRD §4), coalesced so a burst of
 * matched events fires at most one audible ping per {@link COALESCE_MS}.
 * `now` is injected with a default of `Date.now()` (mirrors
 * `dispatcher.ts`'s `now` parameter) purely so tests can drive it
 * deterministically without depending on wall-clock timing; production call
 * sites never pass it explicitly.
 */
export class PingPlayer {
  private lastPlayedAt = -Infinity

  constructor(private readonly createAudio: AudioFactory = defaultAudioFactory) {}

  /** `volume <= 0` mutes entirely (`NotificationsSettings.volume`, PRD §5) - no audio element is even constructed. */
  play(volume: number, now: number = Date.now()): void {
    if (volume <= 0) return
    if (now - this.lastPlayedAt < COALESCE_MS) return
    this.lastPlayedAt = now
    const audio = this.createAudio()
    audio.volume = Math.min(1, Math.max(0, volume))
    audio.play()
  }
}

/**
 * App-wide singleton `AlertToastHost` plays every ping through, so
 * coalescing is global (one ping per {@link COALESCE_MS} across every
 * matched event, not per-component). Tests construct their own
 * `new PingPlayer(mockFactory)` instead of importing this singleton, so
 * coalescing state never leaks between test cases.
 */
export const pingPlayer = new PingPlayer()
