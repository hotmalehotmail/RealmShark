import { useEffect, useRef, useState } from 'react'
import type { OverlaySettings } from '../../../shared/settings'
import type { PanelSettingsProps } from '../panels/registry'
import { Button } from '../ui/Button'
import { CATALOG } from './catalog'
import { PARAMS_EDITORS } from './paramsEditors'
import { buildRuleRows, type RuleRow } from './settingsRows'

/** "Apply on change, no Save button" (PRD §5) - short debounce so a dragged slider doesn't spam `save-settings` on every tick. */
const SAVE_DEBOUNCE_MS = 300

/**
 * The Notifications panel's settings view (issue #221, PRD §5) - the first
 * user of the generic per-panel gear mechanism (`registry.ts`'s
 * `PanelSettingsProps`, `panels/PanelFrame.tsx`). Master on/off, a volume
 * slider with a test-ping button, and one row per catalog entry (enable/
 * banner/sound + its params editor if one is registered in
 * `paramsEditors.ts`) - rows come from `settingsRows.ts`'s `buildRuleRows`,
 * so a future catalog entry needs no edit here.
 * <p>
 * Owns its own storage (PRD §5 "Each settings component owns its storage"):
 * reads/writes the full `OverlaySettings` via the existing
 * `getSettings`/`saveSettings`/`onSettingsChanged` IPC (zero new IPC surface)
 * rather than just the `notifications` slice, since `saveSettings` always
 * takes the whole object - edits to other fields (elsewhere, e.g.
 * `ConfigWindow`) arriving via `onSettingsChanged` while this view is open
 * are folded into the next save instead of being clobbered.
 */
export function NotificationsSettingsView({ onDone }: PanelSettingsProps): React.JSX.Element {
  const fullSettingsRef = useRef<OverlaySettings | null>(null)
  const [notifications, setNotifications] = useState<OverlaySettings['notifications'] | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    window.overlay.getSettings().then((s) => {
      fullSettingsRef.current = s
      setNotifications(s.notifications)
    })
    const offSettings = window.overlay.onSettingsChanged((s) => {
      fullSettingsRef.current = s
      setNotifications(s.notifications)
    })
    return () => {
      offSettings()
      if (saveTimer.current !== undefined) {
        clearTimeout(saveTimer.current)
        if (fullSettingsRef.current) window.overlay.saveSettings(fullSettingsRef.current)
      }
    }
  }, [])

  const update = (next: OverlaySettings['notifications']): void => {
    setNotifications(next)
    if (fullSettingsRef.current)
      fullSettingsRef.current = { ...fullSettingsRef.current, notifications: next }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined
      if (fullSettingsRef.current) window.overlay.saveSettings(fullSettingsRef.current)
    }, SAVE_DEBOUNCE_MS)
  }

  if (!notifications) {
    return <div className="text-2xs text-fg-faint">Loading settings…</div>
  }

  const rows: RuleRow[] = buildRuleRows(CATALOG, notifications)

  const updateRule = (
    kindId: string,
    patch: Partial<{
      enabled: boolean
      banner: boolean
      sound: boolean
      params: Record<string, unknown>
    }>
  ): void => {
    const row = rows.find((r) => r.kindId === kindId)
    const current = notifications.rules[kindId] ??
      row?.settings ?? { enabled: true, banner: true, sound: true }
    update({
      ...notifications,
      rules: { ...notifications.rules, [kindId]: { ...current, ...patch } }
    })
  }

  return (
    // A single flat flow, not a nested scrollport (no `h-full`/inner
    // `overflow-y-auto`) - `PanelFrame`'s own content wrapper is already the
    // scroll container every panel body relies on, and `e2e/shots.spec.ts`'s
    // below-the-fold clip detection only measures that outer wrapper. A
    // second, inner `overflow-y-auto` would clip silently invisibly to that
    // check (found via the sm-preset settings shot showing an empty strip
    // with no `-full` variant generated to explain it).
    <div className="flex flex-col gap-2.5 text-2xs">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={notifications.enabled}
          onChange={(e) => update({ ...notifications, enabled: e.target.checked })}
        />
        <span className="text-fg">Notifications enabled</span>
      </label>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-fg-muted">
            Volume: <span className="font-mono">{Math.round(notifications.volume * 100)}%</span>
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              // Dynamic import, not a static one (issue #221): `sound.ts`
              // statically imports the bundled `.wav` asset, which
              // `e2e/shots.spec.ts`'s top-level `PANEL_REGISTRY` loop -
              // evaluated directly by Playwright's Node-based test
              // collector, no Vite asset transform - can't parse. Deferring
              // the import to click time keeps `sound.ts` out of
              // `registry.ts`'s eagerly-resolved module graph entirely.
              void import('./sound').then(({ pingPlayer }) => pingPlayer.play(notifications.volume))
            }}
            title="Play the notification ping at the current volume"
          >
            Test ping
          </Button>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={notifications.volume}
          onChange={(e) => update({ ...notifications, volume: Number(e.target.value) })}
        />
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const ParamsEditor = PARAMS_EDITORS[row.kindId]
          return (
            <div key={row.kindId} className="rounded border border-edge/60 bg-surface-2 p-1.5">
              <span className="block truncate font-medium text-fg">{row.title}</span>
              {/* Stacked below the title (not beside it) at every size, not
                  just sm: `sm`'s 220px content width can't fit a title plus
                  three labeled checkboxes on one line without squeezing both
                  unreadable - see the notifications-sm-settings.png gallery
                  shot before this change. Vertical space can grow the
                  panel's outer scroll (and trigger the `-full` shot
                  variant); horizontal squeeze can't. */}
              <div className="mt-1 flex items-center gap-3">
                <label className="flex items-center gap-1" title="Enabled">
                  <input
                    type="checkbox"
                    checked={row.settings.enabled}
                    onChange={(e) => updateRule(row.kindId, { enabled: e.target.checked })}
                  />
                  on
                </label>
                <label className="flex items-center gap-1" title="Banner">
                  <input
                    type="checkbox"
                    checked={row.settings.banner}
                    onChange={(e) => updateRule(row.kindId, { banner: e.target.checked })}
                  />
                  banner
                </label>
                <label className="flex items-center gap-1" title="Sound">
                  <input
                    type="checkbox"
                    checked={row.settings.sound}
                    onChange={(e) => updateRule(row.kindId, { sound: e.target.checked })}
                  />
                  sound
                </label>
              </div>
              {ParamsEditor && (
                <div className="mt-1.5">
                  <ParamsEditor
                    params={row.settings.params}
                    onChange={(params) => updateRule(row.kindId, { params })}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Button variant="subtle" size="sm" className="self-start" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
