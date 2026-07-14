/**
 * Continuous animated-textile-dye rendering: bake the static parts of a dyed
 * sprite (base silhouette, any solid/still-textile dye, and per-region
 * mask/shade for each *animated* textile) once, then recomposite each moving
 * layer every frame with plain canvas draws - a repeating `CanvasPattern`
 * translated/rotated by a fractional (sub-pixel) transform, masked into its
 * clothing/accessory region and shaded by the mask value via compositing
 * operators. No per-pixel JS loop and no `getImageData`/`toDataURL` on the
 * per-frame path; those only happen once, at bake time, in `bakeDyedSprite`.
 *
 * See `getDyedSprite` in SpriteProvider.tsx for the (unrelated, still
 * per-pixel) static-dye compositor this shares `regionImageData`/`TEXTILE_SUB`
 * with, and docs/dyes-and-textiles.md for the full mask/shade model.
 */

import { dilateSilhouette, imageDataToCanvas } from './outline'

// A textile (cloth) dye's woven pattern renders finer than the low-res body
// sprite - its weave is smaller than a body pixel. So for textile dyes we
// subdivide each body pixel this many times and tile the pattern in that finer
// space (the body / region outline stays blocky). 5 matches the in-game weave.
export const TEXTILE_SUB = 5

/** Crop an atlas region into an ImageData, for pixel-level dye compositing. */
export function regionImageData(
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

function cropToCanvas(
  img: ImageBitmap | HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
  }
  return c
}

/** A dye's `<AnimatedDye type speed pivotX pivotY/>` (see animDyeTable). */
export interface DyeMotion {
  /** 1 = horizontal scroll, 2 = vertical scroll, 3 = rotate. */
  type: number
  speed: number
  pivotX: number
  pivotY: number
}

/** A resolved clothing/accessory dye, ready to bake. */
export type DyeRoleInput =
  | { kind: 'solid'; rgb: [number, number, number] }
  | {
      kind: 'textile'
      img: ImageBitmap | HTMLImageElement
      x: number
      y: number
      pw: number
      ph: number
      /** Present only for a dye with an <AnimatedDye> element (continuous motion). */
      motion: DyeMotion | null
    }
  | null

export interface DyeLayerBake {
  role: 'clothing' | 'accessory'
  motion: DyeMotion
  /** The pattern tile, cropped at its native resolution (no scaling). */
  tile: HTMLCanvasElement
  pw: number
  ph: number
  /** Alpha-only boolean mask: opaque where this dye's region applies, else transparent. */
  regionSelector: HTMLCanvasElement
  /** Opaque grey = mask shade value at each pixel of this region. */
  regionShade: HTMLCanvasElement
}

export interface DyeBake {
  ow: number
  oh: number
  /** Base sprite with any static (non-animated) dye already composited in. */
  base: HTMLCanvasElement
  /** One entry per clothing/accessory dye that has continuous motion. */
  layers: DyeLayerBake[]
}

function samplePatternPixel(
  pixels: ImageData,
  pw: number,
  ph: number,
  px: number,
  py: number
): [number, number, number, number] {
  const tx = ((Math.floor(px) % pw) + pw) % pw
  const ty = ((Math.floor(py) % ph) + ph) % ph
  const j = (ty * pw + tx) * 4
  const d = pixels.data
  return [d[j], d[j + 1], d[j + 2], d[j + 3]]
}

/** Sample a *static* (non-animated) dye role at an output pixel - solid colour, or a still textile tile. */
function sampleStaticRole(
  role: Exclude<DyeRoleInput, null>,
  pixels: ImageData | null,
  px: number,
  py: number
): [number, number, number, number] | null {
  if (role.kind === 'solid') return [role.rgb[0], role.rgb[1], role.rgb[2], 255]
  if (!pixels) return null
  return samplePatternPixel(pixels, role.pw, role.ph, px, py)
}

