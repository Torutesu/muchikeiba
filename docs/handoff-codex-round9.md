# Round 9 Codex 向け引き継ぎ：アセット配信（REQ-DLV-001〜010）

更新：2026-11-06　基準ブランチ：`feat/r9-asset-delivery`（`claude/round8` から）　前提：`docs/handoff-codex-round8.md`（§4.3 のキー一覧と優先度）
仕様：`contracts/assets.md` §6.1、`contracts/protocol.md` §16、`docs/spec/requirements.md` 9.15.1

分担はこれまでと同じ：**Claude＝ロジック（配信の仕組み・サーバー・ダウンロード・画面のビューモデル）／Codex＝見た目（ファイルを作って置く・画面を描く）**。
Addressables は使わない。**Codex がやるのは「決まった場所に決まった名前でファイルを置く」→「スキャナを回す」だけ**で、配信・検証・キャッシュ・フォールバックはロジック側で動く。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| マニフェストのキー | 403件（`contracts/assets.manifest.json`）。配信用のファイルは **0件**（全部 `<kind>/default` → 表示なし で動いている） |
| サーバー | ✅ `GET /v1/assets/catalog?platform=ios|android`（ETag/304）、`GET /v1/config` の `assetCatalogVersion`、リモート設定の `assets` |
| スキャナ | ✅ `cd server && npm run scan:assets`（CI では報告だけ。失敗にならない） |
| C# | ✅ `AssetCatalogStore`（取得・保存・オフライン）、`AssetDownloader`（並列・再開・再試行・SHA-256・容量・古い版の削除・進み具合）、`AssetResolver`（フォールバック）、`HttpClientAssetHttp` |
| Unity 連携 | ✅ `Assets/Muchi/Integration/UnityAssetHttp.cs`（UnityWebRequest、ファイルへ直接書く） |
| 画面のモデル | ✅ `Muchi.Game.AssetPreloadModel`（起動・チュートリアル前のダウンロード画面） |
| 画面 | **Codex**：ダウンロード画面の見た目と、各画面のアセット読み込みを `AssetResolver` 経由にする（§4） |

## 2. フォルダとファイル名（ここに置くだけ）

```
unity/AssetDelivery~/            ← 末尾の ~ で Unity はこのフォルダを読み込まない（ビルド出力の置き場）
  common/                        ← 全プラットフォーム共通（png・ogg・wav など、そのまま使えるファイル）
    sfx/race/whip.ogg            → キー sfx/race/whip
    ui/gate/5.png                → キー ui/gate/5
    voice/ja/num/3.ogg           → キー voice/ja/num/3
  ios/                           ← iOS 用にビルドしたもの（AssetBundle など）。同じキーなら common より優先
    horse/coat/bay.bundle        → キー horse/coat/bay
    scene/venue/aoba@v2.bundle   → キー scene/venue/aoba@v2（作り直し版）
    scene/minato.bundle          ← 複数のキーを入れたファイルは bundles.json で指定
    bundles.json
  android/
    （ios と同じ構成）
```

- **キー＝フォルダからのパスから最後の拡張子を除いたもの**。キーの一覧と意味は `contracts/assets.md` §3、全403件は `docs/handoff-codex-round8.md` §4.3。
- ファイル名は**小文字の英数字・`_`・`.`・`@`・`-` だけ**（空白・大文字・日本語は不可。スキャナが「キーにならないファイル」として報告する）。
- 1つのファイルに複数のキー（例：競馬場のシーン一式）を入れるとき：

```json
{ "bundles": { "scene/minato.bundle": ["scene/venue/minato", "scene/surface/minato_turf", "scene/surface/minato_dirt", "scene/night/minato"] } }
```

- 無視されるもの：`.` で始まるファイル、`*.meta`、`*.manifest`（AssetBundle のマニフェスト）、`README*`、空のファイル。
- AssetBundle は**キー1つ＝アセット名1つ**で入れる（読み込み側は `bundle.LoadAsset(key)` を想定。アドレスはキーそのもの）。
- 大きいバイナリは Git LFS を推奨（`*.bundle`・`*.ogg`）。コミットしない運用でも、スキャナは手元のフォルダで動く。

### 2.1 アプリに同梱するもの（ダウンロードしない）

