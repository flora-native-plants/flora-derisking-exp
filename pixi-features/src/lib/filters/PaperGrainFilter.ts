// PaperGrainFilter — world-anchored paper/graphite grain for the Sketch Style tab.
//
// The grain SOURCE can be either procedural value-noise (looks like digital static — kept only
// for A/B) or a REAL scanned paper/graphite texture (authentic). Either way the same two hard
// problems are solved in the shader:
//
//   1. World-anchoring (uWorldMatrix, exactly like GridFilter) — grain is glued to the drawing
//      and pans with it, instead of the "shower door" slide.
//   2. Surface-stable fractal dithering — the grain is sampled at two octaves 2^floor(log2 zoom)
//      and the next, cross-faded by fract(log2 zoom), so the apparent grain size stays constant
//      as you zoom (no bloat/pixelation) even though it's anchored in world space.
//
// Applied to a full-screen, screen-fixed Sprite behind the strokes (its bounds == the canvas,
// so the filter covers everything). Bind a paper texture via setPaperTexture(); it should be
// tiling (addressMode 'repeat').

import { Filter, GlProgram, UniformGroup, Texture, defaultFilterVert } from 'pixi.js'
import type { TextureSource } from 'pixi.js'
import { GLSL_HASH21_VNOISE } from './glslNoise'

const FRAG = `
precision highp float;

in  vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;      // filter input (the white paper sprite) — unused for color
uniform sampler2D uPaperTex;     // real paper/graphite texture (tiling)
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform mat3  uWorldMatrix;      // screen -> world (inverse camera)
uniform float uZoom;

uniform float uGrainScale;       // world units per texture tile (bigger = coarser)
uniform float uGrainContrast;    // 0..1 how strongly grain darkens the paper
uniform vec3  uPaperColor;       // paper base color
uniform float uUseTexture;       // 0 = procedural noise (static-looking), 1 = real texture
uniform float uAnchor;           // 0 = world-lock (correct), 1 = screen-lock (shower door)
uniform float uOctaves;          // 0 = single freq (pixelates on zoom), 1 = fractal octaves
uniform float uShowGrain;        // 0 = paper, 1 = visualize raw grain field
uniform float uMode;             // 0 = paper background, 1 = graphite-in-stroke modulation
uniform float uInkGrain;         // 0..1 how much grain breaks up the strokes (mode 1)
uniform float uSurface;          // 0 = flat luminance, 1 = height->normal lighting + directional
uniform vec2  uLightDir;         // raking light direction (cos,sin of angle)
uniform float uBumpStrength;     // steepness of the derived surface normal
uniform float uLightStrength;    // how strongly relief shading tints the paper

${GLSL_HASH21_VNOISE}

float sampleSource(vec2 uv) {
  if (uUseTexture > 0.5) {
    return dot(texture(uPaperTex, uv).rgb, vec3(0.299, 0.587, 0.114)); // luminance
  }
  return vnoise(uv);
}

// Fractal-octave sample: constant apparent tile size at any zoom, anchored to uv (world).
float grainField(vec2 uv) {
  if (uOctaves < 0.5) return sampleSource(uv);
  float L   = log2(max(uZoom, 0.0001));
  float oct = floor(L);
  float f   = fract(L);
  float n0  = sampleSource(uv * exp2(oct));
  float n1  = sampleSource(uv * exp2(oct + 1.0));
  return mix(n0, n1, f);
}

void main() {
  vec2 screenPx = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
  vec2 worldP   = (uWorldMatrix * vec3(screenPx, 1.0)).xy;

  // World-lock (correct) vs screen-lock (deliberately wrong, for the shower-door demo).
  vec2 guv = mix(worldP, screenPx, uAnchor) / uGrainScale;

  float g = grainField(guv);   // ~0..1, luminance as height: 1 = peak, 0 = tooth valley

  // Derive a surface normal from the height field. A WIDE, symmetric difference smooths the
  // gradient — a 1-texel diff over a noisy photo gives salt-and-pepper relief. This gives broad
  // paper undulation instead.
  float e  = 0.02;
  float hxp = grainField(guv + vec2(e, 0.0));
  float hxn = grainField(guv - vec2(e, 0.0));
  float hyp = grainField(guv + vec2(0.0, e));
  float hyn = grainField(guv - vec2(0.0, e));
  vec3 N   = normalize(vec3(-(hxp - hxn) * uBumpStrength, -(hyp - hyn) * uBumpStrength, 1.0));

  // Raking light for relief; small ambient so valleys aren't pure black.
  vec3 L    = normalize(vec3(uLightDir, 0.55));
  float lit = clamp(dot(N, L) + 0.15, 0.0, 1.0);

  if (uShowGrain > 0.5 && uMode < 0.5) {
    vec3 vis = uSurface > 0.5 ? (N * 0.5 + 0.5) : vec3(g); // normal map vs raw height
    finalColor = vec4(vis, 1.0);
    return;
  }

  if (uMode < 0.5) {
    // Paper background. Flat = luminance multiply; surface = relief-lit tooth.
    float flatShade   = mix(1.0, g,   uGrainContrast);
    float reliefShade = mix(1.0, lit, uGrainContrast * uLightStrength);
    float shade = mix(flatShade, reliefShade, uSurface);
    finalColor = vec4(uPaperColor * shade, 1.0);
  } else {
    // Graphite-in-stroke. Filter input is premultiplied.
    vec4 ink = texture(uTexture, vTextureCoord);
    vec3 rgb = ink.a > 0.001 ? ink.rgb / ink.a : ink.rgb;

    // Stroke tangent from the alpha gradient (grad = across-stroke; perp = along-stroke).
    vec2 px = 1.0 / uInputSize.xy;
    float aL = texture(uTexture, vTextureCoord - vec2(px.x, 0.0)).a;
    float aR = texture(uTexture, vTextureCoord + vec2(px.x, 0.0)).a;
    float aD = texture(uTexture, vTextureCoord - vec2(0.0, px.y)).a;
    float aU = texture(uTexture, vTextureCoord + vec2(0.0, px.y)).a;
    vec2 tangent = normalize(vec2(-(aU - aD), (aR - aL)) + vec2(1e-5));

    // Graphite catches on micro-facets facing INTO the pencil's travel (directional tooth).
    float face  = clamp(-dot(N.xy, tangent) * 2.0, 0.0, 1.0);
    float basis = mix(g, mix(g, face, 0.7), uSurface); // isotropic peaks -> directional catch
    float deposit = mix(1.0 - uInkGrain, 1.0, basis);

    float a = ink.a * deposit;
    vec3 col = rgb * mix(1.0 - 0.25 * uInkGrain, 1.0, basis);
    finalColor = vec4(col * a, a);
  }
}
`

