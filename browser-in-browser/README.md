# browser-in-browser

ブラウザの中に、もう 1 つブラウザがある。

3D の部屋に机とブラウン管モニタが置いてあり、その**画面が生きたブラウザ**になっています。
画面の画素はいったん canvas に描かれ、その canvas がテクスチャとしてモニタのわずかに湾曲した
ガラスに貼られ、マウスとキーボードはレイキャスト経由でその canvas に戻されます。

画面の中身は差し替え可能です。

| 供給元 | 中身 | サーバ |
| --- | --- | --- |
| **内蔵 canvas ブラウザ** | 2D canvas に描いたデモ用の小さなブラウザ。既定。 | 不要 |
| **Gecko (wasm エンジン)** | Firefox のエンジンそのものを WebAssembly 化したもの。 | 不要（オフライン）※実サイトを見る場合のみ WISP プロキシ |

## セットアップ

```bash
# 1. 依存をインストール
npm install

# 2. wasm エンジンを取得（fork のビルド済みリリースを使う。
#    詳しくは下の「wasm エンジン」を参照。内蔵ブラウザだけ試すならスキップ可）
curl -LO https://github.com/thirdlf03/firefox-wasm/releases/download/v0.0.3/gecko.js-v0.0.3.tar.gz
npm run engine:link -- --from gecko.js-v0.0.3.tar.gz

# 3. 起動
npm run dev
```

`npm run dev` のあと、左上の HUD で「Gecko (wasm エンジン)」に切り替えると本物のエンジンが
起動します（下の「wasm エンジン」を参照）。

---

## 設計の中心

### 1. 画面は `ScreenSource` インターフェース越しに扱う

3D 側は「画素がどこから来るか」を知りません。ソースは canvas を 1 枚持ち、それを
`THREE.Texture` として公開し、**canvas 画素座標**で入力を受け取ります。

```ts
interface ScreenSource {
  readonly texture: THREE.Texture
  readonly width: number
  readonly height: number
  boot(): Promise<void>
  pointer(event: ScreenPointerEvent): void
  wheel(dx, dy, x, y, modifiers): void
  key(event: ScreenKeyEvent): void
  insertText(text: string): void      // IME の確定・貼り付け用
  cursorKind(x, y): 'default' | 'pointer' | 'text'
  tick(): void                        // 自前でアニメーションするソース用
  isDirty(): boolean                  // テクスチャの再アップロードが必要か
}
```

実装は 3 つあります。

- `CanvasScreenSource` … canvas + `CanvasTexture` + 合成 DOM イベント送出の共通部分
- `DemoBrowserSource` … 内蔵ブラウザ（`src/screen/demo/DemoBrowser.ts`）
- `GeckoSource` … wasm エンジン

WebRTC のストリームでも HTML-in-Canvas でも、同じインターフェースを実装すれば差し替わります。
`src/three/` 以下は一切変更不要です。

### 2. 曲面は「UV の後処理」ではなく「ジオメトリ」

ブラウン管のガラスは本当に曲面のメッシュです（`curvedScreenGeometry.ts`）。

これが重要なのは、**クリック位置が自動的に正確になる**からです。`Raycaster` は
`intersection.uv` をこの曲面の上で補間して返すので、ポインタ → canvas 画素の変換に
逆歪み補正が一切要りません。シェーダで UV を歪めていたら、クリックのたびにその逆関数を
解く必要がありました。

### 3. CRT の後処理は `MeshBasicMaterial` + `onBeforeCompile`

`ShaderMaterial` を一から書かず、three の標準マテリアルに `#include <map_fragment>` の後ろを
差し込んでいます（`crtMaterial.ts`）。こうすると色管理（`SRGB8_ALPHA8` でのデコードと
`<colorspace_fragment>` での出力変換）を three に任せられるので、**ブラウザの見た目が
本物のブラウザと一致**します。

画面に載っている効果:

- 燐光の色ずれ（赤青が緑より外側にずれる。画面端ほど強い）
- アパーチャーグリルと走査線。**周期は `fwidth()` から求めた画面空間の値**を使うので、
  どのズーム段階でも 2 画素に 1 周期に保たれ、縮小時のモアレが出ない
- ブラウン管の減光、ハイライトのにじみ、曲面ガラスの映り込み
- 燐光の応答（軽い圧縮。白いページが完全な白に張り付かない）
- 電源投入時のラスタ収縮とノイズ、水平ハム、微細なフリッカー
- ポインタ位置のリング表示

### 4. 入力

