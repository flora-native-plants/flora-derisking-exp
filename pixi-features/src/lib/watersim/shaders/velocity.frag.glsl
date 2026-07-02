#version 300 es
// VELOCITY + WATER pass. Reads STATE (R=u,G=v,B=h,A=wetMax) + SDF, writes new STATE.
//
// The authentic structure comes from the DYNAMICS, not a static noise field:
//   - the edge evaporates faster (edgeBoost * (1-sdfN)) -> water height h sinks at the
//     rim -> grad(h) points inward -> accel = -grad(h) points OUTWARD -> pigment-laden
//     water flows toward the receding contact line == emergent coffee-ring / tide-line.
//   - a SUBTLE divergence-free curl-noise swirl adds organic wet-in-wet wander (kept small
//     on purpose; if it dominated we'd just reproduce the effects-path "veins" tell).
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uState;
uniform sampler2D uSdf;      // R=sdfN, G=rim, A=inside
uniform vec2  uTexel;        // 1/size
uniform float uSeed;
uniform float uIter;         // iteration index (drives curl drift)
uniform float uPressure;     // accel from water-height gradient
uniform float uDamp;         // velocity damping (viscosity)
uniform float uCurlAmp;      // curl-noise swirl amplitude
uniform float uCurlScale;    // curl-noise spatial frequency
uniform float uEvap;         // base evaporation per step
uniform float uEdgeEvap;     // extra evaporation weighting toward the edge
uniform float uCapillary;    // small water diffusion (wet-area creep)

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

float waterAt(vec2 uv){
  vec4 s = texture(uSdf, uv);
  if(s.a < 0.5) return 0.0;                 // dry paper outside the silhouette
  return texture(uState, uv).b;
}

void main(){
  vec4 sdf = texture(uSdf, vUV);
  float inside = sdf.a;
  if(inside < 0.5){ finalColor = vec4(0.0); return; }  // velocity 0 outside -> front stays on edge
  float sdfN = sdf.r;

  vec4 st = texture(uState, vUV);
  vec2 vel = st.xy;
  float h  = st.b;

  // central-difference water-height gradient (outside counts as h=0)
  float hl = waterAt(vUV - vec2(uTexel.x, 0.0));
  float hr = waterAt(vUV + vec2(uTexel.x, 0.0));
  float hd = waterAt(vUV - vec2(0.0, uTexel.y));
  float hu = waterAt(vUV + vec2(0.0, uTexel.y));
  vec2 gradH = vec2(hr - hl, hu - hd) * 0.5;

  // pressure accel drives water DOWNHILL (toward lower h == toward the drying edge)
  vec2 accel = -uPressure * gradH;

  // divergence-free curl swirl from a drifting scalar potential
  float t = uIter * 0.15;
  vec2 e = uTexel * 1.5;
  float pC = snoise(vUV*uCurlScale + uSeed + t);
  float pX = snoise((vUV+vec2(e.x,0.0))*uCurlScale + uSeed + t);
  float pY = snoise((vUV+vec2(0.0,e.y))*uCurlScale + uSeed + t);
  vec2 gradPsi = vec2(pX - pC, pY - pC);
  vec2 curl = uCurlAmp * vec2(gradPsi.y, -gradPsi.x);

  vec2 newVel = uDamp * (vel + accel) + curl;
  newVel *= inside;

  // capillary creep: tiny diffusion of water into neighbours before evaporation
  float hAvg = (hl + hr + hd + hu) * 0.25;
  float hDiff = mix(h, hAvg, uCapillary);

  // evaporation, biased to the thin rim (coffee-ring engine)
  float evap = uEvap * (1.0 + uEdgeEvap * (1.0 - sdfN));
  float newH = max(0.0, hDiff - evap);

  float wetMax = max(st.a, newH);
  finalColor = vec4(newVel, newH, wetMax);
}
