import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import type { CursorKind, ScreenSource } from '../screen/types'
import type { ScreenRuntime } from './screenRuntime'

interface Options {
  runtime: ScreenRuntime
  source: ScreenSource
  controls: React.RefObject<OrbitControlsImpl | null>
  /** 電源が切れている間は false。ポインタが何も掴まないようにする。 */
  enabled: boolean
  /** 最初のクリックで発火。ウィンドウ側がキーボードを引き取るため。 */
  onEngage: () => void
  /** ソースが望むカーソル形状と、レイがガラスに当たっているかを伝える。 */
  onCursor: (kind: CursorKind, onGlass: boolean) => void
}

/**
 * 3D 画面をポインタ面にする。
 *
 * R3F の合成イベントではなく、WebGL canvas に直接 DOM リスナーを付けている。
 * 理由は、R3F の合成イベントでは素直に得られないものが 3 つあるため:
 * メッシュの外へ出ても持続するポインタキャプチャ、`passive: false` の `wheel`、
 * そして OrbitControls をいつ動かしてよいかの直接制御。
 *
 * UV → canvas 画素に歪み補正は要らない。ガラスは曲面*ジオメトリ*なので、
 * レイキャストの UV がすでに曲面上の位置になっている
 * （curvedScreenGeometry.ts を参照）。
 */
export function useScreenPointer({
  runtime,
  source,
  controls,
  enabled,
  onEngage,
  onCursor,
}: Options): void {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)

  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const ndc = useMemo(() => new THREE.Vector2(), [])

  useEffect(() => {
    const canvas = gl.domElement
    let hovering = false
    let dragging = false
    let pointerDownAnywhere = false
    let capturedPointer: number | null = null

    const pick = (event: PointerEvent | WheelEvent): { x: number; y: number; uv: THREE.Vector2 } | null => {
      const mesh = runtime.mesh
      if (!mesh) return null
      runtime.picks.attempts += 1
      const rect = canvas.getBoundingClientRect()
      ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      camera.updateMatrixWorld()
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(mesh, false)[0]
      if (!hit?.uv) return null
      runtime.picks.hits += 1
      // テクスチャの V 軸は上向き、canvas の Y 軸は下向き。
      return {
        uv: hit.uv,
        x: hit.uv.x * source.width,
        y: (1 - hit.uv.y) * source.height,
      }
    }

    const modifiers = (event: PointerEvent | WheelEvent) => ({
      alt: event.altKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    })

    const setHovering = (next: boolean) => {
      if (hovering === next) return
      hovering = next
      if (!pointerDownAnywhere) {
        const orbit = controls.current
        if (orbit) orbit.enabled = !next
      }
      if (!next) {
        runtime.cursor.active = false
        onCursor('default', false)
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      pointerDownAnywhere = true
      if (!enabled) return
      const hit = pick(event)
      if (!hit) return

      event.preventDefault()
      dragging = true
      capturedPointer = event.pointerId
      canvas.setPointerCapture(event.pointerId)
      const orbit = controls.current
      if (orbit) orbit.enabled = false
      onEngage()

      runtime.cursor.x = hit.uv.x
      runtime.cursor.y = hit.uv.y
      runtime.cursor.active = true
      source.pointer({
        type: 'down',
        x: hit.x,
        y: hit.y,
        button: event.button,
        buttons: event.buttons,
        clickCount: event.detail || 1,
        modifiers: modifiers(event),
      })
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!enabled) return
      const hit = pick(event)
      if (!hit) {
        if (dragging) {
          // ボタンを押している間は直前の有効な座標を使い続ける。レイがガラスから
          // 外れてもドラッグが途切れないようにする。
          return
        }
        setHovering(false)
        return
      }

      runtime.cursor.x = hit.uv.x
      runtime.cursor.y = hit.uv.y
      runtime.cursor.active = true
      setHovering(true)
      onCursor(source.cursorKind(hit.x, hit.y), true)

      source.pointer({
        type: 'move',
        x: hit.x,
        y: hit.y,
        button: -1,
        buttons: event.buttons,
        clickCount: 0,
        modifiers: modifiers(event),
      })
    }

    const onPointerUp = (event: PointerEvent) => {
      pointerDownAnywhere = false
      if (dragging && capturedPointer === event.pointerId) {
        canvas.releasePointerCapture(event.pointerId)
        capturedPointer = null
        dragging = false
        if (enabled) {
          const hit = pick(event)
          source.pointer({
            type: 'up',
            x: hit ? hit.x : (runtime.cursor.x * source.width),
            y: hit ? hit.y : ((1 - runtime.cursor.y) * source.height),
            button: event.button,
            buttons: event.buttons,
            clickCount: event.detail || 1,
            modifiers: modifiers(event),
          })
        }
      }
      const orbit = controls.current
      if (orbit) orbit.enabled = !hovering
    }

    const onWheel = (event: WheelEvent) => {
      if (!enabled) return
      const hit = pick(event)
      if (!hit) return
      event.preventDefault()
      source.wheel(event.deltaX, event.deltaY, hit.x, hit.y, modifiers(event))
    }

    const onContextMenu = (event: MouseEvent) => {
      if (!enabled || !hovering) return
      event.preventDefault()
    }

    const onPointerLeave = () => setHovering(false)

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      const orbit = controls.current
      if (orbit) orbit.enabled = true
    }
  }, [camera, controls, enabled, gl, ndc, onCursor, onEngage, raycaster, runtime, source])
}