/**
 * Bake the static parts of a dyed sprite once: the base silhouette with any
 * solid/still-textile dye already composited in, plus a region-selector +
 * shade mask (at output resolution) for every dye that has continuous motion.
 * Uses `getImageData`/`putImageData` freely - this only runs when the dye/size
 * combination changes, never on the per-frame animation clock.
 */
export function bakeDyedSprite(params: {
  baseImg: ImageBitmap | HTMLImageElement
  baseRect: [x: number, y: number, w: number, h: number]
  maskImg: ImageBitmap | HTMLImageElement
  maskRect: [x: number, y: number, w: number, h: number]
  clothing: DyeRoleInput
  accessory: DyeRoleInput
}): DyeBake | null {
  const { clothing, accessory } = params
  const [bx, by, w, h] = params.baseRect
  const [mx, my, mw, mh] = params.maskRect
  const base = regionImageData(params.baseImg, bx, by, w, h)
  const mask = regionImageData(params.maskImg, mx, my, mw, mh)
  if (!base || !mask) return null

  const clothingPixels =
    clothing?.kind === 'textile'
      ? regionImageData(clothing.img, clothing.x, clothing.y, clothing.pw, clothing.ph)
      : null
  const accessoryPixels =
    accessory?.kind === 'textile'
      ? regionImageData(accessory.img, accessory.x, accessory.y, accessory.pw, accessory.ph)
      : null
  if (clothing?.kind === 'textile' && !clothingPixels) return null
  if (accessory?.kind === 'textile' && !accessoryPixels) return null

  const clothingAnimated = clothing?.kind === 'textile' && clothing.motion != null
  const accessoryAnimated = accessory?.kind === 'textile' && accessory.motion != null

  const SUB = clothing?.kind === 'textile' || accessory?.kind === 'textile' ? TEXTILE_SUB : 1
  // Outline thickness in this bake's own pixel grid: always exactly 1
  // composite pixel, independent of the SUB texture subdivision. renderDyeFrame
  // scales this whole accumulator (base + moving layers) up to the caller's
  // display size every frame via a single canvas draw, so whatever thickness
  // is baked in here gets magnified by that same display-size/composite-size
  // ratio - using SUB (multiple composite pixels) made the line several times
  // too thick at typical display sizes. This can't do SpriteProvider.tsx's
  // getSprite/getDyedSprite trick of scaling to display size *before*
  // outlining (that needs a pixel readback, which the per-frame path here
  // deliberately avoids - see the file header), so 1 composite pixel is the
  // closest approximation to a thin on-screen line without one.
  // The layers below (regionSelector/regionShade/tile) are sized and written
  // into this same padded (cw+2t)×(ch+2t) grid so they stay aligned with the
  // base once padding shifts its content - see docs/dyes-and-textiles.md.
  const thickness = 1
  const cw = Math.max(w, mw) * SUB
  const ch = Math.max(h, mh) * SUB
  const ow = cw + thickness * 2
  const oh = ch + thickness * 2

  const baseOut = new ImageData(ow, oh)
  const clothingSelector = clothingAnimated ? new ImageData(ow, oh) : null
  const clothingShade = clothingAnimated ? new ImageData(ow, oh) : null
  const accessorySelector = accessoryAnimated ? new ImageData(ow, oh) : null
  const accessoryShade = accessoryAnimated ? new ImageData(ow, oh) : null

  for (let py = 0; py < ch; py++) {
    const byp = Math.min(h - 1, Math.floor((py * h) / ch))
    const myp = Math.min(mh - 1, Math.floor((py * mh) / ch))
    for (let px = 0; px < cw; px++) {
      const oi = ((py + thickness) * ow + (px + thickness)) * 4
      const bxp = Math.min(w - 1, Math.floor((px * w) / cw))
      const bi = (byp * w + bxp) * 4
      const baseA = base.data[bi + 3]

      let region: 'clothing' | 'accessory' | null = null
      let shade = 0
      if (baseA > 0) {
        const mxp = Math.min(mw - 1, Math.floor((px * mw) / cw))
        const mi = (myp * mw + mxp) * 4
        const mr = mask.data[mi]
        const mg = mask.data[mi + 1]
        if (clothing && mr > 0 && mr >= mg) {
          region = 'clothing'
          shade = mr / 255
        } else if (accessory && mg > 0) {
          region = 'accessory'
          shade = mg / 255
        }
      }

      let deferred = false
      if (region === 'clothing' && clothingAnimated && clothingSelector && clothingShade) {
        clothingSelector.data[oi + 3] = 255
        const s = Math.round(shade * 255)
        clothingShade.data[oi] = s
        clothingShade.data[oi + 1] = s
        clothingShade.data[oi + 2] = s
        clothingShade.data[oi + 3] = 255
        deferred = true
      } else if (
        region === 'accessory' &&
        accessoryAnimated &&
        accessorySelector &&
        accessoryShade
      ) {
        accessorySelector.data[oi + 3] = 255
        const s = Math.round(shade * 255)
        accessoryShade.data[oi] = s
        accessoryShade.data[oi + 1] = s
        accessoryShade.data[oi + 2] = s
        accessoryShade.data[oi + 3] = 255
        deferred = true
      }

      let r = base.data[bi]
      let g = base.data[bi + 1]
      let b = base.data[bi + 2]
      if (!deferred) {
        const role = region === 'clothing' ? clothing : region === 'accessory' ? accessory : null
        const pixels = region === 'clothing' ? clothingPixels : accessoryPixels
        const c = role ? sampleStaticRole(role, pixels, px, py) : null
        if (c && c[3] > 0) {
          r = Math.round(c[0] * shade)
          g = Math.round(c[1] * shade)
          b = Math.round(c[2] * shade)
        }
      }
      baseOut.data[oi] = r
      baseOut.data[oi + 1] = g
      baseOut.data[oi + 2] = b
      baseOut.data[oi + 3] = baseA
    }
  }

  // Bake the silhouette outline directly into baseOut, into the transparent
  // padding reserved above - never recomputed per frame (renderDyeFrame just
  // draws this baked base + the live motion layers on top every frame).
  dilateSilhouette(baseOut, thickness)

  const layers: DyeLayerBake[] = []
  if (
    clothingAnimated &&
    clothing?.kind === 'textile' &&
    clothing.motion &&
    clothingSelector &&
    clothingShade
  ) {
    layers.push({
      role: 'clothing',
      motion: clothing.motion,
      tile: cropToCanvas(clothing.img, clothing.x, clothing.y, clothing.pw, clothing.ph),
      pw: clothing.pw,
      ph: clothing.ph,
      regionSelector: imageDataToCanvas(clothingSelector),
      regionShade: imageDataToCanvas(clothingShade)
    })
  }
  if (
    accessoryAnimated &&
    accessory?.kind === 'textile' &&
    accessory.motion &&
    accessorySelector &&
    accessoryShade
  ) {
    layers.push({
      role: 'accessory',
      motion: accessory.motion,
      tile: cropToCanvas(accessory.img, accessory.x, accessory.y, accessory.pw, accessory.ph),
      pw: accessory.pw,
      ph: accessory.ph,
      regionSelector: imageDataToCanvas(accessorySelector),
      regionShade: imageDataToCanvas(accessoryShade)
    })
  }

  return { ow, oh, base: imageDataToCanvas(baseOut), layers }
}

