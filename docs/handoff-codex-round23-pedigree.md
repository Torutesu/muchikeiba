# Round 23 Codex 向け引き継ぎ：血統図と系統（REQ-PED-001〜020）

更新：2026-11-12　基準ブランチ：`feat/r23-pedigree`（`origin/main` から）
仕様：`contracts/protocol.md` §71、`docs/spec/requirements.md` 71章。経済の目標（E）は無し（**読むだけ。何も配らない・何も売らない。系統を集めても報酬は無い**）。

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API クライアント・画面のビューモデル）／Codex＝見た目（画面・入力・音・絵）**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `GET /v1/horses/:horseId/pedigree[?playerId]`（既存の口に欄を足した v2。ETag／304）・`GET /v1/breeding/pedigree?sireId&damId`・`GET /v1/bloodlines`。配合で生まれる仔に生まれた時の父母の写し `lineage`。系統の名前は `server/master/bloodlines.json`。ヘルプ記事 `pedigree`（画面リンク `bloodlines`、「？」の文脈 `pedigree`）、ヒントのカード `pedigree_tip` |
| C# | ✅ `engine/Muchi.Client/Pedigree.cs`：`ApiClient.GetPedigreeViewAsync(horseId, playerId, knownRev)`（304 → null）/ `GetBreedingPedigreeAsync` / `GetBloodlinesAsync`、`PedigreeView`・`PedigreeNode`（足した欄：`Gen`・`Rec`・`RecordText`・`Shared`・`Founder`・`IsLent`・`LentOwnerName`・`LentLabel`・`NameHidden`）・`PedigreeRecord`・`PedigreeTree`（15 の枠・`Label`・`FlowFor`）・`BreedingPedigree`・`BloodlineList`、`AnalyticsEvent.PedigreeView` / `BloodlineView` |
| ゲーム層 | ✅ `Muchi.Game.PedigreeModel`（`unity/Assets/Muchi/Game/PedigreeModel.cs`）。チェックは `unity/Checks~/GameChecks/PedigreeChecks.cs`。`new PedigreeModel(new ApiPedigree(backend.Api), analytics.Track)`。`AccountChangeReset.Pedigree` に渡すとアカウントが変わった時にキャッシュを捨てる |
| 見本 | ✅ `tools/figma-prototype/site/index.html`：厩舎の上の「血統」→ 血統図、そこから「系統 ›」「配合の血統を見る」。配合の画面が無いので見本では「配合の血統を見る」が組み合わせの画面（「デモ：家系を用意する」で兄妹の家系と他のトレーナーの種牡馬の仔を作る） |
| **Codex** | 入口（§2）、血統図（§3）、組み合わせ（§4）、系統の一覧（§5）、状態・英語・文字の大きさ（§6）、絵（§7） |

## 2. 入口
- 馬の詳細（厩舎の馬・所属馬の一覧の詳細）に「血統」。**その他には行を置かない**（2ページとも8行）。
- 配合の画面（`frontend/design/screens/14-breeding.svg` の ②「血統と相性を確認する」）：父馬・母馬を選んだら「血統を見る」→ `PedigreeModel.OpenPairAsync(sireId, damId)`。同じ段の相性の行（`BreedingModel.CompatibilityLabel`）の下に `PairSharedLine`（共通の祖先の名前と罰）。
- 系統の一覧：血統図・配合の画面の「系統 ›」→ `OpenBloodlinesAsync(source)`。ヘルプ記事の画面リンク `bloodlines` も同じ。
- 他のプレイヤーの馬：マイ厩舎の訪問の馬房・トレーナーカードの愛馬から `OpenAsync(horseId, PedigreeSources.Stable|Showcase, playerId)`。見られない時は `HiddenText` の1行だけ（理由は出さない）。
- 右上の「？」は `HelpCenterModel.OpenContext("pedigree")`（記事 `pedigree`）。

## 3. 血統図（「ムチ一閃」のトーン）
1600×900。**背景はパドックの写真（見本は `Art/home-paddock`）、左を暗くする影、紺の半透明パネル1枚、字間の広い小さなシアンのキッカー**。主ボタンは置かない。
- 上の帯：題「血統　/　PEDIGREE」、説明「〈系統名〉　·　3代の血統　·　共通の祖先はシアンの枠」。
- 木（パネル 1528×664）：`PedigreeModel.Boxes`（15 枠、`PedigreeTree.Slots` の順：0 本人、1–2 父母、3–6 祖父母、7–14 曾祖父母）。
  - 横長（`PedigreeTree.FlowFor(幅, 文字の倍率) == Columns`）：世代ごとに左→右の4列。枠の高さは世代ごとに半分（見本 190／160／128／66）。親の右端→中点→子の左端を **細いシアンの線（2px、不透明度 .45）** の肘で結ぶ。共通の祖先へ向かう線だけ不透明のシアン。
  - 縦長・文字「特大」（`Rows`）：世代の見出し（「本人」「父母」「祖父母」「曾祖父母」、字間の広いシアン）ごとに、枠を折り返す行で並べ、パネルの中でスクロール。**文字は縮めない**。
