# Unity 3D / Claude implementation handoff

Updated: 2026-11-05（エンジン・サーバー接続を追加）

## 現在の状態

`unity/` は Unity 2022.3.62f1（Built-in RP）。画面は `MuchiApp`、レースの3D表示は `RaceWorld`（Codex作）。
**レースはすべて本番のエンジン（`engine/Muchi.Engine`）で動き、画面のデータはサーバー（`server/`）から取る**ようにつないだ。サーバーに繋がらないときはオフラインで動く。

### 構成（アセンブリ）

| 場所 | アセンブリ | 中身 |
|---|---|---|
| `engine/Muchi.Engine` `Muchi.Net` `Muchi.Client` | UPMローカルパッケージ（`unity/Packages/manifest.json` の `file:../../engine/...`） | 決定論レースエンジン、ロックステップ、APIクライアント、実況、アセットキー、コース形状 |
| `unity/Assets/Muchi/Game` | `Muchi.Game`（UnityEngine参照なし） | 画面とエンジンの間のロジック：レースドライバー（オフライン／オンライン共通）、入力変換、HUD、コース配置、パートナーモデル対応、実況字幕、サーバー連携とオフライン切替、WebSocket |
| `unity/Assets/Muchi/Integration` | `Muchi.Unity` | Unity依存のつなぎ：UnityWebRequest版HTTP、PlayerPrefs保存、設定読み込みと組み立て（`MuchiServices`） |
| `unity/Assets/Muchi/Runtime` | Assembly-CSharp | Codexの画面（`MuchiApp`）と3D表示（`RaceWorld`）。上の2つを使う |

`engine/Directory.Build.props` が3つのパッケージの `bin/` `obj/` を `engine/.build/` に逃がすので、`dotnet test` をしてもUnityに余計なDLL・生成コードは入らない。Unityがパッケージに作る `.meta` は `engine/.gitignore` で無視している（スクリプトはアセンブリ名、データは Resources パスで参照するのでGUIDの共有は不要）。

### つないだもの

| 画面・機能 | 接続先 | オフライン時 |
|---|---|---|
| 起動 | `POST /v1/player/bootstrap`（失敗したらオフライン） | ローカルデータ |
| タイトル → 初レース | `OfflinePresets.Tutorial`（400m直線、自動スタート、ムチだけ） | 同じ |
| 相棒の命名 | 必要なら無料10連（`/v1/gacha/tutorial`）→ 最良の馬に `PUT /v1/horses/:id/name`。カタカナ2〜9文字・NGリストのエラーをそのまま表示 | PlayerPrefs に保存 |
| 初回スカウト表示 | サーバーの抽選結果（上位2頭・ダブり数） | Codexの固定プレビュー |
| ホーム／厩舎 | クラス・シーズンpt・財布（有償/無償/未精算）・相棒の能力・脚質・距離 | Codexのサンプル値 |
| ショップ（コイン） | `/v1/shop/products` の価格・枚数、レビューで `purchase-intent`（年齢・月額上限・1回限り）を確認。**課金処理は未接続** | 固定リスト、確認はできない旨を表示 |
| シーズンパス | `/v1/season-pass`（レベル・XP・有効か） | 表示のみ |
| レースエントリー | オンライン：ランク戦に登録→マッチ（約15秒でCPU補完）→ WebSocketでロックステップ。オフライン：12頭の練習レース（2000m） | 練習レース |
| レース中 | 位置・向きはエンジン状態の補間（`TryGetRender` → `CourseFrame`）。HUD：順位・残り距離・残り脚‰・ムチ残り・かかり・手綱・ゲートまでの時間。実況字幕 | 同じ |
| 結果 | 着順・タイム（エンジン）、オンラインは「サーバー確定／無効」と更新後のシーズンpt | 練習（ポイントなし） |
| 飼い葉（ケア） | `CareModel`：`GET /v1/horses/:id/bond`・`POST …/care`（クールダウン・1日上限・絆レベル・報酬） | PlayerPrefs（`muchi.care.feed`） |
| コースの見た目 | `CourseLooksModel`：`GET /v1/presets`・`PUT /v1/presets/course-look`（持っている見た目だけ） | 標準のみ・PlayerPrefs |
| コンディション | `RoomConditionsModel`：`PUT /v1/presets/room`。自分がホストのフレンドルームがこの条件で走る | PlayerPrefs（`muchi.race.*`） |
| 衣装（3Dモデル） | **ローカルのみ**（LOCAL ONLY 表示のまま。装備のサーバー化はアイテム経済側） | 同じ |

