#version 300 es
// EROSION pass (pass 1 of the receding-wet-mask variant).
//   A texture: R=wetness, G=susGreen, B=susWarm, A=lossFrac(out)
// The wet mask RECEDES as a propagating front: a pixel dries when a neighbour is drier
// (morphological erosion), but the advance is RESISTED by paper height -> the contact
// line STICK-SLIPS: it dwells at paper ridges (pinning) and jumps through valleys. While
// the front is stalled, suspended pigment is advected DOWN the wetness gradient (toward
// the front) and PILES; when the front finally crosses, that pile is stranded == a crisp,
// low-curvature tide-line following the (smooth, low-freq) paper ridge. Successive fronts
// are "yesterday's front minus a little recession", so the deposited rings are correlated
// and nested — the thing static iso-band noise cannot produce.
//
// Output A.a carries the per-step water-loss fraction so the DEPOSIT pass is trivial and
// cannot drift out of sync with this pass's erosion math.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uA;        // R=wet G=susG B=susW
uniform sampler2D uSdf;      // R=sdfN A=inside
uniform vec2  uTexel;
uniform float uSeed;
uniform float uErode;        // front recession speed
uniform float uEvapBase;     // uniform evaporation floor (guarantees completion)
uniform float uPin;          // paper-ridge pinning strength (0..1)
uniform float uPaperScale;   // paper-height frequency (low -> few broad ridges/lines)
uniform float uLowScale;     // low-freq waterline waviness frequency
uniform float uLowAmp;       // waviness amplitude
uniform float uAdvect;       // suspended advection toward the front
uniform float uDiffuse;      // suspended diffusion within the wet region
uniform float uDryLevel;     // wetness below which remaining pigment dumps
uniform float uFrontGain;    // scales |grad wet| -> a 0..1 "on the waterline" mask
uniform float uDepRate;      // pigment fraction stranded at the waterline each step
uniform float uDryDump;      // pigment fraction dumped once a cell goes bone dry
uniform float uReWetActive;  // 1.0 on a backrun step
uniform vec2  uReWetC;       // backrun disc centre (uv)
uniform float uReWetRad;     // backrun disc radius (uv)
uniform float uReWetBurst;   // suspended pigment re-injected by the backrun

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
// wetness at uv, treating outside-silhouette as bone dry (front pins to the edge)
float wetAt(vec2 uv){
  if(texture(uSdf, uv).a < 0.5) return 0.0;
  return texture(uA, uv).r;
}

void main(){
  vec4 sdf = texture(uSdf, vUV);
  if(sdf.a < 0.5){ finalColor = vec4(0.0); return; }

  vec4 s = texture(uA, vUV);
  float wet = s.r;

  float wl = wetAt(vUV - vec2(uTexel.x, 0.0));
  float wr = wetAt(vUV + vec2(uTexel.x, 0.0));
  float wd = wetAt(vUV - vec2(0.0, uTexel.y));
  float wu = wetAt(vUV + vec2(0.0, uTexel.y));
  float wetMin = min(min(wl, wr), min(wd, wu));

  // paper ridges (broad, low-freq -> few, low-curvature tide-lines) and waterline waviness
  float paper = fbm(vUV * uPaperScale + uSeed * 1.7, 4) * 0.5 + 0.5;   // 0..1
  float low   = fbm(vUV * uLowScale  + uSeed * 3.1, 3) * 0.5 + 0.5;    // 0..1

  // stick-slip recession: resisted at ridges (pin), waved by low noise.
  float resist = uPin * paper;
  float front = max(0.0, wet - wetMin);                 // >0 if a neighbour is drier
  float wave  = 1.0 - uLowAmp + 2.0 * uLowAmp * low;    // ~[1-amp, 1+amp]
  float drop  = (uErode * front + uEvapBase) * (1.0 - resist) * wave;
  float wetNext = clamp(wet - drop, 0.0, 1.0);

  // advect suspended pigment toward the front (down the wetness gradient) + diffuse
  vec2 gradW = vec2(wr - wl, wu - wd) * 0.5;
  vec2 vel = -uAdvect * gradW;
  vec4 back = bilin(uA, vUV - vel);
  float diffG = (texture(uA, vUV-vec2(uTexel.x,0.0)).g + texture(uA, vUV+vec2(uTexel.x,0.0)).g
               + texture(uA, vUV-vec2(0.0,uTexel.y)).g + texture(uA, vUV+vec2(0.0,uTexel.y)).g) * 0.25;
  float diffW = (texture(uA, vUV-vec2(uTexel.x,0.0)).b + texture(uA, vUV+vec2(uTexel.x,0.0)).b
               + texture(uA, vUV-vec2(0.0,uTexel.y)).b + texture(uA, vUV+vec2(0.0,uTexel.y)).b) * 0.25;
  float susG = mix(back.g, diffG, uDiffuse);
  float susW = mix(back.b, diffW, uDiffuse);

  // fraction of this cell's water that left this step (+ full dump once nearly dry)
  float lossFrac = clamp((wet - wetNext) / max(wet, 1e-3), 0.0, 1.0);
  float dryDump = 1.0 - smoothstep(0.0, uDryLevel, wetNext);
  lossFrac = max(lossFrac, dryDump);

  // remove what deposits (approx conserve; DEPOSIT pass adds s.g/s.b * lossFrac)
  float susGNext = max(0.0, susG - s.g * lossFrac);
  float susWNext = max(0.0, susW - s.b * lossFrac);

  // backrun: re-wet a disc + re-inject pigment -> a fresh nested ring when it re-dries
  if(uReWetActive > 0.5){
    float d = length(vUV - uReWetC);
    float disc = smoothstep(uReWetRad, 0.0, d);
    wetNext = max(wetNext, 0.9 * disc);
    susGNext += uReWetBurst * disc;
  }

  finalColor = vec4(wetNext, susGNext, susWNext, lossFrac);
}
