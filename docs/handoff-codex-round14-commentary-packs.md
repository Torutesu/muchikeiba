# Codex への引き渡し — Round 14 実況パック（commentary packs）

仕様：`contracts/protocol.md` §36、`docs/spec/requirements.md` §36（REQ-CMT-001〜014）。サーバー・クライアント SDK・Unity のゲーム層・プロトタイプは Claude 側で実装済み。Codex にお願いしたいのは **Unity の画面（見た目）と、音（声の収録・書き出し）** です。

## 何ができたか（Claude 側）
- データ：`server/master/commentary-packs.json`（正本）→ `npm run gen:client-locale` で `engine/Muchi.Client/Resources/Muchi/commentary-packs.json`（Unity の Resources で読む、`MuchiServices.CommentaryPacksResource = "Muchi/commentary-packs"`）。パックは 標準（全員）・熱血（実績「出走の記録」1段目＝10戦で無料）・落ち着いた解説（300コイン）・古風な名調子（300コイン、英語は標準の英語）。
- `Muchi.Client`：`CommentaryPackCatalog`（読み込み・`Apply`＝標準の上に重ねる）、`CommentaryPackLint`（明示のフォールバック・プレースホルダー）、`CommentarySample.Build`（試聴）、`CommentaryVoice.ClipsOrNull`（声か字幕か）、`ApiClient.GetCommentaryPacksAsync`／`EquipCommentaryPackAsync`／`BuyCommentaryPackAsync`、`PlayerView.CommentaryPack`、`AnalyticsEvent.CommentaryPackSample`。
- `Muchi.Game.CommentaryPackModel`：カード（名前・説明・状態「装備中／持っている／300コイン／実績で入手（3/10）」）、`Sample(packId, standard)`、`EquipAsync`、`PurchaseConfirm`（落ち着いた確認シート）、`BuyAsync`（同じパックの再試行は同じ冪等キー、コイン不足は `Shortfall` → 既存の `CoinShortfallModel` のシート）、`TemplatesForRace`、オフライン。
- レース：`MuchiServices.RaceCommentary()` が装備中のパックを重ねたテンプレートを返し、`MuchiApp` の `CommentaryFeed` はそれを使う（観戦・リプレイも**見ている人の**パック）。チュートリアルは装備に関係なく標準。レースの結果・ハッシュ・リプレイは変わらない。

## Codex にお願いしたい画面（ムチ一閃のトーン：写真調の背景・半透明のネイビーのパネル・小さな字間の広いシアンのラベル・斜めのシアンの CTA »・余白多め）
プロトタイプ `tools/figma-prototype/site/app.js` の `CommentaryPacks` / `CommentaryPackBuy` が配置の見本（e2e のスクリーンショット `u-*-commentary-packs*.png`・`en-*-commentary-packs*.png`）。

1. **実況パックの一覧**（「その他」の行「実況パック」と、ショップの「見た目」タブの「実況パック」ボタンから）
   - 4枚のカード（左から 標準・熱血・落ち着いた解説・古風な名調子）。カードの上端に色の線（標準 淡い水色／熱血 オレンジ／解説 シアン／名調子 ゴールド）、英字の小ラベル（STANDARD / FIRED UP / ANALYST / CLASSIC）、名前（大）、説明（1〜2行）、状態（`CommentaryPackCard.Status`）、未入手の実績パックは入手条件の1行（`UnlockLabel`）、英語の時に英語が無いパックは注記（`EnglishNote`）。
   - ボタン：左「試聴する」（いつでも、持っていなくても）／右は状態で1つ：「装備する」（CTA）・「購入する」（CTA）・「装備中」（無効）・「実績で入手」（無効）。
   - 下の帯：試聴のティッカー（下記）と、注意の1行「実況の話し方だけが変わります。レースの結果・能力には影響しません。」
   - **アート（新規）**：パックごとの小さなアイコンまたはアナウンサー席のイラスト 4点（任意。無い間は色の線とラベルだけで成立する）。キー案 `ui/commentary_pack/<packId>`（manifest に足す時は Claude に依頼）。
2. **試聴のティッカー**：`CommentaryPackModel.Sample(packId, standard)` → `CommentarySampleResult`（`Lines`・`Offsets`・`TotalTicks`・`At(tick)`、20Hz）。行を `Offsets` の時刻から、1文字3tick の速さでタイプライターのように出す。進みのバー。声の断片が全部ダウンロード済みの行は声も流す（`CommentaryVoice.ClipsOrNull(line, …, isDownloaded)` が null なら字幕だけ）。TTS は使わない。試聴を始めた時に `AnalyticsEvent.CommentaryPackSample` を送る。
3. **購入の確認シート**（`CommentaryPackPurchaseSheet`）：タイトル「◯◯を購入しますか？」、本文「300コインを使います。有償コインから先に使われます。」（有償限定なら有償コインの文）、所持コイン（無償・有償を分けて）、注意。「購入する」と「やめる」は**同じ大きさ**。「倍」「お得」「今だけ」「残りわずか」・残り時間は出さない。コイン不足は既存の T6 シート（`CoinShortfallModel`、`ctx` はショップ）へ。
4. **レースの HUD**：字幕の上に小さく「実況　熱血」（標準の時・チュートリアルでは出さない）。字幕の見た目は今のまま。

