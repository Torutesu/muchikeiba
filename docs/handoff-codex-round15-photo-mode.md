# Round 15 Codex 向け引き継ぎ：フォトモード（REQ-PHOTO-001〜018）

更新：2026-11-09　基準ブランチ：`feat/r15-photo-mode`（`main` = Round 13 統合後）
仕様：`contracts/protocol.md` §38、`docs/spec/requirements.md` 38章、法務 `docs/planning/03-legal-risk.md`「フォトモード」。経済の目標（E）は無し（何も配らない。品の購入は既存の見た目ショップ）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・カメラの計算・ビューモデル）／Codex＝見た目（カメラリグ・ポストプロセス・オーバーレイの絵・画面・書き出し）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `server/master/photo.json`（ルック5・フレーム7・スタンプ6、解放の条件）、`GET /v1/photo/catalog`、写真の記録 `GET/POST/DELETE /v1/photos`（冪等キー、30件まで）、KPI `photo_save`。品の購入は既存の `POST /v1/shop/cosmetics/:itemId/buy`（`items.json` の `kind: "photo"`） |
| C# | ✅ `engine/Muchi.Client/PhotoMode.cs`：`PhotoSnapshot`（レースをその tick まで計算し直す。走っているレースには触らない）、`PhotoCamera`（範囲とコースの下に入らない高さ）、`PhotoNames`（名札の伏せ方）、`PhotoCaption`（端末での事前チェック）、`PhotoShareCard`（`ShareCard.Photo` にオーバーレイ）、`ApiClient.GetPhotoCatalogAsync` / `GetPhotosAsync` / `SavePhotoAsync` / `DeletePhotoAsync`、`AnalyticsEvent.PhotoTake` / `PhotoShare`、`AssetKeys.PhotoLook/Frame/Stamp` |
| ゲーム層 | ✅ `Muchi.Game.PhotoModeModel`（`unity/Assets/Muchi/Game/PhotoModeModel.cs`、チェックは `unity/Checks~/GameChecks/PhotoModeChecks.cs`） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：タイムアタック中の「フォト」、結果画面の「写真を撮る」、リプレイ共有の「この瞬間を撮る」。ランク戦の HUD では「フォト」が鍵付き（押すと説明だけ） |
| **Codex** | カメラリグ（§3）、ポストプロセスのルックと被写界深度（§4）、オーバーレイの絵（§5、一覧）、撮影画面（§6）、書き出し（§7） |

## 2. 入口と流れ

```csharp
// レースのポーズメニュー（ひとりで走るレースだけ）
if (PhotoModeModel.CanPause(driver)) ShowPhotoButton();          // ランク戦・フレンド戦・イベント・大会では出さない
var pm = PhotoModeModel.OpenPaused((OfflineRaceDriver)driver, new ApiPhoto(backend.Api), raceId, courseName, friendNames, () => backend.Online, analytics.Track);
// 結果画面（どのモードでも、終わったレース）
var pm = PhotoModeModel.OpenFromResult(driver, api, raceId, courseName, friendNames, ...);
// リプレイ再生（Round 9 のリプレイ共有、§37 マイリプレイが入ったらその再生画面からも同じ呼び方）
var pm = PhotoModeModel.OpenFromReplay(config, inputs, tick, playerSlot, mode, raceId, api, visuals, courseName, friendNames, ...);
await pm.LoadCatalogAsync();      // オフラインでも無料の品で撮れる
...
pm.Close();                       // ポーズしたレースはここで再開（止めていた時間は数えない）
```
- 開いている間、走っているレースは止まったまま（`OfflineRace.Pause`）。写真は `pm.Snapshot`（計算し直した写し）から作る。**レースの `RaceSim` を写真のために進めたり戻したりしない**。
- `pm.Pose()` が毎フレームの置き方（`PosedPhoto`：全馬の `WorldPose`、カメラの `WorldCameraShot`、`Dof`、`LookAsset`）。リプレイ共有と同じ `CourseFrame` の変換なので、`RaceWorld` の置き方をそのまま使える。
- 写真は1つの tick なので、**馬のアニメーションも止める**（走りのポーズ1枚。見本は脚の位相を固定）。ムチ・スキルのエフェクトは `Snapshot.States[slot].IsWhipActive / IsSkillActive` を見て、その瞬間の1コマを出してよい。

## 3. カメラリグ（Codex）

