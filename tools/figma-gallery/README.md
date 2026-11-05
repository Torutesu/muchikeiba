# Figma確認用ギャラリー

Codex のフロント（`unity/`）を Figma で目視確認するための静的サイト。Figma ファイル
https://www.figma.com/design/qdNx9WlGOjjLheyWhZTWYx にコードレイヤーとして取り込んでいる。

## 内容
- 画面（18）：`unity/design/figma-screens/*.svg` を 1280×720 の JPEG に描画
- レース再生：サーバーと同じ C# エンジンでゴールデンレースを再計算した位置・順位・実況（結果ハッシュの一致を表示）
- 3Dモデル：パートナーのプレビューと、毛色×勝負服 25 組の一覧（`catalog.json`）
- アート素材：背景・衣装・コース・天気・飼葉
- アセット対応：`contracts/assets.manifest.json` の種類別キー数

## 更新手順（Codex のフロントが変わったとき）
1. `bash tools/figma-gallery/build.sh`（.NET 8・Node・Python + Pillow・プリインストールの Chromium を使用）
2. `site/` の中身をアーカイブにして、Figma のコードレイヤーとして取り込む（Claude Code では `send_code_to_figma`）。
   取り込み済みのレイヤーは上書きできないため、毎回新しいレイヤーが追加される。古いレイヤーは Figma 上で削除する。

`site/img` と `site/data` は生成物なのでコミットしない。
