import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { SpriteContext } from './context'

/**
 * App-level sprite service shared by every panel. Loads the sprite pack once
 * (from the main-process cache via IPC, plus pushed updates), decodes each
 * atlas image once, and crops sprites on demand into a shared memo cache. Any
 * panel uses <Sprite/> or useSprites() - no panel re-loads or re-decodes.
 */
export function SpriteProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [pack, setPack] = useState<SpritePack>({ ready: false })
  const atlasesRef = useRef<Record<string, HTMLImageElement>>({})
  const cacheRef = useRef<Map<string, string>>(new Map())
  // Bumped when an atlas finishes decoding so consumers re-request (a sprite
  // that returned null because its atlas wasn't loaded yet can now be cropped).
  const [, setGen] = useState(0)

  const applyPack = useCallback((p: SpritePack): void => {
    cacheRef.current.clear()
    atlasesRef.current = {}
    setPack(p)
    if (p.ready && p.atlases) {
      for (const [atlasId, url] of Object.entries(p.atlases)) {
        const img = new Image()
        img.onload = (): void => {
          atlasesRef.current[atlasId] = img
          setGen((g) => g + 1)
        }
        img.src = url
      }
    }
  }, [])

  useEffect(() => {
    window.overlay.getSpritePack().then(applyPack)
    const off = window.overlay.onSpritePack(applyPack)
    return () => {
      off()
    }
  }, [applyPack])

  const getSprite = useCallback(
    (objectType: number, size: number): string | null => {
      if (!pack.ready || !pack.table) return null
      const rect = pack.table[String(objectType)]
      if (!rect) return null
      const key = `${objectType}:${size}`
      const cached = cacheRef.current.get(key)
      if (cached) return cached
      const [atlasId, x, y, w, h] = rect
      const img = atlasesRef.current[String(atlasId)]
      if (!img) return null // atlas not decoded yet; a later setGen re-renders
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.imageSmoothingEnabled = false // preserve the pixel-art look when scaling
      ctx.drawImage(img, x, y, w, h, 0, 0, size, size)
      const url = canvas.toDataURL()
      cacheRef.current.set(key, url)
      return url
    },
    // `pack` re-derives getSprite; the setGen bump re-renders consumers once
    // atlases arrive so a previously-null sprite is retried.
    [pack]
  )

  // TEMP (dye-probe): report where an objectType resolves in the pack, so we can
  // tell whether dye sprites (their ids come over the wire as Tex1/Tex2) ship in
  // one of our atlases or need a separate sheet.
  const describeSprite = useCallback(
    (objectType: number): { inTable: boolean; atlasId: number | null; drawable: boolean } => {
      const rect = pack.table?.[String(objectType)]
      return {
        inTable: !!rect,
        atlasId: rect ? rect[0] : null,
        drawable: getSprite(objectType, 40) !== null
      }
    },
    [pack, getSprite]
  )

  return (
    <SpriteContext.Provider value={{ ready: pack.ready, getSprite, describeSprite }}>
      {children}
    </SpriteContext.Provider>
  )
}
