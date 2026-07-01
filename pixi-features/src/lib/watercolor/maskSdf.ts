/**
 * CPU signed-distance transform of a coverage mask, via a two-pass 3-4-5 chamfer
 * (cheap, ~2% error vs exact Euclidean — plenty for driving the drying field).
 * Output: distance in pixels, NEGATIVE inside the mask, positive outside.
 */
const CHAMFER_ORTH = 1
const CHAMFER_DIAG = Math.SQRT2

function chamferDistance(binary: Uint8Array, size: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(size * size)
  for (let i = 0; i < d.length; i++) d[i] = binary[i] ? 0 : INF
  const at = (x: number, y: number) => d[y * size + x]
  const relax = (x: number, y: number, from: number, w: number) => {
    const v = from + w
    if (v < d[y * size + x]) d[y * size + x] = v
  }
  // forward pass
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (x > 0) relax(x, y, at(x - 1, y), CHAMFER_ORTH)
      if (y > 0) relax(x, y, at(x, y - 1), CHAMFER_ORTH)
      if (x > 0 && y > 0) relax(x, y, at(x - 1, y - 1), CHAMFER_DIAG)
      if (x < size - 1 && y > 0) relax(x, y, at(x + 1, y - 1), CHAMFER_DIAG)
    }
  // backward pass
  for (let y = size - 1; y >= 0; y--)
    for (let x = size - 1; x >= 0; x--) {
      if (x < size - 1) relax(x, y, at(x + 1, y), CHAMFER_ORTH)
      if (y < size - 1) relax(x, y, at(x, y + 1), CHAMFER_ORTH)
      if (x < size - 1 && y < size - 1) relax(x, y, at(x + 1, y + 1), CHAMFER_DIAG)
      if (x > 0 && y < size - 1) relax(x, y, at(x - 1, y + 1), CHAMFER_DIAG)
    }
  return d
}

export function computeMaskSdf(mask: Float32Array, size: number): Float32Array {
  const inside = new Uint8Array(size * size)   // 1 where covered
  const outside = new Uint8Array(size * size)  // 1 where NOT covered
  for (let i = 0; i < mask.length; i++) {
    const covered = mask[i] >= 0.5
    inside[i] = covered ? 1 : 0
    outside[i] = covered ? 0 : 1
  }
  const distOut = chamferDistance(inside, size)  // distance to nearest covered pixel (0 inside)
  const distIn = chamferDistance(outside, size)  // distance to nearest empty pixel (0 outside)
  const sdf = new Float32Array(size * size)
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = mask[i] >= 0.5 ? -distIn[i] : distOut[i]  // negative inside
  }
  return sdf
}
