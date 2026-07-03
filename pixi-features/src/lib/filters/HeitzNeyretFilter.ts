import { Filter, GlProgram, UniformGroup, defaultFilterVert, Texture } from 'pixi.js'

/**
 * Heitz–Neyret by-example stochastic texture filter.
 * Implements "Procedural Stochastic Textures by Tiling and Blending" (JCGT 2018).
 *
 * Generates an infinite, seamless, non-repeating watercolor-wash field from a real
 * texture exemplar by tiling and blending 3 overlapping triangle-grid samples in
 * decorrelated/Gaussianized colour space.
 *
 * Construction:
 *   const f = new HeitzNeyretFilter({ Tinv, T, forward, inverse, mean, scale, seed })
 * where T/Tinv are 256×1 RGBA textures (R=ch0, G=ch1, B=ch2) built by the
 * TabWashMaterialHN setup, and forward/inverse/mean come from Task-1 precompute.
 *
 * GLSL mat3 pitfall: PixiJS v8 packs mat3 UBO members with std140 column-padding.
 * We bypass this entirely by uploading the matrix rows as 3 separate vec3 uniforms
 * and using dot-product reconstruction, so we never touch the mat3 type.
 *
 * Blend centring: Task-1 LUTs map to N(0.5, 1/6) not zero-mean, so the
 * variance-preserving blend must be centred at 0.5:
 *   W = 0.5 + (w1*(g1-0.5) + w2*(g2-0.5) + w3*(g3-0.5)) / sqrt(w1²+w2²+w3²)
 */

// ---------------------------------------------------------------------------
// Fragment shader
// ---------------------------------------------------------------------------

