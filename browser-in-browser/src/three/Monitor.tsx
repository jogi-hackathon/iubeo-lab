import * as THREE from 'three'
import {
  BEZEL_Z,
  MONITOR_BODY_DEPTH,
  MONITOR_BODY_HEIGHT,
  MONITOR_BODY_WIDTH,
  MONITOR_BODY_Y,
  MONITOR_FRONT_Z,
  MONITOR_TILT,
  MONITOR_Y,
  MONITOR_Z,
  SCREEN_OPENING_HEIGHT,
  SCREEN_OPENING_WIDTH,
  SCREEN_Z,
} from './dimensions'
import { CrtScreen } from './CrtScreen'
import type { ScreenRuntime } from './screenRuntime'

const BEZEL_BAR_WIDTH = (MONITOR_BODY_WIDTH - SCREEN_OPENING_WIDTH) / 2
const BEZEL_BAR_HEIGHT = (MONITOR_BODY_HEIGHT - SCREEN_OPENING_HEIGHT) / 2
const BEZEL_BAR_DEPTH = 0.03

const SHELL = '#d3ccbe'
const SHELL_DARK = '#a89e8c'
const TRIM = '#2b2723'
/** ガラスとベゼルの間の暗い彫り込み。 */
const RECESS = '#232028'

/**
 * 手続き的に組んだ 18 インチ CRT。外部モデルもテクスチャも使わず、直方体と
 * 円柱と曲面ガラスだけで作る。筐体は 1 枚の板で、その前面に 4 本のベゼルを
 * 貼るので「画面の穴」にブーリアン演算は要らない。
 */
export function Monitor({
  runtime,
  on,
}: {
  runtime: ScreenRuntime
  on: boolean
}) {
  return (
    <group position={[0, MONITOR_Y, MONITOR_Z]} rotation={[MONITOR_TILT, 0, 0]}>
      {/* Main slab; its front face is at +MONITOR_BODY_DEPTH / 2. */}
      <mesh position={[0, MONITOR_BODY_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[MONITOR_BODY_WIDTH, MONITOR_BODY_HEIGHT, MONITOR_BODY_DEPTH]} />
        <meshStandardMaterial color={SHELL} roughness={0.74} metalness={0.04} />
      </mesh>

      {/* Tapered rear that hides the tube. */}
      <mesh position={[0, MONITOR_BODY_Y, -0.33]} castShadow receiveShadow>
        <boxGeometry args={[0.4, 0.31, 0.26]} />
        <meshStandardMaterial color={SHELL_DARK} roughness={0.82} metalness={0.03} />
      </mesh>

      {/* Bezel bars framing the opening. */}
      <BezelBar
        position={[0, MONITOR_BODY_Y + SCREEN_OPENING_HEIGHT / 2 + BEZEL_BAR_HEIGHT / 2, BEZEL_Z]}
        size={[MONITOR_BODY_WIDTH, BEZEL_BAR_HEIGHT, BEZEL_BAR_DEPTH]}
      />
      <BezelBar
        position={[0, MONITOR_BODY_Y - SCREEN_OPENING_HEIGHT / 2 - BEZEL_BAR_HEIGHT / 2, BEZEL_Z]}
        size={[MONITOR_BODY_WIDTH, BEZEL_BAR_HEIGHT, BEZEL_BAR_DEPTH]}
      />
      <BezelBar
        position={[-(SCREEN_OPENING_WIDTH / 2 + BEZEL_BAR_WIDTH / 2), MONITOR_BODY_Y, BEZEL_Z]}
        size={[BEZEL_BAR_WIDTH, SCREEN_OPENING_HEIGHT, BEZEL_BAR_DEPTH]}
      />
      <BezelBar
        position={[SCREEN_OPENING_WIDTH / 2 + BEZEL_BAR_WIDTH / 2, MONITOR_BODY_Y, BEZEL_Z]}
        size={[BEZEL_BAR_WIDTH, SCREEN_OPENING_HEIGHT, BEZEL_BAR_DEPTH]}
      />

      {/* Dark recess where the glass meets the bezel. Without it the tube reads as a
          sticker on a light box. */}
      <BezelBar
        color={RECESS}
        position={[0, MONITOR_BODY_Y + SCREEN_OPENING_HEIGHT / 2 - 0.004, MONITOR_FRONT_Z + 0.012]}
        size={[SCREEN_OPENING_WIDTH, 0.009, 0.028]}
      />
      <BezelBar
        color={RECESS}
        position={[0, MONITOR_BODY_Y - SCREEN_OPENING_HEIGHT / 2 + 0.004, MONITOR_FRONT_Z + 0.012]}
        size={[SCREEN_OPENING_WIDTH, 0.009, 0.028]}
      />
      <BezelBar
        color={RECESS}
        position={[-(SCREEN_OPENING_WIDTH / 2 - 0.004), MONITOR_BODY_Y, MONITOR_FRONT_Z + 0.012]}
        size={[0.009, SCREEN_OPENING_HEIGHT, 0.028]}
      />
      <BezelBar
        color={RECESS}
        position={[SCREEN_OPENING_WIDTH / 2 - 0.004, MONITOR_BODY_Y, MONITOR_FRONT_Z + 0.012]}
        size={[0.009, SCREEN_OPENING_HEIGHT, 0.028]}
      />

      {/* The tube itself: this is the mesh the raycaster and the shader care about. */}
      <CrtScreen runtime={runtime} position={[0, MONITOR_BODY_Y, SCREEN_Z]} />

      {/* Power LED on the bezel. */}
      <mesh position={[0.17, MONITOR_BODY_Y - SCREEN_OPENING_HEIGHT / 2 - BEZEL_BAR_HEIGHT / 2, BEZEL_Z + 0.016]}>
        <sphereGeometry args={[0.0055, 12, 12]} />
        <meshStandardMaterial
          color={on ? '#7dffa8' : '#2c3a2f'}
          emissive={on ? '#4dff8f' : '#0d1a10'}
          emissiveIntensity={on ? 3.2 : 0.25}
          roughness={0.3}
        />
      </mesh>

      {/* Vent slots along the top of the shell. */}
      {[0, 1, 2, 3, 4].map((index) => (
        <mesh
          key={index}
          position={[0, MONITOR_BODY_Y + MONITOR_BODY_HEIGHT / 2 + 0.001, -0.02 - index * 0.03]}
        >
          <boxGeometry args={[0.3, 0.004, 0.012]} />
          <meshStandardMaterial color={TRIM} roughness={0.9} />
        </mesh>
      ))}

      {/* Pedestal. */}
      <mesh position={[0, 0.03, -0.03]} castShadow>
        <cylinderGeometry args={[0.035, 0.045, 0.07, 20]} />
        <meshStandardMaterial color={SHELL_DARK} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.011, 0.005]} castShadow receiveShadow>
        <boxGeometry args={[0.26, 0.022, 0.2]} />
        <meshStandardMaterial color={SHELL} roughness={0.76} />
      </mesh>
    </group>
  )
}

function BezelBar({
  position,
  size,
  color = SHELL_DARK,
}: {
  position: [number, number, number]
  size: [number, number, number]
  color?: string
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.68} metalness={0.04} />
    </mesh>
  )
}

/** シーンが画面の漏れ光の色を決められるように再輸出している。 */
export const SCREEN_GLOW = new THREE.Color('#a9c8ff')
