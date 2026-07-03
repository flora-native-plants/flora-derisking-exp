/**
 * Heitz–Neyret by-example texture synthesis — precompute pass.
 * Pure numerics: color decorrelation (PCA) + per-channel histogram Gaussianization LUTs.
 * No Pixi, no DOM. Consumed by later rendering tasks.
 */

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/**
 * Abramowitz & Stegun 7.1.26 erf approximation (max error < 1.5e-7).
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const poly =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))))
  return sign * (1 - poly * Math.exp(-a * a))
}

/** Standard-normal CDF: Φ(x) */
function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

/**
 * Acklam rational approximation for the standard-normal quantile Φ⁻¹(p).
 * Accurate to ~9 significant digits for p in (0, 1).
 */
function invNormalCDF(p: number): number {
  if (p <= 0) return -8
  if (p >= 1) return  8

  const a = [-3.969683028665376e1,  2.209460984245205e2,
             -2.759285104469687e2,  1.383577518672690e2,
             -3.066479806614716e1,  2.506628277459239e0]
  const b = [-5.447609879822406e1,  1.615858368580409e2,
             -1.556989798598866e2,  6.680131188771972e1,
             -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1,
             -2.400758277161838e0,  -2.549732539343734e0,
              4.374664141464968e0,   2.938163982698783e0]
  const d = [ 7.784695709041462e-3,  3.224671290700398e-1,
              2.445134137142996e0,   3.754408661907416e0]

  const pLow  = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
  }

  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
  }

  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
}

// ---------------------------------------------------------------------------
// Symmetric 3×3 Jacobi eigen-decomposition
// ---------------------------------------------------------------------------

/** Multiply two 3×3 row-major matrices. */
function mat3Mul(A: number[], B: number[]): number[] {
  const C = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        C[r*3+c] += A[r*3+k] * B[k*3+c]
  return C
}

/**
 * Cyclic Jacobi sweeps on a symmetric 3×3 matrix S.
 * Returns { eigvals, eigvecs } where eigvecs rows are eigenvectors.
 */
