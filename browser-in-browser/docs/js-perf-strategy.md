# エンジン内 JS の性能戦略メモ

browser-in-browser の gecko.js (SpiderMonkey-on-wasm) で JS を速くする方法について、
2025-12 時点の計測・調査・判断を記録する。実測データの一次情報は
`firefox-wasm/artifacts/results.md`（In-situ セクション）を参照。

## 前提の整理

- gecko.js v0.0.3 は **JS→Wasm lowering JIT (WJ)** を既定で有効にしている。
  内側の JS は Ion/Warp MIR から wasm bytecode に lowering され、ブラウザの wasm
  エンジン（V8 Liftoff→TurboFan）がネイティブ化する。**実行時コード生成の制約は
  このプロジェクトには存在しない**（`WebAssembly.compile` が普通に使える）。
- `?env.GECKO_NOWASMJIT=1` で JIT を切ると PBL ポータブルインタプリタのみになる。

## 実機計測（Chrome 上の gecko.js、`verify/bench-*.mjs`）

- microbench JIT vs PBL: prop-poly 71.6x / prop-mono 51x / float-arith 43x /
  call-poly 17x / int-arith 7.4x。弱いのは string-ops 1.3x・try-catch 0.74x
  （JIT の方が遅い = deopt churn）
- サイト workload: wiki:search 3.5x / wiki:dom 5.6x / wiki:lodash 3.2x /
  vibey:frame3d 3.0x / home:dom 40.7x
- 起動: JIT/PBL とも ~4.2s（233MB wasm のコンパイル支配）
- WJ 統計: compiled=314, failed=3（永久 PBL 行き）, jitRuns=668万,
  **deopt 率 7%**。1関数（eval:2060）が 52.7万deopt/61.5万runs の deopt storm
- **要するに JIT の恩恵は巨大だが、実行の ~7% は今も PBL に落ちている**

## 同種システムの手法調査（根拠付き）

### ほぼ同構造の先例

