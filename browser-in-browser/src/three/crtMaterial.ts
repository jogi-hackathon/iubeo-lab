import * as THREE from 'three'

/**
 * ブラウン管の画面マテリアル。
 *
 * 意図的な判断が 2 つある:
 *
 *  1. **樽型の歪みは UV ではなくジオメトリで作る。** 画面メッシュは本当に曲面なの
 *     で、`raycaster.intersectObject().uv` が正確なままで、クリックは見た目どおり
 *     の位置に着く。シェーダで UV を歪めると、ポインタが動くたびに
 *     その逆関数を解く羽目になる。
 *  2. **生の ShaderMaterial ではなく MeshBasicMaterial + `onBeforeCompile`。**
 *     こうすると色管理（サンプリング時の `SRGB8_ALPHA8` デコードと、出力時の
 *     `<colorspace_fragment>`）を three に任せられるので、ブラウザの内容が
 *     実機のブラウザとまったく同じ見た目になる。
 *
 * それ以外（アパーチャーグリル、走査線、ブラウン管の減光、ガラスの映り込み、
 * 電源投入時のラスタ収縮、ポインタの目印）は `<map_fragment>` の後、線形空間で行う。
 */

export interface CrtUniforms {
  uTime: { value: number }
  /** 電源の立ち上がり 0..1。 */
  uOn: { value: number }
  /** 起動成功後のラスタ展開 0..1。 */
  uBoot: { value: number }
  /** ポインタ位置（UV）。x < 0 で目印を隠す。 */
  uCursor: { value: THREE.Vector2 }
  uCursorOn: { value: number }
  /** 供給元 canvas の画素サイズ。グリルの周期を安定させるために使う。 */
  uResolution: { value: THREE.Vector2 }
  uMask: { value: number }
  uScanline: { value: number }
}

const FRAGMENT_HEADER = /* glsl */ `
uniform float uTime;
uniform float uOn;
uniform float uBoot;
uniform vec2  uCursor;
uniform float uCursorOn;
uniform vec2  uResolution;
uniform float uMask;
uniform float uScanline;
`