`contracts/assets.md` §6 のとおり、**全 kind の `<kind>/default`（28件）**、チュートリアルのコース（`scene/venue/aoba`・`scene/surface/aoba_turf`）、
よく使う効果音は `Assets/Resources/Muchi/Assets/<key>`（例：`Resources/Muchi/Assets/horse/coat/default`）にも入れる。
同梱しているキーは `AssetPreloadModel` の `bundled` に渡せばダウンロードしない（同梱と配信の両方にあれば配信の新しい方が優先）。

## 3. スキャナ（`npm run scan:assets`）

```
cd server
npm run scan:assets -- --check          # 報告だけ（何も書かない）。CI と同じ
npm run scan:assets -- --check --list   # 足りないキーを全部表示
npm run scan:assets                     # server/master/assets-catalog.json を作り直す（中身が変われば catalogVersion +1）
npm run scan:assets -- --json /tmp/r.json   # レポートを JSON で（uploads[] = CDN に置くファイルの一覧）
```

出力の例（いまの状態）：

```
asset delivery scan: 403 manifest keys, catalogVersion 1 (unchanged)
  ios: 0/403 keys have files, 403 missing (fall back to <kind>/default); 0 files, 0.0 MB; FTUE blocking 0.0 MB
    missing by kind: voice/ja/phrase 143, voice/ja/name 44, item 24, silks/pattern 20, title 20, …
```

- **「N/403 keys have files」がリリースまでに 403/403 になればゼロ**（Round 8 の「何も無い357件」もここで減っていく。仮のアート46件は配信ファイルではないので数えない）。
- 「files without a key」：名前の誤り・マニフェストに無いキー・未知の kind。直すかキーの追加を Claude に依頼する（§6）。
- 「PROBLEM … ftueBlockingMaxBytes」：チュートリアルが待つファイル（boot/ftue の required）が 3MB を超えた。カタログは書き込まれない。
  グループ・required は `contracts/assets.groups.json` で決まる（Codex は変更しない。変えたいときは依頼）。
- カタログ（`server/master/assets-catalog.json`）の差分は**ファイルと一緒にコミット**する。サーバーのテストがカタログの形式を検査する。

### 3.1 CDN への配置（運用、参考）

`--json` の `uploads[]` が `{ from: "ios/horse/coat/bay.bundle", to: "ios/<sha256>/horse/coat/bay.bundle" }` を並べる。
`to` を R2 バケット（`ASSET_CDN_BASE` のカスタムドメイン）に置けば配信される（例：`wrangler r2 object put muchi-assets-staging/<to> --file unity/AssetDelivery~/<from>`）。
パスに中身のハッシュが入るので上書きは起きず、古いアプリ用の古いファイルもそのまま残る（REQ-DLV-010）。バケットとドメインはまだ無い（`wrangler.toml` の `ASSET_CDN_BASE` は REPLACE_ME）。

## 4. Unity 側のつなぎ方

```csharp
// 起動時（1回）
var cache = new AssetCache(Path.Combine(Application.persistentDataPath, "muchi-assets"), NativeFreeBytes /* 無ければ null */);
var catalogs = new AssetCatalogStore(new UnityHttp(settings.BaseUrl, settings.RequestTimeoutMs), cache,
    Application.platform == RuntimePlatform.IPhonePlayer ? AssetPlatforms.Ios : AssetPlatforms.Android);
var downloader = new AssetDownloader(new UnityAssetHttp(), cache);
var preload = new AssetPreloadModel(catalogs, downloader,
    () => Application.internetReachability == NetworkReachability.ReachableViaLocalAreaNetwork ? NetworkReach.Wifi
        : Application.internetReachability == NetworkReachability.ReachableViaCarrierDataNetwork ? NetworkReach.Cellular : NetworkReach.None,
    key => Resources.Load("Muchi/Assets/" + key) != null /* 同梱の判定。一覧を持つ方が速い */,
    () => (long)(Time.realtimeSinceStartupAsDouble * 1000));
await preload.PrepareAsync();
```

### 4.1 ダウンロード画面（起動直後・同意画面の前後、REQ-DLV-009）

毎フレーム `AssetPreloadModel` を読んで描く。文言は全部モデルにある（画面で作らない）。

