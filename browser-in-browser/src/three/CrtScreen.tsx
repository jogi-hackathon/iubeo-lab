import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { createCurvedScreenGeometry } from './curvedScreenGeometry'
import type { ScreenRuntime } from './screenRuntime'

/**
 * ガラス。役目は曲面ジオメトリを持ち、メッシュを runtime に渡すことだけ。
 * そうすれば `useScreenPointer` がそこへレイを飛ばせる。
 */
export function CrtScreen({
  runtime,
  position,
}: {
  runtime: ScreenRuntime
  position: [number, number, number]
}) {
  const geometry = useMemo(() => createCurvedScreenGeometry(), [])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => runtime.material.dispose(), [runtime.material])

  return (
    <mesh
      geometry={geometry}
      material={runtime.material}
      position={position}
      ref={(mesh: THREE.Mesh | null) => {
        runtime.mesh = mesh
      }}
    />
  )
}