## 音（声の収録）— Codex / サウンド担当
- 切り方は標準と同じ：テンプレートの `{name}` `{name2}` `{name3}` `{place}` `{skill}` の間の固定の文が1断片（`<variantId>#<n>`）。ファイルのアセットキーは `voice/ja/phrase/<variantId>_p<n>`（`contracts/assets.manifest.json` に全部載っている、`npm run gen:assets`）。
- 馬名・着順の数字・スキル名は**全パック共通**（既存の `voice/ja/name/*`・`voice/ja/num/*`）。パックの声の担当を標準と別の人にする場合、名前だけ標準の声になる点に注意（同じ担当者で「口調だけ変える」収録を推奨。別の声にするなら名前・数字もパックごとに録る必要があり、その時はキーの規則を Claude と決める）。
- 1行の断片が1つでも端末に無ければ、その行は字幕だけ（途中まで話して黙らない）。配信は既存のアセット配信（§16）の voice の束に入れる。
- 英語の実況は今までどおり文字だけ（声なし）。
- 口調の目安：熱血＝叫ぶ・語尾を伸ばす（「〜だー！」）、落ち着いた解説＝低めで淡々と・です／ます、古風な名調子＝昔のラジオ中継の節回し（「〜であります！」）。

## 収録リスト（パックごと）


### 熱血（`nekketsu`）— 59 断片

