# Round 11 Codex 向け引き継ぎ：英語（REQ-L10N-001〜013）

更新：2026-11-07　基準ブランチ：`feat/r11-english`（`claude/round10` ＋ `main`）
仕様：`contracts/protocol.md` §22、`docs/spec/requirements.md` §22

分担はこれまでと同じ：**Claude＝ロジック（サーバー・API・画面のモデル・文字列表）／Codex＝見た目（画面に出す・英語でも崩れないレイアウト・フォント）**。
文言の元は**日本語**。モデルもサーバーも日本語を作り、英語は「日本語の文 → 英語」の表で訳す。Codex は**文を自分で組み立てない**（今までどおりモデルの値をそのまま出す）。違いは1つだけ：**画面に出す直前に `Loc.T(...)` を通す**。

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| サーバー | ✅ `?lang=en` / `Accept-Language: en` で全ての文が英語（商品・注記・スキル・提供割合・ミッション・お知らせ・エラーの詳細…）。プッシュは端末の言語、トピックは `season_en`・`events_en` |
| C# クライアント | ✅ `ApiClient.Locale`（毎回 `Accept-Language`）、プッシュ登録に `locale`、`Loc`・`LocaleCatalog`・`Romaji`（`engine/Muchi.Client/Localization.cs`） |
| 表（Resources） | ✅ `engine/Muchi.Client/Resources/Muchi/ui-en.json`（ゲーム層の文）、`server-en.json`（サーバーの表の写し、生成物）、`commentary-en.json`（実況） |
| ゲーム層 | ✅ `UxText.For`・`UxText.Reward`・`ActionResult.Message` は言語どおり。ほかのモデルの文字列は日本語のまま → **画面で `Loc.T`**。GameChecks `L10nChecks.cs` |
| 起動 | ✅ `MuchiServices.Create` が表を読み、PlayerPrefs `muchi.language` の言語で実況とAPIを始める。切り替えは `MuchiServices.SetLanguage("en")` |
| 画面 | **Codex**：下の §2〜§4 |

## 2. 文字の出し方（Codex への依頼）

1. **モデルの文字列は全て `Loc.T(x)` を通して `Text` に入れる**（`ja` の時は何もしないので、日本語の見た目は変わらない）。例：`label.text = Loc.T(card.PeriodText);`、`toast(Loc.T(model.Message))`。
   - サーバーから来た文（`ProductCard.Name`・`Notices`・`SkillView.Condition` など）は既に英語。`Loc.T` を通しても英語のまま（害はない）。迷ったら全部通す。
   - `UxText.For(e)`・`UxText.Reward(r)`・`ActionResult.Message` は既に訳されている（もう一度通しても同じ）。
2. **Runtime の `LocaleService`（古い画面の英語キーの表 `Localization/ja.json`）はそのまま**。言語の切り替えボタン（`ToggleLanguage`）で `MuchiServices.SetLanguage(LocaleService.Language)` も呼ぶ（API の言語・実況・`Loc` が揃う）。`LocaleService.Text(source)` の後に `Loc.T` をかけると、日本語で書いた新しい画面の文字も英語になる。
3. **馬名**：`Loc.T(horse.Name)` で、テンプレート馬は英語名（`Shinsei Akatsuki`）、プレイヤーが付けたカタカナの名前は**ローマ字**（`Midorikawa`）になる。命名の入力欄・名前の保存はカタカナのまま（英語でも入力はカタカナ。補足文「Horse names are katakana and shown romanized in English.」はプロトタイプの命名画面を参照）。
4. **実況**：`MuchiServices.Commentary` が言語の実況（`commentary-en.json`）になる。字幕はそのまま `CommentaryFeed.Update` の文字を出す。**読み上げの音声（TTS の事前生成）は言語ごと**：クリップIDは各言語の JSON から（`CommentaryTemplates.AllFixedClips()`）。英語の音声が無い間は字幕だけで良い。
5. **数字・日付**：モデルは `11月5日`・`3着` を作り、`Loc.T` が `11/5`・`3rd` にする。画面で数字を足して文を作らないこと（`"#" + place + "位"` のような組み立ては訳せない）。

## 3. レイアウト（英語は長い）

- 英語は日本語の **1.6〜2.5 倍の幅**になる。ボタン・タブ・チップ・ヘッダーは**1行のまま縮める**（Unity の `Text` なら `resizeTextForBestFit`、最小は元の 66%）。本文は折り返し（`horizontalOverflow = Wrap`）、パネルの高さを超える時だけ縮める。見本はプロトタイプの `fitText`（`tools/figma-prototype/site/app.js`）。
- 英語では**字間を詰める**（日本語の見出しの字間 .12〜.2em は英語では .03〜.08em）。大文字だけの見出しは今のまま（`MUCHI ISSEN`）。
- 確認用のスクリーンショット：`node tools/figma-prototype/test/e2e.cjs`（または `E2E_ONLY=en`）の `en-*.png`。ホーム・ショップ（おすすめ・コイン・見た目）・法定表示・購入確認・パス・スカウト・提供割合・厩舎・設定・出走登録・レース・結果。どれも日本語の残り 0・はみ出し 0 で通っている。

## 4. 法定表示

特定商取引法に基づく表記・資金決済法に基づく表示は**日本語の本文のまま**出す（`Loc.T` を通さない）。英語の時だけ、本文の下に参考訳の注記（プロトタイプの `EN_LEGAL_NOTE`）と参考訳を小さく足す。リンク名はサーバーの英語（`… notice (Japanese)`）。日本国外での法的な効力をうたう文は入れない。

## 5. フォント

- `NotoSansCJKjp-Bold.ttf` は Latin の字形を持つので英語も同じ書体で出る。Unity の Dynamic Font なら追加の作業は無い。**TextMeshPro の SDF アトラスを使う場合**は、文字セットに ASCII（0x20〜0x7E）・Latin-1（0xA0〜0xFF）・`‘’“”–—…•·‹›«»` と、`ui-en.json`・`server-en.json`・`commentary-en.json` の全ての文字を入れる（プロトタイプは `prepare_assets.py` で同じ範囲を絞り込みに入れている）。
- 英語の数字は等幅（tabular）にすると残り時間・タイムが揺れない。

## 6. 確認の手順

```bash
cd server && npm test                                   # test/l10n.test.ts（網羅・リモート設定・プッシュ・表の写し）
cd server && npm run l10n:missing                       # 英語の無いマスターの文（空なら OK）
cd server && npm run gen:client-locale                  # サーバーの表を変えたら engine の server-en.json を作り直す
cd engine && dotnet test --filter LocalizationTests     # 実況の網羅・ローマ字・表・Accept-Language
dotnet run --project "unity/Checks~/GameChecks"         # round 11 の行（L10nChecks）が全て ok
bash tools/figma-prototype/build.sh && E2E_ONLY=en node tools/figma-prototype/test/e2e.cjs
```

新しい画面で日本語の文を足したら、`ui-en.json`（ゲーム層）か `server/master/locale-en.json`（マスター）に英語を足す。GameChecks の「every whole Japanese literal of the game layer has English」が足りない文を名指しする。
