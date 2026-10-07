import * as THREE from 'three'
import type { ScreenSource } from '../screen/types'
import { createCrtMaterial, type CrtUniforms } from './crtMaterial'

/**
 * 画面サーフェスについて可変なものすべて。シーンが所有し、メッシュ・毎フレームの
 * アニメーション・ポインタ操作の間で共有する。
 */
export interface ScreenRuntime {
  readonly material: THREE.MeshBasicMaterial
  readonly uniforms: CrtUniforms
  mesh: THREE.Mesh | null
  /**
   * 画面を見ているカメラ。シーンが設定する。devtools からレイキャストを
   * いじるときにもこれを触る。
   */
  camera: THREE.Camera | null
  /**
   * レイキャストの回数。「ポインタがガラスに届いていない」のか「届いたが外れた」
   * のかを最速で切り分けるための安価な計測。
   */
  readonly picks: { attempts: number; hits: number }
  /** ポインタ位置（UV）と、いまレイがガラスに当たっているか。 */
  cursor: { x: number; y: number; active: boolean }
  /** 画面ソースを切り替えたときにテクスチャを結び直す。 */
  setSource(source: ScreenSource): void
  /** ソースのアニメーションを進め、テクスチャを更新し、ブラウン管の演出を動かす。 */
  update(source: ScreenSource, dt: number): void
}

const approach = (current: number, target: number, rate: number): number =>
  current + (target - current) * (1 - Math.exp(-rate))

export function createScreenRuntime(source: ScreenSource): ScreenRuntime {
  const crt = createCrtMaterial(source.texture, source.width, source.height)
  let bound = source

  const runtime: ScreenRuntime = {
    material: crt.material,
    uniforms: crt.uniforms,
    mesh: null,
    camera: null,
    picks: { attempts: 0, hits: 0 },
    cursor: { x: 0, y: 0, active: false },

    setSource(next) {
      if (next === bound) return
      bound = next
      crt.setTexture(next.texture, next.width, next.height)
      // 選び直した機械は、前の絵ではなく黒から立ち上がる。
      crt.uniforms.uBoot.value = 0
      runtime.cursor.active = false
    },

    update(active, dt) {
      const uniforms = crt.uniforms
      uniforms.uTime.value += dt

      const isOn = active.status === 'ready' || active.status === 'booting'
      uniforms.uOn.value = approach(uniforms.uOn.value, isOn ? 1 : 0, 5)
      uniforms.uBoot.value = approach(uniforms.uBoot.value, active.status === 'ready' ? 1 : 0, 2.4)

      uniforms.uCursor.value.set(
        runtime.cursor.active ? runtime.cursor.x : -1,
        runtime.cursor.active ? runtime.cursor.y : 0,
      )
      uniforms.uCursorOn.value = approach(uniforms.uCursorOn.value, runtime.cursor.active ? 1 : 0, 9)

      // ソースを動かし（カーソル点滅、エンジンのフレーム供給）、変化があれば
      // その画素を GPU へ渡す。
      active.tick()
      // liveSurface（wasm エンジンの GPU モード）は向こうから dirty を立ててくれない
      // ので、毎フレーム読み直す。それ以外は dirty のときだけ。
      if (active.liveSurface || active.isDirty()) {
        active.texture.needsUpdate = true
        active.clearDirty()
      }
    },
  }

  return runtime
}
