#version 300 es
// STRUCTURE-FINAL pass — assemble the low-contrast structure map the static material path
// consumes. Two channels, deliberately gentle (Fable: "the sim emits LOW-CONTRAST structure
// only, fed into the static material path at gentle density"):
//   R = soft wash MASS  — the blurred deposited field, remapped into a narrow value band so
//       the fill-steps make large calm tonal masses, not a busy canopy mottle.
//   G = tide-line FRONTS — the crisp deposited total high-passed against the blurred mass
//       (a front is what sits ABOVE the local wash), rectified + soft-thresholded so only the
//       stronger nested fronts survive (not the full busy mottle) and every dark mark bounds a
//       tone by construction — no free-floating "crack" lines.
// IMPORTANT: work in the RAW (unclamped) deposit space. Clamping the deposit to [0,1] BEFORE
// the high-pass saturates dark regions and collapses the fronts to zero.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uWide;    // R = wide-blurred deposit (the soft wash mass)
uniform sampler2D uNarrow;  // R = narrow-blurred deposit (tide-line scale, flecks removed)
uniform float uMassLo, uMassHi;   // remap band for the wash mass (e.g. 0.22 .. 0.62)
uniform float uFrontGain;         // how strongly the band-passed fronts read
uniform float uMassContrast;      // 0=flat 0.5, 1=full swing
uniform float uFrontThresh;       // band-pass floor: only excursions above this become fronts

void main(){
  vec4 w = texture(uWide, vUV);
  if(w.a < 0.5){ finalColor = vec4(0.0); return; }
  float wide   = w.r;                    // broad wash mass (raw, ~0..1+)
  float narrow = texture(uNarrow, vUV).r; // tide-line-scale deposit (raw, ~0..1+)

  // MASS: pull toward the mid to soften mid-freq value swings, then remap into the narrow band.
  float massN = clamp(wide, 0.0, 1.0);
  massN = mix(0.5, massN, uMassContrast);          // 0 contrast -> flat 0.5, 1 -> full
  float mass = mix(uMassLo, uMassHi, massN);

  // FRONTS: BAND-PASS (narrow - wide) isolates coherent structure at the tide-line scale — above
  // the paper-fleck noise the narrow blur removed, below the broad mass the wide blur holds. Only
  // the raised (deposited) side is a front. Soft-thresholded so only the prominent arcs survive.
  float bp = max(narrow - wide, 0.0);
  float front = smoothstep(uFrontThresh, uFrontThresh + 0.10, bp) * clamp(bp * uFrontGain, 0.0, 1.0);

  finalColor = vec4(mass, front, 0.0, 1.0);
}
