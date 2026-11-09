# Round 14 Codex 向け引き継ぎ：勝負服エディタ（REQ-SILK-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r14-silks-editor`（`origin/main` から）
仕様：`contracts/protocol.md` §35、`docs/spec/requirements.md` 35章、法務：`docs/planning/03-legal-risk.md`（直販・有償/無償の分離・コンプガチャ）

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（3D の騎手の塗り分け・画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/silks/editor`・`POST /v1/silks/preview`・`PUT /v1/silks`・`POST/PUT/DELETE /v1/silks/presets[/:slot]`・`POST /v1/silks/presets/:slot/apply`・`POST /v1/silks/parts/:itemId/buy`・`POST /v1/silks/notice-seen`。パーツの定義 `server/master/silks-editor.json`、直販のパーツ `server/master/items.json`（`kind: "silks_part"`）。KPI `silks_edit` / `silks_part_buy` |
| 共通コード | ✅ 17文字の `code`（`1`＋36進2桁×8）。TS `silksEditor.ts` と C# `SilksCode` が同じテストベクタ `contracts/silks-code.vectors.json` で一致 |
| C# | ✅ `engine/Muchi.Client/SilksEditor.cs`：`SilksCode`（`Encode`/`Decode`/`OfSilks`）、`SilksDesign`（`FromLegacy`）、`SilksCodeTables`、`SilksEditorView`・`SilksPart`・`SilksPreset`・`SilksPreview`、`ApiClient.GetSilksEditorAsync` ほか。`Silks.Code`/`Sleeve`/`CapColors` |
| ゲーム層 | ✅ `Muchi.Game.SilksEditorModel`（`unity/Assets/Muchi/Game/SilksEditorModel.cs`、チェック `unity/Checks~/GameChecks/SilksEditorChecks.cs`）。英語は `ui-en.json` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → 相棒の着せ替え（Wardrobe）→「勝負服エディタ」、またはショップの見た目タブの「勝負服のパーツ」カード。中身は本物のサーバーのコード。プレビューは写真の騎手を canvas で塗り替える方式（§3） |
| **Codex** | 3D の騎手の塗り分け（§2）、エディタの画面（§4）、パーツのサムネイルとアイコン（§5）、レース・他の画面で他人の勝負服を描く（§6） |

## 2. 3D の騎手の塗り分け（マスク＋シェーダー）— いちばん大事

勝負服は**パーツの組み合わせを色で塗る**。模様ごとにメッシュやテクスチャを作り分けない（組み合わせが数万になるため）。

### 2.1 入力（`SilksDesign`、`SilksCode.Decode(code, tables)` で得る）
- 胴：`Pattern`（19種、`silks/pattern/<id>`）と `Colors[0..2]`（地・模様・3色目。2色の模様は2つ）
- 袖：`Sleeve`（8種、`silks/sleeve/<id>`。`match` は胴の模様を袖まで続ける、`plain` は胴の2色目の無地、ほかは胴の1色目＝地／2色目＝模様）
- 帽子：`Cap`（8種、`silks/cap/<id>`）と `CapColors[0..1]`
- 色は**すべて hex**（`SilksEditorView.Colors[].Hex`。基本16色は `visuals.json` の palette と同じ値、特別色6色は `silks-editor.json` の hex）。色のテクスチャは作らない。

### 2.2 騎手のメッシュに必要なもの（Codex）
1. **領域マスク**（1枚、RGB）：R＝胴、G＝袖、B＝帽子（帽子のつばを模様で塗る `peak` のため、A にツバ＝1 を入れる）。騎手の顔・手袋・ブーツ・ゴーグルは 0（塗らない）。
2. **模様マスク**（パーツごとに1枚のグレースケール or 2ch）：胴は UV の胴の範囲、袖は腕の UV に沿って（u＝肩→手首）、帽子は帽子の UV。値の意味：0＝1色目、0.5＝3色目、1＝2色目（2ch にするなら R＝2色目の強さ、G＝3色目の強さ）。アセットキーは `silks/pattern/<id>`・`silks/sleeve/<id>`・`silks/cap/<id>`（`contracts/assets.manifest.json` に全部入っている。無いものは `<kind>/default` に落ちる）。
3. **シェーダー**（Built-in RP の Surface Shader で十分）：
   ```
   region = tex(RegionMask, uv)
   body   = lerp3(C0, C1, C2, tex(BodyPattern, uvBody))
   sleeve = Sleeve == match ? body : lerp(C0, C1, tex(SleevePattern, uvSleeve))
   cap    = lerp(Cap0, Cap1, tex(CapPattern, uvCap))     // peak は A のツバだけ Cap1
   albedo = region.r*body + region.g*sleeve + region.b*cap + (1-sum)*baseAlbedo
   ```
   シルクの光沢（スペキュラ・異方性）は今の騎手のマテリアルの値をそのまま使う。**明るさ（陰影）は元のテクスチャから取り、色だけ差し替える**（見本の canvas と同じ考え方）。
4. マテリアルは `MaterialPropertyBlock` で騎手ごとに色・模様テクスチャを渡す（12頭立てでマテリアルを複製しない）。模様テクスチャは 256×256 で十分（レース中は小さい）。オポネントの LOD も同じシェーダー。
5. 既存の5種の騎手の見た目（`Partner_*` の勝負服：紅・蒼・紫・翠・金）は **既定の勝負服を持たないプレイヤーの近似**として残してよいが、`code` があるときは必ず塗り分けを優先する。

### 2.3 見本の canvas との対応（参考）
`site/app.js` の `silkIdx`（胴）・`sleeveIdx`（袖）・`capIdx`（帽子）が模様マスクの中身の見本（u, v は各領域の 0〜1）。写真の騎手は紫の勝負服の画素を色相で拾ってマスクにしている（`silksMaskOf`）。Unity では写真ではなく §2.2 のマスクで正確に塗る。

## 3. 見本のプレビュー（そのまま 2D の代替にも使える）
- 素材：`Art/3DPreviews/Partner_DappleGrey_Violet`（芦毛・紫）。紫の画素（色相 250〜322°、彩度・明度の下限、画像の上から 40.5% まで＝ゼッケン布は除く）をマスクにし、上 28.5% を帽子、右（x>54.5%・y≥30%）を袖、残りを胴に分ける。
- 画素ごとに「領域の中の位置 → 模様 → 色」を決め、元の明るさ（輝度 ÷ 0.56）を掛ける。
- Unity が 3D で描けない画面（ショップの一覧のサムネイルなど）は、この方式で 2D の立ち絵を塗ってもよい。

## 4. エディタの画面（`SilksEditorModel`）
見本と同じ構成。1600×900 で：

- **上**：タイトル「勝負服エディタ」、副題「見た目のみ。パーツは抽選ではありません（固定の価格・条件）」、財布（有償・無償を分けて）。
- **左（640×676）**：ライブプレビュー（3D の騎手を正面斜め、ゆっくり回せる）。持っていないパーツを選んでいる間は左上に金の「**試着中**」（`IsTryingOn`）、下に「持っていないパーツ n点」「買う場合の合計：200コイン　＋　有償コイン400（有償限定）」（`PurchaseLines()` の合計）。遊んで解放するだけのパーツは「遊んで解放するパーツです（購入はできません）」。
- **右（872×676）**：タブ（胴の模様／色／袖／帽子、`SilksTab`）。色のタブは「胴1・胴2・(胴3)・帽子1・帽子2」（`ColorSlot` 0〜4）。パーツのカード（`Cards()`）：サムネイル・名前（サーバーの文字、英語はサーバーが訳す）・状態。
  - 持っていない：金の線、「LOCK」、下に `LockLine`（サーバーの文：`コイン200で購入`／`有償コイン400で購入`／`実績「勝利の記録」の2段目で解放`／`レースを50回走ると解放`）。**押せる**（試着）。選んでいる時は「試着中」。
  - 読みやすさ：`LowContrast` のカードは半透明＋「見分けにくい」（ペアの相手の色との組がサーバーの `lowContrastPairs` に入っている）。**クライアントで色差を計算しない**。
- **下**：プリセット5枠（`Slots()`／`SlotLabel()`。空きは「空き」、返金で使えないものは名前＋「（使えないパーツがあります）」）。押すと：空き→保存、使える→適用（`ApplyPresetAsync`）、使えない→下書きに読み込んで試着。主ボタン（斜めのシアン »）は「保存する」1つ。試着中は「保存（入手が必要）」→ 足りないパーツのシート。
- **足りないパーツのシート**：パーツごとに1行（種類・名前・`SourceLabel`）、直販のものだけ「購入を確認」。
- **購入の確認**（既存の見た目の購入確認と同じ見た目）：名前、価格（`PriceText`）、`CurrencyNote`（「有償コインから先に使われます」／「有償限定（有償コインのみ）」）、所持（有償／無償）と使う内訳、「一度買えばずっと使えます（期限なし）」。「購入する」→ `BuyAsync`（冪等キーは成功するまで同じ。二重課金にならない）。コイン不足は既存の T6 シート（`CoinShortfallModel`、`ShortfallContext.CosmeticShop`）。
- **返金のお知らせ**（`ResetNotice`）：開いた時に1回だけ。閉じたら `MarkNoticeSeenAsync`。
- 禁止：「今だけ」「残りわずか」「お得」「倍」・残り時間・通常価格・点滅。セット割・まとめ買いの表示は無し（パーツは1つずつ）。

## 5. 必要な絵とアイコン
| キー | 内容 | 数 |
|---|---|---|
| `silks/pattern/<id>` | 胴の模様マスク（§2.2） | 19（既存。マスク形式に作り直し） |
| `silks/sleeve/<id>` | 袖の模様マスク（新規の kind） | 8 |
| `silks/cap/<id>` | 帽子の模様マスク（spots・checks・diamond は新規） | 8 |
| `silks/color/<id>` | 特別色の見本アイコン（ショップの一覧用の丸いチップ。色そのものは hex） | 3（直販の特別色） |
| `item/silkpart_*` | 直販パーツのアイテムアイコン（ショップの見た目タブ・プレゼントボックス） | 7 |

エディタのサムネイルは見本のように**今の下書きの色**で模様を描く（48×48 のマスクに色を掛けるだけ）。

## 6. 他のプレイヤーの勝負服を描く（レース・プロフィール・厩舎・ライバル）
- レースの `start.visuals.entrants[].silks`・公開プロフィール・厩舎の写し・ライバルのカードの `silks` に `code` が入る（エディタで作った人だけ）。**`SilksCode.OfSilks(silks, tables)` を使えば旧い勝負服にもコードが出る**ので、描く側は常にコード → `SilksDesign` → §2 の塗り分け、の1本でよい。
- `tables` はエディタのカタログ（`GET /v1/silks/editor` の parts の `code`）から作る（`SilksCodeTables.From`）。起動時に1回取ってキャッシュしてよい（`version` が同じなら変わらない）。
- コードに知らない番号がある（古いクライアント・パーツの追加前）→ `Decode` が null → 旧いキー（`pattern`/`colors`/`cap`）で描く。
- 勝負服はレースの能力・結果に一切関係しない（結果ハッシュにも入らない）。

## 7. 確認したこと（Claude 側）
- サーバー：`server/test/silks-editor.test.ts`（コードのベクタ、マスターの検証、所持・実績・レース数、読みやすさ、実在の勝負服＋袖・帽子の色、試着、保存、プリセット、直販（有償から先・有償限定・冪等・二重購入・コイン不足の案内）、返金で既定に戻す・プリセットは使えない印、英語）
- C#：`engine/Muchi.Engine.Tests/SilksCodeTests.cs`（TS と同じベクタ、API の形）
- ゲーム層：`SilksEditorChecks`（試着中・保存の拒否・冪等キー・有償限定の文・見分けにくい・3色の模様・プリセット）
- 見本：`test/unity-flow.cjs` の `silksFlow`（試着 → シート → 購入確認 → 保存、有償限定 → T6、プリセット、ショップのカード）と `test/en-flow.cjs`（英語で日本語が残らない・はみ出さない）
