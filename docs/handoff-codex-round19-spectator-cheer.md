# Round 19 Codex 向け引き継ぎ：観戦中の応援（観戦画面の応援ボタン・選手の応援表示・リプレイの印、REQ-CHEER-001〜016）

更新：2026-11-11　基準ブランチ：`feat/r19-spectator-cheer`（`claude/round17` の上）
仕様：`contracts/protocol.md` §55（§4 の互換性の注意・§8.4 も）、`docs/spec/requirements.md` 55章、法務の決まり `docs/planning/03-legal-risk.md`「観戦中の応援」、UX `docs/planning/06-ux-experience-spec.md` の Round 19 の補足。経済の目標（E）は無し（何も配らない・売らない）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・クライアント SDK・画面のビューモデル）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ レースの部屋（`server/src/do/raceRoom.ts`）が観戦者の `cheer` を受け、1秒ごとに集計した `cheers` を観戦者と選手に送る。2秒に1回まで、ブロック（1つの一覧）は両向きに隠す。新しい HTTP の口は無い |
| C#（ネット） | ✅ `LockstepClient.CheerOffer` / `CanCheer` / `SendCheer(slot, kind)` / `CheersReceived`（`engine/Muchi.Net/LockstepClient.cs`・`CheerWire.cs`）。`cheers` は `Sim` に触れない |
| C#（クライアント） | ✅ `CheerKinds`・`CheerThrottle`・`CheerIndicator`・`CheerBurst`・`CheerRaceTally`・`CheerMoment`・`AnalyticsEvent.CheerSend` / `CheerSeen`（`engine/Muchi.Client/Cheer.cs`）、`ReplayData.CheerMoments` |
| ゲーム層 | ✅ `Muchi.Game.CheerModel`（`unity/Assets/Muchi/Game/CheerModel.cs`、チェックは `unity/Checks~/GameChecks/CheerChecks.cs`） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：レース →「観戦して応援する」（観戦画面）。レース中の左上の「応援 ×n」。その他 › 設定 ›「レース中の応援表示」 |
| **Codex** | 観戦画面の応援の段（§2）、ボタンの押し心地（§3）、盛り上がりの表示（§4）、選手の表示（§5）、設定（§6）、リプレイの印（§7）、英語・文字の大きさ・動きを減らす（§8） |

## 2. 観戦画面の「応援」の段（「ムチ一閃」のトーン）

観戦画面（06 §6.13。ライブ一覧 → 観戦）に**右下の半透明の紺のパネル1枚**を足す。レースの絵（3D）をふさがない。見本の構図（1600×900）：
- キッカー「応援」（小さく字間を空けたシアン、上に 86×3 のシアンの線）。
- 「応援する馬」（灰）と、選んだ馬の **馬番（シアン・太字、`CheerHorseChip.NumberText` =「3番」）** と馬名（白、`HorseName`、1行）。
- **ボタン3つ**（`CheerModel.Buttons`、左から「いけ！」「差せ！」「粘れ！」）。斜めのシアンの CTA（»）を小さめに横に3つ。`Enabled == false` の間は灰色（押せない）。
- 下に2行：「応援は2秒に1回まで」（`CheerModel.Note`。古いサーバーで応援が無い時は「このレースでは応援できません」になり、ボタンは灰色のまま）と「応援はレースの結果に影響しません」（`FairnessNote`）。
- 馬の選び方：観戦画面の出走馬の一覧（または馬の頭上の札）を押すと `CheerModel.Select(slot)`。選んだ馬はシアンの枠。一覧には馬ごとのレース中の合計 `CheerHorseChip.Total` を小さな金の数字で出してよい（0 は灰）。
- 毎フレーム（または 0.25 秒ごと）に `CheerModel.Refresh()` を呼ぶ（2秒の灰色を解くため）。

つなぎ方：
```csharp
var cheer = new CheerModel(backend.Store, null, analytics.Track, backend.Accessibility);
session.Client.RaceStarted += c => cheer.AttachSpectator(c);   // start を受けた後（観戦者の RaceSession）
// 画面を出る / final の後
cheer.Finish();                                                  // cheer_send / cheer_seen を1レース1回
```

