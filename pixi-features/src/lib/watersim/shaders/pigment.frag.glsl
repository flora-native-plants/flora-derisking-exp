#version 300 es
// PIGMENT advect + deposit pass.
//   PIG  texture: R=gGreen(suspended), G=dGreen(deposited),
//                 B=gWarm(suspended),  A=dWarm(deposited)
// Suspended pigment is advected along the velocity field (semi-Lagrangian backtrace,
// MANUAL bilinear so we never depend on float-texture linear filtering). Deposited
// pigment is FIXED to the paper (read at the current texel, never backtraced).
// Deposition rate rises with paper "tooth" (granulation) and at the receding wet front
// (|grad h| high, or h nearly dry) -> pigment piles up as a dark tide-line == coffee ring.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uPig;
uniform sampler2D uState;    // R=u,G=v,B=h
uniform sampler2D uSdf;      // A=inside
uniform vec2  uTexel;
uniform float uSeed;
uniform float uAdvect;       // backtrace strength
uniform float uDepositG;     // green base deposition rate
uniform float uDepositW;     // warm base deposition rate
uniform float uGranule;      // paper-height granulation contrast
uniform float uPaperScale;   // paper noise frequency
uniform float uEdgeDeposit;  // extra deposition at the wet front (coffee-ring gain)
uniform float uDryWet;       // wetness below which pigment settles out

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

vec4 bilin(sampler2D t, vec2 uv){
  vec2 p = uv / uTexel - 0.5;
  vec2 f = fract(p);
  vec2 base = (floor(p) + 0.5) * uTexel;
  vec4 a = texture(t, base);
  vec4 b = texture(t, base + vec2(uTexel.x, 0.0));
  vec4 c = texture(t, base + vec2(0.0, uTexel.y));
  vec4 d = texture(t, base + uTexel);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float waterAt(vec2 uv){
  if(texture(uSdf, uv).a < 0.5) return 0.0;
  return texture(uState, uv).b;
}

void main(){
  if(texture(uSdf, vUV).a < 0.5){ finalColor = vec4(0.0); return; }

  vec4 pig = texture(uPig, vUV);       // deposited read here (fixed to paper)
  vec2 vel = texture(uState, vUV).xy;
  float h  = texture(uState, vUV).b;

  // semi-Lagrangian backtrace for suspended pigment
  vec2 srcUV = vUV - vel * uAdvect;
  vec4 back = bilin(uPig, srcUV);
  float gG = back.r;   // advected suspended green
  float gW = back.b;   // advected suspended warm
  float dG = pig.g;    // deposited green (stays put)
  float dW = pig.a;    // deposited warm

  // paper tooth -> granulation: pigment settles into the valleys
  float paper = fbm(vUV * uPaperScale + uSeed, 3) * 0.5 + 0.5;
  float paperFac = mix(1.0 - uGranule, 1.0 + uGranule, paper);

  // wet-front detector: |grad h| large == receding contact line
  float hl = waterAt(vUV - vec2(uTexel.x, 0.0));
  float hr = waterAt(vUV + vec2(uTexel.x, 0.0));
  float hd = waterAt(vUV - vec2(0.0, uTexel.y));
  float hu = waterAt(vUV + vec2(0.0, uTexel.y));
  float gmag = length(vec2(hr - hl, hu - hd));
  float frontBoost = 1.0 + uEdgeDeposit * clamp(gmag * 6.0, 0.0, 1.0);

  // drying multiplier: as water leaves, everything settles (=1 when bone dry)
  float dry = 1.0 - smoothstep(0.0, uDryWet, h);
  float settle = max(dry, 0.0);

  float rateG = clamp(uDepositG * paperFac * frontBoost + settle, 0.0, 1.0);
  float rateW = clamp(uDepositW * paperFac * frontBoost + settle, 0.0, 1.0);

  float depoG = gG * rateG;
  float depoW = gW * rateW;

  finalColor = vec4(gG - depoG, dG + depoG, gW - depoW, dW + depoW);
}
