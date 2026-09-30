import * as THREE from 'three'
import { DESK_DEPTH, DESK_HEIGHT, DESK_WIDTH, DESK_Z, MONITOR_Z } from './dimensions'

const LAMP_X = -0.56
const LAMP_Z = DESK_Z - 0.16

/**
 * コンピュータの周り一式: 床、壁 2 面、机、キーボード、マウス、マグ、本、
 * デスクランプ。すべて手続き的でモデルもテクスチャも無いので、
 * シーン全体を 1 ファイルで見通せる。
 */
export function Room() {
  return (
    <group>
      <Floor />
      <Walls />
      <Desk />
      <Keyboard />
      <Mouse />
      <Mug />
      <Books />
      <DeskLamp />
    </group>
  )
}

function Floor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[8, 8]} />
      <meshStandardMaterial color="#4d3b2a" roughness={0.95} metalness={0} />
    </mesh>
  )
}

function Walls() {
  return (
    <group>
      <mesh position={[0, 1.5, -1.05]} receiveShadow>
        <planeGeometry args={[6, 3]} />
        <meshStandardMaterial color="#37333f" roughness={0.96} />
      </mesh>
      <mesh position={[-1.5, 1.5, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[6, 3]} />
        <meshStandardMaterial color="#312e39" roughness={0.96} />
      </mesh>
      {/* Skirting, so the wall/floor seam is not a hard line. */}
      <mesh position={[0, 0.05, -1.04]}>
        <boxGeometry args={[6, 0.1, 0.02]} />
        <meshStandardMaterial color="#2a2730" roughness={0.9} />
      </mesh>
    </group>
  )
}

function Desk() {
  const legHeight = DESK_HEIGHT - 0.04
  const legX = DESK_WIDTH / 2 - 0.06
  const legZ = DESK_DEPTH / 2 - 0.06

  return (
    <group>
      <mesh position={[0, DESK_HEIGHT - 0.02, DESK_Z]} castShadow receiveShadow>
        <boxGeometry args={[DESK_WIDTH, 0.04, DESK_DEPTH]} />
        <meshStandardMaterial color="#8a6642" roughness={0.62} metalness={0.02} />
      </mesh>

      {[
        [-legX, -legZ],
        [legX, -legZ],
        [-legX, legZ],
        [legX, legZ],
      ].map(([x, z], index) => (
        <mesh
          key={index}
          position={[x, legHeight / 2, DESK_Z + z]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.045, legHeight, 0.045]} />
          <meshStandardMaterial color="#6f5134" roughness={0.7} />
        </mesh>
      ))}

      <mesh position={[0, 0.42, DESK_Z - DESK_DEPTH / 2 + 0.05]} castShadow>
        <boxGeometry args={[DESK_WIDTH - 0.16, 0.46, 0.018]} />
        <meshStandardMaterial color="#7a5a3a" roughness={0.72} />
      </mesh>
    </group>
  )
}

function Keyboard() {
  const y = DESK_HEIGHT + 0.008
  const z = DESK_Z + 0.3
  return (
    <group position={[0, y, z]} rotation={[-0.03, 0, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.34, 0.016, 0.115]} />
        <meshStandardMaterial color="#d6d2cc" roughness={0.55} metalness={0.05} />
      </mesh>
      {[0, 1, 2, 3, 4].map((row) => (
        <mesh key={row} position={[0, 0.011, -0.04 + row * 0.02]}>
          <boxGeometry args={[0.3, 0.005, 0.014]} />
          <meshStandardMaterial color="#b9b4ad" roughness={0.6} />
        </mesh>
      ))}
    </group>
  )
}

function Mouse() {
  return (
    <mesh
      position={[0.25, DESK_HEIGHT + 0.014, DESK_Z + 0.26]}
      rotation={[0, -0.2, 0]}
      castShadow
    >
      <sphereGeometry args={[0.03, 20, 14]} />
      <meshStandardMaterial color="#d8d4cd" roughness={0.5} />
    </mesh>
  )
}

function Mug() {
  return (
    <group position={[0.46, DESK_HEIGHT, DESK_Z + 0.06]}>
      <mesh position={[0, 0.042, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.036, 0.032, 0.084, 24, 1, true]} />
        <meshStandardMaterial color="#c9d3dd" roughness={0.35} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.002, 0]}>
        <cylinderGeometry args={[0.032, 0.032, 0.004, 24]} />
        <meshStandardMaterial color="#b3bcc6" roughness={0.4} />
      </mesh>
      <mesh position={[0.045, 0.045, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[0.02, 0.005, 8, 20]} />
        <meshStandardMaterial color="#c9d3dd" roughness={0.35} />
      </mesh>
    </group>
  )
}

function Books() {
  const palette = ['#7a3f3f', '#3f5a7a', '#6b6b3f']
  return (
    <group position={[-0.5, DESK_HEIGHT, DESK_Z - 0.16]}>
      {palette.map((color, index) => (
        <mesh
          key={color}
          position={[index * 0.006, 0.015 + index * 0.03, index * 0.004]}
          rotation={[0, 0.06 * index, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[0.15 + index * 0.008, 0.03, 0.2]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
    </group>
  )
}

function DeskLamp() {
  return (
    <group position={[LAMP_X, DESK_HEIGHT, LAMP_Z]}>
      <mesh position={[0, 0.007, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.065, 0.07, 0.014, 24]} />
        <meshStandardMaterial color="#3a3a42" roughness={0.45} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.4, 12]} />
        <meshStandardMaterial color="#3a3a42" roughness={0.45} metalness={0.5} />
      </mesh>
      {/* Shade, tilted towards the desk. */}
      <mesh position={[0.075, 0.395, 0.075]} rotation={[0.62, 0, 0.5]} castShadow>
        <cylinderGeometry args={[0.028, 0.085, 0.11, 26, 1, true]} />
        <meshStandardMaterial color="#2f2f38" roughness={0.5} metalness={0.35} side={THREE.DoubleSide} />
      </mesh>
      {/* Bulb: the only warm light source in the room. */}
      <mesh position={[0.075, 0.37, 0.075]}>
        <sphereGeometry args={[0.022, 16, 12]} />
        <meshStandardMaterial
          color="#ffd9a3"
          emissive="#ffb469"
          emissiveIntensity={2.4}
          roughness={0.4}
        />
      </mesh>
      <pointLight
        position={[0.075, 0.35, 0.075]}
        color="#ffb469"
        intensity={0.22}
        distance={1.3}
        decay={2}
      />
    </group>
  )
}

/** シーンがキーライトを机へ向けるとき、再計算せずに済むよう輸出している。 */
export const KEY_LIGHT_TARGET: [number, number, number] = [0.1, DESK_HEIGHT, MONITOR_Z + 0.1]
