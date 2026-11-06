# アセットの取り決め（ロジック ⇄ Unityのアセット）

ロジック側（サーバー・`engine/`）とUnity側（Codexが作る見た目・アセット）の間の**唯一の正**です。
サーバーは絵や音を持ちません。送るのは「どの見た目か」を表す小さな記述（毛色・模様・勝負服など）だけです。
Unity側はこの文書の規則でそれを**アセットキー**に変換し、Addressables のアドレスとして読み込みます。

- データの正：`server/master/visuals.json`（見た目のカタログ）と、各マスター（馬・アイテム・称号・ガチャ・イベント・コース）
- 一覧の正：`contracts/assets.manifest.json`（`cd server && npm run gen:assets` で生成。手で編集しない）
- 実装：サーバー `server/src/domain/visuals.ts`、Unity側 `engine/Muchi.Client/AssetKeys.cs`（同じ規則。両方のテストが一覧と突き合わせる）
- 要件ID：REQ-ASSET-001〜009（`docs/spec/requirements.md`）

---

## 1. キーの書き方（REQ-ASSET-001）

```
<kind>/<name>            例: horse/coat/bay
<kind>/<name>@v<N>       例: scene/venue/aoba@v2   （作り直した版。古い版と並べて配信できる）
```

- 使える文字は **小文字の英字・数字・`_`** だけ。区切りは `/`。最低2段。
- **kind** は最後の段を除いた部分（`horse/coat`、`scene/venue`、`voice/ja/phrase` など）。`@vN` は kind に含めない。
- Addressables のアドレスは**キーそのもの**にする（ラベルは自由）。
- 判定：`AssetKeys.IsValid(key)`（C#）／`ASSET_KEY_RE`（TS）。

## 2. 足りないときの扱い（フォールバック、REQ-ASSET-002）

**キーが見つからなくても絶対に落とさない。** 次の順で探す：

1. そのキー
2. 同じ kind の既定アセット `<kind>/default`（全 kind ぶん、最初のダウンロードに必ず同梱する）
3. それも無ければ何も表示しない（音なら鳴らさない）

C# では `AssetKeys.Resolve(key, exists)` が 1→2→null を返す。古いアプリが新しいキーを受け取ったときも、この順で必ず表示が続く。

## 3. キーの種類（kind）一覧

| kind | キーの例 | 元データ | 説明 |
|---|---|---|---|
| `horse/coat` | `horse/coat/chestnut` | visuals.json `horse.coats` | 毛色（体のテクスチャ・マテリアル） |
| `horse/face` | `horse/face/blaze` | `horse.faces` | 顔の白斑（`none` を含む） |
| `horse/leg` | `horse/leg/sock` | `horse.legs` | 脚の白斑。4本それぞれ（左前・右前・左後・右後） |
| `horse/mane` | `horse/mane/flaxen` | `horse.manes` | たてがみ・尾の色 |
| `horse/build` | `horse/build/rangy` | `horse.builds` | 体型（メッシュのバリエーション） |
| `silks/pattern` | `silks/pattern/hoops` | `silks.patterns` | 勝負服の模様。色はパレットで着色（下記） |
| `silks/cap` | `silks/cap/star` | `silks.caps` | 帽子の模様。色は勝負服の1色目・2色目 |
| `ui/gate` | `ui/gate/5` | `gateBrackets` | 枠番（1〜8）のゼッケン・UI |
| `tack` | `tack/bridle_classic` | items.json の馬具（`asset`） | 馬具（頭絡・ゼッケン布）。馬のモデルに重ねる（REQ-ITEM-006） |
| `decor` | `decor/stable_plaque` | items.json の厩舎の飾り（`asset`） | 厩舎の飾り（REQ-ITEM-006）。マイ厩舎の飾り枠にも同じキー（REQ-STABLE-001） |
| `stable/theme` | `stable/theme/cedar` | `server/master/stable.json themes[].id` | マイ厩舎の部屋のテーマ（壁・床）。飾り枠の数はテーマごと（REQ-STABLE-001）。リモート設定で増えたテーマはフォールバック `stable/theme/default` |
| `item` | `item/ticket_sr_plus` | 商品・報酬・イベント参加費・勝負服の解放アイテム | アイテムのアイコン |
| `banner/gacha` | `banner/gacha/pickup_akatsuki` | gacha.json | ガチャのバナー |
| `banner/event` | `banner/event/sprint_cup_2026_11` | events.json | イベントのバナー |
| `title` | `title/first_win` | titles.json | 称号のアイコン |
| `emblem/shape` | `emblem/shape/shield` | `emblem.shapes` | 支部エンブレムの形 |
| `emblem/symbol` | `emblem/symbol/crown` | `emblem.symbols` | 支部エンブレムの図柄 |
| `scene/venue` | `scene/venue/minato` | `venues` / `tracks` | 競馬場のシーン（地形・スタンド・カメラ） |
| `scene/surface` | `scene/surface/minato_dirt` | コースの馬場 | 競馬場ごとの馬場面（芝・ダート） |
| `scene/night` | `scene/night/minato` | ナイター開催できる競馬場 | ナイター照明 |
| `fx/going` | `fx/going/sloppy` | 馬場状態（good 以外） | 濡れた馬場・水しぶき・土煙 |
| `scene/look` | `scene/look/autumn_gold` | `visuals.json courseLooks` | コースの見た目テーマ（自分の画面だけ、REQ-ROOM-001） |
| `fx/weather` | `fx/weather/rain` | `visuals.json weather` | フレンドルームの天気演出（REQ-ROOM-004） |
| `sfx/race` | `sfx/race/whip` | `sfx.race` | レース中の効果音 |
| `sfx/ui` | `sfx/ui/gacha_ssr` | `sfx.ui` | UIの効果音 |
| `voice/ja/phrase` | `voice/ja/phrase/gate_open_1_p0` | `engine/Muchi.Client/Resources/Muchi/commentary-ja.json` | 実況の定型フレーズの断片 |
| `voice/ja/num` | `voice/ja/num/3` | 1〜12 | 実況の数字（着順） |
| `voice/ja/name` | `voice/ja/name/n4f2c…` | 馬名 | 実況の馬名（**動的**。下記） |

