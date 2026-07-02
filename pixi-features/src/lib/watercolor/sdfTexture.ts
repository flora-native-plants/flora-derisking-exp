// src/lib/watercolor/sdfTexture.ts
import { Texture } from 'pixi.js'

const RIM_PX = 10 // near-edge band width (px) for the warm tidied mask rim

/**
 * Pack a signed-distance field into a texture via a Canvas2D ImageData source —
 * the most reliable upload path in Pixi (BufferImageSource with typed-array data
 * returned near-zero / ~5× compressed values on this backend for BOTH r32float and
 * rgba8unorm; a canvas source uploads exactly). Values are PRE-NORMALIZED:
 *   R = sdfN  (0 at the silhouette edge → 1 at the deepest interior point)
 *   G = rim   (0 at the edge → 1 by RIM_PX inside — fine near-edge resolution)
 */
export function sdfToTexture(sdf: Float32Array, size: number, maxDepth: number): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const invMax = 1 / Math.max(maxDepth, 1e-3)
  for (let i = 0; i < sdf.length; i++) {
    const d = -sdf[i] // positive inside, negative outside
    const sdfN = Math.max(0, Math.min(1, d * invMax))
    const rim = Math.max(0, Math.min(1, d / RIM_PX))
    const o = i * 4
    img.data[o] = Math.round(sdfN * 255)
    img.data[o + 1] = Math.round(rim * 255)
    img.data[o + 2] = 0
    // A = exact silhouette coverage (inside = d>0), so the fill reaches thin lobes where
    // sdfN rounds to ~0 — else the fill recedes and the contour floats outside it.
    img.data[o + 3] = d > 0 ? 255 : 0
  }
  ctx.putImageData(img, 0, 0)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  tex.source.addressMode = 'clamp-to-edge'
  return tex
}
