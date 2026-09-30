/**
 * シーンの単位はメートルで、実物の比率に合わせている（高さ 0.74m の机と 18 インチ CRT）。
 * 縮尺を合わせておくと、ライティングとカメラが自動的にしっくりくる。
 *
 * モニタ筐体の数値はすべてモニタグループのローカル座標。グループ自体は
 * [0, MONITOR_Y, MONITOR_Z] に置かれ、MONITOR_TILT だけ後ろへ傾いている。
 */

export const DESK_HEIGHT = 0.74
export const DESK_WIDTH = 1.36
export const DESK_DEPTH = 0.74
export const DESK_Z = -0.06

export const MONITOR_Y = DESK_HEIGHT
export const MONITOR_Z = -0.14
export const MONITOR_TILT = -0.045

/** ガラス。ブラウザのテクスチャを載せるメッシュ。 */
export const SCREEN_WIDTH = 0.335
export const SCREEN_HEIGHT = 0.251
export const SCREEN_SEGMENTS_X = 72
export const SCREEN_SEGMENTS_Y = 54
/** ガラスの四隅が中央からどれだけ後退するか（シーン単位）。 */
export const SCREEN_CURVATURE = 0.02

/** 各画面ソースの canvas 解像度（デバイス画素）。ブラウン管と同じ 4:3。 */
export const SCREEN_RESOLUTION_WIDTH = 960
export const SCREEN_RESOLUTION_HEIGHT = 720

export const MONITOR_BODY_WIDTH = 0.455
export const MONITOR_BODY_HEIGHT = 0.36
export const MONITOR_BODY_DEPTH = 0.4
/** 机から見た筐体の中心高さ。台座が 0 から画面開口部の下端までを埋める。 */
export const MONITOR_BODY_Y = 0.23/** Front face of the body slab. */
export const MONITOR_FRONT_Z = MONITOR_BODY_DEPTH / 2

/** ベゼルの開口部。ガラスが覗く穴。 */
export const SCREEN_OPENING_WIDTH = 0.345
export const SCREEN_OPENING_HEIGHT = 0.26

/** ガラスは筐体前面のすぐ手前、ベゼルバーはガラスのすぐ手前にある。 */
export const SCREEN_Z = MONITOR_FRONT_Z + 0.03
export const BEZEL_Z = MONITOR_FRONT_Z + 0.035

/**
 * ガラス中心のワールド座標。モニタグループが傾いているため、単純に
 * (0, MONITOR_Y + MONITOR_BODY_Y, MONITOR_Z + SCREEN_Z) にはならない（傾きが Y と Z を混ぜる）。
 */
export const SCREEN_WORLD_POSITION: [number, number, number] = (() => {
  const cos = Math.cos(MONITOR_TILT)
  const sin = Math.sin(MONITOR_TILT)
  return [
    0,
    MONITOR_Y + MONITOR_BODY_Y * cos - SCREEN_Z * sin,
    MONITOR_Z + MONITOR_BODY_Y * sin + SCREEN_Z * cos,
  ]
})()

/**
 * カメラはガラスの中央をちょうど見る。すると画面中心が viewport の中心に来るので、
 * レイキャストの座標変換を検証しやすくなる（viewport 中央の UV は必ず
 * (0.5, 0.5) になる）。
 */
export const CAMERA_TARGET: [number, number, number] = SCREEN_WORLD_POSITION

/**
 * 机と部屋が見える程度に引き、ブラウザの内容が読める程度に寄った位置。
 * 実際に操作するときはホイールで寄る。
 */
export const CAMERA_POSITION: [number, number, number] = [
  CAMERA_TARGET[0],
  CAMERA_TARGET[1] + 0.2,
  CAMERA_TARGET[2] + 0.82,
]
