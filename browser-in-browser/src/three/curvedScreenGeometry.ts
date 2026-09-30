import * as THREE from 'three'
import {
  SCREEN_CURVATURE,
  SCREEN_HEIGHT,
  SCREEN_SEGMENTS_X,
  SCREEN_SEGMENTS_Y,
  SCREEN_WIDTH,
} from './dimensions'

/**
 * わずかに膨らんだ平面、つまりブラウン管のガラス。
 *
 * *ジオメトリ*を変位させる（シェーダで UV を歪めるのではなく）ことが、
 * クリックを正確に保つ理由。`Raycaster` はまさにこの曲面で `intersection.uv` を補間
 * するので、逆歪み補正なしでそのまま canvas 画素に対応する。
 */
export function createCurvedScreenGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(
    SCREEN_WIDTH,
    SCREEN_HEIGHT,
    SCREEN_SEGMENTS_X,
    SCREEN_SEGMENTS_Y,
  )

  const position = geometry.attributes.position as THREE.BufferAttribute
  const halfWidth = SCREEN_WIDTH / 2
  const halfHeight = SCREEN_HEIGHT / 2

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index) / halfWidth // -1..1
    const y = position.getY(index) / halfHeight // -1..1
    // 実物のブラウン管は中央が手前へ膨らみ、端へ向かって後退する。
    // 縦方向をやや強くすると、ブラウン管らしく見える。
    position.setZ(index, -SCREEN_CURVATURE * (0.55 * x * x + y * y))
  }

  position.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
