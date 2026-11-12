#!/usr/bin/env bash
# Builds the web prototype (tools/figma-prototype/site): the ムチ一閃 UI (index.html, the site root; Codex's Figma screens'
# tone & manner on the flow of Codex's Unity UI) and Codex's club UI (frontend/, club.html), both running on
#   - the real server domain logic (server/src/domain → esbuild → site/js/logic.js)
#   - the real C# race engine + Unity game layer compiled to WebAssembly (engine-wasm → site/engine/_framework)
#   - Codex's art, localization and font (prepare_assets.py)
# Then runs the logic and engine checks. Import site/ into Figma as a code layer (see README.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; SITE="$HERE/site"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
command -v dotnet >/dev/null || { [[ -x /opt/dotnet/dotnet ]] && export PATH="/opt/dotnet:$PATH" DOTNET_ROOT=/opt/dotnet; }

[[ -d "$ROOT/server/node_modules" ]] || (cd "$ROOT/server" && npm ci)
"$ROOT/server/node_modules/.bin/esbuild" "$HERE/logic/entry.ts" --bundle --format=iife --platform=browser --target=es2020 --minify --outfile="$SITE/js/logic.js"

OUT="$(mktemp -d)"
dotnet publish "$HERE/engine-wasm" -c Release -o "$OUT" --nologo -v q
rm -rf "$SITE/engine"; mkdir -p "$SITE/engine/_framework"
find "$OUT/wwwroot/_framework" -maxdepth 1 -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.json' \) -exec cp {} "$SITE/engine/_framework/" \;
rm -rf "$OUT"