| システム | 手法 | 根拠 |
|---|---|---|
| **.NET jiterpreter** (Blazor) | インタプリタ opcode 列→wasm 関数のランタイム JIT。トレース単位・ヒットカウンタ駆動・モニタリング段階で悪いトレースを淘汰（penalty 計算→NOP化）・遷移 thunk 特殊化・emit 時定数化・CFG 2パス lowering | [design doc](https://github.com/dotnet/runtime/blob/main/docs/design/mono/jiterpreter.md), [CFG PR 実測](https://github.com/dotnet/runtime/pull/83247) |
| **CheerpX** (Leaning Tech) | x86→wasm JIT。2層（構造発見インタプリタ＋wasm JIT）、自己書換コード対応、SAB/branch hinting。ネイティブ比 2-3x〜 | [docs](https://cheerpx.io/docs/overview), [blog](https://labs.leaningtech.com/blog/cx-10) |
| **CheerpJ 3** | JVM bytecode→**JS** JIT（wasm でなく JS を生成してホスト JIT に任せる） | [deep dive](https://labs.leaningtech.com/blog/cheerpj-3-deep-dive) |
| **Mozilla 公式 wasm32 codegen** | [bug 1863986](https://bugzilla.mozilla.org/show_bug.cgi?id=1863986) — masm→wasm32 バックエンド + hostcall で関数登録。cfallin が weval 記事で「直接ポートは実際に取られている」と引用する先例 | cfallin blog part 3 |

### SpiderMonkey-on-wasm 直系

- **cfallin PBL + weval**（Bytecode Alliance/StarlingMonkey/ComponentizeJS `--aot`）:
  主張は generic interpreter 比 3-5x。Fastly の JS SDK が実運用。
  **ただし我々の環境では 1.0-1.09x に留まった（未再現）**。サイズコスト:
  ComponentizeJS 例で 13MB→29MB。[blog](https://www.cfallin.org/blog/2024/08/28/weval/)

### 別トレードオフ系

- QuickJS/Javy・Ruvy/ruby.wasm: 小さいエンジン＋bytecode事前コンパイル埋め込み＋Wizer
  プリ初期化。ピーク性能より起動・サイズ優先
- mruby Kobako: wasm モジュール自体を cwasm でネイティブ事前コンパイル（サーバ向け）
- Pyodide: 内側言語 JIT を諦め、JS↔wasm FFI 削減 + JSPI に注力
- js-string-builtins (Chrome shipped): 文字列プリミティブを glue なし import —
  gecko.js では wasmhost DOM ブリッジ側に効く可能性（SM 内部には直接効かない）
- WasmGC: Kotlin/Dart が実績。JS エンジンへの適用はオブジェクト表現の作り替えが
  必要で既存 SM には非現実（[V8 porting article](https://v8.dev/blog/wasm-gc-porting)）

## 戦略判断

### 「Gecko を置き換える」「lowering をやめる」はありか → なし

- SM は Gecko に根深く統合（WebIDL bindings/XPConnect/CC）され抜き差し不能。
  エンジンごと替えても V8(jitless)/JSC(cloop) いずれも wasm 上ではインタプリタ止まりで
  同じ壁に当たる。むしろ SM の PBL+WJ 系譜が wasm 上の本物エンジンとして最も進んでいる
- lowering をやめる = 実測 3-70x 悪化。実行時 codegen が許されるこの環境では
  やめる理由がない（PBL は WJ のフォールバック層として残る設計）

### 「lowering 先を wasm→外側 JS（CheerpJ 方式）」は無限リソースで可能か

- **可能だが DOM-heavy workload では勝てない見込み**。内側 JS は既に JS なので
  コンパイルはほぼ不要（outer eval に流せる）。壁は実行時側：
  1. DOM アクセスが全て outer Proxy → wasm 境界越え呼出になる。
     Mozilla の **CPOW**（e10s 期 cross-process wrapper）が先例 — 動いたが遅くて廃止
  2. Gecko cycle collector は V8 ヒープ上の JS オブジェクトをトレースできない
     → wrapper preservation の簿記が必要（Mozilla 実績あるが複雑）
  3. 内側 JS がホストページの realm で走る → ShadowRealm 級の分離が別途必要
- 勝てるのは純粋計算のみ（outer V8 で 1.5-3x 見込み）だが、その領域は WJ でも既に速い
- 結論: 無限リソースでも**配分先として負け筋**。WJ の質向上に投じる方が全 workload で効く

## 次に取ると効果が大きそうな方向（期待度順）

1. ~~**deopt 淘汰機構**（jiterpreter の penalty 監視→NOP化）~~ → **実装済み・実測済み**
   （2026-10、WJStormDecision 系 valve）。site workload 再計測（`GECKO_WJ_STATSJSON=1`、
   全て deoptRatePct=0%）:
   - wiki:lodash — jitRuns 2.3M / deopts 603、storm 2 fn は Failed→PBL へ正常移送
   - wiki:dom — 555K runs / 1584 deopts（dom.js:2015 は 45% rate で count
     trigger 未達のため JIT 残留 — 境界ケース、絶対数は小さい）
   - wiki:search / jsparse — deopts 0 / 406（self-hosted:310 → PBL）
   valve は Ion 式 count trigger + rate gate + mega/generic recompile + alwaysBails
   直PBL で既に網羅。**残る実サイト側の 7% 問題はブラウザ経路で再計測が必要**
   （bench ワークロードでは検出されない — eval/new-Function 経由の動的コード等）
2. **遷移 thunk 特殊化**（jiterpreter jit_call/interp_entry 相当）: Call が
   IC 経路に落ちる箇所の遷移コスト削減。
   実測（2026-10、`GECKO_WJ_PBLWHO`、wiki:lodash ローカル）: PBL→JIT 遷移は
   8 iter で ~1M 回発生するが概算コストは全体の ~1% 規模 — 支配項ではない。
   site workload が microbench（7-70x）より 2-3.7x に留まる主因は
   object/alloc ヘビーなパス（boxing・GC・helper 呼出）と推定。
3. **emit 時定数化の強化**: IC/shape/data 相当値を emit 時に wasm 定数へ畳み込み
4. **CFG 直接分岐 lowering**: per-target dispatch check → wasm block/loop 構造化
   （jiterpreter CFG pass は実測で JSON 系を大幅改善）
5. **粒度の細分化**: メソッド単位→ホットループ/trace 単位（後方分岐ターゲットに
   entry point）。compile latency も下がる
6. **生成 wasm は単純でよい**: ホスト側 Liftoff→TurboFan に最適化を任せる思想に
   倒れる（自前最適化の投資不要）
7. wasm-bytes 上限（ブラウザメモリ保護の安全弁）
8. 既知・自前サイトなら JS bundle をビルド時 AOT（Porffor 的）にして
   JIT 負荷自体を減らす補助路線
9. 起動: 233MB モジュールの wasm-split/遅延ロードが現実的（wizer は env import
   ~50個で stock 不可）

## フレッシュ案ブレインストーム（codex gpt-6.1-sol との合同、2025-12）

既存枠にとらわれない案を codex ヘッドレスと各自で出し合い、収束・新規のものを抽出。
期待値順。詳細な trap/コスト見積もりは /tmp 相談ログ由来の内容を要約。

### 即効性高

1. ~~**エンジン配信に安定 HTTP ID を与える**~~ → **検証済み・効果なし**
   （2026-10、v0.0.9 実測）。`.zst→zstddec→new Module` をやめて生
   `gecko.wasm`(150MB) を `application/wasm` + cacheable で配信し
   `instantiateStreaming` 経路にすると、コード側は既に対応済みだった。
   計測（`verify/boot-time.mjs`、Chrome、各3-4回）:

   | | cold | warm 平均 |
   |---|---|---|
   | raw wasm + streaming | 8.45s | ~6.2s |
   | .zst decode + instantiate | — | ~6.2s |

   同一。150MB 級モジュールは V8 wasm code cache が乗らないか、乗っても
   起動の支配項がコンパイル以外（GRE init・gecko.data 展開・SM init）にある。
   vite dev は `.wasm` が octet-stream + no-store で配信されるため、
   今回 `application/wasm` + `max-age` の middleware 修正だけは残した。
   [ref](https://v8.dev/blog/wasm-code-caching)
2. **WJ 成果物の永続化（codepack）**: emit した wasm bytes + deopt/hotness メタを
   IndexedDB に保存（キー: script hash + 関数 ID + WJ ABI 版）。次回訪問で lowering と
   プロファイリングをスキップ → 再訪問 tier-up 30-80% 減の見込み。埋め込みポインタは
   binding table で再バインド。自前サイトなら codepack を製品同梱＝JIT 出力の AOT 化。
   （codex・私ともに独立に同結論 → 収束）
3. **コンパイルの非同期パイプライン化**: `new Module`（同期）→ `WebAssembly.compile`
   （非同期）に投げ、PBL で走り続けて safepoint で装着。stall 50-90% 減見込み。
   MIR/backend 仕事の一部を worker に移す拡張もあり
4. **warm engine pool**: ナビゲーション間でエンジン・生成モジュール・基盤を生かし、
   内側コンテキストだけ作り直す。セッション内遷移で boot ほぼ消える。trap:
   realm teardown・権限分離・メモリ圧・worker は durable infra でない

### 構造的新機構

5. **ローカルリカバリ deopt**: ガード失敗で activation ごと PBL に落とすのではなく、
   recoverable な失敗は generic op を呼んでコンパイル済み continuation に復帰。
   86% deopt storm 関数に直撃（2-10x、その関数限定）。trap: 失敗 op が
   getter/proxy/alloc/GC/任意JSを呼びうる → 復帰前に再 validate が必要
6. **V8 第2ウォームアップの workaround**: V8 wasm には OSR が無い → 長い初回ループは
   Liftoff のまま。ループを bounded chunk + continuation で再入に lowering すると
   後の chunk が TurboFan コードに乗る（1.2-3x、長い初回カーネル限定）
   [ref](https://v8.dev/docs/wasm-compilation-pipeline)
7. **leaf helper を生成モジュール内に同居**: shape check・タグ判定・dense 要素読み・
   型変換を hostcall でなくモジュール内 wasm 化。V8 の call_indirect 投機 inline 化は
   同一インスタンス内限定 [ref](https://v8.dev/blog/wasm-speculative-optimizations)
   → helper-heavy コードで 1.1-2x。IC スタブ自体の wasm 化（hostcall 往復の削減）も同系
8. **escape 解析で一時オブジェクトを仮想化**: iterator result・record・closure を
   SM オブジェクト化せず wasm locals 維持、escape/deopt 時にのみ materialize
   （alloc hostcall・barrier・GC 圧を削減、alloc-heavy ループで 1.2-3x）

### crazy but plausible

9. **純粋計算 island を outer V8 に輸出**: DOM 境界全開放でなく、プリミティブ+
   owned data のみのホット呼出木を証明して島ごと marshal → outer JS で実行 → 一回戻る。
   島内境界越えゼロで CPOW 問題を回避（2-10x、byte parser/数値変換等の対象限定）
10. **MIR→外側 JS バックエンド（SM ヒープ直読み）**: MIR の一部を JS として emit、
    typed-array 経由で wasm 線形メモリの SM ヒープを直接操作。V8 JS パイプラインの
    別経路利用（0.5-3x、悪化含む。数値 subset のプロトタイプが先）
11. **初期化 epoch リプレイ**: deterministic 初期化区間（フレームワーク init 等）を
    記録し再訪問時に状態再構築+スキップ。wizer の「起動前」でなく「ページ実行」を対象
12. **予測的インタラクション事前計算**: hover 中にアイドル時間で次計算を worker 先回り、
    依存セットを保存し本イベントで validate→採用
13. **wasm-split で冷コード分離**: 起動プロファイルで大きな冷サブシステムを別モジュール化
    → コールドブート 20-60% 減見込み（サイズ帰属の計測が先）

### 推奨実験シーケンス（codex 提案 + 整理）

1. コードキャッシュ用 URL 安定化の検証 + warm pool の計測
2. トップ startup 関数のフィードバック永続化 → リロケータブル WJ 成果物
3. コンパイルをクリティカルパスから外す
4. 86% storm 関数を bailout 理由別に分解 → ローカルリカバリ 1 経路実装
5. 純粋計算 island と bounded-loop chunk のプロトタイプ各 1 本

計測上の注意: cold boot / repeat boot / first interaction / steady state を分離し、
time-weighted な PBL fallback 率・helper 越境数・コンパイル stall・メモリ増を見る。
これらの改善は重複するので乗算してはいけない。

## WJ の深再帰問題と suspend latch（2026-10、patch 0007）

x.com onboarding がスピナーで止まる原因は、JIT 化 JS の再帰が**ホスト wasm
スタック**（~1MB）を uncatchable に使い果たすことだった。sentry-filter 内の
React `insertOrAppendPlacementNode` 系の fiber DFS が数百〜千超の有限再帰を
して、catchable な SpiderMonkey 側 quota に届く前に pthread ごと死亡していた
（PBL の JS ヒープシャドウスタックでは収まる深さ）。

修正は「深度超過で例外を投げる」のではなく**委譲**にした
（`firefox-wasm/patches/0007`、codex 壁打ちで設計確定）:

- 関数エントリ（生成コードのプロローグ）で推定フレームバイトを
  `gWJJitDepth` に加算し、上限超過なら専用 flag 3.0 で「走らなかった」を返す。
- flag 3.0 は同時に `gWJSuspendWatermark = そのエントリ深度` を min-update。
  全 JS→WJ エッジ（PreCall/ObserveCall/RunCall/WJH_CALL fast path/OSR/ctor
  キャッシュ）は `gWJJitDepth >= watermark` の間 routing を拒否するので、
  委譲されたサブツリーは **PBL だけで完走**する（旧 flag-2 委譲は各段で JIT
  に戻って wasm スタックを再成長させてしまい、結局死んでいた）。
- 委譲元フレームが巻き戻ると `gWJJitDepth` が watermark を下回って自動解除。
- flag 2.0（GGG 不一致）は generation 会計なので混同しない（deopt storm 再発防止）。

検証で出た根本原因の地雷: EmitDepthCheck は「EmitBlockBody の最初のブロック」に
emit されていたが、ディスパッチループのエミッタはブロックを**逆順**に emit
する（`bi = n-1-ri`）ため、ガードは終端 return パッドに着地してエントリでは
一度も走らなかった（`DEPTHLIMIT=0` でも再帰が通ることで実証）。
プロローグ配置にして全経路（単一ブロック/relooper/ディスパッチ/OSR）を
共通にカバーした。

効果: 有限の深い再帰（React commit 等）は中断せず完走、真の暴走だけ
catchable InternalError。コストは call-heavy octane richards で ~4%。

## fresh-script family sharing（2026-10、patch 0008）

vibeyboot 系で見つかった残件: `new Function` や再評価で生まれる**同一ソースの
fresh JSScript 群**が per-script warmup を絶対に越えられず、永遠に JIT 化されない
（あるいは同一バイトコードを N 回コンパイルする無駄）。

観測事実（embed 実測）:

- `new Function` の50クローンは全部別 JSScript だが `sharedData()`
  （SharedImmutableScriptData）は**完全に dedup される** → ハッシュ不要の
  family キーがタダで手に入る
- ただし `gcthings()`（PrivateScriptData 内）は**スクリプトごとに別配列**で、
  中身のセルも clone ごとに別物（body Scope が各 clone で別ポインタ）
  → 「sd が同じ = 焼き込み gcthing が安全」は**誤り**

設計（codex 壁打ちで焼き込み依存を洗い出して確定）:

- `gFamilies[sd*]` に集約 observe を貯め、`FAMWARM`(64) 超えで次の適格メンバー
  （jitScript 持ち・非 eval/module/generator/async）を shared-compile。
- 共有 artifact では resume 用 outer-frame script を**ランタイム callee から
  ロード**（`gWJCallRoots[envRootIdx+1]` → `offsetOfJitInfoOrScript`）—
  焼き込みだと B の実行が A の script で resume してしまう。
  inlining は代表の callee script を焼くので共有では禁止（`shared-inline` bail）。
- メンバー適合判定 `WJMemberCompatible`: 代表 bytecode を走査し、
  **即値で参照される gcthing スロットのみ**ポインタ一致を要求
  （JOF_GCTHING/OBJECT/REGEXP/SCOPE/BIGINT/STRING/SHAPE/ATOM — 全て pc+1 が
  GCThingIndex）。参照されないスロット（全関数が持つ outermost scope）は
  不一致でも安全。実測: lambda/オブジェクトリテラル持ち clone は `gcmp FAIL`
  で正しく拒否され個別コンパイルに落ちる。
- 後続メンバーは alias install（handle/tblSlot/directIdx を借用）＋ jitScript
  をその場生成（deopt resume が要求するため）。storm 時は family スロットを
  持ち逃げしないよう detach（**閾値判定を通過した後に限る** — 先に detach すると
  Compiled なのに tblSlot=-1 の壊れた entry が残る）。
- 代表 script は `WJTraceRoots` で root（member-compat 参照元 + 焼き込みセルの
  所有者）; family artifact は cohort fusion から除外（fusion が tblSlot を
  書き換えると兄弟 alias が腐る）。

効果: 50 clone bench で shared-compile 1回 + alias 49（総コンパイル 52→3）。
200-clone perf probe ~288ms vs per-script ~500ms vs PBL ~670ms。
octane/realapp は family が発火しない（refCount≥3 の sd が無い）ので中立。
jit-test subset は NOFAMILY 対照で失敗セット完全一致（回帰ゼロ）。

## v0.0.9 実機検証と PBL スタック増量（patch 0009）

v0.0.9（WindowProvider + suspend latch）を browser-in-browser で検証:

- `verify/nav.mjs` 全項目パス: `_blank` / `window.open` が docshell provider
  経由で同一ウィンドウ遷移に落ちる（以前は `NS_ERROR_FAILURE`）。
- x.com: `sentry-filter.js` の `InternalError: too much recursion` が
  **catchable 化してエンジンは生存**（旧来は pthread 死亡）。`[wj-sus]`
  で suspend latch の発火を確認。ただし委譲先の PBL が quota で落ち、
  React onboarding は依然 mount せず。

残りの壁は **PBL shadow stack が 512KB 固定**だったこと: 1フレーム ~120B で
~4359 フレームしか入らない。`PortableBaselineStack::DEFAULT_SIZE` を 4MB に
増量（ヒープなので native stack を消費しない）→ 純粋再帰 4359→34943、
map 経由の host 越え再帰も 1167→9359（shadow stack は runtime 共有で、
ネストした PBL 入りも同じ領域を食う）。`GECKO_PBL_STACKKB` で可変。
委譲パス込みで 20000 フレーム完走を確認。x.com での効果は次回リリースで検証。

## real-stack 形状別境界と host-charge（patch 0011-0013）

PBL 増量・quota 32MB 化の後も実機では `RangeError: Maximum call stack size
exceeded`（pthread 死亡）が残った。形状ごとにホスト（V8 wasm/JS）スタックの
実コストを計測した表:

| 再帰形状 | 実測境界（実~8MB想定） | 実コスト/level | 束縛する機構 |
|---|---|---|---|
| PBL 内部の JS→JS（map/forEach 経由含む薄い経路） | 300,000+ | ~25B | PBL shadow stack quota（catchable） |
| WJ→WJ（`call_indirect`/direct） | ~620-730 fat frames | ~800B（est） | WJ prologue byte-guard → flag 3.0 委譲 |
| 純 C++ 再帰（`JSON.stringify`） | ~3,250 | ~2.4KB | `AutoCheckRecursionLimit(hostCharge)` |
| getter/Proxy 越境（C++ dispatch 経由） | ~500-1,000 | ~4-8KB | `RunScript` host-charge |
| `WJ fn → wjhelp → host wasm → WJ fn` サイクル | ~50-200 | ~10KB+ | `WJChargeHostBoundary` |

重要な構造的事実:

- **越境（boundary）を挟む形状だけ桁違いに重い**。PBL 内部鎖は30万レベル
  耐えるが、C++ dispatch/helper を跨ぐ再帰は数百〜数千で実スタックを使い切る。
- `AutoCheckRecursionLimit` は ~100 サイトの C++ 再帰ガード集約点で、
  `hostCharge` 引数で **専用の `gWJHostDepth` アカウント**へ課金（RAII restore、
  上限 `gWJHostDepthLimit` = `GECKO_HOSTLIMIT` default 480000）。
  `SerializeJSONProperty` 2400、`RunScript` 4000（`GECKO_HOSTCOST`）、
  `js::CallGetter/Setter` 1500。**WJ バイト勘定とは分離**が要点:
  共有だと委譲後の PBL サブツリー（WJ bytes は高位のまま）が残り budget
  ~1-2 レベルで死ぬ。別勘定にしてから委譲可能な鎖は完走する
  （実測: plain 30000 / map 4000 / methcall 799 / wjcall 1199 完走、
  境界消費型の getter/JSON/sort-callback のみ catchable InternalError）。
- **`wjhelp` は委譲できない**（実行中フレームの途中）ので refusal は
  `ReportOverRecursed` + 1.0 threw 契約。ただし `WJH_CALL` は内部で
  suspend-watermark/flag-3.0 → `JS::Call` フォールバックを持つため charge
  免除 — 課金すると委譲可能な呼出を殺してしまう（実測: 免除でメソッド呼出鎖
  ~1200 が InternalError ではなく**完走**）。
- `WasmJitRunCall`（JS→WJ エッジ）の refusal は `return 0` = PBL 委譲
  （throw ではない）。`gWJSuspendWatermark` を latch して以降の JS→WJ は
  charge せず委譲する。
- **`GECKO_WJ_DEPTHLIMIT` は2系統で効き方が違った**: emit 側は const 焼き込み
  だが C++ charge 側は `gWJJitDepthLimit` を読み、calibration probe が上書き
  していた → `wj_set_depth_limit` で env を優先させ両者の budget を一致。

防御の結論: **実スタックは ~8MB で固定、増やせない**。できるのは
(a) 形状別に実コスト相当を課金して catchable 境界を実限界の手前に置く、
(b) 委譲可能な経路（WJH_CALL, RunCall, prologue flag-3.0）では throw せず
PBL ヒープスタックへ降りて完走させる、の2点。codex (gpt-6.1-sol max) との
壁打ちで「live-scope 加重 budget」として設計を確認 — fuel 計量ではなく
エントリ時 `saved + charge > limit` の拒否モデル。

**非決定的クラッシュ（2026-10 計測、未解決）**: 課金版ビルド（26664ef）で
wiki:lodash が 1 回 `RuntimeError: memory access out of bounds` で死亡したが、
課金あり・なし（`GECKO_WJ_HELPCOST=0`）両方でその後完走を確認 —
**boundary charge とは無関係の非決定的フレーク**。GC タイミング依存の
既存 bug の可能性。再現したら要追跡（wasm 関数 index が取れたので
symbolicate すれば箇所を特定できる）。helper refusal の例外経路自体は
`EmitExceptionExit`（trynote ありなら resumeInError→PBL unwind）で
通常の helper 例外と同型であり健全。
