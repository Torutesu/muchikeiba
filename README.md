# ムチ一閃（仮）— 3D競馬ジョッキー オンライン対戦

騎手として馬に乗り、最大12頭のリアルタイム対戦で「最後の直線、ムチ一発で差し切る」スマホゲーム。

- `frontend/` は画面設計確認用のブラウザプロトタイプ。`unity/` はUnityゲーム本体と3D表示のプロトタイプ。
- Unityの統合と既存レース／サーバー機能への接続は、[Unity 3D引き渡しメモ](docs/handoff-unity-3d.md)から続行する。
- 本リポジトリはロジック（レースエンジン・対戦の同期・サーバー）と設計ドキュメントを持つ

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/planning/01-market-research.md](docs/planning/01-market-research.md) | 市場調査（VS BOAT分析、公営競技の市場、競合） |
| [docs/planning/02-concept.md](docs/planning/02-concept.md) | タイトル・ゲームの柱・コアループ・機能ロードマップ |
| [docs/planning/03-legal-risk.md](docs/planning/03-legal-risk.md) | 法律・商標・炎上リスクの回避設計 |
| [docs/planning/04-monetization-onboarding.md](docs/planning/04-monetization-onboarding.md) | 課金設計・オンボーディング |
| [docs/planning/05-architecture-and-roadmap.md](docs/planning/05-architecture-and-roadmap.md) | 技術構成・インフラ費・ロードマップ・リスク |
| [unity/README.md](unity/README.md) | Unityフロントエンド、画面、アート、検証状況 |
| [docs/handoff-unity-3d.md](docs/handoff-unity-3d.md) | 3Dモデル統合とClaude側のUnity検証手順 |
| [frontend/README.md](frontend/README.md) | ブラウザ画面プロトタイプとFigma素材 |

## 関連資料（claude.ai Artifacts、オーナーのみ閲覧可・共有はShareメニューから）
- モックアップ（企画シート＋画面8枚）：https://claude.ai/artifact/FSspLJDPabXkEF8bZKKt6W
- コンセプトデック（16枚）：https://claude.ai/artifact/3kKpBKToX3foqPKU4EsfVv