**ポインタ**（`useScreenPointer.ts`）: R3F の合成イベントではなく、WebGL canvas に直接
DOM リスナーを付けています。理由は 3 つ: メッシュの外に出ても持続するポインタキャプチャ、
`passive: false` の `wheel`、そして OrbitControls をいつ動かしてよいかの完全な制御。

- ガラスの上では OrbitControls を止める（視点操作とブラウザ操作が競合しない）
- 円弧の外へレイが外れても、ボタンを押している間は直前の座標を使い続ける
- 画面のソースが「ポインタの形」を返し、`pointer` / `text` / 既定でカーソルが変わる

**キーボード**（`KeyboardCapture.ts`）: `window` の**キャプチャ段階**で取り、
消費するキーは `stopPropagation()` します。wasm エンジンは mousedown で `canvas.focus()` を
呼ぶため、要素に紐づけたリスナーだとブラウザ内をクリックした瞬間にキーボードを失います。

- IME: 隠し `<textarea>` をフォーカスしておき、`compositionend` で確定文字列ごと
  `insertText()` に渡します。「候補ウィンドウから『日本語』が確定した」という事実は
  キーイベントの列では表現できません
- HUD の住所欄など編集可能な要素宛のイベントは素通しする
- `Tab` は奪い、ブラウザ自身のショートカット（F5/F12、Ctrl+R/W/T/N、devtools）は触りません

---

## wasm エンジン

### なぜリポジトリに入っていないのか

