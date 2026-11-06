# Round 8 Codex 向け引き継ぎ（REQ-UXU-001〜017）

更新：2026-11-06　基準ブランチ：`claude/round8`（`2e5fe9f`）　仕様：`docs/planning/06-ux-experience-spec.md` §2.3・§6・§10.2　法務：`docs/planning/03-legal-risk.md`
前提：`docs/handoff-unity-3d.md`（構成・既存ビューモデル・ローカル実行手順）。

分担：**Claude＝ロジック・サーバー・エンジン（`engine/`・`server/`・`unity/Assets/Muchi/Game`）／Codex＝見た目（`unity/Assets/Muchi/Runtime`・`unity/Assets/Resources`・アート）**。
画面は「ビューモデル（`Muchi.Game`）か `ApiClient`（`Muchi.Client`）の値をそのまま描く」。レースの判定・文言の組み立て・課金の文言は画面側で作らない。

## 0. 状態の凡例

| 表記 | 意味 |
|---|---|
| ✅ 済 | `claude/round8` にある。そのまま画面につなげる |
| API のみ | `ApiClient` のメソッド・型はある。`Muchi.Game` のビューモデルは未作成 |
| **model pending** | ビューモデルは並行ブランチ `feat/r8-unity-game` で追加中（2026-11-06 時点で未 push）。下の「予定名」は仕様上の呼び名で、確定名はそのブランチのマージ時に `docs/handoff-unity-3d.md` に追記する。それまでは `ApiClient` を直接呼ばず、表示の部品だけ先に作る |

## 1. 全画面共通の文言・法務ガード（03 と 06 §5.5 から）

| # | ガード | 画面側でやること | やってはいけないこと |
|---|---|---|---|
| G1 | 倍率表現の禁止 | 初回購入ボーナスは `Product.FirstPurchaseBonus.Label`（例「はじめての購入時のみ：無償コイン310枚をプレゼント」）をそのまま出す | 「2倍」「倍」「×2」「お得」の文字をクライアントで作る。現行 `MuchiApp` の Store 画面と `ja.json` の該当文言は削除 |
| G2 | 確率はデータから | 提供割合は `GetOddsAsync(bannerId)`／`GetTicketOddsAsync(itemId)` の値だけ。スキルは `HorseSkillView.Notice`（「条件を満たすと1レースに1回発動（確率では決まりません）」） | バナー・告知・ボタンに確率の数字を手で書く |
| G3 | 有償／無償の分離 | 財布は `PaidCoins` と `FreeCoins` を別の行で。消費は有償から（`ProductList.Notice`／`Notices["shop.paid_first"]`）。`Debt>0`（未精算）は購入・ガチャのボタンを止めて理由を出す | 合計1つだけ表示する |
| G4 | 中身は数量だけ | `Product.Contents[].Label` を表示順のまま並べる | 「通常価格◯円」の比較（二重価格）、偽の残り時間・在庫。残り時間は `SeasonEndsAt`／`ShopOffer.EndsAt` など実在の期間だけ |
| G5 | 自動更新なし | パス・厩舎手当は `AutoRenew=false` と期間（`Period`）を購入前に出す（`NoticeKeys` の `shop.no_auto_renew` 等） | 「30日間」など固定の文言（パスはシーズン＝暦月） |
| G6 | 削除予定中のブロック | `Player.Deletion.Scheduled` の間は、ショップ・オファー・手当受け取り・ガチャ購入の入口を無効にし、「アカウント削除の予定があります（◯月◯日）。取り消すと使えます」＋「取り消す」（設定へ）。API が `DELETION_PENDING` を返したときも同じ表示 | 削除予定中にオファーのポップアップを出す |
| G7 | 年齢 | 生年月は `PurchaseIntent` が `AGE_REQUIRED` のときだけ聞く（年・月）。保護者同意は `GUARDIAN_CONSENT_REQUIRED` のときだけ | 先に保護者同意を見せる。毎回年齢を聞く。3択の年齢帯 |
| G8 | ムチの表現 | 痛がる演出・故障の描写なし。ムチは「伸びる」演出 | 馬が苦しむモーション・音 |
| G9 | 実在のもの | 競馬場・馬名・勝負服は全て架空（マスターのまま） | 実在レース名・団体ロゴ |
| G10 | 開発用文言 | 本番ビルドで `PROTOTYPE`／`CHECKOUT DISABLED`／`LOCAL ONLY`／`(proposed)`／キーボード説明を出さない（REQ-UXU-013） | — |

## 2. 項目ごとの引き継ぎ

### REQ-UXU-001 タイトル「同意してはじめる」（F18）
| 項目 | 内容 |
|---|---|
| 画面 | タイトル（`MuchiApp.Title`） |
| 駆動 | API のみ：`PlayerView.Consent`（`ConsentView.Required`／`Current.TermsVersion`・`PrivacyVersion`）、`ApiClient.RecordConsentAsync(terms, privacy)`。**model pending**（予定名：同意の処理を `GameBackend` に追加） |
| 状態 | ①未同意（`Required=true`）：主ボタン「同意してはじめる」、その上に「利用規約」「プライバシーポリシー」リンク ②同意済み：「はじめる」だけ ③版の更新（`Required=true` かつ `TermsVersion!=null`）：「規約が更新されました」＋同じボタン ④オフライン：同意を端末に保存し、オンライン復帰時に送る（ボタンは押せる） ⑤`CONSENT_VERSION_MISMATCH`：`GET /v1/player` を取り直して再送（画面は変えない） |
| 文言 | 1ボタン。チェックボックスは置かない |
| 受け入れ | タイトル→初レース開始まで1タップ・5秒以内。同意の記録がサーバーに残る。KPI `tutorial_step consent` |

### REQ-UXU-002 初レース：ムチだけ・合図1回・もう一度（F1・F4・F5）
| 項目 | 内容 |
|---|---|
| 画面 | 初レース HUD・勝利演出・勝利画面 |
| 駆動 | ✅ `GameBackend.CreateTutorialRace(attempt?)`（試行回数は端末に保存、3回目から補正で必ず勝つ、REQ-UXS-004）→ `OfflineRaceDriver`（中身は `TutorialDirector`：`WhipWindowM=300`、`WhipsToWin=2`）。HUD は `RaceObserver.Hud(now)`、結果は `RaceResultModel.Build(driver, observer)` |
| 状態 | ①導入3秒（スキップ可）②前半：**ムチボタンだけ**（右親指、直径88pt以上）。内外・手綱・スタミナ・レーン表示は出さない（`TutorialDirector.AllowedPlayerBits` は Start と Whip のみ）③合図：`HudSnapshot.WhipChance`（＝`RaceFeelCueKind.WhipChance`、1レース1回）でボタンを光らせ「今だ、ムチ！」④ムチ1回ごと：伸びの演出・触覚強・効果音 `sfx/race/whip`・「伸びた」⑤勝ち：ゴール前スロー2秒→ `RaceResultModel.Headline`「差し切った！」＋馬の顔アップ ⑥負け（`TutorialRetry=true`）：半馬身差の2着→主ボタン「もう一度」（10秒で残り300mから。`CreateTutorialRace(NextTutorialAttempt)`） |
| 文言 | 合図・ヒントは `HudSnapshot.Hint`／`RaceFeelCue.Text` をそのまま。「仕掛けの好機」を常時出さない |
| 受け入れ | aha① 30秒以内。ムチ0〜1回で負け→もう一度→3回目は必ず勝つ。勝利画面の主ボタンは `PrimaryAction`（「相棒に名前をつける」）。KPI `race1_start`・`race1_whip`・`race1_win`（value＝やり直し回数） |