const HN_FRAG = /* glsl */`#version 300 es
precision highp float;

in  vec2 vTextureCoord;
out vec4 finalColor;

// Filter input — applied to a plain rectangle; not read for output generation.
uniform sampler2D uTexture;

// Wash exemplar (tiled, repeat wrap)
uniform sampler2D uWash;

// Gaussianization LUT:   256×1 RGBA, R=ch0 T, G=ch1 T, B=ch2 T  (forward)
// Inverse-Gaussianization: same packing                              (inverse)
uniform sampler2D uT;
uniform sampler2D uTinv;

// Domain
uniform float uScale;
uniform vec2  uSeedOff;  // 2-D domain offset derived from scalar seed

// Per-channel mean (linear RGB)
uniform vec3 uMean;

// Decorrelation matrix rows — forward: centered_rgb → decorrelated
uniform vec3 uFwd0;
uniform vec3 uFwd1;
uniform vec3 uFwd2;

// Re-correlation matrix rows — inverse: decorrelated → centered_rgb
uniform vec3 uInv0;
uniform vec3 uInv1;
uniform vec3 uInv2;

// LUT range (per-channel min/max of decorrelated values)
uniform vec3 uLutMin;
uniform vec3 uLutMax;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

vec3 decorr(vec3 c) {
  return vec3(dot(uFwd0, c), dot(uFwd1, c), dot(uFwd2, c));
}
vec3 recorr(vec3 d) {
  return vec3(dot(uInv0, d), dot(uInv1, d), dot(uInv2, d));
}

// Hash: lattice vertex (integer 2D) → pseudo-random 2D offset in [0,1]²
vec2 hash2(ivec2 p) {
  vec2 pf = vec2(p);
  vec2 r = vec2(dot(pf, vec2(127.1, 311.7)), dot(pf, vec2(269.5, 183.3)));
  return fract(sin(r) * 43758.5453);
}

// Heitz–Neyret triangle grid.
// Maps uv → 3 lattice vertices + barycentric weights (w1+w2+w3 == 1).
// skewMatrix from the supplemental code: gridToSkewedGrid = mat2(1,0,-0.57735027,1.15470054)
void TriangleGrid(
    vec2 uv,
    out float w1, out float w2, out float w3,
    out ivec2 v1,  out ivec2 v2,  out ivec2 v3)
{
  // Scale so tiles appear at a natural size relative to the UV domain
  uv *= 3.464; // 2*sqrt(3)

  // Skew input into simplex triangle grid
  // Column-major: col0=(1,-0.57735027), col1=(0,1.15470054)
  vec2 sk = vec2(uv.x - uv.y * 0.57735027, uv.y * 1.15470054);

  ivec2 base = ivec2(floor(sk));
  vec2  fr   = fract(sk);
  float rem  = 1.0 - fr.x - fr.y;

  if (rem > 0.0) {
    w1 = rem;
    w2 = fr.y;
    w3 = fr.x;
    v1 = base;
    v2 = base + ivec2(0, 1);
    v3 = base + ivec2(1, 0);
  } else {
    w1 = -rem;
    w2 = 1.0 - fr.y;
    w3 = 1.0 - fr.x;
    v1 = base + ivec2(1, 1);
    v2 = base + ivec2(1, 0);
    v3 = base + ivec2(0, 1);
  }
}

// Gaussianize a single per-channel value via the packed LUT texture.
// T has R=ch0, G=ch1, B=ch2; we sample at the channel-specific normalised x.
// Returns the full .rgb at each normalised position — caller extracts the
// right component per channel.
vec3 sampleT(vec3 normCoords) {
  // Each channel uses a different x (its own normalised index) but the same texture.
  // We sample three times and pull the matching component each time.
  return vec3(
    texture(uT, vec2(normCoords.x, 0.5)).r,
    texture(uT, vec2(normCoords.y, 0.5)).g,
    texture(uT, vec2(normCoords.z, 0.5)).b
  );
}

vec3 sampleTinv(vec3 gaussCoords) {
  vec3 raw = vec3(
    texture(uTinv, vec2(gaussCoords.x, 0.5)).r,
    texture(uTinv, vec2(gaussCoords.y, 0.5)).g,
    texture(uTinv, vec2(gaussCoords.z, 0.5)).b
  );
  // Tinv outputs normalised [0,1]; recover raw decorrelated values
  return raw * (uLutMax - uLutMin) + uLutMin;
}

// Gaussianize a decorrelated tap: normalise into LUT index space, sample T.
vec3 gaussianize(vec3 dec) {
  vec3 norm = clamp((dec - uLutMin) / max(uLutMax - uLutMin, vec3(1e-6)), 0.0, 1.0);
  return sampleT(norm);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
  // Domain coords — scale controls tile density; seed offsets for variants
  vec2 uv = vTextureCoord * uScale + uSeedOff;

  // Triangle grid: 3 vertices + barycentric weights
  float w1, w2, w3;
  ivec2 vert1, vert2, vert3;
  TriangleGrid(uv, w1, w2, w3, vert1, vert2, vert3);

  // Per-vertex random 2D offset to decorrelate tile neighbours
  vec2 o1 = hash2(vert1);
  vec2 o2 = hash2(vert2);
  vec2 o3 = hash2(vert3);

  // Sample wash at each offset position (repeat wrap handles tiling)
  vec3 s1 = texture(uWash, uv + o1).rgb;
  vec3 s2 = texture(uWash, uv + o2).rgb;
  vec3 s3 = texture(uWash, uv + o3).rgb;

  // Decorrelate each tap (forward PCA)
  vec3 d1 = decorr(s1 - uMean);
  vec3 d2 = decorr(s2 - uMean);
  vec3 d3 = decorr(s3 - uMean);

  // Gaussianize (histogram transform T: decorrelated → Gaussian-space)
  vec3 g1 = gaussianize(d1);
  vec3 g2 = gaussianize(d2);
  vec3 g3 = gaussianize(d3);

  // Variance-preserving blend, centred at 0.5 because Task-1 LUT maps to N(0.5,1/6).
  // Standard formula (Heitz–Neyret eq.2) works for zero-mean; we centre by subtracting
  // 0.5 before blending and adding it back — this preserves the Gaussian distribution
  // across the blend seam rather than shifting brightness.
  float invW = inversesqrt(w1*w1 + w2*w2 + w3*w3);
  vec3 W = 0.5 + (w1 * (g1 - 0.5) + w2 * (g2 - 0.5) + w3 * (g3 - 0.5)) * invW;
  W = clamp(W, 0.0, 1.0);

  // Inverse-Gaussianize (Tinv: Gaussian-space → decorrelated), then re-correlate
  vec3 dec  = sampleTinv(W);
  vec3 rgb  = recorr(dec) + uMean;

  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`

