# Find a crash in a 14 MB log without reading it.

DEMO_IDLE=1.5

fixture() {
  mkdir -p "$DEMO_DIR/logs"
  seq 1 200000 | awk '{ printf "2026-11-03T10:00:00Z INFO request %d ok path=/api/users status=200\n", $1 }' >"$DEMO_DIR/logs/server.log"
  printf '2026-11-03T10:01:00Z ERROR db pool exhausted: timeout after 30000ms\n2026-11-03T10:01:01Z INFO shutdown\n' >>"$DEMO_DIR/logs/server.log"
  demo_file src/pool.ts 'export function acquire(free) {\n  if (free === 0) {\n    throw new Error("db pool exhausted");\n  }\n}\n'
}

script() {
  demo_turn 'The server crashed last night. Find the log, tell me why without reading the whole thing, and point me at the code. Tell me how big the log was and about how many tokens reading it would have cost.'
}

check() {
  assert_cast_has "$1" 'pool.ts'
  assert_cast_has "$1" 'tail'
  assert_file_has src/pool.ts 'pool exhausted'
}
