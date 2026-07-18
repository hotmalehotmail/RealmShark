import { describe, expect, it, vi } from 'vitest'
import type { SpritePack } from '../src/shared/ipc'

// spritePack.ts imports electron's `app` (only for its on-disk cache dir). Mock
// it with a throwaway temp dir so the module loads under vitest's node env; the
// disk cache is incidental to what these tests assert (in-memory forwarding).
vi.mock('electron', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path')
  const dir = mkdtempSync(join(tmpdir(), 'spritepack-test-'))
  return { app: { getPath: () => dir } }
})

// Imported after the mock so its top-level `import { app } from 'electron'`
// resolves to the stub above.
import {
  getSpritePack,
  initSpritePack,
  onSpritePackMessage,
  requestSpritePack
} from '../src/main/spritePack'

const UI_SPRITES = {
  RarityIcon_1: 'data:image/png;base64,AAAA',
  shiny_item_icon: 'data:image/png;base64,BBBB'
}
const DUNGEON_ICONS = { 'The Shatters': 1234, 'Lost Halls': 5678 }

function fullPack(): SpritePack & { upToDate?: boolean } {
  return {
    ready: true,
    version: 'v1',
    atlases: { '1': 'data:,' },
    table: {},
    maskTable: {},
    dyeTable: {},
    animTable: {},
    animDyeTable: {},
    dungeonIcons: DUNGEON_ICONS,
    uiSprites: UI_SPRITES
  }
}

function captureRequest(): { type: string; haveVersion: string | null } {
  let sent: { type: string; haveVersion: string | null } | undefined
  requestSpritePack((m) => {
    sent = m as { type: string; haveVersion: string | null }
  })
  if (!sent) throw new Error('requestSpritePack sent nothing')
  return sent
}

describe('main-process sprite-pack forwarding (issue #206 regression)', () => {
  it('forwards uiSprites from the bridge message to the cached pack and the renderer', () => {
    const seen: SpritePack[] = []
    initSpritePack((p) => seen.push(p))

    onSpritePackMessage(fullPack())

    // Regression: onSpritePackMessage reconstructs the pack from a hand-kept
    // field list that used to omit uiSprites, so the renderer's getUiSprite()
    // always saw undefined and drew the CSS ring / SVG-star fallback.
    expect(getSpritePack().uiSprites).toEqual(UI_SPRITES)
    expect(seen.at(-1)?.uiSprites).toEqual(UI_SPRITES)
    // dungeonIcons was dropped by the same field list — guard it too so the
    // list can't silently regress another already-shipped section.
    expect(getSpritePack().dungeonIcons).toEqual(DUNGEON_ICONS)
    expect(seen.at(-1)?.dungeonIcons).toEqual(DUNGEON_ICONS)
  })

  it('claims its version once a full pack (with uiSprites) is cached', () => {
    initSpritePack(() => {})
    onSpritePackMessage(fullPack())
    expect(captureRequest().haveVersion).toBe('v1')
  })

  it('treats a cached pack lacking uiSprites as stale, forcing a full refetch', () => {
    // A pre-fix cache: every other section present, uiSprites absent. It must
    // not claim its version, or the bridge answers upToDate and the renderer
    // never receives the pips.
    initSpritePack(() => {})
    onSpritePackMessage({ ...fullPack(), uiSprites: undefined })
    expect(captureRequest().haveVersion).toBeNull()
  })
})
