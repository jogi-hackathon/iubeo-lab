import { DemoBrowserSource } from './DemoBrowserSource'
import { GeckoSource } from './GeckoSource'
import { ENGINE_HOST_ID, type ScreenSource } from './types'

/**
 * ソースはプロセス全体で 1 つのシングルトン。React のライフサイクルには意図的に
 * 結び付けていない。wasm エンジンの起動は数百メガバイトと数十秒を要するため、
 * 再マウントや HMR で絶対に再起動させたくないから。
 */

export interface SourceDescriptor {
  id: string
  label: string
  /** ソースを生成する前から HUD に出す説明。起動なしで一覧できる。 */
  note: string
}

const DESCRIPTORS: SourceDescriptor[] = [
  {
    id: 'demo',
    label: '内蔵 canvas ブラウザ',
    note: 'デモ用の小さなブラウザ。「canvas → テクスチャ → レイ入力」の全経路を検証する',
  },
  {
    id: 'gecko',
    label: 'Gecko (wasm エンジン)',
    note: 'Firefox のエンジンそのものを WebAssembly 化。完全にローカルで動作しサーバ不要',
  },
]

const instances = new Map<string, ScreenSource>()

function host(): HTMLElement {
  const element = document.getElementById(ENGINE_HOST_ID)
  if (!element) throw new Error(`#${ENGINE_HOST_ID} が存在しません`)
  return element
}

export function listSources(): SourceDescriptor[] {
  return DESCRIPTORS
}

export function getSource(id: string, width: number, height: number): ScreenSource {
  const existing = instances.get(id)
  if (existing) return existing

  const created =
    id === 'gecko'
      ? new GeckoSource(host(), width, height)
      : new DemoBrowserSource(host(), width, height)
  instances.set(id, created)
  return created
}

export function disposeSource(id: string): void {
  const source = instances.get(id)
  if (!source) return
  source.dispose()
  instances.delete(id)
}
