#version 300 es
// Shared full-screen-quad vertex shader for every watercolor-sim pass.
// aPosition is clip-space (-1..1); aUV is 0..1 for sampling the ping-pong fields.
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
