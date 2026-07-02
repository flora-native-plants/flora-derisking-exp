#version 300 es
// STRUCTURE-BLUR pass — separable Gaussian on the R channel. Run as a 2-pass H then V for
// each scale we need. The hybrid does TWO blurs of the same raw deposit:
//   NARROW radius (~2-3 texels) -> kills paper-pinning flecks, keeps tide-line-scale structure
//   WIDE   radius (~7 texels)   -> the broad soft wash mass
// A band-pass (narrow - wide) in structFinal then isolates the tide-line scale between the two.
// 9-tap Gaussian, radius scaled by uRadius. Baked once per instance, so tap count is free.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDir;      // (1,0) horizontal or (0,1) vertical
uniform float uRadius;  // blur radius in texels

void main(){
  vec4 c = texture(uSrc, vUV);
  if(c.a < 0.5){ finalColor = vec4(0.0); return; }
  // normalized 9-tap Gaussian weights (sigma ~ radius/2)
  const float w[5] = float[5](0.20236, 0.17954, 0.12578, 0.06972, 0.03052);
  float sum = c.r * w[0];
  float wsum = w[0];
  for(int i=1;i<5;i++){
    vec2 off = uDir * uTexel * (float(i) * uRadius * 0.25);
    vec4 sp = texture(uSrc, vUV + off);
    vec4 sn = texture(uSrc, vUV - off);
    // only accumulate in-silhouette taps so the blur does not drag paper (0) into the rim
    if(sp.a > 0.5){ sum += sp.r * w[i]; wsum += w[i]; }
    if(sn.a > 0.5){ sum += sn.r * w[i]; wsum += w[i]; }
  }
  finalColor = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, c.a);   // R=blurred, A=inside
}
