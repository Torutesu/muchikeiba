#!/usr/bin/env bash
# Builds the Figma review gallery (tools/figma-gallery/site) from the current repo:
#   - Codex's screen designs (unity/design/figma-screens/*.svg → JPEG via the preinstalled Chromium)
#   - Codex's art and 3D partner previews (unity/Assets/Resources/Art, downscaled)
#   - the partner catalog and our asset manifest
#   - a race replay computed by the real engine (golden race, commentary, positions via TrackGeometry)
# Then package site/ and import it into Figma as a code layer (see README.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"; SITE="$HERE/site"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
rm -rf "$SITE/img" "$SITE/data"; mkdir -p "$SITE/data"
node "$HERE/render-screens.cjs" "$ROOT/unity/design/figma-screens" "$SITE/img/screens"
python3 "$HERE/resize-art.py" "$ROOT/unity/Assets/Resources/Art" "$SITE/img/art" 960
cp "$ROOT/unity/Assets/Resources/Models/Partners/catalog.json" "$SITE/data/partners.json"
cp "$ROOT/contracts/assets.manifest.json" "$SITE/data/assets.manifest.json"
(cd "$HERE/race-frames" && dotnet run -- "$ROOT/contracts/golden/race-turf2000-cpu12.json" "$ROOT/engine/Muchi.Client/Resources/Muchi/commentary-ja.json" "$SITE/data/race.json")
python3 - "$SITE" <<'PY'
import os, json, sys
site = sys.argv[1]; os.chdir(site)
screens = sorted('img/screens/' + f for f in os.listdir('img/screens') if f.endswith('.jpg'))
art = sorted(os.path.relpath(os.path.join(r, f), '.') for r, _, fs in os.walk('img/art') for f in fs if f.endswith('.jpg') and '3DPreviews' not in r)
previews = sorted('img/art/3DPreviews/' + f for f in os.listdir('img/art/3DPreviews'))
json.dump({'screens': screens, 'art': art, 'previews': previews}, open('data/files.json', 'w'), ensure_ascii=False, indent=1)
print('screens', len(screens), 'art', len(art), 'previews', len(previews))
PY
echo "built $SITE ($(du -sh "$SITE" | cut -f1))"
