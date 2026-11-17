# U1 B：お金まわりの Unity 画面（ショップ・スカウトの確認・購入・受け取り・シーズンパス）

ブランチ：`unity/shop`（`origin/claude/unity-screens-base` から）
ファイル：`unity/Assets/Muchi/Runtime/MuchiApp.Shop.cs`（画面）、`unity/Assets/Muchi/Game/ShopLayout.cs`（画面の矩形と検査）
見本：`tools/figma-prototype/site/app.js` の `ScoutConfirm`・`Shortfall`・`Store`・`PurchaseConfirm`・`Receipt`・`SeasonPass`

画面はすべて画面キット（`MuchiApp.Kit.cs`：`Card`・`Kicker`・`Body`・`Cta`・`Ghost`・`Moment`）で描き、1画面に `Cta` は1つまで、本文は16px以上、金色はお金・レア度・順位だけ。文はモデルとサーバーの文をそのまま出し、画面が足すのはボタンの文だけ。英語は `Loc` の表（`ui-en.json`）で出す。

## 1. 作った画面と使うモデル

| 画面 | 入口 | 使うモデル |
|---|---|---|
| ショップ（おすすめ／コイン／見た目／パス） | ホームの SHOP（`Store()`）、見た目・世話の画面のショップボタン | `ShopModel`（`CoinPacks`・`Cards("recommended")`・財布2行・はじめての購入の文・削除予約／未精算の帯・法定リンク）、`AllowanceModel`（厩舎手当の今日の分） |
| コインのパック | ショップの「コイン」 | `ShopModel.CoinPacks`：**サーバーの一覧そのまま**（安い順）。`retiredProducts` で外れたパックは一覧に来ないので出ない。品番は画面に書いていない |
| コイン不足の案内（T6） | スカウトで足りない時（引く前の確かめ・断られた引き） | `CoinShortfallModel`（見出し・パック1つ・閉じるが主ボタン、購入後は元の引きへ） |
| スカウトの引き方 | スカウト画面の「引き方を選ぶ」 | `GachaBackend.BannersAsync` ＋ **新規** `GachaBackend.ScoutOptionsAsync`（コイン・持っている券・SR以上確定券を、使う場所＝スカウトに並べる） |
| スカウトの確認 | 引き方を押す | `ScoutConfirmModel`（有償・無償を分けた1行、内訳の棒、引いた後の財布、天井pt、提供割合へ、引く／閉じる）。引いた結果は `Moment`（いちばん良い馬・新規とダブりの1行） |
| 提供割合 | 確認・引き方の「提供割合を見る」 | `GET /v1/gacha/:id/odds`／SR以上確定券は券の表（`GetTicketOddsAsync`） |
| 購入の確認と年齢 | 各「購入を確認」 | `PurchaseConfirmModel`（purchase-intent → 生年月はサーバーが求めた時だけ → 18歳未満だけ保護者の同意 → 確認の行） |
| 受け取り（レシート） | 購入の完了 | `PurchaseReceiptModel`（届いた物ごとの行と使い道、いまの財布、注記、**次の一歩は1つ**：券を使う／パスへ／手当を受け取る／見た目へ／スカウトへ） |
| シーズンパス | ホームの SEASON PASS、ショップの「パス」 | `SeasonPassModel`（レベル・XP・次の特別な段・30段の道と特別な段の印・6段ずつのページ・受け取り・まとめて受け取る・特別な段の `Moment`）、`ShopModel.PassProducts`／`PassTotalLine`／`PassScreenAllowance`、`SilksEditorModel`（自分の勝負服の色） |
| 見本価格だけの見た目 | 天気・コースの「レビュー」 | 商品がまだ無いので「買えません」と言うだけの確認（`ShopLockedReview`） |

### 1.1 リモート設定に従う所（サーバー側は並行の D で有効化）

- `retiredProducts`：サーバーの `/v1/shop/products?mine=1` が外したパックを出さない。8 → 6 はサーバーの一覧が変わるだけで Unity の更新は要らない。
- `allowanceUnderPass`：サーバーが厩舎手当の `tab` を `pass` にすると、おすすめから消えてパスの画面の右下（`allowance` の枠）に出る。手当が動いている間は同じ枠が「今日の分を受け取る」になる。

### 1.2 シーズンパスの試着

左の枠は、プレイヤーの今の勝負服（`SilksEditorModel.View.Current`）に特別な段の見た目を着せた絵（`SeasonPassModel.PreviewDesign`／`PreviewSet`：保存も購入もしない）。色は勝負服エディタの色の hex。帽子・胴・柄の2色目・袖を矩形で塗った**板**で、エディタの写実の塗り（マスク）ではない（Unity にはまだ勝負服エディタの画面が無い）。印のボタン（10・15・20・30・セット）で切り替え、マスの「試着」でもその段を着せる。特別な段を受け取ると `Moment` が1回出て（`TakeMoment` は1回で消える）、ボタン「勝負服に着てみる」でその段を試着の枠に出す。

## 2. モデルの追加（GameChecks `ShopScreenChecks`）

