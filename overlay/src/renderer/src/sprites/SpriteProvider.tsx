import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { SpriteContext } from './context'

// A textile (cloth) dye's woven pattern renders finer than the low-res body
// sprite - its weave is smaller than a body pixel. So for textile dyes we
// subdivide each body pixel this many times and tile the pattern in that finer
// space (the body / region outline stays blocky). 5 matches the in-game weave.
const TEXTILE_SUB = 5

// animTable stores this many ints per animation frame:
// [x, y, w, h, spriteAtlasId, maskX, maskY, maskW, maskH].
const FRAME_STRIDE = 9

// Animated-cloth motion, driven by a dye's <AnimatedDye type speed …> (see
// animDyeTable). `type` picks the motion; the sign of `speed` its direction:
//   type 1 = horizontal scroll (+ = left,  - = right)
//   type 2 = vertical scroll   (+ = down,  - = up)
//   type 3 = rotate            (+ = counter-clockwise)
// The dye's `speed` is scaled into output pattern-pixels/sec (scroll) and
// radians/sec (rotate) by the `textileScrollSpeed` / `textileRotateSpeed`
// settings (live-tunable, no rebuild). The motion is continuous, so
// animated-cloth sprites tick at DYE_ANIM_MS (not the coarser frame rate), and
// the rotation angle is quantized to ROT_STEPS to bound the per-sprite cache.
const ROT_STEPS = 60
export const DYE_ANIM_MS = 50

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
  // Animation frame duration (Settings). Each animated <Sprite> ticks itself at
  // this rate; getSprite/getDyedSprite read the current frame from the clock.
  const [frameMs, setFrameMs] = useState(DEFAULT_SETTINGS.textileAnimMs)
  // Live-tunable rates for continuous cloth scroll (px/sec) and rotate (rad/sec)
  // per unit of the dye's own speed - so the in-game feel can be dialed in
  // without a rebuild.
  const [scrollSpeed, setScrollSpeed] = useState(DEFAULT_SETTINGS.textileScrollSpeed)
  const [rotateSpeed, setRotateSpeed] = useState(DEFAULT_SETTINGS.textileRotateSpeed)

  useEffect(() => {
    const apply = (s: typeof DEFAULT_SETTINGS): void => {
      setFrameMs(s.textileAnimMs)
      setScrollSpeed(s.textileScrollSpeed)
      setRotateSpeed(s.textileRotateSpeed)
    }
    window.overlay.getSettings().then(apply)
    const off = window.overlay.onSettingsChanged(apply)
    return () => {
      off()
    }
  }, [])

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

  // ---- Animation frame helpers (base character sprites) --------------------
  // A base objectType's frames live in animTable (9 ints/frame); static sprites
  // fall back to table/maskTable as a single frame.
  const baseFrameCount = useCallback(
    (objectType: number): number => {
      const a = pack.animTable?.[String(objectType)]
      return a ? Math.floor(a.length / FRAME_STRIDE) : 1
    },
    [pack]
  )
  const baseFrame = useCallback(
    (objectType: number, now: number): number => {
      const c = baseFrameCount(objectType)
      return c > 1 ? Math.floor(now / Math.max(50, frameMs)) % c : 0
    },
    [baseFrameCount, frameMs]
  )
  /** [atlasId, x, y, w, h] for a base objectType's frame, or null. */
  const baseSpriteRect = useCallback(
    (objectType: number, frame: number): [number, number, number, number, number] | null => {
      const a = pack.animTable?.[String(objectType)]
      if (a) {
        const o = frame * FRAME_STRIDE
        return [a[o + 4], a[o], a[o + 1], a[o + 2], a[o + 3]]
      }
      const r = pack.table?.[String(objectType)]
      return r ? [r[0], r[1], r[2], r[3], r[4]] : null
    },
    [pack]
  )
  /** [maskAtlasId(3), x, y, w, h] for a base objectType's frame, or null when no mask. */
  const baseMaskRect = useCallback(
    (objectType: number, frame: number): [number, number, number, number, number] | null => {
      const a = pack.animTable?.[String(objectType)]
      if (a) {
        const o = frame * FRAME_STRIDE
        return a[o + 7] > 0 ? [3, a[o + 5], a[o + 6], a[o + 7], a[o + 8]] : null
      }
      const m = pack.maskTable?.[String(objectType)]
      return m ? [m[0], m[1], m[2], m[3], m[4]] : null
    },
    [pack]
  )

  // A clothing/accessory dye that carries an <AnimatedDye> (animDyeTable) scrolls
  // or rotates continuously - distinct from multi-frame textiles (which cycle
  // discrete frames). Used to pick the smooth DYE_ANIM_MS tick.
  const dyeAnimated = useCallback(
    (clothingDye?: number | null, accessoryDye?: number | null): boolean => {
      const has = (id?: number | null): boolean =>
        !!id && !!pack.animDyeTable?.[String(id)] && pack.dyeTable?.[String(id)]?.[0] === 10
      return has(clothingDye) || has(accessoryDye)
    },
    [pack]
  )

  const isAnimated = useCallback(
    (
      objectType: number | null | undefined,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): boolean => {
      if (
        objectType != null &&
        (pack.animTable?.[String(objectType)]?.length ?? 0) > FRAME_STRIDE
      ) {
        return true
      }
      const textileAnim = (id?: number | null): boolean => {
        const e = id ? pack.dyeTable?.[String(id)] : undefined
        return !!e && e[0] === 10 && (e.length - 2) / 4 > 1
      }
      return (
        textileAnim(clothingDye) ||
        textileAnim(accessoryDye) ||
        dyeAnimated(clothingDye, accessoryDye)
      )
    },
    [pack, dyeAnimated]
  )

  const getSprite = useCallback(
    (objectType: number, size: number): string | null => {
      if (!pack.ready || !pack.table) return null
      const now = Date.now()
      const frame = baseFrame(objectType, now)
      const rect = baseSpriteRect(objectType, frame)
      if (!rect) return null
      const key = `${objectType}:${size}:${frame}`
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
    [pack, baseFrame, baseSpriteRect]
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

      if (!pack.ready || !pack.table || (!clothingEntry && !accessoryEntry)) {
        return getSprite(baseType, size)
      }

      // The base character sprite may itself be an animated idle; grab its
      // current frame's sprite + mask rects (both change together per frame so
      // the dye region tracks the animation).
      const now = Date.now()
      const bFrame = baseFrame(baseType, now)
      const baseRect = baseSpriteRect(baseType, bFrame)
      const maskRect = baseMaskRect(baseType, bFrame)
      if (!baseRect || !maskRect) return getSprite(baseType, size)

      // For a textile entry, the frame count is (len-2)/4; the current frame is
      // driven by the animation clock. Solids (or single-frame textiles) => 0.
      const frameOf = (e: number[] | undefined): number => {
        if (!e || e[0] !== 10) return 0
        const count = (e.length - 2) / 4
        return count > 1 ? Math.floor(now / Math.max(50, frameMs)) % count : 0
      }
      const clothingFrame = frameOf(clothingEntry)
      const accessoryFrame = frameOf(accessoryEntry)

      // Continuous scroll/rotate for a dye with an <AnimatedDye> (animDyeTable).
      // The motion is time-driven; we quantize it (scroll offset mod the pattern
      // size, rotation to ROT_STEPS) so the frame cache stays bounded.
      type TileAnim =
        | { mode: 'scroll'; ox: number; oy: number }
        | { mode: 'rotate'; angle: number; pivotX: number; pivotY: number }
      const animFor = (id: number | null | undefined, e: number[] | undefined): TileAnim | null => {
        if (!e || e[0] !== 10 || !id) return null
        const a = pack.animDyeTable?.[String(id)]
        if (!a) return null
        const [type, speed, pivotX = 0, pivotY = 0] = a
        const pw = e[4] || 1
        const ph = e[5] || 1
        const t = now / 1000
        const wrap = (v: number, m: number): number => ((Math.floor(v) % m) + m) % m
        if (type === 1 || type === 2) {
          const disp = speed * scrollSpeed * t
          // +x sample offset scrolls the pattern left; -y offset scrolls it down.
          return type === 1
            ? { mode: 'scroll', ox: wrap(disp, pw), oy: 0 }
            : { mode: 'scroll', ox: 0, oy: wrap(-disp, ph) }
        }
        if (type === 3) {
          const step =
            ((Math.round((speed * rotateSpeed * t * ROT_STEPS) / (2 * Math.PI)) % ROT_STEPS) +
              ROT_STEPS) %
            ROT_STEPS
          return { mode: 'rotate', angle: (step / ROT_STEPS) * 2 * Math.PI, pivotX, pivotY }
        }
        return null
      }
      const clothingAnim = animFor(clothingDye, clothingEntry)
      const accessoryAnim = animFor(accessoryDye, accessoryEntry)
      const animKey = (a: TileAnim | null): string =>
        !a ? '' : a.mode === 'scroll' ? `s${a.ox},${a.oy}` : `r${a.angle.toFixed(3)}`

      const key = `dye:${baseType}:${size}:${clothingEntry ? clothingDye : 0}:${
        accessoryEntry ? accessoryDye : 0
      }:${bFrame}:${clothingFrame}:${accessoryFrame}:${animKey(clothingAnim)}:${animKey(
        accessoryAnim
      )}`
      const cached = cacheRef.current.get(key)
      if (cached) return cached

      // A resolved dye is either a solid RGB or a tileable textile pattern (the
      // current frame cropped from its atlas rect). Both get mask-shaded below.
      type DyeSrc =
        | { kind: 'solid'; rgb: [number, number, number] }
        | { kind: 'textile'; pixels: ImageData; pw: number; ph: number; anim: TileAnim | null }
      const resolveDye = (
        e: number[] | undefined,
        frame: number,
        anim: TileAnim | null
      ): DyeSrc | null => {
        if (!e) return null
        if (e[0] === 1) return { kind: 'solid', rgb: [e[1], e[2], e[3]] }
        if (e[0] === 10) {
          const atlasId = e[1]
          const o = 2 + frame * 4
          const img = atlasesRef.current[String(atlasId)]
          if (!img) return null // atlas not decoded yet
          const d = regionImageData(img, e[o], e[o + 1], e[o + 2], e[o + 3])
          return d ? { kind: 'textile', pixels: d, pw: e[o + 2], ph: e[o + 3], anim } : null
        }
        return null
      }
      const clothing = resolveDye(clothingEntry, clothingFrame, clothingAnim)
      const accessory = resolveDye(accessoryEntry, accessoryFrame, accessoryAnim)
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
              // Animated cloths offset (scroll) or rotate the sample coords first;
              // both wrap into the pattern tile so it stays seamless.
              let sx = px
              let sy = py
              if (src.anim) {
                if (src.anim.mode === 'scroll') {
                  sx = px + src.anim.ox
                  sy = py + src.anim.oy
                } else {
                  // Rotate within the tile (about its center + pivot) so the spin
                  // stays seamless across the tiling. +angle = counter-clockwise
                  // on screen: since y is down, that's the screen-CW matrix.
                  const lx = ((px % src.pw) + src.pw) % src.pw
                  const ly = ((py % src.ph) + src.ph) % src.ph
                  const cx = src.pw / 2 + src.anim.pivotX
                  const cy = src.ph / 2 + src.anim.pivotY
                  const dx = lx - cx
                  const dy = ly - cy
                  const cos = Math.cos(src.anim.angle)
                  const sin = Math.sin(src.anim.angle)
                  sx = cx + dx * cos - dy * sin
                  sy = cy + dx * sin + dy * cos
                }
              }
              const txp = ((Math.floor(sx) % src.pw) + src.pw) % src.pw
              const typ = ((Math.floor(sy) % src.ph) + src.ph) % src.ph
              const j = (typ * src.pw + txp) * 4
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
    [pack, getSprite, frameMs, scrollSpeed, rotateSpeed, baseFrame, baseSpriteRect, baseMaskRect]
  )

  return (
    <SpriteContext.Provider
      value={{ ready: pack.ready, getSprite, getDyedSprite, isAnimated, dyeAnimated, frameMs }}
    >
      {children}
    </SpriteContext.Provider>
  )
}