### REQ-UXU-003 命名は乗った馬に・ガチャは別画面（F2・F3）
| 項目 | 内容 |
|---|---|
| 画面 | 命名 → 相棒の確定（名札の馬が歩いてくる5秒）→ 入厩祝い10連（REQ-UXU-004） |
| 駆動 | API のみ：`ApiClient.GrantPartnerAsync(name, idemKey)`（`t_partner`「アイボウ」を1回だけ付与して命名、`PARTNER_ALREADY_GRANTED`／`INVALID_NAME`／`NG_NAME`）、`PlayerView.PartnerHorseId`。**model pending**：現行の `GameBackend.NamePartnerAsync` は旧フロー（無料10連を引いて一番良い馬に命名）なので、`feat/r8-unity-game` で `GrantPartnerAsync` に置き換わる。10連は命名の**後**に `EnsureFirstScoutAsync()` |
| 状態 | ①入力：見出し「この馬に名前を」、候補チップ3つ（候補はクライアント固定リスト可）＋自由入力（カタカナ2〜9字）②エラー：サーバーの message をその場で（入力欄の下）③送信中：ボタン無効＋スケルトン ④オフライン：端末に保存（`KeyPartnerName`）、オンライン時に付与 |
| 文言 | 騎手の表示名はここでは聞かない。結果画面の見出しと着順表の名前を同じにする（F3）：着順表は `ResultRow.Name`（エンジンの出走名） |
| 受け入れ | 命名した馬＝初レースで乗った馬（毛色 chestnut・流星 blaze）。ガチャ結果が命名前に見えない |

### REQ-UXU-004 ガチャのめくり・スキップ・一覧・天井（F9）
| 項目 | 内容 |
|---|---|
| 画面 | スカウト（バナー）／めくり演出／結果一覧 |
| 駆動 | ✅ API：`GetBannersAsync`・`GetOddsAsync`・`DrawAsync(bannerId, 1|10)`・`TutorialDrawAsync`・`PityExchangeAsync`、券は `UseTicketAsync`（`gacha_ticket_10` は `TicketResult.Results` に10件）。`GameBackend.ScoutReveal()` はレア度順に並べ替えるので**めくりには使わず `DrawResult.Results` の順で**。スキルは `HorseSkillView.From(...)`。スカウト画面のビューモデルは **model pending** |
| 状態 | ①バナー：馬（脚質・適性・スキル名）、価格と所持（有償／無償の内訳）、天井「交換pt 37/100」、提供割合リンク（常に見える位置）、実際の終了日時 ②めくり：1枚ずつ、レア度は**光の色＋形＋文字**（R/SR/SSR の文字を必ず併記）、効果音 `sfx/ui/gacha_r|sr|ssr`、全スキップ1タップ ③一覧：新規／ダブり（→覚醒素材） ④`INSUFFICIENT_COINS`：足りない枚数と最小のパック1つ（T6）⑤`UNSETTLED_DEBT`：理由と問い合わせ先 ⑥削除予定中（G6） |
| 文言 | G2（確率は表示データから）。「SR以上1頭確定」は券・バナーのデータの文言 |
| 受け入れ | 初ガチャ表示まで1分40秒以内。色覚3型で区別できる。KPI `screen_view scout` / `odds`、`gacha_done` |

### REQ-UXU-005 ホームの作り直し・段階開放（F10）
| 項目 | 内容 |
|---|---|
| 画面 | ホーム（`MuchiApp.Home`）と下部タブ（ホーム／厩舎／スカウト／ショップ／その他） |
| 駆動 | ✅ `GameBackend.Profile()`（相棒・クラス・シーズンpt・財布）。API のみ：`PlayerView.Unlocks`（`UnlocksView.IsUnlocked(key)`、`Features[].Races/Days/RankedRaces/Breedings`）、`PlayerView.Experiments.HomePrimaryButton`（`race`｜`ranked_promotion`）、`GetMissionBoardAsync()`（今日やること）。**model pending**（予定名：ホームのビューモデル） |
| 状態 | ①情報の順：相棒（名前・絆・調子）→「レースへ」（右下・最大）→今日やること（ログボ済み・ミッション2/3・初勝利ボーナス残り `FirstWinBonus.Remaining`）→シーズン（クラス・昇級まで◯pt）②鍵：未開放の機能は鍵アイコン＋「あと◯戦で開放」／「◯日目に開放」（`Features[]` の閾値と `UnlocksView.Races`・`Day` から）③開放した直後：1画面の案内（06 §4.3 の文言）と KPI `feature_unlock` ④読み込み：前回値を出してから更新 ⑤取得失敗：「レースへ」は押せる（オフライン練習）|
| 文言 | 初日は4つ（レース・相棒・スカウト・厩舎）だけ。英語のボタン名を出さない |
| 受け入れ | ホームからレース開始まで2タップ以内。初日・3日目・7日目の3状態が `unlocks` だけで切り替わる |

### REQ-UXU-006 レース HUD の修正（F7・F12）
| 項目 | 内容 |
|---|---|
| 画面 | レース中 HUD（`MuchiApp.BuildRaceScreen`／`UpdateHud`） |
| 駆動 | ✅ `RaceObserver.Hud(now)` → `HudSnapshot`：`RankKnown`（false の間は順位「—」）、`Rank`／`Runners`、`RemainingM`、`StaminaPermille`、`WhipsLeft`／`MaxWhips`、`Progress[]`（全頭）、`PlayerSlot`、`RiderControls`、`GapAheadMm`（`RaceFeel.MarginText`）|
| 状態 | ①発走前：順位「—」、ゲートまでのカウント（`GateCountdownTicks`）②レース中：右上 順位／頭数、左上 残り距離、脚バー＋掛かり（相棒の頭上にも小さく）、ムチ残り（ボタン上に数字と点）、簡易マップ＝**縦に全頭**（自分は大きい点、`Progress[slot]`）、実況字幕1行 ③切断：「再接続中…（CPUが代わりに乗っています）」（`Phase=Reconnecting`）④観戦：`RiderControls=false` で操作を出さない |
| 文言 | レーン表示は出走頭数に合わせる（「LANE 1 / 12」を消す）。「Hold SPACE…」の説明・English ボタンを HUD から消す（言語は設定へ） |
| 受け入れ | 8頭立てで「—」→「◯位 / 8頭」。12頭の点が全部判読できる。相棒の頭上マーカー（勝負服の色＋白縁、色だけに頼らない形） |

### REQ-UXU-007 レースの手応え（F5・F6、§6.3）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `HudSnapshot`：`Stamina`（`StaminaWarning.None/Low/Critical/Empty`）、`StaminaBlink`、`WhipChance`、`Slipstream`、`KakariWarning`、`RunawayWarning`、`WhipMashed`、`Hint`、`Cues[]`（前フレームからの新しい `RaceFeelCue`：`StaminaLow/Critical/Empty`、`WhipChance`、`Kakari`、`Runaway`、`WhipMash`、`SlipstreamOn/Off`、`Overtake`）。設定の触覚オフは **model pending**（設定のビューモデル、REQ-UXU-012） |
| 状態・対応 | 触覚：ムチ＝強1、スタート好反応＝軽2、`Overtake`＝軽1、`StaminaCritical`／`Empty`＝弱い連続、1着ゴール＝強（iOS Core Haptics／Android VibrationEffect、設定でオフ）。スタミナ：Low 黄、Critical 赤＋点滅、Empty「脚が上がった」。`KakariWarning`：「掛かっている：手綱を長押し」（1レース1回）。`WhipMashed`：「間をあけて」1回。`Slipstream`：相棒の周りに風の線＋「脚をためている」。ムチの演出：加速の線・蹄の音・字幕「伸びる！」 |
| 文言 | 文はすべて `Hint`／`Cue.Text`（エンジン側の定数）を使う。画面で文を作らない |
| 受け入れ | タップ→ボタン・馬の演出が1フレーム以内。点滅・揺れ・触覚はそれぞれオフ可（§9.3） |

