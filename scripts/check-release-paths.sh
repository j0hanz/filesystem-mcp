#!/usr/bin/env bash
# The release-only build paths, runnable anywhere without secrets: pack the
# desktop bundle, build the Smithery card in dry-run mode, and build the Docker
# image for the current arch. CI runs this on every push; the Release workflow
# runs it before it tags, so a broken path fails before a version exists.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

bash scripts/pack-mcpb.sh
node scripts/publish-smithery.mjs --dry-run
docker build --tag filesystem-mcp:release-check .
