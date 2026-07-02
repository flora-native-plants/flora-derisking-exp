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
uniform float uErode;        // front snap sharpness (how hard a released pixel recedes)
uniform float uEvapBase;     // guaranteed completion push near the end of the run
uniform float uPin;          // paper contribution to the release barrier (stick-slip)
uniform float uPaperScale;   // paper-height frequency (low -> few broad ridges/lines)
uniform float uLowScale;     // low-freq waterline waviness frequency
uniform float uLowAmp;       // waviness amplitude
uniform float uStep;         // global drying pressure this iteration (0..1, rises to 1)
uniform float uReleaseSoft;  // softness of the barrier->release transition
uniform float uDepthBias;    // how much interior (sdfN) resists -> front sweeps inward
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
  float sdfN = sdf.r;   // 0 at the rim -> 1 in the deep interior

  float wl = wetAt(vUV - vec2(uTexel.x, 0.0));
  float wr = wetAt(vUV + vec2(uTexel.x, 0.0));
  float wd = wetAt(vUV - vec2(0.0, uTexel.y));
  float wu = wetAt(vUV + vec2(0.0, uTexel.y));

  // Broad, low-freq paper ridges (few low-curvature lines) + a low-freq waterline wobble.
  float paper = fbm(vUV * uPaperScale + uSeed * 1.7, 3) * 0.5 + 0.5;   // 0..1 (broad ridges)
  float low   = fbm(vUV * uLowScale  + uSeed * 3.1, 3) * 0.5 + 0.5;    // 0..1

  // THRESHOLD DRYING FRONT (organic, grid-artifact-free).
  // Each pixel has a drying BARRIER; the global pressure uStep climbs 0->1 and a pixel dries
  // when uStep passes its barrier. The waterline is therefore the iso-contour barrier==uStep,
  // sweeping inward as uStep rises. The barrier is a SMOOTH field: interior depth (front
  // echoes the silhouette and sweeps inward), broad low-freq paper ridges (the front dwells
  // at ridges -> nested lines spaced by paper topology), a low-freq wobble, and seeded
  // interior WELLS (nuclei that dry early so their expanding dry zones COLLIDE with the edge
  // front == watershed tide-lines). Unlike a min-filter this has no Manhattan diamond; unlike
  // the effects path it is not drawn as uniform bands -- deposition (below) is weighted by the
  // ADVECTED pigment that piled at the front, so only some contours read as strong lines.
  float sp = fract(sin(uSeed * 12.9898) * 43758.5453) * 100.0;
  float barrier = uDepthBias * sdfN + uPin * paper + uLowAmp * (low - 0.5);
  for(int k = 0; k < 2; k++){
    float fk = float(k);
    float ang = fract(sin((sp + fk*4.7)) * 43758.5) * 6.283;
    float rad = 0.10 + 0.22 * fract(sin((sp + fk*8.3)) * 24634.6);
    vec2 c = vec2(0.5) + rad * vec2(cos(ang), sin(ang));
    float br = 0.14 + 0.12 * fract(sin((sp + fk*11.9)) * 15731.7);
    // heavily warped, shallow well: nucleates an interior front that collides with the edge
    // front (watershed line) WITHOUT punching a clean geometric light disc.
    float d = length(vUV - c) + 0.08 * fbm(vUV*4.0 + sp + fk*5.0, 3);
    barrier -= 0.22 * smoothstep(br, 0.0, d);
  }
  barrier = clamp(barrier, 0.02, 1.0);
  float driedTarget = 1.0 - smoothstep(barrier - uReleaseSoft, barrier + uReleaseSoft, uStep);
  float wetNext = min(wet, driedTarget);   // monotonic drying toward the sweeping front
  // guaranteed completion at the end of the run
  wetNext = min(wetNext, 1.0 - smoothstep(0.92, 1.0, uStep));
  wetNext = clamp(wetNext, 0.0, 1.0);

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

  // COFFEE-RING GATE: pigment strands where the contact line IS (|grad wet| high), not
  // uniformly as water leaves -- that is what turns smooth throughput into a crisp line.
  // As the (stick-slip) waterline recedes each step, successive lines nest. A cell that
  // just receded this step (wet dropped) AND sits on the waterline deposits the most; a
  // final settle dumps whatever is left once the cell goes bone dry.
  float wln = length(vec2(wr - wl, wu - wd));               // contact-line sharpness
  float onLine = clamp(wln * uFrontGain, 0.0, 1.0);
  float receded = clamp((wet - wetNext) * 40.0, 0.0, 1.0);  // did the line pass here now?
  float dryDump = (1.0 - smoothstep(0.0, uDryLevel, wetNext)) * uDryDump;
  float depFrac = clamp(onLine * receded * uDepRate + dryDump, 0.0, 1.0);

  // remove what deposits (approx conserve; DEPOSIT pass adds s.g/s.b * depFrac)
  float susGNext = max(0.0, susG - s.g * depFrac);
  float susWNext = max(0.0, susW - s.b * depFrac);

  // backrun: dump a pigment burst into the STILL-WET wash (a fresh drop landing) -> it gets
  // carried to and stranded at the next fronts == a bloom with its own ring. We do NOT force
  // a persistent re-wet (that leaves a stuck-wet light disc); a light, decaying nudge only.
  if(uReWetActive > 0.5){
    float d = length(vUV - uReWetC);
    float disc = smoothstep(uReWetRad, 0.0, d) * step(0.05, wetNext);  // only within wet paper
    susGNext += uReWetBurst * disc;
    wetNext = min(driedTarget, max(wetNext, 0.55 * disc));   // gentle, still bounded by drying
  }

  finalColor = vec4(wetNext, susGNext, susWNext, depFrac);
}
