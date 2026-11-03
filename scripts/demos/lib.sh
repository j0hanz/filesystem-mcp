# Helpers sourced by record.sh and the scenario files.

DEMO_DIR=/tmp/demo/my-app
DEMO_SESSION=demo
DEMO_TURN_TIMEOUT=600 # polls of 0.5 s, so 300 s
# How long a preview stays up before the driver answers it.
DEMO_READ_PAUSE=2

demo_file() {
  local path="$DEMO_DIR/$1"
  mkdir -p "$(dirname "$path")"
  printf '%b' "$2" >"$path"
}

# shortcut: one send-keys per character looks like typing; slow only for long prompts.
_demo_type() {
  local pane="$1" text="$2" i
  for ((i = 0; i < ${#text}; i++)); do
    tmux send-keys -t "$pane" -l "${text:i:1}"
    sleep 0.01
  done
  sleep 0.3
  tmux send-keys -t "$pane" Enter
}

_demo_last_line() {
  tmux capture-pane -p -t "$DEMO_SESSION:0.0" | awk 'NF { line = $0 } END { print line }'
}

# Types the prompt, answers every gate, returns at the next `> ` prompt.
demo_turn() {
  local prompt="$1" choice="${2:-}" waited=0 line
  _demo_type "$DEMO_SESSION:0.0" "$prompt"
  sleep 1
  while ((waited < DEMO_TURN_TIMEOUT)); do
    if ! line="$(_demo_last_line)"; then
      echo "stalled: the agent pane is gone (not a take)" >&2
      exit 3
    fi
    case "$line" in
      # capture-pane trims trailing spaces, so an answered prompt no longer matches.
      '>') return 0 ;;
      'apply? [y/N/why]')
        sleep "$DEMO_READ_PAUSE"
        _demo_type "$DEMO_SESSION:0.0" y
        waited=0
        ;;
      'y/N')
        # The only yes/no question is a folder grant. A demo never widens access.
        _demo_type "$DEMO_SESSION:0.0" n
        waited=0
        ;;
      'choice:')
        if [[ -z "$choice" ]]; then
          echo "unexpected server question: $line" >&2
          exit 1
        fi
        sleep "$DEMO_READ_PAUSE"
        _demo_type "$DEMO_SESSION:0.0" "$choice"
        waited=0
        ;;
    esac
    sleep 0.5
    waited=$((waited + 1))
  done
  echo "stalled: no prompt after 300 s (not a take)" >&2
  exit 3
}

# Runs a visible command in a second pane, as the person at the keyboard.
demo_human() {
  if (($(tmux list-panes -t "$DEMO_SESSION:0" | wc -l) == 1)); then
    tmux split-window -d -v -l 5 -t "$DEMO_SESSION:0.0" -c "$DEMO_DIR" \
      "PS1='you\$ ' bash --norc --noprofile"
    sleep 0.5
  fi
  _demo_type "$DEMO_SESSION:0.1" "$1"
  sleep 1
}

_demo_fail() {
  echo "check failed: $1" >&2
  exit 1
}

assert_file_has() {
  grep -qF -- "$2" "$DEMO_DIR/$1" || _demo_fail "$1 lacks: $2"
}

assert_file_lacks() {
  if grep -qF -- "$2" "$DEMO_DIR/$1"; then _demo_fail "$1 has: $2"; fi
}

assert_cast_has() {
  grep -qaF -- "$2" "$1" || _demo_fail "recording lacks: $2"
}
