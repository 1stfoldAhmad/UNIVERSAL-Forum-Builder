#!/usr/bin/env bash
# Fetch and build the real VDS dependencies that are not published on npm.
# Apache-2.0 sources; built unmodified into vendor/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/vendor"
cd "$ROOT/vendor"

# A root `npm ci` can create vendor/vds-json-logic/node_modules for the
# `file:../../vendor/vds-json-logic` dependency before the upstream source is
# present. Treat a directory without package.json/package-lock.json as
# incomplete and refetch it instead of skipping the fetch.
if [ ! -f vds-json-logic/package.json ] || [ ! -f vds-json-logic/package-lock.json ]; then
  echo "Fetching NATIVE-JSON-FLOW-LOGIC-Builder (vds-json-logic)…"
  rm -rf vds-json-logic
  curl --fail --silent --show-error --location \
    https://codeload.github.com/1stfoldAhmad/NATIVE-JSON-FLOW-LOGIC-Builder/tar.gz/refs/heads/main \
    -o vds-json-logic.tar.gz
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