### Codex が次に作る画面向けのビューモデル（`Assets/Muchi/Game/ScreenModels.cs`）

すべて `GameBackend` を受け取り、オンラインならサーバー、オフラインなら端末のデータか「OFFLINE / …」の `Message` を返す。
操作は `Task<ActionResult>`（`Ok` と画面に出す `Message`。サーバーのエラーは `CODE  /  メッセージ`）。UnityEngine には依存しない。

| ビューモデル | 読み込み | 操作 | バインドする値 |
|---|---|---|---|
| `CareModel` | `LoadAsync(horseId?)` | `CareAsync(cardIndex)` | `Bond`（Level/Points/NextLevelAt/TodayActions/DailyActions）、`Card(i).Ready`、`SelectedCard` |
| `CourseLooksModel` | `LoadAsync()` | `EquipAsync(index)` | `Owned(i)`、`EquippedIndex`、`EquippedKey`（`scene/look/*`） |
| `RoomConditionsModel` | `LoadAsync()` | `SaveAsync()`、`ResetAsync()` | `Weather`/`Ground`/`Temperature`/`Wind`（画面のボタン番号）、`TrackId`、`Night` |
| `FriendsModel` | `LoadAsync()` | `SendAsync(code)`、`AcceptAsync`/`DeclineAsync`/`CancelAsync`/`RemoveAsync(id)` | `MyCode`、`List.Friends`/`Incoming`/`Outgoing` |
| `TeamsModel`（支部） | `LoadAsync()` | `SearchAsync(q)`、`CreateAsync`、`JoinAsync`、`LeaveAsync`、`ApproveAsync`/`DeclineAsync`/`KickAsync`/`TransferAsync` | `Mine`（Team/Rank/CooldownUntil）、`InTeam`、`Search` |
| `EventsModel` | `LoadAsync()` | `EnterAsync(eventId)`、`LeaveQueueAsync`、`StandingsAsync(eventId)` | `Events`（Eligible/Fee/Me）、`Board` |
| `TimeAttackModel` | `LoadAsync(trackId)` | `StartAsync(trackId, ghosts)` → `IRaceDriver`、`SubmitAsync()` | `Me`（自己ベスト・残り回数・メダル）、`Ghosts`、`Result` |
| `LeaderboardModel` | `LoadAsync(board?)` | – | `Mine`（Rank/Standing）、`Board` |
| `TournamentsBackend`（大会・観戦、REQ-TOUR/SPEC） | `ListAsync()`、`DetailAsync(id)`、`LiveAsync()` | `RegisterAsync(id)`／`UnregisterAsync(id)`、`JoinHeatAsync(id)` → `IRaceDriver`、`WatchAsync(raceId)` → 観戦用 `IRaceDriver`（PlayerSlot = -1、入力は無視、`delayMs` 遅れで描画） | `Rows`（StatusLabel/CanRegister）、`Heats`（Title/Lines/Watchable）、`Standings`、`JoinNow`、観戦の `Rows`（Title/Subtitle/DelayMs） |

カードの番号とサーバーIDの対応は `ScreenIds`（ケア・コースの見た目・天気・馬場・気温・風）。タイムアタックの `StartAsync` が返すドライバーは
練習レースと同じ `OfflineRaceDriver`（`Run.Race` を直接走らせる）なので、レース画面はそのまま使える。

### 操作の対応（`RaceInput`）

| 画面 | エンジン入力 |
|---|---|
| ＜ ＞（左右矢印キー） | 画面の左右 → 内／外（左回りでは左が内ラチ。右回りは逆） |
| SPUR（Eキー） | 出走前は START、出た後は WHIP（ボタン表示も START/SPUR に切替） |
| REIN 長押し（Space） | 押した瞬間 REIN_PRESS、離した瞬間 REIN_RELEASE |

### 見た目の対応（`PartnerCatalog`）

アセットの取り決め（`contracts/assets.md`）の見た目を、Codexの25モデル（毛色5×勝負服5、`Partner_<Coat>_<Silk>`）に割り当てる。