### 3.1 馬の見た目
- サーバーは馬ごとに `appearance = { coat, face, legs[4], mane, build }` を返す（所持馬一覧・ガチャ結果・レースの `start`）。
- キーは `AssetKeys.HorseKeys(appearance)` で8個（毛色・顔・脚4本・たてがみ・体型）。
- **テンプレート馬**（ガチャ・CPU）は `visuals.json horse.templates` の固定の見た目。
- **配合で生まれた馬**は、両親から形質ごとに受け継ぐ（少しだけ突然変異あり。芦毛は親が芦毛なら約半分で芦毛）。結果はサーバーが保存する。
- 古いセーブの馬は、読み込み時に決まった規則で見た目が付く（一度付いたら変わらない）。

### 3.2 勝負服（REQ-ASSET-005）
- `silks = { pattern, colors[2〜3], cap }`。`colors` は**パレットの色ID**（`visuals.json palette`、`#RRGGBB` 付き）。
  - 1色目＝胴、2色目＝袖と模様、3色目（3色の模様だけ）＝差し色。帽子は1色目・2色目を使う。
- 模様ごとに色の数が決まっている（`patterns[].colors`）。同じ色だけの組み合わせは不可。
- 一部の模様はコスチュームのアイテムで解放（`unlockItem`）。
- **実在の馬主の登録服色を再現しない**：`silks.banned` に「模様＋色（＋帽子）」を入れると、その組み合わせは選べない（サーバーで拒否）。
  リリース前に、公開されている登録服色と照合して追記すること（現在は空）。模様・色・帽子の名前もすべて一般名・架空。
- 選んでいないプレイヤーとCPUの騎手は、決まった規則の既定の勝負服（無料の模様のみ・禁止リストに当たらない）。
- 変更：`PUT /v1/player/silks`（C# `SetSilksAsync`）。

### 3.3 枠番の色（ゼッケン）
- 枠番は **8枠**。出走が8頭以下なら馬番＝枠番。9頭以上は前の枠から1頭ずつ、残りを後ろの枠に2頭ずつ入れる。
  - 12頭なら：馬番1〜4 → 1〜4枠、5・6 → 5枠、7・8 → 6枠、9・10 → 7枠、11・12 → 8枠
  - `AssetKeys.BracketOf(gate, runners)`。`start.visuals.entrants[].bracket` にも入っている。
- 色（パレットID）：

| 枠 | ゼッケン | 数字 |
|---|---|---|
| 1 | white | black |
| 2 | black | white |
| 3 | red | white |
| 4 | blue | white |
| 5 | yellow | black |
| 6 | green | white |
| 7 | orange | white |
| 8 | pink | white |

### 3.4 支部エンブレム
- `emblem = { shape, symbol, colors[2] }`（形＋図柄＋パレット2色）。決まったパーツの組み合わせだけ（自由な画像のアップロードはしない＝不適切な画像を防ぐ）。
- 未設定の支部は支部IDから決まった既定のエンブレム。変更は支部長・副長が `PUT /v1/teams/me` の `emblem`。

### 3.5 コースのシーン
- `trackVisual = { venue, direction, surface, going, night, keys{ venue, surface, night, going } }`
- 競馬場（venue）とコースの対応、回り（左回り `left`／右回り `right`）は `visuals.json venues / tracks`。
- 読み込み：`scene/venue/<venue>` をベースに、`scene/surface/<venue>_<surface>` を重ね、夜なら `scene/night/<venue>`、
  馬場が良でなければ `fx/going/<going>` を重ねる。
