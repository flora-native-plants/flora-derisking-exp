export type RGB = [number, number, number]

const EPS = 1e-4
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const acoth = (x: number) => 0.5 * Math.log((x + 1) / (x - 1))

/** Force 0 < Rb < Rw < 1 per channel so the inversion stays real. */
function sanitize(Rw: RGB, Rb: RGB): { rw: RGB; rb: RGB } {
  const rw: RGB = [0, 0, 0], rb: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    rw[c] = clamp(Rw[c], 2 * EPS, 1 - EPS)
    rb[c] = clamp(Rb[c], EPS, rw[c] - EPS)
  }
  return { rw, rb }
}

export function pigmentKS(Rw: RGB, Rb: RGB): { K: RGB; S: RGB } {
  const { rw, rb } = sanitize(Rw, Rb)
  const K: RGB = [0, 0, 0], S: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const a = 0.5 * (rw[c] + (rb[c] - rw[c] + 1) / rb[c])
    const b = Math.sqrt(Math.max(a * a - 1, EPS))
    const arg = (b * b - (a - rw[c]) * (a - 1)) / (b * (1 - rw[c]))
    const s = (1 / b) * acoth(clamp(arg, 1 + EPS, 1e6)) // arg must exceed 1 for acoth
    S[c] = Math.max(s, EPS)
    K[c] = S[c] * (a - 1)
  }
  return { K, S }
}

export function reflectanceInfinite(K: RGB, S: RGB): RGB {
  const out: RGB = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const ks = K[c] / Math.max(S[c], EPS)
    out[c] = clamp(1 + ks - Math.sqrt(ks * ks + 2 * ks), EPS, 1 - EPS)
  }
  return out
}
