#!/usr/bin/env bash
# Cross-language end-to-end test:
#   C# verifier (Muchi.Verifier serve)  <-- HTTP --  TS server (wrangler dev)  <-- WebSocket --  C# bots (Muchi.Bot)
# Checks that real races confirm, that the server's final hash equals each bot's own simulation,
# that a solo ranked race is settled by the real C# verifier, that the stored replay log
# reproduces the same hash offline, that a tournament (heats → final) and a spectator run end to end, and that a
# rewarded-ad SSV callback is verified by signature in front of the player's object, and that a training session's
# mini-game taps are re-scored by the server (REQ-TRAIN-*).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFIER_PORT="${VERIFIER_PORT:-8090}"
SERVER_PORT="${SERVER_PORT:-8787}"
BASE="http://127.0.0.1:${SERVER_PORT}"
LOG_DIR="$(mktemp -d)"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

# Shared secret between the server (VERIFIER_TOKEN) and the verifier (VERIFIER_AUTH_SECRET), as in production.
VERIFIER_SECRET="integration-$(date +%s)-0123456789abcdef0123456789"

kill_tree() { # pid: the process and every descendant (npx → wrangler → workerd would otherwise outlive the script)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  [[ -n "${VERIFIER_PID:-}" ]] && kill_tree "$VERIFIER_PID"
  [[ -n "${SERVER_PID:-}" ]] && kill_tree "$SERVER_PID"
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url, name
  for _ in $(seq 1 120); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $2"; cat "$LOG_DIR"/*.log; exit 1
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$VERIFIER_PORT" "$SERVER_PORT"; do
  port_free "$p" || { echo "port $p is already in use (a stale verifier/wrangler from an earlier run?). Stop it or set VERIFIER_PORT/SERVER_PORT."; exit 1; }
done

echo "== build"
(cd "$ROOT/engine" && dotnet build Muchi.sln -c Release --nologo -v q)

echo "== start C# verifier on :$VERIFIER_PORT"
(cd "$ROOT/engine" && VERIFIER_REQUIRE_AUTH=1 VERIFIER_AUTH_SECRET="$VERIFIER_SECRET" \
  exec dotnet Muchi.Verifier/bin/Release/net8.0/Muchi.Verifier.dll serve --urls "http://127.0.0.1:${VERIFIER_PORT}" >"$LOG_DIR/verifier.log" 2>&1) &
VERIFIER_PID=$!
wait_for "http://127.0.0.1:${VERIFIER_PORT}/healthz" verifier
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "http://127.0.0.1:${VERIFIER_PORT}/verify")
[[ "$code" == "401" ]] || { echo "verifier accepted an unauthenticated call (HTTP $code)"; exit 1; }

# REQ-AD-006: a throwaway ECDSA key pair stands in for the ad network's SSV keys (public half → ADS_SSV_KEYS)
ADS_SSV_KEYS=$(cd "$ROOT/server" && npx tsx scripts/ads-ssv-check.ts keygen "$LOG_DIR")

echo "== start TS server (wrangler dev) on :$SERVER_PORT"
(cd "$ROOT/server" && exec npx wrangler dev --port "$SERVER_PORT" --ip 127.0.0.1 \
  --var DEV_MODE:1 --var TICKET_SECRET:devsecret --var ADMIN_TOKEN:dev-admin \
  --var "VERIFIER_URL:http://127.0.0.1:${VERIFIER_PORT}" --var "VERIFIER_TOKEN:${VERIFIER_SECRET}" \
  --var "ADS_SSV_KEYS:${ADS_SSV_KEYS}" >"$LOG_DIR/server.log" 2>&1) &
SERVER_PID=$!
wait_for "${BASE}/v1/health" server

BOT="dotnet $ROOT/engine/Muchi.Bot/bin/Release/net8.0/Muchi.Bot.dll"
fail=0

echo "== 1) tutorial race (1 human + CPU, not ranked) → confirmed by the room"
$BOT "$BASE" tutorial | tee "$LOG_DIR/tutorial.jsonl" || fail=1