export interface PaperGrainParams {
  grainScale: number
  grainContrast: number
  paperColor: [number, number, number]
  useTexture: number
  anchor: number   // 0 world, 1 screen
  octaves: number  // 0 single, 1 fractal
  showGrain: number
  mode: number     // 0 paper background, 1 graphite-in-stroke
  inkGrain: number // 0..1 stroke breakup (mode 1)
  surface: number  // 0 flat, 1 height->normal lighting + directional tooth
  lightDir: [number, number] // cos,sin of the raking light angle
  bumpStrength: number
  lightStrength: number
}

export const PAPER_GRAIN_DEFAULTS: PaperGrainParams = {
  grainScale: 40,         // world units per texture tile (larger = less obvious tiling)
  grainContrast: 0.7,
  paperColor: [0.957, 0.945, 0.918], // #f4f1ea
  useTexture: 1,
  anchor: 0,
  octaves: 1,
  showGrain: 0,
  mode: 0,
  inkGrain: 0.55,
  surface: 0,
  lightDir: [-0.707, 0.707], // 135° raking
  bumpStrength: 3,
  lightStrength: 0.8,
}

export class PaperGrainFilter extends Filter {
  constructor(p: PaperGrainParams = PAPER_GRAIN_DEFAULTS) {
    const grainUniforms = new UniformGroup({
      uWorldMatrix:  { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), type: 'mat3x3<f32>' },
      uZoom:         { value: 1.0,             type: 'f32' },
      uGrainScale:   { value: p.grainScale,    type: 'f32' },
      uGrainContrast:{ value: p.grainContrast, type: 'f32' },
      uPaperColor:   { value: new Float32Array(p.paperColor), type: 'vec3<f32>' },
      uUseTexture:   { value: p.useTexture,    type: 'f32' },
      uAnchor:       { value: p.anchor,        type: 'f32' },
      uOctaves:      { value: p.octaves,       type: 'f32' },
      uShowGrain:    { value: p.showGrain,     type: 'f32' },
      uMode:         { value: p.mode,          type: 'f32' },
      uInkGrain:     { value: p.inkGrain,      type: 'f32' },
      uSurface:      { value: p.surface,       type: 'f32' },
      uLightDir:     { value: new Float32Array(p.lightDir), type: 'vec2<f32>' },
      uBumpStrength: { value: p.bumpStrength,  type: 'f32' },
      uLightStrength:{ value: p.lightStrength, type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAG }),
      resources: {
        grainUniforms,
        uPaperTex: Texture.WHITE.source, // placeholder until a real texture is set
      },
    })
  }

  /** Bind the paper/graphite texture. Its source should have addressMode 'repeat'. */
  setPaperTexture(source: TextureSource): void {
    ;(this.resources as any).uPaperTex = source
  }

  /** Call every frame the camera moves. cam in screen px. */
  setCamera(camX: number, camY: number, zoom: number): void {
    const iz = 1 / zoom
    const u = (this.resources.grainUniforms as any).uniforms
    u.uWorldMatrix = new Float32Array([iz, 0, 0, 0, iz, 0, -camX * iz, -camY * iz, 1])
    u.uZoom = zoom
  }

  setParams(p: Partial<PaperGrainParams>): void {
    const u = (this.resources.grainUniforms as any).uniforms
    if (p.grainScale !== undefined) u.uGrainScale = p.grainScale
    if (p.grainContrast !== undefined) u.uGrainContrast = p.grainContrast
    if (p.paperColor !== undefined) u.uPaperColor = new Float32Array(p.paperColor)
    if (p.useTexture !== undefined) u.uUseTexture = p.useTexture
    if (p.anchor !== undefined) u.uAnchor = p.anchor
    if (p.octaves !== undefined) u.uOctaves = p.octaves
    if (p.showGrain !== undefined) u.uShowGrain = p.showGrain
    if (p.mode !== undefined) u.uMode = p.mode
    if (p.inkGrain !== undefined) u.uInkGrain = p.inkGrain
    if (p.surface !== undefined) u.uSurface = p.surface
    if (p.lightDir !== undefined) u.uLightDir = new Float32Array(p.lightDir)
    if (p.bumpStrength !== undefined) u.uBumpStrength = p.bumpStrength
    if (p.lightStrength !== undefined) u.uLightStrength = p.lightStrength
  }
}
