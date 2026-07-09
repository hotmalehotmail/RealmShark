import { useEffect, useState } from 'react'
import type { OverlaySettings } from '../../shared/settings'

function ConfigWindow(): React.JSX.Element {
  const [settings, setSettings] = useState<OverlaySettings | null>(null)
  const [status, setStatus] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)

  useEffect(() => {
    window.overlay.getSettings().then(setSettings)
  }, [])

  if (!settings) {
    return <div className="p-4 text-sm text-white">Loading…</div>
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
    <div className="flex h-screen flex-col gap-4 bg-neutral-900 p-5 text-sm text-white">
      <div>
        <label className="mb-1 block text-white/70">Game window title</label>
        <input
          className="w-full rounded border border-white/20 bg-neutral-800 px-2 py-1.5 font-mono"
          value={settings.gameWindowTitle}
          onChange={(e) => setSettings({ ...settings, gameWindowTitle: e.target.value })}
        />
        <p className="mt-1 text-xs text-white/40">
          Must match the game window&apos;s title exactly, including case. Check with PowerShell:
          <br />
          <code>Get-Process | ? MainWindowTitle -ne &apos;&apos; | select MainWindowTitle</code>
        </p>
      </div>

      <div>
        <label className="mb-1 block text-white/70">Toggle hotkey</label>
        <input
          className="w-full rounded border border-white/20 bg-neutral-800 px-2 py-1.5 font-mono"
          value={settings.toggleHotkey}
          onChange={(e) => setSettings({ ...settings, toggleHotkey: e.target.value })}
        />
        <p className="mt-1 text-xs text-white/40">Electron accelerator format, e.g. Alt+Shift+R</p>
      </div>

      <div>
        <label className="mb-1 block text-white/70">
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
        <p className="mt-1 text-xs text-white/40">
          Milliseconds per frame for animated cloth (textile) dyes. Higher = slower. Applies on
          Save.
        </p>
      </div>

      <div className="mt-auto flex items-center gap-3">
        <button
          className="rounded bg-sky-600 px-3 py-1.5 font-medium hover:bg-sky-500"
          onClick={save}
        >
          Save
        </button>
        {needsRestart && (
          <button
            className="rounded bg-amber-600 px-3 py-1.5 font-medium hover:bg-amber-500"
            onClick={() => window.overlay.relaunch()}
          >
            Restart now to apply
          </button>
        )}
        <span className="text-xs text-white/50">{status}</span>
      </div>
    </div>
  )
}

export default ConfigWindow
