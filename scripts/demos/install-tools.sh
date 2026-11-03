#!/usr/bin/env bash
# Installs the demo recording tools to ~/.local/bin without root.
set -euo pipefail

bin="$HOME/.local/bin"
mkdir -p "$bin"
base='https://github.com/asciinema'
arch='x86_64-unknown-linux-gnu'

for tool in asciinema agg; do
  if [[ ! -x "$bin/$tool" ]]; then
    curl -fsSL -o "$bin/$tool" "$base/$tool/releases/latest/download/$tool-$arch"
    chmod +x "$bin/$tool"
  fi
done

if [[ ! -x "$bin/gifsicle" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  # shortcut: private apt lists, because `apt-get update` needs root otherwise.
  apt_opts=(-o "Dir::State::lists=$work/lists" -o "Dir::Cache=$work/cache" -o Debug::NoLocking=1)
  mkdir -p "$work/lists/partial" "$work/cache/archives/partial"
  apt-get "${apt_opts[@]}" update -qq
  (cd "$work" && apt-get "${apt_opts[@]}" download gifsicle && dpkg -x gifsicle_*.deb out)
  cp "$work/out/usr/bin/gifsicle" "$bin/gifsicle"
fi

"$bin/asciinema" --version
"$bin/agg" --version
"$bin/gifsicle" --version | head -1
