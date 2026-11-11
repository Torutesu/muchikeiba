# Round 21 Codex 向け引き継ぎ：プロフィールのショーケース（トレーナーカード、REQ-SHOW-001〜018）

更新：2026-11-11　基準ブランチ：`feat/r21-profile-showcase`（`origin/claude/round19` から）
仕様：`contracts/protocol.md` §62、`docs/spec/requirements.md` 62章、`docs/planning/06-ux-experience-spec.md` の「補足（Round 21）」、`docs/planning/03-legal-risk.md` の §62 の節。**何も配らず何も売らない**（E 番号・balance-targets の節なし。背景は実績で解放、購入なし）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・アニメーション・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/showcase`（編集の画面：選択・選べるもの・プレビュー）、`PUT /v1/showcase`（id だけ。持っている／手に入れたものだけ保存）、`GET /v1/showcase/:playerId`（相手のカード。ブロック・削除・停止は空のカード）。`server/src/domain/showcase.ts`・`server/master/showcase.json`（一言の日英の組・背景）。ゲートのグループ `social` |
| C# | ✅ `ApiClient.GetShowcaseAsync` / `SaveShowcaseAsync` / `GetShowcaseCardAsync`、`ShowcaseCard`（`IsNeutral`）/ `ShowcaseEditor` / `ShowcaseSelection` / `ShowcasePin` / `ShowcaseRecord`、`ShowcaseShare.Build`（共有の画像：既存の `ShareCard`）、`AnalyticsEvent.ShowcaseView` / `ShowcaseShared`、`AssetKeys.ShowcaseBg`（`engine/Muchi.Client/Showcase.cs`） |
| ゲーム層 | ✅ `Muchi.Game.ShowcaseCardModel`（カード：行・空のカード・通報の対象・共有・KPI）と `ShowcaseEditorModel`（編集：下書き・上限・解放前の背景・保存）（`unity/Assets/Muchi/Game/ShowcaseModel.cs`、チェック `unity/Checks~/GameChecks/ShowcaseChecks.cs`）。英語は `ui-en.json`（ラベル）と `server-en.json`（カードの文言） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：カード `__muchi.show('ShowcaseCard', 'demo_sc_1', 'friends')`、空のカード `('ShowcaseCard', 'demo_sc_blk')`、13 歳未満 `('ShowcaseCard', 'demo_sc_kid')`、共有 `('ShowcaseShare')`、編集 `('ShowcaseEdit', 'pins')`。入口：その他 › 見た目・お世話・仲間 › トレーナーカード、フレンドの名前、殿堂の「トレーナーカード」、カップの待合室の名前、お知らせの「カード」、ライバルの「トレーナーカード」、観戦の「部屋のフレンドのカード」 |
| **Codex** | カードの画面（§2）、空のカード（§3）、共有の画像（§4）、編集の画面（§5）、入口（§6）、背景の絵（§7）、文字の大きさ・英語・法務（§8） |

## 2. カードの画面（`ShowcaseCardModel`）

**出し方**：名前を押すと下から上がる全画面（動きを減らす設定ではスライドなし）。`OpenAsync(playerId, source)`（`ShowcaseSources`：friends・rival・activity・cup_lobby・spectate・hall・stable・leaderboard・team、自分の編集から settings）。

**形**（1600×900 の舞台、ムチ一閃のトーン）：
- 背景：`Card.BackgroundKey`（`showcase/bg/<id>`、§7）の写真調の絵を全面に。左に暗いシェード。
- 上：`TopBar`「トレーナーカード」＋「自分で手に入れたものだけが並びます　·　一言は決まった文から」。財布は出さない。
- 左パネル（x=36, y=134, 500×676、不透明度 .8）：字間の広いシアンの「愛馬」、馬の絵（`Card.Horse.Appearance`＝毛色・白斑・たてがみ・体型の 3D／2D、騎手の勝負服は `Card.Silks`）、金色の大きな馬の名前（`HorseTitle`：**プレイヤーが付けたまま、訳さない**。13 歳未満の持ち主では「愛馬」）、レア度・性別。下に勝負服の色の小さなチップ（`Silks.Colors`）。馬がいない時は「愛馬はまだ選ばれていません」。
- 右パネル（x=556, y=134, 1008×676、不透明度 .88）：
  - 名前（白・34px・**訳さない**）、その下に金で「称号　·　クラス C　·　レート 1500」、灰色で「42戦7勝　·　3着以内 16回」。
  - シアンの見出し「ピン留め」＋最大 3 枚の小さなカード（横に並べる。上の細い線は大会・カップが金、他はシアン）。1 枚：種類の小さなラベル（称号／実績／カップ／殿堂／リボン／大会）、太字の 1 行（`ShowcaseLine.Headline`：プレイヤーが付けた馬・カップの名前なら訳さない＝`PlayerText`）、灰色の 1 行（`Sub`：「金トロフィー」「実績 2段目」「大会優勝」…）。称号は `Icon`＝`title/<id>`、実績は `badge/<id>_<段>` の絵を添える。他は種類ごとの印（トロフィー・銘板・リボン・表彰台）を描く。
  - シアンの見出し「ベスト記録」＋行（`Records`：コース名と右に金のタイム、今シーズンのクラスの行）。
  - 一言：「」で囲んで白（サーバーが見る人の言語で返す。訳し直さない）。
  - 下：塗りの CTA「画像で共有 »」（`CanShare`）。線のボタン「通報する」（`CanReport`、§47 の既存のシート、`source: profile`。`ReportTargets()` が名前・馬の名前・プレイヤーの対象を返す）、自分のカードなら「カードを編集」（`CanEdit`）。
- 戻る：左下の BACK（開いた画面へ）。

## 3. 空のカード（`IsNeutral`）

ブロック（どちら向きでも）・削除・停止の相手。**中立の名前**（「プレイヤー」／"Player"）と既定の背景だけ。右パネルには「このカードは表示できません」の 1 行。愛馬・ピン・記録・一言・共有・通報は**出さない**。理由（ブロック・削除・停止のどれか）は出さない。

## 4. 共有の画像（`BuildShare()` → `ShareCard`）

既存の共有カード（リプレイ・フォトモード・振り返りと同じ部品）：ウォーターマーク「ムチ一閃」、`ModeLabel`「トレーナーカード」、`PlaceText` に表示名、`HorseName`、`Lines`（称号・クラス・一言・ピン・記録）、`ShareText`（末尾 `#ムチ一閃`）。背景の絵の上に紺のパネルで並べる。**プレイヤー ID・フレンドコードは描かない**（モデルが渡さない）。共有シートが受け取ったら `ReportShared()`（KPI `showcase_share`）。

