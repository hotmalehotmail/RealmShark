import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { SpriteContext } from './context'

/** Crop an atlas region into an ImageData, for pixel-level dye compositing. */
function regionImageData(
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
): ImageData | null {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

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
  // TEMP dye diagnostic: dedup the [dye] decision log per base+dye combo.
  const dyeDiagRef = useRef<Set<string>>(new Set())
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

  // Render a character sprite with clothing/accessory dyes composited in. Dyes
  // arrive as objectTypes (Tex1/Tex2); their sprites are in the pack, so we crop
  // the base sprite + its mask + each dye's sprite and tile the dye pixels into
  // the masked clothing/accessory regions. Shared by every panel (via <Sprite>
  // dye props or <CharacterSprite>). Falls back to the plain sprite when there's
  // no dye or no mask.
  const getDyedSprite = useCallback(
    (
      baseType: number,
      size: number,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): string | null => {
      const hasClothing = clothingDye != null && clothingDye > 0
      const hasAccessory = accessoryDye != null && accessoryDye > 0
      const baseRect = pack.table?.[String(baseType)]
      const maskRect = pack.maskTable?.[String(baseType)]

      // TEMP dye diagnostic (deduped): surfaces why a dye did/didn't composite.
      if (hasClothing || hasAccessory) {
        const dk = `${baseType}:${clothingDye ?? 0}:${accessoryDye ?? 0}`
        if (!dyeDiagRef.current.has(dk)) {
          dyeDiagRef.current.add(dk)
          console.log(
            `[dye] base=${baseType} ready=${pack.ready} baseInTable=${!!baseRect} ` +
              `maskInTable=${!!maskRect} ` +
              `clothing=${clothingDye ?? 0}(inTable=${!!(clothingDye && pack.table?.[String(clothingDye)])}) ` +
              `accessory=${accessoryDye ?? 0}(inTable=${!!(accessoryDye && pack.table?.[String(accessoryDye)])})`
          )
        }
      }

      if (!pack.ready || !pack.table || (!hasClothing && !hasAccessory)) {
        return getSprite(baseType, size)
      }
      if (!baseRect || !maskRect) return getSprite(baseType, size)

      const key = `dye:${baseType}:${size}:${hasClothing ? clothingDye : 0}:${
        hasAccessory ? accessoryDye : 0
      }`
      const cached = cacheRef.current.get(key)
      if (cached) return cached

      const baseImg = atlasesRef.current[String(baseRect[0])]
      const maskImg = atlasesRef.current[String(maskRect[0])]
      if (!baseImg || !maskImg) return null // atlases not decoded yet

      const [, bx, by, w, h] = baseRect
      const [, mx, my, mw, mh] = maskRect
      const base = regionImageData(baseImg, bx, by, w, h)
      const mask = regionImageData(maskImg, mx, my, Math.min(mw, w), Math.min(mh, h))
      if (!base || !mask) return null

      // Each dye is just an objectType in the pack; grab its swatch/pattern pixels.
      const dyeRegion = (dyeId: number): { pixels: ImageData; w: number; h: number } | null => {
        const r = pack.table?.[String(dyeId)]
        if (!r) return null
        const img = atlasesRef.current[String(r[0])]
        if (!img) return null
        const d = regionImageData(img, r[1], r[2], r[3], r[4])
        return d ? { pixels: d, w: r[3], h: r[4] } : null
      }
      const clothing = hasClothing ? dyeRegion(clothingDye as number) : null
      const accessory = hasAccessory ? dyeRegion(accessoryDye as number) : null

      const out = new ImageData(w, h)
      const mStride = mask.width
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4
          const baseA = base.data[i + 3]
          // Mask channels: red = clothing region, green = accessory region.
          // (Flash-client convention; verify against a live dyed character and
          // swap the r/g test here if it's inverted.)
          const mi = (py * mStride + px) * 4
          const mr = mask.data[mi]
          const mg = mask.data[mi + 1]
          let src: { pixels: ImageData; w: number; h: number } | null = null
          if (baseA > 0) {
            if (clothing && mr >= 128 && mr >= mg) src = clothing
            else if (accessory && mg >= 128) src = accessory
          }
          if (src) {
            const si = ((py % src.h) * src.w + (px % src.w)) * 4
            out.data[i] = src.pixels.data[si]
            out.data[i + 1] = src.pixels.data[si + 1]
            out.data[i + 2] = src.pixels.data[si + 2]
            out.data[i + 3] = baseA // keep the character silhouette's alpha
          } else {
            out.data[i] = base.data[i]
            out.data[i + 1] = base.data[i + 1]
            out.data[i + 2] = base.data[i + 2]
            out.data[i + 3] = baseA
          }
        }
      }

      const composed = document.createElement('canvas')
      composed.width = w
      composed.height = h
      const cctx = composed.getContext('2d')
      if (!cctx) return null
      cctx.putImageData(out, 0, 0)

      const scaled = document.createElement('canvas')
      scaled.width = size
      scaled.height = size
      const sctx = scaled.getContext('2d')
      if (!sctx) return null
      sctx.imageSmoothingEnabled = false
      sctx.drawImage(composed, 0, 0, w, h, 0, 0, size, size)
      const url = scaled.toDataURL()
      cacheRef.current.set(key, url)
      return url
    },
    [pack, getSprite]
  )

  const hasMask = useCallback(
    (objectType: number): boolean => !!pack.maskTable?.[String(objectType)],
    [pack]
  )

  return (
    <SpriteContext.Provider
      value={{ ready: pack.ready, getSprite, describeSprite, getDyedSprite, hasMask }}
    >
      {children}
    </SpriteContext.Provider>
  )
}