- 枠（紺の半透明、薄い枠線）：
  - 左に**写真の馬の小さな絵**（世代0〜2、66×66）：`Box.ThumbKey`（テンプレートの馬は既存の `collection/portrait/<templateId>`）、無ければ `Rec.Appearance` から合成した毛色の写真（見本は 3D プレビューの毛色の写真で代用）。記録の無い祖先は灰色の空き枠。
  - 小さなシアンの続柄（`Box.Relation`：父／母の父…）、名前（太字。プレイヤーが付けた名前はそのまま）、`TraitLine`（脚質・馬場の得意・固有スキル）、その下に金で一番の成績（`Rec.BestText`）か、借りた種牡馬なら `OwnerLine`（持ち主の名前＝プレイヤーの文字、または「他のトレーナーの馬」）、系統の祖なら「系統の祖」。
  - **共通の祖先**（`Box.Shared`）：2px のシアンの枠と淡い光、右上に小さく「共通」。点滅させない。
  - 記録の無い祖先（`NoRecord`）：薄い枠に名前と「記録なし」。
  - 自分の馬の祖先（`CanOpenAncestor`）は押すとその馬の血統図へ（他のプレイヤーの図では押せない）。
- 下の行：`InbreedingLine`（金。共通の祖先がいる時だけ「近親：共通の祖先N頭（能力の基準 −M）」。数はサーバーの値）、「系統 ›」、戻る。
- **やってはいけないこと**：確率・罰・ボーナスを画面で計算すること（サーバーの値だけ）、「近親で弱くなる！」のような煽り・赤い警告、系統の「コンプリート」「あと◯系統」の表示、持ち主のプレイヤー ID の表示。

## 4. 組み合わせ（配合の「血統を見る」）
- 左パネル：父・母の名前（変えるボタン）、`PairSharedLine`、キッカー `HintsTitle`（「この組み合わせで受け継ぎやすい能力」）とサーバーのヒントの行（`Pair.Hints[].Text`。種類 `line`・`nick`・`stat`・`style`・`going`・`skill`・`atavism`・`inbreeding`。`inbreeding` だけ金）、注記 `Pair.Notice`。
- 右パネル：父と母の木を上下に（それぞれ本人・父母・祖父母＝仔から見て曾祖父母まで）。共通の祖先は両方の木で同じシアンの枠。
- 借りた種牡馬との組み合わせは、既存の種付けの確認（`StudPreviewAsync` の `InbreedingCount`）を出す（この画面は自分の馬どうし）。

## 5. 系統の一覧
- 左パネル：「受け継ぎ方」（仔の系統は父の系統・ニックスの加算 `NickBonus`・近親の罰 `InbreedingPenalty`・`Notice`「系統の数で報酬はありません。」）と「血統のヘルプ ›」。
- 右パネル：マスターの順で全系統（**0頭の系統も同じ見た目で、少し薄く**。「未発見」「あと◯」は出さない）。行：系統名（20px 太字）・`CountText`（金）・創始の馬と説明・`NickLines`（シアン）・厩舎の馬の名前（最大6頭）。

## 6. 状態・英語・文字の大きさ
- 読み込み中：パネルの場所に細いシアンのバー。オフライン：`OfflineText`（前に開いた木はそのまま出る）。見られない馬：`HiddenText`。
- 英語：画面の文字は `Loc.T`（ui-en.json）。系統名・創始の馬・説明・ヒントはサーバーが英語で返す。馬の名前・持ち主の名前は訳さない。
- 文字「特大」：木は `Rows` に流し直す（見本は日英とも特大ではみ出さない：e2e の a11y-flow で確認）。
- 動きを減らす：線を描くアニメーションは無しで一度に出す。

## 7. 絵（新しく描くもの）
- **木の部品**：枠の9スライス（通常・記録なし・共通＝シアンの枠と淡い光）、肘の線（2px、端の小さな丸）、「共通」「系統の祖」の小さな札。
- **馬の小さな絵**：毛色・顔の白斑ごとの写真調の顔のアップ（`horse/coat/*`・`horse/face/*` から合成でよい）。テンプレートの馬は既存の `collection/portrait/<templateId>`。
- **系統の紋**（任意）：系統ごとの小さな線画の紋（シアン1色、`bloodline/<lineId>` の新しいキーにするなら contracts/assets.md に足す）。集める見た目にしない（枠・光・数の強調なし）。

## 8. KPI
- `pedigree_view`（入口・関係・共通の祖先の数）は `OpenAsync`／`OpenPairAsync` が1回ずつ送る。`bloodline_view`（入口・系統の数）は `OpenBloodlinesAsync`。どちらも ID を持たない（§58 では任意）。
