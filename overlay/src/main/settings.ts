import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type OverlaySettings } from '../shared/settings'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): OverlaySettings {
  const path = settingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, 'utf-8')) }
  } catch (err) {
    console.error('[settings] failed to read settings.json, using defaults:', err)
    return { ...DEFAULT_SETTINGS }
  }
}

export function persistSettings(settings: OverlaySettings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}
