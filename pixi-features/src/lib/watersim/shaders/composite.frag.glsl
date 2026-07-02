#version 300 es
// COMPOSITE pass — Kubelka-Munk of the deposited pigment over cream paper.
// K/S math + paper-through granulation lifted from proceduralWatercolor.frag.glsl
// (same pigmentKS K/S pairs, same kmReflectance + mix(paper,R,cover) structure) so we
// composite in scattering space, NOT Beer-Lambert (the inkwash mud dead-end).
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uPig;      // R=gGreen G=dGreen B=gWarm A=dWarm
uniform sampler2D uSdf;      // A=inside
uniform vec3  uKA, uSA, uKB, uSB, uPaperColor;
uniform float uDensity;      // overall pigment -> optical density scale
uniform float uCoverKnee;    // coverage opacity knee
uniform float uResidual;     // how much un-dried suspended pigment still shows
uniform float uSeed;
uniform float uGrainScale;

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
float fbm(vec2 p,int oct){ float s=0.0,a=0.5,f=1.0; for(int i=0;i<6;i++){ if(i>=oct)break; s+=a*snoise(p*f); f*=2.0; a*=0.5;} return s; }
float dither(vec2 xy){ return fract(sin(dot(xy, vec2(12.9898,78.233)))*43758.5453); }

vec3 kmReflectance(vec3 K, vec3 S){
  vec3 ks = K / max(S, vec3(1e-4));
  return clamp(1.0 + ks - sqrt(ks*ks + 2.0*ks), vec3(1e-4), vec3(1.0-1e-4));
}

void main(){
  float inside = texture(uSdf, vUV).a;
  if(inside < 0.5){ finalColor = vec4(0.0); return; }

  vec4 pig = texture(uPig, vUV);
  float densG = pig.g + pig.r * uResidual;   // deposited + residual suspended (green)
  float densW = pig.a + pig.b * uResidual;   // deposited + residual suspended (warm)
  float total = densG + densW;
  float m = clamp(densW / max(total, 1e-4), 0.0, 1.0);
  float dens = total * uDensity;

  vec3 K = mix(uKA, uKB, m) * dens;
  vec3 S = mix(uSA, uSB, m);
  vec3 R = kmReflectance(K, S);

  float grainHi = fbm(vUV * uGrainScale + uSeed, 2) * 0.5 + 0.5;
  float cover = clamp(dens / uCoverKnee, 0.0, 1.0);
  cover *= 1.0 - 0.30 * smoothstep(0.55, 0.9, grainHi);   // paper tooth shows through

  vec3 col = mix(uPaperColor, R, cover);
  col += (dither(gl_FragCoord.xy) - 0.5) / 255.0;
  finalColor = vec4(col, inside);
}