| 断片 id | アセットキー | 出来事 | 読む文（断片） | 1行全体（{ } は名前・数字・スキル名が入る） |
|---|---|---|---|---|
| `nekketsu_gate_open_1#0` | `voice/ja/phrase/nekketsu_gate_open_1_p0` | gate_open | ゲートオープン！熱い戦いの幕開けだー！ | ゲートオープン！熱い戦いの幕開けだー！ |
| `nekketsu_gate_open_2#0` | `voice/ja/phrase/nekketsu_gate_open_2_p0` | gate_open | 飛び出した！全馬いっせいに駆け出したー！ | 飛び出した！全馬いっせいに駆け出したー！ |
| `nekketsu_good_start_1#0` | `voice/ja/phrase/nekketsu_good_start_1_p0` | good_start | 、ロケットスタートだ！ | {name}、ロケットスタートだ！ |
| `nekketsu_good_start_2#0` | `voice/ja/phrase/nekketsu_good_start_2_p0` | good_start | うまい！ | うまい！{name}が抜群の飛び出し！ |
| `nekketsu_good_start_2#1` | `voice/ja/phrase/nekketsu_good_start_2_p1` | good_start | が抜群の飛び出し！ | うまい！{name}が抜群の飛び出し！ |
| `nekketsu_late_start_1#0` | `voice/ja/phrase/nekketsu_late_start_1_p0` | late_start | あーっと | あーっと{name}、出遅れたー！ |
| `nekketsu_late_start_1#1` | `voice/ja/phrase/nekketsu_late_start_1_p1` | late_start | 、出遅れたー！ | あーっと{name}、出遅れたー！ |
| `nekketsu_late_start_2#0` | `voice/ja/phrase/nekketsu_late_start_2_p0` | late_start | 、痛いスタート！まだ終わっちゃいないぞ！ | {name}、痛いスタート！まだ終わっちゃいないぞ！ |
| `nekketsu_leader_1#0` | `voice/ja/phrase/nekketsu_leader_1_p0` | leader | 先頭は | 先頭は{name}だー！ |
| `nekketsu_leader_1#1` | `voice/ja/phrase/nekketsu_leader_1_p1` | leader | だー！ | 先頭は{name}だー！ |
| `nekketsu_leader_2#0` | `voice/ja/phrase/nekketsu_leader_2_p0` | leader | がハナを奪ったー！ | {name}がハナを奪ったー！ |
| `nekketsu_position_call_1#0` | `voice/ja/phrase/nekketsu_position_call_1_p0` | position_call | 先頭 | 先頭{name}！続いて{name2}！その後ろに{name3}！ |
| `nekketsu_position_call_1#1` | `voice/ja/phrase/nekketsu_position_call_1_p1` | position_call | ！続いて | 先頭{name}！続いて{name2}！その後ろに{name3}！ |
| `nekketsu_position_call_1#2` | `voice/ja/phrase/nekketsu_position_call_1_p2` | position_call | ！その後ろに | 先頭{name}！続いて{name2}！その後ろに{name3}！ |
| `nekketsu_position_call_1#3` | `voice/ja/phrase/nekketsu_position_call_1_p3` | position_call | ！ | 先頭{name}！続いて{name2}！その後ろに{name3}！ |
| `nekketsu_position_call_2#0` | `voice/ja/phrase/nekketsu_position_call_2_p0` | position_call | が飛ばす！ | {name}が飛ばす！{name2}、{name3}が追いかける！ |
| `nekketsu_position_call_2#1` | `voice/ja/phrase/nekketsu_position_call_2_p1` | position_call | 、 | {name}が飛ばす！{name2}、{name3}が追いかける！ |
| `nekketsu_position_call_2#2` | `voice/ja/phrase/nekketsu_position_call_2_p2` | position_call | が追いかける！ | {name}が飛ばす！{name2}、{name3}が追いかける！ |
| `nekketsu_kakari_1#0` | `voice/ja/phrase/nekketsu_kakari_1_p0` | kakari | 、かかっている！抑えきれないぞ！ | {name}、かかっている！抑えきれないぞ！ |
| `nekketsu_kakari_2#0` | `voice/ja/phrase/nekketsu_kakari_2_p0` | kakari | 、行きたくて仕方がない！ | {name}、行きたくて仕方がない！ |
| `nekketsu_spurt_1#0` | `voice/ja/phrase/nekketsu_spurt_1_p0` | spurt | さあ来たぞ最後の直線！ここからが勝負だー！ | さあ来たぞ最後の直線！ここからが勝負だー！ |
| `nekketsu_spurt_2#0` | `voice/ja/phrase/nekketsu_spurt_2_p0` | spurt | 直線に向いた！全馬、力を振り絞れー！ | 直線に向いた！全馬、力を振り絞れー！ |
| `nekketsu_focus_whip_1#0` | `voice/ja/phrase/nekketsu_focus_whip_1_p0` | focus_whip | にムチが飛んだ！伸びろー！ | {name}にムチが飛んだ！伸びろー！ |
| `nekketsu_focus_whip_2#0` | `voice/ja/phrase/nekketsu_focus_whip_2_p0` | focus_whip | 、ムチに応えてぐんぐん来るぞ！ | {name}、ムチに応えてぐんぐん来るぞ！ |
| `nekketsu_cpu_takeover_1#0` | `voice/ja/phrase/nekketsu_cpu_takeover_1_p0` | cpu_takeover | は自動騎乗に切り替わった！まだまだ走るぞ！ | {name}は自動騎乗に切り替わった！まだまだ走るぞ！ |
| `nekketsu_finish_win_1#0` | `voice/ja/phrase/nekketsu_finish_win_1_p0` | finish_win | だー！一着でゴールイン！ | {name}だー！一着でゴールイン！ |
| `nekketsu_finish_win_2#0` | `voice/ja/phrase/nekketsu_finish_win_2_p0` | finish_win | やったぞ | やったぞ{name}！堂々の一着！ |
| `nekketsu_finish_win_2#1` | `voice/ja/phrase/nekketsu_finish_win_2_p1` | finish_win | ！堂々の一着！ | やったぞ{name}！堂々の一着！ |
| `nekketsu_bond_call_1#0` | `voice/ja/phrase/nekketsu_bond_call_1_p0` | bond_call | 絆の力だ！ | 絆の力だ！{name}が燃えている！ |
| `nekketsu_bond_call_1#1` | `voice/ja/phrase/nekketsu_bond_call_1_p1` | bond_call | が燃えている！ | 絆の力だ！{name}が燃えている！ |
| `nekketsu_bond_call_2#0` | `voice/ja/phrase/nekketsu_bond_call_2_p0` | bond_call | 人馬の心がひとつに！ | 人馬の心がひとつに！{name}が来たー！ |
| `nekketsu_bond_call_2#1` | `voice/ja/phrase/nekketsu_bond_call_2_p1` | bond_call | が来たー！ | 人馬の心がひとつに！{name}が来たー！ |
| `nekketsu_skill_1#0` | `voice/ja/phrase/nekketsu_skill_1_p0` | skill | 出たー！ | 出たー！{name}の{skill}！ |
| `nekketsu_skill_1#1` | `voice/ja/phrase/nekketsu_skill_1_p1` | skill | の | 出たー！{name}の{skill}！ |
| `nekketsu_skill_1#2` | `voice/ja/phrase/nekketsu_skill_1_p2` | skill | ！ | 出たー！{name}の{skill}！ |
| `nekketsu_skill_2#0` | `voice/ja/phrase/nekketsu_skill_2_p0` | skill | 炸裂！ | {skill}炸裂！{name}が加速する！ |
| `nekketsu_skill_2#1` | `voice/ja/phrase/nekketsu_skill_2_p1` | skill | が加速する！ | {skill}炸裂！{name}が加速する！ |
| `nekketsu_focus_finish_1#0` | `voice/ja/phrase/nekketsu_focus_finish_1_p0` | focus_finish | は | {name}は{place}着！よく走った！ |
| `nekketsu_focus_finish_1#1` | `voice/ja/phrase/nekketsu_focus_finish_1_p1` | focus_finish | 着！よく走った！ | {name}は{place}着！よく走った！ |
| `nekketsu_focus_finish_2#0` | `voice/ja/phrase/nekketsu_focus_finish_2_p0` | focus_finish | 、 | {name}、{place}着でゴール！次はもっと上だ！ |
| `nekketsu_focus_finish_2#1` | `voice/ja/phrase/nekketsu_focus_finish_2_p1` | focus_finish | 着でゴール！次はもっと上だ！ | {name}、{place}着でゴール！次はもっと上だ！ |
| `nekketsu_result_1#0` | `voice/ja/phrase/nekketsu_result_1_p0` | result | 一着 | 一着{name}！二着{name2}！三着{name3}！みんなよく走った！ |
| `nekketsu_result_1#1` | `voice/ja/phrase/nekketsu_result_1_p1` | result | ！二着 | 一着{name}！二着{name2}！三着{name3}！みんなよく走った！ |
| `nekketsu_result_1#2` | `voice/ja/phrase/nekketsu_result_1_p2` | result | ！三着 | 一着{name}！二着{name2}！三着{name3}！みんなよく走った！ |
| `nekketsu_result_1#3` | `voice/ja/phrase/nekketsu_result_1_p3` | result | ！みんなよく走った！ | 一着{name}！二着{name2}！三着{name3}！みんなよく走った！ |
| `nekketsu_duel_1#0` | `voice/ja/phrase/nekketsu_duel_1_p0` | duel | と | {name}と{name2}、火の出るような叩き合い！ |
| `nekketsu_duel_1#1` | `voice/ja/phrase/nekketsu_duel_1_p1` | duel | 、火の出るような叩き合い！ | {name}と{name2}、火の出るような叩き合い！ |
| `nekketsu_duel_2#0` | `voice/ja/phrase/nekketsu_duel_2_p0` | duel | が抜き返したー！ | {name}が抜き返したー！{name2}も譲らない！ |
| `nekketsu_duel_2#1` | `voice/ja/phrase/nekketsu_duel_2_p1` | duel | も譲らない！ | {name}が抜き返したー！{name2}も譲らない！ |
| `nekketsu_photo_finish_1#0` | `voice/ja/phrase/nekketsu_photo_finish_1_p0` | photo_finish | 並んだ並んだ！二着の | 並んだ並んだ！二着の{name}と大接戦！ |
| `nekketsu_photo_finish_1#1` | `voice/ja/phrase/nekketsu_photo_finish_1_p1` | photo_finish | と大接戦！ | 並んだ並んだ！二着の{name}と大接戦！ |
| `nekketsu_photo_finish_2#0` | `voice/ja/phrase/nekketsu_photo_finish_2_p0` | photo_finish | わからない！ほとんど同時のゴールだー！ | わからない！ほとんど同時のゴールだー！ |
| `nekketsu_comeback_win_1#0` | `voice/ja/phrase/nekketsu_comeback_win_1_p0` | comeback_win | 後方から一気だー！ | 後方から一気だー！{name}が全部まとめて差し切った！ |
| `nekketsu_comeback_win_1#1` | `voice/ja/phrase/nekketsu_comeback_win_1_p1` | comeback_win | が全部まとめて差し切った！ | 後方から一気だー！{name}が全部まとめて差し切った！ |
| `nekketsu_comeback_win_2#0` | `voice/ja/phrase/nekketsu_comeback_win_2_p0` | comeback_win | 大外一気！ | 大外一気！{name}、豪快にゴール！ |
| `nekketsu_comeback_win_2#1` | `voice/ja/phrase/nekketsu_comeback_win_2_p1` | comeback_win | 、豪快にゴール！ | 大外一気！{name}、豪快にゴール！ |
| `nekketsu_wire_win_1#0` | `voice/ja/phrase/nekketsu_wire_win_1_p0` | wire_win | 、逃げ切ったー！最後まで先頭を譲らない！ | {name}、逃げ切ったー！最後まで先頭を譲らない！ |
| `nekketsu_wire_win_2#0` | `voice/ja/phrase/nekketsu_wire_win_2_p0` | wire_win | 押し切った！ | 押し切った！{name}、見事な逃げ切り！ |
| `nekketsu_wire_win_2#1` | `voice/ja/phrase/nekketsu_wire_win_2_p1` | wire_win | 、見事な逃げ切り！ | 押し切った！{name}、見事な逃げ切り！ |

