import type { NotificationsSettings } from '../../../shared/settings'
import { resolveRuleSettings } from './catalog'
import type { AlertKind, AlertPayload, GameEvent } from './types'

export interface DispatchResult {
  /** The payload the history entry (and, if non-null, the banner) shows. */
  payload: AlertPayload
  /** Non-null iff at least one surviving match wants a banner - the payload to show there is always `payload` itself. */
  banner: AlertPayload | null
  /** True iff at least one surviving match wants a sound. */
  sound: boolean
  /** Every kind id that matched and survived cooldown filtering, in catalog order. */
  matchedKindIds: string[]
}

interface Survivor {
  kindId: string
  payload: AlertPayload
  banner: boolean
  sound: boolean
}

/**
 * Multi-match resolution for one `GameEvent` against the catalog (PRD §3
 * "Multi-match semantics"):
 *
 * 1. Evaluate every *enabled* catalog rule whose `eventType` matches; a rule
 *    on cooldown (its own `cooldownMs`, tracked in `lastFiredAt` by kind id)
 *    is dropped even if it matched. No survivors -> returns `null`.
 * 2. Banner: the payload of the first survivor (in catalog order) that wants
 *    one. If no survivor wants a banner, falls back to the first survivor's
 *    payload anyway (`result.banner` stays `null` in that case - nothing
 *    should pop up - but the history entry still needs *something* to show).
 * 3. Sound: OR across every survivor.
 * 4. `matchedKindIds` carries every survivor, not just the one whose payload
 *    is shown, so a viewer can see why an alert fired even though only one
 *    banner/body appeared.
 *
 * `now`/`lastFiredAt` are threaded in explicitly (rather than read from
 * `Date.now()` internally) so this stays a pure, directly-testable function -
 * `AlertEngine` owns the real cooldown map and clock.
 */
export function dispatchEvent(
  event: GameEvent,
  catalog: readonly AlertKind[],
  settings: NotificationsSettings,
  now: number,
  lastFiredAt: Map<string, number>
): DispatchResult | null {
  if (!settings.enabled) return null

  const survivors: Survivor[] = []
  for (const kind of catalog) {
    if (kind.eventType !== event.type) continue
    const rule = resolveRuleSettings(kind, settings)
    if (!rule.enabled) continue
    const payload = kind.match(event, rule.params, settings)
    if (!payload) continue
    if (kind.cooldownMs != null) {
      const last = lastFiredAt.get(kind.id)
      if (last != null && now - last < kind.cooldownMs) continue
    }
    survivors.push({ kindId: kind.id, payload, banner: rule.banner, sound: rule.sound })
  }
  if (survivors.length === 0) return null

  for (const survivor of survivors) lastFiredAt.set(survivor.kindId, now)

  const bannerSurvivor = survivors.find((s) => s.banner)
  const displayPayload = (bannerSurvivor ?? survivors[0]).payload
  return {
    payload: displayPayload,
    banner: bannerSurvivor ? displayPayload : null,
    sound: survivors.some((s) => s.sound),
    matchedKindIds: survivors.map((s) => s.kindId)
  }
}
