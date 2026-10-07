# WJ → PBL per-site フォールバック

`src/screen/GeckoSource.ts` に実装した、特定サイトだけ WJ を事実上無効化して
PBL で動かす互換性回避策の記録。**根治ではない。**

## 症状と原因（2026-10 調査済み）

x.com の onboarding (`/i/jf/onboarding/web`) が WJ 有効時に描画途中で崩落する
（`bodyLen:0`, `htmlLen:693` の空シェル）。`sentry-filter` が
`InternalError: too much recursion` を投げ、React error boundary が空描画。

原因は PBL の深さではなく **混合ティアの host-charge 枯渇**:

- V8 の wasm 実行スタック（~1MB、外側ブラウザ固定・変更不可）を防衛するため、
  gecko は `gWJHostDepth` に境界通過コストを会計している（budget 480000）
- `WasmJitRunCall` (JS→WJ): +6000、`RunScript` (PBL activation): +4000、
  `wjhelp` 非CALL: 課金。WJ↔PBL の 1 往復で ~10000 → **約50往復で枯渇**
- 枯渇後は `AutoCheckRecursionLimit` を取る全箇所が InternalError を投げ始める
- `GECKO_NOWASMJIT=1`（全 PBL）では交差が存在しないので mount 成功 — 確定済み

`[wj-xrefuse] depth=480000 kind=0` の直後に InternalError、という実測ログあり。

## 回避策の仕組み

- `PBL_ONLY_HOSTS = {x.com, twitter.com, mobile.twitter.com}`
- 遷移時に `_wj_set_depth_limit(1)` — call 含む WJ 関数が entry で即 suspend
  → 全呼び出しが PBL に委譲される（実質ランタイム版 NOJIT、エンジン再起動不要）
- **pin 留めが必須**: glue の `wjProbeStack` は pthread worker 側の
  `Module._wj_set_depth_limit` を直接呼ぶため main thread の mod ラッパーを
  素通りし、最初の `wasmhost_instantiate`（= サイトロード中）にキャリブ値で
  上書きする。対策として pblOnly 中は 250ms interval で値を再アサート
- `location.href` を 1s 毎に poll して内部遷移（リンククリック・リダイレクト）
  にも追従。`about:`/`data:` はスキップ（過渡状態での pin ちらつき防止）
- 非対象サイトでは `wjDepthDefault`(480000) に復帰

## 検証済み

- onboarding mount: `bodyLen:224`, `htmlLen:20926`, `divs:85`, `inputs:2`、
  InternalError ゼロ、安定
- x.com→thirdlf03.com→x.com の往復で pin 着脱を確認（`[wj-depth3]` 11→0）
- blocklist 外サイト（wikipedia, workers.dev, thirdlf03.com）は無変更で動作
- PBL 下でも ToS `bodyLen:120943` の重いページが動く（遅いが実用的）
- 検証スクリプト: `verify/x-pin-test.mjs`（APP_PIN_ONLY=1 でアプリ側のみ）,
  `verify/x-pbl-toggle.mjs`

## 課題点・残タスク

- **根治はエンジン側**: 混合ティアで host-charge を蓄積しない呼び出し経路が
  必要。候補は soft suspend watermark（帳簿が中間閾値を越えた時点で以降の
  JS→WJ entry を全拒否 → PBL in-loop で平らに走らせる）や残存
  `PBL_CALL_INTERP`（bound/getter/`.call`/`.apply`）の in-loop 化
- bound/getter の自己再帰は depth=20000 で**エンジンごと wedge** する未変換
  パスが残っている（catchable ですらない）
- location poll の分解能は 1s — 外部サイトから x.com へ踏んだ場合、pin 作動
  まで最大 ~1s WJ が走る（失敗には蓄積が要るので実害はほぼない）
- `wjDepthDefault` は実測キャリブ値を拾えない（worker 側 Module の呼び出しは
  観測できない）ので 480000 のコンパイル既定値を使っている。保守的な方向な
  ので実害はないが、復帰直後に probe が再発火すれば自動修正される
- PBL 単独の速度は WJ より遅い。x.com 系の体感は「遅いが使える」レベル
- blocklist は `GeckoSource.ts` 内の定数。サイト追加はコード変更が必要
