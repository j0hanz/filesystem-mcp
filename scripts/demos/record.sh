#!/usr/bin/env bash
# Records one demo scenario with a real model. Usage: record.sh <slug>
# Exit 0: the check passed and assets/demos/<slug>.gif was written.
# Exit 1: failed take. Exit 3: API or stall failure, which is not a take.
set -euo pipefail

slug="${1:?usage: record.sh <slug>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh" >/dev/null

source "$here/lib.sh"
source "$here/scenarios/$slug.sh"

: "${GEMINI_API_KEY:?GEMINI_API_KEY is not set; from PowerShell, set WSLENV=GEMINI_API_KEY}"
export GEMINI_API_KEY
export FS_MCP_BIN="${FS_MCP_BIN:-$repo/dist/index.js}"

cast="$HOME/.cache/fs-demos/$slug.cast"
out="$repo/assets/demos/$slug.gif"
mkdir -p "$(dirname "$cast")" "$(dirname "$out")"

tmux kill-session -t "$DEMO_SESSION" 2>/dev/null || true
rm -rf "$DEMO_DIR" "$cast"
mkdir -p "$DEMO_DIR"
fixture

agent="$repo/examples/clients/gatekeeper/agent.ts"
tmux -f /dev/null new-session -d -s "$DEMO_SESSION" -x 90 -y 28 -c "$DEMO_DIR" \
  "exec node '$agent' '$DEMO_DIR' --provider gemini --model gemini-flash-latest"
tmux set-option -t "$DEMO_SESSION" status off >/dev/null

# Wait for the first prompt, so startup is not recorded.
for _ in $(seq 1 120); do
  [[ "$(_demo_last_line 2>/dev/null || true)" == '>' ]] && break
  sleep 0.5
done
[[ "$(_demo_last_line 2>/dev/null || true)" == '>' ]] || {
  echo 'stalled: the agent never reached its prompt (not a take)' >&2
  exit 3
}

asciinema rec --headless --quiet --window-size 90x28 --idle-time-limit 0.7 \
  --output-format asciicast-v2 --command "tmux attach -t $DEMO_SESSION" "$cast" &
recorder=$!
trap 'kill -9 "$recorder" 2>/dev/null || true; tmux kill-session -t "$DEMO_SESSION" 2>/dev/null || true' EXIT
sleep 1

script

# Stop while the session is still on screen, so no detach text is captured.
sleep 1
kill -9 "$recorder" 2>/dev/null || true
wait "$recorder" 2>/dev/null || true

if grep -qaF -- "$GEMINI_API_KEY" "$cast"; then
  rm -f "$cast"
  echo 'the recording held the API key; cast deleted' >&2
  exit 1
fi

check "$cast"

agg --idle-time-limit 0.7 --last-frame-duration 3 --font-size 16 --theme asciinema "$cast" "$out.tmp"
gifsicle -O3 --lossy=30 "$out.tmp" -o "$out"
rm -f "$out.tmp"

bytes="$(stat -c %s "$out")"
echo "$slug: $bytes bytes, cast at $cast"
if ((bytes >= 2097152)); then
  echo "too large: $out is 2 MB or more" >&2
  exit 1
fi