- フレンドルームでホストが条件を決めていれば `visuals.scene = { weather, temperatureC, windKmh, keys{ weather } }` が付き、
  `fx/weather/<weather>` を重ねる（演出のみ）。自分のコースの見た目は `GET /v1/presets` の `courseLookKey`（`scene/look/<id>`）。
- `entrants[].bondLevel`（任意）は騎手とその馬の絆レベル。`RaceVisuals.BondCalloutSlots(5)` を `Commentator.SetBondCallouts` に渡すと実況が一度だけ触れる。

#### 競馬場の一覧（Round 7 で海外風の3場を追加、REQ-TRACK-004）

すべて架空。シーンは競馬場ごとに1つ（`scene/venue/<venue>`）、馬場面はその競馬場にあるコースの面だけ、ナイターは照明のある競馬場だけ。

| venue | 名前 | 回り | コース | `scene/surface/…` | `scene/night/…` | 雰囲気の目安（制作メモ） |
|---|---|---|---|---|---|---|
| `aoba` | 青葉競馬場 | 左 | 芝1600・ダート1400 | `aoba_turf`・`aoba_dirt` | なし | 地方の緑の多い競馬場 |
| `kirameki` | きらめき競馬場 | 右 | 芝2000 | `kirameki_turf` | なし | 都市近郊の大きなスタンド |
| `minato` | みなと競馬場 | 左 | 芝2400・ダート1800 | `minato_turf`・`minato_dirt` | `minato` | 港町、海風 |
| `nordhaven` | ノルトハーフェン競馬場 | 左 | 芝2400（大きなコーナー、直線700m） | `nordhaven_turf` | なし | 北の港町。低い空・石造りのスタンド・重くなりやすい芝（`weather.byTrack`） |
| `santalucera` | サンタルチェラ競馬場 | 右 | ダート1700（小回り） | `santalucera_dirt` | `santalucera` | 乾いた南の町。白い壁・ヤシ・夜の照明。軽い馬場が多い |
| `bellmoor` | ベルムーア競馬場 | 右 | 芝1200（コーナーのない直線コース） | `bellmoor_turf` | なし | 丘陵のヒース。直線だけなのでカメラは横からの並走が基本 |

- 回り `direction` はコーナーの向き。直線だけのベルムーアでも値は持つ（スタンドの位置＝コースの右側）。
- 馬場状態の重ね（`fx/going/<going>`）は全競馬場で共通。

### 3.6 実況の音声（REQ-ASSET-009）
- `Commentary` が出す `ClipKeys` を `AssetKeys.VoiceClip(clipKey, horseNameById)` で変換する。
  - 定型の断片 `gate_open_1#0` → `voice/ja/phrase/gate_open_1_p0`（全部 `AllFixedClips()` で列挙でき、マニフェストにも載る）
  - 数字 `num:3` → `voice/ja/num/3`
  - 馬名 `name:<horseId>` → `voice/ja/name/n<馬名のFNV-1a 64bit>`（**馬IDではなく名前**で決まる。同じ名前は同じ音声）
  - 固有スキル名 `skill:<skillId>` → `voice/ja/name/n<スキル名のFNV-1a 64bit>`（馬名と同じ規則。`VoiceClip(clipKey, horseNameById, skillNameById)` にスキル名を渡す。スキル名は `server/master/skills.json` から全てマニフェストに載る。REQ-UXS-050）
- 馬名の音声は**命名時に生成してCDNに置く**ため、マニフェストにはテンプレート馬の名前だけが載る（kind が `dynamic: true`）。
  見つからなければ `voice/ja/name/default`（例：「この馬」）を使う。
- Round 7 の実況の多様化（REQ-COMM-002〜004）で増えた定型フレーズも同じ規則でマニフェストに載る（`npm run gen:assets`）。
  競馬場ごとの直線の一言 `spurt_<venue>_<n>`、口調 `gate_open_tutorial_<n>` など、流れの実況 `duel_<n>`・`photo_finish_<n>`・
  `comeback_win_<n>`・`wire_win_<n>`、馬場の一言 `going_call_<surface>_<going>_<n>`。収録の口調は、`*_tutorial_*` は
  やさしく教える調子、`*_ranked_*` は少し緊張感のある調子で。

---

## 4. レースの `start` に付く見た目（REQ-ASSET-006）

`start` メッセージに **`visuals`** が付く（`contracts/protocol.md` §4）。レース設定（`config`）とは別物で、
**結果ハッシュにもリプレイログにも入らない**（見た目を変えても検証結果は変わらない）。

