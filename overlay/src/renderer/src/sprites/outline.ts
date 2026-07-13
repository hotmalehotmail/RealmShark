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
