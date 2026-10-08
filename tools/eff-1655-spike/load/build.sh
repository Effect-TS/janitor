#!/usr/bin/env bash
# Bundle the load-test Workers for workerd with code splitting so clanka's
# dynamic imports (turndown, glob, photon, MCP SDK) stay dynamic, as they would
# under alchemy's rolldown build. node:* stays external: workerd's nodejs_compat
# resolves it natively, which is what this test is about.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
for entry in static probe; do
  ../node_modules/.bin/esbuild "$entry.ts" \
    --bundle --splitting --format=esm --platform=node --target=es2022 \
    --main-fields=module,main \
    --conditions=workerd,worker,browser,import,default \
    --external:node:* --external:cloudflare:* \
    --outdir="dist/$entry" --chunk-names="chunks/[name]-[hash]" --log-level=warning
  echo "built dist/$entry: $(ls dist/$entry dist/$entry/chunks 2>/dev/null | grep -c '\.js$') module(s)"
done
