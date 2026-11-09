# Round 15 Codex 向け引き継ぎ：アクセシビリティ設定（REQ-A11Y-001〜016）

更新：2026-11-09　基準ブランチ：`feat/r15-accessibility`（`origin/main` から）
仕様：`contracts/protocol.md` §41、`docs/spec/requirements.md` 41章、UX：docs/planning/06 §11（REQ-UXA-001〜010）、色：`contracts/a11y-tokens.json`

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・設定のモデル・トークン・入力の補助）／Codex＝見た目（画面・HUD・アニメーション・音・触覚の実装）**。
このラウンドは「新しい画面1枚」に加えて、**すべての画面が守る決まり**がある（§3）。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET`/`PUT /v1/settings/accessibility`（PUT は全体の置き換え・冪等）、`GET /v1/player`・bootstrap の `accessibility`、KPI `a11y_setting_change` |
| C# クライアント | ✅ `AccessibilitySettings`・`ApiClient.GetAccessibilityAsync`／`SetAccessibilityAsync`・`PlayerView.Accessibility`・`AccessibilityTokens`・`TextScale`・`MotionPolicy`・`FlashLimiter`・`WhipHold`（`engine/Muchi.Client/Accessibility.cs`） |
| ゲーム層 | ✅ `Muchi.Game.AccessibilityModel`（`unity/Assets/Muchi/Game/AccessibilityModel.cs`）、`GameBackend.Accessibility`＋`AccessibilityChanged`、`RaceInput.WhipMode`／`SetWhipHeld`／`Collect(RaceSim, int)`。チェック `unity/Checks~/GameChecks/AccessibilityChecks.cs` |
| 見本 | ✅ `tools/figma-prototype/site/index.html` → その他 → 「アクセシビリティ」。文字の大きさ・色覚サポート・動きを減らすは**見本の全画面に実際に当たる**。レースは本物のエンジンで長押しのムチ・片手レイアウト |
| **Codex** | 設定の画面（§2）、全画面の決まり（§3）、レースの HUD（§4）、ガチャの演出（§5）、触覚・字幕（§6）、起動時の同期（§7） |

## 2. 設定の画面「アクセシビリティ」

見本と同じ 1600×900 の構図（見本の `A11ySettings`）。背景 `Art/home-paddock`＋暗いシェード、上の帯（`TopBar`、財布なし）、紺のパネル1枚に2列。

- 入口：その他（設定）の「見た目・お世話・仲間」の列の**一番上**に1行「アクセシビリティ ›」。**FTUE 中も出す**（最初のレースの前に文字を大きくできるように）。
- 行は `AccessibilityModel.Rows()` の順。左列 `Group == "display"`（表示）：文字の大きさ・色覚サポート・動きを減らす。右列 `"controls"`（操作・音）：字幕（実況）・振動・片手レイアウト・ムチの入力。
- 1行：名前（`Label`、21px、白、500）→ 説明（`Description`、14px、灰、2行まで）→ 右に選択ボタン（`Choices`、見本の `choice`：紺＋細い灰の枠、選ばれているものは**シアンの2px 枠＋薄いシアン**）。主ボタン（斜めのシアン）は使わない（保存ボタンも無い）。
- 押したら `SetAsync(row.Key, choice.Value)`。**その場で画面全体に当たる**（`AccessibilityChanged` で各画面が結び直す）。結果のトーストは `ActionResult.Message`（`TextSaved`／オフラインは `TextOffline`）。
- 色覚サポートの行の下に**見本の色**：ゲージ3色（`gauge.ok`／`gauge.low`／`gauge.critical`、critical は cvd で斜線）と順位の点（自分 `position.self` 大・他 `position.other` 小）。
- ムチの入力の行の下に `TextFairness`（「長押しはタップと同じ操作を決まった間隔で送るだけです。ランク戦の強さは変わりません。」）。**必ず出す**。
- パネルの下に細い線と `TextFlash`（「点滅は1秒に3回までに抑えています」）。
- 英語：全部 `Loc.T` 経由（`ui-en.json` に入っている）。英語・特大でもはみ出さない（見本で確認済み、`a11y-*-en.png`）。

## 3. すべての画面が守ること（REQ-UXA-001〜010）

| # | 決まり | どこから取るか |
|---|---|---|
| 1 | **文字の大きさ**：本文（設計で 28px 未満の文字・ボタン・字幕・HUD の小さな文字）は `TextScale.Px(base, settings.TextSize)`（×1.00／×1.15／×1.30）。見出し・大きな数字（28px 以上）はそのまま。ムチのボタンの文字（輪に合わせたアイコン扱い）は変えない | `AccessibilityModel.Px(base)` |
| 2 | **はみ出さない**：最大でも箱に入りきらない文字は、標準の大きさまで戻してよい（TextMeshPro の Auto Size：min = 標準、max = 拡大後）。**日本語は標準より小さくしない**（英語は 66% まで、従来どおり）。隣の文字に重なる・ボタンの文字が折り返す・パネルの下にはみ出すのも「入りきらない」に数える | `TextScale.MinPx(base, english)` |
| 3 | **色**：ゲージ（スタミナ・頭上のミニゲージ）・順位（ミニマップの点・頭上の三角）・状態の文字（成功／警告・エラー）・「今だ」のムチの光は**トークンから取る**。直に色を書かない。cvd でもシアン／紺の基調は同じ | `AccessibilityModel.Color(AccessibilityTokens.GaugeLow)` 等、`Palette` |
| 4 | **色だけで伝えない**：スタミナは文字（「脚が残り少ない」等）も出す。cvd の危険（10%以下・空）はゲージに**斜線の模様**（`CriticalHatch`）。cvd の自分の三角は少し大きく | `CriticalHatch` |
| 5 | **動きを減らす**（`Motion`）：カメラの揺れ ×`CameraShakeScale`（0）、ムチの FOV キック ×`FovKickScale`（0）、スピード線なし（`SpeedLines`）、背景のゆっくりしたズームなし（`BackgroundDrift`）、ゲージの点滅なし（`GaugeBlink`、色と文字だけ）、画面の切り替え・シート・ポップは `TransitionMs(normal)`（150ms 以下のフェード）。「今だ」の光・手綱の警告は点滅させず**光ったまま** | `AccessibilityModel.Motion` |
| 6 | **点滅は常に1秒に3回まで**（設定に関係なく）：繰り返す点滅は明暗1組の周期を 0.34 秒以上に（今の見本：スタミナ 2.5回/秒、ムチの光 1.1回/秒、手綱 0.8回/秒）。1回ずつの光（「伸びる！」「抜いた！」・ムチの当たり）は `AccessibilityModel.Flashes.TryFlash(nowMs)` が true の時だけ光らせる（false なら文字だけ）。画面の大部分を赤く光らせない | `FlashLimiter` |
| 7 | **振動**：`Haptics` が false なら一切振動しない（ムチ・追い抜き・スタミナ警告・固有スキル・ボタン） | `AccessibilityModel.Haptics` |
| 8 | **字幕**：実況の文字（レース・観戦・リプレイ）は `Subtitles` が true の時だけ（既定 true） | `AccessibilityModel.Subtitles` |
| 9 | KPI は送らない（サーバーが `a11y_setting_change` を出す） | — |

## 4. レースの HUD

- **片手レイアウト**（`OneHanded`、チュートリアル以外）：`Right` はムチ（今の位置）・手綱（その左）・内／外（手綱の左上に縦に2つ、見本 x=1110、y=520／636）。`Left` は左右を反転し、スタミナのプレートと操作の説明文を右側へ移す。`Off` は今まで通り。配置だけで、入力は同じ。
- **ムチの長押し**（`WhipInput == Hold`）：画面を開いた時に `AccessibilityModel.ApplyTo(raceInput)`。ムチのボタンは **押した時 `SetWhipHeld(true)`、離した・指が外れた・キャンセルで `SetWhipHeld(false)`**。毎フレーム `raceInput.Collect(driver.Sim, driver.PlayerSlot)` を渡す（**`Collect(HorseState)` から切り替える**：`unity/Assets/Muchi/Runtime/MuchiApp.cs` の 752 行目付近）。
  - 押した瞬間はタップと同じ（発走前は START、発走後は WHIP）。押し続けると §27 のムチだけおまかせと同じ間隔で、**1レースに `WhipHold.MaxRepeats`（6本なら2回）まで**自動で入る。残りはタップ。
  - ボタンの下に小さな文字 `HoldHint(raceInput.HoldRepeatsLeft(ruleset))`（「長押し あと2」、シアン 14px、発走後だけ）。
  - 押した瞬間の演出はタップと同じ。自動で入った分は、ムチの残り（金の点）が減った tick に同じ演出（「伸びる！」は `Flashes` を通す）。
  - かんたん操作がムチを持っている時（`whip`／`full`）は今まで通り「おまかせ」（長押しも補助が捨てる）。
- スタミナのゲージ・頭上のミニゲージ・ミニマップの点の色は §3-3 のトークン。点滅は §3-5／§3-6。
- 字幕の帯は `Subtitles` が false なら出さない。

## 5. ガチャ（スカウト）の演出

- `Motion.Reduced` なら：裏面の光の待ち（今は 380ms）を `RevealGlowMs(380)`＝0 にして**すぐ表**、めくりは `RevealFlipMs(600)`（150ms のフェード）、一覧のカードの順番の出し方もフェードだけ。
- **提供割合・抽選・結果・めくる順（`GachaRevealModel`）は変えない**（演出の時間だけ）。見本の e2e が、動きを減らしても10連の全部が同じ計画で出ることを確かめている。

## 6. 触覚・字幕・音

- 触覚は §3-7 の1か所（`Haptics`）を必ず通す。端末の設定とは別（両方オンの時だけ振動）。
- 新しい音は要らない。点滅の代わりに音を足すこともしない。

## 7. 起動とオフライン

- 起動直後（サーバーを待たずに）`GameBackend.Accessibility`（端末の写し）を当てる。文字の大きさ・色はタイトル画面から効く。
- `InitializeAsync` の後に `new AccessibilityModel(backend).SyncAsync(useBootstrap: true)`。未送信の変更があれば送る（端末が勝つ）。無ければ bootstrap の値を写しに入れる。設定画面を開いた時は `SyncAsync()`（別の端末の変更が届く）。
- オフラインで変えた値はその場で当たり、`Dirty` のまま次の `SyncAsync` で送られる。

## 8. Codex が触らないもの（ロジック側の決まり）

- トークンの色・倍率・`MaxRepeats`・間隔はテストで固定している（`server/test/a11y-tokens.test.ts`・`AccessibilityTests`）。見た目の都合で変える時は Claude 側で測り直す（色は `contracts/a11y-tokens.json` だけを変え、C# の表とテストを合わせる）。
- 長押しの公平性：最も上手に押し始めた長押しでも最良のタップの 0.77 倍の勝率・一騎打ち 43.8%（`HoldIsCappedBelowSkilledPlay`）。全部のムチを自動にすると上手なタップと互角になったので、**自動の回数の上限を外さない**。
- 設定はレースの計算に一切触れない。相手には見えず、`res` にも載らない。