### 落ち着いた解説（`ochitsuki`）— 53 断片

| 断片 id | アセットキー | 出来事 | 読む文（断片） | 1行全体（{ } は名前・数字・スキル名が入る） |
|---|---|---|---|---|
| `ochitsuki_gate_open_1#0` | `voice/ja/phrase/ochitsuki_gate_open_1_p0` | gate_open | ゲートが開きました。各馬そろったスタートです。 | ゲートが開きました。各馬そろったスタートです。 |
| `ochitsuki_gate_open_2#0` | `voice/ja/phrase/ochitsuki_gate_open_2_p0` | gate_open | スタートしました。まずは位置取りに注目です。 | スタートしました。まずは位置取りに注目です。 |
| `ochitsuki_good_start_1#0` | `voice/ja/phrase/ochitsuki_good_start_1_p0` | good_start | 、スムーズに出ました。 | {name}、スムーズに出ました。 |
| `ochitsuki_good_start_2#0` | `voice/ja/phrase/ochitsuki_good_start_2_p0` | good_start | は好発を決めています。 | {name}は好発を決めています。 |
| `ochitsuki_late_start_1#0` | `voice/ja/phrase/ochitsuki_late_start_1_p0` | late_start | はややゲートの出が遅れました。 | {name}はややゲートの出が遅れました。 |
| `ochitsuki_late_start_2#0` | `voice/ja/phrase/ochitsuki_late_start_2_p0` | late_start | 、出負けしましたが、まだ焦る場面ではありません。 | {name}、出負けしましたが、まだ焦る場面ではありません。 |
| `ochitsuki_leader_1#0` | `voice/ja/phrase/ochitsuki_leader_1_p0` | leader | 先頭は | 先頭は{name}です。 |
| `ochitsuki_leader_1#1` | `voice/ja/phrase/ochitsuki_leader_1_p1` | leader | です。 | 先頭は{name}です。 |
| `ochitsuki_leader_2#0` | `voice/ja/phrase/ochitsuki_leader_2_p0` | leader | がハナに立ちました。落ち着いたペースです。 | {name}がハナに立ちました。落ち着いたペースです。 |
| `ochitsuki_position_call_1#0` | `voice/ja/phrase/ochitsuki_position_call_1_p0` | position_call | 先頭は | 先頭は{name}、二番手{name2}、三番手{name3}という隊列です。 |
| `ochitsuki_position_call_1#1` | `voice/ja/phrase/ochitsuki_position_call_1_p1` | position_call | 、二番手 | 先頭は{name}、二番手{name2}、三番手{name3}という隊列です。 |
| `ochitsuki_position_call_1#2` | `voice/ja/phrase/ochitsuki_position_call_1_p2` | position_call | 、三番手 | 先頭は{name}、二番手{name2}、三番手{name3}という隊列です。 |
| `ochitsuki_position_call_1#3` | `voice/ja/phrase/ochitsuki_position_call_1_p3` | position_call | という隊列です。 | 先頭は{name}、二番手{name2}、三番手{name3}という隊列です。 |
| `ochitsuki_position_call_2#0` | `voice/ja/phrase/ochitsuki_position_call_2_p0` | position_call | がペースを作り、 | {name}がペースを作り、{name2}、{name3}が続く形です。 |
| `ochitsuki_position_call_2#1` | `voice/ja/phrase/ochitsuki_position_call_2_p1` | position_call | 、 | {name}がペースを作り、{name2}、{name3}が続く形です。 |
| `ochitsuki_position_call_2#2` | `voice/ja/phrase/ochitsuki_position_call_2_p2` | position_call | が続く形です。 | {name}がペースを作り、{name2}、{name3}が続く形です。 |
| `ochitsuki_kakari_1#0` | `voice/ja/phrase/ochitsuki_kakari_1_p0` | kakari | は少し力んでいますね。 | {name}は少し力んでいますね。 |
| `ochitsuki_kakari_2#0` | `voice/ja/phrase/ochitsuki_kakari_2_p0` | kakari | 、折り合いに苦労しています。 | {name}、折り合いに苦労しています。 |
| `ochitsuki_spurt_1#0` | `voice/ja/phrase/ochitsuki_spurt_1_p0` | spurt | 最後の直線に入りました。 | 最後の直線に入りました。 |
| `ochitsuki_spurt_2#0` | `voice/ja/phrase/ochitsuki_spurt_2_p0` | spurt | 直線コースです。ここからの伸びが鍵になります。 | 直線コースです。ここからの伸びが鍵になります。 |
| `ochitsuki_focus_whip_1#0` | `voice/ja/phrase/ochitsuki_focus_whip_1_p0` | focus_whip | にムチが入りました。 | {name}にムチが入りました。 |
| `ochitsuki_focus_whip_2#0` | `voice/ja/phrase/ochitsuki_focus_whip_2_p0` | focus_whip | 、ムチに反応して伸びています。 | {name}、ムチに反応して伸びています。 |
| `ochitsuki_cpu_takeover_1#0` | `voice/ja/phrase/ochitsuki_cpu_takeover_1_p0` | cpu_takeover | は自動騎乗に切り替わりました。 | {name}は自動騎乗に切り替わりました。 |
| `ochitsuki_finish_win_1#0` | `voice/ja/phrase/ochitsuki_finish_win_1_p0` | finish_win | が一着でゴールしました。 | {name}が一着でゴールしました。 |
| `ochitsuki_finish_win_2#0` | `voice/ja/phrase/ochitsuki_finish_win_2_p0` | finish_win | 、着実に脚を伸ばして一着です。 | {name}、着実に脚を伸ばして一着です。 |
| `ochitsuki_bond_call_1#0` | `voice/ja/phrase/ochitsuki_bond_call_1_p0` | bond_call | 、人馬の呼吸がよく合っています。 | {name}、人馬の呼吸がよく合っています。 |
| `ochitsuki_bond_call_2#0` | `voice/ja/phrase/ochitsuki_bond_call_2_p0` | bond_call | 日々の積み重ねが見える走りですね、 | 日々の積み重ねが見える走りですね、{name}。 |
| `ochitsuki_bond_call_2#1` | `voice/ja/phrase/ochitsuki_bond_call_2_p1` | bond_call | 。 | 日々の積み重ねが見える走りですね、{name}。 |
| `ochitsuki_skill_1#0` | `voice/ja/phrase/ochitsuki_skill_1_p0` | skill | の | {name}の{skill}が発動しました。 |
| `ochitsuki_skill_1#1` | `voice/ja/phrase/ochitsuki_skill_1_p1` | skill | が発動しました。 | {name}の{skill}が発動しました。 |
| `ochitsuki_skill_2#0` | `voice/ja/phrase/ochitsuki_skill_2_p0` | skill | ここで | ここで{skill}。{name}の動きが変わりました。 |
| `ochitsuki_skill_2#1` | `voice/ja/phrase/ochitsuki_skill_2_p1` | skill | 。 | ここで{skill}。{name}の動きが変わりました。 |
| `ochitsuki_skill_2#2` | `voice/ja/phrase/ochitsuki_skill_2_p2` | skill | の動きが変わりました。 | ここで{skill}。{name}の動きが変わりました。 |
| `ochitsuki_focus_finish_1#0` | `voice/ja/phrase/ochitsuki_focus_finish_1_p0` | focus_finish | は | {name}は{place}着でした。 |
| `ochitsuki_focus_finish_1#1` | `voice/ja/phrase/ochitsuki_focus_finish_1_p1` | focus_finish | 着でした。 | {name}は{place}着でした。 |
| `ochitsuki_focus_finish_2#0` | `voice/ja/phrase/ochitsuki_focus_finish_2_p0` | focus_finish | 、 | {name}、{place}着でゴールです。 |
| `ochitsuki_focus_finish_2#1` | `voice/ja/phrase/ochitsuki_focus_finish_2_p1` | focus_finish | 着でゴールです。 | {name}、{place}着でゴールです。 |
| `ochitsuki_result_1#0` | `voice/ja/phrase/ochitsuki_result_1_p0` | result | 一着 | 一着{name}、二着{name2}、三着{name3}という結果です。 |
| `ochitsuki_result_1#1` | `voice/ja/phrase/ochitsuki_result_1_p1` | result | 、二着 | 一着{name}、二着{name2}、三着{name3}という結果です。 |
| `ochitsuki_result_1#2` | `voice/ja/phrase/ochitsuki_result_1_p2` | result | 、三着 | 一着{name}、二着{name2}、三着{name3}という結果です。 |
| `ochitsuki_result_1#3` | `voice/ja/phrase/ochitsuki_result_1_p3` | result | という結果です。 | 一着{name}、二着{name2}、三着{name3}という結果です。 |
| `ochitsuki_duel_1#0` | `voice/ja/phrase/ochitsuki_duel_1_p0` | duel | と | {name}と{name2}の競り合いが続いています。 |
| `ochitsuki_duel_1#1` | `voice/ja/phrase/ochitsuki_duel_1_p1` | duel | の競り合いが続いています。 | {name}と{name2}の競り合いが続いています。 |
| `ochitsuki_duel_2#0` | `voice/ja/phrase/ochitsuki_duel_2_p0` | duel | が盛り返しました。 | {name}が盛り返しました。{name2}との接戦です。 |
| `ochitsuki_duel_2#1` | `voice/ja/phrase/ochitsuki_duel_2_p1` | duel | との接戦です。 | {name}が盛り返しました。{name2}との接戦です。 |
| `ochitsuki_photo_finish_1#0` | `voice/ja/phrase/ochitsuki_photo_finish_1_p0` | photo_finish | 二着の | 二着の{name}とほぼ同時のゴールでした。 |
| `ochitsuki_photo_finish_1#1` | `voice/ja/phrase/ochitsuki_photo_finish_1_p1` | photo_finish | とほぼ同時のゴールでした。 | 二着の{name}とほぼ同時のゴールでした。 |
| `ochitsuki_photo_finish_2#0` | `voice/ja/phrase/ochitsuki_photo_finish_2_p0` | photo_finish | 非常に際どい決着です。 | 非常に際どい決着です。 |
| `ochitsuki_comeback_win_1#0` | `voice/ja/phrase/ochitsuki_comeback_win_1_p0` | comeback_win | 後方から | 後方から{name}、見事な末脚で差し切りました。 |
| `ochitsuki_comeback_win_1#1` | `voice/ja/phrase/ochitsuki_comeback_win_1_p1` | comeback_win | 、見事な末脚で差し切りました。 | 後方から{name}、見事な末脚で差し切りました。 |
| `ochitsuki_comeback_win_2#0` | `voice/ja/phrase/ochitsuki_comeback_win_2_p0` | comeback_win | 、外から脚を伸ばして一着です。 | {name}、外から脚を伸ばして一着です。 |
| `ochitsuki_wire_win_1#0` | `voice/ja/phrase/ochitsuki_wire_win_1_p0` | wire_win | 、最後まで先頭を守りました。 | {name}、最後まで先頭を守りました。 |
| `ochitsuki_wire_win_2#0` | `voice/ja/phrase/ochitsuki_wire_win_2_p0` | wire_win | の逃げ切りです。ペース配分が見事でした。 | {name}の逃げ切りです。ペース配分が見事でした。 |

