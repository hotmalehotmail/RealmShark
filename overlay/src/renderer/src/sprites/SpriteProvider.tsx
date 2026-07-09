import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { SpriteContext } from './context'

// A textile (cloth) dye's woven pattern renders finer than the low-res body
// sprite - its weave is smaller than a body pixel. So for textile dyes we
// subdivide each body pixel this many times and tile the pattern in that finer
// space (the body / region outline stays blocky). 5 matches the in-game weave.
const TEXTILE_SUB = 5

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

  // Render a character sprite with clothing/accessory dyes composited in. Dyes
  // arrive as objectTypes (Tex1/Tex2); the dye's real color lives in
  // pack.dyeTable (parsed from the dye object XML - the dye's own sprite is only
  // a generic icon). We recolor the mask's clothing (red) / accessory (green)
  // regions to the dye color, scaled by the mask value so the base sprite's
  // shading is preserved: the undyed sprite is itself referenceColor x
  // (maskValue/255), so dyeColor x (maskValue/255) reproduces the same shading.
  // Textile dyes are the same but the region is filled with the tiled cloth
  // pattern (cropped from its atlas rect) instead of a flat color. Falls back to
  // the plain sprite when there's no dye or no mask.
  const getDyedSprite = useCallback(
    (
      baseType: number,
      size: number,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): string | null => {
      // A resolved dye is either a solid RGB or a tileable textile pattern
      // (cropped from its atlas rect). Both get scaled by the mask shade below.
      type DyeSrc =
        | { kind: 'solid'; rgb: [number, number, number] }
        | { kind: 'textile'; pixels: ImageData; pw: number; ph: number }
      const resolveDye = (dyeId?: number | null): DyeSrc | null => {
        if (dyeId == null || dyeId <= 0) return null
        const e = pack.dyeTable?.[String(dyeId)]
        if (!e) return null
        if (e[0] === 1) return { kind: 'solid', rgb: [e[1], e[2], e[3]] }
        if (e[0] === 10) {
          const [, atlasId, x, y, pw, ph] = e
          const img = atlasesRef.current[String(atlasId)]
          if (!img) return null // atlas not decoded yet
          const d = regionImageData(img, x, y, pw, ph)
          return d ? { kind: 'textile', pixels: d, pw, ph } : null
        }
        return null
      }
      const clothing = resolveDye(clothingDye)
      const accessory = resolveDye(accessoryDye)
      const baseRect = pack.table?.[String(baseType)]
      const maskRect = pack.maskTable?.[String(baseType)]

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
      const mask = regionImageData(maskImg, mx, my, mw, mh)
      if (!base || !mask) return null

      // Textiles render their weave finer than a body pixel, so for textile dyes
      // we subdivide each body pixel (SUB) and tile the pattern in that finer
      // output space; the body / region outline stays blocky (base + mask are
      // sampled at their own low resolution). Solids are unaffected (SUB=1).
      const SUB = clothing?.kind === 'textile' || accessory?.kind === 'textile' ? TEXTILE_SUB : 1
      const ow = Math.max(w, mw) * SUB
      const oh = Math.max(h, mh) * SUB
      const out = new ImageData(ow, oh)
      for (let py = 0; py < oh; py++) {
        const byp = Math.min(h - 1, Math.floor((py * h) / oh))
        const myp = Math.min(mh - 1, Math.floor((py * mh) / oh))
        for (let px = 0; px < ow; px++) {
          const oi = (py * ow + px) * 4
          const bxp = Math.min(w - 1, Math.floor((px * w) / ow))
          const bi = (byp * w + bxp) * 4
          const baseA = base.data[bi + 3]
          // Mask channels: red = clothing region, green = accessory region; the
          // channel value is the shade level. Recolor to the dye, scaled by it.
          let src: DyeSrc | null = null
          let shade = 0
          if (baseA > 0) {
            const mxp = Math.min(mw - 1, Math.floor((px * mw) / ow))
            const mi = (myp * mw + mxp) * 4
            const mr = mask.data[mi]
            const mg = mask.data[mi + 1]
            if (clothing && mr > 0 && mr >= mg) {
              src = clothing
              shade = mr / 255
            } else if (accessory && mg > 0) {
              src = accessory
              shade = mg / 255
            }
          }
          let dyed = false
          if (src) {
            let r = 0
            let g = 0
            let b = 0
            let a = 255
            if (src.kind === 'solid') {
              ;[r, g, b] = src.rgb
            } else {
              // Tile the pattern across the region at the output (mask) scale.
              const j = ((py % src.ph) * src.pw + (px % src.pw)) * 4
              r = src.pixels.data[j]
              g = src.pixels.data[j + 1]
              b = src.pixels.data[j + 2]
              a = src.pixels.data[j + 3]
            }
            if (a > 0) {
              out.data[oi] = Math.round(r * shade)
              out.data[oi + 1] = Math.round(g * shade)
              out.data[oi + 2] = Math.round(b * shade)
              out.data[oi + 3] = baseA // keep the character silhouette's alpha
              dyed = true
            }
          }
          if (!dyed) {
            out.data[oi] = base.data[bi]
            out.data[oi + 1] = base.data[bi + 1]
            out.data[oi + 2] = base.data[bi + 2]
            out.data[oi + 3] = baseA
          }
        }
      }

      const composed = document.createElement('canvas')
      composed.width = ow
      composed.height = oh
      const cctx = composed.getContext('2d')
      if (!cctx) return null
      cctx.putImageData(out, 0, 0)

      const scaled = document.createElement('canvas')
      scaled.width = size
      scaled.height = size
      const sctx = scaled.getContext('2d')
      if (!sctx) return null
      sctx.imageSmoothingEnabled = false
      sctx.drawImage(composed, 0, 0, ow, oh, 0, 0, size, size)
      const url = scaled.toDataURL()
      cacheRef.current.set(key, url)
      return url
    },
    [pack, getSprite]
  )

  return (
    <SpriteContext.Provider value={{ ready: pack.ready, getSprite, getDyedSprite }}>
      {children}
    </SpriteContext.Provider>
  )
}