// 以降の GLSL 本文は、このアプリで唯一英語のままにしてある。シェーダのソースは
// GPU ドライバに渡る文字列なので、非 ASCII を混ぜると環境によっては弾かれる。
// 設計の意図はすべて外側の TypeScript 側のコメントに日本語で書いてある。
const FRAGMENT_BODY = /* glsl */ `
  vec2 crtUv = vMapUv;
  vec2 crtC = crtUv - 0.5;
  float crtOn = clamp( uOn, 0.0, 1.0 );

  // Phosphor misalignment: red and blue land slightly wide of green, worst at the
  // edges of the tube.
  float crtAberr = 0.0024 * dot(crtC, crtC);
  vec3 crtCol;
  crtCol.r = texture2D( map, crtUv + crtC * crtAberr ).r;
  crtCol.g = texture2D( map, crtUv ).g;
  crtCol.b = texture2D( map, crtUv - crtC * crtAberr ).b;

  // Aperture grille (vertical triads) and scanlines (horizontal).
  //
  // The pitch follows the *screen*, not the texture: fwidth() gives UV units per device
  // pixel, so the mask stays at one cycle per two pixels at any zoom level. Without
  // this the mask is a fixed 960-cycle pattern that aliases into moire as soon as the
  // monitor is more than a metre away. Never let it get finer than the source texture.
  vec2 crtTexel = max( fwidth( crtUv ), vec2( 1.0 ) / uResolution );
  float crtGrille = 0.5 + 0.5 * sin( crtUv.x * 3.14159265 / crtTexel.x );
  crtCol *= 1.0 - uMask * 0.26 * crtGrille;

  float crtScan = 0.5 + 0.5 * sin( crtUv.y * 3.14159265 / crtTexel.y );
  crtCol *= 1.0 - uScanline * 0.30 * crtScan;

  // Tube falloff, plus a soft bloom so highlights bleed like a real phosphor.
  float crtR = length( crtC * vec2( 1.0, 0.88 ) ) * 1.34;
  float crtVig = 1.0 - smoothstep( 0.18, 1.0, crtR );
  crtCol *= mix( 0.62, 1.0, crtVig );
  crtCol += crtCol * crtVig * 0.18;

  // Phosphor response: mildly compressive, so a white page does not clip into flat
  // white and the mask keeps its contrast. This is what makes it read as a tube
  // rather than as a screenshot.
  crtCol = crtCol / ( 1.0 + crtCol * 0.22 );

  // Curved glass catching the room light. Strongest when the tube is dark.
  float crtSheen = 1.0 - smoothstep( 0.0, 0.95, length( crtC - vec2( -0.30, 0.36 ) ) );
  crtCol += vec3( 0.030, 0.036, 0.048 ) * crtSheen * mix( 1.0, 0.45, crtOn );

  // Power-on: the raster collapses to a line and expands back out.
  float crtTube = mix( 0.006, 1.0, clamp( uBoot, 0.0, 1.0 ) );
  float crtY = abs( crtC.y ) * 2.0;
  crtCol *= 1.0 - smoothstep( crtTube, crtTube + 0.012, crtY );

  // The bright edge of the expanding raster.
  float crtBand = abs( crtY - crtTube );
  crtCol += vec3( 0.65, 0.80, 1.0 ) * ( 1.0 - smoothstep( 0.0, 0.09, crtBand ) ) * ( 1.0 - crtTube ) * 1.7;

  // Raster noise while the tube settles.
  float crtNoise = fract( sin( dot( crtUv * uResolution + uTime * 13.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  crtCol += ( crtNoise - 0.5 ) * 0.13 * ( 1.0 - crtTube );

  // Power supply ramp, then a faint hum bar and the CRT's own flicker.
  crtCol *= crtOn;
  crtCol += vec3( 0.010, 0.012, 0.020 ) * ( 1.0 - crtOn );
  float crtHum = 0.5 + 0.5 * sin( crtUv.y * 7.0 + uTime * 0.7 );
  crtCol += vec3( 0.006 ) * crtHum * ( 1.0 - crtTube );
  crtCol *= 1.0 + 0.014 * sin( uTime * 43.0 ) * crtOn;

  // Pointer hotspot: the raycast position, so the browser and the eye agree.
  if ( uCursor.x >= 0.0 ) {
    vec2 crtD = ( crtUv - uCursor ) * ( uResolution / uResolution.y );
    float crtRing = 1.0 - smoothstep( 0.004, 0.012, abs( length( crtD ) - 0.021 ) );
    crtCol = mix( crtCol, vec3( 1.0 ) - crtCol * 0.65, crtRing * uCursorOn * 0.85 );
  }

  diffuseColor.rgb = crtCol;
`

export interface CrtMaterial {
  material: THREE.MeshBasicMaterial
  uniforms: CrtUniforms
  /** サンプリング対象を差し替える（画面ソースを切り替えたとき）。 */
  setTexture(texture: THREE.Texture, width: number, height: number): void
}

export function createCrtMaterial(
  texture: THREE.Texture,
  width: number,
  height: number,
): CrtMaterial {
  const uniforms: CrtUniforms = {
    uTime: { value: 0 },
    uOn: { value: 0 },
    uBoot: { value: 0 },
    uCursor: { value: new THREE.Vector2(-1, -1) },
    uCursorOn: { value: 0 },
    uResolution: { value: new THREE.Vector2(width, height) },
    uMask: { value: 0.55 },
    uScanline: { value: 0.7 },
  }

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    // Keep the browser content exactly as authored: no filmic curve on top of it.
    toneMapped: false,
    fog: false,
  })

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_BODY}`)
  }
  // Distinct cache key from every other MeshBasicMaterial in the scene.
  material.customProgramCacheKey = () => 'crt-screen'

  return {
    material,
    uniforms,
    setTexture(next, nextWidth, nextHeight) {
      material.map = next
      uniforms.uResolution.value.set(nextWidth, nextHeight)
      material.needsUpdate = true
    },
  }
}