// ---- Per-frame compositing (no readbacks, no encode) ----------------------

export interface DyeFrameScratch {
  accumulator: HTMLCanvasElement
  layer: HTMLCanvasElement
  snapshot: HTMLCanvasElement
}

export function createDyeFrameScratch(ow: number, oh: number): DyeFrameScratch {
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = ow
    c.height = oh
    return c
  }
  return { accumulator: make(), layer: make(), snapshot: make() }
}

const RAD_TO_DEG = 180 / Math.PI

/**
 * The live scroll/rotate transform for a layer, in the pattern's own local
 * (tile-repeat) space - fed to `CanvasPattern.setTransform`. Direction/sign
 * matches the previous per-pixel implementation (see the history note in
 * SpriteProvider.tsx): +speed on type 1 scrolls left, +speed on type 2
 * scrolls down, +speed on type 3 spins counter-clockwise on screen.
 */
function layerTransform(
  layer: DyeLayerBake,
  tSeconds: number,
  scrollSpeed: number,
  rotateSpeed: number
): DOMMatrix {
  const { type, speed, pivotX, pivotY } = layer.motion
  if (type === 3) {
    const angle = speed * rotateSpeed * tSeconds
    const cx = layer.pw / 2 + pivotX
    const cy = layer.ph / 2 + pivotY
    // Canvas rotation is clockwise-on-screen for +degrees (y-down); negate so
    // +angle (this file's radians) reads as counter-clockwise, matching the
    // dye's documented convention.
    return new DOMMatrix()
      .translate(cx, cy)
      .rotate(-angle * RAD_TO_DEG)
      .translate(-cx, -cy)
  }
  const disp = speed * scrollSpeed * tSeconds
  const tx = type === 1 ? -disp : 0
  const ty = type === 2 ? disp : 0
  return new DOMMatrix().translate(tx, ty)
}

