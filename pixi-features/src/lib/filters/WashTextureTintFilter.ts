import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js'

/**
 * Turns a white-background AI watercolor texture into tinted, transparent pigment.
 *
 * The generators can't emit alpha, so the source wash is dark pigment on white
 * paper. Here: luminance -> alpha (white becomes transparent), and the surviving
 * pigment is tinted to the plant colour. Denser (darker) wash reads as a deeper,
 * more saturated deposit — the "edge darkening" watercolour tell — so the texture's
 * own organic structure drives where pigment pools.
 *
 * Apply to a Sprite/TilingSprite of the wash texture, then mask that sprite with a
 * softened silhouette so the wash bleeds past the plant's crisp edge.
 */

const DEFAULT_TINT: [number, number, number] = [0.298, 0.686, 0.314] // Red Maple #4CAF50

const WASH_FRAG = `
precision highp float;

in  vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;

uniform vec3  uTint;       // pigment colour, linear 0..1
uniform float uStrength;   // overall opacity (wetness)
uniform float uPaperCut;   // luminance below this counts as "paper" -> transparent

void main() {
  vec4 src = texture(uTexture, vTextureCoord);
  // Filter input is premultiplied; un-premultiply to read true colour.
  vec3 rgb = src.a > 0.001 ? src.rgb / src.a : src.rgb;

  float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
  float pig = 1.0 - lum;                              // white paper -> 0, pigment -> 1

  float a = smoothstep(uPaperCut, uPaperCut + 0.45, pig) * uStrength;

  // Edge darkening: thicker pigment deposits deeper / slightly darker tint.
  vec3 col = mix(uTint * 1.12, uTint * 0.62, clamp(pig, 0.0, 1.0));

  finalColor = vec4(col * a, a);
}
`

export class WashTextureTintFilter extends Filter {
  private group: UniformGroup

  constructor(tint: [number, number, number] = DEFAULT_TINT, strength = 0.85, paperCut = 0.04) {
    const group = new UniformGroup({
      uTint:     { value: new Float32Array(tint), type: 'vec3<f32>' },
      uStrength: { value: strength,               type: 'f32' },
      uPaperCut: { value: paperCut,               type: 'f32' },
    })
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: WASH_FRAG }),
      resources: { washUniforms: group },
    })
    this.group = group
  }

  setTint(tint: [number, number, number]) {
    (this.group.uniforms.uTint as Float32Array).set(tint)
  }
  setStrength(v: number) { this.group.uniforms.uStrength = v }
  setPaperCut(v: number) { this.group.uniforms.uPaperCut = v }
}
