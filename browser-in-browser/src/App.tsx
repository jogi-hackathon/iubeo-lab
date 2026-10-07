import { useCallback, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Scene } from './three/Scene'
import { createScreenRuntime } from './three/screenRuntime'
import { getSource, listSources } from './screen/registry'
import {
  CAMERA_POSITION,
  SCREEN_RESOLUTION_HEIGHT,
  SCREEN_RESOLUTION_WIDTH,
} from './three/dimensions'
import { isNavigable, type CursorKind, type ScreenStatus } from './screen/types'
import { prewarmEngine } from './screen/GeckoSource'
import { KeyboardCapture } from './ui/KeyboardCapture'
import { Hud, type HudAddress } from './ui/Hud'
import './styles.css'

export function App() {
  const sources = useMemo(() => listSources(), [])
  const [activeId, setActiveId] = useState(sources[0].id)
  const [status, setStatus] = useState<ScreenStatus>('idle')
  const [detail, setDetail] = useState('')
  const [engaged, setEngaged] = useState(false)
  const [pointer, setPointer] = useState<{ kind: CursorKind; onGlass: boolean }>({
    kind: 'default',
    onGlass: false,
  })

  const source = useMemo(
    () => getSource(activeId, SCREEN_RESOLUTION_WIDTH, SCREEN_RESOLUTION_HEIGHT),
    [activeId],
  )

  // マテリアルとユニフォームはソースを切り替えても生き続け、差し替わるのは
  // サンプリング対象のテクスチャだけ。ブラウン管の状態が保たれる。
  const runtime = useMemo(
    () =>
      createScreenRuntime(
        getSource(sources[0].id, SCREEN_RESOLUTION_WIDTH, SCREEN_RESOLUTION_HEIGHT),
      ),
    [sources],
  )

  const keyboard = useMemo(() => new KeyboardCapture(), [])

  // 初回描画が落ち着いてから、エンジンの重い資産（bundle import + wasm）を
  // 裏で温めておく。クリック時の待ち時間が資産ロード分だけ減る。
  // ?noprewarm で切れる（自動検証が余計な負荷を受けないための抜け道）。
  useEffect(() => {
    if (new URLSearchParams(location.search).has('noprewarm')) return
    const timer = window.setTimeout(prewarmEngine, 800)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    runtime.setSource(source)
    setStatus(source.status)
    setDetail(source.statusDetail)

    source.onStatusChange = (next, text) => {
      setStatus(next)
      setDetail(text)
    }
    keyboard.setSource(source)

    // ソースを選ぶことは電源を入れること。wasm エンジンでは切替そのものが目的で、
    // 内蔵ブラウザでは一瞬で終わる。
    if (source.status === 'idle') void source.boot()

    return () => {
      source.onStatusChange = undefined
    }
  }, [keyboard, runtime, source])

  useEffect(() => {
    keyboard.onActiveChange = setEngaged
    return () => {
      keyboard.onActiveChange = undefined
    }
  }, [keyboard])

  useEffect(() => () => keyboard.dispose(), [keyboard])

  const engage = useCallback(() => {
    keyboard.engage()
    // エンジンは mousedown で自分の canvas にフォーカスを奪うので、少し後に取り戻す。
    // そうしないと IME の入力先が消える。
    window.setTimeout(() => keyboard.refocus(), 0)
  }, [keyboard])

  const disengage = useCallback(() => keyboard.disengage(), [keyboard])

  const handleSelect = useCallback(
    (id: string) => {
      if (id === activeId) return
      keyboard.disengage()
      setActiveId(id)
    },
    [activeId, keyboard],
  )

  const handlePower = useCallback(() => {
    if (source.status === 'ready' || source.status === 'booting') {
      keyboard.disengage()
      source.halt()
      setStatus(source.status)
      setDetail(source.statusDetail)
      return
    }
    void source.boot()
  }, [keyboard, source])

  const handleCursor = useCallback(
    (kind: CursorKind, onGlass: boolean) => setPointer({ kind, onGlass }),
    [],
  )

  // 住所欄。navigate を持つソース（内蔵ブラウザ・wasm エンジン）にだけ出す。
  // 依存の変化で作り直されるが、値は毎レンダー読み直すので常に最新。
  const address: HudAddress | null = isNavigable(source)
    ? { url: source.currentUrl, submit: (input) => source.navigate(input) }
    : null

  // デバッグ用ハンドル。devtools と自動検証スクリプトが、React の内部を辿らずに
  // レイキャストの状態と現在のソースを覗けるようにしておく。
  useEffect(() => {
    ;(window as unknown as { bib?: unknown }).bib = {
      runtime,
      keyboard,
      get source() {
        return source
      },
      get status() {
        return status
      },
    }
  }, [keyboard, runtime, source, status])

  return (
    <div className="app">
      <div className="stage" style={{ cursor: pointer.onGlass ? pointer.kind : 'default' }}>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ position: CAMERA_POSITION, fov: 34, near: 0.05, far: 24 }}
        >
          <Scene
            source={source}
            runtime={runtime}
            status={status}
            onEngage={engage}
            onCursor={handleCursor}
          />
        </Canvas>
      </div>

      <Hud
        sources={sources}
        activeId={activeId}
        status={status}
        detail={detail}
        engaged={engaged}
        address={address}
        source={source}
        onSelect={handleSelect}
        onEngage={engage}
        onDisengage={disengage}
        onPower={handlePower}
      />
    </div>
  )
}