## 3. 押した時

- `CheerModel.Send(kind)`：true なら送った。`Toast`（「3番に「いけ！」」）を短く（1.2秒ほど）出す。ボタンは2秒灰色（モデルが決める）。
- **出さないもの**：連打の数、コンボ、ランキング、「もっと応援しよう」のようなあおり。音は小さな「ポン」1つまで（任意。振動は §41 の振動の設定に従う。既定は無しでよい）。
- 自由な文字の入力欄は作らない（文は3つだけ）。

## 4. 盛り上がり（観戦者、`CheerModel.Burst`）

- 窓が届くと `Burst.Lines`（多い順に最大3行：`Slot`・`Label`・`Count`）。見本では右上のパネルに「3番　粘れ！　×9」を縦に。2.5秒（`CheerBurst.VisibleMs`）で消えてよい（`Burst.Visible(now)`）。
- `Burst.Pulse` が true の時だけ、1行目に小さな光の輪（0.6秒）。false の時（動きを減らす・1秒に3回を超えた）は文字だけ。
- 3D の上に応援の文字を飛ばす演出は**しない**（レースが見えなくなる）。馬の頭上の札を一瞬だけ明るくする程度ならよい（Pulse の時だけ）。

## 5. 選手の表示（`CheerModel.Indicator`）

- レース中、自分の馬への応援が届いた時だけ、**左上の残り距離の下（中断・フォトのボタンの下）**に小さなチップ「応援 ×12」（`Indicator.Text`、レース中の合計）。4秒（`CheerIndicator.VisibleMs`）で消す（`Indicator.Visible(now)`）。
- ムチ・手綱・内外のボタンの上や近くには置かない。片手レイアウト（§41）でも操作と反対側の上。
- `Indicator.Pulse` の時だけ控えめな光の輪。音・振動なし。
- つなぎ方：`session.Client.RaceStarted += c => cheer.AttachRacer(c);`、結果画面に移る時 `cheer.Finish()`。

## 6. 設定

- その他 › 設定 に1行「レース中の応援表示」（`CheerModel.IndicatorSetting`）と説明「観戦している人からの応援を、レース中に小さく表示します」（`IndicatorSettingDesc`）。オン／オフは `CheerModel.IndicatorOn`（端末に保存、すぐ効く、レース中に変えてもよい）。

## 7. リプレイの「応援の多かった瞬間」

- マイリプレイの再生画面（§37）のシークバーに、`CheerModel.MomentMarkers(replayData)` の印（最大3つ、`Fraction` 0〜1）。小さな金の縦線。押すとその少し前（2秒ほど前）から再生。キャプション「応援 6」（`MomentCount`）は印を長押し／ホバーした時だけでよい。見出しが要るなら「応援の多かった瞬間」（`MomentLabel`）。
- 印が無い（`CheerMoments` が空：誰も応援しなかった・古いサーバー）なら何も出さない。

## 8. 英語・文字の大きさ・動きを減らす

- 文はすべて `Loc.T()` を通す（`ui-en.json` にある：Go! / Close in! / Hang on! / Cheers ×{n} / No. {n} …）。馬名は訳さない（今までどおり Loc のローマ字）。
- 特大の文字・英語でボタンの文字がはみ出さない（ボタンは横に伸ばすか2行にしない幅で）。見本は `test/en-flow.cjs`・`test/a11y-flow.cjs` で確認済み。
- 動きを減らす（§41）：`CheerModel.ApplyAccessibility(settings)` を設定が変わった時に呼ぶ。Pulse が false になり、文字だけになる。光は `FlashLimiter`（1秒に3回まで）を通っている。

## 9. やらないこと（決めたこと）

- 有料の応援・投げ銭・ギフト・応援でコインが届く仕組み。応援の数のランキング・報酬。
- 誰が応援したかの表示（サーバーも送らない）。
- 自由な文字・スタンプの追加（スタンプは支部フィード §18 のもの、ここでは使わない）。
