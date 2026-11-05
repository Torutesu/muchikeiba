# ムチ一閃（仮）— 3D競馬ジョッキー オンライン対戦

騎手として馬に乗り、最大12頭のリアルタイム対戦で「最後の直線、ムチ一発で差し切る」スマホゲーム。

- 見た目（UI・3D演出）は Codex で実装する
- 本リポジトリはロジック（レースエンジン・対戦の同期・サーバー）と設計ドキュメントを持つ

## 構成

| フォルダ | 内容 |
|---|---|
| [engine/](engine/README.md) | C#：レースエンジン（Unityにそのまま入れる）、ロックステップのクライアント、検証サーバー、結合テスト用ボット |
| [server/](server/README.md) | TypeScript：Cloudflare Workers + Durable Objects（レース部屋・マッチング・財布・ガチャ・配合・購入・認証） |
| [contracts/](contracts/protocol.md) | C#とTSの共有仕様、レース調整値、言語をまたぐゴールデンファイル |
| [scripts/integration.sh](scripts/integration.sh) | 結合テスト（C#ボット ⇄ TSサーバー ⇄ C#検証サーバー） |

## テストの実行

```bash
cd engine && dotnet test
```

```bash
cd server && npm ci && npm run typecheck && npm test
```

```bash
bash scripts/integration.sh
```

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/planning/01-market-research.md](docs/planning/01-market-research.md) | 市場調査（VS BOAT分析、公営競技の市場、競合） |
| [docs/planning/02-concept.md](docs/planning/02-concept.md) | タイトル・ゲームの柱・コアループ・機能ロードマップ |
| [docs/planning/03-legal-risk.md](docs/planning/03-legal-risk.md) | 法律・商標・炎上リスクの回避設計 |
| [docs/planning/04-monetization-onboarding.md](docs/planning/04-monetization-onboarding.md) | 課金設計・オンボーディング |
| [docs/planning/05-architecture-and-roadmap.md](docs/planning/05-architecture-and-roadmap.md) | 技術構成・インフラ費・ロードマップ・リスク |
| [docs/spec/requirements.md](docs/spec/requirements.md) | 要件定義（ロジック・サーバー） |
| [docs/spec/implementation-plan.md](docs/spec/implementation-plan.md) | 実装計画・実装状況 |

## 関連資料（claude.ai Artifacts、オーナーのみ閲覧可・共有はShareメニューから）
- モックアップ（企画シート＋画面8枚）：https://claude.ai/artifact/FSspLJDPabXkEF8bZKKt6W
- コンセプトデック（16枚）：https://claude.ai/artifact/3kKpBKToX3foqPKU4EsfVv
