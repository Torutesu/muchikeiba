#!/usr/bin/env bash
# Ops console end to end: TS server (wrangler dev, fresh local state) <-- CORS + bearer -- console (tools/ops-console, static)
# <-- Playwright (headless Chromium). Admin tokens are generated per run (only their SHA-256 reaches the server, as
# ADMIN_TOKENS); nothing secret is stored in the repository.
#   VERIFIER_PORT (default 9017): VERIFIER_URL given to the server (the console flows need no verifier)
#   SERVER_PORT   (default 9117), CONSOLE_PORT (default 9217), SCREENSHOT_DIR (default tools/ops-console/e2e-screenshots)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFIER_PORT="${VERIFIER_PORT:-9017}"
SERVER_PORT="${SERVER_PORT:-9117}"
CONSOLE_PORT="${CONSOLE_PORT:-9217}"
API="http://127.0.0.1:${SERVER_PORT}"
CONSOLE_URL="http://127.0.0.1:${CONSOLE_PORT}"
SCREENSHOT_DIR="${SCREENSHOT_DIR:-$ROOT/tools/ops-console/e2e-screenshots}"
LOG_DIR="$(mktemp -d)"

kill_tree() { # pid: the process and every descendant (npx → wrangler → workerd would otherwise outlive the script)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill_tree "$SERVER_PID"
  [[ -n "${CONSOLE_PID:-}" ]] && kill_tree "$CONSOLE_PID"
  wait 2>/dev/null || true
  rm -rf "$LOG_DIR/state" # the run's Durable Object / R2 state (can be large)
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
for p in "$SERVER_PORT" "$CONSOLE_PORT"; do
  port_free "$p" || { echo "port $p is already in use. Stop it or set SERVER_PORT/CONSOLE_PORT."; exit 1; }
done

echo "== tokens (random per run; the server gets only SHA-256)"
eval "$(node -e '
const c = require("crypto");
const t = Object.fromEntries(["viewer", "operator", "admin", "admin2"].map((n) => [n, c.randomBytes(24).toString("base64url")]));
const role = { viewer: "viewer", operator: "operator", admin: "admin", admin2: "admin" };
const entries = Object.entries(t).map(([name, tok]) => ({ name, role: role[name], sha256: c.createHash("sha256").update(tok).digest("hex") }));
for (const [n, tok] of Object.entries(t)) console.log(`export TOKEN_${n.toUpperCase()}=${tok}`);
console.log(`ADMIN_TOKENS_JSON=${JSON.stringify(JSON.stringify(entries))}`);
')"

echo "== start TS server (wrangler dev) on :$SERVER_PORT"
(cd "$ROOT/server" && exec npx wrangler dev --port "$SERVER_PORT" --ip 127.0.0.1 --persist-to "$LOG_DIR/state" \
  --var DEV_MODE:1 --var TICKET_SECRET:devsecret \
  --var "ADMIN_TOKENS:${ADMIN_TOKENS_JSON}" --var "ADMIN_CONSOLE_ORIGINS:${CONSOLE_URL}" \
  --var "VERIFIER_URL:http://127.0.0.1:${VERIFIER_PORT}" >"$LOG_DIR/server.log" 2>&1) &
SERVER_PID=$!
wait_for "${API}/v1/health" server

echo "== build + serve the console on :$CONSOLE_PORT"
(cd "$ROOT/tools/ops-console" && OPS_API_BASE="$API" OPS_ENV_LABEL=local node build.mjs "$LOG_DIR/console")
(exec node "$ROOT/tools/ops-console/serve.mjs" "$CONSOLE_PORT" "$LOG_DIR/console" >"$LOG_DIR/console.log" 2>&1) &
CONSOLE_PID=$!
wait_for "${CONSOLE_URL}/" console

echo "== playwright"
if API_BASE="$API" CONSOLE_URL="$CONSOLE_URL" SCREENSHOT_DIR="$SCREENSHOT_DIR" node "$ROOT/tools/ops-console/e2e/console.e2e.mjs"; then
  echo "== CONSOLE E2E OK (screenshots: $SCREENSHOT_DIR)"
else
  echo "== CONSOLE E2E FAILED"; echo "--- server log"; tail -60 "$LOG_DIR/server.log"; exit 1
fi
