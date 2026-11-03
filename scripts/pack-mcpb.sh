#!/usr/bin/env bash
# Stage the built server, production node_modules, manifest and icon, boot the
# staged tree once with --version, then pack filesystem-mcp.mcpb at the repo
# root. Needs dev dependencies installed (tsc, the MCPB packer).
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

# Boot the production-only tree once: --version loads every runtime import, so a
# dependency that only resolves through devDependencies fails here, not for users.
node "$stage/dist/index.js" --version

# The packer stays a dev dependency: a user's bundle must not carry it.
if [ -e "$stage/node_modules/@anthropic-ai/mcpb" ]; then
  echo "pack-mcpb: the MCPB packer leaked into the production tree" >&2
  exit 1
fi

"$root/node_modules/.bin/mcpb" pack "$stage" "$root/filesystem-mcp.mcpb"
