#!/usr/bin/env bash
# Cross-language end-to-end test:
#   C# verifier (Muchi.Verifier serve)  <-- HTTP --  TS server (wrangler dev)  <-- WebSocket --  C# bots (Muchi.Bot)
# Checks that real races confirm, that the server's final hash equals each bot's own simulation,
# that a solo ranked race is settled by the real C# verifier, and that the stored replay log
# reproduces the same hash offline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFIER_PORT="${VERIFIER_PORT:-8090}"
SERVER_PORT="${SERVER_PORT:-8787}"
BASE="http://127.0.0.1:${SERVER_PORT}"
LOG_DIR="$(mktemp -d)"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

# The background PIDs are subshells; dotnet / npm → wrangler → workerd run as their descendants.
# Killing only the subshell left servers running (and a later run silently talked to a stale build),
# so stop the whole process tree, children first.
kill_tree() {
  local pid="$1" child
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
(cd "$ROOT/engine" && dotnet Muchi.Verifier/bin/Release/net8.0/Muchi.Verifier.dll serve --urls "http://127.0.0.1:${VERIFIER_PORT}" >"$LOG_DIR/verifier.log" 2>&1) &
VERIFIER_PID=$!
wait_for "http://127.0.0.1:${VERIFIER_PORT}/healthz" verifier

echo "== start TS server (wrangler dev) on :$SERVER_PORT"
(cd "$ROOT/server" && npx wrangler dev --port "$SERVER_PORT" --ip 127.0.0.1 \
  --var DEV_MODE:1 --var TICKET_SECRET:devsecret --var ADMIN_TOKEN:dev-admin \
  --var "VERIFIER_URL:http://127.0.0.1:${VERIFIER_PORT}" >"$LOG_DIR/server.log" 2>&1) &
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

if [[ $fail -ne 0 ]]; then
  echo "== INTEGRATION FAILED"; echo "--- server log"; tail -50 "$LOG_DIR/server.log"; echo "--- verifier log"; tail -20 "$LOG_DIR/verifier.log"
  exit 1
fi
echo "== INTEGRATION OK"