### REQ-UXU-008 カメラが相棒を外さない（§6.3）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `RaceObserver.CameraShot(courseFrame, now)` → `WorldCameraShot?`（`RaceCameraRig`：Follow 後ろ6.5m・上3m／残り400mの直線で FinalStraight＝低く寄る／ゴールで Finish＝横から。`StraightBlendPermille` で補間）。判定用 `RaceCameraRig.InFrame(...)` |
| 状態 | null の間（発走前）は既存のゲートのカメラ。以後は毎フレーム `CameraShot` の位置・注視点・FOV をそのまま当てる |
| 受け入れ | 2000m・12頭で相棒が一度も画面外に出ない（ux-audit 10 の状態を再現しない）。直線のベルムーアでも横から並走 |

### REQ-UXU-009 結果画面（F13）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `RaceResultModel.Build(driver, observer)`：`Headline`、`Place`／`Runners`、`TimeText`、`DebriefLine`（勝因・敗因の1行）、`DebriefTip`、`Status`（`VerifyingText`「結果を照合中…」／`VoidText`）、`Rows[]`（`IsPlayer` を強調、`Margin`「クビ」「1馬身」）、`PrimaryAction`「もう一度」・`SecondaryAction`「ホーム」。報酬（コイン・pt・パスXP・ミッション進み）は `GameBackend.RefreshAsync()` 後の `Player` と `GetMissionBoardAsync()` の差分（報酬のまとめは **model pending**） |
| 状態 | ①確定待ち：`Status`＝照合中、`DebriefLine=null`（行を出さない）②確定：①着順（大）②1行 ③報酬1画面 ④着順表 ⑤（P2）リプレイ ③無効：`Headline`「無効」＋`VoidText` ④チュートリアル：`SecondaryAction=null`（ボタン1つ）|
| 文言 | 1行は `DebriefLine` のみ（画面で作らない）。負けた直後に課金の案内を出さない（T2 は結果画面を**閉じた後**、`ShopOffer.ShowPopup`） |
| 受け入れ | 主ボタンが「もう一度」（同じモード）。表示した着順と1行が食い違わない（モデルが保証） |

### REQ-UXU-010 ショップ（F14・F15）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ API：`GetProductsAsync()` → `ProductList.Products[]`（`Name`、`Tab`＝`recommended`/`coins`/`pass`、`Contents[].Label`、`FirstPurchaseBonus`、`OneTime`／`OneTimeScope`、`Period`、`NoticeKeys`、`ClassId`、`Allowance`）、`ProductList.Notices`・`LegalLinks`、`GetShopOffersAsync()`（`Offers[]`・`FirstPurchase`・`Allowance`）、`MarkOfferViewedAsync(offerId)`、`PurchaseIntentAsync(productId)`（`FirstPurchaseBonus`・`Pass`・`Allowance`・`RemainingYen`）、`SetAgeAsync(year, month, guardianConsent)`、`GetCosmeticsAsync`／`BuyCosmeticAsync`（`ItemsBackend` ✅）、`ClaimAllowanceAsync`。ショップのビューモデルは **model pending**（現行 `GameBackend.PurchaseCheckAsync` は英語の確認文だけ） |
| 状態 | タブ：おすすめ（スターター・パス・手当・昇級記念）／コイン／見た目（`ItemsBackend`）／パス。①上部：所持（有償・無償を分けて）、`FirstPurchase.Available` なら T1 の説明 ②商品カード：`Name`・価格・`Contents` のラベル・（あれば）`FirstPurchaseBonus.Label`・1回限り表示 ③下部：`LegalLinks`（特商法・資金決済法・有償コインの使用順）④購入確認：商品・金額・中身・無償の上乗せ・今月の残り（`RemainingYen`）・パスなら「このパスは◯日で終わります」（`Pass.LastWeek`）⑤`AGE_REQUIRED`：年・月の入力 ⑥`GUARDIAN_CONSENT_REQUIRED`：保護者同意 ⑦`AGE_LIMIT_EXCEEDED`：今月の残りと翌月1日に戻る旨 ⑧`ALREADY_PURCHASED` ⑨ストア失敗「購入は完了していません」／保留「確認中。付与されたらお知らせします」⑩削除予定中（G6）⑪オフライン：一覧のみ、買えない旨 |
| 文言 | G1〜G5。昇級記念パック（`promo_pack_B/A/S`、`ClassId`）は T4 のときだけ前面に。オファーの1枚は `ShowPopup` のときだけ出し、出したら `MarkOfferViewedAsync`、KPI `offer_view`/`offer_click`（trigger＝`Touchpoint`） |
| 受け入れ | ux-audit 15「各パック初回購入で2倍」が消える。生年月は未登録時だけ。`CHECKOUT DISABLED` を本番で出さない。課金処理（ストア SDK）は未接続のまま（`PurchaseAsync` は用意済み） |

### REQ-UXU-011 パス画面をサーバーの値だけで（F16）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `GameBackend.SeasonPassAsync()` → `SeasonPassView`：`Level`・`Xp`・`XpToNextLevel`・`RacesToNextLevel`・`MaxLevel`（30）・`FreeLine`／`PremiumLine`（`Every`＋`Reward`）・`ClaimedFree`／`ClaimedPremium`・`Active`・`Purchasable`／`Owned`・`SeasonEndsAt`・`RemainingDays`・`LastWeek`・`AutoRenew`・`AutoGrantAtSeasonEnd`・`BoostLevels`・`LastSeason`（締めで自動付与した段）。受け取り `ClaimSeasonPassAsync(track, level)`。パスのビューモデル（まとめて受け取り）は **model pending** |
| 状態 | ①今のレベルとXP（「次まで◯XP＝あと◯戦」）②無料・有料の全30段（横スクロール、受け取れる段を強調）③未購入：有料ラインも中身を全部見せ、主ボタン「有料ラインを開ける ¥1,000」（`Purchasable` の商品）④購入済み：「まとめて受け取る」⑤期間「11月30日 23:59まで」（`SeasonEndsAt` から）⑥前シーズンの自動付与のお知らせ（`LastSeason.AutoGrantedFree/Premium`）|
| 文言 | 「30日間」「ティア1〜5」「SRチケット」の固定文言を全部消す。報酬は `Reward` の値から |
| 受け入れ | ux-audit 14 の不一致が無い。サーバーの `products.json`／`progression.json` を変えると画面も変わる |

