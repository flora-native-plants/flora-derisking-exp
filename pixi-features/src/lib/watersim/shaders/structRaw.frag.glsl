#version 300 es
// STRUCTURE-RAW pass — first stage of the HYBRID structure bake.
// Instead of running the erosion fields through the K-M composite (which "finishes" the
// pixels and overshoots into busy high-contrast mottle), we EXPORT the sim's raw structure
// so the static proceduralWatercolor material path can finish it at gentle density.
//   in : uAcc = R=depGreen G=depWarm   (deposited pigment == the tide-lines)
//   out: R = total deposited (crisp, pre-blur)   -> becomes both the mass source and,
//        after high-passing in structFinal, the front source. G mirrors R so the separable
//        blur can pass a crisp copy through untouched. A = inside (silhouette gate).
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uAcc;      // R=depGreen G=depWarm
uniform sampler2D uSdf;      // A=inside
uniform float uGain;         // scales deposited total into a workable 0..~1 range

void main(){
  float inside = texture(uSdf, vUV).a;
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  vec4 acc = texture(uAcc, vUV);
  float total = (acc.r + acc.g) * uGain;
  finalColor = vec4(total, total, 0.0, inside);
}