```json
{
  "v": 1,
  "track": { "trackId": "minato_turf_2400", "venue": "minato", "direction": "left", "surface": "turf", "going": "soft", "night": true,
             "keys": { "venue": "scene/venue/minato", "surface": "scene/surface/minato_turf", "night": "scene/night/minato", "going": "fx/going/soft" } },
  "entrants": [
    { "slot": 0, "gate": 1, "bracket": 1, "voiceName": "voice/ja/name/n…",
      "appearance": { "coat": "gray", "face": "blaze", "legs": ["sock","none","none","stocking"], "mane": "flaxen", "build": "rangy" },
      "silks": { "pattern": "hoops", "colors": ["red","white"], "cap": "star" },
      "displayName": "アリス", "titleId": "first_win" }
  ]
}
```

- CPU の馬はテンプレートの見た目、CPU の騎手はレースIDから決まった既定の勝負服。`displayName` は CPU なら null。
- 古いサーバーは `visuals` を送らない。C# の `RaceSession.Visuals` は自動で `RaceVisuals.Fallback(config)` を返す。
- オフライン（チュートリアル・タイムアタック）は `RaceVisuals.Fallback(config)` と `GET /v1/visuals` のカタログを使う。

## 5. コースの形（3D座標への変換、REQ-ASSET-007）

`engine/Muchi.Client/TrackGeometry.cs`（**表示専用**。浮動小数点を使うのでシミュレーションには戻さない）。

- 座標系：Unity と同じ（Y が上、スタート地点が原点、スタート時の進行方向が +Z、ヨーは上から見て時計回り）。
- エンジンの「距離」は**内ラチ（レーン0）に沿った距離**。レーンは内ラチから外向きに垂直な横ずれ（`lane × laneWidthMm`）。
- 直線：進行方向にそのまま進む。
- コーナー：長さ L・半径 R のコーナーは **L/R ラジアン**曲がる。中心は内ラチから R だけ内側。
  横ずれ o の馬は**半径 R+o の円**を同じ角度で走る（外を回るほど実際に走る距離が長い＝エンジンのロスと同じ）。
- 左回り（`left`）は左に曲がり、外側（レーンが増える向き）は右。右回りはその鏡写し。
- バンク（傾き）は無し（Y=0）。最後の区間の先はまっすぐ伸ばす（ゴール後の流し）。
- API：`PoseAt(distanceM, lateralM)` → `TrackPose{X,Y,Z,YawDegrees}`、`PoseOf(horse, laneWidthMm)`、
  `Interpolated(prev, cur, alphaPermille, laneWidthMm)`（tick 間の補間）、`Polyline(stepM, lateralM)`（ラチ・レーン線・カメラレール用）、
  `StartPose()` / `FinishPose()`。`TrackGeometry.For(config, visuals.Track)` で回りの向きも反映される。
- シーン側の作り方：コースのメッシュは `Polyline` に沿って作るか、シーンの基準点（スタート地点・向き）を
  `TrackGeometry` の原点・+Z に合わせて置く。ゴール板は `FinishPose()`。

## 6. 配信とパッケージ（REQ-ASSET-008）

- **最初のダウンロードは小さく**：アプリ本体には、全 kind の `<kind>/default`、UI、チュートリアル用のコース1つ（青葉 芝1600）、
  よく使う効果音、実況の定型フレーズだけを入れる。
- **それ以外は Addressables のリモートグループ**（Cloudflare R2＋CDN、転送料無料）から、必要になった時に取得する。
  - グループの目安：競馬場ごと（`scene/*/<venue>*`）、馬の部品（`horse/*`）、勝負服（`silks/*`）、バナー（`banner/*`、期間ごとに差し替え）、実況の馬名（`voice/ja/name/*`、命名時に追加）。
  - レースに入る前（マッチング中）に、`start.visuals` と `GET /v1/visuals` から必要なキーを集めて先読みする。間に合わなければフォールバックで走らせる。
- キーを作り直したら `@vN` を付けた新しいキーで配信し、古いキーはしばらく残す（古いアプリが参照するため）。
- `contracts/assets.manifest.json` を Unity のエディタ拡張で読み、**全キーにアセットがあるか**をビルド前にチェックする
  （`AssetKeys.ParseManifestKeys`）。足りないキーはフォールバックで動くが、リリース前にゼロにする。

## 7. 変更するとき

- 見た目の種類を増やす：`server/master/visuals.json` を編集 → `cd server && npm run gen:assets` → マニフェストの差分をコミット。
  テスト（サーバー `test/visuals.test.ts`、C# `AssetContractTests`）が、マスターとマニフェストのずれ・形式の誤りを検出する。
- kind を増やす：`visuals.ts` の `ASSET_KINDS` と `assetKeys`、C# の `AssetKeys` に同じ規則を足し、この文書の §3 を更新する。
