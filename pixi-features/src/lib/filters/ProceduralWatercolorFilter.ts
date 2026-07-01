// src/lib/filters/ProceduralWatercolorFilter.ts
// Minimal stub for Task 3 GLSL compile spike.
// Task 4 will expand this into the full procedural watercolor filter.
import { Filter, GlProgram, defaultFilterVert } from 'pixi.js'
import { GLSL_SIMPLEX, GLSL_FBM } from '../watercolor/glslNoise'

// Spike fragment: simplex + fBm concatenated, outputs grayscale noise field.
// This proves the vendored GLSL compiles inside a Pixi v8 GlProgram (no #include resolver).
const SPIKE_FRAG = /* glsl */`
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

${GLSL_SIMPLEX}
${GLSL_FBM}

void main() {
  finalColor = vec4(vec3(fbm(vTextureCoord * 8.0, 4) * 0.5 + 0.5), 1.0);
}
`

/** Temporary spike filter — outputs fBm grayscale noise to prove GLSL compiles. */
export class ProceduralWatercolorFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: SPIKE_FRAG }),
      resources: {},
    })
  }
}
