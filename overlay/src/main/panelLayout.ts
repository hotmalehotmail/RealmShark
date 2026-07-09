import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PanelInstance } from '../shared/panels'

function panelLayoutPath(): string {
  return join(app.getPath('userData'), 'panels.json')
}

/** Returns null if no layout has been saved yet - the renderer's panel registry owns the defaults. */
export function loadPanelLayout(): PanelInstance[] | null {
  const path = panelLayoutPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    console.error('[panel-layout] failed to read panels.json, ignoring:', err)
    return null
  }
}

export function persistPanelLayout(panels: PanelInstance[]): void {
  writeFileSync(panelLayoutPath(), JSON.stringify(panels, null, 2))
}
