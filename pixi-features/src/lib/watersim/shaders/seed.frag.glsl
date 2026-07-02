#version 300 es
// SEED pass — writes the initial sim state from the silhouette SDF.
// One program, two targets selected by uTarget:
//   uTarget 0 -> STATE  texture: R=vel.u, G=vel.v, B=water h, A=spare
//   uTarget 1 -> PIGMENT texture: R=gGreen(suspended), G=dGreen(deposited)=0,
//                                 B=gWarm(suspended blooms), A=dWarm(deposited)=0
// uSdf: R=sdfN (0 edge -> 1 interior), G=rim, A=inside coverage (1 inside).
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uSdf;
uniform float uSeed;      // per-instance seed
uniform float uTarget;    // 0 = state, 1 = pigment
uniform float uWater;     // base initial water level
uniform float uPigment;   // base initial suspended green concentration
uniform float uBloomAmt;  // warm bloom strength

// --- compact simplex + fbm (Ashima, MIT) ---
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
float fbm(vec2 p, int oct){ float s=0.0,a=0.5,f=1.0; for(int i=0;i<6;i++){ if(i>=oct)break; s+=a*snoise(p*f); f*=2.0; a*=0.5;} return s; }
float hash1(float x){ return fract(sin(x*12.9898)*43758.5453); }

void main(){
  vec4 sdf = texture(uSdf, vUV);
  float inside = sdf.a;              // 1 inside the silhouette
  if(inside < 0.5){ finalColor = vec4(0.0); return; }
  float sp = hash1(uSeed) * 100.0;

  if(uTarget < 0.5){
    // STATE: no initial velocity; water roughly uniform with gentle per-seed lumpiness
    float lump = 0.85 + 0.15 * (fbm(vUV*3.0 + sp, 3) * 0.5 + 0.5);
    float h = uWater * lump;
    finalColor = vec4(0.0, 0.0, h, 0.0);
  } else {
    // PIGMENT: suspended green with paper-scale variation + a couple of warm bloom blobs
    float g = uPigment * (0.75 + 0.5 * (fbm(vUV*4.0 + sp + 7.0, 3) * 0.5 + 0.5));
    // 2 seeded warm blobs at off-centre anchors -> emergent warm blooms
    float warm = 0.0;
    for(int k=0;k<2;k++){
      float fk = float(k);
      float ang = hash1(sp + fk*3.7) * 6.283;
      float rad = 0.14 + 0.20 * hash1(sp + fk*9.1);
      vec2 c = vec2(0.5) + rad * vec2(cos(ang), sin(ang));
      float br = 0.10 + 0.10 * hash1(sp + fk*13.3);
      float d = length(vUV - c);
      warm += smoothstep(br, 0.0, d);
    }
    warm = clamp(warm, 0.0, 1.0) * uBloomAmt;
    finalColor = vec4(g, 0.0, warm, 0.0);
  }
}
