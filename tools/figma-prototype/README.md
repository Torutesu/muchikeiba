# ムチ一閃 — 全画面アプリプロトタイプ（Figma コードレイヤー用）


入口は 2 つです。どちらも同じ本物のロジック（サーバーのドメイン）と本物のレースエンジン（WebAssembly）で動きます。

| 入口 | 中身 |
|---|---|
| `index.html`（クラブ版 UI） | Codex の `frontend/`（緑・アイボリー・金のデザイン）。`frontend/design/screens` の詳細画面 25 枚すべてが、本番の流れの中の画面として動きます。 |
| `unity.html`（Unity 版 UI） | Codex の Unity フロント（`MuchiApp.cs`）を HTML に移したもの。以下の節で説明します。 |

## クラブ版 UI（index.html）

Codex の `frontend/src/main.js`・`details.js` のマークアップとクラス名をそのまま使い、固定のデモデータを本物に差し替えています（`site/club/main.js`）。
スタイルは Codex の `frontend/src/style.css`・`details.css` を `build.sh` が `site/club/codex/` にコピーします（Codex が直すとそのまま反映されます）。

| 画面 | つながっている本物の処理 |
|---|---|
| 01 はじめに → 02 初めての直線 | 同意しないと始められない。レースは WASM エンジンのチュートリアル（400m）。順位・残り距離・スタミナ・ムチ・実況・内外の進路をエンジンの HUD から表示 |
| 03 命名 / 22 名前エラー | サーバーと同じ命名規則（カタカナ 2〜9 文字、ひらがなは変換、NG 語は `ng-names.json` で弾く） |
| 04 無料スカウト / 17 結果 / 18 提供内容 | 初回無料 10 連（`tutorialDraw`、ppm 表・SR 以上保証）。提供割合は抽選と同じ表から表示（レアリティ合計・10 枠目・天井・個別） |
| 05 ホーム / 21 受取後 | ログインボーナス（7 日周期）とデイリーミッション 3 本（出走・勝利・3 着以内）の受取、シーズンのクラスとポイント |
| 06 厩舎 / 11 能力 / 12 スキル・適性 / 13 該当なし | 所属馬（能力値・脚質・距離・馬場適性・血統）。検索・レアリティ絞り込み・並び替え・出走馬の選択。所属馬 0 頭のときの空表示 |
| 14 配合 | 引退した牡馬と牝馬がそろうまでは開放条件を表示。そろうと `breedingPreview`（能力の幅・ニックス・インブリード・今日の残り回数）と `breed`。馬の詳細から引退できます |
| 07 出走登録 / 15 出走確認 / 08 レース / 09 リザルト | 2000m・12 頭のレースを WASM エンジンで走り、確定した着順・タイム・着差を表示。報酬はサーバーと同じ表（着順別コイン・シーズンポイント・パス・ミッション進行）で精算（同じレースは一度だけ） |
| 16 フレンドルーム | ルームコードの入力に加え、部屋の条件（コース・馬場・ナイター・天気など）をサーバーと同じ検証で保存。オンライン接続はしません |
| 10 ショップ / 19 購入確認 / 20 確認完了 | 商品はマスターデータから。生年月で年齢区分・保護者同意・月額上限を確認（`setAge`・`purchaseIntent`）。**決済はしません** |
| 23〜25 モバイル | 上部の「レイアウト」で 自動 / PC / モバイル を切り替えます。自動は縦長の窓でモバイル表示。Codex の CSS の狭い画面用ルールを `html.layout-mobile` 付きで生成（`club-css.cjs`）するので、PC の窓でもモバイル表示を確認できます |

テスト用に `index.html?speed=4` でレースの時計を速められます。

---

## Unity 版 UI（unity.html）

Codex が作った Unity フロント（`unity/Assets/Muchi/Runtime/MuchiApp.cs`）を、ブラウザでそのまま触れる形にしたものです。
画面ごとの見本を並べたギャラリーではありません。本番と同じ流れで画面が切り替わり、どのボタンも押せます。
Figma にはコードレイヤーとして読み込みます。

- 画面は Unity と同じ 1600×900（CanvasScaler の基準解像度）で、16:9 のまま縮小し、余白は黒帯にします。
- 座標・色・文字サイズは MuchiApp の `Panel` / `Label` / `Button` の値をそのまま使っています。
- 文言は `Localization/ja.json` を使い、右上のボタンで日本語と英語を切り替えます。
- 画像は Codex の `Resources/Art`、フォントは Noto Sans CJK JP（使う文字だけに絞った woff2）です。

## 画面の流れ

タイトル → 初騎乗（チュートリアルレース 400m）→ 結果 → 相棒の命名（NG の場合は案内画面）→ 無料 10 頭スカウト → 結果 → ホーム

ホームから行ける画面：

- 厩舎
- スカウト（1回・10回、天井、提供割合）
- 衣装（相棒の着せ替え）
- 競馬場（コースの見た目）
- レース条件
- お世話・餌
- ショップ（コイン・衣装・コーステーマ）→ 購入確認 → 年齢確認
- シーズンパス
- レースへ → 出走確認 → レース（2000m・12頭）→ 結果 → ホーム

