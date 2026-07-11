import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SpritePack } from '../shared/ipc'

/**
 * Owns the overlay's copy of the sprite pack. The pack is fetched from the
 * bridge once per game version and cached to disk, so after the first fetch it
 * loads locally with no bridge round-trip. The renderer never talks to the
 * bridge for sprites - it reads this cache via IPC and gets pushed updates.
 */

const NOT_READY: SpritePack = { ready: false }

let current: SpritePack = NOT_READY
let notifyRenderer: ((pack: SpritePack) => void) | undefined

function cacheDir(): string {
  return join(app.getPath('userData'), 'spritePack')
}
function packFile(): string {
  return join(cacheDir(), 'pack.json')
}

function loadFromDisk(): void {
  try {
    if (existsSync(packFile())) {
      current = JSON.parse(readFileSync(packFile(), 'utf-8')) as SpritePack
    }
  } catch {
    current = NOT_READY
  }
}

function saveToDisk(pack: SpritePack): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(packFile(), JSON.stringify(pack))
  } catch (e) {
    console.error('[sprite-pack] failed to cache pack:', (e as Error).message)
  }
}

/** Load any cached pack from disk and register the renderer-notify callback. */
export function initSpritePack(notify: (pack: SpritePack) => void): void {
  notifyRenderer = notify
  loadFromDisk()
}

/**
 * Called when the bridge connection is (re)established. Requests the pack,
 * telling the bridge which version we already have so an unchanged version is a
 * cheap no-op instead of re-sending the whole (multi-MB) payload.
 */
export function requestSpritePack(send: (msg: unknown) => void): void {
  // Force a full refetch if the cached pack predates the dye/animation data
  // (maskTable / dyeTable / animTable / animDyeTable): such a cache matches on
  // version but lacks it, so treat it as stale by claiming no version.
  const haveVersion =
    current.maskTable && current.dyeTable && current.animTable && current.animDyeTable
      ? (current.version ?? null)
      : null
  send({ type: 'spritePackRequest', haveVersion })
}

/** Handles a `spritePack` message from the bridge. */
export function onSpritePackMessage(msg: SpritePack & { upToDate?: boolean }): void {
  if (!msg.ready) {
    // Bridge has no game assets. Keep any cache we already have; only downgrade
    // to not-ready if we had nothing to begin with.
    if (!current.ready) {
      current = NOT_READY
      notifyRenderer?.(current)
    }
    return
  }
  if (msg.upToDate) return // our cached copy is already current
  current = {
    ready: true,
    version: msg.version,
    atlases: msg.atlases,
    table: msg.table,
    maskTable: msg.maskTable,
    dyeTable: msg.dyeTable,
    animTable: msg.animTable,
    animDyeTable: msg.animDyeTable
  }
  saveToDisk(current)
  notifyRenderer?.(current)
}

export function getSpritePack(): SpritePack {
  return current
}
