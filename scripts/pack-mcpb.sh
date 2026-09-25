#!/usr/bin/env bash
# Stage the built server, production node_modules, manifest and icon, then pack
# filesystem-mcp.mcpb at the repo root. Needs dev dependencies installed (tsc).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cd "$root"

npm run build
cp -r dist package.json package-lock.json LICENSE README.md "$stage/"
cp mcpb/manifest.json "$stage/manifest.json"
cp assets/logo.png "$stage/icon.png"
(cd "$stage" && npm ci --omit=dev --ignore-scripts)

npx -y @anthropic-ai/mcpb@2.1.2 validate "$stage/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" "$root/filesystem-mcp.mcpb"