| 表示 | 値 |
|---|---|
| 状態の1行 | `StatusLine`（「データを確認しています…」「ダウンロード中 40%（2.1MB）」「準備ができました」「オフラインのため…」） |
| 進み具合のバー | `BlockingFraction`（待つ分だけ）。グループごとは `GroupProgress("boot")` など |
| サイズ | `BlockingSizeLabel`（待つ分）、`BackgroundSizeLabel`（裏で取る分）、`TotalSizeLabel` |
| モバイル通信の確認 | `NeedsConsent` が true の間ダイアログ。本文 `CellularWarningText`。「今すぐ」→ `AcceptCellular()`、「あとで（Wi-Fi で）」→ `DeferToWifi()` |
| 次へ | **`CanStartTutorial` が true になったら自動で初レースへ**（ボタンを待たせない）。`StartedWithPlaceholders` のときは何も言わずに仮の表示で進む |

- 通信状態が変わったら `OnNetworkChanged()`（Wi-Fi になれば裏の取得が自動で始まる）。
- **初レースを止めない**：任意のアセットは絶対に待たない。required も最大 `tutorialMaxWaitMs`（既定3秒、上限5秒）。06 §2 の「初レース開始まで5秒以内・aha① 30秒以内」を守るため、画面側で待ち時間を足さない（演出の待ちも入れない）。
- ダイアログは裏の取得にだけ関係する。ダイアログが出ていてもチュートリアルは始めてよい。

### 4.2 各画面での読み込み

```csharp
var loc = preload.Resolver.Resolve(AssetKeys.Coat(horse.Appearance.Coat));
switch (loc.Source)
{
    case AssetSource.Downloaded: /* AssetBundle.LoadFromFileAsync(loc.Path) → LoadAsset(loc.Key)（png/ogg ならそのファイルを読む） */ break;
    case AssetSource.Bundled:    /* Resources.Load("Muchi/Assets/" + loc.Key) */ break;
    case AssetSource.None:       /* 何も表示しない・鳴らさない */ break;
}
```

- `loc.Key` は要求したキーか `<kind>/default`。**キーが無くても例外にしない**。
- 先読みに無い（ondemand の）キー（馬名の音声・期間ごとのバナー）は `await downloader.EnsureAsync(preload.Catalog, key)` で取ってから `Resolve`。
- レース前（マッチング中）は `start.visuals` のキーを集めて `downloader.DownloadAsync(catalog, keys.Select(catalog.Find).Where(e => e != null))`。間に合わなければフォールバックで走らせる（待たない）。
- `GET /v1/config` の `assetCatalogVersion` が変わったら（`catalogs.IsStale(v)`）、次のホーム画面で `PrepareAsync()` をもう一度呼ぶ（古い版のファイルはここで消える）。
- AssetBundle の読み込み・解放は Codex 側。読み込み中のファイルは消さない（古い版の削除は起動時の `PrepareAsync` の中だけ）。

## 5. 作る順番（`docs/handoff-codex-round8.md` §4.3 の優先度のまま）

1. `<kind>/default` 28件（同梱。これで全キーが何かしら表示される）
2. `ui/gate/*`・`sfx/race/*`・`sfx/ui/*`（ftue。`sfx/race/whip`・`gate_open` は required）
3. `item/*`・`banner/gacha/*`（shop）
4. `silks/*`・`title/*`・`scene/*`（チュートリアルの `scene/venue/aoba`・`scene/surface/aoba_turf` を最初に）
5. `voice/ja/*`、`emblem/*`・`banner/event/*`・`stable/theme/*`

ファイルを置くたびに `npm run scan:assets -- --check` で「N/403」が増えることを確認する。

## 6. 依頼してよいこと（Claude 側で対応）

- マニフェストに無いが必要なキー（Round 8 §4.2 の `skill/icon` など）の追加 → kind・マスター・マニフェストを更新する。
- グループ・required の変更（`contracts/assets.groups.json`）、FTUE の予算（`policy`）の変更。
- CDN バケット・ドメインの用意とアップロードの自動化（運用）。

## 7. 確認の手順

1. `cd server && npm run scan:assets -- --check`：「files without a key」が0件、PROBLEM が無いこと。
2. `npm run scan:assets` でカタログを書き、`npm test`（カタログの検証を含む）が通ること。
3. `dotnet run --project "unity/Checks~/GameChecks"`（`== asset delivery` の項目）、`dotnet build "unity/Checks~/UnityAdapters"`（`UnityAssetHttp`）。
4. 実機：機内モードで初回起動 → すぐ初レース（仮の表示）。Wi-Fi で起動 → 3秒以内に初レース、ホームまでに裏の取得が進む。モバイル通信で 50MB 超 → 確認ダイアログ。
