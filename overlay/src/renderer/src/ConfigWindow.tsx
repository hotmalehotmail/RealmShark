import { useEffect, useState } from 'react'
import type { OverlaySettings } from '../../shared/settings'
import { Button } from './ui/Button'

function ConfigWindow(): React.JSX.Element {
  const [settings, setSettings] = useState<OverlaySettings | null>(null)
  const [status, setStatus] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)

  useEffect(() => {
    window.overlay.getSettings().then(setSettings)
  }, [])

  if (!settings) {
    return <div className="p-4 text-sm text-fg">Loading…</div>
  }

  const save = async (): Promise<void> => {
    const result = await window.overlay.saveSettings(settings)
    setNeedsRestart(result.needsRestart)
    setStatus(
      result.hotkeyRegistered
        ? 'Saved.'
        : 'Hotkey could not be registered (invalid, or already used by another app) - kept the previous one.'
    )
  }

  return (
    <div className="flex h-screen flex-col gap-4 bg-shell p-5 text-sm text-fg">
      <div>
        <label className="mb-1 block text-fg-muted">Game window title</label>
        <input
          className="w-full rounded border border-edge bg-field px-2 py-1.5 font-mono"
          value={settings.gameWindowTitle}
          onChange={(e) => setSettings({ ...settings, gameWindowTitle: e.target.value })}
        />
        <p className="mt-1 text-xs text-fg-faint">
          Must match the game window&apos;s title exactly, including case. Check with PowerShell:
          <br />
          <code>Get-Process | ? MainWindowTitle -ne &apos;&apos; | select MainWindowTitle</code>
        </p>
      </div>

      <div>
        <label className="mb-1 block text-fg-muted">Toggle hotkey</label>
        <input
          className="w-full rounded border border-edge bg-field px-2 py-1.5 font-mono"
          value={settings.toggleHotkey}
          onChange={(e) => setSettings({ ...settings, toggleHotkey: e.target.value })}
        />
        <p className="mt-1 text-xs text-fg-faint">Electron accelerator format, e.g. Alt+Shift+R</p>
      </div>

      <div>
        <label className="mb-1 block text-fg-muted">
          Textile animation speed: <span className="font-mono">{settings.textileAnimMs}ms</span>
          /frame
        </label>
        <input
          type="range"
          min={50}
          max={1000}
          step={10}
          className="w-full"
          value={settings.textileAnimMs}
          onChange={(e) => setSettings({ ...settings, textileAnimMs: Number(e.target.value) })}
        />
        <p className="mt-1 text-xs text-fg-faint">
          Milliseconds per frame for animated cloth (textile) dyes. Higher = slower. Applies on
          Save.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-fg-muted">
          Cloth scroll speed:{' '}
          <span className="font-mono">{settings.textileScrollSpeed.toFixed(1)}</span>
        </label>
        <input
          type="range"
          min={0.1}
          max={8}
          step={0.1}
          className="w-full"
          value={settings.textileScrollSpeed}
          onChange={(e) => setSettings({ ...settings, textileScrollSpeed: Number(e.target.value) })}
        />
        <p className="mt-1 text-xs text-fg-faint">
          How fast scrolling cloths (horizontal/vertical) move. Higher = faster. Applies on Save.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-fg-muted">
          Cloth rotate speed:{' '}
          <span className="font-mono">{settings.textileRotateSpeed.toFixed(2)}</span>
        </label>
        <input
          type="range"
          min={0.01}
          max={1}
          step={0.01}
          className="w-full"
          value={settings.textileRotateSpeed}
          onChange={(e) => setSettings({ ...settings, textileRotateSpeed: Number(e.target.value) })}
        />
        <p className="mt-1 text-xs text-fg-faint">
          How fast rotating (vortex) cloths spin. Higher = faster. Applies on Save.
        </p>
      </div>

      <div className="mt-auto flex items-center gap-3">
        <Button variant="primary" size="md" onClick={save}>
          Save
        </Button>
        {needsRestart && (
          <Button variant="warn" size="md" onClick={() => window.overlay.relaunch()}>
            Restart now to apply
          </Button>
        )}
        <span className="text-xs text-fg-faint">{status}</span>
      </div>
    </div>
  )
}

export default ConfigWindow