`pm.Shot`（`RaceCameraShot`、コース座標）→ `CourseFrame.ToWorld` で置く。値は `pm.Spec.Camera`（整数）：

| 値 | 範囲（`photo.json config.camera`） | 操作（見本） |
|---|---|---|
| `OrbitDeg` | −180〜180（0 = 馬の真後ろ、90 = 外側、180 = 正面） | 1本指の横ドラッグ（見本は ±15°のボタン）。範囲の端は回り込む |
| `DistanceDm` | 20〜200（2〜20 m、水平距離） | ピンチ（見本は寄る／引く ±1 m） |
| `HeightDm` | 3〜100（0.3〜10 m）。**0.3 m より下には絶対に置かない**（コースの下に入らない） | 1本指の縦ドラッグ |
| `FovDeg` | 20〜70 | 望遠／広角 |
| `Dof` | 0〜3 | ぼかしの強さ（§4） |
| `FocusSlot` | 0〜頭数−1 | 馬をタップでその馬に注目（`pm.Focus(slot)`） |

- 操作はすべて `pm.Orbit / Zoom / Raise / Fov / SetDof / Focus / ResetCamera` を通す（範囲で止める）。Unity 側で値を直接書かない。
- 柵・スタンドとの当たり：カメラがコースの外の物体（柵・看板）にめり込む位置になったら、**見た目の側で**カメラを手前に寄せる（near clip / spring arm）。サーバーに送る値は変えない（作り直した時の差は許容）。
- 注目の馬は常に画面に入る（見本は `RaceCameraRig.InFrame` で確認）。

## 4. ポストプロセス（ルック・被写界深度）

ルックは**すべて無料**（サーバーの検査で強制）。アセットキー `photo/look/<id>`（LUT か Volume Profile）、未着は `photo/look/default`（＝ナチュラル）。

| id | 名前 | 狙い（見本の CSS は目安） |
|---|---|---|
| `natural` | ナチュラル | そのまま（レース画面と同じ） |
| `film` | フィルム | 少し黄みと粒子、コントラスト弱め（`sepia(.28) contrast(1.06)`） |
| `mono` | モノクロ | 白黒、締まった黒（`grayscale(1) contrast(1.08)`） |
| `dusk` | 夕暮れ | 夕方の橙、少し暗く（`sepia(.45) hue-rotate(-18deg) saturate(1.25) brightness(.9)`） |
| `vivid` | ビビッド | 芝の緑・勝負服を鮮やかに（`saturate(1.55) contrast(1.1)`） |

- 被写界深度：`Dof` 0 = なし、1〜3 = 注目の馬（`FocusSlot`）にピントを合わせた Bokeh の強さ。焦点距離はカメラと注目の馬の距離。モバイルの低画質設定では軽いガウスぼかし＋ビネットに落としてよい。
- 写真に HUD（残り距離・着順・タイム）は**入れない**。

## 5. オーバーレイの絵（一覧）

アセットキーは `contracts/assets.md`（`photo/frame/<id>`・`photo/stamp/<id>`、各 kind の `default` が未着時）。フレームは 16:9 の画像の上に重ねる枠（中央は透明）。スタンプは文字の入らない絵（英語でもそのまま使える）。

| キー | 名前 | 解放 | 絵の方向 |
|---|---|---|---|
| `photo/frame/plain` | シンプル | 無料 | 白い細い縁、角は少し丸く |
| `photo/frame/gate` | ゲート | 無料 | ゲートの鉄枠を思わせるシアンの二重線 |
| `photo/frame/victory` | 勝利の額縁 | 実績「勝利の記録」1段目 | 金の額縁、控えめな月桂樹 |
| `photo/frame/champion` | 王者の額縁 | 実績「勝利の記録」3段目 | 厚い金の額縁、上に小さな冠 |
| `photo/frame/ta_gold` | 金時計 | 実績「タイムアタック 金」1段目 | 金色の時計の目盛りが縁を回る |
| `photo/frame/sakura` | 桜吹雪 | 見た目ショップ 150コイン | 縁に桜の花びらが舞う |
| `photo/frame/gold_leaf` | 金箔 | 見た目ショップ 300コイン | 和紙に金箔の縁 |
| `photo/stamp/muchi` | 筆文字 | 無料 | 筆の一閃（文字は入れない。墨の払い） |
| `photo/stamp/hoof` | 蹄あと | 無料 | 蹄鉄のあと2つ |
| `photo/stamp/star` | きらり | 無料 | 光のきらめき |
| `photo/stamp/photo_finish` | ハナ差 | 実績「上位の常連」1段目 | 写真判定の縦線と鼻先のシルエット |
| `photo/stamp/crown` | 王冠 | 実績「大会の覇者」1段目 | 小さな王冠 |
| `photo/stamp/carrot_pop` | にんじんポップ | 見た目ショップ 100コイン | ポップなにんじん |
| `item/photo_frame_sakura` ほか3つ | （ショップのアイコン） | — | 見た目ショップの一覧に出るアイコン（`item/<itemId>`） |

