// src/lib/watercolor/sdfTexture.ts
import { Texture, BufferImageSource } from 'pixi.js'

/**
 * Pack a signed-distance Float32Array into a single-channel float Pixi texture.
 *
 * The plan specifies r16float, but r16float uses gl.HALF_FLOAT at the GL level and
 * rejects Float32Array data. We upload as r32float (gl.FLOAT) instead, which is the
 * correct format for Float32Array resources. r32float linear filtering requires
 * OES_texture_float_linear — which is available in all modern WebGL2 contexts.
 * Values are raw signed pixels; the shader divides by uSdfTexelWorldSize to convert.
 */
export function sdfToTexture(sdf: Float32Array, size: number): Texture {
  const source = new BufferImageSource({
    resource: sdf,
    width: size,
    height: size,
    format: 'r32float',
    scaleMode: 'linear',
    addressMode: 'clamp-to-edge',
  })
  return new Texture({ source })
}