### REQ-UXU-012 設定画面
| 項目 | 内容 |
|---|---|
| 駆動 | API：`GetPushPreferencesAsync`／`SetPushPreferencesAsync`（種類と静かな時間）、`SetDisplayNameAsync`、引き継ぎ `FirebaseAuthTokenProvider.LinkAsync`（`Linked`／`CredentialInUse`→`SwitchToExistingAccountAsync`／`ProviderAlreadyLinked`）、削除 `RequestAccountDeletionAsync()`→`ConfirmAccountDeletionAsync(token)`→（取消）`CancelAccountDeletionAsync()`、`PlayerView.Deletion`。設定のビューモデル（サウンド・触覚・画質・言語の端末保存を含む）は **model pending** |
| 状態 | サウンド／触覚／画質（省電力・標準・高）／通知（種類と静かな時間）／言語（English ボタンはここへ移す）／引き継ぎ（Apple・Google）／騎手の表示名／利用規約・プライバシー・特商法・資金決済法・権利表記・お問い合わせ／アカウント削除。**削除の流れ**：①説明 ②1回目→`DeletionRequest.Forfeit`（有償・無償コイン、馬、アイテム、手当の残り日数、パス）と `Notice` を表示、「放棄して削除を予約」③2回目（`ConfirmToken`、10分以内。`DELETION_CONFIRM_INVALID` なら①から）④予約済み：「◯月◯日に削除されます」（`DeleteAt`、14日）＋「取り消す」⑤取消の `CONFLICT`：「削除が始まっています」 |
| 受け入れ | 法定ページ・削除までアプリ内から2タップ以内（§9.5）。削除予定中は G6 のブロックが全画面で効く |

### REQ-UXU-013 文言の日本語化・開発用文言の非表示（F11）
| 項目 | 内容 |
|---|---|
| 駆動 | `LocaleService`（`Resources/Localization/ja.json`・`en.json`）。サーバー由来の文（商品名・ラベル・エラー message）は翻訳しない |
| やること | `MuchiApp` の英語のリテラル（`"FINDING RIDERS…"`、`"RACE RESULT  /  RANKED"`、`"HOLD YOUR LINE"`、`"8 more partners joined your stable."` 等）を全て `ja.json` のキーへ。英語は見出しの飾りだけ可。G10 の文言は `#if` かビルド時の検査で本番から外す |
| 受け入れ | 日本語設定で英語の文が画面に残らない（ux-audit 06・08）。本番ビルドで G10 の文字列がゼロ（ビルド前チェックを追加） |

### REQ-UXU-014 ミッション・ログボの表示
| 項目 | 内容 |
|---|---|
| 駆動 | API：`ClaimLoginBonusAsync()` → `LoginBonusResult`（`Track`＝`beginner`/`normal`、`BeginnerDaysLeft`、`Reward`。2日目は `Reward.Broodmare`＝繁殖牝馬 `t_broodmare`「ハジメノハナ」）、`GetMissionBoardAsync()` → `MissionBoard`（`Missions` デイリー、`Beginner.Steps[]`（`Claimable`／`Locked`、順番に受け取り）、`Season.Missions[]`（報酬はパスXP）、`FirstWinBonus`）、`ClaimMissionAsync(id)`。**model pending**（予定名：ミッションのビューモデル） |
| 状態 | ①起動時にログボを自動受け取り→トースト（「ログインボーナス 3日目：勝負服」）②ホームのパネル：デイリー 2/3、初心者ミッションの次の1段、初勝利ボーナス残り ③3本完了：「今日の分は完了。明日 0:00 に更新」④初心者10段目の10連券：`UseTicketAsync("gacha_ticket_10")` でめくり演出（REQ-UXU-004 と共通）⑤`NOT_ELIGIBLE`（前の段が未受け取り）は受け取りボタンを出さない状態で防ぐ |
| 文言 | 「揃えたら報酬」の表現を作らない（コンプガチャ）。報酬名は `Reward` の値から |
| 受け入れ | 2戦目の後に開放（`unlocks` の `missions`／`login_bonus`）。ミッションがホームの1画面目に見える |

### REQ-UXU-015 通知の許可の前置き・引き継ぎの案内
| 項目 | 内容 |
|---|---|
| 駆動 | `PlayerView.Experiments.PushPermissionTiming`（`race2_top3`＝2戦目の3着以内の直後／`day2_launch`）、`RaceResultModel.Place`、OS の許可→`RegisterPushDeviceAsync(token, platform)`、KPI `AnalyticsEvent.PushPermission(granted)`。引き継ぎの案内：`UnlocksView.Day>=3` または初回購入後、未連携のとき1回。表示済みの記録（端末）と判定は **model pending** |
| 状態 | 通知：前置き1画面「シーズン開幕や大会の呼び出しを知らせます」→「許可する」でOSダイアログ／「あとで」。3着以内でなければ次の3着以内まで待つ。引き継ぎ：1画面「機種変更でも相棒を引き継げます」→ 設定の引き継ぎへ |
| 受け入れ | チュートリアル中・負けた直後に出ない。各1回だけ。KPI `push_permission`、`account_link`（✅ Round 9 で `AnalyticsEvent.FeatureUnlock`・`OfferView`・`OfferClick`・`RaceQuit`・`AccountLink`・`Share` を追加。引き継ぎの案内の判定と表示済みの記録は `AccountLinkPrompt`、末尾の R9-2） |

### REQ-UXU-016 共通の読み込み・エラー表示
| 項目 | 内容 |
|---|---|
| 駆動 | `ActionResult`（`Ok`／`Message`）、`ApiException.WireCode`（`Muchi.Client.ApiErrorCodes`、全コードの一覧は `Errors.cs`）、`NetworkException`＝オフライン。エラーコード→日本語1文の表は `tools/figma-prototype/site/club/main.js` の `ERROR_TEXT` を正として Unity に移す（表のクラスは **model pending**。追加コード：`CONSENT_VERSION_MISMATCH`・`PARTNER_ALREADY_GRANTED`・`DELETION_CONFIRM_INVALID`・`DELETION_PENDING`・`LIKE_LIMIT`・`ALREADY_LIKED`） |
| 状態 | 300ms以内：何も出さない／300ms〜2秒：スケルトン／2秒超：理由＋「再試行」／オフライン：「オフラインです。練習レースは遊べます」／`ALREADY_IN_RACE`：「前のレースに戻る」ボタン |
| 文言 | 画面に `CODE  /  message` の生の形を出さない（現行 `ScreenModel.Fail` の形式は開発用） |
| 受け入れ | 全画面が同じ部品を使う。表に無いコードは「通信に失敗しました（コード）」＋再試行 |

### REQ-UXU-017 性能
| 項目 | 目標・やること |
|---|---|
| フレームレート | 中位機（iPhone 12／Pixel 6a）60fps、下位機（iPhone SE2／3GB Android）30fps以上。12頭＋生成コースのドローコールを測る |
| メモリ | 下位機 1.2GB 以下 |
| コース生成 | 2000m で数百のプリミティブ → メッシュ結合、または `Greenfield_Trackside_Kit.fbx` に置き換え |
| 初回ダウンロード | 200MB 以下。同梱は全 kind の `<kind>/default`・UI・チュートリアルのコース（青葉 芝1600）・よく使う効果音・実況の定型フレーズだけ（`contracts/assets.md` §6）。他は Addressables のリモート |
| 省電力 | 30fps・影なしのモード（設定の画質「省電力」） |
| 受け入れ | 実機の計測結果（端末・fps・メモリ・ドローコール）をこの文書か `docs/handoff-unity-3d.md` に追記 |

## 3. MuchiApp ↔ RaceObserver / RaceResultModel の配線

現行の `MuchiApp` は `HudModel.Build(driver, now)` を直接呼び、結果画面も `HudSnapshot` から作っている。これを次のように置き換える（`RaceObserver` を使わないと手応えの1回きりの合図・勝因の1行・カメラが働かない）。

