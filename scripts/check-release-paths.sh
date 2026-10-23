#!/usr/bin/env bash
# The release-only build paths, runnable anywhere without secrets: pack and boot
# the desktop bundle, and build and boot the Docker image for the current arch.
# CI runs this on every push; the Release workflow runs it before it tags, so a
# broken path fails before a version exists.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

bash scripts/pack-mcpb.sh
docker build --tag filesystem-mcp:release-check .
# Run the image once: it carries only production node_modules (npm prune
# --production), so this is where a dev-only runtime import would surface.
docker run --rm filesystem-mcp:release-check --version