function jacobi3(S: number[]): { eigvals: number[]; eigvecs: number[] } {
  // Work on a copy
  const A = [...S]
  // Accumulate rotation: starts as identity
  let V = [1,0,0, 0,1,0, 0,0,1]

  const off = (r: number, c: number): number => r*3+c

  for (let sweep = 0; sweep < 10; sweep++) {
    // Pairs (p,q): (0,1),(0,2),(1,2)
    for (const [p, q] of [[0,1],[0,2],[1,2]] as [number,number][]) {
      const Apq = A[off(p,q)]
      if (Math.abs(Apq) < 1e-12) continue
      const App = A[off(p,p)]
      const Aqq = A[off(q,q)]
      const theta = 0.5 * (App - Aqq) / Apq
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
      const cosT = 1 / Math.sqrt(1 + t * t)
      const sinT = t * cosT

      // Build Givens rotation matrix G
      const G = [1,0,0, 0,1,0, 0,0,1]
      G[off(p,p)] =  cosT; G[off(p,q)] = -sinT
      G[off(q,p)] =  sinT; G[off(q,q)] =  cosT

      // A = Gᵀ A G  (similarity transform)
      const GT = [1,0,0, 0,1,0, 0,0,1]
      GT[off(p,p)] =  cosT; GT[off(p,q)] =  sinT
      GT[off(q,p)] = -sinT; GT[off(q,q)] =  cosT

      const tmp = mat3Mul(mat3Mul(GT, A), G)
      for (let i = 0; i < 9; i++) A[i] = tmp[i]

      // Accumulate V = V G
      V = mat3Mul(V, G)
    }
  }

  // Diagonal of A → eigenvalues; columns of V → eigenvectors
  const eigvals = [A[0], A[4], A[8]]

  // eigvecs[row*3+col]: row = eigenvector index, col = component
  // V columns are eigenvectors → transpose to get rows
  const eigvecs = [
    V[0], V[3], V[6],
    V[1], V[4], V[7],
    V[2], V[5], V[8],
  ]

  return { eigvals, eigvecs }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute PCA color decorrelation from an N-pixel RGB Float32Array (length 3N, values 0..1).
 * Returns:
 *   mean    — per-channel mean [R, G, B]
 *   forward — row-major 3×3; maps centered RGB → decorrelated (rows = eigenvectors)
 *   inverse — its transpose; maps decorrelated → centered RGB
 */
export function computeColorDecorrelation(
  rgb: Float32Array,
): { mean: [number, number, number]; forward: number[]; inverse: number[] } {
  const N = rgb.length / 3
  const mean: [number, number, number] = [0, 0, 0]

  for (let i = 0; i < N; i++) {
    mean[0] += rgb[i*3+0]
    mean[1] += rgb[i*3+1]
    mean[2] += rgb[i*3+2]
  }
  mean[0] /= N; mean[1] /= N; mean[2] /= N

  // 3×3 covariance (upper triangle, symmetric)
  const cov = new Array(9).fill(0)
  for (let i = 0; i < N; i++) {
    const dr = rgb[i*3+0] - mean[0]
    const dg = rgb[i*3+1] - mean[1]
    const db = rgb[i*3+2] - mean[2]
    cov[0] += dr*dr; cov[1] += dr*dg; cov[2] += dr*db
    cov[4] += dg*dg; cov[5] += dg*db
    cov[8] += db*db
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5]
  for (let i = 0; i < 9; i++) cov[i] /= N

  const { eigvecs } = jacobi3(cov)

  // forward: rows = eigenvectors (maps centered RGB → decorrelated)
  const forward = eigvecs
  // inverse: transpose of forward
  const inverse = [
    eigvecs[0], eigvecs[3], eigvecs[6],
    eigvecs[1], eigvecs[4], eigvecs[7],
    eigvecs[2], eigvecs[5], eigvecs[8],
  ]

  return { mean, forward, inverse }
}

/**
 * Build forward (T) and inverse (Tinv) Gaussianization LUTs for one decorrelated channel.
 * channel: Float32Array of N values (any range, including negative decorrelated values).
 * size: LUT length (default 256).
 *
 * Both T and Tinv are indexed by a value normalized to [0,1] using [min, max] of channel:
 *   - To index T with a raw value x: T[round((x - min) / (max - min) * (size-1))]
 *   - Tinv outputs values in [0,1] (same normalization); to recover raw: Tinv[i]*(max-min)+min
 *
 * Returns min/max so callers can map arbitrary channel values into LUT index space.
 *
 * Gaussian target: N(0.5, 1/6), clamped to [0,1].
 */
export function buildGaussianLUT(
  channel: Float32Array,
  size = 256,
): { T: Float32Array; Tinv: Float32Array; min: number; max: number } {
  const sorted = Float32Array.from(channel).sort()
  const N = sorted.length

  const minVal = sorted[0]
  const maxVal = sorted[N - 1]
  const range = maxVal - minVal || 1

  const T    = new Float32Array(size)
  const Tinv = new Float32Array(size)

  for (let i = 0; i < size; i++) {
    // Input value in [minVal, maxVal]
    const v = minVal + (i / (size - 1)) * range

    // Empirical CDF: fraction of sorted values ≤ v
    let lo = 0; let hi = N
    while (lo < hi) { const m = (lo + hi) >>> 1; sorted[m] <= v ? lo = m + 1 : hi = m }
    const rank = lo  // number of values ≤ v
    // Avoid 0 and 1 to keep invNormalCDF finite
    const u = Math.max(0.5 / N, Math.min(1 - 0.5 / N, rank / N))

    // Map to Gaussian: G = 0.5 + Φ⁻¹(u) / 6, clamp [0,1]
    T[i] = Math.max(0, Math.min(1, 0.5 + invNormalCDF(u) / 6))
  }

  for (let i = 0; i < size; i++) {
    // Gaussian bucket value in [0,1]
    const g = i / (size - 1)
    // Invert: find quantile u = Φ((g - 0.5) * 6)
    const u = Math.max(0.5 / N, Math.min(1 - 0.5 / N, normalCDF((g - 0.5) * 6)))
    // Look up in sorted array
    const idx = Math.max(0, Math.min(N - 1, Math.round(u * N) - 1))
    // Normalize to [0,1] (caller can recover raw with Tinv[i]*(max-min)+min)
    Tinv[i] = (sorted[idx] - minVal) / range
  }

  return { T, Tinv, min: minVal, max: maxVal }
}
