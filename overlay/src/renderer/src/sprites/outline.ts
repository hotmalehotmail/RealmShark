/**
 * Adds RotMG's thin black silhouette outline to a sprite, baked once at
 * crop/bake time (see SpriteProvider.tsx's `getSprite`/`getDyedSprite` and
 * dyeBake.ts's `bakeDyedSprite`). Ports the same padded-silhouette-dilation
 * approach the Swing desktop client uses (`assets/ImageBuffer.java`'s
 * `getOutlinedIcon` - see docs/asset-pipeline.md) to canvas `ImageData`.
 */

/** Renders an ImageData onto a same-size canvas. */
export function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = data.width
  c.height = data.height
  const ctx = c.getContext('2d')
  ctx?.putImageData(data, 0, 0)
  return c
}

/**
 * Grows the opaque silhouette in `data` by `thickness` pixels (orthogonal
 * 4-neighbour dilation, run `thickness` times), painting newly-opaque pixels
 * solid black. Mutates `data` in place. The caller must leave at least
 * `thickness` transparent pixels of room around the silhouette for the
 * outline to grow into - `outlineImageData` below does this by padding;
 * `bakeDyedSprite` (dyeBake.ts) instead writes its silhouette directly into a
 * pre-padded buffer, since it must also keep its dye-motion layers aligned to
 * the same padded coordinate space.
 */
export function dilateSilhouette(data: ImageData, thickness: number): void {
  if (thickness <= 0) return
  const { width: w, height: h } = data
  let opaque = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) opaque[i] = data.data[i * 4 + 3] > 0 ? 1 : 0

  for (let pass = 0; pass < thickness; pass++) {
    const next = opaque.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (opaque[i]) continue
        const left = x > 0 && opaque[i - 1]
        const right = x < w - 1 && opaque[i + 1]
        const up = y > 0 && opaque[i - w]
        const down = y < h - 1 && opaque[i + w]
        if (left || right || up || down) next[i] = 1
      }
    }
    opaque = next
  }

  for (let i = 0; i < w * h; i++) {
    const di = i * 4
    if (data.data[di + 3] === 0 && opaque[i]) {
      data.data[di] = 0
      data.data[di + 1] = 0
      data.data[di + 2] = 0
      data.data[di + 3] = 255
    }
  }
}

/**
 * Pads `src` by `thickness` transparent pixels on every side, then dilates
 * its silhouette into that padding to produce a solid black outline. Used by
 * `getSprite`/`getDyedSprite` (SpriteProvider.tsx), whose compositors don't
 * need padded output during their own per-pixel pass and can just wrap the
 * finished crop/composite.
 */
export function outlineImageData(src: ImageData, thickness: number): ImageData {
  if (thickness <= 0) return src
  const pw = src.width + thickness * 2
  const ph = src.height + thickness * 2
  const out = new ImageData(pw, ph)
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4
      const di = ((y + thickness) * pw + (x + thickness)) * 4
      out.data[di] = src.data[si]
      out.data[di + 1] = src.data[si + 1]
      out.data[di + 2] = src.data[si + 2]
      out.data[di + 3] = src.data[si + 3]
    }
  }
  dilateSilhouette(out, thickness)
  return out
}

/**
 * Scale `src` up to `displaySize`×`displaySize` first, *then* dilate by
 * exactly 1 pixel - matching the Swing desktop client's `getOutlinedIcon`
 * (`assets/ImageBuffer.java`), which calls `img.getScaledInstance(size - 2,
 * size - 2, ...)` before dilating the already-scaled icon by 1 pixel on every
 * edge. Outlining in the *source* resolution and scaling the result afterward
 * (as `outlineImageData` alone does) instead blows the line up by the same
 * factor as the sprite - fine when source and display resolution are close,
 * badly-thick when a small native/composite sprite is scaled up several times
 * for display (see the git history of this function for the pre-fix
 * behaviour). Returns `displaySize`×`displaySize` ImageData, or `null` if a
 * canvas 2D context couldn't be obtained (mirrors the `if (!ctx) return null`
 * sentinel callers use elsewhere); falls back to a plain unoutlined scale
 * when `displaySize` is too small to fit the 1px border on each side.
 */
export function outlineAtDisplaySize(src: ImageData, displaySize: number): ImageData | null {
  const inner = displaySize - 2
  const targetW = inner > 0 ? inner : displaySize
  const targetH = targetW
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(imageDataToCanvas(src), 0, 0, src.width, src.height, 0, 0, targetW, targetH)
  const scaled = ctx.getImageData(0, 0, targetW, targetH)
  return inner > 0 ? outlineImageData(scaled, 1) : scaled
}