// ---------------------------------------------------------------------------
// Filter class
// ---------------------------------------------------------------------------

export interface HeitzNeyretOpts {
  /** Forward Gaussianization LUT — 256×1 RGBA, R=ch0, G=ch1, B=ch2 (packed). */
  T: Texture
  /** Inverse Gaussianization LUT — same packing as T. */
  Tinv: Texture
  /** forward[0..8]: row-major 3×3; maps centered_rgb → decorrelated.  From Task-1. */
  forward: number[]
  /** inverse[0..8]: row-major 3×3 (= forward.T); maps decorrelated → centered_rgb. */
  inverse: number[]
  /** Per-channel mean [R, G, B] of the wash exemplar. */
  mean: [number, number, number]
  /** Per-channel min of the decorrelated space (from buildGaussianLUT). */
  lutMin: [number, number, number]
  /** Per-channel max of the decorrelated space (from buildGaussianLUT). */
  lutMax: [number, number, number]
  /** UV scale — how many tile-lengths fit across the filter domain. Default 1. */
  scale?: number
  /** Scalar seed → 2-D domain offset for per-variant diversity. Default 0. */
  seed?: number
}

function seedToOffset(seed: number): Float32Array {
  // Two distinct irrational-number-multiplied offsets to keep axes from correlating.
  return new Float32Array([seed * 0.1, seed * 0.1732050808]) // 0.173.. = 1/sqrt(33)
}

export class HeitzNeyretFilter extends Filter {
  private group: UniformGroup

  constructor(opts: HeitzNeyretOpts) {
    const { T, Tinv, forward, inverse, mean, lutMin, lutMax, scale = 1, seed = 0 } = opts

    // Rows of the forward (decorrelation) matrix — uploaded directly as vec3,
    // no mat3 to avoid std140 column-padding in the UBO.
    const f = forward
    const inv = inverse

    const group = new UniformGroup({
      uScale:   { value: scale,                                    type: 'f32' },
      uSeedOff: { value: seedToOffset(seed),                       type: 'vec2<f32>' },
      uMean:    { value: new Float32Array(mean),                   type: 'vec3<f32>' },
      // Forward matrix rows (decorrelation: centered_rgb → decorrelated)
      uFwd0:    { value: new Float32Array([f[0], f[1], f[2]]),     type: 'vec3<f32>' },
      uFwd1:    { value: new Float32Array([f[3], f[4], f[5]]),     type: 'vec3<f32>' },
      uFwd2:    { value: new Float32Array([f[6], f[7], f[8]]),     type: 'vec3<f32>' },
      // Inverse matrix rows (re-correlation: decorrelated → centered_rgb)
      uInv0:    { value: new Float32Array([inv[0], inv[1], inv[2]]), type: 'vec3<f32>' },
      uInv1:    { value: new Float32Array([inv[3], inv[4], inv[5]]), type: 'vec3<f32>' },
      uInv2:    { value: new Float32Array([inv[6], inv[7], inv[8]]), type: 'vec3<f32>' },
      // LUT range
      uLutMin:  { value: new Float32Array(lutMin),                 type: 'vec3<f32>' },
      uLutMax:  { value: new Float32Array(lutMax),                 type: 'vec3<f32>' },
    })

    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: HN_FRAG }),
      resources: {
        hnUniforms: group,
        uWash: Texture.WHITE.source, // placeholder — caller MUST call setWash() before first render
        uT:    T.source,
        uTinv: Tinv.source,
      },
    })

    this.group = group
  }

  /** Bind the watercolor wash texture (must have repeat wrap already set). */
  setWash(tex: Texture): void {
    ;(this.resources as unknown as Record<string, unknown>).uWash = tex.source
  }

  setScale(v: number): void { this.group.uniforms.uScale = v }

  setSeed(v: number): void {
    const arr = this.group.uniforms.uSeedOff as Float32Array
    const off = seedToOffset(v)
    arr[0] = off[0]
    arr[1] = off[1]
  }
}
