#!/usr/bin/env bash
# Builds the web prototype (tools/figma-prototype/site): Codex's club UI (frontend/, index.html) and Codex's Unity UI
# reproduced in HTML (unity.html), both running on
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

python3 "$HERE/prepare_assets.py" "$ROOT" "$SITE"
node "$HERE/club-css.cjs" "$ROOT" "$SITE"   # Codex frontend stylesheets + forced mobile layout for the club UI

node "$HERE/test/logic.test.cjs"
node "$HERE/test/engine.test.mjs"
echo "built $SITE ($(du -sh "$SITE" | cut -f1))"