| タイミング | 今 | 置き換え |
|---|---|---|
| `StartDriver(next, …)` | `driver?.Dispose(); driver = next;` | `observer?.Dispose(); driver?.Dispose(); driver = next; observer = new RaceObserver(driver);`（1レース1個。`RaceObserver` はコンストラクタで、`Sim` と `Config` が揃っていなければ後で `Update()` 時に自動で接続する） |
| `Update()` の毎フレーム | `driver.Update(now)` → `HudModel.Build(driver, now)` | `driver.Update(now)` の**後**に `var hud = observer.Hud(now);`（内部で `Update()`。オフラインは `OfflineRace.Stepped` で毎tick記録、オンラインは毎フレーム）。`hud.Cues` で触覚・効果音・一言を鳴らす（同じ cue は二度来ない） |
| カメラ | `RaceWorld` 内の追従 | `world.Present(driver, now)` の後に `observer.CameraShot(frame, now)` を当てる。`RaceWorld` の private `frame`（`StartRace` で `CourseFrame.For(config, visuals)`）と `view`（Chase camera）を使うので、`RaceWorld` に `public CourseFrame Frame => frame;` と `ApplyCamera(WorldCameraShot)` を Codex 側で追加し、今の追従処理は null の間（発走前）だけにする |
| スキル | — | `SkillHud.Build(driver)` → `SkillHudState.CutIn`（1秒のカットイン、P1 の REQ-UXU-023） |
| `driver.Done` | `Result()` が `HudModel.Build` で着順を取る | `var result = RaceResultModel.Build(driver, observer);`（チュートリアルは試行回数を自動で `TutorialDirector.Attempt` から取る）。オンラインは `Status` が照合中の間も描画し、`driver.Phase` が `Confirmed`／`Void` になったら**もう一度 Build し直す**（`Final.Order` が勝つ） |
| 結果のボタン | 「CONTINUE」「MEET YOUR PARTNER」 | `result.PrimaryAction`：チュートリアル勝ち→命名、チュートリアル負け（`TutorialRetry`）→ `StartDriver(backend.CreateTutorialRace(result.NextTutorialAttempt), "tutorial", true)`、それ以外→同じモードでもう一度。`SecondaryAction`（null なら出さない）→ホーム |
| 終了・退出 | `ExitRace` で `driver.Dispose()` | `observer?.Dispose(); observer = null;` も（`Stepped` の購読を外す）。`OnDestroy` も同じ |
| KPI | `TutorialStep("first_ride",1)` | ステップ名は `consent, race1_start, race1_whip, race1_win, named, gacha_done, race2_done, home` だけ（protocol §8.7）。`first_ride` は送らない |

注意：
- 観戦（`PlayerSlot = -1`）では `RaceObserver` は何も記録せず、`Hud` は `RiderControls=false`、`Debrief()` は null。
- `RaceResultModel` は UnityEngine を参照しない。文言の組み立ては全部モデル側にあるので、画面はフィールドを置くだけ。
- `unity/Checks~/GameChecks`（`RaceFeelChecks.cs` ほか）が HUD・結果・カメラの値を Unity 無しで検査している。画面側の変更でモデルを変えたくなったらこちらに依頼する。

## 4. 新しいアート（NEW ART）

### 4.1 Round 8 で増えたキー（マニフェスト v2 で `main` から +38）

| キー | 何に使うか | 元データ | 現状 |
|---|---|---|---|
| `silks/pattern/promo_b` / `promo_a` / `promo_s` | 昇級記念の勝負服の柄（B・A・S級、昇級記念パック `promo_pack_B/A/S`） | `visuals.json` patterns・`items.json` | 仮：`Art/Cosmetics/silk-jacket`（模様の区別なし） |
| `item/costume_promo_b` / `costume_promo_a` / `costume_promo_s` | 上の柄を解放するアイテムのアイコン（ショップの中身・報酬） | `items.json` | なし |
| `tack/bridle_pass_plus` | シーズンパス＋の限定頭絡（馬に重ねる） | `items.json`（notForSale） | 仮：`Art/Cosmetics/bridle` |
| `item/tack_bridle_pass_plus` | 同アイテムのアイコン | `items.json` | なし |
| `item/gacha_ticket_10` | 10連券（初心者ミッション10段目） | `items.json` | なし |
| `stable/theme/default` / `standard` / `cedar` / `sakura` | マイ厩舎の部屋のテーマ（壁・床、P1 REQ-UXU-022） | `stable.json themes` | なし |
| `voice/ja/name/n47ab6ba076960abe` | 「アイボウ」＝最初の相棒 `t_partner`（命名前・CPU表示用。命名後は動的キー） | `horses.json` | なし |
| `voice/ja/name/n95fa5e537fd1ac15` | 「ハジメノハナ」＝初心者ログボの繁殖牝馬 `t_broodmare` | `horses.json` | なし |
| `voice/ja/name/…`（16件、下表） | 固有スキル名の実況音声（`skill:<id>`） | `skills.json` | なし |
| `voice/ja/phrase/skill_1_p0` `skill_1_p1` `skill_2_p0` `skill_2_p1` `skill_2_p2` `skill_3_p0` `skill_3_p1` | スキル発動の実況フレーズの断片 | `commentary-ja.json` | なし |

固有スキル名の音声キー（FNV-1a 64bit、`contracts/assets.md` §3.6）：

| スキルID | 名前 | レア度 | キー |
|---|---|---|---|
| sk_ichibanyari | 一番槍 | R | `voice/ja/name/nbbd3cdc785351b1f` |
| sk_kagefumase | 影踏ませず | SR | `voice/ja/name/n6dced27b90f105d6` |
| sk_shippu | 疾風の先駆け | SSR | `voice/ja/name/ne3dc944cddde858a` |
| sk_kouinonebari | 好位の粘り | R | `voice/ja/name/ne475216a2a6450e2` |
| sk_nukedashi | 先行抜け出し | SR | `voice/ja/name/ncef787f7a2c87862` |
| sk_oudou | 王道の構え | SSR | `voice/ja/name/n7d269c35cc22d44e` |
| sk_kazeyomi | 風読み | R | `voice/ja/name/n79465d661017ac50` |
| sk_sueashi | 末脚一閃 | SR | `voice/ja/name/n505b9f6d39a8e94e` |
| sk_kireaji | 切れ味鋭く | SSR | `voice/ja/name/nb89c35b7a998e6c3` |
| sk_ooso | 大外一気 | R | `voice/ja/name/n533e323ac682af09` |
| sk_jinrai | 迅雷 | SR | `voice/ja/name/n8f3b41cf490b6c3c` |
| sk_goukyaku | 豪脚 | SSR | `voice/ja/name/n9a50d22f8ffee9a2` |
| sk_hitoiki | ひと息入れて | R | `voice/ja/name/n785ef831c45f1a0b` |
| sk_hitonobi | ラストひと伸び | R | `voice/ja/name/nb614d5400ba26d3f` |
| sk_uchirachi | 内ラチの申し子 | SR | `voice/ja/name/n83246d02bf6dce8c` |
| sk_ninoashi | 根性の二の脚 | SR | `voice/ja/name/n57c2b721fd5cafc9` |

### 4.2 マニフェストに無いが画面に要るもの（キーの追加はこちらで行う。決まるまで Resources の仮パスで可）

