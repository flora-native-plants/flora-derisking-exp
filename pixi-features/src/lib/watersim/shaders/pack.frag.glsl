#version 300 es
// PACK pass — combine the erosion-sim fields into the PIGMENT layout that the shared
// composite.frag.glsl already consumes:
//   out R=gGreen(suspended) G=dGreen(deposited) B=gWarm(suspended) A=dWarm(deposited)
// so the existing Kubelka-Munk + granulation + paper composite runs unchanged.
//
// uDebug>0.5 instead renders a grayscale view of the raw deposited (tide-line) buffer —
// used to eyeball whether crisp nested fronts actually formed BEFORE trusting the composite.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uA;        // R=wet G=susG B=susW
uniform sampler2D uAcc;      // R=depGreen G=depWarm
uniform sampler2D uSdf;      // A=inside
uniform float uDebug;
uniform float uDebugScale;

void main(){
  float inside = texture(uSdf, vUV).a;
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  vec4 a = texture(uA, vUV);
  vec4 acc = texture(uAcc, vUV);
  if(uDebug > 0.5){
    float g = clamp((acc.r + acc.g) * uDebugScale, 0.0, 1.0);
    finalColor = vec4(vec3(1.0 - g), inside);   // darker = more deposited pigment
    return;
  }
  finalColor = vec4(a.g, acc.r, a.b, acc.g);
}