## 5. 編集の画面（`ShowcaseEditorModel`）

- 場所（R21 統合で変更）：その他の行ではなく、プロフィール＝「フレンド › 自分のトレーナーカード」の「カードを編集」から（その他の2ページはどちらも8行で埋まっている。06 の「その他 のページ」）。
- 左パネル（x=36, y=134, 760×676）：上にタブ 5 つ（愛馬・ピン留め・ベスト記録・ひとこと・背景）。タブの中身は選べるものの行（`Editor.Horses` / `Pins` / `Courses` / `Phrases` / `Backgrounds`）だけ。押すと `SetHorse` / `TogglePin` / `ToggleCourse` / `SetPhrase` / `SetBackground`。上限（ピン 3・コース 2）を超える時はモデルが拒否して文を返す → トースト。解放前の背景は鍵と `UnlockText`（「実績「勝利の記録」の1段目で解放」）、押すと `LockedText`。**文字を書く欄は作らない**。
- 右パネル（x=816, y=134, 748×676）：「カードの中身」（愛馬・ピンの数・コースの数・一言・背景）、`Notice`、13 歳未満なら `YoungText`（警告色）。塗りの CTA「保存する »」（`SaveAsync`、`Dirty` の時だけ強調）、文字のリンク「カードを見る」、右上に「？」（ヒント `showcase_tip`）。
- 保存で拒否（`NOT_ELIGIBLE` など）はモデルが文にして返す。オフラインでは編集できない（`OfflineText`）。

## 6. 入口（名前を押すとカード）

フレンド一覧の名前・ライバルのカード・お知らせの行（した人）・カップの待合室の参加者・観戦の部屋・殿堂（友達の殿堂の持ち主）・厩舎の訪問・ランキング・支部のメンバー。押せる名前は下線なし・押した時に薄く光る（既存の行と同じ）。KPI の `source` は上の名前。

## 7. 描くもの一覧（絵・部品）

| もの | キー | 備考 |
|---|---|---|
| カードの背景 7 枚 | `showcase/bg/dawn`（既定）・`turf_stretch`・`night_lights`・`dirt_dust`・`stopwatch`・`every_course`・`golden_gate`、未着は `showcase/bg/default` | 写真調、1600×900、左が暗くても読める構図。名前は master の `backgrounds[].ja/en`。見本は既存の絵で代用（`SC_BG_ART`） |
| ピンの種類の印 | （コード側の印）カップ金・銀・銅、殿堂の銘板、目標のリボン、大会の表彰台 1〜3 | 称号・実績は既存の `title/<id>`・`badge/<id>_<段>` |
| 勝負服のチップ | パレットの色（`master/visuals.json` palette） | 小さな角丸の四角 |
| 鍵のマーク | 既存 | 解放前の背景 |

## 8. 文字の大きさ・英語・法務

- §41 の文字の大きさ（最大）・英語で、カード・編集・共有の画像の文字が箱からはみ出さない（見本の a11y-flow / en-flow で確かめている）。長い名前は 1 行で縮める、ピンの行は 2 行まで。
- 名前（表示名・馬・カップ）は訳さない。一言と背景の名前はサーバーが見る人の言語で返すので訳し直さない。他のラベルは `Loc.T`。
- 賭けの言葉（`bettingWords.ts`。英語の "favourite" も賭けの言葉に当たる：「愛馬」は "Featured horse"）・煽り（「今だけ」「残りわずか」「倍」）・カウントダウン・ショップへの導線を置かない。背景は買えない。
- 共有の画像・カードの画面に、プレイヤー ID・フレンドコード・最終ログインの細かい時刻を出さない（最終ログインはフレンド一覧の既存の表示のまま）。
