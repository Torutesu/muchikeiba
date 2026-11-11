# Round 19 Codex 向け引き継ぎ：引き継ぎコード（IDとパスワード、REQ-TRF-001〜020）

更新：2026-11-11　基準ブランチ：`feat/r19-transfer-code`（`claude/round17` の上）
仕様：`contracts/protocol.md` §54、`docs/spec/requirements.md` 54章、法務の決まり `docs/planning/03-legal-risk.md`「引き継ぎコード」、運用（鍵の入れ替え）`docs/ops/deploy.md` §9.6。経済の目標（E）は無し（コインもアイテムも動かない。アカウント＝uid そのものが新しい端末に移る）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル・Firebase の配線）／Codex＝見た目（画面・入力・音）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET/POST/DELETE /v1/transfer/code`（状態・発行・取り消し）、`POST /v1/transfer/redeem`（入力 → 元のアカウントの Firebase カスタムトークン）。古い端末は次の要求で `401 SESSION_REPLACED`。メンテナンスでも止まらない |
| C# | ✅ `ApiClient.GetTransferCodeAsync` / `IssueTransferCodeAsync` / `RevokeTransferCodeAsync` / `RedeemTransferCodeAsync`、`TransferCodeRules`（正規化・表示の形・パスワードの規則）、`TransferException`（`Rules` / `RetryAfterSec` / `Reason` / `Confirm`）、`SessionReplacedException` と `ApiClient.SessionReplaced` イベント（`engine/Muchi.Client/TransferCode.cs`） |
| ゲーム層 | ✅ `Muchi.Game.TransferCodeModel`（`unity/Assets/Muchi/Game/TransferCodeModel.cs`、チェックは `unity/Checks~/GameChecks/TransferCodeChecks.cs`）。`new TransferCodeModel(new ApiTransferCode(backend.Api), new FirebaseTransferSignIn(MuchiFirebase.Tokens), () => backend.Online, installId: <インストール ID>)` |
| Firebase | ✅ `FirebaseAuthTokenProvider.SignInWithCustomTokenAsync` / `SignOutReplacedSession`、`ICustomTokenAuthBackend`（`MUCHI_FIREBASE` の時の `FirebaseSdkAuthBackend` が実装。SDK の `SignInWithCustomTokenAsync` / `SignOut`） |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：その他 → 設定 →「IDとパスワード」（発行）、タイトル画面の「データ引き継ぎ」（入力）。入力の画面の「前の端末のコードを入れる」（デモ）で、別のアカウント（ハヤテ）のコードで最後まで通せる |
| **Codex** | 発行の画面（§2）、入力の画面（§3）、確認のシート（§4）、完了（§5）、古い端末の案内（§6）、設定とタイトルの入口（§7）、英語・文字の大きさ・オフライン（§8） |

## 2. 発行の画面（設定 → 引き継ぎ → 「IDとパスワード」、「ムチ一閃」のトーン）

見本と同じ 1600×900 の構図。**背景 `Art/home-paddock` 全面、左を暗くする影、紺の半透明パネル2枚、主ボタン（斜めのシアン »）は1つ（「発行する」）**。
- 上の帯：題「引き継ぎコード」、説明「IDとパスワードで機種変更できます（Apple・Googleがなくても引き継げます）」、財布と EN。
- **左パネル**：キッカー「あなたのID」。ID は**大きく・等幅の数字の書体・字間を広く**（`CodeLine`、例 `K7M-Q3X-PHR`。無ければ「まだ発行していません」を灰で）。その下に期限 `ExpiryLine`（金、期限切れは注意色「有効期限が切れています」）。
  - `GeneratedPassword` がある時だけ、金の細い枠の中に「パスワード」（シアンの小さなラベル）とパスワードを大きく、その下に `GeneratedNote`（「このパスワードはこの画面でしか表示されません。メモしてから閉じてください」）。
  - ゴースト「コピー」（`CopyText` をクリップボードへ → `CopiedText` を短いトースト）、文字リンク「このコードを取り消す」（`RevokeAsync`、確認なし）。
  - 細い線の下に `SingleUseNote` と `KeepSecretNote`（灰、小さく）。
- **右パネル**：キッカー「パスワードを決める」（コードがある時は「新しく発行する（前のコードは使えなくなります）」）。
  - 入力欄2つ（「パスワード」「パスワード（確認）」、伏せ字、目のアイコンで表示の切り替えは任意）。**全角で打っても同じパスワードになる**（モデルとサーバーが半角にする）ので、入力の種類を半角に強制しなくてよい。
  - 決まりのチェック表 `RuleLines(password)`：4行（「8〜32文字」「半角の英数字と記号」「英字と数字を両方使う」「よく使われるパスワードは使えません」。文はサーバーから）。満たした行は**シアンの ✓ と太字**、まだの行は灰の「・」。打つたびに更新。赤で責めない。
  - 主ボタン「発行する »」（`CanIssue(pw, again)` が false の間は無効。押したら `IssueAsync(pw, again)`）、ゴースト「自動で作る」（`IssueAsync(null)`）。`Message` は注意色の1行で欄の下に。
  - 一番下に小さく：発行は1日◯回まで（`Status.IssuesPerDay` / `IssuesToday`）、有効期限は発行から◯日（`Status.ExpiryDays`）。
- **画面を離れる時は必ず `LeaveIssueScreen()`**（作ったパスワードを忘れる。戻ってきても二度と出ない）。スクリーンショットの禁止は OS の機能に任せる（入れなくてよい）。

## 3. 入力の画面（タイトル →「データ引き継ぎ」、設定の引き継ぎからも）

- 上の帯：題「データ引き継ぎ」、説明「前の端末で発行したIDとパスワードを入力してください」（財布は出さない：まだアカウントが決まっていない）。
- **左パネル**：キッカー「ID　/　XXX-XXX-XXX」と大きな入力欄（等幅・字間広め・プレースホルダー `K7M-Q3X-PHR`）、キッカー「パスワード」と入力欄（伏せ字）。注意色の1行 `RedeemMessage`。主ボタン「引き継ぐ »」（`CanRedeem(id, pw)` が false の間は無効、押したら `RedeemAsync(id, pw)`）。下に小さく「大文字・小文字・ハイフン・全角はどちらでもかまいません。何度も間違えると、しばらく入力できなくなります」。
- **右パネル**：キッカー「引き継ぐとどうなる？」と4行（見本の文：前の端末のアカウントで遊べる／この端末のデータは使えなくなる（先に確認）／前の端末では遊べなくなる／コードは1回だけ）。
- `State == Busy` の間はボタンを押せない見た目（くるくる）。**`RedeemAvailable == false`（カスタムトークンでサインインできないビルド）なら入口ごと出さない。**
- エラーの文はモデルの `RedeemMessage` をそのまま（「IDまたはパスワードが違います」など）。**「そのIDはありません」のような文は作らない**（サーバーも言わない）。ロック中は「入力の回数が多すぎます。◯分ほど待ってからお試しください」。

## 4. 確認のシート（`State == NeedsConfirm`）

この端末のアカウントに進行（コイン・馬・レース・購入）がある時だけ出る。中央のダイアログ（紺、暗い背景）。
- キッカー「確認」、題「この端末のデータは使えなくなります」、`ConfirmText`（**金**、例「この端末のデータ（有償コイン310枚・馬3頭・レース5回）は、引き継ぎの後に使えなくなります。」— 有償コインが先頭。資金決済法の明示なので省略しない・小さくしない）、灰の補足「Apple・Googleでアカウントを切り替える時と同じです。残したいときは「やめる」を押してください。」
- 主ボタン「引き継ぐ »」（`ConfirmAsync(id, pw)`）、ゴースト「やめる」（`CancelConfirm()`）。「やめる」を小さくしすぎない（同じ高さ）。

## 5. 完了（`State == Done`）

- キッカー「引き継ぎ完了」、題 `DoneText`（「データを引き継ぎました」）、その下に**名前 `ArrivedName` を金で1行（プレイヤーが付けた名前：訳さない）**。
- このあとアプリはサインインしたアカウントでデータを読み直す（`UserChanged` → いつもの起動の流れ。ホームへ）。完了の画面は短いトーストでもよい。
- 入力の後にサインインだけ失敗した時は `RedeemMessage` が「引き継ぎは受け付けました。通信できる場所で「引き継ぐ」をもう一度押してください」になる。同じ ID・パスワードのまま「引き継ぐ」を押せば、モデルが同じキーで送り直して新しいトークンを受け取る（入力欄を消さない）。

## 6. 古い端末の案内（`401 SESSION_REPLACED`）

`ApiClient.SessionReplaced` が来たら、どの画面にいても全画面の案内へ（メンテナンス画面と同じ構図：左の影、大きな題）。
- キッカー「引き継ぎ」、題 `ReplacedTitle`（「別の端末に引き継がれました」）、本文 `ReplacedBody`、灰の補足「心当たりがないときは、ヘルプのお問い合わせから運営に知らせてください。」（ヘルプの問い合わせはこのアカウントでは送れないので、新しく始めた後のアカウントから）。
- 主ボタン `ReplacedRedeemCta`「引き継ぎコードを入力 »」（入力の画面へ）、ゴースト `ReplacedNewCta`「新しく始める」。どちらも先に `MuchiFirebase.Tokens.SignOutReplacedSession()` を呼ぶ（次の要求で新しい匿名アカウントになる）。
- 再試行のボタンは置かない（直らない）。レース中に来た場合もレースの画面を閉じて案内へ。
- R19 統合：この画面はメンテナンスと同じ「1か所」から出す。`MaintenanceModel.Attach(api)` が `ApiClient.SessionReplaced` も受け、`Screen == MaintenanceScreen.SessionReplaced`（`Title`／`Body` は上の文言）になる。メンテナンス・強制アップデート・オフライン・再読み込みはこの画面を置き換えない。2つのボタンのどちらかを押したら `MaintenanceModel.LeaveSessionReplaced()`。

## 7. 入口

- **設定の「引き継ぎ」**：Apple・Google のボタンの横に、同じ大きさのゴースト「IDとパスワード」。Apple／Google で登録済みでも出す（両方使える）。`Status.Visible == false` なら出さない。
- **タイトル画面**：右下（シーズンの表記の上）に文字リンク「データ引き継ぎ」。同意してはじめる前に押せる（新しい端末では最初にここ）。FTUE の途中でも設定から入れる。
- 3日目の「引き継ぎの案内」（`AccountLinkPrompt`）に、Apple・Google と並べて「IDとパスワード」を足してよい（任意。出す条件はそのまま）。

## 8. 英語・文字の大きさ・オフライン

- 英語：画面の文は `Loc.T`（`ui-en.json` に全部ある。決まりの4行はサーバーが英語で返す）。名前は訳さない（`ArrivedName` は別の行にしてある）。ID とパスワードの欄には `keep-ja` 相当（訳の対象外）を付ける。
- 文字の大きさ（§41）：最大でもチェック表の4行・ID・確認の文が欄からはみ出さない（見本の a11y-flow で確認済みの配置）。ID は1行で縮めない（字間を詰める）。
- オフライン：発行・入力とも `OfflineText`（「オフラインです。通信できる場所でお試しください」）。入力欄の中身は消さない。
- **やらないこと**：ID・パスワードをログ・分析・クラッシュレポートに出さない（入力欄の値をデバッグ表示しない）。カウントダウン・「今だけ」などの言葉。ID の有無が分かる表示。

## 9. 確認のしかた

- `dotnet run --project unity/Checks~/GameChecks`（「round 19: 引き継ぎコード」）
- 見本：`bash tools/figma-prototype/build.sh && node tools/figma-prototype/test/e2e.cjs`（`u-*-transfer-*.png`、`en-*-transfer-*.png`、`a11y-*-transfer-*.png`）