### 古風な名調子（`kofuu`）— 62 断片

| 断片 id | アセットキー | 出来事 | 読む文（断片） | 1行全体（{ } は名前・数字・スキル名が入る） |
|---|---|---|---|---|
| `kofuu_gate_open_1#0` | `voice/ja/phrase/kofuu_gate_open_1_p0` | gate_open | いざ発走！各馬いっせいに飛び出しました！ | いざ発走！各馬いっせいに飛び出しました！ |
| `kofuu_gate_open_2#0` | `voice/ja/phrase/kofuu_gate_open_2_p0` | gate_open | ゲートは開かれた！さあ、勝負の始まりであります！ | ゲートは開かれた！さあ、勝負の始まりであります！ |
| `kofuu_good_start_1#0` | `voice/ja/phrase/kofuu_good_start_1_p0` | good_start | 、見事な出足であります！ | {name}、見事な出足であります！ |
| `kofuu_good_start_2#0` | `voice/ja/phrase/kofuu_good_start_2_p0` | good_start | 、まことに鮮やかなスタート！ | {name}、まことに鮮やかなスタート！ |
| `kofuu_late_start_1#0` | `voice/ja/phrase/kofuu_late_start_1_p0` | late_start | おおっと | おおっと{name}、出遅れであります！ |
| `kofuu_late_start_1#1` | `voice/ja/phrase/kofuu_late_start_1_p1` | late_start | 、出遅れであります！ | おおっと{name}、出遅れであります！ |
| `kofuu_late_start_2#0` | `voice/ja/phrase/kofuu_late_start_2_p0` | late_start | 、痛恨の出遅れ！されど勝負はこれからだ！ | {name}、痛恨の出遅れ！されど勝負はこれからだ！ |
| `kofuu_leader_1#0` | `voice/ja/phrase/kofuu_leader_1_p0` | leader | 先頭は | 先頭は{name}であります！ |
| `kofuu_leader_1#1` | `voice/ja/phrase/kofuu_leader_1_p1` | leader | であります！ | 先頭は{name}であります！ |
| `kofuu_leader_2#0` | `voice/ja/phrase/kofuu_leader_2_p0` | leader | ハナを奪うは | ハナを奪うは{name}！ |
| `kofuu_leader_2#1` | `voice/ja/phrase/kofuu_leader_2_p1` | leader | ！ | ハナを奪うは{name}！ |
| `kofuu_position_call_1#0` | `voice/ja/phrase/kofuu_position_call_1_p0` | position_call | 先頭は | 先頭は{name}、続くは{name2}、その後ろに{name3}であります。 |
| `kofuu_position_call_1#1` | `voice/ja/phrase/kofuu_position_call_1_p1` | position_call | 、続くは | 先頭は{name}、続くは{name2}、その後ろに{name3}であります。 |
| `kofuu_position_call_1#2` | `voice/ja/phrase/kofuu_position_call_1_p2` | position_call | 、その後ろに | 先頭は{name}、続くは{name2}、その後ろに{name3}であります。 |
| `kofuu_position_call_1#3` | `voice/ja/phrase/kofuu_position_call_1_p3` | position_call | であります。 | 先頭は{name}、続くは{name2}、その後ろに{name3}であります。 |
| `kofuu_position_call_2#0` | `voice/ja/phrase/kofuu_position_call_2_p0` | position_call | が先導し、 | {name}が先導し、{name2}、{name3}と連なってまいります。 |
| `kofuu_position_call_2#1` | `voice/ja/phrase/kofuu_position_call_2_p1` | position_call | 、 | {name}が先導し、{name2}、{name3}と連なってまいります。 |
| `kofuu_position_call_2#2` | `voice/ja/phrase/kofuu_position_call_2_p2` | position_call | と連なってまいります。 | {name}が先導し、{name2}、{name3}と連なってまいります。 |
| `kofuu_kakari_1#0` | `voice/ja/phrase/kofuu_kakari_1_p0` | kakari | 、はやる気持ちを抑えきれません！ | {name}、はやる気持ちを抑えきれません！ |
| `kofuu_kakari_2#0` | `voice/ja/phrase/kofuu_kakari_2_p0` | kakari | 、手綱を引っ張るほどの気合い！ | {name}、手綱を引っ張るほどの気合い！ |
| `kofuu_spurt_1#0` | `voice/ja/phrase/kofuu_spurt_1_p0` | spurt | さあ、いよいよ最後の直線であります！ | さあ、いよいよ最後の直線であります！ |
| `kofuu_spurt_2#0` | `voice/ja/phrase/kofuu_spurt_2_p0` | spurt | 直線に向きました！勝負どころはここだ！ | 直線に向きました！勝負どころはここだ！ |
| `kofuu_focus_whip_1#0` | `voice/ja/phrase/kofuu_focus_whip_1_p0` | focus_whip | に入魂の一鞭！ | {name}に入魂の一鞭！ |
| `kofuu_focus_whip_2#0` | `voice/ja/phrase/kofuu_focus_whip_2_p0` | focus_whip | 、鞭に応えてぐいぐいと伸びる！ | {name}、鞭に応えてぐいぐいと伸びる！ |
| `kofuu_cpu_takeover_1#0` | `voice/ja/phrase/kofuu_cpu_takeover_1_p0` | cpu_takeover | 、ここより自動騎乗に切り替わります。 | {name}、ここより自動騎乗に切り替わります。 |
| `kofuu_finish_win_1#0` | `voice/ja/phrase/kofuu_finish_win_1_p0` | finish_win | 、堂々の一着ゴールイン！ | {name}、堂々の一着ゴールイン！ |
| `kofuu_finish_win_2#0` | `voice/ja/phrase/kofuu_finish_win_2_p0` | finish_win | 勝ったのは | 勝ったのは{name}！見事、栄光をつかみました！ |
| `kofuu_finish_win_2#1` | `voice/ja/phrase/kofuu_finish_win_2_p1` | finish_win | ！見事、栄光をつかみました！ | 勝ったのは{name}！見事、栄光をつかみました！ |
| `kofuu_bond_call_1#0` | `voice/ja/phrase/kofuu_bond_call_1_p0` | bond_call | 人馬一体とはまさにこのこと、 | 人馬一体とはまさにこのこと、{name}！ |
| `kofuu_bond_call_1#1` | `voice/ja/phrase/kofuu_bond_call_1_p1` | bond_call | ！ | 人馬一体とはまさにこのこと、{name}！ |
| `kofuu_bond_call_2#0` | `voice/ja/phrase/kofuu_bond_call_2_p0` | bond_call | 厩舎で結んだ絆が | 厩舎で結んだ絆が{name}を押し上げる！ |
| `kofuu_bond_call_2#1` | `voice/ja/phrase/kofuu_bond_call_2_p1` | bond_call | を押し上げる！ | 厩舎で結んだ絆が{name}を押し上げる！ |
| `kofuu_skill_1#0` | `voice/ja/phrase/kofuu_skill_1_p0` | skill | 出ました、 | 出ました、{name}の{skill}！ |
| `kofuu_skill_1#1` | `voice/ja/phrase/kofuu_skill_1_p1` | skill | の | 出ました、{name}の{skill}！ |
| `kofuu_skill_1#2` | `voice/ja/phrase/kofuu_skill_1_p2` | skill | ！ | 出ました、{name}の{skill}！ |
| `kofuu_skill_2#0` | `voice/ja/phrase/kofuu_skill_2_p0` | skill | ここで | ここで{skill}！{name}の伝家の宝刀であります！ |
| `kofuu_skill_2#1` | `voice/ja/phrase/kofuu_skill_2_p1` | skill | ！ | ここで{skill}！{name}の伝家の宝刀であります！ |
| `kofuu_skill_2#2` | `voice/ja/phrase/kofuu_skill_2_p2` | skill | の伝家の宝刀であります！ | ここで{skill}！{name}の伝家の宝刀であります！ |
| `kofuu_focus_finish_1#0` | `voice/ja/phrase/kofuu_focus_finish_1_p0` | focus_finish | は | {name}は{place}着であります。 |
| `kofuu_focus_finish_1#1` | `voice/ja/phrase/kofuu_focus_finish_1_p1` | focus_finish | 着であります。 | {name}は{place}着であります。 |
| `kofuu_focus_finish_2#0` | `voice/ja/phrase/kofuu_focus_finish_2_p0` | focus_finish | 、 | {name}、{place}着にてゴール！ |
| `kofuu_focus_finish_2#1` | `voice/ja/phrase/kofuu_focus_finish_2_p1` | focus_finish | 着にてゴール！ | {name}、{place}着にてゴール！ |
| `kofuu_result_1#0` | `voice/ja/phrase/kofuu_result_1_p0` | result | 一着 | 一着{name}、二着{name2}、三着{name3}。以上の結果であります！ |
| `kofuu_result_1#1` | `voice/ja/phrase/kofuu_result_1_p1` | result | 、二着 | 一着{name}、二着{name2}、三着{name3}。以上の結果であります！ |
| `kofuu_result_1#2` | `voice/ja/phrase/kofuu_result_1_p2` | result | 、三着 | 一着{name}、二着{name2}、三着{name3}。以上の結果であります！ |
| `kofuu_result_1#3` | `voice/ja/phrase/kofuu_result_1_p3` | result | 。以上の結果であります！ | 一着{name}、二着{name2}、三着{name3}。以上の結果であります！ |
| `kofuu_result_two_1#0` | `voice/ja/phrase/kofuu_result_two_1_p0` | result_two | 一着 | 一着{name}、二着{name2}。以上の結果であります！ |
| `kofuu_result_two_1#1` | `voice/ja/phrase/kofuu_result_two_1_p1` | result_two | 、二着 | 一着{name}、二着{name2}。以上の結果であります！ |
| `kofuu_result_two_1#2` | `voice/ja/phrase/kofuu_result_two_1_p2` | result_two | 。以上の結果であります！ | 一着{name}、二着{name2}。以上の結果であります！ |
| `kofuu_duel_1#0` | `voice/ja/phrase/kofuu_duel_1_p0` | duel | と | {name}と{name2}、一歩も譲らぬ叩き合い！ |
| `kofuu_duel_1#1` | `voice/ja/phrase/kofuu_duel_1_p1` | duel | 、一歩も譲らぬ叩き合い！ | {name}と{name2}、一歩も譲らぬ叩き合い！ |
| `kofuu_duel_2#0` | `voice/ja/phrase/kofuu_duel_2_p0` | duel | が差し返す！ | {name}が差し返す！{name2}との一騎打ちであります！ |
| `kofuu_duel_2#1` | `voice/ja/phrase/kofuu_duel_2_p1` | duel | との一騎打ちであります！ | {name}が差し返す！{name2}との一騎打ちであります！ |
| `kofuu_photo_finish_1#0` | `voice/ja/phrase/kofuu_photo_finish_1_p0` | photo_finish | 二着 | 二着{name}とほとんど並んでのゴール！ |
| `kofuu_photo_finish_1#1` | `voice/ja/phrase/kofuu_photo_finish_1_p1` | photo_finish | とほとんど並んでのゴール！ | 二着{name}とほとんど並んでのゴール！ |
| `kofuu_photo_finish_2#0` | `voice/ja/phrase/kofuu_photo_finish_2_p0` | photo_finish | わずかの差！まさに紙一重の大接戦であります！ | わずかの差！まさに紙一重の大接戦であります！ |
| `kofuu_comeback_win_1#0` | `voice/ja/phrase/kofuu_comeback_win_1_p0` | comeback_win | 後方一気！ | 後方一気！{name}、鮮やかに差し切りました！ |
| `kofuu_comeback_win_1#1` | `voice/ja/phrase/kofuu_comeback_win_1_p1` | comeback_win | 、鮮やかに差し切りました！ | 後方一気！{name}、鮮やかに差し切りました！ |
| `kofuu_comeback_win_2#0` | `voice/ja/phrase/kofuu_comeback_win_2_p0` | comeback_win | 大外から | 大外から{name}、豪快に突き抜けたあっ！ |
| `kofuu_comeback_win_2#1` | `voice/ja/phrase/kofuu_comeback_win_2_p1` | comeback_win | 、豪快に突き抜けたあっ！ | 大外から{name}、豪快に突き抜けたあっ！ |
| `kofuu_wire_win_1#0` | `voice/ja/phrase/kofuu_wire_win_1_p0` | wire_win | 、逃げ切りであります！先頭を一度も譲りませんでした！ | {name}、逃げ切りであります！先頭を一度も譲りませんでした！ |
| `kofuu_wire_win_2#0` | `voice/ja/phrase/kofuu_wire_win_2_p0` | wire_win | 、そのまま押し切ってのゴール！ | {name}、そのまま押し切ってのゴール！ |

合計 174 断片（3パック）。標準の断片・馬名・数字・スキル名は既存の録音のまま（全パック共通）。