| 追加 | 検査 |
|---|---|
| `ProductCard.Kind`（サーバーの種類） | おすすめの手当・パスのカードの見分け |
| `ShopModel.CoinPacks` | 8つの一覧 → 8つ（安い順、サーバーの順に依らない）。`coin_800`・`coin_2400` が外れた一覧 → 6つ、最小と最大は残る |
| `ShopModel.PassScreenAllowance` | `tab: recommended` → おすすめにあり、パスの画面に無し。`tab: pass` → おすすめから消え、パスの画面に同じ商品・同じ値段 |
| `ShopModel.PassProducts` | パス・パス＋を安い順に |
| `ShopModel.PassTotalLine(view)` | 「有料ライン 無償コイン1,500枚・配合素材30個　＋　特別な段の見た目3点」、パス未購入なら「　·　届いている15段は購入後すぐ受け取れます」。英語のテンプレート |
| `ShopModel.AllowanceClaimable` | 手当なし → 偽、動いていて今日の分が残る → 真、オフライン → 偽 |
| `SeasonPassModel.StandoutState(standout)` | 受け取れます／あと5段（24戦）／受け取り済み・勝負服エディタで選べます／到達済み・パスを買うとすぐ受け取れます |
| `GachaBackend.ScoutOptionsAsync(bannerId)` | サーバーの引き方3つ（コイン・券・SR以上確定券）、知らないバナー → 1文、オフライン → オフラインの文 |
| `ShopLayout`（矩形と検査） | 下の §3 |

既存の `Round8Checks.SeasonPassStandouts` と `MonetizationQualityChecks.Options` の見本 JSON を `internal` にして使い回した（中身は同じ）。

## 3. 配置の検査（ShopLayout）

画面は `ShopLayout` の箱にしか描かない（`l["名前"]` で取り出し、無い名前は例外）。`ShopLayout.All()` が57の画面の状態（コインのパック0〜8、おすすめ0〜4、引き方1〜5、購入の確認の全段階、レシート0〜5行×次の一歩あり／なし、パスの特別な段0〜5 …）を返し、検査は：

- すべての箱が 1600×900 の中、
- 文字・ボタンが言語ボタン（`Clear()` が毎画面 1370,132 に置く）に重ならない、
- 文字は16px以上、
- 文字どうし・文字とボタン・ボタンどうしが重ならない、
- `Cta` は1つまで（キットの高さ：Cta 76・Ghost 64・Kicker 24）。

検査そのものが小さすぎる文字・重なり・はみ出し・Cta 2つ・言語ボタンの下を見つけることも確かめている。座標は見本のダイアログの大きさと内側の位置（例：スカウトの確認 1000×640、引くボタンは右下 450 幅、閉じるは左下）を画面の絶対位置に直したもの。パスは見本の横スクロールの代わりに6段ずつのページ（◀ ▶）。

パスの道の数字（特別な段のレベル）は実際の段の位置に描く。検査は 5・10・15・20・25・30 の印で確かめた（隣り合う段に特別な段が2つ来ると数字が重なりうる：今のマスターでは 10・15・20・30）。

## 4. 英語

`ui-en.json` に `_u1shop` の節を足した（画面の文・合計の行・特別な段の状態・年月の表示）。`ShopScreenChecks` が `MuchiApp.Shop.cs` の日本語の文字列すべてと、画面が組み立てる行（財布・段・合計など）を英語の表で引いて確かめる。`L10nChecks` はモデル側の新しい文を確かめる。

## 5. MuchiApp.cs の変更（つなぎだけ）

- `Store()`・`SeasonPass()`・`PurchaseReview(…)`（2つ）を1行の転送にした（中身は新しい画面）。古いストア・パス・年齢ボタンの本体と、使わなくなったフィールドは消した（同じ範囲の中だけ）。
- スカウト画面の「VIEW COIN SHOP」を「引き方を選ぶ」（`ShopScoutWays`）に替えた。

## 6. まだのこと・オーナーの判断

- **ストアの決済はまだつながっていない**。購入の確認は purchase-intent・年齢・保護者の同意まで本物。主ボタンはローカルの開発サーバー（`UsesDevAuth`）でだけ偽のストア（`StorePlatform.Fake`）で購入→レシートまで通り、他の環境では押せない（「このビルドではストアの決済はまだつながっていません」）。ストアの SDK をつなぐ時は `BeginStore` の後で SDK を開き、結果を `StoreFinishedAsync` に渡す。
- **見た目タブ**は試着の画面（勝負服と馬の見た目・コースの見た目）への2つの入口だけ。コインで買う見た目の一覧（`ItemsBackend`）と試着→購入は見た目の画面の側の仕事。天気・コースの「見本価格」の品は商品が無いので「買えません」とだけ言う。
- **勝負服エディタの画面が Unity に無い**ので、パスの試着は板の絵、試着の枠の下のボタンは「勝負服と馬の見た目へ」（今の見た目の画面 Wardrobe）。受け取りの文「勝負服エディタで選べます」はサーバー・モデルの文のまま。エディタの画面ができたら行き先を替える。
- 法定表示（特商法・資金決済法・有償コインの使用順）はショップの下に題名を並べるだけで、本文の画面は Unity にまだ無い。
- スカウト画面そのもの（バナーの一覧・天井・めくりの演出）は今回の範囲外。古いスカウト画面の「PAID SCOUT PAUSED」の文は残っている（引き方の画面からは引ける）。引いた結果はめくりではなく `Moment` 1枚。
- 年齢の入力は年と月の ◀ ▶（最初は空、最初の一押しで「今年−16」）。選択肢をこちらから大人の年に寄せないための形。オーナーが別の入力（数字の入力欄など）を望むなら替える。
- Unity では見られないので、絵は見本の撮影（`bash tools/figma-prototype/build.sh` → `E2E_ONLY=unity node tools/figma-prototype/test/e2e.cjs`：`u-19/20/21-shop-*`、`u-23〜27-purchase-*`、`u-29/30-season-pass*`、`u-76-…-shortfall`）と座標で突き合わせただけ（コインは2列×4段、パスは左に試着・上に道と次の特別な段・中にマス・下に値段の行と主ボタン、と同じ並び）。見本との違い：パスのマスは横スクロールでなく6段ずつのページ、ショップの下のナビは無い（戻るボタン）。実機で見た目の確認が要る。
