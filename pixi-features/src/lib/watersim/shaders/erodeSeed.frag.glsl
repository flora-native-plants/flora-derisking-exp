#version 300 es
// EROSION-SIM SEED — initial fields for the receding-wet-mask variant.
//   uTarget 0 -> A texture: R=wetness, G=susGreen, B=susWarm, A=spare
//   uTarget 1 -> ACC texture (cleared to 0): R=depGreen, G=depWarm
// The wet mask starts near 1 in the interior and drier at the rim (sdfN low) so the
// drying front nucleates at the silhouette edge and recedes inward. A couple of seeded
// interior dry nuclei spawn extra fronts that collide with the edge front (watershed
// tide-lines). Suspended pigment starts as a paper-scale-varied green + warm bloom blobs.
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uSdf;     // R=sdfN (0 edge -> 1 interior), A=inside
uniform float uSeed;
uniform float uTarget;      // 0 = A, 1 = acc
uniform float uWaterEdge;   // wetness floor at the rim (edge dries first)
uniform float uPigment;     // base suspended green
uniform float uBloomAmt;    // warm bloom strength

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
float hash1(float x){ return fract(sin(x*12.9898)*43758.5453); }

void main(){
  vec4 sdf = texture(uSdf, vUV);
  float inside = sdf.a;
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  if(uTarget > 0.5){ finalColor = vec4(0.0); return; }   // acc starts empty

  float sp = hash1(uSeed) * 100.0;
  float sdfN = sdf.r;

  // wet mask: start (nearly) fully wet; the receding-front dynamics + interior barrier wells
  // (baked in the ERODE pass) drive all structure, so no dry nuclei are seeded here.
  float wet = 1.0;
  // a little large-scale lumpiness so the initial waterline is not perfectly radial
  wet *= 0.92 + 0.08 * (fbm(vUV*2.5 + sp, 3) * 0.5 + 0.5);
  wet = clamp(wet, 0.0, 1.0);

  // suspended green with paper-scale variation
  float g = uPigment * (0.7 + 0.6 * (fbm(vUV*4.0 + sp + 7.0, 3) * 0.5 + 0.5));
  // 2 warm bloom blobs
  float warm = 0.0;
  for(int k=0;k<2;k++){
    float fk = float(k);
    float ang = hash1(sp + fk*3.7 + 1.3) * 6.283;
    float rad = 0.14 + 0.20 * hash1(sp + fk*9.1 + 2.1);
    vec2 c = vec2(0.5) + rad * vec2(cos(ang), sin(ang));
    float br = 0.10 + 0.10 * hash1(sp + fk*13.3);
    float d = length(vUV - c);
    warm += smoothstep(br, 0.0, d);
  }
  warm = clamp(warm, 0.0, 1.0) * uBloomAmt;

  finalColor = vec4(wet, g, warm, 0.0);
}