戻るボタンはどの画面にもあります。状態は `localStorage` に残るので、再読み込みしても続きから遊べます（タイトルから始め直すときは `localStorage.clear()`）。

## 本物のロジックと、端末だけで動かしている部分

| 部分 | 中身 |
|---|---|
| レース | **本物のエンジン**です。`engine/` の C# と、Unity のゲーム層（`Assets/Muchi/Game`：RaceFactory・RaceInput・RaceDrivers・HudModel・CommentaryFeed・CourseFrame）を .NET 8 で WebAssembly にしたものを動かしています（`engine-wasm/`）。ゴールデンレース 4 本の結果ハッシュが C# 版と一致することを `build.sh` で毎回確認します。 |
| レースの 3D 表示 | `RaceWorld.cs` を three.js に移したものです。<br>・コースは本物のコース形状（TrackGeometry → CourseFrame、ゴール z=420）<br>・スタンド・ゴール板・空・霧・日差しも RaceWorld と同じ値<br>・Codex の FBX 相棒モデルに PartnerGallop と同じ脚の動き<br>・追いかけカメラも RaceWorld.Present と同じ（FOV 57、後ろ 6.5m・上 3m、前方 9m を注視） |
| HUD・実況 | Unity の HudModel と CommentaryFeed の出力をそのまま表示します。位置も MuchiApp と同じです。 |
| 操作 | ←/→ で進路、E で仕掛け（ムチ）、Space 長押しで手綱。画面のボタンでも操作できます。 |
| スカウト・命名・ショップ・パス | **本物のサーバードメイン**です。`server/src/domain` を esbuild でブラウザ用にまとめています（`logic/entry.ts` → `site/js/logic.js`）。<br>・ガチャの ppm 表、10 連の保証、天井<br>・提供割合（抽選と同じデータから表示）<br>・名前はカタカナ 2〜9 文字で、ひらがなはカタカナに変換、NG ワードは弾く<br>・年齢確認、シーズンパス |
| 端末だけの部分 | ・保存先はサーバーではなくブラウザの `localStorage`<br>・プレイヤー ID は固定で `local`<br>・開始時に無償コイン 1,200 を付与（1 回だけ）<br>・購入は確認画面まで（**課金処理はしません**）<br>・レースは練習扱い（オフラインのドライバー）なので、ランクポイントは動きません<br>・衣装・コースの見た目・お世話は Unity 版と同じく端末内の設定です |

## 作り直し方

必要なもの：Node 22、.NET 8 SDK（`wasm-tools` ワークロード）、Python 3 と Pillow・numpy・fontTools。

```bash
dotnet workload install wasm-tools
```

```bash
tools/figma-prototype/build.sh
```

`build.sh` が行うこと：

1. ロジックをバンドル
2. エンジンを WebAssembly に変換
3. 素材をコピー（画像の縮小、相棒の切り抜き、FBX モデル、フォントの絞り込み）
4. ロジックとエンジンのテスト

生成物（`site/js/logic.js`、`site/engine/`、`site/art/`、`site/data/`、`site/fonts/`、`site/models/`）は git には入れません。three.js（MIT）は `site/vendor/three/` にそのまま入れてあります。

確認用のコマンド：

```bash
node tools/figma-prototype/test/e2e.cjs
```

```bash
node tools/figma-prototype/test/render-design.cjs unity/design/figma-screens tools/figma-prototype/.compare
```

```bash
python3 tools/figma-prototype/test/compare.py . tools/figma-prototype/.screens tools/figma-prototype/.compare
```

- 1 本目は Chromium でクラブ版（25 画面＋モバイル、`club-*.png`）と Unity 版の全画面を通しでクリックします。コンソールエラーが 0 件であることを確認し、1280×720 の画面写真を `.screens/` に保存します。
- 2 本目と 3 本目は、Codex の `frontend/design/screens`（クラブ版）と `unity/design/figma-screens`（Unity 版）と並べた比較画像を `.compare/cmp-*.jpg` に作り、画素の差を数値でも出します。

手元で動かすときは、`site/` を静的サーバーで配信します（WebAssembly を使うので `file://` では動きません）。

```bash
python3 -m http.server -d tools/figma-prototype/site 8080
```

## Figma への読み込み

`build.sh` のあとの `site/` 一式（約 33MB、圧縮後は 40MB 未満）を Figma のコードレイヤーとして読み込みます。入口は `index.html`（クラブ版）で、ツールバーから `unity.html` に移れます。
フレームは 16:9（例：1600×900 または 1280×720）にしてください。中の画面は自動で拡大縮小します。

## Codex のデザイン画（figma-screens）との違い

デザイン画は完成イメージの一枚絵です。このプロトタイプは Unity の実装（MuchiApp）に合わせています。そのため、次の点が違います。

- ホームのメニュー配置や、ボタンの斜めの形など、MuchiApp 側でまだ実装されていない装飾があります。
- レースは、デザイン画の写真のような背景ではなく、RaceWorld の 3D 表示です（箱でできたスタンドと単色の空）。
- 結果画面には、実際の着順の一覧を足しています。
