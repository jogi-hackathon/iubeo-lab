import { useEffect, useMemo, useRef } from 'react'
import { extend, useFrame, useThree, type ThreeElement } from '@react-three/fiber'
import * as THREE from 'three'
import { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js'
import { Monitor } from './Monitor'
import { KEY_LIGHT_TARGET, Room } from './Room'
import { useScreenPointer } from './useScreenPointer'
import { CAMERA_TARGET, MONITOR_BODY_Y, MONITOR_Y, MONITOR_Z, SCREEN_Z } from './dimensions'
import type { ScreenRuntime } from './screenRuntime'
import type { CursorKind, ScreenSource, ScreenStatus } from '../screen/types'

// three のアドオンは R3F の組み込み JSX 一覧には無い。使うものを登録し、
// 生成される要素を TypeScript に教える。
extend({ OrbitControls: OrbitControlsImpl })

declare module '@react-three/fiber' {
  interface ThreeElements {
    orbitControls: ThreeElement<typeof OrbitControlsImpl>
  }
}

interface SceneProps {
  source: ScreenSource
  runtime: ScreenRuntime
  status: ScreenStatus
  onEngage: () => void
  onCursor: (kind: CursorKind, onGlass: boolean) => void
}

/** ブラウン管から机と使い手の顔へ漏れる光。 */
const GLOW_POSITION: [number, number, number] = [
  0,
  MONITOR_Y + MONITOR_BODY_Y,
  MONITOR_Z + SCREEN_Z + 0.1,
]

export function Scene({ source, runtime, status, onEngage, onCursor }: SceneProps) {
  const controls = useRef<OrbitControlsImpl | null>(null)
  const glow = useRef<THREE.PointLight>(null)

  const camera = useThree((state) => state.camera)
  const domElement = useThree((state) => state.gl.domElement)

  useEffect(() => {
    runtime.camera = camera
    return () => {
      runtime.camera = null
    }
  }, [camera, runtime])

  const interactive = status === 'ready' || status === 'booting'

  useScreenPointer({
    runtime,
    source,
    controls,
    enabled: interactive,
    onEngage,
    onCursor,
  })

  useFrame((_state, delta) => {
    // クランプする。背景タブやエンジンの停止でブラウン管の演出が飛ばないように。
    const dt = Math.min(delta, 0.05)
    runtime.update(source, dt)
    if (glow.current) {
      const power = runtime.uniforms.uBoot.value * runtime.uniforms.uOn.value
      glow.current.intensity = 0.05 + power * 0.5
    }
    // three の OrbitControls がカメラの向きを決めるのは update() の中だけ。
    // コンストラクタは target が原点のまま update() を呼び、以後誰も呼ばない
    // （drei のラッパーは毎フレーム呼んでくれるが、素のアドオンは呼ばない）。
    controls.current?.update()
  })

  return (
    <>
      <color attach="background" args={['#141118']} />
      <fog attach="fog" args={['#141118', 1.5, 5.2]} />

      {/*
        Lighting is physically based (three r155+ removed legacy lights), so the spot
        has to be sized for an inverse-square falloff with the 1/PI Lambert factor:
        radiance ~= intensity / (distance^2 * PI). ~5 cd lands the desk at a comfortable
        ~0.6 linear, and the hemisphere light lifts the walls out of pure black.
      */}
      <hemisphereLight args={['#8fa6c8', '#2b2117', 0.32]} />
      <ambientLight intensity={0.04} />
      <pointLight position={[-1.1, 1.5, 0.7]} color="#5f7396" intensity={0.6} distance={5} decay={2} />
      <KeyLight />

      <Room />
      <Monitor runtime={runtime} on={interactive} />

      <pointLight
        ref={glow}
        position={GLOW_POSITION}
        color="#a9c8ff"
        intensity={0}
        distance={1.3}
        decay={2}
      />

      <orbitControls
        ref={controls}
        args={[camera, domElement]}
        target={CAMERA_TARGET}
        enablePan={false}
        enableDamping
        dampingFactor={0.075}
        rotateSpeed={0.6}
        zoomSpeed={0.7}
        minDistance={0.3}
        maxDistance={1.6}
        minPolarAngle={0.75}
        maxPolarAngle={1.5}
        minAzimuthAngle={-0.75}
        maxAzimuthAngle={0.75}
      />
    </>
  )
}

/** 影を落とすキーライト 1 灯。机の中央を照らす。 */
function KeyLight() {
  const target = useMemo(() => new THREE.Object3D(), [])
  const light = useRef<THREE.SpotLight>(null)

  useEffect(() => {
    if (light.current) light.current.target = target
  }, [target])

  return (
    <>
      <primitive object={target} position={KEY_LIGHT_TARGET} />
      <spotLight
        ref={light}
        position={[0.78, 1.85, 0.86]}
        angle={0.95}
        penumbra={0.85}
        intensity={5}
        distance={6}
        decay={2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.012}
      />
    </>
  )
}
