import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
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
  // Textile animation frame duration (Settings). Bumping the tick re-renders
  // consumers so animated textiles advance a frame (see getDyedSprite).
  const [frameMs, setFrameMs] = useState(DEFAULT_SETTINGS.textileAnimMs)
  const [, setAnimTick] = useState(0)

  useEffect(() => {
    window.overlay.getSettings().then((s) => setFrameMs(s.textileAnimMs))
    const off = window.overlay.onSettingsChanged((s) => setFrameMs(s.textileAnimMs))
    return () => {
      off()
    }
  }, [])

  // Only run the animation clock if some dye is a multi-frame textile.
  const hasAnimatedTextile = useMemo(
    () =>
      !!pack.dyeTable &&
      Object.values(pack.dyeTable).some((e) => e[0] === 10 && (e.length - 2) / 4 > 1),
    [pack.dyeTable]
  )
  useEffect(() => {
    if (!hasAnimatedTextile) return
    const id = setInterval(() => setAnimTick((t) => t + 1), Math.max(50, frameMs))
    return () => clearInterval(id)
  }, [hasAnimatedTextile, frameMs])

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
  // pattern (cropped from its atlas rect) instead of a flat color; an animated
  // textile has several frames and cycles through them over time. Falls back to
  // the plain sprite when there's no dye or no mask.
  const getDyedSprite = useCallback(
    (
      baseType: number,
      size: number,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): string | null => {
      const clothingEntry =
        clothingDye != null && clothingDye > 0 ? pack.dyeTable?.[String(clothingDye)] : undefined
      const accessoryEntry =
        accessoryDye != null && accessoryDye > 0 ? pack.dyeTable?.[String(accessoryDye)] : undefined
      const baseRect = pack.table?.[String(baseType)]
      const maskRect = pack.maskTable?.[String(baseType)]

      if (!pack.ready || !pack.table || (!clothingEntry && !accessoryEntry)) {
        return getSprite(baseType, size)
      }
      if (!baseRect || !maskRect) return getSprite(baseType, size)

      // For a textile entry, the frame count is (len-2)/4; the current frame is
      // driven by the animation clock. Solids (or single-frame textiles) => 0.
      const frameOf = (e: number[] | undefined): number => {
        if (!e || e[0] !== 10) return 0
        const count = (e.length - 2) / 4
        return count > 1 ? Math.floor(Date.now() / Math.max(50, frameMs)) % count : 0
      }
      const clothingFrame = frameOf(clothingEntry)
      const accessoryFrame = frameOf(accessoryEntry)

      const key = `dye:${baseType}:${size}:${clothingEntry ? clothingDye : 0}:${
        accessoryEntry ? accessoryDye : 0
      }:${clothingFrame}:${accessoryFrame}`
      const cached = cacheRef.current.get(key)
      if (cached) return cached

      // A resolved dye is either a solid RGB or a tileable textile pattern (the
      // current frame cropped from its atlas rect). Both get mask-shaded below.
      type DyeSrc =
        | { kind: 'solid'; rgb: [number, number, number] }
        | { kind: 'textile'; pixels: ImageData; pw: number; ph: number }
      const resolveDye = (e: number[] | undefined, frame: number): DyeSrc | null => {
        if (!e) return null
        if (e[0] === 1) return { kind: 'solid', rgb: [e[1], e[2], e[3]] }
        if (e[0] === 10) {
          const atlasId = e[1]
          const o = 2 + frame * 4
          const img = atlasesRef.current[String(atlasId)]
          if (!img) return null // atlas not decoded yet
          const d = regionImageData(img, e[o], e[o + 1], e[o + 2], e[o + 3])
          return d ? { kind: 'textile', pixels: d, pw: e[o + 2], ph: e[o + 3] } : null
        }
        return null
      }
      const clothing = resolveDye(clothingEntry, clothingFrame)
      const accessory = resolveDye(accessoryEntry, accessoryFrame)
      if (!clothing && !accessory) return getSprite(baseType, size) // atlases not ready

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
    [pack, getSprite, frameMs]
  )

  return (
    <SpriteContext.Provider value={{ ready: pack.ready, getSprite, getDyedSprite }}>
      {children}
    </SpriteContext.Provider>
  )
}
