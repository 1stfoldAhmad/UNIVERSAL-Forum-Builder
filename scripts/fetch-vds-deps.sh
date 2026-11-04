#!/usr/bin/env bash
# Fetch and build the real VDS dependencies that are not published on npm.
# Apache-2.0 sources; built unmodified into vendor/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/vendor"
cd "$ROOT/vendor"

if [ ! -d vds-json-logic ]; then
  echo "Fetching NATIVE-JSON-FLOW-LOGIC-Builder (vds-json-logic)…"
  curl -sL https://codeload.github.com/1stfoldAhmad/NATIVE-JSON-FLOW-LOGIC-Builder/tar.gz/refs/heads/main -o vds-json-logic.tar.gz
  mkdir -p vds-json-logic
  tar xzf vds-json-logic.tar.gz -C vds-json-logic --strip-components=1
  rm vds-json-logic.tar.gz
fi

cd vds-json-logic
if [ ! -d dist ]; then
  npm ci --no-audit --no-fund
  npm run build
fi
echo "vds-json-logic ready at vendor/vds-json-logic"