- 実在のブランド・ロゴ・競馬場・レースの名前は入れない（03）。
- ゲームのロゴ（ウォーターマーク）は既存の共有画像のもの（`ShareCard.Watermark`、右下）。

## 6. 撮影画面（「ムチ一閃」のトーン）

見本と同じ構図：**3D の全面の上に、左の 1000×566 がファインダー（シアンの細い縁）、右に紺の半透明パネル（510×840）、主ボタン（斜めのシアン »、金）は「撮影する」1つ**。

- ファインダーの上に小さなチップ：「レースを一時停止中　残り ◯ m」／「レース結果から」／「リプレイから」。
- 右パネル：キッカー「フォトモード」、タブ5つ（カメラ／ルック／フレーム／スタンプ／ひとこと、choice 部品）。一度に1つのタブだけ出す（情報を詰めない）。
  - フレーム・スタンプの鍵付きの品：名前は暗く、鍵の印。タップでシート：サーバーの `unlockText` をそのまま（「実績「勝利の記録」の1段目で解放」「見た目ショップで購入（150コイン）」）。`Buyable` の品だけ「コインで買う」（既存の購入、コイン不足は §29 のシート）。**価格の横に「お得」「今だけ」などは付けない**。
  - スタンプは3つまで。ファインダーの上でドラッグして動かす・ピンチで大きさ・2本指で回転（`pm.MoveStamp`）。
  - ひとこと：入力欄（`Catalog.CaptionMaxChars` 文字まで）、決定で `pm.SetCaption`。`CaptionProblem` があれば警告色で1行。**ひとことは翻訳しない**（英語の画面でもプレイヤーが打ったまま）。
- 下に「名前を隠す／名前を表示」（`pm.ToggleNames`）と「UIを隠す」（`pm.ToggleHideUi`：右パネルとチップを消し、右上に小さな「UIを表示」だけ残す）。
- 名札：`pm.Plates` を馬の頭の上に（見本は `view.project` の位置）。自分は金の下線、他は白。中身は「あなた」・フレンドの表示名・`p<枠>`・CPU（`PhotoNames`）。**フレンドでない人の名前は出さない**。
- 一番下：「レースに戻る」（ポーズから開いた時）／「戻る」。

## 7. 書き出しと共有

- `pm.Take()`（シャッター：KPI `photo_take`）→ 共有シート：カード（ロゴ・馬名・コース・モード・重ねた品）と「共有する」「写真を保存」。
- 「共有する」＝ `pm.ShareAsync(recorder, sheet, applyPose)`：既存の `IClipRecorder.CaptureStillAsync(frame, card)` に `card.Photo`（`PhotoOverlay`：`LookAsset`・`FrameAsset`・`StampAssets`＋`Stamps` の位置・`Caption`・`Plates`・`Dof`）が乗る。**レコーダーはこのオーバーレイを描いて PNG にする**（リプレイ共有の静止画と同じ大きさ・同じロゴの位置）。共有した時だけ `photo_share` が送られる。
- 共有の文（`card.ShareText`）は「馬名　コース　ひとこと　#ムチ一閃」。他人の名前・ID は入らない。
- 「写真を保存」＝ `pm.SaveAsync()`：サーバーには画像ではなく小さな記録だけ（`PhotoSpec`）。オフラインは「写真の保存はオンラインでできます。共有はこのままできます」、30件で `FullText`。画像を端末のアルバムに保存する機能を付ける場合は OS の権限の説明（写真へのアクセス）を出す。

## 8. 確認のしかた

- `dotnet run --project 'unity/Checks~/GameChecks'`（フォトモードのチェックが通ること）。
- 見本：`bash tools/figma-prototype/build.sh` → `site/index.html`。タイムアタックを始めて「フォト」、結果画面の「写真を撮る」、リプレイ共有の「この瞬間を撮る」。英語は EN ボタン。
