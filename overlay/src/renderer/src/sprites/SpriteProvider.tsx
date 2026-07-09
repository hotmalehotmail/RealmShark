import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { SpriteContext } from './context'

/** Crop an atlas region into an ImageData, for pixel-level dye compositing. */
function regionImageData(
  img: ImageBitmap | HTMLImageElement,
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
  const atlasesRef = useRef<Record<string, ImageBitmap | HTMLImageElement>>({})
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
        // Decode with color-management and alpha-premultiplication disabled so
        // sampled pixels are the atlas's raw RGBA - matching the in-game colors
        // exactly. `new Image()` decode applies ICC/gamma conversion and premul
        // rounding, which shifts colors and makes identical pixels diverge.
        void (async (): Promise<void> => {
          try {
            const blob = await (await fetch(url)).blob()
            atlasesRef.current[atlasId] = await createImageBitmap(blob, {
              colorSpaceConversion: 'none',
              premultiplyAlpha: 'none'
            })
          } catch {
            // Fallback to plain Image decode if createImageBitmap is unavailable.
            const img = new Image()
            await new Promise<void>((res) => {
              img.onload = (): void => res()
              img.src = url
            })
            atlasesRef.current[atlasId] = img
          }
          setGen((g) => g + 1)
        })()
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
  // arrive as objectTypes (Tex1/Tex2); the dye's real color lives in
  // pack.dyeTable (parsed from the dye object XML - the dye's own sprite is only
  // a generic icon). We recolor the mask's clothing (red) / accessory (green)
  // regions to the dye color, scaled by the mask value so the base sprite's
  // shading is preserved: the undyed sprite is itself referenceColor x
  // (maskValue/255), so dyeColor x (maskValue/255) reproduces the same shading.
  // Falls back to the plain sprite when there's no solid dye or no mask (textile
  // dyes - encoding [10, idx] - have no pattern shipped yet, so render undyed).
  const getDyedSprite = useCallback(
    (
      baseType: number,
      size: number,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): string | null => {
      const dyeColor = (dyeId?: number | null): [number, number, number] | null => {
        if (dyeId == null || dyeId <= 0) return null
        const e = pack.dyeTable?.[String(dyeId)]
        if (!e || e[0] !== 1) return null // solid only; textile (10) not renderable yet
        return [e[1], e[2], e[3]]
      }
      const clothing = dyeColor(clothingDye)
      const accessory = dyeColor(accessoryDye)
      const baseRect = pack.table?.[String(baseType)]
      const maskRect = pack.maskTable?.[String(baseType)]

      // TEMP dye diagnostic (deduped): surfaces how each dye resolved.
      if ((clothingDye ?? 0) > 0 || (accessoryDye ?? 0) > 0) {
        const dk = `${baseType}:${clothingDye ?? 0}:${accessoryDye ?? 0}`
        if (!dyeDiagRef.current.has(dk)) {
          dyeDiagRef.current.add(dk)
          const desc = (id?: number | null): string => {
            const e = id ? pack.dyeTable?.[String(id)] : undefined
            if (!e) return `${id ?? 0}(none)`
            return e[0] === 1 ? `${id}(solid ${e[1]},${e[2]},${e[3]})` : `${id}(textile ${e[1]})`
          }
          console.log(
            `[dye] base=${baseType} maskInTable=${!!maskRect} ` +
              `clothing=${desc(clothingDye)} accessory=${desc(accessoryDye)}`
          )
        }
      }

      if (!pack.ready || !pack.table || (!clothing && !accessory)) {
        return getSprite(baseType, size)
      }
      if (!baseRect || !maskRect) return getSprite(baseType, size)

      const key = `dye:${baseType}:${size}:${clothing ? clothingDye : 0}:${
        accessory ? accessoryDye : 0
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

      const out = new ImageData(w, h)
      const mStride = mask.width
      const maskH = mask.height
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4
          const baseA = base.data[i + 3]
          // Mask channels: red = clothing region, green = accessory region; the
          // channel value is the shade level. Recolor to the dye, scaled by it.
          let color: [number, number, number] | null = null
          let shade = 0
          if (baseA > 0 && px < mStride && py < maskH) {
            const mi = (py * mStride + px) * 4
            const mr = mask.data[mi]
            const mg = mask.data[mi + 1]
            if (clothing && mr > 0 && mr >= mg) {
              color = clothing
              shade = mr / 255
            } else if (accessory && mg > 0) {
              color = accessory
              shade = mg / 255
            }
          }
          if (color) {
            out.data[i] = Math.round(color[0] * shade)
            out.data[i + 1] = Math.round(color[1] * shade)
            out.data[i + 2] = Math.round(color[2] * shade)
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