`gecko.js`（Firefox のエンジンを WebAssembly 化したもの）は**約 233MB の wasm** で、
ビルドには Linux + emsdk 6.0.1 + 約 15GB + 数時間かかります（上流の README いわく
「Must build on linux」）。macOS では clang/emsdk の都合でビルドできません。
そこで**フォーク（[thirdlf03/firefox-wasm](https://github.com/thirdlf03/firefox-wasm)）の
ビルド済みリリース**を使います。フォーク版には JS→WASM JIT の lowering パッチなど
上流に無い修正が入っています（`scripts/link-engine.mjs` 先頭のコメント参照）。

### 接続方法

```bash
# 1. フォークのビルド済みリリース（35MB）を取得
curl -LO https://github.com/thirdlf03/firefox-wasm/releases/download/v0.0.3/gecko.js-v0.0.3.tar.gz

# 2. 接続（tarball でも dist ディレクトリでもリポジトリでも可）
npm run engine:link -- --from gecko.js-v0.0.3.tar.gz

# 3. 起動して HUD を「Gecko (wasm エンジン)」へ
npm run dev
```

`engine:link` は 3 つを配置し、`public/engine/manifest.json` を書き出します。ランタイムは
そのマニフェストを読んでから動的 import するので、**エンジンが無くてもアプリは普通に動きます**
（その場合は HUD が接続手順を表示します）。

バンドルは完全に自己完結している（bare import なし・`gecko.data` を内包）ため、
`public/` に置いて素の URL として読みます。Vite に通さないのでビルド時間も成果物サイズも
影響を受けません。

### エンジンを動かす上での実測済みの制約

- **ソフトウェア合成のみ。** GPU モード（`GECKO_GPU`）にするとサーフェスが
  OffscreenCanvas として描画スレッドへ transfer され、ページ側にはサンプリングできるものが
  残りません。`GECKO_GPU` を設定しないことで、エンジンは 2D コンテキストへ BGRA フレームを
  blit し、こちらはそれを `CanvasTexture` として読めます。
- **cross-origin isolation 必須。** pthread が `SharedArrayBuffer` を使うため、COOP
  `same-origin` + COEP `require-corp` が必要です（`vite.config.ts` が付与しています）。
- **URL は 8192 バイトまで。** エンジンのコマンド構造体が `url@20[8192]` 固定なので、
  それより長い URL は静かに `NS_NewURI failed` になります。日本語を
  `encodeURIComponent` すると 1 文字 9 バイトに膨らんで即溢れるため、組み込みページは
  **base64 の data URL** で渡しています（`pageToDataUrl()`）。
- **CJK フォントが無い。** 最小 GRE には pdfjs の LiberationSans しか入っておらず、
  CJK フォントは 1 つもありません。したがって**エンジンに読ませるページは ASCII で書く
  必要があります**（日本語は豆腐 □ になります）。`fs` プロバイダで `/gre/fonts` に足そうと
  しましたが、`fs` を渡すと GRE ルートが `/gre` に変わり、GRE ツリー全体を供給しないと
  焼かれた `gecko.data` にフォールバックせず起動しなくなるため、断念しました（実測）。
  **日本語の UI は HUD（DOM 側）が担当しています。**
- **JSPI が必要。** Chrome 137+ / Firefox 153+ で既定有効。古いブラウザでは
  「This browser doesn't support WebAssembly JSPI」と出ます。
- **実サイトには WISP プロキシが必要。** ブラウザからは生の TCP を開けないため、
  `http(s)://` は WISP 経由になります。`?wisp=wss://...` か `VITE_WISP_URL` で指定します。
  指定しなければ完全オフライン（`data:` / `about:` のみ）で、これはこれで成立します。

### WISP サーバの用意（実サイトを見る場合）

WISP は「WebSocket ↔ TCP のリレー」だけをする小さなサーバです。動作確認だけなら
Mercury Workshop が公開しているデモサーバ（`wss://wisp.mercurywork.shop/`、帯域制限・
デモ用途限定）が使えますが、**全部のトラフィックが第三者のサーバを通る**ので、
ふだん使いには自前のサーバを立てるのがおすすめです。

このプロジェクトには `scripts/wisp-server.mjs` が入っています。

```bash
npm run wisp            # ws://127.0.0.1:5001 で待ち受け（WISP_PORT で変更可）
```

別ターミナルでアプリを起動し、クエリで wisp を指定します：

```bash
npm run build && npx vite preview --port 4173
# http://localhost:4173/?wisp=ws://127.0.0.1:5001/  ← これで実サイトが開ける
```

`wss://wisp.mercurywork.shop/` を直接指定して試すこともできます。
ローカルの `npm run wisp` 経由で実サイト（HTTPS へのリダイレクト含む）が描画される
ことは実機確認済みです。

外部の実装を使う場合:
[wisp-js](https://github.com/MercuryWorkshop/wisp-js)（現行推奨。プロジェクトの
`scripts/wisp-server.mjs` もこれ）、[wisp-server-python](https://github.com/MercuryWorkshop/wisp-server-python)、
[mrrowisp](https://github.com/soap-phia/mrrowisp)（Go）など。
旧 [wisp-server-node](https://github.com/MercuryWorkshop/wisp-server-node) は非推奨。

なお、**接続元のページが https なら wisp も `wss://` である必要があります**
（mixed content）。ローカル開発では http + `ws://` で問題ありません。
- **JIT なし。** エンジンは JS をインタプリタで実行するため、JS の重いサイトは遅くなります。
  `?env.GECKO_NOWASMJIT=1` でエンジン内蔵の WASM JIT を切ることもできます。

---

## 検証

「動いているはず」ではなく、実際にヘッドレス Chrome で走らせて画素まで見ています。
システムの Chrome を使うので、ブラウザのダウンロードは不要です。

```bash
npm run build
npx vite preview --port 4173 &

npm run wisp            # WISP が必要な検証を回す前に起動しておく（verify:wisp 用）

npm run verify          # 内蔵ブラウザ経路
npm run verify:engine   # wasm エンジン経路（エンジン接続時のみ）
npm run verify:wisp     # 自前 wisp 経由で実サイトが開けるか（wisp 起動時のみ）
```

スクリーンショットは `verify/shots/` に出ます。

### `verify/screen.mjs` が証明していること

| 検証 | 実測値 |
| --- | --- |
| viewport 中央のレイ → UV | `(0.5000, 0.5000)` 完全一致 |
| canvas 画素 (300, 300) への誘導 | 2px 以内（UV 読み値を閉ループ制御） |
| リンクの探索 | カーソル形状 `pointer` を頼りに発見 |
| リンクのクリック | `about:home` → `demo://input` に遷移 |
| 入力欄のクリック | フォーカス取得（HUD に「入力欄 a」） |
| 打鍵 | `hello 3D` が入力欄に入る |
| IME の確定 | 「日本語入力」が入力欄に入る |

### `verify/engine.mjs` が証明していること

| 検証 | 実測値 |
| --- | --- |
| 配信と隔離 | manifest 200 / wasm 200 / `crossOriginIsolated` true / SAB あり |
| エンジン起動 | **ready まで数秒** |
| 描画 | 40 種の色（実際にレイアウトされたページ） |
| マウス入力の到達 | ウェルカムページの背景が青 `#16202a` に変化 |
| キーボード入力の到達 | 背景が赤 `#2a1a20` に変化 |

エンジン側の入力検証は、組み込みページに「mousedown で青、keydown で赤」という目印を
仕込んで判定しています。座標の決め打ちをしないので、ページ内容を変えても壊れません。

### 開発用ハンドル

`window.bib` に現在のソース、`runtime`（UV・ユニフォーム・レイキャスト回数）、`keyboard` が
出ています。devtools からレイキャストの状態を直接覗けます。

---

## ファイル構成

```
src/screen/                  画面の供給元（3D 側から見た抽象）
  types.ts                     ScreenSource 契約、NavigableScreenSource
  CanvasScreenSource.ts        canvas + CanvasTexture + 合成 DOM イベント
  DemoBrowserSource.ts         内蔵 canvas ブラウザ
  GeckoSource.ts               wasm エンジン（アダプタ）
  geckoTypes.ts                上流 gecko.js の公開 API の型
  registry.ts                  プロセス全体のシングルトン
  demo/DemoBrowser.ts          2D canvas に描く小さなブラウザ本体
src/three/                   3D シーン
  dimensions.ts                実寸ベースの寸法定数
  Scene.tsx                    ライト・部屋・モニタ・操作・毎フレーム更新
  Monitor.tsx                  手続き的に組んだ 18 インチ CRT
  Room.tsx                     机・キーボード・マグ・本・ランプ・床・壁
  CrtScreen.tsx                ガラスのメッシュ
  curvedScreenGeometry.ts      曲面ジオメトリ（= クリックがずれない理由）
  crtMaterial.ts               CRT 後処理（onBeforeCompile）
  screenRuntime.ts             マテリアルと状態の共有、テクスチャ更新、電源シーケンス
  useScreenPointer.ts          レイキャスト入力と OrbitControls の調停
src/ui/
  Hud.tsx                      HUD・住所欄・接続手順
  KeyboardCapture.ts           キーボード横取りと IME
scripts/link-engine.mjs        wasm エンジンの取り込み
verify/                        ヘッドレス Chrome による端から端の検証
```

---

## 既知の制限と次の一手

- **実サイト（http(s)）のスクロールが効かない**。エンジン側の embed-xul の制限で、
  `data:` / `about:` のドキュメントはホイール・キーボードともスクロールできますが、
  WISP 経由で読み込んだ http(s) ドキュメントは一切スクロールしません（ホイールの
  deltaMode 全種、クリックでフォーカスを与えた後のキーボードスクロールも確認済み、
  すべて無反応）。アプリ側の入力経路は正しく届いています（ローカルページでは動く）。
  エンジン側の修正（`embed-xul.cpp`/`embed-input.cpp` の do_wheel がネットワーク文書の
  scroll frame を拾うようにする）が必要です。fork（thirdlf03/firefox-wasm v0.0.2）に
  do_wheel フォールバック修正を入れ済みで、ビルド後に確認する。
- **エンジン内は ASCII のみだった（CJK フォントが最小 GRE に無い）が、現在は暫定対応済み。**
  `scripts/rebake-gecko-data.mjs` が `public/engine/gecko.js` に Noto Sans JP
  （SubsetOTF/JP）を焼き込み、実サイトの日本語が描画されます（実機確認済み: 日本語行の
  々面密度 2〜4% → 6〜11%、従来は欠落グリフ）。恒久対応は fork の CI ビルド
  （`stage-gre-min.sh` に CJK 焼き込みを追加済み、v0.0.2）で、`engine:link` の差し替えで
  置き換わります。
- **エンジンの起動に 32MB の wasm を毎回ダウンロード**します。`Cache Storage` に入れれば
  2 回目以降は速くなります（未実装）。
- **部屋の美術がまだ粗い。** 実測すると、ガラス周囲の面取りが 15px 幅でほぼ黒（0.02 linear）
  と太く、逆にベゼルバーは機体より明るく（0.69 対 0.47）なっていてパネル構造が読めません。
  半球光が青いため、暖色ベージュの CRT が冷たいグレーに見えています。壁は 0.002 linear で
  ほぼ全黒なので、部屋の閉塞感がありません。
- **ブラウン管が周囲を照らす量が弱い。** 画面グローの点光源を強めると一気に「そこにある」
  感じが出ます。
- **モバイル未対応。** タッチ入力、`about:config` が無い環境、dpr の扱い。
- **Firefox / Safari での実機確認が未実施**（検証はヘッドレス Chrome のみ）。
- **画面サイズは 960x720 固定。** `ScreenSource.resize()` は用意済みですが、
  ウィンドウに応じて解像度を変える配線はまだです。
- 次に足すなら: WebRTC のストリームを `ScreenSource` として実装し、同じ 3D 画面で
  「ローカルの wasm エンジン」と「リモートの実ブラウザ」を切り替えられるようにする。