| 用途 | 項目 | 仮の置き場所（提案） |
|---|---|---|
| 固有スキルのアイコン・カットイン枠（REQ-UXU-023） | kind `skill/icon` は未定義。レア度別の枠3種＋スキル16種 | `Resources/Art/Skills/` |
| 最初の相棒（`t_partner`）の見た目 | 毛色 chestnut・流星 blaze・右後ソックス・たてがみ normal・体型 standard。`PartnerCatalog` では `Partner_Chestnut_*`。顔・脚の白斑は今のモデルで表現不可 → 命名画面・確定演出の**顔のアップ用1枚絵**が要る | `Resources/Art/partner-closeup.png` |
| 初レースの勝利演出・ムチの合図 | 合図の光（ボタンのリング）、「差し切った！」のタイトル | UI 内 |
| レア度の形（REQ-UXU-004） | R/SR/SSR で形の違うカード枠・光 | UI 内 |
| 鍵アイコン・トースト・スケルトン・エラー表示（REQ-UXU-005/014/016） | 共通 UI 部品 | UI 内 |
| 通知の前置き・引き継ぎの案内（REQ-UXU-015） | 1画面の挿絵 各1枚 | `Resources/Art/` |

### 4.3 マニフェストの全キーと Unity 側の有無（403件）

`unity/Assets` には Addressables がまだ無く、**キーをアドレスに持つアセットは0件**。`CosmeticArt`・`PartnerCatalog`・`MuchiApp` の対応表で仮のアートに解決できるもの（下表の ¹）が46件、**何も無いものが357件**。リリース前にゼロにする（`contracts/assets.md` §6、`AssetKeys.ParseManifestKeys` でビルド前に検査）。
`<kind>/default` は全 kind で最初のダウンロードに必須。

