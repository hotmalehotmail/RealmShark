import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpritePack } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { SpriteContext } from './context'
import {
  bakeDyedSprite,
  regionImageData,
  TEXTILE_SUB,
  type DyeBake,
  type DyeMotion,
  type DyeRoleInput
} from './dyeBake'
import { LruCache } from './lruCache'
import { outlineAtDisplaySize } from './outline'

// animTable stores this many ints per animation frame:
// [x, y, w, h, spriteAtlasId, maskX, maskY, maskW, maskH].
const FRAME_STRIDE = 9

// Cache caps. The crop/dye caches key on a combinatorial space (objectType ×
// size × dye × enchant × animation frame), so an unbounded Map grew monotonically
// with every distinct player loadout seen - the renderer heap's dominant leak
// over a long session. LRU eviction bounds them; the working set of on-screen +
// retained-history sprites sits well under these caps, so eviction only reclaims
// loadouts that have left view. Bakes hold ImageData (far heavier per entry than a
// data-URL string) and are rarer (animated-textile dyes only), hence the tighter cap.
const CROP_CACHE_MAX = 2048
const BAKE_CACHE_MAX = 256

// Animated-cloth motion, driven by a dye's <AnimatedDye type speed …> (see
// animDyeTable). `type` picks the motion; the sign of `speed` its direction:
//   type 1 = horizontal scroll (+ = left,  - = right)
//   type 2 = vertical scroll   (+ = down,  - = up)
//   type 3 = rotate            (+ = counter-clockwise)
// The dye's `speed` is scaled into output pattern-pixels/sec (scroll) and
// radians/sec (rotate) by the `textileScrollSpeed` / `textileRotateSpeed`
// settings (live-tunable, no rebuild). This motion renders continuously (no
// quantization) via the shared rAF clock - see dyeBake.ts / AnimatedDyeCanvas.tsx.

/**
 * App-level sprite service shared by every panel. Loads the sprite pack once
 * (from the main-process cache via IPC, plus pushed updates), decodes each
 * atlas image once, and crops sprites on demand into a shared memo cache. Any
 * panel uses <Sprite/> or useSprites() - no panel re-loads or re-decodes.
 */