/**
 * Composite one moving layer onto `dest` at (0,0): fill a repeating pattern
 * with the current transform, then clip it into its clothing/accessory region
 * and scale its colour by the mask shade - both via canvas compositing
 * operators (`multiply` for shade, `destination-in` for the region + the
 * pattern's own alpha), never a per-pixel readback.
 */
function drawLayer(
  dest: CanvasRenderingContext2D,
  layer: DyeLayerBake,
  transform: DOMMatrix,
  scratch: DyeFrameScratch
): void {
  const { layer: layerCanvas, snapshot } = scratch
  const lctx = layerCanvas.getContext('2d')
  const sctx = snapshot.getContext('2d')
  if (!lctx || !sctx) return
  const { width: ow, height: oh } = layerCanvas

  lctx.globalCompositeOperation = 'source-over'
  lctx.clearRect(0, 0, ow, oh)
  const pattern = lctx.createPattern(layer.tile, 'repeat')
  if (!pattern) return
  pattern.setTransform(transform)
  lctx.fillStyle = pattern
  lctx.fillRect(0, 0, ow, oh)

  // Snapshot the pattern's own alpha (weave holes, at this frame's transform)
  // before the shade/region passes below flatten it to fully opaque - restored
  // in the final step.
  sctx.clearRect(0, 0, ow, oh)
  sctx.drawImage(layerCanvas, 0, 0)

  // Multiply in the per-pixel shade (mask value).
  lctx.globalCompositeOperation = 'multiply'
  lctx.drawImage(layer.regionShade, 0, 0)

  // Clip to this dye's region (clothing red / accessory green).
  lctx.globalCompositeOperation = 'destination-in'
  lctx.drawImage(layer.regionSelector, 0, 0)

  // Restore the pattern's own alpha within that region.
  lctx.drawImage(snapshot, 0, 0)
  lctx.globalCompositeOperation = 'source-over'

  dest.drawImage(layerCanvas, 0, 0)
}

/** Render one frame of a baked dyed sprite onto `canvas`, scaled to its size. */
export function renderDyeFrame(
  canvas: HTMLCanvasElement,
  bake: DyeBake,
  tSeconds: number,
  scrollSpeed: number,
  rotateSpeed: number,
  scratch: DyeFrameScratch
): void {
  const ctx = canvas.getContext('2d')
  const actx = scratch.accumulator.getContext('2d')
  if (!ctx || !actx) return

  actx.globalCompositeOperation = 'source-over'
  actx.clearRect(0, 0, bake.ow, bake.oh)
  actx.drawImage(bake.base, 0, 0)
  for (const layer of bake.layers) {
    drawLayer(actx, layer, layerTransform(layer, tSeconds, scrollSpeed, rotateSpeed), scratch)
  }

  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(scratch.accumulator, 0, 0, bake.ow, bake.oh, 0, 0, canvas.width, canvas.height)
}
