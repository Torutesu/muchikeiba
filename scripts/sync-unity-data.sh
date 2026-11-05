#!/usr/bin/env bash
# Copies runtime data the Unity app loads from Resources (engine/Muchi.Client/Resources/Muchi) from its source of truth.
# Run after changing contracts/ruleset-params.default.json; engine test UnityPackageTests fails while they differ.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/contracts/ruleset-params.default.json" "$ROOT/engine/Muchi.Client/Resources/Muchi/ruleset-params.default.json"
echo "synced engine/Muchi.Client/Resources/Muchi/ruleset-params.default.json"