# Noto Sans JP Regular / Medium (SIL OFL) for the light body text of the ムチ一閃 UI: the repo only has the CJK Bold.
# Fetched once from npm (@expo-google-fonts/noto-sans-jp ships the full TTFs) into .cache/ (not committed).
FONTS="$HERE/.cache/fonts"
if [[ ! -f "$FONTS/NotoSansJP_500Medium.ttf" ]]; then
  mkdir -p "$FONTS"; TMPF="$(mktemp -d)"
  (cd "$TMPF" && npm pack --silent @expo-google-fonts/noto-sans-jp@0.4.1 >/dev/null && tar xzf ./*.tgz package/400Regular package/500Medium package/LICENSE_FONT) \
    && cp "$TMPF"/package/400Regular/*.ttf "$TMPF"/package/500Medium/*.ttf "$FONTS/" && cp "$TMPF/package/LICENSE_FONT" "$FONTS/OFL.txt" \
    || echo "warning: Noto Sans JP Regular/Medium unavailable; the UI falls back to the bold face"
  rm -rf "$TMPF"
fi
MUCHI_FONTS="$FONTS" python3 "$HERE/prepare_assets.py" "$ROOT" "$SITE"
node "$HERE/club-css.cjs" "$ROOT" "$SITE"   # Codex frontend stylesheets + forced mobile layout for the club UI

node "$HERE/test/logic.test.cjs"
node "$HERE/test/engine.test.mjs"
node "$HERE/test/round8.test.mjs"   # round 8: TutorialDirector, RaceFeel/RaceDebrief, skills, shop/pass/consent/deletion on the real rules
node "$HERE/test/round9.test.mjs"   # round 9: replay share (ReplayClip/ShareCard), account-link prompt, time attack ghost picker (friends first)
node "$HERE/test/round10.test.mjs"   # round 10: 支部 cheer stamps on TeamsService/TeamCore, the bought pass in the per-player shop list
node "$HERE/test/round9-gacha.test.mjs"   # round 9: banner calendar, GachaRevealModel/BannerListModel in WASM, pity meter, step-up, the end boundary
node "$HERE/test/round10-invite.test.mjs" # round 10: 友達招待 — my code, demo friends redeeming it, milestone rewards, entering a code, reset
node "$HERE/test/round11.test.mjs"   # round 11: 図鑑 (obtained / seen / unknown, no reward for completion), achievements and claims, achievement titles
node "$HERE/test/round12.test.mjs"   # round 12: コイン不足の案内 T6 (the one pack, the refused pull's details, KPI, back to the pull), bought packs owned
node "$HERE/test/round11-training.test.mjs" # round 11: 調教 — view, a session re-scored on the server rules, anti-cheat, skip, the mission apple, the ranked line
node "$HERE/test/round12-giftbox.test.mjs" # round 12: プレゼントボックス — boot balance, the demo box, claim one / all, history, no paid coins
node "$HERE/test/round12-assist.test.mjs"   # round 12: かんたん操作 — InputAssistant rides a race in WASM, never the tutorial, the setting and the one-time prompt
node "$HERE/test/round12-rival.test.mjs"    # round 12: ライバル — weekly pairing (public card), head to head, challenge (no points), TA tiebreak, week result once, block / opt-out
node "$HERE/test/round13-history.test.mjs" # round 13: 購入・コイン・ガチャ履歴 — header (有償/無償), tabs, cursor paging, refunded pack, 問い合わせ draft, English
node "$HERE/test/round15-activity.test.mjs" # round 15: アクティビティ — demo from the real event sources, collapsed likes, gift link only, bell, mark read, paging, English
node "$HERE/test/round13-exchange.test.mjs" # round 13: イベント交換所 — points by event race (daily cap), keyed exchange with stock, grace days, leftover → material
node "$HERE/test/round13-weekly-challenge.test.mjs" # round 13: 週替わりチャレンジ — the week, a loan-horse start, the verdict only from the verified result, once a week, mismatch
node "$HERE/test/round13-team-goal.test.mjs" # round 13: 支部の共同目標 — the week, settled races with the daily cap, the feed milestone, the week close paying once
node "$HERE/test/round14-hall.test.mjs"     # round 14: 殿堂 — career from confirmed races, the ceremony once, 殿堂入り and the frame once, paging, a friend's hall
node "$HERE/test/round14-commentary-packs.test.mjs" # round 14: 実況パック — races speak the equipped pack (never the tutorial), the 10-second sample, owned / equip / buy on the server rules
node "$HERE/test/round14-my-replays.test.mjs"  # round 14: マイリプレイ — races settled with their replay, save / rename / favourite / public / delete, ReplayPlayer in WASM (speed, camera, last 200 m), 再生できません, a friend replay
node "$HERE/test/a11y-flash.test.cjs"       # round 15: アクセシビリティ — the --a11y-* tokens equal contracts/a11y-tokens.json, every blink ≤ 3 flashes/s and off with reduce motion
node "$HERE/test/round15-a11y.test.mjs"     # round 15: アクセシビリティ — the whip hold (RaceInput + WhipHold) in WASM, a hold = taps, the tutorial, the settings on the server rules
node "$HERE/test/round15-race-advice.test.mjs" # round 15: 出走前アドバイス — TS = C# (WASM) on the shared vectors, the lobby over today's courses, the challenge loan horse, tutorial, KPI, English
node "$HERE/test/round15-photo.test.mjs" # round 15: フォトモード — pause a solo race (same state, same hash after), camera limits, no pause in ranked, catalog / purchase / keyed record / KPI
node "$HERE/test/round16-roster.test.mjs"     # round 16: 厩舎の整理 — rows, shared sort / filters / search, lock (the single retire refused too), favourite, bulk preview, all or nothing, keyed, stale
node "$HERE/test/round18-horse-goals.test.mjs" # round 18: 馬ごとの目標 — the chain from aptitudes, confirmed races only, completion once, pin / home / horse_goal_near, English, a retired horse keeps its goals
node "$HERE/test/round16-season-recap.test.mjs" # round 16: シーズンの振り返り — short / full / year recaps from confirmed races, promotion and the hall, open / complete once, English, recap_share
node "$HERE/test/round17-reports.test.mjs" # round 17: 通報とブロック — options, a server-side snapshot, merged reports, limits, also block on the one list, block list names, unblock, ops_notice, English
node "$HERE/test/round17-help.test.mjs" # round 17: ヘルプセンター — index (JA/EN), context links, numbers from data, the fold, a vote, one ticket per form key, the ops reply, English
node "$HERE/test/round19-performance.test.mjs" # round 19: 画質・省電力・通信量 — device class / RenderProfile in WASM, storage with low variants, KPI schema, help, the same race hash at 30 and 60 fps
node "$HERE/test/round17-friend-suggestions.test.mjs" # round 17: おすすめフレンド — demo from the real race / like / cheer / friends paths, reasons, opt-out and ranked never shown, request via the friend flow, dismiss, KPI, English
node "$HERE/test/round18-practice.test.mjs" # round 18: 練習レース — the catalog, a device race in PracticeSession, the whip band, slow = same race, same seed + ghost, new seed, photo pause, KPI, nothing granted
node "$HERE/test/round18-quick-chat.test.mjs"   # round 18: 支部の定型チャット — picker JA / EN, a checked value, the 15 s rule, phrases in the shared feed, a mention, both-way block
node "$HERE/test/round19-tips.test.mjs" # round 19: ヒント — index (JA/EN), numbers from data, unlocks, seen marks, the 「？」 contexts, KPI, the whip lesson = the FTUE tutorial race in WASM (never assisted), no first-time reward touched
node "$HERE/test/round21-calendar.test.mjs" # round 21: 予定表 — rows from each feature's own data, paid rows dates only, JST in English, marks (idempotent, no push), KPI
node "$HERE/test/round19-cheer.test.mjs" # round 19: 観戦中の応援 — the 2 s pace, windows fanned out with the block list, no ids, moments, one KPI row per race, English
node "$HERE/test/round19-transfer-code.test.mjs" # round 19: 引き継ぎコード — issue (rules, generated once, hash only), redeem with confirm / one key / replay, single use, the old-device cut-off, no oracle, KPI, English
node "$HERE/test/round20-consent.test.mjs"   # round 20: 広告・分析の同意 — no pre-prompt in the FTUE, ad_offer moment, ATT answer, npa, analytics off withholds optional events, policy update, English
node "$HERE/test/round20-client-errors.test.mjs" # round 20: クライアントのエラー報告 — window.onerror → WASM ErrorReporter (collapse, scrub, saved queue, same batch id on retry, consent) → the server ingest, device fingerprint = server
node "$HERE/test/round20-review-prompt.test.mjs" # round 20: レビュー依頼 — FTUE / session / cool-down / loss, native once, soft → store or inquiry (never the store after いまいち), no reward, English
node "$HERE/test/round22-self-limits.test.mjs" # round 22: 使いすぎ・遊びすぎの防止 — own limit (lower now, raise waits, cancel), refused confirmation, no pack over it in the shortfall, the play-time rule
node "$HERE/test/round20-local-notifications.test.mjs" # round 20: 端末のローカル通知 — the digest, the shared planner, push categories / quiet hours switch the local kinds, cap, details off, English, the diff
node "$HERE/test/round21-showcase.test.mjs" # round 21: トレーナーカード — demo cards (friend, under 13, blocked → neutral), the editor (earned only, strict save), my card, the share image in WASM without a player id, KPI
node "$HERE/test/round21-deep-links.test.mjs" # round 21: ディープリンク・再戦 — share (one link per target, no id in the URL), open → the screen behind a confirmation, one neutral answer, revoke, KPI without tokens, rematch (window, someone left, everyone in → a new room on the same conditions)
node "$HERE/test/round21-release-notes.test.mjs" # round 21: アップデートのお知らせ — a new install never, the updater once (skipped count, numbers from data, never the shop), seen idempotent, the past list JA / EN, KPI, nothing granted
node "$HERE/test/quality-race.test.mjs" # quality pass (docs/quality/race-play.md): ruleset 1.4 in WASM — the hold / release go, 会心 on the gold ring, the tactics HUD, the re-simulated lesson; 1.3 untouched
node "$HERE/test/quality-raising.test.mjs"       # quality pass: raising & breeding — 馬カード (layers, stage, leaning, career, read-only), the training outlook = the start preview, exact foal rarity odds, the foal's generation
node "$HERE/test/quality-integration.test.mjs"   # quality integration: home says each thing once (the next line vs the goal ladder, one link), the ladder cap = the horse card cap
node "$HERE/test/round22-promotion.test.mjs" # round 22: 昇級戦 — start on the line (not counted), pips, pass early, fail → setback, ack once, grace, kill switch, English
node "$HERE/test/round22-surveys.test.mjs" # round 22: ゲーム内アンケート — none in the FTUE / without a live survey, the demo survey at home and after a result, strict check, once per player, scrub, skip → cool-down, results without ids, nothing granted, English
echo "built $SITE ($(du -sh "$SITE" | cut -f1))"
