/**
 * gecko.js の公開 API の型定義。
 *
 * 実体は `public/engine/gecko.js`（上流のビルド済みリリース）にあり、実行時に URL から
 * 動的 import する。ビルド時に型を得られないため、ここで手書きしている。
 * `npm run engine:link` は参照用に上流の `index.d.ts` も `public/engine/` へコピーするので、
 * API が変わったときは差分を確認できる。
 */

export interface FsStat {
  size: number
  isDir: boolean
  mtime?: number
}

/** gecko.data に焼かれていない GRE ファイルを供給する非同期プロバイダ（/gre にマウント）。 */
export interface FsProvider {
  stat(path: string): Promise<FsStat | null>
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<Uint8Array>
}

/** 永続プロファイル用の読み書きプロバイダ（/profile にマウント）。既定は OPFS。 */
export interface ProfileProvider extends FsProvider {
  writeFile(path: string, data: Uint8Array): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface GeckoOptions {
  /** エンジンが合成に使う canvas。 */
  canvas: HTMLCanvasElement
  width?: number
  height?: number
  /** エンジンの環境変数。GECKO_GPU は設定しないこと（理由は GeckoSource を参照）。 */
  env?: Record<string, string>
  /** WISP の websocket エンドポイント。http(s):// はこれ経由で取得される。 */
  wispUrl?: string
  fs?: FsProvider | string
  profile?: ProfileProvider | string
  /** 必須。wasm を配信している URL（.zst なら compressed: true）。 */
  wasm: { url: string; compressed?: boolean }
  locateFile?: (file: string) => string
  print?: (s: string) => void
  printErr?: (s: string) => void
  /** canvas 自身に付くマウス／キーボード／ホイールのリスナーを使う（既定 true）。 */
  forwardInput?: boolean
}

export interface GeckoInstance {
  /** エンジンを起動し、GRE をマウントし、準備完了まで待つ。 */
  init(): Promise<void>
  /** 埋め込みエンジンを遷移させる。data: / about: はネットワーク不要。 */
  load(url: string): Promise<void>
  /** 新しいサーフェスサイズに合わせて再レイアウト・再合成する。 */
  resize(width: number, height: number): Promise<void>
  /** chrome コンテキストで JS を評価する。 */
  evalChrome(js: string): Promise<string>
  destroy(): void
}

export interface GeckoConstructor {
  new (options: GeckoOptions): GeckoInstance
}

/** 動的 import の結果。ESM なので `Gecko` と `default` の両方を見る。 */
export interface GeckoModule {
  Gecko?: GeckoConstructor
  default?: GeckoConstructor
}