echo "== 2) ranked, 2 humans → confirmed by consensus"
$BOT "$BASE" ranked 2 | tee "$LOG_DIR/ranked2.jsonl" || fail=1

echo "== 3) ranked, 1 human → verifying → confirmed by the C# verifier"
$BOT "$BASE" ranked 1 | tee "$LOG_DIR/ranked1.jsonl" || fail=1
grep -q '"statuses":\["verifying","confirmed"\]' "$LOG_DIR/ranked1.jsonl" || { echo "solo ranked race was not settled through the verifier"; fail=1; }

echo "== 4) stored replay log reproduces the same hash offline"
RACE_ID=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0];console.log(JSON.parse(l).raceId)' "$LOG_DIR/ranked1.jsonl")
LOCAL_HASH=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[0];console.log(JSON.parse(l).localHash)' "$LOG_DIR/ranked1.jsonl")
curl -fsS -H 'authorization: Bearer dev-admin' "${BASE}/v1/admin/replays/${RACE_ID}" >"$LOG_DIR/replay.json"
REPLAY_HASH=$(cd "$ROOT/engine" && dotnet Muchi.Verifier/bin/Release/net8.0/Muchi.Verifier.dll replay "$LOG_DIR/replay.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).resultHash))')
echo "bot=$LOCAL_HASH replay=$REPLAY_HASH"
[[ "$LOCAL_HASH" == "$REPLAY_HASH" ]] || { echo "replay hash mismatch"; fail=1; }

echo "== 5) time attack: device run → server re-simulation (C# verifier) → personal best, ghost replay; tampered run rejected"
$BOT "$BASE" timeattack | tee "$LOG_DIR/timeattack.jsonl" || fail=1

echo "== 6) event race: free-coin fee → event pool (CPU fill) → solo human verified by the C# verifier → event points applied"
$BOT "$BASE" event 1 | tee "$LOG_DIR/event.jsonl" || fail=1

echo "== 7) teams: create → open join → directory search → leave (cooldown) → lone leader leaves = disband"
$BOT "$BASE" team | tee "$LOG_DIR/team.jsonl" || fail=1

echo "== 8) Unity app game layer (unity/Assets/Muchi/Game): naming + first scout → shop/pass → ranked race confirmed with the app's own simulation"
(cd "$ROOT/unity/Checks~/GameChecks" && dotnet build -c Release --nologo -v q >/dev/null && dotnet bin/Release/net8.0/GameChecks.dll online "$BASE") | tee "$LOG_DIR/unity-game.log" || fail=1

echo "== 9) tournament: admin creates a mini tournament → 4 bots register → 2 heats + final over real race rooms (TournamentDO alarms) → standings + prize; a spectator watches a heat (delayed, read-only) and gets the players' final hash"
$BOT "$BASE" tournament | tee "$LOG_DIR/tournament.jsonl" || fail=1

echo "== 10) rewarded ads: signed SSV callback (ECDSA) → player object (no session: rejected, 200), replay answered the same, tampered/unsigned 401; no offers in the FTUE"
(cd "$ROOT/server" && npx tsx scripts/ads-ssv-check.ts check "$BASE" "$LOG_DIR") | tee "$LOG_DIR/ads.log" || fail=1

echo "== 11) 調教: start → instant taps refused (422, the server clock) → taps after the mini-game re-scored on the server → growth on the horse, daily mission, keyed retry, 2 per horse a day"
(cd "$ROOT/server" && npx tsx scripts/training-check.ts "$BASE") | tee "$LOG_DIR/training.log" || fail=1

if [[ $fail -ne 0 ]]; then
  echo "== INTEGRATION FAILED"; echo "--- server log"; tail -50 "$LOG_DIR/server.log"; echo "--- verifier log"; tail -20 "$LOG_DIR/verifier.log"
  exit 1
fi
echo "== INTEGRATION OK"