| kind | 件数 | 仮あり¹ | キー（`<kind>/` を省略） |
|---|---|---|---|
| `horse/coat` | 8 | 8 | `bay`¹, `black`¹, `brown`¹, `chestnut`¹, `dark_bay`¹, `default`¹, `gray`¹, `white`¹ |
| `horse/face` | 7 | 0 | `blaze`, `default`, `none`, `star`, `star_stripe`, `stripe`, `white_face` |
| `horse/leg` | 5 | 0 | `coronet`, `default`, `none`, `sock`, `stocking` |
| `horse/mane` | 4 | 0 | `dark`, `default`, `flaxen`, `normal` |
| `horse/build` | 5 | 0 | `compact`, `default`, `powerful`, `rangy`, `standard` |
| `silks/pattern` | 20 | 20 | `braces`¹, `chevrons`¹, `cross_sashes`¹, `default`¹, `diamonds`¹, `flame`¹, `halves`¹, `hoops`¹, `laurel`¹, `lightning`¹, `plain`¹, `promo_a`¹, `promo_b`¹, `promo_s`¹, `quartered`¹, `sash`¹, `spots`¹, `stars`¹, `stripes`¹, `wings`¹ |
| `silks/cap` | 6 | 0 | `default`, `hooped`, `peak`, `plain`, `quartered`, `star` |
| `ui/gate` | 9 | 0 | `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `default` |
| `tack` | 6 | 6 | `bridle_classic`¹, `bridle_gold`¹, `bridle_pass_plus`¹, `default`¹, `saddlecloth_crimson`¹, `saddlecloth_navy`¹ |
| `decor` | 5 | 5 | `default`¹, `flower_box`¹, `golden_horseshoe`¹, `stable_plaque`¹, `trophy_shelf`¹ |
| `stable/theme` | 4 | 0 | `cedar`, `default`, `sakura`, `standard` |
| `item` | 24 | 0 | `breeding_material`, `costume_login`, `costume_promo_a`, `costume_promo_b`, `costume_promo_s`, `costume_season_limited`, `costume_silks_laurel`, `costume_starter`, `course_autumn_gold`, `course_spring_meadow`, `decor_flower_box`, `decor_golden_horseshoe`, `decor_stable_plaque`, `decor_trophy_shelf`, `default`, `event_ticket`, `gacha_ticket`, `gacha_ticket_10`, `tack_bridle_classic`, `tack_bridle_gold`, `tack_bridle_pass_plus`, `tack_saddlecloth_crimson`, `tack_saddlecloth_navy`, `ticket_sr_plus` |
| `banner/gacha` | 5 | 0 | `default`, `pickup_akatsuki`, `standard`, `stepup_paid`, `winter_2026` |
| `banner/event` | 3 | 0 | `default`, `no_whip_cup_2026_12`, `sprint_cup_2026_11` |
| `title` | 20 | 0 | `bond_first`, `bond_master`, `class_a`, `class_s`, `debut`, `default`, `first_win`, `hundred_races`, `kirameki_king`, `kirameki_record`, `lightning_start`, `nige_master`, `oikomi_master`, `podium_50`, `rating_1800`, `sashi_master`, `senko_master`, `start_artist`, `ten_wins`, `whip_artist` |
| `emblem/shape` | 6 | 0 | `circle`, `default`, `diamond`, `horseshoe`, `shield`, `star` |
| `emblem/symbol` | 9 | 0 | `anchor`, `crown`, `default`, `flower`, `horse_head`, `lightning`, `moon`, `sun`, `wing` |
| `scene/venue` | 7 | 0 | `aoba`, `bellmoor`, `default`, `kirameki`, `minato`, `nordhaven`, `santalucera` |
| `scene/surface` | 9 | 0 | `aoba_dirt`, `aoba_turf`, `bellmoor_turf`, `default`, `kirameki_turf`, `minato_dirt`, `minato_turf`, `nordhaven_turf`, `santalucera_dirt` |
| `scene/night` | 3 | 0 | `default`, `minato`, `santalucera` |
| `fx/going` | 7 | 0 | `default`, `fast`, `firm`, `muddy`, `sloppy`, `soft`, `yielding` |
| `scene/look` | 4 | 3 | `autumn_gold`¹, `default`, `greenfield`¹, `spring_meadow`¹ |
| `fx/weather` | 5 | 4 | `cloudy`¹, `default`, `fog`¹, `rain`¹, `sunny`¹ |
| `sfx/race` | 13 | 0 | `countdown`, `crowd_roar`, `default`, `finish`, `gate_open`, `kakari`, `lane_change`, `late_start`, `lead_change`, `photo_finish`, `spurt`, `start`, `whip` |
| `sfx/ui` | 9 | 0 | `back`, `default`, `error`, `gacha_r`, `gacha_sr`, `gacha_ssr`, `level_up`, `reward`, `tap` |
| `voice/ja/phrase` | 143 | 0 | `bond_call_1_p0`, `bond_call_2_p0`, `bond_call_2_p1`, `comeback_win_1_p0`, `comeback_win_1_p1`, `comeback_win_2_p0`, `comeback_win_2_p1`, `cpu_takeover_1_p0`, `default`, `duel_1_p0`, `duel_1_p1`, `duel_2_p0`, `duel_2_p1`, `finish_win_1_p0`, `finish_win_2_p0`, `finish_win_2_p1`, `finish_win_3_p0`, `focus_finish_1_p0`, `focus_finish_1_p1`, `focus_finish_ranked_1_p0`, `focus_finish_ranked_1_p1`, `focus_finish_ranked_2_p0`, `focus_finish_ranked_2_p1`, `focus_finish_tutorial_1_p0`, `focus_finish_tutorial_1_p1`, `focus_whip_1_p0`, `focus_whip_2_p0`, `focus_whip_tutorial_1_p0`, `focus_whip_tutorial_1_p1`, `focus_whip_tutorial_2_p0`, `gate_open_1_p0`, `gate_open_2_p0`, `gate_open_3_p0`, `gate_open_event_1_p0`, `gate_open_event_2_p0`, `gate_open_ranked_1_p0`, `gate_open_ranked_2_p0`, `gate_open_tutorial_1_p0`, `gate_open_tutorial_2_p0`, `going_call_dirt_fast_1_p0`, `going_call_dirt_fast_1_p1`, `going_call_dirt_fast_2_p0`, `going_call_dirt_muddy_1_p0`, `going_call_dirt_muddy_1_p1`, `going_call_dirt_muddy_2_p0`, `going_call_dirt_sloppy_1_p0`, `going_call_dirt_sloppy_1_p1`, `going_call_dirt_sloppy_2_p0`, `going_call_turf_firm_1_p0`, `going_call_turf_firm_1_p1`, `going_call_turf_firm_2_p0`, `going_call_turf_soft_1_p0`, `going_call_turf_soft_1_p1`, `going_call_turf_soft_2_p0`, `going_call_turf_yielding_1_p0`, `going_call_turf_yielding_1_p1`, `going_call_turf_yielding_2_p0`, `good_start_1_p0`, `good_start_2_p0`, `ground_dirt_fast_1_p0`, `ground_dirt_fast_2_p0`, `ground_dirt_fast_night_1_p0`, `ground_dirt_fast_night_2_p0`, `ground_dirt_good_1_p0`, `ground_dirt_good_2_p0`, `ground_dirt_good_night_1_p0`, `ground_dirt_good_night_2_p0`, `ground_dirt_muddy_1_p0`, `ground_dirt_muddy_2_p0`, `ground_dirt_muddy_night_1_p0`, `ground_dirt_muddy_night_2_p0`, `ground_dirt_sloppy_1_p0`, `ground_dirt_sloppy_2_p0`, `ground_dirt_sloppy_night_1_p0`, `ground_dirt_sloppy_night_2_p0`, `ground_turf_firm_1_p0`, `ground_turf_firm_2_p0`, `ground_turf_firm_night_1_p0`, `ground_turf_firm_night_2_p0`, `ground_turf_good_1_p0`, `ground_turf_good_2_p0`, `ground_turf_good_night_1_p0`, `ground_turf_good_night_2_p0`, `ground_turf_soft_1_p0`, `ground_turf_soft_2_p0`, `ground_turf_soft_night_1_p0`, `ground_turf_soft_night_2_p0`, `ground_turf_yielding_1_p0`, `ground_turf_yielding_2_p0`, `ground_turf_yielding_night_1_p0`, `ground_turf_yielding_night_2_p0`, `kakari_1_p0`, `kakari_2_p0`, `late_start_1_p0`, `late_start_2_p0`, `late_start_2_p1`, `late_start_tutorial_1_p0`, `leader_1_p0`, `leader_1_p1`, `leader_2_p0`, `leader_2_p1`, `leader_3_p0`, `photo_finish_1_p0`, `photo_finish_1_p1`, `photo_finish_2_p0`, `position_call_1_p0`, `position_call_1_p1`, `position_call_1_p2`, `position_call_1_p3`, `position_call_2_p0`, `position_call_2_p1`, `position_call_2_p2`, `result_1_p0`, `result_1_p1`, `result_1_p2`, `result_1_p3`, `result_solo_1_p0`, `result_two_1_p0`, `result_two_1_p1`, `result_two_1_p2`, `skill_1_p0`, `skill_1_p1`, `skill_2_p0`, `skill_2_p1`, `skill_2_p2`, `skill_3_p0`, `skill_3_p1`, `spurt_1_p0`, `spurt_2_p0`, `spurt_aoba_1_p0`, `spurt_aoba_2_p0`, `spurt_bellmoor_1_p0`, `spurt_bellmoor_2_p0`, `spurt_kirameki_1_p0`, `spurt_kirameki_2_p0`, `spurt_minato_1_p0`, `spurt_minato_2_p0`, `spurt_nordhaven_1_p0`, `spurt_nordhaven_2_p0`, `spurt_santalucera_1_p0`, `spurt_santalucera_2_p0`, `wire_win_1_p0`, `wire_win_2_p0` |
| `voice/ja/num` | 13 | 0 | `1`, `10`, `11`, `12`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `default` |
| `voice/ja/name` | 44 | 0 | `default`, `n007e94ff5ca3e844`, `n0c06775c745252a3`, `n17a4dbfff7a26076`, `n1c6eb5433126945c`, `n2c35fb4af926271f`, `n2e9954d13002bace`, `n475bb6019218bc56`, `n47ab6ba076960abe`, `n505b9f6d39a8e94e`, `n52faa2441aa58bdf`, `n533e323ac682af09`, `n57c2b721fd5cafc9`, `n589fee4e81e1fb80`, `n59087fe3220af997`, `n6151482108915a72`, `n64bd8ab625d03d7d`, `n6bb40087ff3dc223`, `n6dced27b90f105d6`, `n6f246d2eb516a0d3`, `n785ef831c45f1a0b`, `n79465d661017ac50`, `n7d269c35cc22d44e`, `n81bf206c5786da3a`, `n83246d02bf6dce8c`, `n8921d61e411ac60d`, `n8f3b41cf490b6c3c`, `n95fa5e537fd1ac15`, `n9a50d22f8ffee9a2`, `n9aec3d85e614d2f4`, `nb614d5400ba26d3f`, `nb89c35b7a998e6c3`, `nbb69cd5675cb83f2`, `nbbd3cdc785351b1f`, `ncef787f7a2c87862`, `nd737b07f5801df81`, `ne2ea58631787dce5`, `ne3dc944cddde858a`, `ne475216a2a6450e2`, `neceb60ddfb26d543`, `nf1f7f52e257bd760`, `nf75c16a1f4e4bfd6`, `nf9e453b4b1b2f50a`, `nfb646b876a242376` |

¹ 仮の解決先：`tack/bridle*`・`tack/default` → `Art/Cosmetics/bridle`、`tack/saddlecloth*` → `saddlecloth`、`decor/*` → `stable-plaque`、`silks/pattern/*` → `silk-jacket`、`horse/coat/*` → `Models/Partners/Partner_<Coat>_*`（`PartnerCatalog`）、`scene/look/greenfield|spring_meadow|autumn_gold` → `Art/home-paddock`・`Art/Courses/*`、`fx/weather/sunny|cloudy|rain|fog` → `Art/Weather/*`。いずれも種類ごとに1枚の試作で、キーごとの見分けは無い。

優先度（P0 の画面に要る順）：`ui/gate/*` → `sfx/race/*`・`sfx/ui/*`（ムチ・ガチャ） → `item/*`（ショップ・報酬のアイコン） → `banner/gacha/*` → `silks/cap/*`・`silks/pattern/*`（模様ごと） → `title/*` → `scene/*`（チュートリアルの `scene/venue/aoba`・`scene/surface/aoba_turf` を最初に） → `voice/ja/*` → `emblem/*`・`banner/event/*`・`stable/theme/*`（P1）。

## 5. 確認の手順

1. `dotnet run --project "unity/Checks~/GameChecks"`（ゲーム層のテスト）、`dotnet build "unity/Checks~/UnityRuntime"`（`Runtime` の型チェック）が通ること。
2. エディタ：タイトル→同意→初レース（ムチ0回で負け→もう一度×2→3回目で勝ち）→命名→10連のめくり→2戦目→結果→通知の前置き→ホーム を、サーバーなし／`npm run dev` ありの両方で通す。
3. ショップの4状態（生年月未登録・登録済み・18歳未満・上限超え）と削除予定中を `npm run dev` で再現（`x-dev-user` を変えれば新規プレイヤー。年齢は購入確認の画面から登録）。
4. 本番ビルドの文字列検査（G10）と、マニフェストのキー検査の結果を PR に貼る。

---

# Round 9 追記：リプレイ共有・引き継ぎの案内・フレンドのゴースト（REQ-UXS-070〜074）

更新：2026-11-06　ブランチ：`feat/r9-share-link-ghost`（`claude/round8` から）　仕様：`docs/planning/06-ux-experience-spec.md` §7 の12・§7.3、要件 `docs/spec/requirements.md` §17。
ロジック・ビューモデル・テストはこちらで済み（✅）。**TODO（Codex）** の行が画面・録画・ネイティブ連携の作業。

## R9-1 リプレイ共有（REQ-UXS-070〜072、REQ-UXU-030、P2）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `ReplayShareModel.From(driver, courseName)`（結果画面の時点の `IRaceDriver` から。null＝共有できない：観戦・無効・未完了・再計算のハッシュ不一致）→ `Clip`（`ReplayClip`：最後の200m・最大10秒・30fps、`Frames()`／`FrameAt(ms)`、`CameraKeys`、`Events`、`FocusSkills`）と `Card`（`ShareCard`：`PlaceText`・`TimeText`・`HorseName`・`CourseName`・`ModeLabel`・`SkillLines`・`Watermark`＝「ムチ一閃」・`ShareText`）。`Pose(frame)` → `PosedClipFrame`（全馬の `WorldPose`、`WhipActive`／`SkillActive`、`WorldCameraShot`。ライブと同じ `CourseFrame` 変換） |
| 流れ | ✅ `RecordAndShareAsync(recorder, sheet, applyPose, analytics)`：動画対応なら `Begin` → 各フレームで `applyPose`（シーンを置く）→ `CaptureFrameAsync` → `FinishAsync`（mp4のパス）、非対応なら勝負所（ゴールの瞬間）の `CaptureStillAsync`（png）→ `IShareSheet.ShareAsync(path, Card.ShareText)`。共有した時だけ KPI `share`。失敗・キャンセルで `Cancel()` |
| **TODO（Codex）** | ① `IClipRecorder` の実装（`unity/Assets/Muchi/Game/ReplayShare.cs` のインターフェース）：専用カメラ＋RenderTexture（縦1080×1920 推奨・横も可）、`AsyncGPUReadback` で取り込み、H.264 の mp4 に（iOS：AVAssetWriter、Android：MediaCodec のネイティブプラグイン。エディタは png 連番で可）、`Application.temporaryCachePath` に保存。`SupportsVideo=false` の端末は静止画だけ ② 透かし・終わりのカード：`Card.Watermark` を左上に常時、最後の1.5秒に `PlaceText`／`TimeText`／`HorseName`／`CourseName`／`SkillLines` を重ねる（文言は画面で作らない）③ `applyPose`：`RaceWorld` にリプレイ用の配置メソッドを足し、`PosedClipFrame.Horses[slot]` と `Camera` をそのまま当てる（走りのアニメは `WhipActive`／`SkillActive`）。録画中はライブのHUD・実況を出さない ④ `IShareSheet`：ネイティブの共有シート。true＝共有した ⑤ 結果画面の「リプレイを共有」ボタン（主ボタン「もう一度」の邪魔をしない。`ReplayShareModel.CanShare(driver)` の時だけ）、録画中の進捗（`Frame.Index / Clip.FrameCount`）と中止 |
| 受け入れ | 10秒以内・ゴールが入る・相棒が全フレームで画面内（`RaceCameraRig.InFrame` で検査済み）。プレイヤー名・ID・他の人の名前が映らない。下位機で録画が30秒以内に終わる（終わらなければ解像度を下げる） |

## R9-2 引き継ぎ（アカウント連携）の案内（REQ-UXS-073、REQ-UXU-015 の後半、P0）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `AccountLinkPrompt(backend.Store)`。判定 `ShouldShow(context, backend, auth.IsAnonymous, purchased)`（`LinkPromptContext.Home`／`ResultClosed`／`PurchaseComplete` の時だけ真になりうる）。表示 `Show(trigger, ios)` → `AccountLinkPromptView`（`Title`「機種変更でも相棒を引き継げます」・`Body`・`Providers`（iOSはApple先）・`AppleLabel`／`GoogleLabel`・`LaterLabel`「あとで」・`Footnote`）。「あとで」→ `Dismiss()`。連携 → `LinkAsync(auth, credential, analytics)`（`FirebaseAuthTokenProvider.LinkAsync` が `Linked` の時だけ KPI `account_link` を1回）。購入が付与されたら `NotePurchase()` |
| 規則 | 3日目（`UnlocksView.Day>=3`）か初回購入の直後の早い方で1回だけ。FTUE中（`FtueDone`＝命名済み・入厩祝いスカウト済み・ランク戦1戦以上）・レース・マッチング・結果画面・オフライン・削除予約中は出さない。画面に出した時点で表示済み。スヌーズなし（設定の「引き継ぎ」は常に置く） |
| **TODO（Codex）** | ① 1画面（相棒の絵＋見出し＋本文＋2つのボタン＋「あとで」）② 呼ぶ場所：ホームを開いた時（ログボ・オファー・通知の前置きの後。1回に出す案内は1つ）、結果画面を閉じた後、購入完了の後 ③ Sign in with Apple／Google から `FederatedCredential` を作って `LinkAsync`。`CredentialInUse` は既存の切り替え確認（`docs/handoff-unity-3d.md`）④ 設定の「引き継ぎ」で連携した時も `OnLinkResult` を呼ぶ（以後は案内を出さない） |

## R9-3 TA のフレンドのゴースト（REQ-UXS-074、P1）
| 項目 | 内容 |
|---|---|
| 駆動 | ✅ `TimeAttackModel.LoadAsync(trackId)` がフレンド・上位・自分の3つを取り `Picker`（`GhostPicker`）を作る。`Picker.Tab`（既定 Friends、無ければ Top、次に Me）、`FellBack`／`Note`（「フレンドのゴーストがまだありません。上位の記録と走ります」）、`Current`（タブの一覧、速い順）、`Selected`（自己ベストより速い中で一番近い人）、`TimeLine(entry)`（「1:36.5（あと0.5秒）」）、`SelectTab(kind)`／`Select(entry)`、`GhostPicker.TabLabel`。`StartAsync(trackId, ghostCount)` は選んだゴーストを先頭に並走。サーバーは変更なし（`kind=friends` は既存） |
| **TODO（Codex）** | TA画面にタブ3つ（フレンド／上位／自分、件数つき）、一覧、選択、`Note` の1行。ゴーストは半透明の馬（相手には影響しない）。フレンドが0人ならフレンドのタブに「フレンドを追加すると…」とフレンド画面への導線 |

## R9-4 プロトタイプ・確認
- `tools/figma-prototype/site/unity.html`：結果画面と TA 結果の「リプレイを共有」→ 共有カード（3Dでクリップを再生、カードは実データ）、3日目のホームと「その他 → デモ → 初回購入の直後」で引き継ぎの案内、ホームのキー「タイムアタック」でゴースト選択（フレンドのタブ・フォールバック）とゴースト並走。`node tools/figma-prototype/test/round9.test.mjs`、`node tools/figma-prototype/test/e2e.cjs`（u-*-share-card・ta-picker-*・link-prompt-* の画面写真）。
- `dotnet run --project "unity/Checks~/GameChecks"` の「round 9」節、`engine` の `ReplayClipTests`。
