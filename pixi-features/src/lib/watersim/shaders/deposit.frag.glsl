#version 300 es
// DEPOSIT pass (pass 2 of the receding-wet-mask variant).
//   ACC texture: R=depGreen, G=depWarm
// Trivial by design: the EROSION pass already wrote the per-step water-loss fraction into
// A.a, so the pigment stranded on the paper this step is simply the (old) suspended load
// times that fraction. This is the tide-line being laid down along the strip that just
// dried. No erosion math is duplicated here -> the two passes cannot drift apart.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uAold;     // A before this step: R=wet G=susG B=susW
uniform sampler2D uAnew;     // A after erosion:  A=lossFrac
uniform sampler2D uAcc;      // R=depGreen G=depWarm
uniform sampler2D uSdf;      // A=inside

void main(){
  if(texture(uSdf, vUV).a < 0.5){ finalColor = vec4(0.0); return; }
  float lossFrac = texture(uAnew, vUV).a;
  vec4 old = texture(uAold, vUV);
  vec4 acc = texture(uAcc, vUV);
  float addG = old.g * lossFrac;
  float addW = old.b * lossFrac;
  finalColor = vec4(acc.r + addG, acc.g + addW, 0.0, 0.0);
}