export function SpriteProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [pack, setPack] = useState<SpritePack>({ ready: false })
  const atlasesRef = useRef<Record<string, ImageBitmap | HTMLImageElement>>({})
  const cacheRef = useRef<LruCache<string, string>>(new LruCache(CROP_CACHE_MAX))
  // Baked static composite + per-region motion masks for animated-textile
  // dyes, keyed on everything that affects the bake (NOT the continuous
  // scroll/rotate phase - that's applied live, per frame, by the renderer).
  const bakeCacheRef = useRef<LruCache<string, DyeBake>>(new LruCache(BAKE_CACHE_MAX))
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
    bakeCacheRef.current.clear()
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

  // The game closed (overlay detach): drop the crop/bake caches so a play
  // session's accumulated sprites don't stay resident until the next atlas
  // reload. Already-rendered data-URLs are self-contained strings, so clearing
  // the memo only forces re-derivation on next render (the overlay hides on
  // detach anyway); atlasesRef is asset data, kept for the next attach.
  useEffect(() => {
    const off = window.overlay.onOverlayDetach(() => {
      cacheRef.current.clear()
      bakeCacheRef.current.clear()
    })
    return () => {
      off()
    }
  }, [])

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
  // discrete frames via getDyedSprite). Used by <Sprite> to route to the
  // continuous rAF-driven canvas renderer (bakeAnimatedDye) instead.
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
      const cropped = regionImageData(img, x, y, w, h)
      if (!cropped) return null
      // Scale to display size first, then outline by exactly 1 pixel - see
      // outlineAtDisplaySize for why (outlining before the scale blows the
      // line up by the same factor as the sprite itself).
      const outlined = outlineAtDisplaySize(cropped, size)
      if (!outlined) return null
      const canvas = document.createElement('canvas')
      canvas.width = outlined.width
      canvas.height = outlined.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.putImageData(outlined, 0, 0)
      const url = canvas.toDataURL()
      cacheRef.current.set(key, url)
      return url
    },
    // `pack` re-derives getSprite; the setGen bump re-renders consumers once
    // atlases arrive so a previously-null sprite is retried.
    [pack, baseFrame, baseSpriteRect]
  )

  // For a textile dyeTable entry, the frame count is (len-2)/4; the current
  // frame is driven by the (coarse) animation clock. Solids (or single-frame
  // textiles, including animated-motion cloths - see docs/dyes-and-textiles.md
  // "Sprite animation") => always frame 0.
  const dyeFrameOf = useCallback(
    (e: number[] | undefined, now: number): number => {
      if (!e || e[0] !== 10) return 0
      const count = (e.length - 2) / 4
      return count > 1 ? Math.floor(now / Math.max(50, frameMs)) % count : 0
    },
    [frameMs]
  )

  // Render a character sprite with clothing/accessory dyes composited in. Dyes
  // arrive as objectTypes (Tex1/Tex2); the dye's real color lives in
  // pack.dyeTable (parsed from the dye object XML - the dye's own sprite is only
  // a generic icon). We recolor the mask's clothing (red) / accessory (green)
  // regions to the dye color, scaled by the mask value so the base sprite's
  // shading is preserved: the undyed sprite is itself referenceColor x
  // (maskValue/255), so dyeColor x (maskValue/255) reproduces the same shading.
  // Textile dyes are the same but the region is filled with the tiled cloth
  // pattern (cropped from its atlas rect) instead of a flat color; a
  // multi-frame textile cycles discrete frames over time. A dye with
  // *continuous* scroll/rotate motion (animDyeTable) never reaches this
  // function - <Sprite> routes it to bakeAnimatedDye/AnimatedDyeCanvas instead
  // (see dyeAnimated below). Falls back to the plain sprite when there's no
  // dye or no mask.
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

      const clothingFrame = dyeFrameOf(clothingEntry, now)
      const accessoryFrame = dyeFrameOf(accessoryEntry, now)

      const key = `dye:${baseType}:${size}:${clothingEntry ? clothingDye : 0}:${
        accessoryEntry ? accessoryDye : 0
      }:${bFrame}:${clothingFrame}:${accessoryFrame}`
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
              const txp = ((px % src.pw) + src.pw) % src.pw
              const typ = ((py % src.ph) + src.ph) % src.ph
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

      // Scale the dye composite to display size first, then outline by
      // exactly 1 pixel - see outlineAtDisplaySize (SpriteProvider.tsx's
      // getSprite does the same for undyed sprites).
      const outlined = outlineAtDisplaySize(out, size)
      if (!outlined) return null
      const canvas = document.createElement('canvas')
      canvas.width = outlined.width
      canvas.height = outlined.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.putImageData(outlined, 0, 0)
      const url = canvas.toDataURL()
      cacheRef.current.set(key, url)
      return url
    },
    [pack, getSprite, dyeFrameOf, baseFrame, baseSpriteRect, baseMaskRect]
  )

  const dyeRoleInput = useCallback(
    (id: number | null | undefined, entry: number[] | undefined, frame: number): DyeRoleInput => {
      if (!entry) return null
      if (entry[0] === 1) return { kind: 'solid', rgb: [entry[1], entry[2], entry[3]] }
      if (entry[0] === 10) {
        const atlasId = entry[1]
        const o = 2 + frame * 4
        const img = atlasesRef.current[String(atlasId)]
        if (!img) return null // atlas not decoded yet
        const raw = id ? pack.animDyeTable?.[String(id)] : undefined
        const motion: DyeMotion | null = raw
          ? { type: raw[0], speed: raw[1], pivotX: raw[2] ?? 0, pivotY: raw[3] ?? 0 }
          : null
        return {
          kind: 'textile',
          img,
          x: entry[o],
          y: entry[o + 1],
          pw: entry[o + 2],
          ph: entry[o + 3],
          motion
        }
      }
      return null
    },
    [pack]
  )

  // Bake the static composite + per-region motion masks for a dyeAnimated
  // sprite once per (baseType, size, dyes, discrete frame) combination - the
  // continuous scroll/rotate phase is NOT part of the key, it's applied live
  // by the renderer every animation frame (see dyeBake.ts).
  const bakeAnimatedDye = useCallback(
    (
      baseType: number,
      size: number,
      clothingDye?: number | null,
      accessoryDye?: number | null
    ): DyeBake | null => {
      const clothingEntry =
        clothingDye != null && clothingDye > 0 ? pack.dyeTable?.[String(clothingDye)] : undefined
      const accessoryEntry =
        accessoryDye != null && accessoryDye > 0 ? pack.dyeTable?.[String(accessoryDye)] : undefined
      if (!pack.ready || !pack.table || (!clothingEntry && !accessoryEntry)) return null

      const now = Date.now()
      const bFrame = baseFrame(baseType, now)
      const baseRect = baseSpriteRect(baseType, bFrame)
      const maskRect = baseMaskRect(baseType, bFrame)
      if (!baseRect || !maskRect) return null

      const clothingFrame = dyeFrameOf(clothingEntry, now)
      const accessoryFrame = dyeFrameOf(accessoryEntry, now)

      const key = `bake:${baseType}:${size}:${clothingEntry ? clothingDye : 0}:${
        accessoryEntry ? accessoryDye : 0
      }:${bFrame}:${clothingFrame}:${accessoryFrame}`
      const cached = bakeCacheRef.current.get(key)
      if (cached) return cached

      const clothing = dyeRoleInput(clothingDye, clothingEntry, clothingFrame)
      const accessory = dyeRoleInput(accessoryDye, accessoryEntry, accessoryFrame)
      if (clothingEntry?.[0] === 10 && !clothing) return null // atlas not decoded yet
      if (accessoryEntry?.[0] === 10 && !accessory) return null

      const baseImg = atlasesRef.current[String(baseRect[0])]
      const maskImg = atlasesRef.current[String(maskRect[0])]
      if (!baseImg || !maskImg) return null // atlases not decoded yet

      const bake = bakeDyedSprite({
        baseImg,
        baseRect: [baseRect[1], baseRect[2], baseRect[3], baseRect[4]],
        maskImg,
        maskRect: [maskRect[1], maskRect[2], maskRect[3], maskRect[4]],
        clothing,
        accessory
      })
      if (!bake) return null
      bakeCacheRef.current.set(key, bake)
      return bake
    },
    [pack, baseFrame, baseSpriteRect, baseMaskRect, dyeFrameOf, dyeRoleInput]
  )

  const dungeonIcon = useCallback(
    (name: string | null | undefined): number | null =>
      name ? (pack.dungeonIcons?.[name] ?? null) : null,
    [pack]
  )

  return (
    <SpriteContext.Provider
      value={{
        ready: pack.ready,
        getSprite,
        getDyedSprite,
        isAnimated,
        dyeAnimated,
        bakeAnimatedDye,
        frameMs,
        scrollSpeed,
        rotateSpeed,
        dungeonIcon
      }}
    >
      {children}
    </SpriteContext.Provider>
  )
}
