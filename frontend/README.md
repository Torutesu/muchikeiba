# ムチ一閃 / Frontend prototype

横画面の競馬ジョッキーゲーム UI。グリーン・アイボリー・ゴールド、日本語の明朝・ゴシックと、3D相棒モデルを使ったブラウザプロトタイプです。小画面ではレイアウトを積み替えます。

## 起動とビルド

Node 24 を使用します。

```sh
cd frontend
npm ci --cache /tmp/muchi-npm-cache
npm run dev
# 静的サイトの生成
npm run build
```

開発サーバーは 5173 ポートで起動します。上部の画面セレクトで全10画面を確認できます。URL ハッシュの番号は0始まりです。

## 画面と操作

はじめに（規約同意）→ 最後の直線チュートリアル（仕掛けるを4回）→ 相棒の命名 → 初回無料10連スカウト → ホーム。

- ホーム：選択中の相棒、デイリーミッションの進捗と報酬受取、シーズン記録。
- 厩舎：名前検索、レアリティ絞り込み、評価順・名前順、検索結果なし、出走馬の選択。
- 馬詳細：能力ゲージ、スキル・適性タブ、出走馬にする操作。配合は開放条件の案内。
- 出走登録：コース・参加条件・出走馬、開始前の確認とキャンセル。フレンドコードは数字6桁を検証。
- レース：順位、残り距離、残り脚、折り合い、ムチ残数、内外のレーン移動、操作フィードバック。
- リザルト：上位4頭の着順表、タイム・着差、報酬内訳、受取済み、再出走。
- スカウト：10頭の固定結果、初回受取済み、提供内容の案内。
- ショップ：商品・価格・残高、生年月・同意の確認、未入力／未来の年月／未同意時の無効状態、確認完了。

命名、選択馬、デモ残高、受取状態は localStorage に保存します。デイリーは日本時間の日付で切り替わります。レース報酬は再読込後も重複受取を防ぎ、新しいデモレースの開始時に受取状態をリセットします。

`src/main.js` が画面、`src/details.js` が詳細操作と状態、`src/style.css` と `src/details.css` が共通の見た目、`src/presentation.js` / `src/showroom-renderer.js` が3Dを担当します。デザイン基準と画面別の変更は [design/DESIGN.md](design/DESIGN.md) を参照してください。

## デザイン書き出しと Figma

[全画面レビュー](design/review.html) で29種類を比較できます。

`design/screens.svg` を Figma にドラッグすると、基本10画面と詳細・状態違い・モバイルを含む29種類を取り込めます。個別 SVG と参照 PNG は `design/screens/`、画面名・サイズは `manifest.json` にあります。

`design/muchikeiba-figma-detailed.zip` は SVG・PNG・取り込み手順・名前付きフレームを作るプラグインのセットです。Figma デスクトップの Plugins → Development → Import plugin from manifest で同梱の manifest.json を選択して実行します。プラグインの Figma 実機動作は未検証です。

SVG は DOM の近似変換で、折り返し位置を保持した文字・図形と、埋め込み画像です。影・CSS グラデーション・フィルター等は完全には再現しないため、見た目は同名 PNG を参照してください。Figma への直接投稿、Auto Layout、再利用コンポーネント、プロトタイプ接続は含みません。

## 検証・再生成

開発サーバーを起動し、Playwright と `/usr/bin/chromium` のある環境で実行します。Playwright はアプリ依存関係には含みません。

```sh
node scripts/verify-details.cjs
node scripts/verify-presentation.cjs
node scripts/verify-fallback.cjs
node scripts/export-design.cjs
python3 scripts/package-design.py
npm run build
```

操作検証は初回導線、入力、スカウト、検索、馬選択、出走確認・キャンセル、フレンドコード、レーン操作、残り脚、報酬と再読込、購入確認を対象とします。1440 / 844 / 390px の全10画面で横はみ出しを確認し、ブラウザエラーと保存した馬名の HTML 混入も検出します。

## アート・3Dの再生成

通常の起動は同梱済みの WebP・GLB・フォントを使います。再生成する場合のみ Blender 4.3、Python の Pillow / fontTools / brotli、システムの Noto CJK が必要です。

```sh
# リポジトリのルートから実行
blender -b --factory-startup -t 8 --python-exit-code 1 --python frontend/scripts/build-showroom.py
python3 frontend/scripts/prepare-presentation.py
```

3種類のモデルは同じ解剖形状と馬具の規則から作り、毛色を頂点カラーで描きます。GLB には骨格と走行アニメーションを含みます。ショールームはドラッグ・ピンチ、レースはアニメーションと芝・レール・影の表示に対応します。WebGL 非対応時は静止画へ切り替えます。

3D は遅延読込で、静止画は WebP、フォントは必要字形のみです。書き出しの元になる PNG はビルド中間生成物で、配布版には WebP を使います。Figma 用 ZIP には OTF とフォントのライセンスも含みます。Three.js は MIT ライセンスです。

## 接続範囲

API・Unity・決済・オンライン対戦には接続していません。能力値、着順、報酬、シーズン記録は画面確認用です。スカウトの10頭は固定結果表示のみで、所属馬への追加は未接続です。購入確認で生年月を保存・送信せず、決済も実行しません。実際の提供割合・年齢別購入条件・命名NGリスト等は本接続時に実装します。

Unity の3Dアセットは `unity/`、別の全画面プロトタイプとギャラリーは `tools/figma-prototype/` と `tools/figma-gallery/` を参照してください。

### 配布用ビルドの確認

`npm run build` 後、`npm run preview -- --port 4173` を起動し、別のターミナルで `node scripts/verify-build.cjs` を実行します。最初の画面で3Dコードを読み込まないこと、必要時の3Dチャンク・GLB・フォントの読み込み、ショールームとレース、リソース失敗と JavaScript エラーがないことを確認します。

## Creative Atelier 01

`/creative/index.html` または画面上部の「素材一覧」から、背景・ロゴ・操作アイコン・クラス章・アイテム・枠・状態表示・材質・動き・音・告知テンプレートの112点を確認できます。SVG93点のPNG書き出し、Figma用固定色アイコン、白アルファのUnity向けアトラス、17材質のBlenderライブラリを含みます。

[制作・使用ガイド](design/creative/GUIDE.md) と `public/creative/manifest.json` が素材台帳です。原版と生成プロンプトを保管し、背景の推奨文字エリア・sRGB/PBR設定・枠の保護幅・音の音量・reduced-motionの扱いまで記録しています。

`design/creative/muchi-creative-kit.zip` は素材一覧、原版PNG、SVG、派生PNG、編集用告知データ、音、Blender材質、フォント、制作スクリプトの配布セットです。再生成手順はガイドを参照してください。ホーム・スカウト・シーズンパスには新しい背景を適用しています。