- 毛色：bay / dark_bay / brown → Bay、chestnut → Chestnut（たてがみ flaxen なら Palomino）、black → Black、gray / white → DappleGrey、不明 → Bay
- 勝負服：色の先頭から系統が決まる色を採用。red / maroon / pink / orange → Crimson、blue / sky / navy → Azure、purple → Violet、green / lime → Emerald、yellow / gold → Gold。white / black / silver / brown は次の色へ、全部ダメなら Crimson
- 試作モデルが表現できないもの（顔・脚の白斑、たてがみ、体格、勝負服の柄、帽子）はモデル既定の見た目のまま
- 自分の馬はワードローブで選んだモデル（ローカル）、他の馬は `start.visuals` から上の対応で選ぶ
- `unity/Checks~/GameChecks` が、マニフェストの horse/* silks/* キーとパレット全色が「モデルに対応」か「表現しない種類として明記」のどちらかであること、25モデルとLODのFBXが存在することを確認する

### 着せ替え・馬具・厩舎の飾り（`CosmeticArt` / `ItemsBackend`、REQ-ITEM-004..007）

- `tack/bridle*` → `Art/Cosmetics/bridle`、`tack/saddlecloth*` → `saddlecloth`、`silks/pattern/*` → `silk-jacket`、`decor/*` → `stable-plaque`（試作アートは種類ごとに1枚。専用アートができたら `CosmeticArt` の対応表に足す）
- `ItemsBackend` がワードローブ・コスメ直販・厩舎の飾り枠・券の使用をサーバーへ送る。オフラインは同梱のプレビュー（LOCAL ONLY）だけで、購入・装備・券は使えない
- `GameChecks` が、マニフェストの tack/* decor/* キーが全部アートに解決できること、オフラインのプレビューが `server/master/items.json` にある品だけであることを確認する

### コースの置き方（`CourseFrame`）

エンジンのコース（内ラチ沿いの距離＋外向きの横位置）を `TrackGeometry` で3Dにし、**ゴールが (0, 0, 420) で +Z 向き**（スタンドとゴール板の位置）になるよう回転・平行移動する。直線だけのコース（初レース）はCodexの Greenfield 直線（ラチ x=±15）をそのまま使い、馬群をラチの間に寄せる。コーナーのあるコースはラチ・走路をコース形状から生成し、スタンドを外側に置く。ナイターは照明を暗くする。

## ローカルでサーバーとつないで動かす

1. サーバー：`cd server && npm ci && npm run dev`（`DEV_MODE=1`、`http://127.0.0.1:8787`）。ランク戦を1人で確定させるには検証サーバーも必要：`dotnet run --project engine/Muchi.Verifier -- serve --urls http://127.0.0.1:8090` を起動し、`npm run dev` に `--var VERIFIER_URL:http://127.0.0.1:8090` を足す（なければ1人ランク戦は「無効」で終わる）。
2. Unity：`unity/` を開く → 初回はパッケージ（Muchi Engine / Net / Client SDK）の取り込みを待つ → **Muchi → Create Frontend Scene** → Play。
3. 接続先は `unity/Assets/Resources/Muchi/server-config.json`（既定 `local` / `http://127.0.0.1:8787`、`x-dev-user` は端末ごとに自動生成）。実機から PC のサーバーへは PlayerPrefs `muchi.server.baseUrl` に PC のIPを入れる。サーバーなしで試すときは `muchi.server.offline` = `1`。
4. staging / production は Firebase 認証が必要。Firebase Unity SDK（FirebaseAuth、11.x）を取り込み、`google-services.json` / `GoogleService-Info.plist` を置き、Scripting Define Symbols に `MUCHI_FIREBASE` を追加するだけでよい。**起動時の配線は `MuchiApp` 済み**：
   - `Awake` で `MuchiFirebase.Prepare()` → `MuchiServices.FirebaseTokens` を設定してから `MuchiServices.Create()`（ApiClient が最初から Firebase のトークンを使う）。
   - `InitBackend` で `await MuchiFirebase.InitializeAsync()`（依存関係の確認・修復）→ `backend.InitializeAsync()`（bootstrap）。依存関係が使えない端末では警告を出し、bootstrap が失敗してオフライン表示になる（例外で止まらない）。
   - トークン取得の失敗（SDK 例外・未ログイン）は `NetworkException` として返る：画面側は通常のオフライン／エラー表示、ランク戦エントリーは「NETWORK / …」で終わり「マッチング中」のまま止まらない。
   - Firebase がユーザーをサインアウトした（トークン失効・ユーザー削除）後の次のリクエストは、自動で匿名ログインし直す。
   - アカウント連携（設定画面から）：`FirebaseAuthTokenProvider.LinkAsync(cred)` の結果は `Linked` / `CredentialInUse`（別アカウントが所有 → プレイヤーに確認して `SwitchToExistingAccountAsync()`。**Apple の資格情報は使い捨て**なので、引数なしで呼ぶと Firebase が返した差し替え資格情報 `FirebaseAccountLinkException.UserInfo.UpdatedCredential`＝`PendingSwitchCredential` で切り替える）/ `ProviderAlreadyLinked`（この端末のアカウントに既に別の Apple/Google が紐付いている → 切り替えではなく「連携済み」と表示）。
   - ロジックは `Assets/Muchi/Game/FirebaseAuth.cs`（`unity/Checks~/GameChecks` でテスト）、SDK 呼び出しは `Assets/Muchi/Integration/FirebaseSdkAuth.cs`。`MUCHI_FIREBASE` 付きの型チェックは `dotnet build "unity/Checks~/UnityFirebase"`（SDK のスタブ `FirebaseStubs.cs` に対して。スタブは SDK 11 の公開 API の形を写したもので、本物の確認は SDK を取り込んだ Editor／実機ビルド）。
   - 定義が無い間は従来どおり（ローカルは開発用認証、それ以外はオフライン）。

## Unity エディタでの確認が必要なこと（ここでは未確認）

この環境に Unity は無い。代わりに次を自動で確認している：

- `unity/Checks~/Muchi.Game`：ゲーム層を Unity と同じ条件（netstandard2.1・C# 9・UnityEngine参照なし）でビルド
- `unity/Checks~/UnityRuntime`：`Integration` と `Runtime` のスクリプトを UnityEngine 2022.3.62 の参照アセンブリ（NuGet の第三者再配布 `RocketModFix.UnityEngine.Redist`、ビルド時の参照のみ）で型チェック。**Codexの元の `RaceWorld.cs` はここで3件のコンパイルエラー（GameObject に localPosition 等）が見つかり、修正済み**。Editor スクリプトは対象外
- `unity/Checks~/GameChecks`：入力変換・HUD・コース配置・モデル対応・オフラインレース（初レースと練習）・オフライン切替。`online <URL>` で命名→スカウト→ショップ→パス→ランク戦を本物のサーバーで通す（`scripts/integration.sh` のシナリオ8）

エディタで確認してほしいこと：

1. パッケージ取り込みでエラーが出ないか（Package Manager に Muchi Engine / Net / Client SDK が出る）。`Muchi.Game` `Muchi.Unity` asmdef と Assembly-CSharp がコンパイルできるか
2. Play で タイトル → 初レース → 命名 → スカウト → ホーム → レース が通るか（サーバーなし／`npm run dev` あり の両方）
3. FBXの向き・大きさ・足元（`RaceWorld.Anchor` で 180° 回転・0.95倍）。コーナーで馬が進行方向を向くか、カメラが追うか
4. 生成コース（ラチ・走路）の見た目と負荷。2000m で数百個のプリミティブを作るので、実機で描画負荷を測り、必要ならメッシュ結合かアート側のコースキット（`Greenfield_Trackside_Kit.fbx`）に置き換える
5. `PartnerGallop` のボーン名・軸、Animator の Speed パラメータ
6. 実機（iOS/Android）で `ClientWebSocket` の接続（WebGL は非対応）。PCのサーバーへは同じLANで baseUrl を設定
7. 日本語フォント・セーフエリア・横向き固定

## 3Dアセットの作り直し

Blender 4.3 以上：

```sh
cd unity
blender -b -t 4 -P Assets/Art3D/build_asset_library.py
```

25 のパートナーFBX、25 の対戦相手用LOD、モジュール式の馬・騎手FBX、プレビュー画像5枚、Greenfield トラックサイドキット、元の `.blend` を作り直す。
